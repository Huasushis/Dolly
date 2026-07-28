/**
 * Only the authorized Console ingress producer may emit a content item whose
 * `schema` is `dolly.console.message-boundary/1`.
 *
 * `console-extension.md` Section 15.1 item 8 requires the reserved name to be
 * owned by one publisher. The general registry that would express publisher
 * grants, validator digests, and reserved-name collisions does not exist yet.
 * This suite covers the half that can be enforced today and that matters most:
 * the message stream carrying these boundaries is fed to a language model, so
 * an Extension that can forge a session boundary can inject conversation
 * structure. The check therefore lives on Core's Block commit path, where no
 * Extension can decline to run it.
 *
 * The load-bearing assertion in every refusal case is that **no Block was
 * created** — the identifier generator is never called and the store stays
 * empty — because a create-then-roll-back design would mean a forged boundary
 * momentarily existed.
 */

import { describe, expect, it } from "vitest";
import { BlockStore, BlockStoreError, type BlockProposal } from "../../../src/core/block-store.js";
import { DeliveryStore } from "../../../src/core/delivery-store.js";
import {
  InMemoryModuleResultCommitRepository,
  ModuleResultCommitCoordinator,
} from "../../../src/core/module-result-commit.js";
import {
  CONSOLE_MESSAGE_BOUNDARY_SCHEMA,
  ReservedContentSchemaPolicy,
} from "../../../src/core/reserved-content-schema.js";

const NOW = "2026-07-26T00:00:00.000Z";
const CONSOLE_INGRESS = { kind: "module", id: "console.ingress" } as const;
const IMPOSTOR = { kind: "module", id: "helpful.summarizer" } as const;

function consolePolicy(): ReservedContentSchemaPolicy {
  return new ReservedContentSchemaPolicy([
    { schema: CONSOLE_MESSAGE_BOUNDARY_SCHEMA, producer: CONSOLE_INGRESS },
  ]);
}

function createStore(policy?: ReservedContentSchemaPolicy) {
  let issued = 0;
  const blocks = new BlockStore({
    nextBlockId: () => `block-${(issued += 1)}`,
    now: () => NOW,
    ...(policy === undefined ? {} : { reservedContentSchemas: policy }),
  });
  return {
    blocks,
    /** Every call means one Block identifier was allocated. */
    issuedCount: () => issued,
    storedCount: () => blocks.snapshot().records.length,
  };
}

function boundaryProposal(
  extraItems: readonly unknown[] = [],
  schema: string = CONSOLE_MESSAGE_BOUNDARY_SCHEMA,
): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: {
        items: [
          { type: "data", schema, value: {} },
          { type: "text", text: "hello" },
          ...extraItems,
        ],
      },
    },
  } as BlockProposal;
}

describe("CORE-RESERVED-001 direct Block commit", () => {
  it("refuses a reserved boundary item from a source that does not own the name", () => {
    const store = createStore(consolePolicy());

    expect(() => store.blocks.commit(boundaryProposal(), IMPOSTOR)).toThrowError(
      expect.objectContaining({ code: "BLOCK_RESERVED_SCHEMA_FORBIDDEN" }),
    );

    // The refusal happened before anything was created, not after.
    expect(store.issuedCount()).toBe(0);
    expect(store.storedCount()).toBe(0);
  });

  it("accepts the same proposal from the authorized producer", () => {
    const store = createStore(consolePolicy());
    const block = store.blocks.commit(boundaryProposal(), CONSOLE_INGRESS);

    expect(block.id).toBe("block-1");
    expect(store.storedCount()).toBe(1);
    expect(store.issuedCount()).toBe(1);
  });

  it("binds the grant to the exact producer identity, not to a shape", () => {
    const store = createStore(consolePolicy());
    const wrongKind = { kind: "system", id: CONSOLE_INGRESS.id } as const;
    const wrongId = { kind: "module", id: "console.ingress.v2" } as const;

    for (const source of [wrongKind, wrongId]) {
      expect(() => store.blocks.commit(boundaryProposal(), source)).toThrowError(
        expect.objectContaining({ code: "BLOCK_RESERVED_SCHEMA_FORBIDDEN" }),
      );
    }
    expect(store.issuedCount()).toBe(0);
  });

  it("finds the reserved item wherever it sits in the item list", () => {
    const store = createStore(consolePolicy());
    const buried: BlockProposal = {
      payload: {
        schema: "dolly.content/1",
        value: {
          items: [
            { type: "text", text: "first" },
            { type: "data", schema: "acme.telemetry/1", value: { ok: true } },
            { type: "data", schema: CONSOLE_MESSAGE_BOUNDARY_SCHEMA, value: {} },
          ],
        },
      },
    } as BlockProposal;

    expect(() => store.blocks.commit(buried, IMPOSTOR)).toThrowError(
      expect.objectContaining({ code: "BLOCK_RESERVED_SCHEMA_FORBIDDEN" }),
    );
    expect(store.issuedCount()).toBe(0);
  });

  it("fails closed when no producer is configured at all", () => {
    const store = createStore();

    // Nothing is authorized, so even the Console ingress identity is refused.
    for (const source of [CONSOLE_INGRESS, IMPOSTOR]) {
      expect(() => store.blocks.commit(boundaryProposal(), source)).toThrowError(
        expect.objectContaining({ code: "BLOCK_RESERVED_SCHEMA_FORBIDDEN" }),
      );
    }
    expect(store.issuedCount()).toBe(0);
  });

  it("leaves every non-reserved data schema untouched", () => {
    const store = createStore(consolePolicy());

    // A different name that merely looks similar is ordinary extension data.
    const lookalikes = [
      "dolly.console.message-boundary/10",
      "dolly.console.message-boundary",
      "acme.dolly.console.message-boundary/1",
    ];
    for (const schema of lookalikes) {
      const block = store.blocks.commit(boundaryProposal([], schema), IMPOSTOR);
      expect(block.id).toMatch(/^block-\d+$/u);
    }
    expect(store.storedCount()).toBe(lookalikes.length);
  });

  it("does not relax the existing dolly.content/1 validation", () => {
    const store = createStore(consolePolicy());
    const malformed: readonly BlockProposal[] = [
      // A data item missing its value.
      { payload: { schema: "dolly.content/1", value: { items: [{ type: "data", schema: "a/1" }] } } },
      // An unknown item type.
      { payload: { schema: "dolly.content/1", value: { items: [{ type: "sneaky", text: "x" }] } } },
      // An empty item list.
      { payload: { schema: "dolly.content/1", value: { items: [] } } },
      // A data item with an extra field.
      {
        payload: {
          schema: "dolly.content/1",
          value: {
            items: [
              { type: "data", schema: CONSOLE_MESSAGE_BOUNDARY_SCHEMA, value: {}, fallback: "x" },
            ],
          },
        },
      },
    ] as readonly BlockProposal[];

    for (const proposal of malformed) {
      expect(() => store.blocks.commit(proposal, CONSOLE_INGRESS)).toThrowError(BlockStoreError);
    }
    expect(store.issuedCount()).toBe(0);
  });
});

describe("CORE-RESERVED-002 idempotent commit path", () => {
  it("records no commit effect for a refused proposal", () => {
    const store = createStore(consolePolicy());

    expect(() =>
      store.blocks.commitOnce("effect-1", boundaryProposal(), IMPOSTOR),
    ).toThrowError(expect.objectContaining({ code: "BLOCK_RESERVED_SCHEMA_FORBIDDEN" }));
    expect(store.issuedCount()).toBe(0);
    expect(store.blocks.snapshot().commitEffects).toHaveLength(0);

    // The refusal left no poisoned effect behind: the authorized producer can
    // still use that identifier.
    const block = store.blocks.commitOnce("effect-1", boundaryProposal(), CONSOLE_INGRESS);
    expect(block.id).toBe("block-1");
    expect(store.blocks.snapshot().commitEffects).toHaveLength(1);
  });
});

describe("CORE-RESERVED-003 the Module result path", () => {
  function moduleHarness(consumerId: string) {
    const store = createStore(consolePolicy());
    let runtimeId = 0;
    const deliveries = new DeliveryStore({
      blocks: store.blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => `${kind}-${(runtimeId += 1)}`,
      now: () => NOW,
    });
    deliveries.createPage("input");
    deliveries.createPage("out");
    deliveries.registerConsumer("input", consumerId, "from-now");
    const seed = store.blocks.commit(
      { payload: { schema: "dolly.content/1", value: { items: [{ type: "text", text: "seed" }] } } },
      { kind: "system", id: "seeder" },
    );
    deliveries.append("input", seed.id);
    const claim = deliveries.claim({
      consumerId,
      pageIds: ["input"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    const repository = new InMemoryModuleResultCommitRepository();
    const coordinator = new ModuleResultCommitCoordinator({
      blocks: store.blocks,
      deliveries,
      repository,
      now: () => NOW,
    });
    return { store, deliveries, claim, repository, coordinator };
  }

  it("refuses a forged boundary before any commit record is prepared", async () => {
    const harness = moduleHarness(IMPOSTOR.id);
    const issuedBefore = harness.store.issuedCount();
    const storedBefore = harness.store.storedCount();

    await expect(
      harness.coordinator.commit({
        moduleJobId: harness.claim.moduleJobId,
        claimToken: harness.claim.claimToken,
        runId: harness.claim.runId,
        attempt: harness.claim.attempt,
        moduleGenerationId: harness.claim.moduleGenerationId,
        source: IMPOSTOR,
        outputPageIds: ["out"],
        blockProposal: boundaryProposal(),
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "BLOCK_RESERVED_SCHEMA_FORBIDDEN" }));

    // Nothing was prepared, so there is no record a later recovery could
    // replay into a committed forged Block.
    expect(harness.repository.list()).toHaveLength(0);
    expect(harness.store.issuedCount()).toBe(issuedBefore);
    expect(harness.store.storedCount()).toBe(storedBefore);
  });

  it("lets the authorized Console ingress Module commit the same result", async () => {
    const harness = moduleHarness(CONSOLE_INGRESS.id);
    const storedBefore = harness.store.storedCount();

    const record = await harness.coordinator.commit({
      moduleJobId: harness.claim.moduleJobId,
      claimToken: harness.claim.claimToken,
      runId: harness.claim.runId,
      attempt: harness.claim.attempt,
      moduleGenerationId: harness.claim.moduleGenerationId,
      source: CONSOLE_INGRESS,
      outputPageIds: ["out"],
      blockProposal: boundaryProposal(),
    });

    expect(record.state).toBe("committed");
    expect(harness.repository.list()).toHaveLength(1);
    expect(harness.store.storedCount()).toBe(storedBefore + 1);
  });
});
