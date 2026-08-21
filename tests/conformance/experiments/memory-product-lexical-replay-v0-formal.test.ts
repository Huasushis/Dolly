import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SYNTHETIC_CASES,
  canonicalJson,
  projectionRow,
} from "../../../scripts/experiments/probes/memory-product-lexical-replay-v0/run-synthetic.mjs";
import { runFormal } from "../../../scripts/experiments/probes/memory-product-lexical-replay-v0/run.mjs";
import {
  finalizeFormal,
} from "../../../scripts/experiments/probes/memory-product-lexical-replay-v0/finalize.mjs";
import {
  EXPECTED_MUTATIONS,
  SPLIT_DEVELOPMENT,
  SPLIT_EVALUATION,
  verifyCore,
} from "../../../scripts/experiments/probes/memory-product-lexical-replay-v0/verify.mjs";
import { SPLIT_EVALUATION as ANALYZE_SPLIT_EVALUATION, analyzeFormal } from "../../../scripts/experiments/probes/memory-product-lexical-replay-v0/analyze.mjs";
import type { AnalysisRecord } from "../../../scripts/experiments/probes/memory-product-lexical-replay-v0/analyze.d.mts";

function writeCases(directory: string): string {
  const casesPath = join(directory, "cases.jsonl");
  writeFileSync(
    casesPath,
    SYNTHETIC_CASES.map((row) => `${canonicalJson(projectionRow(row))}\n`).join(""),
  );
  return casesPath;
}

async function withFormalRun<T>(
  action: (directory: string, casesPath: string) => T | Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "dolly-lexical-formal-"));
  try {
    const casesPath = writeCases(directory);
    return await action(directory, casesPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Memory product lexical replay formal runner", () => {
  it("refuses a pre-existing run id without resume (O_EXCL)", async () => {
    await withFormalRun(async (_directory, casesPath) => {
      const runDir = join(tmpdir(), "dolly-lexical-formal-run-oexcl");
      rmSync(runDir, { recursive: true, force: true });
      try {
        const runId = runDir.split("/").pop() ?? "";
        const first = await runFormal(casesPath, runDir, { maxWorkers: 1 });
        expect(runId).toBeTruthy();
        expect(first.runId).toBe(runId);
        expect(first.accounting).toEqual({ complete: 3, failed: 0, notStarted: 0 });
        await expect(runFormal(casesPath, runDir, { maxWorkers: 1 })).rejects.toMatchObject({
          code: "DUPLICATE_RUN_ID",
        });
      } finally {
        rmSync(runDir, { recursive: true, force: true });
      }
    });
  });

  it("resumes an interrupted run from the durable cache with exact accounting", async () => {
    await withFormalRun(async (_directory, casesPath) => {
      const runDir = join(tmpdir(), "dolly-lexical-formal-run-resume");
      rmSync(runDir, { recursive: true, force: true });
      try {
        const complete = await runFormal(casesPath, runDir, { maxWorkers: 1 });
        expect(complete.accounting).toEqual({ complete: 3, failed: 0, notStarted: 0 });
        const treatment = readFileSync(join(runDir, "treatment.jsonl"), "utf8");
        const rankings = readFileSync(join(runDir, "product-rankings.jsonl"), "utf8");

        // Simulate an interruption that lost one cache entry and corrupted
        // another (a crash mid-write leaves a non-canonical partial file).
        rmSync(join(runDir, "cache", "synthetic-basic.json"));
        writeFileSync(join(runDir, "cache", "synthetic-duplicates.json"), `{"row":`);

        const resumed = await runFormal(casesPath, runDir, {
          maxWorkers: 1,
          resume: true,
          onProgress: (accounting) => {
            expect(accounting.complete).toBeGreaterThanOrEqual(0);
            expect(accounting.failed).toBeGreaterThanOrEqual(0);
            expect(accounting.notStarted).toBeGreaterThanOrEqual(0);
            expect(
              accounting.complete + accounting.failed + accounting.notStarted,
            ).toBeLessThanOrEqual(3);
          },
        });
        expect(resumed.accounting).toEqual({ complete: 3, failed: 0, notStarted: 0 });
        // Deterministic treatment output; resume produces byte-identical
        // artifacts, proving the missing entries were recomputed, not skipped.
        expect(readFileSync(join(runDir, "treatment.jsonl"), "utf8")).toBe(treatment);
        expect(readFileSync(join(runDir, "product-rankings.jsonl"), "utf8")).toBe(rankings);
        const manifest = JSON.parse(readFileSync(join(runDir, "run-manifest.json"), "utf8"));
        expect(manifest.status).toBe("ok");
        expect(manifest.totalJobs).toBe(3);
      } finally {
        rmSync(runDir, { recursive: true, force: true });
      }
    });
  });

  it("finalizes: gold isolation, mutation rejection, verdict, inventory", async () => {
    await withFormalRun(async (directory, casesPath) => {
      const runDir = join(directory, "formal-run");
      const completed = await runFormal(casesPath, runDir, { maxWorkers: 1 });
      expect(completed.accounting).toEqual({ complete: 3, failed: 0, notStarted: 0 });
      // Gold isolation: the runner never writes or reads split.jsonl.
      expect(existsSync(join(runDir, "split.jsonl"))).toBe(false);
      expect(existsSync(join(runDir, "sha256sums.txt"))).toBe(false);

      // Test-owned gold: top-ranked product session becomes the gold session.
      // The reference is NOT a copy of the product: for the evaluation
      // questions the reference swaps the top two product sessions on one
      // question, so the paired deltas are non-zero and the comparison path is
      // genuinely exercised, while the development row never enters a gate.
      const rankings = readFileSync(join(runDir, "product-rankings.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { questionId: string; rank: number; sessionId: string });
      const byQuestion: Record<string, { rank: number; sessionId: string }[]> = {};
      for (const row of rankings) {
        (byQuestion[row.questionId] ??= []).push({ rank: row.rank, sessionId: row.sessionId });
      }
      const splitPath = join(directory, "split.jsonl");
      writeFileSync(
        splitPath,
        SYNTHETIC_CASES.map((row, index) => {
          const list = byQuestion[row.question_id]?.sort((a, b) => a.rank - b.rank) ?? [];
          return canonicalJson({
            question_id: row.question_id,
            question_type: "multi-session-user",
            split: index === 0 ? SPLIT_DEVELOPMENT : SPLIT_EVALUATION,
            goldSessionIds: list.length > 0 ? [list[0].sessionId] : [],
          });
        }).join("\n") + "\n",
      );
      const referencePath = join(directory, "reference.jsonl");
      // Reference mirrors the product except that the top two sessions of
      // the evaluation question "synthetic-duplicates" are swapped, so the
      // product/reference deltas are provably non-zero.
      const referenceRows = rankings
        .filter((row) => row.questionId !== "synthetic-basic")
        .map((row) => {
          if (row.questionId !== "synthetic-duplicates" || row.rank > 2) {
            return canonicalJson({ questionId: row.questionId, rank: row.rank, sessionId: row.sessionId });
          }
          const swapped = byQuestion["synthetic-duplicates"] ?? [];
          const target = swapped.find((candidate) => candidate.rank === (row.rank === 1 ? 2 : 1));
          return canonicalJson({
            questionId: row.questionId,
            rank: row.rank,
            sessionId: target?.sessionId ?? row.sessionId,
          });
        });
      writeFileSync(referencePath, referenceRows.join("\n") + "\n");

      const observed: { mutationId: string; code: string | null; rejected: boolean }[] = [];
      const completedFinalize = await finalizeFormal(runDir, {
        splitPath,
        referencePath,
        onMutation: (entry) => observed.push(entry),
      });
      // The real synthetic treatment rows carry a feature-cost ratio above
      // the frozen p95 limit (tiny covered byte counts relative to feature
      // bytes), so this bundle is legitimately rejected by the
      // cost-ratio-p95 gate while every structural gate and the mutation
      // harness pass. The seal still verifies end to end.
      expect(completedFinalize.classification).toBe("rejected");
      expect(completedFinalize.mutationSummary.allRejected).toBe(true);
      expect(completedFinalize.mutationSummary.mutationCount).toBe(EXPECTED_MUTATIONS.length);
      expect(observed.length).toBe(EXPECTED_MUTATIONS.length);
      for (const expected of EXPECTED_MUTATIONS) {
        const entry = completedFinalize.mutationSummary.entries.find(
          (row) => row.mutationId === expected.mutationId,
        );
        expect(entry).toBeDefined();
        expect(entry?.rejected).toBe(true);
        expect(entry?.code).toBe(expected.expectedCode);
      }

      // Final sealed bundle passes the independent verifier end to end.
      const verified = verifyCore(runDir, { referencePath });
      expect(verified).toEqual({ valid: true });

      const inventory = readFileSync(join(runDir, "sha256sums.txt"), "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(inventory.length).toBe(8);
      const manifest = JSON.parse(readFileSync(join(runDir, "run-manifest.json"), "utf8"));
      expect(manifest.splitSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.checksumInventoryVerified).toBe(true);

      // A second finalize is refused: the bundle is sealed.
      await expect(finalizeFormal(runDir, { splitPath, referencePath })).rejects.toMatchObject({
        code: "FINALIZE_ALREADY_FINALIZED",
      });
    });
  });
});


type AnalysisGateRow = {
  questionId: string;
  rank: number;
  recordId: string;
  sourceBlockId: string;
  sessionId: string;
  rawBm25: number;
  caseSha256: string;
};

function okTreatmentRow(questionId: string, ratio: number) {
  const covered = 512;
  const featureBytes = Math.round(ratio * covered);
  return {
    questionId,
    caseSha256: "f".repeat(64),
    state: "ok" as const,
    coverage: {
      normalizedInputBytes: covered,
      coveredNormalizedBytes: covered,
      uncoveredNormalizedBytes: 0,
      truncatedItems: 0,
      skippedItemsByReason: {},
      complete: true,
    },
    terminalJobs: {
      pending: 0,
      running: 0,
      retryable: 0,
      succeeded: 1,
      skipped: 0,
      permanentFailure: 0,
      cancelled: 0,
      outstandingLeases: 0,
      maxObservedConcurrency: 1,
    },
    limit: 10,
    queries: [],
    recordCount: 2,
    featureCount: 2,
    canonicalRecordBytes: 700,
    canonicalFeatureBytes: featureBytes,
  };
}

function okCoverageRow(questionId: string) {
  return {
    ...okTreatmentRow(questionId, 0.5),
    coverage: {
      normalizedInputBytes: 512,
      coveredNormalizedBytes: 300,
      uncoveredNormalizedBytes: 212,
      truncatedItems: 1,
      skippedItemsByReason: { TEXT_INPUT_TOO_LARGE: 1 },
      complete: false,
    },
  };
}

function analysisRankingRow(questionId: string, sessions: string[]): AnalysisGateRow[] {
  return sessions.map((sessionId, index) => ({
    questionId,
    rank: index + 1,
    recordId: `rec-${questionId}-${index}`,
    sourceBlockId: `blk-${questionId}-${index}`,
    sessionId,
    rawBm25: 100 - index,
    caseSha256: "f".repeat(64),
  }));
}

function analysisJsonLines(rows: unknown[]): string {
  return rows.map((row) => `${canonicalJson(row)}\n`).join("");
}

function writeAnalyzerBundle(
  directory: string,
  bundle: {
    treatment: unknown[];
    split: { question_id: string; question_type: string; split: string; goldSessionIds: string[] }[];
    rankings: unknown[];
    reference: { questionId: string; rank: number; sessionId: string }[];
  },
): AnalysisRecord {
  writeFileSync(join(directory, "treatment.jsonl"), analysisJsonLines(bundle.treatment));
  writeFileSync(join(directory, "product-rankings.jsonl"), analysisJsonLines(bundle.rankings));
  writeFileSync(join(directory, "split.jsonl"), analysisJsonLines(bundle.split));
  const referencePath = join(directory, "reference.jsonl");
  writeFileSync(referencePath, analysisJsonLines(bundle.reference));
  return analyzeFormal(directory, { referencePath });
}

describe("Memory product lexical replay analyzer gates", () => {
  it("excludes development rows from every metric gate", () => {
    const directory = mkdtempSync(join(tmpdir(), "dolly-lexical-analyzer-dev"));
    try {
      const evalTreatment = [0, 1, 2].map(i => okTreatmentRow(`e${i}`, 0.5));
      const devTreatment = [okCoverageRow("d0")];
      const evalRankings = [
        ...analysisRankingRow("e0", ["g0", "x0"]),
        ...analysisRankingRow("e1", ["g1", "x1"]),
        ...analysisRankingRow("e2", ["g2", "x2"]),
      ];
      const devRankings = analysisRankingRow("d0", ["dg0", "dx0"]);
      const reference = [
        ...analysisRankingRow("e0", ["g0", "x0"]),
        ...analysisRankingRow("e1", ["g1", "x1"]),
        ...analysisRankingRow("e2", ["g2", "x2"]),
      ].map(({...r}) => ({ questionId: r.questionId, rank: r.rank, sessionId: r.sessionId }));
      const analysis = writeAnalyzerBundle(directory, {
        treatment: [...evalTreatment, ...devTreatment],
        rankings: [...evalRankings, ...devRankings],
        split: [
          { question_id: "e0", question_type: "multi-session-user", split: ANALYZE_SPLIT_EVALUATION, goldSessionIds: ["g0"] },
          { question_id: "e1", question_type: "multi-session-user", split: ANALYZE_SPLIT_EVALUATION, goldSessionIds: ["g1"] },
          { question_id: "e2", question_type: "multi-session-user", split: ANALYZE_SPLIT_EVALUATION, goldSessionIds: ["g2"] },
          { question_id: "d0", question_type: "multi-session-user", split: SPLIT_DEVELOPMENT, goldSessionIds: ["dg0"] },
        ],
        reference,
      });
      expect(analysis.evaluationRows).toBe(3);
      expect(analysis.classification).toBe("supported");
      expect(analysis.decisionGates.find(g => g.gate === "coverage-terminal")?.passed).toBe(true);
      expect(analysis.metricGateFailures).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a worse product on knowledge-update top-one error (product 0.40 vs reference 0.35)", () => {
    const directory = mkdtempSync(join(tmpdir(), "dolly-lexical-analyzer-ku"));
    try {
      const treatment: unknown[] = [];
      const split: { question_id: string; question_type: string; split: string; goldSessionIds: string[] }[] = [];
      const rankings: unknown[] = [];
      const reference: { questionId: string; rank: number; sessionId: string }[] = [];
      for (let i = 0; i < 40; i += 1) {
        const decoy = `ku-decoy-${i}`;
        const gold = `ku-gold-${i}`;
        treatment.push(okTreatmentRow(`ku${i}`, 0.5));
        split.push({ question_id: `ku${i}`, question_type: "knowledge-update", split: ANALYZE_SPLIT_EVALUATION, goldSessionIds: [gold] });
        // Product top-1 misses: 16 of 40 (0.40); reference top-1 misses:
        // 14 of 40 (0.35). Fourteen shared rows put the decoy first for both
        // systems; two additional rows rank the decoy first for the product
        // while the reference still ranks the gold session first, making the
        // product strictly worse on knowledge-update top-one error.
        const sharedMiss = i >= 26; // 14 rows where both rank decoy first
        const productOnlyMiss = i >= 24 && i < 26; // 2 rows product-only
        const productRanksDecoyFirst = sharedMiss || productOnlyMiss;
        const referenceRanksDecoyFirst = sharedMiss; // never the product-only rows
        rankings.push(...analysisRankingRow(
          `ku${i}`,
          productRanksDecoyFirst ? [decoy, gold] : [gold, decoy],
        ));
        reference.push(
          { questionId: `ku${i}`, rank: 1, sessionId: referenceRanksDecoyFirst ? decoy : gold },
          { questionId: `ku${i}`, rank: 2, sessionId: referenceRanksDecoyFirst ? gold : decoy },
        );
      }
      for (let i = 0; i < 100; i += 1) {
        const gold = `n-gold-${i}`;
        treatment.push(okTreatmentRow(`n${i}`, 0.5));
        split.push({ question_id: `n${i}`, question_type: "multi-session-user", split: ANALYZE_SPLIT_EVALUATION, goldSessionIds: [gold] });
        rankings.push(...analysisRankingRow(`n${i}`, [gold, `n-decoy-${i}`]));
        reference.push({ questionId: `n${i}`, rank: 1, sessionId: gold }, { questionId: `n${i}`, rank: 2, sessionId: `n-decoy-${i}` });
      }

      const analysis = writeAnalyzerBundle(directory, { treatment, split, rankings, reference });
      expect(analysis.classification).toBe("rejected");
      expect(analysis.errorRates.product).toBeCloseTo(0.4, 5);
      expect(analysis.errorRates.reference).toBeCloseTo(0.35, 5);
      expect(analysis.errorRates.difference).toBeCloseTo(0.05, 5);
      const kuGate = analysis.decisionGates.find(g => g.gate === "knowledge-update-error");
      expect(kuGate?.passed).toBe(false);
      expect(analysis.metricGateFailures).toBe(1);
      expect(analysis.decisionGates.find(g => g.gate === "ndcg10-lower95")?.passed).toBe(true);
      expect(analysis.decisionGates.find(g => g.gate === "recall10-lower95")?.passed).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects cost-ratio p95 above the frozen limit of 2", () => {
    const directory = mkdtempSync(join(tmpdir(), "dolly-lexical-analyzer-cost"));
    try {
      const treatment = [okTreatmentRow("c0", 3), okTreatmentRow("c1", 1), okTreatmentRow("c2", 2.5)];
      const rankings = [...analysisRankingRow("c0", ["g0"]), ...analysisRankingRow("c1", ["g1"]), ...analysisRankingRow("c2", ["g2"])];
      const reference = [
        { questionId: "c0", rank: 1, sessionId: "g0" },
        { questionId: "c1", rank: 1, sessionId: "g1" },
        { questionId: "c2", rank: 1, sessionId: "g2" },
      ];
      const analysis = writeAnalyzerBundle(directory, {
        treatment,
        rankings,
        split: ["c0", "c1", "c2"].map((qid, i) => ({
          question_id: qid,
          question_type: "multi-session-user",
          split: ANALYZE_SPLIT_EVALUATION,
          goldSessionIds: [`g${i}`],
        })),
        reference,
      });
      expect(analysis.classification).toBe("rejected");
      const costGate = analysis.decisionGates.find(g => g.gate === "cost-ratio-p95");
      expect(costGate?.passed).toBe(false);
      expect(analysis.cost.p95).toBeGreaterThan(2);
      expect(analysis.metricGateFailures).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
