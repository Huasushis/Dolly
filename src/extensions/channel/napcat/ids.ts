/**
 * Exact decimal-string QQ/OneBot identifiers for the NapCatQQ profile.
 *
 * napcatqq.md §1.1 requires every QQ, message, user, group, file, request, and
 * self ID to be normalized as a string and never pass through a JavaScript
 * number representation that loses precision. This slice accepts only the
 * canonical exact decimal spelling of a positive decimal QQ identity; anything
 * that would require changing the string to carry the same identity — trimming,
 * a leading sign, a base prefix, an exponent, leading zeros, or a magnitude
 * outside the exact safe-integer range — is rejected rather than silently
 * coerced.
 */

/** Bound on decimal digit count so the BigInt overflow check cannot scale. */
const MAX_ID_DIGITS = 19;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** Branded exact decimal QQ ID. Constructed only by {@link normalizeQQId}. */
export type QQCanonicalId = string & { readonly __qqId: unique symbol };

export type QQIdRejectReason =
  | "empty"
  | "not_decimal"
  | "sign"
  | "ambiguous"
  | "too_long"
  | "overflow";

export type QQIdNormalization =
  | { readonly kind: "ok"; readonly id: QQCanonicalId }
  | { readonly kind: "invalid"; readonly reason: QQIdRejectReason };

export function normalizeQQId(raw: unknown): QQIdNormalization {
  if (typeof raw !== "string") return { kind: "invalid", reason: "not_decimal" };
  if (raw.length === 0) return { kind: "invalid", reason: "empty" };
  if (raw.length > MAX_ID_DIGITS) return { kind: "invalid", reason: "too_long" };

  if (/^[+-]/.test(raw)) return { kind: "invalid", reason: "sign" };
  if (/^[0-9]+$/.test(raw) === false) {
    // Any digit alongside a non-digit, a decimal point, or an exponent prefix
    // has an ambiguous spelling and is not the canonical exact decimal string.
    return { kind: "invalid", reason: "not_decimal" };
  }
  if (raw.length > 1 && raw.startsWith("0")) {
    return { kind: "invalid", reason: "ambiguous" };
  }
  if (BigInt(raw) > MAX_SAFE_BIGINT) {
    return { kind: "invalid", reason: "overflow" };
  }
  return { kind: "ok", id: raw as QQCanonicalId };
}
