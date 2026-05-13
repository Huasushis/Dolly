import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { resolve } from "path";
import type { Block } from "../blocks/index.js";
import { LLMClient } from "../core/llm-client.js";

export interface MemoryEntry { id: string; content: string; keywords: string[]; source_day: string; created_at: number; }

export class MemoryStore {
  private indexPath: string; private entriesDir: string; private dailyDir: string;
  private index = new Map<string, string[]>(); private cache = new Map<string, MemoryEntry>();

  constructor(basePath: string, private summarizeClient: LLMClient) {
    this.indexPath = resolve(basePath, "index.json");
    this.entriesDir = resolve(basePath, "entries");
    this.dailyDir = resolve(basePath, "daily");
    for (const d of [basePath, this.entriesDir, this.dailyDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }
    if (existsSync(this.indexPath)) {
      try { this.index = new Map(Object.entries(JSON.parse(readFileSync(this.indexPath, "utf-8")))); } catch {}
    }
  }

  /** Append to daily log (JSONL) */
  appendLog(op: string, detail: unknown): void {
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(resolve(this.dailyDir, `${day}.jsonl`), JSON.stringify({ op, detail, time: Date.now() }) + "\n");
  }

  /** Summarize blocks into memory entries */
  async summarize(blocks: Block[]): Promise<MemoryEntry[]> {
    const text = blocks.map((b) => `[${b.type}] ${b.content}`).join("\n\n");
    const day = new Date().toISOString().slice(0, 10);
    const prompt = `你是一个记忆整理助手。从以下日志提取重要信息点。对每条输出一行 JSON：{"content":"信息","keywords":["k1","k2"]}\n\n${text.slice(-16000)}`;
    const resp = await this.summarizeClient.chat([{ role: "user", content: prompt }]);
    const entries: MemoryEntry[] = [];
    for (const line of resp.split("\n")) {
      try {
        const p = JSON.parse(line.trim());
        if (p.content && p.keywords) {
          const e: MemoryEntry = { id: `lte_${day}_${entries.length}`, content: p.content, keywords: p.keywords, source_day: day, created_at: Date.now() };
          entries.push(e); this._store(e);
        }
      } catch {}
    }
    return entries;
  }

  search(query: string, topK = 5): MemoryEntry[] {
    const tokens = query.toLowerCase().split(/\s+/);
    const scored = new Map<string, number>();
    for (const [kw, ids] of this.index) {
      for (const t of tokens) {
        if (kw.toLowerCase().includes(t)) for (const id of ids) scored.set(id, (scored.get(id) ?? 0) + 1);
      }
    }
    return [...scored].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([id]) => this._get(id)).filter(Boolean) as MemoryEntry[];
  }

  private _store(e: MemoryEntry) {
    writeFileSync(resolve(this.entriesDir, `${e.id}.json`), JSON.stringify(e, null, 2));
    for (const kw of e.keywords) { const ids = this.index.get(kw) ?? []; ids.push(e.id); this.index.set(kw, ids); }
    this.cache.set(e.id, e);
    writeFileSync(this.indexPath, JSON.stringify(Object.fromEntries(this.index), null, 2));
  }

  private _get(id: string): MemoryEntry | undefined {
    if (this.cache.has(id)) return this.cache.get(id);
    const p = resolve(this.entriesDir, `${id}.json`);
    if (!existsSync(p)) return undefined;
    try { const e: MemoryEntry = JSON.parse(readFileSync(p, "utf-8")); this.cache.set(id, e); return e; } catch { return undefined; }
  }
}
