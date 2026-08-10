import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInstalledLinuxExtensionModuleExecutor,
  createInstalledLinuxExtensionModuleGenerationFactory,
  deriveInstalledLinuxExtensionModuleExecutor,
  type InstalledLinuxExtensionModuleExecutorOptions,
} from "../../../src/adapters/installed-linux-extension-module-executor.js";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import { ExtensionIsolationPolicy } from "../../../src/core/extension-process-host.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import { resolveInstalledExtensionModule } from "../../../src/core/installed-extension-module.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type { ModuleProcessRecordStore } from "../../../src/core/linux-module-process-lifecycle.js";
import type {
  ModuleProcessRecord,
  ModuleProcessStoppedRecordWriter,
} from "../../../src/core/module-process-records.js";
import { ModuleConfigurationStore } from "../../../src/core/module-configuration-store.js";
import {
  createDefaultDollyInstanceConfig,
  validateDollyInstanceConfig,
  type DollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
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
      subscriptionStart: "from-now",
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

function recordStore(): ModuleProcessRecordStore {
  return {
    getModuleProcessRecord: vi.fn(),
    appendModuleProcessRecord: vi.fn((record: ModuleProcessRecord) => record),
    updateModuleProcessRecordState: vi.fn(() => {
      throw new Error("the derivation must not update process records");
    }),
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

describe("installed Extension Module resolution", () => {
  let scratch: string;
  let installations: ExtensionInstallationRegistry;
  let configurations: ModuleConfigurationStore;

  beforeEach(() => {
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
      binding: CORE_BINDING,
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
      launcher: {
        interpreterProgram: "/usr/bin/python3",
        launcherScriptPath: "/opt/dolly/launcher.py",
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
    expect(processRecord.declaredExternalEffects).toBe("core-capabilities-only");
    expect(derived.executorOptions.lifecycle.execution).toEqual({
      program: process.execPath,
      argumentVector: [process.execPath, installed.entrypointPath],
      environment: {},
    });
    expect(derived.executorOptions.launcher.launcherEnvironment).toEqual({});
    expect(processRecord.serviceInvocationId).toBe(CORE_BINDING.serviceInvocationId);
    expect(processRecord.bootId).toBe(CORE_BINDING.bootId);
    expect(processRecord.moduleCgroupPath).toBe(
      deriveModuleCgroupPath(DELEGATED_ROOT, PROCESS_IDENTITY).filesystemPath,
    );
    expect(derived.executorOptions.host.manifest).toStrictEqual(installed.manifest);
    expect(derived.executorOptions.host.trust).toBe("trusted");
    expect(derived.executorOptions.host.moduleKind).toBe("transform");
    expect(derived.executorOptions.host.config).toEqual({ prefix: "verified" });
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
      binding: CORE_BINDING,
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
      launcher: {
        interpreterProgram: "/usr/bin/python3",
        launcherScriptPath: "/opt/dolly/launcher.py",
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
        ...base.launcher,
        launcherEnvironment: { SECRET: "forged" },
      } as unknown as typeof base.launcher,
    })).toThrow(/launcher cannot supply derived fields: launcherEnvironment/u);
    expect(() => deriveInstalledLinuxExtensionModuleExecutor({
      ...base,
      binding: {
        ...CORE_BINDING,
        serviceInvocationId: "not-a-systemd-invocation",
      },
    })).toThrow(/serviceInvocationId must be the 32 lower-case hexadecimal digits/u);
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
      binding: CORE_BINDING,
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
      launcher: {
        interpreterProgram: "/usr/bin/python3",
        launcherScriptPath: "/opt/dolly/launcher.py",
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
    expect(factory.createExecutor("module-generation-a").isolation).toBe("process");
    expect(factory.createExecutor("module-generation-b").isolation).toBe("process");
    expect(factory.processGenerationIdFor("module-generation-a"))
      .toBe("process-installed-a");
    expect(factory.processGenerationIdFor("module-generation-b"))
      .toBe("process-installed-b");
    expect(() => factory.createExecutor("module-generation-a"))
      .toThrow(/already has an installed Linux executor/u);
    expect(() => factory.createExecutor("module-generation-c"))
      .toThrow(/Process generation process-installed-b has already been used/u);
    expect(() => factory.createExecutor("module-generation-d"))
      .toThrow(/Process generation process-installed-existing has already been used/u);
    expect(records.appendModuleProcessRecord).not.toHaveBeenCalled();
  });
});
