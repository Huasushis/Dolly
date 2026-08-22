#![cfg(unix)]

use std::fs;
use std::path::PathBuf;

use dolly_storage::{Database, StorageError};
use serde_json::json;
use tempfile::tempdir;

fn temp_db() -> (tempfile::TempDir, PathBuf) {
    let dir = tempdir().expect("create tempdir");
    let path = dir.path().join("runtime.sqlite3");
    (dir, path)
}

fn legacy_config() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "schema": "dolly.legacy-runtime-config/v0",
        "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
        "instance_id": "instance-one",
        "config_revision": 1,
        "runtime_config": {"modules": []},
        "permission_policy_selections": [],
        "service_candidate": null
    }))
    .unwrap()
}

#[test]
fn legacy_migration_is_atomic_and_current_pointer_publishes_after_commit() {
    let (_dir, path) = temp_db();
    let mut db = Database::open(&path).expect("fresh database");
    db.migrate_legacy_json(&legacy_config())
        .expect("explicit legacy migration");
    let state: (i64, String, Vec<u8>) = db
        .connection()
        .query_row(
            "SELECT current_config_revision, current_config_digest, record_jcs
             FROM runtime_authority_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(state.0, 1);
    assert!(state.1.starts_with("sha256:"));
    assert!(!state.2.is_empty());
    assert_eq!(
        db.connection()
            .query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM module_activation_premises",
                [],
                |row| row.get(0),
            )
            .unwrap(),
        0
    );
}

#[test]
fn committed_authority_refuses_legacy_json_override() {
    let (_dir, path) = temp_db();
    let mut db = Database::open(&path).unwrap();
    db.migrate_legacy_json(&legacy_config()).unwrap();
    let err = db
        .migrate_legacy_json(
            &serde_json::to_vec(&json!({
                "schema": "dolly.legacy-runtime-config/v0",
                "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
                "instance_id": "instance-one",
                "config_revision": 2,
                "runtime_config": {"modules": ["override"]},
                "permission_policy_selections": [],
                "service_candidate": null
            }))
            .unwrap(),
        )
        .expect_err("ordinary authority never reimports legacy JSON");
    assert!(matches!(err, StorageError::MigrationRequired));
}

#[test]
fn identity_and_reachable_pointer_tampering_refuse_reopen() {
    let (_dir, path) = temp_db();
    {
        let db = Database::open(&path).unwrap();
        let mut db = db;
        db.migrate_legacy_json(&legacy_config()).unwrap();
        db.connection()
            .execute(
                "UPDATE core_meta SET daemon_installation_id = ?1 WHERE singleton = 1",
                ["0198ab31-6c44-7e8a-b2bb-000000000002"],
            )
            .unwrap();
    }
    let err = Database::open(&path).expect_err("identity mismatch must fail closed");
    assert!(matches!(err, StorageError::Corrupt));
}

#[test]
fn malformed_legacy_input_leaves_no_authority_rows() {
    let (_dir, path) = temp_db();
    let mut db = Database::open(&path).unwrap();
    let err = db
        .migrate_legacy_json(
            &serde_json::to_vec(&json!({
                "schema": "dolly.legacy-runtime-config/v0",
                "daemon_installation_id": "not-a-uuid",
                "instance_id": "instance-one",
                "config_revision": 1,
                "runtime_config": {"modules": []},
                "permission_policy_selections": [],
                "service_candidate": null
            }))
            .unwrap(),
        )
        .expect_err("malformed migration must refuse");
    assert!(matches!(
        err,
        StorageError::Corrupt | StorageError::MigrationRequired
    ));
    assert_eq!(
        db.connection()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM runtime_authority_state", [], |row| {
                row.get(0)
            },)
            .unwrap(),
        0
    );
    assert_eq!(
        db.connection()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM config_revision_mappings", [], |row| {
                row.get(0)
            },)
            .unwrap(),
        0
    );
}

#[test]
fn symlink_path_is_not_an_identity_authority() {
    let base = tempdir().unwrap();
    let target = base.path().join("target.sqlite3");
    let link = base.path().join("link.sqlite3");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let err = Database::open(&link).expect_err("symlink locator must fail closed");
    assert!(matches!(err, StorageError::UnsafeConfiguration));
    assert!(!target.exists());
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
