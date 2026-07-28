import { describe, expect, it } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  type MediaByteStore,
  type MediaInspector,
} from "../../../src/core/media-store.js";

const NOW = "2026-07-24T00:00:00.000Z";

function createStore(
  bytes: MediaByteStore = new InMemoryMediaByteStore(),
  referenceGraph: ReferenceGraph = new ReferenceGraph(),
): MediaStore {
  const inspector: MediaInspector = {
    inspect: async () => ({ mimeType: "image/png", width: 1, height: 1 }),
  };
  return new MediaStore({
    durability: "volatile",
    referenceGraph,
    bytes,
    inspector,
    maxMediaBytes: 1_024,
    idNamespace: "inline-grant",
    now: () => NOW,
  });
}

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

describe("inline media grants", () => {
  it("returns immutable base64 data rather than mutable typed-array state", async () => {
    const media = createStore();
    const source = Uint8Array.of(1, 2, 3);
    const registeredMedia = await media.registerMedia(
      {
        registrationId: "registration-inline-grant",
        bytes: source,
        declaredMimeType: "image/png",
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    source.fill(9);

    const grant = await media.resolveProviderAccess({
      mediaId: registeredMedia.mediaId,
      requestId: "provider-request",
      recipientId: "provider-recipient",
      acceptedAccessModes: ["inline"],
    });

    expect(grant).toEqual({
      schemaVersion: "dolly.media-access-grant/5",
      accessMode: "inline",
      mediaId: registeredMedia.mediaId,
      recipientId: "provider-recipient",
      inline: {
        encoding: "base64",
        data: "AQID",
        byteLength: 3,
        mimeType: "image/png",
      },
    });
    expect(Object.isFrozen(grant)).toBe(true);
    expect(grant.accessMode).toBe("inline");
    if (grant.accessMode !== "inline") throw new Error("Expected inline grant");
    expect(Object.isFrozen(grant.inline)).toBe(true);
    expect("leaseId" in grant).toBe(false);
    expect("expiresAt" in grant).toBe(false);
    expect(media.listProviderAccessRecords()).toEqual([]);
    expect(
      media.referenceGraph.leaseCountFor({ kind: "media", id: registeredMedia.mediaId }),
    ).toBe(0);
  });

  it("rejects duplicate or unknown modes and does not retain a failed grant", async () => {
    const media = createStore();
    const registeredMedia = await media.registerMedia(
      {
        registrationId: "registration-invalid-modes",
        bytes: Uint8Array.of(1),
        provenance: { sourceClass: "extension-bytes" },
      },
    );

    await expect(
      media.resolveProviderAccess({
        mediaId: registeredMedia.mediaId,
        requestId: "duplicate-mode-request",
        recipientId: "provider-recipient",
        acceptedAccessModes: ["inline", "inline"],
      }),
    ).rejects.toMatchObject({ code: "MEDIA_ACCESS_UNSUPPORTED" });
    await expect(
      media.resolveProviderAccess({
        mediaId: registeredMedia.mediaId,
        crop: {
          topLeft: { x: 0.1, y: 0.1 },
          bottomRight: { x: 0.9, y: 0.9 },
        },
        requestId: "inline-crop-request",
        recipientId: "provider-recipient",
        acceptedAccessModes: ["inline"],
      }),
    ).rejects.toMatchObject({ code: "MEDIA_ACCESS_UNSUPPORTED" });
    await expect(
      media.resolveProviderAccess({
        mediaId: registeredMedia.mediaId,
        crop: {
          topLeft: { x: 0.1, y: 0.1 },
          bottomRight: { x: 0.9, y: 0.9 },
          extra: true,
        } as never,
        requestId: "invalid-crop-request",
        recipientId: "provider-recipient",
        acceptedAccessModes: ["private-signed"],
        signedUrlExpiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_CROP_INVALID" });
    await expect(
      media.resolveProviderAccess({
        mediaId: registeredMedia.mediaId,
        requestId: "unknown-mode-request",
        recipientId: "provider-recipient",
        acceptedAccessModes: ["arbitrary"] as unknown as ["inline"],
      }),
    ).rejects.toMatchObject({ code: "MEDIA_ACCESS_UNSUPPORTED" });
    expect(
      media.referenceGraph.leaseCountFor({ kind: "media", id: registeredMedia.mediaId }),
    ).toBe(0);
  });

  it("rejects a signed URL expiry for an inline-only request", async () => {
    const media = createStore();
    const registeredMedia = await media.registerMedia({
      registrationId: "registration-inline-expiry",
      bytes: Uint8Array.of(1),
      provenance: { sourceClass: "extension-bytes" },
    });

    await expect(media.resolveProviderAccess({
      mediaId: registeredMedia.mediaId,
      requestId: "inline-expiry-request",
      recipientId: "provider-recipient",
      acceptedAccessModes: ["inline"],
      signedUrlExpiresInSeconds: 60,
    })).rejects.toMatchObject({ code: "MEDIA_ACCESS_UNSUPPORTED" });
  });

  it("rejects same-length byte corruption before returning inline data", async () => {
    const bytes = new InMemoryMediaByteStore();
    const media = createStore(bytes);
    const registeredMedia = await media.registerMedia({
      registrationId: "registration-inline-corruption",
      bytes: Uint8Array.of(1, 2, 3),
      declaredMimeType: "image/png",
      provenance: { sourceClass: "streamed-upload" },
    });
    await bytes.delete(registeredMedia.mediaId);
    await bytes.put(registeredMedia.mediaId, Uint8Array.of(3, 2, 1));

    await expect(media.resolveProviderAccess({
      mediaId: registeredMedia.mediaId,
      requestId: "inline-corruption-request",
      recipientId: "provider-recipient",
      acceptedAccessModes: ["inline"],
    })).rejects.toMatchObject({
      code: "MEDIA_BYTES_INVALID",
      details: { mediaId: registeredMedia.mediaId },
    });
    expect(media.listProviderAccessRecords()).toEqual([]);
  });

  it("keeps Media reachable only while copying inline bytes", async () => {
    const readStarted = createSignal();
    const readCanFinish = createSignal();
    const stored = new Map<string, Uint8Array>();
    const bytes: MediaByteStore = {
      durability: "volatile",
      put: async (mediaId, value) => {
        stored.set(mediaId, Uint8Array.from(value));
      },
      get: async (mediaId) => {
        readStarted.resolve();
        await readCanFinish.promise;
        const value = stored.get(mediaId);
        if (!value) throw new Error("Media bytes were deleted during the read");
        return Uint8Array.from(value);
      },
      delete: async (mediaId) => {
        stored.delete(mediaId);
      },
      has: async (mediaId) => stored.has(mediaId),
    };
    const referenceGraph = new ReferenceGraph();
    const media = createStore(bytes, referenceGraph);
    const blocks = new BlockStore({
      referenceGraph,
      media,
      nextBlockId: () => "block-inline-copy",
      now: () => NOW,
    });
    const registeredMedia = await media.registerMedia({
      registrationId: "registration-inline-copy",
      bytes: Uint8Array.of(1, 2, 3),
      declaredMimeType: "image/png",
      provenance: { sourceClass: "streamed-upload" },
    });
    blocks.commitOnce("commit-inline-copy", {
      payload: {
        schema: "dolly.content/1",
        value: { items: [{ type: "media-reference", mediaId: registeredMedia.mediaId }] },
      },
    }, { kind: "module", id: "module-inline-copy" });
    media.releaseRegistration("registration-inline-copy");
    blocks.releaseCommitEffect("commit-inline-copy");
    blocks.collectUnreachable();

    const access = media.resolveProviderAccess({
      mediaId: registeredMedia.mediaId,
      requestId: "inline-copy-request",
      recipientId: "provider-recipient",
      acceptedAccessModes: ["inline"],
    });
    await readStarted.promise;
    const collectionWhileReading = await media.collectUnreachable();
    readCanFinish.resolve();
    const accessResult = await access.then(
      (grant) => ({ grant }),
      (error: unknown) => ({ error }),
    );

    expect(collectionWhileReading).toEqual({ media: [] });
    expect(accessResult).toMatchObject({
      grant: { accessMode: "inline", schemaVersion: "dolly.media-access-grant/5" },
    });
    expect(media.listProviderAccessRecords()).toEqual([]);
    expect(
      referenceGraph.leaseCountFor({ kind: "media", id: registeredMedia.mediaId }),
    ).toBe(0);
    await expect(media.collectUnreachable()).resolves.toEqual({
      media: [registeredMedia.mediaId],
    });
  });
});
