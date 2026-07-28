import { describe, expect, it, vi } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  MediaStoreError,
  type Media,
  type MediaByteStore,
  type MediaInspector,
  type MediaRegistrationRequest,
  type MediaStoreSnapshot,
  type StorageAdapter,
  type VolatileStorageAdapter,
} from "../../../src/core/media-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";

const START = "2026-07-25T00:00:00.000Z";

const defaultInspector: MediaInspector = {
  inspect: async () => ({ mimeType: "image/png", width: 2, height: 2 }),
};

function createSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createRecordingByteStore(options: {
  readonly beforePut?: () => Promise<void>;
  readonly beforeDelete?: () => Promise<void>;
} = {}) {
  const stored = new Map<string, Uint8Array>();
  const put = vi.fn<MediaByteStore["put"]>(async (mediaId, bytes) => {
    await options.beforePut?.();
    if (stored.has(mediaId)) throw new Error(`Bytes for ${mediaId} already exist`);
    stored.set(mediaId, Uint8Array.from(bytes));
  });
  const get = vi.fn<MediaByteStore["get"]>(async (mediaId) => {
    const bytes = stored.get(mediaId);
    if (!bytes) throw new Error(`Bytes for ${mediaId} do not exist`);
    return Uint8Array.from(bytes);
  });
  const deleteBytes = vi.fn<MediaByteStore["delete"]>(async (mediaId) => {
    await options.beforeDelete?.();
    stored.delete(mediaId);
  });
  const has = vi.fn<MediaByteStore["has"]>(async (mediaId) => stored.has(mediaId));
  const byteStore: MediaByteStore = {
    durability: "volatile",
    put,
    get,
    delete: deleteBytes,
    has,
  };
  return { byteStore, put, get, deleteBytes, has };
}

function createStore(options: {
  readonly idNamespace: string;
  readonly referenceGraph?: ReferenceGraph;
  readonly bytes?: MediaByteStore;
  readonly inspector?: MediaInspector;
  readonly adapters?: readonly StorageAdapter[];
  readonly maxMediaBytes?: number;
  readonly maxTotalMediaBytes?: number;
  readonly maxRegistrationRecords?: number;
  readonly maxStorageRecords?: number;
  readonly maxProviderAccessRecords?: number;
  readonly deletedRegistrationRetentionMs?: number;
  readonly now?: () => string;
  readonly snapshot?: MediaStoreSnapshot;
}): MediaStore {
  return new MediaStore({
    durability: "volatile",
    referenceGraph: options.referenceGraph ?? new ReferenceGraph(),
    bytes: options.bytes ?? new InMemoryMediaByteStore(),
    inspector: options.inspector ?? defaultInspector,
    adapters: options.adapters,
    maxMediaBytes: options.maxMediaBytes ?? 16,
    maxTotalMediaBytes: options.maxTotalMediaBytes,
    maxRegistrationRecords: options.maxRegistrationRecords,
    maxStorageRecords: options.maxStorageRecords,
    maxProviderAccessRecords: options.maxProviderAccessRecords,
    deletedRegistrationRetentionMs: options.deletedRegistrationRetentionMs,
    idNamespace: options.idNamespace,
    now: options.now ?? (() => START),
    snapshot: options.snapshot,
  });
}

function registration(
  registrationId: string,
  bytes: Uint8Array = Uint8Array.of(1),
): MediaRegistrationRequest {
  return {
    registrationId,
    bytes,
    provenance: { sourceClass: "streamed-upload" },
  };
}

function createBlockStore(
  media: MediaStore,
  referenceGraph: ReferenceGraph,
  prefix: string,
): BlockStore {
  let nextBlock = 0;
  return new BlockStore({
    referenceGraph,
    media,
    nextBlockId: () => `${prefix}-block-${++nextBlock}`,
    now: () => START,
  });
}

function makeMediaCollectible(
  mediaStore: MediaStore,
  blocks: BlockStore,
  registrationId: string,
  media: Media,
  suffix: string,
): void {
  const effectId = `effect-${suffix}`;
  const block = blocks.commitOnce(effectId, {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "media-reference", mediaId: media.mediaId }] },
    },
  }, { kind: "module", id: "media-resource-limit-test" });
  expect(mediaStore.releaseRegistration(registrationId)).toBe("released");
  expect(blocks.releaseCommitEffect(effectId)).toBe("released");
  expect(blocks.collectUnreachable()).toEqual([block]);
}

async function expectMediaStoreError(
  operation: Promise<unknown>,
): Promise<MediaStoreError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(MediaStoreError);
    return error as MediaStoreError;
  }
  throw new Error("Expected MediaStore operation to fail");
}

describe("MediaStore resource limits", () => {
  it("allows an idempotent retry when registration records are full and rejects a new ID before inspection, allocation, or byte I/O", async () => {
    const bytes = createRecordingByteStore();
    const inspect = vi.fn<MediaInspector["inspect"]>(async () => ({
      mimeType: "image/png",
      width: 2,
      height: 2,
    }));
    const store = createStore({
      idNamespace: "registration-limit",
      bytes: bytes.byteStore,
      inspector: { inspect },
      maxRegistrationRecords: 1,
    });
    const firstInput = registration("registration-first", Uint8Array.of(1, 2));
    const first = await store.registerMedia(firstInput);
    const callsAfterFirst = {
      inspect: inspect.mock.calls.length,
      put: bytes.put.mock.calls.length,
      get: bytes.get.mock.calls.length,
      delete: bytes.deleteBytes.mock.calls.length,
      has: bytes.has.mock.calls.length,
      nextIdSequence: store.snapshot().nextIdSequence,
    };

    await expect(store.registerMedia(firstInput)).resolves.toEqual(first);
    const error = await expectMediaStoreError(
      store.registerMedia(registration("registration-second", Uint8Array.of(3))),
    );

    expect(error.code).toBe("MEDIA_LIMIT_EXCEEDED");
    expect(error.details).toEqual({
      limitName: "maxRegistrationRecords",
      limit: 1,
      current: 1,
      requested: 1,
    });
    expect({
      inspect: inspect.mock.calls.length,
      put: bytes.put.mock.calls.length,
      get: bytes.get.mock.calls.length,
      delete: bytes.deleteBytes.mock.calls.length,
      has: bytes.has.mock.calls.length,
      nextIdSequence: store.snapshot().nextIdSequence,
    }).toEqual(callsAfterFirst);
  });

  it("admits only one of two registrations competing for the last record", async () => {
    const bytes = createRecordingByteStore();
    const inspect = vi.fn<MediaInspector["inspect"]>(async () => ({
      mimeType: "image/png",
      width: 1,
      height: 1,
    }));
    const store = createStore({
      idNamespace: "concurrent-registration-limit",
      bytes: bytes.byteStore,
      inspector: { inspect },
      maxRegistrationRecords: 1,
    });

    const results = await Promise.allSettled([
      store.registerMedia(registration("registration-left")),
      store.registerMedia(registration("registration-right")),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = rejected[0]!.status === "rejected" ? rejected[0].reason : undefined;
    expect(error).toBeInstanceOf(MediaStoreError);
    expect(error).toMatchObject({
      code: "MEDIA_LIMIT_EXCEEDED",
      details: {
        limitName: "maxRegistrationRecords",
        limit: 1,
        current: 1,
        requested: 1,
      },
    });
    expect(store.listRegistrations()).toHaveLength(1);
    expect(store.snapshot().media).toHaveLength(1);
    expect(store.snapshot().nextIdSequence).toBe("1");
    expect(inspect).toHaveBeenCalledOnce();
    expect(bytes.put).toHaveBeenCalledOnce();
  });

  it("allows independent registrations to inspect bytes concurrently after reserving capacity", async () => {
    const inspectionCanFinish = createSignal();
    let activeInspections = 0;
    let greatestActiveInspectionCount = 0;
    const inspect = vi.fn<MediaInspector["inspect"]>(async () => {
      activeInspections += 1;
      greatestActiveInspectionCount = Math.max(
        greatestActiveInspectionCount,
        activeInspections,
      );
      await inspectionCanFinish.promise;
      activeInspections -= 1;
      return { mimeType: "image/png", width: 1, height: 1 };
    });
    const store = createStore({
      idNamespace: "concurrent-registration-inspection",
      inspector: { inspect },
      maxMediaBytes: 1,
      maxRegistrationRecords: 2,
      maxTotalMediaBytes: 2,
    });

    const first = store.registerMedia(registration("registration-concurrent-first"));
    const second = store.registerMedia(registration("registration-concurrent-second"));
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    inspectionCanFinish.resolve();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(greatestActiveInspectionCount).toBe(2);
  });

  it("releases reserved capacity when inspection fails", async () => {
    const inspect = vi.fn<MediaInspector["inspect"]>()
      .mockRejectedValueOnce(new Error("inspection failed"))
      .mockResolvedValue({ mimeType: "image/png", width: 1, height: 1 });
    const store = createStore({
      idNamespace: "failed-inspection-reservation",
      inspector: { inspect },
      maxMediaBytes: 1,
      maxRegistrationRecords: 1,
      maxTotalMediaBytes: 1,
    });

    await expect(
      store.registerMedia(registration("registration-failed-inspection")),
    ).rejects.toThrow("inspection failed");
    expect(store.snapshot()).toMatchObject({
      nextIdSequence: "0",
      registrations: [],
      media: [],
    });
    await expect(
      store.registerMedia(registration("registration-after-failed-inspection")),
    ).resolves.toMatchObject({ byteLength: 1 });
  });

  it("counts pending, available, and deleting bytes and releases them after deletion is persisted", async () => {
    const putStarted = createSignal();
    const putCanFinish = createSignal();
    const deleteStarted = createSignal();
    const deleteCanFinish = createSignal();
    const bytes = createRecordingByteStore({
      beforePut: async () => {
        putStarted.resolve();
        await putCanFinish.promise;
      },
      beforeDelete: async () => {
        deleteStarted.resolve();
        await deleteCanFinish.promise;
      },
    });
    const referenceGraph = new ReferenceGraph();
    const store = createStore({
      idNamespace: "total-byte-limit",
      referenceGraph,
      bytes: bytes.byteStore,
      maxMediaBytes: 4,
      maxTotalMediaBytes: 4,
    });
    const firstRegistration = registration(
      "registration-four-bytes",
      Uint8Array.of(1, 2, 3, 4),
    );
    const registering = store.registerMedia(firstRegistration);
    await putStarted.promise;
    expect(store.snapshot().registrations).toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);

    const pendingInspector = vi.fn<MediaInspector["inspect"]>();
    const restoredPending = createStore({
      idNamespace: "total-byte-limit",
      referenceGraph: new ReferenceGraph({ snapshot: referenceGraph.snapshot() }),
      bytes: bytes.byteStore,
      inspector: { inspect: pendingInspector },
      maxMediaBytes: 4,
      maxTotalMediaBytes: 4,
      snapshot: store.snapshot(),
    });
    const pendingError = await expectMediaStoreError(
      restoredPending.registerMedia(registration("registration-pending-rejected")),
    );
    expect(pendingError.details).toEqual({
      limitName: "maxTotalMediaBytes",
      limit: 4,
      current: 4,
      requested: 1,
    });
    expect(pendingInspector).not.toHaveBeenCalled();

    putCanFinish.resolve();
    const media = await registering;
    const availableError = await expectMediaStoreError(
      store.registerMedia(registration("registration-next")),
    );
    expect(availableError.details).toEqual({
      limitName: "maxTotalMediaBytes",
      limit: 4,
      current: 4,
      requested: 1,
    });

    const blocks = createBlockStore(store, referenceGraph, "total-byte-limit");
    makeMediaCollectible(
      store,
      blocks,
      firstRegistration.registrationId,
      media,
      "total-byte-limit",
    );
    const deleting = store.collectUnreachable();
    await deleteStarted.promise;
    expect(store.snapshot().registrations).toEqual([
      expect.objectContaining({ state: "deleting" }),
    ]);
    const deletingError = await expectMediaStoreError(
      store.registerMedia(registration("registration-next")),
    );
    expect(deletingError.details).toEqual({
      limitName: "maxTotalMediaBytes",
      limit: 4,
      current: 4,
      requested: 1,
    });

    deleteCanFinish.resolve();
    await expect(deleting).resolves.toEqual({ media: [media.mediaId] });
    await expect(
      store.registerMedia(registration("registration-next")),
    ).resolves.toMatchObject({ byteLength: 1 });
  });

  it("reserves storage-record capacity before PUT and does not exceed it concurrently", async () => {
    const putStarted = createSignal();
    const putCanFinish = createSignal();
    const putOriginal = vi.fn<VolatileStorageAdapter["putOriginal"]>(async ({ mediaId }) => {
      putStarted.resolve();
      await putCanFinish.promise;
      return { locator: `objects/${mediaId}` };
    });
    const adapter: StorageAdapter = {
      descriptor: {
        adapterId: "limited-storage",
        durability: "volatile",
        signedGet: false,
        publicUrl: false,
        supportsSignedCrop: false,
      },
      putOriginal,
      deleteObject: async () => "deleted",
    };
    const bytes = createRecordingByteStore();
    const store = createStore({
      idNamespace: "storage-record-limit",
      bytes: bytes.byteStore,
      adapters: [adapter],
      maxStorageRecords: 1,
    });
    const first = await store.registerMedia(registration("registration-storage-first"));
    const second = await store.registerMedia(registration("registration-storage-second"));
    bytes.get.mockClear();

    const firstStorage = store.storeOriginal(first.mediaId, adapter.descriptor.adapterId);
    await putStarted.promise;
    const sequenceBeforeRejection = store.snapshot().nextIdSequence;
    const error = await expectMediaStoreError(
      store.storeOriginal(second.mediaId, adapter.descriptor.adapterId),
    );

    expect(error.details).toEqual({
      limitName: "maxStorageRecords",
      limit: 1,
      current: 1,
      requested: 1,
    });
    expect(putOriginal).toHaveBeenCalledOnce();
    expect(bytes.get).toHaveBeenCalledOnce();
    expect(store.snapshot().nextIdSequence).toBe(sequenceBeforeRejection);
    expect(store.snapshot().storageRecords).toEqual([]);

    putCanFinish.resolve();
    await expect(firstStorage).resolves.toMatchObject({
      mediaId: first.mediaId,
      adapterId: adapter.descriptor.adapterId,
      state: "available",
    });
    expect(store.snapshot().storageRecords).toHaveLength(1);
  });

  it("reserves provider-access capacity before signing or reading bytes and allows reuse after release", async () => {
    const signStarted = createSignal();
    const signCanFinish = createSignal();
    const signGet = vi.fn<NonNullable<StorageAdapter["signGet"]>>(async ({ locator }) => {
      signStarted.resolve();
      await signCanFinish.promise;
      return `https://private.example/${locator}?signed=1`;
    });
    const adapter: StorageAdapter = {
      descriptor: {
        adapterId: "signed-storage",
        durability: "volatile",
        signedGet: true,
        publicUrl: false,
        supportsSignedCrop: false,
      },
      putOriginal: async ({ mediaId }) => ({ locator: `objects/${mediaId}` }),
      deleteObject: async () => "deleted",
      signGet,
    };
    const bytes = createRecordingByteStore();
    const store = createStore({
      idNamespace: "provider-access-limit",
      bytes: bytes.byteStore,
      adapters: [adapter],
      maxProviderAccessRecords: 1,
    });
    const media = await store.registerMedia(registration("registration-provider-access"));
    await store.storeOriginal(media.mediaId, adapter.descriptor.adapterId);
    bytes.get.mockClear();

    const firstAccess = store.resolveProviderAccess({
      mediaId: media.mediaId,
      requestId: "request-first",
      recipientId: "recipient-first",
      acceptedAccessModes: ["private-signed"],
      signedUrlExpiresInSeconds: 60,
    });
    await signStarted.promise;
    const sequenceBeforeRejection = store.snapshot().nextIdSequence;
    const error = await expectMediaStoreError(store.resolveProviderAccess({
      mediaId: media.mediaId,
      requestId: "request-second",
      recipientId: "recipient-second",
      acceptedAccessModes: ["private-signed"],
      signedUrlExpiresInSeconds: 60,
    }));

    expect(error.details).toEqual({
      limitName: "maxProviderAccessRecords",
      limit: 1,
      current: 1,
      requested: 1,
    });
    expect(signGet).toHaveBeenCalledOnce();
    expect(bytes.get).not.toHaveBeenCalled();
    expect(store.snapshot().nextIdSequence).toBe(sequenceBeforeRejection);
    expect(store.listProviderAccessRecords()).toEqual([]);

    signCanFinish.resolve();
    const firstGrant = await firstAccess;
    if (firstGrant.accessMode === "inline") {
      throw new Error("expected provider access to return a URL grant");
    }
    expect(store.listProviderAccessRecords()).toHaveLength(1);
    expect(store.recordProviderAccessOutcome({
      leaseId: firstGrant.leaseId,
      requestId: "request-first",
      recipientId: "recipient-first",
      outcome: "finished",
    })).toBe("released");

    const nextGrant = await store.resolveProviderAccess({
      mediaId: media.mediaId,
      requestId: "request-after-release",
      recipientId: "recipient-after-release",
      acceptedAccessModes: ["private-signed"],
      signedUrlExpiresInSeconds: 60,
    });
    if (nextGrant.accessMode === "inline") {
      throw new Error("expected provider access to return a URL grant");
    }
    expect(signGet).toHaveBeenCalledTimes(2);
    expect(store.recordProviderAccessOutcome({
      leaseId: nextGrant.leaseId,
      requestId: "request-after-release",
      recipientId: "recipient-after-release",
      outcome: "finished",
    })).toBe("released");
  });

  it("restores state above current limits for reads, release, and deletion but rejects additions", async () => {
    const bytes = new InMemoryMediaByteStore();
    const originalGraph = new ReferenceGraph();
    const original = createStore({
      idNamespace: "restored-limits",
      referenceGraph: originalGraph,
      bytes,
      maxMediaBytes: 4,
      maxTotalMediaBytes: 8,
      maxRegistrationRecords: 2,
    });
    const first = await original.registerMedia(
      registration("registration-restored-first", Uint8Array.of(1, 2, 3, 4)),
    );
    const second = await original.registerMedia(
      registration("registration-restored-second", Uint8Array.of(5, 6, 7, 8)),
    );
    const restoredGraph = new ReferenceGraph({ snapshot: originalGraph.snapshot() });
    const inspect = vi.fn<MediaInspector["inspect"]>();
    const restored = createStore({
      idNamespace: "restored-limits",
      referenceGraph: restoredGraph,
      bytes,
      inspector: { inspect },
      maxMediaBytes: 4,
      maxTotalMediaBytes: 4,
      maxRegistrationRecords: 1,
      snapshot: original.snapshot(),
    });

    expect(restored.getMedia(first.mediaId)).toEqual(first);
    expect(restored.getMedia(second.mediaId)).toEqual(second);
    const error = await expectMediaStoreError(
      restored.registerMedia(registration("registration-restored-new")),
    );
    expect(error.details).toEqual({
      limitName: "maxRegistrationRecords",
      limit: 1,
      current: 2,
      requested: 1,
    });
    expect(inspect).not.toHaveBeenCalled();

    const blocks = createBlockStore(restored, restoredGraph, "restored-limits");
    makeMediaCollectible(
      restored,
      blocks,
      "registration-restored-first",
      first,
      "restored-first",
    );
    makeMediaCollectible(
      restored,
      blocks,
      "registration-restored-second",
      second,
      "restored-second",
    );
    const deletion = await restored.collectUnreachable();
    expect(new Set(deletion.media)).toEqual(new Set([first.mediaId, second.mediaId]));
    expect(restored.getMedia(first.mediaId)).toBeNull();
    expect(restored.getMedia(second.mediaId)).toBeNull();
  });

  it("retains compact deleted registrations through their deadline and permits ID reuse at the boundary", async () => {
    let now = START;
    const referenceGraph = new ReferenceGraph();
    const store = createStore({
      idNamespace: "deleted-registration-retention",
      referenceGraph,
      deletedRegistrationRetentionMs: 1_000,
      now: () => now,
    });
    const input: MediaRegistrationRequest = {
      registrationId: "registration-retained-deletion",
      bytes: Uint8Array.of(1, 2, 3),
      declaredMimeType: "image/png",
      provenance: {
        sourceClass: "streamed-upload",
        sourceLabel: "retention-test",
      },
    };
    const media = await store.registerMedia(input);
    const blocks = createBlockStore(store, referenceGraph, "deleted-retention");
    makeMediaCollectible(
      store,
      blocks,
      input.registrationId,
      media,
      "deleted-retention",
    );
    await expect(store.collectUnreachable()).resolves.toEqual({ media: [media.mediaId] });

    expect(store.snapshot().registrations).toEqual([{
      schemaVersion: "dolly.media-registration/4",
      registrationId: input.registrationId,
      state: "deleted",
      holdsRegistrationReference: false,
      mediaId: media.mediaId,
      digest: media.digest,
      byteLength: media.byteLength,
      declaredMimeType: "image/png",
      provenance: input.provenance,
      retainUntil: "2026-07-25T00:00:01.000Z",
    }]);

    now = "2026-07-25T00:00:00.999Z";
    const deletedError = await expectMediaStoreError(store.registerMedia(input));
    expect(deletedError.code).toBe("MEDIA_REGISTRATION_DELETED");
    expect(deletedError.details).toEqual({
      registrationId: input.registrationId,
      mediaId: media.mediaId,
    });
    const conflictError = await expectMediaStoreError(store.registerMedia({
      ...input,
      bytes: Uint8Array.of(9, 9, 9),
    }));
    expect(conflictError.code).toBe("MEDIA_REGISTRATION_CONFLICT");
    expect(conflictError.details).toEqual({
      registrationId: input.registrationId,
      mediaId: media.mediaId,
    });

    now = "2026-07-25T00:00:01.000Z";
    expect(store.removeExpiredDeletedRegistrations()).toEqual([input.registrationId]);
    expect(store.listRegistrations()).toEqual([]);
    const reused = await store.registerMedia(input);
    expect(reused.mediaId).not.toBe(media.mediaId);
  });

  it("keeps resource collections and snapshot bytes bounded across repeated expiration", async () => {
    const referenceGraph = new ReferenceGraph();
    const store = createStore({
      idNamespace: "bounded-expiration",
      referenceGraph,
      maxMediaBytes: 1,
      maxTotalMediaBytes: 1,
      maxRegistrationRecords: 1,
      maxStorageRecords: 1,
      maxProviderAccessRecords: 1,
      deletedRegistrationRetentionMs: 0,
    });
    const blocks = createBlockStore(store, referenceGraph, "bounded-expiration");
    const snapshots: MediaStoreSnapshot[] = [];

    for (let round = 1; round <= 40; round += 1) {
      const registrationId = `registration-bounded-${round}`;
      const media = await store.registerMedia(registration(registrationId));
      makeMediaCollectible(
        store,
        blocks,
        registrationId,
        media,
        `bounded-${round}`,
      );
      await expect(store.collectUnreachable()).resolves.toEqual({ media: [media.mediaId] });
      expect(store.removeExpiredDeletedRegistrations()).toEqual([registrationId]);
      const snapshot = store.snapshot();
      expect(snapshot.registrations).toEqual([]);
      expect(snapshot.media).toEqual([]);
      expect(snapshot.storageRecords).toEqual([]);
      expect(snapshot.providerAccess).toEqual([]);
      snapshots.push(snapshot);
    }

    const normalizedByteLengths = snapshots.map((snapshot) => Buffer.byteLength(
      JSON.stringify({ ...snapshot, nextIdSequence: "" }),
      "utf8",
    ));
    expect(new Set(normalizedByteLengths)).toEqual(new Set([normalizedByteLengths[0]]));

    const snapshotByteLengths = snapshots.map((snapshot) =>
      Buffer.byteLength(JSON.stringify(snapshot), "utf8")
    );
    const sequenceByteLengths = snapshots.map((snapshot) =>
      Buffer.byteLength(snapshot.nextIdSequence, "utf8")
    );
    expect(Math.max(...snapshotByteLengths) - Math.min(...snapshotByteLengths)).toBe(
      Math.max(...sequenceByteLengths) - Math.min(...sequenceByteLengths),
    );
  });
});
