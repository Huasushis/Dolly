import { join, resolve } from "node:path";
import {
  CoreStateError,
  migrateCoreStateDocumentToVersion18,
  type CoreStateMigrationResult,
} from "./core/file-core-state-store.js";
import {
  InstanceConfigError,
  InstanceConfigStore,
} from "./core/instance-config-store.js";
import {
  InstanceControllerLock,
  InstanceControllerLockError,
} from "./core/instance-controller-lock.js";
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
import { DOLLY_CLI_HELP } from "./cli/help.js";

export { DOLLY_CLI_HELP };
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
  const store = configStore(directories);
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
    result = migrateCoreStateDocumentToVersion18(statePath, {
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
    `Migrated ${statePath} from ${result.sourceSchemaVersion} to dolly.core-state/18`,
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
    const inspected = configStore(directories).inspect(parsed.configPath);
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

  throw new DollyCliError("CLI_ARGUMENT_INVALID", `Unknown command: ${command}`);
}

function publicError(error: unknown): { readonly code: string; readonly message: string } {
  if (
    error instanceof DollyCliError ||
    error instanceof CoreStateError ||
    error instanceof InstanceConfigError ||
    error instanceof InstanceControllerLockError ||
    error instanceof RuntimeBootstrapError ||
    error instanceof RuntimeConfigError
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
