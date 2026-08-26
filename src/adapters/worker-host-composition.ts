/**
 * Host-owned worker-host composition: the production Host-owner call path
 * for one installed stdio tool server.
 *
 * The Host daemon holds the already-open Runtime authority repository and the
 * installed-package facts; this composition derives the sealed Worker-start
 * premise from the CURRENT authority snapshot (the admitted tool-broker
 * server contract) plus those installation facts, projects it through the
 * repository, and launches the installed `worker_host` binary through the
 * premise-gated adapter. It is the real non-test caller of
 * `launchInstalledWorkerHost`.
 *
 * The higher public `RUNTIME_MODULE_MIGRATION_REQUIRED` guard in
 * `src/core/runtime-bootstrap.ts` stays unconditional: this composition is
 * internal Host code and does not make product startup reachable.
 */

import {
  InstalledWorkerHostError,
  launchInstalledWorkerHost,
  type InstalledWorkerHostHandle,
} from "./installed-worker-host.js";
import {
  MAX_SEMANTIC_JSON_NESTING_DEPTH,
  PROTOCOL_WIRE_PARSE_DEPTH,
  type InstallWorkerStartPremiseInput,
  type RuntimeAuthorityDatabase,
} from "./storage/runtime-authority-database.js";
import { canonicalJsonDigest, type JsonValue } from "../schema-bundle/index.js";

/** Spawn-argument ceiling shared with the Rust MAX_SPAWN_ARGS. */
const MAX_SPAWN_ARGS = 64;
/** Dispatch member ceiling shared with the Rust coordinator default. */
const MAX_DISPATCH_MEMBERS = 4096;

export interface HostWorkerHostLaunchOptions {
  /** Already-open Host-owned authority repository (controller lock held). */
  readonly database: RuntimeAuthorityDatabase;
  readonly extensionAlias: string;
  readonly serverId: string;
  /** Absolute installed package root containing `installedPackagePath`. */
  readonly installedPackageRoot: string;
  /** Absolute installed package archive path inside `installedPackageRoot`. */
  readonly installedPackagePath: string;
}

function objectField(value: JsonValue, name: string, label: string): Record<string, JsonValue> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, JsonValue>;
  }
  throw new InstalledWorkerHostError(
    "WORKER_START_INVALID",
    `${label} is not an object`,
  );
}

function requireField(
  object: Record<string, JsonValue>,
  name: string,
  label: string,
): JsonValue {
  if (!(name in object)) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      `${label} is missing ${name}`,
    );
  }
  return object[name];
}

function requireString(
  object: Record<string, JsonValue>,
  name: string,
  label: string,
): string {
  const value = requireField(object, name, label);
  if (typeof value !== "string") {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      `${label} field ${name} is not a string`,
    );
  }
  return value;
}

function requireSafeInteger(
  object: Record<string, JsonValue>,
  name: string,
  label: string,
): number {
  const value = requireField(object, name, label);
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      `${label} field ${name} is not a positive safe integer`,
    );
  }
  return value;
}

/** True for one relative path member without `\`, `.`, or `..` parts. */
function safeRelativeMember(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function readSpawnArgs(
  transport: Record<string, JsonValue>,
): readonly string[] {
  const args = requireField(transport, "args", "stdio transport");
  if (!Array.isArray(args)) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "stdio transport args is not an array",
    );
  }
  if (args.length === 0 || args.length > MAX_SPAWN_ARGS) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      `stdio transport args must have 1..=${MAX_SPAWN_ARGS} members`,
    );
  }
  return args.map((argument, index) => {
    if (typeof argument !== "string") {
      throw new InstalledWorkerHostError(
        "WORKER_START_INVALID",
        `stdio argument ${index} is not a string`,
      );
    }
    return argument;
  });
}

/**
 * Closed local admission of one tool-broker server entry, mirroring the Rust
 * durable-server loader: only an enabled MCP 2025-06-18 stdio server with an
 * empty secret binding set may be launched through the worker-host route.
 */
function admittedServerContract(
  canonicalConfig: JsonValue,
  serverId: string,
): { server: Record<string, JsonValue>; transport: Record<string, JsonValue> } {
  const root = objectField(canonicalConfig, "resolved configuration", "resolved configuration");
	const runtimeConfig = objectField(
		requireField(root, "runtime_config", "resolved configuration"),
		"runtime_config",
		"resolved configuration",
	);
  const spec = objectField(
    requireField(runtimeConfig, "spec", "runtime config"),
    "spec",
    "runtime config",
  );
  const services = objectField(
    requireField(spec, "services", "runtime config spec"),
    "services",
    "runtime config spec",
  );
  const toolBroker = objectField(
    requireField(services, "tool_broker", "runtime services"),
    "tool_broker",
    "runtime services",
  );
  const servers = objectField(
    requireField(toolBroker, "servers", "tool-broker config"),
    "servers",
    "tool-broker config",
  );
  const server = objectField(
    requireField(servers, serverId, "configured server"),
    serverId,
    "configured server",
  );
  if (server["enabled"] !== true) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      `configured MCP server ${serverId} is not enabled`,
    );
  }
  if (server["adapter"] !== "mcp" || server["protocol_version"] !== "2025-06-18") {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "Host accepts only enabled MCP 2025-06-18 servers",
    );
  }
  const transport = objectField(
    requireField(server, "transport", "configured server"),
    "transport",
    "configured server",
  );
  if (requireString(transport, "kind", "stdio transport") !== "stdio") {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "configured transport is not stdio",
    );
  }
  if (!safeRelativeMember(requireString(transport, "executable", "stdio transport"))) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "configured stdio executable is not a safe relative package member",
    );
  }
  const secretBindings = transport["secret_bindings"];
	if (secretBindings !== undefined) {
		if (
			typeof secretBindings === "object" &&
			!Array.isArray(secretBindings) &&
			Object.keys(secretBindings as Record<string, unknown>).length > 0
		) {
			throw new InstalledWorkerHostError(
				"WORKER_START_INVALID",
				"stdio secret bindings require an explicit Host secret provider",
			);
		}
		if (typeof secretBindings !== "object" || Array.isArray(secretBindings)) {
			throw new InstalledWorkerHostError(
				"WORKER_START_INVALID",
				"stdio secret bindings require an explicit Host secret provider",
			);
		}
	}
  return { server, transport };
}

/**
 * Derive the closed Worker-start premise input for one admitted identity pair
 * from the current authority snapshot and the Host-owned installed-package
 * facts. The caller still projects it through the repository (and the
 * repository still seals and pins it to the current revision).
 */
export function deriveWorkerStartPremise(
  options: HostWorkerHostLaunchOptions,
): InstallWorkerStartPremiseInput {
  const { database, extensionAlias, serverId } = options;
  const snapshot = database.readCurrentConfig();
  if (snapshot === null) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "no committed current configuration",
    );
  }
  const { server, transport } = admittedServerContract(snapshot.canonicalConfig, serverId);
  const limits = objectField(
    requireField(server, "limits", "configured server"),
    "limits",
    "configured server",
  );
  const maxRequestBytes = requireSafeInteger(limits, "max_request_bytes", "server limits");
  const maxResponseBytes = requireSafeInteger(limits, "max_response_bytes", "server limits");
  return {
    extensionAlias,
    serverId,
    packageRoot: options.installedPackageRoot,
    packagePath: options.installedPackagePath,
    packageDigest: requireString(transport, "package_digest", "stdio transport"),
    executableDigest: requireString(transport, "executable_digest", "stdio transport"),
    endpoint: requireString(transport, "executable", "stdio transport"),
    spawnArgs: readSpawnArgs(transport),
    startupTimeoutMs: requireSafeInteger(limits, "startup_timeout_ms", "server limits"),
    maxFrameBytes: Math.max(maxRequestBytes, maxResponseBytes),
    maxResponseBytes,
    wireDepth: PROTOCOL_WIRE_PARSE_DEPTH,
    semanticDepth: MAX_SEMANTIC_JSON_NESTING_DEPTH,
    maxDispatchMembers: MAX_DISPATCH_MEMBERS,
    maxDispatchDepth: MAX_SEMANTIC_JSON_NESTING_DEPTH,
    transportDigest: canonicalJsonDigest(transport),
  };
}

/**
 * Launch the installed worker-host for one admitted identity pair through the
 * Host-owned composition: derive the sealed premise from the current
 * authority snapshot and installed-package facts, project it, and launch.
 */
export async function launchHostWorkerHost(
  options: HostWorkerHostLaunchOptions,
): Promise<InstalledWorkerHostHandle> {
  const premise = deriveWorkerStartPremise(options);
  options.database.installWorkerStartPremise(premise);
  return launchInstalledWorkerHost({ database: options.database, premise });
}
