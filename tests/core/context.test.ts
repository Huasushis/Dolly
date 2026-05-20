import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContextManager } from "../../src/core/context.js";

const cfg = { max_tokens: 100000, compression_threshold: 0.8 };

describe("ContextManager", () => {
  describe("addBlock / getBlocks", () => {
    it("adds block and returns it", () => {
      const ctx = new ContextManager(cfg);
      const b = ctx.addBlock("outer", "hello", { source: "test" });
      assert.equal(b.type, "outer");
      assert.equal(b.content, "hello");
      assert.ok(b.id);
      assert.ok(b.created > 0);
    });

    it("getBlocks returns system block + added blocks", () => {
      const ctx = new ContextManager(cfg);
      ctx.addBlock("outer", "a");
      ctx.addBlock("inner", "b");
      const blocks = ctx.getBlocks();
      assert.equal(blocks.length, 3); // system + 2
      assert.equal(blocks[0].type, "system");
    });
  });

  describe("removeBlock", () => {
    it("removes by id", () => {
      const ctx = new ContextManager(cfg);
      const b = ctx.addBlock("outer", "x");
      assert.ok(ctx.removeBlock(b.id));
      assert.equal(ctx.getBlocks().length, 1); // only system
    });

    it("cannot remove system block", () => {
      const ctx = new ContextManager(cfg);
      const sys = ctx.getBlocks()[0];
      assert.equal(ctx.removeBlock(sys.id), false);
    });
  });

  describe("restoreBlock", () => {
    it("preserves original id and created", () => {
      const ctx = new ContextManager(cfg);
      ctx.restoreBlock({ id: "abc-123", type: "outer", content: "old", meta: {}, created: 1600000000000 });
      const blocks = ctx.getBlocks();
      const restored = blocks.find(b => b.id === "abc-123");
      assert.ok(restored);
      assert.equal(restored.created, 1600000000000);
    });
  });

  describe("applyMutations / changeQueue", () => {
    it("returns changes from addBlock", () => {
      const ctx = new ContextManager(cfg);
      ctx.addBlock("outer", "x");
      const changes = ctx.applyMutations([]);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].type, "added");
    });

    it("drains queue after apply", () => {
      const ctx = new ContextManager(cfg);
      ctx.addBlock("outer", "x");
      ctx.applyMutations([]); // drain
      const changes = ctx.applyMutations([]);
      assert.equal(changes.length, 0);
    });
  });

  describe("decayCheck", () => {
    it("does not crash when called", () => {
      const ctx = new ContextManager(cfg);
      assert.doesNotThrow(() => ctx.decayCheck());
    });
  });

  describe("estimateTokens", () => {
    it("returns a positive number", () => {
      const ctx = new ContextManager(cfg);
      ctx.addBlock("outer", "hello world");
      assert.ok(ctx.estimateTokens() > 0);
    });
  });
});
