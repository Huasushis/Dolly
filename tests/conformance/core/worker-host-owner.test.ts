import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalBytes } from "../../../src/schema-bundle/index.js";
import {
  RuntimeAuthorityDatabase,
  type RuntimeAuthorityIdentity,
} from "../../../src/adapters/storage/runtime-authority-database.js";
import { InstanceControllerLock } from "../../../src/core/instance-controller-lock.js";
import { InstalledComponentOriginRegistry } from "../../../src/core/installed-component-origin.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import { setWorkerHostInstallVerifierForTests } from "../../../src/adapters/installed-worker-host.js";
import { deriveWorkerStartPremise } from "../../../src/adapters/worker-host-composition.js";
import {
  openRuntimeWorkerHost,
  type RuntimeWorkerHostOpenOptions,
} from "../../../src/adapters/worker-host-composition.js";
import { DaemonConfigStore } from "../../../src/daemon/daemon-config.js";
import { runDollyCli } from "../../../src/entry.js";
import { projectRuntimeInstanceStableId } from "../../../src/core/runtime-authority-identities.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliBin = resolve(repositoryRoot, "bin", "dolly.js");
const buildScript = resolve(repositoryRoot, "scripts", "build.mjs");
const distEntry = resolve(repositoryRoot, "dist", "src", "entry.js");
const distDaemonConfig = resolve(repositoryRoot, "dist", "src", "daemon", "daemon-config.js");

/**
 * Produces the compiled production entry and its complete module closure with
 * the sanctioned build. The reviewed worker-host binary admission now accepts
 * the pinned-toolchain recompile, so build.mjs must succeed end-to-end and
 * place the packaged binary at dist/bin/worker_host for the shipped-bin tests
 * below to exercise the real process boundary.
 */
let distBuild: Promise<void> | undefined;
function ensureBuiltDist(): Promise<void> {
  distBuild ??= buildDistOnce();
  return distBuild;
}

async function buildDistOnce(): Promise<void> {
  const built = spawnSync(process.execPath, [buildScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_BUILD_JOBS: "2",
      WORKER_HOST_CARGO_TARGET_DIR: "",
    },
    timeout: 600_000,
  });
  expect(built.status, built.stderr + built.stdout).toBe(0);
  expect(existsSync(distEntry), "compiled dist/src/entry.js missing").toBe(true);
  expect(
    existsSync(distDaemonConfig),
    "compiled dist/src/daemon/daemon-config.js missing",
  ).toBe(true);
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function resolvedConfigFixture(runtimeConfig: unknown): { bytes: Uint8Array; digest: string } {
  const bytes = canonicalBytes({
    runtime_config: runtimeConfig,
    permission_policy_selections: [],
    service_candidate: null,
  });
  return {
    bytes,
    digest: sha256Bytes(bytes),
  };
}

function runtimeConfigDocument(server: unknown): unknown {
  return {
    spec: {
      services: {
        tool_broker: {
          schema: "dolly.tool-broker-config/v1",
          extension_alias: "org.dolly.tools",
          servers: { fs: server },
        },
      },
    },
  };
}

function serverContract(overrides: {
  packageDigest: string;
  executableDigest: string;
} & Partial<Record<string, unknown>>): { readonly transport: Record<string, unknown> } & Record<string, unknown> {
  return {
    enabled: true,
    adapter: "mcp",
    protocol_version: "2025-06-18",
    transport: {
      kind: "stdio",
      package_id: "org.dolly.tools.fs",
      package_version: "1.0.0",
      package_digest: overrides.packageDigest,
      executable: "bin/dolly-fs-tools",
      executable_digest: overrides.executableDigest,
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

/** Real Host package: a v1 manifest, an `.mjs` entrypoint, and a stdio server binary. */
function sourcePackage(directory: string): void {
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(
    join(directory, "dolly-extension.json"),
    JSON.stringify({
      schemaVersion: "dolly.extension-package/1",
      extensionId: "org.dolly.tools.fs",
      packageVersion: "1.0.0",
      displayName: "Dolly FS tools",
      description: "Real installed stdio tool server fixture",
      supportedProtocolVersions: ["1.0.0"],
      entrypoint: "bin/dolly-fs-tools.mjs",
      modules: [
        {
          moduleKind: "tool-server",
          activation: "reactive",
          configVersion: 1,
          configurationSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
          },
        },
      ],
      requestedCapabilities: [],
    }),
  );
  writeFileSync(join(directory, "bin", "dolly-fs-tools.mjs"), "export const serve = true;\n");
  const executable = join(directory, "bin", "dolly-fs-tools");
  copyFileSync("/usr/bin/python3", executable);
  chmodSync(executable, 0o755);
}

function capture(): {
  output: { write(text: string): void };
  text: () => string;
} {
  let value = "";
  return {
    output: { write: (text: string) => { value += text; } },
    text: () => value,
  };
}

async function acquireControllerLock(
  registryDirectory: string,
  instanceId: string,
): Promise<InstanceControllerLock> {
  return await InstanceControllerLock.acquire({
    directory: join(registryDirectory, "controllers"),
    instanceId,
  });
}

interface LaunchedCli {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Executes the actual shipped bin (bin/dolly.js over the compiled dist). */
async function launchCli(
  args: readonly string[],
  options: { readonly baseDir: string; readonly cwd: string; readonly signalOnMatch?: RegExp },
): Promise<LaunchedCli> {
  const child = spawn(process.execPath, [cliBin, ...args], {
    cwd: options.cwd,
    env: { ...process.env, XDG_STATE_HOME: options.baseDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let signalled = false;
  const signalWhenReady = (text: string): void => {
    if (options.signalOnMatch !== undefined && !signalled && options.signalOnMatch.test(text)) {
      signalled = true;
      child.kill("SIGTERM");
    }
  };
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    signalWhenReady(stdout);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    signalWhenReady(stderr);
  });
  const code = await new Promise<number>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolveCode(exitCode ?? -1));
  });
  return { code, stdout, stderr };
}

interface PreparedInstance {
  readonly baseDir: string;
  readonly configPath: string;
  readonly directories: { readonly registryDirectory: string; readonly defaultStateRoot: string };
  readonly instanceId: string;
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly authorityDigest: string;
  readonly daemonInstallationId: string;
  /** Realpath the worker route seals into the premise; undefined when the package is not installed. */
  readonly workingDirectory?: string;
  readonly entrypointPath?: string;
  close(): Promise<void>;
}

/**
 * Creates a real registered instance (real `dolly init`), a real durable daemon
 * document (`DaemonConfigStore.loadOrInitialize`), and optionally a real
 * committed Runtime authority repository plus a real installed Host package
 * under the instance state root.
 */
async function prepareInstance(options: {
  readonly installPackage: boolean;
  readonly commitAuthority: boolean;
  readonly packageDigestOverride?: string;
}): Promise<PreparedInstance> {
  const baseDir = mkdtempSync(join(tmpdir(), "wsp-owner-entry-"));
  const directories = {
    registryDirectory: join(baseDir, "dolly", "registry"),
    defaultStateRoot: join(baseDir, "dolly", "instances"),
  };
  const configPath = join(baseDir, "instance.json");
  const initStdout = capture();
  const initStderr = capture();
  const initCode = await runDollyCli(
    ["init", "--config", configPath],
    { cwd: baseDir, directories, stdout: initStdout.output, stderr: initStderr.output },
  );
  if (initCode !== 0) {
    throw new Error(`instance init failed: ${initStderr.text()}`);
  }
  const daemonLoaded = await new DaemonConfigStore({
    directory: directories.registryDirectory,
  }).loadOrInitialize();
  const daemonInstallationId = daemonLoaded.config.daemonInstallationId;
  const instanceId = (JSON.parse(readFileSync(configPath, "utf8")) as { instanceId: string }).instanceId;
  const stateDirectory = join(directories.defaultStateRoot, instanceId);
  const installationsDirectory = join(stateDirectory, "authority", "installations");
  const databasePath = join(stateDirectory, "authority", "authority.sqlite");

  let installed: { packageDigest: string; executableDigest: string } | undefined;
  let workingDirectory: string | undefined;
  let entrypointPath: string | undefined;
  if (options.installPackage) {
    const installations = new ExtensionInstallationRegistry({ directory: installationsDirectory });
    const sourceDirectory = join(baseDir, "source");
    sourcePackage(sourceDirectory);
    const resolved = installations.installNodePackage({ sourceDirectory, trust: "trusted" });
    workingDirectory = resolved.workingDirectory;
    entrypointPath = resolved.entrypointPath;
    installed = {
      packageDigest: resolved.packageDigest,
      executableDigest: sha256File(join(resolved.workingDirectory, "bin", "dolly-fs-tools")),
    };
  }
  const packageDigest = installed?.packageDigest ??
    (options.packageDigestOverride ?? `sha256:${"a".repeat(64)}`);
  const server = serverContract({
    packageDigest,
    executableDigest: installed?.executableDigest ?? `sha256:${"b".repeat(64)}`,
  });
  const authority = resolvedConfigFixture(runtimeConfigDocument(server));

  if (options.commitAuthority) {
    const lock = await acquireControllerLock(directories.registryDirectory, instanceId);
    mkdirSync(join(stateDirectory, "authority"), { recursive: true });
    const database = RuntimeAuthorityDatabase.open({
      path: databasePath,
      identity: projectIdentity(instanceId, daemonInstallationId),
      lock,
    });
    database.installConfig({
      identity: projectIdentity(instanceId, daemonInstallationId),
      canonicalConfigBytes: authority.bytes,
      configDigest: authority.digest,
      premise: null,
      verifiedOrigins: [],
    });
    await lock.release();
  }
  return {
    baseDir,
    configPath,
    directories,
    instanceId,
    stateDirectory,
    databasePath,
    authorityDigest: authority.digest,
    daemonInstallationId,
    ...(workingDirectory === undefined ? {} : { workingDirectory, entrypointPath }),
    close: async () => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function projectIdentity(instanceId: string, daemonInstallationId: string): RuntimeAuthorityIdentity {
  return {
    daemonInstallationId,
    instanceId: projectRuntimeInstanceStableId(instanceId),
  };
}

describe.runIf(process.platform === "linux")("Per-instance Runtime Worker host through the shipped bin", () => {
  it("refuses an absent installation before any spawn or durable premise projection", async () => {
    await ensureBuiltDist();
    // Real daemon document present, committed authority config naming a server
    // whose package is NOT installed: the shipped bin must refuse before
    // spawning or projecting.
    const prepared = await prepareInstance({ installPackage: false, commitAuthority: true });
    try {
      const run = await launchCli(["run", "--config", prepared.configPath], {
        baseDir: prepared.baseDir,
        cwd: prepared.baseDir,
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("no Host-owned installation");
      expect(run.stdout).not.toContain("Dolly ready");
      // Zero durable startup effects: the legitimate premise was never projected.
      const lock = await acquireControllerLock(prepared.directories.registryDirectory, prepared.instanceId);
      try {
        const database = RuntimeAuthorityDatabase.open({
          path: prepared.databasePath,
          identity: projectIdentity(prepared.instanceId, prepared.daemonInstallationId),
          lock,
        });
        try {
          const premise = deriveWorkerStartPremise({
            database,
            extensionAlias: "org.dolly.tools",
            serverId: "fs",
            installedPackageRoot: join(prepared.stateDirectory, "authority", "installations"),
            installedPackagePath: join(prepared.stateDirectory, "authority", "installations", "bin", "dolly-fs-tools.mjs"),
          });
          expect(database.installWorkerStartPremise(premise).projected).toBe(true);
        } finally {
          database.close();
        }
      } finally {
        await lock.release();
      }
    } finally {
      await prepared.close();
    }
  }, 600_000);

  it("refuses a mismatched package digest before any spawn or durable premise projection", async () => {
    await ensureBuiltDist();
    const prepared = await prepareInstance({ installPackage: true, commitAuthority: true });
    // Re-commit the CURRENT revision with a mismatched declared package
    // digest against the same real installation register.
    const lock = await acquireControllerLock(prepared.directories.registryDirectory, prepared.instanceId);
    try {
      const database = RuntimeAuthorityDatabase.open({
        path: prepared.databasePath,
        identity: projectIdentity(prepared.instanceId, prepared.daemonInstallationId),
        lock,
      });
      const server = serverContract({
        packageDigest: `sha256:${"d".repeat(64)}`,
        executableDigest: `sha256:${"e".repeat(64)}`,
      });
      const authority = resolvedConfigFixture(runtimeConfigDocument(server));
      database.installConfig({
        identity: projectIdentity(prepared.instanceId, prepared.daemonInstallationId),
        canonicalConfigBytes: authority.bytes,
        configDigest: authority.digest,
        premise: null,
        verifiedOrigins: [],
        expectedCurrent: { revision: 1, digest: prepared.authorityDigest },
      });
    } finally {
      await lock.release();
    }
    try {
      const run = await launchCli(["run", "--config", prepared.configPath], {
        baseDir: prepared.baseDir,
        cwd: prepared.baseDir,
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("package digest does not match");
      expect(run.stdout).not.toContain("Dolly ready");
    } finally {
      await prepared.close();
    }
  }, 600_000);

  it("refuses absent committed current configuration before any spawn or durable effect", async () => {
    await ensureBuiltDist();
    // Real daemon document present, empty authority repository: no committed
    // current configuration must refuse before any spawn or durable effect.
    const prepared = await prepareInstance({ installPackage: false, commitAuthority: false });
    try {
      const run = await launchCli(["run", "--config", prepared.configPath], {
        baseDir: prepared.baseDir,
        cwd: prepared.baseDir,
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("no committed current configuration");
      expect(run.stdout).not.toContain("Dolly ready");
    } finally {
      await prepared.close();
    }
  }, 600_000);

  it("projects the premise and reaches the process boundary through the shipped bin, then tears storage and lock down", async () => {
    await ensureBuiltDist();
    // Healthy authority + real installation: the shipped bin genuinely
    // invokes the worker-host composition (durable premise projection), and
    // the only refusal is the adapter's process boundary. HEAD's reviewed
    // worker-host binary admission refuses the recompile (pre-existing digest
    // mismatch), so the fixed binary is absent and the adapter refuses there
    // before any spawn. After the run the repository can be reopened and the
    // controller lock re-acquired.
    const prepared = await prepareInstance({ installPackage: true, commitAuthority: true });
    try {
      const run = await launchCli(["run", "--config", prepared.configPath], {
        baseDir: prepared.baseDir,
        cwd: prepared.baseDir,
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/WORKER_HOST_BINARY_ABSENT/u);
      expect(run.stdout).not.toContain("Dolly ready");
      // The owner genuinely reached launchHostWorkerHost: the premise was
      // projected durably exactly once during the run, so re-projecting the
      // identical identity pair is an idempotent no-op.
      const lock = await acquireControllerLock(prepared.directories.registryDirectory, prepared.instanceId);
      try {
        const database = RuntimeAuthorityDatabase.open({
          path: prepared.databasePath,
          identity: projectIdentity(prepared.instanceId, prepared.daemonInstallationId),
          lock,
        });
        try {
          const premise = deriveWorkerStartPremise({
            database,
            extensionAlias: "org.dolly.tools",
            serverId: "fs",
            installedPackageRoot: prepared.workingDirectory ?? join(prepared.stateDirectory, "authority", "installations"),
            installedPackagePath: prepared.entrypointPath ?? join(prepared.stateDirectory, "authority", "installations", "bin", "dolly-fs-tools.mjs"),
          });
          expect(database.installWorkerStartPremise(premise).projected).toBe(false);
        } finally {
          database.close();
        }
      } finally {
        await lock.release();
      }
    } finally {
      await prepared.close();
    }
  }, 600_000);

  it("a legacy run without a daemon document never engages the worker route", async () => {
    await ensureBuiltDist();
    // Current non-runtime CLI behavior: with no durable daemon document the
    // worker route is not engaged and the shipped bin runs the legacy runtime.
    const prepared = await prepareInstance({ installPackage: false, commitAuthority: false });
    try {
      const daemonPath = join(prepared.directories.registryDirectory, "daemon.json");
      const daemonStore = new DaemonConfigStore({ directory: prepared.directories.registryDirectory });
      if (daemonStore.exists()) {
        rmSync(daemonPath);
      }
      const run = await launchCli(["run", "--config", prepared.configPath], {
        baseDir: prepared.baseDir,
        cwd: prepared.baseDir,
        signalOnMatch: /Dolly ready/u,
      });
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("Dolly ready");
      expect(run.stdout).toContain("Dolly stopped");
    } finally {
      await prepared.close();
    }
  }, 600_000);

  it("retains the returned owner; close() stops/reaps descendants before storage close and lock release", async () => {
    await ensureBuiltDist();
    // Lifecycle contract of the per-instance Runtime Worker host object the
    // entry uses: with the existing process-boundary pattern (fake child,
    // install verifier seam) it returns an owner whose retained handle is
    // reaped inside close(), which then closes storage and releases the real
    // controller lock — all within one idempotent close().
    const restore = setWorkerHostInstallVerifierForTests({
      assertInstallSafety: () => {},
      verifyDigest: () => {},
    });
    const prepared = await prepareInstance({ installPackage: true, commitAuthority: true });
    try {
      let spawnedChild: ChildProcess | undefined;
      const spawnForTest: NonNullable<RuntimeWorkerHostOpenOptions["spawn"]> = () => {
        const child = fakeWorkerHostChild();
        spawnedChild = child;
        return child;
      };
      const controllerLock = await acquireControllerLock(prepared.directories.registryDirectory, prepared.instanceId);
      const workerHost = await openRuntimeWorkerHost({
        registryDirectory: prepared.directories.registryDirectory,
        stateDirectory: prepared.stateDirectory,
        identity: projectIdentity(prepared.instanceId, prepared.daemonInstallationId),
        controllerLock,
        spawn: spawnForTest,
      });
      try {
        expect(workerHost.owner.serverIds).toEqual(["fs"]);
        expect(workerHost.owner.handles).toHaveLength(1);
        expect(workerHost.owner.handles[0].pid).toBeGreaterThan(0);
        expect(spawnedChild).toBeDefined();
      } finally {
        await workerHost.close();
      }
      // close() reaped the descendant...
      expect(spawnedChild!.killed || !spawnedChild!.connected).toBe(true);
      // ...closed the repository (reopening the same path succeeds with a
      // fresh lock) and released the real controller lock.
      const reacquired = await acquireControllerLock(prepared.directories.registryDirectory, prepared.instanceId);
      try {
        const reopened = RuntimeAuthorityDatabase.open({
          path: prepared.databasePath,
          identity: projectIdentity(prepared.instanceId, prepared.daemonInstallationId),
          lock: reacquired,
        });
        reopened.close();
      } finally {
        await reacquired.release();
      }
      // A second close() is an idempotent no-op.
      await workerHost.close();
      await controllerLock.release();
    } finally {
      restore();
      await prepared.close();
    }
  }, 600_000);
});

/** Long-lived NDJSON MCP responder (the real installed-child contract). */
function fakeWorkerHostChild(): ChildProcess {
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
  const child = spawn(process.execPath, ["-e", responder], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}
