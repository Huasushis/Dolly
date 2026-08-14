import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migrateModuleConfigurationRecord,
  ModuleConfigurationStore,
  type ModuleConfigurationRecord,
} from "../../../src/core/module-configuration-store.js";
import {
  ConfigMigrationRunner,
  DEFAULT_APPROVAL_CLASS,
} from "../../../src/core/config-revision.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import { canonicalJsonDigest, type JsonValue } from "../../../src/core/canonical-json.js";

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["prefix"],
  properties: {
    prefix: { type: "string", minLength: 1, maxLength: 32 },
  },
} as const;

describe("immutable Module configuration records", () => {
  let root: string;
  let directory: string;
  let store: ModuleConfigurationStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-module-configuration-"));
    directory = join(root, "records");
    let temporaryId = 0;
    store = new ModuleConfigurationStore({
      directory,
      nextTemporaryId: () => `temporary-${++temporaryId}`,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function create(): ModuleConfigurationRecord {
    return store.create({
      configId: "worker:default",
      extensionId: "org.example.worker",
      moduleKind: "transform",
      configVersion: 1,
      schema,
      configuration: { prefix: "processed" },
    });
  }

  it("creates and resolves one content-checked immutable revision", () => {
    const record = create();
    expect(record).toMatchObject({
      schemaVersion: "dolly.module-configuration/1",
      configId: "worker:default",
      extensionId: "org.example.worker",
      moduleKind: "transform",
      configVersion: 1,
      configuration: { prefix: "processed" },
    });
    expect(record.revision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(store.create({
      configId: "worker:default",
      extensionId: "org.example.worker",
      moduleKind: "transform",
      configVersion: 1,
      schema,
      configuration: { prefix: "processed" },
    })).toEqual(record);
    expect(store.resolve({
      configId: record.configId,
      revision: record.revision,
      extensionId: record.extensionId,
      moduleKind: record.moduleKind,
      configVersion: record.configVersion,
      schema,
    })).toEqual(record);

    const [fileName] = readdirSync(directory);
    expect(fileName).toMatch(/^[0-9a-f]{64}\.json$/u);
    expect(fileName).not.toContain(record.configId);
  });

  it("rejects schema, identity, and configuration mismatches", () => {
    expect(() => store.create({
      configId: "worker:invalid",
      extensionId: "org.example.worker",
      moduleKind: "transform",
      configVersion: 1,
      schema,
      configuration: { prefix: "", extra: true },
    })).toThrowError(expect.objectContaining({ code: "CONFIGURATION_VALUE_INVALID" }));

    const record = create();
    expect(() => store.resolve({
      configId: record.configId,
      revision: record.revision,
      extensionId: "org.example.other",
      moduleKind: record.moduleKind,
      configVersion: record.configVersion,
      schema,
    })).toThrowError(expect.objectContaining({ code: "CONFIGURATION_RECORD_CONFLICT" }));
    expect(() => store.resolve({
      configId: record.configId,
      revision: record.revision,
      extensionId: record.extensionId,
      moduleKind: record.moduleKind,
      configVersion: record.configVersion,
      schema: { ...schema, properties: { prefix: { type: "number" } } },
    })).toThrowError(expect.objectContaining({ code: "CONFIGURATION_SCHEMA_MISMATCH" }));
  });

  it("rejects duplicate keys, digest tampering, and the previous record schema", () => {
    const record = create();
    const [fileName] = readdirSync(directory);
    const path = join(directory, fileName!);
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    document.configuration = { prefix: "tampered" };
    writeFileSync(path, `${JSON.stringify(document)}\n`, "utf8");
    expect(() => store.resolve({
      configId: record.configId,
      revision: record.revision,
      extensionId: record.extensionId,
      moduleKind: record.moduleKind,
      configVersion: record.configVersion,
      schema,
    })).toThrowError(expect.objectContaining({ code: "CONFIGURATION_RECORD_INVALID" }));

    writeFileSync(
      path,
      '{"schemaVersion":"dolly.module-configuration/1","schemaVersion":"dolly.module-configuration/0"}\n',
      "utf8",
    );
    expect(() => store.resolve({
      configId: record.configId,
      revision: record.revision,
      extensionId: record.extensionId,
      moduleKind: record.moduleKind,
      configVersion: record.configVersion,
      schema,
    })).toThrowError(expect.objectContaining({ code: "CONFIGURATION_RECORD_INVALID" }));

    writeFileSync(
      path,
      `${JSON.stringify({ ...document, schemaVersion: "dolly.module-configuration/0" })}\n`,
      "utf8",
    );
    expect(() => store.resolve({
      configId: record.configId,
      revision: record.revision,
      extensionId: record.extensionId,
      moduleKind: record.moduleKind,
      configVersion: record.configVersion,
      schema,
    })).toThrowError(expect.objectContaining({ code: "CONFIGURATION_RECORD_INVALID" }));
  });

  it("does not treat identifiers as paths and bounds configuration bytes", () => {
    expect(() => store.create({
      configId: "../escape",
      extensionId: "org.example.worker",
      moduleKind: "transform",
      configVersion: 1,
      schema,
      configuration: { prefix: "processed" },
    })).toThrowError(expect.objectContaining({ code: "CONFIGURATION_RECORD_INVALID" }));

    const bounded = new ModuleConfigurationStore({
      directory: join(root, "bounded"),
      maxRecordBytes: 1024,
      maxConfigurationBytes: 256,
    });
    expect(() => bounded.create({
      configId: "bounded",
      extensionId: "org.example.worker",
      moduleKind: "transform",
      configVersion: 1,
      schema,
      configuration: { prefix: "x".repeat(300) },
    })).toThrowError(expect.objectContaining({ code: "CONFIGURATION_LIMIT_EXCEEDED" }));
  });
});

describe("migrateModuleConfigurationRecord bridge", () => {
  const BRIDGE_CONFIG_ID = "worker:default";
  const BRIDGE_EXTENSION_ID = "org.example.worker";
  const BRIDGE_MODULE_KIND = "transform";
  const BRIDGE_OPERATION_ID = "org.example.worker.v1-to-v2";

  const BRIDGE_SCHEMA_V1: JsonValue = {
    $schema: JSON_SCHEMA_2020_12,
    type: "object",
    additionalProperties: false,
    required: ["name", "retryDelayMs"],
    properties: {
      name: { type: "string", minLength: 1 },
      retryDelayMs: { type: "integer", minimum: 0 },
    },
  };
  const BRIDGE_SCHEMA_V2: JsonValue = {
    $schema: JSON_SCHEMA_2020_12,
    type: "object",
    additionalProperties: false,
    required: ["name", "retryDelayMs", "maxRetries"],
    properties: {
      name: { type: "string", minLength: 1 },
      retryDelayMs: { type: "integer", minimum: 0 },
      maxRetries: { type: "integer", minimum: 0 },
    },
  };

  let root: string;
  let directory: string;
  let store: ModuleConfigurationStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-module-configuration-bridge-"));
    directory = join(root, "records");
    let temporaryId = 0;
    store = new ModuleConfigurationStore({
      directory,
      nextTemporaryId: () => `temporary-${++temporaryId}`,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function bridgeRunner(): ConfigMigrationRunner {
    return new ConfigMigrationRunner({
      schemas: { 1: BRIDGE_SCHEMA_V1, 2: BRIDGE_SCHEMA_V2 },
      migrations: [
        {
          fromVersion: 1,
          toVersion: 2,
          operationId: BRIDGE_OPERATION_ID,
          lossDeclaration: "synthesis",
          approvalRequired: true,
          migrate: (source) => {
            const record = source as Readonly<Record<string, JsonValue>>;
            return {
              configuration: { ...record, maxRetries: 3 },
              warnings: ["added maxRetries default 3"],
            };
          },
        },
      ],
    });
  }

  function sourceRecord(): ModuleConfigurationRecord {
    return store.create({
      configId: BRIDGE_CONFIG_ID,
      extensionId: BRIDGE_EXTENSION_ID,
      moduleKind: BRIDGE_MODULE_KIND,
      configVersion: 1,
      schema: BRIDGE_SCHEMA_V1,
      configuration: { name: "summarizer", retryDelayMs: 250 },
    });
  }

  const BRIDGE_APPROVAL = { approvals: [DEFAULT_APPROVAL_CLASS] } as const;

  it("bridges a store record through the runner to a content-addressed target the store accepts", () => {
    const source = sourceRecord();
    const migrated = migrateModuleConfigurationRecord({
      source,
      migration: bridgeRunner(),
      targetVersion: 2,
      targetSchema: BRIDGE_SCHEMA_V2,
      options: BRIDGE_APPROVAL,
    });

    expect(migrated).toMatchObject({
      schemaVersion: "dolly.module-configuration/1",
      configId: BRIDGE_CONFIG_ID,
      extensionId: BRIDGE_EXTENSION_ID,
      moduleKind: BRIDGE_MODULE_KIND,
      configVersion: 2,
      configuration: { name: "summarizer", retryDelayMs: 250, maxRetries: 3 },
    });
    expect(migrated.revision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(migrated.configurationDigest).toBe(canonicalJsonDigest(migrated.configuration));
    expect(migrated.schemaDigest).toBe(canonicalJsonDigest(BRIDGE_SCHEMA_V2));
    expect(Object.isFrozen(migrated)).toBe(true);
    expect(Object.isFrozen(migrated.configuration)).toBe(true);
    expect(source.configVersion).toBe(1);

    // The returned record is exactly what the store would produce and accept.
    const persisted = store.create({
      configId: migrated.configId,
      extensionId: migrated.extensionId,
      moduleKind: migrated.moduleKind,
      configVersion: migrated.configVersion,
      schema: BRIDGE_SCHEMA_V2,
      configuration: migrated.configuration,
    });
    expect(persisted).toEqual(migrated);
    expect(store.resolve({
      configId: persisted.configId,
      revision: persisted.revision,
      extensionId: persisted.extensionId,
      moduleKind: persisted.moduleKind,
      configVersion: persisted.configVersion,
      schema: BRIDGE_SCHEMA_V2,
    })).toEqual(migrated);
  });

  it("propagates the approval gate unchanged and replays idempotently by operation id", () => {
    const source = sourceRecord();
    const runner = bridgeRunner();
    expect(() =>
      migrateModuleConfigurationRecord({
        source,
        migration: runner,
        targetVersion: 2,
        targetSchema: BRIDGE_SCHEMA_V2,
      }),
    ).toThrowError(expect.objectContaining({
      code: "CONFIG_MIGRATION_APPROVAL_REQUIRED",
    }));

    const first = migrateModuleConfigurationRecord({
      source,
      migration: runner,
      targetVersion: 2,
      targetSchema: BRIDGE_SCHEMA_V2,
      options: BRIDGE_APPROVAL,
    });
    // Re-running with the already-applied chain skips the approval gate and
    // reproduces the identical target record.
    const replay = migrateModuleConfigurationRecord({
      source,
      migration: runner,
      targetVersion: 2,
      targetSchema: BRIDGE_SCHEMA_V2,
      options: { alreadyApplied: [BRIDGE_OPERATION_ID] },
    });
    expect(replay).toEqual(first);
    expect(replay.revision).toBe(first.revision);
  });

  it("refuses an inconsistent target schema instead of producing a poisoned record", () => {
    const source = sourceRecord();
    expect(() =>
      migrateModuleConfigurationRecord({
        source,
        migration: bridgeRunner(),
        targetVersion: 2,
        targetSchema: BRIDGE_SCHEMA_V1,
        options: BRIDGE_APPROVAL,
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFIGURATION_VALUE_INVALID" }));
  });

  it("is deterministic and leaves the source record untouched", () => {
    const source = sourceRecord();
    const snapshot = store.resolve({
      configId: source.configId,
      revision: source.revision,
      extensionId: source.extensionId,
      moduleKind: source.moduleKind,
      configVersion: source.configVersion,
      schema: BRIDGE_SCHEMA_V1,
    });
    const runner = bridgeRunner();
    const first = migrateModuleConfigurationRecord({
      source,
      migration: runner,
      targetVersion: 2,
      targetSchema: BRIDGE_SCHEMA_V2,
      options: BRIDGE_APPROVAL,
    });
    const second = migrateModuleConfigurationRecord({
      source,
      migration: runner,
      targetVersion: 2,
      targetSchema: BRIDGE_SCHEMA_V2,
      options: BRIDGE_APPROVAL,
    });
    expect(second).toEqual(first);
    expect(second.revision).toBe(first.revision);
    expect(
      store.resolve({
        configId: source.configId,
        revision: source.revision,
        extensionId: source.extensionId,
        moduleKind: source.moduleKind,
        configVersion: source.configVersion,
        schema: BRIDGE_SCHEMA_V1,
      }),
    ).toEqual(snapshot);
  });
});
