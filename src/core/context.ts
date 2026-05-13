import type { Block, BlockChange, BlockMutation } from "../blocks/index.js";
import { createBlock } from "../blocks/index.js";

interface LogEntry { op: string; detail: unknown; time: number; }

export class ContextManager {
  private systemPrompt = "";
  private blocks: Block[] = [];
  private config: { max_tokens: number; compression_threshold: number };
  private log: LogEntry[] = [];
  private changeQueue: BlockChange[] = [];
  private systemBlock: Block;

  constructor(config: { max_tokens: number; compression_threshold: number }) {
    this.config = config;
    this.systemBlock = createBlock("system", "", { pinned: true });
    this.blocks = [this.systemBlock];
  }

  setSystemPrompt(text: string): void {
    this.systemPrompt = text;
    this.systemBlock.content = text;
  }

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
    const changes = [...this.changeQueue];
    this.changeQueue = [];
    return changes;
  }

  estimateTokens(): number { return Math.ceil(this.blocks.reduce((s, b) => s + b.content.length, 0) / 4); }
  getLog(): LogEntry[] { return [...this.log]; }
}
