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
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};

use crate::attestation::{LoadedSqlite, ReleaseAttestation, SqliteBuildGate, VerifiedSqliteBuild};
use crate::error::{StorageError, StorageResult};
use crate::host_authority::{
    ConfigRevisionMapping, HOST_AUTHORITY_SCHEMA_SQL, HostAuthorityError, HostAuthorityRevision,
    LinuxServiceCandidate, ModuleActivationPremises, PermissionPolicyBackendBinding,
    PermissionPolicyDefinition, PermissionPolicySelection, ResolvedConfiguration,
    RuntimeAuthorityIdentity, install_host_authority_revision_in_transaction,
    load_current_authority_with_generation, refresh_controller_generation_in_transaction,
    validate_revision,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControllerLockOwner {
    daemon_installation_id: String,
    instance_id: String,
    controller_generation_id: String,
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

/// An opened, verified, write-capable storage instance with a committed
/// authority identity. Empty/uninitialized databases cannot be represented by
/// this public type.
#[derive(Debug)]
pub struct Database {
    connection: Option<Connection>,
    #[allow(dead_code)]
    db_path: PathBuf,
    #[allow(dead_code)]
    identity_lock: Option<File>,
    #[allow(dead_code)]
    path_lock: File,
    verified: VerifiedSqliteBuild,
    configuration: Option<ConnectionConfiguration>,
    schema_version: i64,
    authority_identity: Option<RuntimeAuthorityIdentity>,
    controller_generation_id: Option<String>,
}

/// A private, inert migration handle. It carries no SQLite connection or
/// lock descriptor; setup begins only after the legacy authority bytes have
/// parsed and passed complete validation.
#[derive(Debug)]
pub struct OfflineDatabase {
    db_path: PathBuf,
    attestation: ReleaseAttestation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ArtifactIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(not(unix))]
    length: u64,
}

#[derive(Debug)]
struct ArtifactState {
    bytes: Vec<u8>,
    identity: ArtifactIdentity,
    #[cfg(unix)]
    mode: u32,
    #[cfg(unix)]
    uid: u32,
    #[cfg(unix)]
    gid: u32,
    #[cfg(unix)]
    atime_seconds: i64,
    #[cfg(unix)]
    atime_nanoseconds: i64,
    #[cfg(unix)]
    mtime_seconds: i64,
    #[cfg(unix)]
    mtime_nanoseconds: i64,
}

#[derive(Debug)]
struct ArtifactSnapshot {
    path: PathBuf,
    before: Option<ArtifactState>,
    created_identity: Option<ArtifactIdentity>,
    remove_created: bool,
}

impl ArtifactSnapshot {
    fn capture(path: PathBuf, remove_created: bool) -> StorageResult<Self> {
        Ok(Self {
            before: capture_artifact_state(&path)?,
            path,
            created_identity: None,
            remove_created,
        })
    }

    fn note_created(&mut self) {
        if self.before.is_none() && self.created_identity.is_none() {
            self.created_identity = current_artifact_identity(&self.path);
        }
    }

    fn restore(&self) -> StorageResult<()> {
        reject_symlink_components(&self.path)?;
        match (&self.before, self.created_identity) {
            (None, Some(identity)) if self.remove_created => {
                match current_artifact_identity(&self.path) {
                    None => Ok(()),
                    Some(current) if current == identity => {
                        fs::remove_file(&self.path).map_err(map_io_error)
                    }
                    Some(_) => Err(StorageError::UnsafeConfiguration),
                }
            }
            (None, Some(_)) | (None, None) => Ok(()),
            (Some(state), _) => match current_artifact_identity(&self.path) {
                Some(current) if current == state.identity => {
                    restore_artifact_state(&self.path, state)
                }
                Some(_) | None => Err(StorageError::UnsafeConfiguration),
            },
        }
    }
}

struct MigrationCleanup {
    database: ArtifactSnapshot,
    database_wal: ArtifactSnapshot,
    database_shm: ArtifactSnapshot,
    database_journal: ArtifactSnapshot,
    path_lock: ArtifactSnapshot,
    identity_lock: ArtifactSnapshot,
    database_active: bool,
    path_lock_active: bool,
    identity_lock_active: bool,
    committed: bool,
    restored: bool,
}

impl MigrationCleanup {
    fn capture(
        database_path: &Path,
        path_lock_path: &Path,
        identity_lock_path: &Path,
    ) -> StorageResult<Self> {
        Ok(Self {
            database: ArtifactSnapshot::capture(database_path.to_path_buf(), true)?,
            database_wal: ArtifactSnapshot::capture(
                sqlite_sidecar_path(database_path, "-wal"),
                true,
            )?,
            database_shm: ArtifactSnapshot::capture(
                sqlite_sidecar_path(database_path, "-shm"),
                true,
            )?,
            database_journal: ArtifactSnapshot::capture(
                sqlite_sidecar_path(database_path, "-journal"),
                true,
            )?,
            path_lock: ArtifactSnapshot::capture(path_lock_path.to_path_buf(), false)?,
            identity_lock: ArtifactSnapshot::capture(identity_lock_path.to_path_buf(), false)?,
            database_active: false,
            path_lock_active: false,
            identity_lock_active: false,
            committed: false,
            restored: false,
        })
    }

    fn note_path_lock_created(&mut self, created: bool) {
        if created {
            self.path_lock_active = true;
            self.path_lock.note_created();
        }
    }

    fn note_identity_lock_created(&mut self, created: bool) {
        if created {
            self.identity_lock_active = true;
            self.identity_lock.note_created();
        }
    }

    fn begin_database(&mut self) {
        self.database_active = true;
    }

    fn note_database_artifacts(&mut self) {
        if !self.database_active {
            return;
        }
        self.database.note_created();
        self.database_wal.note_created();
        self.database_shm.note_created();
        self.database_journal.note_created();
    }

    fn note_all_created(&mut self) {
        self.note_database_artifacts();
        if self.path_lock_active {
            self.path_lock.note_created();
        }
        if self.identity_lock_active {
            self.identity_lock.note_created();
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }

    fn restore(&mut self) -> StorageResult<()> {
        if self.committed || self.restored {
            return Ok(());
        }
        self.restored = true;
        self.note_all_created();
        let restorations = [
            self.database_journal.restore(),
            self.database_shm.restore(),
            self.database_wal.restore(),
            self.database.restore(),
            self.identity_lock.restore(),
            self.path_lock.restore(),
        ];
        let mut first_error = None;
        for result in restorations {
            if let Err(error) = result {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn fail(&mut self, primary: StorageError) -> StorageError {
        if let Err(cleanup_error) = self.restore() {
            eprintln!("authority cleanup refused: {cleanup_error}");
        }
        primary
    }
}

impl Drop for MigrationCleanup {
    fn drop(&mut self) {
        if !self.committed && !self.restored {
            if let Err(error) = self.restore() {
                eprintln!("authority cleanup refused: {error}");
            }
        }
    }
}

impl Database {
    /// Open an existing committed authority database.
    pub fn open(db_path: &Path) -> StorageResult<Self> {
        Self::open_with(db_path, &crate::attestation::release_attestation())
    }

    /// Open an existing committed authority database using an explicit
    /// attestation (tests and release instrumenting use this).
    pub fn open_with(db_path: &Path, attestation: &ReleaseAttestation) -> StorageResult<Self> {
        open_internal(db_path, attestation).map(|database| database)
    }

    /// Open the smallest explicit offline handle used to initialize/migrate
    /// an empty database. The handle has no public connection surface and
    /// performs no SQLite or lock setup until migration input is validated.
    pub fn open_for_migration(db_path: &Path) -> StorageResult<OfflineDatabase> {
        Self::open_for_migration_with(db_path, &crate::attestation::release_attestation())
    }

    pub fn open_for_migration_with(
        db_path: &Path,
        attestation: &ReleaseAttestation,
    ) -> StorageResult<OfflineDatabase> {
        Ok(OfflineDatabase {
            db_path: db_path.to_path_buf(),
            attestation: attestation.clone(),
        })
    }

    pub fn connection(&self) -> &Connection {
        self.connection
            .as_ref()
            .expect("ordinary Database always has a private SQLite connection")
    }

    /// Mutable access to the single writer connection. This method is only
    /// reachable after a committed authority identity has been verified.
    pub fn connection_mut(&mut self) -> &mut Connection {
        self.connection
            .as_mut()
            .expect("ordinary Database always has a private SQLite connection")
    }

    pub fn configuration(&self) -> &ConnectionConfiguration {
        self.configuration
            .as_ref()
            .expect("ordinary Database always has configured SQLite pragmas")
    }

    pub fn schema_version(&self) -> i64 {
        self.schema_version
    }

    pub fn verified_build(&self) -> &VerifiedSqliteBuild {
        &self.verified
    }

    pub fn authority_identity(&self) -> &RuntimeAuthorityIdentity {
        self.authority_identity
            .as_ref()
            .expect("ordinary Database always has committed authority identity")
    }
    pub fn controller_generation_id(&self) -> &str {
        self.controller_generation_id
            .as_deref()
            .expect("ordinary Database always has a fresh controller generation")
    }
}

fn open_migration_database(
    db_path: &Path,
    attestation: &ReleaseAttestation,
    cleanup: &mut MigrationCleanup,
) -> StorageResult<Database> {
    reject_symlink_components(db_path)?;
    let path_lock_path = instance_lock_path(db_path);
    reject_symlink_components(&path_lock_path)?;
    let loaded = probe_loaded_sqlite();
    let verified = SqliteBuildGate.verify(attestation, &loaded)?;
    let (path_lock, path_lock_created) = acquire_lock_file_with_creation(&path_lock_path)?;
    cleanup.note_path_lock_created(path_lock_created);
    if read_persisted_identity(db_path)?.is_some() {
        return Err(StorageError::MigrationRequired);
    }
    if lock_owner(&path_lock)?.is_some() {
        return Err(StorageError::Corrupt);
    }
    Ok(Database {
        db_path: db_path.to_path_buf(),
        connection: None,
        identity_lock: None,
        path_lock,
        verified,
        configuration: None,
        schema_version: 0,
        authority_identity: None,
        controller_generation_id: None,
    })
}

impl OfflineDatabase {
    /// Import one legacy JSON document in one immediate transaction, then
    /// consume the offline handle into the ordinary writable Database type.
    pub fn migrate_legacy_json(self, bytes: &[u8]) -> StorageResult<Database> {
        let input = parse_legacy_authority(bytes)?;
        validate_revision(&input).map_err(map_host_authority_error)?;

        let path_lock_path = instance_lock_path(&self.db_path);
        reject_symlink_components(&self.db_path)?;
        reject_symlink_components(&path_lock_path)?;
        if read_persisted_identity(&self.db_path)?.is_some() {
            return Err(StorageError::MigrationRequired);
        }

        let identity_lock_path = canonical_identity_lock_path(&input.identity);
        reject_symlink_components(&identity_lock_path)?;
        let mut cleanup =
            MigrationCleanup::capture(&self.db_path, &path_lock_path, &identity_lock_path)?;
        let result = (|| -> StorageResult<Database> {
            let mut database =
                open_migration_database(&self.db_path, &self.attestation, &mut cleanup)?;

            let controller_generation_id = mint_controller_generation_id()?;
            let (identity_lock, identity_lock_created) =
                acquire_identity_lock_with_creation(&input.identity)?;
            cleanup.note_identity_lock_created(identity_lock_created);
            verify_or_write_lock_owner(&identity_lock, &input.identity, &controller_generation_id)?;
            cleanup.begin_database();
            let connection = match open_connection(&database.db_path) {
                Ok(connection) => connection,
                Err(error) => {
                    cleanup.note_database_artifacts();
                    return Err(error);
                }
            };
            cleanup.note_database_artifacts();
            let configuration = match apply_and_verify_configuration(&connection) {
                Ok(configuration) => configuration,
                Err(error) => {
                    cleanup.note_database_artifacts();
                    return Err(error);
                }
            };
            cleanup.note_database_artifacts();
            database.configuration = Some(configuration);
            database.connection = Some(connection);

            let connection = database
                .connection
                .as_mut()
                .expect("offline migration connection");
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sqlite_error)?;
            create_fresh_schema(&tx, &database.verified)?;
            tx.execute(
                "UPDATE core_meta SET controller_generation_id = ?1 WHERE singleton = 1",
                [&controller_generation_id],
            )
            .map_err(map_sqlite_error)?;
            let disposition = install_host_authority_revision_in_transaction(&tx, &input)
                .map_err(map_host_authority_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            let _ = disposition;
            database.schema_version = SCHEMA_VERSION;
            verify_or_write_lock_owner(
                &database.path_lock,
                &input.identity,
                &controller_generation_id,
            )?;
            database.identity_lock = Some(identity_lock);
            database.authority_identity = Some(input.identity);
            database.controller_generation_id = Some(controller_generation_id);
            Ok(database)
        })();

        match result {
            Ok(database) => {
                cleanup.commit();
                Ok(database)
            }
            Err(error) => Err(cleanup.fail(error)),
        }
    }

    /// Install an already validated Host producer revision while the
    /// database is still in the explicit offline bootstrap mode.
    pub fn install_host_authority_revision(
        self,
        input: HostAuthorityRevision,
    ) -> StorageResult<Database> {
        #[derive(Serialize)]
        struct LegacyAuthorityEnvelope<'a> {
            schema: &'static str,
            identity: &'a RuntimeAuthorityIdentity,
            mapping: &'a ConfigRevisionMapping,
            premise: &'a Option<ModuleActivationPremises>,
        }
        let envelope = LegacyAuthorityEnvelope {
            schema: "dolly.legacy-runtime-authority/v0",
            identity: &input.identity,
            mapping: &input.mapping,
            premise: &input.premise,
        };
        let bytes = serde_json::to_vec(&envelope).map_err(|_| StorageError::Corrupt)?;
        self.migrate_legacy_json(&bytes)
    }
}

fn open_internal(db_path: &Path, attestation: &ReleaseAttestation) -> StorageResult<Database> {
    reject_symlink_components(db_path)?;
    let path_lock_path = instance_lock_path(db_path);
    reject_symlink_components(&path_lock_path)?;

    let loaded = probe_loaded_sqlite();
    let verified = SqliteBuildGate.verify(attestation, &loaded)?;
    let expected_identity =
        read_persisted_identity(db_path)?.ok_or(StorageError::MigrationRequired)?;
    let identity_lock_path = canonical_identity_lock_path(&expected_identity.0);
    reject_symlink_components(&identity_lock_path)?;
    let mut cleanup = MigrationCleanup::capture(db_path, &path_lock_path, &identity_lock_path)?;
    let result = (|| -> StorageResult<Database> {
        let (path_lock, path_lock_created) = acquire_lock_file_with_creation(&path_lock_path)?;
        cleanup.note_path_lock_created(path_lock_created);

        let current_identity =
            read_persisted_identity(db_path)?.ok_or(StorageError::MigrationRequired)?;
        if current_identity != expected_identity {
            return Err(StorageError::Corrupt);
        }

        let (identity_lock, identity_lock_created) =
            acquire_identity_lock_with_creation(&expected_identity.0)?;
        cleanup.note_identity_lock_created(identity_lock_created);
        let controller_generation_id = mint_controller_generation_id()?;
        verify_or_write_lock_owner(
            &identity_lock,
            &expected_identity.0,
            &controller_generation_id,
        )?;
        verify_or_write_lock_owner(&path_lock, &expected_identity.0, &controller_generation_id)?;

        cleanup.begin_database();
        let connection = open_connection(db_path)?;
        cleanup.note_database_artifacts();
        let configuration = apply_and_verify_configuration(&connection)?;
        cleanup.note_database_artifacts();
        let schema_version = ensure_schema(&connection, &verified)?;
        verify_sqlite_integrity(&connection)?;
        let authority_identity =
            validate_authority_state(&connection)?.ok_or(StorageError::MigrationRequired)?;
        let persisted_generation = read_controller_generation(&connection)?;
        if authority_identity != expected_identity.0.clone()
            || persisted_generation != Some(expected_identity.1.clone())
        {
            return Err(StorageError::Corrupt);
        }
        let mut connection = connection;
        refresh_controller_generation(&mut connection, &controller_generation_id)?;
        Ok(Database {
            db_path: db_path.to_path_buf(),
            connection: Some(connection),
            identity_lock: Some(identity_lock),
            path_lock,
            verified,
            configuration: Some(configuration),
            schema_version,
            authority_identity: Some(expected_identity.0.clone()),
            controller_generation_id: Some(controller_generation_id),
        })
    })();

    match result {
        Ok(database) => {
            cleanup.commit();
            Ok(database)
        }
        Err(error) => Err(cleanup.fail(error)),
    }
}

fn read_persisted_identity(
    db_path: &Path,
) -> StorageResult<Option<(RuntimeAuthorityIdentity, String)>> {
    let metadata = match fs::metadata(db_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(StorageError::UnsafeConfiguration),
    };
    if metadata.len() == 0 {
        return Ok(None);
    }

    let connection = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| StorageError::MigrationRequired)?;
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| StorageError::MigrationRequired)?;
    if user_version != SCHEMA_VERSION {
        return Err(StorageError::MigrationRequired);
    }

    let core_identity: Option<(Option<String>, Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT daemon_installation_id, instance_id, controller_generation_id
             FROM core_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| StorageError::MigrationRequired)?;
    let Some((daemon, instance, generation)) = core_identity else {
        return Err(StorageError::MigrationRequired);
    };
    let (core, generation) = match (daemon, instance, generation) {
        (Some(daemon_installation_id), Some(instance_id), Some(generation))
            if !generation.is_empty() =>
        {
            (
                RuntimeAuthorityIdentity {
                    daemon_installation_id,
                    instance_id,
                },
                generation,
            )
        }
        (None, None, None) => return Ok(None),
        _ => return Err(StorageError::Corrupt),
    };
    let state_identity: Option<(String, String, String)> = connection
        .query_row(
            "SELECT daemon_installation_id, instance_id, controller_generation_id
             FROM runtime_authority_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| StorageError::Corrupt)?;
    let Some((state_daemon, state_instance, state_generation)) = state_identity else {
        return Err(StorageError::Corrupt);
    };
    if core.daemon_installation_id != state_daemon
        || core.instance_id != state_instance
        || generation != state_generation
    {
        return Err(StorageError::Corrupt);
    }
    Ok(Some((core, generation)))
}
fn read_controller_generation(connection: &Connection) -> StorageResult<Option<String>> {
    connection
        .query_row(
            "SELECT controller_generation_id FROM core_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite_error)
        .and_then(|generation: Option<Option<String>>| match generation {
            Some(Some(generation)) if !generation.is_empty() => Ok(Some(generation)),
            Some(None) => Ok(None),
            None => Err(StorageError::Corrupt),
            Some(Some(_)) => Err(StorageError::Corrupt),
        })
}

fn refresh_controller_generation(
    connection: &mut Connection,
    generation: &str,
) -> StorageResult<()> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sqlite_error)?;
    tx.execute(
        "UPDATE core_meta SET controller_generation_id = ?1 WHERE singleton = 1",
        [generation],
    )
    .map_err(map_sqlite_error)?;
    refresh_controller_generation_in_transaction(&tx, generation)
        .map_err(map_host_authority_error)?;
    tx.commit().map_err(map_sqlite_error)
}

fn mint_controller_generation_id() -> StorageResult<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| StorageError::UnsafeConfiguration)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    ))
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

fn sqlite_sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut value = database_path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn artifact_identity(metadata: &fs::Metadata) -> ArtifactIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ArtifactIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
    #[cfg(not(unix))]
    {
        ArtifactIdentity {
            length: metadata.len(),
        }
    }
}

fn current_artifact_identity(path: &Path) -> Option<ArtifactIdentity> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| artifact_identity(&metadata))
}

fn capture_artifact_state(path: &Path) -> StorageResult<Option<ArtifactState>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(map_io_error(error)),
    };
    if !metadata.is_file() {
        return Err(StorageError::UnsafeConfiguration);
    }
    let bytes = fs::read(path).map_err(map_io_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Some(ArtifactState {
            bytes,
            identity: artifact_identity(&metadata),
            mode: metadata.mode() & 0o7777,
            uid: metadata.uid(),
            gid: metadata.gid(),
            atime_seconds: metadata.atime(),
            atime_nanoseconds: metadata.atime_nsec(),
            mtime_seconds: metadata.mtime(),
            mtime_nanoseconds: metadata.mtime_nsec(),
        }))
    }
    #[cfg(not(unix))]
    {
        Ok(Some(ArtifactState {
            bytes,
            identity: artifact_identity(&metadata),
        }))
    }
}

fn restore_artifact_state(path: &Path, state: &ArtifactState) -> StorageResult<()> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(false).truncate(true);
    #[cfg(unix)]
    {
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = options.open(path).map_err(map_io_error)?;
    let current_identity = artifact_identity(&file.metadata().map_err(map_io_error)?);
    if current_identity != state.identity {
        return Err(StorageError::UnsafeConfiguration);
    }
    file.write_all(&state.bytes).map_err(map_io_error)?;
    file.sync_all().map_err(map_io_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let fd = file.as_raw_fd();
        unsafe {
            if libc::fchown(fd, state.uid, state.gid) != 0 {
                return Err(map_io_error(io::Error::last_os_error()));
            }
            if libc::fchmod(fd, state.mode) != 0 {
                return Err(map_io_error(io::Error::last_os_error()));
            }
            let times = [
                libc::timespec {
                    tv_sec: state.atime_seconds as libc::time_t,
                    tv_nsec: state.atime_nanoseconds as libc::c_long,
                },
                libc::timespec {
                    tv_sec: state.mtime_seconds as libc::time_t,
                    tv_nsec: state.mtime_nanoseconds as libc::c_long,
                },
            ];
            if libc::futimens(fd, times.as_ptr()) != 0 {
                return Err(map_io_error(io::Error::last_os_error()));
            }
        }
    }
    file.sync_all().map_err(map_io_error)?;
    Ok(())
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
                break;
            }
            Err(e) => {
                return Err(map_io_error(e));
            }
        }
    }
    Ok(())
}
fn verify_lock_path_binding(lock_path: &Path, file: &File) -> StorageResult<()> {
    let path_metadata = fs::symlink_metadata(lock_path).map_err(map_io_error)?;
    if !path_metadata.is_file() {
        return Err(StorageError::UnsafeConfiguration);
    }
    let file_metadata = file.metadata().map_err(map_io_error)?;
    if artifact_identity(&path_metadata) != artifact_identity(&file_metadata) {
        return Err(StorageError::UnsafeConfiguration);
    }
    Ok(())
}

fn acquire_lock_file_with_creation(lock_path: &Path) -> StorageResult<(File, bool)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let mut create = OpenOptions::new();
        create
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let (file, created) = match create.open(lock_path) {
            Ok(file) => (file, true),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let mut open = OpenOptions::new();
                open.read(true)
                    .write(true)
                    .create(false)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
                (open.open(lock_path).map_err(map_io_error)?, false)
            }
            Err(error) => return Err(map_io_error(error)),
        };
        let meta = file.metadata().map_err(map_io_error)?;
        if !meta.is_file()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o7777 != 0o600
        {
            return Err(StorageError::UnsafeConfiguration);
        }
        verify_lock_path_binding(lock_path, &file)?;
        try_lock_exclusive(&file)?;
        verify_lock_path_binding(lock_path, &file)?;
        Ok((file, created))
    }
    #[cfg(not(unix))]
    {
        let _ = lock_path;
        Err(StorageError::UnsafeConfiguration)
    }
}

fn acquire_identity_lock_with_creation(
    identity: &RuntimeAuthorityIdentity,
) -> StorageResult<(File, bool)> {
    let lock_path = identity_lock_path(identity)?;
    reject_symlink_components(&lock_path)?;
    acquire_lock_file_with_creation(&lock_path)
}

fn canonical_identity_lock_path(identity: &RuntimeAuthorityIdentity) -> PathBuf {
    #[cfg(unix)]
    {
        let uid = unsafe { libc::geteuid() };
        let digest = canonicalize(identity)
            .expect("runtime identity is canonical JSON")
            .1
            .to_string()
            .replace(':', "-");
        PathBuf::from(format!(
            "/run/user/{uid}/dolly/runtime-authority/controller-{digest}.lock"
        ))
    }
    #[cfg(not(unix))]
    {
        let _ = identity;
        PathBuf::new()
    }
}

fn identity_lock_path(identity: &RuntimeAuthorityIdentity) -> StorageResult<PathBuf> {
    #[cfg(unix)]
    {
        let uid = unsafe { libc::geteuid() };
        let runtime_root = PathBuf::from(format!("/run/user/{uid}"));
        validate_private_runtime_dir(&runtime_root, false)?;
        let dolly_root = runtime_root.join("dolly");
        validate_private_runtime_dir(&dolly_root, true)?;
        let lock_root = dolly_root.join("runtime-authority");
        validate_private_runtime_dir(&lock_root, true)?;
        Ok(canonical_identity_lock_path(identity))
    }
    #[cfg(not(unix))]
    {
        let _ = identity;
        Err(StorageError::UnsafeConfiguration)
    }
}

#[cfg(unix)]
fn validate_private_runtime_dir(path: &Path, create: bool) -> StorageResult<()> {
    use std::os::unix::fs::MetadataExt;
    if create {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        match builder.create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => {
                return Err(StorageError::UnsafeConfiguration);
            }
        }
    }
    reject_symlink_components(path)?;
    let metadata = fs::metadata(path).map_err(map_io_error)?;
    if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(StorageError::UnsafeConfiguration);
    }
    if metadata.mode() & 0o7777 != 0o700 {
        return Err(StorageError::UnsafeConfiguration);
    }
    Ok(())
}

fn lock_owner(file: &File) -> StorageResult<Option<ControllerLockOwner>> {
    let mut clone = file.try_clone().map_err(map_io_error)?;
    clone.seek(SeekFrom::Start(0)).map_err(map_io_error)?;
    let mut bytes = Vec::new();
    clone.read_to_end(&mut bytes).map_err(map_io_error)?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| StorageError::Corrupt)?;
    if value.get("controller_generation_id").is_some() {
        serde_json::from_value(value)
            .map(Some)
            .map_err(|_| StorageError::Corrupt)
    } else {
        let identity: RuntimeAuthorityIdentity =
            serde_json::from_value(value).map_err(|_| StorageError::Corrupt)?;
        Ok(Some(ControllerLockOwner {
            daemon_installation_id: identity.daemon_installation_id,
            instance_id: identity.instance_id,
            controller_generation_id: String::new(),
        }))
    }
}

fn verify_or_write_lock_owner(
    file: &File,
    expected: &RuntimeAuthorityIdentity,
    generation: &str,
) -> StorageResult<()> {
    if let Some(owner) = lock_owner(file)? {
        if owner.daemon_installation_id != expected.daemon_installation_id
            || owner.instance_id != expected.instance_id
        {
            return Err(StorageError::Corrupt);
        }
    }
    let mut clone = file.try_clone().map_err(map_io_error)?;
    clone.set_len(0).map_err(map_io_error)?;
    clone.seek(SeekFrom::Start(0)).map_err(map_io_error)?;
    let owner = ControllerLockOwner {
        daemon_installation_id: expected.daemon_installation_id.clone(),
        instance_id: expected.instance_id.clone(),
        controller_generation_id: generation.to_string(),
    };
    let bytes = serde_json::to_vec(&owner).map_err(|_| StorageError::Corrupt)?;
    clone.write_all(&bytes).map_err(map_io_error)?;
    clone.write_all(b"\n").map_err(map_io_error)?;
    clone.sync_data().map_err(map_io_error)?;
    Ok(())
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
        create_fresh_schema(&tx, verified)?;
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
        "controller_generation_id",
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
fn create_fresh_schema(
    tx: &rusqlite::Transaction<'_>,
    verified: &VerifiedSqliteBuild,
) -> StorageResult<()> {
    tx.execute_batch(
        "CREATE TABLE core_meta (
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
        );",
    )
    .map_err(map_sqlite_error)?;
    tx.execute_batch(HOST_AUTHORITY_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    tx.execute(
        "INSERT INTO core_meta (
            singleton, schema_version, daemon_installation_id, instance_id,
            controller_generation_id, clean_shutdown, sqlite_version_number,
            sqlite_source_id, sqlite_artifact_digest
         ) VALUES (1, ?1, NULL, NULL, NULL, 0, ?2, ?3, ?4)",
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
    Ok(())
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

    let core_meta: Option<(Option<String>, Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT daemon_installation_id, instance_id, controller_generation_id
             FROM core_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| StorageError::Corrupt)?;
    let (core_identity, core_generation) = match core_meta {
        None => return Err(StorageError::Corrupt),
        Some((None, None, None)) => (None, None),
        Some((Some(daemon_installation_id), Some(instance_id), Some(generation)))
            if !generation.is_empty() =>
        {
            (
                Some(RuntimeAuthorityIdentity {
                    daemon_installation_id,
                    instance_id,
                }),
                Some(generation),
            )
        }
        _ => return Err(StorageError::Corrupt),
    };

    let snapshot =
        load_current_authority_with_generation(connection).map_err(map_host_authority_error)?;
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
        (Some(core), Some((snapshot, state_generation))) => {
            let state_identity = RuntimeAuthorityIdentity {
                daemon_installation_id: snapshot.mapping.daemon_installation_id.clone(),
                instance_id: snapshot.mapping.instance_id.clone(),
            };
            if core != state_identity
                || core_generation.as_deref() != Some(state_generation.as_str())
            {
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
        None if !config.permission_policy_selections.is_empty()
            || !legacy.permission_policy_definitions.is_empty()
            || !legacy.permission_policy_backend_bindings.is_empty() =>
        {
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
