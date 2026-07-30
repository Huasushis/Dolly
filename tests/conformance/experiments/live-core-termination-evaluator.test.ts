import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const EVALUATOR = join(
  process.cwd(),
  "scripts/experiments/linux-core-service-ownership/handlers/live-core-termination-evaluate.mjs",
);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeBeforeMembershipEvidence(
  overrides: Record<string, unknown> = {},
): { readonly directory: string; readonly reportPath: string; readonly tracePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "dolly-live-termination-evaluator-"));
  temporaryDirectories.push(directory);
  const reportPath = join(directory, "report.json");
  const tracePath = join(directory, "trace");
  writeFileSync(
    reportPath,
    `${JSON.stringify({
      phase: "live-termination-complete",
      binding: { serviceInvocationId: "service-invocation" },
      signalledRecoveredProcessId: false,
      generations: [
        {
          started: false,
          executionAuthorized: false,
          startFailure: {
            code: "MODULE_PROCESS_STOP_REQUESTED",
            coreMustExit: false,
          },
          preMembership: { members: [], populated: "0" },
          descendantStarted: false,
          launcherExit: { code: 1, signal: null },
          membersAfterStop: [],
          cgroupOperations: ["read-cgroup-events", "remove-cgroup-directory"],
          groupTerminationAttempted: false,
          genericTerminationWithoutObservedMembership: {
            ran: true,
            refused: true,
            code: "MODULE_CGROUP_MEMBERSHIP_UNOBSERVED",
          },
          groupDirectoryPresentAfterStop: false,
          populatedAfterStop: null,
          recordState: "stopped",
          ...overrides,
        },
      ],
    })}\n`,
    "utf8",
  );
  writeFileSync(tracePath, "pre-membership-stop-requested\n", "utf8");
  return { directory, reportPath, tracePath };
}

function evaluateBeforeMembershipEvidence(
  evidence: ReturnType<typeof writeBeforeMembershipEvidence>,
): { readonly status: number | null; readonly output: Record<string, unknown> } {
  const outputPath = join(evidence.directory, "evaluation.json");
  const result = spawnSync(
    process.execPath,
    [
      EVALUATOR,
      "--case",
      "LC-orderly-stop-before-no-descendant",
      "--reason",
      "orderly-stop",
      "--membership",
      "before",
      "--descendant",
      "none",
      "--report",
      evidence.reportPath,
      "--trace",
      evidence.tracePath,
      "--first-invocation-id",
      "service-invocation",
      "--last-invocation-id",
      "service-invocation",
      "--restarts",
      "0",
      "--residue",
      "0",
      "--output",
      outputPath,
    ],
    { encoding: "utf8" },
  );
  return {
    status: result.status,
    output: JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>,
  };
}

function writeAfterMembershipEvidence(): {
  readonly directory: string;
  readonly reportPath: string;
  readonly tracePath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "dolly-live-termination-evaluator-"));
  temporaryDirectories.push(directory);
  const reportPath = join(directory, "report.json");
  const tracePath = join(directory, "trace");
  writeFileSync(
    reportPath,
    `${JSON.stringify({
      phase: "live-termination-complete",
      binding: { serviceInvocationId: "service-invocation" },
      signalledRecoveredProcessId: false,
      replacementStartedAfterProof: null,
      generations: [
        {
          started: true,
          executionAuthorized: true,
          descendantStarted: false,
          hardTimeoutExpired: false,
          membersBeforeTermination: ["4242"],
          groupTerminationAttempted: true,
          cgroupOperations: [
            "write-cgroup-kill",
            "read-cgroup-events",
            "remove-cgroup-directory",
          ],
          terminationOutcome: { terminated: true },
          membersAfterTermination: [],
          populatedAfterTermination: null,
          groupDirectoryPresentAfterTermination: false,
          recordState: "stopped",
        },
      ],
    })}\n`,
    "utf8",
  );
  writeFileSync(tracePath, "before-termination\n", "utf8");
  return { directory, reportPath, tracePath };
}

function evaluateAfterMembershipEvidence(
  evidence: ReturnType<typeof writeAfterMembershipEvidence>,
): { readonly status: number | null; readonly output: Record<string, unknown> } {
  const outputPath = join(evidence.directory, "evaluation.json");
  const result = spawnSync(
    process.execPath,
    [
      EVALUATOR,
      "--case",
      "LC-orderly-stop-after-no-descendant",
      "--reason",
      "orderly-stop",
      "--membership",
      "after",
      "--descendant",
      "none",
      "--report",
      evidence.reportPath,
      "--trace",
      evidence.tracePath,
      "--first-invocation-id",
      "service-invocation",
      "--last-invocation-id",
      "service-invocation",
      "--restarts",
      "0",
      "--residue",
      "0",
      "--output",
      outputPath,
    ],
    { encoding: "utf8" },
  );
  return {
    status: result.status,
    output: JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>,
  };
}

describe("live Core termination evaluator", () => {
  it("accepts launcher-exit cleanup only with ordered file-operation evidence", () => {
    const result = evaluateBeforeMembershipEvidence(writeBeforeMembershipEvidence());

    expect(result.status).toBe(0);
    expect(result.output.failed).toBe(0);
  });

  it("rejects a report when the Module cgroup directory remains", () => {
    const result = evaluateBeforeMembershipEvidence(
      writeBeforeMembershipEvidence({ groupDirectoryPresentAfterStop: true }),
    );

    expect(result.status).toBe(1);
    const checks = result.output.checks as readonly Record<string, unknown>[];
    expect(checks).toContainEqual(
      expect.objectContaining({
        id: "the-group-was-removed-after-launcher-exit",
        status: "failed",
      }),
    );
  });

  it("rejects launcher-exit cleanup without a fresh empty-state read", () => {
    const result = evaluateBeforeMembershipEvidence(
      writeBeforeMembershipEvidence({
        cgroupOperations: ["remove-cgroup-directory"],
      }),
    );

    expect(result.status).toBe(1);
    const checks = result.output.checks as readonly Record<string, unknown>[];
    expect(checks).toContainEqual(
      expect.objectContaining({
        id: "the-group-was-removed-after-launcher-exit",
        status: "failed",
      }),
    );
  });

  it("accepts observed-member cleanup only with group termination evidence", () => {
    const result = evaluateAfterMembershipEvidence(writeAfterMembershipEvidence());

    expect(result.status).toBe(0);
    expect(result.output.failed).toBe(0);
  });
});
