/**
 * Config admission for the Tool Broker slice.
 *
 * `parseToolBrokerConfig` is the first fail-closed layer: it rejects any
 * config that does not name exactly protocol `2025-06-18`, adapter `mcp`, and
 * a stdio transport, or that does not carry a closed tool map with an exact
 * schema digest per binding, before any child is spawned. Unknown top-level
 * fields are rejected so a stale or typo'd config cannot silently widen
 * behaviour. Server discovery can verify this map, never widen it.
 *
 * Scope: this slice binds exactly `tools` entries with `upstreamName`,
 * `inputSchema`, `inputSchemaDigest`; the other `Tool` schema fields are later
 * gates and are rejected here so the binding stays closed.
 */

import { canonicalJsonDigest, assertJsonValue, type JsonValue } from "../canonical-json.js";
import { ToolBrokerConfigError, MCP_PROTOCOL_VERSION, STABLE_ID_PATTERN, UPSTREAM_NAME_PATTERN, SHA256_PATTERN, type ToolBrokerServerConfig, type ConfiguredTool } from "./types.js";

const SERVER_ID_PATTERN = STABLE_ID_PATTERN;

/** Known top-level keys of `ToolBrokerServerConfig`. */
const ALLOWED_KEYS = ["serverId", "adapter", "protocolVersion", "transport", "startupTimeoutMs", "requestTimeoutMs", "configRevision", "tools"] as const;
const ALLOWED_TRANSPORT_KEYS = ["kind", "command", "args", "env"] as const;
/** Known keys of one configured tool binding. */
const ALLOWED_TOOL_KEYS = ["upstreamName", "inputSchema", "inputSchemaDigest"] as const;
/** Upper bound on configured tools (matches the `maxProperties` cap in
 * `tool-broker-config.schema.json` Tools map). */
const MAX_CONFIGURED_TOOLS = 4096;

/** Default bounded wall-clock wait for a post-handshake request response. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reject(message: string): never {
  throw new ToolBrokerConfigError("TOOL_BROKER_CONFIG_INVALID", message);
}

/**
 * Validates and returns a closed `ToolBrokerServerConfig`. Throws
 * `ToolBrokerConfigError` (code `TOOL_BROKER_CONFIG_INVALID`) for any unknown
 * field, wrong adapter, wrong protocol version, non-stdio transport, or
 * malformed value.
 */
export function parseToolBrokerConfig(input: unknown): ToolBrokerServerConfig {
  if (!isPlainObject(input)) {
    reject("config must be an object");
  }

  // Reject unknown top-level fields.
  for (const key of Object.keys(input)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      reject(`unknown config field "${key}"`);
    }
  }

  const { serverId, adapter, protocolVersion, transport, startupTimeoutMs, requestTimeoutMs, configRevision, tools } = input as Record<string, unknown>;

  if (typeof serverId !== "string" || !SERVER_ID_PATTERN.test(serverId)) {
    reject("serverId must be a stable identifier matching /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/");
  }

  if (typeof configRevision !== "string" || !SERVER_ID_PATTERN.test(configRevision)) {
    reject("configRevision must be a stable identifier matching /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/");
  }

  if (adapter !== "mcp") {
    reject(`adapter must be "mcp" (got ${JSON.stringify(adapter)})`);
  }

  if (protocolVersion !== MCP_PROTOCOL_VERSION) {
    reject(`protocolVersion must be exactly "${MCP_PROTOCOL_VERSION}" (got ${JSON.stringify(protocolVersion)})`);
  }

  if (typeof startupTimeoutMs !== "number" || !Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 300000) {
    reject("startupTimeoutMs must be an integer in [100, 300000]");
  }

  // requestTimeoutMs is optional with a 10000ms default; when present it must
  // be a positive integer capped at 300000 (same admission style as
  // startupTimeoutMs). Only the resolved number is ever stored.
  if (requestTimeoutMs !== undefined) {
    if (typeof requestTimeoutMs !== "number" || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 300000) {
      reject("requestTimeoutMs must be an integer in [1, 300000]");
    }
  }

  // Transport: must be stdio in this slice.
  if (!isPlainObject(transport)) {
    reject("transport must be an object");
  }
  for (const key of Object.keys(transport)) {
    if (!(ALLOWED_TRANSPORT_KEYS as readonly string[]).includes(key)) {
      reject(`unknown transport field "${key}"`);
    }
  }

  if (transport.kind !== "stdio") {
    reject(`transport.kind must be "stdio" in this slice (got ${JSON.stringify(transport.kind)})`);
  }

  if (typeof transport.command !== "string" || transport.command.length === 0 || transport.command.length > 4096) {
    reject("transport.command must be a non-empty string");
  }

  if (!Array.isArray(transport.args) || transport.args.some((a) => typeof a !== "string")) {
    reject("transport.args must be an array of strings");
  }
  if (transport.args.length > 64) {
    reject("transport.args must have at most 64 entries");
  }
  if (!isPlainObject(transport.env)) {
    reject("transport.env must be an object");
  }
  for (const [k, v] of Object.entries(transport.env)) {
    if (typeof v !== "string") {
      reject(`transport.env["${k}"] must be a string`);
    }
  }

  // Closed configured tool map. Every alias must bind an exact upstream name
  // and an exact input schema with a recomputed digest; any duplicate upstream
  // name across the map, unknown entry field, or digest mismatch is rejected.
  if (!isPlainObject(tools)) {
    reject("tools must be a map of aliases to configured tool bindings");
  }
  const toolCount = Object.keys(tools).length;
  if (toolCount > MAX_CONFIGURED_TOOLS) {
    reject(`tools must have at most ${MAX_CONFIGURED_TOOLS} entries`);
  }
  const configuredTools: Record<string, ConfiguredTool> = {};
  const upstreamNames = new Set<string>();
  for (const [alias, rawTool] of Object.entries(tools)) {
    if (!SERVER_ID_PATTERN.test(alias)) {
      reject(`tools key "${alias}" must be a stable identifier matching /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`);
    }
    if (!isPlainObject(rawTool)) {
      reject(`tools["${alias}"] must be an object`);
    }
    for (const key of Object.keys(rawTool)) {
      if (!(ALLOWED_TOOL_KEYS as readonly string[]).includes(key)) {
        reject(`unknown tool field "${key}" in tools["${alias}"]`);
      }
    }
    const { upstreamName, inputSchema, inputSchemaDigest } = rawTool as Record<string, unknown>;
    if (typeof upstreamName !== "string" || !UPSTREAM_NAME_PATTERN.test(upstreamName)) {
      reject(`tools["${alias}"].upstreamName must match /^[ -~]{1,255}$/`);
    }
    if (upstreamNames.has(upstreamName)) {
      reject(`tools["${alias}"] reuses upstreamName "${upstreamName}" which is already bound`);
    }
    upstreamNames.add(upstreamName);
    if (typeof inputSchemaDigest !== "string" || !SHA256_PATTERN.test(inputSchemaDigest)) {
      reject(`tools["${alias}"].inputSchemaDigest must match /^sha256:[0-9a-f]{64}$/`);
    }
    // The configured input schema must be a full JSON value with object-form
    // root type "object" (self-contained). assertJsonValue both validates and
    // narrows the unknown to JsonValue for the closed config.
    try {
      assertJsonValue(inputSchema);
    } catch {
      reject(`tools["${alias}"].inputSchema must be a JSON value`);
    }
    const schemaDocument = inputSchema as JsonValue;
    if (!isPlainObject(schemaDocument) || schemaDocument.type !== "object") {
      reject(`tools["${alias}"].inputSchema must be an object-form schema with root type "object"`);
    }
    // Recompute the digest (spec section 2: the normalizer MUST recompute every
    // schema digest and reject a mismatch) so a previously-rotated key or a
    // stale siloed copy cannot pin a different contract than the schema holds.
    const recomputed = canonicalJsonDigest(schemaDocument);
    if (recomputed !== inputSchemaDigest) {
      reject(`tools["${alias}"].inputSchemaDigest does not match the recomputed digest of its inputSchema`);
    }
    configuredTools[alias] = {
      upstreamName,
      inputSchema: schemaDocument,
      inputSchemaDigest,
    };
  }

  const config: ToolBrokerServerConfig = {
    serverId,
    adapter: "mcp",
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: {
      kind: "stdio",
      command: transport.command,
      args: transport.args as readonly string[],
      env: transport.env as Readonly<Record<string, string>>,
    },
    startupTimeoutMs,
    // Always store the resolved number (never undefined) so the session can
    // read a concrete request timeout off the closed config.
    requestTimeoutMs: requestTimeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : requestTimeoutMs,
    configRevision,
    tools: configuredTools,
  };

  return config;
}
