/**
 * The audited operator flow for a Module Claim preserved as an unknown outcome.
 *
 * `security-operations.md` Section 13.1 states the four obligations of the
 * operator interface, and this module implements them without weakening any
 * automatic rule:
 *
 * 1. identify the exact Claim and show the evidence Core actually considered:
 *    the Module process record and its stop proof, the submission record, the
 *    result journal entry or its absence, and each external-effect intent with
 *    its recorded outcome;
 * 2. offer only dispositions whose consequence is stated plainly;
 * 3. require an explicit confirmation for a forced release that warns it can
 *    repeat an already completed external effect; and
 * 4. record the request before applying it, then record actual success or
 *    failure separately.
 *
 * The confirmation is bound to a digest of the exact evidence that was shown,
 * so an operator cannot confirm one screen and apply a decision to another.
 */

import {
  canonicalJsonByteLength,
  canonicalJsonDigest,
  deepFreeze,
  type JsonValue,
} from "../../core/canonical-json.js";
import type {
  ClaimDescriptor,
  DeliveryClaimIdentity,
} from "../../core/delivery-store.js";
import type { ModuleSubmissionRecord } from "../../core/module-process-records.js";
import { ConsoleOperationError } from "./operation-catalog.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_EVIDENCE_STRING_BYTES = 8 * 1024;
const MAX_EXTERNAL_EFFECT_INTENTS = 1024;

export interface ExternalEffectIntentEvidence {
  readonly intentId: string;
  readonly description: string;
  /**
   * `terminal` records that the effect completed; `unknown` records that it
   * may have completed. Re-running the Claim can repeat either one.
   */
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
  readonly identity: DeliveryClaimIdentity;
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
  readonly schemaVersion: "dolly.unknown-outcome-warning/2";
  readonly disposition: "release";
  readonly identity: DeliveryClaimIdentity;
  readonly evidenceDigest: string;
  readonly consequence: string;
  /**
   * Effects known to have completed or not proven absent. Re-running the Claim
   * can repeat every entry in this list.
   */
  readonly externalEffectsThatMayRepeat: readonly {
    readonly intentId: string;
    readonly description: string;
    readonly recordedOutcome: "terminal" | "unknown";
  }[];
  /** The value the caller echoes back as `acknowledgedWarningDigest`. */
  readonly acknowledgementDigest: string;
}

export interface UnknownOutcomeDispositionRequest {
  readonly identity: DeliveryClaimIdentity;
  readonly disposition: UnknownOutcomeDisposition;
  readonly reasonCode: string;
  /**
   * The exact evidence digest shown to the operator. The store that owns the
   * Claim must compare this value with its current evidence at the same
   * serialized boundary that applies the disposition.
   */
  readonly expectedEvidenceDigest: string;
}

export type UnknownOutcomeDispositionOutcome =
  | "released"
  | "already-released"
  | "dead-lettered"
  | "left-unresolved";

/**
 * The Core-state reads and operation an operator disposition may invoke.
 *
 * A product implementation compares the evidence digest, changes the exact
 * Delivery Claim to its terminal state, and removes the matching Module
 * submission record in one Core-state update.
 *
 * `inspectUnknownOutcomeClaim` returns the Claim, matching submission record,
 * and current evidence digest from the same state store used by
 * `applyUnknownOutcomeDisposition`. The digest is absent after the Claim is no
 * longer preserved as an unknown outcome. Inspection before or after the
 * operation is only a result check; it is not a substitute for comparing the
 * digest inside the operation's durable update.
 *
 * `applyUnknownOutcomeDisposition` must be one synchronous operation that
 * compares `expectedEvidenceDigest` with the current evidence and, when they
 * match, applies the requested disposition. It must reject a mismatch before
 * changing the Claim or its submission record. A state store without that
 * operation cannot use this adapter and must implement
 * `UnknownOutcomeClaimStore` only after it can provide the same guarantee.
 */
export interface DeliveryClaimDispositionOperations {
  readonly inspectUnknownOutcomeClaim: (
    identity: DeliveryClaimIdentity,
  ) => {
    readonly claim: ClaimDescriptor;
    readonly submissionRecord: ModuleSubmissionRecord | undefined;
    readonly evidenceDigest: string | undefined;
  };
  readonly applyUnknownOutcomeDisposition: (
    request: UnknownOutcomeDispositionRequest,
  ) => UnknownOutcomeDispositionOutcome;
}

/**
 * The durable side of the flow. Reading and applying stay behind one interface
 * because the Claim lives in one instance's Core, which the daemon reaches
 * through no implemented interprocess channel today.
 *
 * `applyDisposition` must compare `expectedEvidenceDigest` with the evidence
 * currently bound to the exact Claim at the same serialized durable boundary
 * that applies the disposition. A mismatch must reject before changing the
 * Claim. This is an implementation obligation, not something the console's
 * earlier list operation can prove.
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

/**
 * Lists only effects with an `unknown` outcome. Warning schema version 2 keeps
 * this established meaning and uses `externalEffectsThatMayRepeat` for the
 * broader `terminal` plus `unknown` set.
 */
export function unprovenExternalEffects(evidence: UnknownOutcomeEvidence): readonly string[] {
  return evidence.externalEffectIntents
    .filter((intent) => intent.recordedOutcome === "unknown")
    .map((intent) => `${intent.intentId}: ${intent.description}`)
    .sort();
}

/**
 * Lists effects that a forced rerun can repeat. A `terminal` outcome proves the
 * effect completed; an `unknown` outcome does not prove that it did not.
 */
export function externalEffectsThatMayRepeat(
  evidence: UnknownOutcomeEvidence,
): UnknownOutcomeWarning["externalEffectsThatMayRepeat"] {
  return evidence.externalEffectIntents
    .filter(
      (intent): intent is ExternalEffectIntentEvidence & {
        readonly recordedOutcome: "terminal" | "unknown";
      } =>
        intent.recordedOutcome === "terminal" ||
        intent.recordedOutcome === "unknown",
    )
    .map((intent) => ({
      intentId: intent.intentId,
      description: intent.description,
      recordedOutcome: intent.recordedOutcome,
    }))
    .sort((left, right) =>
      left.intentId < right.intentId ? -1 : left.intentId > right.intentId ? 1 : 0,
    );
}

/** Digest that binds a Claim's identity to the exact evidence shown with it. */
export function evidenceDigest(
  identity: DeliveryClaimIdentity,
  evidence: UnknownOutcomeEvidence,
): string {
  return canonicalJsonDigest({ identity, evidence } as unknown as JsonValue);
}

function assertBoundedEvidence(
  identity: DeliveryClaimIdentity,
  moduleId: string,
  evidence: UnknownOutcomeEvidence,
): void {
  const identifiers = [
    ["moduleJobId", identity.moduleJobId],
    ["claimToken", identity.claimToken],
    ["runId", identity.runId],
    ["moduleGenerationId", identity.moduleGenerationId],
    ["moduleId", moduleId],
  ] as const;
  for (const [name, value] of identifiers) {
    if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
      throw new TypeError(`${name} must be a valid identifier of at most 128 characters`);
    }
  }
  if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1) {
    throw new TypeError("attempt must be a positive safe integer");
  }
  if (
    typeof evidence.preservedReason !== "string" ||
    evidence.preservedReason.length === 0 ||
    new TextEncoder().encode(evidence.preservedReason).byteLength >
      MAX_EVIDENCE_STRING_BYTES
  ) {
    throw new TypeError(
      `preservedReason must contain 1 to ${MAX_EVIDENCE_STRING_BYTES} UTF-8 bytes`,
    );
  }
  if (
    !Array.isArray(evidence.externalEffectIntents) ||
    evidence.externalEffectIntents.length > MAX_EXTERNAL_EFFECT_INTENTS
  ) {
    throw new TypeError(
      `externalEffectIntents must contain at most ${MAX_EXTERNAL_EFFECT_INTENTS} entries`,
    );
  }
  const intentIds = new Set<string>();
  for (const intent of evidence.externalEffectIntents) {
    if (
      typeof intent.intentId !== "string" ||
      !IDENTIFIER_PATTERN.test(intent.intentId)
    ) {
      throw new TypeError(
        "Each external-effect intent ID must be a valid identifier of at most 128 characters",
      );
    }
    if (intentIds.has(intent.intentId)) {
      throw new TypeError("External-effect intent IDs must be unique");
    }
    intentIds.add(intent.intentId);
    if (
      typeof intent.description !== "string" ||
      intent.description.length === 0 ||
      new TextEncoder().encode(intent.description).byteLength >
        MAX_EVIDENCE_STRING_BYTES
    ) {
      throw new TypeError(
        `Each external-effect intent description must contain 1 to ${MAX_EVIDENCE_STRING_BYTES} UTF-8 bytes`,
      );
    }
    if (
      intent.recordedOutcome !== "no-effect" &&
      intent.recordedOutcome !== "retry-safe" &&
      intent.recordedOutcome !== "terminal" &&
      intent.recordedOutcome !== "unknown"
    ) {
      throw new TypeError("An external-effect intent has an invalid recorded outcome");
    }
  }
  if (canonicalJsonByteLength(evidence) > MAX_EVIDENCE_BYTES) {
    throw new TypeError(
      `Unknown-outcome evidence exceeds the ${MAX_EVIDENCE_BYTES}-byte limit`,
    );
  }
}

export function buildPreservedClaim(input: {
  readonly identity: DeliveryClaimIdentity;
  readonly moduleId: string;
  readonly evidence: UnknownOutcomeEvidence;
}): PreservedUnknownOutcomeClaim {
  assertBoundedEvidence(input.identity, input.moduleId, input.evidence);
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
    schemaVersion: "dolly.unknown-outcome-warning/2" as const,
    disposition: "release" as const,
    identity: claim.identity,
    evidenceDigest: claim.evidenceDigest,
    consequence: RELEASE_CONSEQUENCE,
    externalEffectsThatMayRepeat: externalEffectsThatMayRepeat(claim.evidence),
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

function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  const then = (value as { readonly then?: unknown }).then;
  return typeof then === "function";
}

function sameClaimIdentity(
  actual: Pick<
    ClaimDescriptor,
    "moduleJobId" | "claimToken" | "runId" | "attempt" | "moduleGenerationId"
  >,
  expected: DeliveryClaimIdentity,
): boolean {
  return (
    actual.moduleJobId === expected.moduleJobId &&
    actual.claimToken === expected.claimToken &&
    actual.runId === expected.runId &&
    actual.attempt === expected.attempt &&
    actual.moduleGenerationId === expected.moduleGenerationId
  );
}

function submissionMatchesClaim(
  submission: ModuleSubmissionRecord,
  identity: DeliveryClaimIdentity,
): boolean {
  return sameClaimIdentity(submission, identity);
}

function dispositionFailure(
  message: string,
  identity: DeliveryClaimIdentity,
  cause: string,
): ConsoleOperationError {
  return new ConsoleOperationError(
    "ADMIN_OPERATION_FAILED",
    message,
    { cause, claimToken: identity.claimToken },
  );
}

function staleEvidenceError(
  message: string,
  identity: DeliveryClaimIdentity,
  details: Readonly<Record<string, unknown>> = {},
): ConsoleOperationError {
  return new ConsoleOperationError(
    "UNKNOWN_OUTCOME_EVIDENCE_STALE",
    message,
    { claimToken: identity.claimToken, ...details },
  );
}

function dispositionErrorCause(error: unknown): string {
  if (error instanceof ConsoleOperationError) {
    const cause = error.details.cause;
    return typeof cause === "string" ? cause : error.code;
  }
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

function inspectDispositionState(
  operations: DeliveryClaimDispositionOperations,
  identity: DeliveryClaimIdentity,
): ReturnType<DeliveryClaimDispositionOperations["inspectUnknownOutcomeClaim"]> {
  let state: unknown;
  try {
    state = operations.inspectUnknownOutcomeClaim(identity);
    if (isThenable(state)) {
      throw new TypeError("Unknown-outcome Claim inspection must complete synchronously");
    }
  } catch (error) {
    if (
      error instanceof ConsoleOperationError &&
      error.code === "UNKNOWN_OUTCOME_EVIDENCE_STALE"
    ) {
      throw error;
    }
    throw dispositionFailure(
      "The current unknown-outcome Claim state could not be inspected",
      identity,
      dispositionErrorCause(error),
    );
  }
  if (state === null || typeof state !== "object") {
    throw dispositionFailure(
      "The current unknown-outcome Claim state is invalid",
      identity,
      "UNKNOWN",
    );
  }
  const candidate = state as {
    readonly claim?: unknown;
    readonly submissionRecord?: unknown;
    readonly evidenceDigest?: unknown;
  };
  if (
    candidate.claim === null ||
    typeof candidate.claim !== "object" ||
    (
      candidate.submissionRecord !== undefined &&
      (
        candidate.submissionRecord === null ||
        typeof candidate.submissionRecord !== "object"
      )
    ) ||
    (
      candidate.evidenceDigest !== undefined &&
      typeof candidate.evidenceDigest !== "string"
    )
  ) {
    throw dispositionFailure(
      "The current unknown-outcome Claim state is invalid",
      identity,
      "UNKNOWN",
    );
  }
  const claim = candidate.claim as ClaimDescriptor;
  const submission = candidate.submissionRecord as
    | ModuleSubmissionRecord
    | undefined;
  if (
    !sameClaimIdentity(claim, identity) ||
    (submission !== undefined && !submissionMatchesClaim(submission, identity))
  ) {
    throw staleEvidenceError(
      "The unknown-outcome Claim or its submission record does not match the requested identity",
      identity,
    );
  }
  return {
    claim,
    submissionRecord: submission,
    evidenceDigest: candidate.evidenceDigest as string | undefined,
  };
}

function submissionDigest(
  submission: ModuleSubmissionRecord | undefined,
): string | undefined {
  return submission === undefined
    ? undefined
    : canonicalJsonDigest(submission as unknown as JsonValue);
}

/**
 * Applies an operator disposition through the Core-state operation above. A
 * release restores the exact Claim's Deliveries to pending; a dead letter
 * records every remaining Delivery rather than discarding it; leaving it
 * unresolved changes neither the Claim nor its submission record.
 *
 * This adapter requires the single synchronous operation documented by
 * `DeliveryClaimDispositionOperations`. It also confirms the exact Claim and
 * submission-record state afterwards, which detects a no-op or an operation
 * wired to another store. The confirmation does not provide atomicity by
 * itself.
 */
export function deliveryClaimDispositionApplier(
  operations: DeliveryClaimDispositionOperations,
): UnknownOutcomeClaimStore["applyDisposition"] {
  return async (request) => {
    try {
      const before = inspectDispositionState(operations, request.identity);
      if (
        before.claim.status !== "active" ||
        before.evidenceDigest !== request.expectedEvidenceDigest
      ) {
        throw staleEvidenceError(
          "The Claim or evidence changed before the disposition could be applied",
          request.identity,
          {
            expectedEvidenceDigest: request.expectedEvidenceDigest,
            ...(before.evidenceDigest === undefined
              ? {}
              : { currentEvidenceDigest: before.evidenceDigest }),
          },
        );
      }

      const beforeSubmissionDigest = submissionDigest(before.submissionRecord);
      let operationError: unknown;
      let returnedOutcome: unknown;
      let returnedThenable = false;
      try {
        returnedOutcome = operations.applyUnknownOutcomeDisposition(request);
        returnedThenable = isThenable(returnedOutcome);
        if (returnedThenable) {
          operationError = dispositionFailure(
            "A Claim disposition must complete synchronously",
            request.identity,
            "ADMIN_OPERATION_FAILED",
          );
        }
      } catch (error) {
        operationError = error;
      }

      let after:
        | ReturnType<DeliveryClaimDispositionOperations["inspectUnknownOutcomeClaim"]>
        | undefined;
      try {
        after = inspectDispositionState(operations, request.identity);
      } catch (error) {
        operationError ??= error;
      }

      if (request.disposition === "leave-unresolved") {
        if (
          !returnedThenable &&
          operationError === undefined &&
          returnedOutcome === "left-unresolved" &&
          after !== undefined &&
          after.claim.status === "active" &&
          after.evidenceDigest === request.expectedEvidenceDigest &&
          submissionDigest(after.submissionRecord) === beforeSubmissionDigest
        ) {
          return "left-unresolved";
        }
      } else {
        const expectedStatus =
          request.disposition === "release" ? "released" : "dead-lettered";
        const returnedExpectedOutcome =
          request.disposition === "release"
            ? returnedOutcome === "released" || returnedOutcome === "already-released"
            : returnedOutcome === "dead-lettered";
        if (
          !returnedThenable &&
          (operationError !== undefined || returnedExpectedOutcome) &&
          after !== undefined &&
          after.claim.status === expectedStatus &&
          after.submissionRecord === undefined &&
          after.evidenceDigest === undefined
        ) {
          return request.disposition === "release" ? "released" : "dead-lettered";
        }
      }

      if (operationError !== undefined) throw operationError;
      throw dispositionFailure(
        "The Claim disposition did not reach its required state in the inspected store",
        request.identity,
        "ADMIN_OPERATION_FAILED",
      );
    } catch (error) {
      if (
        error instanceof ConsoleOperationError &&
        (error.code === "ADMIN_OPERATION_FAILED" ||
          error.code === "UNKNOWN_OUTCOME_EVIDENCE_STALE")
      ) {
        throw error;
      }
      throw dispositionFailure(
        "The Claim disposition could not be applied",
        request.identity,
        dispositionErrorCause(error),
      );
    }
  };
}
