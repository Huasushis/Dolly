import { describe, expect, it, vi } from "vitest";
import { canonicalizeJson, type JsonValue } from "../../../src/core/canonical-json.js";
import {
  ExtensionCapabilityAuthority,
  type ExtensionCapabilityHandle,
  type ExtensionSessionIdentity,
} from "../../../src/core/extension-capability.js";
import { EndpointBindingRegistry } from "../../../src/core/model-provider-binding.js";
import {
  ChatModelBroker,
  type ChatBrokerInvocation,
  type ChatBrokerResult,
  type ModelHttpTransport,
  type ModelHttpTransportRequest,
  type ModelInvocationBudgets,
  type ModelSecretResolver,
} from "../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry, type DescriptorRef } from "../../../src/core/model-provider-descriptor.js";
import {
  EmbeddingModelBroker,
  type EmbeddingBrokerInvocation,
  type EmbeddingBrokerResult,
} from "../../../src/core/model-provider-embedding-broker.js";
import { EmbeddingDescriptorRegistry } from "../../../src/core/model-provider-embedding.js";
import {
  createModelOperationCapability,
  createModelOperationCapabilityV2,
  type ChatModelBrokerPort,
  type EmbeddingModelBrokerPort,
  type ModelOperationCapabilityOptions,
  type ModelOperationCapabilityV2Options,
} from "../../../src/core/provider-capabilities/index.js";
import {
  CHAT_STRATEGIES,
  EMBEDDING_STRATEGIES,
  chatDescriptor,
  textEmbeddingDescriptor,
} from "../../conformance/model-provider/fixtures.js";

const NOW = "2026-07-26T00:00:00.000Z";
const EXPIRES_AT = "2026-07-27T00:00:00.000Z";
const SCHEMA_DIGEST = `sha256:${"7".repeat(64)}`;
const IDENTITY: ExtensionSessionIdentity = {
  extensionId: "com.example.llm",
  instanceId: "instance-a",
  processGenerationId: "process-generation-a",
  sessionId: "session-a",
  moduleId: "module-a",
  moduleGenerationId: "module-generation-a",
};
const EXECUTION_SCOPE = { moduleJobId: "module-job-a", runId: "run-a" } as const;
const PROVIDER_SECRET = "chat-fixture-secret-91b3de07";

const BUDGETS: ModelInvocationBudgets = {
  maxProviderAttempts: 1,
  maxWallTimeMs: 30_000,
  maxRequestBytes: 64 * 1_024,
  maxResponseBytes: 64 * 1_024,
  maxInputItems: 8,
  maxInputBytes: 32 * 1_024,
  maxOutputBytes: 32 * 1_024,
  maxOutputTokens: 512,
};

function chatRef(): DescriptorRef {
  const registry = new ModelDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: CHAT_STRATEGIES,
  });
  const ref = registry.register(chatDescriptor());
  registry.setStatus(ref, "active");
  return ref;
}

function embeddingRef(): DescriptorRef {
  const registry = new EmbeddingDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: EMBEDDING_STRATEGIES,
  });
  const ref = registry.register(textEmbeddingDescriptor());
  registry.setStatus(ref, "active");
  return ref;
}

function succeededChat(invocation: ChatBrokerInvocation): ChatBrokerResult {
  return {
    schemaVersion: "dolly.model-result/2",
    requestId: invocation.requestId,
    operationId: invocation.context.operationId,
    descriptor: invocation.descriptor,
    status: "succeeded",
    output: {
      schemaVersion: "dolly.model.chat-output/1",
      finalContent: "hello from the broker",
      reasoning: { state: "not-observed" },
      toolCalls: [],
      finishReason: "stop",
    },
    usage: { providerAttempts: 1, observations: [] },
  };
}

interface HarnessOptions {
  readonly descriptor?: DescriptorRef;
  readonly chat?: ChatModelBrokerPort;
  readonly embedding?: EmbeddingModelBrokerPort;
  readonly overrides?: Partial<ModelOperationCapabilityOptions>;
  readonly monotonic?: { value: number };
}

function createHarness(options: HarnessOptions = {}) {
  let handleSeed = 0;
  const authority = new ExtensionCapabilityAuthority({
    now: () => NOW,
    nextHandle: () => Buffer.alloc(32, (handleSeed += 1)).toString("base64url"),
  });
  const session = authority.openSession(IDENTITY);
  const monotonic = options.monotonic ?? { value: 1_000 };
  const chat =
    options.chat ??
    ({ invoke: vi.fn(async (invocation) => succeededChat(invocation)) } as ChatModelBrokerPort);
  const definition = createModelOperationCapability({
    descriptor: options.descriptor ?? chatRef(),
    ownerScope: "owner-1",
    budgets: BUDGETS,
    executionScope: EXECUTION_SCOPE,
    expiresAt: EXPIRES_AT,
    now: () => NOW,
    monotonicNow: () => monotonic.value,
    chat,
    ...(options.embedding === undefined ? {} : { embedding: options.embedding }),
    ...(options.overrides ?? {}),
  } as ModelOperationCapabilityOptions);
  const handle: ExtensionCapabilityHandle = session.issue(definition.grant, definition.handler);
  return {
    authority,
    session,
    handle,
    chat,
    monotonic,
    grant: definition.grant,
    invoke(operation: string, argumentsValue: unknown): Promise<JsonValue> {
      return session.invoke({
        handle,
        operation,
        arguments: argumentsValue as JsonValue,
        moduleJobId: EXECUTION_SCOPE.moduleJobId,
        runId: EXECUTION_SCOPE.runId,
      });
    },
  };
}

const ONE_MESSAGE = {
  messages: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
};

describe("Extension model operation capability", () => {
  it("binds one reusable handle to each host-verified active Run", async () => {
    let handleSeed = 0;
    const authority = new ExtensionCapabilityAuthority({
      now: () => NOW,
      nextHandle: () => Buffer.alloc(32, (handleSeed += 1)).toString("base64url"),
    });
    const session = authority.openSession(IDENTITY);
    const invoke = vi.fn(async (invocation: ChatBrokerInvocation) => succeededChat(invocation));
    const definition = createModelOperationCapability({
      descriptor: chatRef(),
      ownerScope: "owner-1",
      budgets: BUDGETS,
      executionScope: "active-run",
      expiresAt: EXPIRES_AT,
      now: () => NOW,
      chat: { invoke },
    });
    const handle = session.issue(definition.grant, definition.handler);

    expect(definition.grant.executionScope).toBeUndefined();
    expect(definition.grant.resourceScope).toMatchObject({
      executionScope: "active-run",
    });

    await session.invoke({
      handle,
      operation: "chat",
      arguments: ONE_MESSAGE,
      moduleJobId: "module-job-a",
      runId: "run-a",
      attempt: 1,
      deadline: "2026-07-26T00:00:10.000Z",
    });
    await session.invoke({
      handle,
      operation: "chat",
      arguments: ONE_MESSAGE,
      moduleJobId: "module-job-b",
      runId: "run-b",
      attempt: 2,
      deadline: "2026-07-26T00:00:20.000Z",
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.map(([invocation]) => invocation.context)).toEqual([
      expect.objectContaining({
        operationId: "module-job-a",
        moduleJobId: "module-job-a",
        runId: "run-a",
        attempt: 1,
      }),
      expect.objectContaining({
        operationId: "module-job-b",
        moduleJobId: "module-job-b",
        runId: "run-b",
        attempt: 2,
      }),
    ]);

    await expect(
      session.invoke({
        handle,
        operation: "chat",
        arguments: ONE_MESSAGE,
        moduleJobId: "module-job-c",
        runId: "run-c",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
    await expect(
      session.invoke({ handle, operation: "describe", arguments: {} }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
  });

  it("binds one descriptor and builds the invocation identity from the session", async () => {
    const invoke = vi.fn(async (invocation: ChatBrokerInvocation) => succeededChat(invocation));
    const descriptor = chatRef();
    const harness = createHarness({ descriptor, chat: { invoke } });

    const result = await harness.invoke("chat", ONE_MESSAGE);

    expect(invoke).toHaveBeenCalledTimes(1);
    const invocation = invoke.mock.calls[0]![0];
    expect(invocation.descriptor).toEqual(descriptor);
    expect(invocation.schemaVersion).toBe("dolly.model.chat-invocation/3");
    expect(invocation.context).toEqual({
      operationId: "module-job-a",
      instanceId: "instance-a",
      ownerScope: "owner-1",
      moduleId: "module-a",
      moduleGenerationId: "module-generation-a",
      moduleJobId: "module-job-a",
      runId: "run-a",
      attempt: 1,
      sessionId: "session-a",
      // Host arithmetic over the granted wall-time budget.
      deadline: "2026-07-26T00:00:30.000Z",
    });
    expect(invocation.budgets).toEqual(BUDGETS);
    expect(invocation.input).toEqual({
      schemaVersion: "dolly.model.chat-input/2",
      messages: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      outputContract: { kind: "text" },
      stream: false,
    });
    expect(result).toMatchObject({
      schemaVersion: "dolly.model-operation-result/1",
      status: "succeeded",
      output: { finalContent: "hello from the broker", finishReason: "stop" },
    });
    // The routing identity the broker needs never travels back to the caller.
    expect(canonicalizeJson(result)).not.toContain(descriptor.endpointId);
    expect(canonicalizeJson(result)).not.toContain(descriptor.adapterId);
    expect(result).toMatchObject({
      model: {
        operation: "chat-completion",
        modelId: descriptor.modelId,
        descriptorDigest: descriptor.descriptorDigest,
      },
    });
  });

  it("keeps the v2 JSON-object syntax Host-granted and schema-free", async () => {
    let handleSeed = 0;
    const authority = new ExtensionCapabilityAuthority({
      now: () => NOW,
      nextHandle: () => Buffer.alloc(32, (handleSeed += 1)).toString("base64url"),
    });
    const session = authority.openSession(IDENTITY);
    const invoke = vi.fn(async (invocation: ChatBrokerInvocation) => succeededChat(invocation));
    const options: ModelOperationCapabilityV2Options = {
      descriptor: chatRef(),
      ownerScope: "owner-1",
      budgets: BUDGETS,
      executionScope: EXECUTION_SCOPE,
      expiresAt: EXPIRES_AT,
      now: () => NOW,
      chat: { invoke },
      outputContracts: ["json-object"],
    };
    const definition = createModelOperationCapabilityV2(options);
    const handle = session.issue(definition.grant, definition.handler);
    const call = (operation: string, argumentsValue: JsonValue) =>
      session.invoke({
        handle,
        operation,
        arguments: argumentsValue,
        moduleJobId: EXECUTION_SCOPE.moduleJobId,
        runId: EXECUTION_SCOPE.runId,
      });

    expect(definition.grant).toMatchObject({
      capabilityVersion: "v2",
      resourceScope: { outputContracts: ["json-object"] },
    });
    await expect(call("describe", {})).resolves.toMatchObject({
      schemaVersion: "dolly.model-operation-description/2",
      outputContracts: ["json-object"],
    });
    await expect(
      call("chat", { ...ONE_MESSAGE, outputContract: { kind: "json-object" } }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].input).toEqual({
      schemaVersion: "dolly.model.chat-input/3",
      messages: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      outputContract: { kind: "json-object" },
      stream: false,
    });

    await expect(call("chat", ONE_MESSAGE)).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "MODEL_OUTPUT_CONTRACT_DENIED", requested: "text" },
    });
    await expect(
      call("chat", {
        ...ONE_MESSAGE,
        outputContract: { kind: "json-object", schema: { type: "object" } },
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      call("chat", { ...ONE_MESSAGE, outputContract: { kind: "json-schema" } }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    expect(invoke).toHaveBeenCalledTimes(1);

    expect(() =>
      createModelOperationCapabilityV2({ ...options, outputContracts: [] }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_CONFIG_INVALID" }));
  });

  it("refuses every attempt to name the model, endpoint, budget, or context", async () => {
    const harness = createHarness();

    for (const forged of [
      { ...ONE_MESSAGE, model: "other-model" },
      { ...ONE_MESSAGE, endpoint: "https://attacker.test/v1/chat" },
      { ...ONE_MESSAGE, descriptor: { endpointId: "other" } },
      { ...ONE_MESSAGE, budgets: { maxOutputBytes: 1_000_000 } },
      { ...ONE_MESSAGE, deadline: "2030-01-01T00:00:00.000Z" },
      { ...ONE_MESSAGE, ownerScope: "owner-2" },
      { ...ONE_MESSAGE, moduleJobId: "module-job-b" },
      { ...ONE_MESSAGE, outputContract: { kind: "json-object" } },
    ]) {
      await expect(harness.invoke("chat", forged)).rejects.toMatchObject({
        code: "CAPABILITY_ARGUMENT_INVALID",
      });
    }
    expect(harness.chat.invoke).not.toHaveBeenCalled();
  });

  it("authorizes only the operations the bound descriptor defines", async () => {
    const harness = createHarness();

    await expect(harness.invoke("embedding", { items: [], outputDimension: 3 })).rejects.toMatchObject(
      { code: "CAPABILITY_DENIED" },
    );
    await expect(harness.invoke("rerank", {})).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    expect(harness.grant.operations).toEqual(["chat", "describe"]);

    expect(() =>
      createModelOperationCapability({
        descriptor: chatRef(),
        ownerScope: "owner-1",
        budgets: BUDGETS,
        executionScope: EXECUTION_SCOPE,
        expiresAt: EXPIRES_AT,
        now: () => NOW,
        operations: ["embedding"],
      }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_CONFIG_INVALID" }));
    expect(harness.chat.invoke).not.toHaveBeenCalled();
  });

  it("fails visibly on a modality the handle does not grant instead of downgrading", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke("chat", {
        messages: [
          {
            role: "user",
            parts: [
              { kind: "text", text: "describe this" },
              { kind: "media", mediaId: "media-1", requirementId: "image-v1" },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "MODEL_MEDIA_NOT_GRANTED", partIndex: 1 },
    });
    await expect(harness.invoke("chat", { ...ONE_MESSAGE, stream: true })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "MODEL_STREAMING_NOT_GRANTED" },
    });
    await expect(
      harness.invoke("chat", { ...ONE_MESSAGE, reasoning: "require" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "MODEL_REASONING_POLICY_DENIED", requested: "require" },
    });
    await expect(
      harness.invoke("chat", {
        messages: [{ role: "root", parts: [{ kind: "text", text: "hi" }] }],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "MODEL_ROLE_DENIED", role: "root" },
    });
    // Nothing above reached the provider: the text half of a rejected
    // multimodal request is never quietly sent on its own.
    expect(harness.chat.invoke).not.toHaveBeenCalled();
  });

  it("fails visibly when the granted modality has no installed broker", async () => {
    const rerank: DescriptorRef = {
      endpointId: "fixture-rerank-endpoint",
      operation: "rerank",
      modelId: "fixture-reranker",
      adapterId: "fixture-rerank-adapter",
      adapterVersion: "v1",
      descriptorVersion: "v1",
      descriptorDigest: `sha256:${"a".repeat(64)}`,
    };
    const harness = createHarness({ descriptor: rerank });
    expect(harness.grant.operations).toEqual(["rerank", "describe"]);

    await expect(harness.invoke("rerank", {})).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "MODEL_OPERATION_UNAVAILABLE" },
    });

    const withoutChatBroker = createModelOperationCapability({
      descriptor: chatRef(),
      ownerScope: "owner-1",
      budgets: BUDGETS,
      executionScope: EXECUTION_SCOPE,
      expiresAt: EXPIRES_AT,
      now: () => NOW,
    });
    const session = new ExtensionCapabilityAuthority({
      now: () => NOW,
      nextHandle: () => Buffer.alloc(32, 9).toString("base64url"),
    }).openSession(IDENTITY);
    const handle = session.issue(withoutChatBroker.grant, withoutChatBroker.handler);
    await expect(
      session.invoke({
        handle,
        operation: "chat",
        arguments: ONE_MESSAGE,
        moduleJobId: EXECUTION_SCOPE.moduleJobId,
        runId: EXECUTION_SCOPE.runId,
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "MODEL_OPERATION_UNAVAILABLE" },
    });
  });

  it("enforces budgets, sizes, and the rate window host-side", async () => {
    const monotonic = { value: 1_000 };
    const harness = createHarness({
      monotonic,
      overrides: { limits: { maxMessages: 2, maxInvocationsPerWindow: 2, rateWindowMs: 60_000 } },
    });

    await expect(
      harness.invoke("chat", { ...ONE_MESSAGE, maxOutputTokens: 4_096 }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxOutputTokens", allowed: 512 },
    });
    await expect(
      harness.invoke("chat", {
        messages: Array.from({ length: 3 }, () => ({
          role: "user",
          parts: [{ kind: "text", text: "hi" }],
        })),
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxMessages", allowed: 2 },
    });
    await expect(
      harness.invoke("chat", {
        messages: [{ role: "user", parts: [{ kind: "text", text: "x".repeat(40_000) }] }],
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_QUOTA_EXCEEDED" });
    expect(harness.chat.invoke).not.toHaveBeenCalled();

    const narrowed = await harness.invoke("chat", { ...ONE_MESSAGE, maxOutputTokens: 64 });
    expect(narrowed).toMatchObject({ status: "succeeded" });
    expect(
      (harness.chat.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0].budgets.maxOutputTokens,
    ).toBe(64);

    await expect(harness.invoke("chat", ONE_MESSAGE)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(harness.invoke("chat", ONE_MESSAGE)).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { reason: "MODEL_RATE_LIMITED", maxInvocationsPerWindow: 2 },
    });

    monotonic.value += 60_001;
    await expect(harness.invoke("chat", ONE_MESSAGE)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.chat.invoke).toHaveBeenCalledTimes(3);
  });

  it("returns a provider failure as an honest envelope without provider detail", async () => {
    const invoke = vi.fn(
      async (invocation: ChatBrokerInvocation): Promise<ChatBrokerResult> => ({
        schemaVersion: "dolly.model-result/2",
        requestId: invocation.requestId,
        operationId: invocation.context.operationId,
        descriptor: invocation.descriptor,
        status: "failed",
        error: {
          code: "AUTHENTICATION_FAILED",
          phase: "dispatch",
          retryClass: "after-reconfiguration",
          message: "bearer token for https://provider.internal/v1/chat was rejected",
        },
        usage: { providerAttempts: 1, observations: [] },
      }),
    );
    const harness = createHarness({ chat: { invoke } });

    const result = await harness.invoke("chat", ONE_MESSAGE);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "AUTHENTICATION_FAILED", phase: "dispatch", retryClass: "after-reconfiguration" },
    });
    expect(canonicalizeJson(result)).not.toContain("provider.internal");
    expect(canonicalizeJson(result)).not.toContain("bearer");
  });

  it("keeps the endpoint and the bound credential inside the broker", async () => {
    const descriptors = new ModelDescriptorRegistry({
      schemaDigest: SCHEMA_DIGEST,
      allowedStrategyIds: CHAT_STRATEGIES,
    });
    const descriptor = descriptors.register(chatDescriptor());
    descriptors.setStatus(descriptor, "active");
    const bindings = new EndpointBindingRegistry();
    const binding = bindings.register({
      schemaVersion: "dolly.endpoint-binding/2",
      endpointId: descriptor.endpointId,
      bindingRevision: "capability-fixture-binding-v1",
      descriptorRefs: [descriptor],
      exactUrl: "https://provider.internal.test/v1/chat/completions",
      networkScope: "public",
      authentication: {
        kind: "bearer-secret",
        secretRef: "provider.chat.token",
        secretRevision: "rev-1",
      },
      limits: { maxRequestBytes: 64 * 1_024, maxResponseBytes: 64 * 1_024, maxTimeoutMs: 30_000 },
    });
    bindings.setStatus(binding, "active");
    const dispatched: ModelHttpTransportRequest[] = [];
    const transport: ModelHttpTransport = {
      dispatch: vi.fn(async (request) => {
        dispatched.push(request);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: (async function* () {
            yield Buffer.from(
              JSON.stringify({
                id: "provider-response-1",
                object: "chat.completion",
                created: 1,
                model: "fixture-reasoner-27b",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "answer" },
                    finish_reason: "stop",
                  },
                ],
              }),
              "utf8",
            );
          })(),
          abort: () => undefined,
        };
      }),
    };
    const secrets: ModelSecretResolver = {
      resolve: vi.fn(async () => ({ value: PROVIDER_SECRET, release: () => undefined })),
    };
    const broker = new ChatModelBroker({
      descriptors,
      bindings,
      secrets,
      transport,
      now: () => NOW,
    });
    const harness = createHarness({ descriptor, chat: broker });

    const result = await harness.invoke("chat", ONE_MESSAGE);

    expect(result).toMatchObject({ status: "succeeded", output: { finalContent: "answer" } });
    expect(dispatched).toHaveLength(1);
    // The host attached the credential and chose the exact route.
    expect(dispatched[0]!.headers.authorization).toBe(`Bearer ${PROVIDER_SECRET}`);
    expect(dispatched[0]!.url.href).toBe("https://provider.internal.test/v1/chat/completions");
    const serialized = canonicalizeJson(result);
    expect(serialized).not.toContain(PROVIDER_SECRET);
    expect(serialized).not.toContain("provider.internal.test");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("provider.chat.token");

    const description = await harness.invoke("describe", {});
    expect(description).toMatchObject({ modality: "chat" });
    expect(canonicalizeJson(description)).not.toContain(PROVIDER_SECRET);
    expect(canonicalizeJson(description)).not.toContain("provider.internal.test");
  });

  it("drives the embedding modality and refuses a media item on it", async () => {
    const descriptor = embeddingRef();
    const invoke = vi.fn(
      async (invocation: EmbeddingBrokerInvocation): Promise<EmbeddingBrokerResult> => ({
        schemaVersion: "dolly.model-result/2",
        requestId: invocation.requestId,
        operationId: invocation.context.operationId,
        descriptor: invocation.descriptor,
        status: "succeeded",
        output: {
          schemaVersion: "dolly.model.embedding-output/1",
          items: [
            {
              itemId: "item-1",
              status: "succeeded",
              vector: [1, 0, 0],
              dimension: 3,
              vectorSpaceId: "fixture-text-vector-space-v1",
            },
          ],
        },
        usage: { providerAttempts: 1, observations: [] },
      }),
    );
    const harness = createHarness({
      descriptor,
      embedding: { invoke },
      overrides: { chat: undefined },
    });

    const result = await harness.invoke("embedding", {
      outputDimension: 3,
      items: [{ itemId: "item-1", text: "hello" }],
    });
    expect(result).toMatchObject({
      status: "succeeded",
      output: { items: [{ itemId: "item-1", vector: [1, 0, 0], dimension: 3 }] },
    });
    expect(invoke.mock.calls[0]![0].input).toEqual({
      schemaVersion: "dolly.model.embedding-input/2",
      outputDimension: 3,
      items: [{ itemId: "item-1", input: { kind: "text", text: "hello" } }],
    });

    await expect(
      harness.invoke("embedding", {
        outputDimension: 3,
        items: [{ itemId: "item-2", text: "hello", kind: "media" }],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "MODEL_MEDIA_NOT_GRANTED", itemIndex: 0 },
    });
    await expect(
      harness.invoke("embedding", {
        outputDimension: 3,
        items: [
          { itemId: "item-3", text: "a" },
          { itemId: "item-3", text: "b" },
        ],
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects a handle used from another session, after revocation, or past its budget", async () => {
    const harness = createHarness({ overrides: { limits: { maxInvocations: 1 } } });
    const other = harness.authority.openSession({ ...IDENTITY, sessionId: "session-b" });

    await expect(
      other.invoke({
        handle: harness.handle,
        operation: "chat",
        arguments: ONE_MESSAGE,
        moduleJobId: EXECUTION_SCOPE.moduleJobId,
        runId: EXECUTION_SCOPE.runId,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await expect(
      harness.session.invoke({
        handle: harness.handle,
        operation: "chat",
        arguments: ONE_MESSAGE,
        moduleJobId: "module-job-b",
        runId: EXECUTION_SCOPE.runId,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });

    await expect(harness.invoke("chat", ONE_MESSAGE)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(harness.invoke("chat", ONE_MESSAGE)).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
    });

    const revocable = createHarness();
    expect(revocable.session.revoke(revocable.handle)).toBe("revoked");
    await expect(revocable.invoke("chat", ONE_MESSAGE)).rejects.toMatchObject({
      code: "CAPABILITY_REVOKED",
    });
    expect(revocable.chat.invoke).not.toHaveBeenCalled();
    expect(harness.chat.invoke).toHaveBeenCalledTimes(1);
  });
});
