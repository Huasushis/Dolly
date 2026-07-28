import { TextDecoder } from "node:util";
import {
  assertJsonValue,
  canonicalJsonByteLength,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  parseMediaReferenceItem,
  type MediaReferenceItem,
} from "./block-content.js";
import type {
  ChatDescriptorSnapshot,
  ReasoningWireFeatures,
} from "./model-provider-descriptor.js";
import { parseStrictJsonBytes, parseStrictJsonText } from "./strict-json.js";

const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;

/** Requested reasoning behavior before provider-specific request fields are selected. */
export type ReasoningPolicy = "default" | "prefer" | "require" | "disable";
export type ReasoningWireDirective = "omit" | "enable" | "disable";
export type ReasoningObservation =
  | { readonly state: "observed"; readonly parts: readonly string[] }
  | { readonly state: "not-observed" }
  | { readonly state: "unavailable" };

export interface ReasoningPolicyDecision {
  readonly policy: ReasoningPolicy;
  readonly mode: "non-stream" | "stream";
  readonly directive: ReasoningWireDirective;
  readonly requireObserved: boolean;
  readonly preference:
    | "not-requested"
    | "requested"
    | "implicit-always-on"
    | "unsupported";
}

export type ChatPart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "media";
      readonly mediaReference: MediaReferenceItem;
      readonly requirementId: string;
    };

export interface ChatInput {
  readonly schemaVersion: "dolly.model.chat-input/2";
  readonly messages: readonly {
    readonly role: string;
    readonly parts: readonly ChatPart[];
  }[];
  readonly tools?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: JsonValue;
  }[];
  readonly outputContract:
    | { readonly kind: "text" }
    | { readonly kind: "json-schema"; readonly schema: JsonValue };
  readonly reasoning: ReasoningWireDirective;
  readonly stream: boolean;
}

export interface ChatOutput {
  readonly schemaVersion: "dolly.model.chat-output/1";
  readonly finalContent: string;
  readonly reasoning: ReasoningObservation;
  readonly toolCalls: readonly {
    readonly callId: string;
    readonly name: string;
    readonly arguments: JsonValue;
  }[];
  readonly finishReason: string;
}

export interface ChatWirePlan {
  readonly method: "POST";
  readonly routeId: "chat-completions";
  readonly contentType: "application/json";
  readonly body: JsonValue;
  readonly bodyBytes: number;
}

export type ModelChatErrorCode =
  | "CHAT_INPUT_INVALID"
  | "CHAT_FEATURE_UNSUPPORTED"
  | "CHAT_LIMIT_EXCEEDED"
  | "CHAT_STRATEGY_UNSUPPORTED"
  | "CHAT_PROVIDER_PROTOCOL_ERROR"
  | "REASONING_POLICY_UNSATISFIABLE"
  | "REASONING_REQUIRED_NOT_OBSERVED"
  | "CHAT_STREAM_INVALID"
  | "CHAT_STREAM_INCOMPLETE";

export class ModelChatError extends Error {
  constructor(readonly code: ModelChatErrorCode, message: string) {
    super(message);
    this.name = "ModelChatError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closed(
  value: unknown,
  keys: readonly string[],
  label: string,
  code: ModelChatErrorCode = "CHAT_PROVIDER_PROTOCOL_ERROR",
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new ModelChatError(code, `${label} must be an object`);
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ModelChatError(code, `${label} contains unknown fields`);
  }
}

function requireObservationStrategy(
  features: ReasoningWireFeatures,
  mode: ReasoningPolicyDecision["mode"],
): void {
  if (features.observation.state !== "supported") {
    throw new ModelChatError(
      "REASONING_POLICY_UNSATISFIABLE",
      "Required reasoning has no verified observation support",
    );
  }
  const strategy =
    mode === "stream"
      ? features.observation.value.streamStrategyId
      : features.observation.value.nonStreamStrategyId;
  if (!strategy) {
    throw new ModelChatError(
      "REASONING_POLICY_UNSATISFIABLE",
      `Required reasoning has no ${mode} observation strategy`,
    );
  }
}

export function mapReasoningPolicy(
  features: ReasoningWireFeatures,
  policy: ReasoningPolicy,
  mode: ReasoningPolicyDecision["mode"],
): ReasoningPolicyDecision {
  if (policy === "default") {
    return deepFreeze({
      policy,
      mode,
      directive: "omit",
      requireObserved: false,
      preference: "not-requested",
    });
  }

  if (policy === "prefer") {
    if (features.support === "unsupported") {
      return deepFreeze({
        policy,
        mode,
        directive: "omit",
        requireObserved: false,
        preference: "unsupported",
      });
    }
    if (features.support === "always-on") {
      return deepFreeze({
        policy,
        mode,
        directive: "omit",
        requireObserved: false,
        preference: "implicit-always-on",
      });
    }
    return deepFreeze({
      policy,
      mode,
      directive: "enable",
      requireObserved: false,
      preference: "requested",
    });
  }

  if (policy === "require") {
    if (features.support === "unsupported") {
      throw new ModelChatError(
        "REASONING_POLICY_UNSATISFIABLE",
        "Reasoning is required but unsupported",
      );
    }
    requireObservationStrategy(features, mode);
    return deepFreeze({
      policy,
      mode,
      directive: features.support === "always-on" ? "omit" : "enable",
      requireObserved: true,
      preference:
        features.support === "always-on" ? "implicit-always-on" : "requested",
    });
  }

  if (features.support === "always-on") {
    throw new ModelChatError(
      "REASONING_POLICY_UNSATISFIABLE",
      "Reasoning cannot be disabled for an always-on descriptor",
    );
  }
  return deepFreeze({
    policy,
    mode,
    directive: features.support === "request-controlled" ? "disable" : "omit",
    requireObserved: false,
    preference: "not-requested",
  });
}

function assertReasoningDirective(
  features: ReasoningWireFeatures,
  directive: ReasoningWireDirective,
): void {
  if (directive !== "omit" && directive !== "enable" && directive !== "disable") {
    throw new ModelChatError("CHAT_INPUT_INVALID", "Reasoning directive is invalid");
  }
  if (directive === "omit") return;
  if (features.support !== "request-controlled") {
    throw new ModelChatError(
      "REASONING_POLICY_UNSATISFIABLE",
      `Reasoning directive ${directive} is invalid for ${features.support}`,
    );
  }
  if (features.requestControl.kind === "forbidden") {
    throw new ModelChatError(
      "REASONING_POLICY_UNSATISFIABLE",
      "Reasoning request control is forbidden",
    );
  }
}

/**
 * Writes the reasoning control field for the strategy the descriptor selected.
 *
 * There is no single request shape that every endpoint accepts, so each shape
 * is a separately named strategy and a descriptor names the one its endpoint
 * actually honours. Two shapes have installed codecs:
 *
 * - `openai.enable-thinking.boolean.v1` writes the boolean `enable_thinking`
 *   field that the Bailian/DashScope documentation describes for Qwen models.
 * - `thinking-object.enabled-disabled.v1` writes
 *   `{"thinking": {"type": "enabled" | "disabled"}}`, the object form used by
 *   DeepSeek and accepted by at least some Qwen deployments.
 *
 * A descriptor names a strategy because an endpoint honours it, established by
 * observing a response, not because a provider's documentation lists it. The
 * owner found both directions of that gap on the same model: one relay rejects
 * the documented boolean while accepting the object form, and the Bailian
 * endpoint accepts the object form although its documentation describes only
 * the boolean. Neither field is a reliable signal on its own, which is why
 * `reasoning_content` in the response remains the only evidence that deep
 * reasoning actually ran.
 */
function applyReasoningWireField(
  body: Record<string, JsonValue>,
  features: ReasoningWireFeatures,
  directive: ReasoningWireDirective,
): void {
  assertReasoningDirective(features, directive);
  if (directive === "omit") return;
  const control = features.requestControl;
  if (
    control.kind === "boolean-strategy" &&
    control.strategyId === "openai.enable-thinking.boolean.v1"
  ) {
    body.enable_thinking = directive === "enable";
    return;
  }
  if (
    control.kind === "enum-strategy" &&
    control.strategyId === "thinking-object.enabled-disabled.v1"
  ) {
    body.thinking = { type: directive === "enable" ? "enabled" : "disabled" };
    return;
  }
  throw new ModelChatError(
    "CHAT_STRATEGY_UNSUPPORTED",
    "The selected reasoning request strategy has no installed codec",
  );
}

function normalizeInput(snapshot: ChatDescriptorSnapshot, input: ChatInput): JsonValue {
  const descriptor = snapshot.document;
  closed(
    input,
    ["schemaVersion", "messages", "tools", "outputContract", "reasoning", "stream"],
    "chat input",
    "CHAT_INPUT_INVALID",
  );
  if (input.schemaVersion !== "dolly.model.chat-input/2" || typeof input.stream !== "boolean") {
    throw new ModelChatError("CHAT_INPUT_INVALID", "Chat input schema is invalid");
  }
  if (
    input.reasoning !== "omit" &&
    input.reasoning !== "enable" &&
    input.reasoning !== "disable"
  ) {
    throw new ModelChatError("CHAT_INPUT_INVALID", "Reasoning directive is invalid");
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new ModelChatError("CHAT_INPUT_INVALID", "Chat messages must be non-empty");
  }
  if (
    input.messages.length > descriptor.features.maxMessages ||
    input.messages.length > descriptor.limits.maxInputItems
  ) {
    throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Chat message count exceeds its limit");
  }
  if (input.stream && descriptor.limits.streaming.state !== "supported") {
    throw new ModelChatError("CHAT_FEATURE_UNSUPPORTED", "Streaming is not supported");
  }
  if (
    descriptor.adapter.requestStrategyId !== "openai.chat.request.text-parts.v1" ||
    descriptor.features.messageOrderStrategyId !== "openai.chat.message-order.v1"
  ) {
    throw new ModelChatError(
      "CHAT_STRATEGY_UNSUPPORTED",
      "The selected chat request/message strategy has no installed codec",
    );
  }

  let inputBytes = 0;
  const messages = input.messages.map((message, messageIndex): JsonValue => {
    closed(message, ["role", "parts"], `messages[${messageIndex}]`, "CHAT_INPUT_INVALID");
    if (
      typeof message.role !== "string" ||
      !descriptor.features.roles.includes(message.role)
    ) {
      throw new ModelChatError("CHAT_FEATURE_UNSUPPORTED", "Chat role is not supported");
    }
    if (
      !Array.isArray(message.parts) ||
      message.parts.length === 0 ||
      message.parts.length > descriptor.features.maxPartsPerMessage
    ) {
      throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Message part count is invalid");
    }
    const content = message.parts.map((part, partIndex): JsonValue => {
      const label = `messages[${messageIndex}].parts[${partIndex}]`;
      if (!isPlainObject(part)) {
        throw new ModelChatError("CHAT_INPUT_INVALID", `${label} must be an object`);
      }
      if (part.kind === "media") {
        closed(
          part,
          ["kind", "mediaReference", "requirementId"],
          label,
          "CHAT_INPUT_INVALID",
        );
        if (typeof part.requirementId !== "string") {
          throw new ModelChatError(
            "CHAT_INPUT_INVALID",
            `${label}.requirementId must be a string`,
          );
        }
        try {
          parseMediaReferenceItem(part.mediaReference, `${label}.mediaReference`);
        } catch {
          throw new ModelChatError(
            "CHAT_INPUT_INVALID",
            `${label}.mediaReference is invalid`,
          );
        }
        if (!descriptor.features.mediaRequirementIds.includes(part.requirementId)) {
          throw new ModelChatError(
            "CHAT_FEATURE_UNSUPPORTED",
            "Media requirement is not enabled for this chat operation",
          );
        }
        throw new ModelChatError(
          "CHAT_FEATURE_UNSUPPORTED",
          "Media must be resolved by the broker before this text-only wire strategy",
        );
      }
      if (part.kind !== "text") {
        throw new ModelChatError("CHAT_INPUT_INVALID", `${label}.kind is unsupported`);
      }
      closed(part, ["kind", "text"], label, "CHAT_INPUT_INVALID");
      if (typeof part.text !== "string") {
        throw new ModelChatError("CHAT_INPUT_INVALID", "Text part is invalid");
      }
      if (descriptor.input.text.state !== "supported") {
        throw new ModelChatError("CHAT_FEATURE_UNSUPPORTED", "Text input is unsupported");
      }
      const bytes = Buffer.byteLength(part.text, "utf8");
      if (
        bytes > descriptor.input.text.value.maxBytesPerItem ||
        (bytes === 0 && descriptor.input.text.value.empty === "forbidden")
      ) {
        throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Text part exceeds descriptor limits");
      }
      inputBytes += bytes;
      return { type: "text", text: part.text };
    });
    return { role: message.role, content };
  });
  if (inputBytes > descriptor.limits.maxInputBytes) {
    throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Chat input bytes exceed the descriptor");
  }

  const body: Record<string, JsonValue> = {
    model: descriptor.modelId,
    messages,
    stream: input.stream,
  };

  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools) || input.tools.length === 0) {
      throw new ModelChatError("CHAT_INPUT_INVALID", "tools must be an array");
    }
    if (descriptor.features.tools.state !== "supported") {
      throw new ModelChatError("CHAT_FEATURE_UNSUPPORTED", "Tools are unsupported");
    }
    const toolFeature = descriptor.features.tools.value;
    if (toolFeature.strategyId !== "openai.tools.function.v1") {
      throw new ModelChatError("CHAT_STRATEGY_UNSUPPORTED", "Tool strategy is unsupported");
    }
    if (input.tools.length > toolFeature.maxDefinitions) {
      throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Tool definition count exceeds its limit");
    }
    body.tools = input.tools.map((tool, index): JsonValue => {
      closed(tool, ["name", "description", "inputSchema"], `tools[${index}]`, "CHAT_INPUT_INVALID");
      const toolName = tool.name;
      const toolDescription = tool.description;
      const inputSchema = tool.inputSchema;
      if (typeof toolName !== "string" || !TOOL_NAME_PATTERN.test(toolName)) {
        throw new ModelChatError("CHAT_INPUT_INVALID", "Tool name is invalid");
      }
      if (toolDescription !== undefined && typeof toolDescription !== "string") {
        throw new ModelChatError("CHAT_INPUT_INVALID", "Tool description is invalid");
      }
      try {
        assertJsonValue(inputSchema);
      } catch {
        throw new ModelChatError("CHAT_INPUT_INVALID", "Tool input schema is not JSON");
      }
      const schemaBytes = canonicalJsonByteLength(inputSchema);
      if (schemaBytes > toolFeature.maxArgumentBytes) {
        throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Tool schema exceeds its byte limit");
      }
      return {
        type: "function",
        function: {
          name: toolName,
          ...(toolDescription === undefined ? {} : { description: toolDescription }),
          parameters: cloneJson(inputSchema),
        },
      };
    });
  }

  if (!isPlainObject(input.outputContract)) {
    throw new ModelChatError("CHAT_INPUT_INVALID", "Output contract is invalid");
  }
  if (input.outputContract.kind === "json-schema") {
    closed(input.outputContract, ["kind", "schema"], "outputContract", "CHAT_INPUT_INVALID");
    if (descriptor.features.structuredOutput.state !== "supported") {
      throw new ModelChatError(
        "CHAT_FEATURE_UNSUPPORTED",
        "Structured output is unsupported",
      );
    }
    if (
      descriptor.features.structuredOutput.value.strategyId !==
      "openai.response-format.json-schema.v1"
    ) {
      throw new ModelChatError(
        "CHAT_STRATEGY_UNSUPPORTED",
        "Structured-output strategy is unsupported",
      );
    }
    try {
      assertJsonValue(input.outputContract.schema);
    } catch {
      throw new ModelChatError("CHAT_INPUT_INVALID", "Output schema is not JSON");
    }
    const schemaBytes = canonicalJsonByteLength(input.outputContract.schema);
    if (schemaBytes > descriptor.features.structuredOutput.value.maxSchemaBytes) {
      throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Output schema exceeds its byte limit");
    }
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "dolly_output",
        strict: true,
        schema: cloneJson(input.outputContract.schema),
      },
    };
  } else {
    closed(input.outputContract, ["kind"], "outputContract", "CHAT_INPUT_INVALID");
    if (input.outputContract.kind !== "text") {
      throw new ModelChatError("CHAT_INPUT_INVALID", "Output contract is invalid");
    }
  }

  applyReasoningWireField(body, descriptor.features.reasoning, input.reasoning);
  return body;
}

export function encodeOpenAiCompatibleChatRequest(
  snapshot: ChatDescriptorSnapshot,
  input: ChatInput,
  options: { readonly maxOutputTokens?: number } = {},
): ChatWirePlan {
  const body = normalizeInput(snapshot, input) as Record<string, JsonValue>;
  if (options.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0) {
      throw new ModelChatError("CHAT_INPUT_INVALID", "maxOutputTokens is invalid");
    }
    const support = snapshot.document.features.maxOutputTokens;
    if (support.state !== "supported") {
      throw new ModelChatError(
        "CHAT_FEATURE_UNSUPPORTED",
        "A max output token request requires a known supported limit",
      );
    }
    if (options.maxOutputTokens > support.value.maximum) {
      throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "maxOutputTokens exceeds the descriptor");
    }
    body.max_tokens = options.maxOutputTokens;
  }
  const bodyBytes = canonicalJsonByteLength(body);
  if (bodyBytes > snapshot.document.limits.maxRequestBytes) {
    throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Provider request exceeds its byte limit");
  }
  return deepFreeze({
    method: "POST",
    routeId: "chat-completions",
    contentType: "application/json",
    body: cloneJson(body),
    bodyBytes,
  });
}

function reasoningObservation(
  snapshot: ChatDescriptorSnapshot,
  mode: "non-stream" | "stream",
  content: string | undefined,
): ReasoningObservation {
  const observation = snapshot.document.features.reasoning.observation;
  if (observation.state !== "supported") return { state: "unavailable" };
  const strategy =
    mode === "stream"
      ? observation.value.streamStrategyId
      : observation.value.nonStreamStrategyId;
  const expected =
    mode === "stream"
      ? "openai.reasoning-content.stream.v1"
      : "openai.reasoning-content.nonstream.v1";
  if (!strategy) return { state: "unavailable" };
  if (strategy !== expected) {
    throw new ModelChatError(
      "CHAT_STRATEGY_UNSUPPORTED",
      "The selected reasoning observation strategy has no installed codec",
    );
  }
  return content !== undefined && content.trim().length > 0
    ? { state: "observed", parts: [content] }
    : { state: "not-observed" };
}

function enforceReasoningDecision(
  decision: ReasoningPolicyDecision | undefined,
  observation: ReasoningObservation,
): void {
  if (decision?.requireObserved && observation.state !== "observed") {
    throw new ModelChatError(
      "REASONING_REQUIRED_NOT_OBSERVED",
      "The provider response did not contain verified non-empty reasoning",
    );
  }
}

function parseToolCalls(
  snapshot: ChatDescriptorSnapshot,
  value: unknown,
): ChatOutput["toolCalls"] {
  if (value === undefined) return [];
  const support = snapshot.document.features.tools;
  if (support.state !== "supported") {
    throw new ModelChatError(
      "CHAT_PROVIDER_PROTOCOL_ERROR",
      "Provider returned tool calls for an unsupported feature",
    );
  }
  if (!Array.isArray(value) || value.length > support.value.maxDefinitions) {
    throw new ModelChatError("CHAT_PROVIDER_PROTOCOL_ERROR", "Provider tool calls are invalid");
  }
  if (!support.value.parallelCalls && value.length > 1) {
    throw new ModelChatError(
      "CHAT_PROVIDER_PROTOCOL_ERROR",
      "Provider returned parallel calls when they are unsupported",
    );
  }
  const callIds = new Set<string>();
  return value.map((candidate, index) => {
    closed(candidate, ["id", "type", "function"], `tool_calls[${index}]`);
    if (
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      callIds.has(candidate.id) ||
      candidate.type !== "function"
    ) {
      throw new ModelChatError(
        "CHAT_PROVIDER_PROTOCOL_ERROR",
        "Provider tool call identity is invalid",
      );
    }
    callIds.add(candidate.id);
    closed(candidate.function, ["name", "arguments"], `tool_calls[${index}].function`);
    if (
      typeof candidate.function.name !== "string" ||
      !TOOL_NAME_PATTERN.test(candidate.function.name) ||
      typeof candidate.function.arguments !== "string"
    ) {
      throw new ModelChatError(
        "CHAT_PROVIDER_PROTOCOL_ERROR",
        "Provider tool call function is invalid",
      );
    }
    const argumentBytes = Buffer.byteLength(candidate.function.arguments, "utf8");
    if (argumentBytes > support.value.maxArgumentBytes) {
      throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Tool arguments exceed their byte limit");
    }
    let args: JsonValue;
    try {
      args = parseStrictJsonText(candidate.function.arguments, {
        maxBytes: support.value.maxArgumentBytes,
        maxDepth: 64,
      });
    } catch {
      throw new ModelChatError(
        "CHAT_PROVIDER_PROTOCOL_ERROR",
        "Provider tool arguments are not strict JSON",
      );
    }
    return deepFreeze({
      callId: candidate.id,
      name: candidate.function.name,
      arguments: args,
    });
  });
}

function validateProviderEnvelope(value: unknown): Record<string, unknown> {
  closed(
    value,
    ["id", "object", "created", "model", "system_fingerprint", "choices", "usage"],
    "provider response",
  );
  if (typeof value.id !== "string" || value.id.length === 0 || !Array.isArray(value.choices)) {
    throw new ModelChatError(
      "CHAT_PROVIDER_PROTOCOL_ERROR",
      "Provider response identity or choices are invalid",
    );
  }
  return value;
}

export function decodeOpenAiCompatibleChatResponse(
  snapshot: ChatDescriptorSnapshot,
  bytes: Uint8Array,
  decision?: ReasoningPolicyDecision,
): ChatOutput {
  if (decision && decision.mode !== "non-stream") {
    throw new ModelChatError(
      "CHAT_INPUT_INVALID",
      "A non-stream response requires a non-stream reasoning decision",
    );
  }
  if (snapshot.document.adapter.responseStrategyId !== "openai.chat.response.v1") {
    throw new ModelChatError(
      "CHAT_STRATEGY_UNSUPPORTED",
      "The selected response strategy has no installed codec",
    );
  }
  let value: JsonValue;
  try {
    value = parseStrictJsonBytes(bytes, {
      maxBytes: snapshot.document.limits.maxResponseBytes,
      maxDepth: 128,
    });
  } catch {
    throw new ModelChatError(
      "CHAT_PROVIDER_PROTOCOL_ERROR",
      "Provider response is not bounded strict JSON",
    );
  }
  const envelope = validateProviderEnvelope(value);
  if ((envelope.choices as unknown[]).length !== 1) {
    throw new ModelChatError(
      "CHAT_PROVIDER_PROTOCOL_ERROR",
      "Provider response must contain exactly one choice",
    );
  }
  const choice = (envelope.choices as unknown[])[0];
  closed(choice, ["index", "message", "finish_reason", "logprobs"], "provider choice");
  if (choice.index !== 0 || typeof choice.finish_reason !== "string") {
    throw new ModelChatError("CHAT_PROVIDER_PROTOCOL_ERROR", "Provider choice is invalid");
  }
  if (!snapshot.document.features.finishReasons.includes(choice.finish_reason)) {
    throw new ModelChatError(
      "CHAT_PROVIDER_PROTOCOL_ERROR",
      "Provider returned an undeclared finish reason",
    );
  }
  closed(
    choice.message,
    ["role", "content", "reasoning_content", "tool_calls", "refusal"],
    "provider message",
  );
  if (choice.message.role !== "assistant") {
    throw new ModelChatError("CHAT_PROVIDER_PROTOCOL_ERROR", "Provider role is invalid");
  }
  if (choice.message.content !== null && typeof choice.message.content !== "string") {
    throw new ModelChatError("CHAT_PROVIDER_PROTOCOL_ERROR", "Provider content is invalid");
  }
  if (
    choice.message.reasoning_content !== undefined &&
    choice.message.reasoning_content !== null &&
    typeof choice.message.reasoning_content !== "string"
  ) {
    throw new ModelChatError(
      "CHAT_PROVIDER_PROTOCOL_ERROR",
      "Provider reasoning channel is invalid",
    );
  }
  const toolCalls = parseToolCalls(snapshot, choice.message.tool_calls);
  const finalContent = choice.message.content ?? "";
  const reasoningContent =
    typeof choice.message.reasoning_content === "string"
      ? choice.message.reasoning_content
      : undefined;
  const outputBytes =
    Buffer.byteLength(finalContent, "utf8") +
    (reasoningContent === undefined ? 0 : Buffer.byteLength(reasoningContent, "utf8")) +
    toolCalls.reduce(
      (total, call) => total + canonicalJsonByteLength(call.arguments),
      0,
    );
  if (outputBytes > snapshot.document.limits.maxOutputBytes) {
    throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Provider output exceeds its byte limit");
  }
  const observation = reasoningObservation(snapshot, "non-stream", reasoningContent);
  enforceReasoningDecision(decision, observation);
  if (
    (choice.finish_reason === "tool_calls" && toolCalls.length === 0) ||
    (choice.finish_reason !== "tool_calls" && toolCalls.length > 0)
  ) {
    throw new ModelChatError(
      "CHAT_PROVIDER_PROTOCOL_ERROR",
      "Provider finish reason does not match its tool-call result",
    );
  }
  return deepFreeze({
    schemaVersion: "dolly.model.chat-output/1",
    finalContent,
    reasoning: observation,
    toolCalls,
    finishReason: choice.finish_reason,
  });
}

export class OpenAiCompatibleChatStreamDecoder {
  readonly #snapshot: ChatDescriptorSnapshot;
  readonly #decision?: ReasoningPolicyDecision;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = "";
  #responseBytes = 0;
  #eventCount = 0;
  #finalParts: string[] = [];
  #reasoningParts: string[] = [];
  #outputBytes = 0;
  #finishReason: string | undefined;
  #providerId: string | undefined;
  #done = false;
  #ended = false;

  constructor(snapshot: ChatDescriptorSnapshot, decision?: ReasoningPolicyDecision) {
    if (
      snapshot.document.adapter.streamStrategyId !== "openai.chat.stream.sse.v1" ||
      snapshot.document.limits.streaming.state !== "supported"
    ) {
      throw new ModelChatError(
        "CHAT_STRATEGY_UNSUPPORTED",
        "The selected stream strategy has no installed codec",
      );
    }
    if (decision && decision.mode !== "stream") {
      throw new ModelChatError("CHAT_INPUT_INVALID", "A stream decoder requires a stream decision");
    }
    this.#snapshot = snapshot;
    this.#decision = decision;
  }

  push(chunk: Uint8Array): void {
    if (this.#done || this.#ended) {
      throw new ModelChatError("CHAT_STREAM_INVALID", "Provider emitted data after stream terminal");
    }
    this.#responseBytes += chunk.byteLength;
    if (this.#responseBytes > this.#snapshot.document.limits.maxResponseBytes) {
      throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Provider stream exceeds its byte limit");
    }
    try {
      this.#buffer += this.#decoder.decode(chunk, { stream: true });
    } catch {
      throw new ModelChatError("CHAT_STREAM_INVALID", "Provider stream is not valid UTF-8");
    }
    this.#assertBufferLimit();
    this.#drainEvents();
  }

  end(): ChatOutput {
    if (this.#ended) {
      throw new ModelChatError("CHAT_STREAM_INVALID", "Provider stream was already ended");
    }
    this.#ended = true;
    try {
      this.#buffer += this.#decoder.decode();
    } catch {
      throw new ModelChatError("CHAT_STREAM_INVALID", "Provider stream ended mid UTF-8 sequence");
    }
    this.#assertBufferLimit();
    this.#drainEvents();
    if (this.#buffer.trim().length !== 0) {
      throw new ModelChatError("CHAT_STREAM_INCOMPLETE", "Provider stream ended mid SSE event");
    }
    if (!this.#done || this.#finishReason === undefined) {
      throw new ModelChatError("CHAT_STREAM_INCOMPLETE", "Provider stream has no terminal event");
    }
    const reasoningContent = this.#reasoningParts.join("");
    const observation = reasoningObservation(
      this.#snapshot,
      "stream",
      reasoningContent.length === 0 ? undefined : reasoningContent,
    );
    enforceReasoningDecision(this.#decision, observation);
    return deepFreeze({
      schemaVersion: "dolly.model.chat-output/1",
      finalContent: this.#finalParts.join(""),
      reasoning: observation,
      toolCalls: [],
      finishReason: this.#finishReason,
    });
  }

  #assertBufferLimit(): void {
    const streaming = this.#snapshot.document.limits.streaming;
    if (
      streaming.state !== "supported" ||
      Buffer.byteLength(this.#buffer, "utf8") > streaming.value.maxBufferedBytes
    ) {
      throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Buffered provider stream exceeds its limit");
    }
  }

  #drainEvents(): void {
    for (;;) {
      const match = /\r?\n\r?\n/u.exec(this.#buffer);
      if (!match || match.index === undefined) return;
      const event = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      if (event.trim().length === 0) continue;
      this.#acceptSseEvent(event);
      if (this.#done && this.#buffer.trim().length !== 0) {
        throw new ModelChatError("CHAT_STREAM_INVALID", "Provider emitted data after [DONE]");
      }
    }
  }

  #acceptSseEvent(event: string): void {
    const streaming = this.#snapshot.document.limits.streaming;
    if (streaming.state !== "supported") {
      throw new ModelChatError("CHAT_FEATURE_UNSUPPORTED", "Streaming is unsupported");
    }
    this.#eventCount += 1;
    if (this.#eventCount > streaming.value.maxEvents) {
      throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Provider stream event count exceeds its limit");
    }
    const data: string[] = [];
    for (const line of event.split(/\r?\n/u)) {
      if (line.startsWith(":")) continue;
      if (line === "event: message" || line === "event:message") continue;
      if (!line.startsWith("data:")) {
        throw new ModelChatError("CHAT_STREAM_INVALID", "Provider SSE field is unsupported");
      }
      data.push(line.slice(5).replace(/^ /u, ""));
    }
    if (data.length === 0) {
      throw new ModelChatError("CHAT_STREAM_INVALID", "Provider SSE event has no data");
    }
    const payload = data.join("\n");
    if (payload === "[DONE]") {
      if (this.#finishReason === undefined) {
        throw new ModelChatError("CHAT_STREAM_INCOMPLETE", "[DONE] arrived before finish reason");
      }
      this.#done = true;
      return;
    }

    let value: JsonValue;
    try {
      value = parseStrictJsonText(payload, {
        maxBytes: streaming.value.maxBufferedBytes,
        maxDepth: 128,
      });
    } catch {
      throw new ModelChatError("CHAT_STREAM_INVALID", "Provider SSE data is not strict JSON");
    }
    const envelope = validateProviderEnvelope(value);
    if (this.#providerId === undefined) this.#providerId = envelope.id as string;
    if (this.#providerId !== envelope.id) {
      throw new ModelChatError("CHAT_STREAM_INVALID", "Provider stream identity changed");
    }
    const choices = envelope.choices as unknown[];
    if (choices.length === 0) {
      if (envelope.usage === undefined) {
        throw new ModelChatError(
          "CHAT_STREAM_INVALID",
          "A choice-less provider event must carry usage",
        );
      }
      return;
    }
    if (choices.length !== 1) {
      throw new ModelChatError("CHAT_STREAM_INVALID", "Provider stream choice count is invalid");
    }
    const choice = choices[0];
    closed(choice, ["index", "delta", "finish_reason", "logprobs"], "stream choice", "CHAT_STREAM_INVALID");
    if (choice.index !== 0) {
      throw new ModelChatError("CHAT_STREAM_INVALID", "Provider stream choice index is invalid");
    }
    closed(
      choice.delta,
      ["role", "content", "reasoning_content", "tool_calls", "refusal"],
      "stream delta",
      "CHAT_STREAM_INVALID",
    );
    if (choice.delta.role !== undefined && choice.delta.role !== "assistant") {
      throw new ModelChatError("CHAT_STREAM_INVALID", "Provider stream role is invalid");
    }
    if (choice.delta.tool_calls !== undefined) {
      throw new ModelChatError(
        "CHAT_STRATEGY_UNSUPPORTED",
        "Streaming tool-call assembly is not implemented by this codec version",
      );
    }
    this.#appendPart(choice.delta.content, this.#finalParts, "final");
    this.#appendPart(choice.delta.reasoning_content, this.#reasoningParts, "reasoning");
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      if (
        typeof choice.finish_reason !== "string" ||
        !this.#snapshot.document.features.finishReasons.includes(choice.finish_reason) ||
        (this.#finishReason !== undefined && this.#finishReason !== choice.finish_reason)
      ) {
        throw new ModelChatError("CHAT_STREAM_INVALID", "Provider finish reason is invalid");
      }
      this.#finishReason = choice.finish_reason;
    }
  }

  #appendPart(value: unknown, destination: string[], channel: string): void {
    if (value === undefined || value === null) return;
    if (typeof value !== "string") {
      throw new ModelChatError("CHAT_STREAM_INVALID", `Provider ${channel} delta is invalid`);
    }
    if (this.#finishReason !== undefined && value.length > 0) {
      throw new ModelChatError("CHAT_STREAM_INVALID", "Provider emitted content after finish reason");
    }
    this.#outputBytes += Buffer.byteLength(value, "utf8");
    if (this.#outputBytes > this.#snapshot.document.limits.maxOutputBytes) {
      throw new ModelChatError("CHAT_LIMIT_EXCEEDED", "Provider output exceeds its byte limit");
    }
    destination.push(value);
  }
}
