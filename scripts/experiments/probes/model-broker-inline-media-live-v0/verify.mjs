#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../../..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const artifactDirectory = resolve(process.argv[2] ?? "");
const expectedRoot = join(
  REPOSITORY_ROOT,
  "artifacts/experiments/probes/model-broker-inline-media-live-v0",
);
if (!artifactDirectory.startsWith(`${expectedRoot}/`)) {
  throw new Error("usage: verify.mjs <recorded model-broker live artifact directory>");
}
const manifest = JSON.parse(readFileSync(join(artifactDirectory, "manifest.json"), "utf8"));
const result = JSON.parse(readFileSync(join(artifactDirectory, "result.json"), "utf8"));
const preregistrationPath = join(
  REPOSITORY_ROOT,
  "docs/experiments/preregistrations/model-broker-inline-media-live-v0.json",
);
const preregistrationBytes = readFileSync(preregistrationPath);
const preregistration = JSON.parse(preregistrationBytes.toString("utf8"));
const errors = [];
if (
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
  result.status !== "succeeded" ||
  result.exactImageAnswer !== true ||
  result.finishReason !== "stop" ||
  result.reasoningState !== "not-observed" ||
  result.requestWire?.stream !== true ||
  result.requestWire?.includeUsage !== true ||
  result.requestWire?.thinkingType !== "disabled" ||
  result.requestWire?.enableThinkingPresent !== false ||
  result.requestWire?.outputContract !== "json_object" ||
  result.requestWire?.mediaPlacement !== "inline-png-data-url" ||
  result.media?.providerAccessRecords !== 0 ||
  result.media?.remainingLeases !== 0 ||
  result.secretReleases !== 1 ||
  result.endpointRecorded !== false ||
  result.credentialRecorded !== false ||
  result.moduleProcessesStarted !== 0
) {
  errors.push("result contract mismatch");
}
const serialized = `${JSON.stringify({ manifest, result })}`;
const privateValues = ["AETHER_BASE_URL", "AETHER_API_KEY"].flatMap((name) => {
  const direct = process.env[name];
  if (typeof direct === "string" && direct.length > 0) return [direct];
  const line = readFileSync(join(REPOSITORY_ROOT, ".env"), "utf8")
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(`${name}=`));
  return line ? [line.slice(name.length + 1).replace(/^['"]|['"]$/gu, "")] : [];
});
if (privateValues.some((value) => value.length > 0 && serialized.includes(value))) {
  errors.push("private endpoint or credential leaked into artifacts");
}
const validation = {
  schemaVersion: "dolly.model-broker-inline-media-live-validation/1",
  valid: errors.length === 0,
  errors,
  checks: {
    exactImageAnswer: result.exactImageAnswer === true,
    strictStreamingWire: result.requestWire?.stream === true && result.requestWire?.includeUsage === true,
    disabledThinkingObject: result.requestWire?.thinkingType === "disabled",
    noReasoningObserved: result.reasoningState === "not-observed",
    noEnableThinking: result.requestWire?.enableThinkingPresent === false,
    mediaLeaseClosed: result.media?.remainingLeases === 0,
    noPrivateLeak: !errors.includes("private endpoint or credential leaked into artifacts"),
  },
};
writeFileSync(join(artifactDirectory, "validation.json"), `${JSON.stringify(validation, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify(validation)}\n`);
if (!validation.valid) process.exitCode = 1;
