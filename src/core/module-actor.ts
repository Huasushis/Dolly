import type { DollyModuleIsolation } from "./runtime-config.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ModuleActorState =
  | "created"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";
export type ModuleRunPhase = "executing" | "accepting-result";
export type ModuleCancellationReason = "soft-timeout" | "hard-timeout" | "shutdown";

/**
 * A Run is one execution attempt for a ModuleJob. A retry keeps the
 * `moduleJobId` and receives a new `runId` so late results can be rejected.
 */
export interface ModuleRunRequest<Input> {
  readonly moduleGenerationId: string;
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly input: Input;
}

export interface ModuleRunContext {
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly startedAt: number;
  readonly signal: AbortSignal;
}

export interface TerminationContext {
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  readonly moduleJobId?: string;
  readonly runId?: string;
}

export interface ModuleCancellationContext extends TerminationContext {
  readonly moduleJobId: string;
  readonly runId: string;
  readonly reason: ModuleCancellationReason;
}

export interface ModuleExecutor<Input, Output> {
  /**
   * The trusted host declares the Module configuration's `isolation` mode.
   * `process` runs Module code in a separate operating-system process so it
   * cannot block Core's event loop; it does not claim a permission sandbox.
   * An omitted value is treated as `none` for cooperative actor uses.
   */
  readonly isolation?: DollyModuleIsolation;
  /**
   * For process isolation, creates the operating-system process and completes
   * authentication and initialization after the factory has returned a handle.
   */
  start?(): Promise<void>;
  execute(input: Input, context: ModuleRunContext): Promise<Output>;
  cancel?(context: ModuleCancellationContext): void | Promise<void>;
  /**
   * Requests cooperative shutdown and resolves after a non-process executor is
   * stopped. If `start()` is still running, it must prevent that operation
   * from reopening resources after `stop()` resolves. This operation is not
   * proof that an operating-system process exited.
   */
  stop?(): Promise<void>;
  /**
   * Resolves only after the executor is stopped and an unfinished `start()`
   * operation cannot reopen its resources. For `isolation: "process"`, this
   * additionally means the result channel is closed, the process has exited,
   * host-issued capabilities are revoked, and in-flight capability handlers
   * have settled. After a rejected call, a later call must be safe because the
   * rejection does not confirm that termination occurred.
   */
  terminate?(context: TerminationContext): Promise<void>;
}

// A Module executor throws this error only after its result channel is closed,
// its main process (when present) has exited, its host-issued capabilities are
// revoked, and every capability handler invocation has settled. The actor may
// then replace it without accepting a late result; a distinct error type is
// required because ordinary execution errors prove none of these conditions.
// This contract does not claim to stop subprocesses that a trusted Extension
// created with ambient operating-system authority.
export class ModuleExecutorTerminatedError extends Error {
  constructor(message = "Module executor stopped before completing the run") {
    super(message);
    this.name = "ModuleExecutorTerminatedError";
  }
}

// An executor host throws this error when the executor is unusable but cannot
// confirm the termination conditions documented above. The actor must fail and
// must not replace that executor. A separate type is required because an
// ordinary execution error permits reuse while ModuleExecutorTerminatedError
// permits replacement.
export class ModuleExecutorTerminationUnconfirmedError extends Error {
  constructor(message = "Module executor termination could not be confirmed") {
    super(message);
    this.name = "ModuleExecutorTerminationUnconfirmedError";
  }
}

export interface ModuleRunIdentity {
  readonly moduleId: string;
  readonly moduleGenerationId: string;
  readonly moduleJobId: string;
  readonly runId: string;
  readonly attempt: number;
}

export type ModuleRunFailureCode =
  | "MODULE_EXECUTION_FAILED"
  | "EXECUTOR_TERMINATION_UNCONFIRMED"
  | "OUTPUT_SNAPSHOT_FAILED"
  | "RESULT_ACCEPTANCE_UNCERTAIN";

export interface ModuleRunFailure {
  readonly code: ModuleRunFailureCode;
  readonly message: string;
  readonly retrySafe: boolean;
}

export type ModuleRunOutcome<Output> =
  | (ModuleRunIdentity & { readonly status: "succeeded"; readonly output: Output })
  | (ModuleRunIdentity & { readonly status: "failed"; readonly error: ModuleRunFailure })
  | (ModuleRunIdentity & {
      readonly status: "cancelled";
      readonly reason: "shutdown";
    })
  | (ModuleRunIdentity & {
      readonly status: "timed-out" | "fenced";
    });

export interface ModuleActiveRunStatus extends ModuleRunIdentity {
  readonly phase: ModuleRunPhase;
  readonly cancellationRequested: boolean;
}

export type ModuleActorEvent = ModuleRunIdentity &
  (
    | { readonly type: "run.started"; readonly startedAt: number }
    | {
        readonly type: "run.cancellation_requested";
        readonly reason: ModuleCancellationReason;
      }
    | {
        readonly type: "run.completed";
        readonly status: Exclude<ModuleRunOutcome<unknown>["status"], "cancelled">;
      }
    | { readonly type: "run.completed"; readonly status: "cancelled"; readonly reason: "shutdown" }
    | { readonly type: "run.stale_result" }
  );

export type ModuleActorErrorCode =
  | "ACTOR_ID_INVALID"
  | "ACTOR_INPUT_INVALID"
  | "ACTOR_INPUT_TOO_LARGE"
  | "ACTOR_QUEUE_FULL"
  | "ACTOR_QUEUE_BYTES_FULL"
  | "ACTOR_NOT_STARTED"
  | "ACTOR_STOPPING"
  | "ACTOR_STOPPED"
  | "ACTOR_FAILED"
  | "MODULE_JOB_ALREADY_ACTIVE"
  | "RUN_NOT_ACTIVE"
  | "RUN_NOT_EXECUTING"
  | "RUN_LIMIT_REACHED"
  | "HARD_TIMEOUT_UNAVAILABLE"
  | "MODULE_GENERATION_CONFLICT"
  | "MODULE_GENERATION_FENCED"
  | "MODULE_GENERATION_LIMIT_REACHED"
  | "STOP_INCOMPLETE";

export class ModuleActorError extends Error {
  constructor(readonly code: ModuleActorErrorCode, message: string) {
    super(message);
    this.name = "ModuleActorError";
  }
}

export interface ModuleActorOptions<Input, Output> {
  readonly moduleId: string;
  readonly initialModuleGenerationId: string;
  readonly maxQueuedRuns: number;
  readonly maxQueuedInputBytes: number;
  readonly maxInputBytes: number;
  readonly maxRunsPerGeneration: number;
  readonly maxGenerations: number;
  /** Reject executors that cannot confirm termination from process isolation. */
  readonly requireProcessIsolation?: boolean;
  /** Maximum wait for a process-isolated executor to finish initialization. */
  readonly initializationTimeoutMs?: number;
  /** Maximum wait for a process-isolated executor to confirm termination. */
  readonly terminationTimeoutMs?: number;
  readonly nextModuleGenerationId: () => string;
  readonly monotonicNow: () => number;
  readonly snapshotInput: (input: Input) => Input;
  readonly measureInputBytes: (input: Input) => number;
  readonly snapshotOutput: (output: Output) => Output;
  /**
   * With required process isolation, synchronously constructs and returns only
   * a terminable handle. It must not create an operating-system process; the
   * executor's `start()` operation performs creation and initialization. A
   * separate process alone is not proof of a security sandbox.
   */
  readonly createExecutor: (
    moduleGenerationId: string,
  ) => ModuleExecutor<Input, Output> | Promise<ModuleExecutor<Input, Output>>;
  readonly acceptResult: (output: Output, context: ModuleRunContext) => void | Promise<void>;
  readonly onEvent?: (event: ModuleActorEvent) => void;
}

export interface ModuleStopOptions {
  // A starting executor or active run must receive a finite grace period before
  // the actor attempts confirmed termination. Omitting it never permits an
  // unbounded shutdown wait.
  readonly cancellationGraceMs?: number;
  readonly signal?: AbortSignal;
}

interface PendingRun<Input, Output> {
  readonly request: ModuleRunRequest<Input>;
  readonly inputBytes: number;
  readonly resolve: (outcome: ModuleRunOutcome<Output>) => void;
  readonly reject: (error: ModuleActorError) => void;
}

interface ActiveRun<Input, Output> {
  readonly pending: PendingRun<Input, Output>;
  readonly executor: ModuleExecutor<Input, Output>;
  readonly context: ModuleRunContext;
  readonly controller: AbortController;
  phase: ModuleRunPhase;
  cancellationRequested: boolean;
  timedOut: boolean;
  hardTimeoutPending: boolean;
  completionWhileFencing: boolean;
  staleResultReported: boolean;
  settled: boolean;
}

function assertId(value: string, label: string): void {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ModuleActorError("ACTOR_ID_INVALID", `${label} is not a valid identifier`);
  }
}

function assertNonNegativeLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function validateExecutor<Input, Output>(
  executor: unknown,
  requireProcessIsolation: boolean,
  initializationTimeoutMs: number | undefined,
  terminationTimeoutMs: number | undefined,
): ModuleExecutor<Input, Output> {
  const candidate = executor as Partial<ModuleExecutor<Input, Output>> | null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.execute !== "function" ||
    (candidate.isolation !== undefined &&
      candidate.isolation !== "none" &&
      candidate.isolation !== "process" &&
      candidate.isolation !== "sandbox") ||
    (candidate.start !== undefined && typeof candidate.start !== "function") ||
    (candidate.cancel !== undefined && typeof candidate.cancel !== "function") ||
    (candidate.stop !== undefined && typeof candidate.stop !== "function") ||
    (candidate.terminate !== undefined && typeof candidate.terminate !== "function")
  ) {
    throw new ModuleActorError("ACTOR_FAILED", "Executor factory returned an invalid executor");
  }
  if (
    requireProcessIsolation &&
    (candidate.isolation !== "process" ||
      typeof candidate.start !== "function" ||
      typeof candidate.terminate !== "function")
  ) {
    throw new ModuleActorError(
      "ACTOR_FAILED",
      "Executor factory did not provide process isolation with confirmed termination",
    );
  }
  if (
    candidate.isolation === "process" &&
    (typeof candidate.start !== "function" ||
      typeof candidate.terminate !== "function" ||
      initializationTimeoutMs === undefined ||
      terminationTimeoutMs === undefined)
  ) {
    throw new ModuleActorError(
      "ACTOR_FAILED",
      "A process-isolated executor requires bounded initialization and confirmed termination",
    );
  }
  return candidate as ModuleExecutor<Input, Output>;
}

function runFailure(
  code: ModuleRunFailureCode,
  message: string,
  retrySafe: boolean,
): ModuleRunFailure {
  return Object.freeze({ code, message, retrySafe });
}

export class ModuleActor<Input, Output> {
  readonly #moduleId: string;
  readonly #maxQueuedRuns: number;
  readonly #maxQueuedInputBytes: number;
  readonly #maxInputBytes: number;
  readonly #maxRunsPerGeneration: number;
  readonly #maxGenerations: number;
  readonly #requireProcessIsolation: boolean;
  readonly #initializationTimeoutMs: number | undefined;
  readonly #terminationTimeoutMs: number | undefined;
  readonly #nextModuleGenerationId: () => string;
  readonly #monotonicNow: () => number;
  readonly #snapshotInput: (input: Input) => Input;
  readonly #measureInputBytes: (input: Input) => number;
  readonly #snapshotOutput: (output: Output) => Output;
  readonly #createExecutor: ModuleActorOptions<Input, Output>["createExecutor"];
  readonly #acceptResult: ModuleActorOptions<Input, Output>["acceptResult"];
  readonly #onEvent: ModuleActorOptions<Input, Output>["onEvent"];
  readonly #pending: Array<PendingRun<Input, Output>> = [];
  readonly #liveModuleJobIds = new Set<string>();
  readonly #liveRunIds = new Set<string>();
  readonly #usedRunIds = new Set<string>();
  readonly #usedModuleGenerationIds = new Set<string>();
  readonly #idleWaiters = new Set<() => void>();
  #moduleGenerationId: string;
  #executor: ModuleExecutor<Input, Output> | undefined;
  #executorTerminated = false;
  #executorTerminationUnconfirmed = false;
  #unconfirmedExecutor: ModuleExecutor<Input, Output> | undefined;
  #unconfirmedExecutorContext: TerminationContext | undefined;
  #executorTerminatePromise: Promise<void> | undefined;
  readonly #executorTerminationOperations = new WeakMap<
    ModuleExecutor<Input, Output>,
    Promise<void>
  >();
  #executorStopPromise: Promise<void> | undefined;
  #startPromise: Promise<void> | undefined;
  #startingExecutor: ModuleExecutor<Input, Output> | undefined;
  #startingExecutorModuleGenerationId: string | undefined;
  #startingExecutorStartAttempted = false;
  #startingExecutorCleanupPromise: Promise<boolean> | undefined;
  #starting: PendingRun<Input, Output> | undefined;
  #active: ActiveRun<Input, Output> | undefined;
  #state: ModuleActorState = "created";
  #shutdownPromise: Promise<void> | undefined;
  #hardTimeoutPromise: Promise<"module-generation-fenced"> | undefined;
  #replacementPromise: Promise<"module-generation-fenced"> | undefined;
  #pendingBytes = 0;
  #runsInModuleGeneration = 0;
  #pumping = false;

  constructor(options: ModuleActorOptions<Input, Output>) {
    assertId(options.moduleId, "moduleId");
    assertId(options.initialModuleGenerationId, "initialModuleGenerationId");
    assertNonNegativeLimit(options.maxQueuedRuns, "maxQueuedRuns");
    assertNonNegativeLimit(options.maxQueuedInputBytes, "maxQueuedInputBytes");
    assertNonNegativeLimit(options.maxInputBytes, "maxInputBytes");
    assertPositiveLimit(options.maxRunsPerGeneration, "maxRunsPerGeneration");
    assertPositiveLimit(options.maxGenerations, "maxGenerations");
    if (
      options.requireProcessIsolation !== undefined &&
      typeof options.requireProcessIsolation !== "boolean"
    ) {
      throw new TypeError("requireProcessIsolation must be boolean when provided");
    }
    if (
      options.initializationTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.initializationTimeoutMs) ||
        options.initializationTimeoutMs <= 0 ||
        options.initializationTimeoutMs > MAX_TIMER_DELAY_MS)
    ) {
      throw new TypeError(
        "initializationTimeoutMs must be a positive integer within the supported timer range",
      );
    }
    if (
      options.terminationTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.terminationTimeoutMs) ||
        options.terminationTimeoutMs <= 0 ||
        options.terminationTimeoutMs > MAX_TIMER_DELAY_MS)
    ) {
      throw new TypeError(
        "terminationTimeoutMs must be a positive integer within the supported timer range",
      );
    }
    if (
      options.requireProcessIsolation === true &&
      options.initializationTimeoutMs === undefined
    ) {
      throw new TypeError(
        "initializationTimeoutMs is required when requireProcessIsolation is true",
      );
    }
    if (options.requireProcessIsolation === true && options.terminationTimeoutMs === undefined) {
      throw new TypeError(
        "terminationTimeoutMs is required when requireProcessIsolation is true",
      );
    }
    for (const [label, value] of [
      ["nextModuleGenerationId", options.nextModuleGenerationId],
      ["monotonicNow", options.monotonicNow],
      ["snapshotInput", options.snapshotInput],
      ["measureInputBytes", options.measureInputBytes],
      ["snapshotOutput", options.snapshotOutput],
      ["createExecutor", options.createExecutor],
      ["acceptResult", options.acceptResult],
    ] as const) {
      if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
    }
    if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
      throw new TypeError("onEvent must be a function when provided");
    }

    this.#moduleId = options.moduleId;
    this.#maxQueuedRuns = options.maxQueuedRuns;
    this.#maxQueuedInputBytes = options.maxQueuedInputBytes;
    this.#maxInputBytes = options.maxInputBytes;
    this.#maxRunsPerGeneration = options.maxRunsPerGeneration;
    this.#maxGenerations = options.maxGenerations;
    this.#requireProcessIsolation = options.requireProcessIsolation ?? false;
    this.#initializationTimeoutMs = options.initializationTimeoutMs;
    this.#terminationTimeoutMs = options.terminationTimeoutMs;
    this.#nextModuleGenerationId = options.nextModuleGenerationId;
    this.#monotonicNow = options.monotonicNow;
    this.#snapshotInput = options.snapshotInput;
    this.#measureInputBytes = options.measureInputBytes;
    this.#snapshotOutput = options.snapshotOutput;
    this.#createExecutor = options.createExecutor;
    this.#acceptResult = options.acceptResult;
    this.#onEvent = options.onEvent;
    this.#moduleGenerationId = options.initialModuleGenerationId;
    this.#usedModuleGenerationIds.add(options.initialModuleGenerationId);
  }

  get state(): ModuleActorState {
    return this.#state;
  }

  get moduleGenerationId(): string {
    return this.#moduleGenerationId;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  get activeRun(): Readonly<ModuleActiveRunStatus> | null {
    if (!this.#active) return null;
    return Object.freeze({
      ...this.#identity(this.#active),
      phase: this.#active.phase,
      cancellationRequested: this.#active.cancellationRequested,
    });
  }

  start(): Promise<void> {
    if (this.#state === "running") return Promise.resolve();
    if (this.#state === "starting" && this.#startPromise) return this.#startPromise;
    if (this.#state === "stopping") {
      return Promise.reject(new ModuleActorError("ACTOR_STOPPING", "Module actor is stopping"));
    }
    if (this.#state === "stopped") {
      return Promise.reject(new ModuleActorError("ACTOR_STOPPED", "Module actor is stopped"));
    }
    if (this.#state === "failed") {
      return Promise.reject(new ModuleActorError("ACTOR_FAILED", "Module actor is failed"));
    }

    this.#state = "starting";
    const start = Promise.resolve().then(() => this.#performStart());
    this.#startPromise = start;
    void start.then(
      () => {
        if (this.#startPromise === start) this.#startPromise = undefined;
      },
      () => {
        if (this.#startPromise === start) this.#startPromise = undefined;
      },
    );
    return start;
  }

  submit(request: ModuleRunRequest<Input>): Promise<ModuleRunOutcome<Output>> {
    let snapshot: Input;
    let inputBytes: number;
    try {
      this.#assertCanSubmit();
      assertId(request.moduleGenerationId, "moduleGenerationId");
      assertId(request.moduleJobId, "moduleJobId");
      assertId(request.runId, "runId");
      if (request.moduleGenerationId !== this.#moduleGenerationId) {
        throw new ModuleActorError(
          "MODULE_GENERATION_CONFLICT",
          `Run belongs to Module generation ${request.moduleGenerationId}, not ${this.#moduleGenerationId}`,
        );
      }
      if (!Number.isSafeInteger(request.attempt) || request.attempt <= 0) {
        throw new ModuleActorError("ACTOR_ID_INVALID", "attempt must be a positive integer");
      }
      if (this.#liveModuleJobIds.has(request.moduleJobId)) {
        throw new ModuleActorError(
          "MODULE_JOB_ALREADY_ACTIVE",
          `Module job ${request.moduleJobId} already has a live run or mailbox entry`,
        );
      }
      if (this.#liveRunIds.has(request.runId) || this.#usedRunIds.has(request.runId)) {
        throw new ModuleActorError(
          "ACTOR_ID_INVALID",
          `Run ID ${request.runId} has already been submitted to this actor`,
        );
      }
      const reservedRuns =
        this.#runsInModuleGeneration + this.#pending.length + (this.#starting ? 1 : 0);
      if (reservedRuns >= this.#maxRunsPerGeneration) {
        throw new ModuleActorError(
          "RUN_LIMIT_REACHED",
          "Module generation reached its configured run limit",
        );
      }
      if ((this.#active || this.#pumping) && this.#pending.length >= this.#maxQueuedRuns) {
        throw new ModuleActorError("ACTOR_QUEUE_FULL", "Module actor mailbox is full");
      }
      try {
        snapshot = this.#snapshotInput(request.input);
        inputBytes = this.#measureInputBytes(snapshot);
      } catch {
        throw new ModuleActorError(
          "ACTOR_INPUT_INVALID",
          "Module input could not be snapshotted and measured",
        );
      }
      if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) {
        throw new ModuleActorError(
          "ACTOR_INPUT_INVALID",
          "Measured module input bytes must be a non-negative safe integer",
        );
      }
      if (inputBytes > this.#maxInputBytes) {
        throw new ModuleActorError(
          "ACTOR_INPUT_TOO_LARGE",
          "Module input exceeds the configured per-input byte limit",
        );
      }
      if ((this.#active || this.#pumping) && this.#pending.length >= this.#maxQueuedRuns) {
        throw new ModuleActorError("ACTOR_QUEUE_FULL", "Module actor mailbox is full");
      }
      if (
        (this.#active || this.#pumping) &&
        inputBytes > this.#maxQueuedInputBytes - this.#pendingBytes
      ) {
        throw new ModuleActorError(
          "ACTOR_QUEUE_BYTES_FULL",
          "Module actor mailbox exceeds its configured byte limit",
        );
      }
      this.#assertCanSubmit();
      if (request.moduleGenerationId !== this.#moduleGenerationId) {
        throw new ModuleActorError(
          "MODULE_GENERATION_CONFLICT",
          `Run belongs to Module generation ${request.moduleGenerationId}, not ${this.#moduleGenerationId}`,
        );
      }
      if (this.#liveModuleJobIds.has(request.moduleJobId)) {
        throw new ModuleActorError(
          "MODULE_JOB_ALREADY_ACTIVE",
          `Module job ${request.moduleJobId} already has a live run or mailbox entry`,
        );
      }
      if (this.#liveRunIds.has(request.runId) || this.#usedRunIds.has(request.runId)) {
        throw new ModuleActorError(
          "ACTOR_ID_INVALID",
          `Run ID ${request.runId} has already been submitted to this actor`,
        );
      }
      const finalReservedRuns =
        this.#runsInModuleGeneration + this.#pending.length + (this.#starting ? 1 : 0);
      if (finalReservedRuns >= this.#maxRunsPerGeneration) {
        throw new ModuleActorError(
          "RUN_LIMIT_REACHED",
          "Module generation reached its configured run limit",
        );
      }
      if ((this.#active || this.#pumping) && this.#pending.length >= this.#maxQueuedRuns) {
        throw new ModuleActorError("ACTOR_QUEUE_FULL", "Module actor mailbox is full");
      }
      if (
        (this.#active || this.#pumping) &&
        inputBytes > this.#maxQueuedInputBytes - this.#pendingBytes
      ) {
        throw new ModuleActorError(
          "ACTOR_QUEUE_BYTES_FULL",
          "Module actor mailbox exceeds its configured byte limit",
        );
      }
    } catch (error) {
      return Promise.reject(
        error instanceof ModuleActorError
          ? error
          : new ModuleActorError("ACTOR_FAILED", "Module submission validation failed"),
      );
    }

    const frozenRequest = Object.freeze({
      moduleGenerationId: request.moduleGenerationId,
      moduleJobId: request.moduleJobId,
      runId: request.runId,
      attempt: request.attempt,
      input: snapshot,
    });
    const completion = new Promise<ModuleRunOutcome<Output>>((resolve, reject) => {
      this.#pending.push({ request: frozenRequest, inputBytes, resolve, reject });
    });
    this.#liveModuleJobIds.add(request.moduleJobId);
    this.#liveRunIds.add(request.runId);
    this.#pendingBytes += inputBytes;
    this.#pump();
    return completion;
  }

  softTimeout(runId: string): "cancellation-requested" {
    if (this.#state === "stopping" || this.#state === "stopped") {
      throw new ModuleActorError(
        this.#state === "stopped" ? "ACTOR_STOPPED" : "ACTOR_STOPPING",
        this.#state === "stopped" ? "Module actor is stopped" : "Module actor is stopping",
      );
    }
    const active = this.#requireExecutingRun(runId);
    active.timedOut = true;
    this.#requestCancellation(active, "soft-timeout");
    return "cancellation-requested";
  }

  hardTimeout(runId: string): Promise<"module-generation-fenced"> {
    if (this.#state === "stopping" || this.#state === "stopped") {
      return Promise.reject(
        new ModuleActorError(
          this.#state === "stopped" ? "ACTOR_STOPPED" : "ACTOR_STOPPING",
          this.#state === "stopped" ? "Module actor is stopped" : "Module actor is stopping",
        ),
      );
    }
    let active: ActiveRun<Input, Output>;
    try {
      active = this.#requireExecutingRun(runId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!active.executor.terminate) {
      return Promise.reject(
        new ModuleActorError(
          "HARD_TIMEOUT_UNAVAILABLE",
          "The active executor does not provide hard termination",
        ),
      );
    }
    if (this.#hardTimeoutPromise) return this.#hardTimeoutPromise;
    if (this.#replacementPromise) return this.#replacementPromise;

    active.hardTimeoutPending = true;
    active.timedOut = true;
    this.#requestCancellation(active, "hard-timeout");

    const timeoutPromise = Promise.resolve()
      .then(() => this.#performHardTimeout(active))
      .finally(() => {
        if (this.#hardTimeoutPromise === timeoutPromise) this.#hardTimeoutPromise = undefined;
      });
    this.#hardTimeoutPromise = timeoutPromise;
    return timeoutPromise;
  }

  stop(options: ModuleStopOptions = {}): Promise<void> {
    if (this.#state === "stopped") return Promise.resolve();
    if (!this.#shutdownPromise) {
      const shutdown = this.#performStop(options);
      this.#shutdownPromise = shutdown;
      void shutdown.then(
        () => undefined,
        () => {
          if (this.#shutdownPromise === shutdown) this.#shutdownPromise = undefined;
        },
      );
    }
    return this.#awaitStop(this.#shutdownPromise, options.signal);
  }

  async #performStart(): Promise<void> {
    let executor: ModuleExecutor<Input, Output> | undefined;
    let startAttempted = false;
    try {
      if (this.#state !== "starting") {
        throw new ModuleActorError("ACTOR_STOPPING", "Module actor is stopping");
      }
      const created = this.#createExecutor(this.#moduleGenerationId);
      let candidate: ModuleExecutor<Input, Output>;
      if (this.#requireProcessIsolation) {
        if (isPromiseLike(created)) {
          void Promise.resolve(created).then(
            () => undefined,
            () => undefined,
          );
          throw new ModuleActorError(
            "ACTOR_FAILED",
            "Process isolation requires createExecutor to return a handle synchronously",
          );
        }
        candidate = created as ModuleExecutor<Input, Output>;
      } else {
        candidate = await created;
      }
      executor = candidate as ModuleExecutor<Input, Output>;
      this.#startingExecutor = executor;
      this.#startingExecutorModuleGenerationId = this.#moduleGenerationId;
      executor = validateExecutor(
        candidate,
        this.#requireProcessIsolation,
        this.#initializationTimeoutMs,
        this.#terminationTimeoutMs,
      );
      if (this.#state !== "starting") {
        throw new ModuleActorError("ACTOR_STOPPING", "Module actor is stopping");
      }
      if (executor.start) {
        startAttempted = true;
        this.#startingExecutorStartAttempted = true;
        await this.#startExecutor(executor);
      }
      if (this.#state !== "starting") {
        throw new ModuleActorError("ACTOR_STOPPING", "Module actor is stopping");
      }
      this.#executor = executor;
      this.#executorTerminated = false;
      this.#executorTerminationUnconfirmed = false;
      this.#executorTerminatePromise = undefined;
      this.#executorStopPromise = undefined;
      this.#state = "running";
      this.#pump();
    } catch (error) {
      let cleanupConfirmed = true;
      if (executor && this.#executor !== executor) {
        cleanupConfirmed = await this.#cleanupStartingExecutor(executor, startAttempted);
      }
      const actorState: ModuleActorState = this.state;
      if (actorState === "stopping" || actorState === "stopped") {
        if (!cleanupConfirmed) {
          this.#state = "failed";
          throw new ModuleActorError(
            "ACTOR_FAILED",
            "Initial executor cleanup could not be confirmed",
          );
        }
        throw new ModuleActorError(
          actorState === "stopped" ? "ACTOR_STOPPED" : "ACTOR_STOPPING",
          actorState === "stopped" ? "Module actor is stopped" : "Module actor is stopping",
        );
      }
      const actorError =
        error instanceof ModuleActorError && error.code === "ACTOR_FAILED"
          ? error
          : new ModuleActorError(
              "ACTOR_FAILED",
              cleanupConfirmed
                ? "Failed to start the initial executor"
                : "Initial executor startup failed and cleanup could not be confirmed",
            );
      this.#state = "failed";
      this.#rejectPending(actorError);
      throw actorError;
    } finally {
      this.#clearStartingExecutor(executor);
    }
  }

  #assertCanSubmit(): void {
    if (this.#state === "created" || this.#state === "starting") {
      throw new ModuleActorError("ACTOR_NOT_STARTED", "Module actor has not started");
    }
    if (this.#state === "stopping") {
      throw new ModuleActorError("ACTOR_STOPPING", "Module actor is stopping");
    }
    if (this.#state === "stopped") {
      throw new ModuleActorError("ACTOR_STOPPED", "Module actor is stopped");
    }
    if (this.#state === "failed") {
      throw new ModuleActorError("ACTOR_FAILED", "Module actor is failed");
    }
  }

  #requireActiveRun(runId: string): ActiveRun<Input, Output> {
    assertId(runId, "runId");
    if (!this.#active || this.#active.context.runId !== runId || this.#active.settled) {
      throw new ModuleActorError("RUN_NOT_ACTIVE", `Run ${runId} is not active`);
    }
    return this.#active;
  }

  #requireExecutingRun(runId: string): ActiveRun<Input, Output> {
    const active = this.#requireActiveRun(runId);
    if (active.phase !== "executing") {
      throw new ModuleActorError(
        "RUN_NOT_EXECUTING",
        `Run ${runId} has already entered result acceptance`,
      );
    }
    return active;
  }

  #pump(): void {
    if (
      this.#pumping ||
      this.#state !== "running" ||
      this.#active ||
      this.#pending.length === 0
    ) {
      return;
    }
    this.#pumping = true;
    const pending = this.#pending.shift()!;
    this.#starting = pending;
    this.#pendingBytes -= pending.inputBytes;
    try {
      if (this.#runsInModuleGeneration >= this.#maxRunsPerGeneration) {
        throw new ModuleActorError(
          "RUN_LIMIT_REACHED",
          "Module generation reached its configured run limit",
        );
      }

      const runId = pending.request.runId;
      if (this.#usedRunIds.has(runId)) {
        throw new ModuleActorError(
          "ACTOR_ID_INVALID",
          `Run ID ${runId} has already been used by this actor`,
        );
      }

      let startedAt: number;
      try {
        startedAt = this.#monotonicNow();
      } catch {
        throw new ModuleActorError("ACTOR_FAILED", "Monotonic run clock failed");
      }
      if (!Number.isFinite(startedAt) || startedAt < 0) {
        throw new ModuleActorError(
          "ACTOR_FAILED",
          "Monotonic run clock returned an invalid value",
        );
      }
      if (this.#state !== "running") {
        throw new ModuleActorError("ACTOR_STOPPING", "Module actor is stopping");
      }
      if (pending.request.moduleGenerationId !== this.#moduleGenerationId) {
        throw new ModuleActorError(
          "MODULE_GENERATION_FENCED",
          `Queued run ${runId} belongs to a fenced Module generation`,
        );
      }

      this.#usedRunIds.add(runId);
      this.#runsInModuleGeneration += 1;
      const controller = new AbortController();
      const context = Object.freeze({
        moduleId: this.#moduleId,
        moduleGenerationId: pending.request.moduleGenerationId,
        moduleJobId: pending.request.moduleJobId,
        runId,
        attempt: pending.request.attempt,
        startedAt,
        signal: controller.signal,
      });
      const active: ActiveRun<Input, Output> = {
        pending,
        executor: this.#executor!,
        context,
        controller,
        phase: "executing",
        cancellationRequested: false,
        timedOut: false,
        hardTimeoutPending: false,
        completionWhileFencing: false,
        staleResultReported: false,
        settled: false,
      };
      this.#active = active;
      this.#emit(active, { type: "run.started", startedAt });
      void this.#execute(active);
    } catch (error) {
      const actorError =
        error instanceof ModuleActorError
          ? error
          : new ModuleActorError("ACTOR_FAILED", "Module actor failed to start a run");
      const actorState: ModuleActorState = this.state;
      if (actorState === "stopping" || actorState === "stopped") {
        this.#liveModuleJobIds.delete(pending.request.moduleJobId);
        this.#liveRunIds.delete(pending.request.runId);
        pending.reject(
          new ModuleActorError(
            actorState === "stopped" ? "ACTOR_STOPPED" : "ACTOR_STOPPING",
            actorState === "stopped" ? "Module actor is stopped" : "Module actor is stopping",
          ),
        );
      } else {
        this.#failBeforeExecution(pending, actorError);
      }
    } finally {
      this.#starting = undefined;
      this.#pumping = false;
      this.#resolveIdleWaiters();
    }
  }

  async #execute(active: ActiveRun<Input, Output>): Promise<void> {
    if (this.#active !== active || active.settled) {
      this.#reportStaleResult(active);
      return;
    }
    if (active.cancellationRequested) {
      if (active.hardTimeoutPending) return;
      this.#settle(
        active,
        this.#outcome(
          active,
          this.#state === "stopping"
            ? "cancelled"
            : active.timedOut
              ? "timed-out"
              : "cancelled",
        ),
      );
      return;
    }

    let output: Output;
    try {
      output = await active.executor.execute(active.pending.request.input, active.context);
    } catch (error) {
      if (error instanceof ModuleExecutorTerminationUnconfirmedError) {
        this.#setUnconfirmedExecutor(active.executor, {
          moduleId: active.context.moduleId,
          moduleGenerationId: active.context.moduleGenerationId,
          moduleJobId: active.context.moduleJobId,
          runId: active.context.runId,
        });
        this.#failUnconfirmedTermination(active);
        return;
      }
      if (error instanceof ModuleExecutorTerminatedError) {
        if (active.hardTimeoutPending) {
          active.completionWhileFencing = true;
          return;
        }
        active.hardTimeoutPending = true;
        try {
          await this.#startReplacement(active);
        } catch {
          // Replacement failure is represented by the actor state and fenced outcome.
        }
        return;
      }
      this.#finishFailure(active);
      return;
    }
    await this.#finishSuccess(active, output);
  }

  async #finishSuccess(active: ActiveRun<Input, Output>, output: Output): Promise<void> {
    if (this.#active !== active || active.settled) {
      this.#reportStaleResult(active);
      return;
    }
    if (active.hardTimeoutPending) {
      active.completionWhileFencing = true;
      return;
    }
    if (this.#state === "stopping") {
      this.#settle(active, this.#outcome(active, "cancelled"));
      return;
    }
    if (active.timedOut) {
      this.#settle(active, this.#outcome(active, "timed-out"));
      return;
    }
    if (this.#state === "failed") {
      this.#settle(active, this.#outcome(active, "fenced"));
      this.#reportStaleResult(active);
      return;
    }

    active.phase = "accepting-result";
    let acceptedOutput: Output;
    let outcomeOutput: Output;
    try {
      acceptedOutput = this.#snapshotOutput(output);
      outcomeOutput = this.#snapshotOutput(acceptedOutput);
    } catch {
      this.#settle(
        active,
        this.#outcome(
          active,
          "failed",
          runFailure(
            "OUTPUT_SNAPSHOT_FAILED",
            "Module output could not be snapshotted for host acceptance",
            true,
          ),
        ),
      );
      return;
    }

    try {
      await this.#acceptResult(acceptedOutput, active.context);
    } catch {
      if (this.#active === active && !active.settled) {
        this.#settle(
          active,
          this.#outcome(
            active,
            "failed",
            runFailure(
              "RESULT_ACCEPTANCE_UNCERTAIN",
              "Host result acceptance did not return a confirmed outcome",
              false,
            ),
          ),
        );
      } else {
        this.#reportStaleResult(active);
      }
      return;
    }

    if (this.#active !== active || active.settled) {
      this.#reportStaleResult(active);
      return;
    }
    this.#settle(active, this.#outcome(active, "succeeded", undefined, outcomeOutput));
  }

  #finishFailure(active: ActiveRun<Input, Output>): void {
    if (this.#active !== active || active.settled) {
      this.#reportStaleResult(active);
      return;
    }
    if (active.hardTimeoutPending) {
      active.completionWhileFencing = true;
      return;
    }
    if (this.#state === "stopping") {
      this.#settle(active, this.#outcome(active, "cancelled"));
    } else if (active.timedOut) {
      this.#settle(active, this.#outcome(active, "timed-out"));
    } else {
      this.#settle(
        active,
        this.#outcome(
          active,
          "failed",
          runFailure("MODULE_EXECUTION_FAILED", "Module execution failed", false),
        ),
      );
    }
  }

  async #performHardTimeout(
    active: ActiveRun<Input, Output>,
  ): Promise<"module-generation-fenced"> {
    const terminationContext = {
      moduleId: active.context.moduleId,
      moduleGenerationId: active.context.moduleGenerationId,
      moduleJobId: active.context.moduleJobId,
      runId: active.context.runId,
    };
    try {
      await this.#terminateExecutor(active.executor, terminationContext);
    } catch {
      active.hardTimeoutPending = false;
      this.#setUnconfirmedExecutor(active.executor, terminationContext);
      throw this.#failUnconfirmedTermination(active);
    }

    return this.#startReplacement(active);
  }

  #startReplacement(active: ActiveRun<Input, Output>): Promise<"module-generation-fenced"> {
    if (this.#replacementPromise) return this.#replacementPromise;
    const replacement = Promise.resolve()
      .then(() => this.#replaceTerminatedExecutor(active))
      .finally(() => {
        if (this.#replacementPromise === replacement) this.#replacementPromise = undefined;
      });
    this.#replacementPromise = replacement;
    return replacement;
  }

  async #replaceTerminatedExecutor(
    active: ActiveRun<Input, Output>,
  ): Promise<"module-generation-fenced"> {
    if (this.#executor === active.executor) {
      this.#executorTerminated = true;
      this.#executorTerminationUnconfirmed = false;
    }

    if (this.#active !== active || active.settled) return "module-generation-fenced";

    if (this.#state === "stopping") {
      this.#settle(
        active,
        this.#outcome(active, active.hardTimeoutPending ? "fenced" : "cancelled"),
      );
      if (active.completionWhileFencing) this.#reportStaleResult(active);
      return "module-generation-fenced";
    }

    if (this.#usedModuleGenerationIds.size >= this.#maxGenerations) {
      const error = new ModuleActorError(
        "MODULE_GENERATION_LIMIT_REACHED",
        "Module actor reached its configured generation limit",
      );
      this.#failAfterTermination(active, error);
      throw error;
    }

    let nextModuleGenerationId: string;
    try {
      nextModuleGenerationId = this.#nextModuleGenerationId();
    } catch {
      const error = new ModuleActorError("ACTOR_ID_INVALID", "nextModuleGenerationId failed");
      this.#failAfterTermination(active, error);
      throw error;
    }
    try {
      assertId(nextModuleGenerationId, "nextModuleGenerationId");
    } catch (error) {
      const actorError =
        error instanceof ModuleActorError
          ? error
          : new ModuleActorError("ACTOR_ID_INVALID", "nextModuleGenerationId is invalid");
      this.#failAfterTermination(active, actorError);
      throw actorError;
    }
    if (this.#usedModuleGenerationIds.has(nextModuleGenerationId)) {
      const error = new ModuleActorError(
        "MODULE_GENERATION_CONFLICT",
        `Module generation ID ${nextModuleGenerationId} has already been used`,
      );
      this.#failAfterTermination(active, error);
      throw error;
    }

    this.#usedModuleGenerationIds.add(nextModuleGenerationId);

    let nextExecutor: ModuleExecutor<Input, Output> | undefined;
    let startAttempted = false;
    try {
      const created = this.#createExecutor(nextModuleGenerationId);
      let candidate: ModuleExecutor<Input, Output>;
      if (this.#requireProcessIsolation) {
        if (isPromiseLike(created)) {
          void Promise.resolve(created).then(
            () => undefined,
            () => undefined,
          );
          throw new ModuleActorError(
            "ACTOR_FAILED",
            "Process isolation requires createExecutor to return a handle synchronously",
          );
        }
        candidate = created as ModuleExecutor<Input, Output>;
      } else {
        candidate = await created;
      }
      nextExecutor = candidate as ModuleExecutor<Input, Output>;
      this.#startingExecutor = nextExecutor;
      this.#startingExecutorModuleGenerationId = nextModuleGenerationId;
      nextExecutor = validateExecutor(
        candidate,
        this.#requireProcessIsolation,
        this.#initializationTimeoutMs,
        this.#terminationTimeoutMs,
      );
      if (this.#state !== "running") {
        throw new ModuleActorError("ACTOR_STOPPING", "Module actor is stopping");
      }
      if (nextExecutor.start) {
        startAttempted = true;
        this.#startingExecutorStartAttempted = true;
        await this.#startExecutor(nextExecutor);
      }
    } catch {
      const cleanupConfirmed =
        nextExecutor === undefined
          ? true
          : await this.#cleanupStartingExecutor(nextExecutor, startAttempted);
      this.#clearStartingExecutor(nextExecutor);
      const actorState: ModuleActorState = this.state;
      if ((actorState === "stopping" || actorState === "stopped") && cleanupConfirmed) {
        this.#settle(
          active,
          this.#outcome(active, active.hardTimeoutPending ? "fenced" : "cancelled"),
        );
        if (active.completionWhileFencing) this.#reportStaleResult(active);
        return "module-generation-fenced";
      }
      if (!cleanupConfirmed) {
        throw this.#failUnconfirmedTermination(active);
      }
      const error = new ModuleActorError(
        "ACTOR_FAILED",
        "Failed to start a valid replacement executor",
      );
      this.#failAfterTermination(active, error);
      throw error;
    }

    if (this.#state !== "running") {
      const cleanupConfirmed = await this.#cleanupStartingExecutor(nextExecutor, true);
      this.#clearStartingExecutor(nextExecutor);
      if (!cleanupConfirmed) {
        throw this.#failUnconfirmedTermination(active);
      }
      this.#settle(
        active,
        this.#outcome(
          active,
          this.#state === "stopping" || this.#state === "stopped"
            ? active.hardTimeoutPending
              ? "fenced"
              : "cancelled"
            : "fenced",
        ),
      );
      if (active.completionWhileFencing) this.#reportStaleResult(active);
      return "module-generation-fenced";
    }

    this.#clearStartingExecutor(nextExecutor);

    this.#rejectPending(
      new ModuleActorError(
        "MODULE_GENERATION_FENCED",
        `Queued runs belonged to fenced Module generation ${active.context.moduleGenerationId}`,
      ),
    );
    this.#moduleGenerationId = nextModuleGenerationId;
    this.#executor = nextExecutor;
    this.#executorTerminated = false;
    this.#executorTerminationUnconfirmed = false;
    this.#executorTerminatePromise = undefined;
    this.#executorStopPromise = undefined;
    this.#runsInModuleGeneration = 0;
    this.#settle(active, this.#outcome(active, "fenced"));
    if (active.completionWhileFencing) this.#reportStaleResult(active);
    return "module-generation-fenced";
  }

  #identity(active: ActiveRun<Input, Output>): ModuleRunIdentity {
    return {
      moduleId: active.context.moduleId,
      moduleGenerationId: active.context.moduleGenerationId,
      moduleJobId: active.context.moduleJobId,
      runId: active.context.runId,
      attempt: active.context.attempt,
    };
  }

  #failUnconfirmedTermination(
    active: ActiveRun<Input, Output>,
  ): ModuleActorError {
    this.#executorTerminationUnconfirmed = true;
    const error = new ModuleActorError(
      "ACTOR_FAILED",
      "Executor termination could not be confirmed; a Module executor may still be running",
    );
    this.#state = "failed";
    this.#rejectPending(error);
    if (this.#active === active && !active.settled) {
      this.#settle(
        active,
        this.#outcome(
          active,
          "failed",
          runFailure(
            "EXECUTOR_TERMINATION_UNCONFIRMED",
            "Module executor termination could not be confirmed",
            false,
          ),
        ),
      );
      if (active.completionWhileFencing) this.#reportStaleResult(active);
    }
    return error;
  }

  #outcome(
    active: ActiveRun<Input, Output>,
    status: ModuleRunOutcome<Output>["status"],
    error?: ModuleRunFailure,
    output?: Output,
  ): ModuleRunOutcome<Output> {
    const identity = this.#identity(active);
    if (status === "succeeded") return Object.freeze({ ...identity, status, output: output! });
    if (status === "failed") return Object.freeze({ ...identity, status, error: error! });
    if (status === "cancelled") {
      return Object.freeze({ ...identity, status, reason: "shutdown" });
    }
    return Object.freeze({ ...identity, status });
  }

  #settle(active: ActiveRun<Input, Output>, outcome: ModuleRunOutcome<Output>): void {
    if (active.settled) return;
    active.settled = true;
    if (this.#active === active) this.#active = undefined;
    this.#liveModuleJobIds.delete(active.context.moduleJobId);
    this.#liveRunIds.delete(active.context.runId);
    active.pending.resolve(outcome);
    this.#emit(
      active,
      outcome.status === "cancelled"
        ? { type: "run.completed", status: outcome.status, reason: outcome.reason }
        : { type: "run.completed", status: outcome.status },
    );
    this.#resolveIdleWaiters();
    if (this.#state === "running") queueMicrotask(() => this.#pump());
  }

  #failBeforeExecution(
    current: PendingRun<Input, Output>,
    error: ModuleActorError,
  ): void {
    this.#state = "failed";
    this.#liveModuleJobIds.delete(current.request.moduleJobId);
    this.#liveRunIds.delete(current.request.runId);
    current.reject(error);
    this.#rejectPending(error);
  }

  #failAfterTermination(active: ActiveRun<Input, Output>, error: ModuleActorError): void {
    this.#state = "failed";
    this.#rejectPending(error);
    this.#settle(active, this.#outcome(active, "fenced"));
    if (active.completionWhileFencing) this.#reportStaleResult(active);
  }

  #rejectPending(error: ModuleActorError): void {
    for (const pending of this.#pending.splice(0)) {
      this.#liveModuleJobIds.delete(pending.request.moduleJobId);
      this.#liveRunIds.delete(pending.request.runId);
      pending.reject(error);
    }
    this.#pendingBytes = 0;
  }

  #requestCancellation(
    active: ActiveRun<Input, Output>,
    reason: ModuleCancellationReason,
  ): void {
    if (!active.cancellationRequested) {
      active.cancellationRequested = true;
      this.#emit(active, { type: "run.cancellation_requested", reason });
      try {
        void Promise.resolve(
          active.executor.cancel?.({
            moduleId: active.context.moduleId,
            moduleGenerationId: active.context.moduleGenerationId,
            moduleJobId: active.context.moduleJobId,
            runId: active.context.runId,
            reason,
          }),
        ).catch(() => undefined);
      } catch {
        // Cancellation is cooperative; only confirmed termination permits replacement.
      }
    }
    if (!active.controller.signal.aborted) {
      active.controller.abort(new Error("Module run cancellation requested"));
    }
  }

  #reportStaleResult(active: ActiveRun<Input, Output>): void {
    if (active.staleResultReported) return;
    active.staleResultReported = true;
    this.#emit(active, { type: "run.stale_result" });
  }

  #emit(
    active: ActiveRun<Input, Output>,
    detail:
      | { readonly type: "run.started"; readonly startedAt: number }
      | {
          readonly type: "run.cancellation_requested";
          readonly reason: ModuleCancellationReason;
        }
      | {
          readonly type: "run.completed";
          readonly status: Exclude<ModuleRunOutcome<unknown>["status"], "cancelled">;
        }
      | {
          readonly type: "run.completed";
          readonly status: "cancelled";
          readonly reason: "shutdown";
        }
      | { readonly type: "run.stale_result" },
  ): void {
    if (!this.#onEvent) return;
    try {
      this.#onEvent(Object.freeze({ ...this.#identity(active), ...detail }) as ModuleActorEvent);
    } catch {
      // Observability must not mutate actor correctness.
    }
  }

  async #performStop(options: ModuleStopOptions): Promise<void> {
    if (this.#state === "stopped") return;
    const start = this.#executor === undefined ? this.#startPromise : undefined;
    this.#state = "stopping";
    const stopError = new ModuleActorError("ACTOR_STOPPING", "Module actor is stopping");
    this.#rejectPending(stopError);
    if (this.#active?.phase === "executing") {
      this.#requestCancellation(this.#active, "shutdown");
    }
    let cancellationGraceMs: number | undefined;
    const requireCancellationGrace = () => {
      if (cancellationGraceMs !== undefined) return cancellationGraceMs;
      const configured = options.cancellationGraceMs;
      if (
        configured === undefined ||
        !Number.isSafeInteger(configured) ||
        configured < 0 ||
        configured > MAX_TIMER_DELAY_MS
      ) {
        throw new ModuleActorError(
          "STOP_INCOMPLETE",
          "A starting or active Module requires cancellationGraceMs within the supported timer range before stopping",
        );
      }
      cancellationGraceMs = configured;
      return configured;
    };
    if (start) {
      const completed = await this.#waitForCompletionWithinGrace(
        start,
        requireCancellationGrace(),
      );
      if (!completed) {
        const startingExecutor = this.#startingExecutor;
        if (!startingExecutor) {
          throw new ModuleActorError(
            "STOP_INCOMPLETE",
            "Module executor creation did not finish in time",
          );
        }
        const cleanup = this.#cleanupStartingExecutor(
          startingExecutor,
          this.#startingExecutorStartAttempted,
        );
        const cleanupCompleted = await this.#waitForCompletionWithinGrace(
          cleanup,
          requireCancellationGrace(),
        );
        if (!cleanupCompleted) {
          throw new ModuleActorError(
            "STOP_INCOMPLETE",
            "Starting Module executor cleanup did not finish in time",
          );
        }
        if (!(await cleanup)) {
          this.#state = "failed";
          throw new ModuleActorError(
            "ACTOR_FAILED",
            "Starting Module executor cleanup could not be confirmed",
          );
        }
        this.#state = "stopped";
        return;
      }
    }
    const actorState: ModuleActorState = this.state;
    if (actorState === "failed") {
      throw new ModuleActorError("ACTOR_FAILED", "Executor startup cleanup failed");
    }
    const waitForTerminationOrReplacement = async () => {
      while (true) {
        const operation = this.#hardTimeoutPromise ?? this.#replacementPromise;
        if (!operation) return;
        const completed = await this.#waitForCompletionWithinGrace(
          operation,
          requireCancellationGrace(),
        );
        if (!completed) {
          const startingExecutor = this.#startingExecutor;
          if (!startingExecutor) {
            throw new ModuleActorError(
              "STOP_INCOMPLETE",
              "Module actor did not finish termination or replacement cleanup in time",
            );
          }
          const cleanup = this.#cleanupStartingExecutor(
            startingExecutor,
            this.#startingExecutorStartAttempted,
          );
          const cleanupCompleted = await this.#waitForCompletionWithinGrace(
            cleanup,
            requireCancellationGrace(),
          );
          if (!cleanupCompleted) {
            throw new ModuleActorError(
              "STOP_INCOMPLETE",
              "Replacement Module executor cleanup did not finish in time",
            );
          }
          if (!(await cleanup)) {
            this.#state = "failed";
            throw new ModuleActorError(
              "ACTOR_FAILED",
              "Replacement Module executor cleanup could not be confirmed",
            );
          }
          const active = this.#active;
          if (active && !active.settled) {
            this.#settle(
              active,
              this.#outcome(active, active.hardTimeoutPending ? "fenced" : "cancelled"),
            );
            if (active.completionWhileFencing) this.#reportStaleResult(active);
          }
          return;
        }
        if (this.state === "failed") {
          throw new ModuleActorError(
            "ACTOR_FAILED",
            "Executor termination or replacement cleanup failed",
          );
        }
      }
    };

    await waitForTerminationOrReplacement();
    if (this.#active) {
      const becameIdle = await this.#waitForIdleWithinGrace(requireCancellationGrace());
      if (!becameIdle) {
        await waitForTerminationOrReplacement();
        const active = this.#active;
        if (active && (active.phase !== "executing" || !active.executor.terminate)) {
          throw new ModuleActorError(
            "STOP_INCOMPLETE",
            "Module actor could not confirm that active execution stopped",
          );
        }
        if (active) {
          try {
            await this.#terminateExecutor(active.executor, {
              moduleId: active.context.moduleId,
              moduleGenerationId: active.context.moduleGenerationId,
              moduleJobId: active.context.moduleJobId,
              runId: active.context.runId,
            });
          } catch {
            this.#setUnconfirmedExecutor(active.executor, {
              moduleId: active.context.moduleId,
              moduleGenerationId: active.context.moduleGenerationId,
              moduleJobId: active.context.moduleJobId,
              runId: active.context.runId,
            });
            throw this.#failUnconfirmedTermination(active);
          }
          if (this.#executor === active.executor) {
            this.#executorTerminated = true;
            this.#executorTerminationUnconfirmed = false;
          }
          await waitForTerminationOrReplacement();
          if (this.#active === active && !active.settled) {
            this.#settle(active, this.#outcome(active, "cancelled"));
          }
        }
      }
    }
    await this.#whenIdle();

    try {
      if (this.#executorTerminationUnconfirmed) {
        await this.#retryUnconfirmedExecutorTermination();
      }
      if (this.#executor && !this.#executorTerminated) await this.#ensureExecutorStopped();
    } catch (error) {
      this.#state = "failed";
      if (error instanceof ModuleActorError && error.code === "STOP_INCOMPLETE") {
        throw error;
      }
      throw new ModuleActorError("ACTOR_FAILED", "Executor stop failed");
    }
    this.#state = "stopped";
  }

  #ensureExecutorStopped(): Promise<void> {
    if (this.#executorStopPromise) return this.#executorStopPromise;
    const stop = Promise.resolve().then(async () => {
      const executor = this.#executor;
      if (!executor) return;
      if (executor.isolation === "process") {
        try {
          await this.#terminateExecutor(executor, {
            moduleId: this.#moduleId,
            moduleGenerationId: this.#moduleGenerationId,
          });
        } catch {
          this.#setUnconfirmedExecutor(executor, {
            moduleId: this.#moduleId,
            moduleGenerationId: this.#moduleGenerationId,
          });
          throw new ModuleActorError(
            "STOP_INCOMPLETE",
            "Process executor termination could not be confirmed",
          );
        }
        this.#executorTerminated = true;
        this.#executorTerminationUnconfirmed = false;
        return;
      }
      if (this.#executorTerminationUnconfirmed && !this.#executor?.stop) {
        throw new ModuleActorError(
          "STOP_INCOMPLETE",
          "Executor termination was not confirmed and no stop operation is available",
        );
      }
      await this.#executor?.stop?.();
      this.#executorTerminationUnconfirmed = false;
    });
    this.#executorStopPromise = stop;
    void stop.then(
      () => undefined,
      () => {
        if (this.#executorStopPromise === stop) this.#executorStopPromise = undefined;
      },
    );
    return stop;
  }

  #startExecutor(executor: ModuleExecutor<Input, Output>): Promise<void> {
    if (typeof executor.start !== "function") return Promise.resolve();
    if (executor.isolation !== "process") {
      return Promise.resolve().then(() => executor.start!());
    }
    const initializationTimeoutMs = this.#initializationTimeoutMs;
    if (initializationTimeoutMs === undefined) {
      return Promise.reject(
        new ModuleActorError(
          "ACTOR_FAILED",
          "Process executor initialization has no configured timeout",
        ),
      );
    }

    const operation = Promise.resolve().then(() => executor.start!());
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: ModuleActorError) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new ModuleActorError(
              "ACTOR_FAILED",
              "Process executor initialization did not finish within initializationTimeoutMs",
            ),
          ),
        initializationTimeoutMs,
      );
      void operation.then(
        () => finish(),
        () =>
          finish(
            new ModuleActorError("ACTOR_FAILED", "Process executor initialization failed"),
          ),
      );
    });
  }

  #terminateExecutor(
    executor: ModuleExecutor<Input, Output>,
    context: TerminationContext,
  ): Promise<void> {
    if (this.#executor === executor && this.#executorTerminatePromise) {
      return this.#executorTerminatePromise;
    }
    const termination = this.#terminateWithinTimeout(executor, context);
    if (this.#executor === executor) {
      this.#executorTerminatePromise = termination;
      void termination.catch(() => {
        if (this.#executorTerminatePromise === termination) {
          this.#executorTerminatePromise = undefined;
        }
      });
    }
    return termination;
  }

  #terminateWithinTimeout(
    executor: ModuleExecutor<Input, Output>,
    context: TerminationContext,
  ): Promise<void> {
    if (typeof executor.terminate !== "function") {
      return Promise.reject(
        new ModuleExecutorTerminationUnconfirmedError(
          "Process executor does not provide confirmed termination",
        ),
      );
    }
    if (executor.isolation !== "process") {
      return Promise.resolve().then(() => executor.terminate!(context));
    }
    const terminationTimeoutMs = this.#terminationTimeoutMs;
    if (terminationTimeoutMs === undefined) {
      return Promise.reject(
        new ModuleExecutorTerminationUnconfirmedError(
          "Process executor termination has no configured timeout",
        ),
      );
    }

    const operation = this.#getOrStartTermination(executor, context);
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: ModuleExecutorTerminationUnconfirmedError) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new ModuleExecutorTerminationUnconfirmedError(
              "Process executor termination did not finish within terminationTimeoutMs",
            ),
          ),
        terminationTimeoutMs,
      );
      void operation.then(
        () => finish(),
        () =>
          finish(
            new ModuleExecutorTerminationUnconfirmedError(
              "Process executor termination failed",
            ),
          ),
      );
    });
  }

  #getOrStartTermination(
    executor: ModuleExecutor<Input, Output>,
    context: TerminationContext,
  ): Promise<void> {
    const existing = this.#executorTerminationOperations.get(executor);
    if (existing) return existing;
    const operation = Promise.resolve().then(() => executor.terminate!(context));
    this.#executorTerminationOperations.set(executor, operation);
    void operation.then(
      () => undefined,
      () => {
        if (this.#executorTerminationOperations.get(executor) === operation) {
          this.#executorTerminationOperations.delete(executor);
        }
      },
    );
    return operation;
  }

  #cleanupStartingExecutor(
    executor: ModuleExecutor<Input, Output>,
    startAttempted: boolean,
  ): Promise<boolean> {
    if (this.#startingExecutor === executor && this.#startingExecutorCleanupPromise) {
      return this.#startingExecutorCleanupPromise;
    }
    const cleanup = this.#cleanupExecutor(
      executor,
      {
        moduleId: this.#moduleId,
        moduleGenerationId:
          this.#startingExecutor === executor
            ? (this.#startingExecutorModuleGenerationId ?? this.#moduleGenerationId)
            : this.#moduleGenerationId,
      },
      startAttempted,
    );
    if (this.#startingExecutor === executor) {
      this.#startingExecutorCleanupPromise = cleanup;
    }
    return cleanup;
  }

  #clearStartingExecutor(executor: ModuleExecutor<Input, Output> | undefined): void {
    if (executor === undefined || this.#startingExecutor !== executor) return;
    this.#startingExecutor = undefined;
    this.#startingExecutorModuleGenerationId = undefined;
    this.#startingExecutorStartAttempted = false;
    this.#startingExecutorCleanupPromise = undefined;
  }

  async #cleanupExecutor(
    executor: ModuleExecutor<Input, Output>,
    context: TerminationContext,
    startAttempted = true,
  ): Promise<boolean> {
    if (executor.isolation === "process") {
      if (typeof executor.terminate === "function") {
        try {
          await this.#terminateWithinTimeout(executor, context);
          return true;
        } catch {
          this.#setUnconfirmedExecutor(executor, context);
          return false;
        }
      }
      this.#setUnconfirmedExecutor(executor, context);
      return false;
    }
    if (typeof executor.terminate === "function") {
      try {
        await executor.terminate(context);
        return true;
      } catch {
        // A graceful stop is still worth attempting when forced termination fails.
      }
    }
    if (typeof executor.stop !== "function") return !startAttempted;
    try {
      await executor.stop();
      return true;
    } catch {
      return false;
    }
  }

  #setUnconfirmedExecutor(
    executor: ModuleExecutor<Input, Output>,
    context: TerminationContext,
  ): void {
    this.#executorTerminationUnconfirmed = true;
    if (this.#unconfirmedExecutor) return;
    this.#unconfirmedExecutor = executor;
    this.#unconfirmedExecutorContext = context;
  }

  async #retryUnconfirmedExecutorTermination(): Promise<void> {
    const executor = this.#unconfirmedExecutor;
    const context = this.#unconfirmedExecutorContext;
    if (!executor || !context) {
      throw new ModuleActorError(
        "STOP_INCOMPLETE",
        "A Module executor may still be running because termination was not confirmed",
      );
    }
    try {
      if (executor === this.#executor) await this.#terminateExecutor(executor, context);
      else await this.#terminateWithinTimeout(executor, context);
    } catch {
      throw new ModuleActorError(
        "STOP_INCOMPLETE",
        "A Module executor may still be running because termination was not confirmed",
      );
    }
    if (executor === this.#executor) this.#executorTerminated = true;
    this.#unconfirmedExecutor = undefined;
    this.#unconfirmedExecutorContext = undefined;
    this.#executorTerminationUnconfirmed = false;
  }

  #whenIdle(): Promise<void> {
    if (!this.#active && !this.#starting) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  #waitForIdleWithinGrace(cancellationGraceMs: number): Promise<boolean> {
    if (!this.#active && !this.#starting) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const resolveIdle = () => {
        clearTimeout(timer);
        this.#idleWaiters.delete(resolveIdle);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#idleWaiters.delete(resolveIdle);
        resolve(false);
      }, cancellationGraceMs);
      this.#idleWaiters.add(resolveIdle);
    });
  }

  #waitForCompletionWithinGrace(
    operation: Promise<unknown>,
    cancellationGraceMs: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(completed);
      };
      const timer = setTimeout(() => finish(false), cancellationGraceMs);
      void operation.then(
        () => finish(true),
        () => finish(true),
      );
    });
  }

  #resolveIdleWaiters(): void {
    if (this.#active || this.#starting) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  #awaitStop(shutdown: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return shutdown;
    if (signal.aborted) {
      return Promise.reject(
        new ModuleActorError(
          "STOP_INCOMPLETE",
          "Module actor did not stop before the caller's grace period ended",
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        reject(
          new ModuleActorError(
            "STOP_INCOMPLETE",
            "Module actor did not stop before the caller's grace period ended",
          ),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void shutdown.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}
