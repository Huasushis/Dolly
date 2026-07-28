import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BlockProposal } from "../../../src/core/block-store.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { DeliveryStoreError } from "../../../src/core/delivery-store.js";
import {
  CoreStateError,
  FileCoreStateStore,
  migrateCoreStateDocumentToVersion16,
} from "../../../src/core/file-core-state-store.js";
import { withSynchronousCrossProcessLock } from "../../../src/core/synchronous-cross-process-lock.js";

const NOW = "2026-07-24T00:00:00.000Z";

function proposal(text: string): BlockProposal {
  return {
    payload: { schema: "test.content/1", value: { text } },
  };
}

function openStore(
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

describe("CORE atomic file state", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-core-state-"));
    path = join(root, "core-state.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reconstructs one coherent reference, Block, and Delivery state at an active claim", () => {
    const first = openStore(path, "first");
    first.deliveries.createPage("input");
    first.deliveries.createPage("output");
    first.deliveries.registerConsumer("input", "worker", "from-now");
    const block = first.blocks.commit(proposal("input"), {
      kind: "external",
      id: "console",
    });
    const delivery = first.deliveries.append("input", block.id);
    const claim = first.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    const persistedRevision = first.revision;

    const reopened = openStore(path, "second");
    expect(reopened.revision).toBe(persistedRevision);
    expect(reopened.blocks.get(block.id)).toEqual(block);
    expect(reopened.deliveries.listActiveClaims()).toEqual([
      expect.objectContaining({
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        status: "active",
      }),
    ]);
    expect(
      reopened.referenceGraph.strongReferenceCountFor({ kind: "block", id: block.id }),
    ).toBe(1);
    expect(reopened.referenceGraph.leaseCountFor({ kind: "block", id: block.id })).toBe(1);

    expect(reopened.deliveries.nack({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      failure: { code: "RUNTIME_RESTART", retryable: true },
    })).toBe("retry-scheduled");
    const afterNack = openStore(path, "third");
    const retry = afterNack.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-2",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    expect(retry.moduleJobId).toBe(claim.moduleJobId);
    expect(retry.deliveryIds).toEqual([delivery.deliveryId]);
    expect(retry.attempt).toBe(2);
  });

  it("persists an orderly Claim release and reclaims the same Module job", () => {
    const first = openStore(path, "first");
    first.deliveries.createPage("input");
    first.deliveries.registerConsumer("input", "worker", "from-now");
    const firstBlock = first.blocks.commit(proposal("first"), {
      kind: "external",
      id: "console",
    });
    const secondBlock = first.blocks.commit(proposal("second"), {
      kind: "external",
      id: "console",
    });
    first.deliveries.append("input", firstBlock.id);
    first.deliveries.append("input", secondBlock.id);
    const claim = first.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    expect(claim.hasMore).toBe(true);
    expect(first.deliveries.releaseClaim({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
    })).toBe("released");
    const releasedRevision = first.revision;

    const reopened = openStore(path, "second");
    expect(reopened.revision).toBe(releasedRevision);
    expect(reopened.deliveries.listActiveClaims()).toEqual([]);
    expect(reopened.referenceGraph.leaseCountFor({ kind: "block", id: firstBlock.id }))
      .toBe(0);
    const retry = reopened.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-2",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    expect(retry).toMatchObject({
      moduleJobId: claim.moduleJobId,
      deliveryIds: claim.deliveryIds,
      hasMore: claim.hasMore,
      attempt: 2,
    });
    expect(retry.claimToken).not.toBe(claim.claimToken);
    expect(retry.runId).not.toBe(claim.runId);
  });

  it("uses one aggregate revision for appendOnce and no revision for its replay", () => {
    const store = openStore(path, "single");
    store.deliveries.createPage("page");
    const block = store.blocks.commit(proposal("output"), {
      kind: "module",
      id: "worker",
    });
    const before = store.revision;
    const delivery = store.deliveries.appendOnce("effect-1", "page", block.id);
    expect(store.revision).toBe(before + 1);
    expect(store.deliveries.appendOnce("effect-1", "page", block.id)).toEqual(delivery);
    expect(store.revision).toBe(before + 1);
    expect(openStore(path, "reopen").snapshot()).toEqual(store.snapshot());
  });

  it("rejects stale writers instead of overwriting a newer runtime revision", () => {
    const first = openStore(path, "first");
    const stale = openStore(path, "stale");
    first.deliveries.createPage("first-page");

    expect(() => stale.deliveries.createPage("stale-page")).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({
        code: "DELIVERY_PERSISTENCE_FAILED",
      }),
    );
    expect(stale.revision).toBe(0);

    const truth = openStore(path, "truth");
    expect(truth.deliveries.validateOutputPages(["first-page"])).toEqual(["first-page"]);
    expect(() => truth.deliveries.validateOutputPages(["stale-page"])).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({ code: "PAGE_NOT_FOUND" }),
    );
  });

  it("retries a mutation whose first atomic write could not acquire the lock", () => {
    const store = openStore(path, "first");
    withSynchronousCrossProcessLock({ resourceId: `${path}.lock` }, () => {
      expect(() => store.deliveries.createPage("page")).toThrowError(
        expect.objectContaining<Partial<DeliveryStoreError>>({
          code: "DELIVERY_PERSISTENCE_FAILED",
        }),
      );
    });
    expect(store.revision).toBe(0);
    expect(() => store.flush()).not.toThrow();
    expect(store.revision).toBe(1);
    expect(openStore(path, "reopen").deliveries.validateOutputPages(["page"])).toEqual([
      "page",
    ]);
  });

  it("retries the exact Claim release after an atomic write failure", () => {
    const store = openStore(path, "first");
    store.deliveries.createPage("input");
    store.deliveries.registerConsumer("input", "worker", "from-now");
    const block = store.blocks.commit(proposal("input"), {
      kind: "external",
      id: "console",
    });
    store.deliveries.append("input", block.id);
    const claim = store.deliveries.claim({
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

    withSynchronousCrossProcessLock({ resourceId: `${path}.lock` }, () => {
      expect(() => store.deliveries.releaseClaim(request)).toThrowError(
        expect.objectContaining<Partial<DeliveryStoreError>>({
          code: "DELIVERY_PERSISTENCE_FAILED",
        }),
      );
    });
    expect(store.deliveries.releaseClaim(request)).toBe("already-released");

    const reopened = openStore(path, "reopened");
    expect(reopened.deliveries.inspectClaim(request).status).toBe("released");
    expect(reopened.deliveries.listActiveClaims()).toEqual([]);
    expect(reopened.referenceGraph.leaseCountFor({ kind: "block", id: block.id })).toBe(0);
  });

  it("rejects duplicate-key JSON and digest tampering on reconstruction", () => {
    openStore(path, "first");
    writeFileSync(
      path,
      '{"schemaVersion":"dolly.core-state/16","revision":0,"revision":1,"stateDigest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","referenceGraph":{},"blocks":{},"deliveries":{},"moduleProcessRecords":[],"moduleSubmissionRecords":[]}',
      "utf8",
    );
    expect(() => openStore(path, "bad-json")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_DOCUMENT_INVALID",
      }),
    );

    rmSync(path);
    const clean = openStore(path, "clean");
    const document = JSON.parse(readFileSync(path, "utf8")) as { revision: number };
    document.revision += 1;
    writeFileSync(path, `${JSON.stringify(document)}\n`, "utf8");
    expect(() => openStore(path, "tampered")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_DOCUMENT_INVALID",
      }),
    );
    expect(clean.revision).toBe(0);
  });

  it("rejects the previous Core state version", () => {
    openStore(path, "current");
    const previous = JSON.parse(readFileSync(path, "utf8")) as {
      schemaVersion: string;
    };
    previous.schemaVersion = "dolly.core-state/14";
    writeFileSync(path, `${JSON.stringify(previous)}\n`, "utf8");

    expect(() => openStore(path, "previous")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_DOCUMENT_INVALID",
      }),
    );
  });

  it("requires an explicit migration instead of silently upgrading version 15", () => {
    openStore(path, "current");
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete current.moduleProcessRecords;
    delete current.moduleSubmissionRecords;
    const legacyPayload = {
      revision: current.revision,
      referenceGraph: current.referenceGraph,
      blocks: current.blocks,
      deliveries: current.deliveries,
    };
    const legacy = {
      schemaVersion: "dolly.core-state/15",
      stateDigest: canonicalJsonDigest(legacyPayload as never),
      ...legacyPayload,
    };
    writeFileSync(path, `${JSON.stringify(legacy)}\n`, "utf8");

    expect(() => openStore(path, "legacy")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_MIGRATION_REQUIRED",
      }),
    );

    expect(migrateCoreStateDocumentToVersion16(path)).toBe("migrated");
    const migrated = openStore(path, "migrated");
    expect(migrated.snapshot().schemaVersion).toBe("dolly.core-state/16");
    expect(migrated.listModuleProcessRecords()).toEqual([]);
    expect(migrated.listModuleSubmissionRecords()).toEqual([]);
    expect(JSON.parse(readFileSync(`${path}.v15.backup`, "utf8"))).toMatchObject({
      schemaVersion: "dolly.core-state/15",
    });
    expect(migrateCoreStateDocumentToVersion16(path)).toBe("already-current");
  });
});
