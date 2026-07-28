import { canonicalJsonDigest, deepFreeze } from "../../core/canonical-json.js";
import { vectorSpaceKey, type MemoryVectorSpace } from "./embedding-capability.js";
import { memoryError } from "./errors.js";
import type { FeaturePlan } from "./feature-plan.js";
import type { MemoryNamespace } from "./namespace.js";

/**
 * IndexGeneration identity from `docs/spec/memory-extension.md` §5.4 and §9.4.
 *
 * A generation is an immutable compatibility boundary. Its ID is a digest of
 * every property §9.4 lists as an incompatible change, so two configurations
 * that differ in any of them cannot collide on one identity and therefore
 * cannot share an index or have their raw scores compared.
 */

export type MemoryIndexKind = "lexical" | "vector";

/** BM25 with declared parameters; part of the lexical generation identity. */
export const LEXICAL_ALGORITHM_ID = "dolly.memory.bm25";
export const LEXICAL_ALGORITHM_VERSION = "1";
export const LEXICAL_ALGORITHM_PARAMETERS = deepFreeze({ k1: 1.2, b: 0.75 });

/** Exact nearest-neighbour scan; part of the vector generation identity. */
export const VECTOR_ALGORITHM_ID = "dolly.memory.exact-scan";
export const VECTOR_ALGORITHM_VERSION = "1";

export interface DescriptorIdentity {
  readonly endpointId: string;
  readonly modelId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly descriptorVersion: string;
  readonly descriptorDigest: string;
}

export interface IndexGeneration {
  readonly generationId: string;
  readonly namespaceKey: string;
  readonly indexKind: MemoryIndexKind;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly algorithmId: string;
  readonly algorithmVersion: string;
  readonly algorithmParameters: Readonly<Record<string, number>>;
  readonly featurePlanDigest: string;
  /** Vector generations only. */
  readonly vectorSpace?: MemoryVectorSpace;
  readonly descriptor?: DescriptorIdentity;
  /** Vector generations only: what was embedded, for §9.3 provenance. */
  readonly sourceModality?: string;
  readonly derivedTextTransformationId?: string;
}

function generationId(fields: Record<string, unknown>): string {
  return canonicalJsonDigest(fields as never);
}

export function deriveLexicalGeneration(options: {
  readonly namespace: MemoryNamespace;
  readonly plan: FeaturePlan;
  readonly featurePlanDigest: string;
}): IndexGeneration {
  const fields = {
    domain: "dolly.memory-index-generation/1",
    namespaceKey: options.namespace.namespaceKey,
    indexKind: "lexical",
    extractorId: options.plan.extractorId,
    extractorVersion: options.plan.extractorVersion,
    analyzerId: options.plan.analyzerId,
    analyzerVersion: options.plan.analyzerVersion,
    algorithmId: LEXICAL_ALGORITHM_ID,
    algorithmVersion: LEXICAL_ALGORITHM_VERSION,
    algorithmParameters: { ...LEXICAL_ALGORITHM_PARAMETERS },
    featurePlanDigest: options.featurePlanDigest,
  };
  return deepFreeze({
    generationId: generationId(fields),
    namespaceKey: options.namespace.namespaceKey,
    indexKind: "lexical" as const,
    extractorId: options.plan.extractorId,
    extractorVersion: options.plan.extractorVersion,
    analyzerId: options.plan.analyzerId,
    analyzerVersion: options.plan.analyzerVersion,
    algorithmId: LEXICAL_ALGORITHM_ID,
    algorithmVersion: LEXICAL_ALGORITHM_VERSION,
    algorithmParameters: { ...LEXICAL_ALGORITHM_PARAMETERS },
    featurePlanDigest: options.featurePlanDigest,
  });
}

export function deriveVectorGeneration(options: {
  readonly namespace: MemoryNamespace;
  readonly plan: FeaturePlan;
  readonly featurePlanDigest: string;
  readonly sourceModality: string;
  readonly derivedTextTransformationId?: string;
}): IndexGeneration {
  const embedding = options.plan.textEmbedding;
  if (!embedding) {
    throw memoryError(
      "MEMORY_VECTOR_UNAVAILABLE",
      "A vector generation requires a configured embedding descriptor",
    );
  }
  const descriptor: DescriptorIdentity = {
    endpointId: embedding.endpointId,
    modelId: embedding.modelId,
    adapterId: embedding.adapterId,
    adapterVersion: embedding.adapterVersion,
    descriptorVersion: embedding.descriptorVersion,
    descriptorDigest: embedding.descriptorDigest,
  };
  const fields = {
    domain: "dolly.memory-index-generation/1",
    namespaceKey: options.namespace.namespaceKey,
    indexKind: "vector",
    extractorId: options.plan.extractorId,
    extractorVersion: options.plan.extractorVersion,
    analyzerId: options.plan.analyzerId,
    analyzerVersion: options.plan.analyzerVersion,
    algorithmId: VECTOR_ALGORITHM_ID,
    algorithmVersion: VECTOR_ALGORITHM_VERSION,
    algorithmParameters: {},
    featurePlanDigest: options.featurePlanDigest,
    descriptor,
    vectorSpace: vectorSpaceKey(embedding.vectorSpace),
    sourceModality: options.sourceModality,
    derivedTextTransformationId: options.derivedTextTransformationId ?? null,
  };
  return deepFreeze({
    generationId: generationId(fields),
    namespaceKey: options.namespace.namespaceKey,
    indexKind: "vector" as const,
    extractorId: options.plan.extractorId,
    extractorVersion: options.plan.extractorVersion,
    analyzerId: options.plan.analyzerId,
    analyzerVersion: options.plan.analyzerVersion,
    algorithmId: VECTOR_ALGORITHM_ID,
    algorithmVersion: VECTOR_ALGORITHM_VERSION,
    algorithmParameters: {},
    featurePlanDigest: options.featurePlanDigest,
    vectorSpace: embedding.vectorSpace,
    descriptor,
    sourceModality: options.sourceModality,
    ...(options.derivedTextTransformationId === undefined
      ? {}
      : { derivedTextTransformationId: options.derivedTextTransformationId }),
  });
}

/**
 * §9.4: a feature may enter an index only when it was produced under that exact
 * generation. This is the single admission gate for both indexes.
 */
export function assertGenerationAccepts(
  generation: IndexGeneration,
  feature: {
    readonly namespaceKey: string;
    readonly generationId: string;
    readonly vectorSpace?: MemoryVectorSpace;
  },
  subject: string,
): void {
  if (feature.namespaceKey !== generation.namespaceKey) {
    throw memoryError(
      "MEMORY_NAMESPACE_MISMATCH",
      `${subject} belongs to a different Memory namespace`,
      { subject },
    );
  }
  if (feature.generationId !== generation.generationId) {
    throw memoryError(
      "MEMORY_GENERATION_INCOMPATIBLE",
      `${subject} was produced under a different index generation`,
      { subject, expected: generation.generationId, received: feature.generationId },
    );
  }
  if (generation.vectorSpace && feature.vectorSpace) {
    if (vectorSpaceKey(generation.vectorSpace) !== vectorSpaceKey(feature.vectorSpace)) {
      throw memoryError(
        "MEMORY_VECTOR_SPACE_INCOMPATIBLE",
        `${subject} uses a vector space this generation does not index`,
        { subject },
      );
    }
  }
}

/**
 * §9.4: raw scores from two generations are never merged as if they shared a
 * scale. Callers that want to combine channels must first prove the channels
 * come from one generation, or use a rank-based fusion that never adds raw
 * numbers (§10.2).
 */
export function assertComparableRawScores(
  left: IndexGeneration,
  right: IndexGeneration,
): void {
  if (left.generationId !== right.generationId) {
    throw memoryError(
      "MEMORY_GENERATION_INCOMPATIBLE",
      "Raw scores from two index generations are not comparable",
      { left: left.generationId, right: right.generationId },
    );
  }
}
