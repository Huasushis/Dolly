#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const workspaceTemporaryRoot = resolve(repositoryRoot, "..", ".tmp");
const verifierPath = fileURLToPath(import.meta.url);
const artifactRoot = join(
  repositoryRoot,
  "artifacts/experiments/probes/general-agent-tool-registry-v1",
);
const sourcePreregistrationPath = join(
  repositoryRoot,
  "docs/experiments/preregistrations/general-agent-tool-registry-v1.json",
);
const extensionSourcePath = join(scriptDirectory, "extension.mjs");
const HIDDEN_CODENAME = "EMBER-7421";
const IMPLEMENTATION_PATHS = [
  "scripts/experiments/probes/general-agent-live-v0/run.mts",
  "scripts/experiments/probes/general-agent-live-v0/extension.mjs",
  "scripts/experiments/probes/general-agent-live-v0/verify-tool-registry.mjs",
];

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  if (
    (argv.length !== 2 && argv.length !== 3 && argv.length !== 5) ||
    argv[0] !== "--run-id" ||
    !/^registry-v2-[A-Za-z0-9._-]+$/u.test(argv[1]) ||
    (argv.length >= 3 && argv[2] !== "--check-only") ||
    (argv.length === 5 && argv[3] !== "--run-directory")
  ) {
    fail("usage: verify-tool-registry.mjs --run-id registry-v2-<identifier> [--check-only [--run-directory <workspace-temp-run>]]");
  }
  const runId = argv[1];
  let runDirectory;
  if (argv.length === 5) {
    runDirectory = resolve(argv[4]);
    if (
      basename(runDirectory) !== runId ||
      (runDirectory !== workspaceTemporaryRoot &&
        !runDirectory.startsWith(`${workspaceTemporaryRoot}/`))
    ) {
      fail("override run directory is outside the workspace temporary root or has the wrong basename");
    }
  }
  return { runId, checkOnly: argv[2] === "--check-only", runDirectory };
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

function exactArray(value, expected, label) {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    fail(`${label} is not ${JSON.stringify(expected)}`);
  }
}

function verifyCaseEnvelope(row, conditionId, evaluationSeed, repetition) {
  if (row?.schemaVersion !== "general-agent-live/case/1" || row.conditionId !== conditionId) {
    fail(`${conditionId} case identity is invalid`);
  }
  if (row.evaluationSeed !== evaluationSeed || row.repetition !== repetition) {
    fail(`${conditionId} evaluation seed or repetition is invalid`);
  }
  if (
    row.schedulerCompletion !== true ||
    row.childPidRecorded !== true ||
    row.childStopped !== true
  ) {
    fail(`${conditionId} Scheduler/process completion evidence is false`);
  }
  if (row.linuxControlGroupProof !== false) {
    fail(`${conditionId} overclaims Linux control-group proof`);
  }
}

function verifyBaseline(row, evaluationSeed, repetition) {
  verifyCaseEnvelope(row, "no-storage-tool", evaluationSeed, repetition);
  const result = row.result;
  if (result?.conditionId !== "no-storage-tool") fail("baseline result condition is wrong");
  exactArray(result?.actions, ["answer"], "baseline actions");
  exactArray(
    result?.capabilityContracts,
    [{ capabilityType: "model-operation", capabilityVersion: "v2" }],
    "baseline capability contracts",
  );
  if (result?.childCredentialEnvironmentPresent !== false) {
    fail("baseline child observed an Aether environment variable");
  }
  if (result?.answer?.grounded !== false) fail("baseline answer claims unsupported grounding");
  exactArray(result?.answer?.evidenceKeys, [], "baseline evidence keys");
  if (JSON.stringify(result.answer).includes(HIDDEN_CODENAME)) {
    fail("baseline guessed the hidden codename");
  }
}

function verifyRegistry(registry, moduleJobId) {
  if (
    registry?.schemaVersion !== "dolly.tool-registry-view/2" ||
    registry.moduleJobId !== moduleJobId ||
    typeof registry.registryDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(registry.registryDigest)
  ) {
    fail("treatment registry identity is invalid");
  }
  exactArray(
    registry.tools?.map((tool) => tool.name),
    ["storage_get", "storage_list"],
    "registry tool names",
  );
  for (const tool of registry.tools) {
    if (
      tool.schemaDialect !== "dolly.tool-value-schema/1" ||
      !Object.hasOwn(tool, "argumentSchema") ||
      !Object.hasOwn(tool, "successResultSchema") ||
      !Object.hasOwn(tool, "effectClass") ||
      !Object.hasOwn(tool, "limits") ||
      Object.hasOwn(tool, "toolId") ||
      Object.hasOwn(tool, "resourceScope")
    ) {
      fail(`registry tool ${String(tool.name)} is incomplete or exposes an internal field`);
    }
    if (tool.effectClass !== "read" || tool.approval !== "never") {
      fail(`registry tool ${String(tool.name)} is not read-only without approval`);
    }
  }
  const listTool = registry.tools.find((tool) => tool.name === "storage_list");
  if (
    listTool?.argumentSchema?.type !== "object" ||
    listTool.argumentSchema.properties?.limit?.type !== "integer" ||
    listTool.argumentSchema.properties.limit.maximum !== 3 ||
    !Array.isArray(listTool.argumentSchema.required) ||
    !listTool.argumentSchema.required.includes("limit") ||
    !listTool.argumentSchema.required.includes("prefix")
  ) {
    fail("registry list limit or required argument contract is wrong");
  }
  return registry.registryDigest;
}

function verifyTreatment(row, evaluationSeed, repetition) {
  verifyCaseEnvelope(row, "tool-registry-storage", evaluationSeed, repetition);
  const result = row.result;
  if (result?.conditionId !== "tool-registry-storage") {
    fail("treatment result condition is wrong");
  }
  exactArray(
    result?.actions,
    ["storage_list", "storage_get", "answer"],
    "treatment actions",
  );
  exactArray(
    result?.capabilityTypes,
    ["model-operation", "tool-invocation"],
    "treatment child capability types",
  );
  exactArray(
    result?.capabilityContracts,
    [
      { capabilityType: "model-operation", capabilityVersion: "v2" },
      { capabilityType: "tool-invocation", capabilityVersion: "v2" },
    ],
    "treatment capability contracts",
  );
  if (result.capabilityTypes.includes("module-private-storage")) {
    fail("treatment child received the forbidden raw storage capability");
  }
  if (result.childCredentialEnvironmentPresent !== false) {
    fail("treatment child observed an Aether environment variable");
  }
  const registryDigest = verifyRegistry(result.toolRegistry, row.commit?.moduleJobId);
  exactArray(
    result.toolRoundRegistryDigests,
    [registryDigest, registryDigest],
    "tool-round registry digests",
  );
  if (!Array.isArray(result.toolArguments) || result.toolArguments.length !== 2) {
    fail("treatment tool argument evidence is incomplete");
  }
  const [listCall, getCall] = result.toolArguments;
  if (
    listCall?.name !== "storage_list" ||
    listCall.arguments === null ||
    Array.isArray(listCall.arguments) ||
    typeof listCall.arguments !== "object" ||
    typeof listCall.arguments.prefix !== "string" ||
    !Number.isSafeInteger(listCall.arguments.limit) ||
    listCall.arguments.limit < 1 ||
    listCall.arguments.limit > 3
  ) {
    fail("model did not obey the registry-derived list arguments");
  }
  if (getCall?.name !== "storage_get" || getCall.arguments?.key !== "deployment-note") {
    fail("model did not read the active deployment note selected from the list result");
  }
  if (result.answer?.grounded !== true) fail("treatment answer is not grounded");
  if (
    typeof result.answer?.answer !== "string" ||
    !result.answer.answer.includes(HIDDEN_CODENAME)
  ) {
    fail("treatment answer omits the hidden codename");
  }
  if (
    !Array.isArray(result.answer?.evidenceKeys) ||
    !result.answer.evidenceKeys.includes("deployment-note")
  ) {
    fail("treatment answer omits its source key");
  }
  if (!Array.isArray(result.reasoningObserved) || result.reasoningObserved[0] !== true) {
    fail("treatment planning reasoning was not observed");
  }
}

function verifyModelCalls(rows) {
  if (rows.length !== 8) fail(`expected 8 provider calls, observed ${rows.length}`);
  exactArray(
    rows.map((row) => row.requestId),
    [
      "agent-no-storage-tool-seed-7421-model-request-1",
      "agent-tool-registry-storage-seed-7421-model-request-1",
      "agent-tool-registry-storage-seed-7421-model-request-2",
      "agent-tool-registry-storage-seed-7421-model-request-3",
      "agent-tool-registry-storage-seed-7422-model-request-1",
      "agent-tool-registry-storage-seed-7422-model-request-2",
      "agent-tool-registry-storage-seed-7422-model-request-3",
      "agent-no-storage-tool-seed-7422-model-request-1",
    ],
    "model request ids",
  );
  for (const [index, row] of rows.entries()) {
    if (
      row.schemaVersion !== "general-agent-live/model-call/1" ||
      row.result?.status !== "succeeded" ||
      row.result?.usage?.providerAttempts !== 1
    ) {
      fail(`model call ${index + 1} identity, outcome, or attempt count is invalid`);
    }
    if (
      row.input?.schemaVersion !== "dolly.model.chat-input/3" ||
      JSON.stringify(row.input?.outputContract) !== JSON.stringify({ kind: "json-object" })
    ) {
      fail(`model call ${index + 1} did not use the frozen JSON-object contract`);
    }
    try {
      const parsed = JSON.parse(row.result.output.finalContent);
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
        fail(`model call ${index + 1} output is not one JSON object`);
      }
    } catch {
      fail(`model call ${index + 1} output is not exact JSON`);
    }
  }
  for (const planning of [rows[1], rows[4]]) {
    const reasoning = planning.result?.output?.reasoning;
    if (
      reasoning?.state !== "observed" ||
      !Array.isArray(reasoning.parts) ||
      !reasoning.parts.some((part) => typeof part === "string" && part.length > 0)
    ) {
      fail("a treatment planning call lacks non-empty reasoning evidence");
    }
    const prompt = planning.input?.messages?.[0]?.parts?.[0]?.text;
    if (
      typeof prompt !== "string" ||
      !prompt.includes('"schemaVersion":"dolly.tool-registry-view/2"') ||
      !prompt.includes('"maximum":3') ||
      !prompt.includes('"successResultSchema"')
    ) {
      fail("a treatment planning prompt lacks the machine-readable registry contract");
    }
  }
}

function verifySourceIndependence(preregistration, manifest) {
  const source = readFileSync(extensionSourcePath, "utf8");
  for (const forbidden of ["storage_list", "storage_get", "STORAGE_TOOL_LIST_LIMIT"]) {
    if (source.includes(forbidden)) fail(`Extension source hard-codes ${forbidden}`);
  }
  if (/\blimit\s*:\s*3\b/u.test(source) || /"maximum"\s*:\s*3\b/u.test(source)) {
    fail("Extension source hard-codes the registered storage list limit");
  }
  const registered = preregistration.domainDesign?.implementationFiles;
  if (
    registered === null ||
    Array.isArray(registered) ||
    typeof registered !== "object" ||
    JSON.stringify(Object.keys(registered).sort()) !== JSON.stringify([...IMPLEMENTATION_PATHS].sort())
  ) {
    fail("preregistration implementation file inventory is invalid");
  }
  for (const path of IMPLEMENTATION_PATHS) {
    const actual = sha256(readFileSync(join(repositoryRoot, path)));
    if (
      registered[path] !== actual ||
      manifest.configuration?.implementationSha256?.[path] !== actual
    ) {
      fail(`implementation bytes differ from the frozen digest for ${path}`);
    }
  }
}

function verifyNoPrivateLeak(runDirectory, fixtureValues) {
  const names = [
    "preregistration.json",
    "provider-responses.jsonl",
    "model-calls.jsonl",
    "cases.jsonl",
    "analysis.json",
    "run-manifest.json",
  ];
  for (const name of names) {
    const bytes = readFileSync(join(runDirectory, name));
    for (const value of fixtureValues) {
      if (value.length >= 8 && bytes.includes(Buffer.from(value, "utf8"))) {
        fail(`${name} contains a configured private fixture value`);
      }
    }
    if (/"handle"\s*:/u.test(bytes.toString("utf8"))) {
      fail(`${name} contains a capability handle field`);
    }
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonLines(path, rows) {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function refreshManifestArtifactDigests(runDirectory, names) {
  const manifestPath = join(runDirectory, "run-manifest.json");
  const manifest = json(manifestPath);
  const rawFieldByName = {
    "provider-responses.jsonl": "providerResponsesSha256",
    "model-calls.jsonl": "modelCallsSha256",
    "cases.jsonl": "casesSha256",
    "analysis.json": "analysisSha256",
  };
  for (const name of names) {
    const digest = sha256(readFileSync(join(runDirectory, name)));
    manifest.artifacts[name] = digest;
    manifest.rawOutputs[rawFieldByName[name]] = digest;
  }
  writeJson(manifestPath, manifest);
}

function runMutationChecks(sourceRunDirectory, runId, fixtureValues) {
  mkdirSync(workspaceTemporaryRoot, { recursive: true, mode: 0o700 });
  const mutationRoot = mkdtempSync(join(workspaceTemporaryRoot, "registry-v2-mutations-"));
  const mutations = [
    {
      id: "capability-version-v1",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "cases.jsonl"));
        rows[0].result.capabilityContracts[0].capabilityVersion = "v1";
        writeJsonLines(join(runDirectory, "cases.jsonl"), rows);
        refreshManifestArtifactDigests(runDirectory, ["cases.jsonl"]);
      },
    },
    {
      id: "chat-input-v2",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "model-calls.jsonl"));
        rows[0].input.schemaVersion = "dolly.model.chat-input/2";
        writeJsonLines(join(runDirectory, "model-calls.jsonl"), rows);
        refreshManifestArtifactDigests(runDirectory, ["model-calls.jsonl"]);
      },
    },
    {
      id: "text-output-contract",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "model-calls.jsonl"));
        rows[0].input.outputContract = { kind: "text" };
        writeJsonLines(join(runDirectory, "model-calls.jsonl"), rows);
        refreshManifestArtifactDigests(runDirectory, ["model-calls.jsonl"]);
      },
    },
    {
      id: "prose-wrapped-json",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "model-calls.jsonl"));
        rows[0].result.output.finalContent = `prose before JSON\n${rows[0].result.output.finalContent}`;
        writeJsonLines(join(runDirectory, "model-calls.jsonl"), rows);
        refreshManifestArtifactDigests(runDirectory, ["model-calls.jsonl"]);
      },
    },
    {
      id: "provider-wire-response-format-drift",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "provider-responses.jsonl"));
        rows[0].requestBody.response_format = { type: "text" };
        rows[0].requestBodySha256 = sha256(
          Buffer.from(JSON.stringify(rows[0].requestBody), "utf8"),
        );
        writeJsonLines(join(runDirectory, "provider-responses.jsonl"), rows);
        refreshManifestArtifactDigests(runDirectory, ["provider-responses.jsonl"]);
      },
    },
    {
      id: "registry-digest-mismatch",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "cases.jsonl"));
        rows[1].result.toolRoundRegistryDigests[0] = `sha256:${"0".repeat(64)}`;
        writeJsonLines(join(runDirectory, "cases.jsonl"), rows);
        refreshManifestArtifactDigests(runDirectory, ["cases.jsonl"]);
      },
    },
    {
      id: "list-schema-limit-four",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "cases.jsonl"));
        const list = rows[1].result.toolRegistry.tools.find((tool) => tool.name === "storage_list");
        list.argumentSchema.properties.limit.maximum = 4;
        writeJsonLines(join(runDirectory, "cases.jsonl"), rows);
        refreshManifestArtifactDigests(runDirectory, ["cases.jsonl"]);
      },
    },
    {
      id: "list-argument-four",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "cases.jsonl"));
        rows[1].result.toolArguments[0].arguments.limit = 4;
        writeJsonLines(join(runDirectory, "cases.jsonl"), rows);
        refreshManifestArtifactDigests(runDirectory, ["cases.jsonl"]);
      },
    },
    {
      id: "provider-row-missing",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "provider-responses.jsonl"));
        writeJsonLines(join(runDirectory, "provider-responses.jsonl"), rows.slice(0, -1));
        refreshManifestArtifactDigests(runDirectory, ["provider-responses.jsonl"]);
      },
    },
    {
      id: "case-row-missing",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "cases.jsonl"));
        writeJsonLines(join(runDirectory, "cases.jsonl"), rows.slice(0, -1));
        refreshManifestArtifactDigests(runDirectory, ["cases.jsonl"]);
      },
    },
    {
      id: "reasoning-evidence-missing",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "model-calls.jsonl"));
        rows[1].result.output.reasoning = { state: "not-observed" };
        writeJsonLines(join(runDirectory, "model-calls.jsonl"), rows);
        refreshManifestArtifactDigests(runDirectory, ["model-calls.jsonl"]);
      },
    },
    {
      id: "scheduler-completion-false",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "cases.jsonl"));
        rows[0].schedulerCompletion = false;
        writeJsonLines(join(runDirectory, "cases.jsonl"), rows);
        refreshManifestArtifactDigests(runDirectory, ["cases.jsonl"]);
      },
    },
    {
      id: "child-stop-false",
      apply(runDirectory) {
        const rows = jsonLines(join(runDirectory, "cases.jsonl"));
        rows[0].childStopped = false;
        writeJsonLines(join(runDirectory, "cases.jsonl"), rows);
        refreshManifestArtifactDigests(runDirectory, ["cases.jsonl"]);
      },
    },
    {
      id: "capability-handle-field",
      apply(runDirectory) {
        const analysisPath = join(runDirectory, "analysis.json");
        const analysis = json(analysisPath);
        analysis.handle = "forbidden-test-handle";
        writeJson(analysisPath, analysis);
        refreshManifestArtifactDigests(runDirectory, ["analysis.json"]);
      },
    },
  ];
  const results = [];
  try {
    for (const mutation of mutations) {
      const runDirectory = join(mutationRoot, mutation.id, runId);
      cpSync(sourceRunDirectory, runDirectory, { recursive: true, errorOnExist: true });
      mutation.apply(runDirectory);
      let rejected = false;
      try {
        execFileSync(
          process.execPath,
          [verifierPath, "--run-id", runId, "--check-only", "--run-directory", runDirectory],
          { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        rejected = true;
        const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
        for (const value of fixtureValues) {
          if (value.length >= 8 && output.includes(value)) {
            fail(`mutation ${mutation.id} leaked a configured private fixture value`);
          }
        }
      }
      if (!rejected) fail(`mutation ${mutation.id} was accepted`);
      results.push({ id: mutation.id, rejected: true });
    }
    return results;
  } finally {
    rmSync(mutationRoot, { recursive: true, force: true });
  }
}

function main() {
  const { runId, checkOnly, runDirectory: overrideRunDirectory } =
    parseArguments(process.argv.slice(2));
  const runDirectory = overrideRunDirectory ?? join(artifactRoot, "runs", runId);
  const preregistrationBytes = readFileSync(join(runDirectory, "preregistration.json"));
  if (!preregistrationBytes.equals(readFileSync(sourcePreregistrationPath))) {
    fail("run preregistration differs from the registered source bytes");
  }
  const manifestPath = join(runDirectory, "run-manifest.json");
  const modelCallsPath = join(runDirectory, "model-calls.jsonl");
  const providerResponsesPath = join(runDirectory, "provider-responses.jsonl");
  const casesPath = join(runDirectory, "cases.jsonl");
  const analysisPath = join(runDirectory, "analysis.json");
  const manifest = json(manifestPath);
  if (
    manifest.schemaVersion !== "general-agent-live/run-manifest/1" ||
    manifest.experimentId !== "general-agent-tool-registry-v1" ||
    manifest.experimentVersion !== 2 ||
    manifest.runId !== runId ||
    manifest.status !== "completed"
  ) {
    fail("run manifest identity or status is invalid");
  }
  if (
    manifest.providerCalls !== 8 ||
    manifest.secretLeasesReleased !== 8 ||
    manifest.productBootstrapModulesRemainRejected !== true ||
    manifest.linuxControlGroupProof !== false
  ) {
    fail("run manifest budgets or support boundary are invalid");
  }
  if (manifest.preregistrationSha256 !== sha256(preregistrationBytes)) {
    fail("run manifest preregistration digest is invalid");
  }
  const preregistration = JSON.parse(preregistrationBytes.toString("utf8"));
  if (
    manifest.protocolSha256 !== preregistration.protocol?.sha256 ||
    !/^[0-9a-f]{40}$/u.test(manifest.sourceCommit) ||
    typeof manifest.dirtyWorktree !== "boolean" ||
    manifest.configuration?.configuredStorageListLimit !== 3 ||
    manifest.configuration?.modelCapabilityVersion !== 2 ||
    manifest.configuration?.productBootstrapComposition !== false ||
    manifest.modelIdentifier !== "qwen3.6-27b" ||
    manifest.backend?.kind !== "live" ||
    manifest.backend?.silentFallbackAllowed !== false ||
    manifest.modelEndpointCapabilityProfile?.endpointAndCredentialRedacted !== true ||
    manifest.modelEndpointCapabilityProfile?.descriptorVersion !==
      "owner-aether-qwen3.6-27b-v2" ||
    manifest.modelEndpointCapabilityProfile?.jsonObjectOutputStrategyId !==
      "openai.response-format.json-object.v1" ||
    Object.hasOwn(manifest.modelEndpointCapabilityProfile ?? {}, "exactUrl")
  ) {
    fail("run manifest source, configuration, backend, or redacted model profile is invalid");
  }
  exactArray(manifest.seeds, [7421, 7422], "manifest evaluation seeds");
  const expectedExecutionOrder = [
    { evaluationSeed: 7421, repetition: 1, conditionId: "no-storage-tool" },
    { evaluationSeed: 7421, repetition: 1, conditionId: "tool-registry-storage" },
    { evaluationSeed: 7422, repetition: 2, conditionId: "tool-registry-storage" },
    { evaluationSeed: 7422, repetition: 2, conditionId: "no-storage-tool" },
  ];
  if (JSON.stringify(manifest.executionOrder) !== JSON.stringify(expectedExecutionOrder)) {
    fail("manifest execution order differs from the preregistered order");
  }
  if (
    manifest.resourceBudgets?.maximumCases !== 4 ||
    manifest.resourceBudgets?.maximumProviderCalls !== 8 ||
    manifest.resourceBudgets?.maximumToolCapabilityInvocationsPerTreatment !== 3 ||
    !Array.isArray(manifest.perCaseAccounting) ||
    JSON.stringify(manifest.perCaseAccounting.map((entry) => entry.providerCalls)) !==
      JSON.stringify([1, 3, 3, 1]) ||
    manifest.validatorResults?.preregistrationStructure !== "valid-before-run" ||
    manifest.validatorResults?.independentValidation !== "pending" ||
    manifest.failure !== null ||
    manifest.finishedAt !== manifest.completedAt
  ) {
    fail("run manifest accounting, validator state, or completion fields are invalid");
  }
  for (const [name, path] of [
    ["model-calls.jsonl", modelCallsPath],
    ["provider-responses.jsonl", providerResponsesPath],
    ["cases.jsonl", casesPath],
    ["analysis.json", analysisPath],
  ]) {
    if (manifest.artifacts?.[name] !== sha256(readFileSync(path))) {
      fail(`${name} digest is invalid`);
    }
  }
  if (
    manifest.rawOutputs?.providerResponsesSha256 !==
      sha256(readFileSync(providerResponsesPath)) ||
    manifest.rawOutputs?.modelCallsSha256 !== sha256(readFileSync(modelCallsPath)) ||
    manifest.rawOutputs?.casesSha256 !== sha256(readFileSync(casesPath)) ||
    manifest.rawOutputs?.analysisSha256 !== sha256(readFileSync(analysisPath))
  ) {
    fail("run manifest raw output digest inventory is invalid");
  }

  const cases = jsonLines(casesPath);
  if (cases.length !== 4) fail(`expected 4 cases, observed ${cases.length}`);
  verifyBaseline(cases[0], 7421, 1);
  verifyTreatment(cases[1], 7421, 1);
  verifyTreatment(cases[2], 7422, 2);
  verifyBaseline(cases[3], 7422, 2);
  verifyModelCalls(jsonLines(modelCallsPath));
  const providerResponses = jsonLines(providerResponsesPath);
  if (
    providerResponses.length !== 8 ||
    providerResponses.some(
      (row) =>
        row.schemaVersion !== "general-agent-live/provider-response/1" ||
        row.httpStatus !== 200 ||
        row.response === null,
    )
  ) {
    fail("provider raw response inventory is invalid");
  }
  const reasoningTypeByCall = [
    "disabled",
    "enabled",
    "disabled",
    "disabled",
    "enabled",
    "disabled",
    "disabled",
    "disabled",
  ];
  for (const [index, row] of providerResponses.entries()) {
    const requestBody = row.requestBody;
    if (
      requestBody === null ||
      Array.isArray(requestBody) ||
      typeof requestBody !== "object" ||
      JSON.stringify(Object.keys(requestBody).sort()) !==
        JSON.stringify(["max_tokens", "messages", "model", "response_format", "stream", "thinking"]) ||
      requestBody.model !== "qwen3.6-27b" ||
      requestBody.stream !== false ||
      !Array.isArray(requestBody.messages) ||
      requestBody.messages.length !== 2 ||
      JSON.stringify(requestBody.response_format) !== JSON.stringify({ type: "json_object" }) ||
      JSON.stringify(requestBody.thinking) !==
        JSON.stringify({ type: reasoningTypeByCall[index] }) ||
      row.requestBodySha256 !==
        sha256(Buffer.from(JSON.stringify(requestBody), "utf8"))
    ) {
      fail(`provider request ${index + 1} lacks exact JSON-object wire evidence`);
    }
  }
  const analysis = json(analysisPath);
  if (
    analysis.schemaVersion !== "general-agent-tool-registry/analysis/1" ||
    analysis.runId !== runId ||
    analysis.status !== "completed" ||
    analysis.observedCases !== 4 ||
    analysis.plannedCases !== 4 ||
    analysis.providerCalls !== 8 ||
    analysis.aggregateMetrics?.pairedGroundedRecovery !== 1 ||
    analysis.aggregateMetrics?.treatmentGroundedRecoveryRate !== 1 ||
    analysis.aggregateMetrics?.baselineHiddenCodenameRate !== 0 ||
    analysis.aggregateMetrics?.exactToolSequenceRate !== 1 ||
    analysis.aggregateMetrics?.reasoningObservationRate !== 1 ||
    analysis.provisionalClassification !==
      "candidate-supported-pending-independent-validation" ||
    JSON.stringify(analysis.aggregateMetrics) !== JSON.stringify(manifest.aggregateMetrics)
  ) {
    fail("analysis does not match independently recomputed complete-case metrics");
  }
  verifySourceIndependence(preregistration, manifest);
  const fixtureValues = loadFixtureValues();
  verifyNoPrivateLeak(runDirectory, fixtureValues);

  const mutationChecks = checkOnly ? [] : runMutationChecks(runDirectory, runId, fixtureValues);

  const verification = {
    schemaVersion: "general-agent-tool-registry/validation/1",
    experimentId: "general-agent-tool-registry-v1",
    experimentVersion: 2,
    runId,
    valid: true,
    checks: {
      preregistrationByteIdentity: true,
      manifestAndArtifactDigests: true,
      exactCaseCount: 4,
      exactProviderCallCount: 8,
      baselineNoSecretGuess: true,
      treatmentCapabilityBoundary: true,
      registryIdentity: true,
      registryDrivenLimit: true,
      treatmentToolSequence: true,
      treatmentGroundedAnswer: true,
      treatmentReasoningObserved: true,
      schedulerCompletion: true,
      childCredentialIsolation: true,
      configuredFixtureValueLeakage: false,
      capabilityHandleLeakage: false,
      sourceIndependence: true,
      productBootstrapModulesRemainRejected: true,
      linuxControlGroupProof: false,
      durableToolJournalIncluded: false,
      nativeProviderToolCallingIncluded: false,
      mutationChecksRejected: mutationChecks.length,
    },
    mutationChecks,
  };
  if (!checkOnly) {
    writeFileSync(
      join(runDirectory, "validation.json"),
      `${JSON.stringify(verification, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  process.stdout.write(`${JSON.stringify(verification)}\n`);
}

main();
