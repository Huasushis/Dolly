import { describe, expect, it } from "vitest";
import { BlockStore, type BlockProposal } from "../../../src/core/block-store.js";
import { DeliveryStore } from "../../../src/core/delivery-store.js";

const NOW = "2026-07-24T00:00:00.000Z";

const proposal: BlockProposal = {
  payload: {
    schema: "dolly.content/1",
    value: { items: [{ type: "text", text: "root me", format: "plain" }] },
  },
};

describe("CORE-002 unread Delivery retains its Block through a strong reference", () => {
  it("cannot collect pending, claimed, or retryable input", () => {
    let id = 0;
    const blocks = new BlockStore({
      nextBlockId: () => `block-${++id}`,
      now: () => NOW,
    });
    const deliveries = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => `${kind}-${++id}`,
      now: () => NOW,
    });
    deliveries.createPage("page");
    deliveries.registerConsumer("page", "consumer", "from-now");

    const block = blocks.commit(proposal, { kind: "external", id: "console" });
    deliveries.append("page", block.id);

    expect(blocks.collectUnreachable()).toEqual([]);
    expect(blocks.get(block.id)).not.toBeNull();

    const claim = deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    expect(blocks.collectUnreachable()).toEqual([]);

    deliveries.nack({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: "generation-1",
      failure: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
    });
    expect(blocks.collectUnreachable()).toEqual([]);
    expect(deliveries.pruneTerminal("page")).toBe(0);

    const retry = deliveries.claim({
      consumerId: "consumer",
      pageIds: ["page"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    deliveries.ack({
      moduleJobId: retry.moduleJobId,
      claimToken: retry.claimToken,
      runId: retry.runId,
      attempt: retry.attempt,
      moduleGenerationId: "generation-1",
    });

    expect(deliveries.pruneTerminal("page")).toBe(1);
    expect(blocks.collectUnreachable().map((record) => record.id)).toEqual([block.id]);
    expect(blocks.get(block.id)).toBeNull();
  });
});
