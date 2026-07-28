import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { type MediaByteStore } from "./media-store.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export type FileMediaByteStoreErrorCode =
  | "MEDIA_BYTES_ID_INVALID"
  | "MEDIA_BYTES_LIMIT_EXCEEDED"
  | "MEDIA_BYTES_CONFLICT"
  | "MEDIA_BYTES_NOT_FOUND"
  | "MEDIA_BYTES_NOT_REGULAR"
  | "MEDIA_BYTES_IO_FAILED";

export class FileMediaByteStoreError extends Error {
  constructor(readonly code: FileMediaByteStoreErrorCode, message: string) {
    super(message);
    this.name = "FileMediaByteStoreError";
  }
}

export interface FileMediaByteStoreOptions {
  readonly directory: string;
  readonly maxMediaBytes: number;
}

export class FileMediaByteStore implements MediaByteStore {
  readonly durability = "persistent" as const;
  readonly #directory: string;
  readonly #maxMediaBytes: number;

  constructor(options: FileMediaByteStoreOptions) {
    if (
      typeof options.directory !== "string" ||
      options.directory.length === 0 ||
      options.directory.includes("\0")
    ) {
      throw new TypeError("Media byte directory must be a non-empty filesystem path");
    }
    if (!Number.isSafeInteger(options.maxMediaBytes) || options.maxMediaBytes <= 0) {
      throw new TypeError("maxMediaBytes must be a positive safe integer");
    }
    this.#directory = resolve(options.directory);
    this.#maxMediaBytes = options.maxMediaBytes;
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    if (!statSync(this.#directory).isDirectory()) {
      throw new FileMediaByteStoreError(
        "MEDIA_BYTES_NOT_REGULAR",
        "Media byte root must be a directory",
      );
    }
  }

  async put(mediaId: string, bytes: Uint8Array): Promise<void> {
    const target = this.#path(mediaId);
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Media bytes must be Uint8Array");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > this.#maxMediaBytes) {
      throw new FileMediaByteStoreError(
        "MEDIA_BYTES_LIMIT_EXCEEDED",
        "Media bytes exceed the configured media limit",
      );
    }
    if (existsSync(target)) {
      this.#assertRegular(target);
      throw new FileMediaByteStoreError(
        "MEDIA_BYTES_CONFLICT",
        `Media bytes for ${mediaId} already exist`,
      );
    }

    const temporary = join(this.#directory, `.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporary, target);
        fsyncDirectory(this.#directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new FileMediaByteStoreError(
            "MEDIA_BYTES_CONFLICT",
            `Media bytes for ${mediaId} already exist`,
          );
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof FileMediaByteStoreError) throw error;
      throw new FileMediaByteStoreError(
        "MEDIA_BYTES_IO_FAILED",
        "Atomic media byte write failed",
      );
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the primary result.
        }
      }
      if (existsSync(temporary)) {
        try {
          unlinkSync(temporary);
          fsyncDirectory(this.#directory);
        } catch {
          // A temporary hard-link source is never treated as committed metadata.
        }
      }
    }
  }

  async get(mediaId: string): Promise<Uint8Array> {
    const path = this.#path(mediaId);
    if (!existsSync(path)) {
      throw new FileMediaByteStoreError(
        "MEDIA_BYTES_NOT_FOUND",
        `Media bytes for ${mediaId} do not exist`,
      );
    }
    this.#assertRegular(path);
    const size = statSync(path).size;
    if (size <= 0 || size > this.#maxMediaBytes) {
      throw new FileMediaByteStoreError(
        "MEDIA_BYTES_LIMIT_EXCEEDED",
        "Stored media bytes violate the configured media limit",
      );
    }
    try {
      return Uint8Array.from(readFileSync(path));
    } catch {
      throw new FileMediaByteStoreError(
        "MEDIA_BYTES_IO_FAILED",
        "Could not read media bytes",
      );
    }
  }

  async delete(mediaId: string): Promise<void> {
    const path = this.#path(mediaId);
    if (!existsSync(path)) return;
    this.#assertRegular(path);
    try {
      unlinkSync(path);
      fsyncDirectory(this.#directory);
    } catch {
      throw new FileMediaByteStoreError(
        "MEDIA_BYTES_IO_FAILED",
        "Could not delete media bytes",
      );
    }
  }

  async has(mediaId: string): Promise<boolean> {
    const path = this.#path(mediaId);
    if (!existsSync(path)) return false;
    this.#assertRegular(path);
    const size = statSync(path).size;
    if (size <= 0 || size > this.#maxMediaBytes) {
      throw new FileMediaByteStoreError(
        "MEDIA_BYTES_LIMIT_EXCEEDED",
        "Stored media bytes violate the configured media limit",
      );
    }
    return true;
  }

  #path(mediaId: string): string {
    if (typeof mediaId !== "string" || !ID_PATTERN.test(mediaId)) {
      throw new FileMediaByteStoreError(
        "MEDIA_BYTES_ID_INVALID",
        "mediaId is not a valid identifier",
      );
    }
    const digest = createHash("sha256").update(mediaId, "utf8").digest("hex");
    return join(this.#directory, `${digest}.bin`);
  }

  #assertRegular(path: string): void {
    try {
      const status = lstatSync(path);
      if (status.isSymbolicLink() || !status.isFile()) {
        throw new FileMediaByteStoreError(
          "MEDIA_BYTES_NOT_REGULAR",
          "Media byte entry must be a regular non-symbolic file",
        );
      }
    } catch (error) {
      if (error instanceof FileMediaByteStoreError) throw error;
      throw new FileMediaByteStoreError(
        "MEDIA_BYTES_IO_FAILED",
        "Could not inspect media byte entry",
      );
    }
  }
}
