/**
 * Resolves the effective assembly limits for one request.
 *
 * Contract: `docs/spec/llm-extension.md` section 3.2 — "Every category has
 * independent and total byte, token, item, media, reference, and expansion
 * limits. A provider-aware token estimate does not replace hard byte limits."
 *
 * Every limit here is a byte or item count, never a token estimate. A
 * configured limit is clamped by the frozen descriptor rather than trusted, so
 * a deployment cannot raise a budget above what the selected model actually
 * declares, and a descriptor change is visible in the resolved limits instead
 * of surfacing later as a provider rejection.
 */

import type { ChatDescriptorSnapshot } from "../../core/model-provider-descriptor.js";
import {
  ContextAssemblyError,
  DEFAULT_COST_MODEL,
  type ContextCostModel,
} from "./context-types.js";

export interface ForwardExpansionLimits {
  /** Maximum reference hops away from a delivered Block. */
  readonly maxDepth: number;
  /** Maximum number of referenced Blocks expanded across the whole request. */
  readonly maxNodes: number;
  /** Maximum rendered bytes contributed by expansion across the whole request. */
  readonly maxBytes: number;
}

export interface ContextLimits {
  readonly maxTotalBytes: number;
  readonly maxMessages: number;
  readonly maxMediaParts: number;
  readonly maxPartsPerMessage: number;
  readonly maxTextPartBytes: number;
  readonly maxSystemPromptBytes: number;
  readonly maxDeploymentTextBytes: number;
  readonly maxDescriptions: number;
  readonly maxDescriptionBytes: number;
  readonly maxDescriptionsTotalBytes: number;
  readonly maxTextItemBytes: number;
  readonly maxBlockItems: number;
  readonly forward: ForwardExpansionLimits;
  readonly cost: ContextCostModel;
}

export interface ContextLimitsInput {
  readonly maxTotalBytes?: number;
  readonly maxMessages?: number;
  readonly maxMediaParts?: number;
  readonly maxSystemPromptBytes?: number;
  readonly maxDeploymentTextBytes?: number;
  readonly maxDescriptions?: number;
  readonly maxDescriptionBytes?: number;
  readonly maxDescriptionsTotalBytes?: number;
  readonly maxTextItemBytes?: number;
  readonly maxBlockItems?: number;
  readonly forward?: Partial<ForwardExpansionLimits>;
  readonly cost?: Partial<ContextCostModel>;
}

/**
 * Provider-independent defaults. `docs/spec/llm-extension.md` section 11
 * requires the default configuration to expose no tools, hide reasoning, and
 * accept bounded text; these numbers are the bounded-text half of that.
 */
export const DEFAULT_CONTEXT_LIMITS: Omit<
  ContextLimits,
  "maxPartsPerMessage" | "maxTextPartBytes"
> = Object.freeze({
  maxTotalBytes: 256 * 1024,
  maxMessages: 64,
  maxMediaParts: 16,
  maxSystemPromptBytes: 32 * 1024,
  maxDeploymentTextBytes: 16 * 1024,
  maxDescriptions: 32,
  maxDescriptionBytes: 4 * 1024,
  maxDescriptionsTotalBytes: 32 * 1024,
  maxTextItemBytes: 32 * 1024,
  maxBlockItems: 256,
  forward: Object.freeze({ maxDepth: 2, maxNodes: 8, maxBytes: 16 * 1024 }),
  cost: DEFAULT_COST_MODEL,
});

function positive(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ContextAssemblyError(
      "CONTEXT_LIMIT_INVALID",
      `${label} must be a positive safe integer`,
      { label },
    );
  }
  return resolved;
}

function nonNegative(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new ContextAssemblyError(
      "CONTEXT_LIMIT_INVALID",
      `${label} must be a non-negative safe integer`,
      { label },
    );
  }
  return resolved;
}

/**
 * The media parts the descriptor could accept at all, which is the ceiling for
 * the configured media budget. A descriptor with no enabled media requirement
 * yields zero, and every media reference then degrades to identifier-only text.
 */
export function descriptorMediaItemCeiling(descriptor: ChatDescriptorSnapshot): number {
  const enabled = new Set(descriptor.document.features.mediaRequirementIds);
  let total = 0;
  for (const requirement of descriptor.document.input.media) {
    if (enabled.has(requirement.requirementId)) total += requirement.maxItems;
  }
  return total;
}

export function resolveContextLimits(
  descriptor: ChatDescriptorSnapshot,
  input: ContextLimitsInput = {},
): ContextLimits {
  const document = descriptor.document;
  if (document.input.text.state !== "supported") {
    throw new ContextAssemblyError(
      "CONTEXT_TEXT_UNSUPPORTED",
      "Context assembly requires a descriptor that accepts text input",
      { textState: document.input.text.state },
    );
  }

  const configured = {
    maxTotalBytes: positive(
      input.maxTotalBytes,
      DEFAULT_CONTEXT_LIMITS.maxTotalBytes,
      "maxTotalBytes",
    ),
    maxMessages: positive(input.maxMessages, DEFAULT_CONTEXT_LIMITS.maxMessages, "maxMessages"),
    maxMediaParts: nonNegative(
      input.maxMediaParts,
      DEFAULT_CONTEXT_LIMITS.maxMediaParts,
      "maxMediaParts",
    ),
    maxSystemPromptBytes: positive(
      input.maxSystemPromptBytes,
      DEFAULT_CONTEXT_LIMITS.maxSystemPromptBytes,
      "maxSystemPromptBytes",
    ),
    maxDeploymentTextBytes: positive(
      input.maxDeploymentTextBytes,
      DEFAULT_CONTEXT_LIMITS.maxDeploymentTextBytes,
      "maxDeploymentTextBytes",
    ),
    maxDescriptions: nonNegative(
      input.maxDescriptions,
      DEFAULT_CONTEXT_LIMITS.maxDescriptions,
      "maxDescriptions",
    ),
    maxDescriptionBytes: positive(
      input.maxDescriptionBytes,
      DEFAULT_CONTEXT_LIMITS.maxDescriptionBytes,
      "maxDescriptionBytes",
    ),
    maxDescriptionsTotalBytes: positive(
      input.maxDescriptionsTotalBytes,
      DEFAULT_CONTEXT_LIMITS.maxDescriptionsTotalBytes,
      "maxDescriptionsTotalBytes",
    ),
    maxTextItemBytes: positive(
      input.maxTextItemBytes,
      DEFAULT_CONTEXT_LIMITS.maxTextItemBytes,
      "maxTextItemBytes",
    ),
    maxBlockItems: positive(
      input.maxBlockItems,
      DEFAULT_CONTEXT_LIMITS.maxBlockItems,
      "maxBlockItems",
    ),
    forward: {
      maxDepth: nonNegative(
        input.forward?.maxDepth,
        DEFAULT_CONTEXT_LIMITS.forward.maxDepth,
        "forward.maxDepth",
      ),
      maxNodes: nonNegative(
        input.forward?.maxNodes,
        DEFAULT_CONTEXT_LIMITS.forward.maxNodes,
        "forward.maxNodes",
      ),
      maxBytes: nonNegative(
        input.forward?.maxBytes,
        DEFAULT_CONTEXT_LIMITS.forward.maxBytes,
        "forward.maxBytes",
      ),
    },
    cost: {
      messageOverheadBytes: nonNegative(
        input.cost?.messageOverheadBytes,
        DEFAULT_COST_MODEL.messageOverheadBytes,
        "cost.messageOverheadBytes",
      ),
      mediaPartBytes: nonNegative(
        input.cost?.mediaPartBytes,
        DEFAULT_COST_MODEL.mediaPartBytes,
        "cost.mediaPartBytes",
      ),
    },
  };

  const maxTextPartBytes = Math.min(
    configured.maxTextItemBytes,
    document.input.text.value.maxBytesPerItem,
  );
  const limits: ContextLimits = {
    ...configured,
    maxTotalBytes: Math.min(configured.maxTotalBytes, document.limits.maxInputBytes),
    maxMessages: Math.min(
      configured.maxMessages,
      document.features.maxMessages,
      document.limits.maxInputItems,
    ),
    maxMediaParts: Math.min(configured.maxMediaParts, descriptorMediaItemCeiling(descriptor)),
    maxPartsPerMessage: document.features.maxPartsPerMessage,
    maxTextPartBytes,
  };

  if (limits.maxSystemPromptBytes > limits.maxTotalBytes) {
    throw new ContextAssemblyError(
      "CONTEXT_LIMIT_INVALID",
      "maxSystemPromptBytes cannot exceed the total context budget",
      { maxSystemPromptBytes: limits.maxSystemPromptBytes, maxTotalBytes: limits.maxTotalBytes },
    );
  }
  if (limits.maxMessages < 2) {
    throw new ContextAssemblyError(
      "CONTEXT_LIMIT_INVALID",
      "maxMessages must allow at least a system message and one input message",
      { maxMessages: limits.maxMessages },
    );
  }
  return Object.freeze({
    ...limits,
    forward: Object.freeze(limits.forward),
    cost: Object.freeze(limits.cost),
  });
}
