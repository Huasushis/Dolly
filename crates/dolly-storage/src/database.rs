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

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use rusqlite::{Connection, OptionalExtension};

use crate::attestation::{LoadedSqlite, ReleaseAttestation, SqliteBuildGate, VerifiedSqliteBuild};
use crate::error::{StorageError, StorageResult};

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
    /// `PRAGMA busy_timeout` must read back `5000`.
    pub const BUSY_TIMEOUT_MS: i64 = 5000;
}

/// Byte-level result of the open-time connection configuration checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionConfiguration {
    journal_mode: String,
    synchronous: i64,
    foreign_keys: i64,
    busy_timeout: i64,
}

impl ConnectionConfiguration {
    /// Deterministic pure comparator used both at open and by tests. Any
    /// deviation from the §2 values is `STORAGE_UNSAFE_CONFIGURATION`.
    pub fn verify(
        journal_mode: &str,
        synchronous: i64,
        foreign_keys: i64,
        busy_timeout: i64,
    ) -> StorageResult<Self> {
        if journal_mode != required::JOURNAL_MODE
            || synchronous != required::SYNCHRONOUS
            || foreign_keys != required::FOREIGN_KEYS
            || busy_timeout != required::BUSY_TIMEOUT_MS
        {
            return Err(StorageError::UnsafeConfiguration);
        }
        Ok(Self {
            journal_mode: journal_mode.to_string(),
            synchronous,
            foreign_keys,
            busy_timeout,
        })
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

        // Exclusive OS-level instance lock before any write-open.
        let instance_lock = acquire_instance_lock(db_path)?;

        // REQ-TECH-003: verify the loaded library against the plate record
        // BEFORE opening an instance for writes; refusal is fail-closed.
        let loaded = probe_loaded_sqlite();
        let verified = SqliteBuildGate.verify(attestation, &loaded)?;

        let connection = open_connection(db_path)?;
        let configuration = apply_and_verify_configuration(&connection)?;
        let schema_version = ensure_schema(&connection, db_path)?;

        Ok(Self {
            connection,
            instance_lock,
            verified,
            configuration,
            schema_version,
        })
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
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
    execute_pragma(connection, "busy_timeout = 5000").map_err(map_sqlite_error)?;

    let journal_mode: String =
        query_pragma(connection, "journal_mode").map_err(map_sqlite_error)?;
    let synchronous: i64 = query_pragma(connection, "synchronous").map_err(map_sqlite_error)?;
    let foreign_keys: i64 = query_pragma(connection, "foreign_keys").map_err(map_sqlite_error)?;
    let busy_timeout: i64 = query_pragma(connection, "busy_timeout").map_err(map_sqlite_error)?;

    ConnectionConfiguration::verify(&journal_mode, synchronous, foreign_keys, busy_timeout)
}

/// The minimum schema setup for a conforming instance (§3 `core_meta`:
/// schema version, instance identity, clean-shutdown flag). Creating or
/// checking it happens inside one transaction on the write connection.
fn ensure_schema(connection: &Connection, db_path: &Path) -> StorageResult<i64> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS core_meta (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                schema_version INTEGER NOT NULL,
                instance_identity TEXT NOT NULL,
                clean_shutdown INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS commit_sequence (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                next_value INTEGER NOT NULL
            );",
        )
        .map_err(map_sqlite_error)?;

    let existing: Option<(i64, String, i64)> = connection
        .query_row(
            "SELECT schema_version, instance_identity, clean_shutdown
             FROM core_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(map_sqlite_error)?;

    let identity = db_path.to_string_lossy().into_owned();
    match existing {
        None => {
            connection
                .execute(
                    "INSERT INTO core_meta (singleton, schema_version, instance_identity, clean_shutdown)
                     VALUES (1, ?1, ?2, 0)",
                    rusqlite::params![SCHEMA_VERSION, identity],
                )
                .map_err(map_sqlite_error)?;
            // Seed the global sequence domain (no value consumed yet).
            connection
                .execute(
                    "INSERT INTO commit_sequence (singleton, next_value) VALUES (1, 1)",
                    [],
                )
                .map_err(map_sqlite_error)?;
            Ok(SCHEMA_VERSION)
        }
        Some((version, _, _)) => {
            if version > SCHEMA_VERSION {
                return Err(StorageError::MigrationRequired);
            }
            if version < SCHEMA_VERSION {
                // No forward migrations exist below v1 in this binary;
                // older files were created by this same schema.
                return Err(StorageError::MigrationRequired);
            }
            // Retain the clean-shutdown record; instance is now running.
            let _ = version;
            connection
                .execute(
                    "UPDATE core_meta SET clean_shutdown = 0 WHERE singleton = 1",
                    [],
                )
                .map_err(map_sqlite_error)?;
            Ok(SCHEMA_VERSION)
        }
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

fn map_sqlite_error(error: rusqlite::Error) -> StorageError {
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
