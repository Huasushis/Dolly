/**
 * Proves the product-before-bootstrap Scheduler vertical slice in the exact
 * delegated Linux service environment. The public bootstrap refusal remains
 * closed; this test calls the candidate composition boundary directly.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  composeInstalledReactiveModuleHost,
  type InstalledReactiveModuleHost,
} from "../../../src/adapters/installed-reactive-module-runtime.js";
import { defaultLauncherScriptPath } from "../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js";
import type { BlockProposal } from "../../../src/core/block-store.js";
import { ExtensionIsolationPolicy } from "../../../src/core/extension-process-host.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import {
  FileCoreStateStore,
  createFileCoreStateStoreWithStoppedRecordWriter,
} from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import {
  deriveModuleCgroupPath,
  prepareDelegatedCgroupRoot,
  type ModuleCgroupLimits,
} from "../../../src/core/linux-module-cgroup.js";
import { inspectCoreServiceBinding } from "../../../src/core/linux-core-service-binding.js";
import {
  systemSchedulerClock,
  type SchedulerEvent,
} from "../../../src/core/module-scheduler.js";
import { ModuleConfigurationStore } from "../../../src/core/module-configuration-store.js";
import {
  createDefaultDollyInstanceConfig,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const PYTHON = "/usr/bin/python3";
const INSTANCE_ID = "44444444-4444-4444-8444-444444444444";
const MODULE_ID = "scheduler-worker";
const MODULE_GENERATION_ID = "scheduler-module-generation-1";
const LIMITS: ModuleCgroupLimits = {
  memoryMaxBytes: 268_435_456,
  maxProcesses: 64,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/installed-reactive-module-fixture.mjs", import.meta.url),
);

function delegatedRootCgroupPath(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((candidate) => candidate.startsWith("0::"));
    if (line === undefined) return undefined;
    const path = line.slice("0::".length);
    return path.endsWith("/core") ? path.slice(0, -"/core".length) : undefined;
  } catch {
    return undefined;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function proposal(text: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "text", text, format: "plain" }] },
    },
  };
}

const delegatedRoot = delegatedRootCgroupPath();
const integrationUnitName = process.env.DOLLY_LINUX_MODULE_INTEGRATION_UNIT;
const available = delegatedRoot !== undefined && existsSync(PYTHON);
if (process.env.DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED === "1" && !available) {
  throw new Error(
    "The installed Scheduler integration requires its delegated systemd service and Python launcher interpreter",
  );
}
if (
  process.env.DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED === "1" &&
  integrationUnitName === undefined
) {
  throw new Error("The installed Scheduler integration did not receive its exact Core service unit");
}

describe.skipIf(!available)("installed reactive Module host in a real control group", () => {
  it("auto-wakes one installed process Module and reopens its committed output", async () => {
    if (integrationUnitName === undefined) {
      throw new Error("The transient Core service unit name is unavailable");
    }
    const inspectedBinding = await inspectCoreServiceBinding({
      unitName: integrationUnitName,
      mode: "user",
      queryTimeoutMs: 5_000,
      overallTimeoutMs: 15_000,
    });
    if (!inspectedBinding.verified) {
      throw new Error(inspectedBinding.failures
        .map((failure) => `${failure.code}: ${failure.detail}`)
        .join("; "));
    }
    expect(inspectedBinding.binding.delegatedRootCgroupPath).toBe(delegatedRoot);
    const preparedRoot = await prepareDelegatedCgroupRoot({
      delegatedRootCgroupPath: inspectedBinding.binding.delegatedRootCgroupPath,
    });
    if (!preparedRoot.prepared) {
      throw new Error(`${preparedRoot.failure.code}: ${preparedRoot.failure.detail}`);
    }

    const scratchParent = resolve(process.cwd(), ".tmp");
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(scratchParent, "installed-reactive-host-integration-"));
    const statePath = join(scratch, "core-state.json");
    const commitPath = join(scratch, "module-result-commits.json");
    const processGenerationId = `scheduler-process-${process.pid}-${Date.now()}`;
    const moduleCgroupPath = deriveModuleCgroupPath(
      inspectedBinding.binding.delegatedRootCgroupPath,
      { instanceId: INSTANCE_ID, moduleId: MODULE_ID, processGenerationId },
    ).filesystemPath;
    let composed: InstalledReactiveModuleHost | undefined;
    let stopped = false;
    try {
      const packageSource = join(scratch, "package-source");
      mkdirSync(packageSource, { recursive: true, mode: 0o700 });
      copyFileSync(FIXTURE_PATH, join(packageSource, "extension.mjs"));
      const configurationSchema = {
        $schema: JSON_SCHEMA_2020_12,
        type: "object",
        properties: { prefix: { type: "string" } },
        required: ["prefix"],
        additionalProperties: false,
      } as const;
      writeFileSync(join(packageSource, "dolly-extension.json"), JSON.stringify({
        schemaVersion: "dolly.extension-package/1",
        extensionId: "org.example.scheduler-installed",
        packageVersion: "1.0.0",
        displayName: "Installed Scheduler integration fixture",
        description: "Returns one output through the installed Scheduler composition.",
        supportedProtocolVersions: ["3.0"],
        entrypoint: "extension.mjs",
        modules: [{
          moduleKind: "transform",
          activation: "reactive",
          configVersion: 1,
          configurationSchema,
        }],
        requestedCapabilities: [],
      }), "utf8");
      const installations = new ExtensionInstallationRegistry({
        directory: join(scratch, "installations"),
      });
      const installed = installations.installNodePackage({
        sourceDirectory: packageSource,
        trust: "trusted",
      });
      rmSync(packageSource, { recursive: true, force: true });
      const configurations = new ModuleConfigurationStore({
        directory: join(scratch, "configurations"),
      });
      const moduleConfiguration = configurations.create({
        configId: "scheduler-installed-config",
        extensionId: "org.example.scheduler-installed",
        moduleKind: "transform",
        configVersion: 1,
        schema: configurationSchema,
        configuration: { prefix: "scheduled" },
      });
      const defaults = createDefaultDollyInstanceConfig(INSTANCE_ID);
      const configuration = validateDollyInstanceConfig({
        ...defaults,
        core: {
          ...defaults.core,
          scheduler: {
            pollIntervalMs: 60_000,
            retryBaseMs: 25,
            retryMaxMs: 250,
          },
        },
        pages: [{ pageId: "input" }, { pageId: "output" }],
        modules: [{
          moduleId: MODULE_ID,
          extensionId: "org.example.scheduler-installed",
          packageVersion: "1.0.0",
          moduleKind: "transform",
          isolation: "process",
          configurationReference: {
            configId: moduleConfiguration.configId,
            revision: moduleConfiguration.revision,
            configVersion: moduleConfiguration.configVersion,
          },
          permissionPolicyIds: [],
          inputPageIds: ["input"],
          outputPageIds: ["output"],
          subscriptionStart: "from-now",
          activation: { kind: "reactive" },
          limits: {
            claim: { maxCount: 1, maxBytes: 64 * 1_024 },
            maxInputBytes: 64 * 1_024,
            maxResultBytes: 64 * 1_024,
            maxFrameBytes: 128 * 1_024,
            maxRunsPerGeneration: 10,
            maxGenerations: 2,
          },
          timeouts: {
            initializationTimeoutMs: 10_000,
            executionTimeoutMs: 5_000,
            cancellationGraceMs: 1_000,
            terminationTimeoutMs: 10_000,
          },
        }],
      });

      let blockId = 0;
      let deliveryId = 0;
      let moduleGeneration = 1;
      let protocolIdentifier = 0;
      const now = (): string => new Date().toISOString();
      const coreState = createFileCoreStateStoreWithStoppedRecordWriter({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `scheduler-block-${++blockId}`,
        nextDeliveryId: (kind) => `scheduler-${kind}-${++deliveryId}`,
        now,
      });
      coreState.store.deliveries.createPage("input");
      coreState.store.deliveries.createPage("output");
      coreState.store.deliveries.registerConsumer("input", MODULE_ID, "from-now");
      coreState.store.deliveries.registerConsumer("output", "sink", "from-now");
      const repository = new FileModuleResultCommitRepository({ path: commitPath });
      const events: SchedulerEvent[] = [];
      composed = composeInstalledReactiveModuleHost({
        configuration,
        installations,
        configurations,
        coreState,
        mailboxes: [{
          consumerId: MODULE_ID,
          pageIds: ["input"],
          maxResidentCount: 10,
          maxResidentBytes: 1024 * 1024,
        }, {
          consumerId: "sink",
          pageIds: ["output"],
          maxResidentCount: 10,
          maxResidentBytes: 1024 * 1024,
        }],
        clock: systemSchedulerClock(),
        scheduling: {
          maxConcurrentModules: 1,
          backpressureAction: "pause-upstream",
          downstreamRecheckMs: 100,
          noProgressAfterMs: 5_000,
          claimLimitCount: 1,
          claimLimitBytes: 64 * 1_024,
          retryJitterRatio: 0,
          lowWatermarkRatio: 1,
        },
        runtime: {
          resultCommitRepository: repository,
          now,
          initialModuleGenerationId: MODULE_GENERATION_ID,
          nextModuleGenerationId: () =>
            `scheduler-module-generation-${++moduleGeneration}`,
          binding: inspectedBinding.binding,
          lifecycle: { limits: LIMITS, maxOpenFiles: 64 },
          declaredExternalEffects: "none",
          launcher: {
            interpreterProgram: PYTHON,
            launcherScriptPath: defaultLauncherScriptPath(),
            controllerTimeouts: {
              configureTimeoutMs: 5_000,
              inCgroupTimeoutMs: 5_000,
              membershipTimeoutMs: 5_000,
              exitObservationTimeoutMs: 5_000,
            },
          },
          host: {
            isolationPolicy: new ExtensionIsolationPolicy(),
            shutdownRequestTimeoutMs: 2_000,
            forceKillDelayMs: 500,
          },
          channelCloseTimeoutMs: 5_000,
          nextProcessGenerationId: () => processGenerationId,
          nextProtocolIdentifier: (purpose) =>
            `${purpose}-scheduler-installed-${++protocolIdentifier}`,
          classifyFailure: (failure) => ({ code: failure.code, retryable: false }),
        },
        onSchedulerEvent: (event) => events.push(event),
      });

      await composed.host.start();
      expect(await waitFor(
        () => events.some((event) =>
          event.type === "scheduler.decision" &&
          event.moduleId === MODULE_ID &&
          !event.eligible
        ),
        2_000,
      )).toBe(true);
      expect(coreState.store.getModuleProcessRecord(processGenerationId)).toMatchObject({
        state: "running",
        packageDigest: installed.packageDigest,
      });
      expect(existsSync(moduleCgroupPath)).toBe(true);

      const input = coreState.store.blocks.commit(proposal("wake after the empty pass"), {
        kind: "external",
        id: "scheduler-integration",
      });
      coreState.store.deliveries.append("input", input.id);
      expect(await waitFor(
        () =>
          coreState.store.deliveries.inspectPending("sink", ["output"]).pendingCount === 1,
        5_000,
      )).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({
        type: "scheduler.dispatched",
        moduleId: MODULE_ID,
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "scheduler.settled",
        moduleId: MODULE_ID,
        tickStatus: "committed",
      }));
      expect(repository.list()).toHaveLength(1);
      expect(repository.list()[0]).toMatchObject({ state: "committed" });

      await composed.host.stop();
      stopped = true;
      expect(composed.host.state).toBe("stopped");
      expect(coreState.store.getModuleProcessRecord(processGenerationId)).toMatchObject({
        state: "stopped",
        packageDigest: installed.packageDigest,
        moduleCgroupPath,
      });
      expect(existsSync(moduleCgroupPath)).toBe(false);

      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `reopened-block-${++blockId}`,
        nextDeliveryId: (kind) => `reopened-${kind}-${++deliveryId}`,
        now,
      });
      const reopenedRepository = new FileModuleResultCommitRepository({ path: commitPath });
      const committed = reopenedRepository.list()[0];
      expect(committed).toMatchObject({
        state: "committed",
        source: { kind: "module", id: MODULE_ID },
        outputDeliveries: [expect.objectContaining({ pageId: "output" })],
      });
      if (committed?.blockId === undefined) {
        throw new Error("The reopened result commit does not reference its output Block");
      }
      expect(reopened.blocks.get(committed.blockId)).toMatchObject({
        payload: {
          value: {
            items: [expect.objectContaining({ type: "text", text: "scheduled:1" })],
          },
        },
      });
      expect(reopened.deliveries.inspectPending("sink", ["output"]).pendingCount).toBe(1);
      expect(reopened.getModuleProcessRecord(processGenerationId)?.state).toBe("stopped");

      console.info(JSON.stringify({
        packageDigest: installed.packageDigest,
        processGenerationId,
        moduleCgroupPath,
        initialEmptyDecisionObserved: true,
        configuredPollIntervalMs: 60_000,
        outputCommittedWithinMs: 5_000,
        finalRecordState: reopened.getModuleProcessRecord(processGenerationId)?.state,
        cgroupRemoved: !existsSync(moduleCgroupPath),
        reopenedOutput: "scheduled:1",
      }));
    } finally {
      if (!stopped && composed !== undefined &&
        (composed.host.state === "running" || composed.host.state === "failed")) {
        await composed.host.stop().catch(() => undefined);
      }
      if (existsSync(moduleCgroupPath)) {
        throw new Error(`Exact Module control group remained after cleanup: ${moduleCgroupPath}`);
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 90_000);
});
