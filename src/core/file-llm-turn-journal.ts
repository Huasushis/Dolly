import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertJsonValue,
  canonicalizeJson,
  isJsonObject,
  type JsonValue,
} from "./canonical-json.js";
import { parseStrictJsonBytes } from "./strict-json.js";
import {
  assertApprovalDecisionInput,
  assertApprovalDecisionRecord,
  assertLLMTurnJournalEntry,
  assertPreparedTurnInput,
  assertPreparedTurnRecord,
  immutableLLMTurnJournalEntry,
  LLMTurnJournalError,
  type ApprovalDecisionInput,
  type ApprovalDecisionRecord,
  type LLMTurnJournal,
  type LLMTurnJournalEntry,
  type LLMTurnJournalRotation,
  type PreparedTurnInput,
  type PreparedTurnRecord,
} from "./llm-turn-journal.js";
import {
  SynchronousCrossProcessLockError,
  withSynchronousCrossProcessLock,
} from "./synchronous-cross-process-lock.js";

interface LLMTurnJournalDocument {
  readonly schemaVersion: "dolly.llm-turn-journal/2";
  /** Number of completed rotations; also the deterministic archive segment index. */
  readonly rotation: number;
  /** Number of entries appended since the last rotation (equals entries.length). */
  readonly sequence: number;
  readonly entries: readonly LLMTurnJournalEntry[];
}

export interface FileLLMTurnJournalOptions {
  /** Journal file path inside an instance state directory. */
  readonly path: string;
  /** Byte limit guarding the active journal (also the truncate guard). */
  readonly maxBytes?: number;
  /** Injectable clock returning canonical UTC timestamps for appended entries. */
  readonly now?: () => string;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_NOW = (): string => new Date().toISOString();
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function emptyDocument(): LLMTurnJournalDocument {
  return {
    schemaVersion: "dolly.llm-turn-journal/2",
    rotation: 0,
    sequence: 0,
    entries: [],
  };
}

function nextRotation(document: LLMTurnJournalDocument): number {
  if (!Number.isSafeInteger(document.rotation) || document.rotation >= Number.MAX_SAFE_INTEGER) {
    throw new LLMTurnJournalError(
      "LLM_TURN_JOURNAL_LIMIT_EXCEEDED",
      "Turn journal rotation space is exhausted",
    );
  }
  return document.rotation + 1;
}

function nextSequence(sequence: number): number {
  if (!Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER) {
    throw new LLMTurnJournalError(
      "LLM_TURN_JOURNAL_LIMIT_EXCEEDED",
      "Turn journal sequence space is exhausted",
    );
  }
  return sequence + 1;
}

/**
 * Crash-recoverable, append-only storage for prepared turns and approval
 * decisions. Each append durably rewrites the journal document atomically
 * (temporary file, fsync, rename, directory fsync) under a cross-process
 * lock, so a crash never leaves a partially committed entry. Reopening the
 * journal preserves every previously appended record; a corrupted file fails
 * closed instead of silently dropping history.
 */
export class FileLLMTurnJournal implements LLMTurnJournal {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #maxBytes: number;
  readonly #now: () => string;

  constructor(options: FileLLMTurnJournalOptions) {
    if (
      typeof options.path !== "string" ||
      options.path.length === 0 ||
      options.path.includes("\0")
    ) {
      throw new TypeError("Turn journal path must be a non-empty filesystem path");
    }
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1024) {
      throw new TypeError("Turn journal maxBytes must be at least 1024");
    }
    this.#now = options.now ?? DEFAULT_NOW;
    this.#path = resolve(options.path);
    this.#lockPath = `${this.#path}.lock`;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#withMutationLock(() => {
      if (existsSync(this.#path)) {
        void this.#readDocument();
      } else {
        this.#writeDocument(emptyDocument());
      }
    });
  }

  appendPreparedTurn(input: PreparedTurnInput): void {
    assertPreparedTurnInput(input);
    const record: PreparedTurnRecord = {
      ...input,
      kind: "prepared-turn",
      recordedAt: this.#stamp(),
    };
    assertPreparedTurnRecord(record);
    this.#append(record);
  }

  appendApprovalDecision(input: ApprovalDecisionInput): void {
    assertApprovalDecisionInput(input);
    const record: ApprovalDecisionRecord = {
      ...input,
      kind: "approval-decision",
      decidedAt: this.#stamp(),
    };
    assertApprovalDecisionRecord(record);
    this.#append(record);
  }

  list(): readonly LLMTurnJournalEntry[] {
    return this.#readDocument().entries;
  }

  rotate(): LLMTurnJournalRotation {
    return this.#withMutationLock(() => {
      const document = this.#readDocument();
      if (document.entries.length === 0) {
        return {
          rotated: false,
          archivedEntries: 0,
          archivePath: null,
          activeEntries: 0,
        };
      }
      const archivePath = join(
        dirname(this.#path),
        `${basename(this.#path)}.${document.rotation}.archive.json`,
      );
      // The archive is durably written before the active journal is reset, so
      // a crash between the two leaves every entry in at least one file.
      this.#writeDocumentAt(archivePath, document);
      this.#writeDocument({
        schemaVersion: "dolly.llm-turn-journal/2",
        rotation: nextRotation(document),
        sequence: 0,
        entries: [],
      });
      return {
        rotated: true,
        archivedEntries: document.entries.length,
        archivePath,
        activeEntries: 0,
      };
    });
  }

  #append(entry: LLMTurnJournalEntry): void {
    this.#withMutationLock(() => {
      const document = this.#readDocument();
      this.#writeDocument({
        ...document,
        sequence: nextSequence(document.sequence),
        entries: [...document.entries, immutableLLMTurnJournalEntry(entry)],
      });
    });
  }

  #stamp(): string {
    const timestamp = this.#now();
    if (typeof timestamp !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(timestamp)) {
      throw new LLMTurnJournalError(
        "LLM_TURN_JOURNAL_CLOCK_INVALID",
        "The injected turn journal clock must return canonical UTC timestamps",
      );
    }
    return timestamp;
  }

  #readDocument(): LLMTurnJournalDocument {
    let bytes: Buffer;
    try {
      if (lstatSync(this.#path).isSymbolicLink()) {
        throw new LLMTurnJournalError(
          "LLM_TURN_JOURNAL_IO_FAILED",
          "Turn journal file must not be a symbolic link",
        );
      }
      if (statSync(this.#path).size > this.#maxBytes) {
        throw new LLMTurnJournalError(
          "LLM_TURN_JOURNAL_LIMIT_EXCEEDED",
          "Turn journal exceeds its configured byte limit",
        );
      }
      bytes = readFileSync(this.#path);
    } catch (error) {
      if (error instanceof LLMTurnJournalError) throw error;
      throw new LLMTurnJournalError("LLM_TURN_JOURNAL_IO_FAILED", "Could not read the turn journal");
    }

    let value: JsonValue;
    try {
      value = parseStrictJsonBytes(bytes, { maxBytes: this.#maxBytes, maxDepth: 128 });
    } catch {
      throw new LLMTurnJournalError(
        "LLM_TURN_JOURNAL_DOCUMENT_INVALID",
        "Turn journal is not strict JSON data",
      );
    }
    if (!isJsonObject(value)) {
      throw new LLMTurnJournalError(
        "LLM_TURN_JOURNAL_DOCUMENT_INVALID",
        "Turn journal document must be an object",
      );
    }
    if (
      Object.keys(value).some(
        (key) => key !== "schemaVersion" && key !== "rotation" && key !== "sequence" && key !== "entries",
      ) ||
      value.schemaVersion !== "dolly.llm-turn-journal/2" ||
      typeof value.rotation !== "number" ||
      !Number.isSafeInteger(value.rotation) ||
      value.rotation < 0 ||
      typeof value.sequence !== "number" ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 ||
      !Array.isArray(value.entries) ||
      value.entries.length !== value.sequence
    ) {
      throw new LLMTurnJournalError(
        "LLM_TURN_JOURNAL_DOCUMENT_INVALID",
        "Turn journal document schema is invalid",
      );
    }

    const entries: LLMTurnJournalEntry[] = [];
    for (const candidate of value.entries) {
      try {
        assertLLMTurnJournalEntry(candidate);
        entries.push(immutableLLMTurnJournalEntry(candidate));
      } catch (error) {
        if (error instanceof LLMTurnJournalError) {
          throw new LLMTurnJournalError(
            "LLM_TURN_JOURNAL_DOCUMENT_INVALID",
            "Turn journal contains an invalid entry",
          );
        }
        throw error;
      }
    }
    return {
      schemaVersion: "dolly.llm-turn-journal/2",
      rotation: value.rotation,
      sequence: value.sequence,
      entries,
    };
  }

  #writeDocument(document: LLMTurnJournalDocument): void {
    this.#writeDocumentAt(this.#path, document);
  }

  #writeDocumentAt(path: string, document: LLMTurnJournalDocument): void {
    assertJsonValue(document);
    const payload = `${canonicalizeJson(document)}\n`;
    if (Buffer.byteLength(payload, "utf8") > this.#maxBytes) {
      throw new LLMTurnJournalError(
        "LLM_TURN_JOURNAL_LIMIT_EXCEEDED",
        "Turn journal update exceeds its configured byte limit",
      );
    }
    const parent = dirname(path);
    const temporaryPath = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, payload, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
      fsyncDirectory(parent);
    } catch (error) {
      if (error instanceof LLMTurnJournalError) throw error;
      throw new LLMTurnJournalError(
        "LLM_TURN_JOURNAL_IO_FAILED",
        "Atomic turn journal write failed",
      );
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the primary write result.
        }
      }
      if (existsSync(temporaryPath)) {
        try {
          unlinkSync(temporaryPath);
          fsyncDirectory(parent);
        } catch {
          // Same-directory temporary files are never committed state.
        }
      }
    }
  }

  #withMutationLock<T>(operation: () => T): T {
    try {
      return withSynchronousCrossProcessLock({ resourceId: this.#lockPath }, operation);
    } catch (error) {
      if (!(error instanceof SynchronousCrossProcessLockError)) throw error;
      throw new LLMTurnJournalError(
        error.code === "CROSS_PROCESS_LOCK_HELD"
          ? "LLM_TURN_JOURNAL_LOCKED"
          : "LLM_TURN_JOURNAL_IO_FAILED",
        error.code === "CROSS_PROCESS_LOCK_HELD"
          ? "Another writer owns the turn journal lock"
          : `Crash-recoverable turn journal locking failed: ${error.message}`,
      );
    }
  }
}