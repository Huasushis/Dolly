import type { JsonValue } from "./canonical-json.js";
import {
  ContentSchemaRegistrationSet,
  type ContentSchemaRegistrationInput,
  type ContentSchemaModule,
} from "./content-schema-registry.js";
import {
  assertExtensionModuleCompatibility,
  ExtensionInstallationRegistry,
  type ExtensionPackageModule,
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
      installation.manifest.schemaVersion === "dolly.extension-package/3"
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
