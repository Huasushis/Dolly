import { randomUUID } from "crypto";
import type { Block } from "./types.js";
import type { MediaManager } from "./media.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 小时
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000; // 60 秒

/**
 * 从 Block content 中提取 mediaId 引用
 * 约定：content 项若有 `_mediaId` 字段则视为 media 引用
 */
function extractMediaIds(content: any[]): string[] {
  const ids: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && typeof item._mediaId === "string") {
      ids.push(item._mediaId);
    }
  }
  return ids;
}

/**
 * 从 Block content 中提取 forward block 引用
 * 约定：content 项若有 `_forwardBlockId` 字段则视为 forward 引用
 */
function extractForwardBlockIds(content: any[]): string[] {
  const ids: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && typeof item._forwardBlockId === "string") {
      ids.push(item._forwardBlockId);
    }
  }
  return ids;
}

export interface BlockManagerOptions {
  ttlMs?: number;
  cleanupIntervalMs?: number;
}

export class BlockManager {
  private blocks = new Map<string, Block>();
  private refCounts = new Map<string, number>();
  private mediaManager: MediaManager;
  private ttlMs: number;
  private cleanupIntervalMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(mediaManager: MediaManager, options?: BlockManagerOptions) {
    this.mediaManager = mediaManager;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.cleanupIntervalMs = options?.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
  }

  /**
   * 生成新的 Block ID（去掉横线的 UUID hex）
   */
  static generateId(): string {
    return randomUUID().replace(/-/g, "");
  }

  /**
   * 注册新 block
   * - 建立 id→block 映射
   * - 校验 forward 引用的 block 是否存在且时间戳更早
   */
  register(block: Block): void {
    // forward 校验
    const forwardIds = extractForwardBlockIds(block.content);
    for (const fid of forwardIds) {
      const referenced = this.blocks.get(fid);
      if (!referenced) {
        throw new Error(`Forward reference to unknown block: ${fid}`);
      }
      if (referenced.timestamp >= block.timestamp) {
        throw new Error(
          `Forward reference timestamp violation: block ${block.id} (${block.timestamp}) ` +
          `references block ${fid} (${referenced.timestamp}) which is not earlier`
        );
      }
    }

    this.blocks.set(block.id, block);
    this.refCounts.set(block.id, 0);

    // 增加被引用 media 的计数
    for (const mediaId of extractMediaIds(block.content)) {
      this.mediaManager.acquire(mediaId);
    }

    // 增加被 forward 的 block 的计数
    for (const fid of forwardIds) {
      const current = this.refCounts.get(fid) ?? 0;
      this.refCounts.set(fid, current + 1);
    }
  }

  /**
   * 查询 block
   */
  get(id: string): Block | null {
    return this.blocks.get(id) ?? null;
  }

  /**
   * 增加引用计数
   */
  acquire(id: string): void {
    if (!this.blocks.has(id)) return;
    const current = this.refCounts.get(id) ?? 0;
    this.refCounts.set(id, current + 1);
  }

  /**
   * 减少引用计数
   */
  release(id: string): void {
    if (!this.blocks.has(id)) return;
    const current = this.refCounts.get(id) ?? 0;
    this.refCounts.set(id, Math.max(0, current - 1));
  }

  /**
   * 启动后台清理
   * 定期扫描 refCount === 0 且 age > TTL 的 block 进行回收
   */
  startCleanup(intervalMs?: number): void {
    if (this.cleanupTimer) return;
    const interval = intervalMs ?? this.cleanupIntervalMs;

    this.cleanupTimer = setInterval(() => {
      this.sweep();
    }, interval);
    this.cleanupTimer.unref?.();
  }

  /**
   * 停止后台清理
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 单次扫描清理
   */
  private sweep(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, block] of this.blocks) {
      const refCount = this.refCounts.get(id) ?? 0;
      const age = now - block.timestamp;
      if (refCount === 0 && age > this.ttlMs) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.evict(id);
    }
  }

  /**
   * 回收单个 block：移除映射，释放 media 和 forward 引用
   */
  private evict(id: string): void {
    const block = this.blocks.get(id);
    if (!block) return;

    // 释放 media 引用
    for (const mediaId of extractMediaIds(block.content)) {
      this.mediaManager.release(mediaId);
    }

    // 释放 forward block 引用
    for (const fid of extractForwardBlockIds(block.content)) {
      this.release(fid);
    }

    this.blocks.delete(id);
    this.refCounts.delete(id);
  }
}
