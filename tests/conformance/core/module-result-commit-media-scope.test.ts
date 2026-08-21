import { describe, expect, it, vi } from "vitest";
import {
  BlockStore,
  type BlockProposal,
  type SourceIdentity,
} from "../../../src/core/block-store.js";
import { type MediaReferenceItem, type Rect } from "../../../src/core/block-content.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { DeliveryStore, type DeliveryClaim } from "../../../src/core/delivery-store.js";
import type { ModuleSubmissionRecord } from "../../../src/core/module-process-records.js";
import {
  InMemoryModuleResultCommitRepository,
  ModuleResultCommitCoordinator,
  type ModuleResultCommitInput,
  type ModuleResultCommitRecord,
  moduleJobResultDigest,
} from "../../../src/core/module-result-commit.js";

const NOW = "2026-07-26T00:00:00.000Z";
const moduleSource = { kind: "module", id: "worker" } as const;
const trustedCore = { kind: "system", id: "core" } as const;

function crop(
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  return {
    kind: "image_rect_v1",
    x0: left,
    y0: top,
    x1: right,
    y1: bottom,
  } satisfies Rect;
}

function mediaReference(
  mediaId: string,
  selectedCrop?: ReturnType<typeof crop>,
) {
  return {
    type: "media-reference",
    mediaId,
    ...(selectedCrop === undefined ? {} : { crop: selectedCrop }),
  } satisfies MediaReferenceItem;
}

function mediaProposal(
  references: readonly ReturnType<typeof mediaReference>[],
): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: references },
    },
  };
}

function textProposal(text: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "text", text }] },
    },
  };
}

function blockReferenceProposal(blockId: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "block-reference", blockId }] },
    },
  };
}

function blockAndMediaProposal(blockId: string, mediaId: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: {
        items: [
          { type: "block-reference", blockId },
          mediaReference(mediaId),
        ],
      },
    },
  };
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

function createHarness(
  inputReferences: readonly ReturnType<typeof mediaReference>[],
  makeInputProposal?: (blocks: BlockStore) => BlockProposal,
) {
  let blockId = 0;
  let runtimeId = 0;
  const resolve = vi.fn((reference: MediaReferenceItem) => ({ mediaId: reference.mediaId }));
  const blocks = new BlockStore({
    nextBlockId: () => `block-${++blockId}`,
    now: () => NOW,
    media: { resolve },
  });
  for (const mediaId of new Set(inputReferences.map((reference) => reference.mediaId))) {
    blocks.referenceGraph.registerNode({ kind: "media", id: mediaId });
  }
  const deliveries = new DeliveryStore({
    blocks,
    maxFailedAttempts: 3,
    nextId: (kind) => `${kind}-${++runtimeId}`,
    now: () => NOW,
  });
  deliveries.createPage("input");
  deliveries.createPage("output");
  deliveries.registerConsumer("input", "worker", "from-now");
  const inputBlock = blocks.commit(makeInputProposal?.(blocks) ?? mediaProposal(inputReferences), {
    kind: "external",
    id: "console",
  });
  deliveries.append("input", inputBlock.id);
  const claim = deliveries.claim({
    consumerId: "worker",
    pageIds: ["input"],
    moduleGenerationId: "worker-generation",
    maxCount: 1,
    maxBytes: 1024 * 1024,
  })!;
  const submissions = new Map<string, ModuleSubmissionRecord>([
    [claim.runId, submissionForClaim(deliveries, claim)],
  ]);
  const repository = new InMemoryModuleResultCommitRepository();
  const coordinator = new ModuleResultCommitCoordinator({
    blocks,
    deliveries,
    getModuleSubmissionRecord: (runId) => submissions.get(runId),
    acknowledgeDeliveryClaim: (identity) => {
      const result = deliveries.ack(identity);
      submissions.delete(identity.runId);
      return result;
    },
    repository,
    now: () => NOW,
  });
  return { blocks, claim, coordinator, deliveries, inputBlock, repository, resolve };
}

function resultInput(
  harness: ReturnType<typeof createHarness>,
  blockProposal: BlockProposal,
  source: SourceIdentity = moduleSource,
): ModuleResultCommitInput {
  return {
    moduleJobId: harness.claim.moduleJobId,
    claimToken: harness.claim.claimToken,
    runId: harness.claim.runId,
    attempt: harness.claim.attempt,
    moduleGenerationId: harness.claim.moduleGenerationId,
    source,
    outputPageIds: ["output"],
    blockProposal,
  };
}

function preparedRecord(
  harness: ReturnType<typeof createHarness>,
  source: SourceIdentity,
  blockProposal: BlockProposal,
): ModuleResultCommitRecord {
  return {
    schemaVersion: "dolly.module-result-commit/1",
    moduleJobId: harness.claim.moduleJobId,
    claimToken: harness.claim.claimToken,
    runId: harness.claim.runId,
    attempt: harness.claim.attempt,
    moduleGenerationId: harness.claim.moduleGenerationId,
    resultDigest: moduleJobResultDigest({ source, blockProposal, outputPageIds: ["output"] }),
    state: "prepared",
    revision: 1,
    source,
    outputPageIds: ["output"],
    outputDeliveries: [],
    createdAt: NOW,
    updatedAt: NOW,
    blockProposal,
  };
}

describe("module result Media reuse", () => {
  it("rejects an undelivered Media even when the resolver claims it exists", async () => {
    const harness = createHarness([mediaReference("input-media")]);

    await expect(
      harness.coordinator.commit(
        resultInput(harness, mediaProposal([mediaReference("undelivered-media")])),
      ),
    ).rejects.toMatchObject({ code: "MODULE_JOB_OUTPUT_INVALID" });

    expect(harness.repository.get(harness.claim.moduleJobId)).toBeNull();
    expect(harness.blocks.size).toBe(1);
    expect(harness.resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects a result attributed to another Module", async () => {
    const harness = createHarness([mediaReference("input-media")]);

    await expect(
      harness.coordinator.commit(
        resultInput(
          harness,
          mediaProposal([mediaReference("input-media")]),
          { kind: "module", id: "another-module" },
        ),
      ),
    ).rejects.toMatchObject({ code: "MODULE_JOB_SOURCE_MISMATCH" });

    expect(harness.repository.get(harness.claim.moduleJobId)).toBeNull();
    expect(harness.blocks.size).toBe(1);
  });

  it("allows a Module to reuse the same delivered Media", async () => {
    const harness = createHarness([mediaReference("input-media")]);

    await expect(
      harness.coordinator.commit(
        resultInput(harness, mediaProposal([mediaReference("input-media")])),
      ),
    ).resolves.toMatchObject({ state: "committed", blockId: "block-2" });
  });

  it("does not limit a trusted Core direct commit to a Module claim's Media", () => {
    const harness = createHarness([mediaReference("input-media")]);
    harness.blocks.referenceGraph.registerNode({ kind: "media", id: "other-media" });

    expect(
      harness.blocks.commit(
        mediaProposal([mediaReference("other-media")]),
        trustedCore,
      ).payload.value,
    ).toEqual(mediaProposal([mediaReference("other-media")]).payload.value);
  });

  it("allows a full-image input to be reduced to a valid crop", async () => {
    const harness = createHarness([mediaReference("input-media")]);

    await expect(
      harness.coordinator.commit(
        resultInput(
          harness,
          mediaProposal([mediaReference("input-media", crop(200_000, 200_000, 800_000, 800_000))]),
        ),
      ),
    ).resolves.toMatchObject({ state: "committed", blockId: "block-2" });
  });

  it("does not combine separate delivered crops or expand them to the full image", async () => {
    const harness = createHarness([
      mediaReference("input-media", crop(0, 0, 500_000, 1_000_000)),
      mediaReference("input-media", crop(500_000, 0, 1_000_000, 1_000_000)),
    ]);

    await expect(
      harness.coordinator.commit(
        resultInput(harness, mediaProposal([mediaReference("input-media")])),
      ),
    ).rejects.toMatchObject({ code: "MODULE_JOB_OUTPUT_INVALID" });
    await expect(
      harness.coordinator.commit(
        resultInput(
          harness,
          mediaProposal([mediaReference("input-media", crop(250_000, 0, 750_000, 1_000_000))]),
        ),
      ),
    ).rejects.toMatchObject({ code: "MODULE_JOB_OUTPUT_INVALID" });

    expect(harness.repository.get(harness.claim.moduleJobId)).toBeNull();
    expect(harness.blocks.size).toBe(1);
  });

  it("does not enlarge a single delivered crop", async () => {
    const harness = createHarness([mediaReference("input-media", crop(100_000, 100_000, 900_000, 900_000))]);

    await expect(
      harness.coordinator.commit(
        resultInput(
          harness,
          mediaProposal([mediaReference("input-media", crop(50_000, 100_000, 900_000, 900_000))]),
        ),
      ),
    ).rejects.toMatchObject({ code: "MODULE_JOB_OUTPUT_INVALID" });

    expect(harness.repository.get(harness.claim.moduleJobId)).toBeNull();
    expect(harness.blocks.size).toBe(1);
  });

  it("allows a crop contained in one delivered crop", async () => {
    const harness = createHarness([mediaReference("input-media", crop(100_000, 100_000, 900_000, 900_000))]);

    await expect(
      harness.coordinator.commit(
        resultInput(
          harness,
          mediaProposal([mediaReference("input-media", crop(200_000, 200_000, 800_000, 800_000))]),
        ),
      ),
    ).resolves.toMatchObject({ state: "committed", blockId: "block-2" });
  });

  it("does not recover a prepared record that enlarges a delivered crop", async () => {
    const harness = createHarness([
      mediaReference("input-media", crop(100_000, 100_000, 900_000, 900_000)),
    ]);
    harness.repository.createPrepared(
      preparedRecord(
        harness,
        moduleSource,
        mediaProposal([mediaReference("input-media", crop(50_000, 100_000, 900_000, 900_000))]),
      ),
    );

    await expect(harness.coordinator.recover(harness.claim.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_JOB_OUTPUT_INVALID",
      details: { mediaId: "input-media" },
    });

    expect(harness.repository.get(harness.claim.moduleJobId)).toMatchObject({ state: "prepared" });
    expect(harness.blocks.size).toBe(1);
    expect(
      harness.deliveries.inspectClaim({
        moduleJobId: harness.claim.moduleJobId,
        claimToken: harness.claim.claimToken,
        runId: harness.claim.runId,
        attempt: harness.claim.attempt,
        moduleGenerationId: harness.claim.moduleGenerationId,
      }).status,
    ).toBe("active");
  });

  it.each([
    {
      label: "a forged source",
      source: { kind: "module", id: "another-module" } as const,
      output: mediaProposal([mediaReference("input-media")]),
      code: "MODULE_JOB_SOURCE_MISMATCH",
    },
    {
      label: "undelivered Media",
      source: moduleSource,
      output: mediaProposal([mediaReference("undelivered-media")]),
      code: "MODULE_JOB_OUTPUT_INVALID",
    },
  ])("does not resume a prepared record containing $label", async ({ source, output, code }) => {
    const harness = createHarness([mediaReference("input-media")]);
    harness.repository.createPrepared(preparedRecord(harness, source, output));

    await expect(harness.coordinator.recover(harness.claim.moduleJobId)).rejects.toMatchObject({
      code,
    });

    expect(harness.repository.get(harness.claim.moduleJobId)).toMatchObject({ state: "prepared" });
    expect(harness.blocks.size).toBe(1);
    expect(
      harness.deliveries.inspectClaim({
        moduleJobId: harness.claim.moduleJobId,
        claimToken: harness.claim.claimToken,
        runId: harness.claim.runId,
        attempt: harness.claim.attempt,
        moduleGenerationId: harness.claim.moduleGenerationId,
      }).status,
    ).toBe("active");
  });
});

describe("module result Block reference scope", () => {
  it("rejects an earlier undelivered Block before BlockStore validation", async () => {
    const harness = createHarness([mediaReference("input-media")]);
    const earlierBlock = harness.blocks.commit(textProposal("not delivered"), trustedCore);
    const proposal = blockReferenceProposal(earlierBlock.id);

    // A trusted Core caller retains BlockStore's structural-reference behavior.
    expect(harness.blocks.commit(proposal, trustedCore).payload.value).toEqual(proposal.payload.value);

    const validateInput = vi.spyOn(harness.blocks, "validateInput");
    await expect(harness.coordinator.commit(resultInput(harness, proposal))).rejects.toMatchObject({
      code: "MODULE_JOB_OUTPUT_INVALID",
      details: { blockId: earlierBlock.id },
    });

    expect(validateInput).not.toHaveBeenCalled();
    expect(harness.repository.get(harness.claim.moduleJobId)).toBeNull();
    expect(harness.blocks.size).toBe(3);
  });

  it("allows a Module to reference its directly delivered input Block", async () => {
    const harness = createHarness([mediaReference("input-media")]);

    await expect(
      harness.coordinator.commit(
        resultInput(harness, blockReferenceProposal(harness.inputBlock.id)),
      ),
    ).resolves.toMatchObject({ state: "committed", blockId: "block-2" });
  });

  it("does not let a Module forward a Block referenced by its input Block", async () => {
    let referencedBlockId = "";
    const harness = createHarness([], (blocks) => {
      const referencedBlock = blocks.commit(textProposal("referenced by input"), trustedCore);
      referencedBlockId = referencedBlock.id;
      return blockReferenceProposal(referencedBlock.id);
    });

    await expect(
      harness.coordinator.commit(
        resultInput(harness, blockReferenceProposal(referencedBlockId)),
      ),
    ).rejects.toMatchObject({
      code: "MODULE_JOB_OUTPUT_INVALID",
      details: { blockId: referencedBlockId },
    });

    expect(harness.repository.get(harness.claim.moduleJobId)).toBeNull();
    expect(harness.blocks.size).toBe(2);
  });

  it("still applies Media scope after allowing a direct input Block reference", async () => {
    const harness = createHarness([mediaReference("input-media")]);

    await expect(
      harness.coordinator.commit(
        resultInput(
          harness,
          blockAndMediaProposal(harness.inputBlock.id, "undelivered-media"),
        ),
      ),
    ).rejects.toMatchObject({
      code: "MODULE_JOB_OUTPUT_INVALID",
      details: { mediaId: "undelivered-media" },
    });

    expect(harness.repository.get(harness.claim.moduleJobId)).toBeNull();
    expect(harness.blocks.size).toBe(1);
  });

  it("rejects a forged prepared result before output or acknowledgement", async () => {
    const harness = createHarness([mediaReference("input-media")]);
    const earlierBlock = harness.blocks.commit(textProposal("not delivered"), trustedCore);
    harness.deliveries.registerConsumer("output", "sink", "from-head");
    harness.repository.createPrepared(
      preparedRecord(harness, moduleSource, blockReferenceProposal(earlierBlock.id)),
    );

    await expect(harness.coordinator.recover(harness.claim.moduleJobId)).rejects.toMatchObject({
      code: "MODULE_JOB_OUTPUT_INVALID",
      details: { blockId: earlierBlock.id },
    });

    expect(harness.repository.get(harness.claim.moduleJobId)).toMatchObject({ state: "prepared" });
    expect(harness.blocks.size).toBe(2);
    expect(
      harness.deliveries.claim({
        consumerId: "sink",
        pageIds: ["output"],
        moduleGenerationId: "sink-generation",
        maxCount: 1,
        maxBytes: 1024 * 1024,
      }),
    ).toBeNull();
    expect(
      harness.deliveries.inspectClaim({
        moduleJobId: harness.claim.moduleJobId,
        claimToken: harness.claim.claimToken,
        runId: harness.claim.runId,
        attempt: harness.claim.attempt,
        moduleGenerationId: harness.claim.moduleGenerationId,
      }).status,
    ).toBe("active");
  });
});
