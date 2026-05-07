import type { MonitorModule, MonitorAction } from "../base.js";
import type { EventBus } from "../../core/bus.js";

let bus: EventBus | null = null;

/**
 * MCP monitor — detects [TOOL:mcp.*] or [AWAIT:mcp.*] tool calls
 * and forwards them to the appropriate MCP server.
 *
 * Minimal implementation: for each detected MCP tool call,
 * dispatches a tool.call_requested event with an "mcp:" prefix.
 * The tool handler in main.ts resolves the MCP server and forwards the call.
 */
const mcpModule: MonitorModule = {
  id: "mcp",
  blocking: true,

  setup(b: EventBus): void {
    bus = b;
  },

  onOutput(_text: string, fullResponse: string): MonitorAction | null {
    // Detect [AWAIT:mcp.servername.toolname]
    const awaitPattern = /\[AWAIT:(mcp\.[^\]]+)\]\s*\n?([\s\S]*?)\[\/TOOL\]/g;
    let match = awaitPattern.exec(fullResponse);
    if (match) {
      const fullName = match[1].trim();
      const paramsStr = match[2].trim();
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(paramsStr); } catch { params = { raw: paramsStr }; }

      bus?.emit("tool.call_requested", { tool_name: fullName, params });
      return { action: "block", payload: `[MCP:${fullName}] ` };
    }

    // Detect [TOOL:mcp.servername.toolname] (non-blocking)
    const toolPattern = /\[TOOL:(mcp\.[^\]]+)\]\s*\n?([\s\S]*?)\[\/TOOL\]/g;
    match = toolPattern.exec(fullResponse);
    if (match) {
      const fullName = match[1].trim();
      const paramsStr = match[2].trim();
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(paramsStr); } catch { params = { raw: paramsStr }; }

      bus?.emit("tool.call_requested", { tool_name: fullName, params });
      return { action: "pass" };
    }

    return null;
  },
};

export default mcpModule;
