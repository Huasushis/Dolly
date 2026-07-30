import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest, type JsonValue } from "../../../src/core/canonical-json.js";
import * as fileCoreStateModule from "../../../src/core/file-core-state-store.js";
import {
  CoreStateError,
  FileCoreStateStore,
} from "../../../src/core/file-core-state-store.js";

const NOW = "2026-07-31T00:00:00.000Z";

type JsonObject = Record<string, JsonValue>;
type SourceVersion = "15" | "16";

interface ExactClaimIdentity {
  readonly moduleJobId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
}

interface SeededDocument {
  readonly identity: ExactClaimIdentity;
  readonly raw: string;
  readonly revision: number;
  readonly version: SourceVersion;
}

type Version17MigrationResult =
  | {
      readonly status: "migrated";
      readonly sourceSchemaVersion:
        | "dolly.core-state/15"
        | "dolly.core-state/16";
      readonly backupPath: string;
    }
  | {
      readonly status: "already-current";
      readonly schemaVersion: "dolly.core-state/17";
    };

type Version17Migration = (
  path: string,
  options: {
    readonly runtimeConfiguration: {
      readonly maxFailedAttempts: number;
      readonly media: { readonly enabled: false };
    };
  },
) => Version17MigrationResult;

/**
 * `activeClaimsWithUnknownSubmissionHistory` stores exact active Claim
 * identities for which migration from an older Core-state document cannot
 * determine whether a submission record was ever persisted. It is not a
 * submission record and cannot mean that sending was never authorized.
 */
const UNKNOWN_SUBMISSION_HISTORY_FIELD =
  "activeClaimsWithUnknownSubmissionHistory";

function migrateToVersion17(path: string): ReturnType<Version17Migration> {
  const candidate = Reflect.get(
    fileCoreStateModule,
    "migrateCoreStateDocumentToVersion17",
  );
  if (typeof candidate !== "function") {
    throw new Error(
      "FileCoreStateStore must export migrateCoreStateDocumentToVersion17",
    );
  }
  return (candidate as Version17Migration)(path, {
    runtimeConfiguration: {
      maxFailedAttempts: 3,
      media: { enabled: false },
    },
  });
}

function openStore(path: string, prefix: string): FileCoreStateStore {
  let blockId = 0;
  let deliveryId = 0;
  return new FileCoreStateStore({
    path,
    maxFailedAttempts: 3,
    nextBlockId: () => `${prefix}-block-${++blockId}`,
    nextDeliveryId: (kind) => `${prefix}-${kind}-${++deliveryId}`,
    now: () => NOW,
  });
}

function readDocument(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function basePayload(document: JsonObject): JsonObject {
  return {
    revision: document.revision!,
    referenceGraph: document.referenceGraph!,
    ...(document.media === undefined ? {} : { media: document.media }),
    blocks: document.blocks!,
    deliveries: document.deliveries!,
  };
}

function version16Payload(document: JsonObject): JsonObject {
  return {
    ...basePayload(document),
    moduleProcessRecords: document.moduleProcessRecords!,
    moduleSubmissionRecords: document.moduleSubmissionRecords!,
  };
}

function writeVersion15(path: string): { readonly raw: string; readonly revision: number } {
  const current = readDocument(path);
  const payload = basePayload(current);
  const legacy: JsonObject = {
    schemaVersion: "dolly.core-state/15",
    stateDigest: canonicalJsonDigest(payload),
    ...payload,
  };
  const raw = `${JSON.stringify(legacy)}\n`;
  writeFileSync(path, raw, "utf8");
  return {
    raw,
    revision: legacy.revision as number,
  };
}

function writeVersion16(path: string): { readonly raw: string; readonly revision: number } {
  const current = readDocument(path);
  const payload = version16Payload(current);
  const legacy: JsonObject = {
    schemaVersion: "dolly.core-state/16",
    stateDigest: canonicalJsonDigest(payload),
    ...payload,
  };
  const raw = `${JSON.stringify(legacy)}\n`;
  writeFileSync(path, raw, "utf8");
  return {
    raw,
    revision: legacy.revision as number,
  };
}

function seedActiveClaim(
  path: string,
  version: SourceVersion,
): SeededDocument {
  const store = openStore(path, `version-${version}`);
  store.deliveries.createPage("input");
  store.deliveries.registerConsumer("input", "worker", "from-now");
  const block = store.blocks.commit(
    {
      payload: {
        schema: "test.content/1",
        value: { text: `version ${version}` },
      },
    },
    { kind: "external", id: "console" },
  );
  store.deliveries.append("input", block.id);
  const claim = store.deliveries.claim({
    consumerId: "worker",
    pageIds: ["input"],
    moduleGenerationId: "module-generation-1",
    maxCount: 1,
    maxBytes: 1024 * 1024,
  })!;
  const identity: ExactClaimIdentity = Object.freeze({
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: claim.moduleGenerationId,
  });

  if (version === "15") {
    const legacy = writeVersion15(path);
    return {
      identity,
      raw: legacy.raw,
      revision: legacy.revision,
      version,
    };
  }
  const legacy = writeVersion16(path);
  return {
    identity,
    raw: legacy.raw,
    revision: legacy.revision,
    version,
  };
}

function backupPath(path: string, version: SourceVersion): string {
  return `${path}.v${version}.backup`;
}

function writeNestedInvalidDocument(
  path: string,
  version: SourceVersion,
): SeededDocument {
  const seeded = seedActiveClaim(path, version);
  const document = readDocument(path);
  const deliveries = document.deliveries as JsonObject;
  const claims = deliveries.claims as JsonValue[];
  const claim = claims[0] as JsonObject;
  claim.runId = `${claim.runId as string}-different`;

  if (version === "15") {
    const payload = basePayload(document);
    document.stateDigest = canonicalJsonDigest(payload);
  } else {
    document.stateDigest = canonicalJsonDigest(version16Payload(document));
  }
  const raw = `${JSON.stringify(document)}\n`;
  writeFileSync(path, raw, "utf8");
  return { ...seeded, raw };
}

describe("explicit Core-state version 17 migration", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-core-state-v17-migration-"));
    path = join(root, "core-state.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each<SourceVersion>(["15", "16"])(
    "migrates version %s directly to version 17 and preserves the source bytes",
    (version) => {
      const source = seedActiveClaim(path, version);

      expect(migrateToVersion17(path)).toEqual({
        status: "migrated",
        sourceSchemaVersion: `dolly.core-state/${version}`,
        backupPath: resolve(backupPath(path, version)),
      });

      const migrated = readDocument(path);
      expect(migrated.schemaVersion).toBe("dolly.core-state/17");
      expect(migrated.revision).toBe(source.revision + 1);
      expect(migrated[UNKNOWN_SUBMISSION_HISTORY_FIELD]).toEqual([source.identity]);
      expect(migrated.moduleSubmissionRecords).toEqual([]);
      expect(readFileSync(backupPath(path, version), "utf8")).toBe(source.raw);
      expect(existsSync(backupPath(path, version === "15" ? "16" : "15"))).toBe(false);
    },
  );

  it("does not treat a version 16 active Claim without a submission record as never submitted", () => {
    const source = seedActiveClaim(path, "16");
    expect(migrateToVersion17(path)).toEqual({
      status: "migrated",
      sourceSchemaVersion: "dolly.core-state/16",
      backupPath: resolve(backupPath(path, "16")),
    });
    const migratedRaw = readFileSync(path, "utf8");
    const migrated = readDocument(path);

    expect(migrated.moduleSubmissionRecords).toEqual([]);
    expect(migrated[UNKNOWN_SUBMISSION_HISTORY_FIELD]).toEqual([source.identity]);

    const reopened = openStore(path, "reopened");
    expect(() => reopened.releaseDeliveryClaim(source.identity)).toThrow();
    expect(reopened.deliveries.inspectClaim(source.identity).status).toBe("active");
    expect(readFileSync(path, "utf8")).toBe(migratedRaw);
  });

  it("increments revision once and includes the schema version in the version 17 digest", () => {
    const source = seedActiveClaim(path, "16");
    expect(migrateToVersion17(path)).toEqual({
      status: "migrated",
      sourceSchemaVersion: "dolly.core-state/16",
      backupPath: resolve(backupPath(path, "16")),
    });
    const migrated = readDocument(path);
    const {
      stateDigest,
      ...digestInput
    } = migrated;
    const {
      schemaVersion: _schemaVersion,
      ...version16StyleDigestInput
    } = digestInput;

    expect(migrated.revision).toBe(source.revision + 1);
    expect(stateDigest).toBe(canonicalJsonDigest(digestInput));
    expect(stateDigest).not.toBe(canonicalJsonDigest(version16StyleDigestInput));
  });

  it.each<SourceVersion>(["15", "16"])(
    "continues version %s migration when the existing backup exactly matches the source bytes",
    (version) => {
      const source = seedActiveClaim(path, version);
      const existingBackupPath = backupPath(path, version);
      writeFileSync(existingBackupPath, source.raw, "utf8");

      expect(migrateToVersion17(path)).toEqual({
        status: "migrated",
        sourceSchemaVersion: `dolly.core-state/${version}`,
        backupPath: resolve(existingBackupPath),
      });
      expect(readFileSync(existingBackupPath, "utf8")).toBe(source.raw);
      expect(readDocument(path).schemaVersion).toBe("dolly.core-state/17");
    },
  );

  it.each([
    ["15", "partial"],
    ["15", "different"],
    ["16", "partial"],
    ["16", "different"],
  ] as const)(
    "rejects a %s source when its existing backup is %s",
    (version, backupKind) => {
      const source = seedActiveClaim(path, version);
      const existingBackupPath = backupPath(path, version);
      const existingBackup =
        backupKind === "partial"
          ? source.raw.slice(0, Math.floor(source.raw.length / 2))
          : '{"different":"document"}\n';
      writeFileSync(existingBackupPath, existingBackup, "utf8");

      expect(() => migrateToVersion17(path)).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_IO_FAILED",
        }),
      );
      expect(readFileSync(path, "utf8")).toBe(source.raw);
      expect(readFileSync(existingBackupPath, "utf8")).toBe(existingBackup);
    },
  );

  it.each<SourceVersion>(["15", "16"])(
    "fully validates an invalid version %s document before creating its backup",
    (version) => {
      const source = writeNestedInvalidDocument(path, version);

      expect(() => migrateToVersion17(path)).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_DOCUMENT_INVALID",
        }),
      );
      expect(readFileSync(path, "utf8")).toBe(source.raw);
      expect(existsSync(backupPath(path, version))).toBe(false);
    },
  );
});
