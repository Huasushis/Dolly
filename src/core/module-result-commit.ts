import {
  assertJsonValue,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  type BlockProposal,
  type BlockStore,
  type SourceIdentity,
} from "./block-store.js";
import {
  contentReferences,
  parseBlockContent,
  type BlockReferenceItem,
  type MediaReferenceItem,
  type Rect,
} from "./block-content.js";
import {
  type ClaimDescriptor,
  type DeliveryClaimIdentity,
  type DeliveryOutputEffectInput,
  type DeliveryStore,
} from "./delivery-store.js";
import {
  assertValidModuleSubmissionRecord,
  type ModuleSubmissionRecord,
} from "./module-process-records.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * A ModuleResultCommit is the recoverable journal entry that applies one
 * ModuleJob result to Block and Delivery stores and then acknowledges its
 * input. It is not called a transaction because those effects are persisted
 * separately and resumed idempotently after interruption.
 */
export type ModuleResultCommitState = "prepared" | "committed";

export interface ModuleResultCommitOutputDelivery {
  readonly pageId: string;
  readonly deliveryId: string;
}

export interface ModuleResultCommitRecord {
  readonly schemaVersion: "dolly.module-result-commit/1";
  readonly moduleJobId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
  readonly resultDigest: string;
  readonly state: ModuleResultCommitState;
  readonly revision: number;
  readonly source: SourceIdentity;
  readonly outputPageIds: readonly string[];
  readonly outputDeliveries: readonly ModuleResultCommitOutputDelivery[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly blockProposal?: BlockProposal;
  readonly blockId?: string;
}

export interface ModuleResultCommitInput {
  readonly moduleJobId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
  readonly source: SourceIdentity;
  readonly outputPageIds: readonly string[];
  readonly blockProposal?: BlockProposal;
}

export interface ModuleResultCommitRepository {
  createPrepared(record: ModuleResultCommitRecord): "created" | "already-exists";
  get(moduleJobId: string): ModuleResultCommitRecord | null;
  compareAndSet(
    moduleJobId: string,
    expectedRevision: number,
    next: ModuleResultCommitRecord,
  ): boolean;
  deleteIfRevision(moduleJobId: string, expectedRevision: number): boolean;
  list(): readonly ModuleResultCommitRecord[];
}

export type ModuleResultCommitHookPhase =
  | "after-block-effect"
  | "after-delivery-effect"
  | "after-ack-effect";

export interface ModuleResultCommitHookEvent {
  readonly phase: ModuleResultCommitHookPhase;
  readonly moduleJobId: string;
  readonly pageId?: string;
}

/**
 * `MODULE_RESULT_PERSISTED_STATE_CONFLICT` means the journal, Delivery Claim,
 * Module submission record, and Block or Delivery effects form a persisted
 * combination that the result-commit protocol does not allow. Repository
 * document shape and journal-transition violations continue to use
 * `MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT`.
 *
 * `MODULE_RESULT_OPERATION_CONTRACT_VIOLATION` means an operation supplied to
 * the coordinator returned a Promise or another thenable even though its
 * contract requires a synchronous result. It does not describe persisted
 * state found before the operation ran.
 */
export type ModuleResultCommitErrorCode =
  | "MODULE_JOB_ID_INVALID"
  | "MODULE_JOB_RESULT_CONFLICT"
  | "MODULE_JOB_CLAIM_NOT_ACTIVE"
  | "MODULE_JOB_SOURCE_MISMATCH"
  | "MODULE_JOB_OUTPUT_INVALID"
  | "MODULE_RESULT_COMMIT_RECORD_MISSING"
  | "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT"
  | "MODULE_RESULT_PERSISTED_STATE_CONFLICT"
  | "MODULE_RESULT_OPERATION_CONTRACT_VIOLATION"
  | "MODULE_RESULT_COMMIT_DOCUMENT_INVALID"
  | "MODULE_RESULT_COMMIT_LIMIT_EXCEEDED"
  | "MODULE_RESULT_COMMIT_LOCKED"
  | "MODULE_RESULT_COMMIT_IO_FAILED"
  | "MODULE_RESULT_OUTPUT_BACKPRESSURED";

export class ModuleResultCommitError extends Error {
  constructor(
    readonly code: ModuleResultCommitErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "ModuleResultCommitError";
  }
}

/**
 * The exact Module result is durable, but one or more downstream consumers do
 * not currently have room for its output Deliveries. This is not an unknown
 * outcome and not permission to execute the Module again: callers retain the
 * Claim and resume this same commit after capacity changes.
 */
export class ModuleResultCommitBackpressureError extends ModuleResultCommitError {
  readonly blockedConsumerIds: readonly string[];

  constructor(blockedConsumerIds: readonly string[]) {
    const normalized = [...new Set(blockedConsumerIds)].sort();
    if (
      normalized.length === 0 ||
      normalized.some((consumerId) => !ID_PATTERN.test(consumerId))
    ) {
      throw new TypeError("Output backpressure requires valid blocked consumer identifiers");
    }
    super(
      "MODULE_RESULT_OUTPUT_BACKPRESSURED",
      `Module result output is waiting for downstream capacity: ${normalized.join(", ")}`,
      { blockedConsumerIds: normalized },
    );
    this.name = "ModuleResultCommitBackpressureError";
    this.blockedConsumerIds = deepFreeze(normalized);
  }
}

const coordinatorBackpressureErrors = new WeakSet<
  ModuleResultCommitBackpressureError
>();

function coordinatorBackpressureError(
  blockedConsumerIds: readonly string[],
): ModuleResultCommitBackpressureError {
  const error = new ModuleResultCommitBackpressureError(blockedConsumerIds);
  coordinatorBackpressureErrors.add(error);
  return error;
}

/** Rejects lookalike errors thrown by hooks or another caller. */
export function isCoordinatorBackpressureError(
  error: unknown,
): error is ModuleResultCommitBackpressureError {
  return (
    error instanceof ModuleResultCommitBackpressureError &&
    coordinatorBackpressureErrors.has(error)
  );
}

function canonicalTime(now: () => string): string {
  const timestamp = Date.parse(now());
  if (!Number.isFinite(timestamp)) {
    throw new ModuleResultCommitError(
      "MODULE_JOB_ID_INVALID",
      "Runtime clock returned an invalid time",
    );
  }
  return new Date(timestamp).toISOString();
}

function mediaReferencesForProposal(proposal: BlockProposal): readonly MediaReferenceItem[] {
  if (proposal.payload.schema !== "dolly.content/1") return [];
  try {
    return contentReferences(parseBlockContent(proposal.payload.value)).media;
  } catch {
    throw new ModuleResultCommitError(
      "MODULE_JOB_OUTPUT_INVALID",
      "Module job output content is invalid",
    );
  }
}

function blockReferencesForProposal(proposal: BlockProposal): readonly BlockReferenceItem[] {
  if (proposal.payload.schema !== "dolly.content/1") return [];
  try {
    return contentReferences(parseBlockContent(proposal.payload.value)).blocks;
  } catch {
    throw new ModuleResultCommitError(
      "MODULE_JOB_OUTPUT_INVALID",
      "Module job output content is invalid",
    );
  }
}

/**
 * A candidate crop is allowed only when every edge is inside one delivered
 * crop. Separate delivered crops are never combined into a larger region.
 */
function cropIsInside(candidate: Rect, containing: Rect): boolean {
  return (
    candidate.topLeft.x >= containing.topLeft.x &&
    candidate.topLeft.y >= containing.topLeft.y &&
    candidate.bottomRight.x <= containing.bottomRight.x &&
    candidate.bottomRight.y <= containing.bottomRight.y
  );
}

function immutableRecord(record: ModuleResultCommitRecord): ModuleResultCommitRecord {
  assertJsonValue(record);
  const cloned = cloneJson(record as unknown as JsonValue) as unknown as ModuleResultCommitRecord;
  return deepFreeze(cloned) as ModuleResultCommitRecord;
}

export function moduleJobResultDigest(
  record: Pick<
    ModuleResultCommitRecord,
    "source" | "blockProposal" | "outputPageIds"
  >,
): string {
  return canonicalJsonDigest({
    schemaVersion: "dolly.module-job-result/1",
    source: record.source,
    blockProposal: record.blockProposal ?? null,
    outputPageIds: record.outputPageIds,
  });
}

export function assertModuleResultCommitRecord(record: ModuleResultCommitRecord): void {
  try {
    assertJsonValue(record);
  } catch {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module result commit record is not canonical JSON data",
    );
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module result commit record must be an object",
    );
  }
  if (typeof record.moduleJobId !== "string" || !ID_PATTERN.test(record.moduleJobId)) {
    throw new ModuleResultCommitError(
      "MODULE_JOB_ID_INVALID",
      "moduleJobId is not a valid identifier",
    );
  }
  const requiredKeys = [
    "attempt",
    "claimToken",
    "createdAt",
    "moduleGenerationId",
    "moduleJobId",
    "outputDeliveries",
    "outputPageIds",
    "resultDigest",
    "revision",
    "runId",
    "schemaVersion",
    "source",
    "state",
    "updatedAt",
  ];
  const allowedKeys = new Set([...requiredKeys, "blockId", "blockProposal"]);
  const recordKeys = Object.keys(record);
  if (
    requiredKeys.some((key) => !Object.hasOwn(record, key)) ||
    recordKeys.some((key) => !allowedKeys.has(key))
  ) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module result commit record fields are invalid",
    );
  }
  if (record.schemaVersion !== "dolly.module-result-commit/1") {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module result commit schema version is invalid",
    );
  }
  if (record.state !== "prepared" && record.state !== "committed") {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module result commit state is invalid",
    );
  }
  if (
    typeof record.claimToken !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.moduleGenerationId !== "string" ||
    !ID_PATTERN.test(record.claimToken) ||
    !ID_PATTERN.test(record.runId) ||
    !ID_PATTERN.test(record.moduleGenerationId)
  ) {
    throw new ModuleResultCommitError(
      "MODULE_JOB_ID_INVALID",
      "Claim identity is not valid",
    );
  }
  if (!Number.isSafeInteger(record.attempt) || record.attempt <= 0) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module job attempt is invalid",
    );
  }
  if (!Number.isSafeInteger(record.revision) || record.revision <= 0) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module result commit revision is invalid",
    );
  }
  const createdAt = canonicalTime(() => record.createdAt);
  const updatedAt = canonicalTime(() => record.updatedAt);
  if (
    createdAt !== record.createdAt ||
    updatedAt !== record.updatedAt ||
    Date.parse(updatedAt) < Date.parse(createdAt)
  ) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module result commit timestamps are not canonical and monotonic",
    );
  }
  if (
    record.source === null ||
    typeof record.source !== "object" ||
    (record.source.kind !== "module" &&
      record.source.kind !== "external" &&
      record.source.kind !== "system") ||
    typeof record.source.id !== "string" ||
    !ID_PATTERN.test(record.source.id)
  ) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module job source identity is invalid",
    );
  }
  if (!Array.isArray(record.outputPageIds) || !Array.isArray(record.outputDeliveries)) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module job output journals must be arrays",
    );
  }
  const pageIds = new Set<string>();
  for (const pageId of record.outputPageIds) {
    if (typeof pageId !== "string" || !ID_PATTERN.test(pageId) || pageIds.has(pageId)) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
        "Module job output Page identities are invalid or duplicated",
      );
    }
    pageIds.add(pageId);
  }
  let computedResultDigest: string;
  try {
    computedResultDigest = moduleJobResultDigest(record);
  } catch {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module job immutable result cannot be canonically digested",
    );
  }
  if (
    !/^sha256:[0-9a-f]{64}$/.test(record.resultDigest) ||
    record.resultDigest !== computedResultDigest
  ) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module job result digest does not match its immutable result",
    );
  }
  if (record.blockProposal === undefined && record.blockId !== undefined) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "A no-Block result cannot contain a blockId",
    );
  }
  if (
    record.blockId !== undefined &&
    (typeof record.blockId !== "string" || !ID_PATTERN.test(record.blockId))
  ) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module job output Block identity is invalid",
    );
  }
  if (
    record.state === "committed" &&
    record.blockProposal !== undefined &&
    record.blockId === undefined
  ) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "A committed Block proposal is missing its output Block identity",
    );
  }
  if (record.blockProposal === undefined && record.outputPageIds.length > 0) {
    throw new ModuleResultCommitError(
      "MODULE_JOB_OUTPUT_INVALID",
      "A no-Block result cannot append output Deliveries",
    );
  }
  if (record.outputDeliveries.length > record.outputPageIds.length) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module job output journal is longer than its Page set",
    );
  }
  const deliveryIds = new Set<string>();
  for (let index = 0; index < record.outputDeliveries.length; index += 1) {
    const output = record.outputDeliveries[index]!;
    if (
      output === null ||
      typeof output !== "object" ||
      output.pageId !== record.outputPageIds[index] ||
      typeof output.deliveryId !== "string" ||
      !ID_PATTERN.test(output.deliveryId) ||
      deliveryIds.has(output.deliveryId)
    ) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
        "Module job output journal is not an ordered Page prefix",
      );
    }
    deliveryIds.add(output.deliveryId);
  }
  if (record.outputDeliveries.length > 0 && record.blockId === undefined) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Output Deliveries cannot precede the output Block journal entry",
    );
  }
  if (
    record.state === "committed" &&
    record.outputDeliveries.length !== record.outputPageIds.length
  ) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "A committed Module job is missing output Deliveries",
    );
  }
  const expectedRevision =
    record.state === "prepared"
      ? 1 + (record.blockId === undefined ? 0 : 1) + record.outputDeliveries.length
      : record.blockProposal === undefined
        ? 2
        : 3 + record.outputPageIds.length;
  if (record.revision !== expectedRevision) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "Module result commit revision does not match its recorded effects and state",
    );
  }
}

function sameImmutableIdentity(
  current: ModuleResultCommitRecord,
  next: ModuleResultCommitRecord,
): boolean {
  return (
    current.moduleJobId === next.moduleJobId &&
    current.claimToken === next.claimToken &&
    current.runId === next.runId &&
    current.attempt === next.attempt &&
    current.moduleGenerationId === next.moduleGenerationId &&
    current.resultDigest === next.resultDigest &&
    current.createdAt === next.createdAt
  );
}

function sameOutputPrefix(
  left: readonly ModuleResultCommitOutputDelivery[],
  right: readonly ModuleResultCommitOutputDelivery[],
): boolean {
  return left.every((output, index) => {
    const candidate = right[index];
    return candidate?.pageId === output.pageId && candidate.deliveryId === output.deliveryId;
  });
}

export function assertModuleResultCommitTransition(
  current: ModuleResultCommitRecord,
  next: ModuleResultCommitRecord,
): void {
  if (
    next.revision !== current.revision + 1 ||
    !sameImmutableIdentity(current, next) ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    current.state !== "prepared"
  ) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      `Invalid Module result commit transition for ${current.moduleJobId}`,
    );
  }

  if (current.blockProposal !== undefined && current.blockId === undefined) {
    if (
      next.state !== "prepared" ||
      next.blockId === undefined ||
      next.outputDeliveries.length !== current.outputDeliveries.length ||
      !sameOutputPrefix(current.outputDeliveries, next.outputDeliveries)
    ) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
        "A Block-effect revision may record only the output Block identity",
      );
    }
    return;
  }

  if (current.outputDeliveries.length < current.outputPageIds.length) {
    const appended = next.outputDeliveries[current.outputDeliveries.length];
    if (
      next.state !== "prepared" ||
      next.blockId !== current.blockId ||
      next.outputDeliveries.length !== current.outputDeliveries.length + 1 ||
      !sameOutputPrefix(current.outputDeliveries, next.outputDeliveries) ||
      appended?.pageId !== current.outputPageIds[current.outputDeliveries.length]
    ) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
        "A Delivery-effect revision must append exactly the next output Page entry",
      );
    }
    return;
  }

  if (
    next.state !== "committed" ||
    next.blockId !== current.blockId ||
    next.outputDeliveries.length !== current.outputDeliveries.length ||
    !sameOutputPrefix(current.outputDeliveries, next.outputDeliveries)
  ) {
    throw new ModuleResultCommitError(
      "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      "The terminal revision may only mark a complete Module result commit as committed",
    );
  }
}

export class InMemoryModuleResultCommitRepository
  implements ModuleResultCommitRepository
{
  readonly #records = new Map<string, ModuleResultCommitRecord>();

  createPrepared(record: ModuleResultCommitRecord): "created" | "already-exists" {
    assertModuleResultCommitRecord(record);
    if (
      record.state !== "prepared" ||
      record.revision !== 1 ||
      record.blockId !== undefined ||
      record.outputDeliveries.length !== 0
    ) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
        "A new Module result commit must start prepared at revision 1",
      );
    }
    if (this.#records.has(record.moduleJobId)) return "already-exists";
    this.#records.set(record.moduleJobId, immutableRecord(record));
    return "created";
  }

  get(moduleJobId: string): ModuleResultCommitRecord | null {
    return this.#records.get(moduleJobId) ?? null;
  }

  compareAndSet(
    moduleJobId: string,
    expectedRevision: number,
    next: ModuleResultCommitRecord,
  ): boolean {
    const current = this.#records.get(moduleJobId);
    if (!current || current.revision !== expectedRevision) return false;
    assertModuleResultCommitRecord(next);
    assertModuleResultCommitTransition(current, next);
    this.#records.set(moduleJobId, immutableRecord(next));
    return true;
  }

  deleteIfRevision(moduleJobId: string, expectedRevision: number): boolean {
    const current = this.#records.get(moduleJobId);
    if (!current || current.revision !== expectedRevision) return false;
    this.#records.delete(moduleJobId);
    return true;
  }

  list(): readonly ModuleResultCommitRecord[] {
    return [...this.#records.values()];
  }
}

/**
 * The complete set of Core-state operations used by one Module result commit.
 * Persistent product construction obtains this set from one
 * `FileCoreStateStore`; it deliberately omits raw Delivery Claim terminal
 * methods.
 */
export type ModuleResultCommitBlockOperations = Pick<
  BlockStore,
  | "commitOnce"
  | "inspectCommitEffect"
  | "normalizeInput"
  | "releaseCommitEffect"
  | "validateInput"
  | "validateSource"
>;

export type ModuleResultCommitDeliveryOperations = Pick<
  DeliveryStore,
  | "appendOnce"
  | "inspectAppendEffect"
  | "inspectClaim"
  | "inspectClaimInput"
  | "inspectClaimInputBlockIds"
  | "inspectClaimInputMediaReferences"
  | "listPageIds"
  | "validateOutputPages"
> & {
  usesSameBlockStore(blocks: ModuleResultCommitBlockOperations): boolean;
};

export interface ModuleResultCommitOperations {
  readonly blocks: ModuleResultCommitBlockOperations;
  readonly deliveries: ModuleResultCommitDeliveryOperations;
  /**
   * Acknowledges the Delivery Claim through the owning Core-state boundary.
   * Persistent implementations remove its matching submission record in the
   * same state update.
   */
  readonly acknowledgeDeliveryClaim: (
    identity: DeliveryClaimIdentity,
  ) => "committed" | "already-committed";
  /**
   * Reads the submission record from the same Core-state document that owns
   * Delivery Claim completion.
   */
  readonly getModuleSubmissionRecord: (
    runId: string,
  ) => ModuleSubmissionRecord | undefined;
  /**
   * Product FileCore implementations append every output effect, acknowledge
   * the exact Claim, and remove its submission record in one durable update.
   * Direct protocol fixtures may omit this operation and retain the legacy
   * stepwise recovery path.
   */
  readonly commitOutputBatch?: (input: {
    readonly claim: DeliveryClaimIdentity;
    readonly outputs: readonly DeliveryOutputEffectInput[];
  }) =>
    | {
        readonly status: "committed";
        readonly outputDeliveries: readonly ModuleResultCommitOutputDelivery[];
      }
    | {
        readonly status: "backpressured";
        readonly blockedConsumerIds: readonly string[];
      };
}

export interface ModuleResultCommitCoordinatorOptions
  extends ModuleResultCommitOperations {
  readonly repository: ModuleResultCommitRepository;
  readonly now: () => string;
  readonly afterEffect?: (
    event: ModuleResultCommitHookEvent,
  ) => void | Promise<void>;
}

export interface DeferredModuleResultCommit {
  readonly record: ModuleResultCommitRecord;
  readonly blockedConsumerIds: readonly string[];
}

export interface ModuleResultCommitRecoveryReport {
  readonly recoveredCommits: readonly ModuleResultCommitRecord[];
  readonly deferredCommits: readonly DeferredModuleResultCommit[];
}

/**
 * @internal Product composition must use `createModuleResultCommitCoordinator`
 * so Block, Delivery, submission, and acknowledgement operations all come
 * from one `FileCoreStateStore`. Direct construction remains available for
 * isolated protocol tests.
 */
export class ModuleResultCommitCoordinator {
  readonly #blocks: ModuleResultCommitBlockOperations;
  readonly #deliveries: ModuleResultCommitCoordinatorOptions["deliveries"];
  readonly #acknowledgeDeliveryClaim:
    ModuleResultCommitCoordinatorOptions["acknowledgeDeliveryClaim"];
  readonly #getModuleSubmissionRecord:
    ModuleResultCommitCoordinatorOptions["getModuleSubmissionRecord"];
  readonly #commitOutputBatch:
    ModuleResultCommitCoordinatorOptions["commitOutputBatch"];
  readonly #repository: ModuleResultCommitRepository;
  readonly #now: () => string;
  readonly #afterEffect?: ModuleResultCommitCoordinatorOptions["afterEffect"];
  readonly #inFlight = new Map<string, Promise<ModuleResultCommitRecord>>();

  constructor(options: ModuleResultCommitCoordinatorOptions) {
    if (!options.deliveries.usesSameBlockStore(options.blocks)) {
      throw new TypeError(
        "Module result commit requires its Block and Delivery operations to use the same Block store",
      );
    }
    this.#blocks = options.blocks;
    this.#deliveries = options.deliveries;
    this.#acknowledgeDeliveryClaim = options.acknowledgeDeliveryClaim;
    this.#getModuleSubmissionRecord = options.getModuleSubmissionRecord;
    this.#commitOutputBatch = options.commitOutputBatch;
    this.#repository = options.repository;
    this.#now = options.now;
    this.#afterEffect = options.afterEffect;
  }

  async commit(input: ModuleResultCommitInput): Promise<ModuleResultCommitRecord> {
    const record = this.#prepare(input);
    return this.#runExclusive(record.moduleJobId);
  }

  inspect(moduleJobId: string): ModuleResultCommitRecord | null {
    if (!ID_PATTERN.test(moduleJobId)) {
      throw new ModuleResultCommitError(
        "MODULE_JOB_ID_INVALID",
        "moduleJobId is not a valid identifier",
      );
    }
    const record = this.#repository.get(moduleJobId);
    if (record) assertModuleResultCommitRecord(record);
    return record;
  }

  /** Identity check used by the startup-to-runtime handoff; it grants no mutation access. */
  usesRepository(repository: ModuleResultCommitRepository): boolean {
    return this.#repository === repository;
  }

  recover(moduleJobId: string): Promise<ModuleResultCommitRecord> {
    if (!ID_PATTERN.test(moduleJobId)) {
      return Promise.reject(
        new ModuleResultCommitError(
          "MODULE_JOB_ID_INVALID",
          "moduleJobId is not a valid identifier",
        ),
      );
    }
    return this.#runExclusive(moduleJobId);
  }

  async recoverAll(): Promise<ModuleResultCommitRecoveryReport> {
    const recovered: ModuleResultCommitRecord[] = [];
    const prepared: ModuleResultCommitRecord[] = [];
    const records = [...this.#repository.list()];
    for (const record of records) {
      assertModuleResultCommitRecord(record);
    }
    records.sort((left, right) =>
      left.moduleJobId < right.moduleJobId ? -1 : left.moduleJobId > right.moduleJobId ? 1 : 0,
    );
    for (const record of records) {
      if (record.state === "prepared") {
        prepared.push(record);
      } else if (record.state === "committed") {
        await this.#runExclusive(record.moduleJobId);
      }
    }

    // A prepared result can be waiting for capacity that a later prepared
    // result will release when it acknowledges its own input Claim. Repository
    // enumeration order is not a dependency order or a selection policy, so a
    // validated snapshot is ordered canonically above and every later pass
    // preserves that order. One blocked entry must not prevent independent
    // entries from recovering. Each successful pass removes at least one
    // entry; if a complete pass makes no progress, preserve the existing
    // fail-closed backpressure result for the caller.
    let pending = prepared;
    let blockedConsumers = new Map<string, readonly string[]>();
    while (pending.length > 0) {
      const deferred: ModuleResultCommitRecord[] = [];
      const nextBlockedConsumers = new Map<string, readonly string[]>();
      for (const record of pending) {
        try {
          recovered.push(await this.#runExclusive(record.moduleJobId));
        } catch (error) {
          if (!isCoordinatorBackpressureError(error)) throw error;
          const current = this.#repository.get(record.moduleJobId);
          if (!current) {
            throw new ModuleResultCommitError(
              "MODULE_RESULT_COMMIT_RECORD_MISSING",
              `Module result commit ${record.moduleJobId} disappeared during recovery`,
            );
          }
          assertModuleResultCommitRecord(current);
          deferred.push(current);
          nextBlockedConsumers.set(current.moduleJobId, error.blockedConsumerIds);
        }
      }
      if (deferred.length === 0) {
        pending = [];
        break;
      }
      blockedConsumers = nextBlockedConsumers;
      if (deferred.length === pending.length) {
        pending = deferred;
        break;
      }
      pending = deferred;
    }
    return deepFreeze({
      recoveredCommits: [...recovered],
      deferredCommits: pending.map((record) => ({
        record,
        blockedConsumerIds: [...(blockedConsumers.get(record.moduleJobId) ?? [])],
      })),
    });
  }

  #prepare(input: ModuleResultCommitInput): ModuleResultCommitRecord {
    const claimRequest: DeliveryClaimIdentity = {
      moduleJobId: input.moduleJobId,
      claimToken: input.claimToken,
      runId: input.runId,
      attempt: input.attempt,
      moduleGenerationId: input.moduleGenerationId,
    };
    const claim = this.#deliveries.inspectClaim(claimRequest);
    this.#assertClaimMatchesIdentity(claim, claimRequest);
    const source = this.#blocks.validateSource(input.source);
    this.#assertSourceMatchesClaim(source, claim.consumerId);
    const outputPageIds = this.#deliveries.validateOutputPages(input.outputPageIds);
    const blockProposal =
      input.blockProposal === undefined
        ? undefined
        : this.#blocks.normalizeInput(input.blockProposal, source).proposal;
    if (blockProposal === undefined && outputPageIds.length > 0) {
      throw new ModuleResultCommitError(
        "MODULE_JOB_OUTPUT_INVALID",
        "A no-Block result cannot target output Pages",
      );
    }

    const resultDigest = moduleJobResultDigest({
      source,
      ...(blockProposal === undefined ? {} : { blockProposal }),
      outputPageIds,
    });
    const existing = this.#repository.get(claim.moduleJobId);
    if (existing) {
      assertModuleResultCommitRecord(existing);
      this.#assertSameResult(existing, input, resultDigest);
      return existing;
    }
    this.#assertActiveClaimHasSubmission(claim, claimRequest);
    if (blockProposal !== undefined) {
      this.#assertOutputBlockReferencesAllowed(blockProposal, claimRequest);
      this.#assertOutputMediaReferencesAllowed(blockProposal, claimRequest);
      this.#blocks.validateInput(blockProposal, source);
    }

    const now = canonicalTime(this.#now);
    const prepared = immutableRecord({
      schemaVersion: "dolly.module-result-commit/1",
      moduleJobId: claim.moduleJobId,
      claimToken: input.claimToken,
      runId: input.runId,
      attempt: input.attempt,
      moduleGenerationId: input.moduleGenerationId,
      resultDigest,
      state: "prepared",
      revision: 1,
      source,
      outputPageIds,
      outputDeliveries: [],
      createdAt: now,
      updatedAt: now,
      ...(blockProposal === undefined ? {} : { blockProposal }),
    });
    try {
      this.#assertNoEffectsBeforePrepared(prepared);
    } catch (error) {
      if (
        !(error instanceof ModuleResultCommitError) ||
        error.code !== "MODULE_RESULT_PERSISTED_STATE_CONFLICT"
      ) {
        throw error;
      }
      const raced = this.#repository.get(claim.moduleJobId);
      if (!raced) throw error;
      assertModuleResultCommitRecord(raced);
      this.#assertSameResult(raced, input, resultDigest);
      return raced;
    }
    let created: "created" | "already-exists";
    try {
      created = this.#repository.createPrepared(prepared);
    } catch (error) {
      if (
        !(error instanceof ModuleResultCommitError) ||
        error.code !== "MODULE_RESULT_COMMIT_LIMIT_EXCEEDED" ||
        this.#pruneVerifiedTerminalRecords() === 0
      ) {
        throw error;
      }
      created = this.#repository.createPrepared(prepared);
    }
    if (created === "created") return prepared;
    const raced = this.#repository.get(claim.moduleJobId)!;
    assertModuleResultCommitRecord(raced);
    this.#assertSameResult(raced, input, resultDigest);
    return raced;
  }

  #assertSameResult(
    record: ModuleResultCommitRecord,
    input: Pick<
      ModuleResultCommitInput,
      "moduleJobId" | "claimToken" | "runId" | "attempt" | "moduleGenerationId"
    >,
    resultDigest: string,
  ): void {
    assertModuleResultCommitRecord(record);
    if (
      record.moduleJobId !== input.moduleJobId ||
      record.claimToken !== input.claimToken ||
      record.runId !== input.runId ||
      record.attempt !== input.attempt ||
      record.moduleGenerationId !== input.moduleGenerationId ||
      record.resultDigest !== resultDigest
    ) {
      throw new ModuleResultCommitError(
        "MODULE_JOB_RESULT_CONFLICT",
        `Module job ${record.moduleJobId} already has a different committed proposal`,
        { moduleJobId: record.moduleJobId },
      );
    }
  }

  #claimIdentity(
    record: Pick<
      ModuleResultCommitRecord,
      "moduleJobId" | "claimToken" | "runId" | "attempt" | "moduleGenerationId"
    >,
  ): DeliveryClaimIdentity {
    return {
      moduleJobId: record.moduleJobId,
      claimToken: record.claimToken,
      runId: record.runId,
      attempt: record.attempt,
      moduleGenerationId: record.moduleGenerationId,
    };
  }

  #assertClaimMatchesIdentity(
    claim: ClaimDescriptor,
    identity: DeliveryClaimIdentity,
  ): void {
    if (
      claim.moduleJobId === identity.moduleJobId &&
      claim.claimToken === identity.claimToken &&
      claim.runId === identity.runId &&
      claim.attempt === identity.attempt &&
      claim.moduleGenerationId === identity.moduleGenerationId
    ) {
      return;
    }
    throw new ModuleResultCommitError(
      "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
      `Delivery Claim does not match Module job ${identity.moduleJobId}`,
      { moduleJobId: identity.moduleJobId },
    );
  }

  #assertSubmissionMatchesIdentity(
    submission: ModuleSubmissionRecord | undefined,
    identity: DeliveryClaimIdentity,
  ): void {
    if (
      submission !== undefined &&
      submission.moduleJobId === identity.moduleJobId &&
      submission.claimToken === identity.claimToken &&
      submission.runId === identity.runId &&
      submission.attempt === identity.attempt &&
      submission.moduleGenerationId === identity.moduleGenerationId &&
      submission.inputDigest ===
        canonicalJsonDigest(this.#deliveries.inspectClaimInput(identity))
    ) {
      return;
    }
    throw new ModuleResultCommitError(
      "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
      `Module job ${identity.moduleJobId} requires its exact submission record`,
      { moduleJobId: identity.moduleJobId },
    );
  }

  #readModuleSubmissionRecord(runId: string): ModuleSubmissionRecord | undefined {
    const submission: unknown = this.#getModuleSubmissionRecord(runId);
    if (submission === undefined) return undefined;
    try {
      assertValidModuleSubmissionRecord(submission);
    } catch {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
        `Run ${runId} has an invalid Module submission record`,
        { runId },
      );
    }
    return submission;
  }

  #assertActiveClaimHasSubmission(
    claim: ClaimDescriptor,
    identity: DeliveryClaimIdentity,
  ): void {
    this.#assertClaimMatchesIdentity(claim, identity);
    if (claim.status !== "active") {
      throw new ModuleResultCommitError(
        "MODULE_JOB_CLAIM_NOT_ACTIVE",
        `A new Module result requires an active Claim; ${identity.moduleJobId} is ${claim.status}`,
        { claimStatus: claim.status, moduleJobId: identity.moduleJobId },
      );
    }
    this.#assertSubmissionMatchesIdentity(
      this.#readModuleSubmissionRecord(identity.runId),
      identity,
    );
  }

  #assertSourceMatchesClaim(source: SourceIdentity, consumerId: string): void {
    if (source.kind === "module" && source.id === consumerId) return;
    throw new ModuleResultCommitError(
      "MODULE_JOB_SOURCE_MISMATCH",
      "Module job result source must identify the Module that owns the claim",
      { consumerId },
    );
  }

  #assertOutputBlockReferencesAllowed(
    proposal: BlockProposal,
    claimRequest: DeliveryClaimIdentity,
  ): void {
    const inputBlockIds = new Set(this.#deliveries.inspectClaimInputBlockIds(claimRequest));
    for (const reference of blockReferencesForProposal(proposal)) {
      if (inputBlockIds.has(reference.blockId)) continue;
      throw new ModuleResultCommitError(
        "MODULE_JOB_OUTPUT_INVALID",
        `Module job output Block ${reference.blockId} was not delivered to the Module`,
        { blockId: reference.blockId },
      );
    }
  }

  #assertOutputMediaReferencesAllowed(
    proposal: BlockProposal,
    claimRequest: DeliveryClaimIdentity,
  ): void {
    const outputReferences = mediaReferencesForProposal(proposal);
    if (outputReferences.length === 0) return;

    const inputByMediaId = new Map<string, MediaReferenceItem[]>();
    for (const reference of this.#deliveries.inspectClaimInputMediaReferences(claimRequest)) {
      const references = inputByMediaId.get(reference.mediaId) ?? [];
      references.push(reference);
      inputByMediaId.set(reference.mediaId, references);
    }

    for (const outputReference of outputReferences) {
      const inputReferences = inputByMediaId.get(outputReference.mediaId);
      if (!inputReferences) {
        throw new ModuleResultCommitError(
          "MODULE_JOB_OUTPUT_INVALID",
          `Module job output Media ${outputReference.mediaId} was not delivered to the Module`,
          { mediaId: outputReference.mediaId },
        );
      }
      if (inputReferences.some((reference) => reference.crop === undefined)) continue;
      if (
        outputReference.crop !== undefined &&
        inputReferences.some(
          (reference) =>
            reference.crop !== undefined && cropIsInside(outputReference.crop!, reference.crop),
        )
      ) {
        continue;
      }
      throw new ModuleResultCommitError(
        "MODULE_JOB_OUTPUT_INVALID",
        outputReference.crop === undefined
          ? `Module job output Media ${outputReference.mediaId} cannot expand a delivered crop to the full image`
          : `Module job output Media ${outputReference.mediaId} crop extends beyond every delivered crop`,
        { mediaId: outputReference.mediaId },
      );
    }
  }

  #validatePersistentState(
    record: ModuleResultCommitRecord,
  ): "active" | "committed" {
    const identity = this.#claimIdentity(record);
    const claim = this.#deliveries.inspectClaim(identity);
    this.#assertClaimMatchesIdentity(claim, identity);
    this.#assertSourceMatchesClaim(record.source, claim.consumerId);
    const submission = this.#readModuleSubmissionRecord(record.runId);

    if (claim.status === "active") {
      if (record.state !== "prepared") {
        throw new ModuleResultCommitError(
          "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
          `Committed Module result ${record.moduleJobId} still has an active Claim`,
          { moduleJobId: record.moduleJobId },
        );
      }
      this.#assertPreparedResultStillValid(record);
      this.#assertSubmissionMatchesIdentity(submission, identity);
      if (record.blockProposal !== undefined) {
        this.#assertOutputBlockReferencesAllowed(record.blockProposal, identity);
        this.#assertOutputMediaReferencesAllowed(record.blockProposal, identity);
      }
      this.#assertRecordedEffects(record, false);
      return "active";
    }

    if (claim.status === "committed") {
      if (submission !== undefined) {
        throw new ModuleResultCommitError(
          "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
          `Committed Claim for Module job ${record.moduleJobId} still has a submission record`,
          { moduleJobId: record.moduleJobId },
        );
      }
      this.#assertRecordedEffects(record, true);
      return "committed";
    }

    throw new ModuleResultCommitError(
      "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
      `Module result ${record.moduleJobId} cannot continue from Claim state ${claim.status}`,
      { claimStatus: claim.status, moduleJobId: record.moduleJobId },
    );
  }

  #assertPreparedResultStillValid(record: ModuleResultCommitRecord): void {
    try {
      const outputPageIds = this.#deliveries.validateOutputPages(
        record.outputPageIds,
      );
      if (
        outputPageIds.length !== record.outputPageIds.length ||
        !outputPageIds.every(
          (pageId, index) => pageId === record.outputPageIds[index],
        )
      ) {
        throw new Error("Output Page validation changed the journal");
      }
      if (record.blockProposal !== undefined) {
        this.#blocks.validateInput(record.blockProposal, record.source);
      }
    } catch {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
        `Prepared Module result ${record.moduleJobId} is no longer valid against its Block and Delivery stores`,
        { moduleJobId: record.moduleJobId },
      );
    }
  }

  #assertRecordedEffects(
    record: ModuleResultCommitRecord,
    requireComplete: boolean,
  ): void {
    this.#assertNoUndeclaredDeliveryEffects(record);
    if (
      requireComplete &&
      (record.blockProposal !== undefined
        ? record.blockId === undefined ||
          record.outputDeliveries.length !== record.outputPageIds.length
        : record.outputPageIds.length !== 0)
    ) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
        `Module result ${record.moduleJobId} reached a committed Claim before all effects were recorded`,
        { moduleJobId: record.moduleJobId },
      );
    }

    const blockEffect = this.#blocks.inspectCommitEffect(
      this.#blockEffectId(record.moduleJobId),
    );
    if (record.blockProposal === undefined) {
      if (blockEffect === null) return;
      throw new ModuleResultCommitError(
        "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
        `No-Block Module result ${record.moduleJobId} has an unexpected Block effect`,
        { moduleJobId: record.moduleJobId },
      );
    }

    const expectedBlockEffectDigest = canonicalJsonDigest({
      proposal: record.blockProposal,
      source: record.source,
    });
    if (
      (record.blockId !== undefined && blockEffect === null) ||
      (blockEffect !== null &&
        (blockEffect.digest !== expectedBlockEffectDigest ||
          (record.state === "prepared" && !blockEffect.strongReferenceHeld) ||
          (record.blockId !== undefined && blockEffect.record.id !== record.blockId)))
    ) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
        `Module result ${record.moduleJobId} does not match its recorded Block effect`,
        { moduleJobId: record.moduleJobId },
      );
    }

    if (record.blockId === undefined) {
      for (const pageId of record.outputPageIds) {
        if (
          this.#deliveries.inspectAppendEffect(
            this.#deliveryEffectId(record.moduleJobId, pageId),
          ) === null
        ) {
          continue;
        }
        throw new ModuleResultCommitError(
          "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
          `Module result ${record.moduleJobId} has a Delivery effect before its Block journal entry`,
          { moduleJobId: record.moduleJobId, pageId },
        );
      }
      return;
    }
    if (blockEffect === null) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
        `Module result ${record.moduleJobId} does not match its recorded Block effect`,
        { moduleJobId: record.moduleJobId },
      );
    }

    for (let index = 0; index < record.outputPageIds.length; index += 1) {
      const pageId = record.outputPageIds[index]!;
      const output = record.outputDeliveries[index];
      const deliveryEffect = this.#deliveries.inspectAppendEffect(
        this.#deliveryEffectId(record.moduleJobId, pageId),
      );
      if (output !== undefined) {
        if (
          deliveryEffect !== null &&
          deliveryEffect.pageId === output.pageId &&
          deliveryEffect.blockId === record.blockId &&
          deliveryEffect.record.deliveryId === output.deliveryId &&
          deliveryEffect.record.pageId === output.pageId &&
          deliveryEffect.record.blockId === record.blockId
        ) {
          continue;
        }
        throw new ModuleResultCommitError(
          "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
          `Module result ${record.moduleJobId} does not match its recorded Delivery effect`,
          { moduleJobId: record.moduleJobId, pageId },
        );
      }

      const isNextEffect =
        record.blockId !== undefined &&
        index === record.outputDeliveries.length;
      if (deliveryEffect === null) continue;
      if (
        isNextEffect &&
        deliveryEffect.pageId === pageId &&
        deliveryEffect.blockId === record.blockId &&
        deliveryEffect.record.pageId === pageId &&
        deliveryEffect.record.blockId === record.blockId
      ) {
        continue;
      }
      throw new ModuleResultCommitError(
        "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
        `Module result ${record.moduleJobId} has an output Delivery effect before its preceding journal entry`,
        { moduleJobId: record.moduleJobId, pageId },
      );
    }
  }

  #assertNoEffectsBeforePrepared(record: ModuleResultCommitRecord): void {
    if (
      this.#blocks.inspectCommitEffect(
        this.#blockEffectId(record.moduleJobId),
      ) !== null
    ) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
        `Module job ${record.moduleJobId} has a Block effect but no prepared result journal`,
        { moduleJobId: record.moduleJobId },
      );
    }
    for (const pageId of record.outputPageIds) {
      if (
        this.#deliveries.inspectAppendEffect(
          this.#deliveryEffectId(record.moduleJobId, pageId),
        ) === null
      ) {
        continue;
      }
      throw new ModuleResultCommitError(
        "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
        `Module job ${record.moduleJobId} has an output Delivery effect but no prepared result journal`,
        { moduleJobId: record.moduleJobId, pageId },
      );
    }
    this.#assertNoUndeclaredDeliveryEffects(record);
  }

  #assertNoUndeclaredDeliveryEffects(record: ModuleResultCommitRecord): void {
    const declaredPageIds = new Set(record.outputPageIds);
    for (const pageId of this.#deliveries.listPageIds()) {
      const effect = this.#deliveries.inspectAppendEffect(
        this.#deliveryEffectId(record.moduleJobId, pageId),
      );
      if (effect === null) continue;
      if (effect.pageId !== pageId) {
        throw new ModuleResultCommitError(
          "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
          `Module job ${record.moduleJobId} has a Delivery effect whose target does not match its effect identity`,
          { moduleJobId: record.moduleJobId, pageId },
        );
      }
      if (declaredPageIds.has(effect.pageId)) continue;
      throw new ModuleResultCommitError(
        "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
        `Module job ${record.moduleJobId} has a Delivery effect for undeclared output Page ${effect.pageId}`,
        { moduleJobId: record.moduleJobId, pageId: effect.pageId },
      );
    }
  }

  #runExclusive(moduleJobId: string): Promise<ModuleResultCommitRecord> {
    const existing = this.#inFlight.get(moduleJobId);
    if (existing) return existing;
    const operation = this.#resumeWithTerminalPruning(moduleJobId).finally(() => {
      this.#inFlight.delete(moduleJobId);
    });
    this.#inFlight.set(moduleJobId, operation);
    return operation;
  }

  async #resumeWithTerminalPruning(
    moduleJobId: string,
  ): Promise<ModuleResultCommitRecord> {
    try {
      return await this.#resume(moduleJobId);
    } catch (error) {
      if (
        !(error instanceof ModuleResultCommitError) ||
        error.code !== "MODULE_RESULT_COMMIT_LIMIT_EXCEEDED" ||
        this.#pruneVerifiedTerminalRecords() === 0
      ) {
        throw error;
      }
      return this.#resume(moduleJobId);
    }
  }

  async #resume(moduleJobId: string): Promise<ModuleResultCommitRecord> {
    for (;;) {
      const record = this.#repository.get(moduleJobId);
      if (!record) {
        throw new ModuleResultCommitError(
          "MODULE_RESULT_COMMIT_RECORD_MISSING",
          `Module result commit ${moduleJobId} does not exist`,
        );
      }
      assertModuleResultCommitRecord(record);
      if (
        this.#commitOutputBatch !== undefined &&
        this.#synchronizeNextRecordedEffect(record)
      ) {
        continue;
      }
      const claimState = this.#validatePersistentState(record);
      if (claimState === "committed") {
        if (record.state === "committed") {
          if (record.blockProposal !== undefined) {
            this.#blocks.releaseCommitEffect(this.#blockEffectId(moduleJobId));
          }
          return record;
        }
        const committed = immutableRecord({
          ...record,
          state: "committed",
          revision: record.revision + 1,
          updatedAt: canonicalTime(this.#now),
        });
        if (!this.#repository.compareAndSet(moduleJobId, record.revision, committed)) {
          continue;
        }
        if (committed.blockProposal !== undefined) {
          this.#blocks.releaseCommitEffect(this.#blockEffectId(moduleJobId));
        }
        return committed;
      }

      if (record.blockProposal !== undefined) {
        if (record.blockId === undefined) {
          const block = this.#blocks.commitOnce(
            this.#blockEffectId(moduleJobId),
            record.blockProposal,
            record.source,
          );
          await this.#afterEffect?.({ phase: "after-block-effect", moduleJobId });
          const next = immutableRecord({
            ...record,
            revision: record.revision + 1,
            updatedAt: canonicalTime(this.#now),
            blockId: block.id,
          });
          this.#repository.compareAndSet(moduleJobId, record.revision, next);
          continue;
        }
      }

      if (this.#commitOutputBatch !== undefined) {
        const batch = this.#commitOutputBatch({
          claim: this.#claimIdentity(record),
          outputs: record.outputPageIds.map((pageId) => ({
            effectId: this.#deliveryEffectId(moduleJobId, pageId),
            pageId,
            blockId: record.blockId!,
          })),
        });
        if (batch.status === "backpressured") {
          throw coordinatorBackpressureError(batch.blockedConsumerIds);
        }
        await this.#afterEffect?.({ phase: "after-ack-effect", moduleJobId });
        continue;
      }

      const nextPageId = record.outputPageIds[record.outputDeliveries.length];
      if (nextPageId !== undefined) {
        const delivery = this.#deliveries.appendOnce(
          this.#deliveryEffectId(moduleJobId, nextPageId),
          nextPageId,
          record.blockId!,
        );
        await this.#afterEffect?.({
          phase: "after-delivery-effect",
          moduleJobId,
          pageId: nextPageId,
        });
        const next = immutableRecord({
          ...record,
          revision: record.revision + 1,
          updatedAt: canonicalTime(this.#now),
          outputDeliveries: [
            ...record.outputDeliveries,
            { pageId: nextPageId, deliveryId: delivery.deliveryId },
          ],
        });
        this.#repository.compareAndSet(moduleJobId, record.revision, next);
        continue;
      }

      this.#acknowledgeAndConfirm(record);
      await this.#afterEffect?.({ phase: "after-ack-effect", moduleJobId });
      const committed = immutableRecord({
        ...record,
        state: "committed",
        revision: record.revision + 1,
        updatedAt: canonicalTime(this.#now),
      });
      if (!this.#repository.compareAndSet(moduleJobId, record.revision, committed)) {
        continue;
      }
      if (committed.blockProposal !== undefined) {
        this.#blocks.releaseCommitEffect(this.#blockEffectId(moduleJobId));
      }
      return committed;
    }
  }

  /**
   * A result-commit journal is a recovery mechanism, not an audit log. Once
   * the exact Claim and effects are durably terminal, retaining its full
   * result forever can only consume the finite recovery budget. Every removal
   * is preceded by the same cross-store validation used during recovery.
   */
  #pruneVerifiedTerminalRecords(): number {
    let removed = 0;
    const records = [...this.#repository.list()].sort((left, right) =>
      left.moduleJobId < right.moduleJobId ? -1 : left.moduleJobId > right.moduleJobId ? 1 : 0,
    );
    for (const record of records) {
      assertModuleResultCommitRecord(record);
      if (record.state !== "committed") continue;
      if (this.#validatePersistentState(record) !== "committed") continue;
      if (record.blockProposal !== undefined) {
        this.#blocks.releaseCommitEffect(this.#blockEffectId(record.moduleJobId));
      }
      // Releasing the Block reference is idempotent while deleting the
      // journal is not reversible. Keep the terminal journal as the cleanup
      // anchor until the release has durably succeeded.
      if (!this.#repository.deleteIfRevision(record.moduleJobId, record.revision)) continue;
      removed += 1;
    }
    return removed;
  }

  /**
   * A FileCore output batch can commit all Delivery effects and its Claim
   * before the separate result journal advances. Catch up exactly one durable
   * effect per revision so the existing transition validator still detects
   * missing, reordered, or conflicting effects.
   */
  #synchronizeNextRecordedEffect(record: ModuleResultCommitRecord): boolean {
    if (record.blockProposal !== undefined && record.blockId === undefined) {
      const blockEffect = this.#blocks.inspectCommitEffect(
        this.#blockEffectId(record.moduleJobId),
      );
      if (blockEffect === null) return false;
      const expectedDigest = canonicalJsonDigest({
        proposal: record.blockProposal,
        source: record.source,
      });
      if (blockEffect.digest !== expectedDigest || !blockEffect.strongReferenceHeld) {
        throw new ModuleResultCommitError(
          "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
          `Module result ${record.moduleJobId} has a conflicting Block effect`,
          { moduleJobId: record.moduleJobId },
        );
      }
      const next = immutableRecord({
        ...record,
        revision: record.revision + 1,
        updatedAt: canonicalTime(this.#now),
        blockId: blockEffect.record.id,
      });
      this.#repository.compareAndSet(record.moduleJobId, record.revision, next);
      return true;
    }

    if (record.blockId === undefined) return false;
    const pageId = record.outputPageIds[record.outputDeliveries.length];
    if (pageId === undefined) return false;
    const effect = this.#deliveries.inspectAppendEffect(
      this.#deliveryEffectId(record.moduleJobId, pageId),
    );
    if (effect === null) return false;
    if (
      effect.pageId !== pageId ||
      effect.blockId !== record.blockId ||
      effect.record.pageId !== pageId ||
      effect.record.blockId !== record.blockId
    ) {
      throw new ModuleResultCommitError(
        "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
        `Module result ${record.moduleJobId} has a conflicting Delivery effect`,
        { moduleJobId: record.moduleJobId, pageId },
      );
    }
    const next = immutableRecord({
      ...record,
      revision: record.revision + 1,
      updatedAt: canonicalTime(this.#now),
      outputDeliveries: [
        ...record.outputDeliveries,
        { pageId, deliveryId: effect.record.deliveryId },
      ],
    });
    this.#repository.compareAndSet(record.moduleJobId, record.revision, next);
    return true;
  }

  /**
   * A callback response is not proof that it changed the same Delivery store.
   * The exact Claim in the store used by this coordinator must be committed
   * before the journal can advance or recovery can finish.
   */
  #acknowledgeAndConfirm(record: ModuleResultCommitRecord): void {
    const identity = this.#claimIdentity(record);
    let acknowledgementError: unknown;
    let returnedPromise = false;
    try {
      const result: unknown = this.#acknowledgeDeliveryClaim(identity);
      returnedPromise =
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        typeof (result as { readonly then?: unknown }).then === "function";
      if (returnedPromise) {
        acknowledgementError = new ModuleResultCommitError(
          "MODULE_RESULT_OPERATION_CONTRACT_VIOLATION",
          "Delivery Claim acknowledgement must complete synchronously",
          { moduleJobId: record.moduleJobId },
        );
      }
    } catch (error) {
      acknowledgementError = error;
    }

    let claim: ClaimDescriptor;
    try {
      claim = this.#deliveries.inspectClaim(identity);
    } catch (error) {
      throw acknowledgementError ?? error;
    }
    this.#assertClaimMatchesIdentity(claim, identity);
    this.#assertSourceMatchesClaim(record.source, claim.consumerId);
    const submission = this.#readModuleSubmissionRecord(record.runId);
    if (
      !returnedPromise &&
      claim.status === "committed" &&
      submission === undefined
    ) {
      return;
    }
    if (acknowledgementError !== undefined) throw acknowledgementError;
    throw new ModuleResultCommitError(
      "MODULE_RESULT_PERSISTED_STATE_CONFLICT",
      `Acknowledgement for Module job ${record.moduleJobId} did not commit its exact Claim and remove its submission record`,
      {
        claimStatus: claim.status,
        moduleJobId: record.moduleJobId,
        submissionPresent: submission !== undefined,
      },
    );
  }

  #blockEffectId(moduleJobId: string): string {
    return canonicalJsonDigest(["module-result-commit-block", moduleJobId]);
  }

  #deliveryEffectId(moduleJobId: string, pageId: string): string {
    return canonicalJsonDigest(["module-result-commit-delivery", moduleJobId, pageId]);
  }
}
