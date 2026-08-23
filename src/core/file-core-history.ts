import {
  assertCanonicalJsonValue,
  canonicalBytes,
  canonicalJsonDigest,
  parseCanonicalJsonBytes,
  type JsonValue,
} from "../schema-bundle/index.js";
import type {
  RuntimeAuthorityIdentity,
  RuntimeAuthorityLockHandle,
} from "../adapters/storage/runtime-authority-database.js";

export const FILECORE_GLOBAL_HISTORY_ID = "filecore-global" as const;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const NULL_DIGEST = canonicalJsonDigest(null);

interface FileCoreHistorySqliteStatement {
  get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
  all(...parameters: readonly unknown[]): readonly Record<string, unknown>[];
  run(...parameters: readonly unknown[]): { readonly changes: number; readonly lastInsertRowid: number | bigint };
}

interface FileCoreHistorySqliteConnection {
  readonly open: boolean;
  prepare(source: string): FileCoreHistorySqliteStatement;
  exec(source: string): unknown;
}

type FileCoreHistoryProducerCapability = {
  readonly assertValid: () => void;
};

export interface FileCoreHistoryOptions {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxReaders: number;
  readonly now?: () => string;
  readonly legacySourceDigest?: string;
}

export interface FileCoreHistoryMigrationOptions extends FileCoreHistoryOptions {
  readonly producerId: string;
  readonly producerEpoch: string;
  /** Exact bytes digest of the legacy FileCore source at the migration boundary. */
  readonly legacySourceDigest: string;
}

export interface FileCoreHistoryHead {
  readonly schema: "dolly.filecore-history-head/v1";
  readonly history_id: typeof FILECORE_GLOBAL_HISTORY_ID;
  readonly producer_id: string;
  readonly producer_epoch: string;
  readonly head_revision: number;
  readonly next_sequence: number;
  readonly retained_from: number;
  readonly produced_through: number;
  readonly retained_entry_count: number;
  readonly retained_entry_bytes: number;
  readonly max_entries: number;
  readonly max_bytes: number;
  readonly max_readers: number;
  readonly legacy_source_digest: string;
  readonly head_digest: string;
}

export interface FileCoreHistoryEntry {
  readonly schema: "dolly.filecore-history-entry/v1";
  readonly history_id: typeof FILECORE_GLOBAL_HISTORY_ID;
  readonly sequence: number;
  readonly producer_epoch: string;
  readonly producer_entry_id: string;
  readonly entry_jcs: string;
  readonly entry_digest: string;
  readonly entry_bytes: number;
  readonly head_revision: number;
}

export interface FileCoreHistoryCheckpoint {
  readonly schema: "dolly.filecore-history-checkpoint/v1";
  readonly history_id: typeof FILECORE_GLOBAL_HISTORY_ID;
  readonly checkpoint_version: number;
  readonly producer_id: string;
  readonly producer_epoch: string;
  readonly producer_revision: number;
  readonly delete_through: number;
  readonly issued_at: string;
  readonly evidence_digest: string;
  readonly checkpoint_digest: string;
}

export interface FileCoreHistoryReader {
  readonly schema: "dolly.filecore-history-reader/v1";
  readonly history_id: typeof FILECORE_GLOBAL_HISTORY_ID;
  readonly reader_id: string;
  readonly cursor: number;
  readonly reader_revision: number;
  readonly cursor_digest: string;
}

export interface FileCoreHistoryAppendInput {
  readonly producerEntryId: string;
  readonly value: JsonValue;
  readonly expectedHeadRevision: number;
}

export interface FileCoreHistoryCheckpointInput {
  readonly producerRevision: number;
  readonly deleteThrough: number;
  readonly issuedAt: string;
  readonly evidenceDigest?: string;
  readonly expectedHeadRevision: number;
}

export interface FileCoreHistoryDeleteInput {
  readonly checkpointVersion: number;
  readonly checkpointDigest: string;
  readonly producerEpoch: string;
  readonly expectedHeadRevision: number;
}

export type FileCoreHistoryReadStart =
  | "from-head"
  | "from-now"
  | { readonly cursor: number };

export interface FileCoreHistoryReadInput {
  readonly readerId: string;
  readonly start?: FileCoreHistoryReadStart;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export interface FileCoreHistoryReadResult {
  readonly history_id: typeof FILECORE_GLOBAL_HISTORY_ID;
  readonly reader_id: string;
  readonly cursor: number;
  readonly next_cursor: number;
  readonly head_revision: number;
  readonly retained_from: number;
  readonly produced_through: number;
  readonly entries: readonly FileCoreHistoryEntry[];
}

export interface FileCoreHistoryAckInput {
  readonly readerId: string;
  readonly cursor: number;
  readonly expectedReaderRevision: number;
}

export interface FileCoreHistoryDeleteResult {
  readonly head_revision: number;
  readonly retained_from: number;
  readonly produced_through: number;
  readonly deleted_through: number;
  readonly deleted_count: number;
  readonly deleted_bytes: number;
}

export type FileCoreHistoryErrorCode =
  | "HISTORY_CORRUPT"
  | "HISTORY_LOCK_NOT_HELD"
  | "HISTORY_COMMIT_UNKNOWN"
  | "HISTORY_LIMIT_EXCEEDED"
  | "HISTORY_ENTRY_TOO_LARGE"
  | "HISTORY_IDEMPOTENCY_CONFLICT"
  | "HISTORY_CHECKPOINT_REGRESSION"
  | "HISTORY_CHECKPOINT_STALE"
  | "HISTORY_CHECKPOINT_INVALID"
  | "HISTORY_PRODUCER_FENCED"
  | "HISTORY_REVISION_CONFLICT"
  | "HISTORY_READER_LIMIT"
  | "HISTORY_READER_REVISION_CONFLICT"
  | "HISTORY_CURSOR_AHEAD"
  | "HISTORY_CURSOR_REGRESSION"
  | "HISTORY_GAP"
  | "HISTORY_MIGRATION_REQUIRED";

export class FileCoreHistoryError extends Error {
  constructor(
    readonly code: FileCoreHistoryErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "FileCoreHistoryError";
  }
}

const HISTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS filecore_history_head (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  history_id TEXT NOT NULL UNIQUE CHECK (history_id = 'filecore-global'),
  producer_id TEXT NOT NULL,
  producer_epoch TEXT NOT NULL,
  head_revision INTEGER NOT NULL,
  next_sequence INTEGER NOT NULL,
  retained_from INTEGER NOT NULL,
  produced_through INTEGER NOT NULL,
  retained_entry_count INTEGER NOT NULL,
  retained_entry_bytes INTEGER NOT NULL,
  max_entries INTEGER NOT NULL,
  max_bytes INTEGER NOT NULL,
  max_readers INTEGER NOT NULL,
  legacy_source_digest TEXT NOT NULL,
  head_digest TEXT NOT NULL,
  record_jcs BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS filecore_history_entries (
  history_id TEXT NOT NULL CHECK (history_id = 'filecore-global'),
  sequence INTEGER NOT NULL,
  producer_epoch TEXT NOT NULL,
  producer_entry_id TEXT NOT NULL,
  entry_jcs BLOB NOT NULL,
  entry_digest TEXT NOT NULL,
  entry_bytes INTEGER NOT NULL,
  head_revision INTEGER NOT NULL,
  record_jcs BLOB NOT NULL,
  PRIMARY KEY (history_id, sequence),
  UNIQUE (history_id, producer_epoch, producer_entry_id)
);
CREATE TABLE IF NOT EXISTS filecore_history_checkpoint (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  history_id TEXT NOT NULL UNIQUE CHECK (history_id = 'filecore-global'),
  checkpoint_version INTEGER NOT NULL,
  producer_id TEXT NOT NULL,
  producer_epoch TEXT NOT NULL,
  producer_revision INTEGER NOT NULL,
  delete_through INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  checkpoint_digest TEXT NOT NULL,
  record_jcs BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS filecore_history_readers (
  history_id TEXT NOT NULL CHECK (history_id = 'filecore-global'),
  reader_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  reader_revision INTEGER NOT NULL,
  cursor_digest TEXT NOT NULL,
  record_jcs BLOB NOT NULL,
  PRIMARY KEY (history_id, reader_id)
);
`;

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= MAX_SAFE;
}

function assertSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!isSafeInteger(value, minimum)) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a non-empty bounded identifier`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new TypeError(`${label} must be a bounded timestamp string`);
  }
}

function bytesFrom(value: JsonValue): Uint8Array {
  assertCanonicalJsonValue(value);
  return canonicalBytes(value);
}

function digestWithoutField(record: Record<string, unknown>, field: string): string {
  const { [field]: _ignored, ...rest } = record;
  assertCanonicalJsonValue(rest as JsonValue);
  return canonicalJsonDigest(rest);
}

function toBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new FileCoreHistoryError("HISTORY_CORRUPT", `${label} is not a byte column`);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function immutable<T extends object>(value: T): T {
  return Object.freeze(value);
}

function decodeRecord(value: unknown, label: string): Record<string, unknown> {
  let decoded: JsonValue;
  try {
    decoded = parseCanonicalJsonBytes(toBytes(value, `${label}.record_jcs`));
  } catch (error) {
    throw new FileCoreHistoryError("HISTORY_CORRUPT", `${label} record_jcs is not canonical JSON`, { cause: error });
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new FileCoreHistoryError("HISTORY_CORRUPT", `${label} record must be an object`);
  }
  return decoded as Record<string, unknown>;
}

function assertClosedRecord(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new FileCoreHistoryError("HISTORY_CORRUPT", `${label} has unknown or missing fields`);
  }
}

const HEAD_KEYS = [
  "schema",
  "history_id",
  "producer_id",
  "producer_epoch",
  "head_revision",
  "next_sequence",
  "retained_from",
  "produced_through",
  "retained_entry_count",
  "retained_entry_bytes",
  "max_entries",
  "max_bytes",
  "max_readers",
  "legacy_source_digest",
  "head_digest",
] as const;

const ENTRY_KEYS = [
  "schema",
  "history_id",
  "sequence",
  "producer_epoch",
  "producer_entry_id",
  "entry_jcs",
  "entry_digest",
  "entry_bytes",
  "head_revision",
] as const;

const CHECKPOINT_KEYS = [
  "schema",
  "history_id",
  "checkpoint_version",
  "producer_id",
  "producer_epoch",
  "producer_revision",
  "delete_through",
  "issued_at",
  "evidence_digest",
  "checkpoint_digest",
] as const;

const READER_KEYS = [
  "schema",
  "history_id",
  "reader_id",
  "cursor",
  "reader_revision",
  "cursor_digest",
] as const;

const FILECORE_HISTORY_MIGRATION_TOKEN = Symbol("filecore-history-migration");

export class FileCoreHistoryStore {
  readonly #connection: FileCoreHistorySqliteConnection;
  readonly #identity: RuntimeAuthorityIdentity;
  readonly #lock: RuntimeAuthorityLockHandle;
  readonly #producerCapability: FileCoreHistoryProducerCapability;
  #producerId: string;
  #producerEpoch: string;
  readonly #now: () => string;
  private constructor(
    connection: FileCoreHistorySqliteConnection,
    identity: RuntimeAuthorityIdentity,
    lock: RuntimeAuthorityLockHandle,
    options: FileCoreHistoryOptions,
    producerCapability: FileCoreHistoryProducerCapability,
    migrationToken?: symbol,
  ) {
    this.#connection = connection;
    this.#identity = { ...identity };
    this.#lock = lock;
    this.#producerCapability = producerCapability;
    this.#producerId = "";
    this.#producerEpoch = "";
    this.#now = options.now ?? (() => new Date().toISOString());
    assertSafeInteger(options.maxEntries, "maxEntries", 1);
    assertSafeInteger(options.maxBytes, "maxBytes", 1);
    assertSafeInteger(options.maxReaders, "maxReaders", 1);
    if (typeof this.#producerCapability?.assertValid !== "function") {
      throw new TypeError("FileCore history producer capability is required");
    }
    if (typeof this.#now !== "function") throw new TypeError("now must be a function");
    if (migrationToken === FILECORE_HISTORY_MIGRATION_TOKEN) {
      this.#openOrInitialize(options as FileCoreHistoryMigrationOptions);
    } else {
      this.#transaction(() => this.#openExisting(options));
    }
  }

  /** @internal RuntimeAuthorityDatabase-only producer factory. */
  static openForRuntimeAuthority(
    connection: FileCoreHistorySqliteConnection,
    identity: RuntimeAuthorityIdentity,
    lock: RuntimeAuthorityLockHandle,
    options: FileCoreHistoryOptions,
    producerCapability: FileCoreHistoryProducerCapability,
  ): FileCoreHistoryStore {
    return new FileCoreHistoryStore(connection, identity, lock, options, producerCapability);
  }

  /** @internal RuntimeAuthorityDatabase-only migration factory. */
  static migrateForRuntimeAuthority(
    connection: FileCoreHistorySqliteConnection,
    identity: RuntimeAuthorityIdentity,
    lock: RuntimeAuthorityLockHandle,
    options: FileCoreHistoryMigrationOptions,
    producerCapability: FileCoreHistoryProducerCapability,
  ): FileCoreHistoryStore {
    return new FileCoreHistoryStore(connection, identity, lock, options, producerCapability, FILECORE_HISTORY_MIGRATION_TOKEN);
  }

  get identity(): RuntimeAuthorityIdentity {
    return { ...this.#identity };
  }

  get head(): FileCoreHistoryHead {
    return this.#readHead();
  }

  get checkpoint(): FileCoreHistoryCheckpoint {
    return this.#readCheckpoint(this.#readHead());
  }

  append(input: FileCoreHistoryAppendInput): FileCoreHistoryEntry {
    assertIdentifier(input.producerEntryId, "producerEntryId");
    assertSafeInteger(input.expectedHeadRevision, "expectedHeadRevision", 1);
    assertCanonicalJsonValue(input.value);
    return this.#transaction(() => {
      const head = this.#readHead();
      this.#assertProducer(head);
      const bytes = bytesFrom(input.value);
      const digest = canonicalJsonDigest(input.value);
      const existing = this.#connection.prepare(
        "SELECT * FROM filecore_history_entries WHERE history_id = ? AND producer_epoch = ? AND producer_entry_id = ?",
      ).get(FILECORE_GLOBAL_HISTORY_ID, this.#producerEpoch, input.producerEntryId);
      if (existing !== undefined) {
        const entry = this.#decodeEntryRow(existing);
        if (entry.entry_digest !== digest || entry.entry_jcs !== Buffer.from(bytes).toString("utf8")) {
          throw new FileCoreHistoryError(
            "HISTORY_IDEMPOTENCY_CONFLICT",
            `producer entry ${input.producerEntryId} was reused with different canonical bytes`,
          );
        }
        return entry;
      }
      this.#assertExpectedHead(head, input.expectedHeadRevision);
      if (bytes.length > head.max_bytes) {
        throw new FileCoreHistoryError("HISTORY_ENTRY_TOO_LARGE", "history entry exceeds max_bytes", {
          entry_bytes: bytes.length,
          max_bytes: head.max_bytes,
        });
      }
      if (head.retained_entry_count >= head.max_entries || head.retained_entry_bytes + bytes.length > head.max_bytes) {
        throw new FileCoreHistoryError("HISTORY_LIMIT_EXCEEDED", "history entry exceeds retained history limits", {
          retained_entry_count: head.retained_entry_count,
          retained_entry_bytes: head.retained_entry_bytes,
          max_entries: head.max_entries,
          max_bytes: head.max_bytes,
        });
      }
      const sequence = head.produced_through + 1;
      const nextRevision = this.#nextRevision(head.head_revision);
      const entry = this.#entryRecord({
        sequence,
        producerEntryId: input.producerEntryId,
        entryText: Buffer.from(bytes).toString("utf8"),
        entryDigest: digest,
        entryBytes: bytes.length,
        headRevision: nextRevision,
      });
      const insert = this.#connection.prepare(
        `INSERT INTO filecore_history_entries
         (history_id, sequence, producer_epoch, producer_entry_id, entry_jcs, entry_digest, entry_bytes, head_revision, record_jcs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const result = insert.run(
        FILECORE_GLOBAL_HISTORY_ID,
        sequence,
        this.#producerEpoch,
        input.producerEntryId,
        Buffer.from(bytes),
        digest,
        bytes.length,
        nextRevision,
        Buffer.from(canonicalBytes(entry)),
      );
      if (result.changes !== 1) throw new FileCoreHistoryError("HISTORY_CORRUPT", "history entry insert changed an unexpected row count");
      this.#writeHead({
        ...head,
        head_revision: nextRevision,
        next_sequence: sequence + 1,
        produced_through: sequence,
        retained_entry_count: head.retained_entry_count + 1,
        retained_entry_bytes: head.retained_entry_bytes + bytes.length,
      });
      return entry;
    });
  }

  publishCheckpoint(input: FileCoreHistoryCheckpointInput): FileCoreHistoryCheckpoint {
    assertSafeInteger(input.producerRevision, "producerRevision", 1);
    assertSafeInteger(input.deleteThrough, "deleteThrough", 0);
    assertTimestamp(input.issuedAt, "issuedAt");
    assertSafeInteger(input.expectedHeadRevision, "expectedHeadRevision", 1);
    if (input.evidenceDigest !== undefined) assertDigest(input.evidenceDigest, "evidenceDigest");
    return this.#transaction(() => {
      const head = this.#readHead();
      this.#assertProducer(head);
      this.#assertExpectedHead(head, input.expectedHeadRevision);
      const current = this.#readCheckpoint(head);
      if (input.deleteThrough < current.delete_through) {
        throw new FileCoreHistoryError(
          "HISTORY_CHECKPOINT_REGRESSION",
          "delete_through cannot decrease across checkpoint versions",
        );
      }
      if (input.deleteThrough > head.produced_through) {
        throw new FileCoreHistoryError(
          "HISTORY_CHECKPOINT_INVALID",
          "delete_through cannot pass produced_through",
        );
      }
      const version = this.#nextRevision(current.checkpoint_version);
      const checkpoint = this.#checkpointRecord({
        checkpointVersion: version,
        producerRevision: input.producerRevision,
        deleteThrough: input.deleteThrough,
        issuedAt: input.issuedAt,
        evidenceDigest: input.evidenceDigest ?? NULL_DIGEST,
      });
      const nextHead = { ...head, head_revision: this.#nextRevision(head.head_revision) };
      this.#writeCheckpoint(checkpoint);
      this.#writeHead(nextHead);
      return checkpoint;
    });
  }

  deleteEligible(input: FileCoreHistoryDeleteInput): FileCoreHistoryDeleteResult {
    assertSafeInteger(input.checkpointVersion, "checkpointVersion", 0);
    assertDigest(input.checkpointDigest, "checkpointDigest");
    assertIdentifier(input.producerEpoch, "producerEpoch");
    assertSafeInteger(input.expectedHeadRevision, "expectedHeadRevision", 1);
    return this.#transaction(() => {
      const head = this.#readHead();
      this.#assertProducer(head);
      this.#assertExpectedHead(head, input.expectedHeadRevision);
      const checkpoint = this.#readCheckpoint(head);
      if (
        checkpoint.checkpoint_version !== input.checkpointVersion ||
        checkpoint.checkpoint_digest !== input.checkpointDigest ||
        checkpoint.producer_epoch !== input.producerEpoch
      ) {
        throw new FileCoreHistoryError("HISTORY_CHECKPOINT_STALE", "delete request does not name the current checkpoint");
      }
      const deleteThrough = checkpoint.delete_through;
      const rows = this.#connection.prepare(
        `SELECT sequence, entry_bytes FROM filecore_history_entries
         WHERE history_id = ? AND sequence <= ? ORDER BY sequence ASC`,
      ).all(FILECORE_GLOBAL_HISTORY_ID, deleteThrough);
      let deletedBytes = 0;
      for (const row of rows) {
        assertSafeInteger(Number(row.sequence), "entry.sequence", 1);
        assertSafeInteger(Number(row.entry_bytes), "entry.entry_bytes", 0);
        deletedBytes += Number(row.entry_bytes);
      }
      if (rows.length === 0) {
        return {
          head_revision: head.head_revision,
          retained_from: head.retained_from,
          produced_through: head.produced_through,
          deleted_through: deleteThrough,
          deleted_count: 0,
          deleted_bytes: 0,
        };
      }
      const deleted = this.#connection.prepare(
        "DELETE FROM filecore_history_entries WHERE history_id = ? AND sequence <= ?",
      ).run(FILECORE_GLOBAL_HISTORY_ID, deleteThrough);
      if (deleted.changes !== rows.length) throw new FileCoreHistoryError("HISTORY_CORRUPT", "history delete changed an unexpected row count");
      const nextRevision = this.#nextRevision(head.head_revision);
      const nextHead = {
        ...head,
        head_revision: nextRevision,
        retained_from: Math.max(head.retained_from, deleteThrough + 1),
        retained_entry_count: head.retained_entry_count - rows.length,
        retained_entry_bytes: head.retained_entry_bytes - deletedBytes,
      };
      this.#writeHead(nextHead);
      return {
        head_revision: nextRevision,
        retained_from: nextHead.retained_from,
        produced_through: nextHead.produced_through,
        deleted_through: deleteThrough,
        deleted_count: rows.length,
        deleted_bytes: deletedBytes,
      };
    });
  }

  registerReader(readerId: string): FileCoreHistoryReader {
    assertIdentifier(readerId, "readerId");
    return this.#transaction(() => {
      const head = this.#readHead();
      const existing = this.#connection.prepare(
        "SELECT * FROM filecore_history_readers WHERE history_id = ? AND reader_id = ?",
      ).get(FILECORE_GLOBAL_HISTORY_ID, readerId);
      if (existing !== undefined) return this.#decodeReaderRow(existing);
      const count = Number(this.#connection.prepare(
        "SELECT COUNT(*) AS count FROM filecore_history_readers WHERE history_id = ?",
      ).get(FILECORE_GLOBAL_HISTORY_ID)?.count ?? 0);
      if (!isSafeInteger(count, 0) || count >= head.max_readers) {
        throw new FileCoreHistoryError("HISTORY_READER_LIMIT", "history reader slot limit is exhausted");
      }
      const reader = this.#readerRecord({ readerId, cursor: head.retained_from, readerRevision: 1 });
      const insert = this.#connection.prepare(
        `INSERT INTO filecore_history_readers
         (history_id, reader_id, cursor, reader_revision, cursor_digest, record_jcs)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const result = insert.run(
        FILECORE_GLOBAL_HISTORY_ID,
        readerId,
        reader.cursor,
        reader.reader_revision,
        reader.cursor_digest,
        Buffer.from(canonicalBytes(reader)),
      );
      if (result.changes !== 1) throw new FileCoreHistoryError("HISTORY_CORRUPT", "history reader insert changed an unexpected row count");
      return reader;
    });
  }

  read(input: FileCoreHistoryReadInput): FileCoreHistoryReadResult {
    assertIdentifier(input.readerId, "readerId");
    return this.#readTransaction(() => {
      const head = this.#readHead();
      const readerRow = this.#connection.prepare(
        "SELECT * FROM filecore_history_readers WHERE history_id = ? AND reader_id = ?",
      ).get(FILECORE_GLOBAL_HISTORY_ID, input.readerId);
      if (readerRow === undefined) {
        throw new FileCoreHistoryError("HISTORY_CORRUPT", "history reader is not registered");
      }
      const reader = this.#decodeReaderRow(readerRow);
      let cursor = reader.cursor;
      if (input.start === "from-head") cursor = head.retained_from;
      else if (input.start === "from-now") cursor = head.produced_through + 1;
      else if (input.start !== undefined) {
        assertSafeInteger(input.start.cursor, "cursor", 0);
        cursor = input.start.cursor;
      }
      if (cursor < head.retained_from) {
        throw new FileCoreHistoryError("HISTORY_GAP", "requested history precedes the retained floor", {
          retained_from: head.retained_from,
          produced_through: head.produced_through,
          head_revision: head.head_revision,
          checkpoint_digest: this.#readCheckpoint(head).checkpoint_digest,
        });
      }
      if (cursor > head.produced_through + 1) {
        throw new FileCoreHistoryError("HISTORY_CURSOR_AHEAD", "requested history cursor is ahead of the producer frontier");
      }
      const maxEntries = input.maxEntries ?? head.max_entries;
      const maxBytes = input.maxBytes ?? head.max_bytes;
      assertSafeInteger(maxEntries, "maxEntries", 1);
      assertSafeInteger(maxBytes, "maxBytes", 1);
      const rows = this.#connection.prepare(
        `SELECT * FROM filecore_history_entries
         WHERE history_id = ? AND sequence >= ? ORDER BY sequence ASC`,
      ).all(FILECORE_GLOBAL_HISTORY_ID, cursor);
      const entries: FileCoreHistoryEntry[] = [];
      let bytes = 0;
      for (const row of rows) {
        const entry = this.#decodeEntryRow(row);
        if (entries.length >= maxEntries || bytes + entry.entry_bytes > maxBytes) break;
        entries.push(entry);
        bytes += entry.entry_bytes;
      }
      return immutable({
        history_id: FILECORE_GLOBAL_HISTORY_ID,
        reader_id: input.readerId,
        cursor,
        next_cursor: cursor + entries.length,
        head_revision: head.head_revision,
        retained_from: head.retained_from,
        produced_through: head.produced_through,
        entries: Object.freeze(entries),
      });
    });
  }

  acknowledge(input: FileCoreHistoryAckInput): FileCoreHistoryReader {
    assertIdentifier(input.readerId, "readerId");
    assertSafeInteger(input.cursor, "cursor", 0);
    assertSafeInteger(input.expectedReaderRevision, "expectedReaderRevision", 1);
    return this.#transaction(() => {
      const head = this.#readHead();
      const row = this.#connection.prepare(
        "SELECT * FROM filecore_history_readers WHERE history_id = ? AND reader_id = ?",
      ).get(FILECORE_GLOBAL_HISTORY_ID, input.readerId);
      if (row === undefined) throw new FileCoreHistoryError("HISTORY_CORRUPT", "history reader is not registered");
      const current = this.#decodeReaderRow(row);
      if (current.reader_revision !== input.expectedReaderRevision) {
        throw new FileCoreHistoryError("HISTORY_READER_REVISION_CONFLICT", "reader revision is stale");
      }
      if (input.cursor > head.produced_through + 1) {
        throw new FileCoreHistoryError("HISTORY_CURSOR_AHEAD", "acknowledged cursor is ahead of the producer frontier");
      }
      if (input.cursor < current.cursor) {
        throw new FileCoreHistoryError("HISTORY_CURSOR_REGRESSION", "reader cursor cannot move backwards");
      }
      if (input.cursor === current.cursor) return current;
      const next = this.#readerRecord({
        readerId: current.reader_id,
        cursor: input.cursor,
        readerRevision: this.#nextRevision(current.reader_revision),
      });
      const update = this.#connection.prepare(
        `UPDATE filecore_history_readers
         SET cursor = ?, reader_revision = ?, cursor_digest = ?, record_jcs = ?
         WHERE history_id = ? AND reader_id = ? AND reader_revision = ?`,
      );
      const result = update.run(
        next.cursor,
        next.reader_revision,
        next.cursor_digest,
        Buffer.from(canonicalBytes(next)),
        FILECORE_GLOBAL_HISTORY_ID,
        current.reader_id,
        current.reader_revision,
      );
      if (result.changes !== 1) throw new FileCoreHistoryError("HISTORY_CORRUPT", "history reader update changed an unexpected row count");
      return next;
    });
  }

  #openExisting(options: FileCoreHistoryOptions): void {
    this.#connection.exec(HISTORY_SCHEMA_SQL);
    const row = this.#connection.prepare(
      "SELECT record_jcs FROM filecore_history_head WHERE singleton = 1",
    ).get();
    if (row === undefined) {
      throw new FileCoreHistoryError("HISTORY_MIGRATION_REQUIRED", "FileCore history has not been migrated");
    }
    const head = this.#readHead();
    if (options.legacySourceDigest !== undefined && head.legacy_source_digest !== options.legacySourceDigest) {
      throw new FileCoreHistoryError("HISTORY_MIGRATION_REQUIRED", "history migration source digest does not match");
    }
    if (
      head.max_entries !== options.maxEntries ||
      head.max_bytes !== options.maxBytes ||
      head.max_readers !== options.maxReaders
    ) {
      throw new FileCoreHistoryError("HISTORY_MIGRATION_REQUIRED", "history limits do not match the persisted policy");
    }
    this.#producerId = head.producer_id;
    this.#producerEpoch = head.producer_epoch;
    this.#verifyAll(head);
  }

  #openOrInitialize(options: FileCoreHistoryMigrationOptions): void {
    assertIdentifier(options.producerId, "producerId");
    assertIdentifier(options.producerEpoch, "producerEpoch");
    assertDigest(options.legacySourceDigest, "legacySourceDigest");
    this.#producerId = options.producerId;
    this.#producerEpoch = options.producerEpoch;
    this.#connection.exec(HISTORY_SCHEMA_SQL);
    const row = this.#connection.prepare(
      "SELECT record_jcs FROM filecore_history_head WHERE singleton = 1",
    ).get();
    if (row === undefined) {
      const head = this.#headRecord({
        producerId: options.producerId,
        producerEpoch: options.producerEpoch,
        headRevision: 1,
        nextSequence: 1,
        retainedFrom: 1,
        producedThrough: 0,
        retainedEntryCount: 0,
        retainedEntryBytes: 0,
        maxEntries: options.maxEntries,
        maxBytes: options.maxBytes,
        maxReaders: options.maxReaders,
        legacySourceDigest: options.legacySourceDigest,
      });
      const checkpoint = this.#checkpointRecord({
        checkpointVersion: 0,
        producerRevision: 0,
        deleteThrough: 0,
        issuedAt: this.#now(),
        evidenceDigest: NULL_DIGEST,
      });
      this.#connection.prepare(
        `INSERT INTO filecore_history_head
         (singleton, history_id, producer_id, producer_epoch, head_revision, next_sequence,
          retained_from, produced_through, retained_entry_count, retained_entry_bytes,
          max_entries, max_bytes, max_readers, legacy_source_digest, head_digest, record_jcs)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        FILECORE_GLOBAL_HISTORY_ID,
        head.producer_id,
        head.producer_epoch,
        head.head_revision,
        head.next_sequence,
        head.retained_from,
        head.produced_through,
        head.retained_entry_count,
        head.retained_entry_bytes,
        head.max_entries,
        head.max_bytes,
        head.max_readers,
        head.legacy_source_digest,
        head.head_digest,
        Buffer.from(canonicalBytes(head)),
      );
      this.#connection.prepare(
        `INSERT INTO filecore_history_checkpoint
         (singleton, history_id, checkpoint_version, producer_id, producer_epoch,
          producer_revision, delete_through, issued_at, evidence_digest, checkpoint_digest, record_jcs)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        FILECORE_GLOBAL_HISTORY_ID,
        checkpoint.checkpoint_version,
        checkpoint.producer_id,
        checkpoint.producer_epoch,
        checkpoint.producer_revision,
        checkpoint.delete_through,
        checkpoint.issued_at,
        checkpoint.evidence_digest,
        checkpoint.checkpoint_digest,
        Buffer.from(canonicalBytes(checkpoint)),
      );
      return;
    }
    const head = this.#readHead();
    if (head.legacy_source_digest !== options.legacySourceDigest) {
      throw new FileCoreHistoryError("HISTORY_MIGRATION_REQUIRED", "history migration source digest does not match");
    }
    if (
      head.max_entries !== options.maxEntries ||
      head.max_bytes !== options.maxBytes ||
      head.max_readers !== options.maxReaders
    ) {
      throw new FileCoreHistoryError("HISTORY_MIGRATION_REQUIRED", "history limits do not match the persisted policy");
    }
    this.#verifyAll(head);
  }

  #assertProducer(head: FileCoreHistoryHead): void {
    this.#producerCapability.assertValid();
    if (head.producer_id !== this.#producerId || head.producer_epoch !== this.#producerEpoch) {
      throw new FileCoreHistoryError("HISTORY_PRODUCER_FENCED", "history producer identity or epoch is stale");
    }
  }

  #assertExpectedHead(head: FileCoreHistoryHead, expected: number): void {
    if (head.head_revision !== expected) {
      throw new FileCoreHistoryError("HISTORY_REVISION_CONFLICT", "history head revision is stale", {
        expected,
        actual: head.head_revision,
      });
    }
  }

  #nextRevision(current: number): number {
    if (!isSafeInteger(current, 0) || current >= MAX_SAFE) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history revision space is exhausted");
    }
    return current + 1;
  }

  #headRecord(input: {
    producerId: string;
    producerEpoch: string;
    headRevision: number;
    nextSequence: number;
    retainedFrom: number;
    producedThrough: number;
    retainedEntryCount: number;
    retainedEntryBytes: number;
    maxEntries: number;
    maxBytes: number;
    maxReaders: number;
    legacySourceDigest: string;
  }): FileCoreHistoryHead {
    const record = {
      schema: "dolly.filecore-history-head/v1" as const,
      history_id: FILECORE_GLOBAL_HISTORY_ID,
      producer_id: input.producerId,
      producer_epoch: input.producerEpoch,
      head_revision: input.headRevision,
      next_sequence: input.nextSequence,
      retained_from: input.retainedFrom,
      produced_through: input.producedThrough,
      retained_entry_count: input.retainedEntryCount,
      retained_entry_bytes: input.retainedEntryBytes,
      max_entries: input.maxEntries,
      max_bytes: input.maxBytes,
      max_readers: input.maxReaders,
      legacy_source_digest: input.legacySourceDigest,
      head_digest: "",
    };
    return immutable({ ...record, head_digest: digestWithoutField(record, "head_digest") });
  }

  #entryRecord(input: {
    sequence: number;
    producerEntryId: string;
    entryText: string;
    entryDigest: string;
    entryBytes: number;
    headRevision: number;
  }): FileCoreHistoryEntry {
    const record = {
      schema: "dolly.filecore-history-entry/v1" as const,
      history_id: FILECORE_GLOBAL_HISTORY_ID,
      sequence: input.sequence,
      producer_epoch: this.#producerEpoch,
      producer_entry_id: input.producerEntryId,
      entry_jcs: input.entryText,
      entry_digest: input.entryDigest,
      entry_bytes: input.entryBytes,
      head_revision: input.headRevision,
    };
    return immutable(record);
  }

  #checkpointRecord(input: {
    checkpointVersion: number;
    producerRevision: number;
    deleteThrough: number;
    issuedAt: string;
    evidenceDigest: string;
  }): FileCoreHistoryCheckpoint {
    const record = {
      schema: "dolly.filecore-history-checkpoint/v1" as const,
      history_id: FILECORE_GLOBAL_HISTORY_ID,
      checkpoint_version: input.checkpointVersion,
      producer_id: this.#producerId,
      producer_epoch: this.#producerEpoch,
      producer_revision: input.producerRevision,
      delete_through: input.deleteThrough,
      issued_at: input.issuedAt,
      evidence_digest: input.evidenceDigest,
      checkpoint_digest: "",
    };
    return immutable({ ...record, checkpoint_digest: digestWithoutField(record, "checkpoint_digest") });
  }

  #readerRecord(input: { readerId: string; cursor: number; readerRevision: number }): FileCoreHistoryReader {
    const record = {
      schema: "dolly.filecore-history-reader/v1" as const,
      history_id: FILECORE_GLOBAL_HISTORY_ID,
      reader_id: input.readerId,
      cursor: input.cursor,
      reader_revision: input.readerRevision,
      cursor_digest: "",
    };
    return immutable({ ...record, cursor_digest: digestWithoutField(record, "cursor_digest") });
  }

  #readHead(): FileCoreHistoryHead {
    const row = this.#connection.prepare(
      "SELECT * FROM filecore_history_head WHERE singleton = 1",
    ).get();
    if (row === undefined) throw new FileCoreHistoryError("HISTORY_MIGRATION_REQUIRED", "global history has not been initialized");
    const record = decodeRecord(row.record_jcs, "history head");
    assertClosedRecord(record, HEAD_KEYS, "history head");
    const head = record as unknown as FileCoreHistoryHead;
    if (head.schema !== "dolly.filecore-history-head/v1" || head.history_id !== FILECORE_GLOBAL_HISTORY_ID) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history head schema or identity is invalid");
    }
    assertIdentifier(head.producer_id, "history head producer_id");
    assertIdentifier(head.producer_epoch, "history head producer_epoch");
    assertDigest(head.legacy_source_digest, "history head legacy_source_digest");
    assertDigest(head.head_digest, "history head head_digest");
    for (const [label, value, minimum] of [
      ["head_revision", head.head_revision, 1],
      ["next_sequence", head.next_sequence, 1],
      ["retained_from", head.retained_from, 1],
      ["produced_through", head.produced_through, 0],
      ["retained_entry_count", head.retained_entry_count, 0],
      ["retained_entry_bytes", head.retained_entry_bytes, 0],
      ["max_entries", head.max_entries, 1],
      ["max_bytes", head.max_bytes, 1],
      ["max_readers", head.max_readers, 1],
    ] as const) assertSafeInteger(value, `history head ${label}`, minimum);
    if (
      head.next_sequence !== head.produced_through + 1 ||
      head.retained_from > head.next_sequence ||
      head.retained_entry_count > head.max_entries ||
      head.retained_entry_bytes > head.max_bytes ||
      digestWithoutField(record, "head_digest") !== head.head_digest
    ) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history head invariants or digest are invalid");
    }
    for (const key of [
      "history_id",
      "producer_id",
      "producer_epoch",
      "head_revision",
      "next_sequence",
      "retained_from",
      "produced_through",
      "retained_entry_count",
      "retained_entry_bytes",
      "max_entries",
      "max_bytes",
      "max_readers",
      "legacy_source_digest",
      "head_digest",
    ] as const) {
      if (String(row[key]) !== String(head[key])) {
        throw new FileCoreHistoryError("HISTORY_CORRUPT", `history head projection ${key} disagrees with canonical bytes`);
      }
    }
    return head;
  }

  #readCheckpoint(_head: FileCoreHistoryHead): FileCoreHistoryCheckpoint {
    const row = this.#connection.prepare(
      "SELECT * FROM filecore_history_checkpoint WHERE singleton = 1",
    ).get();
    if (row === undefined) throw new FileCoreHistoryError("HISTORY_CORRUPT", "history checkpoint is missing");
    const record = decodeRecord(row.record_jcs, "history checkpoint");
    assertClosedRecord(record, CHECKPOINT_KEYS, "history checkpoint");
    const checkpoint = record as unknown as FileCoreHistoryCheckpoint;
    if (checkpoint.schema !== "dolly.filecore-history-checkpoint/v1" || checkpoint.history_id !== FILECORE_GLOBAL_HISTORY_ID) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history checkpoint schema or identity is invalid");
    }
    assertIdentifier(checkpoint.producer_id, "history checkpoint producer_id");
    assertIdentifier(checkpoint.producer_epoch, "history checkpoint producer_epoch");
    assertDigest(checkpoint.evidence_digest, "history checkpoint evidence_digest");
    assertDigest(checkpoint.checkpoint_digest, "history checkpoint checkpoint_digest");
    assertTimestamp(checkpoint.issued_at, "history checkpoint issued_at");
    assertSafeInteger(checkpoint.checkpoint_version, "history checkpoint checkpoint_version", 0);
    assertSafeInteger(checkpoint.producer_revision, "history checkpoint producer_revision", 0);
    assertSafeInteger(checkpoint.delete_through, "history checkpoint delete_through", 0);
    if (digestWithoutField(record, "checkpoint_digest") !== checkpoint.checkpoint_digest) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history checkpoint digest is invalid");
    }
    for (const key of [
      "history_id",
      "checkpoint_version",
      "producer_id",
      "producer_epoch",
      "producer_revision",
      "delete_through",
      "issued_at",
      "evidence_digest",
      "checkpoint_digest",
    ] as const) {
      if (String(row[key]) !== String(checkpoint[key])) {
        throw new FileCoreHistoryError("HISTORY_CORRUPT", `history checkpoint projection ${key} disagrees with canonical bytes`);
      }
    }
    return checkpoint;
  }

  #decodeEntry(raw: unknown): FileCoreHistoryEntry {
    const record = decodeRecord(raw, "history entry");
    assertClosedRecord(record, ENTRY_KEYS, "history entry");
    const entry = record as unknown as FileCoreHistoryEntry;
    if (entry.schema !== "dolly.filecore-history-entry/v1" || entry.history_id !== FILECORE_GLOBAL_HISTORY_ID) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history entry schema or identity is invalid");
    }
    assertSafeInteger(entry.sequence, "history entry sequence", 1);
    assertIdentifier(entry.producer_epoch, "history entry producer_epoch");
    assertIdentifier(entry.producer_entry_id, "history entry producer_entry_id");
    assertDigest(entry.entry_digest, "history entry entry_digest");
    assertSafeInteger(entry.entry_bytes, "history entry entry_bytes", 0);
    assertSafeInteger(entry.head_revision, "history entry head_revision", 1);
    if (typeof entry.entry_jcs !== "string") throw new FileCoreHistoryError("HISTORY_CORRUPT", "history entry entry_jcs is not text");
    let entryValue: JsonValue;
    try {
      entryValue = parseCanonicalJsonBytes(Buffer.from(entry.entry_jcs, "utf8"));
    } catch {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history entry entry_jcs is not canonical JSON");
    }
    const bytes = bytesFrom(entryValue);
    if (
      Buffer.from(bytes).toString("utf8") !== entry.entry_jcs ||
      bytes.length !== entry.entry_bytes ||
      canonicalJsonDigest(entryValue) !== entry.entry_digest
    ) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history entry bytes or digest are invalid");
    }
    return immutable({ ...entry });
  }

  #decodeEntryRow(row: Record<string, unknown>): FileCoreHistoryEntry {
    const entry = this.#decodeEntry(row.record_jcs);
    if (
      String(row.history_id) !== entry.history_id ||
      Number(row.sequence) !== entry.sequence ||
      String(row.producer_epoch) !== entry.producer_epoch ||
      String(row.producer_entry_id) !== entry.producer_entry_id ||
      String(row.entry_digest) !== entry.entry_digest ||
      Number(row.entry_bytes) !== entry.entry_bytes ||
      Number(row.head_revision) !== entry.head_revision ||
      !sameBytes(toBytes(row.entry_jcs, "history entry entry_jcs"), Buffer.from(entry.entry_jcs, "utf8"))
    ) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history entry projection disagrees with its canonical record");
    }
    return entry;
  }

  #decodeReaderRow(row: Record<string, unknown>): FileCoreHistoryReader {
    const reader = this.#decodeReader(row.record_jcs);
    if (
      String(row.history_id) !== reader.history_id ||
      String(row.reader_id) !== reader.reader_id ||
      Number(row.cursor) !== reader.cursor ||
      Number(row.reader_revision) !== reader.reader_revision ||
      String(row.cursor_digest) !== reader.cursor_digest
    ) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history reader projection disagrees with its canonical record");
    }
    return reader;
  }

  #decodeReader(value: unknown): FileCoreHistoryReader {
    const record = decodeRecord(value, "history reader");
    assertClosedRecord(record, READER_KEYS, "history reader");
    const reader = record as unknown as FileCoreHistoryReader;
    if (reader.schema !== "dolly.filecore-history-reader/v1" || reader.history_id !== FILECORE_GLOBAL_HISTORY_ID) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history reader schema or identity is invalid");
    }
    assertIdentifier(reader.reader_id, "history reader reader_id");
    assertSafeInteger(reader.cursor, "history reader cursor", 0);
    assertSafeInteger(reader.reader_revision, "history reader reader_revision", 1);
    assertDigest(reader.cursor_digest, "history reader cursor_digest");
    if (digestWithoutField(record, "cursor_digest") !== reader.cursor_digest) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history reader digest is invalid");
    }
    return immutable({ ...reader });
  }

  #writeHead(head: FileCoreHistoryHead): void {
    const record = this.#headRecord({
      producerId: head.producer_id,
      producerEpoch: head.producer_epoch,
      headRevision: head.head_revision,
      nextSequence: head.next_sequence,
      retainedFrom: head.retained_from,
      producedThrough: head.produced_through,
      retainedEntryCount: head.retained_entry_count,
      retainedEntryBytes: head.retained_entry_bytes,
      maxEntries: head.max_entries,
      maxBytes: head.max_bytes,
      maxReaders: head.max_readers,
      legacySourceDigest: head.legacy_source_digest,
    });
    const update = this.#connection.prepare(
      `UPDATE filecore_history_head SET
       history_id = ?, producer_id = ?, producer_epoch = ?, head_revision = ?, next_sequence = ?,
       retained_from = ?, produced_through = ?, retained_entry_count = ?, retained_entry_bytes = ?,
       max_entries = ?, max_bytes = ?, max_readers = ?, legacy_source_digest = ?, head_digest = ?, record_jcs = ?
       WHERE singleton = 1`,
    );
    const result = update.run(
      record.history_id,
      record.producer_id,
      record.producer_epoch,
      record.head_revision,
      record.next_sequence,
      record.retained_from,
      record.produced_through,
      record.retained_entry_count,
      record.retained_entry_bytes,
      record.max_entries,
      record.max_bytes,
      record.max_readers,
      record.legacy_source_digest,
      record.head_digest,
      Buffer.from(canonicalBytes(record)),
    );
    if (result.changes !== 1) throw new FileCoreHistoryError("HISTORY_CORRUPT", "history head update changed an unexpected row count");
  }

  #writeCheckpoint(checkpoint: FileCoreHistoryCheckpoint): void {
    const update = this.#connection.prepare(
      `UPDATE filecore_history_checkpoint SET
       history_id = ?, checkpoint_version = ?, producer_id = ?, producer_epoch = ?, producer_revision = ?,
       delete_through = ?, issued_at = ?, evidence_digest = ?, checkpoint_digest = ?, record_jcs = ?
       WHERE singleton = 1`,
    );
    const result = update.run(
      checkpoint.history_id,
      checkpoint.checkpoint_version,
      checkpoint.producer_id,
      checkpoint.producer_epoch,
      checkpoint.producer_revision,
      checkpoint.delete_through,
      checkpoint.issued_at,
      checkpoint.evidence_digest,
      checkpoint.checkpoint_digest,
      Buffer.from(canonicalBytes(checkpoint)),
    );
    if (result.changes !== 1) throw new FileCoreHistoryError("HISTORY_CORRUPT", "history checkpoint update changed an unexpected row count");
  }

  #verifyAll(head: FileCoreHistoryHead): void {
    const checkpoint = this.#readCheckpoint(head);
    if (
      checkpoint.producer_id !== head.producer_id ||
      checkpoint.producer_epoch !== head.producer_epoch ||
      checkpoint.delete_through > head.produced_through
    ) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history checkpoint does not match the producer head");
    }
    const rows = this.#connection.prepare(
      `SELECT * FROM filecore_history_entries WHERE history_id = ? ORDER BY sequence ASC`,
    ).all(FILECORE_GLOBAL_HISTORY_ID);
    let expected = head.retained_from;
    let bytes = 0;
    for (const row of rows) {
      const entry = this.#decodeEntryRow(row);
      if (
        entry.sequence !== expected ||
        entry.producer_epoch !== head.producer_epoch ||
        String(row.producer_epoch) !== entry.producer_epoch ||
        String(row.producer_entry_id) !== entry.producer_entry_id ||
        String(row.entry_digest) !== entry.entry_digest ||
        Number(row.entry_bytes) !== entry.entry_bytes ||
        Number(row.head_revision) !== entry.head_revision ||
        !sameBytes(toBytes(row.entry_jcs, "history entry entry_jcs"), Buffer.from(entry.entry_jcs, "utf8"))
      ) {
        throw new FileCoreHistoryError("HISTORY_CORRUPT", "history entry projection or sequence is invalid");
      }
      expected += 1;
      bytes += entry.entry_bytes;
    }
    if (
      rows.length !== head.retained_entry_count ||
      bytes !== head.retained_entry_bytes ||
      expected !== head.produced_through + 1
    ) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history head retained counts do not match entries");
    }
    const readerRows = this.#connection.prepare(
      "SELECT * FROM filecore_history_readers WHERE history_id = ?",
    ).all(FILECORE_GLOBAL_HISTORY_ID);
    if (readerRows.length > head.max_readers) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history reader count exceeds max_readers");
    }
    for (const row of readerRows) this.#decodeReaderRow(row);
  }

  #transaction<T>(operation: () => T): T {
    if (!this.#connection.open) throw new FileCoreHistoryError("HISTORY_CORRUPT", "history database is closed");
    if (!this.#lock.held) throw new FileCoreHistoryError("HISTORY_LOCK_NOT_HELD", "history writes require the controller lock");
    try {
      this.#lock.assertHeld();
      this.#connection.prepare("BEGIN IMMEDIATE").run();
    } catch (error) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history transaction could not begin", { cause: error });
    }
    let result: T;
    try {
      result = operation();
    } catch (error) {
      try {
        this.#connection.prepare("ROLLBACK").run();
      } catch (rollbackError) {
        throw new FileCoreHistoryError("HISTORY_COMMIT_UNKNOWN", "history rollback outcome is unknown", { cause: rollbackError });
      }
      if (error instanceof FileCoreHistoryError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new FileCoreHistoryError("HISTORY_CORRUPT", `history transaction failed: ${message}`, { cause: error });
    }
    try {
      this.#connection.prepare("COMMIT").run();
    } catch (error) {
      throw new FileCoreHistoryError("HISTORY_COMMIT_UNKNOWN", "history commit outcome is unknown; reopen before retry", { cause: error });
    }
    return result;
  }

  #readTransaction<T>(operation: () => T): T {
    if (!this.#connection.open) throw new FileCoreHistoryError("HISTORY_CORRUPT", "history database is closed");
    if (!this.#lock.held) throw new FileCoreHistoryError("HISTORY_LOCK_NOT_HELD", "history reads require the controller lock");
    try {
      this.#lock.assertHeld();
      this.#connection.prepare("BEGIN").run();
    } catch (error) {
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history read transaction could not begin", { cause: error });
    }
    let result: T;
    try {
      result = operation();
    } catch (error) {
      try {
        this.#connection.prepare("ROLLBACK").run();
      } catch (rollbackError) {
        throw new FileCoreHistoryError("HISTORY_COMMIT_UNKNOWN", "history read rollback outcome is unknown", { cause: rollbackError });
    }
      if (error instanceof FileCoreHistoryError) throw error;
      throw new FileCoreHistoryError("HISTORY_CORRUPT", "history read transaction failed", { cause: error });
    }
    try {
      this.#connection.prepare("COMMIT").run();
    } catch (error) {
      throw new FileCoreHistoryError("HISTORY_COMMIT_UNKNOWN", "history read commit outcome is unknown; reopen before retry", { cause: error });
    }
    return result;
  }
}

export class FileCoreHistoryReaderStore {
  readonly #store: FileCoreHistoryStore;

  private constructor(store: FileCoreHistoryStore) {
    this.#store = store;
  }

  /** @internal RuntimeAuthorityDatabase-only reader facade factory. */
  static fromProducer(store: FileCoreHistoryStore): FileCoreHistoryReaderStore {
    return new FileCoreHistoryReaderStore(store);
  }

  get identity(): RuntimeAuthorityIdentity {
    return this.#store.identity;
  }

  get head(): FileCoreHistoryHead {
    return this.#store.head;
  }

  get checkpoint(): FileCoreHistoryCheckpoint {
    return this.#store.checkpoint;
  }

  registerReader(readerId: string): FileCoreHistoryReader {
    return this.#store.registerReader(readerId);
  }

  read(input: FileCoreHistoryReadInput): FileCoreHistoryReadResult {
    return this.#store.read(input);
  }

  acknowledge(input: FileCoreHistoryAckInput): FileCoreHistoryReader {
    return this.#store.acknowledge(input);
  }
}
