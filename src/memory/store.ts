import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { resolve } from "path";
import type { Block } from "../blocks/index.js";
import { LLMClient } from "../core/llm-client.js";

export interface MemoryEntry {
  id: string; content: string; keywords: string[]; weight: number;
  source_day: string; position: number; created_at: number;
}

export class MemoryStore {
  private indexPath: string; private entriesDir: string; private dailyDir: string;
  private index = new Map<string, string[]>();
  private allEntries: MemoryEntry[] = [];

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
    // Load all entries into memory for search
    this._loadAll();
  }

  appendLog(op: string, detail: unknown): void {
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(resolve(this.dailyDir, `${day}.jsonl`), JSON.stringify({ op, detail, time: Date.now() }) + "\n");
  }

  /** Impression-based summarization */
  async summarize(blocks: Block[]): Promise<MemoryEntry[]> {
    const text = blocks.map((b, i) => `[${i}][${b.type}] ${b.content.slice(0, 300)}`).join("\n\n");
    const day = new Date().toISOString().slice(0, 10);
    const prompt = `回顾你今天的经历。从以下日志中提取你觉得印象深刻、值得记住的片段。不要总结用户需要什么——而是记录你自己经历的、学到的、有感触的。

对每个片段输出一行 JSON：
{"content":"我经历了什么/学到了什么","keywords":["关键词1","关键词2"],"weight":0.8}

weight: 1.0=非常重要, 0.5=一般, 0.1=不太重要。

日志：
${text.slice(-12000)}`;

    const resp = await this.summarizeClient.chat([{ role: "user", content: prompt }]);
    const entries: MemoryEntry[] = [];
    for (const line of resp.split("\n")) {
      try {
        const p = JSON.parse(line.trim());
        if (p.content && p.keywords) {
          const e: MemoryEntry = {
            id: `mem_${day}_${entries.length}`, content: p.content,
            keywords: p.keywords, weight: p.weight ?? 0.5,
            source_day: day, position: entries.length, created_at: Date.now(),
          };
          entries.push(e); this._store(e);
        }
      } catch {}
    }
    return entries;
  }

  /** Semantic-ish search: keyword overlap + fuzzy match */
  search(query: string, topK = 10): MemoryEntry[] {
    const tokens = query.toLowerCase().split(/[\s,，。]+/).filter((t) => t.length > 1);
    const scored = new Map<string, number>();

    for (const entry of this.allEntries) {
      let score = 0;
      const contentLower = entry.content.toLowerCase();
      for (const kw of entry.keywords) {
        const kwLower = kw.toLowerCase();
        // Exact keyword match
        for (const token of tokens) {
          if (kwLower.includes(token) || token.includes(kwLower)) score += 2;
        }
        // Content overlap
        if (contentLower.includes(kwLower)) score += 1;
      }
      // Token overlap with content
      for (const token of tokens) {
        if (contentLower.includes(token)) score += 0.5;
      }
      // Weight boost
      score *= (0.5 + entry.weight);
      if (score > 0) scored.set(entry.id, score);
    }

    return [...scored.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id]) => this._get(id))
      .filter(Boolean) as MemoryEntry[];
  }

  /** Randomly select one from top-K results for context injection */
  pickOne(query: string, topK = 5): MemoryEntry | null {
    const results = this.search(query, topK);
    if (results.length === 0) return null;
    return results[Math.floor(Math.random() * results.length)];
  }

  private _store(e: MemoryEntry) {
    writeFileSync(resolve(this.entriesDir, `${e.id}.json`), JSON.stringify(e, null, 2));
    for (const kw of e.keywords) { const ids = this.index.get(kw) ?? []; ids.push(e.id); this.index.set(kw, ids); }
    this.allEntries.push(e);
    writeFileSync(this.indexPath, JSON.stringify(Object.fromEntries(this.index), null, 2));
  }

  private _get(id: string): MemoryEntry | undefined {
    return this.allEntries.find((e) => e.id === id);
  }

  private _loadAll() {
    if (!existsSync(this.entriesDir)) return;
    const { readdirSync } = require("fs");
    for (const file of readdirSync(this.entriesDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const e: MemoryEntry = JSON.parse(readFileSync(resolve(this.entriesDir, file), "utf-8"));
        this.allEntries.push(e);
      } catch {}
    }
  }
}
