#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deepClone, sha256, stableJson } from "./common.mjs";
import { createArtifactBundle } from "./run.mjs";
import { readArtifactDirectory, verifyBundle } from "./verify.mjs";

function findCase(bundle, cueType, cellId) {
  const row = bundle.cases.find((candidate) => (
    candidate.cueType === cueType && candidate.cellId === cellId
  ));
  if (!row) throw new Error(`missing mutation target ${cueType}/${cellId}`);
  return row;
}

function initialActionOutput(row, scenario, decisionReason = "current_action") {
  const currentId = `${scenario.scenarioId}-current`;
  const constraintId = scenario.groundTruth.claimGroups.constraints.sufficientSourceSets[0]?.[0];
  return {
    schemaVersion: "memory-factorial/decision-v2",
    decision: "resume",
    decisionReason,
    taskId: scenario.groundTruth.taskId,
    taskState: "active",
    action: scenario.groundTruth.initialAction,
    constraints: { retentionDays: scenario.groundTruth.constraints.retentionDays },
    support: {
      taskState: [currentId],
      action: [currentId],
      constraints: constraintId ? [constraintId] : [],
    },
    uncertain: false,
  };
}

export function mutationDefinitions() {
  return [
    {
      id: "action-surface-form",
      expectedFailure: "A prose surface form is not a member of the closed operation enum.",
      mutate(bundle) {
        const row = findCase(bundle, "positive", "association-raw");
        row.output.action.operation = "add an idempotency guard";
      },
    },
    {
      id: "citation-cross-claim",
      expectedFailure: "An anchor record cannot satisfy the constraint claim-group OR-set.",
      mutate(bundle) {
        const row = findCase(bundle, "positive", "association-raw");
        const scenario = bundle.dataset.find((candidate) => candidate.scenarioId === row.scenarioId);
        row.output.support.constraints = [scenario.records.find((entry) => entry.role === "historical-anchor").id];
      },
    },
    {
      id: "do-not-resume-old-action",
      expectedFailure: "An explicit do-not-resume cue cannot authorize the stored action.",
      mutate(bundle) {
        const row = findCase(bundle, "do-not-resume", "association-raw");
        const scenario = bundle.dataset.find((candidate) => candidate.scenarioId === row.scenarioId);
        row.output = initialActionOutput(row, scenario);
      },
    },
    {
      id: "cancelled-old-action",
      expectedFailure: "A cancellation record cannot be overwritten by an older current-action record.",
      mutate(bundle) {
        const row = findCase(bundle, "cancelled", "association-raw");
        const scenario = bundle.dataset.find((candidate) => candidate.scenarioId === row.scenarioId);
        row.output = initialActionOutput(row, scenario);
      },
    },
    {
      id: "superseded-old-action",
      expectedFailure: "A superseded action cannot replace the later explicit replacement action.",
      mutate(bundle) {
        const row = findCase(bundle, "superseded", "association-raw");
        const scenario = bundle.dataset.find((candidate) => candidate.scenarioId === row.scenarioId);
        row.output = initialActionOutput(row, scenario, "superseded_action");
      },
    },
    {
      id: "coverage-row-removed",
      expectedFailure: "Exactly one row per scenario and cell is required.",
      mutate(bundle) {
        bundle.cases.pop();
      },
    },
    {
      id: "analysis-tampered",
      expectedFailure: "Aggregates must be recomputed from per-case rows.",
      mutate(bundle) {
        bundle.analysis.byCell["association-raw"].semanticCaseSuccess = 0;
      },
    },
    {
      id: "frozen-source-tampered",
      expectedFailure: "Dataset bytes must match the pre-result freeze.",
      mutate(bundle) {
        bundle.dataset[0].records[0].text += " tampered";
      },
    },
  ];
}

export function runMutations(bundle, options = {}) {
  return mutationDefinitions().map((definition) => {
    const mutated = deepClone(bundle);
    definition.mutate(mutated);
    const validation = verifyBundle(mutated, options);
    return {
      id: definition.id,
      rejected: !validation.valid,
      expectedFailure: definition.expectedFailure,
      errors: validation.errors,
      mutatedBundleSha256: sha256(stableJson(mutated)),
    };
  });
}

export function assertAllMutationsRejected(results) {
  const survivors = results.filter((result) => !result.rejected);
  if (survivors.length > 0) {
    throw new Error(`mutation verifier survivors: ${survivors.map((entry) => entry.id).join(", ")}`);
  }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) {
    throw new Error("usage: node run-mutation-tests.mjs [artifact-directory]");
  }
  const directory = process.argv[2];
  const bundle = directory
    ? readArtifactDirectory(resolve(directory)).bundle
    : createArtifactBundle({ enforceRegisteredHashes: true });
  const results = runMutations(bundle, { enforceFrozenHashes: true });
  assertAllMutationsRejected(results);
  process.stdout.write(`${stableJson({ valid: true, results })}\n`);
}
