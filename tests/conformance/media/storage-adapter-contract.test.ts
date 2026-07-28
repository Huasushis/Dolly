import { describe, expect, it, vi } from "vitest";
import {
  AliOssDirectObjectStore,
  type AliOssClientLike,
} from "../../../src/adapters/storage/ali-oss.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  MediaStoreError,
  type MediaByteStore,
  type PersistentStorageAdapter,
  type StorageAdapter,
} from "../../../src/core/media-store.js";

const inspector = {
  inspect: async () => ({ mimeType: "image/png", width: 1, height: 1 }),
};

function persistentBytes(): MediaByteStore {
  const bytes = new InMemoryMediaByteStore();
  return {
    durability: "persistent",
    put: (mediaId, value) => bytes.put(mediaId, value),
    get: (mediaId) => bytes.get(mediaId),
    delete: (mediaId) => bytes.delete(mediaId),
    has: (mediaId) => bytes.has(mediaId),
  };
}

function persistentStore(adapters: readonly StorageAdapter[]): MediaStore {
  return new MediaStore({
    durability: "persistent",
    referenceGraph: new ReferenceGraph(),
    bytes: persistentBytes(),
    inspector,
    adapters,
    maxMediaBytes: 1024,
    idNamespace: "storage-adapter-contract",
    now: () => "2026-07-26T00:00:00.000Z",
    onMutation: () => undefined,
  });
}

function completePersistentAdapter(): PersistentStorageAdapter {
  return {
    descriptor: {
      adapterId: "persistent-fixture",
      durability: "persistent",
      signedGet: false,
      publicUrl: false,
      supportsSignedCrop: false,
      storageNamespace: { provider: "fixture", container: "media" },
      objectVersioning: "enabled",
    },
    planOriginal: ({ storageRecordId }) => ({ locator: `objects/${storageRecordId}` }),
    putOriginalIfAbsent: async (input) => ({
      locator: input.locator,
      objectVersion: "fixture-version",
    }),
    headOriginal: async () => ({ status: "not-found" }),
    deleteObject: async () => "deleted",
  };
}

describe("Media storage adapter contract", () => {
  it("rejects persistent adapters that omit recovery or retain an unconditional write", () => {
    const incomplete = {
      descriptor: completePersistentAdapter().descriptor,
      planOriginal: completePersistentAdapter().planOriginal,
      putOriginalIfAbsent: completePersistentAdapter().putOriginalIfAbsent,
      headOriginal: completePersistentAdapter().headOriginal,
    } as unknown as StorageAdapter;
    expect(() => persistentStore([incomplete])).toThrowError(
      expect.objectContaining<Partial<MediaStoreError>>({
        code: "MEDIA_STORAGE_RECOVERY_UNAVAILABLE",
      }),
    );

    const unconditionalWrite = {
      ...completePersistentAdapter(),
      putOriginal: vi.fn(),
    } as unknown as StorageAdapter;
    expect(() => persistentStore([unconditionalWrite])).toThrowError(
      expect.objectContaining<Partial<MediaStoreError>>({
        code: "MEDIA_STORAGE_RECOVERY_UNAVAILABLE",
      }),
    );
  });

  it("rejects a volatile adapter that advertises persistent recovery operations", () => {
    const volatileWithRecovery = {
      descriptor: {
        adapterId: "volatile-fixture",
        durability: "volatile",
        signedGet: false,
        publicUrl: false,
        supportsSignedCrop: false,
      },
      putOriginal: async () => ({ locator: "objects/media" }),
      deleteObject: async () => "deleted",
      planOriginal: () => ({ locator: "objects/media" }),
    } as unknown as StorageAdapter;
    expect(() => new MediaStore({
      durability: "volatile",
      referenceGraph: new ReferenceGraph(),
      bytes: new InMemoryMediaByteStore(),
      inspector,
      adapters: [volatileWithRecovery],
      maxMediaBytes: 1024,
      idNamespace: "volatile-adapter-contract",
      now: () => "2026-07-26T00:00:00.000Z",
    })).toThrowError(
      expect.objectContaining<Partial<MediaStoreError>>({
        code: "MEDIA_STORAGE_INVALID",
      }),
    );
  });

  it("rejects the direct OSS helper before it can be mistaken for a MediaStore adapter", () => {
    const client: AliOssClientLike = {
      put: vi.fn(),
      delete: vi.fn(),
      signatureUrlV4: vi.fn(),
    };
    const directStore = new AliOssDirectObjectStore({
      client,
      keyPrefix: "dolly/media",
    });
    expect(() => new MediaStore({
      durability: "volatile",
      referenceGraph: new ReferenceGraph(),
      bytes: new InMemoryMediaByteStore(),
      inspector,
      adapters: [directStore as unknown as StorageAdapter],
      maxMediaBytes: 1024,
      idNamespace: "direct-oss-contract",
      now: () => "2026-07-26T00:00:00.000Z",
    })).toThrowError(
      expect.objectContaining<Partial<MediaStoreError>>({
        code: "MEDIA_STORAGE_INVALID",
      }),
    );
  });
});
