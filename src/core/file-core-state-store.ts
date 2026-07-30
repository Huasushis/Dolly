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
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  BlockStore,
  type BlockStoreLimits,
  type BlockStoreSnapshot,
} from "./block-store.js";
import {
  DeliveryStore,
  type DeliveryStoreOptions,
  type DeliveryStoreSnapshot,
} from "./delivery-store.js";
import {
  ReferenceGraph,
  type ReferenceGraphSnapshot,
} from "./reference-graph.js";
import {
  MediaStore,
  type MediaByteStore,
  type MediaInspector,
  type MediaStoreSnapshot,
  type StorageAdapter,
} from "./media-store.js";
import {
  ModuleProcessRecordError,
  assertModuleRecordCollectionsConsistent,
  assertValidModuleProcessRecord,
  assertValidModuleSubmissionRecord,
  canTransitionModuleProcessRecordState,
  type ModuleProcessRecord,
  type ModuleProcessRecordState,
  type ModuleSubmissionRecord,
} from "./module-process-records.js";
import { parseStrictJsonBytes } from "./strict-json.js";
import {
  SynchronousCrossProcessLockError,
  withSynchronousCrossProcessLock,
} from "./synchronous-cross-process-lock.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export type CoreStateErrorCode =
  | "CORE_STATE_PATH_INVALID"
  | "CORE_STATE_LIMIT_EXCEEDED"
  | "CORE_STATE_DOCUMENT_INVALID"
  | "CORE_STATE_MIGRATION_REQUIRED"
  | "CORE_STATE_LOCKED"
  | "CORE_STATE_REVISION_CONFLICT"
  | "CORE_STATE_REVISION_EXHAUSTED"
  | "CORE_STATE_REOPEN_REQUIRED"
  | "CORE_STATE_IO_FAILED";

export class CoreStateError extends Error {
  constructor(readonly code: CoreStateErrorCode, message: string) {
    super(message);
    this.name = "CoreStateError";
  }
}

export interface CoreStatePayload {
  readonly revision: number;
  readonly referenceGraph: ReferenceGraphSnapshot;
  readonly media?: MediaStoreSnapshot;
  readonly blocks: BlockStoreSnapshot;
  readonly deliveries: DeliveryStoreSnapshot;
  readonly moduleProcessRecords: readonly ModuleProcessRecord[];
  readonly moduleSubmissionRecords: readonly ModuleSubmissionRecord[];
}

export interface CoreStateDocument extends CoreStatePayload {
  readonly schemaVersion: "dolly.core-state/16";
  readonly stateDigest: string;
}

export interface FileCoreStateStoreOptions {
  readonly path: string;
  readonly maxBytes?: number;
  readonly maxFailedAttempts: number;
  readonly nextBlockId: () => string;
  readonly nextDeliveryId: DeliveryStoreOptions["nextId"];
  readonly now: () => string;
  readonly blockLimits?: Partial<BlockStoreLimits>;
  readonly media?: FileCoreMediaOptions;
}

export interface FileCoreMediaOptions {
  readonly durability: "persistent";
  readonly bytes: MediaByteStore;
  readonly inspector: MediaInspector;
  readonly adapters?: readonly StorageAdapter[];
  readonly maxMediaBytes: number;
  readonly maxTotalMediaBytes?: number;
  readonly maxRegistrationRecords?: number;
  readonly maxStorageRecords?: number;
  readonly maxProviderAccessRecords?: number;
  readonly deletedRegistrationRetentionMs?: number;
  readonly idNamespace: string;
}

function stateDigest(payload: CoreStatePayload): string {
  return canonicalJsonDigest(payload);
}

function assertDocumentObject(value: JsonValue): asserts value is Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreStateError(
      "CORE_STATE_DOCUMENT_INVALID",
      "Core state document must be an object",
    );
  }
  const allowed = new Set([
    "schemaVersion",
    "stateDigest",
    "revision",
    "referenceGraph",
    "media",
    "blocks",
    "deliveries",
    "moduleProcessRecords",
    "moduleSubmissionRecords",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CoreStateError(
      "CORE_STATE_DOCUMENT_INVALID",
      "Core state document contains unknown fields",
    );
  }
}

function nextRevision(current: number): number {
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
    throw new CoreStateError(
      "CORE_STATE_REVISION_EXHAUSTED",
      "Core state revision space is exhausted",
    );
  }
  return current + 1;
}

const MUTATION_OBSERVER_METHODS = new Set<PropertyKey>(["setMutationObserver"]);
const REFERENCE_GRAPH_MUTATION_METHODS = new Set<PropertyKey>([
  "registerNode",
  "addStrongReference",
  "removeStrongReference",
  "acquireLease",
  "releaseLease",
  "beginRemoval",
  "completeRemoval",
  "cancelRemoval",
  "unregisterUnreachable",
]);

/**
 * Exposes an in-memory component owned by `FileCoreStateStore`. Every normal
 * property access and method call first verifies that the store has not
 * entered an uncertain state that requires reopening. Methods that could
 * replace persistence wiring or mutate the reference graph outside a
 * persisted store operation are unavailable on the exposed object, while the
 * store keeps the original object internally.
 */
function exposeCheckedObject<T extends object>(options: {
  readonly target: T;
  readonly assertUsable: () => void;
  readonly label: string;
  readonly forbiddenMethods?: ReadonlySet<PropertyKey>;
  readonly replacements?: ReadonlyMap<unknown, unknown>;
}): T {
  const checkedMethods = new Map<
    PropertyKey,
    { readonly original: unknown; readonly checked: unknown }
  >();
  const forbiddenMethods = new Map<PropertyKey, () => never>();
  return new Proxy(options.target, {
    get(target, property) {
      options.assertUsable();
      if (options.forbiddenMethods?.has(property)) {
        let reject = forbiddenMethods.get(property);
        if (reject === undefined) {
          reject = () => {
            options.assertUsable();
            throw new TypeError(
              `${options.label}.${String(property)} is managed by FileCoreStateStore`,
            );
          };
          forbiddenMethods.set(property, reject);
        }
        return reject;
      }
      const value = Reflect.get(target, property, target) as unknown;
      const replacement = options.replacements?.get(value);
      if (replacement !== undefined) return replacement;
      if (typeof value !== "function") return value;
      const cached = checkedMethods.get(property);
      if (cached?.original === value) return cached.checked;
      const checked = (...args: unknown[]) => {
        options.assertUsable();
        return Reflect.apply(value, target, args) as unknown;
      };
      checkedMethods.set(property, { original: value, checked });
      return checked;
    },
    getOwnPropertyDescriptor(target, property) {
      options.assertUsable();
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (descriptor === undefined || !("value" in descriptor)) return descriptor;
      const replacement = options.replacements?.get(descriptor.value);
      return replacement === undefined ? descriptor : { ...descriptor, value: replacement };
    },
    set() {
      options.assertUsable();
      throw new TypeError(`${options.label} properties cannot be replaced`);
    },
    defineProperty() {
      options.assertUsable();
      throw new TypeError(`${options.label} properties cannot be redefined`);
    },
    deleteProperty() {
      options.assertUsable();
      throw new TypeError(`${options.label} properties cannot be deleted`);
    },
    setPrototypeOf() {
      options.assertUsable();
      throw new TypeError(`${options.label} prototype cannot be replaced`);
    },
    preventExtensions() {
      options.assertUsable();
      throw new TypeError(`${options.label} cannot be made non-extensible`);
    },
  });
}

export class FileCoreStateStore {
  readonly referenceGraph: ReferenceGraph;
  readonly media: MediaStore | undefined;
  readonly blocks: BlockStore;
  readonly deliveries: DeliveryStore;
  readonly #referenceGraph: ReferenceGraph;
  readonly #media: MediaStore | undefined;
  readonly #blocks: BlockStore;
  readonly #deliveries: DeliveryStore;
  readonly #path: string;
  readonly #lockPath: string;
  readonly #maxBytes: number;
  readonly #now: () => string;
  readonly #moduleProcessRecords = new Map<string, ModuleProcessRecord>();
  readonly #moduleSubmissionRecords = new Map<string, ModuleSubmissionRecord>();
  #revision: number;
  #deferPersistence = false;
  #deferredMutation = false;
  #reopenRequired = false;

  constructor(options: FileCoreStateStoreOptions) {
    if (
      typeof options.path !== "string" ||
      options.path.length === 0 ||
      options.path.includes("\0")
    ) {
      throw new CoreStateError("CORE_STATE_PATH_INVALID", "Core state path is invalid");
    }
    if (
      !Number.isSafeInteger(options.maxFailedAttempts) ||
      options.maxFailedAttempts <= 0
    ) {
      throw new TypeError("maxFailedAttempts must be a positive safe integer");
    }
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1024) {
      throw new TypeError("Core state maxBytes must be at least 1024");
    }
    this.#path = resolve(options.path);
    this.#lockPath = `${this.#path}.lock`;
    this.#now = options.now;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });

    const document = this.#withMutationLock(() => {
      if (existsSync(this.#path)) return this.#readDocument();
      const referenceGraph = new ReferenceGraph();
      let media: MediaStore | undefined;
      if (options.media) {
        media = new MediaStore({
          durability: options.media.durability,
          referenceGraph,
          bytes: options.media.bytes,
          inspector: options.media.inspector,
          ...(options.media.adapters === undefined
            ? {}
            : { adapters: options.media.adapters }),
          maxMediaBytes: options.media.maxMediaBytes,
          ...(options.media.maxTotalMediaBytes === undefined
            ? {}
            : { maxTotalMediaBytes: options.media.maxTotalMediaBytes }),
          ...(options.media.maxRegistrationRecords === undefined
            ? {}
            : { maxRegistrationRecords: options.media.maxRegistrationRecords }),
          ...(options.media.maxStorageRecords === undefined
            ? {}
            : { maxStorageRecords: options.media.maxStorageRecords }),
          ...(options.media.maxProviderAccessRecords === undefined
            ? {}
            : { maxProviderAccessRecords: options.media.maxProviderAccessRecords }),
          ...(options.media.deletedRegistrationRetentionMs === undefined
            ? {}
            : {
                deletedRegistrationRetentionMs:
                  options.media.deletedRegistrationRetentionMs,
              }),
          idNamespace: options.media.idNamespace,
          now: options.now,
          onMutation: () => undefined,
        });
      }
      const blocks = new BlockStore({
        nextBlockId: options.nextBlockId,
        now: options.now,
        referenceGraph,
        ...(media === undefined ? {} : { media }),
        ...(options.blockLimits === undefined ? {} : { limits: options.blockLimits }),
      });
      const deliveries = new DeliveryStore({
        blocks,
        maxFailedAttempts: options.maxFailedAttempts,
        nextId: options.nextDeliveryId,
        now: options.now,
      });
      const initial = this.#createDocument(0, referenceGraph, media, blocks, deliveries);
      this.#writeDocument(initial);
      return initial;
    });

    this.#revision = document.revision;
    let loaded: {
      readonly referenceGraph: ReferenceGraph;
      readonly media: MediaStore | undefined;
      readonly blocks: BlockStore;
      readonly deliveries: DeliveryStore;
    };
    try {
      if ((document.media === undefined) !== (options.media === undefined)) {
        throw new Error("Configured Media durability does not match the state document");
      }
      const referenceGraph = new ReferenceGraph({ snapshot: document.referenceGraph });
      const media = options.media === undefined
        ? undefined
        : new MediaStore({
            durability: options.media.durability,
            referenceGraph,
            bytes: options.media.bytes,
            inspector: options.media.inspector,
            ...(options.media.adapters === undefined
              ? {}
              : { adapters: options.media.adapters }),
            maxMediaBytes: options.media.maxMediaBytes,
            ...(options.media.maxTotalMediaBytes === undefined
              ? {}
              : { maxTotalMediaBytes: options.media.maxTotalMediaBytes }),
            ...(options.media.maxRegistrationRecords === undefined
              ? {}
              : { maxRegistrationRecords: options.media.maxRegistrationRecords }),
            ...(options.media.maxStorageRecords === undefined
              ? {}
              : { maxStorageRecords: options.media.maxStorageRecords }),
            ...(options.media.maxProviderAccessRecords === undefined
              ? {}
              : { maxProviderAccessRecords: options.media.maxProviderAccessRecords }),
            ...(options.media.deletedRegistrationRetentionMs === undefined
              ? {}
              : {
                  deletedRegistrationRetentionMs:
                    options.media.deletedRegistrationRetentionMs,
                }),
            idNamespace: options.media.idNamespace,
            now: options.now,
            snapshot: document.media!,
            onMutation: () => undefined,
          });
      const blocks = new BlockStore({
        nextBlockId: options.nextBlockId,
        now: options.now,
        referenceGraph,
        snapshot: document.blocks,
        ...(media === undefined ? {} : { media }),
        ...(options.blockLimits === undefined ? {} : { limits: options.blockLimits }),
      });
      const deliveries = new DeliveryStore({
        blocks,
        maxFailedAttempts: options.maxFailedAttempts,
        nextId: options.nextDeliveryId,
        now: options.now,
        snapshot: document.deliveries,
      });
      loaded = { referenceGraph, media, blocks, deliveries };
    } catch {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Core state components are inconsistent",
      );
    }

    this.#referenceGraph = loaded.referenceGraph;
    this.#media = loaded.media;
    this.#blocks = loaded.blocks;
    this.#deliveries = loaded.deliveries;
    const assertUsable = () => this.#assertUsable();
    this.referenceGraph = exposeCheckedObject({
      target: this.#referenceGraph,
      assertUsable,
      label: "FileCoreStateStore.referenceGraph",
      forbiddenMethods: REFERENCE_GRAPH_MUTATION_METHODS,
    });
    this.media = this.#media === undefined
      ? undefined
      : exposeCheckedObject({
          target: this.#media,
          assertUsable,
          label: "FileCoreStateStore.media",
          forbiddenMethods: MUTATION_OBSERVER_METHODS,
          replacements: new Map([[this.#referenceGraph, this.referenceGraph]]),
        });
    this.blocks = exposeCheckedObject({
      target: this.#blocks,
      assertUsable,
      label: "FileCoreStateStore.blocks",
      forbiddenMethods: MUTATION_OBSERVER_METHODS,
      replacements: new Map([[this.#referenceGraph, this.referenceGraph]]),
    });
    this.deliveries = exposeCheckedObject({
      target: this.#deliveries,
      assertUsable,
      label: "FileCoreStateStore.deliveries",
      forbiddenMethods: MUTATION_OBSERVER_METHODS,
      replacements: new Map([[this.#blocks, this.blocks]]),
    });

    for (const record of document.moduleProcessRecords) {
      this.#moduleProcessRecords.set(record.processGenerationId, record);
    }
    for (const record of document.moduleSubmissionRecords) {
      this.#moduleSubmissionRecords.set(record.runId, record);
    }

    const persist = () => this.#persistCurrent();
    this.#media?.setMutationObserver(persist);
    this.#blocks.setMutationObserver(persist);
    this.#deliveries.setMutationObserver(persist);
  }

  get revision(): number {
    this.#assertUsable();
    return this.#revision;
  }

  snapshot(): CoreStateDocument {
    this.#assertUsable();
    return this.#createDocument(
      this.#revision,
      this.#referenceGraph,
      this.#media,
      this.#blocks,
      this.#deliveries,
    );
  }

  flush(): void {
    this.#assertUsable();
    this.#media?.flushPersistence();
    this.#blocks.flushPersistence();
    this.#deliveries.flushPersistence();
  }

  listModuleProcessRecords(): readonly ModuleProcessRecord[] {
    this.#assertUsable();
    return [...this.#moduleProcessRecords.values()].sort((a, b) =>
      a.processGenerationId < b.processGenerationId ? -1 : 1,
    );
  }

  getModuleProcessRecord(processGenerationId: string): ModuleProcessRecord | undefined {
    this.#assertUsable();
    return this.#moduleProcessRecords.get(processGenerationId);
  }

  listModuleSubmissionRecords(): readonly ModuleSubmissionRecord[] {
    this.#assertUsable();
    return [...this.#moduleSubmissionRecords.values()].sort((a, b) =>
      a.runId < b.runId ? -1 : 1,
    );
  }

  getModuleSubmissionRecord(runId: string): ModuleSubmissionRecord | undefined {
    this.#assertUsable();
    return this.#moduleSubmissionRecords.get(runId);
  }

  /**
   * Persists one Module process record in its `starting` state. The record is
   * durable before any child launcher may be created; the process-generation
   * identifier is never reused, so an existing entry is a conflict.
   */
  appendModuleProcessRecord(record: ModuleProcessRecord): ModuleProcessRecord {
    this.#assertUsable();
    assertValidModuleProcessRecord(record);
    if (record.state !== "starting") {
      throw new ModuleProcessRecordError(
        "MODULE_PROCESS_RECORD_STATE_INVALID",
        "A new Module process record must begin in the starting state",
      );
    }
    if (this.#moduleProcessRecords.has(record.processGenerationId)) {
      throw new ModuleProcessRecordError(
        "MODULE_PROCESS_RECORD_CONFLICT",
        `Module process record "${record.processGenerationId}" already exists`,
      );
    }
    const stored = deepFreeze({ ...record });
    this.#moduleProcessRecords.set(record.processGenerationId, stored);
    try {
      this.#persistCurrent();
    } catch (error) {
      this.#moduleProcessRecords.delete(record.processGenerationId);
      throw error;
    }
    return stored;
  }

  /**
   * Advances one Module process record along
   * starting -> running -> stopping -> stopped. Marking a record `stopped`
   * requires the caller to hold the ADR 0009 empty-cgroup proof; this store
   * enforces only the transition order and durability.
   */
  updateModuleProcessRecordState(
    processGenerationId: string,
    state: ModuleProcessRecordState,
    failureCode?: string,
  ): ModuleProcessRecord {
    this.#assertUsable();
    const existing = this.#moduleProcessRecords.get(processGenerationId);
    if (!existing) {
      throw new ModuleProcessRecordError(
        "MODULE_PROCESS_RECORD_NOT_FOUND",
        `Module process record "${processGenerationId}" does not exist`,
      );
    }
    if (!canTransitionModuleProcessRecordState(existing.state, state)) {
      throw new ModuleProcessRecordError(
        "MODULE_PROCESS_RECORD_STATE_INVALID",
        `Module process record cannot move from ${existing.state} to ${state}`,
      );
    }
    const updated = {
      ...existing,
      state,
      updatedAt: this.#now(),
      ...(failureCode === undefined ? {} : { failureCode }),
    };
    assertValidModuleProcessRecord(updated);
    const stored = deepFreeze(updated);
    this.#moduleProcessRecords.set(processGenerationId, stored);
    try {
      this.#persistCurrent();
    } catch (error) {
      this.#moduleProcessRecords.set(processGenerationId, existing);
      throw error;
    }
    return stored;
  }

  /**
   * Persists durable authority to send one Run over the Extension process
   * protocol. The matching process record must be `running`; the caller must
   * make this update before the protocol send, never after.
   */
  appendModuleSubmissionRecord(record: ModuleSubmissionRecord): ModuleSubmissionRecord {
    this.#assertUsable();
    assertValidModuleSubmissionRecord(record);
    if (this.#moduleSubmissionRecords.has(record.runId)) {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_CONFLICT",
        `Module submission record for Run "${record.runId}" already exists`,
      );
    }
    const processRecord = this.#moduleProcessRecords.get(record.processGenerationId);
    if (!processRecord) {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
        "A Module submission record requires an existing process record",
      );
    }
    if (processRecord.state !== "running") {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
        `A Module submission record requires a running process record, not ${processRecord.state}`,
      );
    }
    if (processRecord.moduleGenerationId !== record.moduleGenerationId) {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
        "A Module submission record must match its process record's Module generation",
      );
    }
    const stored = deepFreeze({ ...record });
    this.#moduleSubmissionRecords.set(record.runId, stored);
    try {
      this.#persistCurrent();
    } catch (error) {
      this.#moduleSubmissionRecords.delete(record.runId);
      throw error;
    }
    return stored;
  }

  /**
   * Removes one Module submission record. Per ADR 0009 the caller may do this
   * only in the update that records the matching Claim as terminal.
   */
  removeModuleSubmissionRecord(runId: string): void {
    this.#assertUsable();
    const existing = this.#moduleSubmissionRecords.get(runId);
    if (!existing) {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_NOT_FOUND",
        `Module submission record for Run "${runId}" does not exist`,
      );
    }
    this.#moduleSubmissionRecords.delete(runId);
    try {
      this.#persistCurrent();
    } catch (error) {
      this.#moduleSubmissionRecords.set(runId, existing);
      throw error;
    }
  }

  /**
   * Collects one `stopped` Module process record that no submission record
   * references. Records pinned by unresolved evidence stay in place.
   */
  removeModuleProcessRecord(processGenerationId: string): void {
    this.#assertUsable();
    const existing = this.#moduleProcessRecords.get(processGenerationId);
    if (!existing) {
      throw new ModuleProcessRecordError(
        "MODULE_PROCESS_RECORD_NOT_FOUND",
        `Module process record "${processGenerationId}" does not exist`,
      );
    }
    if (existing.state !== "stopped") {
      throw new ModuleProcessRecordError(
        "MODULE_PROCESS_RECORD_IN_USE",
        "Only a stopped Module process record may be removed",
      );
    }
    for (const submission of this.#moduleSubmissionRecords.values()) {
      if (submission.processGenerationId === processGenerationId) {
        throw new ModuleProcessRecordError(
          "MODULE_PROCESS_RECORD_IN_USE",
          "A Module process record referenced by a submission record may not be removed",
        );
      }
    }
    this.#moduleProcessRecords.delete(processGenerationId);
    try {
      this.#persistCurrent();
    } catch (error) {
      this.#moduleProcessRecords.set(processGenerationId, existing);
      throw error;
    }
  }

  /**
   * Persists the callback's mutually dependent Core-state changes together.
   * Recovery uses this to make a terminal Delivery Claim transition and the
   * matching Module submission-record removal durable in one update.
   * Persistence is deferred until the operation returns without a value and
   * then written once. Returning any value is rejected because a Promise
   * would otherwise let the callback continue after the update had already
   * been written.
   *
   * The operation must not depend on partial persistence: if it throws, no
   * Core-state update is written. If the single write itself fails, the
   * in-memory state can no longer be proven equal to the file, so the store
   * fails closed and requires a reopen.
   */
  runAtomicUpdate<Operation extends () => unknown>(
    operation: Operation &
      ([ReturnType<Operation>] extends [never]
        ? unknown
        : ReturnType<Operation> extends PromiseLike<unknown>
          ? never
          : ReturnType<Operation> extends void
            ? unknown
            : never),
  ): void {
    this.#assertUsable();
    if (this.#deferPersistence) {
      throw new CoreStateError(
        "CORE_STATE_IO_FAILED",
        "Core state updates cannot be nested",
      );
    }
    this.flush();
    const processRecords = new Map(this.#moduleProcessRecords);
    const submissionRecords = new Map(this.#moduleSubmissionRecords);
    this.#deferPersistence = true;
    this.#deferredMutation = false;
    let returnedValue = false;
    let result: unknown;
    try {
      result = operation();
      if (result !== undefined) {
        returnedValue = true;
        throw new CoreStateError(
          "CORE_STATE_REOPEN_REQUIRED",
          "A Core state update callback returned a value; callbacks must return undefined and the store must be reopened",
        );
      }
    } catch (error) {
      this.#deferPersistence = false;
      const mutated = this.#deferredMutation;
      this.#deferredMutation = false;
      this.#moduleProcessRecords.clear();
      for (const [key, value] of processRecords) this.#moduleProcessRecords.set(key, value);
      this.#moduleSubmissionRecords.clear();
      for (const [key, value] of submissionRecords) {
        this.#moduleSubmissionRecords.set(key, value);
      }
      if (returnedValue || mutated) {
        // Another component inside the update may have changed its own
        // in-memory state, or an asynchronous continuation may still try to
        // use this store. Neither can be allowed to persist after this point.
        this.#reopenRequired = true;
        if (returnedValue) throw error;
        throw new CoreStateError(
          "CORE_STATE_REOPEN_REQUIRED",
          "A Core state update failed after changing runtime state; reopen the store",
        );
      }
      throw error;
    }
    this.#deferPersistence = false;
    const mutated = this.#deferredMutation;
    this.#deferredMutation = false;
    if (!mutated) return;
    try {
      this.#persistCurrent();
    } catch (error) {
      this.#reopenRequired = true;
      throw error;
    }
  }

  #assertUsable(): void {
    if (this.#reopenRequired) {
      throw new CoreStateError(
        "CORE_STATE_REOPEN_REQUIRED",
        "This Core state store failed an update and must be reopened",
      );
    }
  }

  #persistCurrent(): void {
    this.#assertUsable();
    if (this.#deferPersistence) {
      this.#deferredMutation = true;
      return;
    }
    this.#withMutationLock(() => {
      const current = this.#readDocument();
      if (current.revision !== this.#revision) {
        // The file no longer holds the revision this store last wrote. Either
        // another writer replaced it, or one of this store's own writes
        // committed its rename and then failed afterwards. Both leave the
        // in-memory state unequal to the file, so neither may continue.
        this.#reopenRequired = true;
        throw new CoreStateError(
          "CORE_STATE_REOPEN_REQUIRED",
          `Core state on disk is revision ${current.revision} but this store last wrote ${this.#revision}; another writer replaced it or an earlier write of this store committed and then failed. Reopen the store.`,
        );
      }
      const revision = nextRevision(this.#revision);
      const document = this.#createDocument(
        revision,
        this.#referenceGraph,
        this.#media,
        this.#blocks,
        this.#deliveries,
      );
      try {
        this.#writeDocument(document);
      } catch (error) {
        // The atomic replacement commits at the rename. A failure after that
        // point leaves the new document on disk while this store still holds
        // the old revision, so the store can no longer prove that its memory
        // equals the file and must fail closed rather than continue.
        this.#reopenRequired = true;
        throw error;
      }
      this.#revision = revision;
    });
  }

  #createDocument(
    revision: number,
    referenceGraph: ReferenceGraph,
    media: MediaStore | undefined,
    blocks: BlockStore,
    deliveries: DeliveryStore,
  ): CoreStateDocument {
    const payload: CoreStatePayload = {
      revision,
      referenceGraph: referenceGraph.snapshot(),
      ...(media === undefined ? {} : { media: media.snapshot() }),
      blocks: blocks.snapshot(),
      deliveries: deliveries.snapshot(),
      moduleProcessRecords: [...this.#moduleProcessRecords.values()].sort((a, b) =>
        a.processGenerationId < b.processGenerationId ? -1 : 1,
      ),
      moduleSubmissionRecords: [...this.#moduleSubmissionRecords.values()].sort((a, b) =>
        a.runId < b.runId ? -1 : 1,
      ),
    };
    return deepFreeze({
      schemaVersion: "dolly.core-state/16" as const,
      stateDigest: stateDigest(payload),
      ...payload,
    });
  }

  #readDocument(): CoreStateDocument {
    let bytes: Buffer;
    try {
      if (lstatSync(this.#path).isSymbolicLink()) {
        throw new CoreStateError(
          "CORE_STATE_IO_FAILED",
          "Core state file must not be a symbolic link",
        );
      }
      const size = statSync(this.#path).size;
      if (size > this.#maxBytes) {
        throw new CoreStateError(
          "CORE_STATE_LIMIT_EXCEEDED",
          "Core state file exceeds its configured byte limit",
        );
      }
      bytes = readFileSync(this.#path);
    } catch (error) {
      if (error instanceof CoreStateError) throw error;
      throw new CoreStateError("CORE_STATE_IO_FAILED", "Could not read Core state");
    }

    let value: JsonValue;
    try {
      value = parseStrictJsonBytes(bytes, { maxBytes: this.#maxBytes, maxDepth: 256 });
    } catch {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Core state file is not strict JSON data",
      );
    }
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, JsonValue>).schemaVersion === "dolly.core-state/15"
    ) {
      throw new CoreStateError(
        "CORE_STATE_MIGRATION_REQUIRED",
        "Core state uses dolly.core-state/15 and requires an explicit migration to version 16",
      );
    }
    assertDocumentObject(value);
    if (
      value.schemaVersion !== "dolly.core-state/16" ||
      typeof value.stateDigest !== "string" ||
      !DIGEST_PATTERN.test(value.stateDigest) ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0 ||
      value.referenceGraph === null ||
      typeof value.referenceGraph !== "object" ||
      Array.isArray(value.referenceGraph) ||
      (value.media !== undefined &&
        (value.media === null ||
          typeof value.media !== "object" ||
          Array.isArray(value.media))) ||
      value.blocks === null ||
      typeof value.blocks !== "object" ||
      Array.isArray(value.blocks) ||
      value.deliveries === null ||
      typeof value.deliveries !== "object" ||
      Array.isArray(value.deliveries) ||
      !Array.isArray(value.moduleProcessRecords) ||
      !Array.isArray(value.moduleSubmissionRecords)
    ) {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Core state document schema is invalid",
      );
    }
    let moduleProcessRecords: readonly ModuleProcessRecord[];
    let moduleSubmissionRecords: readonly ModuleSubmissionRecord[];
    try {
      moduleProcessRecords = value.moduleProcessRecords.map((record) => {
        assertValidModuleProcessRecord(record);
        return record;
      });
      moduleSubmissionRecords = value.moduleSubmissionRecords.map((record) => {
        assertValidModuleSubmissionRecord(record);
        return record;
      });
      assertModuleRecordCollectionsConsistent(
        moduleProcessRecords,
        moduleSubmissionRecords,
      );
    } catch (error) {
      const detail =
        error instanceof ModuleProcessRecordError ? `: ${error.message}` : "";
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        `Core state Module records are invalid${detail}`,
      );
    }
    const payload: CoreStatePayload = {
      revision: value.revision as number,
      referenceGraph: value.referenceGraph as unknown as ReferenceGraphSnapshot,
      ...(value.media === undefined
        ? {}
        : { media: value.media as unknown as MediaStoreSnapshot }),
      blocks: value.blocks as unknown as BlockStoreSnapshot,
      deliveries: value.deliveries as unknown as DeliveryStoreSnapshot,
      moduleProcessRecords,
      moduleSubmissionRecords,
    };
    if (stateDigest(payload) !== value.stateDigest) {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Core state document digest does not match its payload",
      );
    }
    return deepFreeze({
      schemaVersion: "dolly.core-state/16" as const,
      stateDigest: value.stateDigest,
      ...payload,
    });
  }

  #writeDocument(document: CoreStateDocument): void {
    atomicWriteCoreStateFile(this.#path, this.#maxBytes, document);
  }

  #withMutationLock<T>(operation: () => T): T {
    try {
      return withSynchronousCrossProcessLock({ resourceId: this.#lockPath }, operation);
    } catch (error) {
      if (!(error instanceof SynchronousCrossProcessLockError)) throw error;
      if (error.code === "CROSS_PROCESS_LOCK_HELD") {
        throw new CoreStateError(
          "CORE_STATE_LOCKED",
          "Another writer owns the Core state lock",
        );
      }
      throw new CoreStateError(
        "CORE_STATE_IO_FAILED",
        `Crash-recoverable Core state locking failed: ${error.message}`,
      );
    }
  }
}

function atomicWriteCoreStateFile(
  path: string,
  maxBytes: number,
  document: unknown,
): void {
  assertJsonValue(document);
  const payload = `${canonicalizeJson(document)}\n`;
  if (Buffer.byteLength(payload, "utf8") > maxBytes) {
    throw new CoreStateError(
      "CORE_STATE_LIMIT_EXCEEDED",
      "Core state update exceeds its configured byte limit",
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
    if (error instanceof CoreStateError) throw error;
    throw new CoreStateError("CORE_STATE_IO_FAILED", "Atomic Core state write failed");
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
        // A same-directory temporary file is never committed state.
      }
    }
  }
}

export type CoreStateMigrationResult = "migrated" | "already-current";

/**
 * Explicitly migrates one Core-state file from `dolly.core-state/15` to
 * `dolly.core-state/16` by adding empty Module process and submission record
 * collections. Per ADR 0009, the caller is responsible for running this only
 * on a stopped instance with no old Dolly process; this function takes the
 * same cross-process Core-state lock, verifies the version 15 digest, writes
 * a `.v15.backup` copy of the original bytes, and atomically replaces the
 * document. It never migrates silently and never alters an already current
 * file.
 */
export function migrateCoreStateDocumentToVersion16(
  path: string,
  options: { readonly maxBytes?: number } = {},
): CoreStateMigrationResult {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes(String.fromCharCode(0))
  ) {
    throw new CoreStateError("CORE_STATE_PATH_INVALID", "Core state path is invalid");
  }
  const resolved = resolve(path);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const run = (): CoreStateMigrationResult => {
    let raw: Buffer;
    try {
      if (lstatSync(resolved).isSymbolicLink()) {
        throw new CoreStateError(
          "CORE_STATE_IO_FAILED",
          "Core state file must not be a symbolic link",
        );
      }
      if (statSync(resolved).size > maxBytes) {
        throw new CoreStateError(
          "CORE_STATE_LIMIT_EXCEEDED",
          "Core state file exceeds its configured byte limit",
        );
      }
      raw = readFileSync(resolved);
    } catch (error) {
      if (error instanceof CoreStateError) throw error;
      throw new CoreStateError("CORE_STATE_IO_FAILED", "Could not read Core state");
    }
    let value: JsonValue;
    try {
      value = parseStrictJsonBytes(raw, { maxBytes, maxDepth: 256 });
    } catch {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Core state file is not strict JSON data",
      );
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Core state document must be an object",
      );
    }
    const document = value as Record<string, JsonValue>;
    const basePayload: Record<string, JsonValue> = {
      revision: document.revision as JsonValue,
      referenceGraph: document.referenceGraph as JsonValue,
      ...(document.media === undefined ? {} : { media: document.media }),
      blocks: document.blocks as JsonValue,
      deliveries: document.deliveries as JsonValue,
    };
    if (document.schemaVersion === "dolly.core-state/16") {
      const payload16 = {
        ...basePayload,
        moduleProcessRecords: document.moduleProcessRecords as JsonValue,
        moduleSubmissionRecords: document.moduleSubmissionRecords as JsonValue,
      };
      if (canonicalJsonDigest(payload16) !== document.stateDigest) {
        throw new CoreStateError(
          "CORE_STATE_DOCUMENT_INVALID",
          "Core state document digest does not match its payload",
        );
      }
      return "already-current";
    }
    if (document.schemaVersion !== "dolly.core-state/15") {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Only dolly.core-state/15 can be migrated to version 16",
      );
    }
    if (canonicalJsonDigest(basePayload) !== document.stateDigest) {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Core state version 15 digest does not match its payload",
      );
    }
    const parent = dirname(resolved);
    const backupPath = `${resolved}.v15.backup`;
    let backupDescriptor: number | undefined;
    try {
      backupDescriptor = openSync(backupPath, "wx", 0o600);
      writeFileSync(backupDescriptor, raw);
      fsyncSync(backupDescriptor);
      closeSync(backupDescriptor);
      backupDescriptor = undefined;
      fsyncDirectory(parent);
    } catch (error) {
      if (backupDescriptor !== undefined) {
        try {
          closeSync(backupDescriptor);
        } catch {
          // Preserve the primary failure.
        }
      }
      if (error instanceof CoreStateError) throw error;
      throw new CoreStateError(
        "CORE_STATE_IO_FAILED",
        "Could not create the version 15 backup; remove any stale backup first",
      );
    }
    const migratedPayload = {
      ...basePayload,
      moduleProcessRecords: [] as JsonValue[],
      moduleSubmissionRecords: [] as JsonValue[],
    };
    atomicWriteCoreStateFile(resolved, maxBytes, {
      schemaVersion: "dolly.core-state/16",
      stateDigest: canonicalJsonDigest(migratedPayload),
      ...migratedPayload,
    });
    return "migrated";
  };
  try {
    return withSynchronousCrossProcessLock({ resourceId: `${resolved}.lock` }, run);
  } catch (error) {
    if (error instanceof CoreStateError) throw error;
    if (
      error instanceof SynchronousCrossProcessLockError &&
      error.code === "CROSS_PROCESS_LOCK_HELD"
    ) {
      throw new CoreStateError(
        "CORE_STATE_LOCKED",
        "Another writer owns the Core state lock",
      );
    }
    throw new CoreStateError(
      "CORE_STATE_IO_FAILED",
      "Core state migration failed before its atomic replacement",
    );
  }
}
