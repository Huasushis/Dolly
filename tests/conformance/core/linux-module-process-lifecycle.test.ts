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
  type ModuleProcessRecordStore,
} from "../../../src/core/linux-module-process-lifecycle.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import {
  canTransitionModuleProcessRecordState,
  type ModuleProcessRecord,
  type ModuleProcessStoppedRecordWriter,
} from "../../../src/core/module-process-records.js";

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

// These lifecycle tests have no Extension protocol layer. Supplying both
// operations explicitly keeps the product API fail-closed for real callers.
const NO_PROTOCOL_SESSION = {
  closeCapabilitySession: async (): Promise<void> => undefined,
  waitForChannelClosed: async (): Promise<boolean> => true,
} as const;

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
function recordStore(): ModuleProcessRecordStore & {
  readonly log: string[];
  readonly stoppedRecordWriter: ModuleProcessStoppedRecordWriter;
} {
  const log: string[] = [];
  let current = processRecord();
  const writeState = (
    state: ModuleProcessRecord["state"],
    failureCode?: string,
  ): ModuleProcessRecord => {
    if (!canTransitionModuleProcessRecordState(current.state, state)) {
      throw new Error(`invalid process-record transition ${current.state} -> ${state}`);
    }
    log.push(failureCode === undefined ? `state:${state}` : `state:${state}:${failureCode}`);
    current = { ...current, state };
    return current;
  };
  return {
    log,
    stoppedRecordWriter: {
      isStoreBoundTo: () => true,
      isBoundTo(record) {
        return current === record;
      },
      writeStopped(_id, failureCode) {
        return writeState("stopped", failureCode);
      },
    },
    getModuleProcessRecord(processGenerationId) {
      return current.processGenerationId === processGenerationId ? current : undefined;
    },
    appendModuleProcessRecord(record) {
      log.push("append");
      current = record;
      return record;
    },
    supportsVersion19Identity() {
      return false;
    },
    allocateAndAppendStartingRecord() {
      throw new Error("the test record store never mints version 19 identifiers");
    },
    updateModuleProcessRecordState(_id, state, failureCode) {
      return writeState(state, failureCode);
    },
  };
}

/**
 * An in-memory control-group filesystem that accepts the exact writes the
 * preparation performs and reads them back unchanged.
 */
function fakeCgroupFileSystem(overrides: {
  readonly populated?: () => string;
  readonly createErrorCode?: "EACCES" | "EEXIST";
  readonly failRemove?: boolean;
  readonly failWrite?: boolean;
} = {}) {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  return {
    files,
    directories,
    async createDirectory(path: string): Promise<void> {
      if (overrides.createErrorCode !== undefined) {
        if (overrides.createErrorCode === "EEXIST") directories.add(path);
        throw Object.assign(new Error("directory creation refused"), {
          code: overrides.createErrorCode,
        });
      }
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
      if (overrides.failWrite) {
        throw Object.assign(new Error("limit write denied"), { code: "EACCES" });
      }
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
      return {
        executionAuthorized: true,
        verifiedProcessIds: [4242],
      } as const;
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
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem();
    const control = launcher();
    const startLauncher = vi.fn(async () => control);

    const result = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher,
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });

    expect(result.executionAuthorized).toBe(true);
    if (!result.executionAuthorized) throw new Error("expected authorization");
    // The record is durable before anything else can exist.
    expect(records.log[0]).toBe("append");
    expect(fileSystem.directories.size).toBeGreaterThan(0);
    // The launcher is created only after the group is prepared.
    expect(startLauncher).toHaveBeenCalledOnce();
    expect(control.log).toEqual(["configure", "authorize"]);
    expect(result.launcher).toBe(control);
    expect(result.record.state).toBe("starting");
    expect(records.log).not.toContain("state:running");
  });

  it("requires Core to exit when authorization reports an invalid process list", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem();
    const control = launcher({
      async authorizeExecution() {
        return {
          executionAuthorized: true,
          verifiedProcessIds: [4242, 99],
        } as const;
      },
    });

    const result = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => control,
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });

    expect(result.executionAuthorized).toBe(false);
    if (result.executionAuthorized) throw new Error("expected a refusal");
    expect(result.failure).toMatchObject({
      code: "MODULE_PROCESS_MEMBERSHIP_UNVERIFIED",
      coreMustExit: true,
    });
    expect(result.cgroup?.membershipObserved).toBe(true);
    expect(fileSystem.directories.size).toBe(1);
    expect(records.log).not.toContain("state:running");
    expect(records.log).not.toContain("state:stopped");
  });

  it("requires Core to exit when execute may have been delivered without observed membership", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem();
    const control = launcher({
      async authorizeExecution() {
        return {
          executionAuthorized: false,
          code: "LAUNCHER_CONTROL_TIMEOUT",
          detail: "the execute send result is unknown",
          membershipVerified: false,
          observedProcessIds: [],
          executeCommandMayHaveBeenDelivered: true,
          launcherExitObserved: true,
        } as const;
      },
    });

    const result = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => control,
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });

    expect(result.executionAuthorized).toBe(false);
    if (result.executionAuthorized) throw new Error("expected a refusal");
    expect(result.failure).toMatchObject({
      code: "MODULE_PROCESS_LAUNCHER_FAILED",
      coreMustExit: true,
    });
    expect(control.log).toEqual(["configure"]);
    expect(fileSystem.directories.size).toBe(1);
    expect(records.log).not.toContain("state:stopped");
  });

  it("never starts a launcher when the control group cannot be prepared", async () => {
    const records = recordStore();
    const startLauncher = vi.fn(async () => launcher());

    const result = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher,
      execution: EXECUTION,
      cgroupFileSystem: fakeCgroupFileSystem({ createErrorCode: "EACCES" }),
    });

    expect(result.executionAuthorized).toBe(false);
    if (result.executionAuthorized) throw new Error("expected a refusal");
    expect(result.failure).toMatchObject({
      code: "MODULE_PROCESS_CGROUP_FAILED",
      coreMustExit: true,
    });
    expect(startLauncher).not.toHaveBeenCalled();
    // A failed mkdir does not prove that the named path was never created, so
    // startup recovery must retain and re-prove the durable starting record.
    expect(records.log).toEqual(["append"]);
    expect(records.log).not.toContain("state:stopped");
  });

  it("does not mark a reused control-group path stopped", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem({ createErrorCode: "EEXIST" });
    const startLauncher = vi.fn(async () => launcher());

    const result = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher,
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });

    expect(result.executionAuthorized).toBe(false);
    if (result.executionAuthorized) throw new Error("expected a refusal");
    expect(result.failure).toMatchObject({
      code: "MODULE_PROCESS_CGROUP_FAILED",
      coreMustExit: true,
    });
    expect(result.failure.detail).toContain("MODULE_CGROUP_PATH_IN_USE");
    expect(startLauncher).not.toHaveBeenCalled();
    expect(fileSystem.directories.size).toBe(1);
    expect(records.log).toEqual(["append"]);
    expect(records.log).not.toContain("state:stopped");
  });

  it("does not mark a partially created control group stopped when cleanup fails", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem({ failWrite: true, failRemove: true });
    const startLauncher = vi.fn(async () => launcher());

    const result = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher,
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });

    expect(result.executionAuthorized).toBe(false);
    if (result.executionAuthorized) throw new Error("expected a refusal");
    expect(result.failure).toMatchObject({
      code: "MODULE_PROCESS_CGROUP_FAILED",
      coreMustExit: true,
    });
    expect(result.failure.detail).toContain("MODULE_CGROUP_LIMIT_WRITE_FAILED");
    expect(result.failure.detail).toContain("could also not be removed");
    expect(startLauncher).not.toHaveBeenCalled();
    expect(fileSystem.directories.size).toBe(1);
    expect(records.log).toEqual(["append"]);
    expect(records.log).not.toContain("state:stopped");
  });

  it("does not require Core exit when failed preparation proves its new path was removed", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem({ failWrite: true });
    const startLauncher = vi.fn(async () => launcher());

    const result = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher,
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });

    expect(result.executionAuthorized).toBe(false);
    if (result.executionAuthorized) throw new Error("expected a refusal");
    expect(result.failure).toMatchObject({
      code: "MODULE_PROCESS_CGROUP_FAILED",
      coreMustExit: false,
    });
    expect(startLauncher).not.toHaveBeenCalled();
    expect(fileSystem.directories.size).toBe(0);
    expect(records.log).toEqual(["append"]);
  });

  it("asks the launcher to exit and does not authorize execution when stop was requested", async () => {
    const records = recordStore();
    const control = launcher();
    const fileSystem = fakeCgroupFileSystem();

    const result = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => control,
      execution: EXECUTION,
      stopRequested: () => true,
      cgroupFileSystem: fileSystem,
    });

    expect(result.executionAuthorized).toBe(false);
    if (result.executionAuthorized) throw new Error("expected a refusal");
    expect(result.failure.code).toBe("MODULE_PROCESS_STOP_REQUESTED");
    expect(result.failure.coreMustExit).toBe(false);
    // The launcher was told to exit and never authorized to execute.
    expect(control.log).toEqual(["configure", "exit"]);
    expect(fileSystem.directories.size).toBe(0);
    expect(records.log.at(-1)).toBe("state:stopped:MODULE_PROCESS_STOP_REQUESTED");
  });

  it("does not report failed-start cleanup complete when a structural writer performs no write", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem();
    const noOpWriter: ModuleProcessStoppedRecordWriter = {
      isStoreBoundTo: () => true,
      isBoundTo: () => true,
      writeStopped() {
        return { ...processRecord(), state: "stopped" };
      },
    };

    const result = await startModuleProcess({
      records,
      stoppedRecordWriter: noOpWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => launcher(),
      execution: EXECUTION,
      stopRequested: () => true,
      cgroupFileSystem: fileSystem,
    });

    expect(result.executionAuthorized).toBe(false);
    if (result.executionAuthorized) throw new Error("expected a refusal");
    expect(result.failure).toMatchObject({
      code: "MODULE_PROCESS_STOP_REQUESTED",
      coreMustExit: true,
    });
    expect(records.getModuleProcessRecord(IDENTITY.processGenerationId)?.state).toBe(
      "starting",
    );
    expect(fileSystem.directories.size).toBe(0);
  });

  it("retains the prepared control group when launcher creation has an unknown outcome", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem();

    const result = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => {
        throw new Error("launcher construction failed after spawn may have begun");
      },
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });

    expect(result.executionAuthorized).toBe(false);
    if (result.executionAuthorized) throw new Error("expected a refusal");
    expect(result.failure.code).toBe("MODULE_PROCESS_LAUNCHER_FAILED");
    expect(result.failure.coreMustExit).toBe(true);
    expect("cgroup" in result).toBe(true);
    expect(records.log).not.toContain("state:stopped:LAUNCHER_START_FAILED");
    expect(fileSystem.directories.size).toBe(1);
  });

  it("requires Core to exit when a pre-membership launcher exit cannot be observed", async () => {
    const records = recordStore();
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
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => control,
      execution: EXECUTION,
      cgroupFileSystem: fakeCgroupFileSystem(),
    });

    expect(result.executionAuthorized).toBe(false);
    if (result.executionAuthorized) throw new Error("expected a refusal");
    expect(result.failure.code).toBe("MODULE_PROCESS_MEMBERSHIP_UNVERIFIED");
    // There is no safe way to address the launcher, so the service cleanup is
    // the only remaining group termination.
    expect(result.failure.coreMustExit).toBe(true);
    // The record is not marked stopped: nothing proved the launcher stopped.
    expect(records.log).not.toContain("state:stopped");
  });

  it("marks a process stopped only after its whole group is proven empty", async () => {
    const records = recordStore();
    let populated = "populated 1\nfrozen 0\n";
    const fileSystem = fakeCgroupFileSystem({ populated: () => populated });
    const started = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => launcher(),
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });
    expect(started.executionAuthorized).toBe(true);
    if (!started.executionAuthorized) throw new Error("expected a start");

    // While the group still reports members, the stop is refused and the
    // record stays in `stopping` for a later Core invocation.
    const refused = await stopModuleProcess({
      ...NO_PROTOCOL_SESSION,
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processGenerationId: IDENTITY.processGenerationId,
      cgroup: started.cgroup,
      timeoutMs: 20,
    });
    expect(refused.stopped).toBe(false);
    expect(records.log).toContain("state:stopping");
    expect(records.log).not.toContain("state:stopped");

    populated = "populated 0\nfrozen 0\n";
    const proven = await stopModuleProcess({
      ...NO_PROTOCOL_SESSION,
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processGenerationId: IDENTITY.processGenerationId,
      cgroup: started.cgroup,
      timeoutMs: 200,
    });
    expect(proven.stopped).toBe(true);
    expect(records.log.at(-1)).toBe("state:stopped");
    expect(fileSystem.directories.has(started.cgroup.path)).toBe(false);
  });

  it("does not report a normal stop complete when a structural writer performs no write", async () => {
    const records = recordStore();
    let populated = "populated 1\nfrozen 0\n";
    const fileSystem = fakeCgroupFileSystem({ populated: () => populated });
    const started = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => launcher(),
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });
    if (!started.executionAuthorized) throw new Error("expected authorization");
    records.updateModuleProcessRecordState(IDENTITY.processGenerationId, "running");
    populated = "populated 0\nfrozen 0\n";

    const stopped = await stopModuleProcess({
      ...NO_PROTOCOL_SESSION,
      records,
      stoppedRecordWriter: {
        isStoreBoundTo: () => true,
        isBoundTo: () => true,
        writeStopped() {
          return { ...processRecord(), state: "stopped" };
        },
      },
      processGenerationId: IDENTITY.processGenerationId,
      cgroup: started.cgroup,
      timeoutMs: 200,
    });

    expect(stopped).toMatchObject({
      stopped: false,
      code: "MODULE_PROCESS_RECORD_FAILED",
    });
    expect(records.getModuleProcessRecord(IDENTITY.processGenerationId)?.state).toBe(
      "stopping",
    );
  });

  it("keeps the process record stopping when an empty group cannot be removed", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem({
      populated: () => "populated 0\nfrozen 0\n",
      failRemove: true,
    });
    const started = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => launcher(),
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });
    expect(started.executionAuthorized).toBe(true);
    if (!started.executionAuthorized) throw new Error("expected a start");

    const stopped = await stopModuleProcess({
      ...NO_PROTOCOL_SESSION,
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
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

  it("does not use an existing stopped record instead of current protocol evidence", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem();
    const started = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => launcher(),
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });
    expect(started.executionAuthorized).toBe(true);
    if (!started.executionAuthorized) throw new Error("expected a start");
    await expect(
      stopModuleProcess({
        ...NO_PROTOCOL_SESSION,
        records,
        stoppedRecordWriter: records.stoppedRecordWriter,
        processGenerationId: IDENTITY.processGenerationId,
        cgroup: started.cgroup,
      }),
    ).resolves.toMatchObject({ stopped: true });

    await expect(
      stopModuleProcess({
        ...NO_PROTOCOL_SESSION,
        records,
        stoppedRecordWriter: records.stoppedRecordWriter,
        processGenerationId: IDENTITY.processGenerationId,
        cgroup: started.cgroup,
        waitForChannelClosed: async () => false,
      }),
    ).resolves.toMatchObject({
      stopped: false,
      code: "MODULE_PROTOCOL_CHANNEL_CLOSE_UNCONFIRMED",
    });
  });

  it("lets simultaneous stop calls share the final durable state", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem();
    const started = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => launcher(),
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });
    expect(started.executionAuthorized).toBe(true);
    if (!started.executionAuthorized) throw new Error("expected a start");

    const first = stopModuleProcess({
      ...NO_PROTOCOL_SESSION,
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processGenerationId: IDENTITY.processGenerationId,
      cgroup: started.cgroup,
    });
    const second = stopModuleProcess({
      ...NO_PROTOCOL_SESSION,
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processGenerationId: IDENTITY.processGenerationId,
      cgroup: started.cgroup,
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ stopped: true }),
      expect.objectContaining({ stopped: true }),
    ]);
    expect(records.log.filter((entry) => entry === "state:stopped")).toHaveLength(1);
  });

  it("refuses a control group owned by another process generation", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem();
    const started = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => launcher(),
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });
    expect(started.executionAuthorized).toBe(true);
    if (!started.executionAuthorized) throw new Error("expected a start");

    const stopped = await stopModuleProcess({
      ...NO_PROTOCOL_SESSION,
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processGenerationId: "process-generation-2",
      cgroup: started.cgroup,
    });

    expect(stopped).toMatchObject({
      stopped: false,
      code: "MODULE_PROCESS_RECORD_STATE_INVALID",
    });
    expect(fileSystem.files.has(`${started.cgroup.path}/cgroup.kill`)).toBe(false);
    expect(records.log).not.toContain("state:stopping");
    expect(records.log).not.toContain("state:stopped");
  });

  it("does not close a process record whose control-group path does not match", async () => {
    const records = recordStore();
    const fileSystem = fakeCgroupFileSystem();
    const started = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => launcher(),
      execution: EXECUTION,
      cgroupFileSystem: fileSystem,
    });
    expect(started.executionAuthorized).toBe(true);
    if (!started.executionAuthorized) throw new Error("expected a start");
    const recordsWithWrongPath: ModuleProcessRecordStore = {
      ...records,
      getModuleProcessRecord(processGenerationId) {
        const record = records.getModuleProcessRecord(processGenerationId);
        return record === undefined
          ? undefined
          : { ...record, moduleCgroupPath: `${record.moduleCgroupPath}-other` };
      },
    };

    const stopped = await stopModuleProcess({
      ...NO_PROTOCOL_SESSION,
      records: recordsWithWrongPath,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processGenerationId: IDENTITY.processGenerationId,
      cgroup: started.cgroup,
    });

    expect(stopped).toMatchObject({
      stopped: false,
      code: "MODULE_PROCESS_RECORD_STATE_INVALID",
    });
    expect(fileSystem.files.get(`${started.cgroup.path}/cgroup.kill`)).toBe("1");
    expect(fileSystem.directories.has(started.cgroup.path)).toBe(true);
    expect(records.log).not.toContain("state:stopping");
    expect(records.log).not.toContain("state:stopped");
  });
});
