#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { readStrictOpenAiToolSse } from "../strict-openai-tool-sse.mjs";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIRECTORY, "../../../..");
const EXPECTED_TOOLS = [
  "read_configuration",
  "propose_configuration_change",
  "apply_configuration_change",
  "read_configuration",
  "finish",
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function replayResponse(raw) {
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset >= raw.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 4096, raw.byteLength);
      controller.enqueue(raw.subarray(offset, end));
      offset = end;
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const index = process.argv.indexOf("--run-id");
const runId = index < 0 ? undefined : process.argv[index + 1];
if (!/^live-v1-[a-z0-9][a-z0-9-]{0,47}$/u.test(runId ?? "")) {
  throw new Error("--run-id must match live-v1-<suffix>");
}
const artifactRoot = join(ROOT, "artifacts/experiments/probes/dynamic-config-agent-live-v0", runId);
const manifest = JSON.parse(readFileSync(join(artifactRoot, "manifest.json"), "utf8"));
const preregistration = JSON.parse(readFileSync(join(artifactRoot, "preregistration.json"), "utf8"));
const result = JSON.parse(readFileSync(join(artifactRoot, "result.json"), "utf8"));
const failures = [];

const artifactPaths = manifest.artifacts.map((artifact) => artifact.path);
if (
  new Set(artifactPaths).size !== artifactPaths.length ||
  artifactPaths.some((path) => !/^(?:preregistration\.json|result\.json|round-[0-9]+\.request\.json|round-[0-9]+\.response\.sse)$/u.test(path))
) failures.push("manifest artifact inventory is duplicated or contains an unsupported path");

for (const artifact of manifest.artifacts) {
  const bytes = readFileSync(join(artifactRoot, artifact.path));
  if (bytes.byteLength !== artifact.byteLength || sha256(bytes) !== artifact.sha256) {
    failures.push(`artifact digest mismatch: ${artifact.path}`);
  }
}
if (sha256(readFileSync(join(artifactRoot, "preregistration.json"))) !== manifest.preregistrationSha256) {
  failures.push("preregistration digest mismatch");
}
for (const [label, path] of [
  ["runnerSha256", join(DIRECTORY, "run.mjs")],
  ["verifierSha256", fileURLToPath(import.meta.url)],
  ["parserSha256", join(ROOT, "scripts/experiments/probes/strict-openai-tool-sse.mjs")],
]) {
  const digest = sha256(readFileSync(path));
  if (manifest[label] !== digest || preregistration.implementation?.[label] !== digest) {
    failures.push(`${label} does not bind the current implementation`);
  }
}
if (
  result.status !== "passed" || result.failure !== null ||
  result.modelList?.sourcePresent !== true || result.modelList?.targetPresent !== true ||
  result.productConfigurationWrites !== 0 || result.moduleProcesses !== 0
) failures.push("run did not reach the frozen passing terminal state");
if (
  result.metrics?.toolSequenceExact !== true || result.metrics?.hostPolicyViolationCount !== 0 ||
  result.metrics?.modelChanged !== true || result.metrics?.contextContracted !== true ||
  result.metrics?.beforeCompactionEstimatedTokens <= 1024 ||
  result.metrics?.afterCompactionEstimatedTokens > 1024 ||
  result.metrics?.targetModelCallSucceeded !== true ||
  result.metrics?.postChangeRevisionVerified !== true
) failures.push("dynamic configuration effect gates failed");
if (canonical(result.toolEvents?.map((event) => event.name)) !== canonical(EXPECTED_TOOLS)) {
  failures.push("tool sequence differs from preregistration");
}

const roundRequests = manifest.artifacts
  .filter((artifact) => /^round-[0-9]+\.request\.json$/u.test(artifact.path))
  .sort((left, right) => left.path < right.path ? -1 : 1);
if (roundRequests.length !== result.rounds?.length || roundRequests.length < 5 || roundRequests.length > 8) {
  failures.push("round artifact count is outside the frozen plan");
}
for (let round = 0; round < roundRequests.length; round += 1) {
  const request = JSON.parse(readFileSync(join(artifactRoot, `round-${round}.request.json`), "utf8"));
  const raw = readFileSync(join(artifactRoot, `round-${round}.response.sse`));
  if (
    request.stream !== true || request.stream_options?.include_usage !== true ||
    request.thinking?.type !== "disabled" || Object.hasOwn(request, "enable_thinking") ||
    request.model !== result.rounds[round]?.requestedModel || request.temperature !== 0 ||
    request.max_tokens !== 800 || request.seed !== 4242 || request.tool_choice !== "auto" ||
    !Array.isArray(request.tools) || canonical(request.tools.map((tool) => tool?.function?.name)) !==
      canonical(["read_configuration", "propose_configuration_change", "apply_configuration_change", "finish"])
  ) failures.push(`round ${round} request encoding differs from the frozen stream profile`);
  try {
    const decoded = await readStrictOpenAiToolSse(replayResponse(raw), {
      maximumResponseBytes: 2 * 1024 * 1024,
      maximumBufferedBytes: 256 * 1024,
      maximumOutputBytes: 512 * 1024,
      maximumEvents: 20_000,
      maximumToolCalls: 8,
    });
    const message = decoded.body.choices[0].message;
    if (
      decoded.evidence.doneCount !== 1 || decoded.evidence.usageEventCount !== 1 ||
      message.reasoning_content.length !== 0 || message.tool_calls?.length !== 1 ||
      message.tool_calls[0].function.name !== EXPECTED_TOOLS[round]
    ) failures.push(`round ${round} SSE reconstruction differs from the frozen contract`);
  } catch (error) {
    failures.push(`round ${round} SSE could not be independently reconstructed: ${error instanceof Error ? error.message : "unknown"}`);
  }
}
if (result.rounds?.slice(0, 3).some((round) => round.requestedModel !== "qwen3.6-27b")) {
  failures.push("pre-change rounds did not use the source model");
}
if (result.rounds?.slice(3).some((round) => round.requestedModel !== "deepseek-v4-flash")) {
  failures.push("post-change rounds did not use the target model");
}

const environment = dotenv.parse(readFileSync(join(ROOT, ".env")));
for (const [label, value] of [["endpoint", environment.AETHER_BASE_URL], ["credential", environment.AETHER_API_KEY]]) {
  if (!value) continue;
  const needle = Buffer.from(value, "utf8");
  for (const artifact of [...manifest.artifacts, { path: "manifest.json" }]) {
    if (readFileSync(join(artifactRoot, artifact.path)).includes(needle)) {
      failures.push(`${label} leaked into ${artifact.path}`);
    }
  }
}

const validation = {
  schemaVersion: "dolly.dynamic-config-agent-validation/1",
  experimentId: preregistration.experimentId,
  runId,
  valid: failures.length === 0,
  failures,
  independentlyReparsedRounds: roundRequests.length,
  frozenClassification: result.status,
};
writeFileSync(join(artifactRoot, "validation.json"), `${canonical(validation)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${canonical(validation)}\n`);
if (!validation.valid) process.exitCode = 1;
