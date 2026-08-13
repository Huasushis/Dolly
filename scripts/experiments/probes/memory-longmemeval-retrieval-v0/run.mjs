#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import Ajv2020 from "ajv/dist/2020.js";

import {
  ASSOCIATION_CONDITIONS,
  CONDITIONS,
  DATASET_PATH,
  DATASET_SHA256,
  EXPERIMENT_ID,
  EXPERIMENT_VERSION,
  adaptDatasetRows,
  analyzeEvaluation,
  codeUnitCompare,
  createSplit,
  selectDevelopmentWeights,
  serializeJsonLines,
  sha256,
  stableJson,
} from "./common.mjs";
import { evaluateTreatmentQuestion } from "./treatment.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../../..");
const WORKSPACE_ROOT = resolve(REPOSITORY_ROOT, "..");
const PREREGISTRATION_PATH =
  "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0.json";
const SCHEMA_PATH =
  "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0-schema.json";

export const REQUIRED_SOURCE_PATHS = Object.freeze([
  "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0-protocol.md",
  PREREGISTRATION_PATH,
  SCHEMA_PATH,
  "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0-artifacts.md",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/common.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/treatment.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/treatment-worker.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/run.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/verify.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/verify-worker.mjs",
  "scripts/experiments/probes/memory-longmemeval-retrieval-v0/run-mutation-tests.mjs",
]);

export const CHECKSUM_FILES = Object.freeze([
  "run-freeze.json",
  "preregistration.json",
  "split.jsonl",
  "cases.jsonl",
  "development-rankings.jsonl",
  "selected-weights.json",
  "evaluation-rankings.jsonl",
  "analysis.json",
  "run-manifest.json",
  "validation.json",
  "mutation-validation.json",
]);

function repositoryPath(path) {
  return resolve(REPOSITORY_ROOT, path);
}

function gitOutput(args) {
  return execFileSync("git", args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function validatePreregistration(preregistration, schema) {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(preregistration)) {
    throw new TypeError(`preregistration schema invalid: ${JSON.stringify(validate.errors)}`);
  }
  if (preregistration.experimentVersion !== EXPERIMENT_VERSION) {
    throw new TypeError("preregistration version does not match runner");
  }
  const protocol = readFileSync(repositoryPath(preregistration.protocol.path));
  if (sha256(protocol) !== preregistration.protocol.sha256) {
    throw new TypeError("registered protocol hash changed");
  }
}

function assertRelevantSourcesClean() {
  const status = gitOutput(["status", "--short", "--", ...REQUIRED_SOURCE_PATHS]);
  if (status.length > 0) throw new TypeError(`registered sources are dirty:\n${status}`);
}

export function prepareFreeze({
  runId = "in-memory-v4",
  frozenAt = "1970-01-01T00:00:00.000Z",
  enforceCleanSources = false,
} = {}) {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(runId)) throw new TypeError("invalid run ID");
  const preregistrationBytes = readFileSync(repositoryPath(PREREGISTRATION_PATH));
  const preregistration = JSON.parse(preregistrationBytes.toString("utf8"));
  const preregistrationSnapshot = Buffer.from(`${stableJson(preregistration)}\n`, "utf8");
  const schema = JSON.parse(readFileSync(repositoryPath(SCHEMA_PATH), "utf8"));
  validatePreregistration(preregistration, schema);
  if (enforceCleanSources) assertRelevantSourcesClean();
  const datasetBytes = readFileSync(repositoryPath(DATASET_PATH));
  if (sha256(datasetBytes) !== DATASET_SHA256) throw new TypeError("dataset hash changed");
  const rows = adaptDatasetRows(datasetBytes);
  const split = createSplit(rows);
  const sourceFiles = REQUIRED_SOURCE_PATHS.map((path) => ({
    path,
    sha256: sha256(readFileSync(repositoryPath(path))),
  }));
  return Object.freeze({
    freeze: Object.freeze({
      schemaVersion: "memory-longmemeval-retrieval/freeze-v4",
      experimentId: EXPERIMENT_ID,
      experimentVersion: EXPERIMENT_VERSION,
      runId,
      frozenAt,
      sourceCommit: gitOutput(["rev-parse", "HEAD"]),
      dirtyWorktree: gitOutput(["status", "--short"]).length > 0,
      relevantSourcesClean: enforceCleanSources,
      preregistrationPath: PREREGISTRATION_PATH,
      preregistrationSha256: sha256(preregistrationSnapshot),
      protocolPath: preregistration.protocol.path,
      protocolSha256: preregistration.protocol.sha256,
      artifactContractPath:
        "docs/experiments/preregistrations/memory-longmemeval-retrieval-v0-artifacts.md",
      datasetPath: DATASET_PATH,
      datasetSha256: DATASET_SHA256,
      sourceFiles,
      checksumFiles: CHECKSUM_FILES,
      resultComputationStarted: false,
    }),
    preregistration,
    preregistrationBytes: preregistrationSnapshot,
    rows,
    split,
  });
}

function warmTreatment() {
  evaluateTreatmentQuestion({
    question_id: "warmup-question",
    question: "alpha target",
    sessions: [
      { session_id: "warmup-a", messages: [{ role: "user", content: "alpha" }, { role: "assistant", content: "target" }] },
      { session_id: "warmup-b", messages: [{ role: "user", content: "alpha" }, { role: "assistant", content: "target" }] },
    ],
  });
}

const TREATMENT_WORKER_COUNT = 3;

function evaluateTreatmentJobs(jobs, onCompleted) {
  if (jobs.length === 0) return Promise.resolve([]);
  return new Promise((resolvePromise, rejectPromise) => {
    const results = new Array(jobs.length);
    const workers = [];
    let nextIndex = 0;
    let completed = 0;
    let settled = false;
    const stopWorkers = () => Promise.all(workers.map((worker) => worker.terminate()));
    const fail = (error) => {
      if (settled) return;
      settled = true;
      void stopWorkers().finally(() => rejectPromise(error));
    };
    const dispatch = (worker) => {
      if (nextIndex >= jobs.length) return;
      const index = nextIndex;
      nextIndex += 1;
      worker.postMessage({ index, ...jobs[index] });
    };
    for (let workerIndex = 0; workerIndex < Math.min(TREATMENT_WORKER_COUNT, jobs.length); workerIndex += 1) {
      const worker = new Worker(new URL("./treatment-worker.mjs", import.meta.url));
      workers.push(worker);
      worker.on("message", (message) => {
        if (settled) return;
        if (message.error !== undefined) {
          fail(new Error(`treatment worker failed: ${message.error}`));
          return;
        }
        results[message.index] = message.result;
        completed += 1;
        try {
          onCompleted(completed);
        } catch (error) {
          fail(error);
          return;
        }
        if (completed === jobs.length) {
          settled = true;
          void stopWorkers().then(() => resolvePromise(results), rejectPromise);
          return;
        }
        dispatch(worker);
      });
      worker.on("error", fail);
      worker.on("exit", (code) => {
        if (!settled && code !== 0) fail(new Error(`treatment worker exited with ${code}`));
      });
      dispatch(worker);
    }
  });
}

function rankingRowsForQuestion(result, splitName, caseSha256, selectedWeightsSha256 = undefined) {
  return result.conditions.map((condition) => Object.freeze({
    schemaVersion: "memory-longmemeval-retrieval/ranking-v4",
    questionId: result.questionId,
    caseSha256,
    split: splitName,
    conditionId: condition.conditionId,
    ...(selectedWeightsSha256 === undefined ? {} : { selectedWeightsSha256 }),
    variants: condition.variants.map((variant) => Object.freeze({
      weight: variant.weight,
      ranking: variant.ranking.map((entry) => Object.freeze({
        rank: entry.rank,
        sessionId: entry.sessionId,
      })),
      returnedRawSessionBytes: variant.returnedRawSessionBytes,
    })),
    cost: condition.cost,
  }));
}

function payload(value) {
  return `${stableJson(value)}\n`;
}

function writeExclusive(directory, name, bytes) {
  const descriptor = openSync(resolve(directory, name), "wx", 0o600);
  try {
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertBudgets(startedAt, rowsWritten) {
  if (Date.now() - startedAt > 1_800_000) throw new Error("formal run exceeded wall-clock budget");
  if (process.memoryUsage().rss > 4_294_967_296) throw new Error("formal run exceeded resident-memory budget");
  if (rowsWritten > 2000) throw new Error("formal run exceeded condition-row budget");
}

export async function writeFormalRun(outputDirectory, { runId } = {}) {
  const absoluteOutput = resolve(outputDirectory);
  const relativeToWorkspace = relative(WORKSPACE_ROOT, absoluteOutput);
  if (relativeToWorkspace === ".." || relativeToWorkspace.startsWith(`..${sep}`)) {
    throw new TypeError(`output must stay below ${WORKSPACE_ROOT}`);
  }
  if (existsSync(absoluteOutput)) throw new TypeError(`refusing to overwrite ${absoluteOutput}`);
  const startedAt = Date.now();
  const frozenAt = new Date(startedAt).toISOString();
  const prepared = prepareFreeze({ runId, frozenAt, enforceCleanSources: true });
  mkdirSync(dirname(absoluteOutput), { recursive: true });
  mkdirSync(absoluteOutput, { recursive: false });
  writeExclusive(absoluteOutput, "run-freeze.json", payload(prepared.freeze));
  writeExclusive(absoluteOutput, "preregistration.json", prepared.preregistrationBytes);
  const rowByQuestion = new Map(prepared.rows.map((row) => [row.questionId, row]));
  const splitRows = prepared.split.rows.map((row) => Object.freeze({
    schemaVersion: "memory-longmemeval-retrieval/split-row-v4",
    questionId: row.questionId,
    questionType: row.questionType,
    splitDigest: row.digest,
    split: row.split,
    caseSha256: rowByQuestion.get(row.questionId).inputSha256,
    distinctGoldSessionIds: rowByQuestion.get(row.questionId).goldSessionIds,
  }));
  writeExclusive(absoluteOutput, "split.jsonl", serializeJsonLines(splitRows));
  const cases = prepared.rows.map((row) => row.input)
    .sort((left, right) => codeUnitCompare(left.question_id, right.question_id));
  writeExclusive(absoluteOutput, "cases.jsonl", serializeJsonLines(cases));

  warmTreatment();
  const developmentResults = await evaluateTreatmentJobs(
    prepared.split.development.map((splitRow) => ({
      input: rowByQuestion.get(splitRow.questionId).input,
      selectedWeights: undefined,
    })),
    (completed) => assertBudgets(startedAt, completed * CONDITIONS.length),
  );
  const developmentRows = developmentResults.flatMap((result, index) => rankingRowsForQuestion(
    result,
    "development",
    rowByQuestion.get(prepared.split.development[index].questionId).inputSha256,
  ));
  developmentRows.sort((left, right) =>
    codeUnitCompare(left.questionId, right.questionId) ||
    CONDITIONS.indexOf(left.conditionId) - CONDITIONS.indexOf(right.conditionId)
  );
  if (developmentRows.length !== 588 ||
    developmentRows.reduce((sum, row) => sum + row.variants.length, 0) !== 1911) {
    throw new Error("development coverage changed");
  }
  const developmentBytes = serializeJsonLines(developmentRows);
  writeExclusive(absoluteOutput, "development-rankings.jsonl", developmentBytes);
  const developmentSelection = selectDevelopmentWeights(developmentRows, rowByQuestion);
  const selectedWeights = developmentSelection.selectedWeights;
  const selectedWeightArtifact = Object.freeze({
    schemaVersion: "memory-longmemeval-retrieval/selected-weights-v4",
    developmentRankingsSha256: sha256(developmentBytes),
    selectedWeights,
    selections: developmentSelection.selections,
  });
  const selectedWeightsBytes = payload(selectedWeightArtifact);
  const selectedWeightsSha256 = sha256(selectedWeightsBytes);
  writeExclusive(absoluteOutput, "selected-weights.json", selectedWeightsBytes);

  const evaluationResults = await evaluateTreatmentJobs(
    prepared.split.evaluation.map((splitRow) => ({
      input: rowByQuestion.get(splitRow.questionId).input,
      selectedWeights,
    })),
    (completed) => assertBudgets(startedAt, developmentRows.length + completed * CONDITIONS.length),
  );
  const evaluationRows = evaluationResults.flatMap((result, index) => rankingRowsForQuestion(
    result,
    "evaluation",
    rowByQuestion.get(prepared.split.evaluation[index].questionId).inputSha256,
    selectedWeightsSha256,
  ));
  evaluationRows.sort((left, right) =>
    codeUnitCompare(left.questionId, right.questionId) ||
    CONDITIONS.indexOf(left.conditionId) - CONDITIONS.indexOf(right.conditionId)
  );
  if (evaluationRows.length !== 1412 ||
    evaluationRows.reduce((sum, row) => sum + row.variants.length, 0) !== 1412) {
    throw new Error("evaluation coverage changed");
  }
  const evaluationBytes = serializeJsonLines(evaluationRows);
  writeExclusive(absoluteOutput, "evaluation-rankings.jsonl", evaluationBytes);
  const analysis = Object.freeze({
    ...analyzeEvaluation(evaluationRows, rowByQuestion, selectedWeights, developmentRows),
    selectedWeightsSha256,
    evaluationRankingsSha256: sha256(evaluationBytes),
  });
  writeExclusive(absoluteOutput, "analysis.json", payload(analysis));
  const finishedAt = new Date().toISOString();
  const manifest = Object.freeze({
    schemaVersion: "memory-longmemeval-retrieval/manifest-v4",
    attemptStatus: "complete",
    experimentId: EXPERIMENT_ID,
    experimentVersion: EXPERIMENT_VERSION,
    runId: prepared.freeze.runId,
    preregistrationSha256: prepared.freeze.preregistrationSha256,
    protocolSha256: prepared.freeze.protocolSha256,
    datasetSha256: DATASET_SHA256,
    sourceCommit: prepared.freeze.sourceCommit,
    dirtyWorktree: prepared.freeze.dirtyWorktree,
    relevantSourcesClean: true,
    configuration: { conditions: CONDITIONS, associationWeights: [0.25, 0.5, 1, 2], cutoffs: [1, 5, 10] },
    dataset: { questions: 500, developmentQuestions: 147, evaluationQuestions: 353 },
    backend: "local-deterministic-retrieval",
    modelEndpointCapabilityProfile: null,
    modelIdentifier: null,
    seeds: { bootstrap: 1296387376, shuffle: "per-question-session SHA-256" },
    executionOrder: "UTF-16 code-unit question ID, frozen condition order",
    resourceBudgets: prepared.preregistration.domainDesign.resourceBudgets,
    perCaseAccounting: { conditionRows: 2000, rankingVectors: 3323 },
    rawOutputs: { networkCalls: 0, modelCalls: 0, treatmentInputsPersisted: true },
    validatorResults: { status: "pending", path: "validation.json" },
    aggregateMetrics: { path: "analysis.json" },
    startedAt: frozenAt,
    finishedAt,
    failure: null,
  });
  writeExclusive(absoluteOutput, "run-manifest.json", payload(manifest));
  execFileSync(process.execPath, [
    repositoryPath("scripts/experiments/probes/memory-longmemeval-retrieval-v0/run-mutation-tests.mjs"),
    "--run-directory",
    absoluteOutput,
  ], {
    cwd: REPOSITORY_ROOT,
    stdio: "inherit",
    env: { ...process.env, DOLLY_RETRIEVAL_DEADLINE_MS: String(startedAt + 1_800_000) },
  });
  assertBudgets(startedAt, 2000);
  return Object.freeze({ outputDirectory: absoluteOutput, runId: prepared.freeze.runId });
}

function parseArguments(argv) {
  const runIndex = argv.indexOf("--run-id");
  if (runIndex < 0 || runIndex + 1 >= argv.length) {
    throw new TypeError("usage: run.mjs --run-id <id>");
  }
  const runId = argv[runIndex + 1];
  return {
    runId,
    output: resolve(
      REPOSITORY_ROOT,
      `artifacts/experiments/probes/memory-longmemeval-retrieval-v0/runs/${runId}`,
    ),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const result = await writeFormalRun(args.output, { runId: args.runId });
  process.stdout.write(`${stableJson(result)}\n`);
}
