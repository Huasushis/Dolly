//! Shared real-SQLite fixtures for the coordinator integration tests.

use dolly_canonical_json::{CanonicalJsonObject, Sha256Digest, canonicalize};
use dolly_storage::tool_ledger::{
    LedgerInsertDisposition, create_tool_ledger_schema, insert_authorized,
};
use dolly_storage::Database;
use dolly_tool_broker::{
    ConfirmationDecision, IdempotencyPolicy, LedgerState, RecoveryFacts, SideEffectClass,
    ToolCallLedgerRecord, ToolOperationBinding, ToolOperationBindingSchemaTag,
};
use dolly_tool_coordinator::{
    DispatchOutcome, RecoveryFactsProvider, dispatch_operation,
};
use rusqlite::Connection;
use serde_json::json;

pub fn digest(hex: u8) -> Sha256Digest {
    format!("sha256:{:064x}", hex as u128)
        .parse()
        .expect("valid digest")
}

pub fn server_contract() -> CanonicalJsonObject {
    // Self-consistent frozen output contract: the digest is recomputed from
    // the exact document so the service's frozen-contract validation passes
    // for schema-valid outputs.
    let output_schema = json!({"type": "object", "additionalProperties": false, "required": ["ok"], "properties": {"ok": {"type": "boolean"}}});
    let output_schema_digest = canonicalize(&serde_json::to_value(&output_schema).unwrap())
        .expect("canonicalizable schema")
        .1
        .to_canonical_string();
    let server = json!({
        "enabled": true,
        "adapter": "mcp",
        "protocol_version": "2025-06-18",
        "transport": {
            "kind": "stdio",
            "package_id": "org.dolly.tools.fs",
            "package_version": "1.0.0",
            "package_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "executable": "bin/dolly-fs-tools",
            "executable_digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            "args": ["--stdio"],
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
                "input_schema": {"type": "object", "additionalProperties": false, "properties": {"path": {"type": "string", "minLength": 1, "maxLength": 4096}}},
                "input_schema_digest": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
                "output_schema": output_schema,
                "output_schema_digest": output_schema_digest,
                "side_effect_class": "non_idempotent_write",
                "idempotency": {"kind": "none"},
                "requires_confirmation": false,
                "enabled": true
            }
        }
    });
    serde_json::from_value(server).expect("server contract fixture")
}

pub fn binding(
    operation_id: &str,
    server_request_id: &str,
    request_digest: Sha256Digest,
) -> ToolOperationBinding {
    ToolOperationBinding {
        schema: ToolOperationBindingSchemaTag,
        instance_id: "c-inst-0001".into(),
        module_id: "module-a".into(),
        operation_id: operation_id.into(),
        tool_transaction_id: "0198ab31-6c44-7e8a-b2bb-000000000099".into(),
        activation_id: "0198ab31-6c44-7e8a-b2bb-000000000101".into(),
        activation_lease_generation: 1,
        config_revision: 11,
        tool_server_id: "fs".into(),
        tool_name: "read-file".into(),
        tool_schema_digest: digest(0x44),
        arguments: serde_json::from_value(json!({"path": "notes/example.txt"})).unwrap(),
        side_effect_class: SideEffectClass::NonIdempotentWrite,
        idempotency: IdempotencyPolicy::None,
        idempotency_key: None,
        authorized_deadline: "2026-08-21T00:00:00.000000Z".into(),
        request_digest,
        tool_server_generation: 7,
        server_request_id: server_request_id.into(),
        server_contract: server_contract(),
        confirmation_decision: ConfirmationDecision::NotRequired,
    }
}

/// Build a field-consistent record with recomputed digests.
pub fn build_record(
    state: LedgerState,
    outbound_present: bool,
    terminal_result: Option<dolly_tool_broker::ToolResult>,
    binding: &ToolOperationBinding,
) -> ToolCallLedgerRecord {
    let outbound_digest = if outbound_present {
        Some(binding.recompute_outbound_digest().expect("payload"))
    } else {
        None
    };
    let terminal_result_digest = terminal_result
        .as_ref()
        .map(|result| canonicalize(result).expect("canonicalizable").1);
    let record = ToolCallLedgerRecord {
        schema: dolly_tool_broker::ToolCallLedgerRecordSchemaTag,
        ledger_revision: state.default_ledger_revision(),
        state,
        operation_binding: binding.clone(),
        operation_digest: binding.operation_digest(),
        outbound_digest,
        terminal_result,
        terminal_result_digest,
    };
    // FAILED for TOOL_DISPATCH_NOT_APPLIED is revision 2 with outbound null.
    let record = match state {
        LedgerState::Failed => {
            let not_applied = record
                .terminal_result
                .as_ref()
                .and_then(|r| r.error.as_ref())
                .map(|e| e.code == dolly_tool_broker::ToolErrorCode::DispatchNotApplied)
                .unwrap_or(false);
            if not_applied {
                ToolCallLedgerRecord {
                    ledger_revision: 2,
                    outbound_digest: None,
                    ..record
                }
            } else {
                record
            }
        }
        _ => record,
    };
    record
        .verify_field_combination()
        .expect("fixture must be field-consistent");
    record
}

pub fn authorized_record(operation_id: &str, server_request_id: &str) -> ToolCallLedgerRecord {
    let request_digest = Sha256Digest::compute(operation_id.as_bytes());
    let binding = binding(operation_id, server_request_id, request_digest);
    build_record(LedgerState::Authorized, false, None, &binding)
}

pub fn open_db(dir: &std::path::Path) -> Database {
    let path = dir.join("instance.sqlite");
    let db = Database::open(&path).expect("open real bundled SQLite");
    create_tool_ledger_schema(db.connection()).expect("authoritative ledger schema");
    db
}

pub fn seed_parents(conn: &Connection) {
    conn.execute(
        "INSERT OR IGNORE INTO activations (activation_id) VALUES (?1)",
        rusqlite::params!["0198ab31-6c44-7e8a-b2bb-000000000101"],
    )
    .expect("seed activation");
    conn.execute(
        "INSERT OR IGNORE INTO config_revisions (config_revision) VALUES (?1)",
        rusqlite::params![11_i64],
    )
    .expect("seed config revision");
}

pub fn insert_authorized_row(db: &mut Database, record: &ToolCallLedgerRecord) {
    seed_parents(db.connection());
    match insert_authorized(db.connection_mut(), record).expect("insert must succeed") {
        LedgerInsertDisposition::Inserted { .. } => {}
        LedgerInsertDisposition::Replayed { .. } => panic!("expected a new row"),
    }
}

pub fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

/// A fixed (pure) facts provider: the coordinator only reads facts; no
/// downstream ACK/result/error/absence is consulted.
pub struct FixedFacts(pub RecoveryFacts);

impl RecoveryFactsProvider for FixedFacts {
    fn facts_for(&self, _row: &ToolCallLedgerRecord) -> RecoveryFacts {
        self.0
    }
}

/// Coordinate a permit-eligible dispatch and consume the permit once.
pub fn dispatch_with_proof(
    db: &mut Database,
    record: &ToolCallLedgerRecord,
) -> dolly_tool_coordinator::SendPermitBinding {
    let facts = RecoveryFacts {
        zero_bytes_proved: true,
        exact_generation_ready: true,
        deadline_expired: false,
    };
    match dispatch_operation(db, record, &facts).expect("dispatch must settle") {
        DispatchOutcome::Dispatched { record: _, permit } => permit
            .expect("permit after committed proof dispatch")
            .consume(),
        other => panic!("expected Dispatched, got {other:?}"),
    }
}

pub const OP_A: &str = "0198ab31-6c44-7e8a-b2bb-000000000400";
pub const OP_B: &str = "0198ab31-6c44-7e8a-b2bb-000000000401";
pub const REQ: &str = "0198ab31-6c44-7e8a-b2bb-000000000450";
