#![cfg(any())]

//! The Worker integration fixture is intentionally kept test-only. Production
//! startup and dispatch have no test-only feature, proof constructor, or
//! environment-controlled abort seam. Durable crash/reopen and canonical
//! journal contracts are exercised in the storage and broker suites.

use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_storage::Database;
use dolly_storage::effect_journal::{
    EffectJournalInsertDisposition, enumerate_pending, insert_intent, load_exact,
};
use dolly_storage::host_authority::{
    ConfigRevisionMapping, HostAuthorityRevision, InstalledComponentOrigin, LinuxServiceCandidate,
    ModuleActivationPremises, ResolvedConfiguration, RuntimeAuthorityIdentity,
    load_current_authority,
};
use dolly_storage::tool_ledger::{
    LedgerInsertDisposition, create_tool_ledger_schema, insert_authorized,
};
use dolly_tool_broker::effect_journal::{
    Claim, ClaimRecordSchemaTag, EffectClass, EffectJournalRecordSchemaTag, EffectJournalState,
    ExternalEffectJournalRecord, derive_claim_token,
};
use dolly_tool_broker::{
    ConfirmationDecision, IdempotencyPolicy, LedgerState, RecoveryFacts, SideEffectClass,
    ToolCallLedgerRecord, ToolCallLedgerRecordSchemaTag, ToolOperationBinding,
    ToolOperationBindingSchemaTag,
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

fn facts_proof() -> RecoveryFacts {
    RecoveryFacts::for_authorized_dispatch()
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

    fn preload_ledger(&self, records: &[ToolCallLedgerRecord]) {
        let mut db = Database::open(&self.db_path).expect("reopen real SQLite");
        for record in records {
            match insert_authorized(db.connection_mut(), record).expect("preload ledger row") {
                LedgerInsertDisposition::Inserted { .. } => {}
                LedgerInsertDisposition::Replayed { .. } => {}
            }
        }
    }

    fn binding(&self, seed: u8) -> ToolOperationBinding {
        let contract =
            CanonicalJsonValue::try_from(self.server.clone()).expect("canonicalizable server");
        let mut binding = binding(&contract, seed);
        binding.instance_id = self.instance_id.clone();
        binding
    }

    fn start_worker(&self) -> Worker {
        let config = WorkerStartConfig {
            db_path: self.db_path.clone(),
            extension_alias: "org.dolly.tools".parse().expect("extension id"),
            server_id: "fs".into(),
            package_root: self.package_root.clone(),
            package_path: self.package_path.clone(),
        };
        Worker::start(config).expect("worker starts")
    }
}
