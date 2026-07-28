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
import { type DeliveryClaimIdentity, type DeliveryStore } from "./delivery-store.js";

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

export type ModuleResultCommitErrorCode =
  | "MODULE_JOB_ID_INVALID"
  | "MODULE_JOB_RESULT_CONFLICT"
  | "MODULE_JOB_CLAIM_NOT_ACTIVE"
  | "MODULE_JOB_SOURCE_MISMATCH"
  | "MODULE_JOB_OUTPUT_INVALID"
  | "MODULE_RESULT_COMMIT_RECORD_MISSING"
  | "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT"
  | "MODULE_RESULT_COMMIT_DOCUMENT_INVALID"
  | "MODULE_RESULT_COMMIT_LIMIT_EXCEEDED"
  | "MODULE_RESULT_COMMIT_LOCKED"
  | "MODULE_RESULT_COMMIT_IO_FAILED";

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

  list(): readonly ModuleResultCommitRecord[] {
    return [...this.#records.values()];
  }
}

export interface ModuleResultCommitCoordinatorOptions {
  readonly blocks: BlockStore;
  readonly deliveries: DeliveryStore;
  readonly repository: ModuleResultCommitRepository;
  readonly now: () => string;
  readonly afterEffect?: (
    event: ModuleResultCommitHookEvent,
  ) => void | Promise<void>;
}

export class ModuleResultCommitCoordinator {
  readonly #blocks: BlockStore;
  readonly #deliveries: DeliveryStore;
  readonly #repository: ModuleResultCommitRepository;
  readonly #now: () => string;
  readonly #afterEffect?: ModuleResultCommitCoordinatorOptions["afterEffect"];
  readonly #inFlight = new Map<string, Promise<ModuleResultCommitRecord>>();

  constructor(options: ModuleResultCommitCoordinatorOptions) {
    this.#blocks = options.blocks;
    this.#deliveries = options.deliveries;
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

  async recoverAll(): Promise<readonly ModuleResultCommitRecord[]> {
    const recovered: ModuleResultCommitRecord[] = [];
    for (const record of this.#repository.list()) {
      assertModuleResultCommitRecord(record);
      if (record.state === "prepared") {
        recovered.push(await this.#runExclusive(record.moduleJobId));
      } else if (record.state === "committed") {
        await this.#runExclusive(record.moduleJobId);
      }
    }
    return recovered;
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
      if (existing.state === "prepared") {
        this.#assertPreparedResultAllowed(existing);
      }
      return existing;
    }
    if (claim.status !== "active") {
      throw new ModuleResultCommitError(
        "MODULE_JOB_CLAIM_NOT_ACTIVE",
        `Claim for ${claim.moduleJobId} is ${claim.status}`,
      );
    }
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
    const created = this.#repository.createPrepared(prepared);
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

  #assertPreparedResultAllowed(record: ModuleResultCommitRecord): void {
    const claimRequest: DeliveryClaimIdentity = {
      moduleJobId: record.moduleJobId,
      claimToken: record.claimToken,
      runId: record.runId,
      attempt: record.attempt,
      moduleGenerationId: record.moduleGenerationId,
    };
    const claim = this.#deliveries.inspectClaim(claimRequest);
    this.#assertSourceMatchesClaim(record.source, claim.consumerId);
    if (record.blockProposal !== undefined) {
      this.#assertOutputBlockReferencesAllowed(record.blockProposal, claimRequest);
      this.#assertOutputMediaReferencesAllowed(record.blockProposal, claimRequest);
    }
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

  #runExclusive(moduleJobId: string): Promise<ModuleResultCommitRecord> {
    const existing = this.#inFlight.get(moduleJobId);
    if (existing) return existing;
    const operation = this.#resume(moduleJobId).finally(() => {
      this.#inFlight.delete(moduleJobId);
    });
    this.#inFlight.set(moduleJobId, operation);
    return operation;
  }

  async #resume(moduleJobId: string): Promise<ModuleResultCommitRecord> {
    for (;;) {
      let record = this.#repository.get(moduleJobId);
      if (!record) {
        throw new ModuleResultCommitError(
          "MODULE_RESULT_COMMIT_RECORD_MISSING",
          `Module result commit ${moduleJobId} does not exist`,
        );
      }
      assertModuleResultCommitRecord(record);
      if (record.state === "prepared") {
        this.#assertPreparedResultAllowed(record);
      }
      if (record.state === "committed") {
        if (record.blockProposal !== undefined) {
          const blockEffectId = this.#blockEffectId(moduleJobId);
          const effect = this.#blocks.inspectCommitEffect(blockEffectId);
          if (!effect) {
            throw new ModuleResultCommitError(
              "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
              `Committed Module job ${moduleJobId} is missing its Block effect`,
            );
          }
          const block = this.#blocks.commitOnce(
            blockEffectId,
            record.blockProposal,
            record.source,
          );
          if (record.blockId !== block.id) {
            throw new ModuleResultCommitError(
              "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
              `Committed Module job ${moduleJobId} points to another output Block`,
            );
          }
          for (const output of record.outputDeliveries) {
            const deliveryEffectId = this.#deliveryEffectId(moduleJobId, output.pageId);
            const deliveryEffect = this.#deliveries.inspectAppendEffect(deliveryEffectId);
            if (!deliveryEffect) {
              throw new ModuleResultCommitError(
                "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
                `Committed Module job ${moduleJobId} is missing an output Delivery effect`,
              );
            }
            const delivery = this.#deliveries.appendOnce(
              deliveryEffectId,
              output.pageId,
              block.id,
            );
            if (delivery.deliveryId !== output.deliveryId) {
              throw new ModuleResultCommitError(
                "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
                `Committed Module job ${moduleJobId} points to another output Delivery`,
              );
            }
          }
        }
        this.#deliveries.ack({
          moduleJobId: record.moduleJobId,
          claimToken: record.claimToken,
          runId: record.runId,
          attempt: record.attempt,
          moduleGenerationId: record.moduleGenerationId,
        });
        if (record.blockProposal !== undefined) {
          this.#blocks.releaseCommitEffect(this.#blockEffectId(moduleJobId));
        }
        return record;
      }

      if (record.blockProposal !== undefined) {
        const block = this.#blocks.commitOnce(
          this.#blockEffectId(moduleJobId),
          record.blockProposal,
          record.source,
        );
        if (record.blockId !== undefined && record.blockId !== block.id) {
          throw new ModuleResultCommitError(
            "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
            `Module job ${moduleJobId} points to another output Block`,
          );
        }
        if (record.blockId === undefined) {
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

      this.#deliveries.ack({
        moduleJobId: record.moduleJobId,
        claimToken: record.claimToken,
        runId: record.runId,
        attempt: record.attempt,
        moduleGenerationId: record.moduleGenerationId,
      });
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

  #blockEffectId(moduleJobId: string): string {
    return canonicalJsonDigest(["module-result-commit-block", moduleJobId]);
  }

  #deliveryEffectId(moduleJobId: string, pageId: string): string {
    return canonicalJsonDigest(["module-result-commit-delivery", moduleJobId, pageId]);
  }
}
