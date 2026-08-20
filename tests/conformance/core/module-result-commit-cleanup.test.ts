import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { BlockStore, type BlockProposal, type BlockStoreSnapshot } from "../../../src/core/block-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import { canonicalJsonDigest, type JsonValue } from "../../../src/core/canonical-json.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { InMemoryModuleResultCommitRepository } from "../../../src/core/module-result-commit.js";
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

/**
 * A Module-result Delivery append-effect is identified by the same effect-id
 * derivation the coordinator and FileStoreCore use: the canonical digest of
 * of the literal marker tuple `["module-result-commit-delivery", moduleJobId,
 * pageId]`.
 */
function moduleResultDeliveryEffectId(moduleJobId: string, pageId: string): string {
  return canonicalJsonDigest(["module-result-commit-delivery", moduleJobId, pageId]);
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

  it("RED: atomic retirement removes the exact Delivery append-effect on capacity-pressure prune and it stays absent after reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-red-delivery-"));
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
      const deliveryEffectId = moduleResultDeliveryEffectId(claim.moduleJobId, "output");
      const repository = new FileModuleResultCommitRepository({
        path: journalPath,
        maxBytes: 1024,
      });
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
      // The output Delivery append-effect is recorded commit-side, exactly as
      // the protocol derives it; it must be the object the retirement retires.
      expect(core.deliveries.inspectAppendEffect(deliveryEffectId)).toMatchObject({
        pageId: "output",
      });
      const existingTicket = core.createModuleResultCommitOperations(mailboxes)
        .blocks.inspectCommitEffectRetirementTicket(moduleResultBlockEffectId(claim.moduleJobId));
      expect(existingTicket).toBeNull();

      // A second committed result fills the confined journal and forces the
      // one store-bound atomic retirement: Block tombstone, exact Delivery
      // append-effect, and journal record all retire together.
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

      const effectId = moduleResultBlockEffectId(claim.moduleJobId);
      expect(core.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(core.deliveries.inspectAppendEffect(deliveryEffectId)).toBeNull();
      expect(repository.get(claim.moduleJobId)).toBeNull();
      expect(
        core.createModuleResultCommitOperations(mailboxes)
          .blocks.inspectCommitEffectRetirementTicket(effectId),
      ).toBeNull();

      // Reopen the durable Core state and journal: the retired delivery
      // append-effect must stay absent and a second startup must stay
      // unchanged (idempotent, no effect resurrection).
      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      const reopenedRepository = new FileModuleResultCommitRepository({
        path: journalPath,
        maxBytes: 16 * 1024 * 1024,
      });
      expect(reopened.deliveries.inspectAppendEffect(deliveryEffectId)).toBeNull();
      expect(reopened.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(reopenedRepository.get(claim.moduleJobId)).toBeNull();

      const recovering = createModuleResultCommitCoordinator({
        core: reopened,
        repository: reopenedRepository,
        now: () => NOW,
        mailboxes,
      });
      await expect(recovering.recoverAll()).resolves.toMatchObject({
        recoveredCommits: [],
        deferredCommits: [],
      });
      expect(reopened.deliveries.inspectAppendEffect(deliveryEffectId)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("crash between the durable ticket and the atomic retirement: reopen prunes the all-old state completely", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-pre-atomic-"));
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
      const record = repository.get(claim.moduleJobId)!;
      const effectId = moduleResultBlockEffectId(claim.moduleJobId);
      const deliveryEffectId = moduleResultDeliveryEffectId(claim.moduleJobId, "output");

      // Crash window: only the durable version-2 retirement ticket is written;
      // the atomic retirement (block + deliveries) never ran.
      const operations = core.createModuleResultCommitOperations(mailboxes);
      operations.blocks.stageCommitEffectRetirement(effectId, {
        schemaVersion: "dolly.commit-effect-retirement/2",
        moduleJobId: claim.moduleJobId,
        blockId: record.blockId!,
        digest: canonicalJsonDigest({
          proposal: record.blockProposal,
          source: record.source,
        }),
        deliveryEffectIds: [deliveryEffectId],
      });
      expect(core.blocks.inspectCommitEffect(effectId)).not.toBeNull();
      expect(core.deliveries.inspectAppendEffect(deliveryEffectId)).not.toBeNull();

      // Reopen: everything is still all-old and recovery must finish the
      // atomic retirement, delete the journal, and clear the durable ticket.
      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      const reopenedRepository = new FileModuleResultCommitRepository({ path: journalPath, maxBytes: 1024 });
      expect(reopened.blocks.inspectCommitEffect(effectId)).not.toBeNull();
      expect(reopened.deliveries.inspectAppendEffect(deliveryEffectId)).not.toBeNull();
      expect(
        reopened.createModuleResultCommitOperations(mailboxes)
          .blocks.inspectCommitEffectRetirementTicket(effectId),
      ).toMatchObject({ schemaVersion: "dolly.commit-effect-retirement/2" });

      // Second committed result triggers the retry prune on the reopened store.
      const claim2 = setupWorker(reopened, "worker2", "input2");
      const tightCommits = createModuleResultCommitCoordinator({ core: reopened, repository: reopenedRepository, now: () => NOW, mailboxes });
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
      expect(reopened.deliveries.inspectAppendEffect(deliveryEffectId)).toBeNull();
      expect(reopenedRepository.get(claim.moduleJobId)).toBeNull();
      expect(
        reopened.createModuleResultCommitOperations(mailboxes)
          .blocks.inspectCommitEffectRetirementTicket(effectId),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("crash after the atomic retirement before the journal delete: reopen finishes and never resurrects effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-post-atomic-"));
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
      const record = repository.get(claim.moduleJobId)!;
      const effectId = moduleResultBlockEffectId(claim.moduleJobId);
      const deliveryEffectId = moduleResultDeliveryEffectId(claim.moduleJobId, "output");

      // Apply the full atomic retirement through the real store-bound op, but
      // stop before the journal delete (the delete that follows never ran).
      const operations = core.createModuleResultCommitOperations(mailboxes);
      operations.blocks.stageCommitEffectRetirement(effectId, {
        schemaVersion: "dolly.commit-effect-retirement/2",
        moduleJobId: claim.moduleJobId,
        blockId: record.blockId!,
        digest: canonicalJsonDigest({
          proposal: record.blockProposal,
          source: record.source,
        }),
        deliveryEffectIds: [deliveryEffectId],
      });
      operations.retireModuleResultEffects!({
        moduleJobId: claim.moduleJobId,
        claim: {
          moduleJobId: claim.moduleJobId,
          claimToken: claim.claimToken,
          runId: claim.runId,
          attempt: claim.attempt,
          moduleGenerationId: claim.moduleGenerationId,
        },
        blockEffectId: effectId,
        deliveryEffectIds: [deliveryEffectId],
      });
      expect(core.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(core.deliveries.inspectAppendEffect(deliveryEffectId)).toBeNull();
      expect(repository.get(claim.moduleJobId)?.state).toBe("committed");

      // Reopen: the ticket is the only residue and recoverAll must finish the
      // journal delete and clear the ticket, resurrecting nothing.
      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      const reopenedRepository = new FileModuleResultCommitRepository({ path: journalPath, maxBytes: 1024 });
      expect(reopened.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(reopened.deliveries.inspectAppendEffect(deliveryEffectId)).toBeNull();
      expect(
        reopened.createModuleResultCommitOperations(mailboxes)
          .blocks.inspectCommitEffectRetirementTicket(effectId),
      ).toMatchObject({ schemaVersion: "dolly.commit-effect-retirement/2" });

      const recovering = createModuleResultCommitCoordinator({ core: reopened, repository: reopenedRepository, now: () => NOW, mailboxes });
      await recovering.recoverAll();

      expect(reopenedRepository.get(claim.moduleJobId)).toBeNull();
      expect(
        reopened.createModuleResultCommitOperations(mailboxes)
          .blocks.inspectCommitEffectRetirementTicket(effectId),
      ).toBeNull();
      expect(reopened.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(reopened.deliveries.inspectAppendEffect(deliveryEffectId)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale version-1 ticket as authority for Delivery retirement on reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-v1-ticket-"));
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
      const record = repository.get(claim.moduleJobId)!;
      const effectId = moduleResultBlockEffectId(claim.moduleJobId);
      const deliveryEffectId = moduleResultDeliveryEffectId(claim.moduleJobId, "output");

      // A legacy v1 ticket may finish only the original Block retirement
      // semantics. It must never authorize Delivery append deletion.
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
      expect(core.deliveries.inspectAppendEffect(deliveryEffectId)).not.toBeNull();

      // Reopen; the committed journal's Delivery append-effect must survive.
      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      const reopenedRepository = new FileModuleResultCommitRepository({ path: journalPath, maxBytes: 1024 });
      expect(reopened.deliveries.inspectAppendEffect(deliveryEffectId)).not.toBeNull();

      const recovering = createModuleResultCommitCoordinator({ core: reopened, repository: reopenedRepository, now: () => NOW, mailboxes });
      await recovering.recoverAll();

      // The v1 ticket retires only the Block tombstone; the Delivery
      // append-effect is never touched and the journal delete still happens.
      expect(reopenedRepository.get(claim.moduleJobId)).toBeNull();
      expect(reopened.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(reopened.deliveries.inspectAppendEffect(deliveryEffectId)).not.toBeNull();
      expect(
        reopened.createModuleResultCommitOperations(mailboxes)
          .blocks.inspectCommitEffectRetirementTicket(effectId),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on partial Delivery retirement: a ticket with a stale set never deletes anything", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-partial-effect-"));
    try {
      const statePath = join(root, "core-state.json");
      const journalPath = join(root, "module-result-commits.json");
      let blockId = 0;
      let blockIdGen = () => `block-${++blockId}`;
      let deliveryId = 0;
      const core = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: blockIdGen,
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
      const record = repository.get(claim.moduleJobId)!;
      const effectId = moduleResultBlockEffectId(claim.moduleJobId);
      const deliveryEffectId = moduleResultDeliveryEffectId(claim.moduleJobId, "output");
      const foreignEffectId = moduleResultDeliveryEffectId("some-other-job", "output");

      // A version-2 ticket naming a stale/foreign Delivery effect cannot be
      // used to delete anything: the store-bound op must fail closed before a
      // single effect is removed.
      const operations = core.createModuleResultCommitOperations(mailboxes);
      operations.blocks.stageCommitEffectRetirement(effectId, {
        schemaVersion: "dolly.commit-effect-retirement/2",
        moduleJobId: claim.moduleJobId,
        blockId: record.blockId!,
        digest: canonicalJsonDigest({
          proposal: record.blockProposal,
          source: record.source,
        }),
        deliveryEffectIds: [foreignEffectId],
      });
      expect(() =>
        operations.retireModuleResultEffects!({
          moduleJobId: claim.moduleJobId,
          claim: {
            moduleJobId: claim.moduleJobId,
            claimToken: claim.claimToken,
            runId: claim.runId,
            attempt: claim.attempt,
            moduleGenerationId: claim.moduleGenerationId,
          },
          blockEffectId: effectId,
          deliveryEffectIds: [foreignEffectId],
        }),
      ).toThrowError(
        expect.objectContaining({ code: "MODULE_RESULT_PERSISTED_STATE_CONFLICT" }),
      );
      expect(core.blocks.inspectCommitEffect(effectId)).not.toBeNull();
      expect(core.deliveries.inspectAppendEffect(deliveryEffectId)).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("multi-output atomic retirement: every exact append-effect retires in one prune", async () => {
    const multiMailboxes = [
      { consumerId: "sink", pageIds: ["output-a", "output-b"], maxResidentCount: 8, maxResidentBytes: 1024 * 1024 },
    ];
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-multi-output-"));
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
      core.deliveries.createPage("output-a");
      core.deliveries.createPage("output-b");
      core.deliveries.registerConsumer("output-a", "sink", "from-now");
      core.deliveries.registerConsumer("output-b", "sink", "from-now");
      const claim = setupWorker(core, "worker", "input");
      const repository = new FileModuleResultCommitRepository({ path: journalPath, maxBytes: 1536 });
      const commits = createModuleResultCommitCoordinator({ core, repository, now: () => NOW, mailboxes: multiMailboxes });
      await commits.commit({
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
        source: { kind: "module", id: "worker" },
        outputPageIds: ["output-a", "output-b"],
        blockProposal: proposal("first"),
      });
      const effectId = moduleResultBlockEffectId(claim.moduleJobId);
      const effectA = moduleResultDeliveryEffectId(claim.moduleJobId, "output-a");
      const effectB = moduleResultDeliveryEffectId(claim.moduleJobId, "output-b");
      expect(core.deliveries.inspectAppendEffect(effectA)).not.toBeNull();
      expect(core.deliveries.inspectAppendEffect(effectB)).not.toBeNull();

      const claim2 = setupWorker(core, "worker2", "input2");
      const tightCommits = createModuleResultCommitCoordinator({ core, repository, now: () => NOW, mailboxes: multiMailboxes });
      await tightCommits.commit({
        moduleJobId: claim2.moduleJobId,
        claimToken: claim2.claimToken,
        runId: claim2.runId,
        attempt: claim2.attempt,
        moduleGenerationId: claim2.moduleGenerationId,
        source: { kind: "module", id: "worker2" },
        outputPageIds: ["output-a", "output-b"],
        blockProposal: proposal("second"),
      });

      expect(core.blocks.inspectCommitEffect(effectId)).toBeNull();
      expect(core.deliveries.inspectAppendEffect(effectA)).toBeNull();
      expect(core.deliveries.inspectAppendEffect(effectB)).toBeNull();
      expect(repository.get(claim.moduleJobId)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("E: an opaque SourceActivation append-effect in the same stores survives Module-result cleanup and reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-sa-isolation-"));
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
      core.deliveries.createPage("output");
      core.deliveries.createPage("private");
      core.deliveries.registerConsumer("output", "sink", "from-now");
      // SourceActivation uses its own private page and opaque effect
      // identities; it is never part of any Module-result commit.
      core.deliveries.registerConsumer("private", "source", "from-now");
      const saBlock = core.blocks.commitOnce(
        "source-activation.test.block.00000000",
        proposal("source activation"),
        { kind: "external", id: "source-activation" },
      );
      const saDelivery = core.deliveries.appendOnce(
        "source-activation.test.delivery.00000000",
        "private",
        saBlock.id,
      );

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
      // Capacity prune retires the Module result's own effects atomically.
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
      const moduleEffectId = moduleResultBlockEffectId(claim.moduleJobId);
      const moduleDeliveryEffectId = moduleResultDeliveryEffectId(claim.moduleJobId, "output");
      expect(core.blocks.inspectCommitEffect(moduleEffectId)).toBeNull();
      expect(core.deliveries.inspectAppendEffect(moduleDeliveryEffectId)).toBeNull();
      // The opaque SourceActivation effect stays byte/identity-equivalent.
      expect(core.blocks.inspectCommitEffect("source-activation.test.block.00000000")).not.toBeNull();
      expect(core.deliveries.inspectAppendEffect("source-activation.test.delivery.00000000")).toMatchObject({
        pageId: "private",
        blockId: saBlock.id,
      });

      // Reopen: identity-equivalent and idempotency still resolves terminal
      // duplicates exactly as before the Module-result cleanup.
      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      // The opaque SourceActivation append-effect is byte/identity-equivalent
      // across reopen and its terminal duplicate still resolves.
      expect(reopened.deliveries.inspectAppendEffect("source-activation.test.delivery.00000000")).toMatchObject({
        pageId: "private",
        blockId: saBlock.id,
      });
      const reopenedIdempotent = reopened.deliveries.appendOnce(
        "source-activation.test.delivery.00000000",
        "private",
        saBlock.id,
      );
      expect(reopenedIdempotent).toEqual(saDelivery);
      expect(reopened.blocks.inspectCommitEffect("source-activation.test.block.00000000")).not.toBeNull();
      expect(
        reopened.deliveries.inspectAppendEffect("source-activation.test.delivery.00000000")!.record.blockId,
      ).toBe(saBlock.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("C: journal absence alone is never cleanup authority; the durable anchor is required", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-journal-absent-"));
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
      const deliveryEffectId = moduleResultDeliveryEffectId(claim.moduleJobId, "output");
      // The journal disappears out from under the store, with no durable
      // ticket ever staged. Absence alone must never become cleanup authority:
      // recovery leaves the committed effects untouched.
      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      // The journal for this result is entirely absent: no record and no
      // durable ticket were ever written. Absence alone must never grant
      // cleanup authority, so recovery lifts nothing.
      const reopenedJournal = new InMemoryModuleResultCommitRepository();
      const recovering = createModuleResultCommitCoordinator({
        core: reopened,
        repository: reopenedJournal,
        now: () => NOW,
        mailboxes,
      });
      await expect(recovering.recoverAll()).resolves.toMatchObject({
        recoveredCommits: [],
        deferredCommits: [],
      });
      // No ticket exists, so absence proved nothing: effects stay untouched.
      expect(reopened.blocks.inspectCommitEffect(effectId)).not.toBeNull();
      expect(reopened.deliveries.inspectAppendEffect(deliveryEffectId)).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("F: wrong Claim identity or wrong digest on retirement fails closed with no effect removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-cleanup-wrong-claim-"));
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
      const record = repository.get(claim.moduleJobId)!;
      const effectId = moduleResultBlockEffectId(claim.moduleJobId);
      const deliveryEffectId = moduleResultDeliveryEffectId(claim.moduleJobId, "output");
      const operations = core.createModuleResultCommitOperations(mailboxes);
      operations.blocks.stageCommitEffectRetirement(effectId, {
        schemaVersion: "dolly.commit-effect-retirement/2",
        moduleJobId: claim.moduleJobId,
        blockId: record.blockId!,
        digest: canonicalJsonDigest({
          proposal: record.blockProposal,
          source: record.source,
        }),
        deliveryEffectIds: [deliveryEffectId],
      });
      // Wrong Claim identity (swapped runId): the store-bound op fails
      // closed on the exact delivery-claim mismatch before any mutation.
      expect(() =>
        operations.retireModuleResultEffects!({
          moduleJobId: claim.moduleJobId,
          claim: {
            moduleJobId: claim.moduleJobId,
            claimToken: claim.claimToken,
            runId: "not-the-run",
            attempt: claim.attempt,
            moduleGenerationId: claim.moduleGenerationId,
          },
          blockEffectId: effectId,
          deliveryEffectIds: [deliveryEffectId],
        }),
      ).toThrowError(
        expect.objectContaining({ code: "CLAIM_RUN_MISMATCH" }),
      );
      expect(core.blocks.inspectCommitEffect(effectId)).not.toBeNull();
      expect(core.deliveries.inspectAppendEffect(deliveryEffectId)).not.toBeNull();
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
