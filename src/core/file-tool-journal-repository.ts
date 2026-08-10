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
  cloneJson,
  deepFreeze,
  isJsonObject,
  type JsonValue,
} from "./canonical-json.js";
import { parseStrictJsonBytes } from "./strict-json.js";
import {
  assertToolRoundJournalRecord,
  assertToolRoundJournalTransition,
  ToolPolicyError,
  type ToolJournalRepository,
  type ToolRoundJournalRecord,
} from "./tool-policy.js";
import {
  SynchronousCrossProcessLockError,
  withSynchronousCrossProcessLock,
} from "./synchronous-cross-process-lock.js";

interface ToolJournalDocument {
  readonly schemaVersion: "dolly.tool-journal-repository/1";
  readonly revision: number;
  readonly rounds: readonly ToolRoundJournalRecord[];
}

export interface FileToolJournalRepositoryOptions {
  readonly path: string;
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function immutableRound(record: ToolRoundJournalRecord): ToolRoundJournalRecord {
  assertToolRoundJournalRecord(record);
  return deepFreeze(
    cloneJson(record as unknown as JsonValue) as unknown as ToolRoundJournalRecord,
  );
}

function compareRounds(left: ToolRoundJournalRecord, right: ToolRoundJournalRecord): number {
  if (left.moduleJobId !== right.moduleJobId) {
    return left.moduleJobId < right.moduleJobId ? -1 : 1;
  }
  return left.roundIndex - right.roundIndex;
}

function assertLookup(moduleJobId: string, roundIndex?: number): void {
  if (!ID_PATTERN.test(moduleJobId)) {
    throw new ToolPolicyError("TOOL_ROUND_INVALID", "Tool journal Module job ID is invalid");
  }
  if (roundIndex !== undefined && (!Number.isSafeInteger(roundIndex) || roundIndex <= 0)) {
    throw new ToolPolicyError("TOOL_ROUND_INVALID", "Tool journal round index is invalid");
  }
}

function nextRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) {
    throw new ToolPolicyError(
      "TOOL_JOURNAL_LIMIT_EXCEEDED",
      "Tool journal revision space is exhausted",
    );
  }
  return revision + 1;
}

/** Crash-recoverable, process-locked storage for tool call rounds. */
export class FileToolJournalRepository implements ToolJournalRepository {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #maxBytes: number;

  constructor(options: FileToolJournalRepositoryOptions) {
    if (typeof options.path !== "string" || options.path.length === 0 || options.path.includes("\0")) {
      throw new TypeError("Tool journal path must be a non-empty filesystem path");
    }
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1024) {
      throw new TypeError("Tool journal maxBytes must be at least 1024");
    }
    this.#path = resolve(options.path);
    this.#lockPath = `${this.#path}.lock`;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#withMutationLock(() => {
      if (existsSync(this.#path)) {
        void this.#readDocument();
      } else {
        this.#writeDocument({
          schemaVersion: "dolly.tool-journal-repository/1",
          revision: 0,
          rounds: [],
        });
      }
    });
  }

  reserveRound(record: ToolRoundJournalRecord): "created" | "already-exists" {
    assertToolRoundJournalRecord(record);
    if (record.revision !== 1 || record.state !== "reserved") {
      throw new ToolPolicyError("TOOL_JOURNAL_CONFLICT", "New tool round is invalid");
    }
    return this.#withMutationLock(() => {
      const document = this.#readDocument();
      if (document.rounds.some(
        (candidate) =>
          candidate.moduleJobId === record.moduleJobId &&
          candidate.roundIndex === record.roundIndex,
      )) {
        return "already-exists";
      }
      this.#writeDocument({
        ...document,
        revision: nextRevision(document.revision),
        rounds: [...document.rounds, immutableRound(record)].sort(compareRounds),
      });
      return "created";
    });
  }

  getRound(moduleJobId: string, roundIndex: number): ToolRoundJournalRecord | null {
    assertLookup(moduleJobId, roundIndex);
    return this.#readDocument().rounds.find(
      (record) => record.moduleJobId === moduleJobId && record.roundIndex === roundIndex,
    ) ?? null;
  }

  compareAndSet(
    moduleJobId: string,
    roundIndex: number,
    expectedRevision: number,
    next: ToolRoundJournalRecord,
  ): boolean {
    assertLookup(moduleJobId, roundIndex);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      throw new ToolPolicyError("TOOL_ROUND_INVALID", "Expected tool revision is invalid");
    }
    assertToolRoundJournalRecord(next);
    return this.#withMutationLock(() => {
      const document = this.#readDocument();
      const index = document.rounds.findIndex(
        (record) => record.moduleJobId === moduleJobId && record.roundIndex === roundIndex,
      );
      if (index < 0 || document.rounds[index]!.revision !== expectedRevision) return false;
      const current = document.rounds[index]!;
      assertToolRoundJournalTransition(current, next);
      const rounds = [...document.rounds];
      rounds[index] = immutableRound(next);
      this.#writeDocument({
        ...document,
        revision: nextRevision(document.revision),
        rounds,
      });
      return true;
    });
  }

  listRounds(moduleJobId: string): readonly ToolRoundJournalRecord[] {
    assertLookup(moduleJobId);
    return this.#readDocument().rounds.filter((round) => round.moduleJobId === moduleJobId);
  }

  #readDocument(): ToolJournalDocument {
    let bytes: Buffer;
    try {
      if (lstatSync(this.#path).isSymbolicLink()) {
        throw new ToolPolicyError(
          "TOOL_JOURNAL_IO_FAILED",
          "Tool journal file must not be a symbolic link",
        );
      }
      if (statSync(this.#path).size > this.#maxBytes) {
        throw new ToolPolicyError(
          "TOOL_JOURNAL_LIMIT_EXCEEDED",
          "Tool journal exceeds its configured byte limit",
        );
      }
      bytes = readFileSync(this.#path);
    } catch (error) {
      if (error instanceof ToolPolicyError) throw error;
      throw new ToolPolicyError("TOOL_JOURNAL_IO_FAILED", "Could not read the tool journal");
    }

    let value: JsonValue;
    try {
      value = parseStrictJsonBytes(bytes, { maxBytes: this.#maxBytes, maxDepth: 128 });
    } catch {
      throw new ToolPolicyError(
        "TOOL_JOURNAL_DOCUMENT_INVALID",
        "Tool journal is not strict JSON data",
      );
    }
    if (!isJsonObject(value)) {
      throw new ToolPolicyError(
        "TOOL_JOURNAL_DOCUMENT_INVALID",
        "Tool journal document must be an object",
      );
    }
    if (
      Object.keys(value).some(
        (key) => key !== "schemaVersion" && key !== "revision" && key !== "rounds",
      ) ||
      value.schemaVersion !== "dolly.tool-journal-repository/1" ||
      typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.rounds)
    ) {
      throw new ToolPolicyError(
        "TOOL_JOURNAL_DOCUMENT_INVALID",
        "Tool journal document schema is invalid",
      );
    }

    const rounds: ToolRoundJournalRecord[] = [];
    let previous: ToolRoundJournalRecord | undefined;
    for (const candidate of value.rounds) {
      try {
        assertToolRoundJournalRecord(candidate);
        const record = immutableRound(candidate);
        if (previous !== undefined && compareRounds(previous, record) >= 0) {
          throw new Error("rounds are duplicated or unsorted");
        }
        rounds.push(record);
        previous = record;
      } catch {
        throw new ToolPolicyError(
          "TOOL_JOURNAL_DOCUMENT_INVALID",
          "Tool journal contains an invalid, duplicate, or unsorted round",
        );
      }
    }
    return deepFreeze({
      schemaVersion: "dolly.tool-journal-repository/1" as const,
      revision: value.revision,
      rounds,
    });
  }

  #writeDocument(document: ToolJournalDocument): void {
    assertJsonValue(document);
    const payload = `${canonicalizeJson(document)}\n`;
    if (Buffer.byteLength(payload, "utf8") > this.#maxBytes) {
      throw new ToolPolicyError(
        "TOOL_JOURNAL_LIMIT_EXCEEDED",
        "Tool journal update exceeds its configured byte limit",
      );
    }
    const parent = dirname(this.#path);
    const temporaryPath = join(parent, `.${basename(this.#path)}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, payload, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.#path);
      fsyncDirectory(parent);
    } catch (error) {
      if (error instanceof ToolPolicyError) throw error;
      throw new ToolPolicyError("TOOL_JOURNAL_IO_FAILED", "Atomic tool journal write failed");
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
      throw new ToolPolicyError(
        error.code === "CROSS_PROCESS_LOCK_HELD"
          ? "TOOL_JOURNAL_LOCKED"
          : "TOOL_JOURNAL_IO_FAILED",
        error.code === "CROSS_PROCESS_LOCK_HELD"
          ? "Another writer owns the tool journal lock"
          : `Crash-recoverable tool journal locking failed: ${error.message}`,
      );
    }
  }
}
