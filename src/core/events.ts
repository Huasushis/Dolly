import { EventEmitter } from "events";

export class EventBus {
  private emitter = new EventEmitter();

  emit(event: string, payload?: any): void {
    this.emitter.emit(event, payload);
  }

  on(event: string, handler: (payload?: any) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: string, handler: (payload?: any) => void): void {
    this.emitter.off(event, handler);
  }

  once(event: string, handler: (payload?: any) => void): void {
    this.emitter.once(event, handler);
  }
}
