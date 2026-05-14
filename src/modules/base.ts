import type { Block, BlockChange, BlockMutation } from "../blocks/index.js";
import type { LockManager } from "../core/lock.js";

export interface ModuleContext {
  getBlocks(): Block[];
  getBlock(id: string): Block | undefined;
  estimateTokens(): number;
  config: Record<string, unknown>;
  emit(event: string, payload: unknown): void;
  log(op: string, detail: unknown): void;
  lock: LockManager;
  /** Extension 本地存储路径（可不存在，extension 自行创建） */
  storagePath: string;
}

export interface DollyModule {
  id: string;
  init?(ctx: ModuleContext): Promise<void>;
  onBlocksChanged?(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]>;
  systemPrompt?(ctx: ModuleContext): string;
}
