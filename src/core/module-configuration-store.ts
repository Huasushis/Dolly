import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, parse, resolve } from "node:path";
import {
  assertJsonValue,
  canonicalJsonDigest,
  canonicalizeJson,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import { parseStrictJsonBytes, StrictJsonError } from "./strict-json.js";
import { withSynchronousCrossProcessLock } from "./synchronous-cross-process-lock.js";
import { JsonSchemaError, validateJsonSchema } from "./json-schema.js";
import {
  ConfigMigrationRunner,
  createConfigRevision,
  type ConfigMigrationOptions,
} from "./config-revision.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONFIGURATION_BYTES = 256 * 1024;

export type ModuleConfigurationStoreErrorCode =
  | "CONFIGURATION_RECORD_NOT_FOUND"
  | "CONFIGURATION_RECORD_INVALID"
  | "CONFIGURATION_RECORD_CONFLICT"
  | "CONFIGURATION_SCHEMA_INVALID"
  | "CONFIGURATION_SCHEMA_MISMATCH"
  | "CONFIGURATION_VALUE_INVALID"
  | "CONFIGURATION_LIMIT_EXCEEDED"
  | "CONFIGURATION_IO_FAILED";

export class ModuleConfigurationStoreError extends Error {
  constructor(
    readonly code: ModuleConfigurationStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ModuleConfigurationStoreError";
  }
}

export interface ModuleConfigurationRecord extends Readonly<Record<string, JsonValue>> {
  readonly schemaVersion: "dolly.module-configuration/1";
  readonly configId: string;
  readonly revision: string;
  readonly extensionId: string;
  readonly moduleKind: string;
  readonly configVersion: number;
  readonly schemaDigest: string;
  readonly configurationDigest: string;
  readonly configuration: JsonValue;
}

export interface CreateModuleConfigurationInput {
  readonly configId: string;
  readonly extensionId: string;
  readonly moduleKind: string;
  readonly configVersion: number;
  readonly schema: JsonValue;
  readonly configuration: JsonValue;
}

export interface ResolveModuleConfigurationInput {
  readonly configId: string;
  readonly revision: string;
  readonly extensionId: string;
  readonly moduleKind: string;
  readonly configVersion: number;
  readonly schema: JsonValue;
}

export interface MigrateModuleConfigurationInput {
  /** The immutable source record, as persisted by this store. */
  readonly source: ModuleConfigurationRecord;
  /**
   * The migration runner carrying the registered one-step upgrade paths and
   * retained schemas (`config-revision.ts`). Its approval, idempotency,
   * schema, and byte-size gates run unchanged.
   */
  readonly migration: ConfigMigrationRunner;
  /** The target configuration version; the runner enforces positivity and that it exceeds the source version. */
  readonly targetVersion: number;
  /**
   * The retained JSON Schema for `targetVersion`. Its canonical digest is
   * bound into the returned record as `schemaDigest`, and it must actually
   * validate the migrated configuration; an inconsistent schema is refused
   * instead of producing a record the store cannot resolve.
   */
  readonly targetSchema: JsonValue;
  /** Passed through to the runner as `alreadyApplied` / `approvals`. */
  readonly options?: ConfigMigrationOptions;
}

export interface ModuleConfigurationStoreOptions {
  readonly directory: string;
  readonly maxRecordBytes?: number;
  readonly maxConfigurationBytes?: number;
  readonly nextTemporaryId?: () => string;
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
    throw new ModuleConfigurationStoreError(
      "CONFIGURATION_RECORD_INVALID",
      `${label} must be an object`,
    );
  }
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ModuleConfigurationStoreError(
      "CONFIGURATION_RECORD_INVALID",
      `${label} contains unknown fields`,
    );
  }
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ModuleConfigurationStoreError(
      "CONFIGURATION_RECORD_INVALID",
      `${label} is not a valid identifier`,
    );
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new ModuleConfigurationStoreError(
      "CONFIGURATION_RECORD_INVALID",
      `${label} is not a SHA-256 digest`,
    );
  }
}

function assertConfigVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ModuleConfigurationStoreError(
      "CONFIGURATION_RECORD_INVALID",
      "configVersion must be a positive safe integer",
    );
  }
}

function validateSchemaAndConfiguration(schema: JsonValue, configuration: JsonValue): void {
  try {
    validateJsonSchema(schema, configuration);
  } catch (error) {
    if (error instanceof JsonSchemaError && error.code === "JSON_SCHEMA_VALUE_INVALID") {
      throw new ModuleConfigurationStoreError(
        "CONFIGURATION_VALUE_INVALID",
        "Configuration does not satisfy its declared JSON Schema",
        { cause: error },
      );
    }
    throw new ModuleConfigurationStoreError(
      "CONFIGURATION_SCHEMA_INVALID",
      "Configuration JSON Schema is invalid or unsupported",
      { cause: error },
    );
  }
}

function revisionFor(
  input: Omit<ModuleConfigurationRecord, "schemaVersion" | "revision">,
): string {
  return canonicalJsonDigest(input);
}

function immutableRecord(record: ModuleConfigurationRecord): ModuleConfigurationRecord {
  return deepFreeze(cloneJson(record)) as ModuleConfigurationRecord;
}

export class ModuleConfigurationStore {
  readonly #directory: string;
  readonly #maxRecordBytes: number;
  readonly #maxConfigurationBytes: number;
  readonly #nextTemporaryId: () => string;

  constructor(options: ModuleConfigurationStoreOptions) {
    if (
      typeof options.directory !== "string" ||
      options.directory.length === 0 ||
      options.directory.includes("\0")
    ) {
      throw new TypeError("Configuration record directory is invalid");
    }
    const directory = resolve(options.directory);
    if (directory === parse(directory).root) {
      throw new TypeError("Configuration record directory cannot be a filesystem root");
    }
    this.#directory = directory;
    this.#maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.#maxConfigurationBytes =
      options.maxConfigurationBytes ?? DEFAULT_MAX_CONFIGURATION_BYTES;
    this.#nextTemporaryId = options.nextTemporaryId ?? randomUUID;
    for (const [label, value] of [
      ["maxRecordBytes", this.#maxRecordBytes],
      ["maxConfigurationBytes", this.#maxConfigurationBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 256) {
        throw new TypeError(`${label} must be a safe integer of at least 256 bytes`);
      }
    }
    if (this.#maxConfigurationBytes > this.#maxRecordBytes) {
      throw new TypeError("maxConfigurationBytes cannot exceed maxRecordBytes");
    }
  }

  create(input: CreateModuleConfigurationInput): ModuleConfigurationRecord {
    assertId(input.configId, "configId");
    assertId(input.extensionId, "extensionId");
    assertId(input.moduleKind, "moduleKind");
    assertConfigVersion(input.configVersion);
    assertJsonValue(input.schema);
    assertJsonValue(input.configuration);
    if (Buffer.byteLength(canonicalizeJson(input.configuration), "utf8") > this.#maxConfigurationBytes) {
      throw new ModuleConfigurationStoreError(
        "CONFIGURATION_LIMIT_EXCEEDED",
        "Configuration exceeds its byte limit",
      );
    }
    validateSchemaAndConfiguration(input.schema, input.configuration);

    const body = {
      configId: input.configId,
      extensionId: input.extensionId,
      moduleKind: input.moduleKind,
      configVersion: input.configVersion,
      schemaDigest: canonicalJsonDigest(input.schema),
      configurationDigest: canonicalJsonDigest(input.configuration),
      configuration: cloneJson(input.configuration),
    } as const;
    const record = immutableRecord({
      schemaVersion: "dolly.module-configuration/1",
      ...body,
      revision: revisionFor(body),
    });
    const path = this.#recordPath(record.configId, record.revision);
    return withSynchronousCrossProcessLock({ resourceId: `${path}.lock` }, () => {
      if (existsSync(path)) {
        const existing = this.#read(path);
        if (canonicalizeJson(existing) !== canonicalizeJson(record)) {
          throw new ModuleConfigurationStoreError(
            "CONFIGURATION_RECORD_CONFLICT",
            "Configuration revision already exists with different content",
          );
        }
        return existing;
      }
      this.#writeNew(path, record);
      return record;
    });
  }

  resolve(input: ResolveModuleConfigurationInput): ModuleConfigurationRecord {
    assertId(input.configId, "configId");
    assertDigest(input.revision, "revision");
    assertId(input.extensionId, "extensionId");
    assertId(input.moduleKind, "moduleKind");
    assertConfigVersion(input.configVersion);
    assertJsonValue(input.schema);
    const path = this.#recordPath(input.configId, input.revision);
    if (!existsSync(path)) {
      throw new ModuleConfigurationStoreError(
        "CONFIGURATION_RECORD_NOT_FOUND",
        "Configuration record does not exist",
      );
    }
    const record = this.#read(path);
    if (
      record.configId !== input.configId ||
      record.revision !== input.revision ||
      record.extensionId !== input.extensionId ||
      record.moduleKind !== input.moduleKind ||
      record.configVersion !== input.configVersion
    ) {
      throw new ModuleConfigurationStoreError(
        "CONFIGURATION_RECORD_CONFLICT",
        "Configuration record identity does not match the Module reference",
      );
    }
    if (record.schemaDigest !== canonicalJsonDigest(input.schema)) {
      throw new ModuleConfigurationStoreError(
        "CONFIGURATION_SCHEMA_MISMATCH",
        "Configuration schema does not match the stored schema digest",
      );
    }
    validateSchemaAndConfiguration(input.schema, record.configuration);
    return record;
  }

  #recordPath(configId: string, revision: string): string {
    const fileName = createHash("sha256")
      .update(canonicalizeJson([configId, revision]), "utf8")
      .digest("hex");
    return join(this.#directory, `${fileName}.json`);
  }

  #read(path: string): ModuleConfigurationRecord {
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || statSync(path).size > this.#maxRecordBytes) {
        throw new ModuleConfigurationStoreError(
          "CONFIGURATION_RECORD_INVALID",
          "Configuration record is not a bounded regular file",
        );
      }
      const value = parseStrictJsonBytes(readFileSync(path), {
        maxBytes: this.#maxRecordBytes,
        maxDepth: 128,
      });
      assertClosedObject(
        value,
        [
          "schemaVersion",
          "configId",
          "revision",
          "extensionId",
          "moduleKind",
          "configVersion",
          "schemaDigest",
          "configurationDigest",
          "configuration",
        ],
        "Configuration record",
      );
      if (value.schemaVersion !== "dolly.module-configuration/1") {
        throw new ModuleConfigurationStoreError(
          "CONFIGURATION_RECORD_INVALID",
          "Configuration record schema is unsupported",
        );
      }
      assertId(value.configId, "configId");
      assertDigest(value.revision, "revision");
      assertId(value.extensionId, "extensionId");
      assertId(value.moduleKind, "moduleKind");
      assertConfigVersion(value.configVersion);
      assertDigest(value.schemaDigest, "schemaDigest");
      assertDigest(value.configurationDigest, "configurationDigest");
      assertJsonValue(value.configuration);
      if (canonicalJsonDigest(value.configuration) !== value.configurationDigest) {
        throw new ModuleConfigurationStoreError(
          "CONFIGURATION_RECORD_INVALID",
          "Configuration content digest does not match the record",
        );
      }
      const body = {
        configId: value.configId,
        extensionId: value.extensionId,
        moduleKind: value.moduleKind,
        configVersion: value.configVersion,
        schemaDigest: value.schemaDigest,
        configurationDigest: value.configurationDigest,
        configuration: value.configuration,
      };
      if (revisionFor(body) !== value.revision) {
        throw new ModuleConfigurationStoreError(
          "CONFIGURATION_RECORD_INVALID",
          "Configuration revision does not match the record content",
        );
      }
      return immutableRecord(value as unknown as ModuleConfigurationRecord);
    } catch (error) {
      if (error instanceof ModuleConfigurationStoreError) throw error;
      if (error instanceof StrictJsonError) {
        throw new ModuleConfigurationStoreError(
          "CONFIGURATION_RECORD_INVALID",
          "Configuration record JSON is invalid or ambiguous",
          { cause: error },
        );
      }
      throw new ModuleConfigurationStoreError(
        "CONFIGURATION_IO_FAILED",
        "Configuration record could not be read",
        { cause: error },
      );
    }
  }

  #writeNew(path: string, record: ModuleConfigurationRecord): void {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${this.#nextTemporaryId()}.tmp`;
    let descriptor: number | undefined;
    try {
      const bytes = Buffer.from(`${canonicalizeJson(record)}\n`, "utf8");
      if (bytes.byteLength > this.#maxRecordBytes) {
        throw new ModuleConfigurationStoreError(
          "CONFIGURATION_LIMIT_EXCEEDED",
          "Configuration record exceeds its byte limit",
        );
      }
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The original failure is more useful; stale temp files are never read as records.
      }
      if (error instanceof ModuleConfigurationStoreError) throw error;
      throw new ModuleConfigurationStoreError(
        "CONFIGURATION_IO_FAILED",
        "Configuration record could not be written",
        { cause: error },
      );
    }
  }
}

/**
 * Migrate one immutable configuration record to `targetVersion` through the
 * pure `ConfigMigrationRunner`, producing the target record exactly as this
 * store would persist it. This is the deterministic bridge between the
 * proposed Host-internal configuration-value upgrade contract
 * (`docs/adr/0010-configuration-value-upgrade-chain.md`, ADR-0010, implemented
 * in `config-revision.ts`) and the durable store: a Host migration flow
 * resolves the source record here, calls this function, and persists the
 * returned record with `create`.
 *
 * The runner enforces every migration gate unchanged (target/source version
 * reachability, per-step schema validation, approval for loss-declaring
 * steps, idempotent replay by operation id, output-size and expansion
 * limits). This function is pure: it performs no I/O, does not mutate
 * `source`, and only validates that the supplied `targetSchema` actually
 * validates the migrated configuration so the returned `schemaDigest` binds a
 * consistent schema.
 */
export function migrateModuleConfigurationRecord(
  input: MigrateModuleConfigurationInput,
): ModuleConfigurationRecord {
  assertJsonValue(input.targetSchema);
  const sourceRevision = createConfigRevision({
    configId: input.source.configId,
    extensionId: input.source.extensionId,
    moduleKind: input.source.moduleKind,
    configVersion: input.source.configVersion,
    configuration: input.source.configuration,
  });
  const result = input.migration.migrate(sourceRevision, input.targetVersion, input.options);
  validateSchemaAndConfiguration(input.targetSchema, result.revision.configuration);
  const body = {
    configId: input.source.configId,
    extensionId: input.source.extensionId,
    moduleKind: input.source.moduleKind,
    configVersion: result.revision.configVersion,
    schemaDigest: canonicalJsonDigest(input.targetSchema),
    configurationDigest: canonicalJsonDigest(result.revision.configuration),
    configuration: result.revision.configuration,
  } as const;
  return immutableRecord({
    schemaVersion: "dolly.module-configuration/1",
    ...body,
    revision: revisionFor(body),
  });
}
