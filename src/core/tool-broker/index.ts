/**
 * Public entry point for the Host Tool Broker handshake slice.
 *
 * Exports the config admission, session, and adapter seam for the exact MCP
 * `2025-06-18` stdio initialize/initialized lifecycle. See
 * `docs/spec/services/tool-broker.md` (REQ-TOOL-008) for the normative
 * requirements this slice implements.
 */

export { parseToolBrokerConfig } from "./config.js";
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
  TOOL_CATALOG_SCHEMA,
  ToolBrokerConfigError,
  type AdaptedToolBrokerServer,
  type ConfiguredTool,
  type PinnedToolCatalog,
  type PrepareResult,
  type SpawnFn,
  type NowFn,
  type StdioTransportConfig,
  type ToolBrokerErrorCode,
  type ToolBrokerServerConfig,
  type ToolBrokerServerState,
  type ToolCatalogContext,
  type ToolBrokerServerOptions,
} from "./types.js";
export { startToolBrokerServer, type ToolBrokerServer } from "./factory.js";
