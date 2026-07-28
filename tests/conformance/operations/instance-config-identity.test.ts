import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import {
  InstanceConfigError,
  InstanceConfigStore,
  type InstanceConfigSchema,
} from "../../../src/core/instance-config-store.js";
import { withSynchronousCrossProcessLock } from "../../../src/core/synchronous-cross-process-lock.js";

type TestDocument = {
  [key: string]: JsonValue;
  schemaVersion: "test.instance/1";
  instanceId: string;
  displayName: string;
  stateDirectory: string | null;
  provider: {
    [key: string]: JsonValue;
    operationRef: string;
    secretReference: {
      [key: string]: JsonValue;
      kind: "environment";
      name: string;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireClosed(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`${label} must be closed`);
  }
}

const schema: InstanceConfigSchema<TestDocument> = {
  schemaVersion: "test.instance/1",
  validate(value) {
    requireClosed(
      value,
      ["schemaVersion", "instanceId", "displayName", "stateDirectory", "provider"],
      "document",
    );
    requireClosed(value.provider, ["operationRef", "secretReference"], "provider");
    requireClosed(value.provider.secretReference, ["kind", "name"], "secretReference");
    if (
      value.schemaVersion !== "test.instance/1" ||
      typeof value.instanceId !== "string" ||
      typeof value.displayName !== "string" ||
      value.displayName.length === 0 ||
      (value.stateDirectory !== null && typeof value.stateDirectory !== "string") ||
      typeof value.provider.operationRef !== "string" ||
      value.provider.secretReference.kind !== "environment" ||
      typeof value.provider.secretReference.name !== "string"
    ) {
      throw new TypeError("document fields are invalid");
    }
    return value as unknown as TestDocument;
  },
  instanceId: (document) => document.instanceId,
  stateDirectory: (document) => document.stateDirectory ?? undefined,
  withInstanceId: (document, instanceId) => ({ ...document, instanceId }),
  redact: (document) => ({
    ...document,
    provider: {
      ...document.provider,
      secretReference: {
        ...document.provider.secretReference,
        name: "[redacted]",
      },
    },
  }),
};

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function documentFor(
  instanceId: string,
  overrides: Partial<TestDocument> = {},
): TestDocument {
  return {
    schemaVersion: "test.instance/1",
    instanceId,
    displayName: "test instance",
    stateDirectory: "./state",
    provider: {
      operationRef: "chat-primary",
      secretReference: { kind: "environment", name: "TEST_PROVIDER_KEY" },
    },
    ...overrides,
  };
}

describe("stable instance and configuration identity", () => {
  let root: string;
  let allocated: number;
  let store: InstanceConfigStore<TestDocument>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-instance-config-"));
    allocated = 0;
    store = new InstanceConfigStore({
      schema,
      registryDirectory: join(root, "registry"),
      defaultStateRoot: join(root, "default-state"),
      maxConfigBytes: 4096,
      nextInstanceId: () => IDS[allocated++]!,
      now: () => "2026-07-24T08:00:00.000Z",
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("initializes a random identity, canonical locator, revision, and matching state manifest", () => {
    const configDirectory = join(root, "project");
    mkdirSync(configDirectory);
    const configPath = join(configDirectory, "dolly.json");
    const loaded = store.initialize(configPath, (instanceId) => documentFor(instanceId));

    expect(loaded.instanceId).toBe(IDS[0]);
    expect(loaded.configPath).toBe(realpathSync.native(configPath));
    expect(loaded.stateDirectory).toBe(realpathSync.native(join(configDirectory, "state")));
    expect(loaded.configRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(loaded.redactedDocument).toMatchObject({
      provider: { secretReference: { name: "[redacted]" } },
    });
    expect(JSON.parse(readFileSync(join(loaded.stateDirectory, ".dolly-instance.json"), "utf8")))
      .toEqual({ schemaVersion: "dolly.state-manifest/1", instanceId: IDS[0] });

    const aliasedPath = join(configDirectory, "nested", "..", "dolly.json");
    mkdirSync(join(configDirectory, "nested"));
    expect(store.claim(aliasedPath).configPath).toBe(loaded.configPath);

    if (process.platform !== "win32") {
      expect(statSync(configPath).mode & 0o077).toBe(0);
      expect(statSync(join(loaded.stateDirectory, ".dolly-instance.json")).mode & 0o077).toBe(0);
    }
  });

  it("resolves directory aliases to one canonical configuration locator", () => {
    const realDirectory = join(root, "real-project");
    const aliasDirectory = join(root, "project-alias");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    const configPath = join(realDirectory, "dolly.json");
    store.initialize(configPath, (instanceId) => documentFor(instanceId));

    expect(store.claim(join(aliasDirectory, "dolly.json")).configPath).toBe(
      realpathSync.native(configPath),
    );
  });

  it("rejects a copied instance ID until an explicit rebind or clone is chosen", () => {
    const firstDirectory = join(root, "first");
    const copiedDirectory = join(root, "copied");
    mkdirSync(firstDirectory);
    mkdirSync(copiedDirectory);
    const originalPath = join(firstDirectory, "dolly.json");
    const original = store.initialize(originalPath, (instanceId) =>
      documentFor(instanceId, { stateDirectory: join(root, "stable-state") }),
    );
    const copiedPath = join(copiedDirectory, "dolly.json");
    copyFileSync(originalPath, copiedPath);

    expect(() => store.claim(copiedPath)).toThrowError(
      expect.objectContaining<Partial<InstanceConfigError>>({ code: "INSTANCE_ID_COLLISION" }),
    );

    const movedPath = join(copiedDirectory, "moved.json");
    renameSync(originalPath, movedPath);
    const rebound = store.rebind(originalPath, movedPath);
    expect(rebound.instanceId).toBe(original.instanceId);
    expect(rebound.configPath).toBe(realpathSync.native(movedPath));

    const cloneDirectory = join(root, "clone");
    mkdirSync(cloneDirectory);
    const cloned = store.clone(movedPath, join(cloneDirectory, "dolly.json"), (document, id) => ({
      ...document,
      instanceId: id,
      stateDirectory: "./state",
    }));
    expect(cloned.instanceId).toBe(IDS[1]);
    expect(cloned.instanceId).not.toBe(rebound.instanceId);
    expect(cloned.stateDirectory).toBe(realpathSync.native(join(cloneDirectory, "state")));
  });

  it("uses revision compare-and-swap and leaves the last valid file intact on rejection", () => {
    const configDirectory = join(root, "project");
    mkdirSync(configDirectory);
    const configPath = join(configDirectory, "dolly.json");
    const initial = store.initialize(configPath, (instanceId) => documentFor(instanceId));

    const updated = store.update(configPath, initial.configRevision, (document) => ({
      ...document,
      displayName: "updated",
    }));
    expect(updated.document.displayName).toBe("updated");
    expect(updated.configRevision).not.toBe(initial.configRevision);
    expect(() =>
      store.update(configPath, initial.configRevision, (document) => document as TestDocument),
    ).toThrowError(
      expect.objectContaining<Partial<InstanceConfigError>>({
        code: "CONFIG_REVISION_CONFLICT",
      }),
    );

    const beforeRejectedUpdate = readFileSync(configPath, "utf8");
    expect(() =>
      store.update(configPath, updated.configRevision, (document) => ({
        ...document,
        unknown: true,
      }) as TestDocument),
    ).toThrow();
    expect(readFileSync(configPath, "utf8")).toBe(beforeRejectedUpdate);
    expect(store.inspect(configPath).configRevision).toBe(updated.configRevision);
  });

  it("checks an expected revision before updating the registry or state manifest", () => {
    const configDirectory = join(root, "project");
    mkdirSync(configDirectory);
    const configPath = join(configDirectory, "dolly.json");
    const initial = store.initialize(configPath, (instanceId) => documentFor(instanceId));
    const registryPath = join(root, "registry", "instances", `${initial.instanceId}.json`);
    const manifestPath = join(initial.stateDirectory, ".dolly-instance.json");
    const registryBeforeClaim = readFileSync(registryPath, "utf8");
    const manifestBeforeClaim = readFileSync(manifestPath, "utf8");

    writeFileSync(
      configPath,
      `${JSON.stringify({ ...initial.document, displayName: "replaced" }, null, 2)}\n`,
      "utf8",
    );

    expect(() => store.claim(configPath, {
      instanceId: initial.instanceId,
      configRevision: initial.configRevision,
    })).toThrowError(
      expect.objectContaining<Partial<InstanceConfigError>>({
        code: "CONFIG_REVISION_CONFLICT",
      }),
    );
    expect(readFileSync(registryPath, "utf8")).toBe(registryBeforeClaim);
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestBeforeClaim);
  });

  it("requires an explicit state migration instead of silently moving state", () => {
    const configDirectory = join(root, "project");
    mkdirSync(configDirectory);
    const configPath = join(configDirectory, "dolly.json");
    const initial = store.initialize(configPath, (instanceId) => documentFor(instanceId));

    expect(() =>
      store.update(configPath, initial.configRevision, (document) => ({
        ...document,
        stateDirectory: "./other-state",
      })),
    ).toThrowError(
      expect.objectContaining<Partial<InstanceConfigError>>({
        code: "CONFIG_STATE_DIRECTORY_CHANGED",
      }),
    );
    expect(store.inspect(configPath).stateDirectory).toBe(initial.stateDirectory);
  });

  it("rejects duplicate keys, invalid UTF-8, unknown fields, and oversized files", () => {
    const duplicatePath = join(root, "duplicate.json");
    writeFileSync(
      duplicatePath,
      `{"schemaVersion":"test.instance/1","instanceId":"${IDS[0]}","instanceId":"${IDS[1]}","displayName":"x","stateDirectory":null,"provider":{"operationRef":"chat","secretReference":{"kind":"environment","name":"KEY"}}}`,
    );
    expect(() => store.inspect(duplicatePath)).toThrowError(
      expect.objectContaining<Partial<InstanceConfigError>>({ code: "CONFIG_DOCUMENT_INVALID" }),
    );

    const invalidUtf8Path = join(root, "invalid-utf8.json");
    writeFileSync(invalidUtf8Path, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    expect(() => store.inspect(invalidUtf8Path)).toThrowError(InstanceConfigError);

    const unknownPath = join(root, "unknown.json");
    writeFileSync(unknownPath, JSON.stringify({ ...documentFor(IDS[0]), surprise: true }));
    expect(() => store.inspect(unknownPath)).toThrowError(
      expect.objectContaining<Partial<InstanceConfigError>>({ code: "CONFIG_DOCUMENT_INVALID" }),
    );

    const oversizedPath = join(root, "oversized.json");
    writeFileSync(oversizedPath, " ".repeat(4097));
    expect(() => store.inspect(oversizedPath)).toThrowError(
      expect.objectContaining<Partial<InstanceConfigError>>({ code: "CONFIG_LIMIT_EXCEEDED" }),
    );
  });

  it("refuses a state directory whose durable manifest belongs to another instance", () => {
    const configDirectory = join(root, "project");
    const stateDirectory = join(root, "occupied-state");
    mkdirSync(configDirectory);
    mkdirSync(stateDirectory);
    writeFileSync(
      join(stateDirectory, ".dolly-instance.json"),
      JSON.stringify({ schemaVersion: "dolly.state-manifest/1", instanceId: IDS[1] }),
    );
    const configPath = join(configDirectory, "dolly.json");

    expect(() =>
      store.initialize(configPath, (instanceId) =>
        documentFor(instanceId, { stateDirectory }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<InstanceConfigError>>({ code: "STATE_MANIFEST_CONFLICT" }),
    );
    expect(existsSync(configPath)).toBe(false);
  });

  it("fails closed when another process owns the configuration lock", () => {
    const configDirectory = join(root, "project");
    mkdirSync(configDirectory);
    const configPath = join(configDirectory, "dolly.json");
    store.initialize(configPath, (instanceId) => documentFor(instanceId));

    const canonicalPath = realpathSync.native(configPath);
    const identity = `config:${process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath}`;
    const lockName = createHash("sha256").update(identity, "utf8").digest("hex");
    const lockDirectory = join(root, "registry", "locks");
    mkdirSync(lockDirectory, { recursive: true });
    withSynchronousCrossProcessLock(
      { resourceId: join(lockDirectory, `${lockName}.lock`) },
      () => {
        expect(() => store.claim(configPath)).toThrowError(
          expect.objectContaining<Partial<InstanceConfigError>>({ code: "CONFIG_LOCKED" }),
        );
      },
    );
  });
});
