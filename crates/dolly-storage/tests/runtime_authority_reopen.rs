#![cfg(unix)]

use std::fs;
use std::path::PathBuf;

use dolly_storage::{Database, StorageError};
use serde_json::json;
use tempfile::tempdir;

const ZERO_DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

fn temp_db() -> (tempfile::TempDir, PathBuf) {
    let dir = tempdir().expect("create tempdir");
    let path = dir.path().join("runtime.sqlite3");
    (dir, path)
}
fn instance_id(path: &std::path::Path) -> String {
    let name = path
        .parent()
        .and_then(std::path::Path::file_name)
        .expect("temp directory name")
        .to_string_lossy()
        .replace('.', "d")
        .to_ascii_lowercase();
    format!("instance-{name}")
}

fn legacy_config_for(path: &std::path::Path) -> Vec<u8> {
    serde_json::to_vec(&json!({
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

fn open_migrated(path: &std::path::Path) -> dolly_storage::Database {
    Database::open_for_migration(path)
        .unwrap()
        .migrate_legacy_json(&legacy_config_for(path))
        .unwrap()
}

#[test]
fn ordinary_open_refuses_empty_and_only_offline_mode_bootstraps() {
    let (_dir, path) = temp_db();
    let err = Database::open(&path).expect_err("empty authority must not be writable");
    assert!(matches!(err, StorageError::MigrationRequired));
    assert!(
        !path.exists(),
        "ordinary refusal must not create a database"
    );

    let db = open_migrated(&path);
    let first_generation = db.controller_generation_id().to_owned();
    assert_eq!(db.schema_version(), dolly_storage::SCHEMA_VERSION);
    assert_eq!(db.authority_identity().instance_id, instance_id(&path));
    drop(db);
    let reopened = Database::open(&path).unwrap();
    assert_ne!(reopened.controller_generation_id(), first_generation);
    let persisted_generation: String = reopened
        .connection()
        .query_row(
            "SELECT controller_generation_id FROM core_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(persisted_generation, reopened.controller_generation_id());
}
#[test]
fn legacy_migration_is_atomic_and_current_pointer_publishes_after_commit() {
    let (_dir, path) = temp_db();
    let db = open_migrated(&path);
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
    let db = open_migrated(&path);
    drop(db);
    let err = Database::open_for_migration(&path)
        .unwrap()
        .migrate_legacy_json(
            &serde_json::to_vec(&json!({
                "schema": "dolly.legacy-runtime-config/v0",
                "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
                "instance_id": instance_id(&path),
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
        let db = open_migrated(&path);
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
fn copied_authority_cannot_bypass_identity_lock_domain() {
    let (_dir, path) = temp_db();
    let db = open_migrated(&path);
    drop(db);
    let copied = path.with_file_name("copied.sqlite3");
    fs::copy(&path, &copied).unwrap();

    let original = Database::open(&path).unwrap();
    let err = Database::open(&copied).expect_err("copy must share identity lock domain");
    assert!(matches!(err, StorageError::InstanceLocked));
    drop(original);
}

#[test]
fn malformed_legacy_input_leaves_no_authority_rows() {
    let (_dir, path) = temp_db();
    let err = Database::open_for_migration(&path)
        .unwrap()
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
}

#[test]
fn legacy_migration_rejects_unreachable_prerequisite_arrays() {
    let (_dir, path) = temp_db();
    let definition = json!({
        "schema": "dolly.permission-policy-definition/v1",
        "policy_id": "policy",
        "policy_revision": 1,
        "definition_schema_uri": "schema",
        "definition_schema_digest": ZERO_DIGEST,
        "definition": {},
        "origin": {
            "schema": "dolly.policy-definition-origin/v1",
            "kind": "operator_approved_policy",
            "source_id": "org.policy",
            "source_revision": 1,
            "source_digest": ZERO_DIGEST
        },
        "definition_digest": ZERO_DIGEST
    });
    let err = Database::open_for_migration(&path)
        .unwrap()
        .migrate_legacy_json(
            &serde_json::to_vec(&json!({
                "schema": "dolly.legacy-runtime-config/v0",
                "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
                "instance_id": instance_id(&path),
                "config_revision": 1,
                "runtime_config": {"modules": []},
                "permission_policy_selections": [],
                "service_candidate": null,
                "permission_policy_definitions": [definition]
            }))
            .unwrap(),
        )
        .expect_err("unreachable prerequisite evidence must not be dropped");
    assert!(matches!(err, StorageError::Corrupt));
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
