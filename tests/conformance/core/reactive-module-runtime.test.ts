import { describe, expect, it, vi } from "vitest";
import { BlockStore, type BlockProposal } from "../../../src/core/block-store.js";
import { DeliveryStore, type FailureClassification } from "../../../src/core/delivery-store.js";
import {
  InMemoryModuleResultCommitRepository,
  ModuleResultCommitCoordinator,
  type ModuleResultCommitHookEvent,
} from "../../../src/core/module-result-commit.js";
import {
  ReactiveModuleRuntime,
  type ReactiveModuleFailure,
  type ReactiveModuleInput,
  type ReactiveModuleResult,
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
  readonly wrapDeliveries?: (deliveries: DeliveryStore) => DeliveryStore;
  readonly outputPageIds?: readonly string[];
  readonly maxResultBytes?: number;
  readonly executionTimeoutMs?: number;
  readonly cancellationGraceMs?: number;
  readonly initializationTimeoutMs?: number;
  readonly terminationTimeoutMs?: number;
  /** Unit-test executors simulate the process-isolation contract by default. */
  readonly simulateProcessIsolation?: boolean;
  readonly declaredExternalEffects?: "none" | "core-capabilities-only";
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
  const commits = new ModuleResultCommitCoordinator({
    blocks,
    deliveries,
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
  const runtimeDeliveries = options.wrapDeliveries?.(deliveries) ?? deliveries;
  const createExecutor =
    options.simulateProcessIsolation === false
      ? options.createExecutor
      : (moduleGenerationId: string) => ({
          isolation: "process" as const,
          start: async () => undefined,
          terminate: async () => undefined,
          ...options.createExecutor(moduleGenerationId),
        });
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
    commits,
    nextModuleGenerationId: () => `generation-${++generation}`,
    monotonicNow: () => 1,
    createExecutor,
    classifyFailure,
    ...(options.declaredExternalEffects === undefined
      ? {}
      : { declaredExternalEffects: options.declaredExternalEffects }),
  });
  return { blocks, deliveries, repository, commits, runtime };
}

async function startedHarness(options: HarnessOptions) {
  const harness = createHarness(options);
  await harness.runtime.start();
  return harness;
}

describe("CORE-004 reactive Module claim/run/commit coordination", () => {
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
    let generations = 0;
    const harness = await startedHarness({
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
      wrapDeliveries: (deliveries) =>
        new Proxy(deliveries, {
          get(target, property) {
            if (property === "nack") {
              return (request: Parameters<DeliveryStore["nack"]>[0]) => {
                const result = target.nack(request);
                if (loseResponse) {
                  loseResponse = false;
                  throw new Error("lost response");
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      createExecutor: () => ({
        execute: async () => {
          executions += 1;
          if (executions === 1) throw new Error("retry me");
          return { schemaVersion: "dolly.module-result/1", blockProposal: proposal("after nack") };
        },
      }),
    });

    await expect(harness.runtime.tick()).resolves.toMatchObject({ status: "retry-scheduled" });
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
