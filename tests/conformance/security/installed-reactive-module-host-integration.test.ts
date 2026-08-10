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
import type { ModuleActorEvent } from "../../../src/core/module-actor.js";
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
const FIRST_MODULE_ID = "scheduler-first";
const SECOND_MODULE_ID = "scheduler-second";
const DRAINER_MODULE_ID = "scheduler-drainer";
const MODULE_IDS = [FIRST_MODULE_ID, SECOND_MODULE_ID, DRAINER_MODULE_ID] as const;
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
  it("recovers a full downstream mailbox without re-executing its producers", async () => {
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
    const processGenerationIds = MODULE_IDS.map((moduleId) =>
      `${moduleId}-process-${process.pid}-${Date.now()}`
    );
    const moduleCgroupPaths = MODULE_IDS.map((moduleId, index) =>
      deriveModuleCgroupPath(
        inspectedBinding.binding.delegatedRootCgroupPath,
        {
          instanceId: INSTANCE_ID,
          moduleId,
          processGenerationId: processGenerationIds[index]!,
        },
      ).filesystemPath
    );
    let composed: InstalledReactiveModuleHost | undefined;
    let stopped = false;
    try {
      const packageSource = join(scratch, "package-source");
      mkdirSync(packageSource, { recursive: true, mode: 0o700 });
      copyFileSync(FIXTURE_PATH, join(packageSource, "extension.mjs"));
      const configurationSchema = {
        $schema: JSON_SCHEMA_2020_12,
        type: "object",
        properties: {
          prefix: { type: "string" },
          delayMs: { type: "integer", minimum: 0 },
          emitOutput: { type: "boolean" },
        },
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
      const firstConfiguration = configurations.create({
        configId: "scheduler-first-config",
        extensionId: "org.example.scheduler-installed",
        moduleKind: "transform",
        configVersion: 1,
        schema: configurationSchema,
        configuration: { prefix: "first" },
      });
      const secondConfiguration = configurations.create({
        configId: "scheduler-second-config",
        extensionId: "org.example.scheduler-installed",
        moduleKind: "transform",
        configVersion: 1,
        schema: configurationSchema,
        configuration: { prefix: "second" },
      });
      const drainerConfiguration = configurations.create({
        configId: "scheduler-drainer-config",
        extensionId: "org.example.scheduler-installed",
        moduleKind: "transform",
        configVersion: 1,
        schema: configurationSchema,
        configuration: { prefix: "drainer", delayMs: 2_000, emitOutput: false },
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
        pages: [{ pageId: "input" }, { pageId: "middle" }, { pageId: "output" }],
        modules: [{
          moduleId: FIRST_MODULE_ID,
          extensionId: "org.example.scheduler-installed",
          packageVersion: "1.0.0",
          moduleKind: "transform",
          isolation: "process",
          configurationReference: {
            configId: firstConfiguration.configId,
            revision: firstConfiguration.revision,
            configVersion: firstConfiguration.configVersion,
          },
          permissionPolicyIds: [],
          inputPageIds: ["input"],
          outputPageIds: ["middle"],
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
        }, {
          moduleId: SECOND_MODULE_ID,
          extensionId: "org.example.scheduler-installed",
          packageVersion: "1.0.0",
          moduleKind: "transform",
          isolation: "process",
          configurationReference: {
            configId: secondConfiguration.configId,
            revision: secondConfiguration.revision,
            configVersion: secondConfiguration.configVersion,
          },
          permissionPolicyIds: [],
          inputPageIds: ["middle"],
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
        }, {
          moduleId: DRAINER_MODULE_ID,
          extensionId: "org.example.scheduler-installed",
          packageVersion: "1.0.0",
          moduleKind: "transform",
          isolation: "process",
          configurationReference: {
            configId: drainerConfiguration.configId,
            revision: drainerConfiguration.revision,
            configVersion: drainerConfiguration.configVersion,
          },
          permissionPolicyIds: [],
          inputPageIds: ["output"],
          outputPageIds: [],
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
      let protocolIdentifier = 0;
      let processGenerationIndex = 0;
      const now = (): string => new Date().toISOString();
      const coreState = createFileCoreStateStoreWithStoppedRecordWriter({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `scheduler-block-${++blockId}`,
        nextDeliveryId: (kind) => `scheduler-${kind}-${++deliveryId}`,
        now,
      });
      coreState.store.deliveries.createPage("input");
      coreState.store.deliveries.createPage("middle");
      coreState.store.deliveries.createPage("output");
      coreState.store.deliveries.registerConsumer("input", FIRST_MODULE_ID, "from-now");
      coreState.store.deliveries.registerConsumer("middle", SECOND_MODULE_ID, "from-now");
      coreState.store.deliveries.registerConsumer("output", DRAINER_MODULE_ID, "from-now");
      const repository = new FileModuleResultCommitRepository({ path: commitPath });
      const events: SchedulerEvent[] = [];
      const actorEvents: ModuleActorEvent[] = [];
      composed = composeInstalledReactiveModuleHost({
        configuration,
        installations,
        configurations,
        coreState,
        mailboxes: [{
          consumerId: FIRST_MODULE_ID,
          pageIds: ["input"],
          maxResidentCount: 10,
          maxResidentBytes: 1024 * 1024,
        }, {
          consumerId: SECOND_MODULE_ID,
          pageIds: ["middle"],
          maxResidentCount: 10,
          maxResidentBytes: 1024 * 1024,
        }, {
          consumerId: DRAINER_MODULE_ID,
          pageIds: ["output"],
          maxResidentCount: 1,
          maxResidentBytes: 1024 * 1024,
        }],
        clock: systemSchedulerClock(),
        scheduling: {
          maxConcurrentModules: 3,
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
          initialModuleGenerationIdFor: (moduleId) => `${moduleId}-generation-1`,
          nextModuleGenerationIdFor: (moduleId) => `${moduleId}-generation-2`,
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
          nextProcessGenerationId: () => {
            const next = processGenerationIds[processGenerationIndex++];
            if (next === undefined) {
              throw new Error("The integration attempted an unexpected process generation");
            }
            return next;
          },
          nextProtocolIdentifier: (purpose) =>
            `${purpose}-scheduler-installed-${++protocolIdentifier}`,
          classifyFailure: (failure) => ({ code: failure.code, retryable: false }),
          onActorEvent: (event) => actorEvents.push(event),
        },
        onSchedulerEvent: (event) => events.push(event),
      });

      await composed.host.start();
      expect(await waitFor(
        () => MODULE_IDS.every((moduleId) => events.some((event) =>
          event.type === "scheduler.decision" && event.moduleId === moduleId && !event.eligible
        )),
        2_000,
      )).toBe(true);
      expect(composed.installedRuntimes).toHaveLength(3);
      MODULE_IDS.forEach((moduleId, index) => {
        expect(
          composed?.installedRuntimes[index]?.generations.processGenerationIdFor(
            `${moduleId}-generation-1`,
          ),
        ).toBe(processGenerationIds[index]);
        expect(coreState.store.getModuleProcessRecord(processGenerationIds[index]!))
          .toMatchObject({ state: "running", packageDigest: installed.packageDigest });
        expect(existsSync(moduleCgroupPaths[index]!)).toBe(true);
      });

      const input = coreState.store.blocks.commit(proposal("wake after the empty pass"), {
        kind: "external",
        id: "scheduler-integration",
      });
      coreState.store.deliveries.append("input", input.id);
      expect(await waitFor(
        () =>
          repository.list().length === 2 &&
          coreState.store.deliveries.inspectResident(DRAINER_MODULE_ID, ["output"])
              .claimedCount === 1,
        5_000,
      )).toBe(true);
      for (const moduleId of [FIRST_MODULE_ID, SECOND_MODULE_ID]) {
        expect(events).toContainEqual(expect.objectContaining({
          type: "scheduler.dispatched",
          moduleId,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          type: "scheduler.settled",
          moduleId,
          tickStatus: "committed",
        }));
      }
      expect(repository.list()).toHaveLength(2);
      expect(repository.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: "committed", source: { kind: "module", id: FIRST_MODULE_ID } }),
        expect.objectContaining({ state: "committed", source: { kind: "module", id: SECOND_MODULE_ID } }),
      ]));
      const actorRunCount = (moduleId: string): number => {
        const consumers = new Map(coreState.store.deliveries.snapshot().moduleJobs.map((job) =>
          [job.moduleJobId, job.consumerId]
        ));
        return actorEvents.filter((event) =>
          event.type === "run.started" && consumers.get(event.moduleJobId) === moduleId
        ).length;
      };
      expect(actorRunCount(FIRST_MODULE_ID)).toBe(1);
      expect(actorRunCount(SECOND_MODULE_ID)).toBe(1);
      expect(actorRunCount(DRAINER_MODULE_ID)).toBe(1);

      const secondInput = coreState.store.blocks.commit(proposal("fill the sink boundary"), {
        kind: "external",
        id: "scheduler-integration",
      });
      coreState.store.deliveries.append("input", secondInput.id);
      expect(await waitFor(
        () => events.some((event) =>
          event.type === "scheduler.settled" &&
          event.moduleId === SECOND_MODULE_ID &&
          event.tickStatus === "output-backpressured"
        ),
        5_000,
      )).toBe(true);
      expect(actorRunCount(FIRST_MODULE_ID)).toBe(2);
      expect(actorRunCount(SECOND_MODULE_ID)).toBe(2);
      expect(actorRunCount(DRAINER_MODULE_ID)).toBe(1);
      expect(repository.list()).toHaveLength(4);
      expect(repository.list().filter((record) => record.state === "prepared"))
        .toHaveLength(1);
      expect(coreState.store.deliveries.inspectResident(DRAINER_MODULE_ID, ["output"]))
        .toMatchObject({ residentCount: 1, pendingCount: 0, claimedCount: 1 });
      expect(await waitFor(
        () =>
          repository.list().length === 5 &&
          repository.list().every((record) => record.state === "committed") &&
          actorRunCount(DRAINER_MODULE_ID) === 2,
        5_000,
      )).toBe(true);
      expect(actorRunCount(FIRST_MODULE_ID)).toBe(2);
      expect(actorRunCount(SECOND_MODULE_ID)).toBe(2);
      expect(actorRunCount(DRAINER_MODULE_ID)).toBe(2);
      expect(await waitFor(
        () =>
          repository.list().length === 6 &&
          repository.list().every((record) => record.state === "committed") &&
          coreState.store.deliveries.inspectResident(DRAINER_MODULE_ID, ["output"])
              .residentCount === 0,
        5_000,
      )).toBe(true);

      await composed.host.stop();
      stopped = true;
      expect(composed.host.state).toBe("stopped");
      MODULE_IDS.forEach((_moduleId, index) => {
        expect(coreState.store.getModuleProcessRecord(processGenerationIds[index]!))
          .toMatchObject({
            state: "stopped",
            packageDigest: installed.packageDigest,
            moduleCgroupPath: moduleCgroupPaths[index],
          });
        expect(existsSync(moduleCgroupPaths[index]!)).toBe(false);
      });

      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `reopened-block-${++blockId}`,
        nextDeliveryId: (kind) => `reopened-${kind}-${++deliveryId}`,
        now,
      });
      const reopenedRepository = new FileModuleResultCommitRepository({ path: commitPath });
      const committed = reopenedRepository.list().find((record) =>
        record.source.id === SECOND_MODULE_ID &&
        record.blockId !== undefined &&
        JSON.stringify(reopened.blocks.get(record.blockId)).includes("second:1:run-2")
      );
      expect(reopenedRepository.list()).toHaveLength(6);
      expect(committed).toMatchObject({
        state: "committed",
        source: { kind: "module", id: SECOND_MODULE_ID },
        outputDeliveries: [expect.objectContaining({ pageId: "output" })],
      });
      if (committed?.blockId === undefined) {
        throw new Error("The reopened result commit does not reference its output Block");
      }
      expect(reopened.blocks.get(committed.blockId)).toMatchObject({
        payload: {
          value: {
            items: [expect.objectContaining({ type: "text", text: "second:1:run-2" })],
          },
        },
      });
      const reopenedDrainerResident = reopened.deliveries.inspectResident(
        DRAINER_MODULE_ID,
        ["output"],
      );
      const reopenedDeliverySnapshot = reopened.deliveries.snapshot();
      expect(reopenedDrainerResident)
        .toMatchObject({ residentCount: 0, pendingCount: 0, claimedCount: 0 });
      const reopenedDrainerJobs = reopenedDeliverySnapshot.moduleJobs.filter((job) =>
        job.consumerId === DRAINER_MODULE_ID
      );
      expect(reopenedDrainerJobs).toHaveLength(2);
      expect(reopenedDrainerJobs.every((job) => job.status === "committed")).toBe(true);
      expect(reopened.deliveries.listDeadLetters()).toEqual([]);
      expect(reopened.deliveries.inspectPending(SECOND_MODULE_ID, ["middle"]).pendingCount)
        .toBe(0);
      expect(reopened.deliveries.inspectPending(FIRST_MODULE_ID, ["input"]).pendingCount)
        .toBe(0);
      for (const processGenerationId of processGenerationIds) {
        expect(reopened.getModuleProcessRecord(processGenerationId)?.state).toBe("stopped");
      }

      console.info(JSON.stringify({
        packageDigest: installed.packageDigest,
        processGenerationIds,
        moduleCgroupPaths,
        initialEmptyDecisionsObserved: MODULE_IDS.length,
        configuredPollIntervalMs: 60_000,
        outputCommittedWithinMs: 5_000,
        outputBackpressureObserved: true,
        actorRunsBeforeCapacityRelease: {
          [FIRST_MODULE_ID]: 2,
          [SECOND_MODULE_ID]: 2,
          [DRAINER_MODULE_ID]: 1,
        },
        actorRunsAfterCapacityRelease: {
          [FIRST_MODULE_ID]: actorRunCount(FIRST_MODULE_ID),
          [SECOND_MODULE_ID]: actorRunCount(SECOND_MODULE_ID),
          [DRAINER_MODULE_ID]: actorRunCount(DRAINER_MODULE_ID),
        },
        committedModuleResults: reopenedRepository.list().length,
        finalRecordStates: processGenerationIds.map((processGenerationId) =>
          reopened.getModuleProcessRecord(processGenerationId)?.state
        ),
        cgroupsRemoved: moduleCgroupPaths.every((path) => !existsSync(path)),
        reopenedOutput: "second:1:run-2",
      }));
    } finally {
      if (!stopped && composed !== undefined &&
        (composed.host.state === "running" || composed.host.state === "failed")) {
        await composed.host.stop().catch(() => undefined);
      }
      const remainingCgroup = moduleCgroupPaths.find((path) => existsSync(path));
      if (remainingCgroup !== undefined) {
        throw new Error(`Exact Module control group remained after cleanup: ${remainingCgroup}`);
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 90_000);
});
