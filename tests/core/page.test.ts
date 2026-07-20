import { describe, it, expect, beforeEach } from "vitest";
import { Page } from "../../src/core/page.js";
import type { Block } from "../../src/core/types.js";

function makeBlock(id: string, timestamp = Date.now()): Block {
  return { id, timestamp, description: `block-${id}`, source: "test", content: [], tensity: 1.0 };
}

describe("Page", () => {
  let page: Page;

  beforeEach(() => {
    page = new Page("test-page");
  });

  describe("append + consume", () => {
    it("should append and consume blocks with pointer advancement", () => {
      page.registerConsumer("c1");
      const b1 = makeBlock("b1");
      const b2 = makeBlock("b2");
      page.append(b1);
      page.append(b2);

      const result = page.consume("c1");
      expect(result).toEqual([b1, b2]);

      // Second consume returns empty (pointer moved)
      const result2 = page.consume("c1");
      expect(result2).toEqual([]);
    });

    it("should not return blocks appended before consumer registration", () => {
      const b1 = makeBlock("b1");
      page.append(b1);

      page.registerConsumer("c1");
      const result = page.consume("c1");
      expect(result).toEqual([]); // c1 registered after b1, so pointer starts at end
    });
  });

  describe("multiple consumers", () => {
    it("should maintain independent pointers", () => {
      page.registerConsumer("c1");
      page.registerConsumer("c2");

      const b1 = makeBlock("b1");
      page.append(b1);

      const r1 = page.consume("c1");
      expect(r1).toEqual([b1]);

      // c2 hasn't consumed yet
      const r2 = page.consume("c2");
      expect(r2).toEqual([b1]);
    });

    it("should autoPrune only when all consumers have passed", () => {
      page.registerConsumer("c1");
      page.registerConsumer("c2");

      page.append(makeBlock("b1"));
      page.append(makeBlock("b2"));

      // c1 consumes both
      page.consume("c1");
      // b1 and b2 should NOT be pruned because c2 hasn't consumed them yet
      expect(page.blockCount).toBe(2);

      // c2 consumes
      page.consume("c2");
      // Now both consumers have passed → autoPrune removes them
      expect(page.blockCount).toBe(0);
    });
  });

  describe("registerConsumer / unregisterConsumer", () => {
    it("should register consumer and list it", () => {
      page.registerConsumer("c1");
      expect(page.consumers).toContain("c1");
    });

    it("should not duplicate on re-register", () => {
      page.registerConsumer("c1");
      page.registerConsumer("c1");
      expect(page.consumers.filter((c) => c === "c1")).toHaveLength(1);
    });

    it("should unregister consumer and trigger prune", () => {
      page.registerConsumer("c1");
      page.registerConsumer("c2");
      page.append(makeBlock("b1"));

      page.consume("c1");
      // b1 still there because c2 hasn't consumed
      expect(page.blockCount).toBe(1);

      page.unregisterConsumer("c2");
      // Now only c1 remains and it has passed b1 → prune
      expect(page.blockCount).toBe(0);
    });

    it("should prune all blocks when no consumers remain", () => {
      // When no consumers are registered, autoPrune clears all blocks on append
      page.append(makeBlock("b1"));
      // autoPrune was called with 0 consumers → blocks cleared immediately
      expect(page.blockCount).toBe(0);

      page.append(makeBlock("b2"));
      expect(page.blockCount).toBe(0);
    });
  });

  describe("empty page consume", () => {
    it("should return empty array for unregistered consumer", () => {
      const result = page.consume("nonexistent");
      expect(result).toEqual([]);
    });

    it("should return empty array when no blocks exist", () => {
      page.registerConsumer("c1");
      const result = page.consume("c1");
      expect(result).toEqual([]);
    });
  });
});
