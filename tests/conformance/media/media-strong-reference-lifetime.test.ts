import { describe, expect, it } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { DeliveryStore } from "../../../src/core/delivery-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  type MediaInspector,
} from "../../../src/core/media-store.js";

const NOW = "2026-07-24T00:00:00.000Z";

describe("MEDIA-001 strong-reference lifetime", () => {
  it("keeps Media reachable through Block and Delivery references, then collects it after release", async () => {
    let id = 0;
    const nextId = (kind: string) => `${kind}-${++id}`;
    const referenceGraph = new ReferenceGraph();
    const bytes = new InMemoryMediaByteStore();
    const inspector: MediaInspector = {
      inspect: async () => ({ mimeType: "image/png", width: 64, height: 32 }),
    };
    const media = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "strong-reference-lifetime",
      now: () => NOW,
    });
    const registeredMedia = await media.registerMedia(
      {
        registrationId: "registration-upload-1",
        bytes: Buffer.from("fake png bytes"),
        declaredMimeType: "image/png",
        provenance: { sourceClass: "streamed-upload" },
      },
    );

    const blocks = new BlockStore({
      referenceGraph,
      media,
      nextBlockId: () => nextId("block"),
      now: () => NOW,
    });
    const deliveries = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => nextId(kind),
      now: () => NOW,
    });
    deliveries.createPage("page");
    deliveries.registerConsumer("page", "consumer", "from-now");

    const block = blocks.commit(
      {
        payload: {
          schema: "dolly.content/1",
          value: {
            items: [
              { type: "media-reference", mediaId: registeredMedia.mediaId },
            ],
          },
        },
      },
      { kind: "external", id: "console" },
    );
    deliveries.append("page", block.id);

    expect(media.releaseRegistration("registration-upload-1")).toBe("released");
    expect(await media.collectUnreachable()).toEqual({ media: [] });
    expect(media.getMedia(registeredMedia.mediaId)).not.toBeNull();

    const claim = deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    expect(referenceGraph.leaseCountFor({ kind: "block", id: block.id })).toBe(1);
    expect(await media.collectUnreachable()).toEqual({ media: [] });

    deliveries.ack({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: "generation-1",
    });
    expect(referenceGraph.leaseCountFor({ kind: "block", id: block.id })).toBe(0);
    expect(deliveries.pruneTerminal("page")).toBe(1);
    expect(blocks.collectUnreachable().map((entry) => entry.id)).toEqual([block.id]);

    const collected = await media.collectUnreachable();
    expect(collected.media).toEqual([registeredMedia.mediaId]);
    expect(media.getMedia(registeredMedia.mediaId)).toBeNull();
    expect(await bytes.has(registeredMedia.mediaId)).toBe(false);
  });

  it("requires an unreachable Block to be removed before its Media", async () => {
    let id = 0;
    const referenceGraph = new ReferenceGraph();
    const bytes = new InMemoryMediaByteStore();
    const media = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes,
      inspector: {
        inspect: async () => ({ mimeType: "image/png", width: 2, height: 2 }),
      },
      maxMediaBytes: 1024,
      idNamespace: "block-removal",
      now: () => NOW,
    });
    const registeredMedia = await media.registerMedia(
      {
        registrationId: "registration-block-removal",
        bytes: Uint8Array.of(1),
        provenance: { sourceClass: "streamed-upload" },
      },
    );
    const blocks = new BlockStore({
      referenceGraph,
      media,
      nextBlockId: () => `block-${++id}`,
      now: () => NOW,
    });
    const block = blocks.commitOnce("commit-block-removal", {
      payload: {
        schema: "dolly.content/1",
        value: {
          items: [{ type: "media-reference", mediaId: registeredMedia.mediaId }],
        },
      },
    }, { kind: "module", id: "module-1" });
    expect(media.releaseRegistration("registration-block-removal")).toBe("released");
    expect(blocks.releaseCommitEffect("commit-block-removal")).toBe("released");

    await expect(media.collectUnreachable()).rejects.toMatchObject({
      code: "REFERENCE_GRAPH_NODE_REFERENCED",
    });
    expect(media.getMedia(registeredMedia.mediaId)).toEqual(registeredMedia);
    await expect(bytes.has(registeredMedia.mediaId)).resolves.toBe(true);

    expect(blocks.collectUnreachable()).toEqual([block]);
    await expect(media.collectUnreachable()).resolves.toEqual({
      media: [registeredMedia.mediaId],
    });
  });
});
