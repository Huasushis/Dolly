#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CELL_IDS,
  EXPERIMENT_ID,
  EXPERIMENT_VERSION,
  REQUIRED_IMPLEMENTATION_FILES,
  serializeJsonLines,
  sha256,
  stableJson,
} from "./common.mjs";
import {
  assertDatasetStructure,
  buildCellEvidence,
  constructDeterministicCheckpoint,
  generateDataset,
  retrieveAssociationRecords,
} from "./dataset.mjs";
import {
  analyzeCases,
  makeCaseRow,
  runDeterministicReader,
} from "./scorer.mjs";
import { validateMemoryFactorialPreregistration } from "./validate-preregistration.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../../..");
const WORKSPACE_ROOT = resolve(REPOSITORY_ROOT, "..");
const PREREGISTRATION_PATH = "docs/experiments/preregistrations/memory-factorial-v0.json";

function repositoryPath(path) {
  return resolve(REPOSITORY_ROOT, path);
}

function readUtf8(path) {
  return readFileSync(repositoryPath(path), "utf8");
}

function gitOutput(args) {
  try {
    return execFileSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

export function prepareFreeze({
  runId = "in-memory-v2",
  frozenAt = "1970-01-01T00:00:00.000Z",
  enforceRegisteredHashes = true,
  enforceProtocolHash = true,
} = {}) {
  const validation = validateMemoryFactorialPreregistration(undefined, { enforceProtocolHash });
  if (!validation.valid) {
    throw new Error(`preregistration invalid before freeze: ${validation.errors.join(", ")}`);
  }
  const preregistrationText = readUtf8(PREREGISTRATION_PATH);
  const preregistration = JSON.parse(preregistrationText);
  const preregistrationSnapshot = `${stableJson(preregistration)}\n`;
  if (preregistration.experimentId !== EXPERIMENT_ID || preregistration.experimentVersion !== EXPERIMENT_VERSION) {
    throw new Error("preregistration identity does not match implementation");
  }
  const protocolText = readUtf8(preregistration.protocol.path);
  const protocolSha256 = sha256(protocolText);
  if (enforceProtocolHash && protocolSha256 !== preregistration.protocol.sha256) {
    throw new Error("protocol hash changed before freeze");
  }
  const implementationFiles = REQUIRED_IMPLEMENTATION_FILES.map((path) => ({
    path,
    sha256: sha256(readUtf8(path)),
  }));
  if (enforceRegisteredHashes) {
    const expected = new Map(
      (preregistration.domainDesign.implementationFiles ?? []).map((entry) => [entry.path, entry.sha256]),
    );
    for (const entry of implementationFiles) {
      if (expected.get(entry.path) !== entry.sha256) {
        throw new Error(`implementation hash changed before freeze: ${entry.path}`);
      }
    }
  }
  const dataset = generateDataset();
  assertDatasetStructure(dataset);
  const datasetText = serializeJsonLines(dataset);
  const expectedDatasetSha256 = preregistration.domainDesign.datasetSha256;
  const datasetSha256 = sha256(datasetText);
  if (enforceRegisteredHashes && datasetSha256 !== expectedDatasetSha256) {
    throw new Error("dataset hash changed before freeze");
  }
  return {
    freeze: {
      schemaVersion: "memory-factorial/freeze-v2",
      experimentId: EXPERIMENT_ID,
      experimentVersion: EXPERIMENT_VERSION,
      runId,
      frozenAt,
      sourceCommit: gitOutput(["rev-parse", "HEAD"]),
      dirtyWorktree: gitOutput(["status", "--short"]).length > 0,
      preregistrationPath: PREREGISTRATION_PATH,
      preregistrationSha256: sha256(preregistrationSnapshot),
      protocolPath: preregistration.protocol.path,
      protocolSha256,
      datasetSha256,
      implementationFiles,
      resultComputationStarted: false,
    },
    preregistration,
    preregistrationSnapshot,
    dataset,
    datasetText,
  };
}

function artifactPayloads(bundle) {
  return {
    "run-freeze.json": `${stableJson(bundle.freeze)}\n`,
    "preregistration.json": `${stableJson(bundle.preregistration)}\n`,
    "dataset.jsonl": serializeJsonLines(bundle.dataset),
    "checkpoints.jsonl": serializeJsonLines(bundle.checkpoints),
    "cases.jsonl": serializeJsonLines(bundle.cases),
    "analysis.json": `${stableJson(bundle.analysis)}\n`,
    "run-manifest.json": `${stableJson(bundle.manifest)}\n`,
  };
}

function createArtifactBundleFromPrepared(prepared) {
  const freeze = prepared.freeze;
  const checkpoints = [];
  const cases = [];
  for (const scenario of prepared.dataset) {
    const associationRecords = retrieveAssociationRecords(scenario);
    const checkpoint = constructDeterministicCheckpoint(scenario, associationRecords);
    checkpoints.push(checkpoint);
    for (const cellId of CELL_IDS) {
      const evidence = buildCellEvidence(scenario, cellId, checkpoint);
      const output = runDeterministicReader(scenario, evidence);
      cases.push(makeCaseRow(scenario, cellId, evidence, output));
    }
  }
  const analysis = analyzeCases(cases);
  const manifest = {
    schemaVersion: "memory-factorial/manifest-v2",
    experimentId: EXPERIMENT_ID,
    experimentVersion: EXPERIMENT_VERSION,
    runId: freeze.runId,
    preregistrationSha256: freeze.preregistrationSha256,
    protocolSha256: freeze.protocolSha256,
    datasetSha256: freeze.datasetSha256,
    sourceCommit: freeze.sourceCommit,
    dirtyWorktree: freeze.dirtyWorktree,
    backend: "local-deterministic",
    modelEndpointCapabilityProfile: null,
    modelIdentifier: null,
    configuration: {
      cells: CELL_IDS,
      reader: "closed-schema deterministic reference reader",
      networkUsed: false,
      modelCalls: 0,
    },
    dataset: { scenarios: prepared.dataset.length, taskFamilies: 2, cueTypes: 4 },
    seeds: [...new Set(prepared.dataset.map((scenario) => scenario.seed))],
    executionOrder: cases.map((row) => row.caseId),
    resourceBudgets: { maximumCases: 64, maximumEvidenceBytesPerCase: 4096 },
    perCaseAccounting: { datasetRows: prepared.dataset.length, checkpointRows: checkpoints.length, caseRows: cases.length },
    rawOutputs: { modelRawRows: 0, deterministicCaseRows: cases.length },
    validatorResults: null,
    aggregateMetrics: analysis,
    startedAt: freeze.frozenAt,
    finishedAt: freeze.frozenAt,
    failure: null,
  };
  const bundle = {
    freeze,
    preregistration: prepared.preregistration,
    dataset: prepared.dataset,
    checkpoints,
    cases,
    analysis,
    manifest,
  };
  const payloads = artifactPayloads(bundle);
  bundle.checksums = Object.fromEntries(
    Object.entries(payloads).map(([name, payload]) => [name, sha256(payload)]),
  );
  return bundle;
}

export function createArtifactBundle(options = {}) {
  return createArtifactBundleFromPrepared(prepareFreeze(options));
}

export function bundleDigest(bundle) {
  return sha256(stableJson({
    dataset: bundle.dataset,
    checkpoints: bundle.checkpoints,
    cases: bundle.cases,
    analysis: bundle.analysis,
  }));
}

export function writeArtifactBundle(outputDirectory, options = {}) {
  const absoluteOutput = resolve(outputDirectory);
  const relativeToWorkspace = relative(WORKSPACE_ROOT, absoluteOutput);
  if (relativeToWorkspace === ".." || relativeToWorkspace.startsWith(`..${sep}`)) {
    throw new Error(`output must stay under ${WORKSPACE_ROOT}`);
  }
  if (existsSync(absoluteOutput)) throw new Error(`refusing to overwrite existing output ${absoluteOutput}`);
  const prepared = prepareFreeze(options);
  mkdirSync(absoluteOutput, { recursive: false });

  // The freeze is deliberately the first result-directory write. A formal run
  // cannot create case or analysis bytes before input and implementation hashes
  // have been persisted.
  writeFileSync(resolve(absoluteOutput, "run-freeze.json"), `${stableJson(prepared.freeze)}\n`, { flag: "wx" });
  const bundle = createArtifactBundleFromPrepared(prepared);
  const payloads = artifactPayloads(bundle);
  for (const [name, payload] of Object.entries(payloads)) {
    if (name === "run-freeze.json") continue;
    writeFileSync(resolve(absoluteOutput, name), payload, { flag: "wx" });
  }
  const checksumText = `${Object.entries(bundle.checksums)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest}  ${name}`)
    .join("\n")}\n`;
  writeFileSync(resolve(absoluteOutput, "sha256sums.txt"), checksumText, { flag: "wx" });
  return { outputDirectory: absoluteOutput, bundleDigest: bundleDigest(bundle), cases: bundle.cases.length };
}

function parseOutputArgument(argv) {
  const index = argv.indexOf("--output");
  if (index === -1 || !argv[index + 1] || argv.length !== 2) {
    throw new Error("usage: node run.mjs --output <repository-parent>/<unique-directory>");
  }
  return argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = parseOutputArgument(process.argv.slice(2));
  const result = writeArtifactBundle(output, {
    runId: `deterministic-v2-${new Date().toISOString().replaceAll(/[:.]/gu, "")}`,
    frozenAt: new Date().toISOString(),
    enforceRegisteredHashes: true,
  });
  process.stdout.write(`${stableJson(result)}\n`);
}
