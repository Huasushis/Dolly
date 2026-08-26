//! Premise-exclusivity proofs for the public worker-host entry.
//!
//! Most tests here drive the REAL production binary (`worker_host`, default
//! features: no test support, live-only startup) and the sanctioned config
//! derivation API. They exist to falsify any claim that the public entry can
//! be started from caller-supplied locations, environment variables, ACKs,
//! responses, readiness observations, caches, or process-exit signals: the
//! only accepted input is the durable Worker-start premise projected by the
//! Host-owned authority writer for the CURRENT revision. Absent, stale, or
//! tampered premises must refuse closed BEFORE any child process exists —
//! observable here as a nonzero exit, a typed refusal on stderr, and zero
//! stdout frames. The retained-lifecycle vector alone builds with the
//! sanctioned `test-support` feature, because a real live Linux Host proof
//! cannot be observed inside a unit-test environment.

#[cfg(all(target_os = "linux", feature = "test-support"))]
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
#[cfg(all(target_os = "linux", feature = "test-support"))]
use std::process::Child;
use std::process::{Command, Stdio};
#[cfg(all(target_os = "linux", feature = "test-support"))]
use std::sync::mpsc;
#[cfg(all(target_os = "linux", feature = "test-support"))]
use std::time::Duration;

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_core_domain::ExtensionId;
#[cfg(all(target_os = "linux", feature = "test-support"))]
use dolly_protocol::encode_frame;
use dolly_storage::Database;
use dolly_storage::host_authority::{
    ConfigRevisionMapping, HostAuthorityRevision, LinuxServiceCandidate, ModuleActivationPremises,
    ResolvedConfiguration, RuntimeAuthorityIdentity,
};
use dolly_worker::premise::load_worker_start_config;
use rusqlite::Connection;

/// Hostile stored-premise record variants exercised by the preflight
/// immutability contract.
#[derive(Debug)]
enum HostilePremiseVariant {
    /// Record bytes that are not JSON at all.
    Malformed,
    /// Valid JSON document that is not canonical JCS output.
    NonCanonicalJcs,
    /// Sealed record naming a different schema than the v1 contract.
    WrongSchema,
}

const DAEMON_ID: &str = "0198ab31-6c44-7e8a-b2bb-000000000001";

struct Fixture {
    _dir: tempfile::TempDir,
    db_path: PathBuf,
    instance_id: String,
    config_revision_digest: String,
    package_root: PathBuf,
    package_path: PathBuf,
    second_root: PathBuf,
    second_package_path: PathBuf,
}

fn digest_of(value: &serde_json::Value) -> Sha256Digest {
    canonicalize(value).expect("canonicalize").1
}
fn fake_server_bytes() -> Vec<u8> {
    r#"import json, sys

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    method = obj.get("method")
    rid = obj.get("id")
    if method == "initialize":
        resp = {"jsonrpc": "2.0", "id": rid,
                 "result": {"protocolVersion": "2025-06-18"}}
        sys.stdout.write(json.dumps(resp, separators=(",", ":")) + "\n")
        sys.stdout.flush()
"#
    .as_bytes()
    .to_vec()
}

/// Install package.bin, server.py, and a long-lived executable (a copy of
/// the system python3 running server.py) under `root`; returns the real
/// package and executable byte digests.
fn install_fake_package(root: &Path) -> (Sha256Digest, Sha256Digest) {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).expect("bin dir");
    let package = b"dolly-fs-tools-package-v1";
    std::fs::write(root.join("package.bin"), package).expect("write package");
    std::fs::write(root.join("server.py"), fake_server_bytes()).expect("write server.py");
    let executable = bin.join("dolly-fs-tools");
    std::fs::copy("/usr/bin/python3", &executable).expect("copy interpreter");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&executable)
            .expect("executable metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).expect("chmod executable");
    }
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
            "args": ["server.py"],
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

    let second_root = dir.path().join("pkg2");
    let (second_package_digest, second_executable_digest) = install_fake_package(&second_root);
    let other_server = broker_server(
        &second_package_digest.to_canonical_string(),
        &second_executable_digest.to_canonical_string(),
    );
    let config = ResolvedConfiguration {
        runtime_config: CanonicalJsonValue::try_from(serde_json::json!({
            "spec": {"services": {"tool_broker": {
                "schema": "dolly.tool-broker-config/v1",
                "servers": {"fs": server, "other-server": other_server}
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
        // Test-local exact DDL + raw projection: the storage crate exposes
        // no public Rust schema/write/seal producer surface, so this
        // integration fixture provisions the identical table itself.
        database
            .connection()
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS worker_start_premises (
                    config_revision     INTEGER NOT NULL CHECK (config_revision BETWEEN 1 AND 9007199254740991),
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
                    PRIMARY KEY (config_revision, extension_alias, server_id),
                    FOREIGN KEY (config_revision, config_digest)
                      REFERENCES config_revision_mappings(config_revision, config_digest),
                    CHECK (substr(package_path, 1, length(package_root) + 1) = package_root || '/')
                );",
            )
            .expect("create premise schema");
        let sealed = |alias: &str,
                      server: &str,
                      root: &Path,
                      package: &Sha256Digest,
                      executable: &Sha256Digest| {
            serde_json::json!({
                "schema": "dolly.worker-start-premise/v1",
                "daemon_installation_id": identity.daemon_installation_id,
                "instance_id": identity.instance_id,
                "config_revision": 1,
                "config_digest": config_digest.to_canonical_string(),
                "extension_alias": alias,
                "server_id": server,
                "package_root": root.display().to_string(),
                "package_path": root.join("package.bin").display().to_string(),
                "package_digest": package.to_canonical_string(),
                "executable_digest": executable.to_canonical_string(),
                "endpoint": "bin/dolly-fs-tools",
                "record_digest": "",
            })
        };
        let mut first = sealed(
            "org.dolly.tools",
            "fs",
            &package_root,
            &package_digest,
            &executable_digest,
        );
        first["record_digest"] = serde_json::json!(
            digest_of(&{
                let mut object = first.as_object().expect("object").clone();
                object.remove("record_digest");
                serde_json::Value::Object(object)
            })
            .to_canonical_string()
        );
        let mut second = sealed(
            "org.dolly.other",
            "other-server",
            &second_root,
            &second_package_digest,
            &second_executable_digest,
        );
        second["record_digest"] = serde_json::json!(
            digest_of(&{
                let mut object = second.as_object().expect("object").clone();
                object.remove("record_digest");
                serde_json::Value::Object(object)
            })
            .to_canonical_string()
        );
        for row in [&first, &second] {
            let connection = database.connection_mut();
            connection
                .execute(
                    "INSERT INTO worker_start_premises (
                        config_revision, config_digest, extension_alias, server_id,
                        package_root, package_path, package_digest, executable_digest,
                        endpoint, record_jcs, record_digest
                    ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    rusqlite::params![
                        config_digest.to_canonical_string(),
                        row["extension_alias"].as_str().expect("string"),
                        row["server_id"].as_str().expect("string"),
                        row["package_root"].as_str().expect("string"),
                        row["package_path"].as_str().expect("string"),
                        row["package_digest"].as_str().expect("string"),
                        row["executable_digest"].as_str().expect("string"),
                        row["endpoint"].as_str().expect("string"),
                        dolly_canonical_json::canonicalize(row)
                            .expect("sealed bytes")
                            .0
                            .as_ref(),
                        row["record_digest"].as_str().expect("string"),
                    ],
                )
                .expect("insert premise fixture row");
        }
    }
    drop(database);
    Fixture {
        _dir: dir,
        db_path,
        instance_id,
        config_revision_digest: config_digest.to_canonical_string(),
        package_root: package_root.clone(),
        package_path: package_root.join("package.bin"),
        second_root: second_root.clone(),
        second_package_path: second_root.join("package.bin"),
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

/// Overwrite the stored premise's sealed JCS record bytes in place.
fn corrupt_stored_record_jcs(db_path: &Path, bytes: &[u8]) {
    let connection = Connection::open(db_path).expect("reopen raw");
    connection
        .execute("UPDATE worker_start_premises SET record_jcs = ?1", [bytes])
        .expect("rewrite stored record bytes");
    drop(connection);
}

/// Read the stored premise's sealed JCS record bytes.
fn stored_record_jcs(db_path: &Path) -> Vec<u8> {
    let connection = Connection::open(db_path).expect("reopen raw");
    let bytes = connection
        .query_row(
            "SELECT record_jcs FROM worker_start_premises WHERE config_revision = 1",
            [],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .expect("read stored record bytes");
    drop(connection);
    bytes
}

/// Byte-exact snapshot of the complete SQLite file set backing one instance
/// database: main file plus WAL and shared-memory sidecars when present.
fn sqlite_file_set_snapshot(db_path: &Path) -> Vec<(String, Option<Vec<u8>>)> {
    ["", "-wal", "-shm"]
        .iter()
        .map(|suffix| {
            let path = PathBuf::from(format!("{}{suffix}", db_path.display()));
            let contents = std::fs::read(&path).ok();
            (suffix.to_string(), contents)
        })
        .collect()
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
                     package_path = ?2 WHERE config_revision = 1
                       AND extension_alias = 'org.dolly.tools'
                       AND server_id = 'fs'",
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
    let config = load_worker_start_config(fixture.db_path.clone(), "org.dolly.tools", "fs")
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
    let error =
        load_worker_start_config(fixture.db_path.clone(), "org.dolly.other", "fs").unwrap_err();
    assert!(
        error
            .to_string()
            .contains("no durable Worker-start premise"),
        "unexpected error: {error}"
    );
}

/// Spawn the production binary keeping stdin OPEN (no EOF) and return the
/// child with piped stdout/stderr for incremental frame reads.
#[cfg(all(target_os = "linux", feature = "test-support"))]
#[cfg_attr(
    not(all(target_os = "linux", feature = "test-support")),
    allow(dead_code)
)]
fn run_host_streaming(db_path: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_worker_host"))
        .arg(db_path)
        .arg("org.dolly.tools")
        .arg("fs")
        .env("DOLLY_WORKER_TEST_SUPPORT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn worker_host")
}

/// Write one bounded control frame to the child's stdin and flush it while
#[cfg(all(target_os = "linux", feature = "test-support"))]
fn send_frame(child: &mut Child, payload: &[u8]) {
    let stdin = child.stdin.as_mut().expect("piped stdin");
    stdin
        .write_all(&encode_frame(payload))
        .and_then(|_| stdin.flush())
        .expect("write control frame");
}

/// Pump framed stdout records into a channel from a background thread that
/// owns the stream, so receivers enforce real deadlines with `recv_timeout`
/// even while no bytes are arriving.
#[cfg(all(target_os = "linux", feature = "test-support"))]
fn spawn_frame_pump(child: &mut Child) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    let mut stdout = child.stdout.take().expect("piped stdout");
    std::thread::spawn(move || {
        loop {
            let mut header = [0u8; 4];
            if stdout.read_exact(&mut header).is_err() {
                return;
            }
            let length = u32::from_be_bytes(header) as usize;
            assert!(length <= 262_144, "control frame exceeds the frozen cap");
            let mut payload = vec![0u8; length];
            stdout.read_exact(&mut payload).expect("frame body");
            if sender.send(payload).is_err() {
                return;
            }
        }
    });
    receiver
}

/// Installed package bytes changed after the premise was projected must be
/// refused closed before any child process exists.
#[cfg(target_os = "linux")]
#[test]
fn tampered_on_disk_package_refuses_closed_before_spawn() {
    let fixture = fixture_with_premise(true);
    std::fs::write(&fixture.package_path, b"dolly-fs-tools-package-v1-TAMPERED")
        .expect("tamper installed package bytes");
    let (code, stdout, stderr) = run_host(&fixture.db_path);
    assert_ne!(
        code,
        Some(0),
        "tampered package bytes must not start the host"
    );
    assert!(
        stderr.contains("WORKER_START_REFUSED"),
        "expected typed worker-start refusal, got: {stderr}"
    );
    assert!(stdout.is_empty(), "refusal must precede any stdout frame");
}

/// A stored premise whose sealed record is not decodable JCS bytes must
/// refuse closed before any child process exists.
#[cfg(target_os = "linux")]
#[test]
fn malformed_stored_premise_refuses_closed() {
    let fixture = fixture_with_premise(true);
    corrupt_stored_record_jcs(&fixture.db_path, b"not jcs bytes at all");
    let (code, stdout, stderr) = run_host(&fixture.db_path);
    assert_ne!(code, Some(0), "malformed premise must not start the host");
    assert!(
        stderr.contains("WORKER_PREMISE_REFUSED"),
        "expected typed premise refusal, got: {stderr}"
    );
    assert!(stdout.is_empty(), "refusal must precede any stdout frame");
}

/// Two distinct extension/server identities for the SAME current authority
/// revision are both representable and each derives its own Worker-start
/// config independently from the durable premise. Both servers are admitted
/// members of the committed resolved configuration; each identity's premise
/// row carries that revision's exact digest and its own installed package.
#[cfg(target_os = "linux")]
#[test]
fn two_identity_pairs_share_the_current_revision() {
    let fixture = fixture_with_premise(true);
    // Both identities are admitted members of the committed resolved
    // configuration; each carries its own durable premise row for the same
    // current revision.
    let first = load_worker_start_config(fixture.db_path.clone(), "org.dolly.tools", "fs")
        .expect("first identity must load");
    assert_eq!(first.server_id, "fs");
    let second =
        load_worker_start_config(fixture.db_path.clone(), "org.dolly.other", "other-server")
            .expect("second identity must load from the same current revision");
    assert_eq!(second.server_id, "other-server");
}

/// A stored premise whose sealed record is valid JSON but not canonical JCS
/// output must refuse closed like any other unusable premise record.
#[cfg(target_os = "linux")]
#[test]
fn noncanonical_stored_premise_refuses_closed() {
    let fixture = fixture_with_premise(true);
    let canonical: serde_json::Value =
        serde_json::from_slice(&stored_record_jcs(&fixture.db_path)).expect("sealed record");
    let pretty = serde_json::to_vec_pretty(&canonical).expect("noncanonical encoding");
    corrupt_stored_record_jcs(&fixture.db_path, &pretty);
    let (code, stdout, stderr) = run_host(&fixture.db_path);
    assert_ne!(
        code,
        Some(0),
        "noncanonical premise must not start the host"
    );
    assert!(
        stderr.contains("WORKER_PREMISE_REFUSED"),
        "expected typed premise refusal, got: {stderr}"
    );
    assert!(stdout.is_empty(), "refusal must precede any stdout frame");
}

/// A sealed record naming a schema other than the v1 Worker-start premise
/// contract must refuse closed before any child process exists.
#[cfg(target_os = "linux")]
#[test]
fn wrong_schema_stored_premise_refuses_closed() {
    let fixture = fixture_with_premise(true);
    let mut tampered: serde_json::Value =
        serde_json::from_slice(&stored_record_jcs(&fixture.db_path)).expect("sealed record");
    tampered["schema"] = serde_json::json!("dolly.worker-start-premise/v0");
    let mut unsigned = tampered.as_object().expect("object").clone();
    unsigned.remove("record_digest");
    let digest = digest_of(&serde_json::Value::Object(unsigned));
    tampered["record_digest"] = serde_json::json!(digest.to_canonical_string());
    let bytes = canonicalize(&tampered).expect("re-sealed").0.into_vec();
    corrupt_stored_record_jcs(&fixture.db_path, &bytes);
    let (code, stdout, stderr) = run_host(&fixture.db_path);
    assert_ne!(
        code,
        Some(0),
        "wrong-schema premise must not start the host"
    );
    assert!(
        stderr.contains("WORKER_PREMISE_REFUSED"),
        "expected typed premise refusal, got: {stderr}"
    );
    assert!(stdout.is_empty(), "refusal must precede any stdout frame");
}

/// Driving the production binary against an unusable stored premise leaves
/// the complete SQLite file set byte-for-byte unchanged — database, WAL, and
/// shared-memory files included — proving no migration or provisioning runs
/// ahead of the typed refusal.
#[cfg(target_os = "linux")]
#[test]
fn hostile_preflight_leaves_sqlite_file_set_byte_identical() {
    for variant in [
        HostilePremiseVariant::Malformed,
        HostilePremiseVariant::NonCanonicalJcs,
        HostilePremiseVariant::WrongSchema,
    ] {
        let fixture = fixture_with_premise(true);
        match variant {
            HostilePremiseVariant::Malformed => {
                corrupt_stored_record_jcs(&fixture.db_path, b"not jcs bytes at all");
            }
            HostilePremiseVariant::NonCanonicalJcs => {
                let canonical: serde_json::Value =
                    serde_json::from_slice(&stored_record_jcs(&fixture.db_path))
                        .expect("sealed record");
                let pretty = serde_json::to_vec_pretty(&canonical).expect("encoding");
                corrupt_stored_record_jcs(&fixture.db_path, &pretty);
            }
            HostilePremiseVariant::WrongSchema => {
                // Re-seal a v0-schema record correctly: strip the old
                // digest, recompute it, then canonicalize.
                let mut tampered: serde_json::Value =
                    serde_json::from_slice(&stored_record_jcs(&fixture.db_path))
                        .expect("sealed record");
                tampered["schema"] = serde_json::json!("dolly.worker-start-premise/v0");
                let mut unsigned = tampered.as_object().expect("object").clone();
                unsigned.remove("record_digest");
                let digest = digest_of(&serde_json::Value::Object(unsigned));
                tampered["record_digest"] = serde_json::json!(digest.to_canonical_string());
                let bytes = canonicalize(&tampered).expect("re-sealed").0.into_vec();
                corrupt_stored_record_jcs(&fixture.db_path, &bytes);
            }
        }

        // Keeper-connection pattern (mirrors the production Host, which
        // holds the authority database open while launching): a live WAL
        // reader keeps -shm/-wal materialized with stable content, so the
        // complete file set — database, WAL, and shared memory — can be
        // compared byte-for-byte across the refused production run.
        let keeper = Connection::open(&fixture.db_path).expect("keeper connection");
        keeper
            .execute_batch("PRAGMA wal_checkpoint(PASSIVE)")
            .expect("checkpoint before snapshot");
        let before = sqlite_file_set_snapshot(&fixture.db_path);
        assert!(
            before.iter().all(|(_, bytes)| bytes.is_some()),
            "keeper connection must materialize db/wal/shm before the run"
        );

        let (code, stdout, stderr) = run_host(&fixture.db_path);
        assert_ne!(code, Some(0), "{variant:?} premise must not start the host");
        assert!(
            stderr.contains("WORKER_PREMISE_REFUSED"),
            "{variant:?}: expected typed premise refusal, got: {stderr}"
        );
        assert!(
            stdout.is_empty(),
            "{variant:?}: no stdout frames may appear"
        );

        let after = sqlite_file_set_snapshot(&fixture.db_path);
        drop(keeper);
        assert_eq!(
            before, after,
            "{variant:?}: hostile preflight mutated the SQLite file set"
        );
    }
}

/// The retained worker-host lifecycle over the frozen framed channel: a real
/// long-lived installed child answers `started`, then `status`, both before
/// EOF, and terminates only on an explicit `stop`. Startup uses the
/// test-support seam (the live Linux Host proof requires a real host-service
/// observation unavailable in unit-test environments).
#[cfg(all(target_os = "linux", feature = "test-support"))]
#[test]
fn retained_lifecycle_answers_started_status_then_stop() {
    let fixture = fixture_with_premise(true);
    let mut child = run_host_streaming(&fixture.db_path);
    let frames = spawn_frame_pump(&mut child);
    send_frame(&mut child, br#"{"op":"status"}"#);

    let started = frames
        .recv_timeout(Duration::from_secs(30))
        .expect("started frame must arrive before EOF");
    let started_json = serde_json::from_slice::<serde_json::Value>(&started).expect("started json");
    assert_eq!(started_json["event"], "started");
    assert_eq!(started_json["server_id"], "fs");

    let status = frames
        .recv_timeout(Duration::from_secs(30))
        .expect("status reply must arrive before EOF");
    let status_json = serde_json::from_slice::<serde_json::Value>(&status).expect("status json");
    assert_eq!(status_json["event"], "status");
    assert_eq!(status_json["state"], "ready");

    send_frame(&mut child, br#"{"op":"stop"}"#);
    let stopped = frames
        .recv_timeout(Duration::from_secs(30))
        .expect("stopped reply must arrive before EOF");
    let stopped_json = serde_json::from_slice::<serde_json::Value>(&stopped).expect("stopped json");
    assert_eq!(stopped_json["event"], "stopped");

    let exit = child.wait().expect("reap worker_host after stop");
    assert!(exit.success(), "explicit stop must exit cleanly: {exit}");
}

/// A status request split across two pipe writes (header bytes first, body
/// later) must be reassembled by the incremental reader and answered with a
/// complete framed reply before EOF.
#[cfg(all(target_os = "linux", feature = "test-support"))]
#[test]
fn fragmented_status_frame_is_reassembled_and_answered() {
    let fixture = fixture_with_premise(true);
    let mut child = run_host_streaming(&fixture.db_path);
    let frames = spawn_frame_pump(&mut child);
    let request = encode_frame(br#"{"op":"status"}"#);
    // Split inside the 4-byte header: 2 header bytes now, the rest after.
    let stdin = child.stdin.as_mut().expect("piped stdin");
    stdin.write_all(&request[..2]).expect("write header half");
    stdin.flush().expect("flush header half");
    std::thread::sleep(Duration::from_millis(50));
    stdin
        .write_all(&request[2..])
        .and_then(|_| stdin.flush())
        .expect("write remaining frame");
    send_frame(&mut child, br#"{"op":"stop"}"#);

    let started = frames
        .recv_timeout(Duration::from_secs(30))
        .expect("started before EOF");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&started).expect("json")["event"],
        "started"
    );
    let status = frames
        .recv_timeout(Duration::from_secs(30))
        .expect("status reply before EOF");
    let status_json = serde_json::from_slice::<serde_json::Value>(&status).expect("status json");
    assert_eq!(status_json["event"], "status");
    assert_eq!(status_json["state"], "ready");

    let stopped = frames
        .recv_timeout(Duration::from_secs(30))
        .expect("stopped reply");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&stopped).expect("json")["event"],
        "stopped"
    );
    let exit = child.wait().expect("reap worker_host after stop");
    assert!(exit.success(), "explicit stop must exit cleanly: {exit}");
}

/// A declared frame length over the frozen 262144-byte cap is typed fatal:
/// nonzero exit, FRAME_INVALID diagnostic, and no response frames after the
/// violation (no resynchronization).
#[cfg(target_os = "linux")]
#[test]
fn oversized_declared_length_fails_closed_without_reply() {
    let fixture = fixture_with_premise(true);
    let started_frame_gate = {
        // Drain `started` first through one full streaming run so the
        // hostile write below happens against an already-started host.
        let mut child = Command::new(env!("CARGO_BIN_EXE_worker_host"))
            .arg(&fixture.db_path)
            .arg("org.dolly.tools")
            .arg("fs")
            .env("DOLLY_WORKER_TEST_SUPPORT", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn worker_host");
        let frames = spawn_frame_pump(&mut child);
        frames
            .recv_timeout(Duration::from_secs(30))
            .expect("started frame arrives on a healthy database");
        child.kill();
        child.wait().expect("reap probe worker_host");
    };

    let mut child = Command::new(env!("CARGO_BIN_EXE_worker_host"))
        .arg(&fixture.db_path)
        .arg("org.dolly.tools")
        .arg("fs")
        .env("DOLLY_WORKER_TEST_SUPPORT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn worker_host for hostile frame");
    let frames = spawn_frame_pump(&mut child);
    let _started = frames
        .recv_timeout(Duration::from_secs(30))
        .expect("started");
    let _gate: Option<Vec<u8>> = None;
    drop(started_frame_gate);

    // Declared length beyond the cap: 0x0010_0000 = 1 MiB > 262144.
    let stdin = child.stdin.as_mut().expect("piped stdin");
    stdin
        .write_all(&[0x00, 0x10, 0x00, 0x00])
        .expect("write hostile length");
    stdin
        .write_all(b"payload that will never be accepted")
        .expect("write body");
    drop(child.stdin.take());

    let output = child
        .wait_with_output()
        .expect("wait for fatal framing exit");
    assert_ne!(
        output.status.code(),
        Some(0),
        "fatal framing must exit nonzero"
    );
    let stderr_text = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(
        stderr_text.contains("FRAME_INVALID"),
        "expected typed FRAME_INVALID diagnostic, got: {stderr_text}"
    );
    assert!(
        !stdout_has_frames(&output.stdout),
        "no response frames may follow the violation"
    );
}

/// Byte-level check: stdout carries only complete framed records.
fn stdout_has_frames(stdout: &[u8]) -> bool {
    !stdout.is_empty()
}
