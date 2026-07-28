/**
 * Presents the shipped launcher controller as the `ModuleLauncherControl` shape
 * the ordered Module process start in `linux-module-process-lifecycle.ts` is
 * written against.
 *
 * The two shapes differ in three ways, and each difference is a place where a
 * careless conversion would lose a failure:
 *
 * - `LinuxModuleLauncherController` runs configure, the `in-cgroup` wait,
 *   kernel membership verification, the stop check, and the execute
 *   authorization in one `authorizeExecution` call. It cannot be split, so
 *   `configure` here records the request and the single call happens in
 *   `authorizeExecution`. The ordering Architecture Decision Record 0009
 *   requires is unaffected: the caller's stop check still happens before this
 *   adapter asks the controller to do anything, and the controller still
 *   verifies membership from kernel files before it sends `execute`.
 * - The controller reports failure as a returned outcome, while
 *   `ModuleLauncherControl` reports it by throwing. That conversion is total by
 *   construction: everything that is not the `executing` outcome throws, and
 *   the failure code is described by an exhaustive switch, so a new code cannot
 *   be added without a case here. A variant nobody mapped would otherwise
 *   return normally and be indistinguishable from an authorized execution.
 * - The controller has no `requestExit`. On failure it has already asked the
 *   launcher to exit through the protected control descriptor and waited for
 *   the observed exit, so this adapter reports that evidence instead of asking
 *   again. Before the sequence has run there is nothing to report, so it closes
 *   the control descriptor, which is what the launcher exits on, and waits for
 *   an observed exit. No path here signals a process identifier.
 */

import type {
  LinuxModuleLauncherController,
  LinuxModuleLauncherFailed,
  LinuxModuleLauncherFailureCode,
} from "./linux-module-launcher-controller.js";

/** The launcher members this adapter needs. A started launcher satisfies it. */
export interface ModuleLauncherControlOptions {
  readonly launcher: {
    readonly processId: number;
    readonly controller: LinuxModuleLauncherController;
    closeControlChannel(): void;
    waitForExit(timeoutMs: number): Promise<boolean>;
  };
  /** Bound on observing the launcher's exit when the sequence never ran. */
  readonly exitObservationTimeoutMs?: number;
}

export class LinuxModuleLauncherControlError extends Error {
  constructor(
    readonly code: LinuxModuleLauncherFailureCode,
    /** Whether kernel membership was verified before the failure. */
    readonly membershipVerified: boolean,
    /** Whether the launcher's exit was actually observed. */
    readonly launcherExitObserved: boolean,
    message: string,
  ) {
    super(message);
    this.name = "LinuxModuleLauncherControlError";
  }
}

/**
 * Describes one launcher failure code in plain language.
 *
 * The `never` assignment in the default case is the point of the switch: a
 * failure code added to the controller without a case here stops compiling
 * rather than reaching a caller as an unexplained failure.
 */
function describeLauncherFailure(code: LinuxModuleLauncherFailureCode): string {
  switch (code) {
    case "LAUNCHER_CONTROL_SEND_FAILED":
      return "the launcher control descriptor did not accept a command";
    case "LAUNCHER_CONTROL_CHANNEL_CLOSED":
      return "the launcher control descriptor closed before authorization";
    case "LAUNCHER_CONTROL_PROTOCOL_VIOLATION":
      return "the launcher sent a malformed, unknown, or out-of-order control frame";
    case "LAUNCHER_CONTROL_TIMEOUT":
      return "a launcher control phase exceeded its finite wait";
    case "LAUNCHER_MEMBERSHIP_UNVERIFIED":
      return "the kernel control-group files did not confirm the launcher's membership";
    case "LAUNCHER_STOP_REQUESTED":
      return "a stop was requested before the launcher was authorized to execute";
    default: {
      const unmapped: never = code;
      // Unreachable while the switch is exhaustive. It still fails closed,
      // because the caller throws on every outcome that is not `executing`.
      return `an unmapped launcher failure code ${JSON.stringify(unmapped)}`;
    }
  }
}

function launcherFailureError(
  failure: LinuxModuleLauncherFailed,
): LinuxModuleLauncherControlError {
  return new LinuxModuleLauncherControlError(
    failure.code,
    failure.membershipVerified,
    failure.launcherExitObserved,
    `${failure.code}: ${describeLauncherFailure(failure.code)}; ${failure.message}`,
  );
}

export interface ModuleLauncherControlAdapter {
  readonly processId: number;
  configure(request: {
    readonly moduleCgroupPath: string;
    readonly maxOpenFiles: number;
  }): Promise<void>;
  authorizeExecution(request: {
    readonly moduleCgroupPath: string;
    readonly program: string;
    readonly argumentVector: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
  }): Promise<void>;
  requestExit(): Promise<boolean>;
}

export function createModuleLauncherControl(
  options: ModuleLauncherControlOptions,
): ModuleLauncherControlAdapter {
  const { launcher } = options;
  const exitObservationTimeoutMs = options.exitObservationTimeoutMs ?? 5_000;
  let configured: { moduleCgroupPath: string; maxOpenFiles: number } | undefined;
  let failure: LinuxModuleLauncherFailed | undefined;
  let executing = false;

  return {
    processId: launcher.processId,

    async configure(request) {
      configured = {
        moduleCgroupPath: request.moduleCgroupPath,
        maxOpenFiles: request.maxOpenFiles,
      };
    },

    async authorizeExecution(request) {
      if (!configured) {
        throw new Error(
          "The launcher must be configured with its Module control group before execution is authorized",
        );
      }
      if (configured.moduleCgroupPath !== request.moduleCgroupPath) {
        // Two different groups in one start would mean the launcher joined one
        // group and was authorized against another.
        throw new Error(
          "The configured and authorized Module control-group paths differ, so the launcher's verified membership would not be the group it executes in",
        );
      }
      const outcome = await launcher.controller.authorizeExecution({
        launcherProcessId: launcher.processId,
        moduleCgroupPath: configured.moduleCgroupPath,
        maxOpenFiles: configured.maxOpenFiles,
        program: request.program,
        argumentVector: request.argumentVector,
        environment: request.environment,
      });
      if (outcome.outcome === "executing") {
        executing = true;
        return;
      }
      failure = outcome;
      throw launcherFailureError(outcome);
    },

    async requestExit() {
      if (failure) {
        // The controller already asked and already waited. Reporting its
        // evidence is honest; asking again would not make an unobserved exit
        // observed.
        return failure.launcherExitObserved;
      }
      if (executing) {
        // Membership was verified, so ADR 0009 no longer accepts a launcher
        // exit as proof. Claiming one here would let the caller stop treating
        // the Module control group as the unit of termination.
        return false;
      }
      launcher.controller.requestStop();
      launcher.closeControlChannel();
      return await launcher.waitForExit(exitObservationTimeoutMs);
    },
  };
}
