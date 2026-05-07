import type { InjectionModule, InjectionEvent } from "../base.js";
import type { ContextFrame } from "../../core/context.js";
import type { EventBus } from "../../core/bus.js";

/**
 * Probabilistic forgetting: when context nears capacity,
 * each frame's removal probability = position_from_start / total_frames.
 * Earlier frames are more likely to be forgotten.
 */
class CompressionInjector implements InjectionModule {
  id = "compression";

  private lastCompression = 0;
  private cooldownMs = 5000;
  private triggered = false;

  setup(bus: EventBus): void {
    bus.on("context.near_capacity", (_payload) => {
      this.triggered = true;
    });
  }

  onContextChange(frames: ContextFrame[]): InjectionEvent | null {
    if (!this.triggered) return null;

    const now = Date.now();
    if (now - this.lastCompression < this.cooldownMs) return null;
    this.lastCompression = now;
    this.triggered = false;

    const total = frames.length;
    if (total === 0) return null;

    const toRemove: string[] = [];
    for (let i = 0; i < total; i++) {
      const frame = frames[i];
      if (frame.pinned) continue;
      // Probability higher for older frames (lower index)
      const probability = (total - 1 - i) / total;
      if (Math.random() < probability) {
        toRemove.push(frame.id);
      }
    }

    if (toRemove.length === 0) return null;
    return {
      id: "compression",
      content: `[COMPRESS:${toRemove.join(",")}]`,
      priority: 100,
    };
  }
}

export default new CompressionInjector();
