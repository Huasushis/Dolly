import {
  assertInstalledModuleActivationCandidate,
  type InstalledModuleActivationCandidate,
} from "../core/installed-module-activation-candidate.js";
import {
  assertStartupAuthorityPermissionContext,
  type StartupAuthorityPermission,
  type StartupAuthorityPermissionContext,
} from "../core/startup-authority-premise.js";
import {
  assertInstalledComponentOrigin,
  InstalledComponentOriginRegistry,
  type VerifiedInstalledComponentOrigin,
} from "../core/installed-component-origin.js";
import type { ReservedV10InstalledModulePlan } from "../core/installed-extension-module.js";
import {
  deriveReservedV10InstalledModuleProcessProvenance,
  assertReservedV10InstalledModuleProcessProvenance,
  type ReservedV10InstalledModuleProcessProvenance,
} from "./installed-linux-extension-module-executor.js";
import {
  ReservedV10InstalledPermissionPolicyRegistry,
  type InstalledModulePermissionBinding,
  type ReservedV10InstalledPermissionPolicySelection,
} from "./installed-module-permission-policy.js";

export interface InstalledModuleRuntimePremiseOptions
  extends StartupAuthorityPermissionContext {
  /** The exact branded candidate minted by H3 handoff composition. */
  readonly candidate: InstalledModuleActivationCandidate;
  /** The exact H2 permission that authorized the H3 handoff. */
  readonly startupAuthorityPermission: StartupAuthorityPermission;
  /** Host-owned implementations for the exact policy revisions in each plan. */
  readonly permissionPolicies: ReservedV10InstalledPermissionPolicyRegistry;
}

export interface InstalledModuleRuntimePremiseModule {
  readonly moduleId: string;
  readonly packageOrigin: VerifiedInstalledComponentOrigin;
  readonly permissionPolicies: ReservedV10InstalledPermissionPolicySelection;
  readonly permissionBindings: readonly InstalledModulePermissionBinding[];
  readonly processProvenance: ReservedV10InstalledModuleProcessProvenance;
}

/**
 * Internal, pre-bootstrap input for a later installed Host/process factory.
 * This consumer only projects the branded H3 candidate into per-Module
 * provenance. It starts no process, exposes no readiness, and records no
 * downstream result, acknowledgement, absence, or retry observation.
 */
export interface InstalledModuleRuntimePremise {
  readonly schemaVersion: "dolly.installed-module-runtime-premise/1";
  /** Object identity keeps this premise tied to the exact live candidate. */
  readonly candidate: InstalledModuleActivationCandidate;
  readonly modules: readonly InstalledModuleRuntimePremiseModule[];
}

export interface InstalledModuleRuntimePremiseAuthority {
  readonly permissionPolicies: ReservedV10InstalledPermissionPolicyRegistry;
  readonly startupAuthorityPermission: StartupAuthorityPermission;
  readonly context: StartupAuthorityPermissionContext;
}

const RUNTIME_PREMISE_BRAND = new WeakSet<object>();
const RUNTIME_PREMISE_AUTHORITY = new WeakMap<
  object,
  InstalledModuleRuntimePremiseAuthority
>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOptions(value: unknown): asserts value is InstalledModuleRuntimePremiseOptions {
  if (!isPlainObject(value)) {
    throw new TypeError("installed Module runtime premise options must be a plain object");
  }
  const expected = [
    "candidate",
    "controller",
    "database",
    "origins",
    "permissionPolicies",
    "startupAuthorityPermission",
  ].sort();
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(
      `installed Module runtime premise contains unknown fields: ${keys.join(", ")}`,
    );
  }
  assertInstalledModuleActivationCandidate(value.candidate);
  if (!(value.permissionPolicies instanceof ReservedV10InstalledPermissionPolicyRegistry)) {
    throw new TypeError(
      "installed Module runtime premise requires the reserved version-10 permission policy registry",
    );
  }
  assertStartupAuthorityPermissionContext(
    value.startupAuthorityPermission,
    value as unknown as StartupAuthorityPermissionContext,
  );
}

function assertCandidateAuthority(
  candidate: InstalledModuleActivationCandidate,
  permission: StartupAuthorityPermission,
): void {
  if (
    candidate.configRevision !== permission.configRevision ||
    candidate.configDigest !== permission.configDigest ||
    candidate.premisesDigest !== permission.premisesDigest ||
    candidate.controllerGenerationId !== permission.controllerGenerationId
  ) {
    throw new TypeError(
      "installed Module runtime premise candidate is stale for the durable Startup authority",
    );
  }
}

function assertCandidateModule(
  candidate: InstalledModuleActivationCandidate,
  module: InstalledModuleActivationCandidate["modules"][number],
  seenModuleIds: Set<string>,
  origins: InstalledComponentOriginRegistry,
): void {
  if (seenModuleIds.has(module.moduleId)) {
    throw new TypeError(`installed Module runtime premise has duplicate Module ${module.moduleId}`);
  }
  seenModuleIds.add(module.moduleId);
  const plan: ReservedV10InstalledModulePlan = module.installedModule;
  if (plan.module.moduleId !== module.moduleId) {
    throw new TypeError(
      `installed Module runtime premise Module ${module.moduleId} does not match its installed plan`,
    );
  }
  assertInstalledComponentOrigin(module.packageOrigin);
  origins.assertCurrent(module.packageOrigin);
  const currentOrigin = origins.resolve({
    extensionId: plan.installation.manifest.extensionId,
    packageVersion: plan.installation.manifest.packageVersion,
  });
  if (
    module.packageOrigin.schema !== currentOrigin.schema ||
    module.packageOrigin.kind !== currentOrigin.kind ||
    module.packageOrigin.component_id !== currentOrigin.component_id ||
    module.packageOrigin.component_revision !== currentOrigin.component_revision ||
    module.packageOrigin.component_digest !== currentOrigin.component_digest
  ) {
    throw new TypeError(
      `installed Module runtime premise Module ${module.moduleId} package origin is stale for the current Host registry`,
    );
  }
  if (!candidate.installedComponentOrigins.includes(module.packageOrigin)) {
    throw new TypeError(
      `installed Module runtime premise Module ${module.moduleId} is not bound to the candidate origin set`,
    );
  }
  if (
    module.packageOrigin.component_id !== plan.installation.manifest.extensionId ||
    module.packageOrigin.component_digest !== plan.installation.packageDigest
  ) {
    throw new TypeError(
      `installed Module runtime premise Module ${module.moduleId} package origin does not match its installed package`,
    );
  }
}

/**
 * Consumes one exact candidate and derives immutable per-Module provenance.
 * The returned object is an internal premise only; downstream process or
 * result observations have no path back into candidate or activation minting.
 */
export function composeInstalledModuleRuntimePremise(
  options: InstalledModuleRuntimePremiseOptions,
): InstalledModuleRuntimePremise {
  assertOptions(options);
  assertCandidateAuthority(options.candidate, options.startupAuthorityPermission);
  const seenModuleIds = new Set<string>();
  const modules = options.candidate.modules.map((module) => {
    assertCandidateModule(options.candidate, module, seenModuleIds, options.origins);
    const permissionPolicies = options.permissionPolicies.resolveFor(module.installedModule);
    const permissionBindings = options.permissionPolicies.resolveLiveBindingsFor(
      module.installedModule,
      options.startupAuthorityPermission,
      options,
    );
    const processProvenance = deriveReservedV10InstalledModuleProcessProvenance(
      module.installedModule,
      permissionPolicies,
      options.candidate.activationPermission,
    );
    return Object.freeze({
      moduleId: module.moduleId,
      packageOrigin: module.packageOrigin,
      permissionPolicies,
      permissionBindings,
      processProvenance,
    });
  });
  if (modules.length === 0) {
    throw new TypeError("installed Module runtime premise requires at least one Module");
  }
  const premise = Object.freeze({
    schemaVersion: "dolly.installed-module-runtime-premise/1" as const,
    candidate: options.candidate,
    modules: Object.freeze(modules),
  });
  RUNTIME_PREMISE_BRAND.add(premise);
  RUNTIME_PREMISE_AUTHORITY.set(premise, Object.freeze({
    permissionPolicies: options.permissionPolicies,
    startupAuthorityPermission: options.startupAuthorityPermission,
    context: Object.freeze({
      database: options.database,
      controller: options.controller,
      origins: options.origins,
    }),
  }));
  return premise;
}

function assertPremiseAuthority(
  premise: InstalledModuleRuntimePremise,
): InstalledModuleRuntimePremiseAuthority {
  const authority = RUNTIME_PREMISE_AUTHORITY.get(premise);
  if (authority === undefined) {
    throw new TypeError(
      "installed Module runtime premise has no private Host authority",
    );
  }
  assertStartupAuthorityPermissionContext(
    authority.startupAuthorityPermission,
    authority.context,
  );
  assertCandidateAuthority(premise.candidate, authority.startupAuthorityPermission);
  const seenModuleIds = new Set<string>();
  for (const module of premise.modules) {
    const candidateModule = premise.candidate.modules.find(
      (candidate) => candidate.moduleId === module.moduleId,
    );
    if (
      candidateModule === undefined ||
      candidateModule.installedModule !== module.processProvenance.installedModule ||
      candidateModule.packageOrigin !== module.packageOrigin
    ) {
      throw new TypeError(
        `installed Module runtime premise Module ${module.moduleId} is not bound to its activation candidate`,
      );
    }
    assertCandidateModule(
      premise.candidate,
      candidateModule,
      seenModuleIds,
      authority.context.origins,
    );
    assertReservedV10InstalledModuleProcessProvenance(module.processProvenance);
    authority.permissionPolicies.assertLiveBindingsFor(
      candidateModule.installedModule,
      authority.startupAuthorityPermission,
      authority.context,
      module.permissionPolicies,
      module.permissionBindings,
    );
  }
  return authority;
}

/** Rejects copied or deserialized premises before a future process factory uses them. */
export function assertInstalledModuleRuntimePremise(
  value: unknown,
): asserts value is InstalledModuleRuntimePremise {
  if (
    value === null ||
    typeof value !== "object" ||
    !RUNTIME_PREMISE_BRAND.has(value)
  ) {
    throw new TypeError(
      "installed Module runtime premise was not minted from a branded activation candidate",
    );
  }
  const premise = value as InstalledModuleRuntimePremise;
  assertInstalledModuleActivationCandidate(premise.candidate);
  assertPremiseAuthority(premise);
}

/** Recovers only the exact private Host authority behind a branded premise. */
export function resolveInstalledModuleRuntimePremiseAuthority(
  value: InstalledModuleRuntimePremise,
): InstalledModuleRuntimePremiseAuthority {
  assertInstalledModuleRuntimePremise(value);
  return RUNTIME_PREMISE_AUTHORITY.get(value)!;
}
