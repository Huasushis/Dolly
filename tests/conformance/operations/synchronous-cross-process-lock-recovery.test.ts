import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import {
  InstanceConfigStore,
  type InstanceConfigSchema,
} from "../../../src/core/instance-config-store.js";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import {
  SynchronousCrossProcessLockError,
  withSynchronousCrossProcessLock,
} from "../../../src/core/synchronous-cross-process-lock.js";

const NOW = "2026-07-25T00:00:00.000Z";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

interface TestConfig extends Readonly<Record<string, JsonValue>> {
  readonly schemaVersion: "test.instance/1";
  readonly instanceId: string;
  readonly stateDirectory: null;
}

const configSchema: InstanceConfigSchema<TestConfig> = {
  schemaVersion: "test.instance/1",
  validate: (value) => value as TestConfig,
  instanceId: (value) => value.instanceId,
  stateDirectory: () => undefined,
  withInstanceId: (value, instanceId) => ({ ...value, instanceId }),
  redact: (value) => value,
};

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error("cross-process lock child readiness timed out")),
      10_000,
    );
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
      rejectReady(new Error(`cross-process lock child exited before readiness (${code})`));
    });
  });
}

describe("synchronous cross-process lock crash recovery", () => {
  let root: string;
  const children = new Set<ChildProcessWithoutNullStreams>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-sync-kernel-lock-"));
  });

  afterEach(async () => {
    for (const child of children) {
      child.kill("SIGKILL");
      if (child.exitCode === null) await once(child, "exit");
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function holdInChild(resourceId: string): Promise<ChildProcessWithoutNullStreams> {
    const fixture = resolve(
      "tests/conformance/operations/fixtures/synchronous-cross-process-lock-child.ts",
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", fixture, resourceId],
      { stdio: "pipe" },
    );
    children.add(child);
    await waitForReady(child);
    return child;
  }

  async function killHolder(child: ChildProcessWithoutNullStreams): Promise<void> {
    child.kill("SIGKILL");
    await once(child, "exit");
    children.delete(child);
  }

  it("rejects a live competing process and acquires immediately after forced termination", async () => {
    const resourceId = join(root, "direct.lock");
    const child = await holdInChild(resourceId);

    expect(() => withSynchronousCrossProcessLock({ resourceId }, () => undefined)).toThrowError(
      expect.objectContaining<Partial<SynchronousCrossProcessLockError>>({
        code: "CROSS_PROCESS_LOCK_HELD",
      }),
    );
    await killHolder(child);
    expect(withSynchronousCrossProcessLock({ resourceId }, () => "successor")).toBe("successor");
  });

  it("does not mistake an old crash-residue marker file for live ownership", () => {
    const resourceId = join(root, "legacy.lock");
    writeFileSync(resourceId, "legacy wx lock residue", { mode: 0o600 });

    expect(withSynchronousCrossProcessLock({ resourceId }, () => "recovered")).toBe("recovered");
  });

  it("unblocks all three durable store lock domains after a lock-owner crash", async () => {
    const corePath = join(root, "core.json");
    const openCore = () => new FileCoreStateStore({
      path: corePath,
      maxFailedAttempts: 3,
      nextBlockId: () => "block-1",
      nextDeliveryId: (kind) => `${kind}-1`,
      now: () => NOW,
    });
    openCore();

    const moduleResultCommitPath = join(root, "module-result-commits.json");
    new FileModuleResultCommitRepository({ path: moduleResultCommitPath });

    const project = join(root, "project");
    mkdirSync(project);
    const configPath = join(project, "dolly.json");
    const configStore = new InstanceConfigStore({
      schema: configSchema,
      registryDirectory: join(root, "registry"),
      defaultStateRoot: join(root, "instances"),
      nextInstanceId: () => INSTANCE_ID,
      now: () => NOW,
    });
    configStore.initialize(configPath, (instanceId) => ({
      schemaVersion: "test.instance/1",
      instanceId,
      stateDirectory: null,
    }));
    const canonicalConfigPath = realpathSync.native(configPath);
    const configIdentity = `config:${
      process.platform === "win32"
        ? canonicalConfigPath.toLowerCase()
        : canonicalConfigPath
    }`;
    const configLockName = createHash("sha256")
      .update(configIdentity, "utf8")
      .digest("hex");

    const scenarios = [
      {
        resourceId: `${corePath}.lock`,
        attempt: openCore,
        code: "CORE_STATE_LOCKED",
      },
      {
        resourceId: `${moduleResultCommitPath}.lock`,
        attempt: () => new FileModuleResultCommitRepository({ path: moduleResultCommitPath }),
        code: "MODULE_RESULT_COMMIT_LOCKED",
      },
      {
        resourceId: join(root, "registry", "locks", `${configLockName}.lock`),
        attempt: () => configStore.claim(configPath),
        code: "CONFIG_LOCKED",
      },
    ] as const;

    for (const scenario of scenarios) {
      const child = await holdInChild(scenario.resourceId);
      expect(scenario.attempt).toThrowError(
        expect.objectContaining({ code: scenario.code }),
      );
      await killHolder(child);
      expect(scenario.attempt).not.toThrow();
    }
  });
});
