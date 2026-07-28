import type { JsonValue } from "../core/canonical-json.js";
import type {
  ExtensionProcessHost,
  ExtensionProcessHostSnapshot,
} from "../core/extension-process-host.js";
import {
  ModuleExecutorTerminationUnconfirmedError,
  type ModuleCancellationContext,
  type ModuleExecutor,
  type ModuleRunContext,
} from "../core/module-actor.js";
import type { ReactiveModuleInput } from "../core/reactive-module-input.js";
import type { ReactiveModuleResult } from "../core/reactive-module-runtime.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function assertTimerDelay(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`${label} must be a positive integer within the supported timer range`);
  }
}

function executionDeadline(wallClockNow: () => number, executionTimeoutMs: number): string {
  const now = wallClockNow();
  if (!Number.isSafeInteger(now)) {
    throw new RangeError("wallClockNow must return milliseconds as a safe integer");
  }
  const deadlineMs = now + executionTimeoutMs;
  const deadline = new Date(deadlineMs);
  if (!Number.isSafeInteger(deadlineMs) || !Number.isFinite(deadline.getTime())) {
    throw new RangeError("Execution deadline exceeds the supported date range");
  }
  return deadline.toISOString();
}

function assertSameProcessHost(
  snapshot: ExtensionProcessHostSnapshot,
  initialSnapshot: ExtensionProcessHostSnapshot,
  expectedState: ExtensionProcessHostSnapshot["state"],
): void {
  if (
    snapshot.isolation !== "process" ||
    snapshot.state !== expectedState ||
    snapshot.extensionId !== initialSnapshot.extensionId ||
    snapshot.instanceId !== initialSnapshot.instanceId ||
    snapshot.moduleId !== initialSnapshot.moduleId ||
    snapshot.moduleGenerationId !== initialSnapshot.moduleGenerationId ||
    snapshot.processGenerationId !== initialSnapshot.processGenerationId ||
    snapshot.sessionId !== initialSnapshot.sessionId
  ) {
    throw new Error("Extension process host does not match the Module executor");
  }
}

function assertContextMatchesModuleGeneration(
  context: ModuleRunContext | ModuleCancellationContext,
  initialSnapshot: ExtensionProcessHostSnapshot,
): void {
  if (
    context.moduleId !== initialSnapshot.moduleId ||
    context.moduleGenerationId !== initialSnapshot.moduleGenerationId
  ) {
    throw new Error("Module execution context does not match the Extension process host");
  }
}

/**
 * Maps one unstarted Extension process host to the Module executor interface.
 * Process creation stays in `start()`, so the actor can call `terminate()` after
 * failed initialization.
 */
export function createExtensionProcessModuleExecutor(
  host: ExtensionProcessHost,
  options: {
    readonly moduleId: string;
    readonly moduleGenerationId: string;
    readonly executionTimeoutMs: number;
    readonly cancellationGraceMs: number;
    readonly wallClockNow?: () => number;
  },
): ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult> {
  const initialSnapshot = host.snapshot;
  if (
    initialSnapshot.moduleId !== options.moduleId ||
    initialSnapshot.moduleGenerationId !== options.moduleGenerationId
  ) {
    throw new Error("Extension process host does not match the requested Module generation");
  }
  assertSameProcessHost(initialSnapshot, initialSnapshot, "created");
  if (initialSnapshot.pid !== undefined) {
    throw new Error("Extension process host must not start its process during executor construction");
  }

  const executionTimeoutMs = options.executionTimeoutMs;
  const cancellationGraceMs = options.cancellationGraceMs;
  assertTimerDelay(executionTimeoutMs, "executionTimeoutMs");
  assertTimerDelay(cancellationGraceMs, "cancellationGraceMs");
  if (executionTimeoutMs > MAX_TIMER_DELAY_MS - cancellationGraceMs - 1) {
    throw new RangeError(
      "executionTimeoutMs plus cancellationGraceMs must leave one millisecond for the response timeout",
    );
  }
  const responseTimeoutMs = executionTimeoutMs + cancellationGraceMs + 1;
  const wallClockNow = options.wallClockNow ?? Date.now;
  if (typeof wallClockNow !== "function") {
    throw new TypeError("wallClockNow must be a function");
  }

  return Object.freeze({
    isolation: "process" as const,
    start: async (): Promise<void> => {
      const snapshot = await host.start();
      assertSameProcessHost(snapshot, initialSnapshot, "ready");
    },
    execute: async (
      input: ReactiveModuleInput,
      context: ModuleRunContext,
    ): Promise<ReactiveModuleResult> => {
      assertContextMatchesModuleGeneration(context, initialSnapshot);
      const result = await host.execute({
        moduleJobId: context.moduleJobId,
        runId: context.runId,
        attempt: context.attempt,
        deadline: executionDeadline(wallClockNow, executionTimeoutMs),
        responseTimeoutMs,
        hasMore: input.hasMore,
        input: input as unknown as JsonValue,
      });
      return result as unknown as ReactiveModuleResult;
    },
    cancel: async (context: ModuleCancellationContext): Promise<void> => {
      assertContextMatchesModuleGeneration(context, initialSnapshot);
      await host.cancel(context.runId, context.reason);
    },
    terminate: async (): Promise<void> => {
      const snapshot = await host.terminate();
      try {
        assertSameProcessHost(snapshot, initialSnapshot, "stopped");
      } catch {
        throw new ModuleExecutorTerminationUnconfirmedError(
          "Extension process host did not confirm termination for the expected Module generation",
        );
      }
    },
  });
}
