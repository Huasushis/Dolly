import { describe, expect, it } from "vitest";
import {
  ModelChatError,
  OpenAiCompatibleChatStreamDecoder,
  decodeOpenAiCompatibleChatResponse,
  encodeOpenAiCompatibleChatRequest,
  mapReasoningPolicy,
  type ChatInput,
  type ReasoningPolicyDecision,
} from "../../../src/core/model-provider-chat.js";
import {
  ModelDescriptorRegistry,
  type ChatDescriptorSnapshot,
  type ReasoningWireFeatures,
} from "../../../src/core/model-provider-descriptor.js";
import {
  CHAT_STRATEGIES,
  alwaysOnReasoning,
  chatDescriptor,
  objectFormReasoning,
  requestControlledReasoning,
} from "./fixtures.js";

const SCHEMA_DIGEST = `sha256:${"c".repeat(64)}`;

function activeSnapshot(options: Parameters<typeof chatDescriptor>[0] = {}): ChatDescriptorSnapshot {
  const registry = new ModelDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: CHAT_STRATEGIES,
  });
  const ref = registry.register(chatDescriptor(options));
  registry.setStatus(ref, "active");
  return registry.snapshot(ref);
}

function textInput(
  reasoning: ChatInput["reasoning"] = "omit",
  stream = false,
): ChatInput {
  return {
    schemaVersion: "dolly.model.chat-input/2",
    messages: [
      { role: "system", parts: [{ kind: "text", text: "Be precise." }] },
      { role: "user", parts: [{ kind: "text", text: "What is 2 + 2?" }] },
    ],
    outputContract: { kind: "text" },
    reasoning,
    stream,
  };
}

function nonStreamResponse(options: {
  content?: string | null;
  reasoningContent?: string | null;
  finishReason?: string;
} = {}): Uint8Array {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: options.content === undefined ? "4" : options.content,
  };
  if (options.reasoningContent !== undefined) {
    message.reasoning_content = options.reasoningContent;
  }
  return Buffer.from(
    JSON.stringify({
      id: "chatcmpl-fixture",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message,
          finish_reason: options.finishReason ?? "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }),
  );
}

function unsupportedReasoning(): ReasoningWireFeatures {
  return {
    support: "unsupported",
    requestControl: { kind: "forbidden" },
    observation: { state: "unsupported" },
    replay: { requirement: "forbidden" },
  };
}

function sseEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function streamPayload(reasoningParts = ["推", "理"], finalParts = ["答", "案"]): Buffer {
  const events = [
    {
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    ...reasoningParts.map((part) => ({
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { reasoning_content: part }, finish_reason: null }],
    })),
    ...finalParts.map((part, index) => ({
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { content: part },
          finish_reason: index === finalParts.length - 1 ? "stop" : null,
        },
      ],
    })),
  ];
  return Buffer.from(`${events.map(sseEvent).join("")}data: [DONE]\n\n`, "utf8");
}

function decodeStream(
  snapshot: ChatDescriptorSnapshot,
  decision: ReasoningPolicyDecision,
  payload: Buffer,
  chunkSize: number,
) {
  const decoder = new OpenAiCompatibleChatStreamDecoder(snapshot, decision);
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    decoder.push(payload.subarray(offset, Math.min(offset + chunkSize, payload.length)));
  }
  return decoder.end();
}

describe("descriptor-bound chat reasoning wire behavior", () => {
  it("decodes only the measured closed Aether Qwen response envelope", () => {
    const document = chatDescriptor({
      endpointId: "owner-aether-fixture",
      modelId: "qwen3.6-27b",
      reasoning: objectFormReasoning(),
    });
    const registry = new ModelDescriptorRegistry({
      schemaDigest: SCHEMA_DIGEST,
      allowedStrategyIds: new Set([...CHAT_STRATEGIES, "aether.qwen.chat.response.v2"]),
    });
    const ref = registry.register({
      ...document,
      adapter: {
        ...document.adapter,
        responseStrategyId: "aether.qwen.chat.response.v2",
      },
    });
    registry.setStatus(ref, "active");
    const snapshot = registry.snapshot(ref);
    const decision = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "require",
      "non-stream",
    );
    const measured = {
      choices: [{
        finish_reason: "stop",
        index: 0,
        message: {
          content: '{"answer":"EMBER-7421"}',
          provider_specific_fields: { refusal: null },
          reasoning_content: "ground the answer in the fetched record",
          role: "assistant",
        },
        provider_specific_fields: {},
      }],
      error: null,
      model: "qwen3.6-reasoner",
      usage: {
        completion_tokens: 42,
        prompt_tokens: 12,
        prompt_tokens_details: null,
        total_tokens: 54,
      },
    };

    expect(
      decodeOpenAiCompatibleChatResponse(
        snapshot,
        Buffer.from(JSON.stringify(measured)),
        decision,
      ),
    ).toMatchObject({
      finalContent: '{"answer":"EMBER-7421"}',
      finishReason: "stop",
      reasoning: {
        state: "observed",
        parts: ["ground the answer in the fetched record"],
      },
    });

    const currentEnvelope = {
      id: "chatcmpl-current",
      object: "chat.completion",
      created: 1_786_293_600,
      model: measured.model,
      choices: measured.choices,
      usage: measured.usage,
    };
    expect(
      decodeOpenAiCompatibleChatResponse(
        snapshot,
        Buffer.from(JSON.stringify(currentEnvelope)),
        decision,
      ),
    ).toMatchObject({
      finalContent: '{"answer":"EMBER-7421"}',
      finishReason: "stop",
    });

    for (const mutation of [
      { ...measured, id: "silently-opened" },
      { ...measured, error: { message: "provider failure" } },
      {
        ...measured,
        choices: [{ ...measured.choices[0], provider_specific_fields: { new_field: true } }],
      },
      {
        ...measured,
        choices: [{
          ...measured.choices[0],
          message: {
            ...measured.choices[0].message,
            provider_specific_fields: { refusal: "blocked" },
          },
        }],
      },
    ]) {
      expect(() =>
        decodeOpenAiCompatibleChatResponse(
          snapshot,
          Buffer.from(JSON.stringify(mutation)),
          decision,
        )
      ).toThrowError(ModelChatError);
    }
  });

  it("uses the measured Aether object control for on, off, and endpoint default", () => {
    const snapshot = activeSnapshot({
      endpointId: "owner-aether-fixture",
      modelId: "qwen3.6-27b",
      reasoning: objectFormReasoning(),
    });
    const required = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "require",
      "non-stream",
    );
    const disabled = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "disable",
      "non-stream",
    );
    const endpointDefault = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "default",
      "non-stream",
    );
    expect(required).toMatchObject({ directive: "enable", requireObserved: true });
    expect(disabled).toMatchObject({ directive: "disable", requireObserved: false });
    expect(endpointDefault).toMatchObject({ directive: "omit", requireObserved: false });

    const commonBody = {
      model: "qwen3.6-27b",
      messages: [
        { role: "system", content: [{ type: "text", text: "Be precise." }] },
        { role: "user", content: [{ type: "text", text: "What is 2 + 2?" }] },
      ],
      stream: false,
      max_tokens: 256,
    };
    const enabledBody = encodeOpenAiCompatibleChatRequest(
      snapshot,
      textInput(required.directive),
      { maxOutputTokens: 256 },
    ).body;
    const disabledBody = encodeOpenAiCompatibleChatRequest(
      snapshot,
      textInput(disabled.directive),
      { maxOutputTokens: 256 },
    ).body;
    const endpointDefaultBody = encodeOpenAiCompatibleChatRequest(
      snapshot,
      textInput(endpointDefault.directive),
      { maxOutputTokens: 256 },
    ).body;

    expect(enabledBody).toEqual({
      ...commonBody,
      thinking: { type: "enabled" },
    });
    expect(disabledBody).toEqual({
      ...commonBody,
      thinking: { type: "disabled" },
    });
    // This deployment reasons by default. Omitting both controls preserves that
    // measured endpoint behavior without pretending the descriptor proves it.
    expect(endpointDefaultBody).toEqual(commonBody);

    for (const body of [enabledBody, disabledBody, endpointDefaultBody]) {
      expect(body).not.toHaveProperty("enable_thinking");
      expect(body).not.toHaveProperty("extra_body");
      expect(JSON.stringify(body)).not.toContain("owner-aether-fixture");
      expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|base[_-]?url/i);
    }
  });

  it("maps boolean request control only for a descriptor that explicitly declares it", () => {
    const snapshot = activeSnapshot({ reasoning: requestControlledReasoning() });
    const prefer = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "prefer",
      "non-stream",
    );
    const disabled = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "disable",
      "non-stream",
    );
    const defaultDecision = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "default",
      "non-stream",
    );

    expect(encodeOpenAiCompatibleChatRequest(snapshot, textInput(prefer.directive)).body)
      .toHaveProperty("enable_thinking", true);
    expect(encodeOpenAiCompatibleChatRequest(snapshot, textInput(disabled.directive)).body)
      .toHaveProperty("enable_thinking", false);
    expect(encodeOpenAiCompatibleChatRequest(snapshot, textInput(defaultDecision.directive)).body)
      .not.toHaveProperty("enable_thinking");
  });

  it("maps the object-form request control only for a descriptor that declares it", () => {
    // DeepSeek controls reasoning with `{"thinking": {"type": "enabled"}}`,
    // and the owner measured that shape working on a Qwen relay that rejects
    // `enable_thinking`, and on the Bailian endpoint whose documentation does
    // not mention it. Each shape is therefore its own named strategy, selected
    // by the descriptor for the endpoint that was observed to honour it.
    const snapshot = activeSnapshot({ reasoning: objectFormReasoning() });
    const features = snapshot.document.features.reasoning;
    const prefer = mapReasoningPolicy(features, "prefer", "non-stream");
    const disabled = mapReasoningPolicy(features, "disable", "non-stream");
    const defaultDecision = mapReasoningPolicy(features, "default", "non-stream");

    expect(
      encodeOpenAiCompatibleChatRequest(snapshot, textInput(prefer.directive)).body,
    ).toHaveProperty("thinking", { type: "enabled" });
    expect(
      encodeOpenAiCompatibleChatRequest(snapshot, textInput(disabled.directive)).body,
    ).toHaveProperty("thinking", { type: "disabled" });
    const omitted = encodeOpenAiCompatibleChatRequest(
      snapshot,
      textInput(defaultDecision.directive),
    ).body;
    expect(omitted).not.toHaveProperty("thinking");
    // The two shapes are alternatives, never emitted together: an endpoint
    // that honours one may treat the other as an unknown field.
    expect(omitted).not.toHaveProperty("enable_thinking");
  });

  it("never emits the boolean shape for an object-form descriptor, or the reverse", () => {
    const objectForm = activeSnapshot({ reasoning: objectFormReasoning() });
    const booleanForm = activeSnapshot({ reasoning: requestControlledReasoning() });
    const enableOn = (snapshot: ReturnType<typeof activeSnapshot>) =>
      encodeOpenAiCompatibleChatRequest(
        snapshot,
        textInput(
          mapReasoningPolicy(snapshot.document.features.reasoning, "prefer", "non-stream")
            .directive,
        ),
      ).body;

    expect(enableOn(objectForm)).not.toHaveProperty("enable_thinking");
    expect(enableOn(booleanForm)).not.toHaveProperty("thinking");
  });

  it("implements every product-policy/support combination without model-name guesses", () => {
    const alwaysOn = alwaysOnReasoning();
    const controlled = requestControlledReasoning();
    const unsupported = unsupportedReasoning();

    expect(mapReasoningPolicy(alwaysOn, "prefer", "non-stream")).toMatchObject({
      directive: "omit",
      preference: "implicit-always-on",
      requireObserved: false,
    });
    expect(() => mapReasoningPolicy(alwaysOn, "disable", "non-stream")).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({
        code: "REASONING_POLICY_UNSATISFIABLE",
      }),
    );
    expect(mapReasoningPolicy(controlled, "require", "stream")).toMatchObject({
      directive: "enable",
      requireObserved: true,
    });
    expect(mapReasoningPolicy(unsupported, "prefer", "non-stream")).toMatchObject({
      directive: "omit",
      preference: "unsupported",
    });
    expect(mapReasoningPolicy(unsupported, "disable", "non-stream").directive).toBe("omit");
    expect(() => mapReasoningPolicy(unsupported, "require", "non-stream")).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({
        code: "REASONING_POLICY_UNSATISFIABLE",
      }),
    );
  });

  it("keeps observed reasoning separate from final content", () => {
    const snapshot = activeSnapshot();
    const decision = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "require",
      "non-stream",
    );
    const output = decodeOpenAiCompatibleChatResponse(
      snapshot,
      nonStreamResponse({ content: "Visible answer", reasoningContent: "Private reasoning" }),
      decision,
    );

    expect(output.finalContent).toBe("Visible answer");
    expect(output.reasoning).toEqual({ state: "observed", parts: ["Private reasoning"] });
    expect(output.finalContent).not.toContain("Private reasoning");
  });

  it("does not infer observation from configuration or an empty reasoning channel", () => {
    const snapshot = activeSnapshot();
    const required = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "require",
      "non-stream",
    );
    expect(() =>
      decodeOpenAiCompatibleChatResponse(
        snapshot,
        nonStreamResponse({ reasoningContent: " \n\t " }),
        required,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({
        code: "REASONING_REQUIRED_NOT_OBSERVED",
      }),
    );

    const defaultDecision = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "default",
      "non-stream",
    );
    expect(
      decodeOpenAiCompatibleChatResponse(snapshot, nonStreamResponse(), defaultDecision).reasoning,
    ).toEqual({ state: "not-observed" });
  });

  it("reports unavailable when no verified observation strategy exists", () => {
    const snapshot = activeSnapshot({
      reasoning: {
        support: "always-on",
        requestControl: { kind: "forbidden" },
        observation: { state: "unknown" },
        replay: { requirement: "forbidden" },
      },
    });
    const output = decodeOpenAiCompatibleChatResponse(
      snapshot,
      nonStreamResponse({ reasoningContent: "unverified channel" }),
    );
    expect(output.reasoning).toEqual({ state: "unavailable" });
    expect(() =>
      mapReasoningPolicy(snapshot.document.features.reasoning, "require", "non-stream"),
    ).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({
        code: "REASONING_POLICY_UNSATISFIABLE",
      }),
    );
  });

  it("normalizes arbitrarily fragmented UTF-8 streams identically", () => {
    const snapshot = activeSnapshot();
    const decision = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "require",
      "stream",
    );
    const payload = streamPayload();
    const byteFragmented = decodeStream(snapshot, decision, payload, 1);
    const coarse = decodeStream(snapshot, decision, payload, 97);

    expect(byteFragmented).toEqual(coarse);
    expect(byteFragmented).toEqual({
      schemaVersion: "dolly.model.chat-output/1",
      finalContent: "答案",
      reasoning: { state: "observed", parts: ["推理"] },
      toolCalls: [],
      finishReason: "stop",
    });
  });

  it("fails a required stream with only whitespace reasoning", () => {
    const snapshot = activeSnapshot();
    const decision = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "require",
      "stream",
    );
    expect(() => decodeStream(snapshot, decision, streamPayload([" ", "\t"], ["answer"]), 5))
      .toThrowError(
        expect.objectContaining<Partial<ModelChatError>>({
          code: "REASONING_REQUIRED_NOT_OBSERVED",
        }),
      );
  });

  it("rejects duplicate JSON keys, unknown fields, and mismatched finish reasons", () => {
    const snapshot = activeSnapshot();
    const duplicate = Buffer.from(
      `{"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"x","reasoning_content":"a","reasoning_content":"b"},"finish_reason":"stop"}]}`,
    );
    expect(() => decodeOpenAiCompatibleChatResponse(snapshot, duplicate)).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({
        code: "CHAT_PROVIDER_PROTOCOL_ERROR",
      }),
    );
    const unknown = JSON.parse(Buffer.from(nonStreamResponse()).toString("utf8"));
    unknown.private_debug = "secret";
    expect(() =>
      decodeOpenAiCompatibleChatResponse(snapshot, Buffer.from(JSON.stringify(unknown))),
    ).toThrowError(ModelChatError);

    expect(() =>
      decodeOpenAiCompatibleChatResponse(
        snapshot,
        Buffer.from(
          JSON.stringify({
            id: "x",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "work", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "stop",
              },
            ],
          }),
        ),
      ),
    ).toThrowError(ModelChatError);
  });

  it("rejects arbitrary request fields, unresolved media, and invalid directives before I/O", () => {
    const snapshot = activeSnapshot();
    expect(() =>
      encodeOpenAiCompatibleChatRequest(snapshot, {
        ...textInput(),
        schemaVersion: "dolly.model.chat-input/1",
      } as unknown as ChatInput),
    ).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({ code: "CHAT_INPUT_INVALID" }),
    );
    expect(() =>
      encodeOpenAiCompatibleChatRequest(snapshot, {
        ...textInput(),
        messages: [
          {
            role: "user",
            parts: [
              {
                kind: "media",
                mediaRef: { type: "media-reference", mediaId: "media-1" },
                requirementId: "image",
              },
            ],
          },
        ],
      } as unknown as ChatInput),
    ).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({ code: "CHAT_INPUT_INVALID" }),
    );
    expect(() =>
      encodeOpenAiCompatibleChatRequest(snapshot, {
        ...textInput(),
        endpoint: "https://attacker.test",
      } as ChatInput),
    ).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({ code: "CHAT_INPUT_INVALID" }),
    );
    expect(() =>
      encodeOpenAiCompatibleChatRequest(snapshot, {
        ...textInput(),
        messages: [
          {
            role: "user",
            parts: [
              {
                kind: "media",
                mediaReference: { type: "media-reference", mediaId: "media-1" },
                requirementId: "image",
              },
            ],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({
        code: "CHAT_FEATURE_UNSUPPORTED",
      }),
    );
    expect(() =>
      encodeOpenAiCompatibleChatRequest(snapshot, {
        ...textInput(),
        messages: [
          {
            role: "user",
            parts: [
              {
                kind: "media",
                mediaReference: { handle: "opaque-media" },
                requirementId: "image",
              },
            ],
          },
        ],
      } as unknown as ChatInput),
    ).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({ code: "CHAT_INPUT_INVALID" }),
    );
    expect(() =>
      encodeOpenAiCompatibleChatRequest(snapshot, {
        ...textInput(),
        messages: [
          {
            role: "user",
            parts: [
              {
                kind: "media",
                mediaReference: { type: "media-reference", mediaId: "media-1" },
                requirementId: "image",
                attachmentSlot: "legacy-slot",
              },
            ],
          },
        ],
      } as unknown as ChatInput),
    ).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({ code: "CHAT_INPUT_INVALID" }),
    );
    expect(() =>
      encodeOpenAiCompatibleChatRequest(snapshot, {
        ...textInput(),
        reasoning: "force" as ChatInput["reasoning"],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({ code: "CHAT_INPUT_INVALID" }),
    );
  });

  it("fails incomplete streams and rejects bytes after [DONE]", () => {
    const snapshot = activeSnapshot();
    const decision = mapReasoningPolicy(
      snapshot.document.features.reasoning,
      "default",
      "stream",
    );
    const incomplete = new OpenAiCompatibleChatStreamDecoder(snapshot, decision);
    incomplete.push(Buffer.from(sseEvent({
      id: "chatcmpl-stream",
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
    })));
    expect(() => incomplete.end()).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({ code: "CHAT_STREAM_INCOMPLETE" }),
    );

    const complete = new OpenAiCompatibleChatStreamDecoder(snapshot, decision);
    complete.push(streamPayload([], ["done"]));
    expect(() => complete.push(Buffer.from("data: {}\n\n"))).toThrowError(
      expect.objectContaining<Partial<ModelChatError>>({ code: "CHAT_STREAM_INVALID" }),
    );
  });
});
