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
 * - terminates by terminating the whole Module control group and proving it
 *   empty, then waits for the protocol channel to close, rather than by
 *   signalling a child.
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
  type StartModuleProcessOptions,
} from "../core/linux-module-process-lifecycle.js";
import type { ModuleCgroup } from "../core/linux-module-cgroup.js";

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
   * Closes the capability session, revoking every handle and delivering an
   * abort signal, then resolves once every started handler is terminal.
   * ADR 0009 requires this before a Claim may be classified.
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
  /** Attaches the Extension protocol to the started launcher's streams. */
  readonly openProtocolSession: () => Promise<LinuxModuleProtocolSession>;
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
  let cgroup: ModuleCgroup | undefined;
  let session: LinuxModuleProtocolSession | undefined;
  let terminated = false;

  const proveStopped = async (): Promise<void> => {
    if (terminated) return;
    terminated = true;

    // Capability handles are revoked and their handlers drained before the
    // group is terminated, so no handler can still be running when Core
    // decides what the Claim's outcome was.
    if (session) {
      try {
        await session.closeCapabilitySession();
      } catch (error) {
        throw new ModuleExecutorTerminationUnconfirmedError(
          `the capability session did not close: ${describe(error)}`,
        );
      }
    }

    if (!cgroup) {
      // No control group was ever prepared, so no process of this generation
      // can exist. There is nothing to prove empty.
      return;
    }

    const stopped = await stopModuleProcess({
      records: options.lifecycle.records,
      processGenerationId: options.lifecycle.identity.processGenerationId,
      cgroup,
      timeoutMs: options.terminationTimeoutMs,
    });
    if (!stopped.stopped) {
      throw new ModuleExecutorTerminationUnconfirmedError(
        `the Module control group was not proven empty: ${stopped.code}: ${stopped.detail}`,
      );
    }

    if (session) {
      const closed = await session.waitForChannelClosed(options.channelCloseTimeoutMs);
      if (!closed) {
        // The group is empty, so nothing can still execute, but ADR 0009 also
        // requires the protocol channel to be observed closed before Core may
        // report termination. Reporting success here would let a late frame
        // race a replacement generation.
        throw new ModuleExecutorTerminationUnconfirmedError(
          "the Extension protocol channel was not observed closed after the Module control group emptied",
        );
      }
    }
  };

  return Object.freeze({
    isolation: "process" as const,

    start: async (): Promise<void> => {
      const started = await startModuleProcess(options.lifecycle);
      if (!started.started) {
        // A start that leaves an unaccounted launcher is not a plain failure:
        // ADR 0009 requires Core to exit so its service cleanup removes the
        // whole service control group. The distinction is carried in the
        // message so the caller can act on it.
        terminated = true;
        throw new Error(
          started.failure.coreMustExit
            ? `${started.failure.code}: ${started.failure.detail}; Core must exit so its service cleanup removes the service control group`
            : `${started.failure.code}: ${started.failure.detail}`,
        );
      }
      cgroup = started.cgroup;
      const opened = await options.openProtocolSession();
      session = opened;
      await opened.initialize();
    },

    execute: async (
      input: ReactiveModuleInput,
      context: ModuleRunContext,
    ): Promise<ReactiveModuleResult> => {
      assertContext(context, options.moduleGenerationId);
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
