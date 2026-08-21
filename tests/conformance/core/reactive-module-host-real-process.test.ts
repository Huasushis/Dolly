import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import type { ModuleProcessRecord } from "../../../src/core/module-process-records.js";
import { seedLegacyProcessRecords } from "./fixtures/process-id-v19-cutover.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import { systemSchedulerClock } from "../../../src/core/module-scheduler.js";
import { createModuleResultCommitCoordinator } from "../../../src/core/module-result-commit-factory.js";
import {
  composeReactiveModuleHost,
  type ReactiveModuleHost,
  type ManagedReactiveModuleRuntime,
} from "../../../src/core/reactive-module-host.js";
import {
  ReactiveModuleRuntime,
  type ReactiveModuleFailure,
  type ReactiveModuleRuntimeOptions,
} from "../../../src/core/reactive-module-runtime.js";
import {
  createDefaultDollyInstanceConfig,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const NOW = "2026-08-09T00:00:00.000Z";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratchParent = resolve(repositoryRoot, "..", ".tmp");
const FIXTURE = fileURLToPath(
  new URL("../security/fixtures/extension-process-fixture.mjs", import.meta.url),
);
const MANIFEST: ExtensionPackageManifest = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: "com.example.fixture",
  packageVersion: "1.0.0",
  displayName: "Process test fixture",
  description: "Runs one real child behind the reactive Module host.",
  supportedProtocolVersions: ["3.0"],
  entrypoint: "extension-process-fixture.mjs",
  modules: [{
    moduleKind: "fixture",
    activation: "reactive",
    configVersion: 1,
    configurationSchema: { type: "object" },
  }],
  requestedCapabilities: [],
};

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

describe("reactive Module host with a real child process", () => {
  it("auto-wakes from a durable input and commits the child result through FileCore", async () => {
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    const root = mkdtempSync(join(scratchParent, "dolly-reactive-host-real-"));
    const processGenerationId = "process-generation-host-real-1";
    const moduleGenerationId = "module-generation-host-real-1";
    const extensionHosts: ExtensionProcessHost[] = [];
    let host: ReactiveModuleHost | undefined;
    let childPid: number | undefined;
    try {
      let blockId = 0;
      let deliveryId = 0;
      let nextGeneration = 1;
      let monotonic = 0;
      const coreStatePath = join(root, "core-state.json");
      const openCoreState = () =>
        new FileCoreStateStore({
          path: coreStatePath,
          maxFailedAttempts: 3,
          nextBlockId: () => `block-${++blockId}`,
          nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
          now: () => NOW,
        });
      const processRecordBody: ModuleProcessRecord = {
        schemaVersion: "dolly.module-process-record/1",
        instanceId: INSTANCE_ID,
        moduleId: "worker",
        moduleGenerationId,
        processGenerationId,
        packageDigest: `sha256:${"a".repeat(64)}`,
        configurationReference: {
          configId: "config-host-real",
          revision: `sha256:${"b".repeat(64)}`,
          configVersion: 1,
        },
        declaredExternalEffects: "none",
        serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
        bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
        moduleCgroupPath: deriveModuleCgroupPath(
          "/system.slice/dolly-core.service",
          {
            instanceId: INSTANCE_ID,
            moduleId: "worker",
            processGenerationId,
          },
        ).filesystemPath,
        state: "starting",
        createdAt: NOW,
        updatedAt: NOW,
      };
      // A legacy document can no longer accept caller-supplied process
      // records, so the fixture seeds the exact starting record into the
      // freshly created document before the store is reopened.
      const base = openCoreState();
      seedLegacyProcessRecords(coreStatePath, {
        processRecords: [processRecordBody],
      });
      void base;
      const core = openCoreState();
      core.deliveries.createPage("input");
      core.deliveries.createPage("output");
      core.deliveries.registerConsumer("input", "worker", "from-now");
      core.deliveries.registerConsumer("output", "sink", "from-now");
      const defaults = createDefaultDollyInstanceConfig(INSTANCE_ID);
      const configuration = validateDollyInstanceConfig({
        ...defaults,
        core: {
          ...defaults.core,
          scheduler: {
            pollIntervalMs: 100,
            retryBaseMs: 25,
            retryMaxMs: 250,
          },
        },
        pages: [{ pageId: "input" }, { pageId: "output" }],
        modules: [{
          moduleId: "worker",
          extensionId: "com.example.fixture",
          packageVersion: "1.0.0",
          moduleKind: "fixture",
          isolation: "process",
          configurationReference: {
            configId: "config-host-real",
            revision: `sha256:${"b".repeat(64)}`,
            configVersion: 1,
          },
          permissionPolicyIds: [],
          inputPageIds: ["input"],
          outputPageIds: ["output"],
          subscriptionStart: "from-now",
          activation: { kind: "reactive" },
          limits: {
            claim: { maxCount: 1, maxBytes: 64 * 1024 },
            maxInputBytes: 64 * 1024,
            maxResultBytes: 64 * 1024,
            maxFrameBytes: 128 * 1024,
            maxRunsPerGeneration: 10,
            maxGenerations: 2,
          },
          timeouts: {
            initializationTimeoutMs: 3_000,
            executionTimeoutMs: 10_000,
            cancellationGraceMs: 1_000,
            terminationTimeoutMs: 3_000,
          },
        }],
      });
      const repository = new FileModuleResultCommitRepository({
        path: join(root, "module-result-commits.json"),
      });
      const commits = createModuleResultCommitCoordinator({
        core,
        repository,
        now: () => NOW,
        mailboxes: [{
          consumerId: "sink",
          pageIds: ["output"],
          maxResidentCount: 10,
          maxResidentBytes: 1024 * 1024,
        }],
      });
      const runtimeDeliveries: ReactiveModuleRuntimeOptions["deliveries"] = {
        validateClaimPages: core.deliveries.validateClaimPages.bind(core.deliveries),
        validateOutputPages: core.deliveries.validateOutputPages.bind(core.deliveries),
        claim: core.deliveries.claim.bind(core.deliveries),
        flushPersistence: core.deliveries.flushPersistence.bind(core.deliveries),
        inspectClaim: core.deliveries.inspectClaim.bind(core.deliveries),
        inspectClaimInput: core.deliveries.inspectClaimInput.bind(core.deliveries),
      };
      const runtime = new ReactiveModuleRuntime({
        moduleId: "worker",
        initialModuleGenerationId: moduleGenerationId,
        inputPageIds: ["input"],
        outputPageIds: ["output"],
        claimMaxCount: 1,
        claimMaxBytes: 64 * 1024,
        maxInputBytes: 64 * 1024,
        maxResultBytes: 64 * 1024,
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
        nextModuleGenerationId: () => `module-generation-host-real-${++nextGeneration}`,
        monotonicNow: () => ++monotonic,
        createExecutor: (generationId) => {
          let hostId = 0;
          const extensionHost = new ExtensionProcessHost({
            isolation: "process",
            trust: "trusted",
            isolationPolicy: new ExtensionIsolationPolicy(),
            manifest: MANIFEST,
            command: process.execPath,
            args: [FIXTURE, "module-result-then-cancel"],
            workingDirectory: root,
            instanceId: INSTANCE_ID,
            moduleId: "worker",
            moduleGenerationId: generationId,
            moduleKind: "fixture",
            config: { markerPath: join(root, "unexpected-second-run") },
            maxFrameBytes: 128 * 1024,
            initializationTimeoutMs: 2_000,
            shutdownRequestTimeoutMs: 500,
            forceKillDelayMs: 100,
            terminationTimeoutMs: 2_000,
            nextIdentifier: (purpose) => `${purpose}-${generationId}-${++hostId}`,
          });
          extensionHosts.push(extensionHost);
          return createExtensionProcessModuleExecutor(extensionHost, {
            moduleId: "worker",
            moduleGenerationId: generationId,
            executionTimeoutMs: 10_000,
            cancellationGraceMs: 1_000,
          });
        },
        classifyFailure: (failure: ReactiveModuleFailure) => ({
          code: failure.code,
          retryable: true,
        }),
      });
      const managedRuntime: ManagedReactiveModuleRuntime = {
        get moduleGenerationId() {
          return runtime.moduleGenerationId;
        },
        tick: (limits) => runtime.tick(limits),
        start: async () => {
          await runtime.start();
          core.updateModuleProcessRecordState(processGenerationId, "running");
        },
        stop: async () => {
          if (core.getModuleProcessRecord(processGenerationId)?.state === "running") {
            core.updateModuleProcessRecordState(processGenerationId, "stopping");
          }
          await runtime.stop();
        },
      };
      host = composeReactiveModuleHost({
        configuration,
        deliveries: core.deliveries,
        clock: systemSchedulerClock(),
        scheduling: {
          maxConcurrentModules: 1,
          backpressureAction: "pause-upstream",
          downstreamRecheckMs: 100,
          noProgressAfterMs: 5_000,
          claimLimitCount: 1,
          claimLimitBytes: 64 * 1024,
          retryJitterRatio: 0,
          lowWatermarkRatio: 1,
        },
        registrations: [{
          moduleId: "worker",
          runtime: managedRuntime,
          mailbox: { maxResidentCount: 10, maxResidentBytes: 1024 * 1024 },
          manifest: MANIFEST,
        }],
      });

      await host.start();
      childPid = extensionHosts[0]?.snapshot.pid;
      expect(childPid).toBeTypeOf("number");
      const inputBlock = core.blocks.commit(proposal("wake the real child"), {
        kind: "external",
        id: "console",
      });
      core.deliveries.append("input", inputBlock.id);

      await vi.waitFor(() => {
        expect(core.deliveries.inspectPending("sink", ["output"]).pendingCount).toBe(1);
      }, { timeout: 3_000, interval: 5 });
      const records = repository.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        state: "committed",
        source: { kind: "module", id: "worker" },
        outputDeliveries: [expect.objectContaining({ pageId: "output" })],
      });
      expect(core.deliveries.inspectPending("worker", ["input"]).pendingCount).toBe(0);
      expect(core.listModuleSubmissionRecords()).toEqual([]);

      await host.stop();
      expect(host.state).toBe("stopped");
      expect(extensionHosts[0]?.snapshot.state).toBe("stopped");
      expect(processIsAlive(childPid!)).toBe(false);
      // This test observes the exact child, not the Linux delegated cgroup, so
      // it deliberately does not forge a durable `stopped` process record.
      expect(core.getModuleProcessRecord(processGenerationId)?.state).toBe("stopping");
    } finally {
      if (host && host.state === "running") {
        await host.stop().catch(() => undefined);
      }
      for (const extensionHost of extensionHosts) {
        if (extensionHost.snapshot.state !== "stopped") {
          await extensionHost.terminate().catch(() => undefined);
        }
      }
      if (childPid !== undefined && processIsAlive(childPid)) {
        throw new Error(`Recorded child process ${childPid} remained alive after cleanup`);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
