#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALGORITHM_VERSION,
  analyzeCases,
  agentMessages,
  buildDataset,
  CONDITION_IDS,
  datasetRow,
  evidenceForCondition,
  executionPlan,
  EXPERIMENT_ID,
  EXPERIMENT_VERSION,
  parseStrictObject,
  scoreCase,
  sha256,
  validateAgentOutput,
} from "./common.mjs";
import {
  readBoundedResponseText,
  readStrictChatCompletionSse,
} from "../memory-association-task-switch-v0/strict-chat-sse.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../../..");
const preregistrationRelativePath =
  "docs/experiments/preregistrations/memory-task-state-confirmation-v0.json";
const protocolRelativePath =
  "docs/experiments/preregistrations/memory-task-state-confirmation-v0-protocol.md";
const artifactRoot = path.join(
  repositoryRoot,
  "artifacts/experiments/probes/memory-task-state-confirmation-v0/runs",
);
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
  if (
    argv.length !== 2 ||
    argv[0] !== "--run-id" ||
    !/^aether-v1-[a-zA-Z0-9._-]+$/u.test(argv[1])
  ) {
    throw new Error("usage: run.mjs --run-id aether-v1-<unique-suffix>");
  }
  return { runId: argv[1] };
}

function loadEnv(bytes) {
  const result = {};
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function completionUrl(baseValue) {
  const parsed = new URL(baseValue);
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "")}/v1/chat/completions`;
  return parsed;
}

function jsonLines(rows) {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

function gitOutput(args, fallback) {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

function committedBytes(relativePath) {
  return execFileSync("git", ["show", `HEAD:${relativePath}`], {
    cwd: repositoryRoot,
    encoding: null,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function assertMatchesCommit(relativePath) {
  const current = await readFile(path.join(repositoryRoot, relativePath));
  const committed = committedBytes(relativePath);
  if (!current.equals(committed)) {
    throw new Error(`frozen source differs from HEAD: ${relativePath}`);
  }
  return current;
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
  if (process.env.RUN_LIVE_INTEGRATION !== "1" || process.env.RUN_PAID_INTEGRATION !== "1") {
    throw new Error("RUN_LIVE_INTEGRATION=1 and RUN_PAID_INTEGRATION=1 are both required");
  }
  const { runId } = parseArguments(process.argv.slice(2));
  const preregistrationBytes = await assertMatchesCommit(preregistrationRelativePath);
  const preregistration = JSON.parse(preregistrationBytes);
  if (
    preregistration.experimentId !== EXPERIMENT_ID ||
    preregistration.experimentVersion !== EXPERIMENT_VERSION
  ) {
    throw new Error("unexpected preregistration identity");
  }
  const protocolBytes = await assertMatchesCommit(protocolRelativePath);
  if (sha256(protocolBytes) !== preregistration.protocol.sha256) {
    throw new Error("protocol hash mismatch");
  }
  for (const relativePath of implementationPaths) await assertMatchesCommit(relativePath);
  const preregistrationValidation = JSON.parse(execFileSync(process.execPath, [
    path.join(scriptDirectory, "validate-preregistration.mjs"),
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }));
  if (preregistrationValidation.valid !== true) {
    throw new Error("preregistration validation failed before the live run");
  }

  const fileEnv = loadEnv(await readFile(path.join(repositoryRoot, ".env")));
  const environment = { ...fileEnv, ...process.env };
  const apiKey = environment.AETHER_API_KEY;
  const baseUrl = environment.AETHER_BASE_URL;
  if (!apiKey || !baseUrl) throw new Error("Aether credentials are missing");
  const requestUrl = completionUrl(baseUrl);
  if (requestUrl.origin !== new URL(baseUrl).origin) {
    throw new Error("request route escaped the configured Aether origin");
  }

  const runDirectory = path.join(artifactRoot, runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path.join(runDirectory, "preregistration.json"), preregistrationBytes, {
    flag: "wx",
  });
  const modelRawPath = path.join(runDirectory, "model-raw.jsonl");
  const casesPath = path.join(runDirectory, "cases.jsonl");
  await writeFile(modelRawPath, "", { flag: "wx" });
  await writeFile(casesPath, "", { flag: "wx" });

  const startedAt = new Date().toISOString();
  const dataset = buildDataset(preregistration);
  const datasetRows = dataset.map(datasetRow);
  const datasetBytes = jsonLines(datasetRows);
  await writeFile(path.join(runDirectory, "dataset.jsonl"), datasetBytes, { flag: "wx" });
  const scenarioById = new Map(dataset.map((scenario) => [scenario.scenarioId, scenario]));
  const plan = executionPlan(dataset, preregistration.randomness.executionOrderSeed);
  const rawRows = [];
  const caseRows = [];
  let logicalCallIndex = 0;

  async function persistRaw(row) {
    rawRows.push(row);
    await appendFile(modelRawPath, `${JSON.stringify(row)}\n`);
  }

  async function callModel({ callId, messages }) {
    if (logicalCallIndex >= preregistration.retryPolicy.maxLogicalCalls) {
      throw new Error("logical-call budget exhausted");
    }
    if (Date.now() - Date.parse(startedAt) >= preregistration.execution.maxWallClockMs) {
      throw new Error("experiment wall-clock budget exhausted");
    }
    const requestBody = {
      model: preregistration.backend.model,
      messages,
      thinking: preregistration.requestProfile.thinking,
      temperature: preregistration.requestProfile.temperature,
      max_tokens: preregistration.requestProfile.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if ("enable_thinking" in requestBody) throw new Error("enable_thinking is forbidden");
    const currentLogicalCallIndex = logicalCallIndex;
    logicalCallIndex += 1;
    for (
      let attemptIndex = 1;
      attemptIndex <= preregistration.retryPolicy.maxAttemptsPerLogicalCall;
      attemptIndex += 1
    ) {
      if (rawRows.length >= preregistration.retryPolicy.maxRequestAttempts) {
        throw new Error("request-attempt budget exhausted");
      }
      const callIndex = rawRows.length;
      const requestStartedAt = new Date().toISOString();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), preregistration.requestProfile.timeout_ms);
      let response;
      try {
        response = await fetch(requestUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const failureKind = error?.name === "AbortError"
          ? "timeout"
          : "network-before-response-headers";
        await persistRaw({
          schemaVersion: "memory-task-state-confirmation/model-raw-v1",
          callIndex,
          logicalCallIndex: currentLogicalCallIndex,
          attemptIndex,
          callId,
          request: { ...requestBody, timeout_ms: preregistration.requestProfile.timeout_ms },
          httpStatus: null,
          response: null,
          streamEvidence: null,
          reasoningPresent: false,
          reasoningCharacterCount: 0,
          requestStartedAt,
          responseFinishedAt: new Date().toISOString(),
          failureKind,
        });
        if (attemptIndex < preregistration.retryPolicy.maxAttemptsPerLogicalCall) {
          await new Promise((resolvePromise) =>
            setTimeout(resolvePromise, preregistration.retryPolicy.retryDelayMs)
          );
          continue;
        }
        throw new Error(`transport exhausted for ${callId}: ${failureKind}`);
      }

      let body = null;
      let streamEvidence = null;
      try {
        if (response.ok) {
          const parsedStream = await readStrictChatCompletionSse(response, {
            maximumResponseBytes: 2 * 1024 * 1024,
            maximumBufferedBytes: 256 * 1024,
            maximumOutputBytes: 512 * 1024,
            maximumEvents: 20_000,
          });
          body = parsedStream.body;
          streamEvidence = parsedStream.evidence;
        } else {
          const text = await readBoundedResponseText(response, 2 * 1024 * 1024);
          try {
            body = JSON.parse(text);
          } catch {
            body = { error: { message: "non-JSON provider error response" } };
          }
        }
      } catch (error) {
        clearTimeout(timer);
        const failureKind = error?.name === "AbortError" ? "timeout" : "stream-protocol";
        await persistRaw({
          schemaVersion: "memory-task-state-confirmation/model-raw-v1",
          callIndex,
          logicalCallIndex: currentLogicalCallIndex,
          attemptIndex,
          callId,
          request: { ...requestBody, timeout_ms: preregistration.requestProfile.timeout_ms },
          httpStatus: response.status,
          response: null,
          streamEvidence: null,
          reasoningPresent: false,
          reasoningCharacterCount: 0,
          requestStartedAt,
          responseFinishedAt: new Date().toISOString(),
          failureKind,
        });
        throw new Error(`strict SSE failure for ${callId}: ${failureKind}`);
      } finally {
        clearTimeout(timer);
      }

      const message = body?.choices?.[0]?.message;
      const reasoningContent = typeof message?.reasoning_content === "string"
        ? message.reasoning_content
        : "";
      let parsed = null;
      let contentFailure = null;
      if (response.ok && message) {
        try {
          parsed = validateAgentOutput(
            preregistration,
            parseStrictObject(message.content),
          );
        } catch (error) {
          contentFailure = error instanceof Error ? error.message : String(error);
        }
      }
      const retryableStatus = [408, 425, 429].includes(response.status) || response.status >= 500;
      const failureKind = !response.ok
        ? retryableStatus
          ? "retryable-http"
          : "terminal-http"
        : !message || contentFailure
          ? "content-or-schema"
          : null;
      const rawRow = {
        schemaVersion: "memory-task-state-confirmation/model-raw-v1",
        callIndex,
        logicalCallIndex: currentLogicalCallIndex,
        attemptIndex,
        callId,
        request: { ...requestBody, timeout_ms: preregistration.requestProfile.timeout_ms },
        httpStatus: response.status,
        response: {
          model: body?.model ?? null,
          choices: body?.choices ?? null,
          usage: body?.usage ?? null,
          error: body?.error ?? null,
        },
        streamEvidence,
        reasoningPresent: reasoningContent.trim().length > 0,
        reasoningCharacterCount: reasoningContent.length,
        requestStartedAt,
        responseFinishedAt: new Date().toISOString(),
        failureKind,
        contentFailure,
      };
      await persistRaw(rawRow);
      if (retryableStatus && attemptIndex < preregistration.retryPolicy.maxAttemptsPerLogicalCall) {
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, preregistration.retryPolicy.retryDelayMs)
        );
        continue;
      }
      if (!response.ok) throw new Error(`HTTP failure for ${callId}: ${response.status}`);
      return { parsed, rawRow };
    }
    throw new Error("unreachable model call state");
  }

  for (let orderIndex = 0; orderIndex < plan.length; orderIndex += 1) {
    const item = plan[orderIndex];
    const scenario = scenarioById.get(item.scenarioId);
    if (!scenario || !CONDITION_IDS.includes(item.conditionId)) {
      throw new Error("execution plan references an unknown case");
    }
    const evidence = evidenceForCondition(scenario, item.conditionId);
    const messages = agentMessages(preregistration, scenario, item.conditionId, evidence);
    const result = await callModel({
      callId: `agent-${scenario.scenarioId.replaceAll("/", "-")}-${item.conditionId}`,
      messages,
    });
    const metrics = scoreCase(
      result.parsed,
      scenario,
      evidence,
      result.rawRow.failureKind === "content-or-schema",
    );
    const row = {
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
      output: result.parsed,
      modelCallIndex: result.rawRow.callIndex,
      metrics,
    };
    caseRows.push(row);
    await appendFile(casesPath, `${JSON.stringify(row)}\n`);
  }

  if (logicalCallIndex !== 64 || caseRows.length !== 64) {
    throw new Error(`planned coverage mismatch: ${logicalCallIndex}/${caseRows.length}`);
  }
  const analysis = {
    schemaVersion: "memory-task-state-confirmation/analysis-v1",
    experimentId: EXPERIMENT_ID,
    experimentVersion: EXPERIMENT_VERSION,
    runId,
    ...analyzeCases(preregistration, caseRows, rawRows),
  };
  const casesBytes = await readFile(casesPath);
  const rawBytes = await readFile(modelRawPath);
  const analysisBytes = `${JSON.stringify(analysis, null, 2)}\n`;
  await writeFile(path.join(runDirectory, "analysis.json"), analysisBytes, { flag: "wx" });
  const relevantSourceHashes = {};
  for (const relativePath of implementationPaths) {
    relevantSourceHashes[relativePath] = sha256(await readFile(path.join(repositoryRoot, relativePath)));
  }
  const sourceCommit = gitOutput(["rev-parse", "HEAD"], "unavailable");
  const dirtyStatus = gitOutput(["status", "--short"], "unavailable");
  const manifest = {
    experimentId: EXPERIMENT_ID,
    experimentVersion: EXPERIMENT_VERSION,
    runId,
    protocolSha256: sha256(protocolBytes),
    preregistrationSha256: sha256(preregistrationBytes),
    sourceCommit,
    dirtyWorktree: dirtyStatus === "unavailable" ? "unavailable" : dirtyStatus.length > 0,
    relevantSourceHashes,
    backend: "owner-aether-qwen36",
    modelIdentifier: preregistration.backend.model,
    modelEndpointCapabilityProfile: {
      routeKind: "openai-compatible-chat-completions",
      strictSseRequired: true,
      gatewayTimeoutKnownSeconds: preregistration.domainDesign.gatewayTimeoutSeconds,
    },
    dataset: {
      id: preregistration.data.generatorId,
      sha256: sha256(datasetBytes),
      rows: datasetRows.length,
    },
    executionOrder: plan,
    resourceBudgets: {
      maxLogicalCalls: preregistration.retryPolicy.maxLogicalCalls,
      maxRequestAttempts: preregistration.retryPolicy.maxRequestAttempts,
      maxWallClockMs: preregistration.execution.maxWallClockMs,
    },
    perCaseAccounting: {
      datasetRows: datasetRows.length,
      caseRows: caseRows.length,
      logicalCalls: logicalCallIndex,
      requestAttempts: rawRows.length,
      totalPromptTokens: rawRows.reduce(
        (sum, row) => sum + (row.response?.usage?.prompt_tokens ?? 0),
        0,
      ),
      totalCompletionTokens: rawRows.reduce(
        (sum, row) => sum + (row.response?.usage?.completion_tokens ?? 0),
        0,
      ),
      transportRetries: rawRows.length - logicalCallIndex,
      malformedHttp200: rawRows.filter((row) => row.failureKind === "content-or-schema").length,
      reasoningProfileDeviations: rawRows.filter((row) => row.reasoningPresent).length,
    },
    rawOutputs: {
      preregistration: {
        path: "preregistration.json",
        sha256: sha256(preregistrationBytes),
      },
      dataset: { path: "dataset.jsonl", sha256: sha256(datasetBytes), rows: datasetRows.length },
      cases: { path: "cases.jsonl", sha256: sha256(casesBytes), rows: caseRows.length },
      modelRaw: { path: "model-raw.jsonl", sha256: sha256(rawBytes), rows: rawRows.length },
      analysis: { path: "analysis.json", sha256: sha256(analysisBytes) },
    },
    validatorResults: { status: "not-run", path: "validation.json" },
    aggregateMetrics: analysis,
    startedAt,
    finishedAt: new Date().toISOString(),
    failure: null,
    algorithmVersion: ALGORITHM_VERSION,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  await writeFile(
    path.join(runDirectory, "run-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(
    path.join(runDirectory, "validation.json"),
    `${JSON.stringify({ status: "not-run", runId }, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeChecksums(runDirectory, [
    "analysis.json",
    "cases.jsonl",
    "dataset.jsonl",
    "model-raw.jsonl",
    "preregistration.json",
  ]);
  process.stdout.write(`${JSON.stringify({
    runId,
    logicalCalls: logicalCallIndex,
    requestAttempts: rawRows.length,
    classification: analysis.classification,
    decisions: analysis.decisions,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
