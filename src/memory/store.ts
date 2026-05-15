import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from "fs";
import { resolve } from "path";
import type { Block } from "../blocks/index.js";
import { LLMClient } from "../core/llm-client.js";
import { tokenize, tfVector, cosineSimilarity, extractKeywords } from "./nlp.js";

export interface DaySummary {
  day: string;
  emotion: string;           // Step 1: emotional reflection
  emotionKeywords: string[];
  emotionWeight: number;
  lessons: string;           // Step 2: lessons learned
  lessonsKeywords: string[];
  summary: string;           // Step 3: overall summary
  keywords: string[];        // combined (emotion + lessons + summary)
  weight: number;            // emotional weight
}

export interface RecallResult {
  day: string;
  summary: string;           // the full summary text
  segments: string[];        // drill-down raw log segments
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

  /** 三步总结。fullDay=true 凌晨全量，false 只做增量 */
  async summarize(blocks: Block[], fullDay = false): Promise<DaySummary | null> {
    const day = new Date().toISOString().slice(0, 10);
    const existing = this.summaries.find((s) => s.day === day);
    if (!fullDay && existing) return null;

    const text = blocks.map((b) => `[${b.type}] ${b.content.slice(0, 200)}`).join("\n");
    const maxChars = 10000;
    const logSlice = text.length > maxChars ? text.slice(-maxChars) : text;

    // ── Step 1: 情绪反思 ──
    const thinkPrompt = `回顾你今天经历过的以下片段。反思：哪些让你情绪波动强烈？极度高兴、十分悲伤、非常愤怒、强烈好奇——无论正面负面，只要印象深刻就值得记住。用 2-3 句内心独白反思。然后给出 0.1-1.0 的情绪强度（越高越深刻，不分正负）和 3-5 个情绪关键词。

格式：
think: <反思>
weight: <数字>
mood: <关键词,逗号分隔>

日志：
${logSlice}`;

    const thinkResp = await this.summarizeClient.chat([{ role: "user", content: thinkPrompt }]);
    const thinkMatch = thinkResp.match(/think:\s*([\s\S]+?)(?=\nweight:|\nmood:|$)/);
    const weightMatch = thinkResp.match(/weight:\s*([\d.]+)/);
    const moodMatch = thinkResp.match(/mood:\s*([\s\S]+?)$/);
    const emotion = thinkMatch?.[1]?.trim() ?? thinkResp.slice(0, 300);
    const weight = Math.min(1, Math.max(0.1, parseFloat(weightMatch?.[1] ?? "0.5")));
    const moodStr = moodMatch?.[1]?.trim() ?? "";
    const emotionKeywords = moodStr.split(/[,，\s]+/).filter((k) => k.length > 0).slice(0, 5);

    // ── Step 2: 收获与教训 ──
    const lessonsPrompt = `回顾今天：你是否学到了令你欣喜的新东西？或者遭受了令人难受的教训？有没有让你"啊哈！"的瞬间，或者让你后悔、警醒的事？

列出 3-5 个关键词，并用一段话描述这些收获/教训——不要只列关键词，要讲清楚它们之间的关联和来龙去脉。

格式：
lessons: <一段话描述收获与教训>
keywords: <关键词,逗号分隔>

日志：
${logSlice}`;

    const lessonsResp = await this.summarizeClient.chat([{ role: "user", content: lessonsPrompt }]);
    const lessonsMatch = lessonsResp.match(/lessons:\s*([\s\S]+?)(?=\nkeywords:|$)/);
    const lessonsKwMatch = lessonsResp.match(/keywords:\s*([\s\S]+?)$/);
    const lessons = lessonsMatch?.[1]?.trim() ?? lessonsResp.slice(0, 300);
    const lessonsKwStr = lessonsKwMatch?.[1]?.trim() ?? "";
    const lessonsKeywords = lessonsKwStr.split(/[,，\s]+/).filter((k) => k.length > 0).slice(0, 5);

    // ── Step 3: 总体总结 ──
    const summaryPrompt = existing
      ? `你今天已经有了一段总结：\n${existing.summary}\n\n补充新的经历。把新旧合并为一段完整的总结。融合你的情绪感受和收获教训。\n\n情绪：${emotion}\n收获与教训：${lessons}\n\n新日志：\n${logSlice}`
      : `基于你的情绪反思和收获教训，用一段话总结今天。不要列清单——融合事实、情绪感受和成长体会。\n\n情绪：${emotion}\n收获与教训：${lessons}\n\n日志：\n${logSlice}`;

    const resp = await this.summarizeClient.chat([{ role: "user", content: summaryPrompt }]);
    const summary = resp.trim();
    if (!summary || summary.length < 20) return null;

    const allKeywords = [...new Set([
      ...emotionKeywords,
      ...lessonsKeywords,
      ...extractKeywords(summary, 8),
    ])].slice(0, 15);

    const entry: DaySummary = {
      day, emotion, emotionKeywords, emotionWeight: weight,
      lessons, lessonsKeywords,
      summary, keywords: allKeywords, weight,
    };

    if (existing) {
      this.summaries[this.summaries.indexOf(existing)] = entry;
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

    const segSize = 10;
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

  /** 搜索 → 钻取 → 返回总结+片段 */
  recall(query: string, maxDays = 3, maxSegments = 3): RecallResult[] {
    const days = this.search(query, maxDays);
    const results: RecallResult[] = [];
    for (const d of days) {
      results.push({
        day: d.day,
        summary: d.summary,
        segments: this.drill(d.day, query, maxSegments),
      });
    }
    return results;
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
