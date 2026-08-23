import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  createFileCoreHistoryStore,
  FileCoreHistoryError,
  FileCoreHistoryStore,
  mintFileCoreHistoryProducerCapability,
  type FileCoreHistoryOptions,
} from "../../../src/core/file-core-history.js";
import {
  RuntimeAuthorityDatabase,
  RuntimeAuthorityDatabaseError,
  type RuntimeAuthorityIdentity,
} from "../../../src/adapters/storage/runtime-authority-database.js";
import { canonicalBytes, canonicalJsonDigest } from "../../../src/schema-bundle/index.js";

const identity: RuntimeAuthorityIdentity = {
  daemonInstallationId: "0198ab11-6c44-7e8a-b2bb-000000000501",
  instanceId: "main",
};
const temporaryDirectories: string[] = [];
const authorities: RuntimeAuthorityDatabase[] = [];

class FakeLock {
  held = true;

  assertHeld(): void {
    if (!this.held) throw new Error("controller lock is not held");
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dolly-filecore-history-r31-"));
  temporaryDirectories.push(directory);
  return directory;
}

function resolvedConfig(): Uint8Array {
  return Buffer.from(canonicalBytes({
    runtime_config: { value: "filecore-history" },
    permission_policy_selections: [],
    service_candidate: null,
  }));
}

function legacyCoreSource(): Uint8Array {
  const payload = {
    schemaVersion: "dolly.core-state/19",
    revision: 1,
    referenceGraph: { deliveries: [], activations: [] },
    blocks: { blocks: [] },
    moduleProcessRecords: [],
    moduleSubmissionRecords: [],
    activeClaimsWithUnknownSubmissionHistory: [],
    processGenerationIdCounter: 0,
  };
  return Buffer.from(canonicalBytes({
    ...payload,
    stateDigest: canonicalJsonDigest(payload),
  }));
}

function openAuthority(): { readonly database: RuntimeAuthorityDatabase; readonly lock: FakeLock; readonly path: string } {
  const path = join(scratch(), "runtime-authority.sqlite");
  const lock = new FakeLock();
  const database = RuntimeAuthorityDatabase.open({ path, identity, lock });
  authorities.push(database);
  const configBytes = resolvedConfig();
  database.installConfig({
    identity,
    canonicalConfigBytes: configBytes,
    configDigest: digest(configBytes),
    premise: null,
    verifiedOrigins: [],
  });
  return { database, lock, path };
}

function migrate(database: RuntimeAuthorityDatabase, options: Partial<FileCoreHistoryOptions> = {}) {
  const current = database.readCurrentConfig();
  if (current === null) throw new Error("authority config was not installed");
  const sourceBytes = legacyCoreSource();
  return database.migrateFileCoreHistory({
    expectedAuthority: { revision: current.config_revision, digest: current.config_digest },
    legacySourceBytes: sourceBytes,
    legacySourceDigest: digest(sourceBytes),
    maxEntries: 8,
    maxBytes: 64,
    maxReaders: 2,
    now: () => "2026-08-23T00:00:00.000Z",
    ...options,
  });
}

function expectHistoryCode(action: () => unknown, code: FileCoreHistoryError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FileCoreHistoryError);
    expect((error as FileCoreHistoryError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

afterEach(() => {
  for (const authority of authorities.splice(0)) authority.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("FileCore bounded global history", () => {
  it("rejects raw producer construction without the Runtime authority capability", () => {
    const database = new Database(":memory:");
    const RawStore = FileCoreHistoryStore as unknown as new (...args: readonly unknown[]) => unknown;
    expect(() => new RawStore(database, identity, new FakeLock(), {
      maxEntries: 8,
      maxBytes: 64,
      maxReaders: 2,
    })).toThrowError("constructor requires the Runtime authority token");
    const fakeCapability = { assertValid: () => undefined };
    expect(() => createFileCoreHistoryStore(
      database as never,
      identity,
      new FakeLock() as never,
      { maxEntries: 8, maxBytes: 64, maxReaders: 2 },
      fakeCapability,
    )).toThrowError("not minted");
    expect(() => mintFileCoreHistoryProducerCapability({})).toThrowError("requires RuntimeAuthorityDatabase");
  });

  it("requires Runtime-authority migration and exposes an explicit pre-migration gap", () => {
    const { database } = openAuthority();
    const policy: FileCoreHistoryOptions = { maxEntries: 8, maxBytes: 64, maxReaders: 2 };
    expect(() => database.openFileCoreHistory(policy)).toThrowError(FileCoreHistoryError);
    const current = database.readCurrentConfig();
    if (current === null) throw new Error("authority config was not installed");
    const sourceBytes = legacyCoreSource();
    expect(() => database.migrateFileCoreHistory({
      expectedAuthority: { revision: current.config_revision + 1, digest: current.config_digest },
      legacySourceBytes: sourceBytes,
      legacySourceDigest: digest(sourceBytes),
      ...policy,
    })).toThrowError(RuntimeAuthorityDatabaseError);

    const producer = migrate(database, policy);
    const reader = database.openFileCoreHistoryReader(policy);
    reader.registerReader("reader-a");
    expect(producer.head).toMatchObject({
      history_id: "filecore-global",
      producer_id: "filecore-main",
      retained_from: 1,
      produced_through: 0,
      retained_entry_count: 0,
      retained_entry_bytes: 0,
    });
    expectHistoryCode(
      () => reader.read({ readerId: "reader-a", start: { cursor: 0 } }),
      "HISTORY_GAP",
    );
    expect("publishCheckpoint" in reader).toBe(false);
  });

  it("enforces count and canonical-byte limits before append mutation", () => {
    const { database } = openAuthority();
    const store = migrate(database, { maxEntries: 2 });
    const first = store.append({
      producerEntryId: "entry-1",
      value: { value: "a" },
      expectedHeadRevision: 1,
    });
    const second = store.append({
      producerEntryId: "entry-2",
      value: { value: "b" },
      expectedHeadRevision: 2,
    });
    const before = store.head;
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expectHistoryCode(
      () => store.append({ producerEntryId: "entry-3", value: { value: "c" }, expectedHeadRevision: 3 }),
      "HISTORY_LIMIT_EXCEEDED",
    );
    expect(store.head).toEqual(before);
    expectHistoryCode(
      () => store.append({ producerEntryId: "large-entry", value: { value: "x".repeat(80) }, expectedHeadRevision: 3 }),
      "HISTORY_ENTRY_TOO_LARGE",
    );
    expect(store.append({ producerEntryId: "entry-2", value: { value: "b" }, expectedHeadRevision: 1 })).toEqual(second);
    expectHistoryCode(
      () => store.append({ producerEntryId: "entry-2", value: { value: "different" }, expectedHeadRevision: 3 }),
      "HISTORY_IDEMPOTENCY_CONFLICT",
    );
  });

  it("keeps ACKs reader-only and enforces producer checkpoint monotonicity", () => {
    const { database } = openAuthority();
    const policy: FileCoreHistoryOptions = { maxEntries: 8, maxBytes: 64, maxReaders: 1 };
    const producer = migrate(database, policy);
    const reader = database.openFileCoreHistoryReader(policy);
    const registered = reader.registerReader("reader-a");
    const first = producer.append({ producerEntryId: "entry-1", value: { value: "a" }, expectedHeadRevision: 1 });
    const beforeAck = producer.head;
    expect(reader.acknowledge({ readerId: "reader-a", cursor: 2, expectedReaderRevision: registered.reader_revision }).cursor).toBe(2);
    expect(producer.head).toEqual(beforeAck);
    const checkpoint = producer.publishCheckpoint({
      producerRevision: first.head_revision,
      deleteThrough: 1,
      issuedAt: "2026-08-23T00:00:01.000Z",
      evidenceDigest: `sha256:${"b".repeat(64)}`,
      expectedHeadRevision: beforeAck.head_revision,
    });
    const beforeRegression = producer.head;
    expectHistoryCode(
      () => producer.publishCheckpoint({
        producerRevision: first.head_revision,
        deleteThrough: 0,
        issuedAt: "2026-08-23T00:00:02.000Z",
        expectedHeadRevision: beforeRegression.head_revision,
      }),
      "HISTORY_CHECKPOINT_REGRESSION",
    );
    expect(producer.checkpoint).toEqual(checkpoint);
    expect(() => database.openFileCoreHistoryReader(policy).read({ readerId: "reader-a" })).not.toThrow();
  });

  it("deletes only through the current producer checkpoint and leaves an honest gap", () => {
    const { database } = openAuthority();
    const policy: FileCoreHistoryOptions = { maxEntries: 8, maxBytes: 64, maxReaders: 2 };
    const producer = migrate(database, policy);
    const reader = database.openFileCoreHistoryReader(policy);
    reader.registerReader("reader-a");
    const first = producer.append({ producerEntryId: "entry-1", value: { value: "a" }, expectedHeadRevision: 1 });
    producer.append({ producerEntryId: "entry-2", value: { value: "b" }, expectedHeadRevision: first.head_revision });
    const checkpoint = producer.publishCheckpoint({
      producerRevision: 2,
      deleteThrough: 1,
      issuedAt: "2026-08-23T00:00:01.000Z",
      expectedHeadRevision: 3,
    });
    const beforeDelete = producer.head;
    expectHistoryCode(
      () => producer.deleteEligible({
        checkpointVersion: checkpoint.checkpoint_version,
        checkpointDigest: `sha256:${"c".repeat(64)}`,
        producerEpoch: checkpoint.producer_epoch,
        expectedHeadRevision: beforeDelete.head_revision,
      }),
      "HISTORY_CHECKPOINT_STALE",
    );
    const deleted = producer.deleteEligible({
      checkpointVersion: checkpoint.checkpoint_version,
      checkpointDigest: checkpoint.checkpoint_digest,
      producerEpoch: checkpoint.producer_epoch,
      expectedHeadRevision: beforeDelete.head_revision,
    });
    expect(deleted).toMatchObject({ deleted_through: 1, deleted_count: 1, retained_from: 2 });
    expectHistoryCode(() => reader.read({ readerId: "reader-a", start: { cursor: 1 } }), "HISTORY_GAP");
    expect(reader.read({ readerId: "reader-a", start: { cursor: 2 } }).entries).toHaveLength(1);
  });

  it("requires the controller lock and detects persisted projection tampering", () => {
    const { database, lock, path } = openAuthority();
    const policy: FileCoreHistoryOptions = { maxEntries: 8, maxBytes: 64, maxReaders: 2 };
    const producer = migrate(database, policy);
    producer.append({ producerEntryId: "entry-1", value: { value: "a" }, expectedHeadRevision: 1 });
    const reader = database.openFileCoreHistoryReader(policy);
    reader.registerReader("reader-a");
    lock.held = false;
    expectHistoryCode(() => reader.read({ readerId: "reader-a" }), "HISTORY_LOCK_NOT_HELD");
    lock.held = true;
    database.close();
    const tamper = new Database(path);
    tamper.prepare("UPDATE filecore_history_entries SET entry_bytes = entry_bytes + 1 WHERE sequence = 1").run();
    tamper.close();
    const reopenedLock = new FakeLock();
    const reopened = RuntimeAuthorityDatabase.open({ path, identity, lock: reopenedLock });
    authorities.push(reopened);
    expect(() => reopened.openFileCoreHistory(policy)).toThrowError(FileCoreHistoryError);
  });
});
