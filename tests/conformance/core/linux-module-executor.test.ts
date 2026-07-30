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
import {
  canTransitionModuleProcessRecordState,
  type ModuleProcessRecord,
} from "../../../src/core/module-process-records.js";
import type {
  ModuleLauncherControl,
  ModuleProcessRecordStore,
} from "../../../src/core/linux-module-process-lifecycle.js";
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

interface TestRecordStore extends ModuleProcessRecordStore {
  readonly current: ModuleProcessRecord | undefined;
  readonly log: readonly string[];
}

function recordStore(
  options: {
    readonly rejectStateChange?: (state: ModuleProcessRecord["state"]) => boolean;
  } = {},
): TestRecordStore {
  const log: string[] = [];
  let current = processRecord();
  return {
    get current() {
      return current;
    },
    log,
    getModuleProcessRecord(processGenerationId) {
      return current.processGenerationId === processGenerationId ? current : undefined;
    },
    appendModuleProcessRecord(record) {
      log.push("append");
      current = record;
      return record;
    },
    updateModuleProcessRecordState(_id, state) {
      if (options.rejectStateChange?.(state) === true) {
        throw new Error(`simulated failure persisting process-record state ${state}`);
      }
      if (!canTransitionModuleProcessRecordState(current.state, state)) {
        throw new Error(`invalid process-record transition ${current.state} -> ${state}`);
      }
      log.push(`state:${state}`);
      current = { ...current, state };
      return current;
    },
  };
}

function cgroupFileSystem(populated: () => string) {
  const directories = new Set<string>();
  const files = new Map<string, string>();
  const writeLog: { path: string; contents: string }[] = [];
  return {
    directories,
    writeLog,
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
      writeLog.push({ path, contents });
      files.set(path, contents);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  readonly records?: TestRecordStore;
  readonly fileSystem?: ReturnType<typeof cgroupFileSystem>;
  readonly startLauncher?: () => Promise<ModuleLauncherControl>;
  readonly openProtocolSession?: () => LinuxModuleProtocolSession;
}) {
  const records = options.records ?? recordStore();
  const fileSystem = options.fileSystem ?? cgroupFileSystem(options.populated);
  const executor = createLinuxModuleExecutor({
    moduleId: IDENTITY.moduleId,
    moduleGenerationId: MODULE_GENERATION_ID,
    lifecycle: {
      records,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 256,
      startLauncher:
        options.startLauncher ??
        (async () => ({
          processId: 4242,
          configure: async () => undefined,
          authorizeExecution: async () => undefined,
          requestExit: async () => true,
        })),
      execution: {
        program: "/opt/dolly/node",
        argumentVector: ["/opt/dolly/node", "/opt/dolly/extension/index.mjs"],
        environment: {},
      },
      cgroupFileSystem: fileSystem,
    },
    openProtocolSession: options.openProtocolSession ?? (() => options.session),
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
    const fileSystem = cgroupFileSystem(() => populated);
    const capabilityHandlersSettled = deferred<void>();
    const session = protocolSession({
      closeCapabilitySession: vi.fn(() => {
        expect(
          fileSystem.writeLog.some(({ path }) => path.endsWith("/cgroup.kill")),
        ).toBe(false);
        return capabilityHandlersSettled.promise;
      }),
    });
    const executor = executorFor({ populated: () => populated, session, fileSystem });

    await executor.start();
    expect(session.initialize).toHaveBeenCalledOnce();

    populated = "populated 0\nfrozen 0\n";
    const termination = executor.terminate(TERMINATION_CONTEXT);
    await vi.waitFor(() =>
      expect(
        fileSystem.writeLog.some(({ path }) => path.endsWith("/cgroup.kill")),
      ).toBe(true),
    );
    capabilityHandlersSettled.resolve();
    await termination;

    // Closing synchronously rejects new calls before cgroup.kill. Existing
    // handlers may finish later, but termination is not confirmed until then.
    expect(session.closeCapabilitySession).toHaveBeenCalledOnce();
    expect(session.waitForChannelClosed).toHaveBeenCalledOnce();
  });

  it("terminates the whole group when persisting the stopping state fails", async () => {
    const records = recordStore({
      rejectStateChange: (state) => state === "stopping",
    });
    const fileSystem = cgroupFileSystem(() => "populated 0\nfrozen 0\n");
    const session = protocolSession();
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      records,
      fileSystem,
    });
    await executor.start();

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    expect(session.closeCapabilitySession).toHaveBeenCalledOnce();
    expect(session.waitForChannelClosed).toHaveBeenCalledOnce();
    expect(
      fileSystem.writeLog.some(
        ({ path, contents }) => path.endsWith("/cgroup.kill") && contents === "1",
      ),
    ).toBe(true);
    expect(records.current?.state).toBe("running");
    expect(fileSystem.directories.has(processRecord().moduleCgroupPath)).toBe(true);
  });

  it("refuses to confirm termination while the control group still holds members", async () => {
    const records = recordStore();
    const fileSystem = cgroupFileSystem(() => "populated 1\nfrozen 0\n");
    const session = protocolSession();
    const executor = executorFor({
      populated: () => "populated 1\nfrozen 0\n",
      session,
      records,
      fileSystem,
    });
    await executor.start();

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    // Every independent condition is observed in the same attempt, but a
    // failed group proof still preserves both the durable state and directory.
    expect(session.waitForChannelClosed).toHaveBeenCalledOnce();
    expect(records.current?.state).toBe("stopping");
    expect(fileSystem.directories.has(processRecord().moduleCgroupPath)).toBe(true);
  });

  it("refuses to confirm termination when the protocol channel is not observed closed", async () => {
    const records = recordStore();
    const fileSystem = cgroupFileSystem(() => "populated 0\nfrozen 0\n");
    const session = protocolSession({
      waitForChannelClosed: vi.fn(async () => false),
    });
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      records,
      fileSystem,
    });
    await executor.start();
    // Membership was verified during start, so an empty reading is meaningful.

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    expect(records.current?.state).toBe("stopping");
    expect(fileSystem.directories.has(processRecord().moduleCgroupPath)).toBe(true);
  });

  it("refuses to confirm termination when the capability session does not close", async () => {
    const records = recordStore();
    const fileSystem = cgroupFileSystem(() => "populated 0\nfrozen 0\n");
    const session = protocolSession({
      closeCapabilitySession: vi.fn(async () => {
        throw new Error("a capability handler never finished");
      }),
    });
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      records,
      fileSystem,
    });
    await executor.start();

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    expect(
      fileSystem.writeLog.some(
        ({ path, contents }) => path.endsWith("/cgroup.kill") && contents === "1",
      ),
    ).toBe(true);
    expect(records.current?.state).toBe("stopping");
    expect(fileSystem.directories.has(processRecord().moduleCgroupPath)).toBe(true);
  });

  it("does not treat a failed protocol-session attachment as a closed channel", async () => {
    const records = recordStore();
    const fileSystem = cgroupFileSystem(() => "populated 0\nfrozen 0\n");
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session: protocolSession(),
      records,
      fileSystem,
      openProtocolSession: () => {
        throw new Error("the protocol transport could not be attached");
      },
    });
    await expect(executor.start()).rejects.toThrowError(/could not be attached/);

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    expect(
      fileSystem.writeLog.some(
        ({ path, contents }) => path.endsWith("/cgroup.kill") && contents === "1",
      ),
    ).toBe(true);
    expect(records.current?.state).toBe("stopping");
    expect(fileSystem.directories.has(processRecord().moduleCgroupPath)).toBe(true);
  });

  it("attaches the protocol session when termination races after authorization", async () => {
    const authorizationStarted = deferred<void>();
    const allowAuthorization = deferred<void>();
    const session = protocolSession();
    const openProtocolSession = vi.fn(() => session);
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      openProtocolSession,
      startLauncher: async () => ({
        processId: 4242,
        configure: async () => undefined,
        authorizeExecution: async () => {
          authorizationStarted.resolve();
          await allowAuthorization.promise;
        },
        requestExit: async () => true,
      }),
    });

    const startOutcome = executor.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    await authorizationStarted.promise;
    const termination = executor.terminate(TERMINATION_CONTEXT);
    allowAuthorization.resolve();
    await vi.waitFor(() => expect(openProtocolSession).toHaveBeenCalledOnce());

    expect(await startOutcome).toMatchObject({
      message: expect.stringMatching(/before protocol initialization/),
    });
    await expect(termination).resolves.toBeUndefined();
    expect(session.initialize).not.toHaveBeenCalled();
    expect(session.closeCapabilitySession).toHaveBeenCalledOnce();
    expect(session.waitForChannelClosed).toHaveBeenCalledOnce();
  });

  it("does not confirm termination while protocol initialization is unfinished", async () => {
    const initializationStarted = deferred<void>();
    const allowInitialization = deferred<void>();
    const session = protocolSession({
      initialize: vi.fn(async () => {
        initializationStarted.resolve();
        await allowInitialization.promise;
      }),
    });
    const fileSystem = cgroupFileSystem(() => "populated 0\nfrozen 0\n");
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      fileSystem,
    });
    const startOutcome = executor.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    await initializationStarted.promise;

    let terminationSettled = false;
    const termination = executor.terminate(TERMINATION_CONTEXT).finally(() => {
      terminationSettled = true;
    });
    await vi.waitFor(() =>
      expect(
        fileSystem.writeLog.some(({ path }) => path.endsWith("/cgroup.kill")),
      ).toBe(true),
    );
    expect(session.closeCapabilitySession).toHaveBeenCalledOnce();
    expect(session.waitForChannelClosed).toHaveBeenCalledOnce();
    expect(terminationSettled).toBe(false);

    allowInitialization.resolve();
    expect(await startOutcome).toMatchObject({
      message: expect.stringMatching(/during protocol initialization/),
    });
    await expect(termination).resolves.toBeUndefined();
  });

  it("makes simultaneous termination calls wait for the same proof", async () => {
    const channelClosed = deferred<boolean>();
    const session = protocolSession({
      waitForChannelClosed: vi.fn(async () => await channelClosed.promise),
    });
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
    });
    await executor.start();

    const first = executor.terminate(TERMINATION_CONTEXT);
    await vi.waitFor(() => expect(session.waitForChannelClosed).toHaveBeenCalledOnce());
    let secondSettled = false;
    const second = executor.terminate(TERMINATION_CONTEXT).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    channelClosed.resolve(true);
    await Promise.all([first, second]);
    expect(session.closeCapabilitySession).toHaveBeenCalledOnce();
    expect(session.waitForChannelClosed).toHaveBeenCalledOnce();
  });

  it("does not accept new work after termination begins", async () => {
    const channelClosed = deferred<boolean>();
    const session = protocolSession({
      waitForChannelClosed: vi.fn(async () => await channelClosed.promise),
    });
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
    });
    await executor.start();

    const termination = executor.terminate(TERMINATION_CONTEXT);
    await vi.waitFor(() => expect(session.waitForChannelClosed).toHaveBeenCalledOnce());
    await expect(
      executor.execute(
        {
          schemaVersion: "dolly.reactive-module-input/2",
          claimedDeliveryIds: [],
          blockGroups: [],
          hasMore: false,
        },
        {
          moduleId: IDENTITY.moduleId,
          moduleGenerationId: MODULE_GENERATION_ID,
          moduleJobId: "module-job-after-stop",
          runId: "run-after-stop",
          attempt: 1,
          startedAt: Date.now(),
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrowError(/during termination/);
    expect(session.execute).not.toHaveBeenCalled();

    channelClosed.resolve(true);
    await termination;
  });

  it("retries every missing termination condition after a rejected call", async () => {
    const records = recordStore();
    const fileSystem = cgroupFileSystem(() => "populated 0\nfrozen 0\n");
    const session = protocolSession({
      waitForChannelClosed: vi
        .fn<LinuxModuleProtocolSession["waitForChannelClosed"]>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      records,
      fileSystem,
    });
    await executor.start();

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    await expect(executor.terminate(TERMINATION_CONTEXT)).resolves.toBeUndefined();

    expect(session.closeCapabilitySession).toHaveBeenCalledTimes(2);
    expect(session.waitForChannelClosed).toHaveBeenCalledTimes(2);
    expect(
      fileSystem.writeLog.filter(({ path }) => path.endsWith("/cgroup.kill")),
    ).toHaveLength(2);
    expect(records.log.filter((entry) => entry === "state:stopping")).toHaveLength(1);
    expect(records.current?.state).toBe("stopped");
  });

  it("retries the final durable write without addressing a removed group", async () => {
    let rejectStopped = true;
    const records = recordStore({
      rejectStateChange: (state) => state === "stopped" && rejectStopped,
    });
    const fileSystem = cgroupFileSystem(() => "populated 0\nfrozen 0\n");
    const session = protocolSession();
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      records,
      fileSystem,
    });
    await executor.start();

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    expect(records.current?.state).toBe("stopping");
    expect(fileSystem.directories.has(processRecord().moduleCgroupPath)).toBe(false);

    rejectStopped = false;
    await expect(executor.terminate(TERMINATION_CONTEXT)).resolves.toBeUndefined();
    expect(records.current?.state).toBe("stopped");
    expect(
      fileSystem.writeLog.filter(({ path }) => path.endsWith("/cgroup.kill")),
    ).toHaveLength(1);
    expect(session.closeCapabilitySession).toHaveBeenCalledTimes(2);
    expect(session.waitForChannelClosed).toHaveBeenCalledTimes(2);
  });

  it("waits for an in-progress start and prevents execution authorization", async () => {
    const configureStarted = deferred<void>();
    const allowConfigure = deferred<void>();
    const authorizeExecution = vi.fn(async () => undefined);
    const requestExit = vi.fn(async () => true);
    const session = protocolSession();
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      startLauncher: async () => ({
        processId: 4242,
        async configure() {
          configureStarted.resolve();
          await allowConfigure.promise;
        },
        authorizeExecution,
        requestExit,
      }),
    });

    const startOutcome = executor.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    await configureStarted.promise;
    let terminationSettled = false;
    const termination = executor.terminate(TERMINATION_CONTEXT).finally(() => {
      terminationSettled = true;
    });
    await Promise.resolve();
    expect(terminationSettled).toBe(false);

    allowConfigure.resolve();
    expect(await startOutcome).toBeInstanceOf(Error);
    await expect(termination).resolves.toBeUndefined();
    expect(authorizeExecution).not.toHaveBeenCalled();
    expect(requestExit).toHaveBeenCalledOnce();
  });

  it("never reports termination after a start failure that requires Core to exit", async () => {
    const session = protocolSession();
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      startLauncher: async () => ({
        processId: 4242,
        configure: async () => {
          throw new Error("the launcher control channel failed");
        },
        authorizeExecution: async () => undefined,
        requestExit: async () => false,
      }),
    });
    await expect(executor.start()).rejects.toThrowError(/Core must exit/);

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
  });

  it("does not allow start to create resources after termination already completed", async () => {
    const startLauncher = vi.fn(async (): Promise<ModuleLauncherControl> => ({
      processId: 4242,
      configure: async () => undefined,
      authorizeExecution: async () => undefined,
      requestExit: async () => true,
    }));
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session: protocolSession(),
      startLauncher,
    });

    await expect(executor.terminate(TERMINATION_CONTEXT)).resolves.toBeUndefined();
    await expect(executor.start()).rejects.toThrowError(/termination/i);
    expect(startLauncher).not.toHaveBeenCalled();
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
