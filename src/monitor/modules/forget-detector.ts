import type { MonitorModule, MonitorAction } from "../base.js";
import type { EventBus } from "../../core/bus.js";

let bus: EventBus | null = null;

/**
 * Detects [FORGET:id] tags in LLM output and emits events
 * so the ShortTermMemory can remove the corresponding injection.
 */
const forgetDetectorModule: MonitorModule = {
  id: "forget-detector",
  blocking: false,

  setup(b: EventBus): void {
    bus = b;
  },

  onOutput(text: string, fullResponse: string): MonitorAction | null {
    const pattern = /\[FORGET:([^\]]+)\]/g;
    const seen = new Set<string>();

    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(fullResponse)) !== null) {
      const injectionId = match[1].trim();
      if (!seen.has(injectionId)) {
        seen.add(injectionId);
        bus?.emit("memory.forget_tag", { injection_id: injectionId });
      }
    }

    return null;
  },
};

export default forgetDetectorModule;
