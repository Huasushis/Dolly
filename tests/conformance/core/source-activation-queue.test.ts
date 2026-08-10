import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import {
  SourceActivationQueue,
  SourceActivationQueueError,
} from "../../../src/core/source-activation-queue.js";

const NOW = "2026-08-10T00:00:00.000Z";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratchParent = resolve(repositoryRoot, "..", ".tmp");

function openStore(path: string, prefix: string): FileCoreStateStore {
  let blockId = 0;
  let deliveryId = 0;
  return new FileCoreStateStore({
    path,
    maxFailedAttempts: 3,
    nextBlockId: () => `${prefix}-block-${++blockId}`,
    nextDeliveryId: (kind) => `${prefix}-${kind}-${++deliveryId}`,
    now: () => NOW,
  });
}

function openQueue(
  core: FileCoreStateStore,
  limits: {
    readonly maxResidentCount?: number;
    readonly maxResidentBytes?: number;
    readonly maxRequestBytes?: number;
  } = {},
): SourceActivationQueue {
  const queue = new SourceActivationQueue({
    core,
    moduleId: "source-module",
    maxResidentCount: limits.maxResidentCount ?? 2,
    maxResidentBytes: limits.maxResidentBytes ?? 4096,
    maxRequestBytes: limits.maxRequestBytes ?? 2048,
  });
  queue.reconcile();
  return queue;
}

describe("Core-private source activation queue", () => {
  let scratch: string;
  let statePath: string;

  beforeEach(() => {
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    scratch = mkdtempSync(join(scratchParent, "dolly-source-activation-"));
    statePath = join(scratch, "core-state.json");
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("persists one private Delivery and deduplicates the exact request across reopen", () => {
    const firstCore = openStore(statePath, "first");
    const firstQueue = openQueue(firstCore);
    const request = {
      idempotencyKey: "skill-refresh:source-module:1",
      body: {
        kind: "skill.refresh/1",
        reason: "filesystem-change",
        signalCount: 3,
      },
    } as const;

    const beforeSubmitRevision = firstCore.revision;
    const enqueued = firstQueue.submit(request);
    expect(enqueued.status).toBe("enqueued");
    expect(firstCore.revision).toBe(beforeSubmitRevision + 1);
    const afterFirstRevision = firstCore.revision;
    const duplicate = firstQueue.submit(request);
    expect(duplicate).toEqual({ ...enqueued, status: "duplicate" });
    expect(firstCore.revision).toBe(afterFirstRevision);
    expect(firstQueue.inspect()).toMatchObject({
      residentCount: 1,
      pendingCount: 1,
      claimedCount: 0,
    });

    const reopenedCore = openStore(statePath, "reopened");
    const reopenedQueue = openQueue(reopenedCore);
    const afterReconcileRevision = reopenedCore.revision;
    expect(reopenedQueue.submit(request)).toEqual({ ...enqueued, status: "duplicate" });
    expect(reopenedCore.revision).toBe(afterReconcileRevision);

    const claim = reopenedCore.deliveries.claim({
      consumerId: "source-module",
      pageIds: [reopenedQueue.privatePageId],
      moduleGenerationId: "source-generation-1",
      maxCount: 1,
      maxBytes: 4096,
    });
    expect(claim).not.toBeNull();
    expect(claim?.blockGroups).toHaveLength(1);
    expect(claim?.blockGroups[0]?.block.payload).toEqual({
      schema: "dolly.source-activation/1",
      value: {
        schemaVersion: "dolly.source-activation/1",
        moduleId: "source-module",
        idempotencyKey: request.idempotencyKey,
        body: request.body,
      },
    });

    reopenedCore.negativelyAcknowledgeDeliveryClaim({
      ...claim!,
      failure: { code: "TEST_TERMINAL", retryable: false },
    });
    expect(reopenedQueue.inspect().residentCount).toBe(0);
    const afterReleaseRevision = reopenedCore.revision;
    expect(reopenedQueue.submit(request)).toEqual({ ...enqueued, status: "duplicate" });
    expect(reopenedCore.revision).toBe(afterReleaseRevision);
    expect(reopenedQueue.inspect().residentCount).toBe(0);
  });

  it("rejects one idempotency key reused with different content without changing Core state", () => {
    const core = openStore(statePath, "conflict");
    const queue = openQueue(core);
    queue.submit({ idempotencyKey: "activation:1", body: { reason: "first" } });
    const before = core.snapshot();

    expect(() =>
      queue.submit({ idempotencyKey: "activation:1", body: { reason: "changed" } }),
    ).toThrowError(SourceActivationQueueError);
    try {
      queue.submit({ idempotencyKey: "activation:1", body: { reason: "changed" } });
    } catch (error) {
      expect(error).toMatchObject({ code: "SOURCE_ACTIVATION_CONFLICT" });
    }
    expect(core.snapshot()).toEqual(before);
  });

  it("counts claimed requests as resident and refuses a new request without orphan effects", () => {
    const core = openStore(statePath, "capacity");
    const queue = openQueue(core, { maxResidentCount: 1 });
    queue.submit({ idempotencyKey: "activation:1", body: { reason: "first" } });
    const claim = core.deliveries.claim({
      consumerId: "source-module",
      pageIds: [queue.privatePageId],
      moduleGenerationId: "source-generation-1",
      maxCount: 1,
      maxBytes: 4096,
    });
    expect(claim).not.toBeNull();
    expect(queue.inspect()).toMatchObject({
      pendingCount: 0,
      claimedCount: 1,
      residentCount: 1,
    });
    const before = core.snapshot();

    expect(queue.submit({
      idempotencyKey: "activation:2",
      body: { reason: "second" },
    })).toMatchObject({
      status: "backpressured",
      residentCount: 1,
      maxResidentCount: 1,
    });
    expect(core.snapshot()).toEqual(before);

    core.releaseDeliveryClaim(claim!);
    const retried = core.deliveries.claim({
      consumerId: "source-module",
      pageIds: [queue.privatePageId],
      moduleGenerationId: "source-generation-1",
      maxCount: 1,
      maxBytes: 4096,
    });
    expect(retried).not.toBeNull();
    expect(retried?.moduleJobId).toBe(claim?.moduleJobId);
    expect(retried?.runId).not.toBe(claim?.runId);
  });

  it("applies the byte bound to canonical request bytes and admits exact duplicates first", () => {
    const core = openStore(statePath, "bytes");
    const roomy = openQueue(core);
    const first = { idempotencyKey: "activation:1", body: { payload: "x".repeat(32) } };
    const enqueued = roomy.submit(first);
    const exactBytes = roomy.inspect().residentBytes;
    expect(exactBytes).toBeGreaterThan(0);

    const bounded = openQueue(core, {
      maxResidentBytes: exactBytes,
      maxRequestBytes: exactBytes,
    });
    expect(bounded.submit(first)).toEqual({ ...enqueued, status: "duplicate" });
    const before = core.snapshot();
    expect(bounded.submit({
      idempotencyKey: "activation:2",
      body: { payload: "y" },
    })).toMatchObject({
      status: "backpressured",
      residentBytes: exactBytes,
      maxResidentBytes: exactBytes,
    });
    expect(core.snapshot()).toEqual(before);
  });

  it("fails closed if the private Page has another consumer", () => {
    const core = openStore(statePath, "route");
    const queue = openQueue(core);
    core.deliveries.registerConsumer(queue.privatePageId, "intruder", "from-now");

    expect(() => queue.reconcile()).toThrowError(
      expect.objectContaining({ code: "SOURCE_ACTIVATION_ROUTE_INVALID" }),
    );
  });

  it("rejects a foreign Block appended to the private Page", () => {
    const core = openStore(statePath, "foreign");
    const queue = openQueue(core);
    const forged = core.blocks.commit(
      { payload: { schema: "test.content/1", value: { forged: true } } },
      { kind: "external", id: "forged-source" },
    );
    core.deliveries.append(queue.privatePageId, forged.id);

    expect(() => queue.inspect()).toThrowError(
      expect.objectContaining({ code: "SOURCE_ACTIVATION_STATE_INVALID" }),
    );
  });
});
