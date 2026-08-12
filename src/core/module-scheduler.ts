import { deepFreeze } from "./canonical-json.js";
import {
  FixedSchedulerPolicy,
  type DownstreamAvailability,
  type DownstreamPressure,
  type FixedSchedulerSnapshot,
} from "./scheduler-policy.js";
import type {
  ReactiveModuleClaimLimits,
  ReactiveModuleTickResult,
} from "./reactive-module-runtime.js";
import {
  resolveSourceActivationSchedulerBinding,
  type SourceActivationSchedulerBinding,
} from "./source-activation-queue.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The scheduler run loop. Section 13.1 of the Core runtime contract splits
 * correctness from policy: the Module actor owns serialization, claims, run
 * fencing, and lifecycle, and a scheduler policy only decides *when* an
 * already-correct actor may run. This class is the correctness half. It never
 * touches Deliveries, Claims, Blocks, or Module generations; it only decides
 * which registered Module runtime is driven with one `tick()` and when.
 *
 * Every gate below is enforced by the scheduler itself, so no policy - not even
 * a hostile or broken one - can start a second run for a busy actor or bypass a
 * mailbox bound, as Section 13.1 forbids.
 */

export type ModuleSchedulerErrorCode =
  | "SCHEDULER_CONFIGURATION_INVALID"
  | "SCHEDULER_MODULE_DUPLICATE"
  | "SCHEDULER_MODULE_UNKNOWN"
  | "SCHEDULER_ACTIVATION_UNSUPPORTED"
  | "SCHEDULER_STOPPED";

export class ModuleSchedulerError extends Error {
  constructor(
    readonly code: ModuleSchedulerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModuleSchedulerError";
  }
}

/** A cancellable one-shot timer. Cancelling twice is harmless. */
export interface SchedulerTimer {
  cancel(): void;
}

/**
 * Every duration, deadline, and scheduling calculation reads this clock, so a
 * deterministic test can drive the whole loop without a wall-clock sleep, as
 * Sections 11.4 and 18.5 require.
 */
export interface SchedulerClock {
  monotonicNow(): number;
  schedule(delayMs: number, callback: () => void): SchedulerTimer;
}

export function systemSchedulerClock(): SchedulerClock {
  return {
    monotonicNow: () => performance.now(),
    schedule: (delayMs, callback) => {
      const handle = setTimeout(callback, delayMs);
      return {
        cancel: () => {
          clearTimeout(handle);
        },
      };
    },
  };
}

/**
 * The scheduler drives exactly this surface of a Module runtime. Keeping it
 * this narrow is what makes the loop testable against a fake actor, and it
 * makes plain that the scheduler cannot reach claim, acknowledgement, or
 * generation state. `ReactiveModuleRuntime` satisfies it structurally.
 */
export interface SchedulableModuleRuntime {
  readonly moduleGenerationId: string;
  /** True when startup restored an accepted result that only needs output admission. */
  readonly outputCommitWaiting?: boolean;
  tick(limits?: ReactiveModuleClaimLimits): Promise<ReactiveModuleTickResult>;
}

export interface SchedulerPendingSnapshot {
  readonly pendingCount: number;
  readonly pendingBytes: number;
  /** Canonical persisted enqueue time when the reader can provide it. */
  readonly oldestEnqueuedAt?: string | null;
}

/**
 * Deliveries that still occupy mailbox capacity. Moving a Delivery from
 * pending to claimed does not free its count or Block bytes.
 */
export interface SchedulerResidentSnapshot {
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly claimedCount: number;
  readonly claimedBytes: number;
  readonly residentCount: number;
  readonly residentBytes: number;
}

/**
 * Read-only per-consumer mailbox state. `DeliveryStore` satisfies it; a test
 * may substitute a fake. Pending state drives input eligibility and arrival
 * measurements. Resident state drives capacity decisions. Both are keyed by
 * consumer and Page set rather than by Page alone.
 */
export interface SchedulerMailboxReader {
  inspectPending(consumerId: string, pageIds: readonly string[]): SchedulerPendingSnapshot;
  inspectResident(consumerId: string, pageIds: readonly string[]): SchedulerResidentSnapshot;
  /**
   * Optional durable-change notification.  It is only a wake-up hint; the
   * scheduler re-reads every mailbox before deciding.  The returned function
   * must unsubscribe idempotently.
   */
  subscribeChanges?(listener: () => void): () => void;
}

export type { DownstreamAvailability, DownstreamPressure };

/** Section 13.2 scheduler input. */
export type SchedulerSnapshot = FixedSchedulerSnapshot;

/**
 * Section 13.2 scheduler output, widened so an alternative policy may declare
 * its own reason codes, name, and version. `FixedSchedulerDecision` is
 * assignable to it unchanged.
 */
export interface SchedulerDecision {
  readonly eligible: boolean;
  readonly eligibleAt: number | null;
  readonly claimLimitCount: number;
  readonly claimLimitBytes: number;
  readonly reasonCode: string;
  readonly policyName: string;
  readonly policyVersion: string;
  readonly missedPeriods?: number;
  readonly retryDelayMs?: number;
  readonly blockingDownstreamIds?: readonly string[];
}

/**
 * The replaceable half of Section 13. An adaptive policy - the AIMD experiment
 * of Section 13.4, or the watermark baseline of the open research questions -
 * implements this interface and is selected through
 * `ModuleSchedulerOptions.policy`. It is never the default: omitting the option
 * yields `FixedSchedulerPolicy`, the fixed baseline of Section 13.3.
 *
 * A policy may only reduce eligibility. The scheduler applies its own gates
 * after every decision, so an adaptive policy can be swapped in or out without
 * changing Page, Block, claim, or Module correctness.
 */
export interface SchedulerPolicy {
  decide(snapshot: SchedulerSnapshot): SchedulerDecision;
}

/**
 * What the scheduler does to a Module whose downstream consumer mailbox has
 * reached its configured bound. All three are visible and none is lossy:
 * Section 12 forbids silent dropping, and the scheduler has no mechanism to
 * discard a Delivery under any configuration.
 *
 * - `pause-upstream` keeps the producer ineligible until the mailbox drains.
 * - `delay-upstream` additionally defers re-evaluation by `downstreamRecheckMs`.
 * - `reject-upstream-run` refuses the run and emits a counted rejection event on
 *   every pass, so a sustained block is loud rather than quiet.
 */
export type SchedulerBackpressureAction =
  | "pause-upstream"
  | "delay-upstream"
  | "reject-upstream-run";

export interface SchedulerMailboxLimits {
  readonly maxResidentCount: number;
  readonly maxResidentBytes: number;
}

export type SchedulerActivationDescriptor =
  | { readonly kind: "reactive" }
  | {
      readonly kind: "periodic";
      readonly periodMs: number;
      readonly allowEmptyInput: boolean;
    }
  | { readonly kind: "source" };

export interface SchedulerModuleRegistration {
  readonly moduleId: string;
  readonly runtime: SchedulableModuleRuntime;
  readonly inputPageIds: readonly string[];
  readonly outputPageIds: readonly string[];
  readonly mailbox: SchedulerMailboxLimits;
  /** Defaults to reactive. Empty periodic remains rejected. */
  readonly activation?: SchedulerActivationDescriptor;
  /** Required only for a source registration; ordinary input Page IDs stay empty. */
  readonly sourceActivationBinding?: SourceActivationSchedulerBinding;
}

export type SchedulerPolicyFailureAction = "fallback-baseline" | "quarantine";

export interface ModuleSchedulerOptions {
  readonly instanceId: string;
  readonly deliveries: SchedulerMailboxReader;
  readonly clock: SchedulerClock;
  /** Maps a durable enqueue timestamp onto this Scheduler's monotonic epoch. */
  readonly wallClockNow?: () => number;
  /** `core.scheduler.pollIntervalMs`. */
  readonly pollIntervalMs: number;
  /** `core.scheduler.retryBaseMs`. */
  readonly retryBaseMs: number;
  /** `core.scheduler.retryMaxMs`. */
  readonly retryMaxMs: number;
  /** Section 12 requires a finite instance-wide bound on active Module actors. */
  readonly maxConcurrentModules: number;
  readonly backpressureAction: SchedulerBackpressureAction;
  /** Re-evaluation delay for `delay-upstream`, and the policy's recheck delay. */
  readonly downstreamRecheckMs: number;
  /** Sustained-no-progress detection window (Section 12). */
  readonly noProgressAfterMs: number;
  /** Claim limits reported by the baseline policy. See the note on `SchedulerDecision`. */
  readonly claimLimitCount: number;
  readonly claimLimitBytes: number;
  /** Defaults to the Section 13.3 fixed baseline. */
  readonly policy?: SchedulerPolicy;
  /** Section 14: fall back to a declared safe fixed policy, or fail visibly. */
  readonly onPolicyFailure?: SchedulerPolicyFailureAction;
  /**
   * Bounded retry jitter as a fraction of the exponential delay, in [0, 1].
   * Total retry delay is `min(retryMaxMs, base * 2^(n-1)) * (1 + ratio)` at
   * most. Defaults to 0.2; set 0 for a fully deterministic backoff.
   */
  readonly retryJitterRatio?: number;
  /** Injectable deterministic randomness for jitter (Section 11.4). */
  readonly random?: () => number;
  /**
   * Fraction of a mailbox bound below which a blocked producer resumes.
   * Defaults to 1, meaning no hysteresis: a producer resumes as soon as the
   * consumer is back under its configured bound.
   */
  readonly lowWatermarkRatio?: number;
  readonly onEvent?: (event: SchedulerEvent) => void;
}

export interface SchedulerSnapshotSummary {
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly actorBusy: boolean;
  readonly oldestPendingAgeMs: number;
  readonly retryCount: number;
  readonly blockedDownstreamIds: readonly string[];
}

export interface SchedulerBlockedEdge {
  readonly moduleId: string;
  readonly blockedBy: readonly string[];
}

interface SchedulerEventBase {
  readonly instanceId: string;
  readonly monotonicAt: number;
}

interface SchedulerModuleEventBase extends SchedulerEventBase {
  readonly moduleId: string;
  readonly moduleGenerationId: string;
}

export type SchedulerEvent =
  | (SchedulerModuleEventBase & {
      readonly type: "scheduler.decision";
      readonly eligible: boolean;
      readonly reasonCode: string;
      readonly policyName: string;
      readonly policyVersion: string;
      readonly snapshot: SchedulerSnapshotSummary;
    })
  | (SchedulerModuleEventBase & {
      readonly type: "scheduler.dispatched";
      readonly reasonCode: string;
      readonly claimLimitCount: number;
      readonly claimLimitBytes: number;
      readonly missedPeriods: number;
      readonly snapshot: SchedulerSnapshotSummary;
    })
  | (SchedulerModuleEventBase & {
      readonly type: "scheduler.settled";
      readonly tickStatus: string;
      readonly serviceTimeMs: number;
    })
  | (SchedulerModuleEventBase & {
      readonly type: "scheduler.retry_scheduled";
      readonly retryCount: number;
      readonly retryDelayMs: number;
      readonly retryJitterMs: number;
      readonly nextEligibleAt: number;
    })
  | (SchedulerModuleEventBase & {
      readonly type: "scheduler.backpressure_entered" | "scheduler.backpressure_exited";
      readonly action: SchedulerBackpressureAction;
      readonly blockedBy: readonly string[];
    })
  | (SchedulerModuleEventBase & {
      readonly type: "scheduler.backpressure_rejected";
      readonly action: SchedulerBackpressureAction;
      readonly blockedBy: readonly string[];
      readonly rejectedCount: number;
    })
  | (SchedulerModuleEventBase & {
      readonly type: "scheduler.policy_failed";
      readonly action: SchedulerPolicyFailureAction;
      readonly errorMessage: string;
    })
  | (SchedulerModuleEventBase & {
      readonly type: "scheduler.quarantined";
      readonly reason: string;
    })
  | (SchedulerModuleEventBase & {
      readonly type: "scheduler.mailbox_state_unavailable";
      readonly errorMessage: string;
    })
  | (SchedulerModuleEventBase & {
      readonly type: "scheduler.invariant_violation";
      readonly violation: string;
    })
  | (SchedulerEventBase & {
      readonly type: "scheduler.activation_rejected";
      readonly moduleId: string;
      readonly activationMode: string;
    })
  | (SchedulerEventBase & {
      readonly type: "scheduler.no_progress";
      readonly stalledForMs: number;
      readonly blockedEdges: readonly SchedulerBlockedEdge[];
    })
  | (SchedulerEventBase & {
      readonly type: "scheduler.no_progress_cleared";
      readonly stalledForMs: number;
    });

/**
 * `Omit` collapses a union, so the module-scoped event bodies are omitted
 * member by member. Without this, an emit call site would lose its
 * discriminated payload fields.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type SchedulerModuleEventBody = DistributiveOmit<
  Extract<SchedulerEvent, { readonly moduleGenerationId: string }>,
  "instanceId" | "moduleId" | "moduleGenerationId" | "monotonicAt"
>;

export type SchedulerModuleState =
  | "idle"
  | "eligible"
  | "running"
  | "backpressured"
  | "period-wait"
  | "retry-backoff"
  | "quarantined";

export interface SchedulerModuleCounters {
  readonly dispatched: number;
  readonly committed: number;
  readonly retryScheduled: number;
  readonly outputBackpressured: number;
  readonly deadLettered: number;
  readonly cancelled: number;
  readonly recoveryRequired: number;
  readonly idleTicks: number;
  readonly backpressureBlocked: number;
  readonly backpressureRejected: number;
  readonly policyFailures: number;
  readonly invariantViolations: number;
  readonly missedPeriods: number;
}

export interface SchedulerModuleStatus {
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  readonly activationMode: "reactive" | "periodic" | "source";
  readonly periodMs: number | null;
  readonly allowEmptyPeriodicInput: boolean | null;
  readonly schedulingState: SchedulerModuleState;
  readonly policyName: string | null;
  readonly policyVersion: string | null;
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly claimedCount: number;
  readonly claimedBytes: number;
  readonly residentCount: number;
  readonly residentBytes: number;
  readonly maxResidentCount: number;
  readonly maxResidentBytes: number;
  readonly oldestPendingAgeMs: number;
  readonly mailboxFull: boolean;
  readonly mailboxStateAvailable: boolean;
  readonly backpressured: boolean;
  readonly backpressureAction: SchedulerBackpressureAction | null;
  readonly blockingDownstreamIds: readonly string[];
  readonly retryCount: number;
  readonly deadLetterCount: number;
  readonly retryDelayMs: number;
  readonly retryJitterMs: number;
  readonly nextEligibleAt: number | null;
  readonly lastDecisionReasonCode: string | null;
  readonly lastTickStatus: string | null;
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly lastRunStartedAt: number | null;
  readonly lastServiceTimeMs: number | null;
  readonly arrivalsDuringLastRunCount: number;
  readonly arrivalsDuringLastRunBytes: number;
  readonly quarantineReason: string | null;
  readonly counters: SchedulerModuleCounters;
}

export interface SchedulerInstanceStatus {
  readonly instanceId: string;
  readonly state: "created" | "running" | "stopping" | "stopped";
  readonly policyName: string;
  readonly registeredModules: number;
  readonly activeModules: number;
  readonly maxConcurrentModules: number;
  readonly backpressuredModules: number;
  readonly quarantinedModules: number;
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly claimedCount: number;
  readonly claimedBytes: number;
  readonly residentCount: number;
  readonly residentBytes: number;
  readonly oldestPendingAgeMs: number;
  readonly invariantViolationCount: number;
  readonly noProgressActive: boolean;
  readonly lastProgressAt: number | null;
}

/**
 * Section 11.2 and OWNER-CORE-006: a period is start-to-start intent, so the
 * next eligibility is `S_n + P_n` and the wait is `max(0, E_(n+1) - now)`.
 *
 * The delivery-backed periodic slice uses this formula only when empty input is
 * forbidden. Empty periodic remains rejected until it has a durable Module job
 * and completion boundary; authenticated source queues use Delivery Claims.
 */
export function periodicEligibility(input: {
  readonly lastRunStartedAt: number;
  readonly periodMs: number;
  readonly monotonicNow: number;
}): {
  readonly eligibleAt: number;
  readonly waitMs: number;
  readonly missedPeriods: number;
} {
  const { lastRunStartedAt, periodMs, monotonicNow } = input;
  if (!Number.isFinite(lastRunStartedAt) || lastRunStartedAt < 0) {
    throw new ModuleSchedulerError(
      "SCHEDULER_CONFIGURATION_INVALID",
      "lastRunStartedAt must be a finite non-negative monotonic reading",
    );
  }
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    throw new ModuleSchedulerError(
      "SCHEDULER_CONFIGURATION_INVALID",
      "periodMs must be a positive finite duration",
    );
  }
  if (!Number.isFinite(monotonicNow) || monotonicNow < lastRunStartedAt) {
    throw new ModuleSchedulerError(
      "SCHEDULER_CONFIGURATION_INVALID",
      "monotonicNow must be a finite reading at or after lastRunStartedAt",
    );
  }
  const eligibleAt = lastRunStartedAt + periodMs;
  return deepFreeze({
    eligibleAt,
    waitMs: Math.max(0, eligibleAt - monotonicNow),
    // Overrun is counted, never replayed: one eligibility is produced no matter
    // how many periods elapsed (Section 11.2).
    missedPeriods:
      monotonicNow <= eligibleAt ? 0 : Math.floor((monotonicNow - eligibleAt) / periodMs),
  });
}

interface MutableCounters {
  dispatched: number;
  committed: number;
  retryScheduled: number;
  outputBackpressured: number;
  deadLettered: number;
  cancelled: number;
  recoveryRequired: number;
  idleTicks: number;
  backpressureBlocked: number;
  backpressureRejected: number;
  policyFailures: number;
  invariantViolations: number;
  missedPeriods: number;
}

interface ModuleEntry {
  readonly moduleId: string;
  readonly runtime: SchedulableModuleRuntime;
  readonly activation: SchedulerActivationDescriptor;
  readonly inputPageIds: readonly string[];
  readonly outputPageIds: readonly string[];
  readonly maxResidentCount: number;
  readonly maxResidentBytes: number;
  downstreamIds: readonly string[];
  pending: SchedulerPendingSnapshot;
  resident: SchedulerResidentSnapshot;
  mailboxStateAvailable: boolean;
  pendingSinceMonotonic: number | null;
  pendingOldestEnqueuedAt: string | null;
  mailboxFull: boolean;
  inFlight: Promise<void> | null;
  outputCommitWaiting: boolean;
  dispatchPending: SchedulerPendingSnapshot | null;
  dispatchClaimLimitCount: number | null;
  dispatchClaimLimitBytes: number | null;
  arrivalsDuringLastRunCount: number;
  arrivalsDuringLastRunBytes: number;
  lastRunStartedAt: number | null;
  lastRunServiceTimeMs: number | null;
  retryCount: number;
  deadLetterCount: number;
  retryDelayMs: number;
  retryJitterMs: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  nextEligibleAt: number | null;
  backpressured: boolean;
  blockingDownstreamIds: readonly string[];
  quarantineReason: string | null;
  lastDecisionReasonCode: string | null;
  lastEmittedDecisionKey: string | null;
  lastPolicyName: string | null;
  lastPolicyVersion: string | null;
  lastTickStatus: string | null;
  readonly counters: MutableCounters;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ModuleSchedulerError(
      "SCHEDULER_CONFIGURATION_INVALID",
      `${label} must be a positive safe integer`,
    );
  }
}

function assertTimerDelay(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new ModuleSchedulerError(
      "SCHEDULER_CONFIGURATION_INVALID",
      `${label} must be a positive integer within the supported timer range`,
    );
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function newCounters(): MutableCounters {
  return {
    dispatched: 0,
    committed: 0,
    retryScheduled: 0,
    outputBackpressured: 0,
    deadLettered: 0,
    cancelled: 0,
    recoveryRequired: 0,
    idleTicks: 0,
    backpressureBlocked: 0,
    backpressureRejected: 0,
    policyFailures: 0,
    invariantViolations: 0,
    missedPeriods: 0,
  };
}

export class ModuleScheduler {
  readonly #instanceId: string;
  readonly #deliveries: SchedulerMailboxReader;
  readonly #clock: SchedulerClock;
  readonly #wallClockNow: () => number;
  readonly #pollIntervalMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #maxConcurrentModules: number;
  readonly #backpressureAction: SchedulerBackpressureAction;
  readonly #downstreamRecheckMs: number;
  readonly #noProgressAfterMs: number;
  readonly #claimLimitCount: number;
  readonly #claimLimitBytes: number;
  readonly #policy: SchedulerPolicy;
  readonly #fallbackPolicy: SchedulerPolicy;
  readonly #onPolicyFailure: SchedulerPolicyFailureAction;
  readonly #retryJitterRatio: number;
  readonly #random: () => number;
  readonly #lowWatermarkRatio: number;
  readonly #onEvent: ((event: SchedulerEvent) => void) | undefined;

  readonly #entries = new Map<string, ModuleEntry>();
  /** Private source Page ID -> owning Module ID. */
  readonly #sourcePrivatePages = new Map<string, string>();
  #state: "created" | "running" | "stopping" | "stopped" = "created";
  #pollTimer: SchedulerTimer | null = null;
  #immediateTimer: SchedulerTimer | null = null;
  #eligibilityTimer: SchedulerTimer | null = null;
  #eligibilityTimerDueAt: number | null = null;
  #activeCount = 0;
  #cursor = 0;
  #invariantViolationCount = 0;
  #lastProgressAt: number | null = null;
  #noProgressActive = false;
  #stopPromise: Promise<void> | null = null;
  #unsubscribeDeliveryChanges: (() => void) | null = null;

  constructor(options: ModuleSchedulerOptions) {
    if (!ID_PATTERN.test(options.instanceId)) {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "instanceId is not a valid identifier",
      );
    }
    assertTimerDelay(options.pollIntervalMs, "pollIntervalMs");
    assertTimerDelay(options.retryBaseMs, "retryBaseMs");
    assertTimerDelay(options.retryMaxMs, "retryMaxMs");
    assertTimerDelay(options.downstreamRecheckMs, "downstreamRecheckMs");
    assertTimerDelay(options.noProgressAfterMs, "noProgressAfterMs");
    assertPositiveInteger(options.maxConcurrentModules, "maxConcurrentModules");
    assertPositiveInteger(options.claimLimitCount, "claimLimitCount");
    assertPositiveInteger(options.claimLimitBytes, "claimLimitBytes");
    if (options.retryMaxMs < options.retryBaseMs) {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "retryMaxMs must be greater than or equal to retryBaseMs",
      );
    }
    const jitterRatio = options.retryJitterRatio ?? 0.2;
    if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "retryJitterRatio must be a finite fraction in [0, 1]",
      );
    }
    const lowWatermarkRatio = options.lowWatermarkRatio ?? 1;
    if (!Number.isFinite(lowWatermarkRatio) || lowWatermarkRatio <= 0 || lowWatermarkRatio > 1) {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "lowWatermarkRatio must be a finite fraction in (0, 1]",
      );
    }
    if (typeof options.clock?.monotonicNow !== "function" || typeof options.clock?.schedule !== "function") {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "clock must supply monotonicNow and schedule",
      );
    }
    if (options.wallClockNow !== undefined && typeof options.wallClockNow !== "function") {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "wallClockNow must be a function when present",
      );
    }
    if (typeof options.deliveries?.inspectPending !== "function") {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "deliveries must supply inspectPending",
      );
    }
    if (typeof options.deliveries?.inspectResident !== "function") {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "deliveries must supply inspectResident",
      );
    }
    if (
      options.deliveries.subscribeChanges !== undefined &&
      typeof options.deliveries.subscribeChanges !== "function"
    ) {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "deliveries.subscribeChanges must be a function when present",
      );
    }
    if (options.policy !== undefined && typeof options.policy.decide !== "function") {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "policy must supply decide",
      );
    }

    this.#instanceId = options.instanceId;
    this.#deliveries = options.deliveries;
    this.#clock = options.clock;
    this.#wallClockNow = options.wallClockNow ?? Date.now;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#retryBaseMs = options.retryBaseMs;
    this.#retryMaxMs = options.retryMaxMs;
    this.#maxConcurrentModules = options.maxConcurrentModules;
    this.#backpressureAction = options.backpressureAction;
    this.#downstreamRecheckMs = options.downstreamRecheckMs;
    this.#noProgressAfterMs = options.noProgressAfterMs;
    this.#claimLimitCount = options.claimLimitCount;
    this.#claimLimitBytes = options.claimLimitBytes;
    this.#retryJitterRatio = jitterRatio;
    this.#random = options.random ?? Math.random;
    this.#lowWatermarkRatio = lowWatermarkRatio;
    this.#onPolicyFailure = options.onPolicyFailure ?? "fallback-baseline";
    this.#onEvent = options.onEvent;
    // The declared safe fixed policy of Section 14. It is constructed even when
    // an alternative policy is selected, so a policy crash always has somewhere
    // safe to fall back to without allocating during the failure path.
    this.#fallbackPolicy = new FixedSchedulerPolicy({
      claimLimitCount: options.claimLimitCount,
      claimLimitBytes: options.claimLimitBytes,
      retryBaseMs: options.retryBaseMs,
      retryMaxMs: options.retryMaxMs,
      downstreamRecheckMs: options.downstreamRecheckMs,
    });
    this.#policy = options.policy ?? this.#fallbackPolicy;
  }

  get state(): "created" | "running" | "stopping" | "stopped" {
    return this.#state;
  }

  /**
   * Registers a Delivery-backed runtime. Reactive, non-empty periodic and an
   * authenticated private source queue use the same Claim/commit boundary.
   * Empty periodic remains rejected because it has no durable trigger.
   */
  register(registration: SchedulerModuleRegistration): void {
    if (this.#state === "stopping" || this.#state === "stopped") {
      throw new ModuleSchedulerError("SCHEDULER_STOPPED", "Scheduler is no longer accepting Modules");
    }
    if (!ID_PATTERN.test(registration.moduleId)) {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "moduleId is not a valid identifier",
      );
    }
    if (this.#entries.has(registration.moduleId)) {
      throw new ModuleSchedulerError(
        "SCHEDULER_MODULE_DUPLICATE",
        `Module ${registration.moduleId} is already registered`,
      );
    }
    const activation = registration.activation ?? { kind: "reactive" as const };
    if (
      activation.kind === "source" &&
      registration.sourceActivationBinding === undefined
    ) {
      this.#emit({
        type: "scheduler.activation_rejected",
        instanceId: this.#instanceId,
        monotonicAt: this.#clock.monotonicNow(),
        moduleId: registration.moduleId,
        activationMode: activation.kind,
      });
      throw new ModuleSchedulerError(
        "SCHEDULER_ACTIVATION_UNSUPPORTED",
        "source activation requires a durable Core-private request binding",
      );
    }
    if (activation.kind === "periodic" && activation.allowEmptyInput) {
      this.#emit({
        type: "scheduler.activation_rejected",
        instanceId: this.#instanceId,
        monotonicAt: this.#clock.monotonicNow(),
        moduleId: registration.moduleId,
        activationMode: activation.kind,
      });
      throw new ModuleSchedulerError(
        "SCHEDULER_ACTIVATION_UNSUPPORTED",
        "periodic activation with empty input requires a durable trigger",
      );
    }
    if (activation.kind === "periodic") {
      assertTimerDelay(activation.periodMs, "activation.periodMs");
      if (typeof activation.allowEmptyInput !== "boolean") {
        throw new ModuleSchedulerError(
          "SCHEDULER_CONFIGURATION_INVALID",
          "Periodic activation requires an explicit allowEmptyInput boolean",
        );
      }
    }
    assertPositiveInteger(registration.mailbox.maxResidentCount, "mailbox.maxResidentCount");
    assertPositiveInteger(registration.mailbox.maxResidentBytes, "mailbox.maxResidentBytes");

    let inputPageIds = [...registration.inputPageIds];
    let sourcePrivatePageId: string | undefined;
    if (activation.kind === "source") {
      if (inputPageIds.length !== 0) {
        throw new ModuleSchedulerError(
          "SCHEDULER_CONFIGURATION_INVALID",
          "A source Module cannot declare a public input Page",
        );
      }
      let authority;
      try {
        authority = resolveSourceActivationSchedulerBinding(
          registration.sourceActivationBinding,
          registration.moduleId,
          this.#deliveries,
        );
      } catch {
        throw new ModuleSchedulerError(
          "SCHEDULER_CONFIGURATION_INVALID",
          "The source activation binding is not authentic for this Module and Core store",
        );
      }
      sourcePrivatePageId = authority.privatePageId;
      inputPageIds = [sourcePrivatePageId];
    } else if (registration.sourceActivationBinding !== undefined) {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "Only a source Module may receive a source activation binding",
      );
    }

    if (inputPageIds.length === 0) {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "A Delivery-backed Module must consume at least one input Page",
      );
    }
    const privateRouteConflict = [...this.#sourcePrivatePages.keys()].find(
      (pageId) =>
        inputPageIds.includes(pageId) || registration.outputPageIds.includes(pageId),
    );
    if (privateRouteConflict !== undefined) {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "A Core-private source activation Page cannot be used as a public route",
      );
    }
    if (
      sourcePrivatePageId !== undefined &&
      (
        registration.outputPageIds.includes(sourcePrivatePageId) ||
        [...this.#entries.values()].some((entry) =>
          entry.inputPageIds.includes(sourcePrivatePageId!) ||
          entry.outputPageIds.includes(sourcePrivatePageId!)
        )
      )
    ) {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "The source activation Page is already exposed by another Scheduler route",
      );
    }
    if (typeof registration.runtime?.tick !== "function") {
      throw new ModuleSchedulerError(
        "SCHEDULER_CONFIGURATION_INVALID",
        "runtime must supply tick",
      );
    }

    this.#entries.set(registration.moduleId, {
      moduleId: registration.moduleId,
      runtime: registration.runtime,
      activation,
      inputPageIds,
      outputPageIds: [...registration.outputPageIds],
      maxResidentCount: registration.mailbox.maxResidentCount,
      maxResidentBytes: registration.mailbox.maxResidentBytes,
      downstreamIds: [],
      pending: { pendingCount: 0, pendingBytes: 0 },
      resident: {
        pendingCount: 0,
        pendingBytes: 0,
        claimedCount: 0,
        claimedBytes: 0,
        residentCount: 0,
        residentBytes: 0,
      },
      mailboxStateAvailable: true,
      pendingSinceMonotonic: null,
      pendingOldestEnqueuedAt: null,
      mailboxFull: false,
      inFlight: null,
      outputCommitWaiting: registration.runtime.outputCommitWaiting === true,
      dispatchPending: null,
      dispatchClaimLimitCount: null,
      dispatchClaimLimitBytes: null,
      arrivalsDuringLastRunCount: 0,
      arrivalsDuringLastRunBytes: 0,
      lastRunStartedAt: null,
      lastRunServiceTimeMs: null,
      retryCount: 0,
      deadLetterCount: 0,
      retryDelayMs: 0,
      retryJitterMs: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      nextEligibleAt: null,
      backpressured: false,
      blockingDownstreamIds: [],
      quarantineReason: null,
      lastDecisionReasonCode: null,
      lastEmittedDecisionKey: null,
      lastPolicyName: null,
      lastPolicyVersion: null,
      lastTickStatus: null,
      counters: newCounters(),
    });
    if (sourcePrivatePageId !== undefined) {
      this.#sourcePrivatePages.set(sourcePrivatePageId, registration.moduleId);
    }
    this.#recomputeTopology();
  }

  /**
   * Clears a quarantine after an operator resolved the unknown outcome that
   * caused it. It never touches Claim state; resolving that is the Module
   * runtime's recovery path, not the scheduler's.
   */
  release(moduleId: string): void {
    const entry = this.#requireEntry(moduleId);
    entry.quarantineReason = null;
    entry.nextEligibleAt = null;
    this.#requestPass();
  }

  start(): void {
    if (this.#state === "stopping" || this.#state === "stopped") {
      throw new ModuleSchedulerError("SCHEDULER_STOPPED", "Scheduler has stopped");
    }
    if (this.#state === "running") return;
    this.#state = "running";
    this.#lastProgressAt = this.#clock.monotonicNow();
    if (this.#deliveries.subscribeChanges) {
      const unsubscribe = this.#deliveries.subscribeChanges(() => this.wake());
      if (typeof unsubscribe !== "function") {
        this.#state = "created";
        throw new ModuleSchedulerError(
          "SCHEDULER_CONFIGURATION_INVALID",
          "deliveries.subscribeChanges must return an unsubscribe function",
        );
      }
      this.#unsubscribeDeliveryChanges = unsubscribe;
    }
    this.#armPoll();
    this.#requestPass();
  }

  /**
   * Requests an immediate eligibility pass. Callers use it after appending new
   * input so a reactive Module does not wait a whole poll interval. Repeated
   * calls before the pass runs coalesce into one.
   */
  wake(): void {
    this.#requestPass();
  }

  /**
   * Stops scheduling and resolves only after every in-flight `tick()` has
   * settled. No timer survives this call. It does not stop the Module runtimes
   * themselves: generation lifecycle belongs to the runtime owner, not to the
   * scheduler.
   */
  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#state = "stopping";
    const unsubscribe = this.#unsubscribeDeliveryChanges;
    this.#unsubscribeDeliveryChanges = null;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // A best-effort change observer cannot weaken scheduler shutdown.
      }
    }
    this.#cancelTimers();
    this.#stopPromise = (async () => {
      // A settling tick can never enqueue another one while stopping, but it
      // can settle after the first await, so drain until the set stays empty.
      while (this.#activeCount > 0) {
        const inFlight = [...this.#entries.values()]
          .map((entry) => entry.inFlight)
          .filter((promise): promise is Promise<void> => promise !== null);
        if (inFlight.length === 0) break;
        await Promise.all(inFlight);
      }
      this.#cancelTimers();
      this.#state = "stopped";
    })();
    return this.#stopPromise;
  }

  status(moduleId: string): SchedulerModuleStatus {
    const entry = this.#requireEntry(moduleId);
    return this.#statusOf(entry, this.#clock.monotonicNow());
  }

  statuses(): readonly SchedulerModuleStatus[] {
    const now = this.#clock.monotonicNow();
    return deepFreeze(
      [...this.#entries.values()]
        .sort((left, right) => left.moduleId.localeCompare(right.moduleId))
        .map((entry) => this.#statusOf(entry, now)),
    );
  }

  instanceStatus(): SchedulerInstanceStatus {
    const now = this.#clock.monotonicNow();
    let pendingCount = 0;
    let pendingBytes = 0;
    let claimedCount = 0;
    let claimedBytes = 0;
    let residentCount = 0;
    let residentBytes = 0;
    let oldestPendingAgeMs = 0;
    let backpressuredModules = 0;
    let quarantinedModules = 0;
    for (const entry of this.#entries.values()) {
      pendingCount += entry.pending.pendingCount;
      pendingBytes += entry.pending.pendingBytes;
      claimedCount += entry.resident.claimedCount;
      claimedBytes += entry.resident.claimedBytes;
      residentCount += entry.resident.residentCount;
      residentBytes += entry.resident.residentBytes;
      oldestPendingAgeMs = Math.max(oldestPendingAgeMs, this.#oldestPendingAgeMs(entry, now));
      if (entry.backpressured) backpressuredModules += 1;
      if (entry.quarantineReason !== null) quarantinedModules += 1;
    }
    return deepFreeze({
      instanceId: this.#instanceId,
      state: this.#state,
      policyName: this.#policy === this.#fallbackPolicy ? "fixed-baseline" : "custom",
      registeredModules: this.#entries.size,
      activeModules: this.#activeCount,
      maxConcurrentModules: this.#maxConcurrentModules,
      backpressuredModules,
      quarantinedModules,
      pendingCount,
      pendingBytes,
      claimedCount,
      claimedBytes,
      residentCount,
      residentBytes,
      oldestPendingAgeMs,
      invariantViolationCount: this.#invariantViolationCount,
      noProgressActive: this.#noProgressActive,
      lastProgressAt: this.#lastProgressAt,
    });
  }

  #requireEntry(moduleId: string): ModuleEntry {
    const entry = this.#entries.get(moduleId);
    if (!entry) {
      throw new ModuleSchedulerError(
        "SCHEDULER_MODULE_UNKNOWN",
        `Module ${moduleId} is not registered`,
      );
    }
    return entry;
  }

  /**
   * Downstream consumers are derived from the registered Page routes, not from
   * callbacks, so an aggregation result cannot depend on the order in which
   * pressure reports arrive (Section 13.2). A Module is never its own
   * downstream: it is the only consumer that can drain that mailbox, and one
   * run removes at least one claimed Delivery while committing at most one
   * Block (OWNER-CORE-002), so blocking a self-loop would manufacture the
   * guaranteed no-progress state Section 12 asks the runtime to avoid.
   */
  #recomputeTopology(): void {
    for (const entry of this.#entries.values()) {
      const outputs = new Set(entry.outputPageIds);
      entry.downstreamIds = [...this.#entries.values()]
        .filter(
          (candidate) =>
            candidate.moduleId !== entry.moduleId &&
            candidate.inputPageIds.some((pageId) => outputs.has(pageId)),
        )
        .map((candidate) => candidate.moduleId)
        .sort();
    }
  }

  #armPoll(): void {
    this.#pollTimer?.cancel();
    this.#pollTimer = this.#clock.schedule(this.#pollIntervalMs, () => {
      this.#pollTimer = null;
      if (this.#state !== "running") return;
      this.#runPass();
      if (this.#state === "running") this.#armPoll();
    });
  }

  #requestPass(): void {
    if (this.#state !== "running" || this.#immediateTimer !== null) return;
    this.#immediateTimer = this.#clock.schedule(0, () => {
      this.#immediateTimer = null;
      if (this.#state !== "running") return;
      this.#runPass();
    });
  }

  #cancelTimers(): void {
    this.#pollTimer?.cancel();
    this.#pollTimer = null;
    this.#immediateTimer?.cancel();
    this.#immediateTimer = null;
    this.#eligibilityTimer?.cancel();
    this.#eligibilityTimer = null;
    this.#eligibilityTimerDueAt = null;
  }

  /**
   * Arms one shared timer for the earliest policy, retry, or period deadline.
   * The ordinary poll remains a liveness fallback; it must not determine the
   * latency of an already-known eligibility time.
   */
  #armEligibilityTimer(now = this.#clock.monotonicNow()): void {
    if (this.#state !== "running") return;
    const earliest = [...this.#entries.values()].reduce<number | null>(
      (candidate, entry) => {
        const dueAt = entry.nextEligibleAt;
        if (dueAt === null || dueAt <= now || entry.quarantineReason !== null) {
          return candidate;
        }
        return candidate === null ? dueAt : Math.min(candidate, dueAt);
      },
      null,
    );
    if (earliest === null) {
      this.#eligibilityTimer?.cancel();
      this.#eligibilityTimer = null;
      this.#eligibilityTimerDueAt = null;
      return;
    }
    const scheduledAt = Math.min(earliest, now + MAX_TIMER_DELAY_MS);
    if (
      this.#eligibilityTimer !== null &&
      this.#eligibilityTimerDueAt === scheduledAt
    ) {
      return;
    }
    this.#eligibilityTimer?.cancel();
    this.#eligibilityTimerDueAt = scheduledAt;
    this.#eligibilityTimer = this.#clock.schedule(
      Math.max(0, scheduledAt - now),
      () => {
        this.#eligibilityTimer = null;
        this.#eligibilityTimerDueAt = null;
        if (this.#state !== "running") return;
        this.#runPass();
      },
    );
  }

  #runPass(): void {
    const now = this.#clock.monotonicNow();
    const entries = [...this.#entries.values()].sort((left, right) =>
      left.moduleId.localeCompare(right.moduleId),
    );
    if (entries.length === 0) return;

    for (const entry of entries) this.#refreshMailboxRead(entry, now);
    for (const entry of entries) this.#refreshMailboxState(entry);

    // Round-robin so an instance-wide concurrency cap cannot permanently starve
    // the Modules that sort last.
    const start = this.#cursor % entries.length;
    this.#cursor = (this.#cursor + 1) % entries.length;
    for (let offset = 0; offset < entries.length; offset += 1) {
      this.#evaluate(entries[(start + offset) % entries.length]!, now);
    }

    this.#detectNoProgress(entries, now);
    this.#armEligibilityTimer(now);
  }

  #refreshMailboxRead(entry: ModuleEntry, now: number): void {
    let pending: SchedulerPendingSnapshot;
    let resident: SchedulerResidentSnapshot;
    let durablePendingSince: number | undefined;
    try {
      const read = this.#deliveries.inspectPending(entry.moduleId, entry.inputPageIds);
      const residentRead = this.#deliveries.inspectResident(
        entry.moduleId,
        entry.inputPageIds,
      );
      const hasOldestEnqueuedAt = read.oldestEnqueuedAt !== undefined;
      const oldestEnqueuedAt = read.oldestEnqueuedAt ?? null;
      const oldestEnqueuedAtMs = oldestEnqueuedAt === null
        ? null
        : Date.parse(oldestEnqueuedAt);
      if (
        oldestEnqueuedAt !== null &&
        (
          typeof oldestEnqueuedAt !== "string" ||
          !Number.isFinite(oldestEnqueuedAtMs) ||
          new Date(oldestEnqueuedAtMs!).toISOString() !== oldestEnqueuedAt
        )
      ) {
        throw new TypeError("oldestEnqueuedAt must be a canonical timestamp or null");
      }
      pending = {
        pendingCount: read.pendingCount,
        pendingBytes: read.pendingBytes,
        ...(read.oldestEnqueuedAt === undefined ? {} : { oldestEnqueuedAt }),
      };
      if (
        !Number.isSafeInteger(pending.pendingCount) ||
        pending.pendingCount < 0 ||
        !Number.isSafeInteger(pending.pendingBytes) ||
        pending.pendingBytes < 0 ||
        (pending.pendingCount === 0 && oldestEnqueuedAt !== null) ||
        (pending.pendingCount > 0 && hasOldestEnqueuedAt && oldestEnqueuedAt === null)
      ) {
        throw new TypeError("pending state is inconsistent");
      }
      resident = {
        pendingCount: residentRead.pendingCount,
        pendingBytes: residentRead.pendingBytes,
        claimedCount: residentRead.claimedCount,
        claimedBytes: residentRead.claimedBytes,
        residentCount: residentRead.residentCount,
        residentBytes: residentRead.residentBytes,
      };
      const residentCountSum = resident.pendingCount + resident.claimedCount;
      const residentBytesSum = resident.pendingBytes + resident.claimedBytes;
      if (
        !Number.isSafeInteger(resident.pendingCount) ||
        resident.pendingCount < 0 ||
        !Number.isSafeInteger(resident.pendingBytes) ||
        resident.pendingBytes < 0 ||
        !Number.isSafeInteger(resident.claimedCount) ||
        resident.claimedCount < 0 ||
        !Number.isSafeInteger(resident.claimedBytes) ||
        resident.claimedBytes < 0 ||
        !Number.isSafeInteger(resident.residentCount) ||
        resident.residentCount < 0 ||
        !Number.isSafeInteger(resident.residentBytes) ||
        resident.residentBytes < 0 ||
        !Number.isSafeInteger(residentCountSum) ||
        !Number.isSafeInteger(residentBytesSum) ||
        resident.pendingCount !== pending.pendingCount ||
        resident.pendingBytes !== pending.pendingBytes ||
        resident.residentCount !== residentCountSum ||
        resident.residentBytes !== residentBytesSum
      ) {
        throw new TypeError("resident state is inconsistent with pending state");
      }
      if (
        oldestEnqueuedAt !== null &&
        oldestEnqueuedAt !== entry.pendingOldestEnqueuedAt
      ) {
        const wallClockNow = this.#wallClockNow();
        if (
          !Number.isSafeInteger(wallClockNow) ||
          wallClockNow < 0 ||
          !Number.isFinite(new Date(wallClockNow).getTime())
        ) {
          throw new TypeError(
            "wallClockNow must return a non-negative representable integer millisecond timestamp",
          );
        }
        if (oldestEnqueuedAtMs! > wallClockNow) {
          throw new TypeError("oldestEnqueuedAt cannot be later than wallClockNow");
        }
        const ageAtObservation = wallClockNow - oldestEnqueuedAtMs!;
        durablePendingSince = now - ageAtObservation;
      }
      entry.mailboxStateAvailable = true;
    } catch (error) {
      // An unreadable mailbox is reported as unknown capacity rather than as
      // zero pressure, so it can only make the scheduler more conservative.
      entry.mailboxStateAvailable = false;
      entry.counters.invariantViolations += 1;
      this.#invariantViolationCount += 1;
      this.#emitModule(entry, {
        type: "scheduler.mailbox_state_unavailable",
        errorMessage: errorMessage(error),
      });
      return;
    }
    entry.pending = pending;
    entry.resident = resident;
    if (pending.pendingCount === 0) {
      entry.pendingSinceMonotonic = null;
      entry.pendingOldestEnqueuedAt = null;
    } else if (durablePendingSince !== undefined) {
      entry.pendingSinceMonotonic = durablePendingSince;
      entry.pendingOldestEnqueuedAt = pending.oldestEnqueuedAt!;
    } else if (entry.pendingSinceMonotonic === null) {
      entry.pendingSinceMonotonic = now;
      entry.pendingOldestEnqueuedAt = null;
    }
  }

  #refreshMailboxState(entry: ModuleEntry): void {
    if (!entry.mailboxStateAvailable) return;
    const overCount = entry.resident.residentCount >= entry.maxResidentCount;
    const overBytes = entry.resident.residentBytes >= entry.maxResidentBytes;
    if (overCount || overBytes) {
      entry.mailboxFull = true;
      return;
    }
    if (!entry.mailboxFull) return;
    const resumeCount = Math.floor(entry.maxResidentCount * this.#lowWatermarkRatio);
    const resumeBytes = Math.floor(entry.maxResidentBytes * this.#lowWatermarkRatio);
    entry.mailboxFull =
      entry.resident.residentCount > resumeCount || entry.resident.residentBytes > resumeBytes;
  }

  #downstreamPressure(entry: ModuleEntry): readonly DownstreamPressure[] {
    return entry.downstreamIds.map((moduleId) => {
      const downstream = this.#entries.get(moduleId)!;
      const availability: DownstreamAvailability = !downstream.mailboxStateAvailable
        ? "unknown"
        : downstream.mailboxFull
          ? "blocked"
          : "available";
      return deepFreeze({
        moduleId,
        availability,
        pendingCount: downstream.pending.pendingCount,
        pendingBytes: downstream.pending.pendingBytes,
        residentCount: downstream.resident.residentCount,
        residentBytes: downstream.resident.residentBytes,
        maxResidentCount: downstream.maxResidentCount,
        maxResidentBytes: downstream.maxResidentBytes,
      });
    });
  }

  #oldestPendingAgeMs(entry: ModuleEntry, now: number): number {
    if (entry.pendingSinceMonotonic === null) return 0;
    return Math.max(0, now - entry.pendingSinceMonotonic);
  }

  #buildSnapshot(entry: ModuleEntry, now: number): SchedulerSnapshot {
    return deepFreeze({
      moduleId: entry.moduleId,
      moduleGenerationId: entry.runtime.moduleGenerationId,
      activationMode: entry.activation.kind,
      monotonicNow: now,
      actorBusy: entry.inFlight !== null,
      pendingCount: entry.pending.pendingCount,
      pendingBytes: entry.pending.pendingBytes,
      oldestPendingAgeMs: this.#oldestPendingAgeMs(entry, now),
      arrivalsDuringLastRunCount: entry.arrivalsDuringLastRunCount,
      arrivalsDuringLastRunBytes: entry.arrivalsDuringLastRunBytes,
      retryCount: entry.retryCount,
      ...(entry.lastFailureAt === null ? {} : { lastFailureAt: entry.lastFailureAt }),
      ...(entry.lastRunStartedAt === null ? {} : { lastRunStartedAt: entry.lastRunStartedAt }),
      ...(entry.lastRunServiceTimeMs === null
        ? {}
        : { lastRunServiceTimeMs: entry.lastRunServiceTimeMs }),
      ...(entry.activation.kind === "periodic"
        ? {
            periodMs: entry.activation.periodMs,
            allowEmptyPeriodicInput: entry.activation.allowEmptyInput,
          }
        : {}),
      downstream: this.#downstreamPressure(entry),
    });
  }

  #summarize(snapshot: SchedulerSnapshot): SchedulerSnapshotSummary {
    return {
      pendingCount: snapshot.pendingCount,
      pendingBytes: snapshot.pendingBytes,
      actorBusy: snapshot.actorBusy,
      oldestPendingAgeMs: snapshot.oldestPendingAgeMs,
      retryCount: snapshot.retryCount,
      blockedDownstreamIds: snapshot.downstream
        .filter((pressure) => pressure.availability !== "available")
        .map((pressure) => pressure.moduleId),
    };
  }

  #evaluate(entry: ModuleEntry, now: number): void {
    // Gates the scheduler owns, checked before any policy runs. None of them is
    // delegable: Section 13.1 forbids a policy from starting a second run for a
    // busy actor or bypassing a mailbox limit.
    if (entry.quarantineReason !== null) {
      this.#recordReason(entry, false, "QUARANTINED", null);
      return;
    }
    if (entry.inFlight !== null) {
      this.#recordReason(entry, false, "ACTOR_BUSY", null);
      return;
    }
    if (!entry.mailboxStateAvailable) {
      this.#recordReason(entry, false, "MAILBOX_STATE_UNAVAILABLE", null);
      return;
    }
    if (entry.nextEligibleAt !== null && now < entry.nextEligibleAt) {
      this.#recordReason(
        entry,
        false,
        entry.retryCount > 0 ? "SCHEDULER_RETRY_BACKOFF" : "SCHEDULER_DEFERRED",
        null,
      );
      return;
    }
    if (this.#activeCount >= this.#maxConcurrentModules) {
      this.#recordReason(entry, false, "INSTANCE_CONCURRENCY_LIMIT", null);
      return;
    }

    const snapshot = this.#buildSnapshot(entry, now);
    if (entry.outputCommitWaiting) {
      const blockedBy = snapshot.downstream
        .filter((pressure) => pressure.availability !== "available")
        .map((pressure) => pressure.moduleId);
      entry.blockingDownstreamIds = blockedBy;
      const decision: SchedulerDecision = deepFreeze({
        eligible: blockedBy.length === 0,
        eligibleAt: blockedBy.length === 0 ? now : null,
        claimLimitCount: this.#claimLimitCount,
        claimLimitBytes: this.#claimLimitBytes,
        reasonCode:
          blockedBy.length === 0 ? "OUTPUT_COMMIT_RESUME" : "DOWNSTREAM_BACKPRESSURE",
        policyName: "scheduler-output-commit",
        policyVersion: "1",
      });
      if (blockedBy.length > 0) {
        this.#applyBackpressure(entry, blockedBy, now, snapshot, decision);
        return;
      }
      this.#exitBackpressure(entry);
      this.#recordReason(entry, true, decision.reasonCode, snapshot, decision);
      this.#dispatch(entry, decision, snapshot, now);
      return;
    }
    const decision = this.#decide(entry, snapshot);
    if (decision === null) return;
    entry.lastPolicyName = decision.policyName;
    entry.lastPolicyVersion = decision.policyVersion;

    const blockedBy = snapshot.downstream
      .filter((pressure) => pressure.availability !== "available")
      .map((pressure) => pressure.moduleId);
    entry.blockingDownstreamIds = blockedBy;

    // The mailbox bound is enforced here, after the decision, so that a policy
    // that returns `eligible` while a consumer is at its bound still cannot
    // produce into it.
    if (blockedBy.length > 0) {
      this.#applyBackpressure(entry, blockedBy, now, snapshot, decision);
      return;
    }
    this.#exitBackpressure(entry);

    if (!decision.eligible) {
      this.#recordReason(entry, false, decision.reasonCode, snapshot, decision);
      if (decision.eligibleAt !== null && decision.eligibleAt > now) {
        entry.nextEligibleAt = decision.eligibleAt;
      }
      return;
    }

    this.#recordReason(entry, true, decision.reasonCode, snapshot, decision);
    this.#dispatch(entry, decision, snapshot, now);
  }

  /** Returns null when the Module must not be scheduled at all this pass. */
  #decide(entry: ModuleEntry, snapshot: SchedulerSnapshot): SchedulerDecision | null {
    try {
      return this.#validateDecision(this.#policy.decide(snapshot));
    } catch (error) {
      entry.counters.policyFailures += 1;
      this.#emitModule(entry, {
        type: "scheduler.policy_failed",
        action: this.#onPolicyFailure,
        errorMessage: errorMessage(error),
      });
      if (this.#onPolicyFailure === "quarantine") {
        this.#quarantine(entry, "SCHEDULER_POLICY_FAILED");
        return null;
      }
      if (this.#policy === this.#fallbackPolicy) {
        // The declared safe policy is the one that failed; fail visibly rather
        // than dispatch on an unknown decision.
        this.#recordReason(entry, false, "POLICY_UNAVAILABLE", snapshot);
        return null;
      }
      try {
        return this.#validateDecision(this.#fallbackPolicy.decide(snapshot));
      } catch (fallbackError) {
        entry.counters.policyFailures += 1;
        this.#emitModule(entry, {
          type: "scheduler.policy_failed",
          action: this.#onPolicyFailure,
          errorMessage: errorMessage(fallbackError),
        });
        this.#recordReason(entry, false, "POLICY_UNAVAILABLE", snapshot);
        return null;
      }
    }
  }

  #validateDecision(decision: SchedulerDecision): SchedulerDecision {
    if (
      decision === null ||
      typeof decision !== "object" ||
      typeof decision.eligible !== "boolean" ||
      typeof decision.reasonCode !== "string" ||
      typeof decision.policyName !== "string" ||
      typeof decision.policyVersion !== "string" ||
      (decision.eligibleAt !== null && !Number.isFinite(decision.eligibleAt)) ||
      !Number.isSafeInteger(decision.claimLimitCount) ||
      decision.claimLimitCount <= 0 ||
      decision.claimLimitCount > this.#claimLimitCount ||
      !Number.isSafeInteger(decision.claimLimitBytes) ||
      decision.claimLimitBytes <= 0 ||
      decision.claimLimitBytes > this.#claimLimitBytes ||
      (decision.missedPeriods !== undefined &&
        (!Number.isSafeInteger(decision.missedPeriods) || decision.missedPeriods < 0))
    ) {
      throw new TypeError("Scheduler policy returned an invalid decision");
    }
    return decision;
  }

  #applyBackpressure(
    entry: ModuleEntry,
    blockedBy: readonly string[],
    now: number,
    snapshot: SchedulerSnapshot,
    decision: SchedulerDecision,
  ): void {
    entry.counters.backpressureBlocked += 1;
    if (!entry.backpressured) {
      entry.backpressured = true;
      this.#emitModule(entry, {
        type: "scheduler.backpressure_entered",
        action: this.#backpressureAction,
        blockedBy,
      });
    }
    if (this.#backpressureAction === "delay-upstream") {
      entry.nextEligibleAt = now + this.#downstreamRecheckMs;
    }
    if (this.#backpressureAction === "reject-upstream-run") {
      entry.counters.backpressureRejected += 1;
      this.#emitModule(entry, {
        type: "scheduler.backpressure_rejected",
        action: this.#backpressureAction,
        blockedBy,
        rejectedCount: entry.counters.backpressureRejected,
      });
    }
    this.#recordReason(entry, false, "DOWNSTREAM_BACKPRESSURE", snapshot, decision);
  }

  #exitBackpressure(entry: ModuleEntry): void {
    if (!entry.backpressured) return;
    entry.backpressured = false;
    this.#emitModule(entry, {
      type: "scheduler.backpressure_exited",
      action: this.#backpressureAction,
      blockedBy: [],
    });
  }

  #dispatch(
    entry: ModuleEntry,
    decision: SchedulerDecision,
    snapshot: SchedulerSnapshot,
    now: number,
  ): void {
    entry.counters.dispatched += 1;
    const missedPeriods = decision.missedPeriods ?? 0;
    entry.counters.missedPeriods += missedPeriods;
    entry.lastRunStartedAt = now;
    entry.dispatchPending = entry.pending;
    entry.dispatchClaimLimitCount = decision.claimLimitCount;
    entry.dispatchClaimLimitBytes = decision.claimLimitBytes;
    entry.nextEligibleAt = null;
    this.#activeCount += 1;
    this.#emitModule(entry, {
      type: "scheduler.dispatched",
      reasonCode: decision.reasonCode,
      claimLimitCount: decision.claimLimitCount,
      claimLimitBytes: decision.claimLimitBytes,
      missedPeriods,
      snapshot: this.#summarize(snapshot),
    });

    let tick: Promise<ReactiveModuleTickResult>;
    try {
      tick = entry.runtime.tick({
        claimLimitCount: decision.claimLimitCount,
        claimLimitBytes: decision.claimLimitBytes,
      });
    } catch (error) {
      tick = Promise.reject(error);
    }
    // `entry.inFlight` is assigned before the first await resumes, so the next
    // pass always observes a busy actor. It is cleared only inside settle.
    entry.inFlight = tick.then(
      (result) => {
        this.#settle(entry, result, null);
      },
      (error: unknown) => {
        this.#settle(entry, null, error);
      },
    );
  }

  #settle(entry: ModuleEntry, result: ReactiveModuleTickResult | null, error: unknown): void {
    const now = this.#clock.monotonicNow();
    const startedAt = entry.lastRunStartedAt ?? now;
    entry.lastRunServiceTimeMs = Math.max(0, now - startedAt);
    entry.inFlight = null;
    this.#activeCount = Math.max(0, this.#activeCount - 1);

    const status = result ? result.status : (errorCode(error) ?? "TICK_REJECTED");
    entry.lastTickStatus = status;
    this.#measureArrivals(entry, result);

    if (result) {
      this.#settleResult(entry, result, now);
    } else {
      this.#settleRejection(entry, error, now);
    }

    this.#emitModule(entry, {
      type: "scheduler.settled",
      tickStatus: status,
      serviceTimeMs: entry.lastRunServiceTimeMs,
    });
    this.#armEligibilityTimer(now);
    // Only a run that advanced the backlog earns an immediate re-evaluation.
    // Re-dispatching after an idle tick would spin: an idle result means the
    // claim found nothing, and nothing has changed since.
    if (result?.status === "committed" || result?.status === "dead-lettered") {
      this.#requestPass();
    }
  }

  #settleResult(entry: ModuleEntry, result: ReactiveModuleTickResult, now: number): void {
    switch (result.status) {
      case "idle":
        entry.counters.idleTicks += 1;
        return;
      case "committed":
        entry.counters.committed += 1;
        entry.outputCommitWaiting = false;
        this.#exitBackpressure(entry);
        entry.retryCount = 0;
        entry.retryDelayMs = 0;
        entry.retryJitterMs = 0;
        entry.lastSuccessAt = now;
        this.#recordProgress(now);
        return;
      case "output-backpressured":
        entry.counters.outputBackpressured += 1;
        entry.outputCommitWaiting = true;
        entry.backpressured = true;
        entry.blockingDownstreamIds = [...result.blockedConsumerIds];
        entry.lastFailureAt = now;
        entry.retryCount += 1;
        this.#scheduleRetry(entry, now);
        return;
      case "retry-scheduled":
        entry.counters.retryScheduled += 1;
        entry.lastFailureAt = now;
        entry.retryCount += 1;
        this.#scheduleRetry(entry, now);
        return;
      case "dead-lettered":
        // The Module job left the mailbox, so the backlog advanced even though
        // the outcome was a failure. Section 12 requires the dead letter to be
        // visible; it is counted here and reported in status.
        entry.counters.deadLettered += 1;
        entry.deadLetterCount += 1;
        entry.retryCount = 0;
        entry.retryDelayMs = 0;
        entry.retryJitterMs = 0;
        entry.lastFailureAt = now;
        this.#recordProgress(now);
        return;
      case "cancelled":
        entry.counters.cancelled += 1;
        return;
      case "recovery-required":
        // Section 14: an unknown outcome keeps its exact Claim. The scheduler
        // must not retry, replace, or otherwise touch it, so the Module is
        // quarantined until an operator resolves it.
        entry.counters.recoveryRequired += 1;
        entry.lastFailureAt = now;
        this.#quarantine(entry, `RECOVERY_REQUIRED:${result.reason}`);
        return;
    }
  }

  #settleRejection(entry: ModuleEntry, error: unknown, now: number): void {
    const code = errorCode(error);
    if (code === "RUNTIME_RECOVERY_REQUIRED" || code === "RUNTIME_FAILED") {
      entry.counters.recoveryRequired += 1;
      entry.lastFailureAt = now;
      this.#quarantine(entry, code);
      return;
    }
    if (code === "RUNTIME_STOPPING") {
      this.#quarantine(entry, code);
      return;
    }
    if (code === "RUNTIME_BUSY") {
      // The scheduler serializes dispatch itself, so a busy actor means another
      // caller drove the same runtime. That is an observable invariant
      // violation, not a retryable failure.
      entry.counters.invariantViolations += 1;
      this.#invariantViolationCount += 1;
      this.#emitModule(entry, {
        type: "scheduler.invariant_violation",
        violation: "CONCURRENT_TICK_DETECTED",
      });
    }
    entry.lastFailureAt = now;
    entry.retryCount += 1;
    this.#scheduleRetry(entry, now);
  }

  /**
   * Bounded exponential backoff with bounded, injectable jitter. The
   * exponential term is capped at `retryMaxMs`; jitter adds at most
   * `retryJitterRatio` of that term, and both values are reported so the delay
   * is observable rather than inferred (Section 11.4).
   */
  #scheduleRetry(entry: ModuleEntry, now: number): void {
    let delay = this.#retryBaseMs;
    for (let attempt = 1; attempt < entry.retryCount && delay < this.#retryMaxMs; attempt += 1) {
      delay = Math.min(this.#retryMaxMs, delay * 2);
    }
    let jitter = 0;
    if (this.#retryJitterRatio > 0) {
      const sample = this.#random();
      const bounded = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
      jitter = Math.round(bounded * this.#retryJitterRatio * delay);
    }
    entry.retryDelayMs = delay;
    entry.retryJitterMs = jitter;
    entry.nextEligibleAt = now + delay + jitter;
    this.#emitModule(entry, {
      type: "scheduler.retry_scheduled",
      retryCount: entry.retryCount,
      retryDelayMs: delay,
      retryJitterMs: jitter,
      nextEligibleAt: entry.nextEligibleAt,
    });
  }

  /**
   * Arrivals during the last run, used only as adaptive-policy input. When the
   * run acknowledged nothing the difference is exact; when it consumed a batch
   * the scheduler cannot see the claimed count, so it subtracts the largest
   * batch the policy could have claimed and reports a lower bound. The fixed
   * baseline never reads these fields.
   */
  #measureArrivals(entry: ModuleEntry, result: ReactiveModuleTickResult | null): void {
    const before = entry.dispatchPending;
    const claimLimitCount = entry.dispatchClaimLimitCount;
    const claimLimitBytes = entry.dispatchClaimLimitBytes;
    entry.dispatchPending = null;
    entry.dispatchClaimLimitCount = null;
    entry.dispatchClaimLimitBytes = null;
    if (!before || !entry.mailboxStateAvailable) return;
    let after: SchedulerPendingSnapshot;
    try {
      after = this.#deliveries.inspectPending(entry.moduleId, entry.inputPageIds);
    } catch {
      return;
    }
    const consumed =
      result !== null && (result.status === "committed" || result.status === "dead-lettered");
    if (!consumed) {
      entry.arrivalsDuringLastRunCount = Math.max(0, after.pendingCount - before.pendingCount);
      entry.arrivalsDuringLastRunBytes = Math.max(0, after.pendingBytes - before.pendingBytes);
      return;
    }
    const retainedCount = Math.max(
      0,
      before.pendingCount - (claimLimitCount ?? this.#claimLimitCount),
    );
    const retainedBytes = Math.max(
      0,
      before.pendingBytes - (claimLimitBytes ?? this.#claimLimitBytes),
    );
    entry.arrivalsDuringLastRunCount = Math.max(0, after.pendingCount - retainedCount);
    entry.arrivalsDuringLastRunBytes = Math.max(0, after.pendingBytes - retainedBytes);
  }

  #quarantine(entry: ModuleEntry, reason: string): void {
    if (entry.quarantineReason === reason) return;
    entry.quarantineReason = reason;
    entry.nextEligibleAt = null;
    this.#emitModule(entry, { type: "scheduler.quarantined", reason });
  }

  #recordProgress(now: number): void {
    this.#lastProgressAt = now;
    if (!this.#noProgressActive) return;
    this.#noProgressActive = false;
    this.#emit({
      type: "scheduler.no_progress_cleared",
      instanceId: this.#instanceId,
      monotonicAt: now,
      stalledForMs: 0,
    });
  }

  /**
   * Section 12: a bounded mailbox in a cyclic Page graph can create cyclic
   * wait, so a sustained no-progress state must be detected and the blocked
   * dependency edges exposed. The reported edges are the blocked subgraph; a
   * cycle appears in them directly.
   */
  #detectNoProgress(entries: readonly ModuleEntry[], now: number): void {
    const lastProgressAt = this.#lastProgressAt ?? now;
    const stalledForMs = now - lastProgressAt;
    const workWaiting = entries.some((entry) =>
      (entry.pending.pendingCount > 0 || entry.outputCommitWaiting) &&
      entry.quarantineReason === null &&
      !(
        entry.activation.kind === "periodic" &&
        !entry.backpressured &&
        entry.retryCount === 0 &&
        entry.nextEligibleAt !== null &&
        entry.nextEligibleAt > now
      )
    );
    if (this.#activeCount > 0 || !workWaiting || stalledForMs < this.#noProgressAfterMs) {
      return;
    }
    if (this.#noProgressActive) return;
    this.#noProgressActive = true;
    this.#emit({
      type: "scheduler.no_progress",
      instanceId: this.#instanceId,
      monotonicAt: now,
      stalledForMs,
      blockedEdges: entries
        .filter((entry) => entry.backpressured && entry.blockingDownstreamIds.length > 0)
        .map((entry) => ({
          moduleId: entry.moduleId,
          blockedBy: [...entry.blockingDownstreamIds],
        })),
    });
  }

  #recordReason(
    entry: ModuleEntry,
    eligible: boolean,
    reasonCode: string,
    snapshot: SchedulerSnapshot | null,
    decision?: SchedulerDecision,
  ): void {
    entry.lastDecisionReasonCode = reasonCode;
    const key = `${eligible ? "1" : "0"}:${reasonCode}`;
    // One event per state change rather than one per poll keeps the decision
    // stream bounded while still recording every transition.
    if (entry.lastEmittedDecisionKey === key) return;
    entry.lastEmittedDecisionKey = key;
    this.#emitModule(entry, {
      type: "scheduler.decision",
      eligible,
      reasonCode,
      policyName: decision?.policyName ?? entry.lastPolicyName ?? "scheduler",
      policyVersion: decision?.policyVersion ?? entry.lastPolicyVersion ?? "1",
      snapshot: snapshot
        ? this.#summarize(snapshot)
        : {
            pendingCount: entry.pending.pendingCount,
            pendingBytes: entry.pending.pendingBytes,
            actorBusy: entry.inFlight !== null,
            oldestPendingAgeMs: 0,
            retryCount: entry.retryCount,
            blockedDownstreamIds: entry.blockingDownstreamIds,
          },
    });
  }

  #statusOf(entry: ModuleEntry, now: number): SchedulerModuleStatus {
    const schedulingState: SchedulerModuleState =
      entry.quarantineReason !== null
        ? "quarantined"
        : entry.inFlight !== null
          ? "running"
          : entry.backpressured
            ? "backpressured"
            : entry.retryCount > 0 && entry.nextEligibleAt !== null && now < entry.nextEligibleAt
              ? "retry-backoff"
              : entry.activation.kind === "periodic" &&
                  entry.nextEligibleAt !== null &&
                  now < entry.nextEligibleAt
                ? "period-wait"
              : entry.pending.pendingCount > 0
                ? "eligible"
                : "idle";
    return deepFreeze({
      moduleId: entry.moduleId,
      moduleGenerationId: entry.runtime.moduleGenerationId,
      activationMode: entry.activation.kind,
      periodMs: entry.activation.kind === "periodic" ? entry.activation.periodMs : null,
      allowEmptyPeriodicInput:
        entry.activation.kind === "periodic" ? entry.activation.allowEmptyInput : null,
      schedulingState,
      policyName: entry.lastPolicyName,
      policyVersion: entry.lastPolicyVersion,
      pendingCount: entry.pending.pendingCount,
      pendingBytes: entry.pending.pendingBytes,
      claimedCount: entry.resident.claimedCount,
      claimedBytes: entry.resident.claimedBytes,
      residentCount: entry.resident.residentCount,
      residentBytes: entry.resident.residentBytes,
      maxResidentCount: entry.maxResidentCount,
      maxResidentBytes: entry.maxResidentBytes,
      oldestPendingAgeMs: this.#oldestPendingAgeMs(entry, now),
      mailboxFull: entry.mailboxFull,
      mailboxStateAvailable: entry.mailboxStateAvailable,
      backpressured: entry.backpressured,
      backpressureAction: entry.backpressured ? this.#backpressureAction : null,
      blockingDownstreamIds: [...entry.blockingDownstreamIds],
      retryCount: entry.retryCount,
      deadLetterCount: entry.deadLetterCount,
      retryDelayMs: entry.retryDelayMs,
      retryJitterMs: entry.retryJitterMs,
      nextEligibleAt: entry.nextEligibleAt,
      lastDecisionReasonCode: entry.lastDecisionReasonCode,
      lastTickStatus: entry.lastTickStatus,
      lastSuccessAt: entry.lastSuccessAt,
      lastFailureAt: entry.lastFailureAt,
      lastRunStartedAt: entry.lastRunStartedAt,
      lastServiceTimeMs: entry.lastRunServiceTimeMs,
      arrivalsDuringLastRunCount: entry.arrivalsDuringLastRunCount,
      arrivalsDuringLastRunBytes: entry.arrivalsDuringLastRunBytes,
      quarantineReason: entry.quarantineReason,
      counters: { ...entry.counters },
    });
  }

  #emitModule(entry: ModuleEntry, event: SchedulerModuleEventBody): void {
    let moduleGenerationId = "unknown";
    try {
      moduleGenerationId = entry.runtime.moduleGenerationId;
    } catch {
      // A runtime that cannot report its generation still produces an event.
    }
    this.#emit({
      ...event,
      instanceId: this.#instanceId,
      moduleId: entry.moduleId,
      moduleGenerationId,
    } as SchedulerEvent);
  }

  #emit(event: SchedulerEvent): void {
    if (!this.#onEvent) return;
    const monotonicAt =
      "monotonicAt" in event && typeof event.monotonicAt === "number"
        ? event.monotonicAt
        : this.#clock.monotonicNow();
    try {
      this.#onEvent(deepFreeze({ ...event, monotonicAt }) as SchedulerEvent);
    } catch {
      // An observer must never break the run loop.
    }
  }
}
