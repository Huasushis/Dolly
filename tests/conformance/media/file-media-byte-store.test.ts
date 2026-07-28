import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileMediaByteStore,
  FileMediaByteStoreError,
} from "../../../src/core/file-media-byte-store.js";

describe("persistent Media byte store", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-media-bytes-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("recovers immutable bytes through a reconstructed store", async () => {
    const first = new FileMediaByteStore({ directory: root, maxMediaBytes: 1024 });
    const source = Uint8Array.of(1, 2, 3);
    await first.put("media:one", source);
    source[0] = 9;

    const reopened = new FileMediaByteStore({ directory: root, maxMediaBytes: 1024 });
    expect(await reopened.has("media:one")).toBe(true);
    const read = await reopened.get("media:one");
    expect([...read]).toEqual([1, 2, 3]);
    read[0] = 8;
    expect([...(await reopened.get("media:one"))]).toEqual([1, 2, 3]);
  });

  it("never overwrites an existing Media and makes delete idempotent", async () => {
    const store = new FileMediaByteStore({ directory: root, maxMediaBytes: 1024 });
    await store.put("media-1", Uint8Array.of(1));
    await expect(store.put("media-1", Uint8Array.of(2))).rejects.toMatchObject({
      code: "MEDIA_BYTES_CONFLICT",
    });
    expect([...(await store.get("media-1"))]).toEqual([1]);
    await store.delete("media-1");
    await store.delete("media-1");
    expect(await store.has("media-1")).toBe(false);
  });

  it("rejects path-like IDs, empty data, and oversized data", async () => {
    const store = new FileMediaByteStore({ directory: root, maxMediaBytes: 2 });
    await expect(store.put("../escape", Uint8Array.of(1))).rejects.toMatchObject({
      code: "MEDIA_BYTES_ID_INVALID",
    });
    await expect(store.put("media-1", new Uint8Array())).rejects.toMatchObject({
      code: "MEDIA_BYTES_LIMIT_EXCEEDED",
    });
    await expect(store.put("media-2", Uint8Array.of(1, 2, 3))).rejects.toMatchObject({
      code: "MEDIA_BYTES_LIMIT_EXCEEDED",
    });
    expect(() => new FileMediaByteStore({
      directory: root,
      maxMediaBytes: 0,
    })).toThrow(TypeError);
    expect(FileMediaByteStoreError).toBeDefined();
  });
});
