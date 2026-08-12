/**
 * Proves the complete product-before-bootstrap Linux Extension process chain:
 * durable starting record -> reviewed launcher -> verified Module cgroup ->
 * attached protocol handshake -> one execute -> whole-group stop -> removed
 * cgroup -> durable stopped record.
 *
 * Run only through `scripts/run-linux-module-launcher-integration.sh`, normally
 * inside the repository's uniquely named disposable systemd container.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createExtensionEffectJournalLifecycle } from "../../../src/adapters/extension-effect-run-lifecycle.js";
import { createInstalledLinuxExtensionModuleGenerationFactory } from "../../../src/adapters/installed-linux-extension-module-executor.js";
import { createLinuxExtensionModuleExecutor } from "../../../src/adapters/linux-extension-module-executor.js";
import { defaultLauncherScriptPath } from "../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { EffectIntentJournal } from "../../../src/core/capabilities/effect-intent-journal.js";
import { FileEffectIntentStore } from "../../../src/core/capabilities/file-effect-intent-store.js";
import {
  ExtensionIsolationPolicy,
  type ExtensionProcessHost,
} from "../../../src/core/extension-process-host.js";
import {
  ExtensionInstallationRegistry,
  type ExtensionPackageManifest,
} from "../../../src/core/extension-installation-registry.js";
import { createFileCoreStateStoreWithStoppedRecordWriter } from "../../../src/core/file-core-state-store.js";
import {
  deriveModuleCgroupPath,
  prepareDelegatedCgroupRoot,
  type ModuleCgroupLimits,
} from "../../../src/core/linux-module-cgroup.js";
import { inspectCoreServiceBinding } from "../../../src/core/linux-core-service-binding.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import type { ModuleExecutor } from "../../../src/core/module-actor.js";
import { ModuleConfigurationStore } from "../../../src/core/module-configuration-store.js";
import type { ModuleProcessRecord } from "../../../src/core/module-process-records.js";
import type { ReactiveModuleInput } from "../../../src/core/reactive-module-input.js";
import type { ReactiveModuleResult } from "../../../src/core/reactive-module-runtime.js";
import {
  createDefaultDollyInstanceConfig,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const PYTHON = "/usr/bin/python3";
const MODULE_GENERATION_ID = "generation-linux-extension";
const LIMITS: ModuleCgroupLimits = {
  memoryMaxBytes: 268_435_456,
  maxProcesses: 64,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/extension-process-fixture.mjs", import.meta.url),
);
const MANIFEST: ExtensionPackageManifest = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: "com.example.linux-executor-fixture",
  packageVersion: "1.0.0",
  displayName: "Linux executor fixture",
  description: "Exercises the identity-bound Linux Extension executor.",
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

interface ProcessIdentity {
  readonly processId: number;
  readonly startTimeTicks: string;
  readonly state: string;
}

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

function readProcessIdentity(processId: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const startTimeTicks = fields[19];
    if (state === undefined || startTimeTicks === undefined) return undefined;
    return { processId, startTimeTicks, state };
  } catch {
    return undefined;
  }
}

function sameLiveProcess(identity: ProcessIdentity): boolean {
  const current = readProcessIdentity(identity.processId);
  return current !== undefined &&
    current.startTimeTicks === identity.startTimeTicks &&
    current.state !== "Z";
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function requireLifecycleOperations(
  executor: ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult>,
): asserts executor is ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult> &
  Required<Pick<ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult>, "start" | "terminate">> {
  if (executor.start === undefined || executor.terminate === undefined) {
    throw new Error("The Linux Extension executor must implement start and terminate");
  }
}

const delegatedRoot = delegatedRootCgroupPath();
const available = delegatedRoot !== undefined && existsSync(PYTHON);
const integrationUnitName = process.env.DOLLY_LINUX_MODULE_INTEGRATION_UNIT;
if (process.env.DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED === "1" && !available) {
  throw new Error(
    "The Linux Module integration runner did not provide its delegated systemd service and Python launcher interpreter",
  );
}
if (
  process.env.DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED === "1" &&
  integrationUnitName === undefined
) {
  throw new Error(
    "The Linux Module integration runner did not identify its exact transient Core service unit",
  );
}

describe.skipIf(!available)("Linux Extension Module executor in a real control group", () => {
  it("runs one request and closes the exact authorized process generation", async ({
    onTestFinished,
  }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-linux-extension-executor-"));
    const statePath = join(scratch, "core-state.json");
    const effectPath = join(scratch, "effect-intents.json");
    const processGenerationId = `process-linux-extension-${process.pid}-${Date.now()}`;
    const identity = {
      instanceId: "instance-linux-extension",
      moduleId: "module-linux-extension",
      processGenerationId,
    } as const;
    const moduleCgroupPath = deriveModuleCgroupPath(delegatedRoot!, identity).filesystemPath;
    const serviceInvocationId = process.env.INVOCATION_ID;
    if (serviceInvocationId === undefined) {
      throw new Error("systemd did not provide INVOCATION_ID");
    }
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const now = (): string => new Date().toISOString();
    const { store, stoppedRecordWriter } =
      createFileCoreStateStoreWithStoppedRecordWriter({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => "unused-linux-extension-block",
        nextDeliveryId: (kind) => `unused-linux-extension-${kind}`,
        now,
      });
    store.deliveries.createPage("input");
    store.deliveries.registerConsumer("input", identity.moduleId, "from-now");
    const inputBlock = store.blocks.commit(
      {
        payload: {
          schema: "dolly.content/1",
          value: {
            items: [{ type: "text", text: "Return the isolated process identity." }],
          },
        },
      },
      { kind: "external", id: "integration-test" },
    );
    store.deliveries.append("input", inputBlock.id);
    const claim = store.deliveries.claim({
      consumerId: identity.moduleId,
      pageIds: ["input"],
      moduleGenerationId: MODULE_GENERATION_ID,
      maxCount: 1,
      maxBytes: 64 * 1_024,
    });
    if (claim === null) throw new Error("The Linux integration input was not claimed");
    const effectJournal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path: effectPath }),
      now,
    });
    const effectRunLifecycle = createExtensionEffectJournalLifecycle({
      journal: effectJournal,
      getModuleSubmissionRecord: (runId) => store.getModuleSubmissionRecord(runId),
    });
    const createdAt = now();
    const processRecord: ModuleProcessRecord = {
      schemaVersion: "dolly.module-process-record/1",
      ...identity,
      moduleGenerationId: MODULE_GENERATION_ID,
      packageDigest: `sha256:${"2".repeat(64)}`,
      configurationReference: {
        configId: "config-linux-extension",
        revision: `sha256:${"3".repeat(64)}`,
        configVersion: 1,
      },
      declaredExternalEffects: "none",
      serviceInvocationId,
      bootId,
      moduleCgroupPath,
      state: "starting",
      createdAt,
      updatedAt: createdAt,
    };

    const root = await prepareDelegatedCgroupRoot({
      delegatedRootCgroupPath: delegatedRoot!,
    });
    if (!root.prepared) {
      throw new Error(`${root.failure.code}: ${root.failure.detail}`);
    }

    let host: ExtensionProcessHost | undefined;
    let launchedProcess: ProcessIdentity | undefined;
    let protocolIdentifier = 0;
    const standardErrorChunks: Uint8Array[] = [];
    const executor = createLinuxExtensionModuleExecutor({
      moduleId: identity.moduleId,
      moduleGenerationId: MODULE_GENERATION_ID,
      lifecycle: {
        records: store,
        stoppedRecordWriter,
        processRecord,
        delegatedRootCgroupPath: delegatedRoot!,
        identity,
        limits: LIMITS,
        maxOpenFiles: 64,
        execution: {
          program: process.execPath,
          argumentVector: [process.execPath, FIXTURE_PATH, "process-id"],
          environment: {},
        },
      },
      launcher: {
        interpreterProgram: PYTHON,
        launcherScriptPath: defaultLauncherScriptPath(),
        launcherEnvironment: {},
        controllerTimeouts: {
          configureTimeoutMs: 5_000,
          inCgroupTimeoutMs: 5_000,
          membershipTimeoutMs: 5_000,
          exitObservationTimeoutMs: 5_000,
        },
      },
      host: {
        trust: "trusted",
        isolationPolicy: new ExtensionIsolationPolicy(),
        manifest: MANIFEST,
        moduleKind: "fixture",
        config: {},
        maxFrameBytes: 64 * 1_024,
        initializationTimeoutMs: 10_000,
        shutdownRequestTimeoutMs: 2_000,
        forceKillDelayMs: 500,
        terminationTimeoutMs: 10_000,
        effectRunLifecycle,
      },
      executionTimeoutMs: 5_000,
      cancellationGraceMs: 1_000,
      terminationTimeoutMs: 10_000,
      channelCloseTimeoutMs: 5_000,
      nextProtocolIdentifier: (purpose) =>
        `${purpose}-linux-extension-${++protocolIdentifier}`,
      configureHost: (configuredHost, authorized) => {
        host = configuredHost;
        launchedProcess = readProcessIdentity(authorized.launcher.processId);
      },
      onStandardErrorChunk: (chunk) => {
        // Retain only a finite diagnostic prefix in the test; the adapter
        // continues draining all later chunks without buffering them itself.
        if (standardErrorChunks.length < 8) standardErrorChunks.push(chunk);
      },
    });
    requireLifecycleOperations(executor);
    const terminationContext = {
      moduleId: identity.moduleId,
      moduleGenerationId: MODULE_GENERATION_ID,
    } as const;
    onTestFinished(async () => {
      try {
        await executor.terminate(terminationContext);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 30_000);

    await expect(executor.start()).resolves.toBeUndefined();
    expect(host?.snapshot).toMatchObject({
      state: "ready",
      instanceId: identity.instanceId,
      moduleId: identity.moduleId,
      moduleGenerationId: MODULE_GENERATION_ID,
      processGenerationId,
      pid: launchedProcess?.processId,
    });
    expect(launchedProcess).toBeDefined();
    expect(store.getModuleProcessRecord(processGenerationId)?.state).toBe("running");

    const input = store.deliveries.inspectClaimInput(claim);
    store.appendModuleSubmissionRecord({
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      processGenerationId,
      inputDigest: canonicalJsonDigest(input),
      createdAt: now(),
    });

    const result = await executor.execute(
      input,
      {
        moduleId: identity.moduleId,
        moduleGenerationId: MODULE_GENERATION_ID,
        moduleJobId: claim.moduleJobId,
        runId: claim.runId,
        attempt: claim.attempt,
        startedAt: Date.now(),
        signal: new AbortController().signal,
      },
    );
    expect(result).toEqual({ processId: launchedProcess?.processId });
    expect(effectJournal.evidenceForRun(claim)).toEqual({ kind: "no-effect" });
    expect(
      new EffectIntentJournal({
        store: new FileEffectIntentStore({ path: effectPath }),
        now,
      }).evidenceForRun(claim),
    ).toEqual({ kind: "no-effect" });

    await expect(executor.terminate(terminationContext)).resolves.toBeUndefined();
    expect(store.getModuleProcessRecord(processGenerationId)).toMatchObject({
      state: "stopped",
      processGenerationId,
      moduleCgroupPath,
    });
    expect(existsSync(moduleCgroupPath)).toBe(false);
    expect(
      await waitFor(
        () => launchedProcess === undefined || !sameLiveProcess(launchedProcess),
        5_000,
      ),
    ).toBe(true);
    expect(Buffer.concat(standardErrorChunks.map((chunk) => Buffer.from(chunk))).byteLength)
      .toBeLessThanOrEqual(64 * 1_024);

    console.info(JSON.stringify({
      processGenerationId,
      launcherProcessId: launchedProcess?.processId,
      moduleCgroupPath,
      result,
      finalRecordState: store.getModuleProcessRecord(processGenerationId)?.state,
      effectEvidence: effectJournal.evidenceForRun(claim).kind,
      cgroupRemoved: !existsSync(moduleCgroupPath),
      exactProcessIdentityGone:
        launchedProcess === undefined || !sameLiveProcess(launchedProcess),
    }));
  }, 90_000);

  it("executes the exact installed package and submission process generation", async ({
    onTestFinished,
  }) => {
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

    const scratchParent = resolve(process.cwd(), ".tmp");
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(scratchParent, "installed-linux-extension-integration-"));
    const statePath = join(scratch, "core-state.json");
    const packageSource = join(scratch, "package-source");
    mkdirSync(packageSource, { recursive: true, mode: 0o700 });
    copyFileSync(FIXTURE_PATH, join(packageSource, "extension-process-fixture.mjs"));
    const configurationSchema = {
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      properties: {
        confinementProbe: { const: true },
        coreProcessId: { type: "integer", minimum: 1 },
        coreStatePath: { type: "string", minLength: 1 },
        userManagerPath: { type: "string", minLength: 1 },
      },
      required: [
        "confinementProbe",
        "coreProcessId",
        "coreStatePath",
        "userManagerPath",
      ],
      additionalProperties: false,
    } as const;
    writeFileSync(join(packageSource, "dolly-extension.json"), JSON.stringify({
      schemaVersion: "dolly.extension-package/1",
      extensionId: "org.example.installed-linux",
      packageVersion: "1.0.0",
      displayName: "Installed Linux integration fixture",
      description: "Runs only from the integrity-checked installation registry.",
      supportedProtocolVersions: ["3.0"],
      entrypoint: "extension-process-fixture.mjs",
      modules: [{
        moduleKind: "fixture",
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
    // The source package is no longer available when the launcher starts. A
    // passing execution therefore came from the managed installed bytes.
    rmSync(packageSource, { recursive: true, force: true });
    const configurations = new ModuleConfigurationStore({
      directory: join(scratch, "configurations"),
    });
    const configuration = configurations.create({
      configId: "installed-linux-config",
      extensionId: "org.example.installed-linux",
      moduleKind: "fixture",
      configVersion: 1,
      schema: configurationSchema,
      configuration: {
        confinementProbe: true,
        coreProcessId: process.pid,
        coreStatePath: statePath,
        userManagerPath: process.env.XDG_RUNTIME_DIR ?? "/run/user/1001",
      },
    });
    const instanceId = "22222222-2222-4222-8222-222222222222";
    const defaults = createDefaultDollyInstanceConfig(instanceId);
    const instanceConfiguration = validateDollyInstanceConfig({
      ...defaults,
      pages: [{ pageId: "input" }],
      modules: [{
        moduleId: "installed-worker",
        extensionId: "org.example.installed-linux",
        packageVersion: "1.0.0",
        moduleKind: "fixture",
        isolation: "process",
        configurationReference: {
          configId: configuration.configId,
          revision: configuration.revision,
          configVersion: configuration.configVersion,
        },
        permissionPolicyIds: [],
        inputPageIds: ["input"],
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
    const now = (): string => new Date().toISOString();
    const { store, stoppedRecordWriter } =
      createFileCoreStateStoreWithStoppedRecordWriter({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => "unused-installed-linux-block",
        nextDeliveryId: (kind) => `unused-installed-linux-${kind}`,
        now,
      });
    store.deliveries.createPage("input");
    store.deliveries.registerConsumer("input", "installed-worker", "from-now");
    const inputBlock = store.blocks.commit(
      {
        payload: {
          schema: "dolly.content/1",
          value: { items: [{ type: "text", text: "Use the installed fixture." }] },
        },
      },
      { kind: "external", id: "installed-integration-test" },
    );
    store.deliveries.append("input", inputBlock.id);
    const claim = store.deliveries.claim({
      consumerId: "installed-worker",
      pageIds: ["input"],
      moduleGenerationId: MODULE_GENERATION_ID,
      maxCount: 1,
      maxBytes: 64 * 1_024,
    });
    if (claim === null) throw new Error("The installed integration input was not claimed");

    const root = await prepareDelegatedCgroupRoot({
      delegatedRootCgroupPath: inspectedBinding.binding.delegatedRootCgroupPath,
    });
    if (!root.prepared) {
      throw new Error(`${root.failure.code}: ${root.failure.detail}`);
    }

    const processGenerationId = `process-installed-linux-${process.pid}-${Date.now()}`;
    let launchedProcess: ProcessIdentity | undefined;
    let protocolIdentifier = 0;
    const factory = createInstalledLinuxExtensionModuleGenerationFactory({
      instanceConfiguration,
      moduleId: "installed-worker",
      installations,
      configurations,
      coreStateDirectory: store.stateDirectoryForProcessConfinement(),
      binding: inspectedBinding.binding,
      lifecycle: {
        records: store,
        stoppedRecordWriter,
        limits: LIMITS,
        maxOpenFiles: 64,
      },
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
        maxFrameBytes: 128 * 1_024,
        initializationTimeoutMs: 10_000,
        shutdownRequestTimeoutMs: 2_000,
        forceKillDelayMs: 500,
        terminationTimeoutMs: 10_000,
      },
      executionTimeoutMs: 5_000,
      cancellationGraceMs: 1_000,
      terminationTimeoutMs: 10_000,
      channelCloseTimeoutMs: 5_000,
      nextProcessGenerationId: () => processGenerationId,
      wallClockNow: Date.now,
      nextProtocolIdentifier: (purpose) =>
        `${purpose}-installed-linux-${++protocolIdentifier}`,
      onAuthorizedProcessId: (authorizedProcessId) => {
        launchedProcess = readProcessIdentity(authorizedProcessId);
      },
    });
    const executor = factory.createExecutor(MODULE_GENERATION_ID);
    requireLifecycleOperations(executor);
    const terminationContext = {
      moduleId: "installed-worker",
      moduleGenerationId: MODULE_GENERATION_ID,
    } as const;
    onTestFinished(async () => {
      try {
        await executor.terminate(terminationContext);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 30_000);

    expect(factory.processGenerationIdFor(MODULE_GENERATION_ID)).toBe(processGenerationId);
    expect(store.getModuleProcessRecord(processGenerationId)).toBeUndefined();
    await expect(executor.start()).resolves.toBeUndefined();
    expect(launchedProcess).toBeDefined();
    const liveSession = factory.sessionForProcess(processGenerationId);
    expect(liveSession).toMatchObject({
      extensionId: installed.manifest.extensionId,
      instanceId,
      moduleId: "installed-worker",
      moduleGenerationId: MODULE_GENERATION_ID,
      processGenerationId,
    });
    expect(liveSession?.sessionId).toMatch(/^session-/u);
    expect(factory.sessionForProcess("process-installed-linux-foreign")).toBeNull();
    expect(store.getModuleProcessRecord(processGenerationId)).toMatchObject({
      state: "running",
      packageDigest: installed.packageDigest,
      configurationReference: instanceConfiguration.modules[0]?.configurationReference,
      declaredExternalEffects: "unrestricted",
      serviceInvocationId: inspectedBinding.binding.serviceInvocationId,
      bootId: inspectedBinding.binding.bootId,
    });

    const input = store.deliveries.inspectClaimInput(claim);
    store.appendModuleSubmissionRecord({
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      processGenerationId: factory.processGenerationIdFor(claim.moduleGenerationId),
      inputDigest: canonicalJsonDigest(input),
      createdAt: now(),
    });
    const result = await executor.execute(input, {
      moduleId: "installed-worker",
      moduleGenerationId: MODULE_GENERATION_ID,
      moduleJobId: claim.moduleJobId,
      runId: claim.runId,
      attempt: claim.attempt,
      startedAt: Date.now(),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      ok: true,
      input,
      confinement: {
        processId: 2,
        userId: process.getuid?.(),
        currentDirectory: "/run/dolly/extension",
        entrypointPath: "/run/dolly/extension/extension-process-fixture.mjs",
        cgroup: "0::/",
        networkRouteRows: 0,
        environmentKeys: ["PWD"],
        cgroupWrite: { outcome: "denied" },
        coreSignal: { outcome: "denied", code: "ESRCH" },
        coreProcessRead: { outcome: "denied", code: "ENOENT" },
        coreStateRead: { outcome: "denied", code: "ENOENT" },
        userManagerVisible: false,
      },
    });
    const confinement = (result as unknown as {
      confinement: {
        cgroupNamespace: string;
        networkNamespace: string;
      };
    }).confinement;
    expect(confinement.cgroupNamespace).not.toBe(readlinkSync("/proc/self/ns/cgroup"));
    expect(confinement.networkNamespace).not.toBe(readlinkSync("/proc/self/ns/net"));
    expect(store.releaseDeliveryClaim(claim)).toBe("released");
    expect(store.getModuleSubmissionRecord(claim.runId)).toBeUndefined();

    await expect(executor.terminate(terminationContext)).resolves.toBeUndefined();
    expect(factory.sessionForProcess(processGenerationId)).toBeNull();
    const moduleCgroupPath = deriveModuleCgroupPath(
      inspectedBinding.binding.delegatedRootCgroupPath,
      { instanceId, moduleId: "installed-worker", processGenerationId },
    ).filesystemPath;
    expect(store.getModuleProcessRecord(processGenerationId)).toMatchObject({
      state: "stopped",
      packageDigest: installed.packageDigest,
      moduleCgroupPath,
    });
    expect(existsSync(moduleCgroupPath)).toBe(false);
    expect(
      await waitFor(
        () => launchedProcess === undefined || !sameLiveProcess(launchedProcess),
        5_000,
      ),
    ).toBe(true);

    console.info(JSON.stringify({
      installedPackageDigest: installed.packageDigest,
      installedEntrypoint: installed.entrypointPath,
      processGenerationId,
      launcherProcessId: launchedProcess?.processId,
      moduleCgroupPath,
      finalRecordState: store.getModuleProcessRecord(processGenerationId)?.state,
      cgroupRemoved: !existsSync(moduleCgroupPath),
      exactProcessIdentityGone:
        launchedProcess === undefined || !sameLiveProcess(launchedProcess),
    }));
  }, 90_000);
});
