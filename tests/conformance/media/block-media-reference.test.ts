import { describe, expect, it } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  type MediaInspector,
} from "../../../src/core/media-store.js";

const NOW = "2026-07-24T00:00:00.000Z";

describe("Block media references", () => {
  it("rejects non-image and zero-pixel crops without creating derived media", async () => {
    let id = 0;
    const referenceGraph = new ReferenceGraph();
    const inspector: MediaInspector = {
      inspect: async (_bytes, declaredMimeType) =>
        declaredMimeType === "audio/wav"
          ? { mimeType: "audio/wav", durationMs: 1_000, channels: 1 }
          : { mimeType: "image/png", width: 100, height: 100 },
    };
    const media = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes: new InMemoryMediaByteStore(),
      inspector,
      maxMediaBytes: 1_024,
      idNamespace: "block-media-reference",
      now: () => NOW,
    });
    const image = await media.registerMedia(
      {
        registrationId: "registration-image-upload",
        bytes: Uint8Array.of(1),
        declaredMimeType: "image/png",
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    const audio = await media.registerMedia(
      {
        registrationId: "registration-audio-upload",
        bytes: Uint8Array.of(2),
        declaredMimeType: "audio/wav",
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    const blocks = new BlockStore({
      referenceGraph,
      media,
      nextBlockId: () => `block-${++id}`,
      now: () => NOW,
    });
    const commitCrop = (mediaId: string, start: number, end: number) =>
      blocks.commit(
        {
          payload: {
            schema: "dolly.content/1",
            value: {
              items: [{
                type: "media-reference",
                mediaId,
                crop: {
                  topLeft: { x: start, y: start },
                  bottomRight: { x: end, y: end },
                },
              }],
            },
          },
        },
        { kind: "module", id: "module-a" },
      );

    expect(() => commitCrop(audio.mediaId, 0.1, 0.9)).toThrowError(
      expect.objectContaining({
        code: "BLOCK_MEDIA_REFERENCE_INVALID",
      }),
    );
    expect(() => commitCrop(image.mediaId, 0.006, 0.014)).toThrowError(
      expect.objectContaining({
        code: "BLOCK_MEDIA_REFERENCE_INVALID",
      }),
    );

    const valid = commitCrop(image.mediaId, 0.004, 0.006);
    expect(valid.payload.value).toMatchObject({
      items: [{ type: "media-reference", mediaId: image.mediaId }],
    });
    expect(media.snapshot().media).toHaveLength(2);
  });
});
