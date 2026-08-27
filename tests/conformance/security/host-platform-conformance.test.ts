/**
 * Platform acceptance boundary for the installed Module lifecycle.
 *
 * The real Linux case runs only in the delegated systemd service. The test
 * may run in a worker, so it proves the exact service cgroup rather than
 * treating Vitest's worker PID as the service MainPID.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  startLinuxModuleLauncher,
  type StartedLinuxModuleLauncher,
} from "../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js";
import { createModuleLauncherControl } from "../../../src/adapters/linux-module-launcher/module-launcher-control.js";
import { inspectReviewedLinuxModuleRuntime } from "../../../src/linux-module-runtime-assets.js";
import {
  collectCoreServiceObservation,
} from "../../../src/core/linux-core-service-binding.js";
import {
  decideLinuxModuleActivation,
} from "../../../src/core/linux-module-activation.js";
import {
  deriveModuleCgroupPath,
  parseCgroupEventsPopulated,
  prepareDelegatedCgroupRoot,
  type ModuleCgroupLimits,
} from "../../../src/core/linux-module-cgroup.js";
import {
  startModuleProcess,
  stopModuleProcess,
  type ModuleProcessStartResult,
  type ModuleProcessRecordStore,
  type ModuleProcessStopResult,
} from "../../../src/core/linux-module-process-lifecycle.js";
import {
  canTransitionModuleProcessRecordState,
  type ModuleProcessRecord,
  type ModuleProcessStoppedRecordWriter,
} from "../../../src/core/module-process-records.js";
import {
  ExtensionCapabilityAuthority,
  type ExtensionCapabilitySession,
} from "../../../src/core/extension-capability.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import { ModuleConfigurationStore } from "../../../src/core/module-configuration-store.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import {
  createDefaultDollyInstanceConfig,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";
import { openDollyRuntime } from "../../../src/core/runtime-bootstrap.js";

const platformMock = vi.hoisted(() => ({
  observe: vi.fn<() => NodeJS.Platform>(() => process.platform),
}));

vi.mock("../../../src/core/host-platform.js", () => ({
  observeHostPlatform: platformMock.observe,
}));

const INSTANCE_ID = "44444444-4444-4444-8444-444444444444";
const MODULE_ID = "platform-owner";
const PYTHON = "/usr/bin/python3";
const LIMITS: ModuleCgroupLimits = {
  memoryMaxBytes: 256 * 1024 * 1024,
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

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function exactCgroupIsEmpty(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    return (
      parseCgroupEventsPopulated(readFileSync(`${path}/cgroup.events`, "utf8")) === false &&
      readFileSync(`${path}/cgroup.procs`, "utf8").trim().length === 0
    );
  } catch {
    return false;
  }
}

function removeExactCgroupTree(path: string): boolean {
  if (!existsSync(path)) return true;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !removeExactCgroupTree(join(path, entry.name))) {
      return false;
    }
  }
  if (!exactCgroupIsEmpty(path)) return false;
  try {
    rmdirSync(path);
  } catch {
    return false;
  }
  return !existsSync(path);
}

function realLifecycleRecordStore(
  initial: ModuleProcessRecord,
): ModuleProcessRecordStore & {
  readonly stoppedRecordWriter: ModuleProcessStoppedRecordWriter;
  readonly current: () => ModuleProcessRecord | undefined;
} {
  let current: ModuleProcessRecord | undefined;
  const writeState = (
    state: ModuleProcessRecord["state"],
    failureCode?: string,
  ): ModuleProcessRecord => {
    if (current === undefined) throw new Error("the lifecycle record was not appended");
    if (!canTransitionModuleProcessRecordState(current.state, state)) {
      throw new Error(`invalid process-record transition ${current.state} -> ${state}`);
    }
    current = {
      ...current,
      state,
      ...(failureCode === undefined ? {} : { failureCode }),
    };
    return current;
  };
  return {
    current: () => current,
    stoppedRecordWriter: {
      isStoreBoundTo: () => true,
      isBoundTo: (record) => current === record,
      writeStopped: (_processGenerationId, failureCode) =>
        writeState("stopped", failureCode),
    },
    getModuleProcessRecord: (processGenerationId) =>
      current?.processGenerationId === processGenerationId ? current : undefined,
    appendModuleProcessRecord: (record) => {
      if (current !== undefined) throw new Error("the test store accepts one process");
      if (record !== initial) throw new Error("the lifecycle record identity changed before append");
      current = record;
      return record;
    },
    supportsVersion19Identity: () => false,
    allocateAndAppendStartingRecord: () => {
      throw new Error("the real ownership probe uses an explicit process identity");
    },
    updateModuleProcessRecordState: (_processGenerationId, state, failureCode) =>
      writeState(state, failureCode),
  };
}

const integrationUnitName = process.env.DOLLY_LINUX_MODULE_INTEGRATION_UNIT;
const delegatedRoot = delegatedRootCgroupPath();
const realLinuxAvailable =
  process.platform === "linux" &&
  delegatedRoot !== undefined &&
  integrationUnitName !== undefined &&
  existsSync(PYTHON);
if (process.env.DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED === "1" && !realLinuxAvailable) {
  throw new Error(
    "Host platform conformance requires the exact delegated systemd service and Python launcher",
  );
}

async function requireLinuxHostPremise() {
  if (integrationUnitName === undefined) {
    throw new Error("The transient Core service unit name is unavailable");
  }
  const observedResult = await collectCoreServiceObservation({
    unitName: integrationUnitName,
    mode: "user",
    queryTimeoutMs: 5_000,
    overallTimeoutMs: 15_000,
  });
  if (!observedResult.observed) {
    throw new Error(observedResult.failures
      .map((failure) => `${failure.code}: ${failure.detail}`)
      .join("; "));
  }
  const observation = observedResult.observation;
  if (
    observation.selfCgroupPath !== `${observation.unit.controlGroup}/core` ||
    observation.unit.mainPid < 1 ||
    observation.selfPid < 1 ||
    observation.unit.delegateSubgroup !== "core" ||
    !observation.cgroupFilesystemIsV2
  ) {
    throw new Error("The exact systemd service did not prove the delegated Core subgroup");
  }
  const root = observation.selfCgroupPath.slice(0, -"/core".length);
  if (root !== delegatedRoot) {
    throw new Error("The observed delegated root does not match the process cgroup");
  }
  const prepared = await prepareDelegatedCgroupRoot({
    delegatedRootCgroupPath: root,
  });
  if (!prepared.prepared) {
    throw new Error(`${prepared.failure.code}: ${prepared.failure.detail}`);
  }
  const runtimeResult = await inspectReviewedLinuxModuleRuntime();
  if (!runtimeResult.available) {
    throw new Error(runtimeResult.detail);
  }
  return {
    delegatedRootCgroupPath: root,
    serviceInvocationId: observation.unit.invocationId,
    bootId: observation.bootId,
    runtime: runtimeResult.runtime,
  };
}

describe("Host platform conformance", () => {
  beforeEach(() => {
    platformMock.observe.mockReset();
    platformMock.observe.mockReturnValue(process.platform);
  });

  it.each(["win32", "darwin"] as const)(
    "refuses Module activation on %s before any Linux probe",
    async (platform) => {
      platformMock.observe.mockReturnValueOnce(platform);
      const result = await decideLinuxModuleActivation({
        unitName: "dolly-platform-conformance.service",
        mode: "user",
        queryTimeoutMs: 1_000,
        overallTimeoutMs: 2_000,
      });
      expect(result).toEqual({
        permitted: false,
        refusals: [{
          code: "MODULE_ACTIVATION_PLATFORM_UNSUPPORTED",
          detail: `configured Modules require Linux but this process runs on ${platform}`,
        }],
      });
    },
  );

  it.each(["win32", "darwin"] as const)(
    "refuses Core service inspection on %s without probing systemd",
    async (platform) => {
      platformMock.observe.mockReturnValueOnce(platform);
      const result = await collectCoreServiceObservation({
        unitName: "dolly-platform-conformance.service",
        mode: "user",
        busctlPath: "/definitely-missing/busctl",
        loginctlPath: "/definitely-missing/loginctl",
        queryTimeoutMs: 1_000,
        overallTimeoutMs: 2_000,
      });
      expect(result).toEqual({
        observed: false,
        failures: [{
          code: "CORE_SERVICE_PLATFORM_UNSUPPORTED",
          detail: `Core service binding verification requires Linux but this process runs on ${platform}`,
        }],
      });
    },
  );

  it("keeps RUNTIME_MODULE_MIGRATION_REQUIRED unconditional for configured Modules", async () => {
    const scratchParent = resolve(process.cwd(), ".tmp");
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(scratchParent, "host-platform-guard-"));
    const configPath = join(scratch, "instance.json");
    const registryDirectory = join(scratch, "registry");
    const defaultStateRoot = join(scratch, "instances");
    const defaults = createDefaultDollyInstanceConfig(INSTANCE_ID);
    const configuration = validateDollyInstanceConfig({
      ...defaults,
      pages: [{ pageId: "input" }],
      modules: [{
        moduleId: MODULE_ID,
        extensionId: "org.example.host-platform",
        packageVersion: "1.0.0",
        moduleKind: "transform",
        isolation: "process",
        configurationReference: {
          configId: "platform-owner-config",
          revision: `sha256:${"a".repeat(64)}`,
          configVersion: 1,
        },
        permissionPolicyIds: [],
        inputPageIds: ["input"],
        outputPageIds: [],
        subscriptionStart: "from-now",
        activation: { kind: "reactive" },
        limits: {
          claim: { maxCount: 1, maxBytes: 1_024 },
          maxInputBytes: 16_384,
          maxResultBytes: 16_384,
          maxFrameBytes: 32_768,
          maxRunsPerGeneration: 2,
          maxGenerations: 1,
        },
        timeouts: {
          initializationTimeoutMs: 1_000,
          executionTimeoutMs: 1_000,
          cancellationGraceMs: 100,
          terminationTimeoutMs: 1_000,
        },
      }],
    });
    writeFileSync(configPath, JSON.stringify(configuration), "utf8");
    try {
      await expect(openDollyRuntime({
        configPath,
        registryDirectory,
        defaultStateRoot,
        processId: process.pid,
      })).rejects.toMatchObject({ code: "RUNTIME_MODULE_MIGRATION_REQUIRED" });
      expect(existsSync(join(defaultStateRoot, INSTANCE_ID, "core-state.json"))).toBe(false);
      expect(existsSync(join(registryDirectory, "controllers", `${INSTANCE_ID}.lock`))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!realLinuxAvailable)(
  "real Linux installed Module lifecycle ownership",
  () => {
    it("creates, starts, refuses a foreign stop, and stops one exact package premise", async () => {
      const hostPremise = await requireLinuxHostPremise();
      const scratchParent = resolve(process.cwd(), ".tmp");
      mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
      const scratch = mkdtempSync(join(scratchParent, "host-platform-lifecycle-"));
      const processGenerationId = `${MODULE_ID}-process-${process.pid}-${Date.now()}`;
      const identity = {
        instanceId: INSTANCE_ID,
        moduleId: MODULE_ID,
        processGenerationId,
      } as const;
      const derivedModuleCgroup = deriveModuleCgroupPath(
        hostPremise.delegatedRootCgroupPath,
        identity,
      );
      const moduleCgroupPath = derivedModuleCgroup.filesystemPath;
      let records: (ModuleProcessRecordStore & {
        readonly stoppedRecordWriter: ModuleProcessStoppedRecordWriter;
        readonly current: () => ModuleProcessRecord | undefined;
      }) | undefined;
      let started: ModuleProcessStartResult | undefined;
      let launcher: StartedLinuxModuleLauncher | undefined;
      let stopOperation: Promise<ModuleProcessStopResult> | undefined;
      let releaseHangingCapability: (() => void) | undefined;
      let capabilityInvocation: Promise<unknown> | undefined;
      let capabilitySession: ExtensionCapabilitySession | undefined;

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
          extensionId: "org.example.host-platform",
          packageVersion: "1.0.0",
          displayName: "Host platform lifecycle fixture",
          description: "Runs one installed process for ownership verification.",
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
        expect(existsSync(installed.entrypointPath)).toBe(true);
        rmSync(packageSource, { recursive: true, force: true });

        const configurations = new ModuleConfigurationStore({
          directory: join(scratch, "configurations"),
        });
        const configuration = configurations.create({
          configId: "platform-owner-config",
          extensionId: installed.manifest.extensionId,
          moduleKind: "transform",
          configVersion: 1,
          schema: configurationSchema,
          configuration: { prefix: "platform-owner" },
        });
        const configurationReference = {
          configId: configuration.configId,
          revision: configuration.revision,
          configVersion: configuration.configVersion,
        } as const;
        const premise = Object.freeze({
          packageDigest: installed.packageDigest,
          configurationReference,
        });
        const processRecord: ModuleProcessRecord = {
          schemaVersion: "dolly.module-process-record/1",
          ...identity,
          moduleGenerationId: `${MODULE_ID}-generation-1`,
          packageDigest: premise.packageDigest,
          configurationReference: premise.configurationReference,
          declaredExternalEffects: "core-capabilities-only",
          serviceInvocationId: hostPremise.serviceInvocationId,
          bootId: hostPremise.bootId,
          moduleCgroupPath,
          state: "starting",
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:00.000Z",
        };
        records = realLifecycleRecordStore(processRecord);
        started = await startModuleProcess({
          records,
          stoppedRecordWriter: records.stoppedRecordWriter,
          processRecord,
          delegatedRootCgroupPath: hostPremise.delegatedRootCgroupPath,
          identity,
          limits: LIMITS,
          maxOpenFiles: 64,
          startLauncher: async () => {
            launcher = startLinuxModuleLauncher({
              interpreterProgram: hostPremise.runtime.interpreterProgram,
              launcherScriptPath: hostPremise.runtime.launcherScriptPath,
              launcherEnvironment: {},
              controllerTimeouts: {
                configureTimeoutMs: 5_000,
                inCgroupTimeoutMs: 5_000,
                membershipTimeoutMs: 5_000,
                exitObservationTimeoutMs: 5_000,
              },
            });
            return createModuleLauncherControl({ launcher });
          },
          execution: {
            program: process.execPath,
            argumentVector: [process.execPath, installed.entrypointPath, "process-id"],
            environment: { DOLLY_EXTENSION: "host-platform-conformance" },
          },
        });
        if (!started.executionAuthorized) {
          throw new Error(`${started.failure.code}: ${started.failure.detail}`);
        }
        expect(launcher).toBeDefined();
        if (launcher === undefined) {
          throw new Error("the launcher handle was not retained");
        }
        expect(started.record).toMatchObject({
          instanceId: INSTANCE_ID,
          moduleId: MODULE_ID,
          moduleGenerationId: `${MODULE_ID}-generation-1`,
          processGenerationId,
          packageDigest: premise.packageDigest,
          configurationReference: premise.configurationReference,
          serviceInvocationId: hostPremise.serviceInvocationId,
          bootId: hostPremise.bootId,
          moduleCgroupPath,
        });
        expect(started.cgroup.path).toBe(moduleCgroupPath);
        expect(existsSync(moduleCgroupPath)).toBe(true);
        expect(processIsAlive(launcher.processId)).toBe(true);
        expect(readFileSync(`/proc/${launcher.processId}/cgroup`, "utf8"))
          .toContain(`0::${derivedModuleCgroup.cgroupPath}`);

        const foreignStop = await stopModuleProcess({
          records,
          stoppedRecordWriter: records.stoppedRecordWriter,
          processGenerationId: `${processGenerationId}-foreign`,
          cgroup: started.cgroup,
          closeCapabilitySession: async () => undefined,
          waitForChannelClosed: async () => true,
        });
        expect(foreignStop).toMatchObject({
          stopped: false,
          code: "MODULE_PROCESS_RECORD_STATE_INVALID",
        });
        expect(foreignStop.detail).toMatch(/does not own control group/u);
        expect(processIsAlive(launcher.processId)).toBe(true);
        expect(existsSync(moduleCgroupPath)).toBe(true);

        let capabilityEntered!: () => void;
        const capabilityEnteredPromise = new Promise<void>((resolve) => {
          capabilityEntered = resolve;
        });
        let releaseCapability!: () => void;
        const capabilityGate = new Promise<void>((resolve) => {
          releaseCapability = resolve;
        });
        releaseHangingCapability = releaseCapability;
        const capabilityAuthority = new ExtensionCapabilityAuthority({
          now: () => "2026-08-27T00:00:00.000Z",
          nextHandle: () => "h".repeat(43),
        });
        const session = capabilityAuthority.openSession({
          extensionId: "org.example.host-platform",
          instanceId: INSTANCE_ID,
          processGenerationId,
          sessionId: "platform-session",
          moduleId: MODULE_ID,
          moduleGenerationId: `${MODULE_ID}-generation-1`,
        });
        capabilitySession = session;
        const capabilityHandle = session.issue({
          capabilityType: "test.wait",
          capabilityVersion: "1",
          operations: ["hold"],
          resourceScope: {},
          expiresAt: "2026-08-28T00:00:00.000Z",
          maxInvocations: 1,
          maxConcurrentInvocations: 1,
          maxArgumentBytes: 1_024,
          maxResultBytes: 1_024,
        }, async () => {
          capabilityEntered();
          await capabilityGate;
          return {};
        });
        capabilityInvocation = session.invoke({
          handle: capabilityHandle,
          operation: "hold",
          arguments: {},
        });
        await capabilityEnteredPromise;

        stopOperation = stopModuleProcess({
          records,
          stoppedRecordWriter: records.stoppedRecordWriter,
          processGenerationId,
          cgroup: started.cgroup,
          timeoutMs: 5_000,
          closeCapabilitySession: () => session.close(),
          waitForChannelClosed: async () => true,
          channelCloseTimeoutMs: 5_000,
        });
        expect(await waitFor(() => exactCgroupIsEmpty(moduleCgroupPath), 5_000)).toBe(true);
        expect(
          existsSync(moduleCgroupPath),
          `stopModuleProcess left exact Module control group ${moduleCgroupPath}`,
        ).toBe(false);
      } finally {
        let cleanupError: unknown;
        try {
          if (
            stopOperation === undefined &&
            started?.executionAuthorized &&
            records !== undefined
          ) {
            stopOperation = stopModuleProcess({
              records,
              stoppedRecordWriter: records.stoppedRecordWriter,
              processGenerationId,
              cgroup: started.cgroup,
              timeoutMs: 5_000,
              closeCapabilitySession: () => capabilitySession?.close() ?? Promise.resolve(),
              waitForChannelClosed: async () => true,
              channelCloseTimeoutMs: 5_000,
            });
          }
          if (launcher !== undefined && processIsAlive(launcher.processId)) {
            launcher.child.kill("SIGKILL");
          }
          try {
            launcher?.closeControlChannel();
          } catch {
            // The exact child kill and cgroup proof below remain authoritative.
          }
          launcher?.child.stdin?.destroy();
          launcher?.child.stdout?.destroy();
          launcher?.child.stderr?.destroy();
          if (launcher !== undefined) {
            await launcher.waitForExit(5_000);
          }
          if (started?.cgroup !== undefined && existsSync(moduleCgroupPath)) {
            await started.cgroup.terminate({ timeoutMs: 5_000 }).catch(() => undefined);
          }
          if (existsSync(moduleCgroupPath) && !exactCgroupIsEmpty(moduleCgroupPath)) {
            try {
              writeFileSync(`${moduleCgroupPath}/cgroup.kill`, "1");
            } catch (error) {
              throw new Error(
                `Exact Module control group ${moduleCgroupPath} could not be terminated`,
                { cause: error },
              );
            }
          }
          if (
            !(await waitFor(() => exactCgroupIsEmpty(moduleCgroupPath), 5_000)) ||
            !removeExactCgroupTree(moduleCgroupPath)
          ) {
            throw new Error(`Exact Module control group remained after cleanup: ${moduleCgroupPath}`);
          }
          releaseHangingCapability?.();
          await capabilityInvocation?.catch(() => undefined);
          if (stopOperation !== undefined) await stopOperation;
          if (
            launcher !== undefined &&
            !(await waitFor(() => !processIsAlive(launcher!.processId), 5_000))
          ) {
            throw new Error(`Exact Module launcher process remained after cleanup: ${launcher.processId}`);
          }
        } catch (error) {
          cleanupError = error;
        }
        rmSync(scratch, { recursive: true, force: true });
        if (cleanupError !== undefined) throw cleanupError;
      }
    }, 45_000);
  },
);
