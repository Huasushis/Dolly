import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DollyCliContext } from "../entry.js";
import { runDollyCli } from "../entry.js";
import { DOLLY_CLI_HELP } from "./help.js";

/**
 * A subcommand selected from the raw process arguments.
 *
 * The dispatch layer owns subcommand selection; the `run`, `config`, and
 * `legacy` variants keep the original argument vector so the executor can
 * re-parse options (for example `--config <path>`) with its own semantics.
 */
export type SubcommandSelection =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "run"; readonly argv: readonly string[] }
  | { readonly kind: "config"; readonly argv: readonly string[] }
  /**
   * Every subcommand the dispatch layer does not own yet (for example `init`,
   * `migrate-core-state`, and migration-blocked daemon commands) plus truly
   * unknown commands. They are forwarded to the legacy entry path, which
   * refuses unknown and migration-blocked subcommands.
   */
  | { readonly kind: "legacy"; readonly argv: readonly string[] };

/**
 * Selects the subcommand for an argument vector using the same first-argument
 * precedence as the installed wrapper: metadata flags resolve first, then the
 * subcommand name, and anything else falls through to the legacy entry path.
 */
export function selectSubcommand(argv: readonly string[]): SubcommandSelection {
  const first = argv[0];
  if (first === "-h" || first === "--help" || first === "help") {
    return { kind: "help" };
  }
  if (first === "-v" || first === "--version" || first === "version") {
    return { kind: "version" };
  }
  if (first === "run") {
    return { kind: "run", argv };
  }
  if (first === "config") {
    return { kind: "config", argv };
  }
  return { kind: "legacy", argv };
}

/**
 * Resolves the installed package version from the nearest `package.json`.
 *
 * The source module lives at `src/cli/dispatch.ts` while the compiled module
 * lives at `dist/src/cli/dispatch.js`, so walking up from the module file is
 * the only depth-independent way to reach the package manifest in both trees.
 */
function installedVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestUrl = join(directory, "package.json");
    if (existsSync(manifestUrl)) {
      const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as {
        version?: unknown;
      };
      if (typeof manifest.version === "string") {
        return manifest.version;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error("Unable to locate the Dolly package version");
}

/**
 * Runs one Dolly command-line invocation and returns the process exit code.
 *
 * The `help` and `version` subcommands resolve without loading the runtime.
 * Every other subcommand is delegated to the legacy entry path
 * (`runDollyCli`), which keeps the installed binary's observable behavior
 * unchanged until each command is migrated off it. The legacy executor also
 * refuses unknown and migration-blocked subcommands.
 */
export async function runCli(
  argv: readonly string[],
  context: DollyCliContext = {},
): Promise<number> {
  const stdout = context.stdout ?? process.stdout;
  const stderr = context.stderr ?? process.stderr;
  try {
    switch (selectSubcommand(argv).kind) {
      case "help":
        stdout.write(`${DOLLY_CLI_HELP}\n`);
        return 0;
      case "version":
        stdout.write(`${installedVersion()}\n`);
        return 0;
      case "run":
      case "config":
      case "legacy":
        return await runDollyCli(argv, context);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`error [CLI_INTERNAL_ERROR]: ${message}\n`);
    return 1;
  }
}