import { describe, expect, it } from "vitest";
import { selectCollectableModuleRecords } from "../../../src/core/core-startup-recovery.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type {
  ModuleProcessRecord,
  ModuleSubmissionRecord,
} from "../../../src/core/module-process-records.js";

const NOW = "2026-07-26T00:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";

/**
 * Each case here builds a record set in which exactly one retention condition
 * stands between a record and collection. Driving the same conditions through
 * `CoreStartupRecovery.recover()` cannot do that: on every reachable recovery
 * state at least two conditions retain the same record, so removing any single
 * one leaves every recovery test passing. These cases exist so each condition
 * fails on its own when it is removed.
 */
describe("Module record collection, one retention condition at a time", () => {
  function processRecord(
    overrides: Partial<ModuleProcessRecord> = {},
  ): ModuleProcessRecord {
    const processGenerationId = overrides.processGenerationId ?? "process-generation-1";
    return {
      schemaVersion: "dolly.module-process-record/1",
      instanceId: "instance-1",
      moduleId: "worker",
      moduleGenerationId: "module-generation-1",
      processGenerationId,
      packageDigest: DIGEST_A,
      configurationReference: {
        configId: "config-1",
        revision: DIGEST_B,
        configVersion: 1,
      },
      declaredExternalEffects: "core-capabilities-only",
      serviceInvocationId: INVOCATION_ID,
      bootId: BOOT_ID,
      moduleCgroupPath: deriveModuleCgroupPath("/system.slice/dolly-core.service", {
        instanceId: "instance-1",
        moduleId: "worker",
        processGenerationId,
      }).filesystemPath,
      state: "stopped",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    } as ModuleProcessRecord;
  }

  function submissionRecord(
    overrides: Partial<ModuleSubmissionRecord> = {},
  ): ModuleSubmissionRecord {
    return {
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: "module-job-1",
      claimToken: "claim-token-1",
      runId: "run-1",
      attempt: 1,
      moduleGenerationId: "module-generation-1",
      processGenerationId: "process-generation-1",
      inputDigest: DIGEST_C,
      createdAt: NOW,
      ...overrides,
    } as ModuleSubmissionRecord;
  }

  it("collects a stopped process record that nothing still needs", () => {
    // The baseline the retention cases are measured against: with no active
    // Claim and no submission record, every condition permits collection.
    const record = processRecord();

    const selected = selectCollectableModuleRecords({
      activeClaims: [],
      processRecords: [record],
      submissionRecords: [],
    });

    expect(selected.processRecords).toEqual([record]);
  });

  it("keeps a process record that is not stopped, when nothing else would keep it", () => {
    // No active Claim and no submission record, so the process state is the
    // only condition retaining this record. A record that is not stopped may
    // still describe a live process, and collecting it would discard the
    // control-group path needed to prove otherwise.
    const running = processRecord({ state: "running" });

    const selected = selectCollectableModuleRecords({
      activeClaims: [],
      processRecords: [running],
      submissionRecords: [],
    });

    expect(selected.processRecords).toEqual([]);
  });

  it.each(["starting", "running", "stopping"] as const)(
    "keeps a process record in state %s",
    (state) => {
      const selected = selectCollectableModuleRecords({
        activeClaims: [],
        processRecords: [processRecord({ state })],
        submissionRecords: [],
      });

      expect(selected.processRecords).toEqual([]);
    },
  );

  it("keeps a process record an active Claim's submission still references", () => {
    // The Claim belongs to a different Module generation from the process
    // record, so the Module-generation condition does not apply and the
    // reference from the active submission record is the only thing retaining
    // it. An operator resolving that Claim needs the process record the
    // submission points at.
    const referenced = processRecord({
      processGenerationId: "process-generation-1",
      moduleGenerationId: "module-generation-1",
    });
    const submission = submissionRecord({
      runId: "run-active",
      processGenerationId: "process-generation-1",
      moduleGenerationId: "module-generation-2",
    });

    const selected = selectCollectableModuleRecords({
      activeClaims: [{ runId: "run-active", moduleGenerationId: "module-generation-2" }],
      processRecords: [referenced],
      submissionRecords: [submission],
    });

    expect(selected.processRecords).toEqual([]);
  });

  it("keeps a process record of an active Claim's Module generation with no submission record", () => {
    // Version 16 cannot prove whether the missing submission record was never
    // written or was removed separately. No submission references this process
    // generation, so the Module-generation condition is the only thing
    // retaining the record for audited operator action.
    const record = processRecord({
      processGenerationId: "process-generation-1",
      moduleGenerationId: "module-generation-1",
    });

    const selected = selectCollectableModuleRecords({
      activeClaims: [{ runId: "run-active", moduleGenerationId: "module-generation-1" }],
      processRecords: [record],
      submissionRecords: [],
    });

    expect(selected.processRecords).toEqual([]);
  });

  it("keeps every record of a Module generation with two Claims when one is still active", () => {
    // Two process generations of one Module generation. The active Claim
    // retains both, because an operator resolving it cannot tell in advance
    // which process generation carries the evidence they need.
    const first = processRecord({ processGenerationId: "process-generation-1" });
    const second = processRecord({ processGenerationId: "process-generation-2" });

    const selected = selectCollectableModuleRecords({
      activeClaims: [{ runId: "run-active", moduleGenerationId: "module-generation-1" }],
      processRecords: [first, second],
      submissionRecords: [],
    });

    expect(selected.processRecords).toEqual([]);
  });
});
