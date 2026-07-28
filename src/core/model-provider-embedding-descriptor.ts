import {
  canonicalJsonByteLength,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  supportStatus,
  closed,
  identityKey,
  isPlainObject,
  logicalEndpointId,
  ModelDescriptorError,
  name,
  normalizeInput,
  normalizeLimits,
  normalizeRetry,
  oneOf,
  positiveInteger,
  uniqueNames,
  validateDescriptorRef,
  type SupportStatus,
  type DescriptorInput,
  type DescriptorLimits,
  type DescriptorRef,
  type DescriptorStatus,
  type MediaRequirement,
  type ModelDescriptorRegistryOptions,
  type RetryFeatures,
} from "./model-provider-descriptor.js";

const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type EmbeddingItemKind = "text" | "media" | "multimodal";

export interface EmbeddingFeatures {
  readonly itemKinds: readonly EmbeddingItemKind[];
  readonly mediaRequirementIds: readonly string[];
  readonly compositeStrategyIds: readonly string[];
  readonly dimensions:
    | { readonly kind: "fixed"; readonly value: number }
    | { readonly kind: "allowed"; readonly values: readonly number[] };
  readonly numericEncoding: string;
  readonly decodeStrategyId: string;
  readonly maxBatchItems: number;
  readonly maxPartsPerItem: number;
  readonly normalization:
    | { readonly kind: "not-normalized" }
    | { readonly kind: "unit"; readonly tolerance: number };
  readonly metric:
    | { readonly kind: "cosine" }
    | { readonly kind: "dot-product" }
    | { readonly kind: "euclidean" }
    | { readonly kind: "declared"; readonly semanticsId: string };
  readonly vectorSpaceId: string;
  readonly comparableModalitySets: readonly (readonly string[])[];
  readonly perItemErrors: SupportStatus<{
    readonly correlation: "item-id" | "position";
  }>;
  readonly postProcessing: SupportStatus<{ readonly strategyId: string }>;
}

export interface EmbeddingDescriptorDocument {
  readonly schemaVersion: "dolly.model-descriptor/3";
  readonly descriptorVersion: string;
  readonly endpointId: string;
  readonly operation: "embedding";
  readonly modelId: string;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly requestStrategyId: string;
    readonly responseStrategyId: string;
  };
  readonly limits: DescriptorLimits;
  readonly input: DescriptorInput;
  readonly retry: RetryFeatures;
  readonly features: EmbeddingFeatures;
}

export interface EmbeddingDescriptorSnapshot {
  readonly schemaDigest: string;
  readonly ref: DescriptorRef;
  readonly document: EmbeddingDescriptorDocument;
}

interface EmbeddingRegistryEntry {
  readonly ref: DescriptorRef;
  readonly document: EmbeddingDescriptorDocument;
  status: DescriptorStatus;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", `${label} must be finite`);
  }
  return value;
}

function normalizeItemKinds(value: unknown): readonly EmbeddingItemKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "features.itemKinds must be non-empty",
    );
  }
  const order: readonly EmbeddingItemKind[] = ["text", "media", "multimodal"];
  const kinds = value.map((candidate, index) =>
    oneOf(candidate, order, `features.itemKinds[${index}]`),
  );
  if (new Set(kinds).size !== kinds.length) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "features.itemKinds contains duplicates",
    );
  }
  return [...kinds].sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

function normalizeDimensions(value: unknown): EmbeddingFeatures["dimensions"] {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "features.dimensions is invalid",
    );
  }
  if (value.kind === "fixed") {
    closed(value, ["kind", "value"], "features.dimensions");
    return {
      kind: "fixed",
      value: positiveInteger(value.value, "features.dimensions.value"),
    };
  }
  if (value.kind === "allowed") {
    closed(value, ["kind", "values"], "features.dimensions");
    if (!Array.isArray(value.values) || value.values.length === 0) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        "features.dimensions.values must be non-empty",
      );
    }
    const values = value.values.map((candidate, index) =>
      positiveInteger(candidate, `features.dimensions.values[${index}]`),
    );
    if (new Set(values).size !== values.length) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        "features.dimensions.values contains duplicates",
      );
    }
    return { kind: "allowed", values: [...values].sort((left, right) => left - right) };
  }
  throw new ModelDescriptorError(
    "DESCRIPTOR_INVALID",
    "features.dimensions.kind is unsupported",
  );
}

function normalizeNormalization(value: unknown): EmbeddingFeatures["normalization"] {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "features.normalization is invalid",
    );
  }
  if (value.kind === "not-normalized") {
    closed(value, ["kind"], "features.normalization");
    return { kind: "not-normalized" };
  }
  if (value.kind === "unit") {
    closed(value, ["kind", "tolerance"], "features.normalization");
    const tolerance = finiteNumber(
      value.tolerance,
      "features.normalization.tolerance",
    );
    if (tolerance <= 0 || tolerance > 1) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        "Unit normalization tolerance must be greater than zero and at most one",
      );
    }
    return { kind: "unit", tolerance };
  }
  throw new ModelDescriptorError(
    "DESCRIPTOR_INVALID",
    "features.normalization.kind is unsupported",
  );
}

function normalizeMetric(value: unknown): EmbeddingFeatures["metric"] {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", "features.metric is invalid");
  }
  if (value.kind === "declared") {
    closed(value, ["kind", "semanticsId"], "features.metric");
    return {
      kind: "declared",
      semanticsId: name(value.semanticsId, "features.metric.semanticsId"),
    };
  }
  const kind = oneOf(
    value.kind,
    ["cosine", "dot-product", "euclidean"] as const,
    "features.metric.kind",
  );
  closed(value, ["kind"], "features.metric");
  return { kind };
}

function normalizeComparableModalitySets(
  value: unknown,
  availableModalities: ReadonlySet<string>,
): readonly (readonly string[])[] {
  if (!Array.isArray(value)) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "features.comparableModalitySets must be an array",
    );
  }
  const sets = value.map((candidate, setIndex) => {
    if (!Array.isArray(candidate) || candidate.length < 2) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        `features.comparableModalitySets[${setIndex}] must contain at least two modalities`,
      );
    }
    const modalities = candidate.map((entry, modalityIndex) =>
      name(
        entry,
        `features.comparableModalitySets[${setIndex}][${modalityIndex}]`,
      ),
    );
    if (new Set(modalities).size !== modalities.length) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        `features.comparableModalitySets[${setIndex}] contains duplicates`,
      );
    }
    for (const modality of modalities) {
      if (!availableModalities.has(modality)) {
        throw new ModelDescriptorError(
          "DESCRIPTOR_INVALID",
          `Comparable modality ${modality} is unavailable to this embedding operation`,
        );
      }
    }
    return [...modalities].sort();
  });
  const keys = sets.map((set) => set.join("\u0000"));
  if (new Set(keys).size !== keys.length) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "features.comparableModalitySets contains duplicate sets",
    );
  }
  return [...sets].sort((left, right) => {
    const leftKey = left.join("\u0000");
    const rightKey = right.join("\u0000");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function normalizeEmbeddingFeatures(
  value: unknown,
  input: DescriptorInput,
  limits: DescriptorLimits,
): EmbeddingFeatures {
  closed(
    value,
    [
      "itemKinds",
      "mediaRequirementIds",
      "compositeStrategyIds",
      "dimensions",
      "numericEncoding",
      "decodeStrategyId",
      "maxBatchItems",
      "maxPartsPerItem",
      "normalization",
      "metric",
      "vectorSpaceId",
      "comparableModalitySets",
      "perItemErrors",
      "postProcessing",
    ],
    "features",
  );
  const itemKinds = normalizeItemKinds(value.itemKinds);
  const mediaRequirementIds = uniqueNames(
    value.mediaRequirementIds,
    "features.mediaRequirementIds",
    true,
  );
  const compositeStrategyIds = uniqueNames(
    value.compositeStrategyIds,
    "features.compositeStrategyIds",
    true,
  );
  const availableRequirements = new Map(
    input.media.map((requirement) => [requirement.requirementId, requirement] as const),
  );
  for (const requirementId of mediaRequirementIds) {
    if (!availableRequirements.has(requirementId)) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        `Unknown media requirement ${requirementId}`,
      );
    }
  }

  if (itemKinds.includes("text") && input.text.state !== "supported") {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "Text embedding items require supported text input",
    );
  }
  if (itemKinds.includes("media") && mediaRequirementIds.length === 0) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "Media embedding items require at least one media requirement",
    );
  }
  if (!itemKinds.includes("media") && !itemKinds.includes("multimodal") && mediaRequirementIds.length > 0) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "A text-only embedding operation cannot declare media requirements",
    );
  }
  if (itemKinds.includes("multimodal") !== (compositeStrategyIds.length > 0)) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "Multimodal support and compositeStrategyIds must be declared together",
    );
  }

  const availableModalities = new Set<string>();
  if (
    (itemKinds.includes("text") || itemKinds.includes("multimodal")) &&
    input.text.state === "supported"
  ) {
    availableModalities.add("text");
  }
  if (itemKinds.includes("media") || itemKinds.includes("multimodal")) {
    for (const requirementId of mediaRequirementIds) {
      availableModalities.add(availableRequirements.get(requirementId)!.modality);
    }
  }
  if (itemKinds.includes("multimodal") && availableModalities.size < 2) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "Multimodal embedding requires at least two available modalities",
    );
  }

  const maxBatchItems = positiveInteger(
    value.maxBatchItems,
    "features.maxBatchItems",
  );
  if (maxBatchItems > limits.maxInputItems) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "features.maxBatchItems exceeds limits.maxInputItems",
    );
  }

  return {
    itemKinds,
    mediaRequirementIds,
    compositeStrategyIds,
    dimensions: normalizeDimensions(value.dimensions),
    numericEncoding: name(value.numericEncoding, "features.numericEncoding"),
    decodeStrategyId: name(value.decodeStrategyId, "features.decodeStrategyId"),
    maxBatchItems,
    maxPartsPerItem: positiveInteger(
      value.maxPartsPerItem,
      "features.maxPartsPerItem",
    ),
    normalization: normalizeNormalization(value.normalization),
    metric: normalizeMetric(value.metric),
    vectorSpaceId: name(value.vectorSpaceId, "features.vectorSpaceId"),
    comparableModalitySets: normalizeComparableModalitySets(
      value.comparableModalitySets,
      availableModalities,
    ),
    perItemErrors: supportStatus(
      value.perItemErrors,
      "features.perItemErrors",
      (candidate, label) => {
        closed(candidate, ["correlation"], label);
        return {
          correlation: oneOf(
            candidate.correlation,
            ["item-id", "position"] as const,
            `${label}.correlation`,
          ),
        };
      },
    ),
    postProcessing: supportStatus(
      value.postProcessing,
      "features.postProcessing",
      (candidate, label) => {
        closed(candidate, ["strategyId"], label);
        return { strategyId: name(candidate.strategyId, `${label}.strategyId`) };
      },
    ),
  };
}

export function validateEmbeddingDescriptor(value: unknown): EmbeddingDescriptorDocument {
  closed(
    value,
    [
      "schemaVersion",
      "descriptorVersion",
      "endpointId",
      "operation",
      "modelId",
      "adapter",
      "limits",
      "input",
      "retry",
      "features",
    ],
    "descriptor",
  );
  if (value.schemaVersion !== "dolly.model-descriptor/3" || value.operation !== "embedding") {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "Embedding descriptor schema or operation is unsupported",
    );
  }
  closed(
    value.adapter,
    ["id", "version", "requestStrategyId", "responseStrategyId"],
    "adapter",
  );
  const limits = normalizeLimits(value.limits);
  if (limits.streaming.state === "supported") {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "Embedding descriptor version 3 does not support streaming",
    );
  }
  const input = normalizeInput(value.input);
  return deepFreeze({
    schemaVersion: "dolly.model-descriptor/3",
    descriptorVersion: name(value.descriptorVersion, "descriptorVersion"),
    endpointId: logicalEndpointId(value.endpointId),
    operation: "embedding",
    modelId: name(value.modelId, "modelId"),
    adapter: {
      id: name(value.adapter.id, "adapter.id"),
      version: name(value.adapter.version, "adapter.version"),
      requestStrategyId: name(
        value.adapter.requestStrategyId,
        "adapter.requestStrategyId",
      ),
      responseStrategyId: name(
        value.adapter.responseStrategyId,
        "adapter.responseStrategyId",
      ),
    },
    limits,
    input,
    retry: normalizeRetry(value.retry),
    features: normalizeEmbeddingFeatures(value.features, input, limits),
  }) as EmbeddingDescriptorDocument;
}

function embeddingDescriptorRef(document: EmbeddingDescriptorDocument): DescriptorRef {
  return deepFreeze({
    endpointId: document.endpointId,
    operation: document.operation,
    modelId: document.modelId,
    adapterId: document.adapter.id,
    adapterVersion: document.adapter.version,
    descriptorVersion: document.descriptorVersion,
    descriptorDigest: canonicalJsonDigest(document),
  });
}

function embeddingStrategies(document: EmbeddingDescriptorDocument): readonly string[] {
  const strategies: Array<string | undefined> = [
    document.adapter.requestStrategyId,
    document.adapter.responseStrategyId,
    document.features.decodeStrategyId,
    ...document.features.compositeStrategyIds,
    ...document.input.media.flatMap((requirement) => [
      requirement.lifetimeStrategyId,
      requirement.placementStrategyId,
    ]),
  ];
  if (document.retry.providerIdempotency.state === "supported") {
    strategies.push(
      document.retry.providerIdempotency.value.strategyId,
      document.retry.providerIdempotency.value.outcomeQueryStrategyId,
    );
  }
  if (document.features.postProcessing.state === "supported") {
    strategies.push(document.features.postProcessing.value.strategyId);
  }
  return [...new Set(strategies.filter((value): value is string => value !== undefined))];
}

export class EmbeddingDescriptorRegistry {
  readonly #schemaDigest: string;
  readonly #allowedStrategyIds: ReadonlySet<string>;
  readonly #maxDescriptorBytes: number;
  readonly #entries = new Map<string, EmbeddingRegistryEntry>();
  readonly #aliases = new Map<string, DescriptorRef>();

  constructor(options: ModelDescriptorRegistryOptions) {
    if (!DIGEST_PATTERN.test(options.schemaDigest)) {
      throw new TypeError("schemaDigest must be a sha256 digest");
    }
    this.#schemaDigest = options.schemaDigest;
    this.#allowedStrategyIds = new Set(options.allowedStrategyIds);
    this.#maxDescriptorBytes = options.maxDescriptorBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxDescriptorBytes) || this.#maxDescriptorBytes < 1024) {
      throw new TypeError("maxDescriptorBytes must be a safe integer of at least 1024 bytes");
    }
  }

  register(input: unknown): DescriptorRef {
    let descriptorBytes: number;
    try {
      descriptorBytes = canonicalJsonByteLength(input);
    } catch {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        "Descriptor must be canonical-safe JSON",
      );
    }
    if (descriptorBytes > this.#maxDescriptorBytes) {
      throw new ModelDescriptorError("DESCRIPTOR_INVALID", "Descriptor exceeds its byte limit");
    }
    const document = validateEmbeddingDescriptor(input);
    for (const strategyId of embeddingStrategies(document)) {
      if (!this.#allowedStrategyIds.has(strategyId)) {
        throw new ModelDescriptorError(
          "DESCRIPTOR_STRATEGY_DENIED",
          `Descriptor strategy ${strategyId} is not installed and allowlisted`,
          { strategyId },
        );
      }
    }
    const ref = embeddingDescriptorRef(document);
    const key = identityKey(ref);
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.ref.descriptorDigest !== ref.descriptorDigest) {
        throw new ModelDescriptorError(
          "DESCRIPTOR_IDENTITY_CONFLICT",
          "Descriptor identity already has different canonical bytes",
        );
      }
      return existing.ref;
    }
    const storedDocument = deepFreeze(
      cloneJson(document as unknown as JsonValue),
    ) as unknown as EmbeddingDescriptorDocument;
    this.#entries.set(key, { ref, document: storedDocument, status: "disabled" });
    return ref;
  }

  setStatus(ref: DescriptorRef, status: DescriptorStatus): void {
    validateDescriptorRef(ref, "embedding");
    if (status !== "active" && status !== "disabled" && status !== "superseded") {
      throw new ModelDescriptorError(
        "DESCRIPTOR_STATUS_INVALID",
        "Descriptor status is unsupported",
      );
    }
    const entry = this.#entries.get(identityKey(ref));
    if (!entry) {
      throw new ModelDescriptorError("DESCRIPTOR_NOT_FOUND", "Descriptor is not registered");
    }
    if (entry.ref.descriptorDigest !== ref.descriptorDigest) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_DIGEST_MISMATCH",
        "Descriptor reference digest does not match the registry",
      );
    }
    if (entry.status === "superseded" && status === "active") {
      throw new ModelDescriptorError(
        "DESCRIPTOR_STATUS_INVALID",
        "A superseded descriptor cannot be reactivated",
      );
    }
    entry.status = status;
  }

  setAlias(alias: string, ref: DescriptorRef): void {
    if (!ALIAS_PATTERN.test(alias)) {
      throw new ModelDescriptorError("DESCRIPTOR_ALIAS_INVALID", "Descriptor alias is invalid");
    }
    const entry = this.#requireEntry(ref);
    if (entry.status !== "active") {
      throw new ModelDescriptorError(
        "DESCRIPTOR_DISABLED",
        "An alias can target only an active descriptor",
      );
    }
    this.#aliases.set(alias, entry.ref);
  }

  snapshot(selector: DescriptorRef | { readonly alias: string }): EmbeddingDescriptorSnapshot {
    const ref = "alias" in selector ? this.#aliases.get(selector.alias) : selector;
    if (!ref) {
      throw new ModelDescriptorError("DESCRIPTOR_NOT_FOUND", "Descriptor alias is not registered");
    }
    const entry = this.#requireEntry(ref);
    if (entry.status !== "active") {
      throw new ModelDescriptorError("DESCRIPTOR_DISABLED", "Descriptor is not active");
    }
    return deepFreeze({
      schemaDigest: this.#schemaDigest,
      ref: entry.ref,
      document: entry.document,
    });
  }

  #requireEntry(ref: DescriptorRef): EmbeddingRegistryEntry {
    validateDescriptorRef(ref, "embedding");
    const entry = this.#entries.get(identityKey(ref));
    if (!entry) {
      throw new ModelDescriptorError("DESCRIPTOR_NOT_FOUND", "Descriptor is not registered");
    }
    if (entry.ref.descriptorDigest !== ref.descriptorDigest) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_DIGEST_MISMATCH",
        "Descriptor reference digest does not match the registry",
      );
    }
    return entry;
  }
}
