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
  type InstalledWorkerHostSpawnOptions,
} from "./installed-worker-host.js";
import {
  MAX_SEMANTIC_JSON_NESTING_DEPTH,
  PROTOCOL_WIRE_PARSE_DEPTH,
  RuntimeAuthorityDatabase,
  type CurrentAuthoritySnapshot,
  type InstallWorkerStartPremiseInput,
  type RuntimeAuthorityIdentity,
} from "./storage/runtime-authority-database.js";
import { canonicalJsonDigest, type JsonValue } from "../schema-bundle/index.js";
import {
  ExtensionInstallationRegistry,
  type ResolvedExtensionInstallation,
} from "../core/extension-installation-registry.js";
import { InstanceControllerLock } from "../core/instance-controller-lock.js";
import { InstalledComponentOriginRegistry } from "../core/installed-component-origin.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { StartupAuthorityPermissionContext } from "../core/startup-authority-premise.js";

/** Spawn-argument ceiling shared with the Rust MAX_SPAWN_ARGS. */
const MAX_SPAWN_ARGS = 64;
/** Dispatch member ceiling shared with the Rust coordinator default. */
const MAX_DISPATCH_MEMBERS = 4096;

export interface HostWorkerHostLaunchOptions {
  /** Already-open Host-owned authority repository (controller lock held). */
  readonly database: RuntimeAuthorityDatabase;
  readonly extensionAlias: string;
  readonly serverId: string;
  /** Absolute installed package root. */
  readonly installedPackageRoot: string;
  /** Frozen installed product component origin identity of the package. */
  readonly originComponentId: string;
  /** Frozen installed product component origin revision of the package. */
  readonly originComponentRevision: number;
  /** Frozen installed product component origin digest of the package. */
  readonly originComponentDigest: string;
  /** Process-boundary injection (deterministic tests only), forwarded to the adapter. */
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: InstalledWorkerHostSpawnOptions,
  ) => ChildProcess;
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
  // The sealed premise extension alias IS the authoritative stdio transport
  // package identifier: no caller, daemon-document alias, readiness result,
  // or root config extension may name a different identity.
  if (extensionAlias !== requireString(transport, "package_id", "stdio transport")) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "sealed worker extension alias must equal the stdio transport package_id",
    );
  }
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
    originComponentId: options.originComponentId,
		originComponentRevision: options.originComponentRevision,
		originComponentDigest: options.originComponentDigest,
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
  try {
    return await launchInstalledWorkerHost({
      database: options.database,
      premise,
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    });
  } catch (error) {
    if (
      error instanceof InstalledWorkerHostError &&
      error.code === "WORKER_START_REFUSED"
    ) {
      throw new InstalledWorkerHostError(
        error.code,
        `WORKER_START_REFUSED: ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Production per-instance owner of the installed tool-broker worker hosts.
 *
 * The Runtime Worker already holds the live `{database, controller,
 * origins}` authority context and the Host-owned `ExtensionInstallationRegistry`
 * of immutable package bytes. This owner preflights EVERY admitted identity
 * pair read-only against that context — absent or mismatched current config,
 * unknown/disabled server, and absent or mismatched installation all refuse
 * before any compose spawn or durable premise projection — then launches
 * each server through `launchHostWorkerHost`, retaining the returned handles
 * so shutdown can stop and reap every Tool Broker descendant before storage
 * close and lock release.
 */
export interface HostWorkerHostOwnerOptions
  extends StartupAuthorityPermissionContext {
  /** Host-owned register of immutable installed package bytes. */
  readonly installations: ExtensionInstallationRegistry;
  /** Configured tool-broker server identifiers to launch, unique and non-empty. */
  readonly serverIds: readonly string[];
  /** Process-boundary injection (deterministic tests only). */
  readonly spawn?: HostWorkerHostLaunchOptions["spawn"];
}

export interface HostWorkerHostOwner {
  readonly serverIds: readonly string[];
  readonly handles: readonly { readonly serverId: string; readonly pid: number }[];
  /** Idempotent stop: stops and reaps every retained worker host. */
  stop(): Promise<void>;
}

function assertHostWorkerHostOwnerOptions(
  value: unknown,
): asserts value is HostWorkerHostOwnerOptions {
  const candidate = value as Record<string, unknown> | null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !(candidate.database instanceof RuntimeAuthorityDatabase) ||
    !(candidate.controller instanceof InstanceControllerLock) ||
    !(candidate.origins instanceof InstalledComponentOriginRegistry) ||
    !(candidate.installations instanceof ExtensionInstallationRegistry)
  ) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "worker-host owner requires the live Host authority context and installation register",
    );
  }
  const options = value as HostWorkerHostOwnerOptions;
  if (
    !Array.isArray(options.serverIds) ||
    options.serverIds.length === 0 ||
    options.serverIds.some(
      (serverId) => typeof serverId !== "string" || serverId.length === 0,
    ) ||
    new Set(options.serverIds).size !== options.serverIds.length
  ) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "worker-host owner requires a non-empty extension alias and unique server identifiers",
    );
  }
}

/**
 * Resolves one admitted tool-broker identity pair to the Host-owned managed
 * package bytes. Refuses before any compose spawn or durable projection when
 * the current config, the server contract, or the installation is absent or
 * mismatched.
 */
function admittedInstallation(
  snapshot: CurrentAuthoritySnapshot,
  installations: ExtensionInstallationRegistry,
  serverId: string,
): { installedPackageRoot: string; packageDigest: string } {
  const { transport } = admittedServerContract(snapshot.canonicalConfig, serverId);
  const packageId = requireString(transport, "package_id", "stdio transport");
  const packageVersion = requireString(transport, "package_version", "stdio transport");
  let installed: ResolvedExtensionInstallation;
  try {
    installed = installations.resolve({ extensionId: packageId, packageVersion });
  } catch (error) {
    if (error instanceof InstalledWorkerHostError) throw error;
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      `configured tool-broker server ${serverId} has no Host-owned installation for ${packageId}@${packageVersion}`,
    );
  }
  if (installed.packageDigest !== requireString(transport, "package_digest", "stdio transport")) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      `configured tool-broker server ${serverId} package digest does not match the Host-owned installation`,
    );
  }
  return {
    installedPackageRoot: installed.workingDirectory,
    packageDigest: installed.packageDigest,
  };
}

/**
 * Start and own every configured tool-broker worker host for one instance.
 *
 * All admission preflights complete read-only before the first projection or
 * spawn, so a refused pair leaves the repository at its prior revision with
 * zero durable effects. A mid-composition launch failure rolls back by
 * stopping and reaping every handle already retained, then rethrows.
 */
export async function startHostWorkerHost(
  options: HostWorkerHostOwnerOptions,
): Promise<HostWorkerHostOwner> {
  assertHostWorkerHostOwnerOptions(options);
  const { database, installations, serverIds, spawn } = options;
  const origins: InstalledComponentOriginRegistry = options.origins;
  const snapshot = database.readCurrentConfig();
  if (snapshot === null) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "no committed current configuration",
    );
  }
  const launches = serverIds.map((serverId) => {
    const installed = admittedInstallation(snapshot, installations, serverId);
    const { transport } = admittedServerContract(snapshot.canonicalConfig, serverId);
    // Each committed server names exactly its authoritative immutable package
    // through `transport.package_id`; only that identity may name the
    // server's durable premise alias, and the immutable origin is resolved
    // and revalidated through the Host origin registry first.
    const packageId = requireString(transport, "package_id", "stdio transport");
    const packageOrigin = origins.resolve({
      extensionId: packageId,
      packageVersion: requireString(transport, "package_version", "stdio transport"),
    });
    origins.assertCurrent(packageOrigin);
    const premise = deriveWorkerStartPremise({
      database,
      extensionAlias: packageId,
      serverId,
      installedPackageRoot: installed.installedPackageRoot,
      originComponentId: packageOrigin.component_id,
      originComponentRevision: packageOrigin.component_revision,
      originComponentDigest: packageOrigin.component_digest,
    });
    if (premise.packageDigest !== installed.packageDigest) {
      throw new InstalledWorkerHostError(
        "WORKER_START_INVALID",
        `configured tool-broker server ${serverId} premise package digest does not match the Host-owned installation`,
      );
    }
    return {
      serverId,
      extensionAlias: packageId,
      installedPackageRoot: installed.installedPackageRoot,
      originComponentId: packageOrigin.component_id,
      originComponentRevision: packageOrigin.component_revision,
      originComponentDigest: packageOrigin.component_digest,
    };
  });
  const retained: Array<{ serverId: string; handle: InstalledWorkerHostHandle }> = [];
  try {
    for (const launch of launches) {
      const handle = await launchHostWorkerHost({
        database,
        extensionAlias: launch.extensionAlias,
        serverId: launch.serverId,
        installedPackageRoot: launch.installedPackageRoot,
        originComponentId: launch.originComponentId,
        originComponentRevision: launch.originComponentRevision,
        originComponentDigest: launch.originComponentDigest,
        ...(spawn === undefined ? {} : { spawn }),
      });
      retained.push({ serverId: launch.serverId, handle });
    }
  } catch (error) {
    // Rollback: stop and reap every already-launched descendant before leaving.
    await Promise.all(retained.map((entry) => entry.handle.stop()));
    throw error;
  }
  let stopped = false;
  return Object.freeze({
    serverIds: Object.freeze([...serverIds]),
    handles: Object.freeze(
      retained.map((entry) =>
        Object.freeze({ serverId: entry.serverId, pid: entry.handle.pid }),
      ),
    ),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await Promise.all(retained.map((entry) => entry.handle.stop()));
      retained.length = 0;
    },
  });
}

/**
 * The per-instance Runtime Worker host lifecycle the `dolly run` entry uses.
 *
 * The per-instance Runtime Worker owns the live instance controller lock and
 * this writable Runtime authority repository; `dollyd` supervises that worker
 * process. This composition opens both under the existing instance roots,
 * derives the tool-broker server set from the ONE committed authority
 * revision, projects and launches every worker host through
 * `startHostWorkerHost`, and retains the returned owner so shutdown stops and
 * reaps every Tool Broker descendant before storage close and controller-lock
 * release.
 */
export interface RuntimeWorkerHostOpenOptions {
  readonly registryDirectory: string;
  /** The instance state root that also holds the legacy Core state. */
  readonly stateDirectory: string;
  readonly identity: RuntimeAuthorityIdentity;
  /** The live controller lock the Runtime Worker already holds for the instance. */
  readonly controllerLock: InstanceControllerLock;
  /** Process-boundary injection (deterministic tests only). */
  readonly spawn?: HostWorkerHostLaunchOptions["spawn"];
}

export interface RuntimeWorkerHost {
  readonly database: RuntimeAuthorityDatabase;
  readonly owner: HostWorkerHostOwner;
  /** Idempotent close: stops/reaps worker hosts, then closes storage, then releases the lock. */
  close(): Promise<void>;
}

/**
 * Server identifiers in the ONE committed authority revision, or refusal when
 * an engaged worker route finds no committed current configuration.
 */
function toolBrokerContract(
  snapshot: CurrentAuthoritySnapshot | null,
): { readonly serverIds: readonly string[] } | null {
  if (snapshot === null) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "no committed current configuration",
    );
  }
  const root = objectField(
    snapshot.canonicalConfig,
    "resolved configuration",
    "resolved configuration",
  );
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
  if (!("tool_broker" in services)) {
    return null;
  }
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
  return { serverIds: Object.keys(servers).sort() };
}

function assertRuntimeWorkerHostOpenOptions(
  value: unknown,
): asserts value is RuntimeWorkerHostOpenOptions {
  const candidate = value as Record<string, unknown> | null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !(candidate.controllerLock instanceof InstanceControllerLock)
  ) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "Runtime Worker host requires the live controller lock",
    );
  }
  const options = value as RuntimeWorkerHostOpenOptions;
  if (
    typeof options.registryDirectory !== "string" ||
    options.registryDirectory.length === 0 ||
    typeof options.stateDirectory !== "string" ||
    options.stateDirectory.length === 0
  ) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "Runtime Worker host requires the instance roots",
    );
  }
  if (
    typeof options.identity !== "object" ||
    options.identity === null ||
    typeof options.identity.daemonInstallationId !== "string" ||
    typeof options.identity.instanceId !== "string"
  ) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "Runtime Worker host requires the daemon and instance identity",
    );
  }
  options.identity;
  if (!(options.controllerLock.held)) {
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "Runtime Worker host controller lock is not held",
    );
  }
}

/**
 * Open the per-instance Runtime Worker host: open the writable authority
 * repository under the instance root, derive the configured tool-broker
 * server set from the committed revision, start and own every worker host,
 * and rethrow a refusal (absent or mismatched config or installation) before
 * any spawn or durable startup effect.
 */
export async function openRuntimeWorkerHost(
  options: RuntimeWorkerHostOpenOptions,
): Promise<RuntimeWorkerHost> {
  assertRuntimeWorkerHostOpenOptions(options);
  const authorityDirectory = join(options.stateDirectory, "authority");
  mkdirSync(authorityDirectory, { recursive: true });
  const database = RuntimeAuthorityDatabase.open({
    path: join(authorityDirectory, "authority.sqlite"),
    identity: options.identity,
    lock: options.controllerLock,
  });
  let owner: HostWorkerHostOwner;
  try {
    const census = toolBrokerContract(database.readCurrentConfig());
    if (census === null || census.serverIds.length === 0) {
      owner = Object.freeze({
        serverIds: Object.freeze([] as string[]),
        handles: Object.freeze([]),
        stop: async () => undefined,
      });
    } else {
      const installations = new ExtensionInstallationRegistry({
        directory: join(options.stateDirectory, "authority", "installations"),
      });
      const origins = new InstalledComponentOriginRegistry({
        directory: join(options.stateDirectory, "authority", "origins"),
        installations,
      });
      owner = await startHostWorkerHost({
        database,
        controller: options.controllerLock,
        origins,
        installations,
        serverIds: census.serverIds,
        ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      });
    }
  } catch (error) {
    database.close();
    throw error;
  }
  let closed = false;
  return Object.freeze({
    database,
    owner,
    close: async () => {
      if (closed) return;
      closed = true;
      await owner.stop();
      database.close();
      await options.controllerLock.release();
    },
  });
}
