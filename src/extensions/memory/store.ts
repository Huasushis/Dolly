import { deepFreeze } from "../../core/canonical-json.js";
import type { IndexGeneration } from "./index-generation.js";
import { memoryError } from "./errors.js";
import {
  assertNamespaceAuthorized,
  assertSameNamespace,
  type MemoryAuthorization,
  type MemoryNamespace,
  type MemoryOperation,
} from "./namespace.js";
import type { FeatureKind, FeatureRecord, MemoryRecord, OccurrenceRecord } from "./records.js";

/**
 * Durable state for the Memory baseline (`docs/spec/memory-extension.md` §12.1).
 *
 * The store is a reducer over an append-only journal. Every mutation appends
 * one atomic event group and only then applies it, so a write that never
 * reached the journal is also never visible in memory. Replaying the journal is
 * the whole of recovery: §16.2 requires recovery to reach the same committed
 * state as uninterrupted execution, and there is exactly one code path
 * (`applyEvent`) that can produce state, used identically by both.
 *
 * `InMemoryMemoryJournal` is the in-memory profile §12.1 permits for tests. It
 * advertises that a lost journal object loses Memory; it is not a durability
 * claim.
 */

export type FeatureJobState =
  | "pending"
  | "running"
  | "retryable"
  | "succeeded"
  | "skipped"
  | "permanent-failure"
  | "cancelled";

export const TERMINAL_JOB_STATES: readonly FeatureJobState[] = deepFreeze([
  "succeeded",
  "skipped",
  "permanent-failure",
  "cancelled",
]);

export type AdmissionState = "prepared" | "committed" | "discarded";

export interface PlannedFeature {
  readonly kind: FeatureKind;
  readonly modality: string;
}

export interface FeatureJobRecord {
  readonly featureJobId: string;
  readonly namespaceKey: string;
  readonly sourceBlockId: string;
  /** Provenance the worker needs to build records without re-reading Delivery. */
  readonly coreSequence: number;
  readonly sourcePageId: string;
  readonly originatingSessionId: string;
  readonly payloadSchema: string;
  readonly creationModuleJobId: string;
  readonly featurePlanDigest: string;
  readonly deletionEpoch: number;
  /** Finite planned feature set (§5.5). */
  readonly plannedFeatures: readonly PlannedFeature[];
  readonly requiredByAdmissionIds: readonly string[];
  readonly state: FeatureJobState;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly lastErrorCode?: string;
  /** Present only while `state === "running"`. */
  readonly claim?: {
    readonly leaseId: string;
    readonly moduleGeneration: number;
    readonly attempt: number;
  };
}

export interface AdmissionRecord {
  readonly admissionId: string;
  readonly namespaceKey: string;
  readonly moduleJobId: string;
  readonly moduleGeneration: number;
  readonly expectedResultDigest: string;
  readonly deliveryIds: readonly string[];
  readonly featureJobIds: readonly string[];
  /** One distinct Module retention key per source target (§5.5, §11.2). */
  readonly retentionTargets: readonly {
    readonly retentionKey: string;
    readonly targetBlockId: string;
  }[];
  /** The source lineages this admission indexes, for the tombstone recheck. */
  readonly sourceLineageKeys: readonly string[];
  readonly featurePlanDigest: string;
  readonly deletionEpoch: number;
  readonly state: AdmissionState;
}

export type DeliveryOutcome = "pending" | "retryable" | "success" | "skip" | "permanent-failure";

export interface CoverageState {
  readonly pageId: string;
  /** Highest contiguous sequence whose Deliveries all reached a terminal outcome. */
  readonly processedThrough: number;
  /** Highest contiguous sequence whose required features all succeeded or were skipped. */
  readonly completeThrough: number;
  readonly pendingSequences: readonly number[];
  readonly retryableSequences: readonly number[];
  readonly permanentFailureSequences: readonly number[];
  readonly truncatedGapReport: boolean;
  readonly revision: number;
}

export interface TombstoneRecord {
  readonly lineageKey: string;
  readonly deletionEpoch: number;
  readonly tombstoneRevision: number;
}

export type MemoryEvent =
  | { readonly type: "generation-activated"; readonly generation: IndexGeneration }
  | { readonly type: "admission-prepared"; readonly admission: AdmissionRecord }
  | {
      readonly type: "admission-settled";
      readonly namespaceKey: string;
      readonly admissionId: string;
      readonly state: "committed" | "discarded";
      readonly observedResultDigest?: string;
    }
  | { readonly type: "occurrence-recorded"; readonly occurrence: OccurrenceRecord }
  | { readonly type: "record-committed"; readonly record: MemoryRecord }
  | { readonly type: "feature-job-created"; readonly job: FeatureJobRecord }
  | {
      readonly type: "feature-job-attached";
      readonly namespaceKey: string;
      readonly featureJobId: string;
      readonly admissionId: string;
    }
  | {
      readonly type: "feature-job-claimed";
      readonly namespaceKey: string;
      readonly featureJobId: string;
      readonly leaseId: string;
      readonly moduleGeneration: number;
      readonly attempt: number;
    }
  | {
      readonly type: "feature-job-settled";
      readonly namespaceKey: string;
      readonly featureJobId: string;
      readonly state: FeatureJobState;
      readonly errorCode?: string;
    }
  | { readonly type: "feature-committed"; readonly feature: FeatureRecord }
  | {
      readonly type: "delivery-outcome";
      readonly namespaceKey: string;
      readonly pageId: string;
      readonly pageSequence: number;
      readonly outcome: DeliveryOutcome;
    }
  | {
      readonly type: "retention-key-removed";
      readonly namespaceKey: string;
      readonly admissionId: string;
      readonly retentionKey: string;
    }
  | {
      readonly type: "tombstone-created";
      readonly namespaceKey: string;
      readonly lineageKey: string;
      readonly deletionEpoch: number;
    };

export interface MemoryJournal {
  append(events: readonly MemoryEvent[]): void;
  read(): readonly MemoryEvent[];
}

/** The namespace every event belongs to. No event is namespace-free. */
export function eventNamespaceKey(event: MemoryEvent): string {
  switch (event.type) {
    case "generation-activated":
      return event.generation.namespaceKey;
    case "admission-prepared":
      return event.admission.namespaceKey;
    case "occurrence-recorded":
      return event.occurrence.namespaceKey;
    case "record-committed":
      return event.record.namespaceKey;
    case "feature-job-created":
      return event.job.namespaceKey;
    case "feature-committed":
      return event.feature.namespaceKey;
    default:
      return event.namespaceKey;
  }
}

export class InMemoryMemoryJournal implements MemoryJournal {
  /**
   * Restart loses Memory when this object is discarded. §12.1 permits the
   * profile for tests and requires it to advertise exactly that.
   */
  readonly durability = "process-lifetime-only" as const;
  readonly #events: MemoryEvent[] = [];

  append(events: readonly MemoryEvent[]): void {
    this.#events.push(...events);
  }

  read(): readonly MemoryEvent[] {
    return [...this.#events];
  }

  get length(): number {
    return this.#events.length;
  }
}

interface NamespaceState {
  readonly namespaceKey: string;
  readonly generations: Map<string, IndexGeneration>;
  readonly admissions: Map<string, AdmissionRecord>;
  readonly occurrences: Map<string, OccurrenceRecord>;
  readonly records: Map<string, MemoryRecord>;
  readonly features: Map<string, FeatureRecord>;
  readonly jobs: Map<string, FeatureJobRecord>;
  readonly deliveryOutcomes: Map<string, Map<number, DeliveryOutcome>>;
  readonly tombstones: Map<string, TombstoneRecord>;
  corpusRevision: number;
  tombstoneRevision: number;
}

export interface MemoryStoreLimits {
  readonly maxPreparedAdmissions: number;
  readonly maxPendingJobs: number;
  readonly maxRecordsPerNamespace: number;
  readonly maxFeaturesPerNamespace: number;
  readonly maxTrackedGapsPerPage: number;
  readonly maxJobAttempts: number;
}

export const DEFAULT_MEMORY_STORE_LIMITS: MemoryStoreLimits = deepFreeze({
  maxPreparedAdmissions: 64,
  maxPendingJobs: 256,
  maxRecordsPerNamespace: 10_000,
  maxFeaturesPerNamespace: 40_000,
  maxTrackedGapsPerPage: 32,
  maxJobAttempts: 3,
});

function emptyNamespaceState(namespaceKey: string): NamespaceState {
  return {
    namespaceKey,
    generations: new Map(),
    admissions: new Map(),
    occurrences: new Map(),
    records: new Map(),
    features: new Map(),
    jobs: new Map(),
    deliveryOutcomes: new Map(),
    tombstones: new Map(),
    corpusRevision: 0,
    tombstoneRevision: 0,
  };
}

function computeCoverage(
  pageId: string,
  outcomes: ReadonlyMap<number, DeliveryOutcome>,
  revision: number,
  maxTrackedGaps: number,
): CoverageState {
  const sequences = [...outcomes.keys()].sort((left, right) => left - right);
  let processedThrough = 0;
  let completeThrough = 0;
  let expected = 1;
  let processedStopped = false;
  let completeStopped = false;
  for (const sequence of sequences) {
    if (sequence !== expected) break;
    expected += 1;
    const outcome = outcomes.get(sequence)!;
    const terminal =
      outcome === "success" || outcome === "skip" || outcome === "permanent-failure";
    // A permanent unexpected failure may advance processedThrough but MUST NOT
    // advance completeThrough (§5.4).
    if (!processedStopped && terminal) processedThrough = sequence;
    else processedStopped = true;
    if (!completeStopped && (outcome === "success" || outcome === "skip")) {
      completeThrough = sequence;
    } else {
      completeStopped = true;
    }
  }
  const collect = (wanted: DeliveryOutcome): readonly number[] =>
    sequences.filter((sequence) => outcomes.get(sequence) === wanted);
  const pending = collect("pending");
  const retryable = collect("retryable");
  const permanent = collect("permanent-failure");
  const truncated =
    pending.length > maxTrackedGaps ||
    retryable.length > maxTrackedGaps ||
    permanent.length > maxTrackedGaps;
  return deepFreeze({
    pageId,
    processedThrough,
    completeThrough,
    pendingSequences: pending.slice(0, maxTrackedGaps),
    retryableSequences: retryable.slice(0, maxTrackedGaps),
    permanentFailureSequences: permanent.slice(0, maxTrackedGaps),
    truncatedGapReport: truncated,
    revision,
  });
}

export class MemoryStore {
  readonly #journal: MemoryJournal;
  readonly #limits: MemoryStoreLimits;
  readonly #namespaces = new Map<string, NamespaceState>();

  private constructor(journal: MemoryJournal, limits: MemoryStoreLimits) {
    this.#journal = journal;
    this.#limits = limits;
  }

  /** Opens the store and replays the journal. This is the whole of recovery. */
  static open(
    journal: MemoryJournal,
    limits: MemoryStoreLimits = DEFAULT_MEMORY_STORE_LIMITS,
  ): MemoryStore {
    const store = new MemoryStore(journal, limits);
    for (const event of journal.read()) {
      try {
        store.#apply(event);
      } catch (error) {
        throw memoryError(
          "MEMORY_STORE_CORRUPT",
          "Memory journal could not be replayed",
          { reason: error instanceof Error ? error.name : "unknown" },
        );
      }
    }
    // §12.4 step 3: a `running` job whose process died is not running. It is
    // reset to a retryable state using its durable attempt count as idempotency
    // evidence, rather than being left claimed forever.
    for (const state of store.#namespaces.values()) {
      for (const [jobId, job] of state.jobs) {
        if (job.state !== "running") continue;
        state.jobs.set(jobId, {
          ...job,
          state: job.attempt >= job.maxAttempts ? "permanent-failure" : "retryable",
          lastErrorCode: "MEMORY_JOB_OUTCOME_UNKNOWN",
          claim: undefined,
        });
      }
    }
    return store;
  }

  get limits(): MemoryStoreLimits {
    return this.#limits;
  }

  /**
   * Opens a namespace-scoped view. Every read and write in this file goes
   * through a session, and a session exists only for a runtime-authenticated
   * namespace the authorization grants. There is no unscoped accessor, so no
   * caller can enumerate another owner's, session's, Page's, or Module's data.
   */
  session(
    namespace: MemoryNamespace,
    authorization: MemoryAuthorization,
    operation: MemoryOperation,
  ): MemoryStoreSession {
    assertNamespaceAuthorized(authorization, namespace, operation);
    return new MemoryStoreSession(this, namespace, authorization);
  }

  /** @internal */
  stateFor(namespaceKey: string): NamespaceState {
    let state = this.#namespaces.get(namespaceKey);
    if (!state) {
      state = emptyNamespaceState(namespaceKey);
      this.#namespaces.set(namespaceKey, state);
    }
    return state;
  }

  /** @internal Appends one atomic group, then applies it. */
  commit(events: readonly MemoryEvent[]): void {
    if (events.length === 0) return;
    this.#journal.append(events);
    for (const event of events) this.#apply(event);
  }

  #apply(event: MemoryEvent): void {
    const state = this.stateFor(eventNamespaceKey(event));
    switch (event.type) {
      case "generation-activated":
        state.generations.set(event.generation.generationId, event.generation);
        return;
      case "admission-prepared":
        state.admissions.set(event.admission.admissionId, event.admission);
        return;
      case "admission-settled": {
        const admission = state.admissions.get(event.admissionId);
        if (!admission) {
          throw memoryError("MEMORY_STORE_CORRUPT", "Admission settlement has no admission");
        }
        state.admissions.set(event.admissionId, { ...admission, state: event.state });
        return;
      }
      case "occurrence-recorded":
        state.occurrences.set(event.occurrence.deliveryId, event.occurrence);
        return;
      case "record-committed":
        if (!state.records.has(event.record.recordId)) {
          state.records.set(event.record.recordId, event.record);
          state.corpusRevision += 1;
        }
        return;
      case "feature-job-created":
        if (!state.jobs.has(event.job.featureJobId)) {
          state.jobs.set(event.job.featureJobId, event.job);
        }
        return;
      case "feature-job-attached": {
        const job = state.jobs.get(event.featureJobId);
        if (!job) throw memoryError("MEMORY_STORE_CORRUPT", "Attachment has no job");
        if (job.requiredByAdmissionIds.includes(event.admissionId)) return;
        state.jobs.set(event.featureJobId, {
          ...job,
          requiredByAdmissionIds: [...job.requiredByAdmissionIds, event.admissionId],
        });
        return;
      }
      case "feature-job-claimed": {
        const job = state.jobs.get(event.featureJobId);
        if (!job) throw memoryError("MEMORY_STORE_CORRUPT", "Claim has no job");
        state.jobs.set(event.featureJobId, {
          ...job,
          state: "running",
          attempt: event.attempt,
          claim: {
            leaseId: event.leaseId,
            moduleGeneration: event.moduleGeneration,
            attempt: event.attempt,
          },
        });
        return;
      }
      case "feature-job-settled": {
        const job = state.jobs.get(event.featureJobId);
        if (!job) throw memoryError("MEMORY_STORE_CORRUPT", "Settlement has no job");
        state.jobs.set(event.featureJobId, {
          ...job,
          state: event.state,
          ...(event.errorCode === undefined ? {} : { lastErrorCode: event.errorCode }),
          claim: undefined,
        });
        return;
      }
      case "feature-committed":
        if (!state.features.has(event.feature.featureId)) {
          state.features.set(event.feature.featureId, event.feature);
          state.corpusRevision += 1;
        }
        return;
      case "delivery-outcome": {
        let page = state.deliveryOutcomes.get(event.pageId);
        if (!page) {
          page = new Map();
          state.deliveryOutcomes.set(event.pageId, page);
        }
        page.set(event.pageSequence, event.outcome);
        return;
      }
      case "retention-key-removed": {
        const admission = state.admissions.get(event.admissionId);
        if (!admission) return;
        state.admissions.set(event.admissionId, {
          ...admission,
          retentionTargets: admission.retentionTargets.filter(
            (target) => target.retentionKey !== event.retentionKey,
          ),
        });
        return;
      }
      case "tombstone-created": {
        state.tombstoneRevision += 1;
        state.tombstones.set(event.lineageKey, {
          lineageKey: event.lineageKey,
          deletionEpoch: event.deletionEpoch,
          tombstoneRevision: state.tombstoneRevision,
        });
        return;
      }
    }
  }
}

/**
 * One namespace's view of the store. Every method re-checks authorization
 * (§4.3: the check is per operation, not only at namespace creation) and every
 * returned object is verified to belong to this namespace before it is handed
 * back.
 */
export class MemoryStoreSession {
  readonly #store: MemoryStore;
  readonly #namespace: MemoryNamespace;
  readonly #authorization: MemoryAuthorization;

  constructor(
    store: MemoryStore,
    namespace: MemoryNamespace,
    authorization: MemoryAuthorization,
  ) {
    this.#store = store;
    this.#namespace = namespace;
    this.#authorization = authorization;
  }

  get namespace(): MemoryNamespace {
    return this.#namespace;
  }

  #state(): NamespaceState {
    return this.#store.stateFor(this.#namespace.namespaceKey);
  }

  #authorize(operation: MemoryOperation): void {
    assertNamespaceAuthorized(this.#authorization, this.#namespace, operation);
  }

  #commit(events: readonly MemoryEvent[]): void {
    for (const event of events) {
      assertSameNamespace(
        this.#namespace,
        eventNamespaceKey(event),
        `journal event ${event.type}`,
      );
    }
    this.#store.commit(events);
  }

  activateGeneration(generation: IndexGeneration): void {
    this.#authorize("index");
    assertSameNamespace(this.#namespace, generation.namespaceKey, "index generation");
    this.#commit([{ type: "generation-activated", generation }]);
  }

  generation(generationId: string): IndexGeneration | undefined {
    this.#authorize("query");
    return this.#state().generations.get(generationId);
  }

  activeGenerations(): readonly IndexGeneration[] {
    this.#authorize("query");
    return [...this.#state().generations.values()];
  }

  prepareAdmission(admission: AdmissionRecord): void {
    this.#authorize("index");
    assertSameNamespace(this.#namespace, admission.namespaceKey, "admission");
    const state = this.#state();
    const existing = state.admissions.get(admission.admissionId);
    if (existing) {
      // Creating the same admission twice is idempotent (§5.5).
      if (existing.state !== "prepared") {
        throw memoryError(
          "MEMORY_JOB_STATE_INVALID",
          "An admission is immutable after it reaches a terminal state",
          { admissionId: admission.admissionId, state: existing.state },
        );
      }
      return;
    }
    const prepared = [...state.admissions.values()].filter(
      (candidate) => candidate.state === "prepared",
    ).length;
    if (prepared >= this.#store.limits.maxPreparedAdmissions) {
      throw memoryError("MEMORY_LIMIT_EXCEEDED", "Prepared admission capacity is exhausted", {
        limit: "maxPreparedAdmissions",
        allowed: this.#store.limits.maxPreparedAdmissions,
      });
    }
    this.#commit([{ type: "admission-prepared", admission }]);
  }

  admission(admissionId: string): AdmissionRecord | undefined {
    this.#authorize("query");
    return this.#state().admissions.get(admissionId);
  }

  /**
   * Settles a prepared admission after the extension observed the Core's
   * `module-job-outcome` (§5.5). A `prepared` admission is never runnable and
   * never visible to retrieval, so this is the only way indexing work starts.
   */
  settleAdmission(options: {
    readonly admissionId: string;
    readonly outcome: "committed" | "discarded";
    readonly observedResultDigest?: string;
  }): AdmissionRecord {
    this.#authorize("index");
    const state = this.#state();
    const admission = state.admissions.get(options.admissionId);
    if (!admission) {
      throw memoryError("MEMORY_JOB_STATE_INVALID", "Admission is not prepared", {
        admissionId: options.admissionId,
      });
    }
    if (admission.state !== "prepared") {
      if (admission.state === options.outcome) return admission;
      throw memoryError(
        "MEMORY_JOB_STATE_INVALID",
        "An admission is immutable after it reaches a terminal state",
        { admissionId: options.admissionId, state: admission.state },
      );
    }
    if (options.outcome === "committed") {
      if (options.observedResultDigest !== admission.expectedResultDigest) {
        throw memoryError(
          "MEMORY_JOB_STATE_INVALID",
          "The committed Module result digest does not match this admission",
          { admissionId: options.admissionId },
        );
      }
      // §12.2: activation of an admission after its Module job commits
      // atomically rechecks the lineage tombstone and its deletion epoch, so a
      // late admission cannot resurrect deleted content.
      for (const lineageKey of admission.sourceLineageKeys) {
        const tombstone = state.tombstones.get(lineageKey);
        if (tombstone && tombstone.deletionEpoch >= admission.deletionEpoch) {
          throw memoryError(
            "MEMORY_TOMBSTONED",
            "The source lineage is tombstoned under an equal or newer deletion epoch",
            { admissionId: options.admissionId, lineageKey },
          );
        }
      }
    }
    this.#commit([
      {
        type: "admission-settled",
        namespaceKey: this.#namespace.namespaceKey,
        admissionId: options.admissionId,
        state: options.outcome,
        ...(options.observedResultDigest === undefined
          ? {}
          : { observedResultDigest: options.observedResultDigest }),
      },
    ]);
    if (options.outcome === "committed") this.#settleReusedOccurrences(admission);
    return this.#state().admissions.get(options.admissionId)!;
  }

  /**
   * §5.4: a repeated Delivery of a Block reuses an already committed feature
   * set, and its own Page sequence advances only when its own occurrence
   * reaches the required terminal state. When the shared FeatureJob is already
   * terminal at commit time there is no further background work to wait for, so
   * this serialized step is where the new occurrence becomes terminal. It never
   * advances a sequence whose job is still pending.
   */
  #settleReusedOccurrences(admission: AdmissionRecord): void {
    const state = this.#state();
    for (const deliveryId of admission.deliveryIds) {
      const occurrence = state.occurrences.get(deliveryId);
      if (!occurrence?.featureJobId) continue;
      const job = state.jobs.get(occurrence.featureJobId);
      if (!job || !TERMINAL_JOB_STATES.includes(job.state)) continue;
      const outcome: DeliveryOutcome =
        job.state === "succeeded"
          ? "success"
          : job.state === "skipped"
            ? "skip"
            : job.state === "permanent-failure"
              ? "permanent-failure"
              : "retryable";
      this.#commit([
        {
          type: "delivery-outcome",
          namespaceKey: this.#namespace.namespaceKey,
          pageId: occurrence.sourcePageId,
          pageSequence: occurrence.pageSequence,
          outcome,
        },
      ]);
    }
  }

  occurrence(deliveryId: string): OccurrenceRecord | undefined {
    this.#authorize("query");
    return this.#state().occurrences.get(deliveryId);
  }

  occurrences(): readonly OccurrenceRecord[] {
    this.#authorize("query");
    return [...this.#state().occurrences.values()];
  }

  recordOccurrence(occurrence: OccurrenceRecord): void {
    this.#authorize("index");
    assertSameNamespace(this.#namespace, occurrence.namespaceKey, "occurrence");
    const existing = this.#state().occurrences.get(occurrence.deliveryId);
    if (existing) return; // Idempotent by Delivery ID (§5.2).
    this.#commit([{ type: "occurrence-recorded", occurrence }]);
  }

  record(recordId: string): MemoryRecord | undefined {
    this.#authorize("query");
    return this.#state().records.get(recordId);
  }

  records(): readonly MemoryRecord[] {
    this.#authorize("query");
    return [...this.#state().records.values()];
  }

  /**
   * Commits one record. §3 invariant 2: one immutable source Block is indexed
   * at most once per namespace, extractor version, and feature plan, so a
   * repeated commit of the same `recordId` is a no-op rather than a second
   * segment.
   */
  commitRecord(record: MemoryRecord): void {
    this.#authorize("index");
    assertSameNamespace(this.#namespace, record.namespaceKey, "memory record");
    const state = this.#state();
    if (state.records.has(record.recordId)) return;
    if (state.records.size >= this.#store.limits.maxRecordsPerNamespace) {
      throw memoryError("MEMORY_LIMIT_EXCEEDED", "Namespace record capacity is exhausted", {
        limit: "maxRecordsPerNamespace",
        allowed: this.#store.limits.maxRecordsPerNamespace,
      });
    }
    this.#commit([{ type: "record-committed", record }]);
  }

  feature(featureId: string): FeatureRecord | undefined {
    this.#authorize("query");
    return this.#state().features.get(featureId);
  }

  features(): readonly FeatureRecord[] {
    this.#authorize("query");
    return [...this.#state().features.values()];
  }

  commitFeature(feature: FeatureRecord): void {
    this.#authorize("index");
    assertSameNamespace(this.#namespace, feature.namespaceKey, "memory feature");
    const state = this.#state();
    if (state.features.has(feature.featureId)) return;
    if (state.features.size >= this.#store.limits.maxFeaturesPerNamespace) {
      throw memoryError("MEMORY_LIMIT_EXCEEDED", "Namespace feature capacity is exhausted", {
        limit: "maxFeaturesPerNamespace",
        allowed: this.#store.limits.maxFeaturesPerNamespace,
      });
    }
    this.#commit([{ type: "feature-committed", feature }]);
  }

  createFeatureJob(job: FeatureJobRecord): FeatureJobRecord {
    this.#authorize("index");
    assertSameNamespace(this.#namespace, job.namespaceKey, "feature job");
    const state = this.#state();
    const existing = state.jobs.get(job.featureJobId);
    if (existing) {
      // Creating the same job twice is idempotent (§5.5). A later committed
      // admission attaches its occurrences to the shared job instead of
      // creating a second one, which is what makes duplicate wakeups and
      // retries converge on one job and one committed feature set.
      const attachments = job.requiredByAdmissionIds
        .filter((admissionId) => !existing.requiredByAdmissionIds.includes(admissionId))
        .map((admissionId) => ({
          type: "feature-job-attached" as const,
          namespaceKey: this.#namespace.namespaceKey,
          featureJobId: job.featureJobId,
          admissionId,
        }));
      this.#commit(attachments);
      return this.#state().jobs.get(job.featureJobId)!;
    }
    const pending = [...state.jobs.values()].filter(
      (candidate) => candidate.state === "pending" || candidate.state === "retryable",
    ).length;
    if (pending >= this.#store.limits.maxPendingJobs) {
      throw memoryError("MEMORY_LIMIT_EXCEEDED", "Pending feature job capacity is exhausted", {
        limit: "maxPendingJobs",
        allowed: this.#store.limits.maxPendingJobs,
      });
    }
    this.#commit([{ type: "feature-job-created", job }]);
    return this.#state().jobs.get(job.featureJobId)!;
  }

  featureJob(featureJobId: string): FeatureJobRecord | undefined {
    this.#authorize("query");
    return this.#state().jobs.get(featureJobId);
  }

  featureJobs(): readonly FeatureJobRecord[] {
    this.#authorize("query");
    return [...this.#state().jobs.values()];
  }

  /**
   * Enumerates durable jobs the background indexer may run.
   *
   * §6.2 forbids enumerating prepared admissions as runnable: a job is runnable
   * only when at least one admission that requires it is `committed`.
   */
  runnableFeatureJobs(): readonly FeatureJobRecord[] {
    this.#authorize("query");
    const state = this.#state();
    return [...state.jobs.values()]
      .filter((job) => job.state === "pending" || job.state === "retryable")
      .filter((job) =>
        job.requiredByAdmissionIds.some(
          (admissionId) => state.admissions.get(admissionId)?.state === "committed",
        ),
      )
      .sort((left, right) => (left.featureJobId < right.featureJobId ? -1 : 1));
  }

  claimFeatureJob(options: {
    readonly featureJobId: string;
    readonly leaseId: string;
    readonly moduleGeneration: number;
  }): FeatureJobRecord {
    this.#authorize("index");
    const job = this.#state().jobs.get(options.featureJobId);
    if (!job) {
      throw memoryError("MEMORY_JOB_STATE_INVALID", "Feature job does not exist", {
        featureJobId: options.featureJobId,
      });
    }
    if (job.state !== "pending" && job.state !== "retryable") {
      throw memoryError("MEMORY_JOB_STATE_INVALID", "Feature job is not runnable", {
        featureJobId: options.featureJobId,
        state: job.state,
      });
    }
    const attempt = job.attempt + 1;
    if (attempt > job.maxAttempts) {
      this.settleFeatureJob({
        featureJobId: options.featureJobId,
        state: "permanent-failure",
        errorCode: "MEMORY_JOB_ATTEMPTS_EXHAUSTED",
      });
      throw memoryError("MEMORY_LIMIT_EXCEEDED", "Feature job attempt budget is exhausted", {
        limit: "maxAttempts",
        allowed: job.maxAttempts,
      });
    }
    this.#commit([
      {
        type: "feature-job-claimed",
        namespaceKey: this.#namespace.namespaceKey,
        featureJobId: options.featureJobId,
        leaseId: options.leaseId,
        moduleGeneration: options.moduleGeneration,
        attempt,
      },
    ]);
    return this.#state().jobs.get(options.featureJobId)!;
  }

  settleFeatureJob(options: {
    readonly featureJobId: string;
    readonly state: FeatureJobState;
    readonly errorCode?: string;
    /** When present, a claim from an older generation is fenced (§6.2). */
    readonly moduleGeneration?: number;
  }): FeatureJobRecord {
    this.#authorize("index");
    const job = this.#state().jobs.get(options.featureJobId);
    if (!job) {
      throw memoryError("MEMORY_JOB_STATE_INVALID", "Feature job does not exist", {
        featureJobId: options.featureJobId,
      });
    }
    if (TERMINAL_JOB_STATES.includes(job.state)) {
      if (job.state === options.state) return job;
      throw memoryError("MEMORY_JOB_STATE_INVALID", "Feature job already reached a terminal state", {
        featureJobId: options.featureJobId,
        state: job.state,
      });
    }
    if (
      options.moduleGeneration !== undefined &&
      job.claim !== undefined &&
      options.moduleGeneration < job.claim.moduleGeneration
    ) {
      throw memoryError(
        "MEMORY_GENERATION_FENCED",
        "A result from an older Module generation cannot advance an index",
        { featureJobId: options.featureJobId },
      );
    }
    this.#commit([
      {
        type: "feature-job-settled",
        namespaceKey: this.#namespace.namespaceKey,
        featureJobId: options.featureJobId,
        state: options.state,
        ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
      },
    ]);
    return this.#state().jobs.get(options.featureJobId)!;
  }

  recordDeliveryOutcome(options: {
    readonly pageId: string;
    readonly pageSequence: number;
    readonly outcome: DeliveryOutcome;
  }): void {
    this.#authorize("index");
    this.#commit([
      {
        type: "delivery-outcome",
        namespaceKey: this.#namespace.namespaceKey,
        pageId: options.pageId,
        pageSequence: options.pageSequence,
        outcome: options.outcome,
      },
    ]);
  }

  coverage(pageId: string): CoverageState {
    this.#authorize("query");
    const state = this.#state();
    return computeCoverage(
      pageId,
      state.deliveryOutcomes.get(pageId) ?? new Map(),
      state.corpusRevision,
      this.#store.limits.maxTrackedGapsPerPage,
    );
  }

  removeRetentionKey(admissionId: string, retentionKey: string): void {
    this.#authorize("retention-change");
    this.#commit([
      {
        type: "retention-key-removed",
        namespaceKey: this.#namespace.namespaceKey,
        admissionId,
        retentionKey,
      },
    ]);
  }

  createTombstone(lineageKey: string, deletionEpoch: number): TombstoneRecord {
    this.#authorize("delete");
    this.#commit([
      {
        type: "tombstone-created",
        namespaceKey: this.#namespace.namespaceKey,
        lineageKey,
        deletionEpoch,
      },
    ]);
    return this.#state().tombstones.get(lineageKey)!;
  }

  tombstone(lineageKey: string): TombstoneRecord | undefined {
    this.#authorize("query");
    return this.#state().tombstones.get(lineageKey);
  }

  revisions(): { readonly corpusRevision: number; readonly tombstoneRevision: number } {
    this.#authorize("query");
    const state = this.#state();
    return { corpusRevision: state.corpusRevision, tombstoneRevision: state.tombstoneRevision };
  }
}
