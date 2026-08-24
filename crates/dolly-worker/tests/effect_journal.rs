
#![cfg(feature = "test-support")]
//! RED end-to-end Worker dispatch/start/reopen contract tests for the v1
//! external-effect journal (ADR 0009 capability effect-intent seam).
//!
//! These tests drive the REAL `dolly-worker` production seams: a real bundled
//! SQLite authority database, a real spawned installed child (a copied ELF
//! interpreter running a scripted stdio MCP fake server), the real MCP
//! initialize handshake, the real registry/authority publish, and the real
//! Worker dispatch path that durably records the exact Claim-bound intent
//! BEFORE any child I/O. Every claim is then re-verified straight from the
//! SQLite file across close/reopen, and crash settlement is proven by a real
//! Worker restart (the same startup path a cold start uses).
//!
//! The fixture uses only test-local authority/configuration data; production
//! Worker startup, the coordinator reopen fence, MCP handshake, dispatch,
//! Claim insertion, and SQLite settlement are all exercised directly.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::Duration;

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_storage::Database;
use dolly_storage::effect_journal::{MAX_EFFECT_JOURNAL_ROWS, insert_intent};
use dolly_storage::host_authority::{
    ConfigRevisionMapping, HostAuthorityRevision, InstalledComponentOrigin, LinuxServiceCandidate,
    ModuleActivationPremises, ResolvedConfiguration, RuntimeAuthorityIdentity,
};
use dolly_storage::tool_ledger::{create_tool_ledger_schema, load_exact as load_ledger_exact};
use dolly_tool_broker::effect_journal::{
    Claim, ClaimRecordSchemaTag, EffectClass, EffectJournalRecordSchemaTag, EffectJournalState,
    ExternalEffectJournalRecord, derive_claim_token,
};
use dolly_tool_broker::{
    ConfirmationDecision, IdempotencyPolicy, LedgerState, SideEffectClass, ToolCallLedgerRecord,
    ToolCallLedgerRecordSchemaTag, ToolOperationBinding, ToolOperationBindingSchemaTag,
};
use dolly_tool_coordinator::DispatchOutcome;
use dolly_worker::{Worker, WorkerStartConfig};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

// ---------------------------------------------------------------------------
// closed-JSON / digest helpers
// ---------------------------------------------------------------------------

fn digest_of(value: &Value) -> Sha256Digest {
    canonicalize(value).unwrap().1
}

fn without(value: &Value, field: &str) -> Value {
    let mut object = value.as_object().unwrap().clone();
    object.remove(field);
    Value::Object(object)
}

fn digest_hex(byte: u8) -> Sha256Digest {
    format!("sha256:{:064x}", byte as u128)
        .parse()
        .expect("valid digest")
}

fn origin() -> InstalledComponentOrigin {
    let record = json!({"component": "host-runtime", "revision": 1});
    InstalledComponentOrigin {
        schema: "dolly.installed-component-origin/v1".into(),
        kind: "installed_product_component".into(),
        component_id: "org.dolly.host-runtime".into(),
        component_revision: 1,
        component_digest: digest_of(&record),
    }
}

/// The single fake-MCP-server description shared by the durable authority
/// config and every ledger binding's server contract. `package_digest` and
/// `executable_digest` are the REAL digests of the installed package and
/// executable bytes, so the Worker's package/executable verification and the
/// installed-child verifier both pass.
fn server_value(package_digest: &Sha256Digest, executable_digest: &Sha256Digest) -> Value {
    let input_schema = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {"path": {"type": "string"}}
    });
    let output_schema = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {"text": {"type": "string"}}
    });
    json!({
        "enabled": true,
        "adapter": "mcp",
        "protocol_version": "2025-06-18",
        "transport": {
            "kind": "stdio",
            "package_id": "org.dolly.tools.fs",
            "package_version": "1.0.0",
            "package_digest": package_digest.to_canonical_string(),
            "executable": "bin/dolly-fs-tools",
            "executable_digest": executable_digest.to_canonical_string(),
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
        "tools": {
            "read-file": {
                "upstream_name": "read_file",
                "description": "Read one file.",
                "input_schema": input_schema,
                "input_schema_digest": digest_of(&input_schema).to_canonical_string(),
                "output_schema": output_schema,
                "output_schema_digest": digest_of(&output_schema).to_canonical_string(),
                "side_effect_class": "read_only",
                "idempotency": {"kind": "none"},
                "requires_confirmation": false,
                "enabled": true
            }
        }
    })
}

fn binding(server: &CanonicalJsonValue, seed: u8) -> ToolOperationBinding {
    let contract = match server {
        CanonicalJsonValue::Object(o) => o.clone(),
        _ => panic!("server must be an object"),
    };
    ToolOperationBinding {
        schema: ToolOperationBindingSchemaTag,
        instance_id: "c-inst-0001".into(),
        module_id: "module-a".into(),
        operation_id: format!("op-worker-{seed}"),
        tool_transaction_id: "0198ab31-6c44-7e8a-b2bb-000000000099".into(),
        activation_id: "0198ab31-6c44-7e8a-b2bb-000000000101".into(),
        activation_lease_generation: 1,
        config_revision: 1,
        tool_server_id: "fs".into(),
        tool_name: "read-file".into(),
        tool_schema_digest: digest_hex(0x44),
        arguments: serde_json::from_value(json!({"path": "notes/example.txt"})).unwrap(),
        side_effect_class: SideEffectClass::NonIdempotentWrite,
        idempotency: IdempotencyPolicy::None,
        idempotency_key: None,
        authorized_deadline: "2126-01-01T00:00:00.000000Z".into(),
        request_digest: digest_hex(seed),
        tool_server_generation: 1,
        server_request_id: format!("sr-{seed}"),
        server_contract: contract,
        confirmation_decision: ConfirmationDecision::NotRequired,
    }
}

fn ledger_authorized(b: &ToolOperationBinding) -> ToolCallLedgerRecord {
    let record = ToolCallLedgerRecord {
        schema: ToolCallLedgerRecordSchemaTag,
        ledger_revision: 1,
        state: LedgerState::Authorized,
        operation_binding: b.clone(),
        operation_digest: b.operation_digest(),
        outbound_digest: None,
        terminal_result: None,
        terminal_result_digest: None,
    };
    record
        .verify_field_combination()
        .expect("fixture must be field-consistent");
    record
}

/// The exact outbound request frame the Worker writes to the child. Its
/// digest is the intent/outbound identity and must equal the ledger's
/// reconstituted outbound digest, so recovery settles `APPLIED` exactly.
fn request_frame(b: &ToolOperationBinding) -> Vec<u8> {
    b.recompute_outbound_payload()
        .expect("fixture payload")
        .as_ref()
        .to_vec()
}


// ---------------------------------------------------------------------------
// installed fake MCP server (a REAL spawned child)
// ---------------------------------------------------------------------------

/// Scripted fake server run by the copied interpreter. It answers the real
/// `initialize` handshake and records every `tools/call` it receives in a
/// side file at the package root (the child-I/O marker). `silent` servers
/// exit right after accepting `tools/call`, so the effect outcome stays
/// ambiguous exactly like a crash after dispatch I/O.
fn fake_server_bytes(silent: bool) -> Vec<u8> {
    let silent_flag = if silent { "True" } else { "False" };
    format!(
        r#"import json, sys

SILENT = {silent_flag}

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
        resp = {{"jsonrpc": "2.0", "id": rid,
                 "result": {{"protocolVersion": "2025-06-18"}}}}
        sys.stdout.write(json.dumps(resp, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    elif method == "tools/call":
        with open("marker.txt", "a") as marker:
            marker.write(line + "\n")
        if SILENT:
            sys.exit(0)
        resp = {{"jsonrpc": "2.0", "id": rid,
                 "result": {{"text": "ok"}}}}
        sys.stdout.write(json.dumps(resp, separators=(",", ":")) + "\n")
        sys.stdout.flush()
"""#
    )
    .into_bytes()
}

/// Install package.bin + server.py + the executable (a copy of `/usr/bin/env`
/// or python3) under `root`; returns (package_digest, executable_digest).
fn install_fake_server(root: &Path, silent: bool) -> (Sha256Digest, Sha256Digest) {
    let package = b"dolly-fs-tools-package-v1";
    std::fs::write(root.join("package.bin"), package).expect("write package");
    std::fs::write(root.join("server.py"), &fake_server_bytes(silent)).expect("write server.py");

    let interpreter = if Path::new("/usr/bin/python3").exists() {
        PathBuf::from("/usr/bin/python3")
    } else if Path::new("/usr/bin/env").exists() {
        PathBuf::from("/usr/bin/env")
    } else {
        panic!("no interpreter for the fake MCP server fixture")
    };
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).expect("bin dir");
    let executable = bin.join("dolly-fs-tools");
    std::fs::copy(&interpreter, &executable).expect("copy interpreter");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&executable)
            .expect("executable metadata")
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&executable, perms).expect("chmod executable");
    }
    let executable_bytes = std::fs::read(&executable).expect("read executable");
    (
        Sha256Digest::compute(package),
        Sha256Digest::compute(&executable_bytes),
    )
}

fn count_child_calls(root: &Path) -> usize {
    match std::fs::read_to_string(root.join("marker.txt")) {
        Ok(text) => text.lines().count(),
        Err(_) => 0,
    }
}
fn capacity_intent(operation_id: String) -> ExternalEffectJournalRecord {
    let claim_token = derive_claim_token(
        "c-inst-0001",
        "module-a",
        &operation_id,
        &digest_hex(0xcc),
        999,
        999,
        "01jh8w2etc4x70xj26rg8fsdv92",
        &digest_hex(0xaa),
        &digest_hex(0xbb),
        EffectClass::McpToolsCall,
    );
    ExternalEffectJournalRecord {
        schema: EffectJournalRecordSchemaTag,
        journal_revision: 1,
        state: EffectJournalState::Intended,
        claim: Claim {
            schema: ClaimRecordSchemaTag,
            instance_id: "c-inst-0001".into(),
            module_id: "module-a".into(),
            operation_id,
            operation_digest: digest_hex(0xcc),
            claim_token,
        },
        controller_generation: 999,
        extension_generation: 999,
        worker_epoch: "01jh8w2etc4x70xj26rg8fsdv92".into(),
        package_digest: digest_hex(0xaa),
        policy_premise_digest: digest_hex(0xbb),
        operation_digest: digest_hex(0xcc),
        effect_class: EffectClass::McpToolsCall,
        intent_digest: digest_hex(0xdd),
        evidence_digest: None,
    }
}

fn fill_journal_capacity(db: &mut Database) {
    for i in 0..MAX_EFFECT_JOURNAL_ROWS {
        let record = capacity_intent(format!("prefill-{i}"));
        insert_intent(db.connection_mut(), &record).expect("prefill insert");
    }
}

#[cfg(target_os = "linux")]
static LAST_SPAWNED_PID: AtomicU32 = AtomicU32::new(0);

#[cfg(target_os = "linux")]
fn remember_spawned_pid(pid: u32) {
    LAST_SPAWNED_PID.store(pid, Ordering::SeqCst);
}

#[cfg(target_os = "linux")]
fn assert_process_reaped(pid: u32) {
    let proc_path = format!("/proc/{pid}");
    for _ in 0..100 {
        if !Path::new(&proc_path).exists() {
            return;
        }
        thread::sleep(Duration::from_millis(1));
    }
    panic!("spawned child {pid} was not reaped");
}

// ---------------------------------------------------------------------------
// durable authority fixture
// ---------------------------------------------------------------------------

fn host_revision(broker_config: Value, instance_id: &str) -> HostAuthorityRevision {
    let origin = origin();
    let mut candidate_record = json!({
        "schema": "dolly.linux-service-candidate/v1",
        "origin": serde_json::to_value(&origin).unwrap(),
        "unit_name": "dollyd.service",
        "mode": "user",
        "candidate_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    });
    candidate_record["candidate_digest"] =
        json!(digest_of(&without(&candidate_record, "candidate_digest")).to_canonical_string());
    let candidate: LinuxServiceCandidate = serde_json::from_value(candidate_record).unwrap();
    let runtime_config = CanonicalJsonValue::try_from(json!({
        "spec": {"services": {"tool_broker": broker_config}}
    }))
    .unwrap();
    let config = ResolvedConfiguration {
        runtime_config,
        permission_policy_selections: Vec::new(),
        service_candidate: Some(candidate.clone()),
    };
    let config_digest = canonicalize(&config).unwrap().1;
    let identity = RuntimeAuthorityIdentity {
        daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
        instance_id: instance_id.into(),
    };
    let premise_without_digest = json!({
        "schema": "dolly.module-activation-premises/v1",
        "daemon_installation_id": identity.daemon_installation_id.clone(),
        "instance_id": identity.instance_id.clone(),
        "config_revision": 1,
        "config_digest": config_digest.to_canonical_string(),
        "permission_policy_definitions": [],
        "permission_policy_backend_bindings": [],
        "service_candidate": serde_json::to_value(&candidate).unwrap()
    });
    let premise = ModuleActivationPremises {
        schema: "dolly.module-activation-premises/v1".into(),
        daemon_installation_id: identity.daemon_installation_id.clone(),
        instance_id: identity.instance_id.clone(),
        config_revision: 1,
        config_digest: config_digest.clone(),
        permission_policy_definitions: Vec::new(),
        permission_policy_backend_bindings: Vec::new(),
        service_candidate: candidate,
        premises_digest: digest_of(&premise_without_digest),
    };
    HostAuthorityRevision {
        identity,
        mapping: ConfigRevisionMapping {
            schema: "dolly.config-revision-mapping/v1".into(),
            daemon_installation_id: premise.daemon_installation_id.clone(),
            instance_id: premise.instance_id.clone(),
            config_revision: 1,
            config_digest,
            canonical_config: config,
        },
        premise: Some(premise),
    }
}

fn tool_broker_config(server: &Value) -> Value {
    json!({"schema": "dolly.tool-broker-config/v1", "servers": {"fs": server.clone()}})
}

struct Fixture {
    #[allow(dead_code)]
    directory: TempDir,
    db_path: PathBuf,
    package_root: PathBuf,
    package_path: PathBuf,
    server: Value,
    instance_id: String,
}

impl Fixture {
    fn new(silent: bool) -> Self {
        let directory = tempdir().expect("tempdir");
        let package_root = directory.path().join("pkg");
        std::fs::create_dir_all(&package_root).expect("pkg dir");
        let (package_digest, executable_digest) = install_fake_server(&package_root, silent);
        let server = server_value(&package_digest, &executable_digest);

        let db_path = directory.path().join("instance.sqlite");
        let instance_id = format!(
            "instance-{}",
            directory
                .path()
                .file_name()
                .expect("temp dir name")
                .to_string_lossy()
                .replace('.', "d")
                .to_ascii_lowercase()
        );
        let revision = host_revision(tool_broker_config(&server), &instance_id);
        let db = Database::open_for_migration(&db_path)
            .expect("open for migration")
            .install_host_authority_revision(revision)
            .expect("install authority revision");
        create_tool_ledger_schema(db.connection()).expect("ledger schema");
        // Seed the FK parents the AUTHORIZED ledger row references.
        db.connection()
            .execute(
                "INSERT OR IGNORE INTO activations (activation_id) VALUES (?1)",
                rusqlite::params!["0198ab31-6c44-7e8a-b2bb-000000000101"],
            )
            .expect("seed activation");
        db.connection()
            .execute(
                "INSERT OR IGNORE INTO config_revisions (config_revision) VALUES (?1)",
                rusqlite::params![1_i64],
            )
            .expect("seed config revision");
        drop(db);
        Self {
            directory,
            db_path,
            package_root: package_root.clone(),
            package_path: package_root.join("package.bin"),
            server,
            instance_id,
        }
    }

    fn preload_ledger(&self, worker: &mut Worker, records: &[ToolCallLedgerRecord]) {
        for record in records {
            worker
                .insert_authorized_for_test(record)
                .expect("preload ledger row");
        }
    }

    fn binding(&self, seed: u8) -> ToolOperationBinding {
        let contract =
            CanonicalJsonValue::try_from(self.server.clone()).expect("canonicalizable server");
        let mut binding = binding(&contract, seed);
        binding.instance_id = self.instance_id.clone();
        binding
    }

    fn config(&self) -> WorkerStartConfig {
        WorkerStartConfig {
            db_path: self.db_path.clone(),
            extension_alias: "org.dolly.tools".parse().expect("extension id"),
            server_id: "fs".into(),
            package_root: self.package_root.clone(),
            package_path: self.package_path.clone(),
        }
    }

    fn start_worker(&self) -> Worker {
        Worker::start_for_test(self.config()).expect("worker starts")
    }

    #[cfg(target_os = "linux")]
    fn start_worker_with_observer(
        &self,
        observer: fn(u32),
    ) -> Result<Worker, dolly_worker::WorkerError> {
        Worker::start_for_test_with_spawn_observer(self.config(), observer)
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// Intent-before-effect: the Worker durably records the exact Claim-bound
/// intent before child I/O, and a real Worker restart settles the journal row.
#[test]
fn worker_dispatches_only_after_durable_intent_then_restart_settles() {
    let fixture = Fixture::new(false);
    let b = fixture.binding(1);
    let ledger = ledger_authorized(&b);
    let mut worker = fixture.start_worker();

    fixture.preload_ledger(&mut worker, &[ledger.clone()]);
    let frame = request_frame(&b);
    let intent_digest = Sha256Digest::compute(&frame);

    // Real dispatch through the Worker (real child, real ledger CAS).
    let outcome = worker
        .dispatch_tools_call(&ledger, &frame)
        .expect("dispatch succeeds against the real child");
    match &outcome {
        DispatchOutcome::Terminalized { record } if record.state == LedgerState::Succeeded => {}
        other => panic!("expected a terminal Succeeded outcome, got {other:?}"),
    }
    assert_eq!(
        count_child_calls(&fixture.package_root),
        1,
        "child produced one call"
    );
    drop(worker);

    // Immediate settlement retains the exact Claim-bound row. The row is
    // terminal before the connection is reopened; no second dispatch occurs.
    let db = Database::open(&fixture.db_path).expect("reopen real SQLite");
    let (state, stored_intent_digest): (String, String) = db
        .connection()
        .query_row(
            "SELECT state, intent_digest FROM external_effect_journal
             WHERE instance_id = ?1 AND module_id = ?2 AND operation_id = ?3",
            rusqlite::params![b.instance_id, b.module_id, b.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("retained intent row");
    assert_eq!(state, EffectJournalState::Applied.wire_name());
    assert_eq!(stored_intent_digest, intent_digest.to_canonical_string());
    drop(db);

    // REAL Worker restart: startup settlement reads only the authoritative
    // REAL Worker restart runs reopen recovery and retains the terminal row;
    // it never re-dispatches the child.
    let restarted = fixture.start_worker();
    drop(restarted);
    let db = Database::open(&fixture.db_path).expect("reopen after restart");
    let state_after_restart: String = db
        .connection()
        .query_row(
            "SELECT state FROM external_effect_journal
             WHERE instance_id = ?1 AND module_id = ?2 AND operation_id = ?3",
            rusqlite::params![b.instance_id, b.module_id, b.operation_id],
            |row| row.get(0),
        )
        .expect("retained row after restart");
    assert_eq!(state_after_restart, EffectJournalState::Applied.wire_name());
    drop(db);
    assert_eq!(
        count_child_calls(&fixture.package_root),
        1,
        "restart settlement never re-dispatched a child effect"
    );
}

/// A persisted AUTHORIZED + INTENDED pair is recovered by the real Worker
/// startup path. Reopen may only settle UNKNOWN/NOT_APPLIED; it never starts
/// a replacement child request.
#[test]
fn worker_reopen_recovers_persisted_authorized_without_redispatch() {
    let fixture = Fixture::new(false);
    let binding = fixture.binding(8);
    let ledger = ledger_authorized(&binding);
    let mut worker = fixture.start_worker();
    fixture.preload_ledger(&mut worker, &[ledger.clone()]);
    let frame = request_frame(&binding);
    let intent = worker
        .intent_record_for_test(&ledger, &frame)
        .expect("mint persisted Claim intent");
    worker
        .insert_intent_for_test(&intent)
        .expect("persist Claim intent");
    drop(worker);
    assert_eq!(count_child_calls(&fixture.package_root), 0);

    let restarted = fixture.start_worker();
    drop(restarted);
    let db = Database::open(&fixture.db_path).expect("reopen recovered database");
    let ledger_after = load_ledger_exact(
        db.connection(),
        &binding.module_id,
        &binding.operation_id,
    )
    .expect("load recovered ledger")
    .expect("ledger row retained");
    assert_ne!(ledger_after.state, LedgerState::Authorized);
    let journal_state: String = db
        .connection()
        .query_row(
            "SELECT state FROM external_effect_journal
             WHERE instance_id = ?1 AND module_id = ?2 AND operation_id = ?3",
            rusqlite::params![binding.instance_id, binding.module_id, binding.operation_id],
            |row| row.get(0),
        )
        .expect("recovered journal row");
    assert_ne!(journal_state, EffectJournalState::Intended.wire_name());
    assert_eq!(count_child_calls(&fixture.package_root), 0);
}

/// 2. crash settlement: the child I/O happened (marker written) but never
///    produced the outcome; the durable INTENDED intent exists at the crash
///    point, and a real Worker restart settles it UNKNOWN_OUTCOME — the
///    ambiguity evidence is retained, never re-dispatched.
#[test]
fn crash_mid_dispatch_settles_unknown_outcome_and_never_redispatches() {
    let fixture = Fixture::new(true); // silent child: exits after tools/call I/O
    let b = fixture.binding(2);
    let ledger = ledger_authorized(&b);
    let mut worker = fixture.start_worker();
    fixture.preload_ledger(&mut worker, &[ledger.clone()]);
    let old_extension_generation = worker.process_generation().extension_generation().value();
    let frame = request_frame(&b);
    let result = worker.dispatch_tools_call(&ledger, &frame);
    // The silent child performs the tools/call I/O (writes the marker) then
    // exits without a response. The dispatch fails closed: either the
    // transport error surfaces, or the row settles terminal Unknown (the
    // unambiguous "request sent, no outcome" case). Both are correct fail-
    // closed behavior; what matters is that the child was touched once and
    // the durable intent is left for restart settlement.
    match &result {
        Err(_) => {}
        Ok(DispatchOutcome::Terminalized { record }) if record.state.is_terminal() => {}
        other => panic!("child I/O with no outcome must fail closed, got {other:?}"),
    }
    drop(worker);

    // Immediate settlement retains the ambiguity as a terminal journal row.
    let db = Database::open(&fixture.db_path).expect("reopen");
    let state: String = db
        .connection()
        .query_row(
            "SELECT state FROM external_effect_journal
             WHERE instance_id = ?1 AND module_id = ?2 AND operation_id = ?3",
            rusqlite::params![b.instance_id, b.module_id, b.operation_id],
            |row| row.get(0),
        )
        .expect("retained ambiguity row");
    assert_ne!(state, EffectJournalState::Intended.wire_name());

    drop(db);
    // Real Worker restart settles the ambiguity from the authoritative ledger
    let restarted = fixture.start_worker();
    assert_ne!(
        restarted
            .process_generation()
            .extension_generation()
            .value(),
        old_extension_generation
    );
    drop(restarted);
    let db = Database::open(&fixture.db_path).expect("reopen after restart");
    let old_process_records: i64 = db
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM process_generation_authority_records
             WHERE instance_id = ?1 AND extension_generation = ?2",
            rusqlite::params![b.instance_id.as_str(), old_extension_generation as i64],
            |row| row.get(0),
        )
        .expect("old process record after reopen");
    assert_eq!(old_process_records, 1);
    let state_after_restart: String = db
        .connection()
        .query_row(
            "SELECT state FROM external_effect_journal
             WHERE instance_id = ?1 AND module_id = ?2 AND operation_id = ?3",
            rusqlite::params![b.instance_id, b.module_id, b.operation_id],
            |row| row.get(0),
        )
        .expect("row present after restart");
    assert_ne!(
        state_after_restart,
        EffectJournalState::Intended.wire_name(),
        "reopen recovery leaves no live intent"
    );
    drop(db);
    assert_eq!(
        count_child_calls(&fixture.package_root),
        1,
        "the child effect was never re-dispatched"
    );
}

/// 3. stale identity rejection: a second dispatch of the SAME Claim is refused
///    before any child I/O (a new attempt requires a new Claim), even in the
///    live worker.
#[test]
fn stale_claim_is_rejected_before_child_io_no_redispatch() {
    let fixture = Fixture::new(false);
    let b = fixture.binding(3);
    let ledger = ledger_authorized(&b);
    let mut worker = fixture.start_worker();
    fixture.preload_ledger(&mut worker, &[ledger.clone()]);
    let frame = request_frame(&b);
    let first = worker
        .dispatch_tools_call(&ledger, &frame)
        .expect("first dispatch succeeds");
    assert!(matches!(first, DispatchOutcome::Terminalized { .. }));
    assert_eq!(count_child_calls(&fixture.package_root), 1);

    // The same Claim is already durably recorded: replay refused closed, and
    // the child stays untouched.
    let second = worker.dispatch_tools_call(&ledger, &frame);
    assert!(
        matches!(second, Err(dolly_worker::WorkerError::Premise(_))),
        "same-Claim replay must be refused closed, got {second:?}"
    );
    assert_eq!(
        count_child_calls(&fixture.package_root),
        1,
        "the refused replay never reached the child"
    );
}

/// 4. capacity behavior: a journal at the authoritative whole-journal cap with
///    no safe pruning refuses the intent STORAGE_FULL before any child I/O.
#[test]
fn journal_at_capacity_fails_closed_before_child_io() {
    let fixture = Fixture::new(false);
    let b = fixture.binding(4);
    let ledger = ledger_authorized(&b);
    let mut worker = fixture.start_worker();
    fixture.preload_ledger(&mut worker, &[ledger.clone()]);

    // Fill the durable journal to the cap with INTENDED rows (no ledger
    // evidence, so startup settlement turns them UNKNOWN_OUTCOME — still
    // undeletable, still at the cap).
    for i in 0..MAX_EFFECT_JOURNAL_ROWS {
        let record = capacity_intent(format!("prefill-{i}"));
        worker
            .insert_intent_for_test(&record)
            .expect("prefill insert");
    }

    // Real Worker start settles the prefill (all UNKNOWN_OUTCOME) — still a
    // full, undeletable journal. Dispatch must fail closed STORAGE_FULL
    // before any child I/O.
    let frame = request_frame(&b);
    match worker.dispatch_tools_call(&ledger, &frame) {
        Err(dolly_worker::WorkerError::Storage(detail)) => {
            assert!(
                detail.contains("STORAGE_FULL"),
                "expected STORAGE_FULL refusal, got {detail:?}"
            );
        }
        other => panic!("expected WorkerError::Storage(Full), got {other:?}"),
    }
    assert_eq!(
        count_child_calls(&fixture.package_root),
        0,
        "the intent was refused before the child was ever touched"
    );
}

/// A real post-spawn Claim persistence failure must terminate and reap the
/// child before Worker startup returns. The observer only records the PID;
/// it cannot perform child I/O or own the process.
#[cfg(target_os = "linux")]
#[test]
fn startup_storage_full_reaps_child_before_returning_error() {
    LAST_SPAWNED_PID.store(0, Ordering::SeqCst);
    let fixture = Fixture::new(false);
    {
        let mut db = Database::open(&fixture.db_path).expect("open fixture database");
        fill_journal_capacity(&mut db);
    }

    let error = match fixture.start_worker_with_observer(remember_spawned_pid) {
        Ok(_) => panic!("startup Claim persistence unexpectedly succeeded at capacity"),
        Err(error) => error,
    };
    match error {
        dolly_worker::WorkerError::Storage(detail) => {
            assert!(
                detail.contains("STORAGE_FULL"),
                "unexpected storage error: {detail}"
            );
        }
        other => panic!("startup capacity failure had wrong class: {other:?}"),
    }
    let pid = LAST_SPAWNED_PID.load(Ordering::SeqCst);
    assert!(pid > 0, "startup observer must see the real spawned child");
    assert_process_reaped(pid);
    assert_eq!(
        count_child_calls(&fixture.package_root),
        0,
        "startup failure happened before any child protocol I/O"
    );
}
