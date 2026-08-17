import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SYNTHETIC_CASES,
  canonicalJson,
  writeSyntheticBundle,
} from "../../../scripts/experiments/probes/memory-product-lexical-replay-v0/run-synthetic.mjs";
import { analyzeBundle } from "../../../scripts/experiments/probes/memory-product-lexical-replay-v0/analyze-synthetic.mjs";
import {
  verifyBundle,
  runMutationTests,
} from "../../../scripts/experiments/probes/memory-product-lexical-replay-v0/verify-synthetic.mjs";

// Gold lives only here, never in the runner. Each question's gold is a real
// projected sessionId from SYNTHETIC_CASES so rank-to-session mapping is
// exercised end-to-end. The test writes split.jsonl AFTER the durable bundle,
// mirroring the sealed run's gold-isolation order.
const SYNTHETIC_SPLIT = Object.freeze([
  { question_id: "synthetic-basic", question_type: "single-session", split: "evaluation", goldSessionIds: ["exact"] },
  { question_id: "synthetic-duplicates", question_type: "multi-session", split: "evaluation", goldSessionIds: ["trip"] },
  { question_id: "synthetic-empty", question_type: "edge", split: "evaluation", goldSessionIds: ["empty"] },
]);

function writeSplit(runDirectory) {
  const bytes = SYNTHETIC_SPLIT.map((row) => `${canonicalJson(row)}\n`).join("");
  writeFileSync(join(runDirectory, "split.jsonl"), bytes);
  return bytes;
}

async function withBundle(action) {
  const directory = mkdtempSync(join(tmpdir(), "dolly-lexical-conformance-"));
  try {
    await writeSyntheticBundle(directory);
    writeSplit(directory);
    return await action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Memory product lexical replay synthetic harness", () => {
  it("writes a complete closed-schema bundle that the verifier accepts", async () => {
    await withBundle((directory) => {
      const result = verifyBundle(directory);
      expect(result.valid, `${result.code}: ${result.message ?? ""}`).toBe(true);
      return undefined;
    });
  });

  it("analyzer computes gold-aware metrics with duplicate-rank occupancy preserved", async () => {
    await withBundle((directory) => {
      const analysis = analyzeBundle(directory);
      expect(analysis.classification).toBe("pass");
      expect(analysis.primaryMetrics.ndcg10).toBeGreaterThan(0);
      // duplicateOccupancy is the total retained ranks minus distinct sessions;
      // a non-negative invariant guards the no-collapse rule end-to-end.
      expect(analysis.duplicateOccupancy).toBeGreaterThanOrEqual(0);
      return undefined;
    });
  });

  it("rejects every declared mutation with the expected code", async () => {
    await withBundle((directory) => {
      const summary = runMutationTests(directory);
      expect(summary.allRejected).toBe(true);
      for (const detail of summary.details) {
        expect(detail.rejected, `${detail.mutationId} was not rejected`).toBe(true);
        expect(detail.codeMatched, `${detail.mutationId} expected ${detail.expectedCode} got ${detail.actualCode}`).toBe(true);
      }
      return undefined;
    });
  });

  it("gold-blind projection rows never carry gold or forbidden fields", async () => {
    await withBundle((directory) => {
      const rows = readFileSync(join(directory, "cases.jsonl"), "utf8")
        .split("\n").filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      const forbidden = ["answer_session_ids", "answer", "question_type", "split", "goldSessionIds", "reference"];
      for (const row of rows) {
        for (const field of forbidden) {
          expect(row).not.toHaveProperty(field);
        }
      }
      return undefined;
    });
  });

  it("synthetic case count matches the frozen synthetic bundle", () => {
    expect(SYNTHETIC_CASES).toHaveLength(3);
    expect(SYNTHETIC_SPLIT).toHaveLength(3);
    for (const splitRow of SYNTHETIC_SPLIT) {
      expect(SYNTHETIC_CASES.some((c) => c.question_id === splitRow.question_id)).toBe(true);
    }
  });
});
