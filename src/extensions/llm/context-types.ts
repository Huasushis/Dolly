/**
 * Shared value types for the LLM extension's context assembly.
 *
 * Contract: `docs/spec/llm-extension.md` sections 3 and 5,
 * `docs/spec/core-runtime.md` section 7.3, and `docs/spec/block-payload.md`.
 *
 * The output of context assembly is provider-neutral: a message sequence whose
 * parts are exactly the `ChatPart` shape the model provider broker accepts.
 * Nothing here builds a provider request, opens a socket, reads Media bytes, or
 * touches a credential.
 *
 * Two invariants drive every type in this file:
 *
 * - assembly is a pure function of its inputs, so the same batch, descriptor
 *   snapshot, configuration, and history always yield byte-identical output; and
 * - the removable granule is a whole `ConversationUnit`, never an individual
 *   message, so eviction can never orphan half of a structurally paired
 *   exchange (see `docs/research/open-research-questions.md` section 4.4).
 */

import type { ChatPart } from "../../core/model-provider-chat.js";
import type { JsonValue } from "../../core/canonical-json.js";

export type ContextErrorCode =
  /** A configured limit is absent, non-integral, or too small to hold its own header. */
  | "CONTEXT_LIMIT_INVALID"
  /** The caller supplied a malformed assembly request (identity, schema version, unit shape). */
  | "CONTEXT_REQUEST_INVALID"
  /** A delivered Block claims `dolly.content/1` but does not validate against it. */
  | "CONTEXT_BLOCK_CONTENT_INVALID"
  /** The frozen descriptor does not declare a chat role this assembly needs. */
  | "CONTEXT_ROLE_UNSUPPORTED"
  /** The frozen descriptor does not accept text input at all. */
  | "CONTEXT_TEXT_UNSUPPORTED"
  /** The trusted system prompt alone exceeds its own budget. */
  | "CONTEXT_SYSTEM_PROMPT_TOO_LARGE"
  /** An adjacent Module description is duplicated or structurally invalid. */
  | "CONTEXT_DESCRIPTION_INVALID"
  /** A required modality is unavailable and the configured policy is `fail`. */
  | "CONTEXT_MEDIA_UNSUPPORTED"
  /** The current input batch cannot fit even after every evictable unit is gone. */
  | "CONTEXT_INPUT_DOES_NOT_FIT"
  /** A pluggable trim policy returned an order that is not a permutation of the evictable units. */
  | "CONTEXT_TRIM_POLICY_INVALID";

export class ContextAssemblyError extends Error {
  constructor(
    readonly code: ContextErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "ContextAssemblyError";
  }
}

/**
 * A bounded, content-free diagnostic. Notices carry identifiers and closed
 * reason codes only, so `docs/spec/llm-extension.md` section 11 (logs omit
 * prompt content) holds even when a caller logs the whole report.
 */
export type ContextNoticeCode =
  | "MEDIA_ATTACHED"
  | "MEDIA_NOT_ATTACHED"
  | "FORWARD_EXPANDED"
  | "FORWARD_OMITTED"
  | "DATA_ITEM_UNSUPPORTED"
  | "BLOCK_PAYLOAD_UNSUPPORTED"
  | "BLOCK_REPEATED"
  | "TEXT_TRUNCATED"
  | "DESCRIPTION_TRUNCATED"
  | "FENCE_TOKEN_REDACTED"
  | "UNIT_EVICTED";

export interface ContextNotice {
  readonly code: ContextNoticeCode;
  /** An identifier: Block, Media, unit, or Module. Never conversation content. */
  readonly subject: string;
  /** A closed reason token from this file's documented vocabulary. Never content. */
  readonly reason?: string;
}

export type ConversationRole = "system" | "user" | "assistant";

export interface AssembledMessage {
  readonly role: ConversationRole;
  readonly parts: readonly ChatPart[];
}

/**
 * The atomic removable granule of assembled context.
 *
 * `messages` is kept together or dropped together. A future tool round maps to
 * one unit holding the assistant call message and every terminal tool result,
 * which is why eviction is defined over units rather than messages.
 */
export type ConversationUnitKind =
  /** A Block delivered in the current claim. Never evictable. */
  | "input-block"
  /** A committed unit replayed from conversation state. Evictable. */
  | "history";

export interface ConversationUnit {
  readonly unitId: string;
  readonly kind: ConversationUnitKind;
  /** Block identifiers whose canonical content this unit already carries. */
  readonly blockIds: readonly string[];
  readonly messages: readonly AssembledMessage[];
}

/**
 * How many budget bytes a part costs.
 *
 * A media part costs a flat accounting proxy: the extension never sees the
 * bytes (the broker resolves them), so it cannot measure them, and a
 * provider-side token estimate is explicitly not a substitute for a hard byte
 * limit (`docs/spec/llm-extension.md` section 3.2). The real per-item and
 * aggregate media bytes are enforced by the descriptor's media requirements.
 */
export interface ContextCostModel {
  readonly messageOverheadBytes: number;
  readonly mediaPartBytes: number;
}

export const DEFAULT_COST_MODEL: ContextCostModel = Object.freeze({
  messageOverheadBytes: 8,
  mediaPartBytes: 1024,
});

export function partBytes(part: ChatPart, cost: ContextCostModel): number {
  return part.kind === "text"
    ? Buffer.byteLength(part.text, "utf8")
    : cost.mediaPartBytes;
}

export function messageBytes(message: AssembledMessage, cost: ContextCostModel): number {
  let total = cost.messageOverheadBytes + Buffer.byteLength(message.role, "utf8");
  for (const part of message.parts) total += partBytes(part, cost);
  return total;
}

export function measureMessages(
  messages: readonly AssembledMessage[],
  cost: ContextCostModel,
): { readonly bytes: number; readonly messageCount: number; readonly mediaParts: number } {
  let bytes = 0;
  let mediaParts = 0;
  for (const message of messages) {
    bytes += messageBytes(message, cost);
    for (const part of message.parts) if (part.kind === "media") mediaParts += 1;
  }
  return { bytes, messageCount: messages.length, mediaParts };
}

export function unitMessages(units: readonly ConversationUnit[]): readonly AssembledMessage[] {
  return units.flatMap((unit) => unit.messages);
}
