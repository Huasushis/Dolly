import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { SourceActivationQueue } from "../../../src/core/source-activation-queue.js";
import {
  SkillRefreshScheduler,
  createSkillSourceActivationSubmitter,
} from "../../../src/extensions/skill/index.js";
import { ManualTimerHost } from "./fixtures/manual-timers.js";

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
  maxResidentCount = 2,
): SourceActivationQueue {
  const queue = new SourceActivationQueue({
    core,
    moduleId: "skill-module",
    maxResidentCount,
    maxResidentBytes: 4096,
    maxRequestBytes: 2048,
  });
  queue.reconcile();
  return queue;
}

function terminallyConsume(core: FileCoreStateStore, queue: SourceActivationQueue): void {
  const claim = core.deliveries.claim({
    consumerId: "skill-module",
    pageIds: [queue.privatePageId],
    moduleGenerationId: "skill-generation-1",
    maxCount: 1,
    maxBytes: 4096,
  });
  if (claim === null) throw new Error("expected one source activation Claim");
  core.negativelyAcknowledgeDeliveryClaim({
    ...claim,
    failure: { code: "TEST_TERMINAL", retryable: false },
  });
}

describe("Skill refresh -> durable source activation", () => {
  let scratch: string;
  let statePath: string;

  beforeEach(() => {
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    scratch = mkdtempSync(join(scratchParent, "dolly-skill-source-"));
    statePath = join(scratch, "core-state.json");
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("turns initial and coalesced filesystem hints into bounded canonical requests", () => {
    const core = openStore(statePath, "effect");
    const queue = openQueue(core);
    const timers = new ManualTimerHost();
    const refresh = new SkillRefreshScheduler({
      moduleId: "skill-module",
      monotonicNow: timers.monotonicNow,
      setTimer: timers.setTimer,
      submitSourceActivation: createSkillSourceActivationSubmitter(queue),
      debounceMs: 500,
      maxDebounceMs: 5000,
      periodicVerificationMs: 0,
    });

    refresh.start();
    expect(refresh.status()).toMatchObject({
      liveIdempotencyKey: "skill-refresh:skill-module:0",
      submittedRequestCount: 1,
    });
    let claim = core.deliveries.claim({
      consumerId: "skill-module",
      pageIds: [queue.privatePageId],
      moduleGenerationId: "skill-generation-1",
      maxCount: 1,
      maxBytes: 4096,
    });
    expect(claim?.blockGroups[0]?.block.payload).toEqual({
      schema: "dolly.source-activation/1",
      value: {
        schemaVersion: "dolly.source-activation/1",
        moduleId: "skill-module",
        idempotencyKey: "skill-refresh:skill-module:0",
        body: {
          kind: "skill.refresh/1",
          reason: "initial",
          requestedAt: 0,
          signalCount: 1,
        },
      },
    });
    core.negativelyAcknowledgeDeliveryClaim({
      ...claim!,
      failure: { code: "TEST_TERMINAL", retryable: false },
    });
    expect(refresh.completeRefresh("skill-refresh:skill-module:0")).toBe(true);

    refresh.notifyChange("filesystem-change");
    refresh.notifyChange("filesystem-change");
    refresh.notifyChange("filesystem-change");
    timers.advance(500);

    expect(refresh.status()).toMatchObject({
      liveIdempotencyKey: "skill-refresh:skill-module:1",
      submittedRequestCount: 2,
      lastRequest: { signalCount: 3 },
    });
    claim = core.deliveries.claim({
      consumerId: "skill-module",
      pageIds: [queue.privatePageId],
      moduleGenerationId: "skill-generation-1",
      maxCount: 1,
      maxBytes: 4096,
    });
    expect(claim?.blockGroups[0]?.block.payload.value).toMatchObject({
      idempotencyKey: "skill-refresh:skill-module:1",
      body: {
        reason: "filesystem-change",
        requestedAt: 500,
        signalCount: 3,
      },
    });
  });

  it("keeps a refused refresh pending when the source queue is full", () => {
    const core = openStore(statePath, "full");
    const queue = openQueue(core, 1);
    queue.submit({ idempotencyKey: "filler:1", body: { kind: "test/1" } });
    const timers = new ManualTimerHost();
    const refresh = new SkillRefreshScheduler({
      moduleId: "skill-module",
      monotonicNow: timers.monotonicNow,
      setTimer: timers.setTimer,
      submitSourceActivation: createSkillSourceActivationSubmitter(queue),
      debounceMs: 500,
      maxDebounceMs: 5000,
      periodicVerificationMs: 0,
    });

    refresh.start();
    expect(refresh.status()).toMatchObject({
      liveIdempotencyKey: null,
      pendingSignalCount: 1,
      submittedRequestCount: 0,
    });
    expect(refresh.status().lastSubmitErrorMessage).toContain("capacity");
    expect(queue.inspect().residentCount).toBe(1);

    terminallyConsume(core, queue);
    refresh.notifyChange("filesystem-change");
    timers.advance(500);

    expect(refresh.status()).toMatchObject({
      liveIdempotencyKey: "skill-refresh:skill-module:0",
      pendingSignalCount: 0,
      submittedRequestCount: 1,
      lastRequest: { reason: "initial", signalCount: 2 },
    });
    expect(queue.inspect()).toMatchObject({ residentCount: 1, pendingCount: 1 });
  });

  it("deduplicates one adapter retry and rejects another Module identity", () => {
    const core = openStore(statePath, "identity");
    const queue = openQueue(core);
    const submit = createSkillSourceActivationSubmitter(queue);
    const request = {
      idempotencyKey: "skill-refresh:skill-module:0",
      moduleId: "skill-module",
      reason: "initial" as const,
      requestedAt: 0,
      signalCount: 1,
    };

    expect(() => submit(request)).not.toThrow();
    const revision = core.revision;
    expect(() => submit(request)).not.toThrow();
    expect(core.revision).toBe(revision);
    expect(queue.inspect().residentCount).toBe(1);

    expect(() => submit({ ...request, moduleId: "another-module" })).toThrowError(
      expect.objectContaining({ code: "SKILL_SOURCE_ACTIVATION_MODULE_MISMATCH" }),
    );
    expect(queue.inspect().residentCount).toBe(1);
  });
});
