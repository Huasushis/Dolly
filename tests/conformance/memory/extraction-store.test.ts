import { describe, expect, it } from "vitest";

import { MemoryError } from "../../../src/extensions/memory/errors.js";
import {
  createTextContentExtractor,
  type ExtractionResult,
  type MemorySourceBlock,
} from "../../../src/extensions/memory/extraction.js";
import {
  compareExtractionItems,
  ExtractionStore,
  deriveExtractionId,
  type ExtractionItem,
  type ExtractionWriteResult,
} from "../../../src/extensions/memory/extraction-store.js";
import {
  type MemoryAuthorization,
  type MemoryNamespace,
  type MemoryOperation,
  type RuntimeDeliveryContext,
} from "../../../src/extensions/memory/namespace.js";
import {
  delivered,
  grantAll,
  identity,
  namespaceFor,
  textBlock,
} from "./fixtures.js";

const EXTRACTOR = createTextContentExtractor();

/** A text long enough that the contract splits it into several segments. */
const LONG_TEXT = `${"alpha ".repeat(150)}end`;

function recordBlock(
  store: ExtractionStore,
  namespace: MemoryNamespace,
  authorization: MemoryAuthorization,
  options: {
    readonly deliveryId: string;
    readonly sourceBlockId: string;
    readonly block: MemorySourceBlock;
    readonly coreSequence?: number;
    readonly pageSequence?: number;
    readonly sessionId?: string;
  },
): {
  readonly delivery: RuntimeDeliveryContext;
  readonly extraction: ExtractionResult;
  readonly result: ExtractionWriteResult;
} {
  const input = delivered({
    deliveryId: options.deliveryId,
    sourceBlockId: options.sourceBlockId,
    block: options.block,
    inputPageId: namespace.inputPageId,
    coreSequence: options.coreSequence,
    pageSequence: options.pageSequence,
  });
  const extraction = EXTRACTOR.extract({
    sourceBlockId: options.sourceBlockId,
    payloadSchema: options.block.payloadSchema,
    content: options.block.content,
  });
  const result = store.recordExtraction({
    namespace,
    authorization,
    delivery: input.delivery,
    originatingSessionId: options.sessionId ?? "session-1",
    payloadSchema: options.block.payloadSchema,
    extraction,
  });
  return { delivery: input.delivery, extraction, result };
}

function grantOnly(
  namespace: MemoryNamespace,
  operations: readonly MemoryOperation[],
): MemoryAuthorization {
  return { grants: [{ namespaceKey: namespace.namespaceKey, operations }] };
}

function snapshot(store: ExtractionStore, namespace: MemoryNamespace): readonly ExtractionItem[] {
  return store.readAll(namespace, grantAll(namespace));
}

function prose(
  items: readonly ExtractionItem[],
): readonly { coreSequence: number; itemIndex: number; segmentOrdinal: number; text: string; sourceBlockId: string }[] {
  return items.map((item) => ({
    coreSequence: item.coreSequence,
    itemIndex: item.itemIndex,
    segmentOrdinal: item.segmentOrdinal,
    text: item.text,
    sourceBlockId: item.sourceBlockId,
  }));
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof MemoryError) return error.code;
    throw error;
  }
  return "no-error";
}

/** §5.1: every stored item carries its complete provenance tags. */
describe("the extraction store records provenance", () => {
  it("stores every segment with its §5.1 provenance tags verbatim", () => {
    const namespace = namespaceFor();
    const authorization = grantAll(namespace);
    const store = new ExtractionStore();

    const { delivery, extraction, result } = recordBlock(store, namespace, authorization, {
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock("the quick brown fox"),
      coreSequence: 7,
    });

    expect(result.recorded).toHaveLength(extraction.segments.length);
    const item = result.recorded[0]!;
    expect(item.schemaVersion).toBe("dolly.memory-extraction-item/1");
    expect(item.namespaceKey).toBe(namespace.namespaceKey);
    expect(item.instanceId).toBe(namespace.instanceId);
    expect(item.ownerScopeId).toBe(namespace.ownerScopeId);
    expect(item.memoryModuleInstanceId).toBe(namespace.memoryModuleInstanceId);
    expect(item.inputPageId).toBe(namespace.inputPageId);
    expect(item.retentionScopeKind).toBe(namespace.retentionScopeKind);
    expect(item.retentionScopeId).toBe(namespace.retentionScopeId);
    expect(item.deliveryId).toBe("d1");
    expect(item.sourceBlockId).toBe("b1");
    expect(item.coreSequence).toBe(7);
    expect(item.sourcePageId).toBe(delivery.inputPageId);
    expect(item.originatingSessionId).toBe("session-1");
    expect(item.payloadSchema).toBe("dolly.content/1");
    expect(item.extractorId).toBe("dolly.memory.text-content");
    expect(item.extractorVersion).toBe("1");
    expect(item.segmentId).toBe(extraction.segments[0]!.segmentId);
    expect(item.itemIndex).toBe(0);
    expect(item.segmentOrdinal).toBe(0);
    expect(item.segmentStartByte).toBe(0);
    expect(item.segmentEndByte).toBe(Buffer.byteLength("the quick brown fox", "utf8"));
    expect(item.text).toBe("the quick brown fox");
  });

  it("preserves each segment's boundaries and text for a multi-segment block", () => {
    const namespace = namespaceFor();
    const store = new ExtractionStore();
    const { extraction, result } = recordBlock(store, namespace, grantAll(namespace), {
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock(LONG_TEXT),
      coreSequence: 1,
    });

    expect(extraction.segments.length).toBeGreaterThan(1);
    expect(result.recorded.map((item) => item.segmentId)).toEqual(
      extraction.segments.map((segment) => segment.segmentId),
    );
    for (let index = 0; index < result.recorded.length; index += 1) {
      const item = result.recorded[index]!;
      const segment = extraction.segments[index]!;
      expect(item.text).toBe(segment.text);
      expect(item.segmentStartByte).toBe(segment.startByte);
      expect(item.segmentEndByte).toBe(segment.endByte);
    }
  });

  it("freezes every stored item so prior provenance cannot be mutated", () => {
    const namespace = namespaceFor();
    const store = new ExtractionStore();
    const { result } = recordBlock(store, namespace, grantAll(namespace), {
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock("immutable"),
    });
    for (const item of result.recorded) {
      expect(Object.isFrozen(item)).toBe(true);
    }
    expect(Object.isFrozen(store.readAll(namespace, grantAll(namespace)))).toBe(true);
  });
});

/** §10.4/§11.4: same input always produces the same stored set and order. */
describe("the extraction store is deterministic", () => {
  it("produces identical items and order for identical input across fresh stores", () => {
    const first = new ExtractionStore();
    const second = new ExtractionStore();
    const namespace = namespaceFor();
    const authorization = grantAll(namespace);

    // Insertion order is deliberately reversed between the two stores.
    recordBlock(first, namespace, authorization, {
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock("first block"),
      coreSequence: 10,
    });
    recordBlock(first, namespace, authorization, {
      deliveryId: "d2",
      sourceBlockId: "b2",
      block: textBlock(LONG_TEXT),
      coreSequence: 4,
    });

    recordBlock(second, namespace, authorization, {
      deliveryId: "d2",
      sourceBlockId: "b2",
      block: textBlock(LONG_TEXT),
      coreSequence: 4,
    });
    recordBlock(second, namespace, authorization, {
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock("first block"),
      coreSequence: 10,
    });

    expect(prose(snapshot(first, namespace))).toEqual(prose(snapshot(second, namespace)));
  });

  it("returns committed order (core sequence, then segment position) regardless of insertion order", () => {
    const namespace = namespaceFor();
    const store = new ExtractionStore();
    const authorization = grantAll(namespace);

    recordBlock(store, namespace, authorization, {
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock("late core sequence"),
      coreSequence: 5,
    });
    recordBlock(store, namespace, authorization, {
      deliveryId: "d2",
      sourceBlockId: "b2",
      block: textBlock("early core sequence"),
      coreSequence: 2,
    });

    const items = snapshot(store, namespace);
    expect(items.map((item) => item.coreSequence)).toEqual([2, 5]);
    // The order is also a total order: every adjacent pair satisfies it.
    for (let index = 1; index < items.length; index += 1) {
      expect(compareExtractionItems(items[index - 1]!, items[index]!)).toBeLessThan(0);
    }
  });

  it("breaks ties on equal core sequence deterministically", () => {
    const namespace = namespaceFor();
    const store = new ExtractionStore();
    const authorization = grantAll(namespace);

    recordBlock(store, namespace, authorization, {
      deliveryId: "d1",
      sourceBlockId: "a-block",
      block: textBlock("same sequence"),
      coreSequence: 3,
    });
    recordBlock(store, namespace, authorization, {
      deliveryId: "d2",
      sourceBlockId: "z-block",
      block: textBlock("same sequence"),
      coreSequence: 3,
    });

    const items = snapshot(store, namespace);
    expect(items).toHaveLength(2);
    const ids = items.map((item) => item.extractionId);
    expect(ids).toEqual([...ids].sort());
  });

  it("records a repeated identical input idempotently and reports duplicates", () => {
    const namespace = namespaceFor();
    const store = new ExtractionStore();
    const authorization = grantAll(namespace);

    const first = recordBlock(store, namespace, authorization, {
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock(LONG_TEXT),
      coreSequence: 1,
    });
    expect(first.result.recorded.length).toBeGreaterThan(1);

    // The same input again: no new items, ids reported as duplicates.
    const again = recordBlock(store, namespace, authorization, {
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock(LONG_TEXT),
      coreSequence: 1,
    });
    expect(again.result.recorded).toEqual([]);
    expect([...again.result.duplicates].sort()).toEqual(
      first.result.recorded.map((item) => item.extractionId).sort(),
    );
    expect(store.count(namespace, authorization)).toBe(first.result.recorded.length);
    expect(prose(snapshot(store, namespace))).toEqual(prose(first.result.recorded));

    // A later Delivery of the same immutable Block is still one item (§5.2).
    const reDelivered = recordBlock(store, namespace, authorization, {
      deliveryId: "d9",
      sourceBlockId: "b1",
      block: textBlock(LONG_TEXT),
      coreSequence: 1,
      pageSequence: 2,
    });
    expect(reDelivered.result.recorded).toEqual([]);
    expect(reDelivered.result.duplicates).toHaveLength(first.result.recorded.length);
    expect(store.count(namespace, authorization)).toBe(first.result.recorded.length);
  });

  it("scopes deterministic identity to the namespace", () => {
    const store = new ExtractionStore();
    const ownerA = namespaceFor();
    const ownerB = namespaceFor({ identity: identity({ sessionId: "session-2" }) });

    const a = recordBlock(store, ownerA, grantAll(ownerA), {
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock("identity is scoped"),
    });
    const b = recordBlock(store, ownerB, grantAll(ownerB), {
      deliveryId: "d2",
      sourceBlockId: "b1",
      block: textBlock("identity is scoped"),
    });

    const aId = a.result.recorded[0]!.extractionId;
    const bId = b.result.recorded[0]!.extractionId;
    expect(aId).not.toBe(bId);
    expect(aId).toBe(
      deriveExtractionId({
        namespaceKey: ownerA.namespaceKey,
        extractorId: "dolly.memory.text-content",
        extractorVersion: "1",
        segmentId: a.extraction.segments[0]!.segmentId,
      }),
    );
  });
});

/** §4.2/§4.3: no cross-namespace reads and per-operation authorization. */
describe("the extraction store isolates namespaces", () => {
  it("hides one namespace's items from another namespace's reads", () => {
    const store = new ExtractionStore();
    const ownerA = namespaceFor();
    const ownerB = namespaceFor({ identity: identity({ sessionId: "session-2" }) });

    recordBlock(store, ownerA, grantAll(ownerA), {
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock("private to owner a"),
    });

    // B cannot see A's items, and cannot even learn that A has any.
    expect(snapshot(store, ownerB)).toEqual([]);
    expect(store.count(ownerB, grantAll(ownerB))).toBe(0);
    const aId = snapshot(store, ownerA)[0]!.extractionId;
    expect(store.read(ownerB, grantAll(ownerB), aId)).toBeUndefined();

    // Recording the identical block into B stays in B's partition.
    const b = recordBlock(store, ownerB, grantAll(ownerB), {
      deliveryId: "d2",
      sourceBlockId: "b1",
      block: textBlock("private to owner a"),
    });
    expect(b.result.recorded).toHaveLength(1);
    expect(store.count(ownerB, grantAll(ownerB))).toBe(1);
    // A's partition is untouched by B's write.
    expect(store.count(ownerA, grantAll(ownerA))).toBe(1);
  });

  it("keeps two input Pages of one Module in separate partitions (§4.2)", () => {
    const store = new ExtractionStore();
    const pageMain = namespaceFor({ inputPageId: "page-main" });
    const pageTwo = namespaceFor({ inputPageId: "page-two" });

    recordBlock(store, pageMain, grantAll(pageMain), {
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock("page main only"),
    });
    recordBlock(store, pageTwo, grantAll(pageTwo), {
      deliveryId: "d2",
      sourceBlockId: "b1",
      block: textBlock("page main only"),
    });

    expect(snapshot(store, pageMain)).toHaveLength(1);
    expect(snapshot(store, pageTwo)).toHaveLength(1);
    const mainId = snapshot(store, pageMain)[0]!.extractionId;
    expect(store.read(pageTwo, grantAll(pageTwo), mainId)).toBeUndefined();
  });

  it("fails closed when the authorization does not grant the namespace", () => {
    const namespace = namespaceFor();
    const stranger = grantOnly(namespaceFor({ identity: identity({ ownerScopeId: "owner-x" }) }), [
      "query",
      "index",
    ]);
    const store = new ExtractionStore();

    expect(
      codeOf(() =>
        recordBlock(store, namespace, stranger, {
          deliveryId: "d1",
          sourceBlockId: "b1",
          block: textBlock("denied"),
        }),
      ),
    ).toBe("MEMORY_SCOPE_DENIED");
    expect(codeOf(() => store.readAll(namespace, stranger))).toBe("MEMORY_SCOPE_DENIED");
    expect(codeOf(() => store.read(namespace, stranger, "any"))).toBe("MEMORY_SCOPE_DENIED");
    expect(codeOf(() => store.count(namespace, stranger))).toBe("MEMORY_SCOPE_DENIED");
  });

  it("rechecks the operation grant per call, not only at store creation", () => {
    const namespace = namespaceFor();
    const store = new ExtractionStore();

    // Reads need "query"; writes need "index". Neither grant covers both.
    expect(
      codeOf(() =>
        recordBlock(store, namespace, grantOnly(namespace, ["query"]), {
          deliveryId: "d1",
          sourceBlockId: "b1",
          block: textBlock("index denied"),
        }),
      ),
    ).toBe("MEMORY_SCOPE_DENIED");
    expect(
      recordBlock(store, namespace, grantOnly(namespace, ["index"]), {
        deliveryId: "d1",
        sourceBlockId: "b1",
        block: textBlock("allowed"),
      }).result.recorded,
    ).toHaveLength(1);
    expect(codeOf(() => store.readAll(namespace, grantOnly(namespace, ["index"])))).toBe(
      "MEMORY_SCOPE_DENIED",
    );
    // A "query" grant authorizes the read; an unknown id is simply absent.
    expect(store.read(namespace, grantOnly(namespace, ["query"]), "anything")).toBeUndefined();
  });

  it("rejects a Delivery whose source Page does not match the namespace Page", () => {
    const namespace = namespaceFor();
    const store = new ExtractionStore();
    const input = delivered({
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: textBlock("cross-page"),
      inputPageId: "page-other",
    });
    const extraction = EXTRACTOR.extract({
      sourceBlockId: "b1",
      payloadSchema: "dolly.content/1",
      content: input.block.content,
    });

    expect(
      codeOf(() =>
        store.recordExtraction({
          namespace,
          authorization: grantAll(namespace),
          delivery: input.delivery,
          originatingSessionId: "session-1",
          payloadSchema: "dolly.content/1",
          extraction,
        }),
      ),
    ).toBe("MEMORY_NAMESPACE_MISMATCH");
    expect(store.count(namespace, grantAll(namespace))).toBe(0);
  });
});