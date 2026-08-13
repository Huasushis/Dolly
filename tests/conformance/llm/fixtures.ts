/**
 * Deterministic fixtures for LLM context assembly.
 *
 * Everything here is local and fake: no network, no credential, no provider
 * account, no Media bytes. `docs/spec/llm-extension.md` section 12 requires the
 * suite to run with fake Core, model operation, media, and storage
 * capabilities, so the descriptor snapshots below are hand-built rather than
 * fetched from a broker.
 */

import { canonicalJsonDigest, type JsonValue } from "../../../src/core/canonical-json.js";
import type { Block, SourceIdentity } from "../../../src/core/block-store.js";
import type { BlockContentItem } from "../../../src/core/block-content.js";
import type {
  ChatDescriptorDocument,
  ChatDescriptorSnapshot,
  MediaRequirement,
} from "../../../src/core/model-provider-descriptor.js";
import type { ReactiveModuleInput } from "../../../src/core/reactive-module-input.js";
import type {
  MediaMetadata,
  MediaMetadataLookup,
} from "../../../src/extensions/llm/block-units.js";

const SCHEMA_DIGEST = `sha256:${"11".repeat(32)}`;

export const IMAGE_REQUIREMENT: MediaRequirement = {
  requirementId: "fixture-image-inline",
  modality: "image",
  mimeTypes: ["image/png", "image/jpeg"],
  deliveryModes: ["inline"],
  maxItems: 2,
  maxBytesPerItem: 1024 * 1024,
  maxAggregateBytes: 4 * 1024 * 1024,
  providerFetchesAfterAcceptance: false,
  lifetimeStrategyId: "media.inline-or-private-signed.v1",
  placementStrategyId: "fixture.text-image.composite.v1",
};

export interface DescriptorOptions {
  readonly vision?: boolean;
  readonly modelId?: string;
  readonly roles?: readonly string[];
  readonly maxMessages?: number;
  readonly maxPartsPerMessage?: number;
  readonly maxInputBytes?: number;
  readonly maxTextBytesPerItem?: number;
  readonly imageMaxItems?: number;
  readonly streaming?: boolean;
}

export function chatDescriptorDocument(
  options: DescriptorOptions = {},
): ChatDescriptorDocument {
  const vision = options.vision ?? false;
  const streaming = options.streaming ?? false;
  const requirement: MediaRequirement = {
    ...IMAGE_REQUIREMENT,
    maxItems: options.imageMaxItems ?? IMAGE_REQUIREMENT.maxItems,
  };
  return {
    schemaVersion: "dolly.model-descriptor/3",
    descriptorVersion: "v1",
    endpointId: "fixture-endpoint",
    operation: "chat-completion",
    modelId: options.modelId ?? (vision ? "fixture-vision-model" : "fixture-text-model"),
    adapter: {
      id: "fixture-chat",
      version: "v1",
      requestStrategyId: "openai.chat.request.text-parts.v1",
      responseStrategyId: "openai.chat.response.v1",
      ...(streaming ? { streamStrategyId: "openai.chat.stream.sse.v1" } : {}),
    },
    limits: {
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 256 * 1024,
      maxInputItems: 256,
      maxInputBytes: options.maxInputBytes ?? 512 * 1024,
      maxOutputBytes: 64 * 1024,
      maxConcurrentRequests: 1,
      maxProviderTimeoutMs: 30_000,
      streaming: streaming
        ? {
            state: "supported",
            value: { maxEvents: 1_024, maxBufferedBytes: 256 * 1_024 },
          }
        : { state: "unsupported" },
    },
    input: {
      modalities: vision ? ["text", "image"] : ["text"],
      text: {
        state: "supported",
        value: {
          maxBytesPerItem: options.maxTextBytesPerItem ?? 64 * 1024,
          empty: "forbidden",
        },
      },
      media: vision ? [requirement] : [],
    },
    retry: {
      maxProviderAttempts: 1,
      safeConditions: ["before-dispatch"],
      providerIdempotency: { state: "unsupported" },
    },
    features: {
      roles: [...(options.roles ?? ["system", "user", "assistant", "tool"])],
      messageOrderStrategyId: "openai.chat.message-order.v1",
      maxMessages: options.maxMessages ?? 128,
      maxPartsPerMessage: options.maxPartsPerMessage ?? 32,
      contextWindowTokens: { state: "supported", value: { maximum: 131_072 } },
      maxOutputTokens: { state: "supported", value: { maximum: 8192 } },
      mediaRequirementIds: vision ? [requirement.requirementId] : [],
      tools: { state: "unsupported" },
      structuredOutput: { state: "unsupported" },
      reasoning: {
        support: "unsupported",
        requestControl: { kind: "forbidden" },
        observation: { state: "unsupported" },
        replay: { requirement: "forbidden" },
      },
      finishReasons: ["stop", "length"],
    },
  };
}

export function chatSnapshot(options: DescriptorOptions = {}): ChatDescriptorSnapshot {
  const document = chatDescriptorDocument(options);
  return {
    schemaDigest: SCHEMA_DIGEST,
    ref: {
      endpointId: document.endpointId,
      operation: "chat-completion",
      modelId: document.modelId,
      adapterId: document.adapter.id,
      adapterVersion: document.adapter.version,
      descriptorVersion: document.descriptorVersion,
      descriptorDigest: canonicalJsonDigest(document as unknown as JsonValue),
    },
    document,
  };
}

export interface BlockOptions {
  readonly id: string;
  readonly source?: SourceIdentity;
  readonly items: readonly BlockContentItem[];
  readonly sequence?: string;
  readonly createdAt?: string;
  readonly summary?: string;
  readonly payloadSchema?: string;
}

export function block(options: BlockOptions): Block {
  return {
    schemaVersion: "dolly.block/2",
    id: options.id,
    sequence: options.sequence ?? "1",
    source: options.source ?? { kind: "external", id: "console" },
    createdAt: options.createdAt ?? "2026-01-01T00:00:00.000Z",
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    payload: {
      schema: options.payloadSchema ?? "dolly.content/1",
      value: { items: options.items } as unknown as JsonValue,
    },
  };
}

export function textBlock(id: string, text: string, source?: SourceIdentity): Block {
  return block({
    id,
    ...(source === undefined ? {} : { source }),
    items: [{ type: "text", text }],
  });
}

export interface GroupOptions {
  readonly block: Block;
  readonly occurrenceCount?: number;
  readonly deliveryIds?: readonly string[];
  readonly firstGlobalSequence?: string;
  readonly lastGlobalSequence?: string;
}

export function reactiveInput(groups: readonly GroupOptions[]): ReactiveModuleInput {
  const blockGroups = groups.map((group, index) => {
    const occurrenceCount = group.occurrenceCount ?? 1;
    const deliveryIds =
      group.deliveryIds ??
      Array.from({ length: occurrenceCount }, (_, offset) => `delivery-${index}-${offset}`);
    return {
      block: group.block,
      deliveryIds,
      occurrenceCount,
      firstGlobalSequence: group.firstGlobalSequence ?? String(index * 10 + 1),
      lastGlobalSequence: group.lastGlobalSequence ?? String(index * 10 + occurrenceCount),
    };
  });
  return {
    schemaVersion: "dolly.reactive-module-input/2",
    claimedDeliveryIds: blockGroups.flatMap((group) => group.deliveryIds),
    blockGroups,
    hasMore: false,
  };
}

export function mediaLookup(
  entries: readonly MediaMetadata[],
): MediaMetadataLookup & { readonly calls: string[] } {
  const byId = new Map(entries.map((entry) => [entry.mediaId, entry] as const));
  const calls: string[] = [];
  return {
    calls,
    describe(mediaId: string): MediaMetadata | undefined {
      calls.push(mediaId);
      return byId.get(mediaId);
    },
  };
}

export function blockLookup(blocks: readonly Block[]): {
  get(blockId: string): Block | undefined;
} {
  const byId = new Map(blocks.map((entry) => [entry.id, entry] as const));
  return { get: (blockId: string) => byId.get(blockId) };
}

/** Concatenates every text part of an assembled conversation, in order. */
export function renderedText(messages: readonly {
  readonly role: string;
  readonly parts: readonly ({ readonly kind: "text"; readonly text: string } | {
    readonly kind: "media";
  })[];
}[]): string {
  return messages
    .flatMap((message) =>
      message.parts.filter(
        (part): part is { readonly kind: "text"; readonly text: string } =>
          part.kind === "text",
      ),
    )
    .map((part) => part.text)
    .join("\n");
}
