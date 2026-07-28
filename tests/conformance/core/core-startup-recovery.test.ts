import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BlockProposal } from "../../../src/core/block-store.js";
import { CoreStartupRecovery } from "../../../src/core/core-startup-recovery.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import {
  ModuleResultCommitCoordinator,
  type ModuleResultCommitCoordinatorOptions,
} from "../../../src/core/module-result-commit.js";

const NOW = "2026-07-24T00:00:00.000Z";

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
    repository,
    now: () => NOW,
    ...(afterEffect === undefined ? {} : { afterEffect }),
  });
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

  it("recovers prepared effects before checking for unresolved active Claims", async () => {
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
    restarted.deliveries.ack({
      moduleJobId: sink.moduleJobId,
      claimToken: sink.claimToken,
      runId: sink.runId,
      attempt: sink.attempt,
      moduleGenerationId: sink.moduleGenerationId,
    });
  });

  it("reconciles a terminal journal against a core snapshot captured before its ack", async () => {
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
    const report = await new CoreStartupRecovery({
      deliveries: restarted.deliveries,
      commits: coordinator(restarted, restartedRepository),
    }).recover();
    expect(report.recoveredCommits).toEqual([]);
    expect(restarted.deliveries.inspectClaim({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
    }).status).toBe("committed");
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
    first.deliveries.releaseClaim(request);

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
      collectedRecords: { submissionRecords: 0, processRecords: 0 },
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
});
