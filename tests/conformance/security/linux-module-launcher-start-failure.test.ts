/**
 * A launcher that cannot start must fail closed, not crash Core.
 *
 * Architecture Decision Record 0009 requires a missing child-launcher
 * interpreter to be refused the same way a missing systemd is. Node reports a
 * failed spawn asynchronously through the child's `error` event, and an
 * unobserved `error` event on an EventEmitter is re-thrown as an uncaught
 * exception, which would end the Core process. Under `Restart=on-failure`
 * that becomes a restart loop that spends the finite restart budget.
 */
import { closeSync, openSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultLauncherScriptPath,
  LinuxModuleLauncherStartError,
  startLinuxModuleLauncher,
} from "../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js";

const POSIX_ONLY = process.platform === "win32";

describe("Linux Module launcher start failure", () => {
  it.skipIf(POSIX_ONLY)(
    "reports a missing interpreter instead of raising an uncaught exception",
    async () => {
      const uncaught: unknown[] = [];
      const onUncaught = (error: unknown): void => {
        uncaught.push(error);
      };
      process.on("uncaughtException", onUncaught);
      try {
        // A failed spawn surfaces either synchronously, when the operating
        // system reports that no child was created, or asynchronously through
        // the child's `error` event. Both are acceptable refusals; what must
        // never happen is an uncaught exception that ends the Core process.
        let refusal: unknown;
        let started: ReturnType<typeof startLinuxModuleLauncher> | undefined;
        try {
          started = startLinuxModuleLauncher({
            interpreterProgram: "/nonexistent/dolly-test-python3",
            launcherScriptPath: "/nonexistent/dolly-test-launcher.py",
            protocolStdio: ["ignore", "ignore", "ignore"],
          });
        } catch (error) {
          refusal = error;
        }
        if (started) {
          refusal = await started.waitForLaunchError(5_000);
          expect((refusal as NodeJS.ErrnoException).code).toBe("ENOENT");
          started.closeControlChannel();
        } else {
          expect(refusal).toBeInstanceOf(LinuxModuleLauncherStartError);
        }
        expect(refusal).toBeInstanceOf(Error);

        // Give the event loop several turns so a re-thrown `error` event would
        // have surfaced by now.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(uncaught).toEqual([]);
      } finally {
        process.off("uncaughtException", onUncaught);
      }
    },
  );

  it("rejects a relative interpreter or script path before spawning anything", () => {
    expect(() =>
      startLinuxModuleLauncher({
        interpreterProgram: "python3",
        launcherScriptPath: "/opt/dolly/launcher.py",
      }),
    ).toThrowError(TypeError);
    expect(() =>
      startLinuxModuleLauncher({
        interpreterProgram: "/usr/bin/python3",
        launcherScriptPath: "launcher.py",
      }),
    ).toThrowError(TypeError);
  });

  it.skipIf(POSIX_ONLY)("executes the launcher from one inherited pinned descriptor", async () => {
    const descriptor = openSync(defaultLauncherScriptPath(), "r");
    let started: ReturnType<typeof startLinuxModuleLauncher> | undefined;
    try {
      started = startLinuxModuleLauncher({
        interpreterProgram: "/usr/bin/python3",
        launcherScriptDescriptor: descriptor,
        protocolStdio: ["ignore", "ignore", "ignore"],
      });
    } finally {
      closeSync(descriptor);
    }
    expect(started.launchError).toBeUndefined();
    started.closeControlChannel();
    await expect(started.waitForExit(2_000)).resolves.toBe(true);
  });

  it("names its start failure distinctly from a launcher protocol failure", () => {
    const error = new LinuxModuleLauncherStartError("no launcher");
    expect(error.name).toBe("LinuxModuleLauncherStartError");
  });
});
