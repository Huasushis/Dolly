import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import { createModuleResultCommitCoordinator } from "../../../src/core/module-result-commit-factory.js";
import { InMemoryModuleResultCommitRepository } from "../../../src/core/module-result-commit.js";
import {
  ModuleScheduler,
  type SchedulableModuleRuntime,
  type SchedulerClock,
  type SchedulerEvent,
  type SchedulerTimer,
} from "../../../src/core/module-scheduler.js";
import {
  ReactiveModuleRuntime,
  type ReactiveModuleInput,
  type ReactiveModuleTickResult,
} from "../../../src/core/reactive-module-runtime.js";
import {
  SourceActivationQueue,
  SourceActivationQueueError,
} from "../../../src/core/source-activation-queue.js";

const NOW = "2026-08-10T00:00:00.000Z";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratchParent = resolve(repositoryRoot, "..", ".tmp");

interface TimerState {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
}

class FakeClock implements SchedulerClock {
  #sequence = 0;
  readonly #timers = new Map<number, TimerState>();

  monotonicNow(): number {
    return 0;
  }

  schedule(delayMs: number, callback: () => void): SchedulerTimer {
    const id = ++this.#sequence;
    this.#timers.set(id, { id, dueAt: delayMs, callback });
    return { cancel: () => this.#timers.delete(id) };
  }

  runDue(): void {
    for (;;) {
      const next = [...this.#timers.values()]
        .filter((timer) => timer.dueAt <= 0)
        .sort((left, right) => left.id - right.id)[0];
      if (next === undefined) return;
      this.#timers.delete(next.id);
      next.callback();
    }
  }
}

async function drain(clock: FakeClock): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    await Promise.resolve();
    clock.runDue();
  }
}

function createScheduler(
  core: FileCoreStateStore,
  clock: FakeClock,
  events: SchedulerEvent[] = [],
): ModuleScheduler {
  return new ModuleScheduler({
    instanceId: "source-instance",
    deliveries: core.deliveries,
    clock,
    wallClockNow: () => Date.parse(NOW),
    pollIntervalMs: 60_000,
    retryBaseMs: 250,
    retryMaxMs: 2_000,
    maxConcurrentModules: 1,
    backpressureAction: "pause-upstream",
    downstreamRecheckMs: 50,
    noProgressAfterMs: 1_000,
    claimLimitCount: 1,
    claimLimitBytes: 4_096,
    retryJitterRatio: 0,
    onEvent: (event) => events.push(event),
  });
}

class ConsumingSourceRuntime implements SchedulableModuleRuntime {
  readonly moduleGenerationId = "source-generation-1";
  tickCount = 0;

  constructor(
    readonly core: FileCoreStateStore,
    readonly queue: SourceActivationQueue,
  ) {}

  async tick(): Promise<ReactiveModuleTickResult> {
    this.tickCount += 1;
    const claim = this.core.deliveries.claim({
      consumerId: "source-module",
      pageIds: [this.queue.privatePageId],
      moduleGenerationId: this.moduleGenerationId,
      maxCount: 1,
      maxBytes: 4096,
    });
    if (claim === null) return { status: "idle" };
    const failure = { code: "TEST_TERMINAL", retryable: false } as const;
    this.core.negativelyAcknowledgeDeliveryClaim({ ...claim, failure });
    return { ...claim, status: "dead-lettered", failure };
  }
}

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

function appendRunningProcess(core: FileCoreStateStore): void {
  const processGenerationId = "source-process-generation-1";
  core.appendModuleProcessRecord({
    schemaVersion: "dolly.module-process-record/1",
    instanceId: "source-instance",
    moduleId: "source-module",
    moduleGenerationId: "source-generation-1",
    processGenerationId,
    packageDigest: `sha256:${"a".repeat(64)}`,
    configurationReference: {
      configId: "source-config",
      revision: `sha256:${"b".repeat(64)}`,
      configVersion: 1,
    },
    declaredExternalEffects: "none",
    serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
    bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
    moduleCgroupPath: deriveModuleCgroupPath(
      "/system.slice/dolly-core.service",
      {
        instanceId: "source-instance",
        moduleId: "source-module",
        processGenerationId,
      },
    ).filesystemPath,
    state: "starting",
    createdAt: NOW,
    updatedAt: NOW,
  });
  core.updateModuleProcessRecordState(processGenerationId, "running");
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

  it("lets Scheduler drive one durable source request through an authentic binding", async () => {
    const core = openStore(statePath, "scheduler");
    const queue = openQueue(core);
    const binding = queue.schedulerBinding();
    const runtime = new ConsumingSourceRuntime(core, queue);
    const clock = new FakeClock();
    const events: SchedulerEvent[] = [];
    const scheduler = createScheduler(core, clock, events);
    scheduler.register({
      moduleId: "source-module",
      runtime,
      inputPageIds: [],
      outputPageIds: [],
      mailbox: { maxResidentCount: 2, maxResidentBytes: 4096 },
      activation: { kind: "source" },
      sourceActivationBinding: binding,
    });
    expect(scheduler.status("source-module").activationMode).toBe("source");
    queue.submit({ idempotencyKey: "activation:1", body: { reason: "manual" } });

    scheduler.start();
    await drain(clock);

    expect(runtime.tickCount).toBe(1);
    expect(queue.inspect().residentCount).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "scheduler.dispatched",
      moduleId: "source-module",
      reasonCode: "READY_SOURCE",
    }));
    await scheduler.stop();
  });

  it("runs the private request through ReactiveModuleRuntime and atomically commits it", async () => {
    const core = openStore(statePath, "runtime");
    const queue = openQueue(core);
    appendRunningProcess(core);
    const repository = new InMemoryModuleResultCommitRepository();
    const commits = createModuleResultCommitCoordinator({
      core,
      repository,
      now: () => NOW,
      mailboxes: [],
    });
    let executedInput: ReactiveModuleInput | undefined;
    let executorStarts = 0;
    const runtime = new ReactiveModuleRuntime({
      moduleId: "source-module",
      initialModuleGenerationId: "source-generation-1",
      inputPageIds: [queue.privatePageId],
      outputPageIds: [],
      claimMaxCount: 1,
      claimMaxBytes: 4096,
      maxInputBytes: 8192,
      maxResultBytes: 4096,
      executionTimeoutMs: 60_000,
      cancellationGraceMs: 1_000,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      maxRunsPerGeneration: 10,
      maxGenerations: 2,
      deliveries: core.deliveries,
      persistModuleSubmission: (request) => {
        core.appendModuleSubmissionRecord({
          schemaVersion: "dolly.module-submission-record/1",
          ...request,
          processGenerationId: "source-process-generation-1",
          createdAt: NOW,
        });
      },
      releaseDeliveryClaim: (identity) => core.releaseDeliveryClaim(identity),
      negativelyAcknowledgeDeliveryClaim: (request) =>
        core.negativelyAcknowledgeDeliveryClaim(request),
      getModuleSubmissionRecord: (runId) => core.getModuleSubmissionRecord(runId),
      commits,
      nextModuleGenerationId: () => "source-generation-2",
      monotonicNow: () => 0,
      declaredExternalEffects: "none",
      createExecutor: () => ({
        isolation: "process",
        start: async () => {
          executorStarts += 1;
        },
        execute: async (input) => {
          executedInput = input;
          return { schemaVersion: "dolly.module-result/1" };
        },
        terminate: async () => undefined,
      }),
      classifyFailure: (failure) => ({ code: failure.code, retryable: false }),
    });
    await runtime.start();
    const clock = new FakeClock();
    const scheduler = createScheduler(core, clock);
    scheduler.register({
      moduleId: "source-module",
      runtime,
      inputPageIds: [],
      outputPageIds: [],
      mailbox: { maxResidentCount: 2, maxResidentBytes: 4096 },
      activation: { kind: "source" },
      sourceActivationBinding: queue.schedulerBinding(),
    });
    queue.submit({
      idempotencyKey: "activation:runtime:1",
      body: { kind: "manual/1", instruction: "refresh" },
    });

    scheduler.start();
    await drain(clock);

    expect(executorStarts).toBe(1);
    expect(executedInput?.blockGroups).toHaveLength(1);
    expect(executedInput?.blockGroups[0]?.block.payload).toMatchObject({
      schema: "dolly.source-activation/1",
      value: {
        idempotencyKey: "activation:runtime:1",
        body: { kind: "manual/1", instruction: "refresh" },
      },
    });
    expect(queue.inspect().residentCount).toBe(0);
    expect(repository.list()).toEqual([
      expect.objectContaining({ state: "committed", outputPageIds: [] }),
    ]);
    expect(core.listModuleSubmissionRecords()).toEqual([]);
    expect(core.snapshot().stateDigest).toBe(
      canonicalJsonDigest((({ stateDigest: _, ...payload }) => payload)(core.snapshot())),
    );
    await scheduler.stop();
    await runtime.stop();
  });

  it("rejects forged, cross-store, or publicly routed source bindings", () => {
    const core = openStore(statePath, "bound");
    const queue = openQueue(core);
    const binding = queue.schedulerBinding();
    const otherPath = join(scratch, "other-core-state.json");
    const otherCore = openStore(otherPath, "other");
    const otherClock = new FakeClock();
    const otherScheduler = createScheduler(otherCore, otherClock);
    const runtime = new ConsumingSourceRuntime(core, queue);

    expect(() => otherScheduler.register({
      moduleId: "source-module",
      runtime,
      inputPageIds: [],
      outputPageIds: [],
      mailbox: { maxResidentCount: 2, maxResidentBytes: 4096 },
      activation: { kind: "source" },
      sourceActivationBinding: binding,
    })).toThrowError(expect.objectContaining({ code: "SCHEDULER_CONFIGURATION_INVALID" }));

    const scheduler = createScheduler(core, new FakeClock());
    expect(() => scheduler.register({
      moduleId: "source-module",
      runtime,
      inputPageIds: [],
      outputPageIds: [],
      mailbox: { maxResidentCount: 2, maxResidentBytes: 4096 },
      activation: { kind: "source" },
      sourceActivationBinding: {
        schemaVersion: "dolly.source-activation-binding/1",
        moduleId: "source-module",
        privatePageId: queue.privatePageId,
      },
    })).toThrowError(expect.objectContaining({ code: "SCHEDULER_CONFIGURATION_INVALID" }));

    expect(() => scheduler.register({
      moduleId: "source-module",
      runtime,
      inputPageIds: [queue.privatePageId],
      outputPageIds: [],
      mailbox: { maxResidentCount: 2, maxResidentBytes: 4096 },
      activation: { kind: "source" },
      sourceActivationBinding: binding,
    })).toThrowError(expect.objectContaining({ code: "SCHEDULER_CONFIGURATION_INVALID" }));

    scheduler.register({
      moduleId: "source-module",
      runtime,
      inputPageIds: [],
      outputPageIds: [],
      mailbox: { maxResidentCount: 2, maxResidentBytes: 4096 },
      activation: { kind: "source" },
      sourceActivationBinding: binding,
    });
    expect(() => scheduler.register({
      moduleId: "producer",
      runtime: {
        moduleGenerationId: "producer-generation-1",
        tick: async () => ({ status: "idle" }),
      },
      inputPageIds: ["public-input"],
      outputPageIds: [queue.privatePageId],
      mailbox: { maxResidentCount: 2, maxResidentBytes: 4096 },
    })).toThrowError(expect.objectContaining({ code: "SCHEDULER_CONFIGURATION_INVALID" }));
  });
});
