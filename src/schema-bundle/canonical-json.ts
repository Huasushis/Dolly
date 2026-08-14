/**
 * Canonical JSON for Dolly Core v1 — JSON Canonicalization Scheme (JCS, RFC 8785)
 * conformance plus the Core JSON profile from
 * `docs/spec/core/01-identifiers-and-canonical-json.md`.
 *
 * This module is the schema-bundle entry point for canonical encoding. It
 * reuses the audited Core implementation in `../core/canonical-json.js` and
 * `../core/strict-json.js` rather than introducing a second canonicalizer, so
 * there is exactly one byte-faithful convention for the whole workspace.
 *
 * Canonical-JSON rules implemented (RFC 8785 + Dolly Core profile §2):
 *
 * 1.  Output is UTF-8 without a byte-order mark.
 * 2.  No insignificant whitespace; members are separated only by `,` and `:`.
 * 3.  Object members are sorted by member name using the UTF-16 code-unit
 *     ordering of the UTF-16-encoded key (RFC 8785 §3.2.3) — the exact
 *     ordering `Array.prototype.sort()` produces on `Object.keys()`.
 * 4.  Numbers serialize via the ECMAScript shortest-round-trip algorithm
 *     (`JSON.stringify`, which RFC 8785 §3.2.2.3 references via Note 2):
 *     minimal digits, lowercase `e`, no leading `+`, no trailing zeros. The
 *     Core profile additionally rejects `-0`, `NaN`, and `±Infinity`.
 * 5.  Strings serialize with `JSON.stringify` escaping (RFC 8785 §3.2.2.2).
 * 6.  Duplicate object member names are rejected at the text-parse boundary
 *     (see {@link parseCanonicalJsonText}) before canonicalization, because
 *     the post-parse object model cannot observe collisions.
 * 7.  Lone UTF-16 surrogates in strings or member names are rejected.
 * 8.  Non-plain object prototypes are rejected (no `Date`, `Map`, etc.).
 * 9.  Digests are `sha256:<64 lowercase hex>` over the UTF-8 JCS bytes.
 *
 * @see https://www.rfc-editor.org/rfc/rfc8785 RFC 8785
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  assertJsonValue,
  canonicalizeJson as coreCanonicalizeJson,
  canonicalJsonByteLength as coreCanonicalJsonByteLength,
  canonicalJsonDigest as coreCanonicalJsonDigest,
  type JsonValue,
} from "../core/canonical-json.js";
import {
  type StrictJsonOptions,
  parseStrictJsonBytes,
  parseStrictJsonText,
  StrictJsonError,
} from "../core/strict-json.js";

export type { JsonValue, JsonPrimitive } from "../core/canonical-json.js";

/**
 * Error code set for the schema-bundle canonical layer. These surface the
 * Core profile's `CORE_INVALID_JSON` family (`docs/spec/core/01-…`, §7).
 */
export type CanonicalJsonErrorCode =
  | "CANONICAL_JSON_INVALID_VALUE"
  | "CANONICAL_JSON_DUPLICATE_KEY"
  | "CANONICAL_JSON_SYNTAX"
  | "CANONICAL_JSON_UTF8"
  | "CANONICAL_JSON_LIMIT";

/**
 * Error thrown when a value cannot be represented by the Dolly Core canonical
 * JSON profile. A non-representable value MUST fail rather than be coerced.
 */
export class CanonicalJsonError extends TypeError {
  constructor(
    readonly code: CanonicalJsonErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CanonicalJsonError";
  }
}

/** Default nesting-depth budget for strict parsing (Core profile §2.9). */
export const DEFAULT_MAX_JSON_NESTING_DEPTH = 64;

/** Default byte budget for strict parsing of a single Core document. */
export const DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024;

function strictOptions(
  overrides?: Partial<StrictJsonOptions>,
): StrictJsonOptions {
  return {
    maxBytes: overrides?.maxBytes ?? DEFAULT_MAX_JSON_BYTES,
    maxDepth: overrides?.maxDepth ?? DEFAULT_MAX_JSON_NESTING_DEPTH,
  };
}

function wrapValueError(error: unknown): CanonicalJsonError {
  // The core layer throws its own CanonicalJsonError (codes INVALID_JSON_VALUE
  // / INVALID_UNICODE), which the bundle index never exports. Surface every
  // value-level failure as the bundle class so `instanceof CanonicalJsonError`
  // (the exported type) matches at every entry point.
  if (error instanceof CanonicalJsonError) return error;
  const message = error instanceof Error ? error.message : "Invalid JSON value";
  return new CanonicalJsonError("CANONICAL_JSON_INVALID_VALUE", message, { cause: error });
}

function wrapStrictError(error: unknown): CanonicalJsonError {
  if (error instanceof StrictJsonError) {
    switch (error.code) {
      case "STRICT_JSON_LIMIT_EXCEEDED":
        return new CanonicalJsonError("CANONICAL_JSON_LIMIT", error.message, { cause: error });
      case "STRICT_JSON_UTF8_INVALID":
        return new CanonicalJsonError("CANONICAL_JSON_UTF8", error.message, { cause: error });
      case "STRICT_JSON_SYNTAX_INVALID":
        return new CanonicalJsonError("CANONICAL_JSON_SYNTAX", error.message, { cause: error });
      case "STRICT_JSON_VALUE_INVALID":
        return new CanonicalJsonError("CANONICAL_JSON_INVALID_VALUE", error.message, { cause: error });
    }
  }
  return new CanonicalJsonError("CANONICAL_JSON_SYNTAX", "Invalid JSON", { cause: error });
}

/**
 * Parse JSON text into a Core-profile-safe value, rejecting duplicate object
 * keys, invalid UTF-8, non-finite numbers, negative zero, lone surrogates,
 * and excessive nesting before canonicalization. The Core strict parser
 * detects duplicate keys at the text boundary (spec §2.2); this is the only
 * layer that can observe collisions, so {@link canonicalizeJson} assumes its
 * input already has unique keys.
 */
export function parseCanonicalJsonText(
  text: string,
  options?: Partial<StrictJsonOptions>,
): JsonValue {
  try {
    return parseStrictJsonText(text, strictOptions(options));
  } catch (error) {
    throw wrapStrictError(error);
  }
}

/**
 * Parse canonical-JSON bytes (UTF-8, no BOM) into a Core-profile-safe value.
 * A leading UTF-8 byte-order mark (EF BB BF) is rejected explicitly — the
 * default `TextDecoder` silently strips it, contradicting the "(UTF-8, no
 * BOM)" input contract. Invalid UTF-8 is rejected before any structural scan.
 */
export function parseCanonicalJsonBytes(
  bytes: Uint8Array,
  options?: Partial<StrictJsonOptions>,
): JsonValue {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_UTF8",
      "UTF-8 byte-order mark is not permitted in canonical JSON",
    );
  }
  try {
    return parseStrictJsonBytes(bytes, strictOptions(options));
  } catch (error) {
    throw wrapStrictError(error);
  }
}

/**
 * Bounded depth pre-scan mirroring the parse boundary's 64-level budget.
 * Threading depth into the core `assertJsonValue` is not possible (it has no
 * depth parameter), so we walk the structure first and reject nesting deeper
 * than {@link DEFAULT_MAX_JSON_NESTING_DEPTH} before the core recursion can
 * overflow the call stack. A `seen` set guards against cycles so this pre-scan
 * itself never overflows. The core assertion still handles lone surrogates,
 * negative zero, and non-plain prototypes.
 */
function assertValueDepth(value: unknown, depth: number, seen: Set<object>): void {
  if (value === null || typeof value !== "object") return;
  if (depth > DEFAULT_MAX_JSON_NESTING_DEPTH) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_LIMIT",
      `JSON nesting exceeds the ${DEFAULT_MAX_JSON_NESTING_DEPTH}-level limit`,
    );
  }
  if (seen.has(value)) return; // cycle — core assertion will reject it
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertValueDepth(item, depth + 1, seen);
  } else {
    for (const key of Object.keys(value)) assertValueDepth((value as Record<string, unknown>)[key], depth + 1, seen);
  }
  seen.delete(value);
}

/**
 * Assert that `value` is representable by the Dolly Core canonical JSON
 * profile (RFC 8785 + Core §2). Enforces the same 64-level nesting budget as
 * the parse boundary so a deeply nested programmatic value fails with
 * {@link CanonicalJsonError} instead of overflowing the call stack. Throws
 * {@link CanonicalJsonError} on failure.
 */
export function assertCanonicalJsonValue(value: unknown): asserts value is JsonValue {
  assertValueDepth(value, 1, new Set());
  try {
    assertJsonValue(value);
  } catch (error) {
    throw wrapValueError(error);
  }
}

/**
 * Verify that `declaredDigest` matches the canonical digest of `value`.
 * Returns `true` on match. Comparison is constant-time because digest
 * comparison controls authority: a mismatch MUST NOT be repaired by accepting
 * the sender's bytes (Core profile §2.2, `CORE_DIGEST_MISMATCH`).
 *
 * A declared digest must have the exact form `sha256:<64 lowercase hex>`.
 */
export function verifyCanonicalDigest(value: unknown, declaredDigest: string): boolean {
  if (!/^sha256:[0-9a-f]{64}$/u.test(declaredDigest)) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_INVALID_VALUE",
      "Declared digest must match sha256:<64 lowercase hex>",
    );
  }
  // canonicalJsonDigest validates *and* digests in one pass; calling
  // assertCanonicalJsonValue first would re-walk the tree, so let the digest
  // computation surface value errors via wrapValueError instead.
  const computed = Buffer.from(canonicalJsonDigest(value).slice("sha256:".length), "hex");
  const declared = Buffer.from(declaredDigest.slice("sha256:".length), "hex");
  // Both are 32 bytes (guaranteed by the sha256:<64 hex> regex), so the
  // length check is a defensive invariant rather than a timing leak.
  if (declared.length !== computed.length) return false;
  return timingSafeEqual(computed, declared);
}

/**
 * RFC 8785 canonical string for a Core-profile value. Failures are wrapped in
 * the bundle {@link CanonicalJsonError} so every exported entry point honors
 * the same catch contract.
 */
export function canonicalizeJson(value: unknown): string {
  try {
    return coreCanonicalizeJson(value);
  } catch (error) {
    throw wrapValueError(error);
  }
}

/** UTF-8 bytes of the canonical (JCS) encoding of `value`. */
export function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalizeJson(value), "utf8");
}

/** `sha256:<64 hex>` digest over the UTF-8 JCS bytes (self-validating). */
export function canonicalJsonDigest(value: unknown): string {
  try {
    return coreCanonicalJsonDigest(value);
  } catch (error) {
    throw wrapValueError(error);
  }
}

/** UTF-8 byte length of the canonical encoding (self-validating). */
export function canonicalJsonByteLength(value: unknown): number {
  try {
    return coreCanonicalJsonByteLength(value);
  } catch (error) {
    throw wrapValueError(error);
  }
}
