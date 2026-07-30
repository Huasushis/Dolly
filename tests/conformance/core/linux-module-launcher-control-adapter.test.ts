/**
 * The adapter between the shipped launcher controller and the
 * `ModuleLauncherControl` shape the ordered Module process start is written
 * against, and the control-group path form that start hands to the launcher.
 *
 * This file covers the two contracts that connect the ordered Module start to
 * the launcher. Both now have product implementations.
 *
 * 1. `LinuxModuleLauncherController` runs the whole pre-execution sequence in
 *    one `authorizeExecution` call, reports failure as a returned outcome
 *    rather than by throwing, and exposes neither `processId` nor
 *    `requestExit`. The conversion from that outcome to the exception
 *    `startModuleProcess` expects has to be total: a failure variant nobody
 *    mapped would return normally and be indistinguishable from success, which
 *    is the failure direction Architecture Decision Record 0009 rejects
 *    everywhere else.
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
import type { ModuleProcessRecord } from "../../../src/core/module-process-records.js";

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
  membershipReadHook: (() => void) | undefined;
  exitObserved: boolean;
  readonly channel: LinuxModuleLauncherControlChannel;
}

function controllerHarness(): ControllerHarness {
  const sent: string[] = [];
  const state = {
    failNextSend: false,
    members: [LAUNCHER_PROCESS_ID] as number[],
    membershipReadHook: undefined as (() => void) | undefined,
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
      state.membershipReadHook?.();
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
    set membershipReadHook(value: (() => void) | undefined) {
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

const CONFIGURE = {
  moduleCgroupPath: deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY).filesystemPath,
  maxOpenFiles: 64,
} as const;

const EXECUTION = {
  moduleCgroupPath: CONFIGURE.moduleCgroupPath,
  program: "/usr/bin/node",
  argumentVector: ["/usr/bin/node", "/opt/extension/main.mjs"],
  environment: {},
} as const;

/**
 * Drives one failure code out of the real controller, then reports what the
 * adapter did with it.
 */
async function authorizeAndCapture(
  code: LinuxModuleLauncherFailureCode,
): Promise<{ control: ModuleLauncherControl; error: unknown; harness: LauncherHarness }> {
  const harness = launcherHarness();
  const control = createModuleLauncherControl({ launcher: harness.launcher });
  await control.configure(CONFIGURE);

  if (code === "LAUNCHER_CONTROL_SEND_FAILED") harness.controllerHarness.failNextSend = true;
  if (code === "LAUNCHER_STOP_REQUESTED") harness.controllerHarness.controller.requestStop();
  if (code === "LAUNCHER_MEMBERSHIP_UNVERIFIED") harness.controllerHarness.members = [];

  const authorized = control.authorizeExecution(EXECUTION).then(
    () => undefined,
    (error: unknown) => error,
  );

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

  return { control, error: await authorized, harness };
}

/** An in-memory control-group filesystem sufficient for `prepareModuleCgroup`. */
function cgroupFileSystem(): ModuleCgroupFileSystem {
  const files = new Map<string, string>();
  return {
    async readTextFile(path) {
      if (path.endsWith("/cgroup.events")) return "populated 0\nfrozen 0\n";
      const value = files.get(path);
      if (value === undefined) throw new Error(`${path} does not exist`);
      return value;
    },
    async writeTextFile(path, content) {
      files.set(path, content);
    },
    async createDirectory() {
      // The directory is implied by the files written into it.
    },
    async removeDirectory() {
      // Nothing to remove in memory.
    },
    async listChildDirectoryNames() {
      return [];
    },
    async directoryExists() {
      return true;
    },
    async writableFileExists() {
      return true;
    },
  };
}

function recordStore(): ModuleProcessRecordStore {
  const records = new Map<string, ModuleProcessRecord>();
  return {
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
    await expect(authorized).resolves.toBeUndefined();
    // Both commands crossed the control descriptor, in order.
    expect(harness.controllerHarness.sent).toHaveLength(2);
    expect(harness.controllerHarness.sent[0]).toContain("configure");
    expect(harness.controllerHarness.sent[1]).toContain("execute");
  });

  it.each(ALL_FAILURE_CODES)("turns the %s outcome into a thrown failure", async (code) => {
    const { error } = await authorizeAndCapture(code);
    // The conversion must be total. A code nobody mapped would resolve, and the
    // ordered start would treat it as an authorized execution.
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code });
    expect(String((error as Error).message)).toContain(code);
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
    await expect(control.authorizeExecution(EXECUTION)).rejects.toBeInstanceOf(Error);

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

    await expect(authorized).rejects.toMatchObject({
      code: "LAUNCHER_STOP_REQUESTED",
      membershipVerified: true,
      launcherExitObserved: false,
    });
    // A direct child exit is not a whole-control-group termination proof after
    // membership has been verified, including on this failure path.
    await expect(control.requestExit()).resolves.toBe(false);
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
      }),
      requestExit: vi.fn(async () => true),
    };

    const derived = deriveModuleCgroupPath(DELEGATED_ROOT, IDENTITY);
    const started = await startModuleProcess({
      records: recordStore(),
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

    expect(started.started).toBe(true);
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
