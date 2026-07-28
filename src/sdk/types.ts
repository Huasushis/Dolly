/**
 * Public software development kit (SDK) data types shared with extensions that
 * use Dolly's process protocol.
 *
 * This module deliberately exposes no filesystem paths, network clients,
 * secrets, reference counters, or host objects. Extensions request permitted
 * operations through the process protocol instead of receiving host authority.
 */
export type { JsonPrimitive, JsonValue } from "../core/canonical-json.js";
export type {
  BlockContent,
  BlockContentItem,
  BlockReferenceItem,
  DataContentItem,
  MediaReferenceItem,
  Rect,
  TextContentItem,
} from "../core/block-content.js";
export type {
  Block,
  BlockPayload,
  BlockProposal,
  SourceIdentity,
} from "../core/block-store.js";
