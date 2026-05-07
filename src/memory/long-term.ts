import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { resolve, basename } from "path";
import type { ContextFrame } from "../core/context.js";
import type { LLMConfig } from "../config.js";
import { LLMClient } from "../core/llm-client.js";

export interface LongTermMemoryEntry {
  id: string;
  content: string;
  keywords: string[];
  source_day: string;
  created_at: number;
}

export interface SearchResult {
  entry: LongTermMemoryEntry;
  score: number;
}

/**
 * Simple file-based long-term memory.
 * Storage layout: {path}/
 *   index.json          — keyword → entry_id[] mapping
 *   entries/
 *     {id}.json         — individual entry
 *   daily/
 *     {yyyy-mm-dd}.json — raw daily context log
 */
export class LongTermMemory {
  private indexPath: string;
  private entriesDir: string;
  private dailyDir: string;
  private index: Map<string, string[]> = new Map();
  private cache: Map<string, LongTermMemoryEntry> = new Map();
  private cacheHits: Map<string, number> = new Map(); // entry_id → access count
  private summarizeClient: LLMClient;

  constructor(
    basePath: string,
    auxConfig: LLMConfig
  ) {
    this.indexPath = resolve(basePath, "index.json");
    this.entriesDir = resolve(basePath, "entries");
    this.dailyDir = resolve(basePath, "daily");

    if (!existsSync(basePath)) mkdirSync(basePath, { recursive: true });
    if (!existsSync(this.entriesDir)) mkdirSync(this.entriesDir, { recursive: true });
    if (!existsSync(this.dailyDir)) mkdirSync(this.dailyDir, { recursive: true });

    this.loadIndex();
    this.summarizeClient = new LLMClient(auxConfig);
  }

  /** Archive a full day's context log */
  archiveDay(contextLog: ContextFrame[], date?: string): string {
    const day = date ?? new Date().toISOString().slice(0, 10);
    const dailyPath = resolve(this.dailyDir, `${day}.json`);
    writeFileSync(dailyPath, JSON.stringify(contextLog, null, 2), "utf-8");
    return dailyPath;
  }

  /** Use aux LLM to summarize daily log into memory entries */
  async summarize(rawLog: ContextFrame[]): Promise<LongTermMemoryEntry[]> {
    const logText = rawLog.map((f) => f.content).join("\n\n");
    const day = new Date().toISOString().slice(0, 10);

    const prompt = `你是一个记忆整理助手。以下是一天的对话日志，请从中提取重要的信息点。

对于每个重要信息点，输出一个 JSON 对象（每行一个）：
{"content": "信息内容", "keywords": ["关键词1", "关键词2"]}

对话日志：
${logText.slice(-16000)}`;

    const response = await this.summarizeClient.chat([
      { role: "user", content: prompt },
    ]);

    const entries: LongTermMemoryEntry[] = [];
    for (const line of response.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.content && parsed.keywords) {
          const entry: LongTermMemoryEntry = {
            id: `lte_${day}_${entries.length}`,
            content: parsed.content,
            keywords: parsed.keywords,
            source_day: day,
            created_at: Date.now() / 1000,
          };
          entries.push(entry);
          this.storeEntry(entry);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  /** Simple keyword search */
  search(query: string, topK = 5): SearchResult[] {
    const queryTokens = query.toLowerCase().split(/\s+/);
    const scored: Array<{ id: string; score: number }> = [];

    for (const [keyword, entryIds] of this.index) {
      const kwLower = keyword.toLowerCase();
      for (const qToken of queryTokens) {
        if (kwLower.includes(qToken) || qToken.includes(kwLower)) {
          for (const id of entryIds) {
            const existing = scored.find((s) => s.id === id);
            if (existing) {
              existing.score += 1;
            } else {
              scored.push({ id, score: 1 });
            }
          }
        }
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => {
        const entry = this.getEntry(s.id);
        return entry ? { entry, score: s.score } : null;
      })
      .filter((r): r is SearchResult => r !== null);
  }

  /** Search and format results as context for injection */
  injectRelevant(query: string, topK = 3): Array<{ content: string; id: string }> {
    const results = this.search(query, topK);
    return results.map((r) => {
      this.recordCacheHit(r.entry.id);
      return {
        id: `ltr_${r.entry.id}`,
        content: `[INJECTION:id:${r.entry.id}] 相关记忆 (来源: ${r.entry.source_day}): ${r.entry.content}`,
      };
    });
  }

  /** Cache management: promote frequently accessed entries */
  getPromotedEntries(threshold = 3): LongTermMemoryEntry[] {
    const promoted: LongTermMemoryEntry[] = [];
    for (const [id, count] of this.cacheHits) {
      if (count >= threshold) {
        const entry = this.getEntry(id);
        if (entry) promoted.push(entry);
      }
    }
    return promoted;
  }

  /** Reset cache hit counters for a new session */
  resetCacheHits(): void {
    this.cacheHits.clear();
  }

  private storeEntry(entry: LongTermMemoryEntry): void {
    // Save to disk
    const entryPath = resolve(this.entriesDir, `${entry.id}.json`);
    writeFileSync(entryPath, JSON.stringify(entry, null, 2), "utf-8");

    // Update index
    for (const keyword of entry.keywords) {
      const existing = this.index.get(keyword) ?? [];
      existing.push(entry.id);
      this.index.set(keyword, existing);
    }

    // Update cache
    this.cache.set(entry.id, entry);

    // Persist index
    this.saveIndex();
  }

  private getEntry(id: string): LongTermMemoryEntry | undefined {
    if (this.cache.has(id)) return this.cache.get(id);

    const entryPath = resolve(this.entriesDir, `${id}.json`);
    if (!existsSync(entryPath)) return undefined;

    try {
      const raw = readFileSync(entryPath, "utf-8");
      const entry: LongTermMemoryEntry = JSON.parse(raw);
      this.cache.set(id, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  private recordCacheHit(id: string): void {
    this.cacheHits.set(id, (this.cacheHits.get(id) ?? 0) + 1);
  }

  private loadIndex(): void {
    if (existsSync(this.indexPath)) {
      try {
        const raw = readFileSync(this.indexPath, "utf-8");
        const data = JSON.parse(raw);
        this.index = new Map(Object.entries(data));
      } catch {
        this.index = new Map();
      }
    }
  }

  private saveIndex(): void {
    const data = Object.fromEntries(this.index);
    writeFileSync(this.indexPath, JSON.stringify(data, null, 2), "utf-8");
  }
}
