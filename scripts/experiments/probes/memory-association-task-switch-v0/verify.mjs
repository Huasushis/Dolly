#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const preregistrationPath = path.join(repositoryRoot, 'docs/experiments/preregistrations/memory-association-task-switch-v0.json');
const artifactRoot = path.join(repositoryRoot, 'artifacts/experiments/probes/memory-association-task-switch-v0');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseArguments(argv) {
  const options = { artifactDirectory: null, write: true };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--artifact-dir') options.artifactDirectory = argv[++index];
    else if (argv[index] === '--no-write') options.write = false;
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!options.artifactDirectory) throw new Error('--artifact-dir is required');
  const resolved = path.resolve(repositoryRoot, options.artifactDirectory);
  const relative = path.relative(artifactRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('artifact directory must remain under the experiment artifact root');
  options.artifactDirectory = resolved;
  return options;
}

function parseJsonLines(bytes, filename, errors) {
  if (bytes.length === 0) return [];
  const lines = bytes.toString('utf8').split('\n');
  if (lines.at(-1) !== '') errors.push(`${filename} must end with one newline`);
  lines.pop();
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      errors.push(`${filename}:${index + 1} is not valid JSON: ${error.message}`);
      return null;
    }
  }).filter(Boolean);
}

function parseDotEnv(bytes) {
  const values = [];
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(AETHER_BASE_URL|AETHER_API_KEY)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value.length >= 6) values.push(value);
  }
  return values;
}

function recomputeMetrics(row) {
  const evidenceIds = new Set(row.evidence.flatMap((item) => [item.id, ...(item.citedIds ?? [])]));
  const checkpointIndex = row.evidence.findIndex((item) => item.id === row.groundTruth.expectedCheckpointId || item.citedIds?.includes(row.groundTruth.expectedCheckpointId));
  const constraintPresent = row.groundTruth.expectedConstraintIds.some((id) => evidenceIds.has(id));
  const forbiddenUsed = row.groundTruth.forbiddenIds.some((id) => evidenceIds.has(id));
  const activeContextLeakage = row.activeContextIds.filter((id) => row.retainedRecordIds.includes(id)).length;
  return {
    localEvidenceSuccess: Number(checkpointIndex >= 0 && constraintPresent && !forbiddenUsed),
    checkpointReciprocalRank: checkpointIndex >= 0 ? 1 / (checkpointIndex + 1) : 0,
    unrelatedRecordUse: Number(forbiddenUsed),
    activeContextLeakage,
  };
}

function summarize(rows) {
  const evaluation = rows.filter((row) => row.backend === 'local-deterministic' && row.split === 'evaluation');
  const byConditionPhase = {};
  for (const row of evaluation) {
    const key = `${row.phase}/${row.conditionId}`;
    if (!byConditionPhase[key]) byConditionPhase[key] = { rows: 0, localEvidenceSuccess: 0, checkpointReciprocalRank: 0, unrelatedRecordUse: 0 };
    const aggregate = byConditionPhase[key];
    aggregate.rows += 1;
    aggregate.localEvidenceSuccess += row.metrics.localEvidenceSuccess;
    aggregate.checkpointReciprocalRank += row.metrics.checkpointReciprocalRank;
    aggregate.unrelatedRecordUse += row.metrics.unrelatedRecordUse;
  }
  for (const aggregate of Object.values(byConditionPhase)) {
    for (const metric of ['localEvidenceSuccess', 'checkpointReciprocalRank', 'unrelatedRecordUse']) aggregate[metric] /= aggregate.rows;
  }
  const success = (condition) => byConditionPhase[`after-learning/${condition}`]?.localEvidenceSuccess ?? 0;
  const effects = {
    positionVersusContent: success('normalized-content-position-recurrence') - success('normalized-content'),
    positionVersusNoPosition: success('normalized-content-position-recurrence') - success('normalized-content-recurrence-no-position'),
    positionVersusShuffled: success('normalized-content-position-recurrence') - success('normalized-content-position-shuffled'),
    recurrenceVersusSingle: success('normalized-content-position-recurrence') - success('normalized-content-position-single-observation'),
  };
  const repeatGroups = new Map();
  for (const row of rows.filter((candidate) => candidate.backend === 'local-deterministic')) {
    const key = `${row.split}/${row.seed}/${row.phase}/${row.conditionId}`;
    if (!repeatGroups.has(key)) repeatGroups.set(key, []);
    repeatGroups.get(key).push(sha256(stableJson({ evidence: row.evidence, metrics: row.metrics })));
  }
  const groups = [...repeatGroups.values()];
  const repeatDeterminism = groups.length === 0 ? 0 : groups.filter((hashes) => hashes.length === 3 && new Set(hashes).size === 1).length / groups.length;
  return { byConditionPhase, effects, repeatDeterminism };
}

function equalNumber(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-12;
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function mean(rows, key) {
  return rows.reduce((sum, row) => sum + row.metrics[key], 0) / rows.length;
}

function pairedBootstrap(deltas, repetitions = 10_000) {
  const next = xorshift32(0x4d454d30);
  const values = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    let sum = 0;
    for (let index = 0; index < deltas.length; index += 1) sum += deltas[next() % deltas.length];
    values.push(sum / deltas.length);
  }
  values.sort((left, right) => left - right);
  return { repetitions, lower95: values[Math.floor(0.025 * repetitions)], upper95: values[Math.floor(0.975 * repetitions)] };
}

function recomputeLiveMetric(row) {
  const value = row.agentOutput;
  const required = ['taskId', 'nextAction', 'idempotencyKey', 'retentionDays', 'usedEvidenceIds', 'uncertain'];
  if (value === null || Array.isArray(value) || typeof value !== 'object'
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(required.sort())
      || !Array.isArray(value.usedEvidenceIds)) {
    return { taskResumeSuccess: 0, unrelatedRecordUse: 0, malformed: true };
  }
  const used = new Set(value.usedEvidenceIds);
  const truth = row.groundTruth;
  const checkpoint = used.has(truth.expectedCheckpointId);
  const constraint = truth.expectedConstraintIds.some((id) => used.has(id));
  const unrelated = truth.forbiddenIds.some((id) => used.has(id));
  const exact = value.taskId === truth.taskId
    && value.nextAction === truth.nextAction
    && value.idempotencyKey === truth.idempotencyKey
    && value.retentionDays === truth.retentionDays
    && value.uncertain === false;
  return { taskResumeSuccess: Number(exact && checkpoint && constraint && !unrelated), unrelatedRecordUse: Number(unrelated), malformed: false };
}

function summarizeLive(liveRows, rawRows) {
  const conditions = [
    'no-memory',
    'exact-lexical-bm25',
    'sham-replay',
    'normalized-content',
    'normalized-content-position-recurrence',
    'normalized-content-position-shuffled',
    'normalized-content-temporal-neighbours',
    'explicit-task-checkpoint',
    'combined-memory',
  ];
  const select = (conditionId, phase) => liveRows.filter((row) => row.conditionId === conditionId && row.phase === phase);
  const combinedAfter = select('combined-memory', 'after-learning');
  const combinedBefore = select('combined-memory', 'before-learning');
  const normalizedAfter = select('normalized-content', 'after-learning');
  const bySeed = [301, 302].map((seed) => ({
    seed,
    combinedVsContent: combinedAfter.find((row) => row.seed === seed).metrics.taskResumeSuccess - normalizedAfter.find((row) => row.seed === seed).metrics.taskResumeSuccess,
    learningGain: combinedAfter.find((row) => row.seed === seed).metrics.taskResumeSuccess - combinedBefore.find((row) => row.seed === seed).metrics.taskResumeSuccess,
  }));
  return {
    byConditionPhase: Object.fromEntries(['before-learning', 'after-learning'].flatMap((phase) => conditions.map((conditionId) => {
      const rows = select(conditionId, phase);
      return [`${phase}/${conditionId}`, { rows: rows.length, taskResumeSuccess: mean(rows, 'taskResumeSuccess'), unrelatedRecordUse: mean(rows, 'unrelatedRecordUse') }];
    }))),
    primaryGain: bySeed.reduce((sum, row) => sum + row.combinedVsContent, 0) / bySeed.length,
    learningGain: bySeed.reduce((sum, row) => sum + row.learningGain, 0) / bySeed.length,
    bySeed,
    primaryBootstrap: pairedBootstrap(bySeed.map((row) => row.combinedVsContent)),
    combinedUnrelatedRecordUse: mean(combinedAfter, 'unrelatedRecordUse'),
    normalizedUnrelatedRecordUse: mean(normalizedAfter, 'unrelatedRecordUse'),
    reasoningObservationCoverage: rawRows.filter((row) => typeof row.reasoningPresent === 'boolean' && Number.isInteger(row.reasoningCharacterCount)).length / rawRows.length,
    reasoningPresentRate: rawRows.filter((row) => row.reasoningPresent).length / rawRows.length,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const errors = [];
  const warnings = [];
  let preregistrationBytes;
  let preregistrationSource;
  try {
    preregistrationBytes = await readFile(path.join(options.artifactDirectory, 'preregistration.json'));
    preregistrationSource = 'artifact-snapshot';
  } catch {
    preregistrationBytes = await readFile(preregistrationPath);
    preregistrationSource = 'working-tree';
  }
  const preregistration = JSON.parse(preregistrationBytes);
  const strictStreamRequired = preregistration.experimentVersion >= 10;
  if (strictStreamRequired) {
    const implementationFiles = preregistration.domainDesign.implementationFiles;
    if (!Array.isArray(implementationFiles) || implementationFiles.length < 5) {
      errors.push('version 10 requires frozen implementation file hashes');
    } else {
      for (const entry of implementationFiles) {
        try {
          const sourceBytes = await readFile(path.join(repositoryRoot, entry.path));
          if (sha256(sourceBytes) !== entry.sha256) {
            errors.push(`implementation source hash mismatch for ${entry.path}`);
          }
        } catch {
          errors.push(`implementation source is unavailable for ${entry.path}`);
        }
      }
    }
  }
  function expectedRequest(row) {
    return row.kind === 'agent'
      ? (preregistration.domainDesign.liveEndpointProfile.agentRequest ?? preregistration.domainDesign.liveEndpointProfile.request)
      : preregistration.domainDesign.liveEndpointProfile.request;
  }
  function requestMetadataMatches(row, expected) {
    return row.request?.model === 'qwen3.6-27b'
      && row.request?.thinking?.type === expected.thinking.type
      && row.request?.temperature === 0
      && row.request?.max_tokens === expected.max_tokens
      && (expected.timeout_ms === undefined || row.request?.timeout_ms === expected.timeout_ms)
      && (!strictStreamRequired || (
        row.request?.stream === true
        && stableJson(row.request?.stream_options) === stableJson({ include_usage: true })
      ));
  }
  function validateStrictStreamRow(row, index) {
    if (!strictStreamRequired || row.httpStatus !== 200) return;
    if (!Array.isArray(row.response?.choices)) {
      if (row.failureKind !== 'stream-protocol' && row.failureKind !== 'timeout') {
        errors.push(`HTTP 200 failure lacks a strict-stream failure kind at ${index}`);
      }
      if (row.streamEvidence !== null) errors.push(`failed strict stream carries success evidence at ${index}`);
      return;
    }
    const evidence = row.streamEvidence;
    if (
      !evidence
      || !/^text\/event-stream(?:\s*;|$)/iu.test(evidence.contentType ?? '')
      || !Number.isSafeInteger(evidence.responseBytes) || evidence.responseBytes <= 0
      || !Number.isSafeInteger(evidence.eventCount) || evidence.eventCount < 3
      || evidence.usageEventCount !== 1
      || evidence.doneCount !== 1
      || evidence.providerIdObserved !== true
    ) {
      errors.push(`strict stream evidence mismatch at ${index}`);
    }
  }
  const filenames = ['run-manifest.json', 'cases.jsonl', 'model-raw.jsonl', 'analysis.json', 'sha256sums.txt'];
  if (preregistrationSource === 'artifact-snapshot') filenames.push('preregistration.json');
  const bytesByFile = new Map();
  for (const filename of filenames) bytesByFile.set(filename, await readFile(path.join(options.artifactDirectory, filename)));
  const manifest = JSON.parse(bytesByFile.get('run-manifest.json'));
  const analysis = JSON.parse(bytesByFile.get('analysis.json'));
  const cases = parseJsonLines(bytesByFile.get('cases.jsonl'), 'cases.jsonl', errors);
  const modelRows = parseJsonLines(bytesByFile.get('model-raw.jsonl'), 'model-raw.jsonl', errors);

  if (manifest.experimentId !== preregistration.experimentId || manifest.experimentVersion !== preregistration.experimentVersion) errors.push('manifest experiment identity mismatch');
  if (manifest.preregistrationSha256 !== sha256(preregistrationBytes)) errors.push('manifest preregistration checksum mismatch');
  if (manifest.protocolSha256 !== preregistration.protocol.sha256) errors.push('manifest protocol checksum mismatch');

  const checksumLines = bytesByFile.get('sha256sums.txt').toString('utf8').trimEnd().split('\n');
  const declaredChecksums = new Map();
  for (const line of checksumLines) {
    const match = line.match(/^([a-f0-9]{64})  ([a-z0-9.-]+)$/);
    if (!match) errors.push(`malformed checksum line: ${line}`);
    else declaredChecksums.set(match[2], match[1]);
  }
  for (const filename of ['run-manifest.json', 'cases.jsonl', 'model-raw.jsonl', 'analysis.json']) {
    if (declaredChecksums.get(filename) !== sha256(bytesByFile.get(filename))) errors.push(`${filename} checksum mismatch`);
  }
  if (preregistrationSource === 'artifact-snapshot' && declaredChecksums.has('preregistration.json') && declaredChecksums.get('preregistration.json') !== sha256(preregistrationBytes)) errors.push('preregistration.json checksum mismatch');

  const conditions = [...preregistration.conditions.baselines, ...preregistration.conditions.treatments].map((condition) => condition.id);
  const expectedLocalIds = new Set();
  for (const split of ['training', 'development', 'evaluation']) {
    for (const seed of preregistration.data[split].seeds) {
      for (const phase of ['before-learning', 'after-learning']) {
        for (const conditionId of conditions) {
          for (let repetition = 1; repetition <= 3; repetition += 1) expectedLocalIds.add(`${split}-${seed}-${phase}-${conditionId}-r${repetition}`);
        }
      }
    }
  }
  const localRows = cases.filter((row) => row.backend === 'local-deterministic');
  const observedIds = new Set();
  for (const row of localRows) {
    if (observedIds.has(row.caseId)) errors.push(`duplicate caseId ${row.caseId}`);
    observedIds.add(row.caseId);
    if (!expectedLocalIds.has(row.caseId)) errors.push(`unexpected local caseId ${row.caseId}`);
    if (!conditions.includes(row.conditionId)) errors.push(`unexpected condition ${row.conditionId}`);
    if (row.evidence.length > 8) errors.push(`${row.caseId} exceeds bounded evidence entries`);
    for (const evidence of row.evidence) {
      for (const key of ['score', 'contentScore', 'associationScore']) {
        if (!Number.isFinite(evidence[key])) errors.push(`${row.caseId} has non-finite ${key}`);
      }
    }
    const expectedMetrics = recomputeMetrics(row);
    for (const [metric, expected] of Object.entries(expectedMetrics)) {
      if (!equalNumber(row.metrics[metric], expected)) errors.push(`${row.caseId} metric mismatch for ${metric}`);
    }
    if (stableJson([...new Set(row.evidence.flatMap((item) => [item.id, ...(item.citedIds ?? [])]))]) !== stableJson(row.evidenceIds)) {
      errors.push(`${row.caseId} evidenceIds mismatch`);
    }
  }
  if (localRows.length !== expectedLocalIds.size) errors.push(`expected ${expectedLocalIds.size} local rows, got ${localRows.length}`);
  for (const caseId of expectedLocalIds) if (!observedIds.has(caseId)) errors.push(`missing local caseId ${caseId}`);

  const recomputed = summarize(localRows);
  if (stableJson(recomputed) !== stableJson(analysis.local)) errors.push('analysis.local does not match independently recomputed aggregates');
  if (recomputed.repeatDeterminism !== 1) errors.push(`repeat determinism is ${recomputed.repeatDeterminism}, expected 1`);
  if (localRows.some((row) => row.metrics.activeContextLeakage !== 0)) errors.push('active context leakage is non-zero');

  const liveRows = cases.filter((row) => row.backend === 'owner-aether-qwen36');
  const retryDetails = preregistration.domainDesign.liveEndpointProfile.retryPolicy ?? null;
  const attemptGroups = new Map();
  const terminalAttemptIndexes = new Set();
  function isRetryableAttempt(row) {
    return row.httpStatus === null
      ? (strictStreamRequired
          ? ['timeout', 'network-before-response-headers'].includes(row.failureKind)
          : ['timeout', 'network-or-json'].includes(row.failureKind))
      : [408, 425, 429].includes(row.httpStatus) || row.httpStatus >= 500;
  }
  if (retryDetails) {
    for (let index = 0; index < modelRows.length; index += 1) {
      const row = modelRows[index];
      if (!Number.isInteger(row.logicalCallIndex) || row.logicalCallIndex < 0 || row.logicalCallIndex >= 38) errors.push(`invalid logical call index at request attempt ${index}`);
      if (!Number.isInteger(row.attemptIndex) || row.attemptIndex < 1 || row.attemptIndex > retryDetails.maxAttemptsPerLogicalCall) errors.push(`invalid attempt index at request attempt ${index}`);
      const group = attemptGroups.get(row.logicalCallIndex) ?? [];
      group.push(row);
      attemptGroups.set(row.logicalCallIndex, group);
    }
    for (const [logicalIndex, group] of attemptGroups) {
      for (let index = 0; index < group.length; index += 1) {
        if (group[index].attemptIndex !== index + 1) errors.push(`non-contiguous attempt sequence for logical call ${logicalIndex}`);
        if (index < group.length - 1 && !isRetryableAttempt(group[index])) errors.push(`non-retryable response was retried for logical call ${logicalIndex}`);
      }
      terminalAttemptIndexes.add(group.at(-1).callIndex);
    }
  } else {
    for (const row of modelRows) terminalAttemptIndexes.add(row.callIndex);
  }
  if (manifest.backend === 'local-deterministic') {
    if (modelRows.length !== 0) errors.push('local-only run must have zero model rows');
    if (cases.length !== 1872) errors.push(`local-only run must have 1872 cases, got ${cases.length}`);
    if (analysis.classification !== 'inconclusive') errors.push('local-only run must remain inconclusive');
    warnings.push('Live pilot not present; product and live-Agent efficacy claims remain unsupported.');
  } else if (manifest.backend === 'local-deterministic+owner-aether-qwen36' && manifest.failure !== null) {
    if (cases.length !== 1872 || liveRows.length !== 0) errors.push('aborted full run must retain exactly the complete local rows and no synthesized live Agent rows');
    if (analysis.classification !== 'inconclusive' || analysis.live !== null) errors.push('aborted full run analysis must remain inconclusive with no live aggregate');
    const interruptedBeforeRawResponse = manifest.failure.code === 'process-interrupted-before-raw-response';
    if (!retryDetails && manifest.failure.retryPerformed !== false) errors.push('aborted run must not retry a live call');
    if (interruptedBeforeRawResponse) {
      if (modelRows.length !== 0
          || manifest.failure.stoppedAfterPersistedLiveResponses !== 0
          || manifest.failure.requestMayHaveLeftHost !== true
          || manifest.failure.requestCompletionObserved !== false) {
        errors.push('interrupted run response accounting mismatch');
      }
    } else {
      if (retryDetails) {
        if (manifest.failure.persistedRequestAttempts !== modelRows.length
            || manifest.failure.stoppedAfterLogicalLiveCalls !== attemptGroups.size
            || manifest.failure.retryPerformed !== modelRows.some((row) => row.attemptIndex > 1)) {
          errors.push('aborted retry accounting mismatch');
        }
        if (modelRows.length < 1 || modelRows.length > retryDetails.maxRequestAttempts) errors.push('aborted run request-attempt count outside bounds');
        const logicalIndexes = [...attemptGroups.keys()].sort((left, right) => left - right);
        if (logicalIndexes.some((value, index) => value !== index)) errors.push('aborted logical call sequence is not contiguous');
        for (const logicalIndex of logicalIndexes.slice(0, -1)) {
          const terminal = attemptGroups.get(logicalIndex).at(-1);
          if (terminal.httpStatus !== 200 || !Array.isArray(terminal.response?.choices)) errors.push(`completed logical call ${logicalIndex} lacks a terminal response`);
        }
      } else {
        if (manifest.failure.stoppedAfterLiveCalls !== modelRows.length) errors.push('aborted run failure accounting mismatch');
        if (modelRows.length < 1 || modelRows.length > 38) errors.push('aborted run model row count outside bounds');
      }
    }
    for (let index = 0; index < modelRows.length; index += 1) {
      const row = modelRows[index];
      if (row.callIndex !== index) errors.push(`aborted model raw call index mismatch at ${index}`);
      const expected = expectedRequest(row);
      if (!requestMetadataMatches(row, expected)) errors.push(`aborted model request metadata mismatch at ${index}`);
      if ('enable_thinking' in (row.request ?? {})) errors.push(`forbidden enable_thinking at aborted call ${index}`);
      validateStrictStreamRow(row, index);
      const reasoning = row.response?.choices?.[0]?.message?.reasoning_content;
      const reasoningText = typeof reasoning === 'string' ? reasoning : '';
      if (row.reasoningPresent !== (reasoningText.trim().length > 0) || row.reasoningCharacterCount !== reasoningText.length) errors.push(`aborted reasoning observation mismatch at ${index}`);
    }
    warnings.push(interruptedBeforeRawResponse
      ? 'The process disappeared before a response row was persisted; whether the request reached Aether is unknown. No efficacy conclusion is available.'
      : `Run stopped by preregistered rule: ${manifest.failure.code}. No efficacy conclusion is available.`);
  } else if (manifest.backend === 'local-deterministic+owner-aether-qwen36') {
    const minimumAttempts = 38;
    const maximumAttempts = retryDetails?.maxRequestAttempts ?? 38;
    if (cases.length !== 1908 || liveRows.length !== 36 || modelRows.length < minimumAttempts || modelRows.length > maximumAttempts) errors.push(`full run count mismatch cases/live/raw=${cases.length}/${liveRows.length}/${modelRows.length}`);
    if (retryDetails) {
      if (attemptGroups.size !== 38) errors.push(`expected 38 logical calls, got ${attemptGroups.size}`);
      for (let logicalIndex = 0; logicalIndex < 38; logicalIndex += 1) {
        const terminal = attemptGroups.get(logicalIndex)?.at(-1);
        if (!terminal || terminal.httpStatus !== 200 || !Array.isArray(terminal.response?.choices)) errors.push(`logical call ${logicalIndex} lacks a terminal response`);
      }
    }
    const expectedLiveIds = new Set();
    const liveConditions = preregistration.domainDesign.liveAgentConditions;
    for (const seed of [301, 302]) {
      for (const phase of ['before-learning', 'after-learning']) {
        for (const conditionId of liveConditions) expectedLiveIds.add(`evaluation-${seed}-${phase}-${conditionId}-live`);
      }
    }
    const seenLiveIds = new Set();
    for (const row of liveRows) {
      if (!expectedLiveIds.has(row.caseId)) errors.push(`unexpected live caseId ${row.caseId}`);
      if (seenLiveIds.has(row.caseId)) errors.push(`duplicate live caseId ${row.caseId}`);
      seenLiveIds.add(row.caseId);
      const expectedMetric = recomputeLiveMetric(row);
      if (stableJson(expectedMetric) !== stableJson(row.metrics)) errors.push(`${row.caseId} live metric mismatch`);
      const expectedEvidenceIds = [...new Set(row.evidence.flatMap((item) => [item.id, ...(item.citedIds ?? [])]))];
      if (stableJson(expectedEvidenceIds) !== stableJson(row.evidenceIds)) errors.push(`${row.caseId} live evidenceIds mismatch`);
      if (row.activeContextIds.some((id) => row.retainedRecordIds.includes(id))) errors.push(`${row.caseId} active context leak`);
      const raw = modelRows[row.modelCallIndex];
      if (!raw || raw.kind !== 'agent' || raw.seed !== row.seed || raw.phase !== row.phase || raw.conditionId !== row.conditionId) errors.push(`${row.caseId} model raw linkage mismatch`);
    }
    for (const caseId of expectedLiveIds) if (!seenLiveIds.has(caseId)) errors.push(`missing live caseId ${caseId}`);
    for (let index = 0; index < modelRows.length; index += 1) {
      const row = modelRows[index];
      if (row.callIndex !== index) errors.push(`model raw call index mismatch at ${index}`);
      const expected = expectedRequest(row);
      if (!requestMetadataMatches(row, expected)) errors.push(`model request metadata mismatch at ${index}`);
      if ('enable_thinking' in (row.request ?? {})) errors.push(`forbidden enable_thinking at ${index}`);
      validateStrictStreamRow(row, index);
      if (terminalAttemptIndexes.has(row.callIndex) && (row.httpStatus !== 200 || !Array.isArray(row.response?.choices))) errors.push(`terminal model response failure at ${index}`);
      if (!terminalAttemptIndexes.has(row.callIndex) && !isRetryableAttempt(row)) errors.push(`unapproved retry source at ${index}`);
      const reasoning = row.response?.choices?.[0]?.message?.reasoning_content;
      const reasoningText = typeof reasoning === 'string' ? reasoning : '';
      if (row.reasoningPresent !== (reasoningText.trim().length > 0) || row.reasoningCharacterCount !== reasoningText.length) errors.push(`reasoning observation mismatch at ${index}`);
    }
    const terminalRows = [...terminalAttemptIndexes].sort((left, right) => left - right).map((index) => modelRows[index]);
    const logicalKind = (logicalIndex) => retryDetails ? attemptGroups.get(logicalIndex)?.at(-1)?.kind : modelRows[logicalIndex]?.kind;
    if (logicalKind(0) !== 'learner' || logicalKind(19) !== 'learner') errors.push('learner logical call positions must be 0 and 19');
    if (terminalRows.filter((row) => row?.kind === 'learner').length !== 2 || terminalRows.filter((row) => row?.kind === 'agent').length !== 36) errors.push('learner/agent logical call counts mismatch');
    const recomputedLive = summarizeLive(liveRows, modelRows);
    if (stableJson(recomputedLive) !== stableJson(analysis.live)) errors.push('analysis.live does not match independently recomputed aggregates');
    const localEffectsPass = recomputed.effects.positionVersusContent >= 0.2
      && recomputed.effects.positionVersusNoPosition >= 0.1
      && recomputed.effects.positionVersusShuffled >= 0.1
      && recomputed.effects.recurrenceVersusSingle >= 0.1;
    const guardrailPass = recomputedLive.combinedUnrelatedRecordUse <= recomputedLive.normalizedUnrelatedRecordUse + 0.05;
    const efficacyPass = recomputedLive.primaryGain >= 0.2 && recomputedLive.learningGain >= 0.2 && recomputedLive.bySeed.every((row) => row.combinedVsContent >= 0);
    const integrityPass = recomputed.repeatDeterminism === 1 && recomputedLive.reasoningObservationCoverage === 1 && liveRows.every((row) => row.metrics.malformed === false);
    const expectedClassification = !integrityPass ? 'inconclusive' : (localEffectsPass && guardrailPass && efficacyPass ? 'candidate-supported-exploratory' : 'rejected');
    if (analysis.classification !== expectedClassification) errors.push(`classification mismatch: expected ${expectedClassification}`);
    warnings.push('The two-seed owner-backend pilot remains exploratory and cannot authorize product behavior.');
  } else {
    errors.push(`unsupported manifest backend ${manifest.backend}`);
  }

  let secretValues = [];
  try {
    secretValues = parseDotEnv(await readFile(path.join(repositoryRoot, '.env')));
  } catch {
    warnings.push('No repository .env was readable for configured-value leakage scan.');
  }
  const artifactText = filenames.map((filename) => bytesByFile.get(filename).toString('utf8')).join('\n');
  if (secretValues.some((value) => artifactText.includes(value))) errors.push('configured Aether endpoint or credential leaked into artifacts');

  const validation = {
    schemaVersion: `memory-association-task-switch/validation-v${preregistration.experimentVersion}`,
    experimentId: preregistration.experimentId,
    experimentVersion: preregistration.experimentVersion,
    runId: manifest.runId,
    valid: errors.length === 0,
    scope: manifest.backend === 'local-deterministic' ? 'independent-local-artifact-validation' : 'independent-full-or-aborted-artifact-validation',
    preregistrationSource,
    counts: { cases: cases.length, localCases: localRows.length, modelRawRows: modelRows.length },
    checks: {
      checksumFiles: 4,
      expectedLocalCases: expectedLocalIds.size,
      repeatDeterminism: recomputed.repeatDeterminism,
      activeContextLeakageMaximum: Math.max(...localRows.map((row) => row.metrics.activeContextLeakage), ...liveRows.map((row) => row.activeContextIds.some((id) => row.retainedRecordIds.includes(id)) ? 1 : 0)),
      configuredSecretLeakage: false,
    },
    effects: recomputed.effects,
    errors,
    warnings,
    verifiedAt: new Date().toISOString(),
  };
  if (options.write) await writeFile(path.join(options.artifactDirectory, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
  if (!validation.valid) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
