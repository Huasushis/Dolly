import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { EndpointBindingRegistry } from "../../../src/core/model-provider-binding.js";
import {
  ModelHttpTransportError,
  type ModelHttpTransportRequest,
  type ModelSecretResolver,
} from "../../../src/core/model-provider-broker.js";
import {
  EmbeddingModelBroker,
  type EmbeddingBrokerInvocation,
} from "../../../src/core/model-provider-embedding-broker.js";
import { EmbeddingDescriptorRegistry } from "../../../src/core/model-provider-embedding.js";
import { NodeModelHttpTransport } from "../../../src/core/model-provider-node-http.js";
import type { SecureDnsResolver } from "../../../src/core/secure-remote-fetch.js";
import { EMBEDDING_STRATEGIES, textEmbeddingDescriptor } from "./fixtures.js";

const NOW = "2026-07-24T08:00:00.000Z";
const DEADLINE = "2026-07-24T08:01:00.000Z";
const SCHEMA_DIGEST = `sha256:${"9".repeat(64)}`;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function setupBroker(port: number): {
  readonly broker: EmbeddingModelBroker;
  readonly invocation: EmbeddingBrokerInvocation;
} {
  const descriptors = new EmbeddingDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: EMBEDDING_STRATEGIES,
  });
  const descriptor = descriptors.register(textEmbeddingDescriptor());
  descriptors.setStatus(descriptor, "active");
  const bindings = new EndpointBindingRegistry();
  const binding = bindings.register({
    schemaVersion: "dolly.endpoint-binding/2",
    endpointId: descriptor.endpointId,
    bindingRevision: "real-loopback-binding-v1",
    descriptorRefs: [descriptor],
    exactUrl: `http://127.0.0.1:${port}/exact/embeddings`,
    networkScope: "loopback",
    authentication: { kind: "none" },
    limits: {
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 64 * 1024,
      maxTimeoutMs: 30_000,
    },
  });
  bindings.setStatus(binding, "active");
  const secrets: ModelSecretResolver = {
    resolve: vi.fn(async () => {
      throw new Error("No secret should be resolved for this binding");
    }),
  };
  return {
    broker: new EmbeddingModelBroker({
      descriptors,
      bindings,
      secrets,
      transport: new NodeModelHttpTransport(),
      now: () => NOW,
    }),
    invocation: {
      schemaVersion: "dolly.model.embedding-invocation/3",
      requestId: "real-http-request",
      descriptor,
      context: {
        operationId: "real-http-operation",
        instanceId: "instance-1",
        ownerScope: "owner-1",
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
      input: {
        schemaVersion: "dolly.model.embedding-input/2",
        outputDimension: 3,
        items: [{ itemId: "item-1", input: { kind: "text", text: "hello" } }],
      },
    },
  };
}

describe("production Node model HTTP transport", () => {
  it("executes an exact loopback route with bounded identity-encoded HTTP", async () => {
    const observations: Array<{
      method?: string;
      url?: string;
      headers: typeof import("node:http").IncomingHttpHeaders;
      body: string;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        observations.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "x-request-id": "real-provider-request",
        });
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: [1, 0, 0] }],
            model: "fixture-text-embedding-model",
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        );
      });
    });
    const port = await listen(server);
    try {
      const { broker, invocation } = setupBroker(port);
      await expect(broker.invoke(invocation)).resolves.toMatchObject({
        status: "succeeded",
        providerRequestId: "real-provider-request",
        output: { items: [{ itemId: "item-1", vector: [1, 0, 0] }] },
      });
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        method: "POST",
        url: "/exact/embeddings",
      });
      expect(observations[0]!.headers["accept-encoding"]).toBe("identity");
      expect(Number(observations[0]!.headers["content-length"])).toBe(
        Buffer.byteLength(observations[0]!.body),
      );
      expect(JSON.parse(observations[0]!.body)).toEqual({
        encoding_format: "float",
        input: ["hello"],
        model: "fixture-text-embedding-model",
      });
    } finally {
      await close(server);
    }
  });

  it("does not follow redirects and rejects compressed provider responses", async () => {
    let redirectedHits = 0;
    let mode: "redirect" | "compressed" = "redirect";
    const server = createServer((request, response) => {
      request.resume();
      if (request.url === "/redirected") {
        redirectedHits += 1;
        response.writeHead(500).end();
        return;
      }
      if (mode === "redirect") {
        response.writeHead(307, { location: "/redirected" }).end();
      } else {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        response.end("compressed-or-not-is-irrelevant");
      }
    });
    const port = await listen(server);
    try {
      const { broker, invocation } = setupBroker(port);
      await expect(broker.invoke(invocation)).resolves.toMatchObject({
        status: "failed",
        error: { code: "PROVIDER_REJECTED" },
      });
      expect(redirectedHits).toBe(0);

      mode = "compressed";
      await expect(broker.invoke(invocation)).resolves.toMatchObject({
        status: "failed",
        error: { code: "PROVIDER_PROTOCOL_ERROR" },
      });
      expect(redirectedHits).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("rejects mixed/private DNS and network-scope mismatches before opening a connection", async () => {
    const resolver: SecureDnsResolver = {
      resolve: vi.fn(async () => [
        { address: "93.184.216.34", family: 4 as const },
        { address: "127.0.0.1", family: 4 as const },
      ]),
    };
    const transport = new NodeModelHttpTransport({ resolver });
    const controller = new AbortController();
    const base: ModelHttpTransportRequest = {
      url: new URL("https://provider.example.test/v1/embeddings"),
      networkScope: "public",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
      timeoutMs: 1000,
      maxResponseBytes: 1024,
      signal: controller.signal,
    };
    await expect(transport.dispatch(base)).rejects.toMatchObject({
      name: "ModelHttpTransportError",
      outcome: "not-accepted",
    });
    await expect(
      transport.dispatch({
        ...base,
        url: new URL("http://localhost:8123/v1/embeddings"),
        networkScope: "loopback",
      }),
    ).rejects.toBeInstanceOf(ModelHttpTransportError);
    expect(resolver.resolve).toHaveBeenCalledOnce();
  });
});
