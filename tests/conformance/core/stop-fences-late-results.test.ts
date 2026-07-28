import { describe, expect, it, vi } from "vitest";
import {
  ModuleActor,
  ModuleActorError,
  type ModuleExecutor,
} from "../../../src/core/module-actor.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("CORE-005 stop fences late Module results", () => {
  it("cancels active work, rejects queued work, and closes only after exit", async () => {
    const execution = deferred<string>();
    const started = deferred<void>();
    const stopped = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const acceptResult = vi.fn();
    const executor: ModuleExecutor<string, string> = {
      execute: async (_input, context) => {
        observedSignal = context.signal;
        started.resolve();
        return execution.promise;
      },
      stop: vi.fn(async () => stopped.resolve()),
    };
    const actor = new ModuleActor({
      moduleId: "module-a",
      initialModuleGenerationId: "generation-1",
      maxQueuedRuns: 2,
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
      acceptResult,
    });
    await actor.start();

    const active = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "active",
    });
    await started.promise;
    const queued = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-2",
      runId: "run-2",
      attempt: 1,
      input: "queued",
    });
    const stopPromise = actor.stop({ cancellationGraceMs: 1_000 });

    expect(observedSignal!.aborted).toBe(true);
    await expect(queued).rejects.toEqual(
      expect.objectContaining({ code: "ACTOR_STOPPING" } satisfies Partial<ModuleActorError>),
    );

    let stopSettled = false;
    void stopPromise.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    execution.resolve("late result");
    await expect(active).resolves.toMatchObject({ status: "cancelled" });
    await stopPromise;
    await stopped.promise;

    expect(acceptResult).not.toHaveBeenCalled();
    expect(actor.state).toBe("stopped");
    await expect(
      actor.submit({
        moduleGenerationId: "generation-1",
        moduleJobId: "module-job-3",
        runId: "run-3",
        attempt: 1,
        input: "after",
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "ACTOR_STOPPED" } satisfies Partial<ModuleActorError>),
    );
  });

  it("uses confirmed termination after the cancellation grace and fences a late result", async () => {
    const execution = deferred<string>();
    const started = deferred<void>();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const terminate = vi.fn().mockResolvedValue(undefined);
    const acceptResult = vi.fn();
    const events: string[] = [];
    const actor = new ModuleActor<string, string>({
      moduleId: "module-a",
      initialModuleGenerationId: "generation-1",
      maxQueuedRuns: 2,
      maxQueuedInputBytes: 1024,
      maxInputBytes: 512,
      maxRunsPerGeneration: 100,
      maxGenerations: 8,
      nextModuleGenerationId: () => "generation-2",
      monotonicNow: () => 1,
      snapshotInput: (input) => input,
      measureInputBytes: (input) => Buffer.byteLength(input),
      snapshotOutput: (output) => output,
      createExecutor: () => ({
        execute: async () => {
          started.resolve();
          return execution.promise;
        },
        cancel,
        terminate,
      }),
      acceptResult,
      onEvent: (event) => events.push(event.type),
    });
    await actor.start();
    const outcome = actor.submit({
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 1,
      input: "input",
    });
    await started.promise;

    await expect(actor.stop({ cancellationGraceMs: 0 })).resolves.toBeUndefined();
    await expect(outcome).resolves.toMatchObject({
      status: "cancelled",
      reason: "shutdown",
    });
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", reason: "shutdown" }),
    );
    expect(terminate).toHaveBeenCalledWith(
      expect.objectContaining({ moduleGenerationId: "generation-1", runId: "run-1" }),
    );
    expect(actor.state).toBe("stopped");

    execution.resolve("late result");
    await Promise.resolve();
    await Promise.resolve();
    expect(acceptResult).not.toHaveBeenCalled();
    expect(events).toContain("run.stale_result");
  });

  it("reports an incomplete stop when active execution has no termination operation", async () => {
    const execution = deferred<string>();
    const actor = new ModuleActor<string, string>({
      moduleId: "module-a",
      initialModuleGenerationId: "generation-1",
      maxQueuedRuns: 2,
      maxQueuedInputBytes: 1024,
      maxInputBytes: 512,
      maxRunsPerGeneration: 100,
      maxGenerations: 8,
      nextModuleGenerationId: () => "generation-2",
      monotonicNow: () => 1,
      snapshotInput: (input) => input,
      measureInputBytes: (input) => Buffer.byteLength(input),
      snapshotOutput: (output) => output,
      createExecutor: () => ({ execute: async () => execution.promise }),
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

    await expect(actor.stop({ cancellationGraceMs: 0 })).rejects.toMatchObject({
      code: "STOP_INCOMPLETE",
    });
    expect(actor.state).toBe("stopping");
    execution.resolve("late result");
    await expect(outcome).resolves.toMatchObject({ status: "cancelled" });
    await expect(actor.stop()).resolves.toBeUndefined();
    expect(actor.state).toBe("stopped");
  });
});
