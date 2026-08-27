import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import type { JsonValue } from "./canonical-json.js";
import {
  CoreStartupRecovery,
  type CoreStartupRecoveryReport,
} from "./core-startup-recovery.js";
import { FileCoreStateStore } from "./file-core-state-store.js";
import { FileMediaByteStore } from "./file-media-byte-store.js";
import { FileModuleResultCommitRepository } from "./file-module-result-commit-repository.js";
import {
  InstanceConfigError,
  type LoadedInstanceConfig,
} from "./instance-config-store.js";
import { InstanceControllerLock } from "./instance-controller-lock.js";
import type { MediaInspector } from "./media-store.js";
import { createModuleResultCommitCoordinator } from "./module-result-commit-factory.js";
import type { ModuleResultCommitCoordinator } from "./module-result-commit.js";
import {
  DollyInstanceConfigAdmission,
  type DollyInstanceConfigDialect,
} from "./instance-config-admission.js";

export interface DollyRuntimeDirectories {
  readonly registryDirectory: string;
  readonly defaultStateRoot: string;
}

export interface DollyRuntimeStatus extends Record<string, JsonValue> {
  schemaVersion: "dolly.runtime-status/3";
  state: DollyRuntimeSessionState;
  instanceId: string;
  displayName: string;
  configPath: string;
  effectiveConfigRevision: string;
  stateDirectory: string;
  coreRevision: number;
  recoveredCommitCount: number;
  /** URL accesses whose request results became unknown after this restart. */
  providerAccessMarkedUnknownCount: number;
}

export type DollyRuntimeSessionState = "ready" | "stopping" | "stopped" | "failed";

export type RuntimeBootstrapErrorCode =
  | "RUNTIME_CONFIG_CHANGED_DURING_START"
  | "RUNTIME_MODULE_MIGRATION_REQUIRED"
  | "RUNTIME_MEDIA_INSPECTOR_UNAVAILABLE"
  | "RUNTIME_TOPOLOGY_MISMATCH"
  | "RUNTIME_START_CLEANUP_FAILED";

export class RuntimeBootstrapError extends Error {
  constructor(
    readonly code: RuntimeBootstrapErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RuntimeBootstrapError";
  }
}

export interface OpenDollyRuntimeOptions extends DollyRuntimeDirectories {
  readonly configPath: string;
  readonly mediaInspector?: MediaInspector;
  readonly now?: () => string;
  readonly nextBlockId?: () => string;
  readonly nextDeliveryId?: (
    kind: "delivery" | "module-job" | "run" | "claim" | "lease" | "dead-letter",
  ) => string;
  readonly processId?: number;
  /**
   * The controller lock the per-instance Runtime Worker already owns for this
   * instance. When supplied the session neither acquires nor releases it
   * (the owning worker lifecycle does); otherwise the session acquires and
   * releases its own lock as before.
   */
  readonly controllerLock?: InstanceControllerLock;
}

function usableEnvironmentPath(
  value: string | undefined,
  pathApi: Pick<typeof posix, "isAbsolute">,
): string | undefined {
  return value === undefined ||
    value.length === 0 ||
    value.includes("\0") ||
    !pathApi.isAbsolute(value)
    ? undefined
    : value;
}

export function defaultDollyRuntimeDirectories(options: {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
} = {}): DollyRuntimeDirectories {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const homeDirectory = pathApi.resolve(options.homeDirectory ?? homedir());
  const environment = options.environment ?? process.env;
  let base: string;
  if (platform === "win32") {
    base = pathApi.resolve(
      usableEnvironmentPath(environment.LOCALAPPDATA, pathApi) ??
        pathApi.join(homeDirectory, "AppData", "Local"),
      "Dolly",
    );
  } else if (platform === "darwin") {
    base = pathApi.resolve(homeDirectory, "Library", "Application Support", "Dolly");
  } else {
    base = pathApi.resolve(
      usableEnvironmentPath(environment.XDG_STATE_HOME, pathApi) ??
        pathApi.join(homeDirectory, ".local", "state"),
      "dolly",
    );
  }
  return Object.freeze({
    registryDirectory: pathApi.join(base, "registry"),
    defaultStateRoot: pathApi.join(base, "instances"),
  });
}

function runtimeId(kind: string): string {
  return `${kind}:${randomUUID()}`;
}

async function createDefaultMediaInspector(): Promise<MediaInspector> {
  try {
    const { SharpMediaInspector } = await import(
      "../adapters/sharp-media-inspector.js"
    );
    return new SharpMediaInspector();
  } catch {
    throw new RuntimeBootstrapError(
      "RUNTIME_MEDIA_INSPECTOR_UNAVAILABLE",
      "Enabled persistent Media requires the optional Sharp image inspector",
    );
  }
}

function reconcilePageTopology(
  core: FileCoreStateStore,
  document: Readonly<DollyInstanceConfigDialect>,
): void {
  const desired = new Set(document.pages.map((page) => page.pageId));
  const snapshot = core.deliveries.snapshot();
  const unexpected = snapshot.pages
    .map((page) => page.id)
    .filter((pageId) => !desired.has(pageId));
  if (unexpected.length > 0) {
    throw new RuntimeBootstrapError(
      "RUNTIME_TOPOLOGY_MISMATCH",
      `Durable Core state contains Pages absent from configuration: ${unexpected.join(", ")}`,
    );
  }
  const subscriptions = snapshot.pages.flatMap((page) =>
    page.subscriptions.map((subscription) => `${page.id}:${subscription.consumerId}`),
  );
  if (subscriptions.length > 0) {
    throw new RuntimeBootstrapError(
      "RUNTIME_TOPOLOGY_MISMATCH",
      "Durable Core state contains Module subscriptions, but module hosting is not migrated",
    );
  }
  const existing = new Set(snapshot.pages.map((page) => page.id));
  for (const page of document.pages) {
    if (!existing.has(page.pageId)) core.deliveries.createPage(page.pageId);
  }
}

export class DollyRuntimeSession {
  readonly config: LoadedInstanceConfig<DollyInstanceConfigDialect>;
  readonly core: FileCoreStateStore;
  readonly commits: ModuleResultCommitCoordinator;
  readonly recovery: CoreStartupRecoveryReport;
  readonly providerAccessMarkedUnknownCount: number;
  readonly #controllerLock: InstanceControllerLock;
  readonly #ownsControllerLock: boolean;
  #state: DollyRuntimeSessionState = "ready";
  #stopOperation: Promise<void> | undefined;

  constructor(options: {
    readonly config: LoadedInstanceConfig<DollyInstanceConfigDialect>;
    readonly core: FileCoreStateStore;
    readonly commits: ModuleResultCommitCoordinator;
    readonly recovery: CoreStartupRecoveryReport;
    readonly providerAccessMarkedUnknownCount: number;
    readonly controllerLock: InstanceControllerLock;
    readonly ownsControllerLock: boolean;
  }) {
    this.config = options.config;
    this.core = options.core;
    this.commits = options.commits;
    this.recovery = options.recovery;
    this.providerAccessMarkedUnknownCount = options.providerAccessMarkedUnknownCount;
    this.#controllerLock = options.controllerLock;
    this.#ownsControllerLock = options.ownsControllerLock;
  }

  get state(): DollyRuntimeSessionState {
    return this.#state;
  }

  status(): DollyRuntimeStatus {
    return Object.freeze({
      schemaVersion: "dolly.runtime-status/3" as const,
      state: this.#state,
      instanceId: this.config.instanceId,
      displayName: this.config.document.displayName,
      configPath: this.config.configPath,
      effectiveConfigRevision: this.config.configRevision,
      stateDirectory: this.config.stateDirectory,
      coreRevision: this.core.revision,
      recoveredCommitCount: this.recovery.recoveredCommits.length,
      providerAccessMarkedUnknownCount: this.providerAccessMarkedUnknownCount,
    });
  }

  stop(): Promise<void> {
    if (this.#state === "stopped") return Promise.resolve();
    if (this.#stopOperation) return this.#stopOperation;
    this.#state = "stopping";
    this.#stopOperation = Promise.resolve().then(async () => {
      try {
        this.core.flush();
        if (this.#ownsControllerLock) {
          await this.#controllerLock.release();
        }
        this.#state = "stopped";
      } catch (error) {
        this.#state = "failed";
        throw error;
      }
    });
    return this.#stopOperation;
  }
}

export async function openDollyRuntime(
  options: OpenDollyRuntimeOptions,
): Promise<DollyRuntimeSession> {
  const now = options.now ?? (() => new Date().toISOString());
  const admission = new DollyInstanceConfigAdmission({
    registryDirectory: options.registryDirectory,
    defaultStateRoot: options.defaultStateRoot,
    now,
  });
  const inspected = admission.inspect(options.configPath);
  if (inspected.document.modules.length > 0) {
    throw new RuntimeBootstrapError(
      "RUNTIME_MODULE_MIGRATION_REQUIRED",
      "Configured Modules require the isolated extension process runtime; refusing the legacy in-process Orchestrator",
    );
  }
  const mediaInspector =
    inspected.document.core.media.enabled
      ? options.mediaInspector ?? await createDefaultMediaInspector()
      : undefined;

  const ownsControllerLock = options.controllerLock === undefined;
  const controllerLock =
    options.controllerLock ??
    await InstanceControllerLock.acquire({
      directory: join(resolve(options.registryDirectory), "controllers"),
      instanceId: inspected.instanceId,
      ...(options.processId === undefined ? {} : { processId: options.processId }),
      now,
    });
  try {
    let config: LoadedInstanceConfig<DollyInstanceConfigDialect>;
    try {
      config = admission.claim(inspected.configPath, {
        instanceId: inspected.instanceId,
        configRevision: inspected.configRevision,
      });
    } catch (error) {
      if (
        error instanceof InstanceConfigError &&
        (error.code === "CONFIG_INSTANCE_ID_CHANGED" ||
          error.code === "CONFIG_REVISION_CONFLICT")
      ) {
        throw new RuntimeBootstrapError(
          "RUNTIME_CONFIG_CHANGED_DURING_START",
          "Configuration changed while the runtime was acquiring ownership; retry startup",
          { cause: error },
        );
      }
      throw error;
    }
    const previousCommitJournalPath = join(config.stateDirectory, "processing-commits.json");
    if (existsSync(previousCommitJournalPath)) {
      throw new RuntimeBootstrapError(
        "RUNTIME_MODULE_MIGRATION_REQUIRED",
        "The legacy processing-commits.json file must be migrated before startup",
      );
    }

    const media = config.document.core.media.enabled
      ? {
          durability: "persistent" as const,
          bytes: new FileMediaByteStore({
            directory: join(config.stateDirectory, "media", "objects"),
            maxMediaBytes: config.document.core.media.maxMediaBytes,
          }),
          inspector: mediaInspector!,
          maxMediaBytes: config.document.core.media.maxMediaBytes,
          maxTotalMediaBytes: config.document.core.media.maxTotalMediaBytes,
          maxRegistrationRecords: config.document.core.media.maxRegistrationRecords,
          maxStorageRecords: config.document.core.media.maxStorageRecords,
          maxProviderAccessRecords: config.document.core.media.maxProviderAccessRecords,
          deletedRegistrationRetentionMs:
            config.document.core.media.deletedRegistrationRetentionMs,
          idNamespace: config.instanceId,
        }
      : undefined;
    const core = new FileCoreStateStore({
      path: join(config.stateDirectory, "core-state.json"),
      maxBytes: config.document.core.limits.maxStateBytes,
      maxFailedAttempts: config.document.core.limits.maxFailedAttempts,
      nextBlockId: options.nextBlockId ?? (() => runtimeId("block")),
      nextDeliveryId: options.nextDeliveryId ?? ((kind) => runtimeId(kind)),
      now,
      ...(media === undefined ? {} : { media }),
    });
    core.media?.removeExpiredDeletedRegistrations();
    await core.media?.recoverDeletions();
    await core.media?.recoverRegistrations();
    await core.media?.verifyStoredBytes();
    await core.media?.recoverUploads();
    const providerAccessMarkedUnknown =
      core.media?.markProviderAccessUnknownAfterRestart() ?? [];
    reconcilePageTopology(core, config.document);

    const repository = new FileModuleResultCommitRepository({
      path: join(config.stateDirectory, "module-result-commits.json"),
      maxBytes: config.document.core.limits.maxModuleResultCommitJournalBytes,
    });
    const commits = createModuleResultCommitCoordinator({
      core,
      repository,
      now,
      // Non-empty Module configurations are still rejected above. Product
      // composition must supply every validated consumer mailbox before that
      // guard can ever be reconsidered.
      mailboxes: [],
    });
    const recovery = await new CoreStartupRecovery({
      deliveries: core.deliveries,
      commits,
      moduleRecords: core,
    }).recover();
    core.flush();
    return new DollyRuntimeSession({
      config,
      core,
      commits,
      recovery,
      providerAccessMarkedUnknownCount: providerAccessMarkedUnknown.length,
      controllerLock,
      ownsControllerLock,
    });
  } catch (error) {
    try {
      if (ownsControllerLock) {
        await controllerLock.release();
      }
    } catch (releaseError) {
      throw new RuntimeBootstrapError(
        "RUNTIME_START_CLEANUP_FAILED",
        "Runtime startup failed and its controller lock could not be released",
        { cause: new AggregateError([error, releaseError]) },
      );
    }
    throw error;
  }
}
