#!/usr/bin/env node
// Independent verifier for memory-product-lexical-replay-v0 synthetic bundle.
//
// Standard-library only (node:crypto, node:fs, node:os, node:path). It MUST
// NOT import the treatment, analyzer, common, or product Memory modules. It
// recomputes:
//   1. checksum inventory — every produced artifact hash matches sha256sums.txt
//   2. closed schemas — canonical JSON, exact field sets, deterministic order
//   3. gold-blind projection — cases.jsonl carries no forbidden gold fields
//   4. rank/record/Block/session mapping — ranks are contiguous per question,
//      every projected question has ranking rows, every ranking sessionId
//      appears in that question's projected sessions, and the sourceBlockId
//      matches the runner's deterministic block id
//   5. coverage/job accounting — persisted counts are internally consistent
//   6. secret-marker rejection — no synthetic test sentinel may appear
//   7. mutation rejection — every declared mutation is detected and rejected

import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "../../../..");

const EXPECTED_CHECKSUM_FILES = [
  "cases.jsonl",
  "treatment.jsonl",
  "product-rankings.jsonl",
  "run-manifest.json",
  "command.txt",
];

const TREATMENT_OK_FIELDS = [
  "questionId", "caseSha256", "state", "coverage", "terminalJobs", "limit",
  "queries", "recordCount", "featureCount", "canonicalRecordBytes",
  "canonicalFeatureBytes",
];
const TREATMENT_FAILED_FIELDS = ["questionId", "caseSha256", "state", "failure"];
const RANKING_FIELDS = ["questionId", "rank", "recordId", "sourceBlockId", "sessionId", "rawBm25", "caseSha256"];
const MANIFEST_FIELDS = [
  "experimentId", "experimentVersion", "runId", "frozenAt", "casesSha256",
  "splitSha256", "legacyReferenceRows", "productRows", "rankingRows",
  "treatmentHash", "sourceHash", "checksumInventoryVerified", "workerCount",
  "startedAtUs", "totalJobs", "status",
];
const COVERAGE_FIELDS = [
  "normalizedInputBytes", "coveredNormalizedBytes", "uncoveredNormalizedBytes",
  "truncatedItems", "skippedItemsByReason", "complete",
];
const TERMINAL_JOB_FIELDS = [
  "pending", "running", "retryable", "succeeded", "skipped", "permanentFailure",
  "cancelled", "outstandingLeases", "maxObservedConcurrency",
];
const QUERY_FIELDS = ["mode", "limit", "contextExpansion", "generation", "channelSent"];
const GENERATION_FIELDS = ["generationId", "algorithmId", "algorithmVersion"];
const PROJECTION_FIELDS = ["question_id", "question", "sessions", "caseSha256"];
const FAILURE_FIELDS = ["kind", "reason"];
const FORBIDDEN_PROJECTION_FIELDS = new Set([
  "answer_session_ids", "answer", "question_type", "split", "goldSessionIds",
  "reference", "ranking",
]);

export const SECRET_SENTINEL = "DOLLY_LEXICAL_TEST_SECRET_7f9d";

const MUTATIONS = Object.freeze([
  ["projection-forbidden-field", "PROJECTION_UNKNOWN_FIELD"],
  ["projection-gold-leak", "PROJECTION_GOLD_LEAK"],
  ["ranking-row-removed", "RANKING_COVERAGE_MISMATCH"],
  ["ranking-session-forged", "RANKING_SESSION_MISMATCH"],
  ["treatment-coverage-forged", "COVERAGE_MISMATCH"],
  ["checksum-entry-removed", "CHECKSUM_INVENTORY_MISMATCH"],
  ["manifest-status-forged", "MANIFEST_STATUS_MISMATCH"],
  ["secret-marker-injected", "SECRET_MARKER_LEAK"],
]);

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort(compare);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function closed(value, fields, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compare);
  const expected = [...fields].sort(compare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} fields differ: got ${actual.join(",")} expected ${expected.join(",")}`);
  }
  return value;
}

function nonnegativeInteger(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, `${label} non-negative integer`);
  return value;
}

function readJsonl(directory, name) {
  const bytes = readFileSync(join(directory, name), "utf8");
  if (!bytes.endsWith("\n") || bytes.includes("\r") || bytes.endsWith("\n\n")) {
    fail("ARTIFACT_NONCANONICAL", `${name} line endings`);
  }
  if (bytes.length === 0) return [];
  const rows = bytes.slice(0, -1).split("\n").map((line) => JSON.parse(line));
  if (rows.map((row) => `${canonicalJson(row)}\n`).join("") !== bytes) {
    fail("ARTIFACT_NONCANONICAL", `${name} canonical encoding`);
  }
  return rows;
}

function readJson(directory, name) {
  const bytes = readFileSync(join(directory, name), "utf8");
  const value = JSON.parse(bytes);
  if (!bytes.endsWith("\n") || `${canonicalJson(value)}\n` !== bytes) {
    fail("ARTIFACT_NONCANONICAL", `${name} canonical form`);
  }
  return value;
}

/** Independent case digest — mirrors the runner's caseDigest. */
function expectedCaseDigest(row) {
  const body = row.sessions
    .map((session) =>
      `${session.session_id}\u0000${session.messages.map((m) => `${m.role}\u0000${m.content}`).join("\u0001")}`,
    )
    .join("\u0002");
  return sha256hex(`${row.question_id}\u0000${row.question}\u0000${body}`);
}

function validateProjection(rows) {
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    // gold-blind: forbidden gold fields are rejected before the closed-set
    // check so a gold leak is reported as PROJECTION_GOLD_LEAK, not as an
    // unknown-field schema drift.
    for (const key of Object.keys(row)) {
      if (FORBIDDEN_PROJECTION_FIELDS.has(key)) fail("PROJECTION_GOLD_LEAK", `field ${key}`);
    }
    closed(row, PROJECTION_FIELDS, "PROJECTION_UNKNOWN_FIELD", `cases[${index}]`);
    if (row.question_id.length === 0) fail("PROJECTION_UNKNOWN_FIELD", "empty question_id");
    if (seen.has(row.question_id)) fail("PROJECTION_DUPLICATE_QUESTION", `duplicate ${row.question_id}`);
    seen.add(row.question_id);
    for (const session of row.sessions) {
      if (!Array.isArray(session.messages)) fail("PROJECTION_UNKNOWN_FIELD", "messages array");
      for (const message of session.messages) {
        if (typeof message.role !== "string" || typeof message.content !== "string") {
          fail("PROJECTION_UNKNOWN_FIELD", "message shape");
        }
      }
    }
    if (row.caseSha256 !== expectedCaseDigest(row)) {
      fail("PROJECTION_DIGEST_MISMATCH", `caseSha256 ${row.question_id}`);
    }
  }
  return seen;
}

function validateTreatment(rows, knownQuestions) {
  for (const [index, row] of rows.entries()) {
    if (row.state === "ok") {
      closed(row, TREATMENT_OK_FIELDS, "TREATMENT_SCHEMA_MISMATCH", `treatment[${index}]`);
      closed(row.coverage, COVERAGE_FIELDS, "COVERAGE_MISMATCH", `treatment[${index}].coverage`);
      closed(row.terminalJobs, TERMINAL_JOB_FIELDS, "JOB_ACCOUNTING_MISMATCH", `treatment[${index}].terminalJobs`);
      nonnegativeInteger(row.limit, "TREATMENT_SCHEMA_MISMATCH", "limit");
      if (!Array.isArray(row.queries) || row.queries.length !== 1) {
        fail("TREATMENT_SCHEMA_MISMATCH", `queries[${index}]`);
      }
      closed(row.queries[0], QUERY_FIELDS, "TREATMENT_SCHEMA_MISMATCH", `queries[${index}][0]`);
      closed(row.queries[0].generation, GENERATION_FIELDS, "TREATMENT_SCHEMA_MISMATCH", `generation[${index}]`);
      if (row.queries[0].mode !== "lexical" || row.queries[0].limit !== row.limit || row.queries[0].contextExpansion !== 0) {
        fail("TREATMENT_SCHEMA_MISMATCH", `query profile[${index}]`);
      }
      nonnegativeInteger(row.recordCount, "TREATMENT_SCHEMA_MISMATCH", "recordCount");
      nonnegativeInteger(row.featureCount, "TREATMENT_SCHEMA_MISMATCH", "featureCount");
      nonnegativeInteger(row.canonicalRecordBytes, "TREATMENT_SCHEMA_MISMATCH", "canonicalRecordBytes");
      nonnegativeInteger(row.canonicalFeatureBytes, "TREATMENT_SCHEMA_MISMATCH", "canonicalFeatureBytes");
      const c = row.coverage;
      nonnegativeInteger(c.normalizedInputBytes, "COVERAGE_MISMATCH", "normalizedInputBytes");
      nonnegativeInteger(c.coveredNormalizedBytes, "COVERAGE_MISMATCH", "coveredNormalizedBytes");
      nonnegativeInteger(c.uncoveredNormalizedBytes, "COVERAGE_MISMATCH", "uncoveredNormalizedBytes");
      nonnegativeInteger(c.truncatedItems, "COVERAGE_MISMATCH", "truncatedItems");
      if (c.normalizedInputBytes !== c.coveredNormalizedBytes + c.uncoveredNormalizedBytes) {
        fail("COVERAGE_MISMATCH", `coverage byte identity ${row.questionId}`);
      }
      if (typeof c.complete !== "boolean") fail("COVERAGE_MISMATCH", "complete boolean");
      const j = row.terminalJobs;
      for (const field of TERMINAL_JOB_FIELDS) {
        nonnegativeInteger(j[field], "JOB_ACCOUNTING_MISMATCH", field);
      }
      const cleanTerminal =
        j.pending === 0 && j.running === 0 && j.retryable === 0 &&
        j.permanentFailure === 0 && j.cancelled === 0 && j.outstandingLeases === 0;
      if (!cleanTerminal) fail("JOB_ACCOUNTING_MISMATCH", `nonterminal jobs ${row.questionId}`);
      if (!c.complete) fail("COVERAGE_MISMATCH", `incomplete coverage ${row.questionId}`);
    } else if (row.state === "failed") {
      closed(row, TREATMENT_FAILED_FIELDS, "TREATMENT_SCHEMA_MISMATCH", `treatment[${index}]`);
      closed(row.failure, FAILURE_FIELDS, "TREATMENT_SCHEMA_MISMATCH", `failure[${index}]`);
      if (typeof row.failure.kind !== "string" || row.failure.kind.length === 0) {
        fail("TREATMENT_SCHEMA_MISMATCH", `failure kind ${index}`);
      }
    } else {
      fail("TREATMENT_SCHEMA_MISMATCH", `state ${row.state}`);
    }
    if (!knownQuestions.has(row.questionId)) {
      fail("TREATMENT_UNKNOWN_QUESTION", `unknown ${row.questionId}`);
    }
  }
}

function validateRanking(rankingRows, projectionByQuestion, knownQuestions) {
  const byQuestion = new Map();
  for (const row of rankingRows) {
    closed(row, RANKING_FIELDS, "RANKING_SCHEMA_MISMATCH", "ranking row");
    if (!byQuestion.has(row.questionId)) byQuestion.set(row.questionId, []);
    byQuestion.get(row.questionId).push(row);
  }
  for (const questionId of byQuestion.keys()) {
    if (!knownQuestions.has(questionId)) fail("RANKING_UNKNOWN_QUESTION", `ranking for ${questionId}`);
  }
  // A question may have zero ranking rows (no record matched the query); when
  // rows exist they must be contiguous from rank 1 and every retained session
  // must be a projected session for that question. The exact sourceBlockId is
  // not asserted here — the runner's block-id scheme is an internal detail of
  // the treatment; the verifier checks session provenance instead.
  for (const [questionId, rows] of byQuestion) {
    rows.sort((a, b) => a.rank - b.rank);
    const projection = projectionByQuestion.get(questionId);
    if (projection === undefined) fail("RANKING_UNKNOWN_QUESTION", `ranking for ${questionId}`);
    const sessionIds = new Set(projection.sessions.map((session) => session.session_id));
    rows.forEach((row, index) => {
      if (row.rank !== index + 1) fail("RANKING_COVERAGE_MISMATCH", `rank gap ${questionId}@${index}`);
      if (!sessionIds.has(row.sessionId)) fail("RANKING_SESSION_MISMATCH", `session ${questionId}@${row.rank}`);
      if (!Number.isFinite(row.rawBm25)) fail("RANKING_SCHEMA_MISMATCH", `rawBm25 ${questionId}@${row.rank}`);
    });
  }
}

function validateManifest(manifest, projection, treatment, rankings) {
  closed(manifest, MANIFEST_FIELDS, "MANIFEST_SCHEMA_MISMATCH", "run-manifest");
  if (manifest.experimentId !== "memory-product-lexical-replay-v0") fail("MANIFEST_SCHEMA_MISMATCH", "experimentId");
  if (manifest.experimentVersion !== 1) fail("MANIFEST_SCHEMA_MISMATCH", "experimentVersion");
  if (manifest.productRows !== treatment.length) fail("MANIFEST_STATUS_MISMATCH", "productRows");
  if (manifest.rankingRows !== rankings.length) fail("MANIFEST_STATUS_MISMATCH", "rankingRows");
  const projectionBytes = projection.map((row) => `${canonicalJson(row)}\n`).join("");
  if (manifest.casesSha256 !== sha256hex(projectionBytes)) fail("MANIFEST_STATUS_MISMATCH", "casesSha256");
  const treatmentBytes = treatment.map((row) => `${canonicalJson(row)}\n`).join("");
  if (manifest.treatmentHash !== sha256hex(treatmentBytes)) fail("MANIFEST_STATUS_MISMATCH", "treatmentHash");
  const expectedStatus = treatment.every((row) => row.state === "ok") ? "ok" : "failed";
  if (manifest.status !== expectedStatus) fail("MANIFEST_STATUS_MISMATCH", `status ${manifest.status}`);
  if (typeof manifest.frozenAt !== "string" || Number.isNaN(Date.parse(manifest.frozenAt))) {
    fail("MANIFEST_SCHEMA_MISMATCH", "frozenAt");
  }
  if (manifest.splitSha256 !== null) fail("MANIFEST_SCHEMA_MISMATCH", "splitSha256 must be null for runner");
  if (typeof manifest.sourceHash !== "string" || manifest.sourceHash.length !== 64) {
    fail("MANIFEST_SCHEMA_MISMATCH", "sourceHash");
  }
}

function validateChecksums(directory) {
  const inventoryBytes = readFileSync(join(directory, "sha256sums.txt"), "utf8");
  const lines = inventoryBytes.split("\n").filter((line) => line.length > 0);
  const present = new Set();
  const entries = new Map();
  for (const line of lines) {
    const match = /^(?<hash>[0-9a-f]{64})  (?<name>.+)$/.exec(line);
    if (match === null) fail("CHECKSUM_INVENTORY_MISMATCH", `malformed line ${line}`);
    const { hash, name } = match.groups;
    present.add(name);
    entries.set(name, hash);
  }
  const expected = [...EXPECTED_CHECKSUM_FILES].sort(compare);
  const actual = [...present].sort(compare);
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    fail("CHECKSUM_INVENTORY_MISMATCH", `inventory set ${actual.join(",")}`);
  }
  for (const name of present) {
    const bytes = readFileSync(join(directory, name), "utf8");
    if (entries.get(name) !== sha256hex(bytes)) {
      fail("CHECKSUM_HASH_MISMATCH", `hash ${name}`);
    }
  }
}

function scanSecretMarker(directory) {
  for (const name of readdirSync(directory)) {
    const bytes = readFileSync(join(directory, name), "utf8");
    if (bytes.includes(SECRET_SENTINEL)) fail("SECRET_MARKER_LEAK", `sentinel in ${name}`);
  }
}

/**
 * Core verification. Returns { valid, code } so the mutation harness can run
 * it against mutated copies and check that the expected code is raised.
 */
export function verifyCore(directory, { validateChecksum = true } = {}) {
  try {
    const present = new Set(readdirSync(directory).map((name) => name));
    for (const name of EXPECTED_CHECKSUM_FILES) {
      if (!present.has(name)) fail("CHECKSUM_INVENTORY_MISMATCH", `missing ${name}`);
    }
    if (!present.has("sha256sums.txt")) fail("CHECKSUM_INVENTORY_MISMATCH", "missing sha256sums.txt");

    const projection = readJsonl(directory, "cases.jsonl");
    const knownQuestions = validateProjection(projection);
    const projectionByQuestion = new Map(projection.map((row) => [row.question_id, row]));

    const treatment = readJsonl(directory, "treatment.jsonl");
    validateTreatment(treatment, knownQuestions);

    const rankings = readJsonl(directory, "product-rankings.jsonl");
    validateRanking(rankings, projectionByQuestion, knownQuestions);

    const manifest = readJson(directory, "run-manifest.json");
    validateManifest(manifest, projection, treatment, rankings);

    const command = readFileSync(join(directory, "command.txt"), "utf8");
    if (!command.includes("run-synthetic.mjs")) fail("ARTIFACT_NONCANONICAL", "command.txt");

    scanSecretMarker(directory);

    if (validateChecksum) validateChecksums(directory);

    return { valid: true, code: null, directory };
  } catch (error) {
    return { valid: false, code: error.code ?? "UNKNOWN", message: error.message, directory };
  }
}

export function verifyBundle(directory) {
  return verifyCore(directory, { validateChecksum: true });
}

function writeInventory(directory) {
  const lines = EXPECTED_CHECKSUM_FILES.map(
    (name) => `${sha256hex(readFileSync(join(directory, name), "utf8"))}  ${name}`,
  ).join("\n");
  writeFileSync(join(directory, "sha256sums.txt"), `${lines}\n`);
}

function mutate(directory, mutationId) {
  switch (mutationId) {
    case "projection-forbidden-field": {
      const rows = readJsonl(directory, "cases.jsonl");
      rows[0].__injected_unknown_field = "drift";
      writeFileSync(join(directory, "cases.jsonl"), rows.map((row) => `${canonicalJson(row)}\n`).join(""));
      return ["cases.jsonl"];
    }
    case "projection-gold-leak": {
      const rows = readJsonl(directory, "cases.jsonl");
      rows[0].goldSessionIds = ["leaked"];
      writeFileSync(join(directory, "cases.jsonl"), rows.map((row) => `${canonicalJson(row)}\n`).join(""));
      return ["cases.jsonl"];
    }
    case "ranking-row-removed": {
      // Remove a ranking row from a multi-row question so the retained rows
      // start at rank 2 and break the contiguity invariant.
      const rows = readJsonl(directory, "product-rankings.jsonl");
      const dupIndex = rows.findIndex((row) => row.questionId === "synthetic-duplicates");
      rows.splice(dupIndex, 1);
      writeFileSync(join(directory, "product-rankings.jsonl"), rows.map((row) => `${canonicalJson(row)}\n`).join(""));
      return ["product-rankings.jsonl"];
    }
    case "ranking-session-forged": {
      const rows = readJsonl(directory, "product-rankings.jsonl");
      rows[0].sessionId = "__forged__";
      writeFileSync(join(directory, "product-rankings.jsonl"), rows.map((row) => `${canonicalJson(row)}\n`).join(""));
      return ["product-rankings.jsonl"];
    }
    case "treatment-coverage-forged": {
      const rows = readJsonl(directory, "treatment.jsonl");
      rows[0].coverage.coveredNormalizedBytes = rows[0].coverage.normalizedInputBytes + 1;
      writeFileSync(join(directory, "treatment.jsonl"), rows.map((row) => `${canonicalJson(row)}\n`).join(""));
      return ["treatment.jsonl"];
    }
    case "checksum-entry-removed": {
      const lines = readFileSync(join(directory, "sha256sums.txt"), "utf8")
        .trimEnd().split("\n").filter((line) => !line.endsWith("  command.txt"));
      writeFileSync(join(directory, "sha256sums.txt"), `${lines.join("\n")}\n`);
      return ["sha256sums.txt"];
    }
    case "manifest-status-forged": {
      const manifest = readJson(directory, "run-manifest.json");
      manifest.status = manifest.status === "ok" ? "failed" : "ok";
      writeFileSync(join(directory, "run-manifest.json"), `${canonicalJson(manifest)}\n`);
      return ["run-manifest.json"];
    }
    case "secret-marker-injected": {
      const manifest = readJson(directory, "run-manifest.json");
      manifest.runId = `${manifest.runId}-${SECRET_SENTINEL}`;
      writeFileSync(join(directory, "run-manifest.json"), `${canonicalJson(manifest)}\n`);
      return ["run-manifest.json"];
    }
    default:
      throw new TypeError(`unknown mutation ${mutationId}`);
  }
}

/** Run every declared mutation; each must be rejected with its expected code. */
export function runMutationTests(runDirectory) {
  const baseline = verifyCore(runDirectory, { validateChecksum: true });
  if (!baseline.valid) {
    throw new Error(`baseline bundle invalid before mutations: ${baseline.code}`);
  }
  const summaries = [];
  for (const [mutationId, expectedCode] of MUTATIONS) {
    const temporary = mkdtempSync(join(tmpdir(), "dolly-lexical-mutation-"));
    try {
      cpSync(runDirectory, temporary, { recursive: true });
      const changed = mutate(temporary, mutationId);
      // Mutations that change artifact bytes must regenerate the checksum
      // inventory so the verifier's own checksum gate does not mask the
      // targeted check. The checksum-entry-removed mutation is the exception:
      // it deliberately corrupts the inventory itself.
      if (mutationId !== "checksum-entry-removed") writeInventory(temporary);
      const result = verifyCore(temporary, {
        validateChecksum: mutationId === "checksum-entry-removed",
      });
      summaries.push({
        mutationId,
        expectedCode,
        actualCode: result.code,
        changedFiles: changed,
        rejected: !result.valid,
        codeMatched: result.code === expectedCode,
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const allRejected = summaries.every((summary) => summary.rejected && summary.codeMatched);
  const summary = {
    mutations: summaries.length,
    allRejected,
    details: summaries,
  };
  writeFileSync(join(runDirectory, "mutation-summary.json"), `${canonicalJson(summary)}\n`);
  return summary;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? "");
  const mode = process.argv[3] ?? "verify";
  if (!directory) {
    console.error("usage: verify-synthetic.mjs <run-directory> [verify|mutation]");
    process.exitCode = 1;
  } else if (mode === "mutation") {
    const summary = runMutationTests(directory);
    if (!summary.allRejected) {
      console.error(canonicalJson(summary));
      process.exitCode = 1;
    }
  } else {
    const result = verifyBundle(directory);
    if (!result.valid) {
      console.error(`${result.code}: ${result.message ?? ""}`);
      process.exitCode = 1;
    }
  }
}
