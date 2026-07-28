import { describe, expect, it, vi } from "vitest";
import {
  ModuleActor,
  type ModuleExecutor,
} from "../../../src/core/module-actor.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("CORE-001 Module actor timeout fencing", () => {
  it("keeps the serialization fence after a cooperative timeout", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const cancel = vi.fn().mockResolvedValue(undefined);

    const executor: ModuleExecutor<string, string> = {
      async execute() {
        calls += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const current = calls === 1 ? first : second;
        (calls === 1 ? firstStarted : secondStarted).resolve();
        try {
          return await current.promise;
        } finally {
          concurrent -= 1;
        }
      },
      cancel,
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const accepted = vi.fn();
    const actor = new ModuleActor({
      moduleId: "module-a",
      initialModuleGenerationId: "generation-1",
      maxQueuedRuns: 4,
      maxQueuedInputBytes: 1024,
      maxInputBytes: 512,
      maxRunsPerGeneration: 100,
      maxGenerations: 8,
      nextModuleGenerationId: () => "generation-2",
      monotonicNow: () => 1,
      snapshotInput: (input) => input,
      measureInputBytes: (input) => Buffer.byteLength(input),
      snapshotOutput: (output) => output,
      createExecutor: () => executor,
      acceptResult: accepted,
    });
    await actor.start();

    const firstOutcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "one",
    });
    await firstStarted.promise;
    const firstRunId = actor.activeRun!.runId;
    expect(actor.softTimeout(firstRunId)).toBe("cancellation-requested");
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ runId: firstRunId, reason: "soft-timeout" }),
    );
    await expect(actor.hardTimeout(firstRunId)).rejects.toMatchObject({
      code: "HARD_TIMEOUT_UNAVAILABLE",
    });

    const secondOutcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-2",
      runId: "run-2",
      attempt: 1,
      input: "two",
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(actor.pendingCount).toBe(1);

    first.resolve("late first");
    await expect(firstOutcome).resolves.toMatchObject({ status: "timed-out", runId: firstRunId });
    await secondStarted.promise;
    second.resolve("second result");
    await expect(secondOutcome).resolves.toMatchObject({ status: "succeeded", output: "second result" });

    expect(maxConcurrent).toBe(1);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith(
      "second result",
      expect.objectContaining({ moduleJobId: "module-job-2" }),
    );
    await actor.stop();
  });

  it("advances generation only after an executor-provided termination completes", async () => {
    const oldResult = deferred<string>();
    const oldStarted = deferred<void>();
    const newResult = deferred<string>();
    const newStarted = deferred<void>();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const accepted = vi.fn();
    let generationCreates = 0;

    const actor = new ModuleActor<string, string>({
      moduleId: "module-a",
      initialModuleGenerationId: "generation-1",
      maxQueuedRuns: 4,
      maxQueuedInputBytes: 1024,
      maxInputBytes: 512,
      maxRunsPerGeneration: 100,
      maxGenerations: 8,
      nextModuleGenerationId: () => `generation-${generationCreates + 1}`,
      monotonicNow: () => 1,
      snapshotInput: (input) => input,
      measureInputBytes: (input) => Buffer.byteLength(input),
      snapshotOutput: (output) => output,
      createExecutor: () => {
        generationCreates += 1;
        if (generationCreates === 1) {
          return {
            execute: async () => {
              oldStarted.resolve();
              return oldResult.promise;
            },
            terminate,
            stop: vi.fn().mockResolvedValue(undefined),
          };
        }
        return {
          execute: async () => {
            newStarted.resolve();
            return newResult.promise;
          },
          terminate: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
        };
      },
      acceptResult: accepted,
    });
    await actor.start();

    const oldOutcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "old",
    });
    await oldStarted.promise;
    const oldRun = actor.activeRun!;
    const queued = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-2",
      runId: "run-2",
      attempt: 1,
      input: "new",
    });

    await expect(actor.hardTimeout(oldRun.runId)).resolves.toBe("module-generation-fenced");
    expect(terminate).toHaveBeenCalledWith(
      expect.objectContaining({ moduleGenerationId: "generation-1", runId: oldRun.runId }),
    );
    await expect(oldOutcome).resolves.toMatchObject({ status: "fenced" });
    await expect(queued).rejects.toMatchObject({ code: "MODULE_GENERATION_FENCED" });

    expect(actor.moduleGenerationId).not.toBe("generation-1");
    const replacement = actor.submit({
      moduleGenerationId: actor.moduleGenerationId,
      moduleJobId: "module-job-2",
      runId: "run-3",
      attempt: 2,
      input: "new",
    });
    await newStarted.promise;
    newResult.resolve("new result");
    await expect(replacement).resolves.toMatchObject({
      status: "succeeded",
      output: "new result",
    });

    oldResult.resolve("impossible late result");
    await Promise.resolve();
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith(
      "new result",
      expect.objectContaining({ moduleJobId: "module-job-2" }),
    );
    await actor.stop();
  });

  it("does not install an in-process replacement when process isolation is required", async () => {
    const oldExecution = deferred<string>();
    const replacementExecute = vi.fn().mockResolvedValue("replacement result");
    const replacementTerminate = vi.fn().mockResolvedValue(undefined);
    let creations = 0;
    const actor = new ModuleActor<string, string>({
      moduleId: "module-a",
      initialModuleGenerationId: "generation-1",
      maxQueuedRuns: 1,
      maxQueuedInputBytes: 1_024,
      maxInputBytes: 512,
      maxRunsPerGeneration: 100,
      maxGenerations: 8,
      requireProcessIsolation: true,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      nextModuleGenerationId: () => "generation-2",
      monotonicNow: () => 1,
      snapshotInput: (input) => input,
      measureInputBytes: (input) => Buffer.byteLength(input),
      snapshotOutput: (output) => output,
      createExecutor: () => {
        creations += 1;
        return creations === 1
          ? {
              isolation: "process",
              start: async () => undefined,
              execute: async () => oldExecution.promise,
              terminate: vi.fn().mockResolvedValue(undefined),
            }
          : {
              isolation: "none",
              execute: replacementExecute,
              terminate: replacementTerminate,
            };
      },
      acceptResult: () => undefined,
    });
    await actor.start();
    const outcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "input",
    });
    while (!actor.activeRun) await Promise.resolve();

    await expect(actor.hardTimeout("run-1")).rejects.toMatchObject({ code: "ACTOR_FAILED" });
    await expect(outcome).resolves.toMatchObject({ status: "fenced" });
    expect(actor.state).toBe("failed");
    expect(actor.moduleGenerationId).toBe("generation-1");
    expect(replacementExecute).not.toHaveBeenCalled();
    expect(replacementTerminate).toHaveBeenCalledOnce();
    await actor.stop();
    oldExecution.resolve("late result");
  });

  it("terminates a replacement whose initialization times out without executing it", async () => {
    vi.useFakeTimers();
    try {
      const oldExecution = deferred<string>();
      const oldExecutionStarted = deferred<void>();
      const replacementInitialization = deferred<void>();
      const replacementStart = vi.fn(async () => replacementInitialization.promise);
      const replacementExecute = vi.fn().mockResolvedValue("replacement result");
      const replacementTerminate = vi.fn().mockResolvedValue(undefined);
      const accepted = vi.fn();
      let creations = 0;
      const actor = new ModuleActor<string, string>({
        moduleId: "module-a",
        initialModuleGenerationId: "generation-1",
        maxQueuedRuns: 1,
        maxQueuedInputBytes: 1_024,
        maxInputBytes: 512,
        maxRunsPerGeneration: 100,
        maxGenerations: 8,
        requireProcessIsolation: true,
        initializationTimeoutMs: 25,
        terminationTimeoutMs: 50,
        nextModuleGenerationId: () => "generation-2",
        monotonicNow: () => 1,
        snapshotInput: (input) => input,
        measureInputBytes: (input) => Buffer.byteLength(input),
        snapshotOutput: (output) => output,
        createExecutor: () => {
          creations += 1;
          if (creations === 1) {
            return {
              isolation: "process",
              start: async () => undefined,
              execute: async () => {
                oldExecutionStarted.resolve();
                return oldExecution.promise;
              },
              terminate: vi.fn().mockResolvedValue(undefined),
            };
          }
          return {
            isolation: "process",
            start: replacementStart,
            execute: replacementExecute,
            terminate: replacementTerminate,
          };
        },
        acceptResult: accepted,
      });
      await actor.start();
      const outcome = actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-1",
        runId: "run-1",
        attempt: 1,
        input: "input",
      });
      await oldExecutionStarted.promise;

      const hardTimeoutFailure = actor.hardTimeout("run-1").catch((error) => error);
      while (replacementStart.mock.calls.length === 0) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(24);
      expect(replacementTerminate).not.toHaveBeenCalled();
      expect(replacementExecute).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(hardTimeoutFailure).resolves.toMatchObject({ code: "ACTOR_FAILED" });
      await expect(outcome).resolves.toMatchObject({ status: "fenced" });
      expect(replacementTerminate).toHaveBeenCalledWith({
        moduleId: "module-a",
        moduleGenerationId: "generation-2",
      });
      expect(replacementExecute).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled();
      expect(creations).toBe(2);
      expect(actor.moduleGenerationId).toBe("generation-1");
      expect(actor.state).toBe("failed");

      replacementInitialization.reject(new Error("late initialization failure"));
      oldExecution.resolve("late result");
      await Promise.resolve();
      expect(replacementExecute).not.toHaveBeenCalled();
      expect(actor.moduleGenerationId).toBe("generation-1");
      expect(actor.state).toBe("failed");
      await expect(actor.stop()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one confirmed termination between a hard timeout and concurrent stop", async () => {
    const execution = deferred<string>();
    const termination = deferred<void>();
    const terminate = vi.fn(async () => termination.promise);
    let creations = 0;
    const actor = new ModuleActor<string, string>({
      moduleId: "module-a",
      initialModuleGenerationId: "generation-1",
      maxQueuedRuns: 1,
      maxQueuedInputBytes: 1024,
      maxInputBytes: 512,
      maxRunsPerGeneration: 100,
      maxGenerations: 8,
      nextModuleGenerationId: () => "generation-2",
      monotonicNow: () => 1,
      snapshotInput: (input) => input,
      measureInputBytes: (input) => Buffer.byteLength(input),
      snapshotOutput: (output) => output,
      createExecutor: () => {
        creations += 1;
        return { execute: async () => execution.promise, terminate };
      },
      acceptResult: () => undefined,
    });
    await actor.start();
    const outcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "input",
    });
    while (!actor.activeRun) await Promise.resolve();

    const hardTimeout = actor.hardTimeout("run-1");
    while (terminate.mock.calls.length === 0) await Promise.resolve();
    const stop = actor.stop({ cancellationGraceMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(terminate).toHaveBeenCalledOnce();
    termination.resolve();
    await expect(hardTimeout).resolves.toBe("module-generation-fenced");
    await expect(stop).resolves.toBeUndefined();
    await expect(outcome).resolves.toMatchObject({ status: "fenced" });
    expect(creations).toBe(1);
    expect(actor.state).toBe("stopped");
    execution.resolve("late");
  });
});
