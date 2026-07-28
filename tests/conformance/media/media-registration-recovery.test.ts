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
  type MediaByteStore,
  type MediaInspector,
  type MediaRegistrationRequest,
  type MediaStoreSnapshot,
} from "../../../src/core/media-store.js";
import {
  ReferenceGraph,
  type ReferenceGraphSnapshot,
} from "../../../src/core/reference-graph.js";

const NOW = "2026-07-25T00:00:00.000Z";
const INPUT: MediaRegistrationRequest = {
  registrationId: "registration-1",
  bytes: Uint8Array.of(1, 2, 3),
  declaredMimeType: "image/png",
  provenance: { sourceClass: "streamed-upload" },
};
const inspector: MediaInspector = {
  inspect: async () => ({ mimeType: "image/png", width: 2, height: 2 }),
};

class FailingPutByteStore implements MediaByteStore {
  readonly durability = "persistent" as const;
  #failed = false;

  constructor(
    private readonly inner: FileMediaByteStore,
    private readonly failAfterWrite: boolean,
  ) {}

  async put(mediaId: string, bytes: Uint8Array): Promise<void> {
    if (this.#failed) return this.inner.put(mediaId, bytes);
    this.#failed = true;
    if (this.failAfterWrite) await this.inner.put(mediaId, bytes);
    throw new Error("simulated process exit during byte write");
  }

  get(mediaId: string): Promise<Uint8Array> {
    return this.inner.get(mediaId);
  }

  delete(mediaId: string): Promise<void> {
    return this.inner.delete(mediaId);
  }

  has(mediaId: string): Promise<boolean> {
    return this.inner.has(mediaId);
  }
}

function openCore(
  root: string,
  bytes: MediaByteStore,
  prefix: string,
): FileCoreStateStore {
  let blockId = 0;
  let deliveryId = 0;
  return new FileCoreStateStore({
    path: join(root, "core.json"),
    maxFailedAttempts: 3,
    nextBlockId: () => `${prefix}-block-${++blockId}`,
    nextDeliveryId: (kind) => `${prefix}-${kind}-${++deliveryId}`,
    now: () => NOW,
    media: {
      durability: "persistent",
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "registration-recovery",
    },
  });
}

describe("Media registration recovery", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns one Media item for equal concurrent retries and rejects changed input", async () => {
    const inspect = vi.fn(inspector.inspect);
    const media = new MediaStore({
      durability: "volatile",
      referenceGraph: new ReferenceGraph(),
      bytes: new InMemoryMediaByteStore(),
      inspector: { inspect },
      maxMediaBytes: 1024,
      idNamespace: "concurrent-registration",
      now: () => NOW,
    });

    const [first, retry] = await Promise.all([
      media.registerMedia(INPUT),
      media.registerMedia(INPUT),
    ]);
    expect(retry).toEqual(first);
    expect(inspect).toHaveBeenCalledOnce();
    expect(media.snapshot().media).toEqual([first]);
    expect(media.listRegistrations()).toEqual([
      expect.objectContaining({
        registrationId: INPUT.registrationId,
        state: "available",
        holdsRegistrationReference: true,
        media: first,
      }),
    ]);

    await expect(media.registerMedia({
      ...INPUT,
      bytes: Uint8Array.of(9),
    })).rejects.toMatchObject({ code: "MEDIA_REGISTRATION_CONFLICT" });
    await expect(media.registerMedia({
      ...INPUT,
      owner: { ownerKind: "pin", ownerId: "forged" },
    } as unknown as MediaRegistrationRequest)).rejects.toMatchObject({
      code: "MEDIA_INSPECTION_INVALID",
    });
  });

  it("does not release initial ownership until a persistent Block path exists", async () => {
    let id = 0;
    const referenceGraph = new ReferenceGraph();
    const bytes = new InMemoryMediaByteStore();
    const media = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "registration-ownership",
      now: () => NOW,
    });
    const registered = await media.registerMedia(INPUT);
    referenceGraph.acquireLease({
      leaseId: "temporary-access",
      ownerKind: "storage-operation",
      ownerId: "temporary-access",
      targetKind: "media",
      targetId: registered.mediaId,
      kind: "storage-operation",
    });
    expect(() => media.releaseRegistration(INPUT.registrationId)).toThrowError(
      expect.objectContaining({ code: "MEDIA_REGISTRATION_RELEASE_UNSAFE" }),
    );
    referenceGraph.releaseLease("temporary-access");

    const blocks = new BlockStore({
      referenceGraph,
      media,
      nextBlockId: () => `block-${++id}`,
      now: () => NOW,
    });
    blocks.commitOnce("registration-handoff", {
      payload: {
        schema: "dolly.content/1",
        value: {
          items: [{ type: "media-reference", mediaId: registered.mediaId }],
        },
      },
    }, { kind: "external", id: "test" });

    expect(media.releaseRegistration(INPUT.registrationId)).toBe("released");
    expect(media.releaseRegistration(INPUT.registrationId)).toBe("already-released");
    expect(blocks.releaseCommitEffect("registration-handoff")).toBe("released");
    expect(blocks.collectUnreachable()).toHaveLength(1);
    await expect(media.collectUnreachable()).resolves.toEqual({
      media: [registered.mediaId],
    });
    expect(media.listRegistrations()).toEqual([
      expect.objectContaining({ state: "deleted", holdsRegistrationReference: false }),
    ]);
    await expect(media.registerMedia(INPUT)).rejects.toMatchObject({
      code: "MEDIA_REGISTRATION_DELETED",
    });
  });

  it.each([
    { failAfterWrite: false, expectedPending: true },
    { failAfterWrite: true, expectedPending: false },
  ])(
    "recovers a persisted pending record when failAfterWrite=$failAfterWrite",
    async ({ failAfterWrite, expectedPending }) => {
      const root = mkdtempSync(join(tmpdir(), "dolly-media-registration-"));
      roots.push(root);
      const fileBytes = new FileMediaByteStore({
        directory: join(root, "bytes"),
        maxMediaBytes: 1024,
      });
      const first = openCore(
        root,
        new FailingPutByteStore(fileBytes, failAfterWrite),
        "first",
      );
      await expect(first.media!.registerMedia(INPUT)).rejects.toThrow(
        "simulated process exit",
      );
      expect(first.media!.listRegistrations()).toEqual([
        expect.objectContaining({ state: "pending", holdsRegistrationReference: false }),
      ]);

      const reopened = openCore(root, fileBytes, "second");
      const pendingMediaId = reopened.media!.listRegistrations()[0]!.media.mediaId;
      const recovery = await reopened.media!.recoverRegistrations();
      expect(recovery.pending).toEqual(expectedPending ? [INPUT.registrationId] : []);
      expect(recovery.completed).toEqual(expectedPending ? [] : [INPUT.registrationId]);

      if (expectedPending) {
        await expect(reopened.media!.registerMedia({
          ...INPUT,
          bytes: Uint8Array.of(7),
        })).rejects.toMatchObject({ code: "MEDIA_REGISTRATION_CONFLICT" });
        const completed = await reopened.media!.registerMedia(INPUT);
        expect(completed.mediaId).toBe(pendingMediaId);
      }

      await expect(reopened.media!.verifyStoredBytes()).resolves.toBeUndefined();
      expect(reopened.media!.getMedia(pendingMediaId)).not.toBeNull();
      expect(reopened.media!.listRegistrations()).toEqual([
        expect.objectContaining({ state: "available", holdsRegistrationReference: true }),
      ]);
    },
  );

  it("finishes from the last durable pending snapshot after final state persistence fails", async () => {
    const bytes = new InMemoryMediaByteStore();
    const referenceGraph = new ReferenceGraph();
    let store!: MediaStore;
    let durableMedia: MediaStoreSnapshot | undefined;
    let durableGraph: ReferenceGraphSnapshot | undefined;
    let mutationCount = 0;
    store = new MediaStore({
      durability: "volatile",
      referenceGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "registration-final-state",
      now: () => NOW,
      onMutation: () => {
        mutationCount += 1;
        if (mutationCount === 2) throw new Error("simulated final state write failure");
        durableMedia = store.snapshot();
        durableGraph = referenceGraph.snapshot();
      },
    });

    await expect(store.registerMedia(INPUT)).rejects.toMatchObject({
      code: "MEDIA_PERSISTENCE_FAILED",
    });
    expect(durableMedia?.registrations).toEqual([
      expect.objectContaining({ state: "pending", holdsRegistrationReference: false }),
    ]);

    const restoredGraph = new ReferenceGraph({ snapshot: durableGraph! });
    const restored = new MediaStore({
      durability: "volatile",
      referenceGraph: restoredGraph,
      bytes,
      inspector,
      maxMediaBytes: 1024,
      idNamespace: "registration-final-state",
      now: () => NOW,
      snapshot: durableMedia!,
      onMutation: () => undefined,
    });
    await expect(restored.recoverRegistrations()).resolves.toEqual({
      completed: [INPUT.registrationId],
      pending: [],
    });
    expect(restored.getMedia("media:registration-final-state:0")).not.toBeNull();
  });
});
