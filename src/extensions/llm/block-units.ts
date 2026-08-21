/**
 * Maps one Block delivery group to one conversation unit.
 *
 * Contract: `docs/spec/llm-extension.md` sections 3.1 and 7,
 * `docs/spec/block-payload.md`, `docs/spec/media.md`, and the owner's
 * requirements that an image is given "together with its identifier, with the
 * correspondence stated", that a model without vision is told so in text
 * instead of being handed the picture, and that forward expansion has a
 * maximum depth.
 *
 * Deterministic rules implemented here:
 *
 * - **Role.** A Block whose `source` is this Module becomes an assistant
 *   message; every other source becomes a user message.
 * - **Occurrence.** Canonical content is rendered once. The delivery count and
 *   sequence bounds stay in the host marker, so arriving through three Pages
 *   costs three integers, not three copies of the text.
 * - **Media.** An attachable item emits a host marker naming the Media
 *   identifier and crop, immediately followed by the media part, so the model
 *   is told which identifier the bytes belong to. Otherwise it emits the marker
 *   alone with a closed reason token, which is what a model without the
 *   modality receives.
 * - **Media authority.** A media part is emitted only for a reference that
 *   appears in a Block delivered directly in this claim. Media inside a
 *   forwarded Block renders as an identifier, because
 *   `block-payload.md` section 2 and `security-operations.md` section 10 derive
 *   Media authorization from a delivered Block, and a referenced Block is not
 *   itself a direct input.
 * - **Forward expansion.** Bounded by depth, node count, and bytes. A rejected
 *   expansion consumes none of those budgets and leaves a visible marker with
 *   the exact reason.
 *
 * Nothing here reads Media bytes, resolves a URL, or learns a storage key. It
 * emits the exact `MediaReferenceItem` from Block content plus the descriptor's
 * requirement identifier; the broker owns everything after that.
 */

import type { JsonValue } from "../../core/canonical-json.js";
import type { Block } from "../../core/block-store.js";
import {
  parseBlockContent,
  type BlockContent,
  type BlockContentItem,
  type MediaReferenceItem,
  type Rect,
} from "../../core/block-content.js";
import type { ChatPart } from "../../core/model-provider-chat.js";
import type {
  ChatDescriptorSnapshot,
  MediaRequirement,
} from "../../core/model-provider-descriptor.js";
import {
  ContextAssemblyError,
  type ContextNotice,
  type ConversationRole,
} from "./context-types.js";
import type { ContextLimits } from "./context-limits.js";
import {
  marker,
  markerFields,
  quoteUntrustedText,
  sanitizeUntrustedText,
  truncateUtf8,
  REDACTED_FENCE_PLACEHOLDER,
} from "./untrusted-text.js";

/** Non-secret Media metadata the host supplies for a delivered reference. */
export interface MediaMetadata {
  readonly mediaId: string;
  /** Matches `DescriptorInput.modalities`, for example `image` or `audio`. */
  readonly modality: string;
  readonly mimeType: string;
}

/**
 * Host-provided metadata lookup.
 *
 * It returns descriptive fields only. Bytes, signed URLs, object keys, and
 * local paths are owned by the Media store and the broker and never reach this
 * extension (`llm-extension.md` section 7).
 */
export interface MediaMetadataLookup {
  describe(mediaId: string): MediaMetadata | undefined;
}

/** Host-provided lookup for Blocks reachable through a `block-reference`. */
export interface BlockLookup {
  get(blockId: string): Block | undefined;
}

/** Renders one allowlisted extension-data schema into bounded text. */
export type DataItemAdapter = (value: JsonValue) => string;

/**
 * What to do when a delivered media item cannot be attached.
 *
 * `describe` keeps the identifier in the conversation with an explicit reason,
 * which is the owner's requirement: a model without vision should be told that
 * an image exists and that it cannot see it, so it can ask another Module
 * instead of hallucinating. `fail` is the strict reading of
 * `llm-extension.md` section 7 and rejects before provider I/O.
 */
export type UnavailableModalityPolicy = "describe" | "fail";

export interface BlockRenderOptions {
  readonly fenceToken: string;
  readonly descriptor: ChatDescriptorSnapshot;
  readonly limits: ContextLimits;
  readonly media?: MediaMetadataLookup;
  readonly blocks?: BlockLookup;
  readonly dataAdapters?: ReadonlyMap<string, DataItemAdapter>;
  readonly unavailableModalityPolicy?: UnavailableModalityPolicy;
}

/** Mutable budgets and dedupe state shared by every Block in one assembly. */
export interface RenderState {
  forwardNodesUsed: number;
  forwardBytesUsed: number;
  mediaPartsUsed: number;
  readonly renderedBlockIds: Set<string>;
  readonly requirementItemsUsed: Map<string, number>;
  readonly notices: ContextNotice[];
}

export function createRenderState(): RenderState {
  return {
    forwardNodesUsed: 0,
    forwardBytesUsed: 0,
    mediaPartsUsed: 0,
    renderedBlockIds: new Set<string>(),
    requirementItemsUsed: new Map<string, number>(),
    notices: [],
  };
}

/** One ordered piece of rendered Block content: literal text, or a media part. */
export type Fragment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "media"; readonly part: ChatPart };

function forkState(state: RenderState): RenderState {
  return {
    forwardNodesUsed: state.forwardNodesUsed,
    forwardBytesUsed: state.forwardBytesUsed,
    mediaPartsUsed: state.mediaPartsUsed,
    renderedBlockIds: new Set(state.renderedBlockIds),
    requirementItemsUsed: new Map(state.requirementItemsUsed),
    notices: [...state.notices],
  };
}

function mergeState(target: RenderState, source: RenderState): void {
  target.forwardNodesUsed = source.forwardNodesUsed;
  target.forwardBytesUsed = source.forwardBytesUsed;
  target.mediaPartsUsed = source.mediaPartsUsed;
  target.renderedBlockIds.clear();
  for (const blockId of source.renderedBlockIds) target.renderedBlockIds.add(blockId);
  target.requirementItemsUsed.clear();
  for (const [key, value] of source.requirementItemsUsed) {
    target.requirementItemsUsed.set(key, value);
  }
  target.notices.length = 0;
  target.notices.push(...source.notices);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Places untrusted text inline.
 *
 * Control characters are removed and the fence token is redacted, so untrusted
 * text can never open a line that a reader would attribute to the host. The
 * text keeps its natural shape otherwise: quoting every conversational line
 * would make ordinary dialogue unreadable, and the message role already carries
 * the trust boundary for Block content.
 */
function placeInline(
  value: string,
  fenceToken: string,
  subject: string,
  notices: ContextNotice[],
): string {
  const sanitized = sanitizeUntrustedText(value);
  if (!sanitized.includes(fenceToken)) return sanitized;
  notices.push({ code: "FENCE_TOKEN_REDACTED", subject, reason: "block-content" });
  return sanitized.split(fenceToken).join(REDACTED_FENCE_PLACEHOLDER);
}

function formatCrop(crop: Rect): string {
  return [crop.x0, crop.y0, crop.x1, crop.y1].join(",");
}

function selectMediaRequirement(
  descriptor: ChatDescriptorSnapshot,
  metadata: MediaMetadata,
): MediaRequirement | undefined {
  const enabled = new Set(descriptor.document.features.mediaRequirementIds);
  return descriptor.document.input.media.find(
    (requirement) =>
      enabled.has(requirement.requirementId) &&
      requirement.modality === metadata.modality &&
      requirement.mimeTypes.includes(metadata.mimeType),
  );
}

function modalityIsEnabled(descriptor: ChatDescriptorSnapshot, modality: string): boolean {
  const enabled = new Set(descriptor.document.features.mediaRequirementIds);
  return descriptor.document.input.media.some(
    (requirement) =>
      enabled.has(requirement.requirementId) && requirement.modality === modality,
  );
}

/**
 * Decides whether one media reference is attached, and why not when it is not.
 *
 * The decision reads the frozen descriptor only. A provider or model name never
 * enters it, so a deployment cannot gain vision by renaming an endpoint and
 * cannot lose it because a name looked unfamiliar.
 */
function decideMedia(
  reference: MediaReferenceItem,
  directlyDelivered: boolean,
  options: BlockRenderOptions,
  state: RenderState,
):
  | { readonly attached: true; readonly requirementId: string; readonly modality: string }
  | { readonly attached: false; readonly reason: string; readonly modality: string | null } {
  if (!directlyDelivered) {
    return { attached: false, reason: "not-directly-delivered", modality: null };
  }
  const metadata = options.media?.describe(reference.mediaId);
  if (metadata === undefined) {
    return { attached: false, reason: "metadata-unavailable", modality: null };
  }
  if (metadata.mediaId !== reference.mediaId) {
    throw new ContextAssemblyError(
      "CONTEXT_REQUEST_INVALID",
      "The Media metadata lookup returned a different Media identifier",
      { requested: reference.mediaId, returned: metadata.mediaId },
    );
  }
  if (!modalityIsEnabled(options.descriptor, metadata.modality)) {
    return { attached: false, reason: "modality-not-accepted", modality: metadata.modality };
  }
  const requirement = selectMediaRequirement(options.descriptor, metadata);
  if (requirement === undefined) {
    return { attached: false, reason: "media-type-not-accepted", modality: metadata.modality };
  }
  // The descriptor's own per-requirement cap is reported before the deployment
  // budget, because it is the more specific fact: the model itself will not take
  // another item of this kind.
  const used = state.requirementItemsUsed.get(requirement.requirementId) ?? 0;
  if (used >= requirement.maxItems) {
    return { attached: false, reason: "requirement-item-limit", modality: metadata.modality };
  }
  if (state.mediaPartsUsed >= options.limits.maxMediaParts) {
    return { attached: false, reason: "media-budget-exhausted", modality: metadata.modality };
  }
  return {
    attached: true,
    requirementId: requirement.requirementId,
    modality: metadata.modality,
  };
}

function renderMediaItem(
  item: MediaReferenceItem,
  directlyDelivered: boolean,
  options: BlockRenderOptions,
  state: RenderState,
): Fragment[] {
  const { fenceToken } = options;
  const decision = decideMedia(item, directlyDelivered, options, state);
  const policy = options.unavailableModalityPolicy ?? "describe";
  const fragments: Fragment[] = [];

  if (decision.attached) {
    state.mediaPartsUsed += 1;
    state.requirementItemsUsed.set(
      decision.requirementId,
      (state.requirementItemsUsed.get(decision.requirementId) ?? 0) + 1,
    );
    state.notices.push({ code: "MEDIA_ATTACHED", subject: item.mediaId, reason: decision.modality });
    fragments.push({
      kind: "text",
      text: marker(
        fenceToken,
        markerFields([
          ["media", item.mediaId],
          ["modality", decision.modality],
          ...(item.crop === undefined
            ? []
            : ([["crop", formatCrop(item.crop)]] as const)),
          ["attached", true],
          ["note", "the item immediately after this marker is that Media"],
        ]),
      ),
    });
    fragments.push({
      kind: "media",
      part: { kind: "media", mediaReference: item, requirementId: decision.requirementId },
    });
  } else {
    if (policy === "fail" && decision.reason !== "not-directly-delivered") {
      throw new ContextAssemblyError(
        "CONTEXT_MEDIA_UNSUPPORTED",
        "A delivered Media reference cannot be presented to the selected model",
        { mediaId: item.mediaId, reason: decision.reason },
      );
    }
    state.notices.push({
      code: "MEDIA_NOT_ATTACHED",
      subject: item.mediaId,
      reason: decision.reason,
    });
    fragments.push({
      kind: "text",
      text: marker(
        fenceToken,
        markerFields([
          ["media", item.mediaId],
          ["modality", decision.modality ?? "unknown"],
          ...(item.crop === undefined
            ? []
            : ([["crop", formatCrop(item.crop)]] as const)),
          ["attached", false],
          ["reason", decision.reason],
          ["note", "you have not perceived this item; do not describe its contents"],
        ]),
      ),
    });
  }

  const descriptive: (readonly [string, string])[] = [];
  if (item.caption !== undefined) descriptive.push(["caption", item.caption]);
  if (item.accessibility?.description !== undefined) {
    descriptive.push(["description", item.accessibility.description]);
  }
  if (item.accessibility?.transcript !== undefined) {
    descriptive.push(["transcript", item.accessibility.transcript]);
  }
  for (const [field, value] of descriptive) {
    const quoted = quoteUntrustedText(value, {
      maxBytes: Math.max(options.limits.maxTextItemBytes, 64),
      fenceToken,
    });
    if (quoted.redacted) {
      state.notices.push({
        code: "FENCE_TOKEN_REDACTED",
        subject: item.mediaId,
        reason: `media-${field}`,
      });
    }
    fragments.push({
      kind: "text",
      text: [
        marker(
          fenceToken,
          markerFields([
            [`media-${field}`, item.mediaId],
            ["trust", "untrusted-data"],
          ]),
        ),
        quoted.text,
      ].join("\n"),
    });
  }
  return fragments;
}

function renderTextItem(
  text: string,
  blockId: string,
  options: BlockRenderOptions,
  state: RenderState,
): Fragment {
  const placed = placeInline(text, options.fenceToken, blockId, state.notices);
  if (byteLength(placed) <= options.limits.maxTextItemBytes) {
    return { kind: "text", text: placed };
  }
  state.notices.push({ code: "TEXT_TRUNCATED", subject: blockId, reason: "text-item-byte-limit" });
  const kept = truncateUtf8(placed, options.limits.maxTextItemBytes);
  return {
    kind: "text",
    text: `${kept}\n${marker(
      options.fenceToken,
      markerFields([
        ["text-truncated", blockId],
        ["reason", "text-item-byte-limit"],
      ]),
    )}`,
  };
}

function renderDataItem(
  item: Extract<BlockContentItem, { type: "data" }>,
  blockId: string,
  options: BlockRenderOptions,
  state: RenderState,
): Fragment {
  const adapter = options.dataAdapters?.get(item.schema);
  if (adapter === undefined) {
    // `llm-extension.md` section 3.1: unknown extension data is not stringified
    // into a prompt. The model learns that structured data exists and which
    // schema it claims, and nothing else.
    state.notices.push({
      code: "DATA_ITEM_UNSUPPORTED",
      subject: blockId,
      reason: "schema-not-allowlisted",
    });
    return {
      kind: "text",
      text: marker(
        options.fenceToken,
        markerFields([
          ["data", item.schema],
          ["rendered", false],
          ["reason", "schema-not-allowlisted"],
        ]),
      ),
    };
  }
  const quoted = quoteUntrustedText(adapter(item.value), {
    maxBytes: Math.max(options.limits.maxTextItemBytes, 64),
    fenceToken: options.fenceToken,
  });
  if (quoted.redacted) {
    state.notices.push({ code: "FENCE_TOKEN_REDACTED", subject: blockId, reason: "data-item" });
  }
  if (quoted.truncated) {
    state.notices.push({ code: "TEXT_TRUNCATED", subject: blockId, reason: "data-item-byte-limit" });
  }
  return {
    kind: "text",
    text: [
      marker(
        options.fenceToken,
        markerFields([
          ["data", item.schema],
          ["rendered", true],
          ["trust", "untrusted-data"],
        ]),
      ),
      quoted.text,
    ].join("\n"),
  };
}

function blockContentOf(block: Block, options: BlockRenderOptions): BlockContent | null {
  if (block.payload.schema !== "dolly.content/1") return null;
  try {
    return parseBlockContent(block.payload.value, options.limits.maxBlockItems);
  } catch (error) {
    // Core validated this payload before it committed the Block. A failure here
    // is a broken invariant, not untrusted input, so it fails loudly instead of
    // degrading into a marker that would hide the corruption.
    throw new ContextAssemblyError(
      "CONTEXT_BLOCK_CONTENT_INVALID",
      `Delivered Block ${block.id} claims dolly.content/1 but does not validate`,
      { blockId: block.id, detail: error instanceof Error ? error.message : "unknown" },
    );
  }
}

function renderForwardItem(
  blockId: string,
  depth: number,
  options: BlockRenderOptions,
  state: RenderState,
): Fragment[] {
  const { fenceToken, limits } = options;
  const omitted = (reason: string): Fragment[] => {
    state.notices.push({ code: "FORWARD_OMITTED", subject: blockId, reason });
    return [
      {
        kind: "text",
        text: marker(
          fenceToken,
          markerFields([
            ["forward", blockId],
            ["expanded", false],
            ["reason", reason],
          ]),
        ),
      },
    ];
  };

  if (depth >= limits.forward.maxDepth) return omitted("depth-limit");
  if (state.renderedBlockIds.has(blockId)) return omitted("already-included");
  if (state.forwardNodesUsed >= limits.forward.maxNodes) return omitted("node-limit");
  const target = options.blocks?.get(blockId);
  if (target === undefined) return omitted("not-available");

  // The subtree is rendered against a copy of the shared budgets so that a
  // rejected expansion consumes nothing: no node slot, no dedupe entry, and no
  // notice from a subtree the model never sees.
  const candidateState = forkState(state);
  candidateState.forwardNodesUsed += 1;
  candidateState.renderedBlockIds.add(blockId);
  const content = blockContentOf(target, options);
  const inner: Fragment[] =
    content === null
      ? [
          {
            kind: "text",
            text: marker(
              fenceToken,
              markerFields([
                ["block-payload", target.payload.schema],
                ["rendered", false],
                ["reason", "payload-schema-not-supported"],
              ]),
            ),
          },
        ]
      : renderItems(content.items, target.id, depth + 1, false, options, candidateState);
  if (content === null) {
    candidateState.notices.push({
      code: "BLOCK_PAYLOAD_UNSUPPORTED",
      subject: target.id,
      reason: target.payload.schema,
    });
  }

  const header = marker(
    fenceToken,
    markerFields([
      ["forward", blockId],
      ["expanded", true],
      ["depth", depth + 1],
      ["source", `${target.source.kind}:${target.source.id}`],
      ["createdAt", target.createdAt],
      ["trust", "untrusted-data"],
    ]),
  );
  const footer = marker(
    fenceToken,
    markerFields([
      ["forward-end", blockId],
    ]),
  );
  const fragments: Fragment[] = [
    { kind: "text", text: header },
    ...inner,
    { kind: "text", text: footer },
  ];
  const bytes = fragments.reduce(
    (total, fragment) => total + (fragment.kind === "text" ? byteLength(fragment.text) : 0),
    0,
  );
  if (candidateState.forwardBytesUsed + bytes > limits.forward.maxBytes) {
    return omitted("byte-limit");
  }
  candidateState.forwardBytesUsed += bytes;
  candidateState.notices.push({ code: "FORWARD_EXPANDED", subject: blockId, reason: "expanded" });
  mergeState(state, candidateState);
  return fragments;
}

function renderItems(
  items: readonly BlockContentItem[],
  blockId: string,
  depth: number,
  directlyDelivered: boolean,
  options: BlockRenderOptions,
  state: RenderState,
): Fragment[] {
  const fragments: Fragment[] = [];
  for (const item of items) {
    switch (item.type) {
      case "text":
        fragments.push(renderTextItem(item.text, blockId, options, state));
        break;
      case "media-reference":
        fragments.push(...renderMediaItem(item, directlyDelivered, options, state));
        break;
      case "block-reference":
        fragments.push(...renderForwardItem(item.blockId, depth, options, state));
        break;
      case "data":
        fragments.push(renderDataItem(item, blockId, options, state));
        break;
    }
  }
  return fragments;
}

export interface BlockEnvelope {
  readonly block: Block;
  readonly role: ConversationRole;
  readonly occurrenceCount: number;
  readonly firstGlobalSequence: string;
  readonly lastGlobalSequence: string;
}

/**
 * Renders one delivered Block into ordered fragments.
 *
 * The caller has already decided the role and has already marked this Block as
 * rendered, so a `block-reference` pointing back at a Block in the same batch
 * resolves to `already-included` instead of duplicating it.
 */
export function renderBlockFragments(
  envelope: BlockEnvelope,
  options: BlockRenderOptions,
  state: RenderState,
): readonly Fragment[] {
  const { fenceToken } = options;
  const { block } = envelope;
  const header = marker(
    fenceToken,
    markerFields([
      ["block", block.id],
      ["source", `${block.source.kind}:${block.source.id}`],
      ["role", envelope.role],
      ["occurrences", envelope.occurrenceCount],
      ["sequence", `${envelope.firstGlobalSequence}..${envelope.lastGlobalSequence}`],
      ["createdAt", block.createdAt],
      ["trust", "untrusted-data"],
    ]),
  );
  const fragments: Fragment[] = [{ kind: "text", text: header }];

  if (block.summary !== undefined) {
    const quoted = quoteUntrustedText(block.summary, {
      maxBytes: Math.max(options.limits.maxTextItemBytes, 64),
      fenceToken,
    });
    if (quoted.redacted) {
      state.notices.push({ code: "FENCE_TOKEN_REDACTED", subject: block.id, reason: "summary" });
    }
    fragments.push({
      kind: "text",
      text: [
        marker(
          fenceToken,
          markerFields([
            ["block-summary", block.id],
            ["trust", "untrusted-data"],
          ]),
        ),
        quoted.text,
      ].join("\n"),
    });
  }

  const content = blockContentOf(block, options);
  if (content === null) {
    state.notices.push({
      code: "BLOCK_PAYLOAD_UNSUPPORTED",
      subject: block.id,
      reason: block.payload.schema,
    });
    fragments.push({
      kind: "text",
      text: marker(
        fenceToken,
        markerFields([
          ["block-payload", block.payload.schema],
          ["rendered", false],
          ["reason", "payload-schema-not-supported"],
        ]),
      ),
    });
  } else {
    fragments.push(...renderItems(content.items, block.id, 0, true, options, state));
  }

  fragments.push({
    kind: "text",
    text: marker(fenceToken, markerFields([["block-end", block.id]])),
  });
  return fragments;
}

/** Splits joined text so that no emitted part exceeds the descriptor's per-item byte limit. */
export function splitTextByBytes(text: string, maxBytes: number): readonly string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) chunks.push(current);
    current = "";
  };
  for (const line of text.split("\n")) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }
    flush();
    let rest = line;
    while (byteLength(rest) > maxBytes) {
      let head = truncateUtf8(rest, maxBytes);
      if (head.length === 0) head = [...rest][0] ?? "";
      if (head.length === 0) break;
      chunks.push(head);
      rest = rest.slice(head.length);
    }
    current = rest;
  }
  flush();
  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Turns ordered fragments into messages of one role.
 *
 * Consecutive text fragments are joined and then split by the descriptor's
 * per-item byte limit, and parts are chunked by the descriptor's parts-per-
 * message limit. A media part always follows the marker that names it, because
 * joining stops at every media fragment.
 */
export function fragmentsToMessages(
  fragments: readonly Fragment[],
  role: ConversationRole,
  limits: ContextLimits,
): readonly { readonly role: ConversationRole; readonly parts: readonly ChatPart[] }[] {
  const parts: ChatPart[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    for (const chunk of splitTextByBytes(pending.join("\n"), limits.maxTextPartBytes)) {
      parts.push({ kind: "text", text: chunk });
    }
    pending = [];
  };
  for (const fragment of fragments) {
    if (fragment.kind === "text") {
      pending.push(fragment.text);
      continue;
    }
    flush();
    parts.push(fragment.part);
  }
  flush();

  const messages: { role: ConversationRole; parts: ChatPart[] }[] = [];
  for (let index = 0; index < parts.length; index += limits.maxPartsPerMessage) {
    messages.push({ role, parts: parts.slice(index, index + limits.maxPartsPerMessage) });
  }
  return messages;
}
