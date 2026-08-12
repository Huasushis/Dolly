#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALGORITHM_VERSION,
  evaluateLocalCondition,
  EXPERIMENT_ID,
  fisherYates,
  generateCase,
  LIVE_CONDITION_IDS,
  sha256,
  summarizeLocalRows,
  xorshift32,
} from './common.mjs';
import {
  readBoundedResponseText,
  readStrictChatCompletionSse,
} from './strict-chat-sse.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const preregistrationPath = path.join(repositoryRoot, 'docs/experiments/preregistrations/memory-association-task-switch-v0.json');
const protocolPath = path.join(repositoryRoot, 'docs/experiments/protocol.md');
const artifactRoot = path.join(repositoryRoot, 'artifacts/experiments/probes/memory-association-task-switch-v0');

function parseArguments(argv) {
  const result = { localRun: null, runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--local-run') result.localRun = argv[++index];
    else if (argv[index] === '--run-id') result.runId = argv[++index];
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!/^local-v[0-9]+-[a-zA-Z0-9._-]+$/.test(result.localRun ?? '')) throw new Error('--local-run must name a versioned local run');
  if (!/^full-v[0-9]+-[a-zA-Z0-9._-]+$/.test(result.runId ?? '')) throw new Error('--run-id must name a versioned full run');
  return result;
}

function loadEnv(bytes) {
  const result = {};
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

function completionUrl(baseValue) {
  const parsed = new URL(baseValue);
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
  return parsed;
}

function jsonLines(rows) {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join('');
}

function parseStrictObject(content) {
  if (typeof content !== 'string' || content.trim() === '') throw new Error('response content is empty');
  const value = JSON.parse(content);
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('response is not one JSON object');
  return value;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return JSON.stringify(actual) === JSON.stringify(wanted);
}

function gitOutput(args, fallback) {
  try {
    return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

function rawEvidence(caseData, phase, conditionId) {
  const result = evaluateLocalCondition(caseData, phase, conditionId);
  return result.evidence.map((item) => ({
    id: item.id,
    source: item.source,
    text: item.text ?? caseData.records.find((record) => record.id === item.id)?.text ?? '',
    citedIds: item.citedIds ?? [],
  }));
}

function validateLearner(value, caseData) {
  if (!exactKeys(value, ['checkpoint', 'summary', 'procedure', 'durableFact'])) throw new Error('learner top-level keys mismatch');
  const checkpointKeys = ['taskId', 'completedStep', 'nextAction', 'reason', 'idempotencyKey', 'retentionDays', 'sourceRecordIds'];
  if (!value.checkpoint || !exactKeys(value.checkpoint, checkpointKeys)) throw new Error('learner checkpoint keys mismatch');
  for (const name of ['summary', 'procedure', 'durableFact']) {
    if (!value[name] || !exactKeys(value[name], ['text', 'sourceRecordIds'])) throw new Error(`learner ${name} keys mismatch`);
  }
  const retained = new Set(caseData.records.map((record) => record.id));
  for (const representation of Object.values(value)) {
    if (!Array.isArray(representation.sourceRecordIds) || representation.sourceRecordIds.some((id) => !retained.has(id))) throw new Error('learner cites an unknown record');
  }
  return value;
}

function learnedEvidence(learner, caseData) {
  const entries = [
    ['checkpoint', 'task-checkpoint'],
    ['durableFact', 'durable-fact'],
    ['procedure', 'reusable-procedure'],
    ['summary', 'extractive-summary'],
  ];
  return entries.map(([name, source]) => ({
    id: `${caseData.split}-${caseData.seed}-live-${name}`,
    source,
    text: name === 'checkpoint' ? JSON.stringify(learner[name]) : learner[name].text,
    citedIds: learner[name].sourceRecordIds,
  }));
}

function evidenceForLive(caseData, phase, conditionId, learner) {
  if (conditionId === 'explicit-task-checkpoint') return phase === 'after-learning' ? [learnedEvidence(learner, caseData)[0]] : [];
  if (conditionId !== 'combined-memory') return rawEvidence(caseData, phase, conditionId);
  if (phase === 'before-learning') return rawEvidence(caseData, phase, conditionId);
  const representations = learnedEvidence(learner, caseData);
  const cited = new Set(representations.flatMap((entry) => entry.citedIds));
  const associated = rawEvidence(caseData, 'after-learning', 'normalized-content-position-recurrence').filter((entry) => !cited.has(entry.id));
  const candidates = [...representations, ...associated];
  let bytes = 0;
  return candidates.filter((entry) => {
    const size = Buffer.byteLength(entry.text, 'utf8');
    if (bytes + size > 6000) return false;
    bytes += size;
    return true;
  });
}

function learningMessages(caseData) {
  const originalRecords = caseData.records.filter((record) => record.role !== 'interrupt-task');
  return [
    {
      role: 'system',
      content: 'You are a memory consolidation worker. Use only supplied synthetic records. Keep internal analysis under 200 words and reserve completion budget for the final answer. Return exactly one JSON object, no markdown and no prose. Every claim must cite source record IDs.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: 'Build a task checkpoint, an extractive summary, a reusable procedure, and one durable task fact. Do not infer causes beyond an explicit record.',
        outputSchema: {
          checkpoint: { taskId: 'string', completedStep: 'string', nextAction: 'string', reason: 'string', idempotencyKey: 'string', retentionDays: 'integer', sourceRecordIds: ['string'] },
          summary: { text: 'string', sourceRecordIds: ['string'] },
          procedure: { text: 'string', sourceRecordIds: ['string'] },
          durableFact: { text: 'string', sourceRecordIds: ['string'] },
        },
        records: originalRecords.map(({ id, text }) => ({ id, text })),
      }),
    },
  ];
}

function agentMessages(caseData, evidence) {
  return [
    {
      role: 'system',
      content: 'You are a general task Agent resuming work after an unrelated interruption. Use only active context and the supplied memory packet. Keep internal analysis under 200 words and reserve completion budget for the final answer. Return exactly one JSON object with exactly the requested keys, no markdown. usedEvidenceIds must contain underlying source record IDs, not learned representation IDs. If evidence is insufficient, set uncertain=true and do not invent values.',
    },
    ...caseData.activeContext.map(({ role, text }) => ({ role, content: text })),
    {
      role: 'user',
      content: JSON.stringify({
        memoryEvidence: evidence,
        outputSchema: {
          taskId: 'string',
          nextAction: 'string',
          idempotencyKey: 'string',
          retentionDays: 'integer',
          usedEvidenceIds: ['string'],
          uncertain: 'boolean',
        },
      }),
    },
  ];
}

function scoreAgent(value, caseData) {
  const required = ['taskId', 'nextAction', 'idempotencyKey', 'retentionDays', 'usedEvidenceIds', 'uncertain'];
  if (!exactKeys(value, required) || !Array.isArray(value.usedEvidenceIds)) return { taskResumeSuccess: 0, unrelatedRecordUse: 0, malformed: true };
  const used = new Set(value.usedEvidenceIds);
  const truth = caseData.groundTruth;
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

async function main() {
  if (process.env.RUN_LIVE_INTEGRATION !== '1' || process.env.RUN_PAID_INTEGRATION !== '1') throw new Error('Both RUN_LIVE_INTEGRATION=1 and RUN_PAID_INTEGRATION=1 are required');
  const options = parseArguments(process.argv.slice(2));
  const preregistrationBytes = await readFile(preregistrationPath);
  const preregistration = JSON.parse(preregistrationBytes);
  if (preregistration.experimentId !== EXPERIMENT_ID || !Number.isInteger(preregistration.experimentVersion)) throw new Error('Unexpected preregistration identity or version');
  const experimentVersion = preregistration.experimentVersion;
  if (!options.localRun.startsWith(`local-v${experimentVersion}-`) || !options.runId.startsWith(`full-v${experimentVersion}-`)) throw new Error('run-id version does not match preregistration');
  const protocolBytes = await readFile(protocolPath);
  if (sha256(protocolBytes) !== preregistration.protocol.sha256) throw new Error('Protocol hash mismatch');
  const currentPreregistrationHash = sha256(preregistrationBytes);

  const environment = { ...loadEnv(await readFile(path.join(repositoryRoot, '.env'))), ...process.env };
  const apiKey = environment.AETHER_API_KEY;
  const configuredBase = environment.AETHER_BASE_URL;
  if (!apiKey || !configuredBase) throw new Error('Aether credentials are missing');
  const requestUrl = completionUrl(configuredBase);
  const configuredOrigin = new URL(configuredBase).origin;
  if (requestUrl.origin !== configuredOrigin) throw new Error('Completion route escaped the configured Aether origin');

  const localDirectory = path.join(artifactRoot, 'runs', options.localRun);
  const localManifest = JSON.parse(await readFile(path.join(localDirectory, 'run-manifest.json')));
  if (localManifest.preregistrationSha256 !== currentPreregistrationHash || localManifest.perCaseAccounting.localRows !== 1872) throw new Error('Local source run does not match current preregistration');
  const localRows = (await readFile(path.join(localDirectory, 'cases.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const localAnalysis = summarizeLocalRows(localRows);
  const runDirectory = path.join(artifactRoot, 'runs', options.runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path.join(runDirectory, 'preregistration.json'), preregistrationBytes, { flag: 'wx' });
  const modelRawPath = path.join(runDirectory, 'model-raw.jsonl');
  await writeFile(modelRawPath, '', { flag: 'wx' });
  const startedAt = new Date().toISOString();
  const rawRows = [];
  const liveRows = [];
  let logicalCallIndex = 0;

  async function callModel(kind, seed, phase, conditionId, messages) {
    if (logicalCallIndex >= 38) throw new Error('Logical live call budget exhausted');
    if (Date.now() - Date.parse(startedAt) >= preregistration.execution.maxWallClockMs) throw new Error('Experiment wall-clock budget exhausted');
    const requestProfile = kind === 'learner'
      ? preregistration.domainDesign.liveEndpointProfile.request
      : (preregistration.domainDesign.liveEndpointProfile.agentRequest ?? preregistration.domainDesign.liveEndpointProfile.request);
    const maximumTokens = requestProfile.max_tokens;
    const timeoutMs = requestProfile.timeout_ms;
    const thinkingType = requestProfile.thinking?.type;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('A positive preregistered request timeout is required');
    if (!['enabled', 'disabled'].includes(thinkingType)) throw new Error('A measured preregistered thinking type is required');
    const requestBody = {
      model: 'qwen3.6-27b',
      messages,
      thinking: { type: thinkingType },
      temperature: 0,
      max_tokens: maximumTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if ('enable_thinking' in requestBody) throw new Error('enable_thinking is forbidden');
    const currentLogicalCallIndex = logicalCallIndex;
    logicalCallIndex += 1;
    const retryPolicy = preregistration.domainDesign.liveEndpointProfile.retryPolicy ?? {
      maxAttemptsPerLogicalCall: 1,
      retryDelayMs: 0,
      maxRequestAttempts: 38,
    };
    for (let attemptIndex = 1; attemptIndex <= retryPolicy.maxAttemptsPerLogicalCall; attemptIndex += 1) {
      if (rawRows.length >= retryPolicy.maxRequestAttempts) throw new Error('Live request-attempt budget exhausted');
      const currentIndex = rawRows.length;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const requestStartedAt = new Date().toISOString();
      let response;
      let body;
      let streamEvidence = null;
      try {
        response = await fetch(requestUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const failureRow = {
          schemaVersion: `memory-association-task-switch/model-raw-v${experimentVersion}`,
          callIndex: currentIndex,
          logicalCallIndex: currentLogicalCallIndex,
          attemptIndex,
          callId: `${kind}-${seed}-${phase ?? 'none'}-${conditionId ?? 'none'}`,
          kind,
          seed,
          phase,
          conditionId,
          request: { model: requestBody.model, messages, thinking: requestBody.thinking, temperature: 0, max_tokens: maximumTokens, timeout_ms: timeoutMs, stream: true, stream_options: { include_usage: true } },
          httpStatus: null,
          response: null,
          reasoningPresent: false,
          reasoningCharacterCount: 0,
          requestStartedAt,
          responseFinishedAt: new Date().toISOString(),
          failureKind: error?.name === 'AbortError' ? 'timeout' : 'network-before-response-headers',
        };
        rawRows.push(failureRow);
        await appendFile(modelRawPath, `${JSON.stringify(failureRow)}\n`);
        if (attemptIndex === retryPolicy.maxAttemptsPerLogicalCall) {
          throw new Error(`Aether logical call ${currentLogicalCallIndex} exhausted transport attempts`);
        }
        await new Promise((resolve) => setTimeout(resolve, retryPolicy.retryDelayMs));
        continue;
      }
      try {
        if (response.ok) {
          const parsedStream = await readStrictChatCompletionSse(response, {
            maximumResponseBytes: 2 * 1024 * 1024,
            maximumBufferedBytes: 256 * 1024,
            maximumOutputBytes: 512 * 1024,
            maximumEvents: 20_000,
          });
          body = parsedStream.body;
          streamEvidence = parsedStream.evidence;
        } else {
          const text = await readBoundedResponseText(response, 2 * 1024 * 1024);
          try {
            body = JSON.parse(text);
          } catch {
            body = { error: { message: 'non-JSON provider error response' } };
          }
        }
      } catch (error) {
        const failureKind = error?.name === 'AbortError' ? 'timeout' : 'stream-protocol';
        const failureRow = {
          schemaVersion: `memory-association-task-switch/model-raw-v${experimentVersion}`,
          callIndex: currentIndex,
          logicalCallIndex: currentLogicalCallIndex,
          attemptIndex,
          callId: `${kind}-${seed}-${phase ?? 'none'}-${conditionId ?? 'none'}`,
          kind,
          seed,
          phase,
          conditionId,
          request: { model: requestBody.model, messages, thinking: requestBody.thinking, temperature: 0, max_tokens: maximumTokens, timeout_ms: timeoutMs, stream: true, stream_options: { include_usage: true } },
          httpStatus: response.status,
          response: null,
          streamEvidence: null,
          reasoningPresent: false,
          reasoningCharacterCount: 0,
          requestStartedAt,
          responseFinishedAt: new Date().toISOString(),
          failureKind,
        };
        rawRows.push(failureRow);
        await appendFile(modelRawPath, `${JSON.stringify(failureRow)}\n`);
        if (failureKind === 'timeout' && attemptIndex < retryPolicy.maxAttemptsPerLogicalCall) {
          clearTimeout(timer);
          await new Promise((resolve) => setTimeout(resolve, retryPolicy.retryDelayMs));
          continue;
        }
        throw new Error(`Aether logical call ${currentLogicalCallIndex} returned an invalid strict stream`);
      } finally {
        clearTimeout(timer);
      }
      const message = body?.choices?.[0]?.message;
      const reasoningContent = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
      const rawRow = {
        schemaVersion: `memory-association-task-switch/model-raw-v${experimentVersion}`,
        callIndex: currentIndex,
        logicalCallIndex: currentLogicalCallIndex,
        attemptIndex,
        callId: `${kind}-${seed}-${phase ?? 'none'}-${conditionId ?? 'none'}`,
        kind,
        seed,
        phase,
        conditionId,
        request: { model: requestBody.model, messages, thinking: requestBody.thinking, temperature: 0, max_tokens: maximumTokens, timeout_ms: timeoutMs, stream: true, stream_options: { include_usage: true } },
        httpStatus: response.status,
        response: { model: body?.model ?? null, choices: body?.choices ?? null, usage: body?.usage ?? null, error: body?.error ?? null },
        streamEvidence,
        reasoningPresent: reasoningContent.trim().length > 0,
        reasoningCharacterCount: reasoningContent.length,
        requestStartedAt,
        responseFinishedAt: new Date().toISOString(),
      };
      rawRows.push(rawRow);
      await appendFile(modelRawPath, `${JSON.stringify(rawRow)}\n`);
      const retryableStatus = [408, 425, 429].includes(response.status) || response.status >= 500;
      if (retryableStatus && attemptIndex < retryPolicy.maxAttemptsPerLogicalCall) {
        await new Promise((resolve) => setTimeout(resolve, retryPolicy.retryDelayMs));
        continue;
      }
      if (!response.ok || !message) throw new Error(`Aether logical call ${currentLogicalCallIndex} failed with HTTP ${response.status}`);
      return { content: message.content, rawRow };
    }
    throw new Error(`Aether logical call ${currentLogicalCallIndex} ended without a terminal response`);
  }

  for (const seed of [301, 302]) {
    const caseData = generateCase(seed, 'evaluation');
    const learnerCall = await callModel('learner', seed, null, null, learningMessages(caseData));
    const learner = validateLearner(parseStrictObject(learnerCall.content), caseData);
    const plan = fisherYates(
      ['before-learning', 'after-learning'].flatMap((phase) => LIVE_CONDITION_IDS.map((conditionId) => ({ phase, conditionId }))),
      (seed ^ 0x9e3779b9) >>> 0,
    );
    for (const item of plan) {
      const evidence = evidenceForLive(caseData, item.phase, item.conditionId, learner);
      const modelCall = await callModel('agent', seed, item.phase, item.conditionId, agentMessages(caseData, evidence));
      let parsed = null;
      let metrics;
      try {
        parsed = parseStrictObject(modelCall.content);
        metrics = scoreAgent(parsed, caseData);
      } catch {
        metrics = { taskResumeSuccess: 0, unrelatedRecordUse: 0, malformed: true };
      }
      liveRows.push({
        schemaVersion: `memory-association-task-switch/case-v${experimentVersion}`,
        caseId: `evaluation-${seed}-${item.phase}-${item.conditionId}-live`,
        orderIndex: localRows.length + liveRows.length,
        backend: 'owner-aether-qwen36',
        split: 'evaluation',
        seed,
        phase: item.phase,
        conditionId: item.conditionId,
        repetition: 1,
        query: caseData.query,
        activeContextIds: caseData.activeContext.map((message) => message.id),
        retainedRecordIds: caseData.records.map((record) => record.id),
        groundTruth: caseData.groundTruth,
        evidence,
        evidenceIds: [...new Set(evidence.flatMap((entry) => [entry.id, ...(entry.citedIds ?? [])]))],
        agentOutput: parsed,
        modelCallIndex: modelCall.rawRow.callIndex,
        reasoningPresent: modelCall.rawRow.reasoningPresent,
        reasoningCharacterCount: modelCall.rawRow.reasoningCharacterCount,
        metrics,
      });
    }
  }
  const maximumRequestAttempts = preregistration.domainDesign.liveEndpointProfile.retryPolicy?.maxRequestAttempts ?? 38;
  if (logicalCallIndex !== 38 || rawRows.length < 38 || rawRows.length > maximumRequestAttempts || liveRows.length !== 36) {
    throw new Error(`Expected 38 logical calls, 38-${maximumRequestAttempts} attempts, and 36 live rows; got ${logicalCallIndex}/${rawRows.length}/${liveRows.length}`);
  }

  const select = (conditionId, phase) => liveRows.filter((row) => row.conditionId === conditionId && row.phase === phase);
  const combinedAfter = select('combined-memory', 'after-learning');
  const combinedBefore = select('combined-memory', 'before-learning');
  const normalizedAfter = select('normalized-content', 'after-learning');
  const bySeed = [301, 302].map((seed) => ({
    seed,
    combinedVsContent: combinedAfter.find((row) => row.seed === seed).metrics.taskResumeSuccess - normalizedAfter.find((row) => row.seed === seed).metrics.taskResumeSuccess,
    learningGain: combinedAfter.find((row) => row.seed === seed).metrics.taskResumeSuccess - combinedBefore.find((row) => row.seed === seed).metrics.taskResumeSuccess,
  }));
  const primaryGain = bySeed.reduce((sum, row) => sum + row.combinedVsContent, 0) / bySeed.length;
  const learningGain = bySeed.reduce((sum, row) => sum + row.learningGain, 0) / bySeed.length;
  const combinedUnrelated = mean(combinedAfter, 'unrelatedRecordUse');
  const normalizedUnrelated = mean(normalizedAfter, 'unrelatedRecordUse');
  const reasoningCoverage = rawRows.filter((row) => typeof row.reasoningPresent === 'boolean' && Number.isInteger(row.reasoningCharacterCount)).length / rawRows.length;
  const localEffectsPass = Object.values(localAnalysis.effects).every((value, index) => value >= (index === 0 ? 0.2 : 0.1));
  const guardrailPass = combinedUnrelated <= normalizedUnrelated + 0.05;
  const efficacyPass = primaryGain >= 0.2 && learningGain >= 0.2 && bySeed.every((row) => row.combinedVsContent >= 0);
  const integrityPass = localAnalysis.repeatDeterminism === 1 && reasoningCoverage === 1 && liveRows.every((row) => row.metrics.malformed === false);
  const classification = !integrityPass ? 'inconclusive' : (localEffectsPass && guardrailPass && efficacyPass ? 'candidate-supported-exploratory' : 'rejected');
  const liveAnalysis = {
    byConditionPhase: Object.fromEntries(['before-learning', 'after-learning'].flatMap((phase) => LIVE_CONDITION_IDS.map((conditionId) => {
      const rows = select(conditionId, phase);
      return [`${phase}/${conditionId}`, { rows: rows.length, taskResumeSuccess: mean(rows, 'taskResumeSuccess'), unrelatedRecordUse: mean(rows, 'unrelatedRecordUse') }];
    }))),
    primaryGain,
    learningGain,
    bySeed,
    primaryBootstrap: pairedBootstrap(bySeed.map((row) => row.combinedVsContent)),
    combinedUnrelatedRecordUse: combinedUnrelated,
    normalizedUnrelatedRecordUse: normalizedUnrelated,
    reasoningObservationCoverage: reasoningCoverage,
    reasoningPresentRate: rawRows.filter((row) => row.reasoningPresent).length / rawRows.length,
  };
  const analysis = {
    schemaVersion: `memory-association-task-switch/analysis-v${experimentVersion}`,
    experimentId: EXPERIMENT_ID,
    experimentVersion,
    runId: options.runId,
    status: 'full-run-complete-independent-validation-pending',
    classification,
    classificationReason: classification === 'candidate-supported-exploratory' ? 'All preregistered pilot thresholds pass, but two live seeds cannot authorize product promotion.' : 'See local and live metrics; independent validation remains required.',
    counts: { localCases: localRows.length, liveAgentCases: liveRows.length, liveModelCalls: rawRows.length },
    local: localAnalysis,
    live: liveAnalysis,
  };

  const allRows = [...localRows, ...liveRows];
  const casesBytes = jsonLines(allRows);
  const rawBytes = await readFile(modelRawPath);
  const analysisBytes = `${JSON.stringify(analysis, null, 2)}\n`;
  await writeFile(path.join(runDirectory, 'cases.jsonl'), casesBytes, { flag: 'wx' });
  await writeFile(path.join(runDirectory, 'analysis.json'), analysisBytes, { flag: 'wx' });
  const sourceCommit = gitOutput(['rev-parse', 'HEAD'], 'unavailable');
  const dirtyStatus = gitOutput(['status', '--short'], 'unavailable');
  const manifest = {
    experimentId: EXPERIMENT_ID,
    experimentVersion,
    runId: options.runId,
    protocolSha256: sha256(protocolBytes),
    preregistrationSha256: currentPreregistrationHash,
    sourceCommit,
    dirtyWorktree: dirtyStatus === 'unavailable' ? 'unavailable' : dirtyStatus.length > 0,
    configuration: {
      liveConditions: LIVE_CONDITION_IDS,
      liveSeeds: [301, 302],
      learningPhases: ['before-learning', 'after-learning'],
      temperature: 0,
      learnerRequest: preregistration.domainDesign.liveEndpointProfile.request,
      agentRequest: preregistration.domainDesign.liveEndpointProfile.agentRequest ?? preregistration.domainDesign.liveEndpointProfile.request,
      retryPolicy: preregistration.domainDesign.liveEndpointProfile.retryPolicy ?? null,
    },
    dataset: preregistration.data.generatorOrDataset,
    modelEndpointCapabilityProfile: { label: 'owner-aether-qwen36', routeKind: 'openai-compatible-chat-completions', thinkingRequestAccepted: true },
    modelIdentifier: 'qwen3.6-27b',
    backend: 'local-deterministic+owner-aether-qwen36',
    seeds: { training: preregistration.data.training.seeds, development: preregistration.data.development.seeds, evaluation: preregistration.data.evaluation.seeds, live: [301, 302] },
    executionOrder: [...localRows.map((row) => row.caseId), ...liveRows.map((row) => row.caseId)],
    resourceBudgets: {
      maxCases: 1908,
      maxLogicalLiveCalls: 38,
      maxLiveRequestAttempts: preregistration.domainDesign.liveEndpointProfile.retryPolicy?.maxRequestAttempts ?? 38,
      maxWallClockMs: preregistration.execution.maxWallClockMs,
    },
    perCaseAccounting: { localRows: localRows.length, liveAgentRows: liveRows.length, logicalLiveCalls: logicalCallIndex, liveModelRawRows: rawRows.length },
    rawOutputs: {
      cases: { path: 'cases.jsonl', sha256: sha256(casesBytes), rows: allRows.length },
      modelRaw: { path: 'model-raw.jsonl', sha256: sha256(rawBytes), rows: rawRows.length },
      analysis: { path: 'analysis.json', sha256: sha256(analysisBytes) },
    },
    validatorResults: { status: 'not-run', path: 'validation.json' },
    aggregateMetrics: { local: localAnalysis, live: liveAnalysis },
    startedAt,
    finishedAt: new Date().toISOString(),
    failure: null,
    algorithmVersion: ALGORITHM_VERSION,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(runDirectory, 'run-manifest.json'), manifestBytes, { flag: 'wx' });
  await writeFile(path.join(runDirectory, 'validation.json'), `${JSON.stringify({ status: 'not-run', runId: options.runId }, null, 2)}\n`, { flag: 'wx' });
  const checksumTargets = [['run-manifest.json', manifestBytes], ['cases.jsonl', casesBytes], ['model-raw.jsonl', rawBytes], ['analysis.json', analysisBytes], ['preregistration.json', preregistrationBytes]];
  await writeFile(path.join(runDirectory, 'sha256sums.txt'), `${checksumTargets.map(([filename, bytes]) => `${sha256(bytes)}  ${filename}`).join('\n')}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ runId: options.runId, cases: allRows.length, logicalModelCalls: logicalCallIndex, requestAttempts: rawRows.length, classification, primaryGain, learningGain, reasoningCoverage })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
