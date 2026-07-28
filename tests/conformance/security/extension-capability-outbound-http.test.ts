import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { canonicalizeJson, type JsonValue } from "../../../src/core/canonical-json.js";
import {
  ExtensionCapabilityAuthority,
  type ExtensionCapabilityHandle,
  type ExtensionSessionIdentity,
} from "../../../src/core/extension-capability.js";
import type { ModelSecretResolver } from "../../../src/core/model-provider-broker.js";
import {
  createOutboundHttpCapability,
  NodeOutboundHttpTransport,
  type OutboundHttpAuditRecord,
  type OutboundHttpCapabilityOptions,
  type OutboundHttpTransport,
} from "../../../src/core/provider-capabilities/index.js";
import type { SecureDnsResolver } from "../../../src/core/secure-remote-fetch.js";

const NOW = "2026-07-26T00:00:00.000Z";
const EXPIRES_AT = "2026-07-27T00:00:00.000Z";
const IDENTITY: ExtensionSessionIdentity = {
  extensionId: "com.example.outbound",
  instanceId: "instance-a",
  processGenerationId: "process-generation-a",
  sessionId: "session-a",
  moduleId: "module-a",
  moduleGenerationId: "module-generation-a",
};
const EXECUTION_SCOPE = { moduleJobId: "module-job-a", runId: "run-a" } as const;
const SECRET = "outbound-fixture-secret-8f31c0a2";

interface ServerObservation {
  readonly method: string;
  readonly url: string;
  readonly host: string;
  readonly authorization: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

interface Fixture {
  readonly port: number;
  readonly observations: ServerObservation[];
  close(): Promise<void>;
}

async function startServer(
  route: (request: IncomingMessage, response: ServerResponse, port: number) => void,
): Promise<Fixture> {
  const observations: ServerObservation[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      observations.push({
        method: request.method ?? "",
        url: request.url ?? "",
        host: String(request.headers.host ?? ""),
        authorization:
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      route(request, response, (server.address() as AddressInfo).port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    observations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

interface HarnessOptions {
  readonly port: number;
  readonly resolver?: SecureDnsResolver;
  readonly transport?: OutboundHttpTransport;
  readonly overrides?: Partial<OutboundHttpCapabilityOptions>;
}

function loopbackResolver(): SecureDnsResolver {
  return { resolve: vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]) };
}

function secretResolver(): ModelSecretResolver {
  return {
    resolve: vi.fn(async () => ({ value: SECRET, release: () => undefined })),
  };
}

function createHarness(options: HarnessOptions) {
  let handleSeed = 0;
  const authority = new ExtensionCapabilityAuthority({
    now: () => NOW,
    nextHandle: () => Buffer.alloc(32, (handleSeed += 1)).toString("base64url"),
  });
  const session = authority.openSession(IDENTITY);
  const audit: OutboundHttpAuditRecord[] = [];
  const resolver = options.resolver ?? loopbackResolver();
  const definition = createOutboundHttpCapability({
    destination: {
      networkScope: "loopback",
      allowedHosts: ["primary.test", "secondary.test"],
      allowedPorts: [options.port],
      allowedMethods: ["GET", "POST"],
      allowedPathPrefixes: ["/allowed"],
    },
    redirects: { mode: "same-host", maxRedirects: 3 },
    credential: { kind: "none" },
    transport: options.transport ?? new NodeOutboundHttpTransport(),
    resolver,
    executionScope: EXECUTION_SCOPE,
    expiresAt: EXPIRES_AT,
    audit: { append: (record) => audit.push(record) },
    limits: {
      maxResponseBytes: 4_096,
      maxRequestBytes: 1_024,
      connectTimeoutMs: 2_000,
      headerTimeoutMs: 3_000,
      totalTimeoutMs: 5_000,
    },
    requestHeaderAllowlist: ["x-trace"],
    ...(options.overrides ?? {}),
  } as OutboundHttpCapabilityOptions);
  const handle: ExtensionCapabilityHandle = session.issue(definition.grant, definition.handler);
  return {
    authority,
    session,
    handle,
    audit,
    resolver,
    grant: definition.grant,
    request(argumentsValue: unknown): Promise<JsonValue> {
      return session.invoke({
        handle,
        operation: "request",
        arguments: argumentsValue as JsonValue,
        moduleJobId: EXECUTION_SCOPE.moduleJobId,
        runId: EXECUTION_SCOPE.runId,
      });
    },
  };
}

function decodeBody(result: JsonValue): string {
  const body = (result as { bodyBase64: string }).bodyBase64;
  return Buffer.from(body, "base64").toString("utf8");
}

describe("Extension outbound HTTP capability", () => {
  it("pins the connection to the address the host validated", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    try {
      const harness = createHarness({ port: fixture.port });
      const result = await harness.request({
        url: `http://primary.test:${fixture.port}/allowed/thing`,
      });

      expect(result).toMatchObject({
        schemaVersion: "dolly.outbound-http-response/1",
        status: 200,
        redirects: 0,
        finalUrl: `http://primary.test:${fixture.port}/allowed/thing`,
      });
      expect(decodeBody(result)).toBe(JSON.stringify({ ok: true }));
      // The name is not a real DNS record: reaching the server at all proves
      // the socket used the address the capability resolved and validated.
      expect(harness.resolver.resolve).toHaveBeenCalledWith("primary.test");
      expect(harness.resolver.resolve).toHaveBeenCalledTimes(1);
      expect(fixture.observations).toHaveLength(1);
      expect(fixture.observations[0]!.host).toBe(`primary.test:${fixture.port}`);
      expect(fixture.observations[0]!.headers["accept-encoding"]).toBe("identity");
      expect(harness.audit).toEqual([
        expect.objectContaining({
          outcome: "succeeded",
          status: 200,
          host: "primary.test",
          port: fixture.port,
          path: "/allowed/thing",
          authentication: "none",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("follows a revalidated same-host redirect and refuses one that leaves the host", async () => {
    const fixture = await startServer((request, response, port) => {
      if (request.url === "/allowed/hop") {
        response.writeHead(302, { location: "/allowed/final" }).end();
        return;
      }
      if (request.url === "/allowed/cross") {
        response
          .writeHead(302, { location: `http://secondary.test:${port}/allowed/final` })
          .end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("arrived");
    });
    try {
      const harness = createHarness({ port: fixture.port });
      const followed = await harness.request({
        url: `http://primary.test:${fixture.port}/allowed/hop`,
      });
      expect(followed).toMatchObject({
        status: 200,
        redirects: 1,
        finalUrl: `http://primary.test:${fixture.port}/allowed/final`,
      });
      expect(decodeBody(followed)).toBe("arrived");
      expect(fixture.observations.map((entry) => entry.url)).toEqual([
        "/allowed/hop",
        "/allowed/final",
      ]);
      // Each hop resolved the name again rather than reusing the first answer.
      expect(harness.resolver.resolve).toHaveBeenCalledTimes(2);

      // `secondary.test` is inside the host allowlist, so a refusal here can
      // only come from the cross-host redirect rule itself.
      await expect(
        harness.request({ url: `http://primary.test:${fixture.port}/allowed/cross` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_CROSS_HOST_REDIRECT_DENIED", host: "secondary.test" },
      });
      expect(fixture.observations.map((entry) => entry.url)).toEqual([
        "/allowed/hop",
        "/allowed/final",
        "/allowed/cross",
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("revalidates a redirect target against the whole destination policy", async () => {
    const fixture = await startServer((request, response) => {
      if (request.url === "/allowed/escape") {
        response.writeHead(302, { location: "/forbidden/secret" }).end();
        return;
      }
      if (request.url === "/allowed/traverse") {
        response.writeHead(302, { location: "/allowed/../forbidden/secret" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" }).end("leaked");
    });
    try {
      const harness = createHarness({ port: fixture.port });
      await expect(
        harness.request({ url: `http://primary.test:${fixture.port}/allowed/escape` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_PATH_DENIED", path: "/forbidden/secret" },
      });
      await expect(
        harness.request({ url: `http://primary.test:${fixture.port}/allowed/traverse` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_PATH_DENIED", path: "/forbidden/secret" },
      });
      expect(fixture.observations.map((entry) => entry.url)).toEqual([
        "/allowed/escape",
        "/allowed/traverse",
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a redirect whose re-resolved address moved out of the granted scope", async () => {
    const fixture = await startServer((request, response) => {
      if (request.url === "/allowed/hop") {
        response.writeHead(307, { location: "/allowed/final" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" }).end("must not be reached");
    });
    try {
      const resolve = vi
        .fn()
        .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 as const }])
        .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 as const }]);
      const harness = createHarness({ port: fixture.port, resolver: { resolve } });

      await expect(
        harness.request({ url: `http://primary.test:${fixture.port}/allowed/hop` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_ADDRESS_DENIED" },
      });
      // Two resolutions prove the redirect was not trusted to keep the first
      // answer; the second answer never became a connection.
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(fixture.observations.map((entry) => entry.url)).toEqual(["/allowed/hop"]);
      expect(harness.audit).toEqual([
        expect.objectContaining({ outcome: "denied", reason: "HTTP_ADDRESS_DENIED" }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("refuses redirects entirely and enforces the redirect limit", async () => {
    const fixture = await startServer((request, response) => {
      if (request.url === "/allowed/one") {
        response.writeHead(302, { location: "/allowed/two" }).end();
        return;
      }
      if (request.url === "/allowed/two") {
        response.writeHead(302, { location: "/allowed/three" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" }).end("end of chain");
    });
    try {
      const denying = createHarness({
        port: fixture.port,
        overrides: { redirects: { mode: "deny", maxRedirects: 0 } },
      });
      await expect(
        denying.request({ url: `http://primary.test:${fixture.port}/allowed/one` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_REDIRECT_DENIED", status: 302 },
      });
      expect(fixture.observations.map((entry) => entry.url)).toEqual(["/allowed/one"]);

      const limited = createHarness({
        port: fixture.port,
        overrides: { redirects: { mode: "same-host", maxRedirects: 1 } },
      });
      await expect(
        limited.request({ url: `http://primary.test:${fixture.port}/allowed/one` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_REDIRECT_LIMIT", maxRedirects: 1 },
      });
      expect(fixture.observations.map((entry) => entry.url)).toEqual([
        "/allowed/one",
        "/allowed/one",
        "/allowed/two",
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("enforces the response byte limit on the declared length and on the stream", async () => {
    const fixture = await startServer((request, response) => {
      if (request.url === "/allowed/declared") {
        // Headers only: an implementation that buffered first would hang here
        // until the total timeout instead of refusing on the declared length.
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": "10000000",
        });
        response.flushHeaders();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("x".repeat(3_000));
      response.write("y".repeat(3_000));
      response.end();
    });
    try {
      const harness = createHarness({ port: fixture.port });
      await expect(
        harness.request({ url: `http://primary.test:${fixture.port}/allowed/declared` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_QUOTA_EXCEEDED",
        details: { reason: "HTTP_RESPONSE_LIMIT", maxResponseBytes: 4_096 },
      });
      await expect(
        harness.request({ url: `http://primary.test:${fixture.port}/allowed/chunked` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_QUOTA_EXCEEDED",
        details: { reason: "HTTP_RESPONSE_LIMIT", maxResponseBytes: 4_096 },
      });
    } finally {
      await fixture.close();
    }
  });

  it("refuses an oversized request body before it reaches the destination", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end("accepted");
    });
    try {
      const harness = createHarness({ port: fixture.port });
      await expect(
        harness.request({
          url: `http://primary.test:${fixture.port}/allowed/upload`,
          method: "POST",
          body: "z".repeat(2_048),
        }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_QUOTA_EXCEEDED",
        details: { reason: "HTTP_REQUEST_LIMIT", maxRequestBytes: 1_024 },
      });
      expect(fixture.observations).toHaveLength(0);

      const accepted = await harness.request({
        url: `http://primary.test:${fixture.port}/allowed/upload`,
        method: "POST",
        body: "z".repeat(512),
      });
      expect(accepted).toMatchObject({ status: 200 });
      expect(fixture.observations).toHaveLength(1);
      expect(fixture.observations[0]!.body).toHaveLength(512);
    } finally {
      await fixture.close();
    }
  });

  it("denies every destination, method, and header outside the grant", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end("must not be reached");
    });
    try {
      const harness = createHarness({ port: fixture.port });
      const base = `http://primary.test:${fixture.port}`;

      await expect(
        harness.request({ url: `https://primary.test:${fixture.port}/allowed/x` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_SCHEME_DENIED", scheme: "https:" },
      });
      // An extension-named endpoint is a request, never an authority.
      await expect(
        harness.request({ url: `http://attacker.test:${fixture.port}/allowed/x` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_HOST_DENIED", host: "attacker.test" },
      });
      await expect(harness.request({ url: `http://primary.test:9/allowed/x` })).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_PORT_DENIED", port: 9 },
      });
      await expect(harness.request({ url: `${base}/forbidden/x` })).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_PATH_DENIED", path: "/forbidden/x" },
      });
      await expect(harness.request({ url: `${base}/allowedish/x` })).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_PATH_DENIED" },
      });
      await expect(harness.request({ url: `${base}/allowed/x?q=1` })).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_PATH_DENIED" },
      });
      await expect(
        harness.request({ url: `${base}/allowed/x`, method: "DELETE" }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_METHOD_DENIED", method: "DELETE" },
      });
      await expect(
        harness.request({
          url: `${base}/allowed/x`,
          headers: { authorization: "Bearer stolen" },
        }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_HEADER_DENIED", header: "authorization" },
      });
      await expect(
        harness.request({ url: `${base}/allowed/x`, headers: { "x-not-granted": "1" } }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_HEADER_DENIED", header: "x-not-granted" },
      });
      await expect(
        harness.request({ url: `http://user:pass@primary.test:${fixture.port}/allowed/x` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_ARGUMENT_INVALID",
        details: { reason: "HTTP_URL_INVALID" },
      });
      await expect(
        harness.request({ url: `${base}/allowed/x`, proxy: "http://127.0.0.1:1" }),
      ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
      await expect(
        harness.request({ url: `${base}/allowed/x`, method: "GET", body: "payload" }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_BODY_NOT_ALLOWED" },
      });

      expect(fixture.observations).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("attaches the bound credential host-side and never hands it back", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        // Not in the response allowlist, so it must never reach the extension.
        "x-echo-auth": `Bearer ${SECRET}`,
        "set-cookie": `session=${SECRET}`,
      });
      response.end(JSON.stringify({ ok: true }));
    });
    try {
      const secrets = secretResolver();
      const harness = createHarness({
        port: fixture.port,
        overrides: {
          credential: {
            kind: "bearer-secret",
            secretRef: "outbound.fixture.token",
            secretRevision: "rev-1",
          },
          secrets,
        },
      });
      const result = await harness.request({
        url: `http://primary.test:${fixture.port}/allowed/thing`,
        headers: { "x-trace": "trace-1" },
      });

      expect(fixture.observations[0]!.authorization).toBe(`Bearer ${SECRET}`);
      expect(fixture.observations[0]!.headers["x-trace"]).toBe("trace-1");
      expect(secrets.resolve).toHaveBeenCalledWith("outbound.fixture.token", "rev-1");
      expect(Object.keys(result as Record<string, JsonValue>)).not.toContain("credential");
      // Only allowlisted response headers survive, so the echoing header and
      // the cookie the server tried to set never reach the extension.
      const returnedHeaders = (result as { headers: Record<string, string> }).headers;
      expect(Object.keys(returnedHeaders).sort()).toEqual(["content-type", "date"]);
      expect(returnedHeaders["content-type"]).toBe("application/json");
      // Neither the result nor the audit trail may carry the secret anywhere.
      expect(canonicalizeJson(result)).not.toContain(SECRET);
      expect(canonicalizeJson(harness.audit as unknown as JsonValue)).not.toContain(SECRET);
      expect(canonicalizeJson(harness.audit as unknown as JsonValue)).not.toContain("Bearer");
      expect(harness.audit[0]).toMatchObject({ authentication: "host-attached" });

      const description = await harness.session.invoke({
        handle: harness.handle,
        operation: "describe",
        arguments: {},
        moduleJobId: EXECUTION_SCOPE.moduleJobId,
        runId: EXECUTION_SCOPE.runId,
      });
      expect(description).toMatchObject({ authenticated: true });
      expect(canonicalizeJson(description)).not.toContain(SECRET);
      expect(canonicalizeJson(description)).not.toContain("outbound.fixture.token");
    } finally {
      await fixture.close();
    }
  });

  it("refuses a response that reflects the host-attached credential", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ youSentMe: `Bearer ${SECRET}` }));
    });
    try {
      const harness = createHarness({
        port: fixture.port,
        overrides: {
          credential: {
            kind: "bearer-secret",
            secretRef: "outbound.fixture.token",
            secretRevision: "rev-1",
          },
          secrets: secretResolver(),
        },
      });
      await expect(
        harness.request({ url: `http://primary.test:${fixture.port}/allowed/echo` }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "HTTP_CREDENTIAL_ECHOED" },
      });
      expect(canonicalizeJson(harness.audit as unknown as JsonValue)).not.toContain(SECRET);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a connection that did not use the validated address", async () => {
    const transport: OutboundHttpTransport = {
      request: vi.fn(async () => ({
        status: 200,
        headers: { "content-type": "text/plain" },
        connectedAddress: "10.1.2.3",
        body: (async function* () {
          yield Uint8Array.from([1, 2, 3]);
        })(),
        abort: () => undefined,
      })),
    };
    const harness = createHarness({ port: 8080, transport });
    await expect(
      harness.request({ url: "http://primary.test:8080/allowed/thing" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "HTTP_ADDRESS_MISMATCH" },
    });
  });

  it("rejects cross-session handles, revoked handles, and an exhausted invocation budget", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
    try {
      const harness = createHarness({
        port: fixture.port,
        overrides: { limits: { maxInvocations: 1, maxResponseBytes: 4_096 } },
      });
      const other = harness.authority.openSession({ ...IDENTITY, sessionId: "session-b" });
      await expect(
        other.invoke({
          handle: harness.handle,
          operation: "request",
          arguments: { url: `http://primary.test:${fixture.port}/allowed/thing` },
          moduleJobId: EXECUTION_SCOPE.moduleJobId,
          runId: EXECUTION_SCOPE.runId,
        }),
      ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });

      await expect(
        harness.request({ url: `http://primary.test:${fixture.port}/allowed/thing` }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        harness.request({ url: `http://primary.test:${fixture.port}/allowed/thing` }),
      ).rejects.toMatchObject({ code: "CAPABILITY_QUOTA_EXCEEDED" });

      const fresh = createHarness({ port: fixture.port });
      expect(fresh.session.revoke(fresh.handle)).toBe("revoked");
      await expect(
        fresh.request({ url: `http://primary.test:${fixture.port}/allowed/thing` }),
      ).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" });

      // Exactly one request reached the destination across all three cases.
      expect(fixture.observations).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a grant that would let an extension control host authority headers", () => {
    const base: OutboundHttpCapabilityOptions = {
      destination: {
        networkScope: "public",
        allowedHosts: ["api.example.test"],
        allowedPathPrefixes: ["/v1"],
      },
      redirects: { mode: "deny", maxRedirects: 0 },
      credential: { kind: "none" },
      transport: { request: vi.fn() } as unknown as OutboundHttpTransport,
      resolver: loopbackResolver(),
      executionScope: EXECUTION_SCOPE,
      expiresAt: EXPIRES_AT,
    };
    for (const header of ["authorization", "cookie", "host", "x-forwarded-for"]) {
      expect(() =>
        createOutboundHttpCapability({ ...base, requestHeaderAllowlist: [header] }),
      ).toThrowError(expect.objectContaining({ code: "CAPABILITY_CONFIG_INVALID" }));
    }
    expect(() =>
      createOutboundHttpCapability({
        ...base,
        credential: { kind: "bearer-secret", secretRef: "a.token", secretRevision: "rev-1" },
      }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_CONFIG_INVALID" }));
    expect(() =>
      createOutboundHttpCapability({
        ...base,
        destination: { ...base.destination, allowedHosts: [] },
      }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_CONFIG_INVALID" }));
    // A public grant defaults to the HTTPS port and rejects a plaintext URL.
    const definition = createOutboundHttpCapability(base);
    expect(definition.grant.resourceScope).toMatchObject({
      scheme: "https:",
      allowedPorts: [443],
      authentication: { kind: "none" },
    });
  });
});
