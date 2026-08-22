/**
 * Public entry point for the Host Tool Broker stdio slice.
 *
 * Exports the exact-`dolly.tool-broker-config/v1` config admission, the
 * Host-resolved executable premise seam, the session, and the adapter for the
 * exact MCP `2025-06-18` stdio initialize/initialized lifecycle. See
 * `docs/spec/services/tool-broker.md` (REQ-TOOL-008) for the normative
 * requirements this slice implements.
 */

export {
  parseToolBrokerConfig,
  isParsedToolBrokerServerConfig,
  assertParsedToolBrokerServerConfig,
} from "./config.js";
export {
  adaptToolBrokerServer,
  ToolBrokerSession,
  killChild,
  ToolBrokerSessionError,
  pinnedToolCatalog,
  matchToolCatalog,
} from "./session.js";
export {
  CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  TOOL_BROKER_CONFIG_SCHEMA,
  TOOL_CATALOG_SCHEMA,
  ARGUMENT_POINTER_PATTERN,
  ENV_NAME_PATTERN,
  EXECUTABLE_PATH_PATTERN,
  EXTENSION_ID_PATTERN,
  SECRET_REF_PATTERN,
  SEMVER_VERSION_PATTERN,
  STABLE_ID_PATTERN,
  UPSTREAM_NAME_PATTERN,
  SHA256_PATTERN,
  ToolBrokerConfigError,
  type AdaptedToolBrokerServer,
  type ConfiguredTool,
  type HostResolvedExecutablePremise,
  type PinnedToolCatalog,
  type PrepareResult,
  type SpawnFn,
  type NowFn,
  type StdioTransportConfig,
  type ToolBrokerConfigDocument,
  type ToolBrokerConfigDocumentInput,
  type ToolBrokerErrorCode,
  type ToolBrokerLimits,
  type ToolBrokerServerConfig,
  type ToolBrokerServerState,
  type ToolCatalogContext,
  type ToolBrokerServerOptions,
  type ToolIdempotencyPolicy,
  type ToolSideEffectClass,
} from "./types.js";
export { startToolBrokerServer, type ToolBrokerServer } from "./factory.js";
