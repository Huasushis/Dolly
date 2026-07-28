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
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, parse, resolve } from "node:path";
import { assertJsonValue, deepFreeze, type JsonValue } from "../core/canonical-json.js";
import { NetworkExposurePolicy } from "../core/network-exposure.js";
import { parseStrictJsonBytes } from "../core/strict-json.js";

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
  readonly schemaVersion: "dolly.daemon-config/1";
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
  | "DAEMON_CONFIG_IO_FAILED";

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
  assertClosedObject(value, ["schemaVersion", "daemonId", "listen", "credential"], "daemon config");
  if (value.schemaVersion !== "dolly.daemon-config/1") {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "daemon config schema version is unsupported",
    );
  }
  if (
    typeof value.daemonId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.daemonId)
  ) {
    throw new DaemonConfigError(
      "DAEMON_CONFIG_DOCUMENT_INVALID",
      "daemonId must be a lowercase UUIDv4",
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
  }) as DaemonConfigDocument;
}

/** Strips every credential field that could reconstruct or confirm a guess. */
export function redactDaemonConfig(config: DaemonConfigDocument): JsonValue {
  return {
    schemaVersion: config.schemaVersion,
    daemonId: config.daemonId,
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
  readonly nextDaemonId?: () => string;
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
  readonly #nextDaemonId: () => string;
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
    this.#nextDaemonId = options.nextDaemonId ?? randomUUID;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  get path(): string {
    return join(this.#directory, CONFIG_FILE_NAME);
  }

  exists(): boolean {
    return existsSync(this.path);
  }

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
    const config = parseDaemonConfigDocument(
      parseStrictJsonBytes(bytes, { maxBytes: MAX_CONFIG_BYTES, maxDepth: 8 }),
    );
    return deepFreeze({ config, path }) as LoadedDaemonConfig;
  }

  /**
   * Loads the daemon document, creating it with a fresh random account on
   * first run. `generatedPassword` is set only when this call created the
   * credential.
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
    const daemonId = this.#nextDaemonId();
    const { credential, password } = await this.#createCredential(username);
    const config = parseDaemonConfigDocument({
      schemaVersion: "dolly.daemon-config/1",
      daemonId,
      listen: { host: listenHost, port: listenPort },
      credential,
    });
    this.#writeAtomic(config, false);
    return deepFreeze({
      config,
      path: this.path,
      generatedPassword: password,
    }) as LoadedDaemonConfig;
  }

  /** Replaces the stored account with a fresh random password. */
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
    this.#writeAtomic(config, true);
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

  #writeAtomic(config: DaemonConfigDocument, replaceExisting: boolean): void {
    const value = config as unknown as JsonValue;
    assertJsonValue(value);
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const target = this.path;
    const temporaryPath = join(this.#directory, `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`);
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
