import { describe, expect, it, vi } from "vitest";
import {
  AliOssDirectObjectStore,
  type AliOssClientLike,
} from "../../../src/adapters/storage/ali-oss.js";

describe("Ali OSS direct object store", () => {
  it("uploads one original and deletes only the exact object version", async () => {
    const put = vi.fn(async (name: string) => ({
      name,
      res: {
        headers: {
          etag: '"etag-1"',
          "x-oss-version-id": "object-version-1",
        },
      },
    }));
    const deleteObject = vi.fn().mockResolvedValue({});
    const signatureUrlV4 = vi
      .fn()
      .mockResolvedValue("https://bucket.example/media/media/original.png?signed=1");
    const client: AliOssClientLike = {
      put,
      delete: deleteObject,
      signatureUrlV4,
    };
    const store = new AliOssDirectObjectStore({
      client,
      keyPrefix: "dolly/media",
    });

    const storedObject = await store.putOriginal({
      mediaId: "media-1",
      digest: `sha256:${"0".repeat(64)}`,
      mimeType: "image/png",
      bytes: Buffer.from("image"),
    });
    expect(storedObject).toEqual({
      locator: "dolly/media/media-1/original.png",
      objectVersion: "object-version-1",
      entityTag: '"etag-1"',
    });
    expect(put).toHaveBeenCalledWith(
      "dolly/media/media-1/original.png",
      Buffer.from("image"),
      { mime: "image/png" },
    );

    await expect(
      store.deleteObjectVersion(storedObject.locator, storedObject.objectVersion!),
    ).resolves.toBe("deleted");
    expect(deleteObject).toHaveBeenCalledWith(storedObject.locator, {
      versionId: "object-version-1",
    });
  });

  it("uses Signature Version 4 for ordinary, versioned, and cropped reads", async () => {
    const signatureUrlV4 = vi
      .fn()
      .mockResolvedValue("https://bucket.example/signed");
    const client: AliOssClientLike = {
      put: vi.fn(),
      delete: vi.fn(),
      signatureUrlV4,
    };
    const store = new AliOssDirectObjectStore({
      client,
      keyPrefix: "dolly/media",
    });
    const locator = "dolly/media/media-1/original.png";

    await store.signGet({ locator, expiresInSeconds: 60 });
    expect(signatureUrlV4).toHaveBeenNthCalledWith(
      1,
      "GET",
      60,
      undefined,
      locator,
    );

    await store.signGet({
      locator,
      expiresInSeconds: 120,
      objectVersion: "object-version-1",
    });
    expect(signatureUrlV4).toHaveBeenNthCalledWith(
      2,
      "GET",
      120,
      { queries: { versionId: "object-version-1" } },
      locator,
    );

    await store.signGet({
      locator,
      expiresInSeconds: 180,
      crop: { left: 10, top: 20, width: 30, height: 40 },
    });
    expect(signatureUrlV4).toHaveBeenNthCalledWith(
      3,
      "GET",
      180,
      {
        queries: {
          "x-oss-process": "image/crop,x_10,y_20,w_30,h_40,g_nw",
        },
      },
      locator,
    );

    await store.signGet({
      locator,
      expiresInSeconds: 240,
      objectVersion: "object-version-2",
      crop: { left: 1, top: 2, width: 3, height: 4 },
    });
    expect(signatureUrlV4).toHaveBeenNthCalledWith(
      4,
      "GET",
      240,
      {
        queries: {
          versionId: "object-version-2",
          "x-oss-process": "image/crop,x_1,y_2,w_3,h_4,g_nw",
        },
      },
      locator,
    );
  });

  it("rejects a client without Signature Version 4 URL signing", () => {
    const clientWithoutSignatureUrlV4 = {
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as AliOssClientLike;

    expect(
      () => new AliOssDirectObjectStore({
        client: clientWithoutSignatureUrlV4,
        keyPrefix: "dolly/media",
      }),
    ).toThrow(
      "Ali OSS client must provide Signature Version 4 URL signing through signatureUrlV4",
    );
  });

  it("treats a missing version as success but preserves permission failures", async () => {
    const missingClient: AliOssClientLike = {
      put: vi.fn(),
      delete: vi.fn().mockRejectedValue({ code: "NoSuchKey", status: 404 }),
      signatureUrlV4: vi.fn().mockResolvedValue("https://bucket.example/signed"),
    };
    const missing = new AliOssDirectObjectStore({
      client: missingClient,
      keyPrefix: "dolly/media",
    });
    await expect(
      missing.deleteObjectVersion("dolly/media/missing.png", "missing-version"),
    ).resolves.toBe("not-found");

    const missingBucket = new Error("NoSuchBucket");
    Object.assign(missingBucket, { code: "NoSuchBucket", status: 404 });
    const missingBucketClient: AliOssClientLike = {
      put: vi.fn(),
      delete: vi.fn().mockRejectedValue(missingBucket),
      signatureUrlV4: vi.fn().mockResolvedValue("https://bucket.example/signed"),
    };
    const missingBucketStore = new AliOssDirectObjectStore({
      client: missingBucketClient,
      keyPrefix: "dolly/media",
    });
    await expect(
      missingBucketStore.deleteObjectVersion("dolly/media/missing.png", "missing-version"),
    ).rejects.toBe(missingBucket);

    const denied = new Error("AccessDenied");
    Object.assign(denied, { code: "AccessDenied", status: 403 });
    const deniedClient: AliOssClientLike = {
      put: vi.fn(),
      delete: vi.fn().mockRejectedValue(denied),
      signatureUrlV4: vi.fn().mockResolvedValue("https://bucket.example/signed"),
    };
    const deniedStore = new AliOssDirectObjectStore({
      client: deniedClient,
      keyPrefix: "dolly/media",
    });
    await expect(
      deniedStore.deleteObjectVersion("dolly/media/denied.png", "denied-version"),
    ).rejects.toBe(denied);
  });
});
