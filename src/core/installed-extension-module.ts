import type { JsonValue } from "./canonical-json.js";
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
