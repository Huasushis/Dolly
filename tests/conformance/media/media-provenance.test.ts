import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  type Media,
  type MediaInspector,
  type MediaProvenance,
  type MediaStoreSnapshot,
} from "../../../src/core/media-store.js";

const NOW = "2026-07-24T00:00:00.000Z";
const inspector: MediaInspector = {
  inspect: async () => ({ mimeType: "image/png", width: 2, height: 2 }),
};

interface StoreFixture {
  readonly referenceGraph: ReferenceGraph;
  readonly bytes: InMemoryMediaByteStore;
  readonly store: MediaStore;
}

function openFixture(idNamespace: string): StoreFixture {
  const referenceGraph = new ReferenceGraph();
  const bytes = new InMemoryMediaByteStore();
  const store = new MediaStore({
    durability: "volatile",
    referenceGraph,
    bytes,
    inspector,
    maxMediaBytes: 1024,
    idNamespace,
    now: () => NOW,
  });
  return { referenceGraph, bytes, store };
}

// Restores a store from a snapshot. The reference graph and byte store must be
// the same instances (the graph rebuilt from its own snapshot) so the restored
// Media nodes and bytes remain reachable, matching the cross-restart contract.
function restoreFixture(
  idNamespace: string,
  fixture: StoreFixture,
  snapshot: MediaStoreSnapshot,
): MediaStore {
  return new MediaStore({
    durability: "volatile",
    referenceGraph: new ReferenceGraph({ snapshot: fixture.referenceGraph.snapshot() }),
    bytes: fixture.bytes,
    inspector,
    maxMediaBytes: 1024,
    idNamespace,
    now: () => NOW,
    snapshot,
  });
}

// Records bytes produced by a host Media derivation, distinct from the
// user-supplied ingress paths. The label is diagnostic only.
const DERIVED_INPUT = {
  registrationId: "registration-derived-1",
  bytes: Uint8Array.of(7),
  declaredMimeType: "image/png",
  provenance: {
    sourceClass: "derived" as const,
    sourceLabel: "derivation:audio-split",
  },
};

const LEGACY_SOURCE_CLASSES = [
  "streamed-upload",
  "extension-bytes",
  "local-file",
  "remote-fetch",
  "provider-output",
] as const;

describe("Media provenance sourceClass", () => {
  it("accepts derived provenance and roundtrips it exactly through a snapshot restore", async () => {
    const fixture = openFixture("derived-provenance");
    const media = await fixture.store.registerMedia(DERIVED_INPUT);
    expect(media.provenance).toEqual({
      sourceClass: "derived",
      sourceLabel: "derivation:audio-split",
    });

    const restored = restoreFixture("derived-provenance", fixture, fixture.store.snapshot());
    const revived = restored.getMedia(media.mediaId);
    expect(revived).toEqual(media);
    expect(restored.snapshot().media).toEqual([media]);
    expect(canonicalJsonDigest(revived)).toBe(canonicalJsonDigest(media));
  });

  it("preserves every legacy provenance class through registration and snapshot roundtrip", async () => {
    const fixture = openFixture("legacy-provenance");
    const media: Media[] = [];
    for (const [index, sourceClass] of LEGACY_SOURCE_CLASSES.entries()) {
      const provenance: MediaProvenance = { sourceClass };
      media.push(await fixture.store.registerMedia({
        registrationId: `registration-${sourceClass}`,
        bytes: Uint8Array.of(index + 1),
        provenance,
      }));
    }

    const restored = restoreFixture("legacy-provenance", fixture, fixture.store.snapshot());
    expect(restored.snapshot().media).toEqual(media);
    for (const item of restored.snapshot().media) {
      expect(LEGACY_SOURCE_CLASSES).toContain(item.provenance.sourceClass);
      expect(item.provenance.sourceClass).not.toBe("derived");
    }
  });

  it("rejects an unknown sourceClass at registration", async () => {
    const fixture = openFixture("unknown-provenance-registration");
    await expect(fixture.store.registerMedia({
      registrationId: "registration-unknown",
      bytes: Uint8Array.of(1),
      provenance: { sourceClass: "transcribed" },
    } as unknown as Parameters<MediaStore["registerMedia"]>[0])).rejects.toMatchObject({
      code: "MEDIA_INSPECTION_INVALID",
    });
  });

  it("rejects an unknown sourceClass at snapshot restore", async () => {
    const fixture = openFixture("derived-provenance-tamper");
    const media = await fixture.store.registerMedia(DERIVED_INPUT);
    const snapshot = structuredClone(fixture.store.snapshot()) as unknown as {
      media: Array<{ provenance: { sourceClass: string } }>;
    };
    expect(snapshot.media.length).toBe(1);
    snapshot.media[0].provenance.sourceClass = "transcribed";
    expect(() => restoreFixture("derived-provenance-tamper", fixture, snapshot as unknown as MediaStoreSnapshot))
      .toThrowError(expect.objectContaining({ code: "MEDIA_SNAPSHOT_INVALID" }));
    expect(media.provenance.sourceClass).toBe("derived");
  });
});
