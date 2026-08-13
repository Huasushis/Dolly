import { describe, expect, it } from "vitest";
import {
  evaluateProductLexicalCase,
  scoreProductSessionRanking,
} from "../../../scripts/experiments/probes/memory-product-lexical-replay-v0/product-lexical.mjs";

describe("Memory product lexical replay treatment", () => {
  it("runs the actual extractor, indexer, store, and explicit query action", async () => {
    const result = await evaluateProductLexicalCase({
      question_id: "fixture-basic",
      question: "alpha budget",
      sessions: [
        {
          session_id: "irrelevant",
          messages: [{ role: "assistant", content: "weather forecast" }],
        },
        {
          session_id: "exact",
          messages: [{ role: "user", content: "alpha budget alpha" }],
        },
        {
          session_id: "longer",
          messages: [{ role: "user", content: "alpha budget with several unrelated words" }],
        },
      ],
    });

    expect(result.questionId).toBe("fixture-basic");
    expect(result.ranking[0]).toMatchObject({ rank: 1, sessionId: "exact" });
    expect(result.ranking[0]?.rawBm25).toBeGreaterThan(0);
    expect(result.channelIds).toEqual(["lexical.bm25"]);
    expect(result.recordCount).toBe(3);
    expect(result.featureCount).toBe(3);
    expect(result.canonicalRecordBytes).toBeGreaterThan(0);
    expect(result.canonicalFeatureBytes).toBeGreaterThan(0);
    expect(result.extractionCoverage).toMatchObject({
      complete: true,
      uncoveredNormalizedBytes: 0,
      truncatedItems: 0,
    });
    expect(result.extractionCoverage.normalizedInputBytes).toBeGreaterThan(0);
    expect(result.terminalJobAccounting).toMatchObject({
      pending: 0,
      running: 0,
      retryable: 0,
      permanentFailure: 0,
      cancelled: 0,
      outstandingLeases: 0,
    });
    expect(result.queryCoverage).toMatchObject({
      pendingSequences: [],
      retryableSequences: [],
      permanentFailureSequences: [],
    });
  });

  it("truncates record ranks before mapping segments back to sessions", async () => {
    const result = await evaluateProductLexicalCase({
      question_id: "fixture-segment-duplicates",
      question: "alpha budget",
      sessions: [
        {
          session_id: "segmented",
          messages: [{ role: "user", content: "alpha budget ".repeat(300) }],
        },
        {
          session_id: "single",
          messages: [{ role: "user", content: "alpha budget" }],
        },
      ],
    }, 5);

    expect(result.recordCount).toBeGreaterThan(2);
    const sessionIds = result.ranking.map((rank) => rank.sessionId);
    expect(sessionIds).toHaveLength(5);
    expect(new Set(sessionIds).size).toBeLessThan(sessionIds.length);
    expect(sessionIds.filter((sessionId) => sessionId === "segmented").length)
      .toBeGreaterThan(1);
  });

  it("keeps duplicate sessions in their original metric positions without backfilling", () => {
    const metrics = scoreProductSessionRanking(
      ["gold-a", "gold-a", "miss", "gold-b"],
      ["gold-a", "gold-b"],
      3,
    );

    expect(metrics).toEqual({
      hit: 1,
      recall: 0.5,
      ndcg: 1 / (1 + 1 / Math.log2(3)),
    });
  });

  it("reports skipped source bytes as uncovered instead of diluting feature cost", async () => {
    const oversized = "irrelevant ".repeat(8_000);
    const result = await evaluateProductLexicalCase({
      question_id: "fixture-coverage",
      question: "alpha budget",
      sessions: [
        {
          session_id: "oversized",
          messages: [{ role: "user", content: oversized }],
        },
        {
          session_id: "indexed",
          messages: [{ role: "user", content: "alpha budget" }],
        },
      ],
    });

    expect(result.extractionCoverage.skippedItemsByReason.TEXT_INPUT_TOO_LARGE).toBe(1);
    expect(result.extractionCoverage.complete).toBe(false);
    expect(result.extractionCoverage.uncoveredNormalizedBytes).toBeGreaterThan(64 * 1024);
    expect(result.extractionCoverage.coveredNormalizedBytes).toBeLessThan(
      result.extractionCoverage.normalizedInputBytes,
    );
  });
});
