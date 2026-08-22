/**
 * The daemon's own configuration: the one document that exists beside each
 * instance configuration and holds the management listener and its account.
 *
 * Two rules from `security-operations.md` shape it. Section 3 makes loopback
 * the only default listen address and forbids widening after a bind failure,
 * so the stored address is validated as an exact loopback literal and an
 * unspecified address is rejected rather than normalized. Section 6 keeps
 * secrets out of files that other identities can read, so the document stores
 * only a salted verifier: the generated password is returned once, in memory,
 * to the interactive caller that created or rotated it and is never written
 * anywhere, including this file.
 */

import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, parse, resolve } from "node:path";
import { assertJsonValue, deepFreeze, type JsonValue } from "../core/canonical-json.js";
import { NetworkExposurePolicy } from "../core/network-exposure.js";
import { parseStrictJsonBytes } from "../core/strict-json.js";
import {
  generateRuntimeUuidV7,
  isLowercaseUuidV7,
} from "../core/runtime-authority-identities.js";

const CONFIG_FILE_NAME = "daemon.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const PASSWORD_BYTES = 32;
const SALT_BYTES = 16;
const VERIFIER_BYTES = 32;

/** Loopback literals the daemon is permitted to bind. */
export const ALLOWED_DAEMON_LISTEN_HOSTS = Object.freeze(["127.0.0.1", "::1"] as const);

export type DaemonListenHost = (typeof ALLOWED_DAEMON_LISTEN_HOSTS)[number];

export interface DaemonCredentialRecord {
  readonly username: string;
  readonly algorithm: "scrypt";
  readonly salt: string;
  readonly verifier: string;
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
  readonly keyLength: number;
  readonly createdAt: string;
}

export interface DaemonConfigDocument {
  readonly schemaVersion: "dolly.daemon-config/2";
  /** Strict RFC9562 lowercase UUIDv7, minted once per installation. */
  readonly daemonInstallationId: string;
  readonly listen: {
    readonly host: DaemonListenHost;
    readonly port: number;
  };
  readonly credential: DaemonCredentialRecord;
}

/** Legacy `/1` document read ONLY by the atomic `/1 -> /2` migration. */
export interface LegacyDaemonConfigV1Document {
  readonly schemaVersion: "dolly.daemon-config/1";
  /** Retired lowercase UUIDv4, never reinterpreted or aliased. */
  readonly daemonId: string;
  readonly listen: {
    readonly host: DaemonListenHost;
    readonly port: number;
  };
  readonly credential: DaemonCredentialRecord;
}

export type DaemonConfigErrorCode =
  | "DAEMON_CONFIG_PATH_INVALID"
  | "DAEMON_CONFIG_DOCUMENT_INVALID"
  | "DAEMON_CONFIG_LISTEN_ADDRESS_FORBIDDEN"
  | "DAEMON_CONFIG_PERMISSIONS_INSECURE"
  | "DAEMON_CONFIG_LIMIT_EXCEEDED"
  | "DAEMON_CONFIG_IO_FAILED"
  | "DAEMON_CONFIG_MIGRATION_REFUSED";

export class DaemonConfigError extends Error {
  constructor(
    readonly code: DaemonConfigErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DaemonConfigError";
  }
}

const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

function derive(
  password: string,
  salt: Buffer,
  credential: Pick<
    DaemonCredentialRecord,
    "cost" | "blockSize" | "parallelization" | "keyLength"
  >,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    scrypt(
      Buffer.from(password, "utf8"),
      salt,
      credential.keyLength,
      {
        N: credential.cost,
        r: credential.blockSize,
        p: credential.parallelization,
        // scrypt needs roughly 128 * N * r bytes; grant it explicitly so a
        // stronger stored cost cannot fail with the default 32 MiB cap.
        maxmem: 256 * credential.cost * credential.blockSize + 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) rejectPromise(error);
        else resolvePromise(derivedKey);
      },
    );
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedObject(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new DaemonConfigError("DAEMON_CONFIG_DOCUMENT_INVALID", `${label} must be an object`);
  }
  const permitted = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !permitted.has(key));
  if (unexpected.length > 0) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      `${label} contains unknown fields: ${unexpected.sort().join(", ")}`,
    );
  }
}

/**
 * Accepts only an exact loopback literal. An unspecified address is refused
 * here rather than rewritten, so no code path can turn a configuration
 * mistake into a wider listener.
 */
export function assertDaemonListenHost(value: unknown): asserts value is DaemonListenHost {
  if (typeof value !== "string") {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_LISTEN_ADDRESS_FORBIDDEN",
      "listen.host must be a loopback IP literal",
    );
  }
  if (!(ALLOWED_DAEMON_LISTEN_HOSTS as readonly string[]).includes(value)) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_LISTEN_ADDRESS_FORBIDDEN",
      `listen.host ${JSON.stringify(value)} is not one of the permitted loopback literals ${ALLOWED_DAEMON_LISTEN_HOSTS.join(", ")}`,
    );
  }
}

function assertPort(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 65_535) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "listen.port must be an integer between 0 and 65535",
    );
  }
}

function parseCredential(value: unknown): DaemonCredentialRecord {
  assertClosedObject(
    value,
    [
      "username",
      "algorithm",
      "salt",
      "verifier",
      "cost",
      "blockSize",
      "parallelization",
      "keyLength",
      "createdAt",
    ],
    "credential",
  );
  if (typeof value.username !== "string" || !USERNAME_PATTERN.test(value.username)) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "credential.username is invalid",
    );
  }
  if (value.algorithm !== "scrypt") {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "credential.algorithm must be scrypt",
    );
  }
  if (
    typeof value.salt !== "string" ||
    !BASE64URL_PATTERN.test(value.salt) ||
    typeof value.verifier !== "string" ||
    !BASE64URL_PATTERN.test(value.verifier)
  ) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "credential.salt and credential.verifier must be base64url material",
    );
  }
  if (
    !Number.isSafeInteger(value.cost) ||
    (value.cost as number) < 16_384 ||
    (value.cost as number) > 1_048_576 ||
    ((value.cost as number) & ((value.cost as number) - 1)) !== 0
  ) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "credential.cost must be a power of two of at least 16384",
    );
  }
  if (
    !Number.isSafeInteger(value.blockSize) ||
    (value.blockSize as number) < 1 ||
    (value.blockSize as number) > 64 ||
    !Number.isSafeInteger(value.parallelization) ||
    (value.parallelization as number) < 1 ||
    (value.parallelization as number) > 16 ||
    !Number.isSafeInteger(value.keyLength) ||
    (value.keyLength as number) < 32 ||
    (value.keyLength as number) > 128
  ) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "credential scrypt parameters are outside their supported range",
    );
  }
  const createdAt = value.createdAt;
  if (
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(Date.parse(createdAt)).toISOString() !== createdAt
  ) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "credential.createdAt must be a canonical ISO instant",
    );
  }
  return deepFreeze({ ...value }) as unknown as DaemonCredentialRecord;
}

export function parseDaemonConfigDocument(value: unknown): DaemonConfigDocument {
  assertClosedObject(
    value,
    ["schemaVersion", "daemonInstallationId", "listen", "credential"],
    "daemon config",
  );
  if (value.schemaVersion !== "dolly.daemon-config/2") {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "daemon config schema version is unsupported",
    );
  }
  if (
    typeof value.daemonInstallationId !== "string" ||
    !isLowercaseUuidV7(value.daemonInstallationId)
  ) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "daemonInstallationId must be a strict lowercase RFC9562 UUIDv7",
    );
  }
  assertClosedObject(value.listen, ["host", "port"], "listen");
  assertDaemonListenHost(value.listen.host);
  assertPort(value.listen.port);
  const credential = parseCredential(value.credential);
  return deepFreeze({
    schemaVersion: "dolly.daemon-config/2",
    daemonInstallationId: value.daemonInstallationId,
    listen: { host: value.listen.host, port: value.listen.port },
    credential,
  }) as DaemonConfigDocument;
}

/**
 * Internal `/1` reader used ONLY by the atomic `/1 -> /2` migration in
 * `DaemonConfigStore.load`. The retired UUIDv4 `daemonId` is validated here
 * so a v1 document can be read, carried as listen/credential, and rewritten
 * as `/2` with a newly minted UUIDv7 `daemonInstallationId`; the old UUIDv4
 * is never reinterpreted, aliased, or reused as the installation identifier.
 */
function parseLegacyDaemonConfigV1Document(value: unknown): LegacyDaemonConfigV1Document {
  assertClosedObject(value, ["schemaVersion", "daemonId", "listen", "credential"], "daemon config");
  if (value.schemaVersion !== "dolly.daemon-config/1") {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "legacy daemon config schema version is not dolly.daemon-config/1",
    );
  }
  if (
    typeof value.daemonId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.daemonId,
    )
  ) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "legacy daemonId must be a lowercase UUIDv4",
    );
  }
  assertClosedObject(value.listen, ["host", "port"], "listen");
  assertDaemonListenHost(value.listen.host);
  assertPort(value.listen.port);
  const credential = parseCredential(value.credential);
  return deepFreeze({
    schemaVersion: "dolly.daemon-config/1",
    daemonId: value.daemonId,
    listen: { host: value.listen.host, port: value.listen.port },
    credential,
  }) as LegacyDaemonConfigV1Document;
}

/**
 * Fail-closed guard for the `/1 -> /2` migration: the retired UUIDv4
 * `daemonId` must not be referenced by any durable foreign document beside
 * `daemon.json` itself, else the migration is refused so an old identifier is
 * never silently reinterpreted. Each sibling durable record is scanned
 * (bounded by the daemon config size limit) for the exact literal.
 */
function hasDurableForeignReferenceToLegacyDaemonId(
  directory: string,
  legacyDaemonId: string,
): boolean {
  for (const entry of readdirSync(directory)) {
    if (entry === CONFIG_FILE_NAME || entry.startsWith(".")) continue;
    const candidatePath = join(directory, entry);
    try {
      if (!statSync(candidatePath).isFile()) continue;
      if (statSync(candidatePath).size > MAX_CONFIG_BYTES) continue;
      const content = readFileSync(candidatePath, "utf8");
      if (content.includes(legacyDaemonId)) return true;
    } catch {
      // A file that cannot be read is not evidence for or against; the
      // migration continues with the documented stop condition only when a
      // readable durable record actually names the old identifier.
    }
  }
  return false;
}

/**
 * Atomically migrates a read `/1` document to `/2`: preserve listen and
 * credential, mint exactly one UUIDv7 `daemonInstallationId`, write the `/2`
 * document with owner-only temp + fsync + rename + directory fsync, then
 * reopen from disk so the returned value is the stable written state. The
 * retired UUIDv4 `daemonId` is never reinterpreted or reused.
 */
function migrateLegacyDaemonConfigV1(
  directory: string,
  legacy: LegacyDaemonConfigV1Document,
  mintInstallationId: (() => string) | undefined,
): DaemonConfigDocument {
  if (
    hasDurableForeignReferenceToLegacyDaemonId(directory, legacy.daemonId)
  ) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_MIGRATION_REFUSED",
      "legacy UUIDv4 daemonId has a durable foreign reference; refusing the /1 -> /2 migration",
    );
  }
  const daemonInstallationId = (mintInstallationId ?? defaultMintInstallationId)();
  const config = parseDaemonConfigDocument({
    schemaVersion: "dolly.daemon-config/2",
    daemonInstallationId,
    listen: { host: legacy.listen.host, port: legacy.listen.port },
    credential: legacy.credential,
  });
  writeAtomicConfig(directory, config, /* replaceExisting */ true);
  return config;
}

function defaultMintInstallationId(): string {
  return generateRuntimeUuidV7({
    now: () => Date.now(),
    randomBytes: (size) => randomBytes(size),
  });
}

/** Strips every credential field that could reconstruct or confirm a guess. */
export function redactDaemonConfig(config: DaemonConfigDocument): JsonValue {
  return {
    schemaVersion: config.schemaVersion,
    daemonInstallationId: config.daemonInstallationId,
    listen: { host: config.listen.host, port: config.listen.port },
    credential: {
      username: config.credential.username,
      algorithm: config.credential.algorithm,
      createdAt: config.credential.createdAt,
    },
  };
}

/** Builds the loopback request policy that guards the management listener. */
export function daemonExposurePolicy(config: DaemonConfigDocument): NetworkExposurePolicy {
  return new NetworkExposurePolicy({
    mode: "local",
    listenHost: config.listen.host,
    listenPort: config.listen.port,
  });
}

export interface DaemonConfigStoreOptions {
  /** Owner-only directory that holds the daemon document. */
  readonly directory: string;
  readonly now?: () => string;
  /** Provides the strict RFC9562 lowercase UUIDv7 installation identifier. */
  readonly nextDaemonInstallationId?: () => string;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface LoadedDaemonConfig {
  readonly config: DaemonConfigDocument;
  readonly path: string;
  /**
   * The plaintext password, present only for the call that generated it. It
   * is never persisted, logged, or recoverable afterwards.
   */
  readonly generatedPassword?: string;
}

export interface InitializeDaemonConfigOptions {
  readonly listenHost?: DaemonListenHost;
  readonly listenPort?: number;
  readonly username?: string;
}

function assertOwnerOnly(path: string): void {
  // POSIX permission bits are authoritative here. Section 6 also requires a
  // Windows access control list limited to the service identity; this store
  // does not set or verify one yet, so on Windows it performs no check rather
  // than reporting a protection it has not established.
  if (process.platform === "win32") return;
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (error) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_IO_FAILED",
      "Could not inspect daemon configuration permissions",
      { cause: error },
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_PERMISSIONS_INSECURE",
      `${path} must not be readable or writable by group or other identities`,
    );
  }
}

export class DaemonConfigStore {
  readonly #directory: string;
  readonly #now: () => string;
  readonly #nextDaemonInstallationId: () => string;
  readonly #randomBytes: (size: number) => Buffer;

  constructor(options: DaemonConfigStoreOptions) {
    const directory = options.directory;
    if (typeof directory !== "string" || directory.length === 0 || directory.includes("\u0000")) {
      throw new DaemonConfigError(
        "DAEMON_CONFIG_PATH_INVALID",
        "Daemon configuration directory is invalid",
      );
    }
    const absolute = resolve(directory);
    if (absolute === parse(absolute).root) {
      throw new DaemonConfigError(
        "DAEMON_CONFIG_PATH_INVALID",
        "Daemon configuration directory cannot be a filesystem root",
      );
    }
    this.#directory = absolute;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nextDaemonInstallationId =
      options.nextDaemonInstallationId ?? defaultMintInstallationId;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  get path(): string {
    return join(this.#directory, CONFIG_FILE_NAME);
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  /**
   * Loads the daemon document. When the file holds a legacy `/1` document,
   * it is atomically migrated to `/2` first (preserving listen and credential
   * and minting one UUIDv7 installation identifier), then the stable written
   * document is re-read and returned.
   */
  load(): LoadedDaemonConfig {
    const path = this.path;
    if (!existsSync(path)) {
      throw new DaemonConfigError(
        "DAEMON_CONFIG_IO_FAILED",
        "Daemon configuration does not exist",
      );
    }
    assertOwnerOnly(path);
    let bytes: Buffer;
    try {
      if (statSync(path).size > MAX_CONFIG_BYTES) {
        throw new DaemonConfigError(
          "DAEMON_CONFIG_LIMIT_EXCEEDED",
          "Daemon configuration exceeds its byte limit",
        );
      }
      bytes = readFileSync(path);
    } catch (error) {
      if (error instanceof DaemonConfigError) throw error;
      throw new DaemonConfigError(
        "DAEMON_CONFIG_IO_FAILED",
        "Could not read the daemon configuration",
        { cause: error },
      );
    }
    const parsed = parseStrictJsonBytes(bytes, { maxBytes: MAX_CONFIG_BYTES, maxDepth: 8 });
    if (
      isRecord(parsed) &&
      parsed.schemaVersion === "dolly.daemon-config/1" &&
      typeof parsed.daemonId === "string"
    ) {
      const legacy = parseLegacyDaemonConfigV1Document(parsed);
      const config = migrateLegacyDaemonConfigV1(
        this.#directory,
        legacy,
        this.#nextDaemonInstallationId,
      );
      return deepFreeze({ config, path }) as LoadedDaemonConfig;
    }
    const config = parseDaemonConfigDocument(parsed);
    return deepFreeze({ config, path }) as LoadedDaemonConfig;
  }

  /**
   * Loads the daemon document, creating it with a fresh random account and a
   * freshly minted `/2` installation identifier on first run.
   * `generatedPassword` is set only when this call created the credential.
   */
  async loadOrInitialize(
    options: InitializeDaemonConfigOptions = {},
  ): Promise<LoadedDaemonConfig> {
    if (this.exists()) return this.load();
    const listenHost = options.listenHost ?? "127.0.0.1";
    assertDaemonListenHost(listenHost);
    const listenPort = options.listenPort ?? 0;
    assertPort(listenPort);
    const username =
      options.username ?? `dolly-${this.#randomBytes(5).toString("hex")}`;
    if (!USERNAME_PATTERN.test(username)) {
      throw new DaemonConfigError(
        "DAEMON_CONFIG_DOCUMENT_INVALID",
        "credential.username is invalid",
      );
    }
    const daemonInstallationId = this.#nextDaemonInstallationId();
    const { credential, password } = await this.#createCredential(username);
    const config = parseDaemonConfigDocument({
      schemaVersion: "dolly.daemon-config/2",
      daemonInstallationId,
      listen: { host: listenHost, port: listenPort },
      credential,
    });
    writeAtomicConfig(this.#directory, config, false);
    return deepFreeze({
      config,
      path: this.path,
      generatedPassword: password,
    }) as LoadedDaemonConfig;
  }

  /** Replaces the stored account with a fresh random password, keeping the installation identifier. */
  async rotateCredential(username?: string): Promise<LoadedDaemonConfig> {
    const current = this.load().config;
    const { credential, password } = await this.#createCredential(
      username ?? current.credential.username,
    );
    const config = parseDaemonConfigDocument({
      ...current,
      listen: { ...current.listen },
      credential,
    });
    writeAtomicConfig(this.#directory, config, true);
    return deepFreeze({
      config,
      path: this.path,
      generatedPassword: password,
    }) as LoadedDaemonConfig;
  }

  async #createCredential(
    username: string,
  ): Promise<{ credential: DaemonCredentialRecord; password: string }> {
    const password = this.#randomBytes(PASSWORD_BYTES).toString("base64url");
    const salt = this.#randomBytes(SALT_BYTES);
    const parameters = {
      cost: SCRYPT_COST,
      blockSize: SCRYPT_BLOCK_SIZE,
      parallelization: SCRYPT_PARALLELIZATION,
      keyLength: VERIFIER_BYTES,
    };
    const verifier = await derive(password, salt, parameters);
    return {
      password,
      credential: parseCredential({
        username,
        algorithm: "scrypt",
        salt: salt.toString("base64url"),
        verifier: verifier.toString("base64url"),
        ...parameters,
        createdAt: this.#canonicalNow(),
      }),
    };
  }

  #canonicalNow(): string {
    const candidate = this.#now();
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed)) {
      throw new DaemonConfigError(
        "DAEMON_CONFIG_IO_FAILED",
        "Daemon configuration clock is invalid",
      );
    }
    return new Date(parsed).toISOString();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Owner-only temp + fsync + rename + directory fsync write. The temporary
 * file is created with mode 0600 before any content enters the store, the
 * rename is atomic in the same directory, and the containing directory is
 * fsynced so the rename survives a crash (matching `instance-config-store`).
 */
function writeAtomicConfig(
  directory: string,
  config: DaemonConfigDocument,
  replaceExisting: boolean,
): void {
  const value = config as unknown as JsonValue;
  assertJsonValue(value);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, CONFIG_FILE_NAME);
  const temporaryPath = join(directory, `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    if (!replaceExisting && existsSync(target)) {
      throw new DaemonConfigError(
        "DAEMON_CONFIG_IO_FAILED",
        "Daemon configuration already exists",
      );
    }
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, target);
    fsyncDirectory(directory);
  } catch (error) {
    if (error instanceof DaemonConfigError) throw error;
    throw new DaemonConfigError(
      "DAEMON_CONFIG_IO_FAILED",
      "Atomic daemon configuration write failed",
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The write failure above is the useful diagnostic.
      }
    }
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A same-directory temporary is never treated as committed state.
      }
    }
  }
}

/** Durably records a completed rename on POSIX; a no-op elsewhere. */
function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_IO_FAILED",
      "Could not fsync the daemon configuration directory",
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Confirms a submitted account against the stored verifier. Both the username
 * and the derived key are compared in constant time so a failure does not
 * reveal which half was wrong.
 */
export async function verifyDaemonCredential(
  config: DaemonConfigDocument,
  submitted: { readonly username: unknown; readonly password: unknown },
): Promise<boolean> {
  if (typeof submitted.username !== "string" || typeof submitted.password !== "string") {
    return false;
  }
  if (submitted.password.length === 0 || submitted.password.length > 1_024) return false;
  const expectedName = Buffer.from(config.credential.username, "utf8");
  const actualName = Buffer.from(submitted.username, "utf8");
  const nameMatches =
    expectedName.length === actualName.length && timingSafeEqual(expectedName, actualName);
  const salt = Buffer.from(config.credential.salt, "base64url");
  const expected = Buffer.from(config.credential.verifier, "base64url");
  const actual = await derive(submitted.password, salt, config.credential);
  const secretMatches =
    expected.length === actual.length && timingSafeEqual(expected, actual);
  return nameMatches && secretMatches;
}
