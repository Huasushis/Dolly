import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, parse, resolve } from "node:path";
import type { InstalledComponentOrigin } from "../adapters/storage/runtime-authority-database.js";
import {
  canonicalizeJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  ExtensionInstallationRegistry,
  type ResolvedExtensionInstallation,
} from "./extension-installation-registry.js";
import { parseStrictJsonBytes } from "./strict-json.js";
import { withSynchronousCrossProcessLock } from "./synchronous-cross-process-lock.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RECORD_FILE_PATTERN = /^[0-9a-f]{64}\.json$/u;
const QUALIFIED_NAME_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/u;
const DEFAULT_MAX_RECORD_BYTES = 4 * 1024;
const MAX_COMPONENT_REVISION = Number.MAX_SAFE_INTEGER;
const RECORD_SCHEMA = "dolly.installed-component-origin/v1" as const;
const RECORD_KIND = "installed_product_component" as const;

declare const VERIFIED_INSTALLED_COMPONENT_ORIGIN: unique symbol;

/** An origin record minted by one live Host installation registry. */
export type VerifiedInstalledComponentOrigin = InstalledComponentOrigin & {
  readonly [VERIFIED_INSTALLED_COMPONENT_ORIGIN]: true;
};

export interface InstalledComponentOriginRegistryOptions {
  /** Private directory containing the Host's append-only origin records. */
  readonly directory: string;
  /** The registry that verifies the managed package before an origin is minted. */
  readonly installations: ExtensionInstallationRegistry;
  readonly maxRecordBytes?: number;
}

export interface ResolveInstalledComponentOriginOptions {
  readonly extensionId: string;
  readonly packageVersion: string;
}

export type InstalledComponentOriginErrorCode =
  | "INSTALLED_COMPONENT_ORIGIN_INVALID"
  | "INSTALLED_COMPONENT_ORIGIN_TAMPERED"
  | "INSTALLED_COMPONENT_ORIGIN_UNAVAILABLE"
  | "INSTALLED_COMPONENT_ORIGIN_IO_FAILED";

export class InstalledComponentOriginError extends Error {
  constructor(
    readonly code: InstalledComponentOriginErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InstalledComponentOriginError";
  }
}

interface OriginBrand {
  readonly token: object;
  readonly extensionId: string;
  readonly packageVersion: string;
  readonly recordPath: string;
}

const BRANDS = new WeakMap<object, OriginBrand>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string, cause?: unknown): InstalledComponentOriginError {
  return new InstalledComponentOriginError(
    "INSTALLED_COMPONENT_ORIGIN_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function tampered(message: string, cause?: unknown): InstalledComponentOriginError {
  return new InstalledComponentOriginError(
    "INSTALLED_COMPONENT_ORIGIN_TAMPERED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function unavailable(message: string): InstalledComponentOriginError {
  return new InstalledComponentOriginError(
    "INSTALLED_COMPONENT_ORIGIN_UNAVAILABLE",
    message,
  );
}

function ioFailure(message: string, cause: unknown): InstalledComponentOriginError {
  return new InstalledComponentOriginError(
    "INSTALLED_COMPONENT_ORIGIN_IO_FAILED",
    message,
    { cause },
  );
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameOrigin(left: InstalledComponentOrigin, right: InstalledComponentOrigin): boolean {
  return canonicalizeJson(left as unknown as JsonValue) ===
    canonicalizeJson(right as unknown as JsonValue);
}

function assertLookup(value: unknown): asserts value is ResolveInstalledComponentOriginOptions {
  if (!isPlainObject(value)) throw invalid("installed component origin lookup must be a plain object");
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "extensionId" || keys[1] !== "packageVersion") {
    throw invalid("installed component origin lookup contains unknown fields");
  }
  if (
    typeof value.extensionId !== "string" ||
    value.extensionId.length === 0 ||
    typeof value.packageVersion !== "string" ||
    value.packageVersion.length === 0
  ) {
    throw invalid("installed component origin lookup identity is invalid");
  }
}

function validateOrigin(value: unknown, label: string): InstalledComponentOrigin {
  if (!isPlainObject(value)) throw tampered(`${label} is not a plain object`);
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 5 ||
    keys.some((key, index) => key !== [
      "component_digest",
      "component_id",
      "component_revision",
      "kind",
      "schema",
    ][index])
  ) {
    throw tampered(`${label} contains unknown or missing fields`);
  }
  if (value.schema !== RECORD_SCHEMA || value.kind !== RECORD_KIND) {
    throw tampered(`${label} has an unsupported schema or kind`);
  }
  if (
    typeof value.component_id !== "string" ||
    !QUALIFIED_NAME_PATTERN.test(value.component_id)
  ) {
    throw tampered(`${label}.component_id is invalid`);
  }
  if (
    typeof value.component_revision !== "number" ||
    !Number.isSafeInteger(value.component_revision) ||
    value.component_revision < 1 ||
    value.component_revision > MAX_COMPONENT_REVISION
  ) {
    throw tampered(`${label}.component_revision is invalid`);
  }
  if (typeof value.component_digest !== "string" || !DIGEST_PATTERN.test(value.component_digest)) {
    throw tampered(`${label}.component_digest is invalid`);
  }
  return value as unknown as InstalledComponentOrigin;
}

function sourceFileName(extensionId: string, packageVersion: string): string {
  return `${createHash("sha256")
    .update(canonicalizeJson([extensionId, packageVersion]), "utf8")
    .digest("hex")}.json`;
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function immutableOrigin(origin: InstalledComponentOrigin): InstalledComponentOrigin {
  return deepFreeze({ ...origin }) as InstalledComponentOrigin;
}

/**
 * Asserts that a value is the live object returned by the Host origin registry.
 * A JSON parse, spread, or structural copy is evidence only and is not an
 * origin authority.
 */
export function assertInstalledComponentOrigin(
  value: unknown,
): asserts value is VerifiedInstalledComponentOrigin {
  if (
    value === null ||
    typeof value !== "object" ||
    !BRANDS.has(value)
  ) {
    throw unavailable(
      "installed component origin was not minted by the current Host registry",
    );
  }
  validateOrigin(value, "installed component origin");
}

/**
 * The Host-owned durable mapping from a verified managed package identity to
 * one immutable installed-component origin record. Component revisions are
 * allocated monotonically per component and persisted; they are never made by
 * truncating or mapping a digest to an integer.
 */
export class InstalledComponentOriginRegistry {
  readonly #directory: string;
  readonly #installations: ExtensionInstallationRegistry;
  readonly #maxRecordBytes: number;
  readonly #token = {};

  constructor(options: InstalledComponentOriginRegistryOptions) {
    if (!isPlainObject(options)) throw new TypeError("installed component origin options are invalid");
    if (!(options.installations instanceof ExtensionInstallationRegistry)) {
      throw new TypeError("installations must be an ExtensionInstallationRegistry");
    }
    if (
      typeof options.directory !== "string" ||
      options.directory.length === 0 ||
      options.directory.includes("\0")
    ) {
      throw new TypeError("installed component origin directory is invalid");
    }
    const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 256) {
      throw new TypeError("maxRecordBytes must be a safe integer of at least 256 bytes");
    }
    const absolute = resolve(options.directory);
    if (absolute === parse(absolute).root) {
      throw new TypeError("installed component origin directory cannot be a filesystem root");
    }
    try {
      if (existsSync(absolute)) {
        const metadata = lstatSync(absolute);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw invalid("installed component origin directory must be a real directory");
        }
      } else {
        mkdirSync(absolute, { recursive: true, mode: 0o700 });
      }
      this.#directory = realpathSync.native(absolute);
      this.#setDirectoryPermissions(this.#directory);
      this.#maxRecordBytes = maxRecordBytes;
    } catch (error) {
      if (error instanceof InstalledComponentOriginError) throw error;
      throw ioFailure("could not prepare installed component origin directory", error);
    }
    this.#installations = options.installations;
  }

  resolve(
    options: ResolveInstalledComponentOriginOptions,
  ): VerifiedInstalledComponentOrigin {
    assertLookup(options);
    const installation = this.#installations.resolve({
      extensionId: options.extensionId,
      packageVersion: options.packageVersion,
    });
    this.#assertVerifiedInstallation(installation, options);
    const recordPath = join(
      this.#directory,
      sourceFileName(options.extensionId, options.packageVersion),
    );
    const resourceId = `${this.#directory}/component/${createHash("sha256")
      .update(canonicalizeJson(options.extensionId), "utf8")
      .digest("hex")}`;
    try {
      const origin = withSynchronousCrossProcessLock({ resourceId }, () => {
        const existing = this.#readRecord(
          recordPath,
          options.extensionId,
          installation.packageDigest,
        );
        if (existing !== undefined) return existing;
        const revision = this.#nextRevision(options.extensionId);
        const created = immutableOrigin({
          schema: RECORD_SCHEMA,
          kind: RECORD_KIND,
          component_id: options.extensionId,
          component_revision: revision,
          component_digest: installation.packageDigest,
        });
        this.#writeRecord(recordPath, created);
        return created;
      });
      const branded = immutableOrigin(origin) as VerifiedInstalledComponentOrigin;
      BRANDS.set(branded, {
        token: this.#token,
        extensionId: options.extensionId,
        packageVersion: options.packageVersion,
        recordPath,
      });
      return branded;
    } catch (error) {
      if (error instanceof InstalledComponentOriginError) throw error;
      throw ioFailure("could not resolve installed component origin", error);
    }
  }

  /** Rechecks the managed installation and the durable origin record. */
  assertCurrent(value: unknown): asserts value is VerifiedInstalledComponentOrigin {
    assertInstalledComponentOrigin(value);
    const brand = BRANDS.get(value)!;
    if (brand.token !== this.#token) {
      throw unavailable("installed component origin belongs to another Host registry generation");
    }
    const installation = this.#installations.resolve({
      extensionId: brand.extensionId,
      packageVersion: brand.packageVersion,
    });
    this.#assertVerifiedInstallation(installation, {
      extensionId: brand.extensionId,
      packageVersion: brand.packageVersion,
    });
    const persisted = this.#readRecord(
      brand.recordPath,
      brand.extensionId,
      installation.packageDigest,
    );
    if (persisted === undefined || !sameOrigin(persisted, value)) {
      throw unavailable("installed component origin is stale or no longer current");
    }
  }

  #assertVerifiedInstallation(
    installation: ResolvedExtensionInstallation,
    options: ResolveInstalledComponentOriginOptions,
  ): void {
    if (
      installation.manifest.extensionId !== options.extensionId ||
      installation.manifest.packageVersion !== options.packageVersion
    ) {
      throw tampered("managed installation identity does not match the requested package identity");
    }
    if (!QUALIFIED_NAME_PATTERN.test(installation.manifest.extensionId)) {
      throw invalid("managed installation extensionId is not a qualified component ID");
    }
    if (!DIGEST_PATTERN.test(installation.packageDigest)) {
      throw tampered("managed installation package digest is invalid");
    }
    const snapshotBytes = installation.packageSnapshot.copyBytes();
    if (
      !DIGEST_PATTERN.test(installation.packageSnapshot.digest) ||
      digestBytes(snapshotBytes) !== installation.packageSnapshot.digest ||
      snapshotBytes.byteLength !== installation.packageSnapshot.byteLength ||
      installation.packageSnapshot.fileCount < 1 ||
      installation.packageSnapshot.totalFileBytes < 1
    ) {
      throw tampered("managed installation package snapshot is invalid");
    }
  }

  #recordPathExists(path: string): boolean {
    try {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw tampered("installed component origin record is not a regular file");
      }
      return true;
    } catch (error) {
      if (error instanceof InstalledComponentOriginError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw ioFailure("could not inspect installed component origin record", error);
    }
  }

  #readRecord(
    path: string,
    componentId: string,
    expectedDigest: string,
  ): InstalledComponentOrigin | undefined {
    if (!this.#recordPathExists(path)) return undefined;
    let metadata;
    let bytes: Buffer;
    try {
      metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > this.#maxRecordBytes) {
        throw tampered("installed component origin record is not a bounded regular file");
      }
      bytes = readFileSync(path);
    } catch (error) {
      if (error instanceof InstalledComponentOriginError) throw error;
      throw ioFailure("could not read installed component origin record", error);
    }
    let value: JsonValue;
    try {
      value = parseStrictJsonBytes(bytes, { maxBytes: this.#maxRecordBytes, maxDepth: 8 });
    } catch (error) {
      throw tampered("installed component origin record is not strict JSON", error);
    }
    const origin = validateOrigin(value, "installed component origin record");
    if (
      origin.component_id !== componentId ||
      origin.component_digest !== expectedDigest
    ) {
      throw tampered("installed component origin record does not match the verified package");
    }
    const expectedBytes = Buffer.from(`${canonicalizeJson(origin as unknown as JsonValue)}\n`, "utf8");
    if (!expectedBytes.equals(bytes)) {
      throw tampered("installed component origin record is not canonical JSON");
    }
    return immutableOrigin(origin);
  }

  #allRecords(): InstalledComponentOrigin[] {
    let names: string[];
    try {
      names = readdirSync(this.#directory);
    } catch (error) {
      throw ioFailure("could not list installed component origin records", error);
    }
    const records: InstalledComponentOrigin[] = [];
    for (const name of names) {
      if (name.startsWith(".") && name.endsWith(".tmp")) continue;
      if (!RECORD_FILE_PATTERN.test(name)) {
        throw tampered(`unexpected installed component origin entry ${name}`);
      }
      const path = join(this.#directory, name);
      let metadata;
      try {
        metadata = lstatSync(path);
      } catch (error) {
        throw ioFailure("could not inspect installed component origin entry", error);
      }
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw tampered(`installed component origin entry ${name} is not a regular file`);
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch (error) {
        throw ioFailure("could not read installed component origin entry", error);
      }
      let value: JsonValue;
      try {
        value = parseStrictJsonBytes(bytes, { maxBytes: this.#maxRecordBytes, maxDepth: 8 });
      } catch (error) {
        throw tampered(`installed component origin entry ${name} is not strict JSON`, error);
      }
      const origin = validateOrigin(value, `installed component origin entry ${name}`);
      const expectedBytes = Buffer.from(`${canonicalizeJson(origin as unknown as JsonValue)}\n`, "utf8");
      if (!expectedBytes.equals(bytes)) {
        throw tampered(`installed component origin entry ${name} is not canonical JSON`);
      }
      records.push(immutableOrigin(origin));
    }
    return records;
  }

  #nextRevision(componentId: string): number {
    let maximum = 0;
    const seen = new Set<number>();
    for (const origin of this.#allRecords()) {
      if (origin.component_id !== componentId) continue;
      if (seen.has(origin.component_revision)) {
        throw tampered(`component ${componentId} has duplicate origin revisions`);
      }
      seen.add(origin.component_revision);
      maximum = Math.max(maximum, origin.component_revision);
    }
    if (maximum >= MAX_COMPONENT_REVISION) {
      throw invalid(`component ${componentId} origin revision space is exhausted`);
    }
    return maximum + 1;
  }

  #writeRecord(path: string, origin: InstalledComponentOrigin): void {
    const parent = this.#directory;
    const payload = `${canonicalizeJson(origin as unknown as JsonValue)}\n`;
    if (Buffer.byteLength(payload, "utf8") > this.#maxRecordBytes) {
      throw invalid("installed component origin record exceeds its byte limit");
    }
    const temporaryPath = join(parent, `.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, payload, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
      fsyncDirectory(parent);
    } catch (error) {
      if (error instanceof InstalledComponentOriginError) throw error;
      throw ioFailure("atomic installed component origin record write failed", error);
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the primary write failure.
        }
      }
      if (existsSync(temporaryPath)) {
        try {
          unlinkSync(temporaryPath);
          fsyncDirectory(parent);
        } catch {
          // A same-directory temporary file is never committed state.
        }
      }
    }
  }

  #setDirectoryPermissions(path: string): void {
    if (process.platform === "win32") return;
    try {
      chmodSync(path, 0o700);
      const descriptor = openSync(path, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      throw ioFailure("could not verify installed component origin directory", error);
    }
  }
}
