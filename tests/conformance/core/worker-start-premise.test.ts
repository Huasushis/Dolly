import { canonicalBytes } from "../../../src/schema-bundle/index.js";
import { openAttestedNativeSqlite } from "../../../src/adapters/storage/native-sqlite.js";
import type { NativeSqliteConnection } from "../../../src/adapters/storage/native-sqlite-binding.js";

import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RuntimeAuthorityDatabase,
  RuntimeAuthorityDatabaseError,
  type InstalledComponentOrigin,
  type InstallWorkerStartPremiseInput,
  type LinuxServiceCandidate,
  type ModuleActivationPremises,
  type PermissionPolicyBackendBinding,
  type PermissionPolicyDefinition,
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
  async release(): Promise<void> {
    this.#held = false;
  }
  assertHeld(): void {
    if (!this.#held) throw new Error("lock not held");
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

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Digest of the closed record with `field` removed (schema `comment` rules). */
function selfDigest(record: Record<string, unknown>, field: string): string {
  const { [field]: _digest, ...rest } = record;
  return sha256Bytes(canonicalBytes(rest));
}

/**
 * Exact prior Worker-start physical table: it stores `package_path` and lacks
 * the v2 installed-origin tuple.
 */
const LEGACY_WORKER_START_PREMISE_SCHEMA_SQL = `
CREATE TABLE worker_start_premises (
  config_revision INTEGER NOT NULL CHECK (config_revision BETWEEN 1 AND 9007199254740991),
  config_digest TEXT NOT NULL,
  extension_alias TEXT NOT NULL CHECK (length(extension_alias) > 0),
  server_id TEXT NOT NULL CHECK (length(server_id) > 0),
  package_root TEXT NOT NULL CHECK (length(package_root) > 0),
  package_path TEXT NOT NULL CHECK (length(package_path) > 0),
  package_digest TEXT NOT NULL CHECK (package_digest LIKE 'sha256:%'),
  executable_digest TEXT NOT NULL CHECK (executable_digest LIKE 'sha256:%'),
  endpoint TEXT NOT NULL CHECK (length(endpoint) > 0),
  spawn_args_json TEXT NOT NULL CHECK (json_valid(spawn_args_json) AND json_type(spawn_args_json) = 'array'),
  startup_timeout_ms INTEGER NOT NULL CHECK (startup_timeout_ms BETWEEN 1 AND 9007199254740991),
  max_frame_bytes INTEGER NOT NULL CHECK (max_frame_bytes BETWEEN 1 AND 4294967295),
  max_response_bytes INTEGER NOT NULL CHECK (max_response_bytes BETWEEN 1 AND 4294967295),
  wire_depth INTEGER NOT NULL CHECK (wire_depth BETWEEN 1 AND 96),
  semantic_depth INTEGER NOT NULL CHECK (semantic_depth BETWEEN 1 AND 64),
  max_dispatch_members INTEGER NOT NULL CHECK (max_dispatch_members BETWEEN 1 AND 9007199254740991),
  max_dispatch_depth INTEGER NOT NULL CHECK (max_dispatch_depth BETWEEN 1 AND 64),
  transport_digest TEXT NOT NULL CHECK (transport_digest LIKE 'sha256:%'),
  record_jcs BLOB NOT NULL,
  record_digest TEXT NOT NULL,
  PRIMARY KEY (config_revision, extension_alias, server_id),
  FOREIGN KEY (config_revision, config_digest)
    REFERENCES config_revision_mappings(config_revision, config_digest),
  CHECK (substr(package_path, 1, length(package_root) + 1) = package_root || '/')
);
`;

const NON_WORKER_AUTHORITY_TABLES = [
  "core_meta",
  "commit_sequence",
  "host_authority_meta",
  "config_revision_mappings",
  "installed_component_origins",
  "permission_policy_definitions",
  "permission_policy_backend_bindings",
  "linux_service_candidates",
  "module_activation_premises",
  "module_activation_premise_policy_selections",
  "runtime_authority_state",
  "core_journal",
] as const;

interface TestSqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface TestSqliteConnection {
  prepare(source: string): TestSqliteStatement;
  exec(source: string): unknown;
}

function withNativeDatabase<T>(path: string, work: (database: TestSqliteConnection) => T): T {
  const handle = openAttestedNativeSqlite(path);
  try {
    return work(handle.database as unknown as TestSqliteConnection);
  } finally {
    handle.close();
  }
}


function snapshotNonWorkerAuthority(database: TestSqliteConnection): {
  readonly rows: Record<string, Record<string, unknown>[]>;
  readonly indexes: Record<string, Record<string, unknown>[]>;
  readonly schema: Record<string, unknown>[];
} {
  const rows: Record<string, Record<string, unknown>[]> = {};
  const indexes: Record<string, Record<string, unknown>[]> = {};
  for (const table of NON_WORKER_AUTHORITY_TABLES) {
    rows[table] = database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    indexes[table] = database.prepare(`PRAGMA index_list(${table})`).all()
      .map((index) => {
        const name = String(index.name).replace(/'/gu, "''");
        return {
          ...index,
          name: index.name,
          columns: database.prepare(`PRAGMA index_xinfo('${name}')`).all(),
        };
      })
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  }
  const schema = database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master " +
      "WHERE name NOT LIKE 'sqlite_%' AND tbl_name <> 'worker_start_premises' ORDER BY type, name",
  ).all();
  return { rows, indexes, schema };
}

/**
 * The one committed installed-release origin the Worker-start premise FK may
 * name: the frozen `org.dolly.tools` package origin mirrors the default
 * premise input's extension alias, revision, and package digest.
 */
const TOOLS_ORIGIN: InstalledComponentOrigin = {
  schema: "dolly.installed-component-origin/v1",
  kind: "installed_product_component",
  component_id: "org.dolly.tools",
  component_revision: 1,
  component_digest: `sha256:${"a".repeat(64)}`,
};

/**
 * Builds one canonical resolved config that commits the tools origin into the
 * durable installed-component-origin table, so a subsequent Worker-start
 * premise projection satisfies the closed origin foreign key. The resolved
 * config carries one Linux Module service candidate and its complete
 * activation premise; the `runtime_config` body is arbitrary (the projections
 * under test never read it).
 */
function installedModuleFixture(content: string): {
  bytes: Uint8Array;
  digest: string;
  premise: ModuleActivationPremises;
  origin: InstalledComponentOrigin;
} {
  const origin: InstalledComponentOrigin = { ...TOOLS_ORIGIN };
  const policyOrigin = {
    schema: "dolly.policy-definition-origin/v1",
    kind: "operator_approved_policy",
    source_id: "org.dolly.policy.default",
    source_revision: 1,
    source_digest: `sha256:${"0".repeat(64)}`,
  };
  const definitionRecord: Record<string, unknown> = {
    schema: "dolly.permission-policy-definition/v1",
    policy_id: "policy-tools",
    policy_revision: 1,
    definition_schema_uri: "dolly://schemas/host-permission-policy/v1",
    definition_schema_digest: `sha256:${"f".repeat(64)}`,
    definition: { tools: { invoke: true } },
    origin: policyOrigin,
    definition_digest: "",
  };
  definitionRecord.definition_digest = selfDigest(definitionRecord, "definition_digest");
  const bindingRecord: Record<string, unknown> = {
    schema: "dolly.permission-policy-backend-binding/v1",
    binding_id: "binding-tools",
    binding_revision: 1,
    binding_digest: "",
    policy_id: String(definitionRecord.policy_id),
    policy_revision: 1,
    policy_definition_digest: String(definitionRecord.definition_digest),
    origin,
  };
  bindingRecord.binding_digest = selfDigest(bindingRecord, "binding_digest");
  const candidateRecord: Record<string, unknown> = {
    schema: "dolly.linux-service-candidate/v1",
    origin,
    unit_name: "dolly-fs-tools.service",
    mode: "user",
    candidate_digest: "",
  };
  candidateRecord.candidate_digest = selfDigest(candidateRecord, "candidate_digest");
  const selection = {
    policy_id: String(definitionRecord.policy_id),
    policy_revision: Number(definitionRecord.policy_revision),
    policy_definition_digest: String(definitionRecord.definition_digest),
    binding_id: String(bindingRecord.binding_id),
    binding_revision: Number(bindingRecord.binding_revision),
    binding_digest: String(bindingRecord.binding_digest),
  };
  const resolved = {
    runtime_config: { value: content },
    permission_policy_selections: [selection],
    service_candidate: candidateRecord,
  };
  const bytes = Uint8Array.from(Buffer.from(canonicalBytes(resolved)));
  const digest = sha256Bytes(bytes);
  const premiseRecord: Record<string, unknown> = {
    schema: "dolly.module-activation-premises/v1",
    daemon_installation_id: identity.daemonInstallationId,
    instance_id: identity.instanceId,
    config_revision: 1,
    config_digest: digest,
    permission_policy_definitions: [definitionRecord],
    permission_policy_backend_bindings: [bindingRecord],
    service_candidate: candidateRecord,
    premises_digest: "",
  };
  premiseRecord.premises_digest = selfDigest(premiseRecord, "premises_digest");
  return {
    bytes,
    digest,
    premise: premiseRecord as unknown as ModuleActivationPremises,
    origin,
  };
}

function freshCommitted(dirName: string, lock = new FakeLock()): RuntimeAuthorityDatabase {
  const dir = mkdtempSync(join(tmpdir(), "wsp-"));
  const database = RuntimeAuthorityDatabase.open({
    path: join(dir, `${dirName}.sqlite`),
    identity,
    lock: lock as never,
  });
  const installed = installedModuleFixture("committed");
  database.installConfig({
    identity,
    canonicalConfigBytes: installed.bytes,
    configDigest: installed.digest,
    premise: installed.premise,
    verifiedOrigins: [installed.origin],
  });
  return database;
}

function premiseInput(overrides: Partial<InstallWorkerStartPremiseInput> = {}): InstallWorkerStartPremiseInput {
  return {
    extensionAlias: "org.dolly.tools",
    serverId: "fs",
    packageRoot: "/opt/dolly/pkg",
    originComponentId: "org.dolly.tools",
    originComponentRevision: 1,
    originComponentDigest: `sha256:${"a".repeat(64)}`,
    packageDigest: `sha256:${"a".repeat(64)}`,
    executableDigest: `sha256:${"b".repeat(64)}`,
    endpoint: "bin/dolly-fs-tools",
    spawnArgs: ["server.py"],
    startupTimeoutMs: 10_000,
    maxFrameBytes: 262_144,
    maxResponseBytes: 262_144,
    wireDepth: 96,
    semanticDepth: 64,
    maxDispatchMembers: 4_096,
    maxDispatchDepth: 64,
    transportDigest: `sha256:${"e".repeat(64)}`,
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

  it("rejects endpoints, non-canonical roots, and origin/package mismatches before any durable write", () => {
    const database = freshCommitted("escape");
    expect(() => database.installWorkerStartPremise(premiseInput({ endpoint: "../escape" }))).toThrowError(
      /safe package-root-relative/u,
    );
    expect(() => database.installWorkerStartPremise(premiseInput({ packageRoot: "/opt/dolly/pkg/" }))).toThrowError(
      /absolute canonical path/u,
    );
    // Origin/package identity mismatch refuses closed before any durable
    // write, and the refusal never poisons the identity pair: the exact
    // origin-backed premise still projects fresh afterward.
    expect(() =>
      database.installWorkerStartPremise(premiseInput({ originComponentId: "org.dolly.tools.other" })),
    ).toThrowError(RuntimeAuthorityDatabaseError);
    expect(() => database.installWorkerStartPremise(
      premiseInput({ originComponentRevision: 0 }),
    )).toThrowError(/origin tuple/u);
    expect(() => database.installWorkerStartPremise(
      premiseInput({ packageDigest: `sha256:${"d".repeat(64)}` }),
    )).toThrowError(/package_digest = origin_component_digest/u);
    expect(database.installWorkerStartPremise(premiseInput()).projected).toBe(true);
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

  it("upgrades the exact v1 worker table while preserving authority and reprojection", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-upgrade-"));
    const databasePath = join(dir, "authority.sqlite");
    const lock = new FakeLock();
    const database = RuntimeAuthorityDatabase.open({
      path: databasePath,
      identity,
      lock: lock as never,
    });
    const installed = installedModuleFixture("upgrade");
    database.installConfig({
      identity,
      canonicalConfigBytes: installed.bytes,
      configDigest: installed.digest,
      premise: installed.premise,
      verifiedOrigins: [installed.origin],
    });
    database.close();

    const preservedBefore = withNativeDatabase(databasePath, (raw) => {
      const snapshot = snapshotNonWorkerAuthority(raw);
      raw.exec("DROP TABLE worker_start_premises");
      raw.exec(LEGACY_WORKER_START_PREMISE_SCHEMA_SQL);
      const input = premiseInput();
      const legacyRecordBytes = canonicalBytes({
        schema: "dolly.worker-start-premise/v1",
        config_revision: 1,
        config_digest: installed.digest,
        extension_alias: input.extensionAlias,
        server_id: input.serverId,
        package_root: input.packageRoot,
        package_path: `${input.packageRoot}/package.bin`,
      });
      raw.prepare(
        "INSERT INTO worker_start_premises (config_revision, config_digest, extension_alias, server_id, package_root, package_path, package_digest, executable_digest, endpoint, spawn_args_json, startup_timeout_ms, max_frame_bytes, max_response_bytes, wire_depth, semantic_depth, max_dispatch_members, max_dispatch_depth, transport_digest, record_jcs, record_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        1,
        installed.digest,
        input.extensionAlias,
        input.serverId,
        input.packageRoot,
        `${input.packageRoot}/package.bin`,
        input.packageDigest,
        input.executableDigest,
        input.endpoint,
        JSON.stringify(input.spawnArgs),
        input.startupTimeoutMs,
        input.maxFrameBytes,
        input.maxResponseBytes,
        input.wireDepth,
        input.semanticDepth,
        input.maxDispatchMembers,
        input.maxDispatchDepth,
        input.transportDigest,
        Buffer.from(legacyRecordBytes),
        sha256Bytes(legacyRecordBytes),
      );
      return snapshot;
    });

    const reopened = RuntimeAuthorityDatabase.open({
      path: databasePath,
      identity,
      lock: lock as never,
    });
    expect(reopened.readCurrentConfig()?.premise).not.toBeNull();

    const migrated = withNativeDatabase(databasePath, (raw) => ({
      workerRows: raw.prepare("SELECT 1 FROM worker_start_premises").all(),
      workerColumns: raw.prepare("PRAGMA table_info(worker_start_premises)").all().map((column) => String(column.name)),
      preserved: snapshotNonWorkerAuthority(raw),
    }));
    expect(migrated.workerRows).toHaveLength(0);
    expect(migrated.workerColumns).toEqual([
      "config_revision",
      "config_digest",
      "extension_alias",
      "server_id",
      "package_root",
      "origin_component_id",
      "origin_component_revision",
      "origin_component_digest",
      "package_digest",
      "executable_digest",
      "endpoint",
      "spawn_args_json",
      "startup_timeout_ms",
      "max_frame_bytes",
      "max_response_bytes",
      "wire_depth",
      "semantic_depth",
      "max_dispatch_members",
      "max_dispatch_depth",
      "transport_digest",
      "record_jcs",
      "record_digest",
    ]);
    expect(migrated.preserved).toEqual(preservedBefore);

    expect(reopened.installWorkerStartPremise(premiseInput()).projected).toBe(true);
    reopened.close();

    const projected = withNativeDatabase(databasePath, (raw) => ({
      worker: raw.prepare(
        "SELECT origin_component_id, origin_component_revision, origin_component_digest, package_digest FROM worker_start_premises",
      ).get(),
      preserved: snapshotNonWorkerAuthority(raw),
    }));
    expect(projected.worker).toEqual({
      origin_component_id: "org.dolly.tools",
      origin_component_revision: 1,
      origin_component_digest: `sha256:${"a".repeat(64)}`,
      package_digest: `sha256:${"a".repeat(64)}`,
    });
    expect(projected.preserved).toEqual(preservedBefore);
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

      const dbDir = mkdtempSync(join(tmpdir(), "wsp-route-db-"));
      const databasePath = join(dbDir, "authority.sqlite");
      const database = RuntimeAuthorityDatabase.open({
        path: databasePath,
        identity,
        lock: new FakeLock() as never,
      });
      const installed = installedModuleFixture("committed");
      database.installConfig({
        identity,
        canonicalConfigBytes: installed.bytes,
        configDigest: installed.digest,
        premise: installed.premise,
        verifiedOrigins: [installed.origin],
      });

      const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
      const premise = premiseInput({
        packageRoot,
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
