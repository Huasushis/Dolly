import {
  assertInstalledModuleActivationCandidate,
  type InstalledModuleActivationCandidate,
} from "../core/installed-module-activation-candidate.js";
import {
  assertInstalledComponentOrigin,
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
  type ReservedV10InstalledPermissionPolicySelection,
} from "./installed-module-permission-policy.js";

export interface InstalledModuleRuntimePremiseOptions {
  /** The exact branded candidate minted by H3 handoff composition. */
  readonly candidate: InstalledModuleActivationCandidate;
  /** Host-owned implementations for the exact policy revisions in each plan. */
  readonly permissionPolicies: ReservedV10InstalledPermissionPolicyRegistry;
}

export interface InstalledModuleRuntimePremiseModule {
  readonly moduleId: string;
  readonly packageOrigin: VerifiedInstalledComponentOrigin;
  readonly permissionPolicies: ReservedV10InstalledPermissionPolicySelection;
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

const RUNTIME_PREMISE_BRAND = new WeakSet<object>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOptions(value: unknown): asserts value is InstalledModuleRuntimePremiseOptions {
  if (!isPlainObject(value)) {
    throw new TypeError("installed Module runtime premise options must be a plain object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "candidate" || keys[1] !== "permissionPolicies") {
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
}

function assertCandidateModule(
  candidate: InstalledModuleActivationCandidate,
  module: InstalledModuleActivationCandidate["modules"][number],
  seenModuleIds: Set<string>,
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
  const seenModuleIds = new Set<string>();
  const modules = options.candidate.modules.map((module) => {
    assertCandidateModule(options.candidate, module, seenModuleIds);
    const permissionPolicies = options.permissionPolicies.resolveFor(module.installedModule);
    const processProvenance = deriveReservedV10InstalledModuleProcessProvenance(
      module.installedModule,
      permissionPolicies,
      options.candidate.activationPermission,
    );
    return Object.freeze({
      moduleId: module.moduleId,
      packageOrigin: module.packageOrigin,
      permissionPolicies,
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
  return premise;
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
  assertInstalledModuleActivationCandidate(
    (value as InstalledModuleRuntimePremise).candidate,
  );
  for (const module of (value as InstalledModuleRuntimePremise).modules) {
    assertReservedV10InstalledModuleProcessProvenance(module.processProvenance);
  }
}
