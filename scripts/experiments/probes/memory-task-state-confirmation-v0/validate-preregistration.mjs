#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../../..");
const preregistrationPath = path.join(
  repositoryRoot,
  "docs/experiments/preregistrations/memory-task-state-confirmation-v0.json",
);
const schemaPath = path.join(
  repositoryRoot,
  "docs/experiments/preregistrations/memory-task-state-confirmation-v0-schema.json",
);
const CONDITION_IDS = [
  "content-raw",
  "association-raw",
  "checkpoint-only",
  "checkpoint-association",
];
const CUE_STATES = ["positive", "do-not-resume", "cancelled", "superseded"];
const REQUIRED_FILES = [
  "preregistration.json",
  "dataset.jsonl",
  "cases.jsonl",
  "model-raw.jsonl",
  "analysis.json",
  "run-manifest.json",
  "validation.json",
  "sha256sums.txt",
];
const MUTATION_IDS = [
  "remove-case",
  "flip-stream-false",
  "inject-enable-thinking",
  "retry-http200-content",
  "swap-scenario-output",
  "accept-duplicate-citation-as-extra-claim",
  "remove-artifact-digest",
  "inject-configured-secret",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectExactObject(value, expected, label, errors) {
  if (!same(value, expected)) errors.push(`${label} mismatch`);
}

async function main() {
  const [preregistrationBytes, schemaBytes] = await Promise.all([
    readFile(preregistrationPath),
    readFile(schemaPath),
  ]);
  const preregistration = JSON.parse(preregistrationBytes);
  const schema = JSON.parse(schemaBytes);
  const errors = [];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(preregistration)) {
    for (const error of validate.errors ?? []) {
      errors.push(`schema ${error.instancePath || "/"} ${error.message}`);
    }
  }

  const protocolPath = path.resolve(repositoryRoot, preregistration.protocol?.path ?? "invalid");
  if (!protocolPath.startsWith(`${repositoryRoot}${path.sep}`)) {
    errors.push("protocol path escaped repository");
  } else {
    try {
      if (sha256(await readFile(protocolPath)) !== preregistration.protocol.sha256) {
        errors.push("protocol hash mismatch");
      }
    } catch {
      errors.push("protocol file is missing");
    }
  }

  if (!same(preregistration.conditions?.map((condition) => condition.id), CONDITION_IDS)) {
    errors.push("condition order mismatch");
  }
  if (!same(preregistration.data?.cueStates, CUE_STATES)) errors.push("cue-state order mismatch");
  const baseTasks = preregistration.data?.baseTasks ?? [];
  if (baseTasks.length !== 4 || new Set(baseTasks.map((task) => task.taskId)).size !== 4) {
    errors.push("base task identity mismatch");
  }
  const familyCounts = Object.fromEntries([...new Set(baseTasks.map((task) => task.family))]
    .map((family) => [family, baseTasks.filter((task) => task.family === family).length]));
  if (!same(familyCounts, { "data-processing": 2, "service-incident": 2 })) {
    errors.push("two-by-two family design mismatch");
  }
  const expectedScenarioIds = baseTasks.flatMap((task) => CUE_STATES.map((state) =>
    `${task.family}/${task.taskId}/${state}`
  ));
  if (!same(preregistration.domainDesign?.scenarioIds, expectedScenarioIds)) {
    errors.push("scenario identity mismatch");
  }
  if (!same(preregistration.domainDesign?.conditionOrder, CONDITION_IDS)) {
    errors.push("domain condition order mismatch");
  }

  expectExactObject(preregistration.requestProfile, {
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: "disabled" },
    forbiddenRequestField: "enable_thinking",
    max_tokens: 1200,
    timeout_ms: 900000,
    temperature: 0,
    nonStreamFallbackAllowed: false,
  }, "request profile", errors);
  expectExactObject(preregistration.retryPolicy, {
    maxAttemptsPerLogicalCall: 2,
    retryDelayMs: 2000,
    retryableFailures: [
      "timeout",
      "network-before-response-headers",
      "http-408",
      "http-425",
      "http-429",
      "http-5xx",
    ],
    http200ContentFailureRetryAllowed: false,
    maxLogicalCalls: 64,
    maxRequestAttempts: 128,
  }, "retry policy", errors);
  if (
    preregistration.execution?.plannedCases !== 64 ||
    preregistration.execution?.maxLogicalCalls !== 64 ||
    preregistration.execution?.maxRequestAttempts !== 128 ||
    preregistration.execution?.maxWallClockMs !== 7_200_000 ||
    !same(preregistration.execution?.casePlan?.map((entry) => [entry.id, entry.count]), [
      ["agent-cases", 64],
    ])
  ) {
    errors.push("execution budget or plan mismatch");
  }
  const contract = preregistration.outputContract;
  if (!same(contract?.closedKeys, [
    "schemaVersion",
    "decision",
    "decisionReason",
    "taskId",
    "taskState",
    "action",
    "constraints",
    "support",
    "uncertain",
  ]) || !same(contract?.supportKeys, ["taskState", "action", "constraints"])) {
    errors.push("closed output contract mismatch");
  }
  const thresholds = preregistration.minimumEffectiveDifference;
  expectExactObject(thresholds, {
    actionBearingRequiredSuccesses: 8,
    pairedActionBearingImprovementsOverContent: 2,
    pairedActionBearingLossesMaximum: 0,
    falseResumeMaximum: 0,
    obsoleteActionUseMaximum: 0,
    invalidOrUnrelatedCitationMaximum: 0,
    checkpointPairedLossesMaximum: 1,
    checkpointMinimumEvidenceReduction: 0.25,
    compositionMinimumUniqueRescues: 2,
    compositionPairedLossesMaximum: 0,
    compositionMaximumP95EvidenceRatio: 1.5,
  }, "minimum effective difference", errors);
  if (!same(preregistration.artifacts?.requiredFiles, REQUIRED_FILES)) {
    errors.push("artifact inventory mismatch");
  }
  if (!same(preregistration.independentValidation?.mutationIds, MUTATION_IDS)) {
    errors.push("mutation inventory mismatch");
  }
  if (
    preregistration.backend?.required !== "live" ||
    preregistration.backend?.model !== "qwen3.6-27b" ||
    preregistration.backend?.silentFallbackAllowed !== false
  ) {
    errors.push("backend contract mismatch");
  }
  if (
    preregistration.safetyBoundary?.productRuntimeUsed !== false ||
    preregistration.safetyBoundary?.moduleLaunchAllowed !== false ||
    preregistration.safetyBoundary?.moduleStartupRefusalMustRemain !== true ||
    preregistration.safetyBoundary?.modelDownloadAllowed !== false
  ) {
    errors.push("safety boundary mismatch");
  }
  if (preregistration.domainDesign?.scientificEvidence !== false) {
    errors.push("pre-run scientificEvidence must be false");
  }

  const result = {
    valid: errors.length === 0,
    validationScope: "schema-and-exact-confirmation-contract",
    preregistrationPath,
    preregistrationSha256: sha256(preregistrationBytes),
    schemaPath,
    schemaSha256: sha256(schemaBytes),
    errors,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
