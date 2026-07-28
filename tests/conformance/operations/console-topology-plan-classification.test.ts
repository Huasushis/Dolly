/**
 * `instance-topology.md` Sections 6 and 7 conformance: what the change plan
 * classifies, what it refuses, and which obligations it names.
 *
 * Every classification here is derived from a real committed revision and, for
 * the obligation cases, from a real `DeliveryStore` snapshot rather than an
 * invented count.
 */

import { afterEach, describe, expect, it } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { DeliveryStore } from "../../../src/core/delivery-store.js";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import { ConsoleOperationError } from "../../../src/daemon/console/operation-catalog.js";
import {
  deliveryStoreObligations,
  noRecordedObligations,
} from "../../../src/daemon/console/instance-obligations.js";
import {
  createConsoleHarness,
  type ConsoleHarness,
} from "./fixtures/console-operations-harness.js";

const MODULE_CONFIG_REVISION = `sha256:${"b".repeat(64)}`;
const ACTOR = { principalId: "operator", interface: "cli" as const };

const harnesses: ConsoleHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function trackHarness(): ConsoleHarness {
  const harness = createConsoleHarness();
  harnesses.push(harness);
  return harness;
}

async function rejectedConsoleOperation(
  operation: Promise<unknown>,
): Promise<ConsoleOperationError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof ConsoleOperationError) return error;
    throw error;
  }
  throw new Error("expected the console operation to reject");
}

function moduleProposal(
  moduleId: string,
  inputPageIds: readonly string[],
  outputPageIds: readonly string[],
  overrides: Record<string, JsonValue> = {},
): JsonValue {
  return {
    moduleId,
    extensionId: "acme.summary",
    packageVersion: "1.0.0",
    moduleKind: "reactive-summary",
    isolation: "process",
    configurationReference: {
      configId: `${moduleId}-config`,
      revision: MODULE_CONFIG_REVISION,
      configVersion: 1,
    },
    permissionPolicyIds: [],
    inputPageIds: [...inputPageIds],
    outputPageIds: [...outputPageIds],
    activation: { kind: "reactive" },
    limits: {
      claim: { maxCount: 8, maxBytes: 65_536 },
      maxInputBytes: 1_048_576,
      maxResultBytes: 1_048_576,
      maxFrameBytes: 2_097_152,
      maxRunsPerGeneration: 100,
      maxGenerations: 10,
    },
    timeouts: {
      initializationTimeoutMs: 30_000,
      executionTimeoutMs: 60_000,
      cancellationGraceMs: 5_000,
      terminationTimeoutMs: 5_000,
    },
    ...overrides,
  } as JsonValue;
}

/** A real Page with one registered consumer and one pending Delivery. */
function deliveryStateWithPending(pageId: string, consumerId: string) {
  let blockId = 0;
  let runtimeId = 0;
  const blocks = new BlockStore({
    nextBlockId: () => `block-${++blockId}`,
    now: () => "2026-07-26T00:00:00.000Z",
  });
  const deliveries = new DeliveryStore({
    blocks,
    maxFailedAttempts: 3,
    nextId: (kind) => `${kind}-${++runtimeId}`,
    now: () => "2026-07-26T00:00:00.000Z",
  });
  deliveries.createPage(pageId);
  deliveries.registerConsumer(pageId, consumerId, "from-now");
  const block = blocks.commit(
    { payload: { schema: "test.content/1", value: { text: "pending" } } },
    { kind: "module", id: "producer" },
  );
  deliveries.append(pageId, block.id);
  return deliveries;
}

describe("TOPO-PLAN-001 cycles and self-connections are accepted", () => {
  it("commits a two-Module cycle and a Module whose output Page is also its input", async () => {
    const harness = trackHarness();
    harness.setObligations(noRecordedObligations({ moduleExecutionEnabled: true }));

    const result = await harness.operations.commitTopologyRevision({
      instanceId: harness.instanceId,
      expectedRevision: harness.currentRevision(),
      proposal: {
        pages: [{ pageId: "main" }, { pageId: "left" }, { pageId: "right" }, { pageId: "loop" }],
        modules: [
          moduleProposal("alpha", ["left"], ["right"]),
          moduleProposal("beta", ["right"], ["left"]),
          moduleProposal("echo", ["loop"], ["loop"]),
        ],
      },
      startPositions: [
        { moduleId: "alpha", pageId: "left", start: "from-now" },
        { moduleId: "beta", pageId: "right", start: "from-now" },
        { moduleId: "echo", pageId: "loop", start: "from-now" },
      ],
      operationId: "op-cycle",
      actor: ACTOR,
    });

    expect(result.plan.rejected).toBe(false);
    expect(harness.currentRevision()).toBe(result.newRevision);
    expect(harness.currentDocument().modules.map((module) => module.moduleId)).toEqual([
      "alpha",
      "beta",
      "echo",
    ]);
    // The self-connection is reported as an informational finding, never refused.
    const selfConnected = result.plan.entries.find(
      (entry) => entry.operation === "connection.selfConnected",
    );
    expect(selfConnected?.classification).toBe("informational");
    expect(result.plan.entries.some((entry) => entry.classification === "rejected")).toBe(false);
  });
});

describe("TOPO-PLAN-002 removing a Page with obligations", () => {
  it("refuses the removal and names the exact counts, then accepts a stated disposition", async () => {
    const harness = trackHarness();
    harness.setObligations(noRecordedObligations({ moduleExecutionEnabled: true }));
    const withNotes = await harness.operations.commitTopologyRevision({
      instanceId: harness.instanceId,
      expectedRevision: harness.currentRevision(),
      proposal: { pages: [{ pageId: "main" }, { pageId: "notes" }], modules: [] },
      operationId: "op-add-notes",
      actor: ACTOR,
    });

    const deliveries = deliveryStateWithPending("main", "consumer.summarizer");
    const obligations = deliveryStoreObligations(deliveries.snapshot(), {
      evidenceSource: "live-runtime",
      consumerIdForModule: (moduleId) => `consumer.${moduleId}`,
      moduleIds: [],
      moduleExecutionEnabled: true,
    });
    expect(obligations.pageConsumers).toEqual([
      expect.objectContaining({
        pageId: "main",
        consumerId: "consumer.summarizer",
        pendingDeliveries: 1,
      }),
    ]);
    harness.setObligations(obligations);

    const removal = {
      instanceId: harness.instanceId,
      expectedRevision: withNotes.newRevision,
      proposal: { pages: [{ pageId: "notes" }], modules: [] },
      operationId: "op-remove-main",
      actor: ACTOR,
    };

    await expect(harness.operations.commitTopologyRevision(removal)).rejects.toThrowError(
      expect.objectContaining({ code: "TOPOLOGY_PAGE_HAS_OBLIGATIONS" }),
    );
    expect(harness.currentRevision()).toBe(withNotes.newRevision);

    const plan = await harness.operations.planTopologyRevision({
      ...removal,
      dispositions: [{ pageId: "main", disposition: "dead-letter" }],
    });
    const entry = plan.entries.find((candidate) => candidate.operation === "page.remove")!;
    expect(entry.classification).toBe("breaking");
    expect(entry.disposition).toBe("dead-letter");
    expect(entry.obligations).toEqual({
      pendingDeliveries: 1,
      claimedDeliveries: 0,
      deadLetterRecords: 0,
      activeClaims: 0,
    });
    expect(plan.evidenceSource).toBe("live-runtime");
    expect(plan.requiresConfirmation).toBe(true);

    await expect(
      harness.operations.commitTopologyRevision({
        ...removal,
        dispositions: [{ pageId: "main", disposition: "dead-letter" }],
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "TOPOLOGY_CONFIRMATION_REQUIRED" }));
    expect(harness.currentRevision()).toBe(withNotes.newRevision);

    const committed = await harness.operations.commitTopologyRevision({
      ...removal,
      dispositions: [{ pageId: "main", disposition: "dead-letter" }],
      confirmedPlanDigest: plan.planDigest,
    });
    expect(harness.currentRevision()).toBe(committed.newRevision);
    expect(harness.currentDocument().pages.map((page) => page.pageId)).toEqual(["notes"]);
  });

  it("refuses a confirmation whose plan no longer matches the obligations", async () => {
    const harness = trackHarness();
    harness.setObligations(noRecordedObligations({ moduleExecutionEnabled: true }));
    const withNotes = await harness.operations.commitTopologyRevision({
      instanceId: harness.instanceId,
      expectedRevision: harness.currentRevision(),
      proposal: { pages: [{ pageId: "main" }, { pageId: "notes" }], modules: [] },
      operationId: "op-add-notes-2",
      actor: ACTOR,
    });

    const quiet = deliveryStateWithPending("main", "consumer.summarizer");
    harness.setObligations(
      deliveryStoreObligations(quiet.snapshot(), {
        evidenceSource: "live-runtime",
        consumerIdForModule: (moduleId) => `consumer.${moduleId}`,
        moduleIds: [],
        moduleExecutionEnabled: true,
      }),
    );
    const removal = {
      instanceId: harness.instanceId,
      expectedRevision: withNotes.newRevision,
      proposal: { pages: [{ pageId: "notes" }], modules: [] },
      dispositions: [{ pageId: "main", disposition: "dead-letter" as const }],
      operationId: "op-stale-plan",
      actor: ACTOR,
    };
    const plan = await harness.operations.planTopologyRevision(removal);

    // A second Delivery arrives while the operator reads the plan.
    const busier = deliveryStateWithPending("main", "consumer.summarizer");
    busier.append(
      "main",
      // Reuse the store's own committed Block so the append is real.
      busier.snapshot().deliveries[0]!.record.blockId,
    );
    harness.setObligations(
      deliveryStoreObligations(busier.snapshot(), {
        evidenceSource: "live-runtime",
        consumerIdForModule: (moduleId) => `consumer.${moduleId}`,
        moduleIds: [],
        moduleExecutionEnabled: true,
      }),
    );

    await expect(
      harness.operations.commitTopologyRevision({
        ...removal,
        confirmedPlanDigest: plan.planDigest,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "TOPOLOGY_PLAN_STALE" }));
    expect(harness.currentRevision()).toBe(withNotes.newRevision);
  });
});

describe("TOPO-PLAN-003 removing a Module", () => {
  async function harnessWithModule(): Promise<{ harness: ConsoleHarness; revision: string }> {
    const harness = trackHarness();
    harness.setObligations(noRecordedObligations({ moduleExecutionEnabled: true }));
    const committed = await harness.operations.commitTopologyRevision({
      instanceId: harness.instanceId,
      expectedRevision: harness.currentRevision(),
      proposal: {
        pages: [{ pageId: "main" }, { pageId: "notes" }],
        modules: [moduleProposal("summarizer", ["main"], ["notes"])],
      },
      startPositions: [{ moduleId: "summarizer", pageId: "main", start: "from-now" }],
      operationId: "op-seed-module",
      actor: ACTOR,
    });
    return { harness, revision: committed.newRevision };
  }

  it("refuses removal while the Module holds a Claim preserved as an unknown outcome", async () => {
    const { harness, revision } = await harnessWithModule();
    harness.setObligations(
      noRecordedObligations({
        evidenceSource: "live-runtime",
        moduleExecutionEnabled: true,
        modules: [
          {
            moduleId: "summarizer",
            consumerId: "consumer.summarizer",
            activeClaimTokens: ["claim-7"],
            unknownOutcomeClaimTokens: ["claim-7"],
            claimedPageIds: ["main"],
            generationTerminationProven: false,
          },
        ],
      }),
    );

    const attempt = harness.operations.commitTopologyRevision({
      instanceId: harness.instanceId,
      expectedRevision: revision,
      proposal: { pages: [{ pageId: "main" }, { pageId: "notes" }], modules: [] },
      modulePrivateStorage: [{ moduleId: "summarizer", decision: "retain" }],
      operationId: "op-remove-busy",
      actor: ACTOR,
    });
    await expect(attempt).rejects.toThrowError(
      expect.objectContaining({ code: "TOPOLOGY_UNKNOWN_OUTCOME_PRESENT" }),
    );
    expect(harness.currentRevision()).toBe(revision);
    // No audit event claims a released Claim.
    expect(
      harness.auditLog.some((event) =>
        event.eventType.startsWith("console.claim.unknown-outcome"),
      ),
    ).toBe(false);
    const refusal = harness.auditLog.find(
      (event) => event.eventType === "console.topology.commit" && event.result === "refused",
    );
    expect(refusal?.details?.failureCode).toBe("TOPOLOGY_UNKNOWN_OUTCOME_PRESENT");
  });

  it("requires an explicit Module-private storage decision and then classifies the removal breaking", async () => {
    const { harness, revision } = await harnessWithModule();
    harness.setObligations(
      noRecordedObligations({
        evidenceSource: "live-runtime",
        moduleExecutionEnabled: true,
        modules: [
          {
            moduleId: "summarizer",
            consumerId: "consumer.summarizer",
            activeClaimTokens: [],
            unknownOutcomeClaimTokens: [],
            claimedPageIds: [],
            generationTerminationProven: true,
          },
        ],
      }),
    );
    const removal = {
      instanceId: harness.instanceId,
      expectedRevision: revision,
      proposal: { pages: [{ pageId: "main" }, { pageId: "notes" }], modules: [] },
      operationId: "op-remove-module",
      actor: ACTOR,
    };

    await expect(harness.operations.commitTopologyRevision(removal)).rejects.toThrowError(
      expect.objectContaining({ code: "TOPOLOGY_STORAGE_DECISION_REQUIRED" }),
    );

    const plan = await harness.operations.planTopologyRevision({
      ...removal,
      modulePrivateStorage: [{ moduleId: "summarizer", decision: "delete" }],
    });
    const entry = plan.entries.find((candidate) => candidate.operation === "module.remove")!;
    expect(entry.classification).toBe("breaking");
    expect(entry.detail).toContain("not reversible");
    expect(plan.requiresConfirmation).toBe(true);

    const committed = await harness.operations.commitTopologyRevision({
      ...removal,
      modulePrivateStorage: [{ moduleId: "summarizer", decision: "delete" }],
      confirmedPlanDigest: plan.planDigest,
    });
    expect(harness.currentDocument().modules).toEqual([]);
    expect(harness.currentRevision()).toBe(committed.newRevision);
    const success = harness.auditLog.find(
      (event) =>
        event.eventType === "console.topology.commit" &&
        event.result === "succeeded" &&
        event.operationId === "op-remove-module",
    );
    expect(success).toBeDefined();
    expect(JSON.stringify(success?.details?.entries)).toContain("module.remove");
    expect(success?.newConfigRevision).toBe(committed.newRevision);
  });
});

describe("TOPO-PLAN-004 capability and ownership refusals", () => {
  it("names the disabled Module execution capability instead of calling the document invalid", async () => {
    const harness = trackHarness();
    harness.setObligations(noRecordedObligations({ moduleExecutionEnabled: false }));
    const attempt = harness.operations.commitTopologyRevision({
      instanceId: harness.instanceId,
      expectedRevision: harness.currentRevision(),
      proposal: {
        pages: [{ pageId: "main" }, { pageId: "notes" }],
        modules: [moduleProposal("summarizer", ["main"], ["notes"])],
      },
      startPositions: [{ moduleId: "summarizer", pageId: "main", start: "from-now" }],
      operationId: "op-disabled",
      actor: ACTOR,
    });
    const error = await rejectedConsoleOperation(attempt);
    expect(error.code).toBe("TOPOLOGY_CAPABILITY_DISABLED");
    expect(error.message).toContain("Module execution is disabled");
    expect(harness.currentDocument().modules).toEqual([]);
  });

  it("refuses a connection edit on a Module whose Page set another contract owns", async () => {
    const harness = trackHarness();
    harness.setObligations(noRecordedObligations({ moduleExecutionEnabled: true }));
    const seeded = await harness.operations.commitTopologyRevision({
      instanceId: harness.instanceId,
      expectedRevision: harness.currentRevision(),
      proposal: {
        pages: [{ pageId: "main" }, { pageId: "notes" }, { pageId: "extra" }],
        modules: [moduleProposal("console-ingress", ["main"], ["notes"])],
      },
      startPositions: [{ moduleId: "console-ingress", pageId: "main", start: "from-now" }],
      operationId: "op-seed-owned",
      actor: ACTOR,
    });

    harness.setObligations(
      noRecordedObligations({
        moduleExecutionEnabled: true,
        contractOwnedModules: [
          {
            moduleId: "console-ingress",
            owningContract: "console-extension.md Section 4.2",
            operation: "console route revision",
          },
        ],
      }),
    );

    const attempt = harness.operations.commitTopologyRevision({
      instanceId: harness.instanceId,
      expectedRevision: seeded.newRevision,
      proposal: {
        pages: [{ pageId: "main" }, { pageId: "notes" }, { pageId: "extra" }],
        modules: [moduleProposal("console-ingress", ["main"], ["notes", "extra"])],
      },
      operationId: "op-owned",
      actor: ACTOR,
    });
    const error = await rejectedConsoleOperation(attempt);
    expect(error.code).toBe("TOPOLOGY_OWNED_BY_ANOTHER_CONTRACT");
    expect(error.message).toContain("console-extension.md Section 4.2");
    expect(harness.currentRevision()).toBe(seeded.newRevision);
  });

  it("classifies a from-head subscription as breaking and states the backlog it creates", async () => {
    const harness = trackHarness();
    const deliveries = deliveryStateWithPending("main", "consumer.other");
    harness.setObligations(
      deliveryStoreObligations(deliveries.snapshot(), {
        evidenceSource: "live-runtime",
        consumerIdForModule: (moduleId) => `consumer.${moduleId}`,
        moduleIds: [],
        moduleExecutionEnabled: true,
      }),
    );

    const plan = await harness.operations.planTopologyRevision({
      instanceId: harness.instanceId,
      expectedRevision: harness.currentRevision(),
      proposal: {
        pages: [{ pageId: "main" }, { pageId: "notes" }],
        modules: [moduleProposal("summarizer", ["main"], ["notes"])],
      },
      startPositions: [{ moduleId: "summarizer", pageId: "main", start: "from-head" }],
    });

    const entry = plan.entries.find(
      (candidate) => candidate.operation === "connection.addInput",
    )!;
    expect(entry.classification).toBe("breaking");
    expect(entry.obligations?.immediatelyPendingDeliveries).toBe(1);
    expect(entry.detail).toContain("from-head");
  });

  it("refuses a checkpoint start the Page no longer retains", async () => {
    const harness = trackHarness();
    harness.setObligations(noRecordedObligations({ moduleExecutionEnabled: true }));
    const attempt = harness.operations.planTopologyRevision({
      instanceId: harness.instanceId,
      expectedRevision: harness.currentRevision(),
      proposal: {
        pages: [{ pageId: "main" }, { pageId: "notes" }],
        modules: [moduleProposal("summarizer", ["main"], ["notes"])],
      },
      startPositions: [
        { moduleId: "summarizer", pageId: "main", start: { checkpoint: "delivery-999" } },
      ],
    });
    await expect(attempt).rejects.toThrowError(
      expect.objectContaining({ code: "TOPOLOGY_CHECKPOINT_UNAVAILABLE" }),
    );
  });
});
