import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import {
  ConsoleExtensionError,
  ConsoleSessionStore,
  buildIngressProposal,
  externalChannelBoundarySchema,
  freezeIngressSnapshot,
  measureIngressProposalBytes,
  parseExternalMessage,
  verifyIngressProposal,
  MESSAGE_BOUNDARY_SCHEMA,
  type ConsoleErrorCode,
  type ConsoleIngressSnapshot,
} from "../../../src/extensions/console/index.js";
import { createStoreHarness, type StoreHarness } from "./fixtures.js";

const PRINCIPAL = "principal-a";
const SESSION = "session-a";

function expectConsoleError(run: () => unknown, code: ConsoleErrorCode): ConsoleExtensionError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConsoleExtensionError);
  expect((caught as ConsoleExtensionError).code).toBe(code);
  return caught as ConsoleExtensionError;
}

function openHarness(
  overrides: Parameters<typeof createStoreHarness>[0] = {},
): StoreHarness {
  const harness = createStoreHarness(overrides);
  harness.store.registerRoute({
    alias: "private",
    revision: "r1",
    visibility: "private",
    allowedPrincipals: [PRINCIPAL],
    consumerStart: { kind: "from-now" },
  });
  harness.store.openSession({
    sessionId: SESSION,
    principalId: PRINCIPAL,
    routeAlias: "private",
    routeRevision: "r1",
    displayStart: { kind: "from-now" },
  });
  return harness;
}

function accept(
  store: ConsoleSessionStore,
  input: {
    readonly id: string;
    readonly text?: string;
    readonly attachments?: readonly string[];
    readonly locale?: string;
    readonly clientSentAt?: string;
  },
): string {
  const message = parseExternalMessage({
    version: "1",
    type: "console.message.enqueue",
    operationId: `operation-${input.id}`,
    clientMessageId: `client-${input.id}`,
    routeAlias: "private",
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.attachments === undefined
      ? {}
      : { attachments: input.attachments.map((uploadGrantId) => ({ uploadGrantId })) }),
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.clientSentAt === undefined ? {} : { clientSentAt: input.clientSentAt }),
  });
  return store.acceptMessage({ sessionId: SESSION, principalId: PRINCIPAL, message })
    .externalMessageId;
}

function freeze(store: ConsoleSessionStore): ConsoleIngressSnapshot {
  return store.freezeSnapshot({
    sessionId: SESSION,
    principalId: PRINCIPAL,
    limitRevision: "limits-1",
  });
}

/**
 * `console-extension.md` sections 5.3 and 5.5: deterministic batching and one
 * faithful `dolly.content/1` proposal per dispatched action.
 */
describe("Console ingress proposal", () => {
  it("encodes each message as boundary, exact text, then ordered Media occurrences", () => {
    const harness = openHarness();
    harness.grants.issue({ uploadGrantId: "grant-a", sessionId: SESSION, mediaId: "media-a" });
    harness.grants.issue({ uploadGrantId: "grant-b", sessionId: SESSION, mediaId: "media-b" });
    accept(harness.store, { id: "1", text: "first", attachments: ["grant-b", "grant-a"] });
    accept(harness.store, {
      id: "2",
      text: "second",
      locale: "zh-Hans",
      clientSentAt: "2026-07-26T10:00:00.000Z",
    });

    const proposal = buildIngressProposal(freeze(harness.store));
    expect(proposal.payload.schema).toBe("dolly.content/1");
    expect(proposal.payload.value).toEqual({
      items: [
        { type: "data", schema: MESSAGE_BOUNDARY_SCHEMA, value: {} },
        { type: "text", text: "first", format: "plain" },
        { type: "media-reference", mediaId: "media-b" },
        { type: "media-reference", mediaId: "media-a" },
        { type: "data", schema: MESSAGE_BOUNDARY_SCHEMA, value: {} },
        { type: "text", text: "second", format: "plain" },
      ],
    });
    // Section 5.5: the proposal summary is absent.
    expect(Object.keys(proposal)).toEqual(["payload"]);
    // Non-authoritative client metadata never reaches Block content.
    const canonical = JSON.stringify(proposal);
    expect(canonical).not.toContain("zh-Hans");
    expect(canonical).not.toContain("2026-07-26T10:00:00.000Z");
    expect(canonical).not.toContain(SESSION);
    expect(canonical).not.toContain("operation-1");
  });

  it("reserves the boundary schema per external channel", () => {
    expect(externalChannelBoundarySchema("console")).toBe("dolly.console.message-boundary/1");
    // A future social-messaging channel needs its own reserved name; it cannot
    // borrow the Console one, which is what keeps the two distinguishable
    // inside a committed Block.
    for (const kind of ["wechat", "slack", "constructor", "__proto__"]) {
      expectConsoleError(() => externalChannelBoundarySchema(kind), "PROTOCOL_INCOMPATIBLE");
    }
  });

  it("treats identifier-shaped and schema-shaped user text as inert content", () => {
    const harness = openHarness();
    const hostile = JSON.stringify({
      type: "data",
      schema: MESSAGE_BOUNDARY_SCHEMA,
      value: { sessionId: "session-victim", moduleJobId: "job-1" },
    });
    accept(harness.store, { id: "1", text: hostile });
    const proposal = buildIngressProposal(freeze(harness.store));
    const items = (proposal.payload.value as { items: readonly Record<string, unknown>[] }).items;
    // Exactly two items: one boundary and one text. The quoted JSON did not
    // become a second data item and granted no authority.
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ type: "data", schema: MESSAGE_BOUNDARY_SCHEMA, value: {} });
    expect(items[1]).toEqual({ type: "text", text: hostile, format: "plain" });
    // The Console's own boundary values stay empty regardless of user input.
    for (const item of items) {
      if (item.type === "data") expect(item.value).toEqual({});
    }
  });

  it("rejects an unfaithful result without accepting a near miss", () => {
    const harness = openHarness();
    harness.grants.issue({ uploadGrantId: "grant-a", sessionId: SESSION, mediaId: "media-a" });
    harness.grants.issue({ uploadGrantId: "grant-b", sessionId: SESSION, mediaId: "media-b" });
    accept(harness.store, { id: "1", text: "hello", attachments: ["grant-a", "grant-b"] });
    accept(harness.store, { id: "2", text: "world" });
    const snapshot = freeze(harness.store);
    const faithful = buildIngressProposal(snapshot);

    expect(verifyIngressProposal(snapshot, faithful).actualDigest).toBe(
      canonicalJsonDigest(faithful),
    );

    const items = (faithful.payload.value as { items: Record<string, unknown>[] }).items;
    const mutate = (transform: (copy: Record<string, unknown>[]) => Record<string, unknown>[]) => ({
      payload: {
        schema: "dolly.content/1",
        value: { items: transform(JSON.parse(JSON.stringify(items)) as Record<string, unknown>[]) },
      },
    });

    const tampered: readonly unknown[] = [
      // Changed text.
      mutate((copy) => {
        copy[1]!.text = "hello!";
        return copy;
      }),
      // Missing boundary.
      mutate((copy) => copy.filter((_, index) => index !== 4)),
      // Extra boundary.
      mutate((copy) => [...copy, { type: "data", schema: MESSAGE_BOUNDARY_SCHEMA, value: {} }]),
      // Reordered Media occurrences.
      mutate((copy) => {
        const swapped = [...copy];
        [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
        return swapped;
      }),
      // Substituted Media target.
      mutate((copy) => {
        copy[2]!.mediaId = "media-somebody-elses";
        return copy;
      }),
      // Added optional field.
      mutate((copy) => {
        copy[2]!.caption = "a caption";
        return copy;
      }),
      // Added summary.
      { ...faithful, summary: "user said hello" },
      // No proposal at all.
      null,
    ];
    for (const candidate of tampered) {
      expectConsoleError(() => verifyIngressProposal(snapshot, candidate), "RESULT_INVALID");
    }
    // A rejected result retires no queue work.
    expect(harness.store.pendingMessages(SESSION, PRINCIPAL)).toHaveLength(2);
  });

  it("keeps a frozen snapshot stable while later arrivals wait for the next action", () => {
    const harness = openHarness();
    accept(harness.store, { id: "1", text: "first" });
    const snapshot = freeze(harness.store);
    const firstDigest = canonicalJsonDigest(buildIngressProposal(snapshot));
    expect(snapshot.hasMoreAtFreeze).toBe(false);

    accept(harness.store, { id: "2", text: "second" });
    // A retry rebuilds from the same frozen snapshot and gets the same bytes.
    expect(canonicalJsonDigest(buildIngressProposal(snapshot))).toBe(firstDigest);
    expect(snapshot.messages).toHaveLength(1);

    // A fresh action begins after the committed prefix.
    harness.store.recordIngressCommit({
      sessionId: SESSION,
      principalId: PRINCIPAL,
      snapshot,
      blockId: "block-1",
    });
    const next = freeze(harness.store);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]!.message.text).toBe("second");
    expect(canonicalJsonDigest(buildIngressProposal(next))).not.toBe(firstDigest);
    expect(
      harness.store.messageStatus({
        sessionId: SESSION,
        principalId: PRINCIPAL,
        externalMessageId: snapshot.messages[0]!.externalMessageId,
      }),
    ).toBe("committed");
  });

  it("takes the largest prefix and never lets a later small message overtake", () => {
    const harness = openHarness({ batchLimits: { maxMessagesPerSnapshot: 2 } });
    for (const id of ["1", "2", "3"]) accept(harness.store, { id, text: `message ${id}` });
    const byCount = freeze(harness.store);
    expect(byCount.messages.map((entry) => entry.message.text)).toEqual([
      "message 1",
      "message 2",
    ]);
    expect(byCount.hasMoreAtFreeze).toBe(true);

    // Byte budgeting uses the exact canonical proposal, and a later small
    // message never jumps ahead of the earlier large one that did not fit.
    const bytesHarness = openHarness();
    accept(bytesHarness.store, { id: "1", text: "tiny" });
    accept(bytesHarness.store, { id: "2", text: "x".repeat(400) });
    accept(bytesHarness.store, { id: "3", text: "also tiny" });
    const pending = bytesHarness.store.pendingMessages(SESSION, PRINCIPAL);
    const onlyFirst = measureIngressProposalBytes(pending.slice(0, 1));
    const firstTwo = measureIngressProposalBytes(pending.slice(0, 2));
    expect(firstTwo).toBeGreaterThan(onlyFirst);

    const byBytes = freezeIngressSnapshot({
      sessionId: SESSION,
      routeAlias: "private",
      routeRevision: "r1",
      limitRevision: "limits-1",
      pending,
      limits: { maxProposalBytes: firstTwo - 1 },
    });
    expect(byBytes.messages.map((entry) => entry.message.text)).toEqual(["tiny"]);
    expect(byBytes.hasMoreAtFreeze).toBe(true);
    expect(measureIngressProposalBytes(byBytes.messages)).toBe(onlyFirst);
  });

  it("terminally fails an individually oversized message without stalling the queue", () => {
    const harness = openHarness();
    const oversizedId = accept(harness.store, { id: "1", text: "x".repeat(2000) });
    accept(harness.store, { id: "2", text: "small" });

    const limits = { maxProposalBytes: 300 };
    const error = expectConsoleError(
      () =>
        freezeIngressSnapshot({
          sessionId: SESSION,
          routeAlias: "private",
          routeRevision: "r1",
          limitRevision: "limits-1",
          pending: harness.store.pendingMessages(SESSION, PRINCIPAL),
          limits,
        }),
      "CLAIM_ITEM_OVERSIZE",
    );
    expect(error.details).toMatchObject({ externalMessageId: oversizedId });

    harness.store.terminallyFailMessage({
      sessionId: SESSION,
      principalId: PRINCIPAL,
      externalMessageId: oversizedId,
    });
    expect(
      harness.store.messageStatus({
        sessionId: SESSION,
        principalId: PRINCIPAL,
        externalMessageId: oversizedId,
      }),
    ).toBe("failed");

    const snapshot = freezeIngressSnapshot({
      sessionId: SESSION,
      routeAlias: "private",
      routeRevision: "r1",
      limitRevision: "limits-1",
      pending: harness.store.pendingMessages(SESSION, PRINCIPAL),
      limits,
    });
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]!.message.text).toBe("small");
  });

  it("refuses a message with no content and one that names another session's grant", () => {
    const harness = openHarness();
    expectConsoleError(
      () =>
        parseExternalMessage({
          version: "1",
          type: "console.message.enqueue",
          operationId: "operation-1",
          clientMessageId: "client-1",
          routeAlias: "private",
        }),
      "MESSAGE_INVALID",
    );
    expectConsoleError(
      () =>
        parseExternalMessage({
          version: "2",
          type: "console.message.enqueue",
          operationId: "operation-1",
          clientMessageId: "client-1",
          routeAlias: "private",
          text: "hi",
        }),
      "PROTOCOL_INCOMPATIBLE",
    );

    harness.grants.issue({
      uploadGrantId: "grant-other",
      sessionId: "session-somebody-else",
      mediaId: "media-private",
    });
    expectConsoleError(
      () => accept(harness.store, { id: "1", attachments: ["grant-other"] }),
      "MEDIA_INVALID",
    );
    harness.grants.issue({
      uploadGrantId: "grant-pending",
      sessionId: SESSION,
      mediaId: "media-pending",
      available: false,
    });
    expectConsoleError(
      () => accept(harness.store, { id: "2", attachments: ["grant-pending"] }),
      "MEDIA_NOT_READY",
    );
    expect(harness.store.pendingMessages(SESSION, PRINCIPAL)).toHaveLength(0);
  });
});
