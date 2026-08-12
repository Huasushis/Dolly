import { describe, expect, it } from "vitest";

import {
  assertJsonValue,
  type JsonValue,
} from "../../../src/core/canonical-json.js";
import {
  PROVIDER_INDEPENDENT_DEFAULTS,
  RESEARCH_DISABLED,
  RESEARCH_MECHANISMS,
  assertResearchDisabled,
  validateMemoryConfig,
} from "../../../src/extensions/memory/config.js";
import { MemoryError } from "../../../src/extensions/memory/errors.js";
import { lexicalTokens } from "../../../src/extensions/memory/extraction.js";
import {
  createFeatureRecord,
  createMemoryRecord,
  parseMemoryRecord,
  type MemoryRecord,
} from "../../../src/extensions/memory/records.js";
import { planRetention } from "../../../src/extensions/memory/retention.js";
import {
  IndexReadLease,
  parseMemoryQuery,
  retrieve,
} from "../../../src/extensions/memory/retrieval.js";
import { EMPTY_THRESHOLDS, harness, type Harness } from "./fixtures.js";

const CORPUS = [
  "the quarterly budget was approved by the finance committee",
  "the deployment pipeline runs integration tests on every commit",
  "budget forecasts for the next quarter are attached",
];

function jsonValue(value: unknown): JsonValue {
  assertJsonValue(value);
  return value;
}

/**
 * The fields §3 invariant 12 names. A research harness may store them; the
 * baseline must behave as if they are not there.
 */
function researchAnnotations(index: number): Record<string, unknown> {
  return {
    tensity: 100 - index * 40,
    emotion: { valence: index === 1 ? 0.99 : -0.99, intensity: 1 },
    accessCount: 500 - index * 200,
    recencyRank: index,
    surprise: index === 1 ? 1 : 0,
  };
}

function seed(h: Harness, annotate: boolean): readonly MemoryRecord[] {
  const session = h.store.session(h.namespace, h.authorization, "index");
  const records = CORPUS.map((text, index) => {
    const record = createMemoryRecord({
      namespace: h.namespace,
      sourceBlockId: `b${index + 1}`,
      coreSequence: index + 1,
      sourcePageId: h.namespace.inputPageId,
      originatingSessionId: h.identity.sessionId,
      payloadSchema: "dolly.content/1",
      extractorId: h.plan.extractorId,
      extractorVersion: h.plan.extractorVersion,
      segmentId: `seg-${index + 1}`,
      segmentStartByte: 0,
      segmentEndByte: Buffer.byteLength(text, "utf8"),
      text,
      committedFeatureIds: [],
      skippedFeatures: [],
      featurePlanDigest: h.planDigest,
      creationModuleJobId: "job-seed",
      coverageRevision: 0,
      deletionEpoch: 0,
      ...(annotate ? { researchAnnotations: researchAnnotations(index) as never } : {}),
    });
    session.commitRecord(record);
    session.commitFeature(
      createFeatureRecord({
        recordId: record.recordId,
        namespaceKey: record.namespaceKey,
        kind: "lexical",
        sourceModality: "text",
        pipelineId: h.plan.analyzerId,
        pipelineVersion: h.plan.analyzerVersion,
        generationId: h.lexicalGeneration.generationId,
        featureJobId: "job-seed",
        status: "committed",
        tokens: lexicalTokens(text),
      }),
    );
    return record;
  });
  return records;
}

function search(h: Harness) {
  return retrieve({
    session: h.store.session(h.namespace, h.authorization, "query"),
    query: parseMemoryQuery({ requestId: "q1", text: "budget quarter", mode: "lexical" }),
    lease: new IndexReadLease({
      leaseId: "read-lease-1",
      moduleGeneration: 1,
      queryRunId: "run-1",
      generationIds: [h.lexicalGeneration.generationId],
      expiresAtTick: 4,
    }),
    tick: 0,
    moduleGeneration: 1,
    lexicalGeneration: h.lexicalGeneration,
    thresholdProfile: EMPTY_THRESHOLDS,
  });
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof MemoryError) return error.code;
    return `unexpected:${String(error)}`;
  }
  return "no-error";
}

/** §3 invariant 12 and §11.4. */
describe("research fields do not affect the baseline", () => {
  it("produces byte-identical ranking with and without annotations", () => {
    const plain = harness();
    const annotated = harness();
    expect(annotated.namespace.namespaceKey).toBe(plain.namespace.namespaceKey);
    seed(plain, false);
    seed(annotated, true);

    const left = search(plain);
    const right = search(annotated);
    expect(right.matches).toEqual(left.matches);
    expect(right.matches.map((match) => match.recordId)).toEqual(
      left.matches.map((match) => match.recordId),
    );
    expect(right.channels).toEqual(left.channels);
  });

  it("stores the annotations without letting them enter a record identity", () => {
    const plain = harness();
    const annotated = harness();
    const plainRecords = seed(plain, false);
    const annotatedRecords = seed(annotated, true);
    expect(annotatedRecords[0]!.researchAnnotations).toMatchObject({ tensity: 100 });
    expect(plainRecords[0]!.researchAnnotations).toBeUndefined();
    // Identity is namespace, source Block, extractor, segment, plan, and epoch.
    expect(annotatedRecords.map((record) => record.recordId)).toEqual(
      plainRecords.map((record) => record.recordId),
    );
  });

  it("produces the same retention plan regardless of annotations", () => {
    const plain = harness();
    const annotated = harness();
    const policy = { maxRecords: 2, maxTotalTextBytes: 10_000, pinnedRecordIds: [] };
    const left = planRetention(seed(plain, false), policy);
    const right = planRetention(seed(annotated, true), policy);
    expect(right).toEqual(left);
    // The evicted record is the oldest committed one, not the lowest tensity.
    expect(left.evictedRecordIds).toHaveLength(1);
  });

  it("evicts by committed order and quota, and never evicts a pin", () => {
    const h = harness();
    const records = seed(h, true);
    const unpinned = planRetention(records, {
      maxRecords: 1,
      maxTotalTextBytes: 10_000,
      pinnedRecordIds: [],
    });
    expect(unpinned.retainedRecordIds).toEqual([records[2]!.recordId]);

    const pinned = planRetention(records, {
      maxRecords: 1,
      maxTotalTextBytes: 10_000,
      pinnedRecordIds: [records[0]!.recordId],
    });
    expect(pinned.retainedRecordIds).toContain(records[0]!.recordId);
    expect(pinned.evictedRecordIds).not.toContain(records[0]!.recordId);
    // Deterministic for a fixed state and configuration.
    expect(
      planRetention(records, {
        maxRecords: 1,
        maxTotalTextBytes: 10_000,
        pinnedRecordIds: [records[0]!.recordId],
      }),
    ).toEqual(pinned);
  });

  it("applies a byte quota as well as a record quota", () => {
    const h = harness();
    const records = seed(h, false);
    const plan = planRetention(records, {
      maxRecords: 10,
      maxTotalTextBytes: 60,
      pinnedRecordIds: [],
    });
    expect(plan.quotaExceeded).toBe(true);
    expect(plan.retainedTextBytes).toBeLessThanOrEqual(60);
  });
});

/** §14: research mechanisms are classified, disabled, and not implemented. */
describe("research classification", () => {
  it("lists every mechanism the specification classifies as research", () => {
    for (const mechanism of [
      "dailyOrWindowedSummaries",
      "memoryOwnedSkills",
      "longLivedAbstractThinkingPrompt",
      "tensityRanking",
      "tensityRetention",
      "emotionOrDesireExtraction",
      "emotionTriggeredRecall",
      "trajectoryOrSequenceShapeMatching",
      "partOfSpeechRemoval",
      "relationPatternEmbeddings",
      "conceptAnalogyOrAssociativeBridges",
      "mmrOrSerendipityOptimization",
      "llmSelectedSalienceOrSynthesis",
    ]) {
      expect(RESEARCH_MECHANISMS).toContain(mechanism);
      expect(RESEARCH_DISABLED[mechanism as keyof typeof RESEARCH_DISABLED]).toBe(false);
    }
  });

  it("fails visibly when any single mechanism is enabled", () => {
    expect(() => assertResearchDisabled(RESEARCH_DISABLED)).not.toThrow();
    for (const mechanism of RESEARCH_MECHANISMS) {
      expect(
        codeOf(() => assertResearchDisabled({ ...RESEARCH_DISABLED, [mechanism]: true })),
      ).toBe("MEMORY_RESEARCH_NOT_IMPLEMENTED");
      expect(
        codeOf(() =>
          validateMemoryConfig({
            schemaVersion: "dolly.memory-config/1",
            research: { [mechanism]: true },
          }),
        ),
      ).toBe("MEMORY_RESEARCH_NOT_IMPLEMENTED");
    }
  });

  it("has the provider-independent defaults the specification names", () => {
    const config = validateMemoryConfig({ schemaVersion: "dolly.memory-config/1" });
    expect(config).toEqual(PROVIDER_INDEPENDENT_DEFAULTS);
    expect(config.retentionScope).toEqual({ kind: "session" });
    expect(config.inputPagesPerModule).toBe(1);
    expect(config.retrievalMode).toBe("lexical");
    expect(config.mediaPolicyByModality).toEqual({});
    expect(config.sourceRetentionMode).toBe("features-only");
    expect(config.includeSourceRefs).toBe(false);
    expect(config.automaticRecall.enabled).toBe(false);
    expect(config.allowlistedExtractors).toHaveLength(1);
  });

  it("rejects an unknown configuration field instead of ignoring it", () => {
    expect(
      codeOf(() =>
        validateMemoryConfig({ schemaVersion: "dolly.memory-config/1", tensityWeight: 0.5 }),
      ),
    ).toBe("MEMORY_CONFIG_INVALID");
  });

  it("rejects automatic recall instead of accepting an inoperative setting", () => {
    expect(
      codeOf(() =>
        validateMemoryConfig({
          schemaVersion: "dolly.memory-config/1",
          automaticRecall: { enabled: true },
        }),
      ),
    ).toBe("MEMORY_CONFIG_INVALID");
    expect(
      validateMemoryConfig({
        schemaVersion: "dolly.memory-config/1",
        automaticRecall: { enabled: false },
      }).automaticRecall.enabled,
    ).toBe(false);
  });
});

/** §5.1: a version 1 record is rejected rather than aliased. */
describe("record schema version", () => {
  it("refuses version 1 and its former job field", () => {
    const h = harness();
    const [record] = seed(h, false);
    expect(parseMemoryRecord(jsonValue({ ...record })).recordId).toBe(record!.recordId);
    expect(
      codeOf(() =>
        parseMemoryRecord(jsonValue({ ...record, schemaVersion: "dolly.memory-record/1" })),
      ),
    ).toBe("MEMORY_RECORD_INVALID");

    const { creationModuleJobId, ...withoutJob } = record;
    expect(creationModuleJobId).toBeDefined();
    expect(
      codeOf(() => parseMemoryRecord(jsonValue({ ...withoutJob, jobId: "job-seed" }))),
    ).toBe("MEMORY_RECORD_INVALID");
  });
});
