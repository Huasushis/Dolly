export type {
  Module,
  ModuleContext,
  MediaAccess,
  BlockAccess,
  LLMClient,
  CliCommandSpec,
  DollyExtension,
  ExtensionMetadata,
} from "./types.js";

export type { Block, RawBlock, ExecuteInput, PremiseCollection, Rect } from "../core/types.js";

import type { DollyExtension } from "./types.js";

/** 类型安全的 extension 定义辅助函数 */
export function defineExtension(spec: DollyExtension): DollyExtension {
  return spec;
}
