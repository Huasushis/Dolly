import { describe, expect, it } from "vitest";
import {
  FixedSchedulerPolicy,
  SchedulerPolicyError,
  type FixedSchedulerSnapshot,
} from "../../../src/core/scheduler-policy.js";

function snapshot(
  overrides: Partial<FixedSchedulerSnapshot> = {},
): FixedSchedulerSnapshot {
  return {
    moduleId: "module-a",
    moduleGenerationId: "generation-1",
    activationMode: "reactive",
    monotonicNow: 1_000,
    actorBusy: false,
    pendingCount: 1,
    pendingBytes: 100,
    oldestPendingAgeMs: 20,
    arrivalsDuringLastRunCount: 0,
    arrivalsDuringLastRunBytes: 0,
    retryCount: 0,
    downstream: [],
    ...overrides,
  };
}

function policy() {
  return new FixedSchedulerPolicy({
    claimLimitCount: 8,
    claimLimitBytes: 4096,
    retryBaseMs: 100,
    retryMaxMs: 800,
    downstreamRecheckMs: 25,
  });
}

describe("CORE deterministic fixed scheduler policy", () => {
  it("runs reactive work only when pending and idle", () => {
    expect(policy().decide(snapshot())).toEqual({
      eligible: true,
      eligibleAt: 1_000,
      claimLimitCount: 8,
      claimLimitBytes: 4096,
      reasonCode: "READY_REACTIVE",
      policyName: "fixed-baseline",
      policyVersion: "1",
      missedPeriods: 0,
      retryDelayMs: 0,
      blockingDownstreamIds: [],
    });
    expect(policy().decide(snapshot({ pendingCount: 0, pendingBytes: 0 }))).toMatchObject({
      eligible: false,
      eligibleAt: null,
      reasonCode: "NO_PENDING_INPUT",
    });
    expect(policy().decide(snapshot({ actorBusy: true }))).toMatchObject({
      eligible: false,
      eligibleAt: null,
      reasonCode: "ACTOR_BUSY",
    });
  });

  it("uses start-to-start periodic timing and coalesces missed periods", () => {
    const notDue = policy().decide(snapshot({
      activationMode: "periodic",
      monotonicNow: 1_050,
      lastRunStartedAt: 1_000,
      lastRunServiceTimeMs: 900,
      periodMs: 100,
      allowEmptyPeriodicInput: true,
      pendingCount: 0,
      pendingBytes: 0,
    }));
    expect(notDue).toMatchObject({
      eligible: false,
      eligibleAt: 1_100,
      reasonCode: "PERIOD_NOT_DUE",
      missedPeriods: 0,
    });

    const overdue = policy().decide(snapshot({
      activationMode: "periodic",
      monotonicNow: 1_450,
      lastRunStartedAt: 1_000,
      lastRunServiceTimeMs: 450,
      periodMs: 100,
      allowEmptyPeriodicInput: true,
      pendingCount: 0,
      pendingBytes: 0,
    }));
    expect(overdue).toMatchObject({
      eligible: true,
      eligibleAt: 1_450,
      reasonCode: "READY_PERIODIC",
      missedPeriods: 3,
    });
  });

  it("requires explicit empty-input policy for periodic Modules", () => {
    expect(policy().decide(snapshot({
      activationMode: "periodic",
      periodMs: 100,
      allowEmptyPeriodicInput: false,
      pendingCount: 0,
      pendingBytes: 0,
    }))).toMatchObject({
      eligible: false,
      reasonCode: "NO_PENDING_INPUT",
    });
    expect(() => policy().decide(snapshot({
      activationMode: "periodic",
      periodMs: 100,
      allowEmptyPeriodicInput: undefined,
    }))).toThrowError(expect.objectContaining<Partial<SchedulerPolicyError>>({
      code: "SCHEDULER_SNAPSHOT_INVALID",
    }));
  });

  it("applies bounded exponential retry delay without changing claim limits", () => {
    expect(policy().decide(snapshot({
      monotonicNow: 1_050,
      retryCount: 3,
      lastFailureAt: 1_000,
    }))).toMatchObject({
      eligible: false,
      eligibleAt: 1_400,
      retryDelayMs: 400,
      reasonCode: "RETRY_BACKOFF",
      claimLimitCount: 8,
      claimLimitBytes: 4096,
    });
    expect(policy().decide(snapshot({
      monotonicNow: 2_000,
      retryCount: 99,
      lastFailureAt: 1_000,
    }))).toMatchObject({
      eligible: true,
      retryDelayMs: 800,
      reasonCode: "READY_REACTIVE",
    });
  });

  it("aggregates fan-out pressure independently of callback order", () => {
    const downstream = [
      {
        moduleId: "sink-b",
        availability: "available" as const,
        pendingCount: 10,
        pendingBytes: 100,
        maxPendingCount: 10,
        maxPendingBytes: 1000,
      },
      {
        moduleId: "sink-a",
        availability: "unknown" as const,
        pendingCount: 0,
        pendingBytes: 0,
        maxPendingCount: 10,
        maxPendingBytes: 1000,
      },
      {
        moduleId: "sink-c",
        availability: "available" as const,
        pendingCount: 1,
        pendingBytes: 10,
        maxPendingCount: 10,
        maxPendingBytes: 1000,
      },
    ];
    const first = policy().decide(snapshot({ downstream }));
    const reversed = policy().decide(snapshot({ downstream: [...downstream].reverse() }));
    expect(first).toEqual(reversed);
    expect(first).toMatchObject({
      eligible: false,
      eligibleAt: 1_025,
      reasonCode: "DOWNSTREAM_BACKPRESSURE",
      blockingDownstreamIds: ["sink-a", "sink-b"],
    });
  });

  it("treats source activation request queues explicitly and never invents an empty request", () => {
    expect(policy().decide(snapshot({
      activationMode: "source",
      pendingCount: 0,
      pendingBytes: 0,
    }))).toMatchObject({
      eligible: false,
      reasonCode: "NO_PENDING_SOURCE_TRIGGER",
    });
    expect(policy().decide(snapshot({ activationMode: "source" }))).toMatchObject({
      eligible: true,
      reasonCode: "READY_SOURCE",
    });
  });

  it("rejects malformed or ambiguous snapshots instead of guessing", () => {
    expect(() => policy().decide(snapshot({ retryCount: 1 }))).toThrowError(
      expect.objectContaining<Partial<SchedulerPolicyError>>({
        code: "SCHEDULER_SNAPSHOT_INVALID",
      }),
    );
    expect(() => policy().decide(snapshot({
      downstream: [
        {
          moduleId: "sink",
          availability: "available",
          pendingCount: 0,
          pendingBytes: 0,
          maxPendingCount: 1,
          maxPendingBytes: 1,
        },
        {
          moduleId: "sink",
          availability: "blocked",
          pendingCount: 0,
          pendingBytes: 0,
          maxPendingCount: 1,
          maxPendingBytes: 1,
        },
      ],
    }))).toThrowError(expect.objectContaining<Partial<SchedulerPolicyError>>({
      code: "SCHEDULER_SNAPSHOT_INVALID",
    }));
    expect(() => new FixedSchedulerPolicy({
      claimLimitCount: 0,
      claimLimitBytes: 1,
      retryBaseMs: 100,
      retryMaxMs: 50,
      downstreamRecheckMs: 0,
    })).toThrowError(expect.objectContaining({ code: "SCHEDULER_CONFIGURATION_INVALID" }));
  });

  it("returns immutable decisions and does not mutate its snapshot", () => {
    const input = snapshot({
      downstream: [{
        moduleId: "sink",
        availability: "available",
        pendingCount: 0,
        pendingBytes: 0,
        maxPendingCount: 10,
        maxPendingBytes: 100,
      }],
    });
    const before = JSON.stringify(input);
    const decision = policy().decide(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.blockingDownstreamIds)).toBe(true);
  });
});
