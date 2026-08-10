/**
 * The Linux Module executor: the same `ModuleExecutor` interface the reactive
 * runtime already uses, but with the Architecture Decision Record 0009 process
 * ownership rules substituted for direct child-process handling.
 *
 * The portable adapter in `extension-process-module-executor.ts` treats a
 * confirmed child exit as proof that a Module stopped. That is sound only
 * while the Core process that created the child is alive and the Extension
 * created no descendants. On Linux neither holds, so this executor:
 *
 * - starts the process through the reviewed launcher and the ordered lifecycle
 *   in `linux-module-process-lifecycle.ts`, which persists the process record
 *   before any child exists and verifies control-group membership from kernel
 *   files before the Extension may execute; and
 * - terminates by synchronously closing the capability session, then starts
 *   whole-group termination and protocol-channel observation; confirmation
 *   waits for terminal handlers, an empty group, and a closed channel rather
 *   than treating a signal to one child as proof.
 *
 * `terminate()` resolves only when every part of that proof holds. Anything
 * else raises `ModuleExecutorTerminationUnconfirmedError`, which the reactive
 * runtime already treats as "preserve the Claim, start no replacement".
 *
 * This executor is not wired into runtime startup. `runtime-bootstrap.ts`
 * still rejects every configured Module; that guard is removed only when ADR
 * 0009 becomes `Accepted`.
 */

import {
  ModuleExecutorTerminationUnconfirmedError,
  type ModuleCancellationContext,
  type ModuleExecutor,
  type ModuleRunContext,
} from "../core/module-actor.js";
import type {
  ReactiveModuleInput,
  ReactiveModuleResult,
} from "../core/reactive-module-runtime.js";
import {
  startModuleProcess,
  stopModuleProcess,
  type ModuleProcessStartFailure,
  type ModuleProcessStartResult,
  type StartModuleProcessOptions,
} from "../core/linux-module-process-lifecycle.js";
import type { ModuleCgroup } from "../core/linux-module-cgroup.js";

const DEFAULT_CORE_EXIT_CLEANUP_TIMEOUT_MS = 1_000;

/**
 * The Extension protocol operations this executor needs, named here so the
 * executor does not depend on the process host's construction details.
 *
 * `ExtensionProcessHost` can now be built over the standard streams of a
 * launcher child that Core already started, through the `attachedProcess`
 * option described in Architecture Decision Record 0009 under "Attaching the
 * protocol transport to the launcher child".
 *
 * `attachLinuxModuleProcess` turns a started launcher and its verified Module
 * control group into an `AttachedExtensionProcess`; it also owns whole-group
 * termination because the host cannot enforce how an attachment terminates.
 * This executor passes the exact authorized launcher, control group, and
 * durable starting record to `openProtocolSession`; the caller no longer has
 * to reconstruct or guess any of those lifecycle identities. No runtime
 * startup caller currently assembles the complete host path end to end.
 */
export interface LinuxModuleProtocolSession {
  /** Completes the authenticated handshake and Module creation. */
  initialize(): Promise<void>;
  execute(request: {
    readonly moduleJobId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly hasMore: boolean;
    readonly input: ReactiveModuleInput;
  }): Promise<ReactiveModuleResult>;
  cancel(runId: string, reason: string): Promise<void>;
  /**
   * The call synchronously rejects new capability invocations, revokes every
   * handle, and delivers an abort signal. Its Promise resolves once every
   * already-started handler is terminal. ADR 0009 requires both parts before a
   * Claim may be classified.
   */
  closeCapabilitySession(): Promise<void>;
  /** Resolves once the protocol channel is observed closed. */
  waitForChannelClosed(timeoutMs: number): Promise<boolean>;
}

export type LinuxModuleAuthorizedProcess = Extract<
  ModuleProcessStartResult,
  { readonly executionAuthorized: true }
>;

export interface LinuxModuleExecutorOptions {
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  /** Everything the ordered start needs, minus the record writer's identity. */
  readonly lifecycle: Omit<StartModuleProcessOptions, "startLauncher"> & {
    readonly startLauncher: StartModuleProcessOptions["startLauncher"];
  };
  /**
   * Attaches the Extension protocol to the started launcher's streams and
   * synchronously returns the session handle. Authentication and Module
   * initialization belong to `initialize()`. If attachment fails, this call
   * must throw before it creates capability state that would need closing.
   */
  readonly openProtocolSession: (
    process: LinuxModuleAuthorizedProcess,
  ) => LinuxModuleProtocolSession;
  /** Bound on the whole-group termination proof. */
  readonly terminationTimeoutMs: number;
  /** Bound on observing the protocol channel closed after termination. */
  readonly channelCloseTimeoutMs: number;
  /**
   * The longest Core waits for best-effort cleanup before ending itself after
   * a launcher failure that cannot prove process ownership. This bound is
   * separate from normal termination because process exit is required even
   * when a control-group file operation never settles.
   */
  readonly coreExitCleanupTimeoutMs?: number;
  /**
   * Immediately ends the current Core process with the supplied status.
   * Production uses `process.exit`; tests inject a returning function so they
   * can inspect the failure path without ending the test process.
   */
  readonly exitCoreProcess?: (status: number) => void;
}

function assertCoreExitCleanupTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError(
      "coreExitCleanupTimeoutMs must be an integer between 1 and 60000",
    );
  }
}

function assertPositiveSafeIntegerTimeout(
  optionName: "terminationTimeoutMs" | "channelCloseTimeoutMs",
  timeoutMs: number,
): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError(`${optionName} must be a positive safe integer`);
  }
}

/**
 * Waits only until the cleanup deadline. The cleanup Promise keeps running
 * after that deadline, but its rejection is consumed because Core exits
 * immediately afterwards and cannot use its result as termination proof.
 */
async function waitForBestEffortCleanup(
  cleanup: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settledCleanup = cleanup.then(
    () => undefined,
    () => undefined,
  );
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([settledCleanup, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertContext(
  context: { readonly moduleGenerationId: string },
  moduleGenerationId: string,
): void {
  if (context.moduleGenerationId !== moduleGenerationId) {
    throw new Error(
      "Module execution context does not match this Linux Module executor's generation",
    );
  }
}

/**
 * Builds one Linux Module executor. Nothing is created here: process creation
 * belongs to `start()`, so the runtime holds a terminable handle first.
 */
export function createLinuxModuleExecutor(
  options: LinuxModuleExecutorOptions,
): ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult> {
  assertPositiveSafeIntegerTimeout(
    "terminationTimeoutMs",
    options.terminationTimeoutMs,
  );
  assertPositiveSafeIntegerTimeout(
    "channelCloseTimeoutMs",
    options.channelCloseTimeoutMs,
  );
  const coreExitCleanupTimeoutMs =
    options.coreExitCleanupTimeoutMs ?? DEFAULT_CORE_EXIT_CLEANUP_TIMEOUT_MS;
  assertCoreExitCleanupTimeout(coreExitCleanupTimeoutMs);
  const exitCoreProcess = options.exitCoreProcess ?? ((status: number) => process.exit(status));
  let session: LinuxModuleProtocolSession | undefined;
  let processStart: Promise<ModuleProcessStartResult> | undefined;
  let startOperation: Promise<void> | undefined;
  let startCompleted = false;
  let terminationRequested = false;
  let terminationConfirmed = false;
  let terminationOperation: Promise<void> | undefined;
  let coreExitOperation: Promise<void> | undefined;
  let sessionReported = false;
  let protocolSessionOpenFailed = false;
  let protocolSessionOpenError: unknown;
  let reportSession!: (session: LinuxModuleProtocolSession | undefined) => void;
  const sessionAvailable = new Promise<LinuxModuleProtocolSession | undefined>((resolve) => {
    reportSession = resolve;
  });

  const setAvailableSession = (available: LinuxModuleProtocolSession | undefined): void => {
    if (sessionReported) return;
    sessionReported = true;
    reportSession(available);
  };

  /**
   * Preserves the durable `stopping` intent and starts whole-group cleanup
   * when members were observed. Neither operation can prove recovery in this
   * failure mode, so both are bounded and followed by a nonzero Core exit.
   */
  const exitCoreAfterUnconfirmedProcessOwnership = (
    detail: string,
    failureCode: string | undefined,
    cgroup: ModuleCgroup | undefined,
  ): Promise<void> => {
    if (coreExitOperation !== undefined) return coreExitOperation;

    let rejectExitOperation!: (reason: unknown) => void;
    const operation = new Promise<void>((_resolve, reject) => {
      rejectExitOperation = reject;
    });
    // Store the operation before invoking the exit hook. A test hook can
    // synchronously re-enter `terminate()`, while `process.exit` never
    // returns in production.
    coreExitOperation = operation;
    terminationRequested = true;

    void (async (): Promise<void> => {
      try {
        try {
          options.lifecycle.records.updateModuleProcessRecordState(
            options.lifecycle.identity.processGenerationId,
            "stopping",
          );
        } catch {
          // The exit remains required even when the durable intent is lost.
        }

        if (cgroup?.membershipObserved && !cgroup.removed) {
          const cleanup = cgroup.terminate({
            timeoutMs: Math.min(options.terminationTimeoutMs, coreExitCleanupTimeoutMs),
          });
          await waitForBestEffortCleanup(cleanup, coreExitCleanupTimeoutMs);
        }

        exitCoreProcess(1);
        rejectExitOperation(
          new ModuleExecutorTerminationUnconfirmedError(
            `${failureCode === undefined ? detail : `${failureCode}: ${detail}`}; Core must exit, but the configured Core exit function returned without ending the process`,
          ),
        );
      } catch (error) {
        rejectExitOperation(
          new ModuleExecutorTerminationUnconfirmedError(
            `${failureCode === undefined ? detail : `${failureCode}: ${detail}`}; Core must exit, but the configured Core exit function failed: ${describe(error)}`,
          ),
        );
      }
    })();
    return operation;
  };

  const start = (): Promise<void> => {
    if (startOperation !== undefined) return startOperation;
    if (terminationRequested) {
      return Promise.reject(
        new Error("The Linux Module executor cannot start after termination was requested"),
      );
    }

    const configuredStopRequested = options.lifecycle.stopRequested;
    processStart = startModuleProcess({
      ...options.lifecycle,
      stopRequested: () =>
        terminationRequested || configuredStopRequested?.() === true,
    });
    const currentProcessStart = processStart;
    startOperation = (async (): Promise<void> => {
      let started: ModuleProcessStartResult;
      try {
        started = await currentProcessStart;
      } catch (error) {
        setAvailableSession(undefined);
        return await exitCoreAfterUnconfirmedProcessOwnership(
          `the Module process start failed without returning its process ownership state: ${describe(error)}`,
          undefined,
          undefined,
        );
      }
      if (!started.executionAuthorized) {
        setAvailableSession(undefined);
        if (started.failure.coreMustExit) {
          return await exitCoreAfterUnconfirmedProcessOwnership(
            started.failure.detail,
            started.failure.code,
            started.cgroup,
          );
        }
        throw startFailureError(started.failure);
      }
      let opened: LinuxModuleProtocolSession;
      try {
        opened = options.openProtocolSession(started);
      } catch (error) {
        protocolSessionOpenFailed = true;
        protocolSessionOpenError = error;
        setAvailableSession(undefined);
        throw error;
      }
      session = opened;
      setAvailableSession(opened);
      if (terminationRequested) {
        throw new Error(
          "The Linux Module executor was asked to terminate before protocol initialization",
        );
      }
      await opened.initialize();
      if (terminationRequested) {
        throw new Error(
          "The Linux Module executor was asked to terminate during protocol initialization",
        );
      }
      options.lifecycle.records.updateModuleProcessRecordState(
        options.lifecycle.identity.processGenerationId,
        "running",
      );
      if (terminationRequested) {
        throw new Error(
          "The Linux Module executor was asked to terminate while its running state was persisted",
        );
      }
      startCompleted = true;
    })();
    return startOperation;
  };

  const performTermination = async (): Promise<void> => {
    const currentProcessStart = processStart;
    if (currentProcessStart === undefined) return;

    let started: ModuleProcessStartResult;
    try {
      started = await currentProcessStart;
    } catch (error) {
      return await exitCoreAfterUnconfirmedProcessOwnership(
        `the Module process start failed without returning its process ownership state: ${describe(error)}`,
        undefined,
        undefined,
      );
    }
    let cgroup;
    if (!started.executionAuthorized) {
      if (started.failure.coreMustExit) {
        return await exitCoreAfterUnconfirmedProcessOwnership(
          started.failure.detail,
          started.failure.code,
          started.cgroup,
        );
      }
      if (started.cgroup === undefined) return;
      cgroup = started.cgroup;
    } else {
      cgroup = started.cgroup;
    }

    const executionAuthorized = started.executionAuthorized;
    // Once the launcher has been authorized, opening the protocol session may
    // create capability state. Wait until that attempt finishes so a late
    // session cannot appear after whole-group termination has already begun.
    // A failed authorization never opens an Extension protocol session.
    const availableSession = executionAuthorized
      ? await sessionAvailable
      : undefined;
    let stopped;
    try {
      stopped = await stopModuleProcess({
        records: options.lifecycle.records,
        stoppedRecordWriter: options.lifecycle.stoppedRecordWriter,
        processGenerationId: options.lifecycle.identity.processGenerationId,
        cgroup,
        timeoutMs: options.terminationTimeoutMs,
        closeCapabilitySession: () => {
          if (!executionAuthorized) return Promise.resolve();
          if (!availableSession) {
            const detail = protocolSessionOpenFailed
              ? `: ${describe(protocolSessionOpenError)}`
              : " after the Module process was started";
            return Promise.reject(
              new Error(`the Extension protocol session was not available${detail}`),
            );
          }
          // The close call synchronously rejects new capability invocations.
          // Invoke it before stopModuleProcess can write cgroup.kill; only its
          // returned Promise waits for already-started handlers to finish.
          return availableSession.closeCapabilitySession();
        },
        waitForChannelClosed: (timeoutMs) => {
          if (!executionAuthorized) return Promise.resolve(true);
          return availableSession
            ? availableSession.waitForChannelClosed(timeoutMs)
            : Promise.resolve(false);
        },
        channelCloseTimeoutMs: options.channelCloseTimeoutMs,
      });
    } catch (error) {
      throw new ModuleExecutorTerminationUnconfirmedError(
        `the Module stop state could not be persisted: ${describe(error)}`,
      );
    }
    if (!stopped.stopped) {
      throw new ModuleExecutorTerminationUnconfirmedError(
        `${stopped.code}: ${stopped.detail}`,
      );
    }
    // Physical termination may finish while initialize() is still unwinding.
    // Do not confirm termination until that start operation can no longer
    // create or reopen resources.
    if (executionAuthorized) {
      await startOperation?.catch(() => undefined);
    }
  };

  const proveStopped = (): Promise<void> => {
    if (terminationConfirmed) return Promise.resolve();
    if (coreExitOperation !== undefined) return coreExitOperation;
    if (terminationOperation !== undefined) return terminationOperation;
    terminationRequested = true;
    const operation = performTermination();
    terminationOperation = operation;
    void operation.then(
      () => {
        terminationConfirmed = true;
        if (terminationOperation === operation) terminationOperation = undefined;
      },
      () => {
        if (terminationOperation === operation) terminationOperation = undefined;
      },
    );
    return operation;
  };

  return Object.freeze({
    isolation: "process" as const,

    start,

    execute: async (
      input: ReactiveModuleInput,
      context: ModuleRunContext,
    ): Promise<ReactiveModuleResult> => {
      assertContext(context, options.moduleGenerationId);
      if (terminationRequested) {
        throw new Error("The Linux Module executor cannot accept work during termination");
      }
      if (!startCompleted) {
        throw new Error(
          "The Linux Module executor cannot accept work before protocol initialization is complete and the running record is persisted",
        );
      }
      if (!session) {
        throw new Error("The Linux Module executor has no protocol session");
      }
      return await session.execute({
        moduleJobId: context.moduleJobId,
        runId: context.runId,
        attempt: context.attempt,
        hasMore: input.hasMore,
        input,
      });
    },

    cancel: async (context: ModuleCancellationContext): Promise<void> => {
      assertContext(context, options.moduleGenerationId);
      // Cancellation is cooperative and is never termination proof. It asks
      // the Extension to stop; only `terminate()` proves that it did.
      await session?.cancel(context.runId, context.reason);
    },

    terminate: proveStopped,
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startFailureError(failure: ModuleProcessStartFailure): Error {
  return new Error(`${failure.code}: ${failure.detail}`);
}
