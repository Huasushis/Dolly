/**
 * Immutable configuration revisions and the deterministic migration runner.
 *
 * A configuration revision binds a content-addressed revision identity to a
 * frozen configuration snapshot together with the identity fields a Module
 * resolution checks before extension code starts
 * (`extension-process-protocol.md` Section 7.1.1). A `(configId, revision)`
 * pair is immutable: an edit creates a new revision, and the previous pair is
 * never overwritten.
 *
 * The migration runner implements the Section 7.2 contract for one-step
 * upgrade paths vN -> vN+1. It validates the stored snapshot against the
 * retained source-version schema, validates the result of every step against
 * the next version's schema before accepting it, and refuses a target version
 * that is not higher than the source or is not reachable through the
 * registered one-step paths and retained schemas.
 */

import {
  assertJsonValue,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import { JsonSchemaError, validateJsonSchema } from "./json-schema.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DECIMAL_SEQUENCE_PATTERN = /^(0|[1-9][0-9]*)$/u;

export type ConfigRevisionErrorCode =
  | "CONFIG_REVISION_INVALID"
  | "CONFIG_MIGRATION_REFUSED"
  | "CONFIG_VERSION_UNSUPPORTED"
  | "CONFIG_MIGRATION_STEP_MISSING"
  | "CONFIG_TARGET_VERSION_UNSUPPORTED"
  | "CONFIG_MIGRATION_OUTPUT_INVALID"
  | "CONFIG_MIGRATION_VALUE_INVALID";

export class ConfigRevisionError extends Error {
  constructor(
    readonly code: ConfigRevisionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ConfigRevisionError";
  }
}

/** The immutable identity and snapshot fields of one configuration revision. */
export interface ConfigRevisionInput {
  readonly configId: string;
  readonly extensionId: string;
  readonly moduleKind: string;
  readonly configVersion: number;
  readonly configuration: JsonValue;
}

/**
 * A fully validated, deeply frozen configuration revision. `revision` is the
 * canonical digest of the complete record content and `configurationDigest`
 * the canonical digest of the snapshot, so both integrity checks reuse the
 * same RFC 8785 canonicalization as the rest of Core.
 */
export interface ConfigRevision extends Readonly<Record<string, JsonValue>> {
  readonly schemaVersion: "dolly.config-revision/1";
  readonly configId: string;
  readonly revision: string;
  readonly extensionId: string;
  readonly moduleKind: string;
  readonly configVersion: number;
  readonly configurationDigest: string;
  readonly configuration: JsonValue;
}

/** One accepted migration result: JSON plus ordered structured warnings. */
export interface ConfigMigrationOutput {
  readonly configuration: JsonValue;
  readonly warnings: readonly string[];
}

/** A one-step, deterministic migration from version `fromVersion` to `fromVersion + 1`. */
export type ConfigMigration = (source: JsonValue) => ConfigMigrationOutput;

export interface ConfigMigrationStep {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: ConfigMigration;
}

export interface ConfigMigrationResult {
  /** The new immutable revision at the target version. */
  readonly revision: ConfigRevision;
  /** Warnings from every applied step, in application order. */
  readonly warnings: readonly string[];
}

export interface ConfigMigrationRunnerOptions {
  /**
   * The retained JSON Schema (Draft 2020-12) for each supported
   * `configVersion`. A version without a schema is unknown and unreachable.
   */
  readonly schemas: Readonly<Record<number, JsonValue>>;
  /** The registered one-step migrations, keyed by their source version. */
  readonly migrations: readonly ConfigMigrationStep[];
}

const MIGRATION_OUTPUT_KEYS: Readonly<Record<string, true>> = {
  configuration: true,
  warnings: true,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ConfigRevisionError(
      "CONFIG_REVISION_INVALID",
      `${label} is not a valid identifier`,
    );
  }
}

function assertConfigVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ConfigRevisionError(
      "CONFIG_REVISION_INVALID",
      "configVersion must be a positive safe integer",
    );
  }
}

/**
 * Build a validated, deeply frozen configuration revision. The revision
 * identity is derived from the complete record content, so equal inputs always
 * produce the same revision.
 */
export function createConfigRevision(input: ConfigRevisionInput): ConfigRevision {
  assertId(input.configId, "configId");
  assertId(input.extensionId, "extensionId");
  assertId(input.moduleKind, "moduleKind");
  assertConfigVersion(input.configVersion);
  try {
    assertJsonValue(input.configuration);
  } catch (error) {
    throw new ConfigRevisionError(
      "CONFIG_REVISION_INVALID",
      "configuration is not a valid JSON value",
      { cause: error },
    );
  }
  const frozenConfiguration = deepFreeze(cloneJson(input.configuration)) as JsonValue;
  const body = {
    configId: input.configId,
    extensionId: input.extensionId,
    moduleKind: input.moduleKind,
    configVersion: input.configVersion,
    configurationDigest: canonicalJsonDigest(frozenConfiguration),
    configuration: frozenConfiguration,
  } as const;
  return deepFreeze({
    schemaVersion: "dolly.config-revision/1",
    ...body,
    revision: canonicalJsonDigest(body),
  }) as unknown as ConfigRevision;
}

function parseMigrationOutput(value: unknown): ConfigMigrationOutput {
  if (!isPlainObject(value)) {
    throw new ConfigRevisionError(
      "CONFIG_MIGRATION_OUTPUT_INVALID",
      "Migration must return a JSON object",
    );
  }
  if (Object.keys(value).some((key) => !MIGRATION_OUTPUT_KEYS[key])) {
    throw new ConfigRevisionError(
      "CONFIG_MIGRATION_OUTPUT_INVALID",
      "Migration output contains unknown fields",
    );
  }
  let configuration: JsonValue;
  try {
    assertJsonValue(value.configuration);
    configuration = value.configuration as JsonValue;
  } catch (error) {
    throw new ConfigRevisionError(
      "CONFIG_MIGRATION_OUTPUT_INVALID",
      "Migration configuration is not a valid JSON value",
      { cause: error },
    );
  }
  if (
    !Array.isArray(value.warnings) ||
    value.warnings.some((warning) => typeof warning !== "string")
  ) {
    throw new ConfigRevisionError(
      "CONFIG_MIGRATION_OUTPUT_INVALID",
      "Migration warnings must be an array of strings",
    );
  }
  const frozenConfiguration = deepFreeze(cloneJson(configuration)) as JsonValue;
  const warnings: readonly string[] = [...value.warnings];
  return { configuration: frozenConfiguration, warnings };
}

/**
 * Applies deterministic one-step migrations to immutable configuration
 * revisions. The runner is side-effect free: `migrate` only reads its inputs
 * and returns a new revision, so equal inputs produce equal outputs.
 */
export class ConfigMigrationRunner {
  readonly #schemas: ReadonlyMap<number, JsonValue>;
  readonly #steps: ReadonlyMap<number, ConfigMigrationStep>;
  readonly #maxVersion: number;

  constructor(options: ConfigMigrationRunnerOptions) {
    const schemas = new Map<number, JsonValue>();
    for (const [key, schema] of Object.entries(options.schemas)) {
      if (!DECIMAL_SEQUENCE_PATTERN.test(key)) {
        throw new TypeError(`Schema version "${key}" is not a decimal integer key`);
      }
      const version = Number(key);
      if (version <= 0 || !Number.isSafeInteger(version)) {
        throw new TypeError(`Schema version "${key}" is not a positive safe integer`);
      }
      assertJsonValue(schema);
      schemas.set(version, schema);
    }

    const steps = new Map<number, ConfigMigrationStep>();
    for (const step of options.migrations) {
      if (!Number.isSafeInteger(step.fromVersion) || step.fromVersion <= 0) {
        throw new TypeError("Migration fromVersion must be a positive safe integer");
      }
      if (
        !Number.isSafeInteger(step.toVersion) ||
        step.toVersion !== step.fromVersion + 1
      ) {
        throw new TypeError("Migration toVersion must be exactly fromVersion + 1");
      }
      if (typeof step.migrate !== "function") {
        throw new TypeError("Migration migrate must be a function");
      }
      if (steps.has(step.fromVersion)) {
        throw new TypeError(`Duplicate migration from version ${step.fromVersion}`);
      }
      steps.set(step.fromVersion, step);
    }

    let maxVersion = 0;
    for (const version of schemas.keys()) {
      if (version > maxVersion) maxVersion = version;
    }
    for (const step of steps.values()) {
      if (step.toVersion > maxVersion) maxVersion = step.toVersion;
    }

    this.#schemas = schemas;
    this.#steps = steps;
    this.#maxVersion = maxVersion;
  }

  /**
   * Migrate a source revision to `targetVersion`. Refuses a target that is
   * not higher than the source version, an unsupported source version, and a
   * target that is unknown or unreachable through the registered one-step
   * paths and retained schemas. The whole chain is validated before any
   * migration runs, and every step result is validated against its target
   * schema before the next step is applied.
   */
  migrate(source: ConfigRevision, targetVersion: number): ConfigMigrationResult {
    if (!Number.isSafeInteger(targetVersion) || targetVersion <= 0) {
      throw new ConfigRevisionError(
        "CONFIG_TARGET_VERSION_UNSUPPORTED",
        "targetVersion must be a positive safe integer",
      );
    }
    if (targetVersion <= source.configVersion) {
      throw new ConfigRevisionError(
        "CONFIG_MIGRATION_REFUSED",
        `Migration to version ${targetVersion} is refused: target must be higher than source version ${source.configVersion}`,
      );
    }
    const sourceSchema = this.#schemas.get(source.configVersion);
    if (sourceSchema === undefined) {
      throw new ConfigRevisionError(
        "CONFIG_VERSION_UNSUPPORTED",
        `Source version ${source.configVersion} has no retained schema`,
      );
    }
    if (targetVersion > this.#maxVersion) {
      throw new ConfigRevisionError(
        "CONFIG_TARGET_VERSION_UNSUPPORTED",
        `Target version ${targetVersion} is not registered by any retained schema or migration`,
      );
    }
    for (let version = source.configVersion + 1; version <= targetVersion; version += 1) {
      if (!this.#steps.has(version - 1)) {
        throw new ConfigRevisionError(
          "CONFIG_MIGRATION_STEP_MISSING",
          `No registered one-step migration from version ${version - 1} to ${version}`,
        );
      }
      if (!this.#schemas.has(version)) {
        throw new ConfigRevisionError(
          "CONFIG_TARGET_VERSION_UNSUPPORTED",
          `No retained schema for version ${version}`,
        );
      }
    }

    this.#validateConfiguration(
      sourceSchema,
      source.configuration,
      `Source configuration version ${source.configVersion} does not satisfy its retained schema`,
    );

    const warnings: string[] = [];
    let configuration = source.configuration;
    for (let version = source.configVersion + 1; version <= targetVersion; version += 1) {
      const step = this.#steps.get(version - 1)!;
      const targetSchema = this.#schemas.get(version)!;
      let output: ConfigMigrationOutput;
      try {
        output = parseMigrationOutput(step.migrate(configuration));
      } catch (error) {
        if (error instanceof ConfigRevisionError) throw error;
        throw new ConfigRevisionError(
          "CONFIG_MIGRATION_OUTPUT_INVALID",
          `Migration from version ${version - 1} to ${version} failed`,
          { cause: error },
        );
      }
      this.#validateConfiguration(
        targetSchema,
        output.configuration,
        `Migration result for version ${version} does not satisfy its target schema`,
      );
      configuration = output.configuration;
      for (const warning of output.warnings) warnings.push(warning);
    }

    return {
      revision: createConfigRevision({
        configId: source.configId,
        extensionId: source.extensionId,
        moduleKind: source.moduleKind,
        configVersion: targetVersion,
        configuration: cloneJson(configuration),
      }),
      warnings,
    };
  }

  #validateConfiguration(schema: JsonValue, configuration: JsonValue, message: string): void {
    try {
      validateJsonSchema(schema, configuration);
    } catch (error) {
      if (error instanceof JsonSchemaError && error.code === "JSON_SCHEMA_VALUE_INVALID") {
        throw new ConfigRevisionError(
          "CONFIG_MIGRATION_VALUE_INVALID",
          message,
          { cause: error },
        );
      }
      throw new ConfigRevisionError(
        "CONFIG_MIGRATION_OUTPUT_INVALID",
        "Retained schema is invalid or unsupported",
        { cause: error },
      );
    }
  }
}