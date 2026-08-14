#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Help text for the un-built wrapper, kept in sync with the canonical
// DOLLY_CLI_HELP in src/cli/help.ts. When the package is built this wrapper
// routes every invocation through the compiled subcommand dispatcher
// (dist/src/cli/dispatch.js), which is the single source of subcommand
// selection, the installed version, and the canonical help.
const METADATA_HELP = `Usage: dolly <command> [options]

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

const dispatchUrl = new URL("../dist/src/cli/dispatch.js", import.meta.url);

if (existsSync(fileURLToPath(dispatchUrl))) {
  const dispatch = await import(dispatchUrl.href);
  process.exitCode = await dispatch.runCli(process.argv.slice(2));
} else {
  // The installed package always ships dist, but the metadata commands must
  // still resolve before a build exists (running `node bin/dolly.js --help`
  // from a source checkout, for example).
  const [command] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(METADATA_HELP);
  } else if (command === "--version" || command === "-v" || command === "version") {
    const packageUrl = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageUrl, "utf8"));
    console.log(packageJson.version);
  } else {
    console.error("Dolly is not built. Run `npm run build` before invoking the CLI.");
    process.exitCode = 1;
  }
}