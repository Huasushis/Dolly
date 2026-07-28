import { createHash } from "node:crypto";
import type { BlockContent } from "../../core/block-content.js";
import { deepFreeze } from "../../core/canonical-json.js";
import { memoryError } from "./errors.js";

/**
 * Deterministic, allowlisted text extraction from `docs/spec/memory-extension.md`
 * §8.1, plus the loop-prevention exclusions from §7.
 *
 * Nothing here stringifies arbitrary JSON, scans opaque fields for text, reads a
 * filename or URL as content, or indexes an unknown schema. An extractor is
 * selected by exact payload schema; an unknown schema produces
 * `MEMORY_EXTRACTOR_UNKNOWN`, never a best-effort guess.
 */

/** First-party control schemas. §7 excludes both from feature extraction. */
export const MEMORY_QUERY_SCHEMA = "dolly.memory.query/1";
export const MEMORY_RECALL_SCHEMA = "dolly.memory.recall/1";
export const MEMORY_CONTROL_SCHEMAS: readonly string[] = deepFreeze([
  MEMORY_QUERY_SCHEMA,
  MEMORY_RECALL_SCHEMA,
]);

const SEGMENT_DOMAIN = "dolly.memory-segment/1";

export type ExtractionSkipReason =
  /** §7 A first-party Memory control item is never a feature source. */
  | "MEMORY_CONTROL_ITEM"
  /** §8.1 The item's type or schema is not a permitted text field. */
  | "SCHEMA_NOT_ALLOWLISTED"
  /** §8.1 The item exceeded the declared maximum input bytes. */
  | "TEXT_INPUT_TOO_LARGE"
  /** The item carried no permitted text after normalization. */
  | "TEXT_EMPTY";

export interface ExtractedSegment {
  /** Deterministic in the input and extractor version; independent of namespace. */
  readonly segmentId: string;
  readonly itemIndex: number;
  readonly segmentOrdinal: number;
  /** Byte offsets into the normalized item text. */
  readonly startByte: number;
  readonly endByte: number;
  readonly text: string;
}

export interface ExtractionSkip {
  readonly itemIndex: number;
  readonly reason: ExtractionSkipReason;
  /** An item type or first-party schema name; never the item's content. */
  readonly subject?: string;
}

/**
 * A media item that reached the extractor. The baseline records only its
 * identity: modality comes from the media store through the feature plan
 * (§8.3), never from a caption, filename, or URL in the payload.
 */
export interface MediaCandidate {
  readonly itemIndex: number;
  readonly mediaId: string;
  readonly hasCrop: boolean;
}

export interface ExtractionResult {
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly segments: readonly ExtractedSegment[];
  readonly skipped: readonly ExtractionSkip[];
  readonly mediaCandidates: readonly MediaCandidate[];
}

export interface TextExtractorContract {
  readonly extractorId: string;
  readonly extractorVersion: string;
  /** Exact payload schemas this extractor accepts. */
  readonly payloadSchemas: readonly string[];
  /** Exact fields this extractor reads. Nothing else in the payload is text. */
  readonly acceptedFields: readonly string[];
  readonly unicodeNormalization: "NFC";
  readonly whitespace: "collapse-runs-to-single-space";
  readonly maxInputBytes: number;
  readonly maxSegmentBytes: number;
  readonly segmentOverlapBytes: number;
  readonly maxSegmentsPerItem: number;
  readonly maxItems: number;
  /** Declared, and empty: the baseline redacts nothing and claims nothing. */
  readonly redactionRules: readonly string[];
}

export interface TextExtractor {
  readonly contract: TextExtractorContract;
  extract(options: {
    readonly sourceBlockId: string;
    readonly payloadSchema: string;
    readonly content: BlockContent;
  }): ExtractionResult;
}

/**
 * The source Block as Memory sees it: a payload schema plus validated content.
 * The producing Module and Page are Delivery metadata and are deliberately not
 * part of this structure, so no extractor can read identity out of a payload.
 */
export interface MemorySourceBlock {
  readonly payloadSchema: string;
  readonly content: BlockContent;
}

export const DOLLY_CONTENT_TEXT_EXTRACTOR_CONTRACT: TextExtractorContract = deepFreeze({
  extractorId: "dolly.memory.text-content",
  extractorVersion: "1",
  payloadSchemas: ["dolly.content/1"],
  acceptedFields: ['items[].text where type === "text"'],
  unicodeNormalization: "NFC",
  whitespace: "collapse-runs-to-single-space",
  maxInputBytes: 64 * 1_024,
  maxSegmentBytes: 512,
  segmentOverlapBytes: 64,
  maxSegmentsPerItem: 64,
  maxItems: 256,
  redactionRules: [] as readonly string[],
} as TextExtractorContract);

/**
 * Normalization declared by the contract above. It is pure and total, so the
 * same item text always produces the same segment IDs.
 */
export function normalizeExtractedText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * Splits normalized text into bounded segments at code point boundaries.
 *
 * Overlap is declared by the contract and applied as a byte stride, so the
 * boundaries depend only on the text and the contract, never on wall-clock
 * time, iteration order, or how many items preceded this one.
 */
function segmentText(
  text: string,
  contract: TextExtractorContract,
): readonly { readonly startByte: number; readonly endByte: number; readonly text: string }[] {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= contract.maxSegmentBytes) {
    return [{ startByte: 0, endByte: bytes.length, text }];
  }
  const stride = contract.maxSegmentBytes - contract.segmentOverlapBytes;
  const segments: { startByte: number; endByte: number; text: string }[] = [];
  let start = 0;
  while (start < bytes.length && segments.length < contract.maxSegmentsPerItem) {
    let end = Math.min(start + contract.maxSegmentBytes, bytes.length);
    // Retreat to a code point boundary: continuation bytes are 0b10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    if (end <= start) break;
    segments.push({
      startByte: start,
      endByte: end,
      text: bytes.subarray(start, end).toString("utf8"),
    });
    if (end >= bytes.length) break;
    let next = start + stride;
    while (next < bytes.length && (bytes[next]! & 0xc0) === 0x80) next += 1;
    if (next <= start) break;
    start = next;
  }
  return segments;
}

export function deriveSegmentId(options: {
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly sourceBlockId: string;
  readonly itemIndex: number;
  readonly segmentOrdinal: number;
  readonly text: string;
}): string {
  return createHash("sha256")
    .update(SEGMENT_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(options.extractorId, "utf8")
    .update("\0", "utf8")
    .update(options.extractorVersion, "utf8")
    .update("\0", "utf8")
    .update(options.sourceBlockId, "utf8")
    .update("\0", "utf8")
    .update(String(options.itemIndex), "utf8")
    .update("\0", "utf8")
    .update(String(options.segmentOrdinal), "utf8")
    .update("\0", "utf8")
    .update(options.text, "utf8")
    .digest("hex");
}

export function createTextContentExtractor(
  contract: TextExtractorContract = DOLLY_CONTENT_TEXT_EXTRACTOR_CONTRACT,
): TextExtractor {
  return {
    contract,
    extract({ sourceBlockId, payloadSchema, content }): ExtractionResult {
      if (!contract.payloadSchemas.includes(payloadSchema)) {
        throw memoryError(
          "MEMORY_EXTRACTOR_UNKNOWN",
          "No allowlisted extractor accepts this payload schema",
          { payloadSchema, extractorId: contract.extractorId },
        );
      }
      if (!content || !Array.isArray(content.items)) {
        throw memoryError("MEMORY_EXTRACTION_INVALID", "Block content items are missing", {
          payloadSchema,
        });
      }
      if (content.items.length > contract.maxItems) {
        throw memoryError("MEMORY_LIMIT_EXCEEDED", "Block content exceeds maxItems", {
          limit: "maxItems",
          allowed: contract.maxItems,
        });
      }
      const segments: ExtractedSegment[] = [];
      const skipped: ExtractionSkip[] = [];
      const mediaCandidates: MediaCandidate[] = [];

      content.items.forEach((item, itemIndex) => {
        if (item.type === "block-reference") {
          skipped.push({
            itemIndex,
            reason: "SCHEMA_NOT_ALLOWLISTED",
            subject: "block-reference",
          });
          return;
        }
        if (item.type === "media-reference") {
          mediaCandidates.push({
            itemIndex,
            mediaId: item.mediaId,
            hasCrop: item.crop !== undefined,
          });
          return;
        }
        if (item.type === "data") {
          // §7: a Memory control value is never a feature source, even when a
          // different Memory instance produced it. Every other data schema is
          // skipped too, because §8.1 forbids indexing an unknown schema.
          skipped.push({
            itemIndex,
            reason: MEMORY_CONTROL_SCHEMAS.includes(item.schema)
              ? "MEMORY_CONTROL_ITEM"
              : "SCHEMA_NOT_ALLOWLISTED",
            subject: item.schema,
          });
          return;
        }
        if (Buffer.byteLength(item.text, "utf8") > contract.maxInputBytes) {
          skipped.push({ itemIndex, reason: "TEXT_INPUT_TOO_LARGE" });
          return;
        }
        const normalized = normalizeExtractedText(item.text);
        if (normalized.length === 0) {
          skipped.push({ itemIndex, reason: "TEXT_EMPTY" });
          return;
        }
        segmentText(normalized, contract).forEach((piece, segmentOrdinal) => {
          segments.push({
            segmentId: deriveSegmentId({
              extractorId: contract.extractorId,
              extractorVersion: contract.extractorVersion,
              sourceBlockId,
              itemIndex,
              segmentOrdinal,
              text: piece.text,
            }),
            itemIndex,
            segmentOrdinal,
            startByte: piece.startByte,
            endByte: piece.endByte,
            text: piece.text,
          });
        });
      });

      return deepFreeze({
        extractorId: contract.extractorId,
        extractorVersion: contract.extractorVersion,
        segments,
        skipped,
        mediaCandidates,
      });
    },
  };
}

/**
 * The lexical analyzer. It is part of the IndexGeneration identity (§10.2), so
 * its identity and version are exported rather than inlined at call sites.
 */
export const LEXICAL_ANALYZER_ID = "dolly.memory.lexical.unicode-word";
export const LEXICAL_ANALYZER_VERSION = "1";

export function lexicalTokens(text: string): readonly string[] {
  const matches = text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ?? [];
}
