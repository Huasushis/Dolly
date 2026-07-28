/**
 * Runs the Linux launcher integration scenarios when, and only when, the host
 * can provide the environment Architecture Decision Record (ADR) 0009
 * requires: Linux, cgroup version 2, and a delegated service subtree with
 * `DelegateSubgroup=core`.
 *
 * On Windows the whole suite is skipped. Windows has no cgroups, no
 * `RLIMIT_NOFILE`, and no `exec` that replaces a process image, so there is no
 * partial version of these scenarios that would mean anything. The launcher
 * control protocol codec and the controller state machine are covered by
 * `linux-module-launcher-control-protocol.test.ts` and
 * `linux-module-launcher-controller.test.ts`, which do run on Windows.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  runLinuxModuleLauncherScenarios,
  type LauncherScenarioResult,
} from "./linux-module-launcher-scenarios.js";

function delegatedSubgroupAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .some((line) => line.startsWith("0::") && line.endsWith("/core"));
  } catch {
    return false;
  }
}

const available = delegatedSubgroupAvailable();

if (!available) {
  // eslint-disable-next-line no-console
  console.warn(
    `[skip] Linux Module launcher integration scenarios need Linux with a delegated ` +
      `cgroup v2 service subtree (DelegateSubgroup=core). Platform is ${process.platform}.`,
  );
}

const EXPECTED_SCENARIOS = [
  "delegated-cgroup-root-prepared",
  "launcher-joins-cgroup-and-execs-after-verification",
  "exit-command-before-configure-stops-launcher",
  "exit-command-after-membership-prevents-execute",
  "false-in-cgroup-report-fails-closed-without-signals",
  "malformed-frame-exits-nonzero",
  "oversized-frame-exits-nonzero",
  "out-of-order-execute-frame-exits-nonzero",
  "unknown-protocol-version-exits-nonzero",
  "closed-control-descriptor-exits-nonzero",
  "fixed-internal-deadline-exits-nonzero",
] as const;

describe.skipIf(!available)("Linux Module launcher integration", () => {
  let results: LauncherScenarioResult[] = [];

  beforeAll(async () => {
    results = await runLinuxModuleLauncherScenarios();
  }, 120_000);

  it("runs every expected scenario", () => {
    expect(results.map((result) => result.name)).toEqual([...EXPECTED_SCENARIOS]);
  });

  for (const name of EXPECTED_SCENARIOS) {
    it(`passes ${name}`, () => {
      const result = results.find((candidate) => candidate.name === name);
      expect(result, `scenario ${name} did not run`).toBeDefined();
      expect(
        result?.passed,
        `scenario ${name} failed: ${JSON.stringify(result?.detail, null, 2)}`,
      ).toBe(true);
    });
  }
});
