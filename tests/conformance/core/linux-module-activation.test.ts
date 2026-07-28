/**
 * Architecture Decision Record 0009 requires two independent proofs before
 * Core may accept Module work: its own service binding, and the ability to
 * prove old Module control groups empty. These tests fix the composition rule
 * that neither proof alone is enough and that a refusal carries every reason.
 *
 * The deterministic cases run on any platform by injecting the launcher check.
 * The one case that needs a real Linux host is named and skipped elsewhere.
 */
import { describe, expect, it } from "vitest";
import { decideLinuxModuleActivation } from "../../../src/core/linux-module-activation.js";

const LINUX_ONLY = process.platform !== "linux";

function baseOptions() {
  return {
    unitName: "dolly-test-activation.service",
    mode: "user" as const,
    launcherInterpreterPath: "/usr/bin/python3",
    launcherScriptPath: "/opt/dolly/launcher.py",
    queryTimeoutMs: 1_000,
    overallTimeoutMs: 2_000,
  };
}

describe("Linux Module activation preconditions", () => {
  it.runIf(LINUX_ONLY)("refuses every configured Module away from Linux", async () => {
    const result = await decideLinuxModuleActivation({
      ...baseOptions(),
      checkLauncherAvailable: async () => true,
    });
    expect(result.permitted).toBe(false);
    if (result.permitted) throw new Error("expected a refusal");
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([
      "MODULE_ACTIVATION_PLATFORM_UNSUPPORTED",
    ]);
  });

  it.skipIf(LINUX_ONLY)(
    "refuses when the child launcher is missing, even before the service is checked",
    async () => {
      const result = await decideLinuxModuleActivation({
        ...baseOptions(),
        // A unit name that cannot exist makes the binding fail too, so this
        // case also proves that both reasons are reported, not just the first.
        unitName: "dolly-test-activation-absent.service",
        checkLauncherAvailable: async () => "the interpreter is missing",
      });
      expect(result.permitted).toBe(false);
      if (result.permitted) throw new Error("expected a refusal");
      const codes = result.refusals.map((refusal) => refusal.code);
      expect(codes).toContain("MODULE_ACTIVATION_LAUNCHER_UNAVAILABLE");
      expect(codes).toContain("MODULE_ACTIVATION_SERVICE_UNVERIFIED");
    },
  );

  it.skipIf(LINUX_ONLY)(
    "refuses when the service binding cannot be proven, and reports its exact failures",
    async () => {
      const result = await decideLinuxModuleActivation({
        ...baseOptions(),
        unitName: "dolly-test-activation-absent.service",
        checkLauncherAvailable: async () => true,
      });
      expect(result.permitted).toBe(false);
      if (result.permitted) throw new Error("expected a refusal");
      expect(result.refusals.map((refusal) => refusal.code)).toContain(
        "MODULE_ACTIVATION_SERVICE_UNVERIFIED",
      );
      // The operator sees the underlying binding failure codes, not a summary.
      expect(result.bindingFailures?.length ?? 0).toBeGreaterThan(0);
    },
  );

  it("never returns a stop prover together with a refusal", async () => {
    const result = await decideLinuxModuleActivation({
      ...baseOptions(),
      checkLauncherAvailable: async () => "missing on purpose",
    });
    // The result shape itself prevents a partial proof from being usable.
    expect(result.permitted).toBe(false);
    expect("stopProver" in result).toBe(false);
  });
});
