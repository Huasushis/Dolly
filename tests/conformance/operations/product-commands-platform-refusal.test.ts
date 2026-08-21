/**
 * The two product startup commands (`dolly run` and
 * `dolly migrate-core-state --confirm`) begin their durable work by acquiring
 * the instance controller lock, so the controller lock's platform preflight is
 * the single minimal reachable boundary that keeps both commands fail-closed on
 * an unsupported host. An unsupported host (win32 or darwin) MUST refuse with a
 * typed outcome before creating the controller namespace, claiming the
 * configuration, opening Core state, subscribing to configuration, or creating
 * a durable process record — while Linux keeps its existing behavior.
 *
 * The refusal path is exercised through the same trusted host-owned platform
 * seam (`src/core/host-platform.ts`) that the daemon, Linux Module activation,
 * and Core service binding gates use. The mock defaults to the real platform so
 * Linux CI stays on the supported path; only the refusal cases override it, so
 * no caller-configurable platform override is introduced.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformMock = vi.hoisted(() => ({
  observe: vi.fn<() => NodeJS.Platform>(() => process.platform),
}));

vi.mock("../../../src/core/host-platform.js", () => ({
  observeHostPlatform: platformMock.observe,
}));

import { runDollyCli } from "../../../src/entry.js";
import { openDollyRuntime } from "../../../src/core/runtime-bootstrap.js";

class Capture {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

describe("product commands refuse unsupported host before durable mutation", () => {
  let root: string;
  let cwd: string;
  let registryDirectory: string;
  let defaultStateRoot: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-product-command-preflight-"));
    cwd = join(root, "work");
    mkdirSync(cwd);
    registryDirectory = join(root, "registry");
    defaultStateRoot = join(root, "instances");
    configPath = join(cwd, "dolly.json");
    platformMock.observe.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  async function initializeInstance(): Promise<string> {
    const stdout = new Capture();
    const code = await runDollyCli(["init", "--config", configPath, "--name", "Test"], {
      cwd,
      stdout,
      stderr: new Capture(),
      directories: { registryDirectory, defaultStateRoot },
    });
    expect(code).toBe(0);
    const instanceId = /Initialized Dolly instance (\S+)/.exec(stdout.text)?.[1] ?? "";
    expect(instanceId).not.toBe("");
    return instanceId;
  }

  it.each(["win32", "darwin"] as const)(
    "openDollyRuntime refuses on %s before controller lock, claim, or Core state",
    async (platform) => {
      await initializeInstance();
      const controllersDirectory = join(registryDirectory, "controllers");

      platformMock.observe.mockReturnValueOnce(platform);

      await expect(
        openDollyRuntime({
          configPath,
          registryDirectory,
          defaultStateRoot,
        }),
      ).rejects.toMatchObject({ code: "CONTROLLER_LOCK_PLATFORM_UNSUPPORTED" });

      expect(existsSync(controllersDirectory)).toBe(false);
    },
  );

  it.each(["win32", "darwin"] as const)(
    "dolly run refuses on %s with a typed CLI outcome before durable mutation",
    async (platform) => {
      await initializeInstance();
      const controllersDirectory = join(registryDirectory, "controllers");
      const stderr = new Capture();

      platformMock.observe.mockReturnValueOnce(platform);
      const code = await runDollyCli(["run", "--config", configPath], {
        cwd,
        stdout: new Capture(),
        stderr,
        directories: { registryDirectory, defaultStateRoot },
        waitForShutdown: async () => {},
      });

      expect(code).not.toBe(0);
      expect(stderr.text).toContain("error [CONTROLLER_LOCK_PLATFORM_UNSUPPORTED]");
      expect(existsSync(controllersDirectory)).toBe(false);
    },
  );

  it.each(["win32", "darwin"] as const)(
    "dolly migrate-core-state --confirm refuses on %s before migration",
    async (platform) => {
      await initializeInstance();
      const controllersDirectory = join(registryDirectory, "controllers");
      const stderr = new Capture();

      platformMock.observe.mockReturnValueOnce(platform);
      const code = await runDollyCli(
        ["migrate-core-state", "--config", configPath, "--confirm"],
        {
          cwd,
          stdout: new Capture(),
          stderr,
          directories: { registryDirectory, defaultStateRoot },
        },
      );

      expect(code).not.toBe(0);
      expect(stderr.text).toContain("error [CONTROLLER_LOCK_PLATFORM_UNSUPPORTED]");
      expect(existsSync(controllersDirectory)).toBe(false);
    },
  );
});
