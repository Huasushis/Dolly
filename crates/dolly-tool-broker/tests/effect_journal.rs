//! Deterministic contract tests for the pure v1 external-effect journal:
//! claim-token determinism (new attempt requires a new Claim), closed record
//! verification, and the exact settle matrix over authoritative ledger
//! evidence. No SQLite here; the storage slice owns the durable half.

use dolly_canonical_json::{CanonicalJsonObject, Sha256Digest, canonicalize};
use dolly_tool_broker::effect_journal::{
    Claim, ClaimRecordSchemaTag, EffectClass, EffectJournalRecordSchemaTag, EffectJournalState,
    EffectSettlement, ExternalEffectJournalRecord, derive_claim_token, recover_effect_journal,
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
        request_digest: digest(0x63),
        tool_server_generation: 7,
        server_request_id: server_request_id.into(),
        server_contract: server_contract(),
        confirmation_decision: ConfirmationDecision::NotRequired,
    }
}

/// Build a field-consistent ledger record with recomputed digests and an
/// optional terminal result.
fn ledger(
    state: LedgerState,
    outbound_present: bool,
    terminal_result: Option<ToolResult>,
    binding: &ToolOperationBinding,
) -> ToolCallLedgerRecord {
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
    // FAILED for TOOL_DISPATCH_NOT_APPLIED is revision 2 with outbound null.
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

/// Build a field-consistent `INTENDED` journal record bound to the given
/// operation.
#[allow(clippy::too_many_arguments)]
fn intended_record(
    instance_id: &str,
    module_id: &str,
    operation_id: &str,
    controller_generation: u64,
    extension_generation: u64,
    worker_epoch: &str,
    package_digest: &Sha256Digest,
    policy_premise_digest: &Sha256Digest,
    intent_digest: Sha256Digest,
    operation_digest: Sha256Digest,
) -> ExternalEffectJournalRecord {
    let claim_token = derive_claim_token(
        instance_id,
        module_id,
        operation_id,
        &operation_digest,
        controller_generation,
        extension_generation,
        worker_epoch,
        package_digest,
        policy_premise_digest,
        EffectClass::McpToolsCall,
    );
    let record = ExternalEffectJournalRecord {
        schema: EffectJournalRecordSchemaTag,
        journal_revision: 1,
        state: EffectJournalState::Intended,
        claim: Claim {
            schema: ClaimRecordSchemaTag,
            instance_id: instance_id.into(),
            module_id: module_id.into(),
            operation_id: operation_id.into(),
            operation_digest: operation_digest.clone(),
            claim_token,
        },
        controller_generation,
        extension_generation,
        worker_epoch: worker_epoch.into(),
        package_digest: package_digest.clone(),
        policy_premise_digest: policy_premise_digest.clone(),
        operation_digest,
        effect_class: EffectClass::McpToolsCall,
        intent_digest,
        evidence_digest: None,
    };
    record.verify().expect("fixture must verify");
    record
}

const INSTANCE: &str = "c-inst-0001";
const MODULE: &str = "module-a";
const EPOCH: &str = "01jh8w2etc4x70xj26rg8fsdv92";

fn package_digest() -> Sha256Digest {
    format!("sha256:{}", "11".repeat(32))
        .parse()
        .expect("valid package digest")
}
fn policy_digest() -> Sha256Digest {
    digest(0x22)
}

#[test]
fn claim_token_is_deterministic_for_the_same_attempt() {
    let a = derive_claim_token(
        INSTANCE,
        MODULE,
        "op-1",
        &digest(0x33),
        1,
        2,
        EPOCH,
        &package_digest(),
        &policy_digest(),
        EffectClass::McpToolsCall,
    );
    let b = derive_claim_token(
        INSTANCE,
        MODULE,
        "op-1",
        &digest(0x33),
        1,
        2,
        EPOCH,
        &package_digest(),
        &policy_digest(),
        EffectClass::McpToolsCall,
    );
    assert_eq!(a, b);
}

#[test]
fn every_changed_context_mints_a_new_claim() {
    let base = derive_claim_token(
        INSTANCE,
        MODULE,
        "op-1",
        &digest(0x33),
        1,
        2,
        EPOCH,
        &package_digest(),
        &policy_digest(),
        EffectClass::McpToolsCall,
    );
    let variants = [
        derive_claim_token(
            "other-inst",
            MODULE,
            "op-1",
            &digest(0x33),
            1,
            2,
            EPOCH,
            &package_digest(),
            &policy_digest(),
            EffectClass::McpToolsCall,
        ),
        derive_claim_token(
            INSTANCE,
            "module-b",
            "op-1",
            &digest(0x33),
            1,
            2,
            EPOCH,
            &package_digest(),
            &policy_digest(),
            EffectClass::McpToolsCall,
        ),
        derive_claim_token(
            INSTANCE,
            MODULE,
            "op-2",
            &digest(0x34),
            1,
            2,
            EPOCH,
            &package_digest(),
            &policy_digest(),
            EffectClass::McpToolsCall,
        ),
        derive_claim_token(
            INSTANCE,
            MODULE,
            "op-1",
            &digest(0x33),
            9,
            2,
            EPOCH,
            &package_digest(),
            &policy_digest(),
            EffectClass::McpToolsCall,
        ),
        derive_claim_token(
            INSTANCE,
            MODULE,
            "op-1",
            &digest(0x33),
            1,
            9,
            EPOCH,
            &package_digest(),
            &policy_digest(),
            EffectClass::McpToolsCall,
        ),
        derive_claim_token(
            INSTANCE,
            MODULE,
            "op-1",
            &digest(0x33),
            1,
            2,
            "other-epoch",
            &package_digest(),
            &policy_digest(),
            EffectClass::McpToolsCall,
        ),
        derive_claim_token(
            INSTANCE,
            MODULE,
            "op-1",
            &digest(0x33),
            1,
            2,
            EPOCH,
            &digest(0x88),
            &policy_digest(),
            EffectClass::McpToolsCall,
        ),
        derive_claim_token(
            INSTANCE,
            MODULE,
            "op-1",
            &digest(0x33),
            1,
            2,
            EPOCH,
            &package_digest(),
            &digest(0x89),
            EffectClass::McpToolsCall,
        ),
    ];
    for variant in variants {
        assert_ne!(base, variant, "changed context must mint a new Claim");
    }
}

#[test]
fn settled_states_require_revision_two_and_evidence_only_for_applied() {
    let op_digest = digest(0x99);
    let intent = digest(0x5a);
    let base = intended_record(
        INSTANCE,
        MODULE,
        "op-1",
        1,
        2,
        EPOCH,
        &package_digest(),
        &policy_digest(),
        intent,
        op_digest,
    );
    // A settled APPLIED must carry evidence; a corruption of that shape fails
    // verification.
    let applied = ExternalEffectJournalRecord {
        journal_revision: 2,
        state: EffectJournalState::Applied,
        evidence_digest: Some(digest(0x6b)),
        ..base.clone()
    };
    applied.verify().expect("APPLIED with evidence verifies");
    assert!(
        applied.verify().is_ok(),
        "APPLIED with evidence is field-consistent"
    );

    let bad_applied = ExternalEffectJournalRecord {
        journal_revision: 2,
        state: EffectJournalState::Applied,
        evidence_digest: None,
        ..base.clone()
    };
    assert!(
        bad_applied.verify().is_err(),
        "APPLIED without evidence is corruption"
    );

    let unknown = ExternalEffectJournalRecord {
        journal_revision: 2,
        state: EffectJournalState::UnknownOutcome,
        evidence_digest: None,
        ..base.clone()
    };
    assert!(
        unknown.verify().is_ok(),
        "UNKNOWN_OUTCOME without evidence verifies"
    );

    // A settled record carrying a wrong claim token is corruption.
    let tampered = ExternalEffectJournalRecord {
        claim: Claim {
            claim_token: digest(0xaa),
            ..base.claim.clone()
        },
        ..base.clone()
    };
    assert!(
        tampered.verify().is_err(),
        "tampered claim token is corruption"
    );
    let mut arbitrary_digest = base.clone();
    arbitrary_digest.operation_digest = digest(0xbb);
    assert!(
        arbitrary_digest.verify().is_err(),
        "an arbitrary operation digest cannot settle a different Claim"
    );
}

#[test]
fn ledger_evidence_outcomes_follow_the_settle_matrix() {
    let b = binding("op-1", "0198ab31-6c44-7e8a-b2bb-000000000451");
    let outbound = b.recompute_outbound_digest().expect("outbound present");
    let record = intended_record(
        INSTANCE,
        MODULE,
        "op-1",
        1,
        2,
        EPOCH,
        &package_digest(),
        &policy_digest(),
        outbound,
        b.operation_digest(),
    );

    // 1. Susceptible ledger terminal SUCCEEDED → APPLIED.
    let succeeded = ledger(
        LedgerState::Succeeded,
        true,
        Some(ToolResult {
            operation_id: "op-1".into(),
            status: ToolStatus::Succeeded,
            output: json!({"text": "hello"}),
            error: None,
            server_request_id: Some("0198ab31-6c44-7e8a-b2bb-000000000451".into()),
        }),
        &b,
    );
    let settlement = recover_effect_journal(&record, Some(&succeeded));
    match settlement {
        EffectSettlement::Applied { evidence_digest } => {
            assert_eq!(
                evidence_digest,
                succeeded.terminal_result_digest.as_ref().unwrap().clone()
            );
        }
        other => panic!("expected Applied, got {other:?}"),
    }

    // 2. Ledger FAILED + TOOL_DISPATCH_NOT_APPLIED → NOT_APPLIED.
    let not_applied = ledger(
        LedgerState::Failed,
        false,
        Some(dolly_tool_broker::ToolResult::failed(
            "op-1",
            dolly_tool_broker::ToolErrorCode::DispatchNotApplied,
            "zero-byte proof",
        )),
        &b,
    );
    assert!(matches!(
        recover_effect_journal(&record, Some(&not_applied)),
        EffectSettlement::NotApplied { .. }
    ));

    // 3. Ledger FAILED with an actual error (effect applied on the provider)
    // is NOT deterministic non-application → UNKNOWN_OUTCOME.
    let failed_applied = ledger(
        LedgerState::Failed,
        true,
        Some(dolly_tool_broker::ToolResult::failed(
            "op-1",
            dolly_tool_broker::ToolErrorCode::UpstreamFailed,
            "upstream tool failed",
        )),
        &b,
    );
    assert!(matches!(
        recover_effect_journal(&record, Some(&failed_applied)),
        EffectSettlement::UnknownOutcome
    ));

    // 4. Ledger still DISPATCHED (crash between dispatch and terminal):
    // ambiguous → UNKNOWN_OUTCOME.
    let dispatched = ledger(LedgerState::Dispatched, true, None, &b);
    assert!(matches!(
        recover_effect_journal(&record, Some(&dispatched)),
        EffectSettlement::UnknownOutcome
    ));

    // 5. Absent ledger record → UNKNOWN_OUTCOME (absence never settles).
    assert!(matches!(
        recover_effect_journal(&record, None),
        EffectSettlement::UnknownOutcome
    ));
}

#[test]
fn mismatched_identity_or_effect_never_settles_applied() {
    let b = binding("op-1", "0198ab31-6c44-7e8a-b2bb-000000000451");
    let outbound = b.recompute_outbound_digest().expect("outbound present");

    // Different operation identity → ambiguity.
    let other_b = binding("op-2", "0198ab31-6c44-7e8a-b2bb-000000000452");
    let other_ledger = ledger(
        LedgerState::Succeeded,
        true,
        Some(ToolResult {
            operation_id: "op-2".into(),
            status: ToolStatus::Succeeded,
            output: json!({"text": "x"}),
            error: None,
            server_request_id: Some("0198ab31-6c44-7e8a-b2bb-000000000452".into()),
        }),
        &other_b,
    );
    let record = intended_record(
        INSTANCE,
        MODULE,
        "op-1",
        1,
        2,
        EPOCH,
        &package_digest(),
        &policy_digest(),
        outbound,
        other_b.operation_digest(),
    );
    assert!(matches!(
        recover_effect_journal(&record, Some(&other_ledger)),
        EffectSettlement::UnknownOutcome
    ));

    // Same operation, different effect (intent digest != outbound digest) →
    // ambiguity.
    let same_b = binding("op-1", "0198ab31-6c44-7e8a-b2bb-000000000451");
    let same_ledger = ledger(
        LedgerState::Succeeded,
        true,
        Some(ToolResult {
            operation_id: "op-1".into(),
            status: ToolStatus::Succeeded,
            output: json!({"text": "x"}),
            error: None,
            server_request_id: Some("0198ab31-6c44-7e8a-b2bb-000000000451".into()),
        }),
        &same_b,
    );
    let wrong_effect = intended_record(
        INSTANCE,
        MODULE,
        "op-1",
        1,
        2,
        EPOCH,
        &package_digest(),
        &policy_digest(),
        digest(0x5b), // a different intent digest
        same_b.operation_digest(),
    );
    assert!(matches!(
        recover_effect_journal(&wrong_effect, Some(&same_ledger)),
        EffectSettlement::UnknownOutcome
    ));
}
