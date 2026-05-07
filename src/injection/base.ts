import type { ContextFrame } from "../core/context.js";
import type { EventBus, EventPayloads, EventName } from "../core/bus.js";

export interface InjectionEvent {
  id: string;
  content: string;
  target: "background" | "working";
  priority: number;
}

export interface InjectionModule {
  /** Unique identifier for this injection module */
  id: string;
  /** Triggered when context changes — return injection to insert */
  onContextChange?(frames: ContextFrame[]): InjectionEvent | null;
  /** Triggered on any event bus event — return injection to insert */
  onEvent?(event: EventName, payload: any): InjectionEvent | null;
  /** Optional default prompt contribution, permanently loaded at the front */
  defaultPrompt?(): string;
  /** Initialize the module */
  setup?(bus: EventBus): void;
}
