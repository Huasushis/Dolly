//! RED dispatch-loss / no-redispatch contract tests for the durable
//! Tool-call ledger (spec §5/§6, REQ-TOOL-002/REQ-TOOL-006, TST-TOOL-001/002/006,
//! INV-STORAGE-017).
//!
//! Written BEFORE the storage transaction API exists: this file drives the
//! `dolly_tool_broker` durable-state surface that is not backed by SQLite yet,
//! so running the pure decision over the closed record is the RED gate for
//! what the Host must persist and re-decode byte-for-byte.
//!
//! The contract under test is the pure-core durable dispatch boundary
//! decision. It must:
//!   - recover a row that crossed the durable `DISPATCHED` marker and lost
//!     its authoritative result to terminal `UNKNOWN` with
//!     `TOOL_EXTERNAL_OUTCOME_UNKNOWN`, `automatic_redispatch_count = 0`,
//!     and an unchanged outbound digest for every v1 side-effect class
//!     (REQ-TOOL-002; `argument_key`/`idempotent_write` is not a
//!     durable-deduplication attestation);
//!   - terminate a crash before the durable dispatch marker as
//!     `TOOL_DISPATCH_NOT_APPLIED` only with authoritative zero-byte proof,
//!     and propose a permit-eligible dispatch only when the exact generation
//!     is still Ready with a live deadline (REQ-TOOL-006 / TST-TOOL-009);
//!   - never re-issue or re-count a backend/server call, so a downstream
//!     ACK/result/error/absence can never become upstream redispatch
//!     authority, and re-authorization after `not_applied` is a fresh
//!     operation under a new identity;
//!   - derive the identical disposition across reopen from the same durable
//!     `record_jcs` bytes (restart test) and tie every disposition to the
//!     recomputed record/operation/outbound digests (INV-STORAGE-002/017).

use dolly_canonical_json::{CanonicalJsonObject, Sha256Digest, canonicalize};
use dolly_tool_broker::{
    ConfirmationDecision, DispatchDisposition, IdempotencyPolicy, LedgerRecordError, LedgerState,
    RecoveryFacts, RecoveryFactsSource, SideEffectClass, ToolCallLedgerRecord,
    ToolCallLedgerRecordSchemaTag, ToolErrorCode, ToolOperationBinding,
    ToolOperationBindingSchemaTag, ToolStatus, recover_operation,
};
use serde_json::json;

fn digest_hex(full: &str) -> Sha256Digest {
    full.parse().expect("valid sha256 digest string")
}

/// Canonical closed `Server` contract object used by the frozen binding
/// (spec §5 `server_contract`). Contains the tool map entry the outbound
/// payload reconstruction needs (`upstream_name`).
fn server_contract(tool_name: &str, upstream_name: &str) -> CanonicalJsonObject {
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
            tool_name: {
                "upstream_name": upstream_name,
                "description": "fixture tool",
                "input_schema": {"type": "object", "additionalProperties": false, "properties": {}},
                "input_schema_digest": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
                "output_schema": {"type": "object", "additionalProperties": false, "properties": {}},
                "output_schema_digest": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
                "side_effect_class": "non_idempotent_write",
                "idempotency": {"kind": "none"},
                "requires_confirmation": false,
                "enabled": true
            }
        }
    });
    serde_json::from_value::<CanonicalJsonObject>(server).expect("server contract is canonical")
}

/// Build a complete closed operation binding (spec §5). Reused by every
/// fixture so the embedded `server_contract` is byte-stable.
fn binding(
    operation_id: &str,
    side_effect_class: SideEffectClass,
    idempotency: IdempotencyPolicy,
    server_request_id: &str,
) -> ToolOperationBinding {
    let request_digest =
        digest_hex("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
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
        tool_schema_digest: digest_hex(
            "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        ),
        arguments: serde_json::from_value(json!({"path": "notes/example.txt"})).unwrap(),
        side_effect_class,
        idempotency,
        idempotency_key: None,
        authorized_deadline: "2026-08-21T00:00:00.000000Z".into(),
        request_digest,
        tool_server_generation: 7,
        server_request_id: server_request_id.into(),
        server_contract: server_contract("read-file", "read_file"),
        confirmation_decision: ConfirmationDecision::NotRequired,
    }
}

/// Minimum-friction closed record constructor: it wires `operation_digest`
/// from the binding and `outbound_digest` from a recomputed payload when the
/// state requires one, so fixtures cannot drift from the digest authority.
fn record(
    state: LedgerState,
    ledger_revision: u64,
    outbound_present: bool,
    terminal_result: Option<dolly_tool_broker::ToolResult>,
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
    let record = ToolCallLedgerRecord {
        schema: ToolCallLedgerRecordSchemaTag,
        ledger_revision,
        state,
        operation_binding: binding.clone(),
        operation_digest: binding.operation_digest(),
        outbound_digest,
        terminal_result,
        terminal_result_digest,
    };
    assert!(
        record.verify_field_combination().is_ok(),
        "fixture must be a field-consistent closed record: {:?}",
        record.verify_field_combination()
    );
    record
}

/// Durable row mirroring the TST-TOOL-001 initial state: the durable
/// `DISPATCHED` marker crossed (revision 2, outbound digest present),
/// authoritative response lost.
fn dispatched_row() -> ToolCallLedgerRecord {
    let binding = binding(
        "0198ab31-6c44-7e8a-b2bb-000000000341",
        SideEffectClass::NonIdempotentWrite,
        IdempotencyPolicy::None,
        "0198ab31-6c44-7e8a-b2bb-000000000451",
    );
    record(LedgerState::Dispatched, 2, true, None, &binding)
}

/// Zero-byte-proved AUTHORIZED row (TST-TOOL-006 initial): revision 1, no
/// outbound digest, no eligible/sent bytes.
fn authorized_zero_byte_row() -> ToolCallLedgerRecord {
    let binding = binding(
        "0198ab31-6c44-7e8a-b2bb-000000000346",
        SideEffectClass::NonIdempotentWrite,
        IdempotencyPolicy::None,
        "0198ab31-6c44-7e8a-b2bb-000000000446",
    );
    record(LedgerState::Authorized, 1, false, None, &binding)
}


struct TestFacts {
    zero_bytes_proved: bool,
    exact_generation_ready: bool,
    deadline_expired: bool,
}

// SAFETY: this test source models the coordinator's private fence only.
unsafe impl RecoveryFactsSource for TestFacts {
    fn facts_for(&self, _record: &ToolCallLedgerRecord) -> (bool, bool, bool) {
        (
            self.zero_bytes_proved,
            self.exact_generation_ready,
            self.deadline_expired,
        )
    }
}
/// The facts a reopened AUTHORIZED row needs before a retry/pass disposition
/// can be picked (depended on by every test that crosses the boundary).
fn facts(
    zero_bytes_proved: bool,
    exact_generation_ready: bool,
    deadline_expired: bool,
) -> RecoveryFacts {
    let source = TestFacts {
        zero_bytes_proved,
        exact_generation_ready,
        deadline_expired,
    };
    // The decision records below all carry the same closed-row identity.
    RecoveryFacts::from_authoritative_source(&source, &authorized_zero_byte_row())
}

/// Full TST-TOOL-001 / REQ-TOOL-002 outcome: the durable `DISPATCHED` marker
/// crossed, response lost — recovery MUST be terminal
/// `UNKNOWN`/`TOOL_EXTERNAL_OUTCOME_UNKNOWN`, `retryable:false`,
/// `automatic_redispatch_count = 0`, emitted event `ToolOutcomeUnknown`,
/// never a re-dispatch. The operation identity and digests are preserved
/// byte-for-byte.
#[test]
fn dispatched_row_recovers_to_unknown_without_redispatch() {
    let row = dispatched_row();
    let disposition = recover_operation(&row, &facts(false, false, false));
    let result = match &disposition {
        DispatchDisposition::Unknown { result } => result,
        other => panic!("DISPATCHED + lost response must be UNKNOWN, got {other:?}"),
    };
    assert_eq!(
        result.operation_id, row.operation_binding.operation_id,
        "operation_id unchanged"
    );
    assert_eq!(result.status, ToolStatus::Unknown);
    let error = result
        .error
        .as_ref()
        .expect("UNKNOWN result carries the error");
    assert_eq!(error.code, ToolErrorCode::ExternalOutcomeUnknown);
    assert!(!error.retryable);
    assert_eq!(disposition.automatic_redispatch_count(), 0);
    assert_eq!(disposition.emitted_event(), Some("ToolOutcomeUnknown"));
}

/// The `argument_key` case of TST-TOOL-002
/// (`argument_key_does_not_authorize_redispatch`): matching the exact
/// `argument_pointer`/key does not make `idempotent_write` redispatched. The
/// row keeps the server/tool/policy/request/idempotency identity (frozen by
/// request/operation digest and generation) and recovers to `UNKNOWN`.
#[test]
fn argument_key_is_not_a_redispatch_attestation() {
    let binding = binding(
        "0198ab31-6c44-7e8a-b2bb-000000000341",
        SideEffectClass::IdempotentWrite,
        IdempotencyPolicy::ArgumentKey {
            argument_pointer: "/request_id".into(),
        },
        "0198ab31-6c44-7e8a-b2bb-000000000451",
    );
    let row = record(LedgerState::Dispatched, 2, true, None, &binding);
    let disposition = recover_operation(&row, &facts(false, false, false));
    match &disposition {
        DispatchDisposition::Unknown { result } => {
            assert_eq!(result.status, ToolStatus::Unknown);
            assert_eq!(
                result.error.as_ref().unwrap().code,
                ToolErrorCode::ExternalOutcomeUnknown
            );
        }
        other => panic!("argument_key must not authorize redispatch, got {other:?}"),
    }
    assert_eq!(disposition.automatic_redispatch_count(), 0);
}

/// Crash BEFORE the durable dispatch marker (TST-TOOL-006): an `AUTHORIZED`
/// row with authoritative zero-byte proof whose frozen generation is unusable
/// terminates `FAILED` / `TOOL_DISPATCH_NOT_APPLIED`, `not_applied`,
/// `retryable:false`; no replacement generation is ever dispatched. The
/// accepted binding (digests + frozen generation) is preserved.
#[test]
fn authorized_zero_byte_proof_fails_not_applied() {
    let row = authorized_zero_byte_row();
    let disposition = recover_operation(
        &row,
        &facts(true, false, false), // proof, but frozen generation is unusable
    );
    let result = match &disposition {
        DispatchDisposition::ProvedNotApplied { result } => result,
        other => panic!("zero-byte AUTHORIZED must be DISPATCH_NOT_APPLIED, got {other:?}"),
    };
    assert_eq!(
        result.operation_id, row.operation_binding.operation_id,
        "operation_id unchanged"
    );
    assert_eq!(result.status, ToolStatus::Failed);
    let error = result
        .error
        .as_ref()
        .expect("FAILED result carries the error");
    assert_eq!(error.code, ToolErrorCode::DispatchNotApplied);
    assert!(!error.retryable);
    assert_eq!(
        disposition.automatic_replacement_generation_dispatch_count(),
        0
    );
    assert_eq!(disposition.automatic_redispatch_count(), 0);
    assert_eq!(
        disposition.emitted_event(),
        Some("ToolDispatchProvedNotApplied")
    );
}

/// TST-TOOL-009: an AUTHORIZED row with authoritative zero-byte proof, a
/// Ready exact generation, and a live deadline proposes one permit-eligible
/// dispatch through `AUTHORIZED -> DISPATCHED`. The pure decision never
/// issues the permit — a send permit may be released only after the caller's
/// compare-and-set commits (INV-STORAGE-017).
#[test]
fn authorized_zero_byte_proof_with_ready_generation_proposes_dispatch() {
    let row = authorized_zero_byte_row();
    let disposition = recover_operation(&row, &facts(true, true, false));
    match &disposition {
        DispatchDisposition::ProposeDispatch {
            outbound_digest,
            allow_send_permit,
        } => {
            assert!(
                allow_send_permit,
                "proof + Ready generation + live deadline must allow one send permit after CAS"
            );
            assert_eq!(
                *outbound_digest,
                row.recompute_outbound_digest().expect("payload present"),
                "proposed dispatch carries the recomputed outbound digest"
            );
        }
        other => panic!("expected ProposeDispatch, got {other:?}"),
    }
    assert_eq!(disposition.emitted_event(), Some("ToolOperationDispatched"));
}

/// REQ-TOOL-006 ambiguity: an `AUTHORIZED` row whose transport fence cannot
/// prove zero bytes (already eligible) may already have crossed the durable
/// boundary — recovery proposes crossing the boundary without releasing a
/// permit; once the caller CASes DISPATCHED, the decision on the new row is
/// terminal `UNKNOWN`, never `FAILED`/`not_applied` and never a redispatch.
#[test]
fn authorized_without_zero_byte_proof_proposes_dispatch_without_permit_then_unknown() {
    let row = authorized_zero_byte_row();
    let disposition = recover_operation(&row, &facts(false, true, false));
    match &disposition {
        DispatchDisposition::ProposeDispatch {
            allow_send_permit, ..
        } => {
            assert!(
                !allow_send_permit,
                "no zero-byte proof must never release a send permit"
            );
        }
        other => panic!("AUTHORIZED without proof proposes dispatch, got {other:?}"),
    }
    // The caller CASes DISPATCHED (no permit released), reruns the decision on
    // the new row, and that decision is terminal UNKNOWN.
    let binding = row.operation_binding.clone();
    let dispatched = record(LedgerState::Dispatched, 2, true, None, &binding);
    let after = recover_operation(&dispatched, &facts(false, false, false));
    match &after {
        DispatchDisposition::Unknown { result } => {
            assert_eq!(result.status, ToolStatus::Unknown);
            assert_eq!(after.automatic_redispatch_count(), 0);
        }
        other => panic!("POST-CAS DISPATCHED must recover UNKNOWN, got {other:?}"),
    }
}

/// Restart: the row is journaled as `record_jcs` bytes, dropped, and
/// re-opened in a fresh process-shaped boundary. The reopened record must be
/// byte-identical and re-derive the identical terminal disposition (still
/// `UNKNOWN`, still zero redispatches) — the decision is a pure function of
/// the durable journal form, not of process-local runtime state.
#[test]
fn restart_reopens_same_row_and_derives_identical_unknown() {
    let row = dispatched_row();
    let before = match &recover_operation(&row, &facts(false, false, false)) {
        DispatchDisposition::Unknown { result } => serde_json::to_value(result.clone()).unwrap(),
        other => panic!("unexpected disposition {other:?}"),
    };

    // Durable journal bytes (`record_jcs`): the canonical JCS of the closed
    // record; `record_digest` is its SHA-256 (what the Host stores).
    let (jcs, digest) = row.canonical_bytes_and_digest().expect("canonicalizable");

    let journal_path = std::env::temp_dir().join(format!(
        "dolly-dispatch-loss-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::write(&journal_path, jcs.as_ref());
    let reopened = dolly_canonical_json::deserialize_core_json::<ToolCallLedgerRecord>(
        &std::fs::read(&journal_path).unwrap(),
        dolly_canonical_json::ParseLimits::protocol_wire(),
    )
    .expect("record_jcs must reopen");
    let _ = std::fs::remove_file(&journal_path);

    assert_eq!(
        reopened, row,
        "journal round-trip preserves the closed record exactly"
    );
    assert_eq!(
        reopened.operation_binding.operation_id,
        row.operation_binding.operation_id
    );
    assert_eq!(reopened.state, LedgerState::Dispatched);
    reopened.verify_field_combination().expect("consistent");
    let after = match &recover_operation(&reopened, &facts(false, false, false)) {
        DispatchDisposition::Unknown { result } => serde_json::to_value(result.clone()).unwrap(),
        other => panic!("unexpected disposition {other:?}"),
    };
    assert_eq!(
        before, after,
        "restart must re-derive the identical disposition"
    );
    assert_eq!(
        digest,
        Sha256Digest::compute(jcs.as_ref()),
        "record_digest must equal sha256(record_jcs)"
    );
}

/// A durable recorded result is replayed verbatim at reopen (AlreadyTerminal)
/// and never re-dispatched.
#[test]
fn recorded_result_replayed_without_redispatch() {
    let mut binding = binding(
        "0198ab31-6c44-7e8a-b2bb-000000000341",
        SideEffectClass::NonIdempotentWrite,
        IdempotencyPolicy::None,
        "0198ab31-6c44-7e8a-b2bb-000000000451",
    );
    binding.tool_name = "read-file".into();
    let failed_result = serde_json::from_value(json!({
        "operation_id": "0198ab31-6c44-7e8a-b2bb-000000000341",
        "status": "failed",
        "output": null,
        "error": {
            "code": "TOOL_UPSTREAM_NOT_APPLIED",
            "retryable": false,
            "outcome": "not_applied",
            "message": "upstream returned an applicable error",
            "details": {}
        },
        "server_request_id": null
    }))
    .unwrap();
    let row = record(LedgerState::Failed, 3, true, Some(failed_result), &binding);
    let disposition = recover_operation(&row, &facts(false, false, false));
    let result = match &disposition {
        DispatchDisposition::AlreadyTerminal { result } => result,
        other => panic!("recorded result must replay, got {other:?}"),
    };
    assert_eq!(result.operation_id, row.operation_binding.operation_id);
    assert_eq!(disposition.automatic_redispatch_count(), 0);
    assert_eq!(disposition.emitted_event(), None);
}

// ---------------------------------------------------------------------------
// RED: durable JSON reopen/corruption (explicitly versioned closed form).
//
// The durable journal form is the record's serialized bytes. A reopen must be
// fail-closed: a record without the exact version discriminator, with an
// unknown version value, or with any unknown member is NOT a well-formed
// journal and must not be reconstructed into a recoverable document.
// Corruption must be detected at reopen, never silently repaired.
// ---------------------------------------------------------------------------

/// The wire form must carry exactly the fixed version discriminator; wrong,
/// missing, or unknown versions fail closed before the record is usable.
#[test]
fn durable_reopen_rejects_missing_wrong_and_unknown_version() {
    let good = serde_json::to_value(dispatched_row()).unwrap();

    // Missing discriminator: strip the `schema` member from the serialized form.
    let mut missing = good.clone();
    missing.as_object_mut().unwrap().remove("schema");
    assert!(
        serde_json::from_value::<ToolCallLedgerRecord>(missing).is_err(),
        "missing version discriminator must fail closed"
    );

    // Unknown / wrong discriminator value.
    for bad in [
        "dolly.block/v1",
        "dolly.tool-call-ledger/v2",
        "dolly.tool-dispatch-row/v1",
        "bogus",
        "dolly.test-vector/v1",
    ] {
        let mut wrong = good.clone();
        wrong
            .as_object_mut()
            .unwrap()
            .insert("schema".into(), json!(bad));
        assert!(
            serde_json::from_value::<ToolCallLedgerRecord>(wrong).is_err(),
            "wrong version discriminator {bad:?} must fail closed"
        );
    }
}

/// Unknown members in the durable journal fail closed (closed-world input
/// rule): a foreign/forward field must never be silently dropped and the
/// remaining bytes reinterpreted as a record.
#[test]
fn durable_reopen_rejects_unknown_fields() {
    let mut widened = serde_json::to_value(dispatched_row()).unwrap();
    widened
        .as_object_mut()
        .unwrap()
        .insert("ghost_future_field".into(), json!({"nested": true}));
    assert!(
        serde_json::from_value::<ToolCallLedgerRecord>(widened).is_err(),
        "unknown journal member must fail closed"
    );

    // An unknown member inside the embedded binding fails equally.
    let mut binding = serde_json::to_value(dispatched_row()).unwrap();
    binding["operation_binding"]
        .as_object_mut()
        .unwrap()
        .insert("future_binding_member".into(), json!(1));
    assert!(
        serde_json::from_value::<ToolCallLedgerRecord>(binding).is_err(),
        "unknown binding member must fail closed"
    );
}

/// Corrupt journal bytes (truncation, garbage, or a non-object) must fail
/// closed at reopen: they never produce a recoverable record.
#[test]
fn corrupt_journal_bytes_fail_closed_at_reopen() {
    let good = serde_json::to_vec(&dispatched_row()).unwrap();

    let truncated = serde_json::from_slice::<ToolCallLedgerRecord>(&good[..good.len() / 2]);
    assert!(
        truncated.is_err(),
        "truncated journal must fail closed, got {truncated:?}"
    );

    let garbage = serde_json::from_slice::<ToolCallLedgerRecord>(b"{ not json at all ".as_slice());
    assert!(
        garbage.is_err(),
        "non-JSON journal must fail closed, got {garbage:?}"
    );

    let array = serde_json::from_slice::<ToolCallLedgerRecord>(b"[1,2,3]".as_slice());
    assert!(
        array.is_err(),
        "non-object journal must fail closed, got {array:?}"
    );
}

/// A field-consistent record must round-trip through the crate's canonical
/// decoder, and the recomputed record digest must equal the canonical one
/// (INV-STORAGE-002).
#[test]
fn closed_record_roundtrips_and_digests_recompute() {
    for row in [
        dispatched_row(),
        authorized_zero_byte_row(),
        record(
            LedgerState::Succeeded,
            3,
            true,
            Some(
                serde_json::from_value(json!({
                    "operation_id": "0198ab31-6c44-7e8a-b2bb-000000000341",
                    "status": "succeeded",
                    "output": {"value": "accepted"},
                    "error": null,
                    "server_request_id": "0198ab31-6c44-7e8a-b2bb-000000000451"
                }))
                .unwrap(),
            ),
            &binding(
                "0198ab31-6c44-7e8a-b2bb-000000000341",
                SideEffectClass::NonIdempotentWrite,
                IdempotencyPolicy::None,
                "0198ab31-6c44-7e8a-b2bb-000000000451",
            ),
        ),
    ] {
        let (jcs, digest) = row.canonical_bytes_and_digest().expect("canonicalizable");
        let reopened: ToolCallLedgerRecord = dolly_canonical_json::deserialize_core_json(
            jcs.as_ref(),
            dolly_canonical_json::ParseLimits::protocol_wire(),
        )
        .expect("closed record reopens");
        assert_eq!(reopened, row);
        assert_eq!(Sha256Digest::compute(jcs.as_ref()), digest);
        assert_eq!(row.recompute_operation_digest(), row.operation_digest);
    }
}

/// Impossible field/state combinations are rejected by the closed-record
/// validator (the CHECK's authority), not silently reinterpreted —
/// including states that skip the revision (TST-TOOL-013 stale-revision
/// guidance) and terminal results mismatched to their state.
#[test]
fn impossible_field_combinations_fail_closed() {
    let binding = binding(
        "0198ab31-6c44-7e8a-b2bb-000000000341",
        SideEffectClass::NonIdempotentWrite,
        IdempotencyPolicy::None,
        "0198ab31-6c44-7e8a-b2bb-000000000451",
    );

    // DISPATCHED at revision 1 (revision gap) is impossible.
    let mut gap = record(LedgerState::Dispatched, 2, true, None, &binding);
    gap.ledger_revision = 1;
    assert_eq!(
        gap.verify_field_combination(),
        Err(LedgerRecordError(
            "DISPATCHED requires ledger_revision 2, an outbound_digest, and no terminal result"
                .into()
        ))
    );

    // AUTHORIZED with an outbound digest is impossible (zero-byte boundary).
    let mut authorized = record(LedgerState::Authorized, 1, false, None, &binding);
    authorized.outbound_digest = Some(digest_hex(
        "sha256:9999999999999999999999999999999999999999999999999999999999999999",
    ));
    assert!(authorized.verify_field_combination().is_err());

    // An operation_digest that does not bound the embedded binding must fail
    // (INV-STORAGE-002): a tampered row is corruption, not a new disposition.
    let mut tampered = record(LedgerState::Dispatched, 2, true, None, &binding);
    tampered.operation_digest =
        digest_hex("sha256:9999999999999999999999999999999999999999999999999999999999999999");
    assert!(tampered.verify_field_combination().is_err());
}
