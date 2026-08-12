#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import dotenv from "dotenv";
import { readStrictOpenAiToolSse } from "../strict-openai-tool-sse.mjs";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIRECTORY, "../../../..");
const PREREGISTRATION_PATH = join(
  ROOT,
  "docs/experiments/preregistrations/dynamic-config-agent-live-v0.json",
);
const PARSER_PATH = join(ROOT, "scripts/experiments/probes/strict-openai-tool-sse.mjs");
const ENV_PATH = join(ROOT, ".env");
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

function parseArguments(values) {
  const index = values.indexOf("--run-id");
  const runId = index < 0 ? undefined : values[index + 1];
  if (!/^live-v1-[a-z0-9][a-z0-9-]{0,47}$/u.test(runId ?? "")) {
    throw new Error("--run-id must match live-v1-<suffix>");
  }
  return { runId };
}

function writeExclusive(path, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${canonical(value)}\n`, "utf8");
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return { path: path.split("/").at(-1), byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

function assertNoPrivate(bytes, privateValues, label) {
  for (const value of privateValues) {
    if (value && bytes.includes(Buffer.from(value, "utf8"))) {
      throw new Error(`${label} contains configured private bytes`);
    }
  }
}

function baseUrl(value) {
  const url = new URL(value);
  if (
    url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
  ) throw new Error("AETHER_BASE_URL is invalid");
  url.pathname = `${url.pathname.replace(/\/+$/u, "").replace(/\/chat\/completions$/u, "").replace(/\/v1$/u, "")}/v1/`;
  return url;
}

function route(root, suffix) {
  const url = new URL(root);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${suffix}`;
  return url;
}

async function boundedBytes(response, maximumBytes) {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel("response limit exceeded");
      throw new Error("response exceeded byte limit");
    }
    chunks.push(Buffer.from(item.value));
  }
  return Buffer.concat(chunks);
}

async function modelList(configuration) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(route(configuration.base, "models"), {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${configuration.apiKey}` },
      signal: controller.signal,
    });
    const bytes = await boundedBytes(response, 2 * 1024 * 1024);
    if (!response.ok) throw new Error(`model list returned HTTP ${response.status}`);
    const body = JSON.parse(bytes.toString("utf8"));
    const ids = new Set(Array.isArray(body?.data)
      ? body.data.map((entry) => entry?.id).filter((id) => typeof id === "string")
      : []);
    if (!ids.has(SOURCE_MODEL) || !ids.has(TARGET_MODEL)) {
      throw new Error("frozen source or target model is not listed");
    }
    return { count: ids.size, sourcePresent: true, targetPresent: true };
  } finally {
    clearTimeout(timer);
  }
}

async function readRaw(stream, maximumBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel("raw response limit exceeded");
      throw new Error("raw SSE exceeded byte limit");
    }
    chunks.push(Buffer.from(item.value));
  }
  return Buffer.concat(chunks);
}

async function chat(configuration, requestBody) {
  if (Object.hasOwn(requestBody, "stream") || Object.hasOwn(requestBody, "enable_thinking")) {
    throw new Error("caller attempted to override frozen stream encoding");
  }
  const wire = {
    ...requestBody,
    thinking: { type: "disabled" },
    stream: true,
    stream_options: { include_usage: true },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_800_000);
  try {
    const response = await fetch(route(configuration.base, "chat/completions"), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${configuration.apiKey}`,
        "content-type": "application/json",
      },
      body: canonical(wire),
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      await boundedBytes(response, 2 * 1024 * 1024);
      throw new Error(`chat returned HTTP ${response.status}`);
    }
    const [parserBranch, rawBranch] = response.body.tee();
    const [parsed, raw] = await Promise.all([
      readStrictOpenAiToolSse(new Response(parserBranch, {
        status: response.status,
        headers: response.headers,
      }), {
        maximumResponseBytes: 2 * 1024 * 1024,
        maximumBufferedBytes: 256 * 1024,
        maximumOutputBytes: 512 * 1024,
        maximumEvents: 20_000,
        maximumToolCalls: 8,
      }),
      readRaw(rawBranch, 2 * 1024 * 1024),
    ]);
    return { wire, parsed, raw };
  } finally {
    clearTimeout(timer);
  }
}

function revision(configuration) {
  return `sha256:${sha256(canonical(configuration))}`;
}

function closed(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

class ConfigurationPolicy {
  constructor() {
    this.current = Object.freeze({
      contextContractionPolicy: "reject",
      contextLimitTokens: 8192,
      maxResponseBytes: 1048576,
      modelId: SOURCE_MODEL,
    });
    this.current = Object.freeze({ ...this.current, revision: revision(this.current) });
    this.plan = null;
    this.readBefore = false;
    this.readAfter = false;
    this.applied = false;
    this.finished = false;
    this.policyViolations = 0;
    this.events = [];
  }

  execute(name, argumentText) {
    let args;
    try {
      args = JSON.parse(argumentText);
    } catch {
      return this.refuse(name, "ARGUMENTS_INVALID_JSON");
    }
    if (name === "read_configuration") {
      if (!closed(args, [])) return this.refuse(name, "ARGUMENTS_SCHEMA_INVALID");
      if (this.applied) this.readAfter = true;
      else this.readBefore = true;
      this.events.push({ name, outcome: "SUCCEEDED" });
      return { code: "SUCCEEDED", configuration: this.current };
    }
    if (name === "propose_configuration_change") {
      const replacement = args?.replacement;
      if (
        !this.readBefore || !closed(args, ["expectedRevision", "replacement"]) ||
        args.expectedRevision !== this.current.revision ||
        !closed(replacement, ["contextContractionPolicy", "contextLimitTokens", "maxResponseBytes", "modelId"]) ||
        replacement.contextContractionPolicy !== "structured-checkpoint" ||
        replacement.contextLimitTokens !== 1024 || replacement.maxResponseBytes !== 1048576 ||
        replacement.modelId !== TARGET_MODEL
      ) return this.refuse(name, "PROPOSAL_INVALID");
      const nextWithoutRevision = { ...replacement };
      const proposed = Object.freeze({ ...nextWithoutRevision, revision: revision(nextWithoutRevision) });
      const planId = `sha256:${sha256(canonical({ expected: this.current.revision, proposed: proposed.revision }))}`;
      this.plan = { planId, expected: this.current.revision, proposed };
      this.events.push({ name, outcome: "VALIDATED" });
      return { code: "VALIDATED", planId, proposedRevision: proposed.revision, requiresContextRebuild: true };
    }
    if (name === "apply_configuration_change") {
      if (
        !closed(args, ["planId"]) || this.plan === null ||
        args.planId !== this.plan.planId || this.current.revision !== this.plan.expected
      ) return this.refuse(name, "PLAN_INVALID_OR_STALE");
      this.current = this.plan.proposed;
      this.applied = true;
      this.events.push({ name, outcome: "APPLIED" });
      return { code: "APPLIED", effectiveRevision: this.current.revision, requiresContextRebuild: true };
    }
    if (name === "finish") {
      if (
        !this.readAfter || !closed(args, ["observedRevision", "status"]) ||
        args.status !== "completed" || args.observedRevision !== this.current.revision
      ) return this.refuse(name, "POST_CHANGE_READ_REQUIRED");
      this.finished = true;
      this.events.push({ name, outcome: "COMPLETED" });
      return { code: "COMPLETED" };
    }
    return this.refuse(name, "TOOL_NOT_ALLOWED");
  }

  refuse(name, code) {
    this.policyViolations += 1;
    this.events.push({ name, outcome: code });
    return { accepted: false, code };
  }
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

function estimatedTokens(value) {
  return Math.ceil(Buffer.byteLength(canonical(value), "utf8") / 4);
}

const options = parseArguments(process.argv.slice(2));
if (process.env.RUN_LIVE_INTEGRATION !== "1" || process.env.RUN_PAID_INTEGRATION !== "1") {
  throw new Error("RUN_LIVE_INTEGRATION=1 and RUN_PAID_INTEGRATION=1 are required");
}
const preregistrationBytes = readFileSync(PREREGISTRATION_PATH);
const preregistration = JSON.parse(preregistrationBytes);
if (
  preregistration.schemaVersion !== "dolly.dynamic-config-agent-preregistration/1" ||
  preregistration.experimentVersion !== 1 || preregistration.status !== "frozen-before-first-run" ||
  preregistration.backend.stream !== true || preregistration.backend.nonStreamFallback !== false
) throw new Error("preregistration is not frozen for this runner");
for (const [label, path] of [
  ["runnerSha256", fileURLToPath(import.meta.url)],
  ["verifierSha256", join(DIRECTORY, "verify.mjs")],
  ["parserSha256", PARSER_PATH],
]) {
  if (preregistration.implementation?.[label] !== sha256(readFileSync(path))) {
    throw new Error(`preregistration does not bind the current ${label}`);
  }
}
const environment = dotenv.parse(readFileSync(ENV_PATH));
if (!environment.AETHER_BASE_URL || !environment.AETHER_API_KEY) throw new Error("Aether configuration is absent");
const configuration = {
  base: baseUrl(environment.AETHER_BASE_URL),
  apiKey: environment.AETHER_API_KEY,
};
const privateValues = [environment.AETHER_BASE_URL, environment.AETHER_API_KEY];
const artifactRoot = join(
  ROOT,
  "artifacts/experiments/probes/dynamic-config-agent-live-v0",
  options.runId,
);
mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
const inventory = [];
inventory.push(writeExclusive(join(artifactRoot, "preregistration.json"), preregistrationBytes));
const policy = new ConfigurationPolicy();
const tools = toolDefinitions();
const systemMessage = {
  role: "system",
  content: "You are a general Agent. Manage configuration only through one host tool per response. Use exactly: read, propose, apply, read, finish. Never claim a change before the host returns success.",
};
const inertHistory = Array.from({ length: 900 }, (_, index) => `archived-note-${index % 17}`).join(" ");
let messages = [
  systemMessage,
  {
    role: "user",
    content: `Change modelId from ${SOURCE_MODEL} to ${TARGET_MODEL}, lower contextLimitTokens from 8192 to 1024, set contextContractionPolicy to structured-checkpoint, preserve maxResponseBytes at 1048576, then verify and finish. Inert history forces contraction:\n${inertHistory}`,
  },
];
let beforeCompaction = null;
let afterCompaction = null;
let listObservation = null;
const rounds = [];
let failure = null;
try {
  listObservation = await modelList(configuration);
  if (estimatedTokens(messages) <= 1024 || estimatedTokens(messages) > 8192) {
    throw new Error("initial context fixture is outside the frozen range");
  }
  for (let round = 0; round < 8 && !policy.finished; round += 1) {
    const requestedModel = policy.current.modelId;
    if (estimatedTokens(messages) > policy.current.contextLimitTokens) {
      throw new Error("request exceeds effective context limit");
    }
    const response = await chat(configuration, {
      model: requestedModel,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0,
      max_tokens: 800,
      seed: 4242,
    });
    const requestBytes = Buffer.from(`${canonical(response.wire)}\n`, "utf8");
    assertNoPrivate(requestBytes, privateValues, `round ${round} request`);
    assertNoPrivate(response.raw, privateValues, `round ${round} response`);
    inventory.push(writeExclusive(join(artifactRoot, `round-${round}.request.json`), requestBytes));
    inventory.push(writeExclusive(join(artifactRoot, `round-${round}.response.sse`), response.raw));
    const message = response.parsed.body.choices[0].message;
    if (message.reasoning_content.length !== 0) throw new Error("disabled-thinking response exposed reasoning");
    const calls = message.tool_calls ?? [];
    if (calls.length !== 1) throw new Error("Agent did not return exactly one tool call");
    const call = calls[0];
    const expectedTool = EXPECTED_TOOLS[policy.events.length];
    if (call.function.name !== expectedTool) throw new Error("Agent tool order differs from preregistration");
    const result = policy.execute(call.function.name, call.function.arguments);
    rounds.push({
      round,
      requestedModel,
      requestEstimatedTokens: estimatedTokens(messages),
      finishReason: response.parsed.body.choices[0].finish_reason,
      responseModelPresent: typeof response.parsed.body.model === "string",
      usage: response.parsed.body.usage,
      streamEvidence: response.parsed.evidence,
      toolName: call.function.name,
      toolOutcome: policy.events.at(-1)?.outcome ?? null,
    });
    messages.push({ role: "assistant", content: message.content, tool_calls: calls });
    messages.push({ role: "tool", tool_call_id: call.id, content: canonical(result) });
    if (call.function.name === "apply_configuration_change" && policy.applied) {
      beforeCompaction = estimatedTokens(messages);
      messages = [
        systemMessage,
        {
          role: "user",
          content: `Trusted host checkpoint: configuration ${policy.current.revision} is effective with model ${policy.current.modelId}, contextLimitTokens ${policy.current.contextLimitTokens}, contextContractionPolicy ${policy.current.contextContractionPolicy}, and maxResponseBytes ${policy.current.maxResponseBytes}. Continue: call read_configuration, then finish with the observed revision.`,
        },
      ];
      afterCompaction = estimatedTokens(messages);
      if (beforeCompaction <= 1024 || afterCompaction > 1024) throw new Error("context contraction gate failed");
    }
  }
  if (!policy.finished) throw new Error("Agent exhausted its tool-round budget");
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message } : { name: "unknown", message: "unknown failure" };
}

const result = {
  schemaVersion: "dolly.dynamic-config-agent-result/1",
  experimentId: preregistration.experimentId,
  runId: options.runId,
  status: failure === null ? "passed" : "failed",
  failure,
  modelList: listObservation,
  rounds,
  toolEvents: policy.events,
  metrics: {
    strictStreamRoundCount: rounds.length,
    toolSequenceExact: canonical(policy.events.map((event) => event.name)) === canonical(EXPECTED_TOOLS),
    hostPolicyViolationCount: policy.policyViolations,
    modelChanged: policy.applied && policy.current.modelId === TARGET_MODEL,
    contextContracted: policy.applied && policy.current.contextLimitTokens === 1024,
    beforeCompactionEstimatedTokens: beforeCompaction,
    afterCompactionEstimatedTokens: afterCompaction,
    targetModelCallSucceeded: rounds.some((round) => round.requestedModel === TARGET_MODEL),
    postChangeRevisionVerified: policy.readAfter && policy.finished,
  },
  endpointRecorded: false,
  credentialRecorded: false,
  productConfigurationWrites: 0,
  moduleProcesses: 0,
};
const resultBytes = Buffer.from(`${canonical(result)}\n`, "utf8");
assertNoPrivate(resultBytes, privateValues, "result");
inventory.push(writeExclusive(join(artifactRoot, "result.json"), resultBytes));
const manifest = {
  schemaVersion: "dolly.dynamic-config-agent-manifest/1",
  experimentId: preregistration.experimentId,
  runId: options.runId,
  preregistrationSha256: sha256(preregistrationBytes),
  runnerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  verifierSha256: sha256(readFileSync(join(DIRECTORY, "verify.mjs"))),
  parserSha256: sha256(readFileSync(PARSER_PATH)),
  artifacts: inventory,
  privateEndpointRecorded: false,
  privateCredentialRecorded: false,
};
const manifestBytes = Buffer.from(`${canonical(manifest)}\n`, "utf8");
assertNoPrivate(manifestBytes, privateValues, "manifest");
writeExclusive(join(artifactRoot, "manifest.json"), manifestBytes);
process.stdout.write(`${canonical({ runId: options.runId, status: result.status, rounds: rounds.length, artifactRoot: `artifacts/experiments/probes/dynamic-config-agent-live-v0/${options.runId}` })}\n`);
if (failure !== null) process.exitCode = 1;
