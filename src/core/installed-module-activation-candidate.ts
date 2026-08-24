import { type JsonValue } from "./canonical-json.js";
import {
  consumeLinuxModuleActivationHandoff,
  type LinuxModuleActivationHandoff,
  type LinuxModuleActivationPermission,
} from "./linux-module-activation.js";
import {
  ExtensionInstallationRegistry,
} from "./extension-installation-registry.js";
import {
  ModuleConfigurationStore,
} from "./module-configuration-store.js";
import {
  resolveReservedV10InstalledModulePlan,
  type ReservedV10InstalledModulePlan,
} from "./installed-extension-module.js";
import {
  InstalledComponentOriginRegistry,
  type VerifiedInstalledComponentOrigin,
} from "./installed-component-origin.js";
import {
  InstanceControllerLock,
} from "./instance-controller-lock.js";
import {
  RuntimeAuthorityDatabase,
} from "../adapters/storage/runtime-authority-database.js";
import {
  assertStartupAuthorityPermissionContext,
  type StartupAuthorityPermissionContext,
} from "./startup-authority-premise.js";
import { validateDollyInstanceConfigV10Draft } from "./runtime-config-v10.js";
import {
  produceReservedV10ExtensionPackageManifest,
  type ReservedV10InstalledExtensionPackageManifest,
} from "./reserved-v10-extension-package.js";

export interface InstalledModuleActivationCandidateOptions
  extends StartupAuthorityPermissionContext {
  /** Authentic H3 proof; consuming it is the only way to obtain activation. */
  readonly handoff: LinuxModuleActivationHandoff;
  readonly installations: ExtensionInstallationRegistry;
  readonly configurations: ModuleConfigurationStore;
}

export interface InstalledModuleActivationCandidateModule {
  readonly moduleId: string;
  /** The exact live origin already included in the H3 handoff. */
  readonly packageOrigin: VerifiedInstalledComponentOrigin;
  readonly installedModule: ReservedV10InstalledModulePlan;
}

/**
 * Internal, product-before-bootstrap composition for reserved version 10.
 * Package bytes and configuration are read from the current Runtime authority
 * snapshot; the caller cannot provide a replacement configuration or live
 * activation fields. This result starts no process and reports no readiness.
 */
export interface InstalledModuleActivationCandidate {
  readonly schemaVersion: "dolly.installed-module-activation-candidate/1";
  readonly controllerGenerationId: string;
  readonly configRevision: number;
  readonly configDigest: string;
  readonly premisesDigest: string;
  readonly serviceBinding: LinuxModuleActivationHandoff["serviceBinding"];
  readonly runtimeBinding: LinuxModuleActivationHandoff["runtimeBinding"];
  readonly delegatedRoot: LinuxModuleActivationHandoff["delegatedRoot"];
  readonly installedComponentOrigins: readonly VerifiedInstalledComponentOrigin[];
  readonly activationPermission: LinuxModuleActivationPermission;
  readonly modules: readonly InstalledModuleActivationCandidateModule[];
}

const CANDIDATE_BRAND = new WeakSet<object>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOptions(
  value: unknown,
): asserts value is InstalledModuleActivationCandidateOptions {
  if (!isPlainObject(value)) {
    throw new TypeError("installed Module activation candidate options must be a plain object");
  }
  const expected = [
    "configurations",
    "controller",
    "database",
    "handoff",
    "installations",
    "origins",
  ];
  const keys = Object.keys(value).sort();
  const sortedExpected = expected.slice().sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(
      `installed Module activation candidate contains unknown fields: ${keys.join(", ")}`,
    );
  }
  if (!(value.database instanceof RuntimeAuthorityDatabase)) {
    throw new TypeError("installed Module activation candidate requires the Runtime authority database");
  }
  if (!(value.controller instanceof InstanceControllerLock)) {
    throw new TypeError("installed Module activation candidate requires the instance controller");
  }
  if (!(value.origins instanceof InstalledComponentOriginRegistry)) {
    throw new TypeError("installed Module activation candidate requires the origin registry");
  }
  if (!(value.installations instanceof ExtensionInstallationRegistry)) {
    throw new TypeError("installed Module activation candidate requires the installation registry");
  }
  if (!(value.configurations instanceof ModuleConfigurationStore)) {
    throw new TypeError("installed Module activation candidate requires the configuration store");
  }
  if (!isPlainObject(value.handoff)) {
    throw new TypeError("installed Module activation candidate requires an H3 handoff");
  }
}

function runtimeConfiguration(
  options: InstalledModuleActivationCandidateOptions,
): JsonValue {
  assertStartupAuthorityPermissionContext(
    options.handoff.startupAuthorityPermission,
    options,
  );
  const snapshot = options.database.readCurrentConfig();
  if (snapshot === null) {
    throw new TypeError("installed Module activation candidate has no current authority configuration");
  }
  if (
    snapshot.config_revision !== options.handoff.configRevision ||
    snapshot.config_digest !== options.handoff.configDigest
  ) {
    throw new TypeError(
      "installed Module activation candidate handoff is stale for the current authority configuration",
    );
  }
  if (!isPlainObject(snapshot.canonicalConfig)) {
    throw new TypeError(
      "installed Module activation candidate authority configuration is not an object",
    );
  }
  const runtimeConfig = Reflect.get(snapshot.canonicalConfig, "runtime_config");
  if (runtimeConfig === undefined) {
    throw new TypeError(
      "installed Module activation candidate authority configuration has no runtime_config",
    );
  }
  return runtimeConfig as JsonValue;
}

function packageOrigin(
  plan: ReservedV10InstalledModulePlan,
  handoff: LinuxModuleActivationHandoff,
  origins: InstalledComponentOriginRegistry,
): VerifiedInstalledComponentOrigin {
  const extensionId = plan.installation.manifest.extensionId;
  const packageDigest = plan.installation.packageDigest;
  const origin = handoff.installedComponentOrigins.find(
    (candidate) =>
      candidate.component_id === extensionId &&
      candidate.component_digest === packageDigest,
  );
  if (origin === undefined) {
    throw new TypeError(
      `installed Module ${plan.module.moduleId} package has no matching H3 component origin`,
    );
  }
  origins.assertCurrent(origin);
  return origin;
}

/**
 * Consumes one exact H3 handoff after all read-only package checks succeed.
 * A failed package check leaves the handoff available for a corrected retry;
 * a successful call consumes it exactly once.
 */
export function composeInstalledModuleActivationCandidate(
  options: InstalledModuleActivationCandidateOptions,
): InstalledModuleActivationCandidate {
  assertOptions(options);
  const runtimeConfig = runtimeConfiguration(options);
  const configuration = validateDollyInstanceConfigV10Draft(runtimeConfig);
  const packageManifests = new Map<string, ReservedV10InstalledExtensionPackageManifest>();
  const modules = configuration.modules.map((module) => {
    const installation = options.installations.resolve({
      extensionId: module.extensionId,
      packageVersion: module.packageVersion,
    });
    const packageKey = `${module.extensionId}\u0000${module.packageVersion}`;
    let installedPackageManifest = packageManifests.get(packageKey);
    if (
      installedPackageManifest === undefined &&
      installation.manifest.schemaVersion === "dolly.extension-package/10"
    ) {
      installedPackageManifest = produceReservedV10ExtensionPackageManifest({
        installations: options.installations,
        origins: options.origins,
        database: options.database,
        extensionId: module.extensionId,
        packageVersion: module.packageVersion,
      });
      packageManifests.set(packageKey, installedPackageManifest);
    }
    const installedModule = resolveReservedV10InstalledModulePlan({
      instanceConfiguration: configuration,
      moduleId: module.moduleId,
      installations: options.installations,
      configurations: options.configurations,
      ...(installedPackageManifest === undefined
        ? {}
        : {
            installedPackageManifest,
            packageOrigins: options.origins,
            packageDatabase: options.database,
          }),
    });
    return Object.freeze({
      moduleId: module.moduleId,
      packageOrigin: packageOrigin(installedModule, options.handoff, options.origins),
      installedModule,
    });
  });
  if (modules.length === 0) {
    throw new TypeError("installed Module activation candidate requires at least one Module");
  }
  const activationPermission = consumeLinuxModuleActivationHandoff({
    handoff: options.handoff,
    startupAuthorityPermission: options.handoff.startupAuthorityPermission,
  });
  const candidate = Object.freeze({
    schemaVersion: "dolly.installed-module-activation-candidate/1" as const,
    controllerGenerationId: options.handoff.controllerGenerationId,
    configRevision: options.handoff.configRevision,
    configDigest: options.handoff.configDigest,
    premisesDigest: options.handoff.premisesDigest,
    serviceBinding: options.handoff.serviceBinding,
    runtimeBinding: options.handoff.runtimeBinding,
    delegatedRoot: options.handoff.delegatedRoot,
    installedComponentOrigins: options.handoff.installedComponentOrigins,
    activationPermission,
    modules: Object.freeze(modules),
  });
  CANDIDATE_BRAND.add(candidate);
  return candidate;
}

/** Rejects copied or deserialized candidate composition results. */
export function assertInstalledModuleActivationCandidate(
  value: unknown,
): asserts value is InstalledModuleActivationCandidate {
  if (
    value === null ||
    typeof value !== "object" ||
    !CANDIDATE_BRAND.has(value)
  ) {
    throw new TypeError(
      "installed Module activation candidate was not minted by H3 handoff composition",
    );
  }
}
