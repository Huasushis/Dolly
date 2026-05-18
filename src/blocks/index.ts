import { randomUUID } from "crypto";

/** Framework-native block types: system (pinned prompt), inner (AI-internal), outer (external input) */
export const BlockType = {
  SYSTEM: "system",
  INNER: "inner",
  OUTER: "outer",
} as const;

export type BlockTypeKey = (typeof BlockType)[keyof typeof BlockType];

export interface Block {
  id: string;
  type: string;       // "system" | "inner" | "outer"
  content: string;
  meta: Record<string, unknown>;  // framework: pinned, source, decay_rate. extension: subtype, skill, tool, ...
  created: number;
}

export function createBlock(type: string, content: string, meta: Record<string, unknown> = {}): Block {
  return { id: randomUUID(), type, content, meta, created: Date.now() };
}

export interface BlockChange {
  type: "added" | "removed" | "modified";
  block: Block;
}

export type BlockMutation =
  | { action: "insert"; block: Omit<Block, "id">; priority: number }
  | { action: "delete"; blockId: string }
  | { action: "update"; blockId: string; content?: string; meta?: Record<string, unknown> };

export function serializeBlock(block: Block): string {
  const subtype = block.meta?.subtype ?? block.type;
  return `[ID:${block.id}][TYPE:${block.type}/${subtype}][TIME:${Math.floor(block.created / 1000)}]\n${block.content}`;
}
