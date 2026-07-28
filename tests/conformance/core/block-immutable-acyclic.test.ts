import { describe, expect, it, vi } from "vitest";
import {
  BlockStore,
  BlockStoreError,
  type MediaReferenceResolver,
  type BlockProposal,
} from "../../../src/core/block-store.js";

const FIXED_TIME = "2026-07-24T00:00:00.000Z";

function textProposal(overrides: Partial<BlockProposal> = {}): BlockProposal {
  return {
    summary: "test block",
    payload: {
      schema: "dolly.content/1",
      value: {
        items: [{ type: "text", text: "hello", format: "plain" }],
      },
    },
    ...overrides,
  };
}

function createStore(
  ids: string[] = ["block-1", "block-2", "block-3"],
  media?: MediaReferenceResolver,
): BlockStore {
  let index = 0;
  return new BlockStore({
    nextBlockId: () => ids[index++] ?? `block-${index}`,
    now: () => FIXED_TIME,
    media,
  });
}

const moduleSource = { kind: "module", id: "module-a" } as const;

describe("CORE-003 immutable acyclic BlockStore", () => {
  it("assigns identity, sequence, source and time inside the runtime", () => {
    const store = createStore();
    const record = store.commit(textProposal(), moduleSource);

    expect(record).toMatchObject({
      schemaVersion: "dolly.block/2",
      id: "block-1",
      sequence: "1",
      source: moduleSource,
      createdAt: FIXED_TIME,
    });
  });

  it("rejects an ID collision atomically and preserves the original", () => {
    const store = createStore(["same-id", "same-id"]);
    const original = store.commit(textProposal({ summary: "original" }), moduleSource);

    expect(() =>
      store.commit(textProposal({ summary: "replacement" }), moduleSource),
    ).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_ID_CONFLICT" }),
    );

    expect(store.get("same-id")).toEqual(original);
    expect(store.size).toBe(1);
  });

  it("uses commit sequence rather than equal wall-clock timestamps", () => {
    const store = createStore();
    const first = store.commit(textProposal(), moduleSource);
    const second = store.commit(
      textProposal({
        payload: {
          schema: "dolly.content/1",
          value: {
            items: [
              { type: "text", text: "hello", format: "plain" },
              { type: "block-reference", blockId: first.id },
            ],
          },
        },
      }),
      moduleSource,
    );

    expect(first.createdAt).toBe(second.createdAt);
    expect(first.sequence).toBe("1");
    expect(second.sequence).toBe("2");
    expect((second.payload.value as { items: Array<{ blockId?: string }> }).items[1]?.blockId).toBe(first.id);
  });

  it("rejects missing and self references without consuming sequence", () => {
    const store = createStore(["missing-attempt", "self", "after"]);

    expect(() =>
      store.commit(
        textProposal({
          payload: {
            schema: "dolly.content/1",
            value: { items: [{ type: "block-reference", blockId: "does-not-exist" }] },
          },
        }),
        moduleSource,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_REFERENCE_MISSING" }),
    );

    expect(() =>
      store.commit(
        textProposal({
          payload: {
            schema: "dolly.content/1",
            value: { items: [{ type: "block-reference", blockId: "self" }] },
          },
        }),
        moduleSource,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_REFERENCE_SELF" }),
    );

    const after = store.commit(textProposal(), moduleSource);
    expect(after.sequence).toBe("1");
    expect(store.size).toBe(1);
  });

  it("does not expose mutable aliases from proposals or reads", () => {
    const store = createStore();
    const proposal = textProposal();
    const record = store.commit(proposal, moduleSource);

    (proposal.payload.value as { items: Array<{ text: string }> }).items[0]!.text =
      "mutated proposal";
    expect(
      ((store.get(record.id)!.payload.value as { items: Array<{ text: string }> })
        .items[0]!.text),
    ).toBe("hello");

    expect(() => {
      (record as { summary?: string }).summary = "mutated read";
    }).toThrow();
    expect(store.get(record.id)!.summary).toBe("test block");
  });

  it("uses content references as the only dependency source", () => {
    const resolve = vi.fn(() => ({ mediaId: "media-1" }));
    const store = createStore(undefined, { resolve });
    store.referenceGraph.registerNode({ kind: "media", id: "media-1" });
    const target = store.commit(textProposal(), moduleSource);

    const record = store.commit(
      textProposal({
        payload: {
          schema: "dolly.content/1",
          value: {
            items: [
              { type: "block-reference", blockId: target.id },
              { type: "media-reference", mediaId: "media-1" },
              { type: "media-reference", mediaId: "media-1" },
            ],
          },
        },
      }),
      moduleSource,
    );
    expect(record.payload.value).toMatchObject({
      items: [
        { type: "block-reference", blockId: target.id },
        { type: "media-reference", mediaId: "media-1" },
        { type: "media-reference", mediaId: "media-1" },
      ],
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    const blockNode = store.referenceGraph
      .snapshot()
      .nodes.find((node) => node.target.kind === "block" && node.target.id === record.id);
    expect(blockNode?.outgoing).toEqual([
      { kind: "block", id: target.id },
      { kind: "media", id: "media-1" },
    ]);
  });

  it.each(["refs", "attachments"])(
    "rejects the former top-level %s field instead of accepting two reference sources",
    (field) => {
      const store = createStore();
      const proposal = {
        ...textProposal(),
        [field]: [],
      } as unknown as BlockProposal;

      expect(() => store.commit(proposal, moduleSource)).toThrowError(
        expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_PROPOSAL_INVALID" }),
      );
      expect(store.size).toBe(0);
    },
  );

  it("rejects display-layout fields inside a Core reference", () => {
    const store = createStore(undefined, { resolve: () => ({ mediaId: "media-1" }) });
    expect(() =>
      store.commit(
        textProposal({
          payload: {
            schema: "dolly.content/1",
            value: {
              items: [
                { type: "media-reference", mediaId: "media-1", presentation: "block" },
              ],
            },
          },
        }),
        moduleSource,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<BlockStoreError>>({ code: "BLOCK_CONTENT_INVALID" }),
    );
  });

  it("treats URL, path, base64 and media-like payload keys as inert JSON", () => {
    const resolve = vi.fn();
    const store = createStore(undefined, { resolve });
    const record = store.commit(
      textProposal({
        payload: {
          schema: "com.example.inert/1",
          value: {
            url: "http://127.0.0.1/private",
            file: "C:\\private.txt",
            base64: "dGVzdA==",
            mediaId: "not-an-attachment",
          },
        },
      }),
      moduleSource,
    );

    expect(record.payload.value).toEqual({
      url: "http://127.0.0.1/private",
      file: "C:\\private.txt",
      base64: "dGVzdA==",
      mediaId: "not-an-attachment",
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});
