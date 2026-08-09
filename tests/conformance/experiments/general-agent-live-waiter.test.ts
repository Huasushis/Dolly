import { describe, expect, it, vi } from "vitest";
import { waitForAgentCase } from "../../../scripts/experiments/probes/general-agent-live-v0/wait-for-case.mjs";

describe("general Agent live terminal-state waiter", () => {
  it("reports a Scheduler quarantine without waiting for the case timeout", async () => {
    let now = 0;
    let polls = 0;
    const wait = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
      polls += 1;
    });

    await expect(
      waitForAgentCase({
        findCommitted: () => undefined,
        listDeadLetters: () => [],
        readSchedulerStatus: () =>
          polls === 0
            ? { schedulingState: "running", quarantineReason: null }
            : {
                schedulingState: "quarantined",
                quarantineReason: "RECOVERY_REQUIRED:external-effect-outcome-unknown",
              },
        timeoutMs: 10_000,
        pollIntervalMs: 20,
        now: () => now,
        wait,
      }),
    ).rejects.toThrowError(
      "Module was quarantined: RECOVERY_REQUIRED:external-effect-outcome-unknown",
    );
    expect(wait).toHaveBeenCalledOnce();
    expect(now).toBe(20);
  });
});
