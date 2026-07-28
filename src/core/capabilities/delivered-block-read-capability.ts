import {
  canonicalJsonByteLength,
  deepFreeze,
  isJsonObject,
  type JsonValue,
} from "../canonical-json.js";
import type { Block } from "../block-store.js";
import {
  ExtensionCapabilityError,
  type ExtensionCapabilityGrant,
  type ExtensionCapabilityInvocationContext,
} from "../extension-capability.js";
import {
  assertClosedArguments,
  assertHostIdentifier,
  assertPositiveLimit,
  capabilityArgumentError,
  capabilityQuotaError,
  optionalBoundedInteger,
  optionalString,
  readField,
  requireString,
  type ExtensionCapabilityDefinition,
} from "./capability-support.js";

export const DELIVERED_BLOCK_READ_CAPABILITY_TYPE = "delivered-block-read";
export const DELIVERED_BLOCK_READ_CAPABILITY_VERSION = "v1";

export type DeliveredBlockReadOperation = "list" | "read";

const READ_OPERATIONS: readonly DeliveredBlockReadOperation[] = ["list", "read"];

/**
 * The part of a Delivery Claim this capability is derived from. A real
 * `DeliveryClaim` satisfies this shape; the narrower type keeps the capability
 * from depending on claim disposition authority it must never hold.
 */
export interface DeliveredBlockClaim {
  readonly moduleJobId: string;
  readonly runId: string;
  readonly blockGroups: readonly {
    readonly block: Block;
    readonly deliveryIds: readonly string[];
  }[];
}

export interface DeliveredBlockReadLimits {
  /** Deepest JSON nesting a returned projection may contain. */
  readonly maxDepth: number;
  /** Most JSON nodes a returned projection may contain. */
  readonly maxNodes: number;
  /** Ceiling on one returned snapshot, measured as canonical JSON. */
  readonly maxSnapshotBytes: number;
  /** Longest pointer an argument may carry. */
  readonly maxPointerSegments: number;
  readonly maxListResults: number;
  readonly maxArgumentBytes: number;
  readonly maxInvocations: number;
}

export const DEFAULT_DELIVERED_BLOCK_READ_LIMITS: DeliveredBlockReadLimits = deepFreeze({
  maxDepth: 8,
  maxNodes: 512,
  maxSnapshotBytes: 64 * 1_024,
  maxPointerSegments: 16,
  maxListResults: 64,
  maxArgumentBytes: 4_096,
  maxInvocations: 256,
});

export interface DeliveredBlockReadCapabilityOptions {
  readonly claim: DeliveredBlockClaim;
  readonly expiresAt: string;
  readonly operations?: readonly DeliveredBlockReadOperation[];
  readonly limits?: Partial<DeliveredBlockReadLimits>;
  readonly maxConcurrentInvocations?: number;
  readonly requireIdempotencyKey?: boolean;
}

interface AuthorizedBlock {
  readonly block: Block;
  readonly deliveryIds: readonly string[];
}

function resolveReadLimits(
  overrides: Partial<DeliveredBlockReadLimits> | undefined,
): DeliveredBlockReadLimits {
  const limits = { ...DEFAULT_DELIVERED_BLOCK_READ_LIMITS, ...(overrides ?? {}) };
  for (const [label, value] of Object.entries(limits)) {
    assertPositiveLimit(value, `delivered block read ${label}`);
  }
  return deepFreeze(limits);
}

/**
 * Walks one JSON value and fails as soon as it would exceed a bound.
 *
 * Section 10 of `extension-process-protocol.md` forbids silently truncating
 * structured data into a valid-looking result, so an oversized subtree raises
 * a typed quota error and the extension must ask for a narrower pointer.
 */
function assertBounded(
  value: JsonValue,
  limits: DeliveredBlockReadLimits,
): { readonly nodes: number; readonly depth: number } {
  let nodes = 0;
  let deepest = 0;
  const walk = (node: JsonValue, depth: number): void => {
    nodes += 1;
    if (depth > deepest) deepest = depth;
    if (nodes > limits.maxNodes) throw capabilityQuotaError("maxNodes", limits.maxNodes);
    if (depth > limits.maxDepth) throw capabilityQuotaError("maxDepth", limits.maxDepth);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (isJsonObject(node)) {
      for (const key of Object.keys(node)) walk(node[key]!, depth + 1);
    }
  };
  walk(value, 1);
  return { nodes, depth: deepest };
}

function readPointer(
  argumentsValue: Readonly<Record<string, JsonValue>>,
  limits: DeliveredBlockReadLimits,
): readonly (string | number)[] {
  const pointer = readField(argumentsValue, "pointer");
  if (pointer === undefined) return [];
  if (!Array.isArray(pointer)) {
    throw capabilityArgumentError("block.read.pointer must be an array when present");
  }
  if (pointer.length > limits.maxPointerSegments) {
    throw capabilityQuotaError("maxPointerSegments", limits.maxPointerSegments);
  }
  return pointer.map((segment) => {
    if (typeof segment === "string") {
      if (segment.length === 0 || segment.length > 256) {
        throw capabilityArgumentError("block.read.pointer has an invalid object key");
      }
      return segment;
    }
    if (
      typeof segment === "number" &&
      Number.isSafeInteger(segment) &&
      segment >= 0
    ) {
      return segment;
    }
    throw capabilityArgumentError(
      "block.read.pointer segments must be object keys or array indexes",
    );
  });
}

function resolvePointer(
  value: JsonValue,
  pointer: readonly (string | number)[],
): JsonValue {
  let current = value;
  for (const segment of pointer) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        throw capabilityArgumentError("block.read.pointer does not resolve");
      }
      current = current[segment]!;
      continue;
    }
    if (!isJsonObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      throw capabilityArgumentError("block.read.pointer does not resolve");
    }
    current = current[segment]!;
  }
  return current;
}

/**
 * Builds the bounded Block snapshot read capability.
 *
 * Section 6 of `extension-process-protocol.md` states that receiving a Block
 * snapshot does not authorize every Block identifier inside it. This capability
 * therefore closes over the Blocks the host delivered directly in one Module
 * job's Delivery Claim and holds no route to any other Block: an identifier
 * that appears only as a `block-reference` inside a delivered Block resolves to
 * nothing and is denied exactly like an invented identifier.
 */
export function createDeliveredBlockReadCapability(
  options: DeliveredBlockReadCapabilityOptions,
): ExtensionCapabilityDefinition {
  const limits = resolveReadLimits(options.limits);
  const moduleJobId = assertHostIdentifier(options.claim.moduleJobId, "moduleJobId");
  const runId = assertHostIdentifier(options.claim.runId, "runId");
  const operations = [...new Set(options.operations ?? READ_OPERATIONS)];
  if (operations.length === 0) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      "Delivered Block read requires at least one operation",
    );
  }
  for (const operation of operations) {
    if (!READ_OPERATIONS.includes(operation)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_CONFIG_INVALID",
        `Delivered Block read does not define the operation ${String(operation)}`,
      );
    }
  }
  const enabled = new Set<DeliveredBlockReadOperation>(operations);

  // Only the Blocks delivered directly in this Claim enter the capability.
  const authorized = new Map<string, AuthorizedBlock>();
  for (const group of options.claim.blockGroups) {
    const block = group.block;
    assertHostIdentifier(block.id, "blockId");
    const existing = authorized.get(block.id);
    authorized.set(block.id, {
      block,
      deliveryIds: [
        ...new Set([...(existing?.deliveryIds ?? []), ...group.deliveryIds]),
      ],
    });
  }
  const deliveredBlockIds = [...authorized.keys()].sort();

  const grant: ExtensionCapabilityGrant = {
    capabilityType: DELIVERED_BLOCK_READ_CAPABILITY_TYPE,
    capabilityVersion: DELIVERED_BLOCK_READ_CAPABILITY_VERSION,
    operations,
    resourceScope: {
      schemaVersion: "dolly.capability-scope.delivered-block-read/1",
      moduleJobId,
      deliveredBlockIds,
      limits: { ...limits },
    },
    expiresAt: options.expiresAt,
    maxInvocations: limits.maxInvocations,
    maxConcurrentInvocations: options.maxConcurrentInvocations ?? 2,
    maxArgumentBytes: limits.maxArgumentBytes,
    maxResultBytes: limits.maxSnapshotBytes,
    executionScope: { moduleJobId, runId },
    ...(options.requireIdempotencyKey === true ? { requireIdempotencyKey: true } : {}),
  };

  const describe = (entry: AuthorizedBlock): JsonValue => ({
    blockId: entry.block.id,
    sequence: entry.block.sequence,
    createdAt: entry.block.createdAt,
    payloadSchema: entry.block.payload.schema,
    deliveryIds: [...entry.deliveryIds],
    ...(entry.block.summary === undefined ? {} : { summary: entry.block.summary }),
  });

  const handler = (
    argumentsValue: JsonValue,
    context: ExtensionCapabilityInvocationContext,
  ): JsonValue => {
    const operation = context.operation as DeliveredBlockReadOperation;
    if (!enabled.has(operation)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_DENIED",
        "Delivered Block read does not authorize this operation",
      );
    }

    if (operation === "list") {
      const parsed = assertClosedArguments(
        argumentsValue,
        ["limit", "after"],
        "block.list",
      );
      const after = optionalString(parsed, "after", "block.list");
      const limit =
        optionalBoundedInteger(parsed, "limit", "block.list", limits.maxListResults) ??
        limits.maxListResults;
      const matching = deliveredBlockIds.filter(
        (blockId) => after === undefined || blockId > after,
      );
      const page = matching.slice(0, limit);
      const truncated = page.length < matching.length;
      const result: JsonValue = {
        schemaVersion: "dolly.delivered-block-list/1",
        moduleJobId,
        blocks: page.map((blockId) => describe(authorized.get(blockId)!)),
        truncated,
        ...(truncated ? { nextAfter: page[page.length - 1]! } : {}),
      };
      if (canonicalJsonByteLength(result) > limits.maxSnapshotBytes) {
        throw capabilityQuotaError("maxSnapshotBytes", limits.maxSnapshotBytes);
      }
      return result;
    }

    const parsed = assertClosedArguments(
      argumentsValue,
      ["blockId", "pointer"],
      "block.read",
    );
    const blockId = requireString(parsed, "blockId", "block.read");
    const entry = authorized.get(blockId);
    if (!entry) {
      // An identifier that is merely visible inside a delivered snapshot, an
      // identifier from another Module job, and an invented identifier all
      // reach this branch and are indistinguishable in the response.
      throw new ExtensionCapabilityError(
        "CAPABILITY_DENIED",
        "Block was not delivered directly to this Module job",
      );
    }
    const pointer = readPointer(parsed, limits);
    const subtree = resolvePointer(entry.block.payload.value, pointer);
    const bounds = assertBounded(subtree, limits);
    const result: JsonValue = {
      schemaVersion: "dolly.delivered-block-snapshot/1",
      blockId: entry.block.id,
      sequence: entry.block.sequence,
      createdAt: entry.block.createdAt,
      source: { kind: entry.block.source.kind, id: entry.block.source.id },
      payloadSchema: entry.block.payload.schema,
      deliveryIds: [...entry.deliveryIds],
      pointer: [...pointer],
      value: subtree,
      nodeCount: bounds.nodes,
      depth: bounds.depth,
      ...(entry.block.summary === undefined ? {} : { summary: entry.block.summary }),
    };
    if (canonicalJsonByteLength(result) > limits.maxSnapshotBytes) {
      throw capabilityQuotaError("maxSnapshotBytes", limits.maxSnapshotBytes);
    }
    return result;
  };

  return { grant, handler };
}
