import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type BlockProposal } from "../../../src/core/block-store.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import { createModuleResultCommitCoordinator } from "../../../src/core/module-result-commit-factory.js";
import {
  InMemoryModuleResultCommitRepository,
  type ModuleResultCommitInput,
} from "../../../src/core/module-result-commit.js";

const NOW = "2026-08-09T00:00:00.000Z";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratchParent = resolve(repositoryRoot, "..", ".tmp");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(name: string): string {
  mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(scratchParent, `dolly-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function proposal(text: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "text", text, format: "plain" }] },
    },
  };
}

function openCore(path: string, prefix: string): FileCoreStateStore {
  let blockId = 0;
  let deliveryId = 0;
  return new FileCoreStateStore({
    path,
    maxFailedAttempts: 3,
    nextBlockId: () => `${prefix}-block-${++blockId}`,
    nextDeliveryId: (kind) => `${prefix}-${kind}-${++deliveryId}`,
    now: () => NOW,
  });
}

function prepareWorker(
  core: FileCoreStateStore,
  moduleId: string,
  inputPageId: string,
): ModuleResultCommitInput {
  const moduleGenerationId = `${moduleId}-generation`;
  const processGenerationId = `${moduleId}-process-generation`;
  const inputBlock = core.blocks.commit(proposal(`${moduleId} input`), {
    kind: "external",
    id: "console",
  });
  core.deliveries.append(inputPageId, inputBlock.id);
  const claim = core.deliveries.claim({
    consumerId: moduleId,
    pageIds: [inputPageId],
    moduleGenerationId,
    maxCount: 1,
    maxBytes: 1024 * 1024,
  })!;
  core.appendModuleProcessRecord({
    schemaVersion: "dolly.module-process-record/1",
    instanceId: "capacity-instance",
    moduleId,
    moduleGenerationId,
    processGenerationId,
    packageDigest: `sha256:${"a".repeat(64)}`,
    configurationReference: {
      configId: `${moduleId}-config`,
      revision: `sha256:${"b".repeat(64)}`,
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
    bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
    moduleCgroupPath: deriveModuleCgroupPath(
      "/system.slice/dolly-core.service",
      { instanceId: "capacity-instance", moduleId, processGenerationId },
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
  return {
    ...claim,
    source: { kind: "module", id: moduleId },
    outputPageIds: ["output"],
    blockProposal: proposal(`${moduleId} output`),
  };
}

describe("FileCore Module output capacity", () => {
  it("recovers a later capacity-releasing result before retrying an earlier blocked result", async () => {
    const root = scratch("capacity-restart-order");
    const statePath = join(root, "core-state.json");
    const journalPath = join(root, "module-result-commits.json");
    const core = openCore(statePath, "initial");
    core.deliveries.createPage("upstream-input");
    core.deliveries.createPage("output");
    core.deliveries.registerConsumer("upstream-input", "upstream", "from-now");
    core.deliveries.registerConsumer("output", "sink", "from-now");

    const resident = core.blocks.commit(proposal("sink input"), {
      kind: "external",
      id: "console",
    });
    core.deliveries.append("output", resident.id);
    const upstream = prepareWorker(core, "upstream", "upstream-input");
    const sinkClaim = core.deliveries.claim({
      consumerId: "sink",
      pageIds: ["output"],
      moduleGenerationId: "sink-generation",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    const sinkProcessGenerationId = "sink-process-generation";
    core.appendModuleProcessRecord({
      schemaVersion: "dolly.module-process-record/1",
      instanceId: "capacity-instance",
      moduleId: "sink",
      moduleGenerationId: sinkClaim.moduleGenerationId,
      processGenerationId: sinkProcessGenerationId,
      packageDigest: `sha256:${"a".repeat(64)}`,
      configurationReference: {
        configId: "sink-config",
        revision: `sha256:${"b".repeat(64)}`,
        configVersion: 1,
      },
      declaredExternalEffects: "core-capabilities-only",
      serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
      bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
      moduleCgroupPath: deriveModuleCgroupPath(
        "/system.slice/dolly-core.service",
        {
          instanceId: "capacity-instance",
          moduleId: "sink",
          processGenerationId: sinkProcessGenerationId,
        },
      ).filesystemPath,
      state: "starting",
      createdAt: NOW,
      updatedAt: NOW,
    });
    core.updateModuleProcessRecordState(sinkProcessGenerationId, "running");
    core.appendModuleSubmissionRecord({
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: sinkClaim.moduleJobId,
      claimToken: sinkClaim.claimToken,
      runId: sinkClaim.runId,
      attempt: sinkClaim.attempt,
      moduleGenerationId: sinkClaim.moduleGenerationId,
      processGenerationId: sinkProcessGenerationId,
      inputDigest: canonicalJsonDigest(core.deliveries.inspectClaimInput(sinkClaim)),
      createdAt: NOW,
    });

    const repository = new FileModuleResultCommitRepository({ path: journalPath });
    const coordinator = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 1,
        maxResidentBytes: 1024 * 1024,
      }],
    });
    await expect(coordinator.commit(upstream)).rejects.toMatchObject({
      code: "MODULE_RESULT_OUTPUT_BACKPRESSURED",
      blockedConsumerIds: ["sink"],
    });

    const interruptedSink = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 1,
        maxResidentBytes: 1024 * 1024,
      }],
      afterEffect: (event) => {
        if (event.moduleJobId === sinkClaim.moduleJobId && event.phase === "after-block-effect") {
          throw new Error("simulated restart before the sink releases capacity");
        }
      },
    });
    await expect(interruptedSink.commit({
      ...sinkClaim,
      source: { kind: "module", id: "sink" },
      outputPageIds: [],
      blockProposal: proposal("sink result without output"),
    })).rejects.toThrow("simulated restart before the sink releases capacity");
    expect(repository.list().map((record) => record.moduleJobId)).toEqual([
      upstream.moduleJobId,
      sinkClaim.moduleJobId,
    ]);

    const reopened = openCore(statePath, "reopened");
    const reopenedRepository = new FileModuleResultCommitRepository({ path: journalPath });
    const recovering = createModuleResultCommitCoordinator({
      core: reopened,
      repository: reopenedRepository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 1,
        maxResidentBytes: 1024 * 1024,
      }],
    });

    await expect(recovering.recoverAll()).resolves.toHaveLength(2);
    expect(reopened.deliveries.inspectClaim(upstream).status).toBe("committed");
    expect(reopened.deliveries.inspectClaim(sinkClaim).status).toBe("committed");
    expect(reopened.deliveries.inspectResident("sink", ["output"])).toMatchObject({
      residentCount: 1,
    });

    const verifiedCore = openCore(statePath, "verified");
    const verifiedRepository = new FileModuleResultCommitRepository({ path: journalPath });
    expect(verifiedRepository.get(upstream.moduleJobId)).toMatchObject({
      state: "committed",
      outputDeliveries: [expect.objectContaining({ pageId: "output" })],
    });
    expect(verifiedRepository.get(sinkClaim.moduleJobId)).toMatchObject({
      state: "committed",
      outputDeliveries: [],
    });
    expect(verifiedCore.deliveries.inspectClaim(upstream).status).toBe("committed");
    expect(verifiedCore.deliveries.inspectClaim(sinkClaim).status).toBe("committed");
    expect(verifiedCore.deliveries.inspectResident("sink", ["output"])).toMatchObject({
      residentCount: 1,
    });
  });

  it("keeps a blocked result prepared, then catches its journal up after one atomic commit", async () => {
    const root = scratch("capacity-recovery");
    const statePath = join(root, "core-state.json");
    const core = openCore(statePath, "initial");
    core.deliveries.createPage("input");
    core.deliveries.createPage("output");
    core.deliveries.registerConsumer("input", "worker", "from-now");
    core.deliveries.registerConsumer("output", "sink", "from-now");
    const existing = core.blocks.commit(proposal("already resident"), {
      kind: "external",
      id: "console",
    });
    core.deliveries.append("output", existing.id);
    const input = prepareWorker(core, "worker", "input");
    const repository = new InMemoryModuleResultCommitRepository();
    const limited = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 1,
        maxResidentBytes: 1024 * 1024,
      }],
    });

    await expect(limited.commit(input)).rejects.toMatchObject({
      code: "MODULE_RESULT_OUTPUT_BACKPRESSURED",
      blockedConsumerIds: ["sink"],
    });
    const prepared = repository.get(input.moduleJobId)!;
    expect(prepared).toMatchObject({ state: "prepared", outputDeliveries: [] });
    expect(core.deliveries.inspectClaim(input).status).toBe("active");
    expect(core.getModuleSubmissionRecord(input.runId)).toBeDefined();
    expect(core.deliveries.inspectPending("sink", ["output"]).pendingCount).toBe(1);
    await expect(limited.recoverAll()).rejects.toMatchObject({
      code: "MODULE_RESULT_OUTPUT_BACKPRESSURED",
      blockedConsumerIds: ["sink"],
    });

    let interruptAfterAtomicCommit = true;
    const expanded = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 2,
        maxResidentBytes: 1024 * 1024,
      }],
      afterEffect: (event) => {
        if (interruptAfterAtomicCommit && event.phase === "after-ack-effect") {
          interruptAfterAtomicCommit = false;
          throw new Error("simulated journal interruption after atomic Core commit");
        }
      },
    });
    await expect(expanded.recover(input.moduleJobId)).rejects.toThrow(
      "simulated journal interruption after atomic Core commit",
    );
    expect(core.deliveries.inspectClaim(input).status).toBe("committed");
    expect(core.getModuleSubmissionRecord(input.runId)).toBeUndefined();
    expect(core.deliveries.inspectPending("sink", ["output"]).pendingCount).toBe(2);
    expect(repository.get(input.moduleJobId)).toMatchObject({
      state: "prepared",
      outputDeliveries: [],
    });

    const reopened = openCore(statePath, "reopened");
    const recovering = createModuleResultCommitCoordinator({
      core: reopened,
      repository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 2,
        maxResidentBytes: 1024 * 1024,
      }],
    });
    await expect(recovering.recover(input.moduleJobId)).resolves.toMatchObject({
      state: "committed",
      outputDeliveries: [expect.objectContaining({ pageId: "output" })],
    });
    expect(reopened.deliveries.inspectPending("worker", ["input"]).pendingCount).toBe(0);
    expect(reopened.deliveries.inspectPending("sink", ["output"]).pendingCount).toBe(2);
  });

  it("serializes two producers competing for the same final slot", async () => {
    const root = scratch("capacity-race");
    const core = openCore(join(root, "core-state.json"), "race");
    for (const pageId of ["input-a", "input-b", "output"]) {
      core.deliveries.createPage(pageId);
    }
    core.deliveries.registerConsumer("input-a", "worker-a", "from-now");
    core.deliveries.registerConsumer("input-b", "worker-b", "from-now");
    core.deliveries.registerConsumer("output", "sink", "from-now");
    const left = prepareWorker(core, "worker-a", "input-a");
    const right = prepareWorker(core, "worker-b", "input-b");
    const repository = new InMemoryModuleResultCommitRepository();
    const coordinator = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 1,
        maxResidentBytes: 1024 * 1024,
      }],
    });

    const results = await Promise.allSettled([
      coordinator.commit(left),
      coordinator.commit(right),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      code: "MODULE_RESULT_OUTPUT_BACKPRESSURED",
      blockedConsumerIds: ["sink"],
    });
    expect(core.deliveries.inspectResident("sink", ["output"])).toMatchObject({
      residentCount: 1,
    });
    expect(core.listModuleSubmissionRecords()).toHaveLength(1);
    expect(core.deliveries.listActiveClaims()).toHaveLength(1);
  });
});
