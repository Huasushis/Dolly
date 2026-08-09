#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const artifactRoot = join(repositoryRoot, "artifacts/experiments/probes/general-agent-live-v0");
const sourcePreregistrationPath = join(
  repositoryRoot,
  "docs/experiments/preregistrations/general-agent-live-v0.json",
);
const HIDDEN_CODENAME = "EMBER-7421";

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  if (
    (argv.length !== 2 && argv.length !== 3) ||
    argv[0] !== "--run-id" ||
    !/^live-v8-[A-Za-z0-9._-]+$/u.test(argv[1]) ||
    (argv.length === 3 && argv[2] !== "--check-only")
  ) {
    fail("usage: verify.mjs --run-id live-v8-<identifier> [--check-only]");
  }
  return { runId: argv[1], checkOnly: argv[2] === "--check-only" };
}

function json(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${path} is not one JSON object`);
  }
  return value;
}

function jsonLines(path) {
  const text = readFileSync(path, "utf8");
  if (text !== "" && !text.endsWith("\n")) fail(`${path} lacks a final LF`);
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        fail(`${path} row ${index + 1} is not JSON`);
      }
    });
}

function loadFixtureValues() {
  const values = new Map();
  for (const line of readFileSync(join(repositoryRoot, ".env"), "utf8").split(/\r?\n/u)) {
    const match = /^\s*(AETHER_BASE_URL|AETHER_API_KEY)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) values.set(match[1], value);
  }
  if (!values.has("AETHER_BASE_URL") || !values.has("AETHER_API_KEY")) {
    fail("Aether fixture values are unavailable for the leakage check");
  }
  return [...values.values()];
}

function exactStringArray(value, expected, label) {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    fail(`${label} is not ${JSON.stringify(expected)}`);
  }
}

function verifyBaseline(row) {
  if (row.conditionId !== "no-storage-tool") fail("baseline condition id is wrong");
  if (row.schemaVersion !== "general-agent-live/case/1") fail("baseline schema is wrong");
  if (row.schedulerCompletion !== true || row.childPidRecorded !== true || row.childStopped !== true) {
    fail("baseline Scheduler/process completion evidence is false");
  }
  if (row.linuxControlGroupProof !== false) fail("baseline overclaims Linux group proof");
  const result = row.result;
  if (result?.conditionId !== "no-storage-tool") fail("baseline result condition is wrong");
  exactStringArray(result?.actions, ["answer"], "baseline actions");
  if (result?.childCredentialEnvironmentPresent !== false) {
    fail("baseline child observed an Aether environment variable");
  }
  if (result?.answer?.grounded !== false) fail("baseline answer claims unsupported grounding");
  exactStringArray(result?.answer?.evidenceKeys, [], "baseline evidence keys");
  if (JSON.stringify(result.answer).includes(HIDDEN_CODENAME)) {
    fail("baseline guessed the hidden codename");
  }
}

function verifyTreatment(row) {
  if (row.conditionId !== "private-storage-tool") fail("treatment condition id is wrong");
  if (row.schemaVersion !== "general-agent-live/case/1") fail("treatment schema is wrong");
  if (row.schedulerCompletion !== true || row.childPidRecorded !== true || row.childStopped !== true) {
    fail("treatment Scheduler/process completion evidence is false");
  }
  if (row.linuxControlGroupProof !== false) fail("treatment overclaims Linux group proof");
  const result = row.result;
  if (result?.conditionId !== "private-storage-tool") fail("treatment result condition is wrong");
  exactStringArray(
    result?.actions,
    ["storage.list", "storage.get", "answer"],
    "treatment actions",
  );
  if (result?.childCredentialEnvironmentPresent !== false) {
    fail("treatment child observed an Aether environment variable");
  }
  if (result?.answer?.grounded !== true) fail("treatment answer is not grounded");
  if (typeof result?.answer?.answer !== "string" || !result.answer.answer.includes(HIDDEN_CODENAME)) {
    fail("treatment answer omits the hidden codename");
  }
  if (!Array.isArray(result?.answer?.evidenceKeys) || !result.answer.evidenceKeys.includes("deployment-note")) {
    fail("treatment answer omits its source key");
  }
  if (!Array.isArray(result?.reasoningObserved) || result.reasoningObserved[0] !== true) {
    fail("treatment planning reasoning was not observed");
  }
}

function verifyModelCalls(rows) {
  if (rows.length !== 4) fail(`expected 4 provider calls, observed ${rows.length}`);
  const expectedRequestIds = [
    "agent-no-storage-tool-model-request-1",
    "agent-private-storage-tool-model-request-1",
    "agent-private-storage-tool-model-request-2",
    "agent-private-storage-tool-model-request-3",
  ];
  exactStringArray(rows.map((row) => row.requestId), expectedRequestIds, "model request ids");
  for (const [index, row] of rows.entries()) {
    if (row.schemaVersion !== "general-agent-live/model-call/1") {
      fail(`model call ${index + 1} has the wrong schema`);
    }
    if (row.result?.status !== "succeeded") fail(`model call ${index + 1} did not succeed`);
    if (row.result?.usage?.providerAttempts !== 1) {
      fail(`model call ${index + 1} did not use exactly one provider attempt`);
    }
  }
  const planning = rows[1];
  const reasoning = planning.result?.output?.reasoning;
  if (
    reasoning?.state !== "observed" ||
    !Array.isArray(reasoning.parts) ||
    !reasoning.parts.some((part) => typeof part === "string" && part.length > 0)
  ) {
    fail("the treatment planning call lacks non-empty reasoning evidence");
  }
}

function verifyNoFixtureLeak(runDirectory, fixtureValues) {
  const names = [
    "preregistration.json",
    "provider-responses.jsonl",
    "model-calls.jsonl",
    "cases.jsonl",
    "run-manifest.json",
  ];
  for (const name of names) {
    const bytes = readFileSync(join(runDirectory, name));
    for (const value of fixtureValues) {
      if (value.length >= 8 && bytes.includes(Buffer.from(value, "utf8"))) {
        fail(`${name} contains a configured private fixture value`);
      }
    }
  }
}

function main() {
  const { runId, checkOnly } = parseArguments(process.argv.slice(2));
  const runDirectory = join(artifactRoot, "runs", runId);
  const preregistrationBytes = readFileSync(join(runDirectory, "preregistration.json"));
  const sourcePreregistrationBytes = readFileSync(sourcePreregistrationPath);
  if (!preregistrationBytes.equals(sourcePreregistrationBytes)) {
    fail("run preregistration differs from the registered source bytes");
  }
  const manifestPath = join(runDirectory, "run-manifest.json");
  const modelCallsPath = join(runDirectory, "model-calls.jsonl");
  const providerResponsesPath = join(runDirectory, "provider-responses.jsonl");
  const casesPath = join(runDirectory, "cases.jsonl");
  const manifest = json(manifestPath);
  if (
    manifest.schemaVersion !== "general-agent-live/run-manifest/1" ||
    manifest.experimentId !== "general-agent-live-v0" ||
    manifest.experimentVersion !== 8 ||
    manifest.runId !== runId ||
    manifest.status !== "completed"
  ) {
    fail("run manifest identity or status is invalid");
  }
  if (
    manifest.providerCalls !== 4 ||
    manifest.secretLeasesReleased !== 4 ||
    manifest.productBootstrapModulesRemainRejected !== true ||
    manifest.linuxControlGroupProof !== false
  ) {
    fail("run manifest budgets or support boundary are invalid");
  }
  if (manifest.preregistrationSha256 !== sha256(preregistrationBytes)) {
    fail("run manifest preregistration digest is invalid");
  }
  if (manifest.artifacts?.["model-calls.jsonl"] !== sha256(readFileSync(modelCallsPath))) {
    fail("model-calls.jsonl digest is invalid");
  }
  if (
    manifest.artifacts?.["provider-responses.jsonl"] !==
    sha256(readFileSync(providerResponsesPath))
  ) {
    fail("provider-responses.jsonl digest is invalid");
  }
  if (manifest.artifacts?.["cases.jsonl"] !== sha256(readFileSync(casesPath))) {
    fail("cases.jsonl digest is invalid");
  }

  const cases = jsonLines(casesPath);
  if (cases.length !== 2) fail(`expected 2 cases, observed ${cases.length}`);
  verifyBaseline(cases[0]);
  verifyTreatment(cases[1]);
  verifyModelCalls(jsonLines(modelCallsPath));
  const providerResponses = jsonLines(providerResponsesPath);
  if (
    providerResponses.length !== 4 ||
    providerResponses.some(
      (row) =>
        row.schemaVersion !== "general-agent-live/provider-response/1" ||
        row.httpStatus !== 200 ||
        row.response === null,
    )
  ) {
    fail("provider raw response inventory is invalid");
  }
  verifyNoFixtureLeak(runDirectory, loadFixtureValues());

  const verification = {
    schemaVersion: "general-agent-live/verification/1",
    experimentId: "general-agent-live-v0",
    experimentVersion: 8,
    runId,
    valid: true,
    checks: {
      preregistrationByteIdentity: true,
      manifestAndArtifactDigests: true,
      exactCaseCount: 2,
      exactProviderCallCount: 4,
      baselineNoSecretGuess: true,
      treatmentToolSequence: true,
      treatmentGroundedAnswer: true,
      treatmentReasoningObserved: true,
      schedulerCompletion: true,
      childCredentialIsolation: true,
      configuredFixtureValueLeakage: false,
      productBootstrapModulesRemainRejected: true,
      linuxControlGroupProof: false,
    },
  };
  if (!checkOnly) {
    writeFileSync(
      join(runDirectory, "verification.json"),
      `${JSON.stringify(verification, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  process.stdout.write(`${JSON.stringify(verification)}\n`);
}

main();
