#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALGORITHM_VERSION,
  analyzeCases,
  agentMessages,
  buildDataset,
  datasetRow,
  evidenceForCondition,
  executionPlan,
  EXPERIMENT_ID,
  EXPERIMENT_VERSION,
  scoreCase,
  sha256,
} from "./common.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../../..");
const artifactRoot = path.join(
  repositoryRoot,
  "artifacts/experiments/probes/memory-task-state-confirmation-v0/runs",
);
const preregistrationRelativePath =
  "docs/experiments/preregistrations/memory-task-state-confirmation-v0.json";
const protocolRelativePath =
  "docs/experiments/preregistrations/memory-task-state-confirmation-v0-protocol.md";
const implementationPaths = [
  "docs/experiments/preregistrations/memory-task-state-confirmation-v0-schema.json",
  "scripts/experiments/probes/memory-task-state-confirmation-v0/common.mjs",
  "scripts/experiments/probes/memory-task-state-confirmation-v0/run.mjs",
  "scripts/experiments/probes/memory-task-state-confirmation-v0/verify.mjs",
  "scripts/experiments/probes/memory-task-state-confirmation-v0/run-mutation-tests.mjs",
  "scripts/experiments/probes/memory-task-state-confirmation-v0/validate-preregistration.mjs",
  "scripts/experiments/probes/memory-association-task-switch-v0/strict-chat-sse.mjs",
];

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--run-id" ||
    !/^aether-v1-synthetic-[a-zA-Z0-9._-]+$/u.test(argv[1])) {
    throw new Error("usage: self-test.mjs --run-id aether-v1-synthetic-<unique-suffix>");
  }
  return argv[1];
}

function jsonLines(rows) {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

function supportForScenario(scenario, evidence) {
  const available = new Set(evidence.flatMap((entry) => entry.sourceRecordIds));
  return Object.fromEntries(Object.entries(scenario.truth.claimGroups).map(([key, groups]) => [
    key,
    groups.flatMap((group) => {
      const sourceId = group.sufficientSourceIds.find((id) => available.has(id));
      return sourceId === undefined ? [] : [sourceId];
    }),
  ]));
}

function expectedOutput(scenario, evidence) {
  return {
    schemaVersion: "memory-task-state-confirmation/agent-output-v1",
    decision: scenario.truth.decision,
    decisionReason: scenario.truth.decisionReason,
    taskId: scenario.truth.taskId,
    taskState: scenario.truth.taskState,
    action: scenario.truth.action,
    constraints: scenario.truth.constraints,
    support: supportForScenario(scenario, evidence),
    uncertain: scenario.truth.uncertain,
  };
}

async function writeChecksums(runDirectory, names) {
  const rows = [];
  for (const name of [...names].sort()) {
    rows.push(`${sha256(await readFile(path.join(runDirectory, name)))}  ${name}`);
  }
  await writeFile(path.join(runDirectory, "sha256sums.txt"), `${rows.join("\n")}\n`, {
    flag: "wx",
  });
}

async function main() {
  const runId = parseArguments(process.argv.slice(2));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const preregistrationBytes = await readFile(path.join(repositoryRoot, preregistrationRelativePath));
  const protocolBytes = await readFile(path.join(repositoryRoot, protocolRelativePath));
  const preregistration = JSON.parse(preregistrationBytes);
  const runDirectory = path.join(artifactRoot, runId);
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(runDirectory, { recursive: false });

  const dataset = buildDataset(preregistration);
  const datasetRows = dataset.map(datasetRow);
  const plan = executionPlan(dataset, preregistration.randomness.executionOrderSeed);
  const scenarioById = new Map(dataset.map((scenario) => [scenario.scenarioId, scenario]));
  const rawRows = [];
  const caseRows = [];
  for (let orderIndex = 0; orderIndex < plan.length; orderIndex += 1) {
    const item = plan[orderIndex];
    const scenario = scenarioById.get(item.scenarioId);
    const evidence = evidenceForCondition(scenario, item.conditionId);
    const output = expectedOutput(scenario, evidence);
    const callId = `agent-${scenario.scenarioId.replaceAll("/", "-")}-${item.conditionId}`;
    const content = JSON.stringify(output);
    const rawRow = {
      schemaVersion: "memory-task-state-confirmation/model-raw-v1",
      callIndex: orderIndex,
      logicalCallIndex: orderIndex,
      attemptIndex: 1,
      callId,
      request: {
        model: preregistration.backend.model,
        messages: agentMessages(preregistration, scenario, item.conditionId, evidence),
        thinking: preregistration.requestProfile.thinking,
        temperature: preregistration.requestProfile.temperature,
        max_tokens: preregistration.requestProfile.max_tokens,
        stream: true,
        stream_options: { include_usage: true },
        timeout_ms: preregistration.requestProfile.timeout_ms,
      },
      httpStatus: 200,
      response: {
        model: preregistration.backend.model,
        choices: [{ index: 0, message: { role: "assistant", content, reasoning_content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
        error: null,
      },
      streamEvidence: {
        contentType: "text/event-stream",
        usageEventCount: 1,
        doneCount: 1,
        bytesAfterDone: 0,
      },
      reasoningPresent: false,
      reasoningCharacterCount: 0,
      requestStartedAt: "2000-01-01T00:00:00.000Z",
      responseFinishedAt: "2000-01-01T00:00:00.001Z",
      failureKind: null,
      contentFailure: null,
    };
    rawRows.push(rawRow);
    caseRows.push({
      schemaVersion: "memory-task-state-confirmation/case-v1",
      caseId: `${scenario.scenarioId}/${item.conditionId}`,
      orderIndex,
      scenarioId: scenario.scenarioId,
      family: scenario.family,
      cueState: scenario.cueState,
      conditionId: item.conditionId,
      activeContextIds: scenario.activeContext.map((entry) => entry.id),
      evidence,
      evidenceBytes: Buffer.byteLength(JSON.stringify(evidence), "utf8"),
      output,
      modelCallIndex: orderIndex,
      metrics: scoreCase(output, scenario, evidence),
    });
  }

  const analysis = {
    schemaVersion: "memory-task-state-confirmation/analysis-v1",
    experimentId: EXPERIMENT_ID,
    experimentVersion: EXPERIMENT_VERSION,
    runId,
    ...analyzeCases(preregistration, caseRows, rawRows),
  };
  const datasetBytes = Buffer.from(jsonLines(datasetRows));
  const casesBytes = Buffer.from(jsonLines(caseRows));
  const rawBytes = Buffer.from(jsonLines(rawRows));
  const analysisBytes = Buffer.from(`${JSON.stringify(analysis, null, 2)}\n`);
  const relevantSourceHashes = Object.fromEntries(implementationPaths.map((relativePath) => [
    relativePath,
    sha256(execFileSync("git", ["show", `${sourceCommit}:${relativePath}`], {
      cwd: repositoryRoot,
      encoding: null,
    })),
  ]));
  const manifest = {
    experimentId: EXPERIMENT_ID,
    experimentVersion: EXPERIMENT_VERSION,
    runId,
    protocolSha256: sha256(protocolBytes),
    preregistrationSha256: sha256(preregistrationBytes),
    sourceCommit,
    dirtyWorktree: true,
    relevantSourceHashes,
    backend: "synthetic-no-network-contract-self-test",
    modelIdentifier: preregistration.backend.model,
    modelEndpointCapabilityProfile: {
      routeKind: "synthetic-strict-sse-evidence",
      strictSseRequired: true,
      gatewayTimeoutKnownSeconds: preregistration.domainDesign.gatewayTimeoutSeconds,
    },
    dataset: { id: preregistration.data.generatorId, sha256: sha256(datasetBytes), rows: 16 },
    executionOrder: plan,
    resourceBudgets: {
      maxLogicalCalls: preregistration.retryPolicy.maxLogicalCalls,
      maxRequestAttempts: preregistration.retryPolicy.maxRequestAttempts,
      maxWallClockMs: preregistration.execution.maxWallClockMs,
    },
    perCaseAccounting: {
      datasetRows: 16,
      caseRows: 64,
      logicalCalls: 64,
      requestAttempts: 64,
      totalPromptTokens: 6400,
      totalCompletionTokens: 6400,
      transportRetries: 0,
      malformedHttp200: 0,
      reasoningProfileDeviations: 0,
    },
    rawOutputs: {
      preregistration: { path: "preregistration.json", sha256: sha256(preregistrationBytes) },
      dataset: { path: "dataset.jsonl", sha256: sha256(datasetBytes), rows: 16 },
      cases: { path: "cases.jsonl", sha256: sha256(casesBytes), rows: 64 },
      modelRaw: { path: "model-raw.jsonl", sha256: sha256(rawBytes), rows: 64 },
      analysis: { path: "analysis.json", sha256: sha256(analysisBytes) },
    },
    validatorResults: { status: "not-run", path: "validation.json" },
    aggregateMetrics: analysis,
    startedAt: "2000-01-01T00:00:00.000Z",
    finishedAt: "2000-01-01T00:00:01.000Z",
    failure: null,
    algorithmVersion: ALGORITHM_VERSION,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  const files = {
    "preregistration.json": preregistrationBytes,
    "dataset.jsonl": datasetBytes,
    "cases.jsonl": casesBytes,
    "model-raw.jsonl": rawBytes,
    "analysis.json": analysisBytes,
    "run-manifest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    "validation.json": Buffer.from(`${JSON.stringify({ status: "not-run", runId }, null, 2)}\n`),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(path.join(runDirectory, name), bytes, { flag: "wx" });
  }
  await writeChecksums(runDirectory, [
    "analysis.json",
    "cases.jsonl",
    "dataset.jsonl",
    "model-raw.jsonl",
    "preregistration.json",
  ]);

  execFileSync(process.execPath, [path.join(scriptDirectory, "verify.mjs"), "--run-id", runId], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [
    path.join(scriptDirectory, "run-mutation-tests.mjs"),
    "--run-id",
    runId,
  ], { cwd: repositoryRoot, stdio: "inherit" });
  process.stdout.write(`${JSON.stringify({ runId, status: "valid", networkCalls: 0 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
