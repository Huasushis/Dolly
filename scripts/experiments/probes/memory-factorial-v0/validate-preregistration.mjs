import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../../..");
export const PREREGISTRATION_PATH = resolve(
  REPOSITORY_ROOT,
  "docs/experiments/preregistrations/memory-factorial-v0.json",
);
const SCHEMA_PATH = resolve(
  REPOSITORY_ROOT,
  "docs/experiments/preregistrations/memory-factorial-v0-schema.json",
);

const CELL_IDS = [
  "content-raw",
  "association-raw",
  "deterministic-checkpoint",
  "checkpoint-association-raw",
];
const CUE_TYPES = ["positive", "do-not-resume", "cancelled", "superseded"];
const REQUIRED_ARTIFACTS = [
  "run-freeze.json",
  "preregistration.json",
  "dataset.jsonl",
  "checkpoints.jsonl",
  "cases.jsonl",
  "analysis.json",
  "run-manifest.json",
  "sha256sums.txt",
  "validation.json",
  "mutation-validation.json",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateMemoryFactorialPreregistration(
  path = PREREGISTRATION_PATH,
  { enforceProtocolHash = true } = {},
) {
  const preregistration = JSON.parse(readFileSync(path, "utf8"));
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const errors = [];
  if (!validate(preregistration)) {
    for (const error of validate.errors ?? []) {
      errors.push(`schema ${error.instancePath || "/"} ${error.message}`);
    }
  }
  if (enforceProtocolHash) {
    const protocolPath = resolve(REPOSITORY_ROOT, preregistration.protocol?.path ?? "invalid");
    if (sha256(readFileSync(protocolPath)) !== preregistration.protocol?.sha256) {
      errors.push("protocol hash mismatch");
    }
  }
  const conditionIds = [
    ...(preregistration.conditions?.baselines ?? []),
    ...(preregistration.conditions?.treatments ?? []),
  ].map((condition) => condition.id);
  if (!same(conditionIds, CELL_IDS)) errors.push("condition order mismatch");
  if (!same(preregistration.domainDesign?.factorMatrix?.cueTypes, CUE_TYPES)) {
    errors.push("cue order mismatch");
  }
  if (!same(preregistration.domainDesign?.factorMatrix?.cells, CELL_IDS)) {
    errors.push("factor-cell order mismatch");
  }
  if (
    preregistration.execution?.plannedMaximumCases !== 64 ||
    preregistration.randomness?.repetitionsPerCase !== 1 ||
    !same(preregistration.data?.evaluation?.seeds, [501, 502, 503, 504])
  ) {
    errors.push("case plan mismatch");
  }
  if (
    preregistration.backend?.requiredKind !== "local" ||
    preregistration.backend?.networkRequired !== false ||
    preregistration.backend?.credentialsRequired !== false ||
    preregistration.backend?.silentFallbackAllowed !== false
  ) {
    errors.push("backend boundary mismatch");
  }
  if (!same(preregistration.artifacts?.requiredFiles, REQUIRED_ARTIFACTS)) {
    errors.push("artifact inventory mismatch");
  }
  if (
    preregistration.domainDesign?.implementationStatus !==
      "The public deterministic generator, scorer, runner, independent verifier, mutation harness, and conformance tests exist. No formal result directory or model evidence has been produced in this version."
  ) {
    errors.push("implementation support statement mismatch");
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    preregistration,
  });
}
