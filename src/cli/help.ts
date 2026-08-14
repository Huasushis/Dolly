/**
 * Canonical command-line help text for the installed `dolly` binary.
 *
 * This module deliberately has no runtime dependencies so that help and
 * version metadata resolve without loading the Dolly runtime graph.
 */
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