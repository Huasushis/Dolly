/**
 * The legacy daemon entry (`daemon/index.ts`) is the only daemon composition
 * that starts itself on import and performs the four durable mutations named
 * in the platform-preflight audit: it writes the daemon configuration, the
 * instance registry, the PID file, and the Unix-domain socket. An unsupported
 * host (win32 or darwin) MUST refuse with a stable typed outcome before any of
 * those mutations, while Linux keeps its existing behavior.
 *
 * The refusal is observed through the existing host-owned platform seam in
 * `src/core/host-platform.ts`, the same zero-argument adapter the Linux Module
 * activation and Core service binding gates route through. Defaulting the mock
 * to the real platform keeps Linux CI on the supported path; only the refusal
 * cases override it, so the gate is provable on Linux without exposing platform
 * as caller-controlled configuration.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const platformMock = vi.hoisted(() => ({
  observe: vi.fn<() => NodeJS.Platform>(() => process.platform),
}));

vi.mock("../../../src/core/host-platform.js", () => ({
  observeHostPlatform: platformMock.observe,
}));

const daemonCwd = mkdtempSync(join(tmpdir(), "dolly-daemon-platform-"));
const originalCwd = process.cwd();

beforeAll(() => {
  process.chdir(daemonCwd);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(daemonCwd, { recursive: true, force: true });
});

beforeEach(() => {
  // The daemon starts itself at module top level, so each platform case must
  // re-evaluate the entry rather than reuse a cached module export.
  vi.resetModules();
});

describe("daemon entry refuses unsupported host before durable mutation", () => {
  it.each(["win32", "darwin"] as const)(
    "refuses to start on %s before writing config, registry, pid, or socket",
    async (platform) => {
      platformMock.observe.mockReturnValueOnce(platform);

      await expect(import("../../../daemon/index.js")).rejects.toMatchObject({
        code: "DAEMON_PLATFORM_UNSUPPORTED",
      });

      // No durable mutation may precede the refusal: the daemon directory,
      // configuration, registry, and PID file must not exist.
      const daemonDir = join(daemonCwd, ".dolly", "daemon");
      expect(existsSync(daemonDir)).toBe(false);
      expect(existsSync(join(daemonDir, "config.json"))).toBe(false);
      expect(existsSync(join(daemonDir, "registry.json"))).toBe(false);
      expect(existsSync(join(daemonDir, "pid"))).toBe(false);
    },
  );
});
