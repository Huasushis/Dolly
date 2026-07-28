import { describe, expect, it } from "vitest";
import * as sdk from "../../src/sdk/index.js";
import type {
  Block,
  BlockContent,
  BlockProposal,
  JsonValue,
} from "../../src/sdk/index.js";

describe("public software development kit", () => {
  it("exports data types without runtime host objects", () => {
    expect(Object.keys(sdk)).toEqual([]);
  });

  it("describes the current immutable Block content", () => {
    const content: BlockContent = {
      items: [
        { type: "text", text: "hello" },
        { type: "block-reference", blockId: "block-1" },
        { type: "media-reference", mediaId: "media-1" },
        { type: "data", schema: "example.data/1", value: { answer: 42 } },
      ],
    };
    const value: JsonValue = content;
    const proposal: BlockProposal = {
      payload: { schema: "dolly.content/1", value },
    };
    const block: Block = {
      schemaVersion: "dolly.block/2",
      id: "block-2",
      sequence: "2",
      source: { kind: "module", id: "module-1" },
      createdAt: "2026-07-25T00:00:00.000Z",
      payload: proposal.payload,
    };

    expect(block.payload.value).toBe(content);
  });
});
