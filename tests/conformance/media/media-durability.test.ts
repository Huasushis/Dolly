import { describe, expect, it, vi } from "vitest";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  MediaStoreError,
  type MediaByteStore,
  type MediaDurability,
  type MediaInspector,
  type StorageAdapter,
} from "../../../src/core/media-store.js";

const NOW = "2026-07-24T00:00:00.000Z";

const inspector: MediaInspector = {
  inspect: async () => ({ mimeType: "image/png", width: 2, height: 2 }),
};

function createStore(
  durability: MediaDurability,
  adapters: readonly StorageAdapter[] = [],
  bytes: MediaByteStore = new InMemoryMediaByteStore(),
) {
  return new MediaStore({
    durability,
    referenceGraph: new ReferenceGraph(),
    bytes,
    inspector,
    adapters,
    maxMediaBytes: 1024,
    idNamespace: "media-durability",
    now: () => NOW,
    ...(durability === "persistent" ? { onMutation: () => undefined } : {}),
  });
}

describe("Media durability and persistent storage", () => {
  it("rejects persistent Media backed by volatile byte storage", () => {
    expect(() => createStore("persistent")).toThrowError(
      expect.objectContaining<Partial<MediaStoreError>>({
        code: "MEDIA_DURABILITY_UNAVAILABLE",
      }),
    );
  });

  it("requires matching durability and a complete recovery contract for persistent storage", () => {
    const persistentAdapter = {
      descriptor: {
        adapterId: "remote",
        durability: "persistent",
        signedGet: true,
        publicUrl: false,
        supportsSignedCrop: false,
        storageNamespace: {
          provider: "fixture",
          container: "media-durability",
        },
        objectVersioning: "disabled",
      },
      deleteObject: vi.fn().mockResolvedValue("deleted"),
      signGet: vi.fn().mockResolvedValue("https://private.example/object?signature=x"),
    } as unknown as StorageAdapter;

    expect(() => createStore("volatile", [persistentAdapter])).toThrowError(
      expect.objectContaining<Partial<MediaStoreError>>({
        code: "MEDIA_DURABILITY_UNAVAILABLE",
      }),
    );

    const storedBytes = new InMemoryMediaByteStore();
    const persistentBytes: MediaByteStore = {
      durability: "persistent",
      put: (mediaId, bytes) => storedBytes.put(mediaId, bytes),
      get: (mediaId) => storedBytes.get(mediaId),
      delete: (mediaId) => storedBytes.delete(mediaId),
      has: (mediaId) => storedBytes.has(mediaId),
    };
    expect(() => createStore("persistent", [persistentAdapter], persistentBytes)).toThrowError(
      expect.objectContaining<Partial<MediaStoreError>>({
        code: "MEDIA_STORAGE_RECOVERY_UNAVAILABLE",
      }),
    );
  });
});
