//! Durable Worker-start premise projection over the committed Host authority.
//!
//! The public Worker-host binary receives only a database location plus the
//! `extension_alias`/`server_id` identity pair. Everything else it needs to
//! spawn an installed stdio tool server — the installed package root and
//! package path, their exact digests, the relative executable endpoint, and
//! the config revision this projection belongs to — is loaded from this
//! closed, versioned projection in the shared Runtime SQLite database.
//!
//! The projection is produced exclusively by the Host-owned TS authority
//! writer inside the controller-locked transaction discipline. This module is
//! the consumer side: it never repairs, never guesses, and refuses closed
//! when the row for the current authority revision is absent, stale, or
//! tampered. Readiness, responses, ACKs, caches, and process exits have no
//! API here and cannot mint a premise.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use dolly_canonical_json::{Sha256Digest, canonicalize};

use crate::error::{StorageError, StorageResult};
use crate::host_authority::{
    RuntimeAuthorityIdentity, HOST_AUTHORITY_SCHEMA_SQL, verify_authority_schema,
};

/// Physical schema version of the Worker-start premise slice.
pub const WORKER_START_PREMISE_SCHEMA_VERSION: i64 = 1;
/// Closed logical record schema for one Worker-start premise row.
pub const WORKER_START_PREMISE_RECORD_SCHEMA: &str = "dolly.worker-start-premise/v1";
/// The single projected table.
pub const WORKER_START_PREMISE_TABLE: &str = "worker_start_premises";

/// Closed physical schema for the Worker-start premise projection.
///
/// Every row is pinned to one `(config_revision, config_digest)` mapping
/// through the Host authority foreign key, so installing a new authority
/// revision never silently re-points an existing projection. The CHECK
/// constraints encode the cheap invariants; the complete record digest and
/// identity agreement are verified on every load.
pub const WORKER_START_PREMISE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS worker_start_premises (
    config_revision     INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND 9007199254740991),
    config_digest       TEXT    NOT NULL,
    extension_alias     TEXT    NOT NULL CHECK (length(extension_alias) > 0),
    server_id           TEXT    NOT NULL CHECK (length(server_id) > 0),
    package_root        TEXT    NOT NULL CHECK (length(package_root) > 0),
    package_path        TEXT    NOT NULL CHECK (length(package_path) > 0),
    package_digest      TEXT    NOT NULL CHECK (package_digest LIKE 'sha256:%'),
    executable_digest   TEXT    NOT NULL CHECK (executable_digest LIKE 'sha256:%'),
    endpoint            TEXT    NOT NULL CHECK (length(endpoint) > 0),
    record_jcs          BLOB    NOT NULL,
    record_digest       TEXT    NOT NULL,
    UNIQUE (config_revision, config_digest),
    FOREIGN KEY (config_revision, config_digest)
      REFERENCES config_revision_mappings(config_revision, config_digest),
    CHECK (substr(package_path, 1, length(package_root) + 1) = package_root || '/')
);
"#;

/// One verified durable Worker-start premise.
///
/// All fields mirror the stored record exactly; `record_digest` is the
/// SHA-256 of the canonical JSON encoding of every other field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerStartPremise {
    pub schema: String,
    pub daemon_installation_id: String,
    pub instance_id: String,
    pub config_revision: i64,
    pub config_digest: String,
    pub extension_alias: String,
    pub server_id: String,
    pub package_root: String,
    pub package_path: String,
    pub package_digest: String,
    pub executable_digest: String,
    pub endpoint: String,
    pub record_digest: String,
}

impl WorkerStartPremise {
    /// The unsigned record whose canonical digest seals the premise.
    fn unsigned(&self) -> WorkerStartPremiseUnsigned<'_> {
        WorkerStartPremiseUnsigned {
            schema: &self.schema,
            daemon_installation_id: &self.daemon_installation_id,
            instance_id: &self.instance_id,
            config_revision: self.config_revision,
            config_digest: &self.config_digest,
            extension_alias: &self.extension_alias,
            server_id: &self.server_id,
            package_root: &self.package_root,
            package_path: &self.package_path,
            package_digest: &self.package_digest,
            executable_digest: &self.executable_digest,
            endpoint: &self.endpoint,
        }
    }

    /// Recompute and verify the sealing record digest.
    pub fn verify_record_digest(&self) -> Result<(), WorkerStartPremiseError> {
        let digest = self
            .unsigned()
            .record_digest()
            .map_err(|error| WorkerStartPremiseError(format!("canonical digest failed: {error}")))?;
        if digest.to_canonical_string() != self.record_digest {
            return Err(WorkerStartPremiseError(
                "record_digest does not match the canonical premise record".into(),
            ));
        }
        Ok(())
    }

    /// Verify every closed field-level invariant independent of SQLite.
    pub fn verify_content(&self) -> Result<(), WorkerStartPremiseError> {
        if self.schema != WORKER_START_PREMISE_RECORD_SCHEMA {
            return Err(WorkerStartPremiseError(format!(
                "premise schema must be {WORKER_START_PREMISE_RECORD_SCHEMA}"
            )));
        }
        if !(1..=9_007_199_254_740_991_i64).contains(&self.config_revision) {
            return Err(WorkerStartPremiseError(
                "config_revision out of the safe-integer range".into(),
            ));
        }
        for label in ["config_digest", "package_digest", "executable_digest", "record_digest"] {
            let value = match label {
                "config_digest" => &self.config_digest,
                "package_digest" => &self.package_digest,
                "executable_digest" => &self.executable_digest,
                _ => &self.record_digest,
            };
            if !is_sha256_digest(value) {
                return Err(WorkerStartPremiseError(format!("{label} is not a sha256 digest")));
            }
        }
        if self.extension_alias.is_empty()
            || !self.extension_alias.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
        {
            return Err(WorkerStartPremiseError(
                "extension_alias is not a qualified lowercase identifier".into(),
            ));
        }
        if self.server_id.is_empty() {
            return Err(WorkerStartPremiseError("server_id is empty".into()));
        }
        if !is_safe_relative_member(&self.endpoint) {
            return Err(WorkerStartPremiseError(
                "endpoint escapes the installed package root".into(),
            ));
        }
        let root = Path::new(&self.package_root);
        let package = Path::new(&self.package_path);
        if !root.is_absolute() || !package.is_absolute() {
            return Err(WorkerStartPremiseError(
                "package locations must be absolute".into(),
            ));
        }
        if !package.starts_with(root) || package == root {
            return Err(WorkerStartPremiseError(
                "installed package path must sit inside the package root".into(),
            ));
        }
        self.verify_record_digest()
    }

    /// The database-relative inputs a `WorkerStartConfig` needs.
    pub fn package_root_path(&self) -> PathBuf {
        PathBuf::from(&self.package_root)
    }

    pub fn package_path(&self) -> PathBuf {
        PathBuf::from(&self.package_path)
    }
}

#[derive(Serialize)]
struct WorkerStartPremiseUnsigned<'a> {
    schema: &'a str,
    daemon_installation_id: &'a str,
    instance_id: &'a str,
    config_revision: i64,
    config_digest: &'a str,
    extension_alias: &'a str,
    server_id: &'a str,
    package_root: &'a str,
    package_path: &'a str,
    package_digest: &'a str,
    executable_digest: &'a str,
    endpoint: &'a str,
}

impl WorkerStartPremiseUnsigned<'_> {
    fn record_digest(&self) -> Result<Sha256Digest, WorkerStartPremiseError> {
        let value = serde_json::to_value(self)
            .map_err(|error| WorkerStartPremiseError(format!("serialization failed: {error}")))?;
        Ok(canonicalize(&value)
            .map_err(|error| WorkerStartPremiseError(format!("canonicalization failed: {error}")))?
            .1)
    }
}

/// True when the string is exactly `sha256:` plus 64 lowercase hex digits.
pub(crate) fn is_sha256_digest(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 71
        && bytes[..7] == *b"sha256:"
        && bytes[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

/// True when `value` is a safe relative member: non-empty, no `..`, no
/// absolute or drive components, and no separators beyond `/`.
pub(crate) fn is_safe_relative_member(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\\')
        && value.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Build the canonical JCS bytes and sealing digest for a premise record.
pub fn seal_premise_record(
    unsigned: WorkerStartPremiseInput,
) -> Result<(Vec<u8>, String), WorkerStartPremiseError> {
    let premise = WorkerStartPremise {
        schema: WORKER_START_PREMISE_RECORD_SCHEMA.to_string(),
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
        record_digest: String::new(),
    };
    let digest = premise
        .unsigned()
        .record_digest()
        .map_err(|error| WorkerStartPremiseError(format!("canonical digest failed: {error}")))?;
    let mut sealed = premise;
    sealed.record_digest = digest.to_canonical_string();
    let bytes = canonicalize(&serde_json::to_value(&sealed).map_err(|error| {
        WorkerStartPremiseError(format!("serialization failed: {error}"))
    })?)
    .map_err(|error| WorkerStartPremiseError(format!("canonicalization failed: {error}")))?
    .0;
    Ok((bytes.into_vec(), sealed.record_digest))
}

/// Unsigned premise content supplied by the Host-owned producer.
#[derive(Clone)]
pub struct WorkerStartPremiseInput {
    pub daemon_installation_id: String,
    pub instance_id: String,
    pub config_revision: i64,
    pub config_digest: String,
    pub extension_alias: String,
    pub server_id: String,
    pub package_root: String,
    pub package_path: String,
    pub package_digest: String,
    pub executable_digest: String,
    pub endpoint: String,
}

/// Insert one sealed premise row inside the caller's open transaction.
///
/// The row is keyed by `(config_revision, config_digest)`; rewriting the
/// identical projection is a no-op, any other rewrite refuses closed. The
/// Host authority foreign key must hold inside this transaction.
pub fn insert_worker_start_premise_in_transaction(
    tx: &Transaction<'_>,
    input: WorkerStartPremiseInput,
) -> Result<bool, WorkerStartPremiseError> {
    let (bytes, record_digest) = seal_premise_record(input.clone())?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT record_digest FROM worker_start_premises WHERE config_revision = ?1",
            [input.config_revision],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| WorkerStartPremiseError(format!("premise lookup failed: {error}")))?;
    if let Some(existing_digest) = existing {
        if existing_digest == record_digest {
            return Ok(false);
        }
        return Err(WorkerStartPremiseError(
            "a different Worker-start premise is already projected for this config revision".into(),
        ));
    }
    tx.execute(
        "INSERT INTO worker_start_premises (
            config_revision, config_digest, extension_alias, server_id,
            package_root, package_path, package_digest, executable_digest,
            endpoint, record_jcs, record_digest
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            input.config_revision,
            input.config_digest,
            input.extension_alias,
            input.server_id,
            input.package_root,
            input.package_path,
            input.package_digest,
            input.executable_digest,
            input.endpoint,
            bytes,
            record_digest,
        ],
    )
    .map_err(|error| WorkerStartPremiseError(format!("premise insert failed: {error}")))?;
    Ok(true)
}

/// Load and completely verify the premise projected for the current authority
/// revision, filtered to the requested identity pair.
///
/// Refuses closed when the current pointer, the projection, or any field
/// disagrees; absence is a distinct typed outcome the caller must treat as a
/// startup refusal.
pub fn load_worker_start_premise(
    connection: &Connection,
    identity: &RuntimeAuthorityIdentity,
    extension_alias: &str,
    server_id: &str,
) -> Result<Option<WorkerStartPremise>, WorkerStartPremiseError> {
    let state = connection
        .query_row(
            "SELECT daemon_installation_id, instance_id, current_config_revision, current_config_digest
             FROM runtime_authority_state WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| WorkerStartPremiseError(format!("authority state unavailable: {error}")))?;
    let Some((daemon, instance, revision, digest)) = state else {
        return Ok(None);
    };
    let row = connection
        .query_row(
            "SELECT config_digest, extension_alias, server_id, package_root, package_path,
                    package_digest, executable_digest, endpoint, record_jcs, record_digest
             FROM worker_start_premises WHERE config_revision = ?1",
            [revision],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Vec<u8>>(8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .optional()
        .map_err(|error| WorkerStartPremiseError(format!("premise lookup failed: {error}")))?;
    let Some((
        stored_config_digest,
        stored_alias,
        stored_server,
        package_root,
        package_path,
        package_digest,
        executable_digest,
        endpoint,
        record_bytes,
        record_digest,
    )) = row
    else {
        // A projection that exists only for older revisions is stale, not
        // absent: the Host authority moved without producing a new premise.
        let any_row: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM worker_start_premises",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| WorkerStartPremiseError(format!("premise lookup failed: {error}")))?;
        if any_row > 0 {
            return Err(WorkerStartPremiseError(
                "Worker-start premise is projected for a different authority revision".into(),
            ));
        }
        return Ok(None);
    };
    if daemon != identity.daemon_installation_id || instance != identity.instance_id {
        return Err(WorkerStartPremiseError(
            "authority-state identity disagrees with the opened database tuple".into(),
        ));
    }
    if stored_config_digest != digest {
        return Err(WorkerStartPremiseError(
            "projected premise belongs to a different authority revision".into(),
        ));
    }
    if stored_alias != extension_alias || stored_server != server_id {
        return Ok(None);
    }
    let premise: WorkerStartPremise = serde_json::from_slice(&record_bytes).map_err(|error| {
        WorkerStartPremiseError(format!("stored premise record is malformed: {error}"))
    })?;
    if premise.config_revision != revision
        || premise.config_digest != digest
        || premise.daemon_installation_id != daemon
        || premise.instance_id != instance
        || premise.extension_alias != extension_alias
        || premise.server_id != server_id
        || premise.package_root != package_root
        || premise.package_path != package_path
        || premise.package_digest != package_digest
        || premise.executable_digest != executable_digest
        || premise.endpoint != endpoint
        || premise.record_digest != record_digest
    {
        return Err(WorkerStartPremiseError(
            "stored premise record disagrees with its projection columns".into(),
        ));
    }
    premise.verify_content()?;
    Ok(Some(premise))
}

/// Create the Worker-start premise slice next to an existing Host authority.
///
/// Mirrors the Tool-call ledger discipline: `IF NOT EXISTS` may only install
/// genuinely missing objects; anything existing is compared against the exact
/// authoritative definitions and any mismatch fails closed.
pub fn create_worker_start_premise_schema(connection: &Connection) -> StorageResult<()> {
    verify_authority_schema(connection).map_err(|_| StorageError::Corrupt)?;
    let expected = authoritative_premise_sql()?;
    let parent: Option<String> = connection
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config_revision_mappings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    if parent.is_none() {
        return Err(StorageError::MigrationRequired);
    }
    connection
        .execute_batch(WORKER_START_PREMISE_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    gate_worker_start_premise_schema_with(connection, &expected)
}

/// Verify the exact physical premise slice without creating anything.
pub fn gate_worker_start_premise_schema(connection: &Connection) -> StorageResult<()> {
    let expected = authoritative_premise_sql()?;
    gate_worker_start_premise_schema_with(connection, &expected)
}

fn gate_worker_start_premise_schema_with(
    connection: &Connection,
    expected_table: &str,
) -> StorageResult<()> {
    let table_sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [WORKER_START_PREMISE_TABLE],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some(table_sql) = table_sql else {
        return Err(StorageError::MigrationRequired);
    };
    if normalize_sql(&table_sql) != normalize_sql(expected_table) {
        return Err(StorageError::MigrationRequired);
    }
    verify_required_columns(
        connection,
        WORKER_START_PREMISE_TABLE,
        &[
            ("config_revision", "INTEGER", 0, 1),
            ("config_digest", "TEXT", 1, 0),
            ("extension_alias", "TEXT", 1, 0),
            ("server_id", "TEXT", 1, 0),
            ("package_root", "TEXT", 1, 0),
            ("package_path", "TEXT", 1, 0),
            ("package_digest", "TEXT", 1, 0),
            ("executable_digest", "TEXT", 1, 0),
            ("endpoint", "TEXT", 1, 0),
            ("record_jcs", "BLOB", 1, 0),
            ("record_digest", "TEXT", 1, 0),
        ],
    )?;
    let violations: i64 = {
        let mut statement = connection
            .prepare("PRAGMA foreign_key_check(worker_start_premises)")
            .map_err(map_sqlite_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(map_sqlite_error)?;
        rows.into_iter().next().is_some() as i64
    };
    if violations > 0 {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

/// Build the expected `sqlite_master.sql` for the premise table by creating
/// the reference schema in memory.
fn authoritative_premise_sql() -> StorageResult<String> {
    let connection = Connection::open_in_memory().map_err(map_sqlite_error)?;
    connection
        .execute_batch(HOST_AUTHORITY_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    connection
        .execute_batch(WORKER_START_PREMISE_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [WORKER_START_PREMISE_TABLE],
            |row| row.get(0),
        )
        .map_err(map_sqlite_error)
}

fn normalize_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn verify_required_columns(
    connection: &Connection,
    table: &str,
    expected: &[(&str, &str, i64, i64)],
) -> StorageResult<()> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(map_sqlite_error)?;
    let actual = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(map_sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_sqlite_error)?;
    if actual.len() != expected.len()
        || actual
            .iter()
            .zip(expected.iter())
            .any(|(got, want)| got.0 != want.0 || got.1 != want.1 || got.2 != want.2 || got.3 != want.3)
    {
        return Err(StorageError::MigrationRequired);
    }
    Ok(())
}

fn map_sqlite_error(error: rusqlite::Error) -> StorageError {
    let _ = &error;
    StorageError::Corrupt
}

/// Closed failure set for the Worker-start premise projection.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct WorkerStartPremiseError(pub String);

impl From<WorkerStartPremiseError> for StorageError {
    fn from(_value: WorkerStartPremiseError) -> Self {
        StorageError::Corrupt
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_authority::HOST_AUTHORITY_SCHEMA_SQL;

    fn seeded_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db");
        connection.execute_batch(HOST_AUTHORITY_SCHEMA_SQL).unwrap();
        connection
            .execute_batch(WORKER_START_PREMISE_SCHEMA_SQL)
            .unwrap();
        connection
            .execute(
                "INSERT INTO config_revision_mappings (
                     config_revision, daemon_installation_id, instance_id,
                     config_digest, canonical_bytes
                 ) VALUES (1, '0198ab31-6c44-7e8a-b2bb-000000000001',
                           'instance-a', ?1, x'7b7d')",
                rusqlite::params!["sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO runtime_authority_state (
                     singleton, authority_schema_version, daemon_installation_id,
                     instance_id, controller_generation_id, current_config_revision,
                     current_config_digest, record_jcs
                 ) VALUES (1, 2, '0198ab31-6c44-7e8a-b2bb-000000000001',
                           'instance-a', 'gen-1', 1,
                           'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
                           x'7b7d')",
                [],
            )
            .unwrap();
        connection
    }

    fn sample_input() -> WorkerStartPremiseInput {
        WorkerStartPremiseInput {
            daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
            instance_id: "instance-a".into(),
            config_revision: 1,
            config_digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a".into(),
            extension_alias: "org.dolly.tools".into(),
            server_id: "fs".into(),
            package_root: "/opt/dolly/pkg".into(),
            package_path: "/opt/dolly/pkg/package.bin".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            executable_digest: format!("sha256:{}", "b".repeat(64)),
            endpoint: "bin/dolly-fs-tools".into(),
        }
    }

    fn insert_sample(connection: &mut Connection, input: WorkerStartPremiseInput) -> bool {
        let tx = connection.transaction().expect("transaction");
        let inserted =
            insert_worker_start_premise_in_transaction(&tx, input).expect("insert");
        tx.commit().expect("commit");
        inserted
    }

    #[test]
    fn sealed_record_round_trips_through_insert_and_load() {
        let mut connection = seeded_connection();
        assert!(insert_sample(&mut connection, sample_input()));
        let identity = RuntimeAuthorityIdentity {
            daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
            instance_id: "instance-a".into(),
        };
        let premise = load_worker_start_premise(
            &connection,
            &identity,
            "org.dolly.tools",
            "fs",
        )
        .expect("load")
        .expect("premise present");
        assert_eq!(premise.package_root, "/opt/dolly/pkg");
        assert_eq!(premise.endpoint, "bin/dolly-fs-tools");
        premise.verify_content().expect("content valid");
    }

    #[test]
    fn identical_rewrite_is_idempotent_and_conflicting_rewrite_refuses() {
        let mut connection = seeded_connection();
        assert!(insert_sample(&mut connection, sample_input()));
        assert!(!insert_sample(&mut connection, sample_input()));
        let mut conflicting = sample_input();
        conflicting.package_digest = format!("sha256:{}", "c".repeat(64));
        let tx = connection.transaction().expect("transaction");
        assert!(insert_worker_start_premise_in_transaction(&tx, conflicting).is_err());
        drop(tx);
    }

    #[test]
    fn absent_projection_is_none_not_error() {
        let connection = seeded_connection();
        let identity = RuntimeAuthorityIdentity {
            daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
            instance_id: "instance-a".into(),
        };
        assert!(load_worker_start_premise(&connection, &identity, "org.dolly.tools", "fs")
            .expect("load")
            .is_none());
        assert!(
            load_worker_start_premise(&connection, &identity, "org.dolly.other", "fs")
                .expect("load")
                .is_none()
        );
    }

    #[test]
    fn identity_mismatch_refuses_closed() {
        let mut connection = seeded_connection();
        insert_sample(&mut connection, sample_input());
        let identity = RuntimeAuthorityIdentity {
            daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000002".into(),
            instance_id: "instance-a".into(),
        };
        assert!(
            load_worker_start_premise(&connection, &identity, "org.dolly.tools", "fs")
                .is_err()
        );
    }

    #[test]
    fn tampered_column_or_record_refuses() {
        let mut connection = seeded_connection();
        insert_sample(&mut connection, sample_input());
        // Keep the cross-column containment CHECK satisfied so the tamper
        // reaches the loader instead of tripping the schema guard.
        connection
            .execute(
                "UPDATE worker_start_premises SET package_root = '/opt/other',
                     package_path = '/opt/other/package.bin' WHERE config_revision = 1",
                [],
            )
            .unwrap();
        let identity = RuntimeAuthorityIdentity {
            daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
            instance_id: "instance-a".into(),
        };
        assert!(
            load_worker_start_premise(&connection, &identity, "org.dolly.tools", "fs")
                .is_err()
        );
    }

    #[test]
    fn stale_revision_projection_refuses() {
        let mut connection = seeded_connection();
        insert_sample(&mut connection, sample_input());
        // Advance the Host authority to revision 2 (mapping first so the FK
        // holds) while the projection still describes revision 1.
        connection
            .execute(
                "INSERT INTO config_revision_mappings (
                     config_revision, daemon_installation_id, instance_id,
                     config_digest, canonical_bytes
                 ) VALUES (2, '0198ab31-6c44-7e8a-b2bb-000000000001',
                           'instance-a', ?1, x'7b7d')",
                rusqlite::params![format!("sha256:{}", "2".repeat(64))],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE runtime_authority_state SET current_config_revision = 2,
                     current_config_digest = ?1",
                rusqlite::params![format!("sha256:{}", "2".repeat(64))],
            )
            .unwrap();
        let identity = RuntimeAuthorityIdentity {
            daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
            instance_id: "instance-a".into(),
        };
        assert!(
            load_worker_start_premise(&connection, &identity, "org.dolly.tools", "fs")
                .is_err()
        );
    }

    #[test]
    fn content_validation_rejects_escape_paths_and_bad_digests() {
        let escape = WorkerStartPremise {
            schema: WORKER_START_PREMISE_RECORD_SCHEMA.into(),
            daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
            instance_id: "instance-a".into(),
            config_revision: 1,
            config_digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a".into(),
            extension_alias: "org.dolly.tools".into(),
            server_id: "fs".into(),
            package_root: "/opt/dolly/pkg".into(),
            package_path: "/etc/passwd".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            executable_digest: format!("sha256:{}", "b".repeat(64)),
            endpoint: "bin/tool".into(),
            record_digest: String::new(),
        };
        assert!(escape.verify_content().is_err());
        let bad_endpoint = WorkerStartPremise {
            endpoint: "../escape".into(),
            ..escape.clone()
        };
        assert!(bad_endpoint.verify_content().is_err());
    }

    #[test]
    fn schema_gate_requires_exact_shape() {
        let mut connection = seeded_connection();
        gate_worker_start_premise_schema(&connection).expect("gate passes");
        connection
            .execute("DROP TABLE worker_start_premises", [])
            .unwrap();
        connection
            .execute(
                "CREATE TABLE worker_start_premises (
                     config_revision INTEGER PRIMARY KEY CHECK (config_revision BETWEEN 1 AND 9007199254740991),
                     config_digest TEXT NOT NULL,
                     extension_alias TEXT NOT NULL,
                     server_id TEXT NOT NULL,
                     package_root TEXT NOT NULL,
                     package_path TEXT NOT NULL,
                     package_digest TEXT NOT NULL,
                     executable_digest TEXT NOT NULL,
                     record_jcs BLOB NOT NULL,
                     record_digest TEXT NOT NULL
                 )",
                [],
            )
            .unwrap();
        assert!(matches!(
            gate_worker_start_premise_schema(&connection),
            Err(StorageError::MigrationRequired)
        ));
    }
}
