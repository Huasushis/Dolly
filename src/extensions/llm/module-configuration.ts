/**
 * Closed, provider-neutral configuration for one LLM Module.
 *
 * The configuration names an exact model descriptor but contains no endpoint
 * route or credential. It is stored as an immutable Module configuration
 * record; changing the descriptor or any context policy therefore creates a
 * new record revision, and the instance topology contract treats switching to
 * that revision as a Module generation restart.
 */

import {
  canonicalizeJson,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "../../core/canonical-json.js";
import {
  validateDescriptorRef,
  type ChatDescriptorSnapshot,
  type DescriptorRef,
} from "../../core/model-provider-descriptor.js";
import {
  JSON_SCHEMA_2020_12,
  JsonSchemaError,
  validateJsonSchema,
} from "../../core/json-schema.js";
import {
  resolveContextLimits,
  type ContextLimits,
  type ContextLimitsInput,
} from "./context-limits.js";

const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$";
const DESCRIPTOR_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$";
const DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";

export type LlmReasoningPolicy = "default" | "prefer" | "require" | "disable";
export type LlmStreamingPolicy = "required" | "optional" | "forbidden";
export type LlmOutputContract = "text" | "json-object";

export interface LlmToolLimits {
  readonly maxRounds: number;
  readonly maxCalls: number;
  readonly maxCallsPerRound: number;
  readonly maxApprovals: number;
  readonly maxCallBytes: number;
}

export interface LlmModuleConfiguration {
  readonly schemaVersion: "dolly.llm.module-configuration/1";
  readonly model: {
    readonly permissionPolicyId: string;
    readonly descriptor: DescriptorRef;
    readonly reasoningPolicy: LlmReasoningPolicy;
    readonly streamingPolicy: LlmStreamingPolicy;
    readonly outputContract: LlmOutputContract;
  };
  readonly context: {
    readonly trimPolicyId: "recent-window.v1";
    readonly tokenBudget: {
      readonly estimatorId: "utf8-byte-upper-bound.v1";
      readonly maxInputTokens: number;
    };
    readonly limits: Required<Omit<ContextLimitsInput, "forward" | "cost">> & {
      readonly forward: Required<NonNullable<ContextLimitsInput["forward"]>>;
      readonly cost: Required<NonNullable<ContextLimitsInput["cost"]>>;
    };
  };
  readonly input: {
    readonly acceptedPayloadSchemaIds: readonly string[];
    readonly unavailableModalityPolicy: "describe" | "fail";
  };
  readonly tools: {
    readonly policyIds: readonly string[];
    readonly limits: LlmToolLimits;
  };
  readonly turn: {
    readonly maxProviderCalls: number;
    readonly maxCorrectionCalls: number;
    readonly maxOutputTokens: number;
    readonly maxOutputBytes: number;
    readonly maxWallTimeMs: number;
  };
  readonly retention: {
    readonly maxHistoryUnits: number;
    readonly evictedUnitDisposition: "delete";
    readonly sessionCloseDisposition: "delete";
  };
  readonly output: {
    readonly payloadSchemaId: "dolly.content/1";
    readonly maxTextBytes: number;
    readonly permanentErrorPolicy: "fail-run";
    readonly provisionalStreamingPolicy: "disabled";
  };
}

export type LlmModuleConfigurationErrorCode =
  | "LLM_CONFIGURATION_INVALID"
  | "LLM_DESCRIPTOR_MISMATCH"
  | "LLM_FEATURE_UNSUPPORTED"
  | "LLM_CONTEXT_WINDOW_UNAVAILABLE"
  | "LLM_CONTEXT_BUDGET_EXCEEDED";

export class LlmModuleConfigurationError extends TypeError {
  constructor(
    readonly code: LlmModuleConfigurationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmModuleConfigurationError";
  }
}

const positiveInteger = Object.freeze({ type: "integer", minimum: 1 });
const nonNegativeInteger = Object.freeze({ type: "integer", minimum: 0 });
const descriptorReferenceSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "endpointId",
    "operation",
    "modelId",
    "adapterId",
    "adapterVersion",
    "descriptorVersion",
    "descriptorDigest",
  ],
  properties: {
    endpointId: { type: "string", pattern: DESCRIPTOR_NAME_PATTERN },
    operation: { const: "chat-completion" },
    modelId: { type: "string", pattern: DESCRIPTOR_NAME_PATTERN },
    adapterId: { type: "string", pattern: DESCRIPTOR_NAME_PATTERN },
    adapterVersion: { type: "string", pattern: DESCRIPTOR_NAME_PATTERN },
    descriptorVersion: { type: "string", pattern: DESCRIPTOR_NAME_PATTERN },
    descriptorDigest: { type: "string", pattern: DIGEST_PATTERN },
  },
});

/** The exact JSON Schema stored beside immutable LLM Module configuration records. */
export const LLM_MODULE_CONFIGURATION_SCHEMA: JsonValue = deepFreeze({
  $schema: JSON_SCHEMA_2020_12,
  $id: "https://dolly.local/schema/llm-module-configuration-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "model", "context", "input", "tools", "turn", "retention", "output"],
  properties: {
    schemaVersion: { const: "dolly.llm.module-configuration/1" },
    model: {
      type: "object",
      additionalProperties: false,
      required: ["permissionPolicyId", "descriptor", "reasoningPolicy", "streamingPolicy", "outputContract"],
      properties: {
        permissionPolicyId: { type: "string", pattern: IDENTIFIER_PATTERN },
        descriptor: descriptorReferenceSchema,
        reasoningPolicy: { enum: ["default", "prefer", "require", "disable"] },
        streamingPolicy: { enum: ["required", "optional", "forbidden"] },
        outputContract: { enum: ["text", "json-object"] },
      },
    },
    context: {
      type: "object",
      additionalProperties: false,
      required: ["trimPolicyId", "tokenBudget", "limits"],
      properties: {
        trimPolicyId: { const: "recent-window.v1" },
        tokenBudget: {
          type: "object",
          additionalProperties: false,
          required: ["estimatorId", "maxInputTokens"],
          properties: {
            estimatorId: { const: "utf8-byte-upper-bound.v1" },
            maxInputTokens: positiveInteger,
          },
        },
        limits: {
          type: "object",
          additionalProperties: false,
          required: [
            "maxTotalBytes", "maxMessages", "maxMediaParts", "maxSystemPromptBytes",
            "maxDeploymentTextBytes", "maxDescriptions", "maxDescriptionBytes",
            "maxDescriptionsTotalBytes", "maxTextItemBytes", "maxBlockItems", "forward", "cost",
          ],
          properties: {
            maxTotalBytes: positiveInteger,
            maxMessages: { type: "integer", minimum: 2 },
            maxMediaParts: nonNegativeInteger,
            maxSystemPromptBytes: positiveInteger,
            maxDeploymentTextBytes: positiveInteger,
            maxDescriptions: nonNegativeInteger,
            maxDescriptionBytes: positiveInteger,
            maxDescriptionsTotalBytes: positiveInteger,
            maxTextItemBytes: positiveInteger,
            maxBlockItems: positiveInteger,
            forward: {
              type: "object",
              additionalProperties: false,
              required: ["maxDepth", "maxNodes", "maxBytes"],
              properties: {
                maxDepth: nonNegativeInteger,
                maxNodes: nonNegativeInteger,
                maxBytes: nonNegativeInteger,
              },
            },
            cost: {
              type: "object",
              additionalProperties: false,
              required: ["messageOverheadBytes", "mediaPartBytes"],
              properties: {
                messageOverheadBytes: nonNegativeInteger,
                mediaPartBytes: nonNegativeInteger,
              },
            },
          },
        },
      },
    },
    input: {
      type: "object",
      additionalProperties: false,
      required: ["acceptedPayloadSchemaIds", "unavailableModalityPolicy"],
      properties: {
        acceptedPayloadSchemaIds: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
          items: { type: "string", pattern: IDENTIFIER_PATTERN },
        },
        unavailableModalityPolicy: { enum: ["describe", "fail"] },
      },
    },
    tools: {
      type: "object",
      additionalProperties: false,
      required: ["policyIds", "limits"],
      properties: {
        policyIds: {
          type: "array",
          maxItems: 64,
          uniqueItems: true,
          items: { type: "string", pattern: IDENTIFIER_PATTERN },
        },
        limits: {
          type: "object",
          additionalProperties: false,
          required: ["maxRounds", "maxCalls", "maxCallsPerRound", "maxApprovals", "maxCallBytes"],
          properties: {
            maxRounds: nonNegativeInteger,
            maxCalls: nonNegativeInteger,
            maxCallsPerRound: nonNegativeInteger,
            maxApprovals: nonNegativeInteger,
            maxCallBytes: nonNegativeInteger,
          },
        },
      },
    },
    turn: {
      type: "object",
      additionalProperties: false,
      required: ["maxProviderCalls", "maxCorrectionCalls", "maxOutputTokens", "maxOutputBytes", "maxWallTimeMs"],
      properties: {
        maxProviderCalls: positiveInteger,
        maxCorrectionCalls: nonNegativeInteger,
        maxOutputTokens: positiveInteger,
        maxOutputBytes: positiveInteger,
        maxWallTimeMs: positiveInteger,
      },
    },
    retention: {
      type: "object",
      additionalProperties: false,
      required: ["maxHistoryUnits", "evictedUnitDisposition", "sessionCloseDisposition"],
      properties: {
        maxHistoryUnits: nonNegativeInteger,
        evictedUnitDisposition: { const: "delete" },
        sessionCloseDisposition: { const: "delete" },
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["payloadSchemaId", "maxTextBytes", "permanentErrorPolicy", "provisionalStreamingPolicy"],
      properties: {
        payloadSchemaId: { const: "dolly.content/1" },
        maxTextBytes: positiveInteger,
        permanentErrorPolicy: { const: "fail-run" },
        provisionalStreamingPolicy: { const: "disabled" },
      },
    },
  },
} as JsonValue);

function invalid(message: string, cause?: unknown): LlmModuleConfigurationError {
  return new LlmModuleConfigurationError(
    "LLM_CONFIGURATION_INVALID",
    message,
    {},
    cause === undefined ? undefined : { cause },
  );
}

/** Validates closed shape plus cross-field limits and returns a detached immutable value. */
export function validateLlmModuleConfiguration(value: JsonValue): LlmModuleConfiguration {
  try {
    validateJsonSchema(LLM_MODULE_CONFIGURATION_SCHEMA, value);
  } catch (error) {
    if (error instanceof JsonSchemaError) throw invalid("LLM Module configuration does not satisfy version 1", error);
    throw error;
  }
  const configuration = value as unknown as LlmModuleConfiguration;
  try {
    validateDescriptorRef(configuration.model.descriptor, "chat-completion");
  } catch (error) {
    throw invalid("LLM Module configuration has an invalid chat descriptor reference", error);
  }
  const limits = configuration.context.limits;
  if (
    limits.maxSystemPromptBytes > limits.maxTotalBytes ||
    limits.maxDeploymentTextBytes > limits.maxTotalBytes ||
    limits.maxDescriptionBytes > limits.maxDescriptionsTotalBytes ||
    limits.maxDescriptionsTotalBytes > limits.maxTotalBytes ||
    limits.maxTextItemBytes > limits.maxTotalBytes
  ) {
    throw invalid("LLM context sublimits cannot exceed their enclosing byte limits");
  }
  if (!configuration.input.acceptedPayloadSchemaIds.includes("dolly.content/1")) {
    throw invalid("LLM Module configuration must accept dolly.content/1 input");
  }
  const tool = configuration.tools;
  const toolValues = Object.values(tool.limits);
  if (tool.policyIds.length === 0) {
    if (toolValues.some((entry) => entry !== 0)) {
      throw invalid("A tool-free configuration must reserve zero tool budget");
    }
  } else if (
    tool.limits.maxRounds <= 0 || tool.limits.maxCalls <= 0 ||
    tool.limits.maxCallsPerRound <= 0 || tool.limits.maxCallBytes <= 0 ||
    tool.limits.maxCallsPerRound > tool.limits.maxCalls ||
    tool.limits.maxApprovals > tool.limits.maxCalls
  ) {
    throw invalid("A tool-enabled configuration has inconsistent finite tool limits");
  }
  if (configuration.turn.maxCorrectionCalls >= configuration.turn.maxProviderCalls) {
    throw invalid("Correction calls must fit below the total provider-call budget");
  }
  if (configuration.output.maxTextBytes > configuration.turn.maxOutputBytes) {
    throw invalid("LLM text output exceeds the turn output-byte boundary");
  }
  return deepFreeze(cloneJson(value)) as unknown as LlmModuleConfiguration;
}

export interface ResolvedLlmModuleConfiguration {
  readonly configuration: LlmModuleConfiguration;
  readonly descriptor: ChatDescriptorSnapshot;
  readonly contextLimits: ContextLimits;
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly contextWindowTokens: number;
}

function featureUnsupported(message: string): LlmModuleConfigurationError {
  return new LlmModuleConfigurationError("LLM_FEATURE_UNSUPPORTED", message);
}

/**
 * Resolves configuration against the exact descriptor snapshot that a future
 * Run would receive. Incompatible model switches fail before provider I/O.
 */
export function resolveLlmModuleConfiguration(
  input: LlmModuleConfiguration,
  descriptor: ChatDescriptorSnapshot,
): ResolvedLlmModuleConfiguration {
  const configuration = validateLlmModuleConfiguration(input as unknown as JsonValue);
  if (canonicalizeJson(configuration.model.descriptor) !== canonicalizeJson(descriptor.ref)) {
    throw new LlmModuleConfigurationError(
      "LLM_DESCRIPTOR_MISMATCH",
      "LLM Module configuration does not name the frozen descriptor snapshot",
    );
  }
  const document = descriptor.document;
  if (
    configuration.model.streamingPolicy === "required" &&
    document.limits.streaming.state !== "supported"
  ) {
    throw featureUnsupported("The selected descriptor does not support required streaming");
  }
  const reasoning = document.features.reasoning;
  if (
    configuration.model.reasoningPolicy === "disable" && reasoning.support === "always-on"
  ) {
    throw featureUnsupported("An always-on reasoning descriptor cannot satisfy disable");
  }
  if (
    configuration.model.reasoningPolicy === "require" &&
    (reasoning.support === "unsupported" || reasoning.observation.state !== "supported")
  ) {
    throw featureUnsupported("The selected descriptor cannot prove required reasoning occurred");
  }
  if (
    configuration.model.outputContract === "json-object" &&
    document.features.jsonObjectOutput?.state !== "supported"
  ) {
    throw featureUnsupported("The selected descriptor does not support JSON-object output");
  }
  const contextFeature = document.features.contextWindowTokens;
  const outputFeature = document.features.maxOutputTokens;
  if (contextFeature.state !== "supported" || outputFeature.state !== "supported") {
    throw new LlmModuleConfigurationError(
      "LLM_CONTEXT_WINDOW_UNAVAILABLE",
      "The selected descriptor must declare exact context and output token maxima",
    );
  }
  const maximumInputTokens = configuration.context.tokenBudget.maxInputTokens;
  const maximumOutputTokens = configuration.turn.maxOutputTokens;
  if (
    maximumOutputTokens > outputFeature.value.maximum ||
    maximumInputTokens + maximumOutputTokens > contextFeature.value.maximum
  ) {
    throw new LlmModuleConfigurationError(
      "LLM_CONTEXT_BUDGET_EXCEEDED",
      "Configured input and output token budgets do not fit the selected descriptor",
      {
        maximumInputTokens,
        maximumOutputTokens,
        descriptorContextWindowTokens: contextFeature.value.maximum,
        descriptorMaximumOutputTokens: outputFeature.value.maximum,
      },
    );
  }
  if (configuration.turn.maxOutputBytes > document.limits.maxOutputBytes) {
    throw new LlmModuleConfigurationError(
      "LLM_CONTEXT_BUDGET_EXCEEDED",
      "Configured output bytes exceed the selected descriptor",
    );
  }
  let contextLimits: ContextLimits;
  try {
    contextLimits = resolveContextLimits(descriptor, configuration.context.limits);
  } catch (error) {
    throw new LlmModuleConfigurationError(
      "LLM_CONTEXT_BUDGET_EXCEEDED",
      "Configured context byte limits do not fit the selected descriptor",
      {},
      { cause: error },
    );
  }
  return deepFreeze({
    configuration,
    descriptor,
    contextLimits,
    maximumInputTokens,
    maximumOutputTokens,
    contextWindowTokens: contextFeature.value.maximum,
  }) as ResolvedLlmModuleConfiguration;
}

/**
 * Produces a complete tool-free, strict-streaming baseline for one descriptor.
 * It resolves immediately, so a descriptor missing safe context bounds cannot
 * produce a seemingly valid default.
 */
export function createDefaultLlmModuleConfiguration(
  descriptor: ChatDescriptorSnapshot,
  permissionPolicyId: string,
): LlmModuleConfiguration {
  const contextFeature = descriptor.document.features.contextWindowTokens;
  const outputFeature = descriptor.document.features.maxOutputTokens;
  if (contextFeature.state !== "supported" || outputFeature.state !== "supported") {
    throw new LlmModuleConfigurationError(
      "LLM_CONTEXT_WINDOW_UNAVAILABLE",
      "A default LLM configuration requires exact descriptor token maxima",
    );
  }
  const maximumOutputTokens = Math.min(
    2048,
    outputFeature.value.maximum,
    Math.max(1, Math.floor(contextFeature.value.maximum / 4)),
  );
  const maximumInputTokens = contextFeature.value.maximum - maximumOutputTokens;
  if (maximumInputTokens <= 0) {
    throw new LlmModuleConfigurationError(
      "LLM_CONTEXT_BUDGET_EXCEEDED",
      "The descriptor context window cannot reserve one input token",
    );
  }
  const maxTotalBytes = Math.min(256 * 1024, descriptor.document.limits.maxInputBytes);
  const maxOutputBytes = Math.min(32 * 1024, descriptor.document.limits.maxOutputBytes);
  const configuration = validateLlmModuleConfiguration({
    schemaVersion: "dolly.llm.module-configuration/1",
    model: {
      permissionPolicyId,
      descriptor: descriptor.ref,
      reasoningPolicy: "default",
      streamingPolicy: "required",
      outputContract: "text",
    },
    context: {
      trimPolicyId: "recent-window.v1",
      tokenBudget: {
        estimatorId: "utf8-byte-upper-bound.v1",
        maxInputTokens: maximumInputTokens,
      },
      limits: {
        maxTotalBytes,
        maxMessages: Math.min(64, descriptor.document.features.maxMessages),
        maxMediaParts: 0,
        maxSystemPromptBytes: Math.min(32 * 1024, maxTotalBytes),
        maxDeploymentTextBytes: Math.min(16 * 1024, maxTotalBytes),
        maxDescriptions: 32,
        maxDescriptionBytes: Math.min(4 * 1024, maxTotalBytes),
        maxDescriptionsTotalBytes: Math.min(32 * 1024, maxTotalBytes),
        maxTextItemBytes: Math.min(32 * 1024, maxTotalBytes),
        maxBlockItems: 256,
        forward: { maxDepth: 2, maxNodes: 8, maxBytes: Math.min(16 * 1024, maxTotalBytes) },
        cost: { messageOverheadBytes: 8, mediaPartBytes: 1024 },
      },
    },
    input: {
      acceptedPayloadSchemaIds: ["dolly.content/1"],
      unavailableModalityPolicy: "fail",
    },
    tools: {
      policyIds: [],
      limits: { maxRounds: 0, maxCalls: 0, maxCallsPerRound: 0, maxApprovals: 0, maxCallBytes: 0 },
    },
    turn: {
      maxProviderCalls: 1,
      maxCorrectionCalls: 0,
      maxOutputTokens: maximumOutputTokens,
      maxOutputBytes,
      maxWallTimeMs: Math.min(10 * 60 * 1000, descriptor.document.limits.maxProviderTimeoutMs),
    },
    retention: {
      maxHistoryUnits: 64,
      evictedUnitDisposition: "delete",
      sessionCloseDisposition: "delete",
    },
    output: {
      payloadSchemaId: "dolly.content/1",
      maxTextBytes: maxOutputBytes,
      permanentErrorPolicy: "fail-run",
      provisionalStreamingPolicy: "disabled",
    },
  } as unknown as JsonValue);
  return resolveLlmModuleConfiguration(configuration, descriptor).configuration;
}
