#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../../..");
const DATASET_PATH = "test/memory-data/benchmarks/conversation-memory/longmemeval/longmemeval_s";
const DATASET_SHA256 = "08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894";
const CONDITIONS = ["content", "recurrence-no-position", "repeated-adjacent-position", "shuffled-position"];
const ASSOCIATION_WEIGHTS = [0.25, 0.5, 1, 2];
const EXPECTED_CHECKSUM_FILES = [
  "run-freeze.json", "preregistration.json", "split.jsonl", "cases.jsonl",
  "development-rankings.jsonl", "selected-weights.json", "evaluation-rankings.jsonl",
  "analysis.json", "run-manifest.json", "validation.json", "mutation-validation.json",
];
const EXPECTED_COMPLETE_FILES = [...EXPECTED_CHECKSUM_FILES, "sha256sums.txt"].sort(codeUnitCompare);
const EXPECTED_SOURCE_FILES = [
  "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0-protocol.md",
  "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0.json",
  "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0-schema.json",
  "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0-artifacts.md",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/common.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/treatment.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/treatment-worker.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/run.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/verify.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/verify-worker.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/run-mutation-tests.mjs",
];
const EXPECTED_VALIDATION_CHECKS = [
  "source-freeze", "dataset", "projection", "split", "rankings", "selector",
  "analysis", "manifest", "mutations", "checksum",
];
const EXPECTED_MUTATIONS = [
  ["gold-session-swap", "SPLIT_GOLD_SOURCE_MISMATCH", "split.jsonl"],
  ["projection-forbidden-field", "PROJECTION_UNKNOWN_FIELD", "cases.jsonl"],
  ["projection-message-order", "PROJECTION_SOURCE_MISMATCH", "cases.jsonl"],
  ["ranking-row-removed", "EVALUATION_RANKING_COVERAGE_MISMATCH", "evaluation-rankings.jsonl"],
  ["selected-weight-wrong-grid-member", "SELECTED_WEIGHT_MISMATCH", "selected-weights.json"],
  ["analysis-ndcg-forged", "ANALYSIS_METRIC_MISMATCH", "analysis.json"],
  ["checksum-entry-removed", "CHECKSUM_INVENTORY_SET_MISMATCH", "sha256sums.txt"],
  ["secret-marker-injected", "SECRET_MARKER_LEAK", "run-manifest.json"],
];
const SECRET_SENTINEL = "DOLLY_RETRIEVAL_TEST_SECRET_7f9d";
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "i",
  "in", "is", "it", "my", "of", "on", "or", "that", "the", "this", "to", "was", "were",
  "what", "when", "where", "which", "who", "why", "with", "you", "your",
]);
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

function codeUnitCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort(codeUnitCompare).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function closed(value, fields, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be object`);
  const actual = Object.keys(value).sort(codeUnitCompare); const expected = [...fields].sort(codeUnitCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code, `${label} fields differ`);
  return value;
}
function string(value, code, label, empty = false) {
  if (typeof value !== "string" || (!empty && value.length === 0) || value.includes("\0")) fail(code, `${label} invalid`);
  return value;
}
function finite(value, code, label) { if (!Number.isFinite(value) || Object.is(value, -0)) fail(code, `${label} non-finite`); return value; }
function nonnegative(value, code, label) { finite(value, code, label); if (value < 0) fail(code, `${label} negative`); return value; }
function isoInstant(value, code, label) {
  if (typeof value !== "string") fail(code, `${label} must be string`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(code, `${label} invalid`);
  return parsed.getTime();
}
function canonicalJson(directory, name) {
  const bytes = readFileSync(resolve(directory, name)); const value = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(Buffer.from(`${stableJson(value)}\n`, "utf8"))) fail("ARTIFACT_NONCANONICAL", `${name} is noncanonical`);
  return value;
}
function canonicalJsonl(directory, name) {
  const bytes = readFileSync(resolve(directory, name)); const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.endsWith("\n\n")) fail("ARTIFACT_NONCANONICAL", `${name} line endings`);
  const rows = text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
  if (rows.map((row) => `${stableJson(row)}\n`).join("") !== text) fail("ARTIFACT_NONCANONICAL", `${name} encoding`);
  return rows;
}

function tokenize(value) {
  const result = [];
  for (const match of value.normalize("NFKC").toLowerCase().matchAll(TOKEN_PATTERN)) {
    if ([...match[0]].length >= 2 && !STOP_WORDS.has(match[0])) result.push(match[0]);
  }
  return result;
}
function encodeSession(messages) { return messages.map((message) => `${message.role.toLowerCase()}: ${message.content}\n`).join("").normalize("NFKC").toLowerCase(); }
function count(tokens) { const map = new Map(); for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1); return map; }
function projectSourceRows(datasetBytes) {
  if (sha256(datasetBytes) !== DATASET_SHA256) fail("DATASET_HASH_MISMATCH", "dataset hash mismatch");
  const source = JSON.parse(datasetBytes.toString("utf8")); if (!Array.isArray(source) || source.length !== 500) fail("DATASET_SHAPE_MISMATCH", "dataset rows");
  const questionIds = new Set(); const result = [];
  for (const [rowIndex, raw] of source.entries()) {
    const row = closed(raw, ["answer", "answer_session_ids", "haystack_dates", "haystack_session_ids", "haystack_sessions", "question", "question_date", "question_id", "question_type"], "DATASET_SHAPE_MISMATCH", `source ${rowIndex}`);
    const questionId = string(row.question_id, "DATASET_SHAPE_MISMATCH", "question_id"); if (questionIds.has(questionId)) fail("DATASET_SHAPE_MISMATCH", "duplicate question"); questionIds.add(questionId);
    if (!Array.isArray(row.haystack_session_ids) || !Array.isArray(row.haystack_sessions) || row.haystack_session_ids.length !== row.haystack_sessions.length) fail("DATASET_SHAPE_MISMATCH", "unaligned sessions");
    const first = new Map();
    for (let index = 0; index < row.haystack_session_ids.length; index += 1) {
      const sessionId = string(row.haystack_session_ids[index], "DATASET_SHAPE_MISMATCH", "session id"); const rawMessages = row.haystack_sessions[index];
      if (!Array.isArray(rawMessages)) fail("DATASET_SHAPE_MISMATCH", "messages");
      const messages = rawMessages.map((message) => {
        const keys = Object.keys(message).sort(codeUnitCompare); const okay = stableJson(keys) === stableJson(["content", "role"]) || stableJson(keys) === stableJson(["content", "has_answer", "role"]);
        if (!okay || (Object.hasOwn(message, "has_answer") && typeof message.has_answer !== "boolean")) fail("DATASET_SHAPE_MISMATCH", "source message fields");
        const role = string(message.role, "DATASET_SHAPE_MISMATCH", "role"); if (role !== "user" && role !== "assistant") fail("DATASET_SHAPE_MISMATCH", "role enum");
        return { role, content: string(message.content, "DATASET_SHAPE_MISMATCH", "content", true) };
      });
      if (first.has(sessionId)) { if (stableJson(first.get(sessionId).messages) !== stableJson(messages)) fail("DATASET_SHAPE_MISMATCH", "duplicate changed"); continue; }
      first.set(sessionId, { session_id: sessionId, messages });
    }
    const input = { question_id: questionId, question: string(row.question, "DATASET_SHAPE_MISMATCH", "question"), sessions: [...first.values()] };
    const gold = [...new Set(row.answer_session_ids.map((id) => string(id, "DATASET_SHAPE_MISMATCH", "gold")))]; const retained = new Set(input.sessions.map((session) => session.session_id));
    if (gold.length === 0 || gold.some((id) => !retained.has(id))) fail("DATASET_SHAPE_MISMATCH", "gold absent");
    result.push({ questionId, questionType: row.question_type, input, caseSha256: sha256(`${stableJson(input)}\n`), goldSessionIds: gold });
  }
  return result;
}
function splitDigest(row) { return sha256(Buffer.concat([Buffer.from(row.questionType), Buffer.from([0]), Buffer.from(row.questionId)])); }
function expectedSplit(rows) {
  const groups = new Map(); for (const row of rows) { const list = groups.get(row.questionType) ?? []; list.push({ row, digest: splitDigest(row) }); groups.set(row.questionType, list); }
  const output = [];
  for (const questionType of [...groups.keys()].sort(codeUnitCompare)) {
    const list = groups.get(questionType).sort((a, b) => codeUnitCompare(a.digest, b.digest) || codeUnitCompare(a.row.questionId, b.row.questionId)); const dev = Math.floor(list.length * 0.3);
    list.forEach((entry, index) => output.push({ schemaVersion: "memory-longmemeval-retrieval/split-row-v4", questionId: entry.row.questionId, questionType, splitDigest: entry.digest, split: index < dev ? "development" : "evaluation", caseSha256: entry.row.caseSha256, distinctGoldSessionIds: entry.row.goldSessionIds }));
  }
  return output.sort((a, b) => codeUnitCompare(a.questionId, b.questionId));
}
function numericPair(left, right, size) { return Math.min(left, right) * size + Math.max(left, right); }
function xorshift32(seed) { let state = seed >>> 0; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }; }
function shuffle(questionId, sessionId, messages) {
  const digest = createHash("sha256").update(questionId).update("\0").update(sessionId).update("\0position-shuffle").digest(); const random = xorshift32(digest.readUInt32BE(0)); const result = [...messages];
  for (let index = result.length - 1; index > 0; index -= 1) { const selected = Math.floor((random() * (index + 1)) / 0x1_0000_0000); [result[index], result[selected]] = [result[selected], result[index]]; } return result;
}
function countBits(value) { let bits = value >>> 0; bits -= (bits >>> 1) & 0x55555555; bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333); return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
function independentRecurrenceEdges(documents, vocabulary) {
  const size = vocabulary.length; const masks = Array.from({ length: Math.ceil(documents.length / 32) }, () => new Uint32Array(size)); const excluded = new Map();
  for (let sessionIndex = 0; sessionIndex < documents.length; sessionIndex += 1) { const document = documents[sessionIndex]; const word = Math.floor(sessionIndex / 32), bit = 1 << (sessionIndex % 32); for (const tokenId of document.associationContent) masks[word][tokenId] |= bit; const occurrences = new Uint16Array(size); for (const message of document.associationMessages) for (const tokenId of message) occurrences[tokenId] += 1; for (const message of document.associationMessages) { const exclusive = message.filter((tokenId) => occurrences[tokenId] === 1); for (let left = 0; left < exclusive.length; left += 1) for (let right = left + 1; right < exclusive.length; right += 1) { const key = numericPair(exclusive[left], exclusive[right], size); excluded.set(key, (excluded.get(key) ?? 0) + 1); } } }
  const admitted = new Set(); let edgeBytes = 0; for (let left = 0; left < size; left += 1) for (let right = left + 1; right < size; right += 1) { const key = left * size + right; const distinctSessions = masks.reduce((sum, mask) => sum + countBits(mask[left] & mask[right]), 0) - (excluded.get(key) ?? 0); if (distinctSessions < 2) continue; admitted.add(key); edgeBytes += Buffer.byteLength(JSON.stringify({ left: vocabulary[left], right: vocabulary[right], distinctSessions }) + "\n"); }
  return { admitted, edgeBytes };
}
function independentTreatment(input, selectedWeights) {
  const query = [...new Set(tokenize(input.question))]; const documents = input.sessions.map((session) => { const text = encodeSession(session.messages); const tokens = tokenize(text); return { sessionId: session.session_id, text, tokens, counts: count(tokens), content: new Set(session.messages.flatMap((message) => tokenize(message.content))), messages: session.messages.map((message) => [...new Set(tokenize(message.content))]) }; });
  const sessionFrequency = new Map(); for (const document of documents) for (const token of document.content) sessionFrequency.set(token, (sessionFrequency.get(token) ?? 0) + 1);
  const vocabulary = [...sessionFrequency].filter(([, frequency]) => frequency >= 2).map(([token]) => token).sort(codeUnitCompare); const tokenIds = new Map(vocabulary.map((token, index) => [token, index])); const vocabularySize = vocabulary.length;
  for (const document of documents) { document.associationMessages = document.messages.map((message) => message.filter((token) => tokenIds.has(token)).map((token) => tokenIds.get(token))); document.associationContent = [...document.content].filter((token) => tokenIds.has(token)).map((token) => tokenIds.get(token)); }
  const average = documents.reduce((sum, document) => sum + document.tokens.length, 0) / documents.length; const content = new Map();
  for (const document of documents) { let score = 0; for (const term of query) { const tf = document.counts.get(term) ?? 0; if (tf === 0 || average === 0) continue; const df = documents.reduce((sum, candidate) => sum + Number(candidate.counts.has(term)), 0); const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5)); const denominator = tf + 1.2 * (0.25 + 0.75 * document.tokens.length / average); score += idf * ((tf * 2.2) / denominator); } content.set(document.sessionId, score); }
  const sessionBytes = new Map(documents.map((document) => [document.sessionId, Buffer.byteLength(document.text)])); const corpusRawSessionBytes = [...sessionBytes.values()].reduce((a, b) => a + b, 0);
  const rank = (scores, weight) => documents.map((document) => ({ sessionId: document.sessionId, content: content.get(document.sessionId), association: scores.get(document.sessionId) ?? 0 })).sort((a, b) => b.content + weight * b.association - (a.content + weight * a.association) || b.association - a.association || b.content - a.content || codeUnitCompare(a.sessionId, b.sessionId)).slice(0, 10).map((row) => row.sessionId);
  const result = [];
  for (const conditionId of CONDITIONS) {
    let admitted = new Set(), edgeBytes = 0;
    if (conditionId === "recurrence-no-position") ({ admitted, edgeBytes } = independentRecurrenceEdges(documents, vocabulary));
    else { const support = new Map(); const addPair = (left, right, sessionIndex) => { if (left === right) return; const key = numericPair(left, right, vocabularySize); const prior = support.get(key) ?? 0; if (Math.floor(prior / 128) !== sessionIndex + 1) support.set(key, (sessionIndex + 1) * 128 + prior % 128 + 1); }; if (conditionId !== "content") for (let sessionIndex = 0; sessionIndex < documents.length; sessionIndex += 1) { const document = documents[sessionIndex]; const messages = conditionId === "shuffled-position" ? shuffle(input.question_id, document.sessionId, document.associationMessages) : document.associationMessages; for (let index = 0; index + 1 < messages.length; index += 1) for (const left of messages[index]) for (const right of messages[index + 1]) addPair(left, right, sessionIndex); } for (const [edge, encoded] of [...support].sort(([a], [b]) => a - b)) { const distinctSessions = encoded % 128; if (distinctSessions < 2) continue; admitted.add(edge); const left = Math.floor(edge / vocabularySize), right = edge % vocabularySize; edgeBytes += Buffer.byteLength(JSON.stringify({ left: vocabulary[left], right: vocabulary[right], distinctSessions }) + "\n"); } }
    const queryIds = new Set(query.map((token) => tokenIds.get(token)).filter((id) => id !== undefined)); const association = new Map(documents.map((document) => [document.sessionId, Number([...queryIds].some((queryId) => document.associationContent.some((candidateId) => queryId !== candidateId && !queryIds.has(candidateId) && admitted.has(numericPair(queryId, candidateId, vocabularySize))))) ]));
    const weights = conditionId === "content" ? [0] : selectedWeights === undefined ? ASSOCIATION_WEIGHTS : [selectedWeights[conditionId]];
    const variants = weights.map((weight) => { const sessionIds = rank(association, weight); return { weight, ranking: sessionIds.map((sessionId, index) => ({ rank: index + 1, sessionId })), returnedRawSessionBytes: sessionIds.reduce((sum, id) => sum + sessionBytes.get(id), 0) }; });
    result.push({ conditionId, variants, exactCost: { edgeCount: admitted.size, edgeBytes, corpusRawSessionBytes } });
  }
  return result;
}
export function recomputeTreatmentForTest(input, selectedWeights = undefined) {
  return independentTreatment(input, selectedWeights);
}
const treatmentCache = new Map();
function treatmentCacheKey(caseSha256, selectedWeights) {
  return `${caseSha256}\0${selectedWeights === undefined ? "development" : stableJson(selectedWeights)}`;
}
function primeTreatmentCache(sourceRows, selectedWeights) {
  const missing = sourceRows.map((source) => ({
    key: treatmentCacheKey(source.caseSha256, selectedWeights),
    input: source.input,
    selectedWeights,
  })).filter((job) => !treatmentCache.has(job.key));
  if (missing.length === 0) return;
  const workerCount = Math.min(3, missing.length);
  const batches = Array.from({ length: workerCount }, () => []);
  missing.forEach((job, index) => batches[index % workerCount].push(job));
  const directory = mkdtempSync(resolve(tmpdir(), "dolly-longmemeval-verifier-"));
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const workers = batches.map((jobs, index) => new Worker(
    new URL("./verify-worker.mjs", import.meta.url),
    { workerData: { jobs, outputPath: resolve(directory, `${index}.json`), signal: signal.buffer } },
  ));
  try {
    const deadline = Number(process.env.DOLLY_RETRIEVAL_DEADLINE_MS ?? Number.MAX_SAFE_INTEGER);
    while (Atomics.load(signal, 0) < workers.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail("VERIFIER_RESOURCE_LIMIT", "independent verifier exceeded wall-clock budget");
      Atomics.wait(signal, 0, Atomics.load(signal, 0), Math.min(remaining, 1000));
      if (process.memoryUsage().rss > 4_294_967_296) fail("VERIFIER_RESOURCE_LIMIT", "independent verifier exceeded resident-memory budget");
    }
    for (let index = 0; index < workers.length; index += 1) {
      const payload = JSON.parse(readFileSync(resolve(directory, `${index}.json`), "utf8"));
      if (payload.error !== undefined) fail("VERIFIER_RECOMPUTATION_FAILED", payload.error);
      for (const row of payload.results) treatmentCache.set(row.key, row.result);
    }
  } finally {
    for (const worker of workers) void worker.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
}
function rankingMetrics(variant, goldIds) { const gold = new Set(goldIds); const ids = [...new Set(variant.ranking.map((entry) => entry.sessionId))]; const output = {}; for (const k of [1, 5, 10]) { const chosen = ids.slice(0, k); const rel = chosen.reduce((sum, id) => sum + Number(gold.has(id)), 0); let dcg = 0, idcg = 0; for (let i = 0; i < chosen.length; i += 1) if (gold.has(chosen[i])) dcg += 1 / Math.log2(i + 2); for (let i = 0; i < Math.min(k, gold.size); i += 1) idcg += 1 / Math.log2(i + 2); output[`recallAt${k}`] = rel / gold.size; output[`hitAt${k}`] = Number(rel > 0); output[`ndcgAt${k}`] = dcg / idcg; } return output; }
function compareStable(actual, expected, code, label) { if (stableJson(actual) !== stableJson(expected)) fail(code, `${label} differs`); }
function verifyInventory(directory) {
  const text = readFileSync(resolve(directory, "sha256sums.txt"), "utf8"); const expectedPattern = EXPECTED_CHECKSUM_FILES.map((name) => `${sha256(readFileSync(resolve(directory, name)))}  ${name}`).join("\n") + "\n";
  if (text !== expectedPattern) { const actualNames = text.trimEnd().split("\n").map((line) => line.slice(66)); const sameSet = stableJson(actualNames) === stableJson(EXPECTED_CHECKSUM_FILES); fail(sameSet ? "CHECKSUM_DIGEST_MISMATCH" : "CHECKSUM_INVENTORY_SET_MISMATCH", "checksum inventory differs"); }
}

export function verifyCore(directory, { validateChecksum = true, validateAttestations = false } = {}) {
  try {
    if (validateChecksum) compareStable(readdirSync(directory).sort(codeUnitCompare), EXPECTED_COMPLETE_FILES, "ARTIFACT_FILE_SET_MISMATCH", "artifact file set");
    for (const name of readdirSync(directory)) if (readFileSync(resolve(directory, name)).includes(Buffer.from(SECRET_SENTINEL))) fail("SECRET_MARKER_LEAK", "secret sentinel found");
    const freeze = canonicalJson(directory, "run-freeze.json"); const prereg = canonicalJson(directory, "preregistration.json"); const split = canonicalJsonl(directory, "split.jsonl"); const cases = canonicalJsonl(directory, "cases.jsonl"); const development = canonicalJsonl(directory, "development-rankings.jsonl"); const selected = canonicalJson(directory, "selected-weights.json"); const evaluation = canonicalJsonl(directory, "evaluation-rankings.jsonl"); const analysis = canonicalJson(directory, "analysis.json"); const manifest = canonicalJson(directory, "run-manifest.json");
    closed(freeze, ["schemaVersion", "experimentId", "experimentVersion", "runId", "frozenAt", "sourceCommit", "dirtyWorktree", "relevantSourcesClean", "preregistrationPath", "preregistrationSha256", "protocolPath", "protocolSha256", "artifactContractPath", "datasetPath", "datasetSha256", "sourceFiles", "checksumFiles", "resultComputationStarted"], "FREEZE_MISMATCH", "freeze");
    if (freeze.schemaVersion !== "memory-longmemeval-retrieval/freeze-v4" || freeze.experimentId !== "memory-longmemeval-retrieval-v0" || freeze.experimentVersion !== 4 || !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(freeze.runId) || !/^[0-9a-f]{40}$/u.test(freeze.sourceCommit) || typeof freeze.dirtyWorktree !== "boolean" || freeze.relevantSourcesClean !== true || freeze.resultComputationStarted !== false || freeze.preregistrationPath !== EXPECTED_SOURCE_FILES[1] || freeze.protocolPath !== EXPECTED_SOURCE_FILES[0] || freeze.artifactContractPath !== EXPECTED_SOURCE_FILES[3] || freeze.datasetPath !== DATASET_PATH || freeze.datasetSha256 !== DATASET_SHA256 || stableJson(freeze.checksumFiles) !== stableJson(EXPECTED_CHECKSUM_FILES)) fail("FREEZE_MISMATCH", "freeze identity");
    isoInstant(freeze.frozenAt, "FREEZE_MISMATCH", "freeze time");
    compareStable(freeze.sourceFiles.map((source) => source.path), EXPECTED_SOURCE_FILES, "SOURCE_INVENTORY_MISMATCH", "source inventory");
    const committedSource = new Map();
    for (const source of freeze.sourceFiles) { closed(source, ["path", "sha256"], "SOURCE_INVENTORY_MISMATCH", "source row"); if (!/^[0-9a-f]{64}$/u.test(source.sha256)) fail("SOURCE_INVENTORY_MISMATCH", source.path); const head = execFileSync("git", ["show", `${freeze.sourceCommit}:${source.path}`], { cwd: REPOSITORY_ROOT }); if (sha256(head) !== source.sha256) fail("SOURCE_COMMIT_MISMATCH", source.path); committedSource.set(source.path, head); }
    const committedPrereg = JSON.parse(committedSource.get(EXPECTED_SOURCE_FILES[1]).toString("utf8")); compareStable(prereg, committedPrereg, "PREREGISTRATION_SOURCE_MISMATCH", "preregistration snapshot");
    if (sha256(`${stableJson(prereg)}\n`) !== freeze.preregistrationSha256 || prereg.protocol.path !== freeze.protocolPath || prereg.protocol.sha256 !== freeze.protocolSha256 || sha256(committedSource.get(freeze.protocolPath)) !== freeze.protocolSha256 || prereg.domainDesign.artifactContract.path !== freeze.artifactContractPath || sha256(committedSource.get(freeze.artifactContractPath)) !== prereg.domainDesign.artifactContract.sha256 || prereg.domainDesign.datasetPath !== DATASET_PATH || prereg.domainDesign.datasetSha256 !== DATASET_SHA256) fail("FREEZE_MISMATCH", "frozen source bindings");
    const sourceRows = projectSourceRows(readFileSync(resolve(REPOSITORY_ROOT, DATASET_PATH))); const sourceById = new Map(sourceRows.map((row) => [row.questionId, row])); const expectedSplitRows = expectedSplit(sourceRows);
    if (split.length !== 500) fail("SPLIT_COVERAGE_MISMATCH", "split count"); compareStable(split, expectedSplitRows, "SPLIT_GOLD_SOURCE_MISMATCH", "split");
    if (cases.length !== 500) fail("PROJECTION_COVERAGE_MISMATCH", "case count"); compareStable(cases.map((row) => row.question_id), sourceRows.map((row) => row.questionId).sort(codeUnitCompare), "PROJECTION_ORDER_MISMATCH", "case order"); for (let index = 0; index < cases.length; index += 1) { const input = closed(cases[index], ["question_id", "question", "sessions"], "PROJECTION_UNKNOWN_FIELD", "case"); const source = sourceById.get(input.question_id); if (!source || stableJson(input) !== stableJson(source.input)) fail("PROJECTION_SOURCE_MISMATCH", "case projection"); }
    const verifyRankingRows = (rows, splitName, expectedCount, expectedVariants, selectedWeights, selectedHash) => {
      if (rows.length !== expectedCount) fail(splitName === "evaluation" ? "EVALUATION_RANKING_COVERAGE_MISMATCH" : "DEVELOPMENT_RANKING_COVERAGE_MISMATCH", "ranking count");
      const relevantSources = [...new Set(rows.map((row) => row.questionId))].map((questionId) => sourceById.get(questionId)).filter(Boolean); primeTreatmentCache(relevantSources, selectedWeights);
      const seen = new Set(); for (const row of rows) { const fields = ["schemaVersion", "questionId", "caseSha256", "split", "conditionId", "variants", "cost", ...(splitName === "evaluation" ? ["selectedWeightsSha256"] : [])]; closed(row, fields, "RANKING_ROW_SHAPE_MISMATCH", "ranking row"); if (row.schemaVersion !== "memory-longmemeval-retrieval/ranking-v4") fail("RANKING_ROW_SHAPE_MISMATCH", "ranking schema version"); const key = `${row.questionId}\0${row.conditionId}`; if (seen.has(key)) fail("RANKING_ROW_DUPLICATE", key); seen.add(key); const source = sourceById.get(row.questionId); if (!source || row.caseSha256 !== source.caseSha256 || row.split !== splitName || expectedSplitRows.find((candidate) => candidate.questionId === row.questionId).split !== splitName) fail("RANKING_SOURCE_BINDING_MISMATCH", key); if (selectedHash !== undefined && row.selectedWeightsSha256 !== selectedHash) fail("RANKING_SELECTED_WEIGHT_BINDING_MISMATCH", key); const treatment = treatmentCache.get(treatmentCacheKey(source.caseSha256, selectedWeights)); const recomputed = treatment.find((condition) => condition.conditionId === row.conditionId); if (!recomputed) fail("RANKING_CONDITION_MISMATCH", key); if (row.variants.length !== expectedVariants(row.conditionId)) fail("RANKING_VARIANT_COVERAGE_MISMATCH", key); compareStable(row.variants, recomputed.variants, "RANKING_RECOMPUTATION_MISMATCH", key); closed(row.cost, ["buildMilliseconds", "queryMilliseconds", "edgeCount", "edgeBytes", "corpusRawSessionBytes"], "RANKING_COST_SHAPE_MISMATCH", "cost"); nonnegative(row.cost.buildMilliseconds, "RANKING_COST_INVALID", "build"); nonnegative(row.cost.queryMilliseconds, "RANKING_COST_INVALID", "query"); compareStable({ edgeCount: row.cost.edgeCount, edgeBytes: row.cost.edgeBytes, corpusRawSessionBytes: row.cost.corpusRawSessionBytes }, recomputed.exactCost, "RANKING_COST_MISMATCH", key); }
    };
    verifyRankingRows(development, "development", 588, (condition) => condition === "content" ? 1 : 4, undefined, undefined);
    closed(selected, ["schemaVersion", "developmentRankingsSha256", "selectedWeights", "selections"], "SELECTED_WEIGHT_MISMATCH", "selected weights"); if (selected.schemaVersion !== "memory-longmemeval-retrieval/selected-weights-v4") fail("SELECTED_WEIGHT_MISMATCH", "selected schema version");
    const developmentSha = sha256(readFileSync(resolve(directory, "development-rankings.jsonl"))); if (selected.developmentRankingsSha256 !== developmentSha) fail("SELECTED_WEIGHT_SOURCE_HASH_MISMATCH", "development hash");
    const computedSelections = []; const computedMap = {}; for (const conditionId of CONDITIONS.slice(1)) { const rows = development.filter((row) => row.conditionId === conditionId).sort((a, b) => codeUnitCompare(a.questionId, b.questionId)); const candidates = ASSOCIATION_WEIGHTS.map((weight) => ({ weight, macroNdcgAt10: rows.reduce((sum, row) => sum + rankingMetrics(row.variants.find((variant) => variant.weight === weight), sourceById.get(row.questionId).goldSessionIds).ndcgAt10, 0) / rows.length })); let choice = candidates[0]; for (const candidate of candidates.slice(1)) if (candidate.macroNdcgAt10 > choice.macroNdcgAt10) choice = candidate; computedMap[conditionId] = choice.weight; computedSelections.push({ conditionId, candidates, selectedWeight: choice.weight }); }
    compareStable(selected.selectedWeights, computedMap, "SELECTED_WEIGHT_MISMATCH", "selected weights"); compareStable(selected.selections, computedSelections, "SELECTED_WEIGHT_MISMATCH", "selection evidence"); const selectedHash = sha256(readFileSync(resolve(directory, "selected-weights.json")));
    verifyRankingRows(evaluation, "evaluation", 1412, () => 1, computedMap, selectedHash);
    const evalHash = sha256(readFileSync(resolve(directory, "evaluation-rankings.jsonl"))); if (analysis.selectedWeightsSha256 !== selectedHash || analysis.evaluationRankingsSha256 !== evalHash) fail("ANALYSIS_SOURCE_HASH_MISMATCH", "analysis bindings");
    const expectedAnalysis = independentAnalysis(evaluation, development, sourceById, computedMap, selectedHash, evalHash); closed(analysis, ["schemaVersion", "selectedWeights", "developmentConditionMetrics", "conditionMetrics", "contrasts", "knowledgeUpdate", "cost", "gates", "classification", "selectedWeightsSha256", "evaluationRankingsSha256"], "ANALYSIS_METRIC_MISMATCH", "analysis"); compareStable(analysis, expectedAnalysis, "ANALYSIS_METRIC_MISMATCH", "analysis");
    closed(manifest, ["schemaVersion", "attemptStatus", "experimentId", "experimentVersion", "runId", "preregistrationSha256", "protocolSha256", "datasetSha256", "sourceCommit", "dirtyWorktree", "relevantSourcesClean", "configuration", "dataset", "backend", "modelEndpointCapabilityProfile", "modelIdentifier", "seeds", "executionOrder", "resourceBudgets", "perCaseAccounting", "rawOutputs", "validatorResults", "aggregateMetrics", "startedAt", "finishedAt", "failure"], "MANIFEST_MISMATCH", "manifest");
    if (manifest.schemaVersion !== "memory-longmemeval-retrieval/manifest-v4" || manifest.attemptStatus !== "complete" || manifest.experimentId !== "memory-longmemeval-retrieval-v0" || manifest.experimentVersion !== 4 || manifest.runId !== freeze.runId || manifest.preregistrationSha256 !== freeze.preregistrationSha256 || manifest.protocolSha256 !== freeze.protocolSha256 || manifest.datasetSha256 !== DATASET_SHA256 || manifest.sourceCommit !== freeze.sourceCommit || manifest.dirtyWorktree !== freeze.dirtyWorktree || manifest.relevantSourcesClean !== true || manifest.backend !== "local-deterministic-retrieval" || manifest.modelEndpointCapabilityProfile !== null || manifest.modelIdentifier !== null || manifest.executionOrder !== "UTF-16 code-unit question ID, frozen condition order" || manifest.failure !== null) fail("MANIFEST_MISMATCH", "manifest identity");
    compareStable(manifest.configuration, { conditions: CONDITIONS, associationWeights: ASSOCIATION_WEIGHTS, cutoffs: [1, 5, 10] }, "MANIFEST_MISMATCH", "manifest configuration");
    compareStable(manifest.dataset, { questions: 500, developmentQuestions: 147, evaluationQuestions: 353 }, "MANIFEST_MISMATCH", "manifest dataset");
    compareStable(manifest.seeds, { bootstrap: 1296387376, shuffle: "per-question-session SHA-256" }, "MANIFEST_MISMATCH", "manifest seeds");
    compareStable(manifest.resourceBudgets, prereg.domainDesign.resourceBudgets, "MANIFEST_MISMATCH", "manifest resource budgets");
    compareStable(manifest.perCaseAccounting, { conditionRows: 2000, rankingVectors: 3323 }, "MANIFEST_MISMATCH", "manifest accounting");
    compareStable(manifest.rawOutputs, { networkCalls: 0, modelCalls: 0, treatmentInputsPersisted: true }, "MANIFEST_MISMATCH", "manifest outputs");
    compareStable(manifest.validatorResults, { status: "pending", path: "validation.json" }, "MANIFEST_MISMATCH", "manifest validator pointer");
    compareStable(manifest.aggregateMetrics, { path: "analysis.json" }, "MANIFEST_MISMATCH", "manifest analysis pointer");
    const startedAt = isoInstant(manifest.startedAt, "MANIFEST_MISMATCH", "manifest startedAt"); const finishedAt = isoInstant(manifest.finishedAt, "MANIFEST_MISMATCH", "manifest finishedAt");
    if (manifest.startedAt !== freeze.frozenAt || finishedAt < startedAt) fail("MANIFEST_MISMATCH", "manifest time range");
    if (validateChecksum) verifyInventory(directory);
    if (validateAttestations) {
      const validation = canonicalJson(directory, "validation.json"); const mutations = canonicalJson(directory, "mutation-validation.json");
      closed(validation, ["schemaVersion", "verifierSha256", "valid", "classification", "primaryCode", "errors", "checks", "analysisSha256", "mutationValidationSha256"], "VALIDATION_ATTESTATION_MISMATCH", "validation summary");
      const frozenVerifierSha = freeze.sourceFiles.find((source) => source.path.endsWith("/verify.mjs"))?.sha256;
      if (validation.schemaVersion !== "memory-longmemeval-retrieval/validation-v4" || validation.verifierSha256 !== frozenVerifierSha || validation.valid !== true || validation.classification !== analysis.classification || validation.primaryCode !== null || stableJson(validation.errors) !== "[]" || stableJson(validation.checks) !== stableJson(EXPECTED_VALIDATION_CHECKS) || validation.analysisSha256 !== sha256(readFileSync(resolve(directory, "analysis.json"))) || validation.mutationValidationSha256 !== sha256(readFileSync(resolve(directory, "mutation-validation.json")))) fail("VALIDATION_ATTESTATION_MISMATCH", "validation summary");
      closed(mutations, ["schemaVersion", "mutations", "allRejected"], "MUTATION_ATTESTATION_MISMATCH", "mutation summary");
      if (mutations.schemaVersion !== "memory-longmemeval-retrieval/mutation-validation-v4" || mutations.allRejected !== true || mutations.mutations?.length !== 8 || mutations.mutations.some((row, index) => { closed(row, ["id", "changedFiles", "checksumRegenerated", "expectedPrimaryCode", "observedPrimaryCode", "rejected"], "MUTATION_ATTESTATION_MISMATCH", "mutation row"); const expected = EXPECTED_MUTATIONS[index]; const checksumExpected = row.id !== "checksum-entry-removed"; return row.id !== expected[0] || row.expectedPrimaryCode !== expected[1] || row.observedPrimaryCode !== expected[1] || row.rejected !== true || row.checksumRegenerated !== checksumExpected || stableJson(row.changedFiles) !== stableJson([expected[2]]); })) fail("MUTATION_ATTESTATION_MISMATCH", "mutation summary");
    }
    return { valid: true, classification: analysis.classification, primaryCode: null, errors: [] };
  } catch (error) { return { valid: false, classification: null, primaryCode: error.code ?? "VERIFICATION_ERROR", errors: [String(error.message)] }; }
}

function aggregateMetrics(rows, sourceById, selectedWeights) { const questions = [...new Set(rows.map((row) => row.questionId))].sort(codeUnitCompare); const byKey = new Map(rows.map((row) => [`${row.questionId}\0${row.conditionId}`, row])); return Object.fromEntries(CONDITIONS.map((condition) => { const per = questions.map((id) => { const row = byKey.get(`${id}\0${condition}`); const weight = condition === "content" ? 0 : selectedWeights[condition]; return rankingMetrics(row.variants.find((variant) => variant.weight === weight), sourceById.get(id).goldSessionIds); }); return [condition, Object.fromEntries(["recallAt1", "recallAt5", "recallAt10", "hitAt1", "hitAt5", "hitAt10", "ndcgAt1", "ndcgAt5", "ndcgAt10"].map((metric) => [metric, per.reduce((sum, row) => sum + row[metric], 0) / per.length]))]; })); }

function independentAnalysis(evaluation, development, sourceById, selectedWeights, selectedHash, evalHash) {
  const questions = [...new Set(evaluation.map((row) => row.questionId))].sort(codeUnitCompare); const byKey = new Map(evaluation.map((row) => [`${row.questionId}\0${row.conditionId}`, row])); const conditionMetrics = {};
  for (const condition of CONDITIONS) { const per = questions.map((id) => rankingMetrics(byKey.get(`${id}\0${condition}`).variants[0], sourceById.get(id).goldSessionIds)); conditionMetrics[condition] = Object.fromEntries(["recallAt1", "recallAt5", "recallAt10", "hitAt1", "hitAt5", "hitAt10", "ndcgAt1", "ndcgAt5", "ndcgAt10"].map((metric) => [metric, per.reduce((sum, row) => sum + row[metric], 0) / per.length])); }
  const contrasts = {}; for (const baseline of ["content", "recurrence-no-position", "shuffled-position"]) { const differences = questions.map((id) => rankingMetrics(byKey.get(`${id}\0repeated-adjacent-position`).variants[0], sourceById.get(id).goldSessionIds).ndcgAt10 - rankingMetrics(byKey.get(`${id}\0${baseline}`).variants[0], sourceById.get(id).goldSessionIds).ndcgAt10); const random = xorshift32(1296387376); const samples = []; for (let r = 0; r < 10000; r += 1) { let sum = 0; for (let d = 0; d < differences.length; d += 1) sum += differences[Math.floor(random() * differences.length / 0x1_0000_0000)]; samples.push(sum / differences.length); } samples.sort((a, b) => a - b); contrasts[baseline] = { mean: differences.reduce((a, b) => a + b, 0) / differences.length, lower95: samples[249], upper95: samples[9749] }; }
  const knowledge = questions.filter((id) => sourceById.get(id).questionType === "knowledge-update"); const error = (condition) => knowledge.reduce((sum, id) => sum + Number(!new Set(sourceById.get(id).goldSessionIds).has(byKey.get(`${id}\0${condition}`).variants[0].ranking[0]?.sessionId)), 0) / knowledge.length; const contentError = error("content"), positionError = error("repeated-adjacent-position"); const ratios = evaluation.filter((row) => row.conditionId === "repeated-adjacent-position").map((row) => row.cost.corpusRawSessionBytes === 0 ? row.cost.edgeBytes === 0 ? 0 : Infinity : row.cost.edgeBytes / row.cost.corpusRawSessionBytes).sort((a, b) => a - b); if (ratios.some((value) => !Number.isFinite(value))) fail("ANALYSIS_NONFINITE", "ratio"); const ratioP95 = ratios[Math.ceil(0.95 * ratios.length) - 1]; const nearest = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1]; const descriptiveByTreatment = Object.fromEntries(CONDITIONS.slice(1).map((conditionId) => { const rows = evaluation.filter((row) => row.conditionId === conditionId); const summary = (values) => ({ p50: nearest(values, 0.5), p95: nearest(values, 0.95) }); return [conditionId, { buildMilliseconds: summary(rows.map((row) => row.cost.buildMilliseconds)), queryMilliseconds: summary(rows.map((row) => row.cost.queryMilliseconds)), edgeBytes: summary(rows.map((row) => row.cost.edgeBytes)), corpusRawSessionBytes: summary(rows.map((row) => row.cost.corpusRawSessionBytes)), returnedRawSessionBytes: summary(rows.map((row) => row.variants[0].returnedRawSessionBytes)), edgeToCorpusRawRatio: summary(rows.map((row) => row.cost.corpusRawSessionBytes === 0 ? row.cost.edgeBytes === 0 ? 0 : Infinity : row.cost.edgeBytes / row.cost.corpusRawSessionBytes)) }]; })); const useful = Object.values(contrasts).every((value) => value.mean >= 0.02 && value.lower95 > 0), knowledgePass = positionError - contentError <= 0.02, costPass = ratioP95 <= 2;
  return { schemaVersion: "memory-longmemeval-retrieval/analysis-v4", selectedWeights, developmentConditionMetrics: aggregateMetrics(development, sourceById, selectedWeights), conditionMetrics, contrasts, knowledgeUpdate: { contentTop1Error: contentError, repeatedPositionTop1Error: positionError, difference: positionError - contentError }, cost: { repeatedPositionEdgeToRawRatioP95: ratioP95, descriptiveByTreatment }, gates: { usefulEffect: useful, knowledgeUpdate: knowledgePass, deterministicCost: costPass }, classification: useful && knowledgePass && costPass ? "supported" : "rejected", selectedWeightsSha256: selectedHash, evaluationRankingsSha256: evalHash };
}

export function validationArtifact(result) { return { schemaVersion: "memory-longmemeval-retrieval/validation-v4", verifierSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), valid: result.valid, classification: result.classification, primaryCode: result.primaryCode, errors: result.errors }; }
export function secretSentinelForMutation() { return SECRET_SENTINEL; }

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--run-directory"); if (index < 0 || index + 1 >= process.argv.length) throw new TypeError("usage: verify.mjs --run-directory <path>"); const directory = resolve(process.argv[index + 1]); const result = verifyCore(directory, { validateChecksum: true, validateAttestations: true }); process.stdout.write(`${stableJson(result)}\n`); if (!result.valid) process.exitCode = 1;
}
