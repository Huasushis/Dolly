import { describe, expect, it } from "vitest";
import { BlockStore, type BlockProposal } from "../../../src/core/block-store.js";
import { DeliveryStore } from "../../../src/core/delivery-store.js";
import {
  InMemoryModuleResultCommitRepository,
  ModuleResultCommitCoordinator,
  ModuleResultCommitError,
} from "../../../src/core/module-result-commit.js";

const NOW = "2026-07-24T00:00:00.000Z";
const source = { kind: "module", id: "worker" } as const;

function proposal(text: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "text", text, format: "plain" }] },
    },
  };
}

function createHarness() {
  let blockId = 0;
  let runtimeId = 0;
  const blocks = new BlockStore({
    nextBlockId: () => `block-${++blockId}`,
    now: () => NOW,
  });
  const deliveries = new DeliveryStore({
    blocks,
    maxFailedAttempts: 3,
    nextId: (kind) => `${kind}-${++runtimeId}`,
    now: () => NOW,
  });
  deliveries.createPage("input");
  deliveries.createPage("output");
  deliveries.registerConsumer("input", "worker", "from-now");
  deliveries.registerConsumer("output", "sink", "from-now");
  const inputBlock = blocks.commit(proposal("input"), {
    kind: "external",
    id: "console",
  });
  deliveries.append("input", inputBlock.id);
  const claim = deliveries.claim({
    consumerId: "worker",
    pageIds: ["input"],
    moduleGenerationId: "worker-generation",
    maxCount: 1,
    maxBytes: 1024 * 1024,
  })!;
  return {
    blocks,
    deliveries,
    claim,
    repository: new InMemoryModuleResultCommitRepository(),
  };
}

describe("CORE-004 recoverable output commit", () => {
  it.each([
    "after-block-effect",
    "after-delivery-effect",
    "after-ack-effect",
  ] as const)("recovers interruption at %s without rerunning or duplicating", async (phase) => {
    const harness = createHarness();
    let injected = false;
    const crashing = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
      afterEffect: (event) => {
        if (!injected && event.phase === phase) {
          injected = true;
          throw new Error(`injected ${phase}`);
        }
      },
    });
    const input = {
      moduleJobId: harness.claim.moduleJobId,
      claimToken: harness.claim.claimToken,
      runId: harness.claim.runId,
      attempt: harness.claim.attempt,
      moduleGenerationId: harness.claim.moduleGenerationId,
      source,
      outputPageIds: ["output"],
      blockProposal: proposal("one output"),
    } as const;

    await expect(crashing.commit(input)).rejects.toThrow(`injected ${phase}`);
    expect(harness.repository.get(harness.claim.moduleJobId)).toMatchObject({
      state: "prepared",
      resultDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(harness.blocks.size).toBe(2);
    expect(
      harness.blocks.referenceGraph.strongReferenceCountFor({ kind: "block", id: "block-2" }),
    ).toBeGreaterThan(0);

    const recovered = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
    });
    const result = await recovered.recover(harness.claim.moduleJobId);
    expect(result).toMatchObject({
      state: "committed",
      moduleJobId: harness.claim.moduleJobId,
      runId: harness.claim.runId,
      attempt: harness.claim.attempt,
      moduleGenerationId: harness.claim.moduleGenerationId,
      blockId: "block-2",
      outputDeliveries: [{ pageId: "output" }],
    });
    expect(
      harness.deliveries.inspectClaim({
        moduleJobId: harness.claim.moduleJobId,
        claimToken: harness.claim.claimToken,
        runId: harness.claim.runId,
        attempt: harness.claim.attempt,
        moduleGenerationId: harness.claim.moduleGenerationId,
      }).status,
    ).toBe("committed");
    expect(
      harness.blocks.referenceGraph.strongReferenceCountFor({ kind: "block", id: "block-2" }),
    ).toBe(1);

    await expect(recovered.commit(input)).resolves.toMatchObject({
      state: "committed",
      blockId: "block-2",
    });
    expect(harness.blocks.size).toBe(2);

    const output = harness.deliveries.claim({
      consumerId: "sink",
      pageIds: ["output"],
      moduleGenerationId: "sink-generation",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    })!;
    expect(output.deliveryIds).toEqual([result.outputDeliveries[0]!.deliveryId]);
    expect(output.blockGroups).toHaveLength(1);
    expect(output.blockGroups[0]!.block.id).toBe("block-2");
    harness.deliveries.ack({
      moduleJobId: output.moduleJobId,
      claimToken: output.claimToken,
      runId: output.runId,
      attempt: output.attempt,
      moduleGenerationId: "sink-generation",
    });
    expect(
      harness.deliveries.claim({
        consumerId: "sink",
        pageIds: ["output"],
        moduleGenerationId: "sink-generation",
        maxCount: 10,
        maxBytes: 1024 * 1024,
      }),
    ).toBeNull();

    expect(harness.deliveries.pruneTerminal("input")).toBe(1);
    expect(harness.deliveries.pruneTerminal("output")).toBe(1);
    expect(harness.blocks.collectUnreachable()).toHaveLength(2);
    await expect(recovered.commit(input)).resolves.toMatchObject({
      state: "committed",
      blockId: "block-2",
    });
    expect(harness.blocks.size).toBe(0);
  });

  it("rejects a conflicting result for the same Module job", async () => {
    const harness = createHarness();
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
    });
    const base = {
      moduleJobId: harness.claim.moduleJobId,
      claimToken: harness.claim.claimToken,
      runId: harness.claim.runId,
      attempt: harness.claim.attempt,
      moduleGenerationId: harness.claim.moduleGenerationId,
      source,
      outputPageIds: ["output"],
    } as const;
    await coordinator.commit({ ...base, blockProposal: proposal("first") });

    await expect(
      coordinator.commit({ ...base, blockProposal: proposal("different") }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ModuleResultCommitError>>({
        code: "MODULE_JOB_RESULT_CONFLICT",
      }),
    );
    expect(harness.blocks.size).toBe(2);
  });

  it("commits an explicit no-Block result but forbids output Pages", async () => {
    const harness = createHarness();
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
    });
    const identity = {
      moduleJobId: harness.claim.moduleJobId,
      claimToken: harness.claim.claimToken,
      runId: harness.claim.runId,
      attempt: harness.claim.attempt,
      moduleGenerationId: harness.claim.moduleGenerationId,
      source,
    } as const;

    await expect(
      coordinator.commit({ ...identity, outputPageIds: ["output"] }),
    ).rejects.toMatchObject({ code: "MODULE_JOB_OUTPUT_INVALID" });
    await expect(
      coordinator.commit({ ...identity, outputPageIds: [] }),
    ).resolves.toMatchObject({
      state: "committed",
      outputDeliveries: [],
    });
    expect(harness.blocks.size).toBe(1);
  });

  it("rejects repository field tampering and multi-effect revision jumps", async () => {
    const harness = createHarness();
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
      afterEffect: (event) => {
        if (event.phase === "after-block-effect") throw new Error("interrupt");
      },
    });
    const input = {
      moduleJobId: harness.claim.moduleJobId,
      claimToken: harness.claim.claimToken,
      runId: harness.claim.runId,
      attempt: harness.claim.attempt,
      moduleGenerationId: harness.claim.moduleGenerationId,
      source,
      outputPageIds: ["output"],
      blockProposal: proposal("journal"),
    } as const;
    await expect(coordinator.commit(input)).rejects.toThrow("interrupt");
    const prepared = harness.repository.get(harness.claim.moduleJobId)!;

    expect(() =>
      harness.repository.compareAndSet(prepared.moduleJobId, prepared.revision, {
        ...prepared,
        revision: prepared.revision + 1,
        source: { kind: "module", id: "forged-source" },
      }),
    ).toThrowError(expect.objectContaining<Partial<ModuleResultCommitError>>({
      code: "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
    }));
    expect(() =>
      harness.repository.compareAndSet(prepared.moduleJobId, prepared.revision, {
        ...prepared,
        revision: prepared.revision + 1,
        state: "committed",
        blockId: "block-forged",
        outputDeliveries: [{ pageId: "output", deliveryId: "delivery-forged" }],
      }),
    ).toThrowError(expect.objectContaining<Partial<ModuleResultCommitError>>({
      code: "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
    }));

    const separate = new InMemoryModuleResultCommitRepository();
    expect(() => separate.createPrepared({ ...prepared, blockId: "block-forged" })).toThrowError(
      expect.objectContaining<Partial<ModuleResultCommitError>>({
        code: "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      }),
    );
    expect(harness.repository.get(prepared.moduleJobId)).toEqual(prepared);
  });
});
