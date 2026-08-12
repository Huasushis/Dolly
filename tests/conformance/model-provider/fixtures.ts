import type {
  ChatDescriptorDocument,
  ReasoningWireFeatures,
} from "../../../src/core/model-provider-descriptor.js";
import type {
  EmbeddingDescriptorDocument,
  EmbeddingFeatures,
} from "../../../src/core/model-provider-embedding.js";

export const CHAT_STRATEGIES = new Set([
  "openai.chat.request.text-parts.v1",
  "openai.chat.request.content-parts.v1",
  "openai.chat.response.v1",
  "openai.chat.stream.sse.v1",
  "openai.chat.message-order.v1",
  "openai.reasoning-content.nonstream.v1",
  "openai.reasoning-content.stream.v1",
  "openai.enable-thinking.boolean.v1",
  "thinking-object.enabled-disabled.v1",
  "openai.response-format.json-object.v1",
  "media.inline-copy.v1",
  "openai.chat.media.inline-image-url.v1",
]);

export const EMBEDDING_STRATEGIES = new Set([
  "openai.embedding.request.text.fixed.v1",
  "openai.embedding.request.text.dimensions.v1",
  "openai.embedding.response.position.v1",
  "embedding.vector.json-number-array.v1",
  "fixture.native-vl.request.v1",
  "fixture.native-vl.response.v1",
  "fixture.text-image.composite.v1",
  "media.provider-access-lease.v1",
  "media.inline-or-private-signed.v1",
]);

export function alwaysOnReasoning(): ReasoningWireFeatures {
  return {
    support: "always-on",
    requestControl: { kind: "forbidden" },
    observation: {
      state: "supported",
      value: {
        nonStreamStrategyId: "openai.reasoning-content.nonstream.v1",
        streamStrategyId: "openai.reasoning-content.stream.v1",
        empty: "not-observed",
      },
    },
    replay: { requirement: "forbidden" },
  };
}

export function requestControlledReasoning(): ReasoningWireFeatures {
  return {
    support: "request-controlled",
    requestControl: {
      kind: "boolean-strategy",
      strategyId: "openai.enable-thinking.boolean.v1",
    },
    observation: {
      state: "supported",
      value: {
        nonStreamStrategyId: "openai.reasoning-content.nonstream.v1",
        streamStrategyId: "openai.reasoning-content.stream.v1",
        empty: "not-observed",
      },
    },
    replay: { requirement: "forbidden" },
  };
}

/**
 * The object-form reasoning control, which DeepSeek uses and which at least
 * some Qwen deployments accept in place of, or alongside, `enable_thinking`.
 */
export function objectFormReasoning(): ReasoningWireFeatures {
  return {
    support: "request-controlled",
    requestControl: {
      kind: "enum-strategy",
      strategyId: "thinking-object.enabled-disabled.v1",
    },
    observation: {
      state: "supported",
      value: {
        nonStreamStrategyId: "openai.reasoning-content.nonstream.v1",
        streamStrategyId: "openai.reasoning-content.stream.v1",
        empty: "not-observed",
      },
    },
    replay: { requirement: "forbidden" },
  };
}

export function chatDescriptor(options: {
  endpointId?: string;
  modelId?: string;
  descriptorVersion?: string;
  reasoning?: ReasoningWireFeatures;
  maxRequestBytes?: number;
  jsonObjectOutput?: "supported" | "unsupported";
  inlinePng?: boolean;
} = {}): ChatDescriptorDocument {
  const schemaVersion =
    options.jsonObjectOutput === undefined
      ? "dolly.model-descriptor/3" as const
      : "dolly.model-descriptor/4" as const;
  return {
    schemaVersion,
    descriptorVersion: options.descriptorVersion ?? "v1",
    endpointId: options.endpointId ?? "fixture-chat-endpoint",
    operation: "chat-completion",
    modelId: options.modelId ?? "fixture-reasoner-27b",
    adapter: {
      id: "openai-compatible-chat",
      version: "v1",
      requestStrategyId: options.inlinePng
        ? "openai.chat.request.content-parts.v1"
        : "openai.chat.request.text-parts.v1",
      responseStrategyId: "openai.chat.response.v1",
      streamStrategyId: "openai.chat.stream.sse.v1",
    },
    limits: {
      maxRequestBytes: options.maxRequestBytes ?? 64 * 1024,
      maxResponseBytes: 64 * 1024,
      maxInputItems: 64,
      maxInputBytes: 48 * 1024,
      maxOutputBytes: 32 * 1024,
      maxConcurrentRequests: 2,
      maxProviderTimeoutMs: 30_000,
      streaming: {
        state: "supported",
        value: { maxEvents: 1024, maxBufferedBytes: 64 * 1024 },
      },
    },
    input: {
      modalities: options.inlinePng ? ["text", "image"] : ["text"],
      text: {
        state: "supported",
        value: { maxBytesPerItem: 16 * 1024, empty: "forbidden" },
      },
      media: options.inlinePng
        ? [{
            requirementId: "inline-png-v1",
            modality: "image",
            mimeTypes: ["image/png"],
            deliveryModes: ["inline"],
            maxItems: 2,
            maxBytesPerItem: 16 * 1024,
            maxAggregateBytes: 24 * 1024,
            providerFetchesAfterAcceptance: false,
            lifetimeStrategyId: "media.inline-copy.v1",
            placementStrategyId: "openai.chat.media.inline-image-url.v1",
          }]
        : [],
    },
    retry: {
      maxProviderAttempts: 1,
      safeConditions: ["before-dispatch"],
      providerIdempotency: { state: "unsupported" },
    },
    features: {
      roles: ["system", "user", "assistant", "tool"],
      messageOrderStrategyId: "openai.chat.message-order.v1",
      maxMessages: 64,
      maxPartsPerMessage: 16,
      contextWindowTokens: { state: "supported", value: { maximum: 32_768 } },
      maxOutputTokens: { state: "supported", value: { maximum: 4096 } },
      mediaRequirementIds: options.inlinePng ? ["inline-png-v1"] : [],
      tools: { state: "unsupported" },
      structuredOutput: { state: "unsupported" },
      ...(options.jsonObjectOutput === undefined
        ? {}
        : {
            jsonObjectOutput:
              options.jsonObjectOutput === "supported"
                ? {
                    state: "supported" as const,
                    value: { strategyId: "openai.response-format.json-object.v1" },
                  }
                : { state: "unsupported" as const },
          }),
      reasoning: options.reasoning ?? alwaysOnReasoning(),
      finishReasons: ["stop", "length", "tool_calls"],
    },
  };
}

export function textEmbeddingDescriptor(options: {
  endpointId?: string;
  modelId?: string;
  descriptorVersion?: string;
  dimensions?: EmbeddingFeatures["dimensions"];
  normalization?: EmbeddingFeatures["normalization"];
  vectorSpaceId?: string;
  comparableModalitySets?: readonly (readonly string[])[];
  requestStrategyId?: string;
} = {}): EmbeddingDescriptorDocument {
  const dimensions = options.dimensions ?? { kind: "fixed", value: 3 };
  return {
    schemaVersion: "dolly.model-descriptor/3",
    descriptorVersion: options.descriptorVersion ?? "v1",
    endpointId: options.endpointId ?? "fixture-text-embedding-endpoint",
    operation: "embedding",
    modelId: options.modelId ?? "fixture-text-embedding-model",
    adapter: {
      id: "openai-compatible-embedding",
      version: "v1",
      requestStrategyId:
        options.requestStrategyId ??
        (dimensions.kind === "fixed"
          ? "openai.embedding.request.text.fixed.v1"
          : "openai.embedding.request.text.dimensions.v1"),
      responseStrategyId: "openai.embedding.response.position.v1",
    },
    limits: {
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 64 * 1024,
      maxInputItems: 16,
      maxInputBytes: 48 * 1024,
      maxOutputBytes: 48 * 1024,
      maxConcurrentRequests: 2,
      maxProviderTimeoutMs: 30_000,
      streaming: { state: "inapplicable" },
    },
    input: {
      modalities: ["text"],
      text: {
        state: "supported",
        value: { maxBytesPerItem: 8 * 1024, empty: "forbidden" },
      },
      media: [],
    },
    retry: {
      maxProviderAttempts: 1,
      safeConditions: ["before-dispatch"],
      providerIdempotency: { state: "unsupported" },
    },
    features: {
      itemKinds: ["text"],
      mediaRequirementIds: [],
      compositeStrategyIds: [],
      dimensions,
      numericEncoding: "json-number-array.v1",
      decodeStrategyId: "embedding.vector.json-number-array.v1",
      maxBatchItems: 8,
      maxPartsPerItem: 8,
      normalization: options.normalization ?? { kind: "not-normalized" },
      metric: { kind: "cosine" },
      vectorSpaceId: options.vectorSpaceId ?? "fixture-text-vector-space-v1",
      comparableModalitySets: options.comparableModalitySets ?? [],
      perItemErrors: { state: "unsupported" },
      postProcessing: { state: "unsupported" },
    },
  };
}

export function nativeVlEmbeddingDescriptor(options: {
  endpointId?: string;
  modelId?: string;
  descriptorVersion?: string;
  comparableModalitySets?: readonly (readonly string[])[];
} = {}): EmbeddingDescriptorDocument {
  return {
    schemaVersion: "dolly.model-descriptor/3",
    descriptorVersion: options.descriptorVersion ?? "v1",
    endpointId: options.endpointId ?? "fixture-native-vl-endpoint",
    operation: "embedding",
    modelId: options.modelId ?? "fixture-native-vl-model",
    adapter: {
      id: "fixture-native-vl-embedding",
      version: "v1",
      requestStrategyId: "fixture.native-vl.request.v1",
      responseStrategyId: "fixture.native-vl.response.v1",
    },
    limits: {
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 64 * 1024,
      maxInputItems: 16,
      maxInputBytes: 48 * 1024,
      maxOutputBytes: 48 * 1024,
      maxConcurrentRequests: 2,
      maxProviderTimeoutMs: 30_000,
      streaming: { state: "inapplicable" },
    },
    input: {
      modalities: ["text", "image"],
      text: {
        state: "supported",
        value: { maxBytesPerItem: 8 * 1024, empty: "forbidden" },
      },
      media: [
        {
          requirementId: "native-image-input-v1",
          modality: "image",
          mimeTypes: ["image/jpeg", "image/png"],
          deliveryModes: ["private-signed", "inline"],
          maxItems: 8,
          maxBytesPerItem: 8 * 1024 * 1024,
          maxAggregateBytes: 16 * 1024 * 1024,
          providerFetchesAfterAcceptance: true,
          lifetimeStrategyId: "media.provider-access-lease.v1",
          placementStrategyId: "media.inline-or-private-signed.v1",
        },
      ],
    },
    retry: {
      maxProviderAttempts: 1,
      safeConditions: ["before-dispatch"],
      providerIdempotency: { state: "unsupported" },
    },
    features: {
      itemKinds: ["text", "media", "multimodal"],
      mediaRequirementIds: ["native-image-input-v1"],
      compositeStrategyIds: ["fixture.text-image.composite.v1"],
      dimensions: { kind: "fixed", value: 4 },
      numericEncoding: "json-number-array.v1",
      decodeStrategyId: "embedding.vector.json-number-array.v1",
      maxBatchItems: 8,
      maxPartsPerItem: 8,
      normalization: { kind: "unit", tolerance: 0.0001 },
      metric: { kind: "cosine" },
      vectorSpaceId: "fixture-native-vl-space-v1",
      comparableModalitySets: options.comparableModalitySets ?? [["text", "image"]],
      perItemErrors: { state: "unsupported" },
      postProcessing: { state: "unsupported" },
    },
  };
}
