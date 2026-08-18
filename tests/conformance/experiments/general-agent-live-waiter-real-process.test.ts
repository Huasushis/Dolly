import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createExtensionProcessModuleExecutor } from "../../../src/adapters/extension-process-module-executor.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
} from "../../../src/core/extension-process-host.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import { ModuleScheduler, systemSchedulerClock } from "../../../src/core/module-scheduler.js";
import { ModuleResultCommitCoordinator } from "../../../src/core/module-result-commit.js";
import {
  ReactiveModuleHost,
  type ManagedReactiveModuleRuntime,
} from "../../../src/core/reactive-module-host.js";
import {
  ReactiveModuleRuntime,
  type ReactiveModuleFailure,
  type ReactiveModuleRuntimeOptions,
} from "../../../src/core/reactive-module-runtime.js";
import { waitForAgentCase } from "../../../scripts/experiments/probes/general-agent-live-v0/wait-for-case.mjs";

const NOW = "2026-08-10T00:00:00.000Z";
const FIXTURE = fileURLToPath(
  new URL("../security/fixtures/extension-process-fixture.mjs", import.meta.url),
);

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

describe("general Agent waiter with a real quarantined Extension", () => {
  it("surfaces an unknown capability outcome without commit, retry, or dead letter", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-agent-quarantine-real-process-"));
    const instanceId = "instance-agent-quarantine";
    const moduleId = "agent-quarantine";
    const moduleGenerationId = "module-generation-agent-quarantine";
    const processGenerationId = "process-generation-agent-quarantine";
    let blockSequence = 0;
    let deliverySequence = 0;
    let identifierSequence = 0;
    let monotonicTime = 0;
    let childProcessId: number | undefined;
    let reactiveHost: ReactiveModuleHost | undefined;
    let runtime: ReactiveModuleRuntime | undefined;
    let extensionHost: ExtensionProcessHost | undefined;

    try {
      const core = new FileCoreStateStore({
        path: join(root, "core-state.json"),
        maxFailedAttempts: 3,
        nextBlockId: () => `block-agent-quarantine-${++blockSequence}`,
        nextDeliveryId: (kind) => `${kind}-agent-quarantine-${++deliverySequence}`,
        now: () => NOW,
      });
      core.deliveries.createPage("input");
      core.deliveries.createPage("output");
      core.deliveries.registerConsumer("input", moduleId, "from-now");
      core.deliveries.registerConsumer("output", "sink", "from-now");
      core.appendModuleProcessRecord({
        schemaVersion: "dolly.module-process-record/1",
        instanceId,
        moduleId,
        moduleGenerationId,
        processGenerationId,
        packageDigest: `sha256:${"6".repeat(64)}`,
        configurationReference: {
          configId: "config-agent-quarantine",
          revision: `sha256:${"7".repeat(64)}`,
          configVersion: 1,
        },
        declaredExternalEffects: "core-capabilities-only",
        serviceInvocationId: "6812432ad29e4d3bbd6776c62cafa929",
        bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
        moduleCgroupPath: deriveModuleCgroupPath(
          "/system.slice/dolly-core.service",
          { instanceId, moduleId, processGenerationId },
        ).filesystemPath,
        state: "starting",
        createdAt: NOW,
        updatedAt: NOW,
      });

      const repository = new FileModuleResultCommitRepository({
        path: join(root, "module-result-commits.json"),
      });
      const operations = core.createModuleResultCommitOperations();
      const commits = new ModuleResultCommitCoordinator({
        ...operations,
        repository,
        now: () => NOW,
      });
      const capabilityHandler = vi.fn(async () => ({ fromHost: true }));
      extensionHost = new ExtensionProcessHost({
        isolation: "process",
        trust: "trusted",
        isolationPolicy: new ExtensionIsolationPolicy(),
        manifest: {
          schemaVersion: "dolly.extension-package/1",
          extensionId: "com.example.agent-quarantine",
          packageVersion: "1.0.0",
          displayName: "Agent quarantine fixture",
          description: "Calls a capability and then reports a business error.",
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
        args: [FIXTURE, "capability-then-business-error"],
        workingDirectory: root,
        instanceId,
        moduleId,
        moduleGenerationId,
        moduleKind: "fixture",
        config: {},
        maxFrameBytes: 128 * 1_024,
        initializationTimeoutMs: 3_000,
        shutdownRequestTimeoutMs: 500,
        forceKillDelayMs: 100,
        terminationTimeoutMs: 3_000,
        nextIdentifier: (purpose) =>
          purpose === "process-generation"
            ? processGenerationId
            : `${purpose}-agent-quarantine-${++identifierSequence}`,
      });
      extensionHost.grantCapability(
        {
          capabilityType: "private-storage",
          capabilityVersion: "v1",
          operations: ["read"],
          resourceScope: {
            descriptor: "agent-quarantine-fixture",
            executionScope: "active-run",
          },
          expiresAt: "2099-01-01T00:00:00.000Z",
          maxInvocations: 1,
          maxConcurrentInvocations: 1,
          maxArgumentBytes: 256,
          maxResultBytes: 256,
          requireIdempotencyKey: true,
        },
        capabilityHandler,
      );
      const executor = createExtensionProcessModuleExecutor(extensionHost, {
        moduleId,
        moduleGenerationId,
        executionTimeoutMs: 5_000,
        cancellationGraceMs: 500,
      });
      const deliveries: ReactiveModuleRuntimeOptions["deliveries"] = {
        validateClaimPages: core.deliveries.validateClaimPages.bind(core.deliveries),
        validateOutputPages: core.deliveries.validateOutputPages.bind(core.deliveries),
        claim: core.deliveries.claim.bind(core.deliveries),
        flushPersistence: core.deliveries.flushPersistence.bind(core.deliveries),
        inspectClaim: core.deliveries.inspectClaim.bind(core.deliveries),
        inspectClaimInput: core.deliveries.inspectClaimInput.bind(core.deliveries),
      };
      const classifyFailure = vi.fn((failure: ReactiveModuleFailure) => ({
        code: failure.code,
        retryable: true,
      }));
      runtime = new ReactiveModuleRuntime({
        moduleId,
        initialModuleGenerationId: moduleGenerationId,
        inputPageIds: ["input"],
        outputPageIds: ["output"],
        claimMaxCount: 1,
        claimMaxBytes: 64 * 1_024,
        maxInputBytes: 64 * 1_024,
        maxResultBytes: 64 * 1_024,
        executionTimeoutMs: 5_000,
        cancellationGraceMs: 500,
        initializationTimeoutMs: 3_000,
        terminationTimeoutMs: 3_000,
        maxRunsPerGeneration: 1,
        maxGenerations: 1,
        declaredExternalEffects: "core-capabilities-only",
        deliveries,
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
        nextModuleGenerationId: () => "unused-module-generation",
        monotonicNow: () => ++monotonicTime,
        createExecutor: () => executor,
        classifyFailure,
      });
      const managedRuntime: ManagedReactiveModuleRuntime = {
        get moduleGenerationId() {
          return runtime!.moduleGenerationId;
        },
        tick: (limits) => runtime!.tick(limits),
        start: async () => {
          await runtime!.start();
          core.updateModuleProcessRecordState(processGenerationId, "running");
        },
        stop: async () => {
          if (core.getModuleProcessRecord(processGenerationId)?.state === "running") {
            core.updateModuleProcessRecordState(processGenerationId, "stopping");
          }
          await runtime!.stop();
        },
      };
      const scheduler = new ModuleScheduler({
        instanceId,
        deliveries: core.deliveries,
        clock: systemSchedulerClock(),
        pollIntervalMs: 1_000,
        retryBaseMs: 100,
        retryMaxMs: 1_000,
        maxConcurrentModules: 1,
        backpressureAction: "pause-upstream",
        downstreamRecheckMs: 100,
        noProgressAfterMs: 10_000,
        claimLimitCount: 1,
        claimLimitBytes: 64 * 1_024,
        retryJitterRatio: 0,
      });
      reactiveHost = new ReactiveModuleHost(scheduler, [{
        moduleId,
        runtime: managedRuntime,
        inputPageIds: ["input"],
        outputPageIds: ["output"],
        mailbox: { maxResidentCount: 4, maxResidentBytes: 1024 * 1024 },
      }]);

      await reactiveHost.start();
      childProcessId = extensionHost.snapshot.pid;
      expect(childProcessId).toBeTypeOf("number");
      const input = core.blocks.commit(
        {
          payload: {
            schema: "dolly.content/1",
            value: {
              items: [{ type: "text", text: "exercise failure", format: "plain" }],
            },
          },
        },
        { kind: "external", id: "test" },
      );
      core.deliveries.append("input", input.id);

      const waitStartedAt = Date.now();
      await expect(
        waitForAgentCase({
          findCommitted: () =>
            repository.list().find((record) => record.state === "committed"),
          listDeadLetters: () => core.deliveries.listDeadLetters(),
          readSchedulerStatus: () => scheduler.status(moduleId),
          timeoutMs: 10_000,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrowError(
        "Module was quarantined: RECOVERY_REQUIRED:external-effect-outcome-unknown",
      );
      expect(Date.now() - waitStartedAt).toBeLessThan(2_000);
      expect(scheduler.status(moduleId)).toMatchObject({
        schedulingState: "quarantined",
        quarantineReason: "RECOVERY_REQUIRED:external-effect-outcome-unknown",
      });
      const claimedObligations = core.deliveries.snapshot().deliveries.flatMap(
        (delivery) => delivery.obligations.filter(
          (obligation) => obligation.consumerId === moduleId && obligation.status === "claimed",
        ),
      );
      expect(claimedObligations).toHaveLength(1);
      expect(core.listModuleSubmissionRecords()).toHaveLength(1);
      expect(repository.list()).toEqual([]);
      expect(core.deliveries.listDeadLetters()).toEqual([]);
      expect(capabilityHandler).toHaveBeenCalledOnce();
      expect(classifyFailure).not.toHaveBeenCalled();

      await expect(reactiveHost.stop()).rejects.toMatchObject({
        errors: [expect.objectContaining({ code: "RUNTIME_RECOVERY_REQUIRED" })],
      });
      expect(reactiveHost.state).toBe("failed");
      expect(childProcessId === undefined ? true : processIsAlive(childProcessId)).toBe(false);
    } finally {
      if (reactiveHost?.state === "running" || reactiveHost?.state === "failed") {
        await reactiveHost.stop().catch(() => undefined);
      } else if (runtime && runtime.state !== "stopped") {
        await runtime.stop().catch(() => undefined);
      }
      if (extensionHost && extensionHost.snapshot.state !== "stopped") {
        await extensionHost.terminate().catch(() => undefined);
      }
      if (childProcessId !== undefined && processIsAlive(childProcessId)) {
        throw new Error(`Recorded Extension child ${childProcessId} remained alive`);
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
