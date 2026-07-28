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
import { randomUUID } from "node:crypto";
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
  assertModuleResultCommitRecord,
  assertModuleResultCommitTransition,
  ModuleResultCommitError,
  type ModuleResultCommitRecord,
  type ModuleResultCommitRepository,
} from "./module-result-commit.js";
import {
  SynchronousCrossProcessLockError,
  withSynchronousCrossProcessLock,
} from "./synchronous-cross-process-lock.js";

interface RepositoryDocument {
  readonly schemaVersion: "dolly.module-result-commit-repository/1";
  readonly revision: number;
  readonly records: readonly ModuleResultCommitRecord[];
}

export interface FileModuleResultCommitRepositoryOptions {
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

function immutableRecord(record: ModuleResultCommitRecord): ModuleResultCommitRecord {
  assertModuleResultCommitRecord(record);
  return deepFreeze(
    cloneJson(record as unknown as JsonValue) as unknown as ModuleResultCommitRecord,
  ) as ModuleResultCommitRecord;
}

function assertInitialRecord(record: ModuleResultCommitRecord): void {
  assertModuleResultCommitRecord(record);
  if (
    record.state !== "prepared" ||
    record.revision !== 1 ||
    record.blockId !== undefined ||
    record.outputDeliveries.length !== 0
  ) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "A new Module result commit must be an effect-free prepared revision 1",
    );
  }
}

function nextRepositoryRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_LIMIT_EXCEEDED",
      "Module result commit repository revision space is exhausted",
    );
  }
  return revision + 1;
}

export class FileModuleResultCommitRepository implements ModuleResultCommitRepository {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #maxBytes: number;

  constructor(options: FileModuleResultCommitRepositoryOptions) {
    if (typeof options.path !== "string" || options.path.length === 0 || options.path.includes("\0")) {
      throw new TypeError("Module result commit repository path must be a non-empty filesystem path");
    }
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1024) {
      throw new TypeError("Module result commit repository maxBytes must be at least 1024");
    }
    this.#path = resolve(options.path);
    this.#lockPath = `${this.#path}.lock`;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#withMutationLock(() => {
      if (existsSync(this.#path)) {
        void this.#readDocument();
      } else {
        this.#writeDocument({
          schemaVersion: "dolly.module-result-commit-repository/1",
          revision: 0,
          records: [],
        });
      }
    });
  }

  createPrepared(record: ModuleResultCommitRecord): "created" | "already-exists" {
    assertInitialRecord(record);
    return this.#withMutationLock(() => {
      const document = this.#readDocument();
      if (document.records.some((candidate) => candidate.moduleJobId === record.moduleJobId)) {
        return "already-exists";
      }
      this.#writeDocument({
        ...document,
        revision: nextRepositoryRevision(document.revision),
        records: [...document.records, immutableRecord(record)].sort((left, right) =>
          left.moduleJobId < right.moduleJobId ? -1 : left.moduleJobId > right.moduleJobId ? 1 : 0,
        ),
      });
      return "created";
    });
  }

  get(moduleJobId: string): ModuleResultCommitRecord | null {
    const document = this.#readDocument();
    return document.records.find((record) => record.moduleJobId === moduleJobId) ?? null;
  }

  compareAndSet(
    moduleJobId: string,
    expectedRevision: number,
    next: ModuleResultCommitRecord,
  ): boolean {
    assertModuleResultCommitRecord(next);
    return this.#withMutationLock(() => {
      const document = this.#readDocument();
      const index = document.records.findIndex((record) => record.moduleJobId === moduleJobId);
      if (index < 0 || document.records[index]!.revision !== expectedRevision) return false;
      const current = document.records[index]!;
      assertModuleResultCommitTransition(current, next);
      const records = [...document.records];
      records[index] = immutableRecord(next);
      this.#writeDocument({
        ...document,
        revision: nextRepositoryRevision(document.revision),
        records,
      });
      return true;
    });
  }

  list(): readonly ModuleResultCommitRecord[] {
    return this.#readDocument().records;
  }

  #readDocument(): RepositoryDocument {
    let bytes: Buffer;
    try {
      if (lstatSync(this.#path).isSymbolicLink()) {
        throw new ModuleResultCommitError(
          "MODULE_RESULT_COMMIT_IO_FAILED",
          "Module result commit repository file must not be a symbolic link",
        );
      }
      const size = statSync(this.#path).size;
      if (size > this.#maxBytes) {
        throw new ModuleResultCommitError(
          "MODULE_RESULT_COMMIT_LIMIT_EXCEEDED",
          "Module result commit repository exceeds its configured byte limit",
        );
      }
      bytes = readFileSync(this.#path);
    } catch (error) {
      if (error instanceof ModuleResultCommitError) throw error;
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_IO_FAILED",
        "Could not read the Module result commit repository",
      );
    }

    let value: JsonValue;
    try {
      value = parseStrictJsonBytes(bytes, { maxBytes: this.#maxBytes, maxDepth: 128 });
    } catch {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_DOCUMENT_INVALID",
        "Module result commit repository is not strict JSON data",
      );
    }
    if (!isJsonObject(value)) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_DOCUMENT_INVALID",
        "Module result commit repository document must be an object",
      );
    }
    const keys = Object.keys(value);
    if (
      keys.some((key) => key !== "schemaVersion" && key !== "revision" && key !== "records") ||
      value.schemaVersion !== "dolly.module-result-commit-repository/1" ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0 ||
      !Array.isArray(value.records)
    ) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_DOCUMENT_INVALID",
        "Module result commit repository document schema is invalid",
      );
    }

    const records: ModuleResultCommitRecord[] = [];
    let previousId: string | undefined;
    for (const candidate of value.records) {
      try {
        const record = candidate as unknown as ModuleResultCommitRecord;
        assertModuleResultCommitRecord(record);
        if (previousId !== undefined && record.moduleJobId <= previousId) {
          throw new Error("records are duplicated or unsorted");
        }
        previousId = record.moduleJobId;
        records.push(immutableRecord(record));
      } catch {
        throw new ModuleResultCommitError(
          "MODULE_RESULT_COMMIT_DOCUMENT_INVALID",
          "Module result commit repository contains an invalid or duplicate record",
        );
      }
    }
    return deepFreeze({
      schemaVersion: "dolly.module-result-commit-repository/1" as const,
      revision: value.revision as number,
      records,
    });
  }

  #writeDocument(document: RepositoryDocument): void {
    assertJsonValue(document);
    const payload = `${canonicalizeJson(document)}\n`;
    if (Buffer.byteLength(payload, "utf8") > this.#maxBytes) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_LIMIT_EXCEEDED",
        "Module result commit repository update exceeds its configured byte limit",
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
      if (error instanceof ModuleResultCommitError) throw error;
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_IO_FAILED",
        "Atomic Module result commit repository write failed",
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
          // Same-directory temporary files are never treated as committed state.
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
        throw new ModuleResultCommitError(
          "MODULE_RESULT_COMMIT_LOCKED",
          "Another writer owns the Module result commit repository lock",
        );
      }
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_IO_FAILED",
        `Crash-recoverable Module result commit repository locking failed: ${error.message}`,
      );
    }
  }
}
