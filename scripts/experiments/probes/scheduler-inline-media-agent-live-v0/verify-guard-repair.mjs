#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../../..");
const EXPECTED_ROOT = join(
  REPOSITORY_ROOT,
  "artifacts/experiments/probes/scheduler-inline-media-agent-live-v0",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function privateValue(name) {
  const direct = process.env[name];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const line = readFileSync(join(REPOSITORY_ROOT, ".env"), "utf8")
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim().replace(/^['"]|['"]$/gu, "") ?? "";
}

const artifactDirectory = resolve(process.argv[2] ?? "");
if (!artifactDirectory.startsWith(`${EXPECTED_ROOT}/`)) {
  throw new Error("usage: verify-guard-repair.mjs <recorded run directory>");
}
const manifestBytes = readFileSync(join(artifactDirectory, "manifest.json"));
const resultBytes = readFileSync(join(artifactDirectory, "result.json"));
const effectsBytes = readFileSync(join(artifactDirectory, "effect-intents.json"));
const preregistrationBytes = readFileSync(join(artifactDirectory, "preregistration.json"));
const originalValidationBytes = readFileSync(join(artifactDirectory, "validation.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const result = JSON.parse(resultBytes.toString("utf8"));
const original = JSON.parse(originalValidationBytes.toString("utf8"));
const errors = [];

if (
  original.valid !== false ||
  JSON.stringify(original.errors) !== JSON.stringify(["Module startup refusal source is absent"]) ||
  Object.entries(original.checks ?? {})
    .some(([name, value]) => name !== "productGuardPresent" && value !== true)
) {
  errors.push("original validation is not the registered single-oracle false negative");
}
for (const entry of manifest.implementationSha256 ?? []) {
  if (sha256(readFileSync(join(REPOSITORY_ROOT, entry.path))) !== entry.sha256) {
    errors.push(`registered implementation hash mismatch: ${entry.path}`);
  }
}
if (
  manifest.preregistrationSha256 !== sha256(preregistrationBytes) ||
  manifest.artifacts?.resultSha256 !== sha256(resultBytes) ||
  manifest.artifacts?.effectIntentsSha256 !== sha256(effectsBytes)
) {
  errors.push("registered artifact hash mismatch");
}
if (
  result.status !== "succeeded" ||
  result.exactImageAnswer !== true ||
  result.agent?.capabilityVersion !== "v3" ||
  result.agent?.strictStreamRequested !== true ||
  result.agent?.childCredentialEnvironmentPresent !== false ||
  result.agent?.finishReason !== "stop" ||
  result.agent?.reasoningState !== "not-observed" ||
  result.scheduler?.committedResults !== 1 ||
  result.scheduler?.pendingInput !== 0 ||
  result.scheduler?.pendingOutput !== 1 ||
  result.scheduler?.activeClaims !== 0 ||
  result.scheduler?.deadLetters !== 0 ||
  result.scheduler?.finalState !== "stopped" ||
  result.process?.aliveBeforeStop !== true ||
  result.process?.aliveAfterStop !== false ||
  result.process?.stateAfterStop !== "stopped" ||
  result.media?.providerAccessRecords !== 0 ||
  result.media?.remainingLeases !== 0 ||
  result.effectEvidence !== "terminal" ||
  result.reopenedEffectEvidence !== "terminal" ||
  result.secretReleases !== 1
) {
  errors.push("Agent, Scheduler, Media, effect, secret, or process contract mismatch");
}
if (
  result.requestWire?.dispatches !== 1 ||
  result.requestWire?.stream !== true ||
  result.requestWire?.includeUsage !== true ||
  result.requestWire?.thinkingType !== "disabled" ||
  result.requestWire?.enableThinkingPresent !== false ||
  result.requestWire?.outputContract !== "json_object" ||
  result.requestWire?.mediaPlacement !== "inline-png-data-url" ||
  result.requestWire?.responseStatus !== 200 ||
  typeof result.requestWire?.responseContentType !== "string" ||
  !result.requestWire.responseContentType.toLowerCase().startsWith("text/event-stream") ||
  !Number.isSafeInteger(result.requestWire?.responseChunks) ||
  result.requestWire.responseChunks <= 0
) {
  errors.push("strict streaming wire contract mismatch");
}
const bootstrapSource = readFileSync(join(REPOSITORY_ROOT, "src/core/runtime-bootstrap.ts"), "utf8");
const exactGuard =
  bootstrapSource.includes('"RUNTIME_MODULE_MIGRATION_REQUIRED"') &&
  bootstrapSource.includes(
    "Configured Modules require the isolated extension process runtime; refusing the legacy in-process Orchestrator",
  );
if (!exactGuard) errors.push("exact current Module startup refusal is absent");

const serialized = Buffer.concat([
  manifestBytes,
  resultBytes,
  effectsBytes,
  preregistrationBytes,
  originalValidationBytes,
]).toString("utf8");
if ([privateValue("AETHER_BASE_URL"), privateValue("AETHER_API_KEY")]
  .some((value) => value.length > 0 && serialized.includes(value))) {
  errors.push("private endpoint or credential leaked into artifacts");
}

const validation = {
  schemaVersion: "dolly.scheduler-inline-media-agent-live-validation/2",
  valid: errors.length === 0,
  errors,
  repairScope: {
    originalValidationSha256: sha256(originalValidationBytes),
    originalErrors: original.errors,
    changedOracleOnly: "Match the exact current refusal message including 'isolated extension process runtime'.",
    efficacyMetricsChanged: false,
  },
  checks: {
    registeredHashes: !errors.some((entry) => entry.includes("hash mismatch")),
    exactImageAnswer: result.exactImageAnswer === true,
    strictStreamingWire: result.requestWire?.dispatches === 1 && result.requestWire?.stream === true,
    schedulerAndClaimClosed:
      result.scheduler?.committedResults === 1 && result.scheduler?.activeClaims === 0,
    mediaAndEffectsClosed:
      result.media?.remainingLeases === 0 && result.reopenedEffectEvidence === "terminal",
    childStopped: result.process?.aliveAfterStop === false,
    exactProductGuardPresent: exactGuard,
    noPrivateLeak: !errors.includes("private endpoint or credential leaked into artifacts"),
  },
};
writeFileSync(
  join(artifactDirectory, "validation-v2.json"),
  `${JSON.stringify(validation, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
process.stdout.write(`${JSON.stringify(validation)}\n`);
if (!validation.valid) process.exitCode = 1;
