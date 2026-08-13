import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegatedCgroupRootResult } from "../../../src/core/linux-module-cgroup.js";
import type { ReviewedLinuxModuleRuntimeInspection } from "../../../src/linux-module-runtime-assets.js";

const SERVICE_CGROUP = "/user.slice/dolly-core.service";

const runtimeMock = vi.hoisted(() => {
  const runtime = {
    schemaVersion: "dolly.linux-module-runtime-profile/1" as const,
    nodeProgram: process.execPath,
    nodeVersion: process.versions.node,
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

const bindingMock = vi.hoisted(() => {
  const serviceCgroup = "/user.slice/dolly-core.service";
  const binding = {
    mode: "user" as const,
    unitName: "dolly-core.service",
    serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
    bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
    mainPid: 4242,
    delegatedRootCgroupPath: serviceCgroup,
    coreCgroupPath: `${serviceCgroup}/core`,
    delegatedRootControllers: ["cpu", "memory", "pids"],
  };
  return {
    binding,
    inspect: vi.fn(async () => ({ verified: true as const, binding })),
  };
});

const cgroupMock = vi.hoisted(() => {
  const root = {
    filesystemPath: "/sys/fs/cgroup/user.slice/dolly-core.service",
    controllers: ["cpu", "io", "memory", "pids"],
    subtreeControl: ["cpu", "memory", "pids"],
  };
  return {
    root,
    prepare: vi.fn<() => Promise<DelegatedCgroupRootResult>>(
      async () => ({ prepared: true as const, root }),
    ),
  };
});

vi.mock("../../../src/core/linux-core-service-binding.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/core/linux-core-service-binding.js")>(),
  inspectCoreServiceBinding: bindingMock.inspect,
}));
vi.mock("../../../src/core/linux-module-cgroup.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/core/linux-module-cgroup.js")>(),
  prepareDelegatedCgroupRoot: cgroupMock.prepare,
}));
vi.mock("../../../src/linux-module-runtime-assets.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/linux-module-runtime-assets.js")>(),
  inspectReviewedLinuxModuleRuntime: runtimeMock.inspect,
}));

import {
  assertLinuxModuleActivationPermission,
  assertLinuxModuleRuntimeBinding,
  decideLinuxModuleActivation,
} from "../../../src/core/linux-module-activation.js";

function options() {
  return {
    unitName: "dolly-core.service",
    mode: "user" as const,
  };
}

describe("Linux Module activation delegated-root authority", () => {
  beforeEach(() => {
    cgroupMock.prepare.mockReset();
    cgroupMock.prepare.mockResolvedValue({
      prepared: true as const,
      root: cgroupMock.root,
    });
  });

  it.runIf(process.platform === "linux")(
    "refuses activation when required subtree controllers do not read back",
    async () => {
      cgroupMock.prepare.mockResolvedValueOnce({
        prepared: false as const,
        failure: {
          code: "MODULE_CGROUP_CONTROLLER_UNAVAILABLE" as const,
          detail: "cgroup.subtree_control does not enable pids",
        },
      });
      const result = await decideLinuxModuleActivation(options());

      expect(result).toEqual({
        permitted: false,
        refusals: [{
          code: "MODULE_ACTIVATION_CGROUP_UNAVAILABLE",
          detail: expect.stringContaining("does not enable pids"),
        }],
      });
      expect("stopProver" in result).toBe(false);
      expect(cgroupMock.prepare).toHaveBeenCalledWith({
        delegatedRootCgroupPath: SERVICE_CGROUP,
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "binds the prepared delegated root into a permitted result",
    async () => {
      const result = await decideLinuxModuleActivation(options());

      expect(result).toMatchObject({
        permitted: true,
        binding: bindingMock.binding,
        runtime: {
          auditProfile: runtimeMock.runtime,
          bindingRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        delegatedRoot: cgroupMock.root,
      });
      expect("stopProver" in result).toBe(true);
      if (!result.permitted) throw new Error("expected activation permission");
      expect(() => assertLinuxModuleActivationPermission(result)).not.toThrow();
      expect(() => assertLinuxModuleActivationPermission({ ...result }))
        .toThrow(/was not minted by the Host activation decision/u);
      expect(() => assertLinuxModuleRuntimeBinding(result.runtime)).not.toThrow();
      expect(() => assertLinuxModuleRuntimeBinding({ ...result.runtime }))
        .toThrow(/was not minted by the Host activation decision/u);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.binding)).toBe(true);
      expect(Object.isFrozen(result.delegatedRoot)).toBe(true);
      expect(Object.isFrozen(result.runtime)).toBe(true);
      expect(Object.isFrozen(result.runtime.auditProfile)).toBe(true);
    },
  );
});
