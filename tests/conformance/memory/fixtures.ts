import type { BlockContent } from "../../../src/core/block-content.js";
import {
  EmbeddingDescriptorRegistry,
  type EmbeddingDescriptorDocument,
  type EmbeddingDescriptorSnapshot,
} from "../../../src/core/model-provider-embedding.js";
import {
  EMBEDDING_STRATEGIES,
  nativeVlEmbeddingDescriptor,
  textEmbeddingDescriptor,
} from "../model-provider/fixtures.js";
import type { DeliveredInput } from "../../../src/extensions/memory/admission.js";
import type {
  MemoryBlockLease,
  MemoryBlockReader,
} from "../../../src/extensions/memory/background-indexer.js";
import {
  resolveMemoryEmbeddingCapability,
  type MemoryEmbeddingCapability,
  type MemoryEmbeddingItem,
  type MemoryEmbeddingOperation,
  type MemoryEmbeddingOutcome,
} from "../../../src/extensions/memory/embedding-capability.js";
import {
  DOLLY_CONTENT_TEXT_EXTRACTOR_CONTRACT,
  createTextContentExtractor,
  MEMORY_QUERY_SCHEMA,
  type MemorySourceBlock,
} from "../../../src/extensions/memory/extraction.js";
import {
  createFeaturePlan,
  featurePlanDigest,
  type FeaturePlan,
  type MediaModalityPolicy,
} from "../../../src/extensions/memory/feature-plan.js";
import {
  deriveLexicalGeneration,
  deriveVectorGeneration,
  type IndexGeneration,
} from "../../../src/extensions/memory/index-generation.js";
import {
  authenticateNamespace,
  type MemoryAuthorization,
  type MemoryNamespace,
  type MemoryOperation,
  type RetentionScopeSelection,
  type RuntimeMemoryIdentity,
} from "../../../src/extensions/memory/namespace.js";
import {
  InMemoryMemoryJournal,
  MemoryStore,
  type MemoryEvent,
  type MemoryJournal,
} from "../../../src/extensions/memory/store.js";
import {
  MemoryBackgroundIndexer,
  type IndexerReport,
} from "../../../src/extensions/memory/background-indexer.js";
import {
  runMemoryModuleAction,
  type MemoryActionResult,
} from "../../../src/extensions/memory/module-action.js";
import type { ThresholdProfile } from "../../../src/extensions/memory/retrieval.js";

/**
 * Deterministic fixtures for the Memory conformance suite.
 *
 * Everything here is fake and local: fake identities, a fake journal, a fake
 * Block reader, and a fake embedding operation whose vectors are a pure
 * function of the input text. No network, no API key, no provider, and no
 * clock. §16 requires exactly that.
 */

export const SCHEMA_DIGEST = `sha256:${"0".repeat(64)}`;

export function identity(
  overrides: Partial<RuntimeMemoryIdentity> = {},
): RuntimeMemoryIdentity {
  return {
    instanceId: "instance-a",
    ownerScopeId: "owner-a",
    memoryModuleInstanceId: "memory-a",
    sessionId: "session-1",
    ...overrides,
  };
}

export function namespaceFor(options: {
  readonly identity?: RuntimeMemoryIdentity;
  readonly inputPageId?: string;
  readonly retention?: RetentionScopeSelection;
} = {}): MemoryNamespace {
  return authenticateNamespace({
    identity: options.identity ?? identity(),
    inputPageId: options.inputPageId ?? "page-main",
    retention: options.retention ?? { kind: "session" },
  });
}

export const ALL_OPERATIONS: readonly MemoryOperation[] = [
  "query",
  "index",
  "delete",
  "export",
  "reindex",
  "retention-change",
];

export function grantAll(...namespaces: readonly MemoryNamespace[]): MemoryAuthorization {
  return {
    grants: namespaces.map((namespace) => ({
      namespaceKey: namespace.namespaceKey,
      operations: ALL_OPERATIONS,
    })),
  };
}

/** The authorization the background indexer is expected to hold (§6.2). */
export function grantBackground(namespace: MemoryNamespace): MemoryAuthorization {
  return {
    grants: [{ namespaceKey: namespace.namespaceKey, operations: ["query", "index"] }],
  };
}

/**
 * A journal that can fail one append, simulating a crash before the durable
 * write reached storage. Events already appended survive, which is what makes
 * `MemoryStore.open` a real recovery test rather than a fresh start.
 */
export class CrashingJournal implements MemoryJournal {
  readonly #inner = new InMemoryMemoryJournal();
  #failFromAppend: number | undefined;
  #appends = 0;

  /**
   * Every append from `ordinal` onwards fails. This models process death
   * rather than one recoverable write error: once storage stops accepting
   * writes, the settlement path cannot record anything either, so the failure
   * escapes the worker exactly as a crash would.
   */
  failFromAppend(ordinal: number): void {
    this.#failFromAppend = ordinal;
  }

  clearFault(): void {
    this.#failFromAppend = undefined;
  }

  get appendCount(): number {
    return this.#appends;
  }

  append(events: readonly MemoryEvent[]): void {
    this.#appends += 1;
    if (this.#failFromAppend !== undefined && this.#appends >= this.#failFromAppend) {
      throw new Error("injected crash before durable append");
    }
    this.#inner.append(events);
  }

  read(): readonly MemoryEvent[] {
    return this.#inner.read();
  }
}

export function textBlock(...texts: readonly string[]): MemorySourceBlock {
  return {
    payloadSchema: "dolly.content/1",
    content: { items: texts.map((text) => ({ type: "text" as const, text })) },
  };
}

export function queryBlock(value: Record<string, unknown>): MemorySourceBlock {
  return {
    payloadSchema: "dolly.content/1",
    content: {
      items: [
        { type: "data" as const, schema: MEMORY_QUERY_SCHEMA, value: value as never },
      ],
    },
  };
}

export function blockWith(content: BlockContent): MemorySourceBlock {
  return { payloadSchema: "dolly.content/1", content };
}

export function delivered(options: {
  readonly deliveryId: string;
  readonly sourceBlockId: string;
  readonly block: MemorySourceBlock;
  readonly inputPageId?: string;
  readonly pageSequence?: number;
  readonly coreSequence?: number;
  readonly sourceModuleInstanceId?: string;
}): DeliveredInput {
  return {
    delivery: {
      deliveryId: options.deliveryId,
      inputPageId: options.inputPageId ?? "page-main",
      pageSequence: options.pageSequence ?? 1,
      sourceBlockId: options.sourceBlockId,
      coreSequence: options.coreSequence ?? options.pageSequence ?? 1,
      sourceModuleInstanceId: options.sourceModuleInstanceId ?? "console-a",
    },
    block: options.block,
  };
}

function snapshotOf(document: EmbeddingDescriptorDocument): EmbeddingDescriptorSnapshot {
  const registry = new EmbeddingDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: [...EMBEDDING_STRATEGIES],
  });
  const ref = registry.register(document);
  registry.setStatus(ref, "active");
  return registry.snapshot(ref);
}

/**
 * A text-only descriptor whose model ID reads like a vision model. §9.1 forbids
 * inferring modality from a name, so a conforming implementation must treat it
 * as text-only despite `vl` in the model ID.
 */
export function textOnlySnapshot(
  options: { readonly modelId?: string; readonly vectorSpaceId?: string } = {},
): EmbeddingDescriptorSnapshot {
  return snapshotOf(
    textEmbeddingDescriptor({
      modelId: options.modelId ?? "qwen-vl-plus-embedding",
      dimensions: { kind: "fixed", value: 16 },
      ...(options.vectorSpaceId === undefined
        ? {}
        : { vectorSpaceId: options.vectorSpaceId }),
    }),
  );
}

/** A descriptor that declares native image input and a shared vector space. */
export function nativeImageSnapshot(): EmbeddingDescriptorSnapshot {
  return snapshotOf(nativeVlEmbeddingDescriptor({}));
}

/** A descriptor that accepts image input but declares no shared space. */
export function separateSpaceImageSnapshot(): EmbeddingDescriptorSnapshot {
  return snapshotOf(nativeVlEmbeddingDescriptor({ comparableModalitySets: [] }));
}

export function textOnlyCapability(
  options: { readonly modelId?: string; readonly vectorSpaceId?: string } = {},
): MemoryEmbeddingCapability {
  return resolveMemoryEmbeddingCapability(textOnlySnapshot(options));
}

/**
 * A deterministic fake embedding. §9.3 requires a fake to identify a fake
 * endpoint and model in provenance; the capability carries the fixture
 * descriptor's own `endpointId` and `modelId`, so every stored vector says
 * exactly which descriptor produced it.
 */
export function fakeVector(text: string, dimension: number): readonly number[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const vector = new Array<number>(dimension).fill(0);
  for (const token of tokens) {
    let hash = 0;
    for (const character of token) {
      hash = (hash * 31 + character.codePointAt(0)!) % 1_000_003;
    }
    vector[hash % dimension] += 1;
  }
  return vector;
}

export class FakeEmbeddingOperation implements MemoryEmbeddingOperation {
  readonly capability: MemoryEmbeddingCapability;
  readonly calls: MemoryEmbeddingItem[][] = [];
  #failures = new Map<string, string>();
  #dropItemIds = new Set<string>();

  constructor(capability: MemoryEmbeddingCapability) {
    this.capability = capability;
  }

  failItem(itemId: string, errorCode: string): void {
    this.#failures.set(itemId, errorCode);
  }

  dropItem(itemId: string): void {
    this.#dropItemIds.add(itemId);
  }

  async embed(items: readonly MemoryEmbeddingItem[]): Promise<readonly MemoryEmbeddingOutcome[]> {
    this.calls.push([...items]);
    const outcomes: MemoryEmbeddingOutcome[] = [];
    for (const item of items) {
      if (this.#dropItemIds.has(item.itemId)) continue;
      const failure = this.#failures.get(item.itemId);
      if (failure !== undefined) {
        outcomes.push({
          itemId: item.itemId,
          status: "failed",
          errorCode: failure,
          retryable: false,
        });
        continue;
      }
      if (item.kind !== "text") {
        throw new Error("fixture embedding accepts text items only");
      }
      outcomes.push({
        itemId: item.itemId,
        status: "succeeded",
        vector: fakeVector(item.text, this.capability.vectorSpace.dimension),
      });
    }
    return outcomes;
  }
}

/** Tracks lease balance so a missing release becomes a failing assertion. */
export class FakeBlockReader implements MemoryBlockReader {
  readonly acquired: string[] = [];
  readonly released: string[] = [];
  #blocks: Map<string, MemorySourceBlock>;
  #failFor = new Set<string>();

  constructor(blocks: ReadonlyMap<string, MemorySourceBlock>) {
    this.#blocks = new Map(blocks);
  }

  failFor(blockId: string): void {
    this.#failFor.add(blockId);
  }

  get outstanding(): number {
    return this.acquired.length - this.released.length;
  }

  async acquire(request: {
    readonly blockId: string;
    readonly leaseId: string;
    readonly featureJobId: string;
    readonly moduleGeneration: number;
  }): Promise<MemoryBlockLease> {
    if (this.#failFor.has(request.blockId)) {
      throw new Error(`injected read failure for ${request.blockId}`);
    }
    const block = this.#blocks.get(request.blockId);
    if (!block) throw new Error(`fixture has no block ${request.blockId}`);
    this.acquired.push(request.leaseId);
    const released = this.released;
    return {
      leaseId: request.leaseId,
      blockId: request.blockId,
      block,
      release(): void {
        released.push(request.leaseId);
      },
    };
  }
}

export function leaseIdFactory(prefix = "lease"): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

export interface Harness {
  readonly namespace: MemoryNamespace;
  readonly identity: RuntimeMemoryIdentity;
  readonly authorization: MemoryAuthorization;
  readonly journal: CrashingJournal;
  readonly store: MemoryStore;
  readonly plan: FeaturePlan;
  readonly planDigest: string;
  readonly extractor: ReturnType<typeof createTextContentExtractor>;
  readonly lexicalGeneration: IndexGeneration;
  readonly vectorGeneration?: IndexGeneration;
  readonly embedding?: FakeEmbeddingOperation;
}

export function harness(options: {
  readonly namespace?: MemoryNamespace;
  readonly identity?: RuntimeMemoryIdentity;
  readonly withEmbedding?: boolean;
  readonly embeddingCapability?: MemoryEmbeddingCapability;
  readonly mediaPolicies?: readonly {
    readonly modality: string;
    readonly policy: MediaModalityPolicy;
  }[];
  readonly journal?: CrashingJournal;
  readonly extractorVersion?: string;
  readonly store?: MemoryStore;
} = {}): Harness {
  const runtimeIdentity = options.identity ?? identity();
  const namespace = options.namespace ?? namespaceFor({ identity: runtimeIdentity });
  const journal = options.journal ?? new CrashingJournal();
  const store = options.store ?? MemoryStore.open(journal);
  const extractor = createTextContentExtractor(
    options.extractorVersion === undefined
      ? undefined
      : {
          ...DOLLY_CONTENT_TEXT_EXTRACTOR_CONTRACT,
          extractorVersion: options.extractorVersion,
        },
  );
  const capability =
    options.embeddingCapability ?? (options.withEmbedding === true ? textOnlyCapability() : undefined);
  const plan = createFeaturePlan({
    extractor: extractor.contract,
    ...(capability === undefined ? {} : { embedding: capability }),
    ...(options.mediaPolicies === undefined ? {} : { mediaPolicies: options.mediaPolicies }),
  });
  const planDigest = featurePlanDigest(plan);
  const lexicalGeneration = deriveLexicalGeneration({ namespace, plan, featurePlanDigest: planDigest });
  const vectorGeneration = capability
    ? deriveVectorGeneration({
        namespace,
        plan,
        featurePlanDigest: planDigest,
        sourceModality: "text",
      })
    : undefined;
  const authorization = grantAll(namespace);
  const session = store.session(namespace, authorization, "index");
  session.activateGeneration(lexicalGeneration);
  if (vectorGeneration) session.activateGeneration(vectorGeneration);
  return {
    namespace,
    identity: runtimeIdentity,
    authorization,
    journal,
    store,
    plan,
    planDigest,
    extractor,
    lexicalGeneration,
    ...(vectorGeneration === undefined ? {} : { vectorGeneration }),
    ...(capability === undefined ? {} : { embedding: new FakeEmbeddingOperation(capability) }),
  };
}

export function readerFor(inputs: readonly DeliveredInput[]): FakeBlockReader {
  return new FakeBlockReader(
    new Map(inputs.map((input) => [input.delivery.sourceBlockId, input.block])),
  );
}

export function indexerFor(
  h: Harness,
  reader: FakeBlockReader,
  options: {
    readonly moduleGeneration?: number;
    readonly maxConcurrency?: number;
    readonly leaseIds?: () => string;
    readonly mediaModalities?: { modalityOf(mediaId: string): string | undefined };
    readonly store?: MemoryStore;
  } = {},
): MemoryBackgroundIndexer {
  return new MemoryBackgroundIndexer({
    store: options.store ?? h.store,
    namespace: h.namespace,
    // §6.2: the background service holds `index` and `query` only. It cannot
    // remove a Core strong reference, and the tests rely on that failing.
    authorization: grantBackground(h.namespace),
    plan: h.plan,
    featurePlanDigest: h.planDigest,
    extractor: h.extractor,
    lexicalGeneration: h.lexicalGeneration,
    ...(h.vectorGeneration === undefined ? {} : { vectorGeneration: h.vectorGeneration }),
    ...(h.embedding === undefined ? {} : { embedding: h.embedding }),
    blockReader: reader,
    ...(options.mediaModalities === undefined
      ? {}
      : { mediaModalities: options.mediaModalities }),
    moduleGeneration: options.moduleGeneration ?? 1,
    leaseIds: options.leaseIds ?? leaseIdFactory(),
    limits: { maxConcurrency: options.maxConcurrency ?? 2 },
  });
}

/** Runs one serialized action and commits its admission, as the Core would. */
export async function runAction(
  h: Harness,
  inputs: readonly DeliveredInput[],
  options: {
    readonly moduleJobId?: string;
    readonly moduleGeneration?: number;
    readonly commit?: boolean;
    readonly thresholdProfile?: ThresholdProfile;
    readonly tick?: number;
  } = {},
): Promise<MemoryActionResult> {
  const result = await runMemoryModuleAction({
    store: h.store,
    identity: h.identity,
    namespace: h.namespace,
    authorization: h.authorization,
    moduleJobId: options.moduleJobId ?? "job-1",
    moduleGeneration: options.moduleGeneration ?? 1,
    runId: "run-1",
    inputs,
    plan: h.plan,
    featurePlanDigest: h.planDigest,
    acceptedPayloadSchemas: ["dolly.content/1"],
    lexicalGeneration: h.lexicalGeneration,
    ...(h.vectorGeneration === undefined ? {} : { vectorGeneration: h.vectorGeneration }),
    thresholdProfile: options.thresholdProfile ?? EMPTY_THRESHOLDS,
    deletionEpoch: 0,
    maxAttempts: 3,
    tick: options.tick ?? 0,
    leaseIds: leaseIdFactory("read-lease"),
  });
  if (options.commit !== false) {
    h.store
      .session(h.namespace, h.authorization, "index")
      .settleAdmission({
        admissionId: result.preparation.admission.admissionId,
        outcome: "committed",
        observedResultDigest: result.resultDigest,
      });
  }
  return result;
}

export const EMPTY_THRESHOLDS: ThresholdProfile = {
  profileId: "fixture.no-threshold",
  version: "1",
  rules: [],
};

/** Action, commit, then drain the background indexer to a fixed point. */
export async function indexInputs(
  h: Harness,
  inputs: readonly DeliveredInput[],
  options: {
    readonly moduleJobId?: string;
    readonly reader?: FakeBlockReader;
    readonly maxConcurrency?: number;
    readonly mediaModalities?: { modalityOf(mediaId: string): string | undefined };
  } = {},
): Promise<{
  readonly action: MemoryActionResult;
  readonly report: IndexerReport;
  readonly indexer: MemoryBackgroundIndexer;
  readonly reader: FakeBlockReader;
}> {
  const reader = options.reader ?? readerFor(inputs);
  const action = await runAction(h, inputs, {
    ...(options.moduleJobId === undefined ? {} : { moduleJobId: options.moduleJobId }),
  });
  const indexer = indexerFor(h, reader, {
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
    ...(options.mediaModalities === undefined
      ? {}
      : { mediaModalities: options.mediaModalities }),
  });
  const report = await indexer.drain();
  return { action, report, indexer, reader };
}
