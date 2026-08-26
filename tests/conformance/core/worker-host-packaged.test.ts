import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalBytes } from "../../../src/schema-bundle/index.js";
import {
  deriveWorkerStartPremise,
  launchHostWorkerHost,
} from "../../../src/adapters/worker-host-composition.js";
	import {
		InstallWorkerStartPremiseInput,
		RuntimeAuthorityDatabase,
		RuntimeAuthorityDatabaseError,
		type RuntimeAuthorityIdentity,
	} from "../../../src/adapters/storage/runtime-authority-database.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packagedBinary = join(repositoryRoot, "dist", "bin", "worker_host");
const packagedBinaryPresent = existsSync(packagedBinary);

const identity: RuntimeAuthorityIdentity = {
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

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function resolvedConfigFixture(runtimeConfig: unknown): { bytes: Uint8Array; digest: string } {
  const bytes = canonicalBytes({
    runtime_config: runtimeConfig,
    permission_policy_selections: [],
    service_candidate: null,
  });
  return {
    bytes,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

/** Long-lived NDJSON MCP responder (the real installed-child contract). */
const MCP_RESPONDER = `
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    method = obj.get("method")
    rid = obj.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid,
              "result": {"protocolVersion": "2025-06-18",
                         "capabilities": {},
                         "serverInfo": {"name": "dolly-fs-tools", "version": "1.0.0"}}})
`.trim();

function installInstalledServer(packageRoot: string): {
  packageDigest: string;
  executableDigest: string;
  packagePath: string;
} {
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  const packagePath = join(packageRoot, "package.bin");
  writeFileSync(packagePath, Buffer.from("dolly-fs-tools-package-v1"));
  writeFileSync(join(packageRoot, "server.py"), Buffer.from(MCP_RESPONDER));
  const executablePath = join(packageRoot, "bin", "dolly-fs-tools");
  copyFileSync("/usr/bin/python3", executablePath);
  chmodSync(executablePath, 0o755);
  return {
    packageDigest: sha256File(packagePath),
    executableDigest: sha256File(executablePath),
    packagePath,
  };
}

function serverContract(packageDigest: string, executableDigest: string): unknown {
  return {
    enabled: true,
    adapter: "mcp",
    protocol_version: "2025-06-18",
    transport: {
      kind: "stdio",
      package_id: "org.dolly.tools.fs",
      package_version: "1.0.0",
      package_digest: packageDigest,
      executable: "bin/dolly-fs-tools",
      executable_digest: executableDigest,
      args: ["server.py"],
      secret_bindings: {},
    },
    allowed_modules: ["module-a"],
    limits: {
      startup_timeout_ms: 10_000,
      request_timeout_ms: 30_000,
      max_concurrency: 4,
      max_request_bytes: 1_048_576,
      max_response_bytes: 4_194_304,
    },
    tools: {},
  };
}

function runtimeConfigDocument(server: unknown): unknown {
  return {
    spec: {
      services: {
        tool_broker: {
          schema: "dolly.tool-broker-config/v1",
          servers: { fs: server },
        },
      },
    },
  };
}

function freshCommittedFixture(): {
  directory: string;
  databasePath: string;
  packageRoot: string;
  packagePath: string;
  packageDigest: string;
  database: RuntimeAuthorityDatabase;
} {
  const directory = mkdtempSync(join(tmpdir(), "wsp-packaged-"));
  const packageRoot = join(directory, "pkg");
  const installed = installInstalledServer(packageRoot);
  const server = serverContract(installed.packageDigest, installed.executableDigest);
  const authority = resolvedConfigFixture(runtimeConfigDocument(server));
  const databasePath = join(directory, "authority.sqlite");
  const database = RuntimeAuthorityDatabase.open({
    path: databasePath,
    identity,
    lock: new FakeLock() as never,
  });
  database.installConfig({
    identity,
    canonicalConfigBytes: authority.bytes,
    configDigest: authority.digest,
    premise: null,
    verifiedOrigins: [],
  });
  return {
    directory,
    databasePath,
    packageRoot,
    packagePath: installed.packagePath,
    packageDigest: installed.packageDigest,
    database,
  };
}


		type PremiseFixture = {
			database: RuntimeAuthorityDatabase;
			packageRoot: string;
			packagePath: string;
		};
		function premiseFor(fixture: PremiseFixture): InstallWorkerStartPremiseInput {
  return deriveWorkerStartPremise({
    database: fixture.database,
    extensionAlias: "org.dolly.tools",
    serverId: "fs",
    installedPackageRoot: fixture.packageRoot,
    installedPackagePath: fixture.packagePath,
  });
}

/** Collect the complete stderr text of a child process. */
function collectStderr(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    child.stderr!.on("error", reject);
    child.once("close", () => resolve(text));
  });
}

describe.runIf(packagedBinaryPresent)("Packaged worker_host binary (production binary proof)", () => {
  it("derives, projects, and launches the packaged binary through the Host-owned composition (success route)", async () => {
    if (process.platform !== "linux") return;
    const fixture = freshCommittedFixture();
    try {
      // The production Host-owner composition derives the sealed premise
      // from the current authority snapshot, projects it, and spawns the
      // packaged binary through the adapter with the real install verifier
      // (reviewed digest + fixed-layout mode/owner checks) and real spawn.
      // The binary consumes the premise through every startup gate; only the
      // live Linux Host proof is environment-dependent, so a healthy
      // non-Host database must refuse with a typed diagnostic there and can
      // never reach a started frame within this bounded environment.
      await expect(
        launchHostWorkerHost({
          database: fixture.database,
          extensionAlias: "org.dolly.tools",
          serverId: "fs",
          installedPackageRoot: fixture.packageRoot,
          installedPackagePath: fixture.packagePath,
        }),
      ).rejects.toThrow(/WORKER_START_REFUSED/u);
      // The producer projected exactly once through the repository.
      expect(fixture.database.installWorkerStartPremise(premiseFor(fixture)).projected).toBe(false);
    } finally {
      fixture.database.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("refuses a tampered installed package before any started frame (hostile refusal)", async () => {
    if (process.platform !== "linux") return;
    const fixture = freshCommittedFixture();
    writeFileSync(fixture.packagePath, Buffer.from("dolly-fs-tools-package-v1-TAMPERED"));
    try {
      await expect(
        launchHostWorkerHost({
          database: fixture.database,
          extensionAlias: "org.dolly.tools",
          serverId: "fs",
          installedPackageRoot: fixture.packageRoot,
          installedPackagePath: fixture.packagePath,
        }),
      ).rejects.toThrow(/WORKER_START_REFUSED/u);
    } finally {
      fixture.database.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("refuses a conflicting premise rewrite without spawning (hostile refusal)", async () => {
    if (process.platform !== "linux") return;
    const fixture = freshCommittedFixture();
    try {
      fixture.database.installWorkerStartPremise(premiseFor(fixture));
      const secondRoot = join(fixture.directory, "pkg2");
      const second = installInstalledServer(secondRoot);
      await expect(
        launchHostWorkerHost({
          database: fixture.database,
          extensionAlias: "org.dolly.tools",
          serverId: "fs",
          installedPackageRoot: secondRoot,
          installedPackagePath: second.packagePath,
        }),
      ).rejects.toThrow(RuntimeAuthorityDatabaseError);
    } finally {
      fixture.database.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("consumes a healthy TS-produced premise through every startup gate and refuses only at the live-Host boundary with zero stdout frames", async () => {
    if (process.platform !== "linux") return;
    const fixture = freshCommittedFixture();
    fixture.database.installWorkerStartPremise(premiseFor(fixture));
    fixture.database.close();
    const child = spawn(
      packagedBinary,
      [fixture.databasePath, "org.dolly.tools", "fs"],
      { stdio: ["pipe", "pipe", "pipe"], env: {} },
    );
    const stderrPromise = collectStderr(child);
    let stdoutText = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutText += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    const stderrText = await stderrPromise;
    expect(exitCode).not.toBe(0);
    expect(stderrText).toMatch(/WORKER_START_REFUSED/u);
    // The typed refusal names the out-of-scope live Linux Host proof
    // boundary, proving every earlier gate — read-only preflight, the single
    // writable Host-authority open, journal/ledger installation, durable
    // premise binding, spawn-args/limits/transport equality — accepted the
    // TS-produced database and premise before that boundary.
    expect(stderrText).toContain("live Linux Host proof refused");
    expect(stdoutText).toBe("");
    rmSync(fixture.directory, { recursive: true, force: true });
  });
});
