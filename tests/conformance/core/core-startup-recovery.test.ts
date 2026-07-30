import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BlockProposal } from "../../../src/core/block-store.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { CoreStartupRecovery } from "../../../src/core/core-startup-recovery.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import {
  ModuleResultCommitCoordinator,
  ModuleResultCommitError,
  type ModuleResultCommitCoordinatorOptions,
} from "../../../src/core/module-result-commit.js";

const NOW = "2026-07-24T00:00:00.000Z";
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const CONFIGURATION_DIGEST = `sha256:${"b".repeat(64)}`;
const SERVICE_INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";

function proposal(text: string): BlockProposal {
  return {
    payload: { schema: "test.content/1", value: { text } },
  };
}

function openCore(
  path: string,
  prefix: string,
  maxFailedAttempts = 3,
): FileCoreStateStore {
  let blockId = 0;
  let runtimeId = 0;
  return new FileCoreStateStore({
    path,
    maxFailedAttempts,
    nextBlockId: () => `${prefix}-block-${++blockId}`,
    nextDeliveryId: (kind) => `${prefix}-${kind}-${++runtimeId}`,
    now: () => NOW,
  });
}

function coordinator(
  core: FileCoreStateStore,
  repository: FileModuleResultCommitRepository,
  afterEffect?: ModuleResultCommitCoordinatorOptions["afterEffect"],
) {
  return new ModuleResultCommitCoordinator({
    blocks: core.blocks,
    deliveries: core.deliveries,
    getModuleSubmissionRecord: (runId) =>
      core.getModuleSubmissionRecord(runId),
    acknowledgeDeliveryClaim: (identity) => core.acknowledgeDeliveryClaim(identity),
    repository,
    now: () => NOW,
    ...(afterEffect === undefined ? {} : { afterEffect }),
  });
}

function appendStoppedProcessAndSubmission(
  core: FileCoreStateStore,
  claim: {
    readonly moduleJobId: string;
    readonly claimToken: string;
    readonly runId: string;
    readonly attempt: number;
    readonly moduleGenerationId: string;
  },
): void {
  const processGenerationId = "process-generation-1";
  core.appendModuleProcessRecord({
    schemaVersion: "dolly.module-process-record/1",
    instanceId: "instance-1",
    moduleId: "worker",
    moduleGenerationId: claim.moduleGenerationId,
    processGenerationId,
    packageDigest: PACKAGE_DIGEST,
    configurationReference: {
      configId: "config-1",
      revision: CONFIGURATION_DIGEST,
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    serviceInvocationId: SERVICE_INVOCATION_ID,
    bootId: BOOT_ID,
    moduleCgroupPath: deriveModuleCgroupPath("/system.slice/dolly-core.service", {
      instanceId: "instance-1",
      moduleId: "worker",
      processGenerationId,
    }).filesystemPath,
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
    moduleGenerationId: claim.moduleGenerationId,
    processGenerationId,
    inputDigest: canonicalJsonDigest(core.deliveries.inspectClaimInput(claim)),
    createdAt: NOW,
  });
  core.updateModuleProcessRecordState(processGenerationId, "stopped");
}

describe("CORE startup journal recovery", () => {
  let root: string;
  let statePath: string;
  let journalPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-startup-recovery-"));
    statePath = join(root, "core.json");
    journalPath = join(root, "module-result-commits.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("recovers a prepared result for an active Claim with its exact submission", async () => {
    const first = openCore(statePath, "first");
    first.deliveries.createPage("input");
    first.deliveries.createPage("output");
    first.deliveries.registerConsumer("input", "worker", "from-now");
    first.deliveries.registerConsumer("output", "sink", "from-now");
    const input = first.blocks.commit(proposal("input"), {
      kind: "external",
      id: "console",
    });
    first.deliveries.append("input", input.id);
    const claim = first.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    appendStoppedProcessAndSubmission(first, claim);
    const repository = new FileModuleResultCommitRepository({ path: journalPath });
    const interrupted = coordinator(first, repository, (event) => {
      if (event.phase === "after-block-effect") throw new Error("simulated interruption");
    });
    await expect(interrupted.commit({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      source: { kind: "module", id: "worker" },
      outputPageIds: ["output"],
      blockProposal: proposal("output"),
    })).rejects.toThrow("simulated interruption");
    expect(repository.get(claim.moduleJobId)).toMatchObject({ state: "prepared" });

    const restarted = openCore(statePath, "second");
    const restartedRepository = new FileModuleResultCommitRepository({ path: journalPath });
    const recovery = new CoreStartupRecovery({
      deliveries: restarted.deliveries,
      commits: coordinator(restarted, restartedRepository),
      moduleRecords: restarted,
    });
    const report = await recovery.recover();
    expect(report.recoveredCommits).toHaveLength(1);
    expect(restarted.deliveries.inspectClaim({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
    }).status).toBe("committed");

    const sink = restarted.deliveries.claim({
      consumerId: "sink",
      pageIds: ["output"],
      moduleGenerationId: "sink-generation",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    })!;
    expect(sink.deliveryIds).toHaveLength(1);
  });

  it("fails closed when a committed result journal has an active Claim", async () => {
    const first = openCore(statePath, "first");
    first.deliveries.createPage("input");
    first.deliveries.createPage("output");
    first.deliveries.registerConsumer("input", "worker", "from-now");
    const input = first.blocks.commit(proposal("input"), {
      kind: "external",
      id: "console",
    });
    first.deliveries.append("input", input.id);
    const claim = first.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    appendStoppedProcessAndSubmission(first, claim);
    const repository = new FileModuleResultCommitRepository({ path: journalPath });
    let captured: Buffer | undefined;
    let interrupted = false;
    await expect(coordinator(first, repository, (event) => {
      if (event.phase === "after-delivery-effect" && !interrupted) {
        interrupted = true;
        captured = readFileSync(statePath);
        throw new Error("capture before terminal ack");
      }
    }).commit({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      source: { kind: "module", id: "worker" },
      outputPageIds: ["output"],
      blockProposal: proposal("output"),
    })).rejects.toThrow("capture before terminal ack");
    expect(captured).toBeDefined();

    await coordinator(first, repository).recover(claim.moduleJobId);
    expect(repository.get(claim.moduleJobId)?.state).toBe("committed");
    writeFileSync(statePath, captured!);

    const restarted = openCore(statePath, "second");
    const restartedRepository = new FileModuleResultCommitRepository({ path: journalPath });
    await expect(new CoreStartupRecovery({
      deliveries: restarted.deliveries,
      commits: coordinator(restarted, restartedRepository),
      moduleRecords: restarted,
    }).recover()).rejects.toMatchObject({
      code: "STARTUP_JOURNAL_CLAIM_INCONSISTENT",
    });
    expect(restarted.deliveries.inspectClaim({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
    }).status).toBe("active");
    expect(restarted.getModuleSubmissionRecord(claim.runId)).toBeDefined();
  });

  it("refuses a journal-free active Claim and leaves it unchanged", async () => {
    const core = openCore(statePath, "first");
    core.deliveries.createPage("input");
    core.deliveries.registerConsumer("input", "worker", "from-now");
    const block = core.blocks.commit(proposal("input"), {
      kind: "external",
      id: "console",
    });
    core.deliveries.append("input", block.id);
    const claim = core.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    const repository = new FileModuleResultCommitRepository({ path: journalPath });
    await expect(new CoreStartupRecovery({
      deliveries: core.deliveries,
      commits: coordinator(core, repository),
    }).recover()).rejects.toMatchObject({ code: "STARTUP_ACTIVE_CLAIM_UNRESOLVED" });
    expect(core.deliveries.inspectClaim({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
    }).status).toBe("active");
  });

  it("accepts a persisted released Claim and leaves its Module job ready", async () => {
    const first = openCore(statePath, "first");
    first.deliveries.createPage("input");
    first.deliveries.registerConsumer("input", "worker", "from-now");
    const block = first.blocks.commit(proposal("input"), {
      kind: "external",
      id: "console",
    });
    first.deliveries.append("input", block.id);
    const claim = first.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    const request = {
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
    };
    first.releaseDeliveryClaim(request);

    const restarted = openCore(statePath, "second");
    const repository = new FileModuleResultCommitRepository({ path: journalPath });
    await expect(new CoreStartupRecovery({
      deliveries: restarted.deliveries,
      commits: coordinator(restarted, repository),
    }).recover()).resolves.toEqual({
      recoveredCommits: [],
      releasedClaims: [],
      unknownOutcomeClaims: [],
      stoppedProcessGenerationIds: [],
      collectedRecords: { processRecords: 0 },
    });
    expect(restarted.deliveries.inspectClaim(request).status).toBe("released");

    const retry = restarted.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-2",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    expect(retry).toMatchObject({
      moduleJobId: claim.moduleJobId,
      deliveryIds: claim.deliveryIds,
      attempt: 2,
    });
  });

  it.each([
    "MODULE_JOB_SOURCE_MISMATCH",
    "MODULE_JOB_OUTPUT_INVALID",
  ] as const)(
    "maps %s from result-journal recovery to the startup boundary",
    async (resultCommitCode) => {
      const core = openCore(statePath, "first");
      const resultCommitError = new ModuleResultCommitError(
        resultCommitCode,
        "persisted result does not match the active Claim",
      );
      const commits = {
        recoverAll: async () => {
          throw resultCommitError;
        },
      } as unknown as ModuleResultCommitCoordinator;

      await expect(
        new CoreStartupRecovery({
          deliveries: core.deliveries,
          commits,
        }).recover(),
      ).rejects.toMatchObject({
        code: "STARTUP_JOURNAL_CLAIM_INCONSISTENT",
        message: expect.stringContaining(resultCommitCode),
      });
    },
  );

  it("passes through a non-result-commit recovery error unchanged", async () => {
    const core = openCore(statePath, "first");
    const storageFailure = new Error("result journal storage unavailable");
    const commits = {
      recoverAll: async () => {
        throw storageFailure;
      },
    } as unknown as ModuleResultCommitCoordinator;

    await expect(
      new CoreStartupRecovery({
        deliveries: core.deliveries,
        commits,
      }).recover(),
    ).rejects.toBe(storageFailure);
  });

  it.each([
    "MODULE_RESULT_COMMIT_IO_FAILED",
    "MODULE_RESULT_OPERATION_CONTRACT_VIOLATION",
  ] as const)(
    "does not misclassify %s as a Claim inconsistency",
    async (resultCommitCode) => {
      const core = openCore(statePath, "first");
      const originalError = new ModuleResultCommitError(
        resultCommitCode,
        "result commit operation did not complete normally",
      );
      const commits = {
        recoverAll: async () => {
          throw originalError;
        },
      } as unknown as ModuleResultCommitCoordinator;

      await expect(
        new CoreStartupRecovery({
          deliveries: core.deliveries,
          commits,
        }).recover(),
      ).rejects.toBe(originalError);
    },
  );
});
