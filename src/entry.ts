import { join, resolve } from "node:path";
import {
  CoreStateError,
  migrateCoreStateDocumentToVersion19,
  type CoreStateMigrationResult,
} from "./core/file-core-state-store.js";
import {
  InstanceConfigError,
  InstanceConfigStore,
} from "./core/instance-config-store.js";
import { DollyInstanceConfigAdmission } from "./core/instance-config-admission.js";
import {
  InstanceControllerLock,
  InstanceControllerLockError,
} from "./core/instance-controller-lock.js";
import {
  openRuntimeWorkerHost,
  type RuntimeWorkerHost,
} from "./adapters/worker-host-composition.js";
import { InstalledWorkerHostError } from "./adapters/installed-worker-host.js";

import { projectRuntimeInstanceStableId } from "./core/runtime-authority-identities.js";
import {
  defaultDollyRuntimeDirectories,
  openDollyRuntime,
  RuntimeBootstrapError,
  type DollyRuntimeDirectories,
  type DollyRuntimeSession as InternalDollyRuntimeSession,
  type DollyRuntimeSessionState,
  type DollyRuntimeStatus,
} from "./core/runtime-bootstrap.js";
import {
  createDefaultDollyInstanceConfig,
  dollyInstanceConfigSchema,
  RuntimeConfigError,
} from "./core/runtime-config.js";
export {
  produceReservedV10ExtensionPackageManifest,
  type ProduceReservedV10ExtensionPackageManifestOptions,
  type ReservedV10InstalledExtensionPackageManifest,
} from "./core/reserved-v10-extension-package.js";

export const DOLLY_CLI_HELP = `Usage: dolly <command> [options]

Commands:
  init                 Create and register a new local instance
  run                  Run an initialized instance in the foreground
  config show          Validate and print the public instance configuration
  migrate-core-state   Migrate a stopped instance's Core state to the current schema
  help                 Show this help

Options:
  --config <path>      Configuration path (default: ./dolly.json)
  --name <name>        Display name for a new instance (init only)
  --confirm            Perform a migration instead of describing it
  -h, --help           Show this help
  -v, --version        Show the installed version

Daemon and extension commands are unavailable until their secure runtime migration is complete.`;

export type DollyCliErrorCode =
  | "CLI_ARGUMENT_INVALID"
  | "CLI_FEATURE_UNAVAILABLE"
  | "CLI_INTERNAL_ERROR";

export class DollyCliError extends Error {
  constructor(
    readonly code: DollyCliErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DollyCliError";
  }
}

interface TextOutput {
  write(text: string): unknown;
}

/**
 * The limited runtime session passed to the command-line interface shutdown
 * hook. It exposes lifecycle state, status, and orderly stop, but not the
 * mutable Core state or result-commit coordinator owned by the runtime.
 */
export interface DollyRuntimeSession {
  readonly state: DollyRuntimeSessionState;
  status(): Readonly<DollyRuntimeStatus>;
  stop(): Promise<void>;
}

export interface DollyCliContext {
  readonly cwd?: string;
  readonly directories?: DollyRuntimeDirectories;
  readonly stdout?: TextOutput;
  readonly stderr?: TextOutput;
  /** Test and embedding hook. The default waits for SIGINT or SIGTERM. */
  readonly waitForShutdown?: (session: DollyRuntimeSession) => Promise<void>;
  /**
   * Set when dollyd launches this per-instance Runtime Worker: the daemon
   * installation identity and the tool-broker extension alias this worker
   * owns. When absent the worker-host route is not engaged and `run` is the
   * legacy-only runtime.
   */
  readonly runtimeWorker?: {
    readonly daemonInstallationId: string;
    readonly extensionAlias: string;
  };
}

function createPublicRuntimeSession(
  session: InternalDollyRuntimeSession,
): DollyRuntimeSession {
  return Object.freeze({
    get state(): DollyRuntimeSessionState {
      return session.state;
    },
    status: () => session.status(),
    stop: () => session.stop(),
  });
}

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly configPath: string;
  readonly displayName: string | undefined;
  readonly help: boolean;
  /** Explicit acknowledgement required by an irreversible state migration. */
  readonly confirm: boolean;
}

const MIGRATION_BLOCKED_COMMANDS = new Set([
  "daemon",
  "extension",
  "log",
  "logs",
  "mcp",
  "module",
  "restart",
  "start",
  "status",
  "stop",
]);

function writeLine(output: TextOutput, value: string): void {
  output.write(`${value}\n`);
}

function parseArguments(argv: readonly string[], cwd: string): ParsedArguments {
  const positionals: string[] = [];
  let configValue: string | undefined;
  let displayName: string | undefined;
  let help = false;
  let confirm = false;

  const assignOnce = (
    label: string,
    current: string | undefined,
    value: string | undefined,
  ): string => {
    if (current !== undefined) {
      throw new DollyCliError("CLI_ARGUMENT_INVALID", `${label} may be specified only once`);
    }
    if (value === undefined || value.length === 0 || value.includes("\0")) {
      throw new DollyCliError("CLI_ARGUMENT_INVALID", `${label} requires a non-empty value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "-h" || argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "--confirm") {
      confirm = true;
      continue;
    }
    if (argument === "--config" || argument === "--name") {
      const value = argv[index + 1];
      index += 1;
      if (argument === "--config") {
        configValue = assignOnce("--config", configValue, value);
      } else {
        displayName = assignOnce("--name", displayName, value);
      }
      continue;
    }
    if (argument.startsWith("--config=")) {
      configValue = assignOnce("--config", configValue, argument.slice("--config=".length));
      continue;
    }
    if (argument.startsWith("--name=")) {
      displayName = assignOnce("--name", displayName, argument.slice("--name=".length));
      continue;
    }
    if (argument.startsWith("-")) {
      throw new DollyCliError("CLI_ARGUMENT_INVALID", `Unknown option: ${argument}`);
    }
    positionals.push(argument);
  }

  return Object.freeze({
    positionals: Object.freeze(positionals),
    configPath: resolve(cwd, configValue ?? "dolly.json"),
    displayName,
    help,
    confirm,
  });
}

/**
 * Migrates one stopped instance's Core state to the current supported schema.
 *
 * The migration is deliberately an explicit operator command rather than an
 * automatic startup step: Architecture Decision Record 0009 requires a stopped
 * instance, and reading an older document at startup fails closed with
 * `CORE_STATE_MIGRATION_REQUIRED` instead of guessing. The instance controller
 * lock is taken so the command cannot run against a live instance, and the
 * original bytes are kept beside the state file before it is replaced.
 */
async function migrateCoreState(options: {
  readonly configPath: string;
  readonly directories: DollyRuntimeDirectories;
  readonly confirmed: boolean;
  readonly stdout: TextOutput;
}): Promise<number> {
  const { configPath, directories, confirmed, stdout } = options;
  const store = admissionConfigStore(directories);
  const inspected = store.inspect(configPath);

  if (!confirmed) {
    const statePath = join(inspected.stateDirectory, "core-state.json");
    writeLine(stdout, `Instance:        ${inspected.instanceId}`);
    writeLine(stdout, `Core state:      ${statePath}`);
    writeLine(
      stdout,
      "Backup:          chosen from the validated source schema during migration",
    );
    writeLine(stdout, "");
    writeLine(
      stdout,
      "This validates a supported older Core state document and migrates it",
    );
    writeLine(
      stdout,
      "directly to the current schema. The confirmed command reports the exact",
    );
    writeLine(stdout, "source schema, target schema, and backup path.");
    writeLine(stdout, "");
    writeLine(
      stdout,
      "Stop the instance first. An active Delivery Claim whose older state lacks",
    );
    writeLine(
      stdout,
      "an exact Module submission record remains explicitly unresolved. The next",
    );
    writeLine(
      stdout,
      "startup reports STARTUP_ACTIVE_CLAIM_UNRESOLVED rather than guessing",
    );
    writeLine(
      stdout,
      "whether sending was authorized. Resolving it is a separate audited",
    );
    writeLine(stdout, "operator action. Dolly does not yet provide that command, so the");
    writeLine(stdout, "affected Module remains blocked.");
    writeLine(stdout, "");
    writeLine(stdout, "Re-run with --confirm to perform the migration.");
    return 0;
  }

  // Holding the controller lock proves no runtime owns this instance. A live
  // instance would also be holding it, so acquisition failing is the answer.
  const lock = await InstanceControllerLock.acquire({
    directory: join(resolve(directories.registryDirectory), "controllers"),
    instanceId: inspected.instanceId,
  });
  let statePath: string;
  let result: CoreStateMigrationResult;
  try {
    const claimed = store.claim(configPath, {
      instanceId: inspected.instanceId,
      configRevision: inspected.configRevision,
    });
    statePath = join(claimed.stateDirectory, "core-state.json");
    result = migrateCoreStateDocumentToVersion19(statePath, {
      maxBytes: claimed.document.core.limits.maxStateBytes,
      runtimeConfiguration: {
        maxFailedAttempts: claimed.document.core.limits.maxFailedAttempts,
        media: claimed.document.core.media.enabled
          ? {
              enabled: true,
              idNamespace: claimed.instanceId,
              maxMediaBytes: claimed.document.core.media.maxMediaBytes,
              maxTotalMediaBytes:
                claimed.document.core.media.maxTotalMediaBytes,
              maxRegistrationRecords:
                claimed.document.core.media.maxRegistrationRecords,
              maxStorageRecords:
                claimed.document.core.media.maxStorageRecords,
              maxProviderAccessRecords:
                claimed.document.core.media.maxProviderAccessRecords,
              deletedRegistrationRetentionMs:
                claimed.document.core.media.deletedRegistrationRetentionMs,
            }
          : { enabled: false },
      },
    });
  } finally {
    await lock.release();
  }

  if (result.status === "already-current") {
    writeLine(
      stdout,
      `Core state at ${statePath} is already ${result.schemaVersion}`,
    );
    return 0;
  }
  writeLine(
    stdout,
    `Migrated ${statePath} from ${result.sourceSchemaVersion} to dolly.core-state/19`,
  );
  writeLine(stdout, `Backup:   ${result.backupPath}`);
  writeLine(
    stdout,
    "Keep the backup until the instance has started successfully at least once.",
  );
  return 0;
}

function configStore(directories: DollyRuntimeDirectories) {
  return new InstanceConfigStore({
    schema: dollyInstanceConfigSchema,
    registryDirectory: directories.registryDirectory,
    defaultStateRoot: directories.defaultStateRoot,
  });
}

function admissionConfigStore(directories: DollyRuntimeDirectories) {
  return new DollyInstanceConfigAdmission({
    registryDirectory: directories.registryDirectory,
    defaultStateRoot: directories.defaultStateRoot,
  });
}

function waitForProcessSignal(): Promise<void> {
  return new Promise((resolveWait) => {
    let received = false;
    const finish = () => {
      if (received) return;
      received = true;
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolveWait();
    };
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
  });
}

async function execute(
  argv: readonly string[],
  context: DollyCliContext,
): Promise<number> {
  const cwd = resolve(context.cwd ?? process.cwd());
  const stdout = context.stdout ?? process.stdout;
  const parsed = parseArguments(argv, cwd);
  if (parsed.help || parsed.positionals.length === 0 || parsed.positionals[0] === "help") {
    writeLine(stdout, DOLLY_CLI_HELP);
    return 0;
  }

  const command = parsed.positionals[0]!;
  if (MIGRATION_BLOCKED_COMMANDS.has(command)) {
    throw new DollyCliError(
      "CLI_FEATURE_UNAVAILABLE",
      `${command} is unavailable until the secure daemon and extension runtime migration is complete`,
    );
  }
  const directories = context.directories ?? defaultDollyRuntimeDirectories();

  if (command === "init") {
    if (parsed.positionals.length !== 1) {
      throw new DollyCliError("CLI_ARGUMENT_INVALID", "Usage: dolly init [--config <path>] [--name <name>]");
    }
    const initialized = configStore(directories).initialize(parsed.configPath, (instanceId) =>
      createDefaultDollyInstanceConfig(instanceId, parsed.displayName ?? "Dolly"),
    );
    writeLine(stdout, `Initialized Dolly instance ${initialized.instanceId}`);
    writeLine(stdout, `Configuration: ${initialized.configPath}`);
    writeLine(stdout, `State: ${initialized.stateDirectory}`);
    return 0;
  }

  if (parsed.displayName !== undefined) {
    throw new DollyCliError("CLI_ARGUMENT_INVALID", "--name is valid only with dolly init");
  }

  if (command === "config") {
    if (parsed.positionals.length !== 2 || parsed.positionals[1] !== "show") {
      if (parsed.positionals[1] === "edit") {
        throw new DollyCliError(
          "CLI_FEATURE_UNAVAILABLE",
          "config edit is unavailable until revision-checked schema-aware editing is implemented",
        );
      }
      throw new DollyCliError(
        "CLI_ARGUMENT_INVALID",
        "Usage: dolly config show [--config <path>]",
      );
    }
    const inspected = admissionConfigStore(directories).inspect(parsed.configPath);
    writeLine(stdout, JSON.stringify(inspected.redactedDocument, null, 2));
    return 0;
  }

  if (command === "migrate-core-state") {
    if (parsed.positionals.length !== 1) {
      throw new DollyCliError(
        "CLI_ARGUMENT_INVALID",
        "Usage: dolly migrate-core-state [--config <path>] --confirm",
      );
    }
    return await migrateCoreState({
      configPath: parsed.configPath,
      directories,
      confirmed: parsed.confirm,
      stdout,
    });
  }

  if (command === "run") {
    if (parsed.positionals.length !== 1) {
      throw new DollyCliError("CLI_ARGUMENT_INVALID", "Usage: dolly run [--config <path>]");
    }
    const runtimeWorker = context.runtimeWorker;
    if (runtimeWorker === undefined) {
      const session = await openDollyRuntime({
        configPath: parsed.configPath,
        ...directories,
      });
      const status = session.status();
      writeLine(stdout, `Dolly ready: ${status.instanceId}`);
      writeLine(stdout, JSON.stringify(status));
      try {
        await (context.waitForShutdown ?? (() => waitForProcessSignal()))(
          createPublicRuntimeSession(session),
        );
      } finally {
        await session.stop();
      }
      writeLine(stdout, "Dolly stopped");
      return 0;
    }
    const inspected = admissionConfigStore(directories).inspect(parsed.configPath);
    const controllerLock = await InstanceControllerLock.acquire({
      directory: join(resolve(directories.registryDirectory), "controllers"),
      instanceId: inspected.instanceId,
    });
    let session: InternalDollyRuntimeSession | undefined;
    let workerHost: RuntimeWorkerHost | undefined;
    try {
      session = await openDollyRuntime({
        configPath: parsed.configPath,
        ...directories,
        controllerLock,
      });
      workerHost = await openRuntimeWorkerHost({
        registryDirectory: directories.registryDirectory,
        stateDirectory: inspected.stateDirectory,
        identity: {
          daemonInstallationId: runtimeWorker.daemonInstallationId,
          instanceId: projectRuntimeInstanceStableId(inspected.instanceId),
        },
        extensionAlias: runtimeWorker.extensionAlias,
        controllerLock,
      });
    } catch (error) {
      if (workerHost !== undefined) {
        try {
          await workerHost.close();
        } catch {
          // Propagate the original startup failure.
        }
      } else {
        try {
          await session?.stop();
        } catch {
          // Continue to release the owned controller lock.
        }
        try {
          await controllerLock.release();
        } catch {
          // Continue to propagate the original startup failure.
        }
      }
      throw error;
    }
    const status = session.status();
    writeLine(stdout, `Dolly ready: ${status.instanceId}`);
    writeLine(stdout, JSON.stringify(status));
    try {
      await (context.waitForShutdown ?? (() => waitForProcessSignal()))(
        createPublicRuntimeSession(session),
      );
    } finally {
      // Caller-supplied lock: the session never releases it; this worker
      // lifecycle owns stop-then-close-then-release ordering.
      await session.stop();
      await workerHost.close();
    }
    writeLine(stdout, "Dolly stopped");
    return 0;
  }

  throw new DollyCliError("CLI_ARGUMENT_INVALID", `Unknown command: ${command}`);
}

function publicError(error: unknown): { readonly code: string; readonly message: string } {
  if (
    error instanceof DollyCliError ||
    error instanceof CoreStateError ||
    error instanceof InstanceConfigError ||
    error instanceof InstanceControllerLockError ||
    error instanceof RuntimeBootstrapError ||
    error instanceof RuntimeConfigError ||
    error instanceof InstalledWorkerHostError
  ) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "CLI_INTERNAL_ERROR",
    message: "Dolly encountered an unexpected internal error",
  };
}

export async function runDollyCli(
  argv: readonly string[] = process.argv.slice(2),
  context: DollyCliContext = {},
): Promise<number> {
  const stderr = context.stderr ?? process.stderr;
  try {
    return await execute(argv, context);
  } catch (error) {
    const failure = publicError(error);
    writeLine(stderr, `error [${failure.code}]: ${failure.message}`);
    return error instanceof DollyCliError && error.code !== "CLI_INTERNAL_ERROR" ? 2 : 1;
  }
}
