/**
 * Record protocol for durable evidence about external effects a capability may
 * have caused.
 *
 * Architecture Decision Record 0009 requires every capability that can cause
 * an external effect to persist an intent with a stable idempotency key
 * *before* the input/output, and requires its outcome to be durable or
 * queryable. It states the negative case explicitly: an in-memory duplicate
 * map is not restart evidence.
 *
 * `ExtensionCapabilityAuthority` deduplicates within one live session using an
 * in-memory map, which is correct for a repeated invocation inside that
 * session and useless after Core exits. This journal and its evidence adapter
 * define the record protocol, but the repository does not yet provide the
 * persistent store or integration with the only code path that can authorize
 * an external effect. Until both exist, the journal is not sufficient recovery
 * evidence for a complete Run.
 *
 * The journal deliberately stores no argument values, no response payload, and
 * no credential. It stores identities, a digest of the intended operation, and
 * an outcome. Recovery needs to know *whether* an effect happened, not what it
 * contained.
 */

import { canonicalJsonDigest, deepFreeze } from "../canonical-json.js";
import type {
  ExternalEffectEvidence,
  ExternalEffectEvidenceSource,
} from "../core-startup-recovery.js";
import type { DeliveryClaimIdentity } from "../delivery-store.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_OUTCOME_DETAIL_LENGTH = 4_096;

/**
 * How far an intended effect got. `terminal` means the operation has a durable
 * final result; it does not prove that repeating the operation is safe.
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
  readonly schemaVersion: "dolly.effect-intent/2";
  /** The exact Claim and Run this effect belongs to. */
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly claimToken: string;
  readonly moduleGenerationId: string;
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
  | "EFFECT_INTENT_OUTCOME_INVALID"
  | "EFFECT_INTENT_DOCUMENT_INVALID"
  | "EFFECT_INTENT_IO_FAILED"
  | "EFFECT_INTENT_LIMIT_EXCEEDED"
  | "EFFECT_INTENT_LOCKED";

export class EffectIntentError extends Error {
  constructor(readonly code: EffectIntentErrorCode, message: string) {
    super(message);
    this.name = "EffectIntentError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertClosedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new EffectIntentError(
      "EFFECT_INTENT_INVALID",
      `${label} contains an unknown field`,
    );
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/** Validates one persisted effect-intent record without trusting its source. */
export function assertEffectIntentRecord(
  value: unknown,
): asserts value is EffectIntentRecord {
  if (!isPlainObject(value)) {
    throw new EffectIntentError(
      "EFFECT_INTENT_INVALID",
      "Effect intent record must be an object",
    );
  }
  assertClosedKeys(
    value,
    [
      "schemaVersion",
      "moduleJobId",
      "runId",
      "attempt",
      "claimToken",
      "moduleGenerationId",
      "idempotencyKey",
      "capabilityType",
      "operation",
      "intentDigest",
      "outcome",
      "createdAt",
      "updatedAt",
    ],
    "Effect intent record",
  );
  if (value.schemaVersion !== "dolly.effect-intent/2") {
    throw new EffectIntentError(
      "EFFECT_INTENT_INVALID",
      "Effect intent record schema version is not supported",
    );
  }
  for (const field of [
    "moduleJobId",
    "runId",
    "claimToken",
    "moduleGenerationId",
    "idempotencyKey",
    "capabilityType",
    "operation",
  ] as const) {
    if (!isIdentifier(value[field])) {
      throw new EffectIntentError(
        "EFFECT_INTENT_INVALID",
        `Effect intent field "${field}" must be an identifier`,
      );
    }
  }
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) {
    throw new EffectIntentError(
      "EFFECT_INTENT_INVALID",
      "Effect intent attempt must be a positive integer",
    );
  }
  if (typeof value.intentDigest !== "string" || !DIGEST_PATTERN.test(value.intentDigest)) {
    throw new EffectIntentError(
      "EFFECT_INTENT_INVALID",
      "Effect intent digest must be a sha256 digest",
    );
  }
  if (!isPlainObject(value.outcome) || typeof value.outcome.kind !== "string") {
    throw new EffectIntentError(
      "EFFECT_INTENT_OUTCOME_INVALID",
      "Effect intent outcome must be an object with a known kind",
    );
  }
  switch (value.outcome.kind) {
    case "intended":
      assertClosedKeys(value.outcome, ["kind"], "Intended effect outcome");
      break;
    case "no-effect":
      assertClosedKeys(value.outcome, ["kind", "detail"], "No-effect outcome");
      if (
        typeof value.outcome.detail !== "string" ||
        value.outcome.detail.length === 0 ||
        value.outcome.detail.length > MAX_OUTCOME_DETAIL_LENGTH
      ) {
        throw new EffectIntentError(
          "EFFECT_INTENT_OUTCOME_INVALID",
          "A no-effect outcome needs a bounded stated reason",
        );
      }
      break;
    case "terminal":
      assertClosedKeys(value.outcome, ["kind", "resultDigest"], "Terminal effect outcome");
      if (
        typeof value.outcome.resultDigest !== "string" ||
        !DIGEST_PATTERN.test(value.outcome.resultDigest)
      ) {
        throw new EffectIntentError(
          "EFFECT_INTENT_OUTCOME_INVALID",
          "A terminal effect outcome needs a sha256 result digest",
        );
      }
      break;
    case "unknown":
      assertClosedKeys(value.outcome, ["kind", "reason"], "Unknown effect outcome");
      if (
        typeof value.outcome.reason !== "string" ||
        value.outcome.reason.length === 0 ||
        value.outcome.reason.length > MAX_OUTCOME_DETAIL_LENGTH
      ) {
        throw new EffectIntentError(
          "EFFECT_INTENT_OUTCOME_INVALID",
          "An unknown effect outcome needs a bounded stated reason",
        );
      }
      break;
    default:
      throw new EffectIntentError(
        "EFFECT_INTENT_OUTCOME_INVALID",
        "Unknown effect outcome kind",
      );
  }
  if (
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) {
    throw new EffectIntentError(
      "EFFECT_INTENT_INVALID",
      "Effect intent timestamps must be canonical and ordered",
    );
  }
}

/** Whether two records identify the same authorization of one logical effect. */
export function sameEffectIntentRecordIdentity(
  left: EffectIntentRecord,
  right: EffectIntentRecord,
): boolean {
  return (
    left.moduleJobId === right.moduleJobId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.runId === right.runId &&
    left.attempt === right.attempt &&
    left.claimToken === right.claimToken &&
    left.moduleGenerationId === right.moduleGenerationId
  );
}

/** Enforces immutable identity/intent fields and monotonic outcome settlement. */
export function assertEffectIntentTransition(
  current: EffectIntentRecord,
  next: EffectIntentRecord,
): void {
  assertEffectIntentRecord(current);
  assertEffectIntentRecord(next);
  if (
    !sameEffectIntentRecordIdentity(current, next) ||
    current.capabilityType !== next.capabilityType ||
    current.operation !== next.operation ||
    current.intentDigest !== next.intentDigest ||
    current.createdAt !== next.createdAt ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
  ) {
    throw new EffectIntentError(
      "EFFECT_INTENT_CONFLICT",
      "Effect intent immutable fields or update order changed",
    );
  }
  if (sameOutcome(current.outcome, next.outcome)) return;
  const allowed =
    current.outcome.kind === "intended" ||
    (current.outcome.kind === "unknown" &&
      (next.outcome.kind === "no-effect" || next.outcome.kind === "terminal"));
  if (!allowed) {
    throw new EffectIntentError(
      "EFFECT_INTENT_CONFLICT",
      "Effect intent outcome transition is not permitted",
    );
  }
}

/**
 * Storage boundary for intent records. The repository does not yet provide a
 * persistent product implementation or connect this boundary to capability
 * execution. Tests supply an in-memory store; it cannot prove that evidence
 * survived a Core process crash.
 */
export interface EffectIntentStore {
  list(): readonly EffectIntentRecord[];
  /**
   * Inserts the replacement's complete Claim/Run identity when `expected` is
   * absent, or replaces only that exact current record when `expected` is
   * supplied. More than one Run may carry the same stable idempotency key for
   * the same Module job. `false` means another write won.
   */
  compareAndSet(
    expected: EffectIntentRecord | undefined,
    replacement: EffectIntentRecord,
  ): boolean;
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

function recordMatchesClaim(
  record: EffectIntentRecord,
  identity: DeliveryClaimIdentity,
): boolean {
  return (
    record.moduleJobId === identity.moduleJobId &&
    record.claimToken === identity.claimToken &&
    record.runId === identity.runId &&
    record.attempt === identity.attempt &&
    record.moduleGenerationId === identity.moduleGenerationId
  );
}

function sameOutcome(left: EffectOutcome, right: EffectOutcome): boolean {
  return canonicalJsonDigest(left) === canonicalJsonDigest(right);
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
 * Records intents before input/output and answers what recovery may conclude.
 *
 * Until a persistent product store is connected to the only code path that can
 * authorize an external effect, an absent record proves nothing and answers
 * `unknown`.
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
    readonly moduleGenerationId: string;
    readonly idempotencyKey: string;
    readonly capabilityType: string;
    readonly operation: string;
    readonly intent: unknown;
  }): EffectIntentRecord {
    for (const [field, value] of Object.entries({
      moduleJobId: request.moduleJobId,
      runId: request.runId,
      claimToken: request.claimToken,
      moduleGenerationId: request.moduleGenerationId,
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

    const recordsForKey = this.#store
      .list()
      .filter(
        (record) =>
          record.moduleJobId === request.moduleJobId &&
          record.idempotencyKey === request.idempotencyKey,
      );
    if (recordsForKey.some((record) => record.intentDigest !== intentDigest)) {
      // The same key with a different intent would make the key meaningless as
      // duplicate suppression, so it is refused rather than overwritten.
      throw new EffectIntentError(
        "EFFECT_INTENT_CONFLICT",
        `Idempotency key "${request.idempotencyKey}" already names a different effect`,
      );
    }
    const existing = recordsForKey.find(
      (record) =>
        record.runId === request.runId &&
        record.attempt === request.attempt &&
        record.claimToken === request.claimToken &&
        record.moduleGenerationId === request.moduleGenerationId,
    );
    if (existing) {
      return existing;
    }
    const now = this.#now();
    const record: EffectIntentRecord = deepFreeze({
      schemaVersion: "dolly.effect-intent/2" as const,
      moduleJobId: request.moduleJobId,
      runId: request.runId,
      attempt: request.attempt,
      claimToken: request.claimToken,
      moduleGenerationId: request.moduleGenerationId,
      idempotencyKey: request.idempotencyKey,
      capabilityType: request.capabilityType,
      operation: request.operation,
      intentDigest,
      outcome: { kind: "intended" as const },
      createdAt: now,
      updatedAt: now,
    });
    assertEffectIntentRecord(record);
    if (!this.#store.compareAndSet(undefined, record)) {
      throw new EffectIntentError(
        "EFFECT_INTENT_CONFLICT",
        `Effect intent "${request.idempotencyKey}" changed while it was being recorded`,
      );
    }
    return record;
  }

  /** Settles an intent once its outcome is known. */
  recordOutcome(
    identity: DeliveryClaimIdentity,
    idempotencyKey: string,
    outcome: EffectOutcome,
  ): EffectIntentRecord {
    assertOutcome(outcome);
    const existing = this.#find(identity, idempotencyKey);
    if (!existing) {
      throw new EffectIntentError(
        "EFFECT_INTENT_NOT_FOUND",
        `No effect intent named "${idempotencyKey}" matches Run "${identity.runId}" and its exact Claim`,
      );
    }
    if (sameOutcome(existing.outcome, outcome)) return existing;
    if (
      existing.outcome.kind === "no-effect" ||
      existing.outcome.kind === "terminal" ||
      existing.outcome.kind === "unknown"
    ) {
      if (
        existing.outcome.kind !== "unknown" ||
        (outcome.kind !== "no-effect" && outcome.kind !== "terminal")
      ) {
        throw new EffectIntentError(
          "EFFECT_INTENT_CONFLICT",
          `Effect intent "${idempotencyKey}" already has an outcome that cannot be rewritten`,
        );
      }
    }
    const updated = deepFreeze({ ...existing, outcome, updatedAt: this.#now() });
    assertEffectIntentTransition(existing, updated);
    if (!this.#store.compareAndSet(existing, updated)) {
      throw new EffectIntentError(
        "EFFECT_INTENT_CONFLICT",
        `Effect intent "${idempotencyKey}" changed while its outcome was being recorded`,
      );
    }
    return updated;
  }

  /** Every intent recorded for one exact Claim and Run. */
  listForRun(identity: DeliveryClaimIdentity): readonly EffectIntentRecord[] {
    return this.#store
      .list()
      .filter((record) => recordMatchesClaim(record, identity));
  }

  /**
   * What recovery may conclude about one Run's external effects.
   *
   * No records answers `unknown`: this adapter is not yet connected to the only
   * code path that can authorize an external effect and cannot prove that the
   * journal is complete. Exact records that are all `no-effect` prove only that
   * those recorded operations did not occur; another effect could be missing,
   * so the whole Run remains unknown. A `terminal` record proves at least one
   * final result exists; without a separate durable idempotency contract it
   * does not permit retry or release. An intent still marked `intended` is the
   * crash case: Core recorded the intent but never recorded an outcome.
   */
  evidenceForRun(identity: DeliveryClaimIdentity): ExternalEffectEvidence {
    const records = this.listForRun(identity);
    if (records.length === 0) {
      return {
        kind: "unknown",
        reason:
          "No exact effect intent is recorded, and this journal is not yet connected to the only code path that can authorize an external effect",
      };
    }

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
    if (records.every((record) => record.outcome.kind === "no-effect")) {
      return {
        kind: "unknown",
        reason:
          "Recorded effects are no-effect, but this journal is not yet connected to the only code path that can authorize an external effect",
      };
    }
    return { kind: "terminal" };
  }

  #find(
    identity: DeliveryClaimIdentity,
    idempotencyKey: string,
  ): EffectIntentRecord | undefined {
    return this.#store
      .list()
      .find(
        (record) =>
          recordMatchesClaim(record, identity) &&
          record.idempotencyKey === idempotencyKey,
      );
  }
}

/**
 * Adapts the journal to the evidence source startup recovery consumes.
 *
 * Recovery asks about one submission record; the journal requires all five
 * fields of its exact Claim identity. A record for another claim token,
 * attempt, or Module generation cannot make this Run look safe.
 */
export function effectIntentEvidenceSource(
  journal: EffectIntentJournal,
): ExternalEffectEvidenceSource {
  return {
    async inspectRunEffects(submission) {
      return journal.evidenceForRun(submission);
    },
  };
}
