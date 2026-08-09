#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const artifactRoot = path.join(repositoryRoot, 'artifacts/experiments/probes/memory-association-task-switch-v0');
const verifierPath = path.join(scriptDirectory, 'verify.mjs');
const requiredFiles = ['run-manifest.json', 'preregistration.json', 'cases.jsonl', 'model-raw.jsonl', 'analysis.json', 'sha256sums.txt'];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArguments(argv) {
  const options = { runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--run-id') options.runId = argv[++index];
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!/^full-v[0-9]+-[a-zA-Z0-9._-]+$/.test(options.runId ?? '')) throw new Error('A full run id is required');
  return options;
}

async function copyRun(sourceDirectory, targetDirectory) {
  await mkdir(targetDirectory, { recursive: false });
  for (const filename of requiredFiles) await copyFile(path.join(sourceDirectory, filename), path.join(targetDirectory, filename));
}

async function updateChecksums(directory, changedFilename) {
  const manifestPath = path.join(directory, 'run-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  const manifestField = { 'cases.jsonl': 'cases', 'model-raw.jsonl': 'modelRaw', 'analysis.json': 'analysis' }[changedFilename];
  if (manifestField) manifest.rawOutputs[manifestField].sha256 = sha256(await readFile(path.join(directory, changedFilename)));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checksums = new Map((await readFile(path.join(directory, 'sha256sums.txt'), 'utf8')).trimEnd().split('\n').map((line) => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    return [match[2], match[1]];
  }));
  if (changedFilename) checksums.set(changedFilename, sha256(await readFile(path.join(directory, changedFilename))));
  checksums.set('run-manifest.json', sha256(await readFile(manifestPath)));
  await writeFile(path.join(directory, 'sha256sums.txt'), `${[...checksums].map(([filename, digest]) => `${digest}  ${filename}`).join('\n')}\n`);
}

async function mutateMissingConstraint(directory) {
  const rows = (await readFile(path.join(directory, 'cases.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const row = rows.find((candidate) => candidate.backend === 'owner-aether-qwen36'
    && candidate.metrics.taskResumeSuccess === 1
    && candidate.groundTruth.expectedConstraintIds.some((id) => candidate.agentOutput.usedEvidenceIds.includes(id)));
  if (!row) throw new Error('No successful live row contains an expected constraint');
  row.agentOutput.usedEvidenceIds = row.agentOutput.usedEvidenceIds.filter((id) => !row.groundTruth.expectedConstraintIds.includes(id));
  await writeFile(path.join(directory, 'cases.jsonl'), `${rows.map(JSON.stringify).join('\n')}\n`);
  await updateChecksums(directory, 'cases.jsonl');
}

async function mutateForbiddenEvidence(directory) {
  const rows = (await readFile(path.join(directory, 'cases.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const row = rows.find((candidate) => candidate.backend === 'owner-aether-qwen36' && candidate.agentOutput !== null);
  if (!row) throw new Error('No parsed live Agent row is available');
  row.agentOutput.usedEvidenceIds.push(row.groundTruth.forbiddenIds[0]);
  await writeFile(path.join(directory, 'cases.jsonl'), `${rows.map(JSON.stringify).join('\n')}\n`);
  await updateChecksums(directory, 'cases.jsonl');
}

async function mutateAggregate(directory) {
  const analysisPath = path.join(directory, 'analysis.json');
  const analysis = JSON.parse(await readFile(analysisPath));
  analysis.live.primaryGain += 0.25;
  await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`);
  await updateChecksums(directory, 'analysis.json');
}

async function mutateUncheckedByte(directory) {
  const casesPath = path.join(directory, 'cases.jsonl');
  const bytes = await readFile(casesPath);
  const marker = Buffer.from('"query":"');
  const markerIndex = bytes.indexOf(marker);
  if (markerIndex < 0) throw new Error('No query field was found');
  const byteIndex = markerIndex + marker.length;
  bytes[byteIndex] = bytes[byteIndex] === 0x52 ? 0x72 : 0x52;
  await writeFile(casesPath, bytes);
}

async function mutateReasoningFlag(directory) {
  const rawPath = path.join(directory, 'model-raw.jsonl');
  const rows = (await readFile(rawPath, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const row = rows.find((candidate) => candidate.reasoningPresent === true);
  if (!row) throw new Error('No non-empty reasoning response was found');
  row.reasoningPresent = false;
  await writeFile(rawPath, `${rows.map(JSON.stringify).join('\n')}\n`);
  await updateChecksums(directory, 'model-raw.jsonl');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourceDirectory = path.join(artifactRoot, 'runs', options.runId);
  const outputRoot = path.join(artifactRoot, 'verification-mutations', options.runId);
  await mkdir(outputRoot, { recursive: true });
  const tests = [
    ['missing-expected-constraint', mutateMissingConstraint, 'live metric mismatch'],
    ['insert-forbidden-evidence', mutateForbiddenEvidence, 'live metric mismatch'],
    ['alter-aggregate', mutateAggregate, 'analysis.live does not match independently recomputed aggregates'],
    ['alter-unchecked-byte', mutateUncheckedByte, 'cases.jsonl checksum mismatch'],
    ['mismatch-reasoning-observation', mutateReasoningFlag, 'reasoning observation mismatch'],
  ];
  const results = [];
  for (const [id, mutate, expectedError] of tests) {
    const directory = path.join(outputRoot, id);
    await copyRun(sourceDirectory, directory);
    await mutate(directory);
    const verification = spawnSync(process.execPath, [verifierPath, '--artifact-dir', directory, '--no-write'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    const combinedOutput = `${verification.stdout}\n${verification.stderr}`;
    const passed = verification.status !== 0 && combinedOutput.includes(expectedError);
    results.push({ id, passed, verifierExitCode: verification.status, expectedErrorObserved: combinedOutput.includes(expectedError) });
  }
  const summary = {
    schemaVersion: 'memory-association-task-switch/mutation-validation-v1',
    runId: options.runId,
    valid: results.every((result) => result.passed),
    results,
    verifiedAt: new Date().toISOString(),
  };
  await writeFile(path.join(sourceDirectory, 'mutation-validation.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.valid) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
