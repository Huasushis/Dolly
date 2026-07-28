/**
 * Delimiting and quoting for untrusted text inside an assembled prompt.
 *
 * Contract: `docs/spec/llm-extension.md` section 5 (prompt trust),
 * `docs/spec/core-runtime.md` section 9.2.1 (a Module description is
 * descriptive data, not authorization), and `docs/spec/security-operations.md`
 * section 10 (prompt text and extension payloads are untrusted data).
 *
 * Three independent mechanisms keep untrusted text from becoming an
 * instruction, so defeating one is not enough:
 *
 * 1. **Unforgeable markers.** Every host-generated marker carries a fence
 *    token derived from a digest of the whole assembly request. Untrusted text
 *    cannot predict it, because the digest covers that same text; predicting it
 *    would require solving a fixed point over SHA-256.
 * 2. **Redaction.** If untrusted text nonetheless contains the fence token, the
 *    token is replaced before the text is placed, and a notice records that it
 *    happened. This is the hard guarantee; the token's unpredictability is only
 *    defence in depth.
 * 3. **Line quoting.** Every line of untrusted text is prefixed, so no
 *    untrusted byte ever appears at the start of a line. Markers are defined to
 *    be recognized only at a line start, which makes a forged marker
 *    unrepresentable rather than merely unlikely.
 *
 * Control characters are stripped as well, so a carriage return cannot hide the
 * quoting prefix from a terminal or from a model reading a rendered transcript.
 */

import { canonicalJsonDigest, type JsonValue } from "../../core/canonical-json.js";
import { ContextAssemblyError } from "./context-types.js";

/** Prefix placed at the start of every quoted untrusted line. */
export const UNTRUSTED_LINE_PREFIX = "| ";

/** Replacement written when untrusted text contains the assembly's fence token. */
export const REDACTED_FENCE_PLACEHOLDER = "[redacted-fence-token]";

const TRUNCATION_LINE = `${UNTRUSTED_LINE_PREFIX}[truncated]`;

/** Number of hexadecimal characters kept from the request digest. */
const FENCE_TOKEN_LENGTH = 16;

const CHARACTER_TAB = 0x09;
const CHARACTER_LINE_FEED = 0x0a;
const CHARACTER_SPACE = 0x20;
const CHARACTER_DELETE = 0x7f;
const CHARACTER_LINE_SEPARATOR = 0x2028;
const CHARACTER_PARAGRAPH_SEPARATOR = 0x2029;

/**
 * Derives the per-assembly fence token.
 *
 * Determinism: the token is a pure function of the canonical JSON of the whole
 * request, so replaying the same Module job produces the same prompt bytes.
 */
export function deriveFenceToken(request: JsonValue): string {
  const digest = canonicalJsonDigest(request);
  return digest.slice("sha256:".length, "sha256:".length + FENCE_TOKEN_LENGTH);
}

/**
 * Renders one host-generated marker line.
 *
 * The token makes the line attributable to the host; the caller is responsible
 * for redacting the token from any untrusted text it places in the same prompt.
 */
export function marker(fenceToken: string, body: string): string {
  return `[dolly#${fenceToken} ${body}]`;
}

/** Renders `key="value"` pairs for a marker body with a stable field order. */
export function markerFields(
  fields: readonly (readonly [string, string | number | boolean])[],
): string {
  return fields
    .map(([key, value]) =>
      typeof value === "string" ? `${key}="${value}"` : `${key}=${String(value)}`,
    )
    .join(" ");
}

/**
 * Removes control characters and normalizes line endings.
 *
 * Tab is kept because it carries indentation meaning in quoted text. Everything
 * else below U+0020, plus U+007F and the Unicode line/paragraph separators, is
 * dropped so that a single logical line stays a single physical line.
 */
export function sanitizeUntrustedText(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  let sanitized = "";
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code === CHARACTER_TAB || code === CHARACTER_LINE_FEED) {
      sanitized += character;
      continue;
    }
    if (
      code < CHARACTER_SPACE ||
      code === CHARACTER_DELETE ||
      code === CHARACTER_LINE_SEPARATOR ||
      code === CHARACTER_PARAGRAPH_SEPARATOR
    ) {
      continue;
    }
    sanitized += character;
  }
  return sanitized;
}

export interface QuotedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly redacted: boolean;
}

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Smallest quoting budget that always holds one prefixed character plus the truncation line. */
export const MIN_QUOTED_BYTES = byteLength(TRUNCATION_LINE) + UNTRUSTED_LINE_PREFIX.length + 2;

/**
 * Quotes untrusted text into a bounded, line-prefixed block.
 *
 * Truncation is line-granular first and byte-granular only inside a single
 * oversized line, so the cut point depends solely on the input text and the
 * budget. A truncated block always ends with a visible `[truncated]` line: the
 * reader can tell that text was removed rather than silently receiving a
 * shortened value that still looks complete.
 */
export function quoteUntrustedText(
  value: string,
  options: { readonly maxBytes: number; readonly fenceToken: string },
): QuotedText {
  const { maxBytes, fenceToken } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_QUOTED_BYTES) {
    throw new ContextAssemblyError(
      "CONTEXT_LIMIT_INVALID",
      `Untrusted text budget must be a safe integer of at least ${MIN_QUOTED_BYTES} bytes`,
      { maxBytes: Number.isSafeInteger(maxBytes) ? maxBytes : null },
    );
  }

  const sanitized = sanitizeUntrustedText(value);
  const redacted = sanitized.includes(fenceToken);
  const safe = redacted
    ? sanitized.split(fenceToken).join(REDACTED_FENCE_PLACEHOLDER)
    : sanitized;

  const lines = safe.split("\n").map((line) => `${UNTRUSTED_LINE_PREFIX}${line}`);
  const whole = lines.join("\n");
  if (byteLength(whole) <= maxBytes) {
    return { text: whole, truncated: false, redacted };
  }

  // The block is known to be over budget, so the truncation line is always
  // needed and its room is reserved before any line is kept.
  const reserved = maxBytes - byteLength(TRUNCATION_LINE) - 1;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = byteLength(line) + (kept.length === 0 ? 0 : 1);
    if (used + cost <= reserved) {
      kept.push(line);
      used += cost;
      continue;
    }
    if (kept.length === 0) {
      const room = reserved - UNTRUSTED_LINE_PREFIX.length;
      if (room > 0) {
        kept.push(
          `${UNTRUSTED_LINE_PREFIX}${truncateUtf8(line.slice(UNTRUSTED_LINE_PREFIX.length), room)}`,
        );
      }
    }
    break;
  }
  kept.push(TRUNCATION_LINE);
  return { text: kept.join("\n"), truncated: true, redacted };
}
