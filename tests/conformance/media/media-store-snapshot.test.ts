import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileMediaByteStore } from "../../../src/core/file-media-byte-store.js";
import {
  ReferenceGraph,
  ReferenceGraphError,
  type ReferenceGraphSnapshot,
} from "../../../src/core/reference-graph.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  MediaStoreError,
  type MediaInspector,
  type MediaStoreSnapshot,
  type PersistentStorageAdapter,
  type StorageAdapter,
} from "../../../src/core/media-store.js";

const NOW = "2026-07-24T00:00:00.000Z";
const inspector: MediaInspector = {
  inspect: async () => ({ mimeType: "image/png", width: 100, height: 80 }),
};

function createCropStorage(): PersistentStorageAdapter {
  const storedObjects = new Map<
    string,
    Extract<Awaited<ReturnType<PersistentStorageAdapter["headOriginal"]>>, {
      readonly status: "found";
    }>
  >();
  const storageNamespace = {
    provider: "fixture",
    container: "crop-storage",
  } as const;
  return {
    descriptor: {
      adapterId: "crop-storage",
      durability: "persistent",
      signedGet: true,
      publicUrl: false,
      supportsSignedCrop: true,
      storageNamespace,
      objectVersioning: "enabled",
    },
    planOriginal: ({ mediaId }) => ({ locator: `objects/${mediaId}.png` }),
    putOriginalIfAbsent: async (input) => {
      if (storedObjects.has(input.locator)) throw new Error("Object already exists");
      const stored = {
        status: "found" as const,
        storageRecordId: input.storageRecordId,
        digest: input.digest,
        byteLength: input.bytes.byteLength,
        mimeType: input.mimeType,
        storageNamespaceDigest: input.storageNamespaceDigest,
        objectVersion: "object-version-1",
        entityTag: "etag-1",
      };
      storedObjects.set(input.locator, stored);
      return {
        locator: input.locator,
        objectVersion: stored.objectVersion,
        entityTag: stored.entityTag,
      };
    },
    headOriginal: async ({ locator }) =>
      storedObjects.get(locator) ?? { status: "not-found" },
    deleteObject: async ({ locator }) =>
      storedObjects.delete(locator) ? "deleted" : "not-found",
    signGet: async ({ locator }) => `https://private.example/${locator}?signed=1`,
  };
}

describe("persistent Media metadata snapshot", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-media-snapshot-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects the previous MediaStore snapshot version", () => {
    const options = {
      durability: "volatile" as const,
      referenceGraph: new ReferenceGraph(),
      bytes: new InMemoryMediaByteStore(),
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "previous-store-version",
      now: () => NOW,
    };
    const current = new MediaStore(options).snapshot();
    const previousRecord = structuredClone(current) as unknown as Record<string, unknown>;
    previousRecord.schemaVersion = "dolly.media-store/8";
    const previous = previousRecord as unknown as MediaStoreSnapshot;

    expect(() => new MediaStore({ ...options, snapshot: previous })).toThrowError(
      expect.objectContaining<Partial<MediaStoreError>>({
        code: "MEDIA_SNAPSHOT_INVALID",
      }),
    );
  });

  it("rejects a changed ID namespace and invalid persisted sequences", () => {
    const options = {
      durability: "volatile" as const,
      referenceGraph: new ReferenceGraph(),
      bytes: new InMemoryMediaByteStore(),
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "snapshot-sequence",
      now: () => NOW,
    };
    const snapshot = new MediaStore(options).snapshot();

    expect(() => new MediaStore({
      ...options,
      idNamespace: "different-namespace",
      snapshot,
    })).toThrowError(expect.objectContaining<Partial<MediaStoreError>>({
      code: "MEDIA_SNAPSHOT_INVALID",
    }));

    const invalidSequences = [
      "00",
      "01",
      "+1",
      "-1",
      ((1n << 128n) + 1n).toString(10),
    ];
    for (const nextIdSequence of invalidSequences) {
      expect(() => new MediaStore({
        ...options,
        snapshot: { ...snapshot, nextIdSequence },
      })).toThrowError(expect.objectContaining<Partial<MediaStoreError>>({
        code: "MEDIA_SNAPSHOT_INVALID",
      }));
    }
  });

  it("continues the persisted sequence across restart without reusing an ID", async () => {
    const referenceGraph = new ReferenceGraph();
    const bytes = new InMemoryMediaByteStore();
    const first = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "restart-sequence",
      now: () => NOW,
    });
    const firstMedia = await first.registerMedia({
      registrationId: "registration-before-restart",
      bytes: Uint8Array.of(1),
      provenance: { sourceClass: "streamed-upload" },
    });

    const restored = new MediaStore({
      durability: "volatile",
      referenceGraph: new ReferenceGraph({ snapshot: referenceGraph.snapshot() }),
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "restart-sequence",
      now: () => NOW,
      snapshot: first.snapshot(),
    });
    const secondMedia = await restored.registerMedia({
      registrationId: "registration-after-restart",
      bytes: Uint8Array.of(2),
      provenance: { sourceClass: "streamed-upload" },
    });

    expect(firstMedia.mediaId).toBe("media:restart-sequence:0");
    expect(secondMedia.mediaId).toBe("media:restart-sequence:1");
    expect(secondMedia.mediaId).not.toBe(firstMedia.mediaId);
    expect(restored.snapshot().nextIdSequence).toBe("2");
  });

  it("rejects allocation after the 128-bit sequence is exhausted", async () => {
    const options = {
      durability: "volatile" as const,
      referenceGraph: new ReferenceGraph(),
      bytes: new InMemoryMediaByteStore(),
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "exhausted-sequence",
      now: () => NOW,
    };
    const snapshot: MediaStoreSnapshot = {
      ...new MediaStore(options).snapshot(),
      nextIdSequence: (1n << 128n).toString(10),
    };
    const exhausted = new MediaStore({ ...options, snapshot });

    await expect(exhausted.registerMedia({
      registrationId: "registration-exhausted-sequence",
      bytes: Uint8Array.of(1),
      provenance: { sourceClass: "streamed-upload" },
    })).rejects.toMatchObject({ code: "MEDIA_ID_EXHAUSTED" });
  });

  it("rejects the previous Media registration record version", async () => {
    const referenceGraph = new ReferenceGraph();
    const bytes = new InMemoryMediaByteStore();
    const options = {
      durability: "volatile" as const,
      referenceGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "previous-registration-version",
      now: () => NOW,
    };
    const media = new MediaStore(options);
    await media.registerMedia({
      registrationId: "registration-previous-version",
      bytes: Uint8Array.of(1),
      provenance: { sourceClass: "streamed-upload" },
    });
    const previous = {
      ...media.snapshot(),
      registrations: media.snapshot().registrations.map((record) => ({
        ...record,
        schemaVersion: "dolly.media-registration/3",
      })),
    } as unknown as MediaStoreSnapshot;

    expect(() => new MediaStore({
      ...options,
      referenceGraph: new ReferenceGraph({ snapshot: referenceGraph.snapshot() }),
      snapshot: previous,
    })).toThrowError(expect.objectContaining<Partial<MediaStoreError>>({
      code: "MEDIA_SNAPSHOT_INVALID",
    }));
  });

  it("rejects the previous ReferenceGraph snapshot version", () => {
    const previous = {
      ...new ReferenceGraph().snapshot(),
      schemaVersion: "dolly.reference-graph/3",
    } as unknown as ReferenceGraphSnapshot;

    expect(() => new ReferenceGraph({ snapshot: previous })).toThrowError(
      expect.objectContaining<Partial<ReferenceGraphError>>({
        code: "REFERENCE_GRAPH_INPUT_INVALID",
      }),
    );
  });

  it("restores generated Media IDs and adapter IDs that both contain colons", async () => {
    const adapter = (adapterId: string): StorageAdapter => ({
      descriptor: {
        adapterId,
        durability: "volatile",
        signedGet: false,
        publicUrl: false,
        supportsSignedCrop: false,
      },
      putOriginal: async ({ mediaId }) => ({ locator: `objects/${mediaId}` }),
      deleteObject: async () => "deleted",
    });
    const adapters = [adapter("primary:crop"), adapter("backup:crop")];
    const referenceGraph = new ReferenceGraph();
    const bytes = new InMemoryMediaByteStore();
    const media = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes,
      inspector,
      adapters,
      maxMediaBytes: 1024,
      idNamespace: "colon-pair",
      now: () => NOW,
    });
    const first = await media.registerMedia({
      registrationId: "registration-first-colon-pair",
      bytes: Uint8Array.of(1),
      provenance: { sourceClass: "streamed-upload" },
    });
    const second = await media.registerMedia({
      registrationId: "registration-second-colon-pair",
      bytes: Uint8Array.of(2),
      provenance: { sourceClass: "streamed-upload" },
    });
    expect(first.mediaId).toBe("media:colon-pair:0");
    expect(second.mediaId).toBe("media:colon-pair:1");
    await media.storeOriginal(first.mediaId, "primary:crop");
    await media.storeOriginal(second.mediaId, "backup:crop");

    const restored = new MediaStore({
      durability: "volatile",
      referenceGraph: new ReferenceGraph({ snapshot: referenceGraph.snapshot() }),
      bytes,
      inspector,
      adapters,
      maxMediaBytes: 1024,
      idNamespace: "colon-pair",
      now: () => NOW,
      snapshot: media.snapshot(),
    });
    await expect(restored.verifyStoredBytes()).resolves.toBeUndefined();
    expect(restored.listStorageRecords(first.mediaId)).toHaveLength(1);
    expect(restored.listStorageRecords(second.mediaId)).toHaveLength(1);
  });

  it("restores Media, strong references, bytes, storage records, crops, and provider leases", async () => {
    const referenceGraph = new ReferenceGraph();
    const bytes = new FileMediaByteStore({ directory: root, maxMediaBytes: 1024 });
    let writes = 0;
    const writtenSnapshots: MediaStoreSnapshot[] = [];
    let persisted!: MediaStoreSnapshot;
    let media!: MediaStore;
    media = new MediaStore({
      durability: "persistent",
      referenceGraph,
      bytes,
      inspector,
      adapters: [createCropStorage()],
      maxMediaBytes: 1024,
      idNamespace: "snapshot-restore",
      now: () => NOW,
      onMutation: () => {
        writes += 1;
        persisted = media.snapshot();
        writtenSnapshots.push(persisted);
      },
    });
    const registeredMedia = await media.registerMedia(
      {
        registrationId: "registration-restored-media",
        bytes: Uint8Array.of(1, 2, 3),
        declaredMimeType: "image/png",
        provenance: { sourceClass: "streamed-upload", sourceLabel: "console" },
      },
    );
    await media.storeOriginal(registeredMedia.mediaId, "crop-storage");
    const crop = {
      kind: "image_rect_v1",
      x0: 100_000,
      y0: 250_000,
      x1: 400_000,
      y1: 750_000,
    } as const;
    const grant = await media.resolveProviderAccess({
      mediaId: registeredMedia.mediaId,
      crop,
      requestId: "provider-request",
      recipientId: "provider-model",
      acceptedAccessModes: ["private-signed"],
      signedUrlExpiresInSeconds: 60,
    });
    expect(writes).toBe(7);
    expect(writtenSnapshots.slice(0, 2).map((snapshot) =>
      snapshot.registrations[0]?.state
    )).toEqual(["pending", "available"]);

    const restoredReferenceGraph = new ReferenceGraph({
      snapshot: structuredClone(referenceGraph.snapshot()),
    });
    const restoredBytes = new FileMediaByteStore({ directory: root, maxMediaBytes: 1024 });
    let restored!: MediaStore;
    restored = new MediaStore({
      durability: "persistent",
      referenceGraph: restoredReferenceGraph,
      bytes: restoredBytes,
      inspector,
      adapters: [createCropStorage()],
      maxMediaBytes: 1024,
      idNamespace: "snapshot-restore",
      now: () => NOW,
      snapshot: structuredClone(persisted),
      onMutation: () => {
        persisted = restored.snapshot();
      },
    });
    expect(restored.snapshot()).toEqual(media.snapshot());
    expect(grant.accessMode).toBe("private-signed");
    if (grant.accessMode !== "private-signed") {
      throw new Error("Expected a private signed Media access grant");
    }
    expect(restored.snapshot().storageRecords).toEqual([
      expect.objectContaining({
        schemaVersion: "dolly.media-storage-record/4",
        uploadAttempts: 1,
        deleteAttempts: 0,
        objectVersion: "object-version-1",
        entityTag: "etag-1",
      }),
    ]);
    expect(restored.getMedia(registeredMedia.mediaId)).toEqual(registeredMedia);
    expect([...(await restoredBytes.get(registeredMedia.mediaId))]).toEqual([1, 2, 3]);
    expect(restored.listProviderAccessRecords()).toEqual([
      expect.objectContaining({
        leaseId: grant.leaseId,
        crop,
        requestId: "provider-request",
        requestStatus: "awaiting-result",
      }),
    ]);
    expect(
      restoredReferenceGraph.leaseCountFor({ kind: "media", id: registeredMedia.mediaId }),
    ).toBe(1);
  });

  it("rejects an unsupported storage record snapshot version", async () => {
    const referenceGraph = new ReferenceGraph();
    const bytes = new FileMediaByteStore({ directory: root, maxMediaBytes: 1024 });
    let snapshot!: MediaStoreSnapshot;
    let media!: MediaStore;
    media = new MediaStore({
      durability: "persistent",
      referenceGraph,
      bytes,
      inspector,
      adapters: [createCropStorage()],
      maxMediaBytes: 1024,
      idNamespace: "storage-version",
      now: () => NOW,
      onMutation: () => {
        snapshot = media.snapshot();
      },
    });
    const registeredMedia = await media.registerMedia(
      {
        registrationId: "registration-storage-version",
        bytes: Uint8Array.of(1),
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    await media.storeOriginal(registeredMedia.mediaId, "crop-storage");
    const previous = {
      ...snapshot,
      storageRecords: snapshot.storageRecords.map((record) => ({
        ...record,
        schemaVersion: "dolly.media-storage-record/3",
      })),
    } as unknown as MediaStoreSnapshot;

    expect(() => new MediaStore({
      durability: "persistent",
      referenceGraph: new ReferenceGraph({ snapshot: referenceGraph.snapshot() }),
      bytes,
      inspector,
      adapters: [createCropStorage()],
      maxMediaBytes: 1024,
      idNamespace: "storage-version",
      now: () => NOW,
      snapshot: previous,
      onMutation: () => undefined,
    })).toThrowError(expect.objectContaining<Partial<MediaStoreError>>({
      code: "MEDIA_SNAPSHOT_INVALID",
    }));
  });

  it("releases an interrupted local storage lease and persists that recovery", async () => {
    const referenceGraph = new ReferenceGraph();
    const bytes = new FileMediaByteStore({ directory: root, maxMediaBytes: 1024 });
    let persisted!: MediaStoreSnapshot;
    let media!: MediaStore;
    media = new MediaStore({
      durability: "persistent",
      referenceGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "interrupted-storage",
      now: () => NOW,
      onMutation: () => {
        persisted = media.snapshot();
      },
    });
    const registeredMedia = await media.registerMedia(
      {
        registrationId: "registration-interrupted-storage",
        bytes: Uint8Array.of(1),
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    const interruptedLeaseId = "lease:interrupted-storage:1";
    referenceGraph.acquireLease({
      leaseId: interruptedLeaseId,
      ownerKind: "storage-operation",
      ownerId: interruptedLeaseId,
      targetKind: "media",
      targetId: registeredMedia.mediaId,
      kind: "storage-operation",
    });
    const interruptedSnapshot: MediaStoreSnapshot = {
      ...persisted,
      nextIdSequence: "2",
    };

    const restoredReferenceGraph = new ReferenceGraph({
      snapshot: referenceGraph.snapshot(),
    });
    let recoveryWrites = 0;
    let recoveredReferenceGraph = restoredReferenceGraph.snapshot();
    let restored!: MediaStore;
    restored = new MediaStore({
      durability: "persistent",
      referenceGraph: restoredReferenceGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "interrupted-storage",
      now: () => NOW,
      snapshot: interruptedSnapshot,
      onMutation: () => {
        recoveryWrites += 1;
        restored.snapshot();
        recoveredReferenceGraph = restoredReferenceGraph.snapshot();
      },
    });

    expect(restoredReferenceGraph.hasLease(interruptedLeaseId)).toBe(false);
    expect(recoveryWrites).toBe(0);
    expect(restored.getMedia(registeredMedia.mediaId)).toEqual(registeredMedia);
    expect(recoveryWrites).toBe(1);
    expect(recoveredReferenceGraph.leases).toEqual([]);
  });

  it("releases an interrupted Media read lease and persists that recovery", async () => {
    const referenceGraph = new ReferenceGraph();
    const bytes = new FileMediaByteStore({ directory: root, maxMediaBytes: 1024 });
    let persisted!: MediaStoreSnapshot;
    let media!: MediaStore;
    media = new MediaStore({
      durability: "persistent",
      referenceGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "interrupted-media-read",
      now: () => NOW,
      onMutation: () => {
        persisted = media.snapshot();
      },
    });
    const registeredMedia = await media.registerMedia({
      registrationId: "registration-interrupted-media-read",
      bytes: Uint8Array.of(1),
      provenance: { sourceClass: "streamed-upload" },
    });
    const interruptedLeaseId = "lease:interrupted-media-read:1";
    referenceGraph.acquireLease({
      leaseId: interruptedLeaseId,
      ownerKind: "media-read",
      ownerId: interruptedLeaseId,
      targetKind: "media",
      targetId: registeredMedia.mediaId,
      kind: "media-read",
    });
    const interruptedSnapshot: MediaStoreSnapshot = {
      ...persisted,
      nextIdSequence: "2",
    };

    const restoredReferenceGraph = new ReferenceGraph({
      snapshot: referenceGraph.snapshot(),
    });
    let recoveryWrites = 0;
    let recoveredReferenceGraph = restoredReferenceGraph.snapshot();
    let restored!: MediaStore;
    restored = new MediaStore({
      durability: "persistent",
      referenceGraph: restoredReferenceGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "interrupted-media-read",
      now: () => NOW,
      snapshot: interruptedSnapshot,
      onMutation: () => {
        recoveryWrites += 1;
        restored.snapshot();
        recoveredReferenceGraph = restoredReferenceGraph.snapshot();
      },
    });

    expect(restoredReferenceGraph.hasLease(interruptedLeaseId)).toBe(false);
    expect(recoveryWrites).toBe(0);
    expect(restored.getMedia(registeredMedia.mediaId)).toEqual(registeredMedia);
    expect(recoveryWrites).toBe(1);
    expect(recoveredReferenceGraph.leases).toEqual([]);
  });

  it("rejects malformed interrupted Media read leases", async () => {
    const referenceGraph = new ReferenceGraph();
    const bytes = new InMemoryMediaByteStore();
    const media = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "invalid-media-read",
      now: () => NOW,
    });
    const registeredMedia = await media.registerMedia({
      registrationId: "registration-invalid-media-read",
      bytes: Uint8Array.of(1),
      provenance: { sourceClass: "streamed-upload" },
    });
    const leaseId = "lease:invalid-media-read:1";
    referenceGraph.acquireLease({
      leaseId,
      ownerKind: "media-read",
      ownerId: leaseId,
      targetKind: "media",
      targetId: registeredMedia.mediaId,
      kind: "media-read",
    });
    const snapshot: MediaStoreSnapshot = {
      ...media.snapshot(),
      nextIdSequence: "2",
    };
    const graphSnapshot = referenceGraph.snapshot();
    const invalidLeases = [
      { ownerKind: "other-owner" },
      { ownerId: "other-owner" },
      { moduleGenerationId: "module-generation" },
      { expiresAt: NOW },
      { leaseId: "lease:invalid-media-read:99", ownerId: "lease:invalid-media-read:99" },
    ] as const;

    for (const invalidLease of invalidLeases) {
      const invalidGraphSnapshot: ReferenceGraphSnapshot = {
        ...graphSnapshot,
        leases: graphSnapshot.leases.map((lease) => ({ ...lease, ...invalidLease })),
      };
      expect(() => new MediaStore({
        durability: "volatile",
        referenceGraph: new ReferenceGraph({ snapshot: invalidGraphSnapshot }),
        bytes,
        inspector,
        maxMediaBytes: 1024,
        idNamespace: "invalid-media-read",
        now: () => NOW,
        snapshot,
      })).toThrowError(expect.objectContaining<Partial<MediaStoreError>>({
        code: "MEDIA_SNAPSHOT_INVALID",
      }));
    }
  });

  it("rejects a missing provider lease and an invalid persisted crop", async () => {
    const referenceGraph = new ReferenceGraph();
    const bytes = new FileMediaByteStore({ directory: root, maxMediaBytes: 1024 });
    let persisted!: MediaStoreSnapshot;
    let media!: MediaStore;
    media = new MediaStore({
      durability: "persistent",
      referenceGraph,
      bytes,
      inspector,
      adapters: [createCropStorage()],
      maxMediaBytes: 1024,
      idNamespace: "provider-snapshot",
      now: () => NOW,
      onMutation: () => {
        persisted = media.snapshot();
      },
    });
    const registeredMedia = await media.registerMedia(
      {
        registrationId: "registration-missing-provider-lease",
        bytes: Uint8Array.of(1),
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    await media.storeOriginal(registeredMedia.mediaId, "crop-storage");
    await media.resolveProviderAccess({
      mediaId: registeredMedia.mediaId,
      crop: {
        kind: "image_rect_v1",
        x0: 100_000,
        y0: 100_000,
        x1: 900_000,
        y1: 900_000,
      },
      requestId: "provider-request",
      recipientId: "provider",
      acceptedAccessModes: ["private-signed"],
      signedUrlExpiresInSeconds: 60,
    });

    expect(() => new MediaStore({
      durability: "persistent",
      referenceGraph: new ReferenceGraph({
        snapshot: { ...referenceGraph.snapshot(), leases: [] },
      }),
      bytes,
      inspector,
      adapters: [createCropStorage()],
      maxMediaBytes: 1024,
      idNamespace: "provider-snapshot",
      now: () => NOW,
      snapshot: persisted,
      onMutation: () => undefined,
    })).toThrowError(expect.objectContaining<Partial<MediaStoreError>>({
      code: "MEDIA_SNAPSHOT_INVALID",
    }));

    const forged: MediaStoreSnapshot = {
      ...persisted,
      providerAccess: persisted.providerAccess.map((record) => ({
        ...record,
        crop: {
          kind: "image_rect_v1",
          x0: 900_000,
          y0: 100_000,
          x1: 100_000,
          y1: 900_000,
        },
      })),
    };
    expect(() => new MediaStore({
      durability: "persistent",
      referenceGraph: new ReferenceGraph({ snapshot: referenceGraph.snapshot() }),
      bytes,
      inspector,
      adapters: [createCropStorage()],
      maxMediaBytes: 1024,
      idNamespace: "provider-snapshot",
      now: () => NOW,
      snapshot: forged,
      onMutation: () => undefined,
    })).toThrowError(expect.objectContaining<Partial<MediaStoreError>>({
      code: "MEDIA_SNAPSHOT_INVALID",
    }));

    // A persisted legacy float-scale crop (topLeft/bottomRight doubles) must
    // fail closed on restore, never be silently reinterpreted as a fixed-point
    // rectangle. The closed image_rect_v1 wire shape is the only accepted form.
    const legacyFloat: MediaStoreSnapshot = {
      ...persisted,
      providerAccess: persisted.providerAccess.map((record) => ({
        ...record,
        crop: {
          topLeft: { x: 0.1, y: 0.25 },
          bottomRight: { x: 0.4, y: 0.75 },
        },
      })),
    };
    expect(() => new MediaStore({
      durability: "persistent",
      referenceGraph: new ReferenceGraph({ snapshot: referenceGraph.snapshot() }),
      bytes,
      inspector,
      adapters: [createCropStorage()],
      maxMediaBytes: 1024,
      idNamespace: "provider-snapshot",
      now: () => NOW,
      snapshot: legacyFloat,
      onMutation: () => undefined,
    })).toThrowError(expect.objectContaining<Partial<MediaStoreError>>({
      code: "MEDIA_SNAPSHOT_INVALID",
    }));
  });

  it("keeps an uncertain mutation dirty and rejects unsupported durability", async () => {
    const bytes = new FileMediaByteStore({ directory: root, maxMediaBytes: 1024 });
    let fail = true;
    let writes = 0;
    let media!: MediaStore;
    media = new MediaStore({
      durability: "persistent",
      referenceGraph: new ReferenceGraph(),
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "uncertain-mutation",
      now: () => NOW,
      onMutation: () => {
        writes += 1;
        media.snapshot();
        if (fail) throw new Error("metadata disk unavailable");
      },
    });
    const registration = {
      registrationId: "registration-uncertain-mutation",
      bytes: Uint8Array.of(1),
      provenance: { sourceClass: "streamed-upload" } as const,
    };
    await expect(media.registerMedia(registration)).rejects.toMatchObject({
      code: "MEDIA_PERSISTENCE_FAILED",
    });
    fail = false;
    await expect(media.registerMedia(registration)).resolves.toMatchObject({
      mediaId: "media:uncertain-mutation:0",
    });
    expect(media.getMedia("media:uncertain-mutation:0")).not.toBeNull();
    expect(writes).toBeGreaterThanOrEqual(2);

    expect(() => new MediaStore({
      durability: "persistent",
      referenceGraph: new ReferenceGraph(),
      bytes: new InMemoryMediaByteStore(),
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "durability-check",
      now: () => NOW,
      onMutation: () => undefined,
    })).toThrowError(expect.objectContaining({ code: "MEDIA_DURABILITY_UNAVAILABLE" }));
    expect(() => new MediaStore({
      durability: "persistent",
      referenceGraph: new ReferenceGraph(),
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "durability-check",
      now: () => NOW,
    })).toThrowError(expect.objectContaining({ code: "MEDIA_DURABILITY_UNAVAILABLE" }));
  });
});
