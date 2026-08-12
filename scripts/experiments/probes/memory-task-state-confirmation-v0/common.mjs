import { createHash } from "node:crypto";

export const EXPERIMENT_ID = "memory-task-state-confirmation-v0";
export const EXPERIMENT_VERSION = 1;
export const ALGORITHM_VERSION = "memory-task-state-confirmation/v1";
export const CONDITION_IDS = Object.freeze([
  "content-raw",
  "association-raw",
  "checkpoint-only",
  "checkpoint-association",
]);
export const CUE_STATES = Object.freeze([
  "positive",
  "do-not-resume",
  "cancelled",
  "superseded",
]);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stableJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("value is not JSON");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function fisherYates(values, seed) {
  const result = [...values];
  const random = xorshift32(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(random() * (index + 1));
    [result[index], result[replacement]] = [result[replacement], result[index]];
  }
  return result;
}

function rawRecord(id, text, role, eligible = true) {
  return Object.freeze({ id, kind: "raw-record", text, role, eligible, sourceRecordIds: [id] });
}

function cueText(task, cueState) {
  if (cueState === "positive") {
    return `Resume task ${task.taskId} from memory. Return the current operation and durable constraint.`;
  }
  if (cueState === "do-not-resume") {
    return `Do not resume task ${task.taskId}. Confirm that no old operation should run.`;
  }
  if (cueState === "cancelled") {
    return `Check task ${task.taskId} after its interruption and obey its latest recorded state.`;
  }
  return `Continue task ${task.taskId} after its interruption and obey its latest recorded operation.`;
}

function interruptionRecords(family) {
  return Array.from({ length: 64 }, (_, index) => ({
    id: `${family}-interrupt-${String(index + 1).padStart(2, "0")}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: index % 2 === 0
      ? `Unrelated interrupt ${index + 1}: inventory item ${family}-${index + 11}.`
      : `Completed unrelated interrupt ${index + 1} without retaining another task's state.`,
  }));
}

function buildScenario(task, cueState) {
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
  const records = [constraintA, anchorA, constraintB, anchorB, action, ...(update ? [update] : []), distractor];
  const interrupts = interruptionRecords(prefix);
  const activeContext = [
    ...interrupts.slice(-4),
    { id: `${prefix}-cue`, role: "user", text: cueText(task, cueState) },
  ];
  const expectedDecision = cueState === "do-not-resume" || cueState === "cancelled"
    ? "abstain"
    : "resume";
  const decisionReason = cueState === "positive"
    ? "current_action"
    : cueState === "do-not-resume"
      ? "explicit_do_not_resume"
      : cueState === "cancelled"
        ? "task_cancelled"
        : "superseded_action";
  const expectedOperation = cueState === "superseded"
    ? task.replacement.operation
    : expectedDecision === "resume"
      ? task.operation
      : null;
  const expectedArguments = cueState === "superseded"
    ? task.replacement.arguments
    : expectedDecision === "resume"
      ? task.arguments
      : null;
  const expectedAction = expectedOperation === null
    ? null
    : { operation: expectedOperation, arguments: { ...expectedArguments } };
  const expectedConstraints = expectedDecision === "resume"
    ? { retentionDays: Number(task.constraint.value) }
    : { retentionDays: null };
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
    action: expectedDecision !== "resume"
      ? []
      : [{
          claimId: cueState === "superseded" ? "supersession-action" : "current-action",
          sufficientSourceIds: [cueState === "superseded" ? updateId : actionId],
        }],
    constraints: expectedDecision !== "resume"
      ? []
      : [{
          claimId: "retention-constraint",
          sufficientSourceIds: [constraintAId, constraintBId],
        }],
  };
  return Object.freeze({
    scenarioId: `${task.family}/${task.taskId}/${cueState}`,
    family: task.family,
    cueState,
    task,
    records: Object.freeze(records),
    interruptionRecords: Object.freeze(interrupts),
    activeContext: Object.freeze(activeContext),
    identities: Object.freeze({
      actionId,
      constraintAId,
      constraintBId,
      updateId,
      distractorId: distractor.id,
    }),
    truth: Object.freeze({
      decision: expectedDecision,
      decisionReason,
      taskId: task.taskId,
      taskState: cueState === "cancelled" ? "cancelled" : "active",
      action: expectedAction === null ? null : Object.freeze(expectedAction),
      constraints: Object.freeze(expectedConstraints),
      uncertain: false,
      claimGroups: Object.freeze(Object.fromEntries(Object.entries(claimGroups)
        .map(([key, value]) => [key, Object.freeze(value)]))),
      obsoleteOperation: task.operation,
    }),
  });
}

export function buildDataset(preregistration) {
  const tasks = preregistration.data?.baseTasks;
  if (!Array.isArray(tasks) || tasks.length !== 4) throw new Error("four base tasks are required");
  const scenarios = tasks.flatMap((task) => CUE_STATES.map((cueState) => buildScenario(task, cueState)));
  if (scenarios.length !== 16) throw new Error("scenario coverage mismatch");
  return Object.freeze(scenarios);
}

export function datasetRow(scenario) {
  return {
    schemaVersion: "memory-task-state-confirmation/dataset-v1",
    scenarioId: scenario.scenarioId,
    family: scenario.family,
    cueState: scenario.cueState,
    records: scenario.records,
    interruptionRecords: scenario.interruptionRecords,
    activeContext: scenario.activeContext,
    truth: scenario.truth,
  };
}

function checkpointFor(scenario) {
  const cancelled = scenario.cueState === "cancelled";
  const superseded = scenario.cueState === "superseded";
  const currentOperation = superseded
    ? scenario.task.replacement.operation
    : cancelled
      ? null
      : scenario.task.operation;
  const currentArguments = superseded
    ? scenario.task.replacement.arguments
    : cancelled
      ? null
      : scenario.task.arguments;
  const sourceRecordIds = cancelled
    ? [scenario.identities.updateId]
    : [
        superseded ? scenario.identities.updateId : scenario.identities.actionId,
        scenario.identities.constraintAId,
      ];
  return {
    schemaVersion: "dolly.task-checkpoint/1",
    taskId: scenario.task.taskId,
    state: cancelled ? "cancelled" : superseded ? "superseded" : "active",
    action: currentOperation === null
      ? null
      : { operation: currentOperation, arguments: { ...currentArguments } },
    constraints: cancelled
      ? { retentionDays: null }
      : { retentionDays: Number(scenario.task.constraint.value) },
    sourceRecordIds,
  };
}

function contentRaw(scenario) {
  const byId = new Map(scenario.records.map((record) => [record.id, record]));
  const identifiers = [
    ...(scenario.identities.updateId ? [scenario.identities.updateId] : []),
    scenario.identities.actionId,
    scenario.identities.distractorId,
  ];
  return identifiers.map((id) => byId.get(id));
}

function associationRaw(scenario) {
  const byId = new Map(scenario.records.map((record) => [record.id, record]));
  return [
    ...contentRaw(scenario),
    byId.get(scenario.identities.constraintAId),
    byId.get(scenario.identities.constraintBId),
  ];
}

function checkpointEvidence(scenario) {
  const checkpoint = checkpointFor(scenario);
  return Object.freeze({
    id: `${scenario.scenarioId.replaceAll("/", "-")}-checkpoint`,
    kind: "task-checkpoint",
    text: stableJson(checkpoint),
    role: "derived-checkpoint",
    eligible: true,
    sourceRecordIds: checkpoint.sourceRecordIds,
  });
}

export function evidenceForCondition(scenario, conditionId) {
  if (!CONDITION_IDS.includes(conditionId)) throw new Error(`unknown condition ${conditionId}`);
  const raw = conditionId === "content-raw" ? contentRaw(scenario) : associationRaw(scenario);
  if (raw.some((entry) => entry === undefined)) throw new Error("evidence source is missing");
  if (conditionId === "checkpoint-only") return Object.freeze([checkpointEvidence(scenario)]);
  if (conditionId === "checkpoint-association") {
    return Object.freeze([checkpointEvidence(scenario), ...raw]);
  }
  return Object.freeze(raw);
}

export function agentMessages(preregistration, scenario, conditionId, evidence) {
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

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function parseStrictObject(content) {
  if (typeof content !== "string" || content.trim() === "" || content.includes("```")) {
    throw new Error("response is not bare JSON");
  }
  const value = JSON.parse(content);
  if (!plainObject(value)) throw new Error("response is not one object");
  return value;
}

export function validateAgentOutput(preregistration, value) {
  const contract = preregistration.outputContract;
  if (!exactKeys(value, contract.closedKeys)) throw new Error("Agent output keys mismatch");
  if (value.schemaVersion !== contract.schemaVersion) throw new Error("Agent schema version mismatch");
  if (!contract.decisions.includes(value.decision)) throw new Error("Agent decision mismatch");
  if (!contract.decisionReasons.includes(value.decisionReason)) {
    throw new Error("Agent decision reason mismatch");
  }
  if (typeof value.taskId !== "string" || value.taskId === "") throw new Error("Agent taskId mismatch");
  if (!contract.taskStates.includes(value.taskState)) throw new Error("Agent task state mismatch");
  if (value.action !== null) {
    if (!exactKeys(value.action, ["operation", "arguments"])) throw new Error("Agent action mismatch");
    if (!contract.operations.includes(value.action.operation)) {
      throw new Error("Agent operation is outside the closed enum");
    }
    if (!exactKeys(value.action.arguments, contract.argumentsKeys)) {
      throw new Error("Agent arguments mismatch");
    }
    if (Object.values(value.action.arguments).some((entry) => typeof entry !== "string" || entry === "")) {
      throw new Error("Agent action argument value mismatch");
    }
  }
  if (!exactKeys(value.constraints, contract.constraintKeys) ||
    (value.constraints.retentionDays !== null &&
      (!Number.isSafeInteger(value.constraints.retentionDays) || value.constraints.retentionDays <= 0))) {
    throw new Error("Agent constraints mismatch");
  }
  if (!exactKeys(value.support, contract.supportKeys)) throw new Error("Agent support mismatch");
  for (const key of contract.supportKeys) {
    const citations = value.support[key];
    if (!Array.isArray(citations) || citations.some((id) => typeof id !== "string") ||
      new Set(citations).size !== citations.length) {
      throw new Error(`Agent ${key} support mismatch`);
    }
  }
  if (typeof value.uncertain !== "boolean") throw new Error("Agent uncertainty mismatch");
  if (value.decision === "resume" && (value.action === null || value.uncertain)) {
    throw new Error("Agent resume invariant mismatch");
  }
  if (value.decision === "abstain" && value.action !== null) {
    throw new Error("Agent abstain invariant mismatch");
  }
  return value;
}

function same(left, right) {
  return stableJson(left) === stableJson(right);
}

export function scoreCase(output, scenario, evidence, malformed = false) {
  const empty = {
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
  if (!output) return empty;
  const truth = scenario.truth;
  const evidenceSourceIds = new Set(evidence.flatMap((entry) => entry.sourceRecordIds));
  const eligibleById = new Map(scenario.records.map((record) => [record.id, record.eligible]));
  let requiredClaims = 0;
  let coveredClaims = 0;
  let citationCount = 0;
  let validCitationCount = 0;
  let invalidOrUnrelatedCitation = 0;
  let corroborationCount = 0;
  for (const supportKey of ["taskState", "action", "constraints"]) {
    const citations = output.support[supportKey];
    const groups = truth.claimGroups[supportKey];
    const permitted = new Set(groups.flatMap((group) => group.sufficientSourceIds));
    requiredClaims += groups.length;
    for (const group of groups) {
      const matches = group.sufficientSourceIds.filter((id) => citations.includes(id));
      if (matches.length > 0) coveredClaims += 1;
      corroborationCount += Math.max(0, matches.length - 1);
    }
    citationCount += citations.length;
    for (const id of citations) {
      if (evidenceSourceIds.has(id) && eligibleById.get(id) === true && permitted.has(id)) {
        validCitationCount += 1;
      } else {
        invalidOrUnrelatedCitation += 1;
      }
    }
  }
  const claimCoverage = requiredClaims === 0 ? 1 : coveredClaims / requiredClaims;
  const citationPrecision = citationCount === 0
    ? Number(requiredClaims === 0)
    : validCitationCount / citationCount;
  const fields = {
    decisionAccuracy: Number(output.decision === truth.decision),
    decisionReasonAccuracy: Number(output.decisionReason === truth.decisionReason),
    taskAccuracy: Number(output.taskId === truth.taskId),
    taskStateAccuracy: Number(output.taskState === truth.taskState),
    operationAccuracy: Number(output.action?.operation === truth.action?.operation ||
      (output.action === null && truth.action === null)),
    argumentAccuracy: Number(same(output.action?.arguments ?? null, truth.action?.arguments ?? null)),
    constraintAccuracy: Number(same(output.constraints, truth.constraints)),
  };
  const falseResume = Number(
    (scenario.cueState === "do-not-resume" || scenario.cueState === "cancelled") &&
    output.decision === "resume"
  );
  const obsoleteActionUse = Number(
    ((scenario.cueState === "do-not-resume" || scenario.cueState === "cancelled") &&
      output.action !== null) ||
    (scenario.cueState === "superseded" &&
      (output.action?.operation === truth.obsoleteOperation ||
        output.support.action.includes(scenario.identities.actionId)))
  );
  const semanticSuccess = Number(
    Object.values(fields).every((value) => value === 1) &&
    output.uncertain === truth.uncertain &&
    claimCoverage === 1 &&
    citationPrecision === 1 &&
    invalidOrUnrelatedCitation === 0 &&
    falseResume === 0 &&
    obsoleteActionUse === 0
  );
  return {
    semanticSuccess,
    ...fields,
    claimCoverage,
    citationPrecision,
    corroborationCount,
    falseResume,
    obsoleteActionUse,
    invalidOrUnrelatedCitation,
    malformed,
  };
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function analyzeCases(preregistration, rows, rawRows) {
  const percentile = (values, quantile) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil(quantile * sorted.length) - 1];
  };
  const byCondition = {};
  for (const conditionId of CONDITION_IDS) {
    const selected = rows.filter((row) => row.conditionId === conditionId);
    const actionBearing = selected.filter((row) =>
      row.cueState === "positive" || row.cueState === "superseded"
    );
    const stateCases = selected.filter((row) => row.cueState !== "positive");
    const evidenceBytes = selected.map((row) => row.evidenceBytes);
    byCondition[conditionId] = {
      rows: selected.length,
      actionBearingSuccesses: actionBearing.reduce(
        (sum, row) => sum + row.metrics.semanticSuccess,
        0,
      ),
      semanticSuccess: mean(selected.map((row) => row.metrics.semanticSuccess)),
      falseResume: stateCases.reduce((sum, row) => sum + row.metrics.falseResume, 0),
      obsoleteActionUse: stateCases.reduce((sum, row) => sum + row.metrics.obsoleteActionUse, 0),
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
  const contentByScenario = new Map(rows.filter((row) => row.conditionId === "content-raw")
    .map((row) => [row.scenarioId, row.metrics.semanticSuccess]));
  const actionBearing = (row) => row.cueState === "positive" || row.cueState === "superseded";
  const pairedActionBearingImprovements = (conditionId) => rows.filter((row) =>
    row.conditionId === conditionId &&
    actionBearing(row) &&
    row.metrics.semanticSuccess > (contentByScenario.get(row.scenarioId) ?? 0)
  ).length;
  const pairedActionBearingLosses = (conditionId) => rows.filter((row) =>
    row.conditionId === conditionId &&
    actionBearing(row) &&
    row.metrics.semanticSuccess < (contentByScenario.get(row.scenarioId) ?? 0)
  ).length;
  const associationByScenario = new Map(rows.filter((row) => row.conditionId === "association-raw")
    .map((row) => [row.scenarioId, row.metrics.semanticSuccess]));
  const checkpointRows = rows.filter((row) => row.conditionId === "checkpoint-only");
  const checkpointPairedLosses = checkpointRows.filter((row) =>
    row.metrics.semanticSuccess < (associationByScenario.get(row.scenarioId) ?? 0)
  ).length;
  const componentSuccess = new Map(rows.filter((row) =>
    row.conditionId === "association-raw" || row.conditionId === "checkpoint-only"
  ).map((row) => [`${row.scenarioId}/${row.conditionId}`, row.metrics.semanticSuccess]));
  const compositionRescues = rows.filter((row) =>
    row.conditionId === "checkpoint-association" &&
    actionBearing(row) &&
    row.metrics.semanticSuccess === 1 &&
    componentSuccess.get(`${row.scenarioId}/association-raw`) === 0 &&
    componentSuccess.get(`${row.scenarioId}/checkpoint-only`) === 0
  ).length;
  const compositionLosses = rows.filter((row) =>
    row.conditionId === "checkpoint-association" &&
    actionBearing(row) &&
    row.metrics.semanticSuccess < Math.max(
      componentSuccess.get(`${row.scenarioId}/association-raw`) ?? 0,
      componentSuccess.get(`${row.scenarioId}/checkpoint-only`) ?? 0,
    )
  ).length;
  const successfulRaw = rawRows.filter((row) => row.httpStatus === 200 && row.failureKind === null);
  const strictStreamCoverage = successfulRaw.length === 0 ? 0 : mean(successfulRaw.map((row) =>
    Number(row.request.stream === true &&
      row.streamEvidence?.usageEventCount === 1 &&
      row.streamEvidence?.doneCount === 1)
  ));
  const finalAttempts = [...new Map(rawRows.map((row) => [row.logicalCallIndex, row])).values()];
  const infrastructureFailures = finalAttempts.filter((row) =>
    row.failureKind !== null && row.failureKind !== "content-or-schema"
  ).length;
  const disabledReasoningDeviations = successfulRaw.filter((row) => row.reasoningPresent).length;
  const complete = rows.length === 64 &&
    new Set(rows.map((row) => row.caseId)).size === 64 &&
    new Set(rawRows.map((row) => row.logicalCallIndex)).size === 64;
  const thresholds = preregistration.minimumEffectiveDifference;
  const guardrailPass = (conditionId) => {
    const value = byCondition[conditionId];
    return value.falseResume <= thresholds.falseResumeMaximum &&
      value.obsoleteActionUse <= thresholds.obsoleteActionUseMaximum &&
      value.invalidOrUnrelatedCitation <= thresholds.invalidOrUnrelatedCitationMaximum &&
      value.malformed === 0;
  };
  const associationPass = byCondition["association-raw"].actionBearingSuccesses >=
      thresholds.actionBearingRequiredSuccesses &&
    pairedActionBearingImprovements("association-raw") >=
      thresholds.pairedActionBearingImprovementsOverContent &&
    pairedActionBearingLosses("association-raw") <= thresholds.pairedActionBearingLossesMaximum &&
    guardrailPass("association-raw");
  const checkpointFamilyPass = [...new Set(checkpointRows.map((row) => row.family))].every((family) =>
    checkpointRows.filter((row) => row.family === family && actionBearing(row))
      .every((row) => row.metrics.semanticSuccess === 1)
  );
  const associationBytes = byCondition["association-raw"].evidenceBytes;
  const checkpointBytes = byCondition["checkpoint-only"].evidenceBytes;
  const checkpointCompressionPass =
    checkpointBytes.median <= associationBytes.median *
      (1 - thresholds.checkpointMinimumEvidenceReduction) ||
    checkpointBytes.p95 <= associationBytes.p95 *
      (1 - thresholds.checkpointMinimumEvidenceReduction);
  const checkpointPass = checkpointPairedLosses <= thresholds.checkpointPairedLossesMaximum &&
    checkpointFamilyPass &&
    guardrailPass("checkpoint-only") &&
    checkpointCompressionPass;
  const compositionP95Ratio = associationBytes.p95 === 0
    ? Number.POSITIVE_INFINITY
    : byCondition["checkpoint-association"].evidenceBytes.p95 / associationBytes.p95;
  const compositionPass = compositionRescues >= thresholds.compositionMinimumUniqueRescues &&
    compositionLosses <= thresholds.compositionPairedLossesMaximum &&
    compositionP95Ratio <= thresholds.compositionMaximumP95EvidenceRatio &&
    guardrailPass("checkpoint-association");
  const evidenceValid = complete &&
    infrastructureFailures === 0 &&
    disabledReasoningDeviations === 0 &&
    strictStreamCoverage === 1;
  return {
    byCondition,
    pairedActionBearingImprovements: Object.fromEntries(CONDITION_IDS.map((id) => [
      id,
      pairedActionBearingImprovements(id),
    ])),
    pairedActionBearingLosses: Object.fromEntries(CONDITION_IDS.map((id) => [
      id,
      pairedActionBearingLosses(id),
    ])),
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
      automaticResume: evidenceValid && CONDITION_IDS.every(guardrailPass)
        ? "not-authorized-by-private-fixture"
        : "disabled-by-guardrail-or-incomplete-run",
    },
    classification: evidenceValid ? "complete-exploratory-confirmation" : "inconclusive",
  };
}

export function executionPlan(dataset, seed) {
  return fisherYates(
    dataset.flatMap((scenario) => CONDITION_IDS.map((conditionId) => ({
      scenarioId: scenario.scenarioId,
      conditionId,
    }))),
    seed,
  );
}
