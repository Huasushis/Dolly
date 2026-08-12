import { createHash } from "node:crypto";

const SNAPSHOT_MAGIC = Buffer.from("DOLLYPKGSNAP1\n", "ascii");
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface ExtensionPackageSnapshotSourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Immutable-by-interface copy of the exact package bytes read during registry
 * verification. Callers receive a fresh copy so a launch never reopens the
 * managed package path after its digest was accepted.
 */
export interface ExtensionPackageSnapshot {
  readonly schemaVersion: "dolly.extension-package-snapshot/1";
  readonly digest: string;
  readonly byteLength: number;
  readonly fileCount: number;
  readonly totalFileBytes: number;
  copyBytes(): Uint8Array;
}

class FrozenExtensionPackageSnapshot implements ExtensionPackageSnapshot {
  readonly schemaVersion = "dolly.extension-package-snapshot/1" as const;
  readonly digest: string;
  readonly byteLength: number;
  readonly fileCount: number;
  readonly totalFileBytes: number;
  readonly #bytes: Buffer;

  constructor(bytes: Buffer, fileCount: number, totalFileBytes: number) {
    this.#bytes = Buffer.from(bytes);
    this.digest = `sha256:${createHash("sha256").update(this.#bytes).digest("hex")}`;
    this.byteLength = this.#bytes.byteLength;
    this.fileCount = fileCount;
    this.totalFileBytes = totalFileBytes;
    Object.freeze(this);
  }

  copyBytes(): Uint8Array {
    return new Uint8Array(this.#bytes);
  }
}

function assertSnapshotPath(path: string): void {
  const encoded = Buffer.from(path, "utf8");
  if (
    path.length === 0 ||
    encoded.byteLength > 4_096 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError("Extension package snapshot path is invalid");
  }
}

/** Encodes a deterministic, closed stream consumed by the Linux bootstrap. */
export function createExtensionPackageSnapshot(
  sourceFiles: readonly ExtensionPackageSnapshotSourceFile[],
): ExtensionPackageSnapshot {
  if (sourceFiles.length < 1 || sourceFiles.length > 100_000) {
    throw new TypeError("Extension package snapshot file count is invalid");
  }
  const ordered = [...sourceFiles].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  const chunks: Buffer[] = [SNAPSHOT_MAGIC];
  const count = Buffer.allocUnsafe(4);
  count.writeUInt32BE(ordered.length, 0);
  chunks.push(count);
  let totalFileBytes = 0;
  let previousPath: string | undefined;
  for (const file of ordered) {
    assertSnapshotPath(file.path);
    if (previousPath === file.path) {
      throw new TypeError("Extension package snapshot paths must be unique");
    }
    previousPath = file.path;
    const pathBytes = Buffer.from(file.path, "utf8");
    const content = Buffer.from(file.bytes);
    totalFileBytes += content.byteLength;
    if (!Number.isSafeInteger(totalFileBytes)) {
      throw new TypeError("Extension package snapshot byte count is unsafe");
    }
    const header = Buffer.allocUnsafe(4 + 8 + 32);
    header.writeUInt32BE(pathBytes.byteLength, 0);
    header.writeBigUInt64BE(BigInt(content.byteLength), 4);
    createHash("sha256").update(content).digest().copy(header, 12);
    chunks.push(header, pathBytes, content);
  }
  const bytes = Buffer.concat(chunks);
  const snapshot = new FrozenExtensionPackageSnapshot(
    bytes,
    ordered.length,
    totalFileBytes,
  );
  if (!DIGEST_PATTERN.test(snapshot.digest)) {
    throw new TypeError("Extension package snapshot digest is invalid");
  }
  return snapshot;
}
