import { describe, expect, it, vi } from "vitest";
import { BlockStore, type BlockProposal } from "../../../src/core/block-store.js";
import type {
  ExternalEffectEvidence,
  ExternalEffectEvidenceSource,
} from "../../../src/core/core-startup-recovery.js";
import {
  DeliveryClaimPersistenceUnconfirmedError,
  DeliveryStore,
  type DeliveryClaim,
  type FailureClassification,
} from "../../../src/core/delivery-store.js";
import type { ModuleSubmissionRecord } from "../../../src/core/module-process-records.js";
import {
  InMemoryModuleResultCommitRepository,
  ModuleResultCommitBackpressureError,
  ModuleResultCommitCoordinator,
  type ModuleResultCommitHookEvent,
} from "../../../src/core/module-result-commit.js";
import {
  ReactiveModuleRuntime,
  type ReactiveModuleFailure,
  type ReactiveModuleInput,
  type ReactiveModuleResult,
  type ReactiveModuleRuntimeOptions,
} from "../../../src/core/reactive-module-runtime.js";
import type { ModuleExecutor } from "../../../src/core/module-actor.js";

const NOW = "2026-07-24T00:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function proposal(text: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "text", text, format: "plain" }] },
    },
  };
}

interface HarnessOptions {
  readonly createExecutor: (
    moduleGenerationId: string,
  ) => ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult>;
  readonly afterEffect?: (event: ModuleResultCommitHookEvent) => void | Promise<void>;
  readonly classifyFailure?: (failure: ReactiveModuleFailure) => FailureClassification;
  readonly wrapDeliveries?: (
    deliveries: DeliveryStore,
  ) => ReactiveModuleRuntimeOptions["deliveries"];
  readonly wrapReleaseDeliveryClaim?: (
    releaseDeliveryClaim: ReactiveModuleRuntimeOptions["releaseDeliveryClaim"],
    deliveries: DeliveryStore,
    submissionRecords: Map<string, ModuleSubmissionRecord>,
  ) => ReactiveModuleRuntimeOptions["releaseDeliveryClaim"];
  readonly wrapNegativelyAcknowledgeDeliveryClaim?: (
    negativelyAcknowledgeDeliveryClaim:
      ReactiveModuleRuntimeOptions["negativelyAcknowledgeDeliveryClaim"],
    deliveries: DeliveryStore,
    submissionRecords: Map<string, ModuleSubmissionRecord>,
  ) => ReactiveModuleRuntimeOptions["negativelyAcknowledgeDeliveryClaim"];
  readonly wrapPersistModuleSubmission?: (
    persistModuleSubmission: ReactiveModuleRuntimeOptions["persistModuleSubmission"],
    submissionRecords: Map<string, ModuleSubmissionRecord>,
  ) => ReactiveModuleRuntimeOptions["persistModuleSubmission"];
  readonly reportDeletedSubmissionAsPresent?: boolean;
  readonly outputPageIds?: readonly string[];
  readonly maxResultBytes?: number;
  readonly executionTimeoutMs?: number;
  readonly cancellationGraceMs?: number;
  readonly initializationTimeoutMs?: number;
  readonly terminationTimeoutMs?: number;
  /** Unit-test executors simulate the process-isolation contract by default. */
  readonly simulateProcessIsolation?: boolean;
  readonly declaredExternalEffects?:
    | "unrestricted"
    | "none"
    | "core-capabilities-only"
    | null;
  /** `null` deliberately leaves the product evidence source unconfigured. */
  readonly externalEffectEvidence?: ExternalEffectEvidenceSource | null;
}

function createHarness(options: HarnessOptions) {
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
  deliveries.createPage("output");
  deliveries.registerConsumer("input", "worker", "from-now");
  deliveries.registerConsumer("output", "sink", "from-now");
  const inputBlock = blocks.commit(proposal("input"), { kind: "external", id: "console" });
  deliveries.append("input", inputBlock.id);
  const repository = new InMemoryModuleResultCommitRepository();
  const submissionRecords = new Map<string, ModuleSubmissionRecord>();
  const submittedRecords = new Map<string, ModuleSubmissionRecord>();
  const persistModuleSubmission: ReactiveModuleRuntimeOptions["persistModuleSubmission"] = (
    request,
  ): void => {
    const submission: ModuleSubmissionRecord = {
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: request.moduleJobId,
      claimToken: request.claimToken,
      runId: request.runId,
      attempt: request.attempt,
      moduleGenerationId: request.moduleGenerationId,
      processGenerationId: "process-generation-unit-test-1",
      inputDigest: request.inputDigest,
      createdAt: NOW,
    };
    submissionRecords.set(request.runId, submission);
    submittedRecords.set(request.runId, submission);
  };
  const removeSubmissionAfterTerminalClaim = (
    identity: Parameters<DeliveryStore["inspectClaim"]>[0],
    expectedStatuses: readonly ReturnType<DeliveryStore["inspectClaim"]>["status"][],
  ): void => {
    const descriptor = deliveries.inspectClaim(identity);
    if (expectedStatuses.includes(descriptor.status)) {
      submissionRecords.delete(identity.runId);
    }
  };
  const commits = new ModuleResultCommitCoordinator({
    blocks,
    deliveries,
    acknowledgeDeliveryClaim: (identity) => {
      try {
        const result = deliveries.ack(identity);
        submissionRecords.delete(identity.runId);
        return result;
      } catch (error) {
        try {
          removeSubmissionAfterTerminalClaim(identity, ["committed"]);
        } catch {
          // The test store cannot confirm that its terminal mutation persisted.
        }
        throw error;
      }
    },
    getModuleSubmissionRecord: (runId) => submissionRecords.get(runId),
    repository,
    now: () => NOW,
    ...(options.afterEffect === undefined ? {} : { afterEffect: options.afterEffect }),
  });
  const classifyFailure =
    options.classifyFailure ??
    ((failure: ReactiveModuleFailure) => ({
      code: failure.code,
      retryable: failure.stage !== "result-rejected-before-prepare",
    }));
  const configuredDeliveries = options.wrapDeliveries?.(deliveries) ?? deliveries;
  const runtimeDeliveries: ReactiveModuleRuntimeOptions["deliveries"] = {
    validateClaimPages: configuredDeliveries.validateClaimPages.bind(configuredDeliveries),
    validateOutputPages: configuredDeliveries.validateOutputPages.bind(configuredDeliveries),
    claim: (request) => configuredDeliveries.claim(request),
    flushPersistence: () => configuredDeliveries.flushPersistence(),
    inspectClaim: (request) => configuredDeliveries.inspectClaim(request),
    inspectClaimInput: (request) =>
      configuredDeliveries.inspectClaimInput(request),
  };
  const persistSubmission = vi.fn(
    options.wrapPersistModuleSubmission?.(
      persistModuleSubmission,
      submissionRecords,
    ) ?? persistModuleSubmission,
  );
  const releaseClaim = (identity: Parameters<DeliveryStore["releaseClaim"]>[0]) => {
    try {
      const result = deliveries.releaseClaim(identity);
      submissionRecords.delete(identity.runId);
      return result;
    } catch (error) {
      try {
        removeSubmissionAfterTerminalClaim(identity, ["released"]);
      } catch {
        // The test store cannot confirm that its terminal mutation persisted.
      }
      throw error;
    }
  };
  const releaseDeliveryClaim = vi.fn(
    options.wrapReleaseDeliveryClaim?.(
      releaseClaim,
      deliveries,
      submissionRecords,
    ) ?? releaseClaim,
  );
  const negativelyAcknowledgeClaim = (
    request: Parameters<DeliveryStore["nack"]>[0],
  ) => {
    try {
      const result = deliveries.nack(request);
      submissionRecords.delete(request.runId);
      return result;
    } catch (error) {
      try {
        removeSubmissionAfterTerminalClaim(request, ["nacked", "dead-lettered"]);
      } catch {
        // The test store cannot confirm that its terminal mutation persisted.
      }
      throw error;
    }
  };
  const negativelyAcknowledgeDeliveryClaim = vi.fn(
    options.wrapNegativelyAcknowledgeDeliveryClaim?.(
      negativelyAcknowledgeClaim,
      deliveries,
      submissionRecords,
    ) ?? negativelyAcknowledgeClaim,
  );
  const createExecutor =
    options.simulateProcessIsolation === false
      ? options.createExecutor
      : (moduleGenerationId: string) => ({
          isolation: "process" as const,
          start: async () => undefined,
          terminate: async () => undefined,
          ...options.createExecutor(moduleGenerationId),
        });
  const externalEffectEvidence =
    options.externalEffectEvidence === undefined
      ? {
          inspectRunEffects: async (): Promise<ExternalEffectEvidence> => ({
            kind: "no-effect",
          }),
        }
      : options.externalEffectEvidence;
  const runtime = new ReactiveModuleRuntime({
    moduleId: "worker",
    initialModuleGenerationId: "generation-1",
    inputPageIds: ["input"],
    outputPageIds: options.outputPageIds ?? ["output"],
    claimMaxCount: 10,
    claimMaxBytes: 1024 * 1024,
    maxInputBytes: 2 * 1024 * 1024,
    maxResultBytes: options.maxResultBytes ?? 2 * 1024 * 1024,
    executionTimeoutMs: options.executionTimeoutMs ?? 60_000,
    cancellationGraceMs: options.cancellationGraceMs ?? 1_000,
    initializationTimeoutMs: options.initializationTimeoutMs ?? 1_000,
    terminationTimeoutMs: options.terminationTimeoutMs ?? 1_000,
    maxRunsPerGeneration: 100,
    maxGenerations: 8,
    deliveries: runtimeDeliveries,
    persistModuleSubmission: persistSubmission,
    releaseDeliveryClaim,
    negativelyAcknowledgeDeliveryClaim,
    getModuleSubmissionRecord: (runId) =>
      options.reportDeletedSubmissionAsPresent === true
        ? submittedRecords.get(runId)
        : submissionRecords.get(runId),
    commits,
    nextModuleGenerationId: () => `generation-${++generation}`,
    monotonicNow: () => 1,
    createExecutor,
    classifyFailure,
    ...(options.declaredExternalEffects === null
      ? {}
      : {
          declaredExternalEffects:
            options.declaredExternalEffects ?? "core-capabilities-only",
        }),
    ...(externalEffectEvidence === null ? {} : { externalEffectEvidence }),
  });
  return {
    blocks,
    deliveries,
    runtimeDeliveries,
    repository,
    submissionRecords,
    persistModuleSubmission: persistSubmission,
    commits,
    releaseDeliveryClaim,
    negativelyAcknowledgeDeliveryClaim,
    externalEffectEvidence,
    runtime,
  };
}

function readAndClaimDeliveries(
  deliveries: DeliveryStore,
): ReactiveModuleRuntimeOptions["deliveries"] {
  return {
    validateClaimPages: deliveries.validateClaimPages.bind(deliveries),
    validateOutputPages: deliveries.validateOutputPages.bind(deliveries),
    claim: deliveries.claim.bind(deliveries),
    flushPersistence: deliveries.flushPersistence.bind(deliveries),
    inspectClaim: deliveries.inspectClaim.bind(deliveries),
    inspectClaimInput: deliveries.inspectClaimInput.bind(deliveries),
  };
}

async function startedHarness(options: HarnessOptions) {
  const harness = createHarness(options);
  await harness.runtime.start();
  return harness;
}

describe("CORE-004 reactive Module claim/run/commit coordination", () => {
  it("uses per-dispatch Claim limits without exceeding the runtime maximum", async () => {
    let observedInput: ReactiveModuleInput | undefined;
    const harness = await startedHarness({
      createExecutor: () => ({
        execute: async (input) => {
          observedInput = input;
          return { schemaVersion: "dolly.module-result/1" };
        },
      }),
    });
    for (const value of ["second", "third"]) {
      const block = harness.blocks.commit(proposal(value), { kind: "external", id: "console" });
      harness.deliveries.append("input", block.id);
    }

    await expect(harness.runtime.tick({
      claimLimitCount: 11,
      claimLimitBytes: 1024 * 1024,
    })).rejects.toMatchObject({ code: "RUNTIME_CONFIGURATION_INVALID" });
    expect(harness.deliveries.inspectPending("worker", ["input"]).pendingCount).toBe(3);

    await expect(harness.runtime.tick({
      claimLimitCount: 1,
      claimLimitBytes: 1024 * 1024,
    })).resolves.toMatchObject({ status: "committed" });
    expect(observedInput).toMatchObject({
      hasMore: true,
      blockGroups: [{ occurrenceCount: 1 }],
    });
    expect(observedInput?.blockGroups).toHaveLength(1);
    expect(harness.deliveries.inspectPending("worker", ["input"]).pendingCount).toBe(2);
    await harness.runtime.stop();
  });

  it("rejects an invalid process termination timeout before creating an executor", () => {
    const createExecutor = vi.fn(() => ({
      execute: async () => ({ schemaVersion: "dolly.module-result/1" as const }),
    }));

    expect(() => createHarness({ terminationTimeoutMs: 0, createExecutor })).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CONFIGURATION_INVALID" }),
    );
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it("rejects an invalid process initialization timeout before creating an executor", () => {
    const createExecutor = vi.fn(() => ({
      execute: async () => ({ schemaVersion: "dolly.module-result/1" as const }),
    }));

    expect(() => createHarness({ initializationTimeoutMs: 0, createExecutor })).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CONFIGURATION_INVALID" }),
    );
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it("uses the negative-acknowledgement callback without terminal Delivery methods", async () => {
    const harness = await startedHarness({
      wrapDeliveries: readAndClaimDeliveries,
      createExecutor: () => ({
        execute: async () => Promise.reject(new Error("execution failed")),
      }),
    });

    expect(harness.runtimeDeliveries).not.toHaveProperty("ack");
    expect(harness.runtimeDeliveries).not.toHaveProperty("releaseClaim");
    expect(harness.runtimeDeliveries).not.toHaveProperty("nack");
    await expect(harness.runtime.tick()).resolves.toMatchObject({
      status: "retry-scheduled",
      failure: { code: "MODULE_EXECUTION_FAILED", retryable: true },
    });
    expect(harness.negativelyAcknowledgeDeliveryClaim).toHaveBeenCalledOnce();
    expect(harness.releaseDeliveryClaim).not.toHaveBeenCalled();
    await harness.runtime.stop();
  });

  it("uses the release callback without terminal Delivery methods", async () => {
    const executionStarted = deferred<void>();
    const execution = deferred<ReactiveModuleResult>();
    const harness = await startedHarness({
      wrapDeliveries: readAndClaimDeliveries,
      createExecutor: () => ({
        execute: async () => {
          executionStarted.resolve();
          return execution.promise;
        },
        cancel: () => execution.reject(new Error("shutdown")),
      }),
    });

    const tick = harness.runtime.tick();
    await executionStarted.promise;
    const stop = harness.runtime.stop();
    await expect(tick).resolves.toMatchObject({
      status: "cancelled",
      reason: "shutdown",
    });
    await expect(stop).resolves.toBeUndefined();
    expect(harness.releaseDeliveryClaim).toHaveBeenCalledOnce();
    expect(harness.negativelyAcknowledgeDeliveryClaim).not.toHaveBeenCalled();
  });

  it("does not accept a release callback result while the exact Claim remains active", async () => {
    const executionStarted = deferred<void>();
    const execution = deferred<ReactiveModuleResult>();
    const harness = await startedHarness({
      wrapDeliveries: readAndClaimDeliveries,
      wrapReleaseDeliveryClaim: () => () => "released",
      createExecutor: () => ({
        execute: async () => {
          executionStarted.resolve();
          return execution.promise;
        },
        cancel: () => execution.reject(new Error("shutdown")),
      }),
    });

    const tick = harness.runtime.tick();
    await executionStarted.promise;
    const stop = harness.runtime.stop();
    await expect(tick).resolves.toMatchObject({
      status: "cancelled",
      reason: "shutdown",
    });
    await expect(stop).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
    expect(harness.deliveries.listActiveClaims()).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);
  });

  it("does not accept a raw Claim release that leaves the submission record", async () => {
    const executionStarted = deferred<void>();
    const execution = deferred<ReactiveModuleResult>();
    const harness = await startedHarness({
      wrapReleaseDeliveryClaim: (_releaseDeliveryClaim, deliveries) =>
        (identity) => deliveries.releaseClaim(identity),
      createExecutor: () => ({
        execute: async () => {
          executionStarted.resolve();
          return execution.promise;
        },
        cancel: () => execution.reject(new Error("shutdown")),
      }),
    });

    const tick = harness.runtime.tick();
    await executionStarted.promise;
    const stop = harness.runtime.stop();
    const cancelled = await tick;
    expect(cancelled).toMatchObject({ status: "cancelled" });
    if (cancelled.status !== "cancelled") throw new Error("expected cancellation");
    await expect(stop).rejects.toMatchObject({ code: "RUNTIME_RECOVERY_REQUIRED" });
    expect(harness.deliveries.inspectClaim(cancelled).status).toBe("released");
    expect(harness.submissionRecords.get(cancelled.runId)).toBeDefined();
  });

  it("does not accept submission deletion while the exact Claim remains active", async () => {
    const executionStarted = deferred<void>();
    const execution = deferred<ReactiveModuleResult>();
    const harness = await startedHarness({
      wrapReleaseDeliveryClaim: (
        _releaseDeliveryClaim,
        _deliveries,
        submissionRecords,
      ) => (identity) => {
        submissionRecords.delete(identity.runId);
        return "released";
      },
      createExecutor: () => ({
        execute: async () => {
          executionStarted.resolve();
          return execution.promise;
        },
        cancel: () => execution.reject(new Error("shutdown")),
      }),
    });

    const tick = harness.runtime.tick();
    await executionStarted.promise;
    const stop = harness.runtime.stop();
    const cancelled = await tick;
    expect(cancelled).toMatchObject({ status: "cancelled" });
    if (cancelled.status !== "cancelled") throw new Error("expected cancellation");
    await expect(stop).rejects.toMatchObject({ code: "RUNTIME_RECOVERY_REQUIRED" });
    expect(harness.deliveries.inspectClaim(cancelled).status).toBe("active");
    expect(harness.submissionRecords.get(cancelled.runId)).toBeUndefined();
  });

  it("rejects a Promise-like release result even after both state changes complete", async () => {
    const executionStarted = deferred<void>();
    const execution = deferred<ReactiveModuleResult>();
    const harness = await startedHarness({
      wrapReleaseDeliveryClaim:
        (releaseDeliveryClaim) =>
        ((identity: Parameters<
          ReactiveModuleRuntimeOptions["releaseDeliveryClaim"]
        >[0]) => {
          releaseDeliveryClaim(identity);
          return { then: () => undefined };
        }) as unknown as ReactiveModuleRuntimeOptions["releaseDeliveryClaim"],
      createExecutor: () => ({
        execute: async () => {
          executionStarted.resolve();
          return execution.promise;
        },
        cancel: () => execution.reject(new Error("shutdown")),
      }),
    });

    const tick = harness.runtime.tick();
    await executionStarted.promise;
    const stop = harness.runtime.stop();
    const cancelled = await tick;
    expect(cancelled).toMatchObject({ status: "cancelled" });
    if (cancelled.status !== "cancelled") throw new Error("expected cancellation");
    await expect(stop).rejects.toMatchObject({ code: "RUNTIME_RECOVERY_REQUIRED" });
    expect(harness.deliveries.inspectClaim(cancelled).status).toBe("released");
    expect(harness.submissionRecords.get(cancelled.runId)).toBeUndefined();
  });

  it("does not accept a raw negative acknowledgement that leaves the submission record", async () => {
    const harness = await startedHarness({
      wrapNegativelyAcknowledgeDeliveryClaim: (
        _negativelyAcknowledgeDeliveryClaim,
        deliveries,
      ) => (request) => deliveries.nack(request),
      createExecutor: () => ({
        execute: async () => Promise.reject(new Error("execution failed")),
      }),
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({
      status: "recovery-required",
      reason: "nack-outcome-unknown",
    });
    if (result.status !== "recovery-required") {
      throw new Error("expected recovery");
    }
    expect(harness.deliveries.inspectClaim(result).status).toBe("nacked");
    expect(harness.submissionRecords.get(result.runId)).toBeDefined();
  });

  it("does not accept submission deletion while a negatively acknowledged Claim remains active", async () => {
    const harness = await startedHarness({
      wrapNegativelyAcknowledgeDeliveryClaim: (
        _negativelyAcknowledgeDeliveryClaim,
        _deliveries,
        submissionRecords,
      ) => (request) => {
        submissionRecords.delete(request.runId);
        return "retry-scheduled";
      },
      createExecutor: () => ({
        execute: async () => Promise.reject(new Error("execution failed")),
      }),
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({
      status: "recovery-required",
      reason: "nack-outcome-unknown",
    });
    if (result.status !== "recovery-required") {
      throw new Error("expected recovery");
    }
    expect(harness.deliveries.inspectClaim(result).status).toBe("active");
    expect(harness.submissionRecords.get(result.runId)).toBeUndefined();
  });

  it("rejects a Promise returned after both negative-acknowledgement state changes complete", async () => {
    const harness = await startedHarness({
      wrapDeliveries: readAndClaimDeliveries,
      wrapNegativelyAcknowledgeDeliveryClaim:
        (negativelyAcknowledgeDeliveryClaim) =>
        ((request: Parameters<
          ReactiveModuleRuntimeOptions["negativelyAcknowledgeDeliveryClaim"]
        >[0]) => {
          const status = negativelyAcknowledgeDeliveryClaim(request);
          return Promise.resolve(status);
        }) as unknown as ReactiveModuleRuntimeOptions["negativelyAcknowledgeDeliveryClaim"],
      createExecutor: () => ({
        execute: async () => Promise.reject(new Error("execution failed")),
      }),
    });

    await expect(harness.runtime.tick()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "nack-outcome-unknown",
    });
    const claim = harness.deliveries.snapshot().claims[0];
    expect(claim?.status).toBe("nacked");
    expect(claim && harness.submissionRecords.get(claim.runId)).toBeUndefined();
  });

  it("rejects a Promise-returning process factory before claiming or executing", async () => {
    const execute = vi.fn().mockResolvedValue({ schemaVersion: "dolly.module-result/1" });
    const start = vi.fn().mockResolvedValue(undefined);
    const terminate = vi.fn().mockResolvedValue(undefined);
    const createExecutor = vi.fn(() =>
      Promise.resolve({ isolation: "process" as const, start, execute, terminate }),
    );
    const harness = createHarness({
      simulateProcessIsolation: false,
      createExecutor: createExecutor as unknown as HarnessOptions["createExecutor"],
    });
    const claim = vi.spyOn(harness.deliveries, "claim");

    await expect(harness.runtime.start()).rejects.toMatchObject({ code: "ACTOR_FAILED" });
    await Promise.resolve();
    expect(createExecutor).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    await expect(harness.runtime.stop()).resolves.toBeUndefined();
  });

  it("uses a synchronous process handle without reading a mutable then property twice", async () => {
    let thenReads = 0;
    const executor: ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult> = {
      isolation: "process",
      start: async () => undefined,
      execute: async () => ({
        schemaVersion: "dolly.module-result/1",
        blockProposal: proposal("synchronous process handle"),
      }),
      terminate: async () => undefined,
    };
    Object.defineProperty(executor, "then", {
      configurable: true,
      get: () => {
        thenReads += 1;
        if (thenReads === 1) return undefined;
        throw new Error("process handle then property was read twice");
      },
    });
    const harness = createHarness({
      simulateProcessIsolation: false,
      createExecutor: () => executor,
    });

    await expect(harness.runtime.start()).resolves.toBeUndefined();
    await expect(harness.runtime.tick()).resolves.toMatchObject({ status: "committed" });
    await expect(harness.runtime.stop()).resolves.toBeUndefined();
    expect(thenReads).toBe(1);
  });

  it("rejects an in-process executor before it can claim or execute input", async () => {
    const execute = vi.fn().mockResolvedValue({ schemaVersion: "dolly.module-result/1" });
    const terminate = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({
      simulateProcessIsolation: false,
      createExecutor: () => ({
        isolation: "none",
        execute,
        terminate,
      }),
    });
    const claim = vi.spyOn(harness.deliveries, "claim");

    await expect(harness.runtime.start()).rejects.toMatchObject({ code: "ACTOR_FAILED" });
    expect(execute).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledOnce();
    await harness.runtime.stop();
  });

  it("rejects a process-isolated executor without confirmed termination", async () => {
    const execute = vi.fn().mockResolvedValue({ schemaVersion: "dolly.module-result/1" });
    const stop = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({
      simulateProcessIsolation: false,
      createExecutor: () => ({
        isolation: "process",
        execute,
        stop,
      }),
    });

    await expect(harness.runtime.start()).rejects.toMatchObject({ code: "ACTOR_FAILED" });
    expect(execute).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    await expect(harness.runtime.stop()).rejects.toMatchObject({ code: "STOP_INCOMPLETE" });
  });

  it("does not claim input after executor startup fails", async () => {
    const claim = vi.fn<DeliveryStore["claim"]>();
    const harness = createHarness({
      wrapDeliveries: (deliveries) =>
        new Proxy(deliveries, {
          get(target, property) {
            if (property === "claim") {
              return (request: Parameters<DeliveryStore["claim"]>[0]) => {
                claim(request);
                return target.claim(request);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      createExecutor: () => ({
        start: async () => Promise.reject(new Error("private startup detail")),
        execute: async () => ({ schemaVersion: "dolly.module-result/1" }),
        terminate: vi.fn().mockResolvedValue(undefined),
      }),
    });

    await expect(harness.runtime.start()).rejects.toMatchObject({ code: "ACTOR_FAILED" });
    await expect(harness.runtime.tick()).rejects.toMatchObject({ code: "RUNTIME_FAILED" });
    expect(claim).not.toHaveBeenCalled();
    await harness.runtime.stop();
  });

  it("carries the exact Claim identity through actor execution and recoverable commit", async () => {
    let observedInput: ReactiveModuleInput | undefined;
    let observedRunId: string | undefined;
    const harness = await startedHarness({
      createExecutor: () => ({
        execute: async (input, context) => {
          observedInput = input;
          observedRunId = context.runId;
          return { schemaVersion: "dolly.module-result/1", blockProposal: proposal("output") };
        },
      }),
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({
      status: "committed",
      recovered: false,
      attempt: 1,
      moduleGenerationId: "generation-1",
      record: { state: "committed", blockId: "block-2" },
    });
    if (result.status !== "committed") throw new Error("expected committed result");
    expect(observedRunId).toBe(result.runId);
    expect(observedInput).toMatchObject({
      schemaVersion: "dolly.reactive-module-input/2",
      hasMore: false,
      blockGroups: [{ occurrenceCount: 1, block: { id: "block-1" } }],
    });
    expect(
      harness.deliveries.inspectClaim({
        moduleJobId: result.moduleJobId,
        claimToken: result.claimToken,
        runId: result.runId,
        attempt: result.attempt,
        moduleGenerationId: result.moduleGenerationId,
      }).status,
    ).toBe("committed");
    expect(result.record.source).toEqual({ kind: "module", id: "worker" });
    await expect(harness.runtime.tick()).resolves.toEqual({ status: "idle" });
    await harness.runtime.stop();
  });

  it("commits a no-Block result without targeting configured output Pages", async () => {
    const harness = await startedHarness({
      outputPageIds: ["output"],
      createExecutor: () => ({
        execute: async () => ({
          schemaVersion: "dolly.module-result/1",
        }),
      }),
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({
      status: "committed",
      record: {
        state: "committed",
        outputPageIds: [],
        outputDeliveries: [],
      },
    });
    if (result.status !== "committed") throw new Error("expected committed result");
    expect(result.record.blockId).toBeUndefined();
    expect(harness.deliveries.claim({
      consumerId: "sink",
      pageIds: ["output"],
      moduleGenerationId: "sink-generation-1",
      maxCount: 1,
      maxBytes: 1024,
    })).toBeNull();
    await harness.runtime.stop();
  });

  it("retains observed commit proof when later journal reads fail", async () => {
    for (const successfulRecoveryReads of [0, 1]) {
      const harness = await startedHarness({
        reportDeletedSubmissionAsPresent: true,
        createExecutor: () => ({
          execute: async () => ({
            schemaVersion: "dolly.module-result/1",
            blockProposal: proposal("committed with stale submission reader"),
          }),
        }),
      });

      const result = await harness.runtime.tick();
      expect(result).toMatchObject({
        status: "recovery-required",
        reason: "commit-outcome-unknown",
      });
      if (result.status !== "recovery-required") {
        throw new Error("expected commit recovery");
      }
      expect(harness.repository.get(result.moduleJobId)).toMatchObject({
        state: "committed",
      });
      expect(harness.deliveries.inspectClaim(result).status).toBe("committed");
      expect(harness.submissionRecords.get(result.runId)).toBeUndefined();

      for (let index = 0; index < successfulRecoveryReads; index += 1) {
        await expect(harness.runtime.recover()).resolves.toMatchObject({
          status: "recovery-required",
          reason: "commit-outcome-unknown",
        });
      }
      vi.spyOn(harness.repository, "get").mockReturnValue(null);
      await expect(harness.runtime.recover()).resolves.toMatchObject({
        status: "recovery-required",
        reason: "commit-outcome-unknown",
      });
      expect(harness.negativelyAcknowledgeDeliveryClaim).not.toHaveBeenCalled();
      expect(harness.releaseDeliveryClaim).not.toHaveBeenCalled();
      await expect(harness.runtime.stop()).rejects.toMatchObject({
        code: "RUNTIME_RECOVERY_REQUIRED",
      });
    }
  });

  it("does not trust a matching result journal when its own Delivery store still reports an active Claim", async () => {
    const harness = await startedHarness({
      wrapDeliveries: (deliveries) => {
        let activeDescriptor: ReturnType<DeliveryStore["inspectClaim"]> | undefined;
        return {
          ...readAndClaimDeliveries(deliveries),
          claim: (request) => {
            const claim = deliveries.claim(request);
            if (claim) activeDescriptor = deliveries.inspectClaim(claim);
            return claim;
          },
          inspectClaim: (identity) =>
            activeDescriptor ?? deliveries.inspectClaim(identity),
        };
      },
      createExecutor: () => ({
        execute: async () => ({
          schemaVersion: "dolly.module-result/1",
          blockProposal: proposal("committed in a different Delivery store"),
        }),
      }),
    });

    const uncertain = await harness.runtime.tick();
    expect(uncertain).toMatchObject({
      status: "recovery-required",
      reason: "commit-outcome-unknown",
    });
    if (uncertain.status !== "recovery-required") {
      throw new Error("Expected the runtime Delivery store to prevent commit confirmation");
    }
    expect(harness.repository.get(uncertain.moduleJobId)).toMatchObject({
      state: "committed",
    });
    expect(harness.deliveries.inspectClaim(uncertain).status).toBe("committed");
    expect(harness.runtimeDeliveries.inspectClaim(uncertain).status).toBe("active");

    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "commit-outcome-unknown",
      runId: uncertain.runId,
    });
    await expect(harness.runtime.stop()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
  });

  it("waits for an unconfirmed Claim persistence write before executing its exact first attempt", async () => {
    let persistenceAvailable = false;
    let persistenceWrites = 0;
    const execute = vi.fn(async () => ({
      schemaVersion: "dolly.module-result/1" as const,
      blockProposal: proposal("after Claim persistence confirmation"),
    }));
    const classifyFailure = vi.fn((failure: ReactiveModuleFailure) => ({
      code: failure.code,
      retryable: true,
    }));
    const harness = await startedHarness({
      createExecutor: () => ({ execute }),
      classifyFailure,
    });
    const flushPersistence = vi.spyOn(harness.deliveries, "flushPersistence");
    const inspectClaim = vi.spyOn(harness.deliveries, "inspectClaim");
    harness.deliveries.setMutationObserver(() => {
      persistenceWrites += 1;
      if (!persistenceAvailable) throw new Error("simulated persistence failure");
    });

    const unconfirmed = await harness.runtime.tick();
    expect(unconfirmed).toMatchObject({
      status: "recovery-required",
      reason: "claim-persistence-unconfirmed",
      attempt: 1,
      moduleGenerationId: "generation-1",
    });
    if (unconfirmed.status !== "recovery-required") {
      throw new Error("Expected Claim persistence recovery to be required");
    }
    expect(execute).not.toHaveBeenCalled();
    expect(classifyFailure).not.toHaveBeenCalled();
    expect(persistenceWrites).toBe(1);
    await expect(harness.runtime.tick()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });

    flushPersistence.mockClear();
    inspectClaim.mockClear();

    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "claim-persistence-unconfirmed",
      claimToken: unconfirmed.claimToken,
      runId: unconfirmed.runId,
      attempt: 1,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(classifyFailure).not.toHaveBeenCalled();
    expect(persistenceWrites).toBe(2);
    expect(flushPersistence).toHaveBeenCalledOnce();
    expect(inspectClaim).not.toHaveBeenCalled();

    flushPersistence.mockClear();
    inspectClaim.mockClear();

    persistenceAvailable = true;
    const recovered = await harness.runtime.recover();
    expect(recovered).toMatchObject({
      status: "committed",
      recovered: false,
      moduleJobId: unconfirmed.moduleJobId,
      claimToken: unconfirmed.claimToken,
      runId: unconfirmed.runId,
      attempt: 1,
    });
    expect(persistenceWrites).toBeGreaterThanOrEqual(3);
    expect(flushPersistence).toHaveBeenCalled();
    // Result submission performs further Claim checks. The first check must
    // nevertheless happen only after the pending persistence write succeeds.
    expect(inspectClaim).toHaveBeenCalled();
    const firstFlushOrder = flushPersistence.mock.invocationCallOrder[0];
    const inspectOrder = inspectClaim.mock.invocationCallOrder[0];
    if (firstFlushOrder === undefined || inspectOrder === undefined) {
      throw new Error("Expected persistence flush and Claim inspection calls");
    }
    expect(firstFlushOrder).toBeLessThan(inspectOrder);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        moduleJobId: unconfirmed.moduleJobId,
        runId: unconfirmed.runId,
        attempt: 1,
        moduleGenerationId: unconfirmed.moduleGenerationId,
      }),
    );
    expect(classifyFailure).not.toHaveBeenCalled();
    await harness.runtime.stop();
  });

  it("does not send a Run when Claim persistence recovers without an exact submission record", async () => {
    let persistenceAvailable = false;
    const execute = vi.fn(async () => ({
      schemaVersion: "dolly.module-result/1" as const,
    }));
    const harness = await startedHarness({
      wrapPersistModuleSubmission: () => () => undefined,
      createExecutor: () => ({ execute }),
    });
    harness.deliveries.setMutationObserver(() => {
      if (!persistenceAvailable) throw new Error("simulated persistence failure");
    });

    const claimUnconfirmed = await harness.runtime.tick();
    expect(claimUnconfirmed).toMatchObject({
      status: "recovery-required",
      reason: "claim-persistence-unconfirmed",
    });
    if (claimUnconfirmed.status !== "recovery-required") {
      throw new Error("expected Claim persistence recovery");
    }
    expect(execute).not.toHaveBeenCalled();

    persistenceAvailable = true;
    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "submission-persistence-unconfirmed",
      runId: claimUnconfirmed.runId,
      attempt: claimUnconfirmed.attempt,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(harness.submissionRecords.get(claimUnconfirmed.runId)).toBeUndefined();
    expect(harness.deliveries.inspectClaim(claimUnconfirmed).status).toBe("active");
  });

  it("does not send a Run when the persisted submission has the wrong input digest", async () => {
    const execute = vi.fn(async () => ({
      schemaVersion: "dolly.module-result/1" as const,
    }));
    const harness = await startedHarness({
      wrapPersistModuleSubmission:
        (persistModuleSubmission, submissionRecords) => (request) => {
          persistModuleSubmission(request);
          const submission = submissionRecords.get(request.runId);
          if (!submission) throw new Error("expected submission");
          submissionRecords.set(request.runId, {
            ...submission,
            inputDigest: `sha256:${"f".repeat(64)}`,
          });
        },
      createExecutor: () => ({ execute }),
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({
      status: "recovery-required",
      reason: "submission-persistence-unconfirmed",
    });
    expect(execute).not.toHaveBeenCalled();
    if (result.status !== "recovery-required") {
      throw new Error("expected submission persistence recovery");
    }
    expect(harness.deliveries.inspectClaim(result).status).toBe("active");
  });

  it("does not treat another persisted active Claim as an unconfirmed Claim", async () => {
    const execute = vi.fn(async () => ({ schemaVersion: "dolly.module-result/1" as const }));
    const harness = await startedHarness({ createExecutor: () => ({ execute }) });
    let persistenceWrites = 0;
    harness.deliveries.setMutationObserver(() => {
      persistenceWrites += 1;
    });
    const existing = harness.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-1",
      maxCount: 10,
      maxBytes: 1024 * 1024,
      maxInputBytes: 2 * 1024 * 1024,
    });
    expect(existing).not.toBeNull();
    expect(persistenceWrites).toBe(1);

    await expect(harness.runtime.tick()).rejects.toMatchObject({
      code: "RUNTIME_CLAIM_FAILED",
    });
    expect(execute).not.toHaveBeenCalled();
    await harness.runtime.stop();
  });

  it("nacks an uncommitted execution failure and retries the same Module job with a new run", async () => {
    const contexts: Array<{ moduleJobId: string; runId: string; attempt: number }> = [];
    let executions = 0;
    const classify = vi.fn((failure: ReactiveModuleFailure) => ({
      code: failure.code,
      retryable: true,
    }));
    const harness = await startedHarness({
      classifyFailure: classify,
      createExecutor: () => ({
        execute: async (_input, context) => {
          contexts.push(context);
          executions += 1;
          if (executions === 1) throw new Error("private extension failure");
          return { schemaVersion: "dolly.module-result/1", blockProposal: proposal("retry") };
        },
      }),
    });

    const first = await harness.runtime.tick();
    expect(first).toMatchObject({
      status: "retry-scheduled",
      attempt: 1,
      failure: { code: "MODULE_EXECUTION_FAILED", retryable: true },
    });
    const second = await harness.runtime.tick();
    expect(second).toMatchObject({ status: "committed", attempt: 2 });
    if (first.status === "idle" || second.status !== "committed") {
      throw new Error("unexpected tick result");
    }
    expect(second.moduleJobId).toBe(first.moduleJobId);
    expect(second.runId).not.toBe(first.runId);
    expect(contexts).toEqual([
      expect.objectContaining({ moduleJobId: first.moduleJobId, runId: first.runId, attempt: 1 }),
      expect.objectContaining({ moduleJobId: first.moduleJobId, runId: second.runId, attempt: 2 }),
    ]);
    expect(classify).toHaveBeenCalledWith({
      stage: "module-execution",
      code: "MODULE_EXECUTION_FAILED",
    });
    await harness.runtime.stop();
  });

  it("preserves a soft timeout until persistent evidence permits negative acknowledgement", async () => {
    const executionStarted = deferred<void>();
    const execution = deferred<ReactiveModuleResult>();
    let evidence: ExternalEffectEvidence = {
      kind: "unknown",
      reason: "provider outcome is not available",
    };
    const inspectRunEffects = vi.fn(async () => evidence);
    const harness = await startedHarness({
      declaredExternalEffects: "core-capabilities-only",
      externalEffectEvidence: { inspectRunEffects },
      createExecutor: () => ({
        execute: async () => {
          executionStarted.resolve();
          return execution.promise;
        },
        cancel: () => execution.reject(new Error("cancelled after timeout")),
      }),
    });

    const tick = harness.runtime.tick();
    await executionStarted.promise;
    const activeRun = harness.runtime.activeRun;
    if (!activeRun) throw new Error("expected an active Run");
    expect(harness.runtime.softTimeout(activeRun.runId)).toBe(
      "cancellation-requested",
    );
    await expect(tick).resolves.toMatchObject({
      status: "recovery-required",
      reason: "external-effect-outcome-unknown",
    });
    expect(harness.negativelyAcknowledgeDeliveryClaim).not.toHaveBeenCalled();

    evidence = { kind: "no-effect" };
    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "retry-scheduled",
      failure: { code: "MODULE_TIMED_OUT", retryable: true },
    });
    expect(inspectRunEffects).toHaveBeenCalledTimes(2);
    await harness.runtime.stop();
  });

  it("automatically cancels and then fences an execution that exceeds both time limits", async () => {
    vi.useFakeTimers();
    try {
      const executionStarted = deferred<void>();
      const neverCompletes = deferred<ReactiveModuleResult>();
      const cancel = vi.fn();
      const terminate = vi.fn().mockResolvedValue(undefined);
      const harness = await startedHarness({
        executionTimeoutMs: 100,
        cancellationGraceMs: 50,
        createExecutor: () => ({
          execute: async () => {
            executionStarted.resolve();
            return neverCompletes.promise;
          },
          cancel,
          terminate,
        }),
      });

      const tick = harness.runtime.tick();
      await executionStarted.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect(cancel).toHaveBeenCalledOnce();
      expect(terminate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(50);
      await expect(tick).resolves.toMatchObject({
        status: "retry-scheduled",
        failure: { code: "MODULE_GENERATION_FENCED", retryable: true },
      });
      expect(terminate).toHaveBeenCalledOnce();
      await harness.runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the Claim when automatic hard termination cannot be confirmed", async () => {
    vi.useFakeTimers();
    try {
      const executionStarted = deferred<void>();
      const neverCompletes = deferred<ReactiveModuleResult>();
      const termination = deferred<void>();
      const classifyFailure = vi.fn((failure: ReactiveModuleFailure) => ({
        code: failure.code,
        retryable: true,
      }));
      const stop = vi.fn().mockResolvedValue(undefined);
      let executorCreations = 0;
      const harness = await startedHarness({
        executionTimeoutMs: 100,
        cancellationGraceMs: 50,
        terminationTimeoutMs: 25,
        classifyFailure,
        createExecutor: () => {
          executorCreations += 1;
          return {
            execute: async () => {
              executionStarted.resolve();
              return neverCompletes.promise;
            },
            terminate: vi.fn(async () => termination.promise),
            stop,
          };
        },
      });
      const nack = vi.spyOn(harness.deliveries, "nack");

      const tick = harness.runtime.tick();
      await executionStarted.promise;
      await vi.advanceTimersByTimeAsync(150);
      await vi.advanceTimersByTimeAsync(25);
      const result = await tick;

      expect(result).toMatchObject({
        status: "recovery-required",
        reason: "executor-termination-unconfirmed",
        attempt: 1,
        moduleGenerationId: "generation-1",
      });
      if (result.status !== "recovery-required") {
        throw new Error("Expected executor termination recovery to be required");
      }
      expect(harness.runtime.state).toBe("failed");
      expect(executorCreations).toBe(1);
      expect(classifyFailure).not.toHaveBeenCalled();
      expect(nack).not.toHaveBeenCalled();
      expect(
        harness.deliveries.inspectClaim({
          moduleJobId: result.moduleJobId,
          claimToken: result.claimToken,
          runId: result.runId,
          attempt: result.attempt,
          moduleGenerationId: result.moduleGenerationId,
        }).status,
      ).toBe("active");
      await expect(harness.runtime.recover()).resolves.toMatchObject({
        status: "recovery-required",
        reason: "executor-termination-unconfirmed",
        claimToken: result.claimToken,
        runId: result.runId,
      });
      termination.reject(new Error("late termination failure"));
      await Promise.resolve();
      expect(harness.runtime.state).toBe("failed");
      expect(executorCreations).toBe(1);
      await expect(harness.runtime.stop()).rejects.toMatchObject({
        code: "RUNTIME_RECOVERY_REQUIRED",
      });
      expect(stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the Claim when replacement startup cleanup is not confirmed", async () => {
    const oldExecution = deferred<ReactiveModuleResult>();
    const oldExecutionStarted = deferred<void>();
    const replacementStop = vi.fn().mockResolvedValue(undefined);
    const classifyFailure = vi.fn((failure: ReactiveModuleFailure) => ({
      code: failure.code,
      retryable: true,
    }));
    let executorCreations = 0;
    const harness = await startedHarness({
      declaredExternalEffects: "none",
      externalEffectEvidence: null,
      classifyFailure,
      createExecutor: () => {
        executorCreations += 1;
        if (executorCreations === 1) {
          return {
            execute: async () => {
              oldExecutionStarted.resolve();
              return oldExecution.promise;
            },
            terminate: vi.fn().mockResolvedValue(undefined),
          };
        }
        return {
          start: async () => Promise.reject(new Error("replacement startup failed")),
          execute: async () => ({ schemaVersion: "dolly.module-result/1" as const }),
          terminate: vi.fn().mockRejectedValue(new Error("replacement termination failed")),
          stop: replacementStop,
        };
      },
    });
    const nack = vi.spyOn(harness.deliveries, "nack");

    const tick = harness.runtime.tick();
    await oldExecutionStarted.promise;
    const activeRun = harness.runtime.activeRun;
    if (!activeRun) throw new Error("Expected an active Module run");

    await expect(harness.runtime.hardTimeout(activeRun.runId)).rejects.toMatchObject({
      code: "ACTOR_FAILED",
    });
    const result = await tick;
    expect(result).toMatchObject({
      status: "recovery-required",
      reason: "executor-termination-unconfirmed",
      runId: activeRun.runId,
    });
    if (result.status !== "recovery-required") {
      throw new Error("Expected replacement cleanup recovery to be required");
    }
    expect(executorCreations).toBe(2);
    expect(replacementStop).not.toHaveBeenCalled();
    expect(classifyFailure).not.toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();
    expect(
      harness.deliveries.inspectClaim({
        moduleJobId: result.moduleJobId,
        claimToken: result.claimToken,
        runId: result.runId,
        attempt: result.attempt,
        moduleGenerationId: result.moduleGenerationId,
      }).status,
    ).toBe("active");

    await expect(harness.runtime.stop()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
    expect(executorCreations).toBe(2);
    oldExecution.resolve({ schemaVersion: "dolly.module-result/1" });
    await Promise.resolve();
  });

  it("nacks a proven hard fence and reclaims only under the replacement generation", async () => {
    const oldResult = deferred<ReactiveModuleResult>();
    const oldStarted = deferred<void>();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const inspectRunEffects = vi.fn(
      async (): Promise<ExternalEffectEvidence> => ({ kind: "retry-safe" }),
    );
    let generations = 0;
    const harness = await startedHarness({
      declaredExternalEffects: "core-capabilities-only",
      externalEffectEvidence: { inspectRunEffects },
      createExecutor: () => {
        generations += 1;
        return generations === 1
          ? {
              execute: async () => {
                oldStarted.resolve();
                return oldResult.promise;
              },
              terminate,
            }
          : {
              execute: async () => ({
                schemaVersion: "dolly.module-result/1",
                blockProposal: proposal("replacement"),
              }),
              terminate: vi.fn().mockResolvedValue(undefined),
            };
      },
    });

    const firstTick = harness.runtime.tick();
    await oldStarted.promise;
    const oldRun = harness.runtime.activeRun!;
    await expect(harness.runtime.tick()).rejects.toMatchObject({ code: "RUNTIME_BUSY" });
    await expect(harness.runtime.hardTimeout(oldRun.runId)).resolves.toBe("module-generation-fenced");
    const first = await firstTick;
    expect(first).toMatchObject({ status: "retry-scheduled", failure: { retryable: true } });
    expect(terminate).toHaveBeenCalledOnce();
    expect(inspectRunEffects).toHaveBeenCalledOnce();
    expect(harness.runtime.moduleGenerationId).not.toBe(oldRun.moduleGenerationId);

    const second = await harness.runtime.tick();
    expect(second).toMatchObject({
      status: "committed",
      attempt: 2,
      moduleGenerationId: harness.runtime.moduleGenerationId,
    });
    if (first.status === "idle" || second.status !== "committed") {
      throw new Error("unexpected tick result");
    }
    expect(second.moduleJobId).toBe(first.moduleJobId);
    expect(second.runId).not.toBe(first.runId);
    oldResult.resolve({ schemaVersion: "dolly.module-result/1" });
    await Promise.resolve();
    await harness.runtime.stop();
  });

  it("recovers a commit interruption without executing the Module twice", async () => {
    let injected = false;
    const execute = vi.fn().mockResolvedValue({
      schemaVersion: "dolly.module-result/1",
      blockProposal: proposal("recover once"),
    });
    const harness = await startedHarness({
      createExecutor: () => ({ execute }),
      afterEffect: (event) => {
        if (!injected && event.phase === "after-delivery-effect") {
          injected = true;
          throw new Error("simulated interruption");
        }
      },
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({ status: "committed", recovered: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(harness.blocks.size).toBe(2);
    if (result.status !== "committed") throw new Error("expected recovered commit");
    expect(result.record.outputDeliveries).toHaveLength(1);
    await harness.runtime.stop();
  });

  it("does not let a hook impersonate coordinator output backpressure", async () => {
    let capacityAvailable = false;
    const execute = vi.fn().mockResolvedValue({
      schemaVersion: "dolly.module-result/1",
      blockProposal: proposal("wait for capacity"),
    });
    const harness = await startedHarness({
      createExecutor: () => ({ execute }),
      afterEffect: (event) => {
        if (!capacityAvailable && event.phase === "after-block-effect") {
          throw new ModuleResultCommitBackpressureError(["sink"]);
        }
      },
    });

    const waiting = await harness.runtime.tick();
    expect(waiting).toMatchObject({
      status: "recovery-required",
      reason: "commit-outcome-unknown",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(harness.submissionRecords.size).toBe(1);
    expect(harness.deliveries.listActiveClaims()).toHaveLength(1);

    capacityAvailable = true;
    const committed = await harness.runtime.recover();
    expect(committed).toMatchObject({ status: "committed", recovered: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(harness.submissionRecords.size).toBe(0);
    expect(harness.deliveries.listActiveClaims()).toEqual([]);
    await harness.runtime.stop();
  });

  it("keeps the exact Claim durable when shutdown meets a backpressure-lookalike hook error", async () => {
    const execute = vi.fn().mockResolvedValue({
      schemaVersion: "dolly.module-result/1",
      blockProposal: proposal("preserve on shutdown"),
    });
    const harness = await startedHarness({
      createExecutor: () => ({ execute }),
      afterEffect: (event) => {
        if (event.phase === "after-block-effect") {
          throw new ModuleResultCommitBackpressureError(["sink"]);
        }
      },
    });

    const waiting = await harness.runtime.tick();
    expect(waiting).toMatchObject({
      status: "recovery-required",
      reason: "commit-outcome-unknown",
    });
    await expect(harness.runtime.stop()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(harness.submissionRecords.size).toBe(1);
    expect(harness.deliveries.listActiveClaims()).toEqual([
      expect.objectContaining({
        moduleJobId: waiting.status === "recovery-required" ? waiting.moduleJobId : "invalid",
        status: "active",
      }),
    ]);
  });

  it("blocks new work until a repeatedly interrupted prepared commit is recovered", async () => {
    let remainingInterruptions = 2;
    const execute = vi.fn().mockResolvedValue({
      schemaVersion: "dolly.module-result/1",
      blockProposal: proposal("recover later"),
    });
    const harness = await startedHarness({
      createExecutor: () => ({ execute }),
      afterEffect: (event) => {
        if (event.phase === "after-block-effect" && remainingInterruptions > 0) {
          remainingInterruptions -= 1;
          throw new Error("repository unavailable");
        }
      },
    });

    const uncertain = await harness.runtime.tick();
    expect(uncertain).toMatchObject({
      status: "recovery-required",
      reason: "commit-outcome-unknown",
    });
    await expect(harness.runtime.tick()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
    expect(execute).toHaveBeenCalledOnce();

    const recovered = await harness.runtime.recover();
    expect(recovered).toMatchObject({ status: "committed", recovered: true });
    expect(execute).toHaveBeenCalledOnce();
    await expect(harness.runtime.recover()).resolves.toEqual({ status: "nothing-to-recover" });
    await expect(harness.runtime.tick()).resolves.toEqual({ status: "idle" });
    await harness.runtime.stop();
  });

  it("nacks a result rejected before durable prepare when the Module declares no external effect", async () => {
    const classify = vi.fn((failure: ReactiveModuleFailure) => ({
      code: failure.code,
      retryable: false,
    }));
    const invalidResult = {
      schemaVersion: "dolly.module-result/1",
      blockProposal: {
        payload: { schema: "invalid schema", value: null },
      },
    } as unknown as ReactiveModuleResult;
    const harness = await startedHarness({
      declaredExternalEffects: "none",
      classifyFailure: classify,
      createExecutor: () => ({ execute: async () => invalidResult }),
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({
      status: "dead-lettered",
      failure: { code: "RESULT_REJECTED_BEFORE_PREPARE", retryable: false },
    });
    expect(classify).toHaveBeenCalledWith({
      stage: "result-rejected-before-prepare",
      code: "RESULT_REJECTED_BEFORE_PREPARE",
    });
    if (result.status === "idle") throw new Error("expected terminal result");
    expect(harness.repository.get(result.moduleJobId)).toBeNull();
    expect(harness.blocks.size).toBe(1);
    await harness.runtime.stop();
  });

  it("preserves an ordinary execution failure when no external-effect evidence source exists", async () => {
    const classify = vi.fn((failure: ReactiveModuleFailure) => ({
      code: failure.code,
      retryable: true,
    }));
    const harness = await startedHarness({
      declaredExternalEffects: "core-capabilities-only",
      externalEffectEvidence: null,
      classifyFailure: classify,
      createExecutor: () => ({
        execute: async () => Promise.reject(new Error("execution failed")),
      }),
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({
      status: "recovery-required",
      reason: "external-effect-outcome-unknown",
    });
    if (result.status !== "recovery-required") throw new Error("expected recovery");
    expect(classify).not.toHaveBeenCalled();
    expect(harness.negativelyAcknowledgeDeliveryClaim).not.toHaveBeenCalled();
    expect(harness.deliveries.inspectClaim(result).status).toBe("active");
    expect(harness.submissionRecords.get(result.runId)).toBeDefined();
    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "external-effect-outcome-unknown",
    });
    await expect(harness.runtime.stop()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
  });

  it("defaults to an unrestricted process boundary and ignores an empty capability-only journal", async () => {
    const inspectRunEffects = vi.fn(
      async (): Promise<ExternalEffectEvidence> => ({ kind: "no-effect" }),
    );
    const harness = await startedHarness({
      declaredExternalEffects: null,
      externalEffectEvidence: { inspectRunEffects },
      createExecutor: () => ({
        execute: async () => Promise.reject(new Error("ambient effect may have occurred")),
      }),
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({
      status: "recovery-required",
      reason: "external-effect-outcome-unknown",
    });
    expect(inspectRunEffects).not.toHaveBeenCalled();
    expect(harness.negativelyAcknowledgeDeliveryClaim).not.toHaveBeenCalled();
    if (result.status !== "recovery-required") throw new Error("expected recovery");
    expect(harness.deliveries.inspectClaim(result).status).toBe("active");
    expect(harness.submissionRecords.get(result.runId)).toBeDefined();
    await expect(harness.runtime.stop()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
  });

  it.each(["no-effect", "retry-safe"] as const)(
    "negatively acknowledges an execution failure with persistent %s evidence",
    async (kind) => {
      const inspectRunEffects = vi.fn(
        async (): Promise<ExternalEffectEvidence> => ({ kind }),
      );
      const harness = await startedHarness({
        declaredExternalEffects: "core-capabilities-only",
        externalEffectEvidence: { inspectRunEffects },
        createExecutor: () => ({
          execute: async () => Promise.reject(new Error("execution failed")),
        }),
      });

      const result = await harness.runtime.tick();
      expect(result).toMatchObject({
        status: "retry-scheduled",
        failure: { code: "MODULE_EXECUTION_FAILED", retryable: true },
      });
      if (result.status === "idle") throw new Error("expected a claimed Run");
      expect(inspectRunEffects).toHaveBeenCalledWith(
        expect.objectContaining({
          moduleJobId: result.moduleJobId,
          claimToken: result.claimToken,
          runId: result.runId,
          attempt: result.attempt,
          moduleGenerationId: result.moduleGenerationId,
        }),
      );
      expect(harness.submissionRecords.get(result.runId)).toBeUndefined();
      await harness.runtime.stop();
    },
  );

  it("preserves an execution failure with terminal evidence because it does not prove retry safety", async () => {
    const inspectRunEffects = vi.fn(
      async (): Promise<ExternalEffectEvidence> => ({ kind: "terminal" }),
    );
    const harness = await startedHarness({
      declaredExternalEffects: "core-capabilities-only",
      externalEffectEvidence: { inspectRunEffects },
      createExecutor: () => ({
        execute: async () => Promise.reject(new Error("execution failed")),
      }),
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({
      status: "recovery-required",
      reason: "external-effect-retry-safety-unproven",
    });
    if (result.status !== "recovery-required") throw new Error("expected recovery");
    expect(harness.negativelyAcknowledgeDeliveryClaim).not.toHaveBeenCalled();
    expect(harness.deliveries.inspectClaim(result).status).toBe("active");
    expect(harness.submissionRecords.get(result.runId)).toBeDefined();
    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "external-effect-retry-safety-unproven",
    });
    expect(inspectRunEffects).toHaveBeenCalledTimes(2);
    await expect(harness.runtime.stop()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
  });

  it("rechecks persistent external-effect evidence before recovering a failure", async () => {
    let evidenceResult: unknown = { kind: "no-effect" };
    let evidenceError: Error | undefined;
    const inspectRunEffects = vi.fn(
      () => {
        if (evidenceError) throw evidenceError;
        return evidenceResult;
      },
    ) as unknown as ExternalEffectEvidenceSource["inspectRunEffects"];
    const harness = await startedHarness({
      declaredExternalEffects: "core-capabilities-only",
      externalEffectEvidence: { inspectRunEffects },
      createExecutor: () => ({
        execute: async () => Promise.reject(new Error("execution failed")),
      }),
    });

    await expect(harness.runtime.tick()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "external-effect-outcome-unknown",
    });

    evidenceError = new Error("evidence source failed synchronously");
    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "external-effect-outcome-unknown",
    });
    evidenceError = undefined;

    evidenceResult = Promise.resolve({
      kind: "unknown",
      reason: "provider outcome is not available",
    });
    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "external-effect-outcome-unknown",
    });

    evidenceResult = Promise.resolve({ kind: "no-effect", extra: true });
    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "external-effect-outcome-unknown",
    });

    evidenceResult = Promise.reject(new Error("evidence store unavailable"));
    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "external-effect-outcome-unknown",
    });

    evidenceResult = Promise.resolve({ kind: "no-effect" });
    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "retry-scheduled",
      failure: { code: "MODULE_EXECUTION_FAILED", retryable: true },
    });
    expect(inspectRunEffects).toHaveBeenCalledTimes(6);
    expect(harness.negativelyAcknowledgeDeliveryClaim).toHaveBeenCalledOnce();
    await harness.runtime.stop();
  });

  it("preserves the Claim when a Module that may cause external effects has no committed result", async () => {
    // The Module executed and could have reached a provider through a
    // capability, so a missing journal record is an unknown outcome rather
    // than a proved failure. Architecture Decision Record 0009 forbids
    // classifying, negatively acknowledging, or retrying such a Run.
    const classify = vi.fn((failure: ReactiveModuleFailure) => ({
      code: failure.code,
      retryable: false,
    }));
    const invalidResult = {
      schemaVersion: "dolly.module-result/1",
      blockProposal: {
        payload: { schema: "invalid schema", value: null },
      },
    } as unknown as ReactiveModuleResult;
    const harness = await startedHarness({
      declaredExternalEffects: "core-capabilities-only",
      externalEffectEvidence: null,
      classifyFailure: classify,
      createExecutor: () => ({ execute: async () => invalidResult }),
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({ status: "recovery-required" });
    expect(classify).not.toHaveBeenCalled();
    if (result.status === "idle") throw new Error("expected terminal result");
    expect(harness.repository.get(result.moduleJobId)).toBeNull();
    // The exact Claim stays active for audited operator action.
    expect(harness.deliveries.listActiveClaims()).toEqual([
      expect.objectContaining({ moduleJobId: result.moduleJobId, status: "active" }),
    ]);
    await expect(harness.runtime.stop()).rejects.toThrowError(
      expect.objectContaining({ code: "RUNTIME_RECOVERY_REQUIRED" }),
    );
  });

  it("defaults to preserving the Claim when no external-effect declaration is configured", async () => {
    const invalidResult = {
      schemaVersion: "dolly.module-result/1",
      blockProposal: {
        payload: { schema: "invalid schema", value: null },
      },
    } as unknown as ReactiveModuleResult;
    const harness = await startedHarness({
      externalEffectEvidence: null,
      createExecutor: () => ({ execute: async () => invalidResult }),
    });

    await expect(harness.runtime.tick()).resolves.toMatchObject({
      status: "recovery-required",
    });
    expect(harness.deliveries.listActiveClaims()).toHaveLength(1);
    await expect(harness.runtime.stop()).rejects.toThrowError(
      expect.objectContaining({ code: "RUNTIME_RECOVERY_REQUIRED" }),
    );
  });

  it("rejects an oversized result before preparing or committing output", async () => {
    const classify = vi.fn((failure: ReactiveModuleFailure) => ({
      code: failure.code,
      retryable: false,
    }));
    const harness = await startedHarness({
      maxResultBytes: 256,
      classifyFailure: classify,
      createExecutor: () => ({
        execute: async () => ({
          schemaVersion: "dolly.module-result/1",
          blockProposal: proposal("x".repeat(2_048)),
        }),
      }),
    });

    const result = await harness.runtime.tick();
    expect(result).toMatchObject({
      status: "dead-lettered",
      failure: { code: "OUTPUT_SNAPSHOT_FAILED", retryable: false },
    });
    expect(classify).toHaveBeenCalledWith({
      stage: "output-snapshot",
      code: "OUTPUT_SNAPSHOT_FAILED",
    });
    if (result.status === "idle") throw new Error("expected terminal result");
    expect(harness.repository.get(result.moduleJobId)).toBeNull();
    expect(harness.blocks.size).toBe(1);
    await harness.runtime.stop();
  });

  it("reconciles a lost nack response through the exact claim disposition", async () => {
    let loseResponse = true;
    let executions = 0;
    const harness = await startedHarness({
      wrapNegativelyAcknowledgeDeliveryClaim:
        (negativelyAcknowledgeDeliveryClaim) => (request) => {
          const result = negativelyAcknowledgeDeliveryClaim(request);
          if (loseResponse) {
            loseResponse = false;
            throw new Error("lost response");
          }
          return result;
        },
      createExecutor: () => ({
        execute: async () => {
          executions += 1;
          if (executions === 1) throw new Error("retry me");
          return { schemaVersion: "dolly.module-result/1", blockProposal: proposal("after nack") };
        },
      }),
    });
    const inspectClaim = vi.spyOn(harness.runtimeDeliveries, "inspectClaim");

    const first = await harness.runtime.tick();
    expect(first).toMatchObject({ status: "retry-scheduled" });
    if (first.status === "idle") throw new Error("expected a claimed Module job");
    expect(inspectClaim).toHaveBeenCalledWith({
      moduleJobId: first.moduleJobId,
      claimToken: first.claimToken,
      runId: first.runId,
      attempt: first.attempt,
      moduleGenerationId: first.moduleGenerationId,
    });
    expect(harness.submissionRecords.get(first.runId)).toBeUndefined();
    await expect(harness.runtime.tick()).resolves.toMatchObject({ status: "committed", attempt: 2 });
    expect(executions).toBe(2);
    await harness.runtime.stop();
  });

  it("blocks on unavailable failure policy and resumes only after explicit recovery", async () => {
    let policyAvailable = false;
    const harness = await startedHarness({
      classifyFailure: (failure) => {
        if (!policyAvailable) throw new Error("policy unavailable");
        return { code: failure.code, retryable: true };
      },
      createExecutor: () => ({ execute: async () => Promise.reject(new Error("failure")) }),
    });

    await expect(harness.runtime.tick()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "failure-policy-unavailable",
    });
    await expect(harness.runtime.tick()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
    policyAvailable = true;
    await expect(harness.runtime.recover()).resolves.toMatchObject({
      status: "retry-scheduled",
      failure: { retryable: true },
    });
    await harness.runtime.stop();
  });

  it("validates routes before creating an executor and permits a zero-output sink", async () => {
    const createExecutor = vi.fn(() => ({
      execute: async () => ({ schemaVersion: "dolly.module-result/1" as const }),
    }));
    expect(() => createHarness({ createExecutor, outputPageIds: ["missing-page"] })).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CONFIGURATION_INVALID" }),
    );
    expect(createExecutor).not.toHaveBeenCalled();

    const sink = createHarness({ createExecutor, outputPageIds: [] });
    expect(createExecutor).not.toHaveBeenCalled();
    await expect(sink.runtime.tick()).rejects.toMatchObject({ code: "RUNTIME_NOT_STARTED" });
    await sink.runtime.start();
    const sinkResult = await sink.runtime.tick();
    expect(sinkResult).toMatchObject({ status: "committed", record: { outputDeliveries: [] } });
    if (sinkResult.status !== "committed") throw new Error("expected committed sink result");
    expect("blockId" in sinkResult.record).toBe(false);
    expect(sink.blocks.size).toBe(1);
    await sink.runtime.stop();
  });

  it("releases a Claim after cooperative shutdown without recording a failed attempt", async () => {
    const executionStarted = deferred<void>();
    const execution = deferred<ReactiveModuleResult>();
    const cancel = vi.fn(() => execution.reject(new Error("shutdown")));
    const terminate = vi.fn().mockResolvedValue(undefined);
    const classifyFailure = vi.fn((failure: ReactiveModuleFailure) => ({
      code: failure.code,
      retryable: true,
    }));
    const harness = await startedHarness({
      declaredExternalEffects: "none",
      externalEffectEvidence: null,
      classifyFailure,
      createExecutor: () => ({
        execute: async () => {
          executionStarted.resolve();
          return execution.promise;
        },
        cancel,
        terminate,
      }),
    });
    const nack = vi.spyOn(harness.deliveries, "nack");
    const releaseClaim = vi.spyOn(harness.deliveries, "releaseClaim");

    const tick = harness.runtime.tick();
    await executionStarted.promise;
    const stop = harness.runtime.stop();
    const result = await tick;

    expect(result).toMatchObject({ status: "cancelled", reason: "shutdown", attempt: 1 });
    if (result.status !== "cancelled") throw new Error("Expected shutdown cancellation");
    await expect(stop).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ runId: result.runId, reason: "shutdown" }),
    );
    expect(terminate).toHaveBeenCalledOnce();
    expect(classifyFailure).not.toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledOnce();
    expect(harness.deliveries.inspectClaim(result).status).toBe("released");

    const next = harness.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-2",
      maxCount: 10,
      maxBytes: 1024 * 1024,
      maxInputBytes: 2 * 1024 * 1024,
    });
    expect(next).toMatchObject({ moduleJobId: result.moduleJobId, attempt: 2 });
    expect(
      harness.deliveries.snapshot().moduleJobs.find(
        (moduleJob) => moduleJob.moduleJobId === result.moduleJobId,
      )?.failedAttemptCount,
    ).toBe(0);
  });

  it("preserves a shutdown-cancelled Claim until persistent evidence permits release", async () => {
    const executionStarted = deferred<void>();
    const execution = deferred<ReactiveModuleResult>();
    let evidence: ExternalEffectEvidence = {
      kind: "unknown",
      reason: "provider outcome is not available",
    };
    const inspectRunEffects = vi.fn(async () => evidence);
    const harness = await startedHarness({
      declaredExternalEffects: "core-capabilities-only",
      externalEffectEvidence: { inspectRunEffects },
      createExecutor: () => ({
        execute: async () => {
          executionStarted.resolve();
          return execution.promise;
        },
        cancel: () => execution.reject(new Error("shutdown")),
      }),
    });

    const tick = harness.runtime.tick();
    await executionStarted.promise;
    const stop = harness.runtime.stop();
    const result = await tick;
    expect(result).toMatchObject({ status: "cancelled", reason: "shutdown" });
    if (result.status !== "cancelled") throw new Error("expected cancellation");
    await expect(stop).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
    expect(harness.releaseDeliveryClaim).not.toHaveBeenCalled();
    expect(harness.deliveries.inspectClaim(result).status).toBe("active");
    expect(harness.submissionRecords.get(result.runId)).toBeDefined();

    evidence = { kind: "terminal" };
    await expect(harness.runtime.stop()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
    expect(harness.releaseDeliveryClaim).not.toHaveBeenCalled();
    expect(harness.deliveries.inspectClaim(result).status).toBe("active");
    expect(harness.submissionRecords.get(result.runId)).toBeDefined();

    evidence = { kind: "retry-safe" };
    await expect(harness.runtime.stop()).resolves.toBeUndefined();
    expect(inspectRunEffects).toHaveBeenCalledTimes(3);
    expect(harness.releaseDeliveryClaim).toHaveBeenCalledOnce();
    expect(harness.deliveries.inspectClaim(result).status).toBe("released");
    expect(harness.submissionRecords.get(result.runId)).toBeUndefined();
  });

  it("does not start timeout failure handling after shutdown begins", async () => {
    vi.useFakeTimers();
    try {
      const executionStarted = deferred<void>();
      const execution = deferred<ReactiveModuleResult>();
      const cancel = vi.fn();
      const terminate = vi.fn().mockResolvedValue(undefined);
      const classifyFailure = vi.fn((failure: ReactiveModuleFailure) => ({
        code: failure.code,
        retryable: true,
      }));
      const harness = await startedHarness({
        executionTimeoutMs: 100,
        cancellationGraceMs: 25,
        classifyFailure,
        createExecutor: () => ({
          execute: async () => {
            executionStarted.resolve();
            return execution.promise;
          },
          cancel,
          terminate,
        }),
      });
      const nack = vi.spyOn(harness.deliveries, "nack");

      const tick = harness.runtime.tick();
      await executionStarted.promise;
      const stop = harness.runtime.stop();
      await vi.advanceTimersByTimeAsync(25);

      await expect(tick).resolves.toMatchObject({
        status: "cancelled",
        reason: "shutdown",
      });
      await expect(stop).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(500);
      expect(cancel).toHaveBeenCalledOnce();
      expect(terminate).toHaveBeenCalledOnce();
      expect(classifyFailure).not.toHaveBeenCalled();
      expect(nack).not.toHaveBeenCalled();
      expect(harness.deliveries.listActiveClaims()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a lost Claim release response before stop succeeds", async () => {
    const executionStarted = deferred<void>();
    const execution = deferred<ReactiveModuleResult>();
    const harness = await startedHarness({
      createExecutor: () => ({
        execute: async () => {
          executionStarted.resolve();
          return execution.promise;
        },
        cancel: () => execution.reject(new Error("shutdown")),
      }),
    });
    const releaseClaim = vi.spyOn(harness.deliveries, "releaseClaim");

    const tick = harness.runtime.tick();
    await executionStarted.promise;
    let persistenceWrites = 0;
    harness.deliveries.setMutationObserver(() => {
      persistenceWrites += 1;
      if (persistenceWrites === 1) throw new Error("lost release response");
    });

    await expect(harness.runtime.stop()).resolves.toBeUndefined();
    const result = await tick;
    expect(result).toMatchObject({ status: "cancelled", reason: "shutdown" });
    if (result.status !== "cancelled") throw new Error("Expected shutdown cancellation");
    expect(releaseClaim).toHaveBeenCalledOnce();
    expect(persistenceWrites).toBe(2);
    expect(harness.deliveries.inspectClaim(result).status).toBe("released");
    expect(harness.submissionRecords.get(result.runId)).toBeUndefined();
  });

  it("retries unconfirmed Claim release persistence on a later stop call", async () => {
    const executionStarted = deferred<void>();
    const execution = deferred<ReactiveModuleResult>();
    const classifyFailure = vi.fn((failure: ReactiveModuleFailure) => ({
      code: failure.code,
      retryable: true,
    }));
    const harness = await startedHarness({
      classifyFailure,
      createExecutor: () => ({
        execute: async () => {
          executionStarted.resolve();
          return execution.promise;
        },
        cancel: () => execution.reject(new Error("shutdown")),
      }),
    });
    const nack = vi.spyOn(harness.deliveries, "nack");
    const releaseClaim = vi.spyOn(harness.deliveries, "releaseClaim");

    const tick = harness.runtime.tick();
    await executionStarted.promise;
    let persistenceAvailable = false;
    harness.deliveries.setMutationObserver(() => {
      if (!persistenceAvailable) throw new Error("storage unavailable");
    });

    await expect(harness.runtime.stop()).rejects.toMatchObject({
      code: "RUNTIME_RECOVERY_REQUIRED",
    });
    const result = await tick;
    expect(result).toMatchObject({ status: "cancelled", reason: "shutdown" });
    if (result.status !== "cancelled") throw new Error("Expected shutdown cancellation");
    expect(releaseClaim).toHaveBeenCalledOnce();
    expect(classifyFailure).not.toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();

    persistenceAvailable = true;
    await expect(harness.runtime.stop()).resolves.toBeUndefined();
    expect(releaseClaim).toHaveBeenCalledTimes(2);
    expect(harness.deliveries.inspectClaim(result).status).toBe("released");
  });

  it("commits result acceptance that started before shutdown instead of releasing its Claim", async () => {
    const acceptanceStarted = deferred<void>();
    const finishAcceptance = deferred<void>();
    const harness = await startedHarness({
      afterEffect: async (event) => {
        if (event.phase === "after-block-effect") {
          acceptanceStarted.resolve();
          await finishAcceptance.promise;
        }
      },
      createExecutor: () => ({
        execute: async () => ({
          schemaVersion: "dolly.module-result/1",
          blockProposal: proposal("accepted during shutdown"),
        }),
      }),
    });
    const releaseClaim = vi.spyOn(harness.deliveries, "releaseClaim");

    const tick = harness.runtime.tick();
    await acceptanceStarted.promise;
    const stop = harness.runtime.stop();
    finishAcceptance.resolve();

    const result = await tick;
    expect(result).toMatchObject({ status: "committed" });
    if (result.status !== "committed") throw new Error("Expected committed result");
    await expect(stop).resolves.toBeUndefined();
    expect(releaseClaim).not.toHaveBeenCalled();
    expect(harness.deliveries.inspectClaim(result).status).toBe("committed");
  });

  it("rejects recovery started after runtime stop begins", async () => {
    const harness = await startedHarness({
      createExecutor: () => ({
        execute: async () => ({ schemaVersion: "dolly.module-result/1" }),
      }),
    });

    const recovery = harness.runtime.recover();
    const stop = harness.runtime.stop();
    await expect(harness.runtime.recover()).rejects.toMatchObject({
      code: "RUNTIME_STOPPING",
    });
    await expect(recovery).resolves.toEqual({ status: "nothing-to-recover" });
    await expect(stop).resolves.toBeUndefined();
  });
});
