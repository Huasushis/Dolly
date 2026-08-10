import { deepFreeze } from "./canonical-json.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type SchedulerActivationMode = "reactive" | "periodic" | "source";

/**
 * The observed ability of one downstream Module to accept more output. It is
 * scheduler input only; it neither authorizes a write nor controls a Module.
 */
export type DownstreamAvailability = "available" | "blocked" | "unknown";

/**
 * A read-only count and byte report for one downstream Module. A scheduler
 * uses it to delay upstream work when the downstream Module cannot accept
 * output; it is not a protocol message or a capability.
 */
export interface DownstreamPressure {
  readonly moduleId: string;
  readonly availability: DownstreamAvailability;
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly residentCount: number;
  readonly residentBytes: number;
  readonly maxResidentCount: number;
  readonly maxResidentBytes: number;
}

export interface FixedSchedulerSnapshot {
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  readonly activationMode: SchedulerActivationMode;
  readonly monotonicNow: number;
  readonly actorBusy: boolean;
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly oldestPendingAgeMs: number;
  readonly arrivalsDuringLastRunCount: number;
  readonly arrivalsDuringLastRunBytes: number;
  readonly retryCount: number;
  readonly lastFailureAt?: number;
  readonly lastRunStartedAt?: number;
  readonly lastRunServiceTimeMs?: number;
  readonly periodMs?: number;
  readonly allowEmptyPeriodicInput?: boolean;
  readonly downstream: readonly DownstreamPressure[];
}

export type FixedSchedulerReasonCode =
  | "ACTOR_BUSY"
  | "NO_PENDING_INPUT"
  | "NO_PENDING_SOURCE_TRIGGER"
  | "PERIOD_NOT_DUE"
  | "RETRY_BACKOFF"
  | "DOWNSTREAM_BACKPRESSURE"
  | "READY_REACTIVE"
  | "READY_PERIODIC"
  | "READY_SOURCE";

export interface FixedSchedulerDecision {
  readonly eligible: boolean;
  readonly eligibleAt: number | null;
  readonly claimLimitCount: number;
  readonly claimLimitBytes: number;
  readonly reasonCode: FixedSchedulerReasonCode;
  readonly policyName: "fixed-baseline";
  readonly policyVersion: "1";
  readonly missedPeriods: number;
  readonly retryDelayMs: number;
  readonly blockingDownstreamIds: readonly string[];
}

export interface FixedSchedulerPolicyOptions {
  readonly claimLimitCount: number;
  readonly claimLimitBytes: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly downstreamRecheckMs: number;
}

export type SchedulerPolicyErrorCode =
  | "SCHEDULER_CONFIGURATION_INVALID"
  | "SCHEDULER_SNAPSHOT_INVALID";

export class SchedulerPolicyError extends Error {
  constructor(readonly code: SchedulerPolicyErrorCode, message: string) {
    super(message);
    this.name = "SchedulerPolicyError";
  }
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new SchedulerPolicyError(
      "SCHEDULER_SNAPSHOT_INVALID",
      `${label} must be finite and non-negative`,
    );
  }
}

function assertCount(value: number, label: string, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new SchedulerPolicyError(
      "SCHEDULER_SNAPSHOT_INVALID",
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
    );
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isFinite(result)) {
    throw new SchedulerPolicyError(
      "SCHEDULER_SNAPSHOT_INVALID",
      `${label} exceeds the finite monotonic clock range`,
    );
  }
  return result;
}

export class FixedSchedulerPolicy {
  readonly #claimLimitCount: number;
  readonly #claimLimitBytes: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #downstreamRecheckMs: number;

  constructor(options: FixedSchedulerPolicyOptions) {
    for (const [label, value] of [
      ["claimLimitCount", options.claimLimitCount],
      ["claimLimitBytes", options.claimLimitBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new SchedulerPolicyError(
          "SCHEDULER_CONFIGURATION_INVALID",
          `${label} must be a positive safe integer`,
        );
      }
    }
    for (const [label, value] of [
      ["retryBaseMs", options.retryBaseMs],
      ["retryMaxMs", options.retryMaxMs],
      ["downstreamRecheckMs", options.downstreamRecheckMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new SchedulerPolicyError(
          "SCHEDULER_CONFIGURATION_INVALID",
          `${label} must be finite and non-negative`,
        );
      }
    }
    if (options.retryMaxMs < options.retryBaseMs || options.downstreamRecheckMs <= 0) {
      throw new SchedulerPolicyError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "retryMaxMs must cover retryBaseMs and downstreamRecheckMs must be positive",
      );
    }
    this.#claimLimitCount = options.claimLimitCount;
    this.#claimLimitBytes = options.claimLimitBytes;
    this.#retryBaseMs = options.retryBaseMs;
    this.#retryMaxMs = options.retryMaxMs;
    this.#downstreamRecheckMs = options.downstreamRecheckMs;
  }

  decide(snapshot: FixedSchedulerSnapshot): FixedSchedulerDecision {
    this.#validateSnapshot(snapshot);
    const blockers = this.#blockingDownstream(snapshot.downstream);
    const missedPeriods = this.#missedPeriods(snapshot);
    const retryDelayMs = this.#retryDelay(snapshot.retryCount);
    const retryAt =
      snapshot.retryCount === 0
        ? snapshot.monotonicNow
        : checkedAdd(snapshot.lastFailureAt!, retryDelayMs, "retry eligibility");
    const periodAt = this.#periodEligibleAt(snapshot);
    const baseEligibleAt = Math.max(retryAt, periodAt);

    if (snapshot.actorBusy) {
      return this.#decision(false, null, "ACTOR_BUSY", missedPeriods, retryDelayMs, blockers);
    }
    if (
      snapshot.activationMode === "reactive" &&
      snapshot.pendingCount === 0
    ) {
      return this.#decision(
        false,
        null,
        "NO_PENDING_INPUT",
        missedPeriods,
        retryDelayMs,
        blockers,
      );
    }
    if (snapshot.activationMode === "source" && snapshot.pendingCount === 0) {
      return this.#decision(
        false,
        null,
        "NO_PENDING_SOURCE_TRIGGER",
        missedPeriods,
        retryDelayMs,
        blockers,
      );
    }
    if (
      snapshot.activationMode === "periodic" &&
      snapshot.pendingCount === 0 &&
      snapshot.allowEmptyPeriodicInput !== true
    ) {
      return this.#decision(
        false,
        periodAt > snapshot.monotonicNow ? periodAt : null,
        "NO_PENDING_INPUT",
        missedPeriods,
        retryDelayMs,
        blockers,
      );
    }
    if (baseEligibleAt > snapshot.monotonicNow) {
      const reasonCode = retryAt >= periodAt ? "RETRY_BACKOFF" : "PERIOD_NOT_DUE";
      return this.#decision(
        false,
        baseEligibleAt,
        reasonCode,
        missedPeriods,
        retryDelayMs,
        blockers,
      );
    }
    if (blockers.length > 0) {
      return this.#decision(
        false,
        checkedAdd(snapshot.monotonicNow, this.#downstreamRecheckMs, "pressure recheck"),
        "DOWNSTREAM_BACKPRESSURE",
        missedPeriods,
        retryDelayMs,
        blockers,
      );
    }

    const reasonCode: FixedSchedulerReasonCode =
      snapshot.activationMode === "reactive"
        ? "READY_REACTIVE"
        : snapshot.activationMode === "periodic"
          ? "READY_PERIODIC"
          : "READY_SOURCE";
    return this.#decision(
      true,
      snapshot.monotonicNow,
      reasonCode,
      missedPeriods,
      retryDelayMs,
      blockers,
    );
  }

  #decision(
    eligible: boolean,
    eligibleAt: number | null,
    reasonCode: FixedSchedulerReasonCode,
    missedPeriods: number,
    retryDelayMs: number,
    blockingDownstreamIds: readonly string[],
  ): FixedSchedulerDecision {
    return deepFreeze({
      eligible,
      eligibleAt,
      claimLimitCount: this.#claimLimitCount,
      claimLimitBytes: this.#claimLimitBytes,
      reasonCode,
      policyName: "fixed-baseline" as const,
      policyVersion: "1" as const,
      missedPeriods,
      retryDelayMs,
      blockingDownstreamIds: [...blockingDownstreamIds],
    });
  }

  #retryDelay(retryCount: number): number {
    if (retryCount === 0 || this.#retryBaseMs === 0) return 0;
    let delay = this.#retryBaseMs;
    for (let index = 1; index < retryCount && delay < this.#retryMaxMs; index += 1) {
      delay = Math.min(this.#retryMaxMs, delay * 2);
    }
    return delay;
  }

  #periodEligibleAt(snapshot: FixedSchedulerSnapshot): number {
    if (snapshot.activationMode !== "periodic" || snapshot.lastRunStartedAt === undefined) {
      return snapshot.monotonicNow;
    }
    return checkedAdd(snapshot.lastRunStartedAt, snapshot.periodMs!, "period eligibility");
  }

  #missedPeriods(snapshot: FixedSchedulerSnapshot): number {
    if (
      snapshot.activationMode !== "periodic" ||
      snapshot.lastRunStartedAt === undefined
    ) {
      return 0;
    }
    const firstDue = checkedAdd(
      snapshot.lastRunStartedAt,
      snapshot.periodMs!,
      "period eligibility",
    );
    if (snapshot.monotonicNow <= firstDue) return 0;
    return Math.floor((snapshot.monotonicNow - firstDue) / snapshot.periodMs!);
  }

  #blockingDownstream(downstream: readonly DownstreamPressure[]): readonly string[] {
    return downstream
      .filter(
        (pressure) =>
          pressure.availability !== "available" ||
          pressure.residentCount >= pressure.maxResidentCount ||
          pressure.residentBytes >= pressure.maxResidentBytes,
      )
      .map((pressure) => pressure.moduleId)
      .sort();
  }

  #validateSnapshot(snapshot: FixedSchedulerSnapshot): void {
    if (!ID_PATTERN.test(snapshot.moduleId) || !ID_PATTERN.test(snapshot.moduleGenerationId)) {
      throw new SchedulerPolicyError(
        "SCHEDULER_SNAPSHOT_INVALID",
        "Scheduler Module identity is invalid",
      );
    }
    if (
      snapshot.activationMode !== "reactive" &&
      snapshot.activationMode !== "periodic" &&
      snapshot.activationMode !== "source"
    ) {
      throw new SchedulerPolicyError(
        "SCHEDULER_SNAPSHOT_INVALID",
        "Scheduler activation mode is invalid",
      );
    }
    if (typeof snapshot.actorBusy !== "boolean") {
      throw new SchedulerPolicyError(
        "SCHEDULER_SNAPSHOT_INVALID",
        "actorBusy must be boolean",
      );
    }
    assertFiniteNonNegative(snapshot.monotonicNow, "monotonicNow");
    for (const [label, value] of [
      ["pendingCount", snapshot.pendingCount],
      ["pendingBytes", snapshot.pendingBytes],
      ["arrivalsDuringLastRunCount", snapshot.arrivalsDuringLastRunCount],
      ["arrivalsDuringLastRunBytes", snapshot.arrivalsDuringLastRunBytes],
      ["retryCount", snapshot.retryCount],
    ] as const) {
      assertCount(value, label);
    }
    assertFiniteNonNegative(snapshot.oldestPendingAgeMs, "oldestPendingAgeMs");
    if (snapshot.lastFailureAt !== undefined) {
      assertFiniteNonNegative(snapshot.lastFailureAt, "lastFailureAt");
      if (snapshot.lastFailureAt > snapshot.monotonicNow) {
        throw new SchedulerPolicyError(
          "SCHEDULER_SNAPSHOT_INVALID",
          "lastFailureAt cannot be in the future",
        );
      }
    }
    if (snapshot.retryCount > 0 && snapshot.lastFailureAt === undefined) {
      throw new SchedulerPolicyError(
        "SCHEDULER_SNAPSHOT_INVALID",
        "A retrying snapshot requires lastFailureAt",
      );
    }
    for (const [label, value] of [
      ["lastRunStartedAt", snapshot.lastRunStartedAt],
      ["lastRunServiceTimeMs", snapshot.lastRunServiceTimeMs],
    ] as const) {
      if (value !== undefined) assertFiniteNonNegative(value, label);
    }
    if (snapshot.lastRunStartedAt !== undefined && snapshot.lastRunStartedAt > snapshot.monotonicNow) {
      throw new SchedulerPolicyError(
        "SCHEDULER_SNAPSHOT_INVALID",
        "lastRunStartedAt cannot be in the future",
      );
    }
    if (snapshot.activationMode === "periodic") {
      if (snapshot.periodMs === undefined || !Number.isFinite(snapshot.periodMs) || snapshot.periodMs <= 0) {
        throw new SchedulerPolicyError(
          "SCHEDULER_SNAPSHOT_INVALID",
          "Periodic snapshots require a positive finite periodMs",
        );
      }
      if (typeof snapshot.allowEmptyPeriodicInput !== "boolean") {
        throw new SchedulerPolicyError(
          "SCHEDULER_SNAPSHOT_INVALID",
          "Periodic snapshots require an explicit allowEmptyPeriodicInput policy",
        );
      }
    } else if (snapshot.periodMs !== undefined || snapshot.allowEmptyPeriodicInput !== undefined) {
      throw new SchedulerPolicyError(
        "SCHEDULER_SNAPSHOT_INVALID",
        "Only periodic snapshots may carry periodic policy fields",
      );
    }
    if (!Array.isArray(snapshot.downstream)) {
      throw new SchedulerPolicyError(
        "SCHEDULER_SNAPSHOT_INVALID",
        "downstream pressure must be an array",
      );
    }
    const downstreamIds = new Set<string>();
    for (const pressure of snapshot.downstream) {
      if (!ID_PATTERN.test(pressure.moduleId) || downstreamIds.has(pressure.moduleId)) {
        throw new SchedulerPolicyError(
          "SCHEDULER_SNAPSHOT_INVALID",
          "Downstream Module identities are invalid or duplicated",
        );
      }
      if (
        pressure.availability !== "available" &&
        pressure.availability !== "blocked" &&
        pressure.availability !== "unknown"
      ) {
        throw new SchedulerPolicyError(
          "SCHEDULER_SNAPSHOT_INVALID",
          "Downstream availability is invalid",
        );
      }
      assertCount(pressure.pendingCount, "downstream.pendingCount");
      assertCount(pressure.pendingBytes, "downstream.pendingBytes");
      assertCount(pressure.residentCount, "downstream.residentCount");
      assertCount(pressure.residentBytes, "downstream.residentBytes");
      assertCount(pressure.maxResidentCount, "downstream.maxResidentCount", false);
      assertCount(pressure.maxResidentBytes, "downstream.maxResidentBytes", false);
      if (
        pressure.residentCount < pressure.pendingCount ||
        pressure.residentBytes < pressure.pendingBytes
      ) {
        throw new SchedulerPolicyError(
          "SCHEDULER_SNAPSHOT_INVALID",
          "Downstream resident state cannot be smaller than pending state",
        );
      }
      downstreamIds.add(pressure.moduleId);
    }
  }
}
