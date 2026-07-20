import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BlockManager } from "../../src/core/block-manager.js";
import type { Block } from "../../src/core/types.js";
import type { MediaManager } from "../../src/core/media.js";

function createMockMediaManager(): MediaManager {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    get: vi.fn(),
    getMeta: vi.fn(),
    register: vi.fn(),
    destroy: vi.fn(),
    startCleanup: vi.fn(),
    stop: vi.fn(),
    crop: vi.fn(),
  } as unknown as MediaManager;
}

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: overrides.id ?? "block_" + Math.random().toString(36).slice(2, 8),
    timestamp: overrides.timestamp ?? Date.now(),
    description: overrides.description ?? "test block",
    source: overrides.source ?? "test-source",
    content: overrides.content ?? [],
    tensity: overrides.tensity ?? 1.0,
  };
}

describe("BlockManager", () => {
  let bm: BlockManager;
  let mediaManager: MediaManager;

  beforeEach(() => {
    mediaManager = createMockMediaManager();
    bm = new BlockManager(mediaManager, { ttlMs: 100, cleanupIntervalMs: 50 });
  });

  afterEach(() => {
    bm.stop();
  });

  describe("register", () => {
    it("should register a block successfully", () => {
      const block = makeBlock();
      bm.register(block);
      expect(bm.get(block.id)).toEqual(block);
    });

    it("should allow duplicate IDs (overwrites)", () => {
      const block1 = makeBlock({ id: "dup" });
      const block2 = makeBlock({ id: "dup" });
      bm.register(block1);
      bm.register(block2);
      expect(bm.get("dup")).toEqual(block2);
    });

    it("should reject forward reference to unknown block", () => {
      const block = makeBlock({
        content: [{ _forwardBlockId: "nonexistent" }],
      });
      expect(() => bm.register(block)).toThrow("Forward reference to unknown block");
    });

    it("should reject forward reference with timestamp violation", () => {
      const earlier = makeBlock({ id: "earlier", timestamp: 2000 });
      bm.register(earlier);

      const forwardBlock = makeBlock({
        id: "forwarder",
        timestamp: 1000, // earlier than referenced block
        content: [{ _forwardBlockId: "earlier" }],
      });
      expect(() => bm.register(forwardBlock)).toThrow("timestamp violation");
    });

    it("should accept valid forward reference", () => {
      const earlier = makeBlock({ id: "base", timestamp: 1000 });
      bm.register(earlier);

      const forwardBlock = makeBlock({
        id: "forwarder",
        timestamp: 2000,
        content: [{ _forwardBlockId: "base" }],
      });
      expect(() => bm.register(forwardBlock)).not.toThrow();
    });

    it("should acquire media references on register", () => {
      const block = makeBlock({
        content: [{ _mediaId: "media1" }, { _mediaId: "media2" }],
      });
      bm.register(block);
      expect(mediaManager.acquire).toHaveBeenCalledWith("media1");
      expect(mediaManager.acquire).toHaveBeenCalledWith("media2");
    });

    it("should increment forward block ref count", () => {
      const base = makeBlock({ id: "base", timestamp: 1000 });
      bm.register(base);

      const forwarder = makeBlock({
        id: "fwd",
        timestamp: 2000,
        content: [{ _forwardBlockId: "base" }],
      });
      bm.register(forwarder);

      // base should have refCount 1 (from forward reference)
      bm.acquire("base");
      bm.release("base");
      // Still alive since forward ref keeps count at 1
      expect(bm.get("base")).not.toBeNull();
    });
  });

  describe("acquire/release", () => {
    it("should increment and decrement ref count", () => {
      const block = makeBlock();
      bm.register(block);

      bm.acquire(block.id);
      bm.acquire(block.id);
      bm.release(block.id);
      // refCount should be 1 now, block still exists
      expect(bm.get(block.id)).not.toBeNull();
    });

    it("should not go below 0 on release", () => {
      const block = makeBlock();
      bm.register(block);
      bm.release(block.id);
      bm.release(block.id);
      // Should not throw
      expect(bm.get(block.id)).not.toBeNull();
    });

    it("should be no-op for non-existent block", () => {
      expect(() => bm.acquire("nope")).not.toThrow();
      expect(() => bm.release("nope")).not.toThrow();
    });
  });

  describe("TTL cleanup (sweep)", () => {
    it("should remove expired blocks with refCount 0", async () => {
      const block = makeBlock({ timestamp: Date.now() - 200 }); // 200ms ago, TTL is 100ms
      bm.register(block);

      // Access private sweep via startCleanup trigger
      bm.startCleanup(10);
      await new Promise((r) => setTimeout(r, 50));
      bm.stop();

      expect(bm.get(block.id)).toBeNull();
    });

    it("should NOT remove blocks with refCount > 0", async () => {
      const block = makeBlock({ timestamp: Date.now() - 200 });
      bm.register(block);
      bm.acquire(block.id);

      bm.startCleanup(10);
      await new Promise((r) => setTimeout(r, 50));
      bm.stop();

      expect(bm.get(block.id)).not.toBeNull();
    });

    it("should release media references on eviction", async () => {
      const block = makeBlock({
        timestamp: Date.now() - 200,
        content: [{ _mediaId: "m1" }],
      });
      bm.register(block);

      bm.startCleanup(10);
      await new Promise((r) => setTimeout(r, 50));
      bm.stop();

      expect(mediaManager.release).toHaveBeenCalledWith("m1");
    });

    it("should release forward block references on eviction", async () => {
      const base = makeBlock({ id: "base", timestamp: Date.now() - 300 });
      bm.register(base);

      const forwarder = makeBlock({
        id: "fwd",
        timestamp: Date.now() - 200,
        content: [{ _forwardBlockId: "base" }],
      });
      bm.register(forwarder);

      // forwarder expires → should release base refCount
      bm.startCleanup(10);
      await new Promise((r) => setTimeout(r, 50));
      bm.stop();

      // Both should be expired since both are old and have refCount 0
      expect(bm.get("fwd")).toBeNull();
    });
  });

  describe("boundary: release to 0 then acquire again", () => {
    it("should allow re-acquiring after release to 0", () => {
      const block = makeBlock();
      bm.register(block);

      bm.acquire(block.id);
      bm.release(block.id);
      // refCount is 0 now, but block still exists
      bm.acquire(block.id);
      // refCount is 1 again
      expect(bm.get(block.id)).not.toBeNull();
    });
  });
});
