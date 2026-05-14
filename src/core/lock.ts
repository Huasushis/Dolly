/** 锁管理器——防止多个模块同时触发耗时操作（如 LLM 调用） */

interface Waiter {
  moduleId: string;
  priority: number;
  resolve: (unlock: () => void) => void;
}

export class LockManager {
  private locked = false;
  private queue: Waiter[] = [];

  /** 申请锁。priority 越小越优先。返回释放函数 */
  async acquire(moduleId: string, priority: number): Promise<() => void> {
    if (!this.locked && this.queue.length === 0) {
      this.locked = true;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.queue.push({ moduleId, priority, resolve });
      this.queue.sort((a, b) => a.priority - b.priority);
    });
  }

  private release(): void {
    this.locked = false;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.locked = true;
      next.resolve(() => this.release());
    }
  }

  /** 当前是否被占用 */
  get isLocked(): boolean { return this.locked; }

  /** 队列长度 */
  get pending(): number { return this.queue.length; }
}
