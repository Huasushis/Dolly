import type { ContextFrame } from "../core/context.js";
import type { EventBus } from "../core/bus.js";

/** An injection into the context body */
export interface InjectionEvent {
  id: string;
  content: string;
  priority: number; // lower = higher priority
}

export interface InjectionModule {
  id: string;

  /** Initial head content — loaded into background prompt at startup. Can be empty. */
  headContent?(): string;

  /** Triggered when context body changes — return injection to add to body */
  onContextChange?(frames: ContextFrame[]): InjectionEvent | null | Promise<InjectionEvent | null>;

  /** Triggered on bus events */
  onEvent?(event: string, payload: any): InjectionEvent | null;

  /** Initialize */
  setup?(bus: EventBus): void;
}
