import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveLinuxProcessConfinementExecution,
} from "../../../src/adapters/linux-process-confinement.js";

const BUBBLEWRAP = "/usr/bin/bwrap";
const NODE = "/usr/bin/node";
const INSTALLATION = "/var/lib/dolly/extensions/package-a";
const ENTRYPOINT = `${INSTALLATION}/dist/main.mjs`;
const STATE = "/var/lib/dolly/instances/instance-a";

describe("Linux process confinement derivation", () => {
  it("derives one closed namespace command from host-owned paths", () => {
    const execution = deriveLinuxProcessConfinementExecution({
      bubblewrapProgram: BUBBLEWRAP,
      nodeProgram: NODE,
      installationDirectory: INSTALLATION,
      entrypointPath: ENTRYPOINT,
      coreStateDirectory: STATE,
    });

    expect(execution).toEqual({
      program: BUBBLEWRAP,
      argumentVector: [
        BUBBLEWRAP,
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/run",
        "--tmpfs", "/tmp",
        "--tmpfs", STATE,
        "--dir", "/run/dolly",
        "--ro-bind", INSTALLATION, "/run/dolly/extension",
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
        "--chdir", "/run/dolly/extension",
        "--",
        NODE,
        "/run/dolly/extension/dist/main.mjs",
      ],
      environment: {},
    });
    expect(Object.isFrozen(execution)).toBe(true);
    expect(Object.isFrozen(execution.argumentVector)).toBe(true);
    expect(Object.isFrozen(execution.environment)).toBe(true);
  });

  it("rejects path substitution and overlap before a launcher exists", () => {
    const base = {
      bubblewrapProgram: BUBBLEWRAP,
      nodeProgram: NODE,
      installationDirectory: INSTALLATION,
      entrypointPath: ENTRYPOINT,
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
    })).toThrow(/must not overlap/u);
    expect(() => deriveLinuxProcessConfinementExecution({
      ...base,
      installationDirectory: `${STATE}/packages/package-a`,
      entrypointPath: `${STATE}/packages/package-a/main.mjs`,
    })).toThrow(/must not overlap/u);
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
      coreStateDirectory: STATE,
    });

    const separator = execution.argumentVector.indexOf("--");
    expect(separator).toBeGreaterThan(0);
    expect(execution.argumentVector.slice(separator + 1)).toEqual([
      NODE,
      "/run/dolly/extension/dist/--unshare-all",
    ]);
  });
});
