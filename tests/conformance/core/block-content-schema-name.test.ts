import { describe, expect, it } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { parseContentSchemaName } from "../../../src/core/block-content.js";

const NOW = "2026-08-10T10:00:00.000Z";

describe("structured-data content schema names", () => {
  it.each([
    "acme.note/1",
    "acme.task-checkpoint/27",
    "org.example.agent.memory/9999",
    "dolly.console.message-boundary/1",
  ])("accepts the exact owned and versioned form %s", (name) => {
    expect(parseContentSchemaName(name)).toBe(name);
  });

  it.each([
    "a/1",
    "Acme.note/1",
    "acme_note.value/1",
    "acme:note.value/1",
    "acme.note/0",
    "acme.note/01",
    "acme.note/10000",
    "acme.note",
    "acme.note/1/extra",
    " acme.note/1",
  ])("refuses an ambiguous or unversioned name %s", (name) => {
    expect(() => parseContentSchemaName(name)).toThrow(/lowercase dotted name/u);
  });

  it("rejects an invalid name before allocating a Block identifier", () => {
    let issued = 0;
    const blocks = new BlockStore({
      nextBlockId: () => `block-${(issued += 1)}`,
      now: () => NOW,
    });

    expect(() => blocks.commit({
      payload: {
        schema: "dolly.content/1",
        value: {
          items: [{ type: "data", schema: "unowned/1", value: { accepted: false } }],
        },
      },
    }, { kind: "module", id: "module-a" })).toThrow(/content\.items\[0\]\.schema/u);

    expect(issued).toBe(0);
    expect(blocks.size).toBe(0);
  });
});
