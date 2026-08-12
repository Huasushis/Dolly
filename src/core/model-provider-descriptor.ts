import {
  canonicalJsonByteLength,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type SupportStatus<T> =
  | { readonly state: "supported"; readonly value: T }
  | { readonly state: "unsupported" }
  | { readonly state: "unknown" }
  | { readonly state: "inapplicable" };

export type ModelOperationKind = "chat-completion" | "embedding" | "rerank";
export type MediaDeliveryMode =
  | "private-signed"
  | "public-url"
  | "inline"
  | "provider-upload";

export interface DescriptorRef {
  readonly endpointId: string;
  readonly operation: ModelOperationKind;
  readonly modelId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly descriptorVersion: string;
  readonly descriptorDigest: string;
}

export interface DescriptorLimits {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxInputItems: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxConcurrentRequests: number;
  readonly maxProviderTimeoutMs: number;
  readonly streaming: SupportStatus<{
    readonly maxEvents: number;
    readonly maxBufferedBytes: number;
  }>;
}

export interface MediaRequirement {
  readonly requirementId: string;
  readonly modality: string;
  readonly mimeTypes: readonly string[];
  readonly deliveryModes: readonly MediaDeliveryMode[];
  readonly maxItems: number;
  readonly maxBytesPerItem: number;
  readonly maxAggregateBytes: number;
  readonly providerFetchesAfterAcceptance: boolean;
  readonly lifetimeStrategyId: string;
  readonly placementStrategyId: string;
}

export interface DescriptorInput {
  readonly modalities: readonly string[];
  readonly text: SupportStatus<{
    readonly maxBytesPerItem: number;
    readonly empty: "allowed" | "forbidden";
  }>;
  readonly media: readonly MediaRequirement[];
}

export interface RetryFeatures {
  readonly maxProviderAttempts: number;
  readonly safeConditions: readonly (
    | "before-dispatch"
    | "rate-limited"
    | "transient-server-failure"
    | "transport-not-accepted"
  )[];
  readonly providerIdempotency: SupportStatus<{
    readonly strategyId: string;
    readonly outcomeQueryStrategyId?: string;
  }>;
}

export interface ReasoningWireFeatures {
  readonly support: "unsupported" | "always-on" | "request-controlled";
  readonly requestControl:
    | { readonly kind: "forbidden" }
    | { readonly kind: "boolean-strategy"; readonly strategyId: string }
    | { readonly kind: "enum-strategy"; readonly strategyId: string }
    | { readonly kind: "adapter-strategy"; readonly strategyId: string };
  readonly observation: SupportStatus<{
    readonly nonStreamStrategyId?: string;
    readonly streamStrategyId?: string;
    readonly empty: "not-observed" | "observed-empty";
  }>;
  readonly replay: {
    readonly requirement: "forbidden" | "allowed" | "required-for-tool-continuation";
    readonly strategyId?: string;
  };
}

export interface ChatFeatures {
  readonly roles: readonly string[];
  readonly messageOrderStrategyId: string;
  readonly maxMessages: number;
  readonly maxPartsPerMessage: number;
  readonly contextWindowTokens: SupportStatus<{ readonly maximum: number }>;
  readonly maxOutputTokens: SupportStatus<{ readonly maximum: number }>;
  readonly mediaRequirementIds: readonly string[];
  readonly tools: SupportStatus<{
    readonly maxDefinitions: number;
    readonly maxArgumentBytes: number;
    readonly parallelCalls: boolean;
    readonly strategyId: string;
  }>;
  readonly structuredOutput: SupportStatus<{
    readonly dialectId: string;
    readonly maxSchemaBytes: number;
    readonly strategyId: string;
  }>;
  /**
   * A syntactically valid JSON object without schema enforcement. This is a
   * separate capability from `structuredOutput`: providers commonly expose
   * one without supporting the other, and callers must not mistake JSON
   * syntax for schema validation.
   *
   * Absent only on legacy descriptor schema v3. Descriptor v4 requires an
   * explicit supported/unsupported declaration.
   */
  readonly jsonObjectOutput?: SupportStatus<{
    readonly strategyId: string;
  }>;
  readonly reasoning: ReasoningWireFeatures;
  readonly finishReasons: readonly string[];
}

export interface ChatDescriptorDocument {
  readonly schemaVersion: "dolly.model-descriptor/3" | "dolly.model-descriptor/4";
  readonly descriptorVersion: string;
  readonly endpointId: string;
  readonly operation: "chat-completion";
  readonly modelId: string;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly requestStrategyId: string;
    readonly responseStrategyId: string;
    readonly streamStrategyId?: string;
  };
  readonly limits: DescriptorLimits;
  readonly input: DescriptorInput;
  readonly retry: RetryFeatures;
  readonly features: ChatFeatures;
}

export type DescriptorStatus = "active" | "disabled" | "superseded";

export interface ChatDescriptorSnapshot {
  readonly schemaDigest: string;
  readonly ref: DescriptorRef;
  readonly document: ChatDescriptorDocument;
}

export type ModelDescriptorErrorCode =
  | "DESCRIPTOR_INVALID"
  | "DESCRIPTOR_STRATEGY_DENIED"
  | "DESCRIPTOR_IDENTITY_CONFLICT"
  | "DESCRIPTOR_NOT_FOUND"
  | "DESCRIPTOR_DIGEST_MISMATCH"
  | "DESCRIPTOR_DISABLED"
  | "DESCRIPTOR_STATUS_INVALID"
  | "DESCRIPTOR_ALIAS_INVALID";

export class ModelDescriptorError extends Error {
  constructor(
    readonly code: ModelDescriptorErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "ModelDescriptorError";
  }
}

export interface ModelDescriptorRegistryOptions {
  readonly schemaDigest: string;
  readonly allowedStrategyIds: ReadonlySet<string>;
  readonly maxDescriptorBytes?: number;
}

interface RegistryEntry {
  readonly ref: DescriptorRef;
  readonly document: ChatDescriptorDocument;
  status: DescriptorStatus;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function closed(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", `${label} must be an object`);
  }
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      `${label} contains unknown fields: ${unexpected.sort().join(", ")}`,
    );
  }
}

export function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", `${label} is not a valid name`);
  }
  return value;
}

export function logicalEndpointId(value: unknown): string {
  const endpointId = name(value, "endpointId");
  if (endpointId.includes("://") || endpointId.startsWith("/")) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "endpointId must be a logical identifier, not an address or route",
    );
  }
  return endpointId;
}

export function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      `${label} must be a positive safe integer`,
    );
  }
  return value as number;
}

export function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", `${label} must be boolean`);
  }
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", `${label} is unsupported`);
  }
  return value as T;
}

export function uniqueNames(value: unknown, label: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", `${label} must be an array`);
  }
  const values = value.map((entry, index) => name(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", `${label} contains duplicates`);
  }
  return values;
}

export function supportStatus<T>(
  value: unknown,
  label: string,
  normalize: (candidate: unknown, label: string) => T,
): SupportStatus<T> {
  if (!isPlainObject(value) || typeof value.state !== "string") {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", `${label} is invalid`);
  }
  if (value.state === "supported") {
    closed(value, ["state", "value"], label);
    return { state: "supported", value: normalize(value.value, `${label}.value`) };
  }
  if (value.state === "unsupported" || value.state === "unknown" || value.state === "inapplicable") {
    closed(value, ["state"], label);
    return { state: value.state };
  }
  throw new ModelDescriptorError("DESCRIPTOR_INVALID", `${label}.state is unsupported`);
}

export function normalizeLimits(value: unknown): DescriptorLimits {
  closed(
    value,
    [
      "maxRequestBytes",
      "maxResponseBytes",
      "maxInputItems",
      "maxInputBytes",
      "maxOutputBytes",
      "maxConcurrentRequests",
      "maxProviderTimeoutMs",
      "streaming",
    ],
    "limits",
  );
  return {
    maxRequestBytes: positiveInteger(value.maxRequestBytes, "limits.maxRequestBytes"),
    maxResponseBytes: positiveInteger(value.maxResponseBytes, "limits.maxResponseBytes"),
    maxInputItems: positiveInteger(value.maxInputItems, "limits.maxInputItems"),
    maxInputBytes: positiveInteger(value.maxInputBytes, "limits.maxInputBytes"),
    maxOutputBytes: positiveInteger(value.maxOutputBytes, "limits.maxOutputBytes"),
    maxConcurrentRequests: positiveInteger(
      value.maxConcurrentRequests,
      "limits.maxConcurrentRequests",
    ),
    maxProviderTimeoutMs: positiveInteger(
      value.maxProviderTimeoutMs,
      "limits.maxProviderTimeoutMs",
    ),
    streaming: supportStatus(value.streaming, "limits.streaming", (candidate, label) => {
      closed(candidate, ["maxEvents", "maxBufferedBytes"], label);
      return {
        maxEvents: positiveInteger(candidate.maxEvents, `${label}.maxEvents`),
        maxBufferedBytes: positiveInteger(
          candidate.maxBufferedBytes,
          `${label}.maxBufferedBytes`,
        ),
      };
    }),
  };
}

export function normalizeInput(value: unknown): DescriptorInput {
  closed(value, ["modalities", "text", "media"], "input");
  const modalities = uniqueNames(value.modalities, "input.modalities", true);
  const text = supportStatus(value.text, "input.text", (candidate, label) => {
    closed(candidate, ["maxBytesPerItem", "empty"], label);
    return {
      maxBytesPerItem: positiveInteger(candidate.maxBytesPerItem, `${label}.maxBytesPerItem`),
      empty: oneOf(candidate.empty, ["allowed", "forbidden"] as const, `${label}.empty`),
    };
  });
  if (!Array.isArray(value.media)) {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", "input.media must be an array");
  }
  const requirementIds = new Set<string>();
  const media = value.media.map((candidate, index): MediaRequirement => {
    const label = `input.media[${index}]`;
    closed(
      candidate,
      [
        "requirementId",
        "modality",
        "mimeTypes",
        "deliveryModes",
        "maxItems",
        "maxBytesPerItem",
        "maxAggregateBytes",
        "providerFetchesAfterAcceptance",
        "lifetimeStrategyId",
        "placementStrategyId",
      ],
      label,
    );
    const requirementId = name(candidate.requirementId, `${label}.requirementId`);
    if (requirementIds.has(requirementId)) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        `Duplicate media requirement ${requirementId}`,
      );
    }
    requirementIds.add(requirementId);
    if (!Array.isArray(candidate.deliveryModes) || candidate.deliveryModes.length === 0) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        `${label}.deliveryModes must be non-empty`,
      );
    }
    const deliveryModes = candidate.deliveryModes.map((mode, modeIndex) =>
      oneOf(
        mode,
        ["private-signed", "public-url", "inline", "provider-upload"] as const,
        `${label}.deliveryModes[${modeIndex}]`,
      ),
    );
    if (new Set(deliveryModes).size !== deliveryModes.length) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        `${label}.deliveryModes contains duplicates`,
      );
    }
    const maxBytesPerItem = positiveInteger(
      candidate.maxBytesPerItem,
      `${label}.maxBytesPerItem`,
    );
    const maxAggregateBytes = positiveInteger(
      candidate.maxAggregateBytes,
      `${label}.maxAggregateBytes`,
    );
    if (maxAggregateBytes < maxBytesPerItem) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        `${label}.maxAggregateBytes is smaller than one item`,
      );
    }
    return {
      requirementId,
      modality: name(candidate.modality, `${label}.modality`),
      mimeTypes: uniqueNames(candidate.mimeTypes, `${label}.mimeTypes`),
      deliveryModes,
      maxItems: positiveInteger(candidate.maxItems, `${label}.maxItems`),
      maxBytesPerItem,
      maxAggregateBytes,
      providerFetchesAfterAcceptance: booleanValue(
        candidate.providerFetchesAfterAcceptance,
        `${label}.providerFetchesAfterAcceptance`,
      ),
      lifetimeStrategyId: name(candidate.lifetimeStrategyId, `${label}.lifetimeStrategyId`),
      placementStrategyId: name(
        candidate.placementStrategyId,
        `${label}.placementStrategyId`,
      ),
    };
  });
  for (const requirement of media) {
    if (!modalities.includes(requirement.modality)) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        `Media modality ${requirement.modality} is absent from input.modalities`,
      );
    }
  }
  if (text.state === "supported" && !modalities.includes("text")) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "Supported text input requires the text modality",
    );
  }
  return { modalities, text, media };
}

export function normalizeRetry(value: unknown): RetryFeatures {
  closed(value, ["maxProviderAttempts", "safeConditions", "providerIdempotency"], "retry");
  if (!Array.isArray(value.safeConditions)) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "retry.safeConditions must be an array",
    );
  }
  const safeConditions = value.safeConditions.map((condition, index) =>
    oneOf(
      condition,
      [
        "before-dispatch",
        "rate-limited",
        "transient-server-failure",
        "transport-not-accepted",
      ] as const,
      `retry.safeConditions[${index}]`,
    ),
  );
  if (new Set(safeConditions).size !== safeConditions.length) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "retry.safeConditions contains duplicates",
    );
  }
  return {
    maxProviderAttempts: positiveInteger(
      value.maxProviderAttempts,
      "retry.maxProviderAttempts",
    ),
    safeConditions,
    providerIdempotency: supportStatus(
      value.providerIdempotency,
      "retry.providerIdempotency",
      (candidate, label) => {
        closed(candidate, ["strategyId", "outcomeQueryStrategyId"], label);
        return {
          strategyId: name(candidate.strategyId, `${label}.strategyId`),
          ...(candidate.outcomeQueryStrategyId === undefined
            ? {}
            : {
                outcomeQueryStrategyId: name(
                  candidate.outcomeQueryStrategyId,
                  `${label}.outcomeQueryStrategyId`,
                ),
              }),
        };
      },
    ),
  };
}

function normalizeReasoning(value: unknown): ReasoningWireFeatures {
  closed(value, ["support", "requestControl", "observation", "replay"], "reasoning");
  const support = oneOf(
    value.support,
    ["unsupported", "always-on", "request-controlled"] as const,
    "reasoning.support",
  );
  if (!isPlainObject(value.requestControl) || typeof value.requestControl.kind !== "string") {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "reasoning.requestControl is invalid",
    );
  }
  let requestControl: ReasoningWireFeatures["requestControl"];
  if (value.requestControl.kind === "forbidden") {
    closed(value.requestControl, ["kind"], "reasoning.requestControl");
    requestControl = { kind: "forbidden" };
  } else {
    const kind = oneOf(
      value.requestControl.kind,
      ["boolean-strategy", "enum-strategy", "adapter-strategy"] as const,
      "reasoning.requestControl.kind",
    );
    closed(value.requestControl, ["kind", "strategyId"], "reasoning.requestControl");
    requestControl = {
      kind,
      strategyId: name(
        value.requestControl.strategyId,
        "reasoning.requestControl.strategyId",
      ),
    } as ReasoningWireFeatures["requestControl"];
  }
  if (support === "request-controlled" && requestControl.kind === "forbidden") {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "request-controlled reasoning requires a declared request strategy",
    );
  }
  if (support !== "request-controlled" && requestControl.kind !== "forbidden") {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      `${support} reasoning must forbid request-side control`,
    );
  }

  const observation = supportStatus(value.observation, "reasoning.observation", (candidate, label) => {
    closed(candidate, ["nonStreamStrategyId", "streamStrategyId", "empty"], label);
    const nonStreamStrategyId =
      candidate.nonStreamStrategyId === undefined
        ? undefined
        : name(candidate.nonStreamStrategyId, `${label}.nonStreamStrategyId`);
    const streamStrategyId =
      candidate.streamStrategyId === undefined
        ? undefined
        : name(candidate.streamStrategyId, `${label}.streamStrategyId`);
    if (!nonStreamStrategyId && !streamStrategyId) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        `${label} must declare at least one observation strategy`,
      );
    }
    return {
      ...(nonStreamStrategyId ? { nonStreamStrategyId } : {}),
      ...(streamStrategyId ? { streamStrategyId } : {}),
      empty: oneOf(
        candidate.empty,
        ["not-observed", "observed-empty"] as const,
        `${label}.empty`,
      ),
    };
  });

  closed(value.replay, ["requirement", "strategyId"], "reasoning.replay");
  const requirement = oneOf(
    value.replay.requirement,
    ["forbidden", "allowed", "required-for-tool-continuation"] as const,
    "reasoning.replay.requirement",
  );
  const replayStrategy =
    value.replay.strategyId === undefined
      ? undefined
      : name(value.replay.strategyId, "reasoning.replay.strategyId");
  if (requirement === "forbidden" && replayStrategy !== undefined) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "Forbidden reasoning replay cannot declare a strategy",
    );
  }
  if (requirement === "required-for-tool-continuation" && replayStrategy === undefined) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "Required reasoning replay must declare a strategy",
    );
  }

  return {
    support,
    requestControl,
    observation,
    replay: {
      requirement,
      ...(replayStrategy === undefined ? {} : { strategyId: replayStrategy }),
    },
  };
}

function normalizeChatFeatures(
  value: unknown,
  input: DescriptorInput,
  schemaVersion: ChatDescriptorDocument["schemaVersion"],
): ChatFeatures {
  closed(
    value,
    [
      "roles",
      "messageOrderStrategyId",
      "maxMessages",
      "maxPartsPerMessage",
      "contextWindowTokens",
      "maxOutputTokens",
      "mediaRequirementIds",
      "tools",
      "structuredOutput",
      ...(schemaVersion === "dolly.model-descriptor/4" ? ["jsonObjectOutput"] : []),
      "reasoning",
      "finishReasons",
    ],
    "features",
  );
  const mediaRequirementIds = uniqueNames(
    value.mediaRequirementIds,
    "features.mediaRequirementIds",
    true,
  );
  const availableRequirements = new Set(input.media.map((item) => item.requirementId));
  for (const requirementId of mediaRequirementIds) {
    if (!availableRequirements.has(requirementId)) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        `Unknown media requirement ${requirementId}`,
      );
    }
  }
  const jsonObjectOutput =
    schemaVersion === "dolly.model-descriptor/4"
      ? supportStatus(
          value.jsonObjectOutput,
          "features.jsonObjectOutput",
          (candidate, label) => {
            closed(candidate, ["strategyId"], label);
            return { strategyId: name(candidate.strategyId, `${label}.strategyId`) };
          },
        )
      : undefined;
  if (
    jsonObjectOutput !== undefined &&
    jsonObjectOutput.state !== "supported" &&
    jsonObjectOutput.state !== "unsupported"
  ) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "features.jsonObjectOutput must be explicitly supported or unsupported",
    );
  }
  return {
    roles: uniqueNames(value.roles, "features.roles"),
    messageOrderStrategyId: name(
      value.messageOrderStrategyId,
      "features.messageOrderStrategyId",
    ),
    maxMessages: positiveInteger(value.maxMessages, "features.maxMessages"),
    maxPartsPerMessage: positiveInteger(
      value.maxPartsPerMessage,
      "features.maxPartsPerMessage",
    ),
    contextWindowTokens: supportStatus(
      value.contextWindowTokens,
      "features.contextWindowTokens",
      (candidate, label) => {
        closed(candidate, ["maximum"], label);
        return { maximum: positiveInteger(candidate.maximum, `${label}.maximum`) };
      },
    ),
    maxOutputTokens: supportStatus(
      value.maxOutputTokens,
      "features.maxOutputTokens",
      (candidate, label) => {
        closed(candidate, ["maximum"], label);
        return { maximum: positiveInteger(candidate.maximum, `${label}.maximum`) };
      },
    ),
    mediaRequirementIds,
    tools: supportStatus(value.tools, "features.tools", (candidate, label) => {
      closed(
        candidate,
        ["maxDefinitions", "maxArgumentBytes", "parallelCalls", "strategyId"],
        label,
      );
      return {
        maxDefinitions: positiveInteger(candidate.maxDefinitions, `${label}.maxDefinitions`),
        maxArgumentBytes: positiveInteger(
          candidate.maxArgumentBytes,
          `${label}.maxArgumentBytes`,
        ),
        parallelCalls: booleanValue(candidate.parallelCalls, `${label}.parallelCalls`),
        strategyId: name(candidate.strategyId, `${label}.strategyId`),
      };
    }),
    structuredOutput: supportStatus(
      value.structuredOutput,
      "features.structuredOutput",
      (candidate, label) => {
        closed(candidate, ["dialectId", "maxSchemaBytes", "strategyId"], label);
        return {
          dialectId: name(candidate.dialectId, `${label}.dialectId`),
          maxSchemaBytes: positiveInteger(candidate.maxSchemaBytes, `${label}.maxSchemaBytes`),
          strategyId: name(candidate.strategyId, `${label}.strategyId`),
        };
      },
    ),
    ...(jsonObjectOutput === undefined ? {} : { jsonObjectOutput }),
    reasoning: normalizeReasoning(value.reasoning),
    finishReasons: uniqueNames(value.finishReasons, "features.finishReasons"),
  };
}

export function validateChatDescriptor(value: unknown): ChatDescriptorDocument {
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
  if (
    value.schemaVersion !== "dolly.model-descriptor/3" &&
    value.schemaVersion !== "dolly.model-descriptor/4"
  ) {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", "Descriptor schema is unsupported");
  }
  if (value.operation !== "chat-completion") {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", "Descriptor operation is unsupported");
  }
  closed(
    value.adapter,
    ["id", "version", "requestStrategyId", "responseStrategyId", "streamStrategyId"],
    "adapter",
  );
  const limits = normalizeLimits(value.limits);
  const input = normalizeInput(value.input);
  const adapter = {
    id: name(value.adapter.id, "adapter.id"),
    version: name(value.adapter.version, "adapter.version"),
    requestStrategyId: name(value.adapter.requestStrategyId, "adapter.requestStrategyId"),
    responseStrategyId: name(value.adapter.responseStrategyId, "adapter.responseStrategyId"),
    ...(value.adapter.streamStrategyId === undefined
      ? {}
      : { streamStrategyId: name(value.adapter.streamStrategyId, "adapter.streamStrategyId") }),
  };
  if (limits.streaming.state === "supported" && adapter.streamStrategyId === undefined) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "Streaming support requires an adapter stream strategy",
    );
  }
  if (limits.streaming.state !== "supported" && adapter.streamStrategyId !== undefined) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "A non-streaming descriptor cannot declare an adapter stream strategy",
    );
  }
  const schemaVersion = value.schemaVersion;
  const features = normalizeChatFeatures(value.features, input, schemaVersion);
  if (
    features.reasoning.observation.state === "supported" &&
    features.reasoning.observation.value.streamStrategyId !== undefined &&
    limits.streaming.state !== "supported"
  ) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "A stream reasoning observer requires streaming support",
    );
  }

  const normalized = deepFreeze({
    schemaVersion,
    descriptorVersion: name(value.descriptorVersion, "descriptorVersion"),
    endpointId: logicalEndpointId(value.endpointId),
    operation: "chat-completion",
    modelId: name(value.modelId, "modelId"),
    adapter,
    limits,
    input,
    retry: normalizeRetry(value.retry),
    features,
  }) as ChatDescriptorDocument;
  const inlineImageRequest = normalized.adapter.requestStrategyId ===
    "openai.chat.request.content-parts.v1";
  const inlineImageRequirements = normalized.input.media.filter((requirement) =>
    normalized.features.mediaRequirementIds.includes(requirement.requirementId)
  );
  if (inlineImageRequest) {
    if (inlineImageRequirements.length === 0) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        "The content-parts chat strategy requires an enabled inline image requirement",
      );
    }
    for (const requirement of inlineImageRequirements) {
      if (
        requirement.modality !== "image" ||
        requirement.mimeTypes.length !== 1 ||
        requirement.mimeTypes[0] !== "image/png" ||
        requirement.deliveryModes.length !== 1 ||
        requirement.deliveryModes[0] !== "inline" ||
        requirement.providerFetchesAfterAcceptance ||
        requirement.lifetimeStrategyId !== "media.inline-copy.v1" ||
        requirement.placementStrategyId !== "openai.chat.media.inline-image-url.v1"
      ) {
        throw new ModelDescriptorError(
          "DESCRIPTOR_INVALID",
          "The installed content-parts strategy supports only exact inline PNG requirements",
        );
      }
    }
  } else if (
    inlineImageRequirements.some(
      (requirement) =>
        requirement.placementStrategyId === "openai.chat.media.inline-image-url.v1",
    )
  ) {
    throw new ModelDescriptorError(
      "DESCRIPTOR_INVALID",
      "The inline image placement strategy requires the content-parts chat strategy",
    );
  }
  return normalized;
}

function descriptorRef(document: ChatDescriptorDocument): DescriptorRef {
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

export function identityKey(ref: Omit<DescriptorRef, "descriptorDigest">): string {
  return [
    ref.endpointId,
    ref.operation,
    ref.modelId,
    ref.adapterId,
    ref.adapterVersion,
    ref.descriptorVersion,
  ].join("\u0000");
}

function strategies(document: ChatDescriptorDocument): readonly string[] {
  const values = [
    document.adapter.requestStrategyId,
    document.adapter.responseStrategyId,
    document.adapter.streamStrategyId,
    document.features.messageOrderStrategyId,
    ...document.input.media.flatMap((requirement) => [
      requirement.lifetimeStrategyId,
      requirement.placementStrategyId,
    ]),
  ];
  if (document.retry.providerIdempotency.state === "supported") {
    values.push(
      document.retry.providerIdempotency.value.strategyId,
      document.retry.providerIdempotency.value.outcomeQueryStrategyId,
    );
  }
  if (document.features.tools.state === "supported") {
    values.push(document.features.tools.value.strategyId);
  }
  if (document.features.structuredOutput.state === "supported") {
    values.push(document.features.structuredOutput.value.strategyId);
  }
  if (document.features.jsonObjectOutput?.state === "supported") {
    values.push(document.features.jsonObjectOutput.value.strategyId);
  }
  const reasoning = document.features.reasoning;
  if (reasoning.requestControl.kind !== "forbidden") values.push(reasoning.requestControl.strategyId);
  if (reasoning.observation.state === "supported") {
    values.push(
      reasoning.observation.value.nonStreamStrategyId,
      reasoning.observation.value.streamStrategyId,
    );
  }
  values.push(reasoning.replay.strategyId);
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

export function validateDescriptorRef(
  ref: DescriptorRef,
  expectedOperation?: ModelOperationKind,
): void {
  closed(
    ref,
    [
      "endpointId",
      "operation",
      "modelId",
      "adapterId",
      "adapterVersion",
      "descriptorVersion",
      "descriptorDigest",
    ],
    "descriptor reference",
  );
  if (
    !NAME_PATTERN.test(ref.endpointId) ||
    !(["chat-completion", "embedding", "rerank"] as const).includes(ref.operation) ||
    (expectedOperation !== undefined && ref.operation !== expectedOperation) ||
    !NAME_PATTERN.test(ref.modelId) ||
    !NAME_PATTERN.test(ref.adapterId) ||
    !NAME_PATTERN.test(ref.adapterVersion) ||
    !NAME_PATTERN.test(ref.descriptorVersion) ||
    !DIGEST_PATTERN.test(ref.descriptorDigest)
  ) {
    throw new ModelDescriptorError("DESCRIPTOR_INVALID", "Descriptor reference is invalid");
  }
}

export class ModelDescriptorRegistry {
  readonly #schemaDigest: string;
  readonly #allowedStrategyIds: ReadonlySet<string>;
  readonly #maxDescriptorBytes: number;
  readonly #entries = new Map<string, RegistryEntry>();
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
    } catch (error) {
      throw new ModelDescriptorError(
        "DESCRIPTOR_INVALID",
        "Descriptor must be canonical-safe JSON",
        {},
      );
    }
    if (descriptorBytes > this.#maxDescriptorBytes) {
      throw new ModelDescriptorError("DESCRIPTOR_INVALID", "Descriptor exceeds its byte limit");
    }
    const document = validateChatDescriptor(input);
    for (const strategyId of strategies(document)) {
      if (!this.#allowedStrategyIds.has(strategyId)) {
        throw new ModelDescriptorError(
          "DESCRIPTOR_STRATEGY_DENIED",
          `Descriptor strategy ${strategyId} is not installed and allowlisted`,
          { strategyId },
        );
      }
    }
    const ref = descriptorRef(document);
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
    ) as unknown as ChatDescriptorDocument;
    this.#entries.set(key, { ref, document: storedDocument, status: "disabled" });
    return ref;
  }

  setStatus(ref: DescriptorRef, status: DescriptorStatus): void {
    validateDescriptorRef(ref, "chat-completion");
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

  snapshot(selector: DescriptorRef | { readonly alias: string }): ChatDescriptorSnapshot {
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

  #requireEntry(ref: DescriptorRef): RegistryEntry {
    validateDescriptorRef(ref, "chat-completion");
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
