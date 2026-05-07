import type { EventBus } from "../core/bus.js";

export interface ShortTermMemoryEntry {
  id: string;
  content: string;
  relevance_score: number;
  created_at: number;
  last_accessed: number;
}

/**
 * Tracks injections as short-term memory entries.
 * Listens for FORGET tags from the monitor system to remove entries.
 */
export class ShortTermMemory {
  private entries: Map<string, ShortTermMemoryEntry> = new Map();

  constructor(private bus: EventBus) {
    bus.on("memory.forget_tag", (payload) => {
      this.markUnused(payload.injection_id);
    });
  }

  track(entry: ShortTermMemoryEntry): void {
    this.entries.set(entry.id, entry);
  }

  markUnused(id: string): void {
    this.entries.delete(id);
    this.bus.emit("injection.removed", { injection_id: id });
  }

  getActive(): ShortTermMemoryEntry[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => b.relevance_score - a.relevance_score
    );
  }

  getEntry(id: string): ShortTermMemoryEntry | undefined {
    const entry = this.entries.get(id);
    if (entry) entry.last_accessed = Date.now() / 1000;
    return entry;
  }

  pruneStale(maxAgeSeconds: number): number {
    const now = Date.now() / 1000;
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (now - entry.last_accessed > maxAgeSeconds) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }
}
