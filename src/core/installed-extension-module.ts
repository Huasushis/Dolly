import {
  canonicalJsonDigest,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  ContentSchemaRegistrationSet,
  type ContentSchemaRegistrationInput,
  type ContentSchemaModule,
} from "./content-schema-registry.js";
import {
  assertExtensionModuleCompatibility,
  ExtensionInstallationRegistry,
  type ExtensionPackageModule,
  type ExtensionPackageModuleV10,
  type ResolvedExtensionInstallation,
} from "./extension-installation-registry.js";
import {
  ModuleConfigurationStore,
  type ModuleConfigurationRecord,
} from "./module-configuration-store.js";
import {
  validateDollyInstanceConfig,
  type DollyInstanceConfig,
  type DollyModuleConfig,
} from "./runtime-config.js";
import {
  validateDollyInstanceConfigV10Draft,
  type DollyModuleConfigV10,
} from "./runtime-config-v10.js";
import { InstalledComponentOriginRegistry } from "./installed-component-origin.js";
import { RuntimeAuthorityDatabase } from "../adapters/storage/runtime-authority-database.js";
import { assertCurrentReservedV10ExtensionPackageManifest } from "./reserved-v10-extension-package.js";

export interface InstalledExtensionModule {
  readonly instanceId: string;
  readonly module: Readonly<DollyModuleConfig>;
  readonly installation: Readonly<ResolvedExtensionInstallation>;
  readonly packageModule: Readonly<ExtensionPackageModule>;
  readonly configuration: Readonly<ModuleConfigurationRecord>;
}

export interface ResolveInstalledExtensionModuleOptions {
  /** The complete instance document is validated again before any lookup. */
  readonly instanceConfiguration: DollyInstanceConfig;
  readonly moduleId: string;
  readonly installations: ExtensionInstallationRegistry;
  readonly configurations: ModuleConfigurationStore;
}

export interface ReservedV10InstalledModulePlan {
  readonly instanceId: string;
  /** Digest of the complete, revalidated reserved version-10 document. */
  readonly instanceConfigurationDigest: string;
  readonly module: Readonly<DollyModuleConfigV10>;
  readonly installation: Readonly<ResolvedExtensionInstallation>;
  readonly packageModule: Readonly<ExtensionPackageModule>;
  readonly configuration: Readonly<ModuleConfigurationRecord>;
  /**
   * Closed canonical preimage for the future process-record/2 composition.
   * It contains every configuration, package, trust, policy, and execution
   * value that can change how this installed Module runs.
   */
  readonly provenance: JsonValue;
  readonly provenanceDigest: string;
}
export interface ResolveReservedV10InstalledModulePlanOptions {
  /** The complete reserved version-10 document is validated again before I/O. */
  readonly instanceConfiguration: JsonValue;
  readonly moduleId: string;
  readonly installations: ExtensionInstallationRegistry;
  readonly configurations: ModuleConfigurationStore;
  /**
   * Non-empty v10 capability packages must carry the installer-produced
   * provenance artifact and the durable policy/origin authorities into the
   * plan consumer. Older schemas never accept these fields.
   */
  readonly installedPackageManifest?: unknown;
  readonly packageOrigins?: InstalledComponentOriginRegistry;
  readonly packageDatabase?: RuntimeAuthorityDatabase;
}

const RESERVED_V10_INSTALLED_MODULE_PLANS = new WeakSet<object>();

/** Rejects structurally forged plans at internal composition boundaries. */
export function assertReservedV10InstalledModulePlan(
  value: unknown,
): asserts value is ReservedV10InstalledModulePlan {
  if (
    value === null ||
    typeof value !== "object" ||
    !RESERVED_V10_INSTALLED_MODULE_PLANS.has(value)
  ) {
    throw new TypeError(
      "Reserved version-10 installed Module plan was not minted by the store-bound resolver",
    );
  }
}

export interface ResolveInstalledContentSchemaRegistrationSetOptions {
  /** The complete instance document is validated again before any lookup. */
  readonly instanceConfiguration: DollyInstanceConfig;
  readonly installations: ExtensionInstallationRegistry;
  /** Host-owned registrations and producer grants for `dolly.` names. */
  readonly reservedRegistrations: readonly Extract<
    ContentSchemaRegistrationInput,
    { readonly source: "deployment" }
  >[];
  readonly maxRegisteredValueBytes: number;
}

/**
 * Resolves one configured Module without executing Extension code.
 *
 * Package identity, package bytes, Module declaration, configuration schema,
 * and configuration bytes all come from their integrity-checking stores. The
 * returned object is the only input the installed Linux executor composition
 * accepts; callers do not separately supply a manifest, entrypoint, trust, or
 * configuration value.
 */
export function resolveInstalledExtensionModule(
  options: ResolveInstalledExtensionModuleOptions,
): InstalledExtensionModule {
  if (!(options.installations instanceof ExtensionInstallationRegistry)) {
    throw new TypeError("installations must be an ExtensionInstallationRegistry");
  }
  if (!(options.configurations instanceof ModuleConfigurationStore)) {
    throw new TypeError("configurations must be a ModuleConfigurationStore");
  }
  const configuration = validateDollyInstanceConfig(
    options.instanceConfiguration as unknown as JsonValue,
  );
  const module = configuration.modules.find((candidate) =>
    candidate.moduleId === options.moduleId
  );
  if (!module) {
    throw new TypeError(`Instance does not contain Module ${options.moduleId}`);
  }
  const installation = options.installations.resolve({
    extensionId: module.extensionId,
    packageVersion: module.packageVersion,
  });
  assertExtensionModuleCompatibility(installation.manifest, {
    extensionId: module.extensionId,
    packageVersion: module.packageVersion,
    moduleKind: module.moduleKind,
    configVersion: module.configurationReference.configVersion,
    activation: module.activation.kind,
  });
  const packageModule = installation.manifest.modules.find((candidate) =>
    candidate.moduleKind === module.moduleKind
  );
  if (!packageModule) {
    // The compatibility check above already rejects this. Keeping the local
    // guard prevents a future refactor from replacing proof with `!`.
    throw new TypeError(`Installed package does not contain Module ${module.moduleKind}`);
  }
  const resolvedConfiguration = options.configurations.resolve({
    configId: module.configurationReference.configId,
    revision: module.configurationReference.revision,
    extensionId: module.extensionId,
    moduleKind: module.moduleKind,
    configVersion: module.configurationReference.configVersion,
    schema: packageModule.configurationSchema,
  });
  return Object.freeze({
    instanceId: configuration.instanceId,
    module,
    installation,
    packageModule,
    configuration: resolvedConfiguration,
  });
}

/**
 * Resolves the installation and immutable Module configuration selected by a
 * complete reserved version-10 document without starting a process or writing
 * Core state.
 *
 * The returned provenance digest is deliberately broader than the existing
 * process-record/1 shape. A later Linux composition may consume this one plan;
 * it must not accept caller replacements for limits, effects, policy
 * revisions, package trust, or configuration bytes. This does not register
 * version 10 with public bootstrap and is not itself activation authority.
 */
export function resolveReservedV10InstalledModulePlan(
  options: ResolveReservedV10InstalledModulePlanOptions,
): ReservedV10InstalledModulePlan {
  const expectedOptionKeys = new Set([
    "instanceConfiguration",
    "moduleId",
    "installations",
    "configurations",
    "installedPackageManifest",
    "packageOrigins",
    "packageDatabase",
  ]);
  const unexpectedOptionKeys = Object.keys(options)
    .filter((key) => !expectedOptionKeys.has(key))
    .sort();
  if (unexpectedOptionKeys.length > 0) {
    throw new TypeError(
      `Reserved version-10 installed Module resolution contains unknown fields: ${unexpectedOptionKeys.join(", ")}`,
    );
  }
  if (!(options.installations instanceof ExtensionInstallationRegistry)) {
    throw new TypeError("installations must be an ExtensionInstallationRegistry");
  }
  if (!(options.configurations instanceof ModuleConfigurationStore)) {
    throw new TypeError("configurations must be a ModuleConfigurationStore");
  }

  const instanceConfiguration = validateDollyInstanceConfigV10Draft(
    options.instanceConfiguration,
  );
  const module = instanceConfiguration.modules.find((candidate) =>
    candidate.moduleId === options.moduleId
  );
  if (module === undefined) {
    throw new TypeError(`Instance does not contain Module ${options.moduleId}`);
  }

  const installation = options.installations.resolve({
    extensionId: module.extensionId,
    packageVersion: module.packageVersion,
  });
  assertExtensionModuleCompatibility(installation.manifest, {
    extensionId: module.extensionId,
    packageVersion: module.packageVersion,
    moduleKind: module.moduleKind,
    configVersion: module.configurationReference.configVersion,
    activation: module.activation.kind,
  });
  if (
    module.permissionPolicyReferences.length > 0 &&
    installation.manifest.requestedCapabilities.length === 0
  ) {
    throw new TypeError(
      `Installed package schema ${installation.manifest.schemaVersion} cannot be bound to permission policies because it requests no capabilities`,
    );
  }
  const packageModule = installation.manifest.modules.find((candidate) =>
    candidate.moduleKind === module.moduleKind
  );
  if (packageModule === undefined) {
    throw new TypeError(`Installed package does not contain Module ${module.moduleKind}`);
  }
  if (installation.manifest.schemaVersion === "dolly.extension-package/10") {
    if (
      options.installedPackageManifest === undefined ||
      !(options.packageOrigins instanceof InstalledComponentOriginRegistry) ||
      !(options.packageDatabase instanceof RuntimeAuthorityDatabase)
    ) {
      throw new TypeError(
        "reserved version-10 module plans require the installer manifest and durable package authorities",
      );
    }
    assertCurrentReservedV10ExtensionPackageManifest(options.installedPackageManifest, {
      installations: options.installations,
      origins: options.packageOrigins,
      database: options.packageDatabase,
    });
    const packageModuleForPolicy = installation.manifest.modules.find(
      (candidate): candidate is ExtensionPackageModuleV10 =>
        candidate.moduleKind === module.moduleKind,
    );
    if (packageModuleForPolicy === undefined) {
      throw new TypeError(`Installed package does not contain Module ${module.moduleKind}`);
    }
    const capabilityReferences = installation.manifest.requestedCapabilities
      .filter((capability) => capability.moduleKind === module.moduleKind)
      .map((capability) => `${capability.policyId}\u0000${capability.policyRevision}`)
      .sort();
    const packageReferences = packageModuleForPolicy.permissionPolicyReferences
      .map((reference) => `${reference.policyId}\u0000${reference.revision}`)
      .sort();
    if (canonicalJsonDigest(capabilityReferences) !== canonicalJsonDigest(packageReferences)) {
      throw new TypeError(
        `Module ${module.moduleKind} policy references do not exactly match package capabilities`,
      );
    }
  }
  const configuration = options.configurations.resolve({
    configId: module.configurationReference.configId,
    revision: module.configurationReference.revision,
    extensionId: module.extensionId,
    moduleKind: module.moduleKind,
    configVersion: module.configurationReference.configVersion,
    schema: packageModule.configurationSchema,
  });

  const instanceConfigurationDigest = canonicalJsonDigest(instanceConfiguration);
  const provenance = deepFreeze({
    schemaVersion: "dolly.reserved-v10-installed-module-plan/1",
    instanceId: instanceConfiguration.instanceId,
    instanceConfigurationDigest,
    module: module as unknown as JsonValue,
    installation: {
      extensionId: installation.manifest.extensionId,
      packageVersion: installation.manifest.packageVersion,
      packageDigest: installation.packageDigest,
      trust: installation.trust,
      moduleKind: packageModule.moduleKind,
    },
    configuration: {
      configId: configuration.configId,
      revision: configuration.revision,
      configVersion: configuration.configVersion,
      schemaDigest: configuration.schemaDigest,
      configurationDigest: configuration.configurationDigest,
    },
  } satisfies JsonValue);

  const plan = Object.freeze({
    instanceId: instanceConfiguration.instanceId,
    instanceConfigurationDigest,
    module,
    installation,
    packageModule,
    configuration,
    provenance,
    provenanceDigest: canonicalJsonDigest(provenance),
  });
  RESERVED_V10_INSTALLED_MODULE_PLANS.add(plan);
  return plan;
}

/**
 * Resolves the complete content schema registration set from verified package
 * installations before any Extension code runs. Package declarations and
 * deployment-owned reserved-name grants enter through separate inputs, so a
 * package cannot turn its own manifest into host authority.
 */
export function resolveInstalledContentSchemaRegistrationSet(
  options: ResolveInstalledContentSchemaRegistrationSetOptions,
): ContentSchemaRegistrationSet {
  if (!(options.installations instanceof ExtensionInstallationRegistry)) {
    throw new TypeError("installations must be an ExtensionInstallationRegistry");
  }
  if (!Array.isArray(options.reservedRegistrations)) {
    throw new TypeError("reservedRegistrations must be an array");
  }
  const configuration = validateDollyInstanceConfig(
    options.instanceConfiguration as unknown as JsonValue,
  );
  const modules: ContentSchemaModule[] = [];
  const registrations: ContentSchemaRegistrationInput[] = [
    ...options.reservedRegistrations,
  ];
  for (const module of configuration.modules) {
    const installation = options.installations.resolve({
      extensionId: module.extensionId,
      packageVersion: module.packageVersion,
    });
    assertExtensionModuleCompatibility(installation.manifest, {
      extensionId: module.extensionId,
      packageVersion: module.packageVersion,
      moduleKind: module.moduleKind,
      configVersion: module.configurationReference.configVersion,
      activation: module.activation.kind,
    });
    const packageModule = installation.manifest.modules.find((candidate) =>
      candidate.moduleKind === module.moduleKind
    );
    if (packageModule === undefined) {
      throw new TypeError(`Installed package does not contain Module ${module.moduleKind}`);
    }
    const producer = {
      extensionId: installation.manifest.extensionId,
      packageVersion: installation.manifest.packageVersion,
      moduleKind: packageModule.moduleKind,
    } as const;
    modules.push({ moduleId: module.moduleId, ...producer });
    if (
      installation.manifest.schemaVersion === "dolly.extension-package/2" ||
      installation.manifest.schemaVersion === "dolly.extension-package/3" ||
      installation.manifest.schemaVersion === "dolly.extension-package/4" ||
      installation.manifest.schemaVersion === "dolly.extension-package/10"
    ) {
      const versionedModule = installation.manifest.modules.find((candidate) =>
        candidate.moduleKind === module.moduleKind
      );
      if (versionedModule === undefined) {
        throw new TypeError(`Installed package does not contain Module ${module.moduleKind}`);
      }
      for (const declaration of versionedModule.producedContentSchemas) {
        registrations.push({
          source: "extension-package",
          schema: declaration.schema,
          producer,
          validator: declaration.validator,
          validatorDigest: declaration.validatorDigest,
          maxValueBytes: declaration.maxValueBytes,
          containsCoreReferences: false,
        });
      }
    }
  }
  return new ContentSchemaRegistrationSet({
    modules,
    registrations,
    maxRegisteredValueBytes: options.maxRegisteredValueBytes,
  });
}
