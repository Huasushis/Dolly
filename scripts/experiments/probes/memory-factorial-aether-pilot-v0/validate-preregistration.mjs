#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const preregistrationPath = path.join(repositoryRoot, 'docs/experiments/preregistrations/memory-factorial-aether-pilot-v0.json');
const schemaPath = path.join(repositoryRoot, 'docs/experiments/preregistrations/memory-factorial-aether-pilot-v0-schema.json');
const expectedSeeds = [401, 402, 403, 404, 405, 406, 407, 408];
const expectedCells = [
  'content-none',
  'association-none',
  'content-extractive',
  'association-extractive',
  'content-generated',
  'association-generated',
];
const expectedFiles = [
  'preregistration.json',
  'dataset.jsonl',
  'checkpoints.jsonl',
  'cases.jsonl',
  'model-raw.jsonl',
  'analysis.json',
  'run-manifest.json',
  'validation.json',
  'sha256sums.txt',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function main() {
  const [preregistrationBytes, schemaBytes] = await Promise.all([
    readFile(preregistrationPath),
    readFile(schemaPath),
  ]);
  const preregistration = JSON.parse(preregistrationBytes);
  const schema = JSON.parse(schemaBytes);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const errors = [];
  if (!validate(preregistration)) {
    for (const error of validate.errors ?? []) errors.push(`schema ${error.instancePath || '/'} ${error.message}`);
  }
  const protocolPath = path.resolve(repositoryRoot, preregistration.protocol?.path ?? 'invalid');
  if (!protocolPath.startsWith(`${repositoryRoot}${path.sep}`)) {
    errors.push('protocol path escaped repository');
  } else {
    try {
      if (sha256(await readFile(protocolPath)) !== preregistration.protocol.sha256) errors.push('protocol hash mismatch');
    } catch {
      errors.push('protocol file is missing');
    }
  }
  if (!same(preregistration.data?.evaluation?.seeds, expectedSeeds)) errors.push('evaluation seeds mismatch');
  if (!same(preregistration.domainDesign?.scenarioSeeds, expectedSeeds)) errors.push('domain scenario seeds mismatch');
  if (!same(preregistration.domainDesign?.factorialCells, expectedCells)) errors.push('factorial cell order mismatch');
  const declaredCells = [
    ...(preregistration.conditions?.baselines ?? []),
    ...(preregistration.conditions?.treatments ?? []),
  ].map((condition) => condition.id);
  if (!same(declaredCells, expectedCells)) errors.push('declared condition order mismatch');
  const factors = new Set([
    ...(preregistration.conditions?.baselines ?? []),
    ...(preregistration.conditions?.treatments ?? []),
  ].map((condition) => `${condition.frozenParameters?.association}/${condition.frozenParameters?.checkpoint}`));
  if (!same([...factors].sort(), ['off/extractive', 'off/generated', 'off/none', 'on/extractive', 'on/generated', 'on/none'])) {
    errors.push('factorial crossing mismatch');
  }
  if (preregistration.execution?.plannedMaximumCases !== 64 || preregistration.execution?.maxCases !== 64) errors.push('planned case budget mismatch');
  const plan = preregistration.execution?.casePlan ?? [];
  if (!same(plan.map((item) => [item.id, item.maximumCount]), [['generated-checkpoints', 16], ['factorial-agent', 48]])) errors.push('case plan mismatch');
  if (preregistration.backend?.requiredKind !== 'live' || preregistration.backend?.silentFallbackAllowed !== false) errors.push('backend contract mismatch');
  const live = preregistration.domainDesign?.liveEndpointProfile;
  if (live?.model !== 'qwen3.6-27b' || live?.forbiddenRequestField !== 'enable_thinking' || live?.nonStreamFallbackAllowed !== false) errors.push('model capability profile mismatch');
  const requestProfiles = [
    ['checkpoint', live?.checkpointRequest, 'enabled', 5200],
    ['agent', live?.agentRequest, 'disabled', 1000],
  ];
  for (const [label, profile, thinking, maxTokens] of requestProfiles) {
    if (
      profile?.thinking?.type !== thinking
      || profile?.temperature !== 0
      || profile?.max_tokens !== maxTokens
      || profile?.timeout_ms !== 900000
      || profile?.stream !== true
      || profile?.stream_options?.include_usage !== true
    ) errors.push(`${label} request profile mismatch`);
  }
  if (!same(live?.retryPolicy, { maxAttemptsPerLogicalCall: 4, retryDelayMs: 2000, maxLogicalCalls: 64, maxRequestAttempts: 256 })) errors.push('retry policy mismatch');
  if (!same(preregistration.artifacts?.requiredFiles, expectedFiles)) errors.push('artifact inventory mismatch');
  if (preregistration.safetyBoundary?.productRuntimeUsed !== false
    || preregistration.safetyBoundary?.moduleLaunchAllowed !== false
    || preregistration.safetyBoundary?.moduleStartupRefusalMustRemain !== true) {
    errors.push('product safety boundary mismatch');
  }
  if (preregistration.domainDesign?.scientificEvidence !== false) errors.push('pre-run scientificEvidence must be false');
  const declaredMetrics = new Set([
    preregistration.metrics?.primary?.name,
    ...(preregistration.metrics?.secondary ?? []).map((metric) => metric.name),
    ...(preregistration.metrics?.guardrails ?? []).map((metric) => metric.name),
  ]);
  for (const hypothesis of [
    ...(preregistration.hypotheses?.primary ?? []),
    ...(preregistration.hypotheses?.guardrails ?? []),
  ]) {
    if (!declaredMetrics.has(hypothesis.outcomeMeasure)) errors.push(`undeclared outcome measure ${hypothesis.outcomeMeasure}`);
  }
  const result = {
    valid: errors.length === 0,
    validationScope: 'pilot-schema-and-exact-cross-field-contract',
    schemaPath,
    schemaSha256: sha256(schemaBytes),
    preregistrationPath,
    preregistrationSha256: sha256(preregistrationBytes),
    errors,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
