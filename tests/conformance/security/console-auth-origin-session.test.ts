import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ConsoleGateway } from "../../../src/core/console-gateway.js";

const NOW = "2026-07-24T00:00:00.000Z";
const WS_PROTOCOL = "dolly.console.v1";

interface BrowserSession {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly sessionId: string;
}

function createHarness(overrides: ConstructorParameters<typeof ConsoleGateway>[0]["limits"] = {}) {
  let id = 0;
  let secret = 0;
  let now = NOW;
  const gateway = new ConsoleGateway({
    host: "127.0.0.1",
    port: 0,
    now: () => now,
    nextId: (kind) => `${kind}-${++id}`,
    nextSecret: (kind) =>
      createHash("sha256")
        .update(`${kind}:${++secret}`)
        .digest("base64url"),
    limits: {
      maxJsonBytes: 2048,
      maxTextBytes: 256,
      maxQueuedMessagesPerSession: 4,
      maxWebSocketMessageBytes: 64,
      maxWebSocketsPerSession: 1,
      maxWebSocketBufferedBytes: 1024,
      maxPairingAttemptsPerWindow: 5,
      pairingAttemptWindowMs: 60_000,
      pairingCodeLifetimeMs: 1000,
      sessionIdleMs: 1000,
      headerTimeoutMs: 1000,
      requestTimeoutMs: 2000,
      ...overrides,
    },
  });
  return {
    gateway,
    setNow(value: string) {
      now = value;
    },
  };
}

async function pair(
  gateway: ConsoleGateway,
  origin: string,
  principalId: string,
): Promise<BrowserSession & { code: string }> {
  const pairing = gateway.issuePairingCode({
    principalId,
    routeAliases: ["private"],
  });
  const response = await fetch(`${origin}/v1/session/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code: pairing.code }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { sessionId: string; csrfToken: string };
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).not.toBeNull();
  return {
    code: pairing.code,
    cookie: setCookie!.split(";", 1)[0]!,
    csrfToken: body.csrfToken,
    sessionId: body.sessionId,
  };
}

async function rawRequest(input: {
  readonly port: number;
  readonly path: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}): Promise<{ status: number; headers: NodeJS.Dict<string | string[]>; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: input.method ?? "GET",
        headers: input.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

async function rejectedWebSocket(
  url: string,
  options: { readonly origin: string; readonly cookie?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, WS_PROTOCOL, {
      headers: {
        origin: options.origin,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      },
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.on("open", () => {
      socket.terminate();
      reject(new Error("WebSocket unexpectedly opened"));
    });
    socket.on("error", () => {
      // Expected after a rejected HTTP upgrade; status arrives above.
    });
  });
}

async function openWebSocket(
  origin: string,
  cookie: string,
): Promise<{ socket: WebSocket; ready: Record<string, unknown> }> {
  const url = origin.replace(/^http:/, "ws:") + "/v1/events";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, WS_PROTOCOL, {
      headers: { origin, cookie },
    });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket ready timeout"));
    }, 2000);
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolve({ socket, ready: JSON.parse(data.toString()) as Record<string, unknown> });
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function enqueueBody(text: string) {
  return {
    version: "1",
    type: "message.enqueue",
    operationId: "operation-1",
    clientMessageId: "client-message-1",
    routeAlias: "private",
    text,
  };
}

describe("SEC-002 Console HTTP/WebSocket boundary", () => {
  it("binds loopback and exchanges one pairing code for a hardened cookie", async () => {
    const { gateway } = createHarness();
    const address = await gateway.start();
    try {
      expect(address.host).toBe("127.0.0.1");
      const hostileHost = await rawRequest({
        port: address.port,
        path: "/v1/health",
        headers: { host: "attacker.example" },
      });
      expect(hostileHost.status).toBe(400);

      const unauthorized = await fetch(`${address.origin}/v1/session`);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("access-control-allow-origin")).toBeNull();

      const pairing = gateway.issuePairingCode({
        principalId: "principal-a",
        routeAliases: ["private"],
      });
      const crossOrigin = await fetch(`${address.origin}/v1/session/pair`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body: JSON.stringify({ code: pairing.code }),
      });
      expect(crossOrigin.status).toBe(403);

      const paired = await fetch(`${address.origin}/v1/session/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: address.origin },
        body: JSON.stringify({ code: pairing.code }),
      });
      expect(paired.status).toBe(201);
      const setCookie = paired.headers.get("set-cookie")!;
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).not.toContain("Domain=");
      expect(paired.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

      const reused = await fetch(`${address.origin}/v1/session/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: address.origin },
        body: JSON.stringify({ code: pairing.code }),
      });
      expect(reused.status).toBe(401);
    } finally {
      await gateway.stop();
    }
  });

  it("requires exact Origin, CSRF, route authority, and stable idempotency", async () => {
    const { gateway } = createHarness();
    const address = await gateway.start();
    try {
      const session = await pair(gateway, address.origin, "principal-a");
      const headers = {
        "content-type": "application/json",
        cookie: session.cookie,
      };
      const noCsrf = await fetch(`${address.origin}/v1/messages`, {
        method: "POST",
        headers: { ...headers, origin: address.origin },
        body: JSON.stringify(enqueueBody("hello")),
      });
      expect(noCsrf.status).toBe(403);

      const wrongOrigin = await fetch(`${address.origin}/v1/messages`, {
        method: "POST",
        headers: {
          ...headers,
          origin: "https://attacker.example",
          "x-dolly-csrf": session.csrfToken,
        },
        body: JSON.stringify(enqueueBody("hello")),
      });
      expect(wrongOrigin.status).toBe(403);

      const wrongRoute = await fetch(`${address.origin}/v1/messages`, {
        method: "POST",
        headers: {
          ...headers,
          origin: address.origin,
          "x-dolly-csrf": session.csrfToken,
        },
        body: JSON.stringify({ ...enqueueBody("hello"), routeAlias: "other" }),
      });
      expect(wrongRoute.status).toBe(403);

      const request = async (body: object) =>
        fetch(`${address.origin}/v1/messages`, {
          method: "POST",
          headers: {
            ...headers,
            origin: address.origin,
            "x-dolly-csrf": session.csrfToken,
          },
          body: JSON.stringify(body),
        });
      const first = await request(enqueueBody("hello"));
      const repeated = await request(enqueueBody("hello"));
      expect(first.status).toBe(202);
      expect(repeated.status).toBe(202);
      expect(await repeated.json()).toEqual(await first.json());

      const conflict = await request(enqueueBody("different"));
      expect(conflict.status).toBe(409);
      expect(gateway.listQueuedMessages(session.sessionId)).toHaveLength(1);
    } finally {
      await gateway.stop();
    }
  });

  it("authenticates WebSocket upgrades without URL credentials and enforces limits", async () => {
    const { gateway } = createHarness();
    const address = await gateway.start();
    try {
      const session = await pair(gateway, address.origin, "principal-a");
      const wsOrigin = address.origin.replace(/^http:/, "ws:");
      await expect(
        rejectedWebSocket(`${wsOrigin}/v1/events`, { origin: address.origin }),
      ).resolves.toBe(401);
      await expect(
        rejectedWebSocket(`${wsOrigin}/v1/events`, {
          origin: "https://attacker.example",
          cookie: session.cookie,
        }),
      ).resolves.toBe(403);
      await expect(
        rejectedWebSocket(`${wsOrigin}/v1/events?auth=secret`, {
          origin: address.origin,
          cookie: session.cookie,
        }),
      ).resolves.toBe(404);

      const first = await openWebSocket(address.origin, session.cookie);
      expect(first.ready).toMatchObject({
        version: "1",
        type: "session.ready",
        sessionId: session.sessionId,
      });
      await expect(
        rejectedWebSocket(`${wsOrigin}/v1/events`, {
          origin: address.origin,
          cookie: session.cookie,
        }),
      ).resolves.toBe(429);

      const closeCode = new Promise<number>((resolve) => {
        first.socket.once("close", (code) => resolve(code));
      });
      first.socket.send("x".repeat(128));
      await expect(closeCode).resolves.toBe(1009);
    } finally {
      await gateway.stop();
    }
  });

  it("keeps queues and event delivery isolated between sessions", async () => {
    const { gateway } = createHarness({ maxWebSocketsPerSession: 2 });
    const address = await gateway.start();
    try {
      const first = await pair(gateway, address.origin, "principal-a");
      const second = await pair(gateway, address.origin, "principal-b");
      const queued = await fetch(`${address.origin}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: address.origin,
          cookie: first.cookie,
          "x-dolly-csrf": first.csrfToken,
        },
        body: JSON.stringify(enqueueBody("private to first")),
      });
      expect(queued.status).toBe(202);

      const secondMessages = await fetch(`${address.origin}/v1/messages`, {
        headers: { cookie: second.cookie },
      });
      expect(await secondMessages.json()).toMatchObject({ messages: [] });
      expect(gateway.listQueuedMessages(first.sessionId)).toHaveLength(1);
      expect(gateway.listQueuedMessages(second.sessionId)).toHaveLength(0);

      const firstSocket = await openWebSocket(address.origin, first.cookie);
      const secondSocket = await openWebSocket(address.origin, second.cookie);
      let secondReceivedDisplay = false;
      secondSocket.socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === "display.event") secondReceivedDisplay = true;
      });
      const display = new Promise<Record<string, unknown>>((resolve) => {
        firstSocket.socket.once("message", (data) => resolve(JSON.parse(data.toString())));
      });
      gateway.publishToSession(first.sessionId, { text: "only first" });
      await expect(display).resolves.toMatchObject({
        type: "display.event",
        payload: { text: "only first" },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(secondReceivedDisplay).toBe(false);
      firstSocket.socket.close();
      secondSocket.socket.close();
    } finally {
      await gateway.stop();
    }
  });

  it("rate-limits pairing attempts and expires idle sessions", async () => {
    const harness = createHarness({ maxPairingAttemptsPerWindow: 2 });
    const address = await harness.gateway.start();
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${address.origin}/v1/session/pair`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: address.origin },
          body: JSON.stringify({ code: `invalid-${attempt}` }),
        });
        expect(response.status).toBe(401);
      }
      const limited = await fetch(`${address.origin}/v1/session/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: address.origin },
        body: JSON.stringify({ code: "invalid-third" }),
      });
      expect(limited.status).toBe(429);

      harness.setNow("2026-07-24T00:01:01.000Z");
      const session = await pair(harness.gateway, address.origin, "principal-a");
      harness.setNow("2026-07-24T00:01:02.000Z");
      const expired = await fetch(`${address.origin}/v1/session`, {
        headers: { cookie: session.cookie },
      });
      expect(expired.status).toBe(401);
    } finally {
      await harness.gateway.stop();
    }
  });
});
