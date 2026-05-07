import { randomUUID } from "crypto";
import type { EventBus } from "./bus.js";

export interface ContextFrame {
  id: string;
  role: "system" | "user" | "assistant" | "injection";
  content: string;
  timestamp: number;
  distance_from_end: number;
  injection_id?: string;
  pinned: boolean;
}

export interface ContextConfig {
  max_tokens: number;
  compression_threshold: number;
}

export class ContextManager {
  private frames: ContextFrame[] = [];
  private backgroundPrompt = "";
  private config: ContextConfig;

  constructor(config: ContextConfig, private bus?: EventBus) {
    this.config = config;
  }

  setBackgroundPrompt(prompt: string): void {
    this.backgroundPrompt = prompt;
    this.frames[0] = {
      id: "background",
      role: "system",
      content: prompt,
      timestamp: Date.now() / 1000,
      distance_from_end: 0,
      pinned: true,
    };
  }

  addFrame(frame: Omit<ContextFrame, "id" | "timestamp" | "distance_from_end">): string {
    const id = randomUUID();
    this.frames.push({
      ...frame,
      id,
      timestamp: Date.now() / 1000,
      distance_from_end: 0,
    });
    this.reindex();
    this.checkCapacity();
    return id;
  }

  removeFrame(id: string): boolean {
    const idx = this.frames.findIndex((f) => f.id === id);
    if (idx === -1 || this.frames[idx].pinned) return false;
    this.frames.splice(idx, 1);
    this.reindex();
    return true;
  }

  removeByInjectionId(injectionId: string): number {
    const toRemove = this.frames.filter(
      (f) => f.injection_id === injectionId && !f.pinned
    );
    toRemove.forEach((f) => this.removeFrame(f.id));
    if (toRemove.length > 0) {
      this.bus?.emit("injection.removed", { injection_id: injectionId });
    }
    return toRemove.length;
  }

  getFrames(): ContextFrame[] {
    return [...this.frames];
  }

  pinFrame(id: string): void {
    const frame = this.frames.find((f) => f.id === id);
    if (frame) frame.pinned = true;
  }

  estimateTokens(): { count: number; ratio: number } {
    const totalChars = this.frames.reduce((sum, f) => sum + f.content.length, 0);
    const estimate = Math.ceil(totalChars / 4);
    return {
      count: estimate,
      ratio: estimate / this.config.max_tokens,
    };
  }

  buildMessages(): Array<{ role: string; content: string }> {
    return this.frames.map((f) => ({
      role: f.role === "injection" ? "user" : f.role,
      content: f.content,
    }));
  }

  private reindex(): void {
    const total = this.frames.length;
    for (let i = 0; i < total; i++) {
      this.frames[i].distance_from_end = total - 1 - i;
    }
  }

  private checkCapacity(): void {
    const { ratio } = this.estimateTokens();
    if (ratio >= this.config.compression_threshold) {
      this.bus?.emit("context.near_capacity", {
        token_count: this.estimateTokens().count,
        ratio,
      });
    }
  }
}
