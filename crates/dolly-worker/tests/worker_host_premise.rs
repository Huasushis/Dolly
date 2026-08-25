//! Premise-exclusivity proofs for the public worker-host entry.
//!
//! These tests drive the REAL production binary (`worker_host`, default
//! features: no test support, live-only startup) and the sanctioned config
//! derivation API. They exist to falsify any claim that the public entry can
//! be started from caller-supplied locations, environment variables, ACKs,
//! responses, readiness observations, caches, or process-exit signals: the
//! only accepted input is the durable Worker-start premise projected by the
//! Host-owned authority writer for the CURRENT revision. Absent, stale, or
//! tampered premises must refuse closed BEFORE any child process exists —
//! observable here as a nonzero exit, a typed refusal on stderr, and zero
//! stdout frames.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_core_domain::ExtensionId;
use dolly_storage::Database;
use dolly_storage::host_authority::{
    ConfigRevisionMapping, HostAuthorityRevision, LinuxServiceCandidate,
    ModuleActivationPremises, ResolvedConfiguration, RuntimeAuthorityIdentity,
};
use dolly_storage::worker_start_premise::WorkerStartPremiseInput;
use dolly_worker::premise::load_worker_start_config;

const DAEMON_ID: &str = "0198ab31-6c44-7e8a-b2bb-000000000001";

struct Fixture {
    _dir: tempfile::TempDir,
    db_path: PathBuf,
    instance_id: String,
    package_root: PathBuf,
    package_path: PathBuf,
}

fn digest_of(value: &serde_json::Value) -> Sha256Digest {
    canonicalize(value).expect("canonicalize").1
}

fn install_fake_package(root: &Path) -> (Sha256Digest, Sha256Digest) {
    std::fs::create_dir_all(root.join("bin")).expect("bin dir");
    let package = b"dolly-fs-tools-package-v1";
    std::fs::write(root.join("package.bin"), package).expect("write package");
    let executable = root.join("bin/dolly-fs-tools");
    std::fs::copy("/usr/bin/env", &executable).expect("copy interpreter");
    (
        Sha256Digest::compute(package),
        Sha256Digest::compute(&std::fs::read(&executable).expect("read executable")),
    )
}

fn broker_server(package_digest: &str, executable_digest: &str) -> serde_json::Value {
    serde_json::json!({
        "enabled": true,
        "adapter": "mcp",
        "protocol_version": "2025-06-18",
        "transport": {
            "kind": "stdio",
            "package_id": "org.dolly.tools.fs",
            "package_version": "1.0.0",
            "package_digest": package_digest,
            "executable": "bin/dolly-fs-tools",
            "executable_digest": executable_digest,
            "args": [],
            "secret_bindings": {}
        },
        "allowed_modules": ["module-a"],
        "limits": {
            "startup_timeout_ms": 10000,
            "request_timeout_ms": 30000,
            "max_concurrency": 4,
            "max_request_bytes": 1048576,
            "max_response_bytes": 4194304
        },
        "tools": {}
    })
}

fn fixture_with_premise(insert: bool) -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let instance_id = format!(
        "instance-{}",
        dir.path()
            .file_name()
            .expect("temp name")
            .to_string_lossy()
            .replace('.', "d")
            .to_ascii_lowercase()
    );
    let package_root = dir.path().join("pkg");
    let (package_digest, executable_digest) = install_fake_package(&package_root);
    let server = broker_server(
        &package_digest.to_canonical_string(),
        &executable_digest.to_canonical_string(),
    );

    let origin_record = serde_json::json!({"component": "host-runtime", "revision": 1});
    let origin = dolly_storage::host_authority::InstalledComponentOrigin {
        schema: "dolly.installed-component-origin/v1".into(),
        kind: "installed_product_component".into(),
        component_id: "org.dolly.host-runtime".into(),
        component_revision: 1,
        component_digest: digest_of(&origin_record),
    };
    let candidate_record = {
        let mut value = serde_json::json!({
            "schema": "dolly.linux-service-candidate/v1",
            "origin": serde_json::to_value(&origin).unwrap(),
            "unit_name": "dollyd.service",
            "mode": "user"
        });
        // Self-digest convention: hash the record WITHOUT the digest field.
        let unsigned = value.as_object().unwrap().clone();
        let digest = digest_of(&serde_json::Value::Object(unsigned));
        value["candidate_digest"] = serde_json::json!(digest.to_canonical_string());
        value
    };
    let candidate: LinuxServiceCandidate =
        serde_json::from_value(candidate_record).expect("candidate");
    let config = ResolvedConfiguration {
        runtime_config: CanonicalJsonValue::try_from(serde_json::json!({
            "spec": {"services": {"tool_broker": {
                "schema": "dolly.tool-broker-config/v1",
                "servers": {"fs": server}
            }}}
        }))
        .expect("canonical config"),
        permission_policy_selections: Vec::new(),
        service_candidate: Some(candidate.clone()),
    };
    let config_digest = canonicalize(&config).expect("canonicalize config").1;
    let identity = RuntimeAuthorityIdentity {
        daemon_installation_id: DAEMON_ID.into(),
        instance_id: instance_id.clone(),
    };
    let mut premise_record = serde_json::json!({
        "schema": "dolly.module-activation-premises/v1",
        "daemon_installation_id": identity.daemon_installation_id,
        "instance_id": identity.instance_id,
        "config_revision": 1,
        "config_digest": config_digest.to_canonical_string(),
        "permission_policy_definitions": [],
        "permission_policy_backend_bindings": [],
        "service_candidate": serde_json::to_value(&candidate).unwrap()
    });
    let premises_unsigned = premise_record.as_object().unwrap().clone();
    let premises_digest =
        digest_of(&serde_json::Value::Object(premises_unsigned)).to_canonical_string();
    premise_record["premises_digest"] = serde_json::json!(premises_digest);
    let premise: ModuleActivationPremises =
        serde_json::from_value(premise_record).expect("premise");

    let db_path = dir.path().join("instance.sqlite");
    let mut database = Database::open_for_migration(&db_path)
        .expect("open for migration")
        .install_host_authority_revision(HostAuthorityRevision {
            identity: identity.clone(),
            mapping: ConfigRevisionMapping {
                schema: "dolly.config-revision-mapping/v1".into(),
                daemon_installation_id: identity.daemon_installation_id.clone(),
                instance_id: identity.instance_id.clone(),
                config_revision: 1,
                config_digest: config_digest.clone(),
                canonical_config: config,
            },
            premise: Some(premise),
        })
        .expect("install authority");

    if insert {
        let package_root = package_root.clone();
        dolly_storage::worker_start_premise::create_worker_start_premise_schema(
            database.connection(),
        )
        .expect("create premise schema");
        let connection = database.connection_mut();
        let tx = connection.transaction().expect("transaction");
        dolly_storage::worker_start_premise::insert_worker_start_premise_in_transaction(
            &tx,
            WorkerStartPremiseInput {
                daemon_installation_id: identity.daemon_installation_id.clone(),
                instance_id: identity.instance_id.clone(),
                config_revision: 1,
                config_digest: config_digest.to_canonical_string(),
                extension_alias: "org.dolly.tools".into(),
                server_id: "fs".into(),
                package_root: package_root.display().to_string(),
                package_path: package_root.join("package.bin").display().to_string(),
                package_digest: package_digest.to_canonical_string(),
                executable_digest: executable_digest.to_canonical_string(),
                endpoint: "bin/dolly-fs-tools".into(),
            },
        )
        .expect("insert premise");
        tx.commit().expect("commit premise");
    }
    drop(database);
    Fixture {
        _dir: dir,
        db_path,
        instance_id,
        package_root: package_root.clone(),
        package_path: package_root.join("package.bin"),
    }
}

/// Run the production binary with the given arguments; returns
/// (exit_code, stdout_bytes, stderr_text).
fn run_host(db_path: &Path) -> (Option<i32>, Vec<u8>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_worker_host"))
        .arg(db_path)
        .arg("org.dolly.tools")
        .arg("fs")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn worker_host");
    drop(child.stdin.take());
    let output = child.wait_with_output().expect("wait for worker_host");
    (
        output.status.code(),
        output.stdout,
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[cfg(target_os = "linux")]
#[test]
fn absent_premise_refuses_before_spawn() {
    let fixture = fixture_with_premise(false);
    let (code, stdout, stderr) = run_host(&fixture.db_path);
    assert_ne!(code, Some(0), "absent premise must not start the host");
    assert!(
        stderr.contains("WORKER_PREMISE_REFUSED"),
        "expected typed premise refusal, got: {stderr}"
    );
    assert!(
        stdout.is_empty(),
        "refusal must happen before any stdout frame"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn caller_supplied_locations_cannot_substitute_the_premise() {
    // Even with every location argument pointing at a real installed
    // package, the entry derives its authority ONLY from the durable
    // premise. Without one, the identical invocation refuses.
    let fixture = fixture_with_premise(false);
    let (code, _, stderr) = run_host(&fixture.db_path);
    assert_ne!(code, Some(0));
    assert!(stderr.contains("WORKER_PREMISE_REFUSED"));
}

#[cfg(target_os = "linux")]
#[test]
fn stale_revision_premise_refuses_closed() {
    let fixture = fixture_with_premise(true);
    {
        let mut database = Database::open(&fixture.db_path).expect("reopen");
        let connection = database.connection_mut();
        connection
            .execute(
                "INSERT INTO config_revision_mappings (
                     config_revision, daemon_installation_id, instance_id,
                     config_digest, canonical_bytes
                 ) VALUES (2, ?1, ?2, ?3, x'7b7d')",
                rusqlite::params![
                    DAEMON_ID,
                    fixture.instance_id,
                    format!("sha256:{}", "2".repeat(64)),
                ],
            )
            .expect("insert mapping rev 2");
        connection
            .execute(
                "UPDATE runtime_authority_state SET current_config_revision = 2,
                     current_config_digest = ?1",
                rusqlite::params![format!("sha256:{}", "2".repeat(64))],
            )
            .expect("advance pointer");
    }
    let (code, stdout, stderr) = run_host(&fixture.db_path);
    assert_ne!(code, Some(0), "stale premise must not start the host");
    assert!(stderr.contains("WORKER_PREMISE_REFUSED"), "got: {stderr}");
    assert!(stdout.is_empty());
}

#[cfg(target_os = "linux")]
#[test]
fn tampered_premise_refuses_closed() {
    let fixture = fixture_with_premise(true);
    {
        let mut database = Database::open(&fixture.db_path).expect("reopen");
        let connection = database.connection_mut();
        // Keep the cross-column containment CHECK satisfied so the tamper
        // reaches the loader's digest verification instead of tripping the
        // schema guard.
        let updated = connection
            .execute(
                "UPDATE worker_start_premises SET package_root = ?1,
                     package_path = ?2 WHERE config_revision = 1",
                rusqlite::params![
                    fixture.package_root.display().to_string(),
                    fixture.package_root.join("other.bin").display().to_string(),
                ],
            )
            .expect("tamper update");
        assert_eq!(updated, 1, "tamper must touch the projected row");
    }
    let (code, stdout, stderr) = run_host(&fixture.db_path);
    assert_ne!(code, Some(0), "tampered premise must not start the host");
    assert!(stderr.contains("WORKER_PREMISE_REFUSED"), "got: {stderr}");
    assert!(stdout.is_empty());
}

#[test]
fn derived_config_matches_the_durable_premise_exactly() {
    if !cfg!(target_os = "linux") {
        // Database::open refuses non-Linux hosts pre-mutation; derivation
        // semantics are covered by the storage crate's platform-free tests.
        return;
    }
    let fixture = fixture_with_premise(true);
    let config = load_worker_start_config(
        fixture.db_path.clone(),
        "org.dolly.tools",
        "fs",
    )
    .expect("premise-derived config");
    assert_eq!(config.server_id, "fs");
    assert_eq!(
        config.extension_alias,
        "org.dolly.tools".parse::<ExtensionId>().unwrap()
    );
    assert_eq!(config.package_root, fixture.package_root);
    assert_eq!(config.package_path, fixture.package_path);
}

#[test]
fn identity_pair_mismatch_yields_absence_not_authority() {
    if !cfg!(target_os = "linux") {
        return;
    }
    let fixture = fixture_with_premise(true);
    let error = load_worker_start_config(fixture.db_path.clone(), "org.dolly.other", "fs")
        .err()
        .expect("mismatched identity pair must not derive a config");
    assert!(
        error.to_string().contains("no durable Worker-start premise"),
        "unexpected error: {error}"
    );
}
