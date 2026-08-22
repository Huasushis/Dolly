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
  REQUIRED_CGROUP_CONTROLLERS,
  type CoreServiceBindingFailure,
  type CoreServiceInspectionOptions,
  type VerifiedCoreServiceBinding,
} from "./linux-core-service-binding.js";
import {
  CGROUP_V2_MOUNT_POINT,
  LinuxModuleCgroupStopProver,
  prepareDelegatedCgroupRoot,
  type DelegatedCgroupRootPreparation,
} from "./linux-module-cgroup.js";
import type { ModuleProcessStopProver } from "./core-startup-recovery.js";
import {
  assertReviewedLinuxModuleRuntimeIdentity,
  inspectReviewedLinuxModuleRuntime,
  type ReviewedLinuxModuleRuntimeIdentity,
} from "../linux-module-runtime-assets.js";
import { canonicalJsonDigest, deepFreeze, type JsonValue } from "./canonical-json.js";
import { observeHostPlatform } from "./host-platform.js";
import {
  assertStartupAuthorityPermission,
  type StartupAuthorityPermission,
} from "./startup-authority-premise.js";
import type { VerifiedInstalledComponentOrigin } from "./installed-component-origin.js";
import {
  isAbsoluteCgroupPath,
  isLinuxBootId,
  isServiceInvocationId,
} from "./linux-identifier-formats.js";
import type { LinuxServiceCandidate } from "../adapters/storage/runtime-authority-database.js";

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

/**
 * H3 accepts only a permission minted by H2 and then performs the live
 * systemd, process-filesystem, reviewed-runtime, and delegated-root checks.
 * The options intentionally contain no service candidate or downstream
 * observation: both would let a caller replace an upstream premise.
 */
export interface LinuxModuleActivationProofOptions {
  readonly startupAuthorityPermission: StartupAuthorityPermission;
  readonly queryTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
}

export interface LinuxModuleActivationHandoff {
  readonly permitted: true;
  readonly schemaVersion: "dolly.linux-module-activation-handoff/1";
  readonly startupAuthorityPermission: StartupAuthorityPermission;
  readonly controllerGenerationId: string;
  readonly configRevision: number;
  readonly configDigest: string;
  readonly premisesDigest: string;
  readonly serviceBinding: VerifiedCoreServiceBinding;
  readonly runtimeBinding: LinuxModuleRuntimeBinding;
  readonly delegatedRoot: DelegatedCgroupRootPreparation;
  readonly installedComponentOrigins: readonly VerifiedInstalledComponentOrigin[];
  readonly activationPermission: LinuxModuleActivationPermission;
}

export type LinuxModuleActivationHandoffResult =
  | LinuxModuleActivationHandoff
  | {
      readonly permitted: false;
      readonly refusals: readonly ModuleActivationRefusal[];
      readonly bindingFailures?: readonly CoreServiceBindingFailure[];
    };

export interface ConsumeLinuxModuleActivationHandoffInput {
  readonly handoff: LinuxModuleActivationHandoff;
  readonly startupAuthorityPermission: StartupAuthorityPermission;
}

interface LinuxModuleActivationHandoffState {
  readonly startupAuthorityPermission: StartupAuthorityPermission;
  readonly controllerGenerationId: string;
  readonly configRevision: number;
  readonly configDigest: string;
  readonly premisesDigest: string;
  readonly serviceBinding: VerifiedCoreServiceBinding;
  readonly runtimeBinding: LinuxModuleRuntimeBinding;
  readonly delegatedRoot: DelegatedCgroupRootPreparation;
  readonly installedComponentOrigins: readonly VerifiedInstalledComponentOrigin[];
  readonly activationPermission: LinuxModuleActivationPermission;
  consumed: boolean;
}

const LINUX_MODULE_ACTIVATION_HANDOFFS = new WeakMap<
  object,
  LinuxModuleActivationHandoffState
>();

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertProofOptions(
  value: unknown,
): asserts value is LinuxModuleActivationProofOptions {
  if (!isPlainObject(value)) {
    throw new TypeError("Linux Module activation proof options must be a plain object");
  }
  const allowed = ["overallTimeoutMs", "queryTimeoutMs", "startupAuthorityPermission"];
  const keys = Object.keys(value).sort();
  if (
    keys.length === 0 ||
    keys.some((key) => !allowed.includes(key))
  ) {
    throw new TypeError(
      `Linux Module activation proof contains unknown fields: ${keys.join(", ")}`,
    );
  }
  if (!(value.startupAuthorityPermission instanceof Object)) {
    throw new TypeError("Linux Module activation proof requires the H2 startup authority permission");
  }
}

function refusal(
  code: ModuleActivationRefusalCode,
  detail: string,
  bindingFailures?: readonly CoreServiceBindingFailure[],
): LinuxModuleActivationHandoffResult {
  return {
    permitted: false,
    refusals: [{ code, detail }],
    ...(bindingFailures === undefined ? {} : { bindingFailures }),
  };
}

function validateLiveServiceBinding(
  binding: VerifiedCoreServiceBinding,
  candidate: Pick<LinuxServiceCandidate, "unit_name" | "mode">,
): string | undefined {
  if (binding.mode !== candidate.mode) {
    return `the live service mode ${JSON.stringify(binding.mode)} does not match the candidate mode ${JSON.stringify(candidate.mode)}`;
  }
  if (binding.unitName !== candidate.unit_name) {
    return `the live service unit ${JSON.stringify(binding.unitName)} does not match the installed candidate ${JSON.stringify(candidate.unit_name)}`;
  }
  if (!Number.isSafeInteger(binding.mainPid) || binding.mainPid <= 0) {
    return "the live service reported no valid main process identifier";
  }
  if (!isServiceInvocationId(binding.serviceInvocationId)) {
    return "the live service reported an invalid invocation identifier";
  }
  if (!isLinuxBootId(binding.bootId)) {
    return "the live service reported an invalid Linux boot identifier";
  }
  if (!isAbsoluteCgroupPath(binding.delegatedRootCgroupPath)) {
    return "the live service reported an invalid delegated control-group root";
  }
  if (
    !isAbsoluteCgroupPath(binding.coreCgroupPath) ||
    binding.coreCgroupPath !== `${binding.delegatedRootCgroupPath}/core`
  ) {
    return "the live service main process is not in its exact delegated core subgroup";
  }
  const missingControllers = REQUIRED_CGROUP_CONTROLLERS.filter(
    (controller) => !binding.delegatedRootControllers.includes(controller),
  );
  if (missingControllers.length > 0) {
    return `the live service binding is missing required controllers ${missingControllers.join(", ")}`;
  }
  return undefined;
}

function validateDelegatedRoot(
  root: DelegatedCgroupRootPreparation,
  binding: VerifiedCoreServiceBinding,
): string | undefined {
  if (
    root.filesystemPath !==
    `${CGROUP_V2_MOUNT_POINT}${binding.delegatedRootCgroupPath}`
  ) {
    return "the delegated-root filesystem path does not match the live service binding";
  }
  const missingControllers = REQUIRED_CGROUP_CONTROLLERS.filter(
    (controller) => !root.controllers.includes(controller),
  );
  if (missingControllers.length > 0) {
    return `the delegated root read-back is missing required controllers ${missingControllers.join(", ")}`;
  }
  const missingSubtreeControllers = REQUIRED_CGROUP_CONTROLLERS.filter(
    (controller) => !root.subtreeControl.includes(controller),
  );
  if (missingSubtreeControllers.length > 0) {
    return `the delegated root did not enable required controllers ${missingSubtreeControllers.join(", ")}`;
  }
  return undefined;
}

function currentOrigins(
  permission: StartupAuthorityPermission,
): readonly VerifiedInstalledComponentOrigin[] {
  const origins: VerifiedInstalledComponentOrigin[] = [];
  const append = (origin: VerifiedInstalledComponentOrigin): void => {
    if (!origins.includes(origin)) origins.push(origin);
  };
  append(permission.serviceCandidate.origin);
  for (const binding of permission.policyBindings) append(binding.origin);
  return Object.freeze(origins);
}

function mintLinuxModuleActivationHandoff(
  permission: StartupAuthorityPermission,
  activationPermission: LinuxModuleActivationPermission,
): LinuxModuleActivationHandoff {
  const installedComponentOrigins = currentOrigins(permission);
  const handoff = Object.freeze({
    permitted: true as const,
    schemaVersion: "dolly.linux-module-activation-handoff/1" as const,
    startupAuthorityPermission: permission,
    controllerGenerationId: permission.controllerGenerationId,
    configRevision: permission.configRevision,
    configDigest: permission.configDigest,
    premisesDigest: permission.premisesDigest,
    serviceBinding: activationPermission.binding,
    runtimeBinding: activationPermission.runtime,
    delegatedRoot: activationPermission.delegatedRoot,
    installedComponentOrigins,
    activationPermission,
  });
  LINUX_MODULE_ACTIVATION_HANDOFFS.set(handoff, {
    startupAuthorityPermission: permission,
    controllerGenerationId: handoff.controllerGenerationId,
    configRevision: handoff.configRevision,
    configDigest: handoff.configDigest,
    premisesDigest: handoff.premisesDigest,
    serviceBinding: handoff.serviceBinding,
    runtimeBinding: handoff.runtimeBinding,
    delegatedRoot: handoff.delegatedRoot,
    installedComponentOrigins,
    activationPermission,
    consumed: false,
  });
  return handoff;
}

/**
 * Performs the H3 live proof after H2 has resolved the exact persistent
 * premise. A refusal never returns a partial permission or handoff.
 */
export async function proveLinuxModuleActivation(
  options: LinuxModuleActivationProofOptions,
): Promise<LinuxModuleActivationHandoffResult> {
  assertProofOptions(options);
  assertStartupAuthorityPermission(options.startupAuthorityPermission);
  const permission = options.startupAuthorityPermission;

  const platform = observeHostPlatform();
  if (platform !== "linux") {
    return refusal(
      "MODULE_ACTIVATION_PLATFORM_UNSUPPORTED",
      `configured Modules require Linux but this process runs on ${platform}`,
    );
  }

  const candidate = permission.serviceCandidate;
  if (candidate.mode !== "user") {
    return refusal(
      "MODULE_ACTIVATION_SERVICE_UNVERIFIED",
      `installed Module activation requires a systemd user service, not ${JSON.stringify(candidate.mode)}`,
    );
  }

  const serviceOptions: LinuxModuleActivationOptions = {
    unitName: candidate.unit_name,
    mode: "user",
    ...(options.queryTimeoutMs === undefined
      ? {}
      : { queryTimeoutMs: options.queryTimeoutMs }),
    ...(options.overallTimeoutMs === undefined
      ? {}
      : { overallTimeoutMs: options.overallTimeoutMs }),
  };
  const service = await inspectCoreServiceBinding(serviceOptions);
  if (!service.verified) {
    return refusal(
      "MODULE_ACTIVATION_SERVICE_UNVERIFIED",
      `the Core service binding was not proven: ${service.failures
        .map((failure) => failure.code)
        .join(", ")}`,
      service.failures,
    );
  }
  const serviceFailure = validateLiveServiceBinding(service.binding, candidate);
  if (serviceFailure !== undefined) {
    return refusal("MODULE_ACTIVATION_SERVICE_UNVERIFIED", serviceFailure);
  }

  const runtimeInspection = await inspectReviewedLinuxModuleRuntime();
  if (!runtimeInspection.available) {
    return refusal(
      "MODULE_ACTIVATION_LAUNCHER_UNAVAILABLE",
      runtimeInspection.detail,
    );
  }
  try {
    assertReviewedLinuxModuleRuntimeIdentity(runtimeInspection.runtime);
  } catch (error) {
    return refusal(
      "MODULE_ACTIVATION_LAUNCHER_UNAVAILABLE",
      `the reviewed runtime proof is not the current Host runtime: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const delegatedRoot = await prepareDelegatedCgroupRoot({
    delegatedRootCgroupPath: service.binding.delegatedRootCgroupPath,
  });
  if (!delegatedRoot.prepared) {
    return refusal(
      "MODULE_ACTIVATION_CGROUP_UNAVAILABLE",
      delegatedRoot.failure.detail,
    );
  }
  const delegatedRootFailure = validateDelegatedRoot(
    delegatedRoot.root,
    service.binding,
  );
  if (delegatedRootFailure !== undefined) {
    return refusal("MODULE_ACTIVATION_CGROUP_UNAVAILABLE", delegatedRootFailure);
  }

  assertStartupAuthorityPermission(permission);
  try {
    assertReviewedLinuxModuleRuntimeIdentity(runtimeInspection.runtime);
  } catch (error) {
    return refusal(
      "MODULE_ACTIVATION_LAUNCHER_UNAVAILABLE",
      `the reviewed runtime proof became stale before handoff mint: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const runtime = mintLinuxModuleRuntimeBinding(runtimeInspection.runtime);
  const activationPermission: LinuxModuleActivationPermission = Object.freeze({
    permitted: true,
    binding: Object.freeze({
      ...service.binding,
      delegatedRootControllers: Object.freeze([
        ...service.binding.delegatedRootControllers,
      ]),
    }),
    delegatedRoot: Object.freeze({
      ...delegatedRoot.root,
      controllers: Object.freeze([...delegatedRoot.root.controllers]),
      subtreeControl: Object.freeze([...delegatedRoot.root.subtreeControl]),
    }),
    runtime,
    stopProver: new LinuxModuleCgroupStopProver({
      serviceBindingVerified: true,
      delegatedRootCgroupPath: service.binding.delegatedRootCgroupPath,
    }),
  });
  LINUX_MODULE_ACTIVATION_PERMISSIONS.add(activationPermission);
  return mintLinuxModuleActivationHandoff(permission, activationPermission);
}

function assertHandoffConsumeInput(
  value: unknown,
): asserts value is ConsumeLinuxModuleActivationHandoffInput {
  if (!isPlainObject(value)) {
    throw new TypeError("Linux Module activation handoff consume input must be a plain object");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "handoff" ||
    keys[1] !== "startupAuthorityPermission"
  ) {
    throw new TypeError(
      `Linux Module activation handoff consume contains unknown fields: ${keys.join(", ")}`,
    );
  }
}

/** Consumes the H3 handoff only once with the exact H2 permission it used. */
export function consumeLinuxModuleActivationHandoff(
  input: ConsumeLinuxModuleActivationHandoffInput,
): LinuxModuleActivationPermission {
  assertHandoffConsumeInput(input);
  const state = LINUX_MODULE_ACTIVATION_HANDOFFS.get(input.handoff);
  if (state === undefined) {
    throw new TypeError("Linux Module activation handoff was not minted by the Host");
  }
  if (state.consumed) {
    throw new TypeError("Linux Module activation handoff was already consumed");
  }
  if (input.startupAuthorityPermission !== state.startupAuthorityPermission) {
    throw new TypeError(
      "Linux Module activation handoff is bound to a different H2 startup authority permission",
    );
  }
  assertStartupAuthorityPermission(input.startupAuthorityPermission);
  const currentInstalledOrigins = currentOrigins(input.startupAuthorityPermission);
  if (
    currentInstalledOrigins.length !== state.installedComponentOrigins.length ||
    currentInstalledOrigins.some(
      (origin, index) => origin !== state.installedComponentOrigins[index],
    )
  ) {
    throw new TypeError(
      "Linux Module activation handoff is bound to stale installed component origins",
    );
  }
  if (
    input.startupAuthorityPermission.controllerGenerationId !==
      state.controllerGenerationId ||
    input.startupAuthorityPermission.configRevision !== state.configRevision ||
    input.startupAuthorityPermission.configDigest !== state.configDigest ||
    input.startupAuthorityPermission.premisesDigest !== state.premisesDigest ||
    state.serviceBinding !== state.activationPermission.binding ||
    state.runtimeBinding !== state.activationPermission.runtime ||
    state.delegatedRoot !== state.activationPermission.delegatedRoot
  ) {
    throw new TypeError(
      "Linux Module activation handoff no longer matches its complete live proof",
    );
  }
  assertLinuxModuleActivationPermission(state.activationPermission);
  assertLinuxModuleRuntimeBinding(state.runtimeBinding);
  assertReviewedLinuxModuleRuntimeIdentity(state.runtimeBinding.auditProfile);
  state.consumed = true;
  return state.activationPermission;
}
