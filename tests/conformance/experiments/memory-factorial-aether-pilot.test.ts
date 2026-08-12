import { describe, expect, it } from "vitest";

import {
  analyzeCases,
  CELL_IDS,
  evidencePacket,
  extractCheckpoint,
  makeScenario,
  scoreAgent,
  scoreCheckpoint,
  SEEDS,
} from "../../../scripts/experiments/probes/memory-factorial-aether-pilot-v0/common.mjs";

describe("Memory factorial Aether pilot mechanism", () => {
  it("gives content and association cells different source information before any model call", () => {
    for (const seed of SEEDS) {
      const scenario = makeScenario(seed);
      const content = evidencePacket(scenario, "off");
      const association = evidencePacket(scenario, "on");

      expect(content.some((entry) => entry.id === scenario.groundTruth.expectedCheckpointId)).toBe(true);
      expect(content.some((entry) => scenario.groundTruth.expectedConstraintIds.includes(entry.id))).toBe(false);
      expect(association.some((entry) => entry.id === scenario.groundTruth.expectedCheckpointId)).toBe(true);
      expect(association.some((entry) => scenario.groundTruth.expectedConstraintIds.includes(entry.id))).toBe(true);
    }
  });

  it("keeps extractive checkpoint fields null unless their source is in the condition packet", () => {
    for (const seed of SEEDS) {
      const scenario = makeScenario(seed);
      const contentCheckpoint = extractCheckpoint(evidencePacket(scenario, "off"));
      const associationCheckpoint = extractCheckpoint(evidencePacket(scenario, "on"));

      expect(contentCheckpoint.constraints.retentionDays).toBeNull();
      expect(scoreCheckpoint(contentCheckpoint, scenario).fieldAccuracy).toBeLessThan(1);
      expect(associationCheckpoint.constraints.retentionDays).toBe(scenario.groundTruth.retentionDays);
      expect(scoreCheckpoint(associationCheckpoint, scenario)).toMatchObject({
        fieldAccuracy: 1,
        invalidCitations: 0,
        requiredCitationRecall: 2 / 3,
      });
    }
  });

  it("does not award grounded success when the answer cites a required record absent from evidence", () => {
    const scenario = makeScenario(SEEDS[0]);
    const content = evidencePacket(scenario, "off").map((entry) => ({
      id: entry.id,
      kind: "raw-record",
      text: entry.text,
      role: entry.role,
      eligible: entry.eligible,
      sourceRecordIds: [entry.id],
    }));
    const output = {
      decision: "resume",
      taskId: scenario.groundTruth.taskId,
      action: scenario.groundTruth.nextAction,
      actionArguments: { idempotencyKey: scenario.groundTruth.idempotencyKey },
      constraints: { retentionDays: scenario.groundTruth.retentionDays },
      usedEvidenceIds: [
        scenario.groundTruth.expectedCheckpointId,
        scenario.groundTruth.expectedConstraintIds[0],
        scenario.groundTruth.expectedConstraintIds[1],
      ],
      uncertain: false,
    };

    expect(scoreAgent(output, scenario, content)).toMatchObject({
      groundedResumeSuccess: 0,
      invalidCitations: 2,
    });
  });

  it("makes terminal transport failure inconclusive even with all planned rows", () => {
    const caseRows = SEEDS.flatMap((seed) => CELL_IDS.map((cellId) => ({
      seed,
      cellId,
      evidenceBytes: 1,
      metrics: {
        groundedResumeSuccess: 0,
        malformed: false,
        invalidCitations: 0,
        unrelatedRecordUse: 0,
      },
    })));
    const checkpointRows = Array.from({ length: 32 }, () => ({ metrics: { invalidCitations: 0 } }));
    const rawRows = Array.from({ length: 64 }, (_, logicalCallIndex) => ({
      logicalCallIndex,
      httpStatus: logicalCallIndex === 63 ? null : 200,
      failureKind: logicalCallIndex === 63 ? "timeout" : null,
      request: { stream: true },
      streamEvidence: logicalCallIndex === 63 ? null : { usageEventCount: 1, doneCount: 1 },
    }));

    expect(analyzeCases(caseRows, checkpointRows, rawRows)).toMatchObject({
      classification: "inconclusive",
      integrity: { terminalInfrastructureFailures: 1 },
    });
  });
});
