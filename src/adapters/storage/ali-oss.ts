import type {
  StoragePutInput,
  StoragePutResult,
  StorageSignInput,
} from "../../core/media-store.js";

const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,255}$/;

export interface AliOssClientLike {
  put(
    name: string,
    bytes: Buffer,
    options: { mime: string },
  ): Promise<{ name: string; res?: { headers?: Record<string, unknown> } }>;
  delete(name: string, options: { versionId: string }): Promise<unknown>;
  signatureUrlV4(
    method: "GET",
    expires: number,
    request: {
      headers?: Record<string, unknown>;
      queries?: Record<string, string>;
    } | undefined,
    objectName: string,
    additionalHeaders?: string[],
  ): Promise<string>;
}

export interface AliOssDirectObjectStoreOptions {
  readonly client: AliOssClientLike;
  readonly keyPrefix: string;
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

/**
 * A thin direct wrapper around Alibaba Cloud Object Storage Service (OSS)
 * operations. Callers using it manage object lifecycle themselves. It is not
 * a MediaStore storage adapter because this client surface does not establish
 * conditional creation, metadata reconciliation, or entity-tag-conditional
 * deletion required to recover persistent Media safely.
 */
export class AliOssDirectObjectStore {
  readonly #client: AliOssClientLike;
  readonly #keyPrefix: string;

  constructor(options: AliOssDirectObjectStoreOptions) {
    const keyPrefix = options.keyPrefix.replace(/^\/+|\/+$/g, "");
    if (!SAFE_PREFIX.test(keyPrefix) || keyPrefix.split("/").includes("..")) {
      throw new TypeError("Ali OSS keyPrefix must be a safe non-empty object prefix");
    }
    if (typeof options.client.signatureUrlV4 !== "function") {
      throw new TypeError(
        "Ali OSS client must provide Signature Version 4 URL signing through signatureUrlV4",
      );
    }
    this.#client = options.client;
    this.#keyPrefix = keyPrefix;
  }

  async putOriginal(input: StoragePutInput): Promise<StoragePutResult> {
    const extension = MIME_EXTENSIONS[input.mimeType];
    if (!extension) {
      throw new Error(`Ali OSS adapter does not support MIME type ${input.mimeType}`);
    }
    const locator = `${this.#keyPrefix}/${input.mediaId}/original${extension}`;
    const result = await this.#client.put(locator, Buffer.from(input.bytes), {
      mime: input.mimeType,
    });
    if (result.name !== locator) {
      throw new Error("Ali OSS put returned a different object name");
    }
    const headers = result.res?.headers;
    const objectVersion = headers?.["x-oss-version-id"];
    const entityTag = headers?.etag;
    return {
      locator,
      ...(typeof objectVersion === "string" ? { objectVersion } : {}),
      ...(typeof entityTag === "string" ? { entityTag } : {}),
    };
  }

  async deleteObjectVersion(
    locator: string,
    objectVersion: string,
  ): Promise<"deleted" | "not-found"> {
    if (typeof objectVersion !== "string" || objectVersion.length === 0) {
      throw new TypeError("Ali OSS deletion requires a non-empty object version");
    }
    try {
      await this.#client.delete(locator, { versionId: objectVersion });
      return "deleted";
    } catch (error) {
      const candidate = error as {
        code?: unknown;
      };
      if (
        candidate.code === "NoSuchKey" ||
        candidate.code === "NoSuchVersion"
      ) {
        return "not-found";
      }
      throw error;
    }
  }

  async signGet(input: StorageSignInput): Promise<string> {
    if (
      input.crop !== undefined &&
      (!Number.isSafeInteger(input.crop.left) ||
        input.crop.left < 0 ||
        !Number.isSafeInteger(input.crop.top) ||
        input.crop.top < 0 ||
        !Number.isSafeInteger(input.crop.width) ||
        input.crop.width <= 0 ||
        !Number.isSafeInteger(input.crop.height) ||
        input.crop.height <= 0)
    ) {
      throw new TypeError("Ali OSS crop must use non-negative integer offsets and positive dimensions");
    }
    const process = input.crop === undefined
      ? undefined
      : [
          "image/crop",
          `x_${input.crop.left}`,
          `y_${input.crop.top}`,
          `w_${input.crop.width}`,
          `h_${input.crop.height}`,
          "g_nw",
        ].join(",");
    const queries: Record<string, string> = {
      ...(input.objectVersion === undefined
        ? {}
        : { versionId: input.objectVersion }),
      ...(process === undefined ? {} : { "x-oss-process": process }),
    };
    return this.#client.signatureUrlV4(
      "GET",
      input.expiresInSeconds,
      Object.keys(queries).length === 0 ? undefined : { queries },
      input.locator,
    );
  }
}
