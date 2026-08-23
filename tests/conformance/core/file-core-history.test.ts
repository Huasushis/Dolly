import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  FileCoreHistoryError,
  FileCoreHistoryStore,
  type FileCoreHistorySqliteConnection,
} from "../../../src/core/file-core-history.js";

const identity = {
  daemonInstallationId: "0198ab11-6c44-7e8a-b2bb-000000000501",
  instanceId: "main",
} as const;
const legacySourceDigest = `sha256:${"a".repeat(64)}`;

class FakeLock {
  held = true;

  assertHeld(): void {
    if (!this.held) throw new Error("controller lock is not held");
  }
}

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openStore(options: Partial<ConstructorParameters<typeof FileCoreHistoryStore>[3]> = {}): {
  readonly database: Database.Database;
  readonly store: FileCoreHistoryStore;
} {
  const database = new Database(":memory:");
  databases.push(database);
  const lock = new FakeLock();
  const store = new FileCoreHistoryStore(
    database as unknown as FileCoreHistorySqliteConnection,
    identity,
    lock,
    {
      producerId: "core-producer",
      producerEpoch: "epoch-1",
      maxEntries: 8,
      maxBytes: 1024,
      maxReaders: 2,
      legacySourceDigest,
      now: () => "2026-08-23T00:00:00.000Z",
      ...options,
    },
  );
  return { database, store };
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

describe("FileCore bounded global history", () => {
  it("starts at an explicit migration floor and reports a pre-migration gap", () => {
    const { store } = openStore();
    store.registerReader("reader-a");

    expect(store.head).toMatchObject({
      history_id: "filecore-global",
      retained_from: 1,
      produced_through: 0,
      retained_entry_count: 0,
      retained_entry_bytes: 0,
    });
    expectHistoryCode(
      () => store.read({ readerId: "reader-a", start: { cursor: 0 } }),
      "HISTORY_GAP",
    );
  });

  it("enforces count and canonical-byte limits before append mutation", () => {
    const { store } = openStore({ maxEntries: 2, maxBytes: 64 });
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
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    const before = store.head;

    expectHistoryCode(
      () => store.append({ producerEntryId: "entry-3", value: { value: "c" }, expectedHeadRevision: 3 }),
      "HISTORY_LIMIT_EXCEEDED",
    );
    expect(store.head).toEqual(before);

    const { store: byteLimitedStore } = openStore({ maxEntries: 8, maxBytes: 5 });
    expectHistoryCode(
      () => byteLimitedStore.append({ producerEntryId: "large-entry", value: { value: "a" }, expectedHeadRevision: 1 }),
      "HISTORY_ENTRY_TOO_LARGE",
    );

    const retry = store.append({
      producerEntryId: "entry-2",
      value: { value: "b" },
      expectedHeadRevision: 1,
    });
    expect(retry).toEqual(second);
    expectHistoryCode(
      () => store.append({ producerEntryId: "entry-2", value: { value: "different" }, expectedHeadRevision: 3 }),
      "HISTORY_IDEMPOTENCY_CONFLICT",
    );
  });

  it("bounds reader slots and keeps ACKs outside producer authority", () => {
    const { store } = openStore({ maxReaders: 1 });
    const reader = store.registerReader("reader-a");
    expect(reader.cursor).toBe(1);
    expectHistoryCode(() => store.registerReader("reader-b"), "HISTORY_READER_LIMIT");

    const first = store.append({
      producerEntryId: "entry-1",
      value: { value: "a" },
      expectedHeadRevision: 1,
    });
    const beforeAck = store.head;
    const acknowledged = store.acknowledge({
      readerId: "reader-a",
      cursor: 2,
      expectedReaderRevision: reader.reader_revision,
    });
    expect(acknowledged.cursor).toBe(2);
    expect(store.head).toEqual(beforeAck);
    expect(store.checkpoint.delete_through).toBe(0);

    const checkpoint = store.publishCheckpoint({
      producerRevision: first.head_revision,
      deleteThrough: 1,
      issuedAt: "2026-08-23T00:00:01.000Z",
      evidenceDigest: `sha256:${"b".repeat(64)}`,
      expectedHeadRevision: beforeAck.head_revision,
    });
    expect(checkpoint.delete_through).toBe(1);
    const beforeRegression = store.head;
    expectHistoryCode(
      () => store.publishCheckpoint({
        producerRevision: first.head_revision,
        deleteThrough: 0,
        issuedAt: "2026-08-23T00:00:02.000Z",
        expectedHeadRevision: beforeRegression.head_revision,
      }),
      "HISTORY_CHECKPOINT_REGRESSION",
    );
    expect(store.head).toEqual(beforeRegression);
    expect(store.checkpoint).toEqual(checkpoint);
  });

  it("deletes only through the current producer checkpoint and leaves an honest gap", () => {
    const { store } = openStore();
    const reader = store.registerReader("reader-a");
    const first = store.append({
      producerEntryId: "entry-1",
      value: { value: "a" },
      expectedHeadRevision: 1,
    });
    store.append({
      producerEntryId: "entry-2",
      value: { value: "b" },
      expectedHeadRevision: first.head_revision,
    });
    const checkpoint = store.publishCheckpoint({
      producerRevision: 2,
      deleteThrough: 1,
      issuedAt: "2026-08-23T00:00:01.000Z",
      expectedHeadRevision: 3,
    });
    const beforeDelete = store.head;
    expectHistoryCode(
      () => store.deleteEligible({
        checkpointVersion: checkpoint.checkpoint_version,
        checkpointDigest: `sha256:${"c".repeat(64)}`,
        producerEpoch: "epoch-1",
        expectedHeadRevision: beforeDelete.head_revision,
      }),
      "HISTORY_CHECKPOINT_STALE",
    );
    expect(store.head).toEqual(beforeDelete);

    const deleted = store.deleteEligible({
      checkpointVersion: checkpoint.checkpoint_version,
      checkpointDigest: checkpoint.checkpoint_digest,
      producerEpoch: checkpoint.producer_epoch,
      expectedHeadRevision: beforeDelete.head_revision,
    });
    expect(deleted).toMatchObject({ deleted_through: 1, deleted_count: 1, retained_from: 2 });
    expectHistoryCode(
      () => store.read({ readerId: reader.reader_id, start: { cursor: 1 } }),
      "HISTORY_GAP",
    );
    const remaining = store.read({ readerId: reader.reader_id, start: { cursor: 2 } });
    expect(remaining.entries).toHaveLength(1);
    expect(remaining.entries[0]?.sequence).toBe(2);
  });
});
