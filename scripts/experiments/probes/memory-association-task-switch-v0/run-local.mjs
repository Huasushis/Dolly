#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALGORITHM_VERSION,
  CONDITION_IDS,
  evaluateLocalCondition,
  EXPERIMENT_ID,
  fisherYates,
  generateCase,
  sha256,
  summarizeLocalRows,
} from './common.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const preregistrationPath = path.join(repositoryRoot, 'docs/experiments/preregistrations/memory-association-task-switch-v0.json');
const protocolPath = path.join(repositoryRoot, 'docs/experiments/protocol.md');
const artifactRoot = path.join(repositoryRoot, 'artifacts/experiments/probes/memory-association-task-switch-v0');

function parseArguments(argv) {
  const result = { runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--run-id') result.runId = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (result.runId !== null && !/^local-v[0-9]+-[a-zA-Z0-9._-]+$/.test(result.runId)) {
    throw new Error('run-id must match local-v<version>-[a-zA-Z0-9._-]+');
  }
  return result;
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
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
  const preregistrationBytes = await readFile(preregistrationPath);
  const preregistration = JSON.parse(preregistrationBytes);
  const protocolBytes = await readFile(protocolPath);
  const protocolHash = sha256(protocolBytes);
  if (protocolHash !== preregistration.protocol.sha256) {
    throw new Error(`Protocol hash mismatch: expected ${preregistration.protocol.sha256}, got ${protocolHash}`);
  }
  if (preregistration.experimentId !== EXPERIMENT_ID || !Number.isInteger(preregistration.experimentVersion)) {
    throw new Error('Unexpected preregistration identity or version');
  }
  const experimentVersion = preregistration.experimentVersion;

  const startedAt = new Date().toISOString();
  const defaultSuffix = startedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const runId = options.runId ?? `local-v${experimentVersion}-${defaultSuffix}`;
  if (!runId.startsWith(`local-v${experimentVersion}-`)) throw new Error('run-id version does not match preregistration');
  const runDirectory = path.join(artifactRoot, 'runs', runId);
  await mkdir(runDirectory, { recursive: true });

  const rows = [];
  const executionOrder = [];
  const splitNames = ['training', 'development', 'evaluation'];
  let orderIndex = 0;
  for (const split of splitNames) {
    for (const seed of preregistration.data[split].seeds) {
      const caseData = generateCase(seed, split);
      const plan = [];
      for (const phase of ['before-learning', 'after-learning']) {
        for (const conditionId of CONDITION_IDS) {
          for (let repetition = 1; repetition <= 3; repetition += 1) {
            plan.push({ phase, conditionId, repetition });
          }
        }
      }
      const shuffledPlan = fisherYates(plan, (seed ^ 0x9e3779b9) >>> 0);
      for (const item of shuffledPlan) {
        const result = evaluateLocalCondition(caseData, item.phase, item.conditionId);
        const caseId = `${split}-${seed}-${item.phase}-${item.conditionId}-r${item.repetition}`;
        rows.push({
          schemaVersion: `memory-association-task-switch/case-v${experimentVersion}`,
          caseId,
          orderIndex,
          backend: 'local-deterministic',
          split,
          seed,
          phase: item.phase,
          conditionId: item.conditionId,
          repetition: item.repetition,
          query: caseData.query,
          activeContextIds: caseData.activeContext.map((message) => message.id),
          retainedRecordIds: caseData.records.map((record) => record.id),
          groundTruth: caseData.groundTruth,
          evidence: result.evidence,
          evidenceIds: result.evidenceIds,
          metrics: result.metrics,
        });
        executionOrder.push(caseId);
        orderIndex += 1;
      }
    }
  }

  if (rows.length !== 1872) throw new Error(`Expected 1872 local rows, got ${rows.length}`);
  const casesBytes = rows.map(jsonLine).join('');
  const modelRawBytes = '';
  const localAnalysis = summarizeLocalRows(rows);
  const analysis = {
    schemaVersion: `memory-association-task-switch/analysis-v${experimentVersion}`,
    experimentId: EXPERIMENT_ID,
    experimentVersion,
    runId,
    status: 'local-complete-live-not-run',
    classification: 'inconclusive',
    classificationReason: 'The preregistered live pilot has not run; local results can only accept or reject mechanism hypotheses.',
    counts: { localCases: rows.length, liveAgentCases: 0, liveModelCalls: 0 },
    local: localAnalysis,
    live: null,
  };
  const analysisBytes = `${JSON.stringify(analysis, null, 2)}\n`;
  await writeFile(path.join(runDirectory, 'cases.jsonl'), casesBytes, { flag: 'wx' });
  await writeFile(path.join(runDirectory, 'model-raw.jsonl'), modelRawBytes, { flag: 'wx' });
  await writeFile(path.join(runDirectory, 'analysis.json'), analysisBytes, { flag: 'wx' });
  await writeFile(path.join(runDirectory, 'preregistration.json'), preregistrationBytes, { flag: 'wx' });

  const sourceCommit = gitOutput(['rev-parse', 'HEAD'], 'unavailable');
  const dirtyStatus = gitOutput(['status', '--short'], 'unavailable');
  const manifest = {
    experimentId: EXPERIMENT_ID,
    experimentVersion,
    runId,
    protocolSha256: protocolHash,
    preregistrationSha256: sha256(preregistrationBytes),
    sourceCommit,
    dirtyWorktree: dirtyStatus === 'unavailable' ? 'unavailable' : dirtyStatus.length > 0,
    configuration: {
      conditions: CONDITION_IDS,
      learningPhases: ['before-learning', 'after-learning'],
      deterministicRepetitions: 3,
      topK: 4,
    },
    dataset: preregistration.data.generatorOrDataset,
    modelEndpointCapabilityProfile: null,
    modelIdentifier: null,
    backend: 'local-deterministic',
    seeds: Object.fromEntries(splitNames.map((split) => [split, preregistration.data[split].seeds])),
    executionOrder,
    resourceBudgets: {
      maxCases: preregistration.execution.maxCases,
      maxRawRecordsPerCase: preregistration.execution.maxRawRecordsPerCase,
      maxWallClockMs: preregistration.execution.maxWallClockMs,
    },
    perCaseAccounting: { localRows: rows.length, liveAgentRows: 0, liveModelRawRows: 0 },
    rawOutputs: {
      cases: { path: 'cases.jsonl', sha256: sha256(casesBytes), rows: rows.length },
      modelRaw: { path: 'model-raw.jsonl', sha256: sha256(modelRawBytes), rows: 0 },
      analysis: { path: 'analysis.json', sha256: sha256(analysisBytes) },
    },
    validatorResults: { status: 'not-run', path: 'validation.json' },
    aggregateMetrics: localAnalysis,
    startedAt,
    finishedAt: new Date().toISOString(),
    failure: null,
    algorithmVersion: ALGORITHM_VERSION,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(runDirectory, 'run-manifest.json'), manifestBytes, { flag: 'wx' });
  await writeFile(path.join(runDirectory, 'validation.json'), `${JSON.stringify({ status: 'not-run', runId }, null, 2)}\n`, { flag: 'wx' });

  const checksumTargets = ['run-manifest.json', 'cases.jsonl', 'model-raw.jsonl', 'analysis.json', 'preregistration.json'];
  const checksums = [];
  for (const filename of checksumTargets) {
    checksums.push(`${sha256(await readFile(path.join(runDirectory, filename)))}  ${filename}`);
  }
  await writeFile(path.join(runDirectory, 'sha256sums.txt'), `${checksums.join('\n')}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ runId, runDirectory, localRows: rows.length, preregistrationSha256: sha256(preregistrationBytes) })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
