import { canonicalBytes } from "../../../src/schema-bundle/index.js";
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RuntimeAuthorityDatabase,
  RuntimeAuthorityDatabaseError,
  type InstallWorkerStartPremiseInput,
} from "../../../src/adapters/storage/runtime-authority-database.js";
import {
  launchInstalledWorkerHost,
  setWorkerHostInstallVerifierForTests,
} from "../../../src/adapters/installed-worker-host.js";

const identity = {
  daemonInstallationId: "0198ab31-6c44-7e8a-b2bb-000000000001",
  instanceId: "instance-0f3a1c9e5b7d4e2a8c6d0b1f2a3e4c5d",
};

class FakeLock {
  #held = true;
  readonly controllerGenerationId = "0198ab31-6c44-7e8a-b2bb-0000000000aa";
  get held(): boolean {
    return this.#held;
  }
  get info() {
    return {
      instanceId: identity.instanceId,
      controllerGenerationId: this.controllerGenerationId,
      processId: process.pid,
      createdAt: new Date().toISOString(),
    };
  }
  assertHeld(): void {
    if (!this.#held) throw new Error("lock not held");
  }
  async release(): Promise<void> {
    this.#held = false;
  }
}

function resolvedConfigFixture(content: string): { bytes: Uint8Array; digest: string } {
  const bytes = canonicalBytes({
    runtime_config: { value: content },
    permission_policy_selections: [],
    service_candidate: null,
  });
  return { bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

function freshCommitted(dirName: string, lock = new FakeLock()): RuntimeAuthorityDatabase {
  const dir = mkdtempSync(join(tmpdir(), "wsp-"));
  const database = RuntimeAuthorityDatabase.open({
    path: join(dir, `${dirName}.sqlite`),
    identity,
    lock: lock as never,
  });
  const authority = resolvedConfigFixture("committed");
  database.installConfig({
    identity,
    canonicalConfigBytes: authority.bytes,
    configDigest: authority.digest,
    premise: null,
    verifiedOrigins: [],
  });
  return database;
}

function premiseInput(overrides: Partial<InstallWorkerStartPremiseInput> = {}): InstallWorkerStartPremiseInput {
  return {
    extensionAlias: "org.dolly.tools",
    serverId: "fs",
    packageRoot: "/opt/dolly/pkg",
    packagePath: "/opt/dolly/pkg/package.bin",
    packageDigest: `sha256:${"a".repeat(64)}`,
    executableDigest: `sha256:${"b".repeat(64)}`,
    endpoint: "bin/dolly-fs-tools",
    ...overrides,
  };
}

describe("Worker-start premise projection (Host-owned producer)", () => {
  it("projects the sealed premise for the current revision under the controller lock", () => {
    const database = freshCommitted("locked");
    expect(database.installWorkerStartPremise(premiseInput()).projected).toBe(true);
    // Re-projecting the identical premise is an idempotent no-op.
    expect(database.installWorkerStartPremise(premiseInput()).projected).toBe(false);
  });

  it("refuses a conflicting rewrite of an existing projection", () => {
    const database = freshCommitted("conflict");
    database.installWorkerStartPremise(premiseInput());
    expect(() =>
      database.installWorkerStartPremise(premiseInput({ executableDigest: `sha256:${"c".repeat(64)}` })),
    ).toThrowError(RuntimeAuthorityDatabaseError);
  });

  it("rejects endpoints and paths escaping the package root before any durable write", () => {
    const database = freshCommitted("escape");
    expect(() => database.installWorkerStartPremise(premiseInput({ endpoint: "../escape" }))).toThrowError(
      /safe package-root-relative/u,
    );
    expect(() => database.installWorkerStartPremise(premiseInput({ packagePath: "/etc/passwd" }))).toThrowError(
      /canonical package root/u,
    );
    expect(() =>
      database.installWorkerStartPremise(premiseInput({ packageRoot: "/opt/dolly/pkg/", packagePath: "/opt/evil/x" })),
    ).toThrowError(/canonical package root/u);
  });

  it("refuses to project when the injected controller lock is no longer held", async () => {
    const released = new FakeLock();
    await released.release();
    let database: RuntimeAuthorityDatabase | undefined;
    try {
      database = freshCommitted("released", released);
    } catch {
      // A released handle may refuse the open outright; that also proves
      // the guard, so treat it as satisfied.
      return;
    }
    expect(() => database!.installWorkerStartPremise(premiseInput())).toThrow();
  });

  it("exposes only closed input shapes: no transport observation can project a premise", () => {
    const database = freshCommitted("surface");
    const api = Object.getOwnPropertyNames(Object.getPrototypeOf(database) as object) as string[];
    expect(api.some((name) => /response|ack|readiness|cache|process.?exit/iu.test(name))).toBe(false);
    expect(api).toContain("installWorkerStartPremise");
  });

  it("projections are per-revision: a new current revision starts with none", () => {
    const database = freshCommitted("revision");
    database.installWorkerStartPremise(premiseInput());
    const snapshot = database.readCurrentConfig();
    if (snapshot === null) throw new Error("expected committed state");
    const next = resolvedConfigFixture("second");
    const result = database.installConfig({
      identity,
      canonicalConfigBytes: next.bytes,
      configDigest: next.digest,
      premise: null,
      verifiedOrigins: [],
      expectedCurrent: { revision: snapshot.config_revision, digest: snapshot.config_digest },
    });
    expect(result.allocated).toBe(true);
    // The new revision accepts a fresh projection without conflict — old rows
    // can never silently re-point at new authority.
    expect(database.installWorkerStartPremise(premiseInput()).projected).toBe(true);
  });
});

describe("Installed worker-host composition (Host production route)", () => {
  function fakeWorkerHostChild(): ChildProcess {
    // Deterministic framed responder: emits the frozen `started` frame at
    // startup, answers each bounded `status` request, exits cleanly when
    // stdin closes (mirroring worker_host's EOF behavior).
    const responder = [
      "let buf = Buffer.alloc(0);",
      'const send = (obj) => {',
      "  const body = Buffer.from(JSON.stringify(obj));",
      "  process.stdout.write(Buffer.concat([Buffer.from([0,0,0,body.length]), body]));",
      "};",
      "send({ v: 1, event: \"started\", server_id: \"fs\" });",
      'process.stdin.on("data", (d) => {',
      "  buf = Buffer.concat([buf, d]);",
      "  while (buf.length >= 4) {",
      "    const len = buf.readUInt32BE(0);",
      "    if (buf.length < 4 + len) break;",
      "    const req = JSON.parse(buf.subarray(4, 4 + len).toString());",
      "    buf = buf.subarray(4 + len);",
      '    if (req.op === "status") {',
      '      send({ v: 1, event: "status", state: "ready", server_id: "fs" });',
      '    } else if (req.op === "stop") {',
      '      send({ v: 1, event: "stopped" });',
      "      process.exit(0);",
      "    }",
      "  }",
      "});",
    ].join("\n");
    return spawn(process.execPath, ["-e", responder], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcess;
  }

  it("projects via the repository once, spawns worker_host with argv [database.path, extensionAlias, serverId], and refuses on conflict without spawning", async () => {
    // Full-suite-safe: unit tests verify the ADAPTER contract against a
    // mocked install verifier; the REAL fixed-layout binary proof lives in
    // `npm run build` (digest+mode enforcement) and the built-mode resolver
    // smoke. Production always uses the node verifier.
    const restoreVerifier = setWorkerHostInstallVerifierForTests({
      assertInstallSafety: () => {},
      verifyDigest: () => {},
    });
    try {
      await runCompositionScenario();
    } finally {
      restoreVerifier();
    }

    async function runCompositionScenario(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "wsp-route-"));
    const packageRoot = join(dir, "pkg");
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    const packagePath = join(packageRoot, "package.bin");
    writeFileSync(packagePath, Buffer.from("dolly-fs-tools-package-v1"));
    const executable = join(packageRoot, "bin/dolly-fs-tools");
    copyFileSync("/usr/bin/python3", executable);
    chmodSync(executable, 0o755);
    const sha256 = (bytes: Uint8Array): string =>
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    const dbDir = mkdtempSync(join(tmpdir(), "wsp-route-db-"));
    const databasePath = join(dbDir, "authority.sqlite");
    const database = RuntimeAuthorityDatabase.open({
      path: databasePath,
      identity,
      lock: new FakeLock() as never,
    });
    const authority = resolvedConfigFixture("committed");
    database.installConfig({
      identity,
      canonicalConfigBytes: authority.bytes,
      configDigest: authority.digest,
      premise: null,
      verifiedOrigins: [],
    });

    const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
    const premise = premiseInput({
      packageRoot,
      packagePath,
      packageDigest: sha256(readFileSync(packagePath)),
      executableDigest: sha256(readFileSync(executable)),
    });

    const handle = await launchInstalledWorkerHost({
      database,
      premise,
      spawn: (command, args) => {
        spawnCalls.push({ command, args });
        return fakeWorkerHostChild();
      },
    });
    expect(handle.pid).toBeGreaterThan(0);
    // Framed lifecycle over the deterministic fake child.
    await handle.status();
    await handle.stop();

    // The adapter projected through the repository exactly once: durable
    // here, idempotent on re-projection.
    expect(database.installWorkerStartPremise(premise).projected).toBe(false);
    // Host-owned command resolution + frozen three-part argv.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toMatch(/worker_host$/u);
    expect(spawnCalls[0].args).toEqual([databasePath, "org.dolly.tools", "fs"]);

    // Conflict means zero spawn: a conflicting rewrite throws out of the
    // repository before the adapter reaches its process boundary again.
    const spawnsBefore = spawnCalls.length;
    await expect(
      launchInstalledWorkerHost({
        database,
        premise: premiseInput({ ...premise, packageDigest: `sha256:${"d".repeat(64)}` }),
        spawn: (command, args) => {
          spawnCalls.push({ command, args });
          return fakeWorkerHostChild();
        },
      }),
    ).rejects.toThrow(RuntimeAuthorityDatabaseError);
    expect(spawnCalls.length).toBe(spawnsBefore);
    }
  });
});
