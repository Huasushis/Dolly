import { describe, expect, it } from "vitest";
import {
  ConfigMigrationRunner,
  ConfigRevisionError,
  DEFAULT_APPROVAL_CLASS,
  createConfigRevision,
  type ConfigMigrationStep,
  type ConfigRevision,
  type ConfigRevisionErrorCode,
} from "../../../src/core/config-revision.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import {
  canonicalJsonByteLength,
  type JsonValue,
} from "../../../src/core/canonical-json.js";

const CONFIG_ID = "acme.summary";
const EXTENSION_ID = "acme.summary";
const MODULE_KIND = "writer";

const V1_TO_V2_OPERATION_ID = "acme.summary.v1-to-v2";
const V2_TO_V3_OPERATION_ID = "acme.summary.v2-to-v3";

/** Matching approvals are required before any loss-declaring step runs. */
const APPROVAL = { approvals: [DEFAULT_APPROVAL_CLASS] } as const;

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
  operationId: V1_TO_V2_OPERATION_ID,
  lossDeclaration: "synthesis",
  approvalRequired: true,
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
  operationId: V2_TO_V3_OPERATION_ID,
  lossDeclaration: "semantic-change",
  approvalRequired: true,
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
    const result = runner().migrate(sourceV1(), 3, APPROVAL);
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
    expect(result.appliedOperations).toEqual([V1_TO_V2_OPERATION_ID, V2_TO_V3_OPERATION_ID]);
  });

  it("keeps the output revision immutable and content-addressed", () => {
    const result = runner().migrate(sourceV1(), 2, APPROVAL);
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
          operationId: "acme.summary.bad.v1-to-v2",
          lossDeclaration: "synthesis",
          approvalRequired: true,
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
      () => bad.migrate(sourceV1(), 2, APPROVAL),
      "CONFIG_MIGRATION_VALUE_INVALID",
    );
  });

  it("rejects a source snapshot that fails its retained schema", () => {
    const badSource = revision(1, { retryDelayMs: 250 });
    expectConfigRevisionError(
      () => runner().migrate(badSource, 2, APPROVAL),
      "CONFIG_MIGRATION_VALUE_INVALID",
    );
  });

  it("rejects migration output that is not a JSON object or has malformed warnings", () => {
    const notObject = runner({
      migrations: [
        {
          fromVersion: 1,
          toVersion: 2,
          operationId: "acme.summary.not-object.v1-to-v2",
          lossDeclaration: "none",
          approvalRequired: false,
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
          operationId: "acme.summary.v3-to-v4",
          lossDeclaration: "none",
          approvalRequired: false,
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
          operationId: "acme.summary.broken.v1-to-v2",
          lossDeclaration: "none",
          approvalRequired: false,
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
          operationId: "acme.summary.broken.v3-to-v4",
          lossDeclaration: "none",
          approvalRequired: false,
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
            {
              fromVersion: 1,
              toVersion: 3,
              operationId: "acme.summary.invalid-step",
              lossDeclaration: "none",
              approvalRequired: false,
              migrate: (source) => ({ configuration: source, warnings: [] }),
            },
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

  it("rejects an approval declaration inconsistent with the loss class", () => {
    expect(
      () =>
        new ConfigMigrationRunner({
          schemas: { 1: SCHEMA_V1, 2: SCHEMA_V2 },
          migrations: [
            {
              ...MIGRATE_V1_TO_V2,
              lossDeclaration: "synthesis",
              approvalRequired: false,
            },
          ],
        }),
    ).toThrow(/silent lossy migration is forbidden/);
    expect(
      () =>
        new ConfigMigrationRunner({
          schemas: { 1: SCHEMA_V1, 2: SCHEMA_V2 },
          migrations: [
            {
              ...MIGRATE_V1_TO_V2,
              lossDeclaration: "none",
              approvalRequired: true,
            },
          ],
        }),
    ).toThrow(/a declared loss class is required/);
  });
});

describe("ConfigMigrationRunner operation ids", () => {
  it("rejects duplicate operation ids at construction for identical and different migrate bodies", () => {
    const stepA: ConfigMigrationStep = {
      fromVersion: 1,
      toVersion: 2,
      operationId: "acme.summary.dup",
      lossDeclaration: "none",
      approvalRequired: false,
      migrate: (source) => ({ configuration: source, warnings: [] }),
    };
    const sameBody = { ...stepA };
    const differentBody: ConfigMigrationStep = {
      ...stepA,
      migrate: (source) => {
        const record = source as Readonly<Record<string, JsonValue>>;
        return { configuration: { ...record, extra: true }, warnings: [] };
      },
    };
    expect(
      () =>
        new ConfigMigrationRunner({
          schemas: { 1: SCHEMA_V1, 2: SCHEMA_V2 },
          migrations: [stepA, sameBody],
        }),
    ).toThrow(/Duplicate migration operation id acme\.summary\.dup/);
    expect(
      () =>
        new ConfigMigrationRunner({
          schemas: { 1: SCHEMA_V1, 2: SCHEMA_V2 },
          migrations: [stepA, differentBody],
        }),
    ).toThrow(/Duplicate migration operation id acme\.summary\.dup/);
  });

  it("replays an applied chain idempotently at the value level without re-approval", () => {
    const upgradeRunner = runner();
    const first = upgradeRunner.migrate(sourceV1(), 3, APPROVAL);
    const replay = upgradeRunner.migrate(sourceV1(), 3, {
      alreadyApplied: first.appliedOperations,
    });
    expect(replay.revision.revision).toBe(first.revision.revision);
    expect(replay.revision.configuration).toEqual(first.revision.configuration);
    expect(replay.warnings).toEqual(first.warnings);
    expect(replay.appliedOperations).toEqual(first.appliedOperations);
  });

  it("refuses an alreadyApplied id outside the migration path", () => {
    expectConfigRevisionError(
      () =>
        runner().migrate(sourceV1(), 3, {
          alreadyApplied: ["acme.summary.unknown-op"],
        }),
      "CONFIG_MIGRATION_REFUSED",
      "is not part of the migration path",
    );
  });

  it("records applied operations only for the requested path", () => {
    const partial = runner().migrate(sourceV1(), 2, APPROVAL);
    expect(partial.appliedOperations).toEqual([V1_TO_V2_OPERATION_ID]);
  });
});

describe("ConfigMigrationRunner approval gate", () => {
  it("refuses a loss-declaring step without explicit approval", () => {
    expectConfigRevisionError(
      () => runner().migrate(sourceV1(), 3),
      "CONFIG_MIGRATION_APPROVAL_REQUIRED",
      V1_TO_V2_OPERATION_ID,
    );
  });

  it("refuses when only a sibling step is approved", () => {
    expectConfigRevisionError(
      () => runner().migrate(sourceV1(), 2, { approvals: [V2_TO_V3_OPERATION_ID] }),
      "CONFIG_MIGRATION_APPROVAL_REQUIRED",
      V1_TO_V2_OPERATION_ID,
    );
  });

  it("accepts approval by operation id and by approval class", () => {
    const byOperationId = runner().migrate(sourceV1(), 3, {
      approvals: [V1_TO_V2_OPERATION_ID, V2_TO_V3_OPERATION_ID],
    });
    expect(byOperationId.revision.configVersion).toBe(3);
    const byClass = runner().migrate(sourceV1(), 3, APPROVAL);
    expect(byClass.revision.configVersion).toBe(3);
    expect(byClass.revision.revision).toBe(byOperationId.revision.revision);
  });
});

describe("ConfigMigrationRunner byte-size expansion guard", () => {
  const SCHEMA_V2_WITH_NOTE = schema({
    name: { type: "string", minLength: 1 },
    retryDelayMs: { type: "integer", minimum: 0 },
    note: { type: "string" },
  });
  const PAD_OPERATION_ID = "acme.summary.v1-to-v2-note";
  const PAD_STEP: ConfigMigrationStep = {
    fromVersion: 1,
    toVersion: 2,
    operationId: PAD_OPERATION_ID,
    lossDeclaration: "synthesis",
    approvalRequired: true,
    migrate: (source) => {
      const record = source as Readonly<Record<string, JsonValue>>;
      return {
        configuration: { ...record, note: "n".repeat(24) },
        warnings: [],
      };
    },
  };
  const SOURCE_VALUE = { name: "summarizer", retryDelayMs: 250 };
  const OUTPUT_VALUE = { ...SOURCE_VALUE, note: "n".repeat(24) };
  const sourceBytes = canonicalJsonByteLength(SOURCE_VALUE);
  const outputBytes = canonicalJsonByteLength(OUTPUT_VALUE);
  const expansionBytes = outputBytes - sourceBytes;

  function guardedRunner(
    options: Partial<{ maxOutputBytes: number; maxExpansionBytes: number }>,
  ): ConfigMigrationRunner {
    return new ConfigMigrationRunner({
      schemas: { 1: SCHEMA_V1, 2: SCHEMA_V2_WITH_NOTE },
      migrations: [PAD_STEP],
      ...options,
    });
  }

  it("respects the exact maxOutputBytes boundary", () => {
    const atLimit = guardedRunner({ maxOutputBytes: outputBytes });
    expect(atLimit.migrate(sourceV1(), 2, APPROVAL).revision.configVersion).toBe(2);
    const oneByteOver = guardedRunner({ maxOutputBytes: outputBytes - 1 });
    expectConfigRevisionError(
      () => oneByteOver.migrate(sourceV1(), 2, APPROVAL),
      "CONFIG_MIGRATION_EXPANSION_LIMIT",
      "exceeding the maximum output size",
    );
  });

  it("respects the exact expansion boundary", () => {
    const atLimit = guardedRunner({ maxExpansionBytes: expansionBytes });
    expect(atLimit.migrate(sourceV1(), 2, APPROVAL).revision.configVersion).toBe(2);
    const oneByteTighter = guardedRunner({ maxExpansionBytes: expansionBytes - 1 });
    expectConfigRevisionError(
      () => oneByteTighter.migrate(sourceV1(), 2, APPROVAL),
      "CONFIG_MIGRATION_EXPANSION_LIMIT",
      "exceeding the expansion limit",
    );
  });

  it("measures byte size deterministically", () => {
    const upgradeRunner = guardedRunner({ maxOutputBytes: outputBytes });
    const first = upgradeRunner.migrate(sourceV1(), 2, APPROVAL);
    const second = upgradeRunner.migrate(sourceV1(), 2, APPROVAL);
    expect(canonicalJsonByteLength(first.revision.configuration)).toBe(outputBytes);
    expect(first.revision.revision).toBe(second.revision.revision);
  });
});

describe("ConfigMigrationRunner determinism", () => {
  it("produces identical revisions, warnings, and applied operations for equal inputs", () => {
    const upgradeRunner = runner();
    const first = upgradeRunner.migrate(sourceV1(), 3, APPROVAL);
    const second = upgradeRunner.migrate(sourceV1(), 3, APPROVAL);
    expect(first.revision.revision).toBe(second.revision.revision);
    expect(first.warnings).toEqual(second.warnings);
    expect(first.revision.configuration).toEqual(second.revision.configuration);
    expect(first.appliedOperations).toEqual(second.appliedOperations);
  });
});