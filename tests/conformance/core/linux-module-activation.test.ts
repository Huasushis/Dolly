/**
 * Architecture Decision Record 0009 requires two independent proofs before
 * Core may accept Module work: its own service binding, and the ability to
 * prove old Module control groups empty. These tests fix the composition rule
 * that neither proof alone is enough and that a refusal carries every reason.
 *
 * The deterministic cases mock the fixed runtime inspector rather than
 * exposing an availability override through the activation API.
 * The one case that needs a real Linux host is named and skipped elsewhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewedLinuxModuleRuntimeInspection } from "../../../src/linux-module-runtime-assets.js";

const runtimeMock = vi.hoisted(() => {
  const runtime = {
    interpreterProgram: "/usr/bin/python3" as const,
    launcherScriptPath: "/reviewed/dolly/launcher.py",
    launcherDigest:
      "sha256:2c95f759603f902340f719abaaf12b2df0ab7194d9c89f35aa835927486d3177" as const,
    confinementProgram: "/usr/bin/bwrap" as const,
  };
  return {
    runtime,
    inspect: vi.fn<() => Promise<ReviewedLinuxModuleRuntimeInspection>>(
      async () => ({ available: true as const, runtime }),
    ),
  };
});

vi.mock("../../../src/linux-module-runtime-assets.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/linux-module-runtime-assets.js")>(),
  inspectReviewedLinuxModuleRuntime: runtimeMock.inspect,
}));

import { decideLinuxModuleActivation } from "../../../src/core/linux-module-activation.js";

const LINUX_ONLY = process.platform !== "linux";

function baseOptions() {
  return {
    unitName: "dolly-test-activation.service",
    mode: "user" as const,
    queryTimeoutMs: 1_000,
    overallTimeoutMs: 2_000,
  };
}

describe("Linux Module activation preconditions", () => {
  beforeEach(() => {
    runtimeMock.inspect.mockReset();
    runtimeMock.inspect.mockResolvedValue({
      available: true as const,
      runtime: runtimeMock.runtime,
    });
  });

  it("rejects low-level evidence overrides instead of minting authority from them", async () => {
    await expect(decideLinuxModuleActivation({
      ...baseOptions(),
      cgroupRoot: "/tmp/forged-cgroup",
    } as never)).rejects.toThrow(/unknown fields: cgroupRoot/u);
    expect(runtimeMock.inspect).not.toHaveBeenCalled();
  });

  it.runIf(LINUX_ONLY)("refuses every configured Module away from Linux", async () => {
    const result = await decideLinuxModuleActivation(baseOptions());
    expect(result.permitted).toBe(false);
    if (result.permitted) throw new Error("expected a refusal");
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([
      "MODULE_ACTIVATION_PLATFORM_UNSUPPORTED",
    ]);
    expect(runtimeMock.inspect).not.toHaveBeenCalled();
  });

  it.skipIf(LINUX_ONLY)(
    "refuses when the child launcher is missing, even before the service is checked",
    async () => {
      runtimeMock.inspect.mockResolvedValueOnce({
        available: false as const,
        runtime: runtimeMock.runtime,
        detail: "the interpreter is missing",
      });
      const result = await decideLinuxModuleActivation({
        ...baseOptions(),
        // A unit name that cannot exist makes the binding fail too, so this
        // case also proves that both reasons are reported, not just the first.
        unitName: "dolly-test-activation-absent.service",
      });
      expect(result.permitted).toBe(false);
      if (result.permitted) throw new Error("expected a refusal");
      const codes = result.refusals.map((refusal) => refusal.code);
      expect(codes).toContain("MODULE_ACTIVATION_LAUNCHER_UNAVAILABLE");
      expect(codes).toContain("MODULE_ACTIVATION_SERVICE_UNVERIFIED");
      expect(runtimeMock.inspect).toHaveBeenCalledOnce();
    },
  );

  it.skipIf(LINUX_ONLY)(
    "refuses when the service binding cannot be proven, and reports its exact failures",
    async () => {
      const result = await decideLinuxModuleActivation({
        ...baseOptions(),
        unitName: "dolly-test-activation-absent.service",
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
    runtimeMock.inspect.mockResolvedValueOnce({
      available: false as const,
      runtime: runtimeMock.runtime,
      detail: "missing on purpose",
    });
    const result = await decideLinuxModuleActivation(baseOptions());
    // The result shape itself prevents a partial proof from being usable.
    expect(result.permitted).toBe(false);
    expect("stopProver" in result).toBe(false);
  });
});
