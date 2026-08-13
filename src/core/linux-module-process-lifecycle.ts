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
 * Once any control-group member has been observed, stopping terminates the
 * whole group and proves it empty. Before any member is observed, and only
 * while execution authorization is known not to have been delivered, an
 * observed launcher exit followed by a fresh empty-state reading and
 * successful directory removal is sufficient. An uncertain launcher exit or
 * uncertain authorization delivery requires the Core service to exit.
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
import type {
  ModuleProcessRecord,
  ModuleProcessStoppedRecordWriter,
} from "./module-process-records.js";

/** The durable Module process record reads and writes one lifecycle needs. */
export interface ModuleProcessRecordStore {
  /** Returns the store's stable immutable object for the current record version. */
  getModuleProcessRecord(processGenerationId: string): ModuleProcessRecord | undefined;
  appendModuleProcessRecord(record: ModuleProcessRecord): ModuleProcessRecord;
  updateModuleProcessRecordState(
    processGenerationId: string,
    state: "running" | "stopping",
    failureCode?: string,
  ): ModuleProcessRecord;
  /** Optional until the version-2 submission dispatch boundary is composed. */
  markModuleSubmissionSendPossible?(identity: {
    readonly moduleJobId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly moduleGenerationId: string;
  }, processGenerationId: string): unknown;
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
   * Verifies kernel membership and then authorizes `exec`. Expected launcher
   * failures are returned with their kernel observations. Throwing is reserved
   * for a broken adapter contract or another unexpected failure.
   */
  authorizeExecution(request: {
    readonly moduleCgroupPath: string;
    readonly program: string;
    readonly argumentVector: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    /** Read immediately before the launcher controller sends `execute`. */
    readonly stopRequested: () => boolean;
  }): Promise<ModuleLauncherExecutionAuthorization>;
  /** Asks the launcher to exit and waits for its observed exit. */
  requestExit(): Promise<boolean>;
}

/** The kernel evidence and result of one execution-authorization attempt. */
export type ModuleLauncherExecutionAuthorization =
  | {
      /** Delivery of the execute authorization was confirmed. */
      readonly executionAuthorized: true;
      /** The exact process list accepted by kernel membership verification. */
      readonly verifiedProcessIds: readonly number[];
    }
  | {
      /** Execution authorization was not confirmed and cleanup is required. */
      readonly executionAuthorized: false;
      readonly code: string;
      readonly detail: string;
      readonly membershipVerified: boolean;
      /** Every process identifier read from `cgroup.procs` before failure. */
      readonly observedProcessIds: readonly number[];
      /** Whether the `execute` command may have reached the launcher. */
      readonly executeCommandMayHaveBeenDelivered: boolean;
      /** Whether the launcher's exit was observed through its process handle. */
      readonly launcherExitObserved: boolean;
    };

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
   * Whether this Core invocation must exit before recovery can continue. This
   * is required when a launcher may exist outside the prepared control group,
   * or when the remaining state cannot be proved or persisted safely.
   */
  readonly coreMustExit: boolean;
}

export type ModuleProcessStartResult =
  | {
      readonly executionAuthorized: true;
      readonly record: ModuleProcessRecord;
      readonly cgroup: ModuleCgroup;
      /** The exact launcher whose membership and execution authorization were verified. */
      readonly launcher: ModuleLauncherControl;
    }
  | {
      readonly executionAuthorized: false;
      readonly failure: ModuleProcessStartFailure;
      /** Present whenever a prepared group still requires cleanup or proof. */
      readonly cgroup?: ModuleCgroup;
    };

export interface StartModuleProcessOptions {
  readonly records: ModuleProcessRecordStore;
  /** Held only by this proof-owning lifecycle coordinator. */
  readonly stoppedRecordWriter: ModuleProcessStoppedRecordWriter;
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
  coreMustExit: boolean,
): ModuleProcessStartFailure {
  return {
    code: "MODULE_PROCESS_CGROUP_FAILED",
    detail: `${failure.code}: ${failure.detail}`,
    coreMustExit,
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
      executionAuthorized: false,
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
    const failure = cgroupFailure(
      prepared.failure,
      prepared.pathState === "unconfirmed",
    );
    return {
      executionAuthorized: false,
      // A preparation refusal can mean that a pre-existing path was found or
      // that a partially created path could not be removed. Neither is proof
      // that no process remains, so the starting record is retained for
      // startup recovery instead of being declared stopped here.
      failure,
    };
  }
  const cgroup = prepared.cgroup;

  // Step 3. Only the reviewed launcher is started. It joins the prepared group
  // and applies its open-file limit before it can execute anything.
  let launcher: ModuleLauncherControl;
  try {
    launcher = await options.startLauncher();
  } catch (error) {
    return {
      executionAuthorized: false,
      cgroup,
      failure: {
        code: "MODULE_PROCESS_LAUNCHER_FAILED",
        detail: `the child launcher did not return a process handle, but process creation may already have begun: ${describe(error)}`,
        coreMustExit: true,
      },
    };
  }

  try {
    await launcher.configure({
      moduleCgroupPath: cgroup.path,
      maxOpenFiles: options.maxOpenFiles,
    });
  } catch (error) {
    return await finishFailedStartBeforeExecutionAuthorization(
      records,
      options.stoppedRecordWriter,
      identity.processGenerationId,
      cgroup,
      launcher,
      "MODULE_PROCESS_LAUNCHER_FAILED",
      `the launcher did not report control-group membership: ${describe(error)}`,
    );
  }

  if (options.stopRequested?.() === true) {
    return await finishFailedStartBeforeExecutionAuthorization(
      records,
      options.stoppedRecordWriter,
      identity.processGenerationId,
      cgroup,
      launcher,
      "MODULE_PROCESS_STOP_REQUESTED",
      "a stop was requested before the launcher was authorized to execute",
    );
  }

  // Steps 4 and 5. Membership is verified from kernel files inside
  // `authorizeExecution`, which sends `execute` only after that proof.
  let authorization: ModuleLauncherExecutionAuthorization;
  try {
    authorization = await launcher.authorizeExecution({
      moduleCgroupPath: cgroup.path,
      program: options.execution.program,
      argumentVector: options.execution.argumentVector,
      environment: options.execution.environment,
      stopRequested: () => options.stopRequested?.() === true,
    });
  } catch (error) {
    return await finishFailedStartBeforeExecutionAuthorization(
      records,
      options.stoppedRecordWriter,
      identity.processGenerationId,
      cgroup,
      launcher,
      "MODULE_PROCESS_MEMBERSHIP_UNVERIFIED",
      `the launcher's control-group membership was not verified: ${describe(error)}`,
    );
  }

  if (!authorization.executionAuthorized) {
    const code: ModuleProcessStartFailureCode =
      authorization.code === "LAUNCHER_STOP_REQUESTED"
        ? "MODULE_PROCESS_STOP_REQUESTED"
        : authorization.code === "LAUNCHER_MEMBERSHIP_UNVERIFIED"
          ? "MODULE_PROCESS_MEMBERSHIP_UNVERIFIED"
          : "MODULE_PROCESS_LAUNCHER_FAILED";
    const detail = `${authorization.code}: ${authorization.detail}`;
    if (authorization.observedProcessIds.length === 0) {
      if (authorization.executeCommandMayHaveBeenDelivered) {
        return {
          executionAuthorized: false,
          cgroup,
          failure: {
            code,
            detail: `${detail}; the execute command may have reached the launcher, so an observed launcher exit and an empty control group do not prove that no Extension process existed`,
            coreMustExit: true,
          },
        };
      }
      if (authorization.membershipVerified) {
        return {
          executionAuthorized: false,
          cgroup,
          failure: {
            code,
            detail: `${detail}; the launcher adapter reported verified membership without the process list that proved it`,
            coreMustExit: true,
          },
        };
      }
      return await finishFailedStartBeforeExecutionAuthorization(
        records,
        options.stoppedRecordWriter,
        identity.processGenerationId,
        cgroup,
        launcher,
        code,
        detail,
        authorization.launcherExitObserved,
      );
    }

    cgroup.recordObservedProcessIds(authorization.observedProcessIds);
    const launcherCanBeTerminated =
      authorization.observedProcessIds.includes(launcher.processId) ||
      authorization.launcherExitObserved;
    const coreMustExit =
      !launcherCanBeTerminated ||
      authorization.executeCommandMayHaveBeenDelivered;
    const failureDetail = !launcherCanBeTerminated
      ? `${detail}; the launcher was neither observed in the control group nor observed to exit`
      : authorization.executeCommandMayHaveBeenDelivered
        ? `${detail}; the execute command may have reached the launcher before the failure was reported`
        : detail;
    return {
      executionAuthorized: false,
      cgroup,
      failure: {
        code,
        detail: failureDetail,
        coreMustExit,
      },
    };
  }

  const verifiedProcessIds = authorization.verifiedProcessIds;
  if (
    verifiedProcessIds.length !== 1 ||
    verifiedProcessIds[0] !== launcher.processId
  ) {
    if (verifiedProcessIds.length > 0) {
      cgroup.recordObservedProcessIds(verifiedProcessIds);
    }
    return {
      executionAuthorized: false,
      cgroup,
      failure: {
        code: "MODULE_PROCESS_MEMBERSHIP_UNVERIFIED",
        detail: `the launcher adapter confirmed execution without the exact launcher-only process list for ${cgroup.path}; a protocol session was not opened for that invalid result`,
        coreMustExit: true,
      },
    };
  }

  // Protocol authentication and Module initialization have not completed, so
  // the durable record deliberately remains `starting` here. The executor
  // writes `running` only after its protocol session finishes initialization.
  cgroup.recordObservedProcessIds(verifiedProcessIds);
  return { executionAuthorized: true, record, cgroup, launcher };
}

export type ModuleProcessStopResult =
  | { readonly stopped: true; readonly record: ModuleProcessRecord }
  | {
      readonly stopped: false;
      readonly code: string;
      readonly detail: string;
    };

/**
 * Terminates one Module process after the capability session, protocol channel,
 * and whole control group have all reached their required terminal state.
 *
 * The record moves to `stopping` before termination begins, so a Core that
 * dies during the stop leaves the intent visible. It moves to `stopped` only
 * after every supplied condition is confirmed and the proven-empty group
 * directory is removed; an unproven stop or failed removal leaves the record
 * in `stopping` for a later Core invocation to resolve, and never claims
 * success. An existing `stopped` record is not trusted as a substitute for
 * these live observations. If the stopping intent cannot be persisted, the
 * physical stop still runs so the process tree is not left executing, but the
 * operation preserves the directory and refuses to report success.
 */
export async function stopModuleProcess(options: {
  readonly records: ModuleProcessRecordStore;
  /** Held only by this proof-owning lifecycle coordinator. */
  readonly stoppedRecordWriter: ModuleProcessStoppedRecordWriter;
  readonly processGenerationId: string;
  readonly cgroup: ModuleCgroup;
  readonly timeoutMs?: number;
  /**
   * Must synchronously reject new capability calls when invoked, and returns a
   * Promise that resolves after every already-started handler settles.
   */
  readonly closeCapabilitySession: () => Promise<void>;
  /** Resolves true only after the Extension protocol channel is observed closed. */
  readonly waitForChannelClosed: (timeoutMs: number) => Promise<boolean>;
  readonly channelCloseTimeoutMs?: number;
}): Promise<ModuleProcessStopResult> {
  const { records, processGenerationId, cgroup } = options;
  if (cgroup.identity.processGenerationId !== processGenerationId) {
    return {
      stopped: false,
      code: "MODULE_PROCESS_RECORD_STATE_INVALID",
      detail: `the requested process generation ${processGenerationId} does not own control group ${cgroup.path}`,
    };
  }

  let recordFailure: { readonly code: string; readonly detail: string } | undefined;
  try {
    const current = records.getModuleProcessRecord(processGenerationId);
    if (current === undefined) {
      recordFailure = {
        code: "MODULE_PROCESS_RECORD_NOT_FOUND",
        detail: `the Module process record ${processGenerationId} does not exist`,
      };
    } else if (!recordMatchesCgroup(current, processGenerationId, cgroup)) {
      recordFailure = {
        code: "MODULE_PROCESS_RECORD_STATE_INVALID",
        detail: `the Module process record ${processGenerationId} does not match control group ${cgroup.path}`,
      };
    } else if (current.state !== "stopped" && current.state !== "stopping") {
      records.updateModuleProcessRecordState(processGenerationId, "stopping");
    }
  } catch (error) {
    recordFailure = {
      code: "MODULE_PROCESS_RECORD_FAILED",
      detail: `the Module process record ${processGenerationId} could not be marked stopping: ${describe(error)}`,
    };
  }

  // Call capability close before whole-group termination: the call itself must
  // synchronously reject new capability invocations. Then start every remaining
  // condition before awaiting one of them. Neither a rejected close nor a
  // record failure may leave the complete process tree running.
  let capabilityClose: Promise<void>;
  try {
    capabilityClose = options.closeCapabilitySession();
  } catch (error) {
    capabilityClose = Promise.reject(error);
  }
  let channelClose: Promise<boolean>;
  try {
    channelClose = options.waitForChannelClosed(options.channelCloseTimeoutMs ?? 5_000);
  } catch (error) {
    channelClose = Promise.reject(error);
  }
  const launcherExitedBeforeExecutionAuthorization =
    cgroup.launcherExitObservedBeforeExecutionAuthorization &&
    !cgroup.membershipObserved;
  const cgroupTermination =
    cgroup.removed || launcherExitedBeforeExecutionAuthorization
    ? Promise.resolve(undefined)
    : cgroup.terminate(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
  const [terminationOutcome, capabilityOutcome, channelOutcome] = await Promise.allSettled([
    cgroupTermination,
    capabilityClose,
    channelClose,
  ]);

  if (terminationOutcome.status === "rejected") {
    return {
      stopped: false,
      code: "MODULE_CGROUP_TERMINATION_FAILED",
      detail: `the Module control-group termination operation failed: ${describe(terminationOutcome.reason)}`,
    };
  }
  const termination = terminationOutcome.value;
  if (termination !== undefined && !termination.terminated) {
    return { stopped: false, code: termination.code, detail: termination.detail };
  }
  if (capabilityOutcome.status === "rejected") {
    return {
      stopped: false,
      code: "MODULE_CAPABILITY_SESSION_CLOSE_FAILED",
      detail: `the capability session did not close: ${describe(capabilityOutcome.reason)}`,
    };
  }
  if (channelOutcome.status === "rejected" || !channelOutcome.value) {
    return {
      stopped: false,
      code: "MODULE_PROTOCOL_CHANNEL_CLOSE_UNCONFIRMED",
      detail:
        channelOutcome.status === "rejected"
          ? `the Extension protocol channel close check failed: ${describe(channelOutcome.reason)}`
          : "the Extension protocol channel was not observed closed",
    };
  }
  if (recordFailure !== undefined) {
    return { stopped: false, ...recordFailure };
  }

  if (!cgroup.removed) {
    const removal = launcherExitedBeforeExecutionAuthorization
      ? await cgroup.removeAfterLauncherExitBeforeExecutionAuthorization()
      : await cgroup.remove(
          options.timeoutMs === undefined
            ? {}
            : { terminationWaitTimeoutMs: options.timeoutMs },
        );
    if (!removal.removed) {
      return { stopped: false, code: removal.code, detail: removal.detail };
    }
  }
  let finalRecord: ModuleProcessRecord | undefined;
  try {
    finalRecord = records.getModuleProcessRecord(processGenerationId);
  } catch (error) {
    return {
      stopped: false,
      code: "MODULE_PROCESS_RECORD_FAILED",
      detail: `the Module process record ${processGenerationId} could not be read after termination: ${describe(error)}`,
    };
  }
  if (finalRecord === undefined) {
    return {
      stopped: false,
      code: "MODULE_PROCESS_RECORD_NOT_FOUND",
      detail: `the Module process record ${processGenerationId} disappeared before it could be closed`,
    };
  }
  if (!recordMatchesCgroup(finalRecord, processGenerationId, cgroup)) {
    return {
      stopped: false,
      code: "MODULE_PROCESS_RECORD_STATE_INVALID",
      detail: `the Module process record ${processGenerationId} no longer matches control group ${cgroup.path}`,
    };
  }
  if (finalRecord.state === "stopped") return { stopped: true, record: finalRecord };
  if (finalRecord.state !== "stopping") {
    return {
      stopped: false,
      code: "MODULE_PROCESS_RECORD_STATE_INVALID",
      detail: `the Module process record ${processGenerationId} changed to ${finalRecord.state} while it was stopping`,
    };
  }
  try {
    if (!options.stoppedRecordWriter.isBoundTo(finalRecord)) {
      throw new Error(
        "the stopped-record writer is bound to a different lifecycle record store",
      );
    }
    options.stoppedRecordWriter.writeStopped(processGenerationId);
    const record = records.getModuleProcessRecord(processGenerationId);
    if (
      record === undefined ||
      record.state !== "stopped" ||
      !recordMatchesCgroup(record, processGenerationId, cgroup)
    ) {
      throw new Error(
        "the stopped-record writer did not persist the terminal state in the lifecycle record store",
      );
    }
    return { stopped: true, record };
  } catch (error) {
    return {
      stopped: false,
      code: "MODULE_PROCESS_RECORD_FAILED",
      detail: `the Module process record ${processGenerationId} could not be marked stopped: ${describe(error)}`,
    };
  }
}

function recordMatchesCgroup(
  record: ModuleProcessRecord,
  processGenerationId: string,
  cgroup: ModuleCgroup,
): boolean {
  return (
    record.processGenerationId === processGenerationId &&
    record.instanceId === cgroup.identity.instanceId &&
    record.moduleId === cgroup.identity.moduleId &&
    record.moduleCgroupPath === cgroup.path
  );
}

/**
 * Finishes a failed start before execution authorization was confirmed.
 *
 * After the launcher's exit is observed, a fresh empty-group reading and
 * successful directory removal are both required before the record can be
 * marked stopped. If a process is observed, the prepared group is returned so
 * the executor can terminate the whole group. Core never signals a process
 * identifier directly.
 */
async function finishFailedStartBeforeExecutionAuthorization(
  records: ModuleProcessRecordStore,
  stoppedRecordWriter: ModuleProcessStoppedRecordWriter,
  processGenerationId: string,
  cgroup: ModuleCgroup,
  launcher: ModuleLauncherControl,
  code: ModuleProcessStartFailureCode,
  detail: string,
  knownLauncherExitObserved?: boolean,
): Promise<ModuleProcessStartResult> {
  let launcherExitObserved = knownLauncherExitObserved;
  if (launcherExitObserved === undefined) {
    try {
      launcherExitObserved = await launcher.requestExit();
    } catch {
      launcherExitObserved = false;
    }
  }
  if (!launcherExitObserved) {
    return {
      executionAuthorized: false,
      cgroup,
      failure: {
        code,
        detail: `${detail}; the launcher's exit could not be observed`,
        coreMustExit: true,
      },
    };
  }

  const removal = await cgroup.removeAfterLauncherExitBeforeExecutionAuthorization();
  if (removal.removed) {
    const stoppedPersisted = markStopped(
      records,
      stoppedRecordWriter,
      processGenerationId,
      code,
    );
    return {
      executionAuthorized: false,
      failure: {
        code,
        detail: stoppedPersisted
          ? detail
          : `${detail}; the empty control group was removed but the stopped process record could not be persisted`,
        coreMustExit: !stoppedPersisted,
      },
    };
  }

  const cleanupCanBeRetried =
    cgroup.membershipObserved ||
    cgroup.launcherExitObservedBeforeExecutionAuthorization;
  return {
    executionAuthorized: false,
    cgroup,
    failure: {
      code,
      detail: `${detail}; ${removal.detail}`,
      coreMustExit: !cleanupCanBeRetried,
    },
  };
}

/**
 * Records a stopped state after the launcher exited before execution
 * authorization and the freshly observed empty group was removed. The return
 * value prevents a caller from treating a failed durable write as completed
 * cleanup.
 */
function markStopped(
  records: ModuleProcessRecordStore,
  stoppedRecordWriter: ModuleProcessStoppedRecordWriter,
  processGenerationId: string,
  failureCode: string,
): boolean {
  try {
    const record = records.getModuleProcessRecord(processGenerationId);
    if (record === undefined || !stoppedRecordWriter.isBoundTo(record)) {
      return false;
    }
    stoppedRecordWriter.writeStopped(processGenerationId, failureCode);
    return records.getModuleProcessRecord(processGenerationId)?.state === "stopped";
  } catch {
    // Left in its current state; recovery re-proves it before reuse.
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
