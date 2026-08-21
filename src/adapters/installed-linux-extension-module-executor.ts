import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  canonicalJsonDigest,
  deepFreeze,
  type JsonValue,
} from "../core/canonical-json.js";
import type { ExtensionInstallationRegistry } from "../core/extension-installation-registry.js";
import type { ExtensionSessionIdentity } from "../core/extension-capability.js";
import type { ExtensionProcessHost } from "../core/extension-process-host.js";
import type { FileCoreStateStore } from "../core/file-core-state-store.js";
import {
  assertReservedV10InstalledModulePlan,
  resolveInstalledExtensionModule,
  type InstalledExtensionModule,
  type ReservedV10InstalledModulePlan,
} from "../core/installed-extension-module.js";
import {
  deriveModuleCgroupPath,
  type ModuleCgroupLimits,
} from "../core/linux-module-cgroup.js";
import type { ModuleExecutor } from "../core/module-actor.js";
import type { ModuleConfigurationStore } from "../core/module-configuration-store.js";
import {
  assertValidModuleProcessRecord,
  type ModuleProcessDeclarationProvenanceAuthority,
  type ModuleProcessRecord,
  type ModuleProcessStartingRecordInput,
} from "../core/module-process-records.js";
import type { ReactiveModuleInput } from "../core/reactive-module-input.js";
import type { ReactiveModuleResult } from "../core/reactive-module-runtime.js";
import type { DollyInstanceConfig } from "../core/runtime-config.js";
import {
  assertReservedV10InstalledPermissionPolicySelection,
  type InstalledModulePermissionPolicySetup,
  type ReservedV10InstalledPermissionPolicySelection,
} from "./installed-module-permission-policy.js";
import {
  deriveLinuxProcessConfinementExecution,
} from "./linux-process-confinement.js";
import {
  createLinuxExtensionModuleExecutor,
  type LinuxExtensionModuleExecutorOptions,
} from "./linux-extension-module-executor.js";
import {
  assertLinuxModuleActivationPermission,
  assertLinuxModuleRuntimeBinding,
  type LinuxModuleActivationPermission,
} from "../core/linux-module-activation.js";

type InstalledLifecycleOptions = Omit<
  LinuxExtensionModuleExecutorOptions["lifecycle"],
  "delegatedRootCgroupPath" | "execution" | "processRecord"
>;
type InstalledHostOptions = Omit<
  LinuxExtensionModuleExecutorOptions["host"],
  "config" | "manifest" | "moduleKind" | "trust"
>;
type ProcessRecordDetails = Pick<ModuleProcessRecord, "createdAt" | "updatedAt">;
export interface InstalledLinuxExtensionModuleExecutorOptions {
  readonly instanceConfiguration: DollyInstanceConfig;
  readonly moduleId: string;
  readonly installations: ExtensionInstallationRegistry;
  readonly configurations: ModuleConfigurationStore;
  readonly moduleGenerationId: string;
  /** Directory of the exact FileCore state store owned by this runtime. */
  readonly coreStateDirectory: string;
  /** Exact service, cgroup-root, stop-proof, and runtime decision. */
  readonly activation: LinuxModuleActivationPermission;
  readonly lifecycle: InstalledLifecycleOptions;
  readonly processRecord: ProcessRecordDetails;
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

export interface ReservedV10InstalledLinuxModuleExecutionPlan {
  readonly resolvedModule: ReservedV10InstalledModulePlan;
  readonly provenanceDigest: string;
  readonly cgroupLimits: ModuleCgroupLimits;
  readonly maxOpenFiles: number;
  readonly declaredExternalEffects: "none" | "core-capabilities-only";
  readonly permissionPolicyReferences: readonly Readonly<{
    readonly policyId: string;
    readonly revision: string;
  }>[];
  readonly timeouts: ReservedV10InstalledModulePlan["module"]["timeouts"];
}

export interface ReservedV10InstalledModuleProcessProvenance {
  readonly installedModule: ReservedV10InstalledModulePlan;
  readonly permissionPolicies: ReservedV10InstalledPermissionPolicySelection;
  readonly linuxExecution: ReservedV10InstalledLinuxModuleExecutionPlan;
  readonly snapshot: JsonValue;
  readonly provenanceDigest: string;
}

const RESERVED_V10_PROCESS_PROVENANCE = new WeakSet<object>();

/**
 * Projects the exact Linux-owned values from one resolver-minted v10 plan.
 * It performs no process, cgroup, protocol, or Core-state mutation. Sandbox
 * activation remains unsupported here, and untrusted packages cannot enter
 * the ordinary-process path.
 */
export function deriveReservedV10InstalledLinuxModuleExecutionPlan(
  resolvedModule: ReservedV10InstalledModulePlan,
): ReservedV10InstalledLinuxModuleExecutionPlan {
  assertReservedV10InstalledModulePlan(resolvedModule);
  if (resolvedModule.module.execution.isolation !== "process") {
    throw new TypeError(
      "Reserved version-10 installed Linux process composition does not implement sandbox isolation",
    );
  }
  if (resolvedModule.installation.trust !== "trusted") {
    throw new TypeError(
      "Untrusted installed packages cannot use ordinary process isolation",
    );
  }
  const limits = resolvedModule.module.execution.limits;
  return Object.freeze({
    resolvedModule,
    provenanceDigest: resolvedModule.provenanceDigest,
    cgroupLimits: Object.freeze({
      memoryMaxBytes: limits.memoryMaxBytes,
      maxProcesses: limits.maxTasks,
      cpuQuotaMicros: limits.cpuQuotaMicros,
      cpuPeriodMicros: limits.cpuPeriodMicros,
    }),
    maxOpenFiles: limits.maxOpenFiles,
    declaredExternalEffects: resolvedModule.module.declaredExternalEffects,
    permissionPolicyReferences: resolvedModule.module.permissionPolicyReferences,
    timeouts: resolvedModule.module.timeouts,
  });
}

/**
 * Joins the resolver-minted plan and policy selection with one frozen local
 * runtime profile into the candidate provenance that a future process-record/2
 * factory must consume. The profile prevents structural runtime substitution;
 * it is not the still-missing durable Host runtime-binding authority. This
 * function creates no process record because the current Core-state schema and
 * startup recovery intentionally accept only their existing record boundary.
 */
export function deriveReservedV10InstalledModuleProcessProvenance(
  installedModule: ReservedV10InstalledModulePlan,
  permissionPolicies: ReservedV10InstalledPermissionPolicySelection,
  activation: LinuxModuleActivationPermission,
): ReservedV10InstalledModuleProcessProvenance {
  const linuxExecution = deriveReservedV10InstalledLinuxModuleExecutionPlan(
    installedModule,
  );
  assertReservedV10InstalledPermissionPolicySelection(
    permissionPolicies,
    installedModule,
  );
  assertLinuxModuleActivationPermission(activation);
  assertLinuxModuleRuntimeBinding(activation.runtime);
  const snapshot = deepFreeze({
    schemaVersion: "dolly.reserved-v10-module-process-provenance/1",
    instanceId: installedModule.instanceId,
    moduleId: installedModule.module.moduleId,
    installedPlanDigest: installedModule.provenanceDigest,
    permissionPolicySelectionDigest: permissionPolicies.selectionDigest,
    packageDigest: installedModule.installation.packageDigest,
    configuration: {
      revision: installedModule.configuration.revision,
      schemaDigest: installedModule.configuration.schemaDigest,
      configurationDigest: installedModule.configuration.configurationDigest,
    },
    declaredExternalEffects: installedModule.module.declaredExternalEffects,
    execution: installedModule.module.execution as unknown as JsonValue,
    linuxActivation: {
      serviceBinding: activation.binding as unknown as JsonValue,
      delegatedRoot: activation.delegatedRoot as unknown as JsonValue,
      runtimeBindingRevision: activation.runtime.bindingRevision,
      runtimeAuditProfile: activation.runtime.auditProfile as unknown as JsonValue,
    },
  } satisfies JsonValue);
  const provenance = Object.freeze({
    installedModule,
    permissionPolicies,
    linuxExecution,
    snapshot,
    provenanceDigest: canonicalJsonDigest(snapshot),
  });
  RESERVED_V10_PROCESS_PROVENANCE.add(provenance);
  return provenance;
}

/** Rejects copied process-provenance objects before any future durable write. */
export function assertReservedV10InstalledModuleProcessProvenance(
  value: unknown,
): asserts value is ReservedV10InstalledModuleProcessProvenance {
  if (
    value === null ||
    typeof value !== "object" ||
    !RESERVED_V10_PROCESS_PROVENANCE.has(value)
  ) {
    throw new TypeError(
      "Reserved version-10 Module process provenance was not minted by the installed composition",
    );
  }
}

/**
 * The store-bound authority that persists a WeakSet-authenticated reserved
 * version-10 process provenance on a version 2 Module process record. Product
 * composition passes this function directly as the store's
 * `declarationProvenanceAuthorityProvider`, or a wrapper of it. Records
 * allocated by the returned authority bind the exact instance, Module,
 * package, configuration, policy selection, and Linux execution values the
 * provenance embeds; forged or copied values fail verification.
 */
export function createInstalledModuleProcessDeclarationProvenanceAuthority(
  store: FileCoreStateStore,
): ModuleProcessDeclarationProvenanceAuthority {
  return Object.freeze({
    isStoreBoundTo: (candidate: unknown) => candidate === store,
    verify: (input: ModuleProcessStartingRecordInput) => {
      if (input.schemaVersion !== "dolly.module-process-record/2") {
        throw new TypeError(
          "Version 1 starting records carry no declaration provenance to authenticate",
        );
      }
      const provenance = input.declarationProvenance;
      if (provenance === undefined) {
        throw new TypeError(
          "A version 2 starting record must carry its reserved version-10 declaration provenance",
        );
      }
      assertReservedV10InstalledModuleProcessProvenance(provenance);
      const snapshot = provenance.snapshot as Record<string, unknown> & {
        readonly instanceId: string;
        readonly moduleId: string;
        readonly packageDigest: string;
        readonly declaredExternalEffects: string;
        readonly configuration: { readonly revision: string };
      };
      if (input.instanceId !== snapshot.instanceId) {
        throw new TypeError("Declaration provenance is not bound to this instance");
      }
      if (input.moduleId !== snapshot.moduleId) {
        throw new TypeError("Declaration provenance is not bound to this Module");
      }
      if (input.packageDigest !== snapshot.packageDigest) {
        throw new TypeError("Declaration provenance packageDigest does not match the input");
      }
      if (
        input.configurationReference.revision !== snapshot.configuration.revision
      ) {
        throw new TypeError(
          "Declaration provenance configuration revision does not match the input",
        );
      }
      if (input.declaredExternalEffects !== snapshot.declaredExternalEffects) {
        throw new TypeError(
          "Declaration provenance declaredExternalEffects does not match the input",
        );
      }
      return Object.freeze({
        schemaVersion: "dolly.reserved-v10-module-process-provenance/1",
        provenanceDigest: provenance.provenanceDigest,
      });
    },
  });
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
  if (
    Object.hasOwn(options, "launcher") ||
    Object.hasOwn(options, "interpreterProgram") ||
    Object.hasOwn(options, "launcherScriptPath")
  ) {
    throw new TypeError(
      "Installed Linux Extension executor cannot accept caller-supplied launcher paths",
    );
  }
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
    ["delegatedRootCgroupPath", "execution", "processRecord", "startingRecord"],
    "lifecycle",
  );
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
  assertLinuxModuleActivationPermission(options.activation);
  assertLinuxModuleRuntimeBinding(options.activation.runtime);
  const binding = options.activation.binding;
  const runtime = options.activation.runtime.auditProfile;
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
    binding.delegatedRootCgroupPath,
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
    serviceInvocationId: binding.serviceInvocationId,
    bootId: binding.bootId,
    moduleCgroupPath: derivedCgroupPath,
    ...options.processRecord,
    state: "starting" as const,
  });
  // Reuse the durable-store validator so malformed binding identifiers or
  // timestamps cannot be deferred until after process creation.
  assertValidModuleProcessRecord(processRecord);
  // The id-less twin a version 19 store allocates itself. It carries every
  // unrelated field, so one derivation feeds both identifier domains.
  const startingRecord = Object.freeze({
    schemaVersion: "dolly.module-process-record/1" as const,
    instanceId: identity.instanceId,
    moduleId: identity.moduleId,
    moduleGenerationId: options.moduleGenerationId,
    packageDigest: resolvedModule.installation.packageDigest,
    configurationReference: Object.freeze({
      ...resolvedModule.module.configurationReference,
    }),
    declaredExternalEffects: INSTALLED_PROCESS_EFFECT_DECLARATION,
    serviceInvocationId: binding.serviceInvocationId,
    bootId: binding.bootId,
    delegatedRootCgroupPath: binding.delegatedRootCgroupPath,
    ...options.processRecord,
    state: "starting" as const,
  });
  const confinementExecution = deriveLinuxProcessConfinementExecution({
    bubblewrapProgram: runtime.confinementProgram,
    nodeProgram: runtime.nodeProgram,
    installationDirectory: resolvedModule.installation.workingDirectory,
    entrypointPath: resolvedModule.installation.entrypointPath,
    packageSnapshot: resolvedModule.installation.packageSnapshot,
    coreStateDirectory: options.coreStateDirectory,
  });
  const launcherBytes = readFileSync(runtime.launcherScriptPath);
  const launcherDigest = `sha256:${createHash("sha256")
    .update(launcherBytes)
    .digest("hex")}`;
  if (launcherDigest !== runtime.launcherDigest) {
    throw new TypeError(
      "Installed Linux launcher bytes do not match the reviewed build digest",
    );
  }
  const executorOptions: LinuxExtensionModuleExecutorOptions = {
    moduleId: resolvedModule.module.moduleId,
    moduleGenerationId: options.moduleGenerationId,
    lifecycle: {
      ...options.lifecycle,
      delegatedRootCgroupPath: binding.delegatedRootCgroupPath,
      processRecord,
      startingRecord,
      execution: {
        program: confinementExecution.program,
        argumentVector: confinementExecution.argumentVector,
        environment: confinementExecution.environment,
      },
    },
    launcher: {
      interpreterProgram: runtime.interpreterProgram,
      launcherEnvironment: Object.freeze({}),
    },
    reviewedLauncherSnapshot: {
      bytes: new Uint8Array(launcherBytes),
      digest: launcherDigest,
      stagingDirectory: options.coreStateDirectory,
    },
    beforeDispatch: (identity) => {
      const transition = options.lifecycle.records.markModuleSubmissionSendPossible;
      if (typeof transition !== "function") {
        throw new TypeError(
          "Installed Linux execution requires a store-bound submission dispatch transition",
        );
      }
      const { processGenerationId, ...claimIdentity } = identity;
      transition.call(
        options.lifecycle.records,
        claimIdentity,
        processGenerationId,
      );
    },
    host: {
      ...options.host,
      trust: resolvedModule.installation.trust,
      manifest: resolvedModule.installation.manifest,
      moduleKind: resolvedModule.module.moduleKind,
      config: resolvedModule.configuration.configuration,
    },
    packageSnapshot: {
      bytes: resolvedModule.installation.packageSnapshot.copyBytes(),
      digest: resolvedModule.installation.packageSnapshot.digest,
      stagingDirectory: options.coreStateDirectory,
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
   * Returns the exact durable process generation that owns submissions from
   * this Module generation. It is unavailable until the executor start has
   * bound the persisted process record's identifier: the caller-generated
   * allocator input is never returned.
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
 * or an executor starts no process; `ModuleActor` remains the owner of start,
 * and the mapping is bound only when start exposes the persisted process
 * record through Host configuration. The caller-generated allocator input is
 * never visible to mapping consumers.
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
  const executorModuleGenerations = new Set<string>();
  const usedProcessGenerations = new Set<string>();
  const hostByProcessGeneration = new Map<string, ExtensionProcessHost>();

  const createExecutor = (
    moduleGenerationId: string,
  ): ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult> => {
    if (executorModuleGenerations.has(moduleGenerationId)) {
      throw new TypeError(
        `Module generation ${moduleGenerationId} already has an installed Linux executor`,
      );
    }
    if (processByModuleGeneration.has(moduleGenerationId)) {
      throw new TypeError(
        `Module generation ${moduleGenerationId} already has a bound process generation`,
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
        const durableProcessGenerationId = process.record.processGenerationId;
        if (
          snapshot.state !== "created" ||
          snapshot.instanceId !== process.record.instanceId ||
          snapshot.moduleId !== process.record.moduleId ||
          snapshot.moduleGenerationId !== process.record.moduleGenerationId ||
          snapshot.processGenerationId !== durableProcessGenerationId
        ) {
          throw new TypeError(
            "Installed Extension Host session does not match its authorized process generation",
          );
        }
        if (hostByProcessGeneration.has(durableProcessGenerationId)) {
          throw new TypeError(
            `Process generation ${durableProcessGenerationId} already has an Extension Host session`,
          );
        }
        hostByProcessGeneration.set(durableProcessGenerationId, host);
        processByModuleGeneration.set(moduleGenerationId, durableProcessGenerationId);
      },
    });
    executorModuleGenerations.add(moduleGenerationId);
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
