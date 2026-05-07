import type { MonitorModule, MonitorAction } from "../base.js";
import type { EventBus } from "../../core/bus.js";

/**
 * Simply prints LLM output to stdout as it streams.
 * The most basic monitor — like a pass-through that renders to terminal.
 */
const stdoutModule: MonitorModule = {
  id: "stdout",
  blocking: false,

  onOutput(text: string): MonitorAction | null {
    process.stdout.write(text);
    return null; // Pass through, don't interfere
  },
};

export default stdoutModule;
