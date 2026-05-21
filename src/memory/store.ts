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

    const LOG_FORMAT = `日志格式：[outer]=用户输入，[inner]=你的回复/记忆注入。所有[inner]内容（含[记忆]标记）也属于已有信息。**严格禁止编造。** 任何情绪描述（如"感到温暖""心里一震"）必须有原文依据——如果日志里用户只说"今天下雨"，你不能写成"他今天心情很低落"。事实是事实，情绪是情绪，不能混淆。`;

    // ── Step 1: 关键事实（谁说了什么，有什么重要信息）──
    const thinkPrompt = `${LOG_FORMAT}\n\n提取今天对话中用户分享的关键信息：人名、密码、偏好、事件。只提取[outer]中确实出现的内容。\n\n格式：\nfacts: <一句话>\nweight: <0.1-1.0>\nkeywords: <词,词,词>\n\n日志：\n${logSlice}`;

    const thinkResp = await this.summarizeClient.chat([{ role: "user", content: thinkPrompt }]);
    process.stderr.write(`[summarize:1] ${thinkResp.slice(0, 100)}\n`);
    const factsMatch = thinkResp.match(/facts:\s*([\s\S]+?)(?=\nweight:|\nkeywords:|$)/);
    const weightMatch = thinkResp.match(/weight:\s*([\d.]+)/);
    const kwMatch = thinkResp.match(/keywords:\s*([\s\S]+?)$/);
    const facts = factsMatch?.[1]?.trim() ?? thinkResp.slice(0, 300);
    const weight = Math.min(1, Math.max(0.1, parseFloat(weightMatch?.[1] ?? "0.5")));
    const factsKwStr = kwMatch?.[1]?.trim() ?? "";
    const factsKeywords = factsKwStr.split(/[,，\s]+/).filter((k) => k.length > 0).slice(0, 5);

    // ── Step 2: 了解到的信息（你从对话中知道了什么新东西）──
    const lessonsPrompt = `${LOG_FORMAT}\n\n从今天的对话中，关于对方你了解到了哪些新信息？总结成一段话。\n\n格式：\nlessons: <一段话>\nkeywords: <词,词,词>\n\n日志：\n${logSlice}`;

    const lessonsResp = await this.summarizeClient.chat([{ role: "user", content: lessonsPrompt }]);
    process.stderr.write(`[summarize:2] ${lessonsResp.slice(0, 100)}\n`);
    const lessonsMatch = lessonsResp.match(/lessons:\s*([\s\S]+?)(?=\nkeywords:|$)/);
    const kw2Match = lessonsResp.match(/keywords:\s*([\s\S]+?)$/);
    const lessons = lessonsMatch?.[1]?.trim() ?? lessonsResp.slice(0, 300);
    const lessonsKwStr = kw2Match?.[1]?.trim() ?? "";
    const lessonsKeywords = lessonsKwStr.split(/[,，\s]+/).filter((k) => k.length > 0).slice(0, 5);

    // ── Step 3: 摘要（合并事实+了解到信息，一段话）──
    const summaryPrompt = existing
      ? `已有摘要：${existing.summary}\n\n合并新内容，更新为一段新摘要。\n关键事实：${facts}\n了解到：${lessons}\n新日志：\n${logSlice}`
      : `用一段话总结今天。包含关键事实和了解到的信息。\n关键事实：${facts}\n了解到：${lessons}\n日志：\n${logSlice}`;

    const resp = await this.summarizeClient.chat([{ role: "user", content: summaryPrompt }]);
    process.stderr.write(`[summarize:3] ${resp.slice(0, 100)}\n`);
    const summary = resp.trim();
    if (!summary || summary.length < 20) return null;

    const allKeywords = [...new Set([
      ...factsKeywords,
      ...lessonsKeywords,
      ...extractKeywords(summary, 8),
    ])].slice(0, 15);

    const entry: DaySummary = {
      day, emotion: facts, emotionKeywords: factsKeywords, emotionWeight: weight,
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
      if (score > 0.08) scored.push({ day: s.day, score });
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
      if (score > 0.05) scored.push({ text: text.slice(0, segmentChars), score });
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
