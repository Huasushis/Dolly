import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activationFixture = vi.hoisted(() => ({
  binding: {
    mode: "system" as const,
    unitName: "dolly-core.service",
    serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
    bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
    mainPid: 10_001,
    delegatedRootCgroupPath: "/system.slice/dolly-core.service",
    coreCgroupPath: "/system.slice/dolly-core.service/core",
    delegatedRootControllers: ["cpu", "memory", "pids"],
  },
  root: {
    filesystemPath: "/sys/fs/cgroup/system.slice/dolly-core.service",
    controllers: ["cpu", "memory", "pids"],
    subtreeControl: ["cpu", "memory", "pids"],
  },
}));

vi.mock("../../../src/core/host-platform.js", () => ({
  observeHostPlatform: () => "linux",
}));
vi.mock("../../../src/core/linux-core-service-binding.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/core/linux-core-service-binding.js")>(),
  inspectCoreServiceBinding: vi.fn(async () => ({
    verified: true as const,
    binding: activationFixture.binding,
  })),
}));
vi.mock("../../../src/core/linux-module-cgroup.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/core/linux-module-cgroup.js")>(),
  prepareDelegatedCgroupRoot: vi.fn(async () => ({
    prepared: true as const,
    root: activationFixture.root,
  })),
}));
vi.mock("../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js")>();
  return {
    ...original,
    startLinuxModuleLauncher: vi.fn(() => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return {
        processId: 4242,
        child: { stdin, stdout, stderr },
        controller: {},
        waitForExit: () => Promise.resolve(true),
        exit: undefined,
        launchError: undefined,
        waitForLaunchError: () => Promise.resolve(undefined),
        writeRawControlBytes: () => undefined,
        closeControlChannel: () => undefined,
      };
    }),
  };
});
vi.mock("../../../src/adapters/linux-module-launcher/module-launcher-control.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/adapters/linux-module-launcher/module-launcher-control.js")>();
  return {
    ...original,
    createModuleLauncherControl: vi.fn(() => ({
      processId: 4242,
      configure: async () => undefined,
      authorizeExecution: async () => ({
        executionAuthorized: true,
        verifiedProcessIds: [4242],
      }) as const,
      requestExit: async () => true,
    })),
  };
});
vi.mock("../../../src/adapters/extension-process-module-executor.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/adapters/extension-process-module-executor.js")>();
  return {
    ...original,
    createExtensionProcessLinuxProtocolSession: vi.fn(() => ({
      initialize: async () => undefined,
      execute: async () => ({ schemaVersion: "dolly.module-result/1" }) as ReactiveModuleResult,
      cancel: async () => undefined,
      closeCapabilitySession: async () => undefined,
      waitForChannelClosed: async () => true,
    })),
  };
});
vi.mock("../../../src/core/extension-process-host.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/core/extension-process-host.js")>();
  return {
    ...original,
    ExtensionProcessHost: class {
      readonly options: {
        instanceId: string;
        moduleId: string;
        moduleGenerationId: string;
        moduleKind: string;
        manifest: { extensionId: string; packageVersion: string };
        nextIdentifier?: (purpose: "process-generation" | "session" | "request") => string;
      };
      readonly processGenerationId: string;
      readonly sessionId: string;
      constructor(options: {
        instanceId: string;
        moduleId: string;
        moduleGenerationId: string;
        moduleKind: string;
        manifest: { extensionId: string; packageVersion: string };
        nextIdentifier?: (purpose: "process-generation" | "session" | "request") => string;
      }) {
        this.options = { ...options };
        this.processGenerationId =
          options.nextIdentifier?.("process-generation") ?? "process-generation";
        this.sessionId = options.nextIdentifier?.("session") ?? "session";
      }
      get snapshot(): Record<string, unknown> {
        return Object.freeze({
          isolation: "process",
          state: "created",
          extensionId: this.options.manifest.extensionId,
          instanceId: this.options.instanceId,
          moduleId: this.options.moduleId,
          moduleGenerationId: this.options.moduleGenerationId,
          processGenerationId: this.options.nextIdentifier?.("process-generation") ?? this.processGenerationId,
          sessionId: this.sessionId,
        });
      }
    },
  };
});
vi.mock("../../../src/linux-module-runtime-assets.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/linux-module-runtime-assets.js")>();
  return {
    ...original,
    inspectReviewedLinuxModuleRuntime: vi.fn(async () => ({
      available: true as const,
      runtime: original.reviewedLinuxModuleRuntimeIdentity(),
    })),
  };
});
import {
  createInstalledLinuxExtensionModuleExecutor,
  createInstalledLinuxExtensionModuleGenerationFactory,
  deriveInstalledLinuxExtensionModuleExecutor,
  deriveReservedV10InstalledLinuxModuleExecutionPlan,
  deriveReservedV10InstalledModuleProcessProvenance,
  assertReservedV10InstalledModuleProcessProvenance,
  type InstalledLinuxExtensionModuleExecutorOptions,
} from "../../../src/adapters/installed-linux-extension-module-executor.js";
import {
  createLinuxModuleExecutor,
  type LinuxModuleAuthorizedProcess,
  type LinuxModuleProtocolSession,
} from "../../../src/adapters/linux-module-executor.js";
import {
  LINUX_PACKAGE_SNAPSHOT_BOOTSTRAP,
  LINUX_PROCESS_CONFINEMENT_PROGRAM,
} from "../../../src/adapters/linux-process-confinement.js";
import {
  defaultLauncherScriptPath,
  REVIEWED_LINUX_MODULE_LAUNCHER_DIGEST,
} from "../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js";
import {
  assertReservedV10InstalledPermissionPolicySelection,
  reservedV10InstalledPermissionPolicyRevision,
  ReservedV10InstalledPermissionPolicyRegistry,
  type InstalledModulePrivateStoragePolicy,
} from "../../../src/adapters/installed-module-permission-policy.js";
import {
  reviewedLinuxModuleRuntimeIdentity,
} from "../../../src/linux-module-runtime-assets.js";
import {
  canonicalJsonDigest,
  type JsonValue,
} from "../../../src/core/canonical-json.js";
import { ModulePrivateStorageBackend } from "../../../src/core/capabilities/module-private-storage-capability.js";
import { ExtensionIsolationPolicy } from "../../../src/core/extension-process-host.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import {
  resolveInstalledContentSchemaRegistrationSet,
  resolveInstalledExtensionModule,
  resolveReservedV10InstalledModulePlan,
} from "../../../src/core/installed-extension-module.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import {
  decideLinuxModuleActivation,
  type LinuxModuleActivationPermission,
} from "../../../src/core/linux-module-activation.js";
import type { ModuleProcessRecordStore } from "../../../src/core/linux-module-process-lifecycle.js";
import type {
  ModuleProcessRecord,
  ModuleProcessStoppedRecordWriter,
} from "../../../src/core/module-process-records.js";
import type { ReactiveModuleResult } from "../../../src/core/reactive-module-runtime.js";
import {
  createVersion19RecordStore,
  version19CgroupPath,
  VERSION19_MINTED_PROCESS_GENERATION_ID,
} from "./fixtures/linux-module-executor-version19.js";
import { ModuleConfigurationStore } from "../../../src/core/module-configuration-store.js";
import {
  createDefaultDollyInstanceConfig,
  validateDollyInstanceConfig,
  type DollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME = reviewedLinuxModuleRuntimeIdentity();
const PROCESS_IDENTITY = {
  instanceId: INSTANCE_ID,
  moduleId: "worker",
  processGenerationId: "process-installed-1",
} as const;
const MODULE_GENERATION_ID = "module-installed-1";
const DELEGATED_ROOT = "/system.slice/dolly-core.service";
const CORE_BINDING = {
  mode: "system",
  unitName: "dolly-core.service",
  serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
  bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
  mainPid: 10_001,
  delegatedRootCgroupPath: DELEGATED_ROOT,
  coreCgroupPath: `${DELEGATED_ROOT}/core`,
  delegatedRootControllers: ["cpu", "memory", "pids"],
} as const;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratchParent = resolve(repositoryRoot, "..", ".tmp");
const CONFIGURATION_SCHEMA = {
  $schema: JSON_SCHEMA_2020_12,
  type: "object",
  properties: { prefix: { type: "string" } },
  required: ["prefix"],
  additionalProperties: false,
} as const;
const CONTENT_SCHEMA = {
  $schema: JSON_SCHEMA_2020_12,
  type: "object",
  properties: { value: { type: "string", minLength: 1 } },
  required: ["value"],
  additionalProperties: false,
} as const;

function writePackage(
  directory: string,
  packageVersion: string,
  configurationSchema: object = CONFIGURATION_SCHEMA,
): void {
  mkdirSync(resolve(directory, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(directory, "dist", "main.mjs"),
    "export const installedFixture = true;\n",
    "utf8",
  );
  writeFileSync(resolve(directory, "dolly-extension.json"), JSON.stringify({
    schemaVersion: "dolly.extension-package/1",
    extensionId: "org.example.installed",
    packageVersion,
    displayName: "Installed fixture",
    description: "Exercises installation and configuration provenance.",
    supportedProtocolVersions: ["3.0"],
    entrypoint: "dist/main.mjs",
    modules: [{
      moduleKind: "transform",
      activation: "reactive",
      configVersion: 1,
      configurationSchema,
    }],
    requestedCapabilities: [],
  }), "utf8");
}

function writePackageV2(directory: string, packageVersion: string): void {
  mkdirSync(resolve(directory, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(directory, "dist", "main.mjs"),
    "export const installedFixture = true;\n",
    "utf8",
  );
  writeFileSync(resolve(directory, "dolly-extension.json"), JSON.stringify({
    schemaVersion: "dolly.extension-package/2",
    extensionId: "org.example.installed",
    packageVersion,
    displayName: "Installed fixture",
    description: "Exercises installation and content schema provenance.",
    supportedProtocolVersions: ["3.0"],
    entrypoint: "dist/main.mjs",
    modules: [{
      moduleKind: "transform",
      activation: "reactive",
      configVersion: 1,
      configurationSchema: CONFIGURATION_SCHEMA,
      producedContentSchemas: [{
        schema: "org.example.installed.result/1",
        validator: CONTENT_SCHEMA,
        validatorDigest: canonicalJsonDigest(CONTENT_SCHEMA),
        maxValueBytes: 256,
        containsCoreReferences: false,
      }],
    }],
    requestedCapabilities: [],
  }), "utf8");
}

function writePackageV3(directory: string, packageVersion: string): void {
  mkdirSync(resolve(directory, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(directory, "dist", "main.mjs"),
    "export const installedSourceFixture = true;\n",
    "utf8",
  );
  writeFileSync(resolve(directory, "dolly-extension.json"), JSON.stringify({
    schemaVersion: "dolly.extension-package/3",
    extensionId: "org.example.installed",
    packageVersion,
    displayName: "Installed source fixture",
    description: "Exercises source activation and content schema provenance.",
    supportedProtocolVersions: ["3.0"],
    entrypoint: "dist/main.mjs",
    modules: [{
      moduleKind: "transform",
      activation: "source",
      configVersion: 1,
      configurationSchema: CONFIGURATION_SCHEMA,
      producedContentSchemas: [{
        schema: "org.example.installed.result/1",
        validator: CONTENT_SCHEMA,
        validatorDigest: canonicalJsonDigest(CONTENT_SCHEMA),
        maxValueBytes: 256,
        containsCoreReferences: false,
      }],
    }],
    requestedCapabilities: [],
  }), "utf8");
}

function instanceConfiguration(
  packageVersion: string,
  revision: string,
  activation: JsonValue = { kind: "reactive" },
): DollyInstanceConfig {
  const defaults = createDefaultDollyInstanceConfig(INSTANCE_ID);
  const source = typeof activation === "object" && activation !== null &&
    Reflect.get(activation, "kind") === "source";
  return validateDollyInstanceConfig({
    ...defaults,
    pages: [{ pageId: "input" }, { pageId: "output" }],
    modules: [{
      moduleId: "worker",
      extensionId: "org.example.installed",
      packageVersion,
      moduleKind: "transform",
      isolation: "process",
      configurationReference: {
        configId: "worker-config",
        revision,
        configVersion: 1,
      },
      permissionPolicyIds: [],
      inputPageIds: source ? [] : ["input"],
      outputPageIds: ["output"],
      subscriptionStart: source ? "from-head" : "from-now",
      activation,
      limits: {
        claim: source ? null : { maxCount: 1, maxBytes: 4096 },
        maxInputBytes: 4096,
        maxResultBytes: 4096,
        maxFrameBytes: 8192,
        maxRunsPerGeneration: 10,
        maxGenerations: 2,
      },
      timeouts: {
        initializationTimeoutMs: 1000,
        executionTimeoutMs: 1000,
        cancellationGraceMs: 100,
        terminationTimeoutMs: 1000,
      },
    }],
  });
}

function reservedV10InstanceConfiguration(
  packageVersion: string,
  revision: string,
  overrides: Readonly<Record<string, JsonValue>> = {},
): JsonValue {
  const defaults = createDefaultDollyInstanceConfig(INSTANCE_ID);
  return {
    schemaVersion: "dolly.instance/10",
    instanceId: INSTANCE_ID,
    displayName: "Reserved v10 installed fixture",
    stateDirectory: null,
    core: {
      limits: {
        ...defaults.core.limits,
        maxRegisteredContentValueBytes: 64 * 1024,
      },
      media: defaults.core.media,
      scheduler: {
        pollIntervalMs: 100,
        retryBaseMs: 250,
        retryMaxMs: 30_000,
        maxConcurrentModules: 1,
        backpressureAction: "pause-upstream",
        downstreamRecheckMs: 100,
        noProgressAfterMs: 5_000,
        retryJitterBasisPoints: 0,
        lowWatermarkBasisPoints: 10_000,
        policy: { kind: "fixed" },
        policyFailureAction: "quarantine",
      },
    },
    pages: [{ pageId: "input" }, { pageId: "output" }],
    modules: [{
      moduleId: "worker",
      extensionId: "org.example.installed",
      packageVersion,
      moduleKind: "transform",
      configurationReference: {
        configId: "worker-config",
        revision,
        configVersion: 1,
      },
      permissionPolicyReferences: [],
      inputConnections: [{ pageId: "input", start: "from-now" }],
      outputPageIds: ["output"],
      activation: { kind: "reactive" },
      declaredExternalEffects: "none",
      execution: {
        kind: "linux-process",
        isolation: "process",
        limits: {
          memoryMaxBytes: 64 * 1024 * 1024,
          maxTasks: 32,
          cpuQuotaMicros: 100_000,
          cpuPeriodMicros: 100_000,
          maxOpenFiles: 128,
        },
      },
      limits: {
        claim: {
          baselineCount: 1,
          baselineBytes: 4096,
          maxCount: 1,
          maxBytes: 4096,
        },
        mailbox: { maxResidentCount: 16, maxResidentBytes: 64 * 1024 },
        sourceRequestMaxBytes: null,
        maxInputBytes: 4096,
        maxResultBytes: 4096,
        maxFrameBytes: 8192,
        maxRunsPerGeneration: 10,
        maxGenerations: 2,
      },
      timeouts: {
        initializationTimeoutMs: 1000,
        executionTimeoutMs: 1000,
        cancellationGraceMs: 100,
        terminationTimeoutMs: 1000,
      },
      ...overrides,
    }],
    logging: defaults.logging,
  };
}

function recordStore(): ModuleProcessRecordStore {
  return {
    getModuleProcessRecord: vi.fn(),
    appendModuleProcessRecord: vi.fn((record: ModuleProcessRecord) => record),
    supportsVersion19Identity: vi.fn(() => false),
    allocateAndAppendStartingRecord: vi.fn(() => {
      throw new Error("the test derivation must not allocate process records");
    }),
    updateModuleProcessRecordState: vi.fn(() => {
      throw new Error("the derivation must not update process records");
    }),
    markModuleSubmissionSendPossible: vi.fn(),
  };
}

function stoppedRecordWriter(): ModuleProcessStoppedRecordWriter {
  return {
    isStoreBoundTo: vi.fn(() => true),
    isBoundTo: vi.fn(() => true),
    writeStopped: vi.fn(() => {
      throw new Error("the derivation must not write process records");
    }),
  };
}

/**
 * An in-memory control-group filesystem for one full start/stop composition.
 * The group is always reported empty so the whole-group termination proof can
 * resolve without simulating kernel membership.
 */
function cgroupFileSystemFor() {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  return {
    files,
    directories,
    async createDirectory(path: string): Promise<void> {
      directories.add(path);
    },
    async removeDirectory(path: string): Promise<void> {
      directories.delete(path);
    },
    async directoryExists(path: string): Promise<boolean> {
      return directories.has(path);
    },
    async listChildDirectoryNames(): Promise<readonly string[]> {
      return [];
    },
    async writableFileExists(path: string): Promise<boolean> {
      return directories.has(path.slice(0, path.lastIndexOf("/")));
    },
    async readTextFile(path: string): Promise<string> {
      if (path.endsWith("/cgroup.events")) return "populated 0\nfrozen 0\n";
      const value = files.get(path);
      if (value === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return value;
    },
    async writeTextFile(path: string, contents: string): Promise<void> {
      files.set(path, contents);
    },
  };
}

describe("installed Extension Module resolution", () => {
  let scratch: string;
  let installations: ExtensionInstallationRegistry;
  let configurations: ModuleConfigurationStore;
  let activation: LinuxModuleActivationPermission;

  beforeEach(async () => {
    const result = await decideLinuxModuleActivation({
      unitName: CORE_BINDING.unitName,
      mode: CORE_BINDING.mode,
    });
    if (!result.permitted) throw new Error("fixture activation was refused");
    activation = result;
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    scratch = mkdtempSync(resolve(scratchParent, "installed-extension-module-"));
    installations = new ExtensionInstallationRegistry({
      directory: resolve(scratch, "installations"),
    });
    configurations = new ModuleConfigurationStore({
      directory: resolve(scratch, "configurations"),
    });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("returns package bytes and configuration from the two integrity-checking stores", () => {
    const source = resolve(scratch, "source-v1");
    writePackage(source, "1.0.0");
    const installed = installations.installNodePackage({
      sourceDirectory: source,
      trust: "trusted",
    });
    const configuration = configurations.create({
      configId: "worker-config",
      extensionId: "org.example.installed",
      moduleKind: "transform",
      configVersion: 1,
      schema: CONFIGURATION_SCHEMA,
      configuration: { prefix: "verified" },
    });

    const resolved = resolveInstalledExtensionModule({
      instanceConfiguration: instanceConfiguration("1.0.0", configuration.revision),
      moduleId: "worker",
      installations,
      configurations,
    });

    expect(resolved.installation.packageDigest).toBe(installed.packageDigest);
    expect(resolved.installation.trust).toBe("trusted");
    expect(relative(resolved.installation.workingDirectory, resolved.installation.entrypointPath))
      .toBe(join("dist", "main.mjs"));
    expect(readFileSync(resolved.installation.entrypointPath, "utf8"))
      .toContain("installedFixture");
    expect(resolved.configuration).toEqual(configuration);
    expect(resolved.packageModule.configurationSchema).toEqual(CONFIGURATION_SCHEMA);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("binds every reserved version-10 execution input to one canonical installed plan", () => {
    const source = resolve(scratch, "source-v10");
    writePackage(source, "10.0.0");
    const installed = installations.installNodePackage({
      sourceDirectory: source,
      trust: "trusted",
    });
    const configuration = configurations.create({
      configId: "worker-config",
      extensionId: "org.example.installed",
      moduleKind: "transform",
      configVersion: 1,
      schema: CONFIGURATION_SCHEMA,
      configuration: { prefix: "reserved-v10" },
    });
    const storagePolicy: InstalledModulePrivateStoragePolicy = {
      kind: "module-private-storage",
      policyId: "model.primary",
      backend: new ModulePrivateStorageBackend({
        root: resolve(scratch, "reserved-v10-storage"),
        now: () => "2026-08-13T00:00:00.000Z",
      }),
      operations: ["get"],
      limits: {
        maxKeyBytes: 128,
        maxValueBytes: 1024,
        maxEntries: 16,
        maxTotalBytes: 8192,
        maxListResults: 16,
        maxArgumentBytes: 1024,
        maxResultBytes: 4096,
        maxInvocations: 4,
        maxInvocationsPerRun: 1,
      },
      capabilityLifetimeMs: 10_000,
    };
    const policyRevision = reservedV10InstalledPermissionPolicyRevision(storagePolicy);
    const instance = reservedV10InstanceConfiguration(
      "10.0.0",
      configuration.revision,
      {
        declaredExternalEffects: "none",
        permissionPolicyReferences: [],
      },
    );

    expect(() => resolveReservedV10InstalledModulePlan({
      instanceConfiguration: reservedV10InstanceConfiguration(
        "10.0.0",
        configuration.revision,
        {
          declaredExternalEffects: "core-capabilities-only",
          permissionPolicyReferences: [{
            policyId: "model.primary",
            revision: policyRevision,
          }],
        },
      ),
      moduleId: "worker",
      installations,
      configurations,
    })).toThrow(/cannot be bound to permission policies because it requests no capabilities/u);

    const resolved = resolveReservedV10InstalledModulePlan({
      instanceConfiguration: instance,
      moduleId: "worker",
      installations,
      configurations,
    });

    expect(resolved.installation.packageDigest).toBe(installed.packageDigest);
    expect(resolved.configuration.configurationDigest)
      .toBe(configuration.configurationDigest);
    expect(resolved.module.execution.limits.maxTasks).toBe(32);
    expect(resolved.module.declaredExternalEffects).toBe("none");
    expect(resolved.module.permissionPolicyReferences).toEqual([]);
    expect(resolved.instanceConfigurationDigest).toBe(canonicalJsonDigest(instance));
    expect(resolved.provenanceDigest).toBe(canonicalJsonDigest(resolved.provenance));
    expect(resolved.provenance).toEqual(expect.objectContaining({
      module: expect.objectContaining({
        execution: expect.objectContaining({
          limits: expect.objectContaining({ maxTasks: 32 }),
        }),
        declaredExternalEffects: "none",
      }),
      installation: expect.objectContaining({
        packageDigest: installed.packageDigest,
        trust: "trusted",
      }),
      configuration: expect.objectContaining({
        configurationDigest: configuration.configurationDigest,
      }),
    }));
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.provenance)).toBe(true);
    expect(deriveReservedV10InstalledLinuxModuleExecutionPlan(resolved)).toEqual(
      expect.objectContaining({
        resolvedModule: resolved,
        provenanceDigest: resolved.provenanceDigest,
        cgroupLimits: {
          memoryMaxBytes: 64 * 1024 * 1024,
          maxProcesses: 32,
          cpuQuotaMicros: 100_000,
          cpuPeriodMicros: 100_000,
        },
        maxOpenFiles: 128,
        declaredExternalEffects: "none",
        permissionPolicyReferences: [],
      }),
    );

    expect(() => deriveReservedV10InstalledLinuxModuleExecutionPlan({
      ...resolved,
    })).toThrow(/not minted by the store-bound resolver/u);

    const policyRegistry = new ReservedV10InstalledPermissionPolicyRegistry({
      policies: [{
        policyId: "model.primary",
        revision: policyRevision,
        policy: storagePolicy,
      }],
    });
    const policySelection = policyRegistry.resolveFor(resolved);
    expect(policySelection.snapshot).toEqual(expect.objectContaining({
      installedPlanDigest: resolved.provenanceDigest,
      packageDigest: installed.packageDigest,
      configurationDigest: configuration.configurationDigest,
      policies: [],
    }));
    expect(policySelection.selectionDigest)
      .toBe(canonicalJsonDigest(policySelection.snapshot));
    const processProvenance = deriveReservedV10InstalledModuleProcessProvenance(
      resolved,
      policySelection,
      activation,
    );
    expect(processProvenance.snapshot).toEqual(expect.objectContaining({
      installedPlanDigest: resolved.provenanceDigest,
      permissionPolicySelectionDigest: policySelection.selectionDigest,
      packageDigest: installed.packageDigest,
      declaredExternalEffects: "none",
      execution: resolved.module.execution,
      linuxActivation: {
        serviceBinding: activation.binding,
        delegatedRoot: activation.delegatedRoot,
        runtimeBindingRevision: activation.runtime.bindingRevision,
        runtimeAuditProfile: activation.runtime.auditProfile,
      },
    }));
    expect(processProvenance.provenanceDigest)
      .toBe(canonicalJsonDigest(processProvenance.snapshot));
    expect(() => deriveReservedV10InstalledModuleProcessProvenance(
      resolved,
      policySelection,
      { ...activation, runtime: { ...activation.runtime } },
    )).toThrow(/not minted by the Host activation decision/u);
    expect(() => assertReservedV10InstalledModuleProcessProvenance({
      ...processProvenance,
    })).toThrow(/not minted by the installed composition/u);
    expect(() => assertReservedV10InstalledPermissionPolicySelection(
      { ...policySelection },
      resolved,
    )).toThrow(/not minted by its revision registry/u);

    expect(() => new ReservedV10InstalledPermissionPolicyRegistry({
      policies: [{
        policyId: "model.primary",
        revision: `sha256:${"4".repeat(64)}`,
        policy: storagePolicy,
      }],
    })).toThrow(/revision does not match its canonical definition/u);
    const expandedStoragePolicy: InstalledModulePrivateStoragePolicy = {
      ...storagePolicy,
      operations: ["get", "set"],
    };
    expect(reservedV10InstalledPermissionPolicyRevision(expandedStoragePolicy))
      .not.toBe(policyRevision);
    expect(() => new ReservedV10InstalledPermissionPolicyRegistry({
      policies: [{
        policyId: "model.primary",
        revision: policyRevision,
        policy: expandedStoragePolicy,
      }],
    })).toThrow(/revision does not match its canonical definition/u);

    const changedLimit = resolveReservedV10InstalledModulePlan({
      instanceConfiguration: reservedV10InstanceConfiguration(
        "10.0.0",
        configuration.revision,
        {
          execution: {
            kind: "linux-process",
            isolation: "process",
            limits: {
              memoryMaxBytes: 64 * 1024 * 1024,
              maxTasks: 31,
              cpuQuotaMicros: 100_000,
              cpuPeriodMicros: 100_000,
              maxOpenFiles: 128,
            },
          },
        },
      ),
      moduleId: "worker",
      installations,
      configurations,
    });
    expect(changedLimit.provenanceDigest).not.toBe(resolved.provenanceDigest);

    const changedEffect = resolveReservedV10InstalledModulePlan({
      instanceConfiguration: reservedV10InstanceConfiguration(
        "10.0.0",
        configuration.revision,
        {
          declaredExternalEffects: "core-capabilities-only",
          permissionPolicyReferences: [],
        },
      ),
      moduleId: "worker",
      installations,
      configurations,
    });
    expect(changedEffect.provenanceDigest).not.toBe(resolved.provenanceDigest);

    expect(() => resolveReservedV10InstalledModulePlan({
      instanceConfiguration: reservedV10InstanceConfiguration(
        "10.0.0",
        configuration.revision,
        {
          execution: {
            kind: "linux-process",
            isolation: "sandbox",
            limits: {
              memoryMaxBytes: 64 * 1024 * 1024,
              maxTasks: 32,
              cpuQuotaMicros: 100_000,
              cpuPeriodMicros: 100_000,
              maxOpenFiles: 128,
            },
          },
        },
      ),
      moduleId: "worker",
      installations,
      configurations,
    })).toThrow(/isolation is unsupported/u);

    expect(() => resolveReservedV10InstalledModulePlan({
      instanceConfiguration: instance,
      moduleId: "worker",
      installations,
      configurations,
      declaredExternalEffects: "none",
    } as never)).toThrow(/unknown fields: declaredExternalEffects/u);
  });

  it("binds installed package schema producers to FileCore before Block allocation", () => {
    const source = resolve(scratch, "source-v2");
    writePackageV2(source, "2.0.0");
    installations.installNodePackage({ sourceDirectory: source, trust: "trusted" });
    const instance = instanceConfiguration("2.0.0", `sha256:${"0".repeat(64)}`);
    const contentSchemas = resolveInstalledContentSchemaRegistrationSet({
      instanceConfiguration: instance,
      installations,
      reservedRegistrations: [],
      maxRegisteredValueBytes: 1024,
    });
    let nextBlock = 0;
    let nextDelivery = 0;
    const corePath = resolve(scratch, "core-state.json");
    const openCore = () => new FileCoreStateStore({
      path: corePath,
      maxFailedAttempts: 3,
      nextBlockId: () => `block-${(nextBlock += 1)}`,
      nextDeliveryId: () => `delivery-${(nextDelivery += 1)}`,
      now: () => "2026-08-10T12:00:00.000Z",
      contentSchemas,
    });
    const core = openCore();
    expect(core.blocks.isContentSchemaRegistrationSetBoundTo(contentSchemas)).toBe(true);
    const proposal = (value: JsonValue) => ({
      payload: {
        schema: "dolly.content/1",
        value: {
          items: [{
            type: "data",
            schema: "org.example.installed.result/1",
            value,
          }],
        },
      },
    } as const);

    expect(core.blocks.commit(
      proposal({ value: "verified" }),
      { kind: "module", id: "worker" },
    ).id).toBe("block-1");
    expect(() => core.blocks.commit(
      proposal({ value: "" }),
      { kind: "module", id: "worker" },
    )).toThrowError(expect.objectContaining({ code: "SCHEMA_VALUE_INVALID" }));
    expect(() => core.blocks.commit(
      proposal({ value: "forged" }),
      { kind: "module", id: "another-worker" },
    )).toThrowError(expect.objectContaining({ code: "BLOCK_RESERVED_SCHEMA_FORBIDDEN" }));
    expect(nextBlock).toBe(1);

    const reopened = openCore();
    expect(reopened.blocks.isContentSchemaRegistrationSetBoundTo(contentSchemas)).toBe(true);
    expect(reopened.blocks.get("block-1")?.payload).toEqual(
      proposal({ value: "verified" }).payload,
    );
  });

  it("retains version 2 producer registrations in a version 3 source package", () => {
    const source = resolve(scratch, "source-v3");
    writePackageV3(source, "3.0.0");
    installations.installNodePackage({ sourceDirectory: source, trust: "trusted" });
    const configuration = configurations.create({
      configId: "worker-config",
      extensionId: "org.example.installed",
      moduleKind: "transform",
      configVersion: 1,
      schema: CONFIGURATION_SCHEMA,
      configuration: { prefix: "source" },
    });
    const instance = instanceConfiguration(
      "3.0.0",
      configuration.revision,
      { kind: "source", trigger: "manual" },
    );

    const resolved = resolveInstalledExtensionModule({
      instanceConfiguration: instance,
      moduleId: "worker",
      installations,
      configurations,
    });
    const schemas = resolveInstalledContentSchemaRegistrationSet({
      instanceConfiguration: instance,
      installations,
      reservedRegistrations: [],
      maxRegisteredValueBytes: 1024,
    });

    expect(resolved.packageModule.activation).toBe("source");
    expect(schemas.snapshot()).toEqual([
      expect.objectContaining({
        schema: "org.example.installed.result/1",
        producer: expect.objectContaining({ moduleKind: "transform" }),
      }),
    ]);
  });

  it("rejects a package/configuration schema mismatch and unsupported activation", () => {
    const sourceV1 = resolve(scratch, "source-v1");
    writePackage(sourceV1, "1.0.0");
    installations.installNodePackage({ sourceDirectory: sourceV1, trust: "trusted" });
    const configuration = configurations.create({
      configId: "worker-config",
      extensionId: "org.example.installed",
      moduleKind: "transform",
      configVersion: 1,
      schema: CONFIGURATION_SCHEMA,
      configuration: { prefix: "verified" },
    });
    const sourceV2 = resolve(scratch, "source-v2");
    writePackage(sourceV2, "2.0.0", {
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      properties: { prefix: { type: "number" } },
      required: ["prefix"],
      additionalProperties: false,
    });
    installations.installNodePackage({ sourceDirectory: sourceV2, trust: "trusted" });

    expect(() => resolveInstalledExtensionModule({
      instanceConfiguration: instanceConfiguration("2.0.0", configuration.revision),
      moduleId: "worker",
      installations,
      configurations,
    })).toThrow(/schema does not match/u);

    expect(() => resolveInstalledExtensionModule({
      instanceConfiguration: instanceConfiguration(
        "1.0.0",
        configuration.revision,
        { kind: "periodic", periodMs: 1000, allowEmptyInput: false },
      ),
      moduleId: "worker",
      installations,
      configurations,
    })).toThrow(/does not support periodic activation/u);

    expect(() => resolveInstalledExtensionModule({
      instanceConfiguration: instanceConfiguration(
        "1.0.0",
        configuration.revision,
        { kind: "source", trigger: "manual" },
      ),
      moduleId: "worker",
      installations,
      configurations,
    })).toThrow(/does not support source activation/u);
  });

  it("derives record, executable, manifest, trust, and config from the same stores", () => {
    const source = resolve(scratch, "source-v1");
    writePackage(source, "1.0.0");
    const installed = installations.installNodePackage({
      sourceDirectory: source,
      trust: "trusted",
    });
    const configuration = configurations.create({
      configId: "worker-config",
      extensionId: "org.example.installed",
      moduleKind: "transform",
      configVersion: 1,
      schema: CONFIGURATION_SCHEMA,
      configuration: { prefix: "verified" },
    });
    const records = recordStore();
    const stopped = stoppedRecordWriter();

    const options: InstalledLinuxExtensionModuleExecutorOptions = {
      instanceConfiguration: instanceConfiguration("1.0.0", configuration.revision),
      moduleId: "worker",
      installations,
      configurations,
      moduleGenerationId: MODULE_GENERATION_ID,
      coreStateDirectory: resolve(scratch, "instance-state"),
      activation,
      lifecycle: {
        records,
        stoppedRecordWriter: stopped,
        identity: PROCESS_IDENTITY,
        limits: {
          memoryMaxBytes: 64 * 1_024 * 1_024,
          maxProcesses: 16,
          cpuQuotaMicros: 50_000,
          cpuPeriodMicros: 100_000,
        },
        maxOpenFiles: 64,
      },
      processRecord: {
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
      host: {
        isolationPolicy: new ExtensionIsolationPolicy(),
      },
      executionTimeoutMs: 1_000,
      cancellationGraceMs: 250,
      terminationTimeoutMs: 2_000,
      channelCloseTimeoutMs: 1_000,
    };
    const derived = deriveInstalledLinuxExtensionModuleExecutor(options);
    const executor = createInstalledLinuxExtensionModuleExecutor(options);

    const processRecord = derived.executorOptions.lifecycle.processRecord;
    expect(processRecord.packageDigest).toBe(installed.packageDigest);
    expect(processRecord.configurationReference).toEqual({
      configId: "worker-config",
      revision: configuration.revision,
      configVersion: 1,
    });
    expect(processRecord.processGenerationId).toBe(PROCESS_IDENTITY.processGenerationId);
    expect(processRecord.moduleGenerationId).toBe(MODULE_GENERATION_ID);
    expect(processRecord.declaredExternalEffects).toBe("unrestricted");
    expect(derived.executorOptions.lifecycle.execution).toEqual({
      program: LINUX_PROCESS_CONFINEMENT_PROGRAM,
      argumentVector: [
        LINUX_PROCESS_CONFINEMENT_PROGRAM,
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/sbin", "/sbin",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/run",
        "--tmpfs", "/tmp",
        "--dir", "/run/dolly",
        "--file", "4", "/run/dolly/package.snapshot",
        "--ro-bind", activation.runtime.auditProfile.nodeProgram, "/run/dolly/node",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-cgroup",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-net",
        "--disable-userns",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--cap-drop", "ALL",
        "--chdir", "/run/dolly",
        "--",
        "/usr/bin/python3",
        "-I",
        "-B",
        "-c",
        LINUX_PACKAGE_SNAPSHOT_BOOTSTRAP,
        installed.packageSnapshot.digest,
        String(installed.packageSnapshot.byteLength),
        String(installed.packageSnapshot.fileCount),
        String(installed.packageSnapshot.totalFileBytes),
        "dist/main.mjs",
      ],
      environment: {},
    });
    expect(derived.executorOptions.packageSnapshot).toMatchObject({
      digest: installed.packageSnapshot.digest,
      stagingDirectory: resolve(scratch, "instance-state"),
    });
    expect(derived.executorOptions.packageSnapshot?.bytes)
      .toEqual(installed.packageSnapshot.copyBytes());
    expect(derived.executorOptions.launcher).toEqual({
      interpreterProgram: "/usr/bin/python3",
      launcherEnvironment: {},
    });
    expect(derived.executorOptions.reviewedLauncherSnapshot).toMatchObject({
      digest: REVIEWED_LINUX_MODULE_LAUNCHER_DIGEST,
      stagingDirectory: resolve(scratch, "instance-state"),
    });
    expect(Buffer.from(derived.executorOptions.reviewedLauncherSnapshot!.bytes))
      .toEqual(readFileSync(defaultLauncherScriptPath()));
    expect(processRecord.serviceInvocationId).toBe(CORE_BINDING.serviceInvocationId);
    expect(processRecord.bootId).toBe(CORE_BINDING.bootId);
    expect(processRecord.moduleCgroupPath).toBe(
      deriveModuleCgroupPath(DELEGATED_ROOT, PROCESS_IDENTITY).filesystemPath,
    );
    // The version 19 store owns the identifier, so the installed lifecycle
    // carries an id-less twin instead of a caller process generation. The
    // twin keeps the unrelated record fields and the delegated control-group
    // root the store derives the path from.
    const startingRecord = derived.executorOptions.lifecycle.startingRecord;
    if (startingRecord === undefined) {
      throw new Error("the installed lifecycle must derive a starting record");
    }
    expect(Object.hasOwn(startingRecord, "processGenerationId")).toBe(false);
    expect(Object.hasOwn(startingRecord, "moduleCgroupPath")).toBe(false);
    expect(startingRecord.delegatedRootCgroupPath).toBe(DELEGATED_ROOT);
    const {
      processGenerationId: _placeholderProcessGenerationId,
      moduleCgroupPath: _placeholderModuleCgroupPath,
      ...processRecordBody
    } = processRecord;
    const {
      delegatedRootCgroupPath: _derivedRoot,
      moduleCgroupPath: _optionalCallerPath,
      ...startingBody
    } = startingRecord;
    expect(startingBody).toEqual(processRecordBody);
    expect(derived.executorOptions.host.manifest).toStrictEqual(installed.manifest);
    expect(derived.executorOptions.host.trust).toBe("trusted");
    expect(derived.executorOptions.host.moduleKind).toBe("transform");
    expect(derived.executorOptions.host.config).toEqual({ prefix: "verified" });
    derived.executorOptions.beforeDispatch?.({
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      moduleGenerationId: MODULE_GENERATION_ID,
      processGenerationId: PROCESS_IDENTITY.processGenerationId,
    });
    expect(records.markModuleSubmissionSendPossible).toHaveBeenCalledWith(
      {
        moduleJobId: "module-job-1",
        runId: "run-1",
        attempt: 1,
        moduleGenerationId: MODULE_GENERATION_ID,
      },
      PROCESS_IDENTITY.processGenerationId,
    );
    expect(executor.isolation).toBe("process");
    expect(records.appendModuleProcessRecord).not.toHaveBeenCalled();
    expect(stopped.writeStopped).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied package-sensitive fields before a launcher exists", () => {
    const source = resolve(scratch, "source-v1");
    writePackage(source, "1.0.0");
    installations.installNodePackage({ sourceDirectory: source, trust: "trusted" });
    const configuration = configurations.create({
      configId: "worker-config",
      extensionId: "org.example.installed",
      moduleKind: "transform",
      configVersion: 1,
      schema: CONFIGURATION_SCHEMA,
      configuration: { prefix: "verified" },
    });
    const base = {
      instanceConfiguration: instanceConfiguration("1.0.0", configuration.revision),
      moduleId: "worker",
      installations,
      configurations,
      moduleGenerationId: MODULE_GENERATION_ID,
      coreStateDirectory: resolve(scratch, "instance-state"),
      activation,
      lifecycle: {
        records: recordStore(),
        stoppedRecordWriter: stoppedRecordWriter(),
        identity: PROCESS_IDENTITY,
        limits: {
          memoryMaxBytes: 64 * 1_024 * 1_024,
          maxProcesses: 16,
          cpuQuotaMicros: 50_000,
          cpuPeriodMicros: 100_000,
        },
        maxOpenFiles: 64,
      },
      processRecord: {
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
      host: {
        isolationPolicy: new ExtensionIsolationPolicy(),
      },
      executionTimeoutMs: 1_000,
      cancellationGraceMs: 250,
      terminationTimeoutMs: 2_000,
      channelCloseTimeoutMs: 1_000,
    };

    const callerEffectDeclaration = {
      ...base,
      declaredExternalEffects: "none" as const,
    };
    expect(() => deriveInstalledLinuxExtensionModuleExecutor(
      callerEffectDeclaration,
    )).toThrow(/cannot accept a caller-supplied external-effect declaration/u);
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      activation: { ...activation },
    })).toThrow(/not minted by the Host activation decision/u);
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      configureHost: () => undefined,
    } as unknown as InstalledLinuxExtensionModuleExecutorOptions))
      .toThrow(/cannot accept an arbitrary Host setup callback/u);
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      lifecycle: {
        ...base.lifecycle,
        execution: { program: "/tmp/b", argumentVector: [], environment: {} },
      } as unknown as typeof base.lifecycle,
    })).toThrow(/lifecycle cannot supply derived fields: execution/u);
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      host: {
        ...base.host,
        config: { prefix: "forged" },
        manifest: {},
      } as unknown as typeof base.host,
    })).toThrow(/host cannot supply derived fields: config, manifest/u);
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      processRecord: {
        ...base.processRecord,
        packageDigest: `sha256:${"f".repeat(64)}`,
      } as unknown as typeof base.processRecord,
    })).toThrow(/processRecord cannot supply derived fields: packageDigest/u);
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      lifecycle: {
        ...base.lifecycle,
        identity: { ...PROCESS_IDENTITY, moduleId: "other-module" },
      },
    })).toThrow(/does not match the resolved instance Module/u);
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      processRecord: {
        ...base.processRecord,
        moduleCgroupPath: "/system.slice/dolly-core.service/forged",
      } as unknown as typeof base.processRecord,
    })).toThrow(/processRecord cannot supply derived fields: moduleCgroupPath/u);
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      launcher: {
        interpreterProgram: "/tmp/unreviewed-python",
        launcherScriptPath: "/tmp/unreviewed-launcher.py",
        launcherEnvironment: { SECRET: "forged" },
      },
    } as unknown as InstalledLinuxExtensionModuleExecutorOptions)).toThrow(
      /cannot accept caller-supplied launcher paths/u,
    );
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      activation: {
        ...activation,
        binding: {
          ...activation.binding,
          serviceInvocationId: "not-a-systemd-invocation",
        },
      },
    })).toThrow(/not minted by the Host activation decision/u);
    const sandboxConfiguration = validateDollyInstanceConfig({
      ...base.instanceConfiguration,
      modules: base.instanceConfiguration.modules.map((module) => ({
        ...module,
        isolation: "sandbox",
      })),
    });
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      instanceConfiguration: sandboxConfiguration,
    })).toThrow(/requires process isolation in the instance configuration/u);

    const untrustedSource = resolve(scratch, "source-v2-untrusted");
    writePackage(untrustedSource, "2.0.0");
    installations.installNodePackage({
      sourceDirectory: untrustedSource,
      trust: "untrusted",
    });
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      instanceConfiguration: instanceConfiguration("2.0.0", configuration.revision),
    })).toThrow(/Untrusted extensions require sandbox/u);
    expect(base.lifecycle.records.appendModuleProcessRecord).not.toHaveBeenCalled();
  });

  it("binds every Module generation to one new process generation", () => {
    const source = resolve(scratch, "source-v1");
    writePackage(source, "1.0.0");
    installations.installNodePackage({ sourceDirectory: source, trust: "trusted" });
    const configuration = configurations.create({
      configId: "worker-config",
      extensionId: "org.example.installed",
      moduleKind: "transform",
      configVersion: 1,
      schema: CONFIGURATION_SCHEMA,
      configuration: { prefix: "verified" },
    });
    const records = recordStore();
    vi.mocked(records.getModuleProcessRecord).mockImplementation((processGenerationId) =>
      processGenerationId === "process-installed-existing"
        ? ({} as ModuleProcessRecord)
        : undefined
    );
    const processGenerationIds = [
      "process-installed-a",
      "process-installed-b",
      "process-installed-b",
      "process-installed-existing",
    ];
    let nextProcessGeneration = 0;
    const factory = createInstalledLinuxExtensionModuleGenerationFactory({
      instanceConfiguration: instanceConfiguration("1.0.0", configuration.revision),
      moduleId: "worker",
      installations,
      configurations,
      coreStateDirectory: resolve(scratch, "instance-state"),
      activation,
      lifecycle: {
        records,
        stoppedRecordWriter: stoppedRecordWriter(),
        limits: {
          memoryMaxBytes: 64 * 1_024 * 1_024,
          maxProcesses: 16,
          cpuQuotaMicros: 50_000,
          cpuPeriodMicros: 100_000,
        },
        maxOpenFiles: 64,
      },
      host: {
        isolationPolicy: new ExtensionIsolationPolicy(),
      },
      executionTimeoutMs: 1_000,
      cancellationGraceMs: 250,
      terminationTimeoutMs: 2_000,
      channelCloseTimeoutMs: 1_000,
      nextProcessGenerationId: () => {
        const processGenerationId = processGenerationIds[nextProcessGeneration++];
        if (processGenerationId === undefined) throw new Error("test IDs exhausted");
        return processGenerationId;
      },
      wallClockNow: () => Date.parse("2026-08-10T00:00:00.000Z"),
    });

    expect(() => factory.processGenerationIdFor("module-generation-a"))
      .toThrow(/does not have a process generation/u);
    expect(factory.sessionForProcess("process-installed-a")).toBeNull();
    expect(factory.createExecutor("module-generation-a").isolation).toBe("process");
    expect(factory.createExecutor("module-generation-b").isolation).toBe("process");
    expect(factory.processGenerationIdFor("module-generation-a"))
      .toBe("process-installed-a");
    expect(factory.processGenerationIdFor("module-generation-b"))
      .toBe("process-installed-b");
    expect(factory.sessionForProcess("process-installed-a")).toBeNull();
    expect(factory.sessionForProcess("process-installed-b")).toBeNull();
    expect(() => factory.createExecutor("module-generation-a"))
      .toThrow(/already has an installed Linux executor/u);
    expect(() => factory.createExecutor("module-generation-c"))
      .toThrow(/Process generation process-installed-b has already been used/u);
    expect(() => factory.createExecutor("module-generation-d"))
      .toThrow(/Process generation process-installed-existing has already been used/u);
    expect(records.appendModuleProcessRecord).not.toHaveBeenCalled();
  });

  it("lets a version 19 store mint the installed identifier for running and stop transitions", async () => {
    const source = resolve(scratch, "source-v19");
    writePackage(source, "1.0.0");
    installations.installNodePackage({ sourceDirectory: source, trust: "trusted" });
    const configuration = configurations.create({
      configId: "worker-config",
      extensionId: "org.example.installed",
      moduleKind: "transform",
      configVersion: 1,
      schema: CONFIGURATION_SCHEMA,
      configuration: { prefix: "composed" },
    });
    const records = createVersion19RecordStore();

    const options: InstalledLinuxExtensionModuleExecutorOptions = {
      instanceConfiguration: instanceConfiguration("1.0.0", configuration.revision),
      moduleId: "worker",
      installations,
      configurations,
      moduleGenerationId: MODULE_GENERATION_ID,
      coreStateDirectory: resolve(scratch, "instance-state"),
      activation,
      lifecycle: {
        records,
        stoppedRecordWriter: records.stoppedRecordWriter,
        identity: PROCESS_IDENTITY,
        limits: {
          memoryMaxBytes: 64 * 1_024 * 1_024,
          maxProcesses: 16,
          cpuQuotaMicros: 50_000,
          cpuPeriodMicros: 100_000,
        },
        maxOpenFiles: 64,
      },
      processRecord: {
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
      host: {
        isolationPolicy: new ExtensionIsolationPolicy(),
      },
      executionTimeoutMs: 1_000,
      cancellationGraceMs: 250,
      terminationTimeoutMs: 2_000,
      channelCloseTimeoutMs: 1_000,
    };
    const derived = deriveInstalledLinuxExtensionModuleExecutor(options);
    const lifecycle = derived.executorOptions.lifecycle;
    // The installed lifecycle never carries a caller process generation; the
    // version 19 store allocates it. The reviewed placeholder stays only in
    // the version 18 record twin, which this store ignores.
    expect(Object.hasOwn(lifecycle.startingRecord!, "processGenerationId")).toBe(false);
    expect(lifecycle.processRecord.processGenerationId)
      .toBe(PROCESS_IDENTITY.processGenerationId);

    const fileSystem = cgroupFileSystemFor();
    const mintedPath = version19CgroupPath(
      {
        instanceId: PROCESS_IDENTITY.instanceId,
        moduleId: PROCESS_IDENTITY.moduleId,
      },
      VERSION19_MINTED_PROCESS_GENERATION_ID,
    );
    const openProtocolSession = (
      started: LinuxModuleAuthorizedProcess,
    ): LinuxModuleProtocolSession => {
      expect(started.record.processGenerationId)
        .toBe(VERSION19_MINTED_PROCESS_GENERATION_ID);
      expect(started.cgroup.path).toBe(mintedPath);
      return {
        initialize: async () => undefined,
        execute: async () => ({ schemaVersion: "dolly.module-result/1" }) as ReactiveModuleResult,
        cancel: async () => undefined,
        closeCapabilitySession: async () => undefined,
        waitForChannelClosed: async () => true,
      };
    };

    const composition = createLinuxModuleExecutor({
      moduleId: options.moduleId,
      moduleGenerationId: options.moduleGenerationId,
      lifecycle: {
        ...lifecycle,
        startLauncher: async () => ({
          processId: 4242,
          configure: async () => undefined,
          authorizeExecution: async () => ({
            executionAuthorized: true,
            verifiedProcessIds: [4242],
          }) as const,
          requestExit: async () => true,
        }),
        cgroupFileSystem: fileSystem,
      },
      openProtocolSession,
      terminationTimeoutMs: 200,
      channelCloseTimeoutMs: 200,
      coreExitCleanupTimeoutMs: 200,
      exitCoreProcess: () => undefined,
    });
    if (composition.start === undefined || composition.terminate === undefined) {
      throw new Error("the Linux Module executor must provide start and terminate");
    }

    await composition.start();
    expect(records.log[0]).toBe("allocate");
    expect(records.log).not.toContain("append");
    expect(records.current?.state).toBe("running");
    expect(records.current?.processGenerationId)
      .toBe(VERSION19_MINTED_PROCESS_GENERATION_ID);
    expect(records.getModuleProcessRecord(PROCESS_IDENTITY.processGenerationId))
      .toBeUndefined();
    expect(fileSystem.directories.has(mintedPath)).toBe(true);

    await composition.terminate({
      moduleId: options.moduleId,
      moduleGenerationId: options.moduleGenerationId,
    });
    expect(records.current?.state).toBe("stopped");
    expect(records.current?.processGenerationId)
      .toBe(VERSION19_MINTED_PROCESS_GENERATION_ID);
    expect(records.log).toEqual([
      "allocate",
      "state:running",
      "state:stopping",
      "state:stopped",
    ]);
    expect(records.log).not.toContain("append");
  });

  it("binds a version 19 generation factory to the store-minted process generation", async () => {
    const source = resolve(scratch, "source-v19-factory");
    writePackage(source, "1.0.0");
    installations.installNodePackage({ sourceDirectory: source, trust: "trusted" });
    const configuration = configurations.create({
      configId: "worker-config",
      extensionId: "org.example.installed",
      moduleKind: "transform",
      configVersion: 1,
      schema: CONFIGURATION_SCHEMA,
      configuration: { prefix: "composed" },
    });
    const records = createVersion19RecordStore();
    const fileSystem = cgroupFileSystemFor();
    const coreStateDirectory = resolve(scratch, "instance-state");
    mkdirSync(coreStateDirectory, { recursive: true, mode: 0o700 });
    const factory = createInstalledLinuxExtensionModuleGenerationFactory({
      instanceConfiguration: instanceConfiguration("1.0.0", configuration.revision),
      moduleId: "worker",
      installations,
      configurations,
      coreStateDirectory,
      activation,
      lifecycle: {
        records,
        stoppedRecordWriter: records.stoppedRecordWriter,
        cgroupFileSystem: fileSystem,
        limits: {
          memoryMaxBytes: 64 * 1_024 * 1_024,
          maxProcesses: 16,
          cpuQuotaMicros: 50_000,
          cpuPeriodMicros: 100_000,
        },
        maxOpenFiles: 64,
      },
      host: {
        isolationPolicy: new ExtensionIsolationPolicy(),
      },
      executionTimeoutMs: 1_000,
      cancellationGraceMs: 250,
      terminationTimeoutMs: 2_000,
      channelCloseTimeoutMs: 1_000,
      nextProcessGenerationId: () => PROCESS_IDENTITY.processGenerationId,
      wallClockNow: () => Date.parse("2026-08-10T00:00:00.000Z"),
    });

    const executor = factory.createExecutor(MODULE_GENERATION_ID);
    if (executor.start === undefined || executor.terminate === undefined) {
      throw new Error("the factory executor must provide start and terminate");
    }
    await executor.start();

    expect(records.log[0]).toBe("allocate");
    expect(records.log).not.toContain("append");
    expect(records.current?.state).toBe("running");
    expect(records.current?.processGenerationId)
      .toBe(VERSION19_MINTED_PROCESS_GENERATION_ID);
    expect(records.getModuleProcessRecord(PROCESS_IDENTITY.processGenerationId))
      .toBeUndefined();
    expect(factory.processGenerationIdFor(MODULE_GENERATION_ID))
      .toBe(VERSION19_MINTED_PROCESS_GENERATION_ID);
    const mintedPath = version19CgroupPath(
      {
        instanceId: PROCESS_IDENTITY.instanceId,
        moduleId: PROCESS_IDENTITY.moduleId,
      },
      VERSION19_MINTED_PROCESS_GENERATION_ID,
    );
    expect(fileSystem.directories.has(mintedPath)).toBe(true);

    await executor.terminate({
      moduleId: "worker",
      moduleGenerationId: MODULE_GENERATION_ID,
    });
    expect(records.current?.state).toBe("stopped");
    expect(records.current?.processGenerationId)
      .toBe(VERSION19_MINTED_PROCESS_GENERATION_ID);
    expect(records.log).toEqual([
      "allocate",
      "state:running",
      "state:stopping",
      "state:stopped",
    ]);
    expect(records.log).not.toContain("append");
  });
});
