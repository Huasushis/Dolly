/**
 * Type definitions for the Host Tool Broker slice: the exact MCP `2025-06-18`
 * stdio initialize/initialized handshake plus discovery and contract pinning
 * (sections 1–3), driven by the frozen `dolly.tool-broker-config/v1`
 * document (`tool-broker-config.schema.json`). Discovery is untrusted
 * verification input (section 3): the closed config-bound tool map and schema
 * digests are the only authority.
 *
 * Naming note: "generation" is the spec term (section 4) for one successful
 * server start/connection; each receives a monotonically increasing
 * `toolServerGeneration` under its server ID. "upstream name" is the spec term
 * (section 1) for the server-side tool name stored separately from the Dolly
 * alias. "config revision" is the spec term (section 7) for the immutable
 * configuration revision this server was started from. "premise" is the
 * established Dolly term for a closed host-minted record of resolved
 * preconditions a launcher requires (see `module-activation-premises`); the
 * executable premise below is the same concept applied to the stdio
 * executable: a set of preconditions for starting one server generation.
 */

import type { ChildProcess } from "node:child_process";
import type { JsonValue } from "../canonical-json.js";

/** The single v1 MCP protocol version this slice accepts. Hardcoded, never
 * derived from an SDK constant, because the installed `@modelcontextprotocol/sdk`
 * may advertise a newer version (`2025-11-25` or later) and the spec forbids
 * silent fall-forward. */
export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;

/** Client identity sent in the `initialize` request `clientInfo`. */
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

/** Canonical identifier of the frozen resolved Host tool-broker configuration
 * document (`tool-broker-config.schema.json`). A document MUST carry exactly
 * this tag to pass config admission. */
export const TOOL_BROKER_CONFIG_SCHEMA = "dolly.tool-broker-config/v1" as const;

/** Stable identifier for configuration keys (server IDs, tool aliases,
 * allowed Module IDs). Matches `common.schema.json#/$defs/StableId`. */
export const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
/** Extension ID for stdio `package_id`. Matches
 * `common.schema.json#/$defs/ExtensionId`. */
export const EXTENSION_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){2,}$/u;
/** Printable upstream tool name served by an MCP server. Matches the Tool
 * `upstream_name` pattern in `tool-broker-config.schema.json`. */
export const UPSTREAM_NAME_PATTERN = /^[ -~]{1,255}$/u;
/** Strict content-addressed digest. Matches `common.schema.json#/$defs/Sha256`. */
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
/** Semantic version. Matches the StdioTransport `package_version` pattern. */
export const SEMVER_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
/** Relative executable member path inside an installed package: no leading
 * slash and no `.`/`..` segment, exactly the StdioTransport `executable`
 * pattern. Never a PATH lookup or shell command. */
export const EXECUTABLE_PATH_PATTERN =
  /^(?!.*(?:^|\/)\.\.?(?:\/|$))(?!\/)[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
/** Secret-binding environment variable name. Matches the StdioTransport
 * `secret_bindings` propertyNames pattern. */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
/** Reference to a secret held by the Host secret store. Matches
 * `common.schema.json#/$defs/SecretRef`. */
export const SECRET_REF_PATTERN =
  /^secret:\/\/[a-z][a-z0-9-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/u;
/** RFC 6901 JSON Pointer for an `argument_key` idempotency policy. Matches
 * the IdempotencyPolicy `argument_pointer` pattern. */
export const ARGUMENT_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)+$/u;

/** Side-effect class of a configured Tool. Matches the Tool enum in
 * `tool-broker-config.schema.json`. */
export type ToolSideEffectClass =
  | "read_only"
  | "idempotent_write"
  | "non_idempotent_write"
  | "unknown";

/** Closed idempotency policy of a configured Tool. Every non-`idempotent_write`
 * tool carries exactly `{"kind":"none"}`; every `idempotent_write` tool
 * carries `{"kind":"argument_key","argument_pointer":"/..."}`. */
export type ToolIdempotencyPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "argument_key"; readonly argument_pointer: string };

/** Byte/time/concurrency limits for one broker server. Matches the `Limits`
 * definition; all five fields are required. */
export interface ToolBrokerLimits {
  readonly startup_timeout_ms: number;
  readonly request_timeout_ms: number;
  readonly max_concurrency: number;
  readonly max_request_bytes: number;
  readonly max_response_bytes: number;
}

/** Closed stdio transport for one broker server, exactly the
 * `StdioTransport` definition in `tool-broker-config.schema.json`.
 *
 * `executable` is a relative member of the immutable package named by
 * `(package_id, package_version, package_digest)` (spec section 2). The slice
 * never resolves it through `PATH`, a shell, the current directory, or an
 * Extension-controlled file; a Host-resolved executable premise supplies the
 * concrete file for a generation start. */
export interface StdioTransportConfig {
  readonly kind: "stdio";
  readonly package_id: string;
  readonly package_version: string;
  readonly package_digest: string;
  readonly executable: string;
  readonly executable_digest: string;
  /** Argument vector passed directly, never through a shell. */
  readonly args: readonly string[];
  /** Variable name -> secret reference. Raw secrets are invalid
   * configuration (spec section 2); product secret resolution is a later
   * gate, so this slice passes the configured references verbatim as the
   * child environment. */
  readonly secret_bindings: Readonly<Record<string, string>>;
}

/** One closed Host-configured tool binding, exactly the Tool definition in
 * `tool-broker-config.schema.json`. The map key holding this value is the
 * Dolly logical tool name (a stable configuration key, per spec section 1);
 * the binding fixes the exact upstream MCP tool name, description, embedded
 * input and output schemas with their recomputed JCS SHA-256 digests,
 * side-effect class, closed idempotency policy, confirmation policy, and
 * enabled state (spec sections 2–3).
 *
 * `input_schema` must be an object-form JSON Schema (root
 * `"type":"object"`); `output_schema` may be an object-form or boolean
 * schema. Each digest is `sha256(JCS(entire schema document))`; config
 * admission recomputes both and rejects a mismatch. */
export interface ConfiguredTool {
  readonly upstream_name: string;
  readonly description: string;
  readonly input_schema: JsonValue;
  readonly input_schema_digest: string;
  readonly output_schema: JsonValue;
  readonly output_schema_digest: string;
  readonly side_effect_class: ToolSideEffectClass;
  readonly idempotency: ToolIdempotencyPolicy;
  readonly requires_confirmation: boolean;
  readonly enabled: boolean;
}

/** Closed config for one broker server generation, exactly the Server
 * definition in `tool-broker-config.schema.json` plus the host-assigned
 * server ID (the document's `servers` map key) and config revision. */
export interface ToolBrokerServerConfig {
  /** The document `servers` map key naming this server. */
  readonly serverId: string;
  readonly enabled: boolean;
  readonly adapter: "mcp";
  readonly protocol_version: typeof MCP_PROTOCOL_VERSION;
  readonly transport: StdioTransportConfig;
  readonly allowed_modules: readonly string[];
  /** Byte/time/concurrency limits. Matches the Limit `Limits` definition. */
  readonly limits: ToolBrokerLimits;
  /** The immutable config revision identifier this server belongs to. The
   * resolved registry pins every catalog to the server ID + generation + this
   * revision; a catalog from another revision cannot authorize use. */
  readonly configRevision: string;
  /** The closed configured tool map: Dolly alias -> exact binding. This map
   * is the Host-side authority. Server discovery can verify it, never widen
   * it. */
  readonly tools: Readonly<Record<string, ConfiguredTool>>;
}

/** The frozen resolved Host tool-broker configuration document
 * (`tool-broker-config.schema.json`): the schema tag plus a closed server
 * map. Produced by `parseToolBrokerConfig` and frozen at mint. */
export interface ToolBrokerConfigDocument {
  readonly schema: typeof TOOL_BROKER_CONFIG_SCHEMA;
  readonly servers: Readonly<Record<string, ToolBrokerServerConfig>>;
}

/** The unfrozen admission input: the exact raw `dolly.tool-broker-config/v1`
 * wire document (`tool-broker-config.schema.json`) as the Host reads it,
 * before validation. `parseToolBrokerConfig` accepts it (as `unknown`) and
 * mints the branded `ToolBrokerConfigDocument`; callers never construct
 * `ToolBrokerConfigDocument` directly. Servers are raw objects until the
 * admitter validates and binds the Host's `serverId`/`configRevision`. */
export interface ToolBrokerConfigDocumentInput {
  readonly schema: typeof TOOL_BROKER_CONFIG_SCHEMA;
  readonly servers: Readonly<Record<string, unknown>>;
}

/** Preconditions for starting one stdio server generation, minted by the Host
 * out of its own package resolution on every generation start (spec section
 * 4: the Host resolves only the immutable installed package named by the
 * config, hashes the selected file, and requires `executable_digest`). The
 * premise is the only source of the concrete spawn file; the config's
 * `transport.executable` is a relative package member and is never a spawn
 * target. The factory requires the premise to echo the configured
 * package/executable identity exactly before it may spawn
 * `executablePath`. Product package resolution (later gate) mints this
 * premise after resolving and hashing the file. */
export interface HostResolvedExecutablePremise {
  /** Absolute path of the resolved file inside the resolved installed
   * package. Supplied by the premise (Host resolution), never read from
   * config. */
  readonly executablePath: string;
  readonly package_id: string;
  readonly package_version: string;
  readonly package_digest: string;
  readonly executable: string;
  readonly executable_digest: string;
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
