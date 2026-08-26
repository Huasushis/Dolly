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

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use dolly_canonical_json::{
    MAX_SEMANTIC_JSON_NESTING_DEPTH, PROTOCOL_WIRE_PARSE_DEPTH, Sha256Digest, canonicalize,
};

use crate::error::{StorageError, StorageResult};
use crate::host_authority::{
    HOST_AUTHORITY_SCHEMA_SQL, RuntimeAuthorityIdentity, verify_authority_schema,
};

/// Physical schema version of the Worker-start premise slice.
pub const WORKER_START_PREMISE_SCHEMA_VERSION: i64 = 2;
/// Closed logical record schema for one Worker-start premise row.
pub const WORKER_START_PREMISE_RECORD_SCHEMA: &str = "dolly.worker-start-premise/v2";
/// The single projected table.
pub const WORKER_START_PREMISE_TABLE: &str = "worker_start_premises";
/// Hard ceiling on sealed spawn arguments per premise row.
pub const MAX_SPAWN_ARGS: usize = 64;

/// Closed physical schema for the Worker-start premise projection.
///
/// Every row is pinned to one `(config_revision, config_digest)` mapping
/// through the Host authority foreign key, so installing a new authority
/// revision never silently re-points an existing projection. The CHECK
/// constraints encode the cheap invariants; the complete record digest and
/// identity agreement are verified on every load.
pub(crate) const WORKER_START_PREMISE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS worker_start_premises (
    config_revision     INTEGER NOT NULL CHECK (config_revision BETWEEN 1 AND 9007199254740991),
    config_digest       TEXT    NOT NULL,
    extension_alias     TEXT    NOT NULL CHECK (length(extension_alias) > 0),
    server_id           TEXT    NOT NULL CHECK (length(server_id) > 0),
    package_root        TEXT    NOT NULL CHECK (length(package_root) > 0),
    package_path        TEXT    NOT NULL CHECK (length(package_path) > 0),
    package_digest      TEXT    NOT NULL CHECK (package_digest LIKE 'sha256:%'),
    executable_digest   TEXT    NOT NULL CHECK (executable_digest LIKE 'sha256:%'),
    endpoint            TEXT    NOT NULL CHECK (length(endpoint) > 0),
    spawn_args_json     TEXT    NOT NULL CHECK (json_valid(spawn_args_json) AND json_type(spawn_args_json) = 'array'),
    startup_timeout_ms  INTEGER NOT NULL CHECK (startup_timeout_ms BETWEEN 1 AND 9007199254740991),
    max_frame_bytes     INTEGER NOT NULL CHECK (max_frame_bytes BETWEEN 1 AND 4294967295),
    max_response_bytes  INTEGER NOT NULL CHECK (max_response_bytes BETWEEN 1 AND 4294967295),
    wire_depth          INTEGER NOT NULL CHECK (wire_depth BETWEEN 1 AND 96),
    semantic_depth      INTEGER NOT NULL CHECK (semantic_depth BETWEEN 1 AND 64),
    max_dispatch_members INTEGER NOT NULL CHECK (max_dispatch_members BETWEEN 1 AND 9007199254740991),
    max_dispatch_depth  INTEGER NOT NULL CHECK (max_dispatch_depth BETWEEN 1 AND 64),
    transport_digest    TEXT    NOT NULL CHECK (transport_digest LIKE 'sha256:%'),
    record_jcs          BLOB    NOT NULL,
    record_digest       TEXT    NOT NULL,
    PRIMARY KEY (config_revision, extension_alias, server_id),
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
    /// Exact spawn argv beyond the executable, sealed as a JSON string
    /// array. The Worker spawns with exactly these arguments.
    pub spawn_args_json: String,
    /// Sealed MCP startup deadline in milliseconds (1..=2^53-1).
    pub startup_timeout_ms: i64,
    /// Sealed stdio frame byte cap shared by request and response frames.
    pub max_frame_bytes: i64,
    /// Sealed maximum admitted response frame size in bytes.
    pub max_response_bytes: i64,
    /// Sealed wire parse-depth ceiling for every frame (1..=96).
    pub wire_depth: i64,
    /// Sealed semantic JSON depth ceiling for every frame (1..=64).
    pub semantic_depth: i64,
    /// Sealed maximum total object members across one dispatch response.
    pub max_dispatch_members: i64,
    /// Sealed maximum nesting depth inside one dispatch response.
    pub max_dispatch_depth: i64,
    /// Digest of the canonical transport contract this projection seals.
    pub transport_digest: String,
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
            spawn_args_json: &self.spawn_args_json,
            startup_timeout_ms: self.startup_timeout_ms,
            max_frame_bytes: self.max_frame_bytes,
            max_response_bytes: self.max_response_bytes,
            wire_depth: self.wire_depth,
            semantic_depth: self.semantic_depth,
            max_dispatch_members: self.max_dispatch_members,
            max_dispatch_depth: self.max_dispatch_depth,
            transport_digest: &self.transport_digest,
        }
    }

    /// Recompute and verify the sealing record digest.
    pub fn verify_record_digest(&self) -> Result<(), WorkerStartPremiseError> {
        let digest = self.unsigned().record_digest().map_err(|error| {
            WorkerStartPremiseError(format!("canonical digest failed: {error}"))
        })?;
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
        for label in [
            "config_digest",
            "package_digest",
            "executable_digest",
            "transport_digest",
            "record_digest",
        ] {
            let value = match label {
                "config_digest" => &self.config_digest,
                "package_digest" => &self.package_digest,
                "executable_digest" => &self.executable_digest,
                "transport_digest" => &self.transport_digest,
                _ => &self.record_digest,
            };
            if !is_sha256_digest(value) {
                return Err(WorkerStartPremiseError(format!(
                    "{label} is not a sha256 digest"
                )));
            }
        }
        if self.extension_alias.is_empty()
            || !self
                .extension_alias
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
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
        if !(1..=9_007_199_254_740_991_i64).contains(&self.startup_timeout_ms) {
            return Err(WorkerStartPremiseError(
                "startup_timeout_ms out of the safe-integer range".into(),
            ));
        }
        for label in ["max_frame_bytes", "max_response_bytes"] {
            let value = match label {
                "max_frame_bytes" => self.max_frame_bytes,
                _ => self.max_response_bytes,
            };
            if !(1..=4_294_967_295_i64).contains(&value) {
                return Err(WorkerStartPremiseError(format!(
                    "{label} out of the u32 range"
                )));
            }
        }
        if !(1..=i64::from(PROTOCOL_WIRE_PARSE_DEPTH)).contains(&self.wire_depth) {
            return Err(WorkerStartPremiseError(
                "wire_depth exceeds the protocol wire ceiling".into(),
            ));
        }
        for (label, value) in [
            ("semantic_depth", self.semantic_depth),
            ("max_dispatch_depth", self.max_dispatch_depth),
        ] {
            if !(1..=i64::from(MAX_SEMANTIC_JSON_NESTING_DEPTH)).contains(&value) {
                return Err(WorkerStartPremiseError(format!(
                    "{label} exceeds the semantic depth ceiling"
                )));
            }
        }
        if !(1..=9_007_199_254_740_991_i64).contains(&self.max_dispatch_members) {
            return Err(WorkerStartPremiseError(
                "max_dispatch_members out of the safe-integer range".into(),
            ));
        }
        match serde_json::from_str::<Vec<String>>(&self.spawn_args_json) {
            Ok(args) => {
                if args.len() > MAX_SPAWN_ARGS {
                    return Err(WorkerStartPremiseError(
                        "spawn_args_json carries too many arguments".into(),
                    ));
                }
            }
            Err(_) => {
                return Err(WorkerStartPremiseError(
                    "spawn_args_json is not a JSON string array".into(),
                ));
            }
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
    spawn_args_json: &'a str,
    startup_timeout_ms: i64,
    max_frame_bytes: i64,
    max_response_bytes: i64,
    wire_depth: i64,
    semantic_depth: i64,
    max_dispatch_members: i64,
    max_dispatch_depth: i64,
    transport_digest: &'a str,
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

/// True when `value` is a safe relative member: non-empty, no `\`, no
/// absolute or drive components, and no separators beyond `/`.
pub(crate) fn is_safe_relative_member(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\\')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
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

/// Build the canonical JCS bytes and sealing digest for a premise record.
pub(crate) fn seal_premise_record(
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
        spawn_args_json: unsigned.spawn_args_json,
        startup_timeout_ms: unsigned.startup_timeout_ms,
        max_frame_bytes: unsigned.max_frame_bytes,
        max_response_bytes: unsigned.max_response_bytes,
        wire_depth: unsigned.wire_depth,
        semantic_depth: unsigned.semantic_depth,
        max_dispatch_members: unsigned.max_dispatch_members,
        max_dispatch_depth: unsigned.max_dispatch_depth,
        transport_digest: unsigned.transport_digest,
        record_digest: String::new(),
    };
    let digest = premise
        .unsigned()
        .record_digest()
        .map_err(|error| WorkerStartPremiseError(format!("canonical digest failed: {error}")))?;
    let mut sealed = premise;
    sealed.record_digest = digest.to_canonical_string();
    let bytes = canonicalize(
        &serde_json::to_value(&sealed)
            .map_err(|error| WorkerStartPremiseError(format!("serialization failed: {error}")))?,
    )
    .map_err(|error| WorkerStartPremiseError(format!("canonicalization failed: {error}")))?
    .0;
    Ok((bytes.into_vec(), sealed.record_digest))
}

/// Unsigned premise content supplied by the Host-owned producer. Sealing and
/// insertion stay inside the storage crate; only the TS authority writer is
/// the production producer.
#[derive(Clone)]
pub(crate) struct WorkerStartPremiseInput {
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
    /// Exact spawn argv beyond the executable, already JSON-encoded as a
    /// string array by the Host producer.
    pub spawn_args_json: String,
    pub startup_timeout_ms: i64,
    pub max_frame_bytes: i64,
    pub max_response_bytes: i64,
    pub wire_depth: i64,
    pub semantic_depth: i64,
    pub max_dispatch_members: i64,
    pub max_dispatch_depth: i64,
    pub transport_digest: String,
}

/// Insert one sealed premise row inside the caller's open transaction.
///
/// Idempotence and conflict are scoped to one identity pair; two distinct
/// identity pairs of one revision coexist as separate rows.
pub(crate) fn insert_worker_start_premise_in_transaction(
    tx: &Transaction<'_>,
    input: WorkerStartPremiseInput,
) -> Result<bool, WorkerStartPremiseError> {
    let (bytes, record_digest) = seal_premise_record(input.clone())?;
    // Idempotence and conflict are scoped to ONE identity pair: two distinct
    // extension/server identities of the same revision coexist as rows.
    let existing: Option<String> = tx
        .query_row(
            "SELECT record_digest FROM worker_start_premises
             WHERE config_revision = ?1 AND extension_alias = ?2 AND server_id = ?3",
            rusqlite::params![
                input.config_revision,
                input.extension_alias,
                input.server_id
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| WorkerStartPremiseError(format!("premise lookup failed: {error}")))?;
    if let Some(existing_digest) = existing {
        if existing_digest == record_digest {
            return Ok(false);
        }
        return Err(WorkerStartPremiseError(
            "a different Worker-start premise is already projected for this identity pair".into(),
        ));
    }
    tx.execute(
        "INSERT INTO worker_start_premises (
            config_revision, config_digest, extension_alias, server_id,
            package_root, package_path, package_digest, executable_digest,
            endpoint, spawn_args_json, startup_timeout_ms, max_frame_bytes,
            max_response_bytes, wire_depth, semantic_depth, max_dispatch_members,
            max_dispatch_depth, transport_digest, record_jcs, record_digest
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
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
            input.spawn_args_json,
            input.startup_timeout_ms,
            input.max_frame_bytes,
            input.max_response_bytes,
            input.wire_depth,
            input.semantic_depth,
            input.max_dispatch_members,
            input.max_dispatch_depth,
            input.transport_digest,
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
    if daemon != identity.daemon_installation_id || instance != identity.instance_id {
        return Err(WorkerStartPremiseError(
            "authority-state identity disagrees with the opened database tuple".into(),
        ));
    }
    // The projection is looked up by the full identity key: one row per
    // (current revision, extension alias, server id) pair.
    let row = connection
        .query_row(
            "SELECT config_digest, package_root, package_path,
                    package_digest, executable_digest, endpoint, spawn_args_json,
                    startup_timeout_ms, max_frame_bytes, max_response_bytes,
                    wire_depth, semantic_depth, max_dispatch_members,
                    max_dispatch_depth, transport_digest, record_jcs, record_digest
             FROM worker_start_premises
             WHERE config_revision = ?1 AND extension_alias = ?2 AND server_id = ?3",
            rusqlite::params![revision, extension_alias, server_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, i64>(13)?,
                    row.get::<_, String>(14)?,
                    row.get::<_, Vec<u8>>(15)?,
                    row.get::<_, String>(16)?,
                ))
            },
        )
        .optional()
        .map_err(|error| WorkerStartPremiseError(format!("premise lookup failed: {error}")))?;
    let Some((
        stored_config_digest,
        package_root,
        package_path,
        package_digest,
        executable_digest,
        endpoint,
        spawn_args_json,
        startup_timeout_ms,
        max_frame_bytes,
        max_response_bytes,
        wire_depth,
        semantic_depth,
        max_dispatch_members,
        max_dispatch_depth,
        transport_digest,
        record_bytes,
        record_digest,
    )) = row
    else {
        // Distinguish absence from staleness for THIS identity pair only:
        // rows projected for the same pair under older revisions mean the
        // Host authority moved without producing a new premise; rows for
        // other identity pairs coexist and must not mask absence.
        let stale_row: Option<i64> = connection
            .query_row(
                "SELECT config_revision FROM worker_start_premises
                 WHERE extension_alias = ?1 AND server_id = ?2 LIMIT 1",
                rusqlite::params![extension_alias, server_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| WorkerStartPremiseError(format!("premise lookup failed: {error}")))?;
        if stale_row.is_some() {
            return Err(WorkerStartPremiseError(
                "Worker-start premise is projected for a different authority revision".into(),
            ));
        }
        return Ok(None);
    };
    if stored_config_digest != digest {
        return Err(WorkerStartPremiseError(
            "projected premise belongs to a different authority revision".into(),
        ));
    }
    // Stored bytes must be byte-for-byte JSON Canonicalization Scheme output:
    // the sealed document is re-canonicalized and compared byte-exactly.
    let premise_value: serde_json::Value =
        serde_json::from_slice(&record_bytes).map_err(|error| {
            WorkerStartPremiseError(format!("stored premise record is malformed: {error}"))
        })?;
    let (canonical_bytes, _) =
        dolly_canonical_json::canonicalize(&premise_value).map_err(|error| {
            WorkerStartPremiseError(format!("stored premise record is not JCS: {error}"))
        })?;
    if canonical_bytes.as_ref() != record_bytes.as_slice() {
        return Err(WorkerStartPremiseError(
            "stored premise record bytes are not canonical JSON".into(),
        ));
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
        || premise.spawn_args_json != spawn_args_json
        || premise.startup_timeout_ms != startup_timeout_ms
        || premise.max_frame_bytes != max_frame_bytes
        || premise.max_response_bytes != max_response_bytes
        || premise.wire_depth != wire_depth
        || premise.semantic_depth != semantic_depth
        || premise.max_dispatch_members != max_dispatch_members
        || premise.max_dispatch_depth != max_dispatch_depth
        || premise.transport_digest != transport_digest
        || premise.record_digest != record_digest
    {
        return Err(WorkerStartPremiseError(
            "stored premise record disagrees with its projection columns".into(),
        ));
    }
    premise.verify_content()?;
    Ok(Some(premise))
}

/// Opens SQLite with the driver's read-only flag (no create/write) and sets
/// `query_only` on the connection. SQLite's WAL reader materializes -shm/
/// -wal sidecars even for read-only connections; the keeper-connection
/// contract test therefore proves byte-for-byte equality of the complete
/// file set (db, WAL, SHM) across the refused production run, with the
/// sidecars held open by a live reader.
pub struct ReadOnlyAuthorityPreflight {
    connection: Connection,
}

impl ReadOnlyAuthorityPreflight {
    /// Open `db_path` strictly read-only; a missing database file fails here
    /// instead of being created.
    pub fn open(db_path: &Path) -> StorageResult<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let connection = Connection::open_with_flags(db_path, flags).map_err(map_sqlite_error)?;
        connection
            .execute_batch("PRAGMA query_only = ON")
            .map_err(map_sqlite_error)?;
        Ok(Self { connection })
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }
}

/// Read the persisted authority identity tuple `(daemon_installation_id,
/// instance_id)` without any writable open or lock artifact.
pub fn load_persisted_identity_tuple(
    connection: &Connection,
) -> StorageResult<Option<RuntimeAuthorityIdentity>> {
    let row = connection
        .query_row(
            "SELECT daemon_installation_id, instance_id
             FROM runtime_authority_state WHERE singleton = 1",
            [],
            |row| {
                Ok(RuntimeAuthorityIdentity {
                    daemon_installation_id: row.get::<_, String>(0)?,
                    instance_id: row.get::<_, String>(1)?,
                })
            },
        )
        .optional()
        .map_err(map_sqlite_error)?;
    Ok(row)
}

/// Evaluate one identity pair's Worker-start premise against the current
/// authority revision through exactly ONE read-only open: gate both schemas,
/// read the persisted identity from that same connection, then load and fully
/// verify the requested row. No controller generation is minted, no
/// lock-owner state is rewritten, and no schema creation or migration can run.
pub fn preflight_worker_start_premise(
    db_path: &Path,
    extension_alias: &str,
    server_id: &str,
) -> Result<Option<WorkerStartPremise>, WorkerStartPremiseError> {
    let read_only = ReadOnlyAuthorityPreflight::open(db_path)
        .map_err(|error| WorkerStartPremiseError(format!("read-only open refused: {error}")))?;
    let connection = read_only.connection();
    verify_authority_schema(connection).map_err(|error| {
        WorkerStartPremiseError(format!("host authority schema refused: {error}"))
    })?;
    gate_worker_start_premise_schema(connection)
        .map_err(|error| WorkerStartPremiseError(format!("premise schema refused: {error}")))?;
    let identity = load_persisted_identity_tuple(connection)
        .map_err(|error| WorkerStartPremiseError(format!("identity read failed: {error}")))?
        .ok_or_else(|| {
            WorkerStartPremiseError("authority identity is absent for this database".into())
        })?;
    load_worker_start_premise(connection, &identity, extension_alias, server_id)
}

/// Create the Worker-start premise slice next to an existing Host authority.
///
/// Mirrors the Tool-call ledger discipline: `IF NOT EXISTS` may only install
/// genuinely missing objects; anything existing is compared against the exact
/// authoritative definitions and any mismatch fails closed.
pub(crate) fn create_worker_start_premise_schema(connection: &Connection) -> StorageResult<()> {
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
            ("config_revision", "INTEGER", 1, 1),
            ("config_digest", "TEXT", 1, 0),
            ("extension_alias", "TEXT", 1, 2),
            ("server_id", "TEXT", 1, 3),
            ("package_root", "TEXT", 1, 0),
            ("package_path", "TEXT", 1, 0),
            ("package_digest", "TEXT", 1, 0),
            ("executable_digest", "TEXT", 1, 0),
            ("endpoint", "TEXT", 1, 0),
            ("spawn_args_json", "TEXT", 1, 0),
            ("startup_timeout_ms", "INTEGER", 1, 0),
            ("max_frame_bytes", "INTEGER", 1, 0),
            ("max_response_bytes", "INTEGER", 1, 0),
            ("wire_depth", "INTEGER", 1, 0),
            ("semantic_depth", "INTEGER", 1, 0),
            ("max_dispatch_members", "INTEGER", 1, 0),
            ("max_dispatch_depth", "INTEGER", 1, 0),
            ("transport_digest", "TEXT", 1, 0),
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
        || actual.iter().zip(expected.iter()).any(|(got, want)| {
            got.0 != want.0 || got.1 != want.1 || got.2 != want.2 || got.3 != want.3
        })
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
                rusqlite::params![
                    "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
                ],
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
            config_digest:
                "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a".into(),
            extension_alias: "org.dolly.tools".into(),
            server_id: "fs".into(),
            package_root: "/opt/dolly/pkg".into(),
            package_path: "/opt/dolly/pkg/package.bin".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            executable_digest: format!("sha256:{}", "b".repeat(64)),
            endpoint: "bin/dolly-fs-tools".into(),
            spawn_args_json: r#"["server.py"]"#.into(),
            startup_timeout_ms: 10_000,
            max_frame_bytes: 262_144,
            max_response_bytes: 262_144,
            wire_depth: 96,
            semantic_depth: 64,
            max_dispatch_members: 4_096,
            max_dispatch_depth: 64,
            transport_digest: format!("sha256:{}", "e".repeat(64)),
        }
    }

    #[test]
    fn schema_gate_enforces_composite_identity_pk() {
        let mut connection = seeded_connection();
        // The authoritative table reports the composite identity primary key
        // with ordinals 1/2/3 and NOT NULL on every key column.
        let key: Vec<(String, i64, i64)> = {
            let mut statement = connection
                .prepare(
                    "SELECT name, \"notnull\", pk FROM pragma_table_info('worker_start_premises')
                     WHERE pk > 0 ORDER BY pk",
                )
                .expect("pragma table_info");
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .expect("query key columns");
            rows.map(|row| row.expect("key column row")).collect()
        };
        assert_eq!(
            key,
            vec![
                ("config_revision".to_string(), 1, 1),
                ("extension_alias".to_string(), 1, 2),
                ("server_id".to_string(), 1, 3),
            ]
        );
        // A revision-only PK table must fail the exact-shape gate.
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
                     endpoint TEXT NOT NULL,
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

    fn insert_sample(connection: &mut Connection, input: WorkerStartPremiseInput) -> bool {
        let tx = connection.transaction().expect("transaction");
        let inserted = insert_worker_start_premise_in_transaction(&tx, input).expect("insert");
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
        let premise = load_worker_start_premise(&connection, &identity, "org.dolly.tools", "fs")
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
        assert!(
            load_worker_start_premise(&connection, &identity, "org.dolly.tools", "fs")
                .expect("load")
                .is_none()
        );
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
            load_worker_start_premise(&connection, &identity, "org.dolly.tools", "fs").is_err()
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
            load_worker_start_premise(&connection, &identity, "org.dolly.tools", "fs").is_err()
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
            load_worker_start_premise(&connection, &identity, "org.dolly.tools", "fs").is_err()
        );
    }

    #[test]
    fn content_validation_rejects_escape_paths_and_bad_digests() {
        let escape = WorkerStartPremise {
            schema: WORKER_START_PREMISE_RECORD_SCHEMA.into(),
            daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
            instance_id: "instance-a".into(),
            config_revision: 1,
            config_digest:
                "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a".into(),
            extension_alias: "org.dolly.tools".into(),
            server_id: "fs".into(),
            package_root: "/opt/dolly/pkg".into(),
            package_path: "/etc/passwd".into(),
            package_digest: format!("sha256:{}", "a".repeat(64)),
            executable_digest: format!("sha256:{}", "b".repeat(64)),
            endpoint: "bin/tool".into(),
            spawn_args_json: r#"["server.py"]"#.into(),
            startup_timeout_ms: 10_000,
            max_frame_bytes: 262_144,
            max_response_bytes: 262_144,
            wire_depth: 96,
            semantic_depth: 64,
            max_dispatch_members: 4_096,
            max_dispatch_depth: 64,
            transport_digest: format!("sha256:{}", "e".repeat(64)),
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
        {
            let expected = authoritative_premise_sql().unwrap();
            let got: String = connection
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name='worker_start_premises'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            eprintln!("DBG_EXPECTED={expected}");
            eprintln!("DBG_GOT={got}");
            let mut stmt = connection
                .prepare("PRAGMA table_info(worker_start_premises)")
                .unwrap();
            let rows: Vec<String> = stmt
                .query_map([], |r| {
                    Ok(format!(
                        "{}|{}|{}|{}",
                        r.get::<_, String>(1).unwrap(),
                        r.get::<_, String>(2).unwrap(),
                        r.get::<_, i64>(3).unwrap(),
                        r.get::<_, i64>(5).unwrap()
                    ))
                })
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            eprintln!("DBG_PRAGMA={rows:?}");
        }
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
