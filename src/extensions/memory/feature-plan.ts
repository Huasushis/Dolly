import { canonicalJsonDigest, deepFreeze } from "../../core/canonical-json.js";
import {
  assertModalitySupported,
  vectorSpaceKey,
  type MemoryEmbeddingCapability,
  type MemoryVectorSpace,
} from "./embedding-capability.js";
import { memoryError } from "./errors.js";
import {
  LEXICAL_ANALYZER_ID,
  LEXICAL_ANALYZER_VERSION,
  type TextExtractorContract,
} from "./extraction.js";

/**
 * The feature plan from `docs/spec/memory-extension.md` §5.1 and §8.3.
 *
 * The plan is the complete, finite set of features one record may carry. Its
 * digest participates in the admission and job identities (§5.5), so changing
 * an extractor, an analyzer, an embedding descriptor, or a media policy creates
 * new work rather than silently reinterpreting committed work.
 */

export type MediaModalityPolicy =
  | { readonly kind: "skip" }
  | { readonly kind: "native-embedding" }
  | {
      readonly kind: "derived-text";
      /** A separately configured transformation capability (§8.3). */
      readonly transformationId: string;
      readonly transformationVersion: string;
      readonly transformationDescriptorDigest: string;
    }
  | { readonly kind: "metadata-only"; readonly allowlistedFields: readonly string[] };

export interface TextEmbeddingPlan {
  readonly endpointId: string;
  readonly modelId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly descriptorVersion: string;
  readonly descriptorDigest: string;
  readonly vectorSpace: MemoryVectorSpace;
}

export interface FeaturePlan {
  readonly schemaVersion: "dolly.memory-feature-plan/1";
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  /** Absent for a lexical-only deployment, which §9.2 fully supports. */
  readonly textEmbedding?: TextEmbeddingPlan;
  /** Exactly one policy per configured modality; there is no default. */
  readonly mediaPolicies: readonly { readonly modality: string; readonly policy: MediaModalityPolicy }[];
  readonly maxFeaturesPerRecord: number;
  readonly maxSegmentsPerBlock: number;
}

export interface FeaturePlanInput {
  readonly extractor: TextExtractorContract;
  readonly embedding?: MemoryEmbeddingCapability;
  readonly mediaPolicies?: readonly {
    readonly modality: string;
    readonly policy: MediaModalityPolicy;
  }[];
  readonly maxFeaturesPerRecord?: number;
  readonly maxSegmentsPerBlock?: number;
}

export const DEFAULT_MAX_FEATURES_PER_RECORD = 4;
export const DEFAULT_MAX_SEGMENTS_PER_BLOCK = 128;

/**
 * Builds the plan and validates it against the descriptor.
 *
 * §8.3 has no implicit fallback order: a `native-embedding` policy for a
 * modality the descriptor does not accept is a configuration error here, at
 * plan construction, rather than a runtime decision to substitute OCR, a
 * caption, a hash, a zero vector, or a mock.
 */
export function createFeaturePlan(input: FeaturePlanInput): FeaturePlan {
  const mediaPolicies = [...(input.mediaPolicies ?? [])].sort((left, right) =>
    left.modality < right.modality ? -1 : left.modality > right.modality ? 1 : 0,
  );
  const seen = new Set<string>();
  for (const entry of mediaPolicies) {
    if (seen.has(entry.modality)) {
      throw memoryError(
        "MEMORY_CONFIG_INVALID",
        "A modality has more than one media policy",
        { modality: entry.modality },
      );
    }
    seen.add(entry.modality);
    if (entry.policy.kind === "native-embedding") {
      if (!input.embedding) {
        throw memoryError(
          "MEMORY_CONFIG_INVALID",
          "Native media embedding requires a configured embedding descriptor",
          { modality: entry.modality },
        );
      }
      // Throws MEMORY_MODALITY_UNSUPPORTED when the descriptor does not accept
      // the modality. Selecting native image embedding against a text-only
      // descriptor is an error, not a reason to substitute something else.
      assertModalitySupported(input.embedding, entry.modality);
    }
    if (entry.policy.kind === "metadata-only" && entry.policy.allowlistedFields.length === 0) {
      throw memoryError(
        "MEMORY_CONFIG_INVALID",
        "A metadata-only policy must allowlist at least one non-content field",
        { modality: entry.modality },
      );
    }
  }

  if (input.embedding && !input.embedding.supportsText) {
    throw memoryError(
      "MEMORY_MODALITY_UNSUPPORTED",
      "The configured embedding descriptor does not accept text items",
      { endpointId: input.embedding.endpointId, modelId: input.embedding.modelId },
    );
  }

  const plan: FeaturePlan = {
    schemaVersion: "dolly.memory-feature-plan/1",
    extractorId: input.extractor.extractorId,
    extractorVersion: input.extractor.extractorVersion,
    analyzerId: LEXICAL_ANALYZER_ID,
    analyzerVersion: LEXICAL_ANALYZER_VERSION,
    ...(input.embedding
      ? {
          textEmbedding: {
            endpointId: input.embedding.endpointId,
            modelId: input.embedding.modelId,
            adapterId: input.embedding.adapterId,
            adapterVersion: input.embedding.adapterVersion,
            descriptorVersion: input.embedding.descriptorVersion,
            descriptorDigest: input.embedding.descriptorDigest,
            vectorSpace: input.embedding.vectorSpace,
          },
        }
      : {}),
    mediaPolicies,
    maxFeaturesPerRecord: input.maxFeaturesPerRecord ?? DEFAULT_MAX_FEATURES_PER_RECORD,
    maxSegmentsPerBlock: input.maxSegmentsPerBlock ?? DEFAULT_MAX_SEGMENTS_PER_BLOCK,
  };
  for (const [label, value] of [
    ["maxFeaturesPerRecord", plan.maxFeaturesPerRecord],
    ["maxSegmentsPerBlock", plan.maxSegmentsPerBlock],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw memoryError("MEMORY_CONFIG_INVALID", `${label} must be a positive safe integer`, {
        limit: label,
      });
    }
  }
  return deepFreeze(plan);
}

export function featurePlanDigest(plan: FeaturePlan): string {
  return canonicalJsonDigest({
    schemaVersion: plan.schemaVersion,
    extractorId: plan.extractorId,
    extractorVersion: plan.extractorVersion,
    analyzerId: plan.analyzerId,
    analyzerVersion: plan.analyzerVersion,
    textEmbedding: plan.textEmbedding
      ? {
          endpointId: plan.textEmbedding.endpointId,
          modelId: plan.textEmbedding.modelId,
          adapterId: plan.textEmbedding.adapterId,
          adapterVersion: plan.textEmbedding.adapterVersion,
          descriptorVersion: plan.textEmbedding.descriptorVersion,
          descriptorDigest: plan.textEmbedding.descriptorDigest,
          vectorSpace: vectorSpaceKey(plan.textEmbedding.vectorSpace),
        }
      : null,
    mediaPolicies: plan.mediaPolicies.map((entry) => ({
      modality: entry.modality,
      policy: entry.policy,
    })),
    maxFeaturesPerRecord: plan.maxFeaturesPerRecord,
    maxSegmentsPerBlock: plan.maxSegmentsPerBlock,
  });
}

export type MediaFeatureDecision =
  | { readonly kind: "skip"; readonly reason: "MODALITY_SKIPPED" }
  | { readonly kind: "native-embedding"; readonly modality: string }
  | {
      readonly kind: "derived-text";
      readonly modality: string;
      readonly transformationId: string;
      readonly transformationVersion: string;
      readonly transformationDescriptorDigest: string;
    }
  | {
      readonly kind: "metadata-only";
      readonly modality: string;
      readonly allowlistedFields: readonly string[];
    };

/**
 * Resolves one media item's policy.
 *
 * A modality with no configured policy is not silently skipped and is not
 * silently embedded: it is a visible configuration error, because §8.3 requires
 * configuration to select exactly one supported policy per modality.
 */
export function planMediaFeature(plan: FeaturePlan, modality: string): MediaFeatureDecision {
  const entry = plan.mediaPolicies.find((candidate) => candidate.modality === modality);
  if (!entry) {
    throw memoryError(
      "MEMORY_MODALITY_UNSUPPORTED",
      "No media policy is configured for this modality",
      { modality, configured: plan.mediaPolicies.map((candidate) => candidate.modality) },
    );
  }
  const policy = entry.policy;
  switch (policy.kind) {
    case "skip":
      return { kind: "skip", reason: "MODALITY_SKIPPED" };
    case "native-embedding":
      return { kind: "native-embedding", modality };
    case "derived-text":
      return {
        kind: "derived-text",
        modality,
        transformationId: policy.transformationId,
        transformationVersion: policy.transformationVersion,
        transformationDescriptorDigest: policy.transformationDescriptorDigest,
      };
    case "metadata-only":
      return {
        kind: "metadata-only",
        modality,
        allowlistedFields: policy.allowlistedFields,
      };
  }
}
