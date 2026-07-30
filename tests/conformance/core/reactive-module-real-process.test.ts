import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createExtensionProcessModuleExecutor } from "../../../src/adapters/extension-process-module-executor.js";
import type { BlockProposal } from "../../../src/core/block-store.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
} from "../../../src/core/extension-process-host.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import { ModuleResultCommitCoordinator } from "../../../src/core/module-result-commit.js";
import {
  ReactiveModuleRuntime,
  type ReactiveModuleFailure,
  type ReactiveModuleRuntimeOptions,
} from "../../../src/core/reactive-module-runtime.js";

const NOW = "2026-07-26T00:00:00.000Z";
const FIXTURE = fileURLToPath(
  new URL("../security/fixtures/extension-process-fixture.mjs", import.meta.url),
);

function proposal(text: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "text", text, format: "plain" }] },
    },
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Reactive Module runtime with a real Extension process", () => {
  it("commits and acknowledges one Claim, then releases an active Claim during orderly stop", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-reactive-module-real-process-"));
    const coreStatePath = join(root, "core-state.json");
    const commitRepositoryPath = join(root, "module-result-commits.json");
    const executionMarkerPath = join(root, "second-execution-received.txt");
    let blockId = 0;
    let deliveryId = 0;
    let moduleGeneration = 1;
    let monotonicTime = 0;
    const hosts: ExtensionProcessHost[] = [];
    let runtime: ReactiveModuleRuntime | undefined;

    try {
      const core = new FileCoreStateStore({
        path: coreStatePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      core.deliveries.createPage("input");
      core.deliveries.createPage("output");
      core.deliveries.registerConsumer("input", "worker", "from-now");
      core.deliveries.registerConsumer("output", "sink", "from-now");

      const processGenerationId = "process-generation-real-process-test-1";
      core.appendModuleProcessRecord({
        schemaVersion: "dolly.module-process-record/1",
        instanceId: "instance-real-process",
        moduleId: "worker",
        moduleGenerationId: "module-generation-1",
        processGenerationId,
        packageDigest: `sha256:${"a".repeat(64)}`,
        configurationReference: {
          configId: "config-real-process",
          revision: `sha256:${"b".repeat(64)}`,
          configVersion: 1,
        },
        declaredExternalEffects: "none",
        serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
        bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
        moduleCgroupPath: deriveModuleCgroupPath(
          "/system.slice/dolly-core.service",
          {
            instanceId: "instance-real-process",
            moduleId: "worker",
            processGenerationId,
          },
        ).filesystemPath,
        state: "starting",
        createdAt: NOW,
        updatedAt: NOW,
      });

      const firstInputBlock = core.blocks.commit(proposal("first input"), {
        kind: "external",
        id: "console",
      });
      const firstInputDelivery = core.deliveries.append("input", firstInputBlock.id);
      // ReactiveModuleRuntime is not yet composed by the product bootstrap.
      // This fixture supplies the explicit submission callback and lets the
      // runtime verify its durable postconditions before sending the Run. It
      // exercises the FileCore boundary, but does not claim to prove Linux
      // service or control-group binding.
      const runtimeDeliveries: ReactiveModuleRuntimeOptions["deliveries"] = {
        validateClaimPages: core.deliveries.validateClaimPages.bind(core.deliveries),
        validateOutputPages: core.deliveries.validateOutputPages.bind(core.deliveries),
        claim: core.deliveries.claim.bind(core.deliveries),
        flushPersistence: core.deliveries.flushPersistence.bind(core.deliveries),
        inspectClaim: core.deliveries.inspectClaim.bind(core.deliveries),
        inspectClaimInput: core.deliveries.inspectClaimInput.bind(core.deliveries),
      };
      const repository = new FileModuleResultCommitRepository({
        path: commitRepositoryPath,
      });
      const commits = new ModuleResultCommitCoordinator({
        blocks: core.blocks,
        deliveries: core.deliveries,
        acknowledgeDeliveryClaim: (identity) => core.acknowledgeDeliveryClaim(identity),
        getModuleSubmissionRecord: (runId) => core.getModuleSubmissionRecord(runId),
        repository,
        now: () => NOW,
      });
      const classifyFailure = vi.fn((failure: ReactiveModuleFailure) => ({
        code: failure.code,
        retryable: true,
      }));

      runtime = new ReactiveModuleRuntime({
        moduleId: "worker",
        initialModuleGenerationId: "module-generation-1",
        inputPageIds: ["input"],
        outputPageIds: ["output"],
        claimMaxCount: 1,
        claimMaxBytes: 64 * 1_024,
        maxInputBytes: 64 * 1_024,
        maxResultBytes: 64 * 1_024,
        executionTimeoutMs: 10_000,
        cancellationGraceMs: 1_000,
        initializationTimeoutMs: 3_000,
        terminationTimeoutMs: 3_000,
        maxRunsPerGeneration: 10,
        maxGenerations: 2,
        declaredExternalEffects: "none",
        deliveries: runtimeDeliveries,
        persistModuleSubmission: (request) => {
          core.appendModuleSubmissionRecord({
            schemaVersion: "dolly.module-submission-record/1",
            ...request,
            processGenerationId,
            createdAt: NOW,
          });
        },
        releaseDeliveryClaim: (identity) => core.releaseDeliveryClaim(identity),
        negativelyAcknowledgeDeliveryClaim: (request) =>
          core.negativelyAcknowledgeDeliveryClaim(request),
        getModuleSubmissionRecord: (runId) => core.getModuleSubmissionRecord(runId),
        commits,
        nextModuleGenerationId: () => `module-generation-${++moduleGeneration}`,
        monotonicNow: () => ++monotonicTime,
        createExecutor: (moduleGenerationId) => {
          let hostId = 0;
          const host = new ExtensionProcessHost({
            isolation: "process",
            trust: "trusted",
            isolationPolicy: new ExtensionIsolationPolicy(),
            manifest: {
              schemaVersion: "dolly.extension-package/1",
              extensionId: "com.example.fixture",
              packageVersion: "1.0.0",
              displayName: "Process test fixture",
              description: "Exercises a real child process in a runtime test.",
              supportedProtocolVersions: ["3.0"],
              entrypoint: "extension-process-fixture.mjs",
              modules: [{
                moduleKind: "fixture",
                activation: "reactive",
                configVersion: 1,
                configurationSchema: { type: "object" },
              }],
              requestedCapabilities: [],
            },
            command: process.execPath,
            args: [FIXTURE, "module-result-then-cancel"],
            workingDirectory: root,
            instanceId: "instance-real-process",
            moduleId: "worker",
            moduleGenerationId,
            moduleKind: "fixture",
            config: { markerPath: executionMarkerPath },
            maxFrameBytes: 128 * 1_024,
            initializationTimeoutMs: 2_000,
            shutdownRequestTimeoutMs: 500,
            forceKillDelayMs: 100,
            terminationTimeoutMs: 2_000,
            nextIdentifier: (purpose) => `${purpose}-${moduleGenerationId}-${++hostId}`,
          });
          hosts.push(host);
          return createExtensionProcessModuleExecutor(host, {
            moduleId: "worker",
            moduleGenerationId,
            executionTimeoutMs: 10_000,
            cancellationGraceMs: 1_000,
          });
        },
        classifyFailure,
      });

      await runtime.start();
      core.updateModuleProcessRecordState(processGenerationId, "running");
      const firstProcessId = hosts[0]?.snapshot.pid;
      expect(firstProcessId).toBeTypeOf("number");
      if (firstProcessId === undefined) {
        throw new Error("Expected the Extension process to have a process identifier");
      }

      const committed = await runtime.tick();
      expect(committed).toMatchObject({
        status: "committed",
        recovered: false,
        attempt: 1,
        moduleGenerationId: "module-generation-1",
        record: {
          state: "committed",
          source: { kind: "module", id: "worker" },
          outputDeliveries: [expect.objectContaining({ pageId: "output" })],
        },
      });
      if (committed.status !== "committed") {
        throw new Error("Expected the real child result to commit");
      }
      expect(core.deliveries.inspectClaim(committed).status).toBe("committed");
      expect(core.getModuleSubmissionRecord(committed.runId)).toBeUndefined();
      expect(repository.get(committed.moduleJobId)).toEqual(committed.record);
      if (committed.record.blockId === undefined) {
        throw new Error("Expected the real child result to create one Block");
      }
      expect(core.blocks.get(committed.record.blockId)).toMatchObject({
        source: { kind: "module", id: "worker" },
        payload: {
          value: {
            items: [
              expect.objectContaining({
                type: "text",
                text: "processed by the real child process",
              }),
            ],
          },
        },
      });

      const afterCommit = core.deliveries.snapshot();
      const committedInput = afterCommit.deliveries.find(
        (delivery) => delivery.record.deliveryId === firstInputDelivery.deliveryId,
      );
      expect(committedInput?.obligations).toContainEqual({
        consumerId: "worker",
        status: "acked",
      });

      const secondInputBlock = core.blocks.commit(proposal("second input"), {
        kind: "external",
        id: "console",
      });
      const secondInputDelivery = core.deliveries.append("input", secondInputBlock.id);
      const secondTick = runtime.tick();
      await vi.waitFor(() => expect(existsSync(executionMarkerPath)).toBe(true), {
        timeout: 2_000,
        interval: 5,
      });

      core.updateModuleProcessRecordState(processGenerationId, "stopping");
      const stop = runtime.stop();
      const cancelled = await secondTick;
      expect(cancelled).toMatchObject({
        status: "cancelled",
        reason: "shutdown",
        attempt: 1,
        moduleGenerationId: "module-generation-1",
      });
      if (cancelled.status !== "cancelled") {
        throw new Error("Expected orderly stop to cancel the active run");
      }
      await expect(stop).resolves.toBeUndefined();
      core.updateModuleProcessRecordState(processGenerationId, "stopped");

      expect(core.deliveries.inspectClaim(cancelled).status).toBe("released");
      expect(core.getModuleSubmissionRecord(cancelled.runId)).toBeUndefined();
      expect(classifyFailure).not.toHaveBeenCalled();
      expect(hosts).toHaveLength(1);
      expect(hosts[0]?.snapshot.state).toBe("stopped");
      expect(processIsAlive(firstProcessId)).toBe(false);

      const afterStop = core.deliveries.snapshot();
      const releasedInput = afterStop.deliveries.find(
        (delivery) => delivery.record.deliveryId === secondInputDelivery.deliveryId,
      );
      expect(releasedInput?.obligations).toContainEqual({
        consumerId: "worker",
        status: "pending",
      });
      expect(
        afterStop.moduleJobs.find(
          (moduleJob) => moduleJob.moduleJobId === cancelled.moduleJobId,
        ),
      ).toMatchObject({
        status: "ready",
        attempt: 1,
        failedAttemptCount: 0,
      });

      const reopenedCore = new FileCoreStateStore({
        path: coreStatePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `reopened-block-${++blockId}`,
        nextDeliveryId: (kind) => `reopened-${kind}-${++deliveryId}`,
        now: () => NOW,
      });
      const reopenedRepository = new FileModuleResultCommitRepository({
        path: commitRepositoryPath,
      });
      expect(reopenedCore.deliveries.inspectClaim(committed).status).toBe("committed");
      expect(reopenedCore.deliveries.inspectClaim(cancelled).status).toBe("released");
      expect(reopenedCore.getModuleSubmissionRecord(committed.runId)).toBeUndefined();
      expect(reopenedCore.getModuleSubmissionRecord(cancelled.runId)).toBeUndefined();
      expect(reopenedRepository.get(committed.moduleJobId)).toEqual(committed.record);
    } finally {
      if (runtime && runtime.state !== "stopped") {
        await runtime.stop({ cancellationGraceMs: 1_000 }).catch(() => undefined);
      }
      for (const host of hosts) {
        if (host.snapshot.state !== "stopped") {
          await host.terminate().catch(() => undefined);
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
