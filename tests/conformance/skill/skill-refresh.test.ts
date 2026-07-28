import { describe, expect, it } from "vitest";

import {
  SkillRefreshError,
  SkillRefreshScheduler,
  type SkillSourceActivationRequest,
} from "../../../src/extensions/skill/skill-refresh.js";
import { ManualTimerHost } from "./fixtures/manual-timers.js";

interface Harness {
  readonly timers: ManualTimerHost;
  readonly requests: SkillSourceActivationRequest[];
  readonly scheduler: SkillRefreshScheduler;
}

function createHarness(
  overrides: {
    readonly debounceMs?: number;
    readonly maxDebounceMs?: number;
    readonly periodicVerificationMs?: number;
    readonly submit?: (request: SkillSourceActivationRequest) => void;
  } = {},
): Harness {
  const timers = new ManualTimerHost();
  const requests: SkillSourceActivationRequest[] = [];
  const scheduler = new SkillRefreshScheduler({
    moduleId: "skill-module",
    monotonicNow: timers.monotonicNow,
    setTimer: timers.setTimer,
    submitSourceActivation: (request) => {
      requests.push(request);
      overrides.submit?.(request);
    },
    debounceMs: overrides.debounceMs ?? 500,
    maxDebounceMs: overrides.maxDebounceMs ?? 5000,
    periodicVerificationMs: overrides.periodicVerificationMs ?? 0,
  });
  return { timers, requests, scheduler };
}

/** Runs the initial refresh so a test starts from a settled scheduler. */
function settle(harness: Harness): void {
  harness.scheduler.start();
  const initial = harness.requests.at(-1)!;
  harness.scheduler.completeRefresh(initial.idempotencyKey);
}

describe("skill refresh scheduler: request submission", () => {
  it("submits the first refresh immediately when it starts", () => {
    const harness = createHarness();

    harness.scheduler.start();

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      idempotencyKey: "skill-refresh:skill-module:0",
      moduleId: "skill-module",
      reason: "initial",
      signalCount: 1,
      requestedAt: 0,
    });
  });

  it("refuses a second start", () => {
    const harness = createHarness();
    harness.scheduler.start();

    expect(() => harness.scheduler.start()).toThrowError(
      expect.objectContaining<Partial<SkillRefreshError>>({
        code: "SKILL_REFRESH_STATE_INVALID",
      }),
    );
  });

  it("ignores changes before start", () => {
    const harness = createHarness();

    expect(harness.scheduler.notifyChange()).toBe(false);
    harness.timers.advance(10000);

    expect(harness.requests).toEqual([]);
  });
});

describe("skill refresh scheduler: debounce and coalescing", () => {
  it("coalesces a burst of changes into one request", () => {
    const harness = createHarness();
    settle(harness);

    harness.scheduler.notifyChange();
    harness.scheduler.notifyChange();
    harness.scheduler.notifyChange();
    expect(harness.requests).toHaveLength(1);

    harness.timers.advance(500);

    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]).toMatchObject({
      idempotencyKey: "skill-refresh:skill-module:1",
      reason: "filesystem-change",
      signalCount: 3,
    });
  });

  it("restarts the debounce window on every new change", () => {
    const harness = createHarness();
    settle(harness);

    harness.scheduler.notifyChange();
    harness.timers.advance(300);
    harness.scheduler.notifyChange();
    harness.timers.advance(300);
    harness.scheduler.notifyChange();

    harness.timers.advance(499);
    expect(harness.requests).toHaveLength(1);

    harness.timers.advance(1);
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]!.requestedAt).toBe(1100);
  });

  it("stops extending the window at the maximum debounce delay", () => {
    const harness = createHarness({ debounceMs: 500, maxDebounceMs: 1000 });
    settle(harness);

    harness.scheduler.notifyChange();
    harness.timers.advance(400);
    harness.scheduler.notifyChange();
    harness.timers.advance(400);
    harness.scheduler.notifyChange();

    harness.timers.advance(199);
    expect(harness.requests).toHaveLength(1);

    harness.timers.advance(1);
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]!.requestedAt).toBe(1000);
    expect(harness.requests[1]!.signalCount).toBe(3);
  });

  it("keeps the stronger reason when a window mixes hint kinds", () => {
    const harness = createHarness();
    settle(harness);

    harness.scheduler.notifyChange("filesystem-change");
    harness.scheduler.notifyChange("watcher-degraded");
    harness.scheduler.notifyChange("filesystem-change");
    harness.timers.advance(500);

    expect(harness.requests[1]!.reason).toBe("watcher-degraded");
  });
});

describe("skill refresh scheduler: idempotency and serialization", () => {
  it("does not open a second job while one refresh is live", () => {
    const harness = createHarness();
    harness.scheduler.start();

    harness.scheduler.notifyChange();
    harness.scheduler.notifyChange();
    harness.timers.advance(10000);

    expect(harness.requests).toHaveLength(1);
    expect(harness.scheduler.status()).toMatchObject({
      liveIdempotencyKey: "skill-refresh:skill-module:0",
      deferredSignalCount: 2,
      epoch: 0,
    });
  });

  it("opens the deferred refresh only after the live one completes", () => {
    const harness = createHarness();
    harness.scheduler.start();
    harness.scheduler.notifyChange();
    harness.scheduler.notifyChange();

    expect(harness.scheduler.completeRefresh("skill-refresh:skill-module:0")).toBe(true);
    expect(harness.requests).toHaveLength(1);

    harness.timers.advance(500);

    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]).toMatchObject({
      idempotencyKey: "skill-refresh:skill-module:1",
      signalCount: 2,
    });
  });

  it("ignores a completion that does not name the live request", () => {
    const harness = createHarness();
    harness.scheduler.start();

    expect(harness.scheduler.completeRefresh("skill-refresh:skill-module:7")).toBe(false);
    expect(harness.scheduler.status()).toMatchObject({
      epoch: 0,
      liveIdempotencyKey: "skill-refresh:skill-module:0",
    });
  });

  it("ignores a repeated completion of an already finished request", () => {
    const harness = createHarness();
    harness.scheduler.start();

    expect(harness.scheduler.completeRefresh("skill-refresh:skill-module:0")).toBe(true);
    expect(harness.scheduler.completeRefresh("skill-refresh:skill-module:0")).toBe(false);
    expect(harness.scheduler.status().epoch).toBe(1);
  });
});

describe("skill refresh scheduler: periodic verification", () => {
  it("asks for a verification refresh once the interval elapses", () => {
    const harness = createHarness({ periodicVerificationMs: 60000 });
    settle(harness);

    harness.timers.advance(59999);
    expect(harness.requests).toHaveLength(1);

    harness.timers.advance(1);
    harness.timers.advance(500);

    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]!.reason).toBe("periodic-verification");
  });

  it("re-arms itself so verification keeps running", () => {
    const harness = createHarness({ periodicVerificationMs: 60000 });
    settle(harness);

    harness.timers.advance(60500);
    harness.scheduler.completeRefresh(harness.requests.at(-1)!.idempotencyKey);
    harness.timers.advance(60500);

    expect(harness.requests).toHaveLength(3);
    expect(harness.requests[2]!.reason).toBe("periodic-verification");
  });

  it("does not overlap a live refresh", () => {
    const harness = createHarness({ periodicVerificationMs: 60000 });
    harness.scheduler.start();

    harness.timers.advance(600000);

    expect(harness.requests).toHaveLength(1);
    expect(harness.scheduler.status().deferredSignalCount).toBeGreaterThan(0);
  });

  it("arms no verification timer when the interval is zero", () => {
    const harness = createHarness({ periodicVerificationMs: 0 });
    settle(harness);

    expect(harness.timers.pendingTimerCount).toBe(0);
    harness.timers.advance(3600000);
    expect(harness.requests).toHaveLength(1);
  });
});

describe("skill refresh scheduler: stop", () => {
  it("cancels a pending debounce window and permits no later request", () => {
    const harness = createHarness({ periodicVerificationMs: 60000 });
    settle(harness);
    harness.scheduler.notifyChange();

    harness.scheduler.stop();
    harness.timers.advance(600000);

    expect(harness.requests).toHaveLength(1);
    expect(harness.timers.pendingTimerCount).toBe(0);
    expect(harness.scheduler.notifyChange()).toBe(false);
    expect(harness.scheduler.completeRefresh("skill-refresh:skill-module:1")).toBe(false);
    expect(harness.scheduler.status().state).toBe("stopped");
  });

  it("is idempotent", () => {
    const harness = createHarness();
    settle(harness);

    harness.scheduler.stop();
    harness.scheduler.stop();

    expect(harness.scheduler.status().state).toBe("stopped");
  });

  it("submits nothing from a debounce callback that survives cancellation", () => {
    // Models a timer whose cancellation loses the race, which is exactly the
    // late update that `docs/spec/skill-extension.md` section 6 forbids.
    const timers = new ManualTimerHost();
    const requests: SkillSourceActivationRequest[] = [];
    const scheduler = new SkillRefreshScheduler({
      moduleId: "skill-module",
      monotonicNow: timers.monotonicNow,
      setTimer: (delayMs, callback) => {
        timers.setTimer(delayMs, callback);
        return () => {};
      },
      submitSourceActivation: (request) => requests.push(request),
      debounceMs: 500,
      periodicVerificationMs: 0,
    });

    scheduler.start();
    scheduler.completeRefresh(requests[0]!.idempotencyKey);
    scheduler.notifyChange();
    scheduler.stop();
    timers.advance(500);

    expect(requests).toHaveLength(1);
  });
});

describe("skill refresh scheduler: submission failure and options", () => {
  it("keeps the window open and starts no retry loop when the runtime refuses", () => {
    let failNext = true;
    const harness = createHarness({
      submit: () => {
        if (failNext) throw new Error("mailbox full");
      },
    });

    harness.scheduler.start();

    expect(harness.scheduler.status()).toMatchObject({
      liveIdempotencyKey: null,
      pendingSignalCount: 1,
      submittedRequestCount: 0,
      lastSubmitErrorMessage: "mailbox full",
    });

    harness.timers.advance(600000);
    expect(harness.scheduler.status().submittedRequestCount).toBe(0);

    failNext = false;
    harness.scheduler.notifyChange();
    harness.timers.advance(500);

    expect(harness.scheduler.status()).toMatchObject({
      submittedRequestCount: 1,
      lastSubmitErrorMessage: null,
    });
  });

  it.each([
    ["debounceMs", { debounceMs: 0 }],
    ["maxDebounceMs below debounceMs", { debounceMs: 500, maxDebounceMs: 100 }],
    ["negative periodicVerificationMs", { periodicVerificationMs: -1 }],
  ])("rejects invalid option %s", (_label, options) => {
    const timers = new ManualTimerHost();

    expect(() =>
      new SkillRefreshScheduler({
        moduleId: "skill-module",
        monotonicNow: timers.monotonicNow,
        setTimer: timers.setTimer,
        submitSourceActivation: () => {},
        ...options,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SkillRefreshError>>({
        code: "SKILL_REFRESH_OPTIONS_INVALID",
      }),
    );
  });

  it("rejects an empty module identifier", () => {
    const timers = new ManualTimerHost();

    expect(() =>
      new SkillRefreshScheduler({
        moduleId: "",
        monotonicNow: timers.monotonicNow,
        setTimer: timers.setTimer,
        submitSourceActivation: () => {},
      })
    ).toThrowError(
      expect.objectContaining<Partial<SkillRefreshError>>({
        code: "SKILL_REFRESH_OPTIONS_INVALID",
      }),
    );
  });
});
