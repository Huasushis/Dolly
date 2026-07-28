/**
 * The Core-state migration is an explicit operator command, not an automatic
 * startup step. Reading a `dolly.core-state/15` document fails closed with
 * `CORE_STATE_MIGRATION_REQUIRED`, so without this command a version 15
 * deployment has no supported way forward.
 *
 * These tests fix three properties: the command describes itself and changes
 * nothing without an explicit confirmation, it refuses to run while an
 * instance holds its controller lock, and it keeps the original bytes.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest, type JsonValue } from "../../../src/core/canonical-json.js";
import { runDollyCli } from "../../../src/entry.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { InstanceControllerLock } from "../../../src/core/instance-controller-lock.js";

class Capture {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

describe("dolly migrate-core-state", () => {
  let root: string;
  let cwd: string;
  let registryDirectory: string;
  let defaultStateRoot: string;
  let configPath: string;

  async function initializeInstance(): Promise<{ instanceId: string; statePath: string }> {
    const stdout = new Capture();
    const code = await runDollyCli(["init", "--config", configPath, "--name", "Test"], {
      cwd,
      stdout,
      stderr: new Capture(),
      directories: { registryDirectory, defaultStateRoot },
    });
    expect(code).toBe(0);
    const instanceId = /Initialized Dolly instance (\S+)/.exec(stdout.text)?.[1] ?? "";
    const stateDirectory = /State: (.+)/.exec(stdout.text)?.[1]?.trim() ?? "";
    expect(instanceId).not.toBe("");
    return { instanceId, statePath: join(stateDirectory, "core-state.json") };
  }

  /** Creates the version 16 document a fresh instance would, then rewrites it as 15. */
  function writeVersion15Document(statePath: string): string {
    new FileCoreStateStore({
      path: statePath,
      maxFailedAttempts: 3,
      nextBlockId: () => "block-1",
      nextDeliveryId: (kind) => `${kind}-1`,
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const current = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, JsonValue>;
    delete current.schemaVersion;
    delete current.stateDigest;
    delete current.moduleProcessRecords;
    delete current.moduleSubmissionRecords;
    const legacy = {
      schemaVersion: "dolly.core-state/15",
      stateDigest: canonicalJsonDigest(current),
      ...current,
    };
    const raw = `${JSON.stringify(legacy)}\n`;
    writeFileSync(statePath, raw, "utf8");
    return raw;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-migrate-command-"));
    cwd = join(root, "work");
    mkdirSync(cwd);
    registryDirectory = join(root, "registry");
    defaultStateRoot = join(root, "instances");
    configPath = join(cwd, "dolly.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("describes the migration and changes nothing without an explicit confirmation", async () => {
    const { statePath } = await initializeInstance();
    const before = writeVersion15Document(statePath);
    const stdout = new Capture();

    const code = await runDollyCli(["migrate-core-state", "--config", configPath], {
      cwd,
      stdout,
      stderr: new Capture(),
      directories: { registryDirectory, defaultStateRoot },
    });

    expect(code).toBe(0);
    expect(stdout.text).toContain("Re-run with --confirm");
    // The refusal that follows a migration is stated up front rather than
    // discovered by an operator at the next start.
    expect(stdout.text).toContain("STARTUP_ACTIVE_CLAIM_UNRESOLVED");
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("migrates a stopped instance and keeps the original bytes", async () => {
    const { statePath } = await initializeInstance();
    const before = writeVersion15Document(statePath);
    const stdout = new Capture();

    const code = await runDollyCli(
      ["migrate-core-state", "--config", configPath, "--confirm"],
      {
        cwd,
        stdout,
        stderr: new Capture(),
        directories: { registryDirectory, defaultStateRoot },
      },
    );

    expect(code).toBe(0);
    expect(stdout.text).toContain("dolly.core-state/16");
    expect(readFileSync(`${statePath}.v15.backup`, "utf8")).toBe(before);
    const migrated = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, JsonValue>;
    expect(migrated.schemaVersion).toBe("dolly.core-state/16");
    expect(migrated.moduleProcessRecords).toEqual([]);
    expect(migrated.moduleSubmissionRecords).toEqual([]);
  });

  it("reports an already current document without touching it", async () => {
    const { statePath } = await initializeInstance();
    new FileCoreStateStore({
      path: statePath,
      maxFailedAttempts: 3,
      nextBlockId: () => "block-1",
      nextDeliveryId: (kind) => `${kind}-1`,
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const before = readFileSync(statePath, "utf8");
    const stdout = new Capture();

    const code = await runDollyCli(
      ["migrate-core-state", "--config", configPath, "--confirm"],
      {
        cwd,
        stdout,
        stderr: new Capture(),
        directories: { registryDirectory, defaultStateRoot },
      },
    );

    expect(code).toBe(0);
    expect(stdout.text).toContain("already schema version 16");
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses to migrate while an instance holds the controller lock", async () => {
    const { instanceId, statePath } = await initializeInstance();
    const before = writeVersion15Document(statePath);
    const lock = await InstanceControllerLock.acquire({
      directory: join(registryDirectory, "controllers"),
      instanceId,
    });
    const stderr = new Capture();
    try {
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
      expect(stderr.text).toContain("error [");
      expect(readFileSync(statePath, "utf8")).toBe(before);
    } finally {
      await lock.release();
    }
  });
});
