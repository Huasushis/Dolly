/**
 * Public entry point for the Host Tool Broker handshake slice.
 *
 * Exports the config admission, session, and adapter seam for the exact MCP
 * `2025-06-18` stdio initialize/initialized lifecycle. See
 * `docs/spec/services/tool-broker.md` (REQ-TOOL-008) for the normative
 * requirements this slice implements.
 */

export { parseToolBrokerConfig } from "./config.js";
export { adaptToolBrokerServer, ToolBrokerSession, killChild, ToolBrokerSessionError } from "./session.js";
export {
  CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  ToolBrokerConfigError,
  type AdaptedToolBrokerServer,
  type PrepareResult,
  type SpawnFn,
  type NowFn,
  type StdioTransportConfig,
  type ToolBrokerErrorCode,
  type ToolBrokerServerConfig,
  type ToolBrokerServerState,
} from "./types.js";
export { startToolBrokerServer, type ToolBrokerServer } from "./factory.js";
