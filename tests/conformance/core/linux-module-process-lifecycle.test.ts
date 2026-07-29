/**
 * The order in which a Linux Module process is started and stopped is itself
 * the safety property, so these tests assert the order and the refusals rather
 * than the mechanisms, which have their own tests.
 *
 * Architecture Decision Record 0009 requires: the process record durable
 * before any child exists; every control-group limit written and read back
 * before a process joins; only the reviewed launcher started; kernel
 * membership verified before the launcher may execute anything; and, once
 * membership is verified, whole-group termination with an empty-group proof.
 */
import { describe, expect, it, vi } from "vitest";
import {
  startModuleProcess,
  stopModuleProcess,
  type ModuleLauncherControl,
  type ModuleProcessRecordWriter,
} from "../../../src/core/linux-module-process-lifecycle.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type { ModuleProcessRecord } from "../../../src/core/module-process-records.js";

const DELEGATED_ROOT = "/system.slice/dolly-core.service";
const IDENTITY = {
  instanceId: "instance-1",
  moduleId: "worker",
  processGenerationId: "process-generation-1",
};
const LIMITS = {
  memoryMaxBytes: 64 * 1024 * 1024,
  maxProcesses: 16,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};
const EXECUTION = {
  program: "/opt/dolly/node",
  argumentVector: ["/opt/dolly/node", "/opt/dolly/extensions/worker/index.mjs"],
  environment: { DOLLY_EXTENSION: "worker" },
};

function processRecord(): ModuleProcessRecord {
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: IDENTITY.instanceId,
    moduleId: IDENTITY.moduleId,
    moduleGenerationId: "module-generation-1",
    processGenerationId: IDENTITY.processGenerationId,
    packageDigest: `sha256:${"a".repeat(64)}`,
    configurationReference: {
      configId: "config-1",
      revision: `sha256:${"b".repeat(64)}`,
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
    bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
    moduleCgroupPath: deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY).filesystemPath,
    state: "starting",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

/** Records every write so a test can assert the exact order of steps. */
function recordWriter(): ModuleProcessRecordWriter & { readonly log: string[] } {
  const log: string[] = [];
  let current = processRecord();
  return {
    log,
    appendModuleProcessRecord(record) {
      log.push("append");
      current = record;
      return record;
    },
    updateModuleProcessRecordState(_id, state, failureCode) {
      log.push(failureCode === undefined ? `state:${state}` : `state:${state}:${failureCode}`);
      current = { ...current, state };
      return current;
    },
  };
}

/**
 * An in-memory control-group filesystem that accepts the exact writes the
 * preparation performs and reads them back unchanged.
 */
function fakeCgroupFileSystem(overrides: {
  readonly populated?: () => string;
  readonly failCreate?: boolean;
  readonly failRemove?: boolean;
} = {}) {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  return {
    files,
    directories,
    async createDirectory(path: string): Promise<void> {
      if (overrides.failCreate) throw Object.assign(new Error("denied"), { code: "EACCES" });
      directories.add(path);
    },
    async removeDirectory(path: string): Promise<void> {
      if (overrides.failRemove) {
        throw Object.assign(new Error("removal denied"), { code: "EACCES" });
      }
      directories.delete(path);
    },
    async directoryExists(path: string): Promise<boolean> {
      return directories.has(path);
    },
    async listChildDirectoryNames(): Promise<readonly string[]> {
      return [];
    },
    // The kernel creates every control file when the directory is created, so
    // this fake reports them present for any prepared group.
    async writableFileExists(path: string): Promise<boolean> {
      const directory = path.slice(0, path.lastIndexOf("/"));
      return directories.has(directory);
    },
    async readTextFile(path: string): Promise<string> {
      if (path.endsWith("/cgroup.events")) {
        return overrides.populated?.() ?? "populated 0\nfrozen 0\n";
      }
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

function launcher(
  overrides: Partial<ModuleLauncherControl> = {},
): ModuleLauncherControl & { readonly log: string[] } {
  const log: string[] = [];
  return {
    log,
    processId: 4242,
    async configure() {
      log.push("configure");
    },
    async authorizeExecution() {
      log.push("authorize");
    },
    async requestExit() {
      log.push("exit");
      return true;
    },
    ...overrides,
  } as ModuleLauncherControl & { readonly log: string[] };
}

describe("Linux Module process lifecycle order", () => {
  it("persists the process record before it creates the control group or a launcher", async () => {
    const records = recordWriter();
    const fileSystem = fakeCgroupFileSystem();
    const control = launcher();
    const startLauncher = vi.fn(async () => control);

    const result = await startModuleProcess({
      records,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher,
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });

    expect(result.started).toBe(true);
    // The record is durable before anything else can exist.
    expect(records.log[0]).toBe("append");
    expect(fileSystem.directories.size).toBeGreaterThan(0);
    // The launcher is created only after the group is prepared.
    expect(startLauncher).toHaveBeenCalledOnce();
    expect(control.log).toEqual(["configure", "authorize"]);
    expect(records.log.at(-1)).toBe("state:running");
  });

  it("never starts a launcher when the control group cannot be prepared", async () => {
    const records = recordWriter();
    const startLauncher = vi.fn(async () => launcher());

    const result = await startModuleProcess({
      records,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher,
      execution: EXECUTION,
      cgroupFileSystem: fakeCgroupFileSystem({ failCreate: true }),
    });

    expect(result.started).toBe(false);
    if (result.started) throw new Error("expected a refusal");
    expect(result.failure.code).toBe("MODULE_PROCESS_CGROUP_FAILED");
    expect(startLauncher).not.toHaveBeenCalled();
    // The record stays as evidence, marked stopped because no process joined.
    expect(records.log).toContain("state:stopped:MODULE_CGROUP_CREATE_FAILED");
  });

  it("asks the launcher to exit and does not authorize execution when stop was requested", async () => {
    const records = recordWriter();
    const control = launcher();

    const result = await startModuleProcess({
      records,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => control,
      execution: EXECUTION,
      stopRequested: () => true,
      cgroupFileSystem: fakeCgroupFileSystem(),
    });

    expect(result.started).toBe(false);
    if (result.started) throw new Error("expected a refusal");
    expect(result.failure.code).toBe("MODULE_PROCESS_STOP_REQUESTED");
    expect(result.failure.coreMustExit).toBe(false);
    // The launcher was told to exit and never authorized to execute.
    expect(control.log).toEqual(["configure", "exit"]);
  });

  it("requires Core to exit when a pre-membership launcher exit cannot be observed", async () => {
    const records = recordWriter();
    const control = launcher({
      async authorizeExecution() {
        throw new Error("membership could not be verified");
      },
      async requestExit() {
        return false;
      },
    });

    const result = await startModuleProcess({
      records,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => control,
      execution: EXECUTION,
      cgroupFileSystem: fakeCgroupFileSystem(),
    });

    expect(result.started).toBe(false);
    if (result.started) throw new Error("expected a refusal");
    expect(result.failure.code).toBe("MODULE_PROCESS_MEMBERSHIP_UNVERIFIED");
    // There is no safe way to address the launcher, so the service cleanup is
    // the only remaining group termination.
    expect(result.failure.coreMustExit).toBe(true);
    // The record is not marked stopped: nothing proved the launcher stopped.
    expect(records.log).not.toContain("state:stopped");
  });

  it("marks a process stopped only after its whole group is proven empty", async () => {
    const records = recordWriter();
    let populated = "populated 1\nfrozen 0\n";
    const fileSystem = fakeCgroupFileSystem({ populated: () => populated });
    const started = await startModuleProcess({
      records,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => launcher(),
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });
    expect(started.started).toBe(true);
    if (!started.started) throw new Error("expected a start");

    // While the group still reports members, the stop is refused and the
    // record stays in `stopping` for a later Core invocation.
    const refused = await stopModuleProcess({
      records,
      processGenerationId: IDENTITY.processGenerationId,
      cgroup: started.cgroup,
      timeoutMs: 20,
    });
    expect(refused.stopped).toBe(false);
    expect(records.log).toContain("state:stopping");
    expect(records.log).not.toContain("state:stopped");

    populated = "populated 0\nfrozen 0\n";
    const proven = await stopModuleProcess({
      records,
      processGenerationId: IDENTITY.processGenerationId,
      cgroup: started.cgroup,
      timeoutMs: 200,
    });
    expect(proven.stopped).toBe(true);
    expect(records.log.at(-1)).toBe("state:stopped");
    expect(fileSystem.directories.has(started.cgroup.path)).toBe(false);
  });

  it("keeps the process record stopping when an empty group cannot be removed", async () => {
    const records = recordWriter();
    const fileSystem = fakeCgroupFileSystem({
      populated: () => "populated 0\nfrozen 0\n",
      failRemove: true,
    });
    const started = await startModuleProcess({
      records,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => launcher(),
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });
    expect(started.started).toBe(true);
    if (!started.started) throw new Error("expected a start");

    const stopped = await stopModuleProcess({
      records,
      processGenerationId: IDENTITY.processGenerationId,
      cgroup: started.cgroup,
      timeoutMs: 200,
    });
    expect(stopped).toMatchObject({
      stopped: false,
      code: "MODULE_CGROUP_REMOVE_FAILED",
    });
    expect(records.log.at(-1)).toBe("state:stopping");
    expect(records.log).not.toContain("state:stopped");
    expect(fileSystem.directories.has(started.cgroup.path)).toBe(true);
  });
});
