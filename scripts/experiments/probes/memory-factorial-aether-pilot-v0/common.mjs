import {
  evaluateLocalCondition,
  fisherYates,
  generateCase,
  sha256,
  stableJson,
} from '../memory-association-task-switch-v0/common.mjs';

export const EXPERIMENT_ID = 'memory-factorial-aether-pilot-v0';
export const EXPERIMENT_VERSION = 1;
export const ALGORITHM_VERSION = 'memory-factorial-aether-pilot/v1';
export const SEEDS = Object.freeze([401, 402, 403, 404, 405, 406, 407, 408]);
export const CELL_IDS = Object.freeze([
  'content-none',
  'association-none',
  'content-extractive',
  'association-extractive',
  'content-generated',
  'association-generated',
]);

export const CELL_FACTORS = Object.freeze({
  'content-none': Object.freeze({ association: 'off', checkpoint: 'none' }),
  'association-none': Object.freeze({ association: 'on', checkpoint: 'none' }),
  'content-extractive': Object.freeze({ association: 'off', checkpoint: 'extractive' }),
  'association-extractive': Object.freeze({ association: 'on', checkpoint: 'extractive' }),
  'content-generated': Object.freeze({ association: 'off', checkpoint: 'generated' }),
  'association-generated': Object.freeze({ association: 'on', checkpoint: 'generated' }),
});

export { fisherYates, sha256, stableJson };

export function makeScenario(seed) {
  if (!SEEDS.includes(seed)) throw new Error(`Unregistered scenario seed ${seed}`);
  return generateCase(seed, 'evaluation');
}

export function datasetRow(scenario) {
  return {
    schemaVersion: 'memory-factorial-aether-pilot/dataset-v1',
    seed: scenario.seed,
    split: scenario.split,
    project: scenario.project,
    interruptProject: scenario.interruptProject,
    records: scenario.records,
    activeContext: scenario.activeContext,
    query: scenario.query,
    groundTruth: scenario.groundTruth,
  };
}

export function evidencePacket(scenario, association) {
  if (!['off', 'on'].includes(association)) throw new TypeError('association must be off or on');
  const condition = association === 'on'
    ? 'normalized-content-position-recurrence'
    : 'normalized-content';
  const result = evaluateLocalCondition(scenario, 'after-learning', condition);
  return result.evidence.map((entry) => {
    const source = scenario.records.find((record) => record.id === entry.id);
    if (!source) throw new Error(`Evidence record ${entry.id} is missing`);
    return {
      id: source.id,
      text: source.text,
      role: source.role,
      eligible: source.relevant,
      rank: entry.rank,
      contentScore: entry.contentScore,
      associationScore: entry.associationScore,
      source: entry.source,
    };
  });
}

function firstMatch(packet, pattern) {
  for (const record of packet) {
    const match = record.text.match(pattern);
    if (match) return { record, match };
  }
  return null;
}

export function extractCheckpoint(packet) {
  const task = firstMatch(
    packet,
    /^(\S+) invoice importer parsing is complete\. Next action: add an idempotency guard with key (idem-[a-zA-Z0-9-]+) because duplicate deliveries were observed\.$/u,
  );
  const retention = firstMatch(
    packet,
    /^(?:Retain rejected rows for|Failed entries must be kept for) ([0-9]+) days (?:so operators can inspect failures|for operator review)\.$/u,
  );
  const sourceRecordIds = [];
  if (task) sourceRecordIds.push(task.record.id);
  if (retention) sourceRecordIds.push(retention.record.id);
  return {
    taskId: task?.match[1] ?? null,
    status: task ? 'active' : null,
    completedStep: task ? 'invoice importer parsing' : null,
    action: task ? 'add an idempotency guard' : null,
    actionArguments: { idempotencyKey: task?.match[2] ?? null },
    constraints: { retentionDays: retention ? Number(retention.match[1]) : null },
    sourceRecordIds,
  };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function parseStrictObject(content) {
  if (typeof content !== 'string' || content.trim() === '') throw new Error('response content is empty');
  const value = JSON.parse(content);
  if (!plainObject(value)) throw new Error('response content is not one JSON object');
  return value;
}

export function validateCheckpoint(value, packet) {
  const topKeys = ['taskId', 'status', 'completedStep', 'action', 'actionArguments', 'constraints', 'sourceRecordIds'];
  if (!exactKeys(value, topKeys)) throw new Error('checkpoint keys mismatch');
  if (!exactKeys(value.actionArguments, ['idempotencyKey'])) throw new Error('checkpoint actionArguments keys mismatch');
  if (!exactKeys(value.constraints, ['retentionDays'])) throw new Error('checkpoint constraints keys mismatch');
  for (const key of ['taskId', 'status', 'completedStep', 'action']) {
    if (value[key] !== null && typeof value[key] !== 'string') throw new Error(`checkpoint ${key} type mismatch`);
  }
  if (value.actionArguments.idempotencyKey !== null && typeof value.actionArguments.idempotencyKey !== 'string') {
    throw new Error('checkpoint idempotencyKey type mismatch');
  }
  if (value.constraints.retentionDays !== null && !Number.isSafeInteger(value.constraints.retentionDays)) {
    throw new Error('checkpoint retentionDays type mismatch');
  }
  if (!Array.isArray(value.sourceRecordIds) || new Set(value.sourceRecordIds).size !== value.sourceRecordIds.length) {
    throw new Error('checkpoint sourceRecordIds mismatch');
  }
  const allowed = new Set(packet.map((record) => record.id));
  if (value.sourceRecordIds.some((id) => typeof id !== 'string' || !allowed.has(id))) {
    throw new Error('checkpoint cites a record outside its evidence packet');
  }
  return value;
}

export function checkpointMessages(packet) {
  return [
    {
      role: 'system',
      content: 'You construct a bounded task checkpoint from synthetic records. Use only supplied records. Keep internal analysis under 200 words and reserve budget for the final answer. Return exactly one JSON object with the requested keys, no markdown or prose. Use null for every unsupported field and cite only supplied record IDs.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: 'Construct the current task checkpoint. Do not infer a cause or value that is not explicit in a cited record.',
        outputSchema: {
          taskId: 'string|null',
          status: 'active|null',
          completedStep: 'string|null',
          action: 'string|null',
          actionArguments: { idempotencyKey: 'string|null' },
          constraints: { retentionDays: 'integer|null' },
          sourceRecordIds: ['string'],
        },
        records: packet.map(({ id, text }) => ({ id, text })),
      }),
    },
  ];
}

export function evidenceForCell(scenario, cellId, checkpoints) {
  const factors = CELL_FACTORS[cellId];
  if (!factors) throw new Error(`Unknown cell ${cellId}`);
  const records = evidencePacket(scenario, factors.association);
  const evidence = records.map(({ id, text, role, eligible }) => ({
    id,
    kind: 'raw-record',
    text,
    role,
    eligible,
    sourceRecordIds: [id],
  }));
  if (factors.checkpoint !== 'none') {
    const checkpoint = checkpoints[`${scenario.seed}/${factors.association}/${factors.checkpoint}`];
    if (checkpoint) {
      evidence.unshift({
        id: `checkpoint-${scenario.seed}-${factors.association}-${factors.checkpoint}`,
        kind: `${factors.checkpoint}-checkpoint`,
        text: stableJson(checkpoint),
        role: 'derived-checkpoint',
        eligible: true,
        sourceRecordIds: checkpoint.sourceRecordIds,
      });
    }
  }
  return evidence;
}

export function agentMessages(scenario, evidence) {
  return [
    {
      role: 'system',
      content: 'You are a general task Agent resuming work after an unrelated interruption. Use only active context and the supplied synthetic memory evidence. Return exactly one JSON object with exactly the requested keys, no markdown or prose. Cite underlying raw source record IDs, never a derived checkpoint ID. If evidence is insufficient, use null for unsupported values, set uncertain=true, and do not guess.',
    },
    ...scenario.activeContext.map(({ role, text }) => ({ role, content: text })),
    {
      role: 'user',
      content: JSON.stringify({
        memoryEvidence: evidence,
        outputSchema: {
          decision: 'resume|abstain',
          taskId: 'string|null',
          action: 'string|null',
          actionArguments: { idempotencyKey: 'string|null' },
          constraints: { retentionDays: 'integer|null' },
          usedEvidenceIds: ['string'],
          uncertain: 'boolean',
        },
      }),
    },
  ];
}

export function validateAgentOutput(value) {
  const topKeys = ['decision', 'taskId', 'action', 'actionArguments', 'constraints', 'usedEvidenceIds', 'uncertain'];
  if (!exactKeys(value, topKeys)) throw new Error('Agent keys mismatch');
  if (!['resume', 'abstain'].includes(value.decision)) throw new Error('Agent decision mismatch');
  if (value.taskId !== null && typeof value.taskId !== 'string') throw new Error('Agent taskId mismatch');
  if (value.action !== null && typeof value.action !== 'string') throw new Error('Agent action mismatch');
  if (!exactKeys(value.actionArguments, ['idempotencyKey'])) throw new Error('Agent actionArguments mismatch');
  if (value.actionArguments.idempotencyKey !== null && typeof value.actionArguments.idempotencyKey !== 'string') {
    throw new Error('Agent idempotencyKey mismatch');
  }
  if (!exactKeys(value.constraints, ['retentionDays'])) throw new Error('Agent constraints mismatch');
  if (value.constraints.retentionDays !== null && !Number.isSafeInteger(value.constraints.retentionDays)) {
    throw new Error('Agent retentionDays mismatch');
  }
  if (!Array.isArray(value.usedEvidenceIds) || value.usedEvidenceIds.some((id) => typeof id !== 'string')) {
    throw new Error('Agent usedEvidenceIds mismatch');
  }
  if (new Set(value.usedEvidenceIds).size !== value.usedEvidenceIds.length) throw new Error('Agent duplicate evidence IDs');
  if (typeof value.uncertain !== 'boolean') throw new Error('Agent uncertain mismatch');
  return value;
}

export function scoreCheckpoint(checkpoint, scenario) {
  const truth = scenario.groundTruth;
  const citations = new Set(checkpoint?.sourceRecordIds ?? []);
  const requiredSources = [truth.expectedCheckpointId, ...truth.expectedConstraintIds];
  const fields = {
    taskId: Number(checkpoint?.taskId === truth.taskId),
    status: Number(checkpoint?.status === 'active'),
    completedStep: Number(checkpoint?.completedStep === 'invoice importer parsing'),
    action: Number(checkpoint?.action === truth.nextAction),
    idempotencyKey: Number(checkpoint?.actionArguments?.idempotencyKey === truth.idempotencyKey),
    retentionDays: Number(checkpoint?.constraints?.retentionDays === truth.retentionDays),
  };
  const invalidCitations = [...citations].filter((id) => !scenario.records.some((record) => record.id === id)).length;
  const requiredCitationRecall = requiredSources.filter((id) => citations.has(id)).length / requiredSources.length;
  return {
    fields,
    fieldAccuracy: Object.values(fields).reduce((sum, value) => sum + value, 0) / Object.keys(fields).length,
    invalidCitations,
    requiredCitationRecall,
  };
}

export function scoreAgent(output, scenario, evidence) {
  if (!output) {
    return {
      groundedResumeSuccess: 0,
      fields: { decision: 0, taskId: 0, action: 0, idempotencyKey: 0, retentionDays: 0 },
      invalidCitations: 0,
      unrelatedRecordUse: 0,
      requiredCitationRecall: 0,
      malformed: true,
    };
  }
  const truth = scenario.groundTruth;
  const used = new Set(output.usedEvidenceIds);
  const allowed = new Set(evidence.flatMap((entry) => entry.sourceRecordIds));
  const required = [truth.expectedCheckpointId, ...truth.expectedConstraintIds];
  const fields = {
    decision: Number(output.decision === 'resume' && output.uncertain === false),
    taskId: Number(output.taskId === truth.taskId),
    action: Number(output.action === truth.nextAction),
    idempotencyKey: Number(output.actionArguments.idempotencyKey === truth.idempotencyKey),
    retentionDays: Number(output.constraints.retentionDays === truth.retentionDays),
  };
  const invalidCitations = [...used].filter((id) => !allowed.has(id)).length;
  const unrelatedRecordUse = Number(truth.forbiddenIds.some((id) => used.has(id)));
  const requiredCitationRecall = required.filter((id) => used.has(id)).length / required.length;
  const groundedResumeSuccess = Number(
    Object.values(fields).every((value) => value === 1)
      && invalidCitations === 0
      && unrelatedRecordUse === 0
      && requiredCitationRecall === 1,
  );
  return {
    groundedResumeSuccess,
    fields,
    invalidCitations,
    unrelatedRecordUse,
    requiredCitationRecall,
    malformed: false,
  };
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function analyzeCases(rows, checkpointRows, rawRows) {
  const byCell = {};
  for (const cellId of CELL_IDS) {
    const selected = rows.filter((row) => row.cellId === cellId);
    byCell[cellId] = {
      rows: selected.length,
      groundedResumeSuccess: mean(selected.map((row) => row.metrics.groundedResumeSuccess)),
      malformedResponseRate: mean(selected.map((row) => Number(row.metrics.malformed))),
      unrelatedRecordUse: mean(selected.map((row) => row.metrics.unrelatedRecordUse)),
      evidenceBytes: selected.map((row) => row.evidenceBytes),
    };
  }
  const value = (cellId) => byCell[cellId].groundedResumeSuccess;
  const checkpointMainEffect = mean([
    value('content-extractive'), value('association-extractive'),
    value('content-generated'), value('association-generated'),
  ]) - mean([value('content-none'), value('association-none')]);
  const associationMainEffect = mean([
    value('association-none') - value('content-none'),
    value('association-extractive') - value('content-extractive'),
    value('association-generated') - value('content-generated'),
  ]);
  const checkpointAssociationInteraction = mean([
    value('association-extractive') - value('content-extractive'),
    value('association-generated') - value('content-generated'),
  ]) - (value('association-none') - value('content-none'));
  const extractiveMinusGenerated = mean([
    value('content-extractive'), value('association-extractive'),
  ]) - mean([value('content-generated'), value('association-generated')]);
  const successfulRaw = rawRows.filter((row) => row.httpStatus === 200 && row.failureKind === null);
  const strictStreamCoverage = successfulRaw.length === 0 ? 0 : mean(successfulRaw.map((row) => Number(
    row.request.stream === true
      && row.streamEvidence?.usageEventCount === 1
      && row.streamEvidence?.doneCount === 1,
  )));
  const invalidCitations = rows.reduce((sum, row) => sum + row.metrics.invalidCitations, 0)
    + checkpointRows.reduce((sum, row) => sum + row.metrics.invalidCitations, 0);
  const malformedLogicalCalls = new Set(rawRows.filter((row) => row.failureKind === 'content-or-schema').map((row) => row.logicalCallIndex)).size;
  const finalAttempts = [...new Map(rawRows.map((row) => [row.logicalCallIndex, row])).values()];
  const terminalInfrastructureFailures = finalAttempts.filter((row) =>
    row.failureKind !== null && row.failureKind !== 'content-or-schema'
  ).length;
  const integrity = {
    invalidCitations,
    unrelatedRecordUse: Math.max(...rows.map((row) => row.metrics.unrelatedRecordUse), 0),
    malformedResponseRate: malformedLogicalCalls / 64,
    terminalInfrastructureFailures,
    strictStreamCoverage,
  };
  const complete = rows.length === 48
    && checkpointRows.length === 32
    && new Set(rawRows.map((row) => row.logicalCallIndex)).size === 64;
  const valid = complete
    && invalidCitations === 0
    && integrity.unrelatedRecordUse === 0
    && integrity.malformedResponseRate <= 0.05
    && terminalInfrastructureFailures === 0
    && strictStreamCoverage === 1;
  return {
    byCell,
    effects: {
      checkpointMainEffect,
      associationMainEffect,
      checkpointAssociationInteraction,
      extractiveMinusGenerated,
    },
    factorDecisions: {
      checkpoint: valid && checkpointMainEffect >= 0.125 ? 'pilot-supported' : 'rejected-or-inconclusive',
      association: valid && associationMainEffect >= 0.125 ? 'pilot-supported' : 'rejected-or-inconclusive',
      composition: valid && checkpointAssociationInteraction >= 0.125 ? 'pilot-supported' : 'rejected-or-inconclusive',
      extractive: valid && extractiveMinusGenerated >= -0.125 ? 'pilot-noninferior' : 'rejected-or-inconclusive',
    },
    integrity,
    complete,
    classification: valid ? 'complete-exploratory-pilot' : 'inconclusive',
  };
}

export function executionPlan() {
  const checkpointCalls = fisherYates(
    SEEDS.flatMap((seed) => ['off', 'on'].map((association) => ({ kind: 'checkpoint', seed, association }))),
    0x43484b31,
  );
  const agentCalls = fisherYates(
    SEEDS.flatMap((seed) => CELL_IDS.map((cellId) => ({ kind: 'agent', seed, cellId }))),
    0x41475431,
  );
  return { checkpointCalls, agentCalls };
}
