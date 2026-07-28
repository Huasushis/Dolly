/**
 * Orders the steps that start and stop one Linux Module process.
 *
 * Every individual mechanism this file uses is implemented and tested
 * elsewhere: the durable Module process record, the Module control group and
 * its whole-group termination, the reviewed child launcher and its control
 * protocol, and the Core service binding. What was missing is the one place
 * that performs them in the order Architecture Decision Record 0009 requires
 * and refuses to continue when any step cannot be proven.
 *
 * The start order is fixed and is the point of this file:
 *
 *   1. allocate the non-reused process generation and persist its process
 *      record, before any child exists, so a Core that dies here leaves
 *      evidence that a child may have been created;
 *   2. prepare the Module control group and read back every limit, so a group
 *      that cannot enforce its limits never receives a process;
 *   3. start the reviewed launcher, which joins that group and applies its
 *      open-file limit before it can execute anything;
 *   4. verify the launcher's membership from kernel control-group files, not
 *      from the launcher's own report; and
 *   5. only then authorize the launcher to replace itself with the Extension.
 *
 * Stopping is equally fixed: terminate the whole control group and prove it
 * empty. A direct child exit is never that proof once membership is verified.
 *
 * This module starts no Module by itself and is not wired into runtime
 * startup. `runtime-bootstrap.ts` still rejects every configured Module; that
 * guard is removed only when ADR 0009 becomes `Accepted`.
 */

import {
  ModuleCgroup,
  prepareModuleCgroup,
  type ModuleCgroupFailure,
  type ModuleCgroupIdentity,
  type ModuleCgroupLimits,
  type ModuleCgroupFileSystem,
} from "./linux-module-cgroup.js";
import type { ModuleProcessRecord } from "./module-process-records.js";

/** The durable record operations one Module process lifecycle needs. */
export interface ModuleProcessRecordWriter {
  appendModuleProcessRecord(record: ModuleProcessRecord): ModuleProcessRecord;
  updateModuleProcessRecordState(
    processGenerationId: string,
    state: "starting" | "running" | "stopping" | "stopped",
    failureCode?: string,
  ): ModuleProcessRecord;
}

/**
 * The launcher control operations, named so this file does not depend on the
 * adapter that implements them. The product implementation is
 * `createModuleLauncherControl`; keeping this interface here leaves the
 * ordered lifecycle independent of launcher construction.
 */
export interface ModuleLauncherControl {
  /** The launcher process identifier, used only to verify membership. */
  readonly processId: number;
  /**
   * Supplies the Module control group the launcher must join and the open-file
   * limit it must apply to itself.
   *
   * `moduleCgroupPath` is the group's path in the control-group filesystem,
   * below the cgroup version 2 mount point, not the kernel-relative form. The
   * launcher writes its own process identifier into `<path>/cgroup.procs`, and
   * its control protocol rejects any path outside that filesystem so that a
   * wrong path cannot redirect that write. An implementation must never widen
   * that check by converting one form into the other.
   *
   * An implementation whose control protocol performs configuration and
   * execution authorization in one exchange may defer the exchange to
   * `authorizeExecution`. What it must never do is authorize execution before
   * the caller's stop check below, or before membership is verified from
   * kernel files.
   */
  configure(request: {
    readonly moduleCgroupPath: string;
    readonly maxOpenFiles: number;
  }): Promise<void>;
  /**
   * Verifies kernel membership and then authorizes `exec`. It rejects when the
   * launcher was not authorized, for any reason; resolving means the execute
   * authorization was sent.
   */
  authorizeExecution(request: {
    readonly moduleCgroupPath: string;
    readonly program: string;
    readonly argumentVector: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
  }): Promise<void>;
  /** Asks the launcher to exit and waits for its observed exit. */
  requestExit(): Promise<boolean>;
}

export type ModuleProcessStartFailureCode =
  | "MODULE_PROCESS_RECORD_FAILED"
  | "MODULE_PROCESS_CGROUP_FAILED"
  | "MODULE_PROCESS_LAUNCHER_FAILED"
  | "MODULE_PROCESS_MEMBERSHIP_UNVERIFIED"
  | "MODULE_PROCESS_STOP_REQUESTED";

export interface ModuleProcessStartFailure {
  readonly code: ModuleProcessStartFailureCode;
  readonly detail: string;
  /**
   * Whether the launcher was left running with no proof that it stopped. ADR
   * 0009 requires Core to exit in that case and let the Core service's own
   * cleanup remove the whole service control group, because there is no safe
   * way to address the launcher without its control channel.
   */
  readonly coreMustExit: boolean;
}

export type ModuleProcessStartResult =
  | {
      readonly started: true;
      readonly record: ModuleProcessRecord;
      readonly cgroup: ModuleCgroup;
    }
  | { readonly started: false; readonly failure: ModuleProcessStartFailure };

export interface StartModuleProcessOptions {
  readonly records: ModuleProcessRecordWriter;
  /** The record to persist before any child exists. Its state must be `starting`. */
  readonly processRecord: ModuleProcessRecord;
  readonly delegatedRootCgroupPath: string;
  readonly identity: ModuleCgroupIdentity;
  readonly limits: ModuleCgroupLimits;
  /**
   * The open-file limit the launcher applies to itself before it can execute
   * anything. It is not a control-group limit: `RLIMIT_NOFILE` is a per-process
   * resource limit, so only the launcher can set it, and it must be set before
   * the `exec` that replaces the launcher with the Extension.
   */
  readonly maxOpenFiles: number;
  /** Creates the launcher only after the control group is prepared. */
  readonly startLauncher: () => Promise<ModuleLauncherControl>;
  /** The exact installed entry point and its closed argument and environment. */
  readonly execution: {
    readonly program: string;
    readonly argumentVector: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
  };
  /** Reports a stop requested while the launcher is still pre-membership. */
  readonly stopRequested?: () => boolean;
  readonly cgroupFileSystem?: ModuleCgroupFileSystem;
}

function cgroupFailure(
  failure: ModuleCgroupFailure,
): ModuleProcessStartFailure {
  return {
    code: "MODULE_PROCESS_CGROUP_FAILED",
    detail: `${failure.code}: ${failure.detail}`,
    coreMustExit: false,
  };
}

/**
 * Starts one Module process, or fails without leaving an unaccounted process.
 *
 * The record is persisted first and is left in place on every failure: it is
 * the evidence a later Core invocation uses to decide whether a child may have
 * existed. Nothing here signals a process identifier.
 */
export async function startModuleProcess(
  options: StartModuleProcessOptions,
): Promise<ModuleProcessStartResult> {
  const { records, identity } = options;

  // Step 1. The process generation becomes durable before any child exists.
  let record: ModuleProcessRecord;
  try {
    record = records.appendModuleProcessRecord(options.processRecord);
  } catch (error) {
    return {
      started: false,
      failure: {
        code: "MODULE_PROCESS_RECORD_FAILED",
        detail: `the Module process record could not be persisted: ${describe(error)}`,
        coreMustExit: false,
      },
    };
  }

  // Step 2. The control group must be able to enforce its limits before a
  // process joins it, so every limit is written and read back here.
  const prepared = await prepareModuleCgroup({
    delegatedRootCgroupPath: options.delegatedRootCgroupPath,
    identity,
    limits: options.limits,
    ...(options.cgroupFileSystem === undefined
      ? {}
      : { fileSystem: options.cgroupFileSystem }),
  });
  if (!prepared.prepared) {
    markStopped(records, identity.processGenerationId, prepared.failure.code);
    return { started: false, failure: cgroupFailure(prepared.failure) };
  }
  const cgroup = prepared.cgroup;

  // Step 3. Only the reviewed launcher is started. It joins the prepared group
  // and applies its open-file limit before it can execute anything.
  let launcher: ModuleLauncherControl;
  try {
    launcher = await options.startLauncher();
  } catch (error) {
    markStopped(records, identity.processGenerationId, "LAUNCHER_START_FAILED");
    return {
      started: false,
      failure: {
        code: "MODULE_PROCESS_LAUNCHER_FAILED",
        detail: `the child launcher could not be started: ${describe(error)}`,
        coreMustExit: false,
      },
    };
  }

  try {
    await launcher.configure({
      moduleCgroupPath: cgroup.path,
      maxOpenFiles: options.maxOpenFiles,
    });
  } catch (error) {
    return await abandonPreMembership(
      records,
      identity.processGenerationId,
      launcher,
      "MODULE_PROCESS_LAUNCHER_FAILED",
      `the launcher did not report control-group membership: ${describe(error)}`,
    );
  }

  if (options.stopRequested?.() === true) {
    return await abandonPreMembership(
      records,
      identity.processGenerationId,
      launcher,
      "MODULE_PROCESS_STOP_REQUESTED",
      "a stop was requested before the launcher was authorized to execute",
    );
  }

  // Steps 4 and 5. Membership is verified from kernel files inside
  // `authorizeExecution`, which sends `execute` only after that proof.
  try {
    await launcher.authorizeExecution({
      moduleCgroupPath: cgroup.path,
      program: options.execution.program,
      argumentVector: options.execution.argumentVector,
      environment: options.execution.environment,
    });
  } catch (error) {
    return await abandonPreMembership(
      records,
      identity.processGenerationId,
      launcher,
      "MODULE_PROCESS_MEMBERSHIP_UNVERIFIED",
      `the launcher's control-group membership was not verified: ${describe(error)}`,
    );
  }

  // The launcher's process identifier is now inside the group, so the group is
  // the unit of termination from here on.
  cgroup.recordVerifiedMembership([launcher.processId]);
  const running = records.updateModuleProcessRecordState(
    identity.processGenerationId,
    "running",
  );
  return { started: true, record: running, cgroup };
}

export type ModuleProcessStopResult =
  | { readonly stopped: true; readonly record: ModuleProcessRecord }
  | {
      readonly stopped: false;
      readonly code: string;
      readonly detail: string;
    };

/**
 * Terminates one Module process by terminating its whole control group and
 * proving the group empty.
 *
 * The record moves to `stopping` before termination begins, so a Core that
 * dies during the stop leaves the intent visible. It moves to `stopped` only
 * after the group is proven empty; an unproven stop leaves the record in
 * `stopping` for a later Core invocation to resolve, and never claims success.
 */
export async function stopModuleProcess(options: {
  readonly records: ModuleProcessRecordWriter;
  readonly processGenerationId: string;
  readonly cgroup: ModuleCgroup;
  readonly timeoutMs?: number;
}): Promise<ModuleProcessStopResult> {
  const { records, processGenerationId, cgroup } = options;
  records.updateModuleProcessRecordState(processGenerationId, "stopping");
  const termination = await cgroup.terminate(
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  if (!termination.terminated) {
    return {
      stopped: false,
      code: termination.code,
      detail: termination.detail,
    };
  }
  const record = records.updateModuleProcessRecordState(
    processGenerationId,
    "stopped",
  );
  return { stopped: true, record };
}

/**
 * Gives up before membership was verified.
 *
 * The launcher has not been authorized to execute anything, so asking it to
 * exit through its control channel is the whole cleanup. When that exit cannot
 * be observed, the launcher may still be running outside a group Core can
 * terminate, so Core must exit and let its service's cleanup remove the whole
 * service control group. Core never signals a process identifier instead.
 */
async function abandonPreMembership(
  records: ModuleProcessRecordWriter,
  processGenerationId: string,
  launcher: ModuleLauncherControl,
  code: ModuleProcessStartFailureCode,
  detail: string,
): Promise<ModuleProcessStartResult> {
  let exited = false;
  try {
    exited = await launcher.requestExit();
  } catch {
    exited = false;
  }
  if (exited) {
    markStopped(records, processGenerationId, code);
    return { started: false, failure: { code, detail, coreMustExit: false } };
  }
  return {
    started: false,
    failure: {
      code,
      detail: `${detail}; the launcher's exit could not be observed`,
      coreMustExit: true,
    },
  };
}

/**
 * Records a stop that needs no group proof because no process ever joined the
 * group. A failure to write it is deliberately not escalated: the caller is
 * already reporting a start failure, and the record's current state is still a
 * safe, conservative view for a later Core invocation.
 */
function markStopped(
  records: ModuleProcessRecordWriter,
  processGenerationId: string,
  failureCode: string,
): void {
  try {
    records.updateModuleProcessRecordState(
      processGenerationId,
      "stopped",
      failureCode,
    );
  } catch {
    // Left in its current state; recovery re-proves it before reuse.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
