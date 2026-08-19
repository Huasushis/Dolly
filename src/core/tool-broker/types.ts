/**
 * Type definitions for the Host Tool Broker slice: the exact MCP `2025-06-18`
 * stdio initialize/initialized handshake plus discovery and contract pinning
 * (sections 1–3). Discovery is untrusted verification input (spec section 3):
 * the closed config-bound tool map and schema digests are the only authority.
 *
 * Naming note: "generation" is the spec term (section 4) for one successful
 * server start/connection; each receives a monotonically increasing
 * `toolServerGeneration` under its server ID. "upstream name" is the spec term
 * (section 1) for the server-side tool name stored separately from the Dolly
 * alias. "config revision" is the spec term (section 7) for the immutable
 * configuration revision this server was started from.
 */

import type { ChildProcess } from "node:child_process";
import type { JsonValue } from "../canonical-json.js";

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

/** One closed Host-configured tool binding. The map key holding this value is
 * the Dolly logical tool name (a stable config key, per spec section 1); the
 * binding fixes the exact upstream MCP tool name and the exact embedded
 * input-schema contract with its recomputed JCS SHA-256 digest (spec sections
 * 2–3). The digest is part of the closed contract and is separate from the
 * schema bytes so a later gate can compare verification input cheaply.
 *
 * `inputSchema` must be an object-form JSON Schema (root `"type":"object"`),
 * embedded and self-contained (only `#`/`#/` JSON Pointer references). The
 * digest is `sha256(JCS(entire document))`; ordering and server annotations
 * cannot change it. Scope: this slice binds exactly `upstream_name`,
 * `input_schema`, and `input_schema_digest`; the other `Tool` schema fields
 * (description, output schema, side effects, idempotency, confirmation,
 * enabled) are later gates. Nothing else is admitted so the binding stays
 * closed. */
export interface ConfiguredTool {
  readonly upstreamName: string;
  readonly inputSchema: JsonValue;
  readonly inputSchemaDigest: string;
}

/** Closed config for one broker server generation (spec sections 1–3). */
export interface ToolBrokerServerConfig {
  readonly serverId: string;
  readonly adapter: "mcp";
  readonly protocolVersion: typeof MCP_PROTOCOL_VERSION;
  readonly transport: StdioTransportConfig;
  /** Bounded wall-clock time to wait for the initialize response. The same
   * window bounds the correlated tools/list discovery request: a generation
   * must come up within its startup window or the candidate is rejected. */
  readonly startupTimeoutMs: number;
  /** Bounded wall-clock time to wait for a post-handshake request response.
   * Optional: `parseToolBrokerConfig` resolves it to 10000 when absent and
   * the session falls back to the same default for direct construction, so
   * the effective timeout is always a positive integer. */
  readonly requestTimeoutMs?: number;
  /** The immutable config revision identifier this server belongs to. The
   * resolved registry pins every catalog to the server ID + generation + this
   * revision; a catalog from another revision cannot authorize use. */
  readonly configRevision: string;
  /** The closed configured tool map: Dolly alias -> exact binding. This map
   * is the Host-side authority. Server discovery can verify it, never widen
   * it. */
  readonly tools: Readonly<Record<string, ConfiguredTool>>;
}

/** Stable identifier and printable-name patterns shared by config admission
 * (server IDs, tool aliases, upstream names). Documented in
 * `tool-broker-config.schema.json` and `common.schema.json` (`StableId`). */
export const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const UPSTREAM_NAME_PATTERN = /^[ -~]{1,255}$/;
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

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
  /** Generation number assigned to this start; defaults to 1. The spec
   * assigns a monotonically increasing number per server ID; the counter
   * across restarts is a later gate, and this injection lets a test pin a
   * specific generation so catalog pinning against a stale generation can be
   * proven. */
  readonly generation?: number;
}

/** Error codes for the handshake, discovery, and post-handshake session.
 * Each handshake and request failure maps to a `Quarantined` result or
 * rejection; the post-handshake codes (`requestTimeoutMs`,
 * `protocolFailure`, `notReady`) guard the request substrate. The wire-level
 * config classification is the spec error code `TOOL_CONFIG_INVALID`
 * (section 8) and is used by `prepare()` when the server's discovery content
 * cannot verify the configured catalog. */
export type ToolBrokerErrorCode =
  | "TOOL_BROKER_CONFIG_INVALID"
  | "TOOL_BROKER_PROTOCOL_VERSION_MISMATCH"
  | "TOOL_BROKER_HANDSHAKE_MALFORMED"
  | "TOOL_BROKER_STARTUP_TIMEOUT"
  | "TOOL_BROKER_CHILD_EXITED"
  | "TOOL_BROKER_NOT_READY"
  | "TOOL_BROKER_PROTOCOL_FAILURE"
  | "TOOL_BROKER_REQUEST_TIMEOUT"
  | "TOOL_CONFIG_INVALID";

/** Result of `prepare()`. A `Ready` result carries the generation number and
 * the pinned catalog; a `Quarantined` result carries the failure code.
 * `Stopped` is not returned by `prepare()` — it is the terminal state after
 * `stop()`. The catalog is only ever present on a Ready result and is part
 * of the same minted, frozen identity as the rest of the result. */
export interface PrepareResult {
  readonly state: "Ready" | "Quarantined";
  readonly toolServerId: string;
  /** Monotonically increasing per server ID (spec section 4). Starts at 1. */
  readonly toolServerGeneration: number;
  readonly errorCode?: ToolBrokerErrorCode;
  /** Present exactly on a Ready result: the pinned, frozen catalog produced
   * by discovery verification. See `PinnedToolCatalog`. */
  readonly catalog?: PinnedToolCatalog;
}

/** Canonical schema identifier of the pinned catalog, making the catalog a
 * versioned artifact (matching the `dolly.tool-operation-binding/v1`
 * convention in spec section 5). */
export const TOOL_CATALOG_SCHEMA = "dolly.tool-catalog/v1" as const;

/** The result of discovery verification: a frozen, closed, versioned artifact
 * that later authorization can trust. It is exactly the configured tool map —
 * never a widening. Produced inside the session during `prepare()` and stored
 * on the minted Ready `PrepareResult`, so a catalog cannot be fabricated:
 * only a session that completed discovery can produce one.
 *
 * The identity fields pin the catalog to the generating server ID, generation
 * and config revision. A stale comparison (different generation or revision)
 * must not authorize later use (`matchToolCatalog`). */
export interface PinnedToolCatalog {
  readonly schema: typeof TOOL_CATALOG_SCHEMA;
  readonly toolServerId: string;
  readonly toolServerGeneration: number;
  readonly configRevision: string;
  /** Exactly the configured closed tool map (alias -> binding). */
  readonly tools: Readonly<Record<string, ConfiguredTool>>;
}

/** The context a later authorization gate compares a request catalog against:
 * the current server ID, generation, and config revision of the candidate
 * request. Not minted — caller-supplied expected state. */
export interface ToolCatalogContext {
  readonly toolServerId: string;
  readonly toolServerGeneration: number;
  readonly configRevision: string;
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
