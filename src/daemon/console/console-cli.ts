/**
 * The command-line exposure of the management-console operations.
 *
 * `instance-topology.md` Section 5.2 requires the CLI to call the same
 * control-plane operations as the graphical editor, to supply the expected
 * revision explicitly, to receive the same change plan and the same error
 * codes, to be able to print the plan as structured JavaScript Object Notation
 * (JSON), and to exit non-zero when an operation is refused. Section 5.4 then
 * requires this exposure's operation set to equal the Hypertext Transfer
 * Protocol (HTTP) exposure's set exactly.
 *
 * This module is deliberately independent of `src/entry.ts`: it parses one
 * argument vector and returns the exit code and output text, so it can be
 * tested on its own and wired into the top-level CLI separately.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonValue } from "../../core/canonical-json.js";
import type { ConsoleActor } from "./console-audit.js";
import type { ConsoleOperations } from "./console-operations.js";
import {
  ConsoleOperationError,
  describeExposure,
  type ConsoleOperationDeclaration,
} from "./operation-catalog.js";
import {
  parseDispositions,
  parseModulePrivateStorage,
  parseStartPositions,
  parseTopologyProposal,
} from "./topology-revision.js";

const MAX_PROPOSAL_BYTES = 1024 * 1024;

export interface ConsoleCliContext {
  readonly operations: ConsoleOperations;
  /** Identity of the operating-system account driving the CLI. */
  readonly principalId?: string;
  readonly cwd?: string;
}

export interface ConsoleCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class ConsoleCliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleCliArgumentError";
  }
}

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string>;
}

interface CliCommand {
  readonly path: readonly string[];
  readonly operation: string;
  run(input: {
    readonly arguments: ParsedArguments;
    readonly context: Required<Pick<ConsoleCliContext, "operations" | "cwd">>;
    readonly actor: ConsoleActor;
  }): Promise<JsonValue>;
}

function option(parsed: ParsedArguments, name: string): string {
  const value = parsed.options.get(name);
  if (value === undefined) {
    throw new ConsoleCliArgumentError(`--${name} is required`);
  }
  return value;
}

function optionalOption(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.options.get(name);
}

function positional(parsed: ParsedArguments, index: number, label: string): string {
  const value = parsed.positionals[index];
  if (value === undefined || value.length === 0) {
    throw new ConsoleCliArgumentError(`${label} is required`);
  }
  return value;
}

function readJsonArgument(
  parsed: ParsedArguments,
  inlineName: string,
  fileName: string,
  cwd: string,
): unknown {
  const inline = optionalOption(parsed, inlineName);
  const file = optionalOption(parsed, fileName);
  if (inline !== undefined && file !== undefined) {
    throw new ConsoleCliArgumentError(`--${inlineName} and --${fileName} are mutually exclusive`);
  }
  let text: string;
  if (inline !== undefined) {
    text = inline;
  } else if (file !== undefined) {
    const path = resolve(cwd, file);
    // A hand-edited document becomes effective only through this explicit
    // apply path, never because its bytes changed on disk.
    if (statSync(path).size > MAX_PROPOSAL_BYTES) {
      throw new ConsoleCliArgumentError(`${file} exceeds the ${MAX_PROPOSAL_BYTES}-byte limit`);
    }
    text = readFileSync(path, "utf8");
  } else {
    throw new ConsoleCliArgumentError(`--${inlineName} or --${fileName} is required`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PROPOSAL_BYTES) {
    throw new ConsoleCliArgumentError(`--${inlineName} exceeds the ${MAX_PROPOSAL_BYTES}-byte limit`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConsoleCliArgumentError(`--${inlineName} is not valid JSON`);
  }
}

function optionalJsonArgument(parsed: ParsedArguments, name: string): unknown {
  const raw = optionalOption(parsed, name);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ConsoleCliArgumentError(`--${name} is not valid JSON`);
  }
}

const COMMANDS: readonly CliCommand[] = [
  {
    path: ["instance", "list"],
    operation: "instance.list",
    run: async ({ context }) =>
      ({ instances: await context.operations.listInstances() }) as unknown as JsonValue,
  },
  {
    path: ["instance", "describe"],
    operation: "instance.describe",
    run: async ({ arguments: parsed, context }) =>
      (await context.operations.describeInstance(
        positional(parsed, 2, "instanceId"),
      )) as unknown as JsonValue,
  },
  {
    path: ["instance", "start"],
    operation: "instance.start",
    run: async ({ arguments: parsed, context, actor }) =>
      (await context.operations.startInstance({
        instanceId: positional(parsed, 2, "instanceId"),
        operationId: option(parsed, "operation-id"),
        actor,
      })) as unknown as JsonValue,
  },
  {
    path: ["instance", "stop"],
    operation: "instance.stop",
    run: async ({ arguments: parsed, context, actor }) =>
      (await context.operations.stopInstance({
        instanceId: positional(parsed, 2, "instanceId"),
        operationId: option(parsed, "operation-id"),
        actor,
      })) as unknown as JsonValue,
  },
  {
    path: ["config", "show"],
    operation: "config.read",
    run: async ({ arguments: parsed, context }) =>
      (await context.operations.readConfiguration(
        positional(parsed, 2, "instanceId"),
      )) as unknown as JsonValue,
  },
  {
    path: ["topology", "plan"],
    operation: "topology.plan",
    run: async ({ arguments: parsed, context }) =>
      (await context.operations.planTopologyRevision({
        instanceId: positional(parsed, 2, "instanceId"),
        expectedRevision: option(parsed, "expected-revision"),
        proposal: parseTopologyProposal(
          readJsonArgument(parsed, "proposal-json", "proposal-file", context.cwd),
        ),
        startPositions: parseStartPositions(optionalJsonArgument(parsed, "start-positions")),
        dispositions: parseDispositions(optionalJsonArgument(parsed, "dispositions")),
        modulePrivateStorage: parseModulePrivateStorage(
          optionalJsonArgument(parsed, "module-private-storage"),
        ),
      })) as unknown as JsonValue,
  },
  {
    path: ["topology", "commit"],
    operation: "topology.commit",
    run: async ({ arguments: parsed, context, actor }) => {
      const confirmedPlanDigest = optionalOption(parsed, "confirm-plan");
      return (await context.operations.commitTopologyRevision({
        instanceId: positional(parsed, 2, "instanceId"),
        expectedRevision: option(parsed, "expected-revision"),
        proposal: parseTopologyProposal(
          readJsonArgument(parsed, "proposal-json", "proposal-file", context.cwd),
        ),
        startPositions: parseStartPositions(optionalJsonArgument(parsed, "start-positions")),
        dispositions: parseDispositions(optionalJsonArgument(parsed, "dispositions")),
        modulePrivateStorage: parseModulePrivateStorage(
          optionalJsonArgument(parsed, "module-private-storage"),
        ),
        operationId: option(parsed, "operation-id"),
        actor,
        ...(confirmedPlanDigest === undefined ? {} : { confirmedPlanDigest }),
      })) as unknown as JsonValue;
    },
  },
  {
    path: ["claim", "list-unknown-outcomes"],
    operation: "claim.listUnknownOutcomes",
    run: async ({ arguments: parsed, context }) =>
      ({
        claims: await context.operations.listUnknownOutcomeClaims(
          positional(parsed, 2, "instanceId"),
        ),
      }) as unknown as JsonValue,
  },
  {
    path: ["claim", "dispose-unknown-outcome"],
    operation: "claim.disposeUnknownOutcome",
    run: async ({ arguments: parsed, context, actor }) => {
      const acknowledged = optionalOption(parsed, "acknowledge-warning");
      return (await context.operations.disposeUnknownOutcomeClaim({
        instanceId: positional(parsed, 2, "instanceId"),
        claimToken: option(parsed, "claim-token"),
        disposition: option(parsed, "disposition"),
        operationId: option(parsed, "operation-id"),
        actor,
        ...(acknowledged === undefined ? {} : { acknowledgedWarningDigest: acknowledged }),
      })) as unknown as JsonValue;
    },
  },
];

export const CONSOLE_CLI_COMMANDS: readonly CliCommand[] = Object.freeze([...COMMANDS]);

/** The operations this exposure actually routes, for the parity comparison. */
export function consoleCliExposedOperations(): readonly ConsoleOperationDeclaration[] {
  return describeExposure(COMMANDS.map((command) => command.operation));
}

export const CONSOLE_CLI_HELP = `Usage: dolly console <command> [options]

Commands:
  instance list
  instance describe <instanceId>
  instance start <instanceId> --operation-id <id>
  instance stop <instanceId> --operation-id <id>
  config show <instanceId>
  topology plan <instanceId> --expected-revision <rev> (--proposal-json <json> | --proposal-file <path>)
  topology commit <instanceId> --expected-revision <rev> (--proposal-json <json> | --proposal-file <path>) --operation-id <id> [--confirm-plan <digest>]
  claim list-unknown-outcomes <instanceId>
  claim dispose-unknown-outcome <instanceId> --claim-token <token> --disposition <release|dead-letter|leave-unresolved> --operation-id <id> [--acknowledge-warning <digest>]

Shared options:
  --start-positions <json>         [{"moduleId":"m","pageId":"p","start":"from-now"}]
  --dispositions <json>            [{"pageId":"p","disposition":"dead-letter"}]
  --module-private-storage <json>  [{"moduleId":"m","decision":"retain"}]

Every command prints structured JSON on standard output and exits non-zero when
the operation is refused.`;

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const assignment = argument.indexOf("=");
    const name = assignment === -1 ? argument.slice(2) : argument.slice(2, assignment);
    if (name.length === 0) throw new ConsoleCliArgumentError(`Unknown option: ${argument}`);
    let value: string | undefined;
    if (assignment === -1) {
      value = argv[index + 1];
      index += 1;
    } else {
      value = argument.slice(assignment + 1);
    }
    if (value === undefined) {
      throw new ConsoleCliArgumentError(`--${name} requires a value`);
    }
    if (options.has(name)) {
      throw new ConsoleCliArgumentError(`--${name} may be specified only once`);
    }
    options.set(name, value);
  }
  return { positionals: Object.freeze(positionals), options };
}

/**
 * Runs one console CLI command. Exit code 0 is success, 1 is a refused
 * operation carrying a stable error code, and 2 is an argument error.
 */
export async function runConsoleCliCommand(
  argv: readonly string[],
  context: ConsoleCliContext,
): Promise<ConsoleCliResult> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${(error as Error).message}\n`,
    };
  }
  if (parsed.positionals[0] === "help" || parsed.options.has("help")) {
    return { exitCode: 0, stdout: `${CONSOLE_CLI_HELP}\n`, stderr: "" };
  }
  const command = COMMANDS.find(
    (candidate) =>
      candidate.path[0] === parsed.positionals[0] && candidate.path[1] === parsed.positionals[1],
  );
  if (!command) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Unknown console command: ${parsed.positionals.slice(0, 2).join(" ")}\n${CONSOLE_CLI_HELP}\n`,
    };
  }

  const actor: ConsoleActor = {
    principalId: context.principalId ?? "local-operator",
    interface: "cli",
  };
  try {
    const body = await command.run({
      arguments: parsed,
      context: { operations: context.operations, cwd: context.cwd ?? process.cwd() },
      actor,
    });
    return { exitCode: 0, stdout: `${JSON.stringify(body, null, 2)}\n`, stderr: "" };
  } catch (error) {
    if (error instanceof ConsoleCliArgumentError) {
      return { exitCode: 2, stdout: "", stderr: `${error.message}\n` };
    }
    if (error instanceof ConsoleOperationError) {
      let details: JsonValue | undefined;
      try {
        details = JSON.parse(JSON.stringify(error.details)) as JsonValue;
      } catch {
        details = undefined;
      }
      return {
        exitCode: 1,
        stdout: `${JSON.stringify(
          {
            error: {
              code: error.code,
              message: error.message,
              ...(details === undefined ? {} : { details }),
            },
          },
          null,
          2,
        )}\n`,
        stderr: `${error.code}: ${error.message}\n`,
      };
    }
    throw error;
  }
}
