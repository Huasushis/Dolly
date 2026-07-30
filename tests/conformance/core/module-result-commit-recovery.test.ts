import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlockStore, type BlockProposal } from "../../../src/core/block-store.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { DeliveryStore } from "../../../src/core/delivery-store.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type { ModuleSubmissionRecord } from "../../../src/core/module-process-records.js";
import {
  InMemoryModuleResultCommitRepository,
  ModuleResultCommitCoordinator,
  ModuleResultCommitError,
  moduleJobResultDigest,
  type ModuleResultCommitRecord,
  type ModuleResultCommitOperations,
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
  const submissions = new Map<string, ModuleSubmissionRecord>([
    [
      claim.runId,
      {
        schemaVersion: "dolly.module-submission-record/1",
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
        processGenerationId: "worker-process-generation",
        inputDigest: canonicalJsonDigest(deliveries.inspectClaimInput(claim)),
        createdAt: NOW,
      },
    ],
  ]);
  return {
    blocks,
    deliveries,
    acknowledgeDeliveryClaim: (identity: Parameters<DeliveryStore["ack"]>[0]) => {
      const result = deliveries.ack(identity);
      const submission = submissions.get(identity.runId);
      if (
        submission?.moduleJobId === identity.moduleJobId &&
        submission.claimToken === identity.claimToken &&
        submission.runId === identity.runId &&
        submission.attempt === identity.attempt &&
        submission.moduleGenerationId === identity.moduleGenerationId
      ) {
        submissions.delete(identity.runId);
      }
      return result;
    },
    getModuleSubmissionRecord: (runId: string) => submissions.get(runId),
    removeModuleSubmissionRecord: () => {
      submissions.delete(claim.runId);
    },
    setModuleSubmissionRecord: (record: ModuleSubmissionRecord) => {
      submissions.set(record.runId, record);
    },
    claim,
    repository: new InMemoryModuleResultCommitRepository(),
  };
}

function buildPreparedRecord(
  harness: ReturnType<typeof createHarness>,
  options: {
    readonly blockProposal?: BlockProposal;
    readonly outputPageIds?: readonly string[];
  } = {},
): ModuleResultCommitRecord {
  const outputPageIds = options.outputPageIds ?? (
    options.blockProposal === undefined ? [] : ["output"]
  );
  const record: ModuleResultCommitRecord = {
    schemaVersion: "dolly.module-result-commit/1",
    moduleJobId: harness.claim.moduleJobId,
    claimToken: harness.claim.claimToken,
    runId: harness.claim.runId,
    attempt: harness.claim.attempt,
    moduleGenerationId: harness.claim.moduleGenerationId,
    resultDigest: moduleJobResultDigest({
      source,
      ...(options.blockProposal === undefined
        ? {}
        : { blockProposal: options.blockProposal }),
      outputPageIds,
    }),
    state: "prepared",
    revision: 1,
    source,
    outputPageIds,
    outputDeliveries: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...(options.blockProposal === undefined
      ? {}
      : { blockProposal: options.blockProposal }),
  };
  return record;
}

function createPreparedRecord(
  harness: ReturnType<typeof createHarness>,
  options: {
    readonly blockProposal?: BlockProposal;
    readonly outputPageIds?: readonly string[];
  } = {},
): ModuleResultCommitRecord {
  const record = buildPreparedRecord(harness, options);
  expect(harness.repository.createPrepared(record)).toBe("created");
  return record;
}

function blockEffectId(moduleJobId: string): string {
  return canonicalJsonDigest(["module-result-commit-block", moduleJobId]);
}

function deliveryEffectId(moduleJobId: string, pageId: string): string {
  return canonicalJsonDigest(["module-result-commit-delivery", moduleJobId, pageId]);
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

  it("rejects a new result without its Module submission record before creating effects", async () => {
    const harness = createHarness();
    harness.removeModuleSubmissionRecord();
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
    });
    const input = {
      moduleJobId: harness.claim.moduleJobId,
      claimToken: harness.claim.claimToken,
      runId: harness.claim.runId,
      attempt: harness.claim.attempt,
      moduleGenerationId: harness.claim.moduleGenerationId,
      source,
      outputPageIds: ["output"],
      blockProposal: proposal("must not be applied"),
    } as const;

    await expect(coordinator.commit(input)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(harness.claim.moduleJobId)).toBeNull();
    expect(harness.blocks.size).toBe(1);
    expect(
      harness.blocks.inspectCommitEffect(blockEffectId(harness.claim.moduleJobId)),
    ).toBeNull();
    expect(
      harness.deliveries.inspectAppendEffect(
        deliveryEffectId(harness.claim.moduleJobId, "output"),
      ),
    ).toBeNull();
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
  });

  it("rejects a malformed Module submission record before creating a journal or effect", async () => {
    const harness = createHarness();
    const validSubmission = harness.getModuleSubmissionRecord(
      harness.claim.runId,
    )!;
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      getModuleSubmissionRecord: () =>
        ({
          ...validSubmission,
          unexpected: true,
        }) as unknown as ModuleSubmissionRecord,
      now: () => NOW,
    });

    await expect(
      coordinator.commit({
        moduleJobId: harness.claim.moduleJobId,
        claimToken: harness.claim.claimToken,
        runId: harness.claim.runId,
        attempt: harness.claim.attempt,
        moduleGenerationId: harness.claim.moduleGenerationId,
        source,
        outputPageIds: ["output"],
        blockProposal: proposal("must not be applied"),
      }),
    ).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(harness.claim.moduleJobId)).toBeNull();
    expect(
      harness.blocks.inspectCommitEffect(blockEffectId(harness.claim.moduleJobId)),
    ).toBeNull();
    expect(
      harness.deliveries.inspectAppendEffect(
        deliveryEffectId(harness.claim.moduleJobId, "output"),
      ),
    ).toBeNull();
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
  });

  it("rejects a prepared result whose active Claim lost its Module submission record", async () => {
    const harness = createHarness();
    const prepared = createPreparedRecord(harness, {
      blockProposal: proposal("must remain unapplied"),
    });
    harness.removeModuleSubmissionRecord();
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
    });

    await expect(coordinator.recover(prepared.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(prepared.moduleJobId)).toEqual(prepared);
    expect(harness.blocks.size).toBe(1);
    expect(
      harness.blocks.inspectCommitEffect(blockEffectId(prepared.moduleJobId)),
    ).toBeNull();
    expect(
      harness.deliveries.inspectAppendEffect(
        deliveryEffectId(prepared.moduleJobId, "output"),
      ),
    ).toBeNull();
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
  });

  it("rejects a prepared result whose output Page is missing before creating a Block effect", async () => {
    const harness = createHarness();
    const prepared = createPreparedRecord(harness, {
      blockProposal: proposal("missing output Page"),
      outputPageIds: ["missing-output"],
    });
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
    });

    await expect(coordinator.recover(prepared.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(prepared.moduleJobId)).toEqual(prepared);
    expect(
      harness.blocks.inspectCommitEffect(blockEffectId(prepared.moduleJobId)),
    ).toBeNull();
    expect(harness.blocks.size).toBe(1);
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();
  });

  it("rejects a prepared result whose Block proposal is no longer valid before creating an effect", async () => {
    const harness = createHarness();
    const oversizedProposal: BlockProposal = {
      payload: {
        schema: "application/json",
        value: "x".repeat(1_048_577),
      },
    };
    const prepared = createPreparedRecord(harness, {
      blockProposal: oversizedProposal,
    });
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
    });

    await expect(coordinator.recover(prepared.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(prepared.moduleJobId)).toEqual(prepared);
    expect(
      harness.blocks.inspectCommitEffect(blockEffectId(prepared.moduleJobId)),
    ).toBeNull();
    expect(harness.blocks.size).toBe(1);
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();
  });

  it("rejects a no-Block result when its Module job already has a Block effect", async () => {
    const harness = createHarness();
    const prepared = createPreparedRecord(harness);
    const effectId = blockEffectId(prepared.moduleJobId);
    harness.blocks.commitOnce(
      effectId,
      proposal("unexpected Block effect"),
      source,
    );
    let acknowledgementCalls = 0;
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      acknowledgeDeliveryClaim: (identity) => {
        acknowledgementCalls += 1;
        return harness.acknowledgeDeliveryClaim(identity);
      },
      now: () => NOW,
    });

    await expect(coordinator.recover(prepared.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(acknowledgementCalls).toBe(0);
    expect(harness.repository.get(prepared.moduleJobId)).toEqual(prepared);
    expect(harness.blocks.inspectCommitEffect(effectId)).toMatchObject({
      strongReferenceHeld: true,
    });
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();
  });

  it("rejects an output Delivery effect that precedes its Block journal entry", async () => {
    const harness = createHarness();
    const prepared = createPreparedRecord(harness, {
      blockProposal: proposal("must not be committed"),
    });
    const unrelatedBlock = harness.blocks.commit(
      proposal("preexisting output"),
      source,
    );
    harness.deliveries.appendOnce(
      deliveryEffectId(prepared.moduleJobId, "output"),
      "output",
      unrelatedBlock.id,
    );
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
    });

    await expect(coordinator.recover(prepared.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(prepared.moduleJobId)).toEqual(prepared);
    expect(
      harness.blocks.inspectCommitEffect(blockEffectId(prepared.moduleJobId)),
    ).toBeNull();
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();
  });

  it("rejects a new result when its Module job already has a Delivery effect for an undeclared Page", async () => {
    const harness = createHarness();
    harness.deliveries.createPage("undeclared-output");
    const unrelatedBlock = harness.blocks.commit(
      proposal("preexisting undeclared output"),
      source,
    );
    harness.deliveries.appendOnce(
      deliveryEffectId(harness.claim.moduleJobId, "undeclared-output"),
      "undeclared-output",
      unrelatedBlock.id,
    );
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
    });

    await expect(
      coordinator.commit({
        moduleJobId: harness.claim.moduleJobId,
        claimToken: harness.claim.claimToken,
        runId: harness.claim.runId,
        attempt: harness.claim.attempt,
        moduleGenerationId: harness.claim.moduleGenerationId,
        source,
        outputPageIds: ["output"],
        blockProposal: proposal("must not be committed"),
      }),
    ).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(harness.claim.moduleJobId)).toBeNull();
    expect(
      harness.blocks.inspectCommitEffect(blockEffectId(harness.claim.moduleJobId)),
    ).toBeNull();
    expect(
      harness.deliveries.inspectAppendEffect(
        deliveryEffectId(harness.claim.moduleJobId, "output"),
      ),
    ).toBeNull();
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();
  });

  it("rejects recovery of a no-Block result with a Delivery effect for an undeclared Page", async () => {
    const harness = createHarness();
    harness.deliveries.createPage("undeclared-output");
    const prepared = createPreparedRecord(harness);
    const unrelatedBlock = harness.blocks.commit(
      proposal("preexisting undeclared output"),
      source,
    );
    harness.deliveries.appendOnce(
      deliveryEffectId(prepared.moduleJobId, "undeclared-output"),
      "undeclared-output",
      unrelatedBlock.id,
    );
    let acknowledgementCalls = 0;
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      acknowledgeDeliveryClaim: (identity) => {
        acknowledgementCalls += 1;
        return harness.acknowledgeDeliveryClaim(identity);
      },
      now: () => NOW,
    });

    await expect(coordinator.recover(prepared.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(acknowledgementCalls).toBe(0);
    expect(harness.repository.get(prepared.moduleJobId)).toEqual(prepared);
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();
  });

  it("rejects a Delivery effect whose identity names a different Page than its target", async () => {
    const harness = createHarness();
    harness.deliveries.createPage("undeclared-output");
    const prepared = createPreparedRecord(harness, {
      blockProposal: proposal("must remain unapplied"),
    });
    const unrelatedBlock = harness.blocks.commit(
      proposal("preexisting mismatched output"),
      source,
    );
    harness.deliveries.appendOnce(
      deliveryEffectId(prepared.moduleJobId, "output"),
      "undeclared-output",
      unrelatedBlock.id,
    );
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
    });

    await expect(coordinator.recover(prepared.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(prepared.moduleJobId)).toEqual(prepared);
    expect(
      harness.blocks.inspectCommitEffect(blockEffectId(prepared.moduleJobId)),
    ).toBeNull();
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();
  });

  it("accepts a matching journal created concurrently with its first effect check", async () => {
    const harness = createHarness();
    const blockProposal = proposal("concurrent result");
    const prepared = buildPreparedRecord(harness, { blockProposal });
    const effectId = blockEffectId(prepared.moduleJobId);
    let inserted = false;
    const concurrentBlocks = new Proxy(harness.blocks, {
      get(target, property) {
        if (property === "inspectCommitEffect") {
          return (requestedEffectId: string) => {
            if (!inserted && requestedEffectId === effectId) {
              inserted = true;
              expect(harness.repository.createPrepared(prepared)).toBe("created");
              target.commitOnce(effectId, blockProposal, source);
            }
            return target.inspectCommitEffect(requestedEffectId);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      blocks: concurrentBlocks,
      now: () => NOW,
    });

    await expect(
      coordinator.commit({
        moduleJobId: harness.claim.moduleJobId,
        claimToken: harness.claim.claimToken,
        runId: harness.claim.runId,
        attempt: harness.claim.attempt,
        moduleGenerationId: harness.claim.moduleGenerationId,
        source,
        outputPageIds: ["output"],
        blockProposal,
      }),
    ).resolves.toMatchObject({
      state: "committed",
      blockId: "block-2",
      outputDeliveries: [{ pageId: "output" }],
    });
    expect(inserted).toBe(true);
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("committed");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeUndefined();
  });

  it.each([
    ["colliding Block identifiers", "block"],
    ["different Block identifiers", "other-block"],
  ] as const)(
    "rejects different Block and Delivery stores with %s before creating effects",
    async (_description, blockIdPrefix) => {
      const harness = createHarness();
      let blockId = 0;
      const otherBlocks = new BlockStore({
        nextBlockId: () => `${blockIdPrefix}-${++blockId}`,
        now: () => NOW,
      });

      expect(
        () =>
          new ModuleResultCommitCoordinator({
            ...harness,
            blocks: otherBlocks,
            now: () => NOW,
          }),
      ).toThrowError(
        new TypeError(
          "Module result commit requires its Block and Delivery operations to use the same Block store",
        ),
      );
      expect(otherBlocks.size).toBe(0);
      expect(harness.blocks.size).toBe(1);
      expect(
        otherBlocks.inspectCommitEffect(
          blockEffectId(harness.claim.moduleJobId),
        ),
      ).toBeNull();
      expect(
        harness.deliveries.inspectAppendEffect(
          deliveryEffectId(harness.claim.moduleJobId, "output"),
        ),
      ).toBeNull();
      expect(harness.repository.get(harness.claim.moduleJobId)).toBeNull();
      expect(harness.deliveries.inspectClaim(harness.claim).status).toBe(
        "active",
      );
    },
  );

  it("rejects a prepared result whose existing Block effect no longer holds its reference", async () => {
    const harness = createHarness();
    let injected = false;
    const crashing = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
      afterEffect: (event) => {
        if (!injected && event.phase === "after-block-effect") {
          injected = true;
          throw new Error("injected after-block-effect");
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
      blockProposal: proposal("released Block effect"),
    } as const;

    await expect(crashing.commit(input)).rejects.toThrow("injected after-block-effect");
    const prepared = harness.repository.get(harness.claim.moduleJobId)!;
    expect(prepared).toMatchObject({
      state: "prepared",
      outputDeliveries: [],
    });
    expect(prepared.blockId).toBeUndefined();
    const effectId = blockEffectId(prepared.moduleJobId);
    expect(harness.blocks.inspectCommitEffect(effectId)).toMatchObject({
      strongReferenceHeld: true,
    });
    expect(harness.blocks.releaseCommitEffect(effectId)).toBe("released");
    expect(harness.blocks.inspectCommitEffect(effectId)).toMatchObject({
      strongReferenceHeld: false,
    });

    const recovering = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
    });
    await expect(recovering.recover(prepared.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(prepared.moduleJobId)).toEqual(prepared);
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();
    expect(
      harness.deliveries.inspectAppendEffect(
        deliveryEffectId(prepared.moduleJobId, "output"),
      ),
    ).toBeNull();
  });

  it("confirms that acknowledgement committed the exact Claim before advancing", async () => {
    const harness = createHarness();
    const noOpAcknowledgement = new ModuleResultCommitCoordinator({
      ...harness,
      acknowledgeDeliveryClaim: () => "committed",
      now: () => NOW,
    });
    const input = {
      moduleJobId: harness.claim.moduleJobId,
      claimToken: harness.claim.claimToken,
      runId: harness.claim.runId,
      attempt: harness.claim.attempt,
      moduleGenerationId: harness.claim.moduleGenerationId,
      source,
      outputPageIds: ["output"],
      blockProposal: proposal("unconfirmed acknowledgement"),
    } as const;

    await expect(noOpAcknowledgement.commit(input)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    const prepared = harness.repository.get(harness.claim.moduleJobId)!;
    expect(prepared.state).toBe("prepared");
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();

    expect(harness.repository.compareAndSet(
      prepared.moduleJobId,
      prepared.revision,
      {
        ...prepared,
        state: "committed",
        revision: prepared.revision + 1,
      },
    )).toBe(true);
    await expect(
      noOpAcknowledgement.recover(harness.claim.moduleJobId),
    ).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");

    let acknowledgementCalls = 0;
    const correctlyWired = new ModuleResultCommitCoordinator({
      ...harness,
      acknowledgeDeliveryClaim: (identity) => {
        acknowledgementCalls += 1;
        return harness.acknowledgeDeliveryClaim(identity);
      },
      now: () => NOW,
    });
    await expect(correctlyWired.recover(harness.claim.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(acknowledgementCalls).toBe(0);
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();
  });

  it.each([
    [
      "Promise",
      () => Promise.resolve("committed"),
    ],
    [
      "custom thenable",
      () => ({ then: () => undefined }),
    ],
  ])(
    "rejects an acknowledgement that returns a %s as an operation contract violation",
    async (_label, acknowledge) => {
      const harness = createHarness();
      const coordinator = new ModuleResultCommitCoordinator({
        ...harness,
        acknowledgeDeliveryClaim: acknowledge as unknown as
          ModuleResultCommitOperations["acknowledgeDeliveryClaim"],
        now: () => NOW,
      });

      await expect(
        coordinator.commit({
          moduleJobId: harness.claim.moduleJobId,
          claimToken: harness.claim.claimToken,
          runId: harness.claim.runId,
          attempt: harness.claim.attempt,
          moduleGenerationId: harness.claim.moduleGenerationId,
          source,
          outputPageIds: [],
        }),
      ).rejects.toMatchObject({
        code: "MODULE_RESULT_OPERATION_CONTRACT_VIOLATION",
      });
      expect(harness.repository.get(harness.claim.moduleJobId)).toMatchObject({
        state: "prepared",
      });
      expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
      expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();
    },
  );

  it("rejects acknowledgement that commits the Claim but leaves its submission record", async () => {
    const harness = createHarness();
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      acknowledgeDeliveryClaim: (identity) => harness.deliveries.ack(identity),
      now: () => NOW,
    });

    await expect(
      coordinator.commit({
        moduleJobId: harness.claim.moduleJobId,
        claimToken: harness.claim.claimToken,
        runId: harness.claim.runId,
        attempt: harness.claim.attempt,
        moduleGenerationId: harness.claim.moduleGenerationId,
        source,
        outputPageIds: ["output"],
        blockProposal: proposal("submission must also be removed"),
      }),
    ).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(harness.claim.moduleJobId)).toMatchObject({
      state: "prepared",
      outputDeliveries: [{ pageId: "output" }],
    });
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("committed");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeDefined();
  });

  it("rejects acknowledgement that removes the submission but leaves the Claim active", async () => {
    const harness = createHarness();
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      acknowledgeDeliveryClaim: () => {
        harness.removeModuleSubmissionRecord();
        return "committed";
      },
      now: () => NOW,
    });

    await expect(
      coordinator.commit({
        moduleJobId: harness.claim.moduleJobId,
        claimToken: harness.claim.claimToken,
        runId: harness.claim.runId,
        attempt: harness.claim.attempt,
        moduleGenerationId: harness.claim.moduleGenerationId,
        source,
        outputPageIds: ["output"],
        blockProposal: proposal("Claim must also be committed"),
      }),
    ).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(harness.claim.moduleJobId)).toMatchObject({
      state: "prepared",
      outputDeliveries: [{ pageId: "output" }],
    });
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeUndefined();
  });

  it("revalidates the submission after the Block effect hook before appending output", async () => {
    const harness = createHarness();
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
      afterEffect: (event) => {
        if (event.phase !== "after-block-effect") return;
        const submission = harness.getModuleSubmissionRecord(harness.claim.runId)!;
        harness.setModuleSubmissionRecord({
          ...submission,
          inputDigest: `sha256:${"f".repeat(64)}`,
        });
      },
    });

    await expect(
      coordinator.commit({
        moduleJobId: harness.claim.moduleJobId,
        claimToken: harness.claim.claimToken,
        runId: harness.claim.runId,
        attempt: harness.claim.attempt,
        moduleGenerationId: harness.claim.moduleGenerationId,
        source,
        outputPageIds: ["output"],
        blockProposal: proposal("do not append after submission tampering"),
      }),
    ).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(harness.repository.get(harness.claim.moduleJobId)).toMatchObject({
      state: "prepared",
      blockId: "block-2",
      outputDeliveries: [],
    });
    expect(
      harness.deliveries.inspectAppendEffect(
        deliveryEffectId(harness.claim.moduleJobId, "output"),
      ),
    ).toBeNull();
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("active");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toMatchObject({
      inputDigest: `sha256:${"f".repeat(64)}`,
    });
  });

  it("finishes a prepared journal after acknowledgement only when every effect is complete", async () => {
    const harness = createHarness();
    let injected = false;
    const crashing = new ModuleResultCommitCoordinator({
      ...harness,
      now: () => NOW,
      afterEffect: (event) => {
        if (!injected && event.phase === "after-ack-effect") {
          injected = true;
          throw new Error("injected after-ack-effect");
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
      blockProposal: proposal("complete effects"),
    } as const;

    await expect(crashing.commit(input)).rejects.toThrow("injected after-ack-effect");
    const prepared = harness.repository.get(harness.claim.moduleJobId)!;
    expect(prepared).toMatchObject({
      state: "prepared",
      blockId: expect.any(String),
      outputDeliveries: [{ pageId: "output", deliveryId: expect.any(String) }],
    });
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("committed");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeUndefined();
    const blockCount = harness.blocks.size;
    const blockEffectBefore = harness.blocks.inspectCommitEffect(
      blockEffectId(harness.claim.moduleJobId),
    );
    const deliveryEffectBefore = harness.deliveries.inspectAppendEffect(
      deliveryEffectId(harness.claim.moduleJobId, "output"),
    );
    expect(blockEffectBefore).not.toBeNull();
    expect(deliveryEffectBefore).not.toBeNull();

    let acknowledgementCalls = 0;
    const recovering = new ModuleResultCommitCoordinator({
      ...harness,
      acknowledgeDeliveryClaim: (identity) => {
        acknowledgementCalls += 1;
        return harness.acknowledgeDeliveryClaim(identity);
      },
      now: () => NOW,
    });
    await expect(recovering.recover(harness.claim.moduleJobId)).resolves.toMatchObject({
      state: "committed",
      blockId: prepared.blockId,
      outputDeliveries: prepared.outputDeliveries,
      revision: prepared.revision + 1,
    });

    expect(acknowledgementCalls).toBe(0);
    expect(harness.blocks.size).toBe(blockCount);
    expect(
      harness.blocks.inspectCommitEffect(blockEffectId(harness.claim.moduleJobId)),
    ).toMatchObject({
      record: { id: prepared.blockId },
    });
    expect(
      harness.deliveries.inspectAppendEffect(
        deliveryEffectId(harness.claim.moduleJobId, "output"),
      ),
    ).toEqual(deliveryEffectBefore);
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("committed");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeUndefined();
  });

  it("does not create missing effects for a prepared journal after acknowledgement", async () => {
    const harness = createHarness();
    const prepared = createPreparedRecord(harness, {
      blockProposal: proposal("incomplete effects"),
    });
    expect(harness.acknowledgeDeliveryClaim(harness.claim)).toBe("committed");
    expect(harness.getModuleSubmissionRecord(harness.claim.runId)).toBeUndefined();
    let acknowledgementCalls = 0;
    const coordinator = new ModuleResultCommitCoordinator({
      ...harness,
      acknowledgeDeliveryClaim: (identity) => {
        acknowledgementCalls += 1;
        return harness.acknowledgeDeliveryClaim(identity);
      },
      now: () => NOW,
    });

    await expect(coordinator.recover(prepared.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
    });
    expect(acknowledgementCalls).toBe(0);
    expect(harness.repository.get(prepared.moduleJobId)).toEqual(prepared);
    expect(harness.blocks.size).toBe(1);
    expect(
      harness.blocks.inspectCommitEffect(blockEffectId(prepared.moduleJobId)),
    ).toBeNull();
    expect(
      harness.deliveries.inspectAppendEffect(
        deliveryEffectId(prepared.moduleJobId, "output"),
      ),
    ).toBeNull();
    expect(harness.deliveries.inspectClaim(harness.claim).status).toBe("committed");
  });

  it.each([
    ["after-delivery-effect", "active", true],
    ["after-ack-effect", "committed", false],
  ] as const)(
    "persists only active Claim plus submission or committed Claim without submission at %s",
    async (phase, expectedClaimStatus, expectsSubmission) => {
      const root = mkdtempSync(join(tmpdir(), "dolly-result-commit-ack-"));
      const statePath = join(root, "core-state.json");
      const journalPath = join(root, "module-result-commits.json");
      const moduleGenerationId = "worker-generation";
      const processGenerationId = "process-generation-1";
      const invocationId = "2812432ad29e4d3bbd6776c62cafa929";
      const bootId = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";

      function openCore(prefix: string): FileCoreStateStore {
        let blockId = 0;
        let runtimeId = 0;
        return new FileCoreStateStore({
          path: statePath,
          maxFailedAttempts: 3,
          nextBlockId: () => `${prefix}-block-${++blockId}`,
          nextDeliveryId: (kind) => `${prefix}-${kind}-${++runtimeId}`,
          now: () => NOW,
        });
      }

      try {
        const core = openCore("initial");
        core.deliveries.createPage("input");
        core.deliveries.createPage("output");
        core.deliveries.registerConsumer("input", "worker", "from-now");
        const inputBlock = core.blocks.commit(proposal("input"), {
          kind: "external",
          id: "console",
        });
        core.deliveries.append("input", inputBlock.id);
        const claim = core.deliveries.claim({
          consumerId: "worker",
          pageIds: ["input"],
          moduleGenerationId,
          maxCount: 1,
          maxBytes: 1024 * 1024,
        })!;
        core.appendModuleProcessRecord({
          schemaVersion: "dolly.module-process-record/1",
          instanceId: "instance-1",
          moduleId: "worker",
          moduleGenerationId,
          processGenerationId,
          packageDigest: `sha256:${"a".repeat(64)}`,
          configurationReference: {
            configId: "config-1",
            revision: `sha256:${"b".repeat(64)}`,
            configVersion: 1,
          },
          declaredExternalEffects: "core-capabilities-only",
          serviceInvocationId: invocationId,
          bootId,
          moduleCgroupPath: deriveModuleCgroupPath(
            "/system.slice/dolly-core.service",
            {
              instanceId: "instance-1",
              moduleId: "worker",
              processGenerationId,
            },
          ).filesystemPath,
          state: "starting",
          createdAt: NOW,
          updatedAt: NOW,
        });
        core.updateModuleProcessRecordState(processGenerationId, "running");
        core.appendModuleSubmissionRecord({
          schemaVersion: "dolly.module-submission-record/1",
          moduleJobId: claim.moduleJobId,
          claimToken: claim.claimToken,
          runId: claim.runId,
          attempt: claim.attempt,
          moduleGenerationId,
          processGenerationId,
          inputDigest: canonicalJsonDigest(core.deliveries.inspectClaimInput(claim)),
          createdAt: NOW,
        });

        const repository = new FileModuleResultCommitRepository({ path: journalPath });
        let injected = false;
        let revisionBeforeAcknowledgement: number | undefined;
        const crashing = new ModuleResultCommitCoordinator({
          blocks: core.blocks,
          deliveries: core.deliveries,
          acknowledgeDeliveryClaim: (identity) =>
            core.acknowledgeDeliveryClaim(identity),
          getModuleSubmissionRecord: (runId) =>
            core.getModuleSubmissionRecord(runId),
          repository,
          now: () => NOW,
          afterEffect: (event) => {
            if (event.phase === "after-delivery-effect") {
              revisionBeforeAcknowledgement = core.revision;
            }
            if (!injected && event.phase === phase) {
              injected = true;
              throw new Error(`injected ${phase}`);
            }
          },
        });
        await expect(
          crashing.commit({
            moduleJobId: claim.moduleJobId,
            claimToken: claim.claimToken,
            runId: claim.runId,
            attempt: claim.attempt,
            moduleGenerationId,
            source,
            outputPageIds: ["output"],
            blockProposal: proposal("persisted output"),
          }),
        ).rejects.toThrow(`injected ${phase}`);

        const afterFailure = openCore("after-failure");
        expect(revisionBeforeAcknowledgement).toBeDefined();
        expect(afterFailure.revision).toBe(
          revisionBeforeAcknowledgement! + (phase === "after-ack-effect" ? 1 : 0),
        );
        expect(afterFailure.deliveries.inspectClaim(claim).status).toBe(
          expectedClaimStatus,
        );
        expect(
          afterFailure.getModuleSubmissionRecord(claim.runId) !== undefined,
        ).toBe(expectsSubmission);
        expect(repository.get(claim.moduleJobId)?.state).toBe("prepared");
        const revisionBeforeRecovery = afterFailure.revision;

        const recovered = new ModuleResultCommitCoordinator({
          blocks: afterFailure.blocks,
          deliveries: afterFailure.deliveries,
          acknowledgeDeliveryClaim: (identity) =>
            afterFailure.acknowledgeDeliveryClaim(identity),
          getModuleSubmissionRecord: (runId) =>
            afterFailure.getModuleSubmissionRecord(runId),
          repository: new FileModuleResultCommitRepository({ path: journalPath }),
          now: () => NOW,
        });
        await expect(recovered.recover(claim.moduleJobId)).resolves.toMatchObject({
          state: "committed",
          moduleJobId: claim.moduleJobId,
        });

        const afterRecovery = openCore("after-recovery");
        expect(afterRecovery.revision).toBe(
          revisionBeforeRecovery + (phase === "after-delivery-effect" ? 2 : 1),
        );
        expect(afterRecovery.deliveries.inspectClaim(claim).status).toBe("committed");
        expect(afterRecovery.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
