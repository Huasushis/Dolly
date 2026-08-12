#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This verifier deliberately imports no experiment generator, retrieval,
// checkpoint, scorer, or runner module. The duplicated implementation is the
// independence boundary: mutations to treatment code cannot silently redefine
// verification.

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../../..");
const CELL_IDS = [
  "content-raw",
  "association-raw",
  "deterministic-checkpoint",
  "checkpoint-association-raw",
];
const CUE_TYPES = ["positive", "do-not-resume", "cancelled", "superseded"];
const ACTION_KEYS = {
  add_idempotency_guard: ["idempotencyKey"],
  reconcile_duplicate_deliveries: ["batchId"],
  restart_service: ["serviceName"],
  revert_release: ["releaseId", "serviceName"],
};
const ALIASES = {
  billing: "import", importer: "import", imports: "import", intake: "import",
  invoices: "invoice", failed: "rejected", errors: "rejected", kept: "retain",
  retention: "retain", retained: "retain", incident: "service", incidents: "service",
  outage: "service", outages: "service", diagnostics: "diagnostic", crashes: "diagnostic",
  logs: "diagnostic", preserved: "retain",
};
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "by", "continue", "continuing", "do", "for",
  "from", "has", "in", "is", "it", "must", "no", "not", "of", "on", "operation", "or",
  "so", "that", "the", "their", "this", "to", "was", "were", "with",
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function serializeJsonLines(rows) {
  return `${rows.map((row) => stableJson(row)).join("\n")}\n`;
}

function parseJsonLines(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split("\n").map((line) => JSON.parse(line)) : [];
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function tokens(text) {
  return [...new Set((text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .map((token) => ALIASES[token] ?? token)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token)))];
}

function actionsEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function parseAction(text, replacement = false) {
  const operationPattern = replacement
    ? /replacement_operation_code=([a-z0-9_]+)/u
    : /operation_code=([a-z0-9_]+)/u;
  const argumentsPattern = replacement
    ? /replacement_arguments=(\{[^\n]+?\})\./u
    : /arguments=(\{[^\n]+?\})\./u;
  const operation = text.match(operationPattern)?.[1];
  const argumentsText = text.match(argumentsPattern)?.[1];
  if (!operation || !argumentsText) return null;
  return { operation, arguments: JSON.parse(argumentsText) };
}

function claim(required, sufficientSourceSets) {
  return { required, sufficientSourceSets };
}

function deriveTruth(scenario, errors) {
  const current = scenario.records.find((entry) => entry.role === "current-state");
  const constraints = scenario.records.filter((entry) => entry.role === "constraint");
  const update = scenario.records.find((entry) => ["cancellation", "supersession"].includes(entry.role));
  if (!current || constraints.length !== 2) {
    errors.push(`${scenario.scenarioId}: missing current record or constraint pair`);
    return null;
  }
  const taskId = current.text.match(/Task ([a-z0-9-]+) state=active/u)?.[1];
  const initialAction = parseAction(current.text);
  const retentionValues = constraints.map((entry) => Number(entry.text.match(/retention_days=(\d+)/u)?.[1]));
  if (!taskId || !initialAction || retentionValues.some((value) => !Number.isSafeInteger(value))
    || new Set(retentionValues).size !== 1) {
    errors.push(`${scenario.scenarioId}: source text cannot derive frozen truth`);
    return null;
  }
  const currentId = current.id;
  const constraintSets = constraints.map((entry) => [entry.id]);
  let decision = "resume";
  let decisionReason = "current_action";
  let taskState = "active";
  let action = initialAction;
  let retentionDays = retentionValues[0];
  let groups = {
    taskState: claim(true, [[currentId]]),
    action: claim(true, [[currentId]]),
    constraints: claim(true, constraintSets),
  };
  let replacementAction = scenario.groundTruth.replacementAction;
  if (scenario.cueType === "do-not-resume") {
    if (!/^Do not resume or continue task /u.test(scenario.query)) {
      errors.push(`${scenario.scenarioId}: ambiguous do-not-resume cue`);
    }
    decision = "abstain";
    decisionReason = "explicit_do_not_resume";
    taskState = "unknown";
    action = null;
    retentionDays = null;
    groups = { taskState: claim(false, []), action: claim(false, []), constraints: claim(false, []) };
  } else if (scenario.cueType === "cancelled") {
    if (update?.role !== "cancellation" || !/state=cancelled/u.test(update.text)
      || !/no current action/u.test(update.text)) {
      errors.push(`${scenario.scenarioId}: cancellation source is not explicit`);
    }
    decision = "abstain";
    decisionReason = "task_cancelled";
    taskState = "cancelled";
    action = null;
    retentionDays = null;
    groups = {
      taskState: claim(true, [[update?.id]]),
      action: claim(true, [[update?.id]]),
      constraints: claim(false, []),
    };
  } else if (scenario.cueType === "superseded") {
    replacementAction = update?.role === "supersession" ? parseAction(update.text, true) : null;
    if (!replacementAction || !/superseded and forbidden/u.test(update.text)) {
      errors.push(`${scenario.scenarioId}: supersession source is not explicit`);
    }
    decisionReason = "superseded_action";
    action = replacementAction;
    groups = {
      taskState: claim(true, [[update?.id]]),
      action: claim(true, [[update?.id]]),
      constraints: claim(true, constraintSets),
    };
  } else if (!/^Resume task /u.test(scenario.query)) {
    errors.push(`${scenario.scenarioId}: positive cue is not explicit`);
  }
  const allowed = new Set(Object.values(groups).flatMap((group) => group.sufficientSourceSets.flat()));
  const truth = {
    decision,
    decisionReason,
    taskId,
    taskState,
    action,
    constraints: { retentionDays },
    uncertain: false,
    initialAction,
    replacementAction,
    claimGroups: groups,
    forbiddenSourceIds: scenario.records.map((entry) => entry.id).filter((id) => !allowed.has(id)),
  };
  if (stableJson(truth) !== stableJson(scenario.groundTruth)) {
    errors.push(`${scenario.scenarioId}: stored ground truth differs from source-derived truth`);
  }
  return truth;
}

function contentRecords(scenario) {
  const queryTokens = tokens(scenario.query);
  return scenario.records
    .map((entry) => ({ entry, score: queryTokens.filter((token) => tokens(entry.text).includes(token)).length }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || right.entry.sequence - left.entry.sequence
      || left.entry.id.localeCompare(right.entry.id))
    .slice(0, 4)
    .map(({ entry }) => entry);
}

function associationEdges(records) {
  const episodes = new Map();
  for (const entry of records) {
    const rows = episodes.get(entry.episodeId) ?? [];
    rows.push(entry);
    episodes.set(entry.episodeId, rows);
  }
  const support = new Map();
  for (const [episodeId, rows] of episodes) {
    const ordered = [...rows].sort((left, right) => left.position - right.position);
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        if (Math.abs(ordered[rightIndex].position - ordered[leftIndex].position) !== 1) continue;
        for (const leftToken of tokens(ordered[leftIndex].text)) {
          for (const rightToken of tokens(ordered[rightIndex].text)) {
            if (leftToken === rightToken) continue;
            const key = [leftToken, rightToken].sort().join("\u0000");
            const seen = support.get(key) ?? new Set();
            seen.add(episodeId);
            support.set(key, seen);
          }
        }
      }
    }
  }
  return [...support.entries()]
    .filter(([, seen]) => seen.size >= 2)
    .map(([key]) => key.split("\u0000"));
}

function associationRecords(scenario) {
  const content = contentRecords(scenario);
  const seeds = new Set([...tokens(scenario.query), ...content.flatMap((entry) => tokens(entry.text))]);
  const associatedTokens = new Set();
  for (const [left, right] of associationEdges(scenario.records)) {
    if (seeds.has(left)) associatedTokens.add(right);
    if (seeds.has(right)) associatedTokens.add(left);
  }
  const associated = scenario.records
    .map((entry) => ({ entry, score: tokens(entry.text).filter((token) => associatedTokens.has(token)).length }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score
      || left.entry.sequence - right.entry.sequence
      || left.entry.id.localeCompare(right.entry.id))
    .map(({ entry }) => entry)
    .slice(0, 2);
  const result = [];
  for (const entry of [...associated, ...content]) {
    if (!result.some((candidate) => candidate.id === entry.id)) result.push(entry);
    if (result.length === 4) break;
  }
  return result;
}

function expectedCheckpoint(scenario, records) {
  const update = records.find((entry) => ["cancellation", "supersession"].includes(entry.role));
  const current = records.find((entry) => entry.role === "current-state");
  const constraintRecord = records.find((entry) => entry.role === "constraint");
  let taskState = "unknown";
  let action = null;
  let stateSource = null;
  let actionSource = null;
  if (update?.role === "cancellation") {
    taskState = "cancelled";
    stateSource = update.id;
    actionSource = update.id;
  } else if (update?.role === "supersession") {
    taskState = "active";
    action = parseAction(update.text, true);
    stateSource = update.id;
    actionSource = update.id;
  } else if (current) {
    taskState = "active";
    action = parseAction(current.text);
    stateSource = current.id;
    actionSource = current.id;
  }
  const retentionDays = Number(constraintRecord?.text.match(/retention_days=(\d+)/u)?.[1]) || null;
  return {
    schemaVersion: "memory-factorial/checkpoint-v2",
    checkpointId: `${scenario.scenarioId}-deterministic-checkpoint`,
    scenarioId: scenario.scenarioId,
    taskId: scenario.groundTruth.taskId,
    taskState,
    action,
    constraints: { retentionDays },
    support: {
      taskState: stateSource ? [stateSource] : [],
      action: actionSource ? [actionSource] : [],
      constraints: constraintRecord ? [constraintRecord.id] : [],
    },
    sourceRecordIds: [...new Set([stateSource, actionSource, constraintRecord?.id].filter(Boolean))],
    construction: {
      kind: "deterministic-source-cited",
      inputRecordIds: records.map((entry) => entry.id),
    },
  };
}

function rawEvidence(records) {
  return records.map((entry) => ({
    id: entry.id,
    kind: "raw-record",
    text: entry.text,
    sourceRecordIds: [entry.id],
  }));
}

function expectedEvidence(scenario, cellId, checkpoint) {
  const content = contentRecords(scenario);
  const association = associationRecords(scenario);
  if (cellId === "content-raw") return rawEvidence(content);
  if (cellId === "association-raw") return rawEvidence(association);
  const derived = {
    id: checkpoint.checkpointId,
    kind: "deterministic-checkpoint",
    text: stableJson(checkpoint),
    sourceRecordIds: checkpoint.sourceRecordIds,
  };
  if (cellId === "deterministic-checkpoint") return [derived];
  return [derived, ...rawEvidence(association)];
}

function validateAction(action) {
  if (action === null) return true;
  if (!exactKeys(action, ["operation", "arguments"]) || !(action.operation in ACTION_KEYS)) return false;
  if (!exactKeys(action.arguments, ACTION_KEYS[action.operation])) return false;
  return ACTION_KEYS[action.operation].every((key) => typeof action.arguments[key] === "string" && action.arguments[key]);
}

function validOutput(output) {
  if (!exactKeys(output, [
    "schemaVersion", "decision", "decisionReason", "taskId", "taskState", "action",
    "constraints", "support", "uncertain",
  ])) return false;
  if (output.schemaVersion !== "memory-factorial/decision-v2") return false;
  if (!["resume", "abstain"].includes(output.decision)) return false;
  if (!["current_action", "explicit_do_not_resume", "task_cancelled", "superseded_action", "insufficient_evidence"].includes(output.decisionReason)) return false;
  if (typeof output.taskId !== "string" || !["active", "cancelled", "unknown"].includes(output.taskState)) return false;
  if (!validateAction(output.action)) return false;
  if (!exactKeys(output.constraints, ["retentionDays"])) return false;
  if (output.constraints.retentionDays !== null && !Number.isSafeInteger(output.constraints.retentionDays)) return false;
  if (!exactKeys(output.support, ["taskState", "action", "constraints"])) return false;
  if (Object.values(output.support).some((ids) => !Array.isArray(ids)
    || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length)) return false;
  if (typeof output.uncertain !== "boolean") return false;
  if (output.decision === "resume" && (output.action === null || output.taskState !== "active" || output.uncertain)) return false;
  if (output.decision === "abstain" && output.action !== null) return false;
  if (output.decisionReason === "insufficient_evidence" && !output.uncertain) return false;
  return true;
}

function score(output, scenario, evidence) {
  if (!validOutput(output)) return { semanticCaseSuccess: 0, formatValid: 0 };
  const truth = scenario.groundTruth;
  const fields = {
    decision: Number(output.decision === truth.decision),
    decisionReason: Number(output.decisionReason === truth.decisionReason),
    taskId: Number(output.taskId === truth.taskId),
    taskState: Number(output.taskState === truth.taskState),
    action: Number(actionsEqual(output.action, truth.action)),
    constraints: Number(output.constraints.retentionDays === truth.constraints.retentionDays),
    uncertain: Number(output.uncertain === truth.uncertain),
  };
  const closure = new Set(evidence.flatMap((entry) => entry.sourceRecordIds));
  const claims = ["taskState", "action", "constraints"];
  const claimCoverage = {};
  let precise = true;
  for (const name of claims) {
    const group = truth.claimGroups[name];
    const cited = output.support[name];
    if (!group.required) {
      claimCoverage[name] = Number(cited.length === 0);
      precise = precise && cited.length === 0;
      continue;
    }
    const citedSet = new Set(cited);
    claimCoverage[name] = Number(group.sufficientSourceSets.some((set) => set.every((id) => citedSet.has(id))));
    const allowed = new Set(group.sufficientSourceSets.flat());
    precise = precise && cited.every((id) => allowed.has(id));
  }
  const citations = claims.flatMap((name) => output.support[name]);
  const invalidCitationCount = citations.filter((id) => !closure.has(id)).length;
  const unrelatedRecordUse = Number(citations.some((id) => truth.forbiddenSourceIds.includes(id)));
  const falseResume = Number(["do-not-resume", "cancelled"].includes(scenario.cueType) && output.decision === "resume");
  const currentId = `${scenario.scenarioId}-current`;
  const oldActionUse = Number(
    (["do-not-resume", "cancelled"].includes(scenario.cueType)
      && (output.action !== null || output.support.action.includes(currentId)))
    || (scenario.cueType === "superseded"
      && (actionsEqual(output.action, truth.initialAction) || output.support.action.includes(currentId))),
  );
  const constraintAllowed = new Set(truth.claimGroups.constraints.sufficientSourceSets.flat());
  const corroboratingConstraintSources = new Set(output.support.constraints.filter((id) => constraintAllowed.has(id))).size;
  return {
    semanticCaseSuccess: Number(
      Object.values(fields).every((value) => value === 1)
        && Object.values(claimCoverage).every((value) => value === 1)
        && precise && invalidCitationCount === 0 && unrelatedRecordUse === 0
        && falseResume === 0 && oldActionUse === 0,
    ),
    formatValid: 1,
    formatErrors: [],
    fields,
    claimCoverage,
    citationPrecision: Number(precise),
    invalidCitationCount,
    unrelatedRecordUse,
    falseResume,
    oldActionUse,
    corroboratingConstraintSources,
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(values, proportion) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.ceil(proportion * sorted.length) - 1] : 0;
}

function analyze(rows) {
  const byCell = {};
  for (const cellId of CELL_IDS) {
    const selected = rows.filter((row) => row.cellId === cellId);
    const bytes = selected.map((row) => row.evidenceBytes);
    byCell[cellId] = {
      rows: selected.length,
      semanticCaseSuccess: mean(selected.map((row) => row.metrics.semanticCaseSuccess)),
      actionBearingSuccess: mean(selected.filter((row) => ["positive", "superseded"].includes(row.cueType)).map((row) => row.metrics.semanticCaseSuccess)),
      negativeStateUpdateSuccess: mean(selected.filter((row) => ["do-not-resume", "cancelled", "superseded"].includes(row.cueType)).map((row) => row.metrics.semanticCaseSuccess)),
      falseResume: selected.reduce((sum, row) => sum + row.metrics.falseResume, 0),
      oldActionUse: selected.reduce((sum, row) => sum + row.metrics.oldActionUse, 0),
      invalidCitationCount: selected.reduce((sum, row) => sum + row.metrics.invalidCitationCount, 0),
      unrelatedRecordUse: selected.reduce((sum, row) => sum + row.metrics.unrelatedRecordUse, 0),
      evidenceBytesMedian: quantile(bytes, 0.5),
      evidenceBytesP95: quantile(bytes, 0.95),
    };
  }
  const actionRows = rows.filter((row) => ["positive", "superseded"].includes(row.cueType));
  function paired(leftCell, rightCell) {
    const right = new Map(actionRows.filter((row) => row.cellId === rightCell).map((row) => [row.scenarioId, row.metrics.semanticCaseSuccess]));
    const differences = actionRows.filter((row) => row.cellId === leftCell).map((row) => row.metrics.semanticCaseSuccess - right.get(row.scenarioId));
    return {
      leftCell, rightCell, cases: differences.length,
      netImprovementCases: differences.reduce((sum, value) => sum + value, 0),
      leftWins: differences.filter((value) => value > 0).length,
      rightWins: differences.filter((value) => value < 0).length,
    };
  }
  const association = paired("association-raw", "content-raw");
  const composition = paired("checkpoint-association-raw", "association-raw");
  const checkpointLosses = rows.filter((row) => row.cellId === "deterministic-checkpoint")
    .filter((row) => rows.find((candidate) => candidate.scenarioId === row.scenarioId && candidate.cellId === "association-raw").metrics.semanticCaseSuccess > row.metrics.semanticCaseSuccess).length;
  const safetyPass = ["association-raw", "deterministic-checkpoint", "checkpoint-association-raw"].every((cell) => {
    const value = byCell[cell];
    return value.falseResume === 0 && value.oldActionUse === 0 && value.invalidCitationCount === 0
      && value.unrelatedRecordUse === 0 && value.negativeStateUpdateSuccess === 1;
  });
  const compression = 1 - byCell["deterministic-checkpoint"].evidenceBytesP95 / byCell["association-raw"].evidenceBytesP95;
  return {
    schemaVersion: "memory-factorial/analysis-v2",
    experimentId: "memory-factorial-v0",
    experimentVersion: 2,
    byCell,
    contrasts: {
      associationVersusContent: association,
      checkpointVersusAssociation: { losses: checkpointLosses, p95EvidenceByteReduction: compression },
      compositionVersusAssociation: composition,
    },
    decisions: {
      associationCandidate: safetyPass && association.netImprovementCases >= 2 && association.rightWins === 0,
      deterministicCheckpointCandidate: safetyPass && checkpointLosses <= 1 && compression >= 0.25,
      compositionCandidate: safetyPass && composition.netImprovementCases >= 2 && composition.rightWins === 0
        && byCell["checkpoint-association-raw"].evidenceBytesP95 <= 1.5 * byCell["association-raw"].evidenceBytesP95,
      negativeCueContractPass: safetyPass,
    },
    classification: "deterministic-mechanism-only",
    prohibitedInference: "The deterministic reader is a contract fixture, not a language-model or Dolly product result.",
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

export function verifyBundle(bundle, { enforceFrozenHashes = true } = {}) {
  const errors = [];
  if (bundle.dataset.length !== 16) errors.push(`dataset row count ${bundle.dataset.length} != 16`);
  if (bundle.checkpoints.length !== 16) errors.push(`checkpoint row count ${bundle.checkpoints.length} != 16`);
  if (bundle.cases.length !== 64) errors.push(`case row count ${bundle.cases.length} != 64`);
  const scenarioIds = new Set();
  const truthByScenario = new Map();
  for (const scenario of bundle.dataset) {
    if (scenarioIds.has(scenario.scenarioId)) errors.push(`duplicate scenario ${scenario.scenarioId}`);
    scenarioIds.add(scenario.scenarioId);
    if (!CUE_TYPES.includes(scenario.cueType)) errors.push(`unknown cue ${scenario.cueType}`);
    truthByScenario.set(scenario.scenarioId, deriveTruth(scenario, errors));
  }
  for (const family of ["structured-data-import", "software-incident"]) {
    for (const cueType of CUE_TYPES) {
      if (bundle.dataset.filter((scenario) => scenario.taskFamily === family && scenario.cueType === cueType).length !== 2) {
        errors.push(`factor balance mismatch for ${family}/${cueType}`);
      }
    }
  }
  const checkpointByScenario = new Map();
  for (const scenario of bundle.dataset) {
    const checkpoint = bundle.checkpoints.find((entry) => entry.scenarioId === scenario.scenarioId);
    if (!checkpoint) {
      errors.push(`${scenario.scenarioId}: missing checkpoint`);
      continue;
    }
    const expected = expectedCheckpoint(scenario, associationRecords(scenario));
    if (stableJson(checkpoint) !== stableJson(expected)) errors.push(`${scenario.scenarioId}: checkpoint mismatch`);
    checkpointByScenario.set(scenario.scenarioId, checkpoint);
  }
  const caseIdentities = new Set();
  const recomputedRows = [];
  for (const row of bundle.cases) {
    if (caseIdentities.has(row.caseId)) errors.push(`duplicate case ${row.caseId}`);
    caseIdentities.add(row.caseId);
    const scenario = bundle.dataset.find((entry) => entry.scenarioId === row.scenarioId);
    if (!scenario || !CELL_IDS.includes(row.cellId)) {
      errors.push(`${row.caseId}: unknown scenario or cell`);
      continue;
    }
    const expected = expectedEvidence(scenario, row.cellId, checkpointByScenario.get(row.scenarioId));
    if (stableJson(row.evidence) !== stableJson(expected)) errors.push(`${row.caseId}: evidence mismatch`);
    const expectedBytes = Buffer.byteLength(stableJson(expected), "utf8");
    if (row.evidenceBytes !== expectedBytes || expectedBytes > 4096) errors.push(`${row.caseId}: evidence byte mismatch or overflow`);
    const metrics = score(row.output, scenario, expected);
    if (stableJson(row.metrics) !== stableJson(metrics)) errors.push(`${row.caseId}: metric mismatch`);
    recomputedRows.push({ ...row, metrics });
  }
  for (const scenario of bundle.dataset) {
    for (const cellId of CELL_IDS) {
      const id = `${scenario.scenarioId}-${cellId}`;
      if (!caseIdentities.has(id)) errors.push(`missing case ${id}`);
    }
  }
  const recomputedAnalysis = analyze(recomputedRows);
  if (stableJson(bundle.analysis) !== stableJson(recomputedAnalysis)) errors.push("analysis mismatch");
  if (stableJson(bundle.manifest.aggregateMetrics) !== stableJson(bundle.analysis)) errors.push("manifest aggregate mismatch");

  const datasetText = serializeJsonLines(bundle.dataset);
  if (bundle.freeze.datasetSha256 !== sha256(datasetText)) errors.push("freeze dataset hash mismatch");
  if (bundle.freeze.preregistrationSha256 !== sha256(`${stableJson(bundle.preregistration)}\n`)) {
    errors.push("freeze preregistration hash mismatch");
  }
  if (enforceFrozenHashes) {
    const expected = new Map((bundle.preregistration.domainDesign.implementationFiles ?? []).map((entry) => [entry.path, entry.sha256]));
    for (const entry of bundle.freeze.implementationFiles) {
      const bytes = readFileSync(resolve(REPOSITORY_ROOT, entry.path));
      const actual = sha256(bytes);
      if (entry.sha256 !== actual || expected.get(entry.path) !== actual) errors.push(`implementation hash mismatch ${entry.path}`);
    }
    if (bundle.preregistration.domainDesign.datasetSha256 !== bundle.freeze.datasetSha256) errors.push("registered dataset hash mismatch");
  }
  if (bundle.checksums) {
    const payloads = artifactPayloads(bundle);
    for (const [name, digest] of Object.entries(bundle.checksums)) {
      if (!(name in payloads) || sha256(payloads[name]) !== digest) errors.push(`checksum mismatch ${name}`);
    }
  }
  return {
    valid: errors.length === 0,
    schemaVersion: "memory-factorial/validation-v2",
    experimentId: "memory-factorial-v0",
    experimentVersion: 2,
    checks: {
      datasetRows: bundle.dataset.length,
      checkpointRows: bundle.checkpoints.length,
      caseRows: bundle.cases.length,
      independentTreatmentImports: 0,
      taskFamilies: new Set(bundle.dataset.map((entry) => entry.taskFamily)).size,
      cueTypes: new Set(bundle.dataset.map((entry) => entry.cueType)).size,
    },
    errors,
    recomputedAnalysis,
  };
}

export function readArtifactDirectory(directory) {
  const read = (name) => readFileSync(resolve(directory, name), "utf8");
  const checksumEntries = Object.fromEntries(read("sha256sums.txt").trim().split("\n").map((line) => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/u);
    if (!match) throw new Error(`malformed checksum line ${line}`);
    return [match[2], match[1]];
  }));
  const bundle = {
    freeze: JSON.parse(read("run-freeze.json")),
    preregistration: JSON.parse(read("preregistration.json")),
    dataset: parseJsonLines(read("dataset.jsonl")),
    checkpoints: parseJsonLines(read("checkpoints.jsonl")),
    cases: parseJsonLines(read("cases.jsonl")),
    analysis: JSON.parse(read("analysis.json")),
    manifest: JSON.parse(read("run-manifest.json")),
    checksums: checksumEntries,
  };
  const exactErrors = [];
  for (const [name, digest] of Object.entries(checksumEntries)) {
    if (sha256(read(name)) !== digest) exactErrors.push(`exact artifact checksum mismatch ${name}`);
  }
  if (bundle.freeze.preregistrationSha256 !== sha256(read("preregistration.json"))) {
    exactErrors.push("exact preregistration snapshot hash mismatch");
  }
  return { bundle, exactErrors };
}

export function verifyArtifactDirectory(directory, options = {}) {
  const { bundle, exactErrors } = readArtifactDirectory(directory);
  const result = verifyBundle(bundle, options);
  return { ...result, valid: result.valid && exactErrors.length === 0, errors: [...exactErrors, ...result.errors] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("usage: node verify.mjs <artifact-directory>");
  const result = verifyArtifactDirectory(resolve(process.argv[2]), { enforceFrozenHashes: true });
  process.stdout.write(`${stableJson(result)}\n`);
  if (!result.valid) process.exitCode = 1;
}
