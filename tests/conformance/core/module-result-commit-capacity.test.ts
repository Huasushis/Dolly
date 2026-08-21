import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BlockProposal } from "../../../src/core/block-store.js";
import type { DeliveryMailboxCapacity } from "../../../src/core/delivery-store.js";
import { canonicalJsonDigest, type JsonValue } from "../../../src/core/canonical-json.js";
import { type ModuleProcessRecord } from "../../../src/core/module-process-records.js";
import { seedLegacyProcessRecords } from "./fixtures/process-id-v19-cutover.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import { createModuleResultCommitCoordinator } from "../../../src/core/module-result-commit-factory.js";
import {
  InMemoryModuleResultCommitRepository,
  ModuleResultCommitBackpressureError,
  ModuleResultCommitCoordinator,
  type ModuleResultCommitInput,
  type ModuleResultCommitRepository,
} from "../../../src/core/module-result-commit.js";
import { deriveReservedV10ModuleMailboxCapacities } from "../../../src/core/reactive-module-host.js";
import { ReactiveModuleRuntime } from "../../../src/core/reactive-module-runtime.js";
import { createDefaultDollyInstanceConfig } from "../../../src/core/runtime-config.js";
import { deriveDollyInstanceV10SchedulerPlan } from "../../../src/core/runtime-config-v10.js";

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

function processRecordBody(moduleId: string): ModuleProcessRecord {
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: "capacity-instance",
    moduleId,
    moduleGenerationId: `${moduleId}-generation`,
    processGenerationId: `${moduleId}-process-generation`,
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
      {
        instanceId: "capacity-instance",
        moduleId,
        processGenerationId: `${moduleId}-process-generation`,
      },
    ).filesystemPath,
    state: "starting",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function seededCore(
  path: string,
  prefix: string,
  moduleIds: readonly string[],
): FileCoreStateStore {
  openCore(path, `${prefix}-seed`);
  seedLegacyProcessRecords(path, {
    processRecords: moduleIds.map(processRecordBody),
  });
  return openCore(path, prefix);
}

function prepareWorker(
  core: FileCoreStateStore,
  moduleId: string,
  inputPageId: string,
): ModuleResultCommitInput {
  const moduleGenerationId = `${moduleId}-generation`;
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
  persistSubmittedClaim(core, moduleId, claim);
  return {
    ...claim,
    source: { kind: "module", id: moduleId },
    outputPageIds: ["output"],
    blockProposal: proposal(`${moduleId} output`),
  };
}

function persistSubmittedClaim(
  core: FileCoreStateStore,
  moduleId: string,
  claim: Pick<
    ModuleResultCommitInput,
    "attempt" | "claimToken" | "moduleGenerationId" | "moduleJobId" | "runId"
  >,
): void {
  const moduleGenerationId = claim.moduleGenerationId;
  const processGenerationId = `${moduleId}-process-generation`;
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
}

describe("FileCore Module output capacity", () => {
  it("prunes verified terminal history before resuming a size-bound prepared result", async () => {
    const root = scratch("capacity-terminal-pruning");
    const statePath = join(root, "core-state.json");
    const journalPath = join(root, "result-commits.json");
    const core = seededCore(statePath, "terminal-pruning", ["history", "current"]);
    for (const [pageId, consumerId] of [
      ["history-input", "history"],
      ["current-input", "current"],
      ["output", "sink"],
    ] as const) {
      core.deliveries.createPage(pageId);
      core.deliveries.registerConsumer(pageId, consumerId, "from-now");
    }
    const repository = new FileModuleResultCommitRepository({
      path: journalPath,
      maxBytes: 1024 * 1024,
    });
    const history = prepareWorker(core, "history", "history-input");
    const commits = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 8,
        maxResidentBytes: 1024 * 1024,
      }],
    });
    await expect(commits.commit({
      ...history,
      blockProposal: proposal("h".repeat(2_000)),
    })).resolves.toMatchObject({ state: "committed" });

    const current = prepareWorker(core, "current", "current-input");
    let interrupted = false;
    const interruptedCommits = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 8,
        maxResidentBytes: 1024 * 1024,
      }],
      afterEffect: (event) => {
        if (!interrupted && event.moduleJobId === current.moduleJobId &&
          event.phase === "after-ack-effect") {
          interrupted = true;
          throw new Error("simulated restart after the atomic Core commit");
        }
      },
    });
    await expect(interruptedCommits.commit({
      ...current,
      blockProposal: proposal("c".repeat(2_000)),
    })).rejects.toThrow("simulated restart after the atomic Core commit");
    expect(core.deliveries.inspectClaim(current).status).toBe("committed");
    expect(repository.get(history.moduleJobId)).toMatchObject({ state: "committed" });
    expect(repository.get(current.moduleJobId)).toMatchObject({ state: "prepared" });

    // The legacy-sized document itself remains readable, but recording the
    // already durable output effect cannot grow it by even one byte until the
    // verified terminal history is reclaimed.
    const exactCurrentBytes = statSync(journalPath).size;
    expect(exactCurrentBytes).toBeGreaterThan(1_024);
    const reopenedRepository = new FileModuleResultCommitRepository({
      path: journalPath,
      maxBytes: exactCurrentBytes,
    });
    const mailboxes = [{
      consumerId: "sink",
      pageIds: ["output"],
      maxResidentCount: 8,
      maxResidentBytes: 1024 * 1024,
    }] as const;
    const operations = core.createModuleResultCommitOperations(mailboxes);
    const releaseFailure = new Error("simulated Block effect release failure");
    // The retirement is now one store-bound atomic op; simulate a crash at
    // its boundary by letting the durable ticket stage and then failing the
    // retirement before it runs, so the committed journal and all effects
    // survive untouched for a fresh coordinator to finish.
    const interruptedCleanup = new ModuleResultCommitCoordinator({
      ...operations,
      retireModuleResultEffects: () => { throw releaseFailure; },
      repository: reopenedRepository,
      now: () => NOW,
    });

    await expect(interruptedCleanup.recover(current.moduleJobId)).rejects.toBe(releaseFailure);
    expect(reopenedRepository.get(history.moduleJobId)).toMatchObject({ state: "committed" });
    expect(reopenedRepository.get(current.moduleJobId)).toMatchObject({ state: "prepared" });

    const recovering = createModuleResultCommitCoordinator({
      core,
      repository: reopenedRepository,
      now: () => NOW,
      mailboxes,
    });

    await expect(recovering.recover(current.moduleJobId)).resolves.toMatchObject({
      moduleJobId: current.moduleJobId,
      state: "committed",
      outputDeliveries: [expect.objectContaining({ pageId: "output" })],
    });
    expect(reopenedRepository.get(history.moduleJobId)).toBeNull();
    expect(reopenedRepository.get(current.moduleJobId)).toMatchObject({ state: "committed" });
    expect(new FileModuleResultCommitRepository({
      path: journalPath,
      maxBytes: exactCurrentBytes,
    }).get(current.moduleJobId)).toMatchObject({ state: "committed" });
  });

  it("identifies the owning consumer when a self-loop output cannot fit", async () => {
    const root = scratch("capacity-self-loop");
    const core = seededCore(join(root, "core-state.json"), "self-loop", ["loop"]);
    for (const pageId of ["loop-a", "loop-b"]) {
      core.deliveries.createPage(pageId);
      core.deliveries.registerConsumer(pageId, "loop", "from-now");
    }
    const inputBlock = core.blocks.commit(proposal("self-loop input"), {
      kind: "external",
      id: "console",
    });
    core.deliveries.append("loop-a", inputBlock.id);
    const claim = core.deliveries.claim({
      consumerId: "loop",
      pageIds: ["loop-a", "loop-b"],
      moduleGenerationId: "loop-generation",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    persistSubmittedClaim(core, "loop", claim);
    const repository = new InMemoryModuleResultCommitRepository();
    const commits = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "loop",
        pageIds: ["loop-a", "loop-b"],
        maxResidentCount: 1,
        maxResidentBytes: 1024 * 1024,
      }],
    });

    await expect(commits.commit({
      ...claim,
      source: { kind: "module", id: "loop" },
      outputPageIds: ["loop-a", "loop-b"],
      blockProposal: proposal("self-loop output"),
    })).rejects.toMatchObject({
      code: "MODULE_RESULT_OUTPUT_BACKPRESSURED",
      blockedConsumerIds: ["loop"],
    });
    expect(core.deliveries.inspectClaim(claim).status).toBe("active");
    expect(repository.get(claim.moduleJobId)).toMatchObject({
      state: "prepared",
      outputDeliveries: [],
    });
    expect(core.deliveries.inspectResident("loop", ["loop-a", "loop-b"]))
      .toMatchObject({ residentCount: 1, claimedCount: 1 });
  });

  it("recovers a later capacity-releasing result before retrying an earlier blocked result", async () => {
    const root = scratch("capacity-restart-order");
    const statePath = join(root, "core-state.json");
    const journalPath = join(root, "module-result-commits.json");
    const core = seededCore(statePath, "initial", ["upstream", "sink"]);
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
    persistSubmittedClaim(core, "sink", sinkClaim);

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

    await expect(recovering.recoverAll()).resolves.toMatchObject({
      recoveredCommits: [
        expect.objectContaining({ moduleJobId: sinkClaim.moduleJobId, state: "committed" }),
        expect.objectContaining({ moduleJobId: upstream.moduleJobId, state: "committed" }),
      ],
      deferredCommits: [],
    });
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

  it("restores a deferred output commit without executing the Module again", async () => {
    const root = scratch("capacity-runtime-restart");
    const statePath = join(root, "core-state.json");
    const journalPath = join(root, "module-result-commits.json");
    const first = seededCore(statePath, "first", ["worker", "sink"]);
    first.deliveries.createPage("input");
    first.deliveries.createPage("output");
    first.deliveries.registerConsumer("input", "worker", "from-now");
    first.deliveries.registerConsumer("output", "sink", "from-now");
    const resident = first.blocks.commit(proposal("resident"), {
      kind: "external",
      id: "console",
    });
    first.deliveries.append("output", resident.id);
    const input = prepareWorker(first, "worker", "input");
    const repository = new FileModuleResultCommitRepository({ path: journalPath });
    const limited = createModuleResultCommitCoordinator({
      core: first,
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
    });

    const restarted = openCore(statePath, "restarted");
    const restartedRepository = new FileModuleResultCommitRepository({ path: journalPath });
    const commits = createModuleResultCommitCoordinator({
      core: restarted,
      repository: restartedRepository,
      now: () => NOW,
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output"],
        maxResidentCount: 1,
        maxResidentBytes: 1024 * 1024,
      }],
    });
    const recovery = await commits.recoverAll();
    expect(recovery.deferredCommits).toHaveLength(1);

    const sinkClaim = restarted.deliveries.claim({
      consumerId: "sink",
      pageIds: ["output"],
      moduleGenerationId: "sink-generation",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    persistSubmittedClaim(restarted, "sink", sinkClaim);
    expect(restarted.acknowledgeDeliveryClaim(sinkClaim)).toBe("committed");

    const execute = vi.fn().mockResolvedValue({
      schemaVersion: "dolly.module-result/1",
    });
    const startExecutor = vi.fn().mockResolvedValue(undefined);
    const persistModuleSubmission = vi.fn(() => {
      throw new Error("restored commit must not submit a new Module Run");
    });
    const runtime = new ReactiveModuleRuntime({
      moduleId: "worker",
      initialModuleGenerationId: "worker-restarted-generation",
      inputPageIds: ["input"],
      outputPageIds: ["output"],
      claimMaxCount: 1,
      claimMaxBytes: 1024 * 1024,
      maxInputBytes: 2 * 1024 * 1024,
      maxResultBytes: 2 * 1024 * 1024,
      executionTimeoutMs: 60_000,
      cancellationGraceMs: 1_000,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      maxRunsPerGeneration: 100,
      maxGenerations: 8,
      deliveries: {
        validateClaimPages: restarted.deliveries.validateClaimPages.bind(restarted.deliveries),
        validateOutputPages: restarted.deliveries.validateOutputPages.bind(restarted.deliveries),
        claim: restarted.deliveries.claim.bind(restarted.deliveries),
        flushPersistence: restarted.deliveries.flushPersistence.bind(restarted.deliveries),
        inspectClaim: restarted.deliveries.inspectClaim.bind(restarted.deliveries),
        inspectClaimInput: restarted.deliveries.inspectClaimInput.bind(restarted.deliveries),
      },
      persistModuleSubmission,
      releaseDeliveryClaim: () => {
        throw new Error("restored commit must not release its Claim");
      },
      negativelyAcknowledgeDeliveryClaim: () => {
        throw new Error("restored commit must not negatively acknowledge its Claim");
      },
      getModuleSubmissionRecord: (runId) => restarted.getModuleSubmissionRecord(runId),
      commits,
      initialDeferredCommit: recovery.deferredCommits[0],
      nextModuleGenerationId: () => "worker-next-generation",
      monotonicNow: () => 1,
      declaredExternalEffects: "core-capabilities-only",
      createExecutor: () => ({
        isolation: "process",
        start: startExecutor,
        execute,
        terminate: async () => undefined,
      }),
      classifyFailure: (failure) => ({ code: failure.code, retryable: false }),
    });
    expect(runtime.outputCommitWaiting).toBe(true);
    await runtime.start();
    expect(startExecutor).not.toHaveBeenCalled();
    await expect(runtime.tick()).resolves.toMatchObject({
      moduleJobId: input.moduleJobId,
      status: "committed",
      recovered: true,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(startExecutor).not.toHaveBeenCalled();
    expect(persistModuleSubmission).not.toHaveBeenCalled();
    await runtime.stop();

    const verifiedCore = openCore(statePath, "verified");
    const verifiedRepository = new FileModuleResultCommitRepository({ path: journalPath });
    expect(verifiedRepository.get(input.moduleJobId)).toMatchObject({
      state: "committed",
      outputDeliveries: [expect.objectContaining({ pageId: "output" })],
    });
    expect(verifiedCore.deliveries.inspectClaim(input).status).toBe("committed");
    expect(verifiedCore.deliveries.inspectResident("sink", ["output"])).toMatchObject({
      residentCount: 1,
    });
  });

  it("never nacks a startup-verified result when its journal later disappears", async () => {
    const root = scratch("capacity-runtime-missing-journal");
    const statePath = join(root, "core-state.json");
    const core = seededCore(statePath, "missing", ["worker"]);
    core.deliveries.createPage("input");
    core.deliveries.createPage("output");
    core.deliveries.registerConsumer("input", "worker", "from-now");
    core.deliveries.registerConsumer("output", "sink", "from-now");
    const resident = core.blocks.commit(proposal("resident"), {
      kind: "external",
      id: "console",
    });
    core.deliveries.append("output", resident.id);
    const input = prepareWorker(core, "worker", "input");
    const stored = new InMemoryModuleResultCommitRepository();
    let hideJournal = false;
    const repository: ModuleResultCommitRepository = {
      createPrepared: (record) => stored.createPrepared(record),
      get: (moduleJobId) => hideJournal ? null : stored.get(moduleJobId),
      compareAndSet: (moduleJobId, revision, next) =>
        stored.compareAndSet(moduleJobId, revision, next),
      deleteIfRevision: (moduleJobId, revision) =>
        stored.deleteIfRevision(moduleJobId, revision),
      list: () => hideJournal ? [] : stored.list(),
    };
    const commits = createModuleResultCommitCoordinator({
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
    await expect(commits.commit(input)).rejects.toMatchObject({
      code: "MODULE_RESULT_OUTPUT_BACKPRESSURED",
    });
    const recovery = await commits.recoverAll();
    expect(recovery.deferredCommits).toHaveLength(1);

    const nack = vi.fn(() => "dead-lettered" as const);
    const release = vi.fn(() => "released" as const);
    const startExecutor = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ schemaVersion: "dolly.module-result/1" });
    const runtime = new ReactiveModuleRuntime({
      moduleId: "worker",
      initialModuleGenerationId: "worker-restarted-generation",
      inputPageIds: ["input"],
      outputPageIds: ["output"],
      claimMaxCount: 1,
      claimMaxBytes: 1024 * 1024,
      maxInputBytes: 2 * 1024 * 1024,
      maxResultBytes: 2 * 1024 * 1024,
      executionTimeoutMs: 60_000,
      cancellationGraceMs: 1_000,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      maxRunsPerGeneration: 100,
      maxGenerations: 8,
      deliveries: {
        validateClaimPages: core.deliveries.validateClaimPages.bind(core.deliveries),
        validateOutputPages: core.deliveries.validateOutputPages.bind(core.deliveries),
        claim: core.deliveries.claim.bind(core.deliveries),
        flushPersistence: core.deliveries.flushPersistence.bind(core.deliveries),
        inspectClaim: core.deliveries.inspectClaim.bind(core.deliveries),
        inspectClaimInput: core.deliveries.inspectClaimInput.bind(core.deliveries),
      },
      persistModuleSubmission: () => {
        throw new Error("restored commit must not submit a new Module Run");
      },
      releaseDeliveryClaim: release,
      negativelyAcknowledgeDeliveryClaim: nack,
      getModuleSubmissionRecord: (runId) => core.getModuleSubmissionRecord(runId),
      commits,
      initialDeferredCommit: recovery.deferredCommits[0],
      nextModuleGenerationId: () => "worker-next-generation",
      monotonicNow: () => 1,
      declaredExternalEffects: "none",
      createExecutor: () => ({
        isolation: "process",
        start: startExecutor,
        execute,
        terminate: async () => undefined,
      }),
      classifyFailure: (failure) => ({ code: failure.code, retryable: false }),
    });
    await runtime.start();
    expect(runtime.startupRecoveryPending).toBe(true);
    hideJournal = true;
    await expect(runtime.tick()).resolves.toMatchObject({
      moduleJobId: input.moduleJobId,
      status: "recovery-required",
      reason: "commit-outcome-unknown",
    });
    await expect(runtime.recover()).resolves.toMatchObject({
      moduleJobId: input.moduleJobId,
      status: "recovery-required",
      reason: "commit-outcome-unknown",
    });
    expect(nack).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(startExecutor).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(runtime.outputCommitWaiting).toBe(false);
    expect(runtime.startupRecoveryPending).toBe(true);
    expect(core.deliveries.inspectClaim(input).status).toBe("active");
    expect(core.getModuleSubmissionRecord(input.runId)).toBeDefined();
    await expect(runtime.stop()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
  });

  it("keeps a blocked result prepared, then catches its journal up after one atomic commit", async () => {
    const root = scratch("capacity-recovery");
    const statePath = join(root, "core-state.json");
    const core = seededCore(statePath, "initial", ["worker"]);
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
    await expect(limited.recoverAll()).resolves.toMatchObject({
      recoveredCommits: [],
      deferredCommits: [{
        record: expect.objectContaining({
          moduleJobId: input.moduleJobId,
          state: "prepared",
        }),
        blockedConsumerIds: ["sink"],
      }],
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

  it("does not classify a hook-thrown backpressure lookalike as deferred capacity", async () => {
    const root = scratch("capacity-hook-lookalike");
    const core = seededCore(join(root, "core-state.json"), "hook", ["worker"]);
    core.deliveries.createPage("input");
    core.deliveries.createPage("output");
    core.deliveries.registerConsumer("input", "worker", "from-now");
    core.deliveries.registerConsumer("output", "sink", "from-now");
    const resident = core.blocks.commit(proposal("resident"), {
      kind: "external",
      id: "console",
    });
    core.deliveries.append("output", resident.id);
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
    });

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
        if (event.phase === "after-ack-effect") {
          throw new ModuleResultCommitBackpressureError(["sink"]);
        }
      },
    });
    await expect(expanded.recoverAll()).rejects.toBeInstanceOf(
      ModuleResultCommitBackpressureError,
    );
    expect(core.deliveries.inspectClaim(input).status).toBe("committed");
    expect(repository.get(input.moduleJobId)).toMatchObject({ state: "prepared" });
  });

  it("serializes two producers competing for the same final slot", async () => {
    const root = scratch("capacity-race");
    const core = seededCore(join(root, "core-state.json"), "race", ["worker-a", "worker-b"]);
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

  it("recovers the same prepared result regardless of repository enumeration order", async () => {
    async function recoverOne(reverseList: boolean): Promise<{
      readonly recoveredModuleJobId: string;
      readonly sortedModuleJobIds: readonly string[];
    }> {
      const root = scratch(reverseList ? "capacity-order-reverse" : "capacity-order-forward");
      const core = seededCore(join(root, "core-state.json"), "order", ["worker-a", "worker-b", "sink"]);
      for (const pageId of ["input-a", "input-b", "output"]) {
        core.deliveries.createPage(pageId);
      }
      core.deliveries.registerConsumer("input-a", "worker-a", "from-now");
      core.deliveries.registerConsumer("input-b", "worker-b", "from-now");
      core.deliveries.registerConsumer("output", "sink", "from-now");

      const resident = core.blocks.commit(proposal("resident"), {
        kind: "external",
        id: "console",
      });
      core.deliveries.append("output", resident.id);
      const left = prepareWorker(core, "worker-a", "input-a");
      const right = prepareWorker(core, "worker-b", "input-b");
      const stored = new InMemoryModuleResultCommitRepository();
      const repository: ModuleResultCommitRepository = {
        createPrepared: (record) => stored.createPrepared(record),
        get: (moduleJobId) => stored.get(moduleJobId),
        compareAndSet: (moduleJobId, revision, next) =>
          stored.compareAndSet(moduleJobId, revision, next),
        deleteIfRevision: (moduleJobId, revision) =>
          stored.deleteIfRevision(moduleJobId, revision),
        list: () => {
          const records = [...stored.list()];
          return reverseList ? records.reverse() : records;
        },
      };
      const commits = createModuleResultCommitCoordinator({
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

      for (const input of [left, right]) {
        await expect(commits.commit(input)).rejects.toMatchObject({
          code: "MODULE_RESULT_OUTPUT_BACKPRESSURED",
          blockedConsumerIds: ["sink"],
        });
      }

      const sinkClaim = core.deliveries.claim({
        consumerId: "sink",
        pageIds: ["output"],
        moduleGenerationId: "sink-generation",
        maxCount: 1,
        maxBytes: 1024 * 1024,
      })!;
      persistSubmittedClaim(core, "sink", sinkClaim);
      expect(core.acknowledgeDeliveryClaim(sinkClaim)).toBe("committed");

      const recovery = await commits.recoverAll();
      expect(recovery.recoveredCommits).toHaveLength(1);
      expect(recovery.deferredCommits).toHaveLength(1);
      return {
        recoveredModuleJobId: recovery.recoveredCommits[0]!.moduleJobId,
        sortedModuleJobIds: [left.moduleJobId, right.moduleJobId].sort((first, second) =>
          first < second ? -1 : first > second ? 1 : 0,
        ),
      };
    }

    const forward = await recoverOne(false);
    const reverse = await recoverOne(true);
    expect(forward.recoveredModuleJobId).toBe(forward.sortedModuleJobIds[0]);
    expect(reverse.recoveredModuleJobId).toBe(reverse.sortedModuleJobIds[0]);
    expect(reverse.recoveredModuleJobId).toBe(forward.recoveredModuleJobId);
  });
});

const V10_INSTANCE_ID = "44444444-4444-4444-8444-444444444444";

function v10Scheduler(): Record<string, JsonValue> {
  return {
    pollIntervalMs: 100,
    retryBaseMs: 250,
    retryMaxMs: 30_000,
    maxConcurrentModules: 4,
    backpressureAction: "pause-upstream",
    downstreamRecheckMs: 100,
    noProgressAfterMs: 5_000,
    retryJitterBasisPoints: 0,
    lowWatermarkBasisPoints: 10_000,
    policy: { kind: "fixed" },
    policyFailureAction: "quarantine",
  };
}

function v10Execution(): Record<string, JsonValue> {
  return {
    kind: "linux-process",
    isolation: "process",
    limits: {
      memoryMaxBytes: 64 * 1024 * 1024,
      maxTasks: 32,
      cpuQuotaMicros: 100_000,
      cpuPeriodMicros: 100_000,
      maxOpenFiles: 128,
    },
  };
}

function v10SelfLoopDocument(
  mailbox: { maxResidentCount: number; maxResidentBytes: number },
): Record<string, JsonValue> {
  const version9 = createDefaultDollyInstanceConfig(V10_INSTANCE_ID);
  return {
    schemaVersion: "dolly.instance/10",
    instanceId: V10_INSTANCE_ID,
    displayName: "reserved v10 mailbox capacity fixture",
    stateDirectory: null,
    core: {
      limits: {
        ...version9.core.limits,
        maxRegisteredContentValueBytes: 64 * 1024,
      },
      media: version9.core.media,
      scheduler: v10Scheduler(),
    },
    pages: [
      { pageId: "loop-a", quota: { maxEntries: 1_000_000, maxBytes: 1_000_000_000 } },
      { pageId: "loop-b", quota: { maxEntries: 1_000_000, maxBytes: 1_000_000_000 } },
    ],
    modules: [{
      moduleId: "loop",
      extensionId: "org.example.loop",
      packageVersion: "1.0.0",
      moduleKind: "transform",
      configurationReference: {
        configId: "loop-default",
        revision: `sha256:${"1".repeat(64)}`,
        configVersion: 1,
      },
      permissionPolicyReferences: [],
      inputConnections: [
        { pageId: "loop-a", start: { checkpoint: "0" } },
        { pageId: "loop-b", start: { checkpoint: "0" } },
      ],
      outputPageIds: ["loop-a", "loop-b"],
      activation: { kind: "reactive" },
      declaredExternalEffects: "none",
      execution: v10Execution(),
      limits: {
        claim: { baselineCount: 1, baselineBytes: 1024, maxCount: 1, maxBytes: 4096 },
        mailbox,
        sourceRequestMaxBytes: null,
        maxInputBytes: 4096,
        maxResultBytes: 4096,
        maxFrameBytes: 8192,
        maxRunsPerGeneration: 100,
        maxGenerations: 10,
      },
      timeouts: {
        initializationTimeoutMs: 10_000,
        executionTimeoutMs: 30_000,
        cancellationGraceMs: 1_000,
        terminationTimeoutMs: 2_000,
      },
    }],
    logging: version9.logging,
  };
}

function v10SelfLoopMailboxCapacities(): readonly DeliveryMailboxCapacity[] {
  const maxStateBytes = Number(
    createDefaultDollyInstanceConfig(V10_INSTANCE_ID).core.limits.maxStateBytes,
  );
  const plan = deriveDollyInstanceV10SchedulerPlan(v10SelfLoopDocument({
    maxResidentCount: 2,
    maxResidentBytes: 2 * maxStateBytes,
  }));
  return deriveReservedV10ModuleMailboxCapacities(plan.modules);
}

function setupReservedV10SelfLoop(
  core: FileCoreStateStore,
  residentBlocks = 0,
): ModuleResultCommitInput {
  for (const pageId of ["loop-a", "loop-b"]) {
    core.deliveries.createPage(pageId);
    core.deliveries.registerConsumer(pageId, "loop", "from-now");
  }
  const inputBlock = core.blocks.commit(proposal("reserved v10 input"), {
    kind: "external",
    id: "console",
  });
  core.deliveries.append("loop-a", inputBlock.id);
  for (let index = 0; index < residentBlocks; index += 1) {
    const extra = core.blocks.commit(proposal(`reserved v10 resident ${index}`), {
      kind: "external",
      id: "console",
    });
    core.deliveries.append("loop-a", extra.id);
  }
  const claim = core.deliveries.claim({
    consumerId: "loop",
    pageIds: ["loop-a", "loop-b"],
    moduleGenerationId: "loop-generation",
    maxCount: 1,
    maxBytes: 1024 * 1024,
  })!;
  persistSubmittedClaim(core, "loop", claim);
  return {
    ...claim,
    source: { kind: "module", id: "loop" },
    outputPageIds: ["loop-a", "loop-b"],
    blockProposal: proposal("reserved v10 output"),
  };
}

describe("reserved v10 mailbox capacities through the result-commit coordinator", () => {
  it("rejects every output commit when the coordinator gets the current empty mailbox set", async () => {
    const root = scratch("capacity-reserved-v10-empty");
    const core = seededCore(join(root, "core-state.json"), "v10-empty", ["loop"]);
    const input = setupReservedV10SelfLoop(core);
    const commits = createModuleResultCommitCoordinator({
      core,
      repository: new InMemoryModuleResultCommitRepository(),
      now: () => NOW,
      mailboxes: [],
    });

    const error = await commits.commit(input).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "OUTPUT_CAPACITY_INVALID" });
    expect(String(error instanceof Error ? error.message : "")).toMatch(
      /no mailbox capacity/u,
    );
  });

  it("commits output with capacities derived from the reserved v10 plan", async () => {
    const root = scratch("capacity-reserved-v10-derived");
    const core = seededCore(join(root, "core-state.json"), "v10-derived", ["loop"]);
    const input = setupReservedV10SelfLoop(core);
    const maxStateBytes = Number(
      createDefaultDollyInstanceConfig(V10_INSTANCE_ID).core.limits.maxStateBytes,
    );
    const mailboxes = v10SelfLoopMailboxCapacities();
    expect(mailboxes).toEqual([{
      consumerId: "loop",
      pageIds: ["loop-a", "loop-b"],
      maxResidentCount: 2,
      maxResidentBytes: 2 * maxStateBytes,
    }]);
    const repository = new InMemoryModuleResultCommitRepository();
    const commits = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes,
    });

    await expect(commits.commit(input)).resolves.toMatchObject({
      state: "committed",
      outputDeliveries: [
        expect.objectContaining({ pageId: "loop-a" }),
        expect.objectContaining({ pageId: "loop-b" }),
      ],
    });
    expect(repository.get(input.moduleJobId)).toMatchObject({ state: "committed" });
  });

  it("distinguishes invalid capacity from ordinary output backpressure", async () => {
    const invalidRoot = scratch("capacity-reserved-v10-invalid");
    const invalidCore = seededCore(join(invalidRoot, "core-state.json"), "v10-invalid", ["loop"]);
    const invalidInput = setupReservedV10SelfLoop(invalidCore);
    invalidCore.deliveries.createPage("extra");
    invalidCore.deliveries.registerConsumer("extra", "loop", "from-now");
    const invalidCommits = createModuleResultCommitCoordinator({
      core: invalidCore,
      repository: new InMemoryModuleResultCommitRepository(),
      now: () => NOW,
      mailboxes: v10SelfLoopMailboxCapacities(),
    });
    const invalidError = await invalidCommits.commit(invalidInput).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(invalidError).toMatchObject({ code: "OUTPUT_CAPACITY_INVALID" });
    expect(String(invalidError instanceof Error ? invalidError.message : "")).toMatch(
      /must name every subscribed Page/u,
    );

    const blockedRoot = scratch("capacity-reserved-v10-blocked");
    const blockedCore = seededCore(join(blockedRoot, "core-state.json"), "v10-blocked", ["loop"]);
    const blockedInput = setupReservedV10SelfLoop(blockedCore, 4);
    const blockedCommits = createModuleResultCommitCoordinator({
      core: blockedCore,
      repository: new InMemoryModuleResultCommitRepository(),
      now: () => NOW,
      mailboxes: v10SelfLoopMailboxCapacities(),
    });
    await expect(blockedCommits.commit(blockedInput)).rejects.toMatchObject({
      code: "MODULE_RESULT_OUTPUT_BACKPRESSURED",
      blockedConsumerIds: ["loop"],
    });
  });

  it("recovers persisted output with the same derived capacities", async () => {
    const root = scratch("capacity-reserved-v10-recovery");
    const statePath = join(root, "core-state.json");
    const journalPath = join(root, "module-result-commits.json");
    const mailboxes = v10SelfLoopMailboxCapacities();
    const first = seededCore(statePath, "v10-recovery", ["loop"]);
    const input = setupReservedV10SelfLoop(first);
    const repository = new FileModuleResultCommitRepository({
      path: journalPath,
      maxBytes: 16 * 1024 * 1024,
    });
    const commits = createModuleResultCommitCoordinator({
      core: first,
      repository,
      now: () => NOW,
      mailboxes,
    });
    await expect(commits.commit(input)).resolves.toMatchObject({ state: "committed" });

    const reopened = openCore(statePath, "v10-recovery-reopened");
    const reopenedRepository = new FileModuleResultCommitRepository({
      path: journalPath,
      maxBytes: 16 * 1024 * 1024,
    });
    const recovering = createModuleResultCommitCoordinator({
      core: reopened,
      repository: reopenedRepository,
      now: () => NOW,
      mailboxes,
    });
    await expect(recovering.recoverAll()).resolves.toMatchObject({ recoveredCommits: [] });
    expect(reopenedRepository.get(input.moduleJobId)).toMatchObject({ state: "committed" });
    expect(reopened.deliveries.inspectResident("loop", ["loop-a", "loop-b"]))
      .toMatchObject({ residentCount: 2 });
  });
});
