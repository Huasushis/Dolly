/**
 * OPS-002 for the daemon's own configuration and listener.
 *
 * `security-operations.md` Section 3 requires a deliberate loopback bind, no
 * unspecified-address fallback, and a stop on bind failure rather than a retry
 * on a wider interface. Section 6 requires the account material to stay out of
 * files, URLs, command lines, and logs. The socket cases below bind real
 * loopback sockets and make real connections rather than inspecting a
 * configuration string.
 */

import { createServer, connect, type Server } from "node:net";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NetworkExposureError } from "../../../src/core/network-exposure.js";
import {
  DaemonConfigError,
  DaemonConfigStore,
  daemonExposurePolicy,
  redactDaemonConfig,
  verifyDaemonCredential,
} from "../../../src/daemon/daemon-config.js";
import {
  DaemonListenError,
  bindLoopbackServer,
} from "../../../src/daemon/loopback-listener.js";

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function canConnect(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function firstExternalIpv4(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

const NOW = "2026-07-24T12:00:00.000Z";

describe("OPS-002 daemon total configuration and loopback-only listener", () => {
  let root: string;
  const servers = new Set<Server>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-daemon-config-"));
  });

  afterEach(async () => {
    for (const server of servers) await closeServer(server);
    servers.clear();
    rmSync(root, { recursive: true, force: true });
  });

  function track(server: Server): Server {
    servers.add(server);
    return server;
  }

  it("generates a random account on first run and never writes the password anywhere", async () => {
    const store = new DaemonConfigStore({ directory: root });
    const created = await store.loadOrInitialize();

    expect(created.generatedPassword).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.config.credential.username).toMatch(/^dolly-[0-9a-f]{10}$/u);
    expect(created.config.listen).toEqual({ host: "127.0.0.1", port: 0 });

    const password = created.generatedPassword!;
    const fileText = readFileSync(created.path, "utf8");
    expect(fileText).not.toContain(password);
    expect(fileText).toContain(created.config.credential.verifier);
    expect(JSON.stringify(redactDaemonConfig(created.config))).not.toContain(password);
    expect(JSON.stringify(redactDaemonConfig(created.config))).not.toContain(
      created.config.credential.verifier,
    );
    expect(JSON.stringify(redactDaemonConfig(created.config))).not.toContain(
      created.config.credential.salt,
    );
    expect(process.argv.join(" ")).not.toContain(password);

    const reloaded = store.load();
    expect(reloaded.generatedPassword).toBeUndefined();
    expect(reloaded.config).toEqual(created.config);
    await expect(
      verifyDaemonCredential(reloaded.config, {
        username: created.config.credential.username,
        password,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyDaemonCredential(reloaded.config, {
        username: created.config.credential.username,
        password: `${password}x`,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyDaemonCredential(reloaded.config, { username: "someone-else", password }),
    ).resolves.toBe(false);
  }, 30_000);

  it("rotates the account and invalidates the previous password", async () => {
    const store = new DaemonConfigStore({ directory: root });
    const created = await store.loadOrInitialize();
    const rotated = await store.rotateCredential();

    expect(rotated.generatedPassword).not.toBe(created.generatedPassword);
    expect(rotated.config.daemonInstallationId).toBe(created.config.daemonInstallationId);
    await expect(
      verifyDaemonCredential(rotated.config, {
        username: rotated.config.credential.username,
        password: created.generatedPassword!,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyDaemonCredential(rotated.config, {
        username: rotated.config.credential.username,
        password: rotated.generatedPassword!,
      }),
    ).resolves.toBe(true);
    expect(readFileSync(rotated.path, "utf8")).not.toContain(rotated.generatedPassword!);
  }, 30_000);

  it("atomically migrates a dolly.daemon-config/1 document to /2 with a fresh UUIDv7 installation id", async () => {
    const legacyDaemonId = "11111111-1111-4111-8111-111111111111";
    const store = new DaemonConfigStore({ directory: root, now: () => NOW });
    const legacyDocument = {
      schemaVersion: "dolly.daemon-config/1",
      daemonId: legacyDaemonId,
      listen: { host: "127.0.0.1", port: 0 },
      credential: {
        username: "dolly-admin",
        algorithm: "scrypt",
        salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        verifier: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        cost: 16384,
        blockSize: 8,
        parallelization: 1,
        keyLength: 32,
        createdAt: "2026-07-24T12:00:00.000Z",
      },
    };
    writeFileSync(join(root, "daemon.json"), `${JSON.stringify(legacyDocument, null, 2)}\n`, { mode: 0o600 });

    const loaded = store.load();
    expect(loaded.config.schemaVersion).toBe("dolly.daemon-config/2");
    // A fresh UUIDv7 replaces the retired UUIDv4; the old value is never reused.
    expect(loaded.config.daemonInstallationId).not.toBe(legacyDaemonId);
    expect(loaded.config.daemonInstallationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // listen and credential are preserved verbatim through the migration.
    expect(loaded.config.listen).toEqual({ host: "127.0.0.1", port: 0 });
    expect(loaded.config.credential.username).toBe("dolly-admin");
    expect(loaded.config.credential.salt).toBe(legacyDocument.credential.salt);
    // The on-disk document is now /2 and the migration is stable across loads.
    const onDisk = JSON.parse(readFileSync(loaded.path, "utf8"));
    expect(onDisk.schemaVersion).toBe("dolly.daemon-config/2");
    expect(store.load().config.daemonInstallationId).toBe(loaded.config.daemonInstallationId);
    // Credential rotation preserves the migrated installation id.
    const rotated = await store.rotateCredential("dolly-admin");
    expect(rotated.config.daemonInstallationId).toBe(loaded.config.daemonInstallationId);
  }, 30_000);

  it("refuses the /1 to /2 migration when a durable foreign reference to the old UUIDv4 exists", async () => {
    const legacyDaemonId = "22222222-2222-4222-8222-222222222222";
    const store = new DaemonConfigStore({ directory: root, now: () => NOW });
    // A sibling durable record names the old daemon UUIDv4: migration must
    // stop rather than retire an identifier that is still referenced.
    writeFileSync(
      join(root, "instance-aaa.json"),
      JSON.stringify({ instanceId: "55555555-5555-4555-8555-555555555555", daemonId: legacyDaemonId }),
      "utf8",
    );
    const legacyDocument = {
      schemaVersion: "dolly.daemon-config/1",
      daemonId: legacyDaemonId,
      listen: { host: "127.0.0.1", port: 0 },
      credential: {
        username: "dolly-admin",
        algorithm: "scrypt",
        salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        verifier: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        cost: 16384,
        blockSize: 8,
        parallelization: 1,
        keyLength: 32,
        createdAt: "2026-07-24T12:00:00.000Z",
      },
    };
    writeFileSync(join(root, "daemon.json"), `${JSON.stringify(legacyDocument, null, 2)}\n`, { mode: 0o600 });
    expect(() => store.load()).toThrow(
      expect.objectContaining({ code: "DAEMON_CONFIG_MIGRATION_REFUSED" }),
    );
    // The legacy document is left untouched so the reference stays resolvable.
    expect(JSON.parse(readFileSync(join(root, "daemon.json"), "utf8")).schemaVersion).toBe(
      "dolly.daemon-config/1",
    );
  }, 30_000);


  it("refuses every listen address that is not an exact loopback literal", async () => {
    const store = new DaemonConfigStore({ directory: root });
    for (const host of ["0.0.0.0", "::", "localhost", "192.168.1.5", "0000:0000:0000:0000:0000:0000:0000:0001"]) {
      await expect(
        store.loadOrInitialize({ listenHost: host as "127.0.0.1" }),
      ).rejects.toMatchObject({ code: "DAEMON_CONFIG_LISTEN_ADDRESS_FORBIDDEN" });
      expect(store.exists()).toBe(false);
    }
    const created = await store.loadOrInitialize({ listenHost: "::1", listenPort: 0 });
    expect(created.config.listen.host).toBe("::1");
  }, 30_000);

  it("fails closed when the stored configuration is readable by another identity", async () => {
    if (process.platform === "win32") {
      // Windows uses access control lists rather than permission bits, and
      // this store does not set them yet, so it makes no claim here.
      const store = new DaemonConfigStore({ directory: root });
      const created = await store.loadOrInitialize();
      expect(statSync(created.path).isFile()).toBe(true);
      return;
    }
    const store = new DaemonConfigStore({ directory: root });
    const created = await store.loadOrInitialize();
    expect(statSync(created.path).mode & 0o777).toBe(0o600);
    chmodSync(created.path, 0o644);
    expect(() => store.load()).toThrow(
      expect.objectContaining({ code: "DAEMON_CONFIG_PERMISSIONS_INSECURE" }),
    );
  }, 30_000);

  it("binds a real loopback socket and reports the kernel-selected port", async () => {
    const server = track(createServer((socket) => socket.end()));
    const bound = await bindLoopbackServer(server, { host: "127.0.0.1", port: 0 });

    expect(bound.host).toBe("127.0.0.1");
    expect(bound.port).toBeGreaterThan(0);
    const address = server.address();
    expect(address).not.toBeNull();
    expect(typeof address === "object" && address !== null ? address.address : "").toBe(
      "127.0.0.1",
    );
    expect(await canConnect("127.0.0.1", bound.port)).toBe(true);

    const external = firstExternalIpv4();
    if (external !== undefined) {
      expect(await canConnect(external, bound.port)).toBe(false);
    }
  }, 30_000);

  it("stops on a bind failure instead of retrying on a wider interface", async () => {
    const holder = track(createServer((socket) => socket.end()));
    const bound = await bindLoopbackServer(holder, { host: "127.0.0.1", port: 0 });

    const contender = track(createServer((socket) => socket.end()));
    await expect(
      bindLoopbackServer(contender, { host: "127.0.0.1", port: bound.port }),
    ).rejects.toMatchObject({ code: "DAEMON_LISTEN_BIND_FAILED" });

    expect(contender.listening).toBe(false);
    expect(contender.address()).toBeNull();
    const external = firstExternalIpv4();
    if (external !== undefined) {
      // The refused bind produced no listener on any wider interface.
      expect(await canConnect(external, bound.port)).toBe(false);
    }
  }, 30_000);

  it("never asks the network stack for an unspecified address", async () => {
    for (const host of ["0.0.0.0", "::", "localhost", ""]) {
      const server = track(createServer());
      await expect(bindLoopbackServer(server, { host, port: 0 })).rejects.toBeInstanceOf(
        DaemonConfigError,
      );
      expect(server.listening).toBe(false);
      expect(server.address()).toBeNull();
    }
    const badPort = track(createServer());
    await expect(
      bindLoopbackServer(badPort, { host: "127.0.0.1", port: 70_000 }),
    ).rejects.toMatchObject({ code: "DAEMON_LISTEN_ADDRESS_FORBIDDEN" });
    expect(badPort.listening).toBe(false);
  }, 30_000);

  it("binds the configured IPv6 loopback or reports the failure without widening", async () => {
    const server = track(createServer((socket) => socket.end()));
    let bound: { host: string; port: number } | undefined;
    try {
      bound = await bindLoopbackServer(server, { host: "::1", port: 0 });
    } catch (error) {
      // A host without an IPv6 loopback must surface the failure, not fall
      // back to another interface.
      expect(error).toBeInstanceOf(DaemonListenError);
      expect((error as DaemonListenError).code).toBe("DAEMON_LISTEN_BIND_FAILED");
      expect(server.listening).toBe(false);
      expect(server.address()).toBeNull();
      return;
    }
    expect(bound.host).toBe("::1");
    const address = server.address();
    expect(typeof address === "object" && address !== null ? address.address : "").toBe("::1");
    expect(await canConnect("::1", bound.port)).toBe(true);
  }, 30_000);

  it("guards the bound listener with the loopback request policy from its own configuration", async () => {
    const store = new DaemonConfigStore({ directory: root });
    const created = await store.loadOrInitialize({ listenHost: "127.0.0.1", listenPort: 0 });
    const server = track(createServer((socket) => socket.end()));
    const bound = await bindLoopbackServer(server, created.config.listen);
    const policy = daemonExposurePolicy(created.config).withBoundPort(bound.port);
    const authority = `127.0.0.1:${bound.port}`;

    expect(
      policy.validateRequest(
        {
          peerAddress: "127.0.0.1",
          encrypted: false,
          host: authority,
          origin: `http://${authority}`,
        },
        { requireOrigin: true },
      ),
    ).toMatchObject({ mode: "local", effectiveOrigin: `http://${authority}` });

    expect(() =>
      policy.validateRequest(
        {
          peerAddress: "192.168.1.20",
          encrypted: false,
          host: authority,
          origin: `http://${authority}`,
        },
        { requireOrigin: true },
      ),
    ).toThrow(expect.objectContaining({ code: "EXPOSURE_PEER_DENIED" }));

    expect(() =>
      policy.validateRequest(
        {
          peerAddress: "127.0.0.1",
          encrypted: false,
          host: `daemon.attacker.test:${bound.port}`,
          origin: `http://${authority}`,
        },
        { requireOrigin: true },
      ),
    ).toThrow(expect.objectContaining({ code: "EXPOSURE_HOST_DENIED" }));

    expect(() =>
      policy.validateRequest(
        {
          peerAddress: "127.0.0.1",
          encrypted: false,
          host: authority,
          origin: `http://${authority}`,
          forwarded: "for=203.0.113.9;proto=https;host=admin.example.test",
        },
        { requireOrigin: true },
      ),
    ).toThrow(NetworkExposureError);
  }, 30_000);
});
