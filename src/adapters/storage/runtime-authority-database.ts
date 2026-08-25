/**
 * H1 Runtime SQLite authority database repository.
 *
 * Owns the durable Runtime authority record contract. The logical records
 * retain the `.../v1` discriminators from ADR 0015; the Host-owned physical
 * authority projection is schema version 2 and is shared byte-for-byte with
 * Rust (`host_authority_meta`, identity-bearing parent mappings, and the
 * controller generation projection).
 *
 * It opens the shared database through the H0 Host-internal native SQLite
 * loader/attestation adapter, so every open first attests the pinned SQLite
 * build and the durable PRAGMA profile before any repository method runs.
 *
 * Scope boundary: this is an internal storage repository. It does NOT wire the
 * database into the daemon, bootstrap, installed-Linux activation, live
 * binding resolver, or any product composition, and it does not touch
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
import { isAbsolute, resolve, sep } from "node:path";
import { openAttestedNativeSqlite } from "./native-sqlite.js";
import type { NativeSqliteConnection } from "./native-sqlite-binding.js";
import {
  assertCanonicalJsonValue,
  canonicalBytes,
  canonicalJsonDigest,
  DEFAULT_MAX_JSON_BYTES,
  parseCanonicalJsonBytes,
  type JsonValue,
} from "../../schema-bundle/index.js";
import {
  createFileCoreHistoryStore,
  FileCoreHistoryError,
  FileCoreHistoryReaderStore,
  mintFileCoreHistoryProducerCapability,
  FileCoreHistoryStore,
  type FileCoreHistoryOptions,
} from "../../core/file-core-history.js";
/** Largest revision a conforming database may assign (REQ-AUTH-002 step 4). */
export const MAX_CONFIG_REVISION = 9_007_199_254_740_991;

/** `PRAGMA user_version` for the shared Core database schema. */
export const RUNTIME_AUTHORITY_SCHEMA_VERSION = 1;

/** Physical Host authority projection version (logical records remain `/v1`). */
export const HOST_AUTHORITY_SCHEMA_VERSION = 2;

/** Logical closed-record discriminator version. */
export const RUNTIME_AUTHORITY_RECORD_SCHEMA_VERSION = 1;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const QUALIFIED_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/u;
const UNIT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,246}\.service$/u;
const URI_REFERENCE_PATTERN = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/u;
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
  | "WORKER_START_PREMISE_CONFLICT"
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
  /**
   * The concrete controller exposes this under `info`; test doubles may expose
   * the direct projection. One of the two is required for a committed write.
   */
  readonly controllerGenerationId?: string;
  readonly info?: { readonly controllerGenerationId: string };
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
  readonly controller_generation_id: string;
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

/** Closed Worker-start premise projection input (Host-owned producer only). */
export interface InstallWorkerStartPremiseInput {
  readonly extensionAlias: string;
  readonly serverId: string;
  /** Absolute installed package root; must contain `packagePath`. */
  readonly packageRoot: string;
  /** Absolute installed package archive path inside `packageRoot`. */
  readonly packagePath: string;
  readonly packageDigest: string;
  readonly executableDigest: string;
  /** Package-root-relative executable endpoint (safe relative member). */
  readonly endpoint: string;
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

function isStableId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 63 && STABLE_ID_PATTERN.test(value);
}

function isQualifiedName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 255 &&
    QUALIFIED_NAME_PATTERN.test(value) &&
    value.split(".").every((part) => part.length <= 63)
  );
}

function isUriReference(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || !URI_REFERENCE_PATTERN.test(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "%") {
      const escape = value.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/u.test(escape)) return false;
      index += 2;
    }
  }
  return true;
}

function assertSortedUniquePolicyRevision(
  values: readonly { readonly policy_id: string; readonly policy_revision: number }[],
  label: string,
): void {
  let previous: { readonly policy_id: string; readonly policy_revision: number } | undefined;
  const seen = new Set<string>();
  for (const value of values) {
    const key = `${value.policy_id}\u0000${String(value.policy_revision)}`;
    if (
      seen.has(key) ||
      (previous !== undefined &&
        (previous.policy_id > value.policy_id ||
          (previous.policy_id === value.policy_id && previous.policy_revision >= value.policy_revision)))
    ) {
      throw malformed(`${label} must be sorted and unique by policy_id, policy_revision`);
    }
    seen.add(key);
    previous = value;
  }
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
  const bytes = canonicalBytes(rest as unknown as JsonValue);
  if (bytes.byteLength > DEFAULT_MAX_JSON_BYTES) {
    throw malformed(`${field} record exceeds the ${DEFAULT_MAX_JSON_BYTES}-byte JSON limit`);
  }
  return sha256DigestOfBytes(bytes);
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

const WORKER_START_PREMISE_RECORD_SCHEMA = "dolly.worker-start-premise/v1";

function validateWorkerStartPremiseInput(input: InstallWorkerStartPremiseInput): void {
  if (!STABLE_ID_PATTERN.test(input.extensionAlias) && !QUALIFIED_NAME_PATTERN.test(input.extensionAlias)) {
    throw new RuntimeAuthorityDatabaseError(
      "AUTHORITY_DATABASE_MALFORMED_RECORD",
      "extensionAlias must be a qualified lowercase identifier",
    );
  }
  if (typeof input.serverId !== "string" || input.serverId.length === 0 || input.serverId.length > 255) {
    throw new RuntimeAuthorityDatabaseError(
      "AUTHORITY_DATABASE_MALFORMED_RECORD",
      "serverId must be a non-empty string of at most 255 bytes",
    );
  }
  if (!isSha256(input.packageDigest) || !isSha256(input.executableDigest)) {
    throw new RuntimeAuthorityDatabaseError(
      "CORE_DIGEST_MISMATCH",
      "package and executable digests must be sha256 digests",
    );
  }
  if (!isSafeRelativeEndpoint(input.endpoint)) {
    throw new RuntimeAuthorityDatabaseError(
      "AUTHORITY_DATABASE_MALFORMED_RECORD",
      "endpoint must be a safe package-root-relative member",
    );
  }
  if (!isAbsolute(input.packageRoot) || !isAbsolute(input.packagePath)) {
    throw new RuntimeAuthorityDatabaseError(
      "AUTHORITY_DATABASE_MALFORMED_RECORD",
      "package locations must be absolute paths",
    );
  }
  const root = resolve(input.packageRoot);
  const packagePath = resolve(input.packagePath);
  if (root !== input.packageRoot || !packagePath.startsWith(root + sep)) {
    throw new RuntimeAuthorityDatabaseError(
      "AUTHORITY_DATABASE_MALFORMED_RECORD",
      "installed package path must sit inside the canonical package root",
    );
  }
}

function isSafeRelativeEndpoint(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

interface SealedWorkerStartPremise {
  readonly bytes: Uint8Array;
  readonly recordDigest: string;
}

function buildSealedWorkerStartPremise(unsigned: {
  readonly daemon_installation_id: string;
  readonly instance_id: string;
  readonly config_revision: number;
  readonly config_digest: string;
  readonly extension_alias: string;
  readonly server_id: string;
  readonly package_root: string;
  readonly package_path: string;
  readonly package_digest: string;
  readonly executable_digest: string;
  readonly endpoint: string;
}): SealedWorkerStartPremise {
  const record = {
    schema: WORKER_START_PREMISE_RECORD_SCHEMA,
    daemon_installation_id: unsigned.daemon_installation_id,
    instance_id: unsigned.instance_id,
    config_revision: unsigned.config_revision,
    config_digest: unsigned.config_digest,
    extension_alias: unsigned.extension_alias,
    server_id: unsigned.server_id,
    package_root: unsigned.package_root,
    package_path: unsigned.package_path,
    package_digest: unsigned.package_digest,
    executable_digest: unsigned.executable_digest,
    endpoint: unsigned.endpoint,
    record_digest: "",
  };
  const { record_digest: _omit, ...unsignedRecord } = record;
  const digest = canonicalJsonDigest(unsignedRecord as unknown as JsonValue);
  const sealed = { ...record, record_digest: digest };
  return { bytes: canonicalBytes(sealed as unknown as JsonValue), recordDigest: digest };
}

function validateIdentity(identity: RuntimeAuthorityIdentity): void {
  if (!identity || typeof identity !== "object" || !UUIDV7_PATTERN.test(identity.daemonInstallationId)) throw malformed("identity.daemonInstallationId");
  if (!isStableId(identity.instanceId)) throw malformed("identity.instanceId");
}
function controllerGenerationFromLock(lock: RuntimeAuthorityLockHandle): string {
  const direct = lock.controllerGenerationId;
  const nested = lock.info?.controllerGenerationId;
  const generation = direct ?? nested;
  if (typeof generation !== "string" || !UUIDV7_PATTERN.test(generation)) {
    throw new RuntimeAuthorityDatabaseError(
      "CONTROLLER_LOCK_NOT_HELD",
      "The controller lock does not expose a valid live controller generation",
    );
  }
  return generation;
}

function validateOrigin(value: unknown, label: string): InstalledComponentOrigin {
  assertClosedRecord(value, ["schema", "kind", "component_id", "component_revision", "component_digest"], label);
  const v = value as Record<string, unknown>;
  if (v.schema !== "dolly.installed-component-origin/v1" || v.kind !== "installed_product_component") throw malformed(`${label}.schema`);
  if (!isQualifiedName(v.component_id)) throw malformed(`${label}.component_id`);
  if (!isIntegralInRange(v.component_revision, 1, MAX_CONFIG_REVISION)) throw malformed(`${label}.component_revision`);
  if (!isSha256(v.component_digest)) throw malformed(`${label}.component_digest`);
  return v as unknown as InstalledComponentOrigin;
}

function validatePolicyOrigin(value: unknown, label: string): PolicyDefinitionOrigin {
  assertClosedRecord(value, ["schema", "kind", "source_id", "source_revision", "source_digest"], label);
  const v = value as Record<string, unknown>;
  if (v.schema !== "dolly.policy-definition-origin/v1" || v.kind !== "operator_approved_policy") throw malformed(`${label}.schema`);
  if (!isQualifiedName(v.source_id)) throw malformed(`${label}.source_id`);
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
  if (!isStableId(v.policy_id)) throw malformed(`${label}.policy_id`);
  if (!isIntegralInRange(v.policy_revision, 1, MAX_CONFIG_REVISION)) throw malformed(`${label}.policy_revision`);
  if (!isUriReference(v.definition_schema_uri)) throw malformed(`${label}.definition_schema_uri`);
  if (!isSha256(v.definition_schema_digest)) throw malformed(`${label}.definition_schema_digest`);
  if (v.definition === null || typeof v.definition !== "object" || Array.isArray(v.definition)) {
    throw malformed(`${label}.definition`);
  }
  if (Object.keys(v.definition).length > 256) throw malformed(`${label}.definition`);
  assertCanonicalJsonValue(v.definition);
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
  if (!isStableId(v.binding_id)) throw malformed(`${label}.binding_id`);
  if (!isIntegralInRange(v.binding_revision, 1, MAX_CONFIG_REVISION)) throw malformed(`${label}.binding_revision`);
  if (!isStableId(v.policy_id)) throw malformed(`${label}.policy_id`);
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
  if (!UUIDV7_PATTERN.test(String(v.daemon_installation_id)) || !isStableId(v.instance_id)) throw malformed(`${label}.identity`);
  if (!isIntegralInRange(v.config_revision, 1, MAX_CONFIG_REVISION) || !isSha256(String(v.config_digest))) throw malformed(`${label}.revision/digest`);
  if (!Array.isArray(v.permission_policy_definitions) || v.permission_policy_definitions.length > 1024) throw malformed(`${label}.permission_policy_definitions`);
  if (!Array.isArray(v.permission_policy_backend_bindings) || v.permission_policy_backend_bindings.length > 1024) throw malformed(`${label}.permission_policy_backend_bindings`);
  for (let index = 0; index < v.permission_policy_definitions.length; index += 1) {
    validateDefinition(v.permission_policy_definitions[index], `${label}.permission_policy_definitions[${index}]`);
  }
  for (let index = 0; index < v.permission_policy_backend_bindings.length; index += 1) {
    validateBinding(v.permission_policy_backend_bindings[index], `${label}.permission_policy_backend_bindings[${index}]`);
  }
  assertSortedUniquePolicyRevision(v.permission_policy_definitions as PermissionPolicyDefinition[], `${label}.permission_policy_definitions`);
  assertSortedUniquePolicyRevision(v.permission_policy_backend_bindings as PermissionPolicyBackendBinding[], `${label}.permission_policy_backend_bindings`);
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
    if (!isStableId(s.policy_id) || !isIntegralInRange(s.policy_revision, 1, MAX_CONFIG_REVISION) || !isSha256(String(s.policy_definition_digest))) {
      throw malformed(`${label}.permission_policy_selections[${index}]`);
    }
    if (!isStableId(s.binding_id) || !isIntegralInRange(s.binding_revision, 1, MAX_CONFIG_REVISION) || !isSha256(String(s.binding_digest))) {
      throw malformed(`${label}.permission_policy_selections[${index}]`);
    }
  }
  assertSortedUniquePolicyRevision(v.permission_policy_selections as PermissionPolicySelection[], `${label}.permission_policy_selections`);
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
// Physical Host schema version 2. Logical record discriminators remain /v1.
// ---------------------------------------------------------------------------

export const RUNTIME_AUTHORITY_SCHEMA_SQL = `
CREATE TABLE core_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  daemon_installation_id TEXT,
  instance_id TEXT,
  controller_generation_id TEXT,
  clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)),
  sqlite_version_number INTEGER NOT NULL,
  sqlite_source_id TEXT NOT NULL,
  sqlite_artifact_digest TEXT NOT NULL
);
CREATE TABLE commit_sequence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_value INTEGER NOT NULL
);
CREATE TABLE host_authority_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = ${HOST_AUTHORITY_SCHEMA_VERSION})
);
INSERT INTO host_authority_meta (singleton, authority_schema_version)
  VALUES (1, ${HOST_AUTHORITY_SCHEMA_VERSION});
CREATE TABLE config_revision_mappings (
  config_revision INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND ${MAX_CONFIG_REVISION}),
  daemon_installation_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
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
  authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = ${HOST_AUTHORITY_SCHEMA_VERSION}),
  daemon_installation_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  controller_generation_id TEXT NOT NULL,
  current_config_revision INTEGER NOT NULL CHECK (current_config_revision BETWEEN 1 AND ${MAX_CONFIG_REVISION}),
  current_config_digest TEXT NOT NULL,
  record_jcs BLOB NOT NULL,
  FOREIGN KEY (current_config_revision, current_config_digest)
    REFERENCES config_revision_mappings(config_revision, config_digest)
);
CREATE TABLE worker_start_premises (
  config_revision INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND ${MAX_CONFIG_REVISION}),
  config_digest TEXT NOT NULL,
  extension_alias TEXT NOT NULL CHECK (length(extension_alias) > 0),
  server_id TEXT NOT NULL CHECK (length(server_id) > 0),
  package_root TEXT NOT NULL CHECK (length(package_root) > 0),
  package_path TEXT NOT NULL CHECK (length(package_path) > 0),
  package_digest TEXT NOT NULL CHECK (package_digest LIKE 'sha256:%'),
  executable_digest TEXT NOT NULL CHECK (executable_digest LIKE 'sha256:%'),
  endpoint TEXT NOT NULL CHECK (length(endpoint) > 0),
  record_jcs BLOB NOT NULL,
  record_digest TEXT NOT NULL,
  UNIQUE (config_revision, config_digest),
  FOREIGN KEY (config_revision, config_digest)
    REFERENCES config_revision_mappings(config_revision, config_digest),
  CHECK (substr(package_path, 1, length(package_root) + 1) = package_root || '/')
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

const AUTHORITY_TABLE_NAMES: readonly string[] = Object.freeze([
  "host_authority_meta",
  "config_revision_mappings",
  "installed_component_origins",
  "permission_policy_definitions",
  "permission_policy_backend_bindings",
  "linux_service_candidates",
  "module_activation_premises",
  "module_activation_premise_policy_selections",
  "runtime_authority_state",
  "worker_start_premises",
]);

interface AuthoritySchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull: number;
  readonly primaryKey: number;
}

const AUTHORITY_SCHEMA_COLUMNS: Readonly<Record<string, readonly AuthoritySchemaColumn[]>> = Object.freeze({
  core_meta: [
    { name: "singleton", type: "INTEGER", notNull: 0, primaryKey: 1 },
    { name: "schema_version", type: "INTEGER", notNull: 1, primaryKey: 0 },
    { name: "daemon_installation_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "instance_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "controller_generation_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "clean_shutdown", type: "INTEGER", notNull: 1, primaryKey: 0 },
    { name: "sqlite_version_number", type: "INTEGER", notNull: 1, primaryKey: 0 },
    { name: "sqlite_source_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "sqlite_artifact_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
  ],
  commit_sequence: [
    { name: "singleton", type: "INTEGER", notNull: 0, primaryKey: 1 },
    { name: "next_value", type: "INTEGER", notNull: 1, primaryKey: 0 },
  ],
  host_authority_meta: [
    { name: "singleton", type: "INTEGER", notNull: 0, primaryKey: 1 },
    { name: "authority_schema_version", type: "INTEGER", notNull: 1, primaryKey: 0 },
  ],
  config_revision_mappings: [
    { name: "config_revision", type: "INTEGER", notNull: 0, primaryKey: 1 },
    { name: "daemon_installation_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "instance_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "config_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "canonical_bytes", type: "BLOB", notNull: 1, primaryKey: 0 },
  ],
  installed_component_origins: [
    { name: "component_id", type: "TEXT", notNull: 1, primaryKey: 1 },
    { name: "component_revision", type: "INTEGER", notNull: 1, primaryKey: 2 },
    { name: "component_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "record_jcs", type: "BLOB", notNull: 1, primaryKey: 0 },
  ],
  permission_policy_definitions: [
    { name: "policy_id", type: "TEXT", notNull: 1, primaryKey: 1 },
    { name: "policy_revision", type: "INTEGER", notNull: 1, primaryKey: 2 },
    { name: "definition_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "record_jcs", type: "BLOB", notNull: 1, primaryKey: 0 },
  ],
  permission_policy_backend_bindings: [
    { name: "binding_id", type: "TEXT", notNull: 1, primaryKey: 1 },
    { name: "binding_revision", type: "INTEGER", notNull: 1, primaryKey: 2 },
    { name: "binding_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "policy_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "policy_revision", type: "INTEGER", notNull: 1, primaryKey: 0 },
    { name: "policy_definition_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "origin_component_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "origin_component_revision", type: "INTEGER", notNull: 1, primaryKey: 0 },
    { name: "origin_component_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "record_jcs", type: "BLOB", notNull: 1, primaryKey: 0 },
  ],
  linux_service_candidates: [
    { name: "origin_component_id", type: "TEXT", notNull: 1, primaryKey: 1 },
    { name: "origin_component_revision", type: "INTEGER", notNull: 1, primaryKey: 2 },
    { name: "origin_component_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "unit_name", type: "TEXT", notNull: 1, primaryKey: 3 },
    { name: "mode", type: "TEXT", notNull: 1, primaryKey: 4 },
    { name: "candidate_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "record_jcs", type: "BLOB", notNull: 1, primaryKey: 0 },
  ],
  module_activation_premises: [
    { name: "config_revision", type: "INTEGER", notNull: 0, primaryKey: 1 },
    { name: "config_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "service_origin_component_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "service_origin_component_revision", type: "INTEGER", notNull: 1, primaryKey: 0 },
    { name: "service_unit_name", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "service_mode", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "service_candidate_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "premises_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "record_jcs", type: "BLOB", notNull: 1, primaryKey: 0 },
  ],
  module_activation_premise_policy_selections: [
    { name: "config_revision", type: "INTEGER", notNull: 1, primaryKey: 1 },
    { name: "policy_id", type: "TEXT", notNull: 1, primaryKey: 2 },
    { name: "policy_revision", type: "INTEGER", notNull: 1, primaryKey: 3 },
    { name: "policy_definition_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "binding_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "binding_revision", type: "INTEGER", notNull: 1, primaryKey: 0 },
    { name: "binding_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
  ],
  runtime_authority_state: [
    { name: "singleton", type: "INTEGER", notNull: 0, primaryKey: 1 },
    { name: "authority_schema_version", type: "INTEGER", notNull: 1, primaryKey: 0 },
    { name: "daemon_installation_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "instance_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "controller_generation_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "current_config_revision", type: "INTEGER", notNull: 1, primaryKey: 0 },
    { name: "current_config_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "record_jcs", type: "BLOB", notNull: 1, primaryKey: 0 },
  ],
  worker_start_premises: [
    { name: "config_revision", type: "INTEGER", notNull: 0, primaryKey: 1 },
    { name: "config_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "extension_alias", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "server_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "package_root", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "package_path", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "package_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "executable_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "endpoint", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "record_jcs", type: "BLOB", notNull: 1, primaryKey: 0 },
    { name: "record_digest", type: "TEXT", notNull: 1, primaryKey: 0 },
  ],
  core_journal: [
    { name: "journal_seq", type: "INTEGER", notNull: 0, primaryKey: 1 },
    { name: "event_kind", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "event_jcs", type: "BLOB", notNull: 1, primaryKey: 0 },
    { name: "config_revision", type: "INTEGER", notNull: 0, primaryKey: 0 },
    { name: "config_digest", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "premises_digest", type: "TEXT", notNull: 0, primaryKey: 0 },
  ],
});

const AUTHORITY_SCHEMA_CHECKS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  core_meta: ["check (singleton = 1)", "check (clean_shutdown in (0, 1))"],
  commit_sequence: ["check (singleton = 1)"],
  host_authority_meta: ["check (singleton = 1)", "check (authority_schema_version = 2)"],
  config_revision_mappings: [
    "check (config_revision between 1 and 9007199254740991)",
    "unique (config_revision, config_digest)",
  ],
  installed_component_origins: [
    "check (component_revision between 1 and 9007199254740991)",
    "unique (component_id, component_revision, component_digest)",
  ],
  permission_policy_definitions: [
    "check (policy_revision between 1 and 9007199254740991)",
    "unique (policy_id, policy_revision, definition_digest)",
  ],
  permission_policy_backend_bindings: [
    "check (binding_revision between 1 and 9007199254740991)",
    "unique (binding_id, binding_revision, binding_digest, policy_id, policy_revision, policy_definition_digest)",
  ],
  linux_service_candidates: [
    "check (origin_component_revision between 1 and 9007199254740991)",
    "check (mode = 'user')",
    "unique (origin_component_id, origin_component_revision, unit_name, mode, candidate_digest)",
  ],
  module_activation_premises: [
    "check (config_revision between 1 and 9007199254740991)",
    "unique (config_revision, config_digest)",
  ],
  module_activation_premise_policy_selections: [
    "check (config_revision between 1 and 9007199254740991)",
    "unique (config_revision, binding_id, binding_revision, binding_digest)",
    "deferrable initially deferred",
  ],
  runtime_authority_state: [
    "check (singleton = 1)",
    "check (authority_schema_version = 2)",
    "check (current_config_revision between 1 and 9007199254740991)",
  ],
  worker_start_premises: [
    "check (config_revision between 1 and 9007199254740991)",
    "check (length(extension_alias) > 0)",
    "check (length(server_id) > 0)",
    "check (length(package_root) > 0)",
    "check (length(package_path) > 0)",
    "check (package_digest like 'sha256:%')",
    "check (executable_digest like 'sha256:%')",
    "check (length(endpoint) > 0)",
    "unique (config_revision, config_digest)",
    "check (substr(package_path, 1, length(package_root) + 1) = package_root || '/')",
  ],
});

const AUTHORITY_SCHEMA_FOREIGN_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  permission_policy_backend_bindings: [
    "0:0:installed_component_origins:origin_component_id:component_id:NO ACTION:NO ACTION:NONE",
    "0:1:installed_component_origins:origin_component_revision:component_revision:NO ACTION:NO ACTION:NONE",
    "0:2:installed_component_origins:origin_component_digest:component_digest:NO ACTION:NO ACTION:NONE",
    "1:0:permission_policy_definitions:policy_id:policy_id:NO ACTION:NO ACTION:NONE",
    "1:1:permission_policy_definitions:policy_revision:policy_revision:NO ACTION:NO ACTION:NONE",
    "1:2:permission_policy_definitions:policy_definition_digest:definition_digest:NO ACTION:NO ACTION:NONE",
  ],
  linux_service_candidates: [
    "0:0:installed_component_origins:origin_component_id:component_id:NO ACTION:NO ACTION:NONE",
    "0:1:installed_component_origins:origin_component_revision:component_revision:NO ACTION:NO ACTION:NONE",
    "0:2:installed_component_origins:origin_component_digest:component_digest:NO ACTION:NO ACTION:NONE",
  ],
  module_activation_premises: [
    "0:0:linux_service_candidates:service_origin_component_id:origin_component_id:NO ACTION:NO ACTION:NONE",
    "0:1:linux_service_candidates:service_origin_component_revision:origin_component_revision:NO ACTION:NO ACTION:NONE",
    "0:2:linux_service_candidates:service_unit_name:unit_name:NO ACTION:NO ACTION:NONE",
    "0:3:linux_service_candidates:service_mode:mode:NO ACTION:NO ACTION:NONE",
    "0:4:linux_service_candidates:service_candidate_digest:candidate_digest:NO ACTION:NO ACTION:NONE",
    "1:0:config_revision_mappings:config_revision:config_revision:NO ACTION:NO ACTION:NONE",
    "1:1:config_revision_mappings:config_digest:config_digest:NO ACTION:NO ACTION:NONE",
  ],
  module_activation_premise_policy_selections: [
    "0:0:permission_policy_backend_bindings:binding_id:binding_id:NO ACTION:NO ACTION:NONE",
    "0:1:permission_policy_backend_bindings:binding_revision:binding_revision:NO ACTION:NO ACTION:NONE",
    "0:2:permission_policy_backend_bindings:binding_digest:binding_digest:NO ACTION:NO ACTION:NONE",
    "0:3:permission_policy_backend_bindings:policy_id:policy_id:NO ACTION:NO ACTION:NONE",
    "0:4:permission_policy_backend_bindings:policy_revision:policy_revision:NO ACTION:NO ACTION:NONE",
    "0:5:permission_policy_backend_bindings:policy_definition_digest:policy_definition_digest:NO ACTION:NO ACTION:NONE",
    "1:0:permission_policy_definitions:policy_id:policy_id:NO ACTION:NO ACTION:NONE",
    "1:1:permission_policy_definitions:policy_revision:policy_revision:NO ACTION:NO ACTION:NONE",
    "1:2:permission_policy_definitions:policy_definition_digest:definition_digest:NO ACTION:NO ACTION:NONE",
    "2:0:module_activation_premises:config_revision:config_revision:NO ACTION:NO ACTION:NONE",
  ],
  runtime_authority_state: [
    "0:0:config_revision_mappings:current_config_revision:config_revision:NO ACTION:NO ACTION:NONE",
    "0:1:config_revision_mappings:current_config_digest:config_digest:NO ACTION:NO ACTION:NONE",
  ],
  worker_start_premises: [
    "0:0:config_revision_mappings:config_revision:config_revision:NO ACTION:NO ACTION:NONE",
    "0:1:config_revision_mappings:config_digest:config_digest:NO ACTION:NO ACTION:NONE",
  ],
});

type AuthorityIndexSpec = readonly [unique: number, origin: string, partial: number, columns: readonly string[]];

const AUTHORITY_SCHEMA_INDEXES: Readonly<Record<string, readonly AuthorityIndexSpec[]>> = Object.freeze({
  host_authority_meta: [],
  config_revision_mappings: [[1, "u", 0, ["config_revision", "config_digest"]]],
  installed_component_origins: [
    [1, "pk", 0, ["component_id", "component_revision"]],
    [1, "u", 0, ["component_id", "component_revision", "component_digest"]],
  ],
  permission_policy_definitions: [
    [1, "pk", 0, ["policy_id", "policy_revision"]],
    [1, "u", 0, ["policy_id", "policy_revision", "definition_digest"]],
  ],
  permission_policy_backend_bindings: [
    [1, "pk", 0, ["binding_id", "binding_revision"]],
    [1, "u", 0, ["binding_id", "binding_revision", "binding_digest", "policy_id", "policy_revision", "policy_definition_digest"]],
  ],
  linux_service_candidates: [
    [1, "pk", 0, ["origin_component_id", "origin_component_revision", "unit_name", "mode"]],
    [1, "u", 0, ["origin_component_id", "origin_component_revision", "unit_name", "mode", "candidate_digest"]],
  ],
  module_activation_premises: [[1, "u", 0, ["config_revision", "config_digest"]]],
  module_activation_premise_policy_selections: [
    [1, "pk", 0, ["config_revision", "policy_id", "policy_revision"]],
    [1, "u", 0, ["config_revision", "binding_id", "binding_revision", "binding_digest"]],
  ],
  runtime_authority_state: [],
  worker_start_premises: [[1, "u", 0, ["config_revision", "config_digest"]]],
  core_meta: [],
  commit_sequence: [],
  core_journal: [],
});

function sqlTokens(sql: unknown): string[] {
  const source = String(sql ?? "");
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && source[index + 1] === "-") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index + 1 < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index = Math.min(index + 2, source.length);
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      const quote = character;
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === quote) {
          if (source[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push(source.slice(start, index).toLowerCase());
      continue;
    }
    if (character === "[") {
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== "]") index += 1;
      index = Math.min(index + 1, source.length);
      tokens.push(source.slice(start, index).toLowerCase());
      continue;
    }
    const start = index;
    while (
      index < source.length &&
      !/\s/u.test(source[index]!) &&
      !/[\(\),=<>+\-*\/;\[\]]/u.test(source[index]!)
    ) {
      index += 1;
    }
    if (start === index) {
      tokens.push(source[index]!.toLowerCase());
      index += 1;
    } else {
      tokens.push(source.slice(start, index).toLowerCase());
    }
  }
  return tokens;
}

function sqlHasTokenSequence(tokens: readonly string[], fragment: string): boolean {
  const expected = sqlTokens(fragment);
  return expected.length > 0 && tokens.some((_, index) =>
    expected.every((token, offset) => tokens[index + offset] === token),
  );
}

/**
 * True when any token, after stripping identifier quoting ("...", `...`,
 * '...', [...]) and splitting schema-qualified names on '.', names one of the
 * authority tables.
 */
function tokensReferenceAuthorityTable(tokens: readonly string[], authorityTables: readonly string[]): boolean {
  return tokens.some((token) =>
    token.split(".").some((part) => {
      const trimmed = part.startsWith("[") && part.endsWith("]")
        ? part.slice(1, -1)
        : part.startsWith('"') && part.endsWith('"')
          ? part.slice(1, -1)
          : part.startsWith("`") && part.endsWith("`")
            ? part.slice(1, -1)
            : part;
      return authorityTables.some((table) => table.toLowerCase() === trimmed.toLowerCase());
    }),
  );
}

function verifyAuthorityIndexes(connection: RuntimeSqliteConnection): void {
  verifyAuthorityIndexesForTables(connection, Object.keys(AUTHORITY_SCHEMA_COLUMNS));
}

function verifyAuthorityIndexesForTables(connection: RuntimeSqliteConnection, tables: readonly string[]): void {
  for (const table of tables) {
    const expected = AUTHORITY_SCHEMA_INDEXES[table] ?? [];
    const actual = connection.prepare(`PRAGMA index_list(${table})`).all();
    if (actual.length !== expected.length) {
      throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", `authority table ${table} has a non-canonical index shape`);
    }
    const matched = expected.map(() => false);
    for (const row of actual) {
      const indexName = String(row.name);
      const escapedName = indexName.replace(/'/gu, "''");
      const columns = connection.prepare(`PRAGMA index_xinfo('${escapedName}')`).all()
        .filter((entry) => Number(entry.key) === 1)
        .sort((left, right) => Number(left.seqno) - Number(right.seqno));
      const position = expected.findIndex((spec, index) =>
        !matched[index] &&
        Number(row.unique) === spec[0] &&
        String(row.origin) === spec[1] &&
        Number(row.partial) === spec[2] &&
        columns.length === spec[3].length &&
        columns.every((column, columnIndex) =>
          String(column.name) === spec[3][columnIndex] &&
          Number(column.desc) === 0 &&
          String(column.coll).toUpperCase() === "BINARY",
        ),
      );
      if (position < 0) {
        throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", `authority table ${table} has a wrong index shape`);
      }
      matched[position] = true;
    }
    if (matched.some((value) => !value)) {
      throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", `authority table ${table} is missing a normative index`);
    }
  }
}

function verifyAuthorityPhysicalSchema(connection: RuntimeSqliteConnection): void {
  const tableNames = Object.keys(AUTHORITY_SCHEMA_COLUMNS);
  // Enumerate every persisted trigger and view alongside the authority tables:
  // a tbl_name filter would hide cross-referencing hostile objects whose own
  // name is unrelated to any authority table.
  const rows = connection.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master " +
      "WHERE name = 'config_revisions' OR type IN ('trigger', 'view') OR tbl_name IN (" +
      tableNames.map(() => "?").join(",") +
      ")",
  ).all(...tableNames);
  if (rows.some((row) => row.name === "config_revisions")) {
    throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", "parallel config_revisions table is not part of the Host-owned authority schema");
  }
  for (const table of tableNames) {
    const tableRow = rows.find((row) => row.type === "table" && row.name === table);
    if (!tableRow) throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", `required authority table ${table} is missing`);
    const columns = connection.prepare(`PRAGMA table_info(${table})`).all();
    const expected = AUTHORITY_SCHEMA_COLUMNS[table]!;
    if (
      columns.length !== expected.length ||
      columns.some((column, index) => {
        const wanted = expected[index]!;
        return column.name !== wanted.name ||
          String(column.type).toUpperCase() !== wanted.type ||
          Number(column.notnull) !== wanted.notNull ||
          Number(column.pk) !== wanted.primaryKey;
      })
    ) {
      throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", `authority table ${table} has a non-canonical column shape`);
    }
    const sql = sqlTokens(tableRow.sql);
    for (const fragment of AUTHORITY_SCHEMA_CHECKS[table] ?? []) {
      if (!sqlHasTokenSequence(sql, fragment)) throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", `authority table ${table} is missing constraint ${fragment}`);
    }
    // Exact normative FK metadata: group id, in-group order, parent table,
    // columns, and update/delete/match semantics.
    const foreignKeys = connection.prepare(`PRAGMA foreign_key_list(${table})`).all().map(
      (foreignKey) => `${foreignKey.id}:${foreignKey.seq}:${foreignKey.table}:${foreignKey.from}:${foreignKey.to ?? ""}:${foreignKey.on_update}:${foreignKey.on_delete}:${foreignKey.match}`,
    ).sort();
    const expectedForeignKeys = [...(AUTHORITY_SCHEMA_FOREIGN_KEYS[table] ?? [])].sort();
    if (foreignKeys.length !== expectedForeignKeys.length || foreignKeys.some((value, index) => value !== expectedForeignKeys[index])) {
      throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", `authority table ${table} has a non-canonical foreign-key shape`);
    }
  }
  // Enumerate every persisted trigger and view before scanning; do not
  // pre-filter by sqlite_master.tbl_name, which records only the first FROM
  // item of a view and would miss cross-references through subqueries.
  const hostileObjects = rows.filter((row) => {
    if (row.type !== "trigger" && row.type !== "view") return false;
    if (AUTHORITY_SCHEMA_COLUMNS[row.tbl_name as string] !== undefined) return true;
    return tokensReferenceAuthorityTable(sqlTokens(row.sql), AUTHORITY_TABLE_NAMES);
  });
  if (hostileObjects.length > 0) {
    throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", "authority tables have unexpected triggers or views");
  }
  verifyAuthorityIndexes(connection);
  const foreignKeyViolations = connection.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    throw new RuntimeAuthorityDatabaseError("STORAGE_CORRUPT", "authority foreign-key check reported violations");
  }
}
function verifyLegacyAuthorityPhysicalSchema(
  connection: RuntimeSqliteConnection,
  allowMissingHostMeta: boolean,
): void {
  // The Worker-start premise slice is a post-migration projection: it is
  // created lazily by createWorkerStartPremiseSchema after v2 exists and is
  // never part of the pre-bridge legacy or migrated v1 shape.
  const tables = Object.keys(AUTHORITY_SCHEMA_COLUMNS).filter(
    (table) =>
      table !== "core_meta" &&
      table !== "commit_sequence" &&
      table !== "core_journal" &&
      table !== "worker_start_premises",
  );
  for (const table of tables) {
    const row = connection.prepare(
      "SELECT type, sql FROM sqlite_master WHERE name = ?",
    ).get(table);
    if (!row) {
      if (allowMissingHostMeta && table === "host_authority_meta") continue;
      throw new RuntimeAuthorityDatabaseError("STORAGE_MIGRATION_REQUIRED", `legacy authority table ${table} is missing`);
    }
    if (row.type !== "table") {
      throw new RuntimeAuthorityDatabaseError("STORAGE_MIGRATION_REQUIRED", `legacy authority object ${table} is not a table`);
    }
    const expected = AUTHORITY_SCHEMA_COLUMNS[table]!;
    let legacyExpected = table === "runtime_authority_state"
      ? expected.filter((column) => column.name !== "controller_generation_id")
      : expected;
    if (table === "config_revision_mappings") {
      const mappingColumnSet = new Set(connection.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
      if (!mappingColumnSet.has("daemon_installation_id") || !mappingColumnSet.has("instance_id")) {
        legacyExpected = legacyExpected.filter((column) => column.name !== "daemon_installation_id" && column.name !== "instance_id");
      }
    }
    const columns = connection.prepare(`PRAGMA table_info(${table})`).all();
    if (
      columns.length !== legacyExpected.length ||
      columns.some((column, index) => String(column.name) !== legacyExpected[index]!.name)
    ) {
      throw new RuntimeAuthorityDatabaseError("STORAGE_MIGRATION_REQUIRED", `legacy authority table ${table} has a non-canonical column shape`);
    }
    const sql = sqlTokens(row.sql);
    if (
      !sqlHasTokenSequence(sql, "primary key") ||
      (table !== "host_authority_meta" && table !== "runtime_authority_state" && !sqlHasTokenSequence(sql, "unique"))
    ) {
      throw new RuntimeAuthorityDatabaseError("STORAGE_MIGRATION_REQUIRED", `legacy authority table ${table} is missing a required constraint`);
    }
  }
  verifyAuthorityIndexesForTables(connection, tables);
  const foreignKeyViolations = connection.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    throw new RuntimeAuthorityDatabaseError("STORAGE_MIGRATION_REQUIRED", "legacy authority foreign-key check reported violations");
  }
  // Enumerate every persisted trigger and view before scanning; do not
  // pre-filter by sqlite_master.tbl_name, which records only the first FROM
  // item of a view and would miss cross-references through subqueries.
  const hostile = connection.prepare(
    "SELECT type, tbl_name, sql FROM sqlite_master WHERE type IN ('trigger', 'view')",
  ).all() as Array<{ type: string; tbl_name: string; sql: string }>;
  const hostileObject = hostile.find((row) => {
    if (tables.includes(row.tbl_name)) return true;
    return tokensReferenceAuthorityTable(sqlTokens(row.sql), tables);
  });
  if (hostileObject !== undefined) {
    throw new RuntimeAuthorityDatabaseError("STORAGE_MIGRATION_REQUIRED", "legacy authority tables have unexpected triggers or views");
  }
}
function verifyLegacyCorePhysicalSchema(connection: RuntimeSqliteConnection, typescriptV1: boolean): void {
  const expected = typescriptV1
    ? [
        ["singleton", "INTEGER", 0, 1],
        ["authority_schema_version", "INTEGER", 1, 0],
        ["daemon_installation_id", "TEXT", 1, 0],
        ["instance_id", "TEXT", 1, 0],
      ]
    : [
        ["singleton", "INTEGER", 0, 1],
        ["schema_version", "INTEGER", 1, 0],
        ["daemon_installation_id", "TEXT", 0, 0],
        ["instance_id", "TEXT", 0, 0],
        ["clean_shutdown", "INTEGER", 1, 0],
        ["sqlite_version_number", "INTEGER", 1, 0],
        ["sqlite_source_id", "TEXT", 1, 0],
        ["sqlite_artifact_digest", "TEXT", 1, 0],
      ];
  const columns = connection.prepare("PRAGMA table_info(core_meta)").all();
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => {
      const wanted = expected[index]!;
      return String(column.name) !== wanted[0] ||
        String(column.type).toUpperCase() !== wanted[1] ||
        Number(column.notnull) !== wanted[2] ||
        Number(column.pk) !== wanted[3];
    })
  ) {
    throw new RuntimeAuthorityDatabaseError("STORAGE_MIGRATION_REQUIRED", "legacy core_meta has a non-canonical physical shape");
  }
  const row = connection.prepare("SELECT type, sql FROM sqlite_master WHERE name = 'core_meta'").get();
  const tokens = sqlTokens(row?.sql);
  const requiredChecks = typescriptV1
    ? ["check (singleton = 1)", "check (authority_schema_version = 1)"]
    : ["check (singleton = 1)", "check (clean_shutdown in (0, 1))"];
  if (
    row?.type !== "table" ||
    requiredChecks.some((fragment) => !sqlHasTokenSequence(tokens, fragment))
  ) {
    throw new RuntimeAuthorityDatabaseError("STORAGE_MIGRATION_REQUIRED", "legacy core_meta is missing an authoritative constraint");
  }
}


function stateRecord(identity: RuntimeAuthorityIdentity, controllerGenerationId: string, revision: number, digest: string): JsonValue {
  return {
    schema: "dolly.runtime-authority-state/v1",
    authority_schema_version: HOST_AUTHORITY_SCHEMA_VERSION,
    daemon_installation_id: identity.daemonInstallationId,
    instance_id: identity.instanceId,
    controller_generation_id: controllerGenerationId,
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
  readonly #controllerGenerationId: string;
  #closed = false;

  private constructor(
    connection: RuntimeSqliteConnection,
    identity: RuntimeAuthorityIdentity,
    lock: RuntimeAuthorityLockHandle,
    controllerGenerationId: string,
  ) {
    this.#connection = connection;
    this.#identity = identity;
    this.#lock = lock;
    this.#controllerGenerationId = controllerGenerationId;
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
    const controllerGenerationId = controllerGenerationFromLock(options.lock);
    const handle = openAttestedNativeSqlite(options.path);
    try {
      const repository = new RuntimeAuthorityDatabase(
        asRuntimeSqliteConnection(handle.database),
        options.identity,
        options.lock,
        controllerGenerationId,
      );
      repository.#verifyOnOpen();
      return repository;
    } catch (error) {
      handle.close();
      throw error;
    }
  }
  /**
   * Performs the one explicit bridge from the pre-H1 TypeScript projection.
   * Ordinary `open` refuses that shape with STORAGE_MIGRATION_REQUIRED; this
   * entry point is the only path that may normalize it.
   */
  static migrateV1Authority(options: RuntimeAuthorityDatabaseOptions): void {
    validateIdentity(options.identity);
    if (typeof options.path !== "string" || options.path.length === 0 || options.path.includes("\0")) {
      throw new TypeError("Runtime authority database path must be a non-empty filesystem path");
    }
    if (!options.lock || !options.lock.held) {
      throw new RuntimeAuthorityDatabaseError(
        "CONTROLLER_LOCK_NOT_HELD",
        "A legitimate controller lock owner must run the Runtime authority migration",
      );
    }
    const controllerGenerationId = controllerGenerationFromLock(options.lock);
    const handle = openAttestedNativeSqlite(options.path);
    try {
      const repository = new RuntimeAuthorityDatabase(
        asRuntimeSqliteConnection(handle.database),
        options.identity,
        options.lock,
        controllerGenerationId,
      );
      repository.#migrateLegacyV1();
      repository.#verifyOnOpen();
    } finally {
      handle.close();
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
  /** Supplies an exact context assertion to the FileCore capability mint path. */
  fileCoreHistoryContextBinding(): {
    readonly assertExactContext: (connection: unknown, identity: RuntimeAuthorityIdentity, lock: unknown) => void;
  } {
    const connection = this.#connection;
    const lock = this.#lock;
    const identityDigest = canonicalJsonDigest({
      daemonInstallationId: this.#identity.daemonInstallationId,
      instanceId: this.#identity.instanceId,
    });
    return Object.freeze({
      assertExactContext: (
        candidateConnection: unknown,
        candidateIdentity: RuntimeAuthorityIdentity,
        candidateLock: unknown,
      ): void => {
        if (!this.isOpen) throw new TypeError("Runtime authority database is closed");
        if (!this.#lock.held) throw new RuntimeAuthorityDatabaseError(
          "CONTROLLER_LOCK_NOT_HELD",
          "FileCore history requires the Runtime authority controller lock",
        );
        this.#lock.assertHeld();
        if (candidateConnection !== connection || candidateLock !== lock) {
          throw new TypeError("FileCore history context is not bound to this Runtime authority");
        }
        const candidate = candidateIdentity as unknown as Record<string, unknown>;
        if (
          candidate === null ||
          typeof candidate !== "object" ||
          Object.keys(candidate).sort().join("\u0000") !== "daemonInstallationId\u0000instanceId" ||
          typeof candidate.daemonInstallationId !== "string" ||
          typeof candidate.instanceId !== "string"
        ) {
          throw new TypeError("FileCore history identity is not the canonical Runtime authority identity");
        }
        const candidateDigest = canonicalJsonDigest({
          daemonInstallationId: candidate.daemonInstallationId,
          instanceId: candidate.instanceId,
        });
        if (candidateDigest !== identityDigest) {
          throw new TypeError("FileCore history identity is not bound to this Runtime authority");
        }
      },
    });
  }


  get identity(): RuntimeAuthorityIdentity {
    return { ...this.#identity };
  }
  get controllerGenerationId(): string {
    return this.#controllerGenerationId;
  }

  /**
   * Opens the one already-migrated FileCore global history as its producer
   * capability. First use must go through migrateFileCoreHistory.
   */
  openFileCoreHistory(options: FileCoreHistoryOptions): FileCoreHistoryStore {
    this.#requireOpen();
    this.#requireLockHeld();
    return createFileCoreHistoryStore(
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
      migrated = createFileCoreHistoryStore(
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
        true,
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
    this.#lock.assertHeld();
    if (controllerGenerationFromLock(this.#lock) !== this.#controllerGenerationId) {
      throw new RuntimeAuthorityDatabaseError(
        "CONTROLLER_LOCK_NOT_HELD",
        "The controller generation changed while this Runtime authority handle was open",
      );
    }
  }

  #fileCoreHistoryProducerCapability() {
    return mintFileCoreHistoryProducerCapability(this);
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

  #migrateLegacyV1(): void {
    this.#requireOpen();
    if (this.#userVersion() !== RUNTIME_AUTHORITY_SCHEMA_VERSION) {
      throw new RuntimeAuthorityDatabaseError(
        "STORAGE_MIGRATION_REQUIRED",
        "Only the pre-H1 user_version 1 authority projection can be migrated",
      );
    }
    const hostTable = this.#connection.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'host_authority_meta'",
    ).get();
    const hostVersion = hostTable
      ? Number(this.#connection.prepare(
          "SELECT authority_schema_version FROM host_authority_meta WHERE singleton = 1",
        ).get()?.authority_schema_version)
      : null;
    if (hostVersion !== null && hostVersion !== 1) {
      throw new RuntimeAuthorityDatabaseError(
        "STORAGE_MIGRATION_REQUIRED",
        "The physical Host authority schema is not an expected v1 migration source",
      );
    }
    const coreColumns = new Set(
      this.#connection.prepare("PRAGMA table_info(core_meta)").all().map((column) => String(column.name)),
    );
    const runtimeColumns = new Set(
      this.#connection.prepare("PRAGMA table_info(runtime_authority_state)").all().map((column) => String(column.name)),
    );
    const typescriptV1 = hostVersion === null && coreColumns.has("authority_schema_version") && !coreColumns.has("schema_version");
    const rustV1 = hostVersion === 1 && coreColumns.has("schema_version");
    if ((!typescriptV1 && !rustV1) || runtimeColumns.has("controller_generation_id")) {
      throw new RuntimeAuthorityDatabaseError(
        "STORAGE_MIGRATION_REQUIRED",
        "The database is not an expected v1 authority migration source",
      );
    }
    const mappingColumns = this.#connection.prepare("PRAGMA table_info(config_revision_mappings)").all();
    const mappingColumnNames = new Set(mappingColumns.map((entry) => String(entry.name)));
    const mappingLacksIdentity = !mappingColumnNames.has("daemon_installation_id") || !mappingColumnNames.has("instance_id");
    if (!mappingLacksIdentity) {
      const mappingIdentityColumns = mappingColumns.filter(
        (entry) => entry.name === "daemon_installation_id" || entry.name === "instance_id",
      );
      if (mappingIdentityColumns.some((entry) => Number(entry.notnull) !== 1)) {
        throw new RuntimeAuthorityDatabaseError(
          "STORAGE_MIGRATION_REQUIRED",
          "Legacy mapping identity columns are nullable and cannot be altered into v2",
        );
      }
    }
    const parallelConfigRevisions = this.#connection.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE name = 'config_revisions'",
    ).get();
    if (parallelConfigRevisions) {
      throw new RuntimeAuthorityDatabaseError(
        "STORAGE_MIGRATION_REQUIRED",
        "parallel config_revisions object blocks legacy migration",
      );
    }
    verifyLegacyCorePhysicalSchema(this.#connection, typescriptV1);
    verifyLegacyAuthorityPhysicalSchema(this.#connection, typescriptV1);
    const state = this.#connection.prepare(
      "SELECT authority_schema_version, daemon_installation_id, instance_id, current_config_revision, current_config_digest, record_jcs FROM runtime_authority_state WHERE singleton = 1",
    ).get();
    if (!state || Number(state.authority_schema_version) !== RUNTIME_AUTHORITY_RECORD_SCHEMA_VERSION) {
      throw this.#corrupt("legacy authority-state singleton is missing or has an unknown record version");
    }
    if (state.daemon_installation_id !== this.#identity.daemonInstallationId || state.instance_id !== this.#identity.instanceId) {
      throw this.#corrupt("legacy authority-state identity does not match the requested tuple");
    }
    const revision = Number(state.current_config_revision);
    const digest = String(state.current_config_digest);
    const mapping = this.#resolveLegacyMapping(revision, digest);
    if (mapping === null) throw this.#corrupt("legacy current pointer references a missing mapping");
    let legacyStateRecord: JsonValue;
    try {
      legacyStateRecord = parseCanonicalJsonBytes(toBytes(state.record_jcs));
      assertCanonicalJsonValue(legacyStateRecord);
    assertClosedRecord(
      legacyStateRecord,
      ["schema", "authority_schema_version", "daemon_installation_id", "instance_id", "current_config_revision", "current_config_digest"],
      "legacy authority-state record",
    );
    } catch (error) {
      if (error instanceof RuntimeAuthorityDatabaseError) throw error;
      throw this.#corrupt(`legacy authority-state record is malformed: ${String(error)}`);
    }
    if (
      legacyStateRecord.schema !== "dolly.runtime-authority-state/v1" ||
      legacyStateRecord.authority_schema_version !== 1 ||
      legacyStateRecord.daemon_installation_id !== this.#identity.daemonInstallationId ||
      legacyStateRecord.instance_id !== this.#identity.instanceId ||
      legacyStateRecord.current_config_revision !== revision ||
      legacyStateRecord.current_config_digest !== digest ||
      !sameBytes(toBytes(state.record_jcs), canonicalBytes(legacyStateRecord))
    ) {
      throw this.#corrupt("legacy authority-state record disagrees with its relational projection");
    }
    const legacyConfig = validateResolvedConfiguration(parseCanonicalJsonBytes(mapping.bytes), "legacy current canonical config");
    const legacyPremise = this.#loadPremise(revision, digest);
    if ((legacyConfig.service_candidate !== null) !== (legacyPremise !== null)) {
      throw this.#corrupt("legacy current config and premise presence disagree");
    }
    // Blocker 3: verify every persisted row (reachable and unused) before any
    // schema commit so tampered historical rows cannot enter the v2 projection.
    this.#verifyAllCommittedRows();

    this.#statement("BEGIN IMMEDIATE").run();
    try {
      const sqliteIdentity = this.#connection.prepare(
        "SELECT sqlite_version() AS version, sqlite_source_id() AS source_id",
      ).get();
      const versionParts = String(sqliteIdentity?.version ?? "").split(".").map((part) => Number(part));
      const versionNumber =
        versionParts.length === 3 && versionParts.every((part) => Number.isSafeInteger(part))
          ? (versionParts[0] ?? 0) * 1_000_000 + (versionParts[1] ?? 0) * 1_000 + (versionParts[2] ?? 0)
          : 0;
      const sourceId = String(sqliteIdentity?.source_id ?? "");
      const artifactDigest = sha256DigestOfBytes(Buffer.from(sourceId, "utf8"));
      const coreRow = this.#connection.prepare("SELECT * FROM core_meta WHERE singleton = 1").get() as Record<string, unknown> | undefined;
      const coreDaemon = coreRow?.daemon_installation_id;
      const coreInstance = coreRow?.instance_id;
      const legacySchemaVersion = typescriptV1 ? coreRow?.authority_schema_version : coreRow?.schema_version;
      if (
        typeof coreDaemon !== "string" ||
        typeof coreInstance !== "string" ||
        coreDaemon !== this.#identity.daemonInstallationId ||
        coreInstance !== this.#identity.instanceId ||
        Number(legacySchemaVersion) !== 1
      ) {
        throw this.#corrupt("legacy core_meta identity or schema version is invalid");
      }
      const cleanShutdown = typescriptV1 ? 0 : Number(coreRow?.clean_shutdown);
      const legacySqliteVersion = typescriptV1 ? versionNumber : Number(coreRow?.sqlite_version_number);
      const legacySourceId = typescriptV1 ? sourceId : String(coreRow?.sqlite_source_id ?? "");
      const legacyArtifactDigest = typescriptV1 ? artifactDigest : String(coreRow?.sqlite_artifact_digest ?? "");
      if (
        !Number.isInteger(cleanShutdown) ||
        ![0, 1].includes(cleanShutdown) ||
        !Number.isSafeInteger(legacySqliteVersion) ||
        legacySourceId.length === 0 ||
        !isSha256(legacyArtifactDigest)
      ) {
        throw this.#corrupt("legacy core_meta diagnostic projection is invalid");
      }
      this.#connection.prepare(
          "CREATE TABLE core_meta_v2 (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL, daemon_installation_id TEXT, instance_id TEXT, controller_generation_id TEXT, clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)), sqlite_version_number INTEGER NOT NULL, sqlite_source_id TEXT NOT NULL, sqlite_artifact_digest TEXT NOT NULL)",
        ).run();
        this.#connection.prepare(
          "INSERT INTO core_meta_v2 (singleton, schema_version, daemon_installation_id, instance_id, controller_generation_id, clean_shutdown, sqlite_version_number, sqlite_source_id, sqlite_artifact_digest) SELECT 1, 1, ?, ?, ?, ?, ?, ?, ? FROM core_meta WHERE singleton = 1",
        ).run(
          coreRow!.daemon_installation_id,
          coreRow!.instance_id,
          this.#controllerGenerationId,
          cleanShutdown,
          legacySqliteVersion,
          legacySourceId,
          legacyArtifactDigest,
        );
        this.#connection.prepare("DROP TABLE core_meta").run();
        this.#connection.prepare("ALTER TABLE core_meta_v2 RENAME TO core_meta").run();
      if (mappingLacksIdentity) {
        // config_revision_mappings is referenced by module_activation_premises
        // and runtime_authority_state, and PRAGMA foreign_keys cannot be
        // disabled inside an active transaction. Rebuild the mapping and every
        // referencing table in dependency-safe order: replacements are created
        // and populated first (their FK checks resolve against the still-
        // present old parents), then old children are dropped child-first,
        // then old parents, then each replacement takes the canonical name.
        this.#connection.prepare(
          "CREATE TABLE config_revision_mappings_v2 (config_revision INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND 9007199254740991), daemon_installation_id TEXT NOT NULL, instance_id TEXT NOT NULL, config_digest TEXT NOT NULL, canonical_bytes BLOB NOT NULL, UNIQUE (config_revision, config_digest))",
        ).run();
        this.#connection.prepare(
          "INSERT INTO config_revision_mappings_v2 (config_revision, daemon_installation_id, instance_id, config_digest, canonical_bytes) SELECT config_revision, ?, ?, config_digest, canonical_bytes FROM config_revision_mappings",
        ).run(this.#identity.daemonInstallationId, this.#identity.instanceId);
        this.#connection.prepare(
          "CREATE TABLE module_activation_premises_v2 (config_revision INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND 9007199254740991), config_digest TEXT NOT NULL, service_origin_component_id TEXT NOT NULL, service_origin_component_revision INTEGER NOT NULL, service_unit_name TEXT NOT NULL, service_mode TEXT NOT NULL, service_candidate_digest TEXT NOT NULL, premises_digest TEXT NOT NULL, record_jcs BLOB NOT NULL, UNIQUE (config_revision, config_digest), FOREIGN KEY (config_revision, config_digest) REFERENCES config_revision_mappings_v2(config_revision, config_digest), FOREIGN KEY (service_origin_component_id, service_origin_component_revision, service_unit_name, service_mode, service_candidate_digest) REFERENCES linux_service_candidates(origin_component_id, origin_component_revision, unit_name, mode, candidate_digest))",
        ).run();
        this.#connection.prepare("INSERT INTO module_activation_premises_v2 SELECT * FROM module_activation_premises").run();
        this.#connection.prepare(
          "CREATE TABLE module_activation_premise_policy_selections_v2 (config_revision INTEGER NOT NULL CHECK (config_revision BETWEEN 1 AND 9007199254740991), policy_id TEXT NOT NULL, policy_revision INTEGER NOT NULL, policy_definition_digest TEXT NOT NULL, binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, binding_digest TEXT NOT NULL, PRIMARY KEY (config_revision, policy_id, policy_revision), UNIQUE (config_revision, binding_id, binding_revision, binding_digest), FOREIGN KEY (config_revision) REFERENCES module_activation_premises_v2(config_revision) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY (policy_id, policy_revision, policy_definition_digest) REFERENCES permission_policy_definitions(policy_id, policy_revision, definition_digest), FOREIGN KEY (binding_id, binding_revision, binding_digest, policy_id, policy_revision, policy_definition_digest) REFERENCES permission_policy_backend_bindings(binding_id, binding_revision, binding_digest, policy_id, policy_revision, policy_definition_digest))",
        ).run();
        this.#connection.prepare("INSERT INTO module_activation_premise_policy_selections_v2 SELECT * FROM module_activation_premise_policy_selections").run();
        const stateColumns = this.#connection.prepare("PRAGMA table_info(runtime_authority_state)").all() as Array<{ name: string }>;
        const stateHasGeneration = stateColumns.some((column) => column.name === "controller_generation_id");
        if (stateHasGeneration) {
          this.#connection.prepare(
            "CREATE TABLE runtime_authority_state_v2 (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1), daemon_installation_id TEXT NOT NULL, instance_id TEXT NOT NULL, controller_generation_id TEXT NOT NULL, current_config_revision INTEGER NOT NULL CHECK (current_config_revision BETWEEN 1 AND 9007199254740991), current_config_digest TEXT NOT NULL, record_jcs BLOB NOT NULL, FOREIGN KEY (current_config_revision, current_config_digest) REFERENCES config_revision_mappings_v2(config_revision, config_digest))",
          ).run();
        } else {
          this.#connection.prepare(
            "CREATE TABLE runtime_authority_state_v2 (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1), daemon_installation_id TEXT NOT NULL, instance_id TEXT NOT NULL, current_config_revision INTEGER NOT NULL CHECK (current_config_revision BETWEEN 1 AND 9007199254740991), current_config_digest TEXT NOT NULL, record_jcs BLOB NOT NULL, FOREIGN KEY (current_config_revision, current_config_digest) REFERENCES config_revision_mappings_v2(config_revision, config_digest))",
          ).run();
        }
        this.#connection.prepare("INSERT INTO runtime_authority_state_v2 SELECT * FROM runtime_authority_state").run();
        this.#connection.prepare("DROP TABLE module_activation_premise_policy_selections").run();
        this.#connection.prepare("DROP TABLE module_activation_premises").run();
        this.#connection.prepare("DROP TABLE runtime_authority_state").run();
        this.#connection.prepare("DROP TABLE config_revision_mappings").run();
        this.#connection.prepare("ALTER TABLE module_activation_premise_policy_selections_v2 RENAME TO module_activation_premise_policy_selections").run();
        this.#connection.prepare("ALTER TABLE module_activation_premises_v2 RENAME TO module_activation_premises").run();
        this.#connection.prepare("ALTER TABLE runtime_authority_state_v2 RENAME TO runtime_authority_state").run();
        this.#connection.prepare("ALTER TABLE config_revision_mappings_v2 RENAME TO config_revision_mappings").run();
      }
      if (hostVersion === 1) {
        this.#connection.prepare("DROP TABLE host_authority_meta").run();
      }
      this.#connection.prepare(
        "CREATE TABLE host_authority_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 2))",
      ).run();
      this.#connection.prepare(
        "INSERT INTO host_authority_meta (singleton, authority_schema_version) VALUES (1, 2)",
      ).run();
      const commitSequence = this.#connection.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'commit_sequence'",
      ).get();
      if (!commitSequence) {
        this.#connection.prepare(
          "CREATE TABLE commit_sequence (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), next_value INTEGER NOT NULL)",
        ).run();
        this.#connection.prepare(
          "INSERT INTO commit_sequence (singleton, next_value) SELECT 1, COALESCE(MAX(config_revision), 0) + 1 FROM config_revision_mappings",
        ).run();
      }
      const coreJournal = this.#connection.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'core_journal'",
      ).get();
      if (!coreJournal) {
        this.#connection.prepare(
          "CREATE TABLE core_journal (journal_seq INTEGER PRIMARY KEY AUTOINCREMENT, event_kind TEXT NOT NULL, event_jcs BLOB NOT NULL, config_revision INTEGER, config_digest TEXT, premises_digest TEXT)",
        ).run();
      }
      // The Worker-start premise slice is provisioned empty at migration so
      // the post-migration physical gate sees the complete v2 projection;
      // premises themselves are projected per-revision by the Host writer.
      const workerPremises = this.#connection.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'worker_start_premises'",
      ).get();
      if (!workerPremises) {
        this.#connection.prepare(
          "CREATE TABLE worker_start_premises (config_revision INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND 9007199254740991), config_digest TEXT NOT NULL, extension_alias TEXT NOT NULL CHECK (length(extension_alias) > 0), server_id TEXT NOT NULL CHECK (length(server_id) > 0), package_root TEXT NOT NULL CHECK (length(package_root) > 0), package_path TEXT NOT NULL CHECK (length(package_path) > 0), package_digest TEXT NOT NULL CHECK (package_digest LIKE 'sha256:%'), executable_digest TEXT NOT NULL CHECK (executable_digest LIKE 'sha256:%'), endpoint TEXT NOT NULL CHECK (length(endpoint) > 0), record_jcs BLOB NOT NULL, record_digest TEXT NOT NULL, UNIQUE (config_revision, config_digest), FOREIGN KEY (config_revision, config_digest) REFERENCES config_revision_mappings(config_revision, config_digest), CHECK (substr(package_path, 1, length(package_root) + 1) = package_root || '/'))",
        ).run();
      }
      const recordBytes = Buffer.from(canonicalBytes(
        stateRecord(this.#identity, this.#controllerGenerationId, revision, digest),
      ));
      this.#connection.prepare(
        "CREATE TABLE runtime_authority_state_v2 (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 2), daemon_installation_id TEXT NOT NULL, instance_id TEXT NOT NULL, controller_generation_id TEXT NOT NULL, current_config_revision INTEGER NOT NULL CHECK (current_config_revision BETWEEN 1 AND 9007199254740991), current_config_digest TEXT NOT NULL, record_jcs BLOB NOT NULL, FOREIGN KEY (current_config_revision, current_config_digest) REFERENCES config_revision_mappings(config_revision, config_digest))",
      ).run();
      this.#connection.prepare(
        "INSERT INTO runtime_authority_state_v2 (singleton, authority_schema_version, daemon_installation_id, instance_id, controller_generation_id, current_config_revision, current_config_digest, record_jcs) VALUES (1, 2, ?, ?, ?, ?, ?, ?)",
      ).run(
        this.#identity.daemonInstallationId,
        this.#identity.instanceId,
        this.#controllerGenerationId,
        revision,
        digest,
        recordBytes,
      );
      this.#connection.prepare("DROP TABLE runtime_authority_state").run();
      this.#connection.prepare("ALTER TABLE runtime_authority_state_v2 RENAME TO runtime_authority_state").run();
      verifyAuthorityPhysicalSchema(this.#connection);
      this.#statement("COMMIT").run();
    } catch (error) {
      try {
        this.#statement("ROLLBACK").run();
      } catch {
        /* preserve the original migration error */
      }
      throw this.#translateError(error);
    }
  }

  #verifyOnOpen(): void {
    this.#requireOpen();
    const parallelConfigRevisions = this.#connection.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'config_revisions'",
    ).get();
    if (parallelConfigRevisions) {
      throw new RuntimeAuthorityDatabaseError(
        "STORAGE_CORRUPT",
        "parallel config_revisions table is not part of the Host-owned authority schema",
      );
    }
    const version = this.#userVersion();
    if (version === 0) {
      const objects = Number(this.#connection.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'",
      ).get()?.count ?? 0);
      if (objects !== 0) throw new RuntimeAuthorityDatabaseError("STORAGE_MIGRATION_REQUIRED", "uninitialized authority bytes contain a partial schema");
      return;
    }
    if (version !== RUNTIME_AUTHORITY_SCHEMA_VERSION) {
      throw new RuntimeAuthorityDatabaseError(
        "STORAGE_MIGRATION_REQUIRED",
        `Runtime authority database user_version ${version} is not supported; expected ${RUNTIME_AUTHORITY_SCHEMA_VERSION}`,
      );
    }
    const hostTable = this.#connection.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'host_authority_meta'",
    ).get();
    const hostMeta = hostTable
      ? this.#connection.prepare(
          "SELECT authority_schema_version FROM host_authority_meta WHERE singleton = 1",
        ).get()
      : undefined;
    const stateColumns = this.#connection.prepare("PRAGMA table_info(runtime_authority_state)").all();
    if (
      Number(hostMeta?.authority_schema_version) !== HOST_AUTHORITY_SCHEMA_VERSION ||
      !stateColumns.some((column) => column.name === "controller_generation_id")
    ) {
      throw new RuntimeAuthorityDatabaseError(
        "STORAGE_MIGRATION_REQUIRED",
        "Runtime authority database uses the legacy physical Host schema; invoke the explicit v1 migration",
      );
    }
    this.#verifyCommitted();
    this.#refreshControllerGeneration();
  }

  #verifyCommitted(): void {
    verifyAuthorityPhysicalSchema(this.#connection);
    const quickCheck = this.#connection.prepare("PRAGMA quick_check").all();
    if (quickCheck.length !== 1 || String(quickCheck[0]?.quick_check ?? "") !== "ok") {
      throw this.#corrupt("PRAGMA quick_check did not report ok");
    }
    const violations = this.#connection.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw this.#corrupt("foreign-key check reported violations");
    }
    this.#verifyAllCommittedRows();
    const meta = this.#connection.prepare(
      "SELECT schema_version, daemon_installation_id, instance_id, controller_generation_id FROM core_meta WHERE singleton = 1",
    ).get();
    const state = this.#connection.prepare(
      "SELECT authority_schema_version, daemon_installation_id, instance_id, controller_generation_id, current_config_revision, current_config_digest, record_jcs FROM runtime_authority_state WHERE singleton = 1",
    ).get();
    if (!meta || !state) {
      throw this.#corrupt("core_meta or authority-state singleton is missing");
    }
    if (Number(meta.schema_version) !== RUNTIME_AUTHORITY_SCHEMA_VERSION || Number(state.authority_schema_version) !== HOST_AUTHORITY_SCHEMA_VERSION) {
      throw this.#corrupt("stored authority schema version disagrees with the supported physical versions");
    }
    if (meta.daemon_installation_id !== this.#identity.daemonInstallationId || meta.instance_id !== this.#identity.instanceId) {
      throw this.#corrupt("core_meta identity does not match the requested tuple");
    }
    if (
      state.daemon_installation_id !== meta.daemon_installation_id ||
      state.instance_id !== meta.instance_id ||
      typeof meta.controller_generation_id !== "string" ||
      !UUIDV7_PATTERN.test(meta.controller_generation_id) ||
      state.controller_generation_id !== meta.controller_generation_id
    ) {
      throw this.#corrupt("core_meta/authority-state identity or generation agreement failed");
    }
    const current = this.#resolveMapping(Number(state.current_config_revision), String(state.current_config_digest));
    if (current === null) {
      throw this.#corrupt("current pointer references a missing or digest-mismatched mapping");
    }
    let stateRecordValue: JsonValue;
    try {
      stateRecordValue = parseCanonicalJsonBytes(toBytes(state.record_jcs));
      assertCanonicalJsonValue(stateRecordValue);
    } catch (error) {
      throw this.#corrupt(`authority-state record_jcs is malformed: ${String(error)}`);
    }
    const expectedStateRecord = canonicalBytes(
      stateRecord(this.#identity, String(state.controller_generation_id), Number(state.current_config_revision), String(state.current_config_digest)),
    );
    if (!sameBytes(toBytes(state.record_jcs), expectedStateRecord)) {
      throw this.#corrupt("authority-state canonical bytes disagree with the relational projection");
    }
    let canonicalConfig: JsonValue;
    try {
      canonicalConfig = parseCanonicalJsonBytes(current.bytes);
      assertCanonicalJsonValue(canonicalConfig);
    } catch (error) {
      throw this.#corrupt(`current canonical config bytes are malformed: ${String(error)}`);
    }
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
  #verifyAllCommittedRows(): void {
    const mappingRows = this.#connection.prepare(
      "SELECT config_revision, config_digest FROM config_revision_mappings ORDER BY config_revision",
    ).all();
    const expectedSelectionsByRevision: Record<string, readonly PermissionPolicySelection[]> = Object.create(null);
    const mappingDigestByRevision: Record<string, string> = Object.create(null);
    const mappingHasIdentity = mappingRows.length === 0
      ? true
      : this.#connection.prepare("PRAGMA table_info(config_revision_mappings)").all().some((column) => column.name === "daemon_installation_id");
    for (const row of mappingRows) {
      const revision = Number(row.config_revision);
      const digest = String(row.config_digest);
      const mapping = mappingHasIdentity ? this.#resolveMapping(revision, digest) : this.#resolveLegacyMapping(revision, digest);
      if (mapping === null) throw this.#corrupt(`mapping revision ${revision} disappeared during verification`);
      const config = asResolvedConfiguration(parseCanonicalJsonBytes(mapping.bytes));
      expectedSelectionsByRevision[String(revision)] = config.permission_policy_selections;
      mappingDigestByRevision[String(revision)] = digest;
    }
    const originRows = this.#connection.prepare(
      "SELECT component_id, component_revision, component_digest, record_jcs FROM installed_component_origins",
    ).all();
    for (const row of originRows) {
      const bytes = toBytes(row.record_jcs);
      let record: JsonValue;
      try {
        record = parseCanonicalJsonBytes(bytes);
        assertCanonicalJsonValue(record);
        validateOrigin(record, "stored installed component origin");
      } catch (error) {
        throw this.#corrupt(`stored installed component origin is malformed: ${String(error)}`);
      }
      if (
        !sameBytes(bytes, canonicalBytes(record)) ||
        (record as Record<string, unknown>).component_id !== row.component_id ||
        (record as Record<string, unknown>).component_revision !== Number(row.component_revision) ||
        (record as Record<string, unknown>).component_digest !== row.component_digest
      ) {
        throw this.#corrupt("installed component origin projection disagrees with its canonical record");
      }
    }

    const definitionRows = this.#connection.prepare(
      "SELECT policy_id, policy_revision, definition_digest, record_jcs FROM permission_policy_definitions",
    ).all();
    for (const row of definitionRows) {
      const bytes = toBytes(row.record_jcs);
      let record: JsonValue;
      try {
        record = parseCanonicalJsonBytes(bytes);
        assertCanonicalJsonValue(record);
        validateDefinition(record, "stored permission policy definition");
      } catch (error) {
        throw this.#corrupt(`stored permission policy definition is malformed: ${String(error)}`);
      }
      const object = record as Record<string, unknown>;
      if (
        !sameBytes(bytes, canonicalBytes(record)) ||
        object.policy_id !== row.policy_id ||
        object.policy_revision !== Number(row.policy_revision) ||
        object.definition_digest !== row.definition_digest
      ) {
        throw this.#corrupt("permission policy definition projection disagrees with its canonical record");
      }
    }

    const bindingRows = this.#connection.prepare(
      "SELECT binding_id, binding_revision, binding_digest, policy_id, policy_revision, policy_definition_digest, origin_component_id, origin_component_revision, origin_component_digest, record_jcs FROM permission_policy_backend_bindings",
    ).all();
    for (const row of bindingRows) {
      const bytes = toBytes(row.record_jcs);
      let record: JsonValue;
      try {
        record = parseCanonicalJsonBytes(bytes);
        assertCanonicalJsonValue(record);
        validateBinding(record, "stored permission policy backend binding");
      } catch (error) {
        throw this.#corrupt(`stored permission policy backend binding is malformed: ${String(error)}`);
      }
      const object = record as Record<string, unknown>;
      const origin = object.origin as Record<string, unknown>;
      if (
        !sameBytes(bytes, canonicalBytes(record)) ||
        object.binding_id !== row.binding_id ||
        object.binding_revision !== Number(row.binding_revision) ||
        object.binding_digest !== row.binding_digest ||
        object.policy_id !== row.policy_id ||
        object.policy_revision !== Number(row.policy_revision) ||
        object.policy_definition_digest !== row.policy_definition_digest ||
        origin.component_id !== row.origin_component_id ||
        origin.component_revision !== Number(row.origin_component_revision) ||
        origin.component_digest !== row.origin_component_digest
      ) {
        throw this.#corrupt("permission policy backend binding projection disagrees with its canonical record");
      }
    }

    const candidateRows = this.#connection.prepare(
      "SELECT origin_component_id, origin_component_revision, origin_component_digest, unit_name, mode, candidate_digest, record_jcs FROM linux_service_candidates",
    ).all();
    for (const row of candidateRows) {
      const bytes = toBytes(row.record_jcs);
      let record: JsonValue;
      try {
        record = parseCanonicalJsonBytes(bytes);
        assertCanonicalJsonValue(record);
        validateServiceCandidate(record, "stored Linux service candidate");
      } catch (error) {
        throw this.#corrupt(`stored Linux service candidate is malformed: ${String(error)}`);
      }
      const object = record as Record<string, unknown>;
      const origin = object.origin as Record<string, unknown>;
      if (
        !sameBytes(bytes, canonicalBytes(record)) ||
        origin.component_id !== row.origin_component_id ||
        origin.component_revision !== Number(row.origin_component_revision) ||
        origin.component_digest !== row.origin_component_digest ||
        object.unit_name !== row.unit_name ||
        object.mode !== row.mode ||
        object.candidate_digest !== row.candidate_digest
      ) {
        throw this.#corrupt("Linux service candidate projection disagrees with its canonical record");
      }
    }

    const selectionRowsByRevision: Record<string, PermissionPolicySelection[]> = Object.create(null);
    const premiseRows = this.#connection.prepare(
      "SELECT config_revision, config_digest, service_origin_component_id, service_origin_component_revision, service_unit_name, service_mode, service_candidate_digest, premises_digest FROM module_activation_premises",
    ).all();
    for (const row of premiseRows) {
      const revision = Number(row.config_revision);
      const premise = this.#loadPremise(revision, String(row.config_digest));
      if (premise === null) throw this.#corrupt(`stored premise ${revision} disappeared during verification`);
      const candidate = premise.service_candidate;
      if (
        candidate.origin.component_id !== row.service_origin_component_id ||
        candidate.origin.component_revision !== Number(row.service_origin_component_revision) ||
        candidate.unit_name !== row.service_unit_name ||
        candidate.mode !== row.service_mode ||
        candidate.candidate_digest !== row.service_candidate_digest ||
        premise.premises_digest !== row.premises_digest
      ) {
        throw this.#corrupt(`premise projection disagrees with its canonical record for revision ${revision}`);
      }
    }

    const selectionRows = this.#connection.prepare(
      "SELECT config_revision, policy_id, policy_revision, policy_definition_digest, binding_id, binding_revision, binding_digest FROM module_activation_premise_policy_selections ORDER BY config_revision, policy_id, policy_revision",
    ).all();
    for (const row of selectionRows) {
      const revision = Number(row.config_revision);
      const selection: PermissionPolicySelection = {
        policy_id: String(row.policy_id),
        policy_revision: Number(row.policy_revision),
        policy_definition_digest: String(row.policy_definition_digest),
        binding_id: String(row.binding_id),
        binding_revision: Number(row.binding_revision),
        binding_digest: String(row.binding_digest),
      };
      if (
        !isIntegralInRange(revision, 1, MAX_CONFIG_REVISION) ||
        !isStableId(selection.policy_id) ||
        !isStableId(selection.binding_id) ||
        !isIntegralInRange(selection.policy_revision, 1, MAX_CONFIG_REVISION) ||
        !isIntegralInRange(selection.binding_revision, 1, MAX_CONFIG_REVISION) ||
        !isSha256(selection.policy_definition_digest) ||
        !isSha256(selection.binding_digest)
      ) {
        throw this.#corrupt("stored premise-policy selection is malformed");
      }
      const expectedSelections = expectedSelectionsByRevision[String(revision)];
      if (
        expectedSelections === undefined ||
        !expectedSelections.some((expected) => selectionKey(expected) === selectionKey(selection))
      ) {
        throw this.#corrupt("stored premise-policy selection differs from canonical config");
      }
      const configDigest = mappingDigestByRevision[String(revision)];
      const premise = configDigest === undefined ? null : this.#loadPremise(revision, configDigest);
      if (premise === null) throw this.#corrupt(`stored selection ${revision} has no canonical premise`);
      const definition = premise.permission_policy_definitions.find(
        (value) => value.policy_id === selection.policy_id && value.policy_revision === selection.policy_revision,
      );
      if (definition === undefined || definition.definition_digest !== selection.policy_definition_digest) {
        throw this.#corrupt("stored premise-policy selection definition projection disagrees with its premise");
      }
      const binding = premise.permission_policy_backend_bindings.find(
        (value) => value.binding_id === selection.binding_id && value.binding_revision === selection.binding_revision,
      );
      if (
        binding === undefined ||
        binding.binding_digest !== selection.binding_digest ||
        binding.policy_id !== selection.policy_id ||
        binding.policy_revision !== selection.policy_revision ||
        binding.policy_definition_digest !== selection.policy_definition_digest
      ) {
        throw this.#corrupt("stored premise-policy selection binding projection disagrees with its premise");
      }
      (selectionRowsByRevision[String(revision)] ??= []).push(selection);
    }
    if (Object.keys(selectionRowsByRevision).some((revision) =>
      expectedSelectionsByRevision[revision] === undefined,
    )) {
      throw this.#corrupt("stored premise-policy selection references a missing mapping");
    }
    for (const row of premiseRows) {
      const revision = Number(row.config_revision);
      const expectedSelections = expectedSelectionsByRevision[String(revision)];
      const actualSelections = selectionRowsByRevision[String(revision)] ?? [];
      if (
        expectedSelections === undefined ||
        actualSelections.map(selectionKey).join("\u0001") !== expectedSelections.map(selectionKey).join("\u0001")
      ) {
        throw this.#corrupt(`premise selection projection disagrees with canonical config for revision ${revision}`);
      }
    }
  }


  #refreshControllerGeneration(): void {
    this.#statement("BEGIN IMMEDIATE").run();
    try {
      const state = this.#connection.prepare(
        "SELECT current_config_revision, current_config_digest FROM runtime_authority_state WHERE singleton = 1",
      ).get();
      if (!state) throw this.#corrupt("authority-state singleton disappeared during generation refresh");
      const recordBytes = Buffer.from(
        canonicalBytes(
          stateRecord(
            this.#identity,
            this.#controllerGenerationId,
            Number(state.current_config_revision),
            String(state.current_config_digest),
          ),
        ),
      );
      this.#connection.prepare(
        "UPDATE core_meta SET controller_generation_id = ? WHERE singleton = 1",
      ).run(this.#controllerGenerationId);
      this.#connection.prepare(
        "UPDATE runtime_authority_state SET controller_generation_id = ?, record_jcs = ? WHERE singleton = 1",
      ).run(this.#controllerGenerationId, recordBytes);
      this.#statement("COMMIT").run();
    } catch (error) {
      try {
        this.#statement("ROLLBACK").run();
      } catch {
        /* preserve the original failure */
      }
      throw this.#translateError(error);
    }
  }

  /** Loads a committed mapping with full identity/config verification; null when absent. */
  #resolveMapping(revision: number, declaredDigest: string): { bytes: Uint8Array; digest: string } | null {
    const row = this.#connection.prepare(
      "SELECT config_revision, daemon_installation_id, instance_id, config_digest, canonical_bytes FROM config_revision_mappings WHERE config_revision = ?",
    ).get(revision);
    if (!row) return null;
    if (
      Number(row.config_revision) !== revision ||
      row.daemon_installation_id !== this.#identity.daemonInstallationId ||
      row.instance_id !== this.#identity.instanceId ||
      String(row.config_digest) !== declaredDigest
    ) {
      throw this.#corrupt("config mapping projection disagrees with its stored authority identity or record");
    }
    const bytes = toBytes(row.canonical_bytes);
    let parsed: JsonValue;
    try {
      parsed = parseCanonicalJsonBytes(bytes);
      assertCanonicalJsonValue(parsed);
      validateResolvedConfiguration(parsed, `revision ${revision} canonical config`);
    } catch (error) {
      if (error instanceof RuntimeAuthorityDatabaseError) throw error;
      throw this.#corrupt(`revision ${revision} canonical_bytes are malformed: ${String(error)}`);
    }
    const canonical = canonicalBytes(parsed);
    if (!sameBytes(bytes, canonical)) {
      throw this.#corrupt(`revision ${revision} canonical_bytes are not canonical JSON bytes`);
    }
    const computed = sha256DigestOfBytes(canonical);
    if (computed !== declaredDigest) {
      throw this.#corrupt(`revision ${revision} canonical bytes do not match the stored digest`);
    }
    return { bytes: canonical, digest: declaredDigest };
  }

  /** Legacy source mapping reader used only before the v2 identity columns exist. */
  #resolveLegacyMapping(revision: number, declaredDigest: string): { bytes: Uint8Array; digest: string } | null {
    const row = this.#connection.prepare(
      "SELECT config_revision, config_digest, canonical_bytes FROM config_revision_mappings WHERE config_revision = ?",
    ).get(revision);
    if (!row) return null;
    if (Number(row.config_revision) !== revision || String(row.config_digest) !== declaredDigest) {
      throw this.#corrupt("legacy config mapping projection disagrees with its stored record");
    }
    const bytes = toBytes(row.canonical_bytes);
    let parsed: JsonValue;
    try {
      parsed = parseCanonicalJsonBytes(bytes);
      assertCanonicalJsonValue(parsed);
      validateResolvedConfiguration(parsed, `legacy revision ${revision} canonical config`);
    } catch (error) {
      if (error instanceof RuntimeAuthorityDatabaseError) throw error;
      throw this.#corrupt(`legacy revision ${revision} canonical_bytes are malformed: ${String(error)}`);
    }
    const canonical = canonicalBytes(parsed);
    if (!sameBytes(bytes, canonical) || sha256DigestOfBytes(canonical) !== declaredDigest) {
      throw this.#corrupt(`legacy revision ${revision} canonical bytes disagree with its digest`);
    }
    return { bytes: canonical, digest: declaredDigest };
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
    const rawRecordBytes = toBytes(row.record_jcs);
    let record: JsonValue;
    try {
      record = parseCanonicalJsonBytes(rawRecordBytes);
      assertCanonicalJsonValue(record);
    } catch (error) {
      throw this.#corrupt(`premise record_jcs for revision ${revision} is malformed: ${String(error)}`);
    }
    const canonicalRecordBytes = canonicalBytes(record);
    if (!sameBytes(rawRecordBytes, canonicalRecordBytes)) {
      throw this.#corrupt(`premise record_jcs for revision ${revision} is not canonical JSON bytes`);
    }
    const premise = validatePremise(record, `revision ${revision} premise`);
    if (
      premise.daemon_installation_id !== this.#identity.daemonInstallationId ||
      premise.instance_id !== this.#identity.instanceId ||
      premise.config_revision !== revision ||
      premise.config_digest !== configDigest
    ) {
      throw this.#corrupt(`premise record disagrees with revision ${revision} authority identity`);
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
      "SELECT current_config_revision, current_config_digest, controller_generation_id FROM runtime_authority_state WHERE singleton = 1",
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
      controller_generation_id: String(state?.controller_generation_id),
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

  /**
   * Project the closed Worker-start premise for the CURRENT authority
   * revision. Host-owned producers only: the caller must hold the controller
   * lock, and the premise is sealed (JCS record digest) and pinned to the
   * current `(config_revision, config_digest)` inside the same immediate-
   * transaction discipline as `installConfig`. Re-projecting the identical
   * premise is an idempotent no-op; any conflicting rewrite refuses closed.
   */
  installWorkerStartPremise(input: InstallWorkerStartPremiseInput): { readonly projected: boolean } {
    this.#requireOpen();
    this.#requireLockHeld();
    const snapshot = this.readCurrentConfig();
    if (snapshot === null) {
      throw new RuntimeAuthorityDatabaseError(
        "AUTHORITY_DATABASE_UNINITIALIZED",
        "Worker-start premise requires a committed current configuration",
      );
    }
    validateWorkerStartPremiseInput(input);
    const record = buildSealedWorkerStartPremise({
      daemon_installation_id: this.#identity.daemonInstallationId,
      instance_id: this.#identity.instanceId,
      config_revision: snapshot.config_revision,
      config_digest: snapshot.config_digest,
      extension_alias: input.extensionAlias,
      server_id: input.serverId,
      package_root: input.packageRoot,
      package_path: input.packagePath,
      package_digest: input.packageDigest,
      executable_digest: input.executableDigest,
      endpoint: input.endpoint,
    });
    let projected = false;
    this.#inAuthorityTransaction(undefined, () => {
      // Pointer must still name the premise revision inside the transaction.
      const state = this.#connection.prepare(
        "SELECT current_config_revision, current_config_digest FROM runtime_authority_state WHERE singleton = 1",
      ).get();
      if (
        state === undefined ||
        Number(state.current_config_revision) !== snapshot.config_revision ||
        String(state.current_config_digest) !== snapshot.config_digest
      ) {
        throw new RuntimeAuthorityDatabaseError(
          "CONFIG_REVISION_CONFLICT",
          "current pointer moved while projecting the Worker-start premise",
        );
      }
      const existing = this.#connection.prepare(
        "SELECT record_digest FROM worker_start_premises WHERE config_revision = ?",
      ).get(snapshot.config_revision);
      if (existing !== undefined) {
        if (String(existing.record_digest) === record.recordDigest) {
          return; // idempotent identical projection
        }
        throw new RuntimeAuthorityDatabaseError(
          "WORKER_START_PREMISE_CONFLICT",
          "a different Worker-start premise is already projected for this revision",
        );
      }
      this.#connection.prepare(
        "INSERT INTO worker_start_premises (config_revision, config_digest, extension_alias, server_id, package_root, package_path, package_digest, executable_digest, endpoint, record_jcs, record_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        snapshot.config_revision,
        snapshot.config_digest,
        input.extensionAlias,
        input.serverId,
        input.packageRoot,
        input.packagePath,
        input.packageDigest,
        input.executableDigest,
        input.endpoint,
        record.bytes,
        record.recordDigest,
      );
      projected = true;
    });
    return { projected };
  }

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
      "SELECT current_config_revision, current_config_digest, daemon_installation_id, instance_id, controller_generation_id FROM runtime_authority_state WHERE singleton = 1",
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
    if (premiseRequired) {
      try {
        validatePremise(input.premise, "premise");
      } catch (error) {
        if (error instanceof RuntimeAuthorityDatabaseError && error.message.includes("sorted and unique")) {
          throw new RuntimeAuthorityDatabaseError("MODULE_ACTIVATION_PREMISES_INVALID", error.message, { cause: error });
        }
        throw error;
      }
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
    // Insert the append-only mapping (REQ-AUTH-002 step 5). The identity
    // columns are Host-owned parent projections, not a parallel revision key.
    try {
      this.#connection.prepare(
        "INSERT INTO config_revision_mappings (config_revision, daemon_installation_id, instance_id, config_digest, canonical_bytes) VALUES (?, ?, ?, ?, ?)",
      ).run(
        next,
        input.identity.daemonInstallationId,
        input.identity.instanceId,
        input.configDigest,
        Buffer.from(input.canonicalConfigBytes),
      );
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
    try {
      validatePremise(premise, "premise");
    } catch (error) {
      if (error instanceof RuntimeAuthorityDatabaseError && error.message.includes("sorted and unique")) {
        throw new RuntimeAuthorityDatabaseError(
          "MODULE_ACTIVATION_PREMISES_INVALID",
          error.message,
          { cause: error },
        );
      }
      throw error;
    }
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
      const identity = this.#connection.prepare(
        "SELECT sqlite_version() AS version, sqlite_source_id() AS source_id",
      ).get();
      const versionParts = String(identity?.version ?? "").split(".").map((part) => Number(part));
      const versionNumber =
        versionParts.length === 3 && versionParts.every((part) => Number.isSafeInteger(part))
          ? (versionParts[0] ?? 0) * 1_000_000 + (versionParts[1] ?? 0) * 1_000 + (versionParts[2] ?? 0)
          : 0;
      const sourceId = String(identity?.source_id ?? "");
      const artifactDigest = sha256DigestOfBytes(Buffer.from(sourceId, "utf8"));
      this.#connection.prepare(
        "INSERT INTO core_meta (singleton, schema_version, daemon_installation_id, instance_id, controller_generation_id, clean_shutdown, sqlite_version_number, sqlite_source_id, sqlite_artifact_digest) VALUES (1, ?, ?, ?, ?, 0, ?, ?, ?)",
      ).run(
        RUNTIME_AUTHORITY_SCHEMA_VERSION,
        input.identity.daemonInstallationId,
        input.identity.instanceId,
        this.#controllerGenerationId,
        versionNumber,
        sourceId,
        artifactDigest,
      );
      this.#connection.prepare(
        "INSERT INTO commit_sequence (singleton, next_value) VALUES (1, ?)",
      ).run(2);
    }
    const bytes = Buffer.from(
      canonicalBytes(stateRecord(input.identity, this.#controllerGenerationId, next, input.configDigest)),
    );
    this.#connection.prepare(
      "INSERT INTO runtime_authority_state (singleton, authority_schema_version, daemon_installation_id, instance_id, controller_generation_id, current_config_revision, current_config_digest, record_jcs) VALUES (1, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(singleton) DO UPDATE SET authority_schema_version = excluded.authority_schema_version, " +
      "daemon_installation_id = excluded.daemon_installation_id, instance_id = excluded.instance_id, controller_generation_id = excluded.controller_generation_id, " +
      "current_config_revision = excluded.current_config_revision, current_config_digest = excluded.current_config_digest, record_jcs = excluded.record_jcs",
    ).run(
      HOST_AUTHORITY_SCHEMA_VERSION,
      input.identity.daemonInstallationId,
      input.identity.instanceId,
      this.#controllerGenerationId,
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
