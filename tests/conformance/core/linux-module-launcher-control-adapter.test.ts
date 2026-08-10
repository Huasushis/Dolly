/**
 * The adapter between the shipped launcher controller and the
 * `ModuleLauncherControl` shape the ordered Module process start is written
 * against, and the control-group path form that start hands to the launcher.
 *
 * This file covers the two contracts that connect the ordered Module start to
 * the launcher. Both now have product implementations.
 *
 * 1. `LinuxModuleLauncherController` runs the whole pre-execution sequence in
 *    one `authorizeExecution` call, reports failure as a returned outcome,
 *    and exposes neither `processId` nor `requestExit`. The product adapter
 *    must preserve that structured evidence for `startModuleProcess`.
 * 2. The launcher control protocol addresses the Module control group by its
 *    path below the cgroup version 2 mount point, because the launcher writes
 *    its own process identifier into `<path>/cgroup.procs`. The ordered start
 *    once passed the kernel-relative form, which `assertModuleCgroupPath`
 *    rejects; it now passes the filesystem path. That check exists to stop a
 *    wrong path from redirecting the write outside the control-group
 *    filesystem, so the regression test below rejects a converting adapter
 *    that would make every input legal.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createLinuxModuleExecutor,
  type LinuxModuleProtocolSession,
} from "../../../src/adapters/linux-module-executor.js";
import { createModuleLauncherControl } from "../../../src/adapters/linux-module-launcher/module-launcher-control.js";
import {
  LinuxModuleLauncherController,
  type LinuxModuleLauncherControlChannel,
  type LinuxModuleLauncherFailureCode,
} from "../../../src/adapters/linux-module-launcher/linux-module-launcher-controller.js";
import {
  asLauncherControlJson,
  createLauncherInCgroupEvent,
} from "../../../src/adapters/linux-module-launcher/launcher-control-protocol.js";
import {
  deriveModuleCgroupPath,
  prepareModuleCgroup,
  type ModuleCgroupFileSystem,
  type ModuleCgroupLimits,
} from "../../../src/core/linux-module-cgroup.js";
import {
  startModuleProcess,
  type ModuleLauncherControl,
  type ModuleProcessRecordStore,
} from "../../../src/core/linux-module-process-lifecycle.js";
import type {
  ModuleProcessRecord,
  ModuleProcessStoppedRecordWriter,
} from "../../../src/core/module-process-records.js";

const DELEGATED_ROOT = "/user.slice/user-1000.slice/user@1000.service/dolly.service";
const IDENTITY = {
  instanceId: "instance-1",
  moduleId: "worker",
  processGenerationId: "pg-0123456789abcdef",
} as const;
const LIMITS: ModuleCgroupLimits = {
  memoryMaxBytes: 67_108_864,
  maxProcesses: 16,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};
const LAUNCHER_PROCESS_ID = 4_242;

/**
 * Every failure code the controller can report. The type-level check below
 * fails to compile if the union gains a member this list does not carry, so a
 * new code cannot be added without a case here.
 */
const ALL_FAILURE_CODES = [
  "LAUNCHER_CONTROL_SEND_FAILED",
  "LAUNCHER_CONTROL_CHANNEL_CLOSED",
  "LAUNCHER_CONTROL_PROTOCOL_VIOLATION",
  "LAUNCHER_CONTROL_TIMEOUT",
  "LAUNCHER_MEMBERSHIP_UNVERIFIED",
  "LAUNCHER_STOP_REQUESTED",
] as const satisfies readonly LinuxModuleLauncherFailureCode[];

type UnlistedFailureCode = Exclude<
  LinuxModuleLauncherFailureCode,
  (typeof ALL_FAILURE_CODES)[number]
>;
// Reads as: the list above covers the union. If it does not, this is `false`
// and assigning `true` is a compile error.
const everyFailureCodeIsListed: [UnlistedFailureCode] extends [never] ? true : false = true;

interface ControllerHarness {
  readonly controller: LinuxModuleLauncherController;
  readonly sent: string[];
  /** Fails the next `send`, which the controller reports as a send failure. */
  failNextSend: boolean;
  /** Process identifiers `cgroup.procs` reports during verification. */
  members: number[];
  /** Runs when the controller starts its kernel membership read. */
  membershipReadHook: (() => void | Promise<void>) | undefined;
  exitObserved: boolean;
  readonly channel: LinuxModuleLauncherControlChannel;
}

function controllerHarness(): ControllerHarness {
  const sent: string[] = [];
  const state = {
    failNextSend: false,
    members: [LAUNCHER_PROCESS_ID] as number[],
    membershipReadHook: undefined as (() => void | Promise<void>) | undefined,
    exitObserved: true,
  };
  const channel: LinuxModuleLauncherControlChannel = {
    async send(message) {
      if (state.failNextSend) throw new Error("the control descriptor refused the frame");
      sent.push(JSON.stringify(message));
    },
    close() {
      // The owner of the channel closes it; the controller never does.
    },
  };
  const controller = new LinuxModuleLauncherController({
    channel,
    readModuleCgroupProcessIds: async () => {
      await state.membershipReadHook?.();
      return state.members;
    },
    waitForLauncherExit: async () => state.exitObserved,
    configureTimeoutMs: 200,
    inCgroupTimeoutMs: 100,
    membershipTimeoutMs: 200,
    exitObservationTimeoutMs: 200,
  });
  return {
    controller,
    sent,
    channel,
    get failNextSend() {
      return state.failNextSend;
    },
    set failNextSend(value: boolean) {
      state.failNextSend = value;
    },
    get members() {
      return state.members;
    },
    set members(value: number[]) {
      state.members = value;
    },
    get membershipReadHook() {
      return state.membershipReadHook;
    },
    set membershipReadHook(value: (() => void | Promise<void>) | undefined) {
      state.membershipReadHook = value;
    },
    get exitObserved() {
      return state.exitObserved;
    },
    set exitObserved(value: boolean) {
      state.exitObserved = value;
    },
  };
}

interface LauncherHarness {
  readonly controllerHarness: ControllerHarness;
  readonly launcher: {
    readonly processId: number;
    readonly controller: LinuxModuleLauncherController;
    closeControlChannel(): void;
    waitForExit(timeoutMs: number): Promise<boolean>;
  };
  readonly closed: { count: number };
  exitAfterClose: boolean;
}

function launcherHarness(): LauncherHarness {
  const controllerHarness_ = controllerHarness();
  const closed = { count: 0 };
  const harness: LauncherHarness = {
    controllerHarness: controllerHarness_,
    closed,
    exitAfterClose: true,
    launcher: {
      processId: LAUNCHER_PROCESS_ID,
      controller: controllerHarness_.controller,
      closeControlChannel: () => {
        closed.count += 1;
      },
      waitForExit: async () => harness.exitAfterClose,
    },
  };
  return harness;
}

/**
 * Reports the launcher's `in-cgroup` event, which the controller waits for.
 * The frame is built by the protocol module rather than written out here, so
 * this cannot drift from the wire format the launcher actually sends.
 */
function reportInCgroup(harness: ControllerHarness): void {
  harness.controller.receiveControlMessage(
    asLauncherControlJson(createLauncherInCgroupEvent()),
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const CONFIGURE = {
  moduleCgroupPath: deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY).filesystemPath,
  maxOpenFiles: 64,
} as const;

const EXECUTION = {
  moduleCgroupPath: CONFIGURE.moduleCgroupPath,
  program: "/usr/bin/node",
  argumentVector: ["/usr/bin/node", "/opt/extension/main.mjs"],
  environment: {},
  stopRequested: () => false,
} as const;

/**
 * Drives one failure code out of the real controller, then reports what the
 * adapter did with it.
 */
async function authorizeAndCapture(
  code: LinuxModuleLauncherFailureCode,
): Promise<{
  control: ModuleLauncherControl;
  authorization: Awaited<ReturnType<ModuleLauncherControl["authorizeExecution"]>>;
  harness: LauncherHarness;
}> {
  const harness = launcherHarness();
  const control = createModuleLauncherControl({ launcher: harness.launcher });
  await control.configure(CONFIGURE);

  if (code === "LAUNCHER_CONTROL_SEND_FAILED") harness.controllerHarness.failNextSend = true;
  if (code === "LAUNCHER_STOP_REQUESTED") harness.controllerHarness.controller.requestStop();
  if (code === "LAUNCHER_MEMBERSHIP_UNVERIFIED") harness.controllerHarness.members = [];

  const authorization = control.authorizeExecution(EXECUTION);

  // The remaining codes need an event once the controller is waiting.
  if (code === "LAUNCHER_CONTROL_CHANNEL_CLOSED") {
    await Promise.resolve();
    harness.controllerHarness.controller.observeControlChannelClosed();
  } else if (code === "LAUNCHER_CONTROL_PROTOCOL_VIOLATION") {
    await Promise.resolve();
    harness.controllerHarness.controller.receiveControlMessage({ unexpected: true });
  } else if (code !== "LAUNCHER_CONTROL_TIMEOUT") {
    await Promise.resolve();
    reportInCgroup(harness.controllerHarness);
  }

  return { control, authorization: await authorization, harness };
}

/** An in-memory control-group filesystem sufficient for `prepareModuleCgroup`. */
function cgroupFileSystem(
  populated: () => string = () => "populated 0\nfrozen 0\n",
): ModuleCgroupFileSystem & {
  readonly directories: Set<string>;
  readonly writeLog: readonly { readonly path: string; readonly content: string }[];
} {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const writeLog: { path: string; content: string }[] = [];
  return {
    directories,
    writeLog,
    async readTextFile(path) {
      if (path.endsWith("/cgroup.events")) return populated();
      const value = files.get(path);
      if (value === undefined) throw new Error(`${path} does not exist`);
      return value;
    },
    async writeTextFile(path, content) {
      writeLog.push({ path, content });
      files.set(path, content);
    },
    async createDirectory(path) {
      directories.add(path);
    },
    async removeDirectory(path) {
      directories.delete(path);
    },
    async listChildDirectoryNames() {
      return [];
    },
    async directoryExists(path) {
      return directories.has(path);
    },
    async writableFileExists(path) {
      return directories.has(path.slice(0, path.lastIndexOf("/")));
    },
  };
}

function recordStore(): ModuleProcessRecordStore & {
  readonly current: ModuleProcessRecord | undefined;
  readonly stoppedRecordWriter: ModuleProcessStoppedRecordWriter;
} {
  const records = new Map<string, ModuleProcessRecord>();
  return {
    get current() {
      return records.get(IDENTITY.processGenerationId);
    },
    stoppedRecordWriter: {
      isStoreBoundTo: () => true,
      isBoundTo(record) {
        return records.get(record.processGenerationId) === record;
      },
      writeStopped(processGenerationId, failureCode) {
        const current = records.get(processGenerationId);
        if (!current) throw new Error(`no record for ${processGenerationId}`);
        const next = {
          ...current,
          state: "stopped",
          ...(failureCode === undefined ? {} : { failureCode }),
        } as ModuleProcessRecord;
        records.set(processGenerationId, next);
        return next;
      },
    },
    getModuleProcessRecord(processGenerationId) {
      return records.get(processGenerationId);
    },
    appendModuleProcessRecord(record) {
      records.set(record.processGenerationId, record);
      return record;
    },
    updateModuleProcessRecordState(processGenerationId, state) {
      const current = records.get(processGenerationId);
      if (!current) throw new Error(`no record for ${processGenerationId}`);
      const next = { ...current, state } as ModuleProcessRecord;
      records.set(processGenerationId, next);
      return next;
    },
  };
}

function processRecord(): ModuleProcessRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: IDENTITY.instanceId,
    moduleId: IDENTITY.moduleId,
    moduleGenerationId: "module-generation-a",
    processGenerationId: IDENTITY.processGenerationId,
    packageDigest: `sha256:${"0".repeat(64)}`,
    configurationReference: { configId: "config-a", revision: "1", configVersion: 1 },
    declaredExternalEffects: "none",
    serviceInvocationId: "00000000000000000000000000000000",
    bootId: "00000000-0000-0000-0000-000000000000",
    moduleCgroupPath: deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY).filesystemPath,
    state: "starting",
    createdAt: now,
    updatedAt: now,
  };
}

describe("Module launcher control adapter", () => {
  it("lists every launcher failure code", () => {
    expect(everyFailureCodeIsListed).toBe(true);
    expect(new Set(ALL_FAILURE_CODES).size).toBe(ALL_FAILURE_CODES.length);
  });

  it("reports the launcher's process identifier", () => {
    const harness = launcherHarness();
    const control = createModuleLauncherControl({ launcher: harness.launcher });
    expect(control.processId).toBe(LAUNCHER_PROCESS_ID);
  });

  it("resolves without throwing when the launcher reaches execution", async () => {
    const harness = launcherHarness();
    const control = createModuleLauncherControl({ launcher: harness.launcher });

    await expect(control.configure(CONFIGURE)).resolves.toBeUndefined();
    const authorized = control.authorizeExecution(EXECUTION);
    await Promise.resolve();
    reportInCgroup(harness.controllerHarness);
    await expect(authorized).resolves.toMatchObject({
      executionAuthorized: true,
      verifiedProcessIds: [LAUNCHER_PROCESS_ID],
    });
    // Both commands crossed the control descriptor, in order.
    expect(harness.controllerHarness.sent).toHaveLength(2);
    expect(harness.controllerHarness.sent[0]).toContain("configure");
    expect(harness.controllerHarness.sent[1]).toContain("execute");
  });

  it.each(ALL_FAILURE_CODES)("preserves the %s failure outcome", async (code) => {
    const { authorization } = await authorizeAndCapture(code);
    expect(authorization).toMatchObject({
      executionAuthorized: false,
      code,
    });
    if (authorization.executionAuthorized) throw new Error("expected a refusal");
    expect(authorization.detail.length).toBeGreaterThan(0);
  });

  it("carries the controller's observed-exit evidence into requestExit", async () => {
    const { control, harness } = await authorizeAndCapture("LAUNCHER_CONTROL_TIMEOUT");
    // The controller already asked the launcher to exit through the protected
    // descriptor and waited; the adapter reports that evidence rather than
    // asking again.
    expect(harness.controllerHarness.exitObserved).toBe(true);
    await expect(control.requestExit()).resolves.toBe(true);
  });

  it("reports an unobserved exit as unobserved", async () => {
    const harness = launcherHarness();
    harness.controllerHarness.exitObserved = false;
    const control = createModuleLauncherControl({ launcher: harness.launcher });
    await control.configure(CONFIGURE);
    await expect(control.authorizeExecution(EXECUTION)).resolves.toMatchObject({
      executionAuthorized: false,
      launcherExitObserved: false,
    });

    await expect(control.requestExit()).resolves.toBe(false);
  });

  it("refuses to call a launcher exit proof once membership was verified", async () => {
    const harness = launcherHarness();
    const control = createModuleLauncherControl({ launcher: harness.launcher });
    await control.configure(CONFIGURE);
    const authorized = control.authorizeExecution(EXECUTION);
    await Promise.resolve();
    reportInCgroup(harness.controllerHarness);
    await authorized;

    // After membership, ADR 0009 requires whole-group termination and a
    // `populated 0` reading. A launcher exit is no longer evidence, so this
    // must not claim one.
    await expect(control.requestExit()).resolves.toBe(false);
  });

  it("requires control-group proof when authorization fails after membership verification", async () => {
    const harness = launcherHarness();
    const control = createModuleLauncherControl({ launcher: harness.launcher });
    await control.configure(CONFIGURE);
    harness.controllerHarness.membershipReadHook = () => {
      harness.controllerHarness.controller.requestStop();
    };

    const authorized = control.authorizeExecution(EXECUTION);
    await Promise.resolve();
    reportInCgroup(harness.controllerHarness);

    await expect(authorized).resolves.toMatchObject({
      executionAuthorized: false,
      code: "LAUNCHER_STOP_REQUESTED",
      membershipVerified: true,
      observedProcessIds: [LAUNCHER_PROCESS_ID],
      executeCommandMayHaveBeenDelivered: false,
      launcherExitObserved: false,
    });
    // A direct child exit is not a whole-control-group termination proof after
    // membership has been verified, including on this failure path.
    await expect(control.requestExit()).resolves.toBe(false);
  });

  it.each([
    {
      caseName: "a stop after verified membership",
      terminateWhileMembershipIsRead: false,
      coreMustExit: false,
      arrange(harness: LauncherHarness) {
        harness.controllerHarness.membershipReadHook = () => {
          harness.controllerHarness.controller.requestStop();
        };
      },
    },
    {
      caseName: "an extra process observed during membership verification",
      terminateWhileMembershipIsRead: false,
      coreMustExit: false,
      arrange(harness: LauncherHarness) {
        harness.controllerHarness.members = [LAUNCHER_PROCESS_ID, 99];
      },
    },
    {
      caseName: "a termination request while membership is being read",
      terminateWhileMembershipIsRead: true,
      coreMustExit: false,
      arrange(_harness: LauncherHarness) {
        // The test body installs a blocking read so it can call terminate.
      },
    },
    {
      caseName: "execute delivery becomes uncertain",
      terminateWhileMembershipIsRead: false,
      coreMustExit: true,
      arrange(harness: LauncherHarness) {
        harness.controllerHarness.membershipReadHook = () => {
          harness.controllerHarness.failNextSend = true;
        };
      },
    },
  ])("terminates the whole group after $caseName", async ({
    arrange,
    terminateWhileMembershipIsRead,
    coreMustExit,
  }) => {
    const harness = launcherHarness();
    arrange(harness);
    const membershipReadStarted = deferred<void>();
    const allowMembershipRead = deferred<void>();
    if (terminateWhileMembershipIsRead) {
      harness.controllerHarness.membershipReadHook = async () => {
        membershipReadStarted.resolve();
        await allowMembershipRead.promise;
      };
    }
    let populated = "populated 1\nfrozen 0\n";
    const fileSystem = cgroupFileSystem(() => populated);
    const records = recordStore();
    const session: LinuxModuleProtocolSession = {
      initialize: vi.fn(async () => undefined),
      execute: vi.fn(async () => ({ schemaVersion: "dolly.module-result/1" }) as const),
      cancel: vi.fn(async () => undefined),
      closeCapabilitySession: vi.fn(async () => undefined),
      waitForChannelClosed: vi.fn(async () => true),
    };
    const openProtocolSession = vi.fn(() => session);
    const exitStatuses: number[] = [];
    const executor = createLinuxModuleExecutor({
      moduleId: IDENTITY.moduleId,
      moduleGenerationId: "module-generation-a",
      lifecycle: {
        records,
        stoppedRecordWriter: records.stoppedRecordWriter,
        processRecord: processRecord(),
        delegatedRootCgroupPath: DELEGATED_ROOT,
        identity: IDENTITY,
        limits: LIMITS,
        maxOpenFiles: 64,
        startLauncher: async () =>
          createModuleLauncherControl({ launcher: harness.launcher }),
        execution: {
          program: EXECUTION.program,
          argumentVector: EXECUTION.argumentVector,
          environment: EXECUTION.environment,
        },
        cgroupFileSystem: fileSystem,
      },
      openProtocolSession,
      terminationTimeoutMs: 200,
      channelCloseTimeoutMs: 200,
      coreExitCleanupTimeoutMs: 200,
      exitCoreProcess: (status) => exitStatuses.push(status),
    });
    if (executor.start === undefined || executor.terminate === undefined) {
      throw new Error("the Linux Module executor is missing required operations");
    }

    const startOutcome = executor.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(harness.controllerHarness.sent).toHaveLength(1));
    reportInCgroup(harness.controllerHarness);
    let termination: Promise<void> | undefined;
    if (terminateWhileMembershipIsRead) {
      await membershipReadStarted.promise;
      termination = executor.terminate({
        moduleId: IDENTITY.moduleId,
        moduleGenerationId: "module-generation-a",
      });
      populated = "populated 0\nfrozen 0\n";
      allowMembershipRead.resolve();
    }
    const startError = await startOutcome;

    expect(startError).toBeInstanceOf(Error);
    if (coreMustExit) {
      expect(String(startError)).toContain("Core must exit");
      expect(String(startError)).toContain("execute command may have reached");
      expect(exitStatuses).toEqual([1]);
    } else {
      expect(String(startError)).not.toContain("Core must exit");
      expect(exitStatuses).toEqual([]);
    }
    expect(openProtocolSession).not.toHaveBeenCalled();
    expect(records.current?.state).toBe(
      coreMustExit || terminateWhileMembershipIsRead ? "stopping" : "starting",
    );
    expect(
      harness.controllerHarness.sent.some((frame) => frame.includes('"command":"execute"')),
    ).toBe(false);

    populated = "populated 0\nfrozen 0\n";
    termination ??= executor.terminate({
      moduleId: IDENTITY.moduleId,
      moduleGenerationId: "module-generation-a",
    });
    if (coreMustExit) {
      await expect(termination).rejects.toThrowError(/Core must exit/);
    } else {
      await expect(termination).resolves.toBeUndefined();
    }
    expect(
      fileSystem.writeLog.filter(
        ({ path, content }) => path.endsWith("/cgroup.kill") && content === "1",
      ),
    ).toHaveLength(1);
    expect(fileSystem.directories.has(CONFIGURE.moduleCgroupPath)).toBe(coreMustExit);
    expect(records.current?.state).toBe(coreMustExit ? "stopping" : "stopped");
  });

  it("asks through the control descriptor and waits when the sequence never ran", async () => {
    const harness = launcherHarness();
    const control = createModuleLauncherControl({ launcher: harness.launcher });
    await control.configure(CONFIGURE);

    await expect(control.requestExit()).resolves.toBe(true);
    expect(harness.closed.count).toBe(1);
    // No signal is available to this adapter at all; the launcher exits because
    // its control descriptor closed.
    expect(harness.controllerHarness.sent).toHaveLength(0);
  });

  it("reports an exit that cannot be observed after the control descriptor closes", async () => {
    const harness = launcherHarness();
    harness.exitAfterClose = false;
    const control = createModuleLauncherControl({ launcher: harness.launcher });

    await expect(control.requestExit()).resolves.toBe(false);
  });

  it("hands the launcher the control-group filesystem path, not the kernel path", async () => {
    const configured: string[] = [];
    const authorized: string[] = [];
    const control: ModuleLauncherControl = {
      processId: LAUNCHER_PROCESS_ID,
      configure: vi.fn(async (request) => {
        configured.push(request.moduleCgroupPath);
      }),
      authorizeExecution: vi.fn(async (request) => {
        authorized.push(request.moduleCgroupPath);
        return {
          executionAuthorized: true,
          verifiedProcessIds: [LAUNCHER_PROCESS_ID],
        } as const;
      }),
      requestExit: vi.fn(async () => true),
    };

    const derived = deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY);
    const records = recordStore();
    const started = await startModuleProcess({
      records,
      stoppedRecordWriter: records.stoppedRecordWriter,
      processRecord: processRecord(),
      delegatedRootCgroupPath: DELEGATED_ROOT,
      identity: IDENTITY,
      limits: LIMITS,
      maxOpenFiles: 64,
      startLauncher: async () => control,
      execution: {
        program: "/usr/bin/node",
        argumentVector: ["/usr/bin/node", "/opt/extension/main.mjs"],
        environment: {},
      },
      cgroupFileSystem: cgroupFileSystem(),
    });

    expect(started.executionAuthorized).toBe(true);
    // The launcher writes its own process identifier into
    // `<moduleCgroupPath>/cgroup.procs`, so the path has to be the filesystem
    // form. The kernel-relative form would be rejected by the launcher control
    // protocol, and accepting it there would remove that protection.
    expect(configured).toEqual([derived.filesystemPath]);
    expect(authorized).toEqual([derived.filesystemPath]);
    for (const path of [...configured, ...authorized]) {
      expect(path.startsWith("/sys/fs/cgroup/")).toBe(true);
      expect(path).not.toBe(derived.cgroupPath);
    }
  });
});
