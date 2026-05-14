import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from "fs";
import { resolve } from "path";
import type { Block } from "../blocks/index.js";
import { LLMClient } from "../core/llm-client.js";
import { tokenize, tfVector, cosineSimilarity, extractKeywords } from "./nlp.js";

/** 每日总结 */
export interface DaySummary {
  day: string;
  summary: string;
  keywords: string[];
  weight: number;
}

export class MemoryStore {
  private indexPath: string; private entriesDir: string; private dailyDir: string;
  private index = new Map<string, string[]>(); // keyword → day[]
  private summaries: DaySummary[] = [];

  constructor(basePath: string, private summarizeClient: LLMClient) {
    this.indexPath = resolve(basePath, "index.json");
    this.entriesDir = resolve(basePath, "entries");
    this.dailyDir = resolve(basePath, "daily");
    for (const d of [basePath, this.entriesDir, this.dailyDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }
    this._load();
  }

  appendLog(op: string, detail: unknown): void {
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(resolve(this.dailyDir, `${day}.jsonl`), JSON.stringify({ op, detail, time: Date.now() }) + "\n");
  }

  /** 将一天总结为一段话。fullDay=true 凌晨全量覆盖，false 只总结增量 */
  async summarize(blocks: Block[], fullDay = false): Promise<DaySummary | null> {
    const day = new Date().toISOString().slice(0, 10);
    const existing = this.summaries.find((s) => s.day === day);

    // 空闲总结：如果今天已有且不是全量模式，跳过
    if (!fullDay && existing) return null;

    const text = blocks.map((b) => `[${b.type}] ${b.content.slice(0, 300)}`).join("\n");
    const logSlice = text.slice(-10000);

    // Step 1: Think — reflect on emotional significance
    const thinkPrompt = `回顾你今天经历的以下片段。思考：哪些让你感到兴奋、好奇、困惑、满足？哪些值得记住？用 2-3 句内心独白反思。然后给出一个 0.1-1.0 的情绪权重（越高越深刻）和 3-5 个情绪关键词。\n\n格式：\nthink: <反思>\nweight: <数字>\nmood: <关键词,逗号分隔>\n\n日志：\n${logSlice}`;

    const thinkResp = await this.summarizeClient.chat([{ role: "user", content: thinkPrompt }]);
    const thinkMatch = thinkResp.match(/think:\s*(.+)/);
    const weightMatch = thinkResp.match(/weight:\s*([\d.]+)/);
    const moodMatch = thinkResp.match(/mood:\s*(.+)/);
    const reflection = thinkMatch?.[1]?.trim() ?? "";
    const weight = Math.min(1, Math.max(0.1, parseFloat(weightMatch?.[1] ?? "0.5")));
    const mood = moodMatch?.[1]?.trim() ?? "";

    // Step 2: Summarize with emotional context
    const summaryPrompt = existing
      ? `你今天已经有了一段总结：\n${existing.summary}\n\n${reflection ? `你的反思：${reflection}\n` : ""}补充新的经历。把新旧合并为一段完整的总结。融入你的情绪感受。\n\n新日志：\n${logSlice}`
      : `${reflection ? `你的反思：${reflection}\n` : ""}基于以上反思，用一段话总结今天。不要列清单——融合事实和情绪感受。\n\n日志：\n${logSlice}`;

    const resp = await this.summarizeClient.chat([{ role: "user", content: summaryPrompt }]);
    const summary = resp.trim();
    if (!summary || summary.length < 20) return null;

    const moodKeywords = mood.split(/[,，\s]+/).filter((k) => k.length > 0);
    const keywords = [...new Set([...extractKeywords(summary, 8), ...moodKeywords])].slice(0, 12);
    const entry: DaySummary = { day, summary, keywords, weight };

    if (existing) {
      // 替换旧条目
      const idx = this.summaries.indexOf(existing);
      this.summaries[idx] = entry;
    } else {
      this.summaries.push(entry);
    }
    this._store(entry);
    return entry;
  }

  /** 匹配查询到具体的天 */
  search(query: string, topK = 5): DaySummary[] {
    const queryTokens = tokenize(query);
    const queryVec = tfVector(queryTokens);
    const scored: Array<{ day: string; score: number }> = [];

    for (const s of this.summaries) {
      const entryVec = tfVector(tokenize(s.summary + " " + s.keywords.join(" ")));
      let score = cosineSimilarity(queryVec, entryVec);
      score *= (0.5 + s.weight);
      if (score > 0.01) scored.push({ day: s.day, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((sc) => this.summaries.find((s) => s.day === sc.day)!)
      .filter(Boolean);
  }

  /** 钻进某天的原始日志，提取与查询最相关的片段 */
  drill(day: string, query: string, maxSegments = 3, segmentChars = 500): string[] {
    const logPath = resolve(this.dailyDir, `${day}.jsonl`);
    if (!existsSync(logPath)) return [];

    const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    const queryVec = tfVector(tokenize(query));

    // 把日志分成段落（每 N 行一段），计算与查询的相关度
    const segSize = 10; // lines per segment
    const scored: Array<{ text: string; score: number }> = [];

    for (let i = 0; i < lines.length; i += segSize) {
      const chunk = lines.slice(i, i + segSize);
      const text = chunk.map((l) => {
        try { const p = JSON.parse(l); return p.detail?.content ?? p.detail ?? ""; } catch { return l.slice(0, 200); }
      }).filter(Boolean).join("\n").slice(0, segmentChars * 3);

      if (text.length < 20) continue;

      const segVec = tfVector(tokenize(text));
      const score = cosineSimilarity(queryVec, segVec);
      if (score > 0.01) scored.push({ text: text.slice(0, segmentChars), score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSegments)
      .map((s) => s.text);
  }

  /** 搜索 → 钻取 → 返回相关文本片段 */
  recall(query: string, maxDays = 3, maxSegments = 3): string[] {
    const days = this.search(query, maxDays);
    const segments: string[] = [];
    for (const d of days) {
      segments.push(...this.drill(d.day, query, maxSegments));
    }
    return segments.slice(0, maxSegments * 2);
  }

  hasEntriesForToday(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    return this.summaries.some((s) => s.day === today);
  }

  private _store(s: DaySummary) {
    writeFileSync(resolve(this.entriesDir, `${s.day}.json`), JSON.stringify(s, null, 2));
    for (const kw of s.keywords) {
      const days = this.index.get(kw) ?? [];
      if (!days.includes(s.day)) days.push(s.day);
      this.index.set(kw, days);
    }
    writeFileSync(this.indexPath, JSON.stringify(Object.fromEntries(this.index), null, 2));
  }

  private _load() {
    if (existsSync(this.indexPath)) {
      try { this.index = new Map(Object.entries(JSON.parse(readFileSync(this.indexPath, "utf-8")))); } catch {}
    }
    if (existsSync(this.entriesDir)) {
      for (const f of readdirSync(this.entriesDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const s: DaySummary = JSON.parse(readFileSync(resolve(this.entriesDir, f), "utf-8"));
          if (s.day && s.summary) this.summaries.push(s);
        } catch {}
      }
    }
  }
}
