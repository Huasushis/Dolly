/**
 * Hot reload signalling for the Dolly Skill extension baseline.
 *
 * This is the piece that keeps hot reload legal. `docs/spec/core-runtime.md`
 * section 9.2.1 states that "a Module may propose replacement text only as part
 * of its serialized result. Background activity must enqueue an actor signal
 * before changing a description", and section 9.5 adds that background work
 * "MAY submit a bounded source activation request with a stable
 * `idempotencyKey`" and "MUST emit a Block only as the optional result of that
 * actor run".
 *
 * So this scheduler owns no catalog, holds no description, touches no
 * filesystem and calls nothing that could publish state. A directory watcher or
 * a verification timer calls `notifyChange`; the scheduler debounces and
 * coalesces those hints and submits at most one live source activation request.
 * Scanning the library and proposing the new description happen later, inside
 * the serialized actor Run that the runtime creates from that request.
 *
 * Duplicate suppression follows `docs/spec/core-runtime.md` section 11.3: the
 * `idempotencyKey` is stable for as long as one refresh is live, so a burst of
 * further changes cannot create a second Module job. The key only advances
 * after the runtime reports that refresh complete.
 */

export type SkillRefreshReason =
  | "initial"
  | "watcher-degraded"
  | "periodic-verification"
  | "filesystem-change";

/**
 * Coalescing precedence. A window that saw a degraded watcher must ask for the
 * stronger rescan even if ordinary change events arrived afterwards.
 */
const REASON_PRECEDENCE: readonly SkillRefreshReason[] = [
  "initial",
  "watcher-degraded",
  "periodic-verification",
  "filesystem-change",
];

function strongerReason(
  left: SkillRefreshReason | null,
  right: SkillRefreshReason,
): SkillRefreshReason {
  if (left === null) return right;
  return REASON_PRECEDENCE.indexOf(left) <= REASON_PRECEDENCE.indexOf(right)
    ? left
    : right;
}

export interface SkillSourceActivationRequest {
  readonly idempotencyKey: string;
  readonly moduleId: string;
  readonly reason: SkillRefreshReason;
  /** Monotonic sample, per `docs/spec/core-runtime.md` section 11.4. */
  readonly requestedAt: number;
  /** How many hints this request coalesced. */
  readonly signalCount: number;
}

export type SkillRefreshState = "created" | "running" | "stopped";

export interface SkillRefreshStatus {
  readonly state: SkillRefreshState;
  readonly epoch: number;
  readonly liveIdempotencyKey: string | null;
  readonly pendingSignalCount: number;
  readonly deferredSignalCount: number;
  readonly submittedRequestCount: number;
  readonly lastRequest: SkillSourceActivationRequest | null;
  readonly lastSubmitErrorMessage: string | null;
}

export type SkillRefreshErrorCode =
  | "SKILL_REFRESH_OPTIONS_INVALID"
  | "SKILL_REFRESH_STATE_INVALID";

export class SkillRefreshError extends Error {
  constructor(readonly code: SkillRefreshErrorCode, message: string) {
    super(message);
    this.name = "SkillRefreshError";
  }
}

/** Cancels a scheduled callback. Calling it twice must be safe. */
export type SkillRefreshTimerCancel = () => void;

export interface SkillRefreshSchedulerOptions {
  readonly moduleId: string;
  /** Monotonic clock. Deterministic tests inject a fake one. */
  readonly monotonicNow: () => number;
  /** Timer port. Deterministic tests inject a manually driven one. */
  readonly setTimer: (
    delayMs: number,
    callback: () => void,
  ) => SkillRefreshTimerCancel;
  readonly submitSourceActivation: (request: SkillSourceActivationRequest) => void;
  /**
   * Trailing debounce window. 500 ms coalesces the several write events an
   * editor or a checkout produces for one logical change while still reading as
   * an immediate reload.
   */
  readonly debounceMs?: number;
  /**
   * Maximum delay from the first hint of a window to its request. It bounds
   * starvation when changes never stop arriving; 5 s is ten debounce windows.
   */
  readonly maxDebounceMs?: number;
  /**
   * Periodic verification interval, or 0 to disable. It recovers from missed,
   * dropped, or unsupported watcher events. 5 minutes is frequent enough to
   * heal a broken watcher within one working session and rare enough that it
   * does not become a polling loop; it never overlaps a live refresh because it
   * shares the same idempotency key.
   */
  readonly periodicVerificationMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_DEBOUNCE_MS = 5000;
const DEFAULT_PERIODIC_VERIFICATION_MS = 300000;

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SkillRefreshError(
      "SKILL_REFRESH_OPTIONS_INVALID",
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

/**
 * Debounces filesystem hints and periodic verification into at most one live,
 * idempotent source activation request.
 */
export class SkillRefreshScheduler {
  readonly #moduleId: string;
  readonly #monotonicNow: () => number;
  readonly #setTimer: (delayMs: number, callback: () => void) => SkillRefreshTimerCancel;
  readonly #submitSourceActivation: (request: SkillSourceActivationRequest) => void;
  readonly #debounceMs: number;
  readonly #maxDebounceMs: number;
  readonly #periodicVerificationMs: number;

  #state: SkillRefreshState = "created";
  #epoch = 0;
  #liveIdempotencyKey: string | null = null;
  #pendingReason: SkillRefreshReason | null = null;
  #pendingSignalCount = 0;
  #windowStartedAt: number | null = null;
  #deferredReason: SkillRefreshReason | null = null;
  #deferredSignalCount = 0;
  #cancelDebounce: SkillRefreshTimerCancel | null = null;
  #cancelPeriodic: SkillRefreshTimerCancel | null = null;
  #submittedRequestCount = 0;
  #lastRequest: SkillSourceActivationRequest | null = null;
  #lastSubmitErrorMessage: string | null = null;

  constructor(options: SkillRefreshSchedulerOptions) {
    if (typeof options.moduleId !== "string" || options.moduleId.length === 0) {
      throw new SkillRefreshError(
        "SKILL_REFRESH_OPTIONS_INVALID",
        "moduleId must be a non-empty string",
      );
    }
    this.#moduleId = options.moduleId;
    this.#monotonicNow = options.monotonicNow;
    this.#setTimer = options.setTimer;
    this.#submitSourceActivation = options.submitSourceActivation;
    this.#debounceMs = requirePositiveInteger(
      options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      "debounceMs",
    );
    this.#maxDebounceMs = requirePositiveInteger(
      options.maxDebounceMs ?? DEFAULT_MAX_DEBOUNCE_MS,
      "maxDebounceMs",
    );
    if (this.#maxDebounceMs < this.#debounceMs) {
      throw new SkillRefreshError(
        "SKILL_REFRESH_OPTIONS_INVALID",
        "maxDebounceMs must not be smaller than debounceMs",
      );
    }
    const periodic = options.periodicVerificationMs ?? DEFAULT_PERIODIC_VERIFICATION_MS;
    if (!Number.isSafeInteger(periodic) || periodic < 0) {
      throw new SkillRefreshError(
        "SKILL_REFRESH_OPTIONS_INVALID",
        "periodicVerificationMs must be 0 or a positive safe integer",
      );
    }
    this.#periodicVerificationMs = periodic;
  }

  /**
   * Arms periodic verification and submits the first refresh request at once.
   * The first catalog is not worth a debounce delay: nothing has been published
   * yet, so there is nothing to coalesce with.
   */
  start(): void {
    if (this.#state !== "created") {
      throw new SkillRefreshError(
        "SKILL_REFRESH_STATE_INVALID",
        `start() is only legal from "created", not "${this.#state}"`,
      );
    }
    this.#state = "running";
    this.#armPeriodicVerification();
    this.#pendingReason = "initial";
    this.#pendingSignalCount = 1;
    this.#windowStartedAt = this.#monotonicNow();
    this.#submitPending();
  }

  /**
   * Records one hint. Watcher events are hints, not truth
   * (`docs/spec/skill-extension.md` section 6): this only schedules a request.
   * Returns `false` when the scheduler is not running.
   */
  notifyChange(reason: SkillRefreshReason = "filesystem-change"): boolean {
    if (this.#state !== "running") return false;

    if (this.#liveIdempotencyKey !== null) {
      // A refresh is already live. Remember that another one is owed instead of
      // creating a second Module job for the same library.
      this.#deferredReason = strongerReason(this.#deferredReason, reason);
      this.#deferredSignalCount += 1;
      return true;
    }

    this.#pendingReason = strongerReason(this.#pendingReason, reason);
    this.#pendingSignalCount += 1;
    const now = this.#monotonicNow();
    if (this.#windowStartedAt === null) this.#windowStartedAt = now;
    this.#armDebounce(now);
    return true;
  }

  /**
   * Reports that the actor Run created from `idempotencyKey` finished, so the
   * next change may open a new job. A key that is not the live one is a stale
   * completion and changes nothing.
   */
  completeRefresh(idempotencyKey: string): boolean {
    if (this.#state !== "running") return false;
    if (this.#liveIdempotencyKey === null || this.#liveIdempotencyKey !== idempotencyKey) {
      return false;
    }

    this.#liveIdempotencyKey = null;
    this.#epoch += 1;

    if (this.#deferredReason !== null) {
      this.#pendingReason = strongerReason(this.#pendingReason, this.#deferredReason);
      this.#pendingSignalCount += this.#deferredSignalCount;
      this.#deferredReason = null;
      this.#deferredSignalCount = 0;
      const now = this.#monotonicNow();
      this.#windowStartedAt = now;
      this.#armDebounce(now);
    }
    return true;
  }

  /**
   * Cancels timers and permits no further request. Idempotent, per
   * `docs/spec/core-runtime.md` section 10.
   */
  stop(): void {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    this.#cancelDebounce?.();
    this.#cancelDebounce = null;
    this.#cancelPeriodic?.();
    this.#cancelPeriodic = null;
    this.#liveIdempotencyKey = null;
    this.#pendingReason = null;
    this.#pendingSignalCount = 0;
    this.#deferredReason = null;
    this.#deferredSignalCount = 0;
    this.#windowStartedAt = null;
  }

  status(): SkillRefreshStatus {
    return {
      state: this.#state,
      epoch: this.#epoch,
      liveIdempotencyKey: this.#liveIdempotencyKey,
      pendingSignalCount: this.#pendingSignalCount,
      deferredSignalCount: this.#deferredSignalCount,
      submittedRequestCount: this.#submittedRequestCount,
      lastRequest: this.#lastRequest,
      lastSubmitErrorMessage: this.#lastSubmitErrorMessage,
    };
  }

  #armDebounce(now: number): void {
    this.#cancelDebounce?.();
    const elapsed = this.#windowStartedAt === null ? 0 : now - this.#windowStartedAt;
    const remainingMaxWait = Math.max(0, this.#maxDebounceMs - elapsed);
    const delay = Math.min(this.#debounceMs, remainingMaxWait);
    this.#cancelDebounce = this.#setTimer(delay, () => {
      this.#cancelDebounce = null;
      this.#submitPending();
    });
  }

  #armPeriodicVerification(): void {
    if (this.#periodicVerificationMs === 0) return;
    this.#cancelPeriodic = this.#setTimer(this.#periodicVerificationMs, () => {
      this.#cancelPeriodic = null;
      if (this.#state !== "running") return;
      this.#armPeriodicVerification();
      this.notifyChange("periodic-verification");
    });
  }

  #submitPending(): void {
    if (this.#state !== "running") return;
    if (this.#pendingReason === null) return;
    if (this.#liveIdempotencyKey !== null) return;

    const request: SkillSourceActivationRequest = {
      idempotencyKey: `skill-refresh:${this.#moduleId}:${this.#epoch}`,
      moduleId: this.#moduleId,
      reason: this.#pendingReason,
      requestedAt: this.#monotonicNow(),
      signalCount: this.#pendingSignalCount,
    };

    this.#liveIdempotencyKey = request.idempotencyKey;
    this.#pendingReason = null;
    this.#pendingSignalCount = 0;
    this.#windowStartedAt = null;

    try {
      this.#submitSourceActivation(request);
    } catch (error) {
      // The runtime refused the request. Nothing was published, so put the
      // window back and let the next hint or the periodic verification retry.
      // No self-driven retry loop is started here.
      this.#liveIdempotencyKey = null;
      this.#pendingReason = request.reason;
      this.#pendingSignalCount = request.signalCount;
      this.#lastSubmitErrorMessage = error instanceof Error ? error.message : String(error);
      return;
    }

    this.#submittedRequestCount += 1;
    this.#lastRequest = request;
    this.#lastSubmitErrorMessage = null;
  }
}
