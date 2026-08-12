#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../../..");
const artifactRoot = path.join(
  repositoryRoot,
  "artifacts/experiments/probes/memory-task-state-confirmation-v0/runs",
);
const preregistrationPath = path.join(
  repositoryRoot,
  "docs/experiments/preregistrations/memory-task-state-confirmation-v0.json",
);
const CONDITION_IDS = [
  "content-raw",
  "association-raw",
  "checkpoint-only",
  "checkpoint-association",
];
const CUE_STATES = ["positive", "do-not-resume", "cancelled", "superseded"];
const HASHED_FILES = [
  "analysis.json",
  "cases.jsonl",
  "dataset.jsonl",
  "model-raw.jsonl",
  "preregistration.json",
];

function parseArguments(argv) {
  const noWrite = argv.at(-1) === "--no-write";
  const core = noWrite ? argv.slice(0, -1) : argv;
  if (core.length !== 2 || !["--run-id", "--run-directory"].includes(core[0])) {
    throw new Error(
      "usage: verify.mjs (--run-id aether-v1-<suffix> | --run-directory <path>) [--no-write]",
    );
  }
  if (core[0] === "--run-id" && !/^aether-v1-[a-zA-Z0-9._-]+$/u.test(core[1])) {
    throw new Error("run ID is invalid");
  }
  const runDirectory = core[0] === "--run-id"
    ? path.join(artifactRoot, core[1])
    : path.resolve(core[1]);
  const allowedRoot = path.resolve(repositoryRoot, "artifacts/experiments/probes");
  if (!runDirectory.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error("run directory escaped the experiment artifact root");
  }
  return { requestedRunId: core[0] === "--run-id" ? core[1] : null, runDirectory, write: !noWrite };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stable(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function same(left, right) {
  return stable(left) === stable(right);
}

function parseJsonLines(bytes, label) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error(`${label} lacks terminal LF`);
  return text.slice(0, -1).split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${label} row ${index + 1} is invalid JSON`);
    }
  });
}

function rawRecord(id, text, role, eligible = true) {
  return { id, kind: "raw-record", text, role, eligible, sourceRecordIds: [id] };
}

function cueText(task, state) {
  if (state === "positive") {
    return `Resume task ${task.taskId} from memory. Return the current operation and durable constraint.`;
  }
  if (state === "do-not-resume") {
    return `Do not resume task ${task.taskId}. Confirm that no old operation should run.`;
  }
  if (state === "cancelled") {
    return `Check task ${task.taskId} after its interruption and obey its latest recorded state.`;
  }
  return `Continue task ${task.taskId} after its interruption and obey its latest recorded operation.`;
}

function reconstructScenario(task, cueState) {
  const prefix = `${task.family}-${task.taskId}-${cueState}`;
  const actionId = `${prefix}-current-operation`;
  const constraintAId = `${prefix}-constraint-episode-a`;
  const constraintBId = `${prefix}-constraint-episode-b`;
  const updateId = cueState === "cancelled"
    ? `${prefix}-cancellation`
    : cueState === "superseded"
      ? `${prefix}-supersession`
      : null;
  const action = rawRecord(
    actionId,
    `Task ${task.taskId} completed its previous step. Current operation ${task.operation} has target ${task.arguments.target} and parameter ${task.arguments.parameter}.`,
    "current-operation",
  );
  const constraintA = rawRecord(
    constraintAId,
    `For task ${task.taskId}, durable constraint ${task.constraint.name} equals ${task.constraint.value}.`,
    "historical-constraint",
  );
  const constraintB = rawRecord(
    constraintBId,
    `The ${task.family} work for ${task.taskId} must keep ${task.constraint.name} at ${task.constraint.value}.`,
    "historical-constraint-corroboration",
  );
  const anchorA = rawRecord(
    `${prefix}-anchor-episode-a`,
    `Episode A discussed the ${task.family} operation for ${task.taskId}.`,
    "association-anchor",
  );
  const anchorB = rawRecord(
    `${prefix}-anchor-episode-b`,
    `Episode B again discussed ${task.taskId} ${task.family} operation state.`,
    "association-anchor",
  );
  const distractor = rawRecord(
    `${prefix}-distractor`,
    `The dashboard color for unrelated item ${task.family}-palette is amber.`,
    "distractor",
    false,
  );
  const update = cueState === "cancelled"
    ? rawRecord(
        updateId,
        `Task ${task.taskId} was cancelled after the interruption. Operation ${task.operation} is obsolete and must not run.`,
        "cancellation",
      )
    : cueState === "superseded"
      ? rawRecord(
          updateId,
          `Task ${task.taskId} superseded operation ${task.operation}. The current replacement is ${task.replacement.operation} with target ${task.replacement.arguments.target} and parameter ${task.replacement.arguments.parameter}.`,
          "supersession",
        )
      : null;
  const interruptionRecords = Array.from({ length: 64 }, (_, index) => ({
    id: `${prefix}-interrupt-${String(index + 1).padStart(2, "0")}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: index % 2 === 0
      ? `Unrelated interrupt ${index + 1}: inventory item ${prefix}-${index + 11}.`
      : `Completed unrelated interrupt ${index + 1} without retaining another task's state.`,
  }));
  const activeContext = [
    ...interruptionRecords.slice(-4),
    { id: `${prefix}-cue`, role: "user", text: cueText(task, cueState) },
  ];
  const decision = cueState === "do-not-resume" || cueState === "cancelled"
    ? "abstain"
    : "resume";
  const decisionReason = cueState === "positive"
    ? "current_action"
    : cueState === "do-not-resume"
      ? "explicit_do_not_resume"
      : cueState === "cancelled"
        ? "task_cancelled"
        : "superseded_action";
  const current = cueState === "superseded"
    ? task.replacement
    : { operation: task.operation, arguments: task.arguments };
  const actionTruth = decision === "resume"
    ? { operation: current.operation, arguments: { ...current.arguments } }
    : null;
  const claimGroups = {
    taskState: cueState === "do-not-resume"
      ? []
      : [{
          claimId: cueState === "cancelled"
            ? "cancellation"
            : cueState === "superseded"
              ? "supersession-state"
              : "active-state",
          sufficientSourceIds: [cueState === "cancelled" || cueState === "superseded"
            ? updateId
            : actionId],
        }],
    action: decision !== "resume"
      ? []
      : [{
          claimId: cueState === "superseded" ? "supersession-action" : "current-action",
          sufficientSourceIds: [cueState === "superseded" ? updateId : actionId],
        }],
    constraints: decision !== "resume"
      ? []
      : [{
          claimId: "retention-constraint",
          sufficientSourceIds: [constraintAId, constraintBId],
        }],
  };
  return {
    scenarioId: `${task.family}/${task.taskId}/${cueState}`,
    family: task.family,
    cueState,
    records: [constraintA, anchorA, constraintB, anchorB, action, ...(update ? [update] : []), distractor],
    interruptionRecords,
    activeContext,
    ids: { actionId, constraintAId, constraintBId, updateId, distractorId: distractor.id },
    truth: {
      decision,
      decisionReason,
      taskId: task.taskId,
      taskState: cueState === "cancelled" ? "cancelled" : "active",
      action: actionTruth,
      constraints: decision === "resume"
        ? { retentionDays: Number(task.constraint.value) }
        : { retentionDays: null },
      uncertain: false,
      claimGroups,
      obsoleteOperation: task.operation,
    },
    task,
  };
}

function checkpointFor(scenario) {
  const cancelled = scenario.cueState === "cancelled";
  const superseded = scenario.cueState === "superseded";
  const current = superseded
    ? scenario.task.replacement
    : { operation: scenario.task.operation, arguments: scenario.task.arguments };
  return {
    schemaVersion: "dolly.task-checkpoint/1",
    taskId: scenario.task.taskId,
    state: cancelled ? "cancelled" : superseded ? "superseded" : "active",
    action: cancelled ? null : { operation: current.operation, arguments: { ...current.arguments } },
    constraints: cancelled
      ? { retentionDays: null }
      : { retentionDays: Number(scenario.task.constraint.value) },
    sourceRecordIds: cancelled
      ? [scenario.ids.updateId]
      : [superseded ? scenario.ids.updateId : scenario.ids.actionId, scenario.ids.constraintAId],
  };
}

function expectedEvidence(scenario, conditionId) {
  const byId = new Map(scenario.records.map((record) => [record.id, record]));
  const content = [
    ...(scenario.ids.updateId ? [byId.get(scenario.ids.updateId)] : []),
    byId.get(scenario.ids.actionId),
    byId.get(scenario.ids.distractorId),
  ];
  const association = [
    ...content,
    byId.get(scenario.ids.constraintAId),
    byId.get(scenario.ids.constraintBId),
  ];
  const checkpoint = checkpointFor(scenario);
  const derived = {
    id: `${scenario.scenarioId.replaceAll("/", "-")}-checkpoint`,
    kind: "task-checkpoint",
    text: stable(checkpoint),
    role: "derived-checkpoint",
    eligible: true,
    sourceRecordIds: checkpoint.sourceRecordIds,
  };
  if (conditionId === "content-raw") return content;
  if (conditionId === "association-raw") return association;
  if (conditionId === "checkpoint-only") return [derived];
  return [derived, ...association];
}

function expectedMessages(preregistration, scenario, conditionId, evidence) {
  return [
    {
      role: "system",
      content: [
        "You are a general task Agent after an unrelated interruption.",
        "Use only the active context and supplied synthetic memory evidence.",
        "The latest cancellation or supersession overrides an older operation.",
        "An explicit do-not-resume cue overrides memory and requires abstain with no citations.",
        "Cite underlying raw source IDs, never a checkpoint ID.",
        "Return exactly one bare JSON object matching the closed output contract; no prose or Markdown.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        scenarioId: scenario.scenarioId,
        conditionId,
        activeContext: scenario.activeContext,
        memoryEvidence: evidence,
        outputContract: preregistration.outputContract,
        abstainShape: {
          schemaVersion: "memory-task-state-confirmation/agent-output-v1",
          decision: "abstain",
          decisionReason: "explicit_do_not_resume|task_cancelled|insufficient_evidence",
          taskId: "string",
          taskState: "active|cancelled",
          action: null,
          constraints: { retentionDays: null },
          support: { taskState: ["raw-source-id"], action: [], constraints: [] },
          uncertain: "boolean",
        },
      }),
    },
  ];
}

function score(output, scenario, evidence, malformed) {
  if (!output) {
    return {
      semanticSuccess: 0,
      decisionAccuracy: 0,
      decisionReasonAccuracy: 0,
      taskAccuracy: 0,
      taskStateAccuracy: 0,
      operationAccuracy: 0,
      argumentAccuracy: 0,
      constraintAccuracy: 0,
      claimCoverage: 0,
      citationPrecision: 0,
      corroborationCount: 0,
      falseResume: 0,
      obsoleteActionUse: 0,
      invalidOrUnrelatedCitation: 0,
      malformed,
    };
  }
  const evidenceIds = new Set(evidence.flatMap((entry) => entry.sourceRecordIds));
  const eligibility = new Map(scenario.records.map((record) => [record.id, record.eligible]));
  let required = 0;
  let covered = 0;
  let cited = 0;
  let valid = 0;
  let invalid = 0;
  let corroboration = 0;
  for (const key of ["taskState", "action", "constraints"]) {
    const citations = output.support[key];
    const groups = scenario.truth.claimGroups[key];
    const permitted = new Set(groups.flatMap((group) => group.sufficientSourceIds));
    required += groups.length;
    for (const group of groups) {
      const matches = group.sufficientSourceIds.filter((id) => citations.includes(id));
      if (matches.length > 0) covered += 1;
      corroboration += Math.max(0, matches.length - 1);
    }
    cited += citations.length;
    for (const id of citations) {
      if (evidenceIds.has(id) && eligibility.get(id) === true && permitted.has(id)) valid += 1;
      else invalid += 1;
    }
  }
  const fields = {
    decisionAccuracy: Number(output.decision === scenario.truth.decision),
    decisionReasonAccuracy: Number(output.decisionReason === scenario.truth.decisionReason),
    taskAccuracy: Number(output.taskId === scenario.truth.taskId),
    taskStateAccuracy: Number(output.taskState === scenario.truth.taskState),
    operationAccuracy: Number(output.action?.operation === scenario.truth.action?.operation ||
      (output.action === null && scenario.truth.action === null)),
    argumentAccuracy: Number(same(output.action?.arguments ?? null, scenario.truth.action?.arguments ?? null)),
    constraintAccuracy: Number(same(output.constraints, scenario.truth.constraints)),
  };
  const claimCoverage = required === 0 ? 1 : covered / required;
  const citationPrecision = cited === 0 ? Number(required === 0) : valid / cited;
  const falseResume = Number(
    (scenario.cueState === "do-not-resume" || scenario.cueState === "cancelled") &&
      output.decision === "resume"
  );
  const obsoleteActionUse = Number(
    ((scenario.cueState === "do-not-resume" || scenario.cueState === "cancelled") &&
      output.action !== null) ||
    (scenario.cueState === "superseded" &&
      (output.action?.operation === scenario.truth.obsoleteOperation ||
        output.support.action.includes(scenario.ids.actionId)))
  );
  return {
    semanticSuccess: Number(Object.values(fields).every((value) => value === 1) &&
      output.uncertain === false && claimCoverage === 1 && citationPrecision === 1 &&
      invalid === 0 && falseResume === 0 && obsoleteActionUse === 0),
    ...fields,
    claimCoverage,
    citationPrecision,
    corroborationCount: corroboration,
    falseResume,
    obsoleteActionUse,
    invalidOrUnrelatedCitation: invalid,
    malformed,
  };
}

function aggregate(preregistration, rows, rawRows) {
  const mean = (values) => values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
  const percentile = (values, quantile) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil(quantile * sorted.length) - 1];
  };
  const actionBearing = (row) => row.cueState === "positive" || row.cueState === "superseded";
  const byCondition = {};
  for (const conditionId of CONDITION_IDS) {
    const selected = rows.filter((row) => row.conditionId === conditionId);
    const actionRows = selected.filter(actionBearing);
    const stateRows = selected.filter((row) => row.cueState !== "positive");
    const evidenceBytes = selected.map((row) => row.evidenceBytes);
    byCondition[conditionId] = {
      rows: selected.length,
      actionBearingSuccesses: actionRows.reduce((sum, row) => sum + row.metrics.semanticSuccess, 0),
      semanticSuccess: mean(selected.map((row) => row.metrics.semanticSuccess)),
      falseResume: stateRows.reduce((sum, row) => sum + row.metrics.falseResume, 0),
      obsoleteActionUse: stateRows.reduce((sum, row) => sum + row.metrics.obsoleteActionUse, 0),
      invalidOrUnrelatedCitation: selected.reduce(
        (sum, row) => sum + row.metrics.invalidOrUnrelatedCitation,
        0,
      ),
      malformed: selected.reduce((sum, row) => sum + Number(row.metrics.malformed), 0),
      evidenceBytes: {
        median: percentile(evidenceBytes, 0.5),
        p95: percentile(evidenceBytes, 0.95),
        total: evidenceBytes.reduce((sum, value) => sum + value, 0),
      },
    };
  }
  const content = new Map(rows.filter((row) => row.conditionId === "content-raw")
    .map((row) => [row.scenarioId, row.metrics.semanticSuccess]));
  const improvements = (conditionId) => rows.filter((row) =>
    row.conditionId === conditionId && actionBearing(row) &&
    row.metrics.semanticSuccess > (content.get(row.scenarioId) ?? 0)
  ).length;
  const losses = (conditionId) => rows.filter((row) =>
    row.conditionId === conditionId && actionBearing(row) &&
    row.metrics.semanticSuccess < (content.get(row.scenarioId) ?? 0)
  ).length;
  const association = new Map(rows.filter((row) => row.conditionId === "association-raw")
    .map((row) => [row.scenarioId, row.metrics.semanticSuccess]));
  const checkpointRows = rows.filter((row) => row.conditionId === "checkpoint-only");
  const checkpointPairedLosses = checkpointRows.filter((row) =>
    row.metrics.semanticSuccess < (association.get(row.scenarioId) ?? 0)
  ).length;
  const components = new Map(rows.filter((row) =>
    row.conditionId === "association-raw" || row.conditionId === "checkpoint-only"
  ).map((row) => [`${row.scenarioId}/${row.conditionId}`, row.metrics.semanticSuccess]));
  const compositionRescues = rows.filter((row) =>
    row.conditionId === "checkpoint-association" && actionBearing(row) &&
    row.metrics.semanticSuccess === 1 &&
    components.get(`${row.scenarioId}/association-raw`) === 0 &&
    components.get(`${row.scenarioId}/checkpoint-only`) === 0
  ).length;
  const compositionLosses = rows.filter((row) =>
    row.conditionId === "checkpoint-association" && actionBearing(row) &&
    row.metrics.semanticSuccess < Math.max(
      components.get(`${row.scenarioId}/association-raw`) ?? 0,
      components.get(`${row.scenarioId}/checkpoint-only`) ?? 0,
    )
  ).length;
  const successfulRaw = rawRows.filter((row) => row.httpStatus === 200 && row.failureKind === null);
  const strictStreamCoverage = successfulRaw.length === 0 ? 0 : mean(successfulRaw.map((row) =>
    Number(row.request.stream === true && row.streamEvidence?.usageEventCount === 1 &&
      row.streamEvidence?.doneCount === 1)
  ));
  const finalAttempts = [...new Map(rawRows.map((row) => [row.logicalCallIndex, row])).values()];
  const infrastructureFailures = finalAttempts.filter((row) =>
    row.failureKind !== null && row.failureKind !== "content-or-schema"
  ).length;
  const disabledReasoningDeviations = successfulRaw.filter((row) => row.reasoningPresent).length;
  const complete = rows.length === 64 && new Set(rows.map((row) => row.caseId)).size === 64 &&
    new Set(rawRows.map((row) => row.logicalCallIndex)).size === 64;
  const thresholds = preregistration.minimumEffectiveDifference;
  const guardrail = (conditionId) => {
    const value = byCondition[conditionId];
    return value.falseResume <= thresholds.falseResumeMaximum &&
      value.obsoleteActionUse <= thresholds.obsoleteActionUseMaximum &&
      value.invalidOrUnrelatedCitation <= thresholds.invalidOrUnrelatedCitationMaximum &&
      value.malformed === 0;
  };
  const associationPass = byCondition["association-raw"].actionBearingSuccesses >=
      thresholds.actionBearingRequiredSuccesses &&
    improvements("association-raw") >= thresholds.pairedActionBearingImprovementsOverContent &&
    losses("association-raw") <= thresholds.pairedActionBearingLossesMaximum &&
    guardrail("association-raw");
  const checkpointFamilyPass = [...new Set(checkpointRows.map((row) => row.family))].every((family) =>
    checkpointRows.filter((row) => row.family === family && actionBearing(row))
      .every((row) => row.metrics.semanticSuccess === 1)
  );
  const associationBytes = byCondition["association-raw"].evidenceBytes;
  const checkpointBytes = byCondition["checkpoint-only"].evidenceBytes;
  const checkpointCompressionPass = checkpointBytes.median <= associationBytes.median *
      (1 - thresholds.checkpointMinimumEvidenceReduction) ||
    checkpointBytes.p95 <= associationBytes.p95 *
      (1 - thresholds.checkpointMinimumEvidenceReduction);
  const checkpointPass = checkpointPairedLosses <= thresholds.checkpointPairedLossesMaximum &&
    checkpointFamilyPass && guardrail("checkpoint-only") && checkpointCompressionPass;
  const compositionP95Ratio = associationBytes.p95 === 0
    ? Number.POSITIVE_INFINITY
    : byCondition["checkpoint-association"].evidenceBytes.p95 / associationBytes.p95;
  const compositionPass = compositionRescues >= thresholds.compositionMinimumUniqueRescues &&
    compositionLosses <= thresholds.compositionPairedLossesMaximum &&
    compositionP95Ratio <= thresholds.compositionMaximumP95EvidenceRatio &&
    guardrail("checkpoint-association");
  const evidenceValid = complete && infrastructureFailures === 0 &&
    disabledReasoningDeviations === 0 && strictStreamCoverage === 1;
  return {
    byCondition,
    pairedActionBearingImprovements: Object.fromEntries(CONDITION_IDS.map((id) => [id, improvements(id)])),
    pairedActionBearingLosses: Object.fromEntries(CONDITION_IDS.map((id) => [id, losses(id)])),
    checkpointPairedLosses,
    checkpointFamilyPass,
    checkpointCompressionPass,
    compositionRescues,
    compositionLosses,
    compositionP95Ratio,
    strictStreamCoverage,
    disabledReasoningDeviations,
    infrastructureFailures,
    complete,
    decisions: {
      associationRaw: evidenceValid ? (associationPass ? "keep-experimental" : "reject") : "inconclusive",
      checkpointOnly: evidenceValid ? (checkpointPass ? "prefer-experimental" : "reject") : "inconclusive",
      checkpointAssociation: evidenceValid ? (compositionPass ? "keep-experimental" : "reject") : "inconclusive",
      automaticResume: evidenceValid && CONDITION_IDS.every(guardrail)
        ? "not-authorized-by-private-fixture"
        : "disabled-by-guardrail-or-incomplete-run",
    },
    classification: evidenceValid ? "complete-exploratory-confirmation" : "inconclusive",
  };
}

function scanSensitiveKeys(value, pathParts = []) {
  const failures = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => failures.push(...scanSensitiveKeys(entry, [...pathParts, index])));
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (/authorization|api[_-]?key|capability.*handle|credential|secret/i.test(key)) {
        failures.push([...pathParts, key].join("."));
      }
      failures.push(...scanSensitiveKeys(entry, [...pathParts, key]));
    }
  }
  return failures;
}

function loadFixtureSecrets(bytes) {
  const values = [];
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    const match = line.match(/^\s*(AETHER_API_KEY|AETHER_BASE_URL)\s*=\s*(.*)\s*$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) values.push(value);
  }
  return values;
}

async function main() {
  const { requestedRunId, runDirectory, write } = parseArguments(process.argv.slice(2));
  const names = [
    "preregistration.json",
    "dataset.jsonl",
    "cases.jsonl",
    "model-raw.jsonl",
    "analysis.json",
    "run-manifest.json",
    "sha256sums.txt",
  ];
  const bytes = Object.fromEntries(await Promise.all(names.map(async (name) => [
    name,
    await readFile(path.join(runDirectory, name)),
  ])));
  const preregistration = JSON.parse(bytes["preregistration.json"]);
  const sourcePreregistration = await readFile(preregistrationPath);
  const datasetRows = parseJsonLines(bytes["dataset.jsonl"], "dataset");
  const caseRows = parseJsonLines(bytes["cases.jsonl"], "cases");
  const rawRows = parseJsonLines(bytes["model-raw.jsonl"], "model raw");
  const analysis = JSON.parse(bytes["analysis.json"]);
  const manifest = JSON.parse(bytes["run-manifest.json"]);
  const runId = manifest.runId;
  const errors = [];
  if (requestedRunId !== null && runId !== requestedRunId) errors.push("run identity mismatch");
  if (!bytes["preregistration.json"].equals(sourcePreregistration)) {
    errors.push("frozen preregistration bytes mismatch");
  }
  const checksumRows = bytes["sha256sums.txt"].toString("utf8").trimEnd().split("\n");
  const checksumMap = new Map(checksumRows.map((row) => {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u.exec(row);
    return match ? [match[2], match[1]] : ["invalid", "invalid"];
  }));
  if (!same([...checksumMap.keys()].sort(), [...HASHED_FILES].sort())) {
    errors.push("checksum inventory mismatch");
  }
  for (const name of HASHED_FILES) {
    if (checksumMap.get(name) !== sha256(bytes[name])) errors.push(`checksum mismatch ${name}`);
  }

  const scenarios = preregistration.data.baseTasks.flatMap((task) =>
    CUE_STATES.map((state) => reconstructScenario(task, state))
  );
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const expectedDataset = scenarios.map((scenario) => ({
    schemaVersion: "memory-task-state-confirmation/dataset-v1",
    scenarioId: scenario.scenarioId,
    family: scenario.family,
    cueState: scenario.cueState,
    records: scenario.records,
    interruptionRecords: scenario.interruptionRecords,
    activeContext: scenario.activeContext,
    truth: scenario.truth,
  }));
  if (!same(datasetRows, expectedDataset)) errors.push("dataset reconstruction mismatch");
  if (caseRows.length !== 64 || new Set(caseRows.map((row) => row.caseId)).size !== 64) {
    errors.push("case coverage mismatch");
  }
  if (new Set(rawRows.map((row) => row.logicalCallIndex)).size !== 64) {
    errors.push("logical-call coverage mismatch");
  }
  const independentMetrics = [];
  for (const row of caseRows) {
    const scenario = scenarioById.get(row.scenarioId);
    if (!scenario || !CONDITION_IDS.includes(row.conditionId)) {
      errors.push(`unknown case identity ${row.caseId}`);
      continue;
    }
    const evidence = expectedEvidence(scenario, row.conditionId);
    if (!same(row.evidence, evidence)) errors.push(`evidence mismatch ${row.caseId}`);
    if (row.evidenceBytes !== Buffer.byteLength(JSON.stringify(evidence), "utf8")) {
      errors.push(`evidence byte mismatch ${row.caseId}`);
    }
    if (!same(row.activeContextIds, scenario.activeContext.map((entry) => entry.id))) {
      errors.push(`active-context identity mismatch ${row.caseId}`);
    }
    const raw = rawRows.find((candidate) => candidate.callIndex === row.modelCallIndex);
    if (!raw) {
      errors.push(`model row missing ${row.caseId}`);
      continue;
    }
    if (!same(raw.request.messages, expectedMessages(preregistration, scenario, row.conditionId, evidence))) {
      errors.push(`model messages mismatch ${row.caseId}`);
    }
    if (
      raw.request.stream !== true ||
      raw.request.stream_options?.include_usage !== true ||
      raw.request.thinking?.type !== "disabled" ||
      Object.hasOwn(raw.request, "enable_thinking") ||
      raw.request.max_tokens !== 1200 ||
      raw.request.temperature !== 0
    ) {
      errors.push(`request contract mismatch ${row.caseId}`);
    }
    if (raw.httpStatus === 200 && raw.failureKind === null &&
      (raw.streamEvidence?.usageEventCount !== 1 || raw.streamEvidence?.doneCount !== 1)) {
      errors.push(`strict stream mismatch ${row.caseId}`);
    }
    if (raw.reasoningPresent) errors.push(`disabled reasoning profile deviation ${row.caseId}`);
    const content = raw.response?.choices?.[0]?.message?.content;
    if (row.output !== null) {
      try {
        if (!same(JSON.parse(content), row.output)) {
          errors.push(`model content/output mismatch ${row.caseId}`);
        }
      } catch {
        errors.push(`model content/output mismatch ${row.caseId}`);
      }
    }
    const metrics = score(row.output, scenario, evidence, raw.failureKind === "content-or-schema");
    if (!same(row.metrics, metrics)) errors.push(`score mismatch ${row.caseId}`);
    independentMetrics.push({ row, metrics });
  }
  const independentRows = independentMetrics.map(({ row, metrics }) => ({ ...row, metrics }));
  const expectedAnalysis = {
    schemaVersion: "memory-task-state-confirmation/analysis-v1",
    experimentId: "memory-task-state-confirmation-v0",
    experimentVersion: 1,
    runId,
    ...aggregate(preregistration, independentRows, rawRows),
  };
  if (!same(analysis, expectedAnalysis)) errors.push("aggregate analysis mismatch");

  const groups = new Map();
  for (const row of rawRows) {
    const list = groups.get(row.logicalCallIndex) ?? [];
    list.push(row);
    groups.set(row.logicalCallIndex, list);
  }
  for (const [logicalIndex, attempts] of groups) {
    attempts.sort((left, right) => left.attemptIndex - right.attemptIndex);
    if (attempts.length > 2 || attempts.some((row, index) => row.attemptIndex !== index + 1)) {
      errors.push(`retry sequence mismatch ${logicalIndex}`);
    }
    if (attempts.length > 1) {
      const prior = attempts[0];
      const retryable = prior.failureKind === "timeout" ||
        prior.failureKind === "network-before-response-headers" ||
        prior.failureKind === "retryable-http";
      if (!retryable || prior.httpStatus === 200) errors.push(`illegal retry ${logicalIndex}`);
    }
  }

  for (const [relativePath, digest] of Object.entries(manifest.relevantSourceHashes ?? {})) {
    try {
      const committed = execFileSync("git", ["show", `${manifest.sourceCommit}:${relativePath}`], {
        cwd: repositoryRoot,
        encoding: null,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (sha256(committed) !== digest) errors.push(`source hash mismatch ${relativePath}`);
    } catch {
      errors.push(`source missing at frozen commit ${relativePath}`);
    }
  }
  if (!same(Object.keys(manifest.rawOutputs ?? {}).sort(), [
    "analysis",
    "cases",
    "dataset",
    "modelRaw",
    "preregistration",
  ])) {
    errors.push("manifest artifact digest inventory mismatch");
  }
  for (const [name, descriptor] of Object.entries(manifest.rawOutputs ?? {})) {
    if (!descriptor?.path || !descriptor?.sha256) {
      errors.push(`artifact digest missing ${name}`);
      continue;
    }
    const artifactBytes = await readFile(path.join(runDirectory, descriptor.path));
    if (sha256(artifactBytes) !== descriptor.sha256) errors.push(`manifest digest mismatch ${name}`);
  }
  if (scanSensitiveKeys({ manifest, datasetRows, caseRows, rawRows, analysis }).length > 0) {
    errors.push("sensitive field name found in artifact");
  }
  try {
    const secrets = loadFixtureSecrets(await readFile(path.join(repositoryRoot, ".env")));
    const combined = Buffer.concat(Object.values(bytes)).toString("utf8");
    if (secrets.some((secret) => combined.includes(secret))) errors.push("configured secret leaked");
  } catch {
    errors.push("fixture values unavailable for leak scan");
  }
  if (analysis.classification !== "complete-exploratory-confirmation" && errors.length === 0) {
    // An efficacy-inconclusive result is allowed, but evidence integrity must still be explicit.
    if (analysis.classification !== "inconclusive") errors.push("analysis classification mismatch");
  }

  const validation = {
    schemaVersion: "memory-task-state-confirmation/validation-v1",
    experimentId: "memory-task-state-confirmation-v0",
    runId,
    status: errors.length === 0 ? "valid" : "invalid",
    readsTreatmentImplementation: false,
    datasetRows: datasetRows.length,
    caseRows: caseRows.length,
    logicalCalls: groups.size,
    requestAttempts: rawRows.length,
    errors,
    validatedAt: new Date().toISOString(),
  };
  if (write) {
    await writeFile(
      path.join(runDirectory, "validation.json"),
      `${JSON.stringify(validation, null, 2)}\n`,
    );
    manifest.validatorResults = {
      status: validation.status,
      path: "validation.json",
      validationSha256: sha256(Buffer.from(`${JSON.stringify(validation, null, 2)}\n`)),
    };
    await writeFile(
      path.join(runDirectory, "run-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
