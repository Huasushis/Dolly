import {
  assertJsonValue,
  canonicalJsonByteLength,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import { type BlockProposal, type SourceIdentity } from "./block-store.js";
import {
  DeliveryClaimPersistenceUnconfirmedError,
  type DeliveryClaim,
  type DeliveryClaimIdentity,
  type DeliveryStore,
  type FailureClassification,
} from "./delivery-store.js";
import {
  ModuleActor,
  ModuleActorError,
  type ModuleActiveRunStatus,
  type ModuleActorEvent,
  type ModuleActorOptions,
  type ModuleActorState,
  type ModuleExecutor,
  type ModuleRunContext,
  type ModuleRunOutcome,
  type ModuleStopOptions,
} from "./module-actor.js";
import {
  buildReactiveModuleInput,
  measureReactiveModuleInput,
  type ReactiveModuleInput,
} from "./reactive-module-input.js";
import {
  type ModuleResultCommitCoordinator,
  type ModuleResultCommitRecord,
  moduleJobResultDigest,
} from "./module-result-commit.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type { ReactiveModuleInput } from "./reactive-module-input.js";

export interface ReactiveModuleResult {
  readonly schemaVersion: "dolly.module-result/1";
  readonly blockProposal?: BlockProposal;
}

export type ReactiveModuleFailureStage =
  | "actor-submission"
  | "module-execution"
  | "output-snapshot"
  | "soft-timeout"
  | "generation-fenced"
  | "result-rejected-before-prepare";

export interface ReactiveModuleFailure {
  readonly stage: ReactiveModuleFailureStage;
  readonly code: string;
}

export type ReactiveModuleTickResult =
  | { readonly status: "idle" }
  | (DeliveryClaimIdentity & {
      readonly status: "committed";
      readonly recovered: boolean;
      readonly record: ModuleResultCommitRecord;
    })
  | (DeliveryClaimIdentity & {
      readonly status: "retry-scheduled" | "dead-lettered";
      readonly failure: FailureClassification;
    })
  | (DeliveryClaimIdentity & {
      readonly status: "cancelled";
      readonly reason: "shutdown";
    })
  | (DeliveryClaimIdentity & {
      readonly status: "recovery-required";
      readonly reason:
        | "claim-persistence-unconfirmed"
        | "commit-outcome-unknown"
        | "commit-result-conflict"
        | "executor-termination-unconfirmed"
        | "failure-policy-unavailable"
        | "nack-outcome-unknown";
    });

// `executor-termination-unconfirmed` means Core could not prove that the
// process and its result channel stopped. Recovery preserves the active Claim;
// it never classifies, acknowledges, retries, or starts another execution.

export type ReactiveModuleRecoveryResult =
  | { readonly status: "nothing-to-recover" }
  | Exclude<ReactiveModuleTickResult, { readonly status: "idle" }>;

export type ReactiveModuleRuntimeErrorCode =
  | "RUNTIME_BUSY"
  | "RUNTIME_FAILED"
  | "RUNTIME_NOT_STARTED"
  | "RUNTIME_STOPPING"
  | "RUNTIME_RECOVERY_REQUIRED"
  | "RUNTIME_CONFIGURATION_INVALID"
  | "RUNTIME_CLAIM_FAILED";

export class ReactiveModuleRuntimeError extends Error {
  constructor(readonly code: ReactiveModuleRuntimeErrorCode, message: string) {
    super(message);
    this.name = "ReactiveModuleRuntimeError";
  }
}

export interface ReactiveModuleRuntimeOptions {
  readonly moduleId: string;
  readonly initialModuleGenerationId: string;
  readonly inputPageIds: readonly string[];
  readonly outputPageIds: readonly string[];
  readonly claimMaxCount: number;
  readonly claimMaxBytes: number;
  readonly maxInputBytes: number;
  readonly maxResultBytes: number;
  readonly executionTimeoutMs: number;
  readonly cancellationGraceMs: number;
  readonly initializationTimeoutMs: number;
  readonly terminationTimeoutMs: number;
  readonly maxRunsPerGeneration: number;
  readonly maxGenerations: number;
  readonly deliveries: DeliveryStore;
  readonly commits: ModuleResultCommitCoordinator;
  readonly nextModuleGenerationId: () => string;
  readonly monotonicNow: () => number;
  /**
   * What external or persistent effects this Module may cause, taken from its
   * validated configuration. `"none"` means a Run that produced no committed
   * result can be negatively acknowledged, because repeating it cannot add an
   * external effect. Every other value, including the default, means Core must
   * prove no effect occurred before it classifies such a Run as failed; without
   * that proof the exact Claim is preserved as an unknown outcome for audited
   * operator action, as Architecture Decision Record 0009 requires.
   */
  readonly declaredExternalEffects?: "none" | "core-capabilities-only";
  /**
   * Synchronously constructs and returns a terminable process handle without
   * creating an operating-system process. The executor's `start()` operation
   * performs process creation, authentication, and initialization. Process
   * separation alone is not proof of a security sandbox.
   */
  readonly createExecutor: (
    moduleGenerationId: string,
  ) => ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult>;
  readonly classifyFailure: (failure: ReactiveModuleFailure) => FailureClassification;
  readonly onActorEvent?: (event: ModuleActorEvent) => void;
}

interface UnresolvedRun {
  readonly claim: DeliveryClaim;
  // `executor-termination` selects the preserve-only recovery behavior
  // described by the public recovery reason above.
  readonly kind: "commit" | "nack" | "executor-termination";
  readonly output?: ReactiveModuleResult;
  readonly failure: ReactiveModuleFailure;
  readonly classification?: FailureClassification;
  readonly reason: Extract<
    ReactiveModuleTickResult,
    { readonly status: "recovery-required" }
  >["reason"];
}

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReactiveModuleRuntimeError(
      "RUNTIME_CONFIGURATION_INVALID",
      `${label} must be a positive safe integer`,
    );
  }
}

function assertTimerDelay(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new ReactiveModuleRuntimeError(
      "RUNTIME_CONFIGURATION_INVALID",
      `${label} must be a positive integer within the supported timer range`,
    );
  }
}

function cloneCanonical<T>(value: T, label: string): T {
  try {
    assertJsonValue(value);
    return deepFreeze(cloneJson(value as unknown as JsonValue)) as T;
  } catch {
    throw new TypeError(`${label} must be canonical JSON data`);
  }
}

function snapshotResult(
  value: ReactiveModuleResult,
  maxResultBytes: number,
): ReactiveModuleResult {
  const result = cloneCanonical(value, "Module result");
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("Module result must be an object");
  }
  const keys = Object.keys(result);
  if (
    result.schemaVersion !== "dolly.module-result/1" ||
    keys.some((key) => key !== "schemaVersion" && key !== "blockProposal")
  ) {
    throw new TypeError("Module result schema is invalid");
  }
  if (canonicalJsonByteLength(result as unknown as JsonValue) > maxResultBytes) {
    throw new TypeError("Module result exceeds the configured byte limit");
  }
  return result;
}

function claimIdentity(claim: DeliveryClaim): DeliveryClaimIdentity {
  return {
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: claim.moduleGenerationId,
  };
}

function sameCommittedResult(
  record: ModuleResultCommitRecord,
  claim: DeliveryClaim,
  source: SourceIdentity,
  outputPageIds: readonly string[],
  output: ReactiveModuleResult,
): boolean {
  return (
    record.state === "committed" &&
    record.moduleJobId === claim.moduleJobId &&
    record.claimToken === claim.claimToken &&
    record.runId === claim.runId &&
    record.attempt === claim.attempt &&
    record.moduleGenerationId === claim.moduleGenerationId &&
    record.resultDigest ===
      moduleJobResultDigest({
        source,
        outputPageIds,
        ...(output.blockProposal === undefined ? {} : { blockProposal: output.blockProposal }),
      })
  );
}

export class ReactiveModuleRuntime {
  readonly #moduleId: string;
  readonly #inputPageIds: readonly string[];
  readonly #outputPageIds: readonly string[];
  readonly #claimMaxCount: number;
  readonly #claimMaxBytes: number;
  readonly #maxInputBytes: number;
  readonly #executionTimeoutMs: number;
  readonly #cancellationGraceMs: number;
  readonly #deliveries: DeliveryStore;
  readonly #commits: ModuleResultCommitCoordinator;
  readonly #declaredExternalEffects: "none" | "core-capabilities-only";
  readonly #source: SourceIdentity;
  readonly #classifyFailure: ReactiveModuleRuntimeOptions["classifyFailure"];
  readonly #actor: ModuleActor<ReactiveModuleInput, ReactiveModuleResult>;
  readonly #acceptedRecords = new Map<string, ModuleResultCommitRecord>();
  readonly #attemptedOutputs = new Map<string, ReactiveModuleResult>();
  #activeClaim: DeliveryClaim | undefined;
  /** Claim created in memory whose final persistence callback failed. */
  #claimAwaitingPersistenceConfirmation: DeliveryClaim | undefined;
  #inFlight: Promise<ReactiveModuleTickResult> | undefined;
  #recoveryInFlight: Promise<ReactiveModuleRecoveryResult> | undefined;
  #unresolved: UnresolvedRun | undefined;
  #acceptingOperations = true;

  constructor(options: ReactiveModuleRuntimeOptions) {
    if (!ID_PATTERN.test(options.moduleId)) {
      throw new ReactiveModuleRuntimeError(
        "RUNTIME_CONFIGURATION_INVALID",
        "moduleId is not a valid identifier",
      );
    }
    assertPositiveLimit(options.claimMaxCount, "claimMaxCount");
    assertPositiveLimit(options.claimMaxBytes, "claimMaxBytes");
    assertPositiveLimit(options.maxInputBytes, "maxInputBytes");
    assertPositiveLimit(options.maxResultBytes, "maxResultBytes");
    assertTimerDelay(options.executionTimeoutMs, "executionTimeoutMs");
    assertTimerDelay(options.cancellationGraceMs, "cancellationGraceMs");
    assertTimerDelay(options.initializationTimeoutMs, "initializationTimeoutMs");
    assertTimerDelay(options.terminationTimeoutMs, "terminationTimeoutMs");
    if (options.executionTimeoutMs > MAX_TIMER_DELAY_MS - options.cancellationGraceMs) {
      throw new ReactiveModuleRuntimeError(
        "RUNTIME_CONFIGURATION_INVALID",
        "executionTimeoutMs plus cancellationGraceMs exceeds the supported timer range",
      );
    }
    if (typeof options.classifyFailure !== "function") {
      throw new ReactiveModuleRuntimeError(
        "RUNTIME_CONFIGURATION_INVALID",
        "classifyFailure must be a function",
      );
    }
    this.#moduleId = options.moduleId;
    try {
      this.#inputPageIds = options.deliveries.validateClaimPages(
        options.moduleId,
        options.inputPageIds,
      );
      this.#outputPageIds = options.deliveries.validateOutputPages(options.outputPageIds);
    } catch {
      throw new ReactiveModuleRuntimeError(
        "RUNTIME_CONFIGURATION_INVALID",
        "Reactive Module Page routes are invalid or not registered",
      );
    }
    this.#claimMaxCount = options.claimMaxCount;
    this.#claimMaxBytes = options.claimMaxBytes;
    this.#maxInputBytes = options.maxInputBytes;
    this.#executionTimeoutMs = options.executionTimeoutMs;
    this.#cancellationGraceMs = options.cancellationGraceMs;
    this.#deliveries = options.deliveries;
    this.#commits = options.commits;
    this.#source = deepFreeze({ kind: "module", id: options.moduleId });
    // Defaulting to the stricter value keeps an unconfigured Module from being
    // classified as failed after a Run whose result never reached the journal.
    this.#declaredExternalEffects =
      options.declaredExternalEffects ?? "core-capabilities-only";
    this.#classifyFailure = options.classifyFailure;

    const actorOptions: ModuleActorOptions<ReactiveModuleInput, ReactiveModuleResult> = {
      moduleId: options.moduleId,
      initialModuleGenerationId: options.initialModuleGenerationId,
      maxQueuedRuns: 0,
      maxQueuedInputBytes: 0,
      maxInputBytes: options.maxInputBytes,
      maxRunsPerGeneration: options.maxRunsPerGeneration,
      maxGenerations: options.maxGenerations,
      requireProcessIsolation: true,
      initializationTimeoutMs: options.initializationTimeoutMs,
      terminationTimeoutMs: options.terminationTimeoutMs,
      nextModuleGenerationId: options.nextModuleGenerationId,
      monotonicNow: options.monotonicNow,
      snapshotInput: (input) => cloneCanonical(input, "Module input"),
      measureInputBytes: measureReactiveModuleInput,
      snapshotOutput: (output) => snapshotResult(output, options.maxResultBytes),
      createExecutor: options.createExecutor,
      acceptResult: (output, context) => this.#acceptResult(output, context),
      ...(options.onActorEvent === undefined ? {} : { onEvent: options.onActorEvent }),
    };
    this.#actor = new ModuleActor(actorOptions);
  }

  get state(): ModuleActorState {
    return this.#actor.state;
  }

  get moduleGenerationId(): string {
    return this.#actor.moduleGenerationId;
  }

  get activeRun(): Readonly<ModuleActiveRunStatus> | null {
    return this.#actor.activeRun;
  }

  start(): Promise<void> {
    if (!this.#acceptingOperations) {
      return Promise.reject(
        new ReactiveModuleRuntimeError("RUNTIME_STOPPING", "Reactive Module runtime is stopping"),
      );
    }
    return this.#actor.start();
  }

  tick(): Promise<ReactiveModuleTickResult> {
    if (!this.#acceptingOperations) {
      return Promise.reject(
        new ReactiveModuleRuntimeError("RUNTIME_STOPPING", "Reactive Module runtime is stopping"),
      );
    }
    if (this.#actor.state === "created" || this.#actor.state === "starting") {
      return Promise.reject(
        new ReactiveModuleRuntimeError(
          "RUNTIME_NOT_STARTED",
          "Reactive Module runtime has not started",
        ),
      );
    }
    if (this.#actor.state === "failed") {
      return Promise.reject(
        new ReactiveModuleRuntimeError("RUNTIME_FAILED", "Reactive Module runtime has failed"),
      );
    }
    if (this.#claimAwaitingPersistenceConfirmation || this.#unresolved) {
      return Promise.reject(
        new ReactiveModuleRuntimeError(
          "RUNTIME_RECOVERY_REQUIRED",
          "A prior Module job must be recovered before another tick",
        ),
      );
    }
    if (this.#inFlight || this.#recoveryInFlight) {
      return Promise.reject(
        new ReactiveModuleRuntimeError("RUNTIME_BUSY", "Reactive Module runtime is busy"),
      );
    }

    const operation = this.#performTick();
    this.#inFlight = operation;
    void operation.then(
      () => {
        if (this.#inFlight === operation) this.#inFlight = undefined;
      },
      () => {
        if (this.#inFlight === operation) this.#inFlight = undefined;
      },
    );
    return operation;
  }

  softTimeout(runId: string): "cancellation-requested" {
    if (!this.#acceptingOperations) {
      throw new ReactiveModuleRuntimeError(
        "RUNTIME_STOPPING",
        "Reactive Module runtime is stopping",
      );
    }
    return this.#actor.softTimeout(runId);
  }

  hardTimeout(runId: string): Promise<"module-generation-fenced"> {
    if (!this.#acceptingOperations) {
      return Promise.reject(
        new ReactiveModuleRuntimeError(
          "RUNTIME_STOPPING",
          "Reactive Module runtime is stopping",
        ),
      );
    }
    return this.#actor.hardTimeout(runId);
  }

  recover(): Promise<ReactiveModuleRecoveryResult> {
    if (!this.#acceptingOperations) {
      return Promise.reject(
        new ReactiveModuleRuntimeError("RUNTIME_STOPPING", "Reactive Module runtime is stopping"),
      );
    }
    if (this.#recoveryInFlight) return this.#recoveryInFlight;
    const operation = this.#performRecovery();
    this.#recoveryInFlight = operation;
    void operation.then(
      () => {
        if (this.#recoveryInFlight === operation) this.#recoveryInFlight = undefined;
      },
      () => {
        if (this.#recoveryInFlight === operation) this.#recoveryInFlight = undefined;
      },
    );
    return operation;
  }

  async #performRecovery(): Promise<ReactiveModuleRecoveryResult> {
    if (this.#inFlight) {
      throw new ReactiveModuleRuntimeError(
        "RUNTIME_BUSY",
        "Cannot recover while a Module tick is still active",
      );
    }
    const claimAwaitingPersistenceConfirmation = this.#claimAwaitingPersistenceConfirmation;
    if (claimAwaitingPersistenceConfirmation) {
      return this.#recoverClaimAfterPersistenceConfirmation(
        claimAwaitingPersistenceConfirmation,
      );
    }

    const unresolved = this.#unresolved;
    if (!unresolved) return { status: "nothing-to-recover" };

    if (unresolved.kind === "executor-termination") {
      return deepFreeze({
        ...claimIdentity(unresolved.claim),
        status: "recovery-required",
        reason: unresolved.reason,
      });
    }

    if (unresolved.kind === "commit") {
      if (!unresolved.output) {
        return deepFreeze({
          ...claimIdentity(unresolved.claim),
          status: "recovery-required",
          reason: unresolved.reason,
        });
      }
      return this.#tryRecoverCommit(unresolved.claim, unresolved.output, unresolved.failure);
    }
    return this.#nack(
      unresolved.claim,
      unresolved.failure,
      unresolved.classification,
    );
  }

  async stop(options: ModuleStopOptions = {}): Promise<void> {
    this.#acceptingOperations = false;
    const inFlight = this.#inFlight;
    const recoveryInFlight = this.#recoveryInFlight;
    const actorStopOptions: ModuleStopOptions = {
      cancellationGraceMs: options.cancellationGraceMs ?? this.#cancellationGraceMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    try {
      await Promise.all([
        this.#actor.stop(actorStopOptions),
        inFlight === undefined ? Promise.resolve() : inFlight.then(() => undefined),
        recoveryInFlight === undefined
          ? Promise.resolve()
          : recoveryInFlight.then(() => undefined),
      ]);
    } catch (error) {
      await Promise.resolve();
      if (this.#claimAwaitingPersistenceConfirmation || this.#unresolved) {
        throw new ReactiveModuleRuntimeError(
          "RUNTIME_RECOVERY_REQUIRED",
          "Module stopped with an unresolved Module job outcome",
        );
      }
      throw error;
    }
    if (this.#claimAwaitingPersistenceConfirmation || this.#unresolved) {
      throw new ReactiveModuleRuntimeError(
        "RUNTIME_RECOVERY_REQUIRED",
        "Module stopped with an unresolved Module job outcome",
      );
    }
    this.#releaseActiveClaimAfterShutdown();
  }

  async #performTick(): Promise<ReactiveModuleTickResult> {
    let claim: DeliveryClaim | null;
    try {
      claim = this.#deliveries.claim({
        consumerId: this.#moduleId,
        pageIds: this.#inputPageIds,
        moduleGenerationId: this.#actor.moduleGenerationId,
        maxCount: this.#claimMaxCount,
        maxBytes: this.#claimMaxBytes,
        maxInputBytes: this.#maxInputBytes,
      });
    } catch (error) {
      if (error instanceof DeliveryClaimPersistenceUnconfirmedError) {
        return this.#requireClaimPersistenceRecovery(error.claim);
      }
      throw new ReactiveModuleRuntimeError(
        "RUNTIME_CLAIM_FAILED",
        "Reactive Module input claim failed",
      );
    }
    if (!claim) return { status: "idle" };

    return this.#executeClaim(claim);
  }

  async #recoverClaimAfterPersistenceConfirmation(
    claim: DeliveryClaim,
  ): Promise<ReactiveModuleRecoveryResult> {
    try {
      this.#deliveries.flushPersistence();
    } catch {
      return this.#requireClaimPersistenceRecovery(claim);
    }

    try {
      const descriptor = this.#deliveries.inspectClaim(claimIdentity(claim));
      if (descriptor.status !== "active" || descriptor.consumerId !== this.#moduleId) {
        return this.#requireClaimPersistenceRecovery(claim);
      }
    } catch {
      return this.#requireClaimPersistenceRecovery(claim);
    }

    this.#claimAwaitingPersistenceConfirmation = undefined;
    return this.#executeClaim(claim);
  }

  async #executeClaim(
    claim: DeliveryClaim,
  ): Promise<Exclude<ReactiveModuleTickResult, { readonly status: "idle" }>> {
    this.#activeClaim = claim;
    let input: ReactiveModuleInput;
    try {
      input = buildReactiveModuleInput({
        claimedDeliveryIds: claim.deliveryIds,
        blockGroups: claim.blockGroups,
        hasMore: claim.hasMore,
      });
    } catch {
      return this.#nack(claim, {
        stage: "actor-submission",
        code: "INPUT_SNAPSHOT_REJECTED",
      });
    }

    let outcome: ModuleRunOutcome<ReactiveModuleResult>;
    let softTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completion = this.#actor.submit({
        moduleGenerationId: claim.moduleGenerationId,
        moduleJobId: claim.moduleJobId,
        runId: claim.runId,
        attempt: claim.attempt,
        input,
      });
      softTimeoutTimer = setTimeout(() => {
        if (!this.#acceptingOperations) return;
        try {
          this.#actor.softTimeout(claim.runId);
        } catch {
          // The run completed or entered result acceptance before the timer fired.
        }
      }, this.#executionTimeoutMs);
      hardTimeoutTimer = setTimeout(() => {
        if (!this.#acceptingOperations) return;
        try {
          void this.#actor.hardTimeout(claim.runId).catch(() => undefined);
        } catch {
          // The run completed or was already fenced before the timer fired.
        }
      }, this.#executionTimeoutMs + this.#cancellationGraceMs);
      outcome = await completion;
    } catch (error) {
      if (
        !this.#acceptingOperations &&
        error instanceof ModuleActorError &&
        (error.code === "ACTOR_STOPPING" || error.code === "ACTOR_STOPPED")
      ) {
        return this.#cancelledByShutdown(claim);
      }
      return this.#nack(claim, {
        stage: "actor-submission",
        code:
          error instanceof ModuleActorError ? error.code : "ACTOR_SUBMISSION_REJECTED",
      });
    } finally {
      if (softTimeoutTimer) clearTimeout(softTimeoutTimer);
      if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
    }

    if (outcome.status === "succeeded") {
      const record = this.#acceptedRecords.get(claim.runId);
      this.#clearTransient(claim.runId);
      if (record && sameCommittedResult(record, claim, this.#source, this.#outputPageIds, outcome.output)) {
        return deepFreeze({
          ...claimIdentity(claim),
          status: "committed",
          recovered: false,
          record,
        });
      }
      return this.#requireRecovery(claim, {
        kind: "commit",
        output: outcome.output,
        failure: { stage: "result-rejected-before-prepare", code: "COMMIT_CONFIRMATION_MISSING" },
        reason: "commit-outcome-unknown",
      });
    }

    if (
      outcome.status === "failed" &&
      outcome.error.code === "RESULT_ACCEPTANCE_UNCERTAIN"
    ) {
      const output = this.#attemptedOutputs.get(claim.runId);
      this.#clearTransient(claim.runId);
      if (!output) {
        return this.#requireRecovery(claim, {
          kind: "commit",
          failure: {
            stage: "result-rejected-before-prepare",
            code: "COMMIT_ATTEMPT_MISSING",
          },
          reason: "commit-outcome-unknown",
        });
      }
      return this.#tryRecoverCommit(claim, output, {
        stage: "result-rejected-before-prepare",
        code: "RESULT_REJECTED_BEFORE_PREPARE",
      });
    }

    if (
      outcome.status === "failed" &&
      outcome.error.code === "EXECUTOR_TERMINATION_UNCONFIRMED"
    ) {
      this.#clearTransient(claim.runId);
      return this.#requireRecovery(claim, {
        kind: "executor-termination",
        failure: {
          stage: "module-execution",
          code: outcome.error.code,
        },
        reason: "executor-termination-unconfirmed",
      });
    }

    if (outcome.status === "cancelled") {
      return this.#cancelledByShutdown(claim);
    }

    this.#clearTransient(claim.runId);
    return this.#nack(claim, this.#failureForOutcome(outcome));
  }

  async #acceptResult(output: ReactiveModuleResult, context: ModuleRunContext): Promise<void> {
    const claim = this.#activeClaim;
    if (
      !claim ||
      claim.moduleJobId !== context.moduleJobId ||
      claim.runId !== context.runId ||
      claim.attempt !== context.attempt ||
      claim.moduleGenerationId !== context.moduleGenerationId
    ) {
      throw new ReactiveModuleRuntimeError(
        "RUNTIME_RECOVERY_REQUIRED",
        "Result acceptance did not match the active Claim identity",
      );
    }
    this.#attemptedOutputs.set(context.runId, output);
    const record = await this.#commits.commit({
      ...claimIdentity(claim),
      source: this.#source,
      outputPageIds: this.#outputPageIds,
      ...(output.blockProposal === undefined ? {} : { blockProposal: output.blockProposal }),
    });
    this.#acceptedRecords.set(context.runId, record);
  }

  async #tryRecoverCommit(
    claim: DeliveryClaim,
    output: ReactiveModuleResult,
    noRecordFailure: ReactiveModuleFailure,
  ): Promise<Exclude<ReactiveModuleTickResult, { readonly status: "idle" }>> {
    try {
      const record = await this.#commits.recover(claim.moduleJobId);
      if (sameCommittedResult(record, claim, this.#source, this.#outputPageIds, output)) {
        this.#unresolved = undefined;
        this.#activeClaim = undefined;
        return deepFreeze({
          ...claimIdentity(claim),
          status: "committed",
          recovered: true,
          record,
        });
      }
      return this.#requireRecovery(claim, {
        kind: "commit",
        output,
        failure: noRecordFailure,
        reason: "commit-result-conflict",
      });
    } catch {
      try {
        const existing = this.#commits.inspect(claim.moduleJobId);
        // No journal record means this Run produced no committed result. The
        // Module still executed, so it may have caused an external effect
        // through a capability. Only a Module that declared no external effect
        // at all can be classified as failed here; every other Module keeps
        // its exact Claim as an unknown outcome, because repeating the Run
        // could add a second effect.
        if (existing === null && this.#declaredExternalEffects === "none") {
          return this.#nack(claim, noRecordFailure);
        }
      } catch {
        // A repository read failure is itself an unknown commit outcome.
      }
      return this.#requireRecovery(claim, {
        kind: "commit",
        output,
        failure: noRecordFailure,
        reason: "commit-outcome-unknown",
      });
    }
  }

  #failureForOutcome(
    outcome: Exclude<
      ModuleRunOutcome<ReactiveModuleResult>,
      { readonly status: "succeeded" } | { readonly status: "cancelled" }
    >,
  ): ReactiveModuleFailure {
    if (outcome.status === "failed") {
      return outcome.error.code === "OUTPUT_SNAPSHOT_FAILED"
        ? { stage: "output-snapshot", code: outcome.error.code }
        : { stage: "module-execution", code: outcome.error.code };
    }
    if (outcome.status === "timed-out") {
      return { stage: "soft-timeout", code: "MODULE_TIMED_OUT" };
    }
    return { stage: "generation-fenced", code: "MODULE_GENERATION_FENCED" };
  }

  #cancelledByShutdown(
    claim: DeliveryClaim,
  ): Extract<ReactiveModuleTickResult, { readonly status: "cancelled" }> {
    this.#acceptedRecords.delete(claim.runId);
    this.#attemptedOutputs.delete(claim.runId);
    return deepFreeze({
      ...claimIdentity(claim),
      status: "cancelled",
      reason: "shutdown",
    });
  }

  #releaseActiveClaimAfterShutdown(): void {
    const claim = this.#activeClaim;
    if (!claim) return;
    try {
      this.#deliveries.releaseClaim(claimIdentity(claim));
      this.#activeClaim = undefined;
      return;
    } catch {
      try {
        this.#deliveries.flushPersistence();
        const descriptor = this.#deliveries.inspectClaim(claimIdentity(claim));
        if (descriptor.status === "released" && descriptor.consumerId === this.#moduleId) {
          this.#activeClaim = undefined;
          return;
        }
      } catch {
        // Retain the exact Claim identity so a later stop can reconcile persistence.
      }
      throw new ReactiveModuleRuntimeError(
        "RUNTIME_RECOVERY_REQUIRED",
        "Module executor stopped, but Delivery Claim release persistence is unconfirmed",
      );
    }
  }

  #classify(failure: ReactiveModuleFailure): FailureClassification {
    try {
      const classification = this.#classifyFailure(deepFreeze({ ...failure }));
      if (
        classification === null ||
        typeof classification !== "object" ||
        !ID_PATTERN.test(classification.code) ||
        typeof classification.retryable !== "boolean"
      ) {
        throw new TypeError("invalid failure classification");
      }
      return deepFreeze({ code: classification.code, retryable: classification.retryable });
    } catch {
      throw new ReactiveModuleRuntimeError(
        "RUNTIME_RECOVERY_REQUIRED",
        "Module failure policy did not return a classification",
      );
    }
  }

  #nack(
    claim: DeliveryClaim,
    failure: ReactiveModuleFailure,
    knownClassification?: FailureClassification,
  ): Exclude<ReactiveModuleTickResult, { readonly status: "idle" }> {
    let classification: FailureClassification;
    try {
      classification = knownClassification ?? this.#classify(failure);
    } catch {
      return this.#requireRecovery(claim, {
        kind: "nack",
        failure,
        reason: "failure-policy-unavailable",
      });
    }

    try {
      const status = this.#deliveries.nack({
        ...claimIdentity(claim),
        failure: classification,
      });
      this.#unresolved = undefined;
      this.#activeClaim = undefined;
      return deepFreeze({ ...claimIdentity(claim), status, failure: classification });
    } catch {
      try {
        const descriptor = this.#deliveries.inspectClaim(claimIdentity(claim));
        if (descriptor.status === "nacked" || descriptor.status === "dead-lettered") {
          const status =
            descriptor.status === "nacked" ? "retry-scheduled" : "dead-lettered";
          this.#unresolved = undefined;
          this.#activeClaim = undefined;
          return deepFreeze({ ...claimIdentity(claim), status, failure: classification });
        }
        if (descriptor.status === "committed") {
          return this.#requireRecovery(claim, {
            kind: "nack",
            failure,
            classification,
            reason: "commit-result-conflict",
          });
        }
      } catch {
        // The claim disposition is unknown until the exact fence can be queried.
      }
      return this.#requireRecovery(claim, {
        kind: "nack",
        failure,
        classification,
        reason: "nack-outcome-unknown",
      });
    }
  }

  #requireRecovery(
    claim: DeliveryClaim,
    unresolved: Omit<UnresolvedRun, "claim">,
  ): Extract<ReactiveModuleTickResult, { readonly status: "recovery-required" }> {
    this.#unresolved = { claim, ...unresolved };
    this.#activeClaim = undefined;
    return deepFreeze({
      ...claimIdentity(claim),
      status: "recovery-required",
      reason: unresolved.reason,
    });
  }

  #requireClaimPersistenceRecovery(
    claim: DeliveryClaim,
  ): Extract<ReactiveModuleTickResult, { readonly status: "recovery-required" }> {
    this.#claimAwaitingPersistenceConfirmation = claim;
    this.#activeClaim = undefined;
    return deepFreeze({
      ...claimIdentity(claim),
      status: "recovery-required",
      reason: "claim-persistence-unconfirmed",
    });
  }

  #clearTransient(runId: string): void {
    this.#acceptedRecords.delete(runId);
    this.#attemptedOutputs.delete(runId);
    if (this.#activeClaim?.runId === runId) this.#activeClaim = undefined;
  }
}
