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
  verifyCore,
} from "../../../scripts/experiments/probes/memory-product-lexical-replay-v0/verify.mjs";

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

      // Test-owned gold: top-ranked product session becomes the gold session;
      // reference rankings mirror the product so deltas are exactly zero.
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
            split: index % 2,
            goldSessionIds: list.length > 0 ? [list[0].sessionId] : [],
          });
        }).join("\n") + "\n",
      );
      const referencePath = join(directory, "reference.jsonl");
      writeFileSync(
        referencePath,
        rankings
          .map((row) =>
            canonicalJson({ questionId: row.questionId, rank: row.rank, sessionId: row.sessionId }),
          )
          .join("\n") + "\n",
      );

      const observed: { mutationId: string; code: string | null; rejected: boolean }[] = [];
      const completedFinalize = await finalizeFormal(runDir, {
        splitPath,
        referencePath,
        onMutation: (entry) => observed.push(entry),
      });
      expect(completedFinalize.classification).toBe("supported");
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
