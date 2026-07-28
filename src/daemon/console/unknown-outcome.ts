/**
 * The audited operator flow for a Module Claim preserved as an unknown outcome.
 *
 * `security-operations.md` Section 13.1 states the four obligations of the
 * operator interface, and this module implements them without weakening any
 * automatic rule:
 *
 * 1. identify the exact Claim and show the evidence Core actually considered —
 *    the Module process record and its stop proof, the submission record, the
 *    result journal entry or its absence, and each external-effect intent with
 *    its recorded outcome;
 * 2. offer only dispositions whose consequence is stated plainly;
 * 3. require an explicit confirmation for a forced release that warns it can
 *    repeat an already completed external effect; and
 * 4. emit the Section 11 audit event recording the actor, the chosen
 *    disposition, and the evidence shown, **before** the disposition is
 *    applied.
 *
 * The confirmation is bound to a digest of the exact evidence that was shown,
 * so an operator cannot confirm one screen and apply a decision to another.
 */

import { canonicalJsonDigest, deepFreeze, type JsonValue } from "../../core/canonical-json.js";
import type { DeliveryStore } from "../../core/delivery-store.js";
import { ConsoleOperationError } from "./operation-catalog.js";

export interface UnknownOutcomeClaimIdentity {
  readonly moduleJobId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
}

export interface ExternalEffectIntentEvidence {
  readonly intentId: string;
  readonly description: string;
  /** `unknown` is the state that makes a forced release repeatable. */
  readonly recordedOutcome: "no-effect" | "retry-safe" | "terminal" | "unknown";
}

export interface UnknownOutcomeEvidence {
  /** Why Core could not decide the Claim from durable evidence. */
  readonly preservedReason: string;
  readonly moduleProcessRecord: JsonValue | null;
  readonly moduleProcessStopProof: JsonValue | null;
  readonly submissionRecord: JsonValue | null;
  /** `null` states plainly that no result journal entry exists. */
  readonly resultJournalEntry: JsonValue | null;
  readonly externalEffectIntents: readonly ExternalEffectIntentEvidence[];
}

export interface PreservedUnknownOutcomeClaim {
  readonly schemaVersion: "dolly.unknown-outcome-claim/1";
  readonly identity: UnknownOutcomeClaimIdentity;
  readonly moduleId: string;
  readonly evidence: UnknownOutcomeEvidence;
  /** Digest of `identity` and `evidence`; a confirmation names this value. */
  readonly evidenceDigest: string;
  readonly offeredDispositions: readonly UnknownOutcomeDispositionOffer[];
}

export type UnknownOutcomeDisposition = "release" | "dead-letter" | "leave-unresolved";

export interface UnknownOutcomeDispositionOffer {
  readonly disposition: UnknownOutcomeDisposition;
  readonly consequence: string;
  readonly requiresAcknowledgedWarning: boolean;
}

export interface UnknownOutcomeWarning {
  readonly schemaVersion: "dolly.unknown-outcome-warning/1";
  readonly disposition: "release";
  readonly identity: UnknownOutcomeClaimIdentity;
  readonly evidenceDigest: string;
  readonly consequence: string;
  /** Every intent Core could not prove did not happen. */
  readonly unprovenExternalEffects: readonly string[];
  /** The value the caller echoes back as `acknowledgedWarningDigest`. */
  readonly acknowledgementDigest: string;
}

export interface UnknownOutcomeDispositionRequest {
  readonly identity: UnknownOutcomeClaimIdentity;
  readonly disposition: UnknownOutcomeDisposition;
  readonly reasonCode: string;
}

export type UnknownOutcomeDispositionOutcome =
  | "released"
  | "already-released"
  | "dead-lettered"
  | "left-unresolved";

/**
 * The durable side of the flow. Reading and applying stay behind one port
 * because the Claim lives in one instance's Core, which the daemon reaches
 * through no implemented interprocess channel today.
 */
export interface UnknownOutcomeClaimStore {
  listPreservedClaims(): Promise<readonly PreservedUnknownOutcomeClaim[]>;
  applyDisposition(
    request: UnknownOutcomeDispositionRequest,
  ): Promise<UnknownOutcomeDispositionOutcome>;
}

const RELEASE_CONSEQUENCE =
  "Releasing this Claim makes its Deliveries pending again for another attempt. Core cannot prove the submitted Run did not already take effect, so the retry can repeat an external effect that already completed.";
const DEAD_LETTER_CONSEQUENCE =
  "Dead-lettering records every remaining Delivery of this Claim as a dead-letter record. The work is not retried and the Deliveries are never silently discarded.";
const LEAVE_CONSEQUENCE =
  "Leaving the Claim unresolved keeps it active and its Module inactive. Nothing is released, retried, or removed.";

/**
 * Exactly three dispositions exist, and every one states its consequence.
 * Removing the Module is deliberately absent: `instance-topology.md`
 * Section 7.6 forbids offering it here.
 */
export function describeOfferedDispositions(): readonly UnknownOutcomeDispositionOffer[] {
  return deepFreeze([
    {
      disposition: "release" as const,
      consequence: RELEASE_CONSEQUENCE,
      requiresAcknowledgedWarning: true,
    },
    {
      disposition: "dead-letter" as const,
      consequence: DEAD_LETTER_CONSEQUENCE,
      requiresAcknowledgedWarning: false,
    },
    {
      disposition: "leave-unresolved" as const,
      consequence: LEAVE_CONSEQUENCE,
      requiresAcknowledgedWarning: false,
    },
  ]) as readonly UnknownOutcomeDispositionOffer[];
}

export function unprovenExternalEffects(evidence: UnknownOutcomeEvidence): readonly string[] {
  return evidence.externalEffectIntents
    .filter((intent) => intent.recordedOutcome === "unknown")
    .map((intent) => `${intent.intentId}: ${intent.description}`)
    .sort();
}

/** Digest that binds a Claim's identity to the exact evidence shown with it. */
export function evidenceDigest(
  identity: UnknownOutcomeClaimIdentity,
  evidence: UnknownOutcomeEvidence,
): string {
  return canonicalJsonDigest({ identity, evidence } as unknown as JsonValue);
}

export function buildPreservedClaim(input: {
  readonly identity: UnknownOutcomeClaimIdentity;
  readonly moduleId: string;
  readonly evidence: UnknownOutcomeEvidence;
}): PreservedUnknownOutcomeClaim {
  return deepFreeze({
    schemaVersion: "dolly.unknown-outcome-claim/1",
    identity: input.identity,
    moduleId: input.moduleId,
    evidence: input.evidence,
    evidenceDigest: evidenceDigest(input.identity, input.evidence),
    offeredDispositions: describeOfferedDispositions(),
  }) as PreservedUnknownOutcomeClaim;
}

/**
 * The warning a forced release must return before anything is applied. The
 * acknowledgement digest covers the warning body, so a confirmation computed
 * against different evidence cannot be replayed against this Claim.
 */
export function buildForcedReleaseWarning(
  claim: PreservedUnknownOutcomeClaim,
): UnknownOutcomeWarning {
  const body = {
    schemaVersion: "dolly.unknown-outcome-warning/1" as const,
    disposition: "release" as const,
    identity: claim.identity,
    evidenceDigest: claim.evidenceDigest,
    consequence: RELEASE_CONSEQUENCE,
    unprovenExternalEffects: unprovenExternalEffects(claim.evidence),
  };
  return deepFreeze({
    ...body,
    acknowledgementDigest: canonicalJsonDigest(body as unknown as JsonValue),
  }) as UnknownOutcomeWarning;
}

export function assertUnknownOutcomeDisposition(value: unknown): UnknownOutcomeDisposition {
  if (value === "release" || value === "dead-letter" || value === "leave-unresolved") {
    return value;
  }
  throw new ConsoleOperationError(
    "UNKNOWN_OUTCOME_DISPOSITION_INVALID",
    'disposition must be "release", "dead-letter", or "leave-unresolved"',
    { offered: ["dead-letter", "leave-unresolved", "release"] },
  );
}

/**
 * Applies an operator disposition to a live `DeliveryStore`. A release restores
 * the exact Claim's Deliveries to pending; a dead letter records every
 * remaining Delivery rather than discarding it; leaving it unresolved touches
 * nothing.
 */
export function deliveryStoreDispositionApplier(
  deliveries: DeliveryStore,
): UnknownOutcomeClaimStore["applyDisposition"] {
  return async (request) => {
    if (request.disposition === "leave-unresolved") return "left-unresolved";
    if (request.disposition === "release") {
      return deliveries.releaseClaim(request.identity);
    }
    const result = deliveries.nack({
      ...request.identity,
      failure: { code: request.reasonCode, retryable: false },
    });
    if (result !== "dead-lettered") {
      throw new ConsoleOperationError(
        "ADMIN_OPERATION_FAILED",
        `A non-retryable operator disposition produced ${result} instead of a dead-letter record`,
        { claimToken: request.identity.claimToken },
      );
    }
    return "dead-lettered";
  };
}
