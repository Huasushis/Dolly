#!/usr/bin/env node
// Gold-aware formal analyzer for memory-product-lexical-replay-v0.
//
// Runs AFTER every treatment row is durable and after split.jsonl exists:
// it refuses to open `split.jsonl` or the frozen reference rankings until
// `treatment.jsonl` and `product-rankings.jsonl` are both present and
// canonically encoded. It never imports the treatment, helper, or product
// Memory modules: every metric is recomputed here natively from persisted
// bytes. It reports an exact paired contrast against the reference content
// top-10 with the frozen 10,000-row bootstrap stream (xorshift32 seed
// 1296387376) and binary64 aggregation rule, identical to the independent
// verifier's recomputation.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The analyzer is executed as a stand-alone node process; it must import no
// module that transitively pulls in the treatment, so canonicalJson is
// duplicated here instead of imported from run-synthetic.mjs.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const BOOTSTRAP_SEED = 1296387376;
export const BOOTSTRAP_ROWS = 10000;
export const LOWER_BOUND_INDEX = 249;

export function parseCanonicalJsonLines(bytes) {
  const text = bytes.toString("utf8");
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) throw new TypeError("non-canonical JSONL line endings");
  const lines = text.slice(0, -1).split("\n");
  const rows = lines.map((line) => JSON.parse(line));
  const roundTrip = rows.map((row) => `${canonicalJson(row)}\n`).join("");
  if (roundTrip !== text) throw new TypeError("non-canonical JSONL encoding");
  return rows;
}

export function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

/**
 * Frozen paired-bootstrap rule: a single xorshift32 stream, 10,000 rows, each
 * row one resampled index per question, aggregated as the binary64 mean of
 * the resampled paired differences. The stream is never regenerated per
 * metric or condition. Returns the ordered lower-95% bound (index 249 of the
 * sorted 10,000 samples = floor of 2.5%).
 */
export function pairedBootstrapLower95(orderedDifferences) {
  const random = xorshift32(BOOTSTRAP_SEED);
  const samples = [];
  for (let repetition = 0; repetition < BOOTSTRAP_ROWS; repetition += 1) {
    let sum = 0;
    for (let draw = 0; draw < orderedDifferences.length; draw += 1) {
      const index = Math.floor((random() * orderedDifferences.length) / 0x1_0000_0000);
      sum += orderedDifferences[index];
    }
    samples.push(sum / orderedDifferences.length);
  }
  samples.sort((left, right) => left - right);
  return samples[LOWER_BOUND_INDEX];
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

function diceCoefficient(productSessions, referenceSessions) {
  if (productSessions.length === 0 || referenceSessions.length === 0) return 0;
  const referenceSet = new Set(referenceSessions);
  const intersection = productSessions.filter((sessionId) => referenceSet.has(sessionId)).length;
  return (2 * intersection) / (productSessions.length + referenceSessions.length);
}

/**
 * Analyze a completed formal run. `referencePath` points at the frozen
 * reference content rankings (canonical JSONL rows `{questionId, rank,
 * sessionId}`, rank contiguous from 1 per question). Gold is opened only
 * after the product rankings file is read and every treatment row accounted.
 */
export function analyzeFormal(runDirectory, { referencePath, cutoff = 10 } = {}) {
  let treatment;
  let ranked;
  try {
    treatment = parseCanonicalJsonLines(readFileSync(join(runDirectory, "treatment.jsonl")));
  } catch (error) {
    const missing = new TypeError(
      `analyzer requires durable treatment.jsonl in ${runDirectory}: ${String(error?.message ?? error)}`,
    );
    missing.code = "ANALYZE_RANKINGS_NOT_DURABLE";
    throw missing;
  }
  try {
    ranked = parseCanonicalJsonLines(readFileSync(join(runDirectory, "product-rankings.jsonl")));
  } catch (error) {
    const missing = new TypeError(
      `analyzer refuses gold until product-rankings.jsonl is durable in ${runDirectory}: ${String(error?.message ?? error)}`,
    );
    missing.code = "ANALYZE_RANKINGS_NOT_DURABLE";
    throw missing;
  }
  if (ranked.length === 0 && treatment.length > 0) {
    const waiting = new TypeError(
      `analyzer refuses gold until product rankings cover every treatment row in ${runDirectory}`,
    );
    waiting.code = "ANALYZE_RANKINGS_NOT_DURABLE";
    throw waiting;
  }

  // Only after product rankings are durable does the analyzer open gold.
  let split;
  try {
    split = parseCanonicalJsonLines(readFileSync(join(runDirectory, "split.jsonl")));
  } catch {
    throw new TypeError(`analyzer requires split.jsonl before gold-aware analysis of ${runDirectory}`);
  }
  if (referencePath === undefined) {
    throw new TypeError("analyzer requires a frozen reference rankings path");
  }
  const referenceRows = parseCanonicalJsonLines(readFileSync(resolve(referencePath)));

  const goldByQuestion = new Map();
  const typeByQuestion = new Map();
  for (const row of split) {
    goldByQuestion.set(row.question_id, new Set(row.goldSessionIds ?? []));
    typeByQuestion.set(row.question_id, row.question_type ?? null);
  }

  const productByQuestion = new Map();
  for (const row of ranked) {
    if (!productByQuestion.has(row.questionId)) productByQuestion.set(row.questionId, []);
    productByQuestion.get(row.questionId).push(row);
  }
  for (const rows of productByQuestion.values()) rows.sort((a, b) => a.rank - b.rank);

  const referenceByQuestion = new Map();
  for (const row of referenceRows) {
    if (!referenceByQuestion.has(row.questionId)) referenceByQuestion.set(row.questionId, []);
    referenceByQuestion.get(row.questionId).push(row);
  }
  for (const rows of referenceByQuestion.values()) rows.sort((a, b) => a.rank - b.rank);

  const productMetrics = [];
  const referenceMetrics = [];
  const ndcgDeltas = [];
  const recallDeltas = [];
  const hitDeltas = [];
  const diceValues = [];
  const discordant = [];
  const duplicity = [];
  let allCoverageComplete = true;
  let allJobsTerminal = true;
  let typedFailurePresent = false;

  for (const row of treatment) {
    const gold = goldByQuestion.get(row.questionId) ?? new Set();
    const productRows = productByQuestion.get(row.questionId) ?? [];
    const referenceRowsFor = referenceByQuestion.get(row.questionId) ?? [];
    const productSessions = productRows.map((r) => r.sessionId);
    const referenceSessions = referenceRowsFor.map((r) => r.sessionId);
    const occupancy = new Set(productSessions).size;
    const duplicateOccupancy = productSessions.length - occupancy;
    duplicity.push(duplicateOccupancy);
    const referenceMetricsFor = metricsForRanking(referenceRowsFor, gold, cutoff);
    referenceMetrics.push(referenceMetricsFor);

    if (row.state !== "ok") {
      typedFailurePresent = true;
      allCoverageComplete = false;
      allJobsTerminal = false;
      continue;
    }
    if (!row.coverage.complete) allCoverageComplete = false;
    const jobsTerminal =
      row.terminalJobs.pending === 0 &&
      row.terminalJobs.running === 0 &&
      row.terminalJobs.retryable === 0 &&
      row.terminalJobs.permanentFailure === 0 &&
      row.terminalJobs.cancelled === 0 &&
      row.terminalJobs.outstandingLeases === 0;
    if (!jobsTerminal) allJobsTerminal = false;
    const metrics = metricsForRanking(productRows, gold, cutoff);
    productMetrics.push(metrics);
    ndcgDeltas.push(metrics.ndcg - referenceMetricsFor.ndcg);
    recallDeltas.push(metrics.recall - referenceMetricsFor.recall);
    diceValues.push(diceCoefficient(productSessions.slice(0, cutoff), referenceSessions.slice(0, cutoff)));
    if (metrics.hit !== referenceMetricsFor.hit) discordant.push(row.questionId);
  }

  const aggregation = (values) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  const knowledgeUpdateIds = [...typeByQuestion.entries()]
    .filter(([, type]) => type === "knowledge-update")
    .map(([questionId]) => questionId);
  const kuError = (kind) => {
    if (knowledgeUpdateIds.length === 0) return 0;
    return (
      knowledgeUpdateIds.reduce((sum, questionId) => {
        const gold = goldByQuestion.get(questionId) ?? new Set();
        const rankedFirst = (kind === "product" ? productByQuestion : referenceByQuestion)
          .get(questionId)?.[0]?.sessionId;
        return sum + Number(!(rankedFirst !== undefined && gold.has(rankedFirst)));
      }, 0) / knowledgeUpdateIds.length
    );
  };

  const primary = {
    product: {
      ndcg10: aggregation(productMetrics.map((m) => m.ndcg)),
      recall10: aggregation(productMetrics.map((m) => m.recall)),
      hit10: aggregation(productMetrics.map((m) => m.hit)),
    },
    reference: {
      ndcg10: aggregation(referenceMetrics.map((m) => m.ndcg)),
      recall10: aggregation(referenceMetrics.map((m) => m.recall)),
      hit10: aggregation(referenceMetrics.map((m) => m.hit)),
    },
    delta: {
      ndcg10: aggregation(ndcgDeltas),
      recall10: aggregation(recallDeltas),
      hit10: aggregation(hitDeltas),
    },
    bounds: {
      ndcg10: pairedBootstrapLower95(ndcgDeltas),
      recall10: pairedBootstrapLower95(recallDeltas),
    },
  };

  const missForbidden = -0.02;
  const ndcgGate = primary.bounds.ndcg10 >= missForbidden;
  const recallGate = primary.bounds.recall10 >= missForbidden;
  const kuDifference = kuError("reference") - kuError("product");
  const knowledgeGate = kuDifference <= 0.02;
  const coverageTerminalGate = allCoverageComplete && allJobsTerminal && !typedFailurePresent;

  const gates = [
    { gate: "ndcg10-lower95", passed: ndcgGate },
    { gate: "recall10-lower95", passed: recallGate },
    { gate: "knowledge-update-error", passed: knowledgeGate },
    { gate: "coverage-terminal", passed: coverageTerminalGate },
    { gate: "structural-validation", passed: false },
  ];
  const metricGateFailures = gates.slice(0, 4).filter((gate) => !gate.passed).length;
  const classification = metricGateFailures > 0 ? "rejected" : "supported";

  return {
    classification,
    decisionGates: gates,
    primaryMetrics: {
      ndcg10: {
        product: primary.product.ndcg10,
        reference: primary.reference.ndcg10,
        delta: primary.delta.ndcg10,
        lower95: primary.bounds.ndcg10,
      },
      recall10: {
        product: primary.product.recall10,
        reference: primary.reference.recall10,
        delta: primary.delta.recall10,
        lower95: primary.bounds.recall10,
      },
      hit10: {
        product: primary.product.hit10,
        reference: primary.reference.hit10,
        delta: primary.delta.hit10,
      },
    },
    diceScore: aggregation(diceValues),
    errorRates: {
      product: kuError("product"),
      reference: kuError("reference"),
      difference: kuError("reference") - kuError("product"),
    },
    duplicateOccupancy: duplicity.reduce((sum, value) => sum + value, 0),
    discordantCases: discordant,
    mutationRejected: null,
    verifier: null,
    verdict: null,
  };
}

export const ANALYSIS_KEYS = Object.freeze([
  "classification",
  "decisionGates",
  "primaryMetrics",
  "diceScore",
  "errorRates",
  "duplicateOccupancy",
  "discordantCases",
  "mutationRejected",
  "verifier",
  "verdict",
]);


if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const runDirectory = process.argv[2];
  const referencePath = flagOf(process.argv, "--reference");
  if (runDirectory === undefined || referencePath === undefined) {
    console.error("usage: analyze.mjs <run-directory> --reference <reference-rankings>");
    process.exitCode = 1;
  } else {
    try {
      const analysis = analyzeFormal(resolve(runDirectory), { referencePath });
      console.log(canonicalJson(analysis));
    } catch (error) {
      console.error(String(error?.message ?? error));
      process.exitCode = 1;
    }
  }
}

function flagOf(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
}

