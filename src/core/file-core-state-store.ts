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
  type DeliveryClaimIdentity,
  type DeliveryStoreOptions,
  type DeliveryStoreSnapshot,
  type NegativeAcknowledgementRequest,
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
  type ModuleProcessStoppedRecordWriter,
  type ModuleSubmissionRecord,
} from "./module-process-records.js";
import { type ModuleResultCommitOperations } from "./module-result-commit.js";
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

/**
 * Re-establishes durable-file evidence without changing the file's bytes.
 * Migration uses this before reporting an already-current document because a
 * prior atomic rename may have succeeded while its directory synchronization
 * failed.
 */
function synchronizeCoreStateFile(path: string): void {
  let descriptor: number | undefined;
  try {
    const file = lstatSync(path);
    if (file.isSymbolicLink() || !file.isFile()) {
      throw new Error("Core state path is not a regular file");
    }
    descriptor = openSync(path, "r+");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(dirname(path));
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the synchronization failure.
      }
    }
    throw new CoreStateError(
      "CORE_STATE_IO_FAILED",
      "Could not synchronize the current Core state and its directory",
    );
  }
}

interface CoreStateComponentPayload {
  readonly revision: number;
  readonly referenceGraph: ReferenceGraphSnapshot;
  readonly media?: MediaStoreSnapshot;
  readonly blocks: BlockStoreSnapshot;
  readonly deliveries: DeliveryStoreSnapshot;
}

/**
 * The version 17 Core-state fields covered by `stateDigest`. Unlike versions
 * 15 and 16, the digest includes `schemaVersion`, so changing the format label
 * without constructing and validating a new document invalidates the digest.
 */
export interface CoreStatePayload extends CoreStateComponentPayload {
  readonly schemaVersion: "dolly.core-state/17";
  readonly moduleProcessRecords: readonly ModuleProcessRecord[];
  readonly moduleSubmissionRecords: readonly ModuleSubmissionRecord[];
  /**
   * Each item is the exact identity of an active Claim migrated from an older
   * Core-state format where Dolly cannot determine whether the corresponding
   * Module submission record was ever persisted. An item is not a submission
   * record and must not be interpreted as proof that sending was never
   * authorized.
   */
  readonly activeClaimsWithUnknownSubmissionHistory:
    readonly DeliveryClaimIdentity[];
}

export interface CoreStateDocument extends CoreStatePayload {
  readonly stateDigest: string;
}

interface CoreStateVersion15Document extends CoreStateComponentPayload {
  readonly schemaVersion: "dolly.core-state/15";
  readonly stateDigest: string;
}

interface CoreStateVersion16Document extends CoreStateComponentPayload {
  readonly schemaVersion: "dolly.core-state/16";
  readonly stateDigest: string;
  readonly moduleProcessRecords: readonly ModuleProcessRecord[];
  readonly moduleSubmissionRecords: readonly ModuleSubmissionRecord[];
}

type DecodedCoreStateDocument =
  | CoreStateVersion15Document
  | CoreStateVersion16Document
  | CoreStateDocument;

interface ValidatedCoreStateComponents {
  readonly referenceGraph: ReferenceGraph;
  readonly media: MediaStore | undefined;
  readonly blocks: BlockStore;
  readonly deliveries: DeliveryStore;
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

export interface FileCoreStateStoreWithStoppedRecordWriter {
  readonly store: FileCoreStateStore;
  readonly stoppedRecordWriter: ModuleProcessStoppedRecordWriter;
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

export interface CoreStateMigrationOptions {
  readonly maxBytes?: number;
  /**
   * The configuration the stopped instance will use when it next opens this
   * state. Migration restores both the source and target through the same
   * component constructors and configuration as normal startup before it
   * creates a backup or replaces the source file.
   */
  readonly runtimeConfiguration: {
    readonly maxFailedAttempts: number;
    readonly media:
      | {
          readonly enabled: false;
        }
      | {
          readonly enabled: true;
          readonly idNamespace: string;
          readonly maxMediaBytes: number;
          readonly maxTotalMediaBytes: number;
          readonly maxRegistrationRecords: number;
          readonly maxStorageRecords: number;
          readonly maxProviderAccessRecords: number;
          readonly deletedRegistrationRetentionMs: number;
        };
  };
}

function stateDigest(payload: CoreStatePayload): string {
  return canonicalJsonDigest(payload);
}

function assertDocumentObject(
  value: JsonValue,
): asserts value is Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreStateError(
      "CORE_STATE_DOCUMENT_INVALID",
      "Core state document must be an object",
    );
  }
}

function assertDocumentFields(
  value: Record<string, JsonValue>,
  allowedFields: readonly string[],
  schemaVersion: string,
): void {
  const allowed = new Set(allowedFields);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    allowedFields.some(
      (key) => key !== "media" && !Object.prototype.hasOwnProperty.call(value, key),
    )
  ) {
    throw new CoreStateError(
      "CORE_STATE_DOCUMENT_INVALID",
      `Core state ${schemaVersion} document fields are invalid`,
    );
  }
}

const CORE_STATE_BASE_FIELDS = [
  "schemaVersion",
  "stateDigest",
  "revision",
  "referenceGraph",
  "media",
  "blocks",
  "deliveries",
] as const;

function assertCoreStateComponentPayload(
  value: Record<string, JsonValue>,
): asserts value is Record<string, JsonValue> & CoreStateComponentPayload {
  if (
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
    Array.isArray(value.deliveries)
  ) {
    throw new CoreStateError(
      "CORE_STATE_DOCUMENT_INVALID",
      "Core state document schema is invalid",
    );
  }
}

function decodeModuleRecordCollections(
  value: Record<string, JsonValue>,
): {
  readonly moduleProcessRecords: readonly ModuleProcessRecord[];
  readonly moduleSubmissionRecords: readonly ModuleSubmissionRecord[];
} {
  if (
    !Array.isArray(value.moduleProcessRecords) ||
    !Array.isArray(value.moduleSubmissionRecords)
  ) {
    throw new CoreStateError(
      "CORE_STATE_DOCUMENT_INVALID",
      "Core state Module record collections must be arrays",
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
  return { moduleProcessRecords, moduleSubmissionRecords };
}

function decodeUnknownSubmissionHistory(
  value: JsonValue,
): readonly DeliveryClaimIdentity[] {
  if (!Array.isArray(value)) {
    throw new CoreStateError(
      "CORE_STATE_DOCUMENT_INVALID",
      "activeClaimsWithUnknownSubmissionHistory must be an array",
    );
  }
  return value.map((candidate) => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "An active Claim with unknown submission history must be an object",
      );
    }
    const allowed = new Set([
      "moduleJobId",
      "claimToken",
      "runId",
      "attempt",
      "moduleGenerationId",
    ]);
    if (
      Object.keys(candidate).length !== allowed.size ||
      Object.keys(candidate).some((key) => !allowed.has(key)) ||
      typeof candidate.moduleJobId !== "string" ||
      typeof candidate.claimToken !== "string" ||
      typeof candidate.runId !== "string" ||
      !Number.isSafeInteger(candidate.attempt) ||
      (candidate.attempt as number) < 1 ||
      typeof candidate.moduleGenerationId !== "string"
    ) {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "An active Claim with unknown submission history has an invalid identity",
      );
    }
    return deepFreeze({
      moduleJobId: candidate.moduleJobId,
      claimToken: candidate.claimToken,
      runId: candidate.runId,
      attempt: candidate.attempt as number,
      moduleGenerationId: candidate.moduleGenerationId,
    });
  });
}

function componentPayloadFromDocument(
  value: Record<string, JsonValue> & CoreStateComponentPayload,
): CoreStateComponentPayload {
  return {
    revision: value.revision,
    referenceGraph: value.referenceGraph,
    ...(value.media === undefined ? {} : { media: value.media }),
    blocks: value.blocks,
    deliveries: value.deliveries,
  };
}

function decodeCoreStateDocument(value: JsonValue): DecodedCoreStateDocument {
  assertDocumentObject(value);
  const schemaVersion = value.schemaVersion;
  if (
    schemaVersion !== "dolly.core-state/15" &&
    schemaVersion !== "dolly.core-state/16" &&
    schemaVersion !== "dolly.core-state/17"
  ) {
    throw new CoreStateError(
      "CORE_STATE_DOCUMENT_INVALID",
      "Core state schema version is not supported",
    );
  }
  const fields =
    schemaVersion === "dolly.core-state/15"
      ? CORE_STATE_BASE_FIELDS
      : schemaVersion === "dolly.core-state/16"
        ? [
            ...CORE_STATE_BASE_FIELDS,
            "moduleProcessRecords",
            "moduleSubmissionRecords",
          ]
        : [
            ...CORE_STATE_BASE_FIELDS,
            "moduleProcessRecords",
            "moduleSubmissionRecords",
            "activeClaimsWithUnknownSubmissionHistory",
          ];
  assertDocumentFields(value, fields, schemaVersion);
  assertCoreStateComponentPayload(value);
  const components = componentPayloadFromDocument(value);

  if (schemaVersion === "dolly.core-state/15") {
    if (canonicalJsonDigest(components) !== value.stateDigest) {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Core state version 15 digest does not match its payload",
      );
    }
    return deepFreeze({
      schemaVersion,
      stateDigest: value.stateDigest,
      ...components,
    });
  }

  const records = decodeModuleRecordCollections(value);
  if (schemaVersion === "dolly.core-state/16") {
    const legacyDigestPayload = { ...components, ...records };
    if (canonicalJsonDigest(legacyDigestPayload) !== value.stateDigest) {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Core state version 16 digest does not match its payload",
      );
    }
    return deepFreeze({
      schemaVersion,
      stateDigest: value.stateDigest,
      ...legacyDigestPayload,
    });
  }

  const payload: CoreStatePayload = {
    schemaVersion,
    ...components,
    ...records,
    activeClaimsWithUnknownSubmissionHistory:
      decodeUnknownSubmissionHistory(
        value.activeClaimsWithUnknownSubmissionHistory as JsonValue,
      ),
  };
  if (stateDigest(payload) !== value.stateDigest) {
    throw new CoreStateError(
      "CORE_STATE_DOCUMENT_INVALID",
      "Core state version 17 digest does not match its payload",
    );
  }
  return deepFreeze({ stateDigest: value.stateDigest, ...payload });
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createCoreStatePayload(
  revision: number,
  referenceGraph: ReferenceGraph,
  media: MediaStore | undefined,
  blocks: BlockStore,
  deliveries: DeliveryStore,
  moduleProcessRecords: readonly ModuleProcessRecord[],
  moduleSubmissionRecords: readonly ModuleSubmissionRecord[],
  activeClaimsWithUnknownSubmissionHistory:
    readonly DeliveryClaimIdentity[],
): CoreStatePayload {
  return {
    schemaVersion: "dolly.core-state/17",
    revision,
    referenceGraph: referenceGraph.snapshot(),
    ...(media === undefined ? {} : { media: media.snapshot() }),
    blocks: blocks.snapshot(),
    deliveries: deliveries.snapshot(),
    moduleProcessRecords: [...moduleProcessRecords].sort((left, right) =>
      compareText(left.processGenerationId, right.processGenerationId),
    ),
    moduleSubmissionRecords: [...moduleSubmissionRecords].sort((left, right) =>
      compareText(left.runId, right.runId),
    ),
    activeClaimsWithUnknownSubmissionHistory: [
      ...activeClaimsWithUnknownSubmissionHistory,
    ].sort((left, right) => compareText(left.runId, right.runId)),
  };
}

const REFERENCE_GRAPH_PUBLIC_METHODS = [
  "hasNode",
  "hasStrongReference",
  "hasLease",
  "getLease",
  "isReachable",
  "isReachableFromStrongReference",
  "unreachable",
  "strongReferenceCountFor",
  "leaseCountFor",
  "snapshot",
] as const;

const BLOCK_STORE_PUBLIC_METHODS = [
  "isSameBlockStore",
  "get",
  "has",
  "inspectCommitEffect",
  "flushPersistence",
  "snapshot",
  "validateSource",
  "validateInput",
  "normalizeInput",
  "commit",
  "commitOnce",
  "releaseCommitEffect",
  "collectUnreachable",
] as const;

const DELIVERY_STORE_PUBLIC_METHODS = [
  "usesSameBlockStore",
  "flushPersistence",
  "snapshot",
  "createPage",
  "registerConsumer",
  "inspectSubscription",
  "inspectPending",
  "inspectResident",
  "subscribeChanges",
  "append",
  "appendOnce",
  "validateOutputPages",
  "validateClaimPages",
  "inspectClaim",
  "inspectClaimInput",
  "inspectClaimInputBlockIds",
  "inspectClaimInputMediaReferences",
  "inspectAppendEffect",
  "listPageIds",
  "claim",
  "listDeadLetters",
  "listActiveClaims",
  "pruneTerminal",
] as const;

const MEDIA_STORE_PUBLIC_METHODS = [
  "flushPersistence",
  "snapshot",
  "registerMedia",
  "listRegistrations",
  "removeExpiredDeletedRegistrations",
  "recoverRegistrations",
  "releaseRegistration",
  "getMedia",
  "verifyStoredBytes",
  "resolve",
  "storeOriginal",
  "storageRecordCount",
  "listStorageRecords",
  "recoverUploads",
  "retryUpload",
  "cancelUpload",
  "resolveProviderAccess",
  "recordProviderAccessOutcome",
  "markProviderAccessUnknownAfterRestart",
  "listProviderAccessRecords",
  "collectUnreachable",
  "recoverDeletions",
  "retryDeletion",
] as const;

const MODULE_RESULT_COMMIT_BLOCK_METHODS = [
  "validateSource",
  "validateInput",
  "normalizeInput",
  "inspectCommitEffect",
  "commitOnce",
  "releaseCommitEffect",
] as const;

const MODULE_RESULT_COMMIT_DELIVERY_METHODS = [
  "validateOutputPages",
  "inspectClaim",
  "inspectClaimInput",
  "inspectClaimInputBlockIds",
  "inspectClaimInputMediaReferences",
  "inspectAppendEffect",
  "listPageIds",
  "appendOnce",
  "usesSameBlockStore",
] as const;

const BLOCK_STORE_MUTATION_METHODS = new Set<PropertyKey>([
  "flushPersistence",
  "commit",
  "commitOnce",
  "releaseCommitEffect",
  "collectUnreachable",
]);

const DELIVERY_STORE_MUTATION_METHODS = new Set<PropertyKey>([
  "flushPersistence",
  "createPage",
  "registerConsumer",
  "append",
  "appendOnce",
  "claim",
  "pruneTerminal",
]);

const MEDIA_STORE_MUTATION_METHODS = new Set<PropertyKey>([
  "flushPersistence",
  "registerMedia",
  "removeExpiredDeletedRegistrations",
  "recoverRegistrations",
  "releaseRegistration",
  "storeOriginal",
  "recoverUploads",
  "retryUpload",
  "cancelUpload",
  "resolveProviderAccess",
  "recordProviderAccessOutcome",
  "markProviderAccessUnknownAfterRestart",
  "collectUnreachable",
  "recoverDeletions",
  "retryDeletion",
]);

const MEDIA_STORE_ASYNCHRONOUS_MUTATION_METHODS = new Set<PropertyKey>([
  "registerMedia",
  "recoverRegistrations",
  "storeOriginal",
  "recoverUploads",
  "retryUpload",
  "cancelUpload",
  "resolveProviderAccess",
  "collectUnreachable",
  "recoverDeletions",
  "retryDeletion",
]);

const exposedObjectTargets = new WeakMap<object, object>();

/**
 * Exposes only the listed operations of an in-memory component owned by
 * `FileCoreStateStore`. The returned object has no prototype, is frozen, and
 * contains wrappers rather than the component's own methods. This keeps the
 * underlying component and its persistence controls unreachable while every
 * property access and method call verifies that the store remains usable.
 */
function exposeCheckedObject<T extends object>(options: {
  readonly target: T;
  readonly assertUsable: () => void;
  readonly label: string;
  readonly methods: readonly PropertyKey[];
  readonly properties?: readonly PropertyKey[];
  readonly replacements?: ReadonlyMap<PropertyKey, unknown>;
  readonly mutationMethods?: ReadonlySet<PropertyKey>;
  readonly asynchronousMutationMethods?: ReadonlySet<PropertyKey>;
  readonly invokeMutation?: (
    property: PropertyKey,
    asynchronous: boolean,
    operation: () => unknown,
  ) => unknown;
}): T {
  const exposed = Object.create(null) as Record<PropertyKey, unknown>;
  const defined = new Set<PropertyKey>();
  for (const property of options.methods) {
    if (defined.has(property)) {
      throw new TypeError(
        `${options.label}.${String(property)} is listed more than once`,
      );
    }
    defined.add(property);
    const method = (
      options.replacements?.has(property)
        ? options.replacements.get(property)
        : Reflect.get(options.target, property, options.target)
    ) as unknown;
    if (typeof method !== "function") {
      throw new TypeError(
        `${options.label}.${String(property)} is not a method`,
      );
    }
    Object.defineProperty(exposed, property, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (...args: unknown[]) => {
        options.assertUsable();
        const copiedArguments = args.map((argument) =>
          argument !== null &&
          (typeof argument === "object" || typeof argument === "function")
            ? exposedObjectTargets.get(argument) ?? argument
            : argument);
        const operation = () =>
          Reflect.apply(method, options.target, copiedArguments) as unknown;
        if (!options.mutationMethods?.has(property)) return operation();
        if (options.invokeMutation === undefined) {
          throw new TypeError(
            `${options.label}.${String(property)} has no mutation boundary`,
          );
        }
        return options.invokeMutation(
          property,
          options.asynchronousMutationMethods?.has(property) ?? false,
          operation,
        );
      },
    });
  }
  for (const property of options.properties ?? []) {
    if (defined.has(property)) {
      throw new TypeError(
        `${options.label}.${String(property)} is listed more than once`,
      );
    }
    defined.add(property);
    if (
      !options.replacements?.has(property) &&
      !(property in options.target)
    ) {
      throw new TypeError(
        `${options.label}.${String(property)} is not a property`,
      );
    }
    Object.defineProperty(exposed, property, {
      configurable: false,
      enumerable: true,
      get() {
        options.assertUsable();
        return options.replacements?.has(property)
          ? options.replacements.get(property)
          : Reflect.get(options.target, property, options.target);
      },
    });
  }
  exposedObjectTargets.set(exposed, options.target);
  return Object.freeze(exposed) as T;
}

function copyAndFreezeClaimIdentity(
  input: DeliveryClaimIdentity,
): DeliveryClaimIdentity {
  const moduleJobId = input.moduleJobId;
  const claimToken = input.claimToken;
  const runId = input.runId;
  const attempt = input.attempt;
  const moduleGenerationId = input.moduleGenerationId;
  return Object.freeze({
    moduleJobId,
    claimToken,
    runId,
    attempt,
    moduleGenerationId,
  });
}

function copyAndFreezeNegativeAcknowledgement(
  input: NegativeAcknowledgementRequest,
): NegativeAcknowledgementRequest {
  const identity = copyAndFreezeClaimIdentity(input);
  const suppliedFailure = input.failure as unknown;
  const failureCode =
    suppliedFailure !== null && typeof suppliedFailure === "object"
      ? Reflect.get(suppliedFailure, "code")
      : undefined;
  const retryable =
    suppliedFailure !== null && typeof suppliedFailure === "object"
      ? Reflect.get(suppliedFailure, "retryable")
      : undefined;
  return Object.freeze({
    ...identity,
    failure: Object.freeze({
      code: failureCode,
      retryable,
    }),
  }) as NegativeAcknowledgementRequest;
}

const MODULE_PROCESS_RECORD_FIELDS = new Set([
  "schemaVersion",
  "instanceId",
  "moduleId",
  "moduleGenerationId",
  "processGenerationId",
  "packageDigest",
  "configurationReference",
  "declaredExternalEffects",
  "serviceInvocationId",
  "bootId",
  "moduleCgroupPath",
  "state",
  "createdAt",
  "updatedAt",
  "diagnosticPid",
  "failureCode",
]);

const MODULE_PROCESS_CONFIGURATION_FIELDS = new Set([
  "configId",
  "revision",
  "configVersion",
]);

const MODULE_SUBMISSION_RECORD_FIELDS = new Set([
  "schemaVersion",
  "moduleJobId",
  "claimToken",
  "runId",
  "attempt",
  "moduleGenerationId",
  "processGenerationId",
  "inputDigest",
  "createdAt",
]);

function copyUnrecognizedFields(
  source: Record<string, unknown>,
  sourceKeys: readonly string[],
  recognizedFields: ReadonlySet<string>,
  target: Record<string, unknown>,
): void {
  for (const key of sourceKeys) {
    if (!recognizedFields.has(key)) {
      target[key] = Reflect.get(source, key);
    }
  }
}

function copyModuleProcessRecordInput(input: ModuleProcessRecord): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const source = input as unknown as Record<string, unknown>;
  const sourceKeys = Object.keys(source);
  const configurationInput = Reflect.get(source, "configurationReference") as unknown;
  let configurationReference: unknown = configurationInput;
  if (
    configurationInput !== null &&
    typeof configurationInput === "object" &&
    !Array.isArray(configurationInput)
  ) {
    const configurationSource =
      configurationInput as Record<string, unknown>;
    const configurationKeys = Object.keys(configurationSource);
    const copiedConfiguration: Record<string, unknown> = {
      configId: Reflect.get(configurationSource, "configId"),
      revision: Reflect.get(configurationSource, "revision"),
      configVersion: Reflect.get(configurationSource, "configVersion"),
    };
    copyUnrecognizedFields(
      configurationSource,
      configurationKeys,
      MODULE_PROCESS_CONFIGURATION_FIELDS,
      copiedConfiguration,
    );
    configurationReference = copiedConfiguration;
  }

  const diagnosticPid = Reflect.get(source, "diagnosticPid") as unknown;
  const failureCode = Reflect.get(source, "failureCode") as unknown;
  const copied: Record<string, unknown> = {
    schemaVersion: Reflect.get(source, "schemaVersion"),
    instanceId: Reflect.get(source, "instanceId"),
    moduleId: Reflect.get(source, "moduleId"),
    moduleGenerationId: Reflect.get(source, "moduleGenerationId"),
    processGenerationId: Reflect.get(source, "processGenerationId"),
    packageDigest: Reflect.get(source, "packageDigest"),
    configurationReference,
    declaredExternalEffects: Reflect.get(source, "declaredExternalEffects"),
    serviceInvocationId: Reflect.get(source, "serviceInvocationId"),
    bootId: Reflect.get(source, "bootId"),
    moduleCgroupPath: Reflect.get(source, "moduleCgroupPath"),
    state: Reflect.get(source, "state"),
    createdAt: Reflect.get(source, "createdAt"),
    updatedAt: Reflect.get(source, "updatedAt"),
    ...(diagnosticPid === undefined ? {} : { diagnosticPid }),
    ...(failureCode === undefined ? {} : { failureCode }),
  };
  copyUnrecognizedFields(
    source,
    sourceKeys,
    MODULE_PROCESS_RECORD_FIELDS,
    copied,
  );
  return copied;
}

function copyModuleSubmissionRecordInput(
  input: ModuleSubmissionRecord,
): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const source = input as unknown as Record<string, unknown>;
  const sourceKeys = Object.keys(source);
  const copied: Record<string, unknown> = {
    schemaVersion: Reflect.get(source, "schemaVersion"),
    moduleJobId: Reflect.get(source, "moduleJobId"),
    claimToken: Reflect.get(source, "claimToken"),
    runId: Reflect.get(source, "runId"),
    attempt: Reflect.get(source, "attempt"),
    moduleGenerationId: Reflect.get(source, "moduleGenerationId"),
    processGenerationId: Reflect.get(source, "processGenerationId"),
    inputDigest: Reflect.get(source, "inputDigest"),
    createdAt: Reflect.get(source, "createdAt"),
  };
  copyUnrecognizedFields(
    source,
    sourceKeys,
    MODULE_SUBMISSION_RECORD_FIELDS,
    copied,
  );
  return copied;
}

/**
 * Verifies the part of the Core-state document that crosses the Delivery,
 * Module process, and Module submission record collections.
 */
function assertSubmissionRecordsMatchActiveClaims(
  deliveries: DeliveryStore,
  processRecords: readonly ModuleProcessRecord[],
  submissionRecords: readonly ModuleSubmissionRecord[],
  activeClaimsWithUnknownSubmissionHistory:
    readonly DeliveryClaimIdentity[],
): void {
  const processByGeneration = new Map(
    processRecords.map((record) => [record.processGenerationId, record]),
  );
  const submittedRuns = new Set(
    submissionRecords.map((record) => record.runId),
  );
  const unknownHistoryRuns = new Set<string>();
  try {
    for (const submission of submissionRecords) {
      const claim = deliveries.inspectClaim(submission);
      const processRecord = processByGeneration.get(submission.processGenerationId);
      if (
        claim.status !== "active" ||
        processRecord === undefined ||
        processRecord.state === "starting" ||
        claim.consumerId !== processRecord.moduleId ||
        submission.moduleGenerationId !== processRecord.moduleGenerationId ||
        canonicalJsonDigest(deliveries.inspectClaimInput(submission)) !== submission.inputDigest
      ) {
        throw new Error("Module submission record does not match active Core state");
      }
    }
    for (const identity of activeClaimsWithUnknownSubmissionHistory) {
      if (
        submittedRuns.has(identity.runId) ||
        unknownHistoryRuns.has(identity.runId) ||
        deliveries.inspectClaim(identity).status !== "active"
      ) {
        throw new Error(
          "Unknown submission history does not match one active Claim",
        );
      }
      unknownHistoryRuns.add(identity.runId);
    }
  } catch {
    throw new CoreStateError(
      "CORE_STATE_DOCUMENT_INVALID",
      "Every Module submission record and unknown submission-history item must match one exact active Claim, and the two collections must be disjoint",
    );
  }
}

const MIGRATION_MEDIA_BYTES: MediaByteStore = {
  durability: "persistent",
  async put(): Promise<void> {
    throw new Error("Core-state migration does not access Media bytes");
  },
  async get(): Promise<Uint8Array> {
    throw new Error("Core-state migration does not access Media bytes");
  },
  async delete(): Promise<void> {
    throw new Error("Core-state migration does not access Media bytes");
  },
  async has(): Promise<boolean> {
    throw new Error("Core-state migration does not access Media bytes");
  },
};

interface CoreStateComponentRestoreOptions {
  readonly maxFailedAttempts: number;
  readonly nextBlockId: () => string;
  readonly nextDeliveryId: DeliveryStoreOptions["nextId"];
  readonly now: () => string;
  readonly blockLimits?: Partial<BlockStoreLimits>;
  readonly media?: FileCoreMediaOptions;
}

function restoreCoreStateComponents(
  document: DecodedCoreStateDocument,
  options: CoreStateComponentRestoreOptions,
): ValidatedCoreStateComponents {
  if ((document.media === undefined) !== (options.media === undefined)) {
    throw new Error("Configured Media durability does not match the state document");
  }
  const referenceGraph = new ReferenceGraph({ snapshot: document.referenceGraph });
  const media =
    options.media === undefined
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
  return { referenceGraph, media, blocks, deliveries };
}

/**
 * Runs the normal component decoders during migration. The byte and inspection
 * methods are deliberately unusable because migration validates only the
 * closed persisted metadata document and performs no external Media access.
 */
function validateCoreStateComponents(
  document: DecodedCoreStateDocument,
  runtimeConfiguration?: CoreStateMigrationOptions["runtimeConfiguration"],
): ValidatedCoreStateComponents {
  try {
    const now = () => "1970-01-01T00:00:00.000Z";
    const migrationMedia =
      runtimeConfiguration === undefined
        ? document.media === undefined
          ? undefined
          : {
              durability: "persistent" as const,
              bytes: MIGRATION_MEDIA_BYTES,
              inspector: {
                async inspect() {
                  throw new Error(
                    "Core-state migration does not inspect Media bytes",
                  );
                },
              },
              maxMediaBytes: Number.MAX_SAFE_INTEGER,
              maxTotalMediaBytes: Number.MAX_SAFE_INTEGER,
              maxRegistrationRecords: Number.MAX_SAFE_INTEGER,
              maxStorageRecords: Number.MAX_SAFE_INTEGER,
              maxProviderAccessRecords: Number.MAX_SAFE_INTEGER,
              deletedRegistrationRetentionMs: Number.MAX_SAFE_INTEGER,
              idNamespace: document.media.idNamespace,
            }
        : runtimeConfiguration.media.enabled
          ? {
              durability: "persistent" as const,
              bytes: MIGRATION_MEDIA_BYTES,
              inspector: {
                async inspect() {
                  throw new Error(
                    "Core-state migration does not inspect Media bytes",
                  );
                },
              },
              maxMediaBytes: runtimeConfiguration.media.maxMediaBytes,
              maxTotalMediaBytes: runtimeConfiguration.media.maxTotalMediaBytes,
              maxRegistrationRecords:
                runtimeConfiguration.media.maxRegistrationRecords,
              maxStorageRecords: runtimeConfiguration.media.maxStorageRecords,
              maxProviderAccessRecords:
                runtimeConfiguration.media.maxProviderAccessRecords,
              deletedRegistrationRetentionMs:
                runtimeConfiguration.media.deletedRegistrationRetentionMs,
              idNamespace: runtimeConfiguration.media.idNamespace,
            }
          : undefined;
    const components = restoreCoreStateComponents(document, {
      maxFailedAttempts:
        runtimeConfiguration?.maxFailedAttempts ??
        document.deliveries.maxFailedAttempts,
      nextBlockId: () => {
        throw new Error("Core-state migration does not allocate Block IDs");
      },
      nextDeliveryId: () => {
        throw new Error("Core-state migration does not allocate Delivery IDs");
      },
      now,
      ...(migrationMedia === undefined ? {} : { media: migrationMedia }),
    });
    const processRecords =
      document.schemaVersion === "dolly.core-state/15"
        ? []
        : document.moduleProcessRecords;
    const submissionRecords =
      document.schemaVersion === "dolly.core-state/15"
        ? []
        : document.moduleSubmissionRecords;
    const unknownHistory =
      document.schemaVersion === "dolly.core-state/17"
        ? document.activeClaimsWithUnknownSubmissionHistory
        : [];
    assertSubmissionRecordsMatchActiveClaims(
      components.deliveries,
      processRecords,
      submissionRecords,
      unknownHistory,
    );
    return components;
  } catch (error) {
    if (error instanceof CoreStateError) throw error;
    throw new CoreStateError(
      "CORE_STATE_DOCUMENT_INVALID",
      "Core state component snapshots or their cross-component references are invalid",
    );
  }
}

/**
 * The ReferenceGraph operations exposed by FileCore state. This is a
 * read-only object, not a ReferenceGraph instance, because graph mutations
 * must be persisted through the owning FileCore operation.
 */
export type FileCoreReferenceGraphOperations = Pick<
  ReferenceGraph,
  (typeof REFERENCE_GRAPH_PUBLIC_METHODS)[number]
>;

/**
 * The Block operations exposed by FileCore state. This frozen object retains
 * the normal persisted Block API but omits persistence-observer replacement
 * and does not have BlockStore's class identity.
 */
export type FileCoreBlockOperations = Pick<
  BlockStore,
  Exclude<(typeof BLOCK_STORE_PUBLIC_METHODS)[number], "isSameBlockStore">
> & {
  readonly isSameBlockStore: (
    other: FileCoreBlockOperations | BlockStore,
  ) => boolean;
  readonly size: number;
  readonly referenceGraph: FileCoreReferenceGraphOperations;
};

/**
 * The Delivery operations exposed by FileCore state. Exact Claim terminal
 * changes are omitted because FileCore must update the matching Module
 * submission record in the same persisted state change.
 */
export type FileCoreDeliveryOperations = Pick<
  DeliveryStore,
  Exclude<(typeof DELIVERY_STORE_PUBLIC_METHODS)[number], "usesSameBlockStore">
> & {
  readonly usesSameBlockStore: (
    blocks: FileCoreBlockOperations | BlockStore,
  ) => boolean;
};

/**
 * The Media operations exposed by FileCore state. This frozen object omits
 * persistence-observer replacement and exposes only the read-only graph
 * operations owned by the same FileCore state.
 */
export type FileCoreMediaOperations = Pick<
  MediaStore,
  (typeof MEDIA_STORE_PUBLIC_METHODS)[number]
> & {
  readonly referenceGraph: FileCoreReferenceGraphOperations;
};

const pendingStoppedRecordWriters = new WeakMap<
  FileCoreStateStore,
  ModuleProcessStoppedRecordWriter
>();

export class FileCoreStateStore {
  readonly referenceGraph: FileCoreReferenceGraphOperations;
  readonly media: FileCoreMediaOperations | undefined;
  readonly blocks: FileCoreBlockOperations;
  readonly deliveries: FileCoreDeliveryOperations;
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
  readonly #activeClaimsWithUnknownSubmissionHistory =
    new Map<string, DeliveryClaimIdentity>();
  #revision: number;
  #deferPersistence = false;
  #deferredMutation = false;
  #reopenRequired = false;
  #componentMutationInProgress = false;
  #configuredCallbackInProgress = false;
  readonly #deliveryChangeListeners = new Set<() => void>();
  #deliveryChangePending = false;
  #persistedStateDigest: string;

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
    const now = () => this.#invokeConfiguredCallback(options.now);
    const nextBlockId = () =>
      this.#invokeConfiguredCallback(options.nextBlockId);
    const nextDeliveryId: DeliveryStoreOptions["nextId"] = (kind) =>
      this.#invokeConfiguredCallback(options.nextDeliveryId, kind);
    this.#now = now;
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
          now,
          onMutation: () => undefined,
        });
      }
      const blocks = new BlockStore({
        nextBlockId,
        now,
        referenceGraph,
        ...(media === undefined ? {} : { media }),
        ...(options.blockLimits === undefined ? {} : { limits: options.blockLimits }),
      });
      const deliveries = new DeliveryStore({
        blocks,
        maxFailedAttempts: options.maxFailedAttempts,
        nextId: nextDeliveryId,
        now,
      });
      const initial = this.#createDocument(0, referenceGraph, media, blocks, deliveries);
      this.#writeDocument(initial);
      return initial;
    });

    this.#revision = document.revision;
    this.#persistedStateDigest = document.stateDigest;
    let loaded: ValidatedCoreStateComponents;
    try {
      loaded = restoreCoreStateComponents(document, {
        maxFailedAttempts: options.maxFailedAttempts,
        nextBlockId,
        nextDeliveryId,
        now,
        ...(options.blockLimits === undefined
          ? {}
          : { blockLimits: options.blockLimits }),
        ...(options.media === undefined ? {} : { media: options.media }),
      });
    } catch {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Core state components are inconsistent",
      );
    }
    assertSubmissionRecordsMatchActiveClaims(
      loaded.deliveries,
      document.moduleProcessRecords,
      document.moduleSubmissionRecords,
      document.activeClaimsWithUnknownSubmissionHistory,
    );
    const reconstructedPayload = createCoreStatePayload(
      document.revision,
      loaded.referenceGraph,
      loaded.media,
      loaded.blocks,
      loaded.deliveries,
      document.moduleProcessRecords,
      document.moduleSubmissionRecords,
      document.activeClaimsWithUnknownSubmissionHistory,
    );
    if (stateDigest(reconstructedPayload) !== document.stateDigest) {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Core state component snapshots and record collections are not in their persisted canonical order",
      );
    }

    this.#referenceGraph = loaded.referenceGraph;
    this.#media = loaded.media;
    this.#blocks = loaded.blocks;
    this.#deliveries = loaded.deliveries;
    const assertUsable = () => this.#assertUsable();
    const invokeMutation = (
      _property: PropertyKey,
      asynchronous: boolean,
      operation: () => unknown,
    ) => this.#invokeComponentMutation(asynchronous, operation);
    this.referenceGraph = exposeCheckedObject({
      target: this.#referenceGraph,
      assertUsable,
      label: "FileCoreStateStore.referenceGraph",
      methods: REFERENCE_GRAPH_PUBLIC_METHODS,
    }) as unknown as FileCoreReferenceGraphOperations;
    this.media = this.#media === undefined
      ? undefined
      : exposeCheckedObject({
          target: this.#media,
          assertUsable,
          label: "FileCoreStateStore.media",
          methods: MEDIA_STORE_PUBLIC_METHODS,
          properties: ["referenceGraph"],
          replacements: new Map([["referenceGraph", this.referenceGraph]]),
          mutationMethods: MEDIA_STORE_MUTATION_METHODS,
          asynchronousMutationMethods: MEDIA_STORE_ASYNCHRONOUS_MUTATION_METHODS,
          invokeMutation,
        }) as unknown as FileCoreMediaOperations;
    this.blocks = exposeCheckedObject({
      target: this.#blocks,
      assertUsable,
      label: "FileCoreStateStore.blocks",
      methods: BLOCK_STORE_PUBLIC_METHODS,
      properties: ["size", "referenceGraph"],
      replacements: new Map([["referenceGraph", this.referenceGraph]]),
      mutationMethods: BLOCK_STORE_MUTATION_METHODS,
      invokeMutation,
    }) as unknown as FileCoreBlockOperations;
    this.deliveries = exposeCheckedObject({
      target: this.#deliveries,
      assertUsable,
      label: "FileCoreStateStore.deliveries",
      methods: DELIVERY_STORE_PUBLIC_METHODS,
      replacements: new Map([
        ["subscribeChanges", (listener: () => void) => this.#subscribeDeliveryChanges(listener)],
      ]),
      mutationMethods: DELIVERY_STORE_MUTATION_METHODS,
      invokeMutation,
    }) as unknown as FileCoreDeliveryOperations;
    Object.defineProperties(this, {
      referenceGraph: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: this.referenceGraph,
      },
      media: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: this.media,
      },
      blocks: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: this.blocks,
      },
      deliveries: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: this.deliveries,
      },
    });

    for (const record of document.moduleProcessRecords) {
      this.#moduleProcessRecords.set(record.processGenerationId, record);
    }
    for (const record of document.moduleSubmissionRecords) {
      this.#moduleSubmissionRecords.set(record.runId, record);
    }
    for (const identity of document.activeClaimsWithUnknownSubmissionHistory) {
      this.#activeClaimsWithUnknownSubmissionHistory.set(
        identity.runId,
        identity,
      );
    }

    const persist = () => this.#persistCurrent();
    this.#media?.setMutationObserver(persist);
    this.#blocks.setMutationObserver(persist);
    this.#deliveries.setMutationObserver(persist);
    this.#deliveries.subscribeChanges(() => {
      this.#deliveryChangePending = true;
      if (!this.#deferPersistence && !this.#componentMutationInProgress) {
        this.#publishDeliveryChanges();
      }
    });

    // The terminal writer is deliberately not a property of the store. The
    // construction factory below retrieves this frozen, store-bound closure
    // once and distributes it only to stop-proof coordinators.
    pendingStoppedRecordWriters.set(
      this,
      Object.freeze({
        isBoundTo: (record: ModuleProcessRecord) => {
          this.#assertUsable();
          return this.#moduleProcessRecords.get(record.processGenerationId) === record;
        },
        writeStopped: (processGenerationId: string, failureCode?: string) =>
          this.#writeStoppedModuleProcessRecord(processGenerationId, failureCode),
      }),
    );
  }

  /** @internal Only product composition uses this complete operation set. */
  createModuleResultCommitOperations(): ModuleResultCommitOperations {
    this.#assertUsable();
    const assertUsable = () => this.#assertUsable();
    const invokeMutation = (
      _property: PropertyKey,
      asynchronous: boolean,
      operation: () => unknown,
    ) => this.#invokeComponentMutation(asynchronous, operation);
    const blocks = exposeCheckedObject({
      target: this.#blocks,
      assertUsable,
      label: "FileCoreStateStore Module result Block operations",
      methods: MODULE_RESULT_COMMIT_BLOCK_METHODS,
      mutationMethods: BLOCK_STORE_MUTATION_METHODS,
      invokeMutation,
    });
    const deliveries = exposeCheckedObject({
      target: this.#deliveries,
      assertUsable,
      label: "FileCoreStateStore Module result Delivery operations",
      methods: MODULE_RESULT_COMMIT_DELIVERY_METHODS,
      mutationMethods: DELIVERY_STORE_MUTATION_METHODS,
      invokeMutation,
    });
    const operations = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperties(operations, {
      blocks: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: blocks,
      },
      deliveries: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: deliveries,
      },
      getModuleSubmissionRecord: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: (runId: string) => {
          this.#assertUsable();
          return this.#moduleSubmissionRecords.get(runId);
        },
      },
      acknowledgeDeliveryClaim: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: (identity: DeliveryClaimIdentity) =>
          this.#applyClaimTerminalState(
            identity,
            copyAndFreezeClaimIdentity,
            true,
            (copiedIdentity) => this.#deliveries.ack(copiedIdentity),
          ),
      },
    });
    return Object.freeze(operations) as unknown as ModuleResultCommitOperations;
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
   * Lists exact active Claim identities whose migrated history cannot prove
   * whether a matching Module submission record was ever persisted.
   */
  listActiveClaimsWithUnknownSubmissionHistory():
    readonly DeliveryClaimIdentity[] {
    this.#assertUsable();
    return [...this.#activeClaimsWithUnknownSubmissionHistory.values()].sort(
      (left, right) => compareText(left.runId, right.runId),
    );
  }

  /**
   * Returns whether the supplied five fields exactly identify an active Claim
   * whose migrated submission history is unknown.
   */
  hasActiveClaimWithUnknownSubmissionHistory(
    suppliedIdentity: DeliveryClaimIdentity,
  ): boolean {
    this.#assertUsable();
    const identity = copyAndFreezeClaimIdentity(suppliedIdentity);
    const existing = this.#activeClaimsWithUnknownSubmissionHistory.get(
      identity.runId,
    );
    return (
      existing !== undefined &&
      existing.moduleJobId === identity.moduleJobId &&
      existing.claimToken === identity.claimToken &&
      existing.runId === identity.runId &&
      existing.attempt === identity.attempt &&
      existing.moduleGenerationId === identity.moduleGenerationId
    );
  }

  /**
   * Persists one Module process record in its `starting` state. The record is
   * durable before any child launcher may be created; the process-generation
   * identifier is never reused, so an existing entry is a conflict.
   */
  appendModuleProcessRecord(record: ModuleProcessRecord): ModuleProcessRecord {
    this.#assertUsable();
    const copiedRecord = copyModuleProcessRecordInput(record);
    assertValidModuleProcessRecord(copiedRecord);
    if (copiedRecord.state !== "starting") {
      throw new ModuleProcessRecordError(
        "MODULE_PROCESS_RECORD_STATE_INVALID",
        "A new Module process record must begin in the starting state",
      );
    }
    if (this.#moduleProcessRecords.has(copiedRecord.processGenerationId)) {
      throw new ModuleProcessRecordError(
        "MODULE_PROCESS_RECORD_CONFLICT",
        `Module process record "${copiedRecord.processGenerationId}" already exists`,
      );
    }
    const stored = deepFreeze(copiedRecord);
    this.#moduleProcessRecords.set(copiedRecord.processGenerationId, stored);
    try {
      this.#persistCurrent();
    } catch (error) {
      this.#moduleProcessRecords.delete(copiedRecord.processGenerationId);
      throw error;
    }
    return stored;
  }

  /**
   * Advances one non-terminal Module process state. The terminal transition
   * is intentionally absent from this generic API, including at runtime for
   * JavaScript callers; only the separately distributed stopped-record writer
   * can perform it after the required process-group proof.
   */
  updateModuleProcessRecordState(
    processGenerationId: string,
    state: "running" | "stopping",
    failureCode?: string,
  ): ModuleProcessRecord {
    if ((state as ModuleProcessRecordState) === "stopped") {
      throw new ModuleProcessRecordError(
        "MODULE_PROCESS_STOP_PROOF_REQUIRED",
        "A Module process record may be marked stopped only through the stop-proof writer",
      );
    }
    return this.#writeModuleProcessRecordState(
      processGenerationId,
      state,
      failureCode,
    );
  }

  #writeStoppedModuleProcessRecord(
    processGenerationId: string,
    failureCode?: string,
  ): ModuleProcessRecord {
    return this.#writeModuleProcessRecordState(
      processGenerationId,
      "stopped",
      failureCode,
    );
  }

  #writeModuleProcessRecordState(
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
    const copiedRecord = copyModuleSubmissionRecordInput(record);
    assertValidModuleSubmissionRecord(copiedRecord);
    if (this.#moduleSubmissionRecords.has(copiedRecord.runId)) {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_CONFLICT",
        `Module submission record for Run "${copiedRecord.runId}" already exists`,
      );
    }
    if (
      this.#activeClaimsWithUnknownSubmissionHistory.has(copiedRecord.runId)
    ) {
      throw new ModuleProcessRecordError(
        "MODULE_CLAIM_SUBMISSION_HISTORY_UNKNOWN",
        "A migrated active Claim with unknown submission history cannot receive another submission record",
      );
    }
    const processRecord = this.#moduleProcessRecords.get(
      copiedRecord.processGenerationId,
    );
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
    if (processRecord.moduleGenerationId !== copiedRecord.moduleGenerationId) {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
        "A Module submission record must match its process record's Module generation",
      );
    }
    let claim: ReturnType<DeliveryStore["inspectClaim"]>;
    let persistedInputDigest: string;
    try {
      claim = this.#deliveries.inspectClaim(copiedRecord);
      persistedInputDigest = canonicalJsonDigest(
        this.#deliveries.inspectClaimInput(copiedRecord),
      );
    } catch {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
        "A Module submission record requires one exact persisted Delivery Claim",
      );
    }
    if (claim.status !== "active") {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
        "A Module submission record requires an active Delivery Claim",
      );
    }
    if (claim.consumerId !== processRecord.moduleId) {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
        "A Module submission record's Claim must belong to the Module process",
      );
    }
    if (copiedRecord.inputDigest !== persistedInputDigest) {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
        "A Module submission record input digest must match the persisted Claim input",
      );
    }
    const stored = deepFreeze(copiedRecord);
    this.#moduleSubmissionRecords.set(copiedRecord.runId, stored);
    try {
      this.#persistCurrent();
    } catch (error) {
      this.#moduleSubmissionRecords.delete(copiedRecord.runId);
      throw error;
    }
    return stored;
  }

  /**
   * Commits one exact Delivery Claim and removes its matching Module
   * submission record in the same Core-state update.
   */
  acknowledgeDeliveryClaim(
    identity: DeliveryClaimIdentity,
  ): "committed" | "already-committed" {
    return this.#applyClaimTerminalState(
      identity,
      copyAndFreezeClaimIdentity,
      true,
      (copiedIdentity) => this.#deliveries.ack(copiedIdentity),
    );
  }

  /**
   * Releases one exact Delivery Claim and removes its matching Module
   * submission record in the same Core-state update.
   */
  releaseDeliveryClaim(
    identity: DeliveryClaimIdentity,
  ): "released" | "already-released" {
    return this.#applyClaimTerminalState(
      identity,
      copyAndFreezeClaimIdentity,
      false,
      (copiedIdentity) => this.#deliveries.releaseClaim(copiedIdentity),
    );
  }

  /**
   * Records one exact Delivery Claim failure and removes its matching Module
   * submission record in the same Core-state update.
   */
  negativelyAcknowledgeDeliveryClaim(
    request: NegativeAcknowledgementRequest,
  ): "retry-scheduled" | "dead-lettered" {
    return this.#applyClaimTerminalState(
      request,
      copyAndFreezeNegativeAcknowledgement,
      false,
      (copiedRequest) => this.#deliveries.nack(copiedRequest),
    );
  }

  #removeModuleSubmissionRecord(runId: string): void {
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
   * references and whose Module generation has no active Claim. Records
   * pinned by unresolved evidence stay in place.
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
    if (
      this.#deliveries
        .listActiveClaims()
        .some((claim) => claim.moduleGenerationId === existing.moduleGenerationId)
    ) {
      throw new ModuleProcessRecordError(
        "MODULE_PROCESS_RECORD_IN_USE",
        "A Module process record for a generation with an active Claim may not be removed",
      );
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
    const unknownSubmissionHistory = new Map(
      this.#activeClaimsWithUnknownSubmissionHistory,
    );
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
      this.#deferredMutation = false;
      this.#deliveryChangePending = false;
      this.#moduleProcessRecords.clear();
      for (const [key, value] of processRecords) this.#moduleProcessRecords.set(key, value);
      this.#moduleSubmissionRecords.clear();
      for (const [key, value] of submissionRecords) {
        this.#moduleSubmissionRecords.set(key, value);
      }
      this.#activeClaimsWithUnknownSubmissionHistory.clear();
      for (const [key, value] of unknownSubmissionHistory) {
        this.#activeClaimsWithUnknownSubmissionHistory.set(key, value);
      }
      if (returnedValue) {
        // An asynchronous continuation could still mutate a component after
        // this callback has returned, so equality at this instant is not
        // enough to keep the store usable.
        this.#reopenRequired = true;
        throw error;
      }
      this.#confirmInMemoryStateMatchesPersistedState();
      throw error;
    }
    this.#deferPersistence = false;
    const mutated = this.#deferredMutation;
    this.#deferredMutation = false;
    if (!mutated) {
      this.#confirmInMemoryStateMatchesPersistedState();
      this.#publishDeliveryChanges();
      return;
    }
    try {
      this.#persistCurrent();
      this.#confirmInMemoryStateMatchesPersistedState();
      this.#publishDeliveryChanges();
    } catch (error) {
      this.#deliveryChangePending = false;
      this.#reopenRequired = true;
      throw error;
    }
  }

  /**
   * Applies one exact Claim terminal change and removes its matching
   * submission record before the single deferred Core-state write.
   */
  #applyClaimTerminalState<
    Request extends DeliveryClaimIdentity,
    Result,
  >(
    suppliedRequest: Request,
    copyRequest: (request: Request) => Request,
    requireSubmission: boolean,
    changeClaim: (request: Request) => Result,
  ): Result {
    this.#assertUsable();
    const request = copyRequest(suppliedRequest);
    const claim = this.#deliveries.inspectClaim(request);
    const submission = this.#moduleSubmissionRecords.get(request.runId);
    if (this.#activeClaimsWithUnknownSubmissionHistory.has(request.runId)) {
      throw new ModuleProcessRecordError(
        "MODULE_CLAIM_SUBMISSION_HISTORY_UNKNOWN",
        "A migrated active Claim with unknown submission history requires an explicit operator disposition before any terminal change",
      );
    }
    if (
      submission !== undefined &&
      (
        submission.moduleJobId !== request.moduleJobId ||
        submission.claimToken !== request.claimToken ||
        submission.runId !== request.runId ||
        submission.attempt !== request.attempt ||
        submission.moduleGenerationId !== request.moduleGenerationId
      )
    ) {
      this.#reopenRequired = true;
      throw new CoreStateError(
        "CORE_STATE_REOPEN_REQUIRED",
        "The Module submission record does not match its exact Delivery Claim; reopen the store",
      );
    }
    if (claim.status !== "active" && submission !== undefined) {
      this.#reopenRequired = true;
      throw new CoreStateError(
        "CORE_STATE_REOPEN_REQUIRED",
        "A terminal Delivery Claim still has a Module submission record; reopen the store",
      );
    }
    if (
      requireSubmission &&
      claim.status === "active" &&
      submission === undefined
    ) {
      throw new ModuleProcessRecordError(
        "MODULE_SUBMISSION_RECORD_NOT_FOUND",
        "An active Delivery Claim requires its exact Module submission record before acknowledgement",
      );
    }

    let result!: Result;
    this.runAtomicUpdate(() => {
      result = changeClaim(request);
      if (submission !== undefined) {
        this.#removeModuleSubmissionRecord(request.runId);
      }
    });
    return result;
  }

  #invokeComponentMutation<Result>(
    asynchronous: boolean,
    operation: () => Result,
  ): Result {
    this.#assertUsable();
    if (this.#deferPersistence) {
      if (asynchronous) {
        throw new CoreStateError(
          "CORE_STATE_IO_FAILED",
          "An asynchronous component mutation cannot run inside an atomic Core state update",
        );
      }
      return operation();
    }

    this.#componentMutationInProgress = true;
    let result: Result;
    try {
      result = operation();
    } catch (error) {
      this.#componentMutationInProgress = false;
      this.#confirmInMemoryStateMatchesPersistedState();
      this.#publishDeliveryChanges();
      throw error;
    }

    const possiblePromise = result as unknown;
    if (
      possiblePromise !== null &&
      (typeof possiblePromise === "object" || typeof possiblePromise === "function") &&
      typeof (possiblePromise as PromiseLike<unknown>).then === "function"
    ) {
      return Promise.resolve(possiblePromise).then(
        (value) => {
          this.#componentMutationInProgress = false;
          this.#confirmInMemoryStateMatchesPersistedState();
          this.#publishDeliveryChanges();
          return value;
        },
        (error: unknown) => {
          this.#componentMutationInProgress = false;
          this.#confirmInMemoryStateMatchesPersistedState();
          this.#publishDeliveryChanges();
          throw error;
        },
      ) as Result;
    }

    this.#componentMutationInProgress = false;
    this.#confirmInMemoryStateMatchesPersistedState();
    this.#publishDeliveryChanges();
    return result;
  }

  #subscribeDeliveryChanges(listener: () => void): () => void {
    this.#assertUsable();
    if (typeof listener !== "function") {
      throw new TypeError("FileCoreStateStore Delivery change listener must be a function");
    }
    this.#deliveryChangeListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#deliveryChangeListeners.delete(listener);
    };
  }

  #publishDeliveryChanges(): void {
    if (!this.#deliveryChangePending) return;
    this.#deliveryChangePending = false;
    for (const listener of [...this.#deliveryChangeListeners]) {
      try {
        const result: unknown = listener();
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof (result as { readonly then?: unknown }).then === "function"
        ) {
          void Promise.resolve(result).catch(() => undefined);
        }
      } catch {
        // Delivery-change listeners are wake-up hints and cannot change the
        // result of an already persisted Core-state update.
      }
    }
  }

  #invokeConfiguredCallback<Arguments extends readonly unknown[], Result>(
    callback: (...args: Arguments) => Result,
    ...args: Arguments
  ): Result {
    if (this.#configuredCallbackInProgress) {
      throw new CoreStateError(
        "CORE_STATE_LOCKED",
        "A configured Core callback is already running",
      );
    }
    this.#configuredCallbackInProgress = true;
    try {
      return callback(...args);
    } finally {
      this.#configuredCallbackInProgress = false;
    }
  }

  #confirmInMemoryStateMatchesPersistedState(): void {
    try {
      const current = this.#createDocument(
        this.#revision,
        this.#referenceGraph,
        this.#media,
        this.#blocks,
        this.#deliveries,
      );
      if (current.stateDigest === this.#persistedStateDigest) return;
    } catch {
      // Failure to serialize all current component state is itself a loss of
      // proof that memory still equals the last successful write.
    }
    this.#reopenRequired = true;
    throw new CoreStateError(
      "CORE_STATE_REOPEN_REQUIRED",
      "In-memory Core state no longer matches the last successful write; reopen the store",
    );
  }

  #assertUsable(): void {
    if (this.#reopenRequired) {
      throw new CoreStateError(
        "CORE_STATE_REOPEN_REQUIRED",
        "This Core state store failed an update and must be reopened",
      );
    }
    if (this.#componentMutationInProgress) {
      throw new CoreStateError(
        "CORE_STATE_LOCKED",
        "A Core state component mutation is still in progress",
      );
    }
    if (this.#configuredCallbackInProgress) {
      throw new CoreStateError(
        "CORE_STATE_LOCKED",
        "Core state cannot be accessed from its configured clock or identifier generator",
      );
    }
  }

  #assertPersistenceUsable(): void {
    if (this.#reopenRequired) {
      throw new CoreStateError(
        "CORE_STATE_REOPEN_REQUIRED",
        "This Core state store failed an update and must be reopened",
      );
    }
  }

  #persistCurrent(): void {
    this.#assertPersistenceUsable();
    if (this.#deferPersistence) {
      this.#deferredMutation = true;
      return;
    }
    this.#withMutationLock(() => {
      const current = this.#readDocument();
      if (
        current.revision !== this.#revision ||
        current.stateDigest !== this.#persistedStateDigest
      ) {
        // The file no longer holds the revision and content this store last
        // wrote. Either another writer replaced it, or one of this store's own
        // writes committed its rename and then failed afterwards. Both leave
        // the in-memory state unequal to the file, so neither may continue.
        this.#reopenRequired = true;
        throw new CoreStateError(
          "CORE_STATE_REOPEN_REQUIRED",
          "Core state on disk no longer matches the revision and digest this store last wrote; another writer replaced it or an earlier write of this store committed and then failed. Reopen the store.",
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
      this.#persistedStateDigest = document.stateDigest;
    });
  }

  #createDocument(
    revision: number,
    referenceGraph: ReferenceGraph,
    media: MediaStore | undefined,
    blocks: BlockStore,
    deliveries: DeliveryStore,
  ): CoreStateDocument {
    const payload = createCoreStatePayload(
      revision,
      referenceGraph,
      media,
      blocks,
      deliveries,
      [...this.#moduleProcessRecords.values()],
      [...this.#moduleSubmissionRecords.values()],
      [...this.#activeClaimsWithUnknownSubmissionHistory.values()],
    );
    return deepFreeze({
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
    const document = decodeCoreStateDocument(value);
    if (document.schemaVersion !== "dolly.core-state/17") {
      // A digest-valid older document can still contain an invalid nested
      // snapshot. Report corruption before suggesting a migration that must
      // refuse the same document.
      validateCoreStateComponents(document);
      throw new CoreStateError(
        "CORE_STATE_MIGRATION_REQUIRED",
        `Core state uses ${document.schemaVersion} and requires an explicit migration to version 17`,
      );
    }
    return document;
  }

  #writeDocument(document: CoreStateDocument): void {
    atomicWriteCoreStateFile(this.#path, this.#maxBytes, document);
  }

  #withMutationLock<T>(operation: () => T): T {
    let operationReturned = false;
    try {
      return withSynchronousCrossProcessLock({ resourceId: this.#lockPath }, () => {
        const result = operation();
        operationReturned = true;
        return result;
      });
    } catch (error) {
      // The lock callback runs only after acquisition. Once it has returned,
      // any error from the surrounding lock call belongs to mandatory release
      // confirmation. The update may already be durable, while a record API
      // may restore its previous in-memory entry when this error propagates.
      if (operationReturned) this.#reopenRequired = true;
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

/**
 * Constructs FileCore state together with its store-bound terminal-write
 * capability. Callers that use `new FileCoreStateStore(...)` receive no way to
 * acquire that capability later. This internal composition function is not
 * re-exported from Dolly's package surface.
 */
export function createFileCoreStateStoreWithStoppedRecordWriter(
  options: FileCoreStateStoreOptions,
): FileCoreStateStoreWithStoppedRecordWriter {
  const store = new FileCoreStateStore(options);
  const stoppedRecordWriter = pendingStoppedRecordWriters.get(store);
  pendingStoppedRecordWriters.delete(store);
  if (stoppedRecordWriter === undefined) {
    throw new CoreStateError(
      "CORE_STATE_IO_FAILED",
      "The Module process stopped-record writer could not be constructed",
    );
  }
  return Object.freeze({ store, stoppedRecordWriter });
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

export type CoreStateMigrationResult =
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

function readCoreStateForMigration(
  path: string,
  maxBytes: number,
): { readonly raw: Buffer; readonly document: DecodedCoreStateDocument } {
  let raw: Buffer;
  try {
    const file = lstatSync(path);
    if (file.isSymbolicLink() || !file.isFile()) {
      throw new CoreStateError(
        "CORE_STATE_IO_FAILED",
        "Core state path must be a regular file and not a symbolic link",
      );
    }
    if (file.size > maxBytes) {
      throw new CoreStateError(
        "CORE_STATE_LIMIT_EXCEEDED",
        "Core state file exceeds its configured byte limit",
      );
    }
    raw = readFileSync(path);
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
  return { raw, document: decodeCoreStateDocument(value) };
}

function createVersion17Document(
  source: CoreStateVersion15Document | CoreStateVersion16Document,
  components: ValidatedCoreStateComponents,
): CoreStateDocument {
  const processRecords =
    source.schemaVersion === "dolly.core-state/15"
      ? []
      : source.moduleProcessRecords;
  const submissionRecords =
    source.schemaVersion === "dolly.core-state/15"
      ? []
      : source.moduleSubmissionRecords;
  const submittedRuns = new Set(
    submissionRecords.map((record) => record.runId),
  );
  const activeClaimsWithUnknownSubmissionHistory = components.deliveries
    .listActiveClaims()
    .filter((claim) => !submittedRuns.has(claim.runId))
    .map((claim) =>
      deepFreeze({
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
      }),
    );
  const payload = createCoreStatePayload(
    nextRevision(source.revision),
    components.referenceGraph,
    components.media,
    components.blocks,
    components.deliveries,
    processRecords,
    submissionRecords,
    activeClaimsWithUnknownSubmissionHistory,
  );
  return deepFreeze({
    stateDigest: stateDigest(payload),
    ...payload,
  });
}

function assertMigrationTargetFits(
  document: CoreStateDocument,
  maxBytes: number,
): void {
  const byteLength = Buffer.byteLength(
    `${canonicalizeJson(document)}\n`,
    "utf8",
  );
  if (byteLength > maxBytes) {
    throw new CoreStateError(
      "CORE_STATE_LIMIT_EXCEEDED",
      "Migrated Core state exceeds its configured byte limit",
    );
  }
}

function assertExistingBackupMatches(
  backupPath: string,
  sourceBytes: Buffer,
): void {
  let descriptor: number | undefined;
  try {
    const file = lstatSync(backupPath);
    if (file.isSymbolicLink() || !file.isFile() || file.size !== sourceBytes.length) {
      throw new Error("Backup is not the exact source file");
    }
    const existing = readFileSync(backupPath);
    if (!existing.equals(sourceBytes)) {
      throw new Error("Backup bytes differ from the source file");
    }
    descriptor = openSync(backupPath, "r+");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(dirname(backupPath));
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the backup validation failure.
      }
    }
    throw new CoreStateError(
      "CORE_STATE_IO_FAILED",
      "An existing Core-state migration backup is not the exact regular source file",
    );
  }
}

function createOrVerifyMigrationBackup(
  backupPath: string,
  sourceBytes: Buffer,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(backupPath, "wx", 0o600);
    writeFileSync(descriptor, sourceBytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(dirname(backupPath));
    return;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the primary backup write failure.
      }
    }
    if (
      error !== null &&
      typeof error === "object" &&
      Reflect.get(error, "code") === "EEXIST"
    ) {
      assertExistingBackupMatches(backupPath, sourceBytes);
      return;
    }
    throw new CoreStateError(
      "CORE_STATE_IO_FAILED",
      "Could not create and synchronize the Core-state migration backup",
    );
  }
}

/**
 * Explicitly migrates a fully validated version 15 or version 16 Core-state
 * file directly to version 17. The caller remains responsible for running this
 * only while the instance is stopped and no older Dolly process can write the
 * file. Migration takes the normal Core-state lock, increments the revision
 * once, writes an exact source-version backup, and atomically replaces the
 * primary file. A retry may reuse only a regular backup whose bytes exactly
 * equal the still-current source file.
 */
export function migrateCoreStateDocumentToVersion17(
  path: string,
  options: CoreStateMigrationOptions,
): CoreStateMigrationResult {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes(String.fromCharCode(0))
  ) {
    throw new CoreStateError(
      "CORE_STATE_PATH_INVALID",
      "Core state path is invalid",
    );
  }
  if (options?.runtimeConfiguration === undefined) {
    throw new TypeError(
      "Core-state migration requires the stopped instance's current runtime configuration",
    );
  }
  const resolved = resolve(path);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
    throw new TypeError("Core state maxBytes must be at least 1024");
  }
  const run = (): CoreStateMigrationResult => {
    const { raw, document } = readCoreStateForMigration(resolved, maxBytes);
    const components = validateCoreStateComponents(
      document,
      options.runtimeConfiguration,
    );
    if (document.schemaVersion === "dolly.core-state/17") {
      const reconstructedPayload = createCoreStatePayload(
        document.revision,
        components.referenceGraph,
        components.media,
        components.blocks,
        components.deliveries,
        document.moduleProcessRecords,
        document.moduleSubmissionRecords,
        document.activeClaimsWithUnknownSubmissionHistory,
      );
      if (stateDigest(reconstructedPayload) !== document.stateDigest) {
        throw new CoreStateError(
          "CORE_STATE_DOCUMENT_INVALID",
          "Core state component snapshots and record collections are not in their persisted canonical order",
        );
      }
      synchronizeCoreStateFile(resolved);
      return deepFreeze({
        status: "already-current" as const,
        schemaVersion: "dolly.core-state/17" as const,
      });
    }

    const migrated = createVersion17Document(document, components);
    const decodedTarget = decodeCoreStateDocument(
      migrated as unknown as JsonValue,
    );
    if (decodedTarget.schemaVersion !== "dolly.core-state/17") {
      throw new CoreStateError(
        "CORE_STATE_DOCUMENT_INVALID",
        "Migration did not construct a version 17 Core-state document",
      );
    }
    validateCoreStateComponents(decodedTarget, options.runtimeConfiguration);
    assertMigrationTargetFits(migrated, maxBytes);

    const sourceVersion = document.schemaVersion;
    const backupPath =
      sourceVersion === "dolly.core-state/15"
        ? `${resolved}.v15.backup`
        : `${resolved}.v16.backup`;
    createOrVerifyMigrationBackup(backupPath, raw);
    atomicWriteCoreStateFile(resolved, maxBytes, migrated);
    return deepFreeze({
      status: "migrated" as const,
      sourceSchemaVersion: sourceVersion,
      backupPath,
    });
  };
  try {
    return withSynchronousCrossProcessLock(
      { resourceId: `${resolved}.lock` },
      run,
    );
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
      "Core state migration completion could not be confirmed; rerun the migration to validate the file on disk",
    );
  }
}
