import type { ExtensionInstallationRegistry } from "../core/extension-installation-registry.js";
import {
  resolveInstalledExtensionModule,
  type InstalledExtensionModule,
} from "../core/installed-extension-module.js";
import { deriveModuleCgroupPath } from "../core/linux-module-cgroup.js";
import type { VerifiedCoreServiceBinding } from "../core/linux-core-service-binding.js";
import type { ModuleExecutor } from "../core/module-actor.js";
import type { ModuleConfigurationStore } from "../core/module-configuration-store.js";
import {
  assertValidModuleProcessRecord,
  type DeclaredExternalEffects,
  type ModuleProcessRecord,
} from "../core/module-process-records.js";
import type { ReactiveModuleInput } from "../core/reactive-module-input.js";
import type { ReactiveModuleResult } from "../core/reactive-module-runtime.js";
import type { DollyInstanceConfig } from "../core/runtime-config.js";
import {
  createLinuxExtensionModuleExecutor,
  type LinuxExtensionModuleExecutorOptions,
} from "./linux-extension-module-executor.js";

type InstalledLifecycleOptions = Omit<
  LinuxExtensionModuleExecutorOptions["lifecycle"],
  "delegatedRootCgroupPath" | "execution" | "processRecord"
>;
type InstalledHostOptions = Omit<
  LinuxExtensionModuleExecutorOptions["host"],
  "config" | "manifest" | "moduleKind" | "trust"
>;
type ProcessRecordDetails = Pick<ModuleProcessRecord, "createdAt" | "updatedAt">;
type InstalledLauncherOptions = Omit<
  LinuxExtensionModuleExecutorOptions["launcher"],
  "launcherEnvironment"
>;

export interface InstalledLinuxExtensionModuleExecutorOptions {
  readonly instanceConfiguration: DollyInstanceConfig;
  readonly moduleId: string;
  readonly installations: ExtensionInstallationRegistry;
  readonly configurations: ModuleConfigurationStore;
  readonly moduleGenerationId: string;
  /** Exact systemd/Core binding verified before Module activation. */
  readonly binding: VerifiedCoreServiceBinding;
  readonly lifecycle: InstalledLifecycleOptions;
  readonly processRecord: ProcessRecordDetails;
  readonly declaredExternalEffects: DeclaredExternalEffects;
  readonly launcher: InstalledLauncherOptions;
  readonly host: InstalledHostOptions;
  readonly executionTimeoutMs: number;
  readonly cancellationGraceMs: number;
  readonly terminationTimeoutMs: number;
  readonly channelCloseTimeoutMs: number;
  readonly coreExitCleanupTimeoutMs?: number;
  readonly exitCoreProcess?: (status: number) => void;
  readonly nextProtocolIdentifier?: (purpose: "session" | "request") => string;
  readonly configureHost?: LinuxExtensionModuleExecutorOptions["configureHost"];
  readonly onStandardErrorChunk?: LinuxExtensionModuleExecutorOptions["onStandardErrorChunk"];
}

export interface InstalledLinuxExtensionModuleExecutorDerivation {
  readonly resolvedModule: InstalledExtensionModule;
  readonly executorOptions: LinuxExtensionModuleExecutorOptions;
}

function assertNoDerivedFields(
  value: object,
  forbidden: readonly string[],
  label: string,
): void {
  const found = forbidden.filter((field) => Object.hasOwn(value, field));
  if (found.length > 0) {
    throw new TypeError(`${label} cannot supply derived fields: ${found.sort().join(", ")}`);
  }
}

/**
 * Deterministically derives every package/configuration-sensitive low-level
 * option before a launcher exists. This function is exported for conformance
 * inspection; product callers should use `createInstalledLinuxExtensionModuleExecutor`.
 */
export function deriveInstalledLinuxExtensionModuleExecutor(
  options: InstalledLinuxExtensionModuleExecutorOptions,
): InstalledLinuxExtensionModuleExecutorDerivation {
  assertNoDerivedFields(
    options.lifecycle,
    ["delegatedRootCgroupPath", "execution", "processRecord"],
    "lifecycle",
  );
  assertNoDerivedFields(options.launcher, ["launcherEnvironment"], "launcher");
  assertNoDerivedFields(
    options.host,
    ["config", "manifest", "moduleKind", "trust"],
    "host",
  );
  assertNoDerivedFields(
    options.processRecord,
    [
      "configurationReference",
      "declaredExternalEffects",
      "bootId",
      "instanceId",
      "moduleCgroupPath",
      "moduleGenerationId",
      "moduleId",
      "packageDigest",
      "processGenerationId",
      "schemaVersion",
      "serviceInvocationId",
      "state",
    ],
    "processRecord",
  );
  const resolvedModule = resolveInstalledExtensionModule({
    instanceConfiguration: options.instanceConfiguration,
    moduleId: options.moduleId,
    installations: options.installations,
    configurations: options.configurations,
  });
  const { identity } = options.lifecycle;
  if (
    identity.instanceId !== resolvedModule.instanceId ||
    identity.moduleId !== resolvedModule.module.moduleId
  ) {
    throw new TypeError("Linux process identity does not match the resolved instance Module");
  }
  const derivedCgroupPath = deriveModuleCgroupPath(
    options.binding.delegatedRootCgroupPath,
    identity,
  ).filesystemPath;
  // This executor is deliberately process-isolated, not sandboxed. Resolve
  // the Host policy before any launcher exists so an untrusted package cannot
  // be started and rejected only after process creation.
  options.host.isolationPolicy.resolve("process", resolvedModule.installation.trust);
  const processRecord = Object.freeze({
    schemaVersion: "dolly.module-process-record/1" as const,
    instanceId: identity.instanceId,
    moduleId: identity.moduleId,
    moduleGenerationId: options.moduleGenerationId,
    processGenerationId: identity.processGenerationId,
    packageDigest: resolvedModule.installation.packageDigest,
    configurationReference: Object.freeze({
      ...resolvedModule.module.configurationReference,
    }),
    declaredExternalEffects: options.declaredExternalEffects,
    serviceInvocationId: options.binding.serviceInvocationId,
    bootId: options.binding.bootId,
    moduleCgroupPath: derivedCgroupPath,
    ...options.processRecord,
    state: "starting" as const,
  });
  // Reuse the durable-store validator so malformed binding identifiers or
  // timestamps cannot be deferred until after process creation.
  assertValidModuleProcessRecord(processRecord);
  const executorOptions: LinuxExtensionModuleExecutorOptions = {
    moduleId: resolvedModule.module.moduleId,
    moduleGenerationId: options.moduleGenerationId,
    lifecycle: {
      ...options.lifecycle,
      delegatedRootCgroupPath: options.binding.delegatedRootCgroupPath,
      processRecord,
      execution: {
        program: process.execPath,
        argumentVector: [process.execPath, resolvedModule.installation.entrypointPath],
        // Module authority is granted through Host capabilities, never ambient
        // process variables inherited from Core or its service manager.
        environment: Object.freeze({}),
      },
    },
    launcher: {
      ...options.launcher,
      launcherEnvironment: Object.freeze({}),
    },
    host: {
      ...options.host,
      trust: resolvedModule.installation.trust,
      manifest: resolvedModule.installation.manifest,
      moduleKind: resolvedModule.module.moduleKind,
      config: resolvedModule.configuration.configuration,
    },
    executionTimeoutMs: options.executionTimeoutMs,
    cancellationGraceMs: options.cancellationGraceMs,
    terminationTimeoutMs: options.terminationTimeoutMs,
    channelCloseTimeoutMs: options.channelCloseTimeoutMs,
    ...(options.coreExitCleanupTimeoutMs === undefined
      ? {}
      : { coreExitCleanupTimeoutMs: options.coreExitCleanupTimeoutMs }),
    ...(options.exitCoreProcess === undefined
      ? {}
      : { exitCoreProcess: options.exitCoreProcess }),
    ...(options.nextProtocolIdentifier === undefined
      ? {}
      : { nextProtocolIdentifier: options.nextProtocolIdentifier }),
    ...(options.configureHost === undefined
      ? {}
      : { configureHost: options.configureHost }),
    ...(options.onStandardErrorChunk === undefined
      ? {}
      : { onStandardErrorChunk: options.onStandardErrorChunk }),
  };
  return Object.freeze({
    resolvedModule,
    executorOptions: Object.freeze(executorOptions),
  });
}

/** Builds one unstarted Linux executor from one verified installation/configuration resolution. */
export function createInstalledLinuxExtensionModuleExecutor(
  options: InstalledLinuxExtensionModuleExecutorOptions,
): ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult> {
  return createLinuxExtensionModuleExecutor(
    deriveInstalledLinuxExtensionModuleExecutor(options).executorOptions,
  );
}
