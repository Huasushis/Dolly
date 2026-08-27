import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  runDollyCli,
  type DollyCliContext,
} from "../../../src/entry.js";
import { projectRuntimeInstanceStableId } from "../../../src/core/runtime-authority-identities.js";

const identity: RuntimeAuthorityIdentity = {
  daemonInstallationId: "0198ab31-6c44-7e8a-b2bb-000000000002",
  instanceId: "placeholder",
};

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

function runtimeIdentityFor(instanceId: string): RuntimeAuthorityIdentity {
  return {
    daemonInstallationId: identity.daemonInstallationId,
    instanceId: projectRuntimeInstanceStableId(instanceId),
  };
}

interface PreparedInstance {
  readonly root: string;
  readonly configPath: string;
  readonly directories: { readonly registryDirectory: string; readonly defaultStateRoot: string };
  readonly instanceId: string;
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly authorityDigest: string;
  /** Realpath the worker route seals into the premise; undefined when the package is not installed. */
  readonly workingDirectory?: string;
  readonly entrypointPath?: string;
  close(): Promise<void>;
}

/**
 * Creates a real registered instance (entry `init`), then optionally commits a
 * real Runtime authority repository under the instance state root and installs
 * a real Host package into the Runtime Worker's installation register.
 */
async function prepareInstance(options: {
  readonly installPackage: boolean;
  readonly commitAuthority: boolean;
}): Promise<PreparedInstance> {
  const root = mkdtempSync(join(tmpdir(), "wsp-owner-entry-"));
  const directories = {
    registryDirectory: join(root, "registry"),
    defaultStateRoot: join(root, "instances"),
  };
  const configPath = join(root, "instance.json");
  const initStdout = capture();
  const initStderr = capture();
  const initCode = await runDollyCli(
    ["init", "--config", configPath],
    { cwd: root, directories, stdout: initStdout.output, stderr: initStderr.output },
  );
  if (initCode !== 0) {
    throw new Error(`instance init failed: ${initStderr.text()}`);
  }
  const instanceId = (JSON.parse(readFileSync(configPath, "utf8")) as { instanceId: string }).instanceId;
  const stateDirectory = join(directories.defaultStateRoot, instanceId);
  const installationsDirectory = join(stateDirectory, "authority", "installations");
  const databasePath = join(stateDirectory, "authority", "authority.sqlite");

  let installed: { packageDigest: string; executableDigest: string } | undefined;
  let workingDirectory: string | undefined;
  let entrypointPath: string | undefined;
  if (options.installPackage) {
    const installations = new ExtensionInstallationRegistry({ directory: installationsDirectory });
    const sourceDirectory = join(root, "source");
    sourcePackage(sourceDirectory);
    const resolved = installations.installNodePackage({ sourceDirectory, trust: "trusted" });
    workingDirectory = resolved.workingDirectory;
    entrypointPath = resolved.entrypointPath;
    installed = {
      packageDigest: resolved.packageDigest,
      executableDigest: sha256File(join(resolved.workingDirectory, "bin", "dolly-fs-tools")),
    };
  }
  const server = serverContract({
    packageDigest: installed?.packageDigest ?? `sha256:${"a".repeat(64)}`,
    executableDigest: installed?.executableDigest ?? `sha256:${"b".repeat(64)}`,
  });
  const authority = resolvedConfigFixture(runtimeConfigDocument(server));

  if (options.commitAuthority) {
    const lock = await acquireControllerLock(directories.registryDirectory, instanceId);
    mkdirSync(join(stateDirectory, "authority"), { recursive: true });
    const database = RuntimeAuthorityDatabase.open({
      path: databasePath,
      identity: runtimeIdentityFor(instanceId),
      lock,
    });
    database.installConfig({
      identity: runtimeIdentityFor(instanceId),
      canonicalConfigBytes: authority.bytes,
      configDigest: authority.digest,
      premise: null,
      verifiedOrigins: [],
    });
    await lock.release();
  }
  return {
    root,
    configPath,
    directories,
    instanceId,
    stateDirectory,
    databasePath,
    authorityDigest: authority.digest,
    ...(workingDirectory === undefined ? {} : { workingDirectory, entrypointPath }),
    close: async () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function runContext(
  prepared: PreparedInstance,
  overrides: DollyCliContext = {},
): { value: DollyCliContext; stdout: { text(): string }; stderr: { text(): string } } {
  const stdout = capture();
  const stderr = capture();
  return {
    value: {
      cwd: prepared.root,
      directories: prepared.directories,
      stdout: stdout.output,
      stderr: stderr.output,
      runtimeWorker: {
        daemonInstallationId: identity.daemonInstallationId,
        extensionAlias: "org.dolly.tools",
      },
      waitForShutdown: async () => undefined,
      ...overrides,
    },
    stdout,
    stderr,
  };
}

describe.runIf(process.platform === "linux")("Per-instance Runtime Worker host through the real run entry", () => {
  it("refuses an absent installation before any spawn or durable premise projection", async () => {
    // A registered instance with a committed authority config naming a server
    // whose package is NOT installed: the engaged worker route must refuse
    // through the real `dolly run` entry before spawning or projecting.
    const prepared = await prepareInstance({ installPackage: false, commitAuthority: true });
    try {
      const { value, stdout, stderr } = runContext(prepared);
      const code = await runDollyCli(["run", "--config", prepared.configPath], value);
      expect(code).toBe(1);
      expect(stderr.text()).toContain("no Host-owned installation");
      expect(stdout.text()).not.toContain("Dolly ready");
      // Zero durable startup effects: the legitimate premise was never projected.
      const lock = await acquireControllerLock(prepared.directories.registryDirectory, prepared.instanceId);
      try {
        const database = RuntimeAuthorityDatabase.open({
          path: prepared.databasePath,
          identity: runtimeIdentityFor(prepared.instanceId),
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
  });

  it("refuses a mismatched package digest before any spawn or durable premise projection", async () => {
    const prepared = await prepareInstance({ installPackage: true, commitAuthority: true });
    // Re-commit the CURRENT revision with a mismatched declared package
    // digest against the same real installation register.
    const lock = await acquireControllerLock(prepared.directories.registryDirectory, prepared.instanceId);
    try {
      const database = RuntimeAuthorityDatabase.open({
        path: prepared.databasePath,
        identity: runtimeIdentityFor(prepared.instanceId),
        lock,
      });
      const server = serverContract({
        packageDigest: `sha256:${"d".repeat(64)}`,
        executableDigest: `sha256:${"e".repeat(64)}`,
      });
      const authority = resolvedConfigFixture(runtimeConfigDocument(server));
      database.installConfig({
        identity: runtimeIdentityFor(prepared.instanceId),
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
      const { value, stdout, stderr } = runContext(prepared);
      const code = await runDollyCli(["run", "--config", prepared.configPath], value);
      expect(code).toBe(1);
      expect(stderr.text()).toContain("package digest does not match");
      expect(stdout.text()).not.toContain("Dolly ready");
    } finally {
      await prepared.close();
    }
  });

  it("refuses absent committed current configuration before any spawn or durable effect", async () => {
    // Engaged worker route over an empty authority repository: no committed
    // current configuration must refuse before any spawn or durable effect.
    const prepared = await prepareInstance({ installPackage: false, commitAuthority: false });
    try {
      const { value, stdout, stderr } = runContext(prepared);
      const code = await runDollyCli(["run", "--config", prepared.configPath], value);
      expect(code).toBe(1);
      expect(stderr.text()).toContain("no committed current configuration");
      expect(stdout.text()).not.toContain("Dolly ready");
    } finally {
      await prepared.close();
    }
  });

  it("projects the premise and reaches the process boundary through the real run entry, then tears storage and lock down", async () => {
    // Healthy authority + real installation: the engaged entry genuinely
    // invokes the worker-host composition (durable premise projection), and
    // the only refusal is the adapter's process boundary (the fixed packaged
    // binary is a build artifact). After the run every owned resource is
    // closed: the repository can be reopened and the controller lock
    // re-acquired.
    const prepared = await prepareInstance({ installPackage: true, commitAuthority: true });
    try {
      const { value, stdout, stderr } = runContext(prepared);
      const code = await runDollyCli(["run", "--config", prepared.configPath], value);
      expect(code).toBe(1);
      expect(stderr.text()).toMatch(/WORKER_HOST_BINARY_ABSENT/u);
      expect(stdout.text()).not.toContain("Dolly ready");
      // The owner genuinely reached launchHostWorkerHost: the premise was
      // projected durably exactly once during the run, so re-projecting the
      // identical identity pair is an idempotent no-op.
      const lock = await acquireControllerLock(prepared.directories.registryDirectory, prepared.instanceId);
      try {
        const database = RuntimeAuthorityDatabase.open({
          path: prepared.databasePath,
          identity: runtimeIdentityFor(prepared.instanceId),
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
  });

  it("retains the returned owner; close() stops/reaps descendants before storage close and lock release", async () => {
    // Lifecycle contract of the per-instance Runtime Worker host object the
    // entry uses: with the existing process-boundary pattern (fake child,
    // install verifier seam) it returns an owner whose retained handle is
    // reaped inside close(), which then closes storage and releases the real
    // controller lock — all within one idempotent close().
    const restore = setWorkerHostInstallVerifierForTests({
      assertInstallSafety: () => {},
      verifyDigest: () => {},
    });
    const root = mkdtempSync(join(tmpdir(), "wsp-owner-lifecycle-"));
    try {
      const directories = { registryDirectory: join(root, "registry"), defaultStateRoot: join(root, "instances") };
      const configPath = join(root, "instance.json");
      const initStdout = capture();
      const initCode = await runDollyCli(
        ["init", "--config", configPath],
        { cwd: root, directories, stdout: initStdout.output, stderr: initStdout.output },
      );
      expect(initCode).toBe(0);
      const instanceId = (JSON.parse(readFileSync(configPath, "utf8")) as { instanceId: string }).instanceId;
      const stateDirectory = join(directories.defaultStateRoot, instanceId);
      const installations = new ExtensionInstallationRegistry({
        directory: join(stateDirectory, "authority", "installations"),
      });
      const sourceDirectory = join(root, "source");
      sourcePackage(sourceDirectory);
      const resolved = installations.installNodePackage({ sourceDirectory, trust: "trusted" });
      const executableDigest = sha256File(join(resolved.workingDirectory, "bin", "dolly-fs-tools"));
      const server = serverContract({
        packageDigest: resolved.packageDigest,
        executableDigest,
      });
      const authority = resolvedConfigFixture(runtimeConfigDocument(server));
      const controllerLock = await acquireControllerLock(directories.registryDirectory, instanceId);
      const database = RuntimeAuthorityDatabase.open({
        path: join(stateDirectory, "authority", "authority.sqlite"),
        identity: runtimeIdentityFor(instanceId),
        lock: controllerLock,
      });
      database.installConfig({
        identity: runtimeIdentityFor(instanceId),
        canonicalConfigBytes: authority.bytes,
        configDigest: authority.digest,
        premise: null,
        verifiedOrigins: [],
      });
      database.close();

      let spawnedChild: ChildProcess | undefined;
      const spawnForTest: NonNullable<RuntimeWorkerHostOpenOptions["spawn"]> = () => {
        const child = fakeWorkerHostChild();
        spawnedChild = child;
        return child;
      };
      const origins = new InstalledComponentOriginRegistry({
        directory: join(stateDirectory, "authority", "origins"),
        installations,
      });
      const workerHost = await openRuntimeWorkerHost({
        registryDirectory: directories.registryDirectory,
        stateDirectory,
        identity: runtimeIdentityFor(instanceId),
        extensionAlias: "org.dolly.tools",
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
      const reacquired = await acquireControllerLock(directories.registryDirectory, instanceId);
      try {
        const reopened = RuntimeAuthorityDatabase.open({
          path: join(stateDirectory, "authority", "authority.sqlite"),
          identity: runtimeIdentityFor(instanceId),
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
      rmSync(root, { recursive: true, force: true });
    }
  });
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
