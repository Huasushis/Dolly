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

/** The durable owner token the Module-result commit protocol attaches. */
const moduleResultOwner = "module-result-commit";

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
  it("forgets an owned released Module-result Block effect tombstone through the retire operation", () => {
    const harness = createStore();
    const blocks = harness.blocks;

    // One raw, foreign Block committed through the public `commit` path has
    // no commit-effect entry: it must never be eligible for retirement.
    blocks.commit(proposal("raw external input"), externalSource);
    expect(blocks.size).toBe(1);

    const moduleEffectId = moduleResultBlockEffectId("module-job-1");
    blocks.commitOnce(moduleEffectId, proposal("module output"), moduleSource, moduleResultOwner);
    expect(blocks.size).toBe(2);
    expect(blocks.inspectCommitEffect(moduleEffectId)).toMatchObject({
      strongReferenceHeld: true,
    });

    // The coordinator releases the strong reference once the result journal
    // is committed. The Block record becomes a collection candidate.
    blocks.releaseCommitEffect(moduleEffectId);
    blocks.collectUnreachable();
    expect(blocks.size).toBe(0);

    // After the reference is released and Core retirement is durably
    // confirmed, the owned retire operation removes only this exact
    // Module-result commit-effect tombstone. The tombstone must no longer be
    // retained and must not survive a snapshot reopen.
    expect(blocks.retireCommitEffect(moduleEffectId, moduleResultOwner)).toBe("retired");
    expect(blocks.inspectCommitEffect(moduleEffectId)).toBeNull();
    const reopened = restoreFrom(blocks);
    expect(reopened.inspectCommitEffect(moduleEffectId)).toBeNull();
  });

  it("rejects retiring an effect that still holds its strong reference", () => {
    const harness = createStore();
    const blocks = harness.blocks;
    const moduleEffectId = moduleResultBlockEffectId("module-job-2");
    blocks.commitOnce(moduleEffectId, proposal("module output"), moduleSource, moduleResultOwner);

    expect(() =>
      blocks.retireCommitEffect(moduleEffectId, moduleResultOwner),
    ).toThrowError(
      expect.objectContaining({ code: "BLOCK_EFFECT_CONFLICT" }),
    );
    // The tombstone is preserved because retirement was rejected.
    expect(blocks.inspectCommitEffect(moduleEffectId)).not.toBeNull();
  });

  it("rejects retiring an owned effect with the wrong owner", () => {
    const harness = createStore();
    const blocks = harness.blocks;
    const moduleEffectId = moduleResultBlockEffectId("module-job-3");
    blocks.commitOnce(moduleEffectId, proposal("module output"), moduleSource, moduleResultOwner);
    blocks.releaseCommitEffect(moduleEffectId);

    expect(() =>
      blocks.retireCommitEffect(moduleEffectId, "wrong-owner"),
    ).toThrowError(
      expect.objectContaining({ code: "BLOCK_EFFECT_CONFLICT" }),
    );
    expect(blocks.inspectCommitEffect(moduleEffectId)).not.toBeNull();
  });

  it("does not make a foreign SourceActivation/raw Block effect eligible for owned retirement", () => {
    const harness = createStore();
    const blocks = harness.blocks;

    const foreignEffectId = canonicalJsonDigest(["source-activation-block", "source-1"]);
    // SourceActivationQueue commits foreign effects through `commitOnce`
    // without an owner; they are outside the Module-result cleanup.
    blocks.commitOnce(foreignEffectId, proposal("foreign"), moduleSource);
    blocks.releaseCommitEffect(foreignEffectId);

    // A foreign/SourceActivation/raw effect has no durable owner and must not
    // be eligible for the owned retirement path. The retire operation must
    // reject it outright so that SourceActivation retention and raw
    // replay-conflict guarantees are not weakened.
    expect(() =>
      blocks.retireCommitEffect(foreignEffectId, moduleResultOwner),
    ).toThrowError(
      expect.objectContaining({ code: "BLOCK_EFFECT_CONFLICT" }),
    );

    // The foreign effect tombstone must remain intact (preserved, not
    // reinterpreted as owned/forgettable) across reopen.
    const reopened = restoreFrom(blocks);
    expect(reopened.inspectCommitEffect(foreignEffectId)).not.toBeNull();
  });

  it("preserves a legacy v3 snapshot effect as ownerless and not retireable", () => {
    const harness = createStore();
    const blocks = harness.blocks;
    const legacyEffectId = "legacy-effect-1";
    blocks.commitOnce(legacyEffectId, proposal("legacy"), moduleSource);
    blocks.releaseCommitEffect(legacyEffectId);

    // A legacy v3 snapshot carries no owner metadata. Restoring it must keep
    // the effect ownerless, so the owned retire path rejects it.
    const legacySnapshot = structuredClone(blocks.snapshot()) as BlockStoreSnapshot;
    const reopened = restore(legacySnapshot, new ReferenceGraph({
      snapshot: structuredClone(blocks.referenceGraph.snapshot()),
    }));
    expect(reopened.inspectCommitEffect(legacyEffectId)).not.toBeNull();
    expect(() =>
      reopened.retireCommitEffect(legacyEffectId, moduleResultOwner),
    ).toThrowError(
      expect.objectContaining({ code: "BLOCK_EFFECT_CONFLICT" }),
    );
    expect(reopened.inspectCommitEffect(legacyEffectId)).not.toBeNull();
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
});
