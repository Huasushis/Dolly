#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { readStrictChatCompletionSse } from "./memory-association-task-switch-v0/strict-chat-sse.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function loadEnv(bytes) {
  const result = {};
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

function runId(argumentsValue) {
  const index = argumentsValue.indexOf("--run-id");
  const value = index < 0 ? undefined : argumentsValue[index + 1];
  if (!/^run-[a-z0-9][a-z0-9-]{0,63}$/u.test(value ?? "")) {
    throw new Error("--run-id must match run-[a-z0-9-]+");
  }
  return value;
}

function outputName(argumentsValue) {
  const index = argumentsValue.indexOf("--output");
  const value = index < 0 ? "validation.json" : argumentsValue[index + 1];
  if (!/^validation(?:-[a-z0-9][a-z0-9-]{0,31})?\.json$/u.test(value ?? "")) {
    throw new Error("--output must be validation.json or validation-<suffix>.json");
  }
  return value;
}

const selectedRunId = runId(process.argv.slice(2));
const selectedOutputName = outputName(process.argv.slice(2));
const root = join(
  repositoryRoot,
  "artifacts/experiments/probes/gateway-strict-sse-v0",
  selectedRunId,
);
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
const request = JSON.parse(readFileSync(join(root, "request.json"), "utf8"));
const preregistration = JSON.parse(readFileSync(join(root, "preregistration.json"), "utf8"));
const raw = readFileSync(join(root, "response.sse"));
const timingText = readFileSync(join(root, "chunk-timings.jsonl"), "utf8");
const timings = timingText.trimEnd().split("\n").filter(Boolean).map(JSON.parse);
const failures = [];

for (const entry of manifest.artifacts) {
  const bytes = readFileSync(join(root, entry.path));
  if (bytes.byteLength !== entry.byteLength || sha256(bytes) !== entry.sha256) {
    failures.push(`artifact digest mismatch: ${entry.path}`);
  }
}
if (
  request.stream !== true ||
  request.stream_options?.include_usage !== true ||
  Object.hasOwn(request, "enable_thinking") ||
  preregistration.request.nonStreamFallbackAllowed !== false ||
  result.request.nonStreamFallbackUsed !== false ||
  result.request.retryCount !== 0
) failures.push("request is not the frozen single strict-stream attempt");

let cumulative = 0;
for (let index = 0; index < timings.length; index += 1) {
  const row = timings[index];
  cumulative += row.byteLength;
  if (
    row.chunkIndex !== index ||
    row.cumulativeBytes !== cumulative ||
    !Number.isFinite(row.elapsedMs) ||
    (index > 0 && row.elapsedMs < timings[index - 1].elapsedMs)
  ) failures.push(`chunk timing invariant failed at ${index}`);
}
if (cumulative !== raw.byteLength) failures.push("chunk timings do not cover raw SSE bytes");

let decoded;
try {
  let offset = 0;
  const replay = new ReadableStream({
    start(controller) {
      for (const timing of timings) {
        const end = offset + timing.byteLength;
        controller.enqueue(raw.subarray(offset, end));
        offset = end;
      }
      controller.close();
    },
  });
  decoded = await readStrictChatCompletionSse(new Response(replay, {
    status: 200,
    headers: { "content-type": result.response.contentType },
  }), {
    maximumResponseBytes: preregistration.request.maximumResponseBytes,
    maximumBufferedBytes: preregistration.request.maximumBufferedEventBytes,
    maximumOutputBytes: preregistration.request.maximumReconstructedOutputBytes,
    maximumEvents: preregistration.request.maximumEvents,
  });
} catch (error) {
  failures.push(`strict SSE reparse failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (decoded !== undefined) {
  const choice = decoded.body.choices[0];
  if (
    decoded.evidence.doneCount !== result.response.doneCount ||
    decoded.evidence.usageEventCount !== result.response.usageEventCount ||
    decoded.evidence.eventCount !== result.response.eventCount ||
    choice.finish_reason !== result.response.finishReason ||
    choice.message.reasoning_content.length !== result.response.reasoningCharacterCount ||
    choice.message.content.length !== result.response.contentCharacterCount ||
    canonical(decoded.body.usage) !== canonical(result.response.usage)
  ) failures.push("independent SSE reconstruction differs from result.json");
}

const lastChunkElapsedMs = timings.at(-1)?.elapsedMs ?? null;
if (!(lastChunkElapsedMs > 120_000) || result.response.crossedHistorical120SecondBoundary !== true) {
  failures.push("raw chunk timings do not cross the historical 120-second boundary");
}
if (
  result.status !== "failed" ||
  result.failure?.code !== "MODEL_CONTENT_INVALID" ||
  result.response.finishReason !== "length" ||
  result.response.contentCharacterCount !== 0 ||
  result.response.reasoningObserved !== true
) failures.push("frozen failed semantic classification was not preserved");

const environment = loadEnv(readFileSync(join(repositoryRoot, ".env")));
for (const [label, value] of [
  ["endpoint", environment.AETHER_BASE_URL],
  ["credential", environment.AETHER_API_KEY],
]) {
  if (!value) continue;
  const needle = Buffer.from(value, "utf8");
  for (const path of [
    "manifest.json",
    "preregistration.json",
    "request.json",
    "response.sse",
    "result.json",
    "chunk-timings.jsonl",
  ]) {
    if (readFileSync(join(root, path)).includes(needle)) failures.push(`${label} leaked into ${path}`);
  }
}

const validation = {
  schemaVersion: "dolly.gateway-sse-canary-validation/1",
  experimentId: preregistration.experimentId,
  runId: selectedRunId,
  valid: failures.length === 0,
  failures,
  strictTransportComplete:
    decoded?.evidence.doneCount === 1 && decoded?.evidence.usageEventCount === 1,
  rawTerminalCrossed120Seconds: lastChunkElapsedMs > 120_000,
  frozenOverallClassification: result.status,
  semanticFailurePreserved: result.failure?.code === "MODEL_CONTENT_INVALID",
  sourceFilesRead: [
    "manifest.json",
    "preregistration.json",
    "request.json",
    "response.sse",
    "chunk-timings.jsonl",
    "result.json",
  ],
};
writeFileSync(join(root, selectedOutputName), `${canonical(validation)}\n`, {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`${canonical(validation)}\n`);
if (!validation.valid) process.exitCode = 1;
