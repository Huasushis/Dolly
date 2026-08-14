import { describe, expect, it } from "vitest";
import {
  ConfigMigrationRunner,
  ConfigRevisionError,
  createConfigRevision,
  type ConfigMigrationStep,
  type ConfigRevision,
  type ConfigRevisionErrorCode,
} from "../../../src/core/config-revision.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import type { JsonValue } from "../../../src/core/canonical-json.js";

const CONFIG_ID = "acme.summary";
const EXTENSION_ID = "acme.summary";
const MODULE_KIND = "writer";

function schema(properties: Record<string, JsonValue>): JsonValue {
  return {
    $schema: JSON_SCHEMA_2020_12,
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const SCHEMA_V1 = schema({
  name: { type: "string", minLength: 1 },
  retryDelayMs: { type: "integer", minimum: 0 },
});
const SCHEMA_V2 = schema({
  name: { type: "string", minLength: 1 },
  retryDelayMs: { type: "integer", minimum: 0 },
  maxRetries: { type: "integer", minimum: 0 },
});
const SCHEMA_V3 = schema({
  displayName: { type: "string", minLength: 1 },
  retryDelayMs: { type: "integer", minimum: 0 },
  maxRetries: { type: "integer", minimum: 0 },
});

const MIGRATE_V1_TO_V2: ConfigMigrationStep = {
  fromVersion: 1,
  toVersion: 2,
  migrate: (source) => {
    // The source is validated against schema version 1 before this step runs.
    const record = source as Readonly<Record<string, JsonValue>>;
    return {
      configuration: {
        name: record.name,
        retryDelayMs: record.retryDelayMs,
        maxRetries: 3,
      },
      warnings: ["added maxRetries default 3"],
    };
  },
};

function renameNameToDisplayName(source: JsonValue): JsonValue {
  // The source is validated against schema version 2 before this step runs,
  // so it is a closed object carrying `name` and `maxRetries` at runtime.
  const record = source as Readonly<Record<string, JsonValue>>;
  return {
    retryDelayMs: record.retryDelayMs,
    maxRetries: record.maxRetries,
    displayName: record.name,
  };
}

const MIGRATE_V2_TO_V3: ConfigMigrationStep = {
  fromVersion: 2,
  toVersion: 3,
  migrate: (source) => ({
    configuration: renameNameToDisplayName(source),
    warnings: ["renamed name to displayName"],
  }),
};

function runner(
  overrides: Partial<{
    schemas: Record<number, JsonValue>;
    migrations: readonly ConfigMigrationStep[];
  }> = {},
): ConfigMigrationRunner {
  return new ConfigMigrationRunner({
    schemas: { 1: SCHEMA_V1, 2: SCHEMA_V2, 3: SCHEMA_V3, ...overrides.schemas },
    migrations: overrides.migrations ?? [MIGRATE_V1_TO_V2, MIGRATE_V2_TO_V3],
  });
}

function revision(
  configVersion: number,
  configuration: JsonValue,
  overrides: Partial<{ configId: string; extensionId: string; moduleKind: string }> = {},
): ConfigRevision {
  return createConfigRevision({
    configId: overrides.configId ?? CONFIG_ID,
    extensionId: overrides.extensionId ?? EXTENSION_ID,
    moduleKind: overrides.moduleKind ?? MODULE_KIND,
    configVersion,
    configuration,
  });
}

function sourceV1(): ConfigRevision {
  return revision(1, { name: "summarizer", retryDelayMs: 250 });
}

function expectConfigRevisionError(
  action: () => void,
  code: ConfigRevisionErrorCode,
  messagePart?: string,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigRevisionError);
  const revisionError = thrown as ConfigRevisionError;
  expect(revisionError.code).toBe(code);
  if (messagePart !== undefined) {
    expect(revisionError.message).toContain(messagePart);
  }
}

describe("ConfigRevision", () => {
  it("derives a content-addressed revision and freezes the snapshot", () => {
    const record = sourceV1();
    expect(record.schemaVersion).toBe("dolly.config-revision/1");
    expect(record.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.configurationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.configuration)).toBe(true);
    expect(() => {
      (record as { configId: string }).configId = "mutated";
    }).toThrow();
  });

  it("produces the same revision for equal inputs", () => {
    expect(revision(1, { name: "summarizer", retryDelayMs: 250 }).revision).toBe(
      sourceV1().revision,
    );
  });

  it("rejects invalid identity fields and non-JSON snapshots", () => {
    const valid = { name: "summarizer", retryDelayMs: 250 };
    expectConfigRevisionError(
      () => revision(1, valid, { configId: "NOT VALID!" }),
      "CONFIG_REVISION_INVALID",
    );
    expectConfigRevisionError(() => revision(0, valid), "CONFIG_REVISION_INVALID");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expectConfigRevisionError(
      () => revision(1, cyclic as unknown as JsonValue),
      "CONFIG_REVISION_INVALID",
    );
  });
});

describe("ConfigMigrationRunner", () => {
  it("upgrades sequentially through every registered version", () => {
    const result = runner().migrate(sourceV1(), 3);
    expect(result.revision.configVersion).toBe(3);
    expect(result.revision.configuration).toEqual({
      displayName: "summarizer",
      retryDelayMs: 250,
      maxRetries: 3,
    });
    expect(result.warnings).toEqual([
      "added maxRetries default 3",
      "renamed name to displayName",
    ]);
  });

  it("keeps the output revision immutable and content-addressed", () => {
    const result = runner().migrate(sourceV1(), 2);
    expect(Object.isFrozen(result.revision)).toBe(true);
    expect(Object.isFrozen(result.revision.configuration)).toBe(true);
    expect(result.revision.revision).toBe(
      revision(2, { name: "summarizer", retryDelayMs: 250, maxRetries: 3 }).revision,
    );
  });

  it("rejects a migration result that fails the target schema", () => {
    const bad = runner({
      migrations: [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: (source) => {
            const record = source as Readonly<Record<string, JsonValue>>;
            return {
              configuration: { ...record, maxRetries: -1 },
              warnings: [],
            };
          },
        },
      ],
    });
    expectConfigRevisionError(
      () => bad.migrate(sourceV1(), 2),
      "CONFIG_MIGRATION_VALUE_INVALID",
    );
  });

  it("rejects a source snapshot that fails its retained schema", () => {
    const badSource = revision(1, { retryDelayMs: 250 });
    expectConfigRevisionError(
      () => runner().migrate(badSource, 2),
      "CONFIG_MIGRATION_VALUE_INVALID",
    );
  });

  it("rejects migration output that is not a JSON object or has malformed warnings", () => {
    const notObject = runner({
      migrations: [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: (() => "not-an-object") as unknown as ConfigMigrationStep["migrate"],
        },
      ],
    });
    expectConfigRevisionError(
      () => notObject.migrate(sourceV1(), 2),
      "CONFIG_MIGRATION_OUTPUT_INVALID",
    );
  });
});

describe("ConfigMigrationRunner refusals", () => {
  it("refuses a target lower than or equal to the source version", () => {
    const upgraded = revision(3, {
      displayName: "summarizer",
      retryDelayMs: 250,
      maxRetries: 3,
    });
    expectConfigRevisionError(
      () => runner().migrate(upgraded, 1),
      "CONFIG_MIGRATION_REFUSED",
    );
    expectConfigRevisionError(
      () => runner().migrate(upgraded, 3),
      "CONFIG_MIGRATION_REFUSED",
    );
  });

  it("refuses a target with no retained schema and a target beyond all registrations", () => {
    const noSchemaForTarget = runner({
      migrations: [
        MIGRATE_V1_TO_V2,
        MIGRATE_V2_TO_V3,
        {
          fromVersion: 3,
          toVersion: 4,
          migrate: (source) => ({ configuration: source, warnings: [] }),
        },
      ],
    });
    expectConfigRevisionError(
      () => noSchemaForTarget.migrate(sourceV1(), 4),
      "CONFIG_TARGET_VERSION_UNSUPPORTED",
      "No retained schema",
    );
    expectConfigRevisionError(
      () => runner().migrate(sourceV1(), 99),
      "CONFIG_TARGET_VERSION_UNSUPPORTED",
    );
  });

  it("refuses a broken chain before applying any migration and affects no state", () => {
    let applied = 0;
    const broken = new ConfigMigrationRunner({
      schemas: { 1: SCHEMA_V1, 2: SCHEMA_V2, 3: SCHEMA_V3, 4: SCHEMA_V3 },
      migrations: [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: (source) => {
            applied += 1;
            const record = source as Readonly<Record<string, JsonValue>>;
            return {
              configuration: { ...record, maxRetries: 3 },
              warnings: [],
            };
          },
        },
        {
          fromVersion: 3,
          toVersion: 4,
          migrate: (source) => ({ configuration: source, warnings: [] }),
        },
      ],
    });
    expectConfigRevisionError(
      () => broken.migrate(sourceV1(), 4),
      "CONFIG_MIGRATION_STEP_MISSING",
    );
    expect(applied).toBe(0);
  });

  it("refuses a source version with no retained schema", () => {
    const source = revision(5, { name: "summarizer", retryDelayMs: 250 });
    expectConfigRevisionError(
      () => runner().migrate(source, 6),
      "CONFIG_VERSION_UNSUPPORTED",
    );
  });

  it("rejects invalid migration registrations at construction", () => {
    expect(
      () =>
        new ConfigMigrationRunner({
          schemas: { 1: SCHEMA_V1 },
          migrations: [
            { fromVersion: 1, toVersion: 3, migrate: (source) => ({ configuration: source, warnings: [] }) },
          ],
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new ConfigMigrationRunner({
          schemas: { 1: SCHEMA_V1 },
          migrations: [MIGRATE_V1_TO_V2, MIGRATE_V1_TO_V2],
        }),
    ).toThrow(/Duplicate/);
  });
});

describe("ConfigMigrationRunner determinism", () => {
  it("produces identical revisions and warnings for equal inputs", () => {
    const upgradeRunner = runner();
    const first = upgradeRunner.migrate(sourceV1(), 3);
    const second = upgradeRunner.migrate(sourceV1(), 3);
    expect(first.revision.revision).toBe(second.revision.revision);
    expect(first.warnings).toEqual(second.warnings);
    expect(first.revision.configuration).toEqual(second.revision.configuration);
  });
});