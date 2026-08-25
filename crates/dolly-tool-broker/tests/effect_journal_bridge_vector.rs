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
        EffectClass, EffectJournalState, EffectSettlement, ExternalEffectJournalRecord,
        recover_effect_journal,
    };
    use dolly_tool_broker::{LedgerState, ToolCallLedgerRecord};
    use serde_json::{Value, json};

    // The exact shared vector is the input to production-equivalent recovery:
    // its premise ledger record is parsed into the production type, and the
    // journal row under settlement is derived from the same binding identity.
    let vector: Value = serde_json::from_str(VECTOR).expect("valid bridge vector JSON");
    let initial = object(&vector, "initial");
    let cases = object(initial, "cases").as_array().unwrap();
    let premise_case = cases
        .iter()
        .find(|entry| {
            entry
                .get("ledger_premise")
                .and_then(|v| v.get("record"))
                .and_then(|v| v.get("schema"))
                .and_then(|v| v.as_str())
                == Some("dolly.tool-call-ledger/v1")
        })
        .expect("terminal-premise case in the shared vector");

    let ledger: ToolCallLedgerRecord = serde_json::from_value(
        object(object(premise_case, "ledger_premise"), "record").clone(),
    )
    .expect("vector premise record parses as the production ToolCallLedgerRecord");
    ledger
        .verify_field_combination()
        .expect("vector premise ledger verifies");

    let journal = intended_journal_for(&ledger);
    journal.verify().expect("journal record verifies");

    // Exact premise settles APPLIED with the ledger terminal_result_digest.
    match recover_effect_journal(&journal, Some(&ledger)) {
        EffectSettlement::Applied { evidence_digest } => {
            assert_eq!(
                evidence_digest,
                ledger.terminal_result_digest.as_ref().unwrap().clone()
            );
        }
        other => panic!("exact premise must settle Applied, got {other:?}"),
    }

    // Nine named fail-closed mutations; every one must settle UNKNOWN_OUTCOME.
    const MUTATION_NAMES: [&str; 9] = [
        "missing_premise",
        "extra_forbidden_field",
        "claim_identity_mismatch",
        "dispatch_generation_mismatch",
        "operation_binding_digest_mismatch",
        "outbound_bytes_digest_mismatch",
        "terminal_result_bytes_digest_mismatch",
        "response_ack_cache_readiness_candidate",
        "effect_class_settlement_mismatch",
    ];

    let wrong_digest: dolly_canonical_json::Sha256Digest =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            .parse()
            .unwrap();
    let unknown =
        |name: &str,
         record: &ExternalEffectJournalRecord,
         prem: Option<&ToolCallLedgerRecord>| {
            assert_eq!(
                recover_effect_journal(record, prem),
                EffectSettlement::UnknownOutcome,
                "mutation {name} must fail closed"
            );
        };

    for name in MUTATION_NAMES {
        match name {
            // 1. No ledger premise at all.
            "missing_premise" => unknown(name, &journal, None),
            // 2. Extra member on the premise record that the production
            //    deserializer must reject outright (closed world).
            "extra_forbidden_field" => {
                let raw = object(premise_case, "ledger_premise").clone();
                let rec = object(&raw, "record").clone();
                let mut extra = match rec {
                    Value::Object(m) => m,
                    _ => unreachable!(),
                };
                extra.insert("mutable_queue_state".to_string(), json!("ready"));
                let parsed: Result<ToolCallLedgerRecord, _> =
                    serde_json::from_value(Value::Object(extra));
                assert!(parsed.is_err(), "{name}: forbidden field must be rejected");
                // A premise the production type rejects can never authorize
                // application, so recovery sees no usable premise.
                unknown(name, &journal, None);
            }
            // 3. Claim identity differs from the binding operation identity.
            "claim_identity_mismatch" => {
                let mut bad = journal.clone();
                bad.claim.operation_id = "0198ab31-6c44-7e8a-b2bb-000000000999".to_string();
                unknown(name, &bad, Some(&ledger));
            }
            // 4. Dispatch generation differs: a genuine ledger row of ANOTHER
            //    generation is internally valid, but its recomputed
            //    operation_digest can no longer equal the journal's frozen
            //    digest, so production recovery rejects it.
            "dispatch_generation_mismatch" => {
                let mut other_gen = ledger.clone();
                other_gen.operation_binding.activation_lease_generation += 1;
                other_gen.operation_binding.tool_server_generation += 1;
                other_gen.operation_digest = other_gen.operation_binding.operation_digest();
                other_gen
                    .verify_field_combination()
                    .expect("mutated premise stays an internally valid ledger row");
                assert_ne!(
                    other_gen.operation_digest,
                    journal.operation_digest,
                    "{name}: generation change must move the operation digest"
                );
                unknown(name, &journal, Some(&other_gen));
            }
            // 5. Operation binding/digest mismatch.
            "operation_binding_digest_mismatch" => {
                let mut bad = journal.clone();
                bad.operation_digest = wrong_digest.clone();
                bad.claim.operation_digest = wrong_digest.clone();
                unknown(name, &bad, Some(&ledger));
            }
            // 6. Outbound bytes/digest mismatch.
            "outbound_bytes_digest_mismatch" => {
                let mut bad = journal.clone();
                bad.intent_digest = wrong_digest.clone();
                unknown(name, &bad, Some(&ledger));
            }
            // 7. Terminal result bytes/digest mismatch: tampering the stored
            //    result bytes breaks the production verifier, so the premise is
            //    corrupt and cannot authorize application.
            "terminal_result_bytes_digest_mismatch" => {
                let mut prem = ledger.clone();
                if let Some(result) = prem.terminal_result.as_mut() {
                    result.output = Value::String("tampered".to_string());
                }
                assert_ne!(
                    prem.terminal_result_digest,
                    prem.recompute_terminal_result_digest(),
                    "{name}: tampered bytes must not match the stored digest"
                );
                assert!(
                    prem.verify_field_combination().is_err(),
                    "{name}: corrupted premise must be rejected by the production verifier"
                );
                // A premise that fails verification is unusable; recovery sees
                // no valid terminal evidence and must fail closed.
                unknown(name, &journal, None);
            }
            // 8. A response/ACK/cache/readiness-shaped candidate carries no
            //    authoritative terminal result at all.
            "response_ack_cache_readiness_candidate" => {
                let mut prem = ledger.clone();
                prem.state = LedgerState::Dispatched;
                prem.ledger_revision = 2;
                prem.terminal_result = None;
                prem.terminal_result_digest = None;
                unknown(name, &journal, Some(&prem));
            }
            // 9. Wrong effect class / already-settled row.
            "effect_class_settlement_mismatch" => {
                let mut bad = journal.clone();
                bad.effect_class = EffectClass::McpInitializeHandshake;
                unknown(name, &bad, Some(&ledger));
                let mut settled = journal.clone();
                settled.state = EffectJournalState::Applied;
                settled.journal_revision = 2;
                settled.evidence_digest =
                    Some(ledger.terminal_result_digest.clone().unwrap());
                unknown(name, &settled, Some(&ledger));
            }
            other => panic!("unhandled mutation {other}"),
        }
    }
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
