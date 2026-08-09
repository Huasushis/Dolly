#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPERIMENT_ID, sha256 } from './common.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const artifactRoot = path.join(repositoryRoot, 'artifacts/experiments/probes/memory-association-task-switch-v0/runs');

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--run-id') result.runId = argv[++index];
    else if (argv[index] === '--local-run') result.localRun = argv[++index];
    else if (argv[index] === '--failure-code') result.failureCode = argv[++index];
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!/^full-v[0-9]+-[a-zA-Z0-9._-]+$/.test(result.runId ?? '')) throw new Error('invalid run id');
  if (!/^local-v[0-9]+-[a-zA-Z0-9._-]+$/.test(result.localRun ?? '')) throw new Error('invalid local run id');
  if (!['learner-empty-content', 'live-call-failure', 'learner-malformed', 'process-interrupted-before-raw-response'].includes(result.failureCode)) throw new Error('invalid failure code');
  return result;
}

function gitOutput(args, fallback) {
  try {
    return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const runDirectory = path.join(artifactRoot, options.runId);
  const localDirectory = path.join(artifactRoot, options.localRun);
  const preregistrationBytes = await readFile(path.join(runDirectory, 'preregistration.json'));
  const preregistration = JSON.parse(preregistrationBytes);
  const localManifest = JSON.parse(await readFile(path.join(localDirectory, 'run-manifest.json')));
  if (localManifest.preregistrationSha256 !== sha256(preregistrationBytes)) throw new Error('local and failed-run preregistration differ');
  const casesBytes = await readFile(path.join(localDirectory, 'cases.jsonl'));
  const modelRawPath = path.join(runDirectory, 'model-raw.jsonl');
  const rawBytes = await readFile(modelRawPath);
  const modelRawStat = await stat(modelRawPath);
  const rawRows = rawBytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
  const logicalLiveCalls = new Set(rawRows.map((row) => row.logicalCallIndex ?? row.callIndex)).size;
  const retried = rawRows.some((row) => (row.attemptIndex ?? 1) > 1);
  if (options.failureCode === 'process-interrupted-before-raw-response' && rawRows.length !== 0) {
    throw new Error('interrupted-before-response finalization requires an empty raw response file');
  }
  if (options.failureCode !== 'process-interrupted-before-raw-response' && rawRows.length === 0) {
    throw new Error('ordinary live failure finalization requires at least one raw response row');
  }
  const localAnalysis = JSON.parse(await readFile(path.join(localDirectory, 'analysis.json')));
  const analysis = {
    schemaVersion: `memory-association-task-switch/analysis-v${preregistration.experimentVersion}`,
    experimentId: EXPERIMENT_ID,
    experimentVersion: preregistration.experimentVersion,
    runId: options.runId,
    status: options.failureCode === 'process-interrupted-before-raw-response'
      ? 'interrupted-before-persisted-response'
      : 'aborted-by-preregistered-stopping-rule',
    classification: 'inconclusive',
    classificationReason: options.failureCode,
    counts: { localCases: 1872, liveAgentCases: 0, liveModelCalls: rawRows.length },
    local: localAnalysis.local,
    live: null,
  };
  const analysisBytes = `${JSON.stringify(analysis, null, 2)}\n`;
  await writeFile(path.join(runDirectory, 'cases.jsonl'), casesBytes, { flag: 'wx' });
  await writeFile(path.join(runDirectory, 'analysis.json'), analysisBytes, { flag: 'wx' });
  const sourceCommit = gitOutput(['rev-parse', 'HEAD'], 'unavailable');
  const dirtyStatus = gitOutput(['status', '--short'], 'unavailable');
  const manifest = {
    experimentId: EXPERIMENT_ID,
    experimentVersion: preregistration.experimentVersion,
    runId: options.runId,
    protocolSha256: preregistration.protocol.sha256,
    preregistrationSha256: sha256(preregistrationBytes),
    sourceCommit,
    dirtyWorktree: dirtyStatus === 'unavailable' ? 'unavailable' : dirtyStatus.length > 0,
    configuration: {
      temperature: 0,
      learnerRequest: preregistration.domainDesign.liveEndpointProfile.request,
      agentRequest: preregistration.domainDesign.liveEndpointProfile.agentRequest ?? preregistration.domainDesign.liveEndpointProfile.request,
      retryPolicy: preregistration.domainDesign.liveEndpointProfile.retryPolicy ?? null,
      plannedLiveCalls: 38,
    },
    dataset: preregistration.data.generatorOrDataset,
    modelEndpointCapabilityProfile: { label: 'owner-aether-qwen36', routeKind: 'openai-compatible-chat-completions', thinkingRequestAccepted: true },
    modelIdentifier: 'qwen3.6-27b',
    backend: 'local-deterministic+owner-aether-qwen36',
    seeds: { training: preregistration.data.training.seeds, development: preregistration.data.development.seeds, evaluation: preregistration.data.evaluation.seeds, live: [301, 302] },
    executionOrder: [...localManifest.executionOrder],
    resourceBudgets: {
      maxCases: 1908,
      maxLogicalLiveCalls: 38,
      maxLiveRequestAttempts: preregistration.domainDesign.liveEndpointProfile.retryPolicy?.maxRequestAttempts ?? 38,
      maxWallClockMs: preregistration.execution.maxWallClockMs,
    },
    perCaseAccounting: { localRows: 1872, liveAgentRows: 0, logicalLiveCalls, liveModelRawRows: rawRows.length },
    rawOutputs: {
      cases: { path: 'cases.jsonl', sha256: sha256(casesBytes), rows: 1872 },
      modelRaw: { path: 'model-raw.jsonl', sha256: sha256(rawBytes), rows: rawRows.length },
      analysis: { path: 'analysis.json', sha256: sha256(analysisBytes) },
    },
    validatorResults: { status: 'not-run', path: 'validation.json' },
    aggregateMetrics: { local: localAnalysis.local, live: null },
    startedAt: rawRows[0]?.requestStartedAt ?? modelRawStat.birthtime.toISOString(),
    finishedAt: new Date().toISOString(),
    failure: options.failureCode === 'process-interrupted-before-raw-response'
      ? {
          code: options.failureCode,
          stoppedAfterPersistedLiveResponses: 0,
          retryPerformed: false,
          requestMayHaveLeftHost: true,
          requestCompletionObserved: false,
          evidence: 'The response file was created but remained zero bytes when the agent session disappeared during a server restart.',
        }
      : preregistration.domainDesign.liveEndpointProfile.retryPolicy
        ? { code: options.failureCode, stoppedAfterLogicalLiveCalls: logicalLiveCalls, persistedRequestAttempts: rawRows.length, retryPerformed: retried }
        : { code: options.failureCode, stoppedAfterLiveCalls: rawRows.length, retryPerformed: false },
    algorithmVersion: `memory-association-task-switch/v${preregistration.experimentVersion}`,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(runDirectory, 'run-manifest.json'), manifestBytes, { flag: 'wx' });
  await writeFile(path.join(runDirectory, 'validation.json'), `${JSON.stringify({ status: 'not-run', runId: options.runId }, null, 2)}\n`, { flag: 'wx' });
  const checksumTargets = [['run-manifest.json', manifestBytes], ['cases.jsonl', casesBytes], ['model-raw.jsonl', rawBytes], ['analysis.json', analysisBytes], ['preregistration.json', preregistrationBytes]];
  await writeFile(path.join(runDirectory, 'sha256sums.txt'), `${checksumTargets.map(([filename, bytes]) => `${sha256(bytes)}  ${filename}`).join('\n')}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ runId: options.runId, failure: manifest.failure, rawRows: rawRows.length })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
