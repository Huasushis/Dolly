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
  ModuleConfigurationStore,
  type ModuleConfigurationRecord,
} from "../../../src/core/module-configuration-store.js";

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
