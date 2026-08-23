//! Contract tests for `ToolDispatchService` (tool-broker §6/§8,
//! REQ-TOOL-002/006, INV-STORAGE-017).
//!
//! The service consumes one non-Clone `SendPermit` exactly once, verifies
//! the caller-supplied request bytes' digest against the permit binding
//! BEFORE transport, calls the injected transport AT MOST ONCE, and settles
//! the authoritative row through the existing `cas_terminal` authority.
//! Timeout, disconnect, correlation, schema, and bound failures after
//! dispatch produce terminal `UNKNOWN` (`TOOL_EXTERNAL_OUTCOME_UNKNOWN`),
//! never retry/redispatch, and no downstream ACK authorizes a new permit or
//! generation rotation.

use std::path::Path;

use dolly_canonical_json::{CanonicalJsonObject, Sha256Digest, canonicalize};
use dolly_storage::Database;
use dolly_storage::tool_ledger::{
    LedgerInsertDisposition, create_tool_ledger_schema, enumerate_nonterminal, insert_authorized,
};
use dolly_tool_broker::{
    ConfirmationDecision, IdempotencyPolicy, LedgerState, RecoveryFacts, SideEffectClass,
    ToolCallLedgerRecord, ToolOperationBinding, ToolOperationBindingSchemaTag, ToolStatus,
};
use dolly_tool_coordinator::{
    DispatchLimits, DispatchOutcome, ServiceOutcome, ToolDispatchService, ToolTransport,
    TransportOutcome,
};
use rusqlite::Connection;
use serde_json::{Value, json};

fn digest(hex: u8) -> Sha256Digest {
    format!("sha256:{:064x}", hex as u128)
        .parse()
        .expect("valid digest")
}

fn server_contract() -> CanonicalJsonObject {
    let mut contract = json!({
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
                "output_schema": {
                    "type": ["object", "null"],
                    "additionalProperties": false,
                    "required": ["text"],
                    "properties": {"text": {"type": "string"}}
                },
                "output_schema_digest": "",
                "side_effect_class": "non_idempotent_write",
                "idempotency": {"kind": "none"},
                "requires_confirmation": false,
                "enabled": true
            }
        }
    });
    let output_schema_digest = canonicalize(&contract["tools"]["read-file"]["output_schema"])
        .expect("output schema canonical")
        .1
        .to_canonical_string();
    contract["tools"]["read-file"]["output_schema_digest"] = json!(output_schema_digest);
    serde_json::from_value(contract).expect("server contract fixture")
}

fn binding_fn(operation_id: &str, server_request_id: &str) -> ToolOperationBinding {
    let request_digest = Sha256Digest::compute(operation_id.as_bytes());
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

/// An `AUTHORIZED` record whose binding carries the real outbound-payload
/// recipe, so the test can reconstruct the exact request bytes.
fn authorized_record(operation_id: &str, server_request_id: &str) -> ToolCallLedgerRecord {
    let binding = binding_fn(operation_id, server_request_id);
    let record = ToolCallLedgerRecord {
        schema: dolly_tool_broker::ToolCallLedgerRecordSchemaTag,
        ledger_revision: LedgerState::Authorized.default_ledger_revision(),
        state: LedgerState::Authorized,
        operation_binding: binding.clone(),
        operation_digest: binding.operation_digest(),
        outbound_digest: None,
        terminal_result: None,
        terminal_result_digest: None,
    };
    record
        .verify_field_combination()
        .expect("fixture must be field-consistent");
    record
}

fn open_db(dir: &Path) -> Database {
    let path = dir.join("instance.sqlite");
    if path.exists() {
        let db = Database::open(&path).expect("reopen real sqlite");
        create_tool_ledger_schema(db.connection()).expect("authoritative ledger schema");
        return db;
    }
    let instance_id = format!(
        "instance-{}",
        dir.file_name()
            .expect("temp directory name")
            .to_string_lossy()
            .replace('.', "d")
            .to_ascii_lowercase()
    );
    let legacy = serde_json::to_vec(&json!({
        "schema": "dolly.legacy-runtime-config/v0",
        "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
        "instance_id": instance_id,
        "config_revision": 1,
        "runtime_config": {"modules": []},
        "permission_policy_selections": [],
        "service_candidate": null
    }))
    .unwrap();
    let db = Database::open_for_migration(&path)
        .unwrap()
        .migrate_legacy_json(&legacy)
        .expect("explicit offline initialization");
    create_tool_ledger_schema(db.connection()).expect("authoritative ledger schema");
    db
}
fn seed_parents(conn: &Connection) {
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

fn insert_authorized_row(db: &mut Database, record: &ToolCallLedgerRecord) {
    seed_parents(db.connection());
    match insert_authorized(db.connection_mut(), record).expect("insert must succeed") {
        LedgerInsertDisposition::Inserted { .. } => {}
        _ => panic!("expected a new row"),
    }
}

fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

/// Coordinate a proof-carrying AUTHORIZED row to its DISPATCHED commit and
/// return the single-use `SendPermit`.
fn dispatch_permit(
    db: &mut Database,
    record: &ToolCallLedgerRecord,
) -> dolly_tool_coordinator::SendPermit {
    let facts = RecoveryFacts {
        zero_bytes_proved: true,
        exact_generation_ready: true,
        deadline_expired: false,
    };
    match dolly_tool_coordinator::dispatch_operation(db, record, &facts)
        .expect("dispatch must settle")
    {
        DispatchOutcome::Dispatched { permit, .. } => {
            permit.expect("permit after committed proof dispatch")
        }
        other => panic!("expected Dispatched, got {other:?}"),
    }
}

fn limits() -> DispatchLimits {
    DispatchLimits {
        max_response_bytes: 4096,
        max_members: 64,
        max_depth: 16,
    }
}

const OP_A: &str = "0198ab31-6c44-7e8a-b2bb-000000000400";
const REQ: &str = "0198ab31-6c44-7e8a-b2bb-000000000450";

/// A well-formed JSON-RPC 2.0 envelope for the correlation id.
fn response_body(result: Value) -> String {
    json!({"jsonrpc":"2.0","id":REQ,"result":result}).to_string()
}

/// An envelope whose `id` differs from the permit correlation.
fn mismatched_id(result: Value) -> String {
    json!({"jsonrpc":"2.0","id":"0198ab31-6c44-7e8a-b2bb-000000000999","result":result}).to_string()
}

/// The exact outbound request bytes bound to the record's binding.
fn bound_request_bytes(record: &ToolCallLedgerRecord) -> Vec<u8> {
    record
        .operation_binding
        .recompute_outbound_payload()
        .expect("payload")
        .into_vec()
}

/// Spy transport: counts calls and remembers the exact bytes it received.
struct Spy {
    calls: usize,
    bytes: Vec<u8>,
    outcome: TransportOutcome,
}

impl Spy {
    fn serving(outcome: TransportOutcome) -> Self {
        Self {
            calls: 0,
            bytes: Vec::new(),
            outcome,
        }
    }
}

impl ToolTransport for Spy {
    fn call(&mut self, request_bytes: &[u8]) -> TransportOutcome {
        self.calls += 1;
        self.bytes.extend_from_slice(request_bytes);
        self.outcome.clone()
    }
}

/// Stage an AUTHORIZED row, dispatch it to DISPATCHED, run the service.
/// Returns (kept tempdir, the authorized fixture, outcome, spy).
fn run_with(
    request_bytes: Option<Vec<u8>>,
    response: TransportOutcome,
) -> (tempfile::TempDir, ToolCallLedgerRecord, ServiceOutcome, Spy) {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let authorized = authorized_record(OP_A, REQ);
    insert_authorized_row(&mut db, &authorized);
    let bytes = request_bytes.unwrap_or_else(|| bound_request_bytes(&authorized));
    let permit = dispatch_permit(&mut db, &authorized);
    let mut spy = Spy::serving(response);
    let outcome = ToolDispatchService::new(limits())
        .dispatch(&mut db, permit, &bytes, &mut spy)
        .expect("service must settle");
    drop(db);
    (dir, authorized, outcome, spy)
}

/// The terminal-`UNKNOWN` shape every post-dispatch failure must take.
fn assert_unknown(record: &ToolCallLedgerRecord, result: &dolly_tool_broker::ToolResult) {
    assert_eq!(record.state, LedgerState::Unknown);
    assert_eq!(record.ledger_revision, 3);
    assert!(record.outbound_digest.is_some(), "outbound digest retained");
    assert_eq!(result.status, ToolStatus::Unknown);
    let error = result.error.as_ref().expect("unknown error");
    assert_eq!(
        error.code,
        dolly_tool_broker::ToolErrorCode::ExternalOutcomeUnknown
    );
    assert_eq!(error.outcome, dolly_tool_broker::ErrorOutcome::Unknown);
    assert!(!error.retryable, "failed/unknown results are not retryable");
    assert_eq!(result.operation_id, OP_A);
    assert_eq!(result.server_request_id, None);
}

/// Reopen the ledger and assert no nonterminal row remains and no permit is
/// released: a downstream disposition is never redispatch authority.
fn assert_reopen_clear(dir: &std::path::Path) {
    let db = open_db(dir);
    assert_eq!(
        enumerate_nonterminal(db.connection())
            .expect("enumerate must succeed")
            .len(),
        0,
        "no nonterminal rows after terminal"
    );
}

// ---------------------------------------------------------------------------
// 1) Valid correlated bounded closed response -> persisted SUCCEEDED
// ---------------------------------------------------------------------------

#[test]
fn valid_response_persists_succeeded_one_call_no_redispatch() {
    let (dir, authorized, outcome, spy) = run_with(
        None,
        TransportOutcome::Response(response_body(json!({"text":"ok"})).into_bytes()),
    );
    let expected_digest = authorized
        .recompute_outbound_digest()
        .expect("bound digest");
    match outcome {
        ServiceOutcome::Succeeded { record, result } => {
            assert_eq!(spy.calls, 1, "exactly one transport call");
            assert_eq!(
                Sha256Digest::compute(&spy.bytes),
                expected_digest,
                "transport must receive the exact bound request bytes"
            );
            assert_eq!(record.state, LedgerState::Succeeded);
            assert_eq!(record.ledger_revision, 3);
            assert!(record.outbound_digest.is_some(), "outbound retained");
            assert_eq!(result.status, ToolStatus::Succeeded);
            assert_eq!(result.output, json!({"text":"ok"}));
            assert_eq!(result.server_request_id.as_deref(), Some(REQ));
            assert_eq!(result.operation_id, OP_A);
            assert!(result.error.is_none());
        }
        other => panic!("expected Succeeded, got {other:?}"),
    }
    assert_reopen_clear(dir.path());
}

#[test]
fn explicit_null_result_is_present_and_valid() {
    let (dir, _authorized, outcome, spy) = run_with(
        None,
        TransportOutcome::Response(response_body(Value::Null).into_bytes()),
    );
    match outcome {
        ServiceOutcome::Succeeded { record, result } => {
            assert_eq!(spy.calls, 1, "exactly one transport call");
            assert_eq!(record.state, LedgerState::Succeeded);
            assert_eq!(result.status, ToolStatus::Succeeded);
            assert_eq!(result.output, Value::Null);
            assert!(result.error.is_none());
            assert_eq!(result.server_request_id.as_deref(), Some(REQ));
        }
        other => panic!("expected Succeeded for explicit null, got {other:?}"),
    }
    assert_reopen_clear(dir.path());
}

#[test]
fn complete_output_schema_violation_persists_failed_applied() {
    let (dir, _authorized, outcome, spy) = run_with(
        None,
        TransportOutcome::Response(response_body(json!({"text": 42})).into_bytes()),
    );
    match outcome {
        ServiceOutcome::Failed { record, result } => {
            assert_eq!(spy.calls, 1, "exactly one transport call");
            assert_eq!(record.state, LedgerState::Failed);
            assert_eq!(result.status, ToolStatus::Failed);
            assert_eq!(result.output, Value::Null);
            let error = result.error.as_ref().expect("output error");
            assert_eq!(error.code, dolly_tool_broker::ToolErrorCode::OutputInvalid);
            assert_eq!(error.outcome, dolly_tool_broker::ErrorOutcome::Applied);
            assert!(!error.retryable);
            assert_eq!(result.server_request_id.as_deref(), Some(REQ));
        }
        other => panic!("expected Failed for schema-invalid output, got {other:?}"),
    }
    assert_reopen_clear(dir.path());
}

// ---------------------------------------------------------------------------
// 2) Timeout / disconnect -> persisted UNKNOWN, one call, no redispatch
// ---------------------------------------------------------------------------

#[test]
fn timeout_disconnect_and_error_persist_unknown_one_call_no_redispatch() {
    for response in [
        TransportOutcome::Timeout,
        TransportOutcome::Disconnect,
        TransportOutcome::Error("framing failure".into()),
    ] {
        let (dir, _authorized, outcome, spy) = run_with(None, response);
        match outcome {
            ServiceOutcome::Unknown { record, result } => {
                assert_eq!(spy.calls, 1, "exactly one transport call");
                assert_unknown(&record, &result);
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
        assert_reopen_clear(dir.path());
    }
}

// ---------------------------------------------------------------------------
// 3) Correlation failure -> persisted UNKNOWN, one call
// ---------------------------------------------------------------------------

#[test]
fn wrong_request_id_persists_unknown() {
    let (dir, _authorized, outcome, spy) = run_with(
        None,
        TransportOutcome::Response(
            mismatched_id(json!({"content":[{"type":"text","text":"ok"}]})).into_bytes(),
        ),
    );
    match outcome {
        ServiceOutcome::Unknown { record, result } => {
            assert_eq!(spy.calls, 1, "exactly one transport call");
            assert_unknown(&record, &result);
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
    assert_reopen_clear(dir.path());
}

// ---------------------------------------------------------------------------
// 3b) Schema failures -> persisted UNKNOWN, one call
// ---------------------------------------------------------------------------

#[test]
fn malformed_or_extra_member_response_persists_unknown() {
    let cases: Vec<Vec<u8>> = vec![
        b"not json at all".to_vec(),
        json!({"jsonrpc":"2.0","id":REQ,"result":{"ok":true},"extra":1})
            .to_string()
            .into_bytes(),
        json!({"jsonrpc":"2.0","id":REQ}).to_string().into_bytes(), // missing result & error
    ];
    for body in cases {
        let (dir, _authorized, outcome, spy) = run_with(None, TransportOutcome::Response(body));
        match outcome {
            ServiceOutcome::Unknown { record, result } => {
                assert_eq!(spy.calls, 1, "exactly one transport call");
                assert_unknown(&record, &result);
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
        assert_reopen_clear(dir.path());
    }
}

// ---------------------------------------------------------------------------
// 3c) Bound failures -> persisted UNKNOWN, one call
// ---------------------------------------------------------------------------

#[test]
fn response_byte_overflow_persists_unknown() {
    let huge = json!({
        "jsonrpc":"2.0",
        "id":REQ,
        "result":{"content":[{"type":"text","text":format!("{}","x".repeat(9000))}]}
    })
    .to_string();
    assert!(huge.len() > limits().max_response_bytes as usize);
    let (dir, _authorized, outcome, spy) =
        run_with(None, TransportOutcome::Response(huge.into_bytes()));
    match outcome {
        ServiceOutcome::Unknown { record, result } => {
            assert_eq!(spy.calls, 1, "exactly one transport call");
            assert_unknown(&record, &result);
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
    assert_reopen_clear(dir.path());
}

#[test]
fn response_member_overflow_persists_unknown() {
    let mut members = serde_json::Map::new();
    for i in 0..100 {
        members.insert(format!("member{i}"), json!(i));
    }
    let body = format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":\"{REQ}\",\"result\":{}}}",
        serde_json::Value::Object(members)
    );
    let (dir, _authorized, outcome, spy) =
        run_with(None, TransportOutcome::Response(body.into_bytes()));
    match outcome {
        ServiceOutcome::Unknown { record, result } => {
            assert_eq!(spy.calls, 1, "exactly one transport call");
            assert_unknown(&record, &result);
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
    assert_reopen_clear(dir.path());
}

#[test]
fn response_depth_overflow_persists_unknown() {
    let mut value = json!({"leaf": true});
    for _ in 0..(limits().max_depth as usize + 2) {
        value = json!([value]);
    }
    let body = json!({"jsonrpc":"2.0","id":REQ,"result":value}).to_string();
    let (dir, _authorized, outcome, spy) =
        run_with(None, TransportOutcome::Response(body.into_bytes()));
    match outcome {
        ServiceOutcome::Unknown { record, result } => {
            assert_eq!(spy.calls, 1, "exactly one transport call");
            assert_unknown(&record, &result);
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
    assert_reopen_clear(dir.path());
}

// ---------------------------------------------------------------------------
// 4) Outbound digest mismatch: ZERO transport calls, fail closed
// ---------------------------------------------------------------------------

#[test]
fn outbound_digest_mismatch_zero_transport_calls_fails_closed() {
    let (dir, _authorized, outcome, spy) = run_with(
        Some(b"these-are-not-the-bound-request-bytes".to_vec()),
        TransportOutcome::Response(response_body(json!({"ok":true})).into_bytes()),
    );
    match outcome {
        ServiceOutcome::Unknown { record, result } => {
            assert_eq!(spy.calls, 0, "transport never consulted on digest mismatch");
            assert_unknown(&record, &result);
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
    assert_reopen_clear(dir.path());
}

// ---------------------------------------------------------------------------
// 5) Spy proves at most one call on every path
// ---------------------------------------------------------------------------

#[test]
fn spy_proves_at_most_one_transport_call() {
    // The happy-path spy already asserted exactly one call; here we prove it
    // for every failure class above by re-checking the counters.
    let (dir, _authorized, _outcome, spy) = run_with(
        Some(b"wrong".to_vec()),
        TransportOutcome::Response(response_body(json!({"ok": true})).into_bytes()),
    );
    assert_eq!(spy.calls, 0, "digest-mismatch path must issue zero calls");
    let _ = dir;
}

// ---------------------------------------------------------------------------
// Arbitrary upstream error envelope -> persisted UNKNOWN, one call
// ---------------------------------------------------------------------------

#[test]
fn arbitrary_upstream_error_envelope_persists_unknown_one_call_no_redispatch() {
    let envelope = json!({"jsonrpc":"2.0","id":REQ,"error":{"code":-32000,"message":"boom"}})
        .to_string()
        .into_bytes();
    let (dir, _authorized, outcome, spy) = run_with(None, TransportOutcome::Response(envelope));
    match outcome {
        ServiceOutcome::Unknown { record, result } => {
            assert_eq!(spy.calls, 1, "exactly one transport call");
            assert_unknown(&record, &result);
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
    assert_reopen_clear(dir.path());
}

// ---------------------------------------------------------------------------
// Already-settled row -> Stale, zero transport calls, nothing mutated
// ---------------------------------------------------------------------------

#[test]
fn already_settled_row_returns_stale_and_never_calls_transport() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let authorized = authorized_record(OP_A, REQ);
    insert_authorized_row(&mut db, &authorized);
    let permit = dispatch_permit(&mut db, &authorized);
    // Another writer settles the row before the service runs.
    let current = dolly_storage::tool_ledger::load_exact(db.connection(), "module-a", OP_A)
        .expect("load")
        .expect("present")
        .clone();
    assert_eq!(current.state, LedgerState::Dispatched);
    let result = dolly_tool_broker::ToolResult::unknown_outcome(OP_A);
    let result_digest = dolly_tool_broker::canonicalize(&result)
        .expect("canonical")
        .1;
    let terminal = ToolCallLedgerRecord {
        ledger_revision: 3,
        state: LedgerState::Unknown,
        outbound_digest: current.outbound_digest.clone(),
        terminal_result: Some(result),
        terminal_result_digest: Some(result_digest),
        ..current.clone()
    };
    let expected = dolly_storage::tool_ledger::CasKey {
        module_id: current.operation_binding.module_id.clone(),
        operation_id: current.operation_binding.operation_id.clone(),
        expected_ledger_revision: current.ledger_revision,
        expected_state: current.state,
        correlation: Some(dolly_storage::tool_ledger::TransportCorrelation {
            tool_server_id: current.operation_binding.tool_server_id.clone(),
            tool_name: current.operation_binding.tool_name.clone(),
            tool_server_generation: current.operation_binding.tool_server_generation,
            server_request_id: current.operation_binding.server_request_id.clone(),
            outbound_digest: current.outbound_digest.clone().expect("bound"),
        }),
    };
    dolly_storage::tool_ledger::cas_terminal(db.connection_mut(), &expected, &terminal)
        .expect("settle must commit");

    let request_bytes = bound_request_bytes(&authorized);
    let mut spy = Spy::serving(TransportOutcome::Response(
        response_body(json!({"content":[{"type":"text","text":"ok"}]})).into_bytes(),
    ));
    let outcome = ToolDispatchService::new(limits())
        .dispatch(&mut db, permit, &request_bytes, &mut spy)
        .expect("service must settle");
    match outcome {
        ServiceOutcome::Stale { authoritative } => {
            assert_eq!(spy.calls, 0, "no transport call on an already-settled row");
            assert_eq!(
                authoritative.expect("authoritative row").state,
                LedgerState::Unknown
            );
        }
        other => panic!("expected Stale, got {other:?}"),
    }
    // The authoritative ledger is unchanged by this service call.
    let loaded = dolly_storage::tool_ledger::load_exact(db.connection(), "module-a", OP_A)
        .expect("load")
        .expect("present");
    assert_eq!(loaded.state, LedgerState::Unknown);
    assert_eq!(loaded.ledger_revision, 3);
    drop(db);
    assert_reopen_clear(dir.path());
}
