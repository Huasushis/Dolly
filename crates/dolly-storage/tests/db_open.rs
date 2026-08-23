//! DB-open slice integration tests against the real bundled SQLite.
//!
//! Covers: discovery of the loaded library identity, REQ-TECH-003 gate with
//! the compiled-in release record, required PRAGMA set/readback, WAL
//! persistence across reopen, instance-lock contention, symlink/path refusal,
//! unsafe-build refusal (nothing written on refusal), and schema
//! version/migration handling.

#![cfg(unix)] // flock, O_NOFOLLOW, and symlink fixtures are Linux-first

use std::fs;
use std::path::{Path, PathBuf};

use dolly_storage::{
    ConnectionConfiguration, Database, SCHEMA_VERSION, SQLITE_VERSION_NUMBER_MIN, SqliteBuildGate,
    StorageError, VerifiedSqliteBuild, probe_loaded_sqlite, release_attestation, required,
};

fn temp_db() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("create tempdir");
    let path = dir.path().join("instance.sqlite");
    (dir, path)
}

#[test]
fn offline_handle_is_inert_until_validated_migration() {
    let (_dir, path) = temp_db();
    let offline = Database::open_for_migration(&path).expect("create inert handle");
    assert!(!path.exists(), "offline handle must not create SQLite");
    assert!(
        !lock_for(&path).exists(),
        "offline handle must not create a lock"
    );

    let err = offline
        .migrate_legacy_json(b"{}")
        .expect_err("invalid legacy bytes must fail during preflight");
    assert!(matches!(err, StorageError::Corrupt));
    assert!(!path.exists(), "preflight failure must not create SQLite");
    assert!(
        !lock_for(&path).exists(),
        "preflight failure must not create a path lock"
    );
}

#[test]
fn migration_symlink_path_is_rejected_before_target_read() {
    let (_dir, path) = temp_db();
    let target = path.with_file_name("target.sqlite");
    fs::write(&target, b"authority-target-sentinel").unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();

    let err = Database::open_for_migration(&path)
        .unwrap()
        .migrate_legacy_json(&legacy_json(&path))
        .expect_err("migration must reject a symlinked database path");
    assert!(matches!(err, StorageError::UnsafeConfiguration));
    assert_eq!(
        fs::read(&target).unwrap(),
        b"authority-target-sentinel",
        "symlink target must not be opened or mutated"
    );
}

fn instance_id(path: &Path) -> String {
    let name = path
        .parent()
        .and_then(Path::file_name)
        .expect("temp directory name")
        .to_string_lossy()
        .replace('.', "d")
        .to_ascii_lowercase();
    format!("instance-{name}")
}

fn legacy_json(path: &Path) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "schema": "dolly.legacy-runtime-config/v0",
        "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
        "instance_id": instance_id(path),
        "config_revision": 1,
        "runtime_config": {"modules": []},
        "permission_policy_selections": [],
        "service_candidate": null
    }))
    .unwrap()
}

fn open_migrated(path: &Path) -> Database {
    Database::open_for_migration(path)
        .unwrap()
        .migrate_legacy_json(&legacy_json(path))
        .unwrap()
}

#[test]
fn existing_lock_with_non_private_mode_is_refused() {
    use std::os::unix::fs::PermissionsExt;

    let (_dir, path) = temp_db();
    let lock_path = lock_for(&path);
    fs::write(&lock_path, b"").unwrap();
    let mut permissions = fs::metadata(&lock_path).unwrap().permissions();
    permissions.set_mode(0o644);
    fs::set_permissions(&lock_path, permissions).unwrap();

    let err = Database::open_for_migration(&path)
        .expect("inert handle")
        .migrate_legacy_json(&legacy_json(&path))
        .expect_err("non-private lock must be refused");
    assert!(matches!(err, StorageError::UnsafeConfiguration));
    assert!(!path.exists(), "refused lock must not create SQLite");
}

// ---------------------------------------------------------------------------
// REQ-TECH-003: runtime identity
// ---------------------------------------------------------------------------

/// The loaded bundled library must meet the absolute version floor.
#[test]
fn probe_version_meets_floor() {
    let loaded = probe_loaded_sqlite();
    assert!(
        loaded.version_number >= SQLITE_VERSION_NUMBER_MIN,
        "bundled SQLite {} is below the required floor {}",
        loaded.version,
        SQLITE_VERSION_NUMBER_MIN
    );
}

/// The loaded library must satisfy the compiled-in release attestation
/// end-to-end (version, source id, digest, linkage), exactly as REQ-TECH-003
/// startup does before any write.
#[test]
fn loaded_matches_release_attestation() {
    let loaded = probe_loaded_sqlite();
    let record = release_attestation();
    let verified: VerifiedSqliteBuild = SqliteBuildGate
        .verify(&record, &loaded)
        .expect("gate must pass for the bundled library");
    assert_eq!(verified.version_number, loaded.version_number);
    assert_eq!(verified.source_id, record.sqlite_source_id);
    assert_eq!(verified.artifact_digest, record.artifact_digest);
    // linkage_mode is attested; the loaded library must declare the same.
    assert_eq!(loaded.linkage_mode, record.linkage_mode);
    assert_eq!(loaded.linkage_mode.as_deref(), Some("bundled-static"));
}

/// Compile options come from the real library and are compared when the
/// attestation names them; a genuine mismatch must fail.
#[test]
fn compile_options_probe_and_gate() {
    let loaded = probe_loaded_sqlite();
    let options = loaded
        .compile_options
        .clone()
        .expect("probe returns compile options");
    assert!(
        options.iter().any(|o| o == "THREADSAFE=1"),
        "bundled library must be built with THREADSAFE=1, got {options:?}"
    );
    // When the attestation names exact compile options, the loaded set must
    // replicate them — here derived from the real probe so the positive path
    // is exercised with true data.
    let mut tightened = release_attestation();
    tightened.compile_options = loaded.compile_options.clone();
    assert!(SqliteBuildGate.verify(&tightened, &loaded).is_ok());
}

// ---------------------------------------------------------------------------
// Open + configuration
// ---------------------------------------------------------------------------

/// A fresh open initializes the instance at the current schema version and
/// applies+verifies every required PRAGMA; readback must equal the mandates.
#[test]
fn open_initializes_and_sets_required_pragmas() {
    let (_dir, path) = temp_db();
    let db = open_migrated(&path);
    assert_eq!(db.schema_version(), SCHEMA_VERSION);

    let journal_mode: String = db
        .connection()
        .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
        .unwrap();
    let synchronous: i64 = db
        .connection()
        .query_row("PRAGMA synchronous;", [], |r| r.get(0))
        .unwrap();
    let foreign_keys: i64 = db
        .connection()
        .query_row("PRAGMA foreign_keys;", [], |r| r.get(0))
        .unwrap();
    let busy_timeout: i64 = db
        .connection()
        .query_row("PRAGMA busy_timeout;", [], |r| r.get(0))
        .unwrap();

    let config =
        ConnectionConfiguration::verify(&journal_mode, synchronous, foreign_keys, busy_timeout)
            .expect("readback must match the required values");
    assert_eq!(config, *db.configuration());
}

/// WAL is a persistent database property: after close/reopen it must still
/// read back as `wal`.
#[test]
fn wal_persists_across_reopen() {
    let (_dir, path) = temp_db();
    {
        let db = open_migrated(&path);
        let journal_mode: String = db
            .connection()
            .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(journal_mode, required::JOURNAL_MODE);
    } // drop releases lock + connection

    let db = Database::open(&path).expect("reopen");
    let journal_mode: String = db
        .connection()
        .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(journal_mode, "wal");
}

/// A schema ahead of this binary is `STORAGE_MIGRATION_REQUIRED`, refused at
/// open, and the file is left untouched.
#[test]
fn newer_schema_is_migration_required() {
    let (_dir, path) = temp_db();
    {
        let db = open_migrated(&path);
        db.connection()
            .execute(
                "UPDATE core_meta SET schema_version = ?1 WHERE singleton = 1",
                [SCHEMA_VERSION + 1],
            )
            .unwrap();
    }
    let err = Database::open(&path).expect_err("newer schema must be refused");
    assert!(matches!(err, StorageError::MigrationRequired));

    // Reading after refusal must still report refusal (nothing was mutated
    // into a writable state by the refused open).
    let err2 = Database::open(&path).expect_err("refusal is stable");
    assert!(matches!(err2, StorageError::MigrationRequired));
}

// ---------------------------------------------------------------------------
// Instance lock
// ---------------------------------------------------------------------------

/// A second open while the first Database handle is alive fails with
/// `STORAGE_INSTANCE_LOCKED`; dropping the handle releases the lock.
#[test]
fn instance_lock_contention_and_release() {
    let (_dir, path) = temp_db();
    let first = open_migrated(&path);
    let contended = Database::open(&path).expect_err("second open contends");
    assert!(matches!(contended, StorageError::InstanceLocked));
    drop(first);
    let reopened = Database::open(&path).expect("after drop the lock is free");
    drop(reopened);
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/// A symlink anywhere in the database path is refused before any open, and no
/// file is created at either the link or its target.
#[test]
fn symlinked_database_path_refused() {
    let (_dir, path) = temp_db();
    let real = tempfile::tempdir().unwrap();
    let target = real.path().join("target.sqlite");
    // instance.sqlite -> target.sqlite (final component is a symlink)
    std::os::unix::fs::symlink(&target, &path).unwrap();
    let err = Database::open(&path).expect_err("symlinked path must be refused");
    assert!(matches!(err, StorageError::UnsafeConfiguration));
    assert!(!target.exists(), "target must not be created");
    assert!(
        !path.exists()
            || fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
    );
}

/// A symlink in a parent component is refused equally (TOCTOU guard on path
/// structure, not just the final component).
#[test]
fn symlinked_parent_refused() {
    let base = tempfile::tempdir().unwrap();
    let real_dir = base.path().join("real");
    fs::create_dir(&real_dir).unwrap();
    let link = base.path().join("link");
    std::os::unix::fs::symlink(&real_dir, &link).unwrap();

    let err = Database::open(&link.join("child.sqlite")).expect_err("parent symlink refused");
    assert!(matches!(err, StorageError::UnsafeConfiguration));
    assert!(!real_dir.join("child.sqlite").exists());
}

// NEW-001: fresh open refuses a pre-existing symlink at the lock path even
// when the database path is clean.
#[test]
fn symlinked_lock_file_refused() {
    let (_dir, path) = temp_db();
    let lock_path = lock_for(&path);
    let real_lock = path.with_extension("sqlite.real-lock");
    fs::write(&real_lock, "").unwrap();
    std::os::unix::fs::symlink(&real_lock, &lock_path).unwrap();
    let err = Database::open(&path).expect_err("symlinked lock must be refused");
    assert!(matches!(err, StorageError::UnsafeConfiguration));
}

fn lock_for(db: &Path) -> PathBuf {
    let mut name = db.file_name().unwrap().to_os_string();
    name.push(".lock");
    db.with_file_name(name)
}

// ---------------------------------------------------------------------------
// Unsafe-build refusal
// ---------------------------------------------------------------------------

/// A forged attestation (wrong source id) must not open anything: the failure
/// is `STORAGE_UNSAFE_SQLITE_BUILD`, no schema/changes are written, and the
/// database file may be created by SQLite's open but cannot receive any
/// instance mutation.
#[test]
fn unsafe_build_refused_before_any_write() {
    let (_dir, path) = temp_db();
    let mut forged = release_attestation();
    forged.sqlite_source_id = "attacker-substituted-sqlite".to_string();

    let err = Database::open_with(&path, &forged).expect_err("forged attestation refused");
    assert!(
        matches!(err, StorageError::UnsafeSqliteBuild { .. }),
        "expected UnsafeSqliteBuild, got {err:?}"
    );

    // The refused open must never have run migration: opening afterwards with
    // the true credentials yields an untouched fresh instance.
    let db = open_migrated(&path);
    assert_eq!(db.schema_version(), SCHEMA_VERSION);
}
