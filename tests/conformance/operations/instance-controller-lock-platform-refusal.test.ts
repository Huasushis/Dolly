/**
 * The instance controller lock is the first durable step of both product
 * startup commands (`dolly run` and `dolly migrate-core-state --confirm`), so
 * its platform preflight is the minimal reachable boundary that keeps those
 * commands fail-closed. An unsupported host (win32 or darwin) MUST refuse with
 * the typed `CONTROLLER_LOCK_PLATFORM_UNSUPPORTED` outcome before creating the
 * controller namespace (the `mkdirSync` inside `canonicalDirectory`) and
 * before `listen`, while Linux keeps its existing behavior.
 *
 * The refusal is observed through the existing host-owned platform seam in
 * `src/core/host-platform.ts`, the same zero-argument adapter the daemon,
 * Linux Module activation, and Core service binding gates route through.
 * Defaulting the mock to the real platform keeps Linux CI on the supported
 * path; only the refusal cases override it, so the gate is provable on Linux
 * without exposing platform as caller-controlled configuration.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformMock = vi.hoisted(() => ({
  observe: vi.fn<() => NodeJS.Platform>(() => process.platform),
}));

vi.mock("../../../src/core/host-platform.js", () => ({
  observeHostPlatform: platformMock.observe,
}));

import { InstanceControllerLock } from "../../../src/core/instance-controller-lock.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-07-24T12:00:00.000Z";

describe("instance controller lock platform preflight", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-controller-lock-preflight-"));
    platformMock.observe.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["win32", "darwin"] as const)(
    "refuses to acquire on %s before creating the controller namespace",
    async (platform) => {
      platformMock.observe.mockReturnValueOnce(platform);
      const controllersDirectory = join(root, "registry", "controllers");

      await expect(
        InstanceControllerLock.acquire({
          directory: controllersDirectory,
          instanceId: INSTANCE_ID,
          now: () => NOW,
        }),
      ).rejects.toMatchObject({
        code: "CONTROLLER_LOCK_PLATFORM_UNSUPPORTED",
      });

      expect(existsSync(controllersDirectory)).toBe(false);
    },
  );

  it("does not carry a dead Windows endpoint or a Windows support claim", async () => {
    // The acquire preflight refuses every non-Linux host, so a Windows
    // named-pipe endpoint is unreachable. A surviving Windows support
    // message would contradict that refusal and be untruthful. This guards
    // the boundary text, not Linux behavior.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../../../src/core/instance-controller-lock.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("currently supported on Linux and Windows");
    expect(source).not.toContain("\\\\.\\\\pipe\\\\dolly-controller");
    expect(source).toContain("CONTROLLER_LOCK_PLATFORM_UNSUPPORTED");
  });
});
