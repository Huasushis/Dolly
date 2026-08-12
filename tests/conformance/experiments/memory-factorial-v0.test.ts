import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCellEvidence,
  constructDeterministicCheckpoint,
  generateDataset,
  retrieveAssociationRecords,
  retrieveContentRecords,
} from "../../../scripts/experiments/probes/memory-factorial-v0/dataset.mjs";
import {
  bundleDigest,
  createArtifactBundle,
} from "../../../scripts/experiments/probes/memory-factorial-v0/run.mjs";
import {
  runDeterministicReader,
  scoreDecisionOutput,
  validateDecisionOutput,
} from "../../../scripts/experiments/probes/memory-factorial-v0/scorer.mjs";
import {
  assertAllMutationsRejected,
  runMutations,
} from "../../../scripts/experiments/probes/memory-factorial-v0/run-mutation-tests.mjs";
import { verifyBundle } from "../../../scripts/experiments/probes/memory-factorial-v0/verify.mjs";
import { validateMemoryFactorialPreregistration } from "../../../scripts/experiments/probes/memory-factorial-v0/validate-preregistration.mjs";
import type { DecisionOutput } from "../../../scripts/experiments/probes/memory-factorial-v0/types.d.mts";

const PREREGISTRATION = join(
  process.cwd(),
  "docs/experiments/preregistrations/memory-factorial-v0.json",
);

function scenario(cueType: string) {
  const value = generateDataset().find((entry) => (
    entry.seed === 501 && entry.cueType === cueType
  ));
  if (!value) throw new Error(`missing scenario ${cueType}`);
  return value;
}

function associationEvidence(cueType: string) {
  const value = scenario(cueType);
  const records = retrieveAssociationRecords(value);
  const checkpoint = constructDeterministicCheckpoint(value, records);
  return { value, evidence: buildCellEvidence(value, "association-raw", checkpoint) };
}

function initialActionResume(value: ReturnType<typeof scenario>): DecisionOutput {
  const currentId = `${value.scenarioId}-current`;
  const constraintId = value.records.find((entry) => entry.role === "constraint")!.id;
  return {
    schemaVersion: "memory-factorial/decision-v2",
    decision: "resume",
    decisionReason: value.cueType === "superseded" ? "superseded_action" : "current_action",
    taskId: value.groundTruth.taskId,
    taskState: "active",
    action: structuredClone(value.groundTruth.initialAction),
    constraints: { retentionDays: Number(value.records.find((entry) => entry.role === "constraint")!
      .text.match(/retention_days=(\d+)/u)![1]!) },
    support: {
      taskState: [currentId],
      action: [currentId],
      constraints: [constraintId],
    },
    uncertain: false,
  };
}

describe("memory-factorial-v0 deterministic evidence chain", () => {
  it("freezes a balanced 16-scenario representation contrast", () => {
    const dataset = generateDataset();
    expect(dataset).toHaveLength(16);
    expect(new Set(dataset.map((entry) => entry.taskFamily)).size).toBe(2);
    expect(new Set(dataset.map((entry) => entry.cueType)).size).toBe(4);

    for (const value of dataset.filter((entry) => ["positive", "superseded"].includes(entry.cueType))) {
      const contentRoles = retrieveContentRecords(value).map((entry) => entry.role);
      const associationRoles = retrieveAssociationRecords(value).map((entry) => entry.role);
      expect(contentRoles).not.toContain("constraint");
      expect(associationRoles.filter((role) => role === "constraint")).toHaveLength(2);
      expect(associationRoles).toContain(value.cueType === "superseded" ? "supersession" : "current-state");
    }
  });

  it("rejects a natural-language action surface form independently of retrieval", () => {
    const { value, evidence } = associationEvidence("positive");
    const output = runDeterministicReader(value, evidence);
    expect(scoreDecisionOutput(output, value, evidence).semanticCaseSuccess).toBe(1);

    const mutated = structuredClone(output);
    mutated.action!.operation = "add an idempotency guard";
    expect(validateDecisionOutput(mutated)).toMatchObject({ valid: false });
    expect(scoreDecisionOutput(mutated, value, evidence)).toMatchObject({
      formatValid: 0,
      semanticCaseSuccess: 0,
    });
  });

  it("scores equivalent constraint citations as an OR-set, not duplicate requirements", () => {
    const { value, evidence } = associationEvidence("positive");
    const first = runDeterministicReader(value, evidence);
    const alternatives = value.groundTruth.claimGroups.constraints.sufficientSourceSets;

    const second = structuredClone(first);
    second.support.constraints = [alternatives[1]![0]!];
    expect(scoreDecisionOutput(first, value, evidence)).toMatchObject({
      semanticCaseSuccess: 1,
      corroboratingConstraintSources: 1,
    });
    expect(scoreDecisionOutput(second, value, evidence)).toMatchObject({
      semanticCaseSuccess: 1,
      corroboratingConstraintSources: 1,
    });

    const both = structuredClone(first);
    both.support.constraints = alternatives.map((set) => set[0]!);
    expect(scoreDecisionOutput(both, value, evidence)).toMatchObject({
      semanticCaseSuccess: 1,
      corroboratingConstraintSources: 2,
    });

    const crossClaim = structuredClone(first);
    crossClaim.support.constraints = [`${value.scenarioId}-current`];
    expect(scoreDecisionOutput(crossClaim, value, evidence)).toMatchObject({
      semanticCaseSuccess: 0,
      citationPrecision: 0,
      invalidCitationCount: 0,
      unrelatedRecordUse: 0,
    });
  });

  it("marks resuming the stored action after do-not-resume as false resume and old-action use", () => {
    const { value, evidence } = associationEvidence("do-not-resume");
    const output = initialActionResume(value);
    expect(validateDecisionOutput(output)).toMatchObject({ valid: true });
    expect(scoreDecisionOutput(output, value, evidence)).toMatchObject({
      semanticCaseSuccess: 0,
      falseResume: 1,
      oldActionUse: 1,
    });
  });

  it("marks resurrecting a cancelled action as false resume and old-action use", () => {
    const { value, evidence } = associationEvidence("cancelled");
    const output = initialActionResume(value);
    expect(validateDecisionOutput(output)).toMatchObject({ valid: true });
    expect(scoreDecisionOutput(output, value, evidence)).toMatchObject({
      semanticCaseSuccess: 0,
      falseResume: 1,
      oldActionUse: 1,
    });
  });

  it("marks use of the initial action after supersession as old-action use", () => {
    const { value, evidence } = associationEvidence("superseded");
    const output = initialActionResume(value);
    expect(validateDecisionOutput(output)).toMatchObject({ valid: true });
    expect(scoreDecisionOutput(output, value, evidence)).toMatchObject({
      semanticCaseSuccess: 0,
      falseResume: 0,
      oldActionUse: 1,
    });
  });

  it("replays byte-identically and passes the independent verifier", () => {
    const left = createArtifactBundle({ enforceRegisteredHashes: true, enforceProtocolHash: false });
    const right = createArtifactBundle({ enforceRegisteredHashes: true, enforceProtocolHash: false });
    expect(bundleDigest(left)).toBe(bundleDigest(right));
    expect(verifyBundle(left, { enforceFrozenHashes: true })).toMatchObject({
      valid: true,
      errors: [],
      checks: {
        datasetRows: 16,
        checkpointRows: 16,
        caseRows: 64,
        independentTreatmentImports: 0,
      },
    });
  });

  it("rejects every frozen mutation independently", () => {
    const bundle = createArtifactBundle({ enforceRegisteredHashes: true, enforceProtocolHash: false });
    const results = runMutations(bundle, { enforceFrozenHashes: true });
    expect(results.map((entry) => entry.id)).toEqual([
      "action-surface-form",
      "citation-cross-claim",
      "do-not-resume-old-action",
      "cancelled-old-action",
      "superseded-old-action",
      "coverage-row-removed",
      "analysis-tampered",
      "frozen-source-tampered",
    ]);
    expect(results.every((entry) => entry.rejected)).toBe(true);
    expect(() => assertAllMutationsRejected(results)).not.toThrow();
  });

  it("keeps the independent verifier free of treatment imports", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/experiments/probes/memory-factorial-v0/verify.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']\.\/(?:common|dataset|scorer|run|run-mutation-tests)\.mjs["']/u);
  });

  it("passes the shared preregistration schema and cross-field validator", () => {
    expect(validateMemoryFactorialPreregistration(PREREGISTRATION, {
      enforceProtocolHash: false,
    })).toMatchObject({
      valid: true,
      errors: [],
    });
  });
});
