/**
 * Decides whether this Linux host may activate configured Modules, and builds
 * the evidence sources startup recovery needs when it may.
 *
 * Architecture Decision Record 0009 requires Core to prove, before it accepts
 * any Module work, that it is the main process of its own stable systemd
 * service and that every old Module control group from its durable records is
 * empty. Those are two separate proofs from two separate modules; this file is
 * the one place that orders them and refuses to continue when either is
 * missing.
 *
 * The result is deliberately shaped as either a refusal carrying every reason,
 * or a permission carrying the `ModuleProcessStopProver` that startup recovery
 * uses. There is no third shape, so a caller cannot accidentally proceed with
 * a partial proof.
 *
 * This module decides eligibility only. It starts no process and terminates
 * nothing. `runtime-bootstrap.ts` still rejects every configured Module; that
 * guard is removed only when ADR 0009 becomes `Accepted`.
 */

import {
  inspectCoreServiceBinding,
  type CoreServiceBindingFailure,
  type CoreServiceInspectionOptions,
  type VerifiedCoreServiceBinding,
} from "./linux-core-service-binding.js";
import {
  LinuxModuleCgroupStopProver,
  type ModuleCgroupFileSystem,
} from "./linux-module-cgroup.js";
import type { ModuleProcessStopProver } from "./core-startup-recovery.js";

export type ModuleActivationRefusalCode =
  | "MODULE_ACTIVATION_PLATFORM_UNSUPPORTED"
  | "MODULE_ACTIVATION_SERVICE_UNVERIFIED"
  | "MODULE_ACTIVATION_LAUNCHER_UNAVAILABLE";

export interface ModuleActivationRefusal {
  readonly code: ModuleActivationRefusalCode;
  readonly detail: string;
}

export interface LinuxModuleActivationOptions extends CoreServiceInspectionOptions {
  /**
   * Absolute path of the Python 3 interpreter that runs the reviewed child
   * launcher. ADR 0009 records why the launcher cannot be a Node.js program:
   * it must join a control group, set its own open-file limit, and replace its
   * own process image in one process.
   */
  readonly launcherInterpreterPath: string;
  /** Absolute path of the installed launcher script. */
  readonly launcherScriptPath: string;
  readonly cgroupFileSystem?: ModuleCgroupFileSystem;
  /** Verifies that both launcher paths exist and are executable. */
  readonly checkLauncherAvailable?: (
    interpreterPath: string,
    scriptPath: string,
  ) => Promise<true | string>;
}

export type LinuxModuleActivationResult =
  | {
      readonly permitted: true;
      readonly binding: VerifiedCoreServiceBinding;
      readonly stopProver: ModuleProcessStopProver;
    }
  | {
      readonly permitted: false;
      readonly refusals: readonly ModuleActivationRefusal[];
      /**
       * Present when the service binding itself was inspected and rejected, so
       * an operator sees every effective-setting failure, not only a summary.
       */
      readonly bindingFailures?: readonly CoreServiceBindingFailure[];
    };

async function defaultCheckLauncherAvailable(
  interpreterPath: string,
  scriptPath: string,
): Promise<true | string> {
  const { access } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  for (const [label, path, mode] of [
    ["interpreter", interpreterPath, constants.X_OK],
    ["launcher script", scriptPath, constants.R_OK],
  ] as const) {
    try {
      await access(path, mode);
    } catch {
      return `the child launcher ${label} at ${path} is missing or not usable`;
    }
  }
  return true;
}

/**
 * Runs the ADR 0009 preconditions in order and returns either a refusal or the
 * evidence source startup recovery needs.
 *
 * The order matters: the stop prover may treat a missing control-group path as
 * evidence only when the current service binding has already been verified, so
 * the binding is proven first and its result is passed into the prover rather
 * than assumed.
 */
export async function decideLinuxModuleActivation(
  options: LinuxModuleActivationOptions,
): Promise<LinuxModuleActivationResult> {
  const refusals: ModuleActivationRefusal[] = [];

  if (process.platform !== "linux") {
    return {
      permitted: false,
      refusals: [
        {
          code: "MODULE_ACTIVATION_PLATFORM_UNSUPPORTED",
          detail: `configured Modules require Linux but this process runs on ${process.platform}`,
        },
      ],
    };
  }

  const checkLauncher = options.checkLauncherAvailable ?? defaultCheckLauncherAvailable;
  const launcherAvailable = await checkLauncher(
    options.launcherInterpreterPath,
    options.launcherScriptPath,
  );
  if (launcherAvailable !== true) {
    refusals.push({
      code: "MODULE_ACTIVATION_LAUNCHER_UNAVAILABLE",
      detail: launcherAvailable,
    });
  }

  const binding = await inspectCoreServiceBinding(options);
  if (!binding.verified) {
    refusals.push({
      code: "MODULE_ACTIVATION_SERVICE_UNVERIFIED",
      detail: `the Core service binding was not proven: ${binding.failures
        .map((failure) => failure.code)
        .join(", ")}`,
    });
    return { permitted: false, refusals, bindingFailures: binding.failures };
  }
  if (refusals.length > 0) {
    return { permitted: false, refusals };
  }

  return {
    permitted: true,
    binding: binding.binding,
    stopProver: new LinuxModuleCgroupStopProver({
      // The binding above is the proof this flag stands for. It is never set
      // from configuration or from a previous run's record.
      serviceBindingVerified: true,
      ...(options.cgroupFileSystem === undefined
        ? {}
        : { fileSystem: options.cgroupFileSystem }),
    }),
  };
}
