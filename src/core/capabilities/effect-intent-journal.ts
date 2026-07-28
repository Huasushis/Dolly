/**
 * Durable evidence about external effects a capability may have caused.
 *
 * Architecture Decision Record 0009 requires every capability that can cause
 * an external effect to persist an intent with a stable idempotency key
 * *before* the input/output, and requires its outcome to be durable or
 * queryable. It states the negative case explicitly: an in-memory duplicate
 * map is not restart evidence.
 *
 * `ExtensionCapabilityAuthority` deduplicates within one live session using an
 * in-memory map, which is correct for a repeated invocation inside that
 * session and useless after Core exits. This journal is the durable half. It
 * answers one question for startup recovery: for this exact Claim and Run, did
 * any effect cross its boundary, and is its outcome known?
 *
 * The journal deliberately stores no argument values, no response payload, and
 * no credential. It stores identities, a digest of the intended operation, and
 * an outcome. Recovery needs to know *whether* an effect happened, not what it
 * contained, and everything it stores survives into an operator-visible
 * unknown outcome.
 */

import { canonicalJsonDigest, deepFreeze } from "../canonical-json.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_IDENTIFIER_LENGTH = 256;

/**
 * How far an intended effect got. The three terminal values are the same
 * vocabulary startup recovery uses to decide a Claim, so a journal entry maps
 * onto that decision without translation.
 */
export type EffectOutcome =
  /** Persisted before the operation started; nothing is known yet. */
  | { readonly kind: "intended" }
  /** The operation provably never crossed its effect boundary. */
  | { readonly kind: "no-effect"; readonly detail: string }
  /** The operation completed and its result is durably recorded. */
  | { readonly kind: "terminal"; readonly resultDigest: string }
  /**
   * The operation may have taken effect and the provider offers a query that
   * can still settle it. This is not a safe-to-retry state by itself.
   */
  | { readonly kind: "unknown"; readonly reason: string };

export interface EffectIntentRecord {
  readonly schemaVersion: "dolly.effect-intent/1";
  /** The exact Claim and Run this effect belongs to. */
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly claimToken: string;
  /**
   * The stable key that makes repeating this operation safe. Architecture
   * Decision Record 0009 requires it to derive from the Module job identifier
   * and a stable operation identifier, never from the Run identifier alone,
   * because a retry changes the Run.
   */
  readonly idempotencyKey: string;
  /** Which capability the effect would pass through. */
  readonly capabilityType: string;
  readonly operation: string;
  /** Digest of the intended operation; the arguments themselves are not kept. */
  readonly intentDigest: string;
  readonly outcome: EffectOutcome;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type EffectIntentErrorCode =
  | "EFFECT_INTENT_INVALID"
  | "EFFECT_INTENT_CONFLICT"
  | "EFFECT_INTENT_NOT_FOUND"
  | "EFFECT_INTENT_OUTCOME_INVALID";

export class EffectIntentError extends Error {
  constructor(readonly code: EffectIntentErrorCode, message: string) {
    super(message);
    this.name = "EffectIntentError";
  }
}

/**
 * Durable storage for intent records. A file-backed implementation writes
 * through the same atomic replacement Core state uses; tests supply an
 * in-memory one that can simulate a restart by being reconstructed.
 */
export interface EffectIntentStore {
  list(): readonly EffectIntentRecord[];
  put(record: EffectIntentRecord): void;
}

function isIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint < 0x20 || codePoint === 0x7f) return false;
  }
  return true;
}

function assertOutcome(outcome: EffectOutcome): void {
  switch (outcome.kind) {
    case "intended":
      return;
    case "no-effect":
    case "unknown": {
      const detail = outcome.kind === "no-effect" ? outcome.detail : outcome.reason;
      if (typeof detail !== "string" || detail.length === 0) {
        throw new EffectIntentError(
          "EFFECT_INTENT_OUTCOME_INVALID",
          `An effect outcome of kind ${outcome.kind} needs a stated reason`,
        );
      }
      return;
    }
    case "terminal":
      if (!DIGEST_PATTERN.test(outcome.resultDigest)) {
        throw new EffectIntentError(
          "EFFECT_INTENT_OUTCOME_INVALID",
          "A terminal effect outcome needs a sha256 result digest",
        );
      }
      return;
    default:
      throw new EffectIntentError(
        "EFFECT_INTENT_OUTCOME_INVALID",
        "Unknown effect outcome kind",
      );
  }
}

/**
 * The disposition an effect journal permits for one Run, using the vocabulary
 * `CoreStartupRecovery` already understands.
 */
export type RunEffectEvidence =
  | { readonly kind: "no-effect" | "retry-safe" | "terminal" }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Records intents before input/output and answers what recovery may conclude.
 *
 * The safety rule is one-sided on purpose: an absent record means no effect
 * was ever authorized *only* because the intent is written before the
 * operation starts. Every other combination that is not provably safe answers
 * `unknown`, which preserves the Claim for audited operator action.
 */
export class EffectIntentJournal {
  readonly #store: EffectIntentStore;
  readonly #now: () => string;

  constructor(options: { readonly store: EffectIntentStore; readonly now: () => string }) {
    this.#store = options.store;
    this.#now = options.now;
  }

  /**
   * Persists the intent to perform one external effect. This must complete
   * before the operation begins; a caller that starts the operation first has
   * defeated the whole mechanism.
   */
  recordIntent(request: {
    readonly moduleJobId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly claimToken: string;
    readonly idempotencyKey: string;
    readonly capabilityType: string;
    readonly operation: string;
    readonly intent: unknown;
  }): EffectIntentRecord {
    for (const [field, value] of Object.entries({
      moduleJobId: request.moduleJobId,
      runId: request.runId,
      claimToken: request.claimToken,
      idempotencyKey: request.idempotencyKey,
      capabilityType: request.capabilityType,
      operation: request.operation,
    })) {
      if (!isIdentifier(value)) {
        throw new EffectIntentError(
          "EFFECT_INTENT_INVALID",
          `Effect intent field "${field}" must be an identifier`,
        );
      }
    }
    if (!Number.isSafeInteger(request.attempt) || request.attempt < 1) {
      throw new EffectIntentError(
        "EFFECT_INTENT_INVALID",
        "Effect intent attempt must be a positive integer",
      );
    }

    const intentDigest = canonicalJsonDigest({
      capabilityType: request.capabilityType,
      operation: request.operation,
      idempotencyKey: request.idempotencyKey,
      intent: request.intent as never,
    });

    const existing = this.#find(request.moduleJobId, request.idempotencyKey);
    if (existing) {
      // The same key with a different intent would make the key meaningless as
      // duplicate suppression, so it is refused rather than overwritten.
      if (existing.intentDigest !== intentDigest) {
        throw new EffectIntentError(
          "EFFECT_INTENT_CONFLICT",
          `Idempotency key "${request.idempotencyKey}" already names a different effect`,
        );
      }
      return existing;
    }

    const now = this.#now();
    const record: EffectIntentRecord = deepFreeze({
      schemaVersion: "dolly.effect-intent/1" as const,
      moduleJobId: request.moduleJobId,
      runId: request.runId,
      attempt: request.attempt,
      claimToken: request.claimToken,
      idempotencyKey: request.idempotencyKey,
      capabilityType: request.capabilityType,
      operation: request.operation,
      intentDigest,
      outcome: { kind: "intended" as const },
      createdAt: now,
      updatedAt: now,
    });
    this.#store.put(record);
    return record;
  }

  /** Settles an intent once its outcome is known. */
  recordOutcome(
    moduleJobId: string,
    idempotencyKey: string,
    outcome: EffectOutcome,
  ): EffectIntentRecord {
    assertOutcome(outcome);
    const existing = this.#find(moduleJobId, idempotencyKey);
    if (!existing) {
      throw new EffectIntentError(
        "EFFECT_INTENT_NOT_FOUND",
        `No effect intent named "${idempotencyKey}" for Module job "${moduleJobId}"`,
      );
    }
    const updated = deepFreeze({ ...existing, outcome, updatedAt: this.#now() });
    this.#store.put(updated);
    return updated;
  }

  /** Every intent recorded for one Run, in the order the store returns them. */
  listForRun(moduleJobId: string, runId: string): readonly EffectIntentRecord[] {
    return this.#store
      .list()
      .filter((record) => record.moduleJobId === moduleJobId && record.runId === runId);
  }

  /**
   * What recovery may conclude about one Run's external effects.
   *
   * No records means no effect was ever authorized, because the intent is
   * written before the operation. Records that are all `no-effect` or
   * `terminal` are safe. An intent still marked `intended` is the crash case:
   * Core died between writing the intent and learning the result, so the
   * outcome is unknown and the Claim must be preserved.
   */
  evidenceForRun(moduleJobId: string, runId: string): RunEffectEvidence {
    const records = this.listForRun(moduleJobId, runId);
    if (records.length === 0) return { kind: "no-effect" };

    const unresolved = records.filter(
      (record) => record.outcome.kind === "intended" || record.outcome.kind === "unknown",
    );
    if (unresolved.length > 0) {
      const first = unresolved[0]!;
      const reason =
        first.outcome.kind === "unknown"
          ? first.outcome.reason
          : "Core recorded the intent but never recorded an outcome";
      return {
        kind: "unknown",
        reason: `${unresolved.length} effect intent${
          unresolved.length === 1 ? "" : "s"
        } unresolved for this Run (${first.capabilityType}/${first.operation}: ${reason})`,
      };
    }
    return records.every((record) => record.outcome.kind === "no-effect")
      ? { kind: "no-effect" }
      : { kind: "terminal" };
  }

  #find(moduleJobId: string, idempotencyKey: string): EffectIntentRecord | undefined {
    return this.#store
      .list()
      .find(
        (record) =>
          record.moduleJobId === moduleJobId && record.idempotencyKey === idempotencyKey,
      );
  }
}

/**
 * Adapts the journal to the evidence source startup recovery consumes.
 *
 * Recovery asks about one submission record; the journal answers about the
 * exact Module job and Run that record names. Nothing else about the
 * submission is consulted, so a record for a different Run cannot make this
 * one look safe.
 */
export function effectIntentEvidenceSource(journal: EffectIntentJournal): {
  inspectRunEffects(submission: {
    readonly moduleJobId: string;
    readonly runId: string;
  }): Promise<RunEffectEvidence>;
} {
  return {
    async inspectRunEffects(submission) {
      return journal.evidenceForRun(submission.moduleJobId, submission.runId);
    },
  };
}
