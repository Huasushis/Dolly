import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileMediaByteStore } from "../../../src/core/file-media-byte-store.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  type Media,
  type MediaByteStore,
  type MediaInspector,
  type MediaStoreSnapshot,
  type PersistentStorageAdapter,
  type PersistentStorageDeleteInput,
  type StorageAdapter,
  type VolatileStorageAdapter,
} from "../../../src/core/media-store.js";
import {
  ReferenceGraph,
  type ReferenceGraphSnapshot,
} from "../../../src/core/reference-graph.js";

const START = "2026-07-25T00:00:00.000Z";
const RETRY_DUE = "2026-07-25T00:00:01.000Z";
const inspector: MediaInspector = {
  inspect: async () => ({ mimeType: "image/png", width: 2, height: 2 }),
};

class DeleteThenFailByteStore implements MediaByteStore {
  readonly durability = "persistent" as const;
  #failDelete = true;

  constructor(private readonly inner: FileMediaByteStore) {}

  put(mediaId: string, bytes: Uint8Array): Promise<void> {
    return this.inner.put(mediaId, bytes);
  }

  get(mediaId: string): Promise<Uint8Array> {
    return this.inner.get(mediaId);
  }

  async delete(mediaId: string): Promise<void> {
    await this.inner.delete(mediaId);
    if (!this.#failDelete) return;
    this.#failDelete = false;
    throw new Error("simulated lost byte deletion response");
  }

  has(mediaId: string): Promise<boolean> {
    return this.inner.has(mediaId);
  }
}

type DeleteImplementation = (
  input: string | PersistentStorageDeleteInput,
  objectVersion?: string,
) => Promise<"deleted" | "not-found">;

function storageAdapter(
  adapterId: string,
  deleteObject: DeleteImplementation,
  durability: "volatile" | "persistent" = "volatile",
): StorageAdapter {
  if (durability === "volatile") {
    const adapter: VolatileStorageAdapter = {
      descriptor: {
        adapterId,
        durability,
        signedGet: false,
        publicUrl: false,
        supportsSignedCrop: false,
      },
      putOriginal: async ({ mediaId }) => ({
        locator: `objects/${adapterId}/${mediaId}.png`,
        objectVersion: `version-${adapterId}`,
      }),
      deleteObject: (locator, objectVersion) => deleteObject(locator, objectVersion),
    };
    return adapter;
  }

  const storedObjects = new Map<
    string,
    Extract<Awaited<ReturnType<PersistentStorageAdapter["headOriginal"]>>, {
      readonly status: "found";
    }>
  >();
  const storageNamespace = {
    provider: "fixture",
    container: adapterId,
  } as const;
  const adapter: PersistentStorageAdapter = {
    descriptor: {
      adapterId,
      durability,
      signedGet: false,
      publicUrl: false,
      supportsSignedCrop: false,
      storageNamespace,
      objectVersioning: "disabled",
    },
    planOriginal: ({ mediaId }) => ({
      locator: `objects/${adapterId}/${mediaId}.png`,
    }),
    putOriginalIfAbsent: async (input) => {
      if (storedObjects.has(input.locator)) throw new Error("Object already exists");
      const entityTag = `etag-${adapterId}`;
      storedObjects.set(input.locator, {
        status: "found",
        storageRecordId: input.storageRecordId,
        digest: input.digest,
        byteLength: input.bytes.byteLength,
        mimeType: input.mimeType,
        storageNamespaceDigest: input.storageNamespaceDigest,
        entityTag,
      });
      return { locator: input.locator, entityTag };
    },
    headOriginal: async ({ locator }) =>
      storedObjects.get(locator) ?? { status: "not-found" },
    deleteObject: async (input) => {
      const result = await deleteObject(input);
      if (result === "deleted" || result === "not-found") storedObjects.delete(input.locator);
      return result;
    },
  };
  return adapter;
}

function openFileCore(
  root: string,
  bytes: MediaByteStore,
  prefix: string,
  now: () => string,
  adapters: readonly StorageAdapter[] = [],
): FileCoreStateStore {
  let blockId = 0;
  let deliveryId = 0;
  return new FileCoreStateStore({
    path: join(root, "core.json"),
    maxFailedAttempts: 3,
    nextBlockId: () => `${prefix}-block-${++blockId}`,
    nextDeliveryId: (kind) => `${prefix}-${kind}-${++deliveryId}`,
    now,
    media: {
      durability: "persistent",
      bytes,
      inspector,
      adapters,
      maxMediaBytes: 1024,
      idNamespace: "deletion-file-core",
    },
  });
}

function volatileHarness(
  prefix: string,
  now: () => string,
  adapters: readonly StorageAdapter[] = [],
): { readonly media: MediaStore; readonly blocks: BlockStore } {
  const referenceGraph = new ReferenceGraph();
  let blockId = 0;
  const media = new MediaStore({
    durability: "volatile",
    referenceGraph,
    bytes: new InMemoryMediaByteStore(),
    inspector,
    adapters,
    maxMediaBytes: 1024,
    idNamespace: prefix,
    now,
  });
  return {
    media,
    blocks: new BlockStore({
      referenceGraph,
      media,
      nextBlockId: () => `${prefix}-block-${++blockId}`,
      now,
    }),
  };
}

async function makeCollectible(
  mediaStore: MediaStore,
  blocks: BlockStore,
  registrationId: string,
  beforeRelease?: (media: Media) => Promise<void>,
): Promise<Media> {
  const media = await mediaStore.registerMedia({
    registrationId,
    bytes: Uint8Array.of(1, 2, 3),
    provenance: { sourceClass: "streamed-upload" },
  });
  const effectId = `handoff-${registrationId}`;
  const block = blocks.commitOnce(effectId, {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "media-reference", mediaId: media.mediaId }] },
    },
  }, { kind: "module", id: "deletion-recovery-test" });
  await beforeRelease?.(media);
  expect(mediaStore.releaseRegistration(registrationId)).toBe("released");
  expect(blocks.releaseCommitEffect(effectId)).toBe("released");
  expect(blocks.collectUnreachable()).toEqual([block]);
  return media;
}

describe("Media deletion recovery", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers after bytes were deleted but their deletion response was lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-media-delete-bytes-"));
    roots.push(root);
    const fileBytes = new FileMediaByteStore({
      directory: join(root, "bytes"),
      maxMediaBytes: 1024,
    });
    const first = openFileCore(
      root,
      new DeleteThenFailByteStore(fileBytes),
      "first",
      () => START,
    );
    const registered = await makeCollectible(
      first.media!,
      first.blocks,
      "registration-byte-response-loss",
    );

    await expect(first.media!.collectUnreachable()).rejects.toThrow(
      "simulated lost byte deletion response",
    );
    expect(first.media!.listRegistrations()).toEqual([
      expect.objectContaining({ state: "deleting", holdsRegistrationReference: false }),
    ]);
    await expect(fileBytes.has(registered.mediaId)).resolves.toBe(false);

    const reopened = openFileCore(root, fileBytes, "reopened", () => START);
    await expect(reopened.media!.recoverDeletions()).resolves.toEqual({
      deleted: [registered.mediaId],
      failed: [],
    });
    expect(reopened.media!.getMedia(registered.mediaId)).toBeNull();
    expect(reopened.media!.listRegistrations()).toEqual([
      expect.objectContaining({ state: "deleted", holdsRegistrationReference: false }),
    ]);

    const verified = openFileCore(root, fileBytes, "verified", () => START);
    expect(verified.media!.listRegistrations()).toEqual([
      expect.objectContaining({ state: "deleted" }),
    ]);
  });

  it("retries a lost adapter deletion response only when its retry time is due", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-media-delete-adapter-"));
    roots.push(root);
    const bytes = new FileMediaByteStore({
      directory: join(root, "bytes"),
      maxMediaBytes: 1024,
    });
    let now = START;
    let objectExists = true;
    const deleteObject = vi.fn<DeleteImplementation>(async () => {
      if (!objectExists) return "not-found";
      objectExists = false;
      throw Object.assign(new Error("simulated lost adapter deletion response"), {
        code: "ECONNRESET",
      });
    });
    const adapter = storageAdapter("response-loss-storage", deleteObject, "persistent");
    const first = openFileCore(root, bytes, "first", () => now, [adapter]);
    const registered = await makeCollectible(
      first.media!,
      first.blocks,
      "registration-adapter-response-loss",
      async (media) => {
        await first.media!.storeOriginal(media.mediaId, adapter.descriptor.adapterId);
      },
    );

    await expect(first.media!.collectUnreachable()).rejects.toThrow(
      "simulated lost adapter deletion response",
    );
    expect(first.media!.listStorageRecords(registered.mediaId)).toEqual([
      expect.objectContaining({
        state: "delete-failed",
        deleteRetryable: true,
        nextDeleteAttemptAt: RETRY_DUE,
        lastDeleteErrorCode: "TRANSIENT_NETWORK",
      }),
    ]);

    const reopened = openFileCore(root, bytes, "reopened", () => now, [adapter]);
    await expect(reopened.media!.recoverDeletions()).resolves.toEqual({
      deleted: [],
      failed: [registered.mediaId],
    });
    expect(deleteObject).toHaveBeenCalledTimes(1);

    now = RETRY_DUE;
    await expect(reopened.media!.recoverDeletions()).resolves.toEqual({
      deleted: [registered.mediaId],
      failed: [],
    });
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(deleteObject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        locator: `objects/${adapter.descriptor.adapterId}/${registered.mediaId}.png`,
        timeoutMs: 30_000,
        signal: expect.any(AbortSignal),
        expectedEntityTag: `etag-${adapter.descriptor.adapterId}`,
      }),
    );
    expect(deleteObject.mock.lastCall?.[0]).not.toHaveProperty("objectVersion");
    expect(reopened.media!.getMedia(registered.mediaId)).toBeNull();
  });

  it("retains AccessDenied and deletes only after an explicit retry", async () => {
    let permissionGranted = false;
    const deleteObject = vi.fn<DeleteImplementation>(async () => {
      if (permissionGranted) return "deleted";
      throw Object.assign(new Error("AccessDenied"), {
        code: "AccessDenied",
        status: 403,
      });
    });
    const adapter = storageAdapter("permission-storage", deleteObject);
    const { media, blocks } = volatileHarness("permission", () => START, [adapter]);
    const registered = await makeCollectible(
      media,
      blocks,
      "registration-access-denied",
      async (value) => {
        await media.storeOriginal(value.mediaId, adapter.descriptor.adapterId);
      },
    );

    await expect(media.collectUnreachable()).rejects.toThrow("AccessDenied");
    expect(media.listStorageRecords(registered.mediaId)).toEqual([
      expect.objectContaining({
        state: "delete-failed",
        deleteAttempts: 1,
        deleteRetryable: false,
        lastDeleteErrorCode: "ACCESS_DENIED",
      }),
    ]);
    await expect(media.recoverDeletions()).resolves.toEqual({
      deleted: [],
      failed: [registered.mediaId],
    });
    expect(deleteObject).toHaveBeenCalledOnce();

    permissionGranted = true;
    await expect(media.retryDeletion("registration-access-denied")).resolves.toBe(
      "deleted",
    );
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(media.listStorageRecords(registered.mediaId)).toEqual([]);
    expect(media.getMedia(registered.mediaId)).toBeNull();
  });

  it("recovers from the last deleting snapshot when the final state write fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-media-delete-final-state-"));
    roots.push(root);
    const bytes = new FileMediaByteStore({
      directory: join(root, "bytes"),
      maxMediaBytes: 1024,
    });
    const referenceGraph = new ReferenceGraph();
    let blockId = 0;
    let failDeletedSnapshot = false;
    let durableMedia!: MediaStoreSnapshot;
    let durableGraph!: ReferenceGraphSnapshot;
    let media!: MediaStore;
    media = new MediaStore({
      durability: "persistent",
      referenceGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "deletion-final-state",
      now: () => START,
      onMutation: () => {
        const nextMedia = media.snapshot();
        if (
          failDeletedSnapshot &&
          nextMedia.registrations.some((record) => record.state === "deleted")
        ) {
          throw new Error("simulated final deletion state write failure");
        }
        durableMedia = nextMedia;
        durableGraph = referenceGraph.snapshot();
      },
    });
    const blocks = new BlockStore({
      referenceGraph,
      media,
      nextBlockId: () => `final-block-${++blockId}`,
      now: () => START,
    });
    const registered = await makeCollectible(
      media,
      blocks,
      "registration-final-state-failure",
    );

    failDeletedSnapshot = true;
    await expect(media.collectUnreachable()).rejects.toMatchObject({
      code: "MEDIA_PERSISTENCE_FAILED",
    });
    expect(durableMedia.registrations).toEqual([
      expect.objectContaining({ state: "deleting", holdsRegistrationReference: false }),
    ]);
    expect(durableMedia.media).toEqual([registered]);
    expect(durableGraph.nodes).toEqual([
      expect.objectContaining({ target: { kind: "media", id: registered.mediaId } }),
    ]);
    await expect(bytes.has(registered.mediaId)).resolves.toBe(false);

    const failedRecoveryGraph = new ReferenceGraph({ snapshot: durableGraph });
    const failedRecovery = new MediaStore({
      durability: "persistent",
      referenceGraph: failedRecoveryGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "deletion-final-state",
      now: () => START,
      snapshot: durableMedia,
      onMutation: () => {
        throw new Error("simulated recovery state write failure");
      },
    });
    await expect(failedRecovery.recoverDeletions()).rejects.toMatchObject({
      code: "MEDIA_PERSISTENCE_FAILED",
    });

    const restoredGraph = new ReferenceGraph({ snapshot: durableGraph });
    const restored = new MediaStore({
      durability: "persistent",
      referenceGraph: restoredGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "deletion-final-state",
      now: () => START,
      snapshot: durableMedia,
      onMutation: () => undefined,
    });
    await expect(restored.recoverDeletions()).resolves.toEqual({
      deleted: [registered.mediaId],
      failed: [],
    });
    expect(restored.getMedia(registered.mediaId)).toBeNull();
  });

  it("persists one successful storage deletion when another storage deletion fails", async () => {
    let now = START;
    let firstExists = true;
    const firstDelete = vi.fn<DeleteImplementation>(async () => {
      if (!firstExists) return "not-found";
      firstExists = false;
      return "deleted";
    });
    let secondAttempt = 0;
    const secondDelete = vi.fn<DeleteImplementation>(async () => {
      secondAttempt += 1;
      if (secondAttempt === 1) {
        throw Object.assign(new Error("temporary second storage failure"), {
          code: "ECONNRESET",
        });
      }
      return "deleted";
    });
    const firstAdapter = storageAdapter("first-storage", firstDelete);
    const secondAdapter = storageAdapter("second-storage", secondDelete);
    const { media, blocks } = volatileHarness(
      "multiple",
      () => now,
      [firstAdapter, secondAdapter],
    );
    const registered = await makeCollectible(
      media,
      blocks,
      "registration-multiple-storage",
      async (value) => {
        await media.storeOriginal(value.mediaId, firstAdapter.descriptor.adapterId);
        await media.storeOriginal(value.mediaId, secondAdapter.descriptor.adapterId);
      },
    );

    await expect(media.collectUnreachable()).rejects.toThrow(
      "temporary second storage failure",
    );
    expect(media.listStorageRecords(registered.mediaId)).toEqual([
      expect.objectContaining({
        adapterId: "second-storage",
        state: "delete-failed",
        deleteRetryable: true,
      }),
    ]);
    expect(firstDelete).toHaveBeenCalledOnce();
    expect(secondDelete).toHaveBeenCalledOnce();

    now = RETRY_DUE;
    await expect(media.recoverDeletions()).resolves.toEqual({
      deleted: [registered.mediaId],
      failed: [],
    });
    expect(firstDelete).toHaveBeenCalledOnce();
    expect(secondDelete).toHaveBeenCalledTimes(2);
    expect(media.getMedia(registered.mediaId)).toBeNull();
  });

  it("serializes an explicit retry with concurrent startup recovery", async () => {
    let invocation = 0;
    let activeDeletes = 0;
    let maximumActiveDeletes = 0;
    let finishRetry!: () => void;
    let markRetryStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    const retryCanFinish = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });
    const deleteObject = vi.fn<DeleteImplementation>(async () => {
      invocation += 1;
      activeDeletes += 1;
      maximumActiveDeletes = Math.max(maximumActiveDeletes, activeDeletes);
      try {
        if (invocation === 1) {
          throw Object.assign(new Error("temporary deletion failure"), {
            code: "ECONNRESET",
          });
        }
        markRetryStarted();
        await retryCanFinish;
        return "deleted";
      } finally {
        activeDeletes -= 1;
      }
    });
    const adapter = storageAdapter("serialized-storage", deleteObject);
    const { media, blocks } = volatileHarness("serialized", () => START, [adapter]);
    const registered = await makeCollectible(
      media,
      blocks,
      "registration-serialized-delete",
      async (value) => {
        await media.storeOriginal(value.mediaId, adapter.descriptor.adapterId);
      },
    );
    await expect(media.collectUnreachable()).rejects.toThrow(
      "temporary deletion failure",
    );

    const retry = media.retryDeletion("registration-serialized-delete");
    await retryStarted;
    const recovery = media.recoverDeletions();
    await Promise.resolve();
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(maximumActiveDeletes).toBe(1);

    finishRetry();
    await expect(retry).resolves.toBe("deleted");
    await expect(recovery).resolves.toEqual({
      deleted: [registered.mediaId],
      failed: [],
    });
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(maximumActiveDeletes).toBe(1);
  });
});
