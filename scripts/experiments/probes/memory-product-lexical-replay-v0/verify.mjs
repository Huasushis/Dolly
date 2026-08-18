#!/usr/bin/env node
// Independent stdlib verifier for memory-product-lexical-replay-v0.
// Re-derives every check from persisted bytes without importing the
// treatment, analyzer, helper, or product Memory modules: exact checksum
// inventory, closed schemas, gold-blind projection, treatment/job identity,
// ranking provenance, split gold membership, secret-marker absence, and an
// independent recomputation of the paired metrics/bootstrap bounds that must
// byte-match analyse.json. Result: { valid, code?, message? }.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The verifier is executed as a stand-alone node process and must import no
// module that transitively pulls in the treatment; canonicalJson is
// duplicated here instead of imported.
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

export const CHECKSUM_FILES = Object.freeze([
  "cases.jsonl",
  "split.jsonl",
  "treatment.jsonl",
  "product-rankings.jsonl",
  "analyse.json",
  "run-manifest.json",
  "mutation-summary.json",
  "command.txt",
]);

const CASES_FORBIDDEN_FIELDS = ["answer", "answer_session_ids", "question_type", "split", "goldSessionIds", "reference"];
const PROJECTION_FIELDS = ["question_id", "question", "sessions", "caseSha256"];
const RANKING_FIELDS = ["questionId", "rank", "recordId", "sourceBlockId", "sessionId", "rawBm25", "caseSha256"];
const SPLIT_FIELDS = ["question_id", "question_type", "split", "goldSessionIds"];
const COVERAGE_FIELDS = [
  "normalizedInputBytes", "coveredNormalizedBytes", "uncoveredNormalizedBytes",
  "truncatedItems", "skippedItemsByReason", "complete",
];
const TERMINAL_FIELDS = [
  "pending", "running", "retryable", "succeeded", "skipped", "permanentFailure",
  "cancelled", "outstandingLeases", "maxObservedConcurrency",
];
const TREATMENT_OK_FIELDS = [
  "questionId", "caseSha256", "state", "coverage", "terminalJobs", "limit", "queries",
  "recordCount", "featureCount", "canonicalRecordBytes", "canonicalFeatureBytes",
];
const TREATMENT_FAILED_FIELDS = ["questionId", "caseSha256", "state", "failure"];
const MANIFEST_FIELDS = [
  "experimentId", "experimentVersion", "runId", "frozenAt", "casesSha256", "splitSha256",
  "legacyReferenceRows", "productRows", "rankingRows", "treatmentHash", "sourceHash",
  "checksumInventoryVerified", "workerCount", "startedAtUs", "totalJobs", "status",
];
const SECRET_MARKER = "say-this-is-secret";

function sha256hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(result, code, message) {
  result.valid = false;
  result.code = code;
  result.message = message;
}

function mkResult() {
  return { valid: true };
}

function closedFields(value, fields) {
  const keys = Object.keys(value).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const sorted = [...fields].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function activeNames(validateAttestations) {
  return validateAttestations
    ? CHECKSUM_FILES
    : CHECKSUM_FILES.filter((name) => name !== "mutation-summary.json");
}

function parseJsonL(bytes, result, code, what) {
  try {
    const text = bytes.toString("utf8");
    if (text.length === 0) return [];
    if (!text.endsWith("\n")) throw new Error("missing trailing newline");
    const rows = text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
    const rebuilt = rows.map((row) => `${canonicalJson(row)}\n`).join("");
    if (rebuilt !== text) throw new Error("rows are not canonically encoded");
    return rows;
  } catch (error) {
    fail(result, code, `${what}: ${String(error?.message ?? error)}`);
    return undefined;
  }
}

function artifactFiles(directory, result, validateAttestations) {
  const names = activeNames(validateAttestations);
  const byName = new Map();
  for (const name of names) {
    let bytes;
    try {
      bytes = readFileSync(join(directory, name));
    } catch {
      fail(result, "ARTIFACT_UNREADABLE", `missing artifact ${name}`);
      return false;
    }
    byName.set(name, bytes);
  }
  result.byName = byName;
  return true;
}

function checksumInventory(directory, result, validateAttestations) {
  const names = activeNames(validateAttestations);
  let inventory;
  try {
    inventory = readFileSync(join(directory, "sha256sums.txt"), "utf8");
  } catch {
    fail(result, "CHECKSUM_INVENTORY_SET_MISMATCH", "sha256sums.txt not found");
    return;
  }
  const lines = inventory.split("\n").filter((line) => line.length > 0);
  const declared = new Map();
  for (const line of lines) {
    const match = /^(?<digest>[0-9a-f]{64})  (?<name>[^\s]+)$/.exec(line);
    if (match === null) {
      fail(result, "CHECKSUM_INVENTORY_SET_MISMATCH", `malformed inventory line ${line}`);
      return;
    }
    if (declared.has(match.groups.name)) {
      fail(result, "CHECKSUM_INVENTORY_SET_MISMATCH", `duplicate inventory entry ${match.groups.name}`);
      return;
    }
    declared.set(match.groups.name, match.groups.digest);
  }
  if (declared.size !== names.length) {
    fail(result, "CHECKSUM_INVENTORY_SET_MISMATCH",
      `expected ${names.length} inventory entries, found ${declared.size}`);
    return;
  }
  for (const name of names) {
    if (!declared.has(name)) {
      fail(result, "CHECKSUM_INVENTORY_SET_MISMATCH", `missing inventory entry ${name}`);
      return;
    }
  }
  for (const [name, digest] of declared) {
    let bytes;
    try {
      bytes = readFileSync(join(directory, name));
    } catch {
      fail(result, "CHECKSUM_INVENTORY_SET_MISMATCH", `artifact ${name} missing on disk`);
      return;
    }
    if (sha256hex(bytes.toString("utf8")) !== digest) {
      fail(result, "CHECKSUM_INVENTORY_HASH_MISMATCH", `hash mismatch for ${name}`);
      return;
    }
  }
}

// Independent case binding: identical arithmetic to the runner's caseDigest
// (question_id, NUL, question, NUL, sessions joined with / unit separators),
// deliberately excluding the stored digest field itself.
function caseDigest(row) {
  const body = row.sessions
    .map((session) =>
      `${session.session_id}\u0000${session.messages.map((m) => `${m.role}\u0000${m.content}`).join("\u0001")}`,
    )
    .join("\u0002");
  return sha256hex(`${row.question_id}\u0000${row.question}\u0000${body}`);
}

function casesProjection(result) {
  const rows = parseJsonL(result.byName.get("cases.jsonl"), result,
    "CASES_PROJECTION_UNPARSEABLE", "cases.jsonl");
  if (rows === undefined) return false;
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    for (const field of CASES_FORBIDDEN_FIELDS) {
      if (field in row) {
        fail(result, "PROJECTION_GOLD_LEAK", `cases row ${index} carries ${field}`);
        return false;
      }
    }
    if (!closedFields(row, PROJECTION_FIELDS)) {
      fail(result, "PROJECTION_UNKNOWN_FIELD", `cases row ${index} has unexpected fields`);
      return false;
    }
    if (
      typeof row.question !== "string" ||
      !Array.isArray(row.sessions) ||
      !row.sessions.every(
        (session) =>
          session !== null &&
          typeof session === "object" &&
          closedFields(session, ["session_id", "messages"]) &&
          Array.isArray(session.messages) &&
          session.messages.every(
            (message) =>
              message !== null &&
              typeof message === "object" &&
              closedFields(message, ["role", "content"]) &&
              typeof message.content === "string",
          ),
      )
    ) {
      fail(result, "PROJECTION_UNKNOWN_FIELD", `cases row ${index} has invalid shape`);
      return false;
    }
    if (seen.has(row.question_id)) {
      fail(result, "CASES_PROJECTION_DUPLICATE", `question_id ${row.question_id} repeated`);
      return false;
    }
    seen.add(row.question_id);
    if (row.caseSha256 !== caseDigest(row)) {
      fail(result, "CASES_PROJECTION_DIGEST_MISMATCH", `case binding failed for ${row.question_id}`);
      return false;
    }
  }
  if (seen.size === 0) {
    fail(result, "CASES_PROJECTION_EMPTY", "cases.jsonl is empty");
    return false;
  }
  result.byQuestion = new Map(rows.map((row) => [row.question_id, row]));
  return true;
}

function treatmentRows(result) {
  const rows = parseJsonL(result.byName.get("treatment.jsonl"), result,
    "TREATMENT_UNPARSEABLE", "treatment.jsonl");
  if (rows === undefined) return false;
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    if (row.state === "ok") {
      if (!closedFields(row, TREATMENT_OK_FIELDS)) {
        fail(result, "TREATMENT_ROW_SCHEMA", `ok treatment row ${index} has unexpected fields`);
        return false;
      }
      const coverage = row.coverage;
      if (coverage === null || typeof coverage !== "object" || !closedFields(coverage, COVERAGE_FIELDS)) {
        fail(result, "TREATMENT_ROW_SCHEMA", `ok treatment row ${index} coverage is unclosed`);
        return false;
      }
      const identity =
        coverage.normalizedInputBytes ===
        coverage.coveredNormalizedBytes + coverage.uncoveredNormalizedBytes;
      if (!identity) {
        fail(result, "COVERAGE_MISMATCH",
          `coverage identity failed for ${row.questionId}`);
        return false;
      }
      if (
        (coverage.complete && coverage.uncoveredNormalizedBytes !== 0) ||
        (!coverage.complete && coverage.uncoveredNormalizedBytes === 0)
      ) {
        fail(result, "COVERAGE_MISMATCH",
          `coverage completeness conflicts with coverage for ${row.questionId}`);
        return false;
      }
      if (
        row.terminalJobs === null ||
        typeof row.terminalJobs !== "object" ||
        !closedFields(row.terminalJobs, TERMINAL_FIELDS)
      ) {
        fail(result, "TREATMENT_ROW_SCHEMA", `ok treatment row ${index} terminalJobs is unclosed`);
        return false;
      }
      const terminal =
        row.terminalJobs.pending === 0 &&
        row.terminalJobs.running === 0 &&
        row.terminalJobs.retryable === 0 &&
        row.terminalJobs.permanentFailure === 0 &&
        row.terminalJobs.cancelled === 0 &&
        row.terminalJobs.outstandingLeases === 0;
      if (!terminal) {
        fail(result, "JOB_COVERAGE_MISMATCH", `pending jobs reported for ${row.questionId}`);
        return false;
      }
      if (typeof row.limit !== "number" || !Array.isArray(row.queries) ||
          typeof row.recordCount !== "number" || typeof row.featureCount !== "number") {
        fail(result, "TREATMENT_ROW_SCHEMA", `ok treatment row ${index} has invalid typed fields`);
        return false;
      }
    } else if (row.state === "failed") {
      if (!closedFields(row, TREATMENT_FAILED_FIELDS)) {
        fail(result, "TREATMENT_ROW_SCHEMA", `failed treatment row ${index} is unclosed`);
        return false;
      }
      const failure = row.failure;
      if (
        failure === null || typeof failure !== "object" ||
        !["limit-failure", "coverage-failure", "job-failure", "permanent-error"]
          .includes(failure.kind) ||
        typeof failure.reason !== "string"
      ) {
        fail(result, "TREATMENT_ROW_SCHEMA", `failed treatment row ${index} failure is unclosed`);
        return false;
      }
    } else {
      fail(result, "TREATMENT_ROW_SCHEMA", `treatment row ${index} has invalid state ${String(row.state)}`);
      return false;
    }
    if (seen.has(row.questionId)) {
      fail(result, "TREATMENT_DUPLICATE", `questionId ${row.questionId} repeated`);
      return false;
    }
    seen.add(row.questionId);
  }
  if (seen.size === 0) {
    fail(result, "TREATMENT_EMPTY", "treatment.jsonl is empty");
    return false;
  }
  result.treatment = rows;
  return true;
}

function rankingProvenance(result) {
  const rows = parseJsonL(result.byName.get("product-rankings.jsonl"), result,
    "RANKING_UNPARSEABLE", "product-rankings.jsonl");
  if (rows === undefined) return false;
  const okQuestions = new Set(
    (result.treatment ?? [])
      .filter((row) => row.state === "ok")
      .map((row) => row.questionId),
  );
  const byQuestion = new Map();
  for (const row of rows) {
    if (!byQuestion.has(row.questionId)) byQuestion.set(row.questionId, []);
    byQuestion.get(row.questionId).push(row);
  }
  for (const [questionId, list] of byQuestion) {
    if (!okQuestions.has(questionId)) {
      fail(result, "RANKING_COVERAGE_MISMATCH", `rankings exist for non-ok treatment ${questionId}`);
      return false;
    }
    const caseRow = result.byQuestion.get(questionId);
    if (caseRow === undefined) {
      fail(result, "RANKING_COVERAGE_MISMATCH", `rankings reference unknown question ${questionId}`);
      return false;
    }
    const allowedSessions = new Set(caseRow.sessions.map((session) => session.session_id));
    list.sort((left, right) => left.rank - right.rank);
    for (const [index, row] of list.entries()) {
      if (!closedFields(row, RANKING_FIELDS)) {
        fail(result, "RANKING_COVERAGE_MISMATCH", `ranking row has unexpected fields with rank ${row.rank}`);
        return false;
      }
      if (row.rank !== index + 1) {
        fail(result, "RANKING_COVERAGE_MISMATCH", `rank gap in ${questionId}`);
        return false;
      }
      if (!allowedSessions.has(row.sessionId)) {
        fail(result, "RANKING_COVERAGE_MISMATCH", `session ${row.sessionId} is not from ${questionId}`);
        return false;
      }
      if (row.caseSha256 !== caseRow.caseSha256) {
        fail(result, "RANKING_COVERAGE_MISMATCH", `case binding mismatch for ${questionId}`);
        return false;
      }
    }
  }
  return true;
}

function splitGold(result) {
  const rows = parseJsonL(result.byName.get("split.jsonl"), result,
    "SPLIT_GOLD_UNPARSEABLE", "split.jsonl");
  if (rows === undefined) return false;
  const casesCount = result.byQuestion.size;
  if (rows.length !== casesCount) {
    fail(result, "SPLIT_GOLD_SESSION_MISMATCH",
      `split has ${rows.length} rows, cases has ${casesCount}`);
    return false;
  }
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    if (!closedFields(row, SPLIT_FIELDS)) {
      fail(result, "SPLIT_GOLD_SESSION_MISMATCH", `split row ${index} is unclosed`);
      return false;
    }
    if (seen.has(row.question_id)) {
      fail(result, "SPLIT_GOLD_SESSION_MISMATCH", `split row ${index} repeats question_id`);
      return false;
    }
    seen.add(row.question_id);
    const caseRow = result.byQuestion.get(row.question_id);
    if (caseRow === undefined) {
      fail(result, "SPLIT_GOLD_SESSION_MISMATCH", `split row ${index} references unknown question`);
      return false;
    }
    if (typeof row.question_type !== "string" || (row.split !== 0 && row.split !== 1)) {
      fail(result, "SPLIT_GOLD_SESSION_MISMATCH", `split row ${index} has invalid fields`);
      return false;
    }
    const allowed = new Set(caseRow.sessions.map((session) => session.session_id));
    for (const sessionId of row.goldSessionIds) {
      if (!allowed.has(sessionId)) {
        fail(result, "SPLIT_GOLD_SESSION_MISMATCH",
          `gold session ${sessionId} is outside ${row.question_id}`);
        return false;
      }
    }
  }
  return true;
}

function secretMarker(result) {
  const markerBytes = Buffer.from(SECRET_MARKER, "utf8");
  for (const [name, bytes] of result.byName) {
    if (bytes.includes(markerBytes)) {
      fail(result, "SECRET_MARKER_LEAK", `${name} contains the sentinel marker`);
      return false;
    }
  }
  return true;
}

function manifestIdentity(result) {
  const text = result.byName.get("run-manifest.json").toString("utf8");
  let manifest;
  try {
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
      throw new Error("multi-line manifest");
    }
    manifest = JSON.parse(text.slice(0, -1));
    if (`${canonicalJson(manifest)}\n` !== text) {
      throw new Error("manifest is not canonically encoded");
    }
  } catch (error) {
    fail(result, "MANIFEST_HASH_MISMATCH", `run-manifest.json: ${String(error?.message ?? error)}`);
    return false;
  }
  if (!closedFields(manifest, MANIFEST_FIELDS)) {
    fail(result, "MANIFEST_HASH_MISMATCH", "run-manifest.json has unexpected fields");
    return false;
  }
  const casesSha256 = sha256hex(result.byName.get("cases.jsonl").toString("utf8"));
  if (manifest.casesSha256 !== casesSha256) {
    fail(result, "MANIFEST_HASH_MISMATCH", "manifest casesSha256 does not match cases.jsonl");
    return false;
  }
  const treatmentHash = sha256hex(result.byName.get("treatment.jsonl").toString("utf8"));
  if (manifest.treatmentHash !== treatmentHash) {
    fail(result, "MANIFEST_HASH_MISMATCH", "manifest treatmentHash does not match treatment.jsonl");
    return false;
  }
  const splitSha256 = sha256hex(result.byName.get("split.jsonl").toString("utf8"));
  if (manifest.splitSha256 !== splitSha256) {
    fail(result, "MANIFEST_HASH_MISMATCH", "manifest splitSha256 does not match split.jsonl");
    return false;
  }
  const status = (result.treatment ?? []).every((row) => row.state === "ok") ? "ok" : "failed";
  if (manifest.status !== status) {
    fail(result, "MANIFEST_HASH_MISMATCH", `manifest status ${manifest.status} conflicts with treatment rows`);
    return false;
  }
  const rankingCount = result.byName.get("product-rankings.jsonl").toString("utf8");
  if (manifest.productRows !== (result.treatment ?? []).length) {
    fail(result, "MANIFEST_HASH_MISMATCH", "manifest productRows does not match treatment rows");
    return false;
  }
  void rankingCount;
  if (!/^[0-9a-f]{64}$/.test(manifest.sourceHash)) {
    fail(result, "MANIFEST_HASH_MISMATCH", "manifest sourceHash is not a sha256 hex digest");
    return false;
  }
  if (typeof manifest.runId !== "string" || manifest.runId.length === 0) {
    fail(result, "MANIFEST_HASH_MISMATCH", "manifest runId is missing");
    return false;
  }
  return true;
}

// --- Independent metric recomputation (mirrors analyze.mjs byte-for-byte) ---

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

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function pairedBootstrapLower95(orderedDifferences) {
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

/** Recomputes the analyzer output fields from treatment/split/reference bytes. */
function recomputeAnalysis(result, referencePath, cutoff = 10) {
  if (referencePath === undefined) {
    fail(result, "ANALYSIS_METRIC_MISMATCH", "verifier requires --reference for metric recomputation");
    return undefined;
  }
  const referenceRows = parseJsonL(readFileSync(referencePath), result,
    "ANALYSIS_METRIC_MISMATCH", "reference rankings");
  if (referenceRows === undefined) return undefined;
  const splitRows = parseJsonL(result.byName.get("split.jsonl"), result,
    "ANALYSIS_METRIC_MISMATCH", "split.jsonl");
  if (splitRows === undefined) return undefined;
  const ranked = parseJsonL(result.byName.get("product-rankings.jsonl"), result,
    "ANALYSIS_METRIC_MISMATCH", "product-rankings.jsonl");
  if (ranked === undefined) return undefined;

  const goldByQuestion = new Map();
  const typeByQuestion = new Map();
  for (const row of splitRows) {
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

  for (const row of result.treatment ?? []) {
    const gold = goldByQuestion.get(row.questionId) ?? new Set();
    const productRows = productByQuestion.get(row.questionId) ?? [];
    const referenceRowsFor = referenceByQuestion.get(row.questionId) ?? [];
    const productSessions = productRows.map((r) => r.sessionId);
    const referenceSessions = referenceRowsFor.map((r) => r.sessionId);
    duplicity.push(productSessions.length - new Set(productSessions).size);
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
    hitDeltas.push(metrics.hit - referenceMetricsFor.hit);
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

  const missForbidden = -0.02;
  const ndcgGate = pairedBootstrapLower95(ndcgDeltas) >= missForbidden;
  const recallGate = pairedBootstrapLower95(recallDeltas) >= missForbidden;
  const kuDifference = kuError("reference") - kuError("product");
  const knowledgeGate = kuDifference <= 0.02;
  const coverageTerminalGate = allCoverageComplete && allJobsTerminal && !typedFailurePresent;
  const metricGateFailures = [ndcgGate, recallGate, knowledgeGate, coverageTerminalGate]
    .filter((passed) => !passed).length;

  return {
    classification: metricGateFailures > 0 ? "rejected" : "supported",
    metricGates: [
      { gate: "ndcg10-lower95", passed: ndcgGate },
      { gate: "recall10-lower95", passed: recallGate },
      { gate: "knowledge-update-error", passed: knowledgeGate },
      { gate: "coverage-terminal", passed: coverageTerminalGate },
    ],
    primaryMetrics: {
      ndcg10: {
        product: aggregation(productMetrics.map((m) => m.ndcg)),
        reference: aggregation(referenceMetrics.map((m) => m.ndcg)),
        delta: aggregation(ndcgDeltas),
        lower95: pairedBootstrapLower95(ndcgDeltas),
      },
      recall10: {
        product: aggregation(productMetrics.map((m) => m.recall)),
        reference: aggregation(referenceMetrics.map((m) => m.recall)),
        delta: aggregation(recallDeltas),
        lower95: pairedBootstrapLower95(recallDeltas),
      },
      hit10: {
        product: aggregation(productMetrics.map((m) => m.hit)),
        reference: aggregation(referenceMetrics.map((m) => m.hit)),
        delta: aggregation(hitDeltas),
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
  };
}

function analysisComparison(result, referencePath) {
  const expected = recomputeAnalysis(result, referencePath);
  if (expected === undefined) return false;
  let persisted;
  try {
    persisted = JSON.parse(result.byName.get("analyse.json").toString("utf8"));
  } catch (error) {
    fail(result, "ANALYSIS_METRIC_MISMATCH", `analyse.json: ${String(error?.message ?? error)}`);
    return false;
  }
  if (persisted.classification !== expected.classification) {
    fail(result, "ANALYSIS_METRIC_MISMATCH", "analyse.json classification does not match recomputation");
    return false;
  }
  const persistedGates = (persisted.decisionGates ?? []).filter((g) => g.gate !== "structural-validation");
  if (canonicalJson(persistedGates) !== canonicalJson(expected.metricGates)) {
    fail(result, "ANALYSIS_METRIC_MISMATCH", "analyse.json decision gates do not match recomputation");
    return false;
  }
  for (const key of ["primaryMetrics", "diceScore", "errorRates", "duplicateOccupancy", "discordantCases"]) {
    if (canonicalJson(persisted[key]) !== canonicalJson(expected[key])) {
      fail(result, "ANALYSIS_METRIC_MISMATCH", `analyse.json ${key} does not match recomputation`);
      return false;
    }
  }
  return true;
}

export const EXPECTED_MUTATIONS = Object.freeze([
  { mutationId: "projection-forbidden-field", expectedCode: "PROJECTION_UNKNOWN_FIELD" },
  { mutationId: "projection-gold-leak", expectedCode: "PROJECTION_GOLD_LEAK" },
  { mutationId: "split-gold-session-forged", expectedCode: "SPLIT_GOLD_SESSION_MISMATCH" },
  { mutationId: "ranking-row-removed", expectedCode: "RANKING_COVERAGE_MISMATCH" },
  { mutationId: "treatment-coverage-forged", expectedCode: "COVERAGE_MISMATCH" },
  { mutationId: "analysis-metrics-forged", expectedCode: "ANALYSIS_METRIC_MISMATCH" },
  { mutationId: "checksum-entry-removed", expectedCode: "CHECKSUM_INVENTORY_SET_MISMATCH" },
  { mutationId: "secret-marker-injected", expectedCode: "SECRET_MARKER_LEAK" },
]);

function analysisAttestation(result) {
  let persisted;
  try {
    persisted = JSON.parse(result.byName.get("analyse.json").toString("utf8"));
  } catch (error) {
    fail(result, "ANALYSIS_METRIC_MISMATCH", `analyse.json: ${String(error?.message ?? error)}`);
    return false;
  }
  const structural = (persisted.decisionGates ?? []).find((g) => g.gate === "structural-validation");
  if (structural === undefined || structural.passed !== true) {
    fail(result, "ANALYSIS_METRIC_MISMATCH", "attested analyse.json must pass structural-validation");
    return false;
  }
  if (persisted.mutationRejected !== true) {
    fail(result, "ANALYSIS_METRIC_MISMATCH", "attested analyse.json must record mutationRejected true");
    return false;
  }
  const verdict = persisted.verdict;
  if (verdict === null || typeof verdict !== "object" ||
      verdict.valid !== true || verdict.classification !== persisted.classification ||
      verdict.allRejected !== true || verdict.mutationCount !== EXPECTED_MUTATIONS.length) {
    fail(result, "ANALYSIS_METRIC_MISMATCH", "attested analyse.json verdict is inconsistent");
    return false;
  }
  return true;
}

function mutationSummary(result) {
  let summary;
  try {
    summary = JSON.parse(result.byName.get("mutation-summary.json").toString("utf8"));
  } catch (error) {
    fail(result, "ANALYSIS_METRIC_MISMATCH", `mutation-summary.json: ${String(error?.message ?? error)}`);
    return false;
  }
  if (summary.allRejected !== true || summary.mutationCount !== EXPECTED_MUTATIONS.length) {
    fail(result, "ANALYSIS_METRIC_MISMATCH", "mutation summary does not reject every mutation");
    return false;
  }
  const entries = summary.entries;
  if (!Array.isArray(entries) || entries.length !== EXPECTED_MUTATIONS.length) {
    fail(result, "ANALYSIS_METRIC_MISMATCH", "mutation summary entries are incomplete");
    return false;
  }
  for (const expected of EXPECTED_MUTATIONS) {
    const entry = entries.find((row) => row.mutationId === expected.mutationId);
    if (entry === undefined || entry.rejected !== true || entry.code !== expected.expectedCode) {
      fail(result, "ANALYSIS_METRIC_MISMATCH",
        `mutation ${expected.mutationId} was not rejected with ${expected.expectedCode}`);
      return false;
    }
  }
  return true;
}

/**
 * Verifies a run bundle from persisted bytes. `validateChecksum` enforces the
 * exact checksum inventory; `validateAttestations` additionally requires the
 * final analysis verdict and mutation summary. Mutation snapshots run with
 * `validateAttestations: false` (pre-finalize bundles have neither).
 */
function verifyCoreSteps(
  directory,
  { validateChecksum = true, validateAttestations = true, referencePath } = {},
) {
  const result = { valid: true };
  artifactFiles(directory, result, validateAttestations);
  if (!result.valid) return result;
  if (validateChecksum) checksumInventory(directory, result, validateAttestations);
  if (!result.valid) return result;
  casesProjection(result);
  if (!result.valid) return result;
  treatmentRows(result);
  if (!result.valid) return result;
  rankingProvenance(result);
  if (!result.valid) return result;
  splitGold(result);
  if (!result.valid) return result;
  secretMarker(result);
  if (!result.valid) return result;
  analysisComparison(result, referencePath);
  if (!result.valid) return result;
  manifestIdentity(result);
  if (!result.valid) return result;
  if (validateAttestations && result.valid) {
    analysisAttestation(result);
    if (result.valid) mutationSummary(result);
  }
  return result;
}

export function verifyCore(directory, options = {}) {
  const result = verifyCoreSteps(directory, options);
  const outcome = { valid: result.valid };
  if (result.code !== undefined) outcome.code = result.code;
  if (result.message !== undefined) outcome.message = result.message;
  return outcome;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const runDirectory = args[0];
  const referenceIndex = args.indexOf("--reference");
  const referencePath = referenceIndex >= 0 ? args[referenceIndex + 1] : undefined;
  const noAttest = args.includes("--no-attest");
  if (runDirectory === undefined || referencePath === undefined) {
    console.error("usage: verify.mjs <run-directory> --reference <reference-rankings> [--no-attest]");
    process.exitCode = 1;
  } else {
    const outcome = verifyCore(resolve(runDirectory), {
      referencePath: resolve(referencePath),
      validateAttestations: !noAttest,
    });
    process.stdout.write(`${canonicalJson(outcome)}\n`);
    if (!outcome.valid) process.exitCode = 1;
  }
}


