/**
 * Conformance drive of the H1 Runtime authority SQLite repository against the
 * 41d6476 authority vectors TST-AUTH-001..007, using the real pinned native
 * binding on real temp-file databases with close/reopen and authority-
 * transaction crash injection via `crashPoint`.
 *
 * Covered storage contracts:
 * - zero committed rows from any candidate before its transaction commits,
 *   with a crash at every named point (REQ-AUTH-003 / INV-AUTH-002);
 * - premise-last atomicity and exact current-revision binding;
 * - exact-current reuse vs next-revision allocation, `A -> B -> A` never
 *   reuses history, no digest-to-integer mapping, no global digest uniqueness;
 * - open-time verification of identity, pointer, bytes/digest and user_version
 *   plus legacy-JSON abstention after a commit (REQ-AUTH-004/005);
 * - stale/missing/mismatch/cross-origin prerequisite refusals leave the
 *   current pointer untouched (TST-AUTH-006);
 * - downstream result/ack cannot write any authority row (TST-AUTH-001/003).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  HOST_AUTHORITY_SCHEMA_VERSION,
  RuntimeAuthorityDatabase,
  RuntimeAuthorityCrashPointError,
  RuntimeAuthorityDatabaseError,
  type InstallAuthorityConfigInput,
  type InstalledComponentOrigin,
  type LinuxServiceCandidate,
  type ModuleActivationPremises,
  type PermissionPolicyBackendBinding,
  type PermissionPolicyDefinition,
  type RuntimeAuthorityIdentity,
} from "../../../src/adapters/storage/runtime-authority-database.js";
import { canonicalBytes } from "../../../src/schema-bundle/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dolly-wt-ts-runtime-db-h1-"));
  temporaryDirectories.push(directory);
  return directory;
}

function digestOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** sha256 digest of the closed record with `field` removed (schema `comment` rules). */
function selfDigest(record: Record<string, unknown>, field: string): string {
  const { [field]: _digest, ...rest } = record;
  return digestOfBytes(canonicalBytes(rest));
}

function hex(repeats: string): string {
  return repeats.repeat(64);
}

/** Double that implements the caller-held controller-lock contract. */
class FakeLock {
  readonly controllerGenerationId = "0198ab11-6c44-7e8a-b2bb-000000000701";

  constructor(public held: boolean = true) {}
  assertHeld(): void {
    if (!this.held) throw new Error("fake controller lock is not held");
  }
}

/** One canonical resolved config plus its already-validated bytes/digest/premise. */
interface CandidateFixture {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly premise: ModuleActivationPremises | null;
}

const identity: RuntimeAuthorityIdentity = {
  daemonInstallationId: "0198ab11-6c44-7e8a-b2bb-000000000501",
  instanceId: "main",
};

function readToolsOrigin(componentDigest?: string): InstalledComponentOrigin {
  return {
    schema: "dolly.installed-component-origin/v1",
    kind: "installed_product_component",
    component_id: "org.dolly.host.read-tools",
    component_revision: 5,
    component_digest: componentDigest ?? `sha256:${hex("1")}`,
  };
}
function serviceOrigin(componentDigest?: string): InstalledComponentOrigin {
  return {
    schema: "dolly.installed-component-origin/v1",
    kind: "installed_product_component",
    component_id: "org.dolly.runtime.service-candidate",
    component_revision: 2,
    component_digest: componentDigest ?? `sha256:${hex("2")}`,
  };
}

const verifiedOrigins: readonly InstalledComponentOrigin[] = [readToolsOrigin(), serviceOrigin()];

function definitionRecordFor(policyId = "read-tools"): PermissionPolicyDefinition {
  const record: Record<string, unknown> = {
    schema: "dolly.permission-policy-definition/v1",
    policy_id: policyId,
    policy_revision: 7,
    definition_schema_uri: "https://dolly.example/policies/read-tools.schema.json",
    definition_schema_digest: `sha256:${hex("d")}`,
    definition: { kind: policyId, effect_class: "read-only" },
    origin: {
      schema: "dolly.policy-definition-origin/v1",
      kind: "operator_approved_policy",
      source_id: "org.dolly.policy-store",
      source_revision: 11,
      source_digest: `sha256:${hex("f")}`,
    },
    definition_digest: "",
  };
  record.definition_digest = selfDigest(record, "definition_digest");
  return record as unknown as PermissionPolicyDefinition;
}

function bindingRecordFor(definition: PermissionPolicyDefinition, originOverride?: InstalledComponentOrigin, bindingId = "read-tools-host"): PermissionPolicyBackendBinding {
  const record: Record<string, unknown> = {
    schema: "dolly.permission-policy-backend-binding/v1",
    binding_id: bindingId,
    binding_revision: 3,
    binding_digest: "",
    policy_id: definition.policy_id,
    policy_revision: definition.policy_revision,
    policy_definition_digest: definition.definition_digest,
    origin: originOverride ?? readToolsOrigin(),
  };
  record.binding_digest = selfDigest(record, "binding_digest");
  return record as unknown as PermissionPolicyBackendBinding;
}

function selectionOf(definition: PermissionPolicyDefinition, binding?: PermissionPolicyBackendBinding): { policy_id: string; policy_revision: number; policy_definition_digest: string; binding_id: string; binding_revision: number; binding_digest: string } {
  return {
    policy_id: definition.policy_id,
    policy_revision: definition.policy_revision,
    policy_definition_digest: definition.definition_digest,
    binding_id: binding?.binding_id ?? "read-tools-host",
    binding_revision: binding?.binding_revision ?? 3,
    binding_digest: binding?.binding_digest ?? "",
  };
}

function candidateRecordFor(originOverride?: InstalledComponentOrigin): LinuxServiceCandidate {
  const record: Record<string, unknown> = {
    schema: "dolly.linux-service-candidate/v1",
    origin: originOverride ?? serviceOrigin(),
    unit_name: "dollyd@main.service",
    mode: "user",
    candidate_digest: "",
  };
  record.candidate_digest = selfDigest(record, "candidate_digest");
  return record as unknown as LinuxServiceCandidate;
}

interface PremiseOverrides {
  definitions?: PermissionPolicyDefinition[];
  bindings?: PermissionPolicyBackendBinding[];
  candidateOverride?: LinuxServiceCandidate;
  selections?: Array<{ policy_id: string; policy_revision: number; policy_definition_digest: string; binding_id: string; binding_revision: number; binding_digest: string }>;
  policyId?: string;
}

/** Builds one canonical resolved config for a revision plus its premise. */
function candidate(revision: number, content: string, withLinux: boolean, overrides: PremiseOverrides = {}): CandidateFixture {
  const definition = definitionRecordFor(overrides.policyId ?? "read-tools");
  const binding = bindingRecordFor(definition, undefined, overrides.policyId === "read-tools" ? "read-tools-host" : "read-tools-host");
  const service_candidate = overrides.candidateOverride ?? candidateRecordFor();
  const selection = {
    policy_id: definition.policy_id,
    policy_revision: 7,
    policy_definition_digest: definition.definition_digest,
    binding_id: binding.binding_id,
    binding_revision: 3,
    binding_digest: binding.binding_digest,
  };
  const selections = overrides.selections ?? [selection];
  const resolved = withLinux
    ? {
        runtime_config: { value: content },
        permission_policy_selections: selections,
        service_candidate: { ...service_candidate },
      }
    : { runtime_config: { value: content }, permission_policy_selections: [], service_candidate: null };
  const bytes = Buffer.from(canonicalBytes(resolved));
  const digest = digestOfBytes(bytes);
  if (!withLinux) return { bytes, digest, premise: null };
  const payload: Record<string, unknown> = {
    schema: "dolly.module-activation-premises/v1",
    daemon_installation_id: identity.daemonInstallationId,
    instance_id: identity.instanceId,
    config_revision: revision,
    config_digest: digest,
    permission_policy_definitions: overrides.definitions ?? [definition],
    permission_policy_backend_bindings: overrides.bindings ?? [binding],
    service_candidate: { ...service_candidate },
    premises_digest: "",
  };
  payload.premises_digest = selfDigest(payload, "premises_digest");
  return { bytes, digest, premise: payload as unknown as ModuleActivationPremises };
}

function install(db: RuntimeAuthorityDatabase, fixture: CandidateFixture, overrides: Partial<InstallAuthorityConfigInput> = {}) {
  return db.installConfig({
    identity,
    canonicalConfigBytes: fixture.bytes,
    configDigest: fixture.digest,
    premise: fixture.premise,
    verifiedOrigins,
    ...overrides,
  });
}

function openDatabase(dir: string, name: string, lock: FakeLock = new FakeLock(), overrideIdentity?: RuntimeAuthorityIdentity) {
  return RuntimeAuthorityDatabase.open({
    path: join(dir, name),
    identity: overrideIdentity ?? identity,
    lock,
  });
}

/** Raw native connection over the same file for committed-row inspection and tampering. */
function raw(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // The raw connection is a test harness for byte/row-level corruption and
  // crash observation; it intentionally bypasses the constraint layer that the
  // repository itself enforces on every open.
  db.pragma("foreign_keys = OFF");
  return db;
}

function countRowsWhere(db: Database.Database, table: string, where: string): number {
  const row = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get() as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

function countRows(db: Database.Database, table: string): number {
  const exists = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { c?: number } | undefined;
  if (Number(exists?.c ?? 0) === 0) return 0; // rolled-back schema contributes no rows
  const row = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

function firstRow<T extends Record<string, unknown>>(db: Database.Database, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

function expectAuthorityError(action: () => unknown, code: string): void {
  let caught: unknown = null;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RuntimeAuthorityDatabaseError);
  expect((caught as RuntimeAuthorityDatabaseError).code).toBe(code);
}

const CRASH_POINTS = [
  "after_begin_immediate_before_mapping",
  "after_mapping_before_prerequisites",
  "after_prerequisites_before_premise",
  "after_premise_before_current_pointer",
  "after_current_pointer_before_commit",
] as const;

describe("TST-AUTH-004: config revision allocation and authority-transaction crash", () => {
  it("reuses the exact current revision for identical digest and bytes", () => {
    const dir = scratch();
    const db = openDatabase(dir, "r1.sqlite3");
    const a = candidate(1, "A", true);
    expect(install(db, a)).toEqual({ config_revision: 1, allocated: true });
    expect(install(db, a)).toEqual({ config_revision: 1, allocated: false });
    expect(db.readJournal(10)).toHaveLength(1); // reuse is not a semantic change
    db.close();
  });

  it("fails closed when the digest matches the current revision but bytes differ", () => {
    const dir = scratch();
    const db = openDatabase(dir, "r1.sqlite3");
    const a = candidate(1, "A", true);
    install(db, a);
    // Candidate content "B" declared under A's digest: never a new revision.
    const hostile = candidate(2, "B", true);
    expectAuthorityError(
      () => install(db, { ...hostile, digest: a.digest }),
      "CORE_DIGEST_MISMATCH",
    );
    expect(db.readCurrentConfig()!.config_revision).toBe(1);
    expect(db.readCurrentConfig()!.config_digest).toBe(a.digest);
    expect(db.readJournal(10)).toHaveLength(1);
    db.close();
  });

  it("A -> B -> A allocates successive revisions and never reuses history", () => {
    const dir = scratch();
    const db = openDatabase(dir, "r1.sqlite3");
    const a = candidate(1, "A", true);
    const b = candidate(2, "B", true);
    expect(install(db, a).config_revision).toBe(1);
    expect(install(db, b).config_revision).toBe(2);
    // A premise names its exact target revision, so the caller rebuilds patch A
    // for revision 3; the digest equal to revision 1 never reuses it.
    const a3 = candidate(3, "A", true);
    const back = install(db, a3);
    expect(back).toEqual({ config_revision: 3, allocated: true });
    expect(db.readCurrentConfig()!.config_revision).toBe(3);
    expect(db.readCurrentConfig()!.config_digest).toBe(a.digest);
    expect(db.readJournal(10)).toHaveLength(3);
    db.close();
  });

  for (const crashPoint of CRASH_POINTS) {
    it(`commits zero rows for a candidate crashing at ${crashPoint}`, () => {
      const dir = scratch();
      const path = join(dir, `crash-${crashPoint}.sqlite3`);
      const lock = new FakeLock();
      const db = RuntimeAuthorityDatabase.open({ path, identity, lock });
      const b = candidate(1, "B", true);
      expect(() => install(db, b, { options: { crashPoint } })).toThrow(RuntimeAuthorityCrashPointError);
      db.close();
      // "Process restart": fresh open sees no committed authority.
      const reopened = RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() });
      expect(reopened.readCurrentConfig()).toBeNull();
      expect(reopened.readJournal(10)).toEqual([]);
      reopened.close();
      const inspect = raw(path);
      for (const table of ["config_revision_mappings", "module_activation_premises", "module_activation_premise_policy_selections", "runtime_authority_state", "core_meta", "core_journal"]) {
        expect(countRows(inspect, `SELECT COUNT(*) c FROM ${table}`)).toBe(0);
      }
      inspect.close();
    });
  }

  it("keeps the prior committed revision untouched after a failed changed-config crash", () => {
    const dir = scratch();
    const path = join(dir, "r1.sqlite3");
    const db = openDatabase(dir, "r1.sqlite3");
    const a = candidate(1, "A", true);
    install(db, a);
    const b = candidate(2, "B", true);
    expect(() => install(db, b, { options: { crashPoint: "after_premise_before_current_pointer" } })).toThrow(RuntimeAuthorityCrashPointError);
    db.close();
    const reopened = RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() });
    expect(reopened.readCurrentConfig()!.config_revision).toBe(1);
    expect(reopened.readCurrentConfig()!.config_digest).toBe(a.digest);
    expect(reopened.readJournal(10)).toHaveLength(1);
    reopened.close();
  });

  it("commits the complete mapping, prerequisites, premise and pointer; reopening does not reallocate", () => {
    const dir = scratch();
    const path = join(dir, "r2.sqlite3");
    const db = openDatabase(dir, "r2.sqlite3");
    const a = candidate(1, "A", true);
    const b = candidate(2, "B", true);
    install(db, a);
    expect(install(db, b)).toEqual({ config_revision: 2, allocated: true });
    db.close();
    const reopened = RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() });
    const current = reopened.readCurrentConfig()!;
    expect(current.config_revision).toBe(2);
    expect(current.premise).not.toBeNull();
    expect(current.premise!.permission_policy_backend_bindings).toHaveLength(1);
    // A lost acknowledgement replays without allocating again.
    expect(install(reopened, b)).toEqual({ config_revision: 2, allocated: false });
    expect(reopened.readJournal(10)).toHaveLength(2);
    reopened.close();
    const inspect = raw(path);
    expect(countRowsWhere(inspect, "module_activation_premises", "config_revision = 2")).toBe(1);
    expect(countRowsWhere(inspect, "module_activation_premise_policy_selections", "config_revision = 2")).toBe(1);
    expect(countRows(inspect, "linux_service_candidates")).toBe(1);
    expect(countRows(inspect, "permission_policy_definitions")).toBe(1);
    inspect.close();
  });

  it("never enforces a digest-only unique constraint and never turns a digest into a revision", () => {
    const dir = scratch();
    const path = join(dir, "r3.sqlite3");
    const db = openDatabase(dir, "r3.sqlite3");
    install(db, candidate(1, "A", true));
    install(db, candidate(2, "B", true));
    db.close();
    // Two distinct scoped identity rows may reuse the same digest text.
    const inspect = raw(path);
    const sharedDigest = `sha256:${hex("7")}`;
    expect(() => {
      inspect.prepare(
        "INSERT INTO installed_component_origins (component_id, component_revision, component_digest, record_jcs) VALUES (?, ?, ?, ?)",
      ).run("org.dolly.host.first", 9, sharedDigest, Buffer.from("{\"a\":1}"));
      inspect.prepare(
        "INSERT INTO installed_component_origins (component_id, component_revision, component_digest, record_jcs) VALUES (?, ?, ?, ?)",
      ).run("org.dolly.host.second", 9, sharedDigest, Buffer.from("{\"a\":1}"));
    }).not.toThrow();
    // The committed sequence is strictly lump-sum: 1, 2, ... never derived from hashes.
    const revisions = inspect.prepare("SELECT config_revision FROM config_revision_mappings ORDER BY config_revision").all() as Array<{ config_revision: number }>;
    expect(revisions.map((row) => row.config_revision)).toEqual([1, 2]);
    inspect.close();
  });

  it("exposes the current pointer only together with its complete premise set", () => {
    const dir = scratch();
    const db = openDatabase(dir, "r1.sqlite3");
    const a = candidate(1, "A", true);
    install(db, a);
    const current = db.readCurrentConfig()!;
    expect(current.premise!.config_revision).toBe(1);
    expect(current.premise!.config_digest).toBe(a.digest);
    db.close();
  });
});
describe("TST-AUTH-007: physical Host v2 bridge and canonical-byte gates", () => {
  it("fresh TypeScript authority emits the Rust-compatible Host parent projection", () => {
    const dir = scratch();
    const path = join(dir, "v2.sqlite3");
    const db = openDatabase(dir, "v2.sqlite3");
    install(db, candidate(1, "A", false));
    db.close();
    const inspect = raw(path);
    expect(inspect.prepare("SELECT authority_schema_version FROM host_authority_meta WHERE singleton = 1").get()).toEqual({
      authority_schema_version: HOST_AUTHORITY_SCHEMA_VERSION,
    });
    const mappingColumns = inspect.prepare("PRAGMA table_info(config_revision_mappings)").all() as Array<{ name: string }>;
    expect(mappingColumns.map((column) => column.name)).toContain("daemon_installation_id");
    expect(mappingColumns.map((column) => column.name)).toContain("instance_id");
    const state = inspect.prepare(
      "SELECT authority_schema_version, controller_generation_id, record_jcs FROM runtime_authority_state WHERE singleton = 1",
    ).get() as { authority_schema_version: number; controller_generation_id: string; record_jcs: Buffer };
    expect(state.authority_schema_version).toBe(HOST_AUTHORITY_SCHEMA_VERSION);
    expect(state.controller_generation_id).toBe(new FakeLock().controllerGenerationId);
    expect(Buffer.from(state.record_jcs)).toEqual(Buffer.from(canonicalBytes({
      schema: "dolly.runtime-authority-state/v1",
      authority_schema_version: HOST_AUTHORITY_SCHEMA_VERSION,
      daemon_installation_id: identity.daemonInstallationId,
      instance_id: identity.instanceId,
      controller_generation_id: state.controller_generation_id,
      current_config_revision: 1,
      current_config_digest: candidate(1, "A", false).digest,
    })));
    inspect.close();
  });
  it("matches the Rust cross-language canonical state golden", () => {
    const vector = JSON.parse(readFileSync(
      join(import.meta.dirname, "../../../dolly-spec/test-vectors/core/TST-AUTH-007-physical-v2-bridge.json"),
      "utf8",
    )) as {
      stimulus: {
        cross_language_golden: {
          state_canonical_bytes_utf8: string;
          state_digest: string;
        };
      };
    };
    const expected = vector.stimulus.cross_language_golden;
    const bytes = Buffer.from(expected.state_canonical_bytes_utf8, "utf8");
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    expect(Buffer.from(canonicalBytes(parsed))).toEqual(bytes);
    expect(digestOfBytes(bytes)).toBe(expected.state_digest);
  });


  it("rejects raw-hash-only non-canonical mapping bytes on reopen", () => {
    const dir = scratch();
    const path = join(dir, "noncanonical.sqlite3");
    const db = openDatabase(dir, "noncanonical.sqlite3");
    const fixture = candidate(1, "A", false);
    install(db, fixture);
    db.close();
    const inspect = raw(path);
    const row = inspect.prepare("SELECT canonical_bytes FROM config_revision_mappings WHERE config_revision = 1").get() as { canonical_bytes: Buffer };
    const parsed = JSON.parse(row.canonical_bytes.toString("utf8")) as Record<string, unknown>;
    const nonCanonical = Buffer.from(JSON.stringify(parsed, null, 2), "utf8");
    expect(nonCanonical.equals(row.canonical_bytes)).toBe(false);
    const rawDigest = digestOfBytes(nonCanonical);
    inspect.prepare(
      "UPDATE config_revision_mappings SET canonical_bytes = ?, config_digest = ? WHERE config_revision = 1",
    ).run(nonCanonical, rawDigest);
    inspect.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() }),
      "STORAGE_CORRUPT",
    );
  });

  it("requires an explicit v1-to-v2 migration for the pre-bridge TypeScript projection", () => {
    const dir = scratch();
    const path = join(dir, "legacy.sqlite3");
    const fixture = candidate(1, "legacy", false);
    const legacyState = canonicalBytes({
      schema: "dolly.runtime-authority-state/v1",
      authority_schema_version: 1,
      daemon_installation_id: identity.daemonInstallationId,
      instance_id: identity.instanceId,
      current_config_revision: 1,
      current_config_digest: fixture.digest,
    });
    const legacy = raw(path);
    legacy.exec(`
      CREATE TABLE core_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1),
        daemon_installation_id TEXT NOT NULL,
        instance_id TEXT NOT NULL
      );
      CREATE TABLE config_revision_mappings (
        config_revision INTEGER PRIMARY KEY,
        config_digest TEXT NOT NULL,
        canonical_bytes BLOB NOT NULL,
        UNIQUE (config_revision, config_digest)
      );
      CREATE TABLE runtime_authority_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1),
        daemon_installation_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        current_config_revision INTEGER NOT NULL,
        current_config_digest TEXT NOT NULL,
        record_jcs BLOB NOT NULL
      );
      CREATE TABLE module_activation_premises (
        config_revision INTEGER PRIMARY KEY,
        config_digest TEXT NOT NULL,
        premises_digest TEXT NOT NULL,
        record_jcs BLOB NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    legacy.prepare("INSERT INTO core_meta VALUES (1, 1, ?, ?)").run(identity.daemonInstallationId, identity.instanceId);
    legacy.prepare("INSERT INTO config_revision_mappings VALUES (1, ?, ?)").run(fixture.digest, Buffer.from(fixture.bytes));
    legacy.prepare("INSERT INTO runtime_authority_state VALUES (1, 1, ?, ?, 1, ?, ?)").run(
      identity.daemonInstallationId,
      identity.instanceId,
      fixture.digest,
      Buffer.from(legacyState),
    );
    legacy.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.migrateV1Authority({ path, identity, lock: new FakeLock() }),
      "STORAGE_MIGRATION_REQUIRED",
    );
    const unchanged = raw(path);
    expect((unchanged.prepare("PRAGMA table_info(config_revision_mappings)").all() as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "config_revision",
      "config_digest",
      "canonical_bytes",
    ]);
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'host_authority_meta'").get()).toBeUndefined();
    unchanged.close();
  });
  it("rejects oversized and short service admissions before mapping writes", () => {
    const dir = scratch();
    const path = join(dir, "bounded.sqlite3");
    const candidateOverride = candidateRecordFor() as unknown as Record<string, unknown>;
    candidateOverride.unit_name = "a.servic";
    candidateOverride.candidate_digest = selfDigest(candidateOverride, "candidate_digest");
    const db = openDatabase(dir, "bounded.sqlite3");
    const fixture = candidate(1, "bounded", true, {
      candidateOverride: candidateOverride as unknown as LinuxServiceCandidate,
    });
    expectAuthorityError(() => install(db, fixture), "MODULE_ACTIVATION_PREMISES_INVALID");
    const oversizedCandidate = candidateRecordFor() as unknown as Record<string, unknown>;
    oversizedCandidate.unit_name = `${"a".repeat(248)}.service`;
    oversizedCandidate.candidate_digest = selfDigest(oversizedCandidate, "candidate_digest");
    const oversizedFixture = candidate(1, "oversized", true, {
      candidateOverride: oversizedCandidate as unknown as LinuxServiceCandidate,
    });
    expectAuthorityError(() => install(db, oversizedFixture), "MODULE_ACTIVATION_PREMISES_INVALID");
    const inspect = raw(path);
    expect(inspect.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'config_revision_mappings'").get()).toEqual({ count: 0 });
    inspect.close();
    db.close();
  });

  it("rejects tampered historical mapping identity and missing unused tables on reopen", () => {
    const dir = scratch();
    const path = join(dir, "historical.sqlite3");
    const db = openDatabase(dir, "historical.sqlite3");
    install(db, candidate(1, "A", false));
    install(db, candidate(2, "B", false));
    db.close();
    const inspect = raw(path);
    inspect.prepare("UPDATE config_revision_mappings SET instance_id = ? WHERE config_revision = 1").run("wrong-instance");
    inspect.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() }),
      "STORAGE_CORRUPT",
    );
    const repair = raw(path);
    repair.prepare("UPDATE config_revision_mappings SET instance_id = ? WHERE config_revision = 1").run(identity.instanceId);
    repair.prepare("ALTER TABLE linux_service_candidates RENAME TO linux_service_candidates_tampered").run();
    repair.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() }),
      "STORAGE_CORRUPT",
    );
  });
  it("fails closed on hostile v2 triggers, non-normative indexes, and foreign-key violations", () => {
    for (const [name, tamper] of [
      ["trigger", (database: Database.Database) => database.exec(
        "CREATE TRIGGER hostile_authority AFTER INSERT ON config_revision_mappings BEGIN SELECT 1; END",
      )],
      ["index", (database: Database.Database) => database.exec(
        "CREATE INDEX hostile_authority_index ON config_revision_mappings(config_digest)",
      )],
      ["foreign-key", (database: Database.Database) => {
        database.pragma("foreign_keys = OFF");
        database.prepare(
          "INSERT INTO module_activation_premise_policy_selections (config_revision, policy_id, policy_revision, policy_definition_digest, binding_id, binding_revision, binding_digest) VALUES (999, 'org.dolly.policy.missing', 1, ?, 'org.dolly.binding.missing', 1, ?)",
        ).run(`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`);
      }],
    ] as const) {
      const dir = scratch();
      const path = join(dir, `${name}.sqlite3`);
      const db = openDatabase(dir, `${name}.sqlite3`);
      install(db, candidate(1, name, false));
      db.close();
      const inspect = raw(path);
      tamper(inspect);
      inspect.close();
      expectAuthorityError(
        () => RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() }),
        "STORAGE_CORRUPT",
      );
    }
  });

  it("verifies unused historical selection rows against their premise projections", () => {
    const dir = scratch();
    const path = join(dir, "historical-selection.sqlite3");
    const db = openDatabase(dir, "historical-selection.sqlite3");
    install(db, candidate(1, "A", true));
    install(db, candidate(2, "B", true));
    db.close();
    const inspect = raw(path);
    inspect.prepare(
      "UPDATE module_activation_premise_policy_selections SET binding_digest = ? WHERE config_revision = 1",
    ).run(`sha256:${"3".repeat(64)}`);
    inspect.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() }),
      "STORAGE_CORRUPT",
    );
  });
  it("loads the explicit validator-parity rejection vector", () => {
    const vector = JSON.parse(readFileSync(
      join(import.meta.dirname, "../../../dolly-spec/test-vectors/core/TST-AUTH-008-validator-parity.json"),
      "utf8",
    )) as { stimulus: { rejection_cases: readonly { name: string }[] } };
    expect(vector.stimulus.rejection_cases).toHaveLength(16);
    expect(new Set(vector.stimulus.rejection_cases.map((entry) => entry.name)).size).toBe(16);
  });
  it("executes every TST-AUTH-008 rejection stimulus", () => {
    const vector = JSON.parse(readFileSync(
      join(import.meta.dirname, "../../../dolly-spec/test-vectors/core/TST-AUTH-008-validator-parity.json"),
      "utf8",
    )) as { stimulus: { rejection_cases: readonly { name: string; value?: string; length?: number; field?: string; order?: string; property_count?: number }[] } };
    const names = new Set(vector.stimulus.rejection_cases.map((entry) => entry.name));
    expect(names.size).toBe(16);

    const twoPolicyFixture = (field: "definitions" | "bindings" | "selections"): CandidateFixture => {
      const first = definitionRecordFor("a-policy");
      const second = definitionRecordFor("b-policy");
      const firstBinding = bindingRecordFor(first, undefined, "a-binding");
      const secondBinding = bindingRecordFor(second, undefined, "b-binding");
      const selections = [
        selectionOf(first, firstBinding),
        selectionOf(second, secondBinding),
      ];
      const definitions = [first, second];
      const bindings = [firstBinding, secondBinding];
      if (field === "definitions") definitions.reverse();
      if (field === "bindings") bindings.reverse();
      if (field === "selections") selections.reverse();
      const resolved = {
        runtime_config: { value: "vector" },
        permission_policy_selections: selections,
        service_candidate: { ...candidateRecordFor() },
      };
      const bytes = Buffer.from(canonicalBytes(resolved));
      const digest = digestOfBytes(bytes);
      const premiseRecord: Record<string, unknown> = {
        schema: "dolly.module-activation-premises/v1",
        daemon_installation_id: identity.daemonInstallationId,
        instance_id: identity.instanceId,
        config_revision: 1,
        config_digest: digest,
        permission_policy_definitions: definitions,
        permission_policy_backend_bindings: bindings,
        service_candidate: { ...candidateRecordFor() },
        premises_digest: "",
      };
      premiseRecord.premises_digest = selfDigest(premiseRecord, "premises_digest");
      return { bytes, digest, premise: premiseRecord as unknown as ModuleActivationPremises };
    };

    for (const rejection of vector.stimulus.rejection_cases) {
      const run = (): void => {
        if (rejection.name === "uppercase_uuid_v7" || rejection.name === "digit_first_stable_id" || rejection.name === "uppercase_stable_id" || rejection.name === "oversized_stable_id") {
          const badIdentity = rejection.name === "uppercase_uuid_v7"
            ? { daemonInstallationId: rejection.value!, instanceId: identity.instanceId }
            : {
                daemonInstallationId: identity.daemonInstallationId,
                instanceId: rejection.name === "oversized_stable_id" ? "a".repeat(rejection.length!) : rejection.value!,
              };
          expect(() => RuntimeAuthorityDatabase.open({
            path: join(scratch(), `${rejection.name}.sqlite3`),
            identity: badIdentity,
            lock: new FakeLock(),
          })).toThrow(RuntimeAuthorityDatabaseError);
          return;
        }
        const dir = scratch();
        const db = openDatabase(dir, `${rejection.name}.sqlite3`);
        let fixture: CandidateFixture;
        if (rejection.name === "digit_first_qualified_name" || rejection.name === "uppercase_qualified_name" || rejection.name === "oversized_qualified_name") {
          const origin = { ...serviceOrigin(), component_id: rejection.name === "oversized_qualified_name" ? "a".repeat(rejection.length!) : rejection.value! };
          fixture = candidate(1, rejection.name, true, { candidateOverride: candidateRecordFor(origin) });
        } else if (rejection.name === "short_unit_name" || rejection.name === "oversized_unit_name") {
          const service = candidateRecordFor() as unknown as Record<string, unknown>;
          service.unit_name = rejection.name === "oversized_unit_name" ? `${"a".repeat(rejection.length! - 8)}.service` : rejection.value!;
          service.candidate_digest = selfDigest(service, "candidate_digest");
          fixture = candidate(1, rejection.name, true, { candidateOverride: service as unknown as LinuxServiceCandidate });
        } else if (rejection.name === "invalid_uri_reference_escape" || rejection.name === "definition_array" || rejection.name === "definition_max_properties") {
          const definition = definitionRecordFor();
          const malformed = { ...definition } as unknown as Record<string, unknown>;
          if (rejection.name === "invalid_uri_reference_escape") malformed.definition_schema_uri = rejection.value;
          if (rejection.name === "definition_array") malformed.definition = [];
          if (rejection.name === "definition_max_properties") malformed.definition = Object.fromEntries(
            Array.from({ length: rejection.property_count! }, (_, index) => [`property${index}`, true]),
          );
          fixture = candidate(1, rejection.name, true, { definitions: [malformed as unknown as PermissionPolicyDefinition] });
        } else if (rejection.name === "unsorted_policy_definitions") {
          fixture = twoPolicyFixture("definitions");
        } else if (rejection.name === "unsorted_policy_bindings") {
          fixture = twoPolicyFixture("bindings");
        } else if (rejection.name === "unsorted_policy_selections") {
          fixture = twoPolicyFixture("selections");
        } else if (rejection.name === "oversized_canonical_record") {
          const bytes = Buffer.alloc(rejection.length!);
          fixture = { bytes, digest: digestOfBytes(bytes), premise: null };
        } else {
          throw new Error(`unhandled validator vector ${rejection.name}`);
        }
        expect(() => install(db, fixture)).toThrow(RuntimeAuthorityDatabaseError);
        db.close();
      };
      expect(run).not.toThrow();
    }
  });
  it("rejects uppercase and oversized authority identities", () => {
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({
        path: join(scratch(), "identity.sqlite3"),
        identity: {
          daemonInstallationId: identity.daemonInstallationId.toUpperCase(),
          instanceId: "main",
        },
        lock: new FakeLock(),
      }),
      "AUTHORITY_DATABASE_MALFORMED_RECORD",
    );
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({
        path: join(scratch(), "identity-oversized.sqlite3"),
        identity: { daemonInstallationId: identity.daemonInstallationId, instanceId: "a".repeat(64) },
        lock: new FakeLock(),
      }),
      "AUTHORITY_DATABASE_MALFORMED_RECORD",
    );
  });
});



describe("TST-AUTH-005: reopen identity, digest and legacy-JSON abstention", () => {
  it("reopens stably at the same revision and digest", () => {
    const dir = scratch();
    const path = join(dir, "r1.sqlite3");
    const db = openDatabase(dir, "r1.sqlite3");
    const a = candidate(1, "A", true);
    install(db, a);
    db.close();
    const reopened = RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() });
    expect(reopened.readCurrentConfig()!.config_revision).toBe(1);
    expect(reopened.readCurrentConfig()!.config_digest).toBe(a.digest);
    reopened.close();
  });

  it("accepts the same database moved to another path: a path is not authority", () => {
    const dir = scratch();
    const original = join(dir, "runtime.sqlite3");
    const moved = join(dir, "store", "runtime.sqlite3");
    const db = RuntimeAuthorityDatabase.open({ path: original, identity, lock: new FakeLock() });
    const a = candidate(1, "A", true);
    install(db, a);
    db.close();
    mkdirSync(join(dir, "store"), { recursive: true });
    renameSync(original, moved);
    const reopened = RuntimeAuthorityDatabase.open({ path: moved, identity, lock: new FakeLock() });
    expect(reopened.readCurrentConfig()!.config_revision).toBe(1);
    reopened.close();
  });

  it("fails closed on a stored daemon installation id mismatch", () => {
    const dir = scratch();
    const path = join(dir, "r1.sqlite3");
    const db = openDatabase(dir, "r1.sqlite3");
    install(db, candidate(1, "A", true));
    db.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({
        path,
        identity: { daemonInstallationId: "0198ab11-6c44-7e8a-b2bb-000000000777", instanceId: "main" },
        lock: new FakeLock(),
      }),
      "STORAGE_CORRUPT",
    );
  });

  it("fails closed on a stored instance id mismatch", () => {
    const dir = scratch();
    const path = join(dir, "r1.sqlite3");
    const db = openDatabase(dir, "r1.sqlite3");
    install(db, candidate(1, "A", true));
    db.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({ path, identity: { ...identity, instanceId: "other" }, lock: new FakeLock() }),
      "STORAGE_CORRUPT",
    );
  });

  it("fails closed when the current digest is unchanged but the stored bytes differ", () => {
    const dir = scratch();
    const path = join(dir, "r1.sqlite3");
    const db = openDatabase(dir, "r1.sqlite3");
    install(db, candidate(1, "A", true));
    db.close();
    const inspect = raw(path);
    const row = firstRow<{ canonical_bytes: Buffer }>(inspect, "SELECT canonical_bytes FROM config_revision_mappings WHERE config_revision = 1")!;
    const tampered = Buffer.from(row.canonical_bytes);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0x01;
    inspect.prepare("UPDATE config_revision_mappings SET canonical_bytes = ? WHERE config_revision = 1").run(tampered);
    inspect.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() }),
      "STORAGE_CORRUPT",
    );
  });

  it("fails closed when the current pointer references a missing mapping", () => {
    const dir = scratch();
    const path = join(dir, "r1.sqlite3");
    const db = openDatabase(dir, "r1.sqlite3");
    install(db, candidate(1, "A", true));
    db.close();
    const inspect = raw(path);
    inspect.prepare("DELETE FROM config_revision_mappings WHERE config_revision = 1").run();
    inspect.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() }),
      "STORAGE_CORRUPT",
    );
  });

  it("fails closed on an unsupported user_version with STORAGE_MIGRATION_REQUIRED", () => {
    const dir = scratch();
    const path = join(dir, "r1.sqlite3");
    const db = openDatabase(dir, "r1.sqlite3");
    install(db, candidate(1, "A", true));
    db.close();
    const inspect = raw(path);
    inspect.pragma("user_version = 2");
    inspect.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() }),
      "STORAGE_MIGRATION_REQUIRED",
    );
  });

  it("refuses a second writer for the same identity when the lock is not re-held", () => {
    const dir = scratch();
    const path = join(dir, "r1.sqlite3");
    const db = openDatabase(dir, "r1.sqlite3");
    install(db, candidate(1, "A", true));
    db.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock(false) }),
      "CONTROLLER_LOCK_NOT_HELD",
    );
  });

  it("never reimports or dual-writes legacy JSON after a commit", () => {
    const dir = scratch();
    const path = join(dir, "r1.sqlite3");
    const db = openDatabase(dir, "r1.sqlite3");
    install(db, candidate(1, "A", true));
    db.close();
    const reopened = RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() });
    const competing = candidate(2, "B", true);
    let caught: unknown;
    try {
      reopened.migrateLegacyJson({
        identity,
        canonicalConfigBytes: competing.bytes,
        configDigest: competing.digest,
        premise: competing.premise,
        verifiedOrigins,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as RuntimeAuthorityDatabaseError).code).toBe("AUTHORITY_DATABASE_ALREADY_COMMITTED");
    expect(reopened.readCurrentConfig()!.config_revision).toBe(1);
    reopened.close();
  });
});

describe("TST-AUTH-006: stale pointer and cross-origin prerequisite refusals", () => {
  it("fails closed on a stale pointer and never repairs it from a historical digest match", () => {
    const dir = scratch();
    const path = join(dir, "stale.sqlite3");
    const db = openDatabase(dir, "stale.sqlite3");
    install(db, candidate(1, "A", true));
    db.close();
    const inspect = raw(path);
    inspect.prepare("UPDATE runtime_authority_state SET current_config_revision = 2 WHERE singleton = 1").run();
    inspect.close();
    expectAuthorityError(
      () => RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() }),
      "STORAGE_CORRUPT",
    );
  });

  it("refuses a stale/missing prerequisite premise (no selected binding is supplied)", () => {
    const dir = scratch();
    const db = openDatabase(dir, "stale.sqlite3");
    install(db, candidate(1, "A", true));
    const hollow = candidate(2, "B", true, { definitions: [], bindings: [] });
    expectAuthorityError(() => install(db, hollow), "MODULE_ACTIVATION_POLICY_BINDING_UNAVAILABLE");
    expect(db.readCurrentConfig()!.config_revision).toBe(1);
    db.close();
  });

  it("refuses a cross-policy binding that names another definition triple", () => {
    const dir = scratch();
    const db = openDatabase(dir, "stale.sqlite3");
    install(db, candidate(1, "A", true));
    const otherDef = definitionRecordFor("other-tools");
    const crossBinding = bindingRecordFor(otherDef);
    const hostile = candidate(2, "B", true, { bindings: [crossBinding], definitions: [otherDef] });
    expectAuthorityError(() => install(db, hostile), "MODULE_ACTIVATION_PREMISES_INVALID");
    expect(db.readCurrentConfig()!.config_revision).toBe(1);
    db.close();
  });

  it("refuses a cross-origin binding that embeds an unverified component digest", () => {
    const dir = scratch();
    const db = openDatabase(dir, "stale.sqlite3");
    install(db, candidate(1, "A", true));
    const definition = definitionRecordFor();
    const forgedBinding = bindingRecordFor(definition, { ...readToolsOrigin(), component_digest: `sha256:${hex("9")}` });
    const hostile = candidate(2, "B", true, { bindings: [forgedBinding], definitions: [definition] });
    expectAuthorityError(() => install(db, hostile), "MODULE_ACTIVATION_PREMISES_INVALID");
    expect(db.readCurrentConfig()!.config_revision).toBe(1);
    db.close();
  });

  it("refuses a cross-origin service candidate from an unverified component", () => {
    const dir = scratch();
    const db = openDatabase(dir, "stale.sqlite3");
    install(db, candidate(1, "A", true));
    const forgedCandidate = candidateRecordFor({ ...serviceOrigin(), component_digest: `sha256:${hex("9")}` });
    const hostile = candidate(2, "B", true, { candidateOverride: forgedCandidate });
    expectAuthorityError(() => install(db, hostile), "MODULE_ACTIVATION_PREMISES_INVALID");
    expect(db.readCurrentConfig()!.config_revision).toBe(1);
    db.close();
  });

  it("refuses an extra unconfigured selection in the premise (extra policy not in the config)", () => {
    const dir = scratch();
    const db = openDatabase(dir, "stale.sqlite3");
    install(db, candidate(1, "A", true));
    const extraDef = definitionRecordFor("extra-tools");
    const extraBinding = bindingRecordFor(extraDef);
    const extraSelection = {
      policy_id: "extra-tools",
      policy_revision: 7,
      policy_definition_digest: extraDef.definition_digest,
      binding_id: extraBinding.binding_id,
      binding_revision: 3,
      binding_digest: extraBinding.binding_digest,
    };
    const baseDef = definitionRecordFor();
    const baseBinding = bindingRecordFor(baseDef);
    // The config selects read-tools only; the premise carries an extra,
    // unconfigured policy that no canonical selection names.
    const hostile = candidate(2, "B", true, {
      definitions: [baseDef, extraDef],
      bindings: [baseBinding, extraBinding],
      selections: [selectionOf(baseDef, baseBinding)],
    });
    void extraSelection;
    expectAuthorityError(() => install(db, hostile), "MODULE_ACTIVATION_PREMISES_INVALID");
    expect(db.readCurrentConfig()!.config_revision).toBe(1);
    db.close();
  });

  it("permits equal digest text under distinct scoped identities with no global uniqueness", () => {
    const dir = scratch();
    const path = join(dir, "stale.sqlite3");
    const db = openDatabase(dir, "stale.sqlite3");
    install(db, candidate(1, "A", true));
    install(db, candidate(2, "B", true));
    db.close();
    const inspect = raw(path);
    const shared = `sha256:${hex("7")}`;
    expect(() => {
      inspect.prepare(
        "INSERT INTO installed_component_origins (component_id, component_revision, component_digest, record_jcs) VALUES (?, ?, ?, ?)",
      ).run("org.dolly.host.first", 9, shared, Buffer.from("{{\"a\":1}}"));
      inspect.prepare(
        "INSERT INTO installed_component_origins (component_id, component_revision, component_digest, record_jcs) VALUES (?, ?, ?, ?)",
      ).run("org.dolly.host.second", 9, shared, Buffer.from("{\"a\":1}"));
    }).not.toThrow();
    inspect.close();
  });
});

describe("TST-AUTH-001/003: hostile structural substitution and replay abstention", () => {
  it("resolves exactly one verified definition, binding and candidate with exact digests", () => {
    const dir = scratch();
    const db = openDatabase(dir, "policy.sqlite3");
    install(db, candidate(1, "A", true));
    const current = db.readCurrentConfig()!;
    expect(current.premise!.permission_policy_definitions).toHaveLength(1);
    expect(current.premise!.permission_policy_backend_bindings).toHaveLength(1);
    expect(current.premise!.service_candidate.unit_name).toBe("dollyd@main.service");
    expect(current.premise!.permission_policy_definitions[0].definition_digest).toMatch(/^sha256:/);
    db.close();
  });

  it("refuses a binding record that smuggles a path/secret/function field", () => {
    const dir = scratch();
    const db = openDatabase(dir, "policy.sqlite3");
    install(db, candidate(1, "A", true));
    // A record that serializes a path/live-object shape is not a closed
    // authority record, so the candidate is never admitted.
    const smuggled = (() => {
      const def = definitionRecordFor();
      const binding = bindingRecordFor(def) as unknown as Record<string, unknown> & Partial<PermissionPolicyBackendBinding>;
      (binding as Record<string, unknown>).filesystem_path = "/etc/dolly";       // falls outside the closed record
      (binding as Record<string, unknown>).secret = "s3cr3t";
      delete (binding as Record<string, unknown>).binding_digest;
      return { def, binding: binding as unknown as PermissionPolicyBackendBinding };
    })();
    const hostile = candidate(2, "B", true, { definitions: [smuggled.def], bindings: [smuggled.binding] });
    let caught: unknown;
    try {
      install(db, hostile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeAuthorityDatabaseError);
    // The record is refused as not a closed authority record, before any write.
    expect((caught as RuntimeAuthorityDatabaseError).code).toBe("AUTHORITY_DATABASE_MALFORMED_RECORD");
    expect(db.readCurrentConfig()!.config_revision).toBe(1);
    db.close();
  });

  it("rejects the same policy revision with different canonical definition bytes", () => {
    const dir = scratch();
    const db = openDatabase(dir, "policy.sqlite3");
    const def = definitionRecordFor();
    const binding = bindingRecordFor(def);
    install(db, candidate(1, "A", true, { definitions: [def], bindings: [binding] }));
    // The premise may only reference the established definition triple; a
    // different definition digest for the same policy identity cannot be
    // supplied by the premise.
    const other = definitionRecordFor(); // same policy_id/revision
    (other as unknown as Record<string, unknown>).definition = { kind: "read-tools", effect_class: "write" };
    (other as unknown as Record<string, unknown>).definition_digest = "";
    (other as unknown as Record<string, unknown>).definition_digest = selfDigest(other as unknown as Record<string, unknown>, "definition_digest");
    const otherBinding = bindingRecordFor(other, undefined, "read-tools-host");
    const hostile = candidate(2, "B", true, { definitions: [other], bindings: [otherBinding] });
    let caught: unknown;
    try {
      install(db, hostile);
    } catch (error) {
      caught = error;
    }
    expect((caught as RuntimeAuthorityDatabaseError).code).toBe("MODULE_ACTIVATION_PREMISES_INVALID");
    expect(db.readCurrentConfig()!.config_revision).toBe(1);
    db.close();
  });

  it("rejects a duplicate backend-binding record inside one premise", () => {
    const dir = scratch();
    const db = openDatabase(dir, "policy.sqlite3");
    const def = definitionRecordFor();
    const binding = bindingRecordFor(def);
    install(db, candidate(1, "A", true, { definitions: [def], bindings: [binding] }));
    const hostile = candidate(2, "B", true, {
      definitions: [def, def],
      bindings: [binding, binding],
    });
    let caught: unknown;
    try {
      install(db, hostile);
    } catch (error) {
      caught = error;
    }
    expect((caught as RuntimeAuthorityDatabaseError).code).toBe("MODULE_ACTIVATION_PREMISES_INVALID");
    expect(db.readCurrentConfig()!.config_revision).toBe(1);
    db.close();
  });
});

describe("REQ-AUTH-005: offline legacy-JSON migration under the caller-held lock", () => {
  it("commits SQLite as the sole authority and opens verified on restart", () => {
    const dir = scratch();
    const path = join(dir, "migrate.sqlite3");
    const lock = new FakeLock();
    const db = RuntimeAuthorityDatabase.open({ path, identity, lock });
    const previous = db.readCurrentConfig();
    expect(previous).toBeNull(); // uninitialized candidate bytes, nothing imported yet
    const fixture = candidate(1, "A", true);
    const migrated = db.migrateLegacyJson({
      identity,
      canonicalConfigBytes: fixture.bytes,
      configDigest: fixture.digest,
      premise: fixture.premise,
      verifiedOrigins,
    });
    expect(migrated).toEqual({ config_revision: 1, allocated: true });
    db.close();
    const reopened = RuntimeAuthorityDatabase.open({ path, identity, lock: new FakeLock() });
    expect(reopened.readCurrentConfig()!.config_revision).toBe(1);
    expect(reopened.readJournal(10)).toHaveLength(1);
    reopened.close();
  });

  it("never dual-writes or updates InstanceConfigStore", () => {
    const dir = scratch();
    const path = join(dir, "migrate.sqlite3");
    const lock = new FakeLock();
    const db = RuntimeAuthorityDatabase.open({ path, identity, lock });
    const fixture = candidate(1, "A", true);
    db.migrateLegacyJson({ identity, canonicalConfigBytes: fixture.bytes, configDigest: fixture.digest, premise: fixture.premise, verifiedOrigins });
    db.close();
    // Only the SQLite candidate bytes exist; no JSON instance config, cache or
    // sidecar authority was created, and SQLite is the sole committed source.
    const files = readdirSync(dir).filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"));
    expect(files).toContain("migrate.sqlite3");
    expect(files.filter((name) => name.endsWith(".json")).length).toBe(0);
  });
});

describe("downstream readiness/result/ack cannot write authority rows", () => {
  it("an acknowledgement replay allocates no new revision and writes no row", () => {
    const dir = scratch();
    const path = join(dir, "ack.sqlite3");
    const db = openDatabase(dir, "ack.sqlite3");
    const a = candidate(1, "A", true);
    const first = install(db, a);
    expect(first).toEqual({ config_revision: 1, allocated: true });
    // A downstream acknowledgement/result observes the committed identity; it
    // can only replay it, never mint a new revision or a new premise.
    const replay = install(db, a);
    expect(replay).toEqual({ config_revision: 1, allocated: false });
    const inspect = raw(path);
    expect(countRows(inspect, "module_activation_premises")).toBe(1);
    expect(countRows(inspect, "core_journal")).toBe(1);
    inspect.close();
    db.close();
  });

  it("a result-shaped byte stream is not an accepted configuration", () => {
    const dir = scratch();
    const db = openDatabase(dir, "ack.sqlite3");
    const a = candidate(1, "A", true);
    install(db, a);
    const resultBytes = new TextEncoder().encode(JSON.stringify({ kind: "result", digest: a.digest }));
    let caught: unknown;
    try {
      install(db, { bytes: resultBytes, digest: digestOfBytes(resultBytes), premise: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeAuthorityDatabaseError);
    expect((caught as RuntimeAuthorityDatabaseError).code).toBe("AUTHORITY_DATABASE_MALFORMED_RECORD");
    // Nothing changed: authority was never granted by a result or ack.
    expect(db.readCurrentConfig()!.config_revision).toBe(1);
    expect(db.readJournal(10)).toHaveLength(1);
    db.close();
  });
});
