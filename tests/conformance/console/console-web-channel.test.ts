import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  ConsoleWebChannel,
  type ConsoleWebChannelOptions,
} from "../../../src/extensions/console/index.js";
import { FIXED_NOW, WS_PROTOCOL, openWebSocket } from "./fixtures.js";

/**
 * Authenticated, session-isolated browser channel conformance.
 *
 * These cases run against the assembled web channel on a real loopback
 * socket, because the security properties under test — authentication before
 * subscribe/publish, per-session display delivery, and bounded deterministic
 * replay — only exist at the transport boundary (`console-extension.md`
 * sections 4.1, 6.2, 6.5, 8.2 and `security-operations.md` section 4).
 */

const ROUTES: ConsoleWebChannelOptions["routes"] = [
  {
    alias: "main",
    revision: "rev-1",
    visibility: "private",
    allowedPrincipals: ["alice", "bob"],
    consumerStart: { kind: "from-now" },
  },
];

interface Harness {
  readonly channel: ConsoleWebChannel;
  readonly origin: string;
  setNow(value: string): void;
}

let harness: Harness | undefined;

async function createHarness(
  limits: ConsoleWebChannelOptions["limits"] = {},
): Promise<Harness> {
  let now = FIXED_NOW;
  let id = 0;
  let secret = 0;
  const channel = new ConsoleWebChannel({
    host: "127.0.0.1",
    port: 0,
    routes: ROUTES,
    now: () => now,
    nextId: (kind) => `${kind}-${(id += 1)}`,
    nextSecret: (kind) =>
      createHash("sha256")
        .update(`${kind}:${(secret += 1)}`)
        .digest("base64url"),
    limits: {
      gateway: {
        maxJsonBytes: 4096,
        maxTextBytes: 256,
        maxQueuedMessagesPerSession: 4,
        sessionIdleMs: 600_000,
        pairingCodeLifetimeMs: 600_000,
        ...(limits.gateway ?? {}),
      },
      session: { maxRetainedDisplayItemsPerSession: 8, ...(limits.session ?? {}) },
    },
  });
  await channel.start();
  const address = channel.address();
  harness = {
    channel,
    origin: address.origin,
    setNow(value: string) {
      now = value;
    },
  };
  return harness;
}

afterEach(async () => {
  await harness?.channel.stop();
  harness = undefined;
});

interface BrowserSession {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly sessionId: string;
  readonly principalId: string;
}

async function pair(h: Harness, principalId: string): Promise<BrowserSession> {
  const pairing = h.channel.issuePairingCode({ principalId, routeAlias: "main" });
  const response = await fetch(`${h.origin}/v1/session/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: h.origin },
    body: JSON.stringify({ code: pairing.code }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status).toBe(201);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Pairing returned no session cookie");
  return {
    cookie: setCookie.split(";", 1)[0]!,
    csrfToken: body.csrfToken as string,
    sessionId: body.sessionId as string,
    principalId: body.principalId as string,
  };
}

function authHeaders(h: Harness, session: BrowserSession): Record<string, string> {
  return {
    origin: h.origin,
    cookie: session.cookie,
    "x-dolly-csrf": session.csrfToken,
  };
}

function enqueue(h: Harness, session: BrowserSession, operationId: string, text: string) {
  return fetch(`${h.origin}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(h, session) },
    body: JSON.stringify({
      version: "1",
      type: "message.enqueue",
      operationId,
      clientMessageId: `client-${operationId}`,
      routeAlias: "main",
      text,
    }),
  });
}

let displayCounter = 0;

function displayItem(text: string) {
  displayCounter += 1;
  return {
    blockId: `block-${displayCounter}`,
    deliveryIds: [`delivery-${displayCounter}`],
    source: { kind: "module" as const, id: "llm-a" },
    createdAt: FIXED_NOW,
    presentation: [{ kind: "text" as const, text, format: "plain" as const }],
  };
}

/** Every event a socket emits until closed. */
function collect(socket: WebSocket): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  socket.on("message", (data) => events.push(JSON.parse(data.toString())));
  return events;
}

/** A portable promise resolver; Node 20 lacks `Promise.withResolvers`. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Awaits the next socket event of one type — a real signal, never a sleep. */
function nextEvent(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  const { promise, resolve } = deferred<Record<string, unknown>>();
  const onMessage = (data: WebSocket.RawData) => {
    const event = JSON.parse(data.toString()) as Record<string, unknown>;
    if (event.type === type) {
      socket.off("message", onMessage);
      resolve(event);
    }
  };
  socket.on("message", onMessage);
  return promise;
}

/** Awaits the close handshake, which the server processes before responding. */
function closed(socket: WebSocket): Promise<void> {
  const { promise, resolve } = deferred<void>();
  socket.once("close", () => resolve());
  socket.close();
  return promise;
}

/** Lets already-enqueued socket frames complete their event-loop turns. */
async function flushEvents(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    const { promise, resolve } = deferred<void>();
    setImmediate(resolve);
    await promise;
  }
}

describe("console web channel: serving the client application", () => {
  it("serves an inert application shell with a restrictive policy and no cache", async () => {
    const h = await createHarness();
    const page = await fetch(`${h.origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await page.text();
    expect(html).toContain('id="messages"');

    const script = await fetch(`${h.origin}/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");

    const styles = await fetch(`${h.origin}/styles.css`);
    expect(styles.status).toBe(200);
    expect(styles.headers.get("content-type")).toContain("text/css");

    // Query strings are never accepted, including on the shell: credentials
    // and cursors must not be carried in URLs (security-operations.md 4.3/4.4).
    expect((await fetch(`${h.origin}/?code=abc`)).status).toBe(400);
    expect((await fetch(`${h.origin}/favicon.ico`)).status).toBe(404);
  });
});

describe("console web channel: authentication boundary", () => {
  it("refuses subscribe, publish, and status access without a session", async () => {
    const h = await createHarness();
    expect((await fetch(`${h.origin}/v1/session`)).status).toBe(401);
    expect((await fetch(`${h.origin}/v1/messages`)).status).toBe(401);
    expect((await fetch(`${h.origin}/v1/display/since/0`)).status).toBe(401);

    const denied = await fetch(`${h.origin}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.origin },
      body: JSON.stringify({ version: "1", type: "message.enqueue" }),
    });
    expect(denied.status).toBe(401);

    const wsDenied = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`${h.origin.replace(/^http:/, "ws:")}/v1/events`, WS_PROTOCOL, {
        headers: { origin: h.origin },
      });
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.on("error", () => {});
    });
    expect(wsDenied).toBe(401);
  });


  it("rejects unallowed principals, unknown routes, and bad pairing codes", async () => {
    const h = await createHarness();
    expect(() =>
      h.channel.issuePairingCode({ principalId: "carol", routeAlias: "main" }),
    ).toThrowError(/denied|authorized/i);
    expect(() =>
      h.channel.issuePairingCode({ principalId: "alice", routeAlias: "unknown" }),
    ).toThrowError(/route/i);

    const pairing = h.channel.issuePairingCode({ principalId: "alice", routeAlias: "main" });
    const wrongCode = await fetch(`${h.origin}/v1/session/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.origin },
      body: JSON.stringify({ code: `${pairing.code}x` }),
    });
    expect(wrongCode.status).toBe(401);
  });

  it("binds one host-owned identity to each authenticated session", async () => {
    const h = await createHarness();
    const alice = await pair(h, "alice");
    expect(alice.sessionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(alice.principalId).toBe("alice");
    expect(h.channel.store.sessionState(alice.sessionId)).toBe("active");

    const status = await fetch(`${h.origin}/v1/session`, {
      headers: { cookie: alice.cookie },
    });
    expect(status.status).toBe(200);
    const body = (await status.json()) as Record<string, unknown>;
    expect(body.sessionId).toBe(alice.sessionId);
    expect(body.principalId).toBe("alice");
    expect(body.csrfToken).toBe(alice.csrfToken);
    expect(body.routeAliases).toEqual(["main"]);

    // Publishing state changes still requires the per-session CSRF token.
    const noCsrf = await fetch(`${h.origin}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.origin, cookie: alice.cookie },
      body: JSON.stringify({
        version: "1",
        type: "message.enqueue",
        operationId: "op-no-csrf",
        clientMessageId: "client-no-csrf",
        routeAlias: "main",
        text: "hello",
      }),
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe("console web channel: session-scoped ingress", () => {
  it("queues authenticated input per session and deduplicates by identity", async () => {
    const h = await createHarness();
    const alice = await pair(h, "alice");
    const bob = await pair(h, "bob");

    const first = await enqueue(h, alice, "op-1", "hello from alice");
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.disposition).toBe("queued-volatile");

    // Same identity is an idempotent replay, never a second queue entry.
    const replay = await enqueue(h, alice, "op-1", "hello from alice");
    expect(replay.status).toBe(202);
    expect(((await replay.json()) as Record<string, unknown>).externalMessageId).toBe(
      firstBody.externalMessageId,
    );

    const conflict = await enqueue(h, alice, "op-1", "changed text");
    expect(conflict.status).toBe(409);

    // Ingress state never crosses sessions: bob's own queue stays empty.
    expect(h.channel.gateway.listQueuedMessages(alice.sessionId)).toHaveLength(1);
    expect(h.channel.gateway.listQueuedMessages(bob.sessionId)).toHaveLength(0);

    const ingested = h.channel.ingestSession(alice.sessionId);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.message.text).toBe("hello from alice");

    const saturated = [
      await enqueue(h, alice, "op-2", "b"),
      await enqueue(h, alice, "op-3", "c"),
      await enqueue(h, alice, "op-4", "d"),
      await enqueue(h, alice, "op-5", "e"),
    ];
    expect(saturated[3]!.status).toBe(429);

    const oversized = await enqueue(h, bob, "op-b1", "x".repeat(1024));
    expect(oversized.status).toBe(400);
  });
});

describe("console web channel: malformed and hostile frames", () => {
  it("rejects client frames on the server-to-client event channel with close 1008", async () => {
    const h = await createHarness();
    const alice = await pair(h, "alice");
    const open = await openWebSocket(h.origin, alice.cookie);
    try {
      const code = new Promise<number>((resolve) => {
        open.socket.once("close", (closeCode) => resolve(closeCode));
      });
      // Small well-formed JSON frame, below the payload limit: still refused,
      // because the event channel is server-to-client only (spec 8.2, 13).
      open.socket.send(JSON.stringify({ version: "1", type: "message.enqueue" }));
      await expect(code).resolves.toBe(1008);
    } finally {
      open.socket.terminate();
    }
  });

  it("refuses malformed and impossible display cursors before replaying", async () => {
    const h = await createHarness();
    const alice = await pair(h, "alice");
    const headers = { cookie: alice.cookie };

    // Empty, non-numeric, and zero-padded cursors never reach the store.
    expect((await fetch(`${h.origin}/v1/display/since/`, { headers })).status).toBe(400);
    expect((await fetch(`${h.origin}/v1/display/since/abc`, { headers })).status).toBe(400);
    expect((await fetch(`${h.origin}/v1/display/since/000`, { headers })).status).toBe(400);
    // A cursor or any other value never rides in the query string.
    expect((await fetch(`${h.origin}/v1/display/since/0?x=1`, { headers })).status).toBe(400);
    // A cursor beyond the newest issued sequence is invalid, not a gap.
    expect((await fetch(`${h.origin}/v1/display/since/9`, { headers })).status).toBe(409);

    // The valid frontier cursor returns the versioned projection only.
    h.channel.appendDisplay(alice.sessionId, [displayItem("kept")]);
    const frontier = await fetch(`${h.origin}/v1/display/since/0`, { headers });
    expect(frontier.status).toBe(200);
    const body = (await frontier.json()) as Record<string, unknown>;
    expect(body.version).toBe("1");
    expect(body.type).toBe("display.resume");
    expect(body.truncated).toBe(false);
    expect(body.items).toHaveLength(1);
  });
});

describe("console web channel: session isolation and replay", () => {
  it("delivers display events only to the session that owns them", async () => {
    const h = await createHarness();
    const alice = await pair(h, "alice");
    const bob = await pair(h, "bob");
    const aliceSocket = await openWebSocket(h.origin, alice.cookie);
    const bobSocket = await openWebSocket(h.origin, bob.cookie);
    const aliceEvents = collect(aliceSocket.socket);
    const bobEvents = collect(bobSocket.socket);
    try {
      h.channel.appendDisplay(alice.sessionId, [displayItem("for alice")]);
      h.channel.appendDisplay(bob.sessionId, [displayItem("for bob")]);
      // Positive signals: each side must see its own item. A leak would add a
      // second event to one of the collectors during the same pump turn.
      await Promise.all([
        nextEvent(aliceSocket.socket, "display.event"),
        nextEvent(bobSocket.socket, "display.event"),
      ]);
      await flushEvents();

      const aliceDisplay = aliceEvents.filter((e) => e.type === "display.event");
      const bobDisplay = bobEvents.filter((e) => e.type === "display.event");
      expect(aliceDisplay).toHaveLength(1);
      expect(bobDisplay).toHaveLength(1);
      const alicePayload = aliceDisplay[0]!.payload as Record<string, unknown>;
      const bobPayload = bobDisplay[0]!.payload as Record<string, unknown>;
      expect(
        (alicePayload.presentation as Array<Record<string, unknown>>)[0]!.text,
      ).toBe("for alice");
      expect((bobPayload.presentation as Array<Record<string, unknown>>)[0]!.text).toBe(
        "for bob",
      );

      // Replay is self-scoped: each side's resume view holds only its own.
      const aliceResume = await fetch(`${h.origin}/v1/display/since/0`, {
        headers: { cookie: alice.cookie },
      });
      const bobResume = await fetch(`${h.origin}/v1/display/since/0`, {
        headers: { cookie: bob.cookie },
      });
      expect(aliceResume.status).toBe(200);
      const aliceItems = ((await aliceResume.json()) as Record<string, unknown>)
        .items as Array<Record<string, unknown>>;
      expect(aliceItems).toHaveLength(1);
      expect(
        (aliceItems[0]!.presentation as Array<Record<string, unknown>>)[0]!.text,
      ).toBe("for alice");
      const bobItems = ((await bobResume.json()) as Record<string, unknown>)
        .items as Array<Record<string, unknown>>;
      expect(bobItems).toHaveLength(1);
      expect(
        (bobItems[0]!.presentation as Array<Record<string, unknown>>)[0]!.text,
      ).toBe("for bob");
    } finally {
      await Promise.all([closed(aliceSocket.socket), closed(bobSocket.socket)]);
    }
  });

  it("replays a reconnect gap deterministically inside the bounded window", async () => {
    const h = await createHarness();
    const alice = await pair(h, "alice");
    const socket = await openWebSocket(h.origin, alice.cookie);
    const events = collect(socket.socket);
    await closed(socket.socket);

    // Two items land while no socket is connected; they are retained for
    // resume, not pushed to a global transcript.
    h.channel.appendDisplay(alice.sessionId, [displayItem("missed-1"), displayItem("missed-2")]);
    await flushEvents();
    expect(events.filter((e) => e.type === "display.event")).toHaveLength(0);

    const resume = await fetch(`${h.origin}/v1/display/since/0`, {
      headers: { cookie: alice.cookie },
    });
    expect(resume.status).toBe(200);
    const gap = (await resume.json()) as Record<string, unknown>;
    expect(gap.truncated).toBe(false);
    expect(gap.items).toHaveLength(2);
    expect((gap.items as Array<Record<string, unknown>>)[1]!.displaySequence).toBe("2");

    // A cursor at the frontier returns nothing; a future cursor is invalid.
    const frontier = await fetch(`${h.origin}/v1/display/since/2`, {
      headers: { cookie: alice.cookie },
    });
    expect(((await frontier.json()) as Record<string, unknown>).items).toHaveLength(0);
    const future = await fetch(`${h.origin}/v1/display/since/9`, {
      headers: { cookie: alice.cookie },
    });
    expect(future.status).toBe(409);

    // Acknowledging through 1 releases item 1; replaying from 0 then reports
    // the gap honestly instead of recreating acknowledged state (6.5).
    h.channel.ackDisplay(alice.sessionId, { operationId: "ack-1", ackThrough: "1" });
    const afterAck = await fetch(`${h.origin}/v1/display/since/0`, {
      headers: { cookie: alice.cookie },
    });
    const afterAckBody = (await afterAck.json()) as Record<string, unknown>;
    expect(afterAckBody.truncated).toBe(true);
    expect(afterAckBody.items).toHaveLength(1);
    expect((afterAckBody.items as Array<Record<string, unknown>>)[0]!.displaySequence).toBe("2");

    // The reopening handshake never implies replay: a fresh socket only gets
    // `session.ready`; missed content comes from the bounded resume route.
    const reopened = await openWebSocket(h.origin, alice.cookie);
    const reopenedEvents = collect(reopened.socket);
    try {
      await flushEvents();
      expect(reopenedEvents.filter((e) => e.type === "display.event")).toHaveLength(0);
      // The fixture resolves on the server's first message, which is the
      // ready signal the gateway sends on upgrade.
      expect(reopened.ready).toMatchObject({ type: "session.ready" });
    } finally {
      await closed(reopened.socket);
    }
  });

  it("closes a session permanently and never inherits display state on re-pair", async () => {
    const h = await createHarness();
    const alice = await pair(h, "alice");
    h.channel.appendDisplay(alice.sessionId, [displayItem("before close")]);
    const liveSocket = await openWebSocket(h.origin, alice.cookie);
    const serverClose = deferred<number>();
    liveSocket.socket.once("close", (code) => serverClose.resolve(code));

    const closedResponse = await fetch(`${h.origin}/v1/session/close`, {
      method: "POST",
      headers: authHeaders(h, alice),
    });
    expect(closedResponse.status).toBe(200);
    // The live connection learns about the permanent close from the server
    // with the dedicated session-expired close code, not from a message or
    // from the client's own request.
    await expect(serverClose.promise).resolves.toBe(1008);

    const afterClose = await fetch(`${h.origin}/v1/session`, {
      headers: { cookie: alice.cookie },
    });
    expect(afterClose.status).toBe(401);
    expect(h.channel.store.sessionState(alice.sessionId)).toBe("closed");

    const repaired = await pair(h, "alice");
    expect(repaired.sessionId).not.toBe(alice.sessionId);
    const resume = await fetch(`${h.origin}/v1/display/since/0`, {
      headers: { cookie: repaired.cookie },
    });
    const body = (await resume.json()) as Record<string, unknown>;
    expect(body.truncated).toBe(false);
    expect(body.items).toEqual([]);
  });
});
