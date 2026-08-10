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
  canonicalJsonDigest,
  canonicalizeJson,
  cloneJson,
  deepFreeze,
  isJsonObject,
  type JsonValue,
} from "../canonical-json.js";
import { parseStrictJsonBytes } from "../strict-json.js";
import {
  SynchronousCrossProcessLockError,
  withSynchronousCrossProcessLock,
} from "../synchronous-cross-process-lock.js";
import {
  assertEffectIntentRecord,
  assertEffectIntentTransition,
  EffectIntentError,
  sameEffectIntentRecordIdentity,
  type EffectIntentRecord,
  type EffectIntentStore,
} from "./effect-intent-journal.js";

interface EffectIntentStoreDocument {
  readonly schemaVersion: "dolly.effect-intent-store/1";
  readonly revision: number;
  readonly records: readonly EffectIntentRecord[];
}

export interface FileEffectIntentStoreOptions {
  readonly path: string;
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function immutableRecord(record: EffectIntentRecord): EffectIntentRecord {
  assertEffectIntentRecord(record);
  return deepFreeze(
    cloneJson(record as unknown as JsonValue) as unknown as EffectIntentRecord,
  );
}

function compareRecordIdentity(
  left: EffectIntentRecord,
  right: EffectIntentRecord,
): number {
  for (const [leftValue, rightValue] of [
    [left.moduleJobId, right.moduleJobId],
    [left.idempotencyKey, right.idempotencyKey],
    [left.runId, right.runId],
    [String(left.attempt).padStart(16, "0"), String(right.attempt).padStart(16, "0")],
    [left.claimToken, right.claimToken],
    [left.moduleGenerationId, right.moduleGenerationId],
  ] as const) {
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function nextRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) {
    throw new EffectIntentError(
      "EFFECT_INTENT_LIMIT_EXCEEDED",
      "Effect intent store revision space is exhausted",
    );
  }
  return revision + 1;
}

/**
 * Crash-recoverable storage for effect intents.
 *
 * A successful `compareAndSet` is fsynced before it returns. This store proves
 * that individual records survive Core restart; it does not by itself prove
 * that every possible capability effect for a Run was recorded.
 */
export class FileEffectIntentStore implements EffectIntentStore {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #maxBytes: number;

  constructor(options: FileEffectIntentStoreOptions) {
    if (
      typeof options.path !== "string" ||
      options.path.length === 0 ||
      options.path.includes("\0")
    ) {
      throw new TypeError("Effect intent store path must be a non-empty filesystem path");
    }
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1_024) {
      throw new TypeError("Effect intent store maxBytes must be at least 1024");
    }
    this.#path = resolve(options.path);
    this.#lockPath = `${this.#path}.lock`;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#withMutationLock(() => {
      if (existsSync(this.#path)) {
        void this.#readDocument();
      } else {
        this.#writeDocument({
          schemaVersion: "dolly.effect-intent-store/1",
          revision: 0,
          records: [],
        });
      }
    });
  }

  list(): readonly EffectIntentRecord[] {
    return this.#readDocument().records;
  }

  compareAndSet(
    expected: EffectIntentRecord | undefined,
    replacement: EffectIntentRecord,
  ): boolean {
    assertEffectIntentRecord(replacement);
    if (expected === undefined) {
      if (
        replacement.outcome.kind !== "intended" ||
        replacement.createdAt !== replacement.updatedAt
      ) {
        throw new EffectIntentError(
          "EFFECT_INTENT_CONFLICT",
          "A new persisted effect intent must begin in the intended state",
        );
      }
    } else {
      assertEffectIntentTransition(expected, replacement);
    }
    return this.#withMutationLock(() => {
      const document = this.#readDocument();
      const index = document.records.findIndex((record) =>
        sameEffectIntentRecordIdentity(record, replacement));
      if (expected === undefined) {
        if (index >= 0) return false;
        if (document.records.some(
          (record) =>
            record.moduleJobId === replacement.moduleJobId &&
            record.idempotencyKey === replacement.idempotencyKey &&
            record.intentDigest !== replacement.intentDigest,
        )) {
          throw new EffectIntentError(
            "EFFECT_INTENT_CONFLICT",
            "A stable effect idempotency key already names a different intent",
          );
        }
        this.#writeDocument({
          ...document,
          revision: nextRevision(document.revision),
          records: [...document.records, immutableRecord(replacement)].sort(
            compareRecordIdentity,
          ),
        });
        return true;
      }
      if (
        index < 0 ||
        canonicalJsonDigest(document.records[index]) !== canonicalJsonDigest(expected)
      ) {
        return false;
      }
      assertEffectIntentTransition(document.records[index]!, replacement);
      const records = [...document.records];
      records[index] = immutableRecord(replacement);
      this.#writeDocument({
        ...document,
        revision: nextRevision(document.revision),
        records,
      });
      return true;
    });
  }

  #readDocument(): EffectIntentStoreDocument {
    let bytes: Buffer;
    try {
      if (lstatSync(this.#path).isSymbolicLink()) {
        throw new EffectIntentError(
          "EFFECT_INTENT_IO_FAILED",
          "Effect intent store file must not be a symbolic link",
        );
      }
      if (statSync(this.#path).size > this.#maxBytes) {
        throw new EffectIntentError(
          "EFFECT_INTENT_LIMIT_EXCEEDED",
          "Effect intent store exceeds its configured byte limit",
        );
      }
      bytes = readFileSync(this.#path);
    } catch (error) {
      if (error instanceof EffectIntentError) throw error;
      throw new EffectIntentError(
        "EFFECT_INTENT_IO_FAILED",
        "Could not read the effect intent store",
      );
    }

    let value: JsonValue;
    try {
      value = parseStrictJsonBytes(bytes, { maxBytes: this.#maxBytes, maxDepth: 64 });
    } catch {
      throw new EffectIntentError(
        "EFFECT_INTENT_DOCUMENT_INVALID",
        "Effect intent store is not strict JSON data",
      );
    }
    if (
      !isJsonObject(value) ||
      Object.keys(value).some(
        (key) => key !== "schemaVersion" && key !== "revision" && key !== "records",
      ) ||
      value.schemaVersion !== "dolly.effect-intent-store/1" ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0 ||
      !Array.isArray(value.records)
    ) {
      throw new EffectIntentError(
        "EFFECT_INTENT_DOCUMENT_INVALID",
        "Effect intent store document schema is invalid",
      );
    }
    const records: EffectIntentRecord[] = [];
    const stableIntents = new Map<string, string>();
    let previous: EffectIntentRecord | undefined;
    try {
      for (const candidate of value.records) {
        assertEffectIntentRecord(candidate);
        const record = immutableRecord(candidate);
        if (previous !== undefined && compareRecordIdentity(previous, record) >= 0) {
          throw new Error("records are duplicated or unsorted");
        }
        const stableKey = `${record.moduleJobId}\0${record.idempotencyKey}`;
        const stableIntent = stableIntents.get(stableKey);
        if (stableIntent !== undefined && stableIntent !== record.intentDigest) {
          throw new Error("one stable idempotency key names different intents");
        }
        stableIntents.set(stableKey, record.intentDigest);
        records.push(record);
        previous = record;
      }
    } catch {
      throw new EffectIntentError(
        "EFFECT_INTENT_DOCUMENT_INVALID",
        "Effect intent store contains an invalid, duplicate, or unsorted record",
      );
    }
    return deepFreeze({
      schemaVersion: "dolly.effect-intent-store/1" as const,
      revision: value.revision as number,
      records,
    });
  }

  #writeDocument(document: EffectIntentStoreDocument): void {
    assertJsonValue(document);
    const payload = `${canonicalizeJson(document)}\n`;
    if (Buffer.byteLength(payload, "utf8") > this.#maxBytes) {
      throw new EffectIntentError(
        "EFFECT_INTENT_LIMIT_EXCEEDED",
        "Effect intent store update exceeds its configured byte limit",
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
      if (error instanceof EffectIntentError) throw error;
      throw new EffectIntentError(
        "EFFECT_INTENT_IO_FAILED",
        "Atomic effect intent store write failed",
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
      if (error.code === "CROSS_PROCESS_LOCK_HELD") {
        throw new EffectIntentError(
          "EFFECT_INTENT_LOCKED",
          "Another writer owns the effect intent store lock",
        );
      }
      throw new EffectIntentError(
        "EFFECT_INTENT_IO_FAILED",
        `Crash-recoverable effect intent store locking failed: ${error.message}`,
      );
    }
  }
}
