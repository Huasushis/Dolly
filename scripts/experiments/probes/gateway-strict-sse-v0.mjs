#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { readStrictChatCompletionSse } from "./memory-association-task-switch-v0/strict-chat-sse.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const preregistrationPath = join(
  repositoryRoot,
  "docs/experiments/preregistrations/gateway-strict-sse-v0.json",
);
const parserPath = join(
  repositoryRoot,
  "scripts/experiments/probes/memory-association-task-switch-v0/strict-chat-sse.mjs",
);
const expectedParserSha256 =
  "d67ef50efac2fa7a32daaa4dc8b57c790afccbe6ef2123bc974af47f14d2999b";

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

function writeExclusive(path, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return { path, byteLength: bytes.byteLength, sha256: sha256(bytes) };
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

function completionUrl(baseValue) {
  const parsed = new URL(baseValue);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("AETHER_BASE_URL contains forbidden URL fields");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))
  ) throw new Error("AETHER_BASE_URL is not an allowed origin");
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "")}/v1/chat/completions`;
  return parsed;
}

function parseArguments(argumentsValue) {
  const index = argumentsValue.indexOf("--run-id");
  const runId = index < 0 ? undefined : argumentsValue[index + 1];
  if (!/^run-[a-z0-9][a-z0-9-]{0,63}$/u.test(runId ?? "")) {
    throw new Error("--run-id must match run-[a-z0-9-]+");
  }
  return { runId };
}

async function readRawBranch(stream, startedNs, maximumBytes) {
  const reader = stream.getReader();
  const chunks = [];
  const timings = [];
  let total = 0;
  let previousMs = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("response byte limit exceeded");
      throw new Error("Raw SSE response exceeded its byte limit");
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
    timings.push({
      chunkIndex: timings.length,
      byteLength: item.value.byteLength,
      cumulativeBytes: total,
      elapsedMs,
      gapMs: elapsedMs - previousMs,
    });
    previousMs = elapsedMs;
    chunks.push(Buffer.from(item.value));
  }
  return { bytes: Buffer.concat(chunks), timings };
}

function assertNoSecret(bytes, secrets, label) {
  for (const secret of secrets) {
    if (secret.length > 0 && bytes.includes(Buffer.from(secret, "utf8"))) {
      throw new Error(`${label} contains configured private bytes`);
    }
  }
}

const options = parseArguments(process.argv.slice(2));
const preregistrationBytes = readFileSync(preregistrationPath);
const preregistration = JSON.parse(preregistrationBytes.toString("utf8"));
if (
  preregistration.schemaVersion !== "dolly.gateway-sse-canary-preregistration/1" ||
  preregistration.experimentId !== "gateway-strict-sse-v0" ||
  preregistration.status !== "frozen-before-first-run" ||
  preregistration.request.stream !== true ||
  preregistration.request.nonStreamFallbackAllowed !== false ||
  preregistration.request.retryCount !== 0
) throw new Error("Gateway canary preregistration is not frozen for strict streaming");
if (sha256(readFileSync(parserPath)) !== expectedParserSha256) {
  throw new Error("Strict SSE parser differs from its frozen digest");
}
if (process.env.RUN_LIVE_INTEGRATION !== "1" || process.env.RUN_PAID_INTEGRATION !== "1") {
  throw new Error("RUN_LIVE_INTEGRATION=1 and RUN_PAID_INTEGRATION=1 are required");
}

const environment = loadEnv(readFileSync(join(repositoryRoot, ".env")));
const apiKey = environment.AETHER_API_KEY;
const configuredBase = environment.AETHER_BASE_URL;
if (!apiKey || !configuredBase) throw new Error("Aether configuration is missing");
const requestUrl = completionUrl(configuredBase);
const requestBody = {
  model: preregistration.backend.model,
  messages: [
    { role: "system", content: preregistration.data.system },
    { role: "user", content: preregistration.data.user },
  ],
  thinking: preregistration.request.thinking,
  temperature: preregistration.request.temperature,
  max_tokens: preregistration.request.maximumOutputTokens,
  seed: preregistration.randomness.seed,
  stream: true,
  stream_options: { include_usage: true },
};
if (Object.hasOwn(requestBody, "enable_thinking") || requestBody.stream !== true) {
  throw new Error("Gateway canary request encoding is invalid");
}

const artifactRoot = join(
  repositoryRoot,
  "artifacts/experiments/probes/gateway-strict-sse-v0",
  options.runId,
);
mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
const artifacts = [];
artifacts.push(writeExclusive(join(artifactRoot, "preregistration.json"), preregistrationBytes));
const requestBytes = Buffer.from(`${canonical(requestBody)}\n`, "utf8");
assertNoSecret(requestBytes, [apiKey, configuredBase], "request artifact");
artifacts.push(writeExclusive(join(artifactRoot, "request.json"), requestBytes));

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), preregistration.request.timeoutMs);
const startedAt = new Date().toISOString();
const startedNs = process.hrtime.bigint();
let response;
let rawResult = { bytes: Buffer.alloc(0), timings: [] };
let decoded;
let failure = null;
let headersElapsedMs = null;
try {
  response = await fetch(requestUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: canonical(requestBody),
    signal: controller.signal,
  });
  headersElapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
  if (response.body === null) throw new Error("Aether response has no body");
  const [parserBranch, rawBranch] = response.body.tee();
  const rawPromise = readRawBranch(
    rawBranch,
    startedNs,
    preregistration.request.maximumResponseBytes,
  );
  const parserPromise = response.ok
    ? readStrictChatCompletionSse(new Response(parserBranch, {
        status: response.status,
        headers: response.headers,
      }), {
        maximumResponseBytes: preregistration.request.maximumResponseBytes,
        maximumBufferedBytes: preregistration.request.maximumBufferedEventBytes,
        maximumOutputBytes: preregistration.request.maximumReconstructedOutputBytes,
        maximumEvents: preregistration.request.maximumEvents,
      })
    : Promise.reject(new Error(`Aether returned HTTP ${response.status}`));
  const [rawSettled, parserSettled] = await Promise.allSettled([rawPromise, parserPromise]);
  if (rawSettled.status === "fulfilled") rawResult = rawSettled.value;
  else throw rawSettled.reason;
  if (parserSettled.status === "rejected") throw parserSettled.reason;
  decoded = parserSettled.value;
} catch (error) {
  failure = {
    code: error?.name === "AbortError" ? "CLIENT_DEADLINE_EXCEEDED" : "STREAM_CANARY_FAILED",
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
} finally {
  clearTimeout(timer);
}

const finishedAt = new Date().toISOString();
const terminalElapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
assertNoSecret(rawResult.bytes, [apiKey, configuredBase], "raw response artifact");
artifacts.push(writeExclusive(join(artifactRoot, "response.sse"), rawResult.bytes));
const timingsBytes = Buffer.from(
  rawResult.timings.map((row) => `${canonical(row)}\n`).join(""),
  "utf8",
);
artifacts.push(writeExclusive(join(artifactRoot, "chunk-timings.jsonl"), timingsBytes));

let parsedContent = null;
if (decoded !== undefined) {
  const content = decoded.body.choices[0].message.content;
  try {
    parsedContent = JSON.parse(content);
  } catch {
    failure ??= { code: "MODEL_CONTENT_INVALID", name: "SyntaxError", message: "Model content is not strict JSON" };
  }
}
const reasoningContent = decoded?.body.choices[0].message.reasoning_content ?? "";
const strictStreamConnectivity =
  failure === null &&
  response?.status === 200 &&
  decoded?.evidence.doneCount === 1 &&
  decoded?.evidence.usageEventCount === 1 &&
  reasoningContent.trim().length > 0 &&
  parsedContent?.canary === preregistration.data.expectedCanary;
const result = {
  schemaVersion: "dolly.gateway-sse-canary-result/1",
  experimentId: preregistration.experimentId,
  runId: options.runId,
  status: strictStreamConnectivity ? "passed" : "failed",
  startedAt,
  finishedAt,
  request: {
    model: requestBody.model,
    stream: requestBody.stream,
    thinking: requestBody.thinking,
    maximumOutputTokens: requestBody.max_tokens,
    retryCount: 0,
    nonStreamFallbackUsed: false,
  },
  response: {
    httpStatus: response?.status ?? null,
    contentType: response?.headers.get("content-type") ?? null,
    headersElapsedMs,
    firstChunkElapsedMs: rawResult.timings[0]?.elapsedMs ?? null,
    terminalElapsedMs,
    crossedHistorical120SecondBoundary: terminalElapsedMs > 120_000,
    responseBytes: rawResult.bytes.byteLength,
    chunkCount: rawResult.timings.length,
    maximumInterChunkGapMs: rawResult.timings.length < 2
      ? null
      : Math.max(...rawResult.timings.slice(1).map((row) => row.gapMs)),
    eventCount: decoded?.evidence.eventCount ?? null,
    usageEventCount: decoded?.evidence.usageEventCount ?? null,
    doneCount: decoded?.evidence.doneCount ?? null,
    finishReason: decoded?.body.choices[0].finish_reason ?? null,
    contentCharacterCount: decoded?.body.choices[0].message.content.length ?? null,
    reasoningObserved: reasoningContent.trim().length > 0,
    reasoningCharacterCount: reasoningContent.length,
    usage: decoded?.body.usage ?? null,
    canaryMarkerMatched: parsedContent?.canary === preregistration.data.expectedCanary,
  },
  strictStreamConnectivity,
  gatewayOver120SecondsProven:
    strictStreamConnectivity && terminalElapsedMs > 120_000,
  failure,
};
const resultBytes = Buffer.from(`${canonical(result)}\n`, "utf8");
assertNoSecret(resultBytes, [apiKey, configuredBase], "result artifact");
artifacts.push(writeExclusive(join(artifactRoot, "result.json"), resultBytes));
const manifest = {
  schemaVersion: "dolly.gateway-sse-canary-manifest/1",
  experimentId: preregistration.experimentId,
  runId: options.runId,
  preregistrationSha256: sha256(preregistrationBytes),
  parserSha256: expectedParserSha256,
  sourceCommit: process.env.GIT_SOURCE_COMMIT ?? null,
  proxyEnvironment: {
    httpProxyPresent: Boolean(process.env.http_proxy),
    httpsProxyPresent: Boolean(process.env.https_proxy),
    ambientProxyUsedByNodeFetch: false,
  },
  endpointRecorded: false,
  credentialRecorded: false,
  artifacts: artifacts.map(({ path, ...entry }) => ({ ...entry, path: path.slice(artifactRoot.length + 1) })),
};
const manifestBytes = Buffer.from(`${canonical(manifest)}\n`, "utf8");
assertNoSecret(manifestBytes, [apiKey, configuredBase], "manifest artifact");
writeExclusive(join(artifactRoot, "manifest.json"), manifestBytes);
process.stdout.write(`${canonical({ artifactRoot, status: result.status, terminalElapsedMs })}\n`);
if (!strictStreamConnectivity) process.exitCode = 1;
