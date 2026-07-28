import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CoreStartupRecovery,
  CoreStartupRecoveryError,
  type ExternalEffectEvidence,
  type ModuleProcessStopProof,
} from "../../../src/core/core-startup-recovery.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { ModuleResultCommitCoordinator } from "../../../src/core/module-result-commit.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type {
  ModuleProcessRecord,
  ModuleSubmissionRecord,
} from "../../../src/core/module-process-records.js";

const NOW = "2026-07-26T00:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
/** The shapes systemd and the Linux kernel report; a record stores no other. */
const INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";

describe("CORE startup reconciliation with Module records", () => {
  let root: string;
  let statePath: string;
  let journalPath: string;

  function openStore(prefix: string): FileCoreStateStore {
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

  function openCommits(store: FileCoreStateStore): ModuleResultCommitCoordinator {
    return new ModuleResultCommitCoordinator({
      blocks: store.blocks,
      deliveries: store.deliveries,
      repository: new FileModuleResultCommitRepository({ path: journalPath }),
      now: () => NOW,
    });
  }

  function processRecord(
    overrides: Partial<ModuleProcessRecord> = {},
  ): ModuleProcessRecord {
    const processGenerationId = overrides.processGenerationId ?? "process-generation-1";
    return {
      schemaVersion: "dolly.module-process-record/1",
      instanceId: "instance-1",
      moduleId: "worker",
      moduleGenerationId: "module-generation-1",
      processGenerationId,
      packageDigest: DIGEST_A,
      configurationReference: {
        configId: "config-1",
        revision: DIGEST_B,
        configVersion: 1,
      },
      declaredExternalEffects: "core-capabilities-only",
      serviceInvocationId: INVOCATION_ID,
      bootId: BOOT_ID,
      moduleCgroupPath: deriveModuleCgroupPath("/system.slice/dolly-core.service", {
        instanceId: "instance-1",
        moduleId: "worker",
        processGenerationId,
      }).filesystemPath,
      state: "starting",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    } as ModuleProcessRecord;
  }

  /** Creates one Page, consumer, Block, Delivery, and active Claim. */
  function seedActiveClaim(store: FileCoreStateStore): {
    moduleJobId: string;
    claimToken: string;
    runId: string;
    attempt: number;
    moduleGenerationId: string;
  } {
    store.deliveries.createPage("input");
    store.deliveries.registerConsumer("input", "worker", "from-now");
    const block = store.blocks.commit(
      { payload: { schema: "test.content/1", value: { text: "input" } } },
      { kind: "external", id: "console" },
    );
    store.deliveries.append("input", block.id);
    const claim = store.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "module-generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    return {
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
    };
  }

  function submissionFor(
    claim: { moduleJobId: string; claimToken: string; runId: string; attempt: number },
    overrides: Partial<ModuleSubmissionRecord> = {},
  ): ModuleSubmissionRecord {
    return {
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: "module-generation-1",
      processGenerationId: "process-generation-1",
      inputDigest: DIGEST_C,
      createdAt: NOW,
      ...overrides,
    } as ModuleSubmissionRecord;
  }

  const provenStopped = {
    proveStopped: async (): Promise<ModuleProcessStopProof> => ({
      proven: true,
      evidence: "populated-zero",
    }),
  };
  const unprovenStop = {
    proveStopped: async (): Promise<ModuleProcessStopProof> => ({
      proven: false,
      reason: "cgroup.events still reports populated 1",
    }),
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-startup-recovery-"));
    statePath = join(root, "core-state.json");
    journalPath = join(root, "module-result-commits.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the existing refusal when an active Claim has no durable records", async () => {
    const store = openStore("first");
    seedActiveClaim(store);

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
      }).recover(),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CoreStartupRecoveryError>>({
        code: "STARTUP_ACTIVE_CLAIM_UNRESOLVED",
      }),
    );
    expect(store.deliveries.listActiveClaims()).toHaveLength(1);
  });

  it("releases only a Claim that was never submitted once its cgroup is proven empty", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());

    const report = await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: store,
      processStopProver: provenStopped,
    }).recover();

    expect(report.releasedClaims).toEqual([
      expect.objectContaining({ runId: claim.runId, reason: "never-submitted" }),
    ]);
    expect(report.stoppedProcessGenerationIds).toEqual(["process-generation-1"]);
    expect(store.deliveries.listActiveClaims()).toEqual([]);

    const reopened = openStore("second");
    expect(reopened.deliveries.listActiveClaims()).toEqual([]);
    // The Claim is terminal, so its process record has nothing left to inform
    // and is collected in the same recovery.
    expect(report.collectedRecords.processRecords).toBe(1);
    expect(reopened.listModuleProcessRecords()).toEqual([]);
  });

  it("refuses to release when the old Module cgroup cannot be proven empty", async () => {
    const store = openStore("first");
    seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        processStopProver: unprovenStop,
      }).recover(),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CoreStartupRecoveryError>>({
        code: "STARTUP_MODULE_PROCESS_UNPROVEN",
      }),
    );
    expect(store.deliveries.listActiveClaims()).toHaveLength(1);
    expect(store.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "starting",
    });
  });

  it("refuses to assume a process stopped when no prover is available", async () => {
    const store = openStore("first");
    seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
      }).recover(),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CoreStartupRecoveryError>>({
        code: "STARTUP_MODULE_PROCESS_UNPROVEN",
      }),
    );
  });

  it("preserves a submitted Run with no committed result as an unknown outcome", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionFor(claim));

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        processStopProver: provenStopped,
        externalEffectEvidence: {
          inspectRunEffects: async (): Promise<ExternalEffectEvidence> => ({
            kind: "unknown",
            reason: "the provider response was lost",
          }),
        },
      }).recover(),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CoreStartupRecoveryError>>({
        code: "STARTUP_ACTIVE_CLAIM_UNRESOLVED",
      }),
    );

    const reopened = openStore("second");
    expect(reopened.deliveries.listActiveClaims()).toEqual([
      expect.objectContaining({ runId: claim.runId, status: "active" }),
    ]);
    expect(reopened.getModuleSubmissionRecord(claim.runId)).toBeDefined();
  });

  it("preserves a submitted Run when no external-effect evidence source exists", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionFor(claim));

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CoreStartupRecoveryError>>({
        code: "STARTUP_ACTIVE_CLAIM_UNRESOLVED",
      }),
    );
    expect(store.deliveries.listActiveClaims()).toHaveLength(1);
  });

  it("releases a submitted Run that declared no external effect", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(
      processRecord({ declaredExternalEffects: "none" }),
    );
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionFor(claim));

    const report = await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: store,
      processStopProver: provenStopped,
    }).recover();

    expect(report.releasedClaims).toEqual([
      expect.objectContaining({ runId: claim.runId, reason: "no-external-effect" }),
    ]);
    const reopened = openStore("second");
    expect(reopened.deliveries.listActiveClaims()).toEqual([]);
    expect(reopened.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
  });

  it("releases a submitted Run whose effects all have safe evidence", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionFor(claim));

    const report = await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: store,
      processStopProver: provenStopped,
      externalEffectEvidence: {
        inspectRunEffects: async (): Promise<ExternalEffectEvidence> => ({
          kind: "no-effect",
        }),
      },
    }).recover();

    expect(report.releasedClaims).toEqual([
      expect.objectContaining({ reason: "effect-evidence-safe" }),
    ]);
    expect(store.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
  });

  it("makes the Claim release and its submission removal one Core-state revision", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(
      processRecord({ declaredExternalEffects: "none" }),
    );
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionFor(claim));
    const commits = openCommits(store);
    const before = store.revision;

    await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits,
      moduleRecords: store,
      processStopProver: provenStopped,
    }).recover();

    // Recovery makes exactly three Core-state updates here:
    //   1. mark the old process record stopped after its stop proof;
    //   2. release the Claim and remove its submission record together; and
    //   3. collect the records nothing references any more.
    // Step 2 is the one Architecture Decision Record 0009 requires to be
    // atomic, so splitting it would raise this count and fail this test.
    expect(store.revision - before).toBe(3);
    const reopened = openStore("second");
    expect(reopened.deliveries.listActiveClaims()).toEqual([]);
    expect(reopened.listModuleSubmissionRecords()).toEqual([]);
  });

  it("fails closed when a submission record does not match its active Claim", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(
      submissionFor(claim, { claimToken: "claim-token-that-does-not-match" }),
    );

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CoreStartupRecoveryError>>({
        code: "STARTUP_MODULE_RECORD_INCONSISTENT",
      }),
    );
    expect(store.deliveries.listActiveClaims()).toHaveLength(1);
  });

  it("does not require a committed result to accept a submission record without a Claim", async () => {
    // This replaces an earlier rule that treated such a record as a
    // consistency error unless the result journal still held its commit.
    // That rule made startup depend on the journal never deleting anything,
    // an undocumented coupling: the moment the journal gained a retention
    // policy, every historical record would have blocked startup forever.
    // A Claim that is already terminal reached that state through an
    // evidence-checked path, so its record is collected instead.
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionFor(claim));
    store.deliveries.releaseClaim(claim);

    const report = await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: store,
      processStopProver: provenStopped,
    }).recover();

    expect(report.collectedRecords.submissionRecords).toBe(1);
    expect(openStore("second").listModuleSubmissionRecords()).toEqual([]);
  });

  it("releases a never-submitted Claim after a second start attempt for the same generation", async () => {
    // One Module generation may legitimately have several start attempts, and
    // stopped process records are not collected today. A Claim that was never
    // submitted must still be released once every process record of its
    // generation is proven stopped; an earlier implementation matched a Claim
    // to a process record only when exactly one existed, which left such a
    // Claim unresolvable and blocked startup forever.
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.updateModuleProcessRecordState("process-generation-1", "stopped");
    store.appendModuleProcessRecord(
      processRecord({ processGenerationId: "process-generation-2" }),
    );

    const report = await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: store,
      processStopProver: provenStopped,
    }).recover();

    expect(report.releasedClaims).toEqual([
      expect.objectContaining({ runId: claim.runId, reason: "never-submitted" }),
    ]);
    expect(store.deliveries.listActiveClaims()).toEqual([]);
  });

  it("keeps a never-submitted Claim unresolved while any record of its generation is unstopped", async () => {
    const store = openStore("first");
    seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.updateModuleProcessRecordState("process-generation-1", "stopped");
    store.appendModuleProcessRecord(
      processRecord({ processGenerationId: "process-generation-2" }),
    );

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        // This prover refuses, so the second record cannot be marked stopped.
        processStopProver: unprovenStop,
      }).recover(),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CoreStartupRecoveryError>>({
        code: "STARTUP_MODULE_PROCESS_UNPROVEN",
      }),
    );
    expect(store.deliveries.listActiveClaims()).toHaveLength(1);
  });

  it("collects records of a Run that already reached a terminal state", async () => {
    // A submission record whose Claim is gone belongs to a Run that was
    // committed, acknowledged, or released through an evidence-checked path.
    // Recovery must collect it rather than require a committed result, which
    // would make startup depend on the result journal never deleting anything.
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionFor(claim));
    store.updateModuleProcessRecordState("process-generation-1", "stopped");
    // The Claim reaches a terminal state without the journal recording it.
    store.deliveries.releaseClaim(claim);

    const report = await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: store,
      processStopProver: provenStopped,
    }).recover();

    expect(report.collectedRecords).toEqual({
      submissionRecords: 1,
      processRecords: 1,
    });
    const reopened = openStore("second");
    expect(reopened.listModuleSubmissionRecords()).toEqual([]);
    expect(reopened.listModuleProcessRecords()).toEqual([]);
  });

  it("keeps every record of a Module generation whose Claim is an unknown outcome", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionFor(claim));

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CoreStartupRecoveryError>>({
        code: "STARTUP_ACTIVE_CLAIM_UNRESOLVED",
      }),
    );

    // An operator resolving the unknown outcome needs this evidence, so
    // nothing was collected.
    const reopened = openStore("second");
    expect(reopened.listModuleSubmissionRecords()).toHaveLength(1);
    expect(reopened.listModuleProcessRecords()).toHaveLength(1);
  });

  it("recovers with no Module records exactly as before", async () => {
    const store = openStore("first");
    const report = await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: store,
    }).recover();

    expect(report.releasedClaims).toEqual([]);
    expect(report.unknownOutcomeClaims).toEqual([]);
    expect(report.stoppedProcessGenerationIds).toEqual([]);
    expect(report.recoveredCommits).toEqual([]);
  });
});
