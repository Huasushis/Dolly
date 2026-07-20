import { defineExtension } from "../../src/sdk/index.js";
import type { Module, ModuleContext } from "../../src/sdk/types.js";
import type { RawBlock, ExecuteInput, Block } from "../../src/core/types.js";
import * as lancedb from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import type { VectorQuery } from "@lancedb/lancedb";
import OpenAI from "openai";

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
}

// ─── Extension Definition ────────────────────────────────────────────────────

export default defineExtension({
  name: "memory",
  version: "0.1.0",
  description: "Memory management with vector search and hybrid retrieval",
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
  private embeddingDim: number;

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
      // Remove seed record
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

    // Initialize embedding client
    this.embeddingClient = new OpenAI({
      baseURL: this.config.embedding.base_url,
      apiKey: this.config.embedding.api_key,
    });

    ctx.logger.info("Memory module initialized");
  }

  async execute(input: ExecuteInput): Promise<RawBlock | null> {
    // 1. Queue new blocks (filter self-produced to prevent self-matching)
    for (const block of input.blocks) {
      if (block.source !== this.id) {
        this.pendingBlocks.push(block);
      }
    }

    // 2. Process queue in background (fire-and-forget, non-blocking)
    if (!this.processing && this.pendingBlocks.length > 0) {
      this.processQueue();
    }

    // 3. Periodic cleanup
    const cleanupIntervalMs = (this.config.cleanupIntervalHours ?? 24) * 3600000;
    if (Date.now() - this.lastCleanup > cleanupIntervalMs) {
      this.cleanup();
      this.lastCleanup = Date.now();
    }

    // Memory module does not produce blocks directly
    return null;
  }

  async onStop(): Promise<void> {
    // Wait for any pending processing to finish
    if (this.processing) {
      await this.drainQueue();
    }
    this.ctx?.logger.info("Memory module stopped");
  }

  // ─── Premise ─────────────────────────────────────────────────────────────

  getInputPremise(): string {
    return (
      this.config.premise?.input ??
      "I receive conversation blocks for memory indexing and retrieval."
    );
  }

  getOutputPremise(): string {
    const base =
      this.config.premise?.output ??
      "I store and retrieve conversation memories with vector + full-text hybrid search. Related memories are injected below for context.";
    return base;
  }

  // ─── Background Processing ───────────────────────────────────────────────

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

    const record: MemoryRecord = {
      id: block.id,
      text,
      vector,
      source: block.source,
      timestamp: block.timestamp,
      importance,
      access_count: 0,
      last_access: Date.now(),
    };

    await this.table!.add([record]);
  }

  /**
   * Extract text content from a block.
   * Concatenates all text items from the content array.
   */
  private extractText(block: Block): string {
    const parts: string[] = [];
    for (const item of block.content) {
      if (item && typeof item === "object" && item.type === "text" && item.text) {
        parts.push(item.text as string);
      }
    }
    // Also include description as contextual text
    if (block.description) {
      parts.push(block.description);
    }
    return parts.join(" ");
  }

  /**
   * Estimate importance (0-1) from tensity and text features.
   *
   * Reference tensity ranges:
   *   闲聊/日常: 0.1-0.2, 事实/知识: 0.3-0.5, 偏好/习惯: 0.4-0.6
   *   决策/结论: 0.6-0.8, 情感/重大事件: 0.8-1.0, 核心身份: 0.9-1.0
   */
  private estimateImportance(tensity: number, text: string): number {
    // Start from tensity as baseline
    let score = tensity;

    // Boost for decision/emotion keywords
    const decisionWords = ["决定", "选择", "确认", "important", "decide", "must", "conclusion"];
    const emotionWords = ["开心", "难过", "愤怒", "happy", "sad", "angry", "love", "hate"];

    for (const w of decisionWords) {
      if (text.includes(w)) {
        score = Math.max(score, 0.7);
        break;
      }
    }
    for (const w of emotionWords) {
      if (text.includes(w)) {
        score = Math.max(score, 0.8);
        break;
      }
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

  // ─── Hybrid Search (Vector + BM25 + RRF) ─────────────────────────────────

  /**
   * Search memories using hybrid search (vector similarity + full-text BM25 + RRF reranking).
   * Falls back to vector-only search if FTS fails.
   */
  async searchMemories(query: string, limit: number = 5): Promise<MemoryRecord[]> {
    const vector = await this.getEmbedding(query);
    if (!vector) return [];

    const rowCount = await this.table!.countRows();
    if (rowCount === 0) return [];

    try {
      // Attempt hybrid search with RRF reranking
      const rrfReranker = await lancedb.rerankers.RRFReranker.create(60);
      const queryBuilder = this.table!.query().nearestTo(vector) as VectorQuery;
      queryBuilder.fullTextSearch(query);
      queryBuilder.rerank(rrfReranker);
      queryBuilder.limit(limit);

      const results: MemoryRecord[] = [];
      for await (const batch of queryBuilder) {
        for (const row of batch) {
          results.push(this.rowToRecord(row));
        }
      }

      // Update access metadata (fire-and-forget)
      this.updateAccessMetadata(results);

      return results;
    } catch {
      // Fallback: vector-only search
      return this.vectorSearch(vector, limit);
    }
  }

  /**
   * Vector-only search fallback.
   */
  private async vectorSearch(vector: number[], limit: number): Promise<MemoryRecord[]> {
    try {
      const results: MemoryRecord[] = [];
      const queryBuilder = this.table!.vectorSearch(vector).limit(limit);

      for await (const batch of queryBuilder) {
        for (const row of batch) {
          results.push(this.rowToRecord(row));
        }
      }

      this.updateAccessMetadata(results);
      return results;
    } catch (err) {
      this.ctx?.logger.warn(`Vector search failed: ${err}`);
      return [];
    }
  }

  /**
   * Convert an Arrow record row to a MemoryRecord.
   */
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
    };
  }

  /**
   * Update access_count and last_access for retrieved records (fire-and-forget).
   * TODO: batch update for efficiency
   */
  private updateAccessMetadata(records: MemoryRecord[]): void {
    if (!this.table || records.length === 0) return;

    const now = Date.now();
    for (const record of records) {
      this.table!
        .update(
          {
            values: {
              access_count: String(record.access_count + 1),
              last_access: String(now),
            },
            where: `id = '${record.id}'`,
          },
        )
        .catch(() => {
          // Non-fatal: metadata update failure
        });
    }
  }

  // ─── Memory Cleanup (Decay-based) ────────────────────────────────────────

  /**
   * Clean up stale/irrelevant memories based on decay formula.
   *
   * Decay formula: halfLife = 7 * (1 + log2(1 + accessCount)) * (1 + importance) days
   * Retention score: 2^(-age_days / halfLife)
   *
   * Cleanup conditions (all must be true):
   *   - retentionScore < 0.05
   *   - importance < 0.3
   *   - age > 14 days
   *
   * High importance memories (importance > 0.8) are never auto-cleaned.
   */
  private async cleanup(): Promise<void> {
    if (!this.table) return;

    this.ctx?.logger.info("Memory cleanup triggered");

    try {
      const now = Date.now();
      const fourteenDaysMs = 14 * 86400000;
      const cutoffTimestamp = now - fourteenDaysMs;

      // Query candidates: older than 14 days and not high importance
      const candidates: MemoryRecord[] = [];
      const queryBuilder = this.table!
        .query()
        .where(`timestamp < ${cutoffTimestamp} AND importance < 0.8`)
        .limit(1000);

      for await (const batch of queryBuilder) {
        for (const row of batch) {
          candidates.push(this.rowToRecord(row));
        }
      }

      const toDelete: string[] = [];

      for (const record of candidates) {
        const ageDays = (now - record.timestamp) / 86400000;
        const halfLife =
          7 * (1 + Math.log2(1 + record.access_count)) * (1 + record.importance);
        const retentionScore = Math.pow(2, -ageDays / halfLife);

        // Cleanup if low retention AND low importance AND old enough
        if (retentionScore < 0.05 && record.importance < 0.3 && ageDays > 14) {
          toDelete.push(record.id);
        }
      }

      if (toDelete.length > 0) {
        // Delete in batches
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

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Create a seed record to define the table schema.
   * This record is immediately deleted after table creation.
   */
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
    };
  }
}

// ─── TODO (future versions) ──────────────────────────────────────────────────
// - Daily summary: aggregate daily conversations into summary memories
// - mskill generation: extract reusable skills from conversation patterns
// - Abstract pattern matching: detect recurring themes and behavioral patterns
// - DashScope native embedding adapter: support qwen3-vl-embedding via DashScope API
// - Chinese tokenizer: improve FTS quality for Chinese text
// - Batch metadata updates: optimize access_count/last_access updates
