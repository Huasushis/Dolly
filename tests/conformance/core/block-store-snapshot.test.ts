import { describe, expect, it } from "vitest";
import {
  BlockStore,
  BlockStoreError,
  type BlockProposal,
  type BlockStoreSnapshot,
} from "../../../src/core/block-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";

const FIXED_TIME = "2026-07-24T00:00:00.000Z";
const source = { kind: "module", id: "module-a" } as const;

function proposal(refId?: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: {
        items: [
          { type: "text", text: refId ?? "root", format: "plain" },
          ...(refId === undefined ? [] : [{ type: "block-reference", blockId: refId }]),
        ],
      },
    },
  };
}

function restore(snapshot: BlockStoreSnapshot, referenceGraph: ReferenceGraph): BlockStore {
  return new BlockStore({
    nextBlockId: () => "block-after-restart",
    now: () => FIXED_TIME,
    referenceGraph,
    snapshot: structuredClone(snapshot),
  });
}

describe("CORE BlockStore restart snapshot", () => {
  it("restores live records, sequence order, and commit strong references", () => {
    let sequence = 0;
    const original = new BlockStore({
      nextBlockId: () => `block-${++sequence}`,
      now: () => FIXED_TIME,
    });
    const first = original.commit(proposal(), source);
    const second = original.commitOnce("effect-1", proposal(first.id), source);
    const blockSnapshot = original.snapshot();
    const referenceGraphSnapshot = original.referenceGraph.snapshot();

    expect(Object.isFrozen(blockSnapshot)).toBe(true);
    const referenceGraph = new ReferenceGraph({
      snapshot: structuredClone(referenceGraphSnapshot),
    });
    const restored = restore(blockSnapshot, referenceGraph);

    expect(restored.snapshot()).toEqual(blockSnapshot);
    expect(restored.commitOnce("effect-1", proposal(first.id), source)).toEqual(second);
    expect(
      referenceGraph.strongReferenceCountFor({ kind: "block", id: second.id }),
    ).toBe(1);
    expect(restored.collectUnreachable()).toEqual([]);
    expect(restored.commit(proposal(second.id), source).sequence).toBe("3");
  });

  it("keeps a released and collected effect as an idempotency tombstone", () => {
    const original = new BlockStore({
      nextBlockId: () => "block-1",
      now: () => FIXED_TIME,
    });
    const committed = original.commitOnce("effect-1", proposal(), source);
    expect(original.releaseCommitEffect("effect-1")).toBe("released");
    expect(original.collectUnreachable()).toEqual([committed]);

    const restored = restore(
      original.snapshot(),
      new ReferenceGraph({ snapshot: structuredClone(original.referenceGraph.snapshot()) }),
    );
    expect(restored.size).toBe(0);
    expect(restored.commitOnce("effect-1", proposal(), source)).toEqual(committed);
    expect(() => restored.commitOnce("effect-1", {
      ...proposal(),
      payload: { schema: "test.content/1", value: { text: "different" } },
    }, source)).toThrowError(expect.objectContaining<Partial<BlockStoreError>>({
      code: "BLOCK_EFFECT_CONFLICT",
    }));
  });

  it("rejects corrupted effect digests and strong-reference mismatches", () => {
    const original = new BlockStore({
      nextBlockId: () => "block-1",
      now: () => FIXED_TIME,
    });
    original.commitOnce("effect-1", proposal(), source);
    const snapshot = structuredClone(original.snapshot());
    const corruptedDigestSnapshot: BlockStoreSnapshot = {
      ...snapshot,
      commitEffects: snapshot.commitEffects.map((effect, index) =>
        index === 0 ? { ...effect, digest: `sha256:${"0".repeat(64)}` } : effect,
      ),
    };
    expect(() => restore(corruptedDigestSnapshot, new ReferenceGraph())).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_SNAPSHOT_INVALID" }),
    );

    const referenceSnapshot = structuredClone(original.snapshot());
    const referenceMismatch: BlockStoreSnapshot = {
      ...referenceSnapshot,
      commitEffects: referenceSnapshot.commitEffects.map((effect, index) =>
        index === 0 ? { ...effect, strongReferenceHeld: false } : effect,
      ),
    };
    const referenceGraph = new ReferenceGraph({
      snapshot: structuredClone(original.referenceGraph.snapshot()),
    });
    expect(() => restore(referenceMismatch, referenceGraph)).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_SNAPSHOT_INVALID" }),
    );
  });

  it("rejects the previous BlockStore snapshot version", () => {
    const original = new BlockStore({
      nextBlockId: () => "block-1",
      now: () => FIXED_TIME,
    });
    const previous = {
      ...structuredClone(original.snapshot()),
      schemaVersion: "dolly.block-store/2",
    };

    // The runtime must reject persisted data from an older schema even though
    // the current TypeScript type intentionally excludes that schema version.
    expect(() =>
      restore(previous as unknown as BlockStoreSnapshot, new ReferenceGraph()),
    ).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_SNAPSHOT_INVALID" }),
    );
  });

  it("reports uncertain persistence and retries the same effect without duplication", () => {
    let fail = true;
    let writes = 0;
    let store!: BlockStore;
    store = new BlockStore({
      nextBlockId: () => "block-1",
      now: () => FIXED_TIME,
      onMutation: () => {
        writes += 1;
        store.snapshot();
        if (fail) throw new Error("disk unavailable");
      },
    });

    expect(() => store.commitOnce("effect-1", proposal(), source)).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_PERSISTENCE_FAILED" }),
    );
    expect(store.size).toBe(1);

    fail = false;
    const recovered = store.commitOnce("effect-1", proposal(), source);
    expect(recovered.id).toBe("block-1");
    expect(store.size).toBe(1);
    expect(writes).toBe(2);
    expect(() => store.flushPersistence()).not.toThrow();
    expect(writes).toBe(2);
  });
});
