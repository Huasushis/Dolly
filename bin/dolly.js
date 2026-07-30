#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const help = `Usage: dolly <command>

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

const [command] = process.argv.slice(2);

if (command === "--help" || command === "-h" || command === "help") {
  console.log(help);
} else if (command === "--version" || command === "-v") {
  const packageUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageUrl, "utf8"));
  console.log(packageJson.version);
} else {
  const entryUrl = new URL("../dist/src/entry.js", import.meta.url);
  if (!existsSync(fileURLToPath(entryUrl))) {
    console.error("Dolly is not built. Run `npm run build` before invoking the CLI.");
    process.exitCode = 1;
  } else {
    const entry = await import(entryUrl.href);
    process.exitCode = await entry.runDollyCli(process.argv.slice(2));
  }
}
