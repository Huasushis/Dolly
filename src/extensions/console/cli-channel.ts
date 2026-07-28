import { consoleError, ConsoleExtensionError } from "./errors.js";
import {
  parseExternalMessage,
  EXTERNAL_MESSAGE_TYPE,
  EXTERNAL_MESSAGE_VERSION,
  type ConsoleExternalMessage,
  type ExternalMessageLimits,
} from "./external-message.js";
import type { ConsoleSessionStore } from "./session-store.js";

/**
 * Command-line binding.
 *
 * Section 8.3 requires the CLI to call the same operations with the same
 * authorization, idempotency, and error kinds as the browser. It does that by
 * building the same `dolly.console.external-message/1` envelope and handing it
 * to the same `parseExternalMessage` validator and the same session store; the
 * only thing that differs is how the arguments arrive.
 *
 * Credentials never come from `argv`. On every mainstream operating system the
 * command line of a process is readable by other local processes, so the CLI
 * refuses credential-bearing flags outright instead of warning about them.
 */

/** Flags that would put a credential on the command line. */
const FORBIDDEN_CREDENTIAL_FLAGS = new Set([
  "--token",
  "--session-token",
  "--cookie",
  "--csrf",
  "--csrf-token",
  "--password",
  "--secret",
  "--api-key",
  "--pairing-code",
  "--bearer",
]);

export interface ConsoleCliIdentity {
  readonly sessionId: string;
  readonly principalId: string;
}

/**
 * Where the CLI gets its session. A real implementation reads protected
 * standard input, an OS credential store, or an already authenticated local
 * gateway session; none of those is an argument or a URL query string.
 */
export interface ConsoleCredentialSource {
  read(): ConsoleCliIdentity | null;
}

export interface ConsoleCliDependencies {
  readonly store: ConsoleSessionStore;
  readonly credentials: ConsoleCredentialSource;
  /** Structured JSON Lines sink for non-interactive use. */
  readonly writeLine: (line: string) => void;
  readonly messageLimits?: Partial<ExternalMessageLimits>;
}

export interface ConsoleCliResult {
  readonly exitCode: number;
}

interface ParsedArguments {
  readonly command: string;
  readonly options: ReadonlyMap<string, readonly string[]>;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length === 0) {
    throw consoleError("MESSAGE_INVALID", "A command is required");
  }
  const command = argv[0]!;
  if (command.startsWith("-")) {
    throw consoleError("MESSAGE_INVALID", "The first argument must be a command");
  }
  const options = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      throw consoleError("MESSAGE_INVALID", "Positional arguments are not accepted");
    }
    // An `--flag=value` form would still place the value in the command line,
    // so it is rejected by the same check as the separated form below.
    const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (FORBIDDEN_CREDENTIAL_FLAGS.has(name)) {
      throw consoleError(
        "CREDENTIAL_IN_ARGUMENT",
        "Credentials must not be passed as command-line arguments",
        { flag: name },
      );
    }
    let value: string;
    if (token.includes("=")) {
      value = token.slice(token.indexOf("=") + 1);
    } else {
      index += 1;
      if (index >= argv.length) {
        throw consoleError("MESSAGE_INVALID", `Option ${name} needs a value`);
      }
      value = argv[index]!;
    }
    const existing = options.get(name);
    if (existing) existing.push(value);
    else options.set(name, [value]);
  }
  return { command, options };
}

function single(options: ParsedArguments["options"], name: string): string | undefined {
  const values = options.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) {
    throw consoleError("MESSAGE_INVALID", `Option ${name} may appear once`);
  }
  return values[0];
}

function required(options: ParsedArguments["options"], name: string): string {
  const value = single(options, name);
  if (value === undefined) {
    throw consoleError("MESSAGE_INVALID", `Option ${name} is required`);
  }
  return value;
}

/**
 * Builds the shared envelope from CLI arguments.
 *
 * This is the parity anchor: the HTTP binding and this function both produce a
 * value that only `parseExternalMessage` may bless, so the two transports
 * cannot drift into accepting different messages.
 */
export function buildCliExternalMessage(
  argv: readonly string[],
  limits?: Partial<ExternalMessageLimits>,
): ConsoleExternalMessage {
  const parsed = parseArguments(argv);
  if (parsed.command !== "send") {
    throw consoleError("MESSAGE_INVALID", "Only the send command builds a message");
  }
  const text = single(parsed.options, "--text");
  const attachments = parsed.options.get("--attach") ?? [];
  return parseExternalMessage(
    {
      version: EXTERNAL_MESSAGE_VERSION,
      type: EXTERNAL_MESSAGE_TYPE,
      operationId: required(parsed.options, "--operation"),
      clientMessageId: required(parsed.options, "--client-message"),
      routeAlias: required(parsed.options, "--route"),
      ...(text === undefined ? {} : { text }),
      ...(attachments.length === 0
        ? {}
        : { attachments: attachments.map((uploadGrantId) => ({ uploadGrantId })) }),
      ...(single(parsed.options, "--locale") === undefined
        ? {}
        : { locale: single(parsed.options, "--locale") }),
    },
    limits,
  );
}

/**
 * Runs one CLI operation. Terminal failures exit non-zero with a stable error
 * code; the human-readable message is never the machine contract.
 */
export function runConsoleCli(
  argv: readonly string[],
  dependencies: ConsoleCliDependencies,
): ConsoleCliResult {
  const emit = (event: Record<string, unknown>): void => {
    dependencies.writeLine(JSON.stringify(event));
  };
  try {
    const parsed = parseArguments(argv);
    const identity = dependencies.credentials.read();
    if (!identity) {
      throw consoleError("AUTH_REQUIRED", "No authenticated Console session is available");
    }

    switch (parsed.command) {
      case "send": {
        const message = buildCliExternalMessage(argv, dependencies.messageLimits);
        const receipt = dependencies.store.acceptMessage({
          sessionId: identity.sessionId,
          principalId: identity.principalId,
          message,
        });
        emit({
          event: "message.accepted",
          externalMessageId: receipt.externalMessageId,
          acceptanceSequence: receipt.acceptanceSequence,
          disposition: receipt.disposition,
        });
        return { exitCode: 0 };
      }
      case "display": {
        const after = single(parsed.options, "--after");
        const items = dependencies.store.listDisplay({
          sessionId: identity.sessionId,
          principalId: identity.principalId,
          ...(after === undefined ? {} : { afterSequence: after }),
        });
        for (const item of items) emit({ event: "display.item", item });
        return { exitCode: 0 };
      }
      case "ack": {
        const result = dependencies.store.ackDisplay({
          sessionId: identity.sessionId,
          principalId: identity.principalId,
          operationId: required(parsed.options, "--operation"),
          ackThrough: required(parsed.options, "--through"),
        });
        emit({ event: "display.acked", ackThrough: result.ackThrough });
        return { exitCode: 0 };
      }
      default:
        throw consoleError("MESSAGE_INVALID", `Unknown command ${parsed.command}`);
    }
  } catch (error) {
    if (error instanceof ConsoleExtensionError) {
      emit({ event: "error", code: error.code, message: error.message });
      return { exitCode: 1 };
    }
    // An unexpected failure never becomes a success exit code, and its stack
    // stays a local diagnostic.
    emit({ event: "error", code: "INTERNAL_ERROR", message: "Console CLI failed" });
    return { exitCode: 1 };
  }
}
