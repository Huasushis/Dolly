//! Durable SQLite instance open and connection configuration (DB-open slice).
//!
//! Implements the normative startup sequence of `docs/spec/core/06-storage-and-recovery.md`
//! §2 and §10 plus REQ-TECH-003 / ADR 0006:
//!
//! 1. refuse unsafe paths (any symlinkable component), refusing to touch a
//!    substituted target;
//! 2. acquire the exclusive OS-level instance lock before any write-open;
//! 3. verify the loaded SQLite build against the release attestation before
//!    opening the database (fail-closed, no writable override);
//! 4. open the connection and set+verify the required PRAGMAs, mapping any
//!    mismatch to `STORAGE_UNSAFE_CONFIGURATION`;
//! 5. create or check the schema version singleton, mapping a newer schema to
//!    `STORAGE_MIGRATION_REQUIRED`.
//!
//! Crash-point recovery, sequence allocation, and the `CoreTransaction` write
//! path are out of scope for this slice (`transaction.rs` stays untouched).

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};

use crate::attestation::{LoadedSqlite, ReleaseAttestation, SqliteBuildGate, VerifiedSqliteBuild};
use crate::error::{StorageError, StorageResult};
use crate::host_authority::{
    ConfigRevisionMapping, HOST_AUTHORITY_SCHEMA_SQL, HostAuthorityError, HostAuthorityRevision,
    InstallDisposition, LinuxServiceCandidate, ModuleActivationPremises,
    PermissionPolicyBackendBinding, PermissionPolicyDefinition, PermissionPolicySelection,
    ResolvedConfiguration, RuntimeAuthorityIdentity,
    install_host_authority_revision_in_transaction, load_current_authority,
};

/// Highest schema version this binary understands.
pub const SCHEMA_VERSION: i64 = 1;

/// The required-connection settings from storage-and-recovery §2. The readback
/// of each must equal the mandated value or the open refuses with
/// `STORAGE_UNSAFE_CONFIGURATION`.
pub mod required {
    /// `PRAGMA journal_mode` must read back `"wal"`.
    pub const JOURNAL_MODE: &str = "wal";
    /// `PRAGMA synchronous` must read back `2` (`FULL`).
    pub const SYNCHRONOUS: i64 = 2;
    /// `PRAGMA foreign_keys` must read back `1` (`ON`).
    pub const FOREIGN_KEYS: i64 = 1;
    /// `PRAGMA trusted_schema` must read back `0` (`OFF`).
    pub const TRUSTED_SCHEMA: i64 = 0;
    /// `PRAGMA busy_timeout` must read back `5000`.
    pub const BUSY_TIMEOUT_MS: i64 = 5000;
}

/// Byte-level result of the open-time connection configuration checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionConfiguration {
    journal_mode: String,
    synchronous: i64,
    foreign_keys: i64,
    trusted_schema: i64,
    busy_timeout: i64,
}

impl ConnectionConfiguration {
    /// Deterministic pure comparator used by legacy callers that do not expose
    /// the connection-local trusted-schema setting.
    pub fn verify(
        journal_mode: &str,
        synchronous: i64,
        foreign_keys: i64,
        busy_timeout: i64,
    ) -> StorageResult<Self> {
        Self::verify_with_trusted_schema(
            journal_mode,
            synchronous,
            foreign_keys,
            required::TRUSTED_SCHEMA,
            busy_timeout,
        )
    }

    pub fn verify_with_trusted_schema(
        journal_mode: &str,
        synchronous: i64,
        foreign_keys: i64,
        trusted_schema: i64,
        busy_timeout: i64,
    ) -> StorageResult<Self> {
        if journal_mode != required::JOURNAL_MODE
            || synchronous != required::SYNCHRONOUS
            || foreign_keys != required::FOREIGN_KEYS
            || trusted_schema != required::TRUSTED_SCHEMA
            || busy_timeout != required::BUSY_TIMEOUT_MS
        {
            return Err(StorageError::UnsafeConfiguration);
        }
        Ok(Self {
            journal_mode: journal_mode.to_string(),
            synchronous,
            foreign_keys,
            trusted_schema,
            busy_timeout,
        })
    }

    pub fn journal_mode(&self) -> &str {
        &self.journal_mode
    }

    pub fn synchronous(&self) -> i64 {
        self.synchronous
    }

    pub fn foreign_keys(&self) -> i64 {
        self.foreign_keys
    }

    pub fn trusted_schema(&self) -> i64 {
        self.trusted_schema
    }

    pub fn busy_timeout(&self) -> i64 {
        self.busy_timeout
    }
}

/// An opened, verified, write-capable storage instance.
///
/// Holds the instance lock descriptor for its lifetime; dropping the value
/// releases the OS lock. `connection()` is the single writer surface behind
/// the `CoreTransaction` boundary (`transaction.rs`).
#[derive(Debug)]
pub struct Database {
    connection: Connection,
    #[allow(dead_code)] // the descriptor itself is the lock; keep it alive.
    instance_lock: File,
    verified: VerifiedSqliteBuild,
    configuration: ConnectionConfiguration,
    schema_version: i64,
    authority_identity: Option<RuntimeAuthorityIdentity>,
}

impl Database {
    /// Open `db_path` with the compiled-in release attestation.
    pub fn open(db_path: &Path) -> StorageResult<Self> {
        Self::open_with(db_path, &crate::attestation::release_attestation())
    }

    /// Open `db_path` using an explicit attestation (tests and release
    /// instrumenting use this; the floor constant still cannot be weakened).
    pub fn open_with(db_path: &Path, attestation: &ReleaseAttestation) -> StorageResult<Self> {
        reject_symlink_components(db_path)?;

        // REQ-TECH-003 is checked before creating the controller lock or
        // opening the candidate bytes for a write.
        let loaded = probe_loaded_sqlite();
        let verified = SqliteBuildGate.verify(attestation, &loaded)?;

        // The lock is held for the entire writable connection lifetime.
        let instance_lock = acquire_instance_lock(db_path)?;
        let connection = open_connection(db_path)?;
        let configuration = apply_and_verify_configuration(&connection)?;
        let schema_version = ensure_schema(&connection, &verified)?;
        verify_sqlite_integrity(&connection)?;
        let authority_identity = validate_authority_state(&connection)?;

        Ok(Self {
            connection,
            instance_lock,
            verified,
            configuration,
            schema_version,
            authority_identity,
        })
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    /// Mutable access to the single writer connection, used by transaction
    /// API slices (e.g. the Tool-call ledger) that own their transactions.
    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }

    pub fn configuration(&self) -> &ConnectionConfiguration {
        &self.configuration
    }

    pub fn schema_version(&self) -> i64 {
        self.schema_version
    }

    pub fn verified_build(&self) -> &VerifiedSqliteBuild {
        &self.verified
    }

    /// The persisted identity, if this database has committed an authority
    /// revision. The filesystem path is intentionally absent from this value.
    pub fn authority_identity(&self) -> Option<&RuntimeAuthorityIdentity> {
        self.authority_identity.as_ref()
    }

    /// Explicitly import one legacy JSON document. Ordinary open never calls
    /// this method and therefore never lets JSON override SQLite authority.
    pub fn migrate_legacy_json(&mut self, bytes: &[u8]) -> StorageResult<InstallDisposition> {
        let input = parse_legacy_authority(bytes)?;
        if load_current_authority(self.connection())
            .map_err(map_host_authority_error)?
            .is_some()
        {
            return Err(StorageError::MigrationRequired);
        }

        let identity = input.identity.clone();
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        let disposition = install_host_authority_revision_in_transaction(&tx, &input)
            .map_err(map_host_authority_error)?;
        tx.commit().map_err(map_sqlite_error)?;
        self.authority_identity = Some(identity);
        Ok(disposition)
    }
}

/// Read the loaded SQLite library identity from FFI (REQ-TECH-003 probe).
pub fn probe_loaded_sqlite() -> LoadedSqlite {
    use std::ffi::CStr;
    use std::os::raw::c_char;

    unsafe {
        let version = CStr::from_ptr(libsqlite3_sys::sqlite3_libversion())
            .to_string_lossy()
            .into_owned();
        let version_number = libsqlite3_sys::sqlite3_libversion_number() as u32;
        let source_id = CStr::from_ptr(libsqlite3_sys::sqlite3_sourceid())
            .to_string_lossy()
            .into_owned();
        let mut compile_options = Vec::new();
        for i in 0.. {
            let raw: *const c_char = libsqlite3_sys::sqlite3_compileoption_get(i);
            if raw.is_null() {
                break;
            }
            compile_options.push(CStr::from_ptr(raw).to_string_lossy().into_owned());
        }
        let artifact_digest = boot_artifact_digest();
        LoadedSqlite {
            version,
            version_number,
            source_id,
            artifact_digest,
            compile_options: Some(compile_options),
            linkage_mode: Some("bundled-static".to_string()),
        }
    }
}

/// Compiled-in artifact digest of the bundled amalgamation (build.rs emits it).
fn boot_artifact_digest() -> dolly_canonical_json::Sha256Digest {
    use std::str::FromStr;
    const HEX: &str = env!("DOLLY_STORAGE_SQLITE3_C_SHA256");
    debug_assert_eq!(HEX.len(), 64);
    let mut prefixed = String::with_capacity(71);
    prefixed.push_str("sha256:");
    prefixed.push_str(HEX);
    dolly_canonical_json::Sha256Digest::from_str(&prefixed)
        .expect("build.rs must emit a valid sha256: hex digest")
}

fn reject_symlink_components(path: &Path) -> StorageResult<()> {
    let mut probe = PathBuf::new();
    for component in path.components() {
        probe.push(component.as_os_str());
        match fs::symlink_metadata(&probe) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(StorageError::UnsafeConfiguration);
            }
            Ok(_) => { /* regular dir/file: continue */ }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                // Remaining components do not exist yet; nothing to chase.
                break;
            }
            Err(e) => {
                return Err(map_io_error(e));
            }
        }
    }
    Ok(())
}

fn acquire_instance_lock(db_path: &Path) -> StorageResult<File> {
    let lock_path = instance_lock_path(db_path);
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // Reusable lock file: create if absent, O_NOFOLLOW refuses a
        // pre-existing symlink atomically; exclusivity comes from flock.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&lock_path)
            .map_err(map_io_error)?;
        try_lock_exclusive(&file)?;
        // The open may have raced a replacement; confirm what we hold.
        let meta = file.metadata().map_err(map_io_error)?;
        if !meta.is_file() {
            return Err(StorageError::UnsafeConfiguration);
        }
        let _ = file.as_raw_fd();
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        // No advisory-exclusive lock primitive on this platform in this crate
        // yet; refuse to open for writing rather than risk a second writer.
        let _ = &lock_path;
        Err(StorageError::UnsafeConfiguration)
    }
}

/// The instance lock file lives beside the database, one per storage root
/// (cross-platform contract §6 "one lock file in its durable data root").
fn instance_lock_path(db_path: &Path) -> PathBuf {
    let mut name = db_path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| "instance".into());
    name.push(".lock");
    db_path.with_file_name(name)
}

#[cfg(unix)]
fn try_lock_exclusive(file: &File) -> StorageResult<()> {
    use std::os::unix::io::AsRawFd;
    // LOCK_EX|LOCK_NB: advisory exclusive, never blocks, fails fast. Held by
    // the open descriptor for the entire Database lifetime.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        Ok(())
    } else {
        Err(StorageError::InstanceLocked)
    }
}

#[cfg(not(unix))]
fn try_lock_exclusive(_file: &File) -> StorageResult<()> {
    // Fail closed on platforms without the advisory-exclusive lock semantic.
    Err(StorageError::UnsafeConfiguration)
}

fn open_connection(db_path: &Path) -> StorageResult<Connection> {
    Connection::open(db_path).map_err(map_sqlite_error)
}

fn apply_and_verify_configuration(
    connection: &Connection,
) -> StorageResult<ConnectionConfiguration> {
    execute_pragma(connection, "journal_mode = WAL").map_err(map_sqlite_error)?;
    execute_pragma(connection, "synchronous = FULL").map_err(map_sqlite_error)?;
    execute_pragma(connection, "foreign_keys = ON").map_err(map_sqlite_error)?;
    execute_pragma(connection, "trusted_schema = OFF").map_err(map_sqlite_error)?;
    execute_pragma(connection, "busy_timeout = 5000").map_err(map_sqlite_error)?;

    let journal_mode: String =
        query_pragma(connection, "journal_mode").map_err(map_sqlite_error)?;
    let synchronous: i64 = query_pragma(connection, "synchronous").map_err(map_sqlite_error)?;
    let foreign_keys: i64 = query_pragma(connection, "foreign_keys").map_err(map_sqlite_error)?;
    let trusted_schema: i64 =
        query_pragma(connection, "trusted_schema").map_err(map_sqlite_error)?;
    let busy_timeout: i64 = query_pragma(connection, "busy_timeout").map_err(map_sqlite_error)?;

    ConnectionConfiguration::verify_with_trusted_schema(
        &journal_mode,
        synchronous,
        foreign_keys,
        trusted_schema,
        busy_timeout,
    )
}

/// Create/check the v1 physical schema and the diagnostic SQLite attestation.
/// A non-empty database with an unknown `user_version` is never repaired here;
/// it requires an explicit offline migration.
fn ensure_schema(connection: &Connection, verified: &VerifiedSqliteBuild) -> StorageResult<i64> {
    let object_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type IN ('table', 'index', 'trigger', 'view')",
            [],
            |row| row.get(0),
        )
        .map_err(map_sqlite_error)?;
    let user_version: i64 = query_pragma(connection, "user_version").map_err(map_sqlite_error)?;

    if object_count == 0 && user_version == 0 {
        let tx = connection
            .unchecked_transaction()
            .map_err(map_sqlite_error)?;
        tx.execute_batch(
            "CREATE TABLE core_meta (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                schema_version INTEGER NOT NULL,
                daemon_installation_id TEXT,
                instance_id TEXT,
                clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)),
                sqlite_version_number INTEGER NOT NULL,
                sqlite_source_id TEXT NOT NULL,
                sqlite_artifact_digest TEXT NOT NULL
            );
            CREATE TABLE commit_sequence (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                next_value INTEGER NOT NULL
            );",
        )
        .map_err(map_sqlite_error)?;
        tx.execute_batch(HOST_AUTHORITY_SCHEMA_SQL)
            .map_err(map_sqlite_error)?;
        tx.execute(
            "INSERT INTO core_meta (
                singleton, schema_version, daemon_installation_id, instance_id,
                clean_shutdown, sqlite_version_number, sqlite_source_id,
                sqlite_artifact_digest
             ) VALUES (1, ?1, NULL, NULL, 0, ?2, ?3, ?4)",
            rusqlite::params![
                SCHEMA_VERSION,
                verified.version_number as i64,
                &verified.source_id,
                verified.artifact_digest.to_string(),
            ],
        )
        .map_err(map_sqlite_error)?;
        tx.execute(
            "INSERT INTO commit_sequence (singleton, next_value) VALUES (1, 1)",
            [],
        )
        .map_err(map_sqlite_error)?;
        tx.execute_batch("PRAGMA user_version = 1")
            .map_err(map_sqlite_error)?;
        tx.commit().map_err(map_sqlite_error)?;
        return Ok(SCHEMA_VERSION);
    }

    if user_version != SCHEMA_VERSION {
        return Err(StorageError::MigrationRequired);
    }

    let required_columns = [
        "schema_version",
        "daemon_installation_id",
        "instance_id",
        "clean_shutdown",
        "sqlite_version_number",
        "sqlite_source_id",
        "sqlite_artifact_digest",
    ];
    let mut columns = std::collections::BTreeSet::new();
    let mut statement = connection
        .prepare("PRAGMA table_info(core_meta)")
        .map_err(map_sqlite_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(map_sqlite_error)?;
    for row in rows {
        columns.insert(row.map_err(map_sqlite_error)?);
    }
    if !required_columns
        .iter()
        .all(|column| columns.contains(*column))
    {
        return Err(StorageError::MigrationRequired);
    }

    let existing: Option<(i64, i64, String, String)> = connection
        .query_row(
            "SELECT schema_version, sqlite_version_number, sqlite_source_id,
                    sqlite_artifact_digest
             FROM core_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some((schema_version, version_number, source_id, artifact_digest)) = existing else {
        return Err(StorageError::Corrupt);
    };
    if schema_version != SCHEMA_VERSION {
        return Err(StorageError::MigrationRequired);
    }
    if version_number != verified.version_number as i64
        || source_id != verified.source_id
        || artifact_digest != verified.artifact_digest.to_string()
    {
        return Err(StorageError::Corrupt);
    }
    Ok(SCHEMA_VERSION)
}

fn verify_sqlite_integrity(connection: &Connection) -> StorageResult<()> {
    let quick_check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| StorageError::Corrupt)?;
    if quick_check != "ok" {
        return Err(StorageError::Corrupt);
    }

    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|_| StorageError::Corrupt)?;
    let mut rows = statement.query([]).map_err(|_| StorageError::Corrupt)?;
    if rows.next().map_err(|_| StorageError::Corrupt)?.is_some() {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

fn validate_authority_state(
    connection: &Connection,
) -> StorageResult<Option<RuntimeAuthorityIdentity>> {
    let host_schema_version: Option<i64> = connection
        .query_row(
            "SELECT authority_schema_version FROM host_authority_meta
             WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| StorageError::Corrupt)?;
    if host_schema_version != Some(crate::host_authority::HOST_AUTHORITY_SCHEMA_VERSION) {
        return Err(StorageError::Corrupt);
    }

    let core_identity: Option<(Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT daemon_installation_id, instance_id
             FROM core_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| StorageError::Corrupt)?;
    let core_identity = match core_identity {
        None => return Err(StorageError::Corrupt),
        Some((None, None)) => None,
        Some((Some(daemon_installation_id), Some(instance_id))) => Some(RuntimeAuthorityIdentity {
            daemon_installation_id,
            instance_id,
        }),
        Some(_) => return Err(StorageError::Corrupt),
    };

    let snapshot = load_current_authority(connection).map_err(map_host_authority_error)?;
    if core_identity.is_none() && snapshot.is_none() {
        let reachable_rows: i64 = connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM config_revision_mappings)
                  + (SELECT COUNT(*) FROM module_activation_premises)
                  + (SELECT COUNT(*) FROM module_activation_premise_policy_selections)",
                [],
                |row| row.get(0),
            )
            .map_err(|_| StorageError::Corrupt)?;
        if reachable_rows != 0 {
            return Err(StorageError::Corrupt);
        }
    }
    match (core_identity, snapshot) {
        (None, None) => Ok(None),
        (Some(_), None) => Err(StorageError::Corrupt),
        (None, Some(_)) => Err(StorageError::Corrupt),
        (Some(core), Some(snapshot)) => {
            let state_identity = RuntimeAuthorityIdentity {
                daemon_installation_id: snapshot.mapping.daemon_installation_id.clone(),
                instance_id: snapshot.mapping.instance_id.clone(),
            };
            if core != state_identity {
                return Err(StorageError::Corrupt);
            }
            Ok(Some(core))
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyAuthorityEnvelope {
    schema: String,
    identity: RuntimeAuthorityIdentity,
    mapping: ConfigRevisionMapping,
    #[serde(default)]
    premise: Option<ModuleActivationPremises>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyRuntimeConfig {
    schema: String,
    daemon_installation_id: String,
    instance_id: String,
    #[serde(default)]
    config_revision: Option<i64>,
    runtime_config: CanonicalJsonValue,
    #[serde(default)]
    permission_policy_selections: Vec<PermissionPolicySelection>,
    #[serde(default)]
    service_candidate: Option<LinuxServiceCandidate>,
    #[serde(default)]
    permission_policy_definitions: Vec<PermissionPolicyDefinition>,
    #[serde(default)]
    permission_policy_backend_bindings: Vec<PermissionPolicyBackendBinding>,
}

fn parse_legacy_authority(bytes: &[u8]) -> StorageResult<HostAuthorityRevision> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| StorageError::Corrupt)?;
    if value.get("mapping").is_some() {
        let envelope: LegacyAuthorityEnvelope =
            serde_json::from_value(value).map_err(|_| StorageError::Corrupt)?;
        if envelope.schema != "dolly.legacy-runtime-authority/v0" {
            return Err(StorageError::MigrationRequired);
        }
        return Ok(HostAuthorityRevision {
            identity: envelope.identity,
            mapping: envelope.mapping,
            premise: envelope.premise,
        });
    }

    let legacy: LegacyRuntimeConfig =
        serde_json::from_value(value).map_err(|_| StorageError::Corrupt)?;
    if legacy.schema != "dolly.legacy-runtime-config/v0" {
        return Err(StorageError::MigrationRequired);
    }
    let config = ResolvedConfiguration {
        runtime_config: legacy.runtime_config,
        permission_policy_selections: legacy.permission_policy_selections,
        service_candidate: legacy.service_candidate,
    };
    let config_digest = canonicalize(&config).map_err(|_| StorageError::Corrupt)?.1;
    let identity = RuntimeAuthorityIdentity {
        daemon_installation_id: legacy.daemon_installation_id,
        instance_id: legacy.instance_id,
    };
    let mapping = ConfigRevisionMapping {
        schema: "dolly.config-revision-mapping/v1".into(),
        daemon_installation_id: identity.daemon_installation_id.clone(),
        instance_id: identity.instance_id.clone(),
        config_revision: legacy.config_revision.unwrap_or(1),
        config_digest: config_digest.clone(),
        canonical_config: config.clone(),
    };
    let premise = match config.service_candidate.clone() {
        Some(service_candidate) => {
            let zero_digest = Sha256Digest::from_str(
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            )
            .map_err(|_| StorageError::Corrupt)?;
            let mut premise = ModuleActivationPremises {
                schema: "dolly.module-activation-premises/v1".into(),
                daemon_installation_id: identity.daemon_installation_id.clone(),
                instance_id: identity.instance_id.clone(),
                config_revision: mapping.config_revision,
                config_digest,
                permission_policy_definitions: legacy.permission_policy_definitions,
                permission_policy_backend_bindings: legacy.permission_policy_backend_bindings,
                service_candidate,
                premises_digest: zero_digest,
            };
            premise.premises_digest = canonical_digest_without(&premise, "premises_digest")?;
            Some(premise)
        }
        None if !config.permission_policy_selections.is_empty() => {
            return Err(StorageError::Corrupt);
        }
        None => None,
    };
    Ok(HostAuthorityRevision {
        identity,
        mapping,
        premise,
    })
}

fn canonical_digest_without<T: Serialize>(value: &T, field: &str) -> StorageResult<Sha256Digest> {
    let mut json = serde_json::to_value(value).map_err(|_| StorageError::Corrupt)?;
    let serde_json::Value::Object(object) = &mut json else {
        return Err(StorageError::Corrupt);
    };
    object.remove(field);
    canonicalize(&json)
        .map_err(|_| StorageError::Corrupt)
        .map(|(_, digest)| digest)
}

fn map_host_authority_error(error: HostAuthorityError) -> StorageError {
    match error {
        HostAuthorityError::Storage(error) => match error {
            rusqlite::Error::SqliteFailure(inner, _) => {
                use rusqlite::ErrorCode;
                match inner.code {
                    ErrorCode::DatabaseBusy => StorageError::Busy,
                    ErrorCode::DiskFull => StorageError::Full,
                    _ => StorageError::Corrupt,
                }
            }
            _ => StorageError::Corrupt,
        },
        _ => StorageError::Corrupt,
    }
}

fn execute_pragma(connection: &Connection, pragma: &str) -> rusqlite::Result<()> {
    connection.execute_batch(&format!("PRAGMA {pragma};"))
}

fn query_pragma<T: rusqlite::types::FromSql>(
    connection: &Connection,
    pragma: &str,
) -> rusqlite::Result<T> {
    connection.query_row(&format!("PRAGMA {pragma};"), [], |row| row.get(0))
}

pub(crate) fn map_sqlite_error(error: rusqlite::Error) -> StorageError {
    use rusqlite::{Error, ErrorCode};
    match error {
        Error::SqliteFailure(inner, _) => match inner.code {
            ErrorCode::DatabaseBusy => StorageError::Busy,
            ErrorCode::DiskFull => StorageError::Full,
            ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt => StorageError::Corrupt,
            _ => StorageError::UnsafeConfiguration,
        },
        _ => StorageError::UnsafeConfiguration,
    }
}

fn map_io_error(_error: io::Error) -> StorageError {
    // Open-time filesystem failures refuse the instance (fail-closed); no
    // dedicated code exists for path I/O, so configuration is the closest
    // safe fail-closed mapping and it is never retryable.
    StorageError::UnsafeConfiguration
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_verify_accepts_mandated_values() {
        let config = ConnectionConfiguration::verify("wal", 2, 1, 5000).expect("must pass");
        assert_eq!(config.journal_mode, "wal");
        assert_eq!(config.busy_timeout, 5000);
    }

    #[test]
    fn configuration_verify_rejects_each_deviation() {
        assert!(matches!(
            ConnectionConfiguration::verify("delete", 2, 1, 5000),
            Err(StorageError::UnsafeConfiguration)
        ));
        assert!(matches!(
            ConnectionConfiguration::verify("wal", 1, 1, 5000),
            Err(StorageError::UnsafeConfiguration)
        ));
        assert!(matches!(
            ConnectionConfiguration::verify("wal", 2, 0, 5000),
            Err(StorageError::UnsafeConfiguration)
        ));
        assert!(matches!(
            ConnectionConfiguration::verify("wal", 2, 1, 4000),
            Err(StorageError::UnsafeConfiguration)
        ));
    }

    #[test]
    #[cfg(unix)]
    fn reject_symlink_components_finds_nested_link() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        fs::create_dir(&real).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let target = link.join("db.sqlite");
        assert!(matches!(
            reject_symlink_components(&target),
            Err(StorageError::UnsafeConfiguration)
        ));
    }

    #[test]
    fn reject_symlink_components_allows_plain_paths() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        assert!(reject_symlink_components(&dir.path().join("nested/db.sqlite")).is_ok());
    }
}
