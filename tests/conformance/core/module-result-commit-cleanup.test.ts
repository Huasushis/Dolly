import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { BlockStore, type BlockProposal, type BlockStoreSnapshot } from "../../../src/core/block-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import { canonicalJsonDigest, type JsonValue } from "../../../src/core/canonical-json.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { createModuleResultCommitCoordinator } from "../../../src/core/module-result-commit-factory.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
const NOW = "2026-07-24T00:00:00.000Z";
const moduleSource = { kind: "module", id: "worker" } as const;
const externalSource = { kind: "external", id: "console" } as const;

function proposal(text: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "text", text, format: "plain" }] },
    },
  };
}

/**
 * A Module-result Block commit effect is identified by the same effect-id
 * derivation the coordinator uses: the canonical digest of the literal
 * marker tuple `["module-result-commit-block", moduleJobId]`. Reusing the
 * exact derivation keeps this test tied to the real cleanup boundary rather
 * than a separately invented identifier.
 */
function moduleResultBlockEffectId(moduleJobId: string): string {
  return canonicalJsonDigest(["module-result-commit-block", moduleJobId]);
}

interface StoreHarness {
  readonly blocks: BlockStore;
  nextId(): string;
}

function createStore(): StoreHarness {
  let issued = 0;
  const nextId = (): string => `block-${++issued}`;
  const blocks = new BlockStore({ nextBlockId: nextId, now: () => NOW });
  return { blocks, nextId };
}

function restore(snapshot: BlockStoreSnapshot, referenceGraph: ReferenceGraph): BlockStore {
  return new BlockStore({
    nextBlockId: () => "block-after-restart",
    now: () => NOW,
    referenceGraph,
    snapshot: structuredClone(snapshot),
  });
}

function restoreFrom(blocks: BlockStore): BlockStore {
  return restore(
    blocks.snapshot(),
    new ReferenceGraph({ snapshot: structuredClone(blocks.referenceGraph.snapshot()) }),
  );
}

describe("CORE-005 Module-result Block commit-effect retirement (RED)", () => {
  it("retires a released Module-result Block effect tombstone after staging a durable ticket", () => {
    const harness = createStore();
    const blocks = harness.blocks;

    // One raw, foreign Block committed through the public `commit` path has
    // no commit-effect entry: it must never be eligible for retirement.
    blocks.commit(proposal("raw external input"), externalSource);
    expect(blocks.size).toBe(1);

    const moduleEffectId = moduleResultBlockEffectId("module-job-1");
    const moduleJobId = "moduleJobId-1";
    blocks.commitOnce(moduleEffectId, proposal("module output"), moduleSource);
    expect(blocks.size).toBe(2);
    expect(blocks.inspectCommitEffect(moduleEffectId)).toMatchObject({
      strongReferenceHeld: true,
    });

    // The coordinator releases the strong reference once the result journal
    // is committed. The Block record becomes a collection candidate.
    blocks.releaseCommitEffect(moduleEffectId);
    blocks.collectUnreachable();
    expect(blocks.size).toBe(0);

    // The coordinator stages a durable ticket binding the exact job, Block,
    // and digest, then retires the effect. The ticket survives the removal so
    // a crash before the journal delete is distinguishable from corruption.
    const blockId = blocks.inspectCommitEffect(moduleEffectId)!.record.id;
    blocks.stageCommitEffectRetirement(moduleEffectId, {
      schemaVersion: "dolly.commit-effect-retirement/1",
      moduleJobId: moduleJobId,
      blockId,
      digest: canonicalJsonDigest({
        proposal: proposal("module output"),
        source: moduleSource,
      }),
    });
    expect(blocks.retireCommitEffect(moduleEffectId)).toBe("retired");
    expect(blocks.inspectCommitEffect(moduleEffectId)).toBeNull();
    // The ticket is retained (not cleared) so restart recovery can finish the
    // separate journal delete without wedging.
    expect(
      blocks.inspectCommitEffectRetirementTicket(moduleEffectId),
    ).toMatchObject({ moduleJobId, blockId });

    // Reopen: the retired tombstone stays gone and the ticket survives as the
    // recovery anchor for the not-yet-deleted journal record.
    const reopened = restoreFrom(blocks);
    expect(reopened.inspectCommitEffect(moduleEffectId)).toBeNull();
    expect(
      reopened.inspectCommitEffectRetirementTicket(moduleEffectId),
    ).toMatchObject({ moduleJobId, blockId });

    // The coordinator clears the ticket only after the journal delete
    // succeeds. Clearing is the last residue to drop.
    expect(reopened.clearCommitEffectRetirementTicket(moduleEffectId)).toBe("cleared");
    expect(reopened.inspectCommitEffectRetirementTicket(moduleEffectId)).toBeNull();
  });

  it("rejects staging a retirement ticket while the effect holds its strong reference", () => {
    const harness = createStore();
    const blocks = harness.blocks;
    const moduleEffectId = moduleResultBlockEffectId("module-job-2");
    blocks.commitOnce(moduleEffectId, proposal("module output"), moduleSource);

    const { record } = blocks.inspectCommitEffect(moduleEffectId)!;
    expect(() =>
      blocks.stageCommitEffectRetirement(moduleEffectId, {
        schemaVersion: "dolly.commit-effect-retirement/1",
        moduleJobId: "moduleJobId-2",
        blockId: record.id,
        digest: canonicalJsonDigest({
          proposal: proposal("module output"),
          source: moduleSource,
        }),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "BLOCK_EFFECT_CONFLICT" }),
    );
    expect(blocks.inspectCommitEffect(moduleEffectId)).not.toBeNull();
  });

  it("rejects a retirement ticket that binds the wrong Block or digest", () => {
    const harness = createStore();
    const blocks = harness.blocks;
    const moduleEffectId = moduleResultBlockEffectId("module-job-3");
    blocks.commitOnce(moduleEffectId, proposal("module output"), moduleSource);
    blocks.releaseCommitEffect(moduleEffectId);
    const { record } = blocks.inspectCommitEffect(moduleEffectId)!;

    // A ticket that disagrees with the exact effect identity is forged or
    // corrupted and must be rejected before any retirement.
    expect(() =>
      blocks.stageCommitEffectRetirement(moduleEffectId, {
        schemaVersion: "dolly.commit-effect-retirement/1",
        moduleJobId: "moduleJobId-3",
        blockId: "block-some-other-block",
        digest: canonicalJsonDigest({
          proposal: proposal("module output"),
          source: moduleSource,
        }),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "BLOCK_EFFECT_CONFLICT" }),
    );
    expect(() =>
      blocks.stageCommitEffectRetirement(moduleEffectId, {
        schemaVersion: "dolly.commit-effect-retirement/1",
        moduleJobId: "moduleJobId-3",
        blockId: record.id,
        digest: canonicalJsonDigest({
          proposal: proposal("different output"),
          source: moduleSource,
        }),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "BLOCK_EFFECT_CONFLICT" }),
    );
    expect(blocks.inspectCommitEffect(moduleEffectId)).not.toBeNull();
  });

  it("does not make a foreign SourceActivation/raw Block effect eligible for retirement without a matching durable ticket", () => {
    const harness = createStore();
    const blocks = harness.blocks;

    const foreignEffectId = canonicalJsonDigest(["source-activation-block", "source-1"]);
    // SourceActivationQueue commits foreign effects through `commitOnce`
    // without an owner; they are outside the Module-result cleanup.
    blocks.commitOnce(foreignEffectId, proposal("foreign"), moduleSource);
    blocks.releaseCommitEffect(foreignEffectId);

    // No Module-result record ever stages a ticket for a foreign effect, and
    // retirement without the coordinator's durable ticket is a hard conflict.
    expect(() =>
      blocks.retireCommitEffect(foreignEffectId),
    ).toThrowError(
      expect.objectContaining({ code: "BLOCK_EFFECT_CONFLICT" }),
    );
    expect(
      blocks.inspectCommitEffectRetirementTicket(foreignEffectId),
    ).toBeNull();

    // The foreign effect tombstone must remain intact across reopen, and a
    // legacy v3 snapshot (which carries no ticket metadata) must also keep
    // its effect non-retireable.
    const reopened = restoreFrom(blocks);
    expect(reopened.inspectCommitEffect(foreignEffectId)).not.toBeNull();
  });

  it("preserves a legacy v3 snapshot effect without tickets as not retireable", () => {
    const harness = createStore();
    const blocks = harness.blocks;
    const legacyEffectId = "legacy-effect-1";
    blocks.commitOnce(legacyEffectId, proposal("legacy"), moduleSource);
    blocks.releaseCommitEffect(legacyEffectId);

    // A v3 legacy snapshot carries no retirement ticket metadata. Restoring
    // it must keep the effect intact and non-retireable.
    const legacySnapshot = structuredClone(blocks.snapshot()) as BlockStoreSnapshot;
    const reopened = restore(legacySnapshot, new ReferenceGraph({
      snapshot: structuredClone(blocks.referenceGraph.snapshot()),
    }));
    expect(reopened.inspectCommitEffect(legacyEffectId)).not.toBeNull();
    expect(() =>
      reopened.retireCommitEffect(legacyEffectId),
    ).toThrowError(
      expect.objectContaining({ code: "BLOCK_EFFECT_CONFLICT" }),
    );
    expect(reopened.inspectCommitEffect(legacyEffectId)).not.toBeNull();
  });

  it("forbids re-committing a retired effect while its ticket is staged", () => {
    const harness = createStore();
    const blocks = harness.blocks;
    const moduleEffectId = moduleResultBlockEffectId("module-job-4");
    const moduleJobId = "moduleJobId-4";
    blocks.commitOnce(moduleEffectId, proposal("module output"), moduleSource);
    blocks.releaseCommitEffect(moduleEffectId);
    const { record } = blocks.inspectCommitEffect(moduleEffectId)!;
    blocks.stageCommitEffectRetirement(moduleEffectId, {
      schemaVersion: "dolly.commit-effect-retirement/1",
      moduleJobId,
      blockId: record.id,
      digest: canonicalJsonDigest({
        proposal: proposal("module output"),
        source: moduleSource,
      }),
    });
    blocks.retireCommitEffect(moduleEffectId);
    expect(blocks.inspectCommitEffect(moduleEffectId)).toBeNull();
    expect(
      blocks.inspectCommitEffectRetirementTicket(moduleEffectId),
    ).not.toBeNull();

    // Replaying the commit during in-flight retirement (effect tombstone
    // gone, journal delete pending, ticket present) must not silently mint a
    // replacement Block nor clear the ticket.
    expect(() =>
      blocks.commitOnce(moduleEffectId, proposal("module output"), moduleSource),
    ).toThrowError(
      expect.objectContaining({ code: "BLOCK_EFFECT_CONFLICT" }),
    );
    expect(blocks.inspectCommitEffect(moduleEffectId)).toBeNull();
    expect(
      blocks.inspectCommitEffectRetirementTicket(moduleEffectId),
    ).not.toBeNull();
  });
});

describe("CORE-005 Module-result Block commit-effect retirement lifecycle", () => {
  const mailboxes = [
    { consumerId: "sink", pageIds: ["output"], maxResidentCount: 8, maxResidentBytes: 1024 * 1024 },
  ];

  function persistSubmittedClaim(
    core: FileCoreStateStore,
    moduleId: string,
    claim: { attempt: number; claimToken: string; moduleGenerationId: string; moduleJobId: string; runId: string },
  ): void {
    const processGenerationId = `${moduleId}-process-generation`;
    core.appendModuleProcessRecord({
      schemaVersion: "dolly.module-process-record/1",
      instanceId: "cleanup-instance",
      moduleId,
      moduleGenerationId: claim.moduleGenerationId,
      processGenerationId,
      packageDigest: `sha256:${"a".repeat(64)}`,
      configurationReference: { configId: `${moduleId}-config`, revision: `sha256:${"b".repeat(64)}`, configVersion: 1 },
      declaredExternalEffects: "core-capabilities-only",
      serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
      bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
      moduleCgroupPath: deriveModuleCgroupPath("/system.slice/dolly-core.service", { instanceId: "cleanup-instance", moduleId, processGenerationId }).filesystemPath,
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
      inputDigest: canonicalJsonDigest(core.deliveries.inspectClaimInput(claim) as unknown as JsonValue),
      createdAt: NOW,
    });
  }

  function setupOutput(core: FileCoreStateStore): void {
    core.deliveries.createPage("output");
    core.deliveries.registerConsumer("output", "sink", "from-now");
  }

  function setupWorker(core: FileCoreStateStore, moduleId: string, inputPageId: string): { moduleJobId: string; claimToken: string; runId: string; attempt: number; moduleGenerationId: string } {
    core.deliveries.createPage(inputPageId);
    core.deliveries.registerConsumer(inputPageId, moduleId, "from-now");
    const inputBlock = core.blocks.commit(proposal(`${moduleId} input`), externalSource);
    core.deliveries.append(inputPageId, inputBlock.id);
    const claim = core.deliveries.claim({
      consumerId: moduleId,
      pageIds: [inputPageId],
      moduleGenerationId: `${moduleId}-generation`,
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    persistSubmittedClaim(core, moduleId, claim);
    return claim;
  }

  it("retires the owned Block tombstone and deletes the journal on capacity-pressure prune", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-prune-"));
    try {
      const statePath = join(root, "core-state.json");
      const journalPath = join(root, "module-result-commits.json");
      let blockId = 0;
      let deliveryId = 0;
      const core = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      setupOutput(core);
      const claim = setupWorker(core, "worker", "input");
      const repository = new FileModuleResultCommitRepository({ path: journalPath, maxBytes: 1024 });
      const commits = createModuleResultCommitCoordinator({ core, repository, now: () => NOW, mailboxes });
      await commits.commit({
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
        source: { kind: "module", id: "worker" },
        outputPageIds: ["output"],
        blockProposal: proposal("first"),
      });
      const effectId = moduleResultBlockEffectId(claim.moduleJobId);
      expect(core.blocks.inspectCommitEffect(effectId)).not.toBeNull();
      expect(repository.get(claim.moduleJobId)).not.toBeNull();

      // A second committed result exceeds the 1024-byte journal limit and
      // forces the prune path: release, retire the owned tombstone, delete.
      const claim2 = setupWorker(core, "worker2", "input2");
      const tightCommits = createModuleResultCommitCoordinator({ core, repository, now: () => NOW, mailboxes });
      await tightCommits.commit({
        moduleJobId: claim2.moduleJobId,
        claimToken: claim2.claimToken,
        runId: claim2.runId,
        attempt: claim2.attempt,
        moduleGenerationId: claim2.moduleGenerationId,
        source: { kind: "module", id: "worker2" },
        outputPageIds: ["output"],
        blockProposal: proposal("second"),
      });

      // The first job's tombstone is retired and its journal deleted.
      expect(core.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(repository.get(claim.moduleJobId)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-prunes a committed record whose Block tombstone survived a reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-reopen-"));
    try {
      const statePath = join(root, "core-state.json");
      const journalPath = join(root, "module-result-commits.json");
      let blockId = 0;
      let deliveryId = 0;
      const core = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      setupOutput(core);
      const claim = setupWorker(core, "worker", "input");
      const repository = new FileModuleResultCommitRepository({ path: journalPath, maxBytes: 1024 });
      const commits = createModuleResultCommitCoordinator({ core, repository, now: () => NOW, mailboxes });
      await commits.commit({
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
        source: { kind: "module", id: "worker" },
        outputPageIds: ["output"],
        blockProposal: proposal("first"),
      });
      const effectId = moduleResultBlockEffectId(claim.moduleJobId);

      // Reopen Core and journal: the committed record and released tombstone survive.
      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      const reopenedRepository = new FileModuleResultCommitRepository({ path: journalPath, maxBytes: 1024 });
      expect(reopened.blocks.inspectCommitEffect(effectId)).not.toBeNull();
      expect(reopenedRepository.get(claim.moduleJobId)?.state).toBe("committed");

      // Capacity-pressure prune on the reopened coordinator retires + deletes.
      const tightCommits = createModuleResultCommitCoordinator({ core: reopened, repository: reopenedRepository, now: () => NOW, mailboxes });
      const claim2 = setupWorker(reopened, "worker2", "input2");
      await tightCommits.commit({
        moduleJobId: claim2.moduleJobId,
        claimToken: claim2.claimToken,
        runId: claim2.runId,
        attempt: claim2.attempt,
        moduleGenerationId: claim2.moduleGenerationId,
        source: { kind: "module", id: "worker2" },
        outputPageIds: ["output"],
        blockProposal: proposal("second"),
      });

      expect(reopened.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(reopenedRepository.get(claim.moduleJobId)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finishes a journal delete interrupted between the Block retirement and the journal delete on recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "artifact-module-result-retire-crash-"));
    try {
      const statePath = join(root, "core-state.json");
      const journalPath = join(root, "module-result-commits.json");
      let blockId = 0;
      let deliveryId = 0;
      const core = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      setupOutput(core);
      const claim = setupWorker(core, "worker", "input");
      const repository = new FileModuleResultCommitRepository({ path: journalPath, maxBytes: 1024 });
      const commits = createModuleResultCommitCoordinator({ core, repository, now: () => NOW, mailboxes });
      await commits.commit({
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
        source: moduleSource,
        outputPageIds: ["output"],
        blockProposal: proposal("first"),
      });
      const record = repository.get(claim.moduleJobId)!;
      const effectId = moduleResultBlockEffectId(claim.moduleJobId);

      // Simulate the crash window: retire the effect by staging and applying
      // its durable ticket, but keep the committed journal record (the delete
      // that would follow never ran).
      const operations = core.createModuleResultCommitOperations(mailboxes);
      operations.blocks.stageCommitEffectRetirement(effectId, {
        schemaVersion: "dolly.commit-effect-retirement/1",
        moduleJobId: claim.moduleJobId,
        blockId: record.blockId!,
        digest: canonicalJsonDigest({
          proposal: record.blockProposal,
          source: record.source,
        }),
      });
      operations.blocks.retireCommitEffect(effectId);
      expect(core.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(operations.blocks.inspectCommitEffectRetirementTicket(effectId)).not.toBeNull();
      expect(repository.get(claim.moduleJobId)?.state).toBe("committed");

      // Reopen Core and journal: the committed record and the durable ticket
      // both survive. recoverAll must finish the journal delete and then clear
      // the ticket, with no conflict.
      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      const reopenedRepository = new FileModuleResultCommitRepository({ path: journalPath, maxBytes: 1024 });
      const reopenedOperations = reopened.createModuleResultCommitOperations(mailboxes);
      expect(reopenedOperations.blocks.inspectCommitEffectRetirementTicket(effectId)).not.toBeNull();
      expect(reopenedRepository.get(claim.moduleJobId)?.state).toBe("committed");

      const recovering = createModuleResultCommitCoordinator({ core: reopened, repository: reopenedRepository, now: () => NOW, mailboxes });
      await recovering.recoverAll();

      expect(reopened.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(reopenedOperations.blocks.inspectCommitEffectRetirementTicket(effectId)).toBeNull();
      expect(reopenedRepository.get(claim.moduleJobId)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still reports a conflict when a committed journal's Block effect is absent without its durable ticket", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-conflict-"));
    try {
      const statePath = join(root, "core-state.json");
      const journalPath = join(root, "module-result-commits.json");
      let blockId = 0;
      let deliveryId = 0;
      const core = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      setupOutput(core);
      const claim = setupWorker(core, "worker", "input");
      const repository = new FileModuleResultCommitRepository({ path: journalPath, maxBytes: 1024 });
      const commits = createModuleResultCommitCoordinator({ core, repository, now: () => NOW, mailboxes });
      await commits.commit({
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
        source: moduleSource,
        outputPageIds: ["output"],
        blockProposal: proposal("first"),
      });
      const record = repository.get(claim.moduleJobId)!;
      const effectId = moduleResultBlockEffectId(claim.moduleJobId);
      const operations = core.createModuleResultCommitOperations(mailboxes);
      operations.blocks.stageCommitEffectRetirement(effectId, {
        schemaVersion: "dolly.commit-effect-retirement/1",
        moduleJobId: claim.moduleJobId,
        blockId: record.blockId!,
        digest: canonicalJsonDigest({
          proposal: record.blockProposal,
          source: record.source,
        }),
      });
      operations.blocks.retireCommitEffect(effectId);
      // Drop the ticket without deleting the journal: exactly the corruption
      // that a missing-ticket absence must reject.
      operations.blocks.clearCommitEffectRetirementTicket(effectId);
      expect(core.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(operations.blocks.inspectCommitEffectRetirementTicket(effectId)).toBeNull();
      expect(repository.get(claim.moduleJobId)?.state).toBe("committed");

      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      const reopenedRepository = new FileModuleResultCommitRepository({ path: journalPath, maxBytes: 1024 });
      const recovering = createModuleResultCommitCoordinator({ core: reopened, repository: reopenedRepository, now: () => NOW, mailboxes });
      await expect(recovering.recoverAll()).rejects.toMatchObject({
        name: "ModuleResultCommitError",
        code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
