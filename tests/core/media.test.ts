import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MediaManager } from "../../src/core/media.js";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";

describe("MediaManager", () => {
  let mm: MediaManager;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "dolly-media-test-"));
    mm = new MediaManager(tempDir);
  });

  afterEach(() => {
    mm.stop();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("register", () => {
    it("should register a Buffer source", async () => {
      const buf = Buffer.from("hello world");
      const id = await mm.register(buf, "text/plain");
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    it("should register a base64 data URI source", async () => {
      const b64 = "data:text/plain;base64," + Buffer.from("hello").toString("base64");
      const id = await mm.register(b64, "text/plain");
      expect(id).toBeTruthy();
    });

    it("should register a raw base64 source", async () => {
      const b64 = Buffer.from("hello base64 content that is long enough to pass validation check for base64 detection minimum length").toString("base64");
      const id = await mm.register(b64, "text/plain");
      expect(id).toBeTruthy();
    });

    it("should throw for unrecognized source format", async () => {
      await expect(mm.register("not-a-valid-source", "text/plain")).rejects.toThrow("Unrecognized source format");
    });
  });

  describe("get", () => {
    it("should return buffer content", async () => {
      const buf = Buffer.from("test content");
      const id = await mm.register(buf, "text/plain");
      const result = await mm.get(id, "buffer");
      expect(Buffer.isBuffer(result)).toBe(true);
      expect((result as Buffer).toString()).toBe("test content");
    });

    it("should return base64 data URI", async () => {
      const buf = Buffer.from("test content");
      const id = await mm.register(buf, "text/plain");
      const result = await mm.get(id, "base64");
      expect(typeof result).toBe("string");
      expect((result as string).startsWith("data:text/plain;base64,")).toBe(true);
    });

    it("should throw for non-existent media", async () => {
      await expect(mm.get("nonexistent")).rejects.toThrow("Media not found");
    });
  });

  describe("acquire/release", () => {
    it("should increment refCount on acquire", async () => {
      const id = await mm.register(Buffer.from("x"), "text/plain");
      const meta = mm.getMeta(id)!;
      expect(meta.refCount).toBe(1); // initial

      mm.acquire(id);
      expect(mm.getMeta(id)!.refCount).toBe(2);
    });

    it("should decrement refCount on release", async () => {
      const id = await mm.register(Buffer.from("x"), "text/plain");
      mm.release(id);
      expect(mm.getMeta(id)!.refCount).toBe(0);
    });

    it("should not go below 0 on release", async () => {
      const id = await mm.register(Buffer.from("x"), "text/plain");
      mm.release(id);
      mm.release(id);
      expect(mm.getMeta(id)!.refCount).toBe(0);
    });

    it("should be no-op for non-existent media", () => {
      expect(() => mm.acquire("nope")).not.toThrow();
      expect(() => mm.release("nope")).not.toThrow();
    });
  });

  describe("cleanup (refCount === 0 → destroy)", () => {
    it("should destroy media with refCount 0 during cleanup", async () => {
      const id = await mm.register(Buffer.from("temp"), "text/plain");
      mm.release(id); // refCount = 0

      // Manually trigger cleanup via startCleanup with short interval
      mm.startCleanup(10);
      await new Promise((r) => setTimeout(r, 50));
      mm.stop();

      expect(mm.getMeta(id)).toBeNull();
    });
  });

  describe("getMeta", () => {
    it("should return media metadata", async () => {
      const id = await mm.register(Buffer.from("content"), "text/plain");
      const meta = mm.getMeta(id);
      expect(meta).not.toBeNull();
      expect(meta!.id).toBe(id);
      expect(meta!.mimeType).toBe("text/plain");
      expect(meta!.size).toBe(7);
    });

    it("should return null for non-existent id", () => {
      expect(mm.getMeta("nope")).toBeNull();
    });
  });

  describe("destroy", () => {
    it("should remove media and local file", async () => {
      const id = await mm.register(Buffer.from("delete me"), "text/plain");
      const meta = mm.getMeta(id)!;
      expect(existsSync(meta.localPath!)).toBe(true);

      await mm.destroy(id);
      expect(mm.getMeta(id)).toBeNull();
      expect(existsSync(meta.localPath!)).toBe(false);
    });
  });
});
