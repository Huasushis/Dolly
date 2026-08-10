import { describe, expect, it, vi } from "vitest";
import { createLinuxExtensionModuleExecutor } from "../../../src/adapters/linux-extension-module-executor.js";
import { ExtensionIsolationPolicy } from "../../../src/core/extension-process-host.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type {
  ModuleProcessRecordStore,
} from "../../../src/core/linux-module-process-lifecycle.js";
import type {
  ModuleProcessRecord,
  ModuleProcessStoppedRecordWriter,
} from "../../../src/core/module-process-records.js";

const IDENTITY = {
  instanceId: "instance-linux-factory",
  moduleId: "module-linux-factory",
  processGenerationId: "process-linux-factory",
} as const;
const MODULE_GENERATION_ID = "generation-linux-factory";
const DELEGATED_ROOT = "/system.slice/dolly-core.service";
const MANIFEST: ExtensionPackageManifest = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: "com.example.linux-factory",
  packageVersion: "1.0.0",
  displayName: "Linux factory fixture",
  description: "Validates construction without starting a process.",
  supportedProtocolVersions: ["3.0"],
  entrypoint: "index.mjs",
  modules: [{
    moduleKind: "fixture",
    activation: "reactive",
    configVersion: 1,
    configurationSchema: { type: "object" },
  }],
  requestedCapabilities: [],
};

function processRecord(
  overrides: Partial<ModuleProcessRecord> = {},
): ModuleProcessRecord {
  return {
    schemaVersion: "dolly.module-process-record/1",
    ...IDENTITY,
    moduleGenerationId: MODULE_GENERATION_ID,
    packageDigest: `sha256:${"4".repeat(64)}`,
    configurationReference: {
      configId: "config-linux-factory",
      revision: `sha256:${"5".repeat(64)}`,
      configVersion: 1,
    },
    declaredExternalEffects: "none",
    serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
    bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
    moduleCgroupPath: deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY).filesystemPath,
    state: "starting",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function options(
  overrides: {
    readonly processRecord?: ModuleProcessRecord;
    readonly launcher?: Record<string, unknown>;
  } = {},
) {
  const records: ModuleProcessRecordStore = {
    getModuleProcessRecord: vi.fn(),
    appendModuleProcessRecord: vi.fn((record: ModuleProcessRecord) => record),
    updateModuleProcessRecordState: vi.fn((
      _processGenerationId: string,
      _state: "running" | "stopping",
    ) => processRecord()),
  };
  const stoppedRecordWriter: ModuleProcessStoppedRecordWriter = {
    isBoundTo: vi.fn(() => true),
    writeStopped: vi.fn(() => processRecord({ state: "stopped" })),
  };
  return {
    moduleId: IDENTITY.moduleId,
    moduleGenerationId: MODULE_GENERATION_ID,
    lifecycle: {
      records,
      stoppedRecordWriter,
      processRecord: overrides.processRecord ?? processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: {
        memoryMaxBytes: 64 * 1_024 * 1_024,
        maxProcesses: 16,
        cpuQuotaMicros: 50_000,
        cpuPeriodMicros: 100_000,
      },
      maxOpenFiles: 64,
      execution: {
        program: "/opt/dolly/node",
        argumentVector: ["/opt/dolly/node", "/opt/dolly/extension/index.mjs"],
        environment: {},
      },
    },
    launcher: {
      interpreterProgram: "/usr/bin/python3",
      launcherScriptPath: "/opt/dolly/launcher.py",
      launcherEnvironment: {},
      ...overrides.launcher,
    },
    host: {
      trust: "trusted" as const,
      isolationPolicy: new ExtensionIsolationPolicy(),
      manifest: MANIFEST,
      moduleKind: "fixture",
      config: {},
    },
    executionTimeoutMs: 1_000,
    cancellationGraceMs: 250,
    terminationTimeoutMs: 2_000,
    channelCloseTimeoutMs: 1_000,
  };
}

describe("Linux Extension Module executor composition", () => {
  it("constructs a process-isolated executor without starting a launcher", () => {
    const executorOptions = options();
    const executor = createLinuxExtensionModuleExecutor(executorOptions);

    expect(executor.isolation).toBe("process");
    expect(executor.start).toBeTypeOf("function");
    expect(executor.terminate).toBeTypeOf("function");
    expect(executorOptions.lifecycle.records.appendModuleProcessRecord).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "instance",
      record: processRecord({ instanceId: "other-instance" }),
    },
    {
      label: "Module",
      record: processRecord({ moduleId: "other-module" }),
    },
    {
      label: "Module generation",
      record: processRecord({ moduleGenerationId: "other-generation" }),
    },
    {
      label: "process generation",
      record: processRecord({ processGenerationId: "other-process" }),
    },
    {
      label: "record state",
      record: processRecord({ state: "running" }),
    },
  ])("rejects a mismatched $label before process creation", ({ record }) => {
    const executorOptions = options({ processRecord: record });
    expect(() => createLinuxExtensionModuleExecutor(executorOptions)).toThrowError(
      /one starting Module process identity/,
    );
    expect(executorOptions.lifecycle.records.appendModuleProcessRecord).not.toHaveBeenCalled();
  });

  it.each(["protocolStdio", "additionalInheritedStdio"] as const)(
    "rejects a runtime-supplied %s override before process creation",
    (field) => {
      const executorOptions = options({ launcher: { [field]: ["inherit"] } });
      expect(() => createLinuxExtensionModuleExecutor(executorOptions)).toThrowError(
        /adapter-owned protocol pipes/,
      );
      expect(executorOptions.lifecycle.records.appendModuleProcessRecord).not.toHaveBeenCalled();
    },
  );
});
