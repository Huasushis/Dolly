import { randomUUID } from "crypto";
import type { EventBus } from "./bus.js";

/**
 * A frame in the context body — just text with metadata.
 * No role. Content itself carries meaning.
 */
export interface ContextFrame {
  id: string;
  content: string;
  timestamp: number;
  injection_id?: string;
  pinned: boolean;
}

export interface ContextConfig {
  max_tokens: number;
  compression_threshold: number;
}

/**
 * Context = Head + Body
 *
 * Head: Each injector maintains its own text entry (injector_id → content).
 *       Starts empty, mutable. Combined as the LLM background prompt.
 *
 * Body: Ordered stream of ContextFrames. No roles, no categorization.
 *       Everything — user text, LLM output, injections — flows through here.
 */
export class ContextManager {
  private head = new Map<string, string>();
  private body: ContextFrame[] = [];
  private config: ContextConfig;

  constructor(config: ContextConfig, private bus?: EventBus) {
    this.config = config;
  }

  // ── Head ───────────────────────────────────────────────

  setHead(injectorId: string, content: string): void {
    if (content.trim()) {
      this.head.set(injectorId, content);
    } else {
      this.head.delete(injectorId);
    }
  }

  getHead(injectorId: string): string | undefined {
    return this.head.get(injectorId);
  }

  removeHead(injectorId: string): void {
    this.head.delete(injectorId);
  }

  buildHeadPrompt(): string {
    const entries: string[] = [];
    for (const content of this.head.values()) {
      if (content.trim()) entries.push(content);
    }
    return entries.join("\n\n");
  }

  // ── Body ───────────────────────────────────────────────

  addFrame(content: string, opts?: { injection_id?: string; pinned?: boolean }): string {
    const id = randomUUID();
    this.body.push({
      id,
      content,
      timestamp: Date.now() / 1000,
      injection_id: opts?.injection_id,
      pinned: opts?.pinned ?? false,
    });
    this.checkCapacity();
    return id;
  }

  removeFrame(id: string): boolean {
    const idx = this.body.findIndex((f) => f.id === id);
    if (idx === -1 || this.body[idx].pinned) return false;
    this.body.splice(idx, 1);
    return true;
  }

  /** Remove all body frames created by a given injection */
  removeByInjectionId(injectionId: string): number {
    const toRemove = this.body.filter(
      (f) => f.injection_id === injectionId && !f.pinned
    );
    toRemove.forEach((f) => this.removeFrame(f.id));
    if (toRemove.length > 0) {
      this.bus?.emit("injection.removed", { injection_id: injectionId });
    }
    return toRemove.length;
  }

  getBody(): ContextFrame[] {
    return [...this.body];
  }

  pinFrame(id: string): void {
    const frame = this.body.find((f) => f.id === id);
    if (frame) frame.pinned = true;
  }

  bodyTokens(): number {
    return Math.ceil(this.body.reduce((sum, f) => sum + f.content.length, 0) / 4);
  }

  estimateTokens(): { count: number; ratio: number } {
    const totalChars = this.buildHeadPrompt().length +
      this.body.reduce((sum, f) => sum + f.content.length, 0);
    const estimate = Math.ceil(totalChars / 4);
    return { count: estimate, ratio: estimate / this.config.max_tokens };
  }

  /**
   * Build messages for the external LLM API.
   * This is the ONLY place that assigns roles — at the API boundary.
   * Head → system. Body → single chronological text block (as user, since
   * the OpenAI protocol requires a role — but the content speaks for itself).
   */
  buildMessages(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    const head = this.buildHeadPrompt();
    if (head) msgs.push({ role: "system", content: head });

    if (this.body.length > 0) {
      const text = this.body.map((f) => f.content).join("\n\n");
      msgs.push({ role: "user", content: text });
    }
    return msgs;
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
