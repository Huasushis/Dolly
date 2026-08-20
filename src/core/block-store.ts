import {
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  contentReferences,
  parseBlockContent,
  type BlockContent,
  type MediaReferenceItem,
} from "./block-content.js";
import {
  ContentSchemaRegistrationError,
  type ContentSchemaRegistrationSet,
} from "./content-schema-registry.js";
import { ReferenceGraph, type ResourceTarget } from "./reference-graph.js";
import {
  findReservedSchemaViolation,
  type ReservedContentSchemaPolicy,
} from "./reserved-content-schema.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/;

export type BlockStoreErrorCode =
  | "BLOCK_PROPOSAL_INVALID"
  | "BLOCK_LIMIT_EXCEEDED"
  | "BLOCK_ID_INVALID"
  | "BLOCK_ID_CONFLICT"
  | "BLOCK_EFFECT_CONFLICT"
  | "BLOCK_SOURCE_INVALID"
  | "BLOCK_CONTENT_INVALID"
  | "BLOCK_REFERENCE_MISSING"
  | "BLOCK_REFERENCE_SELF"
  | "BLOCK_REFERENCE_ORDER"
  | "BLOCK_MEDIA_REFERENCE_INVALID"
  | "BLOCK_MEDIA_MISMATCH"
  | "BLOCK_MEDIA_RESOLVER_UNAVAILABLE"
  | "BLOCK_RESERVED_SCHEMA_FORBIDDEN"
  | "SCHEMA_VALUE_INVALID"
  | "SCHEMA_VALUE_LIMIT_EXCEEDED"
  | "BLOCK_SNAPSHOT_INVALID"
  | "BLOCK_PERSISTENCE_FAILED";

export class BlockStoreError extends Error {
  constructor(
    readonly code: BlockStoreErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "BlockStoreError";
  }
}

export interface SourceIdentity {
  readonly kind: "module" | "external" | "system";
  readonly id: string;
}

export interface BlockPayload {
  readonly schema: string;
  readonly value: JsonValue;
}

export interface BlockProposal {
  readonly summary?: string;
  readonly payload: BlockPayload;
}

export interface Block {
  readonly schemaVersion: "dolly.block/2";
  readonly id: string;
  readonly sequence: string;
  readonly source: SourceIdentity;
  readonly createdAt: string;
  readonly summary?: string;
  readonly payload: BlockPayload;
}

/** Result of checking one media-reference content item against the Media store. */
export interface ResolvedMediaReference {
  readonly mediaId: string;
}

/** Trusted Media lookup used while a Block is being committed. */
export interface MediaReferenceResolver {
  resolve(
    reference: MediaReferenceItem,
    source: SourceIdentity,
  ): ResolvedMediaReference | null | undefined;
}

export interface BlockStoreLimits {
  readonly maxSummaryBytes: number;
  readonly maxPayloadBytes: number;
  readonly maxContentItems: number;
  readonly maxReferences: number;
}

export interface BlockStoreOptions {
  readonly nextBlockId: () => string;
  readonly now: () => string;
  readonly media?: MediaReferenceResolver;
  /**
   * Producer grants for the content-item schema names Core reserves. Omitting
   * it authorizes nobody, so a reserved name is refused rather than opened.
   */
  readonly reservedContentSchemas?: ReservedContentSchemaPolicy;
  /** Complete producer/validator set built from verified installation identity. */
  readonly contentSchemas?: ContentSchemaRegistrationSet;
  readonly referenceGraph?: ReferenceGraph;
  readonly limits?: Partial<BlockStoreLimits>;
  readonly snapshot?: BlockStoreSnapshot;
  readonly onMutation?: () => void;
}

export interface ValidatedBlockInput {
  readonly proposal: BlockProposal;
  readonly source: SourceIdentity;
}

interface BlockCommitEffect {
  readonly digest: string;
  readonly record: Block;
  strongReferenceHeld: boolean;
}

export interface BlockCommitEffectSnapshot {
  readonly effectId: string;
  readonly digest: string;
  readonly record: Block;
  readonly strongReferenceHeld: boolean;
}

/**
 * A durable retirement ticket recorded by the Module-result commit protocol
 * (whose identity cannot be forged by a raw Block caller, since Blocks are
 * never given the ticket mutation surface). The ticket binds the exact
 * job, result digest, and Block before the effect tombstone is removed and
 * survives the separate result-journal delete, so recovery can distinguish
 * "retirement in progress" from persisted corruption.
 *
 * Version 2 additionally binds the complete ordered set of exact
 * Module-result-owned Delivery append-effect identities. Only a version-2
 * ticket authorizes the DeliveryStore retirement operation; a version-1
 * ticket may finish only the original Block retirement semantics.
 */
export type BlockCommitEffectRetirementTicket =
  | {
      readonly schemaVersion: "dolly.commit-effect-retirement/1";
      readonly moduleJobId: string;
      readonly blockId: string;
      readonly digest: string;
    }
  | {
      readonly schemaVersion: "dolly.commit-effect-retirement/2";
      readonly moduleJobId: string;
      readonly blockId: string;
      readonly digest: string;
      readonly deliveryEffectIds: readonly string[];
    };

export type BlockCommitEffectRetirementTicketSnapshot = (
  | {
      readonly schemaVersion: "dolly.commit-effect-retirement/1";
      readonly moduleJobId: string;
      readonly blockId: string;
      readonly digest: string;
    }
  | {
      readonly schemaVersion: "dolly.commit-effect-retirement/2";
      readonly moduleJobId: string;
      readonly blockId: string;
      readonly digest: string;
      readonly deliveryEffectIds: readonly string[];
    }
) & { readonly effectId: string };

export type BlockStoreSnapshotVersion = "dolly.block-store/3" | "dolly.block-store/5";

export interface BlockStoreSnapshot {
  readonly schemaVersion: BlockStoreSnapshotVersion;
  readonly nextSequence: string;
  readonly records: readonly Block[];
  readonly commitEffects: readonly BlockCommitEffectSnapshot[];
  readonly retirementTickets: readonly BlockCommitEffectRetirementTicketSnapshot[];
}

const DEFAULT_LIMITS: BlockStoreLimits = {
  maxSummaryBytes: 4 * 1024,
  maxPayloadBytes: 1024 * 1024,
  maxContentItems: 256,
  maxReferences: 256,
};

function ownKeys(value: object): string[] {
  return Object.keys(value).sort();
}

function assertClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BlockStoreError("BLOCK_PROPOSAL_INVALID", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BlockStoreError("BLOCK_PROPOSAL_INVALID", `${label} must be a plain object`);
  }
  const allowed = new Set(allowedKeys);
  const unexpected = ownKeys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new BlockStoreError(
      "BLOCK_PROPOSAL_INVALID",
      `${label} contains unknown fields: ${unexpected.join(", ")}`,
    );
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new BlockStoreError("BLOCK_PROPOSAL_INVALID", `${label} is not a valid identifier`);
  }
}

function assertName(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    throw new BlockStoreError("BLOCK_PROPOSAL_INVALID", `${label} is not a valid name`);
  }
}

function normalizeSource(value: unknown): SourceIdentity {
  assertClosedObject(value, ["kind", "id"], "source");
  if (value.kind !== "module" && value.kind !== "external" && value.kind !== "system") {
    throw new BlockStoreError("BLOCK_SOURCE_INVALID", "source.kind is not supported");
  }
  try {
    assertIdentifier(value.id, "source.id");
  } catch (error) {
    if (error instanceof BlockStoreError) {
      throw new BlockStoreError("BLOCK_SOURCE_INVALID", error.message);
    }
    throw error;
  }
  return { kind: value.kind, id: value.id };
}

function normalizeProposal(value: unknown, limits: BlockStoreLimits): BlockProposal {
  assertClosedObject(value, ["summary", "payload"], "proposal");

  if (value.summary !== undefined) {
    if (typeof value.summary !== "string" || value.summary.length === 0) {
      throw new BlockStoreError(
        "BLOCK_PROPOSAL_INVALID",
        "proposal.summary must be a non-empty string when present",
      );
    }
    if (Buffer.byteLength(value.summary, "utf8") > limits.maxSummaryBytes) {
      throw new BlockStoreError("BLOCK_LIMIT_EXCEEDED", "proposal.summary exceeds its byte limit");
    }
  }

  assertClosedObject(value.payload, ["schema", "value"], "proposal.payload");
  assertName(value.payload.schema, "proposal.payload.schema");
  try {
    assertJsonValue(value.payload.value, "$.payload.value");
  } catch (error) {
    throw new BlockStoreError(
      "BLOCK_PROPOSAL_INVALID",
      error instanceof Error ? error.message : "proposal.payload.value is not JSON",
    );
  }
  if (canonicalJsonByteLength(value.payload.value) > limits.maxPayloadBytes) {
    throw new BlockStoreError("BLOCK_LIMIT_EXCEEDED", "proposal.payload exceeds its byte limit");
  }

  if (value.payload.schema === "dolly.content/1") {
    let content: BlockContent;
    try {
      content = parseBlockContent(value.payload.value, limits.maxContentItems);
    } catch (error) {
      throw new BlockStoreError(
        "BLOCK_CONTENT_INVALID",
        error instanceof Error ? error.message : "Block content is invalid",
      );
    }
    const references = contentReferences(content);
    if (references.blocks.length + references.media.length > limits.maxReferences) {
      throw new BlockStoreError(
        "BLOCK_LIMIT_EXCEEDED",
        "Block content contains too many references",
      );
    }
  }

  return {
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    payload: {
      schema: value.payload.schema,
      value: cloneJson(value.payload.value),
    },
  };
}

function referencesForProposal(proposal: BlockProposal): ReturnType<typeof contentReferences> {
  if (proposal.payload.schema !== "dolly.content/1") {
    return { blocks: [], media: [] };
  }
  return contentReferences(parseBlockContent(proposal.payload.value));
}

/**
 * Validates a durable retirement ticket reported by the Module-result
 * protocol. The ticket must be a closed object binding the effectId (as its
 * storage key), an exact moduleJobId, the exact Block, and the exact input
 * digest. A raw Block caller cannot stage a ticket (retirement mutations are
 * not part of the public Blocks surface), so this shape is only reachable
 * through the coordinator's durable record.
 */
function normalizeRetirementTicket(
  ticket: unknown,
  effectId: string,
): BlockCommitEffectRetirementTicket {
  assertClosedObject(ticket, ["schemaVersion", "moduleJobId", "blockId", "digest", "deliveryEffectIds"], "retirement ticket");
  if (
    ticket.schemaVersion !== "dolly.commit-effect-retirement/1" &&
    ticket.schemaVersion !== "dolly.commit-effect-retirement/2"
  ) {
    throw new BlockStoreError(
      "BLOCK_EFFECT_CONFLICT",
      "Block retirement ticket schema version is invalid",
      { effectId },
    );
  }
  if (
    typeof ticket.moduleJobId !== "string" ||
    !ID_PATTERN.test(ticket.moduleJobId) ||
    typeof ticket.blockId !== "string" ||
    !ID_PATTERN.test(ticket.blockId) ||
    typeof ticket.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(ticket.digest)
  ) {
    throw new BlockStoreError(
      "BLOCK_EFFECT_CONFLICT",
      "Block retirement ticket does not bind an exact identity",
      { effectId },
    );
  }
  if (ticket.schemaVersion === "dolly.commit-effect-retirement/1") {
    if (ticket.deliveryEffectIds !== undefined) {
      throw new BlockStoreError(
        "BLOCK_EFFECT_CONFLICT",
        "A version-1 retirement ticket cannot bind Delivery append-effect identities",
        { effectId },
      );
    }
    return deepFreeze({
      schemaVersion: "dolly.commit-effect-retirement/1" as const,
      moduleJobId: ticket.moduleJobId,
      blockId: ticket.blockId,
      digest: ticket.digest,
    });
  }

  if (
    !Array.isArray(ticket.deliveryEffectIds) ||
    ticket.deliveryEffectIds.some(
      (deliveryEffectId) => typeof deliveryEffectId !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(deliveryEffectId),
    ) ||
    new Set(ticket.deliveryEffectIds).size !== ticket.deliveryEffectIds.length
  ) {
    throw new BlockStoreError(
      "BLOCK_EFFECT_CONFLICT",
      "A version-2 retirement ticket must bind a unique set of Delivery append-effect identities",
      { effectId },
    );
  }
  return deepFreeze({
    schemaVersion: "dolly.commit-effect-retirement/2" as const,
    moduleJobId: ticket.moduleJobId,
    blockId: ticket.blockId,
    digest: ticket.digest,
    deliveryEffectIds: [...ticket.deliveryEffectIds],
  });
}

export class BlockStore {
  readonly #storeIdentity = {};
  readonly #records = new Map<string, Block>();
  readonly #commitEffects = new Map<string, BlockCommitEffect>();
  readonly #retirementTickets = new Map<string, BlockCommitEffectRetirementTicket>();
  readonly #nextBlockId: () => string;
  readonly #now: () => string;
  readonly #media?: MediaReferenceResolver;
  readonly #reservedContentSchemas?: ReservedContentSchemaPolicy;
  readonly #contentSchemas?: ContentSchemaRegistrationSet;
  readonly #limits: BlockStoreLimits;
  readonly referenceGraph: ReferenceGraph;
  #onMutation: (() => void) | undefined;
  #persistenceDirty = false;
  #notifyingMutation = false;
  #nextSequence = 1n;

  constructor(options: BlockStoreOptions) {
    this.#nextBlockId = options.nextBlockId;
    this.#now = options.now;
    this.#media = options.media;
    if (
      options.reservedContentSchemas !== undefined &&
      options.contentSchemas !== undefined
    ) {
      throw new TypeError(
        "BlockStore cannot combine the interim reserved-name policy with a complete content schema registration set",
      );
    }
    this.#reservedContentSchemas = options.reservedContentSchemas;
    this.#contentSchemas = options.contentSchemas;
    this.referenceGraph = options.referenceGraph ?? new ReferenceGraph();
    this.#onMutation = options.onMutation;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };

    for (const [name, limit] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new TypeError(`BlockStore limit ${name} must be a positive safe integer`);
      }
    }
    if (options.snapshot) this.#restore(options.snapshot);
  }

  /** Returns whether both values operate on this exact Block store instance. */
  isSameBlockStore(other: BlockStore): boolean {
    return this.#storeIdentity === other.#storeIdentity;
  }

  /** Returns whether this store uses this exact frozen registration set. */
  isContentSchemaRegistrationSetBoundTo(
    contentSchemas: ContentSchemaRegistrationSet,
  ): boolean {
    return this.#contentSchemas === contentSchemas;
  }

  get size(): number {
    return this.#records.size;
  }

  get(id: string): Block | null {
    return this.#records.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.#records.has(id);
  }

  inspectCommitEffect(effectId: string): BlockCommitEffectSnapshot | null {
    if (!ID_PATTERN.test(effectId)) {
      throw new BlockStoreError("BLOCK_ID_INVALID", "effectId is not a valid identifier");
    }
    this.flushPersistence();
    const effect = this.#commitEffects.get(effectId);
    return effect === undefined
      ? null
      : deepFreeze({
          effectId,
          digest: effect.digest,
          record: effect.record,
          strongReferenceHeld: effect.strongReferenceHeld,
        });
  }

  inspectCommitEffectRetirementTicket(
    effectId: string,
  ): BlockCommitEffectRetirementTicketSnapshot | null {
    if (!ID_PATTERN.test(effectId)) {
      throw new BlockStoreError("BLOCK_ID_INVALID", "effectId is not a valid identifier");
    }
    this.flushPersistence();
    const ticket = this.#retirementTickets.get(effectId);
    if (ticket === undefined) return null;
    return deepFreeze({
      effectId,
      ...ticket,
    } as BlockCommitEffectRetirementTicketSnapshot);
  }

  listCommitEffectRetirementTickets(): readonly BlockCommitEffectRetirementTicketSnapshot[] {
    this.flushPersistence();
    return deepFreeze(
      [...this.#retirementTickets.entries()]
        .map(([effectId, ticket]) => ({
          effectId,
          ...ticket,
        } as BlockCommitEffectRetirementTicketSnapshot))
        .sort((left, right) =>
          left.effectId < right.effectId ? -1 : left.effectId > right.effectId ? 1 : 0,
        ),
    );
  }

  setMutationObserver(observer: (() => void) | undefined): void {
    if (observer !== undefined && typeof observer !== "function") {
      throw new TypeError("BlockStore mutation observer must be a function");
    }
    this.#onMutation = observer;
  }

  flushPersistence(): void {
    if (!this.#persistenceDirty || !this.#onMutation) return;
    this.#notifyMutationObserver();
  }

  snapshot(): BlockStoreSnapshot {
    const records = [...this.#records.values()].sort((left, right) => {
      const leftSequence = BigInt(left.sequence);
      const rightSequence = BigInt(right.sequence);
      return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
    });
    const commitEffects = [...this.#commitEffects.entries()]
      .map(([effectId, effect]) => ({
        effectId,
        digest: effect.digest,
        record: effect.record,
        strongReferenceHeld: effect.strongReferenceHeld,
      }))
      .sort((left, right) =>
        left.effectId < right.effectId ? -1 : left.effectId > right.effectId ? 1 : 0,
      );
    const retirementTickets = [...this.#retirementTickets.entries()]
      .map(([effectId, ticket]) => ({
        effectId,
        ...ticket,
      }))
      .sort((left, right) =>
        left.effectId < right.effectId ? -1 : left.effectId > right.effectId ? 1 : 0,
      );
    return deepFreeze({
      schemaVersion: "dolly.block-store/5" as const,
      nextSequence: this.#nextSequence.toString(10),
      records,
      commitEffects,
      retirementTickets,
    });
  }

  validateSource(sourceInput: SourceIdentity): SourceIdentity {
    return deepFreeze(normalizeSource(sourceInput));
  }

  validateInput(
    proposalInput: BlockProposal,
    sourceInput: SourceIdentity,
  ): ValidatedBlockInput {
    const input = this.normalizeInput(proposalInput, sourceInput);
    this.#validateDependencies(input.proposal, input.source);
    return input;
  }

  normalizeInput(
    proposalInput: BlockProposal,
    sourceInput: SourceIdentity,
  ): ValidatedBlockInput {
    const source = this.validateSource(sourceInput);
    const proposal = normalizeProposal(proposalInput, this.#limits);
    this.#assertContentSchemasAuthorized(proposal, source);
    return deepFreeze({ proposal, source });
  }

  /**
   * Refuses a proposal carrying a registered or reserved content-item schema
   * its source does not own, and applies the pinned value validator and byte
   * bound when a complete registration set is present.
   *
   * This runs in `normalizeInput`, which is the single gate every Block
   * creation passes through: `commit` and `commitOnce` both call it before
   * `#commitValidated` allocates an identifier, and
   * `ModuleResultCommitCoordinator` calls it while preparing a Module result,
   * before any commit record exists. Refusing here means a forged boundary is
   * never created and then withdrawn — it never exists at all.
   */
  #assertContentSchemasAuthorized(proposal: BlockProposal, source: SourceIdentity): void {
    if (proposal.payload.schema !== "dolly.content/1") return;
    // `normalizeProposal` has already parsed and rejected malformed content, so
    // this parse cannot introduce a new failure mode.
    const content = parseBlockContent(proposal.payload.value, this.#limits.maxContentItems);
    if (this.#contentSchemas !== undefined) {
      try {
        this.#contentSchemas.validate(content.items, source);
      } catch (error) {
        if (error instanceof ContentSchemaRegistrationError) {
          if (
            error.code !== "BLOCK_RESERVED_SCHEMA_FORBIDDEN" &&
            error.code !== "SCHEMA_VALUE_INVALID" &&
            error.code !== "SCHEMA_VALUE_LIMIT_EXCEEDED"
          ) {
            throw new BlockStoreError(
              "BLOCK_CONTENT_INVALID",
              "Content schema registration set failed during commit",
            );
          }
          throw new BlockStoreError(error.code, error.message, error.details);
        }
        throw error;
      }
      return;
    }
    const violation = findReservedSchemaViolation(
      content.items,
      source,
      this.#reservedContentSchemas,
    );
    if (violation === null) return;
    throw new BlockStoreError(
      "BLOCK_RESERVED_SCHEMA_FORBIDDEN",
      `content.items[${violation.itemIndex}] uses reserved schema ${violation.schema}, which only its authorized producer may emit`,
      {
        schema: violation.schema,
        itemIndex: violation.itemIndex,
        sourceKind: source.kind,
        sourceId: source.id,
      },
    );
  }

  commit(proposalInput: BlockProposal, sourceInput: SourceIdentity): Block {
    const input = this.normalizeInput(proposalInput, sourceInput);
    const record = this.#commitValidated(input);
    this.#persistMutation();
    return record;
  }
  commitOnce(
    effectId: string,
    proposalInput: BlockProposal,
    sourceInput: SourceIdentity,
  ): Block {
    if (!ID_PATTERN.test(effectId)) {
      throw new BlockStoreError("BLOCK_ID_INVALID", "effectId is not a valid identifier");
    }
    const input = this.normalizeInput(proposalInput, sourceInput);
    const digest = canonicalJsonDigest(input);
    const existing = this.#commitEffects.get(effectId);
    if (existing) {
      if (existing.digest !== digest) {
        throw new BlockStoreError(
          "BLOCK_EFFECT_CONFLICT",
          `Block effect ${effectId} was already committed with another input`,
          { effectId },
        );
      }
      this.flushPersistence();
      return existing.record;
    }
    const ticket = this.#retirementTickets.get(effectId);
    if (ticket !== undefined) {
      // A durable retirement ticket means the Module-result protocol already
      // moved this effect past the commit phase. Never mint a replacement
      // Block: either the effect tombstone still exists and its digest must
      // match (handled above), or retirement is in flight and this identity
      // is finished forever.
      throw new BlockStoreError(
        "BLOCK_EFFECT_CONFLICT",
        `Block effect ${effectId} is being retired and cannot be re-committed`,
        { effectId },
      );
    }

    const record = this.#commitValidated(input);
    const strongReference = {
      ownerKind: "commit",
      ownerId: effectId,
      targetKind: "block" as const,
      targetId: record.id,
    };
    this.referenceGraph.addStrongReference(strongReference);
    this.#commitEffects.set(effectId, {
      digest,
      record,
      strongReferenceHeld: true,
    });
    this.#persistMutation();
    return record;
  }

  releaseCommitEffect(effectId: string): "released" | "absent" {
    if (!ID_PATTERN.test(effectId)) {
      throw new BlockStoreError("BLOCK_ID_INVALID", "effectId is not a valid identifier");
    }
    const effect = this.#commitEffects.get(effectId);
    if (!effect) return "absent";
    if (!effect.strongReferenceHeld) {
      this.flushPersistence();
      return "absent";
    }
    const result = this.referenceGraph.removeStrongReference({
      ownerKind: "commit",
      ownerId: effectId,
      targetKind: "block",
      targetId: effect.record.id,
    });
    effect.strongReferenceHeld = false;
    this.#persistMutation();
    return result === "removed" ? "released" : "absent";
  }

  /**
   * Writes the durable retirement ticket for one Module-result effect Id
   * before any effect removal or journal delete. The ticket must bind the
   * exact moduleJobId, Block, and input digest to the existing effect; only
   * the coordinator, which derives these values from its durable journal and
   * Claim, can stage an authentic ticket. The mutation is persisted by the
   * Core mutation observer, so a crash at any later point leaves the ticket
   * in place for recovery.
   */
  stageCommitEffectRetirement(
    effectId: string,
    ticket: BlockCommitEffectRetirementTicket,
  ): void {
    if (!ID_PATTERN.test(effectId)) {
      throw new BlockStoreError("BLOCK_ID_INVALID", "effectId is not a valid identifier");
    }
    const normalized = normalizeRetirementTicket(ticket, effectId);
    this.flushPersistence();
    const effect = this.#commitEffects.get(effectId);
    if (effect === undefined) {
      throw new BlockStoreError(
        "BLOCK_EFFECT_CONFLICT",
        `Block effect ${effectId} is not committed and cannot be retired`,
        { effectId },
      );
    }
    if (effect.strongReferenceHeld) {
      throw new BlockStoreError(
        "BLOCK_EFFECT_CONFLICT",
        `Block effect ${effectId} still holds its strong reference`,
        { effectId },
      );
    }
    if (normalized.blockId !== effect.record.id) {
      throw new BlockStoreError(
        "BLOCK_EFFECT_CONFLICT",
        `Block effect ${effectId} does not match its retirement ticket Block`,
        { effectId },
      );
    }
    const input = {
      proposal: {
        ...(effect.record.summary === undefined ? {} : { summary: effect.record.summary }),
        payload: effect.record.payload,
      },
      source: effect.record.source,
    };
    if (canonicalJsonDigest(input) !== normalized.digest) {
      throw new BlockStoreError(
        "BLOCK_EFFECT_CONFLICT",
        `Block effect ${effectId} does not match its retirement ticket digest`,
        { effectId },
      );
    }
    this.#retirementTickets.set(effectId, normalized);
    this.#persistMutation();
  }

  /**
   * Removes the retired effect tombstone after a durable ticket was staged.
   * The ticket is intentionally retained so a crash before the journal delete
   * leaves an authentic, recoverable marker rather than an unexplained
   * missing effect. Absence is treated as already retired only while the
   * matching ticket is present; without a ticket this is always a conflict,
   * because a foreign/legacy effect is never eligible for retirement.
   */
  retireCommitEffect(effectId: string): "retired" | "absent" {
    if (!ID_PATTERN.test(effectId)) {
      throw new BlockStoreError("BLOCK_ID_INVALID", "effectId is not a valid identifier");
    }
    this.flushPersistence();
    const ticket = this.#retirementTickets.get(effectId);
    if (ticket === undefined) {
      throw new BlockStoreError(
        "BLOCK_EFFECT_CONFLICT",
        `Block effect ${effectId} is not eligible for retirement without a durable ticket`,
        { effectId },
      );
    }
    const effect = this.#commitEffects.get(effectId);
    if (effect === undefined) return "absent";
    if (effect.strongReferenceHeld) {
      throw new BlockStoreError(
        "BLOCK_EFFECT_CONFLICT",
        `Block effect ${effectId} still holds its strong reference`,
        { effectId },
      );
    }
    if (ticket.blockId !== effect.record.id) {
      throw new BlockStoreError(
        "BLOCK_EFFECT_CONFLICT",
        `Block effect ${effectId} does not match its retirement ticket Block`,
        { effectId },
      );
    }
    this.#commitEffects.delete(effectId);
    this.#persistMutation();
    return "retired";
  }

  /**
   * Removes the durable retirement ticket after the separate result-journal
   * delete has succeeded. The ticket is the only residue that may be dropped
   * at this point: recovery re-enters retirement while it is present.
   */
  clearCommitEffectRetirementTicket(effectId: string): "cleared" | "absent" {
    if (!ID_PATTERN.test(effectId)) {
      throw new BlockStoreError("BLOCK_ID_INVALID", "effectId is not a valid identifier");
    }
    this.flushPersistence();
    if (!this.#retirementTickets.delete(effectId)) return "absent";
    this.#persistMutation();
    return "cleared";
  }

  #commitValidated(input: ValidatedBlockInput): Block {
    const { proposal, source } = input;
    let id: string;
    try {
      id = this.#nextBlockId();
    } catch {
      throw new BlockStoreError("BLOCK_ID_INVALID", "Runtime Block ID allocator failed");
    }

    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      throw new BlockStoreError("BLOCK_ID_INVALID", "Runtime generated an invalid Block ID");
    }
    if (this.#records.has(id)) {
      throw new BlockStoreError(
        "BLOCK_ID_CONFLICT",
        `Block ID ${id} is already committed`,
        { id },
      );
    }

    this.#validateDependencies(proposal, source, id);

    const timestamp = Date.parse(this.#now());
    if (!Number.isFinite(timestamp)) {
      throw new BlockStoreError("BLOCK_PROPOSAL_INVALID", "Runtime clock returned an invalid time");
    }

    const record: Block = {
      schemaVersion: "dolly.block/2",
      id,
      sequence: this.#nextSequence.toString(10),
      source,
      createdAt: new Date(timestamp).toISOString(),
      ...(proposal.summary === undefined ? {} : { summary: proposal.summary }),
      payload: proposal.payload,
    };

    const immutable = deepFreeze(record) as Block;
    const references = referencesForProposal(proposal);
    const dependencies: ResourceTarget[] = [
      ...references.blocks.map((reference) => ({ kind: "block" as const, id: reference.blockId })),
      ...references.media.map((reference) => ({ kind: "media" as const, id: reference.mediaId })),
    ];
    this.referenceGraph.registerNode({ kind: "block", id }, dependencies);
    this.#records.set(id, immutable);
    this.#nextSequence += 1n;
    return immutable;
  }

  #validateDependencies(
    proposal: BlockProposal,
    source: SourceIdentity,
    allocatedId?: string,
  ): void {
    const references = referencesForProposal(proposal);
    for (const reference of references.blocks) {
      if (reference.blockId === allocatedId) {
        throw new BlockStoreError("BLOCK_REFERENCE_SELF", "A Block cannot reference itself", {
          blockId: reference.blockId,
        });
      }
      const target = this.#records.get(reference.blockId);
      if (!target) {
        throw new BlockStoreError(
          "BLOCK_REFERENCE_MISSING",
          `Block reference target ${reference.blockId} is not committed`,
          { blockId: reference.blockId },
        );
      }
      if (BigInt(target.sequence) >= this.#nextSequence) {
        throw new BlockStoreError(
          "BLOCK_REFERENCE_ORDER",
          `Block reference target ${reference.blockId} is not earlier than the new Block`,
          { blockId: reference.blockId },
        );
      }
    }

    if (references.media.length > 0 && !this.#media) {
      throw new BlockStoreError(
        "BLOCK_MEDIA_RESOLVER_UNAVAILABLE",
        "Media references require a trusted media resolver",
      );
    }
    for (const reference of references.media) {
      const resolved = this.#media!.resolve(reference, source);
      if (!resolved || resolved.mediaId !== reference.mediaId) {
        throw new BlockStoreError(
          resolved ? "BLOCK_MEDIA_MISMATCH" : "BLOCK_MEDIA_REFERENCE_INVALID",
          resolved
            ? `Media resolver returned a different ID for ${reference.mediaId}`
            : `Media ${reference.mediaId} is missing or cannot use the requested crop`,
          { mediaId: reference.mediaId },
        );
      }
    }
  }

  collectUnreachable(): readonly Block[] {
    const targets = this.referenceGraph
      .unreachable("block")
      .filter((target) => this.#records.has(target.id));
    const records = targets
      .map((target) => this.#records.get(target.id)!)
      .sort((left, right) => (BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1));
    this.referenceGraph.unregisterUnreachable(targets);
    for (const record of records) this.#records.delete(record.id);
    if (records.length > 0) this.#persistMutation();
    else this.flushPersistence();
    return records;
  }

  #restore(snapshot: BlockStoreSnapshot): void {
    try {
      if (
        snapshot === null ||
        typeof snapshot !== "object" ||
        (snapshot.schemaVersion !== "dolly.block-store/3" &&
          snapshot.schemaVersion !== "dolly.block-store/5") ||
        !/^[1-9][0-9]*$/.test(snapshot.nextSequence) ||
        !Array.isArray(snapshot.records) ||
        !Array.isArray(snapshot.commitEffects) ||
        (snapshot.schemaVersion === "dolly.block-store/5" &&
          !Array.isArray(snapshot.retirementTickets))
      ) {
        throw new BlockStoreError("BLOCK_SNAPSHOT_INVALID", "BlockStore snapshot schema is invalid");
      }
      const shouldRestoreTickets =
        snapshot.schemaVersion === "dolly.block-store/5" &&
        Array.isArray(snapshot.retirementTickets);
      const nextSequence = BigInt(snapshot.nextSequence);
      const recordIds = new Set<string>();
      const recordSequences = new Set<string>();
      let previousSequence = 0n;
      for (const candidate of snapshot.records) {
        const record = this.#normalizeSnapshotRecord(candidate);
        const sequence = BigInt(record.sequence);
        if (
          recordIds.has(record.id) ||
          recordSequences.has(record.sequence) ||
          sequence <= previousSequence ||
          sequence >= nextSequence
        ) {
          throw new BlockStoreError(
            "BLOCK_SNAPSHOT_INVALID",
            "BlockStore live record identities or sequences are invalid",
          );
        }
        recordIds.add(record.id);
        recordSequences.add(record.sequence);
        previousSequence = sequence;
        this.#records.set(record.id, record);
      }
      this.#nextSequence = nextSequence;

      for (const record of this.#records.values()) {
        const recordSequence = BigInt(record.sequence);
        const references = referencesForProposal({ payload: record.payload });
        for (const reference of references.blocks) {
          const target = this.#records.get(reference.blockId);
          if (!target || BigInt(target.sequence) >= recordSequence) {
            throw new BlockStoreError(
              "BLOCK_SNAPSHOT_INVALID",
              `Block ${record.id} has a missing or non-earlier reference`,
            );
          }
        }
        this.#validateDependencies(
          {
            ...(record.summary === undefined ? {} : { summary: record.summary }),
            payload: record.payload,
          },
          record.source,
        );
        const target = { kind: "block" as const, id: record.id };
        if (!this.referenceGraph.hasNode(target)) {
          throw new BlockStoreError(
            "BLOCK_SNAPSHOT_INVALID",
            `Reference graph snapshot omits Block ${record.id}`,
          );
        }
        this.referenceGraph.registerNode(target, [
          ...references.blocks.map((reference) => ({
            kind: "block" as const,
            id: reference.blockId,
          })),
          ...references.media.map((reference) => ({
            kind: "media" as const,
            id: reference.mediaId,
          })),
        ]);
      }

      const effectIds = new Set<string>();
      for (const candidate of snapshot.commitEffects) {
        const effectKeys = ["effectId", "digest", "record", "strongReferenceHeld"];
        assertClosedObject(candidate, effectKeys, "commitEffect");
        if (
          typeof candidate.effectId !== "string" ||
          !ID_PATTERN.test(candidate.effectId) ||
          effectIds.has(candidate.effectId) ||
          typeof candidate.digest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(candidate.digest) ||
          typeof candidate.strongReferenceHeld !== "boolean"
        ) {
          throw new BlockStoreError(
            "BLOCK_SNAPSHOT_INVALID",
            "BlockStore commit effect identity is invalid",
          );
        }
        const record = this.#normalizeSnapshotRecord(candidate.record as Block);
        const input = {
          proposal: {
            ...(record.summary === undefined ? {} : { summary: record.summary }),
            payload: record.payload,
          },
          source: record.source,
        };
        if (canonicalJsonDigest(input) !== candidate.digest) {
          throw new BlockStoreError(
            "BLOCK_SNAPSHOT_INVALID",
            "BlockStore commit effect digest does not match its record",
          );
        }
        const live = this.#records.get(record.id);
        if (
          live &&
          canonicalJsonDigest(live) !== canonicalJsonDigest(record)
        ) {
          throw new BlockStoreError(
            "BLOCK_SNAPSHOT_INVALID",
            "BlockStore commit effect conflicts with its live Block",
          );
        }
        const strongReference = {
          ownerKind: "commit",
          ownerId: candidate.effectId,
          targetKind: "block" as const,
          targetId: record.id,
        };
        if (candidate.strongReferenceHeld) {
          if (!live) {
            throw new BlockStoreError(
              "BLOCK_SNAPSHOT_INVALID",
              "A Block effect holding a strong reference must reference a live Block",
            );
          }
          if (!this.referenceGraph.hasStrongReference(strongReference)) {
            throw new BlockStoreError(
              "BLOCK_SNAPSHOT_INVALID",
              "A Block effect is missing its strong reference",
            );
          }
        } else if (this.referenceGraph.hasStrongReference(strongReference)) {
          throw new BlockStoreError(
            "BLOCK_SNAPSHOT_INVALID",
            "A released Block effect still owns a strong reference",
          );
        }
        effectIds.add(candidate.effectId);
        this.#commitEffects.set(candidate.effectId, {
          digest: candidate.digest,
          record,
          strongReferenceHeld: candidate.strongReferenceHeld,
        });
      }

      const ticketIds = new Set<string>();
      for (const candidate of snapshot.retirementTickets ?? []) {
        const keys = ["effectId", "schemaVersion", "moduleJobId", "blockId", "digest", "deliveryEffectIds"];
        assertClosedObject(candidate, keys, "retirementTicket");
        const { effectId: candidateEffectId, ...ticketFields } = candidate;
        const ticket = normalizeRetirementTicket(ticketFields, candidateEffectId as string);
        if (
          typeof candidate.effectId !== "string" ||
          !ID_PATTERN.test(candidate.effectId) ||
          ticketIds.has(candidate.effectId)
        ) {
          throw new BlockStoreError(
            "BLOCK_SNAPSHOT_INVALID",
            "BlockStore retirement ticket identity is invalid",
          );
        }
        ticketIds.add(candidate.effectId);
        this.#retirementTickets.set(candidate.effectId as string, ticket);
      }

      const referenceGraph = this.referenceGraph.snapshot();
      const actualBlockIds = new Set(
        referenceGraph.nodes
          .filter((node) => node.target.kind === "block")
          .map((node) => node.target.id),
      );
      const expectedBlockIds = new Set(this.#records.keys());
      const effectReferenceKey = (ownerId: string, targetId: string) =>
        JSON.stringify(["commit", ownerId, "block", targetId]);
      const actualEffectReferences = new Set(
        referenceGraph.strongReferences
          .filter((reference) => reference.ownerKind === "commit")
          .map((reference) => effectReferenceKey(reference.ownerId, reference.targetId)),
      );
      const expectedEffectReferences = new Set(
        [...this.#commitEffects.entries()]
          .filter(([, effect]) => effect.strongReferenceHeld)
          .map(([effectId, effect]) => effectReferenceKey(effectId, effect.record.id)),
      );
      if (
        actualBlockIds.size !== expectedBlockIds.size ||
        [...actualBlockIds].some((id) => !expectedBlockIds.has(id)) ||
        actualEffectReferences.size !== expectedEffectReferences.size ||
        [...actualEffectReferences].some((key) => !expectedEffectReferences.has(key))
      ) {
        throw new BlockStoreError(
          "BLOCK_SNAPSHOT_INVALID",
          "BlockStore snapshot and reference graph contain different Block state",
        );
      }
    } catch (error) {
      if (error instanceof BlockStoreError && error.code === "BLOCK_SNAPSHOT_INVALID") {
        throw error;
      }
      throw new BlockStoreError("BLOCK_SNAPSHOT_INVALID", "BlockStore snapshot is invalid");
    }
  }

  #normalizeSnapshotRecord(candidate: Block): Block {
    assertClosedObject(
      candidate,
      [
        "schemaVersion",
        "id",
        "sequence",
        "source",
        "createdAt",
        "summary",
        "payload",
      ],
      "Block",
    );
    if (
      candidate.schemaVersion !== "dolly.block/2" ||
      typeof candidate.id !== "string" ||
      !ID_PATTERN.test(candidate.id) ||
      typeof candidate.sequence !== "string" ||
      !/^[1-9][0-9]*$/.test(candidate.sequence) ||
      typeof candidate.createdAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.createdAt)) ||
      new Date(Date.parse(candidate.createdAt)).toISOString() !== candidate.createdAt
    ) {
      throw new BlockStoreError("BLOCK_SNAPSHOT_INVALID", "Block envelope is invalid");
    }
    const source = normalizeSource(candidate.source);
    const proposal = normalizeProposal(
      {
        ...(candidate.summary === undefined ? {} : { summary: candidate.summary }),
        payload: candidate.payload,
      },
      this.#limits,
    );
    return deepFreeze({
      schemaVersion: "dolly.block/2" as const,
      id: candidate.id,
      sequence: candidate.sequence,
      source,
      createdAt: candidate.createdAt,
      ...(proposal.summary === undefined ? {} : { summary: proposal.summary }),
      payload: proposal.payload,
    });
  }

  #persistMutation(): void {
    if (!this.#onMutation) return;
    this.#persistenceDirty = true;
    this.#notifyMutationObserver();
  }

  #notifyMutationObserver(): void {
    if (!this.#onMutation) return;
    if (this.#notifyingMutation) {
      throw new BlockStoreError(
        "BLOCK_PERSISTENCE_FAILED",
        "BlockStore mutation observer re-entered the store",
      );
    }
    this.#notifyingMutation = true;
    try {
      const result = (this.#onMutation as () => unknown)();
      if (result !== undefined) {
        throw new TypeError("BlockStore mutation observers must complete synchronously");
      }
      this.#persistenceDirty = false;
    } catch {
      throw new BlockStoreError(
        "BLOCK_PERSISTENCE_FAILED",
        "BlockStore state could not be persisted",
      );
    } finally {
      this.#notifyingMutation = false;
    }
  }
}
