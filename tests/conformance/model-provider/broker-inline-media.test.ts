import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { SharpMediaInspector } from "../../../src/adapters/sharp-media-inspector.js";
import type { Block } from "../../../src/core/block-store.js";
import { createDeliveredModelMediaResolver } from "../../../src/core/media-capability/index.js";
import { EndpointBindingRegistry } from "../../../src/core/model-provider-binding.js";
import {
  ChatModelBroker,
  type ChatBrokerInvocation,
  type ModelHttpTransport,
  type ModelHttpTransportRequest,
  type ModelHttpTransportResponse,
} from "../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry } from "../../../src/core/model-provider-descriptor.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  type MediaByteStore,
} from "../../../src/core/media-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import { CHAT_STRATEGIES, chatDescriptor } from "./fixtures.js";

const NOW = "2026-08-12T16:00:00.000Z";
const DEADLINE = "2026-08-12T16:01:00.000Z";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class PausableMediaByteStore implements MediaByteStore {
  readonly durability = "volatile" as const;
  readonly #inner = new InMemoryMediaByteStore();
  #gate:
    | {
        readonly started: ReturnType<typeof deferred<void>>;
        readonly release: ReturnType<typeof deferred<void>>;
      }
    | undefined;

  pauseReads(): { readonly started: Promise<void>; readonly release: () => void } {
    const started = deferred<void>();
    const release = deferred<void>();
    this.#gate = { started, release };
    return { started: started.promise, release: () => release.resolve() };
  }

  async put(mediaId: string, bytes: Uint8Array): Promise<void> {
    await this.#inner.put(mediaId, bytes);
  }

  async get(mediaId: string): Promise<Uint8Array> {
    const gate = this.#gate;
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
      if (this.#gate === gate) this.#gate = undefined;
    }
    return this.#inner.get(mediaId);
  }

  async delete(mediaId: string): Promise<void> {
    await this.#inner.delete(mediaId);
  }

  async has(mediaId: string): Promise<boolean> {
    return this.#inner.has(mediaId);
  }
}

async function png(): Promise<Buffer> {
  return sharp({
    create: {
      width: 4,
      height: 3,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 1 },
    },
  }).png().toBuffer();
}

function block(mediaId: string): Block {
  return {
    schemaVersion: "dolly.block/2",
    id: "block-image-1",
    sequence: "000000000000000000001",
    source: { kind: "external", id: "console" },
    createdAt: NOW,
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "media-reference", mediaId }] },
    },
  };
}

class Response implements ModelHttpTransportResponse {
  readonly status = 200;
  readonly headers = { "content-type": "text/event-stream" };
  readonly abort = vi.fn();
  readonly body: AsyncIterable<Uint8Array>;

  constructor() {
    const bytes = Buffer.from([
      `data: ${JSON.stringify({
        id: "provider-media-1",
        choices: [{ index: 0, delta: { role: "assistant", content: "seen" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "provider-media-1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "provider-media-1",
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
    this.body = {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    };
  }
}

class Transport implements ModelHttpTransport {
  readonly requests: ModelHttpTransportRequest[] = [];
  async dispatch(request: ModelHttpTransportRequest): Promise<ModelHttpTransportResponse> {
    this.requests.push(request);
    return new Response();
  }
}

describe("delivered inline Media through the model provider broker", () => {
  it("composes Sharp inspection, MediaStore verification, Run scope, and strict streaming wire", async () => {
    const image = await png();
    const byteStore = new PausableMediaByteStore();
    const media = new MediaStore({
      durability: "volatile",
      referenceGraph: new ReferenceGraph(),
      bytes: byteStore,
      inspector: new SharpMediaInspector({ maxInputPixels: 100 }),
      maxMediaBytes: 1024 * 1024,
      idNamespace: "broker-inline-media",
      now: () => NOW,
    });
    const registered = await media.registerMedia({
      registrationId: "registration-model-image-1",
      bytes: image,
      declaredMimeType: "image/png",
      provenance: { sourceClass: "streamed-upload" },
    });
    expect(registered).toMatchObject({
      mimeType: "image/png",
      byteLength: image.byteLength,
      width: 4,
      height: 3,
    });

    const descriptors = new ModelDescriptorRegistry({
      schemaDigest: `sha256:${"9".repeat(64)}`,
      allowedStrategyIds: CHAT_STRATEGIES,
    });
    const descriptor = descriptors.register(chatDescriptor({
      inlinePng: true,
      descriptorVersion: "inline-png-v1",
    }));
    descriptors.setStatus(descriptor, "active");
    const bindings = new EndpointBindingRegistry();
    const binding = bindings.register({
      schemaVersion: "dolly.endpoint-binding/2",
      endpointId: descriptor.endpointId,
      bindingRevision: "inline-binding-v1",
      descriptorRefs: [descriptor],
      exactUrl: "https://provider.example.test/v1/chat/completions",
      networkScope: "public",
      authentication: {
        kind: "bearer-secret",
        secretRef: "fixture-secret",
        secretRevision: "fixture-secret-v1",
      },
      limits: {
        maxRequestBytes: 1024 * 1024,
        maxResponseBytes: 64 * 1024,
        maxTimeoutMs: 30_000,
      },
    });
    bindings.setStatus(binding, "active");

    const claim = {
      moduleJobId: "module-job-image-1",
      runId: "run-image-1",
      blockGroups: [{ block: block(registered.mediaId), deliveryIds: ["delivery-image-1"] }],
    };
    const session = {
      extensionId: "llm-extension",
      instanceId: "instance-1",
      processGenerationId: "process-generation-1",
      sessionId: "session-1",
      moduleId: "brain-1",
      moduleGenerationId: "module-generation-1",
    };
    const active = vi.fn(() => true);
    const resolver = createDeliveredModelMediaResolver({
      claim,
      session,
      source: media,
      isActiveRun: active,
      now: () => NOW,
    });
    const transport = new Transport();
    const resolveSecret = vi.fn(async () => ({ value: "private-key", release: vi.fn() }));
    const broker = new ChatModelBroker({
      descriptors,
      bindings,
      secrets: { resolve: resolveSecret },
      transport,
      media: resolver,
      now: () => NOW,
    });
    const invocation: ChatBrokerInvocation = {
      schemaVersion: "dolly.model.chat-invocation/3",
      requestId: "model-request-image-1",
      descriptor,
      context: {
        operationId: "operation-image-1",
        instanceId: session.instanceId,
        ownerScope: "owner-1",
        moduleId: session.moduleId,
        moduleGenerationId: session.moduleGenerationId,
        moduleJobId: claim.moduleJobId,
        runId: claim.runId,
        attempt: 1,
        sessionId: session.sessionId,
        deadline: DEADLINE,
      },
      budgets: {
        maxProviderAttempts: 1,
        maxWallTimeMs: 30_000,
        maxRequestBytes: 1024 * 1024,
        maxResponseBytes: 64 * 1024,
        maxInputItems: 8,
        maxInputBytes: 512 * 1024,
        maxOutputBytes: 32 * 1024,
        maxOutputTokens: 128,
        maxMediaItems: 1,
        maxResolvedMediaBytes: image.byteLength,
      },
      reasoningPolicy: "default",
      input: {
        schemaVersion: "dolly.model.chat-input/2",
        messages: [{
          role: "user",
          parts: [
            { kind: "text", text: "Describe the delivered image." },
            {
              kind: "media",
              mediaReference: { type: "media-reference", mediaId: registered.mediaId },
              requirementId: "inline-png-v1",
            },
          ],
        }],
        outputContract: { kind: "text" },
        stream: true,
      },
    };

    await expect(broker.invoke(invocation)).resolves.toMatchObject({
      status: "succeeded",
      output: { finalContent: "seen", finishReason: "stop" },
    });
    expect(active).toHaveBeenCalledTimes(2);
    expect(resolveSecret).toHaveBeenCalledOnce();
    expect(transport.requests).toHaveLength(1);
    const wire = JSON.parse(Buffer.from(transport.requests[0]!.body).toString("utf8"));
    expect(wire).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ content: [
        { type: "text", text: "Describe the delivered image." },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
        },
      ] }],
    });
    expect(JSON.stringify(wire)).not.toContain(registered.mediaId);
    expect(media.listProviderAccessRecords()).toEqual([]);
    expect(media.referenceGraph.leaseCountFor({ kind: "media", id: registered.mediaId })).toBe(0);

    transport.requests.length = 0;
    resolveSecret.mockClear();
    await expect(broker.invoke({
      ...invocation,
      requestId: "model-request-cross-run",
      context: { ...invocation.context, runId: "run-other" },
    })).resolves.toMatchObject({
      status: "failed",
      error: { code: "INVALID_REQUEST", phase: "validation" },
    });
    expect(resolveSecret).toHaveBeenCalledTimes(0);
    expect(transport.requests).toHaveLength(0);

    const lateRead = byteStore.pauseReads();
    const timed = broker.invoke({
      ...invocation,
      requestId: "model-request-late-media",
      budgets: { ...invocation.budgets, maxWallTimeMs: 20 },
    });
    await lateRead.started;
    await expect(timed).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "DEADLINE_EXCEEDED", phase: "validation" },
    });
    expect(resolveSecret).toHaveBeenCalledTimes(0);
    expect(transport.requests).toHaveLength(0);
    expect(media.referenceGraph.leaseCountFor({ kind: "media", id: registered.mediaId })).toBe(1);

    lateRead.release();
    await vi.waitFor(() => {
      expect(media.referenceGraph.leaseCountFor({ kind: "media", id: registered.mediaId })).toBe(0);
    });
    expect(resolveSecret).toHaveBeenCalledTimes(0);
    expect(transport.requests).toHaveLength(0);
  });
});
