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
import type {
  LinuxModuleAuthorizedProcess,
  LinuxModuleProtocolSession,
} from "./linux-module-executor.js";

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

function assertAuthorizedLinuxProcessHost(
  snapshot: ExtensionProcessHostSnapshot,
  process: LinuxModuleAuthorizedProcess,
): void {
  const { record, cgroup, launcher } = process;
  if (
    snapshot.state !== "created" ||
    snapshot.isolation !== "process" ||
    snapshot.instanceId !== record.instanceId ||
    snapshot.moduleId !== record.moduleId ||
    snapshot.moduleGenerationId !== record.moduleGenerationId ||
    snapshot.processGenerationId !== record.processGenerationId ||
    snapshot.pid !== launcher.processId ||
    record.state !== "starting" ||
    record.moduleCgroupPath !== cgroup.path ||
    cgroup.identity.instanceId !== record.instanceId ||
    cgroup.identity.moduleId !== record.moduleId ||
    cgroup.identity.processGenerationId !== record.processGenerationId ||
    cgroup.membershipObserved !== true ||
    cgroup.removed !== false
  ) {
    throw new Error(
      "Extension process host does not match the exact authorized Linux Module process",
    );
  }
}

/**
 * Adapts a real attached `ExtensionProcessHost` to the protocol surface owned
 * by `createLinuxModuleExecutor`. The Linux executor remains the only caller
 * that may turn process termination into a stopped lifecycle record: this
 * adapter exposes capability closure and channel observation, not Host
 * `stop()` or `terminate()`.
 */
export function createExtensionProcessLinuxProtocolSession(
  host: ExtensionProcessHost,
  process: LinuxModuleAuthorizedProcess,
  options: {
    readonly executionTimeoutMs: number;
    readonly cancellationGraceMs: number;
    readonly wallClockNow?: () => number;
  },
): LinuxModuleProtocolSession {
  const initialSnapshot = host.snapshot;
  assertAuthorizedLinuxProcessHost(initialSnapshot, process);
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

  const session: LinuxModuleProtocolSession = {
    initialize: async (): Promise<void> => {
      const snapshot = await host.start();
      assertSameProcessHost(snapshot, initialSnapshot, "ready");
      if (snapshot.pid !== process.launcher.processId) {
        throw new Error(
          "Extension process host changed the authorized Linux Module process during initialization",
        );
      }
    },
    execute: async (request): Promise<ReactiveModuleResult> => {
      const result = await host.execute({
        moduleJobId: request.moduleJobId,
        runId: request.runId,
        attempt: request.attempt,
        deadline: executionDeadline(wallClockNow, executionTimeoutMs),
        responseTimeoutMs,
        hasMore: request.hasMore,
        input: request.input as unknown as JsonValue,
      });
      return result as unknown as ReactiveModuleResult;
    },
    cancel: async (runId, reason): Promise<void> => {
      await host.cancel(runId, reason);
    },
    closeCapabilitySession: () => host.closeCapabilitySession(),
    waitForChannelClosed: (timeoutMs) => host.waitForChannelClosed(timeoutMs),
  };
  return Object.freeze(session);
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
