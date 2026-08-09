import { describe, expect, it } from "vitest";
import { BlockStore, type BlockProposal } from "../../../src/core/block-store.js";
import {
  DeliveryStore,
  DeliveryStoreError,
  type DeliveryStoreSnapshot,
} from "../../../src/core/delivery-store.js";
import {
  buildReactiveModuleInput,
  measureReactiveModuleInput,
} from "../../../src/core/reactive-module-input.js";

const NOW = "2026-07-24T00:00:00.000Z";
const source = { kind: "module", id: "producer" } as const;

function proposal(text: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "text", text, format: "plain" }] },
    },
  };
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

describe("CORE-004 per-consumer claim/ack recovery", () => {
  it("projects fan-out capacity per subscribed occurrence before any mutation", () => {
    const { blocks, deliveries } = createHarness();
    for (const pageId of ["input", "output-a", "output-b"]) {
      deliveries.createPage(pageId);
    }
    deliveries.registerConsumer("input", "worker", "from-now");
    deliveries.registerConsumer("output-a", "sink", "from-now");
    deliveries.registerConsumer("output-b", "sink", "from-now");
    const inputBlock = blocks.commit(proposal("input"), source);
    deliveries.append("input", inputBlock.id);
    const claim = deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    const outputBlock = blocks.commit(proposal("fan out"), source);
    const before = deliveries.snapshot();

    const capacity = deliveries.inspectOutputCommitCapacity({
      claim,
      outputs: [
        { effectId: "effect-a", pageId: "output-a", blockId: outputBlock.id },
        { effectId: "effect-b", pageId: "output-b", blockId: outputBlock.id },
      ],
      mailboxes: [{
        consumerId: "sink",
        pageIds: ["output-a", "output-b"],
        maxResidentCount: 1,
        maxResidentBytes: 1024 * 1024,
      }],
    });

    expect(capacity.blockedConsumerIds).toEqual(["sink"]);
    expect(capacity.projections).toEqual([
      expect.objectContaining({
        consumerId: "sink",
        residentCount: 0,
        acknowledgedInputCount: 0,
        appendedOutputCount: 2,
        projectedResidentCount: 2,
        maxResidentCount: 1,
        blocked: true,
      }),
    ]);
    expect(deliveries.snapshot()).toEqual(before);
  });

  it("credits the exact claimed input in a capacity-neutral self-loop", () => {
    const { blocks, deliveries } = createHarness();
    deliveries.createPage("loop");
    deliveries.registerConsumer("loop", "worker", "from-now");
    const inputBlock = blocks.commit(proposal("loop input"), source);
    deliveries.append("loop", inputBlock.id);
    const claim = deliveries.claim({
      consumerId: "worker",
      pageIds: ["loop"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    const outputBlock = blocks.commit(proposal("loop replacement"), source);

    const capacity = deliveries.inspectOutputCommitCapacity({
      claim,
      outputs: [{ effectId: "loop-effect", pageId: "loop", blockId: outputBlock.id }],
      mailboxes: [{
        consumerId: "worker",
        pageIds: ["loop"],
        maxResidentCount: 1,
        maxResidentBytes: 1024 * 1024,
      }],
    });

    expect(capacity.blockedConsumerIds).toEqual([]);
    expect(capacity.projections).toEqual([
      expect.objectContaining({
        residentCount: 1,
        acknowledgedInputCount: 1,
        appendedOutputCount: 1,
        projectedResidentCount: 1,
        blocked: false,
      }),
    ]);
  });

  it("keeps claimed Deliveries resident across all subscribed Pages", () => {
    const { blocks, deliveries } = createHarness();
    deliveries.createPage("page-a");
    deliveries.createPage("page-b");
    deliveries.registerConsumer("page-a", "consumer", "from-now");
    deliveries.registerConsumer("page-b", "consumer", "from-now");
    const repeated = blocks.commit(proposal("same resident block"), source);
    deliveries.append("page-a", repeated.id);
    deliveries.append("page-b", repeated.id);

    const before = deliveries.inspectResident("consumer", ["page-a", "page-b"]);
    expect(before).toMatchObject({
      pendingCount: 2,
      claimedCount: 0,
      residentCount: 2,
    });

    const claim = deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page-a", "page-b"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    });
    expect(claim).not.toBeNull();
    expect(deliveries.inspectPending("consumer", ["page-a", "page-b"]).pendingCount).toBe(1);
    expect(deliveries.inspectResident("consumer", ["page-a", "page-b"])).toEqual({
      ...before,
      pendingCount: 1,
      pendingBytes: before.pendingBytes / 2,
      claimedCount: 1,
      claimedBytes: before.claimedBytes + before.pendingBytes / 2,
    });

    deliveries.ack(claim!);
    expect(deliveries.inspectResident("consumer", ["page-a", "page-b"])).toMatchObject({
      pendingCount: 1,
      claimedCount: 0,
      residentCount: 1,
      residentBytes: before.residentBytes / 2,
    });
  });

  it("truncates the exact canonical input envelope and reports remaining work", () => {
    let blockId = 0;
    let allocatedId = 0;
    const blocks = new BlockStore({
      nextBlockId: () => `block-${++blockId}`,
      now: () => NOW,
    });
    const longId = (kind: string, value: number) =>
      `${kind}:${value}:${"x".repeat(128 - kind.length - String(value).length - 2)}`;
    const deliveries = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => longId(kind, ++allocatedId),
      now: () => NOW,
    });
    deliveries.createPage("page");
    deliveries.registerConsumer("page", "consumer", "from-now");
    const firstBlock = blocks.commit(proposal("first"), source);
    const secondBlock = blocks.commit(proposal("second"), source);
    const firstDelivery = deliveries.append("page", firstBlock.id);
    const secondDelivery = deliveries.append("page", secondBlock.id);

    const firstSequence = `1${"0".repeat(999)}`;
    const secondSequence = `2${"0".repeat(999)}`;
    const nextSequence = `3${"0".repeat(999)}`;
    const snapshot = structuredClone(deliveries.snapshot()) as unknown as {
      nextGlobalSequence: string;
      deliveries: Array<{ record: { deliveryId: string; globalSequence: string } }>;
    };
    snapshot.nextGlobalSequence = nextSequence;
    for (const delivery of snapshot.deliveries) {
      delivery.record.globalSequence =
        delivery.record.deliveryId === firstDelivery.deliveryId
          ? firstSequence
          : secondSequence;
    }
    let restoredId = 0;
    const restored = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => `restored-${kind}-${++restoredId}`,
      now: () => NOW,
      snapshot: snapshot as unknown as DeliveryStoreSnapshot,
    });
    const firstInput = buildReactiveModuleInput({
      claimedDeliveryIds: [firstDelivery.deliveryId],
      blockGroups: [{
        block: firstBlock,
        deliveryIds: [firstDelivery.deliveryId],
        occurrenceCount: 1,
        firstGlobalSequence: firstSequence,
        lastGlobalSequence: firstSequence,
      }],
      hasMore: true,
    });
    const maxInputBytes = measureReactiveModuleInput(firstInput);

    const claim = restored.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation",
      maxCount: 10,
      maxBytes: 1024 * 1024,
      maxInputBytes,
    });

    expect(claim).not.toBeNull();
    expect(claim!.deliveryIds).toEqual([firstDelivery.deliveryId]);
    expect(claim!.deliveryIds).not.toContain(secondDelivery.deliveryId);
    expect(claim!.hasMore).toBe(true);
    expect(measureReactiveModuleInput(buildReactiveModuleInput({
      claimedDeliveryIds: claim!.deliveryIds,
      blockGroups: claim!.blockGroups,
      hasMore: claim!.hasMore,
    }))).toBe(maxInputBytes);
  });

  it("rejects an oversized first input envelope without durable or allocation side effects", () => {
    let blockId = 0;
    let allocatedId = 0;
    const blocks = new BlockStore({
      nextBlockId: () => `block-${++blockId}`,
      now: () => NOW,
    });
    const deliveries = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => `${kind}-${++allocatedId}`,
      now: () => NOW,
    });
    deliveries.createPage("page");
    deliveries.registerConsumer("page", "consumer", "from-now");
    const block = blocks.commit(proposal("oversized envelope"), source);
    const delivery = deliveries.append("page", block.id);
    const input = buildReactiveModuleInput({
      claimedDeliveryIds: [delivery.deliveryId],
      blockGroups: [{
        block,
        deliveryIds: [delivery.deliveryId],
        occurrenceCount: 1,
        firstGlobalSequence: delivery.globalSequence,
        lastGlobalSequence: delivery.globalSequence,
      }],
      hasMore: false,
    });
    const beforeDeliveries = deliveries.snapshot();
    const beforeReferenceGraph = blocks.referenceGraph.snapshot();
    const beforeAllocatedId = allocatedId;

    expect(() => deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation",
      maxCount: 10,
      maxBytes: 1024 * 1024,
      maxInputBytes: measureReactiveModuleInput(input) - 1,
    })).toThrowError(expect.objectContaining({
      code: "CLAIM_ITEM_OVERSIZE",
      details: expect.objectContaining({
        deliveryId: delivery.deliveryId,
        limit: "reactive-module-input",
      }),
    } satisfies Partial<DeliveryStoreError>));
    expect(allocatedId).toBe(beforeAllocatedId);
    expect(deliveries.snapshot()).toEqual(beforeDeliveries);
    expect(blocks.referenceGraph.snapshot()).toEqual(beforeReferenceGraph);
  });

  it("rechecks a retry envelope before allocating a new Run identity or lease", () => {
    let blockId = 0;
    let allocatedId = 0;
    const blocks = new BlockStore({
      nextBlockId: () => `block-${++blockId}`,
      now: () => NOW,
    });
    const deliveries = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => `${kind}-${++allocatedId}`,
      now: () => NOW,
    });
    deliveries.createPage("page");
    deliveries.registerConsumer("page", "consumer", "from-now");
    const block = blocks.commit(proposal("retry envelope"), source);
    deliveries.append("page", block.id);
    const first = deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    })!;
    deliveries.nack({
      moduleJobId: first.moduleJobId,
      claimToken: first.claimToken,
      runId: first.runId,
      attempt: first.attempt,
      moduleGenerationId: first.moduleGenerationId,
      failure: { code: "RETRY", retryable: true },
    });
    const inputBytes = measureReactiveModuleInput(buildReactiveModuleInput({
      claimedDeliveryIds: first.deliveryIds,
      blockGroups: first.blockGroups,
      hasMore: first.hasMore,
    }));
    const beforeDeliveries = deliveries.snapshot();
    const beforeReferenceGraph = blocks.referenceGraph.snapshot();
    const beforeAllocatedId = allocatedId;

    expect(() => deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-2",
      maxCount: 10,
      maxBytes: 1024 * 1024,
      maxInputBytes: inputBytes - 1,
    })).toThrowError(expect.objectContaining({
      code: "CLAIM_ITEM_OVERSIZE",
      details: expect.objectContaining({ moduleJobId: first.moduleJobId }),
    } satisfies Partial<DeliveryStoreError>));
    expect(allocatedId).toBe(beforeAllocatedId);
    expect(deliveries.snapshot()).toEqual(beforeDeliveries);
    expect(blocks.referenceGraph.snapshot()).toEqual(beforeReferenceGraph);
  });

  it("retries the exact input, including hasMore, under one Module job", () => {
    const { blocks, deliveries } = createHarness();
    deliveries.createPage("page-a");
    deliveries.createPage("page-b");
    deliveries.registerConsumer("page-a", "consumer", "from-now");
    deliveries.registerConsumer("page-b", "consumer", "from-now");

    const repeated = blocks.commit(proposal("same block"), source);
    const later = blocks.commit(proposal("arrived later"), source);
    const firstDelivery = deliveries.append("page-a", repeated.id);
    const secondDelivery = deliveries.append("page-b", repeated.id);

    const first = deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page-a", "page-b"],
      moduleGenerationId: "generation-1",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    });
    expect(first).not.toBeNull();
    expect(first!.deliveryIds).toEqual([firstDelivery.deliveryId, secondDelivery.deliveryId]);
    expect(first!.hasMore).toBe(false);
    expect(first!.blockGroups).toHaveLength(1);
    expect(first!.blockGroups[0]).toMatchObject({
      block: repeated,
      occurrenceCount: 2,
      deliveryIds: [firstDelivery.deliveryId, secondDelivery.deliveryId],
    });

    expect(
      deliveries.nack({
        moduleJobId: first!.moduleJobId,
        claimToken: first!.claimToken,
        runId: first!.runId,
        attempt: first!.attempt,
        moduleGenerationId: "generation-1",
        failure: { code: "MODULE_EXCEPTION", retryable: true },
      }),
    ).toBe("retry-scheduled");

    const outsideClaim = deliveries.append("page-a", later.id);
    expect(first!.deliveryIds).not.toContain(outsideClaim.deliveryId);

    const retry = deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page-a", "page-b"],
      moduleGenerationId: "generation-1",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    });
    expect(retry).not.toBeNull();
    expect(retry!.moduleJobId).toBe(first!.moduleJobId);
    expect(retry!.deliveryIds).toEqual(first!.deliveryIds);
    expect(retry!.hasMore).toBe(first!.hasMore);
    expect(retry!.attempt).toBe(2);
    expect(retry!.runId).not.toBe(first!.runId);
    expect(retry!.claimToken).not.toBe(first!.claimToken);

    expect(() =>
      deliveries.ack({
        moduleJobId: first!.moduleJobId,
        claimToken: first!.claimToken,
        runId: first!.runId,
        attempt: first!.attempt,
        moduleGenerationId: "generation-1",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CLAIM_STALE" } satisfies Partial<DeliveryStoreError>),
    );

    expect(
      deliveries.ack({
        moduleJobId: retry!.moduleJobId,
        claimToken: retry!.claimToken,
        runId: retry!.runId,
        attempt: retry!.attempt,
        moduleGenerationId: "generation-1",
      }),
    ).toBe("committed");
    expect(
      deliveries.ack({
        moduleJobId: retry!.moduleJobId,
        claimToken: retry!.claimToken,
        runId: retry!.runId,
        attempt: retry!.attempt,
        moduleGenerationId: "generation-1",
      }),
    ).toBe("already-committed");

    const next = deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page-a", "page-b"],
      moduleGenerationId: "generation-1",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    });
    expect(next!.deliveryIds).toEqual([outsideClaim.deliveryId]);
  });

  it("keeps independent consumer checkpoints", () => {
    const { blocks, deliveries } = createHarness();
    deliveries.createPage("page");
    deliveries.registerConsumer("page", "fast", "from-now");
    deliveries.registerConsumer("page", "slow", "from-now");
    const block = blocks.commit(proposal("fanout"), source);
    const delivery = deliveries.append("page", block.id);

    const fast = deliveries.claim({
      consumerId: "fast",
      pageIds: ["page"],
      moduleGenerationId: "fast-gen",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    })!;
    deliveries.ack({
      moduleJobId: fast.moduleJobId,
      claimToken: fast.claimToken,
      runId: fast.runId,
      attempt: fast.attempt,
      moduleGenerationId: "fast-gen",
    });

    const slow = deliveries.claim({
      consumerId: "slow",
      pageIds: ["page"],
      moduleGenerationId: "slow-gen",
      maxCount: 10,
      maxBytes: 1024 * 1024,
    })!;
    expect(slow.deliveryIds).toEqual([delivery.deliveryId]);
  });

  it("requires the exact Module job, Run, attempt, and generation identity", () => {
    const { blocks, deliveries } = createHarness();
    deliveries.createPage("page");
    deliveries.registerConsumer("page", "consumer", "from-now");
    const block = blocks.commit(proposal("identity"), source);
    deliveries.append("page", block.id);
    const claim = deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    const claimIdentity = {
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
    };

    expect(() =>
      deliveries.inspectClaim({ ...claimIdentity, moduleJobId: "module-job-other" }),
    ).toThrowError(expect.objectContaining({
      code: "CLAIM_MODULE_JOB_MISMATCH",
    } satisfies Partial<DeliveryStoreError>));
    expect(() =>
      deliveries.inspectClaim({ ...claimIdentity, runId: "run-other" }),
    ).toThrowError(expect.objectContaining({ code: "CLAIM_RUN_MISMATCH" } satisfies Partial<DeliveryStoreError>));
    expect(() =>
      deliveries.inspectClaim({ ...claimIdentity, attempt: claim.attempt + 1 }),
    ).toThrowError(expect.objectContaining({
      code: "CLAIM_ATTEMPT_MISMATCH",
    } satisfies Partial<DeliveryStoreError>));
    expect(() =>
      deliveries.inspectClaim({ ...claimIdentity, moduleGenerationId: "generation-other" }),
    ).toThrowError(expect.objectContaining({
      code: "CLAIM_GENERATION_MISMATCH",
    } satisfies Partial<DeliveryStoreError>));
    expect(() =>
      deliveries.nack({
        ...claimIdentity,
        failure: { code: "INVALID_RUNTIME_VALUE", retryable: "yes" as unknown as boolean },
      }),
    ).toThrowError(expect.objectContaining({
      code: "FAILURE_CLASSIFICATION_INVALID",
    } satisfies Partial<DeliveryStoreError>));

    expect(deliveries.inspectClaim(claimIdentity)).toMatchObject({
      status: "active",
      ...claimIdentity,
    });
    expect(deliveries.ack(claimIdentity)).toBe("committed");
  });

  it("dead-letters visibly after the finite attempt budget", () => {
    const { blocks, deliveries } = createHarness(2);
    deliveries.createPage("page");
    deliveries.registerConsumer("page", "consumer", "from-now");
    const block = blocks.commit(proposal("poison"), source);
    deliveries.append("page", block.id);

    const first = deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    expect(
      deliveries.nack({
        moduleJobId: first.moduleJobId,
        claimToken: first.claimToken,
        runId: first.runId,
        attempt: first.attempt,
        moduleGenerationId: "generation",
        failure: { code: "MODULE_EXCEPTION", retryable: true },
      }),
    ).toBe("retry-scheduled");

    const second = deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    expect(
      deliveries.nack({
        moduleJobId: second.moduleJobId,
        claimToken: second.claimToken,
        runId: second.runId,
        attempt: second.attempt,
        moduleGenerationId: "generation",
        failure: { code: "MODULE_EXCEPTION", retryable: true },
      }),
    ).toBe("dead-lettered");

    expect(deliveries.listDeadLetters()).toEqual([
      expect.objectContaining({
        blockId: block.id,
        consumerId: "consumer",
        attempts: 2,
        failureCode: "MODULE_EXCEPTION",
      }),
    ]);
    expect(
      deliveries.claim({
        consumerId: "consumer",
        pageIds: ["page"],
        moduleGenerationId: "generation",
        maxCount: 1,
        maxBytes: 1024 * 1024,
      }),
    ).toBeNull();
  });
});
