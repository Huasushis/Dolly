import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ExtensionCapabilityAuthority,
  type ExtensionCapabilityInvocationContext,
} from "../../../src/core/extension-capability.js";
import {
  EndpointBindingRegistry,
  type EndpointBindingDocument,
} from "../../../src/core/model-provider-binding.js";
import {
  ModelHttpTransportError,
  type ModelHttpTransport,
  type ModelHttpTransportRequest,
  type ModelHttpTransportResponse,
  type ModelSecretLease,
  type ModelSecretResolver,
} from "../../../src/core/model-provider-broker.js";
import {
  EmbeddingModelBroker,
  type EmbeddingBrokerInvocation,
} from "../../../src/core/model-provider-embedding-broker.js";
import {
  EmbeddingDescriptorRegistry,
  type EmbeddingInput,
} from "../../../src/core/model-provider-embedding.js";
import type { DescriptorRef } from "../../../src/core/model-provider-descriptor.js";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import {
  EMBEDDING_STRATEGIES,
  nativeVlEmbeddingDescriptor,
  textEmbeddingDescriptor,
} from "./fixtures.js";

const NOW = "2026-07-24T08:00:00.000Z";
const DEADLINE = "2026-07-24T08:01:00.000Z";
const SCHEMA_DIGEST = `sha256:${"f".repeat(64)}`;

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
    bytes: Uint8Array,
    readonly headers: Readonly<Record<string, string>> = {
      "content-type": "application/json; charset=utf-8",
    },
    providerRequestId: string | null = "embedding-provider-request-1",
  ) {
    if (providerRequestId !== null) this.providerRequestId = providerRequestId;
    this.body = {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    };
  }
}

class FakeSecretResolver implements ModelSecretResolver {
  readonly calls: Array<{ secretRef: string; secretRevision: string }> = [];
  releases = 0;

  constructor(
    private readonly value = "host-private-embedding-key",
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

function providerBody(model: string, vector: readonly number[] = [1, 0, 0]): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: vector }],
      model,
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }),
  );
}

function createTextDescriptor(): {
  registry: EmbeddingDescriptorRegistry;
  descriptor: DescriptorRef;
} {
  const registry = new EmbeddingDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: EMBEDDING_STRATEGIES,
  });
  const descriptor = registry.register(textEmbeddingDescriptor());
  registry.setStatus(descriptor, "active");
  return { registry, descriptor };
}

function bindingFor(descriptor: DescriptorRef): EndpointBindingDocument {
  return {
    schemaVersion: "dolly.endpoint-binding/2",
    endpointId: descriptor.endpointId,
    bindingRevision: "embedding-private-binding-v1",
    descriptorRefs: [descriptor],
    exactUrl: "https://embedding.example.test/exact/embeddings",
    networkScope: "public",
    authentication: {
      kind: "bearer-secret",
      secretRef: "embedding-primary-key",
      secretRevision: "secret-rev-3",
    },
    limits: {
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 64 * 1024,
      maxTimeoutMs: 30_000,
    },
  };
}

function activeBindings(descriptor: DescriptorRef): EndpointBindingRegistry {
  const bindings = new EndpointBindingRegistry();
  const ref = bindings.register(bindingFor(descriptor));
  bindings.setStatus(ref, "active");
  return bindings;
}

function invocation(descriptor: DescriptorRef, input?: EmbeddingInput): EmbeddingBrokerInvocation {
  return {
    schemaVersion: "dolly.model.embedding-invocation/3",
    requestId: "embedding-request-1",
    descriptor,
    context: {
      operationId: "embedding-operation-1",
      instanceId: "instance-1",
      ownerScope: "owner-1",
      moduleId: "memory-1",
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      idempotencyKey: "module-job-1-embedding-primary",
      deadline: DEADLINE,
    },
    budgets: {
      maxProviderAttempts: 1,
      maxWallTimeMs: 30_000,
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 64 * 1024,
      maxInputItems: 8,
      maxInputBytes: 32 * 1024,
      maxOutputBytes: 32 * 1024,
    },
    input: input ?? {
      schemaVersion: "dolly.model.embedding-input/2",
      outputDimension: 3,
      items: [{ itemId: "item-1", input: { kind: "text", text: "hello" } }],
    },
  };
}

function brokerWith(options: {
  descriptors: EmbeddingDescriptorRegistry;
  descriptor: DescriptorRef;
  bindings?: EndpointBindingRegistry;
  secrets?: ModelSecretResolver;
  transport?: ModelHttpTransport;
}) {
  const bindings = options.bindings ?? activeBindings(options.descriptor);
  const secrets = options.secrets ?? new FakeSecretResolver();
  const transport =
    options.transport ??
    new FakeTransport(async () =>
      new FakeResponse(200, providerBody(options.descriptor.modelId)),
    );
  return {
    broker: new EmbeddingModelBroker({
      descriptors: options.descriptors,
      bindings,
      secrets,
      transport,
      now: () => NOW,
    }),
    bindings,
    secrets,
    transport,
  };
}

describe("embedding model provider broker", () => {
  it("rejects previous embedding invocation versions and removed context fields", async () => {
    const { registry, descriptor } = createTextDescriptor();
    const { broker, secrets, transport } = brokerWith({ descriptors: registry, descriptor });
    const current = invocation(descriptor);

    for (const schemaVersion of [
      "dolly.model.embedding-invocation/1",
      "dolly.model.embedding-invocation/2",
    ]) {
      await expect(
        broker.invoke({ ...current, schemaVersion } as unknown as EmbeddingBrokerInvocation),
      ).rejects.toMatchObject({ code: "BROKER_REQUEST_INVALID" });
    }

    const removedField = structuredClone(current) as unknown as {
      context: Record<string, unknown>;
    };
    removedField.context.moduleInstanceId = removedField.context.moduleId;
    delete removedField.context.moduleId;
    await expect(
      broker.invoke(removedField as unknown as EmbeddingBrokerInvocation),
    ).rejects.toMatchObject({ code: "BROKER_REQUEST_INVALID" });

    const previousJobField = structuredClone(current) as unknown as {
      context: Record<string, unknown>;
    };
    previousJobField.context.processingId = previousJobField.context.moduleJobId;
    delete previousJobField.context.moduleJobId;
    await expect(
      broker.invoke(previousJobField as unknown as EmbeddingBrokerInvocation),
    ).rejects.toMatchObject({ code: "BROKER_REQUEST_INVALID" });

    expect(secrets.calls).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it("keeps exact URL and bearer credentials inside the host transport", async () => {
    const { registry, descriptor } = createTextDescriptor();
    const secrets = new FakeSecretResolver();
    const transport = new FakeTransport(async () =>
      new FakeResponse(200, providerBody(descriptor.modelId)),
    );
    const { broker } = brokerWith({ descriptors: registry, descriptor, secrets, transport });
    const result = await broker.invoke(invocation(descriptor));

    expect(result).toMatchObject({
      status: "succeeded",
      providerRequestId: "embedding-provider-request-1",
      output: {
        items: [
          {
            itemId: "item-1",
            status: "succeeded",
            vector: [1, 0, 0],
            dimension: 3,
          },
        ],
      },
    });
    expect(secrets.calls).toEqual([
      { secretRef: "embedding-primary-key", secretRevision: "secret-rev-3" },
    ]);
    expect(secrets.releases).toBe(1);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.url.href).toBe(
      "https://embedding.example.test/exact/embeddings",
    );
    expect(transport.requests[0]!.headers.authorization).toBe(
      "Bearer host-private-embedding-key",
    );
    expect(JSON.parse(Buffer.from(transport.requests[0]!.body).toString("utf8"))).toEqual({
      encoding_format: "float",
      input: ["hello"],
      model: descriptor.modelId,
    });
    const consumerVisible = JSON.stringify(result);
    expect(consumerVisible).not.toContain("embedding.example.test");
    expect(consumerVisible).not.toContain("host-private-embedding-key");
    expect(consumerVisible).not.toContain("secret-rev-3");
  });

  it("emits result schema version 2 and omits a missing provider request ID", async () => {
    const { registry, descriptor } = createTextDescriptor();
    const transport = new FakeTransport(async () =>
      new FakeResponse(
        200,
        providerBody(descriptor.modelId),
        { "content-type": "application/json; charset=utf-8" },
        null,
      ),
    );
    const { broker } = brokerWith({ descriptors: registry, descriptor, transport });

    const result = await broker.invoke(invocation(descriptor));

    expect(result).toMatchObject({
      schemaVersion: "dolly.model-result/2",
      status: "succeeded",
      usage: { providerAttempts: 1 },
    });
    expect(result).not.toHaveProperty("providerRequestId");
  });

  it("rejects unsupported media before binding, secret resolution, or provider I/O", async () => {
    const { registry, descriptor } = createTextDescriptor();
    const secrets = new FakeSecretResolver();
    const transport = new FakeTransport(async () =>
      new FakeResponse(200, providerBody(descriptor.modelId)),
    );
    const { broker } = brokerWith({
      descriptors: registry,
      descriptor,
      bindings: new EndpointBindingRegistry(),
      secrets,
      transport,
    });
    const mediaInput = {
      schemaVersion: "dolly.model.embedding-input/2",
      outputDimension: 3,
      items: [
        {
          itemId: "image-1",
          input: {
            kind: "media",
            modality: "image",
            mediaReference: { type: "media-reference", mediaId: "media-1" },
            requirementId: "image-input",
          },
        },
      ],
    } as unknown as EmbeddingInput;
    await expect(broker.invoke(invocation(descriptor, mediaInput))).resolves.toMatchObject({
      status: "failed",
      error: { code: "FEATURE_UNSUPPORTED", phase: "validation" },
    });
    expect(secrets.calls).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it("does not treat a declared native-VL feature as an installed wire codec", async () => {
    const descriptors = new EmbeddingDescriptorRegistry({
      schemaDigest: SCHEMA_DIGEST,
      allowedStrategyIds: EMBEDDING_STRATEGIES,
    });
    const descriptor = descriptors.register(nativeVlEmbeddingDescriptor());
    descriptors.setStatus(descriptor, "active");
    const secrets = new FakeSecretResolver();
    const transport = new FakeTransport(async () =>
      new FakeResponse(200, providerBody(descriptor.modelId, [1, 0, 0, 0])),
    );
    const { broker } = brokerWith({ descriptors, descriptor, secrets, transport });
    const mediaInput: EmbeddingInput = {
      schemaVersion: "dolly.model.embedding-input/2",
      outputDimension: 4,
      items: [
        {
          itemId: "image-1",
          input: {
            kind: "media",
            modality: "image",
            mediaReference: { type: "media-reference", mediaId: "media-1" },
            requirementId: "native-image-input-v1",
          },
        },
      ],
    };
    await expect(broker.invoke(invocation(descriptor, mediaInput))).resolves.toMatchObject({
      status: "failed",
      error: { code: "FEATURE_UNSUPPORTED" },
    });
    expect(secrets.calls).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it("rejects exhausted invocation budgets before resolving a secret", async () => {
    const { registry, descriptor } = createTextDescriptor();
    const secrets = new FakeSecretResolver();
    const transport = new FakeTransport(async () =>
      new FakeResponse(200, providerBody(descriptor.modelId)),
    );
    const { broker } = brokerWith({ descriptors: registry, descriptor, secrets, transport });
    const request = invocation(descriptor);
    const result = await broker.invoke({
      ...request,
      budgets: { ...request.budgets, maxRequestBytes: 1 },
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "BUDGET_EXCEEDED" } });
    expect(secrets.calls).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it("sanitizes provider status, protocol, and uncertain transport failures", async () => {
    const { registry, descriptor } = createTextDescriptor();
    const rateResponse = new FakeResponse(
      429,
      Buffer.from("private rate-limit body"),
      { "content-type": "application/json", "retry-after": "999999999" },
      null,
    );
    const rate = brokerWith({
      descriptors: registry,
      descriptor,
      transport: new FakeTransport(async () => rateResponse),
    });
    const rateResult = await rate.broker.invoke(invocation(descriptor));
    expect(rateResult).toMatchObject({
      schemaVersion: "dolly.model-result/2",
      status: "failed",
      error: { code: "RATE_LIMITED", retryAfterMs: 86_400_000 },
      usage: { providerAttempts: 1 },
    });
    expect(rateResult).not.toHaveProperty("providerRequestId");
    expect(JSON.stringify(rateResult)).not.toContain("private rate-limit body");
    expect(rateResponse.abort).toHaveBeenCalledOnce();

    const malformed = brokerWith({
      descriptors: registry,
      descriptor,
      transport: new FakeTransport(async () =>
        new FakeResponse(200, providerBody("wrong-model")),
      ),
    });
    await expect(malformed.broker.invoke(invocation(descriptor))).resolves.toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_PROTOCOL_ERROR" },
    });

    const uncertain = brokerWith({
      descriptors: registry,
      descriptor,
      transport: new FakeTransport(async () => {
        throw new ModelHttpTransportError("accepted-or-unknown", "private upstream detail");
      }),
    });
    const uncertainResult = await uncertain.broker.invoke(invocation(descriptor));
    expect(uncertainResult).toMatchObject({
      status: "failed",
      error: { code: "INDETERMINATE_REMOTE_OUTCOME", retryClass: "indeterminate" },
    });
    expect(JSON.stringify(uncertainResult)).not.toContain("private upstream detail");
  });

  it("classifies oversized and non-byte response bodies at the shared transport boundary", async () => {
    const { registry, descriptor } = createTextDescriptor();
    const oversized = new FakeResponse(200, Buffer.alloc(65 * 1024, 0x20));
    const oversizedBroker = brokerWith({
      descriptors: registry,
      descriptor,
      transport: new FakeTransport(async () => oversized),
    });
    await expect(oversizedBroker.broker.invoke(invocation(descriptor))).resolves.toMatchObject({
      status: "failed",
      error: { code: "OUTPUT_LIMIT_EXCEEDED", retryClass: "never" },
    });
    expect(oversized.abort).toHaveBeenCalledOnce();

    const abort = vi.fn();
    const nonByte: ModelHttpTransportResponse = {
      status: 200,
      headers: { "content-type": "application/json" },
      providerRequestId: "non-byte-response",
      body: {
        async *[Symbol.asyncIterator]() {
          yield "not bytes" as unknown as Uint8Array;
        },
      },
      abort,
    };
    const nonByteBroker = brokerWith({
      descriptors: registry,
      descriptor,
      transport: new FakeTransport(async () => nonByte),
    });
    await expect(nonByteBroker.broker.invoke(invocation(descriptor))).resolves.toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_PROTOCOL_ERROR", retryClass: "never" },
    });
    expect(abort).toHaveBeenCalledOnce();

    const invalidStatus = new FakeResponse(Number.NaN, providerBody(descriptor.modelId));
    const invalidStatusBroker = brokerWith({
      descriptors: registry,
      descriptor,
      transport: new FakeTransport(async () => invalidStatus),
    });
    await expect(invalidStatusBroker.broker.invoke(invocation(descriptor))).resolves.toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_PROTOCOL_ERROR", retryClass: "never" },
    });
    expect(invalidStatus.abort).toHaveBeenCalledOnce();
  });

  it("does not let an unresolved asynchronous secret cleanup hold the invocation open", async () => {
    const { registry, descriptor } = createTextDescriptor();
    let releaseCalls = 0;
    const secrets: ModelSecretResolver = {
      async resolve() {
        return {
          value: "host-private-embedding-key",
          release() {
            releaseCalls += 1;
            return new Promise<void>(() => undefined);
          },
        };
      },
    };
    const { broker } = brokerWith({ descriptors: registry, descriptor, secrets });
    await expect(broker.invoke(invocation(descriptor))).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(releaseCalls).toBe(1);
  });

  it("releases a secret lease that resolves after cancellation", async () => {
    const { registry, descriptor } = createTextDescriptor();
    const pendingSecret = deferred<ModelSecretLease>();
    let lateReleases = 0;
    const secrets = new FakeSecretResolver("unused", pendingSecret.promise);
    const transport = new FakeTransport(async () =>
      new FakeResponse(200, providerBody(descriptor.modelId)),
    );
    const { broker } = brokerWith({ descriptors: registry, descriptor, secrets, transport });
    const controller = new AbortController();
    const operation = broker.invoke(invocation(descriptor), { signal: controller.signal });
    while (secrets.calls.length === 0) await Promise.resolve();
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

  it("aborts a provider response that arrives after cancellation", async () => {
    const { registry, descriptor } = createTextDescriptor();
    const pendingResponse = deferred<ModelHttpTransportResponse>();
    const lateResponse = new FakeResponse(200, providerBody(descriptor.modelId));
    const transport = new FakeTransport(() => pendingResponse.promise);
    const { broker } = brokerWith({ descriptors: registry, descriptor, transport });
    const controller = new AbortController();
    const operation = broker.invoke(invocation(descriptor), { signal: controller.signal });
    while (transport.requests.length === 0) await Promise.resolve();
    controller.abort(new Error("cancelled by test"));
    await expect(operation).resolves.toMatchObject({ status: "cancelled" });
    pendingResponse.resolve(lateResponse);
    await waitImmediate();
    expect(lateResponse.abort).toHaveBeenCalledOnce();
  });

  it("exposes embedding through an opaque extension capability without host authority", async () => {
    const { registry, descriptor } = createTextDescriptor();
    const transport = new FakeTransport(async () =>
      new FakeResponse(200, providerBody(descriptor.modelId)),
    );
    const { broker } = brokerWith({ descriptors: registry, descriptor, transport });
    const authority = new ExtensionCapabilityAuthority({
      now: () => NOW,
      nextHandle: () => "E".repeat(43),
    });
    const session = authority.openSession({
      extensionId: "memory-extension",
      instanceId: "instance-1",
      processGenerationId: "process-1",
      sessionId: "session-1",
      moduleId: "memory-1",
      moduleGenerationId: "generation-1",
    });
    let invocationContext: ExtensionCapabilityInvocationContext | undefined;
    const handle = session.issue(
      {
        capabilityType: "model-operation",
        capabilityVersion: "v1",
        operations: ["embedding"],
        resourceScope: { descriptor } as unknown as JsonValue,
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
          argumentsValue as unknown as EmbeddingBrokerInvocation,
        )) as unknown as JsonValue;
      },
    );

    const result = await session.invoke({
      handle,
      operation: "embedding",
      arguments: invocation(descriptor) as unknown as JsonValue,
      moduleJobId: "module-job-1",
      runId: "run-1",
      idempotencyKey: "module-job-1-embedding-primary",
    });
    expect(result).toMatchObject({ status: "succeeded", output: { items: [{ itemId: "item-1" }] } });
    expect(invocationContext).toMatchObject({
      identity: { sessionId: "session-1", moduleGenerationId: "generation-1" },
      resourceScope: { descriptor },
    });
    const extensionVisible = JSON.stringify({ handle, invocationContext, result });
    expect(extensionVisible).not.toContain("embedding.example.test");
    expect(extensionVisible).not.toContain("host-private-embedding-key");
    expect(extensionVisible).not.toContain("secret-rev-3");
  });
});
