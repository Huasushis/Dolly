/**
 * Turns one immutable Delivery batch into a provider-neutral conversation.
 *
 * Contract: `docs/spec/llm-extension.md` sections 3.1, 3.2, 5, and 7;
 * `docs/spec/core-runtime.md` section 7.3 (Block delivery groups) and 9.2.1
 * (Module descriptions).
 *
 * Determinism is the whole point of this file. For the same `moduleId`,
 * `dolly.reactive-module-input/2` batch, descriptor snapshot, configuration,
 * history units, and Module descriptions, `assembleConversationContext`
 * produces byte-identical messages. Nothing consults a clock, a random source,
 * a network, or a provider name. `docs/spec/llm-extension.md` section 3.2
 * requires exactly that, because a retried Module job has to rebuild the same
 * request in order to reuse a known terminal provider response.
 *
 * Assembly order, following section 3.2:
 *
 * 1. the trusted system prompt (framework, deployment policy, capability
 *    disclosure, fenced adjacent Module descriptions);
 * 2. committed conversation units selected by the context policy; and
 * 3. the current input batch in Core order.
 *
 * Out of scope here, and deliberately absent: the tool round state machine,
 * provider dispatch, streaming, the turn journal, and conversation persistence.
 * This module produces the request body's message sequence and the diagnostics
 * needed to explain it; it never calls a model.
 */

import { canonicalJsonDigest, deepFreeze, type JsonValue } from "../../core/canonical-json.js";
import type { ReactiveModuleInput } from "../../core/reactive-module-input.js";
import type { ChatDescriptorSnapshot } from "../../core/model-provider-descriptor.js";
import type { ChatInput, ChatPart } from "../../core/model-provider-chat.js";
import {
  ContextAssemblyError,
  measureMessages,
  type AssembledMessage,
  type ContextNotice,
  type ConversationRole,
  type ConversationUnit,
} from "./context-types.js";
import {
  resolveContextLimits,
  type ContextLimits,
  type ContextLimitsInput,
} from "./context-limits.js";
import {
  createRenderState,
  fragmentsToMessages,
  renderBlockFragments,
  splitTextByBytes,
  type BlockLookup,
  type BlockRenderOptions,
  type DataItemAdapter,
  type MediaMetadataLookup,
  type UnavailableModalityPolicy,
} from "./block-units.js";
import {
  assembleSystemPrompt,
  type AdjacentDescriptionPlacement,
  type ModuleDescriptionInput,
} from "./system-prompt.js";
import {
  recentWindowTrimPolicy,
  renderTrimNotice,
  trimNotices,
  validateTrimOrder,
  type ContextTrimPolicy,
} from "./context-trim.js";
import { deriveFenceToken } from "./untrusted-text.js";

const MODULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface SystemPromptConfiguration {
  readonly frameworkText?: string;
  readonly deploymentText?: string;
  readonly adjacentDescriptions?: readonly ModuleDescriptionInput[];
  readonly adjacentDescriptionPlacement?: AdjacentDescriptionPlacement;
}

export interface ContextAssemblyRequest {
  /** The Module whose conversation this is. Blocks from it become assistant turns. */
  readonly moduleId: string;
  readonly input: ReactiveModuleInput;
  readonly descriptor: ChatDescriptorSnapshot;
  /** Committed conversation units, oldest first. Every one is evictable. */
  readonly history?: readonly ConversationUnit[];
  readonly systemPrompt?: SystemPromptConfiguration;
  readonly media?: MediaMetadataLookup;
  readonly blocks?: BlockLookup;
  readonly dataAdapters?: ReadonlyMap<string, DataItemAdapter>;
  readonly unavailableModalityPolicy?: UnavailableModalityPolicy;
  readonly limits?: ContextLimitsInput;
  readonly trimPolicy?: ContextTrimPolicy;
}

export interface ContextAssemblyReport {
  readonly policyId: string;
  readonly fenceToken: string;
  readonly totalBytes: number;
  readonly messageCount: number;
  readonly mediaPartCount: number;
  readonly evictedUnitIds: readonly string[];
  readonly forwardNodesExpanded: number;
  readonly notices: readonly ContextNotice[];
}

export interface AssembledConversation {
  readonly schemaVersion: "dolly.llm.assembled-context/1";
  readonly fenceToken: string;
  readonly messages: readonly AssembledMessage[];
  /** The units that survived trimming, in order. */
  readonly units: readonly ConversationUnit[];
  /** The units built from this batch, for the caller to append to conversation state. */
  readonly inputUnits: readonly ConversationUnit[];
  readonly limits: ContextLimits;
  readonly report: ContextAssemblyReport;
}

function textMessage(
  role: ConversationRole,
  text: string,
  limits: ContextLimits,
): readonly AssembledMessage[] {
  const parts: ChatPart[] = splitTextByBytes(text, limits.maxTextPartBytes).map((chunk) => ({
    kind: "text",
    text: chunk,
  }));
  const messages: AssembledMessage[] = [];
  for (let index = 0; index < parts.length; index += limits.maxPartsPerMessage) {
    messages.push({ role, parts: parts.slice(index, index + limits.maxPartsPerMessage) });
  }
  return messages;
}

function requireRole(descriptor: ChatDescriptorSnapshot, role: string): void {
  if (!descriptor.document.features.roles.includes(role)) {
    throw new ContextAssemblyError(
      "CONTEXT_ROLE_UNSUPPORTED",
      `The frozen descriptor does not declare the ${role} chat role`,
      { role, roles: [...descriptor.document.features.roles] },
    );
  }
}

function validateHistory(history: readonly ConversationUnit[]): void {
  const seen = new Set<string>();
  for (const unit of history) {
    if (unit.kind !== "history") {
      throw new ContextAssemblyError(
        "CONTEXT_REQUEST_INVALID",
        "A supplied history unit must have kind history",
        { unitId: unit.unitId },
      );
    }
    if (typeof unit.unitId !== "string" || unit.unitId.length === 0 || seen.has(unit.unitId)) {
      throw new ContextAssemblyError(
        "CONTEXT_REQUEST_INVALID",
        "History unit identifiers must be unique non-empty strings",
        { unitId: String(unit.unitId) },
      );
    }
    seen.add(unit.unitId);
    if (unit.messages.length === 0) {
      throw new ContextAssemblyError(
        "CONTEXT_REQUEST_INVALID",
        "A history unit must carry at least one message",
        { unitId: unit.unitId },
      );
    }
    for (const message of unit.messages) {
      if (message.parts.length === 0) {
        throw new ContextAssemblyError(
          "CONTEXT_REQUEST_INVALID",
          "A history message must carry at least one part",
          { unitId: unit.unitId },
        );
      }
    }
  }
}

/**
 * The canonical fingerprint the fence token is derived from.
 *
 * It covers the untrusted text through payload digests, so a Block cannot
 * predict the token that will delimit it: doing so would require choosing text
 * whose own digest produces the token that fences it.
 */
function fenceFingerprint(
  request: ContextAssemblyRequest,
  descriptions: readonly ModuleDescriptionInput[],
): JsonValue {
  return {
    moduleId: request.moduleId,
    descriptorDigest: request.descriptor.ref.descriptorDigest,
    claimedDeliveryIds: [...request.input.claimedDeliveryIds],
    hasMore: request.input.hasMore,
    blocks: request.input.blockGroups.map((group) => ({
      blockId: group.block.id,
      source: `${group.block.source.kind}:${group.block.source.id}`,
      occurrenceCount: group.occurrenceCount,
      firstGlobalSequence: group.firstGlobalSequence,
      lastGlobalSequence: group.lastGlobalSequence,
      payloadDigest: canonicalJsonDigest(group.block.payload as unknown as JsonValue),
    })),
    descriptions: descriptions.map((description) => ({
      moduleId: description.moduleId,
      direction: description.direction,
      revision: description.revision,
      textDigest: canonicalJsonDigest(description.text),
    })),
    deploymentTextDigest:
      request.systemPrompt?.deploymentText === undefined
        ? null
        : canonicalJsonDigest(request.systemPrompt.deploymentText),
    historyUnitIds: (request.history ?? []).map((unit) => unit.unitId),
  };
}

export function assembleConversationContext(
  request: ContextAssemblyRequest,
): AssembledConversation {
  if (!MODULE_ID_PATTERN.test(request.moduleId)) {
    // `llm-extension.md` section 2: missing identity fails closed and never
    // falls back to a process-global conversation.
    throw new ContextAssemblyError(
      "CONTEXT_REQUEST_INVALID",
      "moduleId must be a non-empty opaque identifier",
      {},
    );
  }
  if (request.input.schemaVersion !== "dolly.reactive-module-input/2") {
    throw new ContextAssemblyError(
      "CONTEXT_REQUEST_INVALID",
      "Reactive Module input schema is unsupported",
      { schemaVersion: String(request.input.schemaVersion) },
    );
  }

  const descriptor = request.descriptor;
  requireRole(descriptor, "system");
  requireRole(descriptor, "user");
  const limits = resolveContextLimits(descriptor, request.limits);
  const history = request.history ?? [];
  validateHistory(history);

  const descriptions = request.systemPrompt?.adjacentDescriptions ?? [];
  const fenceToken = deriveFenceToken(fenceFingerprint(request, descriptions));

  const systemPrompt = assembleSystemPrompt({
    fenceToken,
    descriptor,
    limits,
    ...(request.systemPrompt?.frameworkText === undefined
      ? {}
      : { frameworkText: request.systemPrompt.frameworkText }),
    ...(request.systemPrompt?.deploymentText === undefined
      ? {}
      : { deploymentText: request.systemPrompt.deploymentText }),
    adjacentDescriptions: descriptions,
    ...(request.systemPrompt?.adjacentDescriptionPlacement === undefined
      ? {}
      : { adjacentDescriptionPlacement: request.systemPrompt.adjacentDescriptionPlacement }),
  });

  const head: AssembledMessage[] = [
    ...textMessage("system", systemPrompt.systemText, limits),
  ];
  if (systemPrompt.untrustedContextText !== null) {
    head.push(...textMessage("user", systemPrompt.untrustedContextText, limits));
  }

  const renderOptions: BlockRenderOptions = {
    fenceToken,
    descriptor,
    limits,
    ...(request.media === undefined ? {} : { media: request.media }),
    ...(request.blocks === undefined ? {} : { blocks: request.blocks }),
    ...(request.dataAdapters === undefined ? {} : { dataAdapters: request.dataAdapters }),
    ...(request.unavailableModalityPolicy === undefined
      ? {}
      : { unavailableModalityPolicy: request.unavailableModalityPolicy }),
  };
  const state = createRenderState();
  state.notices.push(...systemPrompt.notices);

  // A Block already carried by a history unit, or already carried by an earlier
  // group in this batch, is not rendered twice; `core-runtime.md` section 7.3
  // guarantees one group per Block identity, and this keeps that guarantee true
  // across the whole assembled request.
  for (const unit of history) {
    for (const blockId of unit.blockIds) state.renderedBlockIds.add(blockId);
  }
  const batchBlockIds = request.input.blockGroups.map((group) => group.block.id);
  for (const blockId of batchBlockIds) state.renderedBlockIds.add(blockId);

  const inputUnits: ConversationUnit[] = [];
  const seenBlockIds = new Set<string>();
  for (const group of request.input.blockGroups) {
    const block = group.block;
    if (seenBlockIds.has(block.id)) {
      // Core groups by Block identity, so this is defensive. Rendering the
      // canonical content again would double the prompt for a Block that simply
      // arrived twice, which section 3.1 forbids.
      state.notices.push({
        code: "BLOCK_REPEATED",
        subject: block.id,
        reason: "duplicate-block-group",
      });
      continue;
    }
    seenBlockIds.add(block.id);
    const role: ConversationRole =
      block.source.kind === "module" && block.source.id === request.moduleId
        ? "assistant"
        : "user";
    const fragments = renderBlockFragments(
      {
        block,
        role,
        occurrenceCount: group.occurrenceCount,
        firstGlobalSequence: group.firstGlobalSequence,
        lastGlobalSequence: group.lastGlobalSequence,
      },
      renderOptions,
      state,
    );
    const messages = fragmentsToMessages(fragments, role, limits);
    inputUnits.push({
      unitId: `input:${block.id}`,
      kind: "input-block",
      blockIds: [block.id],
      messages,
    });
  }

  const allUnits: readonly ConversationUnit[] = [...history, ...inputUnits];
  for (const message of [...head, ...allUnits.flatMap((unit) => unit.messages)]) {
    requireRole(descriptor, message.role);
  }

  const trimPolicy = request.trimPolicy ?? recentWindowTrimPolicy();
  const order = trimPolicy.order(allUnits);
  validateTrimOrder(allUnits, order, trimPolicy.policyId);

  const compose = (evicted: ReadonlySet<string>): readonly AssembledMessage[] => {
    const messages: AssembledMessage[] = [...head];
    let index = 0;
    while (index < allUnits.length) {
      const unit = allUnits[index];
      if (!evicted.has(unit.unitId)) {
        messages.push(...unit.messages);
        index += 1;
        continue;
      }
      const span: ConversationUnit[] = [];
      while (index < allUnits.length && evicted.has(allUnits[index].unitId)) {
        span.push(allUnits[index]);
        index += 1;
      }
      messages.push(
        ...textMessage(
          "user",
          renderTrimNotice(fenceToken, span, trimPolicy.policyId),
          limits,
        ),
      );
    }
    return messages;
  };

  for (let evictedCount = 0; ; evictedCount += 1) {
    const evicted = new Set(order.slice(0, evictedCount));
    const messages = compose(evicted);
    const measured = measureMessages(messages, limits.cost);
    const fits =
      measured.bytes <= limits.maxTotalBytes &&
      measured.messageCount <= limits.maxMessages &&
      measured.mediaParts <= limits.maxMediaParts;
    if (fits) {
      const keptUnits = allUnits.filter((unit) => !evicted.has(unit.unitId));
      const removedUnits = allUnits.filter((unit) => evicted.has(unit.unitId));
      const notices = [...state.notices, ...trimNotices(removedUnits)];
      return deepFreeze({
        schemaVersion: "dolly.llm.assembled-context/1",
        fenceToken,
        messages,
        units: keptUnits,
        inputUnits,
        limits,
        report: {
          policyId: trimPolicy.policyId,
          fenceToken,
          totalBytes: measured.bytes,
          messageCount: measured.messageCount,
          mediaPartCount: measured.mediaParts,
          evictedUnitIds: removedUnits.map((unit) => unit.unitId),
          forwardNodesExpanded: state.forwardNodesUsed,
          notices,
        },
      }) as AssembledConversation;
    }
    if (evictedCount >= order.length) {
      // Section 3.2: when the current input cannot fit after eligible old
      // context is evicted, the action fails with a typed input-limit result
      // before any provider I/O.
      throw new ContextAssemblyError(
        "CONTEXT_INPUT_DOES_NOT_FIT",
        "The current input batch does not fit the context budget after full eviction",
        {
          bytes: measured.bytes,
          messageCount: measured.messageCount,
          mediaParts: measured.mediaParts,
          maxTotalBytes: limits.maxTotalBytes,
          maxMessages: limits.maxMessages,
          maxMediaParts: limits.maxMediaParts,
        },
      );
    }
  }
}

/**
 * Bridges the assembled conversation to the broker's normalized chat input.
 *
 * The reasoning directive comes from `mapReasoningPolicy` in
 * `model-provider-chat.ts`; this function never invents a provider field. The
 * version-1 LLM Module configuration requires strict streaming, so this
 * Module-specific bridge cannot select the broker's lower-level non-stream
 * compatibility mode.
 */
export function toChatInput(
  assembled: AssembledConversation,
  options: {
    readonly reasoning: ChatInput["reasoning"];
    readonly outputContract?: ChatInput["outputContract"];
  },
): ChatInput {
  return deepFreeze({
    schemaVersion: "dolly.model.chat-input/2",
    messages: assembled.messages.map((message) => ({
      role: message.role,
      parts: message.parts,
    })),
    outputContract: options.outputContract ?? { kind: "text" },
    reasoning: options.reasoning,
    stream: true,
  }) as ChatInput;
}
