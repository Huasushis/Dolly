/**
 * The Core-state migration is an explicit operator command, not an automatic
 * startup step. Reading an older document fails closed with
 * `CORE_STATE_MIGRATION_REQUIRED`, so the command must preserve and report the
 * exact validated source version rather than assuming one.
 *
 * These tests fix the authority boundary as well as the bytes: confirmation
 * acquires the controller lock, reclaims the same configuration revision, uses
 * its state-size limit, releases the lock, and only then reports success.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest, type JsonValue } from "../../../src/core/canonical-json.js";
import { runDollyCli } from "../../../src/entry.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileMediaByteStore } from "../../../src/core/file-media-byte-store.js";
import { InstanceControllerLock } from "../../../src/core/instance-controller-lock.js";

class Capture {
  text = "";
  constructor(private readonly observe?: (chunk: string) => void) {}
  write(chunk: string): boolean {
    this.observe?.(chunk);
    this.text += chunk;
    return true;
  }
}

type LegacyCoreStateVersion = "15" | "16";
type JsonObject = Record<string, JsonValue>;

const MEDIA_LIMITS = Object.freeze({
  maxMediaBytes: 1024,
  maxTotalMediaBytes: 4096,
  maxRegistrationRecords: 12,
  maxStorageRecords: 13,
  maxProviderAccessRecords: 14,
  deletedRegistrationRetentionMs: 60_000,
});

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

  /** Creates a current document, then rewrites it as one validated older version. */
  function writeLegacyDocument(
    statePath: string,
    version: LegacyCoreStateVersion,
    options: { readonly mediaIdNamespace?: string } = {},
  ): string {
    new FileCoreStateStore({
      path: statePath,
      maxFailedAttempts: 3,
      nextBlockId: () => "block-1",
      nextDeliveryId: (kind) => `${kind}-1`,
      now: () => "2026-07-26T00:00:00.000Z",
      ...(options.mediaIdNamespace === undefined
        ? {}
        : {
            media: {
              durability: "persistent" as const,
              bytes: new FileMediaByteStore({
                directory: join(dirname(statePath), "media-bytes"),
                maxMediaBytes: MEDIA_LIMITS.maxMediaBytes,
              }),
              inspector: {
                inspect: async () => ({
                  mimeType: "image/png",
                  width: 1,
                  height: 1,
                }),
              },
              ...MEDIA_LIMITS,
              idNamespace: options.mediaIdNamespace,
            },
          }),
    });
    const current = JSON.parse(readFileSync(statePath, "utf8")) as JsonObject;
    const commonPayload: JsonObject = {
      revision: current.revision!,
      referenceGraph: current.referenceGraph!,
      ...(current.media === undefined ? {} : { media: current.media }),
      blocks: current.blocks!,
      deliveries: current.deliveries!,
    };
    const payload: JsonObject =
      version === "15"
        ? commonPayload
        : {
            ...commonPayload,
            moduleProcessRecords: current.moduleProcessRecords!,
            moduleSubmissionRecords: current.moduleSubmissionRecords!,
          };
    const legacy: JsonObject = {
      schemaVersion: `dolly.core-state/${version}`,
      stateDigest: canonicalJsonDigest(payload),
      ...payload,
    };
    const raw = `${JSON.stringify(legacy)}\n`;
    writeFileSync(statePath, raw, "utf8");
    return raw;
  }

  function rewriteConfiguration(
    replace: (document: JsonObject) => void,
  ): void {
    const document = JSON.parse(readFileSync(configPath, "utf8")) as JsonObject;
    replace(document);
    writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
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
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("describes the migration and changes nothing without an explicit confirmation", async () => {
    const { statePath } = await initializeInstance();
    const before = writeLegacyDocument(statePath, "15");
    const stdout = new Capture();

    const code = await runDollyCli(["migrate-core-state", "--config", configPath], {
      cwd,
      stdout,
      stderr: new Capture(),
      directories: { registryDirectory, defaultStateRoot },
    });

    expect(code).toBe(0);
    expect(stdout.text).toContain("Re-run with --confirm");
    expect(stdout.text).toContain("chosen from the validated source schema");
    expect(stdout.text).not.toContain(".v15.backup");
    expect(stdout.text).not.toContain(".v16.backup");
    // The refusal that follows a migration is stated up front rather than
    // discovered by an operator at the next start.
    expect(stdout.text).toContain("STARTUP_ACTIVE_CLAIM_UNRESOLVED");
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it.each<LegacyCoreStateVersion>(["15", "16"])(
    "migrates a stopped version %s instance and reports the exact backup",
    async (version) => {
      const { statePath } = await initializeInstance();
      const before = writeLegacyDocument(statePath, version);
      const stdout = new Capture();
      const stderr = new Capture();

      const code = await runDollyCli(
        ["migrate-core-state", "--config", configPath, "--confirm"],
        {
          cwd,
          stdout,
          stderr,
          directories: { registryDirectory, defaultStateRoot },
        },
      );

      const backupPath = `${statePath}.v${version}.backup`;
      expect(code, stderr.text).toBe(0);
      expect(stdout.text).toContain(
        `from dolly.core-state/${version} to dolly.core-state/17`,
      );
      expect(stdout.text).toContain(`Backup:   ${backupPath}`);
      expect(readFileSync(backupPath, "utf8")).toBe(before);
      const migrated = JSON.parse(readFileSync(statePath, "utf8")) as JsonObject;
      expect(migrated.schemaVersion).toBe("dolly.core-state/17");
      expect(migrated.moduleProcessRecords).toEqual([]);
      expect(migrated.moduleSubmissionRecords).toEqual([]);
      expect(migrated.activeClaimsWithUnknownSubmissionHistory).toEqual([]);
    },
  );

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
    expect(stdout.text).toContain("already dolly.core-state/17");
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses to migrate while an instance holds the controller lock", async () => {
    const { instanceId, statePath } = await initializeInstance();
    const before = writeLegacyDocument(statePath, "15");
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

  it("rejects a configuration revision change while controller-lock acquisition is pending", async () => {
    const { instanceId, statePath } = await initializeInstance();
    const before = writeLegacyDocument(statePath, "16");
    const stdout = new Capture();
    const stderr = new Capture();

    const running = runDollyCli(
      ["migrate-core-state", "--config", configPath, "--confirm"],
      {
        cwd,
        stdout,
        stderr,
        directories: { registryDirectory, defaultStateRoot },
      },
    );
    // `InstanceControllerLock.acquire` has already been called but its listen
    // callback cannot run until this synchronous configuration write completes.
    rewriteConfiguration((document) => {
      document.displayName = "Changed during controller-lock acquisition";
    });

    expect(await running).toBe(1);
    expect(stderr.text).toContain("error [CONFIG_REVISION_CONFLICT]");
    expect(stdout.text).not.toContain("Migrated ");
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(() => readFileSync(`${statePath}.v16.backup`, "utf8")).toThrow();

    // The rejected command still releases the controller lock.
    const nextLock = await InstanceControllerLock.acquire({
      directory: join(registryDirectory, "controllers"),
      instanceId,
    });
    await nextLock.release();
  });

  it("rejects an instance identity change that keeps the same state directory", async () => {
    const { statePath } = await initializeInstance();
    const before = writeLegacyDocument(statePath, "15");
    const stateDirectory = dirname(statePath);
    rewriteConfiguration((document) => {
      document.stateDirectory = stateDirectory;
    });
    const stdout = new Capture();
    const stderr = new Capture();

    const running = runDollyCli(
      ["migrate-core-state", "--config", configPath, "--confirm"],
      {
        cwd,
        stdout,
        stderr,
        directories: { registryDirectory, defaultStateRoot },
      },
    );
    rewriteConfiguration((document) => {
      document.instanceId = "11111111-1111-4111-8111-111111111111";
    });

    expect(await running).toBe(1);
    expect(stderr.text).toContain("error [CONFIG_INSTANCE_ID_CHANGED]");
    expect(stdout.text).not.toContain("Migrated ");
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(() => readFileSync(`${statePath}.v15.backup`, "utf8")).toThrow();
  });

  it("uses the claimed configuration byte limit and exposes Core-state errors", async () => {
    const { statePath } = await initializeInstance();
    const source = writeLegacyDocument(statePath, "15");
    const oversizedSource = `${source.trimEnd()}${" ".repeat(2048)}\n`;
    writeFileSync(statePath, oversizedSource, "utf8");
    rewriteConfiguration((document) => {
      const core = document.core as JsonObject;
      const limits = core.limits as JsonObject;
      limits.maxStateBytes = 1024;
    });
    const stderr = new Capture();

    const code = await runDollyCli(
      ["migrate-core-state", "--config", configPath, "--confirm"],
      {
        cwd,
        stdout: new Capture(),
        stderr,
        directories: { registryDirectory, defaultStateRoot },
      },
    );

    expect(code).toBe(1);
    expect(stderr.text).toContain("error [CORE_STATE_LIMIT_EXCEEDED]");
    expect(stderr.text).not.toContain("CLI_INTERNAL_ERROR");
    expect(readFileSync(statePath, "utf8")).toBe(oversizedSource);
    expect(() => readFileSync(`${statePath}.v15.backup`, "utf8")).toThrow();
  });

  it("rejects an older snapshot whose failure limit differs from the claimed configuration", async () => {
    const { statePath } = await initializeInstance();
    const source = writeLegacyDocument(statePath, "16");
    rewriteConfiguration((document) => {
      const core = document.core as JsonObject;
      const limits = core.limits as JsonObject;
      limits.maxFailedAttempts = 4;
    });
    const stdout = new Capture();
    const stderr = new Capture();

    const code = await runDollyCli(
      ["migrate-core-state", "--config", configPath, "--confirm"],
      {
        cwd,
        stdout,
        stderr,
        directories: { registryDirectory, defaultStateRoot },
      },
    );

    expect(code).toBe(1);
    expect(stderr.text).toContain("error [CORE_STATE_DOCUMENT_INVALID]");
    expect(stdout.text).not.toContain("Migrated ");
    expect(readFileSync(statePath, "utf8")).toBe(source);
    expect(() => readFileSync(`${statePath}.v16.backup`, "utf8")).toThrow();
  });

  it("validates a Media snapshot with the claimed instance identity and limits", async () => {
    const { instanceId, statePath } = await initializeInstance();
    const source = writeLegacyDocument(statePath, "16", {
      mediaIdNamespace: instanceId,
    });
    rewriteConfiguration((document) => {
      const core = document.core as JsonObject;
      core.media = {
        enabled: true,
        ...MEDIA_LIMITS,
        ingress: {
          maxActiveCapabilities: 10,
          maxConcurrentOperations: 2,
          maxCapabilityLifetimeMs: 60_000,
        },
      };
    });
    const stdout = new Capture();
    const stderr = new Capture();

    const code = await runDollyCli(
      ["migrate-core-state", "--config", configPath, "--confirm"],
      {
        cwd,
        stdout,
        stderr,
        directories: { registryDirectory, defaultStateRoot },
      },
    );

    expect(code, stderr.text).toBe(0);
    expect(stdout.text).toContain(
      "from dolly.core-state/16 to dolly.core-state/17",
    );
    expect(readFileSync(`${statePath}.v16.backup`, "utf8")).toBe(source);
  });

  it("rejects a Media snapshot when the claimed configuration disables Media", async () => {
    const { instanceId, statePath } = await initializeInstance();
    const source = writeLegacyDocument(statePath, "16", {
      mediaIdNamespace: instanceId,
    });
    const stdout = new Capture();
    const stderr = new Capture();

    const code = await runDollyCli(
      ["migrate-core-state", "--config", configPath, "--confirm"],
      {
        cwd,
        stdout,
        stderr,
        directories: { registryDirectory, defaultStateRoot },
      },
    );

    expect(code).toBe(1);
    expect(stderr.text).toContain("error [CORE_STATE_DOCUMENT_INVALID]");
    expect(stdout.text).not.toContain("Migrated ");
    expect(readFileSync(statePath, "utf8")).toBe(source);
    expect(() => readFileSync(`${statePath}.v16.backup`, "utf8")).toThrow();
  });

  it("prints migration success only after the controller lock is released", async () => {
    const { statePath } = await initializeInstance();
    writeLegacyDocument(statePath, "15");
    let releaseCompleted = false;
    let successObservedAfterRelease = false;
    const originalRelease = InstanceControllerLock.prototype.release;
    vi.spyOn(InstanceControllerLock.prototype, "release").mockImplementation(
      async function (this: InstanceControllerLock): Promise<void> {
        await originalRelease.call(this);
        releaseCompleted = true;
      },
    );
    const stdout = new Capture((chunk) => {
      if (chunk.startsWith("Migrated ")) {
        successObservedAfterRelease = releaseCompleted;
      }
    });
    const stderr = new Capture();

    const code = await runDollyCli(
      ["migrate-core-state", "--config", configPath, "--confirm"],
      {
        cwd,
        stdout,
        stderr,
        directories: { registryDirectory, defaultStateRoot },
      },
    );

    expect(code, stderr.text).toBe(0);
    expect(releaseCompleted).toBe(true);
    expect(successObservedAfterRelease).toBe(true);
  });
});
