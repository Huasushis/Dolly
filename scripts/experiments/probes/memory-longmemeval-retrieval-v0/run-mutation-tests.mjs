#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { CHECKSUM_FILES } from "./run.mjs";
import { secretSentinelForMutation, validationArtifact, verifyCore } from "./verify.mjs";

const MUTATIONS = Object.freeze([
  ["gold-session-swap", "SPLIT_GOLD_SOURCE_MISMATCH"],
  ["projection-forbidden-field", "PROJECTION_UNKNOWN_FIELD"],
  ["projection-message-order", "PROJECTION_SOURCE_MISMATCH"],
  ["ranking-row-removed", "EVALUATION_RANKING_COVERAGE_MISMATCH"],
  ["selected-weight-wrong-grid-member", "SELECTED_WEIGHT_MISMATCH"],
  ["analysis-ndcg-forged", "ANALYSIS_METRIC_MISMATCH"],
  ["checksum-entry-removed", "CHECKSUM_INVENTORY_SET_MISMATCH"],
  ["secret-marker-injected", "SECRET_MARKER_LEAK"],
]);
const FINALIZATION_DEADLINE = Number(process.env.DOLLY_RETRIEVAL_DEADLINE_MS ?? Number.MAX_SAFE_INTEGER);
function assertFinalizationBudget() {
  if (!Number.isSafeInteger(FINALIZATION_DEADLINE) || Date.now() > FINALIZATION_DEADLINE) {
    throw new Error("formal run exceeded finalization wall-clock budget");
  }
  if (process.memoryUsage().rss > 4_294_967_296) {
    throw new Error("formal run exceeded finalization resident-memory budget");
  }
}

function codeUnitCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort(codeUnitCompare).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function readJson(directory, name) { return JSON.parse(readFileSync(resolve(directory, name), "utf8")); }
function readJsonl(directory, name) { return readFileSync(resolve(directory, name), "utf8").trimEnd().split("\n").map(JSON.parse); }
function writeJson(directory, name, value) { writeFileSync(resolve(directory, name), `${stableJson(value)}\n`); }
function writeJsonl(directory, name, rows) { writeFileSync(resolve(directory, name), rows.map((row) => `${stableJson(row)}\n`).join("")); }
function writeInventory(directory) { writeFileSync(resolve(directory, "sha256sums.txt"), `${CHECKSUM_FILES.map((name) => `${sha256(readFileSync(resolve(directory, name)))}  ${name}`).join("\n")}\n`); }

function mutate(directory, mutationId) {
  switch (mutationId) {
    case "gold-session-swap": {
      const split = readJsonl(directory, "split.jsonl"); const cases = readJsonl(directory, "cases.jsonl"); const caseById = new Map(cases.map((input) => [input.question_id, input]));
      const row = split.find((candidate) => caseById.get(candidate.questionId).sessions.some((session) => !candidate.distinctGoldSessionIds.includes(session.session_id)));
      const replacement = caseById.get(row.questionId).sessions.map((session) => session.session_id).filter((id) => !row.distinctGoldSessionIds.includes(id)).sort(codeUnitCompare)[0]; row.distinctGoldSessionIds[0] = replacement; writeJsonl(directory, "split.jsonl", split); return ["split.jsonl"];
    }
    case "projection-forbidden-field": { const cases = readJsonl(directory, "cases.jsonl"); cases[0].question_type = "injected"; writeJsonl(directory, "cases.jsonl", cases); return ["cases.jsonl"]; }
    case "projection-message-order": { const cases = readJsonl(directory, "cases.jsonl"); outer: for (const input of cases) for (const session of input.sessions) for (let i = 0; i + 1 < session.messages.length; i += 1) if (stableJson(session.messages[i]) !== stableJson(session.messages[i + 1])) { [session.messages[i], session.messages[i + 1]] = [session.messages[i + 1], session.messages[i]]; break outer; } writeJsonl(directory, "cases.jsonl", cases); return ["cases.jsonl"]; }
    case "ranking-row-removed": { const rows = readJsonl(directory, "evaluation-rankings.jsonl"); const index = rows.findIndex((row) => row.conditionId === "repeated-adjacent-position"); rows.splice(index, 1); writeJsonl(directory, "evaluation-rankings.jsonl", rows); return ["evaluation-rankings.jsonl"]; }
    case "selected-weight-wrong-grid-member": { const selected = readJson(directory, "selected-weights.json"); const condition = "repeated-adjacent-position"; const current = selected.selectedWeights[condition]; const index = [0.25, 0.5, 1, 2].indexOf(current); selected.selectedWeights[condition] = [0.25, 0.5, 1, 2][(index + 1) % 4]; writeJson(directory, "selected-weights.json", selected); return ["selected-weights.json"]; }
    case "analysis-ndcg-forged": { const analysis = readJson(directory, "analysis.json"); const current = analysis.conditionMetrics["repeated-adjacent-position"].ndcgAt10; analysis.conditionMetrics["repeated-adjacent-position"].ndcgAt10 = current === 1 ? 0.999999 : current + 0.000001; writeJson(directory, "analysis.json", analysis); return ["analysis.json"]; }
    case "checksum-entry-removed": { const lines = readFileSync(resolve(directory, "sha256sums.txt"), "utf8").trimEnd().split("\n").filter((line) => !line.endsWith("  analysis.json")); writeFileSync(resolve(directory, "sha256sums.txt"), `${lines.join("\n")}\n`); return ["sha256sums.txt"]; }
    case "secret-marker-injected": { const manifest = readJson(directory, "run-manifest.json"); manifest.backend = `${manifest.backend}-${secretSentinelForMutation()}`; writeJson(directory, "run-manifest.json", manifest); return ["run-manifest.json"]; }
    default: throw new TypeError(`unknown mutation ${mutationId}`);
  }
}

export function finalizeAndVerify(runDirectory) {
  assertFinalizationBudget();
  const baseline = verifyCore(runDirectory, { validateChecksum: false, validateAttestations: false });
  if (!baseline.valid) throw new Error(`primary bundle invalid before mutations: ${baseline.primaryCode}`);
  const summaries = [];
  for (const [mutationId, expectedPrimaryCode] of MUTATIONS) {
    assertFinalizationBudget();
    const temporary = mkdtempSync(resolve(tmpdir(), "dolly-longmemeval-mutation-"));
    try {
      cpSync(runDirectory, temporary, { recursive: true });
      writeJson(temporary, "validation.json", { schemaVersion: "placeholder" });
      writeJson(temporary, "mutation-validation.json", { schemaVersion: "placeholder" });
      if (mutationId === "checksum-entry-removed") writeInventory(temporary);
      const changedFiles = mutate(temporary, mutationId);
      const checksumRegenerated = mutationId !== "checksum-entry-removed";
      if (checksumRegenerated) writeInventory(temporary);
      const result = verifyCore(temporary, {
        validateChecksum: mutationId === "checksum-entry-removed",
        validateAttestations: false,
      });
      summaries.push({
        id: mutationId,
        changedFiles,
        checksumRegenerated,
        expectedPrimaryCode,
        observedPrimaryCode: result.primaryCode,
        rejected: !result.valid && result.primaryCode === expectedPrimaryCode,
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const mutationValidation = {
    schemaVersion: "memory-longmemeval-retrieval/mutation-validation-v4",
    mutations: summaries,
    allRejected: summaries.every((row) => row.rejected),
  };
  if (!mutationValidation.allRejected) throw new Error(`mutation failure: ${stableJson(mutationValidation)}`);
  writeJson(runDirectory, "mutation-validation.json", mutationValidation);
  const validation = {
    ...validationArtifact(baseline),
    checks: ["source-freeze", "dataset", "projection", "split", "rankings", "selector", "analysis", "manifest", "mutations", "checksum"],
    analysisSha256: sha256(readFileSync(resolve(runDirectory, "analysis.json"))),
    mutationValidationSha256: sha256(readFileSync(resolve(runDirectory, "mutation-validation.json"))),
  };
  writeJson(runDirectory, "validation.json", validation);
  writeInventory(runDirectory);
  const complete = verifyCore(runDirectory, { validateChecksum: true, validateAttestations: true });
  assertFinalizationBudget();
  if (!complete.valid) throw new Error(`complete verification failed: ${complete.primaryCode}`);
  return { validation, mutationValidation };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--run-directory"); if (index < 0 || index + 1 >= process.argv.length) throw new TypeError("usage: run-mutation-tests.mjs --run-directory <path>"); finalizeAndVerify(resolve(process.argv[index + 1]));
}
