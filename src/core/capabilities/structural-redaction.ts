import { createHmac, randomBytes } from "node:crypto";

/**
 * Structural redaction for anything an Extension can put into a host log.
 *
 * `security-operations.md` section 6 requires access keys, bearer tokens,
 * cookies, passwords, signed Media URLs, and authorization headers to be
 * redacted "structurally, not through a small list of literal names alone",
 * and `extension-process-protocol.md` section 6 requires capability handles and
 * secret references to be redacted from logs, errors, traces, and prompts.
 *
 * This module therefore never asks what a field is called. It classifies the
 * *shape* of a value:
 *
 * - a Privacy Enhanced Mail (PEM) armoured block;
 * - a Hypertext Transfer Protocol (HTTP) authentication scheme followed by
 *   credentials, which is the RFC 7235 `credentials` production;
 * - a JSON Web Token, which is three base64url segments whose header segment
 *   begins with the `eyJ` encoding of `{"`;
 * - uniform resource locator (URL) userinfo, which is the RFC 3986
 *   `userinfo@host` production and is the shape a leaked password takes inside
 *   a URL;
 * - a capability handle, which is the fixed opaque base64url encoding this
 *   runtime issues; and
 * - any other opaque high-entropy token, including the value half of a
 *   `name=value` or `name:value` pair such as a signed URL query parameter.
 *
 * A redacted value becomes `[redacted:<class>:<correlation>]`. The correlation
 * tag is a truncated keyed hash under a per-host key, so an operator can still
 * tell "the same unknown secret appeared twice" without the log carrying any
 * material that helps recover it. The key never leaves the process and is
 * never logged.
 */
export type StructuralRedactionClass =
  | "pem"
  | "auth"
  | "jwt"
  | "userinfo"
  | "handle"
  | "token";

export interface StructuralRedactionOptions {
  /**
   * Key for the correlation tag. Callers inject a fixed key only in tests; a
   * host uses the random per-process default so tags cannot be precomputed.
   */
  readonly correlationKey?: Uint8Array;
  /** Shortest token that may be classified as an opaque secret. */
  readonly minimumTokenLength?: number;
  /** Shannon entropy in bits per character required of an opaque secret. */
  readonly minimumTokenEntropyBits?: number;
}

const DEFAULT_MINIMUM_TOKEN_LENGTH = 20;
const DEFAULT_MINIMUM_TOKEN_ENTROPY_BITS = 3;
const CORRELATION_TAG_LENGTH = 12;
const MAXIMUM_PAIR_DEPTH = 3;

const PEM_BLOCK = /-----BEGIN[A-Z0-9 ]*-----[\s\S]*?-----END[A-Z0-9 ]*-----/g;
const AUTHENTICATION_CREDENTIALS =
  /\b(Bearer|Basic|Digest|Negotiate|Token|APIKey|AWS4-HMAC-SHA256)[ \t]+([A-Za-z0-9._~+/=-]{8,})/gi;
const JSON_WEB_TOKEN =
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const URL_USERINFO = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@]{1,256})@/g;
/** Longest run of characters that can appear inside an opaque credential. */
const OPAQUE_SPAN = /[A-Za-z0-9_+/=.:~-]{8,}/g;
/** `name=value` or `name:value`, the shape a query parameter or header takes. */
const NAMED_PAIR = /^([A-Za-z0-9_.-]{1,64})([=:])(.+)$/;
/** An algorithm-labelled content digest is a public integrity value. */
const ALGORITHM_DIGEST =
  /^(?:sha1|sha256|sha384|sha512|md5|blake2b|blake3)(?:-[0-9]{1,4})?:[0-9a-fA-F]{8,}$/;
/** The opaque base64url encoding used for capability handles. */
const CAPABILITY_HANDLE_SHAPE = /^[A-Za-z0-9_-]{43,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function shannonEntropyBits(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function longestAlphanumericRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (/[A-Za-z0-9]/.test(character)) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/**
 * Escapes every character that could end a log line or start a new one.
 *
 * A record reaches its sink as a structured object, so a newline cannot create
 * a second record even before this runs; escaping additionally stops a newline
 * from forging a second line inside whatever line-oriented format the sink
 * later chooses.
 */
export function escapeLogText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    const code = character.codePointAt(0)!;
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

export class StructuralRedactor {
  readonly #correlationKey: Uint8Array;
  readonly #minimumTokenLength: number;
  readonly #minimumTokenEntropyBits: number;

  constructor(options: StructuralRedactionOptions = {}) {
    this.#correlationKey = options.correlationKey ?? randomBytes(32);
    this.#minimumTokenLength =
      options.minimumTokenLength ?? DEFAULT_MINIMUM_TOKEN_LENGTH;
    this.#minimumTokenEntropyBits =
      options.minimumTokenEntropyBits ?? DEFAULT_MINIMUM_TOKEN_ENTROPY_BITS;
    if (
      !Number.isSafeInteger(this.#minimumTokenLength) ||
      this.#minimumTokenLength < 8
    ) {
      throw new RangeError("minimumTokenLength must be a safe integer of at least 8");
    }
    if (
      !Number.isFinite(this.#minimumTokenEntropyBits) ||
      this.#minimumTokenEntropyBits <= 0
    ) {
      throw new RangeError("minimumTokenEntropyBits must be a positive number");
    }
  }

  /** Stable marker for one redacted value. Never derived from the plain text alone. */
  marker(redactionClass: StructuralRedactionClass, secret: string): string {
    const tag = createHmac("sha256", this.#correlationKey)
      .update(`${redactionClass}\u0000${secret}`, "utf8")
      .digest("hex")
      .slice(0, CORRELATION_TAG_LENGTH);
    return `[redacted:${redactionClass}:${tag}]`;
  }

  /**
   * True when a token carries the shape of opaque credential material rather
   * than the shape of a name, path segment, timestamp, or content digest.
   */
  looksLikeOpaqueSecret(token: string): boolean {
    if (CAPABILITY_HANDLE_SHAPE.test(token)) return true;
    if (token.length < this.#minimumTokenLength) return false;
    if (ALGORITHM_DIGEST.test(token)) return false;
    if (/^[0-9]+$/.test(token)) return false;
    // A separated name such as `module-generation-a` or `com.example.fixture`
    // never contains one long unbroken run of credential characters.
    if (longestAlphanumericRun(token) < this.#minimumTokenLength) return false;
    const hasLower = /[a-z]/.test(token);
    const hasUpper = /[A-Z]/.test(token);
    const hasDigit = /[0-9]/.test(token);
    const isLongHexadecimal = /^[0-9a-f]{32,}$/i.test(token);
    if (!isLongHexadecimal && !(hasDigit && (hasLower || hasUpper))) return false;
    return shannonEntropyBits(token) >= this.#minimumTokenEntropyBits;
  }

  /**
   * Redacts one string. Runs the shape rules that need surrounding context
   * first, then scans the remaining opaque spans. Markers use characters that
   * the span scanner treats as separators, so a marker is never rescanned into
   * another marker.
   */
  redactText(value: string): { readonly text: string; readonly redactions: number } {
    let redactions = 0;
    const count = <Result>(produce: () => Result): Result => {
      redactions += 1;
      return produce();
    };

    let text = value.replace(PEM_BLOCK, (match) =>
      count(() => this.marker("pem", match)),
    );
    text = text.replace(AUTHENTICATION_CREDENTIALS, (_match, scheme: string, credentials: string) =>
      count(() => `${scheme} ${this.marker("auth", credentials)}`),
    );
    text = text.replace(JSON_WEB_TOKEN, (match) =>
      count(() => this.marker("jwt", match)),
    );
    text = text.replace(URL_USERINFO, (_match, scheme: string, userinfo: string) =>
      count(() => `${scheme}${this.marker("userinfo", userinfo)}@`),
    );
    text = text.replace(OPAQUE_SPAN, (span) => {
      const replaced = this.#redactSpan(span, 0);
      if (replaced === span) return span;
      redactions += 1;
      return replaced;
    });
    return { text, redactions };
  }

  #redactSpan(span: string, depth: number): string {
    if (ALGORITHM_DIGEST.test(span)) return span;
    // A `name=value` span is split first so the name survives in the log and
    // only the value half is classified. Nothing about the name decides the
    // outcome; it is kept solely so an operator can see which parameter was
    // removed.
    if (depth < MAXIMUM_PAIR_DEPTH) {
      const pair = NAMED_PAIR.exec(span);
      if (pair) {
        const [, name, separator, rest] = pair as unknown as [
          string,
          string,
          string,
          string,
        ];
        const replaced = this.#redactSpan(rest, depth + 1);
        if (replaced !== rest) return `${name}${separator}${replaced}`;
      }
    }
    if (this.looksLikeOpaqueSecret(span)) {
      // Hexadecimal of the same length is a digest or signature, not the
      // base64url encoding a capability handle uses; both are redacted, but
      // the class an operator sees should stay truthful.
      const redactionClass: StructuralRedactionClass =
        CAPABILITY_HANDLE_SHAPE.test(span) && !/^[0-9a-fA-F]+$/.test(span)
          ? "handle"
          : "token";
      return this.marker(redactionClass, span);
    }
    return span;
  }
}
