import { describe, expect, it } from "vitest";
import {
  BlockStore,
  type BlockProposal,
  type BlockStoreSnapshot,
} from "../../../src/core/block-store.js";
import {
  DeliveryClaimPersistenceUnconfirmedError,
  DeliveryStore,
  DeliveryStoreError,
  type DeliveryStoreSnapshot,
} from "../../../src/core/delivery-store.js";
import {
  ReferenceGraph,
  type ReferenceGraphSnapshot,
} from "../../../src/core/reference-graph.js";

const NOW = "2026-07-24T00:00:00.000Z";
const source = { kind: "module", id: "producer" } as const;

function proposal(text: string): BlockProposal {
  return {
    payload: { schema: "test.content/1", value: { text } },
  };
}

interface Snapshots {
  readonly referenceGraph: ReferenceGraphSnapshot;
  readonly blocks: BlockStoreSnapshot;
  readonly deliveries: DeliveryStoreSnapshot;
}

function snapshots(blocks: BlockStore, deliveries: DeliveryStore): Snapshots {
  return {
    referenceGraph: blocks.referenceGraph.snapshot(),
    blocks: blocks.snapshot(),
    deliveries: deliveries.snapshot(),
  };
}

function restore(state: Snapshots, maxFailedAttempts = 3) {
  let id = 0;
  const referenceGraph = new ReferenceGraph({
    snapshot: structuredClone(state.referenceGraph),
  });
  const blocks = new BlockStore({
    nextBlockId: () => `restart-block-${++id}`,
    now: () => NOW,
    referenceGraph,
    snapshot: structuredClone(state.blocks),
  });
  const deliveries = new DeliveryStore({
    blocks,
    maxFailedAttempts,
    nextId: (kind) => `${kind}-restart-${++id}`,
    now: () => NOW,
    snapshot: structuredClone(state.deliveries),
  });
  return { referenceGraph, blocks, deliveries };
}

function createHarness(maxFailedAttempts = 3) {
  let blockId = 0;
  let runtimeId = 0;
  const blocks = new BlockStore({
    nextBlockId: () => `block-${++blockId}`,
    now: () => NOW,
  });
  const deliveries = new DeliveryStore({
    blocks,
    maxFailedAttempts,
    nextId: (kind) => `${kind}-${++runtimeId}`,
    now: () => NOW,
  });
  return { blocks, deliveries };
}

describe("CORE DeliveryStore restart snapshot", () => {
  it("persists the configured subscription start and reports pending work", () => {
    const original = createHarness();
    original.deliveries.createPage("page");
    const before = original.blocks.commit(proposal("before subscription"), source);
    original.deliveries.append("page", before.id);
    original.deliveries.registerConsumer("page", "consumer", "from-head");
    const after = original.blocks.commit(proposal("after subscription"), source);
    const delivery = original.deliveries.append("page", after.id);

    expect(original.deliveries.inspectSubscription("page", "consumer")).toEqual({
      consumerId: "consumer",
      start: "from-head",
      startAfter: "0",
    });
    expect(original.deliveries.inspectPending("consumer", ["page"])).toMatchObject({
      consumerId: "consumer",
      pageIds: ["page"],
      pendingCount: 2,
      pendingBytes: expect.any(Number),
      oldestEnqueuedAt: NOW,
    });

    const recovered = restore(snapshots(original.blocks, original.deliveries));
    expect(recovered.deliveries.inspectSubscription("page", "consumer")).toEqual({
      consumerId: "consumer",
      start: "from-head",
      startAfter: "0",
    });
    const claim = recovered.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    });
    expect(claim?.deliveryIds).toContain(delivery.deliveryId);
  });

  it("rejects the previous DeliveryStore snapshot version", () => {
    const original = createHarness();
    original.deliveries.createPage("page");
    const state = snapshots(original.blocks, original.deliveries);
    const previous = structuredClone(state);
    (previous.deliveries as { schemaVersion: string }).schemaVersion =
      "dolly.delivery-store/5";

    expect(() => restore(previous)).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({
        code: "DELIVERY_SNAPSHOT_INVALID",
      }),
    );
  });

  it("rejects the removed maxAttempts field in a version 6 snapshot", () => {
    const original = createHarness();
    const state = structuredClone(snapshots(original.blocks, original.deliveries)) as unknown as {
      deliveries: Record<string, unknown>;
    };
    delete state.deliveries.maxFailedAttempts;
    state.deliveries.maxAttempts = 3;

    expect(() => restore(state as unknown as Snapshots)).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({
        code: "DELIVERY_SNAPSHOT_INVALID",
      }),
    );
  });

  it("rejects a current snapshot that omits a Module job hasMore value", () => {
    const original = createHarness();
    original.deliveries.createPage("page");
    original.deliveries.registerConsumer("page", "consumer", "from-now");
    const block = original.blocks.commit(proposal("input"), source);
    original.deliveries.append("page", block.id);
    original.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    });
    const state = structuredClone(snapshots(original.blocks, original.deliveries)) as unknown as {
      referenceGraph: ReferenceGraphSnapshot;
      blocks: BlockStoreSnapshot;
      deliveries: {
        moduleJobs: Array<Record<string, unknown>>;
      };
    };
    delete state.deliveries.moduleJobs[0]!.hasMore;

    expect(() => restore(state as unknown as Snapshots)).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({
        code: "DELIVERY_SNAPSHOT_INVALID",
      }),
    );
  });

  it("rejects a current snapshot that omits a Module job failed attempt count", () => {
    const original = createHarness();
    original.deliveries.createPage("page");
    original.deliveries.registerConsumer("page", "consumer", "from-now");
    const block = original.blocks.commit(proposal("input"), source);
    original.deliveries.append("page", block.id);
    original.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    });
    const state = structuredClone(snapshots(original.blocks, original.deliveries)) as unknown as {
      referenceGraph: ReferenceGraphSnapshot;
      blocks: BlockStoreSnapshot;
      deliveries: {
        moduleJobs: Array<Record<string, unknown>>;
      };
    };
    delete state.deliveries.moduleJobs[0]!.failedAttemptCount;

    expect(() => restore(state as unknown as Snapshots)).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({
        code: "DELIVERY_SNAPSHOT_INVALID",
      }),
    );
  });

  it("rejects a released Claim whose Module job still holds active state", () => {
    const original = createHarness();
    original.deliveries.createPage("page");
    original.deliveries.registerConsumer("page", "consumer", "from-now");
    const block = original.blocks.commit(proposal("input"), source);
    original.deliveries.append("page", block.id);
    original.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    });
    const state = structuredClone(snapshots(original.blocks, original.deliveries)) as unknown as {
      referenceGraph: ReferenceGraphSnapshot;
      blocks: BlockStoreSnapshot;
      deliveries: {
        claims: Array<Record<string, unknown>>;
      };
    };
    state.deliveries.claims[0]!.status = "released";

    expect(() => restore(state as unknown as Snapshots)).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({
        code: "DELIVERY_SNAPSHOT_INVALID",
      }),
    );
  });

  it("rejects a failed attempt count that conflicts with Claim history", () => {
    const original = createHarness();
    original.deliveries.createPage("page");
    original.deliveries.registerConsumer("page", "consumer", "from-now");
    const block = original.blocks.commit(proposal("input"), source);
    original.deliveries.append("page", block.id);
    const claim = original.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    original.deliveries.nack({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      failure: { code: "RETRY", retryable: true },
    });
    const state = structuredClone(snapshots(original.blocks, original.deliveries)) as unknown as {
      referenceGraph: ReferenceGraphSnapshot;
      blocks: BlockStoreSnapshot;
      deliveries: {
        moduleJobs: Array<Record<string, unknown>>;
      };
    };
    state.deliveries.moduleJobs[0]!.failedAttemptCount = 0;

    expect(() => restore(state as unknown as Snapshots)).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({
        code: "DELIVERY_SNAPSHOT_INVALID",
      }),
    );
  });

  it("rejects dead-letter version 1", () => {
    const original = createHarness(1);
    original.deliveries.createPage("page");
    original.deliveries.registerConsumer("page", "consumer", "from-now");
    const block = original.blocks.commit(proposal("terminal"), source);
    original.deliveries.append("page", block.id);
    const claim = original.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    original.deliveries.nack({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      failure: { code: "TERMINAL_FAILURE", retryable: false },
    });
    const previous = structuredClone(snapshots(original.blocks, original.deliveries));
    (previous.deliveries.deadLetters[0] as { schemaVersion: string }).schemaVersion =
      "dolly.dead-letter/1";

    expect(() => restore(previous, 1)).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({
        code: "DELIVERY_SNAPSHOT_INVALID",
      }),
    );
  });

  it("restores an active Claim and retries the exact Module job with fresh identity", () => {
    const original = createHarness();
    original.deliveries.createPage("page-a");
    original.deliveries.createPage("page-b");
    original.deliveries.registerConsumer("page-a", "consumer", "from-now");
    original.deliveries.registerConsumer("page-b", "consumer", "from-now");
    const block = original.blocks.commit(proposal("repeated"), source);
    const first = original.deliveries.append("page-a", block.id);
    const second = original.deliveries.append("page-b", block.id);
    const claim = original.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page-b", "page-a"],
      moduleGenerationId: "generation-1",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    })!;

    const recovered = restore(snapshots(original.blocks, original.deliveries));
    expect(recovered.deliveries.listActiveClaims()).toEqual([
      expect.objectContaining({
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: 1,
        moduleGenerationId: "generation-1",
        status: "active",
      }),
    ]);
    expect(recovered.referenceGraph.leaseCountFor({ kind: "block", id: block.id })).toBe(1);

    expect(recovered.deliveries.nack({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      failure: { code: "RUNTIME_RESTART", retryable: true },
    })).toBe("retry-scheduled");
    const retry = recovered.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page-a", "page-b"],
      moduleGenerationId: "generation-2",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    })!;
    expect(retry.moduleJobId).toBe(claim.moduleJobId);
    expect(retry.deliveryIds).toEqual([first.deliveryId, second.deliveryId]);
    expect(retry.attempt).toBe(2);
    expect(retry.runId).not.toBe(claim.runId);
    expect(retry.moduleGenerationId).toBe("generation-2");
  });

  it("restores a failed Module job without changing its hasMore input value", () => {
    const original = createHarness();
    original.deliveries.createPage("page");
    original.deliveries.registerConsumer("page", "consumer", "from-now");
    const firstBlock = original.blocks.commit(proposal("first"), source);
    const firstDelivery = original.deliveries.append("page", firstBlock.id);
    const first = original.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    })!;
    expect(first.deliveryIds).toEqual([firstDelivery.deliveryId]);
    expect(first.hasMore).toBe(false);
    expect(original.deliveries.nack({
      moduleJobId: first.moduleJobId,
      claimToken: first.claimToken,
      runId: first.runId,
      attempt: first.attempt,
      moduleGenerationId: first.moduleGenerationId,
      failure: { code: "RETRY", retryable: true },
    })).toBe("retry-scheduled");

    const laterBlock = original.blocks.commit(proposal("later"), source);
    const laterDelivery = original.deliveries.append("page", laterBlock.id);
    const recovered = restore(snapshots(original.blocks, original.deliveries));
    const retry = recovered.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-2",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    })!;

    expect(retry.moduleJobId).toBe(first.moduleJobId);
    expect(retry.deliveryIds).toEqual(first.deliveryIds);
    expect(retry.deliveryIds).not.toContain(laterDelivery.deliveryId);
    expect(retry.hasMore).toBe(first.hasMore);
  });

  it("restores terminal claim history and append tombstones after pruning", () => {
    const original = createHarness(1);
    original.deliveries.createPage("page");
    original.deliveries.registerConsumer("page", "consumer", "from-now");
    const block = original.blocks.commit(proposal("poison"), source);
    const delivery = original.deliveries.appendOnce("append-effect", "page", block.id);
    const claim = original.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    expect(original.deliveries.nack({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      failure: { code: "POISON_INPUT", retryable: false },
    })).toBe("dead-lettered");
    expect(original.deliveries.pruneTerminal("page")).toBe(1);

    const recovered = restore(snapshots(original.blocks, original.deliveries), 1);
    expect(recovered.deliveries.listDeadLetters()).toEqual([
      expect.objectContaining({
        deliveryId: delivery.deliveryId,
        moduleJobId: claim.moduleJobId,
        failureCode: "POISON_INPUT",
      }),
    ]);
    expect(recovered.deliveries.inspectClaim({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
    }).status).toBe("dead-lettered");
    expect(recovered.deliveries.appendOnce("append-effect", "page", block.id)).toEqual(delivery);
    expect(recovered.deliveries.pruneTerminal("page")).toBe(0);
  });

  it("rejects missing active leases and incomplete allocated-ID history", () => {
    const original = createHarness();
    original.deliveries.createPage("page");
    original.deliveries.registerConsumer("page", "consumer", "from-now");
    const block = original.blocks.commit(proposal("active"), source);
    original.deliveries.append("page", block.id);
    original.deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    });
    const state = snapshots(original.blocks, original.deliveries);

    const withoutLease: Snapshots = {
      ...state,
      referenceGraph: { ...state.referenceGraph, leases: [] },
    };
    expect(() => restore(withoutLease)).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({
        code: "DELIVERY_SNAPSHOT_INVALID",
      }),
    );

    const moduleJobId = state.deliveries.moduleJobs[0]!.moduleJobId;
    const incompleteIds: Snapshots = {
      ...state,
      deliveries: {
        ...state.deliveries,
        usedIds: state.deliveries.usedIds.filter((id) => id !== moduleJobId),
      },
    };
    expect(() => restore(incompleteIds)).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({
        code: "DELIVERY_SNAPSHOT_INVALID",
      }),
    );
  });

  it("returns the immutable Claim when its final persistence write is unconfirmed", () => {
    const harness = createHarness();
    harness.deliveries.createPage("page");
    harness.deliveries.registerConsumer("page", "consumer", "from-now");
    const block = harness.blocks.commit(proposal("persist"), source);
    let writes = 0;
    let fail = false;
    harness.deliveries.setMutationObserver(() => {
      writes += 1;
      harness.deliveries.snapshot();
      if (fail) throw new Error("disk unavailable");
    });

    const delivery = harness.deliveries.appendOnce("append-effect", "page", block.id);
    expect(writes).toBe(1);
    expect(harness.deliveries.appendOnce("append-effect", "page", block.id)).toEqual(delivery);
    expect(writes).toBe(1);

    fail = true;
    let error: unknown;
    try {
      harness.deliveries.claim({
        consumerId: "consumer",
        pageIds: ["page"],
        moduleGenerationId: "generation-1",
        maxCount: 1,
        maxBytes: 1024 * 1024,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DeliveryClaimPersistenceUnconfirmedError);
    if (!(error instanceof DeliveryClaimPersistenceUnconfirmedError)) {
      throw new Error("Expected an unconfirmed Delivery Claim persistence error");
    }
    expect(error.code).toBe("CLAIM_PERSISTENCE_UNCONFIRMED");
    expect(error.claim).toMatchObject({
      moduleGenerationId: "generation-1",
      attempt: 1,
      deliveryIds: [delivery.deliveryId],
    });
    expect(Object.isFrozen(error.claim)).toBe(true);

    fail = false;
    const active = harness.deliveries.listActiveClaims();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ status: "active", moduleGenerationId: "generation-1" });
    expect(writes).toBe(3);
  });
});
