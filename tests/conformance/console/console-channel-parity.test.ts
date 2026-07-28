import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import {
  ConsoleExtensionError,
  ConsoleHttpChannel,
  ConsoleSessionStore,
  buildCliExternalMessage,
  buildIngressProposal,
  externalMessageDigest,
  runConsoleCli,
  startLoopbackGateway,
  type ConsoleAttachmentBinding,
  type ConsoleCredentialSource,
  type ConsoleExternalMessage,
} from "../../../src/extensions/console/index.js";
import {
  createGatewayHarness,
  createStoreHarness,
  enqueueBody,
  pairBrowserSession,
  postMessage,
  type StoreHarness,
} from "./fixtures.js";

const ROUTE = "private";
const REVISION = "r1";

/**
 * A corpus chosen so the two transports have to agree on exact bytes rather
 * than on a normalized shape: identifier-shaped text, Markdown-looking text,
 * astral-plane characters, and embedded newlines all survive verbatim.
 */
const TEXT_CORPUS: readonly string[] = [
  "plain hello",
  "session-1 delivery-2 block-3 moduleJobId=job-9",
  "# heading\n- item <script>alert(1)</script>",
  "多模态 🌊 astral \u{1F600} text",
  "line one\nline two\ttabbed",
];

function credentials(sessionId: string, principalId: string): ConsoleCredentialSource {
  return { read: () => ({ sessionId, principalId }) };
}

function openStoreSession(harness: StoreHarness, sessionId: string, principalId: string): void {
  harness.store.registerRoute({
    alias: ROUTE,
    revision: REVISION,
    visibility: "private",
    allowedPrincipals: [principalId],
    consumerStart: { kind: "from-now" },
  });
  harness.store.openSession({
    sessionId,
    principalId,
    routeAlias: ROUTE,
    routeRevision: REVISION,
    displayStart: { kind: "from-now" },
  });
}

function proposalDigest(
  store: ConsoleSessionStore,
  sessionId: string,
  principalId: string,
): string {
  const snapshot = store.freezeSnapshot({ sessionId, principalId, limitRevision: "limits-1" });
  return canonicalJsonDigest(buildIngressProposal(snapshot));
}

class StaticAttachments implements ConsoleAttachmentBinding {
  constructor(private readonly grants: ReadonlyMap<string, readonly string[]>) {}
  attachmentsFor(input: { readonly clientMessageId: string }): readonly string[] {
    return this.grants.get(input.clientMessageId) ?? [];
  }
}

/**
 * `console-extension.md` section 8.3 requires the browser and CLI clients to
 * produce the same normalized requests, statuses, and idempotency results.
 * These cases prove it by comparing the artefact that actually reaches the
 * Core: the canonical BlockProposal.
 */
describe("Console browser and CLI parity", () => {
  it("produces byte-identical Block proposals from both transports", async () => {
    const { gateway } = createGatewayHarness();
    const address = await startLoopbackGateway(gateway);
    try {
      for (const [index, text] of TEXT_CORPUS.entries()) {
        const httpHarness = createStoreHarness();
        const cliHarness = createStoreHarness();
        const browser = await pairBrowserSession(gateway, address.origin, "principal-http", [
          ROUTE,
        ]);
        openStoreSession(httpHarness, browser.sessionId, "principal-http");
        openStoreSession(cliHarness, "cli-session", "principal-cli");

        const posted = await postMessage(
          address,
          browser,
          enqueueBody({
            operationId: `operation-${index}`,
            clientMessageId: `client-${index}`,
            routeAlias: ROUTE,
            text,
          }),
        );
        expect(posted.status).toBe(202);
        const channel = new ConsoleHttpChannel({ gateway, store: httpHarness.store });
        const ingested = channel.ingest({
          sessionId: browser.sessionId,
          principalId: "principal-http",
        });
        expect(ingested).toHaveLength(1);

        const lines: string[] = [];
        const result = runConsoleCli(
          [
            "send",
            "--route",
            ROUTE,
            "--operation",
            `operation-${index}`,
            "--client-message",
            `client-${index}`,
            "--text",
            text,
          ],
          {
            store: cliHarness.store,
            credentials: credentials("cli-session", "principal-cli"),
            writeLine: (line) => lines.push(line),
          },
        );
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(lines[0]!)).toMatchObject({
          event: "message.accepted",
          disposition: "queued-volatile",
        });

        const cliMessage: ConsoleExternalMessage = buildCliExternalMessage([
          "send",
          "--route",
          ROUTE,
          "--operation",
          `operation-${index}`,
          "--client-message",
          `client-${index}`,
          "--text",
          text,
        ]);
        expect(externalMessageDigest(cliMessage)).toBe(
          externalMessageDigest(ingested[0]!.message),
        );

        const fromHttp = proposalDigest(httpHarness.store, browser.sessionId, "principal-http");
        const fromCli = proposalDigest(cliHarness.store, "cli-session", "principal-cli");
        expect(fromHttp).toBe(fromCli);

        // The proposal is identical across two different sessions, which is
        // only possible because no session, route, or receipt identifier
        // entered Block content.
        const proposal = buildIngressProposal(
          httpHarness.store.freezeSnapshot({
            sessionId: browser.sessionId,
            principalId: "principal-http",
            limitRevision: "limits-1",
          }),
        );
        const canonical = JSON.stringify(proposal);
        expect(canonical).not.toContain(browser.sessionId);
        expect(canonical).not.toContain(ingested[0]!.receipt.externalMessageId);
        // ...while the user's own identifier-shaped text is preserved exactly.
        expect(proposal.payload.value).toMatchObject({
          items: [
            { type: "data", schema: "dolly.console.message-boundary/1", value: {} },
            { type: "text", text, format: "plain" },
          ],
        });
      }
    } finally {
      await gateway.stop();
    }
  });

  it("agrees on multimodal proposals when both transports carry the same grant", async () => {
    const { gateway } = createGatewayHarness();
    const address = await startLoopbackGateway(gateway);
    try {
      const httpHarness = createStoreHarness();
      const cliHarness = createStoreHarness();
      const browser = await pairBrowserSession(gateway, address.origin, "principal-http", [ROUTE]);
      openStoreSession(httpHarness, browser.sessionId, "principal-http");
      openStoreSession(cliHarness, "cli-session", "principal-cli");

      // The same opaque grant name resolves to the same Media in each
      // deployment; the client never names the Media itself.
      httpHarness.grants.issue({
        uploadGrantId: "grant-1",
        sessionId: browser.sessionId,
        mediaId: "media-photo",
      });
      cliHarness.grants.issue({
        uploadGrantId: "grant-1",
        sessionId: "cli-session",
        mediaId: "media-photo",
      });

      const posted = await postMessage(
        address,
        browser,
        enqueueBody({
          operationId: "operation-media",
          clientMessageId: "client-media",
          routeAlias: ROUTE,
          text: "look at this",
        }),
      );
      expect(posted.status).toBe(202);
      const channel = new ConsoleHttpChannel({
        gateway,
        store: httpHarness.store,
        attachments: new StaticAttachments(new Map([["client-media", ["grant-1", "grant-1"]]])),
      });
      const ingested = channel.ingest({
        sessionId: browser.sessionId,
        principalId: "principal-http",
      });
      expect(ingested[0]!.message.attachments).toEqual([
        { uploadGrantId: "grant-1" },
        { uploadGrantId: "grant-1" },
      ]);

      const cliResult = runConsoleCli(
        [
          "send",
          "--route",
          ROUTE,
          "--operation",
          "operation-media",
          "--client-message",
          "client-media",
          "--text",
          "look at this",
          "--attach",
          "grant-1",
          "--attach",
          "grant-1",
        ],
        {
          store: cliHarness.store,
          credentials: credentials("cli-session", "principal-cli"),
          writeLine: () => {},
        },
      );
      expect(cliResult.exitCode).toBe(0);

      expect(proposalDigest(httpHarness.store, browser.sessionId, "principal-http")).toBe(
        proposalDigest(cliHarness.store, "cli-session", "principal-cli"),
      );
      const proposal = buildIngressProposal(
        cliHarness.store.freezeSnapshot({
          sessionId: "cli-session",
          principalId: "principal-cli",
          limitRevision: "limits-1",
        }),
      );
      // Two occurrences of one Media stay two ordered content items, and the
      // opaque grant never appears in the Block.
      expect(proposal.payload.value).toEqual({
        items: [
          { type: "data", schema: "dolly.console.message-boundary/1", value: {} },
          { type: "text", text: "look at this", format: "plain" },
          { type: "media-reference", mediaId: "media-photo" },
          { type: "media-reference", mediaId: "media-photo" },
        ],
      });
      expect(JSON.stringify(proposal)).not.toContain("grant-1");
    } finally {
      await gateway.stop();
    }
  });

  it("shares idempotency and route authority decisions across transports", async () => {
    const { gateway } = createGatewayHarness();
    const address = await startLoopbackGateway(gateway);
    try {
      const httpHarness = createStoreHarness();
      const cliHarness = createStoreHarness();
      const browser = await pairBrowserSession(gateway, address.origin, "principal-http", [ROUTE]);
      openStoreSession(httpHarness, browser.sessionId, "principal-http");
      openStoreSession(cliHarness, "cli-session", "principal-cli");

      const body = enqueueBody({
        operationId: "operation-1",
        clientMessageId: "client-1",
        routeAlias: ROUTE,
        text: "first",
      });
      const first = await postMessage(address, browser, body);
      const repeated = await postMessage(address, browser, body);
      expect(first.status).toBe(202);
      expect(await repeated.json()).toEqual(await first.json());
      const conflict = await postMessage(address, browser, { ...body, text: "changed" });
      expect(conflict.status).toBe(409);

      const send = (text: string) => {
        const lines: string[] = [];
        const result = runConsoleCli(
          [
            "send",
            "--route",
            ROUTE,
            "--operation",
            "operation-1",
            "--client-message",
            "client-1",
            "--text",
            text,
          ],
          {
            store: cliHarness.store,
            credentials: credentials("cli-session", "principal-cli"),
            writeLine: (line) => lines.push(line),
          },
        );
        return { result, events: lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
      };
      const cliFirst = send("first");
      const cliRepeat = send("first");
      expect(cliFirst.result.exitCode).toBe(0);
      expect(cliRepeat.events[0]).toEqual(cliFirst.events[0]);
      const cliConflict = send("changed");
      expect(cliConflict.result.exitCode).toBe(1);
      expect(cliConflict.events[0]).toMatchObject({
        event: "error",
        code: "IDEMPOTENCY_CONFLICT",
      });
      expect(cliHarness.store.pendingMessages("cli-session", "principal-cli")).toHaveLength(1);

      // An unauthorized route is refused on both paths.
      const deniedHttp = await postMessage(address, browser, {
        ...body,
        operationId: "operation-2",
        clientMessageId: "client-2",
        routeAlias: "not-mine",
      });
      expect(deniedHttp.status).toBe(403);
      const deniedCli = runConsoleCli(
        [
          "send",
          "--route",
          "not-mine",
          "--operation",
          "operation-2",
          "--client-message",
          "client-2",
          "--text",
          "first",
        ],
        {
          store: cliHarness.store,
          credentials: credentials("cli-session", "principal-cli"),
          writeLine: (line) => {
            expect(JSON.parse(line)).toMatchObject({ event: "error", code: "ROUTE_DENIED" });
          },
        },
      );
      expect(deniedCli.exitCode).toBe(1);
    } finally {
      await gateway.stop();
    }
  });

  it("refuses credentials on the command line and reports terminal failure", () => {
    const harness = createStoreHarness();
    openStoreSession(harness, "cli-session", "principal-cli");
    for (const flag of ["--token", "--session-token", "--cookie", "--csrf", "--pairing-code"]) {
      const lines: string[] = [];
      const result = runConsoleCli(
        [
          "send",
          "--route",
          ROUTE,
          "--operation",
          "operation-1",
          "--client-message",
          "client-1",
          "--text",
          "hi",
          flag,
          "super-secret-value",
        ],
        {
          store: harness.store,
          credentials: credentials("cli-session", "principal-cli"),
          writeLine: (line) => lines.push(line),
        },
      );
      expect(result.exitCode).toBe(1);
      const event = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(event).toMatchObject({ event: "error", code: "CREDENTIAL_IN_ARGUMENT" });
      // The rejected value is never echoed back.
      expect(lines[0]).not.toContain("super-secret-value");
    }
    // The `--flag=value` form is refused by the same check.
    const inlineLines: string[] = [];
    expect(
      runConsoleCli(["send", "--token=super-secret-value"], {
        store: harness.store,
        credentials: credentials("cli-session", "principal-cli"),
        writeLine: (line) => inlineLines.push(line),
      }).exitCode,
    ).toBe(1);
    expect(JSON.parse(inlineLines[0]!)).toMatchObject({ code: "CREDENTIAL_IN_ARGUMENT" });
    expect(harness.store.pendingMessages("cli-session", "principal-cli")).toHaveLength(0);

    // An unauthenticated CLI cannot fall back to an anonymous session.
    const anonymous: string[] = [];
    expect(
      runConsoleCli(
        ["send", "--route", ROUTE, "--operation", "op", "--client-message", "cm", "--text", "hi"],
        {
          store: harness.store,
          credentials: { read: () => null },
          writeLine: (line) => anonymous.push(line),
        },
      ).exitCode,
    ).toBe(1);
    expect(JSON.parse(anonymous[0]!)).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("supports a media-only message on the CLI while the current HTTP enqueue stays text-only", async () => {
    const { gateway } = createGatewayHarness();
    const address = await startLoopbackGateway(gateway);
    try {
      const harness = createStoreHarness();
      openStoreSession(harness, "cli-session", "principal-cli");
      harness.grants.issue({
        uploadGrantId: "grant-1",
        sessionId: "cli-session",
        mediaId: "media-photo",
      });
      const result = runConsoleCli(
        [
          "send",
          "--route",
          ROUTE,
          "--operation",
          "operation-1",
          "--client-message",
          "client-1",
          "--attach",
          "grant-1",
        ],
        {
          store: harness.store,
          credentials: credentials("cli-session", "principal-cli"),
          writeLine: () => {},
        },
      );
      expect(result.exitCode).toBe(0);
      const proposal = buildIngressProposal(
        harness.store.freezeSnapshot({
          sessionId: "cli-session",
          principalId: "principal-cli",
          limitRevision: "limits-1",
        }),
      );
      // No placeholder text is inserted to make a media-only message textual.
      expect(proposal.payload.value).toEqual({
        items: [
          { type: "data", schema: "dolly.console.message-boundary/1", value: {} },
          { type: "media-reference", mediaId: "media-photo" },
        ],
      });

      // The host gateway's enqueue schema has no attachment field yet, so the
      // browser path rejects it rather than silently dropping it.
      const browser = await pairBrowserSession(gateway, address.origin, "principal-http", [ROUTE]);
      const response = await postMessage(address, browser, {
        ...enqueueBody({
          operationId: "operation-1",
          clientMessageId: "client-1",
          routeAlias: ROUTE,
          text: "with media",
        }),
        attachments: [{ uploadGrantId: "grant-1" }],
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "INVALID_REQUEST" } });
    } finally {
      await gateway.stop();
    }
  });

  it("rejects a client-supplied Media identifier on either transport", () => {
    let caught: unknown;
    try {
      buildCliExternalMessage([
        "send",
        "--route",
        ROUTE,
        "--operation",
        "operation-1",
        "--client-message",
        "client-1",
        "--media-id",
        "media-photo",
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConsoleExtensionError);
    expect((caught as ConsoleExtensionError).code).toBe("MESSAGE_INVALID");
  });
});
