/**
 * Presents a started child launcher, together with its verified Module control
 * group, as the attached process `ExtensionProcessHost` speaks to.
 *
 * This is the second half of the seam. `ExtensionProcessHost` owns the
 * Extension protocol but deliberately does not know how its attachment
 * terminates a process, because Architecture Decision Record 0009 requires Core
 * to terminate the whole Module control group once membership is verified, and
 * the host must not know that control groups exist. The consequence is that no
 * host test can require whole-group termination: an adapter that signalled one
 * process identifier would satisfy every contract the host states while leaving
 * descendants running. That obligation is discharged here, and is tested here.
 *
 * Two rules follow, and both are load-bearing:
 *
 * - Both termination steps terminate the whole group. Neither signals a process
 *   identifier, and neither does nothing. A second call costs nothing because
 *   `cgroup.kill` is idempotent, while doing nothing would assert that the
 *   first call had already succeeded - an assertion nothing has verified.
 * - An exit is reported only from `cgroup.events` reporting `populated 0`.
 *   Neither termination call returning, nor the launcher child's own exit, is
 *   evidence: after membership is verified a descendant can outlive the direct
 *   child and keep the group populated.
 *
 * A Module that exits on its own needs no separate watcher. Its protocol
 * channel ends, the host treats that as a protocol failure, and the host then
 * asks this adapter to terminate, which is what reads `populated 0` and reports
 * the exit.
 */

import type { ChildProcess } from "node:child_process";
import type { AttachedExtensionProcess } from "../core/extension-process-host.js";
import type {
  ModuleCgroup,
  ModuleCgroupTerminationResult,
} from "../core/linux-module-cgroup.js";

export interface LinuxModuleAttachedProcessOptions {
  /**
   * The started launcher. Only its process identifier and standard streams are
   * used. The launcher has replaced its own process image with the Extension by
   * now, and its protected control descriptor belonged to the pre-membership
   * phase, which is over before a host attaches. The process identifier is
   * carried for diagnostics only; nothing here signals it.
   */
  readonly launcher: {
    readonly processId: number;
    readonly child: Pick<ChildProcess, "stdin" | "stdout">;
  };
  /** The Module control group whose membership Core verified from kernel files. */
  readonly cgroup: ModuleCgroup;
  /** Bound on one whole-group termination proof. */
  readonly terminationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface LinuxModuleAttachedProcess extends AttachedExtensionProcess {
  /**
   * Every whole-group termination this adapter performed, in order, including
   * the ones that failed to prove the group empty. The Linux Module executor
   * reports the last failure when it cannot confirm termination.
   */
  readonly terminationAttempts: readonly ModuleCgroupTerminationResult[];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function attachLinuxModuleProcess(
  options: LinuxModuleAttachedProcessOptions,
): LinuxModuleAttachedProcess {
  const { stdin, stdout } = options.launcher.child;
  if (!stdin || !stdout) {
    throw new TypeError(
      "The launcher child has no standard input and output pipes, so the Extension protocol cannot be attached to it",
    );
  }
  const { cgroup } = options;
  const waitOptions = {
    ...(options.terminationTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.terminationTimeoutMs }),
    ...(options.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.pollIntervalMs }),
  };
  const attempts: ModuleCgroupTerminationResult[] = [];
  const observers = new Set<() => void>();
  let exited = false;

  const terminateWholeGroup = async (): Promise<void> => {
    let result: ModuleCgroupTerminationResult;
    try {
      result = await cgroup.terminate(waitOptions);
    } catch (error) {
      // A thrown failure is still an unproven group, and it is recorded rather
      // than swallowed so the executor can say why termination was unconfirmed.
      result = {
        terminated: false,
        code: "MODULE_CGROUP_PATH_UNAVAILABLE",
        detail: `whole-group termination of ${cgroup.path} failed: ${describe(error)}`,
        waitedMs: 0,
        readings: 0,
      };
    }
    attempts.push(result);
    if (!result.terminated || exited) return;
    exited = true;
    for (const observer of observers) observer();
    observers.clear();
  };

  // Both steps are the same whole-group operation. The host's two-step
  // escalation exists for a mechanism that has a gentler first step; this one
  // does not, and repeating the group termination is both harmless and the only
  // honest option.
  const terminateGroup = (): void => {
    void terminateWholeGroup();
  };

  return {
    standardInput: stdin,
    standardOutput: stdout,
    processId: options.launcher.processId,
    get exited() {
      return exited;
    },
    onExit: (observer: () => void) => {
      if (exited) observer();
      else observers.add(observer);
    },
    requestTermination: terminateGroup,
    forceTermination: terminateGroup,
    get terminationAttempts() {
      return attempts;
    },
  };
}
