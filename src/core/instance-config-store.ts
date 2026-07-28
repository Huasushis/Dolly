import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  assertJsonValue,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import { parseStrictJsonBytes } from "./strict-json.js";
import {
  SynchronousCrossProcessLockError,
  withSynchronousCrossProcessLock,
} from "./synchronous-cross-process-lock.js";

const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type InstanceConfigErrorCode =
  | "CONFIG_PATH_INVALID"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_NOT_REGULAR_FILE"
  | "CONFIG_LIMIT_EXCEEDED"
  | "CONFIG_DOCUMENT_INVALID"
  | "CONFIG_INSTANCE_ID_INVALID"
  | "CONFIG_INSTANCE_ID_CHANGED"
  | "CONFIG_REVISION_CONFLICT"
  | "CONFIG_STATE_DIRECTORY_CHANGED"
  | "CONFIG_LOCKED"
  | "CONFIG_ALREADY_EXISTS"
  | "INSTANCE_ID_COLLISION"
  | "INSTANCE_NOT_REGISTERED"
  | "INSTANCE_REBIND_SOURCE_MISMATCH"
  | "STATE_MANIFEST_CONFLICT"
  | "CONFIG_IO_FAILED";

export class InstanceConfigError extends Error {
  constructor(
    readonly code: InstanceConfigErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InstanceConfigError";
  }
}

export interface InstanceConfigSchema<T extends JsonValue> {
  readonly schemaVersion: string;
  validate(value: JsonValue): T;
  instanceId(document: T): string;
  stateDirectory(document: T): string | undefined;
  withInstanceId(document: T, instanceId: string): T;
  redact(document: T): JsonValue;
}

export interface LoadedInstanceConfig<T extends JsonValue> {
  readonly document: Readonly<T>;
  readonly schemaVersion: string;
  readonly instanceId: string;
  readonly configPath: string;
  readonly stateDirectory: string;
  readonly configRevision: string;
  readonly redactedDocument: JsonValue;
}

interface RegistryRecord {
  readonly schemaVersion: "dolly.instance-registry/1";
  readonly instanceId: string;
  readonly configPath: string;
  readonly stateDirectory: string;
  readonly desiredConfigRevision: string;
  readonly updatedAt: string;
}

interface StateManifest {
  readonly schemaVersion: "dolly.state-manifest/1";
  readonly instanceId: string;
}

export interface InstanceConfigStoreOptions<T extends JsonValue> {
  readonly schema: InstanceConfigSchema<T>;
  readonly registryDirectory: string;
  readonly defaultStateRoot: string;
  readonly maxConfigBytes?: number;
  readonly nextInstanceId?: () => string;
  readonly now?: () => string;
}

const DEFAULT_MAX_CONFIG_BYTES = 1024 * 1024;

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new InstanceConfigError("CONFIG_DOCUMENT_INVALID", `${label} must be an object`);
  }
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new InstanceConfigError(
      "CONFIG_DOCUMENT_INVALID",
      `${label} contains unknown fields: ${unexpected.sort().join(", ")}`,
    );
  }
}

function assertInstanceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !INSTANCE_ID_PATTERN.test(value)) {
    throw new InstanceConfigError(
      "CONFIG_INSTANCE_ID_INVALID",
      "instanceId must be a lowercase UUIDv4",
    );
  }
}

function canonicalTime(now: () => string): string {
  const timestamp = Date.parse(now());
  if (!Number.isFinite(timestamp)) {
    throw new InstanceConfigError("CONFIG_IO_FAILED", "Configuration clock is invalid");
  }
  return new Date(timestamp).toISOString();
}

function comparisonPath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function samePath(left: string, right: string): boolean {
  return comparisonPath(left) === comparisonPath(right);
}

function assertUsableDirectoryPath(value: string, label: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new InstanceConfigError("CONFIG_PATH_INVALID", `${label} is invalid`);
  }
  const normalized = resolve(value);
  if (normalized === parse(normalized).root) {
    throw new InstanceConfigError("CONFIG_PATH_INVALID", `${label} cannot be a filesystem root`);
  }
}

function parseRegistryRecord(bytes: Uint8Array, maxBytes: number): RegistryRecord {
  const value = parseStrictJsonBytes(bytes, { maxBytes, maxDepth: 16 });
  assertClosedObject(
    value,
    [
      "schemaVersion",
      "instanceId",
      "configPath",
      "stateDirectory",
      "desiredConfigRevision",
      "updatedAt",
    ],
    "instance registry record",
  );
  if (value.schemaVersion !== "dolly.instance-registry/1") {
    throw new InstanceConfigError("CONFIG_DOCUMENT_INVALID", "Registry schema is unsupported");
  }
  assertInstanceId(value.instanceId);
  if (
    typeof value.configPath !== "string" ||
    !isAbsolute(value.configPath) ||
    typeof value.stateDirectory !== "string" ||
    !isAbsolute(value.stateDirectory) ||
    typeof value.desiredConfigRevision !== "string" ||
    !REVISION_PATTERN.test(value.desiredConfigRevision) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new InstanceConfigError("CONFIG_DOCUMENT_INVALID", "Registry record is invalid");
  }
  return value as unknown as RegistryRecord;
}

function parseStateManifest(bytes: Uint8Array, maxBytes: number): StateManifest {
  const value = parseStrictJsonBytes(bytes, { maxBytes, maxDepth: 8 });
  assertClosedObject(value, ["schemaVersion", "instanceId"], "state manifest");
  if (value.schemaVersion !== "dolly.state-manifest/1") {
    throw new InstanceConfigError("CONFIG_DOCUMENT_INVALID", "State manifest schema is unsupported");
  }
  assertInstanceId(value.instanceId);
  return value as unknown as StateManifest;
}

export class InstanceConfigStore<T extends JsonValue> {
  readonly #schema: InstanceConfigSchema<T>;
  readonly #registryDirectory: string;
  readonly #defaultStateRoot: string;
  readonly #maxConfigBytes: number;
  readonly #nextInstanceId: () => string;
  readonly #now: () => string;

  constructor(options: InstanceConfigStoreOptions<T>) {
    assertUsableDirectoryPath(options.registryDirectory, "registryDirectory");
    assertUsableDirectoryPath(options.defaultStateRoot, "defaultStateRoot");
    this.#schema = options.schema;
    this.#registryDirectory = resolve(options.registryDirectory);
    this.#defaultStateRoot = resolve(options.defaultStateRoot);
    this.#maxConfigBytes = options.maxConfigBytes ?? DEFAULT_MAX_CONFIG_BYTES;
    this.#nextInstanceId = options.nextInstanceId ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
    if (!Number.isSafeInteger(this.#maxConfigBytes) || this.#maxConfigBytes < 256) {
      throw new TypeError("maxConfigBytes must be a safe integer of at least 256 bytes");
    }
    if (typeof options.schema.schemaVersion !== "string" || options.schema.schemaVersion === "") {
      throw new TypeError("schemaVersion must be a non-empty string");
    }
  }

  inspect(configPathInput: string): LoadedInstanceConfig<T> {
    const configPath = this.#canonicalExistingFile(configPathInput);
    let bytes: Buffer;
    try {
      const size = statSync(configPath).size;
      if (size > this.#maxConfigBytes) {
        throw new InstanceConfigError(
          "CONFIG_LIMIT_EXCEEDED",
          "Configuration exceeds its byte limit",
        );
      }
      bytes = readFileSync(configPath);
    } catch (error) {
      if (error instanceof InstanceConfigError) throw error;
      throw new InstanceConfigError("CONFIG_IO_FAILED", "Could not read configuration", {
        cause: error,
      });
    }

    let document: T;
    try {
      const parsed = parseStrictJsonBytes(bytes, {
        maxBytes: this.#maxConfigBytes,
        maxDepth: 128,
      });
      document = this.#schema.validate(parsed);
      assertJsonValue(document);
    } catch (error) {
      if (error instanceof InstanceConfigError) throw error;
      throw new InstanceConfigError(
        "CONFIG_DOCUMENT_INVALID",
        "Configuration does not satisfy its closed schema",
        { cause: error },
      );
    }

    const instanceId = this.#schema.instanceId(document);
    assertInstanceId(instanceId);
    const immutable = deepFreeze(cloneJson(document)) as Readonly<T>;
    const stateValue = this.#schema.stateDirectory(document);
    if (stateValue !== undefined && (typeof stateValue !== "string" || stateValue === "")) {
      throw new InstanceConfigError(
        "CONFIG_PATH_INVALID",
        "Configured stateDirectory must be a non-empty path",
      );
    }
    const stateDirectory = resolve(
      stateValue === undefined
        ? join(this.#defaultStateRoot, instanceId)
        : isAbsolute(stateValue)
          ? stateValue
          : join(dirname(configPath), stateValue),
    );
    assertUsableDirectoryPath(stateDirectory, "stateDirectory");

    let redactedDocument: JsonValue;
    try {
      redactedDocument = this.#schema.redact(document);
      assertJsonValue(redactedDocument);
    } catch (error) {
      throw new InstanceConfigError(
        "CONFIG_DOCUMENT_INVALID",
        "Configuration redaction did not return JSON",
        { cause: error },
      );
    }

    return deepFreeze({
      document: immutable,
      schemaVersion: this.#schema.schemaVersion,
      instanceId,
      configPath,
      stateDirectory,
      configRevision: canonicalJsonDigest(immutable),
      redactedDocument: cloneJson(redactedDocument),
    }) as LoadedInstanceConfig<T>;
  }

  claim(
    configPath: string,
    expected?: Pick<LoadedInstanceConfig<T>, "instanceId" | "configRevision">,
  ): LoadedInstanceConfig<T> {
    const canonicalPath = this.#canonicalExistingFile(configPath);
    return this.#withLock(`config:${comparisonPath(canonicalPath)}`, () => {
      const loaded = this.inspect(canonicalPath);
      if (expected !== undefined && loaded.instanceId !== expected.instanceId) {
        throw new InstanceConfigError(
          "CONFIG_INSTANCE_ID_CHANGED",
          "Configuration instanceId changed since it was inspected",
        );
      }
      if (expected !== undefined && loaded.configRevision !== expected.configRevision) {
        throw new InstanceConfigError(
          "CONFIG_REVISION_CONFLICT",
          "Configuration changed since the requested revision",
        );
      }
      return this.#claimLoaded(loaded);
    });
  }

  #claimLoaded(loaded: LoadedInstanceConfig<T>): LoadedInstanceConfig<T> {
    return this.#withLock(`instance:${loaded.instanceId}`, () => {
      const existing = this.#readRegistry(loaded.instanceId);
      if (existing && !samePath(existing.configPath, loaded.configPath)) {
        throw new InstanceConfigError(
          "INSTANCE_ID_COLLISION",
          "instanceId is already bound to another configuration path; use explicit rebind or clone",
        );
      }
      if (existing && !samePath(existing.stateDirectory, loaded.stateDirectory)) {
        throw new InstanceConfigError(
          "CONFIG_STATE_DIRECTORY_CHANGED",
          "State directory changes require an explicit state migration",
        );
      }
      this.#ensureStateManifest(loaded);
      this.#writeRegistry(loaded);
      return loaded;
    });
  }

  initialize(
    configPathInput: string,
    createDocument: (instanceId: string) => T,
  ): LoadedInstanceConfig<T> {
    const destination = this.#canonicalDestination(configPathInput);
    const instanceId = this.#nextInstanceId();
    assertInstanceId(instanceId);
    const document = this.#schema.validate(createDocument(instanceId));
    if (this.#schema.instanceId(document) !== instanceId) {
      throw new InstanceConfigError(
        "CONFIG_INSTANCE_ID_INVALID",
        "Initialized document did not preserve its allocated instanceId",
      );
    }

    return this.#withLock(`config:${comparisonPath(destination)}`, () => {
      if (existsSync(destination)) {
        throw new InstanceConfigError(
          "CONFIG_ALREADY_EXISTS",
          "Configuration destination already exists",
        );
      }
      this.#writeAtomic(destination, document, false);
      try {
        return this.#claimLoaded(this.inspect(destination));
      } catch (error) {
        try {
          unlinkSync(destination);
          fsyncDirectory(dirname(destination));
        } catch {
          // Preserve the original failure; an unclaimed valid file is recoverable.
        }
        throw error;
      }
    });
  }

  update(
    configPathInput: string,
    expectedRevision: string,
    replaceDocument: (current: Readonly<T>) => T,
  ): LoadedInstanceConfig<T> {
    const initialPath = this.#canonicalExistingFile(configPathInput);
    return this.#withLock(`config:${comparisonPath(initialPath)}`, () => {
      const current = this.inspect(initialPath);
      if (current.configRevision !== expectedRevision) {
        throw new InstanceConfigError(
          "CONFIG_REVISION_CONFLICT",
          "Configuration changed since the requested revision",
        );
      }
      const replacement = this.#schema.validate(replaceDocument(current.document));
      if (this.#schema.instanceId(replacement) !== current.instanceId) {
        throw new InstanceConfigError(
          "CONFIG_INSTANCE_ID_CHANGED",
          "Ordinary configuration updates cannot change instanceId",
        );
      }
      const replacementState = this.#resolvedStateDirectory(replacement, current.configPath);
      if (!samePath(replacementState, current.stateDirectory)) {
        throw new InstanceConfigError(
          "CONFIG_STATE_DIRECTORY_CHANGED",
          "Ordinary configuration updates cannot move stateDirectory",
        );
      }
      this.#writeAtomic(current.configPath, replacement, true);
      return this.#claimLoaded(this.inspect(current.configPath));
    });
  }

  rebind(
    expectedCurrentPathInput: string,
    newConfigPathInput: string,
  ): LoadedInstanceConfig<T> {
    const newConfigPath = this.#canonicalExistingFile(newConfigPathInput);
    return this.#withLock(`config:${comparisonPath(newConfigPath)}`, () => {
      const rebound = this.inspect(newConfigPath);
      const expectedCurrentPath = this.#canonicalLocator(expectedCurrentPathInput);
      return this.#withLock(`instance:${rebound.instanceId}`, () => {
        const existing = this.#readRegistry(rebound.instanceId);
        if (!existing) {
          throw new InstanceConfigError(
            "INSTANCE_NOT_REGISTERED",
            "Cannot rebind an unregistered instance",
          );
        }
        if (!samePath(existing.configPath, expectedCurrentPath)) {
          throw new InstanceConfigError(
            "INSTANCE_REBIND_SOURCE_MISMATCH",
            "Rebind source does not match the registered configuration locator",
          );
        }
        if (!samePath(existing.stateDirectory, rebound.stateDirectory)) {
          throw new InstanceConfigError(
            "CONFIG_STATE_DIRECTORY_CHANGED",
            "Rebind must preserve the registered stateDirectory",
          );
        }
        this.#ensureStateManifest(rebound);
        this.#writeRegistry(rebound);
        return rebound;
      });
    });
  }

  clone(
    sourceConfigPath: string,
    destinationConfigPathInput: string,
    transform?: (document: T, newInstanceId: string) => T,
  ): LoadedInstanceConfig<T> {
    const source = this.inspect(sourceConfigPath);
    const destination = this.#canonicalDestination(destinationConfigPathInput);
    const instanceId = this.#nextInstanceId();
    assertInstanceId(instanceId);
    const sourceCopy = cloneJson(source.document as T);
    const replacement = transform
      ? transform(sourceCopy, instanceId)
      : this.#schema.withInstanceId(sourceCopy, instanceId);
    const document = this.#schema.validate(replacement);
    if (this.#schema.instanceId(document) !== instanceId) {
      throw new InstanceConfigError(
        "CONFIG_INSTANCE_ID_INVALID",
        "Cloned document did not preserve its allocated instanceId",
      );
    }

    return this.#withLock(`config:${comparisonPath(destination)}`, () => {
      if (existsSync(destination)) {
        throw new InstanceConfigError(
          "CONFIG_ALREADY_EXISTS",
          "Clone destination already exists",
        );
      }
      this.#writeAtomic(destination, document, false);
      try {
        return this.#claimLoaded(this.inspect(destination));
      } catch (error) {
        try {
          unlinkSync(destination);
          fsyncDirectory(dirname(destination));
        } catch {
          // Preserve the original failure; an unclaimed valid file is recoverable.
        }
        throw error;
      }
    });
  }

  #resolvedStateDirectory(document: T, configPath: string): string {
    const configured = this.#schema.stateDirectory(document);
    return resolve(
      configured === undefined
        ? join(this.#defaultStateRoot, this.#schema.instanceId(document))
        : isAbsolute(configured)
          ? configured
          : join(dirname(configPath), configured),
    );
  }

  #canonicalExistingFile(pathInput: string): string {
    if (typeof pathInput !== "string" || pathInput.length === 0 || pathInput.includes("\0")) {
      throw new InstanceConfigError("CONFIG_PATH_INVALID", "Configuration path is invalid");
    }
    const absolute = resolve(pathInput);
    if (!existsSync(absolute)) {
      throw new InstanceConfigError("CONFIG_NOT_FOUND", "Configuration does not exist");
    }
    try {
      const canonical = realpathSync.native(absolute);
      if (!statSync(canonical).isFile()) {
        throw new InstanceConfigError(
          "CONFIG_NOT_REGULAR_FILE",
          "Configuration must be a regular file",
        );
      }
      return canonical;
    } catch (error) {
      if (error instanceof InstanceConfigError) throw error;
      throw new InstanceConfigError("CONFIG_IO_FAILED", "Could not resolve configuration path", {
        cause: error,
      });
    }
  }

  #canonicalDestination(pathInput: string): string {
    if (typeof pathInput !== "string" || pathInput.length === 0 || pathInput.includes("\0")) {
      throw new InstanceConfigError("CONFIG_PATH_INVALID", "Configuration path is invalid");
    }
    const absolute = resolve(pathInput);
    const parent = dirname(absolute);
    try {
      const canonicalParent = realpathSync.native(parent);
      if (!statSync(canonicalParent).isDirectory()) {
        throw new InstanceConfigError(
          "CONFIG_PATH_INVALID",
          "Configuration parent must be a directory",
        );
      }
      return join(canonicalParent, basename(absolute));
    } catch (error) {
      if (error instanceof InstanceConfigError) throw error;
      throw new InstanceConfigError(
        "CONFIG_PATH_INVALID",
        "Configuration parent directory does not exist",
        { cause: error },
      );
    }
  }

  #canonicalLocator(pathInput: string): string {
    if (existsSync(resolve(pathInput))) return this.#canonicalExistingFile(pathInput);
    return this.#canonicalDestination(pathInput);
  }

  #registryPath(instanceId: string): string {
    return join(this.#registryDirectory, "instances", `${instanceId}.json`);
  }

  #readRegistry(instanceId: string): RegistryRecord | null {
    const path = this.#registryPath(instanceId);
    if (!existsSync(path)) return null;
    try {
      return parseRegistryRecord(readFileSync(path), this.#maxConfigBytes);
    } catch (error) {
      if (error instanceof InstanceConfigError) throw error;
      throw new InstanceConfigError("CONFIG_IO_FAILED", "Could not read instance registry", {
        cause: error,
      });
    }
  }

  #writeRegistry(loaded: LoadedInstanceConfig<T>): void {
    const record: RegistryRecord = {
      schemaVersion: "dolly.instance-registry/1",
      instanceId: loaded.instanceId,
      configPath: loaded.configPath,
      stateDirectory: loaded.stateDirectory,
      desiredConfigRevision: loaded.configRevision,
      updatedAt: canonicalTime(this.#now),
    };
    this.#writeAtomic(this.#registryPath(loaded.instanceId), record as unknown as JsonValue, true);
  }

  #ensureStateManifest(loaded: LoadedInstanceConfig<T>): void {
    mkdirSync(loaded.stateDirectory, { recursive: true, mode: 0o700 });
    const manifestPath = join(loaded.stateDirectory, ".dolly-instance.json");
    if (existsSync(manifestPath)) {
      let manifest: StateManifest;
      try {
        manifest = parseStateManifest(readFileSync(manifestPath), this.#maxConfigBytes);
      } catch (error) {
        if (error instanceof InstanceConfigError) throw error;
        throw new InstanceConfigError("CONFIG_IO_FAILED", "Could not read state manifest", {
          cause: error,
        });
      }
      if (manifest.instanceId !== loaded.instanceId) {
        throw new InstanceConfigError(
          "STATE_MANIFEST_CONFLICT",
          "State directory belongs to another instanceId",
        );
      }
      return;
    }
    const manifest: StateManifest = {
      schemaVersion: "dolly.state-manifest/1",
      instanceId: loaded.instanceId,
    };
    this.#writeAtomic(manifestPath, manifest as unknown as JsonValue, false);
  }

  #withLock<R>(identity: string, operation: () => R): R {
    const lockDirectory = join(this.#registryDirectory, "locks");
    mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
    const digest = createHash("sha256").update(identity, "utf8").digest("hex");
    const lockPath = join(lockDirectory, `${digest}.lock`);
    try {
      return withSynchronousCrossProcessLock({ resourceId: lockPath }, operation);
    } catch (error) {
      if (!(error instanceof SynchronousCrossProcessLockError)) throw error;
      if (error.code === "CROSS_PROCESS_LOCK_HELD") {
        throw new InstanceConfigError(
          "CONFIG_LOCKED",
          "Another configuration operation owns the required lock",
        );
      }
      throw new InstanceConfigError("CONFIG_IO_FAILED", "Could not acquire configuration lock", {
        cause: error,
      });
    }
  }

  #writeAtomic(path: string, value: JsonValue, replaceExisting: boolean): void {
    assertJsonValue(value);
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!replaceExisting && existsSync(path)) {
      throw new InstanceConfigError("CONFIG_ALREADY_EXISTS", "Target file already exists");
    }
    const temporaryPath = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      if (!replaceExisting && existsSync(path)) {
        throw new InstanceConfigError("CONFIG_ALREADY_EXISTS", "Target file already exists");
      }
      renameSync(temporaryPath, path);
      fsyncDirectory(parent);
    } catch (error) {
      if (error instanceof InstanceConfigError) throw error;
      throw new InstanceConfigError("CONFIG_IO_FAILED", "Atomic configuration write failed", {
        cause: error,
      });
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The primary write result is more useful than a second close error.
        }
      }
      if (existsSync(temporaryPath)) {
        try {
          unlinkSync(temporaryPath);
          fsyncDirectory(parent);
        } catch {
          // A same-directory temporary is recoverable and never treated as committed.
        }
      }
    }
  }
}
