import { describe, expect, it, vi } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  type MediaInspector,
  type StorageAdapter,
  type StoragePutResult,
  type VolatileStorageAdapter,
} from "../../../src/core/media-store.js";

const NOW = "2026-07-24T00:00:00.000Z";

describe("Media original storage concurrency", () => {
  it("uploads once and keeps Media reachable until the storage operation finishes", async () => {
    let finishPut!: (result: StoragePutResult) => void;
    let markPutStarted!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    const pendingPut = new Promise<StoragePutResult>((resolve) => {
      finishPut = resolve;
    });
    const putOriginal = vi.fn(async () => {
      markPutStarted();
      return pendingPut;
    });
    const deleteObject = vi.fn(async () => "deleted" as const);
    const adapter: StorageAdapter = {
      descriptor: {
        adapterId: "delayed-storage",
        durability: "volatile",
        signedGet: false,
        publicUrl: false,
        supportsSignedCrop: false,
      },
      putOriginal,
      deleteObject,
    };
    const inspector: MediaInspector = {
      inspect: async () => ({ mimeType: "image/png", width: 2, height: 2 }),
    };
    let id = 0;
    const referenceGraph = new ReferenceGraph();
    const store = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes: new InMemoryMediaByteStore(),
      inspector,
      adapters: [adapter],
      maxMediaBytes: 1024,
      idNamespace: "storage-concurrency",
      now: () => NOW,
    });
    const media = await store.registerMedia(
      {
        registrationId: "registration-storage-concurrency",
        bytes: Uint8Array.of(1),
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    const blocks = new BlockStore({
      referenceGraph,
      media: store,
      nextBlockId: () => `block-${++id}`,
      now: () => NOW,
    });
    blocks.commitOnce("commit-storage-concurrency", {
      payload: {
        schema: "dolly.content/1",
        value: { items: [{ type: "media-reference", mediaId: media.mediaId }] },
      },
    }, { kind: "module", id: "module-storage-concurrency" });
    expect(store.releaseRegistration("registration-storage-concurrency")).toBe("released");
    expect(blocks.releaseCommitEffect("commit-storage-concurrency")).toBe("released");
    expect(blocks.collectUnreachable()).toHaveLength(1);

    const first = store.storeOriginal(media.mediaId, "delayed-storage");
    await putStarted;
    const second = store.storeOriginal(media.mediaId, "delayed-storage");
    const secondResult = expect(second).rejects.toMatchObject({
      code: "MEDIA_STORAGE_CONFLICT",
    });
    await expect(store.collectUnreachable()).resolves.toEqual({ media: [] });
    expect(putOriginal).toHaveBeenCalledOnce();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(referenceGraph.snapshot().leases).toEqual([
      expect.objectContaining({
        kind: "storage-operation",
        targetKind: "media",
        targetId: media.mediaId,
      }),
      expect.objectContaining({
        kind: "storage-operation",
        targetKind: "media",
        targetId: media.mediaId,
      }),
    ]);
    const restoredReferenceGraph = new ReferenceGraph({
      snapshot: referenceGraph.snapshot(),
    });
    expect(restoredReferenceGraph.leaseCountFor({ kind: "media", id: media.mediaId })).toBe(2);

    finishPut({
      locator: `objects/${media.mediaId}.png`,
      objectVersion: "object-version-1",
    });
    await expect(first).resolves.toMatchObject({ mediaId: media.mediaId });
    await secondResult;
    expect(putOriginal).toHaveBeenCalledOnce();
    expect(store.storageRecordCount(media.mediaId)).toBe(1);
    expect(referenceGraph.snapshot().leases).toEqual([]);

    await expect(store.collectUnreachable()).resolves.toEqual({
      media: [media.mediaId],
    });
    expect(deleteObject).toHaveBeenCalledWith(
      `objects/${media.mediaId}.png`,
      "object-version-1",
    );
  });

  it("keeps Media and records a retryable state when object deletion fails", async () => {
    let now = NOW;
    const unavailable = Object.assign(new Error("storage delete unavailable"), {
      code: "ECONNRESET",
    });
    const deleteObject = vi
      .fn<VolatileStorageAdapter["deleteObject"]>()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce("deleted");
    const adapter: StorageAdapter = {
      descriptor: {
        adapterId: "deletion-storage",
        durability: "volatile",
        signedGet: false,
        publicUrl: false,
        supportsSignedCrop: false,
      },
      putOriginal: async ({ mediaId }) => ({ locator: `objects/${mediaId}.png` }),
      deleteObject,
    };
    const bytes = new InMemoryMediaByteStore();
    const referenceGraph = new ReferenceGraph();
    let id = 0;
    const store = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes,
      inspector: {
        inspect: async () => ({ mimeType: "image/png", width: 2, height: 2 }),
      },
      adapters: [adapter],
      maxMediaBytes: 1024,
      idNamespace: "deletion-retry",
      now: () => now,
      deleteRetryDelayMs: () => 1_000,
    });
    const media = await store.registerMedia(
      {
        registrationId: "registration-deletion-retry",
        bytes: Uint8Array.of(1),
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    await store.storeOriginal(media.mediaId, "deletion-storage");
    const blocks = new BlockStore({
      referenceGraph,
      media: store,
      nextBlockId: () => `block-${++id}`,
      now: () => NOW,
    });
    blocks.commitOnce("commit-deletion-retry", {
      payload: {
        schema: "dolly.content/1",
        value: { items: [{ type: "media-reference", mediaId: media.mediaId }] },
      },
    }, { kind: "module", id: "module-deletion-retry" });
    expect(store.releaseRegistration("registration-deletion-retry")).toBe("released");
    expect(blocks.releaseCommitEffect("commit-deletion-retry")).toBe("released");
    expect(blocks.collectUnreachable()).toHaveLength(1);

    await expect(store.collectUnreachable()).rejects.toThrow("storage delete unavailable");
    expect(store.getMedia(media.mediaId)).toEqual(media);
    await expect(bytes.has(media.mediaId)).resolves.toBe(true);
    expect(referenceGraph.hasNode({ kind: "media", id: media.mediaId })).toBe(true);
    expect(store.listStorageRecords(media.mediaId)).toEqual([
      expect.objectContaining({
        state: "delete-failed",
        deleteAttempts: 1,
        deleteRetryable: true,
        nextDeleteAttemptAt: "2026-07-24T00:00:01.000Z",
        lastDeleteErrorCode: "TRANSIENT_NETWORK",
      }),
    ]);

    await expect(store.collectUnreachable()).resolves.toEqual({ media: [] });
    now = "2026-07-24T00:00:01.000Z";
    await expect(store.collectUnreachable()).resolves.toEqual({ media: [media.mediaId] });
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(store.getMedia(media.mediaId)).toBeNull();
    await expect(bytes.has(media.mediaId)).resolves.toBe(false);
    expect(store.storageRecordCount(media.mediaId)).toBe(0);
  });

  it("rejects new Block references while deletion is in progress", async () => {
    let finishDelete!: () => void;
    let markDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    const pendingDelete = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    const adapter: StorageAdapter = {
      descriptor: {
        adapterId: "delayed-deletion",
        durability: "volatile",
        signedGet: false,
        publicUrl: false,
        supportsSignedCrop: false,
      },
      putOriginal: async ({ mediaId }) => ({ locator: `objects/${mediaId}.png` }),
      deleteObject: async () => {
        markDeleteStarted();
        await pendingDelete;
        return "deleted";
      },
    };
    const referenceGraph = new ReferenceGraph();
    const bytes = new InMemoryMediaByteStore();
    let id = 0;
    const store = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes,
      inspector: {
        inspect: async () => ({ mimeType: "image/png", width: 2, height: 2 }),
      },
      adapters: [adapter],
      maxMediaBytes: 1024,
      idNamespace: "deletion-in-progress",
      now: () => NOW,
    });
    const media = await store.registerMedia(
      {
        registrationId: "registration-deletion-in-progress",
        bytes: Uint8Array.of(1),
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    await store.storeOriginal(media.mediaId, "delayed-deletion");
    const blocks = new BlockStore({
      referenceGraph,
      media: store,
      nextBlockId: () => `block-${++id}`,
      now: () => NOW,
    });
    blocks.commitOnce("commit-deletion-in-progress", {
      payload: {
        schema: "dolly.content/1",
        value: { items: [{ type: "media-reference", mediaId: media.mediaId }] },
      },
    }, { kind: "module", id: "module-deletion-in-progress" });
    expect(store.releaseRegistration("registration-deletion-in-progress")).toBe("released");
    expect(blocks.releaseCommitEffect("commit-deletion-in-progress")).toBe("released");
    expect(blocks.collectUnreachable()).toHaveLength(1);
    const deletion = store.collectUnreachable();
    await deleteStarted;

    expect(() => blocks.commit({
      payload: {
        schema: "dolly.content/1",
        value: { items: [{ type: "media-reference", mediaId: media.mediaId }] },
      },
    }, { kind: "module", id: "module-1" })).toThrowError(
      expect.objectContaining({ code: "BLOCK_MEDIA_REFERENCE_INVALID" }),
    );

    finishDelete();
    await expect(deletion).resolves.toEqual({ media: [media.mediaId] });
    expect(store.getMedia(media.mediaId)).toBeNull();
    await expect(bytes.has(media.mediaId)).resolves.toBe(false);
  });

  it("does not persist deletion while an unreachable Block still depends on Media", async () => {
    const referenceGraph = new ReferenceGraph();
    const bytes = new InMemoryMediaByteStore();
    let id = 0;
    const store = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes,
      inspector: {
        inspect: async () => ({ mimeType: "image/png", width: 2, height: 2 }),
      },
      maxMediaBytes: 1024,
      idNamespace: "dependent-block",
      now: () => NOW,
    });
    const media = await store.registerMedia({
      registrationId: "registration-dependent-block",
      bytes: Uint8Array.of(1),
      provenance: { sourceClass: "streamed-upload" },
    });
    const blocks = new BlockStore({
      referenceGraph,
      media: store,
      nextBlockId: () => `block-${++id}`,
      now: () => NOW,
    });
    blocks.commitOnce("commit-dependent-block", {
      payload: {
        schema: "dolly.content/1",
        value: { items: [{ type: "media-reference", mediaId: media.mediaId }] },
      },
    }, { kind: "module", id: "module-dependent-block" });
    expect(store.releaseRegistration("registration-dependent-block")).toBe("released");
    expect(blocks.releaseCommitEffect("commit-dependent-block")).toBe("released");
    expect(referenceGraph.isReachable({ kind: "media", id: media.mediaId })).toBe(false);

    await expect(store.collectUnreachable()).rejects.toMatchObject({
      code: "REFERENCE_GRAPH_NODE_REFERENCED",
    });
    expect(store.listRegistrations()).toEqual([
      expect.objectContaining({ state: "available", holdsRegistrationReference: false }),
    ]);
    await expect(bytes.has(media.mediaId)).resolves.toBe(true);

    expect(blocks.collectUnreachable()).toHaveLength(1);
    await expect(store.collectUnreachable()).resolves.toEqual({ media: [media.mediaId] });
  });
});
