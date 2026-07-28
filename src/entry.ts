import { join, resolve } from "node:path";
import { migrateCoreStateDocumentToVersion16 } from "./core/file-core-state-store.js";
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
  type DollyRuntimeSession,
} from "./core/runtime-bootstrap.js";
import {
  createDefaultDollyInstanceConfig,
  dollyInstanceConfigSchema,
  RuntimeConfigError,
} from "./core/runtime-config.js";

export const DOLLY_CLI_HELP = `Usage: dolly <command> [options]

Commands:
  init                 Create and register a new local instance
  run                  Run an initialized instance in the foreground
  config show          Validate and print the public instance configuration
  migrate-core-state   Migrate a stopped instance's Core state to schema 16
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

export interface DollyCliContext {
  readonly cwd?: string;
  readonly directories?: DollyRuntimeDirectories;
  readonly stdout?: TextOutput;
  readonly stderr?: TextOutput;
  /** Test and embedding hook. The default waits for SIGINT or SIGTERM. */
  readonly waitForShutdown?: (session: DollyRuntimeSession) => Promise<void>;
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
 * Migrates one instance's Core state from `dolly.core-state/15` to version 16.
 *
 * The migration is deliberately an explicit operator command rather than an
 * automatic startup step: Architecture Decision Record 0009 requires a stopped
 * instance, and reading a version 15 document at startup fails closed with
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
  const inspected = configStore(directories).inspect(configPath);
  const statePath = join(inspected.stateDirectory, "core-state.json");

  if (!confirmed) {
    writeLine(stdout, `Instance:        ${inspected.instanceId}`);
    writeLine(stdout, `Core state:      ${statePath}`);
    writeLine(stdout, `Backup will be:  ${statePath}.v15.backup`);
    writeLine(stdout, "");
    writeLine(
      stdout,
      "This replaces the Core state document with schema version 16, which adds",
    );
    writeLine(
      stdout,
      "empty Module process and submission record collections. Existing Delivery",
    );
    writeLine(stdout, "Claims are preserved exactly as they are.");
    writeLine(stdout, "");
    writeLine(
      stdout,
      "Stop the instance first. Any Delivery Claim that is still active after the",
    );
    writeLine(
      stdout,
      "migration has no Module process record, so the next startup reports",
    );
    writeLine(
      stdout,
      "STARTUP_ACTIVE_CLAIM_UNRESOLVED and refuses to run. That refusal is correct:",
    );
    writeLine(
      stdout,
      "Core cannot tell whether such a Claim's Run executed. Resolving it is a",
    );
    writeLine(stdout, "separate audited operator action.");
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
  try {
    const result = migrateCoreStateDocumentToVersion16(statePath);
    if (result === "already-current") {
      writeLine(stdout, `Core state at ${statePath} is already schema version 16`);
      return 0;
    }
    writeLine(stdout, `Migrated ${statePath} to dolly.core-state/16`);
    writeLine(stdout, `Backup:   ${statePath}.v15.backup`);
    writeLine(
      stdout,
      "Keep the backup until the instance has started successfully at least once.",
    );
    return 0;
  } finally {
    await lock.release();
  }
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
    writeLine(stdout, `Dolly ready: ${session.config.instanceId}`);
    writeLine(stdout, JSON.stringify(session.status()));
    try {
      await (context.waitForShutdown ?? (() => waitForProcessSignal()))(session);
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
