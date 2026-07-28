import { describe, expect, it } from "vitest";
import {
  ConsoleExtensionError,
  ConsoleHttpChannel,
  assertLoopbackBinding,
  startLoopbackGateway,
} from "../../../src/extensions/console/index.js";
import {
  createGatewayHarness,
  createStoreHarness,
  enqueueBody,
  openWebSocket,
  pairBrowserSession,
  postMessage,
  rawRequest,
  rejectedWebSocket,
} from "./fixtures.js";

/**
 * Transport-boundary conformance for the Console channel.
 *
 * Every case here drives a real loopback HTTP or WebSocket handshake against
 * the host gateway the extension binds to, because a status field or a URL
 * string is not evidence that a boundary is enforced.
 */
describe("Console transport boundary", () => {
  it("binds an explicit loopback address and refuses unspecified ones", async () => {
    for (const host of ["0.0.0.0", "::", "", "localhost", "192.168.1.5"]) {
      let caught: unknown;
      try {
        assertLoopbackBinding(host);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConsoleExtensionError);
      expect((caught as ConsoleExtensionError).code).toBe("BINDING_NOT_LOOPBACK");
    }
    expect(assertLoopbackBinding("127.0.0.1")).toBe("127.0.0.1");
    expect(assertLoopbackBinding("::1")).toBe("::1");

    const { gateway } = createGatewayHarness();
    const address = await startLoopbackGateway(gateway);
    try {
      expect(address.host).toBe("127.0.0.1");
      expect(address.origin).toBe(`http://127.0.0.1:${address.port}`);
    } finally {
      await gateway.stop();
    }
  });

  it("stops on a bind failure instead of retrying on a wider interface", async () => {
    const first = createGatewayHarness();
    const address = await startLoopbackGateway(first.gateway);
    const second = createGatewayHarness({}, address.port);
    try {
      let caught: unknown;
      try {
        await startLoopbackGateway(second.gateway);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
      // Nothing was bound anywhere: no fallback host, no second attempt.
      expect(second.gateway.address).toBeNull();
    } finally {
      await second.gateway.stop();
      await first.gateway.stop();
    }
  });

  it("requires authentication, exact Origin, and CSRF on the message path", async () => {
    const { gateway } = createGatewayHarness();
    const address = await startLoopbackGateway(gateway);
    try {
      const unauthenticated = await fetch(`${address.origin}/v1/messages`);
      expect(unauthenticated.status).toBe(401);

      const pairing = gateway.issuePairingCode({
        principalId: "principal-a",
        routeAliases: ["private"],
      });
      const hostilePair = await fetch(`${address.origin}/v1/session/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.example" },
        body: JSON.stringify({ code: pairing.code }),
      });
      expect(hostilePair.status).toBe(403);

      const session = await pairBrowserSession(gateway, address.origin, "principal-a", [
        "private",
      ]);
      const body = enqueueBody({
        operationId: "operation-1",
        clientMessageId: "client-1",
        routeAlias: "private",
        text: "hello",
      });

      const noCsrf = await fetch(`${address.origin}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: address.origin,
          cookie: session.cookie,
        },
        body: JSON.stringify(body),
      });
      expect(noCsrf.status).toBe(403);

      const crossOrigin = await fetch(`${address.origin}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
          cookie: session.cookie,
          "x-dolly-csrf": session.csrfToken,
        },
        body: JSON.stringify(body),
      });
      expect(crossOrigin.status).toBe(403);

      const accepted = await postMessage(address, session, body);
      expect(accepted.status).toBe(202);
    } finally {
      await gateway.stop();
    }
  });

  it("applies the request byte limit before the body is parsed", async () => {
    const { gateway } = createGatewayHarness({ maxJsonBytes: 4096 });
    const address = await startLoopbackGateway(gateway);
    try {
      const session = await pairBrowserSession(gateway, address.origin, "principal-a", [
        "private",
      ]);
      const headers = {
        "content-type": "application/json",
        origin: address.origin,
        cookie: session.cookie,
        "x-dolly-csrf": session.csrfToken,
      };

      // A small malformed body reaches the parser and reports INVALID_JSON.
      const malformed = await rawRequest({
        port: address.port,
        path: "/v1/messages",
        method: "POST",
        headers: { ...headers, "content-length": "3" },
        body: "{{{",
      });
      expect(malformed.status).toBe(400);
      expect(JSON.parse(malformed.body)).toEqual({ error: { code: "INVALID_JSON" } });

      // The same malformed shape, above the limit, is refused by size. A
      // different error code is the proof that it never reached JSON.parse.
      const oversized = "{".repeat(5000);
      const rejected = await rawRequest({
        port: address.port,
        path: "/v1/messages",
        method: "POST",
        headers: { ...headers, "content-length": String(oversized.length) },
        body: oversized,
      });
      expect(rejected.status).toBe(413);
      expect(JSON.parse(rejected.body)).toEqual({ error: { code: "BODY_LIMIT" } });
    } finally {
      await gateway.stop();
    }
  });

  it("authenticates and Origin-checks the WebSocket upgrade before the handshake completes", async () => {
    const { gateway } = createGatewayHarness({ maxWebSocketMessageBytes: 512 });
    const address = await startLoopbackGateway(gateway);
    const wsOrigin = address.origin.replace(/^http:/, "ws:");
    try {
      const session = await pairBrowserSession(gateway, address.origin, "principal-a", [
        "private",
      ]);

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
        rejectedWebSocket(`${wsOrigin}/v1/events`, { origin: "null", cookie: session.cookie }),
      ).resolves.toBe(403);
      // A credential in the URL is not an authentication path at all.
      await expect(
        rejectedWebSocket(`${wsOrigin}/v1/events?token=${session.cookie}`, {
          origin: address.origin,
          cookie: session.cookie,
        }),
      ).resolves.toBe(404);

      const open = await openWebSocket(address.origin, session.cookie);
      expect(open.ready).toMatchObject({ type: "session.ready", sessionId: session.sessionId });
      const closed = new Promise<number>((resolve) => {
        open.socket.once("close", (code) => resolve(code));
      });
      open.socket.send("x".repeat(1024));
      await expect(closed).resolves.toBe(1009);
    } finally {
      await gateway.stop();
    }
  });

  it("turns an authenticated queue entry into a Console envelope over the real transport", async () => {
    const { gateway } = createGatewayHarness();
    const address = await startLoopbackGateway(gateway);
    const harness = createStoreHarness();
    try {
      const session = await pairBrowserSession(gateway, address.origin, "principal-a", [
        "private",
      ]);
      harness.store.registerRoute({
        alias: "private",
        revision: "r1",
        visibility: "private",
        allowedPrincipals: ["principal-a"],
        consumerStart: { kind: "from-now" },
      });
      harness.store.openSession({
        sessionId: session.sessionId,
        principalId: "principal-a",
        routeAlias: "private",
        routeRevision: "r1",
        displayStart: { kind: "from-now" },
      });

      const response = await postMessage(
        address,
        session,
        enqueueBody({
          operationId: "operation-1",
          clientMessageId: "client-1",
          routeAlias: "private",
          text: "over the wire",
        }),
      );
      expect(response.status).toBe(202);

      const channel = new ConsoleHttpChannel({ gateway, store: harness.store });
      const ingested = channel.ingest({
        sessionId: session.sessionId,
        principalId: "principal-a",
      });
      expect(ingested).toHaveLength(1);
      expect(ingested[0]!.message).toMatchObject({
        schemaVersion: "dolly.console.external-message/1",
        channelKind: "console",
        routeAlias: "private",
        text: "over the wire",
        attachments: [],
      });
      // In-memory Console state never claims restart safety.
      expect(ingested[0]!.receipt.disposition).toBe("queued-volatile");

      // Draining again is idempotent rather than a second acceptance.
      expect(channel.ingest({ sessionId: session.sessionId, principalId: "principal-a" })).toEqual(
        [],
      );
      expect(
        harness.store.pendingMessages(session.sessionId, "principal-a"),
      ).toHaveLength(1);
    } finally {
      await gateway.stop();
    }
  });
});
