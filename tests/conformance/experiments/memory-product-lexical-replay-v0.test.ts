import { describe, expect, it } from "vitest";
import {
  evaluateProductLexicalCase,
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
    expect(result.sessionIds[0]).toBe("exact");
    expect(result.recordCount).toBe(3);
    expect(result.featureCount).toBe(3);
    expect(result.canonicalFeatureBytes).toBeGreaterThan(0);
    expect(result.normalizedSourceBytes).toBeGreaterThan(0);
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
    expect(result.sessionIds).toHaveLength(5);
    expect(new Set(result.sessionIds).size).toBeLessThan(result.sessionIds.length);
    expect(result.sessionIds.filter((sessionId) => sessionId === "segmented").length)
      .toBeGreaterThan(1);
  });
});
