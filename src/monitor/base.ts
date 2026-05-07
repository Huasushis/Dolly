import type { EventBus } from "../core/bus.js";

export interface MonitorAction {
  action: "inject" | "block" | "pass" | "remove";
  injection_id?: string;
  payload?: string;
  metadata?: Record<string, unknown>;
}

export interface MonitorModule {
  /** Unique identifier */
  id: string;
  /** Whether this monitor should block output while processing */
  blocking?: boolean;
  /** Called for each chunk of LLM output */
  onOutput?(text: string, fullResponse: string): MonitorAction | null;
  /** Initialize the module */
  setup?(bus: EventBus): void;
}
