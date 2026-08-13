import { createHash } from "node:crypto";
import { canonicalJsonByteLength } from "../../../../src/core/canonical-json.js";
import {
  DOLLY_CONTENT_TEXT_EXTRACTOR_CONTRACT,
  InMemoryMemoryJournal,
  LEXICAL_CHANNEL_ID,
  MEMORY_QUERY_SCHEMA,
  MemoryBackgroundIndexer,
  MemoryStore,
  authenticateNamespace,
  createFeaturePlan,
  createTextContentExtractor,
  deriveLexicalGeneration,
  featurePlanDigest,
  normalizeExtractedText,
  runMemoryModuleAction,
  type CoverageState,
  type DeliveredInput,
  type ExtractionSkipReason,
  type MemoryAuthorization,
  type MemoryBlockReader,
  type MemorySourceBlock,
  type RuntimeMemoryIdentity,
  type ThresholdProfile,
} from "../../../../src/extensions/memory/index.js";

export interface ProductLexicalMessage {
  readonly role: string;
  readonly content: string;
}

export interface ProductLexicalSession {
  readonly session_id: string;
  readonly messages: readonly ProductLexicalMessage[];
}

export interface ProductLexicalCase {
  readonly question_id: string;
  readonly question: string;
  readonly sessions: readonly ProductLexicalSession[];
}

export interface ProductLexicalResult {
  readonly questionId: string;
  readonly lexicalGeneration: ReturnType<typeof deriveLexicalGeneration>;
  readonly effectiveMode: "lexical";
  readonly channelIds: readonly string[];
  /** Record ranks are truncated before session mapping; duplicates remain in place. */
  readonly ranking: readonly ProductLexicalRank[];
  readonly inputCounts: {
    readonly sessions: number;
    readonly messages: number;
    readonly emptySessions: number;
  };
  readonly extractionCoverage: ProductLexicalExtractionCoverage;
  readonly terminalJobAccounting: ProductLexicalTerminalJobAccounting;
  readonly queryCoverage: CoverageState;
  readonly recordCount: number;
  readonly featureCount: number;
  readonly canonicalRecordBytes: number;
  readonly canonicalFeatureBytes: number;
}

export interface ProductLexicalRank {
  readonly rank: number;
  readonly recordId: string;
  readonly sourceBlockId: string;
  readonly sessionId: string;
  readonly rawBm25: number;
}

export interface ProductLexicalExtractionCoverage {
  readonly normalizedInputBytes: number;
  readonly coveredNormalizedBytes: number;
  readonly uncoveredNormalizedBytes: number;
  readonly truncatedItems: number;
  readonly skippedItemsByReason: Readonly<Record<ExtractionSkipReason, number>>;
  readonly complete: boolean;
}

export interface ProductLexicalTerminalJobAccounting {
  readonly pending: number;
  readonly running: number;
  readonly retryable: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly permanentFailure: number;
  readonly cancelled: number;
  readonly outstandingLeases: number;
  readonly maxObservedConcurrency: number;
}

export interface ProductSessionRankingMetrics {
  readonly hit: 0 | 1;
  readonly recall: number;
  readonly ndcg: number;
}

const EMPTY_THRESHOLDS: ThresholdProfile = Object.freeze({
  profileId: "memory-product-lexical-replay.no-threshold",
  version: "1",
  rules: [],
});

function stableBlockId(questionId: string, sessionId: string, index: number): string {
  return createHash("sha256")
    .update("memory-product-lexical-replay-v0", "utf8")
    .update("\0", "utf8")
    .update(questionId, "utf8")
    .update("\0", "utf8")
    .update(sessionId, "utf8")
    .update("\0", "utf8")
    .update(String(index), "utf8")
    .digest("hex");
}

function messageText(message: ProductLexicalMessage): string {
  return `${message.role.toLowerCase()}: ${message.content}`;
}

function coveredByteCount(
  ranges: readonly { readonly startByte: number; readonly endByte: number }[],
): number {
  const ordered = [...ranges].sort((left, right) =>
    left.startByte - right.startByte || left.endByte - right.endByte,
  );
  let total = 0;
  let start = 0;
  let end = 0;
  let active = false;
  for (const range of ordered) {
    if (!active) {
      start = range.startByte;
      end = range.endByte;
      active = true;
      continue;
    }
    if (range.startByte <= end) {
      end = Math.max(end, range.endByte);
      continue;
    }
    total += end - start;
    start = range.startByte;
    end = range.endByte;
  }
  return active ? total + end - start : 0;
}

/** Gold-aware analyzer primitive. Duplicate sessions occupy their original ranks. */
export function scoreProductSessionRanking(
  sessionIds: readonly string[],
  goldSessionIds: readonly string[],
  cutoff: number,
): ProductSessionRankingMetrics {
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0) {
    throw new TypeError("product lexical metric cutoff must be a positive safe integer");
  }
  const gold = new Set(goldSessionIds);
  const seen = new Set<string>();
  let relevant = 0;
  let dcg = 0;
  sessionIds.slice(0, cutoff).forEach((sessionId, index) => {
    if (seen.has(sessionId)) return;
    seen.add(sessionId);
    if (!gold.has(sessionId)) return;
    relevant += 1;
    dcg += 1 / Math.log2(index + 2);
  });
  const idealRelevant = Math.min(cutoff, gold.size);
  let idealDcg = 0;
  for (let index = 0; index < idealRelevant; index += 1) {
    idealDcg += 1 / Math.log2(index + 2);
  }
  return Object.freeze({
    hit: relevant > 0 ? 1 : 0,
    recall: gold.size === 0 ? 0 : relevant / gold.size,
    ndcg: idealDcg === 0 ? 0 : dcg / idealDcg,
  });
}

function delivered(
  sourceBlockId: string,
  block: MemorySourceBlock,
  sequence: number,
): DeliveredInput {
  return {
    delivery: {
      deliveryId: `delivery-${sourceBlockId}`,
      inputPageId: "longmemeval-sessions",
      pageSequence: sequence,
      sourceBlockId,
      coreSequence: sequence,
      sourceModuleInstanceId: "longmemeval-source",
    },
    block,
  };
}

function actionArguments(input: {
  readonly store: MemoryStore;
  readonly identity: RuntimeMemoryIdentity;
  readonly namespace: ReturnType<typeof authenticateNamespace>;
  readonly authorization: MemoryAuthorization;
  readonly plan: ReturnType<typeof createFeaturePlan>;
  readonly planDigest: string;
  readonly lexicalGeneration: ReturnType<typeof deriveLexicalGeneration>;
  readonly inputs: readonly DeliveredInput[];
  readonly moduleJobId: string;
  readonly runId: string;
}) {
  let lease = 0;
  return {
    store: input.store,
    identity: input.identity,
    namespace: input.namespace,
    authorization: input.authorization,
    moduleJobId: input.moduleJobId,
    moduleGeneration: 1,
    runId: input.runId,
    inputs: input.inputs,
    plan: input.plan,
    featurePlanDigest: input.planDigest,
    acceptedPayloadSchemas: ["dolly.content/1"],
    lexicalGeneration: input.lexicalGeneration,
    thresholdProfile: EMPTY_THRESHOLDS,
    deletionEpoch: 0,
    maxAttempts: 3,
    tick: 0,
    leaseIds: () => `${input.runId}-lease-${++lease}`,
    includeSourceRefs: false,
  } as const;
}

function settleAction(
  store: MemoryStore,
  namespace: ReturnType<typeof authenticateNamespace>,
  authorization: MemoryAuthorization,
  preparation: Awaited<ReturnType<typeof runMemoryModuleAction>>["preparation"],
  resultDigest: string,
): void {
  store.session(namespace, authorization, "index").settleAdmission({
    admissionId: preparation.admission.admissionId,
    outcome: "committed",
    observedResultDigest: resultDigest,
  });
}

/** Runs one gold-blind case through the current product Memory lexical path. */
export async function evaluateProductLexicalCase(
  input: ProductLexicalCase,
  limit = 10,
): Promise<ProductLexicalResult> {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 20) {
    throw new TypeError("product lexical replay limit must be an integer from 1 through 20");
  }
  const caseDigest = createHash("sha256").update(input.question_id, "utf8").digest("hex");
  const identity: RuntimeMemoryIdentity = {
    instanceId: `longmemeval-${caseDigest.slice(0, 24)}`,
    ownerScopeId: "longmemeval-owner",
    memoryModuleInstanceId: "memory-product-lexical-replay-v0",
    sessionId: `longmemeval-${caseDigest.slice(24, 48)}`,
  };
  const namespace = authenticateNamespace({
    identity,
    inputPageId: "longmemeval-sessions",
    retention: { kind: "session" },
  });
  const authorization: MemoryAuthorization = {
    grants: [{
      namespaceKey: namespace.namespaceKey,
      operations: ["query", "index", "retention-change"],
    }],
  };
  const backgroundAuthorization: MemoryAuthorization = {
    grants: [{ namespaceKey: namespace.namespaceKey, operations: ["query", "index"] }],
  };
  const store = MemoryStore.open(new InMemoryMemoryJournal());
  const extractor = createTextContentExtractor(DOLLY_CONTENT_TEXT_EXTRACTOR_CONTRACT);
  const plan = createFeaturePlan({ extractor: extractor.contract });
  const planDigest = featurePlanDigest(plan);
  const lexicalGeneration = deriveLexicalGeneration({
    namespace,
    plan,
    featurePlanDigest: planDigest,
  });
  const session = store.session(namespace, authorization, "index");
  session.activateGeneration(lexicalGeneration);

  const blockToSession = new Map<string, string>();
  const blocks = new Map<string, MemorySourceBlock>();
  let normalizedInputBytes = 0;
  let coveredNormalizedBytes = 0;
  let truncatedItems = 0;
  const skippedItemsByReason: Record<ExtractionSkipReason, number> = {
    MEMORY_CONTROL_ITEM: 0,
    SCHEMA_NOT_ALLOWLISTED: 0,
    TEXT_INPUT_TOO_LARGE: 0,
    TEXT_EMPTY: 0,
  };
  const inputs = input.sessions.map((source, index) => {
    const sourceBlockId = stableBlockId(input.question_id, source.session_id, index);
    const texts = source.messages.map(messageText);
    const block: MemorySourceBlock = {
      payloadSchema: "dolly.content/1",
      content: { items: texts.map((text) => ({ type: "text" as const, text })) },
    };
    const extraction = extractor.extract({
      sourceBlockId,
      payloadSchema: block.payloadSchema,
      content: block.content,
    });
    for (const skipped of extraction.skipped) {
      skippedItemsByReason[skipped.reason] += 1;
    }
    texts.forEach((text, itemIndex) => {
      const itemBytes = Buffer.byteLength(normalizeExtractedText(text), "utf8");
      normalizedInputBytes += itemBytes;
      const covered = coveredByteCount(
        extraction.segments.filter((segment) => segment.itemIndex === itemIndex),
      );
      coveredNormalizedBytes += covered;
      if (covered > 0 && covered < itemBytes) truncatedItems += 1;
    });
    blockToSession.set(sourceBlockId, source.session_id);
    blocks.set(sourceBlockId, block);
    return delivered(sourceBlockId, block, index + 1);
  });

  const indexing = await runMemoryModuleAction(actionArguments({
    store,
    identity,
    namespace,
    authorization,
    plan,
    planDigest,
    lexicalGeneration,
    inputs,
    moduleJobId: `index-${input.question_id}`,
    runId: `index-${input.question_id}`,
  }));
  settleAction(store, namespace, authorization, indexing.preparation, indexing.resultDigest);

  let leaseOrdinal = 0;
  const blockReader: MemoryBlockReader = {
    acquire: async (request) => {
      const block = blocks.get(request.blockId);
      if (block === undefined) throw new TypeError(`unknown replay Block ${request.blockId}`);
      let released = false;
      return {
        leaseId: request.leaseId,
        blockId: request.blockId,
        block,
        release: () => {
          if (released) return;
          released = true;
        },
      };
    },
  };
  const indexer = new MemoryBackgroundIndexer({
    store,
    namespace,
    authorization: backgroundAuthorization,
    plan,
    featurePlanDigest: planDigest,
    extractor,
    lexicalGeneration,
    blockReader,
    moduleGeneration: 1,
    leaseIds: () => `indexer-${input.question_id}-${++leaseOrdinal}`,
    limits: { maxConcurrency: 1, maxJobsPerDrain: 512, maxSegmentsPerJob: 128 },
  });
  const report = await indexer.drain();
  if (
    report.permanentFailures.length !== 0 ||
    report.cancelled.length !== 0 ||
    report.outstandingLeases !== 0
  ) {
    throw new TypeError(`product lexical replay indexing did not reach a clean fixed point`);
  }

  const queryBlock: MemorySourceBlock = {
    payloadSchema: "dolly.content/1",
    content: {
      items: [{
        type: "data",
        schema: MEMORY_QUERY_SCHEMA,
        value: {
          requestId: `query-${caseDigest.slice(0, 32)}`,
          text: input.question,
          mode: "lexical",
          limit,
          contextExpansion: 0,
        },
      }],
    },
  };
  const queryInput = delivered(
    stableBlockId(input.question_id, "query", input.sessions.length),
    queryBlock,
    input.sessions.length + 1,
  );
  const queried = await runMemoryModuleAction(actionArguments({
    store,
    identity,
    namespace,
    authorization,
    plan,
    planDigest,
    lexicalGeneration,
    inputs: [queryInput],
    moduleJobId: `query-${input.question_id}`,
    runId: `query-${input.question_id}`,
  }));
  settleAction(store, namespace, authorization, queried.preparation, queried.resultDigest);
  const outcome = queried.outcomes[0];
  if (outcome === undefined || outcome.errorCode !== undefined) {
    throw new TypeError(`product lexical replay query failed for ${input.question_id}`);
  }
  const matches = outcome.result?.matches ?? [];
  const queryResult = outcome.result;
  if (
    queryResult === undefined ||
    queryResult.effectiveMode !== "lexical" ||
    queryResult.channels.length !== 1 ||
    queryResult.channels[0]?.channelId !== LEXICAL_CHANNEL_ID ||
    queryResult.snapshot.lexicalGenerationId !== lexicalGeneration.generationId ||
    queryResult.snapshot.coverage.length !== 1
  ) {
    throw new TypeError(`product lexical replay query used an unexpected retrieval profile`);
  }
  const records = session.records();
  const features = session.features();
  const jobs = session.featureJobs();
  const countJobs = (state: (typeof jobs)[number]["state"]): number =>
    jobs.filter((job) => job.state === state).length;
  const ranking = matches.map((match, index): ProductLexicalRank => {
    const sessionId = blockToSession.get(match.sourceBlockId);
    if (sessionId === undefined) {
      throw new TypeError(`ranked record refers to unknown replay Block ${match.sourceBlockId}`);
    }
    const lexicalScore = match.scores.find((score) => score.channelId === LEXICAL_CHANNEL_ID);
    if (
      match.rank !== index + 1 ||
      lexicalScore === undefined ||
      lexicalScore.rank < 1 ||
      !Number.isFinite(lexicalScore.raw)
    ) {
      throw new TypeError(`product lexical replay returned an invalid lexical rank`);
    }
    return Object.freeze({
      rank: match.rank,
      recordId: match.recordId,
      sourceBlockId: match.sourceBlockId,
      sessionId,
      rawBm25: lexicalScore.raw,
    });
  });
  const uncoveredNormalizedBytes = normalizedInputBytes - coveredNormalizedBytes;
  const queryCoverage = queryResult.snapshot.coverage[0]!;
  return Object.freeze({
    questionId: input.question_id,
    lexicalGeneration,
    effectiveMode: "lexical" as const,
    channelIds: Object.freeze(queryResult.channels.map((channel) => channel.channelId)),
    ranking: Object.freeze(ranking),
    inputCounts: Object.freeze({
      sessions: input.sessions.length,
      messages: input.sessions.reduce((total, source) => total + source.messages.length, 0),
      emptySessions: input.sessions.filter((source) => source.messages.length === 0).length,
    }),
    extractionCoverage: Object.freeze({
      normalizedInputBytes,
      coveredNormalizedBytes,
      uncoveredNormalizedBytes,
      truncatedItems,
      skippedItemsByReason: Object.freeze({ ...skippedItemsByReason }),
      complete:
        uncoveredNormalizedBytes === 0 &&
        truncatedItems === 0 &&
        skippedItemsByReason.MEMORY_CONTROL_ITEM === 0 &&
        skippedItemsByReason.SCHEMA_NOT_ALLOWLISTED === 0 &&
        skippedItemsByReason.TEXT_INPUT_TOO_LARGE === 0,
    }),
    terminalJobAccounting: Object.freeze({
      pending: countJobs("pending"),
      running: countJobs("running"),
      retryable: countJobs("retryable"),
      succeeded: countJobs("succeeded"),
      skipped: countJobs("skipped"),
      permanentFailure: countJobs("permanent-failure"),
      cancelled: countJobs("cancelled"),
      outstandingLeases: report.outstandingLeases,
      maxObservedConcurrency: report.maxObservedConcurrency,
    }),
    queryCoverage,
    recordCount: records.length,
    featureCount: features.length,
    canonicalRecordBytes: records.reduce(
      (total, record) => total + canonicalJsonByteLength(record as never),
      0,
    ),
    canonicalFeatureBytes: features.reduce(
      (total, feature) => total + canonicalJsonByteLength(feature as never),
      0,
    ),
  });
}
