/**
 * Config admission for the Tool Broker handshake slice.
 *
 * `parseToolBrokerConfig` is the first fail-closed layer: it rejects any
 * config that does not name exactly protocol `2025-06-18`, adapter `mcp`, and
 * a stdio transport, before any child is spawned. Unknown top-level fields are
 * rejected so a stale or typo'd config cannot silently widen behaviour.
 *
 * The full registry also fixes `enabled`, `allowed_modules`, `limits`, and a
 * closed tool map; validating those is the later discovery/authorization gate
 * and is intentionally not in this slice.
 */

import { ToolBrokerConfigError, MCP_PROTOCOL_VERSION, type ToolBrokerServerConfig } from "./types.js";

const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Known top-level keys of `ToolBrokerServerConfig`. */
const ALLOWED_KEYS = ["serverId", "adapter", "protocolVersion", "transport", "startupTimeoutMs"] as const;
const ALLOWED_TRANSPORT_KEYS = ["kind", "command", "args", "env"] as const;

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

  const { serverId, adapter, protocolVersion, transport, startupTimeoutMs } = input as Record<string, unknown>;

  if (typeof serverId !== "string" || !SERVER_ID_PATTERN.test(serverId)) {
    reject("serverId must be a stable identifier matching /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/");
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
  };


  return config;
}
