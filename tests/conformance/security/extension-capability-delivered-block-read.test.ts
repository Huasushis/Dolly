import { describe, expect, it } from "vitest";
import type { Block } from "../../../src/core/block-store.js";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import type { DeliveryClaim } from "../../../src/core/delivery-store.js";
import {
  ExtensionCapabilityAuthority,
  type ExtensionCapabilityHandle,
  type ExtensionCapabilitySession,
  type ExtensionSessionIdentity,
} from "../../../src/core/extension-capability.js";
import {
  createDeliveredBlockReadCapability,
  type DeliveredBlockClaim,
  type DeliveredBlockReadLimits,
  type DeliveredBlockReadOperation,
} from "../../../src/core/capabilities/delivered-block-read-capability.js";

const IDENTITY: ExtensionSessionIdentity = {
  extensionId: "com.example.fixture",
  instanceId: "instance-a",
  processGenerationId: "process-generation-a",
  sessionId: "session-a",
  moduleId: "module-a",
  moduleGenerationId: "module-generation-a",
};

function block(id: string, sequence: string, value: JsonValue, summary?: string): Block {
  return {
    schemaVersion: "dolly.block/2",
    id,
    sequence,
    source: { kind: "module", id: "module-upstream" },
    createdAt: "2026-07-26T00:00:00.000Z",
    ...(summary === undefined ? {} : { summary }),
    payload: { schema: "dolly.content/1", value },
  };
}

/** A delivered Block whose content names a Block that was never delivered. */
const DELIVERED_WITH_REFERENCE = block(
  "block-delivered-1",
  "000000000000000000001",
  {
    items: [
      { type: "text", text: "delivered payload" },
      { type: "block-reference", blockId: "block-referenced-only" },
      { type: "media-reference", mediaId: "media-1" },
    ],
  },
  "first delivered block",
);
const DELIVERED_PLAIN = block("block-delivered-2", "000000000000000000002", {
  items: [{ type: "text", text: "second" }],
});

function nested(depth: number): JsonValue {
  let value: JsonValue = "leaf";
  for (let level = 0; level < depth; level += 1) value = { down: value };
  return value;
}

interface ReadHarness {
  readonly authority: ExtensionCapabilityAuthority;
  readonly session: ExtensionCapabilitySession;
  readonly handle: ExtensionCapabilityHandle;
  readonly clock: { wall: string };
  invoke(
    operation: string,
    argumentsValue: unknown,
    overrides?: Record<string, unknown>,
  ): Promise<unknown>;
}

function createHarness(
  options: {
    readonly blocks?: readonly { block: Block; deliveryIds: readonly string[] }[];
    readonly limits?: Partial<DeliveredBlockReadLimits>;
    readonly operations?: readonly DeliveredBlockReadOperation[];
  } = {},
): ReadHarness {
  const clock = { wall: "2026-07-26T00:00:00.000Z" };
  let handleSeed = 0;
  const authority = new ExtensionCapabilityAuthority({
    now: () => clock.wall,
    nextHandle: () => Buffer.alloc(32, ++handleSeed).toString("base64url"),
  });
  const session = authority.openSession(IDENTITY);
  const claim: DeliveredBlockClaim = {
    moduleJobId: "module-job-a",
    runId: "run-a",
    blockGroups: options.blocks ?? [
      { block: DELIVERED_WITH_REFERENCE, deliveryIds: ["delivery-1"] },
      { block: DELIVERED_PLAIN, deliveryIds: ["delivery-2", "delivery-3"] },
    ],
  };
  const definition = createDeliveredBlockReadCapability({
    claim,
    expiresAt: "2026-07-27T00:00:00.000Z",
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.operations === undefined ? {} : { operations: options.operations }),
  });
  const handle = session.issue(definition.grant, definition.handler);
  return {
    authority,
    session,
    handle,
    clock,
    invoke(operation, argumentsValue, overrides = {}) {
      return session.invoke({
        handle,
        operation,
        arguments: argumentsValue as never,
        moduleJobId: "module-job-a",
        runId: "run-a",
        ...overrides,
      });
    },
  };
}

describe("Extension delivered-Block read capability", () => {
  it("accepts a real Delivery Claim as its delivered-Block source", () => {
    const claim: DeliveryClaim = {
      claimToken: "claim-token-a",
      moduleJobId: "module-job-a",
      runId: "run-a",
      attempt: 1,
      moduleGenerationId: "module-generation-a",
      deliveryIds: ["delivery-1"],
      blockGroups: [
        {
          block: DELIVERED_PLAIN,
          deliveryIds: ["delivery-1"],
          occurrenceCount: 1,
          firstGlobalSequence: "000000000000000000002",
          lastGlobalSequence: "000000000000000000002",
        },
      ],
      hasMore: false,
    };
    const definition = createDeliveredBlockReadCapability({
      claim,
      expiresAt: "2026-07-27T00:00:00.000Z",
    });
    expect(definition.grant.executionScope).toEqual({
      moduleJobId: "module-job-a",
      runId: "run-a",
    });
    expect(definition.grant.resourceScope).toMatchObject({
      deliveredBlockIds: ["block-delivered-2"],
    });
  });

  it("reads a Block delivered directly in the Claim", async () => {
    const harness = createHarness();

    const snapshot = (await harness.invoke("read", {
      blockId: "block-delivered-1",
    })) as Record<string, JsonValue>;
    expect(snapshot).toMatchObject({
      schemaVersion: "dolly.delivered-block-snapshot/1",
      blockId: "block-delivered-1",
      sequence: "000000000000000000001",
      payloadSchema: "dolly.content/1",
      summary: "first delivered block",
      source: { kind: "module", id: "module-upstream" },
      deliveryIds: ["delivery-1"],
      pointer: [],
      value: DELIVERED_WITH_REFERENCE.payload.value,
    });
    expect(snapshot.nodeCount).toBe(11);
    expect(snapshot.depth).toBe(4);
  });

  it("denies a Block that the delivered snapshot only names", async () => {
    const harness = createHarness();

    const snapshot = await harness.invoke("read", { blockId: "block-delivered-1" });
    // The identifier really is visible inside the snapshot the host delivered.
    expect(JSON.stringify(snapshot)).toContain("block-referenced-only");

    // Seeing it is not authorization to read it.
    await expect(
      harness.invoke("read", { blockId: "block-referenced-only" }),
    ).rejects.toMatchObject({
      name: "ExtensionCapabilityError",
      code: "CAPABILITY_DENIED",
    });
  });

  it("denies an invented identifier and another Module job's Block", async () => {
    const harness = createHarness();

    await expect(harness.invoke("read", { blockId: "block-guessed" })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    await expect(
      harness.invoke("read", { blockId: "block-delivered-99" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await expect(harness.invoke("read", { blockId: 7 })).rejects.toMatchObject({
      code: "CAPABILITY_ARGUMENT_INVALID",
    });
    await expect(
      harness.invoke("read", { blockId: "block-delivered-1", moduleJobId: "module-job-b" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
  });

  it("lists only the directly delivered Blocks", async () => {
    const harness = createHarness();

    const listing = (await harness.invoke("list", {})) as {
      blocks: { blockId: string; deliveryIds: string[] }[];
      truncated: boolean;
    };
    expect(listing.blocks.map((entry) => entry.blockId)).toEqual([
      "block-delivered-1",
      "block-delivered-2",
    ]);
    expect(listing.truncated).toBe(false);
    expect(JSON.stringify(listing)).not.toContain("block-referenced-only");
    expect(listing.blocks[1]!.deliveryIds).toEqual(["delivery-2", "delivery-3"]);
  });

  it("paginates a listing explicitly", async () => {
    const harness = createHarness({ limits: { maxListResults: 1 } });

    await expect(harness.invoke("list", {})).resolves.toMatchObject({
      blocks: [{ blockId: "block-delivered-1" }],
      truncated: true,
      nextAfter: "block-delivered-1",
    });
    await expect(
      harness.invoke("list", { after: "block-delivered-1" }),
    ).resolves.toMatchObject({
      blocks: [{ blockId: "block-delivered-2" }],
      truncated: false,
    });
    await expect(harness.invoke("list", { limit: 2 })).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "limit", allowed: 1 },
    });
  });

  it("bounds expansion depth and fails instead of truncating", async () => {
    const deep = block("block-deep", "000000000000000000003", nested(12));
    const harness = createHarness({
      blocks: [{ block: deep, deliveryIds: ["delivery-9"] }],
      limits: { maxDepth: 4 },
    });

    await expect(harness.invoke("read", { blockId: "block-deep" })).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxDepth", allowed: 4 },
    });
    // An explicit pointer narrows the projection instead of silently trimming it.
    await expect(
      harness.invoke("read", {
        blockId: "block-deep",
        pointer: ["down", "down", "down", "down", "down", "down", "down", "down", "down"],
      }),
    ).resolves.toMatchObject({
      pointer: ["down", "down", "down", "down", "down", "down", "down", "down", "down"],
      value: { down: { down: { down: "leaf" } } },
      depth: 4,
      nodeCount: 4,
    });
  });

  it("bounds node count and serialized bytes", async () => {
    const wide = block(
      "block-wide",
      "000000000000000000004",
      Array.from({ length: 40 }, (_unused, index) => index),
    );
    const wideHarness = createHarness({
      blocks: [{ block: wide, deliveryIds: ["delivery-9"] }],
      limits: { maxNodes: 10 },
    });
    await expect(wideHarness.invoke("read", { blockId: "block-wide" })).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxNodes", allowed: 10 },
    });

    const heavy = block("block-heavy", "000000000000000000005", "x".repeat(4_000));
    const heavyHarness = createHarness({
      blocks: [{ block: heavy, deliveryIds: ["delivery-9"] }],
      limits: { maxSnapshotBytes: 1_024 },
    });
    await expect(
      heavyHarness.invoke("read", { blockId: "block-heavy" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxSnapshotBytes", allowed: 1_024 },
    });
  });

  it("rejects a pointer that does not resolve, is too long, or names a prototype key", async () => {
    const harness = createHarness({ limits: { maxPointerSegments: 3 } });

    await expect(
      harness.invoke("read", { blockId: "block-delivered-1", pointer: ["missing"] }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.invoke("read", { blockId: "block-delivered-1", pointer: ["items", 9] }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.invoke("read", { blockId: "block-delivered-1", pointer: ["__proto__"] }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.invoke("read", { blockId: "block-delivered-1", pointer: ["items", -1] }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.invoke("read", { blockId: "block-delivered-1", pointer: "items" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.invoke("read", {
        blockId: "block-delivered-1",
        pointer: ["items", 0, "type", "extra"],
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxPointerSegments", allowed: 3 },
    });
    await expect(
      harness.invoke("read", { blockId: "block-delivered-1", pointer: ["items", 0, "type"] }),
    ).resolves.toMatchObject({ value: "text" });
  });

  it("binds the capability to the Claim's Module job and Run", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke("read", { blockId: "block-delivered-1" }, { moduleJobId: "module-job-b" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
    await expect(
      harness.invoke("read", { blockId: "block-delivered-1" }, { runId: "run-b" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
  });

  it("keeps list and read as separate operations", async () => {
    const harness = createHarness({ operations: ["list"] });

    await expect(
      harness.invoke("read", { blockId: "block-delivered-1" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await expect(harness.invoke("list", {})).resolves.toMatchObject({ truncated: false });
  });

  it("denies a revoked capability, an expired grant, and a cross-session handle", async () => {
    const harness = createHarness();
    await harness.invoke("read", { blockId: "block-delivered-1" });

    const foreign = harness.authority.openSession({
      ...IDENTITY,
      sessionId: "session-foreign",
      processGenerationId: "process-generation-foreign",
    });
    await expect(
      foreign.invoke({
        handle: harness.handle,
        operation: "read",
        arguments: { blockId: "block-delivered-1" },
        moduleJobId: "module-job-a",
        runId: "run-a",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });

    harness.clock.wall = "2026-07-28T00:00:00.000Z";
    await expect(
      harness.invoke("read", { blockId: "block-delivered-1" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_EXPIRED" });

    harness.clock.wall = "2026-07-26T00:00:00.000Z";
    expect(harness.session.revoke(harness.handle)).toBe("revoked");
    await expect(
      harness.invoke("read", { blockId: "block-delivered-1" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_REVOKED" });

    await harness.session.close();
    await expect(
      harness.invoke("read", { blockId: "block-delivered-1" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SESSION_CLOSED" });
  });

  it("stops issuing snapshots once the invocation budget is spent", async () => {
    const harness = createHarness({ limits: { maxInvocations: 2 } });

    await harness.invoke("read", { blockId: "block-delivered-1" });
    await harness.invoke("read", { blockId: "block-delivered-2" });
    await expect(
      harness.invoke("read", { blockId: "block-delivered-1" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_QUOTA_EXCEEDED" });
  });
});
