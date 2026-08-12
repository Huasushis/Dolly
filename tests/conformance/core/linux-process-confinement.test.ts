import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveLinuxProcessConfinementExecution,
  LINUX_PACKAGE_SNAPSHOT_BOOTSTRAP,
} from "../../../src/adapters/linux-process-confinement.js";
import {
  createLauncherExecuteCommand,
  LAUNCHER_CONTROL_MAX_FRAME_BYTES,
} from "../../../src/adapters/linux-module-launcher/launcher-control-protocol.js";
import { canonicalJsonByteLength } from "../../../src/core/canonical-json.js";
import { createExtensionPackageSnapshot } from "../../../src/core/extension-package-snapshot.js";

const BUBBLEWRAP = "/usr/bin/bwrap";
const NODE = "/usr/bin/node";
const INSTALLATION = "/var/lib/dolly/extensions/package-a";
const ENTRYPOINT = `${INSTALLATION}/dist/main.mjs`;
const STATE = "/var/lib/dolly/instances/instance-a";
const SNAPSHOT = createExtensionPackageSnapshot([
  { path: "dist/main.mjs", bytes: Buffer.from("export {};\n", "utf8") },
]);

describe("Linux process confinement derivation", () => {
  it("derives one closed namespace command from host-owned paths", () => {
    const execution = deriveLinuxProcessConfinementExecution({
      bubblewrapProgram: BUBBLEWRAP,
      nodeProgram: NODE,
      installationDirectory: INSTALLATION,
      entrypointPath: ENTRYPOINT,
      packageSnapshot: SNAPSHOT,
      coreStateDirectory: STATE,
    });

    expect(execution).toEqual({
      program: BUBBLEWRAP,
      argumentVector: [
        BUBBLEWRAP,
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/sbin", "/sbin",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/run",
        "--tmpfs", "/tmp",
        "--dir", "/run/dolly",
        "--file", "4", "/run/dolly/package.snapshot",
        "--ro-bind", NODE, "/run/dolly/node",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-cgroup",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-net",
        "--disable-userns",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--cap-drop", "ALL",
        "--chdir", "/run/dolly",
        "--",
        "/usr/bin/python3",
        "-I",
        "-B",
        "-c",
        LINUX_PACKAGE_SNAPSHOT_BOOTSTRAP,
        SNAPSHOT.digest,
        String(SNAPSHOT.byteLength),
        String(SNAPSHOT.fileCount),
        String(SNAPSHOT.totalFileBytes),
        "dist/main.mjs",
      ],
      environment: {},
      packageSnapshot: SNAPSHOT,
    });
    expect(Object.isFrozen(execution)).toBe(true);
    expect(Object.isFrozen(execution.argumentVector)).toBe(true);
    expect(Object.isFrozen(execution.environment)).toBe(true);
    expect(execution.argumentVector).not.toContain(STATE);
    expect(execution.argumentVector).not.toEqual(expect.arrayContaining(["--ro-bind", "/", "/"]));

    const executeCommand = createLauncherExecuteCommand(
      execution.program,
      execution.argumentVector,
      execution.environment,
    );
    expect(canonicalJsonByteLength(executeCommand)).toBeLessThanOrEqual(
      LAUNCHER_CONTROL_MAX_FRAME_BYTES,
    );
  });

  it("rejects path substitution and overlap before a launcher exists", () => {
    const base = {
      bubblewrapProgram: BUBBLEWRAP,
      nodeProgram: NODE,
      installationDirectory: INSTALLATION,
      entrypointPath: ENTRYPOINT,
      packageSnapshot: SNAPSHOT,
      coreStateDirectory: STATE,
    } as const;

    expect(() => deriveLinuxProcessConfinementExecution({
      ...base,
      bubblewrapProgram: "bwrap",
    })).toThrow(/bubblewrapProgram must be an absolute normalized Linux path/u);
    expect(() => deriveLinuxProcessConfinementExecution({
      ...base,
      entrypointPath: "/var/lib/dolly/extensions/other/main.mjs",
    })).toThrow(/entrypointPath must be inside installationDirectory/u);
    expect(() => deriveLinuxProcessConfinementExecution({
      ...base,
      coreStateDirectory: "/",
    })).toThrow(/coreStateDirectory cannot be a root or runtime-system directory/u);
    expect(() => deriveLinuxProcessConfinementExecution({
      ...base,
      coreStateDirectory: `${INSTALLATION}/private-state`,
    })).toThrow(/must not be the installed package or one of its descendants/u);
    const installationInsideState = deriveLinuxProcessConfinementExecution({
      ...base,
      installationDirectory: `${STATE}/packages/package-a`,
      entrypointPath: `${STATE}/packages/package-a/main.mjs`,
    });
    expect(installationInsideState.argumentVector).not.toContain(STATE);
    expect(installationInsideState.argumentVector).not.toContain(`${STATE}/packages/package-a`);
    expect(() => deriveLinuxProcessConfinementExecution({
      ...base,
      coreStateDirectory: "/run/dolly-state",
    })).toThrow(/coreStateDirectory cannot be a root or runtime-system directory/u);
    expect(() => deriveLinuxProcessConfinementExecution({
      ...base,
      coreStateDirectory: "/tmp/dolly-state",
    })).toThrow(/coreStateDirectory cannot be a root or runtime-system directory/u);
  });

  it("does not let path text become a bubblewrap option", () => {
    const injection = resolve(INSTALLATION, "dist", "--unshare-all");
    const execution = deriveLinuxProcessConfinementExecution({
      bubblewrapProgram: BUBBLEWRAP,
      nodeProgram: NODE,
      installationDirectory: INSTALLATION,
      entrypointPath: injection,
      packageSnapshot: SNAPSHOT,
      coreStateDirectory: STATE,
    });

    const separator = execution.argumentVector.indexOf("--");
    expect(separator).toBeGreaterThan(0);
    expect(execution.argumentVector.slice(separator + 1)).toEqual([
      "/usr/bin/python3",
      "-I",
      "-B",
      "-c",
      LINUX_PACKAGE_SNAPSHOT_BOOTSTRAP,
      SNAPSHOT.digest,
      String(SNAPSHOT.byteLength),
      String(SNAPSHOT.fileCount),
      String(SNAPSHOT.totalFileBytes),
      "dist/--unshare-all",
    ]);
  });
});
