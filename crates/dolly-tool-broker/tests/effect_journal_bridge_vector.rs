//! Cross-language JCS corpus checks for the explicit bridge contract.
//!
//! This test consumes the shared vector through the real Rust canonical JSON and
//! effect-journal record types. It does not claim a daemon-to-Worker transport;
//! that public channel remains an integration prerequisite.

use dolly_canonical_json::{ParseLimits, canonicalize, parse_core_json};
use dolly_tool_broker::effect_journal::ExternalEffectJournalRecord;
use serde_json::Value;

const VECTOR: &str = include_str!(
    "../../../dolly-spec/test-vectors/services/TST-TOOL-014-cross-language-effect-journal.json"
);

fn object<'a>(value: &'a Value, field: &str) -> &'a Value {
    value
        .get(field)
        .unwrap_or_else(|| panic!("missing vector field {field}"))
}

fn string<'a>(value: &'a Value, field: &str) -> &'a str {
    object(value, field)
        .as_str()
        .unwrap_or_else(|| panic!("vector field {field} is not a string"))
}

#[test]
fn validates_rust_records_and_exact_shared_jcs_bytes() {
    let vector: Value = serde_json::from_str(VECTOR).expect("valid bridge vector JSON");
    let initial = object(&vector, "initial");
    let contract = object(initial, "contract");
    assert_eq!(string(contract, "schema"), "dolly.effect-journal-bridge/v1");
    assert_eq!(string(object(contract, "source"), "dialect"), "typescript");
    assert_eq!(string(object(contract, "target"), "dialect"), "rust");
    assert_eq!(
        string(object(contract, "canonicalization"), "scheme"),
        "RFC8785-JCS"
    );
    assert_eq!(
        string(object(contract, "ordering"), "first_external_write"),
        "after-claim-intent-commit"
    );
    assert_eq!(
        string(contract, "aggregate_evidence"),
        "never-map-evidenceForRun-directly-to-one-Rust-record; require-each-intent-outcome; terminal-outcome-without-authoritative-ledger-premise-settles-UNKNOWN_OUTCOME"
    );
    assert_eq!(
        object(initial, "public_bridge"),
        &serde_json::json!({
            "daemon_to_worker_transport": "absent",
            "ffi": "absent",
            "disposition": "blocked-no-go",
        })
    );

    let cases = object(initial, "cases")
        .as_array()
        .expect("bridge cases array");
    assert_eq!(cases.len(), 5);
    for case in cases {
        let target = object(case, "target");
        let claim = object(target, "claim");
        let record_value = object(target, "record");
        let canonical = object(case, "canonical");
        let (claim_bytes, claim_digest) = canonicalize(claim).expect("canonical Claim");
        assert_eq!(
            claim_bytes.as_ref(),
            string(canonical, "claim_utf8").as_bytes()
        );
        assert_eq!(
            claim_digest.to_canonical_string(),
            string(canonical, "claim_digest")
        );

        let record: ExternalEffectJournalRecord =
            serde_json::from_value(record_value.clone()).expect("closed Rust journal record");
        record.verify().expect("Claim and journal identity verify");
        let (record_bytes, record_digest) = record
            .canonical_bytes_and_digest()
            .expect("canonical external-effect journal record");
        assert_eq!(
            record_bytes.as_ref(),
            string(canonical, "record_utf8").as_bytes()
        );
        assert_eq!(
            record_digest.to_canonical_string(),
            string(canonical, "record_digest")
        );
        assert_eq!(
            record.state.wire_name(),
            string(case, "expected_state")
        );

        // Feed the exact bytes through the duplicate-rejecting wire parser at
        // the shared protocol depth instead of trusting serde_json alone.
        let parsed = parse_core_json(
            record_bytes.as_ref(),
            ParseLimits::new(96).expect("wire depth"),
        )
        .expect("record bytes parse under the wire depth");
        assert!(matches!(parsed, dolly_canonical_json::CanonicalJsonValue::Object(_)));
    }

    // Premise direction: a terminal source outcome alone is never authority.
    // It settles APPLIED only via an exact, durable, versioned Tool-call ledger
    // premise whose identity tuple matches and whose terminal state is
    // SUCCEEDED; absence of that premise settles UNKNOWN_OUTCOME fail-closed.
    let outcome_mapping = object(contract, "outcome_mapping")
        .as_array()
        .expect("outcome_mapping array");
    let terminal_rule = outcome_mapping
        .iter()
        .find(|entry| object(entry, "source_kind").as_str() == Some("terminal"))
        .expect("terminal outcome rule");
    assert_eq!(string(terminal_rule, "target_state"), "UNKNOWN_OUTCOME");
    assert_eq!(string(terminal_rule, "evidence_rule"), "null");
    let applied_premise = object(terminal_rule, "applied_premise");
    assert_eq!(string(applied_premise, "premise"), "exact-authoritative-tool-call-ledger");
    assert_eq!(string(applied_premise, "ledger_schema"), "dolly.tool-call-ledger/v1");
    assert_eq!(string(applied_premise, "ledger_record_validator"), "tool-call-ledger-record.schema.json");
    assert_eq!(string(applied_premise, "terminal_state"), "SUCCEEDED");
    assert_eq!(string(applied_premise, "evidence_rule"), "ledger.terminal_result_digest");
    assert!(
        applied_premise
            .get("identity_match")
            .and_then(|v| v.as_array())
            .map_or(false, |arr| arr.len() >= 8),
        "applied_premise must list at least eight concrete identity equalities"
    );

    let no_premise = cases
        .iter()
        .find(|entry| entry.get("ledger_premise").and_then(|v| v.as_str()) == Some("absent"))
        .expect("terminal-no-premise case");
    assert_eq!(string(no_premise, "expected_state"), "UNKNOWN_OUTCOME");
    {
        let rec = object(object(no_premise, "target"), "record");
        assert_eq!(string(rec, "state"), "UNKNOWN_OUTCOME");
        assert!(rec.get("evidence_digest").map_or(true, |v| v.is_null()));
    }

    let with_premise = cases
        .iter()
        .find(|entry| {
            entry
                .get("ledger_premise")
                .and_then(|v| v.get("record"))
                .and_then(|v| v.get("schema"))
                .and_then(|v| v.as_str())
                == Some("dolly.tool-call-ledger/v1")
        })
        .expect("terminal-premise case");
    {
        let prem = object(with_premise, "ledger_premise");
        let ledger_record = object(prem, "record");
        assert_eq!(string(ledger_record, "schema"), "dolly.tool-call-ledger/v1");
        assert_eq!(string(ledger_record, "state"), "SUCCEEDED");
        assert_eq!(ledger_record.get("ledger_revision").and_then(|v| v.as_u64()), Some(3));
        let binding = object(ledger_record, "operation_binding");
        let claim = object(object(with_premise, "target"), "claim");
        let rec = object(object(with_premise, "target"), "record");
        assert_eq!(string(rec, "state"), "APPLIED");
        // Concrete Claim/generation/outbound/terminal-result equality with the
        // exact authoritative ledger record. The Claim operation_id is the
        // binding's Host operation_id (production recover_effect_journal compares
        // binding.operation_id, not idempotency_key). No response/ACK evidence.
        assert_eq!(claim.get("operation_id"), binding.get("operation_id"));
        assert_eq!(string(claim, "instance_id"), string(binding, "instance_id"));
        assert_eq!(string(claim, "module_id"), string(binding, "module_id"));
        assert_eq!(claim.get("operation_digest"), ledger_record.get("operation_digest"));
        assert_eq!(rec.get("intent_digest"), ledger_record.get("outbound_digest"));
        assert_eq!(
            rec.get("evidence_digest"),
            ledger_record.get("terminal_result_digest")
        );
        // The embedded premise record must be byte-identical to the production
        // ledger record canonicalized by dolly-tool-broker itself.
        let prod = production_succeeded_ledger();
        let (prod_bytes, _) = dolly_canonical_json::canonicalize(&prod).unwrap();
        let (vec_bytes, _) = dolly_canonical_json::canonicalize(ledger_record).unwrap();
        assert_eq!(
            prod_bytes.as_ref(), vec_bytes.as_ref(),
            "vector premise ledger record must equal the production canonical bytes"
        );
    }
}

/// Build the production-verified SUCCEEDED Tool-call ledger record whose exact
/// canonical bytes are embedded in the TST-TOOL-014 vector premise case. All
/// digests are recomputed by production methods (operation_digest,
/// recompute_outbound_digest, canonicalize(terminal_result)).
fn production_succeeded_ledger() -> dolly_tool_broker::ToolCallLedgerRecord {
    use dolly_canonical_json::{CanonicalJsonObject, CanonicalJsonValue};
    use dolly_tool_broker::{
        ConfirmationDecision, IdempotencyPolicy, LedgerState, SideEffectClass,
        ToolCallLedgerRecord, ToolCallLedgerRecordSchemaTag, ToolOperationBinding,
        ToolOperationBindingSchemaTag, ToolResult, ToolStatus,
    };
    use serde_json::{Value, json};

    let server_contract: CanonicalJsonObject = {
        // The exact schema-valid Server object from
        // dolly-spec/examples/tool-broker-config.stdio.json (local-files),
        // whose retained `read-file` tool admits outbound reconstruction.
        let example: Value = serde_json::from_str(include_str!(
            "../../../dolly-spec/examples/tool-broker-config.stdio.json"
        ))
        .unwrap();
        let cv = CanonicalJsonValue::try_from(example["servers"]["local-files"].clone()).unwrap();
        match cv {
            CanonicalJsonValue::Object(o) => o,
            _ => unreachable!(),
        }
    };
    let binding = ToolOperationBinding {
        schema: ToolOperationBindingSchemaTag,
        instance_id: "instance-1".to_string(),
        module_id: "module-1".to_string(),
        operation_id: "0198ab31-6c44-7e8a-b2bb-000000000501".to_string(),
        tool_transaction_id: "0198ab31-6c44-7e8a-b2bb-000000000502".to_string(),
        activation_id: "0198ab31-6c44-7e8a-b2bb-000000000503".to_string(),
        activation_lease_generation: 1,
        config_revision: 1,
        tool_server_id: "local-files".to_string(),
        tool_name: "read-file".to_string(),
        tool_schema_digest:
            "sha256:cc312e640fbf1a761a84f981be0997e94b5e0a5c13a54808048852bc42fb9368"
                .parse()
                .unwrap(),
        arguments: json!({"path":"hello.txt"}),
        side_effect_class: SideEffectClass::ReadOnly,
        idempotency: IdempotencyPolicy::None,
        idempotency_key: None,
        authorized_deadline: "2026-08-21T01:02:03.000000Z".to_string(),
        request_digest:
            "sha256:1111111111111111111111111111111111111111111111111111111111111111"
                .parse()
                .unwrap(),
        tool_server_generation: 7,
        server_request_id: "0198ab31-6c44-7e8a-b2bb-000000000504".to_string(),
        server_contract,
        confirmation_decision: ConfirmationDecision::NotRequired,
    };
    let op_digest = binding.operation_digest();
    let outbound_digest = binding
        .recompute_outbound_digest()
        .expect("retained contract admits the read-file tool");
    let terminal_result = ToolResult {
        operation_id: binding.operation_id.clone(),
        status: ToolStatus::Succeeded,
        output: json!({"text":"hello"}),
        error: None,
        server_request_id: Some(binding.server_request_id.clone()),
    };
    let (_, tr_digest) =
        dolly_canonical_json::canonicalize(&terminal_result).expect("canonical terminal result");
    ToolCallLedgerRecord {
        schema: ToolCallLedgerRecordSchemaTag,
        ledger_revision: 3,
        state: LedgerState::Succeeded,
        operation_binding: binding,
        operation_digest: op_digest,
        outbound_digest: Some(outbound_digest),
        terminal_result: Some(terminal_result),
        terminal_result_digest: Some(tr_digest),
    }
}

/// The INTENDED journal row that this premise settles APPLIED. Its identity is
/// derived from the production ledger binding so recovery equality holds.
fn intended_journal_for(
    ledger: &dolly_tool_broker::ToolCallLedgerRecord,
) -> ExternalEffectJournalRecord {
    use dolly_canonical_json::Sha256Digest;
    use dolly_tool_broker::effect_journal::{
        Claim, ClaimRecordSchemaTag, EffectClass, EffectJournalRecordSchemaTag,
        EffectJournalState, derive_claim_token,
    };
    let binding = &ledger.operation_binding;
    let package_digest = binding
        .recompute_package_digest()
        .expect("package digest");
    let policy_premise_digest: Sha256Digest =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .parse()
            .unwrap();
    let claim_token = derive_claim_token(
        &binding.instance_id,
        &binding.module_id,
        &binding.operation_id,
        &ledger.operation_digest,
        7,
        11,
        "worker-epoch-1",
        &package_digest,
        &policy_premise_digest,
        EffectClass::McpToolsCall,
    );
    let claim = Claim {
        schema: ClaimRecordSchemaTag,
        instance_id: binding.instance_id.clone(),
        module_id: binding.module_id.clone(),
        operation_id: binding.operation_id.clone(),
        operation_digest: ledger.operation_digest.clone(),
        claim_token,
    };
    ExternalEffectJournalRecord {
        schema: EffectJournalRecordSchemaTag,
        journal_revision: 1,
        state: EffectJournalState::Intended,
        claim,
        controller_generation: 7,
        extension_generation: 11,
        worker_epoch: "worker-epoch-1".to_string(),
        package_digest,
        policy_premise_digest,
        operation_digest: ledger.operation_digest.clone(),
        effect_class: EffectClass::McpToolsCall,
        intent_digest: ledger.outbound_digest.clone().expect("outbound digest"),
        evidence_digest: None,
    }
}

#[test]
fn production_recovery_settles_applied_only_with_exact_ledger_premise() {
    use dolly_tool_broker::effect_journal::{
        EffectClass, EffectJournalState, EffectSettlement, recover_effect_journal,
    };
    use dolly_tool_broker::LedgerState;

    let ledger = production_succeeded_ledger();
    ledger
        .verify_field_combination()
        .expect("production ledger record verifies");
    let journal = intended_journal_for(&ledger);
    journal.verify().expect("journal record verifies");

    // Exact, identity-matching SUCCEEDED premise settles APPLIED with the
    // ledger's terminal_result_digest as evidence (no response/ACK copied).
    match recover_effect_journal(&journal, Some(&ledger)) {
        EffectSettlement::Applied { evidence_digest } => {
            assert_eq!(
                evidence_digest,
                ledger.terminal_result_digest.as_ref().unwrap().clone()
            );
        }
        other => panic!("exact premise must settle Applied, got {other:?}"),
    }

    // Nine bounded mutations: every one settles UNKNOWN_OUTCOME.
    let unknown = |record: &ExternalEffectJournalRecord, prem: Option<&dolly_tool_broker::ToolCallLedgerRecord>| {
        assert_eq!(
            recover_effect_journal(record, prem),
            EffectSettlement::UnknownOutcome
        );
    };

    // 1. Missing premise.
    unknown(&journal, None);

    // 2. Claim operation_id mismatch (not the binding's Host operation_id).
    let mut bad_id = journal.clone();
    bad_id.claim.operation_id = "0198ab31-6c44-7e8a-b2bb-000000000999".to_string();
    unknown(&bad_id, Some(&ledger));

    // 3. instance_id mismatch.
    let mut bad_inst = journal.clone();
    bad_inst.claim.instance_id = "instance-other".to_string();
    unknown(&bad_inst, Some(&ledger));

    // 4. package_digest mismatch (production checks binding.package_digest).
    let mut bad_pkg = journal.clone();
    bad_pkg.package_digest =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            .parse()
            .unwrap();
    unknown(&bad_pkg, Some(&ledger));

    // 5. operation_digest mismatch.
    let mut bad_op = journal.clone();
    let wrong: dolly_canonical_json::Sha256Digest =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            .parse()
            .unwrap();
    bad_op.operation_digest = wrong.clone();
    bad_op.claim.operation_digest = wrong;
    unknown(&bad_op, Some(&ledger));

    // 6. outbound/intent_digest mismatch.
    let mut bad_out = journal.clone();
    bad_out.intent_digest =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            .parse()
            .unwrap();
    unknown(&bad_out, Some(&ledger));

    // 7. Missing terminal result (no evidence to recompute) -> UNKNOWN. A
    // ledger row that lost its terminal_result cannot prove application.
    let mut no_term = ledger.clone();
    no_term.terminal_result = None;
    no_term.terminal_result_digest = None;
    assert!(no_term.verify_field_combination().is_err());
    unknown(&journal, Some(&no_term));

    // 8. Response/ACK-shaped DISPATCHED ledger (non-terminal) -> UNKNOWN.
    let mut dispatched = ledger.clone();
    dispatched.state = LedgerState::Dispatched;
    dispatched.ledger_revision = 2;
    dispatched.terminal_result = None;
    dispatched.terminal_result_digest = None;
    unknown(&journal, Some(&dispatched));

    // 9. Wrong effect class (extension initialize, not tools/call) -> UNKNOWN.
    let mut bad_class = journal.clone();
    bad_class.effect_class = EffectClass::McpInitializeHandshake;
    unknown(&bad_class, Some(&ledger));

    // Extra guard: an already-settled APPLIED journal is not an INTENDED row.
    let mut settled = journal.clone();
    settled.state = EffectJournalState::Applied;
    settled.journal_revision = 2;
    settled.evidence_digest = Some(ledger.terminal_result_digest.clone().unwrap());
    unknown(&settled, Some(&ledger));

    assert_eq!(9usize, 9, "nine bounded mutation cases all settle UNKNOWN_OUTCOME");
}

#[test]
fn preserves_separate_extension_and_mcp_frame_profiles() {
    let vector: Value = serde_json::from_str(VECTOR).expect("valid bridge vector JSON");
    let transport = object(object(&vector, "initial"), "canonical_transport");
    let extension_payload = string(transport, "extension_payload_utf8");
    let payload_bytes = extension_payload.as_bytes();
    assert_eq!(payload_bytes.len(), 109);
    assert_eq!(
        u32::from_be_bytes([0, 0, 0, payload_bytes.len() as u8]),
        109
    );
    assert_eq!(string(transport, "mcp_line_utf8"), format!("{extension_payload}\n"));
    assert_eq!(
        object(transport, "mcp_line_bytes")
            .as_u64()
            .expect("MCP line byte count") as usize,
        payload_bytes.len() + 1
    );
    assert_eq!(object(transport, "extension_wire_depth").as_u64(), Some(3));
    assert_eq!(object(transport, "mcp_wire_depth").as_u64(), Some(3));
}
