/**
 * Config admission for the Tool Broker slice.
 *
 * `parseToolBrokerConfig` is the first fail-closed layer: it rejects any
 * document that is not exactly the frozen `dolly.tool-broker-config/v1`
 * shape (`tool-broker-config.schema.json` + `common.schema.json`), including
 * any legacy camelCase field, raw `command`/`env`/path, missing allowed
 * modules, missing full limits, or missing required Tool fields, before any
 * child is spawned. Unknown fields are rejected so a stale or typo'd config
 * cannot silently widen behaviour. Server discovery can verify each closed
 * tool map, never widen it.
 *
 * Scope: this slice binds the full exact `Tool` entry as the schema requires
 * (validation and both recomputed digests). Streamable HTTP is out of scope
 * and rejected here; package resolution, the ledger, `host.tool.invoke`, and
 * Module activation are later gates that live outside this module. `enabled`
 * is admitted (config) but enablement is evaluated by a later gate.
 */

import { canonicalJsonDigest, assertJsonValue, type JsonValue } from "../canonical-json.js";
import {
  ToolBrokerConfigError,
  TOOL_BROKER_CONFIG_SCHEMA,
  MCP_PROTOCOL_VERSION,
  STABLE_ID_PATTERN,
  EXTENSION_ID_PATTERN,
  UPSTREAM_NAME_PATTERN,
  SHA256_PATTERN,
  SEMVER_VERSION_PATTERN,
  EXECUTABLE_PATH_PATTERN,
  ENV_NAME_PATTERN,
  SECRET_REF_PATTERN,
  ARGUMENT_POINTER_PATTERN,
  type ConfiguredTool,
  type StdioTransportConfig,
  type ToolBrokerConfigDocument,
  type ToolBrokerLimits,
  type ToolBrokerServerConfig,
  type ToolIdempotencyPolicy,
  type ToolSideEffectClass,
} from "./types.js";

/** Upper bounds mirrored from the frozen schema. */
const MAX_SERVERS = 1024;
const MAX_CONFIGURED_TOOLS = 4096;
const MAX_ALLOWED_MODULES = 4096;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4096;
const MAX_SECRET_BINDINGS = 32;
const MAX_DESCRIPTION_LENGTH = 4096;
const STABLE_ID_MAX_LENGTH = 63;
const EXECUTABLE_MAX_LENGTH = 255;
const EXTENSION_ID_MIN_LENGTH = 5;
const EXTENSION_ID_MAX_LENGTH = 255;
const SECRET_REF_MIN_LENGTH = 12;
const SECRET_REF_MAX_LENGTH = 255;
const POINTER_MAX_LENGTH = 512;

const LIMIT_RANGES: Record<keyof ToolBrokerLimits, readonly [number, number]> = {
  startup_timeout_ms: [100, 300000],
  request_timeout_ms: [100, 3600000],
  max_concurrency: [1, 1024],
  max_request_bytes: [1024, 67108864],
  max_response_bytes: [1024, 67108864],
};

const ALLOWED_SERVER_KEYS = ["enabled", "adapter", "protocol_version", "transport", "allowed_modules", "limits", "tools"] as const;
const ALLOWED_TRANSPORT_KEYS = ["kind", "package_id", "package_version", "package_digest", "executable", "executable_digest", "args", "secret_bindings"] as const;
const ALLOWED_TOOL_KEYS = ["upstream_name", "description", "input_schema", "input_schema_digest", "output_schema", "output_schema_digest", "side_effect_class", "idempotency", "requires_confirmation", "enabled"] as const;
const SIDE_EFFECT_CLASSES = ["read_only", "idempotent_write", "non_idempotent_write", "unknown"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reject(message: string): never {
  throw new ToolBrokerConfigError("TOOL_BROKER_CONFIG_INVALID", message);
}

/** True for a value matching the frozen StableId pattern and length cap
 * (server IDs, tool aliases, allowed Module IDs). */
function isStableId(value: string): boolean {
  return value.length > 0 && value.length <= STABLE_ID_MAX_LENGTH && STABLE_ID_PATTERN.test(value);
}

/**
 * Identity stores for objects minted by `parseToolBrokerConfig`. The factory
 * requires the exact minted server config object (not a spread copy), so a
 * caller-typed value can never bypass admission and reach spawn.
 */
const MINTED_SERVER_CONFIGS = new WeakSet<object>();

/**
 * True only for a server config object returned inside a document produced by
 * `parseToolBrokerConfig` (the exact object, not a spread copy).
 */
export function isParsedToolBrokerServerConfig(value: unknown): value is ToolBrokerServerConfig {
  return typeof value === "object" && value !== null && MINTED_SERVER_CONFIGS.has(value);
}

/**
 * Requires the exact minted server config object. Used by the factory before
 * any spawn, so a caller-constructed or copied config cannot reach spawn.
 */
export function assertParsedToolBrokerServerConfig(config: ToolBrokerServerConfig): void {
  if (!isParsedToolBrokerServerConfig(config)) {
    reject("config was not produced by parseToolBrokerConfig; refusing to spawn");
  }
}

interface ToolBrokerDocumentHostContext {
  /** Immutable configuration revision the document belongs to (Host-registry
   * metadata, spec section 7, not part of the frozen schema). Bound at
   * admission so every minted server config pins its catalog to it. */
  readonly configRevision: string;
}

/**
 * Validates and returns a frozen, branded, closed `dolly.tool-broker-config/v1`
 * document. Throws `ToolBrokerConfigError` (code `TOOL_BROKER_CONFIG_INVALID`)
 * for any unknown field, wrong schema tag, wrong adapter, wrong protocol
 * version, non-stdio transport, missing or malformed limits, missing allowed
 * modules, missing required Tool fields, lax digests, or digest/schema
 * mismatch. Runs before any spawn/fs/network/backend call; the caller never
 * reaches the factory with an unbranded server config.
 */
export function parseToolBrokerConfig(input: unknown, host: ToolBrokerDocumentHostContext): ToolBrokerConfigDocument {
  if (!isPlainObject(input)) {
    reject("config must be an object");
  }
  if (typeof host.configRevision !== "string" || !isStableId(host.configRevision)) {
    reject("host.configRevision must be a stable identifier matching /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/ (max 63 chars)");
  }

  for (const key of Object.keys(input)) {
    if (key !== "schema" && key !== "servers") {
      reject(`unknown config field "${key}"`);
    }
  }

  if (input.schema !== TOOL_BROKER_CONFIG_SCHEMA) {
    reject(`schema must be exactly ${JSON.stringify(TOOL_BROKER_CONFIG_SCHEMA)} (got ${JSON.stringify(input.schema)})`);
  }

  const serversInput = input.servers;
  if (!isPlainObject(serversInput)) {
    reject("servers must be an object");
  }
  const serverIds = Object.keys(serversInput);
  if (serverIds.length > MAX_SERVERS) {
    reject(`servers must have at most ${MAX_SERVERS} entries`);
  }

  const servers: Record<string, ToolBrokerServerConfig> = {};
  for (const serverId of serverIds) {
    if (!isStableId(serverId)) {
      reject(`servers key "${serverId}" must be a stable identifier matching /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/ (max 63 chars)`);
    }
    servers[serverId] = parseServer(serverId, serversInput[serverId], host.configRevision);
  }

  return Object.freeze({
    schema: TOOL_BROKER_CONFIG_SCHEMA,
    servers: Object.freeze(servers),
  });
}

function parseServer(serverId: string, input: unknown, configRevision: string): ToolBrokerServerConfig {
  if (!isPlainObject(input)) {
    reject(`servers["${serverId}"] must be an object`);
  }
  for (const key of Object.keys(input)) {
    if (!(ALLOWED_SERVER_KEYS as readonly string[]).includes(key)) {
      reject(`servers["${serverId}"] unknown field "${key}"`);
    }
  }

  const { enabled, adapter, protocol_version, transport, allowed_modules, limits, tools } = input as Record<string, unknown>;

  if (typeof enabled !== "boolean") {
    reject(`servers["${serverId}"].enabled must be a boolean`);
  }

  if (adapter !== "mcp") {
    reject(`servers["${serverId}"].adapter must be "mcp" (got ${JSON.stringify(adapter)})`);
  }

  if (protocol_version !== MCP_PROTOCOL_VERSION) {
    reject(`servers["${serverId}"].protocol_version must be exactly "${MCP_PROTOCOL_VERSION}" (got ${JSON.stringify(protocol_version)})`);
  }

  const parsedTransport = parseStdioTransport(serverId, transport);
  const parsedModules = parseAllowedModules(serverId, allowed_modules);
  const parsedLimits = parseLimits(serverId, limits);
  const parsedTools = parseTools(serverId, tools);

  const config: ToolBrokerServerConfig = Object.freeze({
    serverId,
    enabled,
    adapter: "mcp",
    protocol_version: MCP_PROTOCOL_VERSION,
    transport: parsedTransport,
    allowed_modules: parsedModules,
    limits: parsedLimits,
    configRevision,
    tools: parsedTools,
  });
  MINTED_SERVER_CONFIGS.add(config);
  return config;
}

function parseStdioTransport(serverId: string, input: unknown): StdioTransportConfig {
  if (!isPlainObject(input)) {
    reject(`servers["${serverId}"].transport must be an object`);
  }
  for (const key of Object.keys(input)) {
    if (!(ALLOWED_TRANSPORT_KEYS as readonly string[]).includes(key)) {
      reject(`servers["${serverId}"].transport unknown field "${key}"`);
    }
  }
  if (input.kind !== "stdio") {
    reject(`servers["${serverId}"].transport.kind must be "stdio" in this slice (got ${JSON.stringify(input.kind)})`);
  }

  const transportInput = input as Record<string, unknown>;
  const { package_id, package_version, package_digest, executable, executable_digest, args, secret_bindings } = transportInput;

  let parsedPackageId: string;
  if (typeof package_id !== "string" || package_id.length < EXTENSION_ID_MIN_LENGTH || package_id.length > EXTENSION_ID_MAX_LENGTH || !EXTENSION_ID_PATTERN.test(package_id)) {
    reject(`servers["${serverId}"].transport.package_id must match the ExtensionId pattern`);
  } else {
    parsedPackageId = package_id;
  }
  let parsedPackageVersion: string;
  if (typeof package_version !== "string" || !SEMVER_VERSION_PATTERN.test(package_version)) {
    reject(`servers["${serverId}"].transport.package_version must match the semver pattern`);
  } else {
    parsedPackageVersion = package_version;
  }
  const parsedPackageDigest = requireSha256Value(serverId, ".transport.package_digest", package_digest);
  if (typeof executable !== "string" || executable.length === 0 || executable.length > EXECUTABLE_MAX_LENGTH || !EXECUTABLE_PATH_PATTERN.test(executable)) {
    reject(`servers["${serverId}"].transport.executable must be a relative member path matching the StdioTransport pattern`);
  }
  const parsedExecutableDigest = requireSha256Value(serverId, ".transport.executable_digest", executable_digest);
  if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((a) => typeof a !== "string" || a.length > MAX_ARG_LENGTH)) {
    reject(`servers["${serverId}"].transport.args must be an array of at most ${MAX_ARGS} strings (each at most ${MAX_ARG_LENGTH} chars)`);
  }
  if (!isPlainObject(secret_bindings)) {
    reject(`servers["${serverId}"].transport.secret_bindings must be an object`);
  }
  const bindingNames = Object.keys(secret_bindings);
  if (bindingNames.length > MAX_SECRET_BINDINGS) {
    reject(`servers["${serverId}"].transport.secret_bindings must have at most ${MAX_SECRET_BINDINGS} entries`);
  }
  const secretBindings: Record<string, string> = {};
  for (const name of bindingNames) {
    const ref = secret_bindings[name];
    if (!ENV_NAME_PATTERN.test(name)) {
      reject(`servers["${serverId}"].transport.secret_bindings key "${name}" must match /^[A-Z][A-Z0-9_]{0,63}$/`);
    }
    if (typeof ref !== "string" || ref.length < SECRET_REF_MIN_LENGTH || ref.length > SECRET_REF_MAX_LENGTH || !SECRET_REF_PATTERN.test(ref)) {
      reject(`servers["${serverId}"].transport.secret_bindings["${name}"] must be a secret reference matching /^secret:\\/\\/[a-z][a-z0-9-]{0,62}\\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/`);
    }
    secretBindings[name] = ref;
  }

  return Object.freeze({
    kind: "stdio",
    package_id: parsedPackageId,
    package_version: parsedPackageVersion,
    package_digest: parsedPackageDigest,
    executable,
    executable_digest: parsedExecutableDigest,
    args: Object.freeze([...(args as string[])]),
    secret_bindings: Object.freeze(secretBindings),
  });
}

function parseAllowedModules(serverId: string, input: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    reject(`servers["${serverId}"].allowed_modules must be an array`);
  }
  if (input.length > MAX_ALLOWED_MODULES) {
    reject(`servers["${serverId}"].allowed_modules must have at most ${MAX_ALLOWED_MODULES} entries`);
  }
  const seen = new Set<string>();
  for (const moduleId of input) {
    if (typeof moduleId !== "string" || !isStableId(moduleId)) {
      reject(`servers["${serverId}"].allowed_modules entries must be stable identifiers matching /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/ (max 63 chars)`);
    }
    if (seen.has(moduleId)) {
      reject(`servers["${serverId}"].allowed_modules contains duplicate module "${moduleId}"`);
    }
    seen.add(moduleId);
  }
  return Object.freeze([...input]);
}

function parseLimits(serverId: string, input: unknown): ToolBrokerLimits {
  if (!isPlainObject(input)) {
    reject(`servers["${serverId}"].limits must be an object`);
  }
  for (const key of Object.keys(input)) {
    if (!(Object.keys(LIMIT_RANGES) as readonly string[]).includes(key)) {
      reject(`servers["${serverId}"].limits unknown field "${key}"`);
    }
  }
  const values = input as Record<string, unknown>;
  const limits = {} as Record<string, number>;
  for (const [field, [min, max]] of Object.entries(LIMIT_RANGES)) {
    const value = values[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      reject(`servers["${serverId}"].limits.${field}: value must be an integer in [${min}, ${max}]`);
    }
    limits[field] = value;
  }
  return {
    startup_timeout_ms: limits.startup_timeout_ms,
    request_timeout_ms: limits.request_timeout_ms,
    max_concurrency: limits.max_concurrency,
    max_request_bytes: limits.max_request_bytes,
    max_response_bytes: limits.max_response_bytes,
  };
}

function parseTools(serverId: string, input: unknown): Readonly<Record<string, ConfiguredTool>> {
  if (!isPlainObject(input)) {
    reject(`servers["${serverId}"].tools must be a map of aliases to configured tool bindings`);
  }
  const aliases = Object.keys(input);
  if (aliases.length > MAX_CONFIGURED_TOOLS) {
    reject(`servers["${serverId}"].tools must have at most ${MAX_CONFIGURED_TOOLS} entries`);
  }
  const tools: Record<string, ConfiguredTool> = {};
  const upstreamNames = new Set<string>();
  for (const alias of aliases) {
    if (!isStableId(alias)) {
      reject(`servers["${serverId}"].tools key "${alias}" must be a stable identifier matching /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/ (max 63 chars)`);
    }
    tools[alias] = parseTool(serverId, alias, input[alias], upstreamNames);
  }
  return Object.freeze(tools);
}

function parseTool(serverId: string, alias: string, input: unknown, upstreamNames: Set<string>): ConfiguredTool {
  if (!isPlainObject(input)) {
    reject(`servers["${serverId}"].tools["${alias}"] must be an object`);
  }
  for (const key of Object.keys(input)) {
    if (!(ALLOWED_TOOL_KEYS as readonly string[]).includes(key)) {
      reject(`servers["${serverId}"].tools["${alias}"] unknown field "${key}"`);
    }
  }

  const { upstream_name, description, input_schema, input_schema_digest, output_schema, output_schema_digest, side_effect_class, idempotency, requires_confirmation, enabled } = input as Record<string, unknown>;

  if (typeof upstream_name !== "string" || !UPSTREAM_NAME_PATTERN.test(upstream_name)) {
    reject(`servers["${serverId}"].tools["${alias}"].upstream_name must match /^[ -~]{1,255}$/`);
  }
  if (upstreamNames.has(upstream_name)) {
    reject(`servers["${serverId}"].tools["${alias}"] reuses upstream_name "${upstream_name}" which is already bound`);
  }
  upstreamNames.add(upstream_name);
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
    reject(`servers["${serverId}"].tools["${alias}"].description must be a string of at most ${MAX_DESCRIPTION_LENGTH} chars`);
  }
  const inputSchemaDocument = assertSchemaDocument(serverId, alias, "input_schema", input_schema, "object");
  const parsedInputSchemaDigest = requireSha256Value(serverId, `.tools["${alias}"].input_schema_digest`, input_schema_digest);
  const outputSchemaDocument = assertSchemaDocument(serverId, alias, "output_schema", output_schema, "object-or-boolean");
  const parsedOutputSchemaDigest = requireSha256Value(serverId, `.tools["${alias}"].output_schema_digest`, output_schema_digest);
  if (canonicalJsonDigest(inputSchemaDocument) !== parsedInputSchemaDigest) {
    reject(`servers["${serverId}"].tools["${alias}"].input_schema_digest does not match the recomputed digest of its input_schema`);
  }
  if (canonicalJsonDigest(outputSchemaDocument) !== parsedOutputSchemaDigest) {
    reject(`servers["${serverId}"].tools["${alias}"].output_schema_digest does not match the recomputed digest of its output_schema`);
  }
  const sideEffectClass = assertSideEffectClass(serverId, alias, side_effect_class);
  const parsedIdempotency = parseIdempotency(serverId, alias, sideEffectClass, idempotency);
  if (typeof requires_confirmation !== "boolean") {
    reject(`servers["${serverId}"].tools["${alias}"].requires_confirmation must be a boolean`);
  }
  if (typeof enabled !== "boolean") {
    reject(`servers["${serverId}"].tools["${alias}"].enabled must be a boolean`);
  }

  return Object.freeze({
    upstream_name,
    description,
    input_schema: inputSchemaDocument,
    input_schema_digest: parsedInputSchemaDigest,
    output_schema: outputSchemaDocument,
    output_schema_digest: parsedOutputSchemaDigest,
    side_effect_class: sideEffectClass,
    idempotency: parsedIdempotency,
    requires_confirmation,
    enabled,
  });
}

function assertSideEffectClass(serverId: string, alias: string, value: unknown): ToolSideEffectClass {
  if (typeof value !== "string" || !(SIDE_EFFECT_CLASSES as readonly string[]).includes(value)) {
    reject(`servers["${serverId}"].tools["${alias}"].side_effect_class must be one of ${SIDE_EFFECT_CLASSES.join(", ")}`);
  }
  return value as ToolSideEffectClass;
}

function parseIdempotency(serverId: string, alias: string, sideEffectClass: ToolSideEffectClass, input: unknown): ToolIdempotencyPolicy {
  if (!isPlainObject(input)) {
    reject(`servers["${serverId}"].tools["${alias}"].idempotency must be an object`);
  }
  if (sideEffectClass === "idempotent_write") {
    if (Object.keys(input).some((key) => key !== "kind" && key !== "argument_pointer")) {
      reject(`servers["${serverId}"].tools["${alias}"].idempotency unknown field (idempotent_write policies must have exactly "kind" and "argument_pointer")`);
    }
    const kind = input.kind;
    if (kind !== "argument_key") {
      reject(`servers["${serverId}"].tools["${alias}"].idempotency.kind must be "argument_key" for an idempotent_write tool`);
    }
    const argumentPointer = input.argument_pointer;
    if (typeof argumentPointer !== "string" || argumentPointer.length === 0 || argumentPointer.length > POINTER_MAX_LENGTH || !ARGUMENT_POINTER_PATTERN.test(argumentPointer)) {
      reject(`servers["${serverId}"].tools["${alias}"].idempotency.argument_pointer must match the RFC 6901 pointer pattern`);
    }
    return Object.freeze({ kind: "argument_key", argument_pointer: argumentPointer });
  }
  if (Object.keys(input).some((key) => key !== "kind")) {
    reject(`servers["${serverId}"].tools["${alias}"].idempotency unknown field (${sideEffectClass} policies must have exactly "kind")`);
  }
  if (input.kind !== "none") {
    reject(`servers["${serverId}"].tools["${alias}"].idempotency.kind must be "none" for a ${sideEffectClass} tool`);
  }
  return Object.freeze({ kind: "none" });
}

/**
 * Validates an embedded schema document: `input_schema` must be an
 * object-form schema with root `"type":"object"`; `output_schema` must be an
 * object-form schema or a boolean schema. Both are full JSON values.
 */
function assertSchemaDocument(serverId: string, alias: string, field: string, value: unknown, kind: "object" | "object-or-boolean"): JsonValue {
  try {
    assertJsonValue(value);
  } catch {
    reject(`servers["${serverId}"].tools["${alias}"].${field} must be a JSON value`);
  }
  const document = value as JsonValue;
  if (kind === "object") {
    if (!isPlainObject(document) || document.type !== "object") {
      reject(`servers["${serverId}"].tools["${alias}"].${field} must be an object-form schema with root type "object"`);
    }
    return document;
  }
  if (document === true || document === false || (isPlainObject(document) && document.type === "object")) {
    return document;
  }
  reject(`servers["${serverId}"].tools["${alias}"].${field} must be an object-form or boolean schema`);
  return document;
}

function requireSha256Value(serverId: string, fieldPath: string, value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    reject(`servers["${serverId}"]${fieldPath} must match /^sha256:[0-9a-f]{64}$/`);
  }
  return value;
}
