import { randomUUID } from "node:crypto";
import type { ExtensionInstallationRegistry } from "../core/extension-installation-registry.js";
import type { ExtensionSessionIdentity } from "../core/extension-capability.js";
import type { ExtensionProcessHost } from "../core/extension-process-host.js";
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
  type ModuleProcessRecord,
} from "../core/module-process-records.js";
import type { ReactiveModuleInput } from "../core/reactive-module-input.js";
import type { ReactiveModuleResult } from "../core/reactive-module-runtime.js";
import type { DollyInstanceConfig } from "../core/runtime-config.js";
import type { InstalledModulePermissionPolicySetup } from "./installed-module-permission-policy.js";
import {
  deriveLinuxProcessConfinementExecution,
  LINUX_PROCESS_CONFINEMENT_PROGRAM,
} from "./linux-process-confinement.js";
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
  /** Directory of the exact FileCore state store owned by this runtime. */
  readonly coreStateDirectory: string;
  /** Exact systemd/Core binding verified before Module activation. */
  readonly binding: VerifiedCoreServiceBinding;
  readonly lifecycle: InstalledLifecycleOptions;
  readonly processRecord: ProcessRecordDetails;
  readonly launcher: InstalledLauncherOptions;
  readonly host: InstalledHostOptions;
  readonly executionTimeoutMs: number;
  readonly cancellationGraceMs: number;
  readonly terminationTimeoutMs: number;
  readonly channelCloseTimeoutMs: number;
  readonly coreExitCleanupTimeoutMs?: number;
  readonly exitCoreProcess?: (status: number) => void;
  readonly nextProtocolIdentifier?: (purpose: "session" | "request") => string;
  /** Host grants derived from the exact installed Module's selected policies. */
  readonly permissionPolicySetup?: InstalledModulePermissionPolicySetup;
  /** Finite diagnostic observer; it receives no Host or capability authority. */
  readonly onAuthorizedProcessId?: (processId: number) => void;
  readonly onStandardErrorChunk?: LinuxExtensionModuleExecutorOptions["onStandardErrorChunk"];
}

/**
 * Ordinary process isolation cannot prove the absence of ambient effects.
 * Until a closed instance schema and effect-evidence composition exist, an
 * installed process is recorded in the disposition that preserves submitted
 * failures instead of treating them as safe to retry.
 */
export const INSTALLED_PROCESS_EFFECT_DECLARATION =
  "unrestricted" as const;

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
  if (Object.hasOwn(options, "configureHost")) {
    throw new TypeError(
      "Installed Linux Extension executor cannot accept an arbitrary Host setup callback",
    );
  }
  if (Object.hasOwn(options, "declaredExternalEffects")) {
    throw new TypeError(
      "Installed Linux Extension executor cannot accept a caller-supplied external-effect declaration",
    );
  }
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
  if (resolvedModule.module.permissionPolicyIds.length === 0) {
    if (options.permissionPolicySetup !== undefined) {
      throw new TypeError(
        "Installed Module without permission policies cannot receive a Host permission setup",
      );
    }
  } else {
    if (options.permissionPolicySetup === undefined) {
      throw new TypeError(
        "Installed Module permission policies require a registry-derived Host setup",
      );
    }
    options.permissionPolicySetup.assertMatches(resolvedModule);
  }
  if (resolvedModule.module.isolation !== "process") {
    throw new TypeError(
      "Installed Linux Extension executor requires process isolation in the instance configuration",
    );
  }
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
    declaredExternalEffects: INSTALLED_PROCESS_EFFECT_DECLARATION,
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
      execution: deriveLinuxProcessConfinementExecution({
        bubblewrapProgram: LINUX_PROCESS_CONFINEMENT_PROGRAM,
        nodeProgram: process.execPath,
        installationDirectory: resolvedModule.installation.workingDirectory,
        entrypointPath: resolvedModule.installation.entrypointPath,
        coreStateDirectory: options.coreStateDirectory,
      }),
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
    ...(options.permissionPolicySetup === undefined &&
      options.onAuthorizedProcessId === undefined
      ? {}
      : {
          configureHost: (host, process) => {
            options.permissionPolicySetup?.configureHost(host);
            options.onAuthorizedProcessId?.(process.launcher.processId);
          },
        }),
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

type InstalledGenerationLifecycleOptions = Omit<InstalledLifecycleOptions, "identity">;

export interface InstalledLinuxExtensionModuleGenerationFactoryOptions extends Omit<
  InstalledLinuxExtensionModuleExecutorOptions,
  "lifecycle" | "moduleGenerationId" | "processRecord"
> {
  readonly lifecycle: InstalledGenerationLifecycleOptions;
  /** Generates one never-reused process identity for each Module generation. */
  readonly nextProcessGenerationId?: () => string;
  /** Supplies the process-record timestamp without mixing it with monotonic scheduling time. */
  readonly wallClockNow?: () => number;
}

export interface InstalledLinuxExtensionModuleGenerationFactory {
  readonly createExecutor: (
    moduleGenerationId: string,
  ) => ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult>;
  /**
   * Returns the exact process generation that owns submissions from this
   * Module generation. It is unavailable until `createExecutor` succeeds.
   */
  readonly processGenerationIdFor: (moduleGenerationId: string) => string;
  /**
   * Returns the live protocol identity minted by the exact Host that owns this
   * process generation. Created, stopping, stopped, and failed Hosts are not
   * active sessions and therefore return null.
   */
  readonly sessionForProcess: (
    processGenerationId: string,
  ) => ExtensionSessionIdentity | null;
}

function processGenerationTimestamp(wallClockNow: () => number): string {
  const milliseconds = wallClockNow();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError("Module process record wall clock must be a non-negative safe integer");
  }
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    throw new TypeError("Module process record wall clock is outside the ISO timestamp range");
  }
}

/**
 * Owns the one-to-one Module-generation to process-generation mapping used by
 * both executor creation and durable submission records. Creating the factory
 * or an executor starts no process; `ModuleActor` remains the owner of start.
 */
export function createInstalledLinuxExtensionModuleGenerationFactory(
  options: InstalledLinuxExtensionModuleGenerationFactoryOptions,
): InstalledLinuxExtensionModuleGenerationFactory {
  const {
    lifecycle,
    nextProcessGenerationId: nextProcessGenerationIdOption,
    wallClockNow: wallClockNowOption,
    ...fixedOptions
  } = options;
  const initiallyResolved = resolveInstalledExtensionModule({
    instanceConfiguration: fixedOptions.instanceConfiguration,
    moduleId: fixedOptions.moduleId,
    installations: fixedOptions.installations,
    configurations: fixedOptions.configurations,
  });
  const nextProcessGenerationId = nextProcessGenerationIdOption ??
    (() => `process-${randomUUID()}`);
  const wallClockNow = wallClockNowOption ?? Date.now;
  const processByModuleGeneration = new Map<string, string>();
  const usedProcessGenerations = new Set<string>();
  const hostByProcessGeneration = new Map<string, ExtensionProcessHost>();

  const createExecutor = (
    moduleGenerationId: string,
  ): ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult> => {
    if (processByModuleGeneration.has(moduleGenerationId)) {
      throw new TypeError(
        `Module generation ${moduleGenerationId} already has an installed Linux executor`,
      );
    }
    const processGenerationId = nextProcessGenerationId();
    if (
      usedProcessGenerations.has(processGenerationId) ||
      lifecycle.records.getModuleProcessRecord(processGenerationId) !== undefined
    ) {
      throw new TypeError(
        `Process generation ${processGenerationId} has already been used`,
      );
    }
    // Reserve even an invalid generated value locally. A generator that emits
    // it again remains fail-closed instead of turning a failed construction
    // into an identity-reuse path.
    usedProcessGenerations.add(processGenerationId);
    const timestamp = processGenerationTimestamp(wallClockNow);
    const derived = deriveInstalledLinuxExtensionModuleExecutor({
      ...fixedOptions,
      moduleGenerationId,
      lifecycle: {
        ...lifecycle,
        identity: {
          instanceId: initiallyResolved.instanceId,
          moduleId: initiallyResolved.module.moduleId,
          processGenerationId,
        },
      },
      processRecord: {
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    const configuredHost = derived.executorOptions.configureHost;
    const executor = createLinuxExtensionModuleExecutor({
      ...derived.executorOptions,
      configureHost: (host, process) => {
        configuredHost?.(host, process);
        const snapshot = host.snapshot;
        if (
          snapshot.state !== "created" ||
          snapshot.instanceId !== process.record.instanceId ||
          snapshot.moduleId !== process.record.moduleId ||
          snapshot.moduleGenerationId !== process.record.moduleGenerationId ||
          snapshot.processGenerationId !== process.record.processGenerationId ||
          snapshot.processGenerationId !== processGenerationId
        ) {
          throw new TypeError(
            "Installed Extension Host session does not match its authorized process generation",
          );
        }
        if (hostByProcessGeneration.has(processGenerationId)) {
          throw new TypeError(
            `Process generation ${processGenerationId} already has an Extension Host session`,
          );
        }
        hostByProcessGeneration.set(processGenerationId, host);
      },
    });
    processByModuleGeneration.set(moduleGenerationId, processGenerationId);
    return executor;
  };

  return Object.freeze({
    createExecutor,
    processGenerationIdFor: (moduleGenerationId: string): string => {
      const processGenerationId = processByModuleGeneration.get(moduleGenerationId);
      if (processGenerationId === undefined) {
        throw new TypeError(
          `Module generation ${moduleGenerationId} does not have a process generation`,
        );
      }
      return processGenerationId;
    },
    sessionForProcess: (processGenerationId: string): ExtensionSessionIdentity | null => {
      const host = hostByProcessGeneration.get(processGenerationId);
      if (host === undefined) return null;
      const snapshot = host.snapshot;
      if (
        snapshot.processGenerationId !== processGenerationId ||
        (snapshot.state !== "ready" && snapshot.state !== "executing")
      ) {
        return null;
      }
      return Object.freeze({
        extensionId: snapshot.extensionId,
        instanceId: snapshot.instanceId,
        processGenerationId: snapshot.processGenerationId,
        sessionId: snapshot.sessionId,
        moduleId: snapshot.moduleId,
        moduleGenerationId: snapshot.moduleGenerationId,
      });
    },
  });
}
