#!/usr/bin/env node
// Gold-aware analyzer seam for memory-product-lexical-replay-v0.
//
// Runs AFTER every treatment row is durable and AFTER split.jsonl is written.
// It never imports the treatment, helper, or product Memory modules: every
// metric is recomputed here natively. It reads only persisted bundle bytes.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseJsonLines(bytes) {
  return bytes
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Duplicate sessions occupy their original ranks; zero backfill. A later
 * returned occurrence of a gold session keeps its rank but gains nothing,
 * and ranks beyond the cutoff are never pulled into the scored result.
 */
function metricsForRanking(ranking, goldIds, cutoff) {
  const seen = new Set();
  let relevant = 0;
  let dcg = 0;
  const limit = Math.min(cutoff, ranking.length);
  for (let index = 0; index < limit; index += 1) {
    const sessionId = ranking[index].sessionId;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    if (!goldIds.has(sessionId)) continue;
    relevant += 1;
    dcg += 1 / Math.log2(index + 2);
  }
  const idealRelevant = Math.min(cutoff, goldIds.size);
  let idealDcg = 0;
  for (let index = 0; index < idealRelevant; index += 1) {
    idealDcg += 1 / Math.log2(index + 2);
  }
  return {
    hit: relevant > 0 ? 1 : 0,
    recall: goldIds.size === 0 ? 0 : relevant / goldIds.size,
    ndcg: idealDcg === 0 ? 0 : dcg / idealDcg,
  };
}

function aggregate(perQuestion) {
  const n = perQuestion.length;
  const mean = (selector) => (n === 0 ? 0 : perQuestion.reduce((sum, row) => sum + selector(row), 0) / n);
  return {
    ndcg10: mean((row) => row.metrics.ndcg),
    recall10: mean((row) => row.metrics.recall),
    hit10: mean((row) => row.metrics.hit),
  };
}

/**
 * Analyze a bundle. The synthetic foundation has no frozen reference, so the
 * analyzer reports product-only primary metrics and leaves reference deltas
 * null; the sealed analyzer replaces them with paired bootstrap bounds.
 */
export function analyzeBundle(runDirectory, { cutoff = 10 } = {}) {
  const treatment = parseJsonLines(readFileSync(join(runDirectory, "treatment.jsonl"), "utf8"));
  const ranking = parseJsonLines(readFileSync(join(runDirectory, "product-rankings.jsonl"), "utf8"));
  let split;
  try {
    split = parseJsonLines(readFileSync(join(runDirectory, "split.jsonl"), "utf8"));
  } catch {
    throw new TypeError(`analyzer requires split.jsonl before gold-aware analysis of ${runDirectory}`);
  }

  const goldByQuestion = new Map();
  const splitByQuestion = new Map();
  for (const row of split) {
    if (row.split !== "development" && row.split !== "evaluation") {
      throw new TypeError(`split value ${String(row.split)} is not in the frozen enum`);
    }
    goldByQuestion.set(row.question_id, new Set(row.goldSessionIds ?? []));
    splitByQuestion.set(row.question_id, row.split);
  }

  const rankingByQuestion = new Map();
  for (const row of ranking) {
    if (!rankingByQuestion.has(row.questionId)) rankingByQuestion.set(row.questionId, []);
    rankingByQuestion.get(row.questionId).push(row);
  }
  for (const rows of rankingByQuestion.values()) rows.sort((a, b) => a.rank - b.rank);

  const perQuestion = [];
  const decisionGates = [];
  let allCoverageComplete = true;
  let allJobsTerminal = true;
  for (const row of treatment) {
    // Development rows are structural only; they never enter the scored
    // result. A typed failure in any row still forces rejection below.
    if (splitByQuestion.get(row.questionId) !== "evaluation") continue;
    const gold = goldByQuestion.get(row.questionId) ?? new Set();
    const ranked = rankingByQuestion.get(row.questionId) ?? [];
    const duplicateOccupancy = ranked.length - new Set(ranked.map((r) => r.sessionId)).size;
    if (row.state !== "ok") {
      decisionGates.push({ questionId: row.questionId, gate: "row-state", passed: false });
      allCoverageComplete = false;
      allJobsTerminal = false;
      perQuestion.push({
        questionId: row.questionId,
        caseSha256: row.caseSha256,
        state: row.state,
        metrics: { hit: 0, recall: 0, ndcg: 0 },
        duplicateOccupancy,
        coverageComplete: false,
        jobsTerminal: false,
        failure: row.failure ?? null,
      });
      continue;
    }
    const metrics = metricsForRanking(ranked, gold, cutoff);
    const jobsTerminal =
      row.terminalJobs.pending === 0 &&
      row.terminalJobs.running === 0 &&
      row.terminalJobs.retryable === 0 &&
      row.terminalJobs.permanentFailure === 0 &&
      row.terminalJobs.cancelled === 0 &&
      row.terminalJobs.outstandingLeases === 0;
    allCoverageComplete = allCoverageComplete && row.coverage.complete;
    allJobsTerminal = allJobsTerminal && jobsTerminal;
    decisionGates.push({ questionId: row.questionId, gate: "row-state", passed: true });
    perQuestion.push({
      questionId: row.questionId,
      caseSha256: row.caseSha256,
      state: row.state,
      metrics,
      duplicateOccupancy,
      coverageComplete: row.coverage.complete,
      jobsTerminal,
      failure: null,
    });
  }

  const primary = aggregate(perQuestion);
  const typedFailurePresent = treatment.some((row) => row.state === "failed");
  // A typed failure forces `rejected`, never `inconclusive`; a structural
  // failure (missing split, broken mappings) is reported by the verifier.
  const classification = typedFailurePresent
    ? "rejected"
    : allCoverageComplete && allJobsTerminal
      ? "pass"
      : "rejected";

  const analysis = {
    classification,
    decisionGates,
    primaryMetrics: {
      ndcg10: primary.ndcg10,
      recall10: primary.recall10,
      hit10: primary.hit10,
      referenceDeltas: null,
    },
    diceScore: null,
    errorRates: null,
    duplicateOccupancy: perQuestion.reduce((sum, row) => sum + row.duplicateOccupancy, 0),
    discordantCases: [],
    mutationRejected: null,
    verifier: null,
    verdict: null,
    cutoff,
    perQuestion,
  };
  return analysis;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const runDirectory = process.argv[2];
  if (!runDirectory) {
    console.error("usage: analyze-synthetic.mjs <run-directory>");
    process.exitCode = 1;
  } else {
    try {
      const analysis = analyzeBundle(resolve(runDirectory));
      console.log(canonicalJson(analysis));
    } catch (error) {
      console.error(String(error?.message ?? error));
      process.exitCode = 1;
    }
  }
}
