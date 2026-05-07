import type { MonitorModule, MonitorAction } from "../base.js";
import type { EventBus } from "../../core/bus.js";

let bus: EventBus | null = null;

/**
 * Detects [TOOL:name]...[AWAIT:name] tags in LLM output.
 * Emits tool_call_requested events and optionally blocks for await-style calls.
 */
const toolCallModule: MonitorModule = {
  id: "tool-call",
  blocking: true,

  setup(b: EventBus): void {
    bus = b;
  },

  onOutput(text: string, fullResponse: string): MonitorAction | null {
    // Check for [AWAIT:toolname] ... [/TOOL] — blocking tool call
    const awaitPattern = /\[AWAIT:([^\]]+)\]\s*\n?([\s\S]*?)\[\/TOOL\]/g;
    let match = awaitPattern.exec(fullResponse);
    if (match) {
      const toolName = match[1].trim();
      const paramsStr = match[2].trim();
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(paramsStr);
      } catch {
        params = { raw: paramsStr };
      }

      bus?.emit("tool.call_requested", { tool_name: toolName, params });
      return { action: "block", payload: `[WAIT:${toolName}] ` };
    }

    // Check for [TOOL:toolname] ... [/TOOL] — non-blocking
    const toolPattern = /\[TOOL:([^\]]+)\]\s*\n?([\s\S]*?)\[\/TOOL\]/g;
    match = toolPattern.exec(fullResponse);
    if (match) {
      const toolName = match[1].trim();
      const paramsStr = match[2].trim();
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(paramsStr);
      } catch {
        params = { raw: paramsStr };
      }

      bus?.emit("tool.call_requested", { tool_name: toolName, params });
      return { action: "pass" };
    }

    return null;
  },
};

export default toolCallModule;
