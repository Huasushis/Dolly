import {
  contentReferences,
  parseBlockContent,
  type MediaReferenceItem,
  type Rect,
} from "../../core/block-content.js";
import type { Block } from "../../core/block-store.js";
import { deepFreeze } from "../../core/canonical-json.js";
import { consoleError } from "./errors.js";

/**
 * The Console's half of the Media contract.
 *
 * Two rules, from `security-operations.md` section 10 and `media.md` section 4:
 *
 * 1. On ingress, the client never names a Media. It hands over an opaque
 *    session-scoped upload grant and the host resolves the `mediaId`. That is
 *    why a Block echoed back to the browser contains an identifier the client
 *    could not have guessed, and why guessing one buys nothing.
 * 2. On egress, the Console may reach only the Media named by a validated
 *    `media-reference` inside a Block that was actually delivered to the
 *    current Module job, never a raw identifier and never a broadened crop.
 */

export interface UploadGrantResolution {
  readonly mediaId: string;
  /** `false` while the upload is still `created`/`uploading`/`validating`. */
  readonly available: boolean;
}

/**
 * Host port for the upload flow. It is deliberately session-scoped: resolving
 * a grant issued to another session must fail, so one session cannot attach
 * another session's asset by quoting its grant identifier.
 */
export interface UploadGrantResolver {
  resolve(input: {
    readonly sessionId: string;
    readonly uploadGrantId: string;
  }): UploadGrantResolution | null;
}

export function resolveAttachmentMedia(
  resolver: UploadGrantResolver | undefined,
  input: { readonly sessionId: string; readonly uploadGrantId: string },
): string {
  if (!resolver) {
    throw consoleError("MEDIA_INVALID", "No upload flow is configured for this Console", {
      uploadGrantId: input.uploadGrantId,
    });
  }
  const resolution = resolver.resolve(input);
  if (!resolution) {
    // An expired grant, a grant belonging to another session, and an invented
    // identifier are indistinguishable on purpose.
    throw consoleError("MEDIA_INVALID", "Upload grant is not valid for this session", {
      uploadGrantId: input.uploadGrantId,
    });
  }
  if (!resolution.available) {
    throw consoleError("MEDIA_NOT_READY", "Upload has not finished validating", {
      uploadGrantId: input.uploadGrantId,
    });
  }
  return resolution.mediaId;
}

export interface DeliveredMediaEntry {
  readonly mediaId: string;
  readonly blockIds: readonly string[];
  readonly deliveryIds: readonly string[];
  /** True when at least one delivered reference carried no crop. */
  readonly allowsFullMedia: boolean;
  /** Exactly the crops that were delivered. They are never merged. */
  readonly crops: readonly Rect[];
}

export interface DeliveredBlockGroup {
  readonly block: Block;
  readonly deliveryIds: readonly string[];
}

function deliveredMediaReferences(block: Block): readonly MediaReferenceItem[] {
  if (block.payload.schema !== "dolly.content/1") return [];
  try {
    return contentReferences(parseBlockContent(block.payload.value)).media;
  } catch {
    // A payload that does not validate contributes no references. Scanning it
    // for identifier-shaped strings would turn inert data into authority.
    return [];
  }
}

function sameCrop(left: Rect, right: Rect): boolean {
  return (
    left.topLeft.x === right.topLeft.x &&
    left.topLeft.y === right.topLeft.y &&
    left.bottomRight.x === right.bottomRight.x &&
    left.bottomRight.y === right.bottomRight.y
  );
}

function cropContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.topLeft.x >= outer.topLeft.x &&
    inner.topLeft.y >= outer.topLeft.y &&
    inner.bottomRight.x <= outer.bottomRight.x &&
    inner.bottomRight.y <= outer.bottomRight.y
  );
}

/**
 * Derives the display scope from the Blocks delivered to this egress Module
 * job. Nothing else contributes: not text, not a filename, not a field inside
 * an unknown payload schema.
 */
export function deriveDeliveredMediaScope(
  groups: readonly DeliveredBlockGroup[],
): ReadonlyMap<string, DeliveredMediaEntry> {
  const draft = new Map<
    string,
    { blockIds: Set<string>; deliveryIds: Set<string>; allowsFullMedia: boolean; crops: Rect[] }
  >();
  for (const group of groups) {
    for (const reference of deliveredMediaReferences(group.block)) {
      let entry = draft.get(reference.mediaId);
      if (!entry) {
        entry = {
          blockIds: new Set(),
          deliveryIds: new Set(),
          allowsFullMedia: false,
          crops: [],
        };
        draft.set(reference.mediaId, entry);
      }
      entry.blockIds.add(group.block.id);
      for (const deliveryId of group.deliveryIds) entry.deliveryIds.add(deliveryId);
      if (reference.crop === undefined) {
        entry.allowsFullMedia = true;
        continue;
      }
      const crop = reference.crop;
      if (!entry.crops.some((existing) => sameCrop(existing, crop))) entry.crops.push(crop);
    }
  }
  const scope = new Map<string, DeliveredMediaEntry>();
  for (const [mediaId, entry] of draft) {
    scope.set(
      mediaId,
      deepFreeze({
        mediaId,
        blockIds: [...entry.blockIds].sort(),
        deliveryIds: [...entry.deliveryIds].sort(),
        allowsFullMedia: entry.allowsFullMedia,
        crops: entry.crops.map((crop) => ({
          topLeft: { ...crop.topLeft },
          bottomRight: { ...crop.bottomRight },
        })),
      }),
    );
  }
  return scope;
}

/**
 * Authorizes one display request against the delivered scope.
 *
 * This mirrors the host capability in `src/core/media-capability`: an
 * undelivered identifier is denied, and when every delivered reference carried
 * a crop, only a crop contained in one single delivered crop is permitted. A
 * region assembled from two delivered crops, an enlarged crop, and an implicit
 * full-image request are all refused.
 */
export function authorizeDeliveredMediaDisplay(
  scope: ReadonlyMap<string, DeliveredMediaEntry>,
  request: { readonly mediaId: string; readonly crop?: Rect },
): DeliveredMediaEntry {
  const entry = scope.get(request.mediaId);
  if (!entry) {
    throw consoleError("MEDIA_NOT_DELIVERED", "Media was not delivered to this Module job", {
      mediaId: request.mediaId,
    });
  }
  if (entry.allowsFullMedia) return entry;
  if (request.crop === undefined) {
    throw consoleError(
      "MEDIA_CROP_NOT_DELIVERED",
      "Every delivered reference for this Media carries a crop",
      { mediaId: request.mediaId },
    );
  }
  const crop = request.crop;
  if (!entry.crops.some((delivered) => cropContains(delivered, crop))) {
    throw consoleError(
      "MEDIA_CROP_NOT_DELIVERED",
      "Requested crop is not contained in any single delivered crop",
      { mediaId: request.mediaId },
    );
  }
  return entry;
}
