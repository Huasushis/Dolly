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
import { CoreStartupRecovery } from "../../../src/core/core-startup-recovery.js";
import { ExtensionIsolationPolicy } from "../../../src/core/extension-process-host.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import {
  FileCoreStateStore,
  createFileCoreStateStoreWithStoppedRecordWriter,
} from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import { resolveInstalledContentSchemaRegistrationSet } from "../../../src/core/installed-extension-module.js";
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
import { createModuleResultCommitCoordinator } from "../../../src/core/module-result-commit-factory.js";
import {
  createDefaultDollyInstanceConfig,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const PYTHON = "/usr/bin/python3";
const INSTANCE_ID = "44444444-4444-4444-8444-444444444444";
const FIRST_MODULE_ID = "scheduler-first";
const SECOND_MODULE_ID = "scheduler-second";
const DRAINER_MODULE_ID = "scheduler-drainer";
const SOURCE_MODULE_ID = "scheduler-source";
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
        // Keep the first sink Run active long enough for both upstream
        // processes to reach the output-commit boundary on a loaded runner.
        // The assertion below observes backpressure before allowing this
        // finite delay to release capacity; it does not use the delay as the
        // backpressure oracle.
        configuration: { prefix: "drainer", delayMs: 10_000, emitOutput: false },
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
      const contentSchemas = resolveInstalledContentSchemaRegistrationSet({
        instanceConfiguration: configuration,
        installations,
        reservedRegistrations: [],
        maxRegisteredValueBytes: 64 * 1_024,
      });
      const coreState = createFileCoreStateStoreWithStoppedRecordWriter({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `scheduler-block-${++blockId}`,
        nextDeliveryId: (kind) => `scheduler-${kind}-${++deliveryId}`,
        now,
        contentSchemas,
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
      const mailboxes = [{
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
      }];
      const startupRecoveryHandoff = (await new CoreStartupRecovery({
        deliveries: coreState.store.deliveries,
        commits: createModuleResultCommitCoordinator({
          core: coreState.store,
          repository,
          now,
          mailboxes,
        }),
        moduleRecords: coreState.store,
        stoppedRecordWriter: coreState.stoppedRecordWriter,
      }).recover()).handoff;
      composed = composeInstalledReactiveModuleHost({
        configuration,
        installations,
        configurations,
        coreState,
        contentSchemas,
        maxRegisteredContentValueBytes: 64 * 1_024,
        startupRecoveryHandoff,
        mailboxes,
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
          .toMatchObject({
            state: "running",
            packageDigest: installed.packageDigest,
            declaredExternalEffects: "core-capabilities-only",
          });
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
        () =>
          actorRunCount(FIRST_MODULE_ID) === 2 &&
          events.some((event) =>
            event.type === "scheduler.backpressure_entered" &&
            event.moduleId === SECOND_MODULE_ID
          ),
        5_000,
      )).toBe(true);
      expect(actorRunCount(FIRST_MODULE_ID)).toBe(2);
      expect(actorRunCount(SECOND_MODULE_ID)).toBe(1);
      expect(actorRunCount(DRAINER_MODULE_ID)).toBe(1);
      expect(repository.list()).toHaveLength(3);
      expect(repository.list().filter((record) => record.state === "prepared"))
        .toHaveLength(0);
      expect(coreState.store.deliveries.inspectResident(DRAINER_MODULE_ID, ["output"]))
        .toMatchObject({ residentCount: 1, pendingCount: 0, claimedCount: 1 });
      const capacityReleased = await waitFor(
        () =>
          repository.list().length === 5 &&
          repository.list().every((record) => record.state === "committed") &&
          actorRunCount(SECOND_MODULE_ID) === 2 &&
          actorRunCount(DRAINER_MODULE_ID) === 2,
        15_000,
      );
      if (!capacityReleased) {
        console.info(JSON.stringify({
          diagnostic: "scheduler-capacity-release-timeout",
          actorRuns: {
            [FIRST_MODULE_ID]: actorRunCount(FIRST_MODULE_ID),
            [SECOND_MODULE_ID]: actorRunCount(SECOND_MODULE_ID),
            [DRAINER_MODULE_ID]: actorRunCount(DRAINER_MODULE_ID),
          },
          resultCommits: repository.list().map((record) => ({
            source: record.source,
            state: record.state,
            outputPageIds: record.outputPageIds,
          })),
          middle: coreState.store.deliveries.inspectResident(
            SECOND_MODULE_ID,
            ["middle"],
          ),
          output: coreState.store.deliveries.inspectResident(
            DRAINER_MODULE_ID,
            ["output"],
          ),
          schedulerEvents: events.slice(-30),
        }));
      }
      expect(capacityReleased).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({
        type: "scheduler.backpressure_exited",
        moduleId: SECOND_MODULE_ID,
      }));
      expect(actorRunCount(FIRST_MODULE_ID)).toBe(2);
      expect(actorRunCount(SECOND_MODULE_ID)).toBe(2);
      expect(actorRunCount(DRAINER_MODULE_ID)).toBe(2);
      expect(await waitFor(
        () =>
          repository.list().length === 6 &&
          repository.list().every((record) => record.state === "committed") &&
          coreState.store.deliveries.inspectResident(DRAINER_MODULE_ID, ["output"])
              .residentCount === 0,
        15_000,
      )).toBe(true);
      const actorRunsAfterCapacityRelease = {
        [FIRST_MODULE_ID]: actorRunCount(FIRST_MODULE_ID),
        [SECOND_MODULE_ID]: actorRunCount(SECOND_MODULE_ID),
        [DRAINER_MODULE_ID]: actorRunCount(DRAINER_MODULE_ID),
      };

      const shutdownProbe = coreState.store.blocks.commit(
        proposal("cancel the active drainer during shutdown"),
        { kind: "external", id: "scheduler-shutdown-probe" },
      );
      const shutdownProbeDelivery = coreState.store.deliveries.append(
        "output",
        shutdownProbe.id,
      );
      expect(await waitFor(
        () =>
          actorRunCount(DRAINER_MODULE_ID) === 3 &&
          coreState.store.deliveries.inspectResident(DRAINER_MODULE_ID, ["output"])
              .claimedCount === 1,
        5_000,
      )).toBe(true);

      await expect(composed.host.stop()).rejects.toMatchObject({
        errors: [expect.objectContaining({ code: "RUNTIME_RECOVERY_REQUIRED" })],
      });
      stopped = true;
      expect(composed.host.state).toBe("failed");
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
        contentSchemas,
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
        .toMatchObject({ residentCount: 1, pendingCount: 0, claimedCount: 1 });
      const reopenedDrainerJobs = reopenedDeliverySnapshot.moduleJobs.filter((job) =>
        job.consumerId === DRAINER_MODULE_ID
      );
      expect(reopenedDrainerJobs).toHaveLength(3);
      expect(reopenedDrainerJobs.filter((job) => job.status === "committed")).toHaveLength(2);
      expect(reopenedDrainerJobs).toContainEqual(expect.objectContaining({
        status: "claimed",
        attempt: 1,
        failedAttemptCount: 0,
      }));
      expect(reopenedDeliverySnapshot.claims).toContainEqual(expect.objectContaining({
        status: "active",
        moduleGenerationId: `${DRAINER_MODULE_ID}-generation-1`,
      }));
      expect(reopened.listModuleSubmissionRecords()).toContainEqual(expect.objectContaining({
        moduleGenerationId: `${DRAINER_MODULE_ID}-generation-1`,
      }));
      expect(
        reopenedDeliverySnapshot.deliveries.find(
          (delivery) => delivery.record.deliveryId === shutdownProbeDelivery.deliveryId,
        )?.obligations,
      ).toContainEqual({ consumerId: DRAINER_MODULE_ID, status: "claimed" });
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
        outputRecoveryWithinMs: 15_000,
        schedulerBackpressureObserved: true,
        outputCommitBackpressureObserved: false,
        actorRunsBeforeCapacityRelease: {
          [FIRST_MODULE_ID]: 2,
          [SECOND_MODULE_ID]: 1,
          [DRAINER_MODULE_ID]: 1,
        },
        actorRunsAfterCapacityRelease,
        shutdownUnknownOutcomePreserved: true,
        shutdownCancelledModuleId: DRAINER_MODULE_ID,
        shutdownFailedAttemptCount: 0,
        shutdownClaimStatus: "active",
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

  it("executes one durable source request in the installed Linux host", async () => {
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
    const preparedRoot = await prepareDelegatedCgroupRoot({
      delegatedRootCgroupPath: inspectedBinding.binding.delegatedRootCgroupPath,
    });
    if (!preparedRoot.prepared) {
      throw new Error(`${preparedRoot.failure.code}: ${preparedRoot.failure.detail}`);
    }

    const scratchParent = resolve(process.cwd(), ".tmp");
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(scratchParent, "installed-source-host-integration-"));
    const statePath = join(scratch, "core-state.json");
    const commitPath = join(scratch, "module-result-commits.json");
    const processGenerationId =
      `${SOURCE_MODULE_ID}-process-${process.pid}-${Date.now()}`;
    const moduleCgroupPath = deriveModuleCgroupPath(
      inspectedBinding.binding.delegatedRootCgroupPath,
      { instanceId: INSTANCE_ID, moduleId: SOURCE_MODULE_ID, processGenerationId },
    ).filesystemPath;
    let composed: InstalledReactiveModuleHost | undefined;
    let stopped = false;
    let primaryFailure: unknown;
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
        schemaVersion: "dolly.extension-package/3",
        extensionId: "org.example.scheduler-installed",
        packageVersion: "1.0.0",
        displayName: "Installed Source Scheduler integration fixture",
        description: "Consumes one durable Core-private source request.",
        supportedProtocolVersions: ["3.0"],
        entrypoint: "extension.mjs",
        modules: [{
          moduleKind: "transform",
          activation: "source",
          configVersion: 1,
          configurationSchema,
          producedContentSchemas: [],
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
      const sourceConfiguration = configurations.create({
        configId: "scheduler-source-config",
        extensionId: "org.example.scheduler-installed",
        moduleKind: "transform",
        configVersion: 1,
        schema: configurationSchema,
        configuration: { prefix: "source" },
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
        pages: [{ pageId: "source-output" }],
        modules: [{
          moduleId: SOURCE_MODULE_ID,
          extensionId: "org.example.scheduler-installed",
          packageVersion: "1.0.0",
          moduleKind: "transform",
          isolation: "process",
          configurationReference: {
            configId: sourceConfiguration.configId,
            revision: sourceConfiguration.revision,
            configVersion: sourceConfiguration.configVersion,
          },
          permissionPolicyIds: [],
          inputPageIds: [],
          outputPageIds: ["source-output"],
          subscriptionStart: "from-head",
          activation: { kind: "source", trigger: "manual" },
          limits: {
            claim: null,
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
      let processIdentifierAllocated = false;
      const now = (): string => new Date().toISOString();
      const contentSchemas = resolveInstalledContentSchemaRegistrationSet({
        instanceConfiguration: configuration,
        installations,
        reservedRegistrations: [],
        maxRegisteredValueBytes: 64 * 1_024,
      });
      const coreState = createFileCoreStateStoreWithStoppedRecordWriter({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `source-block-${++blockId}`,
        nextDeliveryId: (kind) => `source-${kind}-${++deliveryId}`,
        now,
        contentSchemas,
      });
      coreState.store.deliveries.createPage("source-output");
      const repository = new FileModuleResultCommitRepository({ path: commitPath });
      const startupRecoveryHandoff = (await new CoreStartupRecovery({
        deliveries: coreState.store.deliveries,
        commits: createModuleResultCommitCoordinator({
          core: coreState.store,
          repository,
          now,
          mailboxes: [],
        }),
        moduleRecords: coreState.store,
        stoppedRecordWriter: coreState.stoppedRecordWriter,
      }).recover()).handoff;
      const schedulerEvents: SchedulerEvent[] = [];
      const actorEvents: ModuleActorEvent[] = [];
      composed = composeInstalledReactiveModuleHost({
        configuration,
        installations,
        configurations,
        coreState,
        contentSchemas,
        maxRegisteredContentValueBytes: 64 * 1_024,
        mailboxes: [],
        sourceActivationLimits: [{
          moduleId: SOURCE_MODULE_ID,
          maxResidentCount: 4,
          maxResidentBytes: 64 * 1_024,
          maxRequestBytes: 8 * 1_024,
        }],
        startupRecoveryHandoff,
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
          initialModuleGenerationIdFor: (moduleId) => `${moduleId}-generation-1`,
          nextModuleGenerationIdFor: (moduleId) => `${moduleId}-generation-2`,
          binding: inspectedBinding.binding,
          lifecycle: { limits: LIMITS, maxOpenFiles: 64 },
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
            if (processIdentifierAllocated) {
              throw new Error("The source integration attempted another process generation");
            }
            processIdentifierAllocated = true;
            return processGenerationId;
          },
          nextProtocolIdentifier: (purpose) =>
            `${purpose}-scheduler-source-${++protocolIdentifier}`,
          classifyFailure: (failure) => ({ code: failure.code, retryable: false }),
          onActorEvent: (event) => actorEvents.push(event),
        },
        onSchedulerEvent: (event) => schedulerEvents.push(event),
      });
      expect(composed.sourceActivationQueues).toHaveLength(1);
      await composed.host.start();
      expect(composed.host.state).toBe("running");
      expect(composed.installedRuntimes[0]?.generations.processGenerationIdFor(
        `${SOURCE_MODULE_ID}-generation-1`,
      )).toBe(processGenerationId);
      expect(coreState.store.getModuleProcessRecord(processGenerationId)).toMatchObject({
        state: "running",
        packageDigest: installed.packageDigest,
        declaredExternalEffects: "core-capabilities-only",
      });
      expect(existsSync(moduleCgroupPath)).toBe(true);

      const submission = composed.sourceActivationQueues[0]!.submit({
        idempotencyKey: "manual:source:integration:1",
        body: { kind: "manual/1", instruction: "refresh installed source" },
      });
      expect(submission).toMatchObject({ status: "enqueued" });
      expect(await waitFor(
        () =>
          repository.list().length === 1 &&
          repository.list()[0]?.state === "committed" &&
          composed?.sourceActivationQueues[0]?.inspect().residentCount === 0,
        5_000,
      )).toBe(true);
      expect(actorEvents.filter((event) => event.type === "run.started")).toHaveLength(1);
      expect(schedulerEvents).toContainEqual(expect.objectContaining({
        type: "scheduler.dispatched",
        moduleId: SOURCE_MODULE_ID,
        reasonCode: "READY_SOURCE",
      }));
      expect(schedulerEvents).toContainEqual(expect.objectContaining({
        type: "scheduler.settled",
        moduleId: SOURCE_MODULE_ID,
        tickStatus: "committed",
      }));
      const result = repository.list()[0]!;
      expect(result).toMatchObject({
        state: "committed",
        source: { kind: "module", id: SOURCE_MODULE_ID },
        outputDeliveries: [expect.objectContaining({ pageId: "source-output" })],
      });
      if (result.blockId === undefined) {
        throw new Error("The source result does not reference its output Block");
      }
      expect(coreState.store.blocks.get(result.blockId)).toMatchObject({
        payload: {
          value: {
            items: [expect.objectContaining({ type: "text", text: "source:1:run-1" })],
          },
        },
      });

      await composed.host.stop();
      stopped = true;
      expect(composed.host.state).toBe("stopped");
      expect(coreState.store.getModuleProcessRecord(processGenerationId)).toMatchObject({
        state: "stopped",
        moduleCgroupPath,
      });
      expect(existsSync(moduleCgroupPath)).toBe(false);

      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `reopened-source-block-${++blockId}`,
        nextDeliveryId: (kind) => `reopened-source-${kind}-${++deliveryId}`,
        now,
        contentSchemas,
      });
      const reopenedRepository = new FileModuleResultCommitRepository({ path: commitPath });
      expect(reopenedRepository.list()).toEqual([
        expect.objectContaining({
          state: "committed",
          source: { kind: "module", id: SOURCE_MODULE_ID },
        }),
      ]);
      expect(reopened.getModuleProcessRecord(processGenerationId)).toMatchObject({
        state: "stopped",
      });
      expect(reopened.deliveries.inspectPending(SOURCE_MODULE_ID, [
        composed.sourceActivationQueues[0]!.privatePageId,
      ]).pendingCount).toBe(0);

      console.info(JSON.stringify({
        packageSchemaVersion: installed.manifest.schemaVersion,
        packageDigest: installed.packageDigest,
        moduleId: SOURCE_MODULE_ID,
        processGenerationId,
        moduleCgroupPath,
        requestStatus: submission.status,
        schedulerReasonCode: "READY_SOURCE",
        actorRuns: 1,
        committedModuleResults: reopenedRepository.list().length,
        finalRecordState: reopened.getModuleProcessRecord(processGenerationId)?.state,
        cgroupRemoved: !existsSync(moduleCgroupPath),
        reopenedOutput: "source:1:run-1",
      }));
    } catch (error) {
      primaryFailure = error;
    } finally {
      const cleanupFailures: unknown[] = [];
      if (!stopped && composed !== undefined &&
        (composed.host.state === "running" || composed.host.state === "failed")) {
        await composed.host.stop().catch((error) => cleanupFailures.push(error));
      }
      if (existsSync(moduleCgroupPath)) {
        cleanupFailures.push(
          new Error(`Exact Source Module control group remained after cleanup: ${moduleCgroupPath}`),
        );
      }
      rmSync(scratch, { recursive: true, force: true });
      const failures = [
        ...(primaryFailure === undefined ? [] : [primaryFailure]),
        ...cleanupFailures,
      ];
      if (failures.length > 0) {
        throw new AggregateError(failures, "Installed Source Module integration failed");
      }
    }
  }, 60_000);
});
