import type { ExternalEffectEvidenceSource } from "../core/core-startup-recovery.js";
import type { DeliveryMailboxCapacity, FailureClassification } from "../core/delivery-store.js";
import type { ExtensionInstallationRegistry } from "../core/extension-installation-registry.js";
import { FileCoreStateStore } from "../core/file-core-state-store.js";
import type { FileCoreStateStoreWithStoppedRecordWriter } from "../core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../core/file-module-result-commit-repository.js";
import {
  resolveInstalledExtensionModule,
  type InstalledExtensionModule,
} from "../core/installed-extension-module.js";
import type { ModuleActorEvent } from "../core/module-actor.js";
import type { SchedulerClock, SchedulerEvent } from "../core/module-scheduler.js";
import type { ModuleConfigurationStore } from "../core/module-configuration-store.js";
import type { ModuleProcessStoppedRecordWriter } from "../core/module-process-records.js";
import { createModuleResultCommitCoordinator } from "../core/module-result-commit-factory.js";
import type {
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
import type { DollyInstanceConfig } from "../core/runtime-config.js";
import {
  createInstalledLinuxExtensionModuleGenerationFactory,
  type InstalledLinuxExtensionModuleGenerationFactory,
  type InstalledLinuxExtensionModuleGenerationFactoryOptions,
} from "./installed-linux-extension-module-executor.js";

type InstalledRuntimeLifecycleOptions = Omit<
  InstalledLinuxExtensionModuleGenerationFactoryOptions["lifecycle"],
  "records" | "stoppedRecordWriter"
>;
type InstalledRuntimeHostOptions = Omit<
  InstalledLinuxExtensionModuleGenerationFactoryOptions["host"],
  "initializationTimeoutMs" | "maxFrameBytes" | "terminationTimeoutMs"
>;

export interface InstalledReactiveModuleRuntimeOptions extends Omit<
  InstalledLinuxExtensionModuleGenerationFactoryOptions,
  | "cancellationGraceMs"
  | "configureHost"
  | "configurations"
  | "declaredExternalEffects"
  | "executionTimeoutMs"
  | "host"
  | "installations"
  | "instanceConfiguration"
  | "lifecycle"
  | "moduleId"
  | "terminationTimeoutMs"
  | "wallClockNow"
> {
  readonly instanceConfiguration: DollyInstanceConfig;
  readonly moduleId: string;
  readonly installations: ExtensionInstallationRegistry;
  readonly configurations: ModuleConfigurationStore;
  /** The same Core store owns Deliveries, submissions, process records, and result effects. */
  readonly core: FileCoreStateStore;
  readonly stoppedRecordWriter: ModuleProcessStoppedRecordWriter;
  readonly resultCommitRepository: FileModuleResultCommitRepository;
  readonly mailboxes: readonly DeliveryMailboxCapacity[];
  readonly now: () => string;
  readonly initialModuleGenerationId: string;
  readonly nextModuleGenerationId: () => string;
  readonly monotonicNow: () => number;
  readonly lifecycle: InstalledRuntimeLifecycleOptions;
  readonly host: InstalledRuntimeHostOptions;
  /** The first installed runtime grants no effect capability. */
  readonly declaredExternalEffects: "none";
  readonly classifyFailure: (
    failure: ReactiveModuleFailure,
  ) => FailureClassification;
  readonly externalEffectEvidence?: ExternalEffectEvidenceSource;
  readonly onActorEvent?: (event: ModuleActorEvent) => void;
  readonly afterCommitEffect?: (
    event: ModuleResultCommitHookEvent,
  ) => void | Promise<void>;
}

export interface InstalledReactiveModuleRuntime {
  readonly resolvedModule: InstalledExtensionModule;
  readonly generations: InstalledLinuxExtensionModuleGenerationFactory;
  readonly commits: ModuleResultCommitCoordinator;
  readonly runtime: ReactiveModuleRuntime;
}

function canonicalNow(now: () => string): string {
  const milliseconds = Date.parse(now());
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Installed Module runtime wall clock returned an invalid time");
  }
  return new Date(milliseconds).toISOString();
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
  const resolvedModule = resolveInstalledExtensionModule({
    instanceConfiguration: options.instanceConfiguration,
    moduleId: options.moduleId,
    installations: options.installations,
    configurations: options.configurations,
  });
  const module = resolvedModule.module;
  if (module.activation.kind !== "reactive") {
    throw new TypeError("Installed reactive runtime requires reactive activation");
  }
  if (module.isolation !== "process") {
    throw new TypeError("Installed reactive runtime requires process isolation");
  }
  if (module.permissionPolicyIds.length !== 0) {
    throw new TypeError(
      "Installed reactive runtime cannot consume permission policies before capability composition exists",
    );
  }
  const claim = module.limits.claim;
  if (claim === null) {
    throw new TypeError("Installed reactive runtime requires finite Claim limits");
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
  const generations = createInstalledLinuxExtensionModuleGenerationFactory({
    instanceConfiguration: options.instanceConfiguration,
    moduleId: options.moduleId,
    installations: options.installations,
    configurations: options.configurations,
    binding: options.binding,
    lifecycle: {
      ...options.lifecycle,
      records: options.core,
      stoppedRecordWriter: options.stoppedRecordWriter,
    },
    declaredExternalEffects: options.declaredExternalEffects,
    launcher: options.launcher,
    host: {
      ...options.host,
      maxFrameBytes: module.limits.maxFrameBytes,
      initializationTimeoutMs: module.timeouts.initializationTimeoutMs,
      terminationTimeoutMs: module.timeouts.terminationTimeoutMs,
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
    inputPageIds: module.inputPageIds,
    outputPageIds: module.outputPageIds,
    claimMaxCount: claim.maxCount,
    claimMaxBytes: claim.maxBytes,
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
        schemaVersion: "dolly.module-submission-record/1",
        ...request,
        processGenerationId: generations.processGenerationIdFor(
          request.moduleGenerationId,
        ),
        createdAt: now(),
      });
    },
    releaseDeliveryClaim: (identity) =>
      options.core.releaseDeliveryClaim(identity),
    negativelyAcknowledgeDeliveryClaim: (request) =>
      options.core.negativelyAcknowledgeDeliveryClaim(request),
    getModuleSubmissionRecord: (runId) =>
      options.core.getModuleSubmissionRecord(runId),
    commits,
    nextModuleGenerationId: options.nextModuleGenerationId,
    monotonicNow: options.monotonicNow,
    declaredExternalEffects: options.declaredExternalEffects,
    ...(options.externalEffectEvidence === undefined
      ? {}
      : { externalEffectEvidence: options.externalEffectEvidence }),
    createExecutor: generations.createExecutor,
    classifyFailure: options.classifyFailure,
    ...(options.onActorEvent === undefined
      ? {}
      : { onActorEvent: options.onActorEvent }),
  });
  return Object.freeze({ resolvedModule, generations, commits, runtime });
}

type InstalledHostRuntimeOptions = Omit<
  InstalledReactiveModuleRuntimeOptions,
  | "configurations"
  | "core"
  | "installations"
  | "instanceConfiguration"
  | "mailboxes"
  | "moduleId"
  | "monotonicNow"
  | "stoppedRecordWriter"
>;

export interface InstalledReactiveModuleHostOptions {
  readonly configuration: DollyInstanceConfig;
  readonly installations: ExtensionInstallationRegistry;
  readonly configurations: ModuleConfigurationStore;
  readonly coreState: FileCoreStateStoreWithStoppedRecordWriter;
  readonly mailboxes: readonly DeliveryMailboxCapacity[];
  readonly clock: SchedulerClock;
  readonly scheduling: ReactiveModuleSchedulingConstraints;
  readonly runtime: InstalledHostRuntimeOptions;
  readonly random?: () => number;
  readonly onSchedulerEvent?: (event: SchedulerEvent) => void;
}

export interface InstalledReactiveModuleHost {
  readonly installedRuntime: InstalledReactiveModuleRuntime;
  readonly host: ReactiveModuleHost;
}

/**
 * Builds the current one-Module Scheduler vertical slice without accepting a
 * caller-supplied runtime or manifest. This remains a product-before-bootstrap
 * composition because instance schema 9 cannot persist its Linux settings.
 */
export function composeInstalledReactiveModuleHost(
  options: InstalledReactiveModuleHostOptions,
): InstalledReactiveModuleHost {
  if (options.configuration.modules.length !== 1) {
    throw new TypeError(
      "Installed reactive Module host currently requires exactly one configured Module",
    );
  }
  const module = options.configuration.modules[0]!;
  const matchingMailboxes = options.mailboxes.filter((mailbox) =>
    mailbox.consumerId === module.moduleId
  );
  if (matchingMailboxes.length !== 1) {
    throw new TypeError(
      `Installed reactive Module host requires one mailbox for Module ${module.moduleId}`,
    );
  }
  const moduleMailbox = matchingMailboxes[0]!;
  if (
    moduleMailbox.pageIds.length !== module.inputPageIds.length ||
    moduleMailbox.pageIds.some((pageId, index) => pageId !== module.inputPageIds[index])
  ) {
    throw new TypeError(
      `Installed reactive Module mailbox Pages do not match Module ${module.moduleId}`,
    );
  }
  const installedRuntime = createInstalledReactiveModuleRuntime({
    ...options.runtime,
    instanceConfiguration: options.configuration,
    moduleId: module.moduleId,
    installations: options.installations,
    configurations: options.configurations,
    core: options.coreState.store,
    stoppedRecordWriter: options.coreState.stoppedRecordWriter,
    mailboxes: options.mailboxes,
    monotonicNow: options.clock.monotonicNow,
  });
  const host = composeReactiveModuleHost({
    configuration: options.configuration,
    deliveries: options.coreState.store.deliveries,
    clock: options.clock,
    scheduling: options.scheduling,
    registrations: [{
      moduleId: module.moduleId,
      runtime: installedRuntime.runtime,
      mailbox: {
        maxPendingCount: moduleMailbox.maxResidentCount,
        maxPendingBytes: moduleMailbox.maxResidentBytes,
      },
      manifest: installedRuntime.resolvedModule.installation.manifest,
    }],
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.onSchedulerEvent === undefined
      ? {}
      : { onSchedulerEvent: options.onSchedulerEvent }),
  });
  return Object.freeze({ installedRuntime, host });
}
