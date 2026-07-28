import { deepFreeze } from "../../core/canonical-json.js";
import {
  validateEmbeddingOutcomes,
  type MemoryEmbeddingItem,
  type MemoryEmbeddingOperation,
} from "./embedding-capability.js";
import { MemoryError, memoryError } from "./errors.js";
import {
  lexicalTokens,
  type MemorySourceBlock,
  type TextExtractor,
} from "./extraction.js";
import { planMediaFeature, type FeaturePlan } from "./feature-plan.js";
import { assertGenerationAccepts, type IndexGeneration } from "./index-generation.js";
import type { MemoryAuthorization, MemoryNamespace } from "./namespace.js";
import {
  createFeatureRecord,
  createMemoryRecord,
  deriveRecordId,
  assertFeatureRetainsNoMediaBytes,
  type FeatureSkip,
  type MemoryRecord,
} from "./records.js";
import type { FeatureJobRecord, MemoryStore, MemoryStoreSession } from "./store.js";

/**
 * The registered background indexer from `docs/spec/memory-extension.md` §6.2
 * and `docs/spec/core-runtime.md` §9.5.
 *
 * Three properties are structural rather than documented:
 *
 * 1. It cannot emit a Block. There is no Block, Page, or proposal dependency in
 *    this file. A completion that needs actor-visible state produces an
 *    `ActivationRequest` with a stable idempotency key, which only the
 *    serialized Module action can act on.
 * 2. It cannot remove a Core strong reference. Its authorization is expected to
 *    grant `index` and `query` only, so `removeRetentionKey` fails closed with
 *    `MEMORY_SCOPE_DENIED`; the later committed Module result removes the
 *    admission strong references.
 * 3. Correctness does not depend on an in-memory queue, a sleep, or a
 *    fire-and-forget promise. Runnable work is enumerated from durable state
 *    every pass, so a restart resumes exactly where the journal left off.
 */

export interface MemoryBlockLease {
  readonly leaseId: string;
  readonly blockId: string;
  readonly block: MemorySourceBlock;
  release(): void;
}

/**
 * Bounded, fenced access to one delivered Block. The lease carries the Module
 * generation and FeatureJob identity required by §11.3, and the reader is the
 * host's capability: Memory never opens a file, URL, or object key itself.
 */
export interface MemoryBlockReader {
  acquire(request: {
    readonly blockId: string;
    readonly leaseId: string;
    readonly featureJobId: string;
    readonly moduleGeneration: number;
  }): Promise<MemoryBlockLease>;
}

/** Reported to the media policy; supplied by the host's media view (§8.3). */
export interface MemoryMediaModalityResolver {
  modalityOf(mediaId: string): string | undefined;
}

export interface ActivationRequest {
  readonly idempotencyKey: string;
  readonly kind: "memory.feature-job-terminal/1";
  readonly featureJobId: string;
  readonly admissionIds: readonly string[];
  readonly retentionKeys: readonly string[];
  readonly terminalState: FeatureJobRecord["state"];
}

export interface IndexerReport {
  readonly succeeded: readonly string[];
  readonly skipped: readonly string[];
  readonly permanentFailures: readonly string[];
  readonly cancelled: readonly string[];
  readonly maxObservedConcurrency: number;
  readonly outstandingLeases: number;
  readonly activationRequests: readonly ActivationRequest[];
}

export interface BackgroundIndexerLimits {
  readonly maxConcurrency: number;
  readonly maxJobsPerDrain: number;
  readonly maxSegmentsPerJob: number;
}

export const DEFAULT_BACKGROUND_INDEXER_LIMITS: BackgroundIndexerLimits = deepFreeze({
  maxConcurrency: 2,
  maxJobsPerDrain: 512,
  maxSegmentsPerJob: 128,
});

export interface BackgroundIndexerOptions {
  readonly store: MemoryStore;
  readonly namespace: MemoryNamespace;
  /** Expected to grant `index` and `query`, and never `retention-change`. */
  readonly authorization: MemoryAuthorization;
  readonly plan: FeaturePlan;
  readonly featurePlanDigest: string;
  readonly extractor: TextExtractor;
  readonly lexicalGeneration: IndexGeneration;
  readonly vectorGeneration?: IndexGeneration;
  readonly embedding?: MemoryEmbeddingOperation;
  readonly blockReader: MemoryBlockReader;
  readonly mediaModalities?: MemoryMediaModalityResolver;
  readonly moduleGeneration: number;
  readonly leaseIds: () => string;
  readonly limits?: Partial<BackgroundIndexerLimits>;
}

/**
 * A typed Memory failure is a contract failure: a configuration, isolation,
 * schema, limit, or compatibility problem fails the same way on every attempt,
 * so retrying it only burns the attempt budget. Anything else reached this code
 * from a reader or a provider and is transport-shaped, so it is retried under
 * the job's finite attempt budget and then dead-lettered.
 */
function isRetryable(error: unknown): boolean {
  return !(error instanceof MemoryError);
}

export class MemoryBackgroundIndexer {
  readonly #options: BackgroundIndexerOptions;
  readonly #limits: BackgroundIndexerLimits;
  readonly #session: MemoryStoreSession;
  readonly #activationRequests = new Map<string, ActivationRequest>();
  #inFlight = 0;
  #maxObservedConcurrency = 0;
  #outstandingLeases = 0;
  #cancelled = false;

  constructor(options: BackgroundIndexerOptions) {
    this.#options = options;
    this.#limits = { ...DEFAULT_BACKGROUND_INDEXER_LIMITS, ...(options.limits ?? {}) };
    for (const [label, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw memoryError("MEMORY_CONFIG_INVALID", `${label} must be a positive safe integer`, {
          limit: label,
        });
      }
    }
    this.#session = options.store.session(options.namespace, options.authorization, "index");
  }

  get maxObservedConcurrency(): number {
    return this.#maxObservedConcurrency;
  }

  get outstandingLeases(): number {
    return this.#outstandingLeases;
  }

  get activationRequests(): readonly ActivationRequest[] {
    return [...this.#activationRequests.values()].sort((left, right) =>
      left.idempotencyKey < right.idempotencyKey ? -1 : 1,
    );
  }

  /**
   * §6.2/§12.4: on startup the indexer enumerates durable nonterminal jobs in
   * its namespace. `MemoryStore.open` has already reset abandoned `running`
   * claims, so this returns exactly the work a crash left behind.
   */
  resume(): readonly FeatureJobRecord[] {
    return this.#session.runnableFeatureJobs();
  }

  /** Quiesce: stops admitting new jobs. Claimed jobs stay durably resumable. */
  cancel(): void {
    this.#cancelled = true;
  }

  /**
   * Runs durable jobs to a fixed point under bounded concurrency.
   *
   * Completion is state-based: the loop stops when no runnable job remains, not
   * after a sleep or a fixed number of ticks.
   */
  async drain(): Promise<IndexerReport> {
    const succeeded: string[] = [];
    const skipped: string[] = [];
    const permanentFailures: string[] = [];
    const cancelled: string[] = [];
    let processed = 0;

    while (!this.#cancelled) {
      const runnable = this.#session.runnableFeatureJobs();
      if (runnable.length === 0) break;
      if (processed >= this.#limits.maxJobsPerDrain) {
        throw memoryError("MEMORY_LIMIT_EXCEEDED", "Drain exceeded its job budget", {
          limit: "maxJobsPerDrain",
          allowed: this.#limits.maxJobsPerDrain,
        });
      }
      const batch = runnable.slice(0, this.#limits.maxConcurrency);
      processed += batch.length;
      // One failed job must not stop unrelated jobs (§12.4), so `#runJob`
      // settles every outcome durably instead of throwing out of the batch.
      await Promise.all(batch.map((job) => this.#runJob(job)));
      for (const started of batch) {
        const state = this.#session.featureJob(started.featureJobId)!.state;
        if (state === "succeeded") succeeded.push(started.featureJobId);
        else if (state === "skipped") skipped.push(started.featureJobId);
        else if (state === "permanent-failure") permanentFailures.push(started.featureJobId);
        else if (state === "cancelled") cancelled.push(started.featureJobId);
      }
    }

    return deepFreeze({
      succeeded: [...new Set(succeeded)].sort(),
      skipped: [...new Set(skipped)].sort(),
      permanentFailures: [...new Set(permanentFailures)].sort(),
      cancelled: [...new Set(cancelled)].sort(),
      maxObservedConcurrency: this.#maxObservedConcurrency,
      outstandingLeases: this.#outstandingLeases,
      activationRequests: this.activationRequests,
    });
  }

  async #runJob(job: FeatureJobRecord): Promise<FeatureJobRecord["state"]> {
    if (job.attempt >= job.maxAttempts) {
      const settled = this.#session.settleFeatureJob({
        featureJobId: job.featureJobId,
        state: "permanent-failure",
        errorCode: "MEMORY_JOB_ATTEMPTS_EXHAUSTED",
      });
      this.#recordActivation(settled);
      return settled.state;
    }
    const leaseId = this.#options.leaseIds();
    const claimed = this.#session.claimFeatureJob({
      featureJobId: job.featureJobId,
      leaseId,
      moduleGeneration: this.#options.moduleGeneration,
    });

    this.#inFlight += 1;
    this.#maxObservedConcurrency = Math.max(this.#maxObservedConcurrency, this.#inFlight);
    let lease: MemoryBlockLease | undefined;
    try {
      lease = await this.#options.blockReader.acquire({
        blockId: claimed.sourceBlockId,
        leaseId,
        featureJobId: claimed.featureJobId,
        moduleGeneration: this.#options.moduleGeneration,
      });
      this.#outstandingLeases += 1;
      const state = await this.#indexBlock(claimed, lease.block);
      const settled = this.#session.settleFeatureJob({
        featureJobId: claimed.featureJobId,
        state,
        moduleGeneration: this.#options.moduleGeneration,
      });
      this.#recordActivation(settled);
      return settled.state;
    } catch (error) {
      const code = error instanceof MemoryError ? error.code : "MEMORY_JOB_FAILED";
      const retry = isRetryable(error) && claimed.attempt < claimed.maxAttempts;
      const settled = this.#session.settleFeatureJob({
        featureJobId: claimed.featureJobId,
        state: retry ? "retryable" : "permanent-failure",
        errorCode: code,
        moduleGeneration: this.#options.moduleGeneration,
      });
      if (!retry) this.#recordActivation(settled);
      return settled.state;
    } finally {
      // §11.3: released idempotently on success, failure, timeout,
      // cancellation, or fencing. This is the only release site.
      if (lease) {
        lease.release();
        this.#outstandingLeases -= 1;
      }
      this.#inFlight -= 1;
    }
  }

  async #indexBlock(
    job: FeatureJobRecord,
    block: MemorySourceBlock,
  ): Promise<"succeeded" | "skipped"> {
    const extraction = this.#options.extractor.extract({
      sourceBlockId: job.sourceBlockId,
      payloadSchema: block.payloadSchema,
      content: block.content,
    });
    if (extraction.segments.length > this.#limits.maxSegmentsPerJob) {
      throw memoryError("MEMORY_LIMIT_EXCEEDED", "Segment count exceeds the job limit", {
        limit: "maxSegmentsPerJob",
        allowed: this.#limits.maxSegmentsPerJob,
      });
    }

    const mediaSkips = this.#planMedia(extraction.mediaCandidates);
    if (extraction.segments.length === 0) return "skipped";

    const records: MemoryRecord[] = extraction.segments.map((segment) =>
      createMemoryRecord({
        namespace: this.#options.namespace,
        sourceBlockId: job.sourceBlockId,
        coreSequence: job.coreSequence,
        sourcePageId: job.sourcePageId,
        originatingSessionId: job.originatingSessionId,
        payloadSchema: block.payloadSchema,
        extractorId: extraction.extractorId,
        extractorVersion: extraction.extractorVersion,
        segmentId: segment.segmentId,
        segmentStartByte: segment.startByte,
        segmentEndByte: segment.endByte,
        text: segment.text,
        committedFeatureIds: [],
        skippedFeatures: mediaSkips,
        featurePlanDigest: job.featurePlanDigest,
        creationModuleJobId: job.creationModuleJobId,
        coverageRevision: this.#session.revisions().corpusRevision,
        deletionEpoch: job.deletionEpoch,
      }),
    );

    // The record IDs are derived from the namespace, source Block, extractor
    // version, segment, feature plan, and deletion epoch. A second Delivery of
    // the same Block therefore derives the same IDs, and `commitRecord` is a
    // no-op: §3 invariant 2 holds without a separate deduplication pass.
    for (const record of records) {
      const expected = deriveRecordId({
        namespace: this.#options.namespace,
        sourceBlockId: record.sourceBlockId,
        extractorId: record.extractorId,
        extractorVersion: record.extractorVersion,
        segmentId: record.segmentId,
        featurePlanDigest: record.featurePlanDigest,
        deletionEpoch: record.deletionEpoch,
      });
      if (expected !== record.recordId) {
        throw memoryError("MEMORY_RECORD_INVALID", "Record identity is not reproducible");
      }
      this.#session.commitRecord(record);
    }

    for (const record of records) {
      const feature = createFeatureRecord({
        recordId: record.recordId,
        namespaceKey: record.namespaceKey,
        kind: "lexical",
        sourceModality: "text",
        pipelineId: this.#options.plan.analyzerId,
        pipelineVersion: this.#options.plan.analyzerVersion,
        generationId: this.#options.lexicalGeneration.generationId,
        featureJobId: job.featureJobId,
        status: "committed",
        tokens: lexicalTokens(record.text),
      });
      assertGenerationAccepts(this.#options.lexicalGeneration, feature, "lexical feature");
      assertFeatureRetainsNoMediaBytes(feature);
      this.#session.commitFeature(feature);
    }

    const embedding = this.#options.embedding;
    const vectorGeneration = this.#options.vectorGeneration;
    if (embedding && vectorGeneration) {
      const items: MemoryEmbeddingItem[] = records.map((record) => ({
        itemId: record.recordId,
        kind: "text",
        text: record.text,
      }));
      const batchSize = Math.min(embedding.capability.maxBatchItems, items.length) || 1;
      for (let offset = 0; offset < items.length; offset += batchSize) {
        const batch = items.slice(offset, offset + batchSize);
        const outcomes = validateEmbeddingOutcomes(
          embedding.capability,
          batch,
          await embedding.embed(batch),
        );
        if (outcomes.length !== batch.length) {
          // §5.5: a partially returned provider batch is correlated by item ID
          // and is never treated as a complete job.
          throw memoryError(
            "MEMORY_JOB_STATE_INVALID",
            "Embedding batch returned fewer items than requested",
            { requested: batch.length, returned: outcomes.length },
          );
        }
        for (const outcome of outcomes) {
          if (outcome.status !== "succeeded") {
            throw memoryError("MEMORY_JOB_STATE_INVALID", "Embedding item failed", {
              itemId: outcome.itemId,
              errorCode: outcome.errorCode,
            });
          }
          const feature = createFeatureRecord({
            recordId: outcome.itemId,
            namespaceKey: this.#options.namespace.namespaceKey,
            kind: "native-embedding",
            sourceModality: "text",
            pipelineId: this.#options.plan.extractorId,
            pipelineVersion: this.#options.plan.extractorVersion,
            generationId: vectorGeneration.generationId,
            featureJobId: job.featureJobId,
            status: "committed",
            endpointId: embedding.capability.endpointId,
            modelId: embedding.capability.modelId,
            adapterId: embedding.capability.adapterId,
            adapterVersion: embedding.capability.adapterVersion,
            descriptorVersion: embedding.capability.descriptorVersion,
            descriptorDigest: embedding.capability.descriptorDigest,
            vectorSpace: embedding.capability.vectorSpace,
            vector: outcome.vector,
          });
          assertGenerationAccepts(vectorGeneration, feature, "vector feature");
          assertFeatureRetainsNoMediaBytes(feature);
          this.#session.commitFeature(feature);
        }
      }
    }

    return "succeeded";
  }

  /**
   * §5.4: coverage is evaluated per Delivery occurrence, not per job. Two
   * Deliveries of one Block share a feature set but each advances its own Page
   * sequence only when its own occurrence reaches the required terminal state.
   */
  #advanceCoverage(job: FeatureJobRecord, state: FeatureJobRecord["state"]): void {
    const outcome =
      state === "succeeded"
        ? "success"
        : state === "skipped"
          ? "skip"
          : state === "permanent-failure"
            ? "permanent-failure"
            : "retryable";
    for (const occurrence of this.#session.occurrences()) {
      if (occurrence.featureJobId !== job.featureJobId) continue;
      this.#session.recordDeliveryOutcome({
        pageId: occurrence.sourcePageId,
        pageSequence: occurrence.pageSequence,
        outcome,
      });
    }
  }

  /**
   * §8.3: each modality reaches exactly one configured policy. An unsupported
   * or unresolvable modality produces a visible terminal skip; nothing here
   * hashes bytes, inserts zeros, reuses a text vector, or calls a mock.
   */
  #planMedia(
    candidates: readonly { readonly mediaId: string }[],
  ): readonly FeatureSkip[] {
    const skips: FeatureSkip[] = [];
    for (const candidate of candidates) {
      const modality = this.#options.mediaModalities?.modalityOf(candidate.mediaId);
      if (modality === undefined) {
        skips.push({
          kind: "native-embedding",
          modality: "unresolved",
          reason: "MEDIA_MODALITY_UNRESOLVED",
        });
        continue;
      }
      let decision;
      try {
        decision = planMediaFeature(this.#options.plan, modality);
      } catch (error) {
        if (error instanceof MemoryError && error.code === "MEMORY_MODALITY_UNSUPPORTED") {
          skips.push({ kind: "native-embedding", modality, reason: error.code });
          continue;
        }
        throw error;
      }
      if (decision.kind === "skip") {
        skips.push({ kind: "native-embedding", modality, reason: decision.reason });
        continue;
      }
      // Native, derived-text, and metadata-only media features are outside the
      // provider-independent baseline path implemented here. The policy is
      // honoured by recording a visible unimplemented skip rather than by
      // quietly producing a text vector and labelling it as media.
      skips.push({
        kind: decision.kind === "derived-text" ? "derived-text-embedding" : "native-embedding",
        modality,
        reason: "MEDIA_FEATURE_NOT_IMPLEMENTED",
      });
    }
    return skips;
  }

  /**
   * §6.2/§11.2: a terminal job submits a stable actor signal. The signal asks a
   * later serialized Module result to remove the admission strong references.
   * The background service never removes one itself, so a crash before the
   * actor result leaves an observable extra strong reference, not a dangling
   * source.
   */
  #recordActivation(job: FeatureJobRecord): void {
    this.#advanceCoverage(job, job.state);
    const admissions = job.requiredByAdmissionIds
      .map((admissionId) => this.#session.admission(admissionId))
      .filter((admission): admission is NonNullable<typeof admission> => admission !== undefined)
      .filter((admission) => admission.state === "committed");
    const request: ActivationRequest = {
      idempotencyKey: `memory.feature-job-terminal/1:${job.namespaceKey}:${job.featureJobId}:${job.state}`,
      kind: "memory.feature-job-terminal/1",
      featureJobId: job.featureJobId,
      admissionIds: admissions.map((admission) => admission.admissionId).sort(),
      retentionKeys: [
        ...new Set(
          admissions.flatMap((admission) =>
            admission.retentionTargets.map((target) => target.retentionKey),
          ),
        ),
      ].sort(),
      terminalState: job.state,
    };
    this.#activationRequests.set(request.idempotencyKey, request);
  }
}
