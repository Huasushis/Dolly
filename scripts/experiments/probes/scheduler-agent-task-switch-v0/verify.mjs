#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const workspaceRoot = resolve(repositoryRoot, "..");
const TASK_ID = "release-aurora";
const CHECKPOINT_KEY = `task.${TASK_ID}.checkpoint`;
const CHECKPOINT = {
  schemaVersion: "dolly.task-checkpoint/1",
  taskId: TASK_ID,
  objective: "Publish the Aurora package after owner approval",
  completed: ["unit-tests", "package-built"],
  constraints: { channel: "canary", retentionHours: 24 },
  nextAction: { kind: "request-approval", target: "owner", reason: "publish-canary" },
  sourceId: "task-a-input",
};
const EXPECTED_ARTIFACTS = [
  "analysis.json",
  "cases.jsonl",
  "effect-intents-no-checkpoint.json",
  "effect-intents-structured-checkpoint.json",
  "model-calls.jsonl",
  "provider-responses.jsonl",
  "tool-rounds-structured-checkpoint.json",
];
const MUTATION_IDS = [
  "delete-checkpoint",
  "leak-task-a-into-task-b",
  "flip-resume-result",
  "inject-capability-handle",
  "remove-artifact-digest",
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exact(value, expected, label) {
  assert(JSON.stringify(value) === JSON.stringify(expected), `${label} differs`);
}

function object(value, label) {
  assert(value !== null && !Array.isArray(value) && typeof value === "object", `${label} is not one object`);
  return value;
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseJsonl(path) {
  const text = readFileSync(path, "utf8");
  assert(text.endsWith("\n"), `${path} lacks the final LF`);
  return text.trimEnd().split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(`${path} row ${index + 1} is not JSON`);
    }
  });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function loadFixtureValues() {
  const values = [];
  const source = readFileSync(join(repositoryRoot, ".env"), "utf8");
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(AETHER_BASE_URL|AETHER_API_KEY)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== "") values.push(Buffer.from(value));
  }
  assert(values.length === 2, "private fixture values are unavailable for leak validation");
  return values;
}

function allRegularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else fail(`non-regular artifact found: ${path}`);
    }
  };
  visit(root);
  return files;
}

function verifyNoPrivateFields(value, location) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => verifyNoPrivateFields(entry, `${location}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const forbidden = new Set([
    "authorization",
    "capabilityhandle",
    "handle",
    "apikey",
    "exacturl",
    "baseurl",
  ]);
  for (const [key, entry] of Object.entries(value)) {
    assert(!forbidden.has(key.toLowerCase()), `${location} exposes forbidden field ${key}`);
    verifyNoPrivateFields(entry, `${location}.${key}`);
  }
}

function verifyNoPrivateLeak(runDirectory, fixtureValues) {
  for (const path of allRegularFiles(runDirectory)) {
    const bytes = readFileSync(path);
    for (const fixture of fixtureValues) {
      assert(!bytes.includes(fixture), `${relative(runDirectory, path)} contains a private fixture value`);
    }
    if (path.endsWith(".json")) verifyNoPrivateFields(JSON.parse(bytes.toString("utf8")), path);
    if (path.endsWith(".jsonl")) {
      parseJsonl(path).forEach((row, index) => verifyNoPrivateFields(row, `${path}:${index + 1}`));
    }
  }
}

function providerMessages(inputMessages) {
  return inputMessages.map((message) => ({
    role: message.role,
    content: message.parts.map((part) => ({ type: "text", text: part.text })),
  }));
}

function verifyModelAndWire(modelRows, providerRows) {
  assert(modelRows.length === 11, "model call count is not 11");
  assert(providerRows.length === 11, "provider response count is not 11");
  const maximumTokens = [800, 800, 800, 5200, 1200, 1200, 800, 5200, 1200, 1200, 1200];
  const outputKinds = [
    "json-object", "json-object", "json-object",
    "text", "json-object", "json-object", "json-object",
    "text", "json-object", "json-object", "json-object",
  ];
  const reasoning = [
    "disable", "disable", "disable",
    "require", "disable", "disable", "disable",
    "require", "disable", "disable", "disable",
  ];
  const requestIds = new Set();
  modelRows.forEach((row, index) => {
    object(row, `model row ${index}`);
    assert(row.schemaVersion === "scheduler-agent-task-switch/model-call/1", "model row schema differs");
    assert(typeof row.requestId === "string" && !requestIds.has(row.requestId), "model request ID is invalid");
    requestIds.add(row.requestId);
    assert(row.reasoningPolicy === reasoning[index], `model reasoning policy ${index} differs`);
    assert(row.budgets?.maxOutputTokens === maximumTokens[index], `model max tokens ${index} differs`);
    assert(row.input?.schemaVersion === "dolly.model.chat-input/3", "chat input version differs");
    assert(row.input?.outputContract?.kind === outputKinds[index], `output kind ${index} differs`);
    assert(row.input?.stream === false, "streaming was enabled");
    assert(row.result?.status === "succeeded", `model call ${index} failed`);
    assert(row.result?.output?.finishReason === "stop", `model call ${index} did not stop normally`);
    const content = row.result?.output?.finalContent;
    assert(typeof content === "string" && content.trim() !== "", `model content ${index} is absent`);
    if (outputKinds[index] === "json-object") {
      assert(!content.includes("```"), `model content ${index} uses a Markdown fence`);
      object(JSON.parse(content), `model content ${index}`);
    }
    if (reasoning[index] === "require") {
      const observed = row.result?.output?.reasoning;
      assert(
        observed?.state === "observed" &&
          Array.isArray(observed.parts) &&
          observed.parts.some((part) => typeof part === "string" && part.length > 0),
        `model reasoning ${index} was not actually observed`,
      );
    }

    const provider = providerRows[index];
    assert(provider.schemaVersion === "general-agent-live/provider-response/1", "provider row schema differs");
    assert(provider.httpStatus === 200, `provider row ${index} was not HTTP 200`);
    assert(provider.requestBodySha256 === sha256(JSON.stringify(provider.requestBody)), "provider body digest differs");
    const body = provider.requestBody;
    exact(body.messages, providerMessages(row.input.messages), `provider messages ${index}`);
    assert(body.model === "qwen3.6-27b", "provider model differs");
    assert(body.max_tokens === maximumTokens[index], `provider max_tokens ${index} differs`);
    assert(body.stream === false, "provider stream differs");
    exact(body.thinking, { type: reasoning[index] === "require" ? "enabled" : "disabled" }, `provider thinking ${index}`);
    if (outputKinds[index] === "json-object") {
      exact(body.response_format, { type: "json_object" }, `provider response_format ${index}`);
    } else {
      assert(!Object.hasOwn(body, "response_format"), `text call ${index} sent response_format`);
    }
    assert(!Object.hasOwn(body, "temperature"), `provider call ${index} sent unregistered temperature`);
  });

  const taskBRows = [modelRows[1], modelRows[6]];
  for (const row of taskBRows) {
    const text = JSON.stringify(row.input.messages);
    for (const forbidden of [CHECKPOINT_KEY, CHECKPOINT.objective, "unit-tests", "retentionHours", "request-approval"]) {
      assert(!text.includes(forbidden), `unrelated task model input leaked ${forbidden}`);
    }
  }
  const firstResumePlan = JSON.stringify(modelRows[7].input.messages);
  for (const forbidden of [CHECKPOINT_KEY, CHECKPOINT.objective, "unit-tests", "retentionHours", "request-approval"]) {
    assert(!firstResumePlan.includes(forbidden), `resume planning input leaked ${forbidden} before retrieval`);
  }
}

function phase(caseRow, name) {
  const found = caseRow.phases.find((entry) => entry.phase === name);
  assert(found, `${caseRow.conditionId} lacks ${name}`);
  return found;
}

function verifyCommonCase(row, conditionId) {
  assert(row.schemaVersion === "scheduler-agent-task-switch/case/1", "case schema differs");
  assert(row.conditionId === conditionId, "case condition differs");
  assert(Array.isArray(row.phases) && row.phases.length === 3, "case phase count differs");
  exact(row.phases.map((entry) => entry.phase), ["checkpoint", "unrelated", "resume"], "phase order");
  assert(row.sameProcessAcrossPhases === true, "case did not retain one Module generation");
  assert(row.distinctRuns === true, "case did not use three distinct Runs");
  assert(row.schedulerCompletion === true, "Scheduler did not complete all phases");
  assert(row.childPidRecorded === true && row.childStopped === true, "exact child stop was not observed");
  assert(row.linuxControlGroupProof === false, "case falsely claims Linux group proof");
  const identities = row.phases.map((entry) => entry.commit);
  assert(new Set(identities.map((entry) => entry.runId)).size === 3, "Run IDs are not distinct");
  assert(new Set(identities.map((entry) => entry.moduleGenerationId)).size === 1, "Module generation changed");
  identities.forEach((entry) => {
    assert(entry.attempt === 1, "Run attempt differs");
    assert(typeof entry.moduleJobId === "string" && typeof entry.runId === "string", "Run identity is absent");
  });
  exact(phase(row, "unrelated").input, {
    phase: "unrelated",
    taskId: "arithmetic-cobalt",
    question: "What is 29 - 12?",
  }, "unrelated input");
  exact(phase(row, "resume").input, {
    phase: "resume",
    taskId: TASK_ID,
    request: "Resume this task from memory and identify the next action.",
  }, "resume input");
}

function verifyBaseline(row) {
  verifyCommonCase(row, "no-checkpoint");
  exact(row.childCapabilityTypes, ["model-operation"], "baseline capability types");
  exact(row.storageEntries, [], "baseline storage");
  const checkpoint = phase(row, "checkpoint").result;
  exact(checkpoint.actions, ["answer"], "baseline checkpoint actions");
  exact(checkpoint.final, {
    action: "checkpointed",
    taskId: TASK_ID,
    checkpointKey: null,
    stored: false,
  }, "baseline checkpoint result");
  const unrelated = phase(row, "unrelated").result;
  exact(unrelated.actions, ["answer"], "baseline unrelated actions");
  assert(unrelated.final?.answer === 17, "baseline unrelated answer differs");
  const resume = phase(row, "resume").result;
  exact(resume.actions, ["answer"], "baseline resume actions");
  exact(resume.final, {
    action: "resumed",
    taskId: TASK_ID,
    resumed: false,
    nextAction: null,
    evidenceKeys: [],
  }, "baseline resume result");
}

function verifyTreatment(row) {
  verifyCommonCase(row, "structured-checkpoint");
  exact(row.childCapabilityTypes, ["model-operation", "tool-invocation"], "treatment capability types");
  assert(row.storageEntries.length === 1, "treatment checkpoint count differs");
  assert(row.storageEntries[0].key === CHECKPOINT_KEY, "stored checkpoint key differs");
  exact(row.storageEntries[0].value, CHECKPOINT, "stored checkpoint value");
  const checkpoint = phase(row, "checkpoint").result;
  exact(checkpoint.actions, ["storage_set", "checkpointed"], "treatment checkpoint actions");
  exact(checkpoint.final, {
    action: "checkpointed",
    taskId: TASK_ID,
    checkpointKey: CHECKPOINT_KEY,
    stored: true,
  }, "treatment checkpoint result");
  exact(checkpoint.reasoningObserved, [true], "checkpoint reasoning evidence");
  const unrelated = phase(row, "unrelated").result;
  exact(unrelated.actions, ["answer"], "treatment unrelated actions");
  assert(unrelated.final?.answer === 17, "treatment unrelated answer differs");
  const resume = phase(row, "resume").result;
  exact(resume.actions, ["storage_list", "storage_get", "resumed"], "treatment resume actions");
  exact(resume.final, {
    action: "resumed",
    taskId: TASK_ID,
    resumed: true,
    nextAction: CHECKPOINT.nextAction,
    evidenceKeys: [CHECKPOINT_KEY],
  }, "treatment resume result");
  exact(resume.reasoningObserved, [true], "resume reasoning evidence");
}

function verifyEffectJournal(caseRow, runDirectory, expectedRecords) {
  const reference = caseRow.effectJournal;
  assert(reference?.evidence === "terminal-all-runs", "effect evidence label differs");
  const path = join(runDirectory, reference.artifact);
  assert(sha256(readFileSync(path)) === reference.sha256, "case effect digest differs");
  const document = parseJson(path);
  assert(document.schemaVersion === "dolly.effect-intent-store/2", "effect store schema differs");
  assert(document.runs.length === 3, "effect run count differs");
  assert(document.records.length === expectedRecords, "effect record count differs");
  const identities = caseRow.phases.map((entry) => entry.commit);
  for (const identity of identities) {
    const run = document.runs.find((entry) => entry.runId === identity.runId);
    assert(run?.state === "closed" && run.moduleJobId === identity.moduleJobId, "effect Run is not closed");
  }
  document.records.forEach((record) => {
    assert(record.outcome?.kind === "terminal", "effect record is not terminal");
    assert(identities.some((identity) => identity.runId === record.runId), "effect record belongs to another Run");
  });
}

function verifyToolJournal(caseRow, runDirectory) {
  assert(caseRow.toolJournal !== null, "treatment tool journal is absent");
  const reference = caseRow.toolJournal;
  const path = join(runDirectory, reference.artifact);
  assert(sha256(readFileSync(path)) === reference.sha256, "case tool digest differs");
  const document = parseJson(path);
  assert(document.schemaVersion === "dolly.tool-journal-repository/1", "tool journal schema differs");
  assert(document.rounds.length === 3, "tool round count differs");
  const checkpointJob = phase(caseRow, "checkpoint").commit.moduleJobId;
  const resumeJob = phase(caseRow, "resume").commit.moduleJobId;
  const expectedRounds = [[checkpointJob, 1, "complete"], [resumeJob, 1, "complete"], [resumeJob, 2, "complete"]]
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1] - right[1]);
  exact(
    document.rounds.map((round) => [round.moduleJobId, round.roundIndex, round.state]),
    expectedRounds,
    "tool journal round identity",
  );
  document.rounds.forEach((round) => {
    assert(round.effects.length === 1, "tool round effect count differs");
    assert(round.effects[0].status === "terminal", "tool effect is not terminal");
    assert(round.effects[0].result?.status === "succeeded", "tool effect did not succeed");
  });
}

function verifyAccounting(manifest, providerRows) {
  const accounting = manifest.perCaseAccounting;
  assert(accounting?.["no-checkpoint"]?.modelCalls === 3, "baseline accounting call count differs");
  assert(accounting?.["structured-checkpoint"]?.modelCalls === 8, "treatment accounting call count differs");
  assert(accounting["no-checkpoint"].providerAttempts === 3, "baseline provider attempts differ");
  assert(accounting["structured-checkpoint"].providerAttempts === 8, "treatment provider attempts differ");
  for (const entry of Object.values(accounting)) {
    assert(entry.retries === 0 && entry.errors === 0, "accounting reports retry or error");
    assert(entry.latencyMs >= 0, "accounting latency is invalid");
    assert(entry.tokens.recordsMissingUsage === 0, "provider token usage is missing");
  }
  const tokenTotals = providerRows.reduce((total, row) => {
    const usage = row.response?.usage;
    assert(Number.isSafeInteger(usage?.prompt_tokens), "provider prompt token count is absent");
    assert(Number.isSafeInteger(usage?.completion_tokens), "provider completion token count is absent");
    return total + usage.prompt_tokens + usage.completion_tokens;
  }, 0);
  const recorded = Object.values(accounting).reduce((total, entry) => total + entry.tokens.total, 0);
  assert(recorded === tokenTotals, "accounting token total differs from raw provider rows");
}

function verifySources(preregistration, manifest) {
  assert(manifest.preregistrationSha256 === sha256(readFileSync(join(manifest.runDirectory, "preregistration.json"))), "preregistration digest differs");
  assert(preregistration.protocol?.sha256 === manifest.protocolSha256, "protocol digest differs");
  assert(manifest.protocolSha256 === sha256(readFileSync(join(repositoryRoot, preregistration.protocol.path))), "protocol source changed");
  for (const key of ["implementationSha256", "productionSourceSha256"]) {
    const expected = preregistration.domainDesign?.[key];
    exact(Object.keys(manifest[key]).sort(), Object.keys(expected).sort(), `${key} inventory`);
    for (const [path, digest] of Object.entries(expected)) {
      assert(sha256(readFileSync(join(repositoryRoot, path))) === digest, `${path} source changed`);
      assert(manifest[key][path] === digest, `${path} manifest source digest differs`);
    }
  }
}

function verifyRun(runDirectory, fixtureValues) {
  const manifest = parseJson(join(runDirectory, "run-manifest.json"));
  manifest.runDirectory = runDirectory;
  const preregistration = parseJson(join(runDirectory, "preregistration.json"));
  assert(manifest.schemaVersion === "scheduler-agent-task-switch/run-manifest/1", "manifest schema differs");
  assert(manifest.experimentId === "scheduler-agent-task-switch-v0", "manifest experiment differs");
  assert(manifest.status === "completed" && manifest.failure === null, "run did not complete");
  assert(manifest.providerCalls === 11 && manifest.maximumProviderCalls === 11, "provider call budget differs");
  assert(manifest.secretLeasesReleased === 11, "secret leases were not released");
  assert(manifest.backendKind === "live", "backend kind differs");
  assert(manifest.temperatureWire === "omitted" && manifest.providerDefaultSampling === "unverified", "sampling claim differs");
  assert(manifest.productBootstrapModulesRemainRejected === true, "product guard is not retained");
  assert(manifest.linuxControlGroupProof === false, "manifest falsely claims Linux group proof");
  exact(Object.keys(manifest.artifacts).sort(), EXPECTED_ARTIFACTS, "artifact inventory");
  for (const [path, digest] of Object.entries(manifest.artifacts)) {
    const absolute = join(runDirectory, path);
    assert(statSync(absolute).isFile(), `${path} is not a regular artifact`);
    assert(sha256(readFileSync(absolute)) === digest, `${path} digest differs`);
  }
  const cases = parseJsonl(join(runDirectory, "cases.jsonl"));
  assert(cases.length === 2, "case count differs");
  verifyBaseline(cases[0]);
  verifyTreatment(cases[1]);
  verifyEffectJournal(cases[0], runDirectory, 3);
  verifyEffectJournal(cases[1], runDirectory, 13);
  assert(cases[0].toolJournal === null, "baseline has a tool journal");
  verifyToolJournal(cases[1], runDirectory);
  const modelRows = parseJsonl(join(runDirectory, "model-calls.jsonl"));
  const providerRows = parseJsonl(join(runDirectory, "provider-responses.jsonl"));
  verifyModelAndWire(modelRows, providerRows);
  verifyAccounting(manifest, providerRows);
  verifySources(preregistration, manifest);
  verifyNoPrivateLeak(runDirectory, fixtureValues);
  return { manifest, preregistration, cases, modelRows, providerRows };
}

function refreshArtifactDigest(runDirectory, path) {
  const manifestPath = join(runDirectory, "run-manifest.json");
  const manifest = parseJson(manifestPath);
  manifest.artifacts[path] = sha256(readFileSync(join(runDirectory, path)));
  writeJson(manifestPath, manifest);
}

function runMutationChecks(sourceDirectory, fixtureValues) {
  mkdirSync(join(workspaceRoot, ".tmp"), { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(workspaceRoot, ".tmp", "task-switch-mutations-"));
  const mutations = [
    {
      id: "delete-checkpoint",
      apply(directory) {
        const rows = parseJsonl(join(directory, "cases.jsonl"));
        rows[1].storageEntries = [];
        writeJsonl(join(directory, "cases.jsonl"), rows);
        refreshArtifactDigest(directory, "cases.jsonl");
      },
    },
    {
      id: "leak-task-a-into-task-b",
      apply(directory) {
        const rows = parseJsonl(join(directory, "cases.jsonl"));
        rows[1].phases[1].input.objective = CHECKPOINT.objective;
        writeJsonl(join(directory, "cases.jsonl"), rows);
        refreshArtifactDigest(directory, "cases.jsonl");
      },
    },
    {
      id: "flip-resume-result",
      apply(directory) {
        const rows = parseJsonl(join(directory, "cases.jsonl"));
        rows[1].phases[2].result.final.resumed = false;
        writeJsonl(join(directory, "cases.jsonl"), rows);
        refreshArtifactDigest(directory, "cases.jsonl");
      },
    },
    {
      id: "inject-capability-handle",
      apply(directory) {
        const analysisPath = join(directory, "analysis.json");
        const analysis = parseJson(analysisPath);
        analysis.capabilityHandle = "forged-handle";
        writeJson(analysisPath, analysis);
        refreshArtifactDigest(directory, "analysis.json");
      },
    },
    {
      id: "remove-artifact-digest",
      apply(directory) {
        const path = join(directory, "run-manifest.json");
        const manifest = parseJson(path);
        delete manifest.artifacts["tool-rounds-structured-checkpoint.json"];
        writeJson(path, manifest);
      },
    },
  ];
  exact(mutations.map((entry) => entry.id), MUTATION_IDS, "mutation inventory");
  const results = [];
  try {
    for (const mutation of mutations) {
      const directory = join(root, mutation.id);
      cpSync(sourceDirectory, directory, { recursive: true, errorOnExist: true });
      mutation.apply(directory);
      let rejected = false;
      try {
        verifyRun(directory, fixtureValues);
      } catch {
        rejected = true;
      }
      assert(rejected, `mutation ${mutation.id} was accepted`);
      results.push({ id: mutation.id, rejected: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return results;
}

function parseArguments(argv) {
  if (argv.length < 2 || argv[0] !== "--run-dir") {
    fail("usage: verify.mjs --run-dir <path> [--check-only]");
  }
  const runDirectory = resolve(repositoryRoot, argv[1]);
  const checkOnly = argv.slice(2).includes("--check-only");
  return { runDirectory, checkOnly };
}

function main() {
  const { runDirectory, checkOnly } = parseArguments(process.argv.slice(2));
  const fixtureValues = loadFixtureValues();
  const verified = verifyRun(runDirectory, fixtureValues);
  const mutationChecks = checkOnly ? [] : runMutationChecks(runDirectory, fixtureValues);
  const verification = {
    schemaVersion: "scheduler-agent-task-switch/verification/1",
    experimentId: "scheduler-agent-task-switch-v0",
    runId: verified.manifest.runId,
    valid: true,
    checkedAt: new Date().toISOString(),
    checks: {
      cases: verified.cases.length,
      modelCalls: verified.modelRows.length,
      providerResponses: verified.providerRows.length,
      distinctRunsPerCondition: 3,
      sameProcessPerCondition: true,
      taskBContextLeakage: 0,
      resumePlanningLeakageBeforeRetrieval: 0,
      mutationChecksRejected: mutationChecks.length,
      privateFixtureLeakage: false,
    },
    mutationChecks,
  };
  if (!checkOnly) {
    writeFileSync(join(runDirectory, "validation.json"), `${JSON.stringify(verification, null, 2)}\n`, { flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify(verification)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
