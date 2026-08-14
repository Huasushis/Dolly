/**
 * Immutable configuration revisions and the deterministic config-value
 * migration runner (config-value revision/upgrade support).
 *
 * A configuration revision binds a content-addressed revision identity to a
 * frozen configuration snapshot together with the identity fields a Module
 * resolution checks before extension code starts
 * (`dolly-spec/docs/spec/extension-protocol/02-lifecycle-and-fencing.md`
 * Sections 1 and 4). A `(configId, revision)` pair is immutable: an edit
 * creates a new revision, and the previous pair is never overwritten.
 *
 * The runner implements the Host-internal configuration-value upgrade chain
 * defined in `docs/adr/0010-configuration-value-upgrade-chain.md` (ADR-0010,
 * Proposed): one-step upgrade paths vN -> vN+1, deterministic for identical
 * input bytes and parameters, idempotent by migration operation id,
 * output-size and expansion limited, and never mutating the source value. A
 * step that drops, synthesizes, or semantically changes user data MUST declare
 * its loss class and require the configured approval identity; silent lossy
 * migration is refused. No imported extension-protocol section normatively
 * defines this chain: 04-hot-reload-and-state-migration.md Section 5 governs
 * `module.migrate_state` snapshot state, not configuration values.
 *
 * This module is deliberately NOT `module.migrate_state`: that is the
 * Extension-side wire method (`01-wire-protocol.md`) that operates only on
 * staged snapshot state under Host authority. This unit provides Host-side
 * pure config-value revision/upgrade support only; Store, Host, snapshot, and
 * startup wiring are out of scope here.
 */

import {
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import { JsonSchemaError, validateJsonSchema } from "./json-schema.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DECIMAL_SEQUENCE_PATTERN = /^(0|[1-9][0-9]*)$/u;

/**
 * The closed set of loss classes a migration step can declare (ADR-0010):
 * the transform drops user data, synthesizes values, or semantically changes
 * user data. `none` declares the transform is lossless and never synthesizes.
 */
export type ConfigLossDeclaration = "none" | "value-loss" | "synthesis" | "semantic-change";

const LOSS_DECLARATIONS: Readonly<Record<ConfigLossDeclaration, true>> = {
  none: true,
  "value-loss": true,
  synthesis: true,
  "semantic-change": true,
};

/**
 * The default approval identity (ADR-0010 "configured approval class")
 * that approves every loss-declaring step when supplied to `migrate`.
 */
export const DEFAULT_APPROVAL_CLASS = "config.migration.approval";

export type ConfigRevisionErrorCode =
  | "CONFIG_REVISION_INVALID"
  | "CONFIG_MIGRATION_REFUSED"
  | "CONFIG_VERSION_UNSUPPORTED"
  | "CONFIG_MIGRATION_STEP_MISSING"
  | "CONFIG_TARGET_VERSION_UNSUPPORTED"
  | "CONFIG_MIGRATION_OUTPUT_INVALID"
  | "CONFIG_MIGRATION_VALUE_INVALID"
  | "CONFIG_MIGRATION_APPROVAL_REQUIRED"
  | "CONFIG_MIGRATION_EXPANSION_LIMIT";

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

/**
 * A registered one-step upgrade path. `operationId` is the stable identity a
 * call chain is idempotent on (ADR-0010), `lossDeclaration` the closed
 * loss class, and `approvalRequired` the approval gate required by ADR-0010
 * for any step that is not declared `none`.
 */
export interface ConfigMigrationStep {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly operationId: string;
  readonly lossDeclaration: ConfigLossDeclaration;
  readonly approvalRequired: boolean;
  readonly migrate: ConfigMigration;
}

export interface ConfigMigrationResult {
  /** The new immutable revision at the target version. */
  readonly revision: ConfigRevision;
  /** Warnings from every applied step, in application order. */
  readonly warnings: readonly string[];
  /** The ordered operation ids this value has been migrated through. */
  readonly appliedOperations: readonly string[];
}

export interface ConfigMigrationOptions {
  /**
   * Operation ids already applied to this value. Their steps skip the
   * approval gate; each id MUST be part of the current migration path. This
   * is what makes re-running an upgrade idempotent by operation id.
   */
  readonly alreadyApplied?: readonly string[];
  /**
   * Explicit approvals for the current run: step operation ids and/or the
   * runner's configured approval class. A loss-declaring step with no
   * matching approval is refused.
   */
  readonly approvals?: readonly string[];
}

export interface ConfigMigrationRunnerOptions {
  /**
   * The retained JSON Schema (Draft 2020-12) for each supported
   * `configVersion`. A version without a schema is unknown and unreachable.
   */
  readonly schemas: Readonly<Record<number, JsonValue>>;
  /** The registered one-step migrations, keyed by their source version. */
  readonly migrations: readonly ConfigMigrationStep[];
  /** Approval identity that approves every loss-declaring step when supplied. */
  readonly approvalClass?: string;
  /**
   * Absolute cap on the canonical UTF-8 byte length of the migrated
   * configuration (ADR-0010, output-size limit).
   */
  readonly maxOutputBytes?: number;
  /**
   * Cap on how many canonical UTF-8 bytes the migrated configuration may
   * expand the source value by (ADR-0010, expansion limit).
   */
  readonly maxExpansionBytes?: number;
}

const MIGRATION_OUTPUT_KEYS: Readonly<Record<string, true>> = {
  configuration: true,
  warnings: true,
};

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_EXPANSION_BYTES = 64 * 1024;

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

function assertLossDeclaration(value: unknown, label: string): asserts value is ConfigLossDeclaration {
  if (typeof value !== "string" || !LOSS_DECLARATIONS[value as ConfigLossDeclaration]) {
    throw new TypeError(
      `${label} must be one of: none, value-loss, synthesis, semantic-change`,
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

function assertPositiveByteLimit(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
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
 * and returns a new revision, so equal inputs produce equal outputs, and the
 * migration never runs against the sole active value (ADR-0010).
 */
export class ConfigMigrationRunner {
  readonly #schemas: ReadonlyMap<number, JsonValue>;
  readonly #steps: ReadonlyMap<number, ConfigMigrationStep>;
  readonly #maxVersion: number;
  readonly #approvalClass: string;
  readonly #maxOutputBytes: number;
  readonly #maxExpansionBytes: number;

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
    const seenOperationIds = new Set<string>();
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
      if (typeof step.operationId !== "string" || !ID_PATTERN.test(step.operationId)) {
        throw new TypeError("Migration operationId must be a valid identifier");
      }
      if (seenOperationIds.has(step.operationId)) {
        throw new TypeError(`Duplicate migration operation id ${step.operationId}`);
      }
      seenOperationIds.add(step.operationId);
      assertLossDeclaration(step.lossDeclaration, "Migration lossDeclaration");
      if (step.lossDeclaration !== "none" && !step.approvalRequired) {
        throw new TypeError(
          `Migration ${step.operationId} declares ${step.lossDeclaration} but does not require approval; silent lossy migration is forbidden`,
        );
      }
      if (step.lossDeclaration === "none" && step.approvalRequired) {
        throw new TypeError(
          `Migration ${step.operationId} requires approval but declares no loss; a declared loss class is required for approval`,
        );
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

    if (
      options.approvalClass !== undefined &&
      (typeof options.approvalClass !== "string" || !ID_PATTERN.test(options.approvalClass))
    ) {
      throw new TypeError("approvalClass must be a valid identifier");
    }
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const maxExpansionBytes = options.maxExpansionBytes ?? DEFAULT_MAX_EXPANSION_BYTES;
    assertPositiveByteLimit(maxOutputBytes, "maxOutputBytes");
    assertPositiveByteLimit(maxExpansionBytes, "maxExpansionBytes");

    this.#schemas = schemas;
    this.#steps = steps;
    this.#maxVersion = maxVersion;
    this.#approvalClass = options.approvalClass ?? DEFAULT_APPROVAL_CLASS;
    this.#maxOutputBytes = maxOutputBytes;
    this.#maxExpansionBytes = maxExpansionBytes;
  }

  /**
   * Migrate a source revision to `targetVersion`. Refuses a target that is
   * not higher than the source version, an unsupported source version, and a
   * target that is unknown or unreachable through the registered one-step
   * paths and retained schemas. The whole chain is validated before any
   * migration runs, and every step result is validated against its target
   * schema before the next step is applied.
   *
   * Each step is idempotent by operation id: a step whose operationId is
   * already present in `options.alreadyApplied` skips the approval gate, and
   * any `alreadyApplied` operation that is not part of the current path is
   * refused. A loss-declaring step that is not already applied and has no
   * matching approval is refused with `CONFIG_MIGRATION_APPROVAL_REQUIRED`.
   * The final configuration is additionally capped by the runner's canonical
   * byte-size and expansion limits.
   */
  migrate(
    source: ConfigRevision,
    targetVersion: number,
    options: ConfigMigrationOptions = {},
  ): ConfigMigrationResult {
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
    if (
      options.alreadyApplied !== undefined &&
      (options.alreadyApplied.some((id) => typeof id !== "string") ||
        options.alreadyApplied.some((id) => !ID_PATTERN.test(id)))
    ) {
      throw new ConfigRevisionError(
        "CONFIG_MIGRATION_REFUSED",
        "alreadyApplied must be an array of valid operation ids",
      );
    }
    if (
      options.approvals !== undefined &&
      options.approvals.some((id) => typeof id !== "string")
    ) {
      throw new ConfigRevisionError(
        "CONFIG_MIGRATION_REFUSED",
        "approvals must be an array of strings",
      );
    }
    const alreadyApplied = new Set<string>(options.alreadyApplied ?? []);
    const approvals = new Set<string>(options.approvals ?? []);

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
    const chainOperations: string[] = [];
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
      chainOperations.push(this.#steps.get(version - 1)!.operationId);
    }
    for (const operationId of alreadyApplied) {
      if (!chainOperations.includes(operationId)) {
        throw new ConfigRevisionError(
          "CONFIG_MIGRATION_REFUSED",
          `alreadyApplied operation id ${operationId} is not part of the migration path to version ${targetVersion}`,
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
      if (!alreadyApplied.has(step.operationId) && step.approvalRequired) {
        const approved =
          approvals.has(step.operationId) || approvals.has(this.#approvalClass);
        if (!approved) {
          throw new ConfigRevisionError(
            "CONFIG_MIGRATION_APPROVAL_REQUIRED",
            `Migration ${step.operationId} (${step.lossDeclaration}) from version ${version - 1} to ${version} requires explicit approval before applying`,
          );
        }
      }
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

    const sourceBytes = canonicalJsonByteLength(source.configuration);
    const outputBytes = canonicalJsonByteLength(configuration);
    if (outputBytes > this.#maxOutputBytes) {
      throw new ConfigRevisionError(
        "CONFIG_MIGRATION_EXPANSION_LIMIT",
        `Migration result for version ${targetVersion} is ${outputBytes} canonical bytes, exceeding the maximum output size of ${this.#maxOutputBytes} bytes`,
      );
    }
    if (outputBytes > sourceBytes + this.#maxExpansionBytes) {
      throw new ConfigRevisionError(
        "CONFIG_MIGRATION_EXPANSION_LIMIT",
        `Migration result for version ${targetVersion} expands the source by ${outputBytes - sourceBytes} canonical bytes, exceeding the expansion limit of ${this.#maxExpansionBytes} bytes`,
      );
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
      appliedOperations: chainOperations,
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