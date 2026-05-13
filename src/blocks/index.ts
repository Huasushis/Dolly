import { randomUUID } from "crypto";

export const BlockType = {
  SYSTEM: "system", MESSAGE: "message", RESPONSE: "response",
  TOOL_CALL: "tool_call", TOOL_RESULT: "tool_result",
  INJECTION: "injection", SKILL: "skill", FORGET: "forget", LOG: "log",
} as const;

export type BlockTypeKey = (typeof BlockType)[keyof typeof BlockType];

export interface Block {
  id: string;
  type: string;
  content: string;
  meta: Record<string, unknown>;
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
  return `[ID:${block.id}][TYPE:${block.type}][TIME:${Math.floor(block.created / 1000)}]\n${block.content}`;
}
