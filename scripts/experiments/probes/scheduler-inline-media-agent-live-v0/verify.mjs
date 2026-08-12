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

function readPrivateValue(name) {
  const direct = process.env[name];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const line = readFileSync(join(REPOSITORY_ROOT, ".env"), "utf8")
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) return "";
  return line.slice(name.length + 1).trim().replace(/^['"]|['"]$/gu, "");
}

const artifactDirectory = resolve(process.argv[2] ?? "");
if (!artifactDirectory.startsWith(`${EXPECTED_ROOT}/`)) {
  throw new Error("usage: verify.mjs <recorded Scheduler inline-Media Agent directory>");
}
const manifestBytes = readFileSync(join(artifactDirectory, "manifest.json"));
const resultBytes = readFileSync(join(artifactDirectory, "result.json"));
const effectBytes = readFileSync(join(artifactDirectory, "effect-intents.json"));
const copiedPreregistrationBytes = readFileSync(join(artifactDirectory, "preregistration.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const result = JSON.parse(resultBytes.toString("utf8"));
const preregistrationPath = join(
  REPOSITORY_ROOT,
  "docs/experiments/preregistrations/scheduler-inline-media-agent-live-v0.json",
);
const preregistrationBytes = readFileSync(preregistrationPath);
const preregistration = JSON.parse(preregistrationBytes.toString("utf8"));
const errors = [];

if (
  sha256(copiedPreregistrationBytes) !== sha256(preregistrationBytes) ||
  manifest.preregistrationSha256 !== sha256(preregistrationBytes) ||
  manifest.experimentId !== preregistration.experimentId ||
  manifest.experimentVersion !== preregistration.experimentVersion ||
  result.experimentId !== preregistration.experimentId ||
  result.runId !== manifest.runId
) {
  errors.push("preregistration or run identity mismatch");
}
for (const entry of manifest.implementationSha256 ?? []) {
  if (sha256(readFileSync(join(REPOSITORY_ROOT, entry.path))) !== entry.sha256) {
    errors.push(`implementation hash mismatch: ${entry.path}`);
  }
}
if (
  manifest.artifacts?.resultSha256 !== sha256(resultBytes) ||
  manifest.artifacts?.effectIntentsSha256 !== sha256(effectBytes)
) {
  errors.push("artifact digest mismatch");
}
if (
  result.status !== "succeeded" ||
  result.exactImageAnswer !== true ||
  result.agent?.capabilityVersion !== "v3" ||
  result.agent?.strictStreamRequested !== true ||
  result.agent?.childCredentialEnvironmentPresent !== false ||
  result.agent?.finishReason !== "stop" ||
  result.agent?.reasoningState !== "not-observed"
) {
  errors.push("Agent output contract mismatch");
}
if (
  result.scheduler?.committedResults !== 1 ||
  result.scheduler?.pendingInput !== 0 ||
  result.scheduler?.pendingOutput !== 1 ||
  result.scheduler?.activeClaims !== 0 ||
  result.scheduler?.deadLetters !== 0 ||
  result.scheduler?.finalState !== "stopped"
) {
  errors.push("Scheduler terminal state mismatch");
}
if (
  result.process?.started !== true ||
  result.process?.childPidRecorded !== true ||
  result.process?.aliveBeforeStop !== true ||
  result.process?.stateBeforeStop !== "running" ||
  result.process?.aliveAfterStop !== false ||
  result.process?.stateAfterStop !== "stopped" ||
  result.process?.linuxControlGroupProof !== false
) {
  errors.push("Extension process lifecycle mismatch");
}
if (
  result.media?.mimeType !== "image/png" ||
  !Number.isSafeInteger(result.media?.byteLength) ||
  result.media.byteLength <= 0 ||
  !Number.isSafeInteger(result.media?.width) ||
  result.media.width <= 0 ||
  !Number.isSafeInteger(result.media?.height) ||
  result.media.height <= 0 ||
  result.media?.providerAccessRecords !== 0 ||
  result.media?.remainingLeases !== 0
) {
  errors.push("Media terminal state mismatch");
}
if (
  result.effectEvidence !== "terminal" ||
  result.reopenedEffectEvidence !== "terminal" ||
  result.secretReleases !== 1 ||
  result.endpointRecorded !== false ||
  result.credentialRecorded !== false ||
  result.productBootstrapModulesRemainRejected !== true
) {
  errors.push("effect, secret, or product-guard contract mismatch");
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
  result.requestWire.responseChunks <= 0 ||
  !Number.isSafeInteger(result.requestWire?.responseBytes) ||
  result.requestWire.responseBytes <= 0
) {
  errors.push("strict streaming wire contract mismatch");
}
const bootstrapSource = readFileSync(join(REPOSITORY_ROOT, "src/core/runtime-bootstrap.ts"), "utf8");
if (
  !bootstrapSource.includes('"RUNTIME_MODULE_MIGRATION_REQUIRED"') ||
  !bootstrapSource.includes("Configured Modules require the migrated runtime")
) {
  errors.push("Module startup refusal source is absent");
}
const serialized = Buffer.concat([
  manifestBytes,
  resultBytes,
  effectBytes,
  copiedPreregistrationBytes,
]).toString("utf8");
const privateValues = [readPrivateValue("AETHER_BASE_URL"), readPrivateValue("AETHER_API_KEY")];
if (privateValues.some((value) => value.length > 0 && serialized.includes(value))) {
  errors.push("private endpoint or credential leaked into artifacts");
}

const validation = {
  schemaVersion: "dolly.scheduler-inline-media-agent-live-validation/1",
  valid: errors.length === 0,
  errors,
  checks: {
    exactImageAnswer: result.exactImageAnswer === true,
    schedulerCommittedOnce: result.scheduler?.committedResults === 1,
    activeClaimClosed: result.scheduler?.activeClaims === 0,
    strictStreamingWire:
      result.requestWire?.dispatches === 1 &&
      result.requestWire?.stream === true &&
      result.requestWire?.includeUsage === true,
    deliveredMediaV3: result.agent?.capabilityVersion === "v3",
    mediaLeaseClosed: result.media?.remainingLeases === 0,
    effectJournalReopenedTerminal: result.reopenedEffectEvidence === "terminal",
    childStopped: result.process?.aliveAfterStop === false,
    productGuardPresent: !errors.includes("Module startup refusal source is absent"),
    noPrivateLeak: !errors.includes("private endpoint or credential leaked into artifacts"),
  },
};
writeFileSync(join(artifactDirectory, "validation.json"), `${JSON.stringify(validation, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify(validation)}\n`);
if (!validation.valid) process.exitCode = 1;
