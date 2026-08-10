import { describe, expect, it, vi } from "vitest";
import { BlockStore, type BlockProposal } from "../../../src/core/block-store.js";
import {
  DeliveryStore,
  type DeliveryClaim,
  type DeliveryClaimIdentity,
} from "../../../src/core/delivery-store.js";
import type { ModuleSubmissionRecord } from "../../../src/core/module-process-records.js";
import {
  InMemoryModuleResultCommitRepository,
  ModuleResultCommitCoordinator,
  type ModuleResultCommitRecord,
} from "../../../src/core/module-result-commit.js";
import {
  ModuleScheduler,
  ModuleSchedulerError,
  periodicEligibility,
  type ModuleSchedulerOptions,
  type SchedulableModuleRuntime,
  type SchedulerClock,
  type SchedulerDecision,
  type SchedulerEvent,
  type SchedulerPendingReader,
  type SchedulerPendingSnapshot,
  type SchedulerPolicy,
  type SchedulerSnapshot,
  type SchedulerTimer,
} from "../../../src/core/module-scheduler.js";
import {
  ReactiveModuleRuntime,
  type ReactiveModuleClaimLimits,
  type ReactiveModuleInput,
  type ReactiveModuleResult,
  type ReactiveModuleRuntimeOptions,
  type ReactiveModuleTickResult,
} from "../../../src/core/reactive-module-runtime.js";

const NOW = "2026-07-26T00:00:00.000Z";

function submissionForClaim(
  claim: DeliveryClaimIdentity & { readonly inputDigest: string },
): ModuleSubmissionRecord {
  return {
    schemaVersion: "dolly.module-submission-record/1",
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: claim.moduleGenerationId,
    processGenerationId: `${claim.moduleGenerationId}-process`,
    inputDigest: claim.inputDigest,
    createdAt: NOW,
  };
}

interface FakeTimerState {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
}

/**
 * A deterministic monotonic clock and timer wheel. Nothing in this file waits
 * on real time: a test moves the clock itself and runs whatever became due,
 * which is what Sections 11.4 and 18.5 require of conformance tests.
 */
class FakeSchedulerClock implements SchedulerClock {
  #now = 0;
  #sequence = 0;
  readonly #timers = new Map<number, FakeTimerState>();

  monotonicNow(): number {
    return this.#now;
  }

  schedule(delayMs: number, callback: () => void): SchedulerTimer {
    const id = (this.#sequence += 1);
    this.#timers.set(id, { id, dueAt: this.#now + Math.max(0, delayMs), callback });
    return {
      cancel: () => {
        this.#timers.delete(id);
      },
    };
  }

  get liveTimerCount(): number {
    return this.#timers.size;
  }

  nextDueAt(): number | null {
    let earliest: number | null = null;
    for (const timer of this.#timers.values()) {
      if (earliest === null || timer.dueAt < earliest) earliest = timer.dueAt;
    }
    return earliest;
  }

  setNow(value: number): void {
    if (value < this.#now) throw new Error("a monotonic clock cannot move backwards");
    this.#now = value;
  }

  /** Fires every timer already due, in (dueAt, creation) order. */
  runDue(): number {
    let fired = 0;
    for (;;) {
      const due = [...this.#timers.values()]
        .filter((timer) => timer.dueAt <= this.#now)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!due) return fired;
      this.#timers.delete(due.id);
      due.callback();
      fired += 1;
      if (fired > 10_000) throw new Error("fake clock fired a timer storm");
    }
  }
}

async function flushMicrotasks(depth = 12): Promise<void> {
  for (let index = 0; index < depth; index += 1) await Promise.resolve();
}

/**
 * Virtual time: steps to each timer's due reading in order, flushing
 * microtasks between steps so a `tick()` that settles between two polls is
 * observed exactly where it would be in real time. No real waiting occurs.
 */
async function advance(clock: FakeSchedulerClock, ms: number): Promise<void> {
  const target = clock.monotonicNow() + ms;
  for (let step = 0; ; step += 1) {
    if (step > 5_000) throw new Error("fake clock made no progress toward the target reading");
    await flushMicrotasks();
    const next = clock.nextDueAt();
    if (next === null || next > target) break;
    clock.setNow(Math.max(clock.monotonicNow(), next));
    clock.runDue();
  }
  clock.setNow(target);
  await flushMicrotasks();
  clock.runDue();
  await flushMicrotasks();
}

/** Runs everything already due without moving the clock. */
async function drain(clock: FakeSchedulerClock): Promise<void> {
  await advance(clock, 0);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function claimIdentity(index: number) {
  return {
    moduleJobId: `module-job-${index}`,
    claimToken: `claim-${index}`,
    runId: `run-${index}`,
    attempt: index,
    moduleGenerationId: "generation-1",
  } as const;
}

function committedResult(index: number): ReactiveModuleTickResult {
  const identity = claimIdentity(index);
  const record: ModuleResultCommitRecord = {
    schemaVersion: "dolly.module-result-commit/1",
    ...identity,
    resultDigest: `sha256:${"0".repeat(64)}`,
    state: "committed",
    revision: 1,
    source: { kind: "module", id: "producer" },
    outputPageIds: ["middle"],
    outputDeliveries: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...identity, status: "committed", recovered: false, record };
}

function retryResult(index: number): ReactiveModuleTickResult {
  return {
    ...claimIdentity(index),
    status: "retry-scheduled",
    failure: { code: "MODULE_FAILED", retryable: true },
  };
}

function outputBackpressuredResult(index: number): ReactiveModuleTickResult {
  return {
    ...claimIdentity(index),
    status: "output-backpressured",
    stage: "output-commit",
    blockedConsumerIds: ["sink"],
  };
}

/**
 * A Module runtime stand-in that records how many ticks were ever in flight at
 * once. The serialization invariant of Section 9.1 is checked against
 * `maxConcurrent`, not against the scheduler's own bookkeeping.
 */
class FakeModuleRuntime implements SchedulableModuleRuntime {
  moduleGenerationId = "generation-1";
  tickCount = 0;
  concurrent = 0;
  maxConcurrent = 0;
  readonly waiting: Array<ReturnType<typeof deferred<ReactiveModuleTickResult>>> = [];
  readonly receivedClaimLimits: ReactiveModuleClaimLimits[] = [];
  #auto: ((tickCount: number) => ReactiveModuleTickResult) | null;

  constructor(auto?: (tickCount: number) => ReactiveModuleTickResult) {
    this.#auto = auto ?? null;
  }

  tick(limits?: ReactiveModuleClaimLimits): Promise<ReactiveModuleTickResult> {
    if (limits !== undefined) this.receivedClaimLimits.push({ ...limits });
    this.tickCount += 1;
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    const release = <T>(promise: Promise<T>): Promise<T> =>
      promise.finally(() => {
        this.concurrent -= 1;
      });
    if (this.#auto) return release(Promise.resolve(this.#auto(this.tickCount)));
    const gate = deferred<ReactiveModuleTickResult>();
    this.waiting.push(gate);
    return release(gate.promise);
  }

  settle(result: ReactiveModuleTickResult): void {
    const gate = this.waiting.shift();
    if (!gate) throw new Error("no tick is waiting");
    gate.resolve(result);
  }

  fail(error: unknown): void {
    const gate = this.waiting.shift();
    if (!gate) throw new Error("no tick is waiting");
    gate.reject(error);
  }
}

class FakeMailboxes implements SchedulerPendingReader {
  readonly #state = new Map<string, SchedulerPendingSnapshot>();
  readonly reads: Array<{ consumerId: string; pageIds: readonly string[] }> = [];
  readonly failing = new Set<string>();

  set(consumerId: string, pendingCount: number, pendingBytes: number): void {
    this.#state.set(consumerId, { pendingCount, pendingBytes });
  }

  inspectPending(consumerId: string, pageIds: readonly string[]): SchedulerPendingSnapshot {
    this.reads.push({ consumerId, pageIds: [...pageIds] });
    if (this.failing.has(consumerId)) throw new Error(`pending state unavailable for ${consumerId}`);
    return this.#state.get(consumerId) ?? { pendingCount: 0, pendingBytes: 0 };
  }
}

interface HarnessOptions extends Partial<ModuleSchedulerOptions> {
  readonly mailboxes?: FakeMailboxes;
}

function createScheduler(options: HarnessOptions = {}) {
  const clock = new FakeSchedulerClock();
  const mailboxes = options.mailboxes ?? new FakeMailboxes();
  const events: SchedulerEvent[] = [];
  const scheduler = new ModuleScheduler({
    instanceId: "instance-1",
    deliveries: mailboxes,
    clock,
    pollIntervalMs: 100,
    retryBaseMs: 250,
    retryMaxMs: 2_000,
    maxConcurrentModules: 4,
    backpressureAction: "pause-upstream",
    downstreamRecheckMs: 50,
    noProgressAfterMs: 1_000,
    claimLimitCount: 8,
    claimLimitBytes: 4_096,
    retryJitterRatio: 0,
    onEvent: (event) => {
      events.push(event);
    },
    ...options,
  });
  return { clock, mailboxes, events, scheduler };
}

function eventTypes(events: readonly SchedulerEvent[], moduleId?: string): string[] {
  return events
    .filter((event) => moduleId === undefined || (event as { moduleId?: string }).moduleId === moduleId)
    .map((event) => event.type);
}

describe("CORE scheduler run loop serialization", () => {
  it("wakes from persisted Delivery changes and coalesces an arrival burst", async () => {
    let blockId = 0;
    let deliveryId = 0;
    const blocks = new BlockStore({
      nextBlockId: () => `wake-block-${++blockId}`,
      now: () => NOW,
    });
    const deliveries = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => `${kind}-wake-${++deliveryId}`,
      now: () => NOW,
    });
    deliveries.createPage("input");
    deliveries.registerConsumer("input", "worker", "from-now");

    const clock = new FakeSchedulerClock();
    const runtime = new FakeModuleRuntime(() => ({ status: "idle" }));
    const scheduler = new ModuleScheduler({
      instanceId: "instance-1",
      deliveries,
      clock,
      pollIntervalMs: 60_000,
      retryBaseMs: 250,
      retryMaxMs: 2_000,
      maxConcurrentModules: 1,
      backpressureAction: "pause-upstream",
      downstreamRecheckMs: 50,
      noProgressAfterMs: 1_000,
      claimLimitCount: 8,
      claimLimitBytes: 4_096,
      retryJitterRatio: 0,
    });
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await drain(clock);
    expect(runtime.tickCount).toBe(0);

    for (const text of ["one", "two", "three"]) {
      const block = blocks.commit(
        { payload: { schema: "test.content/1", value: { text } } },
        { kind: "external", id: "console" },
      );
      deliveries.append("input", block.id);
    }
    await drain(clock);

    expect(clock.monotonicNow()).toBe(0);
    expect(runtime.tickCount).toBe(1);
    await scheduler.stop();
    expect(clock.liveTimerCount).toBe(0);

    const afterStop = blocks.commit(
      { payload: { schema: "test.content/1", value: { text: "after-stop" } } },
      { kind: "external", id: "console" },
    );
    deliveries.append("input", afterStop.id);
    expect(clock.liveTimerCount).toBe(0);
  });

  it("drives one tick for a Module with pending input and never overlaps it", async () => {
    const { clock, mailboxes, scheduler, events } = createScheduler();
    const runtime = new FakeModuleRuntime();
    mailboxes.set("worker", 3, 300);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await drain(clock);

    expect(runtime.tickCount).toBe(1);

    // Rapid triggers: many wakes plus many poll intervals while the run is in
    // flight (Section 18.3, rapid triggers cannot overlap one Module).
    for (let index = 0; index < 20; index += 1) {
      scheduler.wake();
      await advance(clock, 100);
    }

    expect(runtime.tickCount).toBe(1);
    expect(runtime.maxConcurrent).toBe(1);
    expect(scheduler.status("worker").schedulingState).toBe("running");
    expect(eventTypes(events).filter((type) => type === "scheduler.dispatched")).toHaveLength(1);

    runtime.settle(committedResult(1));
    await drain(clock);

    expect(runtime.tickCount).toBe(2);
    expect(runtime.maxConcurrent).toBe(1);

    runtime.settle({ status: "idle" });
    await drain(clock);
    await scheduler.stop();
  });

  it("does not dispatch a Module with an empty mailbox", async () => {
    const { clock, mailboxes, scheduler } = createScheduler();
    const runtime = new FakeModuleRuntime();
    mailboxes.set("worker", 0, 0);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 10, maxPendingBytes: 1_000 },
    });
    scheduler.start();
    await advance(clock, 500);

    expect(runtime.tickCount).toBe(0);
    expect(scheduler.status("worker").lastDecisionReasonCode).toBe("NO_PENDING_INPUT");

    mailboxes.set("worker", 1, 10);
    await advance(clock, 100);

    expect(runtime.tickCount).toBe(1);

    runtime.settle({ status: "idle" });
    await drain(clock);
    await scheduler.stop();
  });

  it("runs different Modules concurrently only up to the instance-wide cap", async () => {
    const { clock, mailboxes, scheduler } = createScheduler({ maxConcurrentModules: 2 });
    const runtimes = ["a", "b", "c"].map(() => new FakeModuleRuntime());
    ["a", "b", "c"].forEach((moduleId, index) => {
      mailboxes.set(moduleId, 5, 500);
      scheduler.register({
        moduleId,
        runtime: runtimes[index]!,
        inputPageIds: [`page-${moduleId}`],
        outputPageIds: [],
        mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
      });
    });
    scheduler.start();
    await drain(clock);

    const dispatched = runtimes.filter((runtime) => runtime.tickCount === 1);
    expect(dispatched).toHaveLength(2);
    expect(scheduler.instanceStatus().activeModules).toBe(2);
    const deferredRuntime = runtimes.find((runtime) => runtime.tickCount === 0)!;
    expect(deferredRuntime.tickCount).toBe(0);

    dispatched[0]!.settle({ status: "idle" });
    await advance(clock, 100);

    expect(deferredRuntime.tickCount).toBe(1);
    expect(scheduler.instanceStatus().activeModules).toBe(2);
    for (const runtime of runtimes) expect(runtime.maxConcurrent).toBeLessThanOrEqual(1);

    for (const runtime of runtimes) {
      while (runtime.waiting.length > 0) runtime.settle({ status: "idle" });
    }
    await drain(clock);
    await scheduler.stop();
  });

  it("rotates dispatch order so a concurrency cap cannot starve one Module", async () => {
    const { clock, mailboxes, scheduler } = createScheduler({ maxConcurrentModules: 1 });
    const runtimes = new Map<string, FakeModuleRuntime>();
    for (const moduleId of ["a", "b", "c"]) {
      const runtime = new FakeModuleRuntime(() => ({ status: "idle" }));
      runtimes.set(moduleId, runtime);
      mailboxes.set(moduleId, 5, 500);
      scheduler.register({
        moduleId,
        runtime,
        inputPageIds: [`page-${moduleId}`],
        outputPageIds: [],
        mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
      });
    }
    scheduler.start();
    await drain(clock);
    await advance(clock, 300);

    for (const [moduleId, runtime] of runtimes) {
      expect(`${moduleId}:${runtime.tickCount > 0}`).toBe(`${moduleId}:true`);
    }
    await scheduler.stop();
  });
});

describe("CORE scheduler bounded mailboxes and backpressure", () => {
  function fanOut(options: HarnessOptions = {}) {
    const harness = createScheduler(options);
    const producer = new FakeModuleRuntime(() => ({ status: "idle" }));
    const left = new FakeModuleRuntime(() => ({ status: "idle" }));
    const right = new FakeModuleRuntime(() => ({ status: "idle" }));
    harness.mailboxes.set("producer", 4, 400);
    harness.mailboxes.set("left", 0, 0);
    harness.mailboxes.set("right", 0, 0);
    return { ...harness, producer, left, right };
  }

  function registerFanOut(
    harness: ReturnType<typeof fanOut>,
    order: readonly ("producer" | "left" | "right")[],
  ) {
    const registrations = {
      producer: {
        moduleId: "producer",
        runtime: harness.producer,
        inputPageIds: ["source"],
        outputPageIds: ["shared"],
        mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
      },
      left: {
        moduleId: "left",
        runtime: harness.left,
        inputPageIds: ["shared"],
        outputPageIds: [],
        mailbox: { maxPendingCount: 2, maxPendingBytes: 1_000 },
      },
      right: {
        moduleId: "right",
        runtime: harness.right,
        inputPageIds: ["shared"],
        outputPageIds: [],
        mailbox: { maxPendingCount: 2, maxPendingBytes: 1_000 },
      },
    } as const;
    for (const moduleId of order) harness.scheduler.register(registrations[moduleId]);
  }

  it("resumes a one-slot mailbox after it drains below a fractional low watermark", async () => {
    const { clock, mailboxes, scheduler } = createScheduler({ lowWatermarkRatio: 0.5 });
    mailboxes.set("worker", 1, 10);
    scheduler.register({
      moduleId: "worker",
      runtime: new FakeModuleRuntime(() => ({ status: "idle" })),
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 1, maxPendingBytes: 100 },
    });
    scheduler.start();
    await drain(clock);
    expect(scheduler.status("worker").mailboxFull).toBe(true);

    mailboxes.set("worker", 0, 0);
    await advance(clock, 100);
    expect(scheduler.status("worker").mailboxFull).toBe(false);
    await scheduler.stop();
  });

  it("pauses an upstream Module while a downstream mailbox is at its bound and resumes after it drains", async () => {
    const harness = fanOut();
    registerFanOut(harness, ["producer", "left", "right"]);
    harness.scheduler.start();
    await drain(harness.clock);

    expect(harness.producer.tickCount).toBe(1);

    harness.mailboxes.set("left", 2, 20);
    await advance(harness.clock, 100);

    const blocked = harness.scheduler.status("producer");
    expect(blocked.backpressured).toBe(true);
    expect(blocked.blockingDownstreamIds).toEqual(["left"]);
    expect(blocked.backpressureAction).toBe("pause-upstream");
    expect(blocked.lastDecisionReasonCode).toBe("DOWNSTREAM_BACKPRESSURE");
    expect(eventTypes(harness.events, "producer")).toContain("scheduler.backpressure_entered");

    const ticksWhileBlocked = harness.producer.tickCount;
    await advance(harness.clock, 1_000);
    expect(harness.producer.tickCount).toBe(ticksWhileBlocked);

    harness.mailboxes.set("left", 1, 10);
    await advance(harness.clock, 100);

    expect(harness.scheduler.status("producer").backpressured).toBe(false);
    expect(eventTypes(harness.events, "producer")).toContain("scheduler.backpressure_exited");
    expect(harness.producer.tickCount).toBeGreaterThan(ticksWhileBlocked);
    await harness.scheduler.stop();
  });

  it("measures each consumer separately in count and in bytes", async () => {
    const harness = fanOut();
    registerFanOut(harness, ["producer", "left", "right"]);
    harness.scheduler.start();
    await drain(harness.clock);

    // `left` is at its byte bound but under its count bound; `right` is the
    // mirror image. Either alone must block the shared producer.
    harness.mailboxes.set("left", 1, 1_000);
    harness.mailboxes.set("right", 0, 0);
    await advance(harness.clock, 100);
    expect(harness.scheduler.status("producer").blockingDownstreamIds).toEqual(["left"]);
    expect(harness.scheduler.status("left").pendingBytes).toBe(1_000);
    expect(harness.scheduler.status("left").pendingCount).toBe(1);

    harness.mailboxes.set("left", 0, 0);
    harness.mailboxes.set("right", 2, 5);
    await advance(harness.clock, 100);
    expect(harness.scheduler.status("producer").blockingDownstreamIds).toEqual(["right"]);
    expect(harness.scheduler.status("right").pendingCount).toBe(2);
    expect(harness.scheduler.status("right").pendingBytes).toBe(5);

    // Every consumer is inspected under its own identity and Page set.
    expect(harness.mailboxes.reads.some((read) => read.consumerId === "left")).toBe(true);
    expect(harness.mailboxes.reads.some((read) => read.consumerId === "right")).toBe(true);
    expect(
      harness.mailboxes.reads
        .filter((read) => read.consumerId === "producer")
        .every((read) => read.pageIds.join() === "source"),
    ).toBe(true);
    await harness.scheduler.stop();
  });

  it("aggregates fan-out pressure independently of registration order", async () => {
    const forward = fanOut();
    registerFanOut(forward, ["producer", "left", "right"]);
    const reverse = fanOut();
    registerFanOut(reverse, ["right", "left", "producer"]);

    for (const harness of [forward, reverse]) {
      harness.scheduler.start();
      await drain(harness.clock);
      harness.mailboxes.set("left", 2, 20);
      harness.mailboxes.set("right", 2, 20);
      await advance(harness.clock, 100);
    }

    expect(forward.scheduler.status("producer").blockingDownstreamIds).toEqual(["left", "right"]);
    expect(reverse.scheduler.status("producer").blockingDownstreamIds).toEqual(["left", "right"]);
    expect(reverse.scheduler.status("producer").backpressured).toBe(
      forward.scheduler.status("producer").backpressured,
    );
    await forward.scheduler.stop();
    await reverse.scheduler.stop();
  });

  it("counts every refused run when the configured action is reject-upstream-run", async () => {
    const harness = fanOut({ backpressureAction: "reject-upstream-run" });
    registerFanOut(harness, ["producer", "left", "right"]);
    harness.scheduler.start();
    await drain(harness.clock);
    harness.mailboxes.set("left", 5, 50);

    await advance(harness.clock, 100);
    const first = harness.scheduler.status("producer").counters.backpressureRejected;
    await advance(harness.clock, 100);
    const second = harness.scheduler.status("producer").counters.backpressureRejected;

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first + 1);
    const rejections = harness.events.filter(
      (event) => event.type === "scheduler.backpressure_rejected",
    );
    expect(rejections).toHaveLength(second);
    expect(rejections[0]).toMatchObject({
      moduleId: "producer",
      action: "reject-upstream-run",
      blockedBy: ["left"],
    });
    await harness.scheduler.stop();
  });

  it("defers re-evaluation by downstreamRecheckMs when the configured action is delay-upstream", async () => {
    const harness = fanOut({ backpressureAction: "delay-upstream", downstreamRecheckMs: 500 });
    registerFanOut(harness, ["producer", "left", "right"]);
    harness.scheduler.start();
    await drain(harness.clock);
    harness.mailboxes.set("left", 5, 50);
    await advance(harness.clock, 100);

    const blockedAt = harness.scheduler.status("producer");
    expect(blockedAt.nextEligibleAt).toBe(harness.clock.monotonicNow() + 500);

    // Capacity returns immediately, but the deferral is honoured.
    harness.mailboxes.set("left", 0, 0);
    const ticksBefore = harness.producer.tickCount;
    await advance(harness.clock, 400);
    expect(harness.producer.tickCount).toBe(ticksBefore);

    await advance(harness.clock, 200);
    expect(harness.producer.tickCount).toBeGreaterThan(ticksBefore);
    await harness.scheduler.stop();
  });

  it("does not treat a self-loop Module as its own backpressure source", async () => {
    const { clock, mailboxes, scheduler } = createScheduler();
    const runtime = new FakeModuleRuntime(() => ({ status: "idle" }));
    mailboxes.set("loop", 9, 900);
    scheduler.register({
      moduleId: "loop",
      runtime,
      inputPageIds: ["shared"],
      outputPageIds: ["shared"],
      mailbox: { maxPendingCount: 2, maxPendingBytes: 20 },
    });
    scheduler.start();
    await drain(clock);

    // Its own mailbox is over the bound, but it is the only consumer that can
    // drain it, so blocking it would guarantee no progress.
    expect(scheduler.status("loop").mailboxFull).toBe(true);
    expect(scheduler.status("loop").backpressured).toBe(false);
    expect(runtime.tickCount).toBeGreaterThan(0);
    await scheduler.stop();
  });

  it("treats an unreadable mailbox as unknown capacity instead of as free capacity", async () => {
    const harness = fanOut();
    registerFanOut(harness, ["producer", "left", "right"]);
    harness.scheduler.start();
    await drain(harness.clock);
    const before = harness.producer.tickCount;

    harness.mailboxes.failing.add("left");
    await advance(harness.clock, 100);

    expect(harness.scheduler.status("left").pendingStateAvailable).toBe(false);
    expect(harness.scheduler.status("producer").blockingDownstreamIds).toEqual(["left"]);
    expect(harness.producer.tickCount).toBe(before);
    expect(harness.scheduler.instanceStatus().invariantViolationCount).toBeGreaterThan(0);
    expect(eventTypes(harness.events, "left")).toContain("scheduler.pending_unavailable");
    await harness.scheduler.stop();
  });

  it("detects a sustained no-progress state and exposes the blocked dependency cycle", async () => {
    const { clock, mailboxes, scheduler, events } = createScheduler({ noProgressAfterMs: 1_000 });
    for (const [moduleId, input, output] of [
      ["alpha", "page-a", "page-b"],
      ["beta", "page-b", "page-a"],
    ] as const) {
      mailboxes.set(moduleId, 4, 400);
      scheduler.register({
        moduleId,
        runtime: new FakeModuleRuntime(() => ({ status: "idle" })),
        inputPageIds: [input],
        outputPageIds: [output],
        mailbox: { maxPendingCount: 2, maxPendingBytes: 200 },
      });
    }
    scheduler.start();
    await advance(clock, 500);

    expect(scheduler.instanceStatus().noProgressActive).toBe(false);

    await advance(clock, 1_000);

    const stalls = events.filter((event) => event.type === "scheduler.no_progress");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({
      blockedEdges: [
        { moduleId: "alpha", blockedBy: ["beta"] },
        { moduleId: "beta", blockedBy: ["alpha"] },
      ],
    });
    expect(scheduler.instanceStatus().noProgressActive).toBe(true);

    // The episode is reported once, not once per poll.
    await advance(clock, 2_000);
    expect(events.filter((event) => event.type === "scheduler.no_progress")).toHaveLength(1);
    await scheduler.stop();
  });
});

describe("CORE scheduler policy boundary", () => {
  const rogueDecision: SchedulerDecision = {
    eligible: true,
    eligibleAt: 0,
    claimLimitCount: 1_000,
    claimLimitBytes: 1_000_000,
    reasonCode: "ALWAYS_RUN",
    policyName: "rogue",
    policyVersion: "0",
  };

  it("uses the fixed baseline policy when no policy is selected", async () => {
    const { clock, mailboxes, scheduler } = createScheduler();
    mailboxes.set("worker", 2, 20);
    scheduler.register({
      moduleId: "worker",
      runtime: new FakeModuleRuntime(() => ({ status: "idle" })),
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 10, maxPendingBytes: 1_000 },
    });
    scheduler.start();
    await drain(clock);

    expect(scheduler.status("worker").policyName).toBe("fixed-baseline");
    expect(scheduler.status("worker").policyVersion).toBe("1");
    expect(scheduler.instanceStatus().policyName).toBe("fixed-baseline");
    await scheduler.stop();
  });

  it("passes the policy-selected Claim limits to the Module runtime", async () => {
    const policy: SchedulerPolicy = {
      decide: () => ({
        eligible: true,
        eligibleAt: 0,
        claimLimitCount: 2,
        claimLimitBytes: 200,
        reasonCode: "SMALL_BATCH",
        policyName: "small-batch",
        policyVersion: "1",
      }),
    };
    const { clock, mailboxes, scheduler } = createScheduler({ policy });
    const runtime = new FakeModuleRuntime(() => ({ status: "idle" }));
    mailboxes.set("worker", 5, 500);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });

    scheduler.start();
    await drain(clock);

    expect(runtime.receivedClaimLimits).toEqual([{
      claimLimitCount: 2,
      claimLimitBytes: 200,
    }]);
    await scheduler.stop();
  });

  it("refuses a policy decision that would bypass a downstream mailbox bound", async () => {
    const policy: SchedulerPolicy = { decide: () => rogueDecision };
    const { clock, mailboxes, scheduler } = createScheduler({ policy });
    const producer = new FakeModuleRuntime(() => ({ status: "idle" }));
    mailboxes.set("producer", 5, 500);
    mailboxes.set("consumer", 9, 900);
    scheduler.register({
      moduleId: "producer",
      runtime: producer,
      inputPageIds: ["source"],
      outputPageIds: ["shared"],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.register({
      moduleId: "consumer",
      runtime: new FakeModuleRuntime(() => ({ status: "idle" })),
      inputPageIds: ["shared"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 2, maxPendingBytes: 20 },
    });
    scheduler.start();
    await advance(clock, 400);

    expect(producer.tickCount).toBe(0);
    expect(scheduler.status("producer").lastDecisionReasonCode).toBe("DOWNSTREAM_BACKPRESSURE");
    await scheduler.stop();
  });

  it("cannot start a second run for a busy actor even when the policy always says eligible", async () => {
    const policy: SchedulerPolicy = { decide: () => rogueDecision };
    const { clock, mailboxes, scheduler } = createScheduler({ policy });
    const runtime = new FakeModuleRuntime();
    mailboxes.set("worker", 5, 500);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await advance(clock, 1_000);

    expect(runtime.tickCount).toBe(1);
    expect(runtime.maxConcurrent).toBe(1);

    runtime.settle({ status: "idle" });
    await drain(clock);
    await scheduler.stop();
  });

  it("falls back to the declared safe policy when the selected policy crashes", async () => {
    const decide = vi.fn(() => {
      throw new Error("policy exploded");
    });
    const { clock, mailboxes, scheduler, events } = createScheduler({ policy: { decide } });
    const runtime = new FakeModuleRuntime(() => ({ status: "idle" }));
    mailboxes.set("worker", 3, 300);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await drain(clock);

    expect(decide).toHaveBeenCalled();
    expect(runtime.tickCount).toBe(1);
    expect(runtime.maxConcurrent).toBe(1);
    expect(scheduler.status("worker").policyName).toBe("fixed-baseline");
    expect(scheduler.status("worker").counters.policyFailures).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === "scheduler.policy_failed")[0]).toMatchObject({
      moduleId: "worker",
      action: "fallback-baseline",
      errorMessage: "policy exploded",
    });
    await scheduler.stop();
  });

  it("quarantines instead of dispatching when a crashing policy is configured to fail visibly", async () => {
    const { clock, mailboxes, scheduler } = createScheduler({
      policy: {
        decide: () => {
          throw new Error("policy exploded");
        },
      },
      onPolicyFailure: "quarantine",
    });
    const runtime = new FakeModuleRuntime(() => ({ status: "idle" }));
    mailboxes.set("worker", 3, 300);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await advance(clock, 1_000);

    expect(runtime.tickCount).toBe(0);
    expect(scheduler.status("worker").schedulingState).toBe("quarantined");
    expect(scheduler.status("worker").quarantineReason).toBe("SCHEDULER_POLICY_FAILED");
    await scheduler.stop();
  });

  it("rejects a policy decision that is not a well-formed decision record", async () => {
    const { clock, mailboxes, scheduler } = createScheduler({
      policy: { decide: () => ({ reasonCode: "BROKEN" }) as unknown as SchedulerDecision },
      onPolicyFailure: "quarantine",
    });
    const runtime = new FakeModuleRuntime(() => ({ status: "idle" }));
    mailboxes.set("worker", 3, 300);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await advance(clock, 300);

    expect(runtime.tickCount).toBe(0);
    expect(scheduler.status("worker").quarantineReason).toBe("SCHEDULER_POLICY_FAILED");
    await scheduler.stop();
  });

  it("passes a Section 13.2 snapshot with per-consumer downstream pressure to the policy", async () => {
    const seen: SchedulerSnapshot[] = [];
    const policy: SchedulerPolicy = {
      decide: (snapshot) => {
        seen.push(snapshot);
        return {
          eligible: false,
          eligibleAt: null,
          claimLimitCount: 4,
          claimLimitBytes: 400,
          reasonCode: "OBSERVED",
          policyName: "observer",
          policyVersion: "9",
        };
      },
    };
    const { clock, mailboxes, scheduler } = createScheduler({ policy });
    mailboxes.set("producer", 3, 333);
    mailboxes.set("consumer", 1, 111);
    scheduler.register({
      moduleId: "producer",
      runtime: new FakeModuleRuntime(() => ({ status: "idle" })),
      inputPageIds: ["source"],
      outputPageIds: ["shared"],
      mailbox: { maxPendingCount: 50, maxPendingBytes: 5_000 },
    });
    scheduler.register({
      moduleId: "consumer",
      runtime: new FakeModuleRuntime(() => ({ status: "idle" })),
      inputPageIds: ["shared"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 7, maxPendingBytes: 700 },
    });
    scheduler.start();
    await drain(clock);

    const producerSnapshot = seen.find((snapshot) => snapshot.moduleId === "producer")!;
    expect(producerSnapshot).toMatchObject({
      activationMode: "reactive",
      actorBusy: false,
      pendingCount: 3,
      pendingBytes: 333,
      retryCount: 0,
      downstream: [
        {
          moduleId: "consumer",
          availability: "available",
          pendingCount: 1,
          pendingBytes: 111,
          maxPendingCount: 7,
          maxPendingBytes: 700,
        },
      ],
    });
    expect(scheduler.status("producer").policyName).toBe("observer");
    expect(scheduler.status("producer").policyVersion).toBe("9");
    await scheduler.stop();
  });
});

describe("CORE scheduler retry backoff", () => {
  it("applies bounded exponential backoff and dispatches only at the deadline", async () => {
    const { clock, mailboxes, scheduler, events } = createScheduler({
      retryBaseMs: 250,
      retryMaxMs: 1_000,
      retryJitterRatio: 0,
    });
    const runtime = new FakeModuleRuntime((tickCount) => retryResult(tickCount));
    mailboxes.set("worker", 4, 400);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await drain(clock);

    expect(runtime.tickCount).toBe(1);
    expect(scheduler.status("worker").retryCount).toBe(1);
    expect(scheduler.status("worker").schedulingState).toBe("retry-backoff");

    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = runtime.tickCount;
      const deadline = scheduler.status("worker").nextEligibleAt!;
      delays.push(scheduler.status("worker").retryDelayMs);
      await advance(clock, deadline - clock.monotonicNow() - 1);
      expect(runtime.tickCount).toBe(before);
      await advance(clock, 101);
      expect(runtime.tickCount).toBe(before + 1);
    }

    expect(delays).toEqual([250, 500, 1_000, 1_000, 1_000]);
    const retries = events.filter((event) => event.type === "scheduler.retry_scheduled");
    expect(retries[0]).toMatchObject({ retryCount: 1, retryDelayMs: 250, retryJitterMs: 0 });
    await scheduler.stop();
  });

  it("resumes an output commit on the first pass after backoff even when no input remains", async () => {
    const { clock, mailboxes, scheduler } = createScheduler({
      retryBaseMs: 250,
      retryMaxMs: 1_000,
      retryJitterRatio: 0,
    });
    const runtime = new FakeModuleRuntime((tickCount) =>
      tickCount === 1 ? outputBackpressuredResult(1) : committedResult(1),
    );
    mailboxes.set("worker", 1, 100);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: ["output"],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await drain(clock);

    expect(runtime.tickCount).toBe(1);
    expect(scheduler.status("worker")).toMatchObject({
      schedulingState: "backpressured",
      retryCount: 1,
      lastTickStatus: "output-backpressured",
      counters: { outputBackpressured: 1 },
    });

    // The original input is already held by the exact Claim, so the normal
    // pending queue is empty. Recovery must still resume the prepared commit.
    mailboxes.set("worker", 0, 0);
    await advance(clock, 249);
    expect(runtime.tickCount).toBe(1);
    // The retry deadline is a lower bound. The fixed baseline observes it on
    // the next poll (300 ms here); no dedicated per-Module retry timer exists.
    await advance(clock, 50);
    expect(runtime.tickCount).toBe(1);
    await advance(clock, 1);

    expect(runtime.tickCount).toBe(2);
    expect(scheduler.status("worker")).toMatchObject({
      lastTickStatus: "committed",
      retryCount: 0,
      counters: { committed: 1, outputBackpressured: 1 },
    });
    await scheduler.stop();
  });

  it("adds bounded jitter from the injected random source", async () => {
    const samples = [0, 1, 0.5];
    let index = 0;
    const { clock, mailboxes, scheduler } = createScheduler({
      retryBaseMs: 1_000,
      retryMaxMs: 1_000,
      retryJitterRatio: 0.5,
      random: () => samples[index++ % samples.length]!,
    });
    const runtime = new FakeModuleRuntime((tickCount) => retryResult(tickCount));
    mailboxes.set("worker", 4, 400);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await drain(clock);

    const observed: number[] = [scheduler.status("worker").retryJitterMs];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const deadline = scheduler.status("worker").nextEligibleAt!;
      await advance(clock, deadline - clock.monotonicNow() + 100);
      observed.push(scheduler.status("worker").retryJitterMs);
    }

    expect(observed).toEqual([0, 500, 250]);
    await scheduler.stop();
  });

  it("clears retry state after a committed run", async () => {
    const { clock, mailboxes, scheduler } = createScheduler({ retryJitterRatio: 0 });
    // Tick 1 fails, tick 2 commits, and the mailbox is then empty: a fake
    // mailbox that stayed full forever would model a Module that can never
    // drain, not a retry that recovered.
    const runtime = new FakeModuleRuntime((tickCount) =>
      tickCount === 1
        ? retryResult(tickCount)
        : tickCount === 2
          ? committedResult(tickCount)
          : { status: "idle" },
    );
    mailboxes.set("worker", 4, 400);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await drain(clock);
    expect(scheduler.status("worker").retryCount).toBe(1);

    await advance(clock, 400);

    const status = scheduler.status("worker");
    expect(status.retryCount).toBe(0);
    expect(status.retryDelayMs).toBe(0);
    expect(status.nextEligibleAt).toBeNull();
    expect(status.lastSuccessAt).not.toBeNull();
    expect(status.counters.committed).toBeGreaterThan(0);
    await scheduler.stop();
  });

  it("quarantines a Module that reports an unknown outcome and never re-drives it", async () => {
    const { clock, mailboxes, scheduler, events } = createScheduler();
    const runtime = new FakeModuleRuntime(() => ({
      ...claimIdentity(1),
      status: "recovery-required",
      reason: "commit-outcome-unknown",
    }));
    mailboxes.set("worker", 4, 400);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await drain(clock);
    await advance(clock, 5_000);

    expect(runtime.tickCount).toBe(1);
    expect(scheduler.status("worker").schedulingState).toBe("quarantined");
    expect(scheduler.status("worker").quarantineReason).toBe(
      "RECOVERY_REQUIRED:commit-outcome-unknown",
    );
    expect(eventTypes(events, "worker")).toContain("scheduler.quarantined");

    scheduler.release("worker");
    await drain(clock);
    expect(runtime.tickCount).toBe(2);
    await scheduler.stop();
  });

  it("records a concurrent tick from another caller as an invariant violation", async () => {
    const { clock, mailboxes, scheduler, events } = createScheduler();
    const runtime = new FakeModuleRuntime();
    mailboxes.set("worker", 4, 400);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await drain(clock);

    runtime.fail(Object.assign(new Error("busy"), { code: "RUNTIME_BUSY" }));
    await drain(clock);

    expect(scheduler.instanceStatus().invariantViolationCount).toBe(1);
    expect(events.filter((event) => event.type === "scheduler.invariant_violation")[0]).toMatchObject(
      { moduleId: "worker", violation: "CONCURRENT_TICK_DETECTED" },
    );
    expect(scheduler.status("worker").retryCount).toBe(1);
    await scheduler.stop();
  });
});

describe("CORE scheduler stop", () => {
  it("waits for an in-flight tick and leaves no live timer", async () => {
    const { clock, mailboxes, scheduler } = createScheduler();
    const runtime = new FakeModuleRuntime();
    mailboxes.set("worker", 4, 400);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await drain(clock);
    expect(runtime.tickCount).toBe(1);

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await drain(clock);

    expect(stopped).toBe(false);
    expect(scheduler.state).toBe("stopping");

    runtime.settle(committedResult(1));
    await stopping;

    expect(stopped).toBe(true);
    expect(scheduler.state).toBe("stopped");
    expect(clock.liveTimerCount).toBe(0);

    await advance(clock, 10_000);
    expect(runtime.tickCount).toBe(1);
  });

  it("is idempotent and rejects registration after it stops", async () => {
    const { clock, scheduler } = createScheduler();
    scheduler.start();
    await drain(clock);

    const first = scheduler.stop();
    const second = scheduler.stop();
    expect(first).toBe(second);
    await first;

    expect(scheduler.state).toBe("stopped");
    expect(clock.liveTimerCount).toBe(0);
    expect(() =>
      scheduler.register({
        moduleId: "late",
        runtime: new FakeModuleRuntime(),
        inputPageIds: ["input"],
        outputPageIds: [],
        mailbox: { maxPendingCount: 1, maxPendingBytes: 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "SCHEDULER_STOPPED" }));
    expect(() => scheduler.start()).toThrowError(
      expect.objectContaining({ code: "SCHEDULER_STOPPED" }),
    );
  });

  it("does not leave a rejected tick unhandled while stopping", async () => {
    const { clock, mailboxes, scheduler } = createScheduler();
    const runtime = new FakeModuleRuntime();
    mailboxes.set("worker", 4, 400);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 100, maxPendingBytes: 100_000 },
    });
    scheduler.start();
    await drain(clock);

    const stopping = scheduler.stop();
    runtime.fail(Object.assign(new Error("stopping"), { code: "RUNTIME_STOPPING" }));
    await expect(stopping).resolves.toBeUndefined();
    expect(scheduler.status("worker").quarantineReason).toBe("RUNTIME_STOPPING");
  });
});

describe("CORE scheduler activation modes", () => {
  it("rejects empty periodic and source activation while their completion boundaries are unimplemented", () => {
    const { scheduler, events } = createScheduler();
    expect(() => scheduler.register({
      moduleId: "module-periodic-empty",
      runtime: new FakeModuleRuntime(),
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 1, maxPendingBytes: 1 },
      activation: { kind: "periodic", periodMs: 100, allowEmptyInput: true },
    })).toThrowError(expect.objectContaining({ code: "SCHEDULER_ACTIVATION_UNSUPPORTED" }));
    expect(() => scheduler.register({
      moduleId: "module-source",
      runtime: new FakeModuleRuntime(),
      inputPageIds: [],
      outputPageIds: [],
      mailbox: { maxPendingCount: 1, maxPendingBytes: 1 },
      activation: { kind: "source" },
    })).toThrowError(expect.objectContaining({ code: "SCHEDULER_ACTIVATION_UNSUPPORTED" }));
    expect(events.filter((event) => event.type === "scheduler.activation_rejected")).toHaveLength(2);
  });

  it("drives non-empty periodic input start-to-start and never before its period", async () => {
    const { clock, mailboxes, scheduler } = createScheduler();
    const runtime = new FakeModuleRuntime();
    mailboxes.set("periodic", 1, 10);
    scheduler.register({
      moduleId: "periodic",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 10, maxPendingBytes: 1_000 },
      activation: { kind: "periodic", periodMs: 2_000, allowEmptyInput: false },
    });
    scheduler.start();
    await drain(clock);
    expect(runtime.tickCount).toBe(1);

    runtime.settle(committedResult(1));
    await drain(clock);
    await advance(clock, 1_500);
    expect(runtime.tickCount).toBe(1);
    expect(scheduler.instanceStatus().noProgressActive).toBe(false);

    await advance(clock, 500);
    expect(runtime.tickCount).toBe(2);
    expect(runtime.maxConcurrent).toBe(1);
    expect(scheduler.status("periodic")).toMatchObject({
      activationMode: "periodic",
      periodMs: 2_000,
      allowEmptyPeriodicInput: false,
    });
    runtime.settle({ status: "idle" });
    await drain(clock);
    await scheduler.stop();
  });

  it("counts an overrun once and does not launch a missed-period catch-up burst", async () => {
    const { clock, mailboxes, scheduler } = createScheduler();
    const runtime = new FakeModuleRuntime();
    mailboxes.set("periodic", 1, 10);
    scheduler.register({
      moduleId: "periodic",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 10, maxPendingBytes: 1_000 },
      activation: { kind: "periodic", periodMs: 100, allowEmptyInput: false },
    });
    scheduler.start();
    await drain(clock);
    expect(runtime.tickCount).toBe(1);

    await advance(clock, 350);
    expect(runtime.tickCount).toBe(1);
    runtime.settle(committedResult(1));
    await drain(clock);

    expect(runtime.tickCount).toBe(2);
    expect(runtime.maxConcurrent).toBe(1);
    expect(scheduler.status("periodic").counters.missedPeriods).toBe(2);
    await advance(clock, 500);
    expect(runtime.tickCount).toBe(2);
    runtime.settle({ status: "idle" });
    await drain(clock);
    await scheduler.stop();
  });

  it("computes start-to-start periodic timing from the monotonic clock (OWNER-CORE-006)", () => {
    expect(periodicEligibility({ lastRunStartedAt: 1_000, periodMs: 100, monotonicNow: 1_000 })).toEqual(
      { eligibleAt: 1_100, waitMs: 100, missedPeriods: 0 },
    );
    // A run that took 40 ms of a 100 ms period waits the remaining 60 ms.
    expect(periodicEligibility({ lastRunStartedAt: 1_000, periodMs: 100, monotonicNow: 1_040 })).toEqual(
      { eligibleAt: 1_100, waitMs: 60, missedPeriods: 0 },
    );
    // An overrun waits zero: max(period - elapsed, 0).
    expect(periodicEligibility({ lastRunStartedAt: 1_000, periodMs: 100, monotonicNow: 1_250 })).toEqual(
      { eligibleAt: 1_100, waitMs: 0, missedPeriods: 1 },
    );
  });

  it("counts a long overrun without producing a catch-up burst", () => {
    const overrun = periodicEligibility({
      lastRunStartedAt: 0,
      periodMs: 100,
      monotonicNow: 1_050,
    });

    // Ten periods elapsed, and exactly one eligibility is produced for them.
    expect(overrun.missedPeriods).toBe(9);
    expect(overrun.eligibleAt).toBe(100);
    expect(overrun.waitMs).toBe(0);

    // The next start time is measured from the next run's start, so the
    // schedule never tries to replay the missed periods.
    const next = periodicEligibility({
      lastRunStartedAt: 1_050,
      periodMs: 100,
      monotonicNow: 1_050,
    });
    expect(next.eligibleAt).toBe(1_150);
    expect(next.missedPeriods).toBe(0);
  });

  it("rejects a periodic input that a monotonic clock cannot produce", () => {
    expect(() =>
      periodicEligibility({ lastRunStartedAt: 100, periodMs: 0, monotonicNow: 100 }),
    ).toThrowError(expect.objectContaining({ code: "SCHEDULER_CONFIGURATION_INVALID" }));
    expect(() =>
      periodicEligibility({ lastRunStartedAt: 100, periodMs: 10, monotonicNow: 90 }),
    ).toThrowError(expect.objectContaining({ code: "SCHEDULER_CONFIGURATION_INVALID" }));
  });
});

describe("CORE scheduler configuration and observability", () => {
  it("rejects a configuration without finite bounds", () => {
    const base: ModuleSchedulerOptions = {
      instanceId: "instance-1",
      deliveries: new FakeMailboxes(),
      clock: new FakeSchedulerClock(),
      pollIntervalMs: 100,
      retryBaseMs: 250,
      retryMaxMs: 1_000,
      maxConcurrentModules: 2,
      backpressureAction: "pause-upstream",
      downstreamRecheckMs: 50,
      noProgressAfterMs: 1_000,
      claimLimitCount: 8,
      claimLimitBytes: 4_096,
    };
    for (const override of [
      { pollIntervalMs: 0 },
      { maxConcurrentModules: 0 },
      { retryMaxMs: 100 },
      { retryJitterRatio: 1.5 },
      { lowWatermarkRatio: 0 },
      { instanceId: "not a valid id" },
    ]) {
      expect(() => new ModuleScheduler({ ...base, ...override })).toThrowError(
        expect.objectContaining({ code: "SCHEDULER_CONFIGURATION_INVALID" }),
      );
    }
    expect(() => new ModuleScheduler(base)).not.toThrow();
  });

  it("rejects a duplicate Module and an unknown Module lookup", () => {
    const { scheduler } = createScheduler();
    const registration = {
      moduleId: "worker",
      runtime: new FakeModuleRuntime(),
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 1, maxPendingBytes: 1 },
    };
    scheduler.register(registration);

    expect(() => scheduler.register(registration)).toThrowError(
      expect.objectContaining({ code: "SCHEDULER_MODULE_DUPLICATE" }),
    );
    expect(() => scheduler.status("absent")).toThrowError(
      expect.objectContaining({ code: "SCHEDULER_MODULE_UNKNOWN" }),
    );
  });

  it("exposes the Section 16 per-Module and instance status", async () => {
    const { clock, mailboxes, scheduler } = createScheduler({ retryJitterRatio: 0 });
    const runtime = new FakeModuleRuntime((tickCount) =>
      tickCount === 1 ? committedResult(1) : retryResult(tickCount),
    );
    mailboxes.set("worker", 6, 600);
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 20, maxPendingBytes: 2_000 },
    });
    scheduler.start();
    await drain(clock);
    await advance(clock, 100);

    const status = scheduler.status("worker");
    expect(status.moduleId).toBe("worker");
    expect(status.moduleGenerationId).toBe("generation-1");
    expect(status.activationMode).toBe("reactive");
    expect(status.pendingCount).toBe(6);
    expect(status.pendingBytes).toBe(600);
    expect(status.maxPendingCount).toBe(20);
    expect(status.maxPendingBytes).toBe(2_000);
    expect(status.lastSuccessAt).not.toBeNull();
    expect(status.lastFailureAt).not.toBeNull();
    expect(status.lastServiceTimeMs).not.toBeNull();
    expect(status.retryCount).toBe(1);
    expect(status.deadLetterCount).toBe(0);
    expect(status.counters.committed).toBe(1);
    expect(status.counters.retryScheduled).toBe(1);
    expect(status.counters.dispatched).toBe(2);
    expect(scheduler.statuses().map((entry) => entry.moduleId)).toEqual(["worker"]);

    const instance = scheduler.instanceStatus();
    expect(instance.registeredModules).toBe(1);
    expect(instance.pendingCount).toBe(6);
    expect(instance.pendingBytes).toBe(600);
    expect(instance.maxConcurrentModules).toBe(4);
    expect(instance.state).toBe("running");
    await scheduler.stop();
  });

  it("emits a decision event per state change with a reason code and snapshot summary", async () => {
    const { clock, mailboxes, scheduler, events } = createScheduler();
    mailboxes.set("worker", 0, 0);
    scheduler.register({
      moduleId: "worker",
      runtime: new FakeModuleRuntime(() => ({ status: "idle" })),
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 10, maxPendingBytes: 1_000 },
    });
    scheduler.start();
    await advance(clock, 500);

    const idleDecisions = events.filter(
      (event) => event.type === "scheduler.decision" && event.reasonCode === "NO_PENDING_INPUT",
    );
    // Five polls, one decision: repeated identical decisions are collapsed.
    expect(idleDecisions).toHaveLength(1);
    expect(idleDecisions[0]).toMatchObject({
      instanceId: "instance-1",
      moduleId: "worker",
      moduleGenerationId: "generation-1",
      eligible: false,
      policyName: "fixed-baseline",
      snapshot: { pendingCount: 0, actorBusy: false, blockedDownstreamIds: [] },
    });

    mailboxes.set("worker", 2, 20);
    await advance(clock, 100);
    const dispatch = events.filter((event) => event.type === "scheduler.dispatched");
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]).toMatchObject({
      reasonCode: "READY_REACTIVE",
      claimLimitCount: 8,
      claimLimitBytes: 4_096,
      snapshot: { pendingCount: 2, pendingBytes: 20 },
    });
    await scheduler.stop();
  });

  it("survives an observer that throws", async () => {
    const clock = new FakeSchedulerClock();
    const mailboxes = new FakeMailboxes();
    const runtime = new FakeModuleRuntime(() => ({ status: "idle" }));
    mailboxes.set("worker", 2, 20);
    const scheduler = new ModuleScheduler({
      instanceId: "instance-1",
      deliveries: mailboxes,
      clock,
      pollIntervalMs: 100,
      retryBaseMs: 250,
      retryMaxMs: 1_000,
      maxConcurrentModules: 2,
      backpressureAction: "pause-upstream",
      downstreamRecheckMs: 50,
      noProgressAfterMs: 10_000,
      claimLimitCount: 8,
      claimLimitBytes: 4_096,
      onEvent: () => {
        throw new Error("observer exploded");
      },
    });
    scheduler.register({
      moduleId: "worker",
      runtime,
      inputPageIds: ["input"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 10, maxPendingBytes: 1_000 },
    });
    scheduler.start();
    await advance(clock, 300);

    expect(runtime.tickCount).toBeGreaterThan(0);
    await scheduler.stop();
  });
});

describe("CORE scheduler over the real Delivery store", () => {
  function proposal(text: string): BlockProposal {
    return {
      payload: {
        schema: "dolly.content/1",
        value: { items: [{ type: "text", text, format: "plain" }] },
      },
    };
  }

  function createPipeline() {
    let blockId = 0;
    let runtimeId = 0;
    let generation = 1;
    const blocks = new BlockStore({
      nextBlockId: () => `block-${++blockId}`,
      now: () => NOW,
    });
    const deliveries = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => `${kind}-${++runtimeId}`,
      now: () => NOW,
    });
    deliveries.createPage("input");
    deliveries.createPage("middle");
    deliveries.registerConsumer("input", "producer", "from-now");
    deliveries.registerConsumer("middle", "sink", "from-now");
    const submissions = new Map<string, ModuleSubmissionRecord>();
    const runtimeDeliveries: ReactiveModuleRuntimeOptions["deliveries"] = {
      validateClaimPages: deliveries.validateClaimPages.bind(deliveries),
      validateOutputPages: deliveries.validateOutputPages.bind(deliveries),
      claim: deliveries.claim.bind(deliveries),
      flushPersistence: deliveries.flushPersistence.bind(deliveries),
      inspectClaim: deliveries.inspectClaim.bind(deliveries),
      inspectClaimInput: deliveries.inspectClaimInput.bind(deliveries),
    };
    const commits = new ModuleResultCommitCoordinator({
      blocks,
      deliveries,
      getModuleSubmissionRecord: (runId) => submissions.get(runId),
      acknowledgeDeliveryClaim: (identity) => {
        const result = deliveries.ack(identity);
        submissions.delete(identity.runId);
        return result;
      },
      repository: new InMemoryModuleResultCommitRepository(),
      now: () => NOW,
    });
    const producer = new ReactiveModuleRuntime({
      moduleId: "producer",
      initialModuleGenerationId: "generation-1",
      inputPageIds: ["input"],
      outputPageIds: ["middle"],
      claimMaxCount: 1,
      claimMaxBytes: 1024 * 1024,
      maxInputBytes: 2 * 1024 * 1024,
      maxResultBytes: 2 * 1024 * 1024,
      executionTimeoutMs: 60_000,
      cancellationGraceMs: 1_000,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      maxRunsPerGeneration: 100,
      maxGenerations: 8,
      deliveries: runtimeDeliveries,
      persistModuleSubmission: (request) => {
        submissions.set(request.runId, submissionForClaim(request));
      },
      releaseDeliveryClaim: (identity) => {
        const result = deliveries.releaseClaim(identity);
        submissions.delete(identity.runId);
        return result;
      },
      negativelyAcknowledgeDeliveryClaim: (request) => {
        const result = deliveries.nack(request);
        submissions.delete(request.runId);
        return result;
      },
      getModuleSubmissionRecord: (runId) => submissions.get(runId),
      commits,
      nextModuleGenerationId: () => `generation-${++generation}`,
      monotonicNow: () => 1,
      createExecutor: () => ({
        isolation: "process" as const,
        start: async () => undefined,
        terminate: async () => undefined,
        execute: async (_input, context): Promise<ReactiveModuleResult> => {
          if (!submissions.has(context.runId)) {
            throw new Error("The submitted Module Run has no persisted submission");
          }
          return {
            schemaVersion: "dolly.module-result/1",
            blockProposal: proposal("produced"),
          };
        },
      }),
      classifyFailure: (failure) => ({ code: failure.code, retryable: true }),
    });
    const appendInput = (text: string) =>
      deliveries.append("input", blocks.commit(proposal(text), { kind: "external", id: "console" }).id);
    return { blocks, deliveries, commits, producer, appendInput };
  }

  /** Drains the sink by claiming and acknowledging through the real store. */
  class DrainingSink implements SchedulableModuleRuntime {
    readonly moduleGenerationId = "generation-1";
    enabled = false;
    drained = 0;
    constructor(private readonly deliveries: DeliveryStore) {}

    async tick(): Promise<ReactiveModuleTickResult> {
      if (!this.enabled) return { status: "idle" };
      let claim: DeliveryClaim | null;
      try {
        claim = this.deliveries.claim({
          consumerId: "sink",
          pageIds: ["middle"],
          moduleGenerationId: this.moduleGenerationId,
          maxCount: 10,
          maxBytes: 1024 * 1024,
        });
      } catch {
        return { status: "idle" };
      }
      if (!claim) return { status: "idle" };
      this.deliveries.ack({
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
      });
      this.drained += claim.deliveryIds.length;
      return { status: "idle" };
    }
  }

  it("drives real ticks serially, blocks on a full downstream mailbox, and drops nothing", async () => {
    const pipeline = createPipeline();
    await pipeline.producer.start();
    for (const text of ["one", "two", "three"]) pipeline.appendInput(text);

    const clock = new FakeSchedulerClock();
    const events: SchedulerEvent[] = [];
    const sink = new DrainingSink(pipeline.deliveries);
    const scheduler = new ModuleScheduler({
      instanceId: "instance-1",
      deliveries: pipeline.deliveries,
      clock,
      pollIntervalMs: 100,
      retryBaseMs: 250,
      retryMaxMs: 1_000,
      maxConcurrentModules: 4,
      backpressureAction: "pause-upstream",
      downstreamRecheckMs: 50,
      noProgressAfterMs: 100_000,
      claimLimitCount: 1,
      claimLimitBytes: 4_096,
      retryJitterRatio: 0,
      onEvent: (event) => {
        events.push(event);
      },
    });
    scheduler.register({
      moduleId: "producer",
      runtime: pipeline.producer,
      inputPageIds: ["input"],
      outputPageIds: ["middle"],
      mailbox: { maxPendingCount: 50, maxPendingBytes: 500_000 },
    });
    scheduler.register({
      moduleId: "sink",
      runtime: sink,
      inputPageIds: ["middle"],
      outputPageIds: [],
      mailbox: { maxPendingCount: 1, maxPendingBytes: 500_000 },
    });
    scheduler.start();
    await advance(clock, 1_000);

    // One committed Block filled the sink's one-slot mailbox, so the producer
    // was paused with two input Deliveries still pending and unacknowledged.
    expect(pipeline.deliveries.inspectPending("sink", ["middle"]).pendingCount).toBe(1);
    expect(pipeline.deliveries.inspectPending("producer", ["input"]).pendingCount).toBe(2);
    expect(scheduler.status("producer").backpressured).toBe(true);
    expect(scheduler.status("producer").blockingDownstreamIds).toEqual(["sink"]);
    expect(eventTypes(events, "producer")).toContain("scheduler.backpressure_entered");
    expect(pipeline.deliveries.snapshot().deadLetters).toEqual([]);

    const blockedInputPending = pipeline.deliveries.inspectPending("producer", ["input"]).pendingCount;
    await advance(clock, 2_000);
    expect(pipeline.deliveries.inspectPending("producer", ["input"]).pendingCount).toBe(
      blockedInputPending,
    );

    sink.enabled = true;
    await advance(clock, 2_000);

    expect(sink.drained).toBe(3);
    expect(pipeline.deliveries.inspectPending("producer", ["input"]).pendingCount).toBe(0);
    expect(pipeline.deliveries.inspectPending("sink", ["middle"]).pendingCount).toBe(0);
    expect(scheduler.status("producer").counters.committed).toBe(3);
    expect(scheduler.status("producer").backpressured).toBe(false);
    expect(pipeline.deliveries.snapshot().deadLetters).toEqual([]);

    await scheduler.stop();
    expect(clock.liveTimerCount).toBe(0);
    await pipeline.producer.stop();
  });
});
