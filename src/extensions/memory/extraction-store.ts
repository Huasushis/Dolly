import { createHash } from "node:crypto";
import { deepFreeze } from "../../core/canonical-json.js";
import { memoryError } from "./errors.js";
import type { ExtractedSegment, ExtractionResult } from "./extraction.js";
import {
  assertNamespaceAuthorized,
  assertSameNamespace,
  authenticateDelivery,
  type MemoryAuthorization,
  type MemoryNamespace,
  type RetentionScopeKind,
  type RuntimeDeliveryContext,
} from "./namespace.js";

/**
 * The namespace-keyed extraction store from `docs/spec/memory-extension.md`
 * §4, §5.1, and §8.1.
 *
 * It records the items an allowlisted deterministic extractor already produced
 * (`ExtractionResult`), each tagged with the full §5.1 provenance: source Block
 * ID and core sequence, source Page and originating session, payload schema,
 * extractor ID/version, and the deterministic segment identity and boundaries.
 *
 * Isolation is structural, not by convention: storage is partitioned by the
 * authenticated six-tuple `namespaceKey`, so a read addressed to any other
 * namespace simply cannot resolve the same partition. Every method re-checks
 * the §4.3 authorization for its operation, and every returned item is
 * re-verified to belong to the requested namespace before it is handed back.
 *
 * Ordering is deterministic: committed order is source `coreSequence`, then
 * item index, then segment ordinal, then `extractionId` (§10.4/§11.4). The
 * same input therefore always yields the same stored set and the same read
 * order. Re-recording the same input is idempotent — a repeated Delivery of the
 * same Block produces no duplicate item (§3 invariant 2, §5.2).
 *
 * This component owns the in-memory namespace-keyed extraction view. Durable
 * journaling, feature jobs, and recovery are the `MemoryStore`'s concern; this
 * slice performs no background indexing and no model calls.
 */

export const EXTRACTION_ITEM_SCHEMA_VERSION = "dolly.memory-extraction-item/1";
const EXTRACTION_ITEM_DOMAIN = "dolly.memory-extraction-item-id/1";

/**
 * One extracted segment plus the §5.1 provenance tags of its source. Immutable
 * after construction; an extraction change produces a new `extractionId`, so
 * stored text and provenance are never mutated in place.
 */
export interface ExtractionItem {
  readonly schemaVersion: typeof EXTRACTION_ITEM_SCHEMA_VERSION;
  /**
   * Deterministic in the namespace, extractor, and segment. It is never
   * derived from wall-clock time, insertion order, or read order.
   */
  readonly extractionId: string;
  // Namespace identity (§4). Every component mirrors the authenticated tuple,
  // so no stored item can be re-addressed under a different namespace.
  readonly namespaceKey: string;
  readonly instanceId: string;
  readonly ownerScopeId: string;
  readonly memoryModuleInstanceId: string;
  readonly inputPageId: string;
  readonly retentionScopeKind: RetentionScopeKind;
  readonly retentionScopeId: string;
  // Provenance tags (§5.1).
  readonly deliveryId: string;
  readonly sourceBlockId: string;
  readonly coreSequence: number;
  readonly sourcePageId: string;
  readonly originatingSessionId: string;
  readonly payloadSchema: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  // The extracted segment, verbatim from the deterministic extractor (§8.1).
  readonly segmentId: string;
  readonly itemIndex: number;
  readonly segmentOrdinal: number;
  readonly segmentStartByte: number;
  readonly segmentEndByte: number;
  readonly text: string;
}

export interface RecordExtractionInput {
  readonly namespace: MemoryNamespace;
  readonly authorization: MemoryAuthorization;
  /** Delivery metadata the core supplied; the store never reads identity from a payload. */
  readonly delivery: RuntimeDeliveryContext;
  /** The authenticated session that produced the source Block (§5.1). */
  readonly originatingSessionId: string;
  /** The source Block's payload schema, a §5.1 provenance tag. */
  readonly payloadSchema: string;
  /** The deterministic output of an allowlisted extractor. */
  readonly extraction: ExtractionResult;
}

export interface ExtractionWriteResult {
  /** Freshly recorded items in the deterministic order of the input extraction. */
  readonly recorded: readonly ExtractionItem[];
  /** `extractionId`s already present in this namespace: the input was a repeat. */
  readonly duplicates: readonly string[];
}

/**
 * Deterministic, namespace-scoped identity of one extracted item. `segmentId`
 * already binds extractor, source Block, item index, segment ordinal, and text;
 * the namespace is added here so one Block extracted into two namespaces yields
 * two distinct, non-addressable-across items (§4.2).
 */
export function deriveExtractionId(options: {
  readonly namespaceKey: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly segmentId: string;
}): string {
  return createHash("sha256")
    .update(EXTRACTION_ITEM_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(options.namespaceKey, "utf8")
    .update("\0", "utf8")
    .update(options.extractorId, "utf8")
    .update("\0", "utf8")
    .update(options.extractorVersion, "utf8")
    .update("\0", "utf8")
    .update(options.segmentId, "utf8")
    .digest("hex");
}

/**
 * Committed order: source sequence, then item index, then segment ordinal,
 * then `extractionId` as the declared stable tie-break (§10.4). This is the
 * same ordering `planRetention` uses for records, so read order never depends
 * on insertion order, map iteration, or wall-clock time.
 */
export function compareExtractionItems(
  left: ExtractionItem,
  right: ExtractionItem,
): number {
  if (left.coreSequence !== right.coreSequence) return left.coreSequence - right.coreSequence;
  if (left.itemIndex !== right.itemIndex) return left.itemIndex - right.itemIndex;
  if (left.segmentOrdinal !== right.segmentOrdinal) {
    return left.segmentOrdinal - right.segmentOrdinal;
  }
  return left.extractionId < right.extractionId
    ? -1
    : left.extractionId > right.extractionId
      ? 1
      : 0;
}

export class ExtractionStore {
  /**
   * One partition per authenticated `namespaceKey`. A key contains every §4.1
   * component, so there is no shared default partition and no way to address
   * another namespace's partition from a different namespace.
   */
  readonly #partitions = new Map<string, Map<string, ExtractionItem>>();

  #partitionFor(namespace: MemoryNamespace): Map<string, ExtractionItem> {
    let partition = this.#partitions.get(namespace.namespaceKey);
    if (!partition) {
      partition = new Map();
      this.#partitions.set(namespace.namespaceKey, partition);
    }
    return partition;
  }

  #partitionOf(namespace: MemoryNamespace): Map<string, ExtractionItem> | undefined {
    return this.#partitions.get(namespace.namespaceKey);
  }

  /**
   * Records every segment of one deterministic extraction under the namespace,
   * each with its §5.1 provenance tags. Recording the same input again is
   * idempotent: the already-present `extractionId`s are returned as
   * `duplicates` and no item is replaced or duplicated (§3 invariant 2 §5.2).
   */
  recordExtraction(input: RecordExtractionInput): ExtractionWriteResult {
    assertNamespaceAuthorized(input.authorization, input.namespace, "index");
    const delivery = authenticateDelivery(input.delivery);
    // §4.2: the source Page comes from Delivery metadata and must be the Page
    // this namespace isolates. A delivery addressing another Page can never
    // record into this namespace's partition.
    if (delivery.inputPageId !== input.namespace.inputPageId) {
      throw memoryError(
        "MEMORY_NAMESPACE_MISMATCH",
        "Delivery source Page does not match the namespace input Page",
        { sourcePageId: delivery.inputPageId, inputPageId: input.namespace.inputPageId },
      );
    }

    const partition = this.#partitionFor(input.namespace);
    const recorded: ExtractionItem[] = [];
    const duplicates: string[] = [];

    for (const segment of input.extraction.segments) {
      const extractionId = deriveExtractionId({
        namespaceKey: input.namespace.namespaceKey,
        extractorId: input.extraction.extractorId,
        extractorVersion: input.extraction.extractorVersion,
        segmentId: segment.segmentId,
      });
      if (partition.has(extractionId)) {
        duplicates.push(extractionId);
        continue;
      }
      const item = createExtractionItem({
        namespace: input.namespace,
        delivery,
        originatingSessionId: input.originatingSessionId,
        payloadSchema: input.payloadSchema,
        extraction: input.extraction,
        segment,
        extractionId,
      });
      partition.set(extractionId, item);
      recorded.push(item);
    }

    return deepFreeze({ recorded, duplicates });
  }

  /**
   * All items of one namespace in deterministic committed order. An empty or
   * unknown namespace returns `[]`; items of every other namespace are
   * structurally unreachable.
   */
  readAll(
    namespace: MemoryNamespace,
    authorization: MemoryAuthorization,
  ): readonly ExtractionItem[] {
    assertNamespaceAuthorized(authorization, namespace, "query");
    const partition = this.#partitionOf(namespace);
    if (!partition) return deepFreeze([]);
    const items = [...partition.values()];
    for (const item of items) {
      assertSameNamespace(namespace, item.namespaceKey, "extraction item");
    }
    return deepFreeze(items.sort(compareExtractionItems));
  }

  /** Reads one item by its deterministic id; `undefined` when absent. */
  read(
    namespace: MemoryNamespace,
    authorization: MemoryAuthorization,
    extractionId: string,
  ): ExtractionItem | undefined {
    assertNamespaceAuthorized(authorization, namespace, "query");
    const partition = this.#partitionOf(namespace);
    const item = partition?.get(extractionId);
    if (!item) return undefined;
    assertSameNamespace(namespace, item.namespaceKey, "extraction item");
    return item;
  }

  /** Number of distinct extracted items committed under one namespace. */
  count(namespace: MemoryNamespace, authorization: MemoryAuthorization): number {
    assertNamespaceAuthorized(authorization, namespace, "query");
    return this.#partitionOf(namespace)?.size ?? 0;
  }
}

function createExtractionItem(options: {
  readonly namespace: MemoryNamespace;
  readonly delivery: RuntimeDeliveryContext;
  readonly originatingSessionId: string;
  readonly payloadSchema: string;
  readonly extraction: ExtractionResult;
  readonly segment: ExtractedSegment;
  readonly extractionId: string;
}): ExtractionItem {
  const { namespace, delivery, segment } = options;
  return deepFreeze({
    schemaVersion: EXTRACTION_ITEM_SCHEMA_VERSION,
    extractionId: options.extractionId,
    namespaceKey: namespace.namespaceKey,
    instanceId: namespace.instanceId,
    ownerScopeId: namespace.ownerScopeId,
    memoryModuleInstanceId: namespace.memoryModuleInstanceId,
    inputPageId: namespace.inputPageId,
    retentionScopeKind: namespace.retentionScopeKind,
    retentionScopeId: namespace.retentionScopeId,
    deliveryId: delivery.deliveryId,
    sourceBlockId: delivery.sourceBlockId,
    coreSequence: delivery.coreSequence,
    sourcePageId: delivery.inputPageId,
    originatingSessionId: options.originatingSessionId,
    payloadSchema: options.payloadSchema,
    extractorId: options.extraction.extractorId,
    extractorVersion: options.extraction.extractorVersion,
    segmentId: segment.segmentId,
    itemIndex: segment.itemIndex,
    segmentOrdinal: segment.segmentOrdinal,
    segmentStartByte: segment.startByte,
    segmentEndByte: segment.endByte,
    text: segment.text,
  }) as ExtractionItem;
}