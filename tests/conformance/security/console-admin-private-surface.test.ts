/**
 * `security-operations.md` Section 14 conformance for the management console's
 * administrative Hypertext Transfer Protocol (HTTP) surface: loopback-only
 * default binding and refusal to widen after a bind failure (item 1),
 * authentication on every private route (item 2), exact origin, host, and
 * cross-site request forgery (CSRF) rejection plus pairing-code expiry,
 * attempt limits, single consumption, and cookie exchange (item 3), absence of
 * credentials from uniform resource locators (URLs) and error bodies (item 4),
 * and request limits enforced before unbounded allocation (item 5).
 *
 * Every assertion runs against a real listener over a real loopback socket.
 */

import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AdminHttpServer } from "../../../src/daemon/console/admin-http-server.js";
import { DaemonConfigError } from "../../../src/daemon/daemon-config.js";
import { DaemonListenError } from "../../../src/daemon/loopback-listener.js";
import {
  createConsoleHarness,
  rawHttpRequest,
  type ConsoleHarness,
} from "../operations/fixtures/console-operations-harness.js";

const servers: AdminHttpServer[] = [];
const harnesses: ConsoleHarness[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const harness of harnesses.splice(0)) harness.dispose();
});

interface Listening {
  readonly server: AdminHttpServer;
  readonly host: string;
  readonly port: number;
  readonly authority: string;
  readonly origin: string;
  readonly harness: ConsoleHarness;
  setNow(value: string): void;
}

async function listen(
  options: {
    readonly host?: "127.0.0.1" | "::1";
    readonly limits?: ConstructorParameters<typeof AdminHttpServer>[0]["limits"];
  } = {},
): Promise<Listening> {
  const harness = createConsoleHarness();
  harnesses.push(harness);
  let now = "2026-07-25T00:00:00.000Z";
  const server = new AdminHttpServer({
    operations: harness.operations,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    now: () => now,
  });
  const address = await server.start();
  servers.push(server);
  return {
    server,
    harness,
    host: address.host,
    port: address.port,
    authority: new URL(server.origin!).host,
    origin: server.origin!,
    setNow(value) {
      now = value;
    },
  };
}

async function pair(
  listening: Listening,
): Promise<{ cookie: string; csrfToken: string; code: string }> {
  const pairing = listening.server.issuePairingCode("operator");
  const response = await rawHttpRequest({
    host: listening.host,
    port: listening.port,
    path: "/v1/admin/session",
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: listening.authority,
      origin: listening.origin,
    },
    body: JSON.stringify({ code: pairing.code }),
  });
  expect(response.status).toBe(201);
  const setCookie = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  return {
    code: pairing.code,
    cookie: cookieHeader.split(";", 1)[0]!,
    csrfToken: (JSON.parse(response.text) as { csrfToken: string }).csrfToken,
  };
}

describe("SEC-CONSOLE-001 private-by-default binding", () => {
  it("binds the IPv4 loopback literal by default and reports it as the only origin", async () => {
    const listening = await listen();
    expect(listening.host).toBe("127.0.0.1");
    expect(listening.origin).toBe(`http://127.0.0.1:${listening.port}`);
    expect(listening.port).toBeGreaterThan(0);
    const health = await rawHttpRequest({
      host: "127.0.0.1",
      port: listening.port,
      path: "/v1/admin/health",
      headers: { host: listening.authority },
    });
    expect(health.status).toBe(200);
    // A liveness result reveals no configuration at all.
    expect(JSON.parse(health.text)).toEqual({ status: "ok" });
  });

  it("binds an explicit IPv6 loopback literal when asked", async () => {
    const listening = await listen({ host: "::1" });
    expect(listening.host).toBe("::1");
    expect(listening.origin).toBe(`http://[::1]:${listening.port}`);
  });

  it("refuses an unspecified listen address before any listener exists", () => {
    const harness = createConsoleHarness();
    harnesses.push(harness);
    for (const host of ["0.0.0.0", "::", "192.168.1.10"]) {
      expect(
        () =>
          new AdminHttpServer({
            operations: harness.operations,
            host: host as "127.0.0.1",
          }),
      ).toThrowError(
        expect.objectContaining({ code: "DAEMON_CONFIG_LISTEN_ADDRESS_FORBIDDEN" }),
      );
    }
    expect(() => new AdminHttpServer({ operations: harness.operations, host: "0.0.0.0" as "127.0.0.1" }))
      .toThrowError(DaemonConfigError);
  });

  it("stops on a bind failure instead of retrying on a wider interface", async () => {
    const first = await listen();
    const harness = createConsoleHarness();
    harnesses.push(harness);
    const second = new AdminHttpServer({
      operations: harness.operations,
      host: "127.0.0.1",
      port: first.port,
    });
    await expect(second.start()).rejects.toThrowError(
      expect.objectContaining({ code: "DAEMON_LISTEN_BIND_FAILED" }),
    );
    await expect(second.start()).rejects.toThrowError(DaemonListenError);
    // Nothing was bound, so no wider address could have been substituted.
    expect(second.address).toBeNull();
    expect(second.origin).toBeNull();
  });
});

describe("SEC-CONSOLE-002 authentication on every private route", () => {
  const privateRoutes: readonly { method: string; path: (id: string) => string }[] = [
    { method: "GET", path: () => "/v1/admin/operations" },
    { method: "GET", path: () => "/v1/admin/instances" },
    { method: "GET", path: (id) => `/v1/admin/instances/${id}` },
    { method: "GET", path: (id) => `/v1/admin/instances/${id}/config` },
    { method: "GET", path: (id) => `/v1/admin/instances/${id}/claims/unknown-outcome` },
    { method: "POST", path: (id) => `/v1/admin/instances/${id}/start` },
    { method: "POST", path: (id) => `/v1/admin/instances/${id}/stop` },
    { method: "POST", path: (id) => `/v1/admin/instances/${id}/topology/plan` },
    { method: "POST", path: (id) => `/v1/admin/instances/${id}/topology/commit` },
    {
      method: "POST",
      path: (id) => `/v1/admin/instances/${id}/claims/unknown-outcome/disposition`,
    },
  ];

  it("refuses every private route without a session and serves them with one", async () => {
    const listening = await listen();
    const instanceId = listening.harness.instanceId;

    for (const route of privateRoutes) {
      const denied = await rawHttpRequest({
        host: listening.host,
        port: listening.port,
        path: route.path(instanceId),
        method: route.method,
        headers: {
          host: listening.authority,
          origin: listening.origin,
          "content-type": "application/json",
        },
        body: route.method === "POST" ? "{}" : undefined,
      });
      expect({ route: route.path(instanceId), status: denied.status }).toEqual({
        route: route.path(instanceId),
        status: 401,
      });
      expect(JSON.parse(denied.text).error.code).toBe("AUTH_REQUIRED");
    }

    const session = await pair(listening);
    const allowed = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: `/v1/admin/instances/${instanceId}/config`,
      headers: { host: listening.authority, cookie: session.cookie },
    });
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.text).instanceId).toBe(instanceId);
  });

  it("keeps every credential out of the URL and out of the error body", async () => {
    const listening = await listen();
    const session = await pair(listening);
    const queryAttempt = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: `/v1/admin/instances?token=${session.csrfToken}`,
      headers: { host: listening.authority, cookie: session.cookie },
    });
    expect(queryAttempt.status).toBe(400);
    expect(JSON.parse(queryAttempt.text).error.code).toBe("QUERY_DENIED");

    const failure = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: "/v1/admin/instances/not-a-uuid",
      headers: { host: listening.authority, cookie: session.cookie },
    });
    expect(failure.status).toBe(400);
    expect(failure.text).not.toContain(session.csrfToken);
    expect(failure.text).not.toContain(session.cookie.split("=")[1]);
    expect(failure.text.toLowerCase()).not.toContain("at object");
    expect(failure.text).not.toContain(listening.harness.configPath);
  });
});

describe("SEC-CONSOLE-003 origin, host, forwarding, and CSRF controls", () => {
  it("refuses a malicious webpage origin on a state-changing route", async () => {
    const listening = await listen();
    const session = await pair(listening);
    const attempt = (origin: string) =>
      rawHttpRequest({
        host: listening.host,
        port: listening.port,
        path: `/v1/admin/instances/${listening.harness.instanceId}/start`,
        method: "POST",
        headers: {
          host: listening.authority,
          origin,
          cookie: session.cookie,
          "x-dolly-csrf": session.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationId: "op-1" }),
      });

    const sameScheme = await attempt("http://attacker.example");
    expect(sameScheme.status).toBe(403);
    expect(JSON.parse(sameScheme.text).error.code).toBe("EXPOSURE_ORIGIN_DENIED");

    // A cross-scheme origin and an opaque `null` origin never reach the origin
    // comparison: both fail to canonicalize against the loopback listener's
    // scheme, which is still a refusal, not an accepted request.
    for (const origin of ["https://attacker.example", "null"]) {
      const refused = await attempt(origin);
      expect({ origin, status: refused.status }).toEqual({ origin, status: 403 });
    }

    // Also refused when the browser omits Origin entirely on a mutating route.
    const missingOrigin = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: `/v1/admin/instances/${listening.harness.instanceId}/start`,
      method: "POST",
      headers: {
        host: listening.authority,
        cookie: session.cookie,
        "x-dolly-csrf": session.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operationId: "op-1" }),
    });
    expect(missingOrigin.status).toBe(403);

    expect(listening.harness.lifecycle.starts).toEqual([]);
  });

  it("refuses a rebinding Host and every forwarding header in local mode", async () => {
    const listening = await listen();
    const session = await pair(listening);

    const rebound = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: "/v1/admin/instances",
      headers: { host: `attacker.example:${listening.port}`, cookie: session.cookie },
    });
    expect(rebound.status).toBe(403);
    expect(JSON.parse(rebound.text).error.code).toBe("EXPOSURE_HOST_DENIED");

    const forwarded = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: "/v1/admin/instances",
      headers: {
        host: listening.authority,
        cookie: session.cookie,
        forwarded: "for=203.0.113.7;proto=https;host=admin.example",
      },
    });
    expect(forwarded.status).toBe(403);
    expect(JSON.parse(forwarded.text).error.code).toBe("EXPOSURE_FORWARDED_DENIED");
  });

  it("refuses a state-changing request whose CSRF token is missing or wrong", async () => {
    const listening = await listen();
    const session = await pair(listening);
    const body = JSON.stringify({ operationId: "op-csrf" });
    const path = `/v1/admin/instances/${listening.harness.instanceId}/start`;

    const missing = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path,
      method: "POST",
      headers: {
        host: listening.authority,
        origin: listening.origin,
        cookie: session.cookie,
        "content-type": "application/json",
      },
      body,
    });
    expect(missing.status).toBe(403);
    expect(JSON.parse(missing.text).error.code).toBe("CSRF_DENIED");

    const wrong = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path,
      method: "POST",
      headers: {
        host: listening.authority,
        origin: listening.origin,
        cookie: session.cookie,
        "x-dolly-csrf": "A".repeat(43),
        "content-type": "application/json",
      },
      body,
    });
    expect(wrong.status).toBe(403);
    expect(JSON.parse(wrong.text).error.code).toBe("CSRF_DENIED");
    expect(listening.harness.lifecycle.starts).toEqual([]);

    const accepted = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path,
      method: "POST",
      headers: {
        host: listening.authority,
        origin: listening.origin,
        cookie: session.cookie,
        "x-dolly-csrf": session.csrfToken,
        "content-type": "application/json",
      },
      body,
    });
    expect(accepted.status).toBe(200);
    expect(listening.harness.lifecycle.starts).toEqual([
      `${listening.harness.instanceId}/op-csrf`,
    ]);
  });

  it("issues an HttpOnly SameSite=Strict cookie and consumes the pairing code once", async () => {
    const listening = await listen();
    const pairing = listening.server.issuePairingCode("operator");
    const first = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: "/v1/admin/session",
      method: "POST",
      headers: {
        host: listening.authority,
        origin: listening.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: pairing.code }),
    });
    expect(first.status).toBe(201);
    const setCookie = String(first.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(first.text).not.toContain(pairing.code);

    const replay = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: "/v1/admin/session",
      method: "POST",
      headers: {
        host: listening.authority,
        origin: listening.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: pairing.code }),
    });
    expect(replay.status).toBe(401);
    expect(JSON.parse(replay.text).error.code).toBe("PAIRING_DENIED");
  });

  it("expires a pairing code and rate limits repeated attempts", async () => {
    const listening = await listen({ limits: { authenticationRequestsPerMinute: 10 } });
    const expiring = listening.server.issuePairingCode("operator");
    listening.setNow("2026-07-25T00:10:00.000Z");
    const expired = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: "/v1/admin/session",
      method: "POST",
      headers: {
        host: listening.authority,
        origin: listening.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: expiring.code }),
    });
    expect(expired.status).toBe(401);
    expect(JSON.parse(expired.text).error.code).toBe("PAIRING_EXPIRED");

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await rawHttpRequest({
        host: listening.host,
        port: listening.port,
        path: "/v1/admin/session",
        method: "POST",
        headers: {
          host: listening.authority,
          origin: listening.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ code: "B".repeat(43) }),
      });
      statuses.push(response.status);
    }
    // The first attempt already consumed one slot through the expiry check.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(-1)[0]).toBe(429);
  });

  it("ships restrictive browser headers on success and on failure", async () => {
    const listening = await listen();
    const session = await pair(listening);
    for (const path of ["/v1/admin/instances", "/v1/admin/nope"]) {
      const response = await rawHttpRequest({
        host: listening.host,
        port: listening.port,
        path,
        headers: { host: listening.authority, cookie: session.cookie },
      });
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("invalidates a session after its idle limit", async () => {
    const listening = await listen();
    const session = await pair(listening);
    const before = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: "/v1/admin/instances",
      headers: { host: listening.authority, cookie: session.cookie },
    });
    expect(before.status).toBe(200);

    listening.setNow("2026-07-25T02:00:00.000Z");
    const after = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: "/v1/admin/instances",
      headers: { host: listening.authority, cookie: session.cookie },
    });
    expect(after.status).toBe(401);
    expect(JSON.parse(after.text).error.code).toBe("SESSION_INVALID");
  });
});

describe("SEC-CONSOLE-004 request limits before parsing", () => {
  it("rejects an oversized declared body before it reaches the parser", async () => {
    const listening = await listen({ limits: { maxSmallJsonBytes: 512 } });
    const session = await pair(listening);
    // Invalid JSON on purpose: a parser that saw this body would answer
    // INVALID_JSON, so BODY_LIMIT proves nothing was parsed.
    const body = `{${"a".repeat(2_000)}`;
    const response = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: `/v1/admin/instances/${listening.harness.instanceId}/start`,
      method: "POST",
      headers: {
        host: listening.authority,
        origin: listening.origin,
        cookie: session.cookie,
        "x-dolly-csrf": session.csrfToken,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body, "utf8")),
      },
      body,
    });
    expect(response.status).toBe(413);
    expect(JSON.parse(response.text).error.code).toBe("BODY_LIMIT");
    expect(listening.harness.lifecycle.starts).toEqual([]);
  });

  it("rejects an oversized chunked body that declares no length", async () => {
    const listening = await listen({ limits: { maxSmallJsonBytes: 512 } });
    const session = await pair(listening);
    const body = `{${"b".repeat(2_000)}`;
    const response = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: `/v1/admin/instances/${listening.harness.instanceId}/start`,
      method: "POST",
      headers: {
        host: listening.authority,
        origin: listening.origin,
        cookie: session.cookie,
        "x-dolly-csrf": session.csrfToken,
        // No Content-Length: node:http then uses chunked transfer encoding, so
        // only the streaming cap can stop this body.
        "content-type": "application/json",
      },
      body,
    });
    expect(response.status).toBe(413);
    expect(JSON.parse(response.text).error.code).toBe("BODY_LIMIT");
  });

  it("accepts a body inside the limit and refuses a wrong media type", async () => {
    const listening = await listen({ limits: { maxSmallJsonBytes: 512 } });
    const session = await pair(listening);
    const accepted = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: `/v1/admin/instances/${listening.harness.instanceId}/stop`,
      method: "POST",
      headers: {
        host: listening.authority,
        origin: listening.origin,
        cookie: session.cookie,
        "x-dolly-csrf": session.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operationId: "op-stop" }),
    });
    expect(accepted.status).toBe(200);

    const wrongType = await rawHttpRequest({
      host: listening.host,
      port: listening.port,
      path: `/v1/admin/instances/${listening.harness.instanceId}/stop`,
      method: "POST",
      headers: {
        host: listening.authority,
        origin: listening.origin,
        cookie: session.cookie,
        "x-dolly-csrf": session.csrfToken,
        "content-type": "text/plain",
      },
      body: "operationId=op",
    });
    expect(wrongType.status).toBe(415);
    expect(JSON.parse(wrongType.text).error.code).toBe("CONTENT_TYPE_REQUIRED");
  });

  it("refuses a configured administrative body limit above the 1 MiB baseline", () => {
    const harness = createConsoleHarness();
    harnesses.push(harness);
    expect(
      () =>
        new AdminHttpServer({
          operations: harness.operations,
          limits: { maxJsonBytes: 4 * 1024 * 1024 },
        }),
    ).toThrowError(/1 MiB administrative JSON baseline/u);
  });

  it("closes a connection whose headers never finish arriving", async () => {
    const listening = await listen({
      limits: { headerTimeoutMs: 300, requestTimeoutMs: 1_000 },
    });
    const startedAt = Date.now();
    const outcome = await new Promise<string>((resolvePromise, rejectPromise) => {
      const socket = connect({ host: listening.host, port: listening.port }, () => {
        // A request line and one header, with no terminating blank line, so the
        // header block never completes.
        socket.write(`GET /v1/admin/health HTTP/1.1\r\nHost: ${listening.authority}\r\n`);
      });
      let received = "";
      const timer = setTimeout(() => {
        socket.destroy();
        rejectPromise(new Error("The listener never abandoned an unfinished header block"));
      }, 5_000);
      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
      });
      socket.on("close", () => {
        clearTimeout(timer);
        resolvePromise(received);
      });
      socket.on("error", () => {
        clearTimeout(timer);
        resolvePromise(received);
      });
    });
    // A listener that held the socket open would be caught by the five-second
    // guard above; this asserts it answered and closed well inside the bound.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(outcome.split("\r\n", 1)[0]).toBe("HTTP/1.1 408 Request Timeout");
    expect(outcome).not.toContain("at Object");
  });
});
