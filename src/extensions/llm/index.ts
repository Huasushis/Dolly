/**
 * Context assembly for the Dolly LLM extension.
 *
 * This package owns one question from `docs/spec/llm-extension.md`: how a
 * bounded Delivery batch, the committed conversation, and the deployment's
 * trusted policy become one provider-neutral request body. It owns nothing
 * else. The tool round state machine (section 8), provider dispatch and
 * streaming (sections 6 and 9.3), the turn journal (section 4.2), and
 * conversation persistence are separate work and are not implemented here.
 *
 * Entry point: `assembleConversationContext`.
 */

export {
  ContextAssemblyError,
  DEFAULT_COST_MODEL,
  measureMessages,
  messageBytes,
  partBytes,
  unitMessages,
  type AssembledMessage,
  type ContextCostModel,
  type ContextErrorCode,
  type ContextNotice,
  type ContextNoticeCode,
  type ConversationRole,
  type ConversationUnit,
  type ConversationUnitKind,
} from "./context-types.js";

export {
  DEFAULT_CONTEXT_LIMITS,
  descriptorMediaItemCeiling,
  resolveContextLimits,
  type ContextLimits,
  type ContextLimitsInput,
  type ForwardExpansionLimits,
} from "./context-limits.js";

export {
  MIN_QUOTED_BYTES,
  REDACTED_FENCE_PLACEHOLDER,
  UNTRUSTED_LINE_PREFIX,
  deriveFenceToken,
  marker,
  markerFields,
  quoteUntrustedText,
  sanitizeUntrustedText,
  truncateUtf8,
  type QuotedText,
} from "./untrusted-text.js";

export {
  assembleSystemPrompt,
  renderFrameworkSection,
  type AdjacentDescriptionPlacement,
  type ModuleDescriptionInput,
  type SystemPromptInput,
  type SystemPromptResult,
} from "./system-prompt.js";

export {
  createRenderState,
  fragmentsToMessages,
  renderBlockFragments,
  splitTextByBytes,
  type BlockEnvelope,
  type BlockLookup,
  type BlockRenderOptions,
  type DataItemAdapter,
  type Fragment,
  type MediaMetadata,
  type MediaMetadataLookup,
  type RenderState,
  type UnavailableModalityPolicy,
} from "./block-units.js";

export {
  RECENT_WINDOW_POLICY_ID,
  recentWindowTrimPolicy,
  renderTrimNotice,
  trimNotices,
  validateTrimOrder,
  type ContextTrimPolicy,
  type RecentWindowTrimOptions,
} from "./context-trim.js";

export {
  assembleConversationContext,
  toChatInput,
  type AssembledConversation,
  type ContextAssemblyReport,
  type ContextAssemblyRequest,
  type SystemPromptConfiguration,
} from "./context-assembly.js";
