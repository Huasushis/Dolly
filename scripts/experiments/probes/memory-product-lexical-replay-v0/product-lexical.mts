import { createHash } from "node:crypto";
import { canonicalJsonByteLength } from "../../../../src/core/canonical-json.js";
import {
  DOLLY_CONTENT_TEXT_EXTRACTOR_CONTRACT,
  InMemoryMemoryJournal,
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
  type DeliveredInput,
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
  /** Record ranks mapped to sessions after truncation; duplicates are retained. */
  readonly sessionIds: readonly string[];
  readonly recordIds: readonly string[];
  readonly recordCount: number;
  readonly featureCount: number;
  readonly canonicalFeatureBytes: number;
  readonly normalizedSourceBytes: number;
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
  let normalizedSourceBytes = 0;
  const inputs = input.sessions.map((source, index) => {
    const sourceBlockId = stableBlockId(input.question_id, source.session_id, index);
    const texts = source.messages.map(messageText);
    normalizedSourceBytes += texts.reduce(
      (total, text) => total + Buffer.byteLength(normalizeExtractedText(text), "utf8"),
      0,
    );
    const block: MemorySourceBlock = {
      payloadSchema: "dolly.content/1",
      content: { items: texts.map((text) => ({ type: "text" as const, text })) },
    };
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
  const records = session.records();
  const features = session.features();
  return Object.freeze({
    questionId: input.question_id,
    sessionIds: Object.freeze(matches.map((match) => {
      const sessionId = blockToSession.get(match.sourceBlockId);
      if (sessionId === undefined) {
        throw new TypeError(`ranked record refers to unknown replay Block ${match.sourceBlockId}`);
      }
      return sessionId;
    })),
    recordIds: Object.freeze(matches.map((match) => match.recordId)),
    recordCount: records.length,
    featureCount: features.length,
    canonicalFeatureBytes: features.reduce(
      (total, feature) => total + canonicalJsonByteLength(feature as never),
      0,
    ),
    normalizedSourceBytes,
  });
}
