/**
 * The Linux Module executor replaces "the child exited" with the
 * Architecture Decision Record 0009 termination proof. These tests fix that
 * substitution: `terminate()` resolves only when the capability session has
 * closed, the whole Module control group is proven empty, and the Extension
 * protocol channel is observed closed. Any missing part raises
 * `ModuleExecutorTerminationUnconfirmedError`, which the reactive runtime
 * already treats as "preserve the Claim, start no replacement".
 */
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createLinuxModuleExecutor,
  type LinuxModuleProtocolSession,
} from "../../../src/adapters/linux-module-executor.js";
import {
  ModuleActor,
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
const CORE_EXIT_FIXTURE = fileURLToPath(
  new URL("./fixtures/linux-module-executor-core-exit.ts", import.meta.url),
);
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

function cgroupFileSystem(
  populated: () => string,
  options: {
    readonly onWrite?: (path: string, contents: string) => void | Promise<void>;
  } = {},
) {
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
      await options.onWrite?.(path, contents);
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

function confirmedExecutionAuthorization(processId = 4242) {
  return {
    executionAuthorized: true,
    verifiedProcessIds: [processId],
  } as const;
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
  readonly coreExitCleanupTimeoutMs?: number;
  readonly exitCoreProcess?: (status: number) => void;
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
          authorizeExecution: async () => confirmedExecutionAuthorization(),
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
    coreExitCleanupTimeoutMs: options.coreExitCleanupTimeoutMs ?? 200,
    // Unit tests must inspect the path after it would end Core. A separate
    // child-process test covers the production `process.exit` default.
    exitCoreProcess: options.exitCoreProcess ?? (() => undefined),
  });
  assertRequiredExecutorOperations(executor);
  return executor;
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      reject(new Error(`child did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("Linux Module executor termination proof", () => {
  it("uses a direct nonzero process exit when unconfirmed ownership reaches the production default", async () => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", CORE_EXIT_FIXTURE], {
      cwd: process.cwd(),
      stdio: "pipe",
      windowsHide: true,
    });

    const result = await waitForChildExit(child, 3_000);
    expect(result.stdout).toContain("STARTED");
    expect(result.stdout).not.toContain("EXIT_HOOK_RETURNED");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(1);
  });

  it("keeps the cleanup deadline alive until the production Core exit runs", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", CORE_EXIT_FIXTURE, "hanging-cleanup"],
      {
        cwd: process.cwd(),
        stdio: "pipe",
        windowsHide: true,
      },
    );

    const result = await waitForChildExit(child, 3_000);
    expect(result.stdout).toContain("STARTED");
    expect(result.stdout).not.toContain("EXIT_HOOK_RETURNED");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(1);
  });

  it("requests Core exit before ModuleActor converts the startup failure", async () => {
    const eventOrder: string[] = [];
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session: protocolSession(),
      exitCoreProcess: (status) => eventOrder.push(`exit:${status}`),
      startLauncher: async () => ({
        processId: 4242,
        configure: async () => {
          throw new Error("the launcher control channel failed");
        },
        authorizeExecution: async () => confirmedExecutionAuthorization(),
        requestExit: async () => false,
      }),
    });
    const actor = new ModuleActor<ReactiveModuleInput, ReactiveModuleResult>({
      moduleId: IDENTITY.moduleId,
      initialModuleGenerationId: MODULE_GENERATION_ID,
      maxQueuedRuns: 4,
      maxQueuedInputBytes: 1024,
      maxInputBytes: 512,
      maxRunsPerGeneration: 100,
      maxGenerations: 8,
      requireProcessIsolation: true,
      initializationTimeoutMs: 200,
      terminationTimeoutMs: 200,
      nextModuleGenerationId: () => "module-generation-2",
      monotonicNow: () => 1,
      snapshotInput: (input) => structuredClone(input),
      measureInputBytes: (input) => Buffer.byteLength(JSON.stringify(input)),
      snapshotOutput: (output) => structuredClone(output),
      createExecutor: () => executor,
      acceptResult: () => undefined,
    });

    const failure = await actor.start().catch((error: unknown) => error);
    eventOrder.push("actor-failed");
    expect(failure).toMatchObject({ code: "ACTOR_FAILED" });
    expect(eventOrder).toEqual(["exit:1", "actor-failed"]);
    expect(actor.state).toBe("failed");
  });

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

  it("persists running only after protocol initialization completes", async () => {
    const records = recordStore();
    const initializationStarted = deferred<void>();
    const allowInitialization = deferred<void>();
    const session = protocolSession({
      initialize: vi.fn(async () => {
        initializationStarted.resolve();
        await allowInitialization.promise;
      }),
    });
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      records,
    });

    const start = executor.start();
    await initializationStarted.promise;
    expect(records.current?.state).toBe("starting");
    expect(records.log).not.toContain("state:running");

    allowInitialization.resolve();
    await start;
    expect(records.current?.state).toBe("running");
    expect(records.log.filter((entry) => entry === "state:running")).toHaveLength(1);
  });

  it("retains termination ownership when persisting running fails", async () => {
    let populated = "populated 1\nfrozen 0\n";
    const records = recordStore({
      rejectStateChange: (state) => state === "running",
    });
    const fileSystem = cgroupFileSystem(() => populated);
    const session = protocolSession();
    const executor = executorFor({
      populated: () => populated,
      session,
      records,
      fileSystem,
    });

    await expect(executor.start()).rejects.toThrowError(
      /simulated failure persisting process-record state running/,
    );
    expect(session.initialize).toHaveBeenCalledOnce();
    expect(records.current?.state).toBe("starting");
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
          moduleJobId: "module-job-before-running-write",
          runId: "run-before-running-write",
          attempt: 1,
          startedAt: Date.now(),
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrowError(
      /before protocol initialization is complete and the running record is persisted/,
    );
    expect(session.execute).not.toHaveBeenCalled();

    populated = "populated 0\nfrozen 0\n";
    await expect(executor.terminate(TERMINATION_CONTEXT)).resolves.toBeUndefined();
    expect(session.closeCapabilitySession).toHaveBeenCalledOnce();
    expect(session.waitForChannelClosed).toHaveBeenCalledOnce();
    expect(
      fileSystem.writeLog.filter(
        ({ path, contents }) => path.endsWith("/cgroup.kill") && contents === "1",
      ),
    ).toHaveLength(1);
    expect(records.log).toContain("state:stopping");
    expect(records.current?.state).toBe("stopped");
    expect(fileSystem.directories.has(processRecord().moduleCgroupPath)).toBe(false);
  });

  it("retains termination ownership when protocol initialization fails", async () => {
    const records = recordStore();
    const fileSystem = cgroupFileSystem(() => "populated 0\nfrozen 0\n");
    const session = protocolSession({
      initialize: vi.fn(async () => {
        throw new Error("authenticated initialization failed");
      }),
    });
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      records,
      fileSystem,
    });

    await expect(executor.start()).rejects.toThrowError(/initialization failed/);
    expect(records.current?.state).toBe("starting");
    expect(records.log).not.toContain("state:running");

    await expect(executor.terminate(TERMINATION_CONTEXT)).resolves.toBeUndefined();
    expect(session.closeCapabilitySession).toHaveBeenCalledOnce();
    expect(session.waitForChannelClosed).toHaveBeenCalledOnce();
    expect(
      fileSystem.writeLog.filter(
        ({ path, contents }) => path.endsWith("/cgroup.kill") && contents === "1",
      ),
    ).toHaveLength(1);
    expect(records.current?.state).toBe("stopped");
    expect(fileSystem.directories.has(processRecord().moduleCgroupPath)).toBe(false);
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
          return confirmedExecutionAuthorization();
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
    const authorizeExecution = vi.fn(async () => confirmedExecutionAuthorization());
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

  it("ends Core after a start failure whose launcher cannot be accounted for", async () => {
    const exitStatuses: number[] = [];
    const session = protocolSession();
    const executor = executorFor({
      populated: () => "populated 0\nfrozen 0\n",
      session,
      exitCoreProcess: (status) => exitStatuses.push(status),
      startLauncher: async () => ({
        processId: 4242,
        configure: async () => {
          throw new Error("the launcher control channel failed");
        },
        authorizeExecution: async () => confirmedExecutionAuthorization(),
        requestExit: async () => false,
      }),
    });
    await expect(executor.start()).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    expect(exitStatuses).toEqual([1]);

    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    expect(exitStatuses).toEqual([1]);
  });

  it("starts observed-group cleanup before ending Core for an unobserved launcher", async () => {
    let populated = "populated 1\nfrozen 0\n";
    const records = recordStore();
    const fileSystem = cgroupFileSystem(() => populated, {
      onWrite(path, contents) {
        if (path.endsWith("/cgroup.kill") && contents === "1") {
          populated = "populated 0\nfrozen 0\n";
        }
      },
    });
    const exitStatuses: number[] = [];
    const session = protocolSession();
    const executor = executorFor({
      populated: () => populated,
      session,
      records,
      fileSystem,
      exitCoreProcess: (status) => exitStatuses.push(status),
      startLauncher: async () => ({
        processId: 4242,
        configure: async () => undefined,
        authorizeExecution: async () => ({
          executionAuthorized: false,
          code: "LAUNCHER_MEMBERSHIP_UNVERIFIED",
          detail: "the control group contained only an unexplained process",
          membershipVerified: false,
          observedProcessIds: [99],
          executeCommandMayHaveBeenDelivered: false,
          launcherExitObserved: false,
        }),
        requestExit: async () => false,
      }),
    });

    await expect(executor.start()).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    await expect(executor.terminate(TERMINATION_CONTEXT)).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );

    expect(
      fileSystem.writeLog.filter(
        ({ path, contents }) => path.endsWith("/cgroup.kill") && contents === "1",
      ),
    ).toHaveLength(1);
    expect(records.current?.state).toBe("stopping");
    expect(records.log).not.toContain("state:stopped");
    expect(fileSystem.directories.has(processRecord().moduleCgroupPath)).toBe(true);
    expect(session.closeCapabilitySession).not.toHaveBeenCalled();
    expect(exitStatuses).toEqual([1]);
  });

  it("ends Core even when recording the stopping intent fails", async () => {
    let populated = "populated 1\nfrozen 0\n";
    const records = recordStore({
      rejectStateChange: (state) => state === "stopping",
    });
    const fileSystem = cgroupFileSystem(() => populated, {
      onWrite(path, contents) {
        if (path.endsWith("/cgroup.kill") && contents === "1") {
          populated = "populated 0\nfrozen 0\n";
        }
      },
    });
    const exitStatuses: number[] = [];
    const executor = executorFor({
      populated: () => populated,
      session: protocolSession(),
      records,
      fileSystem,
      exitCoreProcess: (status) => exitStatuses.push(status),
      startLauncher: async () => ({
        processId: 4242,
        configure: async () => undefined,
        authorizeExecution: async () => ({
          executionAuthorized: false,
          code: "LAUNCHER_MEMBERSHIP_UNVERIFIED",
          detail: "the execute command may have reached the launcher",
          membershipVerified: true,
          observedProcessIds: [4242],
          executeCommandMayHaveBeenDelivered: true,
          launcherExitObserved: false,
        }),
        requestExit: async () => false,
      }),
    });

    await expect(executor.start()).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    expect(exitStatuses).toEqual([1]);
    expect(
      fileSystem.writeLog.filter(
        ({ path, contents }) => path.endsWith("/cgroup.kill") && contents === "1",
      ),
    ).toHaveLength(1);
    expect(records.current?.state).toBe("starting");
    expect(records.log).not.toContain("state:stopped");
  });

  it("does not let a hanging control-group cleanup prevent the required Core exit", async () => {
    const cleanupNeverSettles = new Promise<void>(() => undefined);
    const fileSystem = cgroupFileSystem(
      () => "populated 1\nfrozen 0\n",
      {
        onWrite(path, contents) {
          if (path.endsWith("/cgroup.kill") && contents === "1") {
            return cleanupNeverSettles;
          }
        },
      },
    );
    const exitStatuses: number[] = [];
    const executor = executorFor({
      populated: () => "populated 1\nfrozen 0\n",
      session: protocolSession(),
      fileSystem,
      coreExitCleanupTimeoutMs: 20,
      exitCoreProcess: (status) => exitStatuses.push(status),
      startLauncher: async () => ({
        processId: 4242,
        configure: async () => undefined,
        authorizeExecution: async () => ({
          executionAuthorized: false,
          code: "LAUNCHER_MEMBERSHIP_UNVERIFIED",
          detail: "the control group contained an unexplained process",
          membershipVerified: false,
          observedProcessIds: [99],
          executeCommandMayHaveBeenDelivered: false,
          launcherExitObserved: false,
        }),
        requestExit: async () => false,
      }),
    });

    const startedAt = Date.now();
    await expect(executor.start()).rejects.toThrowError(
      ModuleExecutorTerminationUnconfirmedError,
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(exitStatuses).toEqual([1]);
    expect(
      fileSystem.writeLog.filter(
        ({ path, contents }) => path.endsWith("/cgroup.kill") && contents === "1",
      ),
    ).toHaveLength(1);
  });

  it("does not allow start to create resources after termination already completed", async () => {
    const startLauncher = vi.fn(async (): Promise<ModuleLauncherControl> => ({
      processId: 4242,
      configure: async () => undefined,
      authorizeExecution: async () => confirmedExecutionAuthorization(),
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
