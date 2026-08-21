import { describe, expect, it, vi } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  type MediaInspector,
  type PixelCrop,
  type StorageAdapter,
} from "../../../src/core/media-store.js";

const NOW = "2026-07-24T00:00:00.000Z";

describe("private object-storage crop", () => {
  it("signs an exact crop of one original object and leases only the Media", async () => {
    const referenceGraph = new ReferenceGraph();
    const inspector: MediaInspector = {
      inspect: async () => ({ mimeType: "image/png", width: 100, height: 80 }),
    };
    const putOriginal = vi.fn(async ({ mediaId }: { mediaId: string }) => ({
      locator: `objects/${mediaId}.png`,
      objectVersion: "object-version-1",
      entityTag: "etag-1",
    }));
    const deleteObject = vi.fn(async () => "deleted" as const);
    const signGet = vi.fn(
      async ({ locator, crop }: { locator: string; crop?: PixelCrop }) =>
        `https://private.example/${locator}?x-oss-process=${encodeURIComponent(
          crop === undefined
            ? ""
            : `image/crop,x_${crop.left},y_${crop.top},w_${crop.width},h_${crop.height}`,
        )}&Signature=redacted`,
    );
    const adapter: StorageAdapter = {
      descriptor: {
        adapterId: "fake-oss",
        durability: "volatile",
        signedGet: true,
        publicUrl: false,
        supportsSignedCrop: true,
      },
      putOriginal,
      deleteObject,
      signGet,
    };
    const store = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes: new InMemoryMediaByteStore(),
      inspector,
      adapters: [adapter],
      maxMediaBytes: 1024,
      idNamespace: "private-oss-crop",
      now: () => NOW,
    });
    const media = await store.registerMedia(
      {
        registrationId: "registration-private-crop",
        bytes: Buffer.from("image"),
        declaredMimeType: "image/png",
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    await store.storeOriginal(media.mediaId, "fake-oss");

    const crop = {
      kind: "image_rect_v1",
      x0: 100_000,
      y0: 250_000,
      x1: 400_000,
      y1: 750_000,
    } as const;
    const grant = await store.resolveProviderAccess({
      mediaId: media.mediaId,
      crop,
      requestId: "provider-request-1",
      recipientId: "model-operation-1",
      acceptedAccessModes: ["private-signed"],
      signedUrlExpiresInSeconds: 60,
    });

    expect(putOriginal).toHaveBeenCalledTimes(1);
    expect(store.storageRecordCount(media.mediaId)).toBe(1);
    expect(store.listStorageRecords(media.mediaId)).toEqual([
      expect.objectContaining({
        mediaId: media.mediaId,
        adapterId: "fake-oss",
        visibility: "private",
        state: "available",
      }),
    ]);
    expect(grant).toMatchObject({
      schemaVersion: "dolly.media-access-grant/5",
      accessMode: "private-signed",
      mediaId: media.mediaId,
      crop,
    });
    expect(signGet).toHaveBeenCalledWith(
      expect.objectContaining({
        locator: `objects/${media.mediaId}.png`,
        objectVersion: "object-version-1",
        crop: { left: 10, top: 20, width: 30, height: 40 },
        expiresInSeconds: 60,
      }),
    );
    expect(referenceGraph.leaseCountFor({ kind: "media", id: media.mediaId })).toBe(1);
    expect(referenceGraph.snapshot().nodes).toHaveLength(1);
    expect(store.listProviderAccessRecords()).toEqual([
      expect.objectContaining({ mediaId: media.mediaId, crop }),
    ]);
    if (grant.accessMode !== "private-signed") {
      throw new Error(`expected a private-signed grant, received ${grant.accessMode}`);
    }
    expect(store.recordProviderAccessOutcome({
      leaseId: grant.leaseId,
      requestId: "provider-request-1",
      recipientId: "model-operation-1",
      outcome: "finished",
    })).toBe("released");

    const blocks = new BlockStore({
      referenceGraph,
      media: store,
      nextBlockId: () => "block-private-crop",
      now: () => NOW,
    });
    blocks.commitOnce("commit-private-crop", {
      payload: {
        schema: "dolly.content/1",
        value: { items: [{ type: "media-reference", mediaId: media.mediaId }] },
      },
    }, { kind: "module", id: "module-private-crop" });
    expect(store.releaseRegistration("registration-private-crop")).toBe("released");
    expect(blocks.releaseCommitEffect("commit-private-crop")).toBe("released");
    expect(blocks.collectUnreachable().map((block) => block.id)).toEqual([
      "block-private-crop",
    ]);
    expect(await store.collectUnreachable()).toEqual({ media: [media.mediaId] });
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith(
      `objects/${media.mediaId}.png`,
      "object-version-1",
    );
  });
});
