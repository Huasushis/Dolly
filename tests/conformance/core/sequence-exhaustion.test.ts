import { describe, expect, it } from "vitest";
import {
  BlockStore,
  BlockStoreError,
  type BlockProposal,
  type BlockStoreSnapshot,
} from "../../../src/core/block-store.js";
import {
  DeliveryStore,
  DeliveryStoreError,
  type DeliveryRecord,
  type DeliveryStoreSnapshot,
} from "../../../src/core/delivery-store.js";
import {
  ReferenceGraph,
  type ReferenceGraphSnapshot,
} from "../../../src/core/reference-graph.js";

const NOW = "2026-07-24T00:00:00.000Z";
const MAX_SAFE = 9007199254740991;
const MAX_SAFE_TEXT = MAX_SAFE.toString(10);
const source = { kind: "module", id: "producer" } as const;

function proposal(): BlockProposal {
  return {
    payload: { schema: "test.content/1", value: { text: "payload" } },
  };
}

function emptyBlockSnapshot(nextSequence: string): BlockStoreSnapshot {
  return {
    schemaVersion: "dolly.block-store/5",
    nextSequence,
    records: [],
    commitEffects: [],
    retirementTickets: [],
  };
}

function emptyDeliverySnapshot(
  nextGlobalSequence: string,
  pageNextSequence: string,
): DeliveryStoreSnapshot {
  return {
    schemaVersion: "dolly.delivery-store/6",
    maxFailedAttempts: 3,
    nextGlobalSequence,
    usedIds: [],
    pages: [{ id: "page-1", nextSequence: pageNextSequence, deliveryIds: [], subscriptions: [] }],
    deliveries: [],
    moduleJobs: [],
    claims: [],
    appendEffects: [],
    deadLetters: [],
  };
}

interface State {
  readonly reference: ReferenceGraphSnapshot;
  readonly blocks: BlockStoreSnapshot;
  readonly deliveries: DeliveryStoreSnapshot;
}

function stateOf(blocks: BlockStore, deliveries: DeliveryStore): State {
  return {
    reference: blocks.referenceGraph.snapshot(),
    blocks: blocks.snapshot(),
    deliveries: deliveries.snapshot(),
  };
}

function emptyStateFor(deliveries: DeliveryStoreSnapshot): State {
  return {
    reference: new ReferenceGraph().snapshot(),
    blocks: emptyBlockSnapshot("1"),
    deliveries,
  };
}

function restoreUniverse(
  state: State,
  nextId: (kind: string) => string,
): { referenceGraph: ReferenceGraph; blocks: BlockStore; deliveries: DeliveryStore } {
  const referenceGraph = new ReferenceGraph({
    snapshot: structuredClone(state.reference),
  });
  const blocks = new BlockStore({
    nextBlockId: () => "block-after-restart",
    now: () => NOW,
    referenceGraph,
    snapshot: structuredClone(state.blocks),
  });
  const deliveries = new DeliveryStore({
    blocks,
    maxFailedAttempts: 3,
    nextId,
    now: () => NOW,
    snapshot: structuredClone(state.deliveries),
  });
  return { referenceGraph, blocks, deliveries };
}

function restoreBlock(
  snapshot: BlockStoreSnapshot,
  nextBlockId: () => string = () => "block-live",
  graphSnapshot?: ReferenceGraphSnapshot,
): BlockStore {
  const referenceGraph = new ReferenceGraph(
    graphSnapshot === undefined
      ? {}
      : { snapshot: structuredClone(graphSnapshot) },
  );
  return new BlockStore({
    nextBlockId,
    now: () => NOW,
    referenceGraph,
    snapshot: structuredClone(snapshot),
  });
}

describe("CORE Block sequence high-water exhaustion guard", () => {
  it("rejects the next commit at the restored maximum safe sequence without mutation", () => {
    let allocations = 0;
    const store = restoreBlock(emptyBlockSnapshot(MAX_SAFE_TEXT), () => {
      allocations += 1;
      return "block-live";
    });

    expect(() => store.commit(proposal(), source)).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_SEQUENCE_EXHAUSTED" }),
    );
    expect(() => store.commitOnce("effect-new", proposal(), source)).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_SEQUENCE_EXHAUSTED" }),
    );
    expect(allocations).toBe(0);
    expect(store.size).toBe(0);
    expect(store.snapshot().nextSequence).toBe(MAX_SAFE_TEXT);
  });

  it("rejects a restored next sequence above the safe maximum", () => {
    expect(() => restoreBlock(emptyBlockSnapshot((MAX_SAFE + 1).toString(10)))).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_SNAPSHOT_INVALID" }),
    );
  });

  it("commits while below the safe maximum and rejects exactly at it", () => {
    const store = restoreBlock(emptyBlockSnapshot((MAX_SAFE - 1).toString(10)));
    const record = store.commit(proposal(), source);
    expect(record.sequence).toBe((MAX_SAFE - 1).toString(10));
    expect(store.snapshot().nextSequence).toBe(MAX_SAFE_TEXT);
    expect(() => store.commit(proposal(), source)).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_SEQUENCE_EXHAUSTED" }),
    );
    expect(store.snapshot().nextSequence).toBe(MAX_SAFE_TEXT);

    const repaired = restoreBlock(store.snapshot(), () => "block-live", store.referenceGraph.snapshot());
    expect(repaired.snapshot()).toEqual(store.snapshot());
    expect(() => repaired.commit(proposal(), source)).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_SEQUENCE_EXHAUSTED" }),
    );
  });

  it("rejects at the boundary before allocating an ID, even when the allocator fails", () => {
    const store = restoreBlock(emptyBlockSnapshot(MAX_SAFE_TEXT), () => {
      throw new Error("allocator failed");
    });
    expect(() => store.commit(proposal(), source)).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_SEQUENCE_EXHAUSTED" }),
    );
  });

  it("rejects the next commit with a live record at the boundary and roundtrips", () => {
    const { block, snapshot } = boundaryBlockStore();
    expect(block.snapshot()).toEqual(snapshot);
    expect(() => block.commit(proposal(), source)).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_SEQUENCE_EXHAUSTED" }),
    );
    expect(block.snapshot()).toEqual(snapshot);
  });
});

/** A committed Block on a Block store whose nextSequence already rests at the maximum. */
function boundaryBlockStore(): { block: BlockStore; snapshot: BlockStoreSnapshot } {
  const live = new BlockStore({ nextBlockId: () => "block-1", now: () => NOW });
  live.commit(proposal(), source);
  const snapshot: BlockStoreSnapshot = {
    ...live.snapshot(),
    nextSequence: MAX_SAFE_TEXT,
  };
  const graph = new ReferenceGraph({
    snapshot: structuredClone(live.referenceGraph.snapshot()),
  });
  const block = new BlockStore({
    nextBlockId: () => "block-1",
    now: () => NOW,
    referenceGraph: graph,
    snapshot: structuredClone(snapshot),
  });
  return { block, snapshot };
}

describe("CORE Delivery sequence high-water exhaustion guard", () => {
  it("rejects append at the restored boundary before allocation or mutation", () => {
    let allocations = 0;
    const { deliveries } = restoreUniverse(
      emptyStateFor(emptyDeliverySnapshot(MAX_SAFE_TEXT, MAX_SAFE_TEXT)),
      (kind) => {
        allocations += 1;
        return `${kind}-fresh-${allocations}`;
      },
    );
    const baseline = deliveries.snapshot();

    expect(() => deliveries.append("page-1", "block-1")).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({ code: "DELIVERY_SEQUENCE_EXHAUSTED" }),
    );
    // No ID is allocated, no Block is required, no counter moves, and the
    // snapshot deep-equals the restored baseline: the guard is atomic.
    expect(allocations).toBe(0);
    expect(deliveries.snapshot()).toEqual(baseline);
    expect(deliveries.snapshot().nextGlobalSequence).toBe(MAX_SAFE_TEXT);
    expect(deliveries.snapshot().pages[0]!.nextSequence).toBe(MAX_SAFE_TEXT);
  });

  it("rejects appendOnce with a new effect at the restored boundary", () => {
    const { deliveries } = restoreUniverse(
      emptyStateFor(emptyDeliverySnapshot(MAX_SAFE_TEXT, MAX_SAFE_TEXT)),
      (kind) => `${kind}-fresh`,
    );
    expect(() => deliveries.appendOnce("effect-new", "page-1", "block-1")).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({ code: "DELIVERY_SEQUENCE_EXHAUSTED" }),
    );
    expect(deliveries.snapshot().appendEffects).toEqual([]);
  });

  it("rejects restored nextGlobalSequence and page nextSequence above the safe maximum", () => {
    expect(() =>
      restoreUniverse(emptyStateFor(emptyDeliverySnapshot((MAX_SAFE + 1).toString(10), "1")), (k) => k),
    ).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({ code: "DELIVERY_SNAPSHOT_INVALID" }),
    );
    expect(() =>
      restoreUniverse(emptyStateFor(emptyDeliverySnapshot("1", (MAX_SAFE + 1).toString(10))), (k) => k),
    ).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({ code: "DELIVERY_SNAPSHOT_INVALID" }),
    );
  });

  it("appends at MAX_SAFE-1, then rejects at MAX_SAFE with appendOnce idempotent at the boundary", () => {
    const near = (MAX_SAFE - 1).toString(10);
    const universe = restoreUniverse(emptyStateFor(emptyDeliverySnapshot(near, near)), (kind) => kind);
    universe.blocks.commit(proposal(), source);
    const record: DeliveryRecord = universe.deliveries.appendOnce(
      "effect-1",
      "page-1",
      "block-after-restart",
    );
    expect(record.pageSequence).toBe(near);
    expect(record.globalSequence).toBe(near);
    expect(universe.deliveries.snapshot().nextGlobalSequence).toBe(MAX_SAFE_TEXT);
    expect(universe.deliveries.snapshot().pages[0]!.nextSequence).toBe(MAX_SAFE_TEXT);

    // At the boundary the same effect remains an idempotent read: no counter
    // advances and no allocation occurs.
    expect(
      universe.deliveries.appendOnce("effect-1", "page-1", "block-after-restart"),
    ).toEqual(record);

    // A fresh append or appendOnce is refused and nothing changes.
    const boundarySnapshot = universe.deliveries.snapshot();
    expect(() => universe.deliveries.append("page-1", "block-after-restart")).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({ code: "DELIVERY_SEQUENCE_EXHAUSTED" }),
    );
    expect(() =>
      universe.deliveries.appendOnce("effect-2", "page-1", "block-after-restart"),
    ).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({ code: "DELIVERY_SEQUENCE_EXHAUSTED" }),
    );
    expect(universe.deliveries.snapshot()).toEqual(boundarySnapshot);

    // The full boundary state roundtrips through restore.
    const roundtrip = restoreUniverse(stateOf(universe.blocks, universe.deliveries), (kind) => kind);
    expect(roundtrip.deliveries.snapshot()).toEqual(boundarySnapshot);
    expect(roundtrip.deliveries.appendOnce("effect-1", "page-1", "block-after-restart")).toEqual(
      record,
    );
    expect(() => roundtrip.deliveries.append("page-1", "block-after-restart")).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({ code: "DELIVERY_SEQUENCE_EXHAUSTED" }),
    );
  });

  it("does not let a low page counter widen the frozen global counter at the boundary", () => {
    const near = (MAX_SAFE - 1).toString(10);
    const universe = restoreUniverse(emptyStateFor(emptyDeliverySnapshot(near, near)), (kind) => kind);
    universe.blocks.commit(proposal(), source);
    universe.deliveries.appendOnce("effect-1", "page-1", "block-after-restart");
    const boundaryState = stateOf(universe.blocks, universe.deliveries);
    const withAnotherPage: DeliveryStoreSnapshot = {
      ...boundaryState.deliveries,
      pages: [
        ...boundaryState.deliveries.pages,
        { id: "page-2", nextSequence: "1", deliveryIds: [], subscriptions: [] },
      ],
    };
    const second = restoreUniverse(
      { ...boundaryState, deliveries: withAnotherPage },
      (kind) => `${kind}-fresh`,
    );
    expect(() => second.deliveries.append("page-2", "block-after-restart")).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({ code: "DELIVERY_SEQUENCE_EXHAUSTED" }),
    );
    expect(second.deliveries.snapshot().pages).toEqual(withAnotherPage.pages);
  });
});
