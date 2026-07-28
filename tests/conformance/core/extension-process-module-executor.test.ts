import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import type {
  ExtensionProcessHost,
  ExtensionProcessHostSnapshot,
} from "../../../src/core/extension-process-host.js";
import {
  ModuleExecutorTerminationUnconfirmedError,
} from "../../../src/core/module-actor.js";
import { createExtensionProcessModuleExecutor } from "../../../src/adapters/extension-process-module-executor.js";
import type {
  ModuleCancellationContext,
  ModuleRunContext,
  TerminationContext,
} from "../../../src/core/module-actor.js";
import type { ReactiveModuleInput } from "../../../src/core/reactive-module-input.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const WALL_CLOCK_NOW_MS = 1_700_000_000_000;
const EXECUTOR_OPTIONS = Object.freeze({
  moduleId: "module-1",
  moduleGenerationId: "generation-1",
  executionTimeoutMs: 1_000,
  cancellationGraceMs: 250,
});

const INPUT: ReactiveModuleInput = Object.freeze({
  schemaVersion: "dolly.reactive-module-input/2",
  claimedDeliveryIds: ["delivery-1"],
  blockGroups: [],
  hasMore: true,
});

const RUN_CONTEXT: ModuleRunContext = Object.freeze({
  moduleId: "module-1",
  moduleGenerationId: "generation-1",
  moduleJobId: "module-job-1",
  runId: "run-1",
  attempt: 3,
  startedAt: 125,
  signal: new AbortController().signal,
});

function processSnapshot(
  state: ExtensionProcessHostSnapshot["state"],
  overrides: Partial<ExtensionProcessHostSnapshot> = {},
): ExtensionProcessHostSnapshot {
  return {
    isolation: "process",
    state,
    extensionId: "extension-1",
    instanceId: "instance-1",
    moduleId: "module-1",
    moduleGenerationId: "generation-1",
    processGenerationId: "process-generation-1",
    sessionId: "session-1",
    guarantees: {
      crashContained: true,
      cpuHangContained: true,
      inheritedEnvironmentScrubbed: true,
      ambientFilesystemDenied: false,
      ambientNetworkDenied: false,
      ambientSubprocessDenied: false,
      hardMemoryLimit: false,
    },
    ...overrides,
  };
}

function createHostSpies(
  result: JsonValue = { schemaVersion: "dolly.module-result/1" },
  initialSnapshot = processSnapshot("created"),
) {
  let currentSnapshot = initialSnapshot;
  const start = vi.fn(async () => {
    currentSnapshot = processSnapshot("ready");
    return currentSnapshot;
  });
  const execute = vi.fn(async () => result);
  const cancel = vi.fn(async () => "sent" as const);
  const terminate = vi.fn(async () => {
    currentSnapshot = processSnapshot("stopped");
    return currentSnapshot;
  });
  const stop = vi.fn(async () => processSnapshot("stopped"));
  const host = {
    get snapshot() {
      return currentSnapshot;
    },
    start,
    execute,
    cancel,
    terminate,
    stop,
  } as unknown as ExtensionProcessHost;
  return { host, start, execute, cancel, terminate, stop };
}

describe("Extension process Module executor", () => {
  it("forwards the exact Module job and Run identifiers, deadline, response timeout, and input", async () => {
    const hostResult = { unexpected: true };
    const calls = createHostSpies(hostResult);
    const executor = createExtensionProcessModuleExecutor(calls.host, {
      ...EXECUTOR_OPTIONS,
      wallClockNow: () => WALL_CLOCK_NOW_MS,
    });

    expect(calls.start).not.toHaveBeenCalled();
    expect(executor.isolation).toBe("process");
    await executor.start!();
    expect(calls.start).toHaveBeenCalledOnce();

    const result = await executor.execute(INPUT, RUN_CONTEXT);

    expect(result).toBe(hostResult);
    expect(calls.execute).toHaveBeenCalledOnce();
    expect(calls.execute).toHaveBeenCalledWith({
      moduleJobId: "module-job-1",
      runId: "run-1",
      attempt: 3,
      deadline: new Date(WALL_CLOCK_NOW_MS + 1_000).toISOString(),
      responseTimeoutMs: 1_251,
      hasMore: true,
      input: INPUT,
    });
  });

  it("forwards cancellation and termination without exposing process stop", async () => {
    const calls = createHostSpies();
    const executor = createExtensionProcessModuleExecutor(calls.host, EXECUTOR_OPTIONS);
    const cancellation: ModuleCancellationContext = {
      moduleId: "module-1",
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      reason: "shutdown",
    };
    const termination: TerminationContext = {
      moduleId: "module-1",
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
    };

    await executor.cancel!(cancellation);
    await executor.terminate!(termination);

    expect(calls.cancel).toHaveBeenCalledWith("run-1", "shutdown");
    expect(calls.terminate).toHaveBeenCalledWith();
    expect(executor.stop).toBeUndefined();
    expect(calls.stop).not.toHaveBeenCalled();
  });

  it("propagates termination failure without falling back to process stop", async () => {
    const calls = createHostSpies();
    const terminationFailure = new Error("termination failed");
    calls.terminate.mockRejectedValueOnce(terminationFailure);
    const executor = createExtensionProcessModuleExecutor(calls.host, EXECUTOR_OPTIONS);

    await expect(executor.terminate!({
      moduleId: "module-1",
      moduleGenerationId: "generation-1",
    })).rejects.toBe(terminationFailure);

    expect(calls.terminate).toHaveBeenCalledOnce();
    expect(calls.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["executionTimeoutMs", 0, 1],
    ["executionTimeoutMs", -1, 1],
    ["executionTimeoutMs", 1.5, 1],
    ["executionTimeoutMs", Number.NaN, 1],
    ["executionTimeoutMs", Number.POSITIVE_INFINITY, 1],
    ["executionTimeoutMs", MAX_TIMER_DELAY_MS + 1, 1],
    ["cancellationGraceMs", 1, 0],
    ["cancellationGraceMs", 1, -1],
    ["cancellationGraceMs", 1, 1.5],
    ["cancellationGraceMs", 1, Number.NaN],
    ["cancellationGraceMs", 1, Number.POSITIVE_INFINITY],
    ["cancellationGraceMs", 1, MAX_TIMER_DELAY_MS + 1],
  ])("rejects invalid %s configuration", (_label, executionTimeoutMs, cancellationGraceMs) => {
    const { host } = createHostSpies();
    expect(() =>
      createExtensionProcessModuleExecutor(host, {
        moduleId: "module-1",
        moduleGenerationId: "generation-1",
        executionTimeoutMs,
        cancellationGraceMs,
      }),
    ).toThrow(RangeError);
  });

  it("rejects response timeout overflow", () => {
    const { host } = createHostSpies();
    expect(() =>
      createExtensionProcessModuleExecutor(host, {
        moduleId: "module-1",
        moduleGenerationId: "generation-1",
        executionTimeoutMs: MAX_TIMER_DELAY_MS - 1,
        cancellationGraceMs: 1,
      }),
    ).toThrowError(/leave one millisecond/);
  });

  it("allows the largest response timeout supported by the timer", async () => {
    const calls = createHostSpies();
    const executor = createExtensionProcessModuleExecutor(calls.host, {
      moduleId: "module-1",
      moduleGenerationId: "generation-1",
      executionTimeoutMs: MAX_TIMER_DELAY_MS - 2,
      cancellationGraceMs: 1,
      wallClockNow: () => 0,
    });

    await executor.execute(INPUT, RUN_CONTEXT);

    expect(calls.execute).toHaveBeenCalledWith(
      expect.objectContaining({ responseTimeoutMs: MAX_TIMER_DELAY_MS }),
    );
  });

  it.each([Number.NaN, 1.5, 8_640_000_000_000_000])(
    "rejects an invalid or overflowing wall-clock value %s",
    async (wallClockValue) => {
      const { host } = createHostSpies();
      const executor = createExtensionProcessModuleExecutor(host, {
        moduleId: "module-1",
        moduleGenerationId: "generation-1",
        executionTimeoutMs: 1,
        cancellationGraceMs: 1,
        wallClockNow: () => wallClockValue,
      });

      await expect(executor.execute(INPUT, RUN_CONTEXT)).rejects.toBeInstanceOf(RangeError);
    },
  );

  it.each([
    { field: "moduleId", context: { ...RUN_CONTEXT, moduleId: "another-module" } },
    {
      field: "moduleGenerationId",
      context: { ...RUN_CONTEXT, moduleGenerationId: "another-generation" },
    },
  ])("rejects execution when $field does not match the host", async ({ context }) => {
    const calls = createHostSpies();
    const executor = createExtensionProcessModuleExecutor(calls.host, EXECUTOR_OPTIONS);

    await expect(executor.execute(INPUT, context)).rejects.toThrow(/does not match/);
    expect(calls.execute).not.toHaveBeenCalled();
  });

  it("rejects cancellation for another Module generation", async () => {
    const calls = createHostSpies();
    const executor = createExtensionProcessModuleExecutor(calls.host, EXECUTOR_OPTIONS);

    await expect(executor.cancel!({
      moduleId: "module-1",
      moduleGenerationId: "another-generation",
      moduleJobId: "module-job-1",
      runId: "run-1",
      reason: "shutdown",
    })).rejects.toThrow(/does not match/);
    expect(calls.cancel).not.toHaveBeenCalled();
  });

  it("rejects a host that was constructed for another Module generation", () => {
    const calls = createHostSpies(
      { schemaVersion: "dolly.module-result/1" },
      processSnapshot("created", { moduleGenerationId: "another-generation" }),
    );

    expect(() =>
      createExtensionProcessModuleExecutor(calls.host, EXECUTOR_OPTIONS),
    ).toThrow(/does not match/);
    expect(calls.start).not.toHaveBeenCalled();
  });

  it("requires start to return the ready state for the same process generation and session", async () => {
    const calls = createHostSpies();
    calls.start.mockResolvedValueOnce(
      processSnapshot("ready", { processGenerationId: "another-process-generation" }),
    );
    const executor = createExtensionProcessModuleExecutor(calls.host, EXECUTOR_OPTIONS);

    await expect(executor.start!()).rejects.toThrow(/does not match/);
  });

  it("always terminates its host even when the termination context does not match", async () => {
    const calls = createHostSpies();
    const executor = createExtensionProcessModuleExecutor(calls.host, EXECUTOR_OPTIONS);

    await expect(executor.terminate!({
      moduleId: "another-module",
      moduleGenerationId: "another-generation",
    })).resolves.toBeUndefined();
    expect(calls.terminate).toHaveBeenCalledOnce();
  });

  it("reports termination as unconfirmed when the host does not return stopped", async () => {
    const calls = createHostSpies();
    calls.terminate.mockResolvedValueOnce(processSnapshot("failed"));
    const executor = createExtensionProcessModuleExecutor(calls.host, EXECUTOR_OPTIONS);

    await expect(executor.terminate!({
      moduleId: "module-1",
      moduleGenerationId: "generation-1",
    })).rejects.toBeInstanceOf(ModuleExecutorTerminationUnconfirmedError);
    expect(calls.stop).not.toHaveBeenCalled();
  });
});
