import type { Block } from "./types.js";

/**
 * Page — 广播空间
 *
 * 维护一个有序的 Block 序列，为每个消费者 module 维护一个读取指针。
 * 当所有消费者都已越过某些 block 时，自动从头部清理以防止内存溢出。
 */
export class Page {
  readonly id: string;
  private blocks: Block[] = [];
  private pointers: Map<string, number> = new Map();

  constructor(id: string) {
    this.id = id;
  }

  /** 注册新消费者，初始指针指向当前末尾（不会收到历史 block） */
  registerConsumer(moduleId: string): void {
    if (this.pointers.has(moduleId)) return;
    this.pointers.set(moduleId, this.blocks.length);
  }

  /** 注销消费者，注销后触发 prune */
  unregisterConsumer(moduleId: string): void {
    this.pointers.delete(moduleId);
    this.autoPrune();
  }

  /** 追加 block，然后自动 prune */
  append(block: Block): void {
    this.blocks.push(block);
    this.autoPrune();
  }

  /** 返回该消费者指针之后的所有 block，并移动指针到末尾 */
  consume(moduleId: string): Block[] {
    const ptr = this.pointers.get(moduleId);
    if (ptr === undefined) return [];

    const result = this.blocks.slice(ptr);
    this.pointers.set(moduleId, this.blocks.length);
    this.autoPrune();
    return result;
  }

  /** 当前 block 数量 */
  get blockCount(): number {
    return this.blocks.length;
  }

  /** 当前已注册的消费者 id 列表 */
  get consumers(): string[] {
    return [...this.pointers.keys()];
  }

  /**
   * 自动清理：所有消费者指针都已越过的 block 从头部移除。
   * 如果没有注册任何消费者，则清理全部 block。
   */
  private autoPrune(): void {
    if (this.pointers.size === 0) {
      // 没有消费者时，所有 block 都可以清理
      this.blocks.length = 0;
      return;
    }

    let minPtr = Infinity;
    for (const ptr of this.pointers.values()) {
      if (ptr < minPtr) minPtr = ptr;
    }

    if (minPtr > 0) {
      this.blocks.splice(0, minPtr);
      for (const [id, ptr] of this.pointers) {
        this.pointers.set(id, ptr - minPtr);
      }
    }
  }
}
