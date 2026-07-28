import { deepFreeze } from "../../core/canonical-json.js";
import type { DescriptorRef } from "../../core/model-provider-descriptor.js";
import {
  embeddingModalitiesComparable,
  type EmbeddingDescriptorSnapshot,
  type EmbeddingFeatures,
} from "../../core/model-provider-embedding.js";
import { memoryError } from "./errors.js";

/**
 * Embedding capability resolution from `docs/spec/memory-extension.md` §9.1 and
 * §9.2.
 *
 * Every fact below is read out of the descriptor document the model provider
 * registry validated: accepted item kinds, accepted media modalities, output
 * dimension, numeric encoding, normalization, metric, vector space, and which
 * modality pairs the endpoint declares comparable. No function here looks at
 * `endpointId` or `modelId` text. A model named `qwen-vl-embedding` whose
 * descriptor declares `itemKinds: ["text"]` is a text-only capability, and a
 * model named `text-embedding-3-small` whose descriptor declares an image
 * requirement supports images. Provider-name inference is the defect this file
 * exists to make unrepresentable.
 */

export interface MemoryVectorSpace {
  readonly vectorSpaceId: string;
  readonly dimension: number;
  readonly numericEncoding: string;
  readonly normalization: EmbeddingFeatures["normalization"];
  readonly metric: EmbeddingFeatures["metric"];
}

export interface MemoryEmbeddingCapability {
  readonly ref: DescriptorRef;
  readonly endpointId: string;
  readonly modelId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly descriptorVersion: string;
  readonly descriptorDigest: string;
  readonly schemaDigest: string;
  /** True only when the descriptor declares text items and supported text input. */
  readonly supportsText: boolean;
  /** Media modalities the descriptor's own media requirements declare. */
  readonly supportedMediaModalities: readonly string[];
  readonly vectorSpace: MemoryVectorSpace;
  readonly maxBatchItems: number;
  readonly snapshot: EmbeddingDescriptorSnapshot;
}

function descriptorMediaModalities(
  snapshot: EmbeddingDescriptorSnapshot,
): readonly string[] {
  const document = snapshot.document;
  const modalities = new Set<string>();
  for (const requirementId of document.features.mediaRequirementIds) {
    const requirement = document.input.media.find(
      (candidate) => candidate.requirementId === requirementId,
    );
    if (requirement) modalities.add(requirement.modality);
  }
  return [...modalities].sort();
}

/**
 * Pins one embedding capability for Memory.
 *
 * A descriptor whose dimension is a choice (`allowed`) does not become a
 * capability until the deployment names the exact dimension, because the
 * dimension is part of the IndexGeneration identity (§9.4) and a silently
 * chosen default would let two generations claim one identity.
 */
export function resolveMemoryEmbeddingCapability(
  snapshot: EmbeddingDescriptorSnapshot,
  options: { readonly outputDimension?: number } = {},
): MemoryEmbeddingCapability {
  const document = snapshot.document;
  if (document.operation !== "embedding") {
    throw memoryError(
      "MEMORY_CONFIG_INVALID",
      "Memory requires a descriptor whose operation is embedding",
      { operation: String(document.operation) },
    );
  }
  const dimensions = document.features.dimensions;
  let dimension: number;
  if (dimensions.kind === "fixed") {
    if (
      options.outputDimension !== undefined &&
      options.outputDimension !== dimensions.value
    ) {
      throw memoryError(
        "MEMORY_CONFIG_INVALID",
        "Configured output dimension does not match the descriptor's fixed dimension",
        { configured: options.outputDimension, descriptor: dimensions.value },
      );
    }
    dimension = dimensions.value;
  } else {
    if (options.outputDimension === undefined) {
      throw memoryError(
        "MEMORY_CONFIG_INVALID",
        "This descriptor allows several dimensions; Memory requires an explicit one",
        { allowed: [...dimensions.values] },
      );
    }
    if (!dimensions.values.includes(options.outputDimension)) {
      throw memoryError(
        "MEMORY_CONFIG_INVALID",
        "Configured output dimension is not allowed by the descriptor",
        { configured: options.outputDimension, allowed: [...dimensions.values] },
      );
    }
    dimension = options.outputDimension;
  }

  const supportsText =
    document.features.itemKinds.includes("text") && document.input.text.state === "supported";

  return deepFreeze({
    ref: snapshot.ref,
    endpointId: document.endpointId,
    modelId: document.modelId,
    adapterId: document.adapter.id,
    adapterVersion: document.adapter.version,
    descriptorVersion: document.descriptorVersion,
    descriptorDigest: snapshot.ref.descriptorDigest,
    schemaDigest: snapshot.schemaDigest,
    supportsText,
    supportedMediaModalities: descriptorMediaModalities(snapshot),
    vectorSpace: {
      vectorSpaceId: document.features.vectorSpaceId,
      dimension,
      numericEncoding: document.features.numericEncoding,
      normalization: document.features.normalization,
      metric: document.features.metric,
    },
    maxBatchItems: document.features.maxBatchItems,
    snapshot,
  });
}

/**
 * §8.3/§9.2: an unsupported modality stays visibly unsupported. There is no
 * branch that hashes bytes, inserts zeros, reuses a text vector, or calls a
 * mock, so a caller that ignores this error still cannot obtain a vector.
 */
export function assertModalitySupported(
  capability: MemoryEmbeddingCapability,
  modality: string,
): void {
  const supported =
    modality === "text"
      ? capability.supportsText
      : capability.supportedMediaModalities.includes(modality);
  if (!supported) {
    throw memoryError(
      "MEMORY_MODALITY_UNSUPPORTED",
      "The configured embedding descriptor does not accept this modality",
      {
        modality,
        endpointId: capability.endpointId,
        modelId: capability.modelId,
        supportsText: capability.supportsText,
        supportedMediaModalities: [...capability.supportedMediaModalities],
      },
    );
  }
}

/**
 * §9.2: cross-modal retrieval requires the descriptor to declare that the two
 * modalities share one comparable vector space. Equal dimension is not
 * evidence, so this delegates to the descriptor's own declaration.
 */
export function assertModalitiesComparable(
  capability: MemoryEmbeddingCapability,
  modalities: readonly string[],
): void {
  for (const modality of modalities) assertModalitySupported(capability, modality);
  if (!embeddingModalitiesComparable(capability.snapshot, modalities)) {
    throw memoryError(
      "MEMORY_VECTOR_SPACE_INCOMPATIBLE",
      "The descriptor does not declare these modalities comparable in one vector space",
      { modalities: [...modalities], vectorSpaceId: capability.vectorSpace.vectorSpaceId },
    );
  }
}

export function vectorSpaceKey(space: MemoryVectorSpace): string {
  const normalization =
    space.normalization.kind === "unit"
      ? `unit:${space.normalization.tolerance}`
      : space.normalization.kind;
  const metric =
    space.metric.kind === "declared" ? `declared:${space.metric.semanticsId}` : space.metric.kind;
  return [
    space.vectorSpaceId,
    String(space.dimension),
    space.numericEncoding,
    normalization,
    metric,
  ].join("|");
}

/**
 * §9.4: vectors from incompatible spaces are never inserted into one index,
 * averaged, compared, or padded to fit.
 */
export function assertCompatibleVectorSpaces(
  left: MemoryVectorSpace,
  right: MemoryVectorSpace,
  subject: string,
): void {
  if (vectorSpaceKey(left) !== vectorSpaceKey(right)) {
    throw memoryError(
      "MEMORY_VECTOR_SPACE_INCOMPATIBLE",
      `${subject} uses a vector space that is not compatible with this index`,
      { subject, left: vectorSpaceKey(left), right: vectorSpaceKey(right) },
    );
  }
}

export type EmbeddingSourceModality = "text" | (string & {});

/** One request item. Media is named by identity; Memory never holds bytes. */
export type MemoryEmbeddingItem =
  | { readonly itemId: string; readonly kind: "text"; readonly text: string }
  | {
      readonly itemId: string;
      readonly kind: "media";
      readonly mediaId: string;
      readonly modality: string;
    };

export type MemoryEmbeddingOutcome =
  | { readonly itemId: string; readonly status: "succeeded"; readonly vector: readonly number[] }
  | {
      readonly itemId: string;
      readonly status: "failed";
      readonly errorCode: string;
      readonly retryable: boolean;
    };

/**
 * The bounded model operation Memory is granted. The broker owns the endpoint,
 * credential, signed URL, and provider representation (§8.4); this interface
 * deliberately exposes none of them.
 */
export interface MemoryEmbeddingOperation {
  readonly capability: MemoryEmbeddingCapability;
  embed(items: readonly MemoryEmbeddingItem[]): Promise<readonly MemoryEmbeddingOutcome[]>;
}

/**
 * Validates one provider response against the pinned capability.
 *
 * §5.5 requires partially returned batches to be correlated by item ID and
 * never treated as a complete job, so an unknown or missing item ID is an
 * error rather than a positional guess.
 */
export function validateEmbeddingOutcomes(
  capability: MemoryEmbeddingCapability,
  requested: readonly MemoryEmbeddingItem[],
  outcomes: readonly MemoryEmbeddingOutcome[],
): readonly MemoryEmbeddingOutcome[] {
  const requestedIds = new Set(requested.map((item) => item.itemId));
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (!requestedIds.has(outcome.itemId)) {
      throw memoryError(
        "MEMORY_JOB_STATE_INVALID",
        "Embedding response carries an item ID that was not requested",
        { itemId: outcome.itemId },
      );
    }
    if (seen.has(outcome.itemId)) {
      throw memoryError(
        "MEMORY_JOB_STATE_INVALID",
        "Embedding response repeats an item ID",
        { itemId: outcome.itemId },
      );
    }
    seen.add(outcome.itemId);
    if (outcome.status !== "succeeded") continue;
    const vector = outcome.vector;
    if (!Array.isArray(vector) || vector.length !== capability.vectorSpace.dimension) {
      throw memoryError(
        "MEMORY_VECTOR_SPACE_INCOMPATIBLE",
        "Embedding vector dimension does not match the pinned capability",
        {
          itemId: outcome.itemId,
          expected: capability.vectorSpace.dimension,
          received: Array.isArray(vector) ? vector.length : -1,
        },
      );
    }
    for (const component of vector) {
      if (typeof component !== "number" || !Number.isFinite(component)) {
        throw memoryError(
          "MEMORY_VECTOR_SPACE_INCOMPATIBLE",
          "Embedding vector contains a non-finite component",
          { itemId: outcome.itemId },
        );
      }
    }
    const normalization = capability.vectorSpace.normalization;
    if (normalization.kind === "unit") {
      const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
      if (Math.abs(norm - 1) > normalization.tolerance) {
        throw memoryError(
          "MEMORY_VECTOR_SPACE_INCOMPATIBLE",
          "Embedding vector is not unit normalized as the descriptor declares",
          { itemId: outcome.itemId, norm },
        );
      }
    }
  }
  return outcomes;
}
