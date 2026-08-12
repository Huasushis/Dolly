import { createHash } from "node:crypto";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import {
  ExtensionCapabilityAuthority,
  type ExtensionCapabilityInvocationContext,
} from "../../../src/core/extension-capability.js";
import {
  EndpointBindingError,
  EndpointBindingRegistry,
  type EndpointBindingDocument,
} from "../../../src/core/model-provider-binding.js";
import {
  ChatModelBroker,
  ModelHttpTransportError,
  type ChatBrokerInvocation,
  type ModelHttpTransport,
  type ModelHttpTransportRequest,
  type ModelHttpTransportResponse,
  type ModelMediaResolver,
  type ModelResolvedMedia,
  type ModelSecretLease,
  type ModelSecretResolver,
} from "../../../src/core/model-provider-broker.js";
import {
  ModelDescriptorRegistry,
  type ChatDescriptorSnapshot,
  type DescriptorRef,
} from "../../../src/core/model-provider-descriptor.js";
import { CHAT_STRATEGIES, chatDescriptor } from "./fixtures.js";

const NOW = "2026-07-24T08:00:00.000Z";
const DEADLINE = "2026-07-24T08:01:00.000Z";
const SCHEMA_DIGEST = `sha256:${"d".repeat(64)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeResponse implements ModelHttpTransportResponse {
  readonly abort = vi.fn();
  readonly body: AsyncIterable<Uint8Array>;
  readonly providerRequestId?: string;

  constructor(
    readonly status: number,
    bytes: Uint8Array | readonly Uint8Array[],
    readonly headers: Readonly<Record<string, string>> = {
      "content-type": "application/json; charset=utf-8",
    },
    providerRequestId: string | null = "provider-request-1",
  ) {
    if (providerRequestId !== null) this.providerRequestId = providerRequestId;
    const chunks = bytes instanceof Uint8Array ? [bytes] : bytes;
    this.body = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    };
  }
}

class FakeSecretResolver implements ModelSecretResolver {
  readonly calls: Array<{ secretRef: string; secretRevision: string }> = [];
  releases = 0;

  constructor(
    private readonly value = "host-private-key",
    private readonly pending?: Promise<ModelSecretLease>,
  ) {}

  async resolve(secretRef: string, secretRevision: string): Promise<ModelSecretLease> {
    this.calls.push({ secretRef, secretRevision });
    if (this.pending) return this.pending;
    return {
      value: this.value,
      release: () => {
        this.releases += 1;
      },
    };
  }
}

class FakeTransport implements ModelHttpTransport {
  readonly requests: ModelHttpTransportRequest[] = [];

  constructor(
    private readonly handler: (
      request: ModelHttpTransportRequest,
    ) => Promise<ModelHttpTransportResponse>,
  ) {}

  dispatch(request: ModelHttpTransportRequest): Promise<ModelHttpTransportResponse> {
    this.requests.push(request);
    return this.handler(request);
  }
}

function providerBody(
  reasoningContent: string | undefined = "2 + 2 equals 4",
  content = "4",
): Buffer {
  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoningContent !== undefined) message.reasoning_content = reasoningContent;
  return Buffer.from(
    JSON.stringify({
      id: "provider-request-1",
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
  );
}

function providerStream(options: { readonly done?: boolean } = {}): Buffer {
  const events = [
    {
      id: "provider-request-1",
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: { role: "assistant", reasoning_content: "2 + 2 equals " },
        finish_reason: null,
      }],
    },
    {
      id: "provider-request-1",
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: { reasoning_content: "4", content: "4" },
        finish_reason: null,
      }],
    },
    {
      id: "provider-request-1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      id: "provider-request-1",
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (options.done !== false) events.push("data: [DONE]\n\n");
  return Buffer.from(events.join(""));
}

function createDescriptor(options: {
  jsonObjectOutput?: "supported" | "unsupported";
  inlinePng?: boolean;
} = {}): {
  registry: ModelDescriptorRegistry;
  snapshot: ChatDescriptorSnapshot;
} {
  const registry = new ModelDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: CHAT_STRATEGIES,
  });
  const ref = registry.register(chatDescriptor(options));
  registry.setStatus(ref, "active");
  return { registry, snapshot: registry.snapshot(ref) };
}

function bindingFor(
  descriptor: DescriptorRef,
  overrides: Partial<EndpointBindingDocument> = {},
): EndpointBindingDocument {
  return {
    schemaVersion: "dolly.endpoint-binding/2",
    endpointId: descriptor.endpointId,
    bindingRevision: "binding-private-rev-1",
    descriptorRefs: [descriptor],
    exactUrl: "https://provider.example.test/exact/chat/completions",
    networkScope: "public",
    authentication: {
      kind: "bearer-secret",
      secretRef: "provider-primary-key",
      secretRevision: "secret-rev-7",
    },
    limits: {
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 64 * 1024,
      maxTimeoutMs: 30_000,
    },
    ...overrides,
  };
}

function activeBindings(
  descriptor: DescriptorRef,
  overrides: Partial<EndpointBindingDocument> = {},
): EndpointBindingRegistry {
  const bindings = new EndpointBindingRegistry();
  const ref = bindings.register(bindingFor(descriptor, overrides));
  bindings.setStatus(ref, "active");
  return bindings;
}

function invocation(descriptor: DescriptorRef): ChatBrokerInvocation {
  return {
    schemaVersion: "dolly.model.chat-invocation/3",
    requestId: "request-1",
    descriptor,
    context: {
      operationId: "operation-1",
      instanceId: "instance-1",
      ownerScope: "owner-1",
      moduleId: "brain-1",
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      idempotencyKey: "module-job-1-chat-primary",
      deadline: DEADLINE,
    },
    budgets: {
      maxProviderAttempts: 1,
      maxWallTimeMs: 30_000,
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 64 * 1024,
      maxInputItems: 16,
      maxInputBytes: 32 * 1024,
      maxOutputBytes: 32 * 1024,
      maxOutputTokens: 1024,
    },
    reasoningPolicy: "require",
    input: {
      schemaVersion: "dolly.model.chat-input/2",
      messages: [{ role: "user", parts: [{ kind: "text", text: "What is 2 + 2?" }] }],
      outputContract: { kind: "text" },
      stream: false,
    },
  };
}

function brokerWith(options: {
  descriptors: ModelDescriptorRegistry;
  descriptor: DescriptorRef;
  secrets?: ModelSecretResolver;
  transport?: ModelHttpTransport;
  bindings?: EndpointBindingRegistry;
  media?: ModelMediaResolver;
}) {
  const secrets = options.secrets ?? new FakeSecretResolver();
  const transport =
    options.transport ??
    new FakeTransport(async () => new FakeResponse(200, providerBody()));
  const bindings = options.bindings ?? activeBindings(options.descriptor);
  return {
    broker: new ChatModelBroker({
      descriptors: options.descriptors,
      bindings,
      secrets,
      transport,
      ...(options.media === undefined ? {} : { media: options.media }),
      now: () => NOW,
    }),
    secrets,
    transport,
    bindings,
  };
}

function mediaInvocation(descriptor: DescriptorRef): ChatBrokerInvocation {
  const base = invocation(descriptor);
  return {
    ...base,
    context: { ...base.context, sessionId: "session-1" },
    budgets: {
      ...base.budgets,
      maxMediaItems: 1,
      maxResolvedMediaBytes: 16 * 1024,
    },
    input: {
      ...base.input,
      messages: [{
        role: "user",
        parts: [
          { kind: "text", text: "Read the attached image." },
          {
            kind: "media",
            mediaReference: { type: "media-reference", mediaId: "media-1" },
            requirementId: "inline-png-v1",
          },
        ],
      }],
    },
  };
}

function resolvedMedia(
  request: Parameters<ModelMediaResolver["resolve"]>[0],
  bytes = Buffer.from("inspected-png-bytes", "utf8"),
): ModelResolvedMedia {
  return {
    schemaVersion: "dolly.model.resolved-media/1",
    modelRequestId: request.modelRequestId,
    mediaRequestId: request.mediaRequestId,
    recipientId: request.recipientId,
    descriptorDigest: request.descriptor.descriptorDigest,
    bindingRevision: request.binding.bindingRevision,
    messageIndex: request.messageIndex,
    partIndex: request.partIndex,
    requirementId: request.requirement.requirementId,
    mediaId: request.mediaReference.mediaId,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    mimeType: "image/png",
    byteLength: bytes.byteLength,
    width: 64,
    height: 32,
    accessMode: "inline",
    inline: { encoding: "base64", data: bytes.toString("base64") },
  };
}

describe("private endpoint binding and model provider broker", () => {
  it("rejects previous chat invocation versions and removed context fields", async () => {
    const { registry, snapshot } = createDescriptor();
    const secrets = new FakeSecretResolver();
    const transport = new FakeTransport(async () => new FakeResponse(200, providerBody()));
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      secrets,
      transport,
    });
    const current = invocation(snapshot.ref);

    for (const schemaVersion of [
      "dolly.model.chat-invocation/1",
      "dolly.model.chat-invocation/2",
    ]) {
      await expect(
        broker.invoke({ ...current, schemaVersion } as unknown as ChatBrokerInvocation),
      ).rejects.toMatchObject({ code: "BROKER_REQUEST_INVALID" });
    }

    const removedField = structuredClone(current) as unknown as {
      context: Record<string, unknown>;
    };
    removedField.context.moduleInstanceId = removedField.context.moduleId;
    delete removedField.context.moduleId;
    await expect(
      broker.invoke(removedField as unknown as ChatBrokerInvocation),
    ).rejects.toMatchObject({ code: "BROKER_REQUEST_INVALID" });

    const previousJobField = structuredClone(current) as unknown as {
      context: Record<string, unknown>;
    };
    previousJobField.context.processingId = previousJobField.context.moduleJobId;
    delete previousJobField.context.moduleJobId;
    await expect(
      broker.invoke(previousJobField as unknown as ChatBrokerInvocation),
    ).rejects.toMatchObject({ code: "BROKER_REQUEST_INVALID" });

    expect(secrets.calls).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it("rejects endpoint binding version 1 and the former transportProfile field", () => {
    const { snapshot } = createDescriptor();
    const bindings = new EndpointBindingRegistry();
    expect(() => bindings.register({
      ...bindingFor(snapshot.ref),
      schemaVersion: "dolly.endpoint-binding/1",
    })).toThrowError(expect.objectContaining<Partial<EndpointBindingError>>({
      code: "BINDING_INVALID",
    }));

    const legacyField = {
      ...bindingFor(snapshot.ref),
    } as Record<string, unknown>;
    delete legacyField.networkScope;
    legacyField.transportProfile = "https";
    expect(() => bindings.register(legacyField)).toThrowError(
      expect.objectContaining<Partial<EndpointBindingError>>({
        code: "BINDING_INVALID",
      }),
    );
  });

  it("rejects raw credentials, non-HTTPS public routes, query credentials, and hostname loopback", () => {
    const { snapshot } = createDescriptor();
    const bindings = new EndpointBindingRegistry();
    expect(() =>
      bindings.register({
        ...bindingFor(snapshot.ref),
        authentication: {
          kind: "bearer-secret",
          secretRef: "provider-primary-key",
          secretRevision: "secret-rev-7",
          value: "must-not-be-here",
        },
      }),
    ).toThrowError(expect.objectContaining<Partial<EndpointBindingError>>({ code: "BINDING_INVALID" }));
    expect(() =>
      bindings.register({
        ...bindingFor(snapshot.ref),
        exactUrl: "http://provider.example.test/v1/chat/completions",
      }),
    ).toThrowError(EndpointBindingError);
    expect(() =>
      bindings.register({
        ...bindingFor(snapshot.ref),
        exactUrl: "https://provider.example.test/v1/chat/completions?token=secret",
      }),
    ).toThrowError(EndpointBindingError);
    expect(() =>
      bindings.register({
        ...bindingFor(snapshot.ref),
        exactUrl: "http://localhost:8123/v1/chat/completions",
        networkScope: "loopback",
      }),
    ).toThrowError(EndpointBindingError);

    expect(() =>
      bindings.register({
        ...bindingFor(snapshot.ref),
        bindingRevision: "loopback-rev",
        exactUrl: "http://127.0.0.1:8123/v1/chat/completions",
        networkScope: "loopback",
        authentication: { kind: "none" },
      }),
    ).not.toThrow();
  });

  it("freezes an old binding snapshot when a new revision becomes active", () => {
    const { snapshot } = createDescriptor();
    const bindings = activeBindings(snapshot.ref);
    const first = bindings.snapshot(snapshot.ref);
    const secondRef = bindings.register(
      bindingFor(snapshot.ref, {
        bindingRevision: "binding-private-rev-2",
        exactUrl: "https://replacement.example.test/v2/chat/completions",
        authentication: {
          kind: "bearer-secret",
          secretRef: "provider-primary-key",
          secretRevision: "secret-rev-8",
        },
      }),
    );
    bindings.setStatus(secondRef, "active");
    const second = bindings.snapshot(snapshot.ref);

    expect(first.ref.bindingRevision).toBe("binding-private-rev-1");
    expect(first.document.exactUrl).toContain("provider.example.test");
    expect(first.document.authentication).toMatchObject({ secretRevision: "secret-rev-7" });
    expect(second.ref.bindingRevision).toBe("binding-private-rev-2");
    expect(second.document.exactUrl).toContain("replacement.example.test");
  });

  it("keeps URL and secret authority inside the host transport", async () => {
    const { registry, snapshot } = createDescriptor();
    const secrets = new FakeSecretResolver("host-private-key");
    const transport = new FakeTransport(async () => new FakeResponse(200, providerBody()));
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      secrets,
      transport,
    });
    const result = await broker.invoke(invocation(snapshot.ref));

    expect(result).toMatchObject({
      status: "succeeded",
      providerRequestId: "provider-request-1",
      output: {
        finalContent: "4",
        reasoning: { state: "observed", parts: ["2 + 2 equals 4"] },
      },
    });
    expect(secrets.calls).toEqual([
      { secretRef: "provider-primary-key", secretRevision: "secret-rev-7" },
    ]);
    expect(secrets.releases).toBe(1);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.url.href).toBe(
      "https://provider.example.test/exact/chat/completions",
    );
    expect(transport.requests[0]!.headers.authorization).toBe("Bearer host-private-key");
    const wireBody = JSON.parse(Buffer.from(transport.requests[0]!.body).toString("utf8"));
    expect(wireBody).not.toHaveProperty("enable_thinking");
    expect(wireBody).not.toHaveProperty("base_url");

    const consumerVisible = JSON.stringify(result);
    expect(consumerVisible).not.toContain("host-private-key");
    expect(consumerVisible).not.toContain("provider.example.test");
    expect(consumerVisible).not.toContain("binding-private-rev-1");
    expect(consumerVisible).not.toContain("secret-rev-7");
  });

  it("resolves a delivered inline PNG through the frozen descriptor and binding before dispatch", async () => {
    const { registry, snapshot } = createDescriptor({ inlinePng: true });
    const bytes = Buffer.from("inspected-png-bytes", "utf8");
    const resolve = vi.fn<ModelMediaResolver["resolve"]>(async (request) => {
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.context)).toBe(true);
      expect(request).toMatchObject({
        schemaVersion: "dolly.model.media-resolution-request/1",
        modelRequestId: "request-1",
        recipientId: expect.stringMatching(/^model:[0-9a-f]{64}$/u),
        descriptor: snapshot.ref,
        binding: {
          endpointId: snapshot.ref.endpointId,
          bindingRevision: "binding-private-rev-1",
        },
        context: {
          moduleId: "brain-1",
          moduleGenerationId: "generation-1",
          moduleJobId: "module-job-1",
          runId: "run-1",
          attempt: 1,
          sessionId: "session-1",
        },
        messageIndex: 0,
        partIndex: 1,
        mediaReference: { type: "media-reference", mediaId: "media-1" },
        requirement: {
          requirementId: "inline-png-v1",
          modality: "image",
          mimeTypes: ["image/png"],
          deliveryModes: ["inline"],
          providerFetchesAfterAcceptance: false,
          lifetimeStrategyId: "media.inline-copy.v1",
          placementStrategyId: "openai.chat.media.inline-image-url.v1",
        },
        acceptedAccessModes: ["inline"],
        limits: {
          maxItemsRemaining: 1,
          maxBytesForItem: 16 * 1024,
          maxResolvedBytesRemaining: 16 * 1024,
        },
      });
      return resolvedMedia(request, bytes);
    });
    const transport = new FakeTransport(async () => new FakeResponse(200, providerBody()));
    const secrets = new FakeSecretResolver();
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      media: { resolve },
      transport,
      secrets,
    });

    await expect(broker.invoke(mediaInvocation(snapshot.ref))).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(secrets.calls).toHaveLength(1);
    expect(transport.requests).toHaveLength(1);
    const wire = JSON.parse(Buffer.from(transport.requests[0]!.body).toString("utf8"));
    expect(wire.messages[0].content).toEqual([
      { type: "text", text: "Read the attached image." },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` },
      },
    ]);
    expect(JSON.stringify(wire)).not.toContain("media-1");
  });

  it("fails unresolved, foreign, corrupted, and over-budget Media before secret or network access", async () => {
    const { registry, snapshot } = createDescriptor({ inlinePng: true });
    const request = mediaInvocation(snapshot.ref);

    const noResolverSecrets = new FakeSecretResolver();
    const noResolverTransport = new FakeTransport(
      async () => new FakeResponse(200, providerBody()),
    );
    const noResolver = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      secrets: noResolverSecrets,
      transport: noResolverTransport,
    });
    await expect(noResolver.broker.invoke(request)).resolves.toMatchObject({
      status: "failed",
      error: { code: "FEATURE_UNSUPPORTED", phase: "validation" },
    });
    expect(noResolverSecrets.calls).toHaveLength(0);
    expect(noResolverTransport.requests).toHaveLength(0);

    const mutations: Array<(value: ModelResolvedMedia) => ModelResolvedMedia> = [
      (value) => ({ ...value, mediaId: "media-other" }),
      (value) => ({ ...value, descriptorDigest: `sha256:${"a".repeat(64)}` }),
      (value) => ({ ...value, bindingRevision: "binding-other" }),
      (value) => ({ ...value, requirementId: "inline-other" }),
      (value) => ({ ...value, mimeType: "image/jpeg" as "image/png" }),
      (value) => ({ ...value, byteLength: value.byteLength + 1 }),
      (value) => ({ ...value, digest: `sha256:${"b".repeat(64)}` }),
      (value) => ({
        ...value,
        inline: {
          ...value.inline,
          data: Buffer.alloc(value.byteLength, 0x62).toString("base64"),
        },
      }),
    ];
    for (const mutate of mutations) {
      const secrets = new FakeSecretResolver();
      const transport = new FakeTransport(async () => new FakeResponse(200, providerBody()));
      const resolver: ModelMediaResolver = {
        resolve: async (mediaRequest) => mutate(resolvedMedia(mediaRequest)),
      };
      const { broker } = brokerWith({
        descriptors: registry,
        descriptor: snapshot.ref,
        media: resolver,
        secrets,
        transport,
      });
      await expect(broker.invoke(request)).resolves.toMatchObject({
        status: "failed",
        error: { code: "INVALID_REQUEST", phase: "validation" },
      });
      expect(secrets.calls).toHaveLength(0);
      expect(transport.requests).toHaveLength(0);
    }

    const budgetSecrets = new FakeSecretResolver();
    const budgetTransport = new FakeTransport(async () => new FakeResponse(200, providerBody()));
    const budgetResolver = vi.fn<ModelMediaResolver["resolve"]>(async (mediaRequest) =>
      resolvedMedia(mediaRequest));
    const budget = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      media: { resolve: budgetResolver },
      secrets: budgetSecrets,
      transport: budgetTransport,
    });
    await expect(budget.broker.invoke({
      ...request,
      budgets: { ...request.budgets, maxResolvedMediaBytes: 1 },
    })).resolves.toMatchObject({
      status: "failed",
      error: { code: "BUDGET_EXCEEDED", phase: "validation" },
    });
    expect(budgetSecrets.calls).toHaveLength(0);
    expect(budgetTransport.requests).toHaveLength(0);

    const aggregateLimits: number[] = [];
    const aggregateTransport = new FakeTransport(
      async () => new FakeResponse(200, providerBody()),
    );
    const aggregate = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      media: {
        resolve: async (mediaRequest) => {
          aggregateLimits.push(mediaRequest.limits.maxBytesForItem);
          return resolvedMedia(
            mediaRequest,
            Buffer.alloc(mediaRequest.limits.maxBytesForItem, 0x61),
          );
        },
      },
      transport: aggregateTransport,
    });
    await expect(aggregate.broker.invoke({
      ...request,
      budgets: {
        ...request.budgets,
        maxMediaItems: 2,
        maxResolvedMediaBytes: 32 * 1024,
        maxInputBytes: 64 * 1024,
      },
      input: {
        ...request.input,
        messages: [{
          role: "user",
          parts: [
            ...request.input.messages[0]!.parts,
            {
              kind: "media",
              mediaReference: { type: "media-reference", mediaId: "media-2" },
              requirementId: "inline-png-v1",
            },
          ],
        }],
      },
    })).resolves.toMatchObject({ status: "succeeded" });
    expect(aggregateLimits).toEqual([16 * 1024, 8 * 1024]);
    expect(aggregateTransport.requests).toHaveLength(1);
  });

  it("cancels a pending Media resolution without reading a secret or dispatching", async () => {
    const { registry, snapshot } = createDescriptor({ inlinePng: true });
    const pending = deferred<ModelResolvedMedia>();
    const secrets = new FakeSecretResolver();
    const transport = new FakeTransport(async () => new FakeResponse(200, providerBody()));
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      media: { resolve: () => pending.promise },
      secrets,
      transport,
    });
    const controller = new AbortController();
    const operation = broker.invoke(mediaInvocation(snapshot.ref), { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error("cancel media resolution"));

    await expect(operation).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "CANCELLED", phase: "validation" },
    });
    expect(secrets.calls).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it("charges pending Media resolution to the invocation wall-time budget", async () => {
    const { registry, snapshot } = createDescriptor({ inlinePng: true });
    const pending = deferred<ModelResolvedMedia>();
    const deadlines: string[] = [];
    let capturedRequest: Parameters<ModelMediaResolver["resolve"]>[0] | undefined;
    const secrets = new FakeSecretResolver();
    const transport = new FakeTransport(async () => new FakeResponse(200, providerBody()));
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      media: {
        resolve: (request) => {
          capturedRequest = request;
          deadlines.push(request.deadline);
          return pending.promise;
        },
      },
      secrets,
      transport,
    });
    const request = mediaInvocation(snapshot.ref);

    const operation = broker.invoke({
      ...request,
      budgets: { ...request.budgets, maxWallTimeMs: 20 },
    });

    await expect(operation).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "DEADLINE_EXCEEDED", phase: "validation" },
    });
    expect(deadlines).toEqual(["2026-07-24T08:00:00.020Z"]);
    expect(secrets.calls).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);

    expect(capturedRequest).toBeDefined();
    pending.resolve(resolvedMedia(capturedRequest!));
    await waitImmediate();
    expect(secrets.calls).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it("preserves deadline classification when the shared budget expires during dispatch", async () => {
    const { registry, snapshot } = createDescriptor({ inlinePng: true });
    const pendingResponse = deferred<ModelHttpTransportResponse>();
    const lateResponse = new FakeResponse(200, providerBody());
    const secrets = new FakeSecretResolver();
    const transport = new FakeTransport(() => pendingResponse.promise);
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      media: { resolve: async (request) => resolvedMedia(request) },
      secrets,
      transport,
    });
    const request = mediaInvocation(snapshot.ref);

    const operation = broker.invoke({
      ...request,
      budgets: { ...request.budgets, maxWallTimeMs: 20 },
    });

    await expect(operation).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "DEADLINE_EXCEEDED", phase: "dispatch" },
    });
    expect(secrets.calls).toHaveLength(1);
    expect(transport.requests).toHaveLength(1);

    pendingResponse.resolve(lateResponse);
    await waitImmediate();
    expect(lateResponse.abort).toHaveBeenCalledOnce();
  });

  it("validates a descriptor-bound provider stream while retaining one final result", async () => {
    const { registry, snapshot } = createDescriptor();
    const streamBytes = providerStream();
    const chunks = Array.from(
      { length: Math.ceil(streamBytes.length / 7) },
      (_, index) => streamBytes.subarray(index * 7, Math.min((index + 1) * 7, streamBytes.length)),
    );
    const transport = new FakeTransport(async () =>
      new FakeResponse(200, chunks, { "content-type": "text/event-stream" }),
    );
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      transport,
    });
    const request: ChatBrokerInvocation = {
      ...invocation(snapshot.ref),
      input: { ...invocation(snapshot.ref).input, stream: true },
    };

    await expect(broker.invoke(request)).resolves.toMatchObject({
      status: "succeeded",
      output: {
        finalContent: "4",
        finishReason: "stop",
        reasoning: { state: "observed", parts: ["2 + 2 equals 4"] },
      },
    });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.headers.accept).toBe("text/event-stream");
    expect(JSON.parse(Buffer.from(transport.requests[0]!.body).toString("utf8"))).toMatchObject({
      stream: true,
    });

    const incomplete = new FakeTransport(async () =>
      new FakeResponse(
        200,
        providerStream({ done: false }),
        { "content-type": "text/event-stream; charset=utf-8" },
      ),
    );
    const failed = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      transport: incomplete,
    });
    await expect(failed.broker.invoke(request)).resolves.toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_PROTOCOL_ERROR", phase: "response", retryClass: "never" },
    });
  });

  it("emits result schema version 2 and omits a missing provider request ID", async () => {
    const { registry, snapshot } = createDescriptor();
    const transport = new FakeTransport(async () =>
      new FakeResponse(
        200,
        providerBody(),
        { "content-type": "application/json; charset=utf-8" },
        null,
      ),
    );
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      transport,
    });

    const result = await broker.invoke(invocation(snapshot.ref));

    expect(result).toMatchObject({
      schemaVersion: "dolly.model-result/2",
      status: "succeeded",
      usage: { providerAttempts: 1 },
    });
    expect(result).not.toHaveProperty("providerRequestId");
  });

  it("fails provider responses that violate the requested JSON-object syntax", async () => {
    const { registry, snapshot } = createDescriptor({ jsonObjectOutput: "supported" });
    const request: ChatBrokerInvocation = {
      ...invocation(snapshot.ref),
      reasoningPolicy: "default",
      input: {
        ...invocation(snapshot.ref).input,
        schemaVersion: "dolly.model.chat-input/3",
        outputContract: { kind: "json-object" },
      },
    };

    const validTransport = new FakeTransport(
      async () => new FakeResponse(200, providerBody(undefined, '{"answer":4}')),
    );
    const valid = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      transport: validTransport,
    });
    await expect(valid.broker.invoke(request)).resolves.toMatchObject({
      status: "succeeded",
      output: { finalContent: '{"answer":4}' },
    });

    for (const content of [
      "not JSON",
      "[]",
      "null",
      "```json\n{\"answer\":4}\n```",
      'prose before {"answer":4}',
    ]) {
      const transport = new FakeTransport(
        async () => new FakeResponse(200, providerBody(undefined, content)),
      );
      const { broker } = brokerWith({
        descriptors: registry,
        descriptor: snapshot.ref,
        transport,
      });
      await expect(broker.invoke(request)).resolves.toMatchObject({
        status: "failed",
        error: {
          code: "PROVIDER_PROTOCOL_ERROR",
          phase: "response",
          retryClass: "never",
        },
      });
      expect(transport.requests).toHaveLength(1);
    }
  });

  it("rejects exhausted budgets before resolving a secret or dispatching", async () => {
    const { registry, snapshot } = createDescriptor();
    const secrets = new FakeSecretResolver();
    const transport = new FakeTransport(async () => new FakeResponse(200, providerBody()));
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      secrets,
      transport,
    });
    const request = invocation(snapshot.ref);
    const result = await broker.invoke({
      ...request,
      budgets: { ...request.budgets, maxRequestBytes: 1 },
    });

    expect(result).toMatchObject({ status: "failed", error: { code: "BUDGET_EXCEEDED" } });
    expect(secrets.calls).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it("maps provider status and transport uncertainty without exposing raw errors", async () => {
    const { registry, snapshot } = createDescriptor();
    const rateLimitedResponse = new FakeResponse(
      429,
      Buffer.from("private provider error"),
      { "content-type": "application/json", "retry-after": "2" },
      null,
    );
    const rateLimited = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      transport: new FakeTransport(async () => rateLimitedResponse),
    });
    const rateResult = await rateLimited.broker.invoke(invocation(snapshot.ref));
    expect(rateResult).toMatchObject({
      schemaVersion: "dolly.model-result/2",
      status: "failed",
      error: { code: "RATE_LIMITED", retryClass: "after-bounded-backoff", retryAfterMs: 2000 },
      usage: { providerAttempts: 1 },
    });
    expect(rateResult).not.toHaveProperty("providerRequestId");
    expect(JSON.stringify(rateResult)).not.toContain("private provider error");
    expect(rateLimitedResponse.abort).toHaveBeenCalledOnce();

    const notAccepted = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      transport: new FakeTransport(async () => {
        throw new ModelHttpTransportError("not-accepted", "private socket detail");
      }),
    });
    await expect(notAccepted.broker.invoke(invocation(snapshot.ref))).resolves.toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_UNAVAILABLE", retryClass: "same-snapshot-before-deadline" },
    });

    const uncertain = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      transport: new FakeTransport(async () => {
        throw new ModelHttpTransportError("accepted-or-unknown", "private upstream detail");
      }),
    });
    const uncertainResult = await uncertain.broker.invoke(invocation(snapshot.ref));
    expect(uncertainResult).toMatchObject({
      status: "failed",
      error: { code: "INDETERMINATE_REMOTE_OUTCOME", retryClass: "indeterminate" },
    });
    expect(JSON.stringify(uncertainResult)).not.toContain("private upstream detail");
  });

  it("enforces per-response reasoning observation through the broker", async () => {
    const { registry, snapshot } = createDescriptor();
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      transport: new FakeTransport(async () => new FakeResponse(200, providerBody(""))),
    });
    await expect(broker.invoke(invocation(snapshot.ref))).resolves.toMatchObject({
      status: "failed",
      error: { code: "REASONING_REQUIRED_NOT_OBSERVED" },
    });
  });

  it("releases a secret lease that resolves after caller cancellation", async () => {
    const { registry, snapshot } = createDescriptor();
    const pendingSecret = deferred<ModelSecretLease>();
    let lateReleases = 0;
    const secrets = new FakeSecretResolver("unused", pendingSecret.promise);
    const transport = new FakeTransport(async () => new FakeResponse(200, providerBody()));
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor: snapshot.ref,
      secrets,
      transport,
    });
    const controller = new AbortController();
    const operation = broker.invoke(invocation(snapshot.ref), { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error("cancelled by test"));
    await expect(operation).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "CANCELLED" },
    });
    pendingSecret.resolve({
      value: "late-secret",
      release: () => {
        lateReleases += 1;
      },
    });
    await waitImmediate();
    expect(lateReleases).toBe(1);
    expect(transport.requests).toHaveLength(0);
  });

  it("aborts a transport response that arrives after cancellation", async () => {
    const { registry, snapshot } = createDescriptor();
    const pendingResponse = deferred<ModelHttpTransportResponse>();
    const lateResponse = new FakeResponse(200, providerBody());
    const transport = new FakeTransport(() => pendingResponse.promise);
    const { broker } = brokerWith({ descriptors: registry, descriptor: snapshot.ref, transport });
    const controller = new AbortController();
    const operation = broker.invoke(invocation(snapshot.ref), { signal: controller.signal });
    while (transport.requests.length === 0) await Promise.resolve();
    controller.abort(new Error("cancelled by test"));
    await expect(operation).resolves.toMatchObject({ status: "cancelled" });
    pendingResponse.resolve(lateResponse);
    await waitImmediate();
    expect(lateResponse.abort).toHaveBeenCalledOnce();
  });

  it("can be exposed through an opaque extension capability without leaking binding authority", async () => {
    const { registry, snapshot } = createDescriptor();
    const transport = new FakeTransport(async () => new FakeResponse(200, providerBody()));
    const { broker } = brokerWith({ descriptors: registry, descriptor: snapshot.ref, transport });
    const authority = new ExtensionCapabilityAuthority({
      now: () => NOW,
      nextHandle: () => "H".repeat(43),
    });
    const session = authority.openSession({
      extensionId: "llm-extension",
      instanceId: "instance-1",
      processGenerationId: "process-1",
      sessionId: "session-1",
      moduleId: "brain-1",
      moduleGenerationId: "generation-1",
    });
    let invocationContext: ExtensionCapabilityInvocationContext | undefined;
    const handle = session.issue(
      {
        capabilityType: "model-operation",
        capabilityVersion: "v1",
        operations: ["chat-completion"],
        resourceScope: { descriptor: snapshot.ref } as unknown as JsonValue,
        expiresAt: DEADLINE,
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 64 * 1024,
        maxResultBytes: 64 * 1024,
        executionScope: { moduleJobId: "module-job-1", runId: "run-1" },
        requireIdempotencyKey: true,
      },
      async (argumentsValue, context) => {
        invocationContext = context;
        return (await broker.invoke(
          argumentsValue as unknown as ChatBrokerInvocation,
        )) as unknown as JsonValue;
      },
    );

    const result = await session.invoke({
      handle,
      operation: "chat-completion",
      arguments: invocation(snapshot.ref) as unknown as JsonValue,
      moduleJobId: "module-job-1",
      runId: "run-1",
      idempotencyKey: "module-job-1-chat-primary",
    });
    expect(result).toMatchObject({ status: "succeeded", output: { finalContent: "4" } });
    expect(invocationContext).toMatchObject({
      identity: { sessionId: "session-1", moduleGenerationId: "generation-1" },
      resourceScope: { descriptor: snapshot.ref },
    });
    const extensionVisible = JSON.stringify({ handle, context: invocationContext, result });
    expect(extensionVisible).not.toContain("provider.example.test");
    expect(extensionVisible).not.toContain("host-private-key");
    expect(extensionVisible).not.toContain("secret-rev-7");
  });
});
