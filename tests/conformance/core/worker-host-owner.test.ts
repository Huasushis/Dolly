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
  RuntimeAuthorityDatabaseError,
  type RuntimeAuthorityIdentity,
} from "../../../src/adapters/storage/runtime-authority-database.js";
import { InstanceControllerLock } from "../../../src/core/instance-controller-lock.js";
import { InstalledComponentOriginRegistry } from "../../../src/core/installed-component-origin.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import { setWorkerHostInstallVerifierForTests } from "../../../src/adapters/installed-worker-host.js";
import {
  deriveWorkerStartPremise,
  startHostWorkerHost,
  type HostWorkerHostOwnerOptions,
} from "../../../src/adapters/worker-host-composition.js";

const identity: RuntimeAuthorityIdentity = {
  daemonInstallationId: "0198ab31-6c44-7e8a-b2bb-000000000002",
  instanceId: "instance-0f3a1c9e5b7d4e2a8c6d0b1f2a3e4c5d",
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
  return spawn(process.execPath, ["-e", responder], {
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcess;
}

interface OwnerFixture {
  readonly database: RuntimeAuthorityDatabase;
  readonly controller: InstanceControllerLock;
  readonly installations: ExtensionInstallationRegistry;
  readonly origins: InstalledComponentOriginRegistry;
  readonly workingDirectory: string;
  readonly entrypointPath: string;
  readonly packageDigest: string;
  readonly executableDigest: string;
  readonly databasePath: string;
  readonly directory: string;
}

async function freshOwnerFixture(
  overrides: { readonly packageDigest?: string; readonly packageVersion?: string } = {},
): Promise<OwnerFixture> {
  const directory = mkdtempSync(join(tmpdir(), "wsp-owner-"));
  const controllersDirectory = join(directory, "controllers");
  const installationsDirectory = join(directory, "installations");
  const originsDirectory = join(directory, "origins");

  const controller = await InstanceControllerLock.acquire({
    directory: controllersDirectory,
    instanceId: identity.instanceId,
  });
  const installations = new ExtensionInstallationRegistry({
    directory: installationsDirectory,
  });
  const sourceDirectory = join(directory, "source");
  sourcePackage(sourceDirectory);
  const resolved = installations.installNodePackage({
    sourceDirectory,
    trust: "trusted",
  });
  const workingDirectory = resolved.workingDirectory;
  const entrypointPath = resolved.entrypointPath;
  const executableDigest = sha256File(join(workingDirectory, "bin", "dolly-fs-tools"));
  const packageDigest =
    overrides.packageDigest === undefined ? resolved.packageDigest : overrides.packageDigest;
  const server = serverContract({ packageDigest, executableDigest });
  if (overrides.packageVersion !== undefined) {
    server.transport.package_version = overrides.packageVersion;
  }
  const databasePath = join(directory, "authority.sqlite");
  const database = RuntimeAuthorityDatabase.open({
    path: databasePath,
    identity,
    lock: controller,
  });
  const authority = resolvedConfigFixture(runtimeConfigDocument(server));
  database.installConfig({
    identity,
    canonicalConfigBytes: authority.bytes,
    configDigest: authority.digest,
    premise: null,
    verifiedOrigins: [],
  });
  const origins = new InstalledComponentOriginRegistry({
    directory: originsDirectory,
    installations,
  });
  return {
    database,
    controller,
    installations,
    origins,
    workingDirectory,
    entrypointPath,
    packageDigest: resolved.packageDigest,
    executableDigest,
    databasePath,
    directory,
  };
}

async function withFixture(
  body: (fixture: OwnerFixture) => Promise<void>,
): Promise<void> {
  const fixture = await freshOwnerFixture();
  try {
    await body(fixture);
  } finally {
    fixture.database.close();
    await fixture.controller.release();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}

function ownerOptions(
  fixture: OwnerFixture,
  overrides: Partial<HostWorkerHostOwnerOptions> = {},
): HostWorkerHostOwnerOptions {
  return {
    database: fixture.database,
    controller: fixture.controller,
    origins: fixture.origins,
    installations: fixture.installations,
    extensionAlias: "org.dolly.tools",
    serverIds: ["fs"],
    ...overrides,
  };
}

describe.runIf(process.platform === "linux")("Production worker-host owner callsite", () => {
  it("real owner invokes launchHostWorkerHost, retains the handle, and stop() reaps it", async () => {
    const restore = setWorkerHostInstallVerifierForTests({
      assertInstallSafety: () => {},
      verifyDigest: () => {},
    });
    try {
      await withFixture(async (fixture) => {
        const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
        const spawnForTest: HostWorkerHostOwnerOptions["spawn"] = (command, args) => {
          spawnCalls.push({ command, args });
          return fakeWorkerHostChild();
        };
        const owner = await startHostWorkerHost(
          ownerOptions(fixture, { spawn: spawnForTest }),
        );
        try {
          expect(owner.serverIds).toEqual(["fs"]);
          expect(owner.handles).toHaveLength(1);
          expect(owner.handles[0].serverId).toBe("fs");
          expect(owner.handles[0].pid).toBeGreaterThan(0);
          expect(spawnCalls).toHaveLength(1);
          expect(spawnCalls[0].args).toEqual([
            fixture.databasePath,
            "org.dolly.tools",
            "fs",
          ]);
          // The caller's premise derived from the same authority facts is
          // already projected: the owner projected it durably exactly once.
          const premise = deriveWorkerStartPremise({
            database: fixture.database,
            extensionAlias: "org.dolly.tools",
            serverId: "fs",
            installedPackageRoot: fixture.workingDirectory,
            installedPackagePath: fixture.entrypointPath,
          });
          expect(fixture.database.installWorkerStartPremise(premise).projected).toBe(false);
        } finally {
          await owner.stop();
        }
        // stop() reaped the child exactly once and a second stop is a no-op.
        await owner.stop();
        // Owner-level fixtures owned these processes; nothing further leaks.
      });
    } finally {
      restore();
    }
  });

  it("refuses an unknown server before any spawn or durable premise projection", async () => {
    const restore = setWorkerHostInstallVerifierForTests({
      assertInstallSafety: () => {},
      verifyDigest: () => {},
    });
    try {
      await withFixture(async (fixture) => {
        const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
        const spawnForTest: HostWorkerHostOwnerOptions["spawn"] = (command, args) => {
          spawnCalls.push({ command, args });
          return fakeWorkerHostChild();
        };
        await expect(
          startHostWorkerHost(
            ownerOptions(fixture, { serverIds: ["missing"], spawn: spawnForTest }),
          ),
        ).rejects.toThrow(/configured server is missing/u);
        expect(spawnCalls).toHaveLength(0);
        // Zero durable startup effects: the legitimate premise was never projected.
        const premise = deriveWorkerStartPremise({
          database: fixture.database,
          extensionAlias: "org.dolly.tools",
          serverId: "fs",
          installedPackageRoot: fixture.workingDirectory,
          installedPackagePath: fixture.entrypointPath,
        });
        expect(fixture.database.installWorkerStartPremise(premise).projected).toBe(true);
      });
    } finally {
      restore();
    }
  });

  it("refuses an absent installation before any spawn or durable premise projection", async () => {
    const restore = setWorkerHostInstallVerifierForTests({
      assertInstallSafety: () => {},
      verifyDigest: () => {},
    });
    try {
      await withFixture(async (fixture) => {
        const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
        const spawnForTest: HostWorkerHostOwnerOptions["spawn"] = (command, args) => {
          spawnCalls.push({ command, args });
          return fakeWorkerHostChild();
        };
        const stale = await freshOwnerFixture({ packageVersion: "9.9.9" });
        try {
          await expect(
            startHostWorkerHost(
              ownerOptions(stale, { spawn: spawnForTest }),
            ),
          ).rejects.toThrow(/no Host-owned installation/u);
          expect(spawnCalls).toHaveLength(0);
          expect(stale.database.installWorkerStartPremise(
            deriveWorkerStartPremise({
              database: stale.database,
              extensionAlias: "org.dolly.tools",
              serverId: "fs",
              installedPackageRoot: fixture.workingDirectory,
              installedPackagePath: fixture.entrypointPath,
            }),
          ).projected).toBe(true);
        } finally {
          stale.database.close();
          await stale.controller.release();
          rmSync(stale.directory, { recursive: true, force: true });
        }
      });
    } finally {
      restore();
    }
  });

  it("refuses a mismatched package digest before any spawn or durable premise projection", async () => {
    const restore = setWorkerHostInstallVerifierForTests({
      assertInstallSafety: () => {},
      verifyDigest: () => {},
    });
    try {
      await withFixture(async (fixture) => {
        const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
        const spawnForTest: HostWorkerHostOwnerOptions["spawn"] = (command, args) => {
          spawnCalls.push({ command, args });
          return fakeWorkerHostChild();
        };
        const mismatched = await freshOwnerFixture({
          packageDigest: `sha256:${"d".repeat(64)}`,
        });
        try {
          await expect(
            startHostWorkerHost(
              ownerOptions(mismatched, { spawn: spawnForTest }),
            ),
          ).rejects.toThrow(/package digest does not match/u);
          expect(spawnCalls).toHaveLength(0);
          expect(mismatched.database.installWorkerStartPremise(
            deriveWorkerStartPremise({
              database: mismatched.database,
              extensionAlias: "org.dolly.tools",
              serverId: "fs",
              installedPackageRoot: fixture.workingDirectory,
              installedPackagePath: fixture.entrypointPath,
            }),
          ).projected).toBe(true);
        } finally {
          mismatched.database.close();
          await mismatched.controller.release();
          rmSync(mismatched.directory, { recursive: true, force: true });
        }
      });
    } finally {
      restore();
    }
  });

  it("refuses absent current configuration before any spawn or durable effect", async () => {
    const restore = setWorkerHostInstallVerifierForTests({
      assertInstallSafety: () => {},
      verifyDigest: () => {},
    });
    try {
      const directory = mkdtempSync(join(tmpdir(), "wsp-owner-empty-"));
      const controller = await InstanceControllerLock.acquire({
        directory: join(directory, "controllers"),
        instanceId: identity.instanceId,
      });
      const installations = new ExtensionInstallationRegistry({
        directory: join(directory, "installations"),
      });
      const origins = new InstalledComponentOriginRegistry({
        directory: join(directory, "origins"),
        installations,
      });
      const database = RuntimeAuthorityDatabase.open({
        path: join(directory, "authority.sqlite"),
        identity,
        lock: controller,
      });
      try {
        const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
        await expect(
          startHostWorkerHost({
            database,
            controller,
            origins,
            installations,
            extensionAlias: "org.dolly.tools",
            serverIds: ["fs"],
            spawn: (command, args) => {
              spawnCalls.push({ command, args });
              return fakeWorkerHostChild();
            },
          }),
        ).rejects.toThrow(/no committed current configuration/u);
        expect(spawnCalls).toHaveLength(0);
        expect(database.readCurrentConfig()).toBe(null);
      } finally {
        database.close();
        await controller.release();
        rmSync(directory, { recursive: true, force: true });
      }
    } finally {
      restore();
    }
  });
});
