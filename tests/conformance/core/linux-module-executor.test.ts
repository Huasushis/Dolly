/**
 * The Linux Module executor replaces "the child exited" with the
 * Architecture Decision Record 0009 termination proof. These tests fix that
 * substitution: `terminate()` resolves only when the capability session has
 * closed, the whole Module control group is proven empty, and the Extension
 * protocol channel is observed closed. Any missing part raises
 * `ModuleExecutorTerminationUnconfirmedError`, which the reactive runtime
 * already treats as "preserve the Claim, start no replacement".
 */
import { describe, expect, it, vi } from "vitest";
import {
  createLinuxModuleExecutor,
  type LinuxModuleProtocolSession,
} from "../../../src/adapters/linux-module-executor.js";
import {
  ModuleExecutorTerminationUnconfirmedError,
  type ModuleExecutor,
} from "../../../src/core/module-actor.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type { ModuleProcessRecord } from "../../../src/core/module-process-records.js";
import type { ModuleProcessRecordWriter } from "../../../src/core/linux-module-process-lifecycle.js";
import type { ReactiveModuleInput } from "../../../src/core/reactive-module-input.js";
import type { ReactiveModuleResult } from "../../../src/core/reactive-module-runtime.js";

const DELEGATED_ROOT = "/system.slice/dolly-core.service";
const IDENTITY = {
  instanceId: "instance-1",
  moduleId: "worker",
  processGenerationId: "process-generation-1",
};
const MODULE_GENERATION_ID = "module-generation-1";
const TERMINATION_CONTEXT = {
  moduleId: IDENTITY.moduleId,
  moduleGenerationId: MODULE_GENERATION_ID,
} as const;
const LIMITS = {
  memoryMaxBytes: 64 * 1024 * 1024,
  maxProcesses: 16,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};

function processRecord(): ModuleProcessRecord {
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: IDENTITY.instanceId,
    moduleId: IDENTITY.moduleId,
    moduleGenerationId: MODULE_GENERATION_ID,
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

function recordWriter(): ModuleProcessRecordWriter {
  let current = processRecord();
  return {
    appendModuleProcessRecord(record) {
      current = record;
      return record;
    },
    updateModuleProcessRecordState(_id, state) {
      current = { ...current, state };
      return current;
    },
  };
}

function cgroupFileSystem(populated: () => string) {
  const directories = new Set<string>();
  const files = new Map<string, string>();
  return {
    async createDirectory(path: string) {
      directories.add(path);
    },
    async removeDirectory(path: string) {
      directories.delete(path);
    },
    async directoryExists(path: string) {
      return directories.has(path);
    },
    async listChildDirectoryNames() {
      return [] as readonly string[];
    },
    async writableFileExists(path: string) {
      return directories.has(path.slice(0, path.lastIndexOf("/")));
    },
    async readTextFile(path: string) {
      if (path.endsWith("/cgroup.events")) return populated();
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    async writeTextFile(path: string, contents: string) {
      files.set(path, contents);
    },
  };
}

function protocolSession(
  overrides: Partial<LinuxModuleProtocolSession> = {},
): LinuxModuleProtocolSession {
  return {
    initialize: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ schemaVersion: "dolly.module-result/1" }) as const),
    cancel: vi.fn(async () => undefined),
    closeCapabilitySession: vi.fn(async () => undefined),
    waitForChannelClosed: vi.fn(async () => true),
    ...overrides,
  };
}

function assertRequiredExecutorOperations(
  executor: ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult>,
): asserts executor is ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult> &
  Required<
    Pick<
      ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult>,
      "start" | "cancel" | "terminate"
    >
  > {
  if (
    executor.start === undefined ||
    executor.cancel === undefined ||
    executor.terminate === undefined
  ) {
    throw new Error(
      "The Linux Module executor must provide start, cancel, and terminate operations",
    );
  }
}

function executorFor(options: {
  readonly populated: () => string;
  readonly session: LinuxModuleProtocolSession;
}) {
  const executor = createLinuxModuleExecutor({
    moduleId: IDENTITY.moduleId,
    moduleGenerationId: MODULE_GENERATION_ID,
    lifecycle: {
      records: recordWriter(),
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher: async () => ({
        processId: 4242,
        configure: async () => undefined,
        authorizeExecution: async () => undefined,
        requestExit: async () => true,
      }),
      execution: {
        program: "/opt/dolly/node",
        argumentVector: ["/opt/dolly/node", "/opt/dolly/extension/index.mjs"],
        environment: {},
      },
      cgroupFileSystem: cgroupFileSystem(options.populated),
    },
    openProtocolSession: async () => options.session,
    terminationTimeoutMs: 200,
    channelCloseTimeoutMs: 200,
  });
  assertRequiredExecutorOperations(executor);
  return executor;
}

describe("Linux Module executor termination proof", () => {
  it("does not create a process while the executor is being built", async () => {
    const session = protocolSession();
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
    });
    // Construction returns a terminable handle; nothing has started.
    expect(typeof executor.terminate).toBe("function");
    expect(session.initialize).not.toHaveBeenCalled();
  });

  it("proves termination only after the capability session, the group, and the channel", async () => {
    let populated = "populated 1\nfrozen 0\n";
    const session = protocolSession();
    const executor = executorFor({ populated: () => populated, session });

    await executor.start();
    expect(session.initialize).toHaveBeenCalledOnce();

    populated = "populated 0\nfrozen 0\n";
    await executor.terminate(TERMINATION_CONTEXT);

    // The capability session closes before the group is terminated, so no
    // handler can still be running when the Claim's outcome is decided.
    expect(session.closeCapabilitySession).toHaveBeenCalledOnce();
    expect(session.waitForChannelClosed).toHaveBeenCalledOnce();
  });

  it("refuses to confirm termination while the control group still holds members", async () => {
    const session = protocolSession();
    const executor = executorFor({
      populated: () => "populated 1\nfrozen 0\n",
      session,
    });
    await executor.start();

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    // The channel is never even consulted: the group proof failed first.
    expect(session.waitForChannelClosed).not.toHaveBeenCalled();
  });

  it("refuses to confirm termination when the protocol channel is not observed closed", async () => {
    const session = protocolSession({
      waitForChannelClosed: vi.fn(async () => false),
    });
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
    });
    await executor.start();
    // Membership was verified during start, so an empty reading is meaningful.

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
  });

  it("refuses to confirm termination when the capability session does not close", async () => {
    const session = protocolSession({
      closeCapabilitySession: vi.fn(async () => {
        throw new Error("a capability handler never finished");
      }),
    });
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
    });
    await executor.start();

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
  });

  it("treats cancellation as cooperative and never as termination proof", async () => {
    const session = protocolSession();
    const executor = executorFor({
      populated: () => "populated 1\nfrozen 0\n",
      session,
    });
    await executor.start();

    await executor.cancel({
      moduleId: IDENTITY.moduleId,
      moduleJobId: "module-job-1",
      runId: "run-1",
      moduleGenerationId: MODULE_GENERATION_ID,
      reason: "soft-timeout",
    });

    expect(session.cancel).toHaveBeenCalledOnce();
    // Cancelling proves nothing: the group still holds members.
    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
  });
});
