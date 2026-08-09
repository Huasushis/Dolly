export interface AgentCaseSchedulerStatus {
  readonly schedulingState: string;
  readonly quarantineReason: string | null;
}

export async function waitForAgentCase<T>(options: {
  readonly findCommitted: () => T | undefined;
  readonly listDeadLetters: () => readonly { readonly failureCode?: string }[];
  readonly readSchedulerStatus: () => AgentCaseSchedulerStatus;
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const deadline = now() + options.timeoutMs;
  while (now() < deadline) {
    const committed = options.findCommitted();
    if (committed !== undefined) return committed;
    const deadLetters = options.listDeadLetters();
    if (deadLetters.length > 0) {
      throw new Error(
        `Module input was dead-lettered: ${deadLetters[0]!.failureCode ?? "unknown"}`,
      );
    }
    const schedulerStatus = options.readSchedulerStatus();
    if (schedulerStatus.schedulingState === "quarantined") {
      throw new Error(
        `Module was quarantined: ${schedulerStatus.quarantineReason ?? "unknown-reason"}`,
      );
    }
    await wait(options.pollIntervalMs ?? 20);
  }
  throw new Error("Agent case exceeded its registered wall-clock bound");
}
