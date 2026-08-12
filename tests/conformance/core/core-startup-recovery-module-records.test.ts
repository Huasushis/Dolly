import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CoreStartupRecovery,
  CoreStartupRecoveryError,
  moduleProcessStopProofIdentityDigest,
  type CoreStartupStateStore,
  type ExternalEffectEvidence,
  type ExternalEffectEvidenceSource,
  type ModuleProcessStopProver,
  type ModuleProcessStopProof,
} from "../../../src/core/core-startup-recovery.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import {
  EffectIntentJournal,
  effectIntentEvidenceSource,
} from "../../../src/core/capabilities/effect-intent-journal.js";
import { FileEffectIntentStore } from "../../../src/core/capabilities/file-effect-intent-store.js";
import {
  createFileCoreStateStoreWithStoppedRecordWriter,
  FileCoreStateStore,
} from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { ModuleResultCommitCoordinator } from "../../../src/core/module-result-commit.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type {
  ModuleProcessRecord,
  ModuleProcessStoppedRecordWriter,
  ModuleSubmissionRecord,
} from "../../../src/core/module-process-records.js";

const NOW = "2026-07-26T00:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
/** The shapes systemd and the Linux kernel report; a record stores no other. */
const INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";

describe("CORE startup reconciliation with Module records", () => {
  let root: string;
  let statePath: string;
  let journalPath: string;
  const stoppedRecordWriters = new WeakMap<
    FileCoreStateStore,
    ModuleProcessStoppedRecordWriter
  >();

  function openStore(prefix: string, path = statePath): FileCoreStateStore {
    let blockId = 0;
    let runtimeId = 0;
    const created = createFileCoreStateStoreWithStoppedRecordWriter({
      path,
      maxFailedAttempts: 3,
      nextBlockId: () => `${prefix}-block-${++blockId}`,
      nextDeliveryId: (kind) => `${prefix}-${kind}-${++runtimeId}`,
      now: () => NOW,
    });
    stoppedRecordWriters.set(created.store, created.stoppedRecordWriter);
    return created.store;
  }

  function stoppedRecordWriterFor(
    store: FileCoreStateStore,
  ): ModuleProcessStoppedRecordWriter {
    const writer = stoppedRecordWriters.get(store);
    if (!writer) throw new Error("Test store has no stopped-record writer");
    return writer;
  }

  function openCommits(store: FileCoreStateStore): ModuleResultCommitCoordinator {
    return new ModuleResultCommitCoordinator({
      blocks: store.blocks,
      deliveries: store.deliveries,
      getModuleSubmissionRecord: (runId) =>
        store.getModuleSubmissionRecord(runId),
      acknowledgeDeliveryClaim: (identity) => store.acknowledgeDeliveryClaim(identity),
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
    inputDigest: string;
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
      inputDigest: canonicalJsonDigest(store.deliveries.inspectClaimInput(claim)),
    };
  }

  function submissionFor(
    claim: {
      moduleJobId: string;
      claimToken: string;
      runId: string;
      attempt: number;
      inputDigest: string;
    },
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
      inputDigest: claim.inputDigest,
      createdAt: NOW,
      ...overrides,
    } as ModuleSubmissionRecord;
  }

  function exactIdentity(
    claim: ReturnType<typeof seedActiveClaim>,
  ): ReturnType<
    FileCoreStateStore["listActiveClaimsWithUnknownSubmissionHistory"]
  >[number] {
    return {
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
    };
  }

  /**
   * Supplies a deliberately inconsistent submission-record view without using
   * a product write API to create an invalid Core-state update.
   */
  function withSubmissionRecords(
    store: FileCoreStateStore,
    submissionRecords: readonly ModuleSubmissionRecord[],
    releaseDeliveryClaim: CoreStartupStateStore["releaseDeliveryClaim"] = (identity) =>
      store.releaseDeliveryClaim(identity),
    getModuleSubmissionRecord: CoreStartupStateStore["getModuleSubmissionRecord"] = (
      runId,
    ) => submissionRecords.find((record) => record.runId === runId),
  ): CoreStartupStateStore {
    return {
      listModuleProcessRecords: () => store.listModuleProcessRecords(),
      listModuleSubmissionRecords: () => submissionRecords,
      getModuleProcessRecord: (processGenerationId) =>
        store.getModuleProcessRecord(processGenerationId),
      getModuleSubmissionRecord,
      listActiveClaimsWithUnknownSubmissionHistory: () =>
        store.listActiveClaimsWithUnknownSubmissionHistory(),
      hasActiveClaimWithUnknownSubmissionHistory: (identity) =>
        store.hasActiveClaimWithUnknownSubmissionHistory(identity),
      updateModuleProcessRecordState: (processGenerationId, state, failureCode) =>
        store.updateModuleProcessRecordState(processGenerationId, state, failureCode),
      releaseDeliveryClaim,
      removeModuleProcessRecord: (processGenerationId) =>
        store.removeModuleProcessRecord(processGenerationId),
      runAtomicUpdate: (operation) => store.runAtomicUpdate(operation),
    };
  }

  function withUnknownSubmissionHistory(
    store: FileCoreStateStore,
    identities: ReturnType<
      FileCoreStateStore["listActiveClaimsWithUnknownSubmissionHistory"]
    >,
    hasIdentity: CoreStartupStateStore["hasActiveClaimWithUnknownSubmissionHistory"] = (
      supplied,
    ) =>
      identities.some(
        (identity) =>
          identity.moduleJobId === supplied.moduleJobId &&
          identity.claimToken === supplied.claimToken &&
          identity.runId === supplied.runId &&
          identity.attempt === supplied.attempt &&
          identity.moduleGenerationId === supplied.moduleGenerationId,
      ),
    submissionRecords: readonly ModuleSubmissionRecord[] =
      store.listModuleSubmissionRecords(),
  ): CoreStartupStateStore {
    return {
      ...withSubmissionRecords(store, submissionRecords),
      listActiveClaimsWithUnknownSubmissionHistory: () => identities,
      hasActiveClaimWithUnknownSubmissionHistory: hasIdentity,
    };
  }

  const provenStopped = {
    proveStopped: async (
      record: ModuleProcessRecord,
    ): Promise<ModuleProcessStopProof> => ({
      proven: true,
      evidence: "populated-zero",
      recordIdentityDigest: moduleProcessStopProofIdentityDigest(record),
    }),
  };
  const unprovenStop = {
    proveStopped: async (): Promise<ModuleProcessStopProof> => ({
      proven: false,
      reason: "cgroup.events still reports populated 1",
    }),
  };
  const invalidProcessStopProofs: readonly (readonly [string, unknown])[] = [
    [
      "a truthy non-boolean proven property",
      { proven: "yes", evidence: "populated-zero" },
    ],
    [
      "an unsupported evidence value",
      { proven: true, evidence: "process-identifier" },
    ],
    ["null", null],
  ];
  const invalidExternalEffectEvidenceResults: readonly (
    readonly [string, () => unknown]
  )[] = [
    ["null", () => Promise.resolve(null)],
    [
      "an unknown kind",
      () => Promise.resolve({ kind: "provider-finished" }),
    ],
    [
      "an unknown decision without a reason",
      () => Promise.resolve({ kind: "unknown" }),
    ],
    [
      "a non-Promise thenable",
      () => ({
        then(resolve: (value: ExternalEffectEvidence) => void): void {
          resolve({ kind: "no-effect" });
        },
      }),
    ],
  ];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-startup-recovery-"));
    statePath = join(root, "core-state.json");
    journalPath = join(root, "module-result-commits.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("releases a version 17 Claim that was never authorized to send", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);

    const report = await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: store,
    }).recover();

    expect(report.releasedClaims).toEqual([
      expect.objectContaining({
        runId: claim.runId,
        reason: "never-authorized-to-send",
      }),
    ]);
    expect(store.deliveries.listActiveClaims()).toEqual([]);
  });

  it("keeps a migrated Claim unresolved when its submission history is unknown", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withUnknownSubmissionHistory(store, [exactIdentity(claim)]),
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_ACTIVE_CLAIM_UNRESOLVED",
    });

    const reopened = openStore("second");
    expect(reopened.deliveries.listActiveClaims()).toEqual([
      expect.objectContaining({ runId: claim.runId, status: "active" }),
    ]);
    expect(reopened.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "stopped",
    });
  });

  it("releases a never-authorized Claim only after every old process is proven stopped", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());

    const report = await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: store,
      stoppedRecordWriter: stoppedRecordWriterFor(store),
      processStopProver: provenStopped,
    }).recover();

    expect(report).toMatchObject({
      releasedClaims: [
        { runId: claim.runId, reason: "never-authorized-to-send" },
      ],
      stoppedProcessGenerationIds: ["process-generation-1"],
      collectedRecords: { processRecords: 1 },
    });
    expect(store.deliveries.inspectClaim(claim).status).toBe("released");
  });

  it.each([
    ["Module job identifier", { moduleJobId: "different-module-job" }],
    ["Claim token", { claimToken: "different-claim-token" }],
    ["Run identifier", { runId: "different-run" }],
    ["attempt number", { attempt: 2 }],
    [
      "Module generation identifier",
      { moduleGenerationId: "different-module-generation" },
    ],
  ] as const)(
    "rejects unknown submission history with a mismatched %s",
    async (_field, override) => {
      const store = openStore("first");
      const claim = seedActiveClaim(store);
      const mismatched = {
        ...exactIdentity(claim),
        ...override,
      };

      await expect(
        new CoreStartupRecovery({
          deliveries: store.deliveries,
          commits: openCommits(store),
          moduleRecords: withUnknownSubmissionHistory(store, [mismatched]),
        }).recover(),
      ).rejects.toMatchObject({
        code: "STARTUP_MODULE_RECORD_INCONSISTENT",
      });
      expect(store.deliveries.inspectClaim(claim).status).toBe("active");
    },
  );

  it("rejects duplicate unknown submission-history entries", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withUnknownSubmissionHistory(store, [
          exactIdentity(claim),
          exactIdentity(claim),
        ]),
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_MODULE_RECORD_INCONSISTENT",
    });
    expect(store.deliveries.inspectClaim(claim).status).toBe("active");
  });

  it("rejects a Claim present in both submission-history classifications", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const submission = submissionFor(claim);

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withUnknownSubmissionHistory(
          store,
          [exactIdentity(claim)],
          undefined,
          [submission],
        ),
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_MODULE_RECORD_INCONSISTENT",
    });
    expect(store.deliveries.inspectClaim(claim).status).toBe("active");
  });

  it("rejects disagreement between the unknown-history list and exact query", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withUnknownSubmissionHistory(
          store,
          [],
          (identity) => identity.runId === claim.runId,
        ),
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_MODULE_RECORD_INCONSISTENT",
    });
    expect(store.deliveries.inspectClaim(claim).status).toBe("active");
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
        stoppedRecordWriter: stoppedRecordWriterFor(store),
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

  it("refuses to trust an existing stopped label without a fresh proof and preserves it", async () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    stoppedRecordWriterFor(store).writeStopped("process-generation-1");
    const beforeRevision = store.revision;

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_MODULE_PROCESS_UNPROVEN",
      message: expect.stringContaining("stopped and no fresh stop proof is available"),
    });

    expect(store.revision).toBe(beforeRevision);
    expect(store.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "stopped",
    });
    const reopened = openStore("second");
    expect(reopened.revision).toBe(beforeRevision);
    expect(reopened.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "stopped",
    });
  });

  it("rejects a structured stop proof without the store-bound writer and preserves durable state", async () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    const beforeRevision = store.revision;

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_MODULE_PROCESS_UNPROVEN",
      message: expect.stringContaining("does not hold its store-bound stopped-record writer"),
    });

    expect(store.revision).toBe(beforeRevision);
    expect(store.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "starting",
    });
    const reopened = openStore("second");
    expect(reopened.revision).toBe(beforeRevision);
    expect(reopened.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "starting",
    });
  });

  it("accepts a fresh proof for an existing stopped record without distributing write authority", async () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    stoppedRecordWriterFor(store).writeStopped("process-generation-1");

    const report = await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: store,
      processStopProver: provenStopped,
    }).recover();

    expect(report.stoppedProcessGenerationIds).toEqual(["process-generation-1"]);
    expect(report.collectedRecords.processRecords).toBe(1);
    expect(store.getModuleProcessRecord("process-generation-1")).toBeUndefined();
  });

  it("rejects a failed fresh proof for an existing stopped record", async () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    stoppedRecordWriterFor(store).writeStopped("process-generation-1");
    const beforeRevision = store.revision;

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        processStopProver: unprovenStop,
      }).recover(),
    ).rejects.toMatchObject({ code: "STARTUP_MODULE_PROCESS_UNPROVEN" });

    expect(store.revision).toBe(beforeRevision);
    expect(store.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "stopped",
    });
  });

  it("rejects a structural stopped-record writer that performs no durable write", async () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    const beforeRevision = store.revision;

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        stoppedRecordWriter: {
          isStoreBoundTo: () => true,
          isBoundTo: () => true,
          writeStopped: () => processRecord({ state: "stopped" }),
        },
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_MODULE_PROCESS_UNPROVEN",
      message: expect.stringContaining("did not update process generation"),
    });

    expect(store.revision).toBe(beforeRevision);
    expect(store.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "starting",
    });
  });

  it("rejects a stopped-record writer bound to a different state store", async () => {
    const store = openStore("first");
    const otherStore = openStore("other", join(root, "other-core-state.json"));
    store.appendModuleProcessRecord(processRecord());
    otherStore.appendModuleProcessRecord(processRecord());

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        stoppedRecordWriter: stoppedRecordWriterFor(otherStore),
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_MODULE_PROCESS_UNPROVEN",
      message: expect.stringContaining("is not bound to process generation"),
    });

    expect(store.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "starting",
    });
    expect(otherStore.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "starting",
    });
  });

  it.each(invalidProcessStopProofs)(
    "keeps the Claim active when the stop prover returns %s",
    async (_description, proof) => {
      const store = openStore("first");
      seedActiveClaim(store);
      store.appendModuleProcessRecord(processRecord());
      const processStopProver = {
        proveStopped: (() => Promise.resolve(proof)) as unknown as
          ModuleProcessStopProver["proveStopped"],
      };

      await expect(
        new CoreStartupRecovery({
          deliveries: store.deliveries,
          commits: openCommits(store),
          moduleRecords: store,
          stoppedRecordWriter: stoppedRecordWriterFor(store),
          processStopProver,
        }).recover(),
      ).rejects.toMatchObject({
        code: "STARTUP_MODULE_PROCESS_UNPROVEN",
      });

      expect(store.deliveries.listActiveClaims()).toHaveLength(1);
      expect(store.getModuleProcessRecord("process-generation-1")).toMatchObject({
        state: "starting",
      });
    },
  );

  it("rejects a valid stop proof that belongs to a different process record", async () => {
    const store = openStore("first");
    seedActiveClaim(store);
    const record = processRecord();
    const otherRecord = processRecord({
      processGenerationId: "process-generation-other",
    });
    store.appendModuleProcessRecord(record);

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: {
          proveStopped: async (): Promise<ModuleProcessStopProof> => ({
            proven: true,
            evidence: "populated-zero",
            recordIdentityDigest:
              moduleProcessStopProofIdentityDigest(otherRecord),
          }),
        },
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_MODULE_PROCESS_UNPROVEN",
      message: expect.stringContaining(
        "does not match process generation process-generation-1",
      ),
    });
    expect(store.getModuleProcessRecord(record.processGenerationId)).toMatchObject({
      state: "starting",
    });
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
        stoppedRecordWriter: stoppedRecordWriterFor(store),
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
        stoppedRecordWriter: stoppedRecordWriterFor(store),
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
      stoppedRecordWriter: stoppedRecordWriterFor(store),
      processStopProver: provenStopped,
    }).recover();

    expect(report.releasedClaims).toEqual([
      expect.objectContaining({ runId: claim.runId, reason: "no-external-effect" }),
    ]);
    const reopened = openStore("second");
    expect(reopened.deliveries.listActiveClaims()).toEqual([]);
    expect(reopened.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
  });

  it.each(["no-effect", "retry-safe"] as const)(
    "releases a submitted Run whose effects have persistent %s evidence",
    async (kind) => {
      const store = openStore("first");
      const claim = seedActiveClaim(store);
      store.appendModuleProcessRecord(processRecord());
      store.updateModuleProcessRecordState("process-generation-1", "running");
      store.appendModuleSubmissionRecord(submissionFor(claim));

      const report = await new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: store,
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
        externalEffectEvidence: {
          inspectRunEffects: async (): Promise<ExternalEffectEvidence> => ({
            kind,
          }),
        },
      }).recover();

      expect(report.releasedClaims).toEqual([
        expect.objectContaining({ reason: "external-effects-safe-to-retry" }),
      ]);
      expect(store.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
    },
  );

  it("does not treat an empty capability journal as proof that an ordinary process made no ambient effect", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord({
      declaredExternalEffects: "unrestricted",
    }));
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionFor(claim));
    const journal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path: join(root, "effect-intents.json") }),
      now: () => NOW,
    });
    const identity = exactIdentity(claim);
    journal.openRun(identity);
    journal.closeRun(identity);
    expect(journal.evidenceForRun(identity)).toEqual({ kind: "no-effect" });

    await expect(new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: store,
      stoppedRecordWriter: stoppedRecordWriterFor(store),
      processStopProver: provenStopped,
      externalEffectEvidence: effectIntentEvidenceSource(journal),
    }).recover()).rejects.toMatchObject({
      code: "STARTUP_ACTIVE_CLAIM_UNRESOLVED",
      message: expect.stringContaining("ambient effects are not excluded"),
    });

    expect(store.deliveries.inspectClaim(claim).status).toBe("active");
    expect(store.getModuleSubmissionRecord(claim.runId)).toBeDefined();
  });

  it("preserves a submitted Run with terminal evidence because it does not prove retry safety", async () => {
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
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
        externalEffectEvidence: {
          inspectRunEffects: async (): Promise<ExternalEffectEvidence> => ({
            kind: "terminal",
          }),
        },
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_ACTIVE_CLAIM_UNRESOLVED",
      message: expect.stringContaining(
        "no durable idempotency contract proves that repeating the Run is safe",
      ),
    });

    expect(store.deliveries.inspectClaim(claim).status).toBe("active");
    expect(store.getModuleSubmissionRecord(claim.runId)).toBeDefined();
  });

  it.each(invalidExternalEffectEvidenceResults)(
    "keeps the Claim active when external-effect evidence returns %s",
    async (_description, inspectRunEffectsResult) => {
      const store = openStore("first");
      const claim = seedActiveClaim(store);
      store.appendModuleProcessRecord(processRecord());
      store.updateModuleProcessRecordState("process-generation-1", "running");
      store.appendModuleSubmissionRecord(submissionFor(claim));
      const externalEffectEvidence = {
        inspectRunEffects: inspectRunEffectsResult as unknown as
          ExternalEffectEvidenceSource["inspectRunEffects"],
      };

      await expect(
        new CoreStartupRecovery({
          deliveries: store.deliveries,
          commits: openCommits(store),
          moduleRecords: store,
          stoppedRecordWriter: stoppedRecordWriterFor(store),
          processStopProver: provenStopped,
          externalEffectEvidence,
        }).recover(),
      ).rejects.toMatchObject({
        code: "STARTUP_ACTIVE_CLAIM_UNRESOLVED",
      });

      expect(store.deliveries.inspectClaim(claim)).toMatchObject({
        runId: claim.runId,
        status: "active",
      });
      expect(store.getModuleSubmissionRecord(claim.runId)).toBeDefined();
    },
  );

  it("fails closed when Claim release reports success without changing Core state", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(
      processRecord({ declaredExternalEffects: "none" }),
    );
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const submission = store.appendModuleSubmissionRecord(submissionFor(claim));

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withSubmissionRecords(
          store,
          [submission],
          () => "released",
        ),
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
    });

    expect(store.deliveries.inspectClaim(claim).status).toBe("active");
    expect(store.getModuleSubmissionRecord(claim.runId)).toBeDefined();
  });

  it("does not report release while the submission-record view still contains the Run", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(
      processRecord({ declaredExternalEffects: "none" }),
    );
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const submission = store.appendModuleSubmissionRecord(submissionFor(claim));

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withSubmissionRecords(
          store,
          [submission],
          (identity) => store.releaseDeliveryClaim(identity),
        ),
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
    });

    expect(store.deliveries.inspectClaim(claim).status).toBe("released");
    expect(store.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
  });

  it("accepts a callback error only after both release effects are confirmed", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(
      processRecord({ declaredExternalEffects: "none" }),
    );
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const submission = store.appendModuleSubmissionRecord(submissionFor(claim));

    const report = await new CoreStartupRecovery({
      deliveries: store.deliveries,
      commits: openCommits(store),
      moduleRecords: withSubmissionRecords(
        store,
        [submission],
        (identity) => {
          store.releaseDeliveryClaim(identity);
          throw new Error("simulated error after persistence");
        },
        (runId) => store.getModuleSubmissionRecord(runId),
      ),
      stoppedRecordWriter: stoppedRecordWriterFor(store),
      processStopProver: provenStopped,
    }).recover();

    expect(report.releasedClaims).toEqual([
      expect.objectContaining({ runId: claim.runId, reason: "no-external-effect" }),
    ]);
    expect(store.deliveries.inspectClaim(claim).status).toBe("released");
    expect(store.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
  });

  it("fails closed when Claim release changes a different Core-state file", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(
      processRecord({ declaredExternalEffects: "none" }),
    );
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const submission = store.appendModuleSubmissionRecord(submissionFor(claim));

    const otherStore = openStore("first", join(root, "other-core-state.json"));
    const otherClaim = seedActiveClaim(otherStore);
    otherStore.appendModuleProcessRecord(
      processRecord({ declaredExternalEffects: "none" }),
    );
    otherStore.updateModuleProcessRecordState("process-generation-1", "running");
    otherStore.appendModuleSubmissionRecord(submissionFor(otherClaim));

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withSubmissionRecords(
          store,
          [submission],
          (identity) => otherStore.releaseDeliveryClaim(identity),
        ),
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
    });

    expect(store.deliveries.inspectClaim(claim).status).toBe("active");
    expect(store.getModuleSubmissionRecord(claim.runId)).toBeDefined();
    expect(otherStore.deliveries.inspectClaim(otherClaim).status).toBe("released");
  });

  it("fails closed when Claim release returns a Promise", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(
      processRecord({ declaredExternalEffects: "none" }),
    );
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const submission = store.appendModuleSubmissionRecord(submissionFor(claim));
    const asynchronousRelease = (() =>
      Promise.resolve("released")) as unknown as CoreStartupStateStore["releaseDeliveryClaim"];

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withSubmissionRecords(
          store,
          [submission],
          asynchronousRelease,
        ),
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_CLAIM_RELEASE_UNCONFIRMED",
    });

    expect(store.deliveries.inspectClaim(claim).status).toBe("active");
    expect(store.getModuleSubmissionRecord(claim.runId)).toBeDefined();
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
      stoppedRecordWriter: stoppedRecordWriterFor(store),
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
    const submission = store.appendModuleSubmissionRecord(submissionFor(claim));
    const mismatched = {
      ...submission,
      claimToken: "claim-token-that-does-not-match",
    };

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withSubmissionRecords(store, [mismatched]),
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CoreStartupRecoveryError>>({
        code: "STARTUP_MODULE_RECORD_INCONSISTENT",
      }),
    );
    expect(store.deliveries.listActiveClaims()).toHaveLength(1);
  });

  it("fails closed when a terminal Claim still has a submission record", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const submission = store.appendModuleSubmissionRecord(submissionFor(claim));
    store.releaseDeliveryClaim(claim);

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withSubmissionRecords(store, [submission]),
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_MODULE_RECORD_INCONSISTENT",
    });
    expect(store.deliveries.inspectClaim(claim).status).toBe("released");
  });

  it("keeps a migrated Claim unresolved after two stopped process attempts", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    stoppedRecordWriterFor(store).writeStopped("process-generation-1");
    store.appendModuleProcessRecord(
      processRecord({ processGenerationId: "process-generation-2" }),
    );

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withUnknownSubmissionHistory(store, [exactIdentity(claim)]),
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_ACTIVE_CLAIM_UNRESOLVED",
    });
    expect(store.deliveries.listActiveClaims()).toEqual([
      expect.objectContaining({ runId: claim.runId, status: "active" }),
    ]);
    expect(store.listModuleProcessRecords()).toEqual([
      expect.objectContaining({ processGenerationId: "process-generation-1", state: "stopped" }),
      expect.objectContaining({ processGenerationId: "process-generation-2", state: "stopped" }),
    ]);
  });

  it("proves every old process stopped before classifying migrated Claim history", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    stoppedRecordWriterFor(store).writeStopped("process-generation-1");
    store.appendModuleProcessRecord(
      processRecord({ processGenerationId: "process-generation-2" }),
    );
    const provedProcessGenerationIds: string[] = [];
    const refusesSecondProcess = {
      proveStopped: async (
        record: ModuleProcessRecord,
      ): Promise<ModuleProcessStopProof> => {
        provedProcessGenerationIds.push(record.processGenerationId);
        if (record.processGenerationId === "process-generation-2") {
          return {
            proven: false,
            reason: "the second cgroup is still populated",
          };
        }
        return {
          proven: true,
          evidence: "populated-zero",
          recordIdentityDigest: moduleProcessStopProofIdentityDigest(record),
        };
      },
    };

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withUnknownSubmissionHistory(store, [exactIdentity(claim)]),
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: refusesSecondProcess,
      }).recover(),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CoreStartupRecoveryError>>({
        code: "STARTUP_MODULE_PROCESS_UNPROVEN",
      }),
    );
    expect(provedProcessGenerationIds).toEqual([
      "process-generation-1",
      "process-generation-2",
    ]);
    expect(store.deliveries.listActiveClaims()).toHaveLength(1);
    expect(store.getModuleProcessRecord("process-generation-2")).toMatchObject({
      state: "starting",
    });
  });

  it("does not collect a process record when a terminal Claim still has a submission record", async () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const submission = store.appendModuleSubmissionRecord(submissionFor(claim));
    stoppedRecordWriterFor(store).writeStopped("process-generation-1");
    store.releaseDeliveryClaim(claim);

    await expect(
      new CoreStartupRecovery({
        deliveries: store.deliveries,
        commits: openCommits(store),
        moduleRecords: withSubmissionRecords(store, [submission]),
        stoppedRecordWriter: stoppedRecordWriterFor(store),
        processStopProver: provenStopped,
      }).recover(),
    ).rejects.toMatchObject({
      code: "STARTUP_MODULE_RECORD_INCONSISTENT",
    });
    expect(store.listModuleProcessRecords()).toEqual([
      expect.objectContaining({ processGenerationId: "process-generation-1", state: "stopped" }),
    ]);
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
        stoppedRecordWriter: stoppedRecordWriterFor(store),
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
