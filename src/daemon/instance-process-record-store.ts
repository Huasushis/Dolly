/**
 * Durable process records for daemon-managed Dolly instance processes.
 *
 * `security-operations.md` Section 7.4 requires each record to carry the
 * instance identifier, the process generation identifier, the process
 * identifier, an operating-system identity token, and an authenticated IPC
 * session identity, so that a later daemon can decide whether a recovered
 * identifier may be signalled at all.
 *
 * The record never stores a secret. The IPC session identity is a digest of
 * the generation's identity token, which binds the record to the authenticated
 * readiness handshake without persisting the material that authenticates it.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, parse, resolve } from "node:path";
import { assertJsonValue, deepFreeze, type JsonValue } from "../core/canonical-json.js";
import { parseStrictJsonBytes } from "../core/strict-json.js";

const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONFIG_REVISION_PATTERN = /^(?:sha256:[0-9a-f]{64}|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/u;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_REASON_LENGTH = 256;

export type InstanceProcessRecordState = "starting" | "running" | "stopping" | "stale";

export interface InstanceProcessRecord {
  readonly schemaVersion: "dolly.instance-process-record/1";
  readonly instanceId: string;
  readonly processGenerationId: string;
  readonly pid: number;
  readonly controllerId: string;
  readonly configRevision: string;
  /** Digest of the generation identity token proven by readiness. */
  readonly ipcSessionId: string;
  readonly state: InstanceProcessRecordState;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Operating-system identity observed for `pid` right after the spawn.
   * Absent when the platform could not supply one, which permanently denies
   * signalling this identifier after a daemon restart.
   */
  readonly osIdentityToken?: string;
  /** Why the record became stale; present only in the `stale` state. */
  readonly staleReason?: string;
}

export type InstanceProcessRecordErrorCode =
  | "PROCESS_RECORD_INVALID"
  | "PROCESS_RECORD_PATH_INVALID"
  | "PROCESS_RECORD_IO_FAILED";

export class InstanceProcessRecordError extends Error {
  constructor(
    readonly code: InstanceProcessRecordErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InstanceProcessRecordError";
  }
}

/** Derives the non-secret IPC session identity bound to one generation. */
export function deriveIpcSessionId(processIdentityToken: string): string {
  if (typeof processIdentityToken !== "string" || processIdentityToken.length === 0) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "An IPC session identity requires a process identity token",
    );
  }
  return `sha256:${createHash("sha256")
    .update("dolly.ipc-session/1\u0000", "utf8")
    .update(processIdentityToken, "utf8")
    .digest("hex")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isPrintable(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint < 0x20 || codePoint === 0x7f) return false;
  }
  return true;
}

export function parseInstanceProcessRecord(value: unknown): InstanceProcessRecord {
  if (!isPlainObject(value)) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "A process record must be a plain object",
    );
  }
  const allowed = new Set([
    "schemaVersion",
    "instanceId",
    "processGenerationId",
    "pid",
    "controllerId",
    "configRevision",
    "ipcSessionId",
    "state",
    "createdAt",
    "updatedAt",
    "osIdentityToken",
    "staleReason",
  ]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      `Process record contains unknown fields: ${unexpected.sort().join(", ")}`,
    );
  }
  if (value.schemaVersion !== "dolly.instance-process-record/1") {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "Process record schema version is unsupported",
    );
  }
  if (typeof value.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(value.instanceId)) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "Process record instanceId must be a lowercase UUIDv4",
    );
  }
  if (
    typeof value.processGenerationId !== "string" ||
    !GENERATION_ID_PATTERN.test(value.processGenerationId)
  ) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "Process record processGenerationId is invalid",
    );
  }
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "Process record pid must be a positive safe integer",
    );
  }
  if (typeof value.controllerId !== "string" || !INSTANCE_ID_PATTERN.test(value.controllerId)) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "Process record controllerId must be a lowercase UUIDv4",
    );
  }
  if (
    typeof value.configRevision !== "string" ||
    !CONFIG_REVISION_PATTERN.test(value.configRevision)
  ) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "Process record configRevision is invalid",
    );
  }
  if (typeof value.ipcSessionId !== "string" || !DIGEST_PATTERN.test(value.ipcSessionId)) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "Process record ipcSessionId must be a sha256 digest",
    );
  }
  if (
    value.state !== "starting" &&
    value.state !== "running" &&
    value.state !== "stopping" &&
    value.state !== "stale"
  ) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "Process record state is invalid",
    );
  }
  if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "Process record timestamps must be canonical ISO instants",
    );
  }
  if (value.osIdentityToken !== undefined && !isPrintable(value.osIdentityToken, 512)) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "Process record osIdentityToken is invalid",
    );
  }
  if (value.staleReason !== undefined && !isPrintable(value.staleReason, MAX_REASON_LENGTH)) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "Process record staleReason is invalid",
    );
  }
  if ((value.state === "stale") !== (value.staleReason !== undefined)) {
    throw new InstanceProcessRecordError(
      "PROCESS_RECORD_INVALID",
      "A stale process record must carry exactly one stale reason",
    );
  }
  return deepFreeze({ ...value }) as unknown as InstanceProcessRecord;
}

export interface InstanceProcessRecordStoreOptions {
  /** Owner-only directory that holds one JSON record per instance. */
  readonly directory: string;
}

export class InstanceProcessRecordStore {
  readonly #directory: string;

  constructor(options: InstanceProcessRecordStoreOptions) {
    const directory = options.directory;
    if (typeof directory !== "string" || directory.length === 0 || directory.includes("\0")) {
      throw new InstanceProcessRecordError(
        "PROCESS_RECORD_PATH_INVALID",
        "Process record directory is invalid",
      );
    }
    const absolute = resolve(directory);
    if (absolute === parse(absolute).root) {
      throw new InstanceProcessRecordError(
        "PROCESS_RECORD_PATH_INVALID",
        "Process record directory cannot be a filesystem root",
      );
    }
    this.#directory = absolute;
  }

  get directory(): string {
    return this.#directory;
  }

  read(instanceId: string): InstanceProcessRecord | null {
    const path = this.#pathFor(instanceId);
    if (!existsSync(path)) return null;
    let bytes: Buffer;
    try {
      if (statSync(path).size > MAX_RECORD_BYTES) {
        throw new InstanceProcessRecordError(
          "PROCESS_RECORD_INVALID",
          "Process record exceeds its byte limit",
        );
      }
      bytes = readFileSync(path);
    } catch (error) {
      if (error instanceof InstanceProcessRecordError) throw error;
      throw new InstanceProcessRecordError(
        "PROCESS_RECORD_IO_FAILED",
        "Could not read the process record",
        { cause: error },
      );
    }
    const record = parseInstanceProcessRecord(
      parseStrictJsonBytes(bytes, { maxBytes: MAX_RECORD_BYTES, maxDepth: 8 }),
    );
    if (record.instanceId !== instanceId) {
      throw new InstanceProcessRecordError(
        "PROCESS_RECORD_INVALID",
        "Process record instanceId does not match its file name",
      );
    }
    return record;
  }

  listInstanceIds(): readonly string[] {
    if (!existsSync(this.#directory)) return [];
    let entries: readonly string[];
    try {
      entries = readdirSync(this.#directory);
    } catch (error) {
      throw new InstanceProcessRecordError(
        "PROCESS_RECORD_IO_FAILED",
        "Could not list process records",
        { cause: error },
      );
    }
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .filter((candidate) => INSTANCE_ID_PATTERN.test(candidate))
      .sort();
  }

  write(record: InstanceProcessRecord): InstanceProcessRecord {
    const validated = parseInstanceProcessRecord(record);
    this.#writeAtomic(this.#pathFor(validated.instanceId), validated as unknown as JsonValue);
    return validated;
  }

  /** Removes a record. Deleting a record never terminates a process. */
  clear(instanceId: string): boolean {
    const path = this.#pathFor(instanceId);
    if (!existsSync(path)) return false;
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      throw new InstanceProcessRecordError(
        "PROCESS_RECORD_IO_FAILED",
        "Could not remove the process record",
        { cause: error },
      );
    }
  }

  #pathFor(instanceId: string): string {
    if (typeof instanceId !== "string" || !INSTANCE_ID_PATTERN.test(instanceId)) {
      throw new InstanceProcessRecordError(
        "PROCESS_RECORD_PATH_INVALID",
        "Process record instanceId must be a lowercase UUIDv4",
      );
    }
    return join(this.#directory, `${instanceId}.json`);
  }

  #writeAtomic(path: string, value: JsonValue): void {
    assertJsonValue(value);
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(this.#directory, `.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
    } catch (error) {
      throw new InstanceProcessRecordError(
        "PROCESS_RECORD_IO_FAILED",
        "Atomic process record write failed",
        { cause: error },
      );
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The write failure above is the useful diagnostic.
        }
      }
      if (existsSync(temporaryPath)) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // A same-directory temporary is never treated as committed state.
        }
      }
    }
  }
}
