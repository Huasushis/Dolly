import { describe, expect, it } from "vitest";
import { BlockStore, type BlockProposal } from "../../../src/core/block-store.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import {
  DeliveryStore,
  DeliveryStoreError,
  type DeliveryClaim,
} from "../../../src/core/delivery-store.js";
import type { ModuleSubmissionRecord } from "../../../src/core/module-process-records.js";
import {
  InMemoryModuleResultCommitRepository,
  ModuleResultCommitCoordinator,
} from "../../../src/core/module-result-commit.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";

const NOW = "2026-07-26T00:00:00.000Z";
const source = { kind: "module", id: "worker" } as const;

function proposal(text: string): BlockProposal {
  return {
    payload: { schema: "test.content/1", value: { text } },
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
  deliveries.createPage("input");
  deliveries.registerConsumer("input", "worker", "from-now");
  return { blocks, deliveries };
}

function claimRequest(claim: {
  readonly moduleJobId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
}) {
  return {
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: claim.moduleGenerationId,
  };
}

function claimOne(deliveries: DeliveryStore, moduleGenerationId: string) {
  return deliveries.claim({
    consumerId: "worker",
    pageIds: ["input"],
    moduleGenerationId,
    maxCount: 1,
    maxBytes: 1024 * 1024,
  })!;
}

function submissionForClaim(
  deliveries: DeliveryStore,
  claim: DeliveryClaim,
): ModuleSubmissionRecord {
  return {
    schemaVersion: "dolly.module-submission-record/1",
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: claim.moduleGenerationId,
    processGenerationId: `${claim.moduleGenerationId}-process`,
    inputDigest: canonicalJsonDigest(deliveries.inspectClaimInput(claim)),
    createdAt: NOW,
  };
}

describe("CORE orderly Delivery Claim release", () => {
  it("preserves the Module job input while revoking the old Claim", async () => {
    const { blocks, deliveries } = createHarness();
    const firstBlock = blocks.commit(proposal("first"), source);
    const secondBlock = blocks.commit(proposal("second"), source);
    const firstDelivery = deliveries.append("input", firstBlock.id);
    deliveries.append("input", secondBlock.id);
    const claim = claimOne(deliveries, "generation-1");
    const request = claimRequest(claim);
    const submissions = new Map<string, ModuleSubmissionRecord>([
      [claim.runId, submissionForClaim(deliveries, claim)],
    ]);
    expect(claim.deliveryIds).toEqual([firstDelivery.deliveryId]);
    expect(claim.hasMore).toBe(true);
    expect(blocks.referenceGraph.leaseCountFor({ kind: "block", id: firstBlock.id })).toBe(1);

    expect(() => deliveries.releaseClaim({ ...request, claimToken: "claim-other" }))
      .toThrowError(expect.objectContaining({ code: "CLAIM_STALE" }));
    expect(() => deliveries.releaseClaim({ ...request, moduleJobId: "module-job-other" }))
      .toThrowError(expect.objectContaining({
        code: "CLAIM_MODULE_JOB_MISMATCH",
      }));
    expect(() => deliveries.releaseClaim({ ...request, runId: "run-other" }))
      .toThrowError(expect.objectContaining({ code: "CLAIM_RUN_MISMATCH" }));
    expect(() => deliveries.releaseClaim({ ...request, attempt: request.attempt + 1 }))
      .toThrowError(expect.objectContaining({
        code: "CLAIM_ATTEMPT_MISMATCH",
      }));
    expect(() => deliveries.releaseClaim({
      ...request,
      moduleGenerationId: "generation-other",
    })).toThrowError(expect.objectContaining({
      code: "CLAIM_GENERATION_MISMATCH",
    }));

    expect(deliveries.releaseClaim(request)).toBe("released");
    submissions.delete(claim.runId);
    expect(deliveries.releaseClaim(request)).toBe("already-released");
    expect(deliveries.inspectClaim(request).status).toBe("released");
    expect(deliveries.listActiveClaims()).toEqual([]);
    expect(blocks.referenceGraph.leaseCountFor({ kind: "block", id: firstBlock.id })).toBe(0);

    const released = deliveries.snapshot();
    expect(released.moduleJobs).toEqual([
      expect.objectContaining({
        moduleJobId: claim.moduleJobId,
        status: "ready",
        attempt: 1,
        failedAttemptCount: 0,
        activeLeaseIds: [],
      }),
    ]);
    expect(released.moduleJobs[0]!.activeClaimToken).toBeUndefined();
    expect(released.moduleJobs[0]!.activeRunId).toBeUndefined();
    expect(released.moduleJobs[0]!.activeGenerationId).toBeUndefined();
    expect(released.claims).toEqual([
      expect.objectContaining({ claimToken: claim.claimToken, status: "released" }),
    ]);
    expect(
      released.deliveries.find(
        (delivery) => delivery.record.deliveryId === firstDelivery.deliveryId,
      )?.obligations,
    ).toEqual([{ consumerId: "worker", status: "pending" }]);

    expect(() => deliveries.ack(request)).toThrowError(
      expect.objectContaining({ code: "CLAIM_STALE" }),
    );
    expect(() => deliveries.nack({
      ...request,
      failure: { code: "LATE_FAILURE", retryable: true },
    })).toThrowError(expect.objectContaining({ code: "CLAIM_STALE" }));

    const coordinator = new ModuleResultCommitCoordinator({
      blocks,
      deliveries,
      getModuleSubmissionRecord: (runId) => submissions.get(runId),
      acknowledgeDeliveryClaim: (identity) => {
        const result = deliveries.ack(identity);
        submissions.delete(identity.runId);
        return result;
      },
      repository: new InMemoryModuleResultCommitRepository(),
      now: () => NOW,
    });
    await expect(coordinator.commit({
      ...request,
      source,
      outputPageIds: [],
    })).rejects.toMatchObject({
      code: "MODULE_JOB_CLAIM_NOT_ACTIVE",
    });

    const retry = claimOne(deliveries, "generation-2");
    expect(retry).toMatchObject({
      moduleJobId: claim.moduleJobId,
      deliveryIds: claim.deliveryIds,
      hasMore: claim.hasMore,
      attempt: 2,
      moduleGenerationId: "generation-2",
    });
    expect(retry.claimToken).not.toBe(claim.claimToken);
    expect(retry.runId).not.toBe(claim.runId);
    const retrySnapshot = deliveries.snapshot();
    expect(deliveries.releaseClaim(request)).toBe("already-released");
    expect(deliveries.snapshot()).toEqual(retrySnapshot);
    deliveries.ack(claimRequest(retry));
    expect(() => deliveries.releaseClaim(claimRequest(retry))).toThrowError(
      expect.objectContaining({ code: "CLAIM_STALE" }),
    );
  });

  it("restores a released Claim and reclaims the same immutable input", () => {
    const original = createHarness();
    const firstBlock = original.blocks.commit(proposal("first"), source);
    const secondBlock = original.blocks.commit(proposal("second"), source);
    original.deliveries.append("input", firstBlock.id);
    original.deliveries.append("input", secondBlock.id);
    const first = claimOne(original.deliveries, "generation-1");
    expect(first.hasMore).toBe(true);
    original.deliveries.releaseClaim(claimRequest(first));

    const referenceGraph = new ReferenceGraph({
      snapshot: structuredClone(original.blocks.referenceGraph.snapshot()),
    });
    let id = 0;
    const blocks = new BlockStore({
      nextBlockId: () => `restart-block-${++id}`,
      now: () => NOW,
      referenceGraph,
      snapshot: structuredClone(original.blocks.snapshot()),
    });
    const deliveries = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => `${kind}-restart-${++id}`,
      now: () => NOW,
      snapshot: structuredClone(original.deliveries.snapshot()),
    });

    expect(deliveries.listActiveClaims()).toEqual([]);
    expect(deliveries.inspectClaim(claimRequest(first)).status).toBe("released");
    const retry = claimOne(deliveries, "generation-2");
    expect(retry).toMatchObject({
      moduleJobId: first.moduleJobId,
      deliveryIds: first.deliveryIds,
      hasMore: first.hasMore,
      attempt: 2,
    });
    expect(retry.claimToken).not.toBe(first.claimToken);
    expect(retry.runId).not.toBe(first.runId);
    expect(deliveries.snapshot().moduleJobs[0]).toMatchObject({
      attempt: 2,
      failedAttemptCount: 0,
      status: "claimed",
    });
  });

  it("retries the exact release after persistence response loss", () => {
    const { blocks, deliveries } = createHarness();
    const block = blocks.commit(proposal("input"), source);
    deliveries.append("input", block.id);
    const claim = claimOne(deliveries, "generation-1");
    const request = claimRequest(claim);
    let writes = 0;
    let loseResponse = true;
    deliveries.setMutationObserver(() => {
      writes += 1;
      deliveries.snapshot();
      if (loseResponse) throw new Error("persistence response lost");
    });

    expect(() => deliveries.releaseClaim(request)).toThrowError(
      expect.objectContaining({ code: "DELIVERY_PERSISTENCE_FAILED" }),
    );
    expect(writes).toBe(1);

    loseResponse = false;
    expect(deliveries.releaseClaim(request)).toBe("already-released");
    expect(writes).toBe(2);
    expect(deliveries.inspectClaim(request).status).toBe("released");
    expect(deliveries.snapshot().moduleJobs[0]).toMatchObject({
      status: "ready",
      attempt: 1,
      failedAttemptCount: 0,
    });
  });

  it("counts only negatively acknowledged Runs against the failure limit", () => {
    const { blocks, deliveries } = createHarness(2);
    const block = blocks.commit(proposal("input"), source);
    deliveries.append("input", block.id);

    const first = claimOne(deliveries, "generation-1");
    deliveries.releaseClaim(claimRequest(first));
    const second = claimOne(deliveries, "generation-2");
    expect(deliveries.nack({
      ...claimRequest(second),
      failure: { code: "FIRST_FAILURE", retryable: true },
    })).toBe("retry-scheduled");
    expect(() => deliveries.releaseClaim(claimRequest(second))).toThrowError(
      expect.objectContaining({ code: "CLAIM_STALE" }),
    );
    const third = claimOne(deliveries, "generation-3");
    deliveries.releaseClaim(claimRequest(third));
    const fourth = claimOne(deliveries, "generation-4");
    expect(deliveries.nack({
      ...claimRequest(fourth),
      failure: { code: "SECOND_FAILURE", retryable: true },
    })).toBe("dead-lettered");
    expect(() => deliveries.releaseClaim(claimRequest(fourth))).toThrowError(
      expect.objectContaining({ code: "CLAIM_STALE" }),
    );

    expect(deliveries.snapshot().moduleJobs[0]).toMatchObject({
      attempt: 4,
      failedAttemptCount: 2,
      status: "dead-lettered",
    });
    expect(
      [...deliveries.snapshot().claims]
        .sort((left, right) => left.attempt - right.attempt)
        .map((claim) => claim.status),
    ).toEqual(["released", "nacked", "released", "dead-lettered"]);
    expect(deliveries.listDeadLetters()).toEqual([
      expect.objectContaining({ attempts: 4, failureCode: "SECOND_FAILURE" }),
    ]);
  });
});
