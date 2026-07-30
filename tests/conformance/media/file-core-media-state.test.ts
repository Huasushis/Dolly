import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCoreStateStore, CoreStateError } from "../../../src/core/file-core-state-store.js";
import { FileMediaByteStore } from "../../../src/core/file-media-byte-store.js";
import { type MediaInspector } from "../../../src/core/media-store.js";

const NOW = "2026-07-24T00:00:00.000Z";
const inspector: MediaInspector = {
  inspect: async () => ({ mimeType: "image/png", width: 100, height: 80 }),
};

function openStore(root: string, prefix: string, withMedia = true): FileCoreStateStore {
  let blockId = 0;
  let deliveryId = 0;
  return new FileCoreStateStore({
    path: join(root, "core.json"),
    maxFailedAttempts: 3,
    nextBlockId: () => `${prefix}-block-${++blockId}`,
    nextDeliveryId: (kind) => `${prefix}-${kind}-${++deliveryId}`,
    now: () => NOW,
    ...(withMedia
      ? {
          media: {
            durability: "persistent" as const,
            bytes: new FileMediaByteStore({
              directory: join(root, "bytes"),
              maxMediaBytes: 1024,
            }),
            inspector,
            maxMediaBytes: 1024,
            idNamespace: "file-core-media-state",
          },
        }
      : {}),
  });
}

describe("MEDIA atomic Core/Media state", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-core-media-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("restores Media before validating an attached Block in the same revision", async () => {
    const first = openStore(root, "first");
    expect(first.media!.referenceGraph).toBe(first.referenceGraph);
    expect(Object.getOwnPropertyDescriptor(first.media!, "referenceGraph")?.get)
      .toEqual(expect.any(Function));
    // @ts-expect-error FileCore does not expose persistence observer replacement.
    expect(() => first.media!.setMutationObserver(undefined)).toThrowError(TypeError);
    first.deliveries.createPage("page");
    first.deliveries.registerConsumer("page", "consumer", "from-now");
    const media = await first.media!.registerMedia(
      {
        registrationId: "registration-block-media",
        bytes: Uint8Array.of(1, 2, 3),
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    const block = first.blocks.commit(
      {
        payload: {
          schema: "dolly.content/1",
          value: {
            items: [{
              type: "media-reference",
              mediaId: media.mediaId,
              crop: {
                topLeft: { x: 0.1, y: 0.25 },
                bottomRight: { x: 0.4, y: 0.75 },
              },
            }],
          },
        },
      },
      { kind: "external", id: "console" },
    );
    first.deliveries.append("page", block.id);
    expect(first.media!.releaseRegistration("registration-block-media")).toBe("released");
    const revision = first.revision;

    const reopened = openStore(root, "second");
    expect(reopened.revision).toBe(revision);
    await expect(reopened.media!.verifyStoredBytes()).resolves.toBeUndefined();
    expect(reopened.media!.getMedia(media.mediaId)).toEqual(media);
    expect(reopened.blocks.get(block.id)).toEqual(block);
    expect(reopened.referenceGraph.isReachable({ kind: "media", id: media.mediaId })).toBe(true);
    expect(reopened.snapshot()).toEqual(first.snapshot());
  });

  it("fails configuration mismatch and reports missing bytes before startup", async () => {
    const first = openStore(root, "first");
    const media = await first.media!.registerMedia(
      {
        registrationId: "registration-missing-bytes",
        bytes: Uint8Array.of(1),
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    expect(() => openStore(root, "without-media", false)).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_DOCUMENT_INVALID",
      }),
    );

    await new FileMediaByteStore({
      directory: join(root, "bytes"),
      maxMediaBytes: 1024,
    }).delete(media.mediaId);
    const reopened = openStore(root, "second");
    await expect(reopened.media!.verifyStoredBytes()).rejects.toMatchObject({
      code: "MEDIA_BYTES_INVALID",
      details: { mediaId: media.mediaId },
    });
  });

  it("rejects the previous Core state document version", () => {
    openStore(root, "first");
    const statePath = join(root, "core.json");
    const document = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    document.schemaVersion = "dolly.core-state/13";
    writeFileSync(statePath, JSON.stringify(document), "utf8");

    expect(() => openStore(root, "second")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_DOCUMENT_INVALID",
      }),
    );
  });
});
