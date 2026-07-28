import { describe, expect, it } from "vitest";

import {
  deriveFeatureJobId,
  prepareAdmission,
} from "../../../src/extensions/memory/admission.js";
import { MemoryError } from "../../../src/extensions/memory/errors.js";
import {
  MEMORY_QUERY_SCHEMA,
  MEMORY_RECALL_SCHEMA,
} from "../../../src/extensions/memory/extraction.js";
import { deriveRecordId } from "../../../src/extensions/memory/records.js";
import {
  delivered,
  harness,
  indexInputs,
  namespaceFor,
  runAction,
  textBlock,
} from "./fixtures.js";

/** §3 invariant 2 and §5.2. */
describe("one source Block is indexed at most once", () => {
  it("records a second Delivery as an occurrence, not a second record or vector", async () => {
    const h = harness({ withEmbedding: true });
    const first = delivered({
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock("quarterly budget approved by finance"),
      pageSequence: 1,
    });
    await indexInputs(h, [first], { moduleJobId: "job-1" });

    const query = h.store.session(h.namespace, h.authorization, "query");
    const recordsAfterFirst = query.records().length;
    const featuresAfterFirst = query.features().length;
    expect(recordsAfterFirst).toBeGreaterThan(0);
    expect(featuresAfterFirst).toBe(recordsAfterFirst * 2); // lexical + vector

    // The same immutable Block arrives again as a different Delivery.
    const second = delivered({
      deliveryId: "d2",
      sourceBlockId: "b1",
      block: textBlock("quarterly budget approved by finance"),
      pageSequence: 2,
    });
    await indexInputs(h, [second], { moduleJobId: "job-2" });

    expect(query.records().length).toBe(recordsAfterFirst);
    expect(query.features().length).toBe(featuresAfterFirst);
    expect(query.occurrences().map((entry) => entry.deliveryId).sort()).toEqual(["d1", "d2"]);
    expect(h.embedding!.calls.flat().length).toBe(recordsAfterFirst);
  });

  it("converges both Deliveries on one FeatureJob but keeps two admissions", async () => {
    const h = harness();
    const block = textBlock("one immutable block");
    const a = await runAction(h, [delivered({ deliveryId: "d1", sourceBlockId: "b1", block })], {
      moduleJobId: "job-1",
    });
    const b = await runAction(
      h,
      [delivered({ deliveryId: "d2", sourceBlockId: "b1", block, pageSequence: 2 })],
      { moduleJobId: "job-2" },
    );
    expect(a.preparation.admission.admissionId).not.toBe(b.preparation.admission.admissionId);
    expect(a.preparation.jobs[0]!.featureJobId).toBe(b.preparation.jobs[0]!.featureJobId);

    const query = h.store.session(h.namespace, h.authorization, "query");
    const jobs = query.featureJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.requiredByAdmissionIds.sort()).toEqual(
      [a.preparation.admission.admissionId, b.preparation.admission.admissionId].sort(),
    );
  });

  it("advances each Delivery's own Page sequence when its occurrence completes", async () => {
    const h = harness();
    const block = textBlock("shared block text");
    await indexInputs(
      h,
      [delivered({ deliveryId: "d1", sourceBlockId: "b1", block, pageSequence: 1 })],
      { moduleJobId: "job-1" },
    );
    const query = h.store.session(h.namespace, h.authorization, "query");
    expect(query.coverage("page-main").completeThrough).toBe(1);

    await indexInputs(
      h,
      [delivered({ deliveryId: "d2", sourceBlockId: "b1", block, pageSequence: 2 })],
      { moduleJobId: "job-2" },
    );
    // The second occurrence advanced on its own terminal state, and the
    // deduplicated feature work did not prematurely advance it earlier.
    expect(query.coverage("page-main").completeThrough).toBe(2);
  });

  it("makes a new extractor version a new record instead of a mutation", async () => {
    const v1 = harness();
    await indexInputs(v1, [
      delivered({ deliveryId: "d1", sourceBlockId: "b1", block: textBlock("stable input text") }),
    ]);
    const query = v1.store.session(v1.namespace, v1.authorization, "query");
    const before = query.records();
    expect(before).toHaveLength(1);

    const v2 = harness({
      namespace: v1.namespace,
      store: v1.store,
      journal: v1.journal,
      extractorVersion: "2",
    });
    await indexInputs(
      v2,
      [delivered({ deliveryId: "d2", sourceBlockId: "b1", block: textBlock("stable input text") })],
      { moduleJobId: "job-2" },
    );
    const after = query.records();
    expect(after).toHaveLength(2);
    expect(after.map((record) => record.extractorVersion).sort()).toEqual(["1", "2"]);
    // The version 1 record is byte-identical: nothing was rewritten in place.
    expect(after.find((record) => record.extractorVersion === "1")).toEqual(before[0]);
  });

  it("derives distinct identities for a distinct feature plan or deletion epoch", () => {
    const namespace = namespaceFor();
    const base = {
      namespace,
      sourceBlockId: "b1",
      featurePlanDigest: "sha256:plan-a",
      deletionEpoch: 0,
    };
    expect(deriveFeatureJobId(base)).toBe(deriveFeatureJobId({ ...base }));
    expect(deriveFeatureJobId({ ...base, featurePlanDigest: "sha256:plan-b" })).not.toBe(
      deriveFeatureJobId(base),
    );
    expect(deriveFeatureJobId({ ...base, deletionEpoch: 1 })).not.toBe(deriveFeatureJobId(base));
    expect(
      deriveFeatureJobId({ ...base, namespace: namespaceFor({ inputPageId: "page-other" }) }),
    ).not.toBe(deriveFeatureJobId(base));

    const recordBase = {
      namespace,
      sourceBlockId: "b1",
      extractorId: "dolly.memory.text-content",
      extractorVersion: "1",
      segmentId: "seg-1",
      featurePlanDigest: "sha256:plan-a",
      deletionEpoch: 0,
    };
    expect(deriveRecordId({ ...recordBase, extractorVersion: "2" })).not.toBe(
      deriveRecordId(recordBase),
    );
  });
});

/** §3 invariant 5 and §7. */
describe("memory never indexes its own output", () => {
  it("excludes a Block produced by this Memory Module instance", async () => {
    const h = harness();
    const result = await runAction(h, [
      delivered({
        deliveryId: "d1",
        sourceBlockId: "b1",
        block: textBlock("a recall block this module emitted"),
        sourceModuleInstanceId: h.namespace.memoryModuleInstanceId,
      }),
    ]);
    expect(result.preparation.excluded).toEqual([
      { deliveryId: "d1", sourceBlockId: "b1", reason: "SELF_OUTPUT" },
    ]);
    expect(result.preparation.jobs).toEqual([]);
    expect(result.preparation.admission.deliveryIds).toEqual([]);
    expect(result.preparation.retentionChanges).toEqual([]);
  });

  it("excludes a Block whose only items are Memory control values", async () => {
    const h = harness();
    for (const schema of [MEMORY_QUERY_SCHEMA, MEMORY_RECALL_SCHEMA]) {
      const result = await runAction(
        h,
        [
          delivered({
            deliveryId: `d-${schema}`,
            sourceBlockId: `b-${schema}`,
            block: {
              payloadSchema: "dolly.content/1",
              content: {
                items: [
                  {
                    type: "data",
                    schema,
                    // Text that would rank highly if it were ever indexed.
                    value: { requestId: "q1", text: "sentinel control text", mode: "lexical" },
                  },
                ],
              },
            },
            // Another Memory instance produced it; §7 still excludes the value.
            sourceModuleInstanceId: "memory-b",
          }),
        ],
        { moduleJobId: `job-${schema}` },
      );
      expect(result.preparation.excluded[0]!.reason).toBe("MEMORY_CONTROL_ONLY");
    }
  });

  it("indexes an independently eligible text item while skipping the control value", async () => {
    const h = harness();
    const input = delivered({
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: {
        payloadSchema: "dolly.content/1",
        content: {
          items: [
            { type: "text", text: "ordinary user sentence" },
            {
              type: "data",
              schema: MEMORY_QUERY_SCHEMA,
              value: { requestId: "q1", text: "sentinel control text", mode: "lexical" },
            },
          ],
        },
      },
    });
    await indexInputs(h, [input]);
    const records = h.store.session(h.namespace, h.authorization, "query").records();
    expect(records.map((record) => record.text)).toEqual(["ordinary user sentence"]);
    expect(records.some((record) => record.text.includes("sentinel"))).toBe(false);
  });

  it("skips a data item whose schema is not allowlisted rather than stringifying it", async () => {
    const h = harness();
    const extraction = h.extractor.extract({
      sourceBlockId: "b1",
      payloadSchema: "dolly.content/1",
      content: {
        items: [
          { type: "data", schema: "vendor.telemetry/7", value: { secret: "do not index me" } },
        ],
      },
    });
    expect(extraction.segments).toEqual([]);
    expect(extraction.skipped).toEqual([
      { itemIndex: 0, reason: "SCHEMA_NOT_ALLOWLISTED", subject: "vendor.telemetry/7" },
    ]);
  });

  it("refuses an unknown payload schema instead of guessing an extractor", () => {
    const h = harness();
    let code = "no-error";
    try {
      h.extractor.extract({
        sourceBlockId: "b1",
        payloadSchema: "vendor.custom/1",
        content: { items: [{ type: "text", text: "hello" }] },
      });
    } catch (error) {
      code = error instanceof MemoryError ? error.code : "unexpected";
    }
    expect(code).toBe("MEMORY_EXTRACTOR_UNKNOWN");
  });
});

/** §5.5: a prepared admission is not runnable until the Core result commits. */
describe("admission commit gate", () => {
  it("keeps a prepared admission invisible to the background indexer", async () => {
    const h = harness();
    const result = await runAction(
      h,
      [delivered({ deliveryId: "d1", sourceBlockId: "b1", block: textBlock("pending work") })],
      { commit: false },
    );
    const session = h.store.session(h.namespace, h.authorization, "index");
    expect(session.admission(result.preparation.admission.admissionId)!.state).toBe("prepared");
    expect(session.runnableFeatureJobs()).toEqual([]);

    session.settleAdmission({
      admissionId: result.preparation.admission.admissionId,
      outcome: "committed",
      observedResultDigest: result.resultDigest,
    });
    expect(session.runnableFeatureJobs()).toHaveLength(1);
  });

  it("refuses to commit against a different Module result digest", async () => {
    const h = harness();
    const result = await runAction(
      h,
      [delivered({ deliveryId: "d1", sourceBlockId: "b1", block: textBlock("pending work") })],
      { commit: false },
    );
    const session = h.store.session(h.namespace, h.authorization, "index");
    let code = "no-error";
    try {
      session.settleAdmission({
        admissionId: result.preparation.admission.admissionId,
        outcome: "committed",
        observedResultDigest: "sha256:not-the-committed-result",
      });
    } catch (error) {
      code = error instanceof MemoryError ? error.code : "unexpected";
    }
    expect(code).toBe("MEMORY_JOB_STATE_INVALID");
    expect(session.runnableFeatureJobs()).toEqual([]);
  });

  it("never runs work for a discarded admission", async () => {
    const h = harness();
    const result = await runAction(
      h,
      [delivered({ deliveryId: "d1", sourceBlockId: "b1", block: textBlock("rejected result") })],
      { commit: false },
    );
    const session = h.store.session(h.namespace, h.authorization, "index");
    session.settleAdmission({
      admissionId: result.preparation.admission.admissionId,
      outcome: "discarded",
    });
    expect(session.runnableFeatureJobs()).toEqual([]);
  });
});

/** §12.2: a tombstoned lineage cannot be re-admitted by an ordinary Delivery. */
describe("tombstoned lineage", () => {
  it("records a terminal TOMBSTONED occurrence and creates no job", async () => {
    const h = harness();
    h.store.session(h.namespace, h.authorization, "delete").createTombstone("block:b1", 1);
    const preparation = prepareAdmission({
      namespace: h.namespace,
      identity: h.identity,
      moduleJobId: "job-1",
      moduleGeneration: 1,
      inputs: [
        delivered({ deliveryId: "d1", sourceBlockId: "b1", block: textBlock("deleted content") }),
      ],
      plan: h.plan,
      featurePlanDigest: h.planDigest,
      acceptedPayloadSchemas: ["dolly.content/1"],
      deletionEpoch: 0,
      tombstonedLineages: new Set(["block:b1"]),
      maxAttempts: 3,
      expectedResultDigest: "sha256:x",
    });
    expect(preparation.excluded[0]!.reason).toBe("TOMBSTONED");
    expect(preparation.jobs).toEqual([]);
    expect(preparation.occurrences[0]!.state).toBe("tombstoned");
    expect(preparation.occurrences[0]!.terminal).toBe(true);
  });
});
