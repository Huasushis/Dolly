import { randomUUID } from "node:crypto";
import {
  parseMediaReferenceItem,
  type MediaReferenceItem,
} from "../block-content.js";
import { canonicalJsonByteLength, deepFreeze, type JsonValue } from "../canonical-json.js";
import {
  assertClosedArguments,
  assertHostIdentifier,
  assertPositiveLimit,
  capabilityArgumentError,
  capabilityQuotaError,
  optionalBoundedInteger,
  optionalString,
  readField,
  requireString,
  resolveExecutionScope,
  type ExtensionCapabilityDefinition,
} from "../capabilities/capability-support.js";
import {
  ExtensionCapabilityError,
  type ExtensionCapabilityGrant,
  type ExtensionCapabilityInvocationContext,
  type ExtensionExecutionScope,
} from "../extension-capability.js";
import type { ReasoningPolicy } from "../model-provider-chat.js";
import type {
  ChatBrokerInvocation,
  ChatBrokerResult,
  ModelInvocationBudgets,
  ModelInvocationContext,
  ModelOperationError,
  ModelUsage,
} from "../model-provider-broker.js";
import type {
  EmbeddingBrokerInvocation,
  EmbeddingBrokerResult,
} from "../model-provider-embedding-broker.js";
import {
  ModelDescriptorError,
  validateDescriptorRef,
  type DescriptorRef,
} from "../model-provider-descriptor.js";

export const MODEL_OPERATION_CAPABILITY_TYPE = "model-operation";
export const MODEL_OPERATION_CAPABILITY_VERSION = "v1";
export const MODEL_OPERATION_CAPABILITY_VERSION_V2 = "v2";
export const MODEL_OPERATION_CAPABILITY_VERSION_V3 = "v3";

/** The modality an extension may ask for; one handle carries exactly one. */
export type ModelModality = "chat" | "embedding" | "rerank";
export type ModelOperationName = ModelModality | "describe";
export type ModelOutputContractKind = "text" | "json-object";

/**
 * The reason a model operation was refused before any provider dispatch.
 *
 * These names are stable extension-visible strings carried in the `reason`
 * detail of a typed capability error. They never name an endpoint, a host, a
 * secret binding, or a provider adapter.
 */
export type ModelOperationDenialReason =
  | "MODEL_OPERATION_DENIED"
  | "MODEL_OPERATION_UNAVAILABLE"
  | "MODEL_MEDIA_NOT_GRANTED"
  | "MODEL_STREAMING_NOT_GRANTED"
  | "MODEL_STREAMING_REQUIRED"
  | "MODEL_TOOLS_NOT_GRANTED"
  | "MODEL_OUTPUT_CONTRACT_DENIED"
  | "MODEL_REASONING_POLICY_DENIED"
  | "MODEL_ROLE_DENIED"
  | "MODEL_RATE_LIMITED"
  | "MODEL_INPUT_LIMIT";

const MODALITY_BY_DESCRIPTOR_OPERATION = {
  "chat-completion": "chat",
  embedding: "embedding",
  rerank: "rerank",
} as const;

export interface ModelOperationLimits {
  /** Most chat messages one request may carry. */
  readonly maxMessages: number;
  /** Most parts one chat message may carry. */
  readonly maxPartsPerMessage: number;
  /** Ceiling on one text part, measured in UTF-8 bytes. */
  readonly maxPartBytes: number;
  /** Most embedding items one request may carry. */
  readonly maxItems: number;
  readonly maxItemBytes: number;
  readonly maxArgumentBytes: number;
  readonly maxResultBytes: number;
  /** Ceiling on invocations for the whole capability session. */
  readonly maxInvocations: number;
  /** Ceiling on provider dispatches attributable to one Run. */
  readonly maxInvocationsPerRun: number;
  /** Ceiling on invocations inside one sliding rate window. */
  readonly maxInvocationsPerWindow: number;
  readonly rateWindowMs: number;
}

export const DEFAULT_MODEL_OPERATION_LIMITS: ModelOperationLimits = deepFreeze({
  maxMessages: 32,
  maxPartsPerMessage: 8,
  maxPartBytes: 16 * 1_024,
  maxItems: 16,
  maxItemBytes: 8 * 1_024,
  maxArgumentBytes: 128 * 1_024,
  maxResultBytes: 128 * 1_024,
  maxInvocations: 64,
  maxInvocationsPerRun: 8,
  maxInvocationsPerWindow: 8,
  rateWindowMs: 60_000,
});

export interface ChatModelBrokerPort {
  invoke(
    invocation: ChatBrokerInvocation,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ChatBrokerResult>;
}

export interface EmbeddingModelBrokerPort {
  invoke(
    invocation: EmbeddingBrokerInvocation,
    options?: { readonly signal?: AbortSignal },
  ): Promise<EmbeddingBrokerResult>;
}

export interface ModelOperationCapabilityOptions {
  /** The one descriptor this handle is bound to, including its exact digest. */
  readonly descriptor: DescriptorRef;
  /** Owner/tenant scope the host charges this work to. */
  readonly ownerScope: string;
  /** Stable upper-level operation identity; defaults to the Module job. */
  readonly operationId?: string;
  /** Upper-level retry number of the Module work, not a provider dispatch count. */
  readonly attempt?: number;
  readonly budgets: ModelInvocationBudgets;
  /**
   * Either pins the handle to one exact Run or explicitly authorizes reuse by
   * this Module process while the host has a verified active Run.
   */
  readonly executionScope: ExtensionExecutionScope | "active-run";
  readonly expiresAt: string;
  readonly now: () => string;
  readonly chat?: ChatModelBrokerPort;
  readonly embedding?: EmbeddingModelBrokerPort;
  readonly operations?: readonly ModelOperationName[];
  /** Reasoning policies the extension may request; the host pins the set. */
  readonly reasoningPolicies?: readonly ReasoningPolicy[];
  /** Allow descriptor-bound provider streaming with a Host-validated final result. */
  readonly allowStreaming?: boolean;
  /** Reject non-stream chat calls before broker dispatch; requires allowStreaming. */
  readonly requireStreaming?: boolean;
  readonly roles?: readonly string[];
  readonly limits?: Partial<ModelOperationLimits>;
  readonly maxConcurrentInvocations?: number;
  readonly requireIdempotencyKey?: boolean;
  /** Monotonic milliseconds used only for the sliding rate window. */
  readonly monotonicNow?: () => number;
  /** Host-issued identity of one provider-request-service call. */
  readonly nextRequestId?: () => string;
}

export interface ModelOperationCapabilityV2Options extends ModelOperationCapabilityOptions {
  /** Output syntaxes this Host grants. No schema or provider strategy is Extension-controlled. */
  readonly outputContracts: readonly ModelOutputContractKind[];
}

export interface ModelOperationCapabilityV3Options extends ModelOperationCapabilityV2Options {
  /** Media requirement identities the Host-selected descriptor and resolver grant. */
  readonly mediaRequirementIds: readonly string[];
}

function modelDenied(
  reason: ModelOperationDenialReason,
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): ExtensionCapabilityError {
  return new ExtensionCapabilityError("CAPABILITY_DENIED", message, { reason, ...details });
}

function modelQuota(
  reason: ModelOperationDenialReason,
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): ExtensionCapabilityError {
  return new ExtensionCapabilityError("CAPABILITY_QUOTA_EXCEEDED", message, {
    reason,
    ...details,
  });
}

function configError(message: string): ExtensionCapabilityError {
  return new ExtensionCapabilityError("CAPABILITY_CONFIG_INVALID", message);
}

function resolveLimits(overrides: Partial<ModelOperationLimits> | undefined): ModelOperationLimits {
  const limits = { ...DEFAULT_MODEL_OPERATION_LIMITS, ...(overrides ?? {}) };
  for (const [label, value] of Object.entries(limits)) {
    assertPositiveLimit(value, `model operation ${label}`);
  }
  return deepFreeze(limits);
}

/**
 * Rejects any argument that would let the extension name its own endpoint,
 * credential, provider, or descriptor. Model selection is a host decision that
 * was frozen when the handle was issued.
 */
const CHAT_ARGUMENT_FIELDS = ["messages", "reasoning", "maxOutputTokens", "stream"] as const;
const CHAT_ARGUMENT_FIELDS_V2 = [...CHAT_ARGUMENT_FIELDS, "outputContract"] as const;
const EMBEDDING_ARGUMENT_FIELDS = ["items", "outputDimension"] as const;

type RequestedChatPart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "media";
      readonly mediaReference: MediaReferenceItem;
      readonly requirementId: string;
    };

function readChatParts(
  value: JsonValue,
  limits: ModelOperationLimits,
  label: string,
  mediaRequirementIds: ReadonlySet<string>,
): readonly RequestedChatPart[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw capabilityArgumentError(`${label} must be a non-empty array`);
  }
  if (value.length > limits.maxPartsPerMessage) {
    throw capabilityQuotaError("maxPartsPerMessage", limits.maxPartsPerMessage);
  }
  return value.map((part, index) => {
    const parsed = assertClosedArguments(
      part as JsonValue,
      ["kind", "text", "mediaId", "mediaReference", "requirementId"],
      `${label}[${index}]`,
    );
    const kind = requireString(parsed, "kind", `${label}[${index}]`);
    if (kind === "media") {
      if (mediaRequirementIds.size === 0) {
        // A text-only model handle is not a Media grant. Dropping the media
        // part would be a silent downgrade, so the complete request fails.
        throw modelDenied(
          "MODEL_MEDIA_NOT_GRANTED",
          "This model handle carries no Media permission for a media part",
          { partIndex: index },
        );
      }
      if (readField(parsed, "mediaId") !== undefined) {
        throw capabilityArgumentError(
          `${label}[${index}] must carry mediaReference instead of mediaId`,
        );
      }
      if (readField(parsed, "text") !== undefined) {
        throw capabilityArgumentError(`${label}[${index}] media part cannot carry text`);
      }
      const requirementId = requireString(
        parsed,
        "requirementId",
        `${label}[${index}]`,
      );
      if (!mediaRequirementIds.has(requirementId)) {
        throw modelDenied(
          "MODEL_MEDIA_NOT_GRANTED",
          "This model handle does not grant the requested Media requirement",
          { partIndex: index, requirementId },
        );
      }
      let mediaReference: MediaReferenceItem;
      try {
        mediaReference = parseMediaReferenceItem(
          readField(parsed, "mediaReference"),
          `${label}[${index}].mediaReference`,
        );
      } catch {
        throw capabilityArgumentError(
          `${label}[${index}].mediaReference is not a valid Media reference`,
        );
      }
      return { kind: "media" as const, mediaReference, requirementId };
    }
    if (kind !== "text") {
      throw capabilityArgumentError(`${label}[${index}].kind is not a supported part kind`);
    }
    if (
      readField(parsed, "mediaId") !== undefined ||
      readField(parsed, "mediaReference") !== undefined ||
      readField(parsed, "requirementId") !== undefined
    ) {
      throw capabilityArgumentError(`${label}[${index}] text part cannot carry Media fields`);
    }
    const text = requireString(parsed, "text", `${label}[${index}]`);
    if (Buffer.byteLength(text, "utf8") > limits.maxPartBytes) {
      throw capabilityQuotaError("maxPartBytes", limits.maxPartBytes);
    }
    return { kind: "text" as const, text };
  });
}

/**
 * Builds the descriptor-bound model operation capability.
 *
 * Section 6 of `extension-process-protocol.md` separates model operations from
 * generic outbound network access: this handle authorizes exactly one frozen
 * descriptor identity through the host's broker. It closes over no endpoint,
 * no credential binding, no redirect policy, and no provider access grant, so
 * there is no argument an extension can send that reaches the transport layer
 * directly. Section 2.3 of `model-provider.md` additionally binds it to the
 * owner scope, the allowed operation, and finite rate, byte, item, time, and
 * expiry limits, all enforced here before the broker is called.
 */
function buildModelOperationCapability(
  options: ModelOperationCapabilityOptions,
  capabilityVersion:
    | typeof MODEL_OPERATION_CAPABILITY_VERSION
    | typeof MODEL_OPERATION_CAPABILITY_VERSION_V2
    | typeof MODEL_OPERATION_CAPABILITY_VERSION_V3,
  configuredOutputContracts: readonly ModelOutputContractKind[],
  configuredMediaRequirementIds: readonly string[] = [],
): ExtensionCapabilityDefinition {
  const limits = resolveLimits(options.limits);
  try {
    validateDescriptorRef(options.descriptor);
  } catch (error) {
    throw configError(
      error instanceof ModelDescriptorError
        ? "Model operation descriptor reference is invalid"
        : "Model operation descriptor reference could not be validated",
    );
  }
  const descriptor = deepFreeze({ ...options.descriptor });
  const modality: ModelModality = MODALITY_BY_DESCRIPTOR_OPERATION[descriptor.operation];
  const grantScope = options.executionScope !== "active-run"
    ? {
        moduleJobId: assertHostIdentifier(options.executionScope.moduleJobId, "moduleJobId"),
        runId: assertHostIdentifier(options.executionScope.runId, "runId"),
      }
    : undefined;
  const ownerScope = assertHostIdentifier(options.ownerScope, "ownerScope");
  const configuredOperationId =
    options.operationId === undefined
      ? undefined
      : assertHostIdentifier(options.operationId, "operationId");
  const configuredAttempt = options.attempt ?? (grantScope === undefined ? undefined : 1);
  if (
    configuredAttempt !== undefined &&
    (!Number.isSafeInteger(configuredAttempt) || configuredAttempt <= 0)
  ) {
    throw configError("Model operation attempt must be a positive safe integer");
  }
  if (grantScope === undefined && configuredAttempt !== undefined) {
    throw configError("A reusable model handle takes its attempt from the active Run");
  }

  const available: readonly ModelOperationName[] = [modality, "describe"];
  const operations = [...new Set(options.operations ?? available)];
  if (operations.length === 0) {
    throw configError("A model operation capability requires at least one operation");
  }
  for (const operation of operations) {
    if (!available.includes(operation)) {
      // A chat descriptor can never authorize an embedding call: the handle is
      // bound to one descriptor identity, not to a provider name.
      throw configError(
        `A ${descriptor.operation} descriptor does not define the operation ${String(operation)}`,
      );
    }
  }
  const enabled = new Set<ModelOperationName>(operations);

  const outputContracts = [...new Set(configuredOutputContracts)];
  if (outputContracts.length === 0) {
    throw configError("A model operation capability requires an output contract");
  }

  const mediaRequirementIds = [...new Set(configuredMediaRequirementIds)];
  if (capabilityVersion === MODEL_OPERATION_CAPABILITY_VERSION_V3) {
    if (modality !== "chat" || mediaRequirementIds.length === 0) {
      throw configError("Model operation v3 requires at least one chat Media requirement");
    }
    for (const requirementId of mediaRequirementIds) {
      assertHostIdentifier(requirementId, "mediaRequirementId");
    }
    if (
      options.budgets.maxMediaItems === undefined ||
      options.budgets.maxResolvedMediaBytes === undefined
    ) {
      throw configError("Model operation v3 requires finite Media item and byte budgets");
    }
    try {
      assertPositiveLimit(options.budgets.maxMediaItems, "model Media maxMediaItems");
      assertPositiveLimit(
        options.budgets.maxResolvedMediaBytes,
        "model Media maxResolvedMediaBytes",
      );
    } catch {
      throw configError("Model operation v3 Media budgets must be positive safe integers");
    }
  } else if (mediaRequirementIds.length !== 0) {
    throw configError("Only model operation v3 can grant Media requirements");
  }
  const mediaRequirements = new Set(mediaRequirementIds);
  for (const outputContract of outputContracts) {
    if (outputContract !== "text" && outputContract !== "json-object") {
      throw configError(`Model output contract ${String(outputContract)} is not defined`);
    }
  }

  const reasoningPolicies = [...new Set(options.reasoningPolicies ?? ["default"])];
  for (const policy of reasoningPolicies) {
    if (!["default", "prefer", "require", "disable"].includes(policy)) {
      throw configError(`Reasoning policy ${String(policy)} is not a defined policy`);
    }
  }
  const allowStreaming = options.allowStreaming === true;
  const requireStreaming = options.requireStreaming === true;
  if (requireStreaming && !allowStreaming) {
    throw configError("Required model streaming requires streaming to be allowed");
  }
  if (allowStreaming && modality !== "chat") {
    throw configError("Provider streaming is available only for chat model operations");
  }
  const roles = [...new Set(options.roles ?? ["system", "user", "assistant", "tool"])];
  for (const role of roles) assertHostIdentifier(role, "role");

  const budgets = deepFreeze({ ...options.budgets });
  const grantedMaxOutputTokens = budgets.maxOutputTokens;
  const now = options.now;
  const monotonicNow = options.monotonicNow ?? (() => Date.now());
  const nextRequestId =
    options.nextRequestId ??
    (() => `model-request-${randomUUID()}`);

  const grant: ExtensionCapabilityGrant = {
    capabilityType: MODEL_OPERATION_CAPABILITY_TYPE,
    capabilityVersion,
    operations,
    resourceScope: {
      schemaVersion: "dolly.capability-scope.model-operation/1",
      // The logical descriptor identity, never an address or a binding.
      descriptor: {
        endpointId: descriptor.endpointId,
        operation: descriptor.operation,
        modelId: descriptor.modelId,
        adapterId: descriptor.adapterId,
        adapterVersion: descriptor.adapterVersion,
        descriptorVersion: descriptor.descriptorVersion,
        descriptorDigest: descriptor.descriptorDigest,
      },
      modality,
      ownerScope,
      ...(grantScope === undefined
        ? { executionScope: "active-run" }
        : { moduleJobId: grantScope.moduleJobId }),
      reasoningPolicies: [...reasoningPolicies],
      providerStreaming: allowStreaming,
      roles: [...roles],
      ...(capabilityVersion !== MODEL_OPERATION_CAPABILITY_VERSION
        ? { outputContracts: [...outputContracts] }
        : {}),
      ...(capabilityVersion === MODEL_OPERATION_CAPABILITY_VERSION_V3
        ? { mediaRequirementIds: [...mediaRequirementIds] }
        : {}),
      limits: { ...limits },
    },
    expiresAt: options.expiresAt,
    maxInvocations: limits.maxInvocations,
    maxInvocationsPerRun: Math.min(
      limits.maxInvocations,
      limits.maxInvocationsPerRun,
    ),
    maxConcurrentInvocations: options.maxConcurrentInvocations ?? 1,
    maxArgumentBytes: limits.maxArgumentBytes,
    maxResultBytes: limits.maxResultBytes,
    ...(grantScope === undefined ? {} : { executionScope: grantScope }),
    ...(options.requireIdempotencyKey === true ? { requireIdempotencyKey: true } : {}),
  };

  const rateWindow: number[] = [];
  const invocationsByRun = new Map<string, number>();
  const consumeRunSlot = (scope: ExtensionExecutionScope): void => {
    const key = `${scope.moduleJobId}\u0000${scope.runId}`;
    const used = invocationsByRun.get(key) ?? 0;
    if (used >= limits.maxInvocationsPerRun) {
      throw modelQuota("MODEL_RATE_LIMITED", "Model operation Run limit reached", {
        maxInvocationsPerRun: limits.maxInvocationsPerRun,
      });
    }
    invocationsByRun.set(key, used + 1);
  };
  const consumeRateSlot = (): void => {
    const stamp = monotonicNow();
    if (!Number.isFinite(stamp)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_DEPENDENCY_FAILED",
        "Model operation rate clock is unavailable",
      );
    }
    while (rateWindow.length > 0 && stamp - rateWindow[0]! >= limits.rateWindowMs) {
      rateWindow.shift();
    }
    if (rateWindow.length >= limits.maxInvocationsPerWindow) {
      throw modelQuota("MODEL_RATE_LIMITED", "Model operation rate limit reached", {
        maxInvocationsPerWindow: limits.maxInvocationsPerWindow,
        rateWindowMs: limits.rateWindowMs,
      });
    }
    rateWindow.push(stamp);
  };

  const resolveInvocationExecution = (
    context: ExtensionCapabilityInvocationContext,
  ): { readonly scope: ExtensionExecutionScope; readonly attempt: number } => {
    const scope = resolveExecutionScope(grantScope, context);
    const attempt = configuredAttempt ?? context.attempt;
    if (attempt === undefined || !Number.isSafeInteger(attempt) || attempt <= 0) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Model operation requires the host-verified active Run attempt",
      );
    }
    return { scope, attempt };
  };

  const buildContext = (
    context: ExtensionCapabilityInvocationContext,
    execution: { readonly scope: ExtensionExecutionScope; readonly attempt: number },
  ): ModelInvocationContext => {
    const { scope, attempt } = execution;
    const operationId = configuredOperationId ?? scope.moduleJobId;
    const startedMs = Date.parse(now());
    if (!Number.isFinite(startedMs)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_DEPENDENCY_FAILED",
        "Model operation clock is unavailable",
      );
    }
    // The deadline is host arithmetic over the granted wall-time budget; an
    // extension can neither extend it nor observe the provider timeout.
    const grantedDeadlineMs = startedMs + budgets.maxWallTimeMs;
    const runDeadlineMs =
      grantScope === undefined && context.deadline !== undefined
        ? Date.parse(context.deadline)
        : grantedDeadlineMs;
    if (!Number.isFinite(runDeadlineMs)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Model operation active Run deadline is invalid",
      );
    }
    if (grantScope === undefined && context.deadline === undefined) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Model operation requires the host-verified active Run deadline",
      );
    }
    const deadline = new Date(Math.min(grantedDeadlineMs, runDeadlineMs)).toISOString();
    return {
      operationId,
      instanceId: context.identity.instanceId,
      ownerScope,
      moduleId: context.identity.moduleId,
      moduleGenerationId: context.identity.moduleGenerationId,
      moduleJobId: scope.moduleJobId,
      runId: scope.runId,
      attempt,
      sessionId: context.identity.sessionId,
      ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
      deadline,
    };
  };

  const modelProjection = (): JsonValue => ({
    // Deliberately omits endpointId and adapter identity: those select host
    // routing and reviewed adapter code, not anything an extension may act on.
    operation: descriptor.operation,
    modelId: descriptor.modelId,
    descriptorVersion: descriptor.descriptorVersion,
    descriptorDigest: descriptor.descriptorDigest,
  });

  const errorProjection = (error: ModelOperationError): JsonValue => ({
    code: error.code,
    phase: error.phase,
    retryClass: error.retryClass,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  });

  const usageProjection = (usage: ModelUsage): JsonValue => ({
    providerAttempts: usage.providerAttempts,
    observations: usage.observations.map((observation) => ({
      name: observation.name,
      state: observation.state,
      ...(observation.source === undefined ? {} : { source: observation.source }),
      ...(observation.value === undefined ? {} : { value: observation.value }),
      ...(observation.unit === undefined ? {} : { unit: observation.unit }),
    })),
  });

  const chatArguments = (
    argumentsValue: JsonValue,
  ): {
    readonly input: ChatBrokerInvocation["input"];
    readonly reasoningPolicy: ReasoningPolicy;
    readonly budgets: ModelInvocationBudgets;
  } => {
    const parsed = assertClosedArguments(
      argumentsValue,
      capabilityVersion !== MODEL_OPERATION_CAPABILITY_VERSION
        ? [...CHAT_ARGUMENT_FIELDS_V2]
        : [...CHAT_ARGUMENT_FIELDS],
      "model.chat",
    );
    const stream = readField(parsed, "stream");
    if (stream !== undefined) {
      if (typeof stream !== "boolean") {
        throw capabilityArgumentError("model.chat.stream must be a boolean when present");
      }
      if (stream && !allowStreaming) {
        throw modelDenied(
          "MODEL_STREAMING_NOT_GRANTED",
          "This model handle does not grant provider streaming",
        );
      }
    }
    if (requireStreaming && stream !== true) {
      throw modelDenied(
        "MODEL_STREAMING_REQUIRED",
        "This model handle requires provider streaming",
      );
    }
    const requestedPolicy = optionalString(parsed, "reasoning", "model.chat") ?? "default";
    if (!reasoningPolicies.includes(requestedPolicy as ReasoningPolicy)) {
      throw modelDenied(
        "MODEL_REASONING_POLICY_DENIED",
        "This model handle does not grant the requested reasoning policy",
        { requested: requestedPolicy },
      );
    }
    const messages = readField(parsed, "messages");
    if (!Array.isArray(messages) || messages.length === 0) {
      throw capabilityArgumentError("model.chat.messages must be a non-empty array");
    }
    if (messages.length > limits.maxMessages) {
      throw capabilityQuotaError("maxMessages", limits.maxMessages);
    }
    const normalizedMessages = messages.map((message, index) => {
      const entry = assertClosedArguments(
        message as JsonValue,
        ["role", "parts"],
        `model.chat.messages[${index}]`,
      );
      const role = requireString(entry, "role", `model.chat.messages[${index}]`);
      if (!roles.includes(role)) {
        throw modelDenied("MODEL_ROLE_DENIED", "This model handle does not grant the message role", {
          role,
        });
      }
      const parts = readChatParts(
        readField(entry, "parts") ?? null,
        limits,
        `model.chat.messages[${index}].parts`,
        mediaRequirements,
      );
      return { role, parts };
    });
    // A request may only narrow the granted budget. Asking for more is a
    // typed quota refusal rather than a silent clamp, so the extension never
    // believes it received a larger allowance than the host granted.
    const requestedOutputTokens = optionalBoundedInteger(
      parsed,
      "maxOutputTokens",
      "model.chat",
      grantedMaxOutputTokens ?? Number.MAX_SAFE_INTEGER,
    );
    const maxOutputTokens = requestedOutputTokens ?? grantedMaxOutputTokens;
    let outputContract: ModelOutputContractKind = "text";
    const requestedOutputContract = readField(parsed, "outputContract");
    if (requestedOutputContract !== undefined) {
      const contract = assertClosedArguments(
        requestedOutputContract,
        ["kind"],
        "model.chat.outputContract",
      );
      const kind = requireString(contract, "kind", "model.chat.outputContract");
      if (kind !== "text" && kind !== "json-object") {
        throw capabilityArgumentError("model.chat.outputContract.kind is unsupported");
      }
      outputContract = kind;
    }
    if (!outputContracts.includes(outputContract)) {
      throw modelDenied(
        "MODEL_OUTPUT_CONTRACT_DENIED",
        "This model handle does not grant the requested output contract",
        { requested: outputContract },
      );
    }
    const input: ChatBrokerInvocation["input"] = {
      schemaVersion:
        capabilityVersion !== MODEL_OPERATION_CAPABILITY_VERSION
          ? "dolly.model.chat-input/3"
          : "dolly.model.chat-input/2",
      messages: normalizedMessages,
      outputContract: { kind: outputContract },
      stream: stream === true,
    };
    const inputBytes = canonicalJsonByteLength(input as unknown as JsonValue);
    if (inputBytes > budgets.maxInputBytes || normalizedMessages.length > budgets.maxInputItems) {
      throw modelQuota("MODEL_INPUT_LIMIT", "Model request exceeds the granted input budget", {
        inputBytes,
        maxInputBytes: budgets.maxInputBytes,
      });
    }
    const mediaItems = normalizedMessages.reduce(
      (count, message) => count + message.parts.filter((part) => part.kind === "media").length,
      0,
    );
    if (
      mediaItems > 0 &&
      (budgets.maxMediaItems === undefined || mediaItems > budgets.maxMediaItems)
    ) {
      throw modelQuota(
        "MODEL_INPUT_LIMIT",
        "Model request exceeds the granted Media item budget",
        { mediaItems, maxMediaItems: budgets.maxMediaItems ?? 0 },
      );
    }
    return {
      input,
      reasoningPolicy: requestedPolicy as ReasoningPolicy,
      budgets: deepFreeze({
        ...budgets,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      }),
    };
  };

  const embeddingArguments = (argumentsValue: JsonValue): EmbeddingBrokerInvocation["input"] => {
    const parsed = assertClosedArguments(
      argumentsValue,
      [...EMBEDDING_ARGUMENT_FIELDS],
      "model.embedding",
    );
    const items = readField(parsed, "items");
    if (!Array.isArray(items) || items.length === 0) {
      throw capabilityArgumentError("model.embedding.items must be a non-empty array");
    }
    if (items.length > limits.maxItems) throw capabilityQuotaError("maxItems", limits.maxItems);
    const outputDimension = readField(parsed, "outputDimension");
    if (
      typeof outputDimension !== "number" ||
      !Number.isSafeInteger(outputDimension) ||
      outputDimension <= 0
    ) {
      throw capabilityArgumentError("model.embedding.outputDimension must be a positive integer");
    }
    const normalized = items.map((item, index) => {
      const entry = assertClosedArguments(
        item as JsonValue,
        ["itemId", "text", "kind"],
        `model.embedding.items[${index}]`,
      );
      const kind = optionalString(entry, "kind", `model.embedding.items[${index}]`) ?? "text";
      if (kind === "media" || kind === "multimodal") {
        throw modelDenied(
          "MODEL_MEDIA_NOT_GRANTED",
          "This model handle carries no Media permission for a media item",
          { itemIndex: index },
        );
      }
      if (kind !== "text") {
        throw capabilityArgumentError(`model.embedding.items[${index}].kind is not supported`);
      }
      const itemId = requireString(entry, "itemId", `model.embedding.items[${index}]`);
      assertHostIdentifier(itemId, `model.embedding.items[${index}].itemId`);
      const text = requireString(entry, "text", `model.embedding.items[${index}]`);
      if (Buffer.byteLength(text, "utf8") > limits.maxItemBytes) {
        throw capabilityQuotaError("maxItemBytes", limits.maxItemBytes);
      }
      return { itemId, input: { kind: "text" as const, text } };
    });
    if (new Set(normalized.map((item) => item.itemId)).size !== normalized.length) {
      throw capabilityArgumentError("model.embedding.items must carry unique item identifiers");
    }
    const input: EmbeddingBrokerInvocation["input"] = {
      schemaVersion: "dolly.model.embedding-input/2",
      outputDimension,
      items: normalized,
    };
    const inputBytes = canonicalJsonByteLength(input as unknown as JsonValue);
    if (inputBytes > budgets.maxInputBytes || normalized.length > budgets.maxInputItems) {
      throw modelQuota("MODEL_INPUT_LIMIT", "Model request exceeds the granted input budget", {
        inputBytes,
        maxInputBytes: budgets.maxInputBytes,
      });
    }
    return input;
  };

  const handler = async (
    argumentsValue: JsonValue,
    context: ExtensionCapabilityInvocationContext,
  ): Promise<JsonValue> => {
    const operation = context.operation as ModelOperationName;
    // Even read-only description is available only inside the Run explicitly
    // selected by this grant. This keeps "active-run" executable policy, not
    // merely descriptive metadata in resourceScope.
    const execution = resolveInvocationExecution(context);
    if (!enabled.has(operation)) {
      throw modelDenied(
        "MODEL_OPERATION_DENIED",
        "This model handle does not authorize the operation",
      );
    }

    if (operation === "describe") {
      assertClosedArguments(argumentsValue, [], "model.describe");
      return {
        schemaVersion:
          capabilityVersion === MODEL_OPERATION_CAPABILITY_VERSION_V3
            ? "dolly.model-operation-description/3"
            : capabilityVersion === MODEL_OPERATION_CAPABILITY_VERSION_V2
              ? "dolly.model-operation-description/2"
            : "dolly.model-operation-description/1",
        modality,
        model: modelProjection(),
        grantedOperations: [...operations].sort(),
        reasoningPolicies: [...reasoningPolicies].sort(),
        roles: [...roles].sort(),
        streaming: requireStreaming
          ? "required"
          : allowStreaming
            ? "optional"
            : "forbidden",
        ...(capabilityVersion !== MODEL_OPERATION_CAPABILITY_VERSION
          ? { outputContracts: [...outputContracts].sort() }
          : {}),
        ...(capabilityVersion === MODEL_OPERATION_CAPABILITY_VERSION_V3
          ? { mediaRequirementIds: [...mediaRequirementIds].sort() }
          : {}),
        limits: {
          maxMessages: limits.maxMessages,
          maxPartsPerMessage: limits.maxPartsPerMessage,
          maxPartBytes: limits.maxPartBytes,
          maxItems: limits.maxItems,
          maxItemBytes: limits.maxItemBytes,
          maxInputBytes: budgets.maxInputBytes,
          maxInputItems: budgets.maxInputItems,
          maxOutputBytes: budgets.maxOutputBytes,
          maxWallTimeMs: budgets.maxWallTimeMs,
          maxInvocationsPerRun: limits.maxInvocationsPerRun,
          ...(grantedMaxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: grantedMaxOutputTokens }),
          ...(capabilityVersion === MODEL_OPERATION_CAPABILITY_VERSION_V3
            ? {
                maxMediaItems: budgets.maxMediaItems!,
                maxResolvedMediaBytes: budgets.maxResolvedMediaBytes!,
              }
            : {}),
        },
      };
    }

    if (operation === "rerank") {
      // The modality is described by the descriptor but no reviewed broker is
      // wired for it. Failing here is the visible outcome; falling back to
      // another modality would silently change the model contract.
      throw modelDenied(
        "MODEL_OPERATION_UNAVAILABLE",
        "No reranking broker is installed for this model handle",
      );
    }

    if (operation === "chat" && !options.chat) {
      throw modelDenied(
        "MODEL_OPERATION_UNAVAILABLE",
        "No chat broker is installed for this model handle",
      );
    }
    if (operation === "embedding" && !options.embedding) {
      throw modelDenied(
        "MODEL_OPERATION_UNAVAILABLE",
        "No embedding broker is installed for this model handle",
      );
    }

    const invocationContext = buildContext(context, execution);
    const requestId = assertHostIdentifier(nextRequestId(), "requestId");

    if (operation === "chat") {
      const prepared = chatArguments(argumentsValue);
      consumeRunSlot(execution.scope);
      consumeRateSlot();
      const result = await options.chat!.invoke(
        {
          schemaVersion: "dolly.model.chat-invocation/3",
          requestId,
          descriptor,
          context: invocationContext,
          budgets: prepared.budgets,
          reasoningPolicy: prepared.reasoningPolicy,
          input: prepared.input,
        },
        { signal: context.signal },
      );
      if (result.status === "succeeded") {
        return {
          schemaVersion: "dolly.model-operation-result/1",
          operation,
          status: "succeeded",
          model: modelProjection(),
          output: {
            finalContent: result.output.finalContent,
            finishReason: result.output.finishReason,
            reasoning:
              result.output.reasoning.state === "observed"
                ? { state: "observed", parts: [...result.output.reasoning.parts] }
                : { state: result.output.reasoning.state },
            toolCalls: result.output.toolCalls.map((call) => ({
              callId: call.callId,
              name: call.name,
              arguments: call.arguments,
            })),
          },
          usage: usageProjection(result.usage),
        };
      }
      return {
        schemaVersion: "dolly.model-operation-result/1",
        operation,
        status: result.status,
        model: modelProjection(),
        error: errorProjection(result.error),
        usage: usageProjection(result.usage),
      };
    }

    const input = embeddingArguments(argumentsValue);
    consumeRunSlot(execution.scope);
    consumeRateSlot();
    const result = await options.embedding!.invoke(
      {
        schemaVersion: "dolly.model.embedding-invocation/3",
        requestId,
        descriptor,
        context: invocationContext,
        budgets,
        input,
      },
      { signal: context.signal },
    );
    if (result.status === "succeeded") {
      return {
        schemaVersion: "dolly.model-operation-result/1",
        operation,
        status: "succeeded",
        model: modelProjection(),
        output: {
          items: result.output.items.map((item): JsonValue =>
            item.status === "succeeded"
              ? {
                  itemId: item.itemId,
                  status: item.status,
                  vector: [...item.vector],
                  dimension: item.dimension,
                  vectorSpaceId: item.vectorSpaceId,
                }
              : { itemId: item.itemId, status: item.status, error: item.error },
          ),
        },
        usage: usageProjection(result.usage),
      };
    }
    return {
      schemaVersion: "dolly.model-operation-result/1",
      operation,
      status: result.status,
      model: modelProjection(),
      error: errorProjection(result.error),
      usage: usageProjection(result.usage),
    };
  };

  return { grant, handler };
}

/** Legacy v1 handle: text output only and a closed v1 argument contract. */
export function createModelOperationCapability(
  options: ModelOperationCapabilityOptions,
): ExtensionCapabilityDefinition {
  return buildModelOperationCapability(
    options,
    MODEL_OPERATION_CAPABILITY_VERSION,
    ["text"],
  );
}

/**
 * Version two makes the output syntax an explicit Host grant. The Extension
 * may select only among those frozen kinds; it cannot provide a schema,
 * endpoint, adapter, or provider wire strategy.
 */
export function createModelOperationCapabilityV2(
  options: ModelOperationCapabilityV2Options,
): ExtensionCapabilityDefinition {
  return buildModelOperationCapability(
    options,
    MODEL_OPERATION_CAPABILITY_VERSION_V2,
    options.outputContracts,
  );
}

/**
 * Version three permits only strict Block Media references selected by a
 * Host-granted requirement. Paths, URLs, Base64 bytes, access modes, and
 * resolver results are not part of its closed argument contract; the broker's
 * Host-only resolver remains the authority for the active delivered Run.
 */
export function createModelOperationCapabilityV3(
  options: ModelOperationCapabilityV3Options,
): ExtensionCapabilityDefinition {
  return buildModelOperationCapability(
    options,
    MODEL_OPERATION_CAPABILITY_VERSION_V3,
    options.outputContracts,
    options.mediaRequirementIds,
  );
}

/** Exposed for hosts that need the modality a descriptor reference implies. */
export function modalityForDescriptor(descriptor: DescriptorRef): ModelModality {
  const modality = MODALITY_BY_DESCRIPTOR_OPERATION[descriptor.operation];
  if (modality === undefined) {
    throw configError("Descriptor reference names an unknown model operation");
  }
  return modality;
}
