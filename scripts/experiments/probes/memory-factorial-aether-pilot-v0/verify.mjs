#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const experimentId = 'memory-factorial-aether-pilot-v0';
const seeds = [401, 402, 403, 404, 405, 406, 407, 408];
const cells = [
  'content-none',
  'association-none',
  'content-extractive',
  'association-extractive',
  'content-generated',
  'association-generated',
];
const factors = {
  'content-none': { association: 'off', checkpoint: 'none' },
  'association-none': { association: 'on', checkpoint: 'none' },
  'content-extractive': { association: 'off', checkpoint: 'extractive' },
  'association-extractive': { association: 'on', checkpoint: 'extractive' },
  'content-generated': { association: 'off', checkpoint: 'generated' },
  'association-generated': { association: 'on', checkpoint: 'generated' },
};
const normalization = {
  billing: 'invoice', intake: 'import', importer: 'import', continue: 'resume', back: 'resume',
  failed: 'rejected', entries: 'rows', keep: 'retain', preserve: 'retain', retained: 'retain',
};
const stopwords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'by', 'can',
  'did', 'do', 'does', 'for', 'from', 'go', 'has', 'have', 'in', 'into', 'is', 'it', 'later',
  'now', 'of', 'on', 'only', 'or', 'so', 'than', 'that', 'the', 'their', 'then', 'there', 'this',
  'to', 'was', 'we', 'were', 'when', 'with', 'work', 'you',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  if ((argv.length !== 2 && argv.length !== 4) || argv[0] !== '--run-id' || !/^aether-v1-[a-zA-Z0-9._-]+$/u.test(argv[1])) {
    fail('usage: verify.mjs --run-id aether-v1-<unique-suffix> [--run-directory <artifact-relative-directory>]');
  }
  let runDirectory = null;
  if (argv.length === 4) {
    if (argv[2] !== '--run-directory' || !/^[a-zA-Z0-9._/-]+$/u.test(argv[3]) || argv[3].split('/').includes('..')) {
      fail('run-directory is invalid');
    }
    runDirectory = argv[3];
  }
  return { runId: argv[1], runDirectory };
}

function parseJsonl(bytes, name) {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) fail(`${name} is missing its terminal LF`);
  const lines = text.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) fail(`${name} contains an empty row`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(`${name} row ${index} is not JSON`);
    }
  });
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function same(left, right) {
  return stable(left) === stable(right);
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function exactTokens(text) {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{Nd}]+/gu) ?? [];
}

function normalizedTokens(text) {
  return exactTokens(text).map((token) => normalization[token] ?? token).filter((token) => !stopwords.has(token));
}

function termCounts(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function corpusIdf(records) {
  const frequencies = new Map();
  for (const record of records) {
    for (const token of new Set(normalizedTokens(record.text))) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }
  return new Map([...frequencies].map(([token, count]) => [token, Math.log((records.length + 1) / (count + 1)) + 1]));
}

function vector(tokens, idf) {
  const counts = termCounts(tokens);
  const length = tokens.length || 1;
  return new Map([...counts].map(([token, count]) => [token, (count / length) * (idf.get(token) ?? (Math.log(idf.size + 1) + 1))]));
}

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  for (const [key, value] of left) dot += value * (right.get(key) ?? 0);
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function pair(left, right) {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function expectedEvidence(dataset, association) {
  const idf = corpusIdf(dataset.records);
  const queryTerms = new Set(normalizedTokens(dataset.query));
  const queryVector = vector([...queryTerms], idf);
  const base = dataset.records.map((record) => ({
    record,
    contentScore: cosine(queryVector, vector(normalizedTokens(record.text), idf)),
    associationScore: 0,
  }));
  if (association === 'on') {
    const episodeSupport = new Map();
    const byEpisode = new Map();
    for (const record of dataset.records) {
      if (!byEpisode.has(record.episodeId)) byEpisode.set(record.episodeId, []);
      byEpisode.get(record.episodeId).push(record);
    }
    for (const [episodeId, records] of byEpisode) {
      const ordered = [...records].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
      const local = new Map();
      for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
          const distance = Math.abs(ordered[leftIndex].position - ordered[rightIndex].position);
          if (distance === 0 || distance > 2) continue;
          for (const leftTerm of new Set(normalizedTokens(ordered[leftIndex].text))) {
            for (const rightTerm of new Set(normalizedTokens(ordered[rightIndex].text))) {
              if (leftTerm === rightTerm) continue;
              const key = pair(leftTerm, rightTerm);
              local.set(key, Math.max(local.get(key) ?? 0, 1 / distance));
            }
          }
        }
      }
      for (const [key, proximity] of local) {
        if (!episodeSupport.has(key)) episodeSupport.set(key, new Map());
        episodeSupport.get(key).set(episodeId, proximity);
      }
    }
    const edges = new Map();
    for (const [key, support] of episodeSupport) {
      if (support.size < 2) continue;
      edges.set(key, [...support.values()].reduce((sum, value) => sum + value, 0) / support.size);
    }
    for (const row of base) {
      const candidateTerms = new Set(normalizedTokens(row.record.text));
      for (const queryTerm of queryTerms) {
        for (const candidateTerm of candidateTerms) {
          if (queryTerm === candidateTerm || queryTerms.has(candidateTerm)) continue;
          row.associationScore = Math.max(row.associationScore, edges.get(pair(queryTerm, candidateTerm)) ?? 0);
        }
      }
    }
  }
  return base
    .map((row) => ({ ...row, score: row.contentScore + row.associationScore }))
    .filter((row) => Number.isFinite(row.score) && row.score > 0)
    .sort((left, right) => right.score - left.score || right.associationScore - left.associationScore || left.record.id.localeCompare(right.record.id))
    .slice(0, 4)
    .map((row) => row.record.id);
}

function deriveTruth(dataset) {
  const checkpoint = dataset.records.find((record) => record.role === 'latest-checkpoint');
  const constraints = dataset.records.filter((record) => record.role === 'true-constraint');
  if (!checkpoint || constraints.length !== 2) fail(`dataset ${dataset.seed} role inventory mismatch`);
  const task = checkpoint.text.match(/^(\S+) invoice importer parsing is complete\. Next action: add an idempotency guard with key (idem-[a-zA-Z0-9-]+) /u);
  const retention = constraints[0].text.match(/([0-9]+) days/u);
  if (!task || !retention) fail(`dataset ${dataset.seed} truth syntax mismatch`);
  return {
    taskId: task[1],
    nextAction: 'add an idempotency guard',
    idempotencyKey: task[2],
    retentionDays: Number(retention[1]),
    expectedCheckpointId: checkpoint.id,
    expectedConstraintIds: constraints.map((record) => record.id),
    forbiddenIds: dataset.records.filter((record) => !record.relevant).map((record) => record.id),
  };
}

function scoreCheckpoint(checkpoint, dataset) {
  const truth = deriveTruth(dataset);
  const citations = new Set(checkpoint?.sourceRecordIds ?? []);
  const required = [truth.expectedCheckpointId, ...truth.expectedConstraintIds];
  const fields = {
    taskId: Number(checkpoint?.taskId === truth.taskId),
    status: Number(checkpoint?.status === 'active'),
    completedStep: Number(checkpoint?.completedStep === 'invoice importer parsing'),
    action: Number(checkpoint?.action === truth.nextAction),
    idempotencyKey: Number(checkpoint?.actionArguments?.idempotencyKey === truth.idempotencyKey),
    retentionDays: Number(checkpoint?.constraints?.retentionDays === truth.retentionDays),
  };
  return {
    fields,
    fieldAccuracy: mean(Object.values(fields)),
    invalidCitations: [...citations].filter((id) => !dataset.records.some((record) => record.id === id)).length,
    requiredCitationRecall: required.filter((id) => citations.has(id)).length / required.length,
  };
}

function scoreCase(row, dataset) {
  if (!row.output) {
    return {
      groundedResumeSuccess: 0,
      fields: { decision: 0, taskId: 0, action: 0, idempotencyKey: 0, retentionDays: 0 },
      invalidCitations: 0,
      unrelatedRecordUse: 0,
      requiredCitationRecall: 0,
      malformed: true,
    };
  }
  const truth = deriveTruth(dataset);
  const used = new Set(row.output.usedEvidenceIds);
  const allowed = new Set(row.evidence.flatMap((entry) => entry.sourceRecordIds));
  const required = [truth.expectedCheckpointId, ...truth.expectedConstraintIds];
  const fields = {
    decision: Number(row.output.decision === 'resume' && row.output.uncertain === false),
    taskId: Number(row.output.taskId === truth.taskId),
    action: Number(row.output.action === truth.nextAction),
    idempotencyKey: Number(row.output.actionArguments?.idempotencyKey === truth.idempotencyKey),
    retentionDays: Number(row.output.constraints?.retentionDays === truth.retentionDays),
  };
  const invalidCitations = [...used].filter((id) => !allowed.has(id)).length;
  const unrelatedRecordUse = Number(truth.forbiddenIds.some((id) => used.has(id)));
  const requiredCitationRecall = required.filter((id) => used.has(id)).length / required.length;
  return {
    groundedResumeSuccess: Number(
      Object.values(fields).every((value) => value === 1)
        && invalidCitations === 0
        && unrelatedRecordUse === 0
        && requiredCitationRecall === 1,
    ),
    fields,
    invalidCitations,
    unrelatedRecordUse,
    requiredCitationRecall,
    malformed: false,
  };
}

function analyze(caseRows, checkpointRows, rawRows) {
  const byCell = {};
  for (const cell of cells) {
    const selected = caseRows.filter((row) => row.cellId === cell);
    byCell[cell] = {
      rows: selected.length,
      groundedResumeSuccess: mean(selected.map((row) => row.metrics.groundedResumeSuccess)),
      malformedResponseRate: mean(selected.map((row) => Number(row.metrics.malformed))),
      unrelatedRecordUse: mean(selected.map((row) => row.metrics.unrelatedRecordUse)),
      evidenceBytes: selected.map((row) => row.evidenceBytes),
    };
  }
  const value = (cell) => byCell[cell].groundedResumeSuccess;
  const effects = {
    checkpointMainEffect: mean([
      value('content-extractive'), value('association-extractive'),
      value('content-generated'), value('association-generated'),
    ]) - mean([value('content-none'), value('association-none')]),
    associationMainEffect: mean([
      value('association-none') - value('content-none'),
      value('association-extractive') - value('content-extractive'),
      value('association-generated') - value('content-generated'),
    ]),
    checkpointAssociationInteraction: mean([
      value('association-extractive') - value('content-extractive'),
      value('association-generated') - value('content-generated'),
    ]) - (value('association-none') - value('content-none')),
    extractiveMinusGenerated: mean([
      value('content-extractive'), value('association-extractive'),
    ]) - mean([value('content-generated'), value('association-generated')]),
  };
  const successful = rawRows.filter((row) => row.httpStatus === 200 && row.failureKind === null);
  const finalAttempts = [...new Map(rawRows.map((row) => [row.logicalCallIndex, row])).values()];
  const malformed = new Set(rawRows.filter((row) => row.failureKind === 'content-or-schema').map((row) => row.logicalCallIndex)).size;
  const integrity = {
    invalidCitations: caseRows.reduce((sum, row) => sum + row.metrics.invalidCitations, 0)
      + checkpointRows.reduce((sum, row) => sum + row.metrics.invalidCitations, 0),
    unrelatedRecordUse: Math.max(...caseRows.map((row) => row.metrics.unrelatedRecordUse), 0),
    malformedResponseRate: malformed / 64,
    terminalInfrastructureFailures: finalAttempts.filter((row) => row.failureKind !== null && row.failureKind !== 'content-or-schema').length,
    strictStreamCoverage: successful.length === 0 ? 0 : mean(successful.map((row) => Number(
      row.request.stream === true
        && row.streamEvidence?.usageEventCount === 1
        && row.streamEvidence?.doneCount === 1,
    ))),
  };
  const complete = caseRows.length === 48
    && checkpointRows.length === 32
    && new Set(rawRows.map((row) => row.logicalCallIndex)).size === 64;
  const valid = complete
    && integrity.invalidCitations === 0
    && integrity.unrelatedRecordUse === 0
    && integrity.malformedResponseRate <= 0.05
    && integrity.terminalInfrastructureFailures === 0
    && integrity.strictStreamCoverage === 1;
  return {
    byCell,
    effects,
    factorDecisions: {
      checkpoint: valid && effects.checkpointMainEffect >= 0.125 ? 'pilot-supported' : 'rejected-or-inconclusive',
      association: valid && effects.associationMainEffect >= 0.125 ? 'pilot-supported' : 'rejected-or-inconclusive',
      composition: valid && effects.checkpointAssociationInteraction >= 0.125 ? 'pilot-supported' : 'rejected-or-inconclusive',
      extractive: valid && effects.extractiveMinusGenerated >= -0.125 ? 'pilot-noninferior' : 'rejected-or-inconclusive',
    },
    integrity,
    complete,
    classification: valid ? 'complete-exploratory-pilot' : 'inconclusive',
  };
}

function loadEnv(bytes) {
  const result = {};
  for (const line of bytes.toString('utf8').split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const runId = options.runId;
  const artifactRoot = path.join(repositoryRoot, 'artifacts/experiments/probes/memory-factorial-aether-pilot-v0');
  const runDirectory = options.runDirectory === null
    ? path.join(artifactRoot, 'runs', runId)
    : path.resolve(artifactRoot, options.runDirectory);
  if (!runDirectory.startsWith(`${artifactRoot}${path.sep}`)) fail('run-directory escaped the experiment artifact root');
  const names = [
    'analysis.json', 'cases.jsonl', 'checkpoints.jsonl', 'dataset.jsonl', 'model-raw.jsonl',
    'preregistration.json', 'run-manifest.json', 'validation.json',
  ];
  const bytes = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(path.join(runDirectory, name))])));
  const checksumBytes = await readFile(path.join(runDirectory, 'sha256sums.txt'));
  const checksumRows = checksumBytes.toString('utf8').trimEnd().split('\n');
  const expectedChecksums = new Map(checksumRows.map((line) => {
    const match = line.match(/^([a-f0-9]{64})  ([a-z0-9.-]+)$/u);
    if (!match) fail('invalid checksum row');
    return [match[2], match[1]];
  }));
  if (expectedChecksums.size !== names.length) fail('checksum inventory mismatch');
  for (const name of names) {
    if (expectedChecksums.get(name) !== sha256(bytes[name])) fail(`checksum mismatch for ${name}`);
  }

  const preregistration = JSON.parse(bytes['preregistration.json']);
  const manifest = JSON.parse(bytes['run-manifest.json']);
  const storedAnalysis = JSON.parse(bytes['analysis.json']);
  if (preregistration.experimentId !== experimentId || preregistration.experimentVersion !== 1) fail('preregistration identity mismatch');
  if (manifest.experimentId !== experimentId || manifest.runId !== runId) fail('manifest identity mismatch');
  if (manifest.preregistrationSha256 !== sha256(bytes['preregistration.json'])) fail('manifest preregistration hash mismatch');
  const committedProtocol = execFileSync('git', ['show', `${manifest.sourceCommit}:${preregistration.protocol.path}`], {
    cwd: repositoryRoot,
    encoding: null,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 8 * 1024 * 1024,
  });
  if (sha256(committedProtocol) !== preregistration.protocol.sha256 || manifest.protocolSha256 !== preregistration.protocol.sha256) {
    fail('committed protocol hash mismatch');
  }

  for (const [relativePath, digest] of Object.entries(manifest.relevantSourceHashes ?? {})) {
    const sourcePath = path.resolve(repositoryRoot, relativePath);
    if (!sourcePath.startsWith(`${repositoryRoot}${path.sep}`)) fail('source hash path escaped repository');
    if (sha256(await readFile(sourcePath)) !== digest) fail(`source hash mismatch for ${relativePath}`);
  }

  const datasetRows = parseJsonl(bytes['dataset.jsonl'], 'dataset.jsonl');
  const checkpointRows = parseJsonl(bytes['checkpoints.jsonl'], 'checkpoints.jsonl');
  const caseRows = parseJsonl(bytes['cases.jsonl'], 'cases.jsonl');
  const rawRows = parseJsonl(bytes['model-raw.jsonl'], 'model-raw.jsonl');
  const rawByIndex = new Map(rawRows.map((row) => [row.callIndex, row]));
  if (rawByIndex.size !== rawRows.length) fail('duplicate model call index');
  if (datasetRows.length !== 8 || checkpointRows.length !== 32 || caseRows.length !== 48) fail('row coverage mismatch');
  if (!same(datasetRows.map((row) => row.seed).sort((a, b) => a - b), seeds)) fail('dataset seed coverage mismatch');
  const datasets = new Map(datasetRows.map((row) => [row.seed, row]));
  for (const dataset of datasetRows) {
    if (dataset.records.length !== 18 || dataset.activeContext.length !== 3) fail(`dataset ${dataset.seed} inventory mismatch`);
    const ids = dataset.records.map((record) => record.id);
    if (new Set(ids).size !== ids.length) fail(`dataset ${dataset.seed} duplicate record ID`);
    if (!same(deriveTruth(dataset), dataset.groundTruth)) fail(`dataset ${dataset.seed} ground truth mismatch`);
  }

  const checkpointKeys = new Set();
  for (const row of checkpointRows) {
    if (!seeds.includes(row.seed) || !['off', 'on'].includes(row.association) || !['extractive', 'generated'].includes(row.checkpointType)) {
      fail(`checkpoint ${row.checkpointId} identity mismatch`);
    }
    const key = `${row.seed}/${row.association}/${row.checkpointType}`;
    if (checkpointKeys.has(key)) fail(`duplicate checkpoint ${key}`);
    checkpointKeys.add(key);
    const dataset = datasets.get(row.seed);
    const expectedIds = expectedEvidence(dataset, row.association);
    if (!same(row.evidenceRecordIds, expectedIds)) fail(`checkpoint ${key} evidence mismatch`);
    const expectedMetrics = scoreCheckpoint(row.checkpoint, dataset);
    if (!same(row.metrics, expectedMetrics)) fail(`checkpoint ${key} metric mismatch`);
    if (row.checkpointType === 'extractive') {
      if (row.modelCallIndex !== null) fail(`extractive checkpoint ${key} unexpectedly links a model call`);
    } else {
      const raw = rawByIndex.get(row.modelCallIndex);
      if (!raw || raw.kind !== 'checkpoint' || raw.callId !== `checkpoint-${row.seed}-${row.association}-generated`) {
        fail(`generated checkpoint ${key} model link mismatch`);
      }
      if (!Array.isArray(raw.request.messages) || raw.request.messages.length !== 2) fail(`generated checkpoint ${key} prompt shape mismatch`);
      const prompt = JSON.parse(raw.request.messages[1].content);
      if (!same(prompt.records?.map((record) => record.id), expectedIds)) fail(`generated checkpoint ${key} prompt records mismatch`);
    }
  }

  const logicalGroups = new Map();
  for (const row of rawRows) {
    if (!Number.isSafeInteger(row.logicalCallIndex) || row.logicalCallIndex < 0 || row.logicalCallIndex >= 64) fail('logical call index invalid');
    if (!logicalGroups.has(row.logicalCallIndex)) logicalGroups.set(row.logicalCallIndex, []);
    logicalGroups.get(row.logicalCallIndex).push(row);
    if (row.request.model !== 'qwen3.6-27b' || row.request.stream !== true || row.request.stream_options?.include_usage !== true) fail(`raw call ${row.callIndex} stream profile mismatch`);
    if ('enable_thinking' in row.request) fail(`raw call ${row.callIndex} contains enable_thinking`);
    const expectedProfile = row.kind === 'checkpoint'
      ? { thinking: 'enabled', max: 5200 }
      : { thinking: 'disabled', max: 1000 };
    if (row.request.thinking?.type !== expectedProfile.thinking || row.request.max_tokens !== expectedProfile.max || row.request.temperature !== 0 || row.request.timeout_ms !== 900000) {
      fail(`raw call ${row.callIndex} request profile mismatch`);
    }
    if (row.httpStatus === 200 && row.failureKind === null) {
      if (row.streamEvidence?.usageEventCount !== 1 || row.streamEvidence?.doneCount !== 1 || row.response?.usage === null) fail(`raw call ${row.callIndex} strict stream mismatch`);
    }
  }
  if (logicalGroups.size !== 64) fail('logical call coverage mismatch');
  for (const [logicalIndex, group] of logicalGroups) {
    group.sort((left, right) => left.attemptIndex - right.attemptIndex);
    if (group.length > 4 || group.some((row, index) => row.attemptIndex !== index + 1)) fail(`logical call ${logicalIndex} attempt sequence mismatch`);
    for (const row of group.slice(0, -1)) {
      if (!['timeout', 'network-before-response-headers', 'retryable-http'].includes(row.failureKind)) fail(`logical call ${logicalIndex} retried an ineligible failure`);
    }
  }

  const caseKeys = new Set();
  for (const row of caseRows) {
    const key = `${row.seed}/${row.cellId}`;
    if (!seeds.includes(row.seed) || !cells.includes(row.cellId) || caseKeys.has(key)) fail(`case identity mismatch ${key}`);
    caseKeys.add(key);
    if (!same(row.factors, factors[row.cellId])) fail(`case ${key} factor mismatch`);
    const dataset = datasets.get(row.seed);
    if (!same(row.activeContextIds, dataset.activeContext.map((entry) => entry.id))) fail(`case ${key} active context mismatch`);
    const expectedRawIds = expectedEvidence(dataset, factors[row.cellId].association);
    const rawEvidence = row.evidence.filter((entry) => entry.kind === 'raw-record');
    if (!same(rawEvidence.map((entry) => entry.id), expectedRawIds)) fail(`case ${key} raw evidence mismatch`);
    for (const entry of rawEvidence) {
      const source = dataset.records.find((record) => record.id === entry.id);
      if (!source || entry.text !== source.text || !same(entry.sourceRecordIds, [entry.id])) fail(`case ${key} raw evidence provenance mismatch`);
    }
    if (factors[row.cellId].checkpoint === 'none' && row.evidence.some((entry) => entry.kind.endsWith('-checkpoint'))) fail(`case ${key} unexpected checkpoint`);
    if (factors[row.cellId].checkpoint !== 'none') {
      const checkpoint = checkpointRows.find((candidate) => candidate.seed === row.seed && candidate.association === factors[row.cellId].association && candidate.checkpointType === factors[row.cellId].checkpoint);
      const evidenceCheckpoint = row.evidence.find((entry) => entry.kind === `${factors[row.cellId].checkpoint}-checkpoint`);
      if (!checkpoint || !evidenceCheckpoint || evidenceCheckpoint.text !== stable(checkpoint.checkpoint) || !same(evidenceCheckpoint.sourceRecordIds, checkpoint.checkpoint?.sourceRecordIds ?? [])) {
        fail(`case ${key} checkpoint provenance mismatch`);
      }
    }
    if (row.evidenceBytes !== Buffer.byteLength(JSON.stringify(row.evidence), 'utf8')) fail(`case ${key} evidence byte mismatch`);
    const expectedMetrics = scoreCase(row, dataset);
    if (!same(row.metrics, expectedMetrics)) fail(`case ${key} metric mismatch`);
    const raw = rawByIndex.get(row.modelCallIndex);
    if (!raw || raw.kind !== 'agent' || raw.callId !== `agent-${row.seed}-${row.cellId}`) fail(`case ${key} model link mismatch`);
    if (!Array.isArray(raw.request.messages) || raw.request.messages.length !== 5) fail(`case ${key} prompt shape mismatch`);
    const promptContext = raw.request.messages.slice(1, 4).map((message) => ({ role: message.role, content: message.content }));
    const expectedContext = dataset.activeContext.map((message) => ({ role: message.role, content: message.text }));
    if (!same(promptContext, expectedContext)) fail(`case ${key} active prompt context mismatch`);
    const prompt = JSON.parse(raw.request.messages[4].content);
    if (!same(prompt.memoryEvidence, row.evidence)) fail(`case ${key} prompt evidence mismatch`);
  }
  if (caseKeys.size !== 48) fail('factorial case coverage mismatch');

  const recomputed = analyze(caseRows, checkpointRows, rawRows);
  const expectedAnalysis = {
    schemaVersion: 'memory-factorial-aether-pilot/analysis-v1',
    experimentId,
    experimentVersion: 1,
    runId,
    ...recomputed,
  };
  if (!same(storedAnalysis, expectedAnalysis)) fail('analysis mismatch');
  if (!same(manifest.aggregateMetrics, storedAnalysis)) fail('manifest aggregate mismatch');
  for (const [key, item] of Object.entries(manifest.rawOutputs)) {
    const artifactBytes = bytes[item.path];
    if (!artifactBytes || item.sha256 !== sha256(artifactBytes)) fail(`manifest output hash mismatch for ${key}`);
  }

  const env = loadEnv(await readFile(path.join(repositoryRoot, '.env')));
  const forbiddenValues = [env.AETHER_API_KEY, env.AETHER_BASE_URL].filter((value) => typeof value === 'string' && value.length >= 8);
  const scanNames = names.filter((name) => name !== 'validation.json');
  const scanText = scanNames.map((name) => bytes[name].toString('utf8')).join('\n');
  if (forbiddenValues.some((value) => scanText.includes(value))) fail('configured secret or endpoint leaked into artifacts');
  const forbiddenKey = /"(?:authorization|api[_-]?key|capability[_-]?handle|handle)"\s*:/iu;
  if (forbiddenKey.test(scanText)) fail('authorization or capability field leaked into artifacts');

  const validation = {
    status: 'valid',
    runId,
    verifier: 'memory-factorial-aether-pilot/independent-v1',
    importsTreatmentImplementation: false,
    datasetRows: datasetRows.length,
    checkpointRows: checkpointRows.length,
    caseRows: caseRows.length,
    logicalCalls: logicalGroups.size,
    requestAttempts: rawRows.length,
    classification: recomputed.classification,
    effects: recomputed.effects,
    factorDecisions: recomputed.factorDecisions,
    integrity: recomputed.integrity,
  };
  const validationBytes = `${JSON.stringify(validation, null, 2)}\n`;
  await writeFile(path.join(runDirectory, 'validation.json'), validationBytes);
  bytes['validation.json'] = Buffer.from(validationBytes);
  const checksumText = `${names.sort().map((name) => `${sha256(bytes[name])}  ${name}`).join('\n')}\n`;
  await writeFile(path.join(runDirectory, 'sha256sums.txt'), checksumText);
  process.stdout.write(`${JSON.stringify(validation)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
