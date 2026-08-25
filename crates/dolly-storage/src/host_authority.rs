//! Durable Host activation-premise authority in the shared Runtime SQLite.
//!
//! This module persists only closed, non-secret prerequisite records. It does
//! not mint a live backend binding, capability, process generation, transport
//! readiness, or dispatch outcome. Those are downstream Host observations and
//! cannot write these tables. A successful install commits the config mapping,
//! every referenced origin/definition/binding/candidate, the policy-selection
//! projection, the complete premise last, and the current pointer in one
//! transaction.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use dolly_canonical_json::{
    CanonicalJsonValue, MAX_SEMANTIC_JSON_NESTING_DEPTH, ParseLimits, Sha256Digest, canonicalize,
    deserialize_core_json,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Largest revision representable by the frozen safe-integer contract.
pub const MAX_AUTHORITY_REVISION: i64 = 9_007_199_254_740_991;
/// Runtime Host authority logical schema version.
pub const HOST_AUTHORITY_SCHEMA_VERSION: i64 = 2;

pub(crate) fn is_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index)
                || byte.is_ascii_digit()
                || byte.is_ascii_lowercase() && byte.is_ascii_hexdigit()
        })
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

/// Physical tables for the Host prerequisite authority. The table names and
/// projections follow runtime-authority-record/v1; `host_authority_meta` keeps
/// this slice's schema gate separate from the older DB-open `core_meta` row.
pub const HOST_AUTHORITY_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS host_authority_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 2)
);
INSERT OR IGNORE INTO host_authority_meta (singleton, authority_schema_version) VALUES (1, 2);
CREATE TABLE IF NOT EXISTS config_revision_mappings (
    config_revision INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND 9007199254740991),
    daemon_installation_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    config_digest TEXT NOT NULL,
    canonical_bytes BLOB NOT NULL,
    UNIQUE (config_revision, config_digest)
);
CREATE TABLE IF NOT EXISTS installed_component_origins (
    component_id TEXT NOT NULL,
    component_revision INTEGER NOT NULL CHECK (component_revision BETWEEN 1 AND 9007199254740991),
    component_digest TEXT NOT NULL,
    record_jcs BLOB NOT NULL,
    PRIMARY KEY (component_id, component_revision),
    UNIQUE (component_id, component_revision, component_digest)
);
CREATE TABLE IF NOT EXISTS permission_policy_definitions (
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL CHECK (policy_revision BETWEEN 1 AND 9007199254740991),
    definition_digest TEXT NOT NULL,
    record_jcs BLOB NOT NULL,
    PRIMARY KEY (policy_id, policy_revision),
    UNIQUE (policy_id, policy_revision, definition_digest)
);
CREATE TABLE IF NOT EXISTS permission_policy_backend_bindings (
    binding_id TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK (binding_revision BETWEEN 1 AND 9007199254740991),
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
CREATE TABLE IF NOT EXISTS linux_service_candidates (
    origin_component_id TEXT NOT NULL,
    origin_component_revision INTEGER NOT NULL CHECK (origin_component_revision BETWEEN 1 AND 9007199254740991),
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
CREATE TABLE IF NOT EXISTS module_activation_premises (
    config_revision INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND 9007199254740991),
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
    FOREIGN KEY (
      service_origin_component_id, service_origin_component_revision,
      service_unit_name, service_mode, service_candidate_digest
    ) REFERENCES linux_service_candidates(
      origin_component_id, origin_component_revision, unit_name, mode, candidate_digest
    )
);
CREATE TABLE IF NOT EXISTS module_activation_premise_policy_selections (
    config_revision INTEGER NOT NULL CHECK (config_revision BETWEEN 1 AND 9007199254740991),
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    policy_definition_digest TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    binding_revision INTEGER NOT NULL,
    binding_digest TEXT NOT NULL,
    PRIMARY KEY (config_revision, policy_id, policy_revision),
    UNIQUE (config_revision, binding_id, binding_revision, binding_digest),
    FOREIGN KEY (config_revision)
      REFERENCES module_activation_premises(config_revision) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (policy_id, policy_revision, policy_definition_digest)
      REFERENCES permission_policy_definitions(policy_id, policy_revision, definition_digest),
    FOREIGN KEY (
      binding_id, binding_revision, binding_digest,
      policy_id, policy_revision, policy_definition_digest
    ) REFERENCES permission_policy_backend_bindings(
      binding_id, binding_revision, binding_digest,
      policy_id, policy_revision, policy_definition_digest
    )
);
CREATE TABLE IF NOT EXISTS runtime_authority_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 2),
    daemon_installation_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    controller_generation_id TEXT NOT NULL,
    current_config_revision INTEGER NOT NULL CHECK (current_config_revision BETWEEN 1 AND 9007199254740991),
    current_config_digest TEXT NOT NULL,
    record_jcs BLOB NOT NULL,
    FOREIGN KEY (current_config_revision, current_config_digest)
      REFERENCES config_revision_mappings(config_revision, config_digest)
);
"#;

/// Stable identity of one Runtime authority database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeAuthorityIdentity {
    pub daemon_installation_id: String,
    pub instance_id: String,
}

/// Installed product component identity; it is evidence, not a live component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstalledComponentOrigin {
    pub schema: String,
    pub kind: String,
    pub component_id: String,
    pub component_revision: i64,
    pub component_digest: Sha256Digest,
}

/// Operator-approved source identity for one policy definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyDefinitionOrigin {
    pub schema: String,
    pub kind: String,
    pub source_id: String,
    pub source_revision: i64,
    pub source_digest: Sha256Digest,
}

/// Closed persistent policy definition. It contains no live backend handle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionPolicyDefinition {
    pub schema: String,
    pub policy_id: String,
    pub policy_revision: i64,
    pub definition_schema_uri: String,
    pub definition_schema_digest: Sha256Digest,
    pub definition: CanonicalJsonValue,
    pub origin: PolicyDefinitionOrigin,
    pub definition_digest: Sha256Digest,
}

/// Closed persistent binding from one policy revision to one installed Host component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionPolicyBackendBinding {
    pub schema: String,
    pub binding_id: String,
    pub binding_revision: i64,
    pub binding_digest: Sha256Digest,
    pub policy_id: String,
    pub policy_revision: i64,
    pub policy_definition_digest: Sha256Digest,
    pub origin: InstalledComponentOrigin,
}

/// Product-owned Linux service lookup candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinuxServiceCandidate {
    pub schema: String,
    pub origin: InstalledComponentOrigin,
    pub unit_name: String,
    pub mode: String,
    pub candidate_digest: Sha256Digest,
}

/// Relational projection of one selected policy and backend binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionPolicySelection {
    pub policy_id: String,
    pub policy_revision: i64,
    pub policy_definition_digest: Sha256Digest,
    pub binding_id: String,
    pub binding_revision: i64,
    pub binding_digest: Sha256Digest,
}

/// Canonical resolved configuration snapshot bound to one revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedConfiguration {
    pub runtime_config: CanonicalJsonValue,
    pub permission_policy_selections: Vec<PermissionPolicySelection>,
    pub service_candidate: Option<LinuxServiceCandidate>,
}

/// Closed final prerequisite set consumed by future Host verification.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModuleActivationPremises {
    pub schema: String,
    pub daemon_installation_id: String,
    pub instance_id: String,
    pub config_revision: i64,
    pub config_digest: Sha256Digest,
    pub permission_policy_definitions: Vec<PermissionPolicyDefinition>,
    pub permission_policy_backend_bindings: Vec<PermissionPolicyBackendBinding>,
    pub service_candidate: LinuxServiceCandidate,
    pub premises_digest: Sha256Digest,
}

/// Append-only config mapping row, including its exact canonical resolved config.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigRevisionMapping {
    pub schema: String,
    pub daemon_installation_id: String,
    pub instance_id: String,
    pub config_revision: i64,
    pub config_digest: Sha256Digest,
    pub canonical_config: ResolvedConfiguration,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeAuthorityStateRecord {
    schema: String,
    authority_schema_version: i64,
    daemon_installation_id: String,
    instance_id: String,
    controller_generation_id: String,
    current_config_revision: i64,
    current_config_digest: Sha256Digest,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyRuntimeAuthorityStateRecord {
    schema: String,
    authority_schema_version: i64,
    daemon_installation_id: String,
    instance_id: String,
    current_config_revision: i64,
    current_config_digest: Sha256Digest,
}

/// One candidate revision to commit. The premise, if present, must match the mapping.
#[derive(Debug, Clone, PartialEq)]
pub struct HostAuthorityRevision {
    pub identity: RuntimeAuthorityIdentity,
    pub mapping: ConfigRevisionMapping,
    pub premise: Option<ModuleActivationPremises>,
}

/// Verified current pointer plus all prerequisite records for that revision.
#[derive(Debug, Clone, PartialEq)]
pub struct CurrentAuthoritySnapshot {
    pub mapping: ConfigRevisionMapping,
    pub premise: Option<ModuleActivationPremises>,
}
/// Result of one append-only install.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallDisposition {
    Committed { config_revision: i64 },
    Reused { config_revision: i64 },
}

type PremiseProjectionRow = (String, i64, String, String, String, String, String, Vec<u8>);
type BindingProjectionRow = (String, String, i64, String, String, i64, String, Vec<u8>);

/// Closed failure set for the Host authority repository.
#[derive(Debug, Error)]
pub enum HostAuthorityError {
    #[error("host authority schema is unavailable: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("canonical record failure: {0}")]
    Canonical(String),
    #[error("malformed authority record: {0}")]
    Malformed(String),
    #[error("authority record digest mismatch: {0}")]
    DigestMismatch(String),
    #[error("authority relationship is invalid: {0}")]
    InvalidPremise(String),
    #[error("append-only revision conflict at {config_revision}: {reason}")]
    RevisionConflict {
        config_revision: i64,
        reason: String,
    },
}

/// Create the Host authority tables in the shared Runtime database.
pub fn create_host_authority_schema(connection: &Connection) -> Result<(), HostAuthorityError> {
    connection.execute_batch(HOST_AUTHORITY_SCHEMA_SQL)?;
    let version: i64 = connection.query_row(
        "SELECT authority_schema_version FROM host_authority_meta WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    if version != HOST_AUTHORITY_SCHEMA_VERSION {
        return Err(HostAuthorityError::Malformed(
            "unsupported Host authority schema version".into(),
        ));
    }
    Ok(())
}

/// Verify the complete v2 Host authority projection before reading or writing
/// any reachable row. SQLite's foreign-key check cannot detect an absent
/// prerequisite table, nullable identity column, altered CHECK, or an
/// unexpected trigger, so the physical shape is checked independently.
pub(crate) fn verify_authority_schema(connection: &Connection) -> Result<(), HostAuthorityError> {
    let tables = [
        "host_authority_meta",
        "config_revision_mappings",
        "installed_component_origins",
        "permission_policy_definitions",
        "permission_policy_backend_bindings",
        "linux_service_candidates",
        "module_activation_premises",
        "module_activation_premise_policy_selections",
        "runtime_authority_state",
    ];
    let parallel: Option<String> = connection
        .query_row(
            "SELECT name FROM sqlite_master WHERE name = 'config_revisions'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if parallel.is_some() {
        return Err(HostAuthorityError::Malformed(
            "parallel config_revisions object is not part of the authority schema".into(),
        ));
    }
    for table in tables {
        let kind: Option<String> = connection
            .query_row(
                "SELECT type FROM sqlite_master WHERE name = ?1",
                [table],
                |row| row.get(0),
            )
            .optional()?;
        if kind.as_deref() != Some("table") {
            return Err(HostAuthorityError::Malformed(format!(
                "required authority table {table} is missing or is not a table"
            )));
        }
    }
    verify_table_shape(
        connection,
        "host_authority_meta",
        &[
            ("singleton", "INTEGER", 0, 1),
            ("authority_schema_version", "INTEGER", 1, 0),
        ],
        &[
            "check (singleton = 1)",
            "check (authority_schema_version = 2)",
        ],
        &[],
    )?;
    verify_table_shape(
        connection,
        "config_revision_mappings",
        &[
            ("config_revision", "INTEGER", 0, 1),
            ("daemon_installation_id", "TEXT", 1, 0),
            ("instance_id", "TEXT", 1, 0),
            ("config_digest", "TEXT", 1, 0),
            ("canonical_bytes", "BLOB", 1, 0),
        ],
        &[
            "check (config_revision between 1 and 9007199254740991)",
            "unique (config_revision, config_digest)",
        ],
        &[],
    )?;
    verify_table_shape(
        connection,
        "installed_component_origins",
        &[
            ("component_id", "TEXT", 1, 1),
            ("component_revision", "INTEGER", 1, 2),
            ("component_digest", "TEXT", 1, 0),
            ("record_jcs", "BLOB", 1, 0),
        ],
        &[
            "check (component_revision between 1 and 9007199254740991)",
            "unique (component_id, component_revision, component_digest)",
        ],
        &[],
    )?;
    verify_table_shape(
        connection,
        "permission_policy_definitions",
        &[
            ("policy_id", "TEXT", 1, 1),
            ("policy_revision", "INTEGER", 1, 2),
            ("definition_digest", "TEXT", 1, 0),
            ("record_jcs", "BLOB", 1, 0),
        ],
        &[
            "check (policy_revision between 1 and 9007199254740991)",
            "unique (policy_id, policy_revision, definition_digest)",
        ],
        &[],
    )?;
    verify_table_shape(
        connection,
        "permission_policy_backend_bindings",
        &[
            ("binding_id", "TEXT", 1, 1),
            ("binding_revision", "INTEGER", 1, 2),
            ("binding_digest", "TEXT", 1, 0),
            ("policy_id", "TEXT", 1, 0),
            ("policy_revision", "INTEGER", 1, 0),
            ("policy_definition_digest", "TEXT", 1, 0),
            ("origin_component_id", "TEXT", 1, 0),
            ("origin_component_revision", "INTEGER", 1, 0),
            ("origin_component_digest", "TEXT", 1, 0),
            ("record_jcs", "BLOB", 1, 0),
        ],
        &[
            "check (binding_revision between 1 and 9007199254740991)",
            "unique (binding_id, binding_revision, binding_digest, policy_id, policy_revision, policy_definition_digest)",
        ],
        &[
            "permission_policy_definitions|policy_id|policy_id",
            "permission_policy_definitions|policy_revision|policy_revision",
            "permission_policy_definitions|policy_definition_digest|definition_digest",
            "installed_component_origins|origin_component_id|component_id",
            "installed_component_origins|origin_component_revision|component_revision",
            "installed_component_origins|origin_component_digest|component_digest",
        ],
    )?;
    verify_table_shape(
        connection,
        "linux_service_candidates",
        &[
            ("origin_component_id", "TEXT", 1, 1),
            ("origin_component_revision", "INTEGER", 1, 2),
            ("origin_component_digest", "TEXT", 1, 0),
            ("unit_name", "TEXT", 1, 3),
            ("mode", "TEXT", 1, 4),
            ("candidate_digest", "TEXT", 1, 0),
            ("record_jcs", "BLOB", 1, 0),
        ],
        &[
            "check (origin_component_revision between 1 and 9007199254740991)",
            "check (mode = 'user')",
            "unique (origin_component_id, origin_component_revision, unit_name, mode, candidate_digest)",
        ],
        &[
            "installed_component_origins|origin_component_id|component_id",
            "installed_component_origins|origin_component_revision|component_revision",
            "installed_component_origins|origin_component_digest|component_digest",
        ],
    )?;
    verify_table_shape(
        connection,
        "module_activation_premises",
        &[
            ("config_revision", "INTEGER", 0, 1),
            ("config_digest", "TEXT", 1, 0),
            ("service_origin_component_id", "TEXT", 1, 0),
            ("service_origin_component_revision", "INTEGER", 1, 0),
            ("service_unit_name", "TEXT", 1, 0),
            ("service_mode", "TEXT", 1, 0),
            ("service_candidate_digest", "TEXT", 1, 0),
            ("premises_digest", "TEXT", 1, 0),
            ("record_jcs", "BLOB", 1, 0),
        ],
        &[
            "check (config_revision between 1 and 9007199254740991)",
            "unique (config_revision, config_digest)",
        ],
        &[
            "config_revision_mappings|config_revision|config_revision",
            "config_revision_mappings|config_digest|config_digest",
            "linux_service_candidates|service_origin_component_id|origin_component_id",
            "linux_service_candidates|service_origin_component_revision|origin_component_revision",
            "linux_service_candidates|service_unit_name|unit_name",
            "linux_service_candidates|service_mode|mode",
            "linux_service_candidates|service_candidate_digest|candidate_digest",
        ],
    )?;
    verify_table_shape(
        connection,
        "module_activation_premise_policy_selections",
        &[
            ("config_revision", "INTEGER", 1, 1),
            ("policy_id", "TEXT", 1, 2),
            ("policy_revision", "INTEGER", 1, 3),
            ("policy_definition_digest", "TEXT", 1, 0),
            ("binding_id", "TEXT", 1, 0),
            ("binding_revision", "INTEGER", 1, 0),
            ("binding_digest", "TEXT", 1, 0),
        ],
        &[
            "check (config_revision between 1 and 9007199254740991)",
            "unique (config_revision, binding_id, binding_revision, binding_digest)",
            "deferrable initially deferred",
        ],
        &[
            "module_activation_premises|config_revision|config_revision",
            "permission_policy_definitions|policy_id|policy_id",
            "permission_policy_definitions|policy_revision|policy_revision",
            "permission_policy_definitions|policy_definition_digest|definition_digest",
            "permission_policy_backend_bindings|binding_id|binding_id",
            "permission_policy_backend_bindings|binding_revision|binding_revision",
            "permission_policy_backend_bindings|binding_digest|binding_digest",
            "permission_policy_backend_bindings|policy_id|policy_id",
            "permission_policy_backend_bindings|policy_revision|policy_revision",
            "permission_policy_backend_bindings|policy_definition_digest|policy_definition_digest",
        ],
    )?;
    verify_table_shape(
        connection,
        "runtime_authority_state",
        &[
            ("singleton", "INTEGER", 0, 1),
            ("authority_schema_version", "INTEGER", 1, 0),
            ("daemon_installation_id", "TEXT", 1, 0),
            ("instance_id", "TEXT", 1, 0),
            ("controller_generation_id", "TEXT", 1, 0),
            ("current_config_revision", "INTEGER", 1, 0),
            ("current_config_digest", "TEXT", 1, 0),
            ("record_jcs", "BLOB", 1, 0),
        ],
        &[
            "check (singleton = 1)",
            "check (authority_schema_version = 2)",
            "check (current_config_revision between 1 and 9007199254740991)",
        ],
        &[
            "config_revision_mappings|current_config_revision|config_revision",
            "config_revision_mappings|current_config_digest|config_digest",
        ],
    )?;
    verify_authority_indexes(connection)?;
    let mut foreign_key_check = connection.prepare("PRAGMA foreign_key_check")?;
    if foreign_key_check.query([])?.next()?.is_some() {
        return Err(HostAuthorityError::Malformed(
            "authority foreign-key check reported violations".into(),
        ));
    }
    let hostile_objects: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type IN ('trigger', 'view')
           AND tbl_name IN (
             'host_authority_meta',
             'config_revision_mappings',
             'installed_component_origins',
             'permission_policy_definitions',
             'permission_policy_backend_bindings',
             'linux_service_candidates',
             'module_activation_premises',
             'module_activation_premise_policy_selections',
             'runtime_authority_state'
           )",
        [],
        |row| row.get(0),
    )?;
    if hostile_objects != 0 {
        return Err(HostAuthorityError::Malformed(
            "authority tables have unexpected triggers or views".into(),
        ));
    }
    Ok(())
}

fn verify_authority_indexes(connection: &Connection) -> Result<(), HostAuthorityError> {
    let expected: [(&str, &[(bool, &str, bool, &[&str])]); 9] = [
        ("host_authority_meta", &[]),
        (
            "config_revision_mappings",
            &[(true, "u", false, &["config_revision", "config_digest"])],
        ),
        (
            "installed_component_origins",
            &[
                (true, "pk", false, &["component_id", "component_revision"]),
                (
                    true,
                    "u",
                    false,
                    &["component_id", "component_revision", "component_digest"],
                ),
            ],
        ),
        (
            "permission_policy_definitions",
            &[
                (true, "pk", false, &["policy_id", "policy_revision"]),
                (
                    true,
                    "u",
                    false,
                    &["policy_id", "policy_revision", "definition_digest"],
                ),
            ],
        ),
        (
            "permission_policy_backend_bindings",
            &[
                (true, "pk", false, &["binding_id", "binding_revision"]),
                (
                    true,
                    "u",
                    false,
                    &[
                        "binding_id",
                        "binding_revision",
                        "binding_digest",
                        "policy_id",
                        "policy_revision",
                        "policy_definition_digest",
                    ],
                ),
            ],
        ),
        (
            "linux_service_candidates",
            &[
                (
                    true,
                    "pk",
                    false,
                    &[
                        "origin_component_id",
                        "origin_component_revision",
                        "unit_name",
                        "mode",
                    ],
                ),
                (
                    true,
                    "u",
                    false,
                    &[
                        "origin_component_id",
                        "origin_component_revision",
                        "unit_name",
                        "mode",
                        "candidate_digest",
                    ],
                ),
            ],
        ),
        (
            "module_activation_premises",
            &[(true, "u", false, &["config_revision", "config_digest"])],
        ),
        (
            "module_activation_premise_policy_selections",
            &[
                (
                    true,
                    "pk",
                    false,
                    &["config_revision", "policy_id", "policy_revision"],
                ),
                (
                    true,
                    "u",
                    false,
                    &[
                        "config_revision",
                        "binding_id",
                        "binding_revision",
                        "binding_digest",
                    ],
                ),
            ],
        ),
        ("runtime_authority_state", &[]),
    ];
    for (table, expected_indexes) in expected {
        let mut statement = connection.prepare(&format!("PRAGMA index_list({table})"))?;
        let actual = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? != 0,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)? != 0,
                ))
            })?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?;
        if actual.len() != expected_indexes.len() {
            return Err(HostAuthorityError::Malformed(format!(
                "authority table {table} has a non-canonical index shape"
            )));
        }
        let mut matched = vec![false; expected_indexes.len()];
        for (index_name, unique, origin, partial) in actual {
            let escaped_name = index_name.replace('\'', "''");
            let mut xinfo = connection.prepare(&format!("PRAGMA index_xinfo('{escaped_name}')"))?;
            let mut columns = xinfo
                .query_map([], |row| {
                    let key: i64 = row.get(5)?;
                    if key == 0 {
                        return Ok(None);
                    }
                    Ok(Some((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                    )))
                })?
                .collect::<Result<Vec<_>, rusqlite::Error>>()?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            columns.sort_by_key(|column| column.0);
            let Some((position, _expected_index)) =
                expected_indexes
                    .iter()
                    .enumerate()
                    .find(|(_, expected_index)| {
                        expected_index.0 == unique
                            && expected_index.1 == origin
                            && expected_index.2 == partial
                            && expected_index.3.len() == columns.len()
                            && expected_index.3.iter().zip(&columns).all(|(name, column)| {
                                column.1.as_deref() == Some(*name)
                                    && column.2 == 0
                                    && column.3.eq_ignore_ascii_case("BINARY")
                            })
                    })
            else {
                return Err(HostAuthorityError::Malformed(format!(
                    "authority table {table} has a wrong index shape"
                )));
            };
            if matched[position] {
                return Err(HostAuthorityError::Malformed(format!(
                    "authority table {table} has duplicate normative indexes"
                )));
            }
            matched[position] = true;
        }
        if matched.iter().any(|value| !value) {
            return Err(HostAuthorityError::Malformed(format!(
                "authority table {table} is missing a normative index"
            )));
        }
    }
    Ok(())
}

fn sql_tokens(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if bytes[index] == b'-' && bytes.get(index + 1) == Some(&b'-') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        if matches!(bytes[index], b'\'' | b'"' | b'`') {
            let quote = bytes[index];
            let start = index;
            index += 1;
            while index < bytes.len() {
                if bytes[index] == quote {
                    if bytes.get(index + 1) == Some(&quote) {
                        index += 2;
                        continue;
                    }
                    index += 1;
                    break;
                }
                index += 1;
            }
            tokens.push(String::from_utf8_lossy(&bytes[start..index]).to_ascii_lowercase());
            continue;
        }
        if bytes[index] == b'[' {
            let start = index;
            index += 1;
            while index < bytes.len() && bytes[index] != b']' {
                index += 1;
            }
            index = (index + 1).min(bytes.len());
            tokens.push(String::from_utf8_lossy(&bytes[start..index]).to_ascii_lowercase());
            continue;
        }
        let start = index;
        while index < bytes.len()
            && !bytes[index].is_ascii_whitespace()
            && !matches!(
                bytes[index],
                b'(' | b')'
                    | b','
                    | b'='
                    | b'<'
                    | b'>'
                    | b'+'
                    | b'-'
                    | b'*'
                    | b'/'
                    | b'['
                    | b']'
                    | b';'
            )
        {
            index += 1;
        }
        if start == index {
            tokens.push(String::from_utf8_lossy(&bytes[index..=index]).to_ascii_lowercase());
            index += 1;
        } else {
            tokens.push(String::from_utf8_lossy(&bytes[start..index]).to_ascii_lowercase());
        }
    }
    tokens
}

fn sql_has_token_sequence(tokens: &[String], fragment: &str) -> bool {
    let expected = sql_tokens(fragment);
    !expected.is_empty()
        && tokens
            .windows(expected.len())
            .any(|window| window == expected.as_slice())
}

fn verify_table_shape(
    connection: &Connection,
    table: &str,
    expected_columns: &[(&str, &str, i64, i64)],
    checks: &[&str],
    expected_foreign_keys: &[&str],
) -> Result<(), HostAuthorityError> {
    let columns: Vec<(String, String, i64, i64)> = {
        let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?
    };
    if columns.len() != expected_columns.len()
        || columns
            .iter()
            .zip(expected_columns)
            .any(|(actual, expected)| {
                actual.0 != expected.0
                    || actual.1.to_ascii_uppercase() != expected.1
                    || actual.2 != expected.2
                    || actual.3 != expected.3
            })
    {
        return Err(HostAuthorityError::Malformed(format!(
            "authority table {table} has a non-canonical column shape"
        )));
    }
    let sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )?;
    let tokens = sql_tokens(&sql);
    for check in checks {
        if !sql_has_token_sequence(&tokens, check) {
            return Err(HostAuthorityError::Malformed(format!(
                "authority table {table} is missing constraint {check}"
            )));
        }
    }
    let mut foreign_keys = {
        let mut statement = connection.prepare(&format!("PRAGMA foreign_key_list({table})"))?;
        statement
            .query_map([], |row| {
                Ok(format!(
                    "{}|{}|{}",
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?
                ))
            })?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?
    };
    foreign_keys.sort();
    let mut expected = expected_foreign_keys
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    expected.sort();
    if foreign_keys != expected {
        return Err(HostAuthorityError::Malformed(format!(
            "authority table {table} has a non-canonical foreign-key shape"
        )));
    }
    Ok(())
}

/// Preflight the v1 authority projection without changing any object. This
/// uses the same table/column/constraint contract as v2, except for the
/// v1 Host meta/state version and the deliberately absent controller
/// generation column. Migration callers run this before opening their write
/// transaction so malformed unused parents cannot be discovered after ALTER.
pub(crate) fn verify_legacy_authority_schema(
    connection: &Connection,
) -> Result<(), HostAuthorityError> {
    let specs: [(&str, &[&str], &[&str]); 9] = [
        (
            "host_authority_meta",
            &["singleton", "authority_schema_version"],
            &["authority_schema_version = 1"],
        ),
        (
            "config_revision_mappings",
            &[
                "config_revision",
                "daemon_installation_id",
                "instance_id",
                "config_digest",
                "canonical_bytes",
            ],
            &["unique"],
        ),
        (
            "installed_component_origins",
            &[
                "component_id",
                "component_revision",
                "component_digest",
                "record_jcs",
            ],
            &["unique"],
        ),
        (
            "permission_policy_definitions",
            &[
                "policy_id",
                "policy_revision",
                "definition_digest",
                "record_jcs",
            ],
            &["unique"],
        ),
        (
            "permission_policy_backend_bindings",
            &[
                "binding_id",
                "binding_revision",
                "binding_digest",
                "policy_id",
                "policy_revision",
                "policy_definition_digest",
                "origin_component_id",
                "origin_component_revision",
                "origin_component_digest",
                "record_jcs",
            ],
            &["unique", "foreign key"],
        ),
        (
            "linux_service_candidates",
            &[
                "origin_component_id",
                "origin_component_revision",
                "origin_component_digest",
                "unit_name",
                "mode",
                "candidate_digest",
                "record_jcs",
            ],
            &["unique", "foreign key"],
        ),
        (
            "module_activation_premises",
            &[
                "config_revision",
                "config_digest",
                "service_origin_component_id",
                "service_origin_component_revision",
                "service_unit_name",
                "service_mode",
                "service_candidate_digest",
                "premises_digest",
                "record_jcs",
            ],
            &["unique", "foreign key"],
        ),
        (
            "module_activation_premise_policy_selections",
            &[
                "config_revision",
                "policy_id",
                "policy_revision",
                "policy_definition_digest",
                "binding_id",
                "binding_revision",
                "binding_digest",
            ],
            &["unique", "foreign key"],
        ),
        (
            "runtime_authority_state",
            &[
                "singleton",
                "authority_schema_version",
                "daemon_installation_id",
                "instance_id",
                "current_config_revision",
                "current_config_digest",
                "record_jcs",
            ],
            &["authority_schema_version = 1", "foreign key"],
        ),
    ];
    for (table, expected_columns, sql_fragments) in specs {
        let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
        let actual: Vec<String> = statement
            .query_map([], |row| row.get(1))?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?;
        if actual
            .iter()
            .map(String::as_str)
            .ne(expected_columns.iter().copied())
        {
            return Err(HostAuthorityError::Malformed(format!(
                "legacy authority table {table} has a non-canonical column shape"
            )));
        }
        let sql: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )?;
        let tokens = sql_tokens(&sql);
        if sql_fragments
            .iter()
            .any(|fragment| !sql_has_token_sequence(&tokens, fragment))
        {
            return Err(HostAuthorityError::Malformed(format!(
                "legacy authority table {table} is missing a required constraint"
            )));
        }
    }
    verify_authority_indexes(connection)?;
    let mut foreign_key_check = connection.prepare("PRAGMA foreign_key_check")?;
    if foreign_key_check.query([])?.next()?.is_some() {
        return Err(HostAuthorityError::Malformed(
            "legacy authority foreign-key check reported violations".into(),
        ));
    }
    Ok(())
}

/// Atomically install one config mapping and its final premise authority.
pub fn install_host_authority_revision(
    db: &mut crate::Database,
    input: HostAuthorityRevision,
) -> Result<InstallDisposition, HostAuthorityError> {
    validate_revision(&input)?;
    // A same-revision install is an idempotent read of the existing authority;
    // verify every canonical row before allowing it to return Reused.
    let _ = load_current_authority(db.connection())?;

    let tx = db
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let disposition = install_host_authority_revision_in_transaction(&tx, &input)?;
    tx.commit()?;
    Ok(disposition)
}
/// Shared transaction body used by normal installs and explicit legacy
/// migration. It is deliberately crate-private: callers cannot publish a
/// pointer without the Database controller lock and open-time gate.
pub(crate) fn install_host_authority_revision_in_transaction(
    tx: &Transaction<'_>,
    input: &HostAuthorityRevision,
) -> Result<InstallDisposition, HostAuthorityError> {
    validate_revision(input)?;
    let current = load_state_row(tx)?;
    if let Some((current_identity, current_revision, current_digest)) = current {
        if current_identity != input.identity {
            return Err(HostAuthorityError::RevisionConflict {
                config_revision: input.mapping.config_revision,
                reason: "runtime authority identity differs from the committed pointer".into(),
            });
        }
        if current_revision == input.mapping.config_revision {
            let incoming_bytes =
                canonical_bytes(&input.mapping.canonical_config, "canonical resolved config")?;
            let existing_bytes: Vec<u8> = tx.query_row(
                "SELECT canonical_bytes FROM config_revision_mappings WHERE config_revision = ?1",
                [current_revision],
                |row| row.get(0),
            )?;
            if current_digest == input.mapping.config_digest && existing_bytes == incoming_bytes {
                return Ok(InstallDisposition::Reused {
                    config_revision: current_revision,
                });
            }
            return Err(HostAuthorityError::RevisionConflict {
                config_revision: input.mapping.config_revision,
                reason: "current digest or canonical bytes differ".into(),
            });
        }
        if input.mapping.config_revision != current_revision + 1 {
            return Err(HostAuthorityError::RevisionConflict {
                config_revision: input.mapping.config_revision,
                reason: "revision is not the next monotonic value".into(),
            });
        }
    } else if input.mapping.config_revision != 1 {
        return Err(HostAuthorityError::RevisionConflict {
            config_revision: input.mapping.config_revision,
            reason: "first authority revision must be 1".into(),
        });
    }

    ensure_core_identity(tx, &input.identity)?;
    let controller_generation_id: String = tx.query_row(
        "SELECT controller_generation_id FROM core_meta WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    if !is_uuid_v7(&controller_generation_id) {
        return Err(HostAuthorityError::InvalidPremise(
            "controller generation is not a valid UUIDv7".into(),
        ));
    }
    let mapping_bytes =
        canonical_bytes(&input.mapping.canonical_config, "canonical resolved config")?;
    insert_mapping(tx, &input.mapping, &mapping_bytes)?;
    if let Some(premise) = input.premise.as_ref() {
        insert_origin(tx, &premise.service_candidate.origin)?;
        for definition in &premise.permission_policy_definitions {
            let definition_bytes = canonical_bytes(definition, "policy definition")?;
            insert_definition(tx, definition, &definition_bytes)?;
        }
        for binding in &premise.permission_policy_backend_bindings {
            insert_origin(tx, &binding.origin)?;
            let binding_bytes = canonical_bytes(binding, "policy backend binding")?;
            insert_binding(tx, binding, &binding_bytes)?;
        }
        let candidate_bytes = canonical_bytes(&premise.service_candidate, "service candidate")?;
        insert_candidate(tx, &premise.service_candidate, &candidate_bytes)?;
        for selection in &input.mapping.canonical_config.permission_policy_selections {
            insert_selection(tx, input.mapping.config_revision, selection)?;
        }
        // The complete premise is the last prerequisite record.
        insert_premise(tx, premise)?;
    }
    let state = RuntimeAuthorityStateRecord {
        schema: "dolly.runtime-authority-state/v1".into(),
        authority_schema_version: HOST_AUTHORITY_SCHEMA_VERSION,
        daemon_installation_id: input.identity.daemon_installation_id.clone(),
        instance_id: input.identity.instance_id.clone(),
        controller_generation_id: controller_generation_id.clone(),
        current_config_revision: input.mapping.config_revision,
        current_config_digest: input.mapping.config_digest.clone(),
    };
    let state_bytes = canonical_bytes(&state, "authority state")?;
    tx.execute(
        "INSERT INTO runtime_authority_state (
            singleton, authority_schema_version, daemon_installation_id, instance_id,
            controller_generation_id, current_config_revision, current_config_digest,
            record_jcs
         ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(singleton) DO UPDATE SET
            authority_schema_version = excluded.authority_schema_version,
            daemon_installation_id = excluded.daemon_installation_id,
            instance_id = excluded.instance_id,
            controller_generation_id = excluded.controller_generation_id,
            current_config_revision = excluded.current_config_revision,
            current_config_digest = excluded.current_config_digest,
            record_jcs = excluded.record_jcs",
        params![
            HOST_AUTHORITY_SCHEMA_VERSION,
            &state.daemon_installation_id,
            &state.instance_id,
            &state.controller_generation_id,
            state.current_config_revision,
            state.current_config_digest.to_string(),
            state_bytes,
        ],
    )?;
    Ok(InstallDisposition::Committed {
        config_revision: input.mapping.config_revision,
    })
}

fn ensure_core_identity(
    tx: &Transaction<'_>,
    identity: &RuntimeAuthorityIdentity,
) -> Result<(), HostAuthorityError> {
    let existing: Option<(Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT daemon_installation_id, instance_id
             FROM core_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((daemon, instance)) = existing else {
        return Err(HostAuthorityError::InvalidPremise(
            "core_meta identity row is missing".into(),
        ));
    };
    match (daemon, instance) {
        (None, None) => {
            tx.execute(
                "UPDATE core_meta SET daemon_installation_id = ?1, instance_id = ?2
                 WHERE singleton = 1",
                params![&identity.daemon_installation_id, &identity.instance_id],
            )?;
            Ok(())
        }
        (Some(daemon), Some(instance))
            if daemon == identity.daemon_installation_id && instance == identity.instance_id =>
        {
            Ok(())
        }
        _ => Err(HostAuthorityError::RevisionConflict {
            config_revision: 0,
            reason: "core_meta identity differs from the authority producer".into(),
        }),
    }
}
pub(crate) fn refresh_controller_generation_in_transaction(
    tx: &Transaction<'_>,
    generation: &str,
) -> Result<(), HostAuthorityError> {
    if !is_uuid_v7(generation) {
        return Err(HostAuthorityError::InvalidPremise(
            "controller generation is not a valid UUIDv7".into(),
        ));
    }
    let state_bytes: Vec<u8> = tx.query_row(
        "SELECT record_jcs FROM runtime_authority_state WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    let mut state: RuntimeAuthorityStateRecord = decode_record(&state_bytes, "authority state")?;
    if canonical_bytes(&state, "authority state")? != state_bytes {
        return Err(HostAuthorityError::DigestMismatch(
            "authority state canonical bytes".into(),
        ));
    }
    state.controller_generation_id = generation.to_string();
    let refreshed_bytes = canonical_bytes(&state, "authority state")?;
    tx.execute(
        "UPDATE runtime_authority_state
         SET controller_generation_id = ?1, record_jcs = ?2
         WHERE singleton = 1",
        params![generation, refreshed_bytes],
    )?;
    Ok(())
}

/// Load and fully verify the committed current pointer and premise.
pub fn load_current_authority(
    connection: &Connection,
) -> Result<Option<CurrentAuthoritySnapshot>, HostAuthorityError> {
    load_current_authority_with_generation(connection)
        .map(|snapshot| snapshot.map(|(snapshot, _generation)| snapshot))
}

pub(crate) fn load_current_authority_with_generation(
    connection: &Connection,
) -> Result<Option<(CurrentAuthoritySnapshot, String)>, HostAuthorityError> {
    verify_authority_schema(connection)?;
    let parallel: i64 = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_revisions'
         )",
        [],
        |row| row.get(0),
    )?;
    if parallel != 0 {
        return Err(HostAuthorityError::Malformed(
            "parallel config_revisions table is not part of the authority schema".into(),
        ));
    }
    let Some((identity, generation, revision, digest, state_bytes)) = connection
        .query_row(
            "SELECT daemon_installation_id, instance_id, controller_generation_id,
                    current_config_revision, current_config_digest, record_jcs
             FROM runtime_authority_state WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    RuntimeAuthorityIdentity {
                        daemon_installation_id: row.get(0)?,
                        instance_id: row.get(1)?,
                    },
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let state: RuntimeAuthorityStateRecord = decode_record(&state_bytes, "authority state")?;
    if canonical_bytes(&state, "authority state")? != state_bytes {
        return Err(HostAuthorityError::DigestMismatch(
            "authority state canonical bytes".into(),
        ));
    }
    if state.schema != "dolly.runtime-authority-state/v1"
        || state.authority_schema_version != HOST_AUTHORITY_SCHEMA_VERSION
        || state.daemon_installation_id != identity.daemon_installation_id
        || state.instance_id != identity.instance_id
        || state.controller_generation_id != generation
        || state.current_config_revision != revision
        || state.current_config_digest.to_string() != digest
    {
        return Err(HostAuthorityError::InvalidPremise(
            "runtime authority pointer projection does not match its canonical record".into(),
        ));
    }
    let snapshot = load_authority_snapshot(connection, &identity, revision, &digest)?;
    Ok(Some((snapshot, generation)))
}

/// Load the pre-generation Host authority used only by the explicit offline
/// v1-to-v2 migration. Ordinary open must never call this path.
pub(crate) fn load_legacy_current_authority(
    connection: &Connection,
) -> Result<Option<CurrentAuthoritySnapshot>, HostAuthorityError> {
    let Some((authority_schema_version, identity, revision, digest, state_bytes)) = connection
        .query_row(
            "SELECT authority_schema_version, daemon_installation_id, instance_id,
                    current_config_revision, current_config_digest, record_jcs
             FROM runtime_authority_state WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    RuntimeAuthorityIdentity {
                        daemon_installation_id: row.get(1)?,
                        instance_id: row.get(2)?,
                    },
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let state: LegacyRuntimeAuthorityStateRecord =
        decode_record(&state_bytes, "legacy authority state")?;
    if canonical_bytes(&state, "legacy authority state")? != state_bytes {
        return Err(HostAuthorityError::DigestMismatch(
            "legacy authority state canonical bytes".into(),
        ));
    }
    if authority_schema_version != 1
        || state.schema != "dolly.runtime-authority-state/v1"
        || state.authority_schema_version != 1
        || state.daemon_installation_id != identity.daemon_installation_id
        || state.instance_id != identity.instance_id
        || state.current_config_revision != revision
        || state.current_config_digest.to_string() != digest
    {
        return Err(HostAuthorityError::InvalidPremise(
            "legacy runtime authority pointer projection does not match its canonical record"
                .into(),
        ));
    }
    load_authority_snapshot(connection, &identity, revision, &digest).map(Some)
}

fn load_authority_snapshot(
    connection: &Connection,
    identity: &RuntimeAuthorityIdentity,
    revision: i64,
    digest: &str,
) -> Result<CurrentAuthoritySnapshot, HostAuthorityError> {
    let has_mapping_identity =
        table_has_column(
            connection,
            "config_revision_mappings",
            "daemon_installation_id",
        )? && table_has_column(connection, "config_revision_mappings", "instance_id")?;
    let mapping_row: Option<(String, String, i64, String, Vec<u8>)> = if has_mapping_identity {
        connection
            .query_row(
                "SELECT daemon_installation_id, instance_id, config_revision, config_digest,
                        canonical_bytes
                 FROM config_revision_mappings
                 WHERE config_revision = ?1 AND config_digest = ?2",
                params![revision, digest],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?
    } else {
        // TypeScript's pre-bridge v1 projection did not repeat the authority
        // identity on each mapping row. During the explicit migration window
        // the core identity is the only permitted source for this projection.
        let row: Option<(i64, String, Vec<u8>)> = connection
            .query_row(
                "SELECT config_revision, config_digest, canonical_bytes
                 FROM config_revision_mappings
                 WHERE config_revision = ?1 AND config_digest = ?2",
                params![revision, digest],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        row.map(|(mapping_revision, mapping_digest, bytes)| {
            (
                identity.daemon_installation_id.clone(),
                identity.instance_id.clone(),
                mapping_revision,
                mapping_digest,
                bytes,
            )
        })
    };
    let Some((
        mapping_daemon,
        mapping_instance,
        mapping_revision,
        mapping_digest_text,
        config_bytes,
    )) = mapping_row
    else {
        return Err(HostAuthorityError::InvalidPremise(
            "current mapping is missing".into(),
        ));
    };
    if mapping_daemon != identity.daemon_installation_id || mapping_instance != identity.instance_id
    {
        return Err(HostAuthorityError::InvalidPremise(
            "current mapping identity differs from authority state".into(),
        ));
    }
    let mapping_digest = mapping_digest_text
        .parse::<Sha256Digest>()
        .map_err(|_| HostAuthorityError::Malformed("mapping config_digest".into()))?;
    let mapping = ConfigRevisionMapping {
        schema: "dolly.config-revision-mapping/v1".into(),
        daemon_installation_id: mapping_daemon,
        instance_id: mapping_instance,
        config_revision: mapping_revision,
        config_digest: mapping_digest,
        canonical_config: decode_record(&config_bytes, "canonical resolved config")?,
    };

    let premise = connection
        .query_row(
            "SELECT record_jcs FROM module_activation_premises
             WHERE config_revision = ?1",
            [revision],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()?
        .map(|bytes| decode_record(&bytes, "activation premise"))
        .transpose()?;
    let snapshot = CurrentAuthoritySnapshot { mapping, premise };
    verify_persisted_snapshot(connection, &snapshot)?;
    verify_all_persisted_rows(connection, &identity)?;
    validate_loaded_snapshot(&snapshot)?;
    Ok(snapshot)
}

fn table_has_column(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, HostAuthorityError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Rewrite a validated v1 authority into the v2 physical schema. The caller
/// must hold the path and identity locks in that order and must execute this
/// body inside one immediate transaction.
pub(crate) fn migrate_legacy_authority_in_transaction(
    tx: &Transaction<'_>,
    generation: &str,
) -> Result<(), HostAuthorityError> {
    if !is_uuid_v7(generation) {
        return Err(HostAuthorityError::InvalidPremise(
            "controller generation is not a valid UUIDv7".into(),
        ));
    }
    let Some(snapshot) = load_legacy_current_authority(tx)? else {
        return Err(HostAuthorityError::InvalidPremise(
            "legacy current authority is missing".into(),
        ));
    };
    let host_version: i64 = tx.query_row(
        "SELECT authority_schema_version FROM host_authority_meta WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    if host_version != 1 {
        return Err(HostAuthorityError::Malformed(
            "offline migration requires Host authority schema v1".into(),
        ));
    }
    let mut columns = BTreeSet::new();
    let mut statement = tx.prepare("PRAGMA table_info(runtime_authority_state)")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        columns.insert(row?);
    }
    if columns.contains("controller_generation_id") {
        return Err(HostAuthorityError::Malformed(
            "offline migration target already has controller generation".into(),
        ));
    }
    let core_row: Option<(
        i64,
        Option<String>,
        Option<String>,
        i64,
        i64,
        String,
        String,
    )> = tx
        .query_row(
            "SELECT schema_version, daemon_installation_id, instance_id, clean_shutdown,
                    sqlite_version_number, sqlite_source_id, sqlite_artifact_digest
             FROM core_meta WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((
        schema_version,
        Some(core_daemon),
        Some(core_instance),
        clean_shutdown,
        sqlite_version_number,
        sqlite_source_id,
        sqlite_artifact_digest,
    )) = core_row
    else {
        return Err(HostAuthorityError::Malformed(
            "core authority identity row is missing or nullable".into(),
        ));
    };
    if schema_version != 1
        || core_daemon != snapshot.mapping.daemon_installation_id
        || core_instance != snapshot.mapping.instance_id
        || !matches!(clean_shutdown, 0 | 1)
    {
        return Err(HostAuthorityError::Malformed(
            "legacy core authority row disagrees with the authority identity".into(),
        ));
    }
    tx.execute_batch(
        "CREATE TABLE core_meta__dolly_v2 (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            schema_version INTEGER NOT NULL,
            daemon_installation_id TEXT,
            instance_id TEXT,
            controller_generation_id TEXT,
            clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)),
            sqlite_version_number INTEGER NOT NULL,
            sqlite_source_id TEXT NOT NULL,
            sqlite_artifact_digest TEXT NOT NULL
        );",
    )?;
    tx.execute(
        "INSERT INTO core_meta__dolly_v2 (
            singleton, schema_version, daemon_installation_id, instance_id,
            controller_generation_id, clean_shutdown, sqlite_version_number,
            sqlite_source_id, sqlite_artifact_digest
         ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            schema_version,
            core_daemon,
            core_instance,
            generation,
            clean_shutdown,
            sqlite_version_number,
            sqlite_source_id,
            sqlite_artifact_digest,
        ],
    )?;
    tx.execute_batch(
        "DROP TABLE core_meta;
         ALTER TABLE core_meta__dolly_v2 RENAME TO core_meta;",
    )?;

    let state = RuntimeAuthorityStateRecord {
        schema: "dolly.runtime-authority-state/v1".into(),
        authority_schema_version: HOST_AUTHORITY_SCHEMA_VERSION,
        daemon_installation_id: snapshot.mapping.daemon_installation_id.clone(),
        instance_id: snapshot.mapping.instance_id.clone(),
        controller_generation_id: generation.to_owned(),
        current_config_revision: snapshot.mapping.config_revision,
        current_config_digest: snapshot.mapping.config_digest.clone(),
    };
    let state_bytes = canonical_bytes(&state, "authority state")?;
    tx.execute_batch(
        "CREATE TABLE runtime_authority_state__dolly_v2 (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 2),
            daemon_installation_id TEXT NOT NULL,
            instance_id TEXT NOT NULL,
            controller_generation_id TEXT NOT NULL,
            current_config_revision INTEGER NOT NULL CHECK (current_config_revision BETWEEN 1 AND 9007199254740991),
            current_config_digest TEXT NOT NULL,
            record_jcs BLOB NOT NULL,
            FOREIGN KEY (current_config_revision, current_config_digest)
              REFERENCES config_revision_mappings(config_revision, config_digest)
        );
        CREATE TABLE host_authority_meta__dolly_v2 (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 2)
        );",
    )?;
    tx.execute(
        "INSERT INTO runtime_authority_state__dolly_v2 (
            singleton, authority_schema_version, daemon_installation_id, instance_id,
            controller_generation_id, current_config_revision, current_config_digest,
            record_jcs
         ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            HOST_AUTHORITY_SCHEMA_VERSION,
            &state.daemon_installation_id,
            &state.instance_id,
            generation,
            state.current_config_revision,
            state.current_config_digest.to_string(),
            state_bytes,
        ],
    )?;
    tx.execute(
        "INSERT INTO host_authority_meta__dolly_v2
            (singleton, authority_schema_version) VALUES (1, ?1)",
        [HOST_AUTHORITY_SCHEMA_VERSION],
    )?;
    tx.execute_batch(
        "DROP TABLE runtime_authority_state;
         ALTER TABLE runtime_authority_state__dolly_v2
           RENAME TO runtime_authority_state;
         DROP TABLE host_authority_meta;
         ALTER TABLE host_authority_meta__dolly_v2
           RENAME TO host_authority_meta;",
    )?;
    Ok(())
}

fn verify_persisted_snapshot(
    connection: &Connection,
    snapshot: &CurrentAuthoritySnapshot,
) -> Result<(), HostAuthorityError> {
    let mapping_bytes: Vec<u8> = connection
        .query_row(
            "SELECT canonical_bytes FROM config_revision_mappings
             WHERE config_revision = ?1 AND config_digest = ?2",
            params![
                snapshot.mapping.config_revision,
                snapshot.mapping.config_digest.to_string()
            ],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            HostAuthorityError::InvalidPremise("current mapping bytes are missing".into())
        })?;
    if mapping_bytes
        != canonical_bytes(
            &snapshot.mapping.canonical_config,
            "canonical resolved config",
        )?
    {
        return Err(HostAuthorityError::DigestMismatch(
            "canonical resolved config bytes".into(),
        ));
    }

    match snapshot.premise.as_ref() {
        Some(premise) => {
            let premise_row: Option<PremiseProjectionRow> = connection
                .query_row(
                    "SELECT config_digest, service_origin_component_revision,
                            service_origin_component_id, service_unit_name, service_mode,
                            service_candidate_digest, premises_digest, record_jcs
                     FROM module_activation_premises WHERE config_revision = ?1",
                    [premise.config_revision],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                        ))
                    },
                )
                .optional()?;
            let Some((
                config_digest,
                origin_revision,
                origin_id,
                unit_name,
                mode,
                candidate_digest,
                premises_digest,
                premise_bytes,
            )) = premise_row
            else {
                return Err(HostAuthorityError::InvalidPremise(
                    "current activation premise is missing".into(),
                ));
            };
            if config_digest != premise.config_digest.to_string()
                || origin_revision != premise.service_candidate.origin.component_revision
                || origin_id != premise.service_candidate.origin.component_id
                || unit_name != premise.service_candidate.unit_name
                || mode != premise.service_candidate.mode
                || candidate_digest != premise.service_candidate.candidate_digest.to_string()
                || premises_digest != premise.premises_digest.to_string()
                || premise_bytes != canonical_bytes(premise, "activation premise")?
            {
                return Err(HostAuthorityError::DigestMismatch(
                    "activation premise indexed projection".into(),
                ));
            }
            verify_origin_row(connection, &premise.service_candidate.origin)?;
            verify_candidate_row(connection, &premise.service_candidate)?;
            for definition in &premise.permission_policy_definitions {
                verify_definition_row(connection, definition)?;
            }
            for binding in &premise.permission_policy_backend_bindings {
                verify_binding_row(connection, binding)?;
            }
            let mut statement = connection.prepare(
                "SELECT policy_id, policy_revision, policy_definition_digest,
                        binding_id, binding_revision, binding_digest
                 FROM module_activation_premise_policy_selections
                 WHERE config_revision = ?1 ORDER BY policy_id, policy_revision",
            )?;
            let selections = statement
                .query_map([premise.config_revision], |row| {
                    let definition_digest: String = row.get(2)?;
                    let binding_digest: String = row.get(5)?;
                    Ok(PermissionPolicySelection {
                        policy_id: row.get(0)?,
                        policy_revision: row.get(1)?,
                        policy_definition_digest: definition_digest
                            .parse::<Sha256Digest>()
                            .map_err(|_| rusqlite::Error::InvalidQuery)?,
                        binding_id: row.get(3)?,
                        binding_revision: row.get(4)?,
                        binding_digest: binding_digest
                            .parse::<Sha256Digest>()
                            .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    })
                })?
                .collect::<Result<Vec<_>, rusqlite::Error>>()?;
            if selections
                != snapshot
                    .mapping
                    .canonical_config
                    .permission_policy_selections
            {
                return Err(HostAuthorityError::InvalidPremise(
                    "policy-selection projection differs from canonical config".into(),
                ));
            }
        }
        None => {
            let premise_count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM module_activation_premises WHERE config_revision = ?1",
                [snapshot.mapping.config_revision],
                |row| row.get(0),
            )?;
            let selection_count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM module_activation_premise_policy_selections WHERE config_revision = ?1",
                [snapshot.mapping.config_revision],
                |row| row.get(0),
            )?;
            if premise_count != 0 || selection_count != 0 {
                return Err(HostAuthorityError::InvalidPremise(
                    "configuration without a premise has retained prerequisite rows".into(),
                ));
            }
        }
    }
    Ok(())
}
fn verify_all_persisted_rows(
    connection: &Connection,
    authority_identity: &RuntimeAuthorityIdentity,
) -> Result<(), HostAuthorityError> {
    let mapping_identity_present =
        table_has_column(connection, "config_revision_mappings", "daemon_installation_id")?
            && table_has_column(connection, "config_revision_mappings", "instance_id")?;
    let mapping_rows: Vec<(Option<String>, Option<String>, i64, String, Vec<u8>)> = if mapping_identity_present {
        connection
            .prepare(
                "SELECT daemon_installation_id, instance_id, config_revision,
                        config_digest, canonical_bytes
                 FROM config_revision_mappings ORDER BY config_revision",
            )?
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?
    } else {
        connection
            .prepare(
                "SELECT NULL, NULL, config_revision,
                        config_digest, canonical_bytes
                 FROM config_revision_mappings ORDER BY config_revision",
            )?
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?
    };
    let mut expected_selections_by_revision: BTreeMap<i64, Vec<PermissionPolicySelection>> =
        BTreeMap::new();
    for (daemon_id, instance_id, revision, digest_text, bytes) in mapping_rows {
        if let (Some(daemon_id), Some(instance_id)) = (&daemon_id, &instance_id) {
            if *daemon_id != authority_identity.daemon_installation_id
                || *instance_id != authority_identity.instance_id
            {
                return Err(HostAuthorityError::RevisionConflict {
                    config_revision: revision,
                    reason: "historical mapping identity differs from authority identity".into(),
                });
            }
        }
        let digest = digest_text
            .parse::<Sha256Digest>()
            .map_err(|_| HostAuthorityError::Malformed("historical mapping digest".into()))?;
        let mapping = ConfigRevisionMapping {
            schema: "dolly.config-revision-mapping/v1".into(),
            daemon_installation_id: daemon_id
                .clone()
                .unwrap_or_else(|| authority_identity.daemon_installation_id.clone()),
            instance_id: instance_id
                .clone()
                .unwrap_or_else(|| authority_identity.instance_id.clone()),
            config_revision: revision,
            config_digest: digest,
            canonical_config: decode_record(&bytes, "historical resolved config")?,
        };
        validate_mapping(&mapping)?;
        if bytes != canonical_bytes(&mapping.canonical_config, "historical resolved config")? {
            return Err(HostAuthorityError::DigestMismatch(
                "historical mapping canonical bytes".into(),
            ));
        }
        expected_selections_by_revision.insert(
            revision,
            mapping
                .canonical_config
                .permission_policy_selections
                .clone(),
        );
    }

    let origin_bytes: Vec<Vec<u8>> = connection
        .prepare("SELECT record_jcs FROM installed_component_origins")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, rusqlite::Error>>()?;
    for bytes in origin_bytes {
        let origin: InstalledComponentOrigin =
            decode_record(&bytes, "historical installed origin")?;
        validate_origin(&origin)?;
        verify_origin_row(connection, &origin)?;
    }

    let definition_bytes: Vec<Vec<u8>> = connection
        .prepare("SELECT record_jcs FROM permission_policy_definitions")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, rusqlite::Error>>()?;
    for bytes in definition_bytes {
        let definition: PermissionPolicyDefinition =
            decode_record(&bytes, "historical permission policy definition")?;
        validate_definition(&definition)?;
        verify_definition_row(connection, &definition)?;
    }

    let binding_bytes: Vec<Vec<u8>> = connection
        .prepare("SELECT record_jcs FROM permission_policy_backend_bindings")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, rusqlite::Error>>()?;
    for bytes in binding_bytes {
        let binding: PermissionPolicyBackendBinding =
            decode_record(&bytes, "historical backend binding")?;
        validate_binding(&binding)?;
        verify_binding_row(connection, &binding)?;
    }

    let candidate_bytes: Vec<Vec<u8>> = connection
        .prepare("SELECT record_jcs FROM linux_service_candidates")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, rusqlite::Error>>()?;
    for bytes in candidate_bytes {
        let candidate: LinuxServiceCandidate =
            decode_record(&bytes, "historical Linux service candidate")?;
        validate_candidate(&candidate)?;
        verify_candidate_row(connection, &candidate)?;
    }
    let mut selection_rows_by_revision: BTreeMap<i64, Vec<PermissionPolicySelection>> =
        BTreeMap::new();
    let selection_rows: Vec<(i64, PermissionPolicySelection)> = connection
        .prepare(
            "SELECT config_revision, policy_id, policy_revision,
                    policy_definition_digest, binding_id, binding_revision, binding_digest
             FROM module_activation_premise_policy_selections
             ORDER BY config_revision, policy_id, policy_revision",
        )?
        .query_map([], |row| {
            let policy_definition_digest: String = row.get(3)?;
            let binding_digest: String = row.get(6)?;
            Ok((
                row.get(0)?,
                PermissionPolicySelection {
                    policy_id: row.get(1)?,
                    policy_revision: row.get(2)?,
                    policy_definition_digest: policy_definition_digest
                        .parse::<Sha256Digest>()
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    binding_id: row.get(4)?,
                    binding_revision: row.get(5)?,
                    binding_digest: binding_digest
                        .parse::<Sha256Digest>()
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                },
            ))
        })?
        .collect::<Result<Vec<_>, rusqlite::Error>>()?;
    for (revision, selection) in selection_rows {
        validate_selection(&selection)?;
        let Some(expected) = expected_selections_by_revision.get(&revision) else {
            return Err(HostAuthorityError::InvalidPremise(
                "policy selection references a missing mapping".into(),
            ));
        };
        if !expected.contains(&selection) {
            return Err(HostAuthorityError::DigestMismatch(
                "historical policy selection differs from canonical config".into(),
            ));
        }
        let premise_bytes: Option<Vec<u8>> = connection
            .query_row(
                "SELECT record_jcs FROM module_activation_premises WHERE config_revision = ?1",
                [revision],
                |row| row.get(0),
            )
            .optional()?;
        let Some(premise_bytes) = premise_bytes else {
            return Err(HostAuthorityError::InvalidPremise(
                "policy selection references a missing premise".into(),
            ));
        };
        let premise: ModuleActivationPremises =
            decode_record(&premise_bytes, "historical selection premise")?;
        validate_premise(&premise)?;
        let Some(definition) = premise.permission_policy_definitions.iter().find(|value| {
            value.policy_id == selection.policy_id
                && value.policy_revision == selection.policy_revision
        }) else {
            return Err(HostAuthorityError::InvalidPremise(
                "policy selection references a missing definition".into(),
            ));
        };
        if definition.definition_digest != selection.policy_definition_digest {
            return Err(HostAuthorityError::DigestMismatch(
                "policy selection definition digest".into(),
            ));
        }
        let Some(binding) = premise
            .permission_policy_backend_bindings
            .iter()
            .find(|value| {
                value.binding_id == selection.binding_id
                    && value.binding_revision == selection.binding_revision
            })
        else {
            return Err(HostAuthorityError::InvalidPremise(
                "policy selection references a missing binding".into(),
            ));
        };
        if binding.binding_digest != selection.binding_digest
            || binding.policy_id != selection.policy_id
            || binding.policy_revision != selection.policy_revision
            || binding.policy_definition_digest != selection.policy_definition_digest
        {
            return Err(HostAuthorityError::DigestMismatch(
                "policy selection binding projection".into(),
            ));
        }
        selection_rows_by_revision
            .entry(revision)
            .or_default()
            .push(selection);
    }

    let premise_rows: Vec<(i64, String, Vec<u8>)> = connection
        .prepare(
            "SELECT config_revision, config_digest, record_jcs
             FROM module_activation_premises ORDER BY config_revision",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<Vec<_>, rusqlite::Error>>()?;
    for (revision, digest_text, bytes) in premise_rows {
        let premise: ModuleActivationPremises =
            decode_record(&bytes, "historical activation premise")?;
        validate_premise(&premise)?;
        if premise.config_revision != revision
            || premise.config_digest.to_string() != digest_text
            || premise.daemon_installation_id != authority_identity.daemon_installation_id
            || premise.instance_id != authority_identity.instance_id
            || bytes != canonical_bytes(&premise, "historical activation premise")?
        {
            return Err(HostAuthorityError::DigestMismatch(
                "historical activation premise projection".into(),
            ));
        }
        let projection: (String, i64, String, String, String, String, String) = connection
            .query_row(
                "SELECT service_origin_component_id, service_origin_component_revision,
                        service_unit_name, service_mode, service_candidate_digest,
                        premises_digest, config_digest
                 FROM module_activation_premises WHERE config_revision = ?1",
                [revision],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )?;
        if projection.0 != premise.service_candidate.origin.component_id
            || projection.1 != premise.service_candidate.origin.component_revision
            || projection.2 != premise.service_candidate.unit_name
            || projection.3 != premise.service_candidate.mode
            || projection.4 != premise.service_candidate.candidate_digest.to_string()
            || projection.5 != premise.premises_digest.to_string()
            || projection.6 != premise.config_digest.to_string()
        {
            return Err(HostAuthorityError::DigestMismatch(
                "historical activation premise indexed projection".into(),
            ));
        }
        let Some(expected) = expected_selections_by_revision.get(&revision) else {
            return Err(HostAuthorityError::InvalidPremise(
                "historical premise references a missing mapping".into(),
            ));
        };
        let actual = selection_rows_by_revision
            .remove(&revision)
            .unwrap_or_default();
        if actual != *expected {
            return Err(HostAuthorityError::InvalidPremise(
                "historical policy-selection projection differs from canonical config".into(),
            ));
        }
    }
    if !selection_rows_by_revision.is_empty() {
        return Err(HostAuthorityError::InvalidPremise(
            "historical policy selection has no premise".into(),
        ));
    }
    Ok(())
}

fn verify_origin_row(
    connection: &Connection,
    origin: &InstalledComponentOrigin,
) -> Result<(), HostAuthorityError> {
    let row: Option<(String, Vec<u8>)> = connection
        .query_row(
            "SELECT component_digest, record_jcs FROM installed_component_origins
             WHERE component_id = ?1 AND component_revision = ?2",
            params![&origin.component_id, origin.component_revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((digest, bytes)) = row else {
        return Err(HostAuthorityError::InvalidPremise(
            "installed component origin row is missing".into(),
        ));
    };
    if digest != origin.component_digest.to_string()
        || bytes != canonical_bytes(origin, "installed component origin")?
    {
        return Err(HostAuthorityError::DigestMismatch(
            "installed component origin row".into(),
        ));
    }
    Ok(())
}

fn verify_definition_row(
    connection: &Connection,
    definition: &PermissionPolicyDefinition,
) -> Result<(), HostAuthorityError> {
    let row: Option<(String, Vec<u8>)> = connection
        .query_row(
            "SELECT definition_digest, record_jcs FROM permission_policy_definitions
             WHERE policy_id = ?1 AND policy_revision = ?2",
            params![&definition.policy_id, definition.policy_revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((digest, bytes)) = row else {
        return Err(HostAuthorityError::InvalidPremise(
            "permission policy definition row is missing".into(),
        ));
    };
    if digest != definition.definition_digest.to_string()
        || bytes != canonical_bytes(definition, "policy definition")?
    {
        return Err(HostAuthorityError::DigestMismatch(
            "permission policy definition row".into(),
        ));
    }
    Ok(())
}

fn verify_binding_row(
    connection: &Connection,
    binding: &PermissionPolicyBackendBinding,
) -> Result<(), HostAuthorityError> {
    let row: Option<BindingProjectionRow> = connection
        .query_row(
            "SELECT binding_digest, policy_id, policy_revision, policy_definition_digest,
                    origin_component_id, origin_component_revision, origin_component_digest,
                    record_jcs
             FROM permission_policy_backend_bindings
             WHERE binding_id = ?1 AND binding_revision = ?2",
            params![&binding.binding_id, binding.binding_revision],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .optional()?;
    let Some((
        digest,
        policy_id,
        policy_revision,
        policy_digest,
        origin_id,
        origin_revision,
        origin_digest,
        bytes,
    )) = row
    else {
        return Err(HostAuthorityError::InvalidPremise(
            "permission policy backend binding row is missing".into(),
        ));
    };
    if digest != binding.binding_digest.to_string()
        || policy_id != binding.policy_id
        || policy_revision != binding.policy_revision
        || policy_digest != binding.policy_definition_digest.to_string()
        || origin_id != binding.origin.component_id
        || origin_revision != binding.origin.component_revision
        || origin_digest != binding.origin.component_digest.to_string()
        || bytes != canonical_bytes(binding, "policy backend binding")?
    {
        return Err(HostAuthorityError::DigestMismatch(
            "permission policy backend binding row".into(),
        ));
    }
    Ok(())
}

fn verify_candidate_row(
    connection: &Connection,
    candidate: &LinuxServiceCandidate,
) -> Result<(), HostAuthorityError> {
    let row: Option<(String, String, String, String, Vec<u8>)> = connection
        .query_row(
            "SELECT origin_component_digest, unit_name, mode, candidate_digest, record_jcs
             FROM linux_service_candidates
             WHERE origin_component_id = ?1 AND origin_component_revision = ?2
               AND unit_name = ?3 AND mode = ?4",
            params![
                &candidate.origin.component_id,
                candidate.origin.component_revision,
                &candidate.unit_name,
                &candidate.mode
            ],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((origin_digest, unit_name, mode, candidate_digest, bytes)) = row else {
        return Err(HostAuthorityError::InvalidPremise(
            "Linux service candidate row is missing".into(),
        ));
    };
    if origin_digest != candidate.origin.component_digest.to_string()
        || unit_name != candidate.unit_name
        || mode != candidate.mode
        || candidate_digest != candidate.candidate_digest.to_string()
        || bytes != canonical_bytes(candidate, "service candidate")?
    {
        return Err(HostAuthorityError::DigestMismatch(
            "Linux service candidate row".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_revision(input: &HostAuthorityRevision) -> Result<(), HostAuthorityError> {
    validate_identity(&input.identity)?;
    validate_mapping(&input.mapping)?;
    if input.mapping.daemon_installation_id != input.identity.daemon_installation_id
        || input.mapping.instance_id != input.identity.instance_id
    {
        return Err(HostAuthorityError::InvalidPremise(
            "mapping identity differs from requested authority identity".into(),
        ));
    }
    match &input.premise {
        Some(premise) => {
            validate_premise(premise)?;
            if premise.daemon_installation_id != input.identity.daemon_installation_id
                || premise.instance_id != input.identity.instance_id
                || premise.config_revision != input.mapping.config_revision
                || premise.config_digest != input.mapping.config_digest
            {
                return Err(HostAuthorityError::InvalidPremise(
                    "premise is not bound to the exact mapping identity, revision, and digest"
                        .into(),
                ));
            }
            if input.mapping.canonical_config.service_candidate.as_ref()
                != Some(&premise.service_candidate)
            {
                return Err(HostAuthorityError::InvalidPremise(
                    "mapping and premise service candidates differ".into(),
                ));
            }
            let selections = &input.mapping.canonical_config.permission_policy_selections;
            if selections.len() != premise.permission_policy_definitions.len()
                || selections.len() != premise.permission_policy_backend_bindings.len()
            {
                return Err(HostAuthorityError::InvalidPremise(
                    "mapping policy selection cardinality differs from the premise".into(),
                ));
            }
            for selection in selections {
                let definition = premise
                    .permission_policy_definitions
                    .iter()
                    .find(|value| {
                        value.policy_id == selection.policy_id
                            && value.policy_revision == selection.policy_revision
                    })
                    .ok_or_else(|| {
                        HostAuthorityError::InvalidPremise(
                            "mapping selects a missing policy definition".into(),
                        )
                    })?;
                if definition.definition_digest != selection.policy_definition_digest {
                    return Err(HostAuthorityError::InvalidPremise(
                        "mapping selects a different policy definition digest".into(),
                    ));
                }
                let binding = premise
                    .permission_policy_backend_bindings
                    .iter()
                    .find(|value| {
                        value.binding_id == selection.binding_id
                            && value.binding_revision == selection.binding_revision
                    })
                    .ok_or_else(|| {
                        HostAuthorityError::InvalidPremise(
                            "mapping selects a missing backend binding".into(),
                        )
                    })?;
                if binding.binding_digest != selection.binding_digest
                    || binding.policy_id != selection.policy_id
                    || binding.policy_revision != selection.policy_revision
                    || binding.policy_definition_digest != selection.policy_definition_digest
                {
                    return Err(HostAuthorityError::InvalidPremise(
                        "mapping selection and backend binding differ".into(),
                    ));
                }
            }
        }
        None => {
            if input.mapping.canonical_config.service_candidate.is_some()
                || !input
                    .mapping
                    .canonical_config
                    .permission_policy_selections
                    .is_empty()
            {
                return Err(HostAuthorityError::InvalidPremise(
                    "a configuration with selected Host policy or service candidate requires a premise".into(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_loaded_snapshot(snapshot: &CurrentAuthoritySnapshot) -> Result<(), HostAuthorityError> {
    let identity = RuntimeAuthorityIdentity {
        daemon_installation_id: snapshot.mapping.daemon_installation_id.clone(),
        instance_id: snapshot.mapping.instance_id.clone(),
    };
    let candidate = HostAuthorityRevision {
        identity,
        mapping: snapshot.mapping.clone(),
        premise: snapshot.premise.clone(),
    };
    validate_revision(&candidate)
}

fn validate_identity(identity: &RuntimeAuthorityIdentity) -> Result<(), HostAuthorityError> {
    if !valid_uuid_v7(&identity.daemon_installation_id) {
        return Err(HostAuthorityError::Malformed(
            "daemon_installation_id".into(),
        ));
    }
    if !valid_stable_id(&identity.instance_id) {
        return Err(HostAuthorityError::Malformed("instance_id".into()));
    }
    Ok(())
}

fn validate_mapping(mapping: &ConfigRevisionMapping) -> Result<(), HostAuthorityError> {
    if mapping.canonical_config.permission_policy_selections.len() > 1024 {
        return Err(HostAuthorityError::Malformed(
            "config policy selections exceed 1024 entries".into(),
        ));
    }
    if mapping.schema != "dolly.config-revision-mapping/v1" {
        return Err(HostAuthorityError::Malformed(
            "config mapping schema".into(),
        ));
    }
    if !valid_uuid_v7(&mapping.daemon_installation_id) || !valid_stable_id(&mapping.instance_id) {
        return Err(HostAuthorityError::Malformed(
            "config mapping identity".into(),
        ));
    }
    validate_revision_number(mapping.config_revision, "config revision")?;
    if !matches!(
        mapping.canonical_config.runtime_config,
        CanonicalJsonValue::Object(_)
    ) {
        return Err(HostAuthorityError::Malformed(
            "runtime_config must be an object".into(),
        ));
    }
    let canonical_digest = canonicalize(&mapping.canonical_config)
        .map_err(|error| HostAuthorityError::Canonical(error.to_string()))?
        .1;
    if canonical_digest != mapping.config_digest {
        return Err(HostAuthorityError::DigestMismatch("config_digest".into()));
    }
    for selection in &mapping.canonical_config.permission_policy_selections {
        validate_selection(selection)?;
    }
    ensure_sorted_unique_selections(&mapping.canonical_config.permission_policy_selections)?;
    if let Some(candidate) = &mapping.canonical_config.service_candidate {
        validate_candidate(candidate)?;
    }
    Ok(())
}

fn validate_premise(premise: &ModuleActivationPremises) -> Result<(), HostAuthorityError> {
    if premise.permission_policy_definitions.len() > 1024
        || premise.permission_policy_backend_bindings.len() > 1024
    {
        return Err(HostAuthorityError::Malformed(
            "activation premise policy arrays exceed 1024 entries".into(),
        ));
    }
    if premise.schema != "dolly.module-activation-premises/v1" {
        return Err(HostAuthorityError::Malformed(
            "activation premise schema".into(),
        ));
    }
    if !valid_uuid_v7(&premise.daemon_installation_id) || !valid_stable_id(&premise.instance_id) {
        return Err(HostAuthorityError::Malformed(
            "activation premise identity".into(),
        ));
    }
    validate_revision_number(premise.config_revision, "premise revision")?;
    for definition in &premise.permission_policy_definitions {
        validate_definition(definition)?;
    }
    for binding in &premise.permission_policy_backend_bindings {
        validate_binding(binding)?;
    }
    ensure_sorted_unique_definitions(&premise.permission_policy_definitions)?;
    ensure_sorted_unique_bindings(&premise.permission_policy_backend_bindings)?;
    validate_candidate(&premise.service_candidate)?;
    let computed = digest_without(premise, "premises_digest")?;
    if computed != premise.premises_digest {
        return Err(HostAuthorityError::DigestMismatch("premises_digest".into()));
    }
    for binding in &premise.permission_policy_backend_bindings {
        let definition = premise
            .permission_policy_definitions
            .iter()
            .find(|value| {
                value.policy_id == binding.policy_id
                    && value.policy_revision == binding.policy_revision
            })
            .ok_or_else(|| {
                HostAuthorityError::InvalidPremise("binding references a missing definition".into())
            })?;
        if definition.definition_digest != binding.policy_definition_digest {
            return Err(HostAuthorityError::InvalidPremise(
                "binding definition digest differs".into(),
            ));
        }
    }
    Ok(())
}

fn validate_definition(definition: &PermissionPolicyDefinition) -> Result<(), HostAuthorityError> {
    if definition.schema != "dolly.permission-policy-definition/v1"
        || !valid_stable_id(&definition.policy_id)
    {
        return Err(HostAuthorityError::Malformed(
            "permission policy definition identity".into(),
        ));
    }
    validate_revision_number(definition.policy_revision, "policy revision")?;
    if !valid_uri_reference(&definition.definition_schema_uri) {
        return Err(HostAuthorityError::Malformed(
            "definition_schema_uri".into(),
        ));
    }
    if !matches!(definition.definition, CanonicalJsonValue::Object(_)) {
        return Err(HostAuthorityError::Malformed(
            "policy definition must be an object".into(),
        ));
    }
    if let CanonicalJsonValue::Object(object) = &definition.definition {
        if object.len() > 256 {
            return Err(HostAuthorityError::Malformed(
                "policy definition has too many members".into(),
            ));
        }
    }
    validate_policy_origin(&definition.origin)?;
    let computed = digest_without(definition, "definition_digest")?;
    if computed != definition.definition_digest {
        return Err(HostAuthorityError::DigestMismatch(
            "definition_digest".into(),
        ));
    }
    Ok(())
}

fn validate_policy_origin(origin: &PolicyDefinitionOrigin) -> Result<(), HostAuthorityError> {
    if origin.schema != "dolly.policy-definition-origin/v1"
        || origin.kind != "operator_approved_policy"
        || !valid_qualified_name(&origin.source_id)
    {
        return Err(HostAuthorityError::Malformed(
            "policy definition origin".into(),
        ));
    }
    validate_revision_number(origin.source_revision, "policy origin revision")
}

fn validate_binding(binding: &PermissionPolicyBackendBinding) -> Result<(), HostAuthorityError> {
    if binding.schema != "dolly.permission-policy-backend-binding/v1"
        || !valid_stable_id(&binding.binding_id)
        || !valid_stable_id(&binding.policy_id)
    {
        return Err(HostAuthorityError::Malformed(
            "backend binding identity".into(),
        ));
    }
    validate_revision_number(binding.binding_revision, "binding revision")?;
    validate_revision_number(binding.policy_revision, "binding policy revision")?;
    validate_origin(&binding.origin)?;
    let computed = digest_without(binding, "binding_digest")?;
    if computed != binding.binding_digest {
        return Err(HostAuthorityError::DigestMismatch("binding_digest".into()));
    }
    Ok(())
}

fn validate_origin(origin: &InstalledComponentOrigin) -> Result<(), HostAuthorityError> {
    if origin.schema != "dolly.installed-component-origin/v1"
        || origin.kind != "installed_product_component"
        || !valid_qualified_name(&origin.component_id)
    {
        return Err(HostAuthorityError::Malformed(
            "installed component origin".into(),
        ));
    }
    validate_revision_number(origin.component_revision, "component revision")
}

fn validate_candidate(candidate: &LinuxServiceCandidate) -> Result<(), HostAuthorityError> {
    if candidate.schema != "dolly.linux-service-candidate/v1"
        || candidate.mode != "user"
        || candidate.unit_name.len() < 9
        || candidate.unit_name.len() > 255
        || !valid_unit_name(&candidate.unit_name)
    {
        return Err(HostAuthorityError::Malformed(
            "Linux service candidate".into(),
        ));
    }
    validate_origin(&candidate.origin)?;
    let computed = digest_without(candidate, "candidate_digest")?;
    if computed != candidate.candidate_digest {
        return Err(HostAuthorityError::DigestMismatch(
            "candidate_digest".into(),
        ));
    }
    Ok(())
}

fn validate_selection(selection: &PermissionPolicySelection) -> Result<(), HostAuthorityError> {
    if !valid_stable_id(&selection.policy_id) || !valid_stable_id(&selection.binding_id) {
        return Err(HostAuthorityError::Malformed(
            "policy selection identity".into(),
        ));
    }
    validate_revision_number(selection.policy_revision, "selection policy revision")?;
    validate_revision_number(selection.binding_revision, "selection binding revision")
}

fn ensure_sorted_unique_selections(
    values: &[PermissionPolicySelection],
) -> Result<(), HostAuthorityError> {
    let mut previous: Option<(&str, i64)> = None;
    let mut seen = BTreeSet::new();
    for value in values {
        let key = (value.policy_id.as_str(), value.policy_revision);
        if previous.is_some_and(|prior| prior.cmp(&key) != Ordering::Less) || !seen.insert(key) {
            return Err(HostAuthorityError::InvalidPremise(
                "policy selections are not sorted and unique".into(),
            ));
        }
        previous = Some(key);
    }
    Ok(())
}

fn ensure_sorted_unique_definitions(
    values: &[PermissionPolicyDefinition],
) -> Result<(), HostAuthorityError> {
    let mut previous: Option<(&str, i64)> = None;
    let mut seen = BTreeSet::new();
    for value in values {
        let key = (value.policy_id.as_str(), value.policy_revision);
        if previous.is_some_and(|prior| prior.cmp(&key) != Ordering::Less) || !seen.insert(key) {
            return Err(HostAuthorityError::InvalidPremise(
                "policy definitions are not sorted and unique".into(),
            ));
        }
        previous = Some(key);
    }
    Ok(())
}

fn ensure_sorted_unique_bindings(
    values: &[PermissionPolicyBackendBinding],
) -> Result<(), HostAuthorityError> {
    let mut previous: Option<(&str, i64)> = None;
    let mut seen = BTreeSet::new();
    for value in values {
        let key = (value.policy_id.as_str(), value.policy_revision);
        if previous.is_some_and(|prior| prior.cmp(&key) != Ordering::Less) || !seen.insert(key) {
            return Err(HostAuthorityError::InvalidPremise(
                "policy backend bindings are not sorted and unique".into(),
            ));
        }
        previous = Some(key);
    }
    Ok(())
}

fn validate_revision_number(value: i64, label: &str) -> Result<(), HostAuthorityError> {
    if !(1..=MAX_AUTHORITY_REVISION).contains(&value) {
        return Err(HostAuthorityError::Malformed(label.into()));
    }
    Ok(())
}

fn valid_uri_reference(value: &str) -> bool {
    if value.is_empty() || value.len() > 512 {
        return false;
    }
    let bytes = value.as_bytes();
    let allowed = |byte: u8| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'.'
                    | b'_'
                    | b'~'
                    | b':'
                    | b'/'
                    | b'?'
                    | b'#'
                    | b'['
                    | b']'
                    | b'@'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
                    | b'%'
            )
    };
    let mut index = 0;
    while index < bytes.len() {
        if !allowed(bytes[index]) {
            return false;
        }
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    true
}

fn valid_stable_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 63 {
        return false;
    }
    let mut pieces = value.split('-');
    let Some(first) = pieces.next() else {
        return false;
    };
    !first.is_empty()
        && first.as_bytes()[0].is_ascii_lowercase()
        && first
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && pieces.all(|piece| {
            !piece.is_empty()
                && piece
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn valid_qualified_name(value: &str) -> bool {
    let mut pieces = value.split('.');
    let count = pieces.clone().count();
    count >= 2 && value.len() >= 3 && value.len() <= 255 && pieces.all(valid_stable_id)
}

fn valid_uuid_v7(value: &str) -> bool {
    is_uuid_v7(value)
}

fn valid_unit_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() >= 9
        && value.len() <= 255
        && !bytes.is_empty()
        && bytes[0].is_ascii_alphanumeric()
        && value.ends_with(".service")
        && bytes.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'.' | b'@' | b'-')
        })
}

fn canonical_bytes<T: Serialize>(value: &T, label: &str) -> Result<Vec<u8>, HostAuthorityError> {
    canonicalize(value)
        .map(|(bytes, _)| bytes.as_ref().to_vec())
        .map_err(|error| HostAuthorityError::Canonical(format!("{label}: {error}")))
}

fn digest_without<T: Serialize>(
    value: &T,
    field: &str,
) -> Result<Sha256Digest, HostAuthorityError> {
    let mut json = serde_json::to_value(value)
        .map_err(|error| HostAuthorityError::Canonical(error.to_string()))?;
    let object = json.as_object_mut().ok_or_else(|| {
        HostAuthorityError::Canonical("authority record must be an object".into())
    })?;
    object.remove(field);
    canonicalize(&json)
        .map(|(_, digest)| digest)
        .map_err(|error| HostAuthorityError::Canonical(error.to_string()))
}

fn decode_record<T: serde::de::DeserializeOwned>(
    bytes: &[u8],
    label: &str,
) -> Result<T, HostAuthorityError> {
    let limits = ParseLimits::semantic(MAX_SEMANTIC_JSON_NESTING_DEPTH)
        .map_err(|error| HostAuthorityError::Canonical(error.to_string()))?;
    deserialize_core_json(bytes, limits)
        .map_err(|error| HostAuthorityError::Malformed(format!("{label}: {error}")))
}
fn load_state_row(
    tx: &Transaction<'_>,
) -> Result<Option<(RuntimeAuthorityIdentity, i64, Sha256Digest)>, HostAuthorityError> {
    tx.query_row(
        "SELECT daemon_installation_id, instance_id, current_config_revision,
                current_config_digest
         FROM runtime_authority_state WHERE singleton = 1",
        [],
        |row| {
            let digest: String = row.get(3)?;
            let digest = digest
                .parse::<Sha256Digest>()
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            Ok((
                RuntimeAuthorityIdentity {
                    daemon_installation_id: row.get(0)?,
                    instance_id: row.get(1)?,
                },
                row.get(2)?,
                digest,
            ))
        },
    )
    .optional()
    .map_err(HostAuthorityError::from)
}

fn insert_mapping(
    tx: &Transaction<'_>,
    mapping: &ConfigRevisionMapping,
    bytes: &[u8],
) -> Result<(), HostAuthorityError> {
    let existing: Option<(String, String, String, Vec<u8>)> = tx
        .query_row(
            "SELECT daemon_installation_id, instance_id, config_digest, canonical_bytes
             FROM config_revision_mappings WHERE config_revision = ?1",
            [mapping.config_revision],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((daemon_installation_id, instance_id, digest, existing_bytes)) = existing {
        if daemon_installation_id == mapping.daemon_installation_id
            && instance_id == mapping.instance_id
            && digest == mapping.config_digest.to_string()
            && existing_bytes == bytes
        {
            return Ok(());
        }
        return Err(HostAuthorityError::RevisionConflict {
            config_revision: mapping.config_revision,
            reason: "config mapping identity is already bound to different bytes".into(),
        });
    }
    tx.execute(
        "INSERT INTO config_revision_mappings (
            config_revision, daemon_installation_id, instance_id,
            config_digest, canonical_bytes
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            mapping.config_revision,
            &mapping.daemon_installation_id,
            &mapping.instance_id,
            mapping.config_digest.to_string(),
            bytes,
        ],
    )?;
    Ok(())
}

fn insert_origin(
    tx: &Transaction<'_>,
    origin: &InstalledComponentOrigin,
) -> Result<(), HostAuthorityError> {
    let bytes = canonical_bytes(origin, "installed component origin")?;
    let existing: Option<(String, Vec<u8>)> = tx
        .query_row(
            "SELECT component_digest, record_jcs FROM installed_component_origins
             WHERE component_id = ?1 AND component_revision = ?2",
            params![&origin.component_id, origin.component_revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((digest, existing_bytes)) = existing {
        if digest == origin.component_digest.to_string() && existing_bytes == bytes {
            return Ok(());
        }
        return Err(HostAuthorityError::RevisionConflict {
            config_revision: origin.component_revision,
            reason: "installed component origin differs at the same identity".into(),
        });
    }
    tx.execute(
        "INSERT INTO installed_component_origins (
            component_id, component_revision, component_digest, record_jcs
         ) VALUES (?1, ?2, ?3, ?4)",
        params![
            &origin.component_id,
            origin.component_revision,
            origin.component_digest.to_string(),
            bytes
        ],
    )?;
    Ok(())
}

fn insert_definition(
    tx: &Transaction<'_>,
    definition: &PermissionPolicyDefinition,
    bytes: &[u8],
) -> Result<(), HostAuthorityError> {
    let existing: Option<(String, Vec<u8>)> = tx
        .query_row(
            "SELECT definition_digest, record_jcs FROM permission_policy_definitions
             WHERE policy_id = ?1 AND policy_revision = ?2",
            params![&definition.policy_id, definition.policy_revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((digest, existing_bytes)) = existing {
        if digest == definition.definition_digest.to_string() && existing_bytes == bytes {
            return Ok(());
        }
        return Err(HostAuthorityError::RevisionConflict {
            config_revision: definition.policy_revision,
            reason: "permission policy definition differs at the same identity".into(),
        });
    }
    tx.execute(
        "INSERT INTO permission_policy_definitions (
            policy_id, policy_revision, definition_digest, record_jcs
         ) VALUES (?1, ?2, ?3, ?4)",
        params![
            &definition.policy_id,
            definition.policy_revision,
            definition.definition_digest.to_string(),
            bytes
        ],
    )?;
    Ok(())
}

fn insert_binding(
    tx: &Transaction<'_>,
    binding: &PermissionPolicyBackendBinding,
    bytes: &[u8],
) -> Result<(), HostAuthorityError> {
    let existing: Option<(String, Vec<u8>)> = tx
        .query_row(
            "SELECT binding_digest, record_jcs FROM permission_policy_backend_bindings
             WHERE binding_id = ?1 AND binding_revision = ?2",
            params![&binding.binding_id, binding.binding_revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((digest, existing_bytes)) = existing {
        if digest == binding.binding_digest.to_string() && existing_bytes == bytes {
            return Ok(());
        }
        return Err(HostAuthorityError::RevisionConflict {
            config_revision: binding.binding_revision,
            reason: "permission policy backend binding differs at the same identity".into(),
        });
    }
    tx.execute(
        "INSERT INTO permission_policy_backend_bindings (
            binding_id, binding_revision, binding_digest,
            policy_id, policy_revision, policy_definition_digest,
            origin_component_id, origin_component_revision, origin_component_digest,
            record_jcs
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            &binding.binding_id,
            binding.binding_revision,
            binding.binding_digest.to_string(),
            &binding.policy_id,
            binding.policy_revision,
            binding.policy_definition_digest.to_string(),
            &binding.origin.component_id,
            binding.origin.component_revision,
            binding.origin.component_digest.to_string(),
            bytes,
        ],
    )?;
    Ok(())
}

fn insert_candidate(
    tx: &Transaction<'_>,
    candidate: &LinuxServiceCandidate,
    bytes: &[u8],
) -> Result<(), HostAuthorityError> {
    let existing: Option<(String, Vec<u8>)> = tx
        .query_row(
            "SELECT candidate_digest, record_jcs FROM linux_service_candidates
             WHERE origin_component_id = ?1 AND origin_component_revision = ?2
               AND unit_name = ?3 AND mode = ?4",
            params![
                &candidate.origin.component_id,
                candidate.origin.component_revision,
                &candidate.unit_name,
                &candidate.mode
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((digest, existing_bytes)) = existing {
        if digest == candidate.candidate_digest.to_string() && existing_bytes == bytes {
            return Ok(());
        }
        return Err(HostAuthorityError::RevisionConflict {
            config_revision: candidate.origin.component_revision,
            reason: "Linux service candidate differs at the same identity".into(),
        });
    }
    tx.execute(
        "INSERT INTO linux_service_candidates (
            origin_component_id, origin_component_revision, origin_component_digest,
            unit_name, mode, candidate_digest, record_jcs
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            &candidate.origin.component_id,
            candidate.origin.component_revision,
            candidate.origin.component_digest.to_string(),
            &candidate.unit_name,
            &candidate.mode,
            candidate.candidate_digest.to_string(),
            bytes,
        ],
    )?;
    Ok(())
}

fn insert_premise(
    tx: &Transaction<'_>,
    premise: &ModuleActivationPremises,
) -> Result<(), HostAuthorityError> {
    let bytes = canonical_bytes(premise, "activation premise")?;
    let existing: Option<(String, Vec<u8>)> = tx
        .query_row(
            "SELECT premises_digest, record_jcs FROM module_activation_premises WHERE config_revision = ?1",
            [premise.config_revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((digest, existing_bytes)) = existing {
        if digest == premise.premises_digest.to_string() && existing_bytes == bytes {
            return Ok(());
        }
        return Err(HostAuthorityError::RevisionConflict {
            config_revision: premise.config_revision,
            reason: "activation premise differs at the same config revision".into(),
        });
    }
    tx.execute(
        "INSERT INTO module_activation_premises (
            config_revision, config_digest,
            service_origin_component_id, service_origin_component_revision,
            service_unit_name, service_mode, service_candidate_digest,
            premises_digest, record_jcs
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            premise.config_revision,
            premise.config_digest.to_string(),
            &premise.service_candidate.origin.component_id,
            premise.service_candidate.origin.component_revision,
            &premise.service_candidate.unit_name,
            &premise.service_candidate.mode,
            premise.service_candidate.candidate_digest.to_string(),
            premise.premises_digest.to_string(),
            bytes,
        ],
    )?;
    Ok(())
}

fn insert_selection(
    tx: &Transaction<'_>,
    config_revision: i64,
    selection: &PermissionPolicySelection,
) -> Result<(), HostAuthorityError> {
    tx.execute(
        "INSERT INTO module_activation_premise_policy_selections (
            config_revision, policy_id, policy_revision, policy_definition_digest,
            binding_id, binding_revision, binding_digest
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            config_revision,
            &selection.policy_id,
            selection.policy_revision,
            selection.policy_definition_digest.to_string(),
            &selection.binding_id,
            selection.binding_revision,
            selection.binding_digest.to_string(),
        ],
    )?;
    Ok(())
}

impl fmt::Display for CurrentAuthoritySnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "authority revision {}",
            self.mapping.config_revision
        )
    }
}
