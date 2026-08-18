/**
 * Type definitions for the first Host Tool Broker slice: the exact MCP
 * `2025-06-18` stdio initialize/initialized handshake with fail-closed
 * protocol-version admission.
 *
 * This slice owns only the handshake seam. There is no tool discovery,
 * invocation, idempotency, authorization, Streamable HTTP, or product runtime
 * wiring here; those are later gates (see docs/spec/services/tool-broker.md).
 *
 * Naming note: "generation" is the spec term (section 4) for one successful
 * server start/connection; each receives a monotonically increasing
 * `toolServerGeneration` under its server ID. It is not a retry counter.
 */

import type { ChildProcess } from "node:child_process";

/** The single v1 MCP protocol version this slice accepts. Hardcoded, never
 * derived from an SDK constant, because the installed `@modelcontextprotocol/sdk`
 * may advertise a newer version (`2025-11-25` or later) and the spec forbids
 * silent fall-forward. */
export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;

/** Client identity sent in the `initialize` request `clientInfo` field. */
export const CLIENT_INFO = Object.freeze({
  name: "dolly-tool-broker",
  version: "0.1.0",
} as const);

/** Lifecycle states for a single broker server generation.
 *
 * `Preparing` — the child has been spawned and the handshake is in progress.
 * `Ready` — the handshake completed; the generation may accept dispatch.
 * `Quarantined` — the handshake failed; the generation is unusable and torn
 *   down. Requires operator repair before another attempt.
 * `Stopped` — the generation has been stopped by the host and the child is
 *   confirmed dead. `Draining` (spec section 4) is out of scope for this slice
 *   because there is no in-flight dispatch to drain.
 */
export type ToolBrokerServerState =
  | "Preparing"
  | "Ready"
  | "Quarantined"
  | "Stopped";

/** stdio transport for this slice. Streamable HTTP is out of scope. */
export interface StdioTransportConfig {
  readonly kind: "stdio";
  /** Absolute or PATH-resolved executable path. In the full registry this is a
   * relative member of an immutable package; this slice accepts an absolute
   * path so a test fixture can be spawned directly. Package/digest binding is a
   * later gate. */
  readonly command: string;
  /** Argument vector passed directly, never through a shell. */
  readonly args: readonly string[];
  /** Environment for the child. The spec clears the environment by default and
   * only adds configured secret bindings; product secret resolution is a later
   * gate, so this slice passes the given map verbatim (empty by default). */
  readonly env: Readonly<Record<string, string>>;
}

/** Closed config for one broker server, handshake-relevant fields only.
 *
 * The full `tool-broker-config.schema.json` Server object also fixes
 * `enabled`, `allowed_modules`, `limits`, and a closed tool map; those are the
 * later discovery/authorization gates and are intentionally absent here. */
export interface ToolBrokerServerConfig {
  readonly serverId: string;
  readonly adapter: "mcp";
  readonly protocolVersion: typeof MCP_PROTOCOL_VERSION;
  readonly transport: StdioTransportConfig;
  /** Bounded wall-clock time to wait for the initialize response. */
  readonly startupTimeoutMs: number;
  /** Bounded wall-clock time to wait for a post-handshake request response.
   * Optional: `parseToolBrokerConfig` resolves it to 10000 when absent and
   * the session falls back to the same default for direct construction, so
   * the effective timeout is always a positive integer. */
  readonly requestTimeoutMs?: number;
}

/** Subset of `node:child_process` `spawn` used for dependency injection in
 * tests. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: readonly ("pipe" | "ignore")[]; readonly env: Readonly<Record<string, string>>; readonly windowsHide: boolean },
) => ChildProcess;

/** Clock injection for deterministic timeout measurement. */
export type NowFn = () => number;

/** Options injected into `startToolBrokerServer` for testing. */
export interface ToolBrokerServerOptions {
  readonly spawn: SpawnFn;
  readonly now: NowFn;
}

/** Error codes for the handshake and post-handshake session. Each handshake
 * and request failure maps to a `Quarantined` result or rejection; the
 * post-handshake codes (`requestTimeoutMs`, `protocolFailure`,
 * `notReady`) guard the ping request substrate. */
export type ToolBrokerErrorCode =
  | "TOOL_BROKER_CONFIG_INVALID"
  | "TOOL_BROKER_PROTOCOL_VERSION_MISMATCH"
  | "TOOL_BROKER_HANDSHAKE_MALFORMED"
  | "TOOL_BROKER_STARTUP_TIMEOUT"
  | "TOOL_BROKER_CHILD_EXITED"
  | "TOOL_BROKER_NOT_READY"
  | "TOOL_BROKER_PROTOCOL_FAILURE"
  | "TOOL_BROKER_REQUEST_TIMEOUT";

/** Result of `prepare()`. A `Ready` result carries the generation number; a
 * `Quarantined` result carries the failure code. `Stopped` is not returned by
 * `prepare()` — it is the terminal state after `stop()`. */
export interface PrepareResult {
  readonly state: "Ready" | "Quarantined";
  readonly toolServerId: string;
  /** Monotonically increasing per server ID (spec section 4). Starts at 1. */
  readonly toolServerGeneration: number;
  readonly errorCode?: ToolBrokerErrorCode;
}

/** Frozen, reusable projection of a prepared, ready generation. Returned by
 * `adaptToolBrokerServer` so callers never receive a mutable reference to
 * internal state. */
export interface AdaptedToolBrokerServer {
  readonly toolServerId: string;
  readonly toolServerGeneration: number;
  readonly protocolVersion: typeof MCP_PROTOCOL_VERSION;
}

/** Error thrown by `parseToolBrokerConfig` for any invalid or unknown field. */
export class ToolBrokerConfigError extends Error {
  constructor(readonly code: "TOOL_BROKER_CONFIG_INVALID", message: string) {
    super(`${code}: ${message}`);
    this.name = "ToolBrokerConfigError";
  }
}
