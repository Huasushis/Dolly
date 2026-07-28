import { parseBlockContent, type Rect } from "../../core/block-content.js";
import type { Block } from "../../core/block-store.js";
import { canonicalizeJson, deepFreeze } from "../../core/canonical-json.js";
import { MESSAGE_BOUNDARY_SCHEMA } from "./external-message.js";

/**
 * The egress counterpart of the ingress envelope: what one delivered Block
 * looks like to an external session.
 *
 * This is the "speak" side of the channel. It is a protocol projection, not a
 * Block mutation and not a second copy of Block content: it names the Media a
 * client may ask to display and keeps every unknown payload inspectable
 * without executing it.
 */
export const DISPLAY_ITEM_SCHEMA = "dolly.console.display-item/1" as const;

export type ConsolePresentationItem =
  /** A message boundary the ingress side wrote. Renderers may group by it. */
  | { readonly kind: "message-boundary" }
  /**
   * Plain or Markdown text. `format` is a hint for a sanitizing renderer; the
   * text itself is untrusted display data in every case.
   */
  | { readonly kind: "text"; readonly text: string; readonly format: "plain" | "markdown" }
  /**
   * A Media the client MAY request. The identifier alone grants nothing: a
   * display request is re-authorized against the delivered scope.
   */
  | { readonly kind: "media"; readonly mediaId: string; readonly crop?: Rect }
  /** A reference to an earlier Block, shown as a link rather than expanded. */
  | { readonly kind: "block-reference"; readonly blockId: string }
  /**
   * The safe fallback required by section 6.4. An unknown schema stays
   * inspectable as bounded canonical JSON and is never executed, fetched, or
   * searched for identifiers.
   */
  | {
      readonly kind: "structured";
      readonly schema: string;
      readonly preview: string;
      readonly truncated: boolean;
    };

export interface PresentationLimits {
  readonly maxStructuredPreviewBytes: number;
  readonly maxPresentationItems: number;
}

export const DEFAULT_PRESENTATION_LIMITS: PresentationLimits = deepFreeze({
  maxStructuredPreviewBytes: 4 * 1024,
  maxPresentationItems: 512,
});

/** Truncates on a UTF-8 boundary so a preview never emits a broken code point. */
function boundedPreview(
  value: unknown,
  maxBytes: number,
): { preview: string; truncated: boolean } {
  let canonical: string;
  try {
    canonical = canonicalizeJson(value);
  } catch {
    return { preview: "", truncated: true };
  }
  const bytes = Buffer.from(canonical, "utf8");
  if (bytes.byteLength <= maxBytes) return { preview: canonical, truncated: false };
  const slice = bytes.subarray(0, maxBytes);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  // The replacement character marks a split code point; drop that last unit.
  const preview = decoded.endsWith("�") ? decoded.slice(0, -1) : decoded;
  return { preview, truncated: true };
}

/**
 * Projects one delivered Block into presentation items.
 *
 * A Block whose payload claims `dolly.content/1` but does not validate is not
 * partially rendered: it falls back to one bounded structured item, so a
 * malformed payload cannot smuggle half-parsed text into the stream.
 */
export function presentBlock(
  block: Block,
  limitsInput?: Partial<PresentationLimits>,
): readonly ConsolePresentationItem[] {
  const limits = { ...DEFAULT_PRESENTATION_LIMITS, ...(limitsInput ?? {}) };
  const structuredFallback = (schema: string, value: unknown): ConsolePresentationItem[] => {
    const bounded = boundedPreview(value, limits.maxStructuredPreviewBytes);
    return [{ kind: "structured", schema, preview: bounded.preview, truncated: bounded.truncated }];
  };

  if (block.payload.schema !== "dolly.content/1") {
    return deepFreeze(structuredFallback(block.payload.schema, block.payload.value));
  }

  let items;
  try {
    items = parseBlockContent(block.payload.value).items;
  } catch {
    return deepFreeze(structuredFallback(block.payload.schema, block.payload.value));
  }

  const presentation: ConsolePresentationItem[] = [];
  for (const item of items) {
    if (presentation.length >= limits.maxPresentationItems) break;
    switch (item.type) {
      case "text":
        presentation.push({
          kind: "text",
          text: item.text,
          format: item.format === "markdown" ? "markdown" : "plain",
        });
        break;
      case "media-reference":
        presentation.push({
          kind: "media",
          mediaId: item.mediaId,
          ...(item.crop === undefined ? {} : { crop: item.crop }),
        });
        break;
      case "block-reference":
        presentation.push({ kind: "block-reference", blockId: item.blockId });
        break;
      case "data":
        if (item.schema === MESSAGE_BOUNDARY_SCHEMA) {
          presentation.push({ kind: "message-boundary" });
          break;
        }
        presentation.push(...structuredFallback(item.schema, item.value));
        break;
    }
  }
  return deepFreeze(presentation);
}
