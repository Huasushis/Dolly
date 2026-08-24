//! RED crash-point contract tests for the authoritative Tool-call ledger
//! storage slice (storage-and-recovery §5.10/§6/§7, INV-STORAGE-017,
//! TST-TOOL-001/002/006/009/010/011/012/013).
//!
//! Every test drives the real bundled SQLite through `dolly_storage`: each
//! writes through the store transaction API, drops the `Database` handle, then
//! REOPENS the same temp `.sqlite` file and re-reads the durable ledger —
//! proving each crash-point observation survives close/reopen byte-for-byte.
//!
//! The rows are inserted only after creating the referenced `activations` and
//! `config_revisions` parent rows so the §5.10 foreign keys are exercised for
//! real.

use dolly_canonical_json::{CanonicalJsonObject, Sha256Digest, canonicalize};
use dolly_storage::tool_ledger::{
    CasKey, CasOutcome, LedgerInsertDisposition, TransportCorrelation, create_tool_ledger_schema,
    enumerate_nonterminal, insert_authorized, load_exact, propose_recovery,
};
use dolly_storage::{Database, StorageError};
use dolly_tool_broker::{
    ConfirmationDecision, DispatchDisposition, IdempotencyPolicy, LedgerState, RecoveryFacts,
    RecoveryFactsSource, SideEffectClass, ToolCallLedgerRecord, ToolOperationBinding,
    ToolOperationBindingSchemaTag, ToolStatus,
};
use rusqlite::Connection;
use serde_json::json;


struct TestFacts {
    zero_bytes_proved: bool,
    exact_generation_ready: bool,
    deadline_expired: bool,
}

// SAFETY: this fixture models coordinator-owned recovery facts.
unsafe impl RecoveryFactsSource for TestFacts {
    fn facts_for(&self, _record: &ToolCallLedgerRecord) -> (bool, bool, bool) {
        (
            self.zero_bytes_proved,
            self.exact_generation_ready,
            self.deadline_expired,
        )
    }
}

fn facts(
    record: &ToolCallLedgerRecord,
    zero_bytes_proved: bool,
    exact_generation_ready: bool,
    deadline_expired: bool,
) -> RecoveryFacts {
    RecoveryFacts::from_authoritative_source(
        &TestFacts {
            zero_bytes_proved,
            exact_generation_ready,
            deadline_expired,
        },
        record,
    )
}
/// Request-digest/operation-digest/outbound digest shorthand.
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
) -> dolly_tool_broker::ToolCallLedgerRecord {
    let outbound_digest = if outbound_present {
        Some(
            binding
                .recompute_outbound_digest()
                .expect("payload present"),
        )
    } else {
        None
    };
    let terminal_result_digest = terminal_result
        .as_ref()
        .map(|result| canonicalize(result).expect("canonicalizable").1);
    let record = dolly_tool_broker::ToolCallLedgerRecord {
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
                dolly_tool_broker::ToolCallLedgerRecord {
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

fn digest_marker(operation_id: &str) -> Sha256Digest {
    // Deterministic per-operation request digest (stable across processes).
    Sha256Digest::compute(operation_id.as_bytes())
}

fn authorized_record(
    operation_id: &str,
) -> (
    dolly_tool_broker::ToolCallLedgerRecord,
    ToolOperationBinding,
) {
    let binding = binding(
        operation_id,
        "0198ab31-6c44-7e8a-b2bb-000000000451",
        digest_marker(operation_id),
    );
    let record = build_record(LedgerState::Authorized, false, None, &binding);
    (record, binding)
}

// ---- helpers to open a real temp database and seed FK parents ----

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

// ---------------------------------------------------------------------------
// TST-TOOL-009 / 006: AUTHORIZED zero-byte safe retry disposition
// ---------------------------------------------------------------------------

/// Reopen after an unattributed `AUTHORIZED` row: the row is still an exact,
/// verified revision-1 record; with zero-byte proof + Ready generation + a
/// live deadline the pure decision proposes a permit-eligible dispatch that a
/// committed store CAS can land — and only then is the row durably DISPATCHED
/// (INV-STORAGE-017: the commit precedes any send permit).
#[test]
fn authorized_zero_byte_safe_retry_disposition() {
    let dir = tempdir();

    // ---- first process: insert AUTHORIZED ----
    let mut db = open_db(dir.path());
    let (record, binding) = authorized_record("0198ab31-6c44-7e8a-b2bb-000000000346");
    let _ = &binding;
    insert_authorized_row(&mut db, &record);
    drop(db); // close: the durable write is already committed

    // ---- reopened process ----
    let mut db = open_db(dir.path());
    let nonterminal = enumerate_nonterminal(db.connection()).expect("enumerate");
    assert_eq!(
        nonterminal.len(),
        1,
        "exactly one nonterminal row on reopen"
    );
    let recovered = &nonterminal[0];
    assert_eq!(recovered.state, LedgerState::Authorized);
    assert_eq!(recovered.ledger_revision, 1);
    assert!(recovered.outbound_digest.is_none(), "zero-byte boundary");

    // Pure zero-byte proof decision with exact Ready generation + live
    // deadline: propose dispatch with a permit (TST-TOOL-009).
    let disposition = propose_recovery(
        recovered,
        &facts(recovered, true, true, false),
    );
    let outbound_digest = match &disposition {
        DispatchDisposition::ProposeDispatch {
            outbound_digest,
            allow_send_permit,
        } => {
            assert!(allow_send_permit, "permit eligible after proof");
            outbound_digest.clone()
        }
        other => panic!("expected ProposeDispatch, got {other:?}"),
    };

    // The store CAS commits the transition durably - before any send permit.
    let dispatched = build_record(
        LedgerState::Dispatched,
        true,
        None,
        &authorized_record("0198ab31-6c44-7e8a-b2bb-000000000346").1,
    );
    let outcome = dolly_storage::tool_ledger::cas_to_dispatched(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: "0198ab31-6c44-7e8a-b2bb-000000000346".into(),
            expected_ledger_revision: 1,
            expected_state: LedgerState::Authorized,
            correlation: None,
        },
        &dispatched,
    )
    .expect("dispatch CAS");
    match outcome {
        CasOutcome::Committed { record } => {
            assert_eq!(record.state, LedgerState::Dispatched);
            assert_eq!(record.ledger_revision, 2);
            assert_eq!(record.outbound_digest, Some(outbound_digest));
        }
        other => panic!("CAS must commit, got {other:?}"),
    }
    drop(db);

    // ---- re-open again: DISPATCHED is durable and exact ----
    let db = open_db(dir.path());
    let rows = enumerate_nonterminal(db.connection()).expect("enumerate");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, LedgerState::Dispatched);
    assert_eq!(rows[0].ledger_revision, 2);
}

/// TST-TOOL-006: AUTHORIZED with zero-byte proof but an unusable generation
/// (crashed before dispatch) fails closed as FAILED / TOOL_DISPATCH_NOT_APPLIED
/// through the terminal CAS.
#[test]
fn authorized_zero_byte_proof_unusable_generation_fails_not_applied() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let (record, binding) = authorized_record("0198ab31-6c44-7e8a-b2bb-000000000346");
    insert_authorized_row(&mut db, &record);
    drop(db);

    let mut db = open_db(dir.path());
    let recovered = enumerate_nonterminal(db.connection())
        .expect("enumerate")
        .remove(0);
    let disposition = propose_recovery(
        &recovered,
        &facts(&recovered, true, false, false),
    );
    let terminal_result = match &disposition {
        DispatchDisposition::ProvedNotApplied { result } => result.clone(),
        other => panic!("expected ProvedNotApplied, got {other:?}"),
    };
    assert_eq!(terminal_result.status, ToolStatus::Failed);
    assert_eq!(
        terminal_result.error.as_ref().unwrap().code,
        dolly_tool_broker::ToolErrorCode::DispatchNotApplied
    );

    let terminal = build_record(LedgerState::Failed, false, Some(terminal_result), &binding);
    let outcome = dolly_storage::tool_ledger::cas_terminal(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: "0198ab31-6c44-7e8a-b2bb-000000000346".into(),
            expected_ledger_revision: 1,
            expected_state: LedgerState::Authorized,
            correlation: None,
        },
        &terminal,
    )
    .expect("terminal CAS");
    match outcome {
        CasOutcome::Committed { record } => {
            assert_eq!(record.state, LedgerState::Failed);
            assert_eq!(record.ledger_revision, 2);
            assert!(
                record.outbound_digest.is_none(),
                "null outbound for not_applied"
            );
        }
        other => panic!("terminal CAS must commit, got {other:?}"),
    }
    drop(db);

    // Reopen: FAILED is terminal, none left for enumeration.
    let db = open_db(dir.path());
    assert!(
        enumerate_nonterminal(db.connection())
            .expect("enumerate")
            .is_empty()
    );
    let loaded = load_exact(
        db.connection(),
        "module-a",
        "0198ab31-6c44-7e8a-b2bb-000000000346",
    )
    .expect("load")
    .expect("row present");
    assert_eq!(loaded.state, LedgerState::Failed);
    assert_eq!(loaded.ledger_revision, 2);
}

// ---------------------------------------------------------------------------
// TST-TOOL-001/002/010: DISPATCHED -> UNKNOWN / no redispatch
// ---------------------------------------------------------------------------

/// Reopen after the durable DISPATCHED marker with no authoritative result:
/// recovery is `Unknown`/`TOOL_EXTERNAL_OUTCOME_UNKNOWN`, no send permit is
/// recreated, and the terminal CAS lands an immutable UNKNOWN in revision 3
/// (REQ-TOOL-002 / INV-STORAGE-017).
#[test]
fn dispatched_row_becomes_unknown_without_redispatch() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let (authorized, binding) = authorized_record("0198ab31-6c44-7e8a-b2bb-000000000341");
    insert_authorized_row(&mut db, &authorized);

    let dispatched = build_record(LedgerState::Dispatched, true, None, &binding);
    let outcome = dolly_storage::tool_ledger::cas_to_dispatched(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: "0198ab31-6c44-7e8a-b2bb-000000000341".into(),
            expected_ledger_revision: 1,
            expected_state: LedgerState::Authorized,
            correlation: None,
        },
        &dispatched,
    )
    .expect("dispatch CAS");
    assert!(matches!(outcome, CasOutcome::Committed { .. }));
    drop(db); // close before the authoritative result ever exists

    // Reopened process: DISPATCHED row -> Unknown without redispatch.
    let mut db = open_db(dir.path());
    let recovered = enumerate_nonterminal(db.connection())
        .expect("enumerate")
        .remove(0);
    assert_eq!(recovered.state, LedgerState::Dispatched);
    let disposition = propose_recovery(
        &recovered,
        &facts(&recovered, false, false, false),
    );
    match &disposition {
        DispatchDisposition::Unknown { result } => {
            assert_eq!(result.status, ToolStatus::Unknown);
            assert_eq!(disposition.automatic_redispatch_count(), 0);
        }
        other => panic!("DISPATCHED must recover Unknown, got {other:?}"),
    }
    assert_eq!(disposition.automatic_redispatch_count(), 0);

    // Terminal CAS: DISPATCHED(2) -> UNKNOWN(3), outbound digest retained.
    let unknown_result = match &disposition {
        DispatchDisposition::Unknown { result } => result.clone(),
        _ => unreachable!(),
    };
    let terminal = build_record(LedgerState::Unknown, true, Some(unknown_result), &binding);
    let outcome = dolly_storage::tool_ledger::cas_terminal(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: "0198ab31-6c44-7e8a-b2bb-000000000341".into(),
            expected_ledger_revision: 2,
            expected_state: LedgerState::Dispatched,
            correlation: Some(TransportCorrelation {
                tool_server_id: "fs".into(),
                tool_name: "read-file".into(),
                tool_server_generation: 7,
                server_request_id: "0198ab31-6c44-7e8a-b2bb-000000000451".into(),
                outbound_digest: terminal
                    .recompute_outbound_digest()
                    .expect("payload present"),
            }),
        },
        &terminal,
    )
    .expect("terminal CAS");
    match &outcome {
        CasOutcome::Committed { record } => {
            assert_eq!(record.state, LedgerState::Unknown);
            assert_eq!(record.ledger_revision, 3);
            assert!(
                record.outbound_digest.is_some(),
                "UNKNOWN retains the outbound digest"
            );
        }
        other => panic!("expected Committed, got {other:?}"),
    }
    drop(db);

    // Reopen: terminal UNKNOWN is immutable, nothing nonterminal remains.
    let db = open_db(dir.path());
    assert!(
        enumerate_nonterminal(db.connection())
            .expect("enumerate")
            .is_empty()
    );
    let loaded = load_exact(
        db.connection(),
        "module-a",
        "0198ab31-6c44-7e8a-b2bb-000000000341",
    )
    .expect("load")
    .expect("row present");
    assert_eq!(loaded.state, LedgerState::Unknown);
    assert_eq!(loaded.ledger_revision, 3);
    let disposition = propose_recovery(
        &loaded,
        &facts(&loaded, false, false, false),
    );
    assert!(
        matches!(disposition, DispatchDisposition::AlreadyTerminal { .. }),
        "reopened terminal row must replay, not recreate a permit"
    );
}

// ---------------------------------------------------------------------------
// TST-TOOL-011: terminal replay is exact across reopen
// ---------------------------------------------------------------------------

/// A lost terminal-commit acknowledgement: reopen must return the exact
/// stored terminal result and digest with zero mutation and zero redispatch.
#[test]
fn terminal_commit_ack_lost_reopen_replays_exact() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let (authorized, binding) = authorized_record("0198ab31-6c44-7e8a-b2bb-000000000351");
    insert_authorized_row(&mut db, &authorized);

    let dispatched = build_record(LedgerState::Dispatched, true, None, &binding);
    let _ = dolly_storage::tool_ledger::cas_to_dispatched(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: "0198ab31-6c44-7e8a-b2bb-000000000351".into(),
            expected_ledger_revision: 1,
            expected_state: LedgerState::Authorized,
            correlation: None,
        },
        &dispatched,
    )
    .expect("dispatch");

    let succeeded_result = serde_json::from_value(json!({
        "operation_id": "0198ab31-6c44-7e8a-b2bb-000000000351",
        "status": "succeeded",
        "output": {"value": "accepted"},
        "error": null,
        "server_request_id": "0198ab31-6c44-7e8a-b2bb-000000000451",
    }))
    .unwrap();
    let terminal = build_record(
        LedgerState::Succeeded,
        true,
        Some(serde_json::from_value(succeeded_result).unwrap()),
        &binding,
    );
    let raw_outbound = terminal.recompute_outbound_digest().expect("payload");
    let _ = dolly_storage::tool_ledger::cas_terminal(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: "0198ab31-6c44-7e8a-b2bb-000000000351".into(),
            expected_ledger_revision: 2,
            expected_state: LedgerState::Dispatched,
            correlation: Some(TransportCorrelation {
                tool_server_id: "fs".into(),
                tool_name: "read-file".into(),
                tool_server_generation: 7,
                server_request_id: "0198ab31-6c44-7e8a-b2bb-000000000451".into(),
                outbound_digest: raw_outbound,
            }),
        },
        &terminal,
    )
    .expect("terminal CAS");
    let terminal_bytes = terminal.canonical_bytes_and_digest().expect("canonical").0;
    drop(db); // terminal commit ack "lost" before acknowledgement consumed

    // Reopen: exact load returns the identical terminal record.
    let db = open_db(dir.path());
    let loaded = load_exact(
        db.connection(),
        "module-a",
        "0198ab31-6c44-7e8a-b2bb-000000000351",
    )
    .expect("load")
    .expect("row present");
    assert_eq!(loaded.state, LedgerState::Succeeded);
    assert_eq!(loaded.ledger_revision, 3);
    assert!(
        loaded.terminal_result.is_some() && loaded.terminal_result_digest.is_some(),
        "terminal result and digest survive reopen"
    );
    assert_eq!(
        loaded
            .canonical_bytes_and_digest()
            .expect("canonical")
            .0
            .as_ref(),
        terminal_bytes.as_ref(),
        "reopened record_jcs must byte-match the committed terminal record"
    );
    // Recovery of a terminal row is a verbatim replay, never a redispatch.
    let disposition = propose_recovery(
        &loaded,
        &facts(&loaded, false, false, false),
    );
    match &disposition {
        DispatchDisposition::AlreadyTerminal { result } => {
            assert_eq!(result.status, ToolStatus::Succeeded);
            assert_eq!(disposition.automatic_redispatch_count(), 0);
        }
        other => panic!("expected AlreadyTerminal, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// TST-TOOL-013: stale / cross-request CAS changes nothing
// ---------------------------------------------------------------------------

/// A stale compare-and-set (wrong expected revision or wrong transport
/// correlation) returns `Stale` with the verified authoritative row and no
/// mutation - after reopen the authoritative row is byte-identical.
#[test]
fn stale_or_wrong_correlation_cas_does_not_mutate() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let (authorized, binding) = authorized_record("0198ab31-6c44-7e8a-b2bb-000000000353");
    insert_authorized_row(&mut db, &authorized);

    let dispatched = build_record(LedgerState::Dispatched, true, None, &binding);
    let original_outbound = dispatched.recompute_outbound_digest().expect("payload");
    let _ = dolly_storage::tool_ledger::cas_to_dispatched(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: "0198ab31-6c44-7e8a-b2bb-000000000353".into(),
            expected_ledger_revision: 1,
            expected_state: LedgerState::Authorized,
            correlation: None,
        },
        &dispatched,
    )
    .expect("dispatch");
    let before = dd_of(&db);

    // Stale dispatch CAS (expects AUTHORIZED rev-1) - row is already DISPATCHED.
    let stale_re_dispatch = build_record(LedgerState::Dispatched, true, None, &binding);
    let outcome = dolly_storage::tool_ledger::cas_to_dispatched(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: "0198ab31-6c44-7e8a-b2bb-000000000353".into(),
            expected_ledger_revision: 1,
            expected_state: LedgerState::Authorized,
            correlation: None,
        },
        &stale_re_dispatch,
    )
    .expect("stale CAS must return Stale");
    match &outcome {
        CasOutcome::Stale { authoritative } => {
            assert_eq!(authoritative.state, LedgerState::Dispatched);
            assert_eq!(authoritative.ledger_revision, 2);
        }
        other => panic!("stale dispatch must be Stale, got {other:?}"),
    }
    drop(db);

    // Reopen after the stale CAS: the authoritative row is unchanged.
    let mut db = open_db(dir.path());
    let after = dd_of(&db);
    assert_eq!(
        before, after,
        "stale CAS must not mutate the authoritative ledger row"
    );

    // A response from the WRONG generation (8) or request id cannot settle.
    let wrong_result = serde_json::from_value(json!({
        "operation_id": "0198ab31-6c44-7e8a-b2bb-000000000353",
        "status": "succeeded",
        "output": {"value": "accepted"},
        "error": null,
        "server_request_id": "0198ab31-6c44-7e8a-b2bb-000000000999",
    }))
    .unwrap();
    let terminal = build_record(
        LedgerState::Succeeded,
        true,
        Some(serde_json::from_value(wrong_result).unwrap()),
        &binding,
    );
    let outcome = dolly_storage::tool_ledger::cas_terminal(
        db.connection_mut(),
        &CasKey {
            module_id: "module-a".into(),
            operation_id: "0198ab31-6c44-7e8a-b2bb-000000000353".into(),
            expected_ledger_revision: 2,
            expected_state: LedgerState::Dispatched,
            correlation: Some(TransportCorrelation {
                tool_server_id: "fs".into(),
                tool_name: "read-file".into(),
                tool_server_generation: 8, // wrong generation
                server_request_id: "0198ab31-6c44-7e8a-b2bb-000000000999".into(),
                outbound_digest: original_outbound,
            }),
        },
        &terminal,
    )
    .expect("wrong-correlation CAS");
    match &outcome {
        CasOutcome::Stale { authoritative } => {
            assert_eq!(authoritative.state, LedgerState::Dispatched);
            assert_eq!(authoritative.ledger_revision, 2);
        }
        other => panic!("wrong-generation response must be Stale, got {other:?}"),
    }
    drop(db);

    let db = open_db(dir.path());
    let loaded = load_exact(
        db.connection(),
        "module-a",
        "0198ab31-6c44-7e8a-b2bb-000000000353",
    )
    .expect("load")
    .expect("row present");
    assert_eq!(loaded.state, LedgerState::Dispatched);
    assert_eq!(loaded.ledger_revision, 2);
}

/// Canonical `record_jcs` bytes of the row, on-DB verification included.
fn dd_of(db: &Database) -> Vec<u8> {
    let loaded = load_exact(
        db.connection(),
        "module-a",
        "0198ab31-6c44-7e8a-b2bb-000000000353",
    )
    .expect("load")
    .expect("present");
    loaded
        .canonical_bytes_and_digest()
        .expect("canonical")
        .0
        .as_ref()
        .to_vec()
}

// ---------------------------------------------------------------------------
// TST-TOOL-012: corruption blocks the broker as STORAGE_CORRUPT
// ---------------------------------------------------------------------------

/// A row whose stored record digest no longer matches its bytes, or whose
/// indexed columns drift, blocks every read as `STORAGE_CORRUPT`; enumeration
/// fails closed instead of returning a partial list; nothing is repaired.
#[test]
fn corrupt_row_blocks_reads_with_storage_corrupt() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let (authorized, _binding) = authorized_record("0198ab31-6c44-7e8a-b2bb-000000000354");
    insert_authorized_row(&mut db, &authorized);
    drop(db);

    // Tamper the file out-of-band (a second writer without the lock).
    {
        let conn = Connection::open(dir.path().join("instance.sqlite")).expect("tamper open");
        conn.execute(
            "UPDATE tool_call_ledger SET record_digest = ?1 WHERE operation_id = ?2",
            rusqlite::params![
                "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                "0198ab31-6c44-7e8a-b2bb-000000000354",
            ],
        )
        .expect("tamper record_digest");
    }

    let db = open_db(dir.path());
    assert!(
        matches!(
            load_exact(
                db.connection(),
                "module-a",
                "0198ab31-6c44-7e8a-b2bb-000000000354"
            ),
            Err(StorageError::Corrupt)
        ),
        "record digest mismatch must be STORAGE_CORRUPT"
    );
    assert!(
        matches!(
            enumerate_nonterminal(db.connection()),
            Err(StorageError::Corrupt)
        ),
        "corrupt row must fail the whole enumeration, not be returned"
    );
}
