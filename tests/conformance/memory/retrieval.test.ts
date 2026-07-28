import { describe, expect, it } from "vitest";

import { MemoryError } from "../../../src/extensions/memory/errors.js";
import {
  DEFAULT_FUSION_PROFILE,
  FUSION_CHANNEL_ID,
  IndexReadLease,
  LEXICAL_CHANNEL_ID,
  VECTOR_CHANNEL_ID,
  fusionProfileDigest,
  parseMemoryQuery,
  retrieve,
  type FusionProfile,
  type MemoryQuery,
  type RetrievalResult,
  type ThresholdProfile,
} from "../../../src/extensions/memory/retrieval.js";
import {
  EMPTY_THRESHOLDS,
  delivered,
  fakeVector,
  harness,
  indexInputs,
  textBlock,
  textOnlyCapability,
  type Harness,
} from "./fixtures.js";

const CORPUS = [
  "the quarterly budget was approved by the finance committee",
  "the deployment pipeline runs integration tests on every commit",
  "budget forecasts for the next quarter are attached",
];

async function corpus(withEmbedding: boolean): Promise<Harness> {
  const h = harness({ withEmbedding });
  await indexInputs(
    h,
    CORPUS.map((text, index) =>
      delivered({
        deliveryId: `d${index + 1}`,
        sourceBlockId: `b${index + 1}`,
        block: textBlock(text),
        pageSequence: index + 1,
        coreSequence: index + 1,
      }),
    ),
  );
  return h;
}

function query(overrides: Partial<MemoryQuery> & { readonly mode: MemoryQuery["mode"] }): MemoryQuery {
  return parseMemoryQuery({
    requestId: "q1",
    text: "budget",
    limit: 10,
    ...overrides,
  });
}

function search(
  h: Harness,
  options: {
    readonly query: MemoryQuery;
    readonly thresholdProfile?: ThresholdProfile;
    readonly degradedLexicalThresholdProfile?: ThresholdProfile;
    readonly degradedMode?: "lexical";
    readonly fusionProfile?: FusionProfile;
    readonly withVector?: boolean;
    readonly queryVectorOverride?: readonly number[];
    readonly queryVectorSpaceOverride?: ReturnType<typeof textOnlyCapability>["vectorSpace"];
    readonly excludedSourceBlockIds?: readonly string[];
    readonly tick?: number;
    readonly moduleGeneration?: number;
    readonly lease?: IndexReadLease;
  },
): RetrievalResult {
  const useVector = options.withVector !== false && h.vectorGeneration !== undefined;
  const lease =
    options.lease ??
    new IndexReadLease({
      leaseId: "read-lease-1",
      moduleGeneration: 1,
      queryRunId: "run-1",
      generationIds: [
        h.lexicalGeneration.generationId,
        ...(useVector ? [h.vectorGeneration!.generationId] : []),
      ],
      expiresAtTick: 4,
    });
  const vectorSpace =
    options.queryVectorSpaceOverride ?? h.vectorGeneration?.vectorSpace;
  return retrieve({
    session: h.store.session(h.namespace, h.authorization, "query"),
    query: options.query,
    lease,
    tick: options.tick ?? 0,
    moduleGeneration: options.moduleGeneration ?? 1,
    lexicalGeneration: h.lexicalGeneration,
    ...(useVector && h.vectorGeneration !== undefined
      ? { vectorGeneration: h.vectorGeneration }
      : {}),
    ...(useVector && vectorSpace !== undefined && options.query.text !== undefined
      ? {
          queryVector: {
            vector:
              options.queryVectorOverride ??
              fakeVector(options.query.text, vectorSpace.dimension),
            vectorSpace,
          },
        }
      : {}),
    ...(options.fusionProfile === undefined ? {} : { fusionProfile: options.fusionProfile }),
    thresholdProfile: options.thresholdProfile ?? EMPTY_THRESHOLDS,
    ...(options.degradedLexicalThresholdProfile === undefined
      ? {}
      : { degradedLexicalThresholdProfile: options.degradedLexicalThresholdProfile }),
    ...(options.degradedMode === undefined ? {} : { degradedMode: options.degradedMode }),
    ...(options.excludedSourceBlockIds === undefined
      ? {}
      : { excludedSourceBlockIds: options.excludedSourceBlockIds }),
  });
}

/**
 * A unit vector on a component no committed document uses. Cosine similarity to
 * every stored vector is then exactly zero, which lets the test separate a
 * record's rank from its score without depending on hash luck.
 */
function orthogonalQueryVector(h: Harness): readonly number[] {
  const dimension = h.vectorGeneration!.vectorSpace!.dimension;
  const used = new Set<number>();
  for (const text of CORPUS) {
    fakeVector(text, dimension).forEach((value, index) => {
      if (value !== 0) used.add(index);
    });
  }
  const free = Array.from({ length: dimension }, (_unused, index) => index).find(
    (index) => !used.has(index),
  );
  expect(free).toBeDefined();
  return Array.from({ length: dimension }, (_unused, index) => (index === free ? 1 : 0));
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

/** §10.2: the three baseline modes. */
describe("baseline retrieval modes", () => {
  it("ranks lexically with real BM25 scores and a stable order", async () => {
    const h = await corpus(false);
    const result = search(h, { query: query({ mode: "lexical" }), withVector: false });
    expect(result.status).toBe("ok");
    // b3 outranks b1 because BM25 length normalization favours the shorter
    // document; b2 has no matching term and never becomes a candidate.
    expect(result.matches.map((match) => match.sourceBlockId)).toEqual(["b3", "b1"]);
    const raw = result.matches.map(
      (match) => match.scores.find((entry) => entry.channelId === LEXICAL_CHANNEL_ID)!.raw,
    );
    expect(raw[0]!).toBeGreaterThan(raw[1]!);
    expect(raw[1]!).toBeGreaterThan(0);
    const repeated = search(h, { query: query({ mode: "lexical" }), withVector: false });
    expect(repeated.matches).toEqual(result.matches);
  });

  it("names the lexical channel, algorithm, version, generation, and direction", async () => {
    const h = await corpus(false);
    const result = search(h, { query: query({ mode: "lexical" }), withVector: false });
    expect(result.channels).toEqual([
      {
        channelId: LEXICAL_CHANNEL_ID,
        kind: "lexical",
        algorithmId: "dolly.memory.bm25",
        algorithmVersion: "1",
        generationId: h.lexicalGeneration.generationId,
        metric: "bm25",
        direction: "higher-is-better",
      },
    ]);
  });

  it("runs vector retrieval inside one compatible generation", async () => {
    const h = await corpus(true);
    const result = search(h, { query: query({ mode: "vector" }) });
    expect(result.effectiveMode).toBe("vector");
    const channel = result.channels.find((entry) => entry.channelId === VECTOR_CHANNEL_ID)!;
    expect(channel.generationId).toBe(h.vectorGeneration!.generationId);
    expect(channel.metric).toBe("cosine");
    expect(channel.range).toEqual({ min: -1, max: 1 });
  });

  it("reports every component score and rank beside the fusion score", async () => {
    const h = await corpus(true);
    const result = search(h, { query: query({ mode: "hybrid" }) });
    expect(result.snapshot.fusionProfileDigest).toBe(fusionProfileDigest(DEFAULT_FUSION_PROFILE));
    const top = result.matches[0]!;
    expect(top.scores.map((score) => score.channelId).sort()).toEqual(
      [FUSION_CHANNEL_ID, LEXICAL_CHANNEL_ID, VECTOR_CHANNEL_ID].sort(),
    );
    const fusion = top.scores.find((score) => score.channelId === FUSION_CHANNEL_ID)!;
    const lexical = top.scores.find((score) => score.channelId === LEXICAL_CHANNEL_ID)!;
    // The fusion score is a reciprocal-rank value, not the sum of raw numbers.
    expect(fusion.raw).not.toBeCloseTo(lexical.raw, 5);
    expect(fusion.raw).toBeLessThanOrEqual(2 / 61);
  });

  it("reports a missing component channel instead of pretending it ran", async () => {
    const h = await corpus(false);
    const result = search(h, { query: query({ mode: "hybrid" }), degradedMode: "lexical",
      degradedLexicalThresholdProfile: EMPTY_THRESHOLDS, withVector: false });
    expect(result.effectiveMode).toBe("lexical");
    expect(result.notices.map((notice) => notice.code)).toContain(
      "VECTOR_UNAVAILABLE_DEGRADED_LEXICAL",
    );
  });
});

/** §3 invariant 10 and §10.3. */
describe("honest scores and typed thresholds", () => {
  it("keeps a top-ranked low-similarity record at its real score", async () => {
    const h = await corpus(true);
    const orthogonal = orthogonalQueryVector(h);
    const result = search(h, {
      query: query({ mode: "vector" }),
      queryVectorOverride: orthogonal,
    });
    const top = result.matches[0]!;
    const vector = top.scores.find((score) => score.channelId === VECTOR_CHANNEL_ID)!;
    // Rank 1 out of three candidates that all have cosine exactly 0. A rank is
    // never promoted into a score.
    expect(vector.rank).toBe(1);
    expect(vector.raw).toBe(0);
    expect(top.rank).toBe(1);
    expect(result.matches).toHaveLength(3);
  });

  it("filters that top-ranked record out under a real similarity threshold", async () => {
    const h = await corpus(true);
    const thresholdProfile: ThresholdProfile = {
      profileId: "fixture.cosine",
      version: "1",
      rules: [
        {
          channelId: VECTOR_CHANNEL_ID,
          generationId: h.vectorGeneration!.generationId,
          metric: "cosine",
          direction: "higher-is-better",
          value: 0.3,
          profileDigest: null,
        },
      ],
    };
    const unrelated = search(h, {
      query: query({ mode: "vector" }),
      queryVectorOverride: orthogonalQueryVector(h),
      thresholdProfile,
    });
    expect(unrelated.status).toBe("no-match");
    expect(unrelated.matches).toEqual([]);

    const related = search(h, { query: query({ mode: "vector" }), thresholdProfile });
    expect(related.matches.length).toBeGreaterThan(0);
  });

  it("rejects a threshold that names a channel this result does not carry", async () => {
    const h = await corpus(false);
    expect(
      codeOf(() =>
        search(h, {
          query: query({ mode: "lexical" }),
          withVector: false,
          thresholdProfile: {
            profileId: "fixture.wrong-channel",
            version: "1",
            rules: [
              {
                channelId: VECTOR_CHANNEL_ID,
                generationId: "whatever",
                metric: "cosine",
                direction: "higher-is-better",
                value: 0.3,
                profileDigest: null,
              },
            ],
          },
        }),
      ),
    ).toBe("MEMORY_THRESHOLD_CHANNEL_INVALID");
  });

  it("rejects a rule frozen against another generation or metric", async () => {
    const h = await corpus(false);
    for (const rule of [
      { generationId: "another-generation", metric: "bm25" },
      { generationId: h.lexicalGeneration.generationId, metric: "cosine" },
    ]) {
      expect(
        codeOf(() =>
          search(h, {
            query: query({ mode: "lexical" }),
            withVector: false,
            thresholdProfile: {
              profileId: "fixture.mismatch",
              version: "1",
              rules: [
                {
                  channelId: LEXICAL_CHANNEL_ID,
                  direction: "higher-is-better",
                  value: 0.1,
                  profileDigest: null,
                  ...rule,
                },
              ],
            },
          }),
        ),
      ).toBe("MEMORY_THRESHOLD_CHANNEL_INVALID");
    }
  });

  it("applies a lower-is-better rule in the correct direction", async () => {
    const h = await corpus(false);
    const rules = (value: number, direction: "higher-is-better" | "lower-is-better") => ({
      profileId: "fixture.direction",
      version: "1",
      rules: [
        {
          channelId: LEXICAL_CHANNEL_ID,
          generationId: h.lexicalGeneration.generationId,
          metric: "bm25",
          direction,
          value,
          profileDigest: null,
        },
      ],
    });
    // BM25 is higher-is-better, so a lower-is-better rule is not the same rule.
    expect(
      codeOf(() =>
        search(h, {
          query: query({ mode: "lexical" }),
          withVector: false,
          thresholdProfile: rules(0.1, "lower-is-better"),
        }),
      ),
    ).toBe("MEMORY_THRESHOLD_CHANNEL_INVALID");
    const passing = search(h, {
      query: query({ mode: "lexical" }),
      withVector: false,
      thresholdProfile: rules(0.1, "higher-is-better"),
    });
    expect(passing.matches.length).toBeGreaterThan(0);
    const blocking = search(h, {
      query: query({ mode: "lexical" }),
      withVector: false,
      thresholdProfile: rules(1_000, "higher-is-better"),
    });
    expect(blocking.status).toBe("no-match");
  });
});

/** §3 invariant 9, §9.4, §10.2. */
describe("generation and vector-space compatibility", () => {
  it("refuses a query vector from another vector space", async () => {
    const h = await corpus(true);
    const other = textOnlyCapability({ vectorSpaceId: "other-space-v1" });
    expect(
      codeOf(() =>
        search(h, {
          query: query({ mode: "vector" }),
          queryVectorSpaceOverride: other.vectorSpace,
        }),
      ),
    ).toBe("MEMORY_VECTOR_SPACE_INCOMPATIBLE");
  });

  it("gives two vector spaces two generation identities", () => {
    const a = harness({ withEmbedding: true });
    const b = harness({
      embeddingCapability: textOnlyCapability({ vectorSpaceId: "other-space-v1" }),
    });
    expect(a.vectorGeneration!.generationId).not.toBe(b.vectorGeneration!.generationId);
    expect(a.lexicalGeneration.generationId).not.toBe(b.lexicalGeneration.generationId);
  });

  it("fails closed when vector retrieval is requested with no configured degraded policy", async () => {
    const h = await corpus(false);
    expect(
      codeOf(() => search(h, { query: query({ mode: "vector" }), withVector: false })),
    ).toBe("MEMORY_VECTOR_UNAVAILABLE");
  });

  it("refuses to reuse a vector threshold profile as the degraded lexical profile", async () => {
    const h = await corpus(false);
    expect(
      codeOf(() =>
        search(h, {
          query: query({ mode: "vector" }),
          withVector: false,
          degradedMode: "lexical",
          thresholdProfile: {
            profileId: "fixture.cosine",
            version: "1",
            rules: [
              {
                channelId: VECTOR_CHANNEL_ID,
                generationId: "some-vector-generation",
                metric: "cosine",
                direction: "higher-is-better",
                value: 0.3,
                profileDigest: null,
              },
            ],
          },
        }),
      ),
    ).toBe("MEMORY_THRESHOLD_CHANNEL_INVALID");
  });
});

/** §10.4 and §7. */
describe("candidate rules and context", () => {
  it("excludes every source Block in the current input batch", async () => {
    const h = await corpus(false);
    const result = search(h, {
      query: query({ mode: "lexical" }),
      withVector: false,
      excludedSourceBlockIds: ["b1", "b3"],
    });
    expect(result.matches).toEqual([]);
    expect(result.status).toBe("no-match");
  });

  it("labels adjacent context separately and never gives it a score", async () => {
    const h = await corpus(false);
    const result = search(h, {
      query: query({ mode: "lexical", contextExpansion: 2 }),
      withVector: false,
    });
    const top = result.matches[0]!;
    expect(top.context.length).toBeGreaterThan(0);
    expect(top.context.length).toBeLessThanOrEqual(2);
    for (const context of top.context) {
      expect(context.label).toBe("adjacent-context");
      expect(Object.keys(context)).not.toContain("scores");
      expect(context.recordId).not.toBe(top.recordId);
    }
  });

  it("bounds context expansion at its configured limit", () => {
    expect(codeOf(() => query({ mode: "lexical", contextExpansion: 99 }))).toBe(
      "MEMORY_LIMIT_EXCEEDED",
    );
    expect(codeOf(() => query({ mode: "lexical", limit: 9_999 }))).toBe("MEMORY_LIMIT_EXCEEDED");
  });
});

/** §5.4: the read lease is bounded, fenced, and released. */
describe("index read lease", () => {
  it("refuses a query under an expired lease", async () => {
    const h = await corpus(false);
    expect(
      codeOf(() => search(h, { query: query({ mode: "lexical" }), withVector: false, tick: 99 })),
    ).toBe("MEMORY_LIMIT_EXCEEDED");
  });

  it("refuses a query fenced by an older Module generation", async () => {
    const h = await corpus(false);
    expect(
      codeOf(() =>
        search(h, { query: query({ mode: "lexical" }), withVector: false, moduleGeneration: 2 }),
      ),
    ).toBe("MEMORY_GENERATION_FENCED");
  });

  it("refuses a query under a released lease and releases idempotently", async () => {
    const h = await corpus(false);
    const lease = new IndexReadLease({
      leaseId: "read-lease-x",
      moduleGeneration: 1,
      queryRunId: "run-1",
      generationIds: [h.lexicalGeneration.generationId],
      expiresAtTick: 4,
    });
    lease.release();
    lease.release();
    expect(lease.released).toBe(true);
    expect(
      codeOf(() => search(h, { query: query({ mode: "lexical" }), withVector: false, lease })),
    ).toBe("MEMORY_JOB_STATE_INVALID");
  });

  it("pins the exact revisions and generations the result observed", async () => {
    const h = await corpus(false);
    const result = search(h, { query: query({ mode: "lexical" }), withVector: false });
    expect(result.snapshot.lexicalGenerationId).toBe(h.lexicalGeneration.generationId);
    expect(result.snapshot.namespaceKey).toBe(h.namespace.namespaceKey);
    expect(result.snapshot.corpusRevision).toBeGreaterThan(0);
    expect(result.snapshot.tombstoneRevision).toBe(0);
    expect(result.snapshot.coverage[0]!.completeThrough).toBe(3);
  });
});
