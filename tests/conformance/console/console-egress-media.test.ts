import { describe, expect, it } from "vitest";
import { buildReactiveModuleInput } from "../../../src/core/reactive-module-input.js";
import type { Block } from "../../../src/core/block-store.js";
import {
  ConsoleEgressCoordinator,
  ConsoleExtensionError,
  ConsoleSessionStore,
  assertEgressResultHasNoProposal,
  buildIngressProposal,
  parseExternalMessage,
  presentBlock,
  MESSAGE_BOUNDARY_SCHEMA,
  type ConsoleErrorCode,
} from "../../../src/extensions/console/index.js";
import { contentBlock, createStoreHarness, makeBlock, type StoreHarness } from "./fixtures.js";

const FULL_CROP = {
  topLeft: { x: 0.1, y: 0.1 },
  bottomRight: { x: 0.5, y: 0.5 },
};

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

function coordinatorFor(store: ConsoleSessionStore): ConsoleEgressCoordinator {
  let membership = 0;
  return new ConsoleEgressCoordinator({
    store,
    nextMembershipSnapshotId: () => `membership-${(membership += 1)}`,
  });
}

function inputOf(blocks: readonly Block[]) {
  return buildReactiveModuleInput({
    claimedDeliveryIds: blocks.map((_, index) => `delivery-${index + 1}`),
    blockGroups: blocks.map((block, index) => ({
      block,
      deliveryIds: [`delivery-${index + 1}`],
      occurrenceCount: 1,
      firstGlobalSequence: String(index + 1),
      lastGlobalSequence: String(index + 1),
    })),
    hasMore: false,
  });
}

function openRoute(
  harness: StoreHarness,
  input: {
    readonly alias: string;
    readonly visibility: "private" | "shared";
    readonly sessions: readonly { readonly sessionId: string; readonly principalId: string }[];
  },
): void {
  harness.store.registerRoute({
    alias: input.alias,
    revision: "r1",
    visibility: input.visibility,
    allowedPrincipals: input.sessions.map((session) => session.principalId),
    consumerStart: { kind: "from-now" },
  });
  for (const session of input.sessions) {
    harness.store.openSession({
      sessionId: session.sessionId,
      principalId: session.principalId,
      routeAlias: input.alias,
      routeRevision: "r1",
      displayStart: { kind: "from-now" },
    });
  }
}

/**
 * Egress conformance: `console-extension.md` section 6, plus the Media rule
 * from `security-operations.md` section 10 that an Extension may reach only
 * Media named by a Block already delivered to its Module job.
 */
describe("Console egress and Media contract", () => {
  it("rejects any Block output from the egress role", () => {
    assertEgressResultHasNoProposal({ acknowledged: true });
    for (const forbidden of [
      { proposal: { payload: { schema: "dolly.content/1", value: { items: [] } } } },
      { blockProposal: {} },
      { moduleDescription: "replacement" },
      { retentionChanges: [] },
    ]) {
      expectConsoleError(() => assertEgressResultHasNoProposal(forbidden), "RESULT_INVALID");
    }
    expectConsoleError(() => assertEgressResultHasNoProposal(null), "RESULT_INVALID");
  });

  it("freezes membership at prepare and stays idempotent across retries", () => {
    const harness = createStoreHarness();
    openRoute(harness, {
      alias: "shared",
      visibility: "shared",
      sessions: [
        { sessionId: "session-a", principalId: "principal-a" },
        { sessionId: "session-b", principalId: "principal-b" },
      ],
    });
    const coordinator = coordinatorFor(harness.store);
    const input = inputOf([contentBlock([{ type: "text", text: "hello", format: "plain" }])]);

    const first = coordinator.prepare({
      instanceId: "instance-1",
      moduleJobId: "job-1",
      routeAlias: "shared",
      routeRevision: "r1",
      input,
    });
    expect(first.kind).toBe("prepared");
    if (first.kind !== "prepared") throw new Error("unreachable");
    expect(first.records.map((record) => record.sessionId)).toEqual(["session-a", "session-b"]);
    expect(new Set(first.records.map((record) => record.membershipSnapshotId)).size).toBe(1);
    expect(first.records[0]!.state).toBe("prepared");

    // A retry reuses the same snapshot and does not double-prepare.
    const retry = coordinator.prepare({
      instanceId: "instance-1",
      moduleJobId: "job-1",
      routeAlias: "shared",
      routeRevision: "r1",
      input,
    });
    if (retry.kind !== "prepared") throw new Error("unreachable");
    expect(retry.records).toEqual(first.records);

    // A different input under the same Module job is a visible conflict.
    expectConsoleError(
      () =>
        coordinator.prepare({
          instanceId: "instance-1",
          moduleJobId: "job-1",
          routeAlias: "shared",
          routeRevision: "r1",
          input: inputOf([contentBlock([{ type: "text", text: "different", format: "plain" }])]),
        }),
      "DISPLAY_PREPARATION_CONFLICT",
    );

    coordinator.activate({ instanceId: "instance-1", moduleJobId: "job-1" });
    expect(
      harness.store.listDisplay({ sessionId: "session-a", principalId: "principal-a" }),
    ).toHaveLength(1);
    // Replaying activation assigns no second sequence.
    coordinator.activate({ instanceId: "instance-1", moduleJobId: "job-1" });
    expect(
      harness.store.listDisplay({ sessionId: "session-a", principalId: "principal-a" }),
    ).toHaveLength(1);
  });

  it("fails a non-lossy route with no eligible member and records a lossy one", () => {
    const harness = createStoreHarness();
    harness.store.registerRoute({
      alias: "empty",
      revision: "r1",
      visibility: "shared",
      allowedPrincipals: ["principal-a"],
      consumerStart: { kind: "from-now" },
    });
    const coordinator = coordinatorFor(harness.store);
    const input = inputOf([contentBlock([{ type: "text", text: "nobody home", format: "plain" }])]);

    expectConsoleError(
      () =>
        coordinator.prepare({
          instanceId: "instance-1",
          moduleJobId: "job-1",
          routeAlias: "empty",
          routeRevision: "r1",
          input,
        }),
      "BACKPRESSURE",
    );
    expect(
      coordinator.prepare({
        instanceId: "instance-1",
        moduleJobId: "job-2",
        routeAlias: "empty",
        routeRevision: "r1",
        input,
        lossy: true,
      }),
    ).toEqual({ kind: "not-presented", reason: "no-eligible-member" });
  });

  it("keeps a retired preparation invisible and refuses to activate it", () => {
    const harness = createStoreHarness();
    openRoute(harness, {
      alias: "private",
      visibility: "private",
      sessions: [{ sessionId: "session-a", principalId: "principal-a" }],
    });
    const coordinator = coordinatorFor(harness.store);
    coordinator.prepare({
      instanceId: "instance-1",
      moduleJobId: "job-1",
      routeAlias: "private",
      routeRevision: "r1",
      input: inputOf([contentBlock([{ type: "text", text: "never shown", format: "plain" }])]),
    });
    expect(harness.store.listDisplay({ sessionId: "session-a", principalId: "principal-a" })).toEqual(
      [],
    );
    coordinator.retire({ instanceId: "instance-1", moduleJobId: "job-1" });
    expectConsoleError(
      () => coordinator.activate({ instanceId: "instance-1", moduleJobId: "job-1" }),
      "DISPLAY_PREPARATION_CONFLICT",
    );
    expect(harness.store.listDisplay({ sessionId: "session-a", principalId: "principal-a" })).toEqual(
      [],
    );
    // The internal preparation order advanced; no client sequence was consumed.
    expect(harness.store.preparationFrontier("private", "r1")).toBe("1");
  });

  it("authorizes Media display only from delivered references", () => {
    const harness = createStoreHarness();
    openRoute(harness, {
      alias: "private",
      visibility: "private",
      sessions: [{ sessionId: "session-a", principalId: "principal-a" }],
    });
    const coordinator = coordinatorFor(harness.store);
    const delivered = contentBlock([
      { type: "text", text: "here is media-secret and media-guess", format: "plain" },
      { type: "media-reference", mediaId: "media-open" },
      { type: "media-reference", mediaId: "media-cropped", crop: FULL_CROP },
    ]);
    coordinator.prepare({
      instanceId: "instance-1",
      moduleJobId: "job-1",
      routeAlias: "private",
      routeRevision: "r1",
      input: inputOf([delivered]),
    });

    const authorized = coordinator.authorizeMediaDisplay({
      instanceId: "instance-1",
      moduleJobId: "job-1",
      sessionId: "session-a",
      mediaId: "media-open",
    });
    expect(authorized.allowsFullMedia).toBe(true);
    expect(authorized.blockIds).toEqual([delivered.id]);

    // An identifier that only ever appeared inside delivered text is not a
    // reference and grants nothing.
    expectConsoleError(
      () =>
        coordinator.authorizeMediaDisplay({
          instanceId: "instance-1",
          moduleJobId: "job-1",
          sessionId: "session-a",
          mediaId: "media-secret",
        }),
      "MEDIA_NOT_DELIVERED",
    );
    expectConsoleError(
      () =>
        coordinator.authorizeMediaDisplay({
          instanceId: "instance-1",
          moduleJobId: "job-1",
          sessionId: "session-a",
          mediaId: "media-never-heard-of",
        }),
      "MEDIA_NOT_DELIVERED",
    );

    // The full image is out of scope when every delivered reference is cropped.
    expectConsoleError(
      () =>
        coordinator.authorizeMediaDisplay({
          instanceId: "instance-1",
          moduleJobId: "job-1",
          sessionId: "session-a",
          mediaId: "media-cropped",
        }),
      "MEDIA_CROP_NOT_DELIVERED",
    );
    // An enlarged crop is refused; a contained sub-crop is allowed.
    expectConsoleError(
      () =>
        coordinator.authorizeMediaDisplay({
          instanceId: "instance-1",
          moduleJobId: "job-1",
          sessionId: "session-a",
          mediaId: "media-cropped",
          crop: { topLeft: { x: 0.05, y: 0.05 }, bottomRight: { x: 0.6, y: 0.6 } },
        }),
      "MEDIA_CROP_NOT_DELIVERED",
    );
    expect(
      coordinator.authorizeMediaDisplay({
        instanceId: "instance-1",
        moduleJobId: "job-1",
        sessionId: "session-a",
        mediaId: "media-cropped",
        crop: { topLeft: { x: 0.2, y: 0.2 }, bottomRight: { x: 0.4, y: 0.4 } },
      }).crops,
    ).toEqual([FULL_CROP]);

    // A session outside the frozen membership cannot borrow the scope.
    expectConsoleError(
      () =>
        coordinator.authorizeMediaDisplay({
          instanceId: "instance-1",
          moduleJobId: "job-1",
          sessionId: "session-outsider",
          mediaId: "media-open",
        }),
      "SESSION_SCOPE_DENIED",
    );
  });

  it("presents unknown payloads inspectably without treating them as references", () => {
    const unknown = makeBlock({
      payload: {
        schema: "vendor.unknown/9",
        value: {
          mediaId: "media-not-a-reference",
          url: "https://example.invalid/secret",
          path: "C:/Users/secret.png",
        },
      },
    });
    const presented = presentBlock(unknown);
    expect(presented).toHaveLength(1);
    expect(presented[0]).toMatchObject({ kind: "structured", schema: "vendor.unknown/9" });

    // Nothing in an unknown payload becomes a Media reference.
    const harness = createStoreHarness();
    openRoute(harness, {
      alias: "private",
      visibility: "private",
      sessions: [{ sessionId: "session-a", principalId: "principal-a" }],
    });
    const coordinator = coordinatorFor(harness.store);
    coordinator.prepare({
      instanceId: "instance-1",
      moduleJobId: "job-1",
      routeAlias: "private",
      routeRevision: "r1",
      input: inputOf([unknown]),
    });
    expectConsoleError(
      () =>
        coordinator.authorizeMediaDisplay({
          instanceId: "instance-1",
          moduleJobId: "job-1",
          sessionId: "session-a",
          mediaId: "media-not-a-reference",
        }),
      "MEDIA_NOT_DELIVERED",
    );

    // A payload that claims dolly.content/1 but does not validate is not
    // partially rendered.
    const malformed = makeBlock({
      payload: { schema: "dolly.content/1", value: { items: [{ type: "text", text: "" }] } },
    });
    expect(presentBlock(malformed)).toEqual([
      { kind: "structured", schema: "dolly.content/1", preview: expect.any(String), truncated: false },
    ]);

    // A large structured payload is bounded rather than streamed whole.
    const large = makeBlock({
      payload: { schema: "vendor.big/1", value: { blob: "y".repeat(10_000) } },
    });
    const bounded = presentBlock(large, { maxStructuredPreviewBytes: 128 })[0]!;
    expect(bounded).toMatchObject({ kind: "structured", truncated: true });
    if (bounded.kind !== "structured") throw new Error("unreachable");
    expect(Buffer.byteLength(bounded.preview, "utf8")).toBeLessThanOrEqual(128);
  });

  it("reconciles a self-echo per session without a global deduplication set", () => {
    const harness = createStoreHarness();
    openRoute(harness, {
      alias: "shared",
      visibility: "shared",
      sessions: [
        { sessionId: "session-a", principalId: "principal-a" },
        { sessionId: "session-b", principalId: "principal-b" },
      ],
    });
    const message = parseExternalMessage({
      version: "1",
      type: "console.message.enqueue",
      operationId: "operation-1",
      clientMessageId: "client-1",
      routeAlias: "shared",
      text: "session A speaking",
    });
    harness.store.acceptMessage({
      sessionId: "session-a",
      principalId: "principal-a",
      message,
    });
    const snapshot = harness.store.freezeSnapshot({
      sessionId: "session-a",
      principalId: "principal-a",
      limitRevision: "limits-1",
    });
    const proposal = buildIngressProposal(snapshot);
    const committed = makeBlock({
      id: "block-from-a",
      source: { kind: "module", id: "console-ingress" },
      payload: proposal.payload,
    });
    harness.store.recordIngressCommit({
      sessionId: "session-a",
      principalId: "principal-a",
      snapshot,
      blockId: committed.id,
    });

    const coordinator = coordinatorFor(harness.store);
    coordinator.prepare({
      instanceId: "instance-1",
      moduleJobId: "job-1",
      routeAlias: "shared",
      routeRevision: "r1",
      input: inputOf([committed]),
    });
    coordinator.activate({ instanceId: "instance-1", moduleJobId: "job-1" });

    const forA = harness.store.listDisplay({ sessionId: "session-a", principalId: "principal-a" });
    const forB = harness.store.listDisplay({ sessionId: "session-b", principalId: "principal-b" });
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    // The author reconciles its optimistic item; the other member sees a
    // legitimate independent occurrence of the same Block.
    expect(forA[0]!.selfEcho).toBe(true);
    expect(forB[0]!.selfEcho).toBe(false);
    expect(forA[0]!.blockId).toBe(forB[0]!.blockId);
    expect(forB[0]!.presentation).toEqual([
      { kind: "message-boundary" },
      { kind: "text", text: "session A speaking", format: "plain" },
    ]);
    // The Block itself carries no external message or session identifier.
    expect(JSON.stringify(committed.payload)).not.toContain("session-a");
    expect(JSON.stringify(committed.payload)).not.toContain("client-1");
    expect(presentBlock(committed)[0]).toEqual({ kind: "message-boundary" });
    expect(MESSAGE_BOUNDARY_SCHEMA).toBe("dolly.console.message-boundary/1");
  });
});
