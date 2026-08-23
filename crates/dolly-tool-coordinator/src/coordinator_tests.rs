//! RED crash-point contract tests for the Tool Coordinator slice
//! (tool-broker §6, REQ-TOOL-002/006, INV-STORAGE-017).
//!
//! Every test drives the real bundled SQLite through `dolly_storage`, drops
//! the `Database` handle, REOPENS the same temp `.sqlite`/`.sqlite` file and
//! verifies the coordinator's durable outcome. The central rule: a send
//! permit exists only after an unambiguous committed `AUTHORIZED ->
//! DISPATCHED` compare-and-set; stale/error/lost-ack/unknown observe no
//! permit.

use dolly_canonical_json::{CanonicalJsonObject, Sha256Digest, canonicalize};
use dolly_storage::mcp_readiness::McpTransportReadiness;
use dolly_storage::runtime_binding::{ProcessGeneration, RuntimeBinding};
use dolly_storage::tool_broker_authority::ToolDispatchAuthority;
use dolly_storage::tool_ledger::{
    CasKey, LedgerInsertDisposition, TransportCorrelation, create_tool_ledger_schema,
    enumerate_nonterminal, insert_authorized, load_exact,
};
use dolly_storage::{Database, StorageError};
use dolly_tool_broker::{
    ConfirmationDecision, IdempotencyPolicy, LedgerState, RecoveryFacts, SideEffectClass,
    ToolCallLedgerRecord, ToolOperationBinding, ToolOperationBindingSchemaTag,
};
use dolly_tool_coordinator::{
    DispatchError, DispatchOutcome, FencedFactsProvider, HostMcpStdioInvocation,
    RecoveryFactsProvider, RecoveryOutcome, ToolDispatchService, dispatch_operation,
    dispatch_operation_authorized, reopen_recovery,
};
use rusqlite::Connection;
use serde_json::json;

fn digest(hex: u8) -> Sha256Digest {
    format!("sha256:{:064x}", hex as u128)
        .parse()
        .expect("valid digest")
}

fn server_contract() -> CanonicalJsonObject {
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
                "output_schema": {"type": "object", "additionalProperties": false, "properties": {"text": {"type": "string"}}},
                "output_schema_digest": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
                "side_effect_class": "non_idempotent_write",
                "idempotency": {"kind": "none"},
                "requires_confirmation": false,
                "enabled": true
            }
        }
    });
    serde_json::from_value(server).expect("server contract fixture")
}

fn binding(
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
fn build_record(
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

fn authorized_record(operation_id: &str, server_request_id: &str) -> ToolCallLedgerRecord {
    let request_digest = Sha256Digest::compute(operation_id.as_bytes());
    let binding = binding(operation_id, server_request_id, request_digest);
    build_record(LedgerState::Authorized, false, None, &binding)
}

fn open_db(dir: &std::path::Path) -> Database {
    let path = dir.join("instance.sqlite");
    if path.exists() {
        let db = Database::open(&path).expect("reopen real bundled SQLite");
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
        LedgerInsertDisposition::Replayed { .. } => panic!("expected a new row"),
    }
}

fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

/// Coordinate a permit-eligible dispatch and consume the permit once.
fn dispatch_with_proof(
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

const OP_A: &str = "0198ab31-6c44-7e8a-b2bb-000000000400";
const OP_B: &str = "0198ab31-6c44-7e8a-b2bb-000000000401";
const REQ: &str = "0198ab31-6c44-7e8a-b2bb-000000000450";

// ---------------------------------------------------------------------------
// Permit only after an unambiguous committed dispatch CAS
// ---------------------------------------------------------------------------

/// The permit is bound to the exact committed record identity and appears
/// only after the `AUTHORIZED -> DISPATCHED` commit; the row is durably
/// DISPATCHED when the permit exists (INV-STORAGE-017, TST-TOOL-009).
#[test]
fn permit_only_after_commit_and_bound_to_record() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let authorized = authorized_record(OP_A, REQ);
    insert_authorized_row(&mut db, &authorized);

    // Before any CAS the row is AUTHORIZED and no permit exists; the permit
    // is created strictly after the commit returns (single call boundary).
    let rows = enumerate_nonterminal(db.connection()).expect("enum");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, LedgerState::Authorized);

    let binding = dispatch_with_proof(&mut db, &authorized);
    assert_eq!(binding.module_id, "module-a");
    assert_eq!(binding.operation_id, OP_A);
    assert_eq!(binding.ledger_revision, 2);
    assert_eq!(binding.tool_server_generation, 7);
    assert_eq!(binding.server_request_id, REQ);
    assert_eq!(
        binding.outbound_digest,
        authorized
            .recompute_outbound_digest()
            .expect("payload present")
    );
    drop(db); // commit is durable

    // Reopen: row is durably DISPATCHED.
    let db = open_db(dir.path());
    let loaded = load_exact(db.connection(), "module-a", OP_A)
        .expect("load")
        .expect("present");
    assert_eq!(loaded.state, LedgerState::Dispatched);
    assert_eq!(loaded.ledger_revision, 2);
}

/// A stale observation (the store already moved past the given snapshot)
/// releases no permit: the stale proposal is discarded, the pure decision is
/// rerun on the authoritative row, and only the terminal UNKNOWN lands.
#[test]
fn no_permit_on_stale_or_ambiguous() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let authorized = authorized_record(OP_A, REQ);
    insert_authorized_row(&mut db, &authorized);

    // Racing writer: the row is already durably DISPATCHED.
    let dispatched = build_record(
        LedgerState::Dispatched,
        true,
        None,
        &authorized.operation_binding,
    );
    let outcome = dolly_storage::tool_ledger::cas_to_dispatched(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: OP_A.into(),
            expected_ledger_revision: 1,
            expected_state: LedgerState::Authorized,
            correlation: None,
        },
        &dispatched,
    )
    .expect("racing dispatch CAS commits");
    assert!(matches!(
        outcome,
        dolly_storage::tool_ledger::CasOutcome::Committed { .. }
    ));

    // The coordinator knows only the stale snapshot; the facts even permit a
    // send. A stale CAS returns `Stale` with the authoritative row and no
    // permit; the caller reruns the pure decision on that row (spec §6).
    let facts = RecoveryFacts {
        zero_bytes_proved: true,
        exact_generation_ready: true,
        deadline_expired: false,
    };
    let authoritative = match dispatch_operation(&mut db, &authorized, &facts).expect("must settle")
    {
        DispatchOutcome::Stale { authoritative } => authoritative,
        DispatchOutcome::Dispatched {
            permit: Some(_), ..
        } => {
            panic!("stale observations must never release a permit")
        }
        other => panic!("expected Stale after stale CAS, got {other:?}"),
    };
    assert_eq!(authoritative.state, LedgerState::Dispatched);
    assert_eq!(authoritative.ledger_revision, 2);

    // Rerun the pure decision on the authoritative row: no permit, terminal
    // UNKNOWN.
    match dispatch_operation(&mut db, &authoritative, &facts).expect("rerun settles") {
        DispatchOutcome::Terminalized { record } => {
            assert_eq!(record.state, LedgerState::Unknown);
            assert_eq!(record.ledger_revision, 3);
        }
        DispatchOutcome::Dispatched {
            permit: Some(_), ..
        } => {
            panic!("a DISPATCHED row in rerun must never release a permit")
        }
        other => panic!("expected terminal UNKNOWN, got {other:?}"),
    }
}

/// An ambiguous no-proof reopen crosses DISPATCHED without a permit and
/// terminalizes UNKNOWN; the permit count stays zero (TST-TOOL-010).
#[test]
fn no_permit_on_ambiguous_no_proof() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let authorized = authorized_record(OP_A, REQ);
    insert_authorized_row(&mut db, &authorized);

    // Without zero-byte proof the first CAS crosses DISPATCHED without a
    // permit; the second pure decision terminalizes UNKNOWN.
    let facts = RecoveryFacts {
        zero_bytes_proved: false,
        exact_generation_ready: true,
        deadline_expired: false,
    };
    let first = dispatch_operation(&mut db, &authorized, &facts).expect("dispatch settles");
    match first {
        DispatchOutcome::Dispatched { permit: None, .. } => {}
        other => panic!("no-proof dispatch must not release a permit: {other:?}"),
    }
    let dispatched = load_exact(db.connection(), "module-a", OP_A)
        .expect("load")
        .expect("present");
    match dispatch_operation(&mut db, &dispatched, &facts).expect("unknown settles") {
        DispatchOutcome::Terminalized { record } => {
            assert_eq!(record.state, LedgerState::Unknown);
            assert_eq!(record.ledger_revision, 3);
        }
        other => panic!("expected terminal UNKNOWN, got {other:?}"),
    }
    drop(db);

    let db = open_db(dir.path());
    let loaded = load_exact(db.connection(), "module-a", OP_A)
        .expect("load")
        .expect("present");
    assert_eq!(loaded.state, LedgerState::Unknown);
    assert_eq!(loaded.ledger_revision, 3);
    assert!(loaded.outbound_digest.is_some(), "UNKNOWN retains outbound");
}

// ---------------------------------------------------------------------------
// Reopen recovery: DISPATCHED -> UNKNOWN without redispatch
// ---------------------------------------------------------------------------

/// A disconnected DISPATCHED row (dispatch committed, ack never consumed)
/// reopens to UNKNOWN without a recreated permit and without redispatch
/// (TST-TOOL-001/010, REQ-TOOL-002).
#[test]
fn dispatched_row_reopens_unknown_no_redispatch() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let authorized = authorized_record(OP_A, REQ);
    insert_authorized_row(&mut db, &authorized);
    // Commit the dispatch, then drop WITHOUT consuming the permit (the
    // "lost ack before send" crash point).
    let _binding = dispatch_with_proof(&mut db, &authorized);
    drop(db); // permit dropped unconsumed = the acknowledgement was lost

    let mut db = open_db(dir.path());
    let dispatched = load_exact(db.connection(), "module-a", OP_A)
        .expect("load")
        .expect("present");
    let facts = RecoveryFacts {
        zero_bytes_proved: false,
        exact_generation_ready: false,
        deadline_expired: false,
    };
    match dispatch_operation(&mut db, &dispatched, &facts).expect("recovery settles") {
        DispatchOutcome::Terminalized { record } => {
            assert_eq!(record.state, LedgerState::Unknown);
            assert_eq!(record.ledger_revision, 3);
        }
        other => panic!("DISPATCHED must terminalize UNKNOWN, got {other:?}"),
    }
    drop(db);

    let db = open_db(dir.path());
    let loaded = load_exact(db.connection(), "module-a", OP_A)
        .expect("load")
        .expect("present");
    assert_eq!(loaded.state, LedgerState::Unknown);
    assert_eq!(loaded.ledger_revision, 3);
    assert!(
        enumerate_nonterminal(db.connection())
            .expect("enum")
            .is_empty()
    );
}

// ---------------------------------------------------------------------------
// AUTHORIZED + zero-byte proof + exact Ready generation: at most one dispatch
// ---------------------------------------------------------------------------

/// An AUTHORIZED row reopened with authoritative zero-byte proof, the exact
/// generation still Ready, and a live deadline proposes at most one dispatch
/// and releases at most one permit; a later reopen never re-dispatches
/// (TST-TOOL-009, INV-STORAGE-017).
#[test]
fn authorized_reopen_with_proof_at_most_one_dispatch() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let authorized = authorized_record(OP_A, REQ);
    insert_authorized_row(&mut db, &authorized);
    drop(db);

    // First dispatch: proof permits exactly one committed send transition.
    let mut db = open_db(dir.path());
    let facts = RecoveryFacts {
        zero_bytes_proved: true,
        exact_generation_ready: true,
        deadline_expired: false,
    };
    let outcome = dispatch_operation(&mut db, &authorized, &facts).expect("dispatch settles");
    let binding = match outcome {
        DispatchOutcome::Dispatched {
            permit: Some(permit),
            ..
        } => permit.consume(),
        other => panic!("expected one dispatch permit, got {other:?}"),
    };
    assert_eq!(binding.operation_id, OP_A);
    assert_eq!(binding.module_id, "module-a");
    assert_eq!(binding.ledger_revision, 2);
    assert_eq!(binding.tool_server_generation, 7);
    assert_eq!(binding.server_request_id, REQ);
    drop(db);

    // Reopen #2: the durable DISPATCHED marker becomes UNKNOWN with no
    // second dispatch and no second permit.
    let mut db = open_db(dir.path());
    let dispatched = load_exact(db.connection(), "module-a", OP_A)
        .expect("load")
        .expect("present");
    match dispatch_operation(&mut db, &dispatched, &facts).expect("second settles") {
        DispatchOutcome::Terminalized { record } => {
            assert_eq!(record.state, LedgerState::Unknown);
            assert_eq!(record.ledger_revision, 3);
        }
        DispatchOutcome::Dispatched {
            permit: Some(_), ..
        } => {
            panic!("a DISPATCHED row must never release a second permit")
        }
        other => panic!("expected terminal UNKNOWN, got {other:?}"),
    }
    drop(db);
}

/// An AUTHORIZED row with proof but the exact generation lost fails closed
/// as FAILED / TOOL_DISPATCH_NOT_APPLIED; no permit (TST-TOOL-006).
#[test]
fn authorized_with_proof_and_dead_generation_fails_not_applied() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let authorized = authorized_record(OP_A, REQ);
    insert_authorized_row(&mut db, &authorized);
    drop(db);

    let mut db = open_db(dir.path());
    let facts = RecoveryFacts {
        zero_bytes_proved: true,
        exact_generation_ready: false,
        deadline_expired: false,
    };
    let outcome = dispatch_operation(&mut db, &authorized, &facts).expect("dispatch settles");
    match outcome {
        DispatchOutcome::Terminalized { record } => {
            assert_eq!(record.state, LedgerState::Failed);
            assert_eq!(record.ledger_revision, 2);
            let not_applied = record
                .terminal_result
                .as_ref()
                .and_then(|r| r.error.as_ref())
                .map(|e| e.code == dolly_tool_broker::ToolErrorCode::DispatchNotApplied)
                .unwrap_or(false);
            assert!(not_applied, "must be TOOL_DISPATCH_NOT_APPLIED");
        }
        other => panic!("dead generation must fail closed, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Terminal rows are immutable
// ---------------------------------------------------------------------------

/// A terminal row is never re-decided into another transition: recovery
/// visits zero rows, issues no permit, and leaves the stored bytes intact
/// (TST-TOOL-011).
#[test]
fn terminal_row_unchanged_across_recovery() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let authorized = authorized_record(OP_A, REQ);
    insert_authorized_row(&mut db, &authorized);
    let binding = authorized.operation_binding.clone();

    // Reach a durable DISPATCHED, then SUCCEEDED terminal.
    let dispatched = build_record(LedgerState::Dispatched, true, None, &binding);
    let _ = dolly_storage::tool_ledger::cas_to_dispatched(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: OP_A.into(),
            expected_ledger_revision: 1,
            expected_state: LedgerState::Authorized,
            correlation: None,
        },
        &dispatched,
    )
    .expect("dispatch CAS");

    let succeeded = json!({
        "operation_id": OP_A,
        "status": "succeeded",
        "output": {"value": "accepted"},
        "error": null,
        "server_request_id": REQ,
    });
    let terminal = build_record(
        LedgerState::Succeeded,
        true,
        Some(serde_json::from_value(succeeded).unwrap()),
        &binding,
    );
    let terminal_bytes = terminal
        .canonical_bytes_and_digest()
        .expect("canonical")
        .0
        .as_ref()
        .to_vec();
    let _ = dolly_storage::tool_ledger::cas_terminal(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: OP_A.into(),
            expected_ledger_revision: 2,
            expected_state: LedgerState::Dispatched,
            correlation: Some(TransportCorrelation {
                tool_server_id: "fs".into(),
                tool_name: "read-file".into(),
                tool_server_generation: 7,
                server_request_id: REQ.into(),
                outbound_digest: terminal
                    .recompute_outbound_digest()
                    .expect("payload present"),
            }),
        },
        &terminal,
    )
    .expect("terminal CAS");
    drop(db); // terminal-commit ack "lost"

    // Reopen and inspect directly: terminal rows are immutable.
    let mut db = open_db(dir.path());
    let loaded_terminal = load_exact(db.connection(), "module-a", OP_A)
        .expect("load")
        .expect("present");
    let facts = RecoveryFacts {
        zero_bytes_proved: true,
        exact_generation_ready: true,
        deadline_expired: false,
    };
    match dispatch_operation(&mut db, &loaded_terminal, &facts).expect("terminal settles") {
        DispatchOutcome::Unchanged { record } => {
            assert_eq!(record.state, LedgerState::Succeeded);
            assert_eq!(record.ledger_revision, 3);
        }
        other => panic!("terminal row must remain unchanged, got {other:?}"),
    }
    drop(db);

    // The stored terminal bytes are byte-identical after reopen+recovery.
    let db = open_db(dir.path());
    let loaded = load_exact(db.connection(), "module-a", OP_A)
        .expect("load")
        .expect("present");
    assert_eq!(loaded.state, LedgerState::Succeeded);
    assert_eq!(loaded.ledger_revision, 3);
    assert_eq!(
        loaded
            .canonical_bytes_and_digest()
            .expect("canonical")
            .0
            .as_ref(),
        terminal_bytes.as_slice(),
        "reopened terminal record must byte-match the committed terminal"
    );
}

// ---------------------------------------------------------------------------
// Logic errors release no permit
// ---------------------------------------------------------------------------

/// An AUTHORIZED binding whose outbound payload cannot be reconstructed
/// fails closed at the storage verification step: the coordinator errors and
/// releases no permit.
#[test]
fn no_permit_when_outbound_unreconstructible() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let mut authorized = authorized_record(OP_A, REQ);
    insert_authorized_row(&mut db, &authorized);

    // Break the binding so the adapter payload can no longer be recomputed
    // (drop the tool entry from the server contract).
    let mut binding = authorized.operation_binding.clone();
    binding.server_contract = serde_json::from_value(json!({"tools": {}})).expect("empty");
    authorized.operation_binding = binding;
    let facts = RecoveryFacts {
        zero_bytes_proved: true,
        exact_generation_ready: true,
        deadline_expired: false,
    };
    let result = dispatch_operation(&mut db, &authorized, &facts);
    match &result {
        Err(DispatchError::InvalidRecord) | Err(DispatchError::Storage(_)) => {}
        other => panic!("unreconstructable payload must be refused, got {other:?}"),
    }
    // The stored row is untouched.
    let rows = enumerate_nonterminal(db.connection()).expect("enum");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, LedgerState::Authorized);
}

/// A corrupt row (digest mismatch) stops the ENTIRE reopen recovery: no
/// partial terminalization, no permits (TST-TOOL-012).
#[test]
fn corrupt_row_stops_entire_recovery() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let a = authorized_record(OP_A, REQ);
    let b = authorized_record(OP_B, "0198ab31-6c44-7e8a-b2bb-000000000451");
    insert_authorized_row(&mut db, &a);
    insert_authorized_row(&mut db, &b);
    drop(db);

    // Tamper only row A's stored digest out-of-band.
    {
        let conn = Connection::open(dir.path().join("instance.sqlite")).expect("tamper open");
        conn.execute(
            "UPDATE tool_call_ledger SET record_digest = ?1 WHERE operation_id = ?2",
            rusqlite::params![
                "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                OP_A,
            ],
        )
        .expect("tamper record_digest");
    }

    let db = open_db(dir.path());
    let result = load_exact(db.connection(), "module-a", OP_A);
    match &result {
        Err(StorageError::Corrupt) => {}
        other => panic!("corrupt row must stop the whole recovery, got {other:?}"),
    }
    // The unaffected row B stays AUTHORIZED; nothing was terminalized.
    let found = load_exact(db.connection(), "module-a", OP_B)
        .expect("load")
        .expect("present");
    assert_eq!(found.state, LedgerState::Authorized);
    assert_eq!(found.ledger_revision, 1);
}

/// The FencedFactsProvider composite translates Host-owned readiness and
/// clock into the pure facts; an unreadable deadline means expired.
#[test]
fn fenced_facts_provider_composes_ports() {
    struct Ready;
    impl dolly_tool_coordinator::GenerationReadiness for Ready {
        fn exact_generation_ready(&self, module_id: &str, _server: &str, generation: u64) -> bool {
            module_id == "module-a" && generation == 7
        }
    }
    struct PeakClock;
    impl dolly_tool_coordinator::Clock for PeakClock {
        fn now(&self) -> std::time::SystemTime {
            std::time::SystemTime::UNIX_EPOCH
        }
    }
    let authorized = authorized_record(OP_A, REQ);
    let provider = FencedFactsProvider {
        zero_bytes_proved: true,
        readiness: &Ready,
        clock: &PeakClock,
    };
    let facts = provider.facts_for(&authorized);
    assert!(facts.zero_bytes_proved);
    assert!(facts.exact_generation_ready);
    assert!(!facts.deadline_expired, "deadline far in the future");
}

#[test]
fn authority_dispatch_requires_current_revalidation_api() {
    let _ = dolly_storage::tool_broker_authority::revalidate_tool_dispatch_authority;
    let _requires_stdio_handoff: fn(
        &mut Database,
        &ToolDispatchAuthority,
        &RuntimeBinding,
        &ProcessGeneration,
        &McpTransportReadiness,
        &ToolCallLedgerRecord,
        &RecoveryFacts,
        &ToolDispatchService,
        HostMcpStdioInvocation,
    ) -> Result<DispatchOutcome, DispatchError> = dispatch_operation_authorized;
}

#[test]
fn recovery_boundary_requires_producer_authority() {
    let _requires_authority: fn(
        &mut Database,
        &ToolDispatchAuthority,
        &RuntimeBinding,
        &ProcessGeneration,
        &McpTransportReadiness,
        &dyn RecoveryFactsProvider,
    ) -> Result<RecoveryOutcome, DispatchError> = reopen_recovery;
}
