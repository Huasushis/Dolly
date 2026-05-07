import type { InjectionModule, InjectionEvent } from "../base.js";
import type { ContextFrame } from "../../core/context.js";
import type { EventBus, EventPayloads } from "../../core/bus.js";

/**
 * Context compression via probabilistic forgetting.
 * When context nears capacity, older frames (farther from end) have higher
 * probability of being removed. Triggers on 'context.near_capacity' event.
 */
class CompressionInjector implements InjectionModule {
  id = "compression";

  private lastCompression = 0;
  private cooldownMs = 5000; // Don't compress more than once every 5s

  setup(bus: EventBus): void {
    bus.on("context.near_capacity", (payload) => {
      this.trigger = true;
    });
  }

  private trigger = false;

  onContextChange(frames: ContextFrame[]): InjectionEvent | null {
    if (!this.trigger) return null;

    const now = Date.now();
    if (now - this.lastCompression < this.cooldownMs) return null;
    this.lastCompression = now;
    this.trigger = false;

    // Probabilistic forgetting: older frames have higher removal probability
    const totalFrames = frames.length;
    const toRemove: string[] = [];

    for (const frame of frames) {
      if (frame.pinned) continue;
      if (frame.role === "user") continue; // Never remove user input

      const probability = frame.distance_from_end / Math.max(totalFrames, 1);
      if (Math.random() < probability) {
        toRemove.push(frame.id);
      }
    }

    if (toRemove.length === 0) return null;

    return {
      id: "compression",
      content: `[COMPRESS:${toRemove.join(",")}]`,
      target: "working",
      priority: 100, // Low priority, processed last
    };
  }
}

export default new CompressionInjector();
