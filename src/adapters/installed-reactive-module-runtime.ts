import {
  consumeCoreStartupRecoveryHandoff,
  type CoreStartupRecoveryHandoff,
} from "../core/core-startup-recovery.js";
import { canonicalJsonDigest } from "../core/canonical-json.js";
import { EffectIntentJournal } from "../core/capabilities/effect-intent-journal.js";
import { FileEffectIntentStore } from "../core/capabilities/file-effect-intent-store.js";
import { ContentSchemaRegistrationSet } from "../core/content-schema-registry.js";
import type { DeliveryMailboxCapacity, FailureClassification } from "../core/delivery-store.js";
import type { ExtensionInstallationRegistry } from "../core/extension-installation-registry.js";
import {
  createFileCoreStateStoreWithStoppedRecordWriter,
  FileCoreStateStore,
  type FileCoreStateStoreOptions,
  type FileCoreStateStoreWithStoppedRecordWriter,
} from "../core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../core/file-module-result-commit-repository.js";
import {
  assertLinuxModuleActivationPermission,
  type LinuxModuleActivationPermission,
} from "../core/linux-module-activation.js";
import {
  resolveInstalledContentSchemaRegistrationSet,
  resolveInstalledExtensionModule,
  type InstalledExtensionModule,
  type ReservedV10InstalledModulePlan,
} from "../core/installed-extension-module.js";
import type { ModuleActorEvent } from "../core/module-actor.js";
import type {
  SchedulerClock,
  SchedulerEvent,
} from "../core/module-scheduler.js";
import type { ModuleConfigurationStore } from "../core/module-configuration-store.js";
import type {
  DeclaredExternalEffects,
  ModuleProcessStoppedRecordWriter,
} from "../core/module-process-records.js";
import { createFileCoreActiveRunModelMediaResolver } from "../core/media-capability/index.js";
import type { ModelMediaResolver } from "../core/model-provider-broker.js";
import { createModuleResultCommitCoordinator } from "../core/module-result-commit-factory.js";
import type {
  DeferredModuleResultCommit,
  ModuleResultCommitCoordinator,
  ModuleResultCommitHookEvent,
} from "../core/module-result-commit.js";
import {
  ReactiveModuleRuntime,
  type ReactiveModuleFailure,
} from "../core/reactive-module-runtime.js";
import {
  composeReactiveModuleHost,
  type ReactiveModuleHost,
  type ReactiveModuleSchedulingConstraints,
} from "../core/reactive-module-host.js";
import {
  resolveSourceActivationSchedulerBinding,
  SourceActivationQueue,
  SourceActivationQueueError,
  type SourceActivationQueueStatus,
  type SourceActivationRequest,
  type SourceActivationSchedulerBinding,
  type SourceActivationSubmission,
} from "../core/source-activation-queue.js";
import type {
  DollyInstanceConfig,
  DollyModuleConfig,
} from "../core/runtime-config.js";
import type { DollyInstanceConfigV10Draft } from "../core/runtime-config-v10.js";
import {
  assertInstalledModuleRuntimePremise,
  type InstalledModuleRuntimePremise,
} from "./installed-module-runtime-premise.js";
import {
  assertReservedV10InstalledModuleProcessProvenance,
  createInstalledLinuxExtensionModuleGenerationFactory,
  createInstalledModuleProcessDeclarationProvenanceAuthority,
  INSTALLED_PROCESS_EFFECT_DECLARATION,
  type InstalledLinuxExtensionModuleGenerationFactory,
  type InstalledLinuxExtensionModuleGenerationFactoryOptions,
  type ReservedV10InstalledModuleProcessProvenance,
} from "./installed-linux-extension-module-executor.js";
import {
  InstalledModulePermissionPolicyRegistry,
  type InstalledModulePermissionPolicySetup,
} from "./installed-module-permission-policy.js";
import { createExtensionEffectJournalLifecycle } from "./extension-effect-run-lifecycle.js";

type InstalledRuntimeLifecycleOptions = Omit<
  InstalledLinuxExtensionModuleGenerationFactoryOptions["lifecycle"],
  "records" | "stoppedRecordWriter"
>;
type InstalledRuntimeHostOptions = Omit<
  InstalledLinuxExtensionModuleGenerationFactoryOptions["host"],
  | "effectRunLifecycle"
  | "initializationTimeoutMs"
  | "maxFrameBytes"
  | "terminationTimeoutMs"
>;

export interface InstalledReactiveModuleRuntimeOptions extends Omit<
  InstalledLinuxExtensionModuleGenerationFactoryOptions,
  | "activation"
  | "cancellationGraceMs"
  | "configurations"
  | "coreStateDirectory"
  | "declarationProvenance"
  | "executionTimeoutMs"
  | "host"
  | "installations"
  | "instanceConfiguration"
  | "lifecycle"
  | "moduleId"
  | "permissionPolicySetup"
  | "resolvedModule"
  | "terminationTimeoutMs"
  | "wallClockNow"
> {
  /** v9 stays on the legacy resolver; v10 requires `premise`. */
  readonly instanceConfiguration: DollyInstanceConfig | DollyInstanceConfigV10Draft;
  readonly moduleId: string;
  readonly installations: ExtensionInstallationRegistry;
  /**
   * Legacy v9 callers supply activation directly. A v10 caller MUST omit it:
   * the Host permission is consumed from the branded runtime premise.
   */
  readonly activation?: LinuxModuleActivationPermission;
  /** Exact v10 candidate/premise handoff; absent only for v9. */
  readonly premise?: InstalledModuleRuntimePremise;
  readonly configurations: ModuleConfigurationStore;
  /** The same Core store owns Deliveries, submissions, process records, and result effects. */
  readonly core: FileCoreStateStore;
  readonly stoppedRecordWriter: ModuleProcessStoppedRecordWriter;
  readonly resultCommitRepository: FileModuleResultCommitRepository;
  /** Host-owned implementations for the policy identifiers selected by the Module. */
  readonly permissionPolicies?: InstalledModulePermissionPolicyRegistry;
  /** Durable intent records for every Core-mediated capability invocation. */
  readonly effectIntentStore?: FileEffectIntentStore;
  readonly mailboxes: readonly DeliveryMailboxCapacity[];
  readonly now: () => string;
  readonly initialModuleGenerationId: string;
  readonly nextModuleGenerationId: () => string;
  readonly monotonicNow: () => number;
  /** Required only for a package-version-3 source Module. */
  readonly sourceActivationQueue?: SourceActivationQueue;
  readonly lifecycle: InstalledRuntimeLifecycleOptions;
  readonly host: InstalledRuntimeHostOptions;
  readonly classifyFailure: (
    failure: ReactiveModuleFailure,
  ) => FailureClassification;
  readonly onActorEvent?: (event: ModuleActorEvent) => void;
  readonly afterCommitEffect?: (
    event: ModuleResultCommitHookEvent,
  ) => void | Promise<void>;
}

export interface InstalledReactiveModuleRuntime {
  readonly resolvedModule: InstalledExtensionModule;
  readonly permissionPolicySetup?: InstalledModulePermissionPolicySetup;
  readonly generations: InstalledLinuxExtensionModuleGenerationFactory;
  readonly commits: ModuleResultCommitCoordinator;
  readonly runtime: ReactiveModuleRuntime;
  readonly sourceActivationBinding?: SourceActivationSchedulerBinding;
}

function canonicalNow(now: () => string): string {
  const milliseconds = Date.parse(now());
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Installed Module runtime wall clock returned an invalid time");
  }
  return new Date(milliseconds).toISOString();
}

/**
 * @internal Installed-adapter construction seam. Creates FileCore state with
 * a store-bound process-record/2 declaration-provenance authority and the
 * stopped-record writer, so v2 starting records can be allocated and
 * validated from one store. No public runtime path calls this yet; public
 * activation remains guarded.
 */
export function createInstalledFileCoreStateStoreWithStoppedRecordWriter(
  options: Omit<FileCoreStateStoreOptions, "declarationProvenanceAuthorityProvider">,
): FileCoreStateStoreWithStoppedRecordWriter {
  return createFileCoreStateStoreWithStoppedRecordWriter({
    ...options,
    declarationProvenanceAuthorityProvider: (store) =>
      createInstalledModuleProcessDeclarationProvenanceAuthority(store),
  });
}
function projectReservedV10Module(
  plan: ReservedV10InstalledModulePlan,
): InstalledExtensionModule {
  const module = plan.module;
  const inputConnections = module.inputConnections;
  const firstStart = inputConnections[0]?.start;
  const subscriptionStart = firstStart === "from-head" ? "from-head" : "from-now";
  const projectedModule = Object.freeze({
    moduleId: module.moduleId,
    extensionId: module.extensionId,
    packageVersion: module.packageVersion,
    moduleKind: module.moduleKind,
    isolation: "process" as const,
    configurationReference: Object.freeze({ ...module.configurationReference }),
    permissionPolicyIds: Object.freeze(
      module.permissionPolicyReferences.map((reference) => reference.policyId),
    ),
    inputPageIds: Object.freeze(inputConnections.map((connection) => connection.pageId)),
    outputPageIds: Object.freeze([...module.outputPageIds]),
    subscriptionStart,
    activation: module.activation,
    limits: Object.freeze({
      claim: Object.freeze({
        maxCount: module.limits.claim.maxCount,
        maxBytes: module.limits.claim.maxBytes,
      }),
      maxInputBytes: module.limits.maxInputBytes,
      maxResultBytes: module.limits.maxResultBytes,
      maxFrameBytes: module.limits.maxFrameBytes,
      maxRunsPerGeneration: module.limits.maxRunsPerGeneration,
      maxGenerations: module.limits.maxGenerations,
    }),
    timeouts: Object.freeze({ ...module.timeouts }),
  } satisfies DollyModuleConfig);
  return Object.freeze({
    instanceId: plan.instanceId,
    module: projectedModule,
    installation: plan.installation,
    packageModule: plan.packageModule,
    configuration: plan.configuration,
  });
}

function assertReservedV10PremiseForRuntime(
  options: InstalledReactiveModuleRuntimeOptions,
): {
  readonly plan: ReservedV10InstalledModulePlan;
  readonly processProvenance: ReservedV10InstalledModuleProcessProvenance;
  readonly configuration: DollyInstanceConfigV10Draft;
} {
  if (options.premise === undefined) {
    throw new TypeError(
      "Reserved version-10 installed Module runtime requires an InstalledModuleRuntimePremise",
    );
  }
  assertInstalledModuleRuntimePremise(options.premise);
  const configuration = options.instanceConfiguration;
  if (configuration.schemaVersion !== "dolly.instance/10") {
    throw new TypeError(
      "Installed Module runtime premise requires a reserved version-10 configuration",
    );
  }
  const premiseModule = options.premise.modules.find(
    (candidate) => candidate.moduleId === options.moduleId,
  );
  if (premiseModule === undefined) {
    throw new TypeError(
      `Installed Module runtime premise has no Module ${options.moduleId}`,
    );
  }
  const candidateModule = options.premise.candidate.modules.find(
    (candidate) => candidate.moduleId === options.moduleId,
  );
  if (
    candidateModule === undefined ||
    candidateModule.installedModule !== premiseModule.processProvenance.installedModule ||
    candidateModule.packageOrigin !== premiseModule.packageOrigin
  ) {
    throw new TypeError(
      `Installed Module runtime premise Module ${options.moduleId} is not bound to its activation candidate`,
    );
  }
  const processProvenance = premiseModule.processProvenance;
  assertReservedV10InstalledModuleProcessProvenance(processProvenance);
  const plan = processProvenance.installedModule;
  if (
    processProvenance.linuxExecution.resolvedModule !== plan ||
    processProvenance.permissionPolicies !== premiseModule.permissionPolicies ||
    processProvenance.snapshot === undefined ||
    canonicalJsonDigest(processProvenance.snapshot) !== processProvenance.provenanceDigest
  ) {
    throw new TypeError(
      `Installed Module runtime premise Module ${options.moduleId} has mismatched process provenance`,
    );
  }
  const configuredModule = configuration.modules.find(
    (candidate) => candidate.moduleId === options.moduleId,
  );
  if (
    configuredModule === undefined ||
    plan.instanceId !== configuration.instanceId ||
    plan.instanceConfigurationDigest !== canonicalJsonDigest(configuration) ||
    canonicalJsonDigest(configuredModule) !== canonicalJsonDigest(plan.module)
  ) {
    throw new TypeError(
      `Installed Module runtime premise Module ${options.moduleId} is stale for the supplied version-10 configuration`,
    );
  }
  const installation = options.installations.resolve({
    extensionId: plan.module.extensionId,
    packageVersion: plan.module.packageVersion,
  });
  if (
    installation.packageDigest !== plan.installation.packageDigest ||
    canonicalJsonDigest(installation.manifest) !== canonicalJsonDigest(plan.installation.manifest)
  ) {
    throw new TypeError(
      `Installed Module runtime premise Module ${options.moduleId} is stale for the installed package`,
    );
  }
  const configurationRecord = options.configurations.resolve({
    configId: plan.module.configurationReference.configId,
    revision: plan.module.configurationReference.revision,
    extensionId: plan.module.extensionId,
    moduleKind: plan.module.moduleKind,
    configVersion: plan.module.configurationReference.configVersion,
    schema: plan.packageModule.configurationSchema,
  });
  if (
    configurationRecord.revision !== plan.configuration.revision ||
    configurationRecord.configurationDigest !== plan.configuration.configurationDigest
  ) {
    throw new TypeError(
      `Installed Module runtime premise Module ${options.moduleId} is stale for its configuration record`,
    );
  }
  const selectionSnapshot = premiseModule.permissionPolicies.snapshot;
  const selectedPolicies =
    selectionSnapshot !== null &&
    typeof selectionSnapshot === "object" &&
    !Array.isArray(selectionSnapshot) &&
    Array.isArray(Reflect.get(selectionSnapshot, "policies"))
      ? Reflect.get(selectionSnapshot, "policies") as readonly {
          readonly policyId: string;
          readonly revision: string;
        }[]
      : undefined;
  if (
    selectedPolicies === undefined ||
    selectedPolicies.length !== plan.module.permissionPolicyReferences.length ||
    selectedPolicies.some((selected, index) => {
      const reference = plan.module.permissionPolicyReferences[index];
      return (
        reference === undefined ||
        selected.policyId !== reference.policyId ||
        selected.revision !== reference.revision
      );
    }) ||
    premiseModule.permissionBindings.length !== selectedPolicies.length
  ) {
    throw new TypeError(
      `Installed Module runtime premise Module ${options.moduleId} has mismatched policy provenance`,
    );
  }
  if (selectedPolicies.length !== 0) {
    throw new TypeError(
      "Reserved version-10 installed Module capability Host setup is not connected to the TypeScript runtime",
    );
  }
  return { plan, processProvenance, configuration };
}

function createInstalledReactiveModuleRuntimeFromPremise(
  options: InstalledReactiveModuleRuntimeOptions,
): InstalledReactiveModuleRuntime {
  const { plan, processProvenance, configuration } =
    assertReservedV10PremiseForRuntime(options);
  const {
    activation: _callerActivation,
    permissionPolicies: _callerPolicies,
    premise: _premise,
    ...runtimeOptions
  } = options;
  return createInstalledReactiveModuleRuntimeInternal({
    ...runtimeOptions,
    instanceConfiguration: configuration,
    moduleId: plan.module.moduleId,
    activation: options.premise!.candidate.activationPermission,
    resolvedModule: projectReservedV10Module(plan),
    declarationProvenance: processProvenance,
    declaredExternalEffects: plan.module.declaredExternalEffects,
  });
}

/**
 * Constructs one unstarted reactive runtime from one installation, one
 * configuration record, and one FileCore state store. In ordinary terms, this
 * is the boundary that prevents the executor, Claim, submission, and result
 * commit paths from quietly using different stores or process identities.
 */
export function createInstalledReactiveModuleRuntime(
  options: InstalledReactiveModuleRuntimeOptions,
): InstalledReactiveModuleRuntime {
  if (options.instanceConfiguration.schemaVersion === "dolly.instance/10") {
    if (options.premise === undefined) {
      throw new TypeError(
        "Reserved version-10 installed Module runtime requires an InstalledModuleRuntimePremise",
      );
    }
    if (options.activation !== undefined) {
      throw new TypeError(
        "Reserved version-10 installed Module runtime consumes activation from its premise",
      );
    }
    if (options.permissionPolicies !== undefined) {
      throw new TypeError(
        "Reserved version-10 installed Module runtime consumes policy selection from its premise",
      );
    }
    return createInstalledReactiveModuleRuntimeFromPremise(options);
  }
  if (options.premise !== undefined) {
    throw new TypeError(
      "Installed Module runtime premises require a reserved version-10 configuration",
    );
  }
  if (options.activation === undefined) {
    throw new TypeError("Installed Module runtime requires Host activation permission");
  }
  return createInstalledReactiveModuleRuntimeInternal({
    ...options,
    activation: options.activation,
  });
}

type InstalledRuntimeInternalOptions = InstalledReactiveModuleRuntimeOptions & {
  readonly activation: LinuxModuleActivationPermission;
  readonly initialDeferredCommit?: DeferredModuleResultCommit;
  readonly resolvedModule?: InstalledExtensionModule;
  readonly declarationProvenance?: ReservedV10InstalledModuleProcessProvenance;
  readonly declaredExternalEffects?: DeclaredExternalEffects;
};

function createInstalledReactiveModuleRuntimeInternal(
  options: InstalledRuntimeInternalOptions,
): InstalledReactiveModuleRuntime {
  if (
    (Object.hasOwn(options, "declaredExternalEffects") &&
      options.declarationProvenance === undefined) ||
    Object.hasOwn(options, "externalEffectEvidence")
  ) {
    throw new TypeError(
      "Installed Module runtime cannot accept caller-supplied external-effect recovery inputs",
    );
  }
  if (Object.hasOwn(options.host, "effectRunLifecycle")) {
    throw new TypeError(
      "Installed Module runtime cannot accept a caller-supplied capability effect lifecycle",
    );
  }
  if (Object.getPrototypeOf(options.core) !== FileCoreStateStore.prototype) {
    throw new TypeError("Installed Module runtime requires one direct FileCoreStateStore");
  }
  if (
    Object.getPrototypeOf(options.resultCommitRepository) !==
      FileModuleResultCommitRepository.prototype
  ) {
    throw new TypeError(
      "Installed Module runtime requires one direct durable result-commit repository",
    );
  }
  if (!options.stoppedRecordWriter.isStoreBoundTo(options.core)) {
    throw new TypeError(
      "Installed Module runtime stopped-record writer is not bound to its FileCoreStateStore",
    );
  }
  const resolvedModule = options.resolvedModule ?? resolveInstalledExtensionModule({
    instanceConfiguration: options.instanceConfiguration as DollyInstanceConfig,
    moduleId: options.moduleId,
    installations: options.installations,
    configurations: options.configurations,
  });
  const module = resolvedModule.module;
  if (options.declarationProvenance !== undefined) {
    assertReservedV10InstalledModuleProcessProvenance(options.declarationProvenance);
    const provenanceModule = options.declarationProvenance.installedModule;
    if (
      provenanceModule.instanceId !== resolvedModule.instanceId ||
      provenanceModule.module.moduleId !== module.moduleId ||
      provenanceModule.installation.packageDigest !== resolvedModule.installation.packageDigest ||
      provenanceModule.configuration.revision !== module.configurationReference.revision ||
      options.declaredExternalEffects !==
        options.declarationProvenance.linuxExecution.declaredExternalEffects
    ) {
      throw new TypeError(
        "Installed Module runtime process provenance does not match its resolved Module",
      );
    }
  }
  if (
    module.activation.kind === "source" &&
    module.activation.trigger === "periodic"
  ) {
    throw new TypeError(
      "Installed source Module runtime does not yet provide an automatic periodic request producer",
    );
  }
  if (module.isolation !== "process") {
    throw new TypeError("Installed reactive runtime requires process isolation");
  }
  let permissionPolicySetup;
  let effectRunLifecycle;
  if (module.permissionPolicyIds.length !== 0) {
    if (
      options.permissionPolicies === undefined ||
      Object.getPrototypeOf(options.permissionPolicies) !==
        InstalledModulePermissionPolicyRegistry.prototype
    ) {
      throw new TypeError(
        "Installed Module permission policies require one direct Host policy registry",
      );
    }
    if (
      options.effectIntentStore === undefined ||
      Object.getPrototypeOf(options.effectIntentStore) !== FileEffectIntentStore.prototype
    ) {
      throw new TypeError(
        "Installed Module permission policies require one direct durable effect intent store",
      );
    }
    const effectJournal = new EffectIntentJournal({
      store: options.effectIntentStore,
      now: () => canonicalNow(options.now),
    });
    effectRunLifecycle = createExtensionEffectJournalLifecycle({
      journal: effectJournal,
      getModuleSubmissionRecord: (runId) =>
        options.core.getModuleSubmissionRecord(runId),
    });
  }
  const expectedExternalEffects =
    options.declaredExternalEffects ?? INSTALLED_PROCESS_EFFECT_DECLARATION;
  if (options.initialDeferredCommit !== undefined) {
    const record = options.initialDeferredCommit.record;
    const submission = options.core.getModuleSubmissionRecord(record.runId);
    const processRecord = submission === undefined
      ? undefined
      : options.core.getModuleProcessRecord(submission.processGenerationId);
    const reference = module.configurationReference;
    if (
      submission === undefined ||
      processRecord === undefined ||
      processRecord.state !== "stopped" ||
      processRecord.instanceId !== resolvedModule.instanceId ||
      processRecord.moduleId !== module.moduleId ||
      processRecord.moduleGenerationId !== record.moduleGenerationId ||
      processRecord.packageDigest !== resolvedModule.installation.packageDigest ||
      processRecord.configurationReference.configId !== reference.configId ||
      processRecord.configurationReference.revision !== reference.revision ||
      processRecord.configurationReference.configVersion !== reference.configVersion ||
      processRecord.declaredExternalEffects !== expectedExternalEffects
    ) {
      throw new TypeError(
        "Deferred Module result does not match its stopped installed process, package, configuration, and effect declaration",
      );
    }
  }
  const sourceActivationQueue = options.sourceActivationQueue;
  let sourceActivationBinding: SourceActivationSchedulerBinding | undefined;
  let inputPageIds: readonly string[];
  let claimMaxCount: number;
  let claimMaxBytes: number;
  if (module.activation.kind === "source") {
    if (!(sourceActivationQueue instanceof SourceActivationQueue)) {
      throw new TypeError("Installed source Module runtime requires a source activation queue");
    }
    sourceActivationQueue.reconcile();
    sourceActivationBinding = sourceActivationQueue.schedulerBinding();
    const route = resolveSourceActivationSchedulerBinding(
      sourceActivationBinding,
      module.moduleId,
      options.core.deliveries,
    );
    inputPageIds = [route.privatePageId];
    // One durable source request is one Module job. The complete serialized
    // input remains bounded independently by maxInputBytes.
    claimMaxCount = 1;
    claimMaxBytes = module.limits.maxInputBytes;
  } else {
    if (sourceActivationQueue !== undefined) {
      throw new TypeError("A reactive Module cannot receive a source activation queue");
    }
    const claim = module.limits.claim;
    if (claim === null) {
      throw new TypeError("Installed reactive runtime requires finite Claim limits");
    }
    inputPageIds = module.inputPageIds;
    claimMaxCount = claim.maxCount;
    claimMaxBytes = claim.maxBytes;
  }
  const now = () => canonicalNow(options.now);
  const commits = createModuleResultCommitCoordinator({
    core: options.core,
    repository: options.resultCommitRepository,
    now,
    mailboxes: options.mailboxes,
    ...(options.afterCommitEffect === undefined
      ? {}
      : { afterEffect: options.afterCommitEffect }),
  });
  let generations: InstalledLinuxExtensionModuleGenerationFactory | undefined;
  let modelMediaResolver: ModelMediaResolver | undefined;
  if (options.core.media !== undefined) {
    modelMediaResolver = createFileCoreActiveRunModelMediaResolver({
      core: options.core,
      extensionId: resolvedModule.installation.manifest.extensionId,
      instanceId: resolvedModule.instanceId,
      moduleId: module.moduleId,
      sessionForProcess: (processGenerationId) =>
        generations?.sessionForProcess(processGenerationId) ?? null,
      now,
    });
  }
  if (module.permissionPolicyIds.length !== 0) {
    permissionPolicySetup = options.permissionPolicies!.setupFor(resolvedModule, {
      ...(modelMediaResolver === undefined ? {} : { modelMediaResolver }),
    });
  }
  generations = createInstalledLinuxExtensionModuleGenerationFactory({
    ...(options.resolvedModule === undefined
      ? {}
      : { resolvedModule: options.resolvedModule }),
    ...(options.declarationProvenance === undefined
      ? {}
      : { declarationProvenance: options.declarationProvenance }),
    instanceConfiguration: options.instanceConfiguration,
    moduleId: options.moduleId,
    installations: options.installations,
    configurations: options.configurations,
    coreStateDirectory: options.core.stateDirectoryForProcessConfinement(),
    activation: options.activation,
    lifecycle: {
      ...options.lifecycle,
      records: options.core,
      stoppedRecordWriter: options.stoppedRecordWriter,
    },
    host: {
      ...options.host,
      maxFrameBytes: module.limits.maxFrameBytes,
      initializationTimeoutMs: module.timeouts.initializationTimeoutMs,
      terminationTimeoutMs: module.timeouts.terminationTimeoutMs,
      ...(effectRunLifecycle === undefined ? {} : { effectRunLifecycle }),
    },
    executionTimeoutMs: module.timeouts.executionTimeoutMs,
    cancellationGraceMs: module.timeouts.cancellationGraceMs,
    terminationTimeoutMs: module.timeouts.terminationTimeoutMs,
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
    ...(permissionPolicySetup === undefined
      ? {}
      : { permissionPolicySetup }),
    ...(options.onStandardErrorChunk === undefined
      ? {}
      : { onStandardErrorChunk: options.onStandardErrorChunk }),
    ...(options.nextProcessGenerationId === undefined
      ? {}
      : { nextProcessGenerationId: options.nextProcessGenerationId }),
    wallClockNow: () => Date.parse(now()),
  });
  const deliveries = options.core.deliveries;
  const runtime = new ReactiveModuleRuntime({
    moduleId: module.moduleId,
    initialModuleGenerationId: options.initialModuleGenerationId,
    inputPageIds,
    outputPageIds: module.outputPageIds,
    claimMaxCount,
    claimMaxBytes,
    maxInputBytes: module.limits.maxInputBytes,
    maxResultBytes: module.limits.maxResultBytes,
    executionTimeoutMs: module.timeouts.executionTimeoutMs,
    cancellationGraceMs: module.timeouts.cancellationGraceMs,
    initializationTimeoutMs: module.timeouts.initializationTimeoutMs,
    terminationTimeoutMs: module.timeouts.terminationTimeoutMs,
    maxRunsPerGeneration: module.limits.maxRunsPerGeneration,
    maxGenerations: module.limits.maxGenerations,
    deliveries: {
      validateClaimPages: deliveries.validateClaimPages.bind(deliveries),
      validateOutputPages: deliveries.validateOutputPages.bind(deliveries),
      claim: deliveries.claim.bind(deliveries),
      flushPersistence: deliveries.flushPersistence.bind(deliveries),
      inspectClaim: deliveries.inspectClaim.bind(deliveries),
      inspectClaimInput: deliveries.inspectClaimInput.bind(deliveries),
    },
    persistModuleSubmission: (request) => {
      options.core.appendModuleSubmissionRecord({
        schemaVersion: "dolly.module-submission-record/2",
        ...request,
        processGenerationId: generations.processGenerationIdFor(
          request.moduleGenerationId,
        ),
        createdAt: now(),
        dispatchState: "prepared",
      });
    },
    releaseDeliveryClaim: (identity) =>
      options.core.releaseDeliveryClaim(identity),
    negativelyAcknowledgeDeliveryClaim: (request) =>
      options.core.negativelyAcknowledgeDeliveryClaim(request),
    getModuleSubmissionRecord: (runId) =>
      options.core.getModuleSubmissionRecord(runId),
    commits,
    declaredExternalEffects:
      options.declaredExternalEffects ?? INSTALLED_PROCESS_EFFECT_DECLARATION,
    ...(options.initialDeferredCommit === undefined
      ? {}
      : { initialDeferredCommit: options.initialDeferredCommit }),
    nextModuleGenerationId: options.nextModuleGenerationId,
    monotonicNow: options.monotonicNow,
    createExecutor: generations.createExecutor,
    classifyFailure: options.classifyFailure,
    ...(options.onActorEvent === undefined
      ? {}
      : { onActorEvent: options.onActorEvent }),
  });
  return Object.freeze({
    resolvedModule,
    ...(permissionPolicySetup === undefined ? {} : { permissionPolicySetup }),
    generations,
    commits,
    runtime,
    ...(sourceActivationBinding === undefined ? {} : { sourceActivationBinding }),
  });
}

type InstalledHostRuntimeOptions = Omit<
  InstalledReactiveModuleRuntimeOptions,
  | "configurations"
  | "core"
  | "activation"
  | "initialModuleGenerationId"
  | "installations"
  | "instanceConfiguration"
  | "mailboxes"
  | "moduleId"
  | "monotonicNow"
  | "nextModuleGenerationId"
  | "stoppedRecordWriter"
> & {
  /** Allocates the first non-reused generation identifier for each configured Module. */
  readonly initialModuleGenerationIdFor: (moduleId: string) => string;
  /** Allocates later non-reused generation identifiers in that same Module's actor. */
  readonly nextModuleGenerationIdFor: (moduleId: string) => string;
};

export interface InstalledSourceActivationLimits {
  readonly moduleId: string;
  readonly maxResidentCount: number;
  readonly maxResidentBytes: number;
  readonly maxRequestBytes: number;
}

export interface InstalledReactiveModuleHostOptions {
  /** Host-minted proof of the exact service, cgroup root, and reviewed runtime. */
  readonly activation: LinuxModuleActivationPermission;
  readonly configuration: DollyInstanceConfig;
  readonly installations: ExtensionInstallationRegistry;
  readonly configurations: ModuleConfigurationStore;
  readonly coreState: FileCoreStateStoreWithStoppedRecordWriter;
  /** Exact set already bound to `coreState.store.blocks`. */
  readonly contentSchemas: ContentSchemaRegistrationSet;
  /** Product-before-bootstrap resource ceiling used to rederive the set. */
  readonly maxRegisteredContentValueBytes: number;
  readonly mailboxes: readonly DeliveryMailboxCapacity[];
  /** Explicit until a later instance schema persists source queue limits. */
  readonly sourceActivationLimits?: readonly InstalledSourceActivationLimits[];
  /** One-use, store-bound proof produced only after startup stopped old processes. */
  readonly startupRecoveryHandoff: CoreStartupRecoveryHandoff;
  readonly clock: SchedulerClock;
  readonly scheduling: ReactiveModuleSchedulingConstraints;
  readonly runtime: InstalledHostRuntimeOptions;
  readonly random?: () => number;
  readonly onSchedulerEvent?: (event: SchedulerEvent) => void;
}

export interface InstalledReactiveModuleHost {
  /** Read-only diagnostics; runtime and process-generation authorities stay inside the Host. */
  readonly modules: readonly InstalledReactiveModuleStatus[];
  /**
   * The only source/manual request surface returned by installed composition.
   * It keeps the owning queue private and admits writes only after startup
   * recovery has reached the Host's running state.
   */
  readonly sourceActivations: readonly InstalledSourceActivation[];
  readonly host: ReactiveModuleHost;
}

export interface InstalledReactiveModuleStatus {
  readonly moduleId: string;
  readonly activation: DollyInstanceConfig["modules"][number]["activation"];
  readonly moduleGenerationId: string;
  readonly outputCommitWaiting: boolean;
  readonly startupRecoveryPending: boolean;
}

/** A read/submit view over one private source queue, gated by Host readiness. */
export interface InstalledSourceActivation {
  readonly moduleId: string;
  readonly privatePageId: string;
  readonly limits: Readonly<{
    readonly maxResidentCount: number;
    readonly maxResidentBytes: number;
    readonly maxRequestBytes: number;
  }>;
  inspect(): SourceActivationQueueStatus;
  submit(input: SourceActivationRequest): SourceActivationSubmission;
}

function sourceActivationAdmission(
  queue: SourceActivationQueue,
  host: ReactiveModuleHost,
): InstalledSourceActivation {
  return Object.freeze({
    moduleId: queue.moduleId,
    privatePageId: queue.privatePageId,
    limits: queue.limits,
    inspect: () => queue.inspect(),
    submit: (input: SourceActivationRequest) => {
      if (host.state !== "running") {
        throw new SourceActivationQueueError(
          "SOURCE_ACTIVATION_ADMISSION_CLOSED",
          `Source activation Module ${queue.moduleId} is not running`,
        );
      }
      return queue.submit(input);
    },
  });
}

/**
 * Builds every configured reactive Module into one Scheduler without accepting
 * caller-supplied runtimes or manifests. This remains a product-before-bootstrap
 * composition because instance schema 9 cannot persist its Linux settings.
 */
export function composeInstalledReactiveModuleHost(
  options: InstalledReactiveModuleHostOptions,
): InstalledReactiveModuleHost {
  assertLinuxModuleActivationPermission(options.activation);
  if (!(options.contentSchemas instanceof ContentSchemaRegistrationSet)) {
    throw new TypeError("contentSchemas must be a ContentSchemaRegistrationSet");
  }
  if (!options.coreState.store.blocks.isContentSchemaRegistrationSetBoundTo(
    options.contentSchemas,
  )) {
    throw new TypeError(
      "Installed reactive Module host content schemas are not bound to its FileCore state",
    );
  }
  const expectedContentSchemas = resolveInstalledContentSchemaRegistrationSet({
    instanceConfiguration: options.configuration,
    installations: options.installations,
    reservedRegistrations: [],
    maxRegisteredValueBytes: options.maxRegisteredContentValueBytes,
  });
  if (
    canonicalJsonDigest(expectedContentSchemas.snapshot()) !==
    canonicalJsonDigest(options.contentSchemas.snapshot())
  ) {
    throw new TypeError(
      "Installed reactive Module host content schemas do not match its verified installations",
    );
  }
  if (options.configuration.modules.length === 0) {
    throw new TypeError(
      "Installed reactive Module host requires at least one configured Module",
    );
  }
  // Resolve every package and configuration before source reconciliation is
  // allowed to mutate Core state. Runtime construction repeats this lookup so
  // a changed installation cannot pass on a stale preflight object.
  for (const module of options.configuration.modules) {
    resolveInstalledExtensionModule({
      instanceConfiguration: options.configuration,
      moduleId: module.moduleId,
      installations: options.installations,
      configurations: options.configurations,
    });
    if (
      module.activation.kind === "source" &&
      module.activation.trigger === "periodic"
    ) {
      throw new TypeError(
        `Installed source Module ${module.moduleId} does not yet have an automatic periodic request producer`,
      );
    }
  }
  const configuredSourceIds = new Set(
    options.configuration.modules
      .filter((module) => module.activation.kind === "source")
      .map((module) => module.moduleId),
  );
  const sourceActivationQueues = new Map<string, SourceActivationQueue>();
  for (const limits of options.sourceActivationLimits ?? []) {
    if (!configuredSourceIds.has(limits.moduleId)) {
      throw new TypeError(
        `Source activation limits name non-source Module ${limits.moduleId}`,
      );
    }
    if (sourceActivationQueues.has(limits.moduleId)) {
      throw new TypeError(
        `Source activation limits contain duplicate Module ${limits.moduleId}`,
      );
    }
    const queue = new SourceActivationQueue({
      core: options.coreState.store,
      moduleId: limits.moduleId,
      maxResidentCount: limits.maxResidentCount,
      maxResidentBytes: limits.maxResidentBytes,
      maxRequestBytes: limits.maxRequestBytes,
    });
    sourceActivationQueues.set(limits.moduleId, queue);
  }
  const missingSourceLimits = [...configuredSourceIds]
    .filter((moduleId) => !sourceActivationQueues.has(moduleId));
  if (missingSourceLimits.length > 0) {
    throw new TypeError(
      `Installed source Modules require activation limits: ${missingSourceLimits.sort().join(", ")}`,
    );
  }
  const orderedSourceActivationQueues = options.configuration.modules
    .filter((module) => module.activation.kind === "source")
    .map((module) => sourceActivationQueues.get(module.moduleId)!);
  const moduleMailboxes = options.configuration.modules.map((module) => {
    const matchingMailboxes = options.mailboxes.filter((mailbox) =>
      mailbox.consumerId === module.moduleId
    );
    if (module.activation.kind === "source") {
      if (matchingMailboxes.length !== 0) {
        throw new TypeError(
          `Installed source Module ${module.moduleId} cannot have a public mailbox`,
        );
      }
      return Object.freeze({ module, mailbox: undefined });
    }
    if (matchingMailboxes.length !== 1) {
      throw new TypeError(
        `Installed reactive Module host requires one mailbox for Module ${module.moduleId}`,
      );
    }
    const mailbox = matchingMailboxes[0]!;
    if (
      mailbox.pageIds.length !== module.inputPageIds.length ||
      mailbox.pageIds.some((pageId, index) => pageId !== module.inputPageIds[index])
    ) {
      throw new TypeError(
        `Installed reactive Module mailbox Pages do not match Module ${module.moduleId}`,
      );
    }
    return Object.freeze({ module, mailbox });
  });
  const {
    initialModuleGenerationIdFor,
    nextModuleGenerationIdFor,
    ...sharedRuntimeOptions
  } = options.runtime;
  // Allocators are trusted Host seams but may still reject or return malformed
  // data. Resolve the first generation for every Module before consuming the
  // one-use startup proof so a pure construction failure can be corrected and
  // retried with that same handoff.
  const initialModuleGenerationIds = new Map<string, string>();
  const generationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  for (const { module } of moduleMailboxes) {
    const generationId = initialModuleGenerationIdFor(module.moduleId);
    if (!generationIdPattern.test(generationId)) {
      throw new TypeError(
        `Initial Module generation for ${module.moduleId} is not a valid identifier`,
      );
    }
    initialModuleGenerationIds.set(module.moduleId, generationId);
  }
  // Startup recovery authority must be authenticated before source
  // reconciliation is allowed to create any private Page. A copied or
  // store-mismatched handoff is a refusal, not a partially applied
  // composition.
  const deferredCommits = consumeCoreStartupRecoveryHandoff({
    handoff: options.startupRecoveryHandoff,
    deliveries: options.coreState.store.deliveries,
    repository: options.runtime.resultCommitRepository,
    moduleRecords: options.coreState.store,
    processStopProver: options.activation.stopProver,
  });
  const deferredByModule = new Map<string, DeferredModuleResultCommit>();
  for (const deferred of deferredCommits) {
    const record = deferred.record;
    if (
      record.source.kind !== "module" ||
      !options.configuration.modules.some((module) => module.moduleId === record.source.id)
    ) {
      throw new TypeError(
        `Deferred Module result ${record.moduleJobId} does not belong to a configured Module`,
      );
    }
    if (deferredByModule.has(record.source.id)) {
      throw new TypeError(
        `Configured Module ${record.source.id} has more than one deferred result commit`,
      );
    }
    deferredByModule.set(record.source.id, deferred);
  }
  // Do not create the private Page until every caller-supplied mailbox,
  // source limit, and startup-recovery result has passed the non-mutating
  // composition checks above.
  for (const queue of orderedSourceActivationQueues) queue.reconcile();
  const installedRuntimes = moduleMailboxes.map(({ module }) =>
    createInstalledReactiveModuleRuntimeInternal({
      ...sharedRuntimeOptions,
      instanceConfiguration: options.configuration,
      moduleId: module.moduleId,
      installations: options.installations,
      configurations: options.configurations,
      core: options.coreState.store,
      activation: options.activation,
      stoppedRecordWriter: options.coreState.stoppedRecordWriter,
      mailboxes: options.mailboxes,
      initialModuleGenerationId: initialModuleGenerationIds.get(module.moduleId)!,
      nextModuleGenerationId: () =>
        nextModuleGenerationIdFor(module.moduleId),
      monotonicNow: options.clock.monotonicNow,
      ...(sourceActivationQueues.has(module.moduleId)
        ? { sourceActivationQueue: sourceActivationQueues.get(module.moduleId)! }
        : {}),
      ...(deferredByModule.has(module.moduleId)
        ? { initialDeferredCommit: deferredByModule.get(module.moduleId)! }
        : {}),
    })
  );
  const host = composeReactiveModuleHost({
    configuration: options.configuration,
    deliveries: options.coreState.store.deliveries,
    clock: options.clock,
    scheduling: options.scheduling,
    registrations: moduleMailboxes.map(({ module, mailbox }, index) => {
      const installed = installedRuntimes[index]!;
      const sourceQueue = sourceActivationQueues.get(module.moduleId);
      return {
        moduleId: module.moduleId,
        runtime: installed.runtime,
        mailbox: sourceQueue === undefined
          ? {
              maxResidentCount: mailbox!.maxResidentCount,
              maxResidentBytes: mailbox!.maxResidentBytes,
            }
          : {
              maxResidentCount: sourceQueue.limits.maxResidentCount,
              maxResidentBytes: sourceQueue.limits.maxResidentBytes,
            },
        manifest: installed.resolvedModule.installation.manifest,
        ...(installed.sourceActivationBinding === undefined
          ? {}
          : { sourceActivationBinding: installed.sourceActivationBinding }),
      };
    }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.onSchedulerEvent === undefined
      ? {}
      : { onSchedulerEvent: options.onSchedulerEvent }),
  });
  const modules = installedRuntimes.map((installed) => Object.freeze({
    moduleId: installed.resolvedModule.module.moduleId,
    activation: Object.freeze({ ...installed.resolvedModule.module.activation }),
    get moduleGenerationId() {
      return installed.runtime.moduleGenerationId;
    },
    get outputCommitWaiting() {
      return installed.runtime.outputCommitWaiting;
    },
    get startupRecoveryPending() {
      return installed.runtime.startupRecoveryPending;
    },
  } satisfies InstalledReactiveModuleStatus));
  return Object.freeze({
    modules: Object.freeze(modules),
    sourceActivations: Object.freeze(
      orderedSourceActivationQueues.map((queue) => sourceActivationAdmission(queue, host)),
    ),
    host,
  });
}
