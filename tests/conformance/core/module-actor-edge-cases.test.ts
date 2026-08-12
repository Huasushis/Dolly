import { describe, expect, it, vi } from "vitest";
import {
  ModuleActor,
  ModuleActorError,
  ModuleExecutorRunAdmissionExpiredError,
  ModuleExecutorTerminationUnconfirmedError,
  ModuleExecutorTerminatedError,
  type ModuleActorOptions,
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

function options<Input, Output>(overrides: Partial<ModuleActorOptions<Input, Output>> & {
  createExecutor: ModuleActorOptions<Input, Output>["createExecutor"];
  acceptResult: ModuleActorOptions<Input, Output>["acceptResult"];
}): ModuleActorOptions<Input, Output> {
  let generation = 1;
  return {
    moduleId: "module-edge",
    initialModuleGenerationId: "generation-1",
    maxQueuedRuns: 4,
    maxQueuedInputBytes: 1024,
    maxInputBytes: 512,
    maxRunsPerGeneration: 100,
    maxGenerations: 8,
    nextModuleGenerationId: () => `generation-${++generation}`,
    monotonicNow: () => 1,
    snapshotInput: (input) => structuredClone(input),
    measureInputBytes: (input) => Buffer.byteLength(JSON.stringify(input)),
    snapshotOutput: (output) => structuredClone(output),
    ...overrides,
  };
}

async function startedActor<Input, Output>(
  actorOptions: ModuleActorOptions<Input, Output>,
): Promise<ModuleActor<Input, Output>> {
  const actor = new ModuleActor(actorOptions);
  await actor.start();
  return actor;
}

describe("ModuleActor phase, mailbox, and lifecycle edge cases", () => {
  it("does not create or run an executor before explicit asynchronous startup completes", async () => {
    const factoryResult = deferred<ModuleExecutor<string, string>>();
    const startResult = deferred<void>();
    const execute = vi.fn(async (input: string) => input);
    const createExecutor = vi.fn(async () => factoryResult.promise);
    const actor = new ModuleActor(options<string, string>({
      createExecutor,
      acceptResult: () => undefined,
    }));

    expect(actor.state).toBe("created");
    expect(createExecutor).not.toHaveBeenCalled();
    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-before-start",
        runId: "run-before-start",
        attempt: 1,
        input: "input",
      }),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_STARTED" });

    const start = actor.start();
    expect(actor.state).toBe("starting");
    factoryResult.resolve({ start: async () => startResult.promise, execute });
    await Promise.resolve();
    expect(actor.state).toBe("starting");
    expect(execute).not.toHaveBeenCalled();
    startResult.resolve();
    await start;
    expect(actor.state).toBe("running");
    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-after-start",
        runId: "run-after-start",
        attempt: 1,
        input: "input",
      }),
    ).resolves.toMatchObject({ status: "succeeded", output: "input" });
    await actor.stop();
  });

  it("cleans up an executor whose asynchronous startup fails", async () => {
    const terminate = vi.fn().mockResolvedValue(undefined);
    const actor = new ModuleActor(options<string, string>({
      createExecutor: async () => ({
        start: async () => Promise.reject(new Error("private startup detail")),
        execute: async (input) => input,
        terminate,
      }),
      acceptResult: () => undefined,
    }));

    const failure = await actor.start().catch((error) => error);
    expect(failure).toMatchObject({ code: "ACTOR_FAILED" });
    expect(String(failure)).not.toContain("private startup detail");
    expect(terminate).toHaveBeenCalledWith({
      moduleId: "module-edge",
      moduleGenerationId: "generation-1",
    });
    expect(actor.state).toBe("failed");
    await actor.stop();
  });

  it("terminates an initial process when initialization exceeds its configured time", async () => {
    vi.useFakeTimers();
    try {
      const initialization = deferred<void>();
      const start = vi.fn(async () => initialization.promise);
      const terminate = vi.fn().mockResolvedValue(undefined);
      const execute = vi.fn(async (input: string) => input);
      const actor = new ModuleActor(options<string, string>({
        requireProcessIsolation: true,
        initializationTimeoutMs: 25,
        terminationTimeoutMs: 50,
        createExecutor: () => ({
          isolation: "process",
          start,
          execute,
          terminate,
        }),
        acceptResult: () => undefined,
      }));

      const startFailure = actor.start().catch((error) => error);
      while (start.mock.calls.length === 0) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(24);
      expect(terminate).not.toHaveBeenCalled();
      expect(actor.state).toBe("starting");

      await vi.advanceTimersByTimeAsync(1);
      await expect(startFailure).resolves.toMatchObject({ code: "ACTOR_FAILED" });
      expect(terminate).toHaveBeenCalledWith({
        moduleId: "module-edge",
        moduleGenerationId: "generation-1",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(actor.state).toBe("failed");

      initialization.reject(new Error("late initialization failure"));
      await Promise.resolve();
      expect(actor.state).toBe("failed");
      expect(actor.moduleGenerationId).toBe("generation-1");
      await expect(actor.stop()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat cooperative stop as confirmed process cleanup after startup fails", async () => {
    vi.useFakeTimers();
    try {
      const firstTermination = deferred<void>();
      let terminationAttempts = 0;
      const terminate = vi.fn(async () => {
        terminationAttempts += 1;
        if (terminationAttempts === 1) return firstTermination.promise;
      });
      const stop = vi.fn().mockResolvedValue(undefined);
      const actor = new ModuleActor(options<string, string>({
        requireProcessIsolation: true,
        initializationTimeoutMs: 1_000,
        terminationTimeoutMs: 25,
        createExecutor: () => ({
          isolation: "process",
          start: async () => Promise.reject(new Error("startup failed")),
          execute: async (input) => input,
          terminate,
          stop,
        }),
        acceptResult: () => undefined,
      }));

      const startFailure = actor.start().catch((error) => error);
      while (terminate.mock.calls.length === 0) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await expect(startFailure).resolves.toMatchObject({ code: "ACTOR_FAILED" });
      expect(actor.state).toBe("failed");
      expect(stop).not.toHaveBeenCalled();

      firstTermination.reject(new Error("late termination failure"));
      await Promise.resolve();
      expect(actor.state).toBe("failed");

      await expect(actor.stop()).resolves.toBeUndefined();
      expect(terminate).toHaveBeenCalledTimes(2);
      expect(actor.state).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues observing the same termination after the first wait times out", async () => {
    vi.useFakeTimers();
    try {
      const termination = deferred<void>();
      const terminate = vi.fn(async () => termination.promise);
      const actor = new ModuleActor(options<string, string>({
        requireProcessIsolation: true,
        initializationTimeoutMs: 1_000,
        terminationTimeoutMs: 25,
        createExecutor: () => ({
          isolation: "process",
          start: async () => Promise.reject(new Error("startup failed")),
          execute: async (input) => input,
          terminate,
        }),
        acceptResult: () => undefined,
      }));

      const startFailure = actor.start().catch((error) => error);
      while (terminate.mock.calls.length === 0) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await expect(startFailure).resolves.toMatchObject({ code: "ACTOR_FAILED" });
      expect(terminate).toHaveBeenCalledOnce();

      const stop = actor.stop();
      await Promise.resolve();
      expect(terminate).toHaveBeenCalledOnce();
      termination.resolve();

      await expect(stop).resolves.toBeUndefined();
      expect(terminate).toHaveBeenCalledOnce();
      expect(actor.state).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues observing replacement termination after its first wait times out", async () => {
    vi.useFakeTimers();
    try {
      const oldExecution = deferred<string>();
      const replacementTermination = deferred<void>();
      const terminateReplacement = vi.fn(async () => replacementTermination.promise);
      let executorCreations = 0;
      const actor = await startedActor(options<string, string>({
        requireProcessIsolation: true,
        initializationTimeoutMs: 1_000,
        terminationTimeoutMs: 25,
        createExecutor: () => {
          executorCreations += 1;
          return executorCreations === 1
            ? {
                isolation: "process",
                start: async () => undefined,
                execute: async () => oldExecution.promise,
                terminate: vi.fn().mockResolvedValue(undefined),
              }
            : {
                isolation: "process",
                start: async () => Promise.reject(new Error("replacement startup failed")),
                execute: async (input) => input,
                terminate: terminateReplacement,
              };
        },
        acceptResult: () => undefined,
      }));
      const outcome = actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-replacement-termination",
        runId: "run-replacement-termination",
        attempt: 1,
        input: "input",
      });
      while (!actor.activeRun) await Promise.resolve();

      const hardTimeout = actor.hardTimeout("run-replacement-termination").catch((error) => error);
      while (terminateReplacement.mock.calls.length === 0) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await expect(hardTimeout).resolves.toMatchObject({ code: "ACTOR_FAILED" });
      await expect(outcome).resolves.toMatchObject({
        status: "failed",
        error: { code: "EXECUTOR_TERMINATION_UNCONFIRMED" },
      });
      expect(terminateReplacement).toHaveBeenCalledOnce();

      const stop = actor.stop();
      await Promise.resolve();
      expect(terminateReplacement).toHaveBeenCalledOnce();
      replacementTermination.resolve();

      await expect(stop).resolves.toBeUndefined();
      expect(terminateReplacement).toHaveBeenCalledOnce();
      expect(actor.state).toBe("stopped");
      oldExecution.resolve("late");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up one asynchronously starting executor when concurrent stops arrive", async () => {
    const startResult = deferred<void>();
    const startCalled = deferred<void>();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async (input: string) => input);
    const actor = new ModuleActor(options<string, string>({
      createExecutor: async () => ({
        start: async () => {
          startCalled.resolve();
          await startResult.promise;
        },
        execute,
        terminate,
      }),
      acceptResult: () => undefined,
    }));

    const start = actor.start();
    await startCalled.promise;
    const firstStop = actor.stop({ cancellationGraceMs: 1_000 });
    const secondStop = actor.stop({ cancellationGraceMs: 1_000 });
    startResult.resolve();
    await expect(start).rejects.toMatchObject({ code: "ACTOR_STOPPING" });
    await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([undefined, undefined]);
    expect(terminate).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(actor.state).toBe("stopped");
  });

  it("cleans up an obtained executor when its startup operation does not settle", async () => {
    const startResult = deferred<void>();
    const startCalled = deferred<void>();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const actor = new ModuleActor(options<string, string>({
      createExecutor: () => ({
        start: async () => {
          startCalled.resolve();
          await startResult.promise;
        },
        execute: async (input) => input,
        terminate,
      }),
      acceptResult: () => undefined,
    }));

    const start = actor.start();
    await startCalled.promise;
    await expect(actor.stop({ cancellationGraceMs: 50 })).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledOnce();
    expect(actor.state).toBe("stopped");

    startResult.resolve();
    await expect(start).rejects.toMatchObject({ code: "ACTOR_STOPPED" });
  });

  it("does not report stopped while the initial executor factory is still pending", async () => {
    const factoryResult = deferred<ModuleExecutor<string, string>>();
    const factoryCalled = deferred<void>();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const actor = new ModuleActor(options<string, string>({
      createExecutor: async () => {
        factoryCalled.resolve();
        return factoryResult.promise;
      },
      acceptResult: () => undefined,
    }));

    const start = actor.start();
    await factoryCalled.promise;
    await expect(actor.stop({ cancellationGraceMs: 1 })).rejects.toMatchObject({
      code: "STOP_INCOMPLETE",
    });
    expect(actor.state).toBe("stopping");
    await expect(actor.stop()).rejects.toMatchObject({ code: "STOP_INCOMPLETE" });
    expect(actor.state).toBe("stopping");

    factoryResult.resolve({ execute: async (input) => input, terminate });
    await expect(start).rejects.toMatchObject({ code: "ACTOR_STOPPING" });
    await expect(actor.stop({ cancellationGraceMs: 1_000 })).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledOnce();
    expect(actor.state).toBe("stopped");
  });

  it("publishes a replacement only after startup and keeps ordinary errors in one generation", async () => {
    const replacementStarted = deferred<void>();
    const oldTerminate = vi.fn().mockResolvedValue(undefined);
    let creations = 0;
    let oldExecutions = 0;
    const actor = await startedActor(options<string, string>({
      createExecutor: async () => {
        creations += 1;
        if (creations === 1) {
          return {
            execute: async () => {
              oldExecutions += 1;
              if (oldExecutions === 1) throw new Error("ordinary business failure");
              throw new ModuleExecutorTerminatedError();
            },
            terminate: oldTerminate,
          };
        }
        return {
          start: async () => replacementStarted.promise,
          execute: async (input) => input,
          terminate: vi.fn().mockResolvedValue(undefined),
        };
      },
      acceptResult: () => undefined,
    }));

    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-business-error",
        runId: "run-business-error",
        attempt: 1,
        input: "first",
      }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "MODULE_EXECUTION_FAILED" } });
    expect(creations).toBe(1);
    expect(actor.moduleGenerationId).toBe("generation-1");

    const fenced = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-terminated",
      runId: "run-terminated",
      attempt: 1,
      input: "second",
    });
    while (creations < 2) await Promise.resolve();
    expect(actor.moduleGenerationId).toBe("generation-1");
    expect(oldTerminate).not.toHaveBeenCalled();
    replacementStarted.resolve();
    await expect(fenced).resolves.toMatchObject({ status: "fenced" });
    expect(actor.moduleGenerationId).toBe("generation-2");
    await actor.stop();
  });

  it("cleans up and does not publish a replacement whose startup fails", async () => {
    const oldResult = deferred<string>();
    const replacementTerminate = vi.fn().mockResolvedValue(undefined);
    let creations = 0;
    const actor = await startedActor(options<string, string>({
      createExecutor: async () => {
        creations += 1;
        return creations === 1
          ? {
              execute: async () => oldResult.promise,
              terminate: vi.fn().mockResolvedValue(undefined),
            }
          : {
              start: async () => Promise.reject(new Error("private replacement detail")),
              execute: async (input) => input,
              terminate: replacementTerminate,
            };
      },
      acceptResult: () => undefined,
    }));
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
    expect(replacementTerminate).toHaveBeenCalledWith({
      moduleId: "module-edge",
      moduleGenerationId: "generation-2",
    });
    expect(actor.moduleGenerationId).toBe("generation-1");
    expect(actor.state).toBe("failed");
    oldResult.resolve("late");
    await actor.stop();
  });

  it("cleans up a replacement executor whose startup does not settle during stop", async () => {
    const oldResult = deferred<string>();
    const replacementStart = deferred<void>();
    const replacementStartCalled = deferred<void>();
    const replacementTerminate = vi.fn().mockResolvedValue(undefined);
    let executorCreations = 0;
    const actor = await startedActor(options<string, string>({
      createExecutor: () => {
        executorCreations += 1;
        if (executorCreations === 1) {
          return {
            execute: async () => oldResult.promise,
            terminate: vi.fn().mockResolvedValue(undefined),
          };
        }
        return {
          start: async () => {
            replacementStartCalled.resolve();
            await replacementStart.promise;
          },
          execute: async (input) => input,
          terminate: replacementTerminate,
        };
      },
      acceptResult: () => undefined,
    }));
    const outcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-replacement-stop",
      runId: "run-replacement-stop",
      attempt: 1,
      input: "input",
    });
    while (!actor.activeRun) await Promise.resolve();

    const hardTimeout = actor.hardTimeout("run-replacement-stop");
    await replacementStartCalled.promise;
    await expect(actor.stop({ cancellationGraceMs: 50 })).resolves.toBeUndefined();
    expect(replacementTerminate).toHaveBeenCalledWith({
      moduleId: "module-edge",
      moduleGenerationId: "generation-2",
    });
    expect(actor.state).toBe("stopped");
    expect(actor.moduleGenerationId).toBe("generation-1");
    await expect(outcome).resolves.toMatchObject({ status: "fenced" });

    replacementStart.resolve();
    await expect(hardTimeout).resolves.toBe("module-generation-fenced");
    oldResult.resolve("late");
  });

  it("does not cancel or fence a Module generation after result acceptance starts", async () => {
    const commitStarted = deferred<void>();
    const finishCommit = deferred<void>();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const executor: ModuleExecutor<string, { value: string }> = {
      execute: async () => ({ value: "committed" }),
      terminate,
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const actor = await startedActor(options({
      createExecutor: () => executor,
      acceptResult: async () => {
        commitStarted.resolve();
        await finishCommit.promise;
      },
    }));

    const outcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "input",
    });
    await commitStarted.promise;
    const active = actor.activeRun!;
    expect(active.phase).toBe("accepting-result");
    expect(() => actor.softTimeout(active.runId)).toThrowError(
      expect.objectContaining<Partial<ModuleActorError>>({ code: "RUN_NOT_EXECUTING" }),
    );
    await expect(actor.hardTimeout(active.runId)).rejects.toMatchObject({
      code: "RUN_NOT_EXECUTING",
    });
    expect(terminate).not.toHaveBeenCalled();

    const stop = actor.stop({ cancellationGraceMs: 1_000 });
    expect(active.cancellationRequested).toBe(false);
    finishCommit.resolve();
    await expect(outcome).resolves.toMatchObject({ status: "succeeded" });
    await expect(stop).resolves.toBeUndefined();
    expect(actor.state).toBe("stopped");
  });

  it("snapshots queued input and enforces per-input plus aggregate byte limits", async () => {
    const first = deferred<{ value: string }>();
    const seen: Array<{ value: string }> = [];
    const actor = await startedActor(options<{ value: string }, { value: string }>({
      maxInputBytes: 20,
      maxQueuedInputBytes: 15,
      snapshotInput: (input) => structuredClone(input),
      measureInputBytes: (input) => Buffer.byteLength(input.value),
      createExecutor: () => ({
        async execute(input) {
          seen.push(input);
          return seen.length === 1 ? first.promise : input;
        },
      }),
      acceptResult: () => undefined,
    }));
    const mutable = { value: "first" };
    const firstOutcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: mutable,
    });
    mutable.value = "mutated";
    const queued = { value: "1234567890" };
    const secondOutcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-2",
      runId: "run-2",
      attempt: 1,
      input: queued,
    });
    queued.value = "changed";
    expect(actor.pendingBytes).toBe(10);

    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-3",
        runId: "run-3",
        attempt: 1,
        input: { value: "123456" },
      }),
    ).rejects.toMatchObject({ code: "ACTOR_QUEUE_BYTES_FULL" });
    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-4",
        runId: "run-4",
        attempt: 1,
        input: { value: "x".repeat(21) },
      }),
    ).rejects.toMatchObject({ code: "ACTOR_INPUT_TOO_LARGE" });

    first.resolve({ value: "done" });
    await firstOutcome;
    await secondOutcome;
    expect(seen).toEqual([{ value: "first" }, { value: "1234567890" }]);
    await actor.stop();
  });

  it("does not enqueue a run when input snapshotting reenters stop", async () => {
    let stop: Promise<void> | undefined;
    let actor!: ModuleActor<string, string>;
    const execute = vi.fn(async (input: string) => input);
    actor = await startedActor(options<string, string>({
      snapshotInput: (input) => {
        stop = actor.stop();
        return input;
      },
      createExecutor: () => ({ execute }),
      acceptResult: () => undefined,
    }));

    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-reentrant-stop",
        runId: "run-reentrant-stop",
        attempt: 1,
        input: "input",
      }),
    ).rejects.toMatchObject({ code: "ACTOR_STOPPING" });
    await expect(stop).resolves.toBeUndefined();
    expect(actor.pendingCount).toBe(0);
    expect(actor.activeRun).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a duplicate active Module job ID but permits a later retry", async () => {
    const first = deferred<string>();
    const actor = await startedActor(options<string, string>({
      createExecutor: () => ({ execute: async () => first.promise }),
      acceptResult: () => undefined,
    }));
    const original = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "first",
    });
    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-1",
        runId: "run-2",
        attempt: 2,
        input: "duplicate",
      }),
    ).rejects.toMatchObject({ code: "MODULE_JOB_ALREADY_ACTIVE" });
    first.resolve("done");
    await original;

    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-1",
        runId: "run-3",
        attempt: 2,
        input: "retry",
      }),
    ).resolves.toMatchObject({ status: "succeeded", attempt: 2 });
    await actor.stop();
  });

  it("rejects an invalid authority-provided run ID without orphaning promises", async () => {
    const actor = await startedActor(options<string, string>({
      createExecutor: () => ({ execute: async (input) => input }),
      acceptResult: () => undefined,
    }));
    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-1",
        runId: "invalid run id",
        attempt: 1,
        input: "input",
      }),
    ).rejects.toMatchObject({ code: "ACTOR_ID_INVALID" });
    expect(actor.state).toBe("running");
    expect(actor.activeRun).toBeNull();
    await actor.stop();
  });

  it("accepts only the current authority generation and never reuses a run ID", async () => {
    const execute = vi.fn(async (input: string) => input);
    const actor = await startedActor(options<string, string>({
      createExecutor: () => ({ execute }),
      acceptResult: () => undefined,
    }));

    await expect(
      actor.submit({
        moduleGenerationId: "generation-other",
        moduleJobId: "module-job-1",
        runId: "run-foreign",
        attempt: 1,
        input: "wrong generation",
      }),
    ).rejects.toMatchObject({ code: "MODULE_GENERATION_CONFLICT" });
    expect(execute).not.toHaveBeenCalled();

    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-1",
        runId: "run-1",
        attempt: 1,
        input: "valid",
      }),
    ).resolves.toMatchObject({ status: "succeeded", runId: "run-1" });
    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-2",
        runId: "run-1",
        attempt: 1,
        input: "reused",
      }),
    ).rejects.toMatchObject({ code: "ACTOR_ID_INVALID" });
    expect(execute).toHaveBeenCalledOnce();
    await actor.stop();
  });

  it("fences and fails cleanly when the next generation ID is invalid", async () => {
    const oldResult = deferred<string>();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const actor = await startedActor(options<string, string>({
      nextModuleGenerationId: () => "invalid generation id",
      createExecutor: () => ({ execute: async () => oldResult.promise, terminate }),
      acceptResult: () => undefined,
    }));
    const outcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "input",
    });
    while (!actor.activeRun) await Promise.resolve();
    await expect(actor.hardTimeout(actor.activeRun.runId)).rejects.toMatchObject({
      code: "ACTOR_ID_INVALID",
    });
    await expect(outcome).resolves.toMatchObject({ status: "fenced" });
    expect(actor.state).toBe("failed");
    expect(actor.activeRun).toBeNull();
    oldResult.resolve("late");
    await actor.stop();
  });

  it("reports an incomplete bounded stop instead of claiming an in-process run stopped", async () => {
    const result = deferred<string>();
    const stopExecutor = vi.fn().mockResolvedValue(undefined);
    const actor = await startedActor(options<string, string>({
      createExecutor: () => ({ execute: async () => result.promise, stop: stopExecutor }),
      acceptResult: () => undefined,
    }));
    const outcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "input",
    });
    while (!actor.activeRun) await Promise.resolve();
    const controller = new AbortController();
    const stop = actor.stop({ cancellationGraceMs: 1_000, signal: controller.signal });
    controller.abort(new Error("grace elapsed"));
    await expect(stop).rejects.toMatchObject({ code: "STOP_INCOMPLETE" });
    expect(actor.state).toBe("stopping");
    expect(stopExecutor).not.toHaveBeenCalled();

    result.resolve("late");
    await expect(outcome).resolves.toMatchObject({ status: "cancelled" });
    await expect(actor.stop()).resolves.toBeUndefined();
    expect(stopExecutor).toHaveBeenCalledOnce();
    expect(actor.state).toBe("stopped");
  });

  it("emits a stale-result event without accepting a late fenced output", async () => {
    const oldResult = deferred<string>();
    const events: Array<{ type: string; runId: string }> = [];
    let generations = 0;
    const accepted = vi.fn();
    const actor = await startedActor(options<string, string>({
      createExecutor: () => {
        generations += 1;
        return generations === 1
          ? {
              execute: async () => oldResult.promise,
              terminate: vi.fn().mockResolvedValue(undefined),
            }
          : { execute: async (input) => input, terminate: vi.fn().mockResolvedValue(undefined) };
      },
      acceptResult: accepted,
      onEvent: (event) => events.push({ type: event.type, runId: event.runId }),
    }));
    const outcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "input",
    });
    while (!actor.activeRun) await Promise.resolve();
    const runId = actor.activeRun.runId;
    await actor.hardTimeout(runId);
    await expect(outcome).resolves.toMatchObject({ status: "fenced" });
    oldResult.resolve("late output");
    await Promise.resolve();
    await Promise.resolve();
    expect(accepted).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "run.stale_result", runId });
    await actor.stop();
  });

  it("does not invoke extension code when stop is requested from run-start observation", async () => {
    const execute = vi.fn().mockResolvedValue("impossible");
    let stop: Promise<void> | undefined;
    let actor!: ModuleActor<string, string>;
    actor = await startedActor(options<string, string>({
      createExecutor: () => ({ execute }),
      acceptResult: () => undefined,
      onEvent: (event) => {
        if (event.type === "run.started") {
          stop = actor.stop({ cancellationGraceMs: 1_000 });
        }
      },
    }));

    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-1",
        runId: "run-1",
        attempt: 1,
        input: "input",
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(stop).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(actor.state).toBe("stopped");
  });

  it("keeps shutdown fenced while a reentrant clock callback is still starting a run", async () => {
    const execute = vi.fn().mockResolvedValue("impossible");
    let stop: Promise<void> | undefined;
    let actor!: ModuleActor<string, string>;
    actor = await startedActor(options<string, string>({
      monotonicNow: () => {
        stop = actor.stop({ cancellationGraceMs: 1_000 });
        return 1;
      },
      createExecutor: () => ({ execute }),
      acceptResult: () => undefined,
    }));

    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-1",
        runId: "run-1",
        attempt: 1,
        input: "input",
      }),
    ).rejects.toMatchObject({ code: "ACTOR_STOPPING" });
    await expect(stop).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(actor.state).toBe("stopped");
  });

  it("fails closed without leaking executor errors when hard termination is unproven", async () => {
    const result = deferred<string>();
    const stopExecutor = vi.fn().mockResolvedValue(undefined);
    const actor = await startedActor(options<string, string>({
      requireProcessIsolation: true,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      createExecutor: () => ({
        isolation: "process",
        start: async () => undefined,
        execute: async () => result.promise,
        terminate: vi.fn().mockRejectedValue(new Error("private executor detail")),
        stop: stopExecutor,
      }),
      acceptResult: () => undefined,
    }));
    const activeOutcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "active",
    });
    while (!actor.activeRun) await Promise.resolve();
    const queued = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-2",
      runId: "run-2",
      attempt: 1,
      input: "queued",
    });

    const hardFailure = await actor.hardTimeout(actor.activeRun.runId).catch((error) => error);
    expect(hardFailure).toMatchObject({ code: "ACTOR_FAILED" });
    expect(String(hardFailure)).not.toContain("private executor detail");
    await expect(queued).rejects.toMatchObject({ code: "ACTOR_FAILED" });
    expect(actor.state).toBe("failed");

    await expect(activeOutcome).resolves.toMatchObject({
      status: "failed",
      error: { code: "EXECUTOR_TERMINATION_UNCONFIRMED", retrySafe: false },
    });
    result.resolve("late");
    await expect(actor.stop()).rejects.toMatchObject({ code: "STOP_INCOMPLETE" });
    expect(stopExecutor).not.toHaveBeenCalled();
  });

  it("fails an idle process stop when terminate fails even if cooperative stop succeeds", async () => {
    const terminate = vi.fn().mockRejectedValue(new Error("termination failed"));
    const stop = vi.fn().mockResolvedValue(undefined);
    const actor = await startedActor(options<string, string>({
      requireProcessIsolation: true,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      createExecutor: () => ({
        isolation: "process",
        start: async () => undefined,
        execute: async (input) => input,
        terminate,
        stop,
      }),
      acceptResult: () => undefined,
    }));

    await expect(actor.stop()).rejects.toMatchObject({ code: "STOP_INCOMPLETE" });
    expect(terminate).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(actor.state).toBe("failed");
  });

  it("fails without replacement when execution reports unconfirmed termination", async () => {
    const createExecutor = vi.fn(() => ({
      execute: async () => {
        throw new ModuleExecutorTerminationUnconfirmedError();
      },
      stop: vi.fn().mockResolvedValue(undefined),
    }));
    const actor = await startedActor(options<string, string>({
      createExecutor,
      acceptResult: () => undefined,
    }));

    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-unconfirmed",
        runId: "run-unconfirmed",
        attempt: 1,
        input: "input",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "EXECUTOR_TERMINATION_UNCONFIRMED", retrySafe: false },
    });
    expect(actor.state).toBe("failed");
    expect(actor.moduleGenerationId).toBe("generation-1");
    expect(createExecutor).toHaveBeenCalledOnce();
    await expect(actor.stop()).rejects.toMatchObject({ code: "STOP_INCOMPLETE" });
  });

  it("fences the old generation when replacement executor creation fails", async () => {
    const oldResult = deferred<string>();
    let generations = 0;
    const actor = await startedActor(options<string, string>({
      createExecutor: () => {
        generations += 1;
        if (generations > 1) throw new Error("private factory detail");
        return {
          execute: async () => oldResult.promise,
          terminate: vi.fn().mockResolvedValue(undefined),
        };
      },
      acceptResult: () => undefined,
    }));
    const outcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "input",
    });
    while (!actor.activeRun) await Promise.resolve();

    const hardFailure = await actor.hardTimeout(actor.activeRun.runId).catch((error) => error);
    expect(hardFailure).toMatchObject({ code: "ACTOR_FAILED" });
    expect(String(hardFailure)).not.toContain("private factory detail");
    await expect(outcome).resolves.toMatchObject({ status: "fenced" });
    expect(actor.state).toBe("failed");
    oldResult.resolve("late");
    await actor.stop();
  });

  it("bounds run and generation identity retention", async () => {
    const runLimited = await startedActor(options<string, string>({
      maxRunsPerGeneration: 1,
      createExecutor: () => ({ execute: async (input) => input }),
      acceptResult: () => undefined,
    }));
    await expect(
      runLimited.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-1",
        runId: "run-1",
        attempt: 1,
        input: "first",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      runLimited.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-2",
        runId: "run-2",
        attempt: 1,
        input: "second",
      }),
    ).rejects.toMatchObject({ code: "RUN_LIMIT_REACHED" });
    expect(runLimited.state).toBe("running");
    await runLimited.stop();

    const never = deferred<string>();
    const generationLimited = await startedActor(options<string, string>({
      maxGenerations: 1,
      createExecutor: () => ({
        execute: async () => never.promise,
        terminate: vi.fn().mockResolvedValue(undefined),
      }),
      acceptResult: () => undefined,
    }));
    const outcome = generationLimited.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-3",
      runId: "run-1",
      attempt: 1,
      input: "input",
    });
    while (!generationLimited.activeRun) await Promise.resolve();
    await expect(generationLimited.hardTimeout(generationLimited.activeRun.runId)).rejects.toMatchObject({
      code: "MODULE_GENERATION_LIMIT_REACHED",
    });
    await expect(outcome).resolves.toMatchObject({ status: "fenced" });
    expect(generationLimited.state).toBe("failed");
    never.resolve("late");
    await generationLimited.stop();
  });

  it("rotates an idle process generation before admitting the next bounded Run", async () => {
    const events: string[] = [];
    const actor = await startedActor(options<string, string>({
      maxRunsPerGeneration: 1,
      requireProcessIsolation: true,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      createExecutor: (moduleGenerationId) => {
        events.push(`create:${moduleGenerationId}`);
        return {
          isolation: "process",
          start: async () => {
            events.push(`start:${moduleGenerationId}`);
          },
          execute: async (input) => input,
          terminate: async () => {
            events.push(`terminate:${moduleGenerationId}`);
          },
        };
      },
      acceptResult: () => undefined,
    }));
    await expect(actor.prepareNextRun()).resolves.toBe("generation-1");
    await expect(actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "first",
    })).resolves.toMatchObject({ status: "succeeded", output: "first" });

    await expect(actor.prepareNextRun()).resolves.toBe("generation-2");
    expect(events).toEqual([
      "create:generation-1",
      "start:generation-1",
      "terminate:generation-1",
      "create:generation-2",
      "start:generation-2",
    ]);
    await expect(actor.submit({
      moduleGenerationId: "generation-2",
      moduleJobId: "module-job-2",
      runId: "run-2",
      attempt: 1,
      input: "second",
    })).resolves.toMatchObject({ status: "succeeded", output: "second" });
    await actor.stop();
    expect(events.at(-1)).toBe("terminate:generation-2");
  });

  it("rotates an idle process before Claim ownership when its Host cannot admit a Run", async () => {
    const events: string[] = [];
    const actor = await startedActor(options<string, string>({
      maxRunsPerGeneration: 10,
      requireProcessIsolation: true,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      createExecutor: (moduleGenerationId) => ({
        isolation: "process" as const,
        start: async () => {
          events.push(`start:${moduleGenerationId}`);
        },
        prepareRun: () => {
          events.push(`prepare:${moduleGenerationId}`);
          return moduleGenerationId === "generation-1"
            ? { status: "rotation-required" as const, reason: "capability-invocation-capacity" as const }
            : { status: "ready" as const };
        },
        releaseRunAdmission: () => undefined,
        execute: async (input) => input,
        terminate: async () => {
          events.push(`terminate:${moduleGenerationId}`);
        },
      }),
      acceptResult: () => undefined,
    }));

    await expect(actor.prepareNextRun()).resolves.toBe("generation-2");
    expect(events).toEqual([
      "start:generation-1",
      "prepare:generation-1",
      "terminate:generation-1",
      "start:generation-2",
      "prepare:generation-2",
    ]);
    await expect(actor.submit({
      moduleGenerationId: "generation-2",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "after-rotation",
    })).resolves.toMatchObject({ status: "succeeded", output: "after-rotation" });
    await actor.stop();
  });

  it("binds exactly one prepared Host admission to exactly one submitted Run", async () => {
    const execution = deferred<string>();
    const prepareRun = vi.fn(() => ({ status: "ready" as const }));
    const releaseRunAdmission = vi.fn();
    const actor = await startedActor(options<string, string>({
      createExecutor: () => ({
        prepareRun,
        releaseRunAdmission,
        execute: () => execution.promise,
      }),
      acceptResult: () => undefined,
    }));

    await expect(actor.prepareNextRun()).resolves.toBe("generation-1");
    const first = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "first",
    });
    await expect(actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-2",
      runId: "run-2",
      attempt: 1,
      input: "second",
    })).rejects.toMatchObject({ code: "RUN_ADMISSION_REQUIRED" });
    await expect(actor.releasePreparedRun()).resolves.toBeUndefined();
    expect(releaseRunAdmission).not.toHaveBeenCalled();
    execution.resolve("done");
    await expect(first).resolves.toMatchObject({ status: "succeeded", output: "done" });
    expect(prepareRun).toHaveBeenCalledOnce();
    await actor.stop();
  });

  it("reports a Host admission that expires before IPC as not executed", async () => {
    const actor = await startedActor(options<string, string>({
      createExecutor: () => ({
        prepareRun: () => ({ status: "ready" as const }),
        releaseRunAdmission: () => undefined,
        execute: async () => {
          throw new ModuleExecutorRunAdmissionExpiredError();
        },
      }),
      acceptResult: () => undefined,
    }));

    await actor.prepareNextRun();
    await expect(actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "never sent",
    })).resolves.toMatchObject({
      status: "not-executed",
      reason: "run-admission-expired",
    });
    await actor.stop();
  });

  it("does not enter Host Run admission after shutdown begins", async () => {
    const prepareRun = vi.fn(() => ({ status: "ready" as const }));
    const actor = await startedActor(options<string, string>({
      requireProcessIsolation: true,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      createExecutor: () => ({
        isolation: "process" as const,
        start: async () => undefined,
        prepareRun,
        releaseRunAdmission: () => undefined,
        execute: async (input) => input,
        terminate: async () => undefined,
      }),
      acceptResult: () => undefined,
    }));

    const preparation = actor.prepareNextRun();
    const stop = actor.stop({ cancellationGraceMs: 100 });
    await expect(preparation).rejects.toMatchObject({ code: "ACTOR_STOPPING" });
    await expect(stop).resolves.toBeUndefined();
    expect(prepareRun).not.toHaveBeenCalled();
  });

  it("terminates a process whose Host Run admission throws", async () => {
    const terminate = vi.fn().mockResolvedValue(undefined);
    const actor = await startedActor(options<string, string>({
      requireProcessIsolation: true,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      createExecutor: () => ({
        isolation: "process" as const,
        start: async () => undefined,
        prepareRun: () => {
          throw new Error("private admission failure");
        },
        releaseRunAdmission: () => undefined,
        execute: async (input) => input,
        terminate,
      }),
      acceptResult: () => undefined,
    }));

    await expect(actor.prepareNextRun()).rejects.toMatchObject({ code: "ACTOR_FAILED" });
    expect(terminate).toHaveBeenCalledOnce();
    expect(actor.state).toBe("failed");
    await actor.stop();
  });

  it("terminates a process whose Host Run admission cannot be released", async () => {
    const terminate = vi.fn().mockResolvedValue(undefined);
    const actor = await startedActor(options<string, string>({
      requireProcessIsolation: true,
      initializationTimeoutMs: 1_000,
      terminationTimeoutMs: 1_000,
      createExecutor: () => ({
        isolation: "process" as const,
        start: async () => undefined,
        prepareRun: () => ({ status: "ready" as const }),
        releaseRunAdmission: () => {
          throw new Error("private release failure");
        },
        execute: async (input) => input,
        terminate,
      }),
      acceptResult: () => undefined,
    }));

    await expect(actor.prepareNextRun()).resolves.toBe("generation-1");
    await expect(actor.releasePreparedRun()).rejects.toMatchObject({ code: "ACTOR_FAILED" });
    expect(terminate).toHaveBeenCalledOnce();
    expect(actor.state).toBe("failed");
    await actor.stop();
  });

  it.each(["return", "throw"] as const)(
    "does not create a replacement when shutdown starts inside generation allocation (%s)",
    async (allocationOutcome) => {
      const events: string[] = [];
      let actor!: ModuleActor<string, string>;
      let stop: Promise<void> | undefined;
      actor = await startedActor(options<string, string>({
        maxRunsPerGeneration: 1,
        requireProcessIsolation: true,
        initializationTimeoutMs: 1_000,
        terminationTimeoutMs: 1_000,
        nextModuleGenerationId: () => {
          stop = actor.stop({ cancellationGraceMs: 100 });
          if (allocationOutcome === "throw") throw new Error("allocation stopped");
          return "generation-2";
        },
        createExecutor: (moduleGenerationId) => {
          events.push(`create:${moduleGenerationId}`);
          return {
            isolation: "process",
            start: async () => undefined,
            execute: async (input) => input,
            terminate: async () => {
              events.push(`terminate:${moduleGenerationId}`);
            },
          };
        },
        acceptResult: () => undefined,
      }));
      await expect(actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-1",
        runId: "run-1",
        attempt: 1,
        input: "first",
      })).resolves.toMatchObject({ status: "succeeded" });

      await expect(actor.prepareNextRun()).rejects.toMatchObject({ code: "ACTOR_STOPPING" });
      await expect(stop).resolves.toBeUndefined();
      expect(events).toEqual(["create:generation-1", "terminate:generation-1"]);
      expect(actor.state).toBe("stopped");
    },
  );

  it("isolates observer failures and sanitizes execution and acceptance failures", async () => {
    let executeFailure = true;
    const actor = await startedActor(options<string, string>({
      createExecutor: () => ({
        execute: async (input) => {
          if (executeFailure) {
            executeFailure = false;
            throw new Error("private execution detail");
          }
          return input;
        },
      }),
      acceptResult: () => {
        throw new Error("private commit detail");
      },
      onEvent: () => {
        throw new Error("observer failure");
      },
    }));

    const execution = await actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "first",
    });
    expect(execution).toMatchObject({
      status: "failed",
      error: { code: "MODULE_EXECUTION_FAILED", retrySafe: false },
    });
    expect(JSON.stringify(execution)).not.toContain("private execution detail");

    const acceptance = await actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-2",
      runId: "run-2",
      attempt: 1,
      input: "second",
    });
    expect(acceptance).toMatchObject({
      status: "failed",
      error: { code: "RESULT_ACCEPTANCE_UNCERTAIN", retrySafe: false },
    });
    expect(JSON.stringify(acceptance)).not.toContain("private commit detail");
    await actor.stop();
  });

  it("allows an explicit stop retry after executor cleanup fails", async () => {
    const stopExecutor = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("private stop detail"))
      .mockResolvedValueOnce(undefined);
    const actor = await startedActor(options<string, string>({
      createExecutor: () => ({ execute: async (input) => input, stop: stopExecutor }),
      acceptResult: () => undefined,
    }));

    const firstFailure = await actor.stop().catch((error) => error);
    expect(firstFailure).toMatchObject({ code: "ACTOR_FAILED" });
    expect(String(firstFailure)).not.toContain("private stop detail");
    expect(actor.state).toBe("failed");
    await expect(actor.stop()).resolves.toBeUndefined();
    expect(stopExecutor).toHaveBeenCalledTimes(2);
    expect(actor.state).toBe("stopped");
  });
});
