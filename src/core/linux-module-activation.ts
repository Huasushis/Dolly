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
  prepareDelegatedCgroupRoot,
  type DelegatedCgroupRootPreparation,
} from "./linux-module-cgroup.js";
import type { ModuleProcessStopProver } from "./core-startup-recovery.js";
import {
  inspectReviewedLinuxModuleRuntime,
  type ReviewedLinuxModuleRuntimeIdentity,
} from "../linux-module-runtime-assets.js";
import { canonicalJsonDigest, deepFreeze, type JsonValue } from "./canonical-json.js";
import { observeHostPlatform } from "./host-platform.js";

export type ModuleActivationRefusalCode =
  | "MODULE_ACTIVATION_PLATFORM_UNSUPPORTED"
  | "MODULE_ACTIVATION_SERVICE_UNVERIFIED"
  | "MODULE_ACTIVATION_LAUNCHER_UNAVAILABLE"
  | "MODULE_ACTIVATION_CGROUP_UNAVAILABLE";

export interface ModuleActivationRefusal {
  readonly code: ModuleActivationRefusalCode;
  readonly detail: string;
}

export interface LinuxModuleActivationOptions extends Pick<
  CoreServiceInspectionOptions,
  "unitName" | "mode" | "queryTimeoutMs" | "overallTimeoutMs"
> {
}

export interface LinuxModuleActivationPermission {
  readonly permitted: true;
  readonly binding: VerifiedCoreServiceBinding;
  readonly delegatedRoot: DelegatedCgroupRootPreparation;
  readonly runtime: LinuxModuleRuntimeBinding;
  readonly stopProver: ModuleProcessStopProver;
}

/**
 * Host-owned proof that one closed Linux runtime profile passed the activation
 * inspection. The audit profile describes the executable paths and reviewed
 * launcher bytes; object identity ties later composition to this exact
 * inspection rather than to a caller-created object with equal fields.
 *
 * The revision is an audit-record digest, not a claim that dynamic libraries,
 * the kernel, or bubblewrap semantics are portable across hosts. A future
 * durable process record must pair it with separately versioned host
 * conformance evidence before public Module activation can be enabled.
 */
export interface LinuxModuleRuntimeBinding {
  readonly bindingRevision: string;
  readonly auditProfile: ReviewedLinuxModuleRuntimeIdentity;
}

export type LinuxModuleActivationResult =
  | LinuxModuleActivationPermission
  | {
      readonly permitted: false;
      readonly refusals: readonly ModuleActivationRefusal[];
      /**
       * Present when the service binding itself was inspected and rejected, so
       * an operator sees every effective-setting failure, not only a summary.
       */
      readonly bindingFailures?: readonly CoreServiceBindingFailure[];
    };

const LINUX_MODULE_ACTIVATION_PERMISSIONS = new WeakSet<object>();
const LINUX_MODULE_RUNTIME_BINDINGS = new WeakSet<object>();

function mintLinuxModuleRuntimeBinding(
  profile: ReviewedLinuxModuleRuntimeIdentity,
): LinuxModuleRuntimeBinding {
  const auditProfile = deepFreeze({
    ...profile,
  }) as unknown as ReviewedLinuxModuleRuntimeIdentity;
  const bindingRevision = canonicalJsonDigest(deepFreeze({
    schemaVersion: "dolly.linux-module-runtime-binding/1",
    auditProfile: auditProfile as unknown as JsonValue,
  }));
  const binding = Object.freeze({ bindingRevision, auditProfile });
  LINUX_MODULE_RUNTIME_BINDINGS.add(binding);
  return binding;
}

/** Rejects copied runtime profiles and bindings not minted by activation. */
export function assertLinuxModuleRuntimeBinding(
  value: unknown,
): asserts value is LinuxModuleRuntimeBinding {
  if (
    value === null ||
    typeof value !== "object" ||
    !LINUX_MODULE_RUNTIME_BINDINGS.has(value)
  ) {
    throw new TypeError(
      "Linux Module runtime binding was not minted by the Host activation decision",
    );
  }
}

/** Rejects copied or caller-constructed activation evidence. */
export function assertLinuxModuleActivationPermission(
  value: unknown,
): asserts value is LinuxModuleActivationPermission {
  if (
    value === null ||
    typeof value !== "object" ||
    !LINUX_MODULE_ACTIVATION_PERMISSIONS.has(value)
  ) {
    throw new TypeError(
      "Linux Module activation permission was not minted by the Host activation decision",
    );
  }
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
  const allowedOptionKeys = new Set([
    "unitName",
    "mode",
    "queryTimeoutMs",
    "overallTimeoutMs",
  ]);
  const unknownOptionKeys = Object.keys(options)
    .filter((key) => !allowedOptionKeys.has(key))
    .sort();
  if (unknownOptionKeys.length > 0) {
    throw new TypeError(
      `Linux Module activation contains unknown fields: ${unknownOptionKeys.join(", ")}`,
    );
  }
  const refusals: ModuleActivationRefusal[] = [];

  const platform = observeHostPlatform();
  if (platform !== "linux") {
    return {
      permitted: false,
      refusals: [
        {
          code: "MODULE_ACTIVATION_PLATFORM_UNSUPPORTED",
          detail: `configured Modules require Linux but this process runs on ${platform}`,
        },
      ],
    };
  }

  const runtimeInspection = await inspectReviewedLinuxModuleRuntime();
  if (!runtimeInspection.available) {
    refusals.push({
      code: "MODULE_ACTIVATION_LAUNCHER_UNAVAILABLE",
      detail: runtimeInspection.detail,
    });
  }
  const runtimeProfile = runtimeInspection.runtime;

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

  const runtime = mintLinuxModuleRuntimeBinding(runtimeProfile);

  const delegatedRoot = await prepareDelegatedCgroupRoot({
    delegatedRootCgroupPath: binding.binding.delegatedRootCgroupPath,
  });
  if (!delegatedRoot.prepared) {
    return {
      permitted: false,
      refusals: [{
        code: "MODULE_ACTIVATION_CGROUP_UNAVAILABLE",
        detail: delegatedRoot.failure.detail,
      }],
    };
  }

  const permission: LinuxModuleActivationPermission = Object.freeze({
    permitted: true,
    binding: Object.freeze({
      ...binding.binding,
      delegatedRootControllers: Object.freeze([
        ...binding.binding.delegatedRootControllers,
      ]),
    }),
    delegatedRoot: Object.freeze({
      ...delegatedRoot.root,
      controllers: Object.freeze([...delegatedRoot.root.controllers]),
      subtreeControl: Object.freeze([...delegatedRoot.root.subtreeControl]),
    }),
    runtime,
    stopProver: new LinuxModuleCgroupStopProver({
      // The binding above is the proof this flag stands for. It is never set
      // from configuration or from a previous run's record.
      serviceBindingVerified: true,
      delegatedRootCgroupPath: binding.binding.delegatedRootCgroupPath,
    }),
  });
  LINUX_MODULE_ACTIVATION_PERMISSIONS.add(permission);
  return permission;
}
