/**
 * Host-owned, closed outbound policy for the NapCatQQ Channel slice.
 *
 * The allowlists are fixed host-owned constants: exactly group `739571751` and
 * private users `3227435534` and `1074313761` may receive outbound sends; every
 * other recipient is denied by default. The policy is an immutable singleton
 * with a private constructor and no mutator, so no caller can widen an
 * allowlist. Policy decisions are discriminated unions, never booleans a
 * caller could substitute, so "deny" cannot be recast as an allow result.
 */

import { normalizeQQId, type QQCanonicalId, type QQIdRejectReason } from "./ids.js";

export type OutboundRecipient =
  | { readonly kind: "group"; readonly group_id: QQCanonicalId }
  | { readonly kind: "private"; readonly user_id: QQCanonicalId };

/** Raw caller-supplied target before normalization; the id is unknown-shaped. */
export type OutboundTargetSpec =
  | { readonly kind: "group"; readonly id: string }
  | { readonly kind: "private"; readonly id: string };

export type OutboundDenialReason =
  | QQIdRejectReason
  | "group_not_allowed"
  | "user_not_allowed";

export type OutboundDecision =
  | { readonly allowed: true; readonly recipient: OutboundRecipient }
  | { readonly allowed: false; readonly reason: OutboundDenialReason };

const ALLOWED_GROUP_IDS = Object.freeze(["739571751"] as const);
const ALLOWED_USER_IDS = Object.freeze(["3227435534", "1074313761"] as const);

/** Read-only view of the fixed host-owned allowlists (cannot be widened). */
export const NAPCAT_OUTBOUND_ALLOWLIST = Object.freeze({
  groups: ALLOWED_GROUP_IDS,
  users: ALLOWED_USER_IDS,
});

export class OutboundPolicy {
  // Membership is dynamic lookup over the fixed arrays; values are literal.
  #groups: readonly string[];
  #users: readonly string[];

  private constructor(groups: readonly string[], users: readonly string[]) {
    this.#groups = groups;
    this.#users = users;
  }

  /** Builds the immutable host-owned policy from the fixed allowlist above. */
  static hostDefault(): OutboundPolicy {
    return new OutboundPolicy(ALLOWED_GROUP_IDS, ALLOWED_USER_IDS);
  }

  evaluate(target: OutboundTargetSpec): OutboundDecision {
    const normalized = normalizeQQId(target.id);
    if (normalized.kind === "invalid") {
      return Object.freeze({ allowed: false as const, reason: normalized.reason });
    }
    if (target.kind === "group") {
      if (this.#groups.includes(normalized.id) === false) {
        return Object.freeze({ allowed: false as const, reason: "group_not_allowed" });
      }
      return Object.freeze({
        allowed: true as const,
        recipient: { kind: "group", group_id: normalized.id },
      });
    }
    if (this.#users.includes(normalized.id) === false) {
      return Object.freeze({ allowed: false as const, reason: "user_not_allowed" });
    }
    return Object.freeze({
      allowed: true as const,
      recipient: { kind: "private", user_id: normalized.id },
    });
  }
}

/** The one host-owned policy instance for this slice. */
export const HOST_OUTBOUND_POLICY: OutboundPolicy = Object.freeze(
  OutboundPolicy.hostDefault(),
) as unknown as OutboundPolicy;
