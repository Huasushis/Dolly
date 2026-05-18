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
  storagePath: string;
  setSystemPrompt(text: string): void;
  /** Persist arbitrary state to <storagePath>/save.json */
  saveState(data: Record<string, unknown>): void;
  /** Read previously saved state */
  loadState(): Record<string, unknown> | null;
}

export interface DollyModule {
  id: string;
  init?(ctx: ModuleContext): Promise<void>;
  onBlocksChanged?(ctx: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]>;
  systemPrompt?(ctx: ModuleContext): string;
  /** Called on daemon shutdown */
  onStop?(ctx: ModuleContext): Promise<void>;
  /** Called after profile restore on startup */
  onStart?(ctx: ModuleContext): Promise<void>;
  /** Handle CLI command: dolly <extName> <args...> */
  handleCli?(args: string[], ctx: ModuleContext): Promise<void>;
}
