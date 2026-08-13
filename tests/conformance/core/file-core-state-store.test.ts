import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BlockStore,
  type BlockProposal,
} from "../../../src/core/block-store.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import {
  DeliveryStore,
  DeliveryStoreError,
} from "../../../src/core/delivery-store.js";
import {
  CoreStateError,
  FileCoreStateStore,
  migrateCoreStateDocumentToVersion18,
} from "../../../src/core/file-core-state-store.js";
import {
  MediaStore,
  type MediaByteStore,
} from "../../../src/core/media-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import { withSynchronousCrossProcessLock } from "../../../src/core/synchronous-cross-process-lock.js";

const NOW = "2026-07-24T00:00:00.000Z";
const MIGRATION_OPTIONS = {
  runtimeConfiguration: {
    maxFailedAttempts: 3,
    media: { enabled: false as const },
  },
};

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

class PersistentMediaBytes implements MediaByteStore {
  readonly durability = "persistent" as const;
  readonly #values = new Map<string, Uint8Array>();

  async put(mediaId: string, bytes: Uint8Array): Promise<void> {
    this.#values.set(mediaId, Uint8Array.from(bytes));
  }

  async get(mediaId: string): Promise<Uint8Array> {
    const bytes = this.#values.get(mediaId);
    if (bytes === undefined) throw new Error(`Bytes for ${mediaId} do not exist`);
    return Uint8Array.from(bytes);
  }

  async delete(mediaId: string): Promise<void> {
    this.#values.delete(mediaId);
  }

  async has(mediaId: string): Promise<boolean> {
    return this.#values.has(mediaId);
  }
}

function openStoreWithMedia(path: string): FileCoreStateStore {
  let blockId = 0;
  let runtimeId = 0;
  return new FileCoreStateStore({
    path,
    maxFailedAttempts: 3,
    nextBlockId: () => `media-block-${++blockId}`,
    nextDeliveryId: (kind) => `media-${kind}-${++runtimeId}`,
    now: () => NOW,
    media: {
      durability: "persistent",
      bytes: new PersistentMediaBytes(),
      inspector: {
        inspect: async () => ({ mimeType: "application/octet-stream" }),
      },
      maxMediaBytes: 1024,
      idNamespace: "file-core-view-test",
    },
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

  it("publishes Delivery changes only after an enclosing atomic write succeeds", () => {
    const committed = openStore(path, "committed-notification");
    let committedNotifications = 0;
    committed.deliveries.subscribeChanges(() => {
      committedNotifications += 1;
    });

    committed.runAtomicUpdate(() => {
      committed.deliveries.createPage("committed-page");
      expect(committedNotifications).toBe(0);
    });
    expect(committedNotifications).toBe(1);
    expect(openStore(path, "committed-reopen").deliveries.listPageIds()).toContain(
      "committed-page",
    );

    const failedPath = join(root, "failed-core-state.json");
    const failed = openStore(failedPath, "failed-notification");
    const beforeBytes = readFileSync(failedPath);
    let failedNotifications = 0;
    failed.deliveries.subscribeChanges(() => {
      failedNotifications += 1;
    });

    expect(() =>
      failed.runAtomicUpdate(() => {
        failed.deliveries.createPage("not-persisted");
        expect(failedNotifications).toBe(0);
        throw new Error("abort atomic update");
      }),
    ).toThrow();
    expect(failedNotifications).toBe(0);
    expect(readFileSync(failedPath)).toEqual(beforeBytes);
    expect(openStore(failedPath, "failed-reopen").deliveries.listPageIds()).not.toContain(
      "not-persisted",
    );
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

    expect(reopened.negativelyAcknowledgeDeliveryClaim({
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
    expect(first.releaseDeliveryClaim({
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

  it("exposes only frozen null-prototype component operations", () => {
    const store = openStore(path, "owned");
    const storeWithMedia = openStoreWithMedia(join(root, "media-core-state.json"));
    const views = [
      store.referenceGraph,
      store.blocks,
      store.deliveries,
      storeWithMedia.media!,
      storeWithMedia.media!.referenceGraph,
    ];

    for (const view of views) {
      expect(Object.getPrototypeOf(view)).toBeNull();
      expect(Object.isFrozen(view)).toBe(true);
      expect(Reflect.get(view, "valueOf")).toBeUndefined();
      expect(Reflect.get(view, "constructor")).toBeUndefined();
      expect(Reflect.set(view, "injected", () => view)).toBe(false);
      expect(Reflect.defineProperty(view, "injected", {
        value: () => view,
      })).toBe(false);
      expect(Reflect.setPrototypeOf(view, {
        injected() {
          return this;
        },
      })).toBe(false);
      expect(Reflect.get(view, "injected")).toBeUndefined();
    }
    for (const [owner, property] of [
      [store, "referenceGraph"],
      [store, "blocks"],
      [store, "deliveries"],
      [storeWithMedia, "media"],
    ] as const) {
      const original = Reflect.get(owner, property);
      expect(Object.getOwnPropertyDescriptor(owner, property)).toMatchObject({
        configurable: false,
        writable: false,
        value: original,
      });
      expect(Reflect.set(owner, property, Object.create(null))).toBe(false);
      expect(Reflect.defineProperty(owner, property, {
        value: Object.create(null),
      })).toBe(false);
      expect(Reflect.get(owner, property)).toBe(original);
    }

    expect(store.blocks.referenceGraph).toBe(store.referenceGraph);
    expect(Object.getOwnPropertyDescriptor(store.blocks, "referenceGraph")?.get)
      .toEqual(expect.any(Function));
    expect(store.blocks.isSameBlockStore(store.blocks)).toBe(true);
    expect(store.deliveries.usesSameBlockStore(store.blocks)).toBe(true);
    // @ts-expect-error FileCore does not expose persistence observer replacement.
    expect(() => store.blocks.setMutationObserver(undefined)).toThrowError(TypeError);
    // @ts-expect-error The Delivery persistence observer is intentionally not public.
    expect(() => store.deliveries.setMutationObserver(undefined)).toThrowError(TypeError);
    expect(() =>
      // @ts-expect-error FileCore exposes only read operations on the reference graph.
      store.referenceGraph.registerNode({ kind: "block", id: "unpersisted" }),
    ).toThrowError(TypeError);
    expect(() =>
      // @ts-expect-error Nested reference graph access is read-only too.
      store.blocks.referenceGraph.registerNode({ kind: "block", id: "nested-unpersisted" }),
    ).toThrowError(TypeError);
    expect(() => ReferenceGraph.prototype.snapshot.call(store.referenceGraph))
      .toThrowError(TypeError);
    expect(() => BlockStore.prototype.snapshot.call(store.blocks))
      .toThrowError(TypeError);
    expect(() => DeliveryStore.prototype.snapshot.call(store.deliveries))
      .toThrowError(TypeError);
    expect(() => MediaStore.prototype.snapshot.call(storeWithMedia.media))
      .toThrowError(TypeError);

    store.deliveries.createPage("persisted-page");
    expect(openStore(path, "reopen").deliveries.validateOutputPages(["persisted-page"]))
      .toEqual(["persisted-page"]);
  });

  it("rejects stale writers instead of overwriting a newer runtime revision", () => {
    const first = openStore(path, "first");
    const stale = openStore(path, "stale");
    const staleBlocks = stale.blocks;
    const readStaleBlocks = stale.blocks.snapshot;
    const readStaleReferenceGraph = stale.referenceGraph.snapshot;
    const readStaleBlockCount = () => staleBlocks.size;
    first.deliveries.createPage("first-page");

    expect(() => stale.deliveries.createPage("stale-page")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(() => stale.revision).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(readStaleBlocks).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(readStaleReferenceGraph).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(readStaleBlockCount).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );

    const truth = openStore(path, "truth");
    expect(truth.deliveries.validateOutputPages(["first-page"])).toEqual(["first-page"]);
    expect(() => truth.deliveries.validateOutputPages(["stale-page"])).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({ code: "PAGE_NOT_FOUND" }),
    );
  });

  it("rejects a same-revision replacement instead of overwriting its bytes", () => {
    const store = openStore(path, "original");
    store.deliveries.createPage("original-page");

    const replacementPath = join(root, "replacement-core-state.json");
    const replacement = openStore(replacementPath, "replacement");
    replacement.deliveries.createPage("replacement-page");
    expect(replacement.revision).toBe(store.revision);

    const replacementBytes = readFileSync(replacementPath);
    writeFileSync(path, replacementBytes);

    expect(() => store.deliveries.createPage("later-page")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(readFileSync(path)).toEqual(replacementBytes);
  });

  it("requires a reopen when a changed component could not acquire the write lock", () => {
    const store = openStore(path, "first");
    withSynchronousCrossProcessLock({ resourceId: `${path}.lock` }, () => {
      expect(() => store.deliveries.createPage("page")).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_REOPEN_REQUIRED",
        }),
      );
    });
    expect(() => store.revision).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(() => openStore(path, "reopen").deliveries.validateOutputPages(["page"]))
      .toThrowError(
        expect.objectContaining<Partial<DeliveryStoreError>>({
          code: "PAGE_NOT_FOUND",
        }),
      );
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
      expect(() => store.releaseDeliveryClaim(request)).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_LOCKED",
        }),
      );
    });
    expect(() => store.releaseDeliveryClaim(request)).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );

    const retry = openStore(path, "retry");
    expect(retry.deliveries.inspectClaim(request).status).toBe("active");
    expect(retry.releaseDeliveryClaim(request)).toBe("released");

    const reopened = openStore(path, "reopened");
    expect(reopened.deliveries.inspectClaim(request).status).toBe("released");
    expect(reopened.deliveries.listActiveClaims()).toEqual([]);
    expect(reopened.referenceGraph.leaseCountFor({ kind: "block", id: block.id })).toBe(0);
  });

  it("rejects duplicate-key JSON and digest tampering on reconstruction", () => {
    openStore(path, "first");
    writeFileSync(
      path,
      '{"schemaVersion":"dolly.core-state/18","revision":0,"revision":1,"stateDigest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","referenceGraph":{},"blocks":{},"deliveries":{},"moduleProcessRecords":[],"moduleSubmissionRecords":[],"activeClaimsWithUnknownSubmissionHistory":[]}',
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

  it("rejects invalid nested state in older documents before reporting that migration is required", () => {
    for (const version of ["15", "16"] as const) {
      const legacyPath = join(root, `core-state-version-${version}.json`);
      const store = openStore(legacyPath, `version-${version}`);
      store.deliveries.createPage("input");
      store.deliveries.registerConsumer("input", "worker", "from-now");
      const block = store.blocks.commit(proposal("input"), {
        kind: "external",
        id: "console",
      });
      store.deliveries.append("input", block.id);
      store.deliveries.claim({
        consumerId: "worker",
        pageIds: ["input"],
        moduleGenerationId: "generation-1",
        maxCount: 1,
        maxBytes: 1024 * 1024,
      });

      const current = JSON.parse(
        readFileSync(legacyPath, "utf8"),
      ) as Record<string, unknown>;
      const deliveries = current.deliveries as {
        claims: Array<Record<string, unknown>>;
      };
      deliveries.claims[0]!.runId = `${deliveries.claims[0]!.runId as string}-different`;
      const basePayload = {
        revision: current.revision,
        referenceGraph: current.referenceGraph,
        blocks: current.blocks,
        deliveries: current.deliveries,
      };
      const legacyPayload =
        version === "15"
          ? basePayload
          : {
              ...basePayload,
              moduleProcessRecords: current.moduleProcessRecords,
              moduleSubmissionRecords: current.moduleSubmissionRecords,
            };
      const legacy = {
        schemaVersion: `dolly.core-state/${version}`,
        stateDigest: canonicalJsonDigest(legacyPayload as never),
        ...legacyPayload,
      };
      writeFileSync(legacyPath, `${JSON.stringify(legacy)}\n`, "utf8");

      expect(() => openStore(legacyPath, `invalid-${version}`)).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_DOCUMENT_INVALID",
        }),
      );
    }
  });

  it("requires an explicit migration instead of silently upgrading version 15", () => {
    openStore(path, "current");
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete current.moduleProcessRecords;
    delete current.moduleSubmissionRecords;
    delete current.activeClaimsWithUnknownSubmissionHistory;
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

    expect(migrateCoreStateDocumentToVersion18(path, MIGRATION_OPTIONS)).toEqual({
      status: "migrated",
      sourceSchemaVersion: "dolly.core-state/15",
      backupPath: resolve(`${path}.v15.backup`),
    });
    const migrated = openStore(path, "migrated");
    expect(migrated.snapshot().schemaVersion).toBe("dolly.core-state/18");
    expect(migrated.listModuleProcessRecords()).toEqual([]);
    expect(migrated.listModuleSubmissionRecords()).toEqual([]);
    expect(migrated.listActiveClaimsWithUnknownSubmissionHistory()).toEqual([]);
    expect(JSON.parse(readFileSync(`${path}.v15.backup`, "utf8"))).toMatchObject({
      schemaVersion: "dolly.core-state/15",
    });
    expect(migrateCoreStateDocumentToVersion18(path, MIGRATION_OPTIONS)).toEqual({
      status: "already-current",
      schemaVersion: "dolly.core-state/18",
    });
  });
});
