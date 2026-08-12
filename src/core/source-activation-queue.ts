import {
  canonicalJsonByteLength,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  BlockStoreError,
  type Block,
  type BlockProposal,
  type SourceIdentity,
} from "./block-store.js";
import type {
  DeliveryAppendEffectSnapshot,
  DeliveryRecord,
  DeliveryStoreSnapshot,
} from "./delivery-store.js";
import type {
  FileCoreDeliveryOperations,
  FileCoreStateStore,
} from "./file-core-state-store.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_ACTIVATION_SCHEMA = "dolly.source-activation/1";
const SOURCE_IDENTITY: SourceIdentity = deepFreeze({
  kind: "system",
  id: "source-activation",
});

export type SourceActivationQueueErrorCode =
  | "SOURCE_ACTIVATION_CONFIGURATION_INVALID"
  | "SOURCE_ACTIVATION_ROUTE_INVALID"
  | "SOURCE_ACTIVATION_REQUEST_INVALID"
  | "SOURCE_ACTIVATION_REQUEST_TOO_LARGE"
  | "SOURCE_ACTIVATION_CONFLICT"
  | "SOURCE_ACTIVATION_ADMISSION_CLOSED"
  | "SOURCE_ACTIVATION_STATE_INVALID";

export class SourceActivationQueueError extends Error {
  constructor(readonly code: SourceActivationQueueErrorCode, message: string) {
    super(message);
    this.name = "SourceActivationQueueError";
  }
}

export interface SourceActivationRequest {
  readonly idempotencyKey: string;
  readonly body: JsonValue;
}

export interface SourceActivationQueueOptions {
  readonly core: FileCoreStateStore;
  readonly moduleId: string;
  /** Maximum pending plus claimed requests for this Module. */
  readonly maxResidentCount: number;
  /** Maximum canonical request bytes across pending plus claimed requests. */
  readonly maxResidentBytes: number;
  /** Maximum canonical bytes for one complete request envelope. */
  readonly maxRequestBytes: number;
}

export interface SourceActivationQueueStatus {
  readonly moduleId: string;
  readonly privatePageId: string;
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly claimedCount: number;
  readonly claimedBytes: number;
  readonly residentCount: number;
  readonly residentBytes: number;
  readonly maxResidentCount: number;
  readonly maxResidentBytes: number;
}

/**
 * An in-memory proof that one private source Page came from the queue bound to
 * the Scheduler's exact FileCore Delivery view. Copying these public fields
 * does not copy the proof held in this module's WeakMap.
 */
export interface SourceActivationSchedulerBinding {
  readonly schemaVersion: "dolly.source-activation-binding/1";
  readonly moduleId: string;
  readonly privatePageId: string;
}

interface SourceActivationSchedulerAuthority {
  readonly moduleId: string;
  readonly privatePageId: string;
  readonly deliveries: FileCoreDeliveryOperations;
}

const schedulerBindings = new WeakMap<
  SourceActivationSchedulerBinding,
  SourceActivationSchedulerAuthority
>();

/** @internal Scheduler registration verifies the non-serializable binding here. */
export function resolveSourceActivationSchedulerBinding(
  candidate: unknown,
  moduleId: string,
  deliveries: unknown,
): Pick<SourceActivationSchedulerBinding, "moduleId" | "privatePageId"> {
  if (candidate === null || typeof candidate !== "object") {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_ROUTE_INVALID",
      "A source activation Scheduler binding is required",
    );
  }
  const authority = schedulerBindings.get(
    candidate as SourceActivationSchedulerBinding,
  );
  if (
    authority === undefined ||
    authority.moduleId !== moduleId ||
    authority.deliveries !== deliveries
  ) {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_ROUTE_INVALID",
      "The source activation binding does not belong to this Module and FileCore store",
    );
  }
  return deepFreeze({
    moduleId: authority.moduleId,
    privatePageId: authority.privatePageId,
  });
}

export type SourceActivationSubmission =
  | {
      readonly status: "enqueued" | "duplicate";
      readonly blockId: string;
      readonly deliveryId: string;
      readonly privatePageId: string;
    }
  | {
      readonly status: "backpressured";
      readonly residentCount: number;
      readonly residentBytes: number;
      readonly maxResidentCount: number;
      readonly maxResidentBytes: number;
    };

interface SourceActivationEnvelope {
  readonly schemaVersion: typeof SOURCE_ACTIVATION_SCHEMA;
  readonly moduleId: string;
  readonly idempotencyKey: string;
  readonly body: JsonValue;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_CONFIGURATION_INVALID",
      `${label} must be a positive safe integer`,
    );
  }
}

function assertPlainClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_STATE_INVALID",
      `${label} must be an object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_STATE_INVALID",
      `${label} must be a plain object`,
    );
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_STATE_INVALID",
      `${label} contains unknown fields`,
    );
  }
}

function effectDigest(moduleId: string, idempotencyKey: string): string {
  return canonicalJsonDigest({
    schemaVersion: SOURCE_ACTIVATION_SCHEMA,
    moduleId,
    idempotencyKey,
  }).slice("sha256:".length);
}

function privatePageId(moduleId: string): string {
  const digest = canonicalJsonDigest({
    schemaVersion: "dolly.source-activation-page/1",
    moduleId,
  }).slice("sha256:".length);
  return `core.source-activation.${digest}`;
}

function normalizeRequest(
  moduleId: string,
  input: SourceActivationRequest,
  maxRequestBytes: number,
): { readonly envelope: SourceActivationEnvelope; readonly requestBytes: number } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_REQUEST_INVALID",
      "A source activation request must be an object",
    );
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "body" || keys[1] !== "idempotencyKey") {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_REQUEST_INVALID",
      "A source activation request must contain only body and idempotencyKey",
    );
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length === 0
  ) {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_REQUEST_INVALID",
      "A source activation idempotency key must be a non-empty string",
    );
  }
  let body: JsonValue;
  try {
    body = cloneJson(input.body);
  } catch {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_REQUEST_INVALID",
      "A source activation body must be canonical JSON data",
    );
  }
  const envelope: SourceActivationEnvelope = deepFreeze({
    schemaVersion: SOURCE_ACTIVATION_SCHEMA as typeof SOURCE_ACTIVATION_SCHEMA,
    moduleId,
    idempotencyKey: input.idempotencyKey,
    body,
  });
  const requestBytes = canonicalJsonByteLength(envelope);
  if (requestBytes > maxRequestBytes) {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_REQUEST_TOO_LARGE",
      "The source activation request exceeds its configured byte limit",
    );
  }
  return { envelope, requestBytes };
}

function parseEnvelope(block: Block, moduleId: string): SourceActivationEnvelope {
  if (block.source.kind !== "system" || block.source.id !== SOURCE_IDENTITY.id) {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_STATE_INVALID",
      "A private source activation Page contains a Block from another producer",
    );
  }
  if (block.payload.schema !== SOURCE_ACTIVATION_SCHEMA) {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_STATE_INVALID",
      "A private source activation Page contains another payload schema",
    );
  }
  assertPlainClosedObject(
    block.payload.value,
    ["schemaVersion", "moduleId", "idempotencyKey", "body"],
    "source activation envelope",
  );
  if (
    block.payload.value.schemaVersion !== SOURCE_ACTIVATION_SCHEMA ||
    block.payload.value.moduleId !== moduleId ||
    typeof block.payload.value.idempotencyKey !== "string" ||
    block.payload.value.idempotencyKey.length === 0
  ) {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_STATE_INVALID",
      "A private source activation Page contains an invalid request identity",
    );
  }
  try {
    cloneJson(block.payload.value.body as JsonValue);
  } catch {
    throw new SourceActivationQueueError(
      "SOURCE_ACTIVATION_STATE_INVALID",
      "A private source activation Page contains a non-JSON request body",
    );
  }
  return block.payload.value as unknown as SourceActivationEnvelope;
}

/**
 * A durable, Core-private queue for Modules that have no public input Pages.
 *
 * The queue reuses the existing Block, Delivery, Claim, retry and result-commit
 * boundary. The private Page is an implementation detail and is never a route
 * supplied by an Extension or instance configuration. This class only creates
 * and admits requests. The candidate installed composition can bind it to the
 * same Runtime and Scheduler; product bootstrap remains disabled.
 */
export class SourceActivationQueue {
  readonly #core: FileCoreStateStore;
  readonly #moduleId: string;
  readonly #maxResidentCount: number;
  readonly #maxResidentBytes: number;
  readonly #maxRequestBytes: number;
  readonly privatePageId: string;

  constructor(options: SourceActivationQueueOptions) {
    if (!ID_PATTERN.test(options.moduleId)) {
      throw new SourceActivationQueueError(
        "SOURCE_ACTIVATION_CONFIGURATION_INVALID",
        "moduleId is not a valid identifier",
      );
    }
    if (
      options.core === null ||
      typeof options.core !== "object" ||
      typeof options.core.runAtomicUpdate !== "function"
    ) {
      throw new SourceActivationQueueError(
        "SOURCE_ACTIVATION_CONFIGURATION_INVALID",
        "core must be an owning FileCore state store",
      );
    }
    assertPositiveSafeInteger(options.maxResidentCount, "maxResidentCount");
    assertPositiveSafeInteger(options.maxResidentBytes, "maxResidentBytes");
    assertPositiveSafeInteger(options.maxRequestBytes, "maxRequestBytes");
    if (options.maxRequestBytes > options.maxResidentBytes) {
      throw new SourceActivationQueueError(
        "SOURCE_ACTIVATION_CONFIGURATION_INVALID",
        "maxRequestBytes cannot exceed maxResidentBytes",
      );
    }
    this.#core = options.core;
    this.#moduleId = options.moduleId;
    this.#maxResidentCount = options.maxResidentCount;
    this.#maxResidentBytes = options.maxResidentBytes;
    this.#maxRequestBytes = options.maxRequestBytes;
    this.privatePageId = privatePageId(options.moduleId);
  }

  get moduleId(): string {
    return this.#moduleId;
  }

  get limits(): Readonly<{
    maxResidentCount: number;
    maxResidentBytes: number;
    maxRequestBytes: number;
  }> {
    return Object.freeze({
      maxResidentCount: this.#maxResidentCount,
      maxResidentBytes: this.#maxResidentBytes,
      maxRequestBytes: this.#maxRequestBytes,
    });
  }

  reconcile(): void {
    const pages = this.#core.deliveries.listPageIds();
    if (!pages.includes(this.privatePageId)) {
      this.#core.runAtomicUpdate(() => {
        this.#core.deliveries.createPage(this.privatePageId);
        this.#core.deliveries.registerConsumer(
          this.privatePageId,
          this.#moduleId,
          "from-head",
        );
      });
    }
    this.#assertPrivateRoute();
  }

  schedulerBinding(): SourceActivationSchedulerBinding {
    // Validate route ownership and every retained private-page record before
    // granting Scheduler access to the route identity.
    this.inspect();
    const binding: SourceActivationSchedulerBinding = deepFreeze({
      schemaVersion: "dolly.source-activation-binding/1" as const,
      moduleId: this.#moduleId,
      privatePageId: this.privatePageId,
    });
    schedulerBindings.set(binding, {
      moduleId: this.#moduleId,
      privatePageId: this.privatePageId,
      deliveries: this.#core.deliveries,
    });
    return binding;
  }

  inspect(): SourceActivationQueueStatus {
    this.#assertPrivateRoute();
    const core = this.#core.snapshot();
    const blocks = new Map(core.blocks.records.map((block) => [block.id, block]));
    let pendingCount = 0;
    let pendingBytes = 0;
    let claimedCount = 0;
    let claimedBytes = 0;
    for (const delivery of core.deliveries.deliveries) {
      if (delivery.record.pageId !== this.privatePageId) continue;
      const block = blocks.get(delivery.record.blockId);
      if (block === undefined) {
        throw new SourceActivationQueueError(
          "SOURCE_ACTIVATION_STATE_INVALID",
          "A private source activation Delivery references a missing Block",
        );
      }
      const envelope = parseEnvelope(block, this.#moduleId);
      const status = delivery.obligations.find(
        (obligation) => obligation.consumerId === this.#moduleId,
      )?.status;
      const bytes = canonicalJsonByteLength(envelope);
      if (status === "pending") {
        pendingCount += 1;
        pendingBytes += bytes;
      } else if (status === "claimed") {
        claimedCount += 1;
        claimedBytes += bytes;
      }
      if (
        !Number.isSafeInteger(pendingBytes) ||
        !Number.isSafeInteger(claimedBytes)
      ) {
        throw new SourceActivationQueueError(
          "SOURCE_ACTIVATION_STATE_INVALID",
          "Source activation resident bytes exceed the safe integer range",
        );
      }
    }
    const residentCount = pendingCount + claimedCount;
    const residentBytes = pendingBytes + claimedBytes;
    if (
      !Number.isSafeInteger(residentCount) ||
      !Number.isSafeInteger(residentBytes)
    ) {
      throw new SourceActivationQueueError(
        "SOURCE_ACTIVATION_STATE_INVALID",
        "Source activation resident size exceeds the safe integer range",
      );
    }
    return deepFreeze({
      moduleId: this.#moduleId,
      privatePageId: this.privatePageId,
      pendingCount,
      pendingBytes,
      claimedCount,
      claimedBytes,
      residentCount,
      residentBytes,
      maxResidentCount: this.#maxResidentCount,
      maxResidentBytes: this.#maxResidentBytes,
    });
  }

  submit(input: SourceActivationRequest): SourceActivationSubmission {
    this.#assertPrivateRoute();
    const { envelope, requestBytes } = normalizeRequest(
      this.#moduleId,
      input,
      this.#maxRequestBytes,
    );
    const digest = effectDigest(this.#moduleId, envelope.idempotencyKey);
    const blockEffectId = `source-activation.block.${digest}`;
    const deliveryEffectId = `source-activation.delivery.${digest}`;
    const existingBlock = this.#core.blocks.inspectCommitEffect(blockEffectId);
    const existingDelivery = this.#core.deliveries.inspectAppendEffect(deliveryEffectId);
    const proposal: BlockProposal = {
      payload: {
        schema: SOURCE_ACTIVATION_SCHEMA,
        value: envelope as unknown as JsonValue,
      },
    };

    if (existingBlock !== null || existingDelivery !== null) {
      return this.#resolveDuplicate(
        blockEffectId,
        deliveryEffectId,
        proposal,
        existingDelivery,
      );
    }

    const status = this.inspect();
    if (
      status.residentCount + 1 > this.#maxResidentCount ||
      status.residentBytes + requestBytes > this.#maxResidentBytes
    ) {
      return deepFreeze({
        status: "backpressured" as const,
        residentCount: status.residentCount,
        residentBytes: status.residentBytes,
        maxResidentCount: this.#maxResidentCount,
        maxResidentBytes: this.#maxResidentBytes,
      });
    }

    let block: Block | undefined;
    let delivery: DeliveryRecord | undefined;
    this.#core.runAtomicUpdate(() => {
      block = this.#core.blocks.commitOnce(blockEffectId, proposal, SOURCE_IDENTITY);
      delivery = this.#core.deliveries.appendOnce(
        deliveryEffectId,
        this.privatePageId,
        block.id,
      );
    });
    if (block === undefined || delivery === undefined) {
      throw new SourceActivationQueueError(
        "SOURCE_ACTIVATION_STATE_INVALID",
        "The atomic source activation update did not produce its exact records",
      );
    }
    return deepFreeze({
      status: "enqueued" as const,
      blockId: block.id,
      deliveryId: delivery.deliveryId,
      privatePageId: this.privatePageId,
    });
  }

  #resolveDuplicate(
    blockEffectId: string,
    deliveryEffectId: string,
    proposal: BlockProposal,
    existingDelivery: DeliveryAppendEffectSnapshot | null,
  ): SourceActivationSubmission {
    if (existingDelivery === null) {
      throw new SourceActivationQueueError(
        "SOURCE_ACTIVATION_STATE_INVALID",
        "A source activation Block effect exists without its atomic Delivery effect",
      );
    }
    if (existingDelivery.pageId !== this.privatePageId) {
      throw new SourceActivationQueueError(
        "SOURCE_ACTIVATION_STATE_INVALID",
        "A source activation Delivery effect targets another Page",
      );
    }
    let block: Block;
    try {
      block = this.#core.blocks.commitOnce(blockEffectId, proposal, SOURCE_IDENTITY);
    } catch (error) {
      if (error instanceof BlockStoreError && error.code === "BLOCK_EFFECT_CONFLICT") {
        throw new SourceActivationQueueError(
          "SOURCE_ACTIVATION_CONFLICT",
          "The source activation idempotency key already names different content",
        );
      }
      throw error;
    }
    if (existingDelivery.blockId !== block.id) {
      throw new SourceActivationQueueError(
        "SOURCE_ACTIVATION_STATE_INVALID",
        "A source activation Delivery effect does not reference its exact Block effect",
      );
    }
    return deepFreeze({
      status: "duplicate" as const,
      blockId: block.id,
      deliveryId: existingDelivery.record.deliveryId,
      privatePageId: this.privatePageId,
    });
  }

  #assertPrivateRoute(): void {
    const snapshot: DeliveryStoreSnapshot = this.#core.deliveries.snapshot();
    const page = snapshot.pages.find((candidate) => candidate.id === this.privatePageId);
    if (
      page === undefined ||
      page.subscriptions.length !== 1 ||
      page.subscriptions[0]?.consumerId !== this.#moduleId ||
      page.subscriptions[0]?.start !== "from-head"
    ) {
      throw new SourceActivationQueueError(
        "SOURCE_ACTIVATION_ROUTE_INVALID",
        "The private source activation Page must belong only to its exact Module",
      );
    }
  }
}
