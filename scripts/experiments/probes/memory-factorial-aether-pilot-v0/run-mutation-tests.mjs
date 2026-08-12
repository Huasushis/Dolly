#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const artifactRoot = path.join(repositoryRoot, 'artifacts/experiments/probes/memory-factorial-aether-pilot-v0');
const verifierPath = path.join(scriptDirectory, 'verify.mjs');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--run-id' || !/^aether-v1-[a-zA-Z0-9._-]+$/u.test(argv[1])) {
    throw new Error('usage: run-mutation-tests.mjs --run-id aether-v1-<unique-suffix>');
  }
  return { runId: argv[1] };
}

function parseJsonl(bytes) {
  return bytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
}

function jsonLines(rows) {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join('');
}

async function refreshIntegrity(directory, changedName, changedBytes) {
  await writeFile(path.join(directory, changedName), changedBytes);
  const manifestPath = path.join(directory, 'run-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  const output = Object.values(manifest.rawOutputs).find((item) => item.path === changedName);
  if (output) {
    output.sha256 = sha256(changedBytes);
    if (changedName.endsWith('.jsonl')) output.rows = parseJsonl(Buffer.from(changedBytes)).length;
  }
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestBytes);
  const names = [
    'analysis.json', 'cases.jsonl', 'checkpoints.jsonl', 'dataset.jsonl', 'model-raw.jsonl',
    'preregistration.json', 'run-manifest.json', 'validation.json',
  ];
  const rows = [];
  for (const name of names.sort()) rows.push(`${sha256(await readFile(path.join(directory, name)))}  ${name}`);
  await writeFile(path.join(directory, 'sha256sums.txt'), `${rows.join('\n')}\n`);
}

async function main() {
  const { runId } = parseArguments(process.argv.slice(2));
  const sourceDirectory = path.join(artifactRoot, 'runs', runId);
  const mutationRoot = path.join(artifactRoot, 'verification-mutations', runId);
  await mkdir(mutationRoot, { recursive: true });
  const dataset = parseJsonl(await readFile(path.join(sourceDirectory, 'dataset.jsonl')));
  const forbiddenBySeed = new Map(dataset.map((row) => [
    row.seed,
    row.records.find((record) => !record.relevant)?.id,
  ]));
  const mutations = [
    {
      id: 'alter-agent-action',
      apply: async (directory) => {
        const rows = parseJsonl(await readFile(path.join(directory, 'cases.jsonl')));
        const row = rows.find((candidate) => candidate.output !== null && candidate.metrics.groundedResumeSuccess === 1);
        if (!row) throw new Error('no successful Agent output available for mutation');
        row.output.action = 'perform a different action';
        await refreshIntegrity(directory, 'cases.jsonl', jsonLines(rows));
      },
    },
    {
      id: 'inject-ineligible-citation',
      apply: async (directory) => {
        const rows = parseJsonl(await readFile(path.join(directory, 'cases.jsonl')));
        const row = rows.find((candidate) => candidate.output !== null && candidate.metrics.groundedResumeSuccess === 1);
        if (!row) throw new Error('no successful Agent output available for mutation');
        row.output.usedEvidenceIds.push(forbiddenBySeed.get(row.seed));
        await refreshIntegrity(directory, 'cases.jsonl', jsonLines(rows));
      },
    },
    {
      id: 'remove-factorial-case',
      apply: async (directory) => {
        const rows = parseJsonl(await readFile(path.join(directory, 'cases.jsonl')));
        rows.pop();
        await refreshIntegrity(directory, 'cases.jsonl', jsonLines(rows));
      },
    },
    {
      id: 'disable-stream',
      apply: async (directory) => {
        const rows = parseJsonl(await readFile(path.join(directory, 'model-raw.jsonl')));
        rows[0].request.stream = false;
        await refreshIntegrity(directory, 'model-raw.jsonl', jsonLines(rows));
      },
    },
    {
      id: 'alter-artifact-without-checksum',
      apply: async (directory) => {
        const bytes = await readFile(path.join(directory, 'analysis.json'));
        await writeFile(path.join(directory, 'analysis.json'), Buffer.concat([bytes, Buffer.from(' ')]));
      },
    },
  ];
  const results = [];
  for (const mutation of mutations) {
    const directory = path.join(mutationRoot, mutation.id);
    await cp(sourceDirectory, directory, { recursive: true, force: false, errorOnExist: true });
    await mutation.apply(directory);
    const relativeDirectory = path.relative(artifactRoot, directory).split(path.sep).join('/');
    const verification = spawnSync(process.execPath, [
      verifierPath,
      '--run-id', runId,
      '--run-directory', relativeDirectory,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env },
    });
    const rejected = verification.status !== 0;
    results.push({
      mutationId: mutation.id,
      rejected,
      exitStatus: verification.status,
      signal: verification.signal,
      stderrDigest: sha256(verification.stderr ?? ''),
    });
    if (!rejected) throw new Error(`Verifier accepted mutation ${mutation.id}`);
  }
  const summary = {
    schemaVersion: 'memory-factorial-aether-pilot/mutation-summary-v1',
    sourceRunId: runId,
    expectedMutations: mutations.map((mutation) => mutation.id),
    rejectedCount: results.filter((result) => result.rejected).length,
    allRejected: results.every((result) => result.rejected),
    results,
  };
  await writeFile(path.join(mutationRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
