import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstanceControllerLock } from "../../../src/core/instance-controller-lock.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_CONTROLLER = "22222222-2222-4222-8222-222222222222";
const SECOND_CONTROLLER = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-07-24T12:00:00.000Z";

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("lock child readiness timed out")), 10_000);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("READY\n")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`lock child exited before readiness (${code})`));
    });
  });
}

describe("instance controller kernel lock", () => {
  let root: string;
  const children = new Set<ChildProcessWithoutNullStreams>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-controller-lock-"));
  });

  afterEach(async () => {
    for (const child of children) {
      child.kill("SIGKILL");
      if (child.exitCode === null) await once(child, "exit");
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("holds one instance exclusively and permits a clean later owner", async () => {
    const first = await InstanceControllerLock.acquire({
      directory: root,
      instanceId: INSTANCE_ID,
      controllerId: FIRST_CONTROLLER,
      processId: 101,
      now: () => NOW,
    });

    await expect(InstanceControllerLock.acquire({
      directory: root,
      instanceId: INSTANCE_ID,
      controllerId: SECOND_CONTROLLER,
      processId: 202,
      now: () => NOW,
    })).rejects.toMatchObject({
      code: "CONTROLLER_LOCK_HELD",
    });

    await first.release();
    expect(first.held).toBe(false);
    await expect(first.release()).resolves.toBeUndefined();

    const second = await InstanceControllerLock.acquire({
      directory: root,
      instanceId: INSTANCE_ID,
      controllerId: SECOND_CONTROLLER,
      processId: 202,
      now: () => NOW,
    });
    expect(second.held).toBe(true);
    await second.release();
  });

  it("namespaces identical instance IDs by canonical registry directory", async () => {
    const first = await InstanceControllerLock.acquire({
      directory: join(root, "registry-a"),
      instanceId: INSTANCE_ID,
      controllerId: FIRST_CONTROLLER,
      now: () => NOW,
    });
    const second = await InstanceControllerLock.acquire({
      directory: join(root, "registry-b"),
      instanceId: INSTANCE_ID,
      controllerId: SECOND_CONTROLLER,
      now: () => NOW,
    });
    expect(first.held).toBe(true);
    expect(second.held).toBe(true);
    await first.release();
    await second.release();
  });

  it("releases ownership automatically when the controller process is killed", async () => {
    const fixture = resolve(
      "tests/conformance/operations/fixtures/controller-lock-child.ts",
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", fixture, root, INSTANCE_ID, FIRST_CONTROLLER, NOW],
      { stdio: "pipe" },
    );
    children.add(child);
    await waitForReady(child);

    await expect(InstanceControllerLock.acquire({
      directory: root,
      instanceId: INSTANCE_ID,
      controllerId: SECOND_CONTROLLER,
      now: () => NOW,
    })).rejects.toMatchObject({
      code: "CONTROLLER_LOCK_HELD",
    });

    child.kill("SIGKILL");
    await once(child, "exit");
    children.delete(child);

    const successor = await InstanceControllerLock.acquire({
      directory: root,
      instanceId: INSTANCE_ID,
      controllerId: SECOND_CONTROLLER,
      now: () => NOW,
    });
    expect(successor.held).toBe(true);
    await successor.release();
  });
});
