import type { Block, BlockChange, BlockMutation } from "../blocks/index.js";
import { createBlock } from "../blocks/index.js";

interface LogEntry { op: string; detail: unknown; time: number; }

export interface ContextConfig {
  max_tokens: number;
  compression_threshold: number;
  decay_rate?: number;
  protect_window_min?: number;
  max_background_chars?: number;
}

const DEFAULT_DECAY = 0.1;       // per hour
const DEFAULT_PROTECT_MIN = 10;  // minutes

export class ContextManager {
  private systemPrompt = "";
  private background = "";
  private blocks: Block[] = [];
  private config: ContextConfig;
  private log: LogEntry[] = [];
  private changeQueue: BlockChange[] = [];
  private systemBlock: Block;

  constructor(config: ContextConfig) {
    this.config = config;
    this.systemBlock = createBlock("system", "", { pinned: true });
    this.blocks = [this.systemBlock];
  }

  setSystemPrompt(text: string): void {
    this.systemPrompt = text;
    this.systemBlock.content = text;
  }

  getBackground(): string { return this.background; }
  setBackground(text: string): void { this.background = text; }

  addBlock(type: string, content: string, meta: Record<string, unknown> = {}): Block {
    const block = createBlock(type, content, meta);
    this.blocks.push(block);
    this.log.push({ op: "insert", detail: { type, content: content.slice(0, 200) }, time: Date.now() });
    this.changeQueue.push({ type: "added", block });
    return block;
  }

  removeBlock(id: string): boolean {
    if (id === this.systemBlock.id) return false;
    const idx = this.blocks.findIndex((b) => b.id === id);
    if (idx === -1) return false;
    const [removed] = this.blocks.splice(idx, 1);
    this.log.push({ op: "delete", detail: { id, type: removed.type }, time: Date.now() });
    this.changeQueue.push({ type: "removed", block: removed });
    return true;
  }

  updateBlock(id: string, content?: string, meta?: Record<string, unknown>): boolean {
    const b = this.blocks.find((x) => x.id === id);
    if (!b) return false;
    if (content !== undefined) b.content = content;
    if (meta !== undefined) b.meta = { ...b.meta, ...meta };
    this.changeQueue.push({ type: "modified", block: b });
    return true;
  }

  getBlocks(): Block[] { return [...this.blocks]; }
  getBlock(id: string): Block | undefined { return this.blocks.find((b) => b.id === id); }

  applyMutations(mutations: BlockMutation[]): BlockChange[] {
    const inserts = mutations.filter((m) => m.action === "insert").sort((a: any, b: any) => a.priority - b.priority);
    for (const m of inserts) {
      if (m.action === "insert") this.addBlock(m.block.type, m.block.content, m.block.meta);
    }
    for (const m of mutations) {
      if (m.action === "delete") this.removeBlock(m.blockId);
      if (m.action === "update") this.updateBlock(m.blockId, (m as any).content, (m as any).meta);
    }
    this.decayCheck();
    const changes = [...this.changeQueue];
    this.changeQueue = [];
    return changes;
  }

  estimateTokens(): number {
    return Math.ceil((this.systemPrompt.length + this.background.length +
      this.blocks.reduce((s, b) => s + b.content.length, 0)) / 4);
  }

  getLog(): LogEntry[] { return [...this.log]; }

  /** Exponential decay forget — one block per call */
  private decayCheck(): void {
    const maxT = this.config.max_tokens;
    const threshold = this.config.compression_threshold;
    if (this.estimateTokens() <= maxT * threshold) return;

    const now = Date.now();
    const protectMs = (this.config.protect_window_min ?? DEFAULT_PROTECT_MIN) * 60 * 1000;
    const defaultRate = this.config.decay_rate ?? DEFAULT_DECAY;

    const candidates: Array<{ block: Block; prob: number }> = [];
    for (const b of this.blocks) {
      if (b.type === "system" || b.meta?.pinned) continue;
      const ageMs = now - b.created;
      if (ageMs < protectMs) continue;
      const rate = (b.meta?.decay_rate as number) ?? defaultRate;
      const ageHours = ageMs / 3600000;
      const p = 1 - Math.exp(-rate * ageHours);
      if (p > 0.001) candidates.push({ block: b, prob: p });
    }

    if (candidates.length === 0) return;

    // Weighted random pick one
    const total = candidates.reduce((s, c) => s + c.prob, 0);
    let r = Math.random() * total;
    for (const c of candidates) {
      r -= c.prob;
      if (r <= 0) { this.removeBlock(c.block.id); break; }
    }
  }
}
