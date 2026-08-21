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
import {
  createFileCoreStateStoreWithStoppedRecordWriter,
  migrateCoreStateDocumentToVersion19,
} from "../../../src/core/file-core-state-store.js";
import { FileMediaByteStore } from "../../../src/core/file-media-byte-store.js";
import {
  deriveModuleCgroupPath,
  prepareDelegatedCgroupRoot,
  type ModuleCgroupLimits,
} from "../../../src/core/linux-module-cgroup.js";
import { createFileCoreActiveRunModelMediaResolver } from "../../../src/core/media-capability/index.js";
import type { ModelMediaResolutionRequest } from "../../../src/core/model-provider-broker.js";
import { inspectCoreServiceBinding } from "../../../src/core/linux-core-service-binding.js";
import { decideLinuxModuleActivation } from "../../../src/core/linux-module-activation.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import type { ModuleExecutor } from "../../../src/core/module-actor.js";
import { ModuleConfigurationStore } from "../../../src/core/module-configuration-store.js";
import type {
  ModuleProcessRecord,
  ModuleProcessStartingRecordInput,
} from "../../../src/core/module-process-records.js";
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
    // The caller does not provide a process-generation identifier in the
    // version 19 identity domain: the migrated store mints one. This fixed
    // allocator-input identity is never exposed to Host/session/store/cgroup;
    // the durable `_v19_host_N` minted by the store on start is captured and
    // every assertion keys on it.
    const identity = {
      instanceId: "instance-linux-extension",
      moduleId: "module-linux-extension",
      processGenerationId: "process-linux-extension",
    } as const;
    // Path used only by the legacy twin the executor's construction checks
    // against its allocator input; the durable record's path is derived from
    // the allocated identifier below.
    const moduleCgroupPath = deriveModuleCgroupPath(delegatedRoot!, identity).filesystemPath;
    const serviceInvocationId = process.env.INVOCATION_ID;
    if (serviceInvocationId === undefined) {
      throw new Error("systemd did not provide INVOCATION_ID");
    }
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const now = (): string => new Date().toISOString();
    // Persist a fresh version 18 Core-state document exactly as an operator
    // would, then explicitly migrate it to version 19 through the public path,
    // and reopen the migrated document so the store itself allocates.
    createFileCoreStateStoreWithStoppedRecordWriter({
      path: statePath,
      maxFailedAttempts: 3,
      nextBlockId: () => "unused-linux-extension-block",
      nextDeliveryId: (kind) => `unused-linux-extension-${kind}`,
      now,
    });
    const migration = migrateCoreStateDocumentToVersion19(statePath, {
      runtimeConfiguration: {
        maxFailedAttempts: 3,
        media: { enabled: false },
      },
    });
    if (migration.status !== "migrated") {
      throw new Error(
        `The fresh state file did not migrate to version 19: ${JSON.stringify(migration)}`,
      );
    }
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
    // The id-less twin the migrated version 19 store itself completes.
    const startingRecord: ModuleProcessStartingRecordInput = {
      schemaVersion: "dolly.module-process-record/1",
      instanceId: identity.instanceId,
      moduleId: identity.moduleId,
      moduleGenerationId: MODULE_GENERATION_ID,
      packageDigest: processRecord.packageDigest,
      configurationReference: processRecord.configurationReference,
      declaredExternalEffects: processRecord.declaredExternalEffects,
      serviceInvocationId,
      bootId,
      delegatedRootCgroupPath: delegatedRoot!,
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
    let durableProcessGenerationId: string | undefined;
    let protocolIdentifier = 0;
    const standardErrorChunks: Uint8Array[] = [];
    const executor = createLinuxExtensionModuleExecutor({
      moduleId: identity.moduleId,
      moduleGenerationId: MODULE_GENERATION_ID,
      lifecycle: {
        records: store,
        stoppedRecordWriter,
        processRecord,
        startingRecord,
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
        durableProcessGenerationId = authorized.record.processGenerationId;
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
    if (durableProcessGenerationId === undefined) {
      throw new Error("Starting did not surface the store-minted durable process generation");
    }
    expect(/^_v19_host_[1-9][0-9]*$/u.test(durableProcessGenerationId)).toBe(true);
    // The allocator input is never persisted: the durable identifier is the
    // only one, so a caller-exposing value cannot appear in any record or path.
    expect(store.getModuleProcessRecord(identity.processGenerationId)).toBeUndefined();
    const durableModuleCgroupPath = deriveModuleCgroupPath(
      delegatedRoot!,
      { ...identity, processGenerationId: durableProcessGenerationId },
    ).filesystemPath;
    expect(host?.snapshot).toMatchObject({
      state: "ready",
      instanceId: identity.instanceId,
      moduleId: identity.moduleId,
      moduleGenerationId: MODULE_GENERATION_ID,
      processGenerationId: durableProcessGenerationId,
      pid: launchedProcess?.processId,
    });
    expect(launchedProcess).toBeDefined();
    expect(store.getModuleProcessRecord(durableProcessGenerationId)?.state).toBe("running");

    const input = store.deliveries.inspectClaimInput(claim);
    store.appendModuleSubmissionRecord({
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      processGenerationId: durableProcessGenerationId,
      inputDigest: canonicalJsonDigest(input),
      createdAt: now(),
    });

    // The run admission must be prepared on the authorized process before
    // `execute` can dispatch, mirroring the ModuleActor sequence.
    expect(await executor.prepareRun?.()).toEqual({ status: "ready" });
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
    expect(store.getModuleProcessRecord(durableProcessGenerationId)).toMatchObject({
      state: "stopped",
      processGenerationId: durableProcessGenerationId,
      moduleCgroupPath: durableModuleCgroupPath,
    });
    expect(existsSync(durableModuleCgroupPath)).toBe(false);
    expect(
      await waitFor(
        () => launchedProcess === undefined || !sameLiveProcess(launchedProcess),
        5_000,
      ),
    ).toBe(true);
    expect(Buffer.concat(standardErrorChunks.map((chunk) => Buffer.from(chunk))).byteLength)
      .toBeLessThanOrEqual(64 * 1_024);

    console.info(JSON.stringify({
      processGenerationId: durableProcessGenerationId,
      launcherProcessId: launchedProcess?.processId,
      moduleCgroupPath: durableModuleCgroupPath,
      result,
      finalRecordState: store.getModuleProcessRecord(durableProcessGenerationId)?.state,
      effectEvidence: effectJournal.evidenceForRun(claim).kind,
      cgroupRemoved: !existsSync(durableModuleCgroupPath),
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
    const activation = await decideLinuxModuleActivation({
      unitName: integrationUnitName,
      mode: "user",
      queryTimeoutMs: 5_000,
      overallTimeoutMs: 15_000,
    });
    if (!activation.permitted) {
      throw new Error(activation.refusals
        .map((failure) => `${failure.code}: ${failure.detail}`)
        .join("; "));
    }
    expect(activation.binding.delegatedRootCgroupPath).toBe(delegatedRoot);

    const scratchParent = resolve(process.cwd(), ".tmp");
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(scratchParent, "installed-linux-extension-integration-"));
    const statePath = join(scratch, "instance-state", "core-state.json");
    const siblingPrivateDirectory = join(scratch, "sibling-private-state");
    const siblingPrivatePath = join(siblingPrivateDirectory, "private.txt");
    mkdirSync(siblingPrivateDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(siblingPrivatePath, "another-instance-secret\n", { mode: 0o600 });
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
        siblingPrivatePath: { type: "string", minLength: 1 },
        userManagerPath: { type: "string", minLength: 1 },
      },
      required: [
        "confinementProbe",
        "coreProcessId",
        "coreStatePath",
        "siblingPrivatePath",
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
        siblingPrivatePath,
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
    const mediaBytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4);
    const storeOptions = {
      path: statePath,
      maxFailedAttempts: 3,
      nextBlockId: () => "unused-installed-linux-block",
      nextDeliveryId: (kind: string) => `unused-installed-linux-${kind}`,
      now,
      media: {
        durability: "persistent" as const,
        bytes: new FileMediaByteStore({
          directory: resolve(scratch, "media"),
          maxMediaBytes: 1_024,
        }),
        inspector: {
          inspect: async () => ({ mimeType: "image/png", width: 2, height: 1 }),
        },
        maxMediaBytes: 1_024,
        idNamespace: "installed-linux-active-run",
      },
    };
    // Persist a fresh version 18 document, migrate it to version 19 through
    // the public path, then reopen so the store itself mints identifiers.
    createFileCoreStateStoreWithStoppedRecordWriter(storeOptions);
    const migration = migrateCoreStateDocumentToVersion19(statePath, {
      runtimeConfiguration: {
        maxFailedAttempts: 3,
        media: {
          enabled: true,
          idNamespace: "installed-linux-active-run",
          maxMediaBytes: 1_024,
          maxTotalMediaBytes: 1_024_000,
          maxRegistrationRecords: 10_000,
          maxStorageRecords: 10_000,
          maxProviderAccessRecords: 10_000,
          deletedRegistrationRetentionMs: 24 * 60 * 60 * 1_000,
        },
      },
    });
    if (migration.status !== "migrated") {
      throw new Error(
        `The installed state file did not migrate to version 19: ${JSON.stringify(migration)}`,
      );
    }
    const { store, stoppedRecordWriter } =
      createFileCoreStateStoreWithStoppedRecordWriter(storeOptions);
    if (!store.media) throw new Error("The installed integration Media store is absent");
    store.deliveries.createPage("input");
    store.deliveries.registerConsumer("input", "installed-worker", "from-now");
    const registeredMedia = await store.media.registerMedia({
      registrationId: "installed-linux-active-run-media",
      bytes: mediaBytes,
      declaredMimeType: "image/png",
      provenance: { sourceClass: "streamed-upload" },
    });
    const inputBlock = store.blocks.commit(
      {
        payload: {
          schema: "dolly.content/1",
          value: { items: [
            { type: "text", text: "Use the installed fixture." },
            { type: "media-reference", mediaId: registeredMedia.mediaId },
          ] },
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

    const processGenerationId = `process-installed-linux-${process.pid}-${Date.now()}`;
    let launchedProcess: ProcessIdentity | undefined;
    let protocolIdentifier = 0;
    const factory = createInstalledLinuxExtensionModuleGenerationFactory({
      instanceConfiguration,
      moduleId: "installed-worker",
      installations,
      configurations,
      coreStateDirectory: store.stateDirectoryForProcessConfinement(),
      activation,
      lifecycle: {
        records: store,
        stoppedRecordWriter,
        limits: LIMITS,
        maxOpenFiles: 64,
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
    const verifiedEntrypoint = readFileSync(installed.entrypointPath, "utf8");
    const changedEntrypoint = verifiedEntrypoint.replace(
      "? { ok: true, input: params.input, confinement: confinementReport() }",
      "? { ok: \"tampered-after-resolution\", input: params.input, confinement: confinementReport() }",
    );
    expect(changedEntrypoint).not.toBe(verifiedEntrypoint);
    // The execution handle must own the bytes validated while it was created.
    // Mutating the managed path afterwards is the time-of-check/time-of-use
    // counterexample: a path-only launcher will run this changed response while
    // persisting the digest of the earlier package.
    writeFileSync(installed.entrypointPath, changedEntrypoint, "utf8");
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

    expect(() => factory.processGenerationIdFor(MODULE_GENERATION_ID))
      .toThrow(/does not have a process generation/u);
    expect(store.getModuleProcessRecord(processGenerationId)).toBeUndefined();
    await expect(executor.start()).resolves.toBeUndefined();
    expect(launchedProcess).toBeDefined();
    const durableProcessGenerationId =
      factory.processGenerationIdFor(MODULE_GENERATION_ID);
    const liveSession = factory.sessionForProcess(durableProcessGenerationId);
    expect(liveSession).toMatchObject({
      extensionId: installed.manifest.extensionId,
      instanceId,
      moduleId: "installed-worker",
      moduleGenerationId: MODULE_GENERATION_ID,
      processGenerationId: durableProcessGenerationId,
    });
    expect(liveSession?.sessionId).toMatch(/^session-/u);
    expect(factory.sessionForProcess("process-installed-linux-foreign")).toBeNull();
    expect(store.getModuleProcessRecord(durableProcessGenerationId)).toMatchObject({
      state: "running",
      packageDigest: installed.packageDigest,
      configurationReference: instanceConfiguration.modules[0]?.configurationReference,
      declaredExternalEffects: "unrestricted",
      serviceInvocationId: activation.binding.serviceInvocationId,
      bootId: activation.binding.bootId,
    });

    const input = store.deliveries.inspectClaimInput(claim);
    store.appendModuleSubmissionRecord({
      schemaVersion: "dolly.module-submission-record/2",
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      processGenerationId: factory.processGenerationIdFor(claim.moduleGenerationId),
      inputDigest: canonicalJsonDigest(input),
      dispatchState: "prepared",
      createdAt: now(),
    });
    const mediaResolver = createFileCoreActiveRunModelMediaResolver({
      core: store,
      extensionId: installed.manifest.extensionId,
      instanceId,
      moduleId: "installed-worker",
      sessionForProcess: factory.sessionForProcess,
      now,
    });
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const mediaRequest: ModelMediaResolutionRequest = {
      schemaVersion: "dolly.model.media-resolution-request/1",
      modelRequestId: "installed-linux-model-request",
      mediaRequestId: "installed-linux-media-request",
      recipientId: "installed-linux-recipient",
      descriptor: {
        endpointId: "installed-linux-endpoint",
        operation: "chat-completion",
        modelId: "installed-linux-model",
        adapterId: "openai-compatible-chat",
        adapterVersion: "v1",
        descriptorVersion: "installed-linux-descriptor",
        descriptorDigest: `sha256:${"c".repeat(64)}`,
      },
      binding: {
        endpointId: "installed-linux-endpoint",
        bindingRevision: "installed-linux-binding",
      },
      context: {
        operationId: "installed-linux-operation",
        instanceId,
        ownerScope: "installed-linux-owner",
        moduleId: "installed-worker",
        moduleGenerationId: claim.moduleGenerationId,
        moduleJobId: claim.moduleJobId,
        runId: claim.runId,
        attempt: claim.attempt,
        sessionId: liveSession!.sessionId,
        deadline,
      },
      messageIndex: 0,
      partIndex: 1,
      mediaReference: { type: "media-reference", mediaId: registeredMedia.mediaId },
      requirement: {
        requirementId: "installed-inline-png-v1",
        modality: "image",
        mimeTypes: ["image/png"],
        deliveryModes: ["inline"],
        maxItems: 1,
        maxBytesPerItem: 1_024,
        maxAggregateBytes: 1_024,
        providerFetchesAfterAcceptance: false,
        lifetimeStrategyId: "media.inline-copy.v1",
        placementStrategyId: "openai.chat.media.inline-image-url.v1",
      },
      acceptedAccessModes: ["inline"],
      deadline,
      limits: {
        maxItemsRemaining: 1,
        maxBytesForItem: 1_024,
        maxResolvedBytesRemaining: 1_024,
      },
    };
    await expect(mediaResolver.resolve(mediaRequest, {})).resolves.toMatchObject({
      mediaId: registeredMedia.mediaId,
      digest: registeredMedia.digest,
      byteLength: mediaBytes.byteLength,
      width: 2,
      height: 1,
      accessMode: "inline",
      inline: { data: Buffer.from(mediaBytes).toString("base64") },
    });
    expect(store.media.referenceGraph.leaseCountFor({
      kind: "media",
      id: registeredMedia.mediaId,
    })).toBe(0);
    expect(await executor.prepareRun?.()).toEqual({ status: "ready" });
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
        siblingPrivateRead: { outcome: "denied", code: "ENOENT" },
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
    expect(factory.sessionForProcess(durableProcessGenerationId)).toBeNull();
    await expect(mediaResolver.resolve(mediaRequest, {})).rejects.toThrow("not authorized");
    const moduleCgroupPath = deriveModuleCgroupPath(
      activation.binding.delegatedRootCgroupPath,
      { instanceId, moduleId: "installed-worker", processGenerationId: durableProcessGenerationId },
    ).filesystemPath;
    expect(store.getModuleProcessRecord(durableProcessGenerationId)).toMatchObject({
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
      processGenerationId: durableProcessGenerationId,
      launcherProcessId: launchedProcess?.processId,
      moduleCgroupPath,
      finalRecordState: store.getModuleProcessRecord(durableProcessGenerationId)?.state,
      cgroupRemoved: !existsSync(moduleCgroupPath),
      exactProcessIdentityGone:
        launchedProcess === undefined || !sameLiveProcess(launchedProcess),
    }));
  }, 90_000);
});
