import {
  defineExtension,
  type Module,
  type ModuleContext,
} from "../../src/core/legacy-in-process-extension.js";
import type { RawBlock, ExecuteInput, Block } from "../../src/core/types.js";
import * as lancedb from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import type { VectorQuery } from "@lancedb/lancedb";
import OpenAI from "openai";
import { MEMORY_DAILY_SUMMARY_PROMPT, MEMORY_EMOTION_ANNOTATION_PROMPT } from "./prompts.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface MemoryModuleConfig {
  /** Embedding provider config */
  embedding: {
    base_url: string;
    api_key: string;
    model: string;
    /** Embedding dimension (default: 1536 for text-embedding-3-small) */
    dim?: number;
  };
  /** Min text length to index (default: 5) */
  minTextLength?: number;
  /** Max memories to inject via premise (default: 5) */
  maxPremiseMemories?: number;
  /** Cleanup interval in hours (default: 24) */
  cleanupIntervalHours?: number;
  /** Custom premise overrides */
  premise?: { input?: string; output?: string };

  // ─── C2: In-day boost ─────────────────────────────────────────────────────
  /** Boost weight for memories created today (default: 0.2) */
  inDayBoost?: number;
  /** Hour that defines day boundary (default: 4 = 4:00 AM) */
  dayBoundaryHour?: number;

  // ─── C3: Context window ───────────────────────────────────────────────────
  /** Characters of surrounding context to return with search results (default: 500) */
  contextWindow?: number;

  // ─── C11: Injection balance (config only, logic TBD by experiments) ───────
  /** Minimum relevance score to inject a memory (default: 0.3) */
  injectionThreshold?: number;
  /** Maximum number of memories injected per premise call (default: 5) */
  maxInjections?: number;

  // ─── C9: Expired ID cleanup interval ──────────────────────────────────────
  /** Interval in hours for expired reference cleanup (default: 48) */
  expiredCleanupIntervalHours?: number;
}

interface MemoryRecord {
  [key: string]: unknown;
  id: string;
  text: string;
  vector: number[];
  source: string;
  timestamp: number;
  importance: number;
  access_count: number;
  last_access: number;
  /** C5: Emotion tag (8-label: joy/sadness/anger/fear/surprise/disgust/trust/neutral) */
  emotion?: string;
  /** C5: Emotion intensity 0.0-1.0 */
  emotionIntensity?: number;
  /** C4: Extracted keywords (comma-separated, populated by daily summary) */
  keys?: string;
  /** C9: Referenced forward block IDs (comma-separated) */
  forwardBlockIds?: string;
  /** C9: Referenced media IDs (comma-separated) */
  mediaIds?: string;
  /** C9: Whether references have been invalidated (0=valid, 1=invalidated) */
  refsInvalidated?: number;
}

/** C3: Search result with surrounding context */
interface MemorySearchResult {
  record: MemoryRecord;
  /** Surrounding context text (up to contextWindow chars) */
  context?: string;
  /** Computed relevance score after boosts */
  score?: number;
}

/** C6: mskill data structure (interface only, full flow depends on LLM/B-part) */
interface MSkill {
  name: string;
  description: string;
  content: string;
  usageCount: number;
  lastUsed: number;
}

// ─── Extension Definition ────────────────────────────────────────────────────

export default defineExtension({
  name: "memory",
  version: "0.2.0",
  description: "Memory management with vector search, hybrid retrieval, and contextual injection",
  createModule({ id, config }) {
    return new MemoryModule(id, config as MemoryModuleConfig);
  },
});

// ─── Memory Module ───────────────────────────────────────────────────────────

class MemoryModule implements Module {
  id: string;
  private config: MemoryModuleConfig;
  private ctx: ModuleContext | null = null;
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private embeddingClient: OpenAI | null = null;
  private pendingBlocks: Block[] = [];
  private processing = false;
  private lastCleanup = 0;
  private lastExpiredCleanup = 0;
  private embeddingDim: number;
    private embeddingModel: string = "text-embedding-v3";

  /** C7b: Maintained thinking mode string, attached via getOutputPremise() */
  private thinkingMode: string = "";

  /** C1: Last query context for premise injection */
  private lastQueryContext: string = "";
  /** C1: Cached injection text from background search */
  private cachedInjection: string = "";
  private lastInjectionTime = 0;
  private injectionSearchPending = false;

  constructor(id: string, config: MemoryModuleConfig) {
    this.id = id;
    this.config = config;
    this.embeddingDim = config.embedding?.dim ?? 1536;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async init(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Initialize LanceDB
    const dbPath = `${ctx.storagePath}/memory.lance`;
    this.db = await lancedb.connect(dbPath);

    // Create or open table
    const tables = await this.db.tableNames();
    if (tables.includes("memories")) {
      this.table = await this.db.openTable("memories");
    } else {
      this.table = await this.db.createTable("memories", [
        this.createSeedRecord(),
      ]);
      await this.table.delete("id = '__seed__'");
    }

    // Create FTS index on text column (for hybrid search)
    try {
      await this.table.createIndex("text", {
        config: Index.fts({ baseTokenizer: "simple" }),
        replace: true,
      });
    } catch {
      // FTS index may already exist or fail on empty table — non-fatal
    }

    // Initialize embedding client (optional - skip if not configured)
    if (this.config.embedding?.base_url) {
      this.embeddingClient = new OpenAI({
        baseURL: this.config.embedding.base_url,
        apiKey: this.config.embedding.api_key,
      });
      this.embeddingModel = this.config.embedding.model || "text-embedding-v3";
      ctx.logger.info("Memory embedding client initialized", { model: this.embeddingModel });
    } else {
      ctx.logger.warn("Memory module running without embedding client (embedding config missing)");
    }

    ctx.logger.info("Memory module initialized");
  }

  async execute(input: ExecuteInput): Promise<RawBlock | null> {
    // 1. Queue new blocks (filter self-produced to prevent self-matching)
    for (const block of input.blocks) {
      if (block.source !== this.id) {
        this.pendingBlocks.push(block);
      }
    }

    // 2. C1: Update query context from incoming blocks (for premise injection)
    this.updateQueryContext(input.blocks);

    // 3. C8: Process queue in background (fire-and-forget, non-blocking)
    if (!this.processing && this.pendingBlocks.length > 0) {
      this.processQueue();
    }

    // 4. Periodic cleanup (decay-based)
    const cleanupIntervalMs = (this.config.cleanupIntervalHours ?? 24) * 3600000;
    if (Date.now() - this.lastCleanup > cleanupIntervalMs) {
      this.cleanup();
      this.lastCleanup = Date.now();
    }

    // 5. C9: Periodic expired ID cleanup
    const expiredIntervalMs = (this.config.expiredCleanupIntervalHours ?? 48) * 3600000;
    if (Date.now() - this.lastExpiredCleanup > expiredIntervalMs) {
      this.cleanupExpiredReferences();
      this.lastExpiredCleanup = Date.now();
    }

    // Memory module does not produce blocks directly
    return null;
  }

  async onStop(): Promise<void> {
    if (this.processing) {
      await this.drainQueue();
    }
    this.ctx?.logger.info("Memory module stopped");
  }

  // ─── Premise (C1: Memory Injection + C7b: Thinking Mode) ────────────────

  getInputPremise(): string {
    return (
      this.config.premise?.input ??
      "I receive conversation blocks for memory indexing and retrieval."
    );
  }

  /**
   * C1: getOutputPremise dynamically attaches retrieved memories.
   * Background search populates cachedInjection; this method reads it synchronously.
   * C7b: Also appends the maintained thinking mode string.
   */
  getOutputPremise(): string {
    const base =
      this.config.premise?.output ??
      "I store and retrieve conversation memories with vector + full-text hybrid search.";

    const parts: string[] = [base];

    // C7b: Attach thinking mode if present
    if (this.thinkingMode) {
      parts.push(`\n[思维模式]\n${this.thinkingMode}`);
    }

    // C1: Attach cached memory injection
    if (this.cachedInjection) {
      parts.push(`\n[相关记忆]\n${this.cachedInjection}`);
    }

    return parts.join("");
  }

  // ─── C1: Active Recall ──────────────────────────────────────────────────

  /**
   * C1 方式二: Active recall — triggered via content convention {type: "recall", query: "..."}.
   * Returns formatted memory results as a RawBlock.
   */
  async handleRecallRequest(query: string): Promise<RawBlock | null> {
    const results = await this.searchMemoriesWithContext(query);
    if (results.length === 0) return null;

    const text = results
      .map((r) => {
        let entry = `- [${new Date(r.record.timestamp).toISOString()}] ${r.record.text}`;
        if (r.context) entry += `\n  上下文: ${r.context}`;
        return entry;
      })
      .join("\n");

    return {
      description: `Memory recall: ${query.slice(0, 50)}`,
      source: this.id,
      content: [{ type: "text", text: `[记忆召回结果]\n${text}` }],
      tensity: 0.3,
    };
  }

  // ─── C1: Background Injection Search ────────────────────────────────────

  private updateQueryContext(blocks: Block[]): void {
    const texts: string[] = [];
    for (const block of blocks) {
      if (block.source === this.id) continue;
      for (const item of block.content) {
        if (item && typeof item === "object" && item.type === "text" && item.text) {
          texts.push(item.text as string);
        }
      }
    }
    if (texts.length > 0) {
      this.lastQueryContext = texts.join(" ").slice(0, 500);
      this.triggerInjectionSearch();
    }
  }

  /**
   * C1 + C11: Background search for premise injection.
   * Rate-limited and controlled by injectionThreshold/maxInjections config.
   */
  private triggerInjectionSearch(): void {
    if (this.injectionSearchPending || !this.lastQueryContext) return;
    // Rate limit: at most once per 5 seconds
    if (Date.now() - this.lastInjectionTime < 5000) return;

    this.injectionSearchPending = true;
    const maxInjections = this.config.maxInjections ?? 5;

    this.searchMemoriesWithContext(this.lastQueryContext, maxInjections)
      .then((results) => {
        const threshold = this.config.injectionThreshold ?? 0.3;
        const filtered = results
          .filter((r) => (r.score ?? 0) >= threshold)
          .slice(0, maxInjections);

        if (filtered.length > 0) {
          this.cachedInjection = filtered
            .map((r) => {
              let line = `- ${r.record.text}`;
              if (r.context) line += ` (上下文: ${r.context.slice(0, 100)}...)`;
              return line;
            })
            .join("\n");
        } else {
          this.cachedInjection = "";
        }
        this.lastInjectionTime = Date.now();
      })
      .catch(() => { /* Non-fatal */ })
      .finally(() => {
        this.injectionSearchPending = false;
      });
  }

  // ─── C8: Background Processing (Non-blocking) ───────────────────────────

  /**
   * C8: execute() only enqueues and returns immediately.
   * Vectorization, indexing happen outside the call cycle.
   * Multimedia not persistently stored — only text kept in DB.
   */
  private async processQueue(): Promise<void> {
    this.processing = true;
    try {
      while (this.pendingBlocks.length > 0) {
        const block = this.pendingBlocks.shift()!;
        await this.indexBlock(block);
      }
    } catch (err) {
      this.ctx?.logger.error(`Memory processing error: ${err}`);
    } finally {
      this.processing = false;
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.processing) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ─── Indexing ────────────────────────────────────────────────────────────

  private async indexBlock(block: Block): Promise<void> {
    const text = this.extractText(block);
    const minLen = this.config.minTextLength ?? 5;
    if (!text || text.length < minLen) return;

    const vector = await this.getEmbedding(text);
    if (!vector) return;

    const importance = this.estimateImportance(block.tensity, text);
    const { forwardBlockIds, mediaIds } = this.extractReferencedIds(block);

    const record: MemoryRecord = {
      id: block.id,
      text,
      vector,
      source: block.source,
      timestamp: block.timestamp,
      importance,
      access_count: 0,
      last_access: Date.now(),
      keys: "",
      forwardBlockIds: forwardBlockIds || undefined,
      mediaIds: mediaIds || undefined,
      refsInvalidated: 0,
    };

    await this.table!.add([record]);
  }

  /** Extract text from block. C8: media discarded, only text stored. */
  private extractText(block: Block): string {
    const parts: string[] = [];
    for (const item of block.content) {
      if (item && typeof item === "object" && item.type === "text" && item.text) {
        parts.push(item.text as string);
      }
    }
    if (block.description) {
      parts.push(block.description);
    }
    return parts.join(" ");
  }

  /** C9: Extract forward block IDs and media IDs from block content. */
  private extractReferencedIds(block: Block): { forwardBlockIds: string; mediaIds: string } {
    const blockIds: string[] = [];
    const mIds: string[] = [];
    for (const item of block.content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "forward" && item.blockId) blockIds.push(item.blockId);
      if ((item.type === "image" || item.type === "audio" || item.type === "video") && item.mediaId) {
        mIds.push(item.mediaId);
      }
    }
    return { forwardBlockIds: blockIds.join(","), mediaIds: mIds.join(",") };
  }

  private estimateImportance(tensity: number, text: string): number {
    let score = tensity;
    const decisionWords = ["决定", "选择", "确认", "important", "decide", "must", "conclusion"];
    const emotionWords = ["开心", "难过", "愤怒", "happy", "sad", "angry", "love", "hate"];
    for (const w of decisionWords) {
      if (text.includes(w)) { score = Math.max(score, 0.7); break; }
    }
    for (const w of emotionWords) {
      if (text.includes(w)) { score = Math.max(score, 0.8); break; }
    }
    return Math.min(Math.max(score, 0), 1);
  }

  // ─── Embedding ───────────────────────────────────────────────────────────

  private async getEmbedding(text: string): Promise<number[] | null> {
    try {
      const response = await this.embeddingClient!.embeddings.create({
        model: this.config.embedding.model,
        input: text.slice(0, 8000),
      });
      return response.data[0].embedding;
    } catch (err) {
      this.ctx?.logger.warn(`Embedding failed: ${err}`);
      return null;
    }
  }

  // ─── Hybrid Search (Vector + BM25 + RRF + C2 InDay Boost) ───────────────

  /**
   * Search memories with hybrid search.
   * C2: Applies inDayBoost for memories created after today's day boundary.
   */
  async searchMemories(query: string, limit: number = 5): Promise<MemoryRecord[]> {
    const vector = await this.getEmbedding(query);
    if (!vector) return [];

    const rowCount = await this.table!.countRows();
    if (rowCount === 0) return [];

    let rawResults: MemoryRecord[] = [];

    try {
      const rrfReranker = await lancedb.rerankers.RRFReranker.create(60);
      const queryBuilder = this.table!.query().nearestTo(vector) as VectorQuery;
      queryBuilder.fullTextSearch(query);
      queryBuilder.rerank(rrfReranker);
      queryBuilder.limit(limit * 3); // Fetch extra for boost re-ranking

      for await (const batch of queryBuilder) {
        for (const row of batch) {
          rawResults.push(this.rowToRecord(row));
        }
      }
    } catch {
      rawResults = await this.vectorSearchRaw(vector, limit * 3);
    }

    // C2: Apply in-day boost and re-rank
    const scored = this.applyInDayBoost(rawResults);
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const results = scored.slice(0, limit).map((s) => s.record);

    // Update access metadata (fire-and-forget, C10: positive feedback)
    this.updateAccessMetadata(results);
    return results;
  }

  /** C2: Apply in-day boost to search results. */
  private applyInDayBoost(records: MemoryRecord[]): MemorySearchResult[] {
    const inDayBoost = this.config.inDayBoost ?? 0.2;
    const dayBoundaryHour = this.config.dayBoundaryHour ?? 4;
    const dayStart = this.getDayBoundaryTimestamp(Date.now(), dayBoundaryHour);

    return records.map((record, index) => {
      // Base score from rank position
      let score = 1 - index / (records.length + 1);
      // C2: In-day boost
      if (record.timestamp >= dayStart) {
        score += inDayBoost;
      }
      return { record, score };
    });
  }

  /** C2: Get timestamp for today's day boundary (e.g., 4:00 AM). */
  private getDayBoundaryTimestamp(now: number, boundaryHour: number): number {
    const date = new Date(now);
    const boundary = new Date(date);
    boundary.setHours(boundaryHour, 0, 0, 0);
    if (date.getHours() < boundaryHour) {
      boundary.setDate(boundary.getDate() - 1);
    }
    return boundary.getTime();
  }

  // ─── C3: Search with Context Window ─────────────────────────────────────

  /** C3: Search and return surrounding context for each result. */
  async searchMemoriesWithContext(query: string, limit: number = 5): Promise<MemorySearchResult[]> {
    const vector = await this.getEmbedding(query);
    if (!vector) return [];

    const rowCount = await this.table!.countRows();
    if (rowCount === 0) return [];

    let rawResults: MemoryRecord[] = [];
    try {
      const rrfReranker = await lancedb.rerankers.RRFReranker.create(60);
      const queryBuilder = this.table!.query().nearestTo(vector) as VectorQuery;
      queryBuilder.fullTextSearch(query);
      queryBuilder.rerank(rrfReranker);
      queryBuilder.limit(limit * 3);
      for await (const batch of queryBuilder) {
        for (const row of batch) {
          rawResults.push(this.rowToRecord(row));
        }
      }
    } catch {
      rawResults = await this.vectorSearchRaw(vector, limit * 3);
    }

    const scored = this.applyInDayBoost(rawResults);
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const top = scored.slice(0, limit);

    const contextWindow = this.config.contextWindow ?? 500;
    const results: MemorySearchResult[] = [];
    for (const item of top) {
      const context = await this.getSurroundingContext(item.record, contextWindow);
      results.push({ record: item.record, context, score: item.score });
    }

    this.updateAccessMetadata(results.map((r) => r.record));
    return results;
  }

  /**
   * C3: Get surrounding context by expanding temporally in both directions
   * until contextWindow character budget is exhausted.
   */
  private async getSurroundingContext(record: MemoryRecord, contextWindow: number): Promise<string> {
    if (!this.table || contextWindow <= 0) return "";

    try {
      const timeRange = 3600000; // 1 hour each direction
      const before: MemoryRecord[] = [];
      const after: MemoryRecord[] = [];

      const beforeQuery = this.table!.query()
        .where(`timestamp >= ${record.timestamp - timeRange} AND timestamp < ${record.timestamp}`)
        .limit(20);
      for await (const batch of beforeQuery) {
        for (const row of batch) before.push(this.rowToRecord(row));
      }

      const afterQuery = this.table!.query()
        .where(`timestamp > ${record.timestamp} AND timestamp <= ${record.timestamp + timeRange}`)
        .limit(20);
      for await (const batch of afterQuery) {
        for (const row of batch) after.push(this.rowToRecord(row));
      }

      before.sort((a, b) => b.timestamp - a.timestamp); // closest first
      after.sort((a, b) => a.timestamp - b.timestamp);

      let accumulated = record.text.length;
      const contextParts: string[] = [];
      let bi = 0, ai = 0;

      while (accumulated < contextWindow && (bi < before.length || ai < after.length)) {
        if (bi < before.length && (ai >= after.length || bi <= ai)) {
          const text = before[bi].text;
          if (accumulated + text.length > contextWindow) {
            contextParts.unshift("..." + text.slice(text.length - (contextWindow - accumulated)));
            accumulated = contextWindow;
          } else {
            contextParts.unshift(text);
            accumulated += text.length;
          }
          bi++;
        } else if (ai < after.length) {
          const text = after[ai].text;
          if (accumulated + text.length > contextWindow) {
            contextParts.push(text.slice(0, contextWindow - accumulated) + "...");
            accumulated = contextWindow;
          } else {
            contextParts.push(text);
            accumulated += text.length;
          }
          ai++;
        }
      }

      return contextParts.join(" ");
    } catch {
      return "";
    }
  }

  /** Vector-only search fallback. */
  private async vectorSearchRaw(vector: number[], limit: number): Promise<MemoryRecord[]> {
    try {
      const results: MemoryRecord[] = [];
      const queryBuilder = this.table!.vectorSearch(vector).limit(limit);
      for await (const batch of queryBuilder) {
        for (const row of batch) results.push(this.rowToRecord(row));
      }
      return results;
    } catch (err) {
      this.ctx?.logger.warn(`Vector search failed: ${err}`);
      return [];
    }
  }

  private rowToRecord(row: Record<string, unknown>): MemoryRecord {
    return {
      id: row["id"] as string,
      text: row["text"] as string,
      vector: row["vector"] as number[],
      source: row["source"] as string,
      timestamp: Number(row["timestamp"]),
      importance: Number(row["importance"]),
      access_count: Number(row["access_count"]),
      last_access: Number(row["last_access"]),
      emotion: (row["emotion"] as string) || undefined,
      emotionIntensity: row["emotionIntensity"] ? Number(row["emotionIntensity"]) : undefined,
      keys: (row["keys"] as string) || undefined,
      forwardBlockIds: (row["forwardBlockIds"] as string) || undefined,
      mediaIds: (row["mediaIds"] as string) || undefined,
      refsInvalidated: row["refsInvalidated"] ? Number(row["refsInvalidated"]) : 0,
    };
  }

  /** C10: Update access_count (positive feedback for cleanup half-life). */
  private updateAccessMetadata(records: MemoryRecord[]): void {
    if (!this.table || records.length === 0) return;
    const now = Date.now();
    for (const record of records) {
      this.table!.update({
        values: { access_count: String(record.access_count + 1), last_access: String(now) },
        where: `id = '${record.id}'`,
      }).catch(() => { /* Non-fatal */ });
    }
  }

  // ─── Memory Cleanup (Decay-based, C10: access_count in half-life) ───────

  private async cleanup(): Promise<void> {
    if (!this.table) return;
    this.ctx?.logger.info("Memory cleanup triggered");

    try {
      const now = Date.now();
      const cutoffTimestamp = now - 14 * 86400000;

      const candidates: MemoryRecord[] = [];
      const queryBuilder = this.table!.query()
        .where(`timestamp < ${cutoffTimestamp} AND importance < 0.8`)
        .limit(1000);
      for await (const batch of queryBuilder) {
        for (const row of batch) candidates.push(this.rowToRecord(row));
      }

      const toDelete: string[] = [];
      for (const record of candidates) {
        const ageDays = (now - record.timestamp) / 86400000;
        // C10: access_count extends half-life (positive feedback)
        const halfLife = 7 * (1 + Math.log2(1 + record.access_count)) * (1 + record.importance);
        const retentionScore = Math.pow(2, -ageDays / halfLife);
        if (retentionScore < 0.05 && record.importance < 0.3 && ageDays > 14) {
          toDelete.push(record.id);
        }
      }

      if (toDelete.length > 0) {
        const batchSize = 100;
        for (let i = 0; i < toDelete.length; i += batchSize) {
          const batch = toDelete.slice(i, i + batchSize);
          const predicate = batch.map((id) => `id = '${id}'`).join(" OR ");
          await this.table!.delete(predicate);
        }
        this.ctx?.logger.info(`Cleaned up ${toDelete.length} stale memories`);
      }
    } catch (err) {
      this.ctx?.logger.warn(`Memory cleanup failed: ${err}`);
    }
  }

  // ─── C9: Expired Reference Cleanup ──────────────────────────────────────

  /**
   * C9: Scan memories for forwardBlockId/mediaId that no longer exist.
   * Marks invalidated (does NOT delete the memory itself).
   */
  private async cleanupExpiredReferences(): Promise<void> {
    if (!this.table || !this.ctx) return;
    this.ctx.logger.info("Expired reference cleanup triggered");

    try {
      const withRefs: MemoryRecord[] = [];
      const queryBuilder = this.table!.query()
        .where("(forwardBlockIds != '' OR mediaIds != '') AND refsInvalidated = 0")
        .limit(500);
      for await (const batch of queryBuilder) {
        for (const row of batch) withRefs.push(this.rowToRecord(row));
      }

      let invalidatedCount = 0;
      for (const record of withRefs) {
        let expired = false;

        if (record.forwardBlockIds) {
          for (const blockId of record.forwardBlockIds.split(",").filter(Boolean)) {
            if (!this.ctx.blocks.get(blockId)) { expired = true; break; }
          }
        }

        if (!expired && record.mediaIds) {
          for (const mediaId of record.mediaIds.split(",").filter(Boolean)) {
            try { await this.ctx.media.get(mediaId, "url"); }
            catch { expired = true; break; }
          }
        }

        if (expired) {
          await this.table!.update({
            values: { refsInvalidated: "1" },
            where: `id = '${record.id}'`,
          });
          invalidatedCount++;
        }
      }

      if (invalidatedCount > 0) {
        this.ctx.logger.info(`Marked ${invalidatedCount} memories with expired references`);
      }
    } catch (err) {
      this.ctx?.logger.warn(`Expired reference cleanup failed: ${err}`);
    }
  }

  // ─── C5: Emotion Annotation (LLM-based, uses prompt) ────────────────────

  /**
   * C5: Annotate emotion for a text using MEMORY_EMOTION_ANNOTATION_PROMPT.
   * 8-label set: joy/sadness/anger/fear/surprise/disgust/trust/neutral.
   * Requires ctx.llm to be available; returns null otherwise.
   */
  async annotateEmotion(text: string): Promise<{ emotion: string; intensity: number } | null> {
    if (!this.ctx?.llm) return null;
    try {
      const prompt = MEMORY_EMOTION_ANNOTATION_PROMPT + text;
      const result = await this.ctx.llm.chat([{ role: "user", content: prompt }]);
      const content = typeof result === "string" ? result : result?.content ?? "{}";
      const parsed = JSON.parse(content);
      if (parsed.emotion && typeof parsed.intensity === "number") {
        return { emotion: parsed.emotion, intensity: parsed.intensity };
      }
    } catch { /* Non-fatal */ }
    return null;
  }

  // ─── C4: Key Extraction (Interface Only) ────────────────────────────────

  /**
   * C4: Extract keys for a memory record during daily summary.
   * Uses MEMORY_DAILY_SUMMARY_PROMPT when LLM available.
   * TODO: Full implementation pending spec finalization.
   */
  async extractKeysForRecord(_recordId: string): Promise<string[]> {
    // TODO: Implement with LLM using MEMORY_DAILY_SUMMARY_PROMPT
    // 1. Fetch record text
    // 2. Call LLM with daily summary prompt
    // 3. Parse keys from response
    // 4. Store keys back to record
    return [];
  }

  /**
   * C4: Find associated memories via shared keys.
   * TODO: Implement MMR-style diversification for serendipity.
   */
  async findAssociations(keys: string[], limit: number = 5): Promise<MemoryRecord[]> {
    if (!this.table || keys.length === 0) return [];
    try {
      const keyCondition = keys.map((k) => `keys LIKE '%${k}%'`).join(" OR ");
      const results: MemoryRecord[] = [];
      const queryBuilder = this.table!.query().where(keyCondition).limit(limit);
      for await (const batch of queryBuilder) {
        for (const row of batch) results.push(this.rowToRecord(row));
      }
      return results;
    } catch {
      return [];
    }
  }

  // ─── C6: mskill Generation (Interface + Storage Path Only) ──────────────

  /** C6: Storage path for mskills */
  private get mskillPath(): string {
    return `${this.ctx?.storagePath ?? "."}/mskills.json`;
  }

  /**
   * C6: Generate an mskill from conversation patterns.
   * TODO: Full flow requires LLM calls (depends on B-part).
   */
  async generateMSkill(_name: string, _description: string, _content: string): Promise<MSkill> {
    // TODO: Use LLM to refine mskill content, persist to mskillPath
    return { name: _name, description: _description, content: _content, usageCount: 0, lastUsed: Date.now() };
  }

  /** C6: Retrieve stored mskills. TODO: Implement persistent storage. */
  async getMSkills(): Promise<MSkill[]> {
    // TODO: Load from mskillPath
    return [];
  }

  // ─── C7: Abstract Pattern Matching ──────────────────────────────────────
  // TODO: Implement abstract pattern detection across memories.
  // Direction: embedding clustering + LLM summarization to find recurring themes.
  // Not implemented — pending research spec.

  // ─── C7b: Thinking Mode Maintenance ─────────────────────────────────────

  /** C7b: Update thinking mode string (attached to getOutputPremise). */
  async updateThinkingMode(summary?: string): Promise<void> {
    if (summary) this.thinkingMode = summary;
  }

  /** C7b: Get current thinking mode. */
  getThinkingMode(): string {
    return this.thinkingMode;
  }

  /**
   * C7b: Daily refresh interface.
   * TODO: Aggregate recent memories with MEMORY_DAILY_SUMMARY_PROMPT, update thinkingMode.
   */
  async dailyThinkingRefresh(): Promise<void> {
    // TODO: Call LLM with MEMORY_DAILY_SUMMARY_PROMPT + recent conversations
    // Parse summary field → this.thinkingMode
    // Parse keys field → store to respective records
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private createSeedRecord(): MemoryRecord {
    return {
      id: "__seed__",
      text: "",
      vector: new Array(this.embeddingDim).fill(0),
      source: "",
      timestamp: 0,
      importance: 0,
      access_count: 0,
      last_access: 0,
      emotion: "",
      emotionIntensity: 0,
      keys: "",
      forwardBlockIds: "",
      mediaIds: "",
      refsInvalidated: 0,
    };
  }
}
