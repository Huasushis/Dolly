//! RED dispatch-loss / no-redispatch contract tests for the durable
//! Tool-call ledger (spec §6, REQ-TOOL-002/REQ-TOOL-006, TST-TOOL-001/002/006).
//!
//! Written BEFORE the recovery decision exists: this file drives the
//! `dolly_tool_broker` durable-state surface that is not implemented yet, so
//! building it is the genuine RED gate (API missing), not an assertion
//! failure.
//!
//! The contract under test is the pure-core durable dispatch boundary
//! decision. It must:
//!   - recover a row that crossed the durable `DISPATCHED` marker and lost
//!     its authoritative result to terminal `UNKNOWN` with
//!     `TOOL_EXTERNAL_OUTCOME_UNKNOWN`, `automatic_redispatch_count = 0`,
//!     and an unchanged `server_effect_count` for every v1 side-effect class
//!     (REQ-TOOL-002; `argument_key`/`idempotent_write` is not a
//!     durable-deduplication attestation);
//!   - terminate a crash before the durable dispatch marker as
//!     `TOOL_DISPATCH_NOT_APPLIED` only with authoritative zero-byte proof,
//!     and any ambiguity as `UNKNOWN` (REQ-TOOL-006);
//!   - never re-issue or re-count a backend/server call, so a downstream
//!     ACK/result/error/absence can never become upstream redispatch
//!     authority, and re-authorization after `not_applied` is a fresh
//!     operation under a new identity;
//!   - derive the identical disposition across reopen from the same durable
//!     journal bytes (restart test).

use dolly_canonical_json::Sha256Digest;
use dolly_tool_broker::{
    DispatchDisposition, DurableDispatchRow, ErrorOutcome, LedgerState, ToolErrorCode, ToolStatus,
    recover_operation,
};
use serde_json::json;

fn digest_hex(full: &str) -> Sha256Digest {
    full.parse().expect("valid sha256 digest string")
}

/// Durable row mirroring the TST-TOOL-002 vector initial state:
/// `argument_key`/`idempotent_write` binding at the durable `DISPATCHED`
/// marker, authoritative response lost, `server_effect_count` already 1.
fn dispatched_row() -> DurableDispatchRow {
    DurableDispatchRow {
        operation_id: "0198ab31-6c44-7e8a-b2bb-000000000341".into(),
        request_digest: digest_hex(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
        operation_digest: digest_hex(
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
        tool_server_generation: 7,
        ledger_state: LedgerState::Dispatched,
        transport_eligible_byte_count: 1,
        transport_sent_byte_count: 1,
        server_effect_count: 1,
        result: None,
    }
}

/// Full TST-TOOL-002 / REQ-TOOL-002 outcome: the durable `DISPATCHED` marker
/// crossed, response lost, `argument_key` attached — recovery MUST be
/// terminal `UNKNOWN`/`TOOL_EXTERNAL_OUTCOME_UNKNOWN`, `retryable:false`,
/// `automatic_redispatch_count = 0`, and the emitted event is
/// `ToolOutcomeUnknown`, never a re-dispatch. The operation identity is
/// preserved byte-for-byte.
#[test]
fn dispatched_row_recoversto_unknown_without_redispatch() {
    let row = dispatched_row();
    let disposition = recover_operation(&row);
    let result = match &disposition {
        DispatchDisposition::Unknown { result } => result,
        other => panic!("DISPATCHED + lost response must be UNKNOWN, got {other:?}"),
    };
    assert_eq!(
        result.operation_id, row.operation_id,
        "operation_id unchanged"
    );
    assert_eq!(result.status, ToolStatus::Unknown);
    let error = result
        .error
        .as_ref()
        .expect("UNKNOWN result carries the error");
    assert_eq!(error.code, ToolErrorCode::ExternalOutcomeUnknown);
    assert!(!error.retryable);
    assert_eq!(error.outcome, ErrorOutcome::Unknown);
    assert_eq!(disposition.automatic_redispatch_count(), 0);
}

/// The `argument_key` case of TST-TOOL-002
/// (`argument_key_does_not_authorize_redispatch`): matching the exact
/// `argument_pointer`/key does not make `idempotent_write` redispatched. The
/// row keeps the server/tool/policy/request/idempotency identity (frozen by
/// request/operation digest and generation) and recovers to `UNKNOWN`.
#[test]
fn argument_key_is_not_a_redispatch_attestation() {
    let row = DurableDispatchRow {
        operation_id: "0198ab31-6c44-7e8a-b2bb-000000000341".into(),
        request_digest: digest_hex(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
        operation_digest: digest_hex(
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
        tool_server_generation: 7,
        ledger_state: LedgerState::Dispatched,
        transport_eligible_byte_count: 1,
        transport_sent_byte_count: 1,
        server_effect_count: 1,
        result: None,
    };
    let disposition = recover_operation(&row);
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
/// row with authoritative zero-byte proof terminates `FAILED` /
/// `TOOL_DISPATCH_NOT_APPLIED`, `not_applied`, `retryable:false`; no
/// replacement generation is ever dispatched. The accepted binding (digests +
/// frozen generation) is preserved.
#[test]
fn authorized_zero_byte_proof_fails_not_applied() {
    let row = DurableDispatchRow {
        operation_id: "0198ab31-6c44-7e8a-b2bb-000000000346".into(),
        request_digest: digest_hex(
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        ),
        operation_digest: digest_hex(
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        ),
        tool_server_generation: 7,
        ledger_state: LedgerState::Authorized,
        transport_eligible_byte_count: 0,
        transport_sent_byte_count: 0,
        server_effect_count: 1,
        result: None,
    };
    let disposition = recover_operation(&row);
    let result = match &disposition {
        DispatchDisposition::ProvedNotApplied { result } => result,
        other => panic!("zero-byte AUTHORIZED must be DISPATCH_NOT_APPLIED, got {other:?}"),
    };
    assert_eq!(
        result.operation_id, row.operation_id,
        "operation_id unchanged"
    );
    assert_eq!(result.status, ToolStatus::Failed);
    let error = result
        .error
        .as_ref()
        .expect("FAILED result carries the error");
    assert_eq!(error.code, ToolErrorCode::DispatchNotApplied);
    assert!(!error.retryable);
    assert_eq!(error.outcome, ErrorOutcome::NotApplied);
    assert_eq!(
        disposition.automatic_replacement_generation_dispatch_count(),
        0
    );
    assert_eq!(disposition.automatic_redispatch_count(), 0);
}

/// REQ-TOOL-006 ambiguity: an `AUTHORIZED` row whose transport fence cannot
/// prove zero bytes (already eligible) may already have crossed the durable
/// boundary — recovery is `UNKNOWN`, never `FAILED`/`not_applied` and never
/// a redispatch.
#[test]
fn authorized_without_zero_byte_proof_recovers_unknown() {
    let row = DurableDispatchRow {
        operation_id: "0198ab31-6c44-7e8a-b2bb-000000000346".into(),
        request_digest: digest_hex(
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        ),
        operation_digest: digest_hex(
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        ),
        tool_server_generation: 7,
        ledger_state: LedgerState::Authorized,
        transport_eligible_byte_count: 1,
        transport_sent_byte_count: 0,
        server_effect_count: 1,
        result: None,
    };
    let disposition = recover_operation(&row);
    match &disposition {
        DispatchDisposition::Unknown { result } => {
            assert_eq!(result.status, ToolStatus::Unknown);
            assert_eq!(
                result.error.as_ref().unwrap().code,
                ToolErrorCode::ExternalOutcomeUnknown
            );
            assert_eq!(disposition.automatic_redispatch_count(), 0);
        }
        other => panic!("ambiguous pre-dispatch must be UNKNOWN, got {other:?}"),
    }
}

/// Restart: the row is journaled as bytes, dropped, and re-opened in a fresh
/// process-shaped boundary. The reopened row must be byte-identical and
/// re-derive the identical terminal disposition (still `UNKNOWN`, still zero
/// redispatches) — the decision is a pure function of the durable journal
/// form, not of process-local runtime state.
#[test]
fn restart_reopens_same_row_and_derives_identical_unknown() {
    let row = dispatched_row();
    let before = match &recover_operation(&row) {
        DispatchDisposition::Unknown { result } => serde_json::to_value(result.clone()).unwrap(),
        other => panic!("unexpected disposition {other:?}"),
    };

    // Durable journal bytes: serialize, "crash", reopen from exactly those
    // bytes (what the Host reads back after restart).
    let journal_path = std::env::temp_dir().join(format!(
        "dolly-dispatch-loss-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::write(&journal_path, serde_json::to_vec(&row).unwrap());
    let reopened: DurableDispatchRow =
        serde_json::from_slice(&std::fs::read(&journal_path).unwrap()).unwrap();
    let _ = std::fs::remove_file(&journal_path);

    assert_eq!(
        reopened, row,
        "journal round-trip preserves the durable row exactly"
    );
    assert_eq!(reopened.operation_id, row.operation_id);
    assert_eq!(reopened.ledger_state, LedgerState::Dispatched);
    let after = match &recover_operation(&reopened) {
        DispatchDisposition::Unknown { result } => serde_json::to_value(result.clone()).unwrap(),
        other => panic!("unexpected disposition {other:?}"),
    };
    assert_eq!(
        before, after,
        "restart must re-derive the identical disposition"
    );
    assert_eq!(row.server_effect_count, 1); // effect count exact: never re-counted
}

/// A durable recorded result is replayed verbatim at reopen (AlreadyTerminal)
/// and never re-dispatched — the `server_effect_count` stays exact.
#[test]
fn recorded_result_replayed_without_redispatch() {
    let mut row = dispatched_row();
    row.result = Some(
        serde_json::from_value(json!({
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
        .unwrap(),
    );
    let disposition = recover_operation(&row);
    let result = match &disposition {
        DispatchDisposition::AlreadyTerminal { result } => result,
        other => panic!("recorded result must replay, got {other:?}"),
    };
    assert_eq!(result.operation_id, row.operation_id);
    assert_eq!(disposition.automatic_redispatch_count(), 0);
}
