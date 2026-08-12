import {
  ACTION_ARGUMENT_KEYS,
  CELL_IDS,
  actionEquals,
  exactKeys,
  stableJson,
  utf8Bytes,
  validateClosedAction,
} from "./common.mjs";

const OUTPUT_KEYS = [
  "schemaVersion",
  "decision",
  "decisionReason",
  "taskId",
  "taskState",
  "action",
  "constraints",
  "support",
  "uncertain",
];

const SUPPORT_KEYS = ["taskState", "action", "constraints"];

function extractTaskId(query) {
  return query.match(/task ([a-z0-9-]+)/iu)?.[1] ?? null;
}

function parseRawState(entry) {
  if (entry.kind !== "raw-record") return null;
  const taskId = entry.text.match(/Task ([a-z0-9-]+) state=/u)?.[1] ?? null;
  if (/state=cancelled/u.test(entry.text)) {
    return { taskId, taskState: "cancelled", action: null, sourceId: entry.id, priority: 3 };
  }
  const replacementOperation = entry.text.match(/replacement_operation_code=([a-z0-9_]+)/u)?.[1];
  const replacementArguments = entry.text.match(/replacement_arguments=(\{[^\n]+?\})\./u)?.[1];
  if (replacementOperation && replacementArguments) {
    return {
      taskId,
      taskState: "active",
      action: { operation: replacementOperation, arguments: JSON.parse(replacementArguments) },
      sourceId: entry.id,
      priority: 2,
    };
  }
  const operation = entry.text.match(/operation_code=([a-z0-9_]+)/u)?.[1];
  const argumentsText = entry.text.match(/arguments=(\{[^\n]+?\})\./u)?.[1];
  if (operation && operation !== "none" && argumentsText) {
    return {
      taskId,
      taskState: "active",
      action: { operation, arguments: JSON.parse(argumentsText) },
      sourceId: entry.id,
      priority: 1,
    };
  }
  return null;
}

function parseCheckpoint(entry) {
  if (entry.kind !== "deterministic-checkpoint") return null;
  const checkpoint = JSON.parse(entry.text);
  return {
    taskId: checkpoint.taskId,
    taskState: checkpoint.taskState,
    action: checkpoint.action,
    sourceId: checkpoint.support.action[0] ?? checkpoint.support.taskState[0] ?? null,
    stateSourceId: checkpoint.support.taskState[0] ?? null,
    actionSourceId: checkpoint.support.action[0] ?? null,
    constraintSourceId: checkpoint.support.constraints[0] ?? null,
    retentionDays: checkpoint.constraints.retentionDays,
    priority: 4,
  };
}

function parseRetention(entry) {
  if (entry.kind !== "raw-record") return null;
  const match = entry.text.match(/retention_days=(\d+)/u);
  return match ? { retentionDays: Number(match[1]), sourceId: entry.id } : null;
}

function outputShape({
  decision,
  decisionReason,
  taskId,
  taskState,
  action,
  retentionDays,
  support,
  uncertain,
}) {
  return {
    schemaVersion: "memory-factorial/decision-v2",
    decision,
    decisionReason,
    taskId,
    taskState,
    action,
    constraints: { retentionDays },
    support,
    uncertain,
  };
}

export function runDeterministicReader(scenario, evidence) {
  const taskId = extractTaskId(scenario.query);
  if (/Do not resume or continue task/u.test(scenario.query)) {
    return outputShape({
      decision: "abstain",
      decisionReason: "explicit_do_not_resume",
      taskId,
      taskState: "unknown",
      action: null,
      retentionDays: null,
      support: { taskState: [], action: [], constraints: [] },
      uncertain: false,
    });
  }

  const checkpoints = evidence.map(parseCheckpoint).filter(Boolean);
  const rawStates = evidence.map(parseRawState).filter(Boolean);
  const state = [...checkpoints, ...rawStates]
    .sort((left, right) => right.priority - left.priority)[0] ?? null;
  const checkpointRetention = checkpoints.find((entry) => entry.retentionDays !== null);
  const rawRetention = evidence.map(parseRetention).find(Boolean);
  const retention = checkpointRetention
    ? { retentionDays: checkpointRetention.retentionDays, sourceId: checkpointRetention.constraintSourceId }
    : rawRetention;

  if (state?.taskState === "cancelled") {
    const sourceId = state.stateSourceId ?? state.sourceId;
    return outputShape({
      decision: "abstain",
      decisionReason: "task_cancelled",
      taskId,
      taskState: "cancelled",
      action: null,
      retentionDays: null,
      support: { taskState: [sourceId], action: [state.actionSourceId ?? sourceId], constraints: [] },
      uncertain: false,
    });
  }

  if (!state?.action || !retention || retention.retentionDays === null) {
    return outputShape({
      decision: "abstain",
      decisionReason: "insufficient_evidence",
      taskId,
      taskState: state?.taskState ?? "unknown",
      action: null,
      retentionDays: null,
      support: {
        taskState: (state?.stateSourceId ?? state?.sourceId) ? [state.stateSourceId ?? state.sourceId] : [],
        action: [],
        constraints: [],
      },
      uncertain: true,
    });
  }

  const actionSourceId = state.actionSourceId ?? state.sourceId;
  const stateSourceId = state.stateSourceId ?? state.sourceId;
  return outputShape({
    decision: "resume",
    decisionReason: scenario.cueType === "superseded" ? "superseded_action" : "current_action",
    taskId,
    taskState: "active",
    action: state.action,
    retentionDays: retention.retentionDays,
    support: {
      taskState: [stateSourceId],
      action: [actionSourceId],
      constraints: [retention.sourceId],
    },
    uncertain: false,
  });
}

export function validateDecisionOutput(output) {
  const errors = [];
  if (!exactKeys(output, OUTPUT_KEYS)) errors.push("output keys mismatch");
  if (output?.schemaVersion !== "memory-factorial/decision-v2") errors.push("schemaVersion mismatch");
  if (!(["resume", "abstain"].includes(output?.decision))) errors.push("decision mismatch");
  if (!([
    "current_action",
    "explicit_do_not_resume",
    "task_cancelled",
    "superseded_action",
    "insufficient_evidence",
  ].includes(output?.decisionReason))) errors.push("decisionReason mismatch");
  if (typeof output?.taskId !== "string" || output.taskId.length === 0) errors.push("taskId mismatch");
  if (!(["active", "cancelled", "unknown"].includes(output?.taskState))) errors.push("taskState mismatch");
  const actionValidation = validateClosedAction(output?.action);
  if (!actionValidation.valid) errors.push(actionValidation.reason);
  if (!exactKeys(output?.constraints, ["retentionDays"])) errors.push("constraints keys mismatch");
  if (output?.constraints?.retentionDays !== null
    && (!Number.isSafeInteger(output?.constraints?.retentionDays) || output.constraints.retentionDays < 1)) {
    errors.push("retentionDays mismatch");
  }
  if (!exactKeys(output?.support, SUPPORT_KEYS)) errors.push("support keys mismatch");
  for (const claim of SUPPORT_KEYS) {
    const citations = output?.support?.[claim];
    if (!Array.isArray(citations) || citations.some((id) => typeof id !== "string" || id.length === 0)) {
      errors.push(`${claim} support mismatch`);
    } else if (new Set(citations).size !== citations.length) {
      errors.push(`${claim} support contains duplicates`);
    }
  }
  if (typeof output?.uncertain !== "boolean") errors.push("uncertain mismatch");

  if (output?.decision === "resume") {
    if (output.taskState !== "active" || output.action === null || output.uncertain !== false) {
      errors.push("resume conditional mismatch");
    }
    if (!(["current_action", "superseded_action"].includes(output.decisionReason))) {
      errors.push("resume reason mismatch");
    }
  }
  if (output?.decision === "abstain") {
    if (output.action !== null) errors.push("abstain action must be null");
    if (output.decisionReason === "insufficient_evidence" && output.uncertain !== true) {
      errors.push("insufficient evidence must be uncertain");
    }
    if (output.decisionReason !== "insufficient_evidence" && output.uncertain !== false) {
      errors.push("definite abstention cannot be uncertain");
    }
  }
  return { valid: errors.length === 0, errors };
}

function groupCoverage(citations, sufficientSourceSets) {
  const cited = new Set(citations);
  return sufficientSourceSets.some((sourceSet) => sourceSet.every((id) => cited.has(id)));
}

function groupPrecision(citations, sufficientSourceSets) {
  const allowed = new Set(sufficientSourceSets.flat());
  return citations.every((id) => allowed.has(id));
}

function citationClosure(evidence) {
  return new Set(evidence.flatMap((entry) => entry.sourceRecordIds));
}

export function scoreDecisionOutput(output, scenario, evidence) {
  const format = validateDecisionOutput(output);
  if (!format.valid) {
    return {
      semanticCaseSuccess: 0,
      formatValid: 0,
      formatErrors: format.errors,
      fields: {
        decision: 0,
        decisionReason: 0,
        taskId: 0,
        taskState: 0,
        action: 0,
        constraints: 0,
        uncertain: 0,
      },
      claimCoverage: { taskState: 0, action: 0, constraints: 0 },
      citationPrecision: 0,
      invalidCitationCount: 0,
      unrelatedRecordUse: 0,
      falseResume: 0,
      oldActionUse: 0,
      corroboratingConstraintSources: 0,
    };
  }

  const truth = scenario.groundTruth;
  const fields = {
    decision: Number(output.decision === truth.decision),
    decisionReason: Number(output.decisionReason === truth.decisionReason),
    taskId: Number(output.taskId === truth.taskId),
    taskState: Number(output.taskState === truth.taskState),
    action: Number(actionEquals(output.action, truth.action)),
    constraints: Number(output.constraints.retentionDays === truth.constraints.retentionDays),
    uncertain: Number(output.uncertain === truth.uncertain),
  };
  const closure = citationClosure(evidence);
  const allCitations = SUPPORT_KEYS.flatMap((claim) => output.support[claim]);
  const invalidCitationCount = allCitations.filter((id) => !closure.has(id)).length;
  const claimCoverage = {};
  let precise = true;
  for (const claim of SUPPORT_KEYS) {
    const group = truth.claimGroups[claim];
    const citations = output.support[claim];
    if (group.required) {
      claimCoverage[claim] = Number(groupCoverage(citations, group.sufficientSourceSets));
      precise = precise && groupPrecision(citations, group.sufficientSourceSets);
    } else {
      claimCoverage[claim] = Number(citations.length === 0);
      precise = precise && citations.length === 0;
    }
  }
  const unrelatedRecordUse = Number(allCitations.some((id) => truth.forbiddenSourceIds.includes(id)));
  const falseResume = Number(
    ["do-not-resume", "cancelled"].includes(scenario.cueType) && output.decision === "resume",
  );
  const currentSourceId = `${scenario.scenarioId}-current`;
  const oldActionUse = Number(
    (["do-not-resume", "cancelled"].includes(scenario.cueType)
      && (output.action !== null || output.support.action.includes(currentSourceId)))
    || (scenario.cueType === "superseded"
      && (actionEquals(output.action, truth.initialAction) || output.support.action.includes(currentSourceId))),
  );
  const constraintAllowed = new Set(truth.claimGroups.constraints.sufficientSourceSets.flat());
  const corroboratingConstraintSources = new Set(
    output.support.constraints.filter((id) => constraintAllowed.has(id)),
  ).size;
  const semanticCaseSuccess = Number(
    Object.values(fields).every((value) => value === 1)
      && Object.values(claimCoverage).every((value) => value === 1)
      && precise
      && invalidCitationCount === 0
      && unrelatedRecordUse === 0
      && falseResume === 0
      && oldActionUse === 0,
  );
  return {
    semanticCaseSuccess,
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
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values, proportion) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(proportion * sorted.length) - 1];
}

export function analyzeCases(cases) {
  const byCell = {};
  for (const cellId of CELL_IDS) {
    const rows = cases.filter((row) => row.cellId === cellId);
    const bytes = rows.map((row) => row.evidenceBytes);
    byCell[cellId] = {
      rows: rows.length,
      semanticCaseSuccess: mean(rows.map((row) => row.metrics.semanticCaseSuccess)),
      actionBearingSuccess: mean(rows
        .filter((row) => ["positive", "superseded"].includes(row.cueType))
        .map((row) => row.metrics.semanticCaseSuccess)),
      negativeStateUpdateSuccess: mean(rows
        .filter((row) => ["do-not-resume", "cancelled", "superseded"].includes(row.cueType))
        .map((row) => row.metrics.semanticCaseSuccess)),
      falseResume: rows.reduce((sum, row) => sum + row.metrics.falseResume, 0),
      oldActionUse: rows.reduce((sum, row) => sum + row.metrics.oldActionUse, 0),
      invalidCitationCount: rows.reduce((sum, row) => sum + row.metrics.invalidCitationCount, 0),
      unrelatedRecordUse: rows.reduce((sum, row) => sum + row.metrics.unrelatedRecordUse, 0),
      evidenceBytesMedian: quantile(bytes, 0.5),
      evidenceBytesP95: quantile(bytes, 0.95),
    };
  }
  const actionBearing = cases.filter((row) => ["positive", "superseded"].includes(row.cueType));
  const paired = (leftCell, rightCell) => {
    const rightByScenario = new Map(actionBearing
      .filter((row) => row.cellId === rightCell)
      .map((row) => [row.scenarioId, row.metrics.semanticCaseSuccess]));
    const differences = actionBearing
      .filter((row) => row.cellId === leftCell)
      .map((row) => row.metrics.semanticCaseSuccess - rightByScenario.get(row.scenarioId));
    return {
      leftCell,
      rightCell,
      cases: differences.length,
      netImprovementCases: differences.reduce((sum, value) => sum + value, 0),
      leftWins: differences.filter((value) => value > 0).length,
      rightWins: differences.filter((value) => value < 0).length,
    };
  };
  const associationVersusContent = paired("association-raw", "content-raw");
  const compositionVersusAssociation = paired("checkpoint-association-raw", "association-raw");
  const checkpointLosses = cases.filter((row) => row.cellId === "deterministic-checkpoint")
    .filter((row) => {
      const baseline = cases.find((candidate) => candidate.scenarioId === row.scenarioId && candidate.cellId === "association-raw");
      return baseline.metrics.semanticCaseSuccess > row.metrics.semanticCaseSuccess;
    }).length;
  const candidates = ["association-raw", "deterministic-checkpoint", "checkpoint-association-raw"];
  const safetyPass = candidates.every((cellId) => {
    const result = byCell[cellId];
    return result.falseResume === 0
      && result.oldActionUse === 0
      && result.invalidCitationCount === 0
      && result.unrelatedRecordUse === 0
      && result.negativeStateUpdateSuccess === 1;
  });
  const checkpointCompression = 1 - (byCell["deterministic-checkpoint"].evidenceBytesP95
    / byCell["association-raw"].evidenceBytesP95);
  return {
    schemaVersion: "memory-factorial/analysis-v2",
    experimentId: "memory-factorial-v0",
    experimentVersion: 2,
    byCell,
    contrasts: {
      associationVersusContent,
      checkpointVersusAssociation: {
        losses: checkpointLosses,
        p95EvidenceByteReduction: checkpointCompression,
      },
      compositionVersusAssociation,
    },
    decisions: {
      associationCandidate: safetyPass
        && associationVersusContent.netImprovementCases >= 2
        && associationVersusContent.rightWins === 0,
      deterministicCheckpointCandidate: safetyPass
        && checkpointLosses <= 1
        && checkpointCompression >= 0.25,
      compositionCandidate: safetyPass
        && compositionVersusAssociation.netImprovementCases >= 2
        && compositionVersusAssociation.rightWins === 0
        && byCell["checkpoint-association-raw"].evidenceBytesP95
          <= 1.5 * byCell["association-raw"].evidenceBytesP95,
      negativeCueContractPass: safetyPass,
    },
    classification: "deterministic-mechanism-only",
    prohibitedInference: "The deterministic reader is a contract fixture, not a language-model or Dolly product result.",
  };
}

export function makeCaseRow(scenario, cellId, evidence, output) {
  const metrics = scoreDecisionOutput(output, scenario, evidence);
  return {
    schemaVersion: "memory-factorial/case-v2",
    caseId: `${scenario.scenarioId}-${cellId}`,
    scenarioId: scenario.scenarioId,
    seed: scenario.seed,
    taskFamily: scenario.taskFamily,
    cueType: scenario.cueType,
    cellId,
    evidence,
    evidenceBytes: utf8Bytes(stableJson(evidence)),
    output,
    metrics,
  };
}

export function actionOperations() {
  return Object.keys(ACTION_ARGUMENT_KEYS).sort();
}
