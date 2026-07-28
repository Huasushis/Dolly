import { describe, expect, it } from "vitest";
import { buildReactiveModuleInput } from "../../../src/core/reactive-module-input.js";
import {
  ConsoleEgressCoordinator,
  ConsoleExtensionError,
  ConsoleHttpChannel,
  ConsoleSessionStore,
  parseExternalMessage,
  startLoopbackGateway,
  type ConsoleErrorCode,
} from "../../../src/extensions/console/index.js";
import {
  contentBlock,
  createGatewayHarness,
  createStoreHarness,
  enqueueBody,
  openWebSocket,
  pairBrowserSession,
  postMessage,
} from "./fixtures.js";

function expectConsoleError(run: () => unknown, code: ConsoleErrorCode): ConsoleExtensionError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConsoleExtensionError);
  const error = caught as ConsoleExtensionError;
  expect(error.code).toBe(code);
  return error;
}

function message(input: {
  readonly operationId: string;
  readonly clientMessageId: string;
  readonly routeAlias: string;
  readonly text: string;
}) {
  return parseExternalMessage({
    version: "1",
    type: "console.message.enqueue",
    operationId: input.operationId,
    clientMessageId: input.clientMessageId,
    routeAlias: input.routeAlias,
    text: input.text,
  });
}

function coordinatorFor(store: ConsoleSessionStore): ConsoleEgressCoordinator {
  let membership = 0;
  return new ConsoleEgressCoordinator({
    store,
    nextMembershipSnapshotId: () => `membership-${(membership += 1)}`,
  });
}

function deliveryOf(blockId: string, deliveryId: string) {
  return buildReactiveModuleInput({
    claimedDeliveryIds: [deliveryId],
    blockGroups: [
      {
        block: contentBlock([{ type: "text", text: `output for ${blockId}`, format: "plain" }], blockId),
        deliveryIds: [deliveryId],
        occurrenceCount: 1,
        firstGlobalSequence: "1",
        lastGlobalSequence: "1",
      },
    ],
    hasMore: false,
  });
}

/**
 * SEC-002 conformance.
 *
 * The legacy Console prototype kept one global transcript and broadcast every
 * event to every connected socket. These cases assert the replacement rule
 * from `console-extension.md` section 6.2: state is scoped by session, a new
 * session must choose its start explicitly, and no read path exists that
 * reaches another principal's queue, display stream, or cursor.
 */
describe("Console session isolation", () => {
  it("refuses a session that does not choose a display start", () => {
    const { store } = createStoreHarness();
    store.registerRoute({
      alias: "shared",
      revision: "r1",
      visibility: "shared",
      allowedPrincipals: ["principal-a"],
      consumerStart: { kind: "from-now" },
    });
    expectConsoleError(
      () =>
        store.openSession({
          sessionId: "session-a",
          principalId: "principal-a",
          routeAlias: "shared",
          routeRevision: "r1",
        }),
      "DISPLAY_START_REQUIRED",
    );
    // An unrecognised start policy is refused rather than treated as a default.
    expectConsoleError(
      () =>
        store.openSession({
          sessionId: "session-a",
          principalId: "principal-a",
          routeAlias: "shared",
          routeRevision: "r1",
          displayStart: { kind: "from-head" } as never,
        }),
      "DISPLAY_START_REQUIRED",
    );
    expect(store.sessionState("session-a")).toBeNull();
  });

  it("keeps ingress queues private to their own session", () => {
    const { store } = createStoreHarness();
    store.registerRoute({
      alias: "shared",
      revision: "r1",
      visibility: "shared",
      allowedPrincipals: ["principal-a", "principal-b"],
      consumerStart: { kind: "from-now" },
    });
    for (const [sessionId, principalId] of [
      ["session-a", "principal-a"],
      ["session-b", "principal-b"],
    ]) {
      store.openSession({
        sessionId: sessionId!,
        principalId: principalId!,
        routeAlias: "shared",
        routeRevision: "r1",
        displayStart: { kind: "from-now" },
      });
    }

    store.acceptMessage({
      sessionId: "session-a",
      principalId: "principal-a",
      message: message({
        operationId: "operation-1",
        clientMessageId: "client-1",
        routeAlias: "shared",
        text: "only session A wrote this",
      }),
    });

    expect(store.pendingMessages("session-a", "principal-a")).toHaveLength(1);
    expect(store.pendingMessages("session-b", "principal-b")).toHaveLength(0);
    // Session B's principal cannot name session A at all.
    expectConsoleError(
      () => store.pendingMessages("session-a", "principal-b"),
      "SESSION_SCOPE_DENIED",
    );
    expectConsoleError(
      () => store.listDisplay({ sessionId: "session-a", principalId: "principal-b" }),
      "SESSION_SCOPE_DENIED",
    );
    expectConsoleError(
      () =>
        store.acceptMessage({
          sessionId: "session-a",
          principalId: "principal-b",
          message: message({
            operationId: "operation-2",
            clientMessageId: "client-2",
            routeAlias: "shared",
            text: "injected",
          }),
        }),
      "SESSION_SCOPE_DENIED",
    );

    // The same idempotency key in a different session is a different message,
    // because idempotency is session-scoped rather than global.
    const receipt = store.acceptMessage({
      sessionId: "session-b",
      principalId: "principal-b",
      message: message({
        operationId: "operation-1",
        clientMessageId: "client-1",
        routeAlias: "shared",
        text: "session B wrote something else",
      }),
    });
    expect(receipt.acceptanceSequence).toBe("1");
    expect(store.pendingMessages("session-b", "principal-b")).toHaveLength(1);
  });

  it("gives each member its own display sequence, cursor, and occurrence", () => {
    const { store } = createStoreHarness();
    store.registerRoute({
      alias: "shared",
      revision: "r1",
      visibility: "shared",
      allowedPrincipals: ["principal-a", "principal-b"],
      consumerStart: { kind: "from-now" },
    });
    store.openSession({
      sessionId: "session-a",
      principalId: "principal-a",
      routeAlias: "shared",
      routeRevision: "r1",
      displayStart: { kind: "from-now" },
    });
    store.openSession({
      sessionId: "session-b",
      principalId: "principal-b",
      routeAlias: "shared",
      routeRevision: "r1",
      displayStart: { kind: "from-now" },
    });

    const coordinator = coordinatorFor(store);
    const prepared = coordinator.prepare({
      instanceId: "instance-1",
      moduleJobId: "job-1",
      routeAlias: "shared",
      routeRevision: "r1",
      input: deliveryOf("block-shared", "delivery-1"),
    });
    expect(prepared.kind).toBe("prepared");
    // A prepared record is invisible until the Module job outcome activates it.
    expect(store.listDisplay({ sessionId: "session-a", principalId: "principal-a" })).toEqual([]);

    coordinator.activate({ instanceId: "instance-1", moduleJobId: "job-1" });
    const forA = store.listDisplay({ sessionId: "session-a", principalId: "principal-a" });
    const forB = store.listDisplay({ sessionId: "session-b", principalId: "principal-b" });
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0]!.displaySequence).toBe("1");
    expect(forB[0]!.displaySequence).toBe("1");
    expect(forA[0]!.blockId).toBe("block-shared");

    // One member acknowledging releases only its own retained item.
    store.ackDisplay({
      sessionId: "session-a",
      principalId: "principal-a",
      operationId: "ack-1",
      ackThrough: "1",
    });
    expect(store.displayCursor("session-a", "principal-a")).toBe("1");
    expect(store.displayCursor("session-b", "principal-b")).toBe("0");
    expect(store.listDisplay({ sessionId: "session-a", principalId: "principal-a" })).toEqual([]);
    expect(store.listDisplay({ sessionId: "session-b", principalId: "principal-b" })).toHaveLength(
      1,
    );

    // A future or never-issued cursor fails visibly rather than creating a gap.
    expectConsoleError(
      () =>
        store.ackDisplay({
          sessionId: "session-b",
          principalId: "principal-b",
          operationId: "ack-2",
          ackThrough: "7",
        }),
      "DISPLAY_ACK_INVALID",
    );
    // Replaying one operation identifier with a different cursor is a conflict.
    expectConsoleError(
      () =>
        store.ackDisplay({
          sessionId: "session-a",
          principalId: "principal-a",
          operationId: "ack-1",
          ackThrough: "0",
        }),
      "DISPLAY_ACK_INVALID",
    );
    // Repeating the same operation is idempotent.
    expect(
      store.ackDisplay({
        sessionId: "session-a",
        principalId: "principal-a",
        operationId: "ack-1",
        ackThrough: "1",
      }),
    ).toEqual({ ackThrough: "1" });
    // And another principal cannot move a cursor that is not theirs.
    expectConsoleError(
      () =>
        store.ackDisplay({
          sessionId: "session-b",
          principalId: "principal-a",
          operationId: "ack-3",
          ackThrough: "1",
        }),
      "SESSION_SCOPE_DENIED",
    );
  });

  it("never hands a late joiner a batch prepared before it chose from-now", () => {
    const { store } = createStoreHarness();
    store.registerRoute({
      alias: "shared",
      revision: "r1",
      visibility: "shared",
      allowedPrincipals: ["principal-a", "principal-c"],
      consumerStart: { kind: "from-now" },
    });
    store.openSession({
      sessionId: "session-a",
      principalId: "principal-a",
      routeAlias: "shared",
      routeRevision: "r1",
      displayStart: { kind: "from-now" },
    });

    const coordinator = coordinatorFor(store);
    coordinator.prepare({
      instanceId: "instance-1",
      moduleJobId: "job-1",
      routeAlias: "shared",
      routeRevision: "r1",
      input: deliveryOf("block-early", "delivery-1"),
    });
    expect(store.preparationFrontier("shared", "r1")).toBe("1");

    // Session C joins while batch 1 is still prepared.
    store.openSession({
      sessionId: "session-c",
      principalId: "principal-c",
      routeAlias: "shared",
      routeRevision: "r1",
      displayStart: { kind: "from-now" },
    });
    coordinator.activate({ instanceId: "instance-1", moduleJobId: "job-1" });
    expect(store.listDisplay({ sessionId: "session-c", principalId: "principal-c" })).toEqual([]);
    expect(store.listDisplay({ sessionId: "session-a", principalId: "principal-a" })).toHaveLength(
      1,
    );

    // Even an explicit attempt to backfill the earlier ordinal is refused.
    expectConsoleError(
      () =>
        store.appendDisplayItems({
          sessionId: "session-c",
          preparationOrdinal: "1",
          items: [
            {
              blockId: "block-early",
              deliveryIds: ["delivery-1"],
              source: { kind: "module", id: "module-writer" },
              createdAt: "2026-07-26T00:00:00.000Z",
              presentation: [{ kind: "text", text: "backfilled", format: "plain" }],
            },
          ],
        }),
      "DISPLAY_START_REQUIRED",
    );

    const second = coordinator.prepare({
      instanceId: "instance-1",
      moduleJobId: "job-2",
      routeAlias: "shared",
      routeRevision: "r1",
      input: deliveryOf("block-late", "delivery-2"),
    });
    expect(second.kind).toBe("prepared");
    coordinator.activate({ instanceId: "instance-1", moduleJobId: "job-2" });
    const forC = store.listDisplay({ sessionId: "session-c", principalId: "principal-c" });
    expect(forC).toHaveLength(1);
    expect(forC[0]!.blockId).toBe("block-late");
    expect(forC[0]!.preparationOrdinal).toBe("2");
    expect(forC[0]!.displaySequence).toBe("1");
  });

  it("resumes only the same principal's own retained window", () => {
    const { store } = createStoreHarness();
    store.registerRoute({
      alias: "private-a",
      revision: "r1",
      visibility: "private",
      allowedPrincipals: ["principal-a", "principal-b"],
      consumerStart: { kind: "from-now" },
    });
    store.openSession({
      sessionId: "session-a1",
      principalId: "principal-a",
      routeAlias: "private-a",
      routeRevision: "r1",
      displayStart: { kind: "from-now" },
    });
    const coordinator = coordinatorFor(store);
    coordinator.prepare({
      instanceId: "instance-1",
      moduleJobId: "job-1",
      routeAlias: "private-a",
      routeRevision: "r1",
      input: deliveryOf("block-a", "delivery-1"),
    });
    coordinator.activate({ instanceId: "instance-1", moduleJobId: "job-1" });
    store.closeSession("session-a1", "principal-a");

    // Another principal cannot adopt that window by naming the prior session.
    expectConsoleError(
      () =>
        store.openSession({
          sessionId: "session-b1",
          principalId: "principal-b",
          routeAlias: "private-a",
          routeRevision: "r1",
          displayStart: {
            kind: "from-session-resume",
            priorSessionId: "session-a1",
            authorizedBy: "principal-b",
          },
        }),
      "SESSION_SCOPE_DENIED",
    );
    expect(store.sessionState("session-b1")).toBeNull();

    store.openSession({
      sessionId: "session-a2",
      principalId: "principal-a",
      routeAlias: "private-a",
      routeRevision: "r1",
      displayStart: {
        kind: "from-session-resume",
        priorSessionId: "session-a1",
        authorizedBy: "principal-a",
      },
    });
    const resumed = store.listDisplay({ sessionId: "session-a2", principalId: "principal-a" });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.blockId).toBe("block-a");

    // A revoked session's window is gone and cannot be resumed.
    store.revokeSession("session-a1");
    expectConsoleError(
      () => store.pendingMessages("session-a1", "principal-a"),
      "SESSION_REVOKED",
    );
    expectConsoleError(
      () =>
        store.openSession({
          sessionId: "session-a3",
          principalId: "principal-a",
          routeAlias: "private-a",
          routeRevision: "r1",
          displayStart: {
            kind: "from-session-resume",
            priorSessionId: "session-a1",
            authorizedBy: "principal-a",
          },
        }),
      "SESSION_REVOKED",
    );
  });

  it("delivers a display event to its own session's sockets only", async () => {
    const { gateway } = createGatewayHarness();
    const address = await startLoopbackGateway(gateway);
    const { store } = createStoreHarness();
    store.registerRoute({
      alias: "private-a",
      revision: "r1",
      visibility: "private",
      allowedPrincipals: ["principal-a"],
      consumerStart: { kind: "from-now" },
    });
    store.registerRoute({
      alias: "private-b",
      revision: "r1",
      visibility: "private",
      allowedPrincipals: ["principal-b"],
      consumerStart: { kind: "from-now" },
    });

    let socketA: Awaited<ReturnType<typeof openWebSocket>> | undefined;
    let socketB: Awaited<ReturnType<typeof openWebSocket>> | undefined;
    try {
      const browserA = await pairBrowserSession(gateway, address.origin, "principal-a", [
        "private-a",
      ]);
      const browserB = await pairBrowserSession(gateway, address.origin, "principal-b", [
        "private-b",
      ]);
      store.openSession({
        sessionId: browserA.sessionId,
        principalId: "principal-a",
        routeAlias: "private-a",
        routeRevision: "r1",
        displayStart: { kind: "from-now" },
      });
      store.openSession({
        sessionId: browserB.sessionId,
        principalId: "principal-b",
        routeAlias: "private-b",
        routeRevision: "r1",
        displayStart: { kind: "from-now" },
      });

      // Session A submits over the real transport; session B must not see it.
      const posted = await postMessage(
        address,
        browserA,
        enqueueBody({
          operationId: "operation-1",
          clientMessageId: "client-1",
          routeAlias: "private-a",
          text: "private to A",
        }),
      );
      expect(posted.status).toBe(202);
      const bMessages = await fetch(`${address.origin}/v1/messages`, {
        headers: { cookie: browserB.cookie },
      });
      expect(await bMessages.json()).toMatchObject({ messages: [] });

      socketA = await openWebSocket(address.origin, browserA.cookie);
      socketB = await openWebSocket(address.origin, browserB.cookie);
      const displayEventsForB: unknown[] = [];
      socketB.socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as { type?: string };
        if (event.type === "display.event") displayEventsForB.push(event);
      });
      const displayForA = new Promise<Record<string, unknown>>((resolve) => {
        socketA!.socket.once("message", (data) =>
          resolve(JSON.parse(data.toString()) as Record<string, unknown>),
        );
      });

      const coordinator = coordinatorFor(store);
      coordinator.prepare({
        instanceId: "instance-1",
        moduleJobId: "job-1",
        routeAlias: "private-a",
        routeRevision: "r1",
        input: deliveryOf("block-for-a", "delivery-1"),
      });
      coordinator.activate({ instanceId: "instance-1", moduleJobId: "job-1" });

      const channel = new ConsoleHttpChannel({ gateway, store });
      const published = channel.publishDisplay({
        sessionId: browserA.sessionId,
        principalId: "principal-a",
      });
      expect(published).toHaveLength(1);
      await expect(displayForA).resolves.toMatchObject({
        type: "display.event",
        payload: { blockId: "block-for-a" },
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(displayEventsForB).toEqual([]);
      expect(store.listDisplay({ sessionId: browserB.sessionId, principalId: "principal-b" })).toEqual(
        [],
      );

      // Republishing does not replay an item the session already received.
      expect(
        channel.publishDisplay({ sessionId: browserA.sessionId, principalId: "principal-a" }),
      ).toEqual([]);
    } finally {
      socketA?.socket.close();
      socketB?.socket.close();
      await gateway.stop();
    }
  });
});
