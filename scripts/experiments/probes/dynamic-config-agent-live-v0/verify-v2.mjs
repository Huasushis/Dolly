#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { readStrictOpenAiToolSse } from "../strict-openai-tool-sse.mjs";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIRECTORY, "../../../..");
const SOURCE_MODEL = "qwen3.6-27b";
const TARGET_MODEL = "deepseek-v4-flash";
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

function closed(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function revision(configuration) {
  return `sha256:${sha256(canonical(configuration))}`;
}

function estimatedTokens(value) {
  return Math.ceil(Buffer.byteLength(canonical(value), "utf8") / 4);
}

function toolDefinitions() {
  const empty = { type: "object", additionalProperties: false, properties: {}, required: [] };
  return [
    {
      type: "function",
      function: {
        name: "read_configuration",
        description: "Read the redacted host-owned effective Agent configuration. Call this first and again after apply.",
        parameters: empty,
      },
    },
    {
      type: "function",
      function: {
        name: "propose_configuration_change",
        description: "Validate, but do not apply, the exact requested replacement.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            expectedRevision: { type: "string" },
            replacement: {
              type: "object",
              additionalProperties: false,
              properties: {
                contextContractionPolicy: { type: "string", const: "structured-checkpoint" },
                contextLimitTokens: { type: "integer", const: 1024 },
                maxResponseBytes: { type: "integer", const: 1048576 },
                modelId: { type: "string", const: TARGET_MODEL },
              },
              required: ["contextContractionPolicy", "contextLimitTokens", "maxResponseBytes", "modelId"],
            },
          },
          required: ["expectedRevision", "replacement"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "apply_configuration_change",
        description: "Apply one exact validated plan identifier.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { planId: { type: "string" } },
          required: ["planId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish",
        description: "Finish only after the post-change read, using its exact revision.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            observedRevision: { type: "string" },
            status: { type: "string", const: "completed" },
          },
          required: ["observedRevision", "status"],
        },
      },
    },
  ];
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

function parseCanonical(files, name, failures) {
  const bytes = files.get(name);
  if (bytes === undefined) {
    failures.push(`missing ${name}`);
    return null;
  }
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!bytes.equals(Buffer.from(`${canonical(value)}\n`, "utf8"))) {
      failures.push(`${name} is not canonical JSON`);
    }
    return value;
  } catch {
    failures.push(`${name} is not JSON`);
    return null;
  }
}

function executePolicy(state, name, argumentText) {
  let args;
  try {
    args = JSON.parse(argumentText);
  } catch {
    throw new Error(`${name} arguments are not JSON`);
  }
  if (name === "read_configuration") {
    if (!closed(args, [])) throw new Error("read_configuration arguments are invalid");
    if (state.applied) state.readAfter = true;
    else state.readBefore = true;
    state.events.push({ name, outcome: "SUCCEEDED" });
    return { code: "SUCCEEDED", configuration: state.current };
  }
  if (name === "propose_configuration_change") {
    const replacement = args?.replacement;
    if (
      !state.readBefore || !closed(args, ["expectedRevision", "replacement"]) ||
      args.expectedRevision !== state.current.revision ||
      !closed(replacement, ["contextContractionPolicy", "contextLimitTokens", "maxResponseBytes", "modelId"]) ||
      replacement.contextContractionPolicy !== "structured-checkpoint" ||
      replacement.contextLimitTokens !== 1024 || replacement.maxResponseBytes !== 1048576 ||
      replacement.modelId !== TARGET_MODEL
    ) throw new Error("configuration proposal is invalid");
    const next = { ...replacement };
    const proposed = Object.freeze({ ...next, revision: revision(next) });
    const planId = `sha256:${sha256(canonical({ expected: state.current.revision, proposed: proposed.revision }))}`;
    state.plan = { planId, expected: state.current.revision, proposed };
    state.events.push({ name, outcome: "VALIDATED" });
    return { code: "VALIDATED", planId, proposedRevision: proposed.revision, requiresContextRebuild: true };
  }
  if (name === "apply_configuration_change") {
    if (
      !closed(args, ["planId"]) || state.plan === null ||
      args.planId !== state.plan.planId || state.current.revision !== state.plan.expected
    ) throw new Error("configuration plan is invalid or stale");
    state.current = state.plan.proposed;
    state.applied = true;
    state.events.push({ name, outcome: "APPLIED" });
    return { code: "APPLIED", effectiveRevision: state.current.revision, requiresContextRebuild: true };
  }
  if (name === "finish") {
    if (
      !state.readAfter || !closed(args, ["observedRevision", "status"]) ||
      args.status !== "completed" || args.observedRevision !== state.current.revision
    ) throw new Error("finish did not bind the post-change revision");
    state.finished = true;
    state.events.push({ name, outcome: "COMPLETED" });
    return { code: "COMPLETED" };
  }
  throw new Error(`unsupported tool ${name}`);
}

function initialMessages() {
  const system = {
    role: "system",
    content: "You are a general Agent. Manage configuration only through one host tool per response. Use exactly: read, propose, apply, read, finish. Never claim a change before the host returns success.",
  };
  const inertHistory = Array.from({ length: 900 }, (_, index) => `archived-note-${index % 17}`).join(" ");
  return {
    system,
    messages: [
      system,
      {
        role: "user",
        content: `Change modelId from ${SOURCE_MODEL} to ${TARGET_MODEL}, lower contextLimitTokens from 8192 to 1024, set contextContractionPolicy to structured-checkpoint, preserve maxResponseBytes at 1048576, then verify and finish. Inert history forces contraction:\n${inertHistory}`,
      },
    ],
  };
}

function implementationBytes() {
  return {
    runnerSha256: readFileSync(join(DIRECTORY, "run.mjs")),
    verifierSha256: readFileSync(join(DIRECTORY, "verify.mjs")),
    parserSha256: readFileSync(join(ROOT, "scripts/experiments/probes/strict-openai-tool-sse.mjs")),
  };
}

export function loadBundle(artifactRoot) {
  return new Map(readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => [entry.name, readFileSync(join(artifactRoot, entry.name))]));
}

export async function validateBundle({ files, runId, privateValues = [], sourceBytes = implementationBytes() }) {
  const failures = [];
  const preregistrationBytes = files.get("preregistration.json");
  let preregistration;
  try {
    preregistration = JSON.parse(preregistrationBytes?.toString("utf8") ?? "");
  } catch {
    failures.push("preregistration.json is not JSON");
    preregistration = {};
  }
  const manifest = parseCanonical(files, "manifest.json", failures) ?? {};
  const result = parseCanonical(files, "result.json", failures) ?? {};
  const expectedNames = new Set([
    "manifest.json", "preregistration.json", "result.json", "validation.json",
    ...Array.from({ length: 5 }, (_, index) => [`round-${index}.request.json`, `round-${index}.response.sse`]).flat(),
  ]);
  if (
    files.size !== expectedNames.size ||
    [...files.keys()].some((name) => !expectedNames.has(name)) ||
    [...expectedNames].some((name) => !files.has(name))
  ) failures.push("artifact directory inventory is not exact");
  if (
    manifest.schemaVersion !== "dolly.dynamic-config-agent-manifest/1" ||
    manifest.experimentId !== "dynamic-config-agent-live-v0" || manifest.runId !== runId ||
    result.schemaVersion !== "dolly.dynamic-config-agent-result/1" ||
    result.experimentId !== manifest.experimentId || result.runId !== runId ||
    preregistration.experimentId !== manifest.experimentId || preregistration.experimentVersion !== 1
  ) failures.push("experiment or run identity is inconsistent");
  if (
    preregistrationBytes === undefined || sha256(preregistrationBytes) !== manifest.preregistrationSha256 ||
    preregistrationBytes === undefined ||
    !preregistrationBytes.equals(readFileSync(join(ROOT, "docs/experiments/preregistrations/dynamic-config-agent-live-v0.json")))
  ) failures.push("preregistration is not the frozen repository file");
  for (const [label, bytes] of Object.entries(sourceBytes)) {
    const digest = sha256(bytes);
    if (manifest[label] !== digest || preregistration.implementation?.[label] !== digest) {
      failures.push(`${label} does not bind the frozen implementation`);
    }
  }
  const artifactNames = [
    "preregistration.json",
    ...Array.from({ length: 5 }, (_, index) => [`round-${index}.request.json`, `round-${index}.response.sse`]).flat(),
    "result.json",
  ];
  if (
    !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== artifactNames.length ||
    canonical(manifest.artifacts.map((artifact) => artifact.path)) !== canonical(artifactNames)
  ) failures.push("manifest inventory does not list the exact ordered evidence set");
  for (const artifact of manifest.artifacts ?? []) {
    const bytes = files.get(artifact.path);
    if (
      bytes === undefined || bytes.byteLength !== artifact.byteLength ||
      sha256(bytes) !== artifact.sha256 ||
      !closed(artifact, ["byteLength", "path", "sha256"])
    ) failures.push(`artifact digest mismatch: ${artifact.path}`);
  }

  const initial = initialMessages();
  let messages = initial.messages;
  const tools = toolDefinitions();
  const initialConfiguration = {
    contextContractionPolicy: "reject",
    contextLimitTokens: 8192,
    maxResponseBytes: 1048576,
    modelId: SOURCE_MODEL,
  };
  const state = {
    current: Object.freeze({ ...initialConfiguration, revision: revision(initialConfiguration) }),
    plan: null,
    readBefore: false,
    readAfter: false,
    applied: false,
    finished: false,
    events: [],
  };
  const reconstructedRounds = [];
  let beforeCompaction = null;
  let afterCompaction = null;
  for (let round = 0; round < 5; round += 1) {
    const request = parseCanonical(files, `round-${round}.request.json`, failures);
    if (request === null) continue;
    const expectedModel = round < 3 ? SOURCE_MODEL : TARGET_MODEL;
    if (
      !closed(request, ["max_tokens", "messages", "model", "seed", "stream", "stream_options", "temperature", "thinking", "tool_choice", "tools"]) ||
      request.model !== expectedModel || request.max_tokens !== 800 || request.seed !== 4242 ||
      request.stream !== true || request.stream_options?.include_usage !== true ||
      !closed(request.stream_options, ["include_usage"]) || request.temperature !== 0 ||
      request.thinking?.type !== "disabled" || !closed(request.thinking, ["type"]) ||
      Object.hasOwn(request, "enable_thinking") || request.tool_choice !== "auto" ||
      canonical(request.tools) !== canonical(tools) || canonical(request.messages) !== canonical(messages)
    ) failures.push(`round ${round} request is not the reconstructed host request`);
    const raw = files.get(`round-${round}.response.sse`);
    if (raw === undefined) {
      failures.push(`round ${round} response is missing`);
      continue;
    }
    try {
      const decoded = await readStrictOpenAiToolSse(replayResponse(raw), {
        maximumResponseBytes: 2 * 1024 * 1024,
        maximumBufferedBytes: 256 * 1024,
        maximumOutputBytes: 512 * 1024,
        maximumEvents: 20_000,
        maximumToolCalls: 8,
      });
      const message = decoded.body.choices[0].message;
      const calls = message.tool_calls ?? [];
      if (
        decoded.evidence.doneCount !== 1 || decoded.evidence.usageEventCount !== 1 ||
        message.reasoning_content.length !== 0 || calls.length !== 1 ||
        calls[0].function.name !== EXPECTED_TOOLS[round]
      ) throw new Error("stream terminal or tool sequence is invalid");
      const toolResult = executePolicy(state, calls[0].function.name, calls[0].function.arguments);
      const reportedContentType = result.rounds?.[round]?.streamEvidence?.contentType;
      if (typeof reportedContentType !== "string" || !/^text\/event-stream(?:\s*;|$)/iu.test(reportedContentType)) {
        failures.push(`round ${round} did not report an SSE response content type`);
      }
      reconstructedRounds.push({
        round,
        requestedModel: expectedModel,
        requestEstimatedTokens: estimatedTokens(messages),
        finishReason: decoded.body.choices[0].finish_reason,
        responseModelPresent: typeof decoded.body.model === "string",
        usage: decoded.body.usage,
        streamEvidence: { ...decoded.evidence, contentType: reportedContentType },
        toolName: calls[0].function.name,
        toolOutcome: state.events.at(-1).outcome,
      });
      messages = [
        ...messages,
        { role: "assistant", content: message.content, tool_calls: calls },
        { role: "tool", tool_call_id: calls[0].id, content: canonical(toolResult) },
      ];
      if (round === 2) {
        beforeCompaction = estimatedTokens(messages);
        messages = [
          initial.system,
          {
            role: "user",
            content: `Trusted host checkpoint: configuration ${state.current.revision} is effective with model ${state.current.modelId}, contextLimitTokens ${state.current.contextLimitTokens}, contextContractionPolicy ${state.current.contextContractionPolicy}, and maxResponseBytes ${state.current.maxResponseBytes}. Continue: call read_configuration, then finish with the observed revision.`,
          },
        ];
        afterCompaction = estimatedTokens(messages);
      }
    } catch (error) {
      failures.push(`round ${round} response cannot reconstruct the state transition: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  const expectedMetrics = {
    strictStreamRoundCount: 5,
    toolSequenceExact: true,
    hostPolicyViolationCount: 0,
    modelChanged: state.applied && state.current.modelId === TARGET_MODEL,
    contextContracted: state.applied && state.current.contextLimitTokens === 1024,
    beforeCompactionEstimatedTokens: beforeCompaction,
    afterCompactionEstimatedTokens: afterCompaction,
    targetModelCallSucceeded: reconstructedRounds.some((round) => round.requestedModel === TARGET_MODEL),
    postChangeRevisionVerified: state.readAfter && state.finished,
  };
  if (
    result.status !== "passed" || result.failure !== null || result.productConfigurationWrites !== 0 ||
    result.moduleProcesses !== 0 || result.endpointRecorded !== false || result.credentialRecorded !== false ||
    result.modelList?.sourcePresent !== true || result.modelList?.targetPresent !== true ||
    canonical(result.rounds) !== canonical(reconstructedRounds) ||
    canonical(result.toolEvents) !== canonical(state.events) ||
    canonical(result.metrics) !== canonical(expectedMetrics)
  ) failures.push("result does not equal independently reconstructed per-round evidence");
  for (const [name, bytes] of files) {
    for (const value of privateValues) {
      if (value && bytes.includes(Buffer.from(value, "utf8"))) failures.push(`private bytes leaked into ${name}`);
    }
  }
  return {
    schemaVersion: "dolly.dynamic-config-agent-validation/2",
    experimentId: "dynamic-config-agent-live-v0",
    runId,
    valid: failures.length === 0,
    failures,
    independentlyReconstructedRounds: reconstructedRounds.length,
    modelListEvidence: "runner-reported; chat dispatch independently proves both requested model identifiers were accepted",
    responseContentTypeEvidence: "runner-reported; raw event framing, terminal usage, DONE, identity, and tool calls independently reconstructed",
    frozenV1Classification: result.status ?? null,
  };
}

async function main() {
  const index = process.argv.indexOf("--run-id");
  const runId = index < 0 ? undefined : process.argv[index + 1];
  if (!/^live-v1-[a-z0-9][a-z0-9-]{0,47}$/u.test(runId ?? "")) {
    throw new Error("--run-id must match live-v1-<suffix>");
  }
  const artifactRoot = join(ROOT, "artifacts/experiments/probes/dynamic-config-agent-live-v0", runId);
  const environment = dotenv.parse(readFileSync(join(ROOT, ".env")));
  const validation = await validateBundle({
    files: loadBundle(artifactRoot),
    runId,
    privateValues: [environment.AETHER_BASE_URL, environment.AETHER_API_KEY],
  });
  writeFileSync(join(artifactRoot, "validation-v2.json"), `${canonical(validation)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${canonical(validation)}\n`);
  if (!validation.valid) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
