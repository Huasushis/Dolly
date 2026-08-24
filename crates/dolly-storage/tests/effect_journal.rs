//! RED crash-point contract tests for the authoritative v1 external-effect
//! journal storage slice (ADR 0009 capability effect-intent seam).
//!
//! Every write path drives the real bundled SQLite through `dolly_storage`,
//! drops the `Database` handle, then REOPENS the same temp `.sqlite` file and
//! re-reads the durable journal — proving crash-point observations survive
//! close/reopen byte-for-byte. Also covers: only-Worker-settled transitions
//! via identity-matched evidence, ambiguity to `UNKNOWN_OUTCOME`,
//! replay/stale-claim refusal (a new attempt requires a new Claim), corrupt
//! and version-mismatched fail-closed, and the bounded storage ceilings.

use dolly_canonical_json::{CanonicalJsonObject, Sha256Digest, canonicalize};
use dolly_storage::effect_journal::{
    EffectCasKey, EffectCasOutcome, EffectCorrelation, EffectJournalInsertDisposition,
    assert_operation_claimable, enumerate_pending, insert_intent, load_exact, propose_effect_recovery,
    settle_pending_effect_journal,
};
use dolly_storage::effect_journal::{cas_settle, gate_schema_version};
use dolly_storage::tool_ledger::{
    CasKey, CasOutcome, LedgerInsertDisposition, TransportCorrelation, cas_terminal,
    cas_to_dispatched, create_tool_ledger_schema, insert_authorized,
};
use dolly_storage::{Database, StorageError};
use dolly_tool_broker::effect_journal::{
    Claim, ClaimRecordSchemaTag, EffectClass, EffectJournalRecordSchemaTag, EffectJournalState,
    EffectSettlement, ExternalEffectJournalRecord, derive_claim_token,
};
use dolly_tool_broker::{
    ConfirmationDecision, IdempotencyPolicy, LedgerState, SideEffectClass, ToolCallLedgerRecord,
    ToolCallLedgerRecordSchemaTag, ToolOperationBinding, ToolOperationBindingSchemaTag, ToolResult,
    ToolStatus,
};
use serde_json::json;

fn digest(hex_byte: u8) -> Sha256Digest {
    format!("sha256:{:064x}", hex_byte as u128)
        .parse()
        .expect("valid digest")
}

const INSTANCE: &str = "c-inst-0001";
const MODULE: &str = "module-a";
const EPOCH: &str = "01jh8w2etc4x70xj26rg8fsdv92";
const CONTROLLER: u64 = 1;
const EXTENSION_GENERATION: u64 = 2;

fn package_digest() -> Sha256Digest {
    format!("sha256:{}", "11".repeat(32))
        .parse()
        .expect("valid package digest")
}
fn policy_digest() -> Sha256Digest {
    digest(0x22)
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

fn binding(operation_id: &str, server_request_id: &str) -> ToolOperationBinding {
    ToolOperationBinding {
        schema: ToolOperationBindingSchemaTag,
        instance_id: INSTANCE.into(),
        module_id: MODULE.into(),
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
        request_digest: digest(0x63),
        tool_server_generation: 7,
        server_request_id: server_request_id.into(),
        server_contract: server_contract(),
        confirmation_decision: ConfirmationDecision::NotRequired,
    }
}

fn ledger_record(
    state: LedgerState,
    outbound_present: bool,
    terminal_result: Option<ToolResult>,
    binding: &ToolOperationBinding,
) -> ToolCallLedgerRecord {
    let outbound_digest = if outbound_present {
        Some(
            binding
                .recompute_outbound_digest()
                .expect("outbound present"),
        )
    } else {
        None
    };
    let terminal_result_digest = terminal_result
        .as_ref()
        .map(|result| canonicalize(result).expect("canonicalizable").1);
    let mut record = ToolCallLedgerRecord {
        schema: ToolCallLedgerRecordSchemaTag,
        ledger_revision: state.default_ledger_revision(),
        state,
        operation_binding: binding.clone(),
        operation_digest: binding.operation_digest(),
        outbound_digest,
        terminal_result,
        terminal_result_digest,
    };
    if record.state == LedgerState::Failed {
        let not_applied = record
            .terminal_result
            .as_ref()
            .and_then(|r| r.error.as_ref())
            .map(|e| e.code == dolly_tool_broker::ToolErrorCode::DispatchNotApplied)
            .unwrap_or(false);
        if not_applied {
            record = ToolCallLedgerRecord {
                ledger_revision: 2,
                outbound_digest: None,
                ..record
            };
        }
    }
    record
        .verify_field_combination()
        .expect("fixture must be field-consistent");
    record
}
fn seed_succeeded_ledger(db: &mut Database, binding: &ToolOperationBinding) {
    let authorized = ledger_record(LedgerState::Authorized, false, None, binding);
    assert!(matches!(
        insert_authorized(db.connection_mut(), &authorized).expect("insert authorized"),
        LedgerInsertDisposition::Inserted { .. }
    ));
    let dispatched = ledger_record(LedgerState::Dispatched, true, None, binding);
    assert!(matches!(
        cas_to_dispatched(
            db.connection_mut(),
            &CasKey {
                module_id: binding.module_id.clone(),
                operation_id: binding.operation_id.clone(),
                expected_ledger_revision: 1,
                expected_state: LedgerState::Authorized,
                correlation: None,
            },
            &dispatched,
        )
        .expect("dispatch ledger CAS"),
        CasOutcome::Committed { .. }
    ));
    let terminal_result = ToolResult {
        operation_id: binding.operation_id.clone(),
        status: ToolStatus::Succeeded,
        output: json!({"text": "hi"}),
        error: None,
        server_request_id: Some(binding.server_request_id.clone()),
    };
    let succeeded = ledger_record(LedgerState::Succeeded, true, Some(terminal_result), binding);
    assert!(matches!(
        cas_terminal(
            db.connection_mut(),
            &CasKey {
                module_id: binding.module_id.clone(),
                operation_id: binding.operation_id.clone(),
                expected_ledger_revision: 2,
                expected_state: LedgerState::Dispatched,
                correlation: Some(TransportCorrelation {
                    tool_server_id: binding.tool_server_id.clone(),
                    tool_name: binding.tool_name.clone(),
                    tool_server_generation: binding.tool_server_generation,
                    server_request_id: binding.server_request_id.clone(),
                    outbound_digest: binding
                        .recompute_outbound_digest()
                        .expect("outbound digest"),
                }),
            },
            &succeeded,
        )
        .expect("terminal ledger CAS"),
        CasOutcome::Committed { .. }
    ));
}

fn authoritative_record(operation_id: &str) -> (ToolOperationBinding, ExternalEffectJournalRecord) {
    let binding = binding(operation_id, &format!("request-{operation_id}"));
    let intent_digest = binding.recompute_outbound_digest().expect("outbound");
    (
        binding.clone(),
        intended_record(operation_id, intent_digest, binding.operation_digest()),
    )
}

/// A field-consistent `INTENDED` journal record for one operation.
fn intended_record(
    operation_id: &str,
    intent_digest: Sha256Digest,
    operation_digest: Sha256Digest,
) -> ExternalEffectJournalRecord {
    let claim_token = derive_claim_token(
        INSTANCE,
        MODULE,
        operation_id,
        &operation_digest,
        CONTROLLER,
        EXTENSION_GENERATION,
        EPOCH,
        &package_digest(),
        &policy_digest(),
        EffectClass::McpToolsCall,
    );
    let record = ExternalEffectJournalRecord {
        schema: EffectJournalRecordSchemaTag,
        journal_revision: 1,
        state: EffectJournalState::Intended,
        claim: Claim {
            schema: ClaimRecordSchemaTag,
            instance_id: INSTANCE.into(),
            module_id: MODULE.into(),
            operation_id: operation_id.into(),
            operation_digest: operation_digest.clone(),
            claim_token,
        },
        controller_generation: CONTROLLER,
        extension_generation: EXTENSION_GENERATION,
        worker_epoch: EPOCH.into(),
        package_digest: package_digest(),
        policy_premise_digest: policy_digest(),
        operation_digest,
        effect_class: EffectClass::McpToolsCall,
        intent_digest,
        evidence_digest: None,
    };
    record.verify().expect("fixture must verify");
    record
}

fn claim_of(record: &ExternalEffectJournalRecord) -> Claim {
    record.claim.clone()
}

// ---- helpers to open a real temp database and wire the journal schema ----

fn prepare_tool_ledger_schema(db: &mut Database) {
    create_tool_ledger_schema(db.connection()).expect("ledger schema");
    db.connection()
        .execute(
            "INSERT OR IGNORE INTO activations (activation_id) VALUES (?1)",
            rusqlite::params!["0198ab31-6c44-7e8a-b2bb-000000000101"],
        )
        .expect("activation parent");
    db.connection()
        .execute(
            "INSERT OR IGNORE INTO config_revisions (config_revision) VALUES (?1)",
            rusqlite::params![11_i64],
        )
        .expect("config revision parent");
}

fn open_db(dir: &std::path::Path) -> Database {
    let path = dir.join("instance.sqlite");
    if path.exists() {
        let mut db = Database::open(&path).expect("reopen real bundled SQLite");
        gate_schema_version(db.connection()).expect("journal schema");
        prepare_tool_ledger_schema(&mut db);
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
    let mut db = Database::open_for_migration(&path)
        .unwrap()
        .migrate_legacy_json(&legacy)
        .expect("explicit offline initialization");
    gate_schema_version(db.connection()).expect("journal schema");
    prepare_tool_ledger_schema(&mut db);
    db
}

fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

// ---------------------------------------------------------------------------
// crash/reopen durability
// ---------------------------------------------------------------------------

#[test]
fn intended_intent_survives_crash_reopen() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let record = intended_record("op-1", digest(0x5a), digest(0x99));
    match insert_intent(db.connection_mut(), &record).expect("insert intent") {
        EffectJournalInsertDisposition::Inserted { record, .. } => {
            assert_eq!(record.state, EffectJournalState::Intended)
        }
        EffectJournalInsertDisposition::Replayed { .. } => panic!("expected new intent"),
    }
    drop(db);

    // Crash: reopen and verify the intent is byte-for-byte durable.
    let db = open_db(dir.path());
    let loaded = load_exact(db.connection(), &claim_of(&record))
        .expect("load")
        .expect("row present after reopen");
    assert_eq!(loaded, record);
    assert_eq!(loaded.state, EffectJournalState::Intended);
}

#[test]
fn settle_applied_survives_crash_reopen() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let (binding, record) = authoritative_record("op-1");
    seed_succeeded_ledger(&mut db, &binding);
    assert!(matches!(
        insert_intent(db.connection_mut(), &record),
        Ok(EffectJournalInsertDisposition::Inserted { .. })
    ));
    let evidence_digest = dolly_storage::tool_ledger::load_exact(
        db.connection(),
        &binding.module_id,
        &binding.operation_id,
    )
    .expect("load ledger")
    .expect("ledger present")
    .terminal_result_digest
    .expect("terminal evidence");
    let applied = ExternalEffectJournalRecord {
        journal_revision: 2,
        state: EffectJournalState::Applied,
        evidence_digest: Some(evidence_digest.clone()),
        ..record.clone()
    };
    let outcome = cas_settle(
        db.connection_mut(),
        &EffectCasKey {
            claim: claim_of(&record),
            expected_journal_revision: 1,
            expected_state: EffectJournalState::Intended,
            correlation: Some(EffectCorrelation::from_record(&record)),
        },
        &applied,
    )
    .expect("settle applied");
    assert!(matches!(outcome, EffectCasOutcome::Committed { .. }));
    drop(db);

    let db = open_db(dir.path());
    let loaded = load_exact(db.connection(), &claim_of(&record))
        .expect("load")
        .expect("row present after reopen");
    assert_eq!(loaded.state, EffectJournalState::Applied);
    assert_eq!(loaded.evidence_digest.as_ref(), Some(&evidence_digest));
}

#[test]
fn unknown_outcome_survives_crash_reopen_and_never_redispatches() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let record = intended_record("op-1", digest(0x5a), digest(0x99));
    assert!(matches!(
        insert_intent(db.connection_mut(), &record),
        Ok(EffectJournalInsertDisposition::Inserted { .. })
    ));
    let unknown = ExternalEffectJournalRecord {
        journal_revision: 2,
        state: EffectJournalState::UnknownOutcome,
        evidence_digest: None,
        ..record.clone()
    };
    let error = cas_settle(
        db.connection_mut(),
        &EffectCasKey {
            claim: claim_of(&record),
            expected_journal_revision: 1,
            expected_state: EffectJournalState::Intended,
            correlation: Some(EffectCorrelation::from_record(&record)),
        },
        &unknown,
    )
    .expect_err("caller-supplied absence cannot settle");
    assert!(matches!(error, StorageError::Corrupt));
    settle_pending_effect_journal(&mut db).expect("reopen recovery");
    drop(db);

    let mut db = open_db(dir.path());
    let loaded = load_exact(db.connection(), &claim_of(&record))
        .expect("load")
        .expect("row present after reopen");
    assert_eq!(loaded.state, EffectJournalState::UnknownOutcome);
    assert!(loaded.evidence_digest.is_none());
    assert!(
        enumerate_pending(db.connection())
            .expect("enumerate")
            .is_empty()
    );

    let again = cas_settle(
        db.connection_mut(),
        &EffectCasKey {
            claim: claim_of(&loaded),
            expected_journal_revision: 1,
            expected_state: EffectJournalState::Intended,
            correlation: Some(EffectCorrelation::from_record(&loaded)),
        },
        &loaded,
    )
    .expect_err("terminal ambiguity cannot be settled again");
    assert!(matches!(again, StorageError::Corrupt));
}

// ---------------------------------------------------------------------------
// stale-claim / replay: a new attempt requires a new Claim
// ---------------------------------------------------------------------------

#[test]
fn same_claim_replays_without_mutation_and_refuses_a_second_effect() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let record = intended_record("op-1", digest(0x5a), digest(0x99));
    assert!(matches!(
        insert_intent(db.connection_mut(), &record),
        Ok(EffectJournalInsertDisposition::Inserted { .. })
    ));
    // Identical re-submission of the SAME claim: replay, no mutation.
    match insert_intent(db.connection_mut(), &record).expect("insert again") {
        EffectJournalInsertDisposition::Replayed {
            record: authoritative,
        } => {
            assert_eq!(authoritative, record)
        }
        EffectJournalInsertDisposition::Inserted { .. } => {
            panic!("a second intent under one Claim must be refused")
        }
    }
    let pending = enumerate_pending(db.connection()).expect("enumerate");
    assert_eq!(pending.len(), 1, "replay did not mint a second row");
}

#[test]
fn stale_claim_settle_changes_nothing() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let record = intended_record("op-1", digest(0x5a), digest(0x99));
    assert!(matches!(
        insert_intent(db.connection_mut(), &record),
        Ok(EffectJournalInsertDisposition::Inserted { .. })
    ));
    let applied = ExternalEffectJournalRecord {
        journal_revision: 2,
        state: EffectJournalState::Applied,
        evidence_digest: Some(digest(0x6b)),
        ..record.clone()
    };
    // Wrong expected revision (2) while the row is revision 1: stale, atom.
    let stale = cas_settle(
        db.connection_mut(),
        &EffectCasKey {
            claim: claim_of(&record),
            expected_journal_revision: 2,
            expected_state: EffectJournalState::Applied,
            correlation: Some(EffectCorrelation::from_record(&record)),
        },
        &applied,
    )
    .expect("settle with stale expectation");
    match stale {
        EffectCasOutcome::Stale { authoritative } => {
            assert_eq!(authoritative.state, EffectJournalState::Intended)
        }
        EffectCasOutcome::Committed { .. } => panic!("stale expectation must not commit"),
    }
}

#[test]
fn correlation_mismatch_evidence_never_settles_the_row() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let record = intended_record("op-1", digest(0x5a), digest(0x99));
    assert!(matches!(
        insert_intent(db.connection_mut(), &record),
        Ok(EffectJournalInsertDisposition::Inserted { .. })
    ));
    let applied = ExternalEffectJournalRecord {
        journal_revision: 2,
        state: EffectJournalState::Applied,
        evidence_digest: Some(digest(0x6b)),
        ..record.clone()
    };
    // Evidence from a DIFFERENT effect (different intent digest) must not
    // settle this row: stored correlation mismatch → stale, zero mutation.
    let outcome = cas_settle(
        db.connection_mut(),
        &EffectCasKey {
            claim: claim_of(&record),
            expected_journal_revision: 1,
            expected_state: EffectJournalState::Intended,
            correlation: Some(EffectCorrelation {
                controller_generation: record.controller_generation,
                extension_generation: record.extension_generation,
                worker_epoch: record.worker_epoch.clone(),
                package_digest: record.package_digest.clone(),
                policy_premise_digest: record.policy_premise_digest.clone(),
                operation_digest: record.operation_digest.clone(),
                outbound_digest: digest(0x5b), // different effect identity
                effect_class: record.effect_class,
            }),
        },
        &applied,
    )
    .expect("settle with mismatched correlation");
    assert!(matches!(outcome, EffectCasOutcome::Stale { .. }));
    let loaded = load_exact(db.connection(), &claim_of(&record))
        .expect("load")
        .expect("still present");
    assert_eq!(loaded.state, EffectJournalState::Intended);
}

#[test]
fn applied_settle_requires_evidence_digest() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let record = intended_record("op-1", digest(0x5a), digest(0x99));
    assert!(matches!(
        insert_intent(db.connection_mut(), &record),
        Ok(EffectJournalInsertDisposition::Inserted { .. })
    ));
    // Missing evidence on an APPLIED settle is a corrupt proposal, not a
    // valid ambiguity settle.
    let bad = ExternalEffectJournalRecord {
        journal_revision: 2,
        state: EffectJournalState::Applied,
        evidence_digest: None,
        ..record.clone()
    };
    let error = cas_settle(
        db.connection_mut(),
        &EffectCasKey {
            claim: claim_of(&record),
            expected_journal_revision: 1,
            expected_state: EffectJournalState::Intended,
            correlation: Some(EffectCorrelation::from_record(&record)),
        },
        &bad,
    )
    .expect_err("missing evidence must fail closed");
    assert!(matches!(error, StorageError::Corrupt));
}

// ---------------------------------------------------------------------------
// provider-evidence recovery seam
// ---------------------------------------------------------------------------

#[test]
fn reopen_recovery_settles_only_from_identity_matched_ledger_evidence() {
    let dir = tempdir();
    {
        let mut db = open_db(dir.path());
        // Intended intent digest matches the ledger's future outbound digest.
        let b = binding("op-1", "0198ab31-6c44-7e8a-b2bb-000000000451");
        let outbound = b.recompute_outbound_digest().expect("outbound");
        let record = intended_record("op-1", outbound, b.operation_digest());
        assert!(matches!(
            insert_intent(db.connection_mut(), &record),
            Ok(EffectJournalInsertDisposition::Inserted { .. })
        ));
        seed_succeeded_ledger(&mut db, &b);
        drop(db);
    }

    // Crash during dispatch leaves an INTENDED row. Reopen settles from the
    // authoritative ledger evidence only (identity + effect matched), else
    // UNKNOWN_OUTCOME — never redispatch.
    let b = binding("op-1", "0198ab31-6c44-7e8a-b2bb-000000000451");
    let succeeded = ledger_record(
        LedgerState::Succeeded,
        true,
        Some(ToolResult {
            operation_id: "op-1".into(),
            status: ToolStatus::Succeeded,
            output: json!({"text": "hi"}),
            error: None,
            server_request_id: Some("0198ab31-6c44-7e8a-b2bb-000000000451".into()),
        }),
        &b,
    );

    let mut db = open_db(dir.path());
    let pending = enumerate_pending(db.connection()).expect("enumerate");
    assert_eq!(pending.len(), 1);
    let row = &pending[0];
    let settlement = propose_effect_recovery(row, Some(&succeeded));
    let applied = match &settlement {
        EffectSettlement::Applied { evidence_digest } => evidence_digest.clone(),
        other => panic!("expected Applied, got {other:?}"),
    };
    let settled = ExternalEffectJournalRecord {
        journal_revision: 2,
        state: EffectJournalState::Applied,
        evidence_digest: Some(applied.clone()),
        ..row.clone()
    };
    let outcome = cas_settle(
        db.connection_mut(),
        &EffectCasKey {
            claim: claim_of(row),
            expected_journal_revision: 1,
            expected_state: EffectJournalState::Intended,
            correlation: Some(EffectCorrelation::from_record(row)),
        },
        &settled,
    )
    .expect("settle");
    assert!(matches!(outcome, EffectCasOutcome::Committed { .. }));
    let reloaded = load_exact(db.connection(), &claim_of(row))
        .expect("load")
        .expect("present");
    assert_eq!(reloaded.state, EffectJournalState::Applied);

    // Absent ledger evidence (recovery cannot see a terminal record) → the
    // pure decision keeps UNKNOWN_OUTCOME; nothing redispatches.
    let second_record = intended_record("op-2", digest(0x5c), digest(0x9a));
    assert!(matches!(
        insert_intent(db.connection_mut(), &second_record),
        Ok(EffectJournalInsertDisposition::Inserted { .. })
    ));
    let pending2 = enumerate_pending(db.connection()).expect("enumerate");
    let op2 = pending2
        .iter()
        .find(|r| r.claim.operation_id == "op-2")
        .expect("op-2 pending");
    let settlement_unknown = propose_effect_recovery(op2, None);
    assert!(matches!(
        settlement_unknown,
        EffectSettlement::UnknownOutcome
    ));
    assert!(
        assert_operation_claimable(db.connection(), INSTANCE, MODULE, "op-2").is_err(),
        "an existing INTENDED operation blocks a replacement Claim before minting"
    );
}
#[test]
fn new_claim_cannot_consume_old_terminal_evidence() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let (binding, old_record) = authoritative_record("op-same");
    seed_succeeded_ledger(&mut db, &binding);
    insert_intent(db.connection_mut(), &old_record).expect("old intent");
    let evidence = dolly_storage::tool_ledger::load_exact(
        db.connection(),
        &binding.module_id,
        &binding.operation_id,
    )
    .expect("load ledger")
    .expect("ledger")
    .terminal_result_digest
    .expect("evidence");
    let old_applied = ExternalEffectJournalRecord {
        journal_revision: 2,
        state: EffectJournalState::Applied,
        evidence_digest: Some(evidence.clone()),
        ..old_record.clone()
    };
    let old_outcome = cas_settle(
        db.connection_mut(),
        &EffectCasKey {
            claim: old_record.claim.clone(),
            expected_journal_revision: 1,
            expected_state: EffectJournalState::Intended,
            correlation: Some(EffectCorrelation::from_record(&old_record)),
        },
        &old_applied,
    )
    .expect("old settlement");
    assert!(matches!(old_outcome, EffectCasOutcome::Committed { .. }));

    let mut new_record = old_record.clone();
    new_record.controller_generation += 1;
    new_record.extension_generation += 1;
    new_record.worker_epoch = "01newclaimgeneration000000000000".into();
    new_record.claim.operation_digest = new_record.operation_digest.clone();
    new_record.claim.claim_token = derive_claim_token(
        &new_record.claim.instance_id,
        &new_record.claim.module_id,
        &new_record.claim.operation_id,
        &new_record.operation_digest,
        new_record.controller_generation,
        new_record.extension_generation,
        &new_record.worker_epoch,
        &new_record.package_digest,
        &new_record.policy_premise_digest,
        new_record.effect_class,
    );
    new_record.verify().expect("new Claim");
    insert_intent(db.connection_mut(), &new_record).expect("new intent");
    let new_applied = ExternalEffectJournalRecord {
        journal_revision: 2,
        state: EffectJournalState::Applied,
        evidence_digest: Some(evidence),
        ..new_record.clone()
    };
    let new_outcome = cas_settle(
        db.connection_mut(),
        &EffectCasKey {
            claim: new_record.claim.clone(),
            expected_journal_revision: 1,
            expected_state: EffectJournalState::Intended,
            correlation: Some(EffectCorrelation::from_record(&new_record)),
        },
        &new_applied,
    )
    .expect("ambiguous new Claim settlement");
    assert!(matches!(new_outcome, EffectCasOutcome::Stale { .. }));
    assert_eq!(
        load_exact(db.connection(), &new_record.claim)
            .expect("load new Claim")
            .expect("new Claim row")
            .state,
        EffectJournalState::Intended
    );
}

// ---------------------------------------------------------------------------
// fail-closed: corrupt / version mismatched
// ---------------------------------------------------------------------------

#[test]
fn version_mismatched_journal_fails_closed() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let record = intended_record("op-1", digest(0x5a), digest(0x99));
    assert!(matches!(
        insert_intent(db.connection_mut(), &record),
        Ok(EffectJournalInsertDisposition::Inserted { .. })
    ));
    // A version-3 singleton write is refused by the schema CHECK (= 2): the
    // runtime fails closed instead of writing a mismatched premise.
    let tamper = db.connection().execute(
        "UPDATE external_effect_journal_meta SET schema_version = 3",
        [],
    );
    assert!(tamper.is_err(), "a version-3 singleton write is refused");

    // Delete the meta singleton: a missing premise fails closed as
    // STORAGE_MIGRATION_REQUIRED on every writer and reader gate.
    db.connection()
        .execute("DELETE FROM external_effect_journal_meta", [])
        .expect("remove the meta singleton");
    assert!(matches!(
        gate_schema_version(db.connection()),
        Err(StorageError::MigrationRequired)
    ));
    assert!(matches!(
        insert_intent(
            db.connection_mut(),
            &intended_record("op-9", digest(0x5d), digest(0x9b))
        ),
        Err(StorageError::MigrationRequired)
    ));
    assert!(matches!(
        enumerate_pending(db.connection()),
        Err(StorageError::MigrationRequired)
    ));
}
#[test]
fn ordinary_reopen_never_repairs_missing_journal_schema() {
    let dir = tempdir();
    let db = open_db(dir.path());
    db.connection()
        .execute("DROP TABLE external_effect_journal", [])
        .expect("remove journal table");
    drop(db);
    assert!(matches!(
        Database::open(&dir.path().join("instance.sqlite")),
        Err(StorageError::Corrupt)
    ));

    let dir = tempdir();
    let db = open_db(dir.path());
    db.connection()
        .execute("DELETE FROM external_effect_journal_meta", [])
        .expect("remove journal metadata");
    drop(db);
    assert!(matches!(
        Database::open(&dir.path().join("instance.sqlite")),
        Err(StorageError::MigrationRequired)
    ));
}

#[test]
fn tampered_physical_index_and_check_schema_fails_closed() {
    let dir = tempdir();
    let db = open_db(dir.path());
    db.connection()
        .execute_batch(
            "PRAGMA writable_schema = ON;
             UPDATE sqlite_master
                SET sql = replace(sql, 'state, instance_id', 'instance_id, state')
              WHERE type = 'index' AND name = 'effect_journal_recovery';
             PRAGMA schema_version = 2;
             PRAGMA writable_schema = OFF;",
        )
        .expect("tamper sqlite schema");
    assert!(
        matches!(
            gate_schema_version(db.connection()),
            Err(StorageError::Corrupt)
        ),
        "index order tampering must not be repaired or accepted"
    );
}

#[test]
fn corrupt_bytes_fail_closed_on_read_and_pending_enumeration() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let record = intended_record("op-1", digest(0x5a), digest(0x99));
    assert!(matches!(
        insert_intent(db.connection_mut(), &record),
        Ok(EffectJournalInsertDisposition::Inserted { .. })
    ));
    // Flip a byte inside record_jcs; the row is now corrupt.
    db.connection()
        .execute(
            "UPDATE external_effect_journal SET record_jcs = X'00' WHERE claim_token = ?1",
            rusqlite::params![record.claim.claim_token.to_canonical_string()],
        )
        .expect("corrupt the row");
    assert!(matches!(
        load_exact(db.connection(), &claim_of(&record)),
        Err(StorageError::Corrupt)
    ));
    assert!(matches!(
        enumerate_pending(db.connection()),
        Err(StorageError::Corrupt)
    ));
}

#[test]
fn corrupt_digest_fails_closed_on_read() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let record = intended_record("op-1", digest(0x5a), digest(0x99));
    assert!(matches!(
        insert_intent(db.connection_mut(), &record),
        Ok(EffectJournalInsertDisposition::Inserted { .. })
    ));
    db.connection()
        .execute(
            "UPDATE external_effect_journal SET record_digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'",
            [],
        )
        .expect("corrupt digest");
    assert!(matches!(
        load_exact(db.connection(), &claim_of(&record)),
        Err(StorageError::Corrupt)
    ));
}

// ---------------------------------------------------------------------------
// bounded storage limits
// ---------------------------------------------------------------------------

#[test]
fn pending_row_ceiling_refuses_unbounded_backlog() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    let ceiling = dolly_storage::effect_journal::MAX_EFFECT_JOURNAL_ROWS;
    // Fill to the ceiling with distinct operations (distinct claim contexts).
    for i in 0..ceiling {
        let record = intended_record(
            &format!("op-{i}"),
            digest(0x5a),
            digest((i % 250) as u8 + 1),
        );
        assert!(
            matches!(
                insert_intent(db.connection_mut(), &record),
                Ok(EffectJournalInsertDisposition::Inserted { .. })
            ),
            "filling to ceiling"
        );
    }
    let over = intended_record("op-overflow", digest(0x5e), digest(0xfc));
    assert!(
        matches!(
            insert_intent(db.connection_mut(), &over),
            Err(StorageError::Full)
        ),
        "one row past the ceiling is refused"
    );
    // The refused intent never became durable.
    let pending = enumerate_pending(db.connection()).expect("enumerate");
    assert_eq!(pending.len() as u64, ceiling);
    assert!(
        pending
            .iter()
            .all(|r| r.claim.operation_id != "op-overflow")
    );
}

#[test]
fn jcs_byte_ceiling_refuses_overlarge_intent() {
    let dir = tempdir();
    let mut db = open_db(dir.path());
    // Force a record whose JCS exceeds the fixed per-record ceiling.
    let ceiling = dolly_storage::effect_journal::MAX_EFFECT_JOURNAL_JCS_BYTES;
    let padded_epoch = "e".repeat(ceiling + 1);
    let operation_digest = digest(0xff);
    let claim_token = derive_claim_token(
        INSTANCE,
        MODULE,
        "op-big",
        &operation_digest,
        CONTROLLER,
        EXTENSION_GENERATION,
        &padded_epoch,
        &package_digest(),
        &policy_digest(),
        EffectClass::McpToolsCall,
    );
    let big = ExternalEffectJournalRecord {
        schema: EffectJournalRecordSchemaTag,
        journal_revision: 1,
        state: EffectJournalState::Intended,
        claim: Claim {
            schema: ClaimRecordSchemaTag,
            instance_id: INSTANCE.into(),
            module_id: MODULE.into(),
            operation_id: "op-big".into(),
            operation_digest: operation_digest.clone(),
            claim_token,
        },
        controller_generation: CONTROLLER,
        extension_generation: EXTENSION_GENERATION,
        worker_epoch: padded_epoch,
        package_digest: package_digest(),
        policy_premise_digest: policy_digest(),
        operation_digest: digest(0xff),
        effect_class: EffectClass::McpToolsCall,
        intent_digest: digest(0x5e),
        evidence_digest: None,
    };
    assert!(
        matches!(
            insert_intent(db.connection_mut(), &big),
            Err(StorageError::Full)
        ),
        "overlarge intent is refused before mutation"
    );
}
#[test]
fn retention_frees_only_fully_settled_rows_and_fails_closed_otherwise() {
    let dir = tempdir();
    let cap = dolly_storage::effect_journal::MAX_EFFECT_JOURNAL_ROWS;
    let half = cap / 2;
    let mut db = open_db(dir.path());
    let mut settled_claims = Vec::new();
    // Settle half the journal rows into APPLIED (deletable by retention).
    for i in 0..half {
        let (binding, record) = authoritative_record(&format!("op-s-{i}"));
        seed_succeeded_ledger(&mut db, &binding);
        assert!(
            matches!(
                insert_intent(db.connection_mut(), &record),
                Ok(EffectJournalInsertDisposition::Inserted { .. })
            ),
            "settle-source {i}"
        );
        let evidence_digest = dolly_storage::tool_ledger::load_exact(
            db.connection(),
            &binding.module_id,
            &binding.operation_id,
        )
        .expect("load ledger")
        .expect("ledger present")
        .terminal_result_digest
        .expect("terminal evidence");
        let applied = ExternalEffectJournalRecord {
            journal_revision: 2,
            state: EffectJournalState::Applied,
            evidence_digest: Some(evidence_digest),
            ..record.clone()
        };
        match cas_settle(
            db.connection_mut(),
            &EffectCasKey {
                claim: claim_of(&record),
                expected_journal_revision: 1,
                expected_state: EffectJournalState::Intended,
                correlation: Some(EffectCorrelation::from_record(&record)),
            },
            &applied,
        ) {
            Ok(EffectCasOutcome::Committed { .. }) => settled_claims.push(claim_of(&record)),
            other => panic!("expected committed settle, got {other:?}"),
        }
    }
    // Fill the remaining half with pending intents (never deletable). The
    // journal reaches its cap; retention has not run during the fill.
    for i in half..cap {
        let record = intended_record(
            &format!("op-p-{i}"),
            digest(0x5f),
            digest((i % 250) as u8 + 1),
        );
        assert!(
            matches!(
                insert_intent(db.connection_mut(), &record),
                Ok(EffectJournalInsertDisposition::Inserted { .. })
            ),
            "pending fill {i}"
        );
    }
    let oldest = load_exact(db.connection(), &settled_claims[0])
        .expect("load oldest candidate")
        .expect("oldest settled row");
    let (_, oldest_digest) = oldest
        .canonical_bytes_and_digest()
        .expect("canonical oldest row");
    let admitted = intended_record("op-admitted", digest(0x60), digest(0x61));
    db.connection()
        .execute(
            "UPDATE external_effect_journal SET record_digest = ?1
             WHERE claim_token = ?2",
            rusqlite::params![
                digest(0xee).to_canonical_string(),
                settled_claims[0].claim_token.to_canonical_string()
            ],
        )
        .expect("corrupt retention candidate digest");
    assert!(matches!(
        insert_intent(db.connection_mut(), &admitted),
        Err(StorageError::Corrupt)
    ));
    db.connection()
        .execute(
            "UPDATE external_effect_journal SET record_digest = ?1
             WHERE claim_token = ?2",
            rusqlite::params![
                oldest_digest.to_canonical_string(),
                settled_claims[0].claim_token.to_canonical_string()
            ],
        )
        .expect("restore retention candidate digest");
    match insert_intent(db.connection_mut(), &admitted).expect("retention frees capacity") {
        EffectJournalInsertDisposition::Inserted { .. } => {}
        other => panic!("expected a fresh insert after retention, got {other:?}"),
    }
    assert!(
        matches!(load_exact(db.connection(), &settled_claims[0]), Ok(None)),
        "the deterministically oldest settled row is released"
    );
    for claim in settled_claims.iter().skip(1) {
        let loaded = load_exact(db.connection(), claim)
            .expect("load")
            .expect("younger settled row retained");
        assert_eq!(loaded.state, EffectJournalState::Applied);
    }
    let after = enumerate_pending(db.connection()).expect("enumerate");
    assert_eq!(
        after.len() as u64,
        half + 1,
        "pending rows survive retention"
    );
    assert!(after.iter().any(|r| r.claim.operation_id == "op-admitted"));
    // Crash-and-reopen proves retention durability: released rows stay gone,
    // pending rows survive intact, and retained settled rows survive.
    drop(db);
    let db = open_db(dir.path());
    assert!(
        matches!(load_exact(db.connection(), &settled_claims[0]), Ok(None)),
        "no released row comes back on reopen"
    );
    for claim in settled_claims.iter().skip(1) {
        let loaded = load_exact(db.connection(), claim)
            .expect("load")
            .expect("settled row present on reopen");
        assert_eq!(loaded.state, EffectJournalState::Applied);
    }
    assert_eq!(
        enumerate_pending(db.connection()).expect("enumerate").len() as u64,
        half + 1,
        "pending rows (never deletable) survive reopen intact"
    );
}

#[test]
fn unknown_outcome_rows_survive_capacity_retention() {
    let dir = tempdir();
    let cap = dolly_storage::effect_journal::MAX_EFFECT_JOURNAL_ROWS;
    let quarter = cap / 4;
    let mut db = open_db(dir.path());
    let mut settled_claims = Vec::new();
    // Settle to APPLIED (deletable).
    for i in 0..quarter {
        let (binding, record) = authoritative_record(&format!("op-a-{i}"));
        seed_succeeded_ledger(&mut db, &binding);
        assert!(
            matches!(
                insert_intent(db.connection_mut(), &record),
                Ok(EffectJournalInsertDisposition::Inserted { .. })
            ),
            "applied-source {i}"
        );
        let evidence_digest = dolly_storage::tool_ledger::load_exact(
            db.connection(),
            &binding.module_id,
            &binding.operation_id,
        )
        .expect("load ledger")
        .expect("ledger present")
        .terminal_result_digest
        .expect("terminal evidence");
        let applied = ExternalEffectJournalRecord {
            journal_revision: 2,
            state: EffectJournalState::Applied,
            evidence_digest: Some(evidence_digest),
            ..record.clone()
        };
        assert!(
            matches!(
                cas_settle(
                    db.connection_mut(),
                    &EffectCasKey {
                        claim: claim_of(&record),
                        expected_journal_revision: 1,
                        expected_state: EffectJournalState::Intended,
                        correlation: Some(EffectCorrelation::from_record(&record)),
                    },
                    &applied,
                ),
                Ok(EffectCasOutcome::Committed { .. })
            ),
            "applied settle {i}"
        );
        settled_claims.push(claim_of(&record));
    }
    let mut unknown_claims = Vec::new();
    // Settle to UNKNOWN_OUTCOME (ambiguity evidence, never deletable).
    for i in 0..quarter {
        let record = intended_record(
            &format!("op-u-{i}"),
            digest(0x72),
            digest((i % 250) as u8 + 1),
        );
        assert!(
            matches!(
                insert_intent(db.connection_mut(), &record),
                Ok(EffectJournalInsertDisposition::Inserted { .. })
            ),
            "unknown-source {i}"
        );
        unknown_claims.push(claim_of(&record));
    }
    settle_pending_effect_journal(&mut db).expect("unknown recovery");
    // Fill the remaining half with pending intents (never deletable) up to
    // the whole-journal cap; retention has not run during the fill.
    for i in (2 * quarter)..cap {
        let record = intended_record(
            &format!("op-q-{i}"),
            digest(0x73),
            digest((i % 250) as u8 + 1),
        );
        assert!(
            matches!(
                insert_intent(db.connection_mut(), &record),
                Ok(EffectJournalInsertDisposition::Inserted { .. })
            ),
            "pending fill {i}"
        );
    }
    assert_eq!(
        enumerate_pending(db.connection()).unwrap().len() as u64,
        2 * quarter
    );
    // Capacity retention fires on the next intent and releases only the
    // APPLIED rows (deterministically oldest first): every UNKNOWN_OUTCOME
    // ambiguity record survives.
    let admitted = intended_record("op-u-admitted", digest(0x74), digest(0x75));
    assert!(
        matches!(
            insert_intent(db.connection_mut(), &admitted),
            Ok(EffectJournalInsertDisposition::Inserted { .. })
        ),
        "retention frees capacity so the intent commits"
    );
    assert!(
        matches!(load_exact(db.connection(), &settled_claims[0]), Ok(None)),
        "the deterministically oldest applied row is released"
    );
    for claim in settled_claims.iter().skip(1) {
        let loaded = load_exact(db.connection(), claim)
            .expect("load")
            .expect("younger applied row retained");
        assert_eq!(loaded.state, EffectJournalState::Applied);
    }
    for claim in &unknown_claims {
        let loaded = load_exact(db.connection(), claim)
            .expect("load")
            .expect("UNKNOWN_OUTCOME row present");
        assert_eq!(loaded.state, EffectJournalState::UnknownOutcome);
    }
    let pending = enumerate_pending(db.connection()).unwrap();
    assert_eq!(
        pending.len() as u64,
        2 * quarter + 1,
        "pending rows survive retention"
    );
    assert!(
        pending
            .iter()
            .any(|r| r.claim.operation_id == "op-u-admitted")
    );
    // Crash-and-reopen durability: released rows stay gone, UNKNOWN_OUTCOME
    // rows stay, pending rows survive.
    drop(db);
    let db = open_db(dir.path());
    assert!(
        matches!(load_exact(db.connection(), &settled_claims[0]), Ok(None)),
        "no released row comes back on reopen"
    );
    for claim in settled_claims.iter().skip(1) {
        assert_eq!(
            load_exact(db.connection(), claim)
                .expect("load")
                .expect("settled row on reopen")
                .state,
            EffectJournalState::Applied
        );
    }
    for claim in &unknown_claims {
        let loaded = load_exact(db.connection(), claim)
            .expect("load")
            .expect("UNKNOWN_OUTCOME row present on reopen");
        assert_eq!(loaded.state, EffectJournalState::UnknownOutcome);
    }
    assert_eq!(
        enumerate_pending(db.connection()).unwrap().len() as u64,
        2 * quarter + 1,
        "pending rows survive reopen intact"
    );
}
