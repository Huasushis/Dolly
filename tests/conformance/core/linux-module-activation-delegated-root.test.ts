import { describe, expect, it, vi } from "vitest";
import type { ModuleCgroupFileSystem } from "../../../src/core/linux-module-cgroup.js";

const SERVICE_CGROUP = "/user.slice/dolly-core.service";
const CGROUP_ROOT = "/test-cgroup";

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

vi.mock("../../../src/core/linux-core-service-binding.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/core/linux-core-service-binding.js")>(),
  inspectCoreServiceBinding: bindingMock.inspect,
}));

import { decideLinuxModuleActivation } from "../../../src/core/linux-module-activation.js";

function cgroupFileSystem(readSubtreeControl: () => string): ModuleCgroupFileSystem {
  const root = `${CGROUP_ROOT}${SERVICE_CGROUP}`;
  return {
    readTextFile: vi.fn(async (path: string) => {
      if (path === `${root}/cgroup.procs`) return "";
      if (path === `${root}/cgroup.controllers`) return "cpu io memory pids\n";
      if (path === `${root}/cgroup.subtree_control`) return readSubtreeControl();
      throw new Error(`unexpected read ${path}`);
    }),
    writeTextFile: vi.fn(async () => undefined),
    createDirectory: vi.fn(async () => undefined),
    removeDirectory: vi.fn(async () => undefined),
    listChildDirectoryNames: vi.fn(async () => []),
    directoryExists: vi.fn(async () => false),
    writableFileExists: vi.fn(async () => true),
  };
}

function options(fileSystem: ModuleCgroupFileSystem) {
  return {
    unitName: "dolly-core.service",
    mode: "user" as const,
    cgroupRoot: CGROUP_ROOT,
    launcherInterpreterPath: "/usr/bin/python3",
    launcherScriptPath: "/opt/dolly/launcher.py",
    checkLauncherAvailable: async () => true as const,
    cgroupFileSystem: fileSystem,
  };
}

describe("Linux Module activation delegated-root authority", () => {
  it.runIf(process.platform === "linux")(
    "refuses activation when required subtree controllers do not read back",
    async () => {
      const fileSystem = cgroupFileSystem(() => "cpu memory\n");
      const result = await decideLinuxModuleActivation(options(fileSystem));

      expect(result).toEqual({
        permitted: false,
        refusals: [{
          code: "MODULE_ACTIVATION_CGROUP_UNAVAILABLE",
          detail: expect.stringContaining("does not enable pids"),
        }],
      });
      expect("stopProver" in result).toBe(false);
      expect(fileSystem.writeTextFile).toHaveBeenCalledWith(
        `${CGROUP_ROOT}${SERVICE_CGROUP}/cgroup.subtree_control`,
        "+cpu +memory +pids",
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "binds the prepared delegated root into a permitted result",
    async () => {
      let subtreeControl = "";
      const fileSystem = cgroupFileSystem(() => subtreeControl);
      vi.mocked(fileSystem.writeTextFile).mockImplementation(async (_path, value) => {
        subtreeControl = value.replaceAll("+", "");
      });

      const result = await decideLinuxModuleActivation(options(fileSystem));

      expect(result).toMatchObject({
        permitted: true,
        binding: bindingMock.binding,
        delegatedRoot: {
          filesystemPath: `${CGROUP_ROOT}${SERVICE_CGROUP}`,
          controllers: ["cpu", "io", "memory", "pids"],
          subtreeControl: ["cpu", "memory", "pids"],
        },
      });
      expect("stopProver" in result).toBe(true);
    },
  );
});
