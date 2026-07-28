import {
  canonicalJsonByteLength,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  parseMediaReferenceItem,
  type MediaReferenceItem,
} from "./block-content.js";
import {
  isPlainObject,
  type MediaRequirement,
} from "./model-provider-descriptor.js";
import type {
  EmbeddingFeatures,
  EmbeddingDescriptorDocument,
  EmbeddingDescriptorSnapshot,
} from "./model-provider-embedding-descriptor.js";
import { parseStrictJsonBytes } from "./strict-json.js";

const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export {
  EmbeddingDescriptorRegistry,
  validateEmbeddingDescriptor,
} from "./model-provider-embedding-descriptor.js";
export type {
  EmbeddingFeatures,
  EmbeddingDescriptorDocument,
  EmbeddingDescriptorSnapshot,
  EmbeddingItemKind,
} from "./model-provider-embedding-descriptor.js";


export type EmbeddingPart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "media";
      readonly modality: string;
      readonly mediaReference: MediaReferenceItem;
      readonly requirementId: string;
    };

export type EmbeddingItemInput =
  | EmbeddingPart
  | {
      readonly kind: "multimodal";
      readonly parts: readonly EmbeddingPart[];
      readonly compositeStrategyId: string;
    };

export interface EmbeddingInput {
  readonly schemaVersion: "dolly.model.embedding-input/2";
  readonly outputDimension: number;
  readonly items: readonly {
    readonly itemId: string;
    readonly input: EmbeddingItemInput;
  }[];
}

export type EmbeddingItemOutcome =
  | {
      readonly itemId: string;
      readonly status: "succeeded";
      readonly vector: readonly number[];
      readonly dimension: number;
      readonly vectorSpaceId: string;
    }
  | {
      readonly itemId: string;
      readonly status: "failed";
      readonly error: JsonValue;
    };

export interface EmbeddingOutput {
  readonly schemaVersion: "dolly.model.embedding-output/1";
  readonly items: readonly EmbeddingItemOutcome[];
}

export interface EmbeddingMediaRequest {
  readonly itemId: string;
  readonly partIndex: number;
  readonly modality: string;
  readonly mediaReference: MediaReferenceItem;
  readonly requirement: MediaRequirement;
}

export interface PreparedEmbeddingInput {
  readonly input: EmbeddingInput;
  readonly mediaRequests: readonly EmbeddingMediaRequest[];
  readonly itemModalities: readonly {
    readonly itemId: string;
    readonly modalities: readonly string[];
  }[];
}

export interface EmbeddingWirePlan {
  readonly method: "POST";
  readonly routeId: "embeddings";
  readonly contentType: "application/json";
  readonly body: JsonValue;
  readonly bodyBytes: number;
  readonly itemOrder: readonly string[];
  readonly outputDimension: number;
}

export type ModelEmbeddingErrorCode =
  | "EMBEDDING_INPUT_INVALID"
  | "EMBEDDING_FEATURE_UNSUPPORTED"
  | "EMBEDDING_LIMIT_EXCEEDED"
  | "EMBEDDING_STRATEGY_UNSUPPORTED"
  | "EMBEDDING_PROVIDER_PROTOCOL_ERROR"
  | "EMBEDDING_VECTOR_INVALID"
  | "EMBEDDING_CORRELATION_INVALID";

export class ModelEmbeddingError extends Error {
  constructor(readonly code: ModelEmbeddingErrorCode, message: string) {
    super(message);
    this.name = "ModelEmbeddingError";
  }
}

function embeddingClosed(
  value: unknown,
  keys: readonly string[],
  label: string,
  code: ModelEmbeddingErrorCode = "EMBEDDING_INPUT_INVALID",
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new ModelEmbeddingError(code, `${label} must be an object`);
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ModelEmbeddingError(code, `${label} contains unknown fields`);
  }
}

function validateOutputDimension(
  features: EmbeddingFeatures,
  candidate: unknown,
): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) {
    throw new ModelEmbeddingError(
      "EMBEDDING_INPUT_INVALID",
      "outputDimension must be a positive safe integer",
    );
  }
  const outputDimension = candidate as number;
  const accepted =
    features.dimensions.kind === "fixed"
      ? outputDimension === features.dimensions.value
      : features.dimensions.values.includes(outputDimension);
  if (!accepted) {
    throw new ModelEmbeddingError(
      "EMBEDDING_FEATURE_UNSUPPORTED",
      "Requested outputDimension is not declared by the descriptor",
    );
  }
  return outputDimension;
}

function validateTextPart(
  descriptor: EmbeddingDescriptorDocument,
  part: unknown,
  label: string,
): { readonly kind: "text"; readonly text: string; readonly bytes: number } {
  embeddingClosed(part, ["kind", "text"], label);
  if (part.kind !== "text" || typeof part.text !== "string") {
    throw new ModelEmbeddingError("EMBEDDING_INPUT_INVALID", `${label} is not text`);
  }
  if (descriptor.input.text.state !== "supported") {
    throw new ModelEmbeddingError(
      "EMBEDDING_FEATURE_UNSUPPORTED",
      "Text input is unsupported",
    );
  }
  const bytes = Buffer.byteLength(part.text, "utf8");
  if (
    bytes > descriptor.input.text.value.maxBytesPerItem ||
    (bytes === 0 && descriptor.input.text.value.empty === "forbidden")
  ) {
    throw new ModelEmbeddingError(
      "EMBEDDING_LIMIT_EXCEEDED",
      "Text input exceeds descriptor limits",
    );
  }
  return { kind: "text", text: part.text, bytes };
}

function validateMediaPart(
  descriptor: EmbeddingDescriptorDocument,
  itemId: string,
  part: unknown,
  partIndex: number,
  mediaCounts: Map<string, number>,
): {
  readonly part: Extract<EmbeddingPart, { readonly kind: "media" }>;
  readonly request: EmbeddingMediaRequest;
} {
  const label = `items[${itemId}].media[${partIndex}]`;
  embeddingClosed(
    part,
    ["kind", "modality", "mediaReference", "requirementId"],
    label,
  );
  if (
    part.kind !== "media" ||
    typeof part.modality !== "string" ||
    typeof part.requirementId !== "string"
  ) {
    throw new ModelEmbeddingError("EMBEDDING_INPUT_INVALID", `${label} is invalid`);
  }
  if (!descriptor.features.mediaRequirementIds.includes(part.requirementId)) {
    throw new ModelEmbeddingError(
      "EMBEDDING_FEATURE_UNSUPPORTED",
      "Media requirement is not enabled for this embedding operation",
    );
  }
  const requirement = descriptor.input.media.find(
    (candidate) => candidate.requirementId === part.requirementId,
  );
  if (!requirement || requirement.modality !== part.modality) {
    throw new ModelEmbeddingError(
      "EMBEDDING_FEATURE_UNSUPPORTED",
      "Media modality does not match the frozen requirement",
    );
  }
  let mediaReference: MediaReferenceItem;
  try {
    mediaReference = parseMediaReferenceItem(
      part.mediaReference,
      `${label}.mediaReference`,
    );
  } catch {
    throw new ModelEmbeddingError(
      "EMBEDDING_INPUT_INVALID",
      `${label}.mediaReference is invalid`,
    );
  }
  const nextCount = (mediaCounts.get(requirement.requirementId) ?? 0) + 1;
  if (nextCount > requirement.maxItems) {
    throw new ModelEmbeddingError(
      "EMBEDDING_LIMIT_EXCEEDED",
      "Media item count exceeds the frozen requirement",
    );
  }
  mediaCounts.set(requirement.requirementId, nextCount);
  return {
    part: {
      kind: "media",
      modality: requirement.modality,
      mediaReference,
      requirementId: requirement.requirementId,
    },
    request: {
      itemId,
      partIndex,
      modality: requirement.modality,
      mediaReference,
      requirement,
    },
  };
}

export function prepareEmbeddingInput(
  snapshot: EmbeddingDescriptorSnapshot,
  input: EmbeddingInput,
): PreparedEmbeddingInput {
  embeddingClosed(input, ["schemaVersion", "outputDimension", "items"], "embedding input");
  if (input.schemaVersion !== "dolly.model.embedding-input/2") {
    throw new ModelEmbeddingError(
      "EMBEDDING_INPUT_INVALID",
      "Embedding input schema is unsupported",
    );
  }
  const descriptor = snapshot.document;
  const outputDimension = validateOutputDimension(
    descriptor.features,
    input.outputDimension,
  );
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ModelEmbeddingError(
      "EMBEDDING_INPUT_INVALID",
      "Embedding items must be non-empty",
    );
  }
  if (
    input.items.length > descriptor.features.maxBatchItems ||
    input.items.length > descriptor.limits.maxInputItems
  ) {
    throw new ModelEmbeddingError(
      "EMBEDDING_LIMIT_EXCEEDED",
      "Embedding item count exceeds descriptor limits",
    );
  }

  const itemIds = new Set<string>();
  const mediaCounts = new Map<string, number>();
  const mediaRequests: EmbeddingMediaRequest[] = [];
  const itemModalities: Array<{ itemId: string; modalities: readonly string[] }> = [];
  let textBytes = 0;
  const items = input.items.map((item, itemIndex) => {
    embeddingClosed(item, ["itemId", "input"], `items[${itemIndex}]`);
    const itemId = item.itemId;
    if (typeof itemId !== "string" || !ITEM_ID_PATTERN.test(itemId)) {
      throw new ModelEmbeddingError("EMBEDDING_INPUT_INVALID", "Embedding itemId is invalid");
    }
    if (itemIds.has(itemId)) {
      throw new ModelEmbeddingError(
        "EMBEDDING_CORRELATION_INVALID",
        "Embedding itemId values must be unique",
      );
    }
    itemIds.add(itemId);
    if (!isPlainObject(item.input) || typeof item.input.kind !== "string") {
      throw new ModelEmbeddingError("EMBEDDING_INPUT_INVALID", "Embedding item is invalid");
    }

    if (item.input.kind === "text") {
      if (!descriptor.features.itemKinds.includes("text")) {
        throw new ModelEmbeddingError(
          "EMBEDDING_FEATURE_UNSUPPORTED",
          "Direct text embedding is unsupported",
        );
      }
      const text = validateTextPart(descriptor, item.input, `items[${itemIndex}].input`);
      textBytes += text.bytes;
      itemModalities.push({ itemId, modalities: ["text"] });
      return { itemId, input: { kind: "text", text: text.text } as const };
    }

    if (item.input.kind === "media") {
      if (!descriptor.features.itemKinds.includes("media")) {
        throw new ModelEmbeddingError(
          "EMBEDDING_FEATURE_UNSUPPORTED",
          "Direct media embedding is unsupported",
        );
      }
      const media = validateMediaPart(
        descriptor,
        itemId,
        item.input,
        0,
        mediaCounts,
      );
      mediaRequests.push(media.request);
      itemModalities.push({ itemId, modalities: [media.part.modality] });
      return { itemId, input: media.part };
    }

    if (item.input.kind === "multimodal") {
      if (!descriptor.features.itemKinds.includes("multimodal")) {
        throw new ModelEmbeddingError(
          "EMBEDDING_FEATURE_UNSUPPORTED",
          "Multimodal embedding is unsupported",
        );
      }
      embeddingClosed(
        item.input,
        ["kind", "parts", "compositeStrategyId"],
        `items[${itemIndex}].input`,
      );
      const compositeStrategyId = item.input.compositeStrategyId;
      if (
        typeof compositeStrategyId !== "string" ||
        !descriptor.features.compositeStrategyIds.includes(compositeStrategyId)
      ) {
        throw new ModelEmbeddingError(
          "EMBEDDING_FEATURE_UNSUPPORTED",
          "Multimodal composite strategy is not declared",
        );
      }
      if (!Array.isArray(item.input.parts) || item.input.parts.length < 2) {
        throw new ModelEmbeddingError(
          "EMBEDDING_INPUT_INVALID",
          "A multimodal item must contain at least two parts",
        );
      }
      if (item.input.parts.length > descriptor.features.maxPartsPerItem) {
        throw new ModelEmbeddingError(
          "EMBEDDING_LIMIT_EXCEEDED",
          "Multimodal part count exceeds descriptor limits",
        );
      }
      const modalities = new Set<string>();
      const parts = item.input.parts.map((part, partIndex): EmbeddingPart => {
        if (!isPlainObject(part) || typeof part.kind !== "string") {
          throw new ModelEmbeddingError("EMBEDDING_INPUT_INVALID", "Embedding part is invalid");
        }
        if (part.kind === "text") {
          const text = validateTextPart(
            descriptor,
            part,
            `items[${itemIndex}].input.parts[${partIndex}]`,
          );
          textBytes += text.bytes;
          modalities.add("text");
          return { kind: "text", text: text.text };
        }
        if (part.kind === "media") {
          const media = validateMediaPart(
            descriptor,
            itemId,
            part,
            partIndex,
            mediaCounts,
          );
          mediaRequests.push(media.request);
          modalities.add(media.part.modality);
          return media.part;
        }
        throw new ModelEmbeddingError(
          "EMBEDDING_INPUT_INVALID",
          "Multimodal item contains an unsupported part kind",
        );
      });
      if (modalities.size < 2) {
        throw new ModelEmbeddingError(
          "EMBEDDING_INPUT_INVALID",
          "A multimodal item must contain at least two distinct modalities",
        );
      }
      itemModalities.push({ itemId, modalities: [...modalities].sort() });
      return {
        itemId,
        input: {
          kind: "multimodal",
          parts,
          compositeStrategyId,
        } as const,
      };
    }

    throw new ModelEmbeddingError(
      "EMBEDDING_INPUT_INVALID",
      "Embedding item kind is unsupported",
    );
  });

  if (textBytes > descriptor.limits.maxInputBytes) {
    throw new ModelEmbeddingError(
      "EMBEDDING_LIMIT_EXCEEDED",
      "Embedding text bytes exceed descriptor limits",
    );
  }
  const normalizedInput = {
    schemaVersion: "dolly.model.embedding-input/2",
    outputDimension,
    items,
  } as const;
  let canonicalBytes: number;
  try {
    canonicalBytes = canonicalJsonByteLength(normalizedInput);
  } catch {
    throw new ModelEmbeddingError(
      "EMBEDDING_INPUT_INVALID",
      "Embedding input is not canonical-safe JSON",
    );
  }
  if (canonicalBytes > descriptor.limits.maxInputBytes) {
    throw new ModelEmbeddingError(
      "EMBEDDING_LIMIT_EXCEEDED",
      "Embedding input bytes exceed descriptor limits",
    );
  }
  return deepFreeze({ input: normalizedInput, mediaRequests, itemModalities });
}

export function embeddingModalitiesComparable(
  snapshot: EmbeddingDescriptorSnapshot,
  modalities: readonly string[],
): boolean {
  const unique = [...new Set(modalities)];
  if (unique.length === 0) return false;
  if (unique.length === 1) {
    const modality = unique[0]!;
    return (
      (modality === "text" && snapshot.document.input.text.state === "supported") ||
      snapshot.document.features.mediaRequirementIds.some((requirementId) =>
        snapshot.document.input.media.some(
          (requirement) =>
            requirement.requirementId === requirementId && requirement.modality === modality,
        ),
      )
    );
  }
  return snapshot.document.features.comparableModalitySets.some((set) =>
    unique.every((modality) => set.includes(modality)),
  );
}

export function encodeOpenAiCompatibleTextEmbeddingRequest(
  snapshot: EmbeddingDescriptorSnapshot,
  input: EmbeddingInput,
): EmbeddingWirePlan {
  const prepared = prepareEmbeddingInput(snapshot, input);
  const descriptor = snapshot.document;
  if (prepared.mediaRequests.length > 0 || prepared.input.items.some((item) => item.input.kind !== "text")) {
    throw new ModelEmbeddingError(
      "EMBEDDING_FEATURE_UNSUPPORTED",
      "The installed OpenAI-compatible text codec does not accept media",
    );
  }
  if (
    descriptor.adapter.responseStrategyId !== "openai.embedding.response.position.v1" ||
    descriptor.features.decodeStrategyId !== "embedding.vector.json-number-array.v1" ||
    descriptor.features.numericEncoding !== "json-number-array.v1" ||
    descriptor.features.postProcessing.state === "supported" ||
    descriptor.features.perItemErrors.state === "supported"
  ) {
    throw new ModelEmbeddingError(
      "EMBEDDING_STRATEGY_UNSUPPORTED",
      "The selected embedding response strategy has no installed codec",
    );
  }
  const body: Record<string, JsonValue> = {
    model: descriptor.modelId,
    input: prepared.input.items.map((item) => (item.input as { text: string }).text),
    encoding_format: "float",
  };
  if (descriptor.adapter.requestStrategyId === "openai.embedding.request.text.fixed.v1") {
    if (descriptor.features.dimensions.kind !== "fixed") {
      throw new ModelEmbeddingError(
        "EMBEDDING_STRATEGY_UNSUPPORTED",
        "A fixed-dimension request strategy requires a fixed descriptor dimension",
      );
    }
  } else if (
    descriptor.adapter.requestStrategyId === "openai.embedding.request.text.dimensions.v1"
  ) {
    body.dimensions = prepared.input.outputDimension;
  } else {
    throw new ModelEmbeddingError(
      "EMBEDDING_STRATEGY_UNSUPPORTED",
      "The selected embedding request strategy has no installed codec",
    );
  }
  const bodyBytes = canonicalJsonByteLength(body);
  if (bodyBytes > descriptor.limits.maxRequestBytes) {
    throw new ModelEmbeddingError(
      "EMBEDDING_LIMIT_EXCEEDED",
      "Encoded embedding request exceeds descriptor limits",
    );
  }
  return deepFreeze({
    method: "POST",
    routeId: "embeddings",
    contentType: "application/json",
    body,
    bodyBytes,
    itemOrder: prepared.input.items.map((item) => item.itemId),
    outputDimension: prepared.input.outputDimension,
  });
}

function stableVectorNorm(vector: readonly number[]): number {
  let scale = 0;
  let scaledSquares = 1;
  for (const value of vector) {
    const absolute = Math.abs(value);
    if (absolute === 0) continue;
    if (scale < absolute) {
      const ratio = scale / absolute;
      scaledSquares = 1 + scaledSquares * ratio * ratio;
      scale = absolute;
    } else {
      const ratio = absolute / scale;
      scaledSquares += ratio * ratio;
    }
  }
  return scale === 0 ? 0 : scale * Math.sqrt(scaledSquares);
}

function validateVector(
  descriptor: EmbeddingDescriptorDocument,
  value: unknown,
  outputDimension: number,
): readonly number[] {
  if (!Array.isArray(value) || value.length !== outputDimension) {
    throw new ModelEmbeddingError(
      "EMBEDDING_VECTOR_INVALID",
      "Provider vector dimension does not match the request",
    );
  }
  const vector = value.map((element) => {
    if (typeof element !== "number" || !Number.isFinite(element) || Object.is(element, -0)) {
      throw new ModelEmbeddingError(
        "EMBEDDING_VECTOR_INVALID",
        "Provider vector contains a non-finite or ambiguous element",
      );
    }
    return element;
  });
  if (descriptor.features.normalization.kind === "unit") {
    const norm = stableVectorNorm(vector);
    if (
      !Number.isFinite(norm) ||
      Math.abs(norm - 1) > descriptor.features.normalization.tolerance
    ) {
      throw new ModelEmbeddingError(
        "EMBEDDING_VECTOR_INVALID",
        "Provider vector violates the declared unit normalization",
      );
    }
  }
  return vector;
}

function validateUsage(value: unknown): void {
  if (value === undefined) return;
  embeddingClosed(
    value,
    ["prompt_tokens", "total_tokens"],
    "embedding provider usage",
    "EMBEDDING_PROVIDER_PROTOCOL_ERROR",
  );
  for (const field of ["prompt_tokens", "total_tokens"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new ModelEmbeddingError(
        "EMBEDDING_PROVIDER_PROTOCOL_ERROR",
        "Embedding provider usage is invalid",
      );
    }
  }
}

export function decodeOpenAiCompatibleEmbeddingResponse(
  snapshot: EmbeddingDescriptorSnapshot,
  input: EmbeddingInput,
  bytes: Uint8Array,
): EmbeddingOutput {
  const prepared = prepareEmbeddingInput(snapshot, input);
  const descriptor = snapshot.document;
  if (
    prepared.mediaRequests.length > 0 ||
    prepared.input.items.some((item) => item.input.kind !== "text") ||
    descriptor.adapter.responseStrategyId !== "openai.embedding.response.position.v1" ||
    descriptor.features.decodeStrategyId !== "embedding.vector.json-number-array.v1" ||
    descriptor.features.numericEncoding !== "json-number-array.v1" ||
    descriptor.features.postProcessing.state === "supported" ||
    descriptor.features.perItemErrors.state === "supported"
  ) {
    throw new ModelEmbeddingError(
      "EMBEDDING_STRATEGY_UNSUPPORTED",
      "The selected embedding response strategy has no installed codec",
    );
  }

  let parsed: JsonValue;
  try {
    parsed = parseStrictJsonBytes(bytes, {
      maxBytes: descriptor.limits.maxResponseBytes,
      maxDepth: 64,
    });
  } catch {
    throw new ModelEmbeddingError(
      "EMBEDDING_PROVIDER_PROTOCOL_ERROR",
      "Embedding provider response is not strict bounded JSON",
    );
  }
  embeddingClosed(
    parsed,
    ["object", "data", "model", "usage"],
    "embedding provider response",
    "EMBEDDING_PROVIDER_PROTOCOL_ERROR",
  );
  if (
    parsed.object !== "list" ||
    parsed.model !== descriptor.modelId ||
    !Array.isArray(parsed.data)
  ) {
    throw new ModelEmbeddingError(
      "EMBEDDING_PROVIDER_PROTOCOL_ERROR",
      "Embedding provider response envelope is invalid",
    );
  }
  validateUsage(parsed.usage);
  if (parsed.data.length !== prepared.input.items.length) {
    throw new ModelEmbeddingError(
      "EMBEDDING_CORRELATION_INVALID",
      "Embedding provider returned a missing or foreign item",
    );
  }
  const vectors = new Map<number, readonly number[]>();
  for (const candidate of parsed.data) {
    embeddingClosed(
      candidate,
      ["object", "index", "embedding"],
      "embedding provider item",
      "EMBEDDING_PROVIDER_PROTOCOL_ERROR",
    );
    if (
      candidate.object !== "embedding" ||
      !Number.isSafeInteger(candidate.index) ||
      (candidate.index as number) < 0 ||
      (candidate.index as number) >= prepared.input.items.length
    ) {
      throw new ModelEmbeddingError(
        "EMBEDDING_CORRELATION_INVALID",
        "Embedding provider item index is foreign",
      );
    }
    const index = candidate.index as number;
    if (vectors.has(index)) {
      throw new ModelEmbeddingError(
        "EMBEDDING_CORRELATION_INVALID",
        "Embedding provider item index is duplicated",
      );
    }
    vectors.set(
      index,
      validateVector(descriptor, candidate.embedding, prepared.input.outputDimension),
    );
  }
  const outcomes = prepared.input.items.map((item, index): EmbeddingItemOutcome => {
    const vector = vectors.get(index);
    if (!vector) {
      throw new ModelEmbeddingError(
        "EMBEDDING_CORRELATION_INVALID",
        "Embedding provider omitted an item",
      );
    }
    return {
      itemId: item.itemId,
      status: "succeeded",
      vector,
      dimension: prepared.input.outputDimension,
      vectorSpaceId: descriptor.features.vectorSpaceId,
    };
  });
  const output: EmbeddingOutput = {
    schemaVersion: "dolly.model.embedding-output/1",
    items: outcomes,
  };
  if (canonicalJsonByteLength(output) > descriptor.limits.maxOutputBytes) {
    throw new ModelEmbeddingError(
      "EMBEDDING_LIMIT_EXCEEDED",
      "Normalized embedding output exceeds descriptor limits",
    );
  }
  return deepFreeze(output);
}
