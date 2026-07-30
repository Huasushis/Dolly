import {
  canonicalJsonByteLength,
  canonicalJsonDigest,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  contentReferences,
  parseBlockContent,
  type BlockReferenceItem,
  type MediaReferenceItem,
} from "./block-content.js";
import { type Block, type BlockStore } from "./block-store.js";
import { type AccessLease, type StrongReference } from "./reference-graph.js";
import {
  buildReactiveModuleInput,
  measureReactiveModuleInput,
  type ReactiveModuleInput,
  type ReactiveModuleInputBlockGroup,
} from "./reactive-module-input.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface DeliveryRecord {
  readonly schemaVersion: "dolly.delivery/1";
  readonly deliveryId: string;
  readonly pageId: string;
  readonly pageSequence: string;
  readonly globalSequence: string;
  readonly blockId: string;
  readonly enqueuedAt: string;
}

export type BlockDeliveryGroup = ReactiveModuleInputBlockGroup;

/**
 * A ModuleJob is one persistent logical work unit assigned to a Module. It
 * keeps the same immutable Delivery input across retry Runs until it reaches a
 * terminal result or failure; the Module qualifier distinguishes it from
 * provider and background jobs represented elsewhere in Dolly.
 */
export interface DeliveryClaim {
  readonly claimToken: string;
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
  readonly deliveryIds: readonly string[];
  readonly blockGroups: readonly BlockDeliveryGroup[];
  readonly hasMore: boolean;
}

export interface ClaimRequest {
  readonly consumerId: string;
  readonly pageIds: readonly string[];
  readonly moduleGenerationId: string;
  readonly maxCount: number;
  readonly maxBytes: number;
  readonly maxInputBytes?: number;
}

export interface FailureClassification {
  readonly code: string;
  readonly retryable: boolean;
}

export interface DeliveryClaimIdentity {
  readonly moduleJobId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
}

export interface NegativeAcknowledgementRequest extends DeliveryClaimIdentity {
  readonly failure: FailureClassification;
}

export interface DeadLetterRecord {
  readonly schemaVersion: "dolly.dead-letter/2";
  readonly deadLetterId: string;
  readonly deliveryId: string;
  readonly blockId: string;
  readonly pageId: string;
  readonly consumerId: string;
  readonly moduleJobId: string;
  readonly attempts: number;
  readonly failureCode: string;
  readonly createdAt: string;
}

export type SubscriptionStart =
  | "from-head"
  | "from-now"
  | { readonly checkpoint: string };

export type DeliveryStoreErrorCode =
  | "DELIVERY_ID_INVALID"
  | "DELIVERY_ID_CONFLICT"
  | "DELIVERY_EFFECT_CONFLICT"
  | "PAGE_EXISTS"
  | "PAGE_NOT_FOUND"
  | "BLOCK_NOT_FOUND"
  | "SUBSCRIPTION_EXISTS"
  | "SUBSCRIPTION_INVALID"
  | "CONSUMER_NOT_REGISTERED"
  | "CLAIM_ACTIVE"
  | "CLAIM_STALE"
  | "CLAIM_MODULE_JOB_MISMATCH"
  | "CLAIM_RUN_MISMATCH"
  | "CLAIM_ATTEMPT_MISMATCH"
  | "CLAIM_GENERATION_MISMATCH"
  | "CLAIM_LIMIT_INVALID"
  | "FAILURE_CLASSIFICATION_INVALID"
  | "CLAIM_ITEM_OVERSIZE"
  | "MODULE_JOB_INPUT_PAGE_SET_CHANGED"
  | "DELIVERY_SNAPSHOT_INVALID"
  | "CLAIM_PERSISTENCE_UNCONFIRMED"
  | "DELIVERY_PERSISTENCE_FAILED";

export class DeliveryStoreError extends Error {
  constructor(
    readonly code: DeliveryStoreErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "DeliveryStoreError";
  }
}

/**
 * Claim creation changed this store in memory, but the final synchronous
 * persistence callback failed. The immutable Claim contains the exact Module
 * job ID, Claim token, run ID, attempt, and Module generation that a caller
 * must re-check after persistence succeeds; this error does not prove that
 * the Claim would survive a process restart.
 */
export class DeliveryClaimPersistenceUnconfirmedError extends DeliveryStoreError {
  constructor(readonly claim: DeliveryClaim) {
    super(
      "CLAIM_PERSISTENCE_UNCONFIRMED",
      "Delivery Claim was created but its final persistence write is unconfirmed",
      {
        claimToken: claim.claimToken,
        moduleJobId: claim.moduleJobId,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
      },
    );
    this.name = "DeliveryClaimPersistenceUnconfirmedError";
  }
}

export interface DeliveryStoreOptions {
  readonly blocks: BlockStore;
  readonly nextId: (
    kind: "delivery" | "module-job" | "run" | "claim" | "lease" | "dead-letter",
  ) => string;
  readonly now: () => string;
  readonly maxFailedAttempts: number;
  readonly snapshot?: DeliveryStoreSnapshot;
  readonly onMutation?: () => void;
}

interface PageState {
  readonly id: string;
  nextSequence: bigint;
  readonly deliveryIds: string[];
  readonly subscriptions: Map<string, SubscriptionState>;
}

interface SubscriptionState {
  readonly consumerId: string;
  readonly start: SubscriptionStart;
  readonly startAfter: bigint;
}

type ObligationStatus = "pending" | "claimed" | "acked" | "dead-lettered";

interface DeliveryState {
  readonly record: DeliveryRecord;
  readonly obligations: Map<string, ObligationStatus>;
  readonly strongReference: StrongReference;
}

/** Internal persistent state for the ModuleJob defined above. */
interface ModuleJobState {
  readonly moduleJobId: string;
  readonly consumerId: string;
  readonly pageIds: readonly string[];
  readonly deliveryIds: readonly string[];
  /**
   * Whether pending Deliveries remained when this exact input was selected.
   * It is part of the immutable Module input and must not change on retry.
   */
  readonly hasMore: boolean;
  attempt: number;
  /** Number of Runs recorded as failed by a negative acknowledgement. */
  failedAttemptCount: number;
  status: "ready" | "claimed" | "committed" | "dead-lettered";
  activeClaimToken?: string;
  activeRunId?: string;
  activeGenerationId?: string;
  activeLeaseIds: string[];
}

interface ClaimState {
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
  /**
   * `released` means Core confirmed that this Run's executor process exited.
   * The old Claim can no longer submit, acknowledge, or negatively acknowledge
   * a result, while the same immutable Delivery batch remains pending for the
   * Module job. Existing Claim states either keep a Run active, classify a
   * failure, or finish the Delivery obligation, so none represents an orderly
   * stop that preserves the work.
   */
  status: "active" | "released" | "nacked" | "committed" | "dead-lettered";
}

interface DeliveryAppendEffect {
  readonly pageId: string;
  readonly blockId: string;
  readonly record: DeliveryRecord;
}

export interface ClaimDescriptor {
  readonly moduleJobId: string;
  readonly consumerId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly attempt: number;
  readonly status: ClaimState["status"];
  readonly moduleGenerationId: string;
}

export interface DeliverySubscriptionSnapshot {
  readonly consumerId: string;
  readonly start: SubscriptionStart;
  readonly startAfter: string;
}

export interface DeliveryPendingStatus {
  readonly consumerId: string;
  readonly pageIds: readonly string[];
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly oldestEnqueuedAt: string | null;
}

export interface DeliveryPageSnapshot {
  readonly id: string;
  readonly nextSequence: string;
  readonly deliveryIds: readonly string[];
  readonly subscriptions: readonly DeliverySubscriptionSnapshot[];
}

export interface DeliveryObligationSnapshot {
  readonly consumerId: string;
  readonly status: ObligationStatus;
}

export interface DeliveryStateSnapshot {
  readonly record: DeliveryRecord;
  readonly obligations: readonly DeliveryObligationSnapshot[];
}

export interface ModuleJobStateSnapshot {
  readonly moduleJobId: string;
  readonly consumerId: string;
  readonly pageIds: readonly string[];
  readonly deliveryIds: readonly string[];
  readonly hasMore: boolean;
  readonly attempt: number;
  readonly failedAttemptCount: number;
  readonly status: ModuleJobState["status"];
  readonly activeClaimToken?: string;
  readonly activeRunId?: string;
  readonly activeGenerationId?: string;
  readonly activeLeaseIds: readonly string[];
}

export interface DeliveryClaimStateSnapshot {
  readonly claimToken: string;
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
  readonly status: ClaimState["status"];
}

export interface DeliveryAppendEffectSnapshot {
  readonly effectId: string;
  readonly pageId: string;
  readonly blockId: string;
  readonly record: DeliveryRecord;
}

export interface DeliveryStoreSnapshot {
  readonly schemaVersion: "dolly.delivery-store/6";
  readonly maxFailedAttempts: number;
  readonly nextGlobalSequence: string;
  readonly usedIds: readonly string[];
  readonly pages: readonly DeliveryPageSnapshot[];
  readonly deliveries: readonly DeliveryStateSnapshot[];
  readonly moduleJobs: readonly ModuleJobStateSnapshot[];
  readonly claims: readonly DeliveryClaimStateSnapshot[];
  readonly appendEffects: readonly DeliveryAppendEffectSnapshot[];
  readonly deadLetters: readonly DeadLetterRecord[];
}

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new DeliveryStoreError("DELIVERY_ID_INVALID", `${label} is not a valid identifier`);
  }
}

function canonicalTime(now: () => string): string {
  const timestamp = Date.parse(now());
  if (!Number.isFinite(timestamp)) {
    throw new DeliveryStoreError("DELIVERY_ID_INVALID", "Runtime clock returned invalid time");
  }
  return new Date(timestamp).toISOString();
}

function samePageSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((pageId, index) => pageId === right[index]);
}

function normalizeSubscriptionStart(value: SubscriptionStart): SubscriptionStart {
  if (value === "from-head" || value === "from-now") return value;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.checkpoint !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value.checkpoint)
  ) {
    throw new DeliveryStoreError(
      "SUBSCRIPTION_INVALID",
      "Subscription start must be from-head, from-now, or an exact decimal checkpoint",
    );
  }
  return deepFreeze({ checkpoint: value.checkpoint });
}

function assertSnapshotObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryStoreError("DELIVERY_SNAPSHOT_INVALID", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DeliveryStoreError(
      "DELIVERY_SNAPSHOT_INVALID",
      `${label} must be a plain object`,
    );
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new DeliveryStoreError(
      "DELIVERY_SNAPSHOT_INVALID",
      `${label} contains unknown fields`,
    );
  }
}

function assertCanonicalTimestamp(value: string, label: string): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new DeliveryStoreError(
      "DELIVERY_SNAPSHOT_INVALID",
      `${label} is not a canonical timestamp`,
    );
  }
}

function strongReferenceKey(reference: StrongReference): string {
  return JSON.stringify([
    reference.ownerKind,
    reference.ownerId,
    reference.targetKind,
    reference.targetId,
  ]);
}

export class DeliveryStore {
  readonly #blocks: BlockStore;
  readonly #nextId: DeliveryStoreOptions["nextId"];
  readonly #now: () => string;
  readonly #maxFailedAttempts: number;
  readonly #usedIds = new Set<string>();
  readonly #pages = new Map<string, PageState>();
  readonly #deliveries = new Map<string, DeliveryState>();
  readonly #moduleJobs = new Map<string, ModuleJobState>();
  readonly #activeByConsumer = new Map<string, string>();
  readonly #claims = new Map<string, ClaimState>();
  readonly #appendEffects = new Map<string, DeliveryAppendEffect>();
  readonly #deadLetters: DeadLetterRecord[] = [];
  #onMutation: (() => void) | undefined;
  #persistenceDirty = false;
  #notifyingMutation = false;
  #nextGlobalSequence = 1n;

  constructor(options: DeliveryStoreOptions) {
    if (
      !Number.isSafeInteger(options.maxFailedAttempts) ||
      options.maxFailedAttempts <= 0
    ) {
      throw new TypeError("maxFailedAttempts must be a positive safe integer");
    }
    this.#blocks = options.blocks;
    this.#nextId = options.nextId;
    this.#now = options.now;
    this.#maxFailedAttempts = options.maxFailedAttempts;
    this.#onMutation = options.onMutation;
    if (options.snapshot) this.#restore(options.snapshot);
  }

  /** Returns whether this Delivery store uses the supplied exact Block store. */
  usesSameBlockStore(blocks: BlockStore): boolean {
    try {
      return blocks.isSameBlockStore(this.#blocks);
    } catch {
      return false;
    }
  }

  setMutationObserver(observer: (() => void) | undefined): void {
    if (observer !== undefined && typeof observer !== "function") {
      throw new TypeError("DeliveryStore mutation observer must be a function");
    }
    this.#onMutation = observer;
  }

  flushPersistence(): void {
    if (!this.#persistenceDirty || !this.#onMutation) return;
    this.#notifyMutationObserver();
  }

  snapshot(): DeliveryStoreSnapshot {
    const pages = [...this.#pages.values()]
      .map((page) => ({
        id: page.id,
        nextSequence: page.nextSequence.toString(10),
        deliveryIds: [...page.deliveryIds],
        subscriptions: [...page.subscriptions.values()]
          .map((subscription) => ({
            consumerId: subscription.consumerId,
            start:
              typeof subscription.start === "string"
                ? subscription.start
                : { checkpoint: subscription.start.checkpoint },
            startAfter: subscription.startAfter.toString(10),
          }))
          .sort((left, right) => left.consumerId.localeCompare(right.consumerId)),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const deliveries = [...this.#deliveries.values()]
      .sort((left, right) => {
        const leftSequence = BigInt(left.record.globalSequence);
        const rightSequence = BigInt(right.record.globalSequence);
        return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
      })
      .map((delivery) => ({
        record: delivery.record,
        obligations: [...delivery.obligations.entries()]
          .map(([consumerId, status]) => ({ consumerId, status }))
          .sort((left, right) => left.consumerId.localeCompare(right.consumerId)),
      }));
    const moduleJobs = [...this.#moduleJobs.values()]
      .map((moduleJob) => ({
        moduleJobId: moduleJob.moduleJobId,
        consumerId: moduleJob.consumerId,
        pageIds: [...moduleJob.pageIds],
        deliveryIds: [...moduleJob.deliveryIds],
        hasMore: moduleJob.hasMore,
        attempt: moduleJob.attempt,
        failedAttemptCount: moduleJob.failedAttemptCount,
        status: moduleJob.status,
        ...(moduleJob.activeClaimToken === undefined
          ? {}
          : { activeClaimToken: moduleJob.activeClaimToken }),
        ...(moduleJob.activeRunId === undefined ? {} : { activeRunId: moduleJob.activeRunId }),
        ...(moduleJob.activeGenerationId === undefined
          ? {}
          : { activeGenerationId: moduleJob.activeGenerationId }),
        activeLeaseIds: [...moduleJob.activeLeaseIds],
      }))
      .sort((left, right) => left.moduleJobId.localeCompare(right.moduleJobId));
    const claims = [...this.#claims.entries()]
      .map(([claimToken, claim]) => ({ claimToken, ...claim }))
      .sort((left, right) => left.claimToken.localeCompare(right.claimToken));
    const appendEffects = [...this.#appendEffects.entries()]
      .map(([effectId, effect]) => ({ effectId, ...effect }))
      .sort((left, right) => left.effectId.localeCompare(right.effectId));
    return deepFreeze({
      schemaVersion: "dolly.delivery-store/6" as const,
      maxFailedAttempts: this.#maxFailedAttempts,
      nextGlobalSequence: this.#nextGlobalSequence.toString(10),
      usedIds: [...this.#usedIds].sort(),
      pages,
      deliveries,
      moduleJobs,
      claims,
      appendEffects,
      deadLetters: [...this.#deadLetters],
    });
  }

  createPage(pageId: string): void {
    this.flushPersistence();
    assertId(pageId, "pageId");
    if (this.#pages.has(pageId)) {
      throw new DeliveryStoreError("PAGE_EXISTS", `Page ${pageId} already exists`);
    }
    this.#pages.set(pageId, {
      id: pageId,
      nextSequence: 1n,
      deliveryIds: [],
      subscriptions: new Map(),
    });
    this.#persistMutation();
  }

  registerConsumer(pageId: string, consumerId: string, start: SubscriptionStart): void {
    this.flushPersistence();
    const page = this.#requirePage(pageId);
    assertId(consumerId, "consumerId");
    if (page.subscriptions.has(consumerId)) {
      throw new DeliveryStoreError(
        "SUBSCRIPTION_EXISTS",
        `Consumer ${consumerId} is already registered on Page ${pageId}`,
      );
    }

    const normalizedStart = normalizeSubscriptionStart(start);
    let startAfter: bigint;
    if (normalizedStart === "from-now") {
      startAfter = page.nextSequence - 1n;
    } else if (normalizedStart === "from-head") {
      const first = page.deliveryIds
        .map((id) => this.#deliveries.get(id))
        .find((delivery) => delivery !== undefined);
      startAfter = first ? BigInt(first.record.pageSequence) - 1n : page.nextSequence - 1n;
    } else {
      startAfter = BigInt(normalizedStart.checkpoint);
      if (startAfter >= page.nextSequence) {
        throw new DeliveryStoreError(
          "SUBSCRIPTION_INVALID",
          "checkpoint is beyond the current Page frontier",
        );
      }
      const firstRetained = page.deliveryIds
        .map((id) => this.#deliveries.get(id))
        .find((delivery) => delivery !== undefined);
      if (firstRetained && startAfter < BigInt(firstRetained.record.pageSequence) - 1n) {
        throw new DeliveryStoreError(
          "SUBSCRIPTION_INVALID",
          "checkpoint is older than the retained Page frontier",
        );
      }
    }

    page.subscriptions.set(consumerId, {
      consumerId,
      start: normalizedStart,
      startAfter,
    });
    for (const deliveryId of page.deliveryIds) {
      const delivery = this.#deliveries.get(deliveryId);
      if (delivery && BigInt(delivery.record.pageSequence) > startAfter) {
        delivery.obligations.set(consumerId, "pending");
      }
    }
    this.#persistMutation();
  }

  inspectSubscription(
    pageId: string,
    consumerId: string,
  ): DeliverySubscriptionSnapshot | null {
    this.flushPersistence();
    const page = this.#requirePage(pageId);
    assertId(consumerId, "consumerId");
    const subscription = page.subscriptions.get(consumerId);
    if (!subscription) return null;
    return deepFreeze({
      consumerId,
      start:
        typeof subscription.start === "string"
          ? subscription.start
          : { checkpoint: subscription.start.checkpoint },
      startAfter: subscription.startAfter.toString(10),
    });
  }

  inspectPending(consumerId: string, pageIds: readonly string[]): DeliveryPendingStatus {
    this.flushPersistence();
    const validatedPageIds = this.validateClaimPages(consumerId, pageIds);
    const pending = this.#pendingFor(consumerId, validatedPageIds);
    let pendingBytes = 0;
    for (const delivery of pending) {
      pendingBytes += canonicalJsonByteLength(this.#blocks.get(delivery.record.blockId)!);
      if (!Number.isSafeInteger(pendingBytes)) {
        throw new DeliveryStoreError(
          "CLAIM_LIMIT_INVALID",
          "Pending Block bytes exceed the safe integer range",
        );
      }
    }
    return deepFreeze({
      consumerId,
      pageIds: [...validatedPageIds],
      pendingCount: pending.length,
      pendingBytes,
      oldestEnqueuedAt: pending[0]?.record.enqueuedAt ?? null,
    });
  }

  append(pageId: string, blockId: string): DeliveryRecord {
    this.flushPersistence();
    const record = this.#append(pageId, blockId);
    this.#persistMutation();
    return record;
  }

  #append(pageId: string, blockId: string): DeliveryRecord {
    const page = this.#requirePage(pageId);
    const block = this.#blocks.get(blockId);
    if (!block) {
      throw new DeliveryStoreError("BLOCK_NOT_FOUND", `Block ${blockId} is not committed`);
    }

    const deliveryId = this.#allocate("delivery");
    const pageSequence = page.nextSequence;
    const globalSequence = this.#nextGlobalSequence;
    const enqueuedAt = canonicalTime(this.#now);
    const strongReference: StrongReference = {
      ownerKind: "delivery",
      ownerId: deliveryId,
      targetKind: "block",
      targetId: blockId,
    };
    this.#blocks.referenceGraph.addStrongReference(strongReference);

    const record = deepFreeze({
      schemaVersion: "dolly.delivery/1" as const,
      deliveryId,
      pageId,
      pageSequence: pageSequence.toString(10),
      globalSequence: globalSequence.toString(10),
      blockId,
      enqueuedAt,
    });
    const obligations = new Map<string, ObligationStatus>();
    for (const subscription of page.subscriptions.values()) {
      if (pageSequence > subscription.startAfter) {
        obligations.set(subscription.consumerId, "pending");
      }
    }

    this.#deliveries.set(deliveryId, { record, obligations, strongReference });
    page.deliveryIds.push(deliveryId);
    page.nextSequence += 1n;
    this.#nextGlobalSequence += 1n;
    return record;
  }

  appendOnce(effectId: string, pageId: string, blockId: string): DeliveryRecord {
    this.flushPersistence();
    assertId(effectId, "effectId");
    assertId(pageId, "pageId");
    assertId(blockId, "blockId");
    const existing = this.#appendEffects.get(effectId);
    if (existing) {
      if (existing.pageId !== pageId || existing.blockId !== blockId) {
        throw new DeliveryStoreError(
          "DELIVERY_EFFECT_CONFLICT",
          `Delivery effect ${effectId} was already committed with another target`,
          { effectId },
        );
      }
      return existing.record;
    }

    const record = this.#append(pageId, blockId);
    this.#appendEffects.set(
      effectId,
      deepFreeze({ pageId, blockId, record }),
    );
    this.#persistMutation();
    return record;
  }

  validateOutputPages(pageIds: readonly string[]): readonly string[] {
    this.flushPersistence();
    const seen = new Set<string>();
    const validated: string[] = [];
    for (const pageId of pageIds) {
      assertId(pageId, "pageId");
      if (seen.has(pageId)) {
        throw new DeliveryStoreError(
          "SUBSCRIPTION_INVALID",
          `Output Page ${pageId} is duplicated`,
        );
      }
      this.#requirePage(pageId);
      seen.add(pageId);
      validated.push(pageId);
    }
    return deepFreeze(validated);
  }

  validateClaimPages(consumerId: string, pageIds: readonly string[]): readonly string[] {
    this.flushPersistence();
    assertId(consumerId, "consumerId");
    const validated = [...new Set(pageIds)].sort();
    if (validated.length !== pageIds.length || validated.length === 0) {
      throw new DeliveryStoreError(
        "SUBSCRIPTION_INVALID",
        "claim must name a non-empty unique Page set",
      );
    }
    for (const pageId of validated) {
      const page = this.#requirePage(pageId);
      if (!page.subscriptions.has(consumerId)) {
        throw new DeliveryStoreError(
          "CONSUMER_NOT_REGISTERED",
          `Consumer ${consumerId} is not registered on Page ${pageId}`,
        );
      }
    }
    return deepFreeze(validated);
  }

  inspectClaim(request: DeliveryClaimIdentity): ClaimDescriptor {
    this.flushPersistence();
    const claim = this.#requireClaim(request);
    const moduleJob = this.#moduleJobs.get(claim.moduleJobId);
    if (!moduleJob) {
      throw new DeliveryStoreError(
        "CLAIM_STALE",
        `Claim ${request.claimToken} has no Module job`,
      );
    }
    return deepFreeze({
      moduleJobId: claim.moduleJobId,
      consumerId: moduleJob.consumerId,
      claimToken: request.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      status: claim.status,
      moduleGenerationId: claim.moduleGenerationId,
    });
  }

  /**
   * Rebuilds the immutable input of one exact Claim from its persisted Module
   * job and Delivery records. Callers do not supply any part of the input.
   */
  inspectClaimInput(request: DeliveryClaimIdentity): ReactiveModuleInput {
    this.flushPersistence();
    const claim = this.#requireClaim(request);
    const moduleJob = this.#moduleJobs.get(claim.moduleJobId);
    if (!moduleJob) {
      throw new DeliveryStoreError(
        "CLAIM_STALE",
        `Claim ${request.claimToken} has no Module job`,
      );
    }
    return this.#buildReactiveInput(moduleJob.deliveryIds, moduleJob.hasMore);
  }

  /**
   * Return the distinct IDs of Blocks delivered directly to this claim. This
   * reads the Module job's persisted Delivery IDs on every call instead of
   * keeping a second list, so a claim cannot drift away from its input
   * Deliveries.
   */
  inspectClaimInputBlockIds(request: DeliveryClaimIdentity): readonly string[] {
    this.flushPersistence();
    const claim = this.#requireClaim(request);
    const moduleJob = this.#moduleJobs.get(claim.moduleJobId);
    if (!moduleJob) {
      throw new DeliveryStoreError(
        "CLAIM_STALE",
        `Claim ${request.claimToken} has no Module job`,
      );
    }

    const blockIds = new Set<string>();
    for (const deliveryId of moduleJob.deliveryIds) {
      const delivery = this.#deliveries.get(deliveryId);
      if (!delivery) {
        throw new DeliveryStoreError(
          "CLAIM_STALE",
          `Claim ${request.claimToken} is missing Delivery ${deliveryId}`,
        );
      }
      if (!this.#blocks.has(delivery.record.blockId)) {
        throw new DeliveryStoreError(
          "BLOCK_NOT_FOUND",
          `Claim ${request.claimToken} input Block ${delivery.record.blockId} is missing`,
        );
      }
      blockIds.add(delivery.record.blockId);
    }
    return deepFreeze([...blockIds]);
  }

  /**
   * Return only the Media references in the immutable Blocks delivered to this
   * claim. The trusted result coordinator uses this to prevent a Module from
   * forwarding a Media item it did not receive as input.
   */
  inspectClaimInputMediaReferences(request: DeliveryClaimIdentity): readonly MediaReferenceItem[] {
    this.flushPersistence();
    const claim = this.#requireClaim(request);
    const moduleJob = this.#moduleJobs.get(claim.moduleJobId);
    if (!moduleJob) {
      throw new DeliveryStoreError(
        "CLAIM_STALE",
        `Claim ${request.claimToken} has no Module job`,
      );
    }

    const references: MediaReferenceItem[] = [];
    for (const deliveryId of moduleJob.deliveryIds) {
      const delivery = this.#deliveries.get(deliveryId);
      if (!delivery) {
        throw new DeliveryStoreError(
          "CLAIM_STALE",
          `Claim ${request.claimToken} is missing Delivery ${deliveryId}`,
        );
      }
      const block = this.#blocks.get(delivery.record.blockId);
      if (!block) {
        throw new DeliveryStoreError(
          "BLOCK_NOT_FOUND",
          `Claim ${request.claimToken} input Block ${delivery.record.blockId} is missing`,
        );
      }
      if (block.payload.schema !== "dolly.content/1") continue;
      try {
        references.push(...contentReferences(parseBlockContent(block.payload.value)).media);
      } catch {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          `Claim ${request.claimToken} input Block ${block.id} has invalid content`,
        );
      }
    }
    return deepFreeze(references);
  }

  inspectAppendEffect(effectId: string): DeliveryAppendEffectSnapshot | null {
    this.flushPersistence();
    assertId(effectId, "effectId");
    const effect = this.#appendEffects.get(effectId);
    return effect === undefined
      ? null
      : deepFreeze({ effectId, ...effect });
  }

  /**
   * Lists every existing Page identity without exposing the rest of the
   * Delivery snapshot. Append effects can target only existing Pages, and
   * Pages are not removed, so callers can inspect a deterministic effect ID
   * for each Page without scanning the unbounded append-effect history.
   */
  listPageIds(): readonly string[] {
    this.flushPersistence();
    return deepFreeze([...this.#pages.keys()].sort((left, right) =>
      left.localeCompare(right)));
  }

  claim(request: ClaimRequest): DeliveryClaim | null {
    this.flushPersistence();
    assertId(request.consumerId, "consumerId");
    assertId(request.moduleGenerationId, "moduleGenerationId");
    if (
      !Number.isSafeInteger(request.maxCount) ||
      request.maxCount <= 0 ||
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes <= 0 ||
      (request.maxInputBytes !== undefined &&
        (!Number.isSafeInteger(request.maxInputBytes) || request.maxInputBytes <= 0))
    ) {
      throw new DeliveryStoreError(
        "CLAIM_LIMIT_INVALID",
        "claim count, Block byte, and input byte limits must be positive safe integers",
      );
    }

    const pageIds = this.validateClaimPages(request.consumerId, request.pageIds);

    let moduleJob: ModuleJobState | undefined;
    const existingId = this.#activeByConsumer.get(request.consumerId);
    if (existingId) {
      moduleJob = this.#moduleJobs.get(existingId)!;
      if (moduleJob.status === "claimed") {
        throw new DeliveryStoreError(
          "CLAIM_ACTIVE",
          `Consumer ${request.consumerId} already has an active claim`,
        );
      }
      if (!samePageSet(moduleJob.pageIds, pageIds)) {
        throw new DeliveryStoreError(
          "MODULE_JOB_INPUT_PAGE_SET_CHANGED",
          "A retry must use the Module job's original Page set",
        );
      }
    }

    let input: ReactiveModuleInput;
    if (!moduleJob) {
      const candidates = this.#pendingFor(request.consumerId, pageIds);
      if (candidates.length === 0) return null;

      const eligible: DeliveryState[] = [];
      let selectedBytes = 0;
      for (const candidate of candidates) {
        if (eligible.length >= request.maxCount) break;
        const block = this.#blocks.get(candidate.record.blockId)!;
        const bytes = canonicalJsonByteLength(block);
        if (eligible.length === 0 && bytes > request.maxBytes) {
          throw new DeliveryStoreError(
            "CLAIM_ITEM_OVERSIZE",
            `Delivery ${candidate.record.deliveryId} exceeds the claim byte limit`,
            { deliveryId: candidate.record.deliveryId, bytes, maxBytes: request.maxBytes },
          );
        }
        if (selectedBytes + bytes > request.maxBytes) break;
        eligible.push(candidate);
        selectedBytes += bytes;
      }

      let selected = eligible;
      if (request.maxInputBytes !== undefined) {
        const first = this.#buildReactiveInput(
          [eligible[0]!.record.deliveryId],
          candidates.length > 1,
        );
        const firstBytes = measureReactiveModuleInput(first);
        if (firstBytes > request.maxInputBytes) {
          throw new DeliveryStoreError(
            "CLAIM_ITEM_OVERSIZE",
            `Delivery ${eligible[0]!.record.deliveryId} exceeds the Module input byte limit`,
            {
              deliveryId: eligible[0]!.record.deliveryId,
              bytes: firstBytes,
              maxBytes: request.maxInputBytes,
              limit: "reactive-module-input",
            },
          );
        }

        let low = 1;
        let high = eligible.length;
        let fittingCount = 1;
        // Canonical input size grows with this sequence-ordered prefix. Binary
        // search keeps exact envelope measurement within O(n log n).
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const candidateInput = this.#buildReactiveInput(
            eligible.slice(0, middle).map((delivery) => delivery.record.deliveryId),
            middle < candidates.length,
          );
          if (measureReactiveModuleInput(candidateInput) <= request.maxInputBytes) {
            fittingCount = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        selected = eligible.slice(0, fittingCount);
      }

      const hasMore = selected.length < candidates.length;
      input = this.#buildReactiveInput(
        selected.map((delivery) => delivery.record.deliveryId),
        hasMore,
      );
      moduleJob = {
        moduleJobId: this.#allocate("module-job"),
        consumerId: request.consumerId,
        pageIds,
        deliveryIds: selected.map((delivery) => delivery.record.deliveryId),
        hasMore,
        attempt: 0,
        failedAttemptCount: 0,
        status: "ready",
        activeLeaseIds: [],
      };
      this.#moduleJobs.set(moduleJob.moduleJobId, moduleJob);
      this.#activeByConsumer.set(request.consumerId, moduleJob.moduleJobId);
    } else {
      input = this.#buildReactiveInput(moduleJob.deliveryIds, moduleJob.hasMore);
      const bytes = measureReactiveModuleInput(input);
      if (request.maxInputBytes !== undefined && bytes > request.maxInputBytes) {
        throw new DeliveryStoreError(
          "CLAIM_ITEM_OVERSIZE",
          `Module job ${moduleJob.moduleJobId} exceeds the Module input byte limit`,
          {
            deliveryId: moduleJob.deliveryIds[0]!,
            moduleJobId: moduleJob.moduleJobId,
            bytes,
            maxBytes: request.maxInputBytes,
            limit: "reactive-module-input",
          },
        );
      }
    }

    const claimToken = this.#allocate("claim");
    const runId = this.#allocate("run");
    const leaseIds: string[] = [];
    try {
      for (const blockId of new Set(
        moduleJob.deliveryIds.map((deliveryId) => this.#deliveries.get(deliveryId)!.record.blockId),
      )) {
        const leaseId = this.#allocate("lease");
        const lease: AccessLease = {
          leaseId,
          ownerKind: "module-job",
          ownerId: moduleJob.moduleJobId,
          targetKind: "block",
          targetId: blockId,
          kind: "active-claim",
          moduleGenerationId: request.moduleGenerationId,
          moduleJobId: moduleJob.moduleJobId,
          runId,
        };
        this.#blocks.referenceGraph.acquireLease(lease);
        leaseIds.push(leaseId);
      }
    } catch (error) {
      for (const leaseId of leaseIds) this.#blocks.referenceGraph.releaseLease(leaseId);
      throw error;
    }

    for (const deliveryId of moduleJob.deliveryIds) {
      this.#deliveries.get(deliveryId)!.obligations.set(request.consumerId, "claimed");
    }
    moduleJob.attempt += 1;
    moduleJob.status = "claimed";
    moduleJob.activeClaimToken = claimToken;
    moduleJob.activeRunId = runId;
    moduleJob.activeGenerationId = request.moduleGenerationId;
    moduleJob.activeLeaseIds = leaseIds;
    this.#claims.set(claimToken, {
      moduleJobId: moduleJob.moduleJobId,
      runId,
      attempt: moduleJob.attempt,
      moduleGenerationId: request.moduleGenerationId,
      status: "active",
    });

    const result = deepFreeze({
      claimToken,
      moduleJobId: moduleJob.moduleJobId,
      runId,
      attempt: moduleJob.attempt,
      moduleGenerationId: request.moduleGenerationId,
      deliveryIds: input.claimedDeliveryIds,
      blockGroups: input.blockGroups,
      hasMore: input.hasMore,
    });
    try {
      this.#persistMutation();
    } catch (error) {
      if (
        error instanceof DeliveryStoreError &&
        error.code === "DELIVERY_PERSISTENCE_FAILED"
      ) {
        throw new DeliveryClaimPersistenceUnconfirmedError(result);
      }
      throw error;
    }
    return result;
  }

  ack(request: DeliveryClaimIdentity): "committed" | "already-committed" {
    this.flushPersistence();
    const claim = this.#requireClaim(request);
    if (claim.status === "committed") return "already-committed";
    if (claim.status !== "active") {
      throw new DeliveryStoreError("CLAIM_STALE", `Claim ${request.claimToken} is no longer active`);
    }

    const moduleJob = this.#moduleJobs.get(claim.moduleJobId)!;
    for (const deliveryId of moduleJob.deliveryIds) {
      this.#deliveries.get(deliveryId)!.obligations.set(moduleJob.consumerId, "acked");
    }
    this.#releaseModuleJobLeases(moduleJob);
    moduleJob.status = "committed";
    claim.status = "committed";
    this.#activeByConsumer.delete(moduleJob.consumerId);
    this.#persistMutation();
    return "committed";
  }

  releaseClaim(request: DeliveryClaimIdentity): "released" | "already-released" {
    this.flushPersistence();
    const claim = this.#requireClaim(request);
    if (claim.status === "released") return "already-released";
    if (claim.status !== "active") {
      throw new DeliveryStoreError(
        "CLAIM_STALE",
        `Claim ${request.claimToken} is no longer active`,
      );
    }

    const moduleJob = this.#moduleJobs.get(claim.moduleJobId)!;
    for (const deliveryId of moduleJob.deliveryIds) {
      this.#deliveries.get(deliveryId)!.obligations.set(moduleJob.consumerId, "pending");
    }
    this.#releaseModuleJobLeases(moduleJob);
    moduleJob.status = "ready";
    moduleJob.activeClaimToken = undefined;
    moduleJob.activeRunId = undefined;
    moduleJob.activeGenerationId = undefined;
    claim.status = "released";
    this.#persistMutation();
    return "released";
  }

  nack(request: NegativeAcknowledgementRequest): "retry-scheduled" | "dead-lettered" {
    this.flushPersistence();
    const claim = this.#requireClaim(request);
    if (claim.status !== "active") {
      throw new DeliveryStoreError("CLAIM_STALE", `Claim ${request.claimToken} is no longer active`);
    }
    if (
      request.failure === null ||
      typeof request.failure !== "object" ||
      !ID_PATTERN.test(request.failure.code) ||
      typeof request.failure.retryable !== "boolean"
    ) {
      throw new DeliveryStoreError(
        "FAILURE_CLASSIFICATION_INVALID",
        "failure classification must contain a valid code and boolean retryable flag",
      );
    }

    const moduleJob = this.#moduleJobs.get(claim.moduleJobId)!;
    this.#releaseModuleJobLeases(moduleJob);
    moduleJob.failedAttemptCount += 1;

    if (
      request.failure.retryable &&
      moduleJob.failedAttemptCount < this.#maxFailedAttempts
    ) {
      for (const deliveryId of moduleJob.deliveryIds) {
        this.#deliveries.get(deliveryId)!.obligations.set(moduleJob.consumerId, "pending");
      }
      moduleJob.status = "ready";
      claim.status = "nacked";
      moduleJob.activeClaimToken = undefined;
      moduleJob.activeRunId = undefined;
      moduleJob.activeGenerationId = undefined;
      this.#persistMutation();
      return "retry-scheduled";
    }

    for (const deliveryId of moduleJob.deliveryIds) {
      const delivery = this.#deliveries.get(deliveryId)!;
      delivery.obligations.set(moduleJob.consumerId, "dead-lettered");
      const deadLetterId = this.#allocate("dead-letter");
      const deadLetter = deepFreeze({
        schemaVersion: "dolly.dead-letter/2" as const,
        deadLetterId,
        deliveryId,
        blockId: delivery.record.blockId,
        pageId: delivery.record.pageId,
        consumerId: moduleJob.consumerId,
        moduleJobId: moduleJob.moduleJobId,
        attempts: moduleJob.attempt,
        failureCode: request.failure.code,
        createdAt: canonicalTime(this.#now),
      });
      this.#deadLetters.push(deadLetter);
      this.#blocks.referenceGraph.addStrongReference({
        ownerKind: "dead-letter",
        ownerId: deadLetterId,
        targetKind: "block",
        targetId: delivery.record.blockId,
      });
    }
    moduleJob.status = "dead-lettered";
    claim.status = "dead-lettered";
    this.#activeByConsumer.delete(moduleJob.consumerId);
    this.#persistMutation();
    return "dead-lettered";
  }

  listDeadLetters(): readonly DeadLetterRecord[] {
    this.flushPersistence();
    return [...this.#deadLetters];
  }

  listActiveClaims(): readonly ClaimDescriptor[] {
    this.flushPersistence();
    return deepFreeze(
      [...this.#claims.entries()]
        .filter(([, claim]) => claim.status === "active")
        .map(([claimToken, claim]) => {
          const moduleJob = this.#moduleJobs.get(claim.moduleJobId);
          if (!moduleJob) {
            throw new DeliveryStoreError(
              "CLAIM_STALE",
              `Claim ${claimToken} has no Module job`,
            );
          }
          return { claimToken, consumerId: moduleJob.consumerId, ...claim };
        })
        .sort((left, right) => left.moduleJobId.localeCompare(right.moduleJobId)),
    );
  }

  pruneTerminal(pageId: string): number {
    this.flushPersistence();
    const page = this.#requirePage(pageId);
    let pruned = 0;
    const retained: string[] = [];
    for (const deliveryId of page.deliveryIds) {
      const delivery = this.#deliveries.get(deliveryId);
      if (!delivery) continue;
      const terminal = [...delivery.obligations.values()].every(
        (status) => status === "acked" || status === "dead-lettered",
      );
      if (!terminal) {
        retained.push(deliveryId);
        continue;
      }
      this.#blocks.referenceGraph.removeStrongReference(delivery.strongReference);
      this.#deliveries.delete(deliveryId);
      pruned += 1;
    }
    page.deliveryIds.splice(0, page.deliveryIds.length, ...retained);
    if (pruned > 0) this.#persistMutation();
    return pruned;
  }

  #restore(snapshot: DeliveryStoreSnapshot): void {
    try {
      this.#restoreValidated(snapshot);
    } catch (error) {
      if (
        error instanceof DeliveryStoreError &&
        error.code === "DELIVERY_SNAPSHOT_INVALID"
      ) {
        throw error;
      }
      throw new DeliveryStoreError(
        "DELIVERY_SNAPSHOT_INVALID",
        "DeliveryStore snapshot is invalid",
      );
    }
  }

  #restoreValidated(snapshot: DeliveryStoreSnapshot): void {
    assertSnapshotObject(
      snapshot,
      [
        "schemaVersion",
        "maxFailedAttempts",
        "nextGlobalSequence",
        "usedIds",
        "pages",
        "deliveries",
        "moduleJobs",
        "claims",
        "appendEffects",
        "deadLetters",
      ],
      "DeliveryStore snapshot",
    );
    if (
      snapshot.schemaVersion !== "dolly.delivery-store/6" ||
      snapshot.maxFailedAttempts !== this.#maxFailedAttempts ||
      typeof snapshot.nextGlobalSequence !== "string" ||
      !/^[1-9][0-9]*$/.test(snapshot.nextGlobalSequence) ||
      !Array.isArray(snapshot.usedIds) ||
      !Array.isArray(snapshot.pages) ||
      !Array.isArray(snapshot.deliveries) ||
      !Array.isArray(snapshot.moduleJobs) ||
      !Array.isArray(snapshot.claims) ||
      !Array.isArray(snapshot.appendEffects) ||
      !Array.isArray(snapshot.deadLetters)
    ) {
      throw new DeliveryStoreError(
        "DELIVERY_SNAPSHOT_INVALID",
        "DeliveryStore snapshot schema or retry policy is invalid",
      );
    }
    this.#nextGlobalSequence = BigInt(snapshot.nextGlobalSequence);

    for (const id of snapshot.usedIds) {
      if (typeof id !== "string" || !ID_PATTERN.test(id) || this.#usedIds.has(id)) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "DeliveryStore used-ID history is invalid",
        );
      }
      this.#usedIds.add(id);
    }

    for (const candidate of snapshot.pages) {
      assertSnapshotObject(
        candidate,
        ["id", "nextSequence", "deliveryIds", "subscriptions"],
        "Page snapshot",
      );
      if (
        typeof candidate.id !== "string" ||
        !ID_PATTERN.test(candidate.id) ||
        this.#pages.has(candidate.id) ||
        typeof candidate.nextSequence !== "string" ||
        !/^[1-9][0-9]*$/.test(candidate.nextSequence) ||
        !Array.isArray(candidate.deliveryIds) ||
        !Array.isArray(candidate.subscriptions)
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Page snapshot envelope is invalid",
        );
      }
      const deliveryIds = new Set<string>();
      for (const deliveryId of candidate.deliveryIds) {
        if (
          typeof deliveryId !== "string" ||
          !ID_PATTERN.test(deliveryId) ||
          deliveryIds.has(deliveryId)
        ) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Page delivery order contains an invalid or duplicate ID",
          );
        }
        deliveryIds.add(deliveryId);
      }
      const subscriptions = new Map<string, SubscriptionState>();
      for (const subscription of candidate.subscriptions) {
        assertSnapshotObject(
          subscription,
          ["consumerId", "start", "startAfter"],
          "Subscription snapshot",
        );
        let start: SubscriptionStart;
        try {
          start = normalizeSubscriptionStart(subscription.start as SubscriptionStart);
        } catch {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Subscription snapshot start is invalid",
          );
        }
        if (
          typeof subscription.consumerId !== "string" ||
          !ID_PATTERN.test(subscription.consumerId) ||
          subscriptions.has(subscription.consumerId) ||
          typeof subscription.startAfter !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(subscription.startAfter) ||
          BigInt(subscription.startAfter) >= BigInt(candidate.nextSequence)
        ) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Subscription snapshot is invalid",
          );
        }
        subscriptions.set(subscription.consumerId, {
          consumerId: subscription.consumerId,
          start,
          startAfter: BigInt(subscription.startAfter),
        });
      }
      this.#pages.set(candidate.id, {
        id: candidate.id,
        nextSequence: BigInt(candidate.nextSequence),
        deliveryIds: [...candidate.deliveryIds],
        subscriptions,
      });
    }

    const globalSequences = new Set<string>();
    for (const candidate of snapshot.deliveries) {
      assertSnapshotObject(candidate, ["record", "obligations"], "Delivery snapshot");
      if (!Array.isArray(candidate.obligations)) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Delivery obligations must be an array",
        );
      }
      const record = this.#normalizeDeliveryRecord(candidate.record, "Delivery record");
      if (
        this.#deliveries.has(record.deliveryId) ||
        globalSequences.has(record.globalSequence) ||
        BigInt(record.globalSequence) >= this.#nextGlobalSequence ||
        !this.#blocks.has(record.blockId)
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Live Delivery identity, sequence, or Block target is invalid",
        );
      }
      const page = this.#pages.get(record.pageId);
      if (!page || !page.deliveryIds.includes(record.deliveryId)) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Live Delivery is not present on its Page",
        );
      }
      const obligations = new Map<string, ObligationStatus>();
      for (const obligation of candidate.obligations) {
        assertSnapshotObject(
          obligation,
          ["consumerId", "status"],
          "Delivery obligation",
        );
        if (
          typeof obligation.consumerId !== "string" ||
          !ID_PATTERN.test(obligation.consumerId) ||
          obligations.has(obligation.consumerId) ||
          (obligation.status !== "pending" &&
            obligation.status !== "claimed" &&
            obligation.status !== "acked" &&
            obligation.status !== "dead-lettered")
        ) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Delivery obligation is invalid",
          );
        }
        const subscription = page.subscriptions.get(obligation.consumerId);
        if (!subscription || BigInt(record.pageSequence) <= subscription.startAfter) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Delivery obligation has no matching subscription occurrence",
          );
        }
        obligations.set(obligation.consumerId, obligation.status);
      }
      for (const subscription of page.subscriptions.values()) {
        if (
          BigInt(record.pageSequence) > subscription.startAfter &&
          !obligations.has(subscription.consumerId)
        ) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Delivery snapshot omits a subscribed consumer obligation",
          );
        }
      }
      const strongReference: StrongReference = {
        ownerKind: "delivery",
        ownerId: record.deliveryId,
        targetKind: "block",
        targetId: record.blockId,
      };
      if (!this.#blocks.referenceGraph.hasStrongReference(strongReference)) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Live Delivery strong reference is missing",
        );
      }
      globalSequences.add(record.globalSequence);
      this.#deliveries.set(record.deliveryId, { record, obligations, strongReference });
    }

    const listedDeliveryIds = new Set<string>();
    for (const page of this.#pages.values()) {
      let previousSequence = 0n;
      for (const deliveryId of page.deliveryIds) {
        const delivery = this.#deliveries.get(deliveryId);
        if (
          !delivery ||
          delivery.record.pageId !== page.id ||
          listedDeliveryIds.has(deliveryId)
        ) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Page delivery index is inconsistent",
          );
        }
        const sequence = BigInt(delivery.record.pageSequence);
        if (sequence <= previousSequence || sequence >= page.nextSequence) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Page delivery sequence is inconsistent",
          );
        }
        previousSequence = sequence;
        listedDeliveryIds.add(deliveryId);
      }
    }
    if (listedDeliveryIds.size !== this.#deliveries.size) {
      throw new DeliveryStoreError(
        "DELIVERY_SNAPSHOT_INVALID",
        "A live Delivery is not indexed by exactly one Page",
      );
    }

    const activeConsumers = new Set<string>();
    for (const candidate of snapshot.moduleJobs) {
      assertSnapshotObject(
        candidate,
        [
          "moduleJobId",
          "consumerId",
          "pageIds",
          "deliveryIds",
          "hasMore",
          "attempt",
          "failedAttemptCount",
          "status",
          "activeClaimToken",
          "activeRunId",
          "activeGenerationId",
          "activeLeaseIds",
        ],
        "Module job snapshot",
      );
      if (
        typeof candidate.moduleJobId !== "string" ||
        !ID_PATTERN.test(candidate.moduleJobId) ||
        this.#moduleJobs.has(candidate.moduleJobId) ||
        typeof candidate.consumerId !== "string" ||
        !ID_PATTERN.test(candidate.consumerId) ||
        !Array.isArray(candidate.pageIds) ||
        candidate.pageIds.length === 0 ||
        !Array.isArray(candidate.deliveryIds) ||
        candidate.deliveryIds.length === 0 ||
        typeof candidate.hasMore !== "boolean" ||
        !Number.isSafeInteger(candidate.attempt) ||
        candidate.attempt < 0 ||
        !Number.isSafeInteger(candidate.failedAttemptCount) ||
        candidate.failedAttemptCount < 0 ||
        candidate.failedAttemptCount > candidate.attempt ||
        (candidate.status !== "ready" &&
          candidate.status !== "claimed" &&
          candidate.status !== "committed" &&
          candidate.status !== "dead-lettered") ||
        !Array.isArray(candidate.activeLeaseIds)
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Module job snapshot envelope is invalid",
        );
      }
      const pageIds = [...candidate.pageIds];
      if (
        new Set(pageIds).size !== pageIds.length ||
        pageIds.some((pageId) => typeof pageId !== "string" || !ID_PATTERN.test(pageId)) ||
        [...pageIds].sort().some((pageId, index) => pageId !== pageIds[index])
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Module job Page set is not a canonical unique set",
        );
      }
      for (const pageId of pageIds) {
        if (!this.#pages.get(pageId)?.subscriptions.has(candidate.consumerId)) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Module job consumer is not subscribed to every input Page",
          );
        }
      }
      const deliveryIds = [...candidate.deliveryIds];
      if (
        new Set(deliveryIds).size !== deliveryIds.length ||
        deliveryIds.some(
          (deliveryId) => typeof deliveryId !== "string" || !ID_PATTERN.test(deliveryId),
        )
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Module job Delivery set is invalid",
        );
      }
      const isActive = candidate.status === "ready" || candidate.status === "claimed";
      if (isActive) {
        if (activeConsumers.has(candidate.consumerId)) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "A consumer has more than one active Module job",
          );
        }
        activeConsumers.add(candidate.consumerId);
      }
      const expectedObligation =
        candidate.status === "ready"
          ? "pending"
          : candidate.status === "claimed"
            ? "claimed"
            : candidate.status === "committed"
              ? "acked"
              : "dead-lettered";
      for (const deliveryId of deliveryIds) {
        const delivery = this.#deliveries.get(deliveryId);
        if (isActive && !delivery) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "An active Module job refers to a pruned Delivery",
          );
        }
        if (
          delivery &&
          delivery.obligations.get(candidate.consumerId) !== expectedObligation
        ) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Module job status conflicts with its Delivery obligations",
          );
        }
      }
      for (const [label, id] of [
        ["activeClaimToken", candidate.activeClaimToken],
        ["activeRunId", candidate.activeRunId],
        ["activeGenerationId", candidate.activeGenerationId],
      ] as const) {
        if (id !== undefined && (typeof id !== "string" || !ID_PATTERN.test(id))) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            `Module job ${label} is invalid`,
          );
        }
      }
      if (
        candidate.activeLeaseIds.some(
          (leaseId: unknown) =>
            typeof leaseId !== "string" || !ID_PATTERN.test(leaseId),
        ) ||
        new Set(candidate.activeLeaseIds).size !== candidate.activeLeaseIds.length
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Module job lease set is invalid",
        );
      }
      const hasActiveClaimIdentity =
        candidate.activeClaimToken !== undefined &&
        candidate.activeRunId !== undefined &&
        candidate.activeGenerationId !== undefined;
      if (
        (candidate.status === "ready" &&
          (hasActiveClaimIdentity ||
            candidate.activeClaimToken !== undefined ||
            candidate.activeRunId !== undefined ||
            candidate.activeGenerationId !== undefined ||
            candidate.activeLeaseIds.length > 0)) ||
        (candidate.status !== "ready" && !hasActiveClaimIdentity) ||
        (candidate.status !== "claimed" && candidate.activeLeaseIds.length > 0) ||
        (candidate.status !== "ready" && candidate.attempt === 0)
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Module job active Claim identity does not match its status",
        );
      }
      const moduleJob: ModuleJobState = {
        moduleJobId: candidate.moduleJobId,
        consumerId: candidate.consumerId,
        pageIds: deepFreeze(pageIds),
        deliveryIds: deepFreeze(deliveryIds),
        hasMore: candidate.hasMore,
        attempt: candidate.attempt,
        failedAttemptCount: candidate.failedAttemptCount,
        status: candidate.status,
        ...(candidate.activeClaimToken === undefined
          ? {}
          : { activeClaimToken: candidate.activeClaimToken }),
        ...(candidate.activeRunId === undefined
          ? {}
          : { activeRunId: candidate.activeRunId }),
        ...(candidate.activeGenerationId === undefined
          ? {}
          : { activeGenerationId: candidate.activeGenerationId }),
        activeLeaseIds: [...candidate.activeLeaseIds],
      };
      this.#moduleJobs.set(moduleJob.moduleJobId, moduleJob);
      if (isActive) this.#activeByConsumer.set(moduleJob.consumerId, moduleJob.moduleJobId);
    }

    const claimsByModuleJob = new Map<string, Array<[string, ClaimState]>>();
    for (const candidate of snapshot.claims) {
      assertSnapshotObject(
        candidate,
        [
          "claimToken",
          "moduleJobId",
          "runId",
          "attempt",
          "moduleGenerationId",
          "status",
        ],
        "Claim snapshot",
      );
      if (
        typeof candidate.claimToken !== "string" ||
        !ID_PATTERN.test(candidate.claimToken) ||
        this.#claims.has(candidate.claimToken) ||
        typeof candidate.moduleJobId !== "string" ||
        !ID_PATTERN.test(candidate.moduleJobId) ||
        typeof candidate.runId !== "string" ||
        !ID_PATTERN.test(candidate.runId) ||
        typeof candidate.moduleGenerationId !== "string" ||
        !ID_PATTERN.test(candidate.moduleGenerationId) ||
        !Number.isSafeInteger(candidate.attempt) ||
        candidate.attempt <= 0 ||
        (candidate.status !== "active" &&
          candidate.status !== "released" &&
          candidate.status !== "nacked" &&
          candidate.status !== "committed" &&
          candidate.status !== "dead-lettered")
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Claim snapshot is invalid",
        );
      }
      const moduleJob = this.#moduleJobs.get(candidate.moduleJobId);
      if (!moduleJob) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Claim refers to a missing Module job",
        );
      }
      const claim: ClaimState = {
        moduleJobId: candidate.moduleJobId,
        runId: candidate.runId,
        attempt: candidate.attempt,
        moduleGenerationId: candidate.moduleGenerationId,
        status: candidate.status,
      };
      this.#claims.set(candidate.claimToken, claim);
      const group = claimsByModuleJob.get(candidate.moduleJobId) ?? [];
      group.push([candidate.claimToken, claim]);
      claimsByModuleJob.set(candidate.moduleJobId, group);
    }

    const expectedActiveLeaseIds = new Set<string>();
    for (const moduleJob of this.#moduleJobs.values()) {
      const claims = (claimsByModuleJob.get(moduleJob.moduleJobId) ?? []).sort(
        (left, right) => left[1].attempt - right[1].attempt,
      );
      if (claims.length !== moduleJob.attempt) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Module job attempt count does not match its claim history",
        );
      }
      for (let index = 0; index < claims.length; index += 1) {
        if (claims[index]![1].attempt !== index + 1) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Module job claim attempts are not contiguous",
          );
        }
        if (
          index < claims.length - 1 &&
          claims[index]![1].status !== "nacked" &&
          claims[index]![1].status !== "released"
        ) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Only a nacked or released Claim may precede a later Run",
          );
        }
      }
      const failedAttemptCount = claims.filter(
        ([, claim]) => claim.status === "nacked" || claim.status === "dead-lettered",
      ).length;
      if (
        moduleJob.failedAttemptCount !== failedAttemptCount ||
        moduleJob.failedAttemptCount > this.#maxFailedAttempts ||
        (moduleJob.status !== "dead-lettered" &&
          moduleJob.failedAttemptCount >= this.#maxFailedAttempts) ||
        (moduleJob.status === "dead-lettered" && moduleJob.failedAttemptCount === 0)
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Module job failed attempt count conflicts with its Claim history",
        );
      }
      if (moduleJob.attempt === 0) {
        if (moduleJob.status !== "ready") {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "A zero-attempt Module job must be ready",
          );
        }
        continue;
      }
      const [claimToken, latest] = claims[claims.length - 1]!;
      if (
        (moduleJob.status === "ready"
          ? latest.status !== "nacked" && latest.status !== "released"
          : moduleJob.status === "claimed"
            ? latest.status !== "active"
            : latest.status !== moduleJob.status) ||
        (moduleJob.status !== "ready" &&
          (moduleJob.activeClaimToken !== claimToken ||
            moduleJob.activeRunId !== latest.runId ||
            moduleJob.activeGenerationId !== latest.moduleGenerationId))
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Module job status or active Claim identity conflicts with its latest Claim",
        );
      }

      if (moduleJob.status === "claimed") {
        const expectedBlockIds = new Set(
          moduleJob.deliveryIds.map(
            (deliveryId) => this.#deliveries.get(deliveryId)!.record.blockId,
          ),
        );
        if (moduleJob.activeLeaseIds.length !== expectedBlockIds.size) {
          throw new DeliveryStoreError(
            "DELIVERY_SNAPSHOT_INVALID",
            "Active Module job lease count does not match its unique Blocks",
          );
        }
        const leasedBlockIds = new Set<string>();
        for (const leaseId of moduleJob.activeLeaseIds) {
          const lease = this.#blocks.referenceGraph.getLease(leaseId);
          if (
            !lease ||
            lease.ownerKind !== "module-job" ||
            lease.ownerId !== moduleJob.moduleJobId ||
            lease.targetKind !== "block" ||
            lease.kind !== "active-claim" ||
            lease.moduleJobId !== moduleJob.moduleJobId ||
            lease.runId !== latest.runId ||
            lease.moduleGenerationId !== latest.moduleGenerationId ||
            !expectedBlockIds.has(lease.targetId) ||
            leasedBlockIds.has(lease.targetId)
          ) {
            throw new DeliveryStoreError(
              "DELIVERY_SNAPSHOT_INVALID",
              "Active Module job lease identity is inconsistent",
            );
          }
          leasedBlockIds.add(lease.targetId);
          expectedActiveLeaseIds.add(leaseId);
        }
      }
    }

    const effectDeliveryIds = new Set<string>();
    for (const candidate of snapshot.appendEffects) {
      assertSnapshotObject(
        candidate,
        ["effectId", "pageId", "blockId", "record"],
        "Delivery append effect",
      );
      if (
        typeof candidate.effectId !== "string" ||
        !ID_PATTERN.test(candidate.effectId) ||
        this.#appendEffects.has(candidate.effectId) ||
        typeof candidate.pageId !== "string" ||
        !ID_PATTERN.test(candidate.pageId) ||
        typeof candidate.blockId !== "string" ||
        !ID_PATTERN.test(candidate.blockId)
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Delivery append effect identity is invalid",
        );
      }
      const record = this.#normalizeDeliveryRecord(candidate.record, "Append-effect record");
      const page = this.#pages.get(candidate.pageId);
      const live = this.#deliveries.get(record.deliveryId);
      if (
        !page ||
        candidate.pageId !== record.pageId ||
        candidate.blockId !== record.blockId ||
        BigInt(record.pageSequence) >= page.nextSequence ||
        BigInt(record.globalSequence) >= this.#nextGlobalSequence ||
        effectDeliveryIds.has(record.deliveryId) ||
        (live !== undefined &&
          canonicalJsonDigest(live.record) !== canonicalJsonDigest(record))
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Delivery append effect conflicts with its historical record",
        );
      }
      effectDeliveryIds.add(record.deliveryId);
      this.#appendEffects.set(
        candidate.effectId,
        deepFreeze({ pageId: candidate.pageId, blockId: candidate.blockId, record }),
      );
    }

    const deadLetterIds = new Set<string>();
    const deadLetterDeliveries = new Set<string>();
    for (const candidate of snapshot.deadLetters) {
      const record = this.#normalizeDeadLetter(candidate);
      const moduleJob = this.#moduleJobs.get(record.moduleJobId);
      const strongReference: StrongReference = {
        ownerKind: "dead-letter",
        ownerId: record.deadLetterId,
        targetKind: "block",
        targetId: record.blockId,
      };
      if (
        deadLetterIds.has(record.deadLetterId) ||
        deadLetterDeliveries.has(record.deliveryId) ||
        !this.#pages.has(record.pageId) ||
        !this.#blocks.has(record.blockId) ||
        !moduleJob ||
        moduleJob.status !== "dead-lettered" ||
        moduleJob.consumerId !== record.consumerId ||
        moduleJob.attempt !== record.attempts ||
        !moduleJob.deliveryIds.includes(record.deliveryId) ||
        !this.#blocks.referenceGraph.hasStrongReference(strongReference)
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Dead-letter record or strong reference is inconsistent",
        );
      }
      deadLetterIds.add(record.deadLetterId);
      deadLetterDeliveries.add(record.deliveryId);
      this.#deadLetters.push(record);
    }
    for (const moduleJob of this.#moduleJobs.values()) {
      if (
        moduleJob.status === "dead-lettered" &&
        moduleJob.deliveryIds.some((deliveryId) => !deadLetterDeliveries.has(deliveryId))
      ) {
        throw new DeliveryStoreError(
          "DELIVERY_SNAPSHOT_INVALID",
          "Dead-lettered Module job is missing a Delivery record",
        );
      }
    }

    const referenceGraph = this.#blocks.referenceGraph.snapshot();
    const expectedDeliveryReferences = new Set(
      [...this.#deliveries.values()].map((delivery) =>
        strongReferenceKey(delivery.strongReference),
      ),
    );
    const actualDeliveryReferences = new Set(
      referenceGraph.strongReferences
        .filter((reference) => reference.ownerKind === "delivery")
        .map(strongReferenceKey),
    );
    const expectedDeadLetterReferences = new Set(
      this.#deadLetters.map((deadLetter) =>
        strongReferenceKey({
          ownerKind: "dead-letter",
          ownerId: deadLetter.deadLetterId,
          targetKind: "block",
          targetId: deadLetter.blockId,
        }),
      ),
    );
    const actualDeadLetterReferences = new Set(
      referenceGraph.strongReferences
        .filter((reference) => reference.ownerKind === "dead-letter")
        .map(strongReferenceKey),
    );
    const actualActiveLeaseIds = new Set(
      referenceGraph.leases
        .filter((lease) => lease.kind === "active-claim" && lease.ownerKind === "module-job")
        .map((lease) => lease.leaseId),
    );
    if (
      !this.#sameStringSet(expectedDeliveryReferences, actualDeliveryReferences) ||
      !this.#sameStringSet(expectedDeadLetterReferences, actualDeadLetterReferences) ||
      !this.#sameStringSet(expectedActiveLeaseIds, actualActiveLeaseIds)
    ) {
      throw new DeliveryStoreError(
        "DELIVERY_SNAPSHOT_INVALID",
        "Delivery strong references or active leases contain stale entries",
      );
    }

    const observedUsedIds = new Set<string>();
    for (const delivery of this.#deliveries.values()) {
      observedUsedIds.add(delivery.record.deliveryId);
    }
    for (const effect of this.#appendEffects.values()) {
      observedUsedIds.add(effect.record.deliveryId);
    }
    for (const moduleJob of this.#moduleJobs.values()) {
      observedUsedIds.add(moduleJob.moduleJobId);
      for (const deliveryId of moduleJob.deliveryIds) observedUsedIds.add(deliveryId);
      for (const leaseId of moduleJob.activeLeaseIds) observedUsedIds.add(leaseId);
    }
    for (const [claimToken, claim] of this.#claims) {
      observedUsedIds.add(claimToken);
      observedUsedIds.add(claim.runId);
    }
    for (const deadLetter of this.#deadLetters) {
      observedUsedIds.add(deadLetter.deadLetterId);
      observedUsedIds.add(deadLetter.deliveryId);
    }
    if ([...observedUsedIds].some((id) => !this.#usedIds.has(id))) {
      throw new DeliveryStoreError(
        "DELIVERY_SNAPSHOT_INVALID",
        "DeliveryStore used-ID history omits an allocated identity",
      );
    }
  }

  #normalizeDeliveryRecord(candidate: DeliveryRecord, label: string): DeliveryRecord {
    assertSnapshotObject(
      candidate,
      [
        "schemaVersion",
        "deliveryId",
        "pageId",
        "pageSequence",
        "globalSequence",
        "blockId",
        "enqueuedAt",
      ],
      label,
    );
    if (
      candidate.schemaVersion !== "dolly.delivery/1" ||
      typeof candidate.deliveryId !== "string" ||
      !ID_PATTERN.test(candidate.deliveryId) ||
      typeof candidate.pageId !== "string" ||
      !ID_PATTERN.test(candidate.pageId) ||
      typeof candidate.pageSequence !== "string" ||
      !/^[1-9][0-9]*$/.test(candidate.pageSequence) ||
      typeof candidate.globalSequence !== "string" ||
      !/^[1-9][0-9]*$/.test(candidate.globalSequence) ||
      typeof candidate.blockId !== "string" ||
      !ID_PATTERN.test(candidate.blockId) ||
      typeof candidate.enqueuedAt !== "string"
    ) {
      throw new DeliveryStoreError(
        "DELIVERY_SNAPSHOT_INVALID",
        `${label} envelope is invalid`,
      );
    }
    assertCanonicalTimestamp(candidate.enqueuedAt, `${label}.enqueuedAt`);
    return deepFreeze({ ...candidate });
  }

  #normalizeDeadLetter(candidate: DeadLetterRecord): DeadLetterRecord {
    assertSnapshotObject(
      candidate,
      [
        "schemaVersion",
        "deadLetterId",
        "deliveryId",
        "blockId",
        "pageId",
        "consumerId",
        "moduleJobId",
        "attempts",
        "failureCode",
        "createdAt",
      ],
      "Dead-letter record",
    );
    if (
      candidate.schemaVersion !== "dolly.dead-letter/2" ||
      typeof candidate.deadLetterId !== "string" ||
      !ID_PATTERN.test(candidate.deadLetterId) ||
      typeof candidate.deliveryId !== "string" ||
      !ID_PATTERN.test(candidate.deliveryId) ||
      typeof candidate.blockId !== "string" ||
      !ID_PATTERN.test(candidate.blockId) ||
      typeof candidate.pageId !== "string" ||
      !ID_PATTERN.test(candidate.pageId) ||
      typeof candidate.consumerId !== "string" ||
      !ID_PATTERN.test(candidate.consumerId) ||
      typeof candidate.moduleJobId !== "string" ||
      !ID_PATTERN.test(candidate.moduleJobId) ||
      !Number.isSafeInteger(candidate.attempts) ||
      candidate.attempts <= 0 ||
      typeof candidate.failureCode !== "string" ||
      !ID_PATTERN.test(candidate.failureCode) ||
      typeof candidate.createdAt !== "string"
    ) {
      throw new DeliveryStoreError(
        "DELIVERY_SNAPSHOT_INVALID",
        "Dead-letter record envelope is invalid",
      );
    }
    assertCanonicalTimestamp(candidate.createdAt, "Dead-letter record.createdAt");
    return deepFreeze({ ...candidate });
  }

  #sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    return left.size === right.size && [...left].every((value) => right.has(value));
  }

  #requirePage(pageId: string): PageState {
    assertId(pageId, "pageId");
    const page = this.#pages.get(pageId);
    if (!page) throw new DeliveryStoreError("PAGE_NOT_FOUND", `Page ${pageId} does not exist`);
    return page;
  }

  #allocate(kind: Parameters<DeliveryStoreOptions["nextId"]>[0]): string {
    let id: string;
    try {
      id = this.#nextId(kind);
    } catch {
      throw new DeliveryStoreError(
        "DELIVERY_ID_INVALID",
        `Runtime ${kind} identifier allocator failed`,
      );
    }
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      throw new DeliveryStoreError(
        "DELIVERY_ID_INVALID",
        `Runtime generated an invalid ${kind} identifier`,
      );
    }
    if (this.#usedIds.has(id)) {
      throw new DeliveryStoreError(
        "DELIVERY_ID_CONFLICT",
        `Runtime generated duplicate identifier ${id}`,
      );
    }
    this.#usedIds.add(id);
    return id;
  }

  #pendingFor(consumerId: string, pageIds: readonly string[]): DeliveryState[] {
    const pageSet = new Set(pageIds);
    return [...this.#deliveries.values()]
      .filter(
        (delivery) =>
          pageSet.has(delivery.record.pageId) &&
          delivery.obligations.get(consumerId) === "pending",
      )
      .sort((left, right) =>
        BigInt(left.record.globalSequence) < BigInt(right.record.globalSequence) ? -1 : 1,
      );
  }

  #buildReactiveInput(
    deliveryIds: readonly string[],
    hasMore: boolean,
  ): ReactiveModuleInput {
    return buildReactiveModuleInput({
      claimedDeliveryIds: deliveryIds,
      blockGroups: this.#groupDeliveriesByBlock(deliveryIds),
      hasMore,
    });
  }

  #groupDeliveriesByBlock(deliveryIds: readonly string[]): readonly BlockDeliveryGroup[] {
    const groups = new Map<
      string,
      { block: Block; deliveryIds: string[]; sequences: bigint[] }
    >();
    for (const deliveryId of deliveryIds) {
      const delivery = this.#deliveries.get(deliveryId)!;
      const block = this.#blocks.get(delivery.record.blockId)!;
      const group = groups.get(block.id) ?? { block, deliveryIds: [], sequences: [] };
      group.deliveryIds.push(deliveryId);
      group.sequences.push(BigInt(delivery.record.globalSequence));
      groups.set(block.id, group);
    }
    return [...groups.values()].map((group) =>
      deepFreeze({
        block: group.block,
        deliveryIds: [...group.deliveryIds],
        occurrenceCount: group.deliveryIds.length,
        firstGlobalSequence: group.sequences[0]!.toString(10),
        lastGlobalSequence: group.sequences[group.sequences.length - 1]!.toString(10),
      }),
    );
  }

  #requireClaim(request: DeliveryClaimIdentity): ClaimState {
    assertId(request.moduleJobId, "moduleJobId");
    assertId(request.claimToken, "claimToken");
    assertId(request.runId, "runId");
    assertId(request.moduleGenerationId, "moduleGenerationId");
    if (!Number.isSafeInteger(request.attempt) || request.attempt <= 0) {
      throw new DeliveryStoreError(
        "CLAIM_ATTEMPT_MISMATCH",
        "Claim attempt must be a positive safe integer",
      );
    }
    const claim = this.#claims.get(request.claimToken);
    if (!claim) {
      throw new DeliveryStoreError("CLAIM_STALE", `Claim ${request.claimToken} is unknown`);
    }
    if (claim.moduleJobId !== request.moduleJobId) {
      throw new DeliveryStoreError(
        "CLAIM_MODULE_JOB_MISMATCH",
        `Claim ${request.claimToken} belongs to another Module job`,
      );
    }
    if (claim.runId !== request.runId) {
      throw new DeliveryStoreError(
        "CLAIM_RUN_MISMATCH",
        `Claim ${request.claimToken} belongs to another run`,
      );
    }
    if (claim.attempt !== request.attempt) {
      throw new DeliveryStoreError(
        "CLAIM_ATTEMPT_MISMATCH",
        `Claim ${request.claimToken} belongs to another attempt`,
      );
    }
    if (claim.moduleGenerationId !== request.moduleGenerationId) {
      throw new DeliveryStoreError(
        "CLAIM_GENERATION_MISMATCH",
        `Claim ${request.claimToken} belongs to another Module generation`,
      );
    }
    return claim;
  }

  #releaseModuleJobLeases(moduleJob: ModuleJobState): void {
    for (const leaseId of moduleJob.activeLeaseIds) {
      this.#blocks.referenceGraph.releaseLease(leaseId);
    }
    moduleJob.activeLeaseIds = [];
  }

  #persistMutation(): void {
    if (!this.#onMutation) return;
    this.#persistenceDirty = true;
    this.#notifyMutationObserver();
  }

  #notifyMutationObserver(): void {
    if (!this.#onMutation) return;
    if (this.#notifyingMutation) {
      throw new DeliveryStoreError(
        "DELIVERY_PERSISTENCE_FAILED",
        "DeliveryStore mutation observer re-entered the store",
      );
    }
    this.#notifyingMutation = true;
    try {
      const result = (this.#onMutation as () => unknown)();
      if (result !== undefined) {
        throw new TypeError("DeliveryStore mutation observers must complete synchronously");
      }
      this.#persistenceDirty = false;
    } catch {
      throw new DeliveryStoreError(
        "DELIVERY_PERSISTENCE_FAILED",
        "DeliveryStore state could not be persisted",
      );
    } finally {
      this.#notifyingMutation = false;
    }
  }
}
