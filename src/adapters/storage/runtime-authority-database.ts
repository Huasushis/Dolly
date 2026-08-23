/**
 * H1 Runtime SQLite authority database repository.
 *
 * Owns the durable "Runtime authority database schema version 1" defined in
 * `dolly-spec/docs/spec/core/06-storage-and-recovery.md` section 3.1 and the
 * closed records in `dolly-spec/schemas/runtime-authority-record.schema.json`
 * (spec snapshot 41d6476). It opens the shared database through the H0
 * Host-internal native SQLite loader/attestation adapter, so every open first
 * attests the pinned SQLite build and the durable PRAGMA profile before any
 * repository method runs.
 *
 * Scope boundary: this is an internal storage repository. It does NOT wire the
 * database into the daemon, bootstrap, installed-Linux activation, live binding
 * resolver, or any product composition, and it does not touch
 * `InstanceConfigStore` - legacy JSON import commits SQLite as the sole
 * authority and never dual-writes or updates the JSON instance store.
 *
 * Closed storage contract (REQ-AUTH-002 / INV-AUTH-001, section 3.1):
 * - config revisions are append-only positive integers bound to exact
 *   canonical config bytes and their sha256 digest;
 * - the current pointer and the config-installed journal event commit in the
 *   same `BEGIN IMMEDIATE` transaction, all-or-nothing;
 * - exact current digest AND bytes reuse the current revision; a changed
 *   digest allocates `current + 1`; `A -> B -> A` always allocates a new
 *   revision and never reuses history (no digest-to-integer mapping);
 * - no digest column is globally unique on its own;
 * - the complete Module activation premise is published last, only after all
 *   prerequisite origins, definitions, backend bindings, service candidate and
 *   premise-policy selections, and only as part of the exact current revision.
 */
import { createHash } from "node:crypto";
import { openAttestedNativeSqlite } from "./native-sqlite.js";
import type { NativeSqliteConnection } from "./native-sqlite-binding.js";
import {
  assertCanonicalJsonValue,
  canonicalBytes,
  canonicalJsonDigest,
  parseCanonicalJsonBytes,
  type JsonValue,
} from "../../schema-bundle/index.js";
import {
  FileCoreHistoryError,
  FileCoreHistoryReaderStore,
  FileCoreHistoryStore,
  type FileCoreHistoryOptions,
} from "../../core/file-core-history.js";

/** Largest revision a conforming database may assign (REQ-AUTH-002 step 4). */
export const MAX_CONFIG_REVISION = 9_007_199_254_740_991;

/** `PRAGMA user_version` for the supported Runtime authority schema version 1. */
export const RUNTIME_AUTHORITY_SCHEMA_VERSION = 1;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const QUALIFIED_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/u;
const UNIT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,246}\.service$/u;
const URI_REFERENCE_PATTERN = /^.{1,512}$/us;

export type RuntimeAuthorityDatabaseErrorCode =
  | "CONTROLLER_LOCK_NOT_HELD"
  | "STORAGE_INSTANCE_LOCKED"
  | "STORAGE_CORRUPT"
  | "STORAGE_MIGRATION_REQUIRED"
  | "STORAGE_BUSY"
  | "STORAGE_FULL"
  | "CORE_DIGEST_MISMATCH"
  | "CORE_SEQUENCE_EXHAUSTED"
  | "CONFIG_REVISION_CONFLICT"
  | "MODULE_ACTIVATION_PREMISES_INVALID"
  | "MODULE_ACTIVATION_POLICY_BINDING_UNAVAILABLE"
  | "AUTHORITY_DATABASE_UNINITIALIZED"
  | "AUTHORITY_DATABASE_ALREADY_COMMITTED"
  | "AUTHORITY_DATABASE_MALFORMED_RECORD";

export class RuntimeAuthorityDatabaseError extends Error {
  constructor(
    readonly code: RuntimeAuthorityDatabaseErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RuntimeAuthorityDatabaseError";
  }
}

/** One named point inside the atomic authority transaction where tests crash. */
export class RuntimeAuthorityCrashPointError extends Error {
  constructor(readonly point: string) {
    super(`crash injection at ${point}`);
    this.name = "RuntimeAuthorityCrashPointError";
  }
}

/** The one identity tuple of a Runtime authority database (REQ-AUTH-001). */
export interface RuntimeAuthorityIdentity {
  readonly daemonInstallationId: string;
  readonly instanceId: string;
}

/** Caller-held controller-lock handle the repository asserts before writes. */
export interface RuntimeAuthorityLockHandle {
  readonly held: boolean;
  assertHeld(): void;
}

export interface InstalledComponentOrigin {
  readonly schema: "dolly.installed-component-origin/v1";
  readonly kind: "installed_product_component";
  readonly component_id: string;
  readonly component_revision: number;
  readonly component_digest: string;
}

export interface PolicyDefinitionOrigin {
  readonly schema: "dolly.policy-definition-origin/v1";
  readonly kind: "operator_approved_policy";
  readonly source_id: string;
  readonly source_revision: number;
  readonly source_digest: string;
}

export interface PermissionPolicyDefinition {
  readonly schema: "dolly.permission-policy-definition/v1";
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly definition_schema_uri: string;
  readonly definition_schema_digest: string;
  readonly definition: JsonValue;
  readonly origin: PolicyDefinitionOrigin;
  readonly definition_digest: string;
}

export interface PermissionPolicyBackendBinding {
  readonly schema: "dolly.permission-policy-backend-binding/v1";
  readonly binding_id: string;
  readonly binding_revision: number;
  readonly binding_digest: string;
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly policy_definition_digest: string;
  readonly origin: InstalledComponentOrigin;
}

export interface LinuxServiceCandidate {
  readonly schema: "dolly.linux-service-candidate/v1";
  readonly unit_name: string;
  readonly mode: string;
  readonly origin: InstalledComponentOrigin;
  readonly candidate_digest: string;
}

export interface PermissionPolicySelection {
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly policy_definition_digest: string;
  readonly binding_id: string;
  readonly binding_revision: number;
  readonly binding_digest: string;
}

export interface ResolvedConfiguration {
  readonly runtime_config: JsonValue;
  readonly permission_policy_selections: readonly PermissionPolicySelection[];
  readonly service_candidate: LinuxServiceCandidate | null;
}

export interface ModuleActivationPremises {
  readonly schema: "dolly.module-activation-premises/v1";
  readonly daemon_installation_id: string;
  readonly instance_id: string;
  readonly config_revision: number;
  readonly config_digest: string;
  readonly permission_policy_definitions: readonly PermissionPolicyDefinition[];
  readonly permission_policy_backend_bindings: readonly PermissionPolicyBackendBinding[];
  readonly service_candidate: LinuxServiceCandidate;
  readonly premises_digest: string;
}

export interface CurrentAuthoritySnapshot {
  readonly config_revision: number;
  readonly config_digest: string;
  /** Exact canonical resolved-config bytes of the current revision. */
  readonly canonicalConfigBytes: Uint8Array;
  readonly canonicalConfig: JsonValue;
  /** Verified premise of the current revision, or null when none installed. */
  readonly premise: ModuleActivationPremises | null;
}

export interface RuntimeAuthorityDatabaseOptions {
  readonly path: string;
  readonly identity: RuntimeAuthorityIdentity;
  readonly lock: RuntimeAuthorityLockHandle;
}

/** Named crash points for conformance fault injection only (TST-AUTH-004). */
export type AuthorityCrashPoint =
  | "after_begin_immediate_before_mapping"
  | "after_mapping_before_prerequisites"
  | "after_prerequisites_before_premise"
  | "after_premise_before_current_pointer"
  | "after_current_pointer_before_commit";

export interface AuthorityTransactionOptions {
  readonly crashPoint?: AuthorityCrashPoint;
}

export interface InstallAuthorityConfigInput {
  readonly identity: RuntimeAuthorityIdentity;
  /** Exact canonical resolved-config JCS bytes, already validated by the caller. */
  readonly canonicalConfigBytes: Uint8Array;
  /** `sha256(canonicalConfigBytes)` as already validated by the caller. */
  readonly configDigest: string;
  /** Complete Module activation premise when the config has an installed Linux Module; else null. */
  readonly premise: ModuleActivationPremises | null;
  /** The verified installed-release component origins the premise may name. */
  readonly verifiedOrigins: readonly InstalledComponentOrigin[];
  /** When set, the transaction rechecks the pointer still names this revision/digest. */
  readonly expectedCurrent?: { readonly revision: number; readonly digest: string };
  readonly options?: AuthorityTransactionOptions;
}

export interface FileCoreHistoryMigrationInput extends FileCoreHistoryOptions {
  readonly expectedAuthority: { readonly revision: number; readonly digest: string };
  /** Exact canonical bytes read from the legacy FileCore source under the controller lock. */
  readonly legacySourceBytes: Uint8Array;
  readonly legacySourceDigest: string;
}

export interface InstallAuthorityConfigResult {
  readonly config_revision: number;
  /** `true` when a new mapping row was allocated; `false` when the exact current was reused. */
  readonly allocated: boolean;
}

/** Closed config-installed journal event record appended inside the authority transaction. */
export interface ConfigInstalledJournalEvent {
  readonly schema: "dolly.runtime-authority-config-installed/v1";
  readonly daemon_installation_id: string;
  readonly instance_id: string;
  readonly event_kind: "config-installed";
  readonly config_revision: number;
  readonly config_digest: string;
  readonly premises_digest: string | null;
}

// ---------------------------------------------------------------------------
// Closed-record validation
// ---------------------------------------------------------------------------

interface RuntimeSqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface RuntimeSqliteConnection {
  readonly name: string;
  readonly open: boolean;
  prepare(source: string): RuntimeSqliteStatement;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): unknown;
  close(): void;
}

function asRuntimeSqliteConnection(database: NativeSqliteConnection): RuntimeSqliteConnection {
  return database as unknown as RuntimeSqliteConnection;
}

function isClosedObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return false;
  }
  return true;
}

function isIntegralInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isSha256(value: unknown): boolean {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function sha256DigestOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError("expected a byte column value");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Self-referential digest of a closed record: the record serialized with one
 * named field removed, then hashed, exactly as the digest `comment` for
 * definition/binding/candidate/premise records in
 * `runtime-authority-record.schema.json`.
 */
function recordDigestWithoutField(record: Record<string, unknown>, field: string): string {
  const { [field]: _digest, ...rest } = record;
  assertCanonicalJsonValue(rest as unknown as JsonValue);
  return sha256DigestOfBytes(canonicalBytes(rest as unknown as JsonValue));
}

function malformed(label: string): RuntimeAuthorityDatabaseError {
  return new RuntimeAuthorityDatabaseError(
    "AUTHORITY_DATABASE_MALFORMED_RECORD",
    `${label} does not satisfy the closed runtime-authority record definition`,
  );
}

function assertClosedRecord(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isClosedObject(value, keys)) throw malformed(label);
}

function validateIdentity(identity: RuntimeAuthorityIdentity): void {
  if (!identity || !UUIDV7_PATTERN.test(identity.daemonInstallationId)) throw malformed("identity.daemonInstallationId");
  if (!STABLE_ID_PATTERN.test(identity.instanceId)) throw malformed("identity.instanceId");
}

function validateOrigin(value: unknown, label: string): InstalledComponentOrigin {
  assertClosedRecord(value, ["schema", "kind", "component_id", "component_revision", "component_digest"], label);
  const v = value as Record<string, unknown>;
  if (v.schema !== "dolly.installed-component-origin/v1" || v.kind !== "installed_product_component") throw malformed(`${label}.schema`);
  if (typeof v.component_id !== "string" || !QUALIFIED_NAME_PATTERN.test(v.component_id)) throw malformed(`${label}.component_id`);
  if (!isIntegralInRange(v.component_revision, 1, MAX_CONFIG_REVISION)) throw malformed(`${label}.component_revision`);
  if (!isSha256(v.component_digest)) throw malformed(`${label}.component_digest`);
  return v as unknown as InstalledComponentOrigin;
}

function validatePolicyOrigin(value: unknown, label: string): PolicyDefinitionOrigin {
  assertClosedRecord(value, ["schema", "kind", "source_id", "source_revision", "source_digest"], label);
  const v = value as Record<string, unknown>;
  if (v.schema !== "dolly.policy-definition-origin/v1" || v.kind !== "operator_approved_policy") throw malformed(`${label}.schema`);
  if (typeof v.source_id !== "string" || !QUALIFIED_NAME_PATTERN.test(v.source_id)) throw malformed(`${label}.source_id`);
  if (!isIntegralInRange(v.source_revision, 1, MAX_CONFIG_REVISION)) throw malformed(`${label}.source_revision`);
  if (!isSha256(v.source_digest)) throw malformed(`${label}.source_digest`);
  return v as unknown as PolicyDefinitionOrigin;
}

function validateDefinition(value: unknown, label: string): void {
  assertClosedRecord(
    value,
    ["schema", "policy_id", "policy_revision", "definition_schema_uri", "definition_schema_digest", "definition", "origin", "definition_digest"],
    label,
  );
  const v = value as Record<string, unknown>;
  if (v.schema !== "dolly.permission-policy-definition/v1") throw malformed(`${label}.schema`);
  if (typeof v.policy_id !== "string" || !STABLE_ID_PATTERN.test(v.policy_id)) throw malformed(`${label}.policy_id`);
  if (!isIntegralInRange(v.policy_revision, 1, MAX_CONFIG_REVISION)) throw malformed(`${label}.policy_revision`);
  if (typeof v.definition_schema_uri !== "string" || !URI_REFERENCE_PATTERN.test(v.definition_schema_uri)) throw malformed(`${label}.definition_schema_uri`);
  if (!isSha256(v.definition_schema_digest)) throw malformed(`${label}.definition_schema_digest`);
  validatePolicyOrigin(v.origin, `${label}.origin`);
  const computed = recordDigestWithoutField(v, "definition_digest");
  if (v.definition_digest !== computed) {
    throw new RuntimeAuthorityDatabaseError("CORE_DIGEST_MISMATCH", `${label}.definition_digest does not match its canonical bytes`);
  }
}

function validateBinding(value: unknown, label: string): void {
  assertClosedRecord(
    value,
    ["schema", "binding_id", "binding_revision", "binding_digest", "policy_id", "policy_revision", "policy_definition_digest", "origin"],
    label,
  );
  const v = value as Record<string, unknown>;
  if (v.schema !== "dolly.permission-policy-backend-binding/v1") throw malformed(`${label}.schema`);
  if (typeof v.binding_id !== "string" || !STABLE_ID_PATTERN.test(v.binding_id)) throw malformed(`${label}.binding_id`);
  if (!isIntegralInRange(v.binding_revision, 1, MAX_CONFIG_REVISION)) throw malformed(`${label}.binding_revision`);
  if (typeof v.policy_id !== "string" || !STABLE_ID_PATTERN.test(v.policy_id)) throw malformed(`${label}.policy_id`);
  if (!isIntegralInRange(v.policy_revision, 1, MAX_CONFIG_REVISION)) throw malformed(`${label}.policy_revision`);
  if (!isSha256(v.policy_definition_digest) || !isSha256(v.binding_digest)) throw malformed(`${label}.digest`);
  validateOrigin(v.origin, `${label}.origin`);
  const computed = recordDigestWithoutField(v, "binding_digest");
  if (v.binding_digest !== computed) {
    throw new RuntimeAuthorityDatabaseError("CORE_DIGEST_MISMATCH", `${label}.binding_digest does not match its canonical bytes`);
  }
}

function validateServiceCandidate(value: unknown, label: string): void {
  assertClosedRecord(value, ["schema", "origin", "unit_name", "mode", "candidate_digest"], label);
  const v = value as Record<string, unknown>;
  if (v.schema !== "dolly.linux-service-candidate/v1") throw malformed(`${label}.schema`);
  validateOrigin(v.origin, `${label}.origin`);
  if (typeof v.unit_name !== "string" || v.unit_name.length < 9 || v.unit_name.length > 255 || !UNIT_NAME_PATTERN.test(v.unit_name)) {
    throw new RuntimeAuthorityDatabaseError("MODULE_ACTIVATION_PREMISES_INVALID", `${label}.unit_name must match a Linux unit name`);
  }
  if (v.mode !== "user") throw new RuntimeAuthorityDatabaseError("MODULE_ACTIVATION_PREMISES_INVALID", `${label}.mode must be user`);
  if (!isSha256(v.candidate_digest)) throw malformed(`${label}.candidate_digest`);
  const computed = recordDigestWithoutField(v, "candidate_digest");
  if (v.candidate_digest !== computed) {
    throw new RuntimeAuthorityDatabaseError("CORE_DIGEST_MISMATCH", `${label}.candidate_digest does not match its canonical bytes`);
  }
}

function validatePremise(value: unknown, label: string): ModuleActivationPremises {
  assertClosedRecord(
    value,
    ["schema", "daemon_installation_id", "instance_id", "config_revision", "config_digest", "permission_policy_definitions", "permission_policy_backend_bindings", "service_candidate", "premises_digest"],
    label,
  );
  const v = value as Record<string, unknown>;
  if (v.schema !== "dolly.module-activation-premises/v1") throw malformed(`${label}.schema`);
  if (!UUIDV7_PATTERN.test(String(v.daemon_installation_id)) || !STABLE_ID_PATTERN.test(String(v.instance_id))) throw malformed(`${label}.identity`);
  if (!isIntegralInRange(v.config_revision, 1, MAX_CONFIG_REVISION) || !isSha256(String(v.config_digest))) throw malformed(`${label}.revision/digest`);
  if (!Array.isArray(v.permission_policy_definitions) || v.permission_policy_definitions.length > 1024) throw malformed(`${label}.permission_policy_definitions`);
  if (!Array.isArray(v.permission_policy_backend_bindings) || v.permission_policy_backend_bindings.length > 1024) throw malformed(`${label}.permission_policy_backend_bindings`);
  for (let index = 0; index < v.permission_policy_definitions.length; index += 1) {
    validateDefinition(v.permission_policy_definitions[index], `${label}.permission_policy_definitions[${index}]`);
  }
  for (let index = 0; index < v.permission_policy_backend_bindings.length; index += 1) {
    validateBinding(v.permission_policy_backend_bindings[index], `${label}.permission_policy_backend_bindings[${index}]`);
  }
  validateServiceCandidate(v.service_candidate, `${label}.service_candidate`);
  const computed = recordDigestWithoutField(v, "premises_digest");
  if (v.premises_digest !== computed) {
    throw new RuntimeAuthorityDatabaseError("CORE_DIGEST_MISMATCH", `${label}.premises_digest does not match its canonical bytes`);
  }
  return v as unknown as ModuleActivationPremises;
}

function validateResolvedConfiguration(value: unknown, label: string): ResolvedConfiguration {
  // The stored canonical_config is itself a closed authoritative record (the
  // ResolvedConfiguration in runtime-authority-record.schema.json); admitting
  // an arbitrary JSON blob (for example a downstream result/ack payload) would
  // otherwise make a non-config the subject of the current pointer.
  assertClosedRecord(value, ["runtime_config", "permission_policy_selections", "service_candidate"], label);
  const v = value as Record<string, unknown>;
  if (v.runtime_config === null || typeof v.runtime_config !== "object" || Array.isArray(v.runtime_config)) {
    throw malformed(`${label}.runtime_config`);
  }
  if (!Array.isArray(v.permission_policy_selections) || v.permission_policy_selections.length > 1024) {
    throw malformed(`${label}.permission_policy_selections`);
  }
  for (let index = 0; index < v.permission_policy_selections.length; index += 1) {
    const s = v.permission_policy_selections[index] as Record<string, unknown>;
    assertClosedRecord(s, ["policy_id", "policy_revision", "policy_definition_digest", "binding_id", "binding_revision", "binding_digest"], `${label}.permission_policy_selections[${index}]`);
    if (!STABLE_ID_PATTERN.test(String(s.policy_id)) || !isIntegralInRange(s.policy_revision, 1, MAX_CONFIG_REVISION) || !isSha256(String(s.policy_definition_digest))) {
      throw malformed(`${label}.permission_policy_selections[${index}]`);
    }
    if (!STABLE_ID_PATTERN.test(String(s.binding_id)) || !isIntegralInRange(s.binding_revision, 1, MAX_CONFIG_REVISION) || !isSha256(String(s.binding_digest))) {
      throw malformed(`${label}.permission_policy_selections[${index}]`);
    }
  }
  if (v.service_candidate !== null) {
    validateServiceCandidate(v.service_candidate, `${label}.service_candidate`);
  }
  return value as unknown as ResolvedConfiguration;
}

function asResolvedConfiguration(value: JsonValue): ResolvedConfiguration {
  return value as unknown as ResolvedConfiguration;
}

function selectionKey(selection: PermissionPolicySelection): string {
  return [
    selection.policy_id,
    String(selection.policy_revision),
    selection.policy_definition_digest,
    selection.binding_id,
    String(selection.binding_revision),
    selection.binding_digest,
  ].join("\u0000");
}

function bindingKey(binding: PermissionPolicyBackendBinding): string {
  return [
    binding.policy_id,
    String(binding.policy_revision),
    binding.policy_definition_digest,
    binding.binding_id,
    String(binding.binding_revision),
    binding.binding_digest,
  ].join("\u0000");
}

function originKey(origin: InstalledComponentOrigin): string {
  return [origin.component_id, String(origin.component_revision), origin.component_digest].join("\u0000");
}

// ---------------------------------------------------------------------------
// Schema version 1 (physical normalization of spec section 3.1)
// ---------------------------------------------------------------------------

export const RUNTIME_AUTHORITY_SCHEMA_SQL = `
CREATE TABLE core_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1),
  daemon_installation_id TEXT NOT NULL,
  instance_id TEXT NOT NULL
);
CREATE TABLE config_revision_mappings (
  config_revision INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND ${MAX_CONFIG_REVISION}),
  config_digest TEXT NOT NULL,
  canonical_bytes BLOB NOT NULL,
  UNIQUE (config_revision, config_digest)
);
CREATE TABLE installed_component_origins (
  component_id TEXT NOT NULL,
  component_revision INTEGER NOT NULL CHECK (component_revision BETWEEN 1 AND ${MAX_CONFIG_REVISION}),
  component_digest TEXT NOT NULL,
  record_jcs BLOB NOT NULL,
  PRIMARY KEY (component_id, component_revision),
  UNIQUE (component_id, component_revision, component_digest)
);
CREATE TABLE permission_policy_definitions (
  policy_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision BETWEEN 1 AND ${MAX_CONFIG_REVISION}),
  definition_digest TEXT NOT NULL,
  record_jcs BLOB NOT NULL,
  PRIMARY KEY (policy_id, policy_revision),
  UNIQUE (policy_id, policy_revision, definition_digest)
);
CREATE TABLE permission_policy_backend_bindings (
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision BETWEEN 1 AND ${MAX_CONFIG_REVISION}),
  binding_digest TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  policy_definition_digest TEXT NOT NULL,
  origin_component_id TEXT NOT NULL,
  origin_component_revision INTEGER NOT NULL,
  origin_component_digest TEXT NOT NULL,
  record_jcs BLOB NOT NULL,
  PRIMARY KEY (binding_id, binding_revision),
  UNIQUE (binding_id, binding_revision, binding_digest, policy_id, policy_revision, policy_definition_digest),
  FOREIGN KEY (policy_id, policy_revision, policy_definition_digest)
    REFERENCES permission_policy_definitions(policy_id, policy_revision, definition_digest),
  FOREIGN KEY (origin_component_id, origin_component_revision, origin_component_digest)
    REFERENCES installed_component_origins(component_id, component_revision, component_digest)
);
CREATE TABLE linux_service_candidates (
  origin_component_id TEXT NOT NULL,
  origin_component_revision INTEGER NOT NULL CHECK (origin_component_revision BETWEEN 1 AND ${MAX_CONFIG_REVISION}),
  origin_component_digest TEXT NOT NULL,
  unit_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode = 'user'),
  candidate_digest TEXT NOT NULL,
  record_jcs BLOB NOT NULL,
  PRIMARY KEY (origin_component_id, origin_component_revision, unit_name, mode),
  UNIQUE (origin_component_id, origin_component_revision, unit_name, mode, candidate_digest),
  FOREIGN KEY (origin_component_id, origin_component_revision, origin_component_digest)
    REFERENCES installed_component_origins(component_id, component_revision, component_digest)
);
CREATE TABLE module_activation_premise_policy_selections (
  config_revision INTEGER NOT NULL CHECK (config_revision BETWEEN 1 AND ${MAX_CONFIG_REVISION}),
  policy_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  policy_definition_digest TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  binding_digest TEXT NOT NULL,
  PRIMARY KEY (config_revision, policy_id, policy_revision),
  UNIQUE (config_revision, binding_id, binding_revision, binding_digest),
  FOREIGN KEY (config_revision)
    REFERENCES module_activation_premises(config_revision)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (policy_id, policy_revision, policy_definition_digest)
    REFERENCES permission_policy_definitions(policy_id, policy_revision, definition_digest),
  FOREIGN KEY (binding_id, binding_revision, binding_digest, policy_id, policy_revision, policy_definition_digest)
    REFERENCES permission_policy_backend_bindings(
      binding_id, binding_revision, binding_digest, policy_id, policy_revision, policy_definition_digest
    )
);
CREATE TABLE module_activation_premises (
  config_revision INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND ${MAX_CONFIG_REVISION}),
  config_digest TEXT NOT NULL,
  service_origin_component_id TEXT NOT NULL,
  service_origin_component_revision INTEGER NOT NULL,
  service_unit_name TEXT NOT NULL,
  service_mode TEXT NOT NULL,
  service_candidate_digest TEXT NOT NULL,
  premises_digest TEXT NOT NULL,
  record_jcs BLOB NOT NULL,
  UNIQUE (config_revision, config_digest),
  FOREIGN KEY (config_revision, config_digest)
    REFERENCES config_revision_mappings(config_revision, config_digest),
  FOREIGN KEY (service_origin_component_id, service_origin_component_revision, service_unit_name, service_mode, service_candidate_digest)
    REFERENCES linux_service_candidates(
      origin_component_id, origin_component_revision, unit_name, mode, candidate_digest
    )
);
CREATE TABLE runtime_authority_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1),
  daemon_installation_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  current_config_revision INTEGER NOT NULL CHECK (current_config_revision BETWEEN 1 AND ${MAX_CONFIG_REVISION}),
  current_config_digest TEXT NOT NULL,
  record_jcs BLOB NOT NULL,
  FOREIGN KEY (current_config_revision, current_config_digest)
    REFERENCES config_revision_mappings(config_revision, config_digest)
);
CREATE TABLE core_journal (
  journal_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_kind TEXT NOT NULL,
  event_jcs BLOB NOT NULL,
  config_revision INTEGER,
  config_digest TEXT,
  premises_digest TEXT
);
`;

function stateRecord(identity: RuntimeAuthorityIdentity, revision: number, digest: string): JsonValue {
  return {
    schema: "dolly.runtime-authority-state/v1",
    authority_schema_version: RUNTIME_AUTHORITY_SCHEMA_VERSION,
    daemon_installation_id: identity.daemonInstallationId,
    instance_id: identity.instanceId,
    current_config_revision: revision,
    current_config_digest: digest,
  };
}

/**
 * Internal repository over the Runtime authority database. A caller must hold
 * the exclusive instance controller lock for the identity tuple before opening
 * it for writing; every writable operation re-asserts that handle.
 */
export class RuntimeAuthorityDatabase {
  readonly #connection: RuntimeSqliteConnection;
  readonly #identity: RuntimeAuthorityIdentity;
  readonly #lock: RuntimeAuthorityLockHandle;
  #closed = false;

  private constructor(connection: RuntimeSqliteConnection, identity: RuntimeAuthorityIdentity, lock: RuntimeAuthorityLockHandle) {
    this.#connection = connection;
    this.#identity = identity;
    this.#lock = lock;
  }

  /** Opens through the H0 attested loader and verifies the committed DB (REQ-AUTH-004). */
  static open(options: RuntimeAuthorityDatabaseOptions): RuntimeAuthorityDatabase {
    validateIdentity(options.identity);
    if (typeof options.path !== "string" || options.path.length === 0 || options.path.includes("\0")) {
      throw new TypeError("Runtime authority database path must be a non-empty filesystem path");
    }
    if (!options.lock || !options.lock.held) {
      throw new RuntimeAuthorityDatabaseError(
        "CONTROLLER_LOCK_NOT_HELD",
        "A legitimate controller lock owner must open the Runtime authority database for writing",
      );
    }
    const handle = openAttestedNativeSqlite(options.path);
    try {
      const repository = new RuntimeAuthorityDatabase(asRuntimeSqliteConnection(handle.database), options.identity, options.lock);
      repository.#verifyOnOpen();
      return repository;
    } catch (error) {
      handle.close();
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close();
  }

  get isOpen(): boolean {
    return !this.#closed && this.#connection.open;
  }

  get identity(): RuntimeAuthorityIdentity {
    return { ...this.#identity };
  }

  /**
   * Opens the one already-migrated FileCore global history as its producer
   * capability. First use must go through migrateFileCoreHistory.
   */
  openFileCoreHistory(options: FileCoreHistoryOptions): FileCoreHistoryStore {
    this.#requireOpen();
    this.#requireLockHeld();
    return FileCoreHistoryStore.openForRuntimeAuthority(
      this.#connection,
      this.#identity,
      this.#lock,
      options,
      this.#fileCoreHistoryProducerCapability(),
    );
  }

  openFileCoreHistoryReader(options: FileCoreHistoryOptions): FileCoreHistoryReaderStore {
    return FileCoreHistoryReaderStore.fromProducer(this.openFileCoreHistory(options));
  }

  migrateFileCoreHistory(input: FileCoreHistoryMigrationInput): FileCoreHistoryStore {
    this.#requireOpen();
    this.#requireLockHeld();
    if (!isIntegralInRange(input.expectedAuthority.revision, 1, MAX_CONFIG_REVISION)) {
      throw new RuntimeAuthorityDatabaseError("CONFIG_REVISION_CONFLICT", "expected history authority revision is invalid");
    }
    if (!isSha256(input.expectedAuthority.digest) || !isSha256(input.legacySourceDigest)) {
      throw new RuntimeAuthorityDatabaseError("CORE_DIGEST_MISMATCH", "history migration digest is invalid");
    }
    const sourceDigest = sha256DigestOfBytes(input.legacySourceBytes);
    if (sourceDigest !== input.legacySourceDigest) {
      throw new RuntimeAuthorityDatabaseError("CORE_DIGEST_MISMATCH", "legacy FileCore bytes do not match their digest");
    }
    try {
      const source = parseCanonicalJsonBytes(input.legacySourceBytes);
      assertCanonicalJsonValue(source);
      if (
        (source as Record<string, unknown>).schemaVersion !== "dolly.core-state/18" &&
          (source as Record<string, unknown>).schemaVersion !== "dolly.core-state/19"
      ) {
        throw new Error("legacy source is not a FileCore state snapshot");
      }
      const sourceRecord = source as Record<string, unknown>;
      if (!isSha256(sourceRecord.stateDigest)) throw new Error("legacy FileCore stateDigest is invalid");
      const { stateDigest: _stateDigest, ...statePayload } = sourceRecord;
      if (canonicalJsonDigest(statePayload as JsonValue) !== sourceRecord.stateDigest) {
        throw new Error("legacy FileCore stateDigest does not match canonical payload");
      }
    } catch (error) {
      throw new RuntimeAuthorityDatabaseError("AUTHORITY_DATABASE_MALFORMED_RECORD", "legacy FileCore bytes are not a canonical FileCore snapshot", { cause: error });
    }
    const current = this.readCurrentConfig();
    if (
      current === null ||
      current.config_revision !== input.expectedAuthority.revision ||
      current.config_digest !== input.expectedAuthority.digest
    ) {
      throw new RuntimeAuthorityDatabaseError("CONFIG_REVISION_CONFLICT", "history migration authority moved");
    }
    let migrated: FileCoreHistoryStore | undefined;
    this.#inFileCoreHistoryMigrationTransaction(() => {
      const state = this.#connection.prepare(
        "SELECT current_config_revision, current_config_digest FROM runtime_authority_state WHERE singleton = 1",
      ).get();
      if (
        Number(state?.current_config_revision) !== input.expectedAuthority.revision ||
        String(state?.current_config_digest) !== input.expectedAuthority.digest
      ) {
        throw new RuntimeAuthorityDatabaseError("CONFIG_REVISION_CONFLICT", "history migration authority moved under the lock");
      }
      const historyTable = this.#connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'filecore_history_head'",
      ).get();
      if (historyTable !== undefined) {
        const existing = this.#connection.prepare(
          "SELECT singleton FROM filecore_history_head WHERE singleton = 1",
        ).get();
        if (existing !== undefined) {
          throw new FileCoreHistoryError("HISTORY_MIGRATION_REQUIRED", "FileCore history migration is already committed");
        }
      }
      const producerId = `filecore-${this.#identity.instanceId}`;
      const producerEpoch = `${input.expectedAuthority.revision}:${input.expectedAuthority.digest}`;
      migrated = FileCoreHistoryStore.migrateForRuntimeAuthority(
        this.#connection,
        this.#identity,
        this.#lock,
        {
          maxEntries: input.maxEntries,
          maxBytes: input.maxBytes,
          maxReaders: input.maxReaders,
          now: input.now,
          producerId,
          producerEpoch,
          legacySourceDigest: input.legacySourceDigest,
        },
        this.#fileCoreHistoryProducerCapability(),
      );
    });
    if (migrated === undefined) throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", "history migration returned no store");
    return migrated;
  }

  #requireOpen(): void {
    if (this.#closed || !this.#connection.open) {
      throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", "Runtime authority database is closed");
    }
  }

  #requireLockHeld(): void {
    if (!this.#lock.held) {
      throw new RuntimeAuthorityDatabaseError(
        "CONTROLLER_LOCK_NOT_HELD",
        "Writable Runtime authority access requires the caller-held instance controller lock",
      );
    }
  }


  #fileCoreHistoryProducerCapability(): { readonly assertValid: () => void } {
    return {
      assertValid: () => {
        this.#requireOpen();
        this.#requireLockHeld();
      },
    };
  }
  #inFileCoreHistoryMigrationTransaction(work: () => void): void {
    this.#statement("BEGIN IMMEDIATE").run();
    try {
      work();
    } catch (error) {
      try {
        this.#statement("ROLLBACK").run();
      } catch (rollbackError) {
        throw new FileCoreHistoryError("HISTORY_COMMIT_UNKNOWN", "history migration rollback outcome is unknown", { cause: rollbackError });
      }
      throw error;
    }
    try {
      this.#statement("COMMIT").run();
    } catch (error) {
      throw new FileCoreHistoryError("HISTORY_COMMIT_UNKNOWN", "history migration commit outcome is unknown; reopen before retry", { cause: error });
    }
  }

  #statement(source: string): RuntimeSqliteStatement {
    this.#requireOpen();
    try {
      return this.#connection.prepare(source);
    } catch (error) {
      throw this.#translateError(error);
    }
  }

  #translateError(error: unknown): RuntimeAuthorityDatabaseError {
    const sqlite = error as { code?: string; message?: string };
    if (sqlite.code === "SQLITE_BUSY" || sqlite.code === "SQLITE_BUSY_SNAPSHOT") {
      return new RuntimeAuthorityDatabaseError("STORAGE_BUSY", sqlite.message ?? "SQLite busy", { cause: error });
    }
    if (sqlite.code === "SQLITE_FULL") {
      return new RuntimeAuthorityDatabaseError("STORAGE_FULL", sqlite.message ?? "SQLite full", { cause: error });
    }
    // A premise-embedded record that violates the FK/unique/check constraints
    // is an admission-time premise defect (cross-policy, duplicate, or missing
    // definition/binding), never a pre-existing corruption of committed rows.
    if (typeof sqlite.code === "string" && sqlite.code.startsWith("SQLITE_CONSTRAINT")) {
      return new RuntimeAuthorityDatabaseError(
        "MODULE_ACTIVATION_PREMISES_INVALID",
        `premise violates the authority database relationship constraints: ${sqlite.message ?? sqlite.code}`,
        { cause: error },
      );
    }
    if (sqlite.code === "SQLITE_NOTADB") {
      return new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", sqlite.message ?? "SQLite rejected the candidate bytes", { cause: error });
    }
    if (error instanceof RuntimeAuthorityDatabaseError || error instanceof RuntimeAuthorityCrashPointError) {
      return error as RuntimeAuthorityDatabaseError;
    }
    return new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", sqlite.message ?? String(error), { cause: error });
  }

  #corrupt(detail: string): RuntimeAuthorityDatabaseError {
    return new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", `Runtime authority database is corrupt: ${detail}`);
  }

  // -------------------------------------------------------------------------
  // Open verification (REQ-AUTH-004)
  // -------------------------------------------------------------------------

  #openHasCommittedState(): boolean {
    try {
      return (
        this.#connection.prepare(
          "SELECT 1 FROM runtime_authority_state WHERE singleton = 1",
        ).get() !== undefined
      );
    } catch {
      return false; // schema not yet provisioned: nothing is committed
    }
  }

  #userVersion(): number {
    const value = this.#connection.pragma("user_version", { simple: true });
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  #verifyOnOpen(): void {
    this.#requireOpen();
    const version = this.#userVersion();
    if (version === 0) return; // uninitialized candidate bytes; first write bootstraps schema 1
    if (version !== RUNTIME_AUTHORITY_SCHEMA_VERSION) {
      throw new RuntimeAuthorityDatabaseError(
        "STORAGE_MIGRATION_REQUIRED",
        `Runtime authority database user_version ${version} is not supported; expected ${RUNTIME_AUTHORITY_SCHEMA_VERSION}`,
      );
    }
    this.#verifyCommitted();
  }

  #verifyCommitted(): void {
    const quickCheck = this.#connection.prepare("PRAGMA quick_check").all();
    if (quickCheck.length !== 1 || String(quickCheck[0]?.quick_check ?? "") !== "ok") {
      throw this.#corrupt("PRAGMA quick_check did not report ok");
    }
    const violations = this.#connection.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw this.#corrupt("foreign-key check reported violations");
    }
    const meta = this.#connection.prepare(
      "SELECT authority_schema_version, daemon_installation_id, instance_id FROM core_meta WHERE singleton = 1",
    ).get();
    const state = this.#connection.prepare(
      "SELECT authority_schema_version, daemon_installation_id, instance_id, current_config_revision, current_config_digest FROM runtime_authority_state WHERE singleton = 1",
    ).get();
    if (!meta || !state) {
      throw this.#corrupt("core_meta or authority-state singleton is missing");
    }
    if (Number(meta.authority_schema_version) !== RUNTIME_AUTHORITY_SCHEMA_VERSION || Number(state.authority_schema_version) !== RUNTIME_AUTHORITY_SCHEMA_VERSION) {
      throw this.#corrupt("stored authority schema version disagrees with the supported version");
    }
    if (meta.daemon_installation_id !== this.#identity.daemonInstallationId || meta.instance_id !== this.#identity.instanceId) {
      throw this.#corrupt("core_meta identity does not match the requested tuple");
    }
    if (state.daemon_installation_id !== meta.daemon_installation_id || state.instance_id !== meta.instance_id) {
      throw this.#corrupt("core_meta/authority-state identity agreement failed");
    }
    const current = this.#resolveMapping(Number(state.current_config_revision), String(state.current_config_digest));
    if (current === null) {
      throw this.#corrupt("current pointer references a missing or digest-mismatched mapping");
    }
    const canonicalConfig = parseCanonicalJsonBytes(current.bytes);
    assertCanonicalJsonValue(canonicalConfig);
    const premise = this.#loadPremise(Number(state.current_config_revision), String(state.current_config_digest));
    if (asResolvedConfiguration(canonicalConfig).service_candidate !== null && premise === null) {
      throw this.#corrupt("an installed Linux Module config has no premise row");
    }
    if (premise !== null) {
      this.#assertPremiseSelectionCardinality(premise, canonicalConfig);
      if (asResolvedConfiguration(canonicalConfig).service_candidate === null) {
        throw this.#corrupt("a premise exists for a config selecting no installed Linux Module");
      }
    } else if (asResolvedConfiguration(canonicalConfig).service_candidate !== null) {
      throw this.#corrupt("an installed Linux Module config has no premise row");
    }
  }

  /** Loads a committed mapping with full verification; null when absent. */
  #resolveMapping(revision: number, declaredDigest: string): { bytes: Uint8Array; digest: string } | null {
    const row = this.#connection.prepare(
      "SELECT config_revision, config_digest, canonical_bytes FROM config_revision_mappings WHERE config_revision = ?",
    ).get(revision);
    if (!row) return null;
    if (Number(row.config_revision) !== revision || String(row.config_digest) !== declaredDigest) {
      throw this.#corrupt("config mapping projection disagrees with its stored record");
    }
    const bytes = toBytes(row.canonical_bytes);
    const computed = sha256DigestOfBytes(bytes);
    if (computed !== declaredDigest) {
      throw this.#corrupt(`revision ${revision} canonical bytes do not match the stored digest`);
    }
    return { bytes, digest: declaredDigest };
  }

  /** Loads and verifies the one premise of a revision (digest + projection). Returns null when none. */
  #loadPremise(revision: number, configDigest: string): ModuleActivationPremises | null {
    const rows = this.#connection.prepare(
      "SELECT config_revision, config_digest, premises_digest, record_jcs FROM module_activation_premises WHERE config_revision = ?",
    ).all(revision);
    if (rows.length > 1) throw this.#corrupt(`more than one Module activation premise for revision ${revision}`);
    if (rows.length === 0) return null;
    const row = rows[0];
    if (Number(row.config_revision) !== revision || String(row.config_digest) !== configDigest) {
      throw this.#corrupt(`premise projection disagrees with revision ${revision}`);
    }
    const record = parseCanonicalJsonBytes(toBytes(row.record_jcs));
    assertCanonicalJsonValue(record);
    const premise = validatePremise(record, `revision ${revision} premise`);
    if (premise.config_revision !== revision || premise.config_digest !== configDigest) {
      throw this.#corrupt(`premise record disagrees with revision ${revision}`);
    }
    if (premise.premises_digest !== String(row.premises_digest)) {
      throw this.#corrupt(`premise digest projection disagrees with the stored record for revision ${revision}`);
    }
    return premise;
  }

  /** REQ-AUTH-004: the premise selection set equals the canonical config selections. */
  #assertPremiseSelectionCardinality(premise: ModuleActivationPremises, config: JsonValue): void {
    const decoded = asResolvedConfiguration(config);
    const configSet = new Set(decoded.permission_policy_selections.map((s) => selectionKey(s)));
    const premiseSet = new Set(premise.permission_policy_backend_bindings.map((b) => bindingKey(b)));
    if (configSet.size !== premiseSet.size) {
      throw this.#corrupt("premise selection set does not match the canonical config selection set");
    }
    for (const key of premiseSet) {
      if (!configSet.has(key)) {
        throw this.#corrupt("premise selection set does not match the canonical config selection set");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Verified read
  // -------------------------------------------------------------------------

  readCurrentConfig(): CurrentAuthoritySnapshot | null {
    this.#requireOpen();
    if (this.#userVersion() === 0) return null;
    this.#verifyCommitted();
    const state = this.#connection.prepare(
      "SELECT current_config_revision, current_config_digest FROM runtime_authority_state WHERE singleton = 1",
    ).get();
    const revision = Number(state?.current_config_revision);
    const digest = String(state?.current_config_digest);
    const mapping = this.#resolveMapping(revision, digest);
    if (mapping === null) throw this.#corrupt("current pointer references a missing mapping");
    const canonicalConfig = parseCanonicalJsonBytes(mapping.bytes);
    assertCanonicalJsonValue(canonicalConfig);
    const premise = this.#loadPremise(revision, digest);
    if (asResolvedConfiguration(canonicalConfig).service_candidate !== null && premise === null) {
      throw this.#corrupt("an installed Linux Module config has no premise row");
    }
    if (premise !== null) {
      this.#assertPremiseSelectionCardinality(premise, canonicalConfig);
    } else if (asResolvedConfiguration(canonicalConfig).service_candidate !== null) {
      throw this.#corrupt("an installed Linux Module config has no premise row");
    }
    return {
      config_revision: revision,
      config_digest: digest,
      canonicalConfigBytes: mapping.bytes,
      canonicalConfig,
      premise,
    };
  }

  readJournal(limit: number): ConfigInstalledJournalEvent[] {
    this.#requireOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
      throw new TypeError("readJournal limit must be a positive integer");
    }
    if (this.#userVersion() === 0) return []; // uninitialized: no journal exists
    const rows = this.#connection.prepare(
      "SELECT event_jcs FROM core_journal ORDER BY journal_seq DESC LIMIT ?",
    ).all(limit);
    const events: ConfigInstalledJournalEvent[] = [];
    for (const row of rows) {
      const record = parseCanonicalJsonBytes(toBytes(row.event_jcs));
      assertCanonicalJsonValue(record);
      events.push(record as unknown as ConfigInstalledJournalEvent);
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Write path
  // -------------------------------------------------------------------------

  installConfig(input: InstallAuthorityConfigInput): InstallAuthorityConfigResult {
    this.#requireOpen();
    this.#requireLockHeld();
    validateIdentity(input.identity);
    if (input.identity.daemonInstallationId !== this.#identity.daemonInstallationId || input.identity.instanceId !== this.#identity.instanceId) {
      throw new RuntimeAuthorityDatabaseError(
        "CONTROLLER_LOCK_NOT_HELD",
        "install identity disagrees with the opened database tuple",
      );
    }
    if (!isSha256(input.configDigest)) {
      throw new RuntimeAuthorityDatabaseError("CORE_DIGEST_MISMATCH", "configDigest must be a sha256 digest");
    }
    const computed = sha256DigestOfBytes(input.canonicalConfigBytes);
    if (input.configDigest !== computed) {
      throw new RuntimeAuthorityDatabaseError("CORE_DIGEST_MISMATCH", "declared config digest does not match the canonical bytes");
    }
    let decoded: ResolvedConfiguration;
    try {
      const canonical = parseCanonicalJsonBytes(input.canonicalConfigBytes);
      assertCanonicalJsonValue(canonical);
      decoded = validateResolvedConfiguration(canonical, "canonical config");
    } catch (error) {
      if (error instanceof RuntimeAuthorityDatabaseError) throw error;
      throw new RuntimeAuthorityDatabaseError(
        "AUTHORITY_DATABASE_MALFORMED_RECORD",
        `canonicalConfigBytes do not parse as a resolved configuration: ${(error as Error).message}`,
        { cause: error },
      );
    }
    const crashPoint = input.options?.crashPoint;
    let outcome: InstallAuthorityConfigResult | undefined;
    this.#inAuthorityTransaction(crashPoint, () => {
      outcome = this.#commitAllocation(decoded, input, crashPoint);
    });
    return outcome as InstallAuthorityConfigResult;
  }

  /** Offline legacy-JSON migration (REQ-AUTH-005): commits as the sole authority when none committed. */
  migrateLegacyJson(input: InstallAuthorityConfigInput): InstallAuthorityConfigResult {
    this.#requireOpen();
    this.#requireLockHeld();
    if (this.#userVersion() !== 0 && !this.#openHasCommittedState()) {
      // An initialized-but-incomplete database cannot claim schema version 1.
      throw new RuntimeAuthorityDatabaseError(
        "STORAGE_CORRUPT",
        "Runtime authority database is initialized but the authority state is missing",
      );
    }
    if (this.#openHasCommittedState()) {
      throw new RuntimeAuthorityDatabaseError(
        "AUTHORITY_DATABASE_ALREADY_COMMITTED",
        "A committed authority state exists; legacy JSON is never reimported",
      );
    }
    return this.installConfig(input);
  }

  #inAuthorityTransaction(crashPoint: AuthorityCrashPoint | undefined, work: () => void): void {
    let statement: RuntimeSqliteStatement | undefined;
    try {
      statement = this.#statement("BEGIN IMMEDIATE");
      statement.run();
    } catch (error) {
      throw this.#translateError(error);
    }
    try {
      work();
      if (crashPoint === "after_current_pointer_before_commit") {
        throw new RuntimeAuthorityCrashPointError(crashPoint);
      }
      this.#statement("COMMIT").run();
    } catch (error) {
      try {
        this.#statement("ROLLBACK").run();
      } catch {
        /* preserve the original failure */
      }
      if (error instanceof RuntimeAuthorityCrashPointError) throw error;
      throw this.#translateError(error);
    }
  }

  #commitAllocation(decoded: ResolvedConfiguration, input: InstallAuthorityConfigInput, crashPoint: AuthorityCrashPoint | undefined): InstallAuthorityConfigResult {
    if (this.#userVersion() === 0) {
      // Provision schema version 1 inside this transaction; a crash rolls back
      // the tables and user_version together, leaving no authority behind.
      try {
        this.#connection.exec(RUNTIME_AUTHORITY_SCHEMA_SQL);
        this.#connection.pragma("user_version = 1");
      } catch (error) {
        throw this.#translateError(error);
      }
    }
    const state = this.#connection.prepare(
      "SELECT current_config_revision, current_config_digest, daemon_installation_id, instance_id FROM runtime_authority_state WHERE singleton = 1",
    ).get();
    let currentRevision: number | null = null;
    let currentDigest: string | null = null;
    let currentBytes: Uint8Array | null = null;
    if (state) {
      currentRevision = Number(state.current_config_revision);
      currentDigest = String(state.current_config_digest);
      // Recheck identity agreement under the lock (REQ-AUTH-001).
      if (state.daemon_installation_id !== this.#identity.daemonInstallationId || state.instance_id !== this.#identity.instanceId) {
        throw this.#corrupt("authority-state identity disagrees with the requested tuple");
      }
      const mapping = this.#resolveMapping(currentRevision, currentDigest);
      if (mapping === null) throw this.#corrupt("current pointer references a missing mapping");
      currentBytes = mapping.bytes;
    }
    if (input.expectedCurrent) {
      if (currentRevision !== input.expectedCurrent.revision || currentDigest !== input.expectedCurrent.digest) {
        throw new RuntimeAuthorityDatabaseError(
          "CONFIG_REVISION_CONFLICT",
          "current pointer moved since the caller inspected it",
        );
      }
    }
    const premiseRequired = decoded.service_candidate !== null;
    if (premiseRequired && input.premise === null) {
      throw new RuntimeAuthorityDatabaseError(
        "MODULE_ACTIVATION_PREMISES_INVALID",
        "an installed Linux Module configuration requires a complete activation premise",
      );
    }
    if (!premiseRequired && input.premise !== null) {
      throw new RuntimeAuthorityDatabaseError(
        "MODULE_ACTIVATION_PREMISES_INVALID",
        "a configuration selecting no installed Linux Module must not carry a premise",
      );
    }
    // Reuse the exact current mapping: identical digest AND bytes.
    if (currentRevision !== null && currentDigest === input.configDigest) {
      if (currentBytes !== null && sameBytes(currentBytes, input.canonicalConfigBytes)) {
        return { config_revision: currentRevision, allocated: false };
      }
      throw new RuntimeAuthorityDatabaseError(
        "CORE_DIGEST_MISMATCH",
        "candidate digest equals the current digest but the canonical bytes differ; no revision is allocated",
      );
    }
    // Allocate the next integer revision; a digest never derives a revision.
    let next: number;
    if (currentRevision === null) {
      next = 1;
    } else if (currentRevision >= MAX_CONFIG_REVISION) {
      throw new RuntimeAuthorityDatabaseError("CORE_SEQUENCE_EXHAUSTED", "config revision space is exhausted");
    } else {
      next = currentRevision + 1;
    }
    if (crashPoint === "after_begin_immediate_before_mapping") {
      throw new RuntimeAuthorityCrashPointError(crashPoint);
    }
    // Insert the append-only mapping (REQ-AUTH-002 step 5).
    try {
      this.#connection.prepare(
        "INSERT INTO config_revision_mappings (config_revision, config_digest, canonical_bytes) VALUES (?, ?, ?)",
      ).run(next, input.configDigest, Buffer.from(input.canonicalConfigBytes));
    } catch (error) {
      throw this.#translateError(error);
    }
    if (crashPoint === "after_mapping_before_prerequisites") {
      throw new RuntimeAuthorityCrashPointError(crashPoint);
    }
    if (premiseRequired) {
      const premise = input.premise as ModuleActivationPremises;
      this.#verifyPremiseForAllocation(premise, decoded, input, next);
      // Prerequisites first (origins, definitions, bindings, candidate,
      // deferred selections), then the premise row last.
      this.#insertPrerequisites(next, input, premise);
      if (crashPoint === "after_prerequisites_before_premise") {
        throw new RuntimeAuthorityCrashPointError(crashPoint);
      }
      this.#insertPremiseRow(next, premise);
    }
    if (crashPoint === "after_premise_before_current_pointer") {
      throw new RuntimeAuthorityCrashPointError(crashPoint);
    }
    // Update the current pointer and append the journal event in this same
    // transaction (REQ-AUTH-002 steps 6-7, REQ-AUTH-003).
    this.#updateCurrentPointer(next, input, currentRevision === null);
    this.#appendJournalEvent(next, input, premiseRequired ? (input.premise as ModuleActivationPremises).premises_digest : null);
    return { config_revision: next, allocated: true };
  }

  #verifyPremiseForAllocation(premise: ModuleActivationPremises, decoded: ResolvedConfiguration, input: InstallAuthorityConfigInput, next: number): void {
    // Closed-record validation first: a premise record (and every embedded
    // definition/binding/candidate) must satisfy the closed runtime-authority
    // definitions before any row is written, so a record smuggling a path,
    // secret, function, or live-object shape is refused before admission.
    validatePremise(premise, "premise");
    if (premise.config_revision !== next) {
      throw new RuntimeAuthorityDatabaseError(
        "MODULE_ACTIVATION_PREMISES_INVALID",
        `premise config_revision must equal the target revision ${next}`,
      );
    }
    if (premise.config_digest !== input.configDigest) {
      throw new RuntimeAuthorityDatabaseError(
        "MODULE_ACTIVATION_PREMISES_INVALID",
        "premise config digest must equal the candidate config digest",
      );
    }
    if (premise.daemon_installation_id !== this.#identity.daemonInstallationId || premise.instance_id !== this.#identity.instanceId) {
      throw new RuntimeAuthorityDatabaseError(
        "MODULE_ACTIVATION_PREMISES_INVALID",
        "premise identity disagrees with the repository tuple",
      );
    }
    const configCandidateBytes = canonicalBytes(decoded.service_candidate as unknown as JsonValue);
    const premiseCandidateBytes = canonicalBytes(premise.service_candidate as unknown as JsonValue);
    if (!sameBytes(configCandidateBytes, premiseCandidateBytes)) {
      throw new RuntimeAuthorityDatabaseError(
        "MODULE_ACTIVATION_PREMISES_INVALID",
        "premise service candidate disagrees with the resolved config",
      );
    }
    // Exact cardinality: the premise binding set must equal the canonical
    // selection set; missing, extra, duplicate, stale, or cross-policy rows
    // fail closed (INV-ACTIVATION-013, TST-AUTH-006).
    const premiseSet = new Set(premise.permission_policy_backend_bindings.map((b) => bindingKey(b)));
    const configSet = new Set(decoded.permission_policy_selections.map((s) => selectionKey(s)));
    const missing = [...configSet].filter((key) => !premiseSet.has(key));
    const extra = [...premiseSet].filter((key) => !configSet.has(key));
    if (missing.length > 0 && extra.length === 0) {
      // Nothing in the premise can satisfy an entire selection (for example a
      // Ready/result/acknowledgement observer with no binding record): the
      // premise is incomplete, not a fabricated cross-policy authority.
      throw new RuntimeAuthorityDatabaseError(
        "MODULE_ACTIVATION_POLICY_BINDING_UNAVAILABLE",
        "a canonical policy selection has no exact premise backend binding",
      );
    }
    if (missing.length > 0 || extra.length > 0) {
      throw new RuntimeAuthorityDatabaseError(
        "MODULE_ACTIVATION_PREMISES_INVALID",
        "premise policy set disagrees with the canonical selection set",
      );
    }
    // The embedded definition triples must equal exactly the triples the
    // backend bindings reference: no extra, duplicate, stale, unbound
    // definition, or cross-policy row (INV-ACTIVATION-013).
    const defKey = (policyId: string, revision: number) => `${policyId}\u0000${String(revision)}`;
    const defKeys = premise.permission_policy_definitions.map((d) => defKey(d.policy_id, d.policy_revision));
    const boundKeys = premise.permission_policy_backend_bindings.map((b) => defKey(b.policy_id, b.policy_revision));
    if (new Set(defKeys).size !== defKeys.length || new Set(boundKeys).size !== boundKeys.length) {
      throw new RuntimeAuthorityDatabaseError(
        "MODULE_ACTIVATION_PREMISES_INVALID",
        "premise arrays must be unique by identity; duplicate definition or binding records are invalid",
      );
    }
    const defSet = new Set(defKeys);
    const boundSet = new Set(boundKeys);
    if (defSet.size !== boundSet.size || ![...boundSet].every((k) => defSet.has(k))) {
      throw new RuntimeAuthorityDatabaseError(
        "MODULE_ACTIVATION_PREMISES_INVALID",
        "premise definition set must equal exactly the definition triples the backend bindings reference",
      );
    }
  }

  /** Inserts origin/definition/binding/candidate rows and the deferred selection rows. */
  #insertPrerequisites(next: number, input: InstallAuthorityConfigInput, premise: ModuleActivationPremises): void {
    // Verified installed origins: every embedded origin must be in the
    // verified installed-release set (cross-origin insert refuses).
    const verified = new Map(input.verifiedOrigins.map((o) => [originKey(o), o]));
    const needed = new Map<string, InstalledComponentOrigin>();
    for (const binding of premise.permission_policy_backend_bindings) {
      needed.set(originKey(binding.origin), binding.origin);
    }
    needed.set(originKey(premise.service_candidate.origin), premise.service_candidate.origin);
    for (const [, origin] of needed) {
      const verifiedOrigin = verified.get(originKey(origin));
      if (!verifiedOrigin || !sameBytes(canonicalBytes(origin as unknown as JsonValue), canonicalBytes(verifiedOrigin as unknown as JsonValue))) {
        throw new RuntimeAuthorityDatabaseError(
          "MODULE_ACTIVATION_PREMISES_INVALID",
          `premise names an origin that is not in the verified installed release: ${originKey(origin)}`,
        );
      }
    }
    // Origins.
    for (const [, origin] of needed) {
      this.#insertPrerequisiteRow(
        "INSERT OR IGNORE INTO installed_component_origins (component_id, component_revision, component_digest, record_jcs) VALUES (?, ?, ?, ?)",
        [origin.component_id, origin.component_revision, origin.component_digest, Buffer.from(canonicalBytes(origin as unknown as JsonValue))],
        "installed_component_origins",
        "component_id = ? AND component_revision = ?",
        [origin.component_id, origin.component_revision],
        Buffer.from(canonicalBytes(origin as unknown as JsonValue)),
        `installed origin ${originKey(origin)}`,
      );
    }
    // Definitions.
    for (const definition of premise.permission_policy_definitions) {
      const bytes = Buffer.from(canonicalBytes(definition as unknown as JsonValue));
      this.#insertPrerequisiteRow(
        "INSERT OR IGNORE INTO permission_policy_definitions (policy_id, policy_revision, definition_digest, record_jcs) VALUES (?, ?, ?, ?)",
        [definition.policy_id, definition.policy_revision, definition.definition_digest, bytes],
        "permission_policy_definitions",
        "policy_id = ? AND policy_revision = ?",
        [definition.policy_id, definition.policy_revision],
        bytes,
        `policy definition ${definition.policy_id}`,
      );
    }
    // Bindings.
    for (const binding of premise.permission_policy_backend_bindings) {
      const bytes = Buffer.from(canonicalBytes(binding as unknown as JsonValue));
      this.#insertPrerequisiteRow(
        "INSERT OR IGNORE INTO permission_policy_backend_bindings (binding_id, binding_revision, binding_digest, policy_id, policy_revision, policy_definition_digest, origin_component_id, origin_component_revision, origin_component_digest, record_jcs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [binding.binding_id, binding.binding_revision, binding.binding_digest, binding.policy_id, binding.policy_revision, binding.policy_definition_digest, binding.origin.component_id, binding.origin.component_revision, binding.origin.component_digest, bytes],
        "permission_policy_backend_bindings",
        "binding_id = ? AND binding_revision = ?",
        [binding.binding_id, binding.binding_revision],
        bytes,
        `backend binding ${binding.binding_id}`,
      );
    }
    // Service candidate.
    const candidate = premise.service_candidate;
    const candidateBytes = Buffer.from(canonicalBytes(candidate as unknown as JsonValue));
    this.#insertPrerequisiteRow(
      "INSERT OR IGNORE INTO linux_service_candidates (origin_component_id, origin_component_revision, origin_component_digest, unit_name, mode, candidate_digest, record_jcs) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [candidate.origin.component_id, candidate.origin.component_revision, candidate.origin.component_digest, candidate.unit_name, candidate.mode, candidate.candidate_digest, candidateBytes],
      "linux_service_candidates",
      "origin_component_id = ? AND origin_component_revision = ? AND unit_name = ? AND mode = ?",
      [candidate.origin.component_id, candidate.origin.component_revision, candidate.unit_name, candidate.mode],
      candidateBytes,
      `service candidate ${candidate.unit_name}`,
    );
    // Premise-policy selections (relational projection; deferred FK to the premise).
    for (const selection of premise.permission_policy_backend_bindings) {
      this.#connection.prepare(
        `INSERT INTO module_activation_premise_policy_selections
           (config_revision, policy_id, policy_revision, policy_definition_digest, binding_id, binding_revision, binding_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(next, selection.policy_id, selection.policy_revision, selection.policy_definition_digest, selection.binding_id, selection.binding_revision, selection.binding_digest);
    }
  }

  /** Inserts the complete Module activation premise row LAST (REQ-AUTH-002 step 6). */
  #insertPremiseRow(next: number, premise: ModuleActivationPremises): void {
    const candidate = premise.service_candidate;
    const premiseBytes = Buffer.from(canonicalBytes(premise as unknown as JsonValue));
    this.#connection.prepare(
      `INSERT INTO module_activation_premises
         (config_revision, config_digest, service_origin_component_id, service_origin_component_revision,
          service_unit_name, service_mode, service_candidate_digest, premises_digest, record_jcs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      next,
      premise.config_digest,
      candidate.origin.component_id,
      candidate.origin.component_revision,
      candidate.unit_name,
      candidate.mode,
      candidate.candidate_digest,
      premise.premises_digest,
      premiseBytes,
    );
  }

  #insertPrerequisiteRow(
    insertSql: string,
    insertParams: unknown[],
    table: string,
    selectWhere: string,
    selectParams: unknown[],
    expectedBytes: Uint8Array,
    label: string,
  ): void {
    // REQ-AUTH-002 step 5: an existing identity row must be byte-identical or
    // the transaction fails. The composite-unique constraints that include the
    // digest already fail on a differing digest; additionally verify the
    // stored record bytes.
    try {
      this.#connection.prepare(insertSql).run(...insertParams);
    } catch (error) {
      throw this.#translateError(error);
    }
    const row = this.#connection.prepare(`SELECT record_jcs FROM ${table} WHERE ${selectWhere}`).get(...selectParams);
    if (!row) throw this.#corrupt(`prerequisite ${label} did not persist`);
    if (!sameBytes(toBytes(row.record_jcs), expectedBytes)) {
      throw this.#corrupt(`existing prerequisite identity row for ${label} differs byte-for-byte; refusing to relabel it`);
    }
  }

  #updateCurrentPointer(next: number, input: InstallAuthorityConfigInput, first: boolean): void {
    if (first) {
      this.#connection.prepare(
        "INSERT INTO core_meta (singleton, authority_schema_version, daemon_installation_id, instance_id) VALUES (1, ?, ?, ?)",
      ).run(RUNTIME_AUTHORITY_SCHEMA_VERSION, input.identity.daemonInstallationId, input.identity.instanceId);
    }
    const bytes = Buffer.from(canonicalBytes(stateRecord(input.identity, next, input.configDigest)));
    this.#connection.prepare(
      "INSERT INTO runtime_authority_state (singleton, authority_schema_version, daemon_installation_id, instance_id, current_config_revision, current_config_digest, record_jcs) VALUES (1, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(singleton) DO UPDATE SET authority_schema_version = excluded.authority_schema_version, " +
      "current_config_revision = excluded.current_config_revision, current_config_digest = excluded.current_config_digest, record_jcs = excluded.record_jcs",
    ).run(
      RUNTIME_AUTHORITY_SCHEMA_VERSION,
      input.identity.daemonInstallationId,
      input.identity.instanceId,
      next,
      input.configDigest,
      bytes,
    );
  }

  #appendJournalEvent(next: number, input: InstallAuthorityConfigInput, premisesDigest: string | null): void {
    const event: ConfigInstalledJournalEvent = {
      schema: "dolly.runtime-authority-config-installed/v1",
      daemon_installation_id: this.#identity.daemonInstallationId,
      instance_id: this.#identity.instanceId,
      event_kind: "config-installed",
      config_revision: next,
      config_digest: input.configDigest,
      premises_digest: premisesDigest,
    };
    this.#connection.prepare(
      "INSERT INTO core_journal (event_kind, event_jcs, config_revision, config_digest, premises_digest) VALUES ('config-installed', ?, ?, ?, ?)",
    ).run(
      Buffer.from(canonicalBytes(event as unknown as JsonValue)),
      next,
      input.configDigest,
      premisesDigest,
    );
  }
}
