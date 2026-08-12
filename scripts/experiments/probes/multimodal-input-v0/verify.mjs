#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const runIdIndex = process.argv.indexOf("--run-id");
const runId = runIdIndex < 0 ? undefined : process.argv[runIdIndex + 1];
if (
  process.argv.length !== 4 ||
  runIdIndex !== 2 ||
  !/^v1-[a-z0-9][a-z0-9-]{0,63}$/u.test(runId ?? "")
) {
  throw new Error("usage: verify.mjs --run-id v1-<unique-suffix>");
}
const artifactRoot = join(
  repositoryRoot,
  "artifacts/experiments/probes/multimodal-input-v0/runs",
  runId,
);
const preregistrationPath = join(
  repositoryRoot,
  "docs/experiments/preregistrations/multimodal-input-v0.json",
);
const validationPath = join(artifactRoot, "verification.json");
const failures = [];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

function parseEnv(bytes) {
  const values = {};
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function imageUrlFromMessage(message) {
  if (!Array.isArray(message?.content)) return null;
  const parts = message.content.filter((part) => part?.type === "image_url");
  if (parts.length !== 1 || typeof parts[0]?.image_url?.url !== "string") return null;
  return parts[0].image_url.url;
}

function decodePngDataUrl(value) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value ?? "");
  if (!match) return null;
  const bytes = Buffer.from(match[1], "base64");
  return bytes.toString("base64") === match[1] ? bytes : null;
}

function exactImageAnswer(value) {
  const expected = {
    title: "DOLLY VISUAL CHECK",
    visualNonce: "K8M2",
    boxes: [
      { color: "red", label: "ALPHA", number: 7 },
      { color: "blue", label: "BETA", number: 4 },
      { color: "green", label: "GAMMA", number: 9 },
    ],
    checksum: 20,
    answerToken: 12,
  };
  try {
    return canonicalJson(JSON.parse(value)) === canonicalJson(expected);
  } catch {
    return false;
  }
}

function exactFollowup(value) {
  try {
    return canonicalJson(JSON.parse(value)) === canonicalJson({ followup: 59 });
  } catch {
    return false;
  }
}

if (!existsSync(artifactRoot)) throw new Error("multimodal artifact root does not exist");
if (existsSync(validationPath)) throw new Error("verification.json already exists");

const preregistrationBytes = readFileSync(preregistrationPath);
const preregistration = JSON.parse(preregistrationBytes.toString("utf8"));
const manifest = loadJson(join(artifactRoot, "manifest.json"));
const summary = loadJson(join(artifactRoot, "summary.json"));
const digests = loadJson(join(artifactRoot, "sha256sums.json"));
const rawText = readFileSync(join(artifactRoot, "raw-cases.jsonl"), "utf8");
const rows = rawText.trimEnd().split("\n").filter(Boolean).map(JSON.parse);

check(manifest.preregistration?.digest === sha256(preregistrationBytes), "preregistration digest differs");
check(manifest.runId === runId, "manifest run ID differs");
check(manifest.preregistration?.status === "preregistered-before-execution", "preregistration was not frozen before execution");
for (const source of manifest.sourceConsumers ?? []) {
  const path = join(repositoryRoot, source.path ?? "");
  check(existsSync(path), `frozen source is absent: ${source.path}`);
  if (existsSync(path)) {
    const bytes = readFileSync(path);
    check(source.digest === sha256(bytes), `frozen source digest differs: ${source.path}`);
    check(source.byteLength === bytes.byteLength, `frozen source length differs: ${source.path}`);
  }
}
check(
  readFileSync(join(repositoryRoot, "src/core/runtime-bootstrap.ts"), "utf8")
    .includes("RUNTIME_MODULE_MIGRATION_REQUIRED"),
  "Module startup refusal is absent",
);

for (const [path, entry] of Object.entries(digests.files ?? {})) {
  const bytes = readFileSync(join(artifactRoot, path));
  check(entry.digest === sha256(bytes), `artifact digest differs: ${path}`);
  check(entry.byteLength === bytes.byteLength, `artifact length differs: ${path}`);
}
const storedBeforeValidation = listFiles(artifactRoot)
  .map((path) => relative(artifactRoot, path))
  .filter((path) => path !== "sha256sums.json" && path !== "verification.json")
  .sort();
check(
  canonicalJson(storedBeforeValidation) === canonicalJson(Object.keys(digests.files ?? {}).sort()),
  "artifact inventory differs from sha256sums.json",
);

const planned = new Map();
for (const definition of preregistration.cases) {
  for (let repetition = 1; repetition <= definition.repetitions; repetition += 1) {
    planned.set(`${definition.id}:${repetition}`, definition);
  }
}
check(rows.length === planned.size, "case count differs from preregistration");
const seen = new Set();
for (const row of rows) {
  const key = `${row.caseId}:${row.repetition}`;
  const definition = planned.get(key);
  check(definition !== undefined, `unplanned case row: ${key}`);
  check(!seen.has(key), `duplicate case row: ${key}`);
  check(row.runId === runId, `case run ID differs: ${key}`);
  seen.add(key);
  if (definition !== undefined) {
    check(row.expectedCode === definition.expectedCode, `expected code drift: ${key}`);
    check(row.passed === (row.observed?.code === definition.expectedCode), `pass field drift: ${key}`);
  }
  const requestArtifact = row.observed?.requestArtifact;
  if (requestArtifact !== undefined) {
    const bytes = readFileSync(join(artifactRoot, requestArtifact.path));
    check(requestArtifact.digest === sha256(bytes), `request digest differs: ${key}`);
    check(requestArtifact.storedBytes === bytes.byteLength, `request length differs: ${key}`);
  }
}
for (const key of planned.keys()) check(seen.has(key), `planned case is missing: ${key}`);

const agentFixture = readFileSync(join(artifactRoot, "fixtures/agent-task.png"));
const agentMetadata = await sharp(agentFixture, { failOn: "error" }).metadata();
check(agentMetadata.width === 640 && agentMetadata.height === 360, "Agent image dimensions differ");
const agentDigest = sha256(agentFixture);
const aetherRows = rows.filter((row) => row.family === "real-model");
check(aetherRows.length === 5, "Aether case count differs from five");
let firstImageContent = null;
for (const row of aetherRows) {
  const key = `${row.caseId}:${row.repetition}`;
  const request = loadJson(join(artifactRoot, row.observed.requestArtifact.path));
  check(request.model === "qwen3.6-27b", `Aether model differs: ${key}`);
  check(request.stream === true, `Aether stream is not true: ${key}`);
  check(request.stream_options?.include_usage === true, `Aether terminal usage is absent: ${key}`);
  check(request.thinking?.type === "disabled", `Aether thinking policy differs: ${key}`);
  check(!Object.hasOwn(request, "enable_thinking"), `legacy thinking field is present: ${key}`);
  check(request.response_format?.type === "json_object", `JSON-object request is absent: ${key}`);
  check(request.temperature === 0, `Aether temperature differs: ${key}`);
  check(row.observed.streamEvidence?.usageEventCount === 1, `usage event differs: ${key}`);
  check(row.observed.streamEvidence?.doneCount === 1, `DONE count differs: ${key}`);
  check(row.observed.response?.status === 200, `Aether status differs: ${key}`);
  check(row.observed.response?.finishReason === "stop", `Aether finish reason differs: ${key}`);
  check(row.observed.response?.message?.reasoningObserved === false, `disabled reasoning was non-empty: ${key}`);
  const content = row.observed.response?.message?.content;
  if (row.caseId === "aether-text-only-control") {
    check(imageUrlFromMessage(request.messages?.[0]) === null, "text control contains an image");
    check(!exactImageAnswer(content), "text control reproduced the hidden visual answer");
    check(row.observed.code === "AETHER_TEXT_CONTROL_NO_EXACT_VISUAL_ANSWER", "text control code differs");
  } else {
    const imageBytes = decodePngDataUrl(imageUrlFromMessage(request.messages?.[0]));
    check(imageBytes !== null && sha256(imageBytes) === agentDigest, `inline image bytes differ: ${key}`);
  }
  if (row.caseId === "aether-inline-image-understanding") {
    const exact = exactImageAnswer(content);
    check(row.observed.exactAnswer === exact, `image exact-answer field differs: ${key}`);
    check(row.observed.code === (exact ? "AETHER_IMAGE_TASK_PASS" : "AETHER_IMAGE_TASK_FAIL"), `image code differs: ${key}`);
    if (row.repetition === 1) firstImageContent = content;
  }
  if (row.caseId === "aether-followup-image-use") {
    const exact = exactFollowup(content);
    check(request.messages?.[1]?.content === firstImageContent, "follow-up did not replay first answer");
    check(row.observed.exactAnswer === exact, "follow-up exact-answer field differs");
    check(row.observed.code === (exact ? "AETHER_FOLLOWUP_TASK_PASS" : "AETHER_FOLLOWUP_TASK_FAIL"), "follow-up code differs");
  }
}

for (const row of rows.filter((entry) => entry.caseId === "tool-chunk-reconstruct")) {
  const chunks = row.observed?.chunks ?? [];
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, "base64")));
  check(bytes.byteLength === row.observed?.token?.byteLength, `tool reconstruction length differs: ${row.repetition}`);
  check(sha256(bytes) === row.observed?.token?.digest, `tool reconstruction digest differs: ${row.repetition}`);
}

const derivedPassed = rows.filter((row) => row.passed).length;
check(summary.executions === rows.length, "summary execution count differs");
check(summary.passed === derivedPassed, "summary pass count differs");
check(summary.failed === rows.length - derivedPassed, "summary failure count differs");
check(summary.aether?.executions === 5, "summary Aether execution count differs");

const envPath = join(repositoryRoot, ".env");
if (existsSync(envPath)) {
  const environment = parseEnv(readFileSync(envPath));
  const forbidden = [environment.AETHER_BASE_URL, environment.AETHER_API_KEY]
    .filter((value) => typeof value === "string" && value.length >= 8)
    .map((value) => Buffer.from(value, "utf8"));
  for (const path of listFiles(artifactRoot)) {
    if (path === validationPath) continue;
    const bytes = readFileSync(path);
    for (const secret of forbidden) check(!bytes.includes(secret), `configured secret leaked into ${relative(artifactRoot, path)}`);
  }
}

const validation = {
  schemaVersion: "dolly.multimodal-input-probe-validation/1",
  experimentId: preregistration.experimentId,
  runId,
  valid: failures.length === 0,
  failures,
  verifiedCases: rows.length,
  verifiedAetherCases: aetherRows.length,
  exactImagePasses: aetherRows.filter((row) =>
    row.caseId === "aether-inline-image-understanding" && row.observed?.exactAnswer === true
  ).length,
  followupPassed: aetherRows.some((row) =>
    row.caseId === "aether-followup-image-use" && row.observed?.exactAnswer === true
  ),
  moduleStartupRefusalObserved: failures.every((failure) => failure !== "Module startup refusal is absent"),
};
writeFileSync(validationPath, `${canonicalJson(validation)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${canonicalJson(validation)}\n`);
if (!validation.valid) process.exitCode = 1;
