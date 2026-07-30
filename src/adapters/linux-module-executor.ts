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
 * This executor still receives `openProtocolSession` from its caller and does
 * not itself connect those exact launcher and control-group values. No runtime
 * startup caller currently assembles that path end to end.
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
  readonly openProtocolSession: () => LinuxModuleProtocolSession;
  /** Bound on the whole-group termination proof. */
  readonly terminationTimeoutMs: number;
  /** Bound on observing the protocol channel closed after termination. */
  readonly channelCloseTimeoutMs: number;
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
  let session: LinuxModuleProtocolSession | undefined;
  let processStart: Promise<ModuleProcessStartResult> | undefined;
  let startOperation: Promise<void> | undefined;
  let startCompleted = false;
  let terminationRequested = false;
  let terminationConfirmed = false;
  let terminationOperation: Promise<void> | undefined;
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
        throw error;
      }
      if (!started.executionAuthorized) {
        setAvailableSession(undefined);
        throw startFailureError(started.failure);
      }
      let opened: LinuxModuleProtocolSession;
      try {
        opened = options.openProtocolSession();
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
      throw new ModuleExecutorTerminationUnconfirmedError(
        `the Module process start failed without returning its process ownership state: ${describe(error)}; Core must exit so its service cleanup removes any unreported process`,
      );
    }
    let cgroup;
    if (!started.executionAuthorized) {
      await startOperation?.catch(() => undefined);
      if (started.failure.coreMustExit) {
        let groupCleanupDetail = "no control-group member was observed";
        if (
          started.cgroup !== undefined &&
          started.cgroup.membershipObserved &&
          !started.cgroup.removed
        ) {
          try {
            options.lifecycle.records.updateModuleProcessRecordState(
              options.lifecycle.identity.processGenerationId,
              "stopping",
            );
          } catch {
            // The physical group termination below must still be attempted.
          }
          try {
            const termination = await started.cgroup.terminate({
              timeoutMs: options.terminationTimeoutMs,
            });
            groupCleanupDetail = termination.terminated
              ? "the observed control-group members were terminated, but the group and process record were preserved for service recovery"
              : `${termination.code}: ${termination.detail}`;
          } catch (error) {
            groupCleanupDetail = `control-group termination failed: ${describe(error)}`;
          }
        }
        throw new ModuleExecutorTerminationUnconfirmedError(
          `${started.failure.code}: ${started.failure.detail}; ${groupCleanupDetail}; Core must exit so its service cleanup removes any unaccounted process`,
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
  return new Error(
    failure.coreMustExit
      ? `${failure.code}: ${failure.detail}; Core must exit so its service cleanup removes the service control group`
      : `${failure.code}: ${failure.detail}`,
  );
}
