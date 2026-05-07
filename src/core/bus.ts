import { EventEmitter } from "events";

export type EventName =
  | "llm.output_chunk"
  | "llm.response_done"
  | "monitor.detected"
  | "injection.pending"
  | "injection.removed"
  | "context.near_capacity"
  | "context.compressed"
  | "tool.call_requested"
  | "tool.result"
  | "memory.forget_tag"
  | "memory.long_term_retrieved"
  | "system.shutdown";

export interface EventPayloads {
  "llm.output_chunk": { text: string; timestamp: number };
  "llm.response_done": { full_response: string };
  "monitor.detected": { monitor_id: string; action: any };
  "injection.pending": { injection: any };
  "injection.removed": { injection_id: string };
  "context.near_capacity": { token_count: number; ratio: number };
  "context.compressed": { removed_ids: string[] };
  "tool.call_requested": { tool_name: string; params: Record<string, unknown> };
  "tool.result": { tool_name: string; result: unknown };
  "memory.forget_tag": { injection_id: string };
  "memory.long_term_retrieved": { entries: any[] };
  "system.shutdown": {};
}

export class EventBus {
  private emitter = new EventEmitter();

  emit<E extends EventName>(event: E, payload: EventPayloads[E]): void {
    this.emitter.emit(event, payload);
  }

  on<E extends EventName>(event: E, handler: (payload: EventPayloads[E]) => void): string {
    this.emitter.on(event, handler);
    const handlerId = `${event}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    (handler as any).__handlerId = handlerId;
    return handlerId;
  }

  off(event: EventName, handler: (...args: any[]) => void): void {
    this.emitter.off(event, handler);
  }

  once<E extends EventName>(event: E, handler: (payload: EventPayloads[E]) => void): void {
    this.emitter.once(event, handler);
  }
}
