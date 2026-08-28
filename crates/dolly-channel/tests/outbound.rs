//! Outbound effect-ledger RED/GREEN evidence.

mod common;

use common::*;
use dolly_channel::{
    ChannelConfigBuilder, ChannelLedger, OutboundAdmission, OutboundState, PieceObservation,
    PieceOutcome, ScriptedTransport, SendDispatchResult, TransportSendResult,
    dispatch_send, parse_send_action, recover_outbound, observe_outbound,
};

fn dispatch(config: &dolly_channel::ChannelConfig, ledger: &mut ChannelLedger, transport: &mut ScriptedTransport, block: &serde_json::Value) -> SendDispatchResult {
    let mut clock = clock();
    let action = parse_send_action(block).expect("block carries a channel send");
    let mut admission = OutboundAdmission::new();
    dispatch_send(config, &clock, ledger, transport, &mut admission, &action)
}

#[test]
fn confirmed_send_produces_valid_result_and_records_echo() {
    let config = config();
    let mut ledger = ChannelLedger::new();
    // A session must exist for the session authorization check.
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-msg-001".to_string()],
    });
    let block = send_block(
        "0198ab31-6c44-7e8a-b2bb-000000000091",
        "session-main",
        &["Hello."],
    );

    let outcome = dispatch(&config, &mut ledger, &mut transport, &block);
    match outcome {
        SendDispatchResult::Terminal {
            state,
            result,
        } => {
            assert_eq!(state, OutboundState::Confirmed);
            // The outcome is the common ActionResult envelope whose `result`
            // validates against the frozen semantic validator.
            let json: serde_json::Value = serde_json::from_str(
                &dolly_canonical_json::canonicalize(&result)
                    .map(|(b, _)| String::from_utf8(b.as_bytes().to_vec()).unwrap())
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(json["status"], "succeeded");
            assert_eq!(json["error"], serde_json::Value::Null);
            let send_result: dolly_canonical_json::CanonicalJsonValue =
                dolly_canonical_json::CanonicalJsonValue::try_from(json["result"].clone()).unwrap();
            assert!(dolly_channel::validate_send_result(&send_result).is_ok());
            let entry = ledger.outbound_entry("0198ab31-6c44-7e8a-b2bb-000000000091").unwrap();
            assert!(entry.attempts.iter().any(|a| a.kind == "prepare"));
            assert!(entry.attempts.iter().any(|a| a.kind == "settle"));
        }
        other => panic!("expected Terminal, got {other:?}"),
    }
    // Echo suppression knowledge recorded.
    assert!(ledger.is_echo("account-a", "transport-msg-001"));
    // Exactly one transport call.
    assert_eq!(transport.calls().len(), 1);
    // Provider idempotency key derived from action_id was supplied.
    assert!(transport.calls()[0].idempotency_key.is_some());
}

#[test]
fn confirmed_action_replay_returns_existing_result_and_never_re_dispatches() {
    let config = config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-msg-001".to_string()],
    });
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000092";
    let block = send_block(action_id, "session-main", &["Hello."]);

    let first = dispatch(&config, &mut ledger, &mut transport, &block);
    let (first_state, first_result) = match &first {
        SendDispatchResult::Terminal { state, result } => (state.clone(), result.clone()),
        other => panic!("expected Terminal, got {other:?}"),
    };

    // Re-deliver the same committed action (at-least-once delivery).
    let second = dispatch(&config, &mut ledger, &mut transport, &block);
    match second {
        SendDispatchResult::Terminal { state, result } => {
            assert_eq!(state, first_state);
            assert_eq!(result, first_result, "replay returns the existing result");
        }
        other => panic!("expected Terminal replay, got {other:?}"),
    }
    // No second transport call: retries/duplicates do not duplicate effects.
    assert_eq!(transport.calls().len(), 1);
    assert_eq!(ledger.outbound_entry(action_id).unwrap().attempts.len() >= 2, true);
}

#[test]
fn timeout_after_send_is_unknown_never_failed() {
    let config = config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(false);
    transport.push(TransportSendResult::Timeout);

    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000093";
    let block = send_block(action_id, "session-main", &["Hello."]);
    let outcome = dispatch(&config, &mut ledger, &mut transport, &block);

    match outcome {
        SendDispatchResult::DispatchedPending => {}
        other => panic!("expected DispatchedPending (unknown), got {other:?}"),
    }
    // The row is dispatched and its outcome is genuinely unresolved.
    assert_eq!(
        ledger.outbound_entry(action_id).unwrap().state,
        OutboundState::Dispatched
    );
    assert!(ledger
        .outbound_entry(action_id)
        .unwrap()
        .pieces
        .iter()
        .all(|p| p.outcome == Some(PieceOutcome::Unknown)));

    // Recovery reconciles to unknown (never failed, never re-dispatched).
    let mut clock = clock();
    clock.advance_seconds(config.outbound_limits.unknown_after_seconds as i64 + 1);
    let recovered = recover_outbound(&config, &clock, &mut ledger);
    assert_eq!(recovered, vec![action_id.to_string()]);
    let entry = ledger.outbound_entry(action_id).unwrap();
    assert_eq!(entry.state, OutboundState::Unknown);
    assert_eq!(entry.attempts.iter().filter(|a| a.kind == "dispatch").count(), 1);
    // Transport still has only had one call.
    assert_eq!(transport.calls().len(), 1);
}

#[test]
fn partial_multipart_send_maps_to_failed_applied_channel_partial_delivery() {
    let config = config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::PerPiece {
        pieces: vec![
            dolly_channel::TransportPieceOutcome::Confirmed {
                ordinal: 0,
                message_id: "mid-0".to_string(),
            },
            dolly_channel::TransportPieceOutcome::Rejected {
                ordinal: 1,
                code: "REMOTE_REFUSED".to_string(),
            },
        ],
    });

    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000094";
    let block = send_block(action_id, "session-main", &["part one", "part two"]);
    let outcome = dispatch(&config, &mut ledger, &mut transport, &block);

    match outcome {
        SendDispatchResult::Terminal { state, result } => {
            assert_eq!(state, OutboundState::Partial);
            // Common ActionResult shape: failed, result null, error code
            // CHANNEL_PARTIAL_DELIVERY, outcome applied, delivery_outcome
            // partial, and piece ordinals without payload.
            let _ = &result;
            let json: serde_json::Value = serde_json::from_str(
                &dolly_canonical_json::canonicalize(&result)
                    .map(|(b, _)| String::from_utf8(b.as_bytes().to_vec()).unwrap())
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(json["status"], "failed");
            assert_eq!(json["result"], serde_json::Value::Null);
            assert_eq!(json["error"]["code"], "CHANNEL_PARTIAL_DELIVERY");
            assert_eq!(json["error"]["retryable"], false);
            assert_eq!(json["error"]["outcome"], "applied");
            assert_eq!(json["error"]["details"]["delivery_outcome"], "partial");
            assert_eq!(json["error"]["details"]["confirmed_ordinals"], serde_json::json!([0]));
            assert_eq!(json["error"]["details"]["failed_ordinals"], serde_json::json!([1]));
            assert_eq!(json["error"]["details"]["unknown_ordinals"], serde_json::json!([]));
        }
        other => panic!("expected Terminal partial, got {other:?}"),
    }
    // Never collapsed to success; no wholesale retry on later replay.
    let second = dispatch(&config, &mut ledger, &mut transport, &block);
    assert!(matches!(second, SendDispatchResult::Terminal { state: OutboundState::Partial, .. }));
    assert_eq!(transport.calls().len(), 1, "no re-dispatch of a partial send");
}

#[test]
fn all_pieces_rejected_is_failed_with_not_sent() {
    let config = config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::Rejected {
        code: "TRANSPORT_AUTH_FAILED".to_string(),
    });

    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000095";
    let block = send_block(action_id, "session-main", &["Hello."]);
    let outcome = dispatch(&config, &mut ledger, &mut transport, &block);
    match outcome {
        SendDispatchResult::Terminal { state, result } => {
            assert_eq!(state, OutboundState::Failed);
            let json: serde_json::Value = serde_json::from_str(
                &dolly_canonical_json::canonicalize(&result)
                    .map(|(b, _)| String::from_utf8(b.as_bytes().to_vec()).unwrap())
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(json["status"], "failed");
            assert_eq!(json["error"]["code"], "CHANNEL_TRANSPORT_REJECTED");
            assert_eq!(json["error"]["outcome"], "not_applied");
            assert_eq!(json["error"]["details"]["delivery_outcome"], "not_sent");
        }
        other => panic!("expected Terminal failed, got {other:?}"),
    }
}

#[test]
fn late_unknown_observation_on_dispatched_row_stays_pending_then_recovers() {
    let config = config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::Timeout);

    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000096";
    let block = send_block(action_id, "session-main", &["Hello."]);
    let _ = dispatch(&config, &mut ledger, &mut transport, &block);
    assert_eq!(
        ledger.outbound_entry(action_id).unwrap().state,
        OutboundState::Dispatched
    );

    // A late provider callback with an unknown observation keeps it pending.
    let mut clock = clock();
    let outcome = observe_outbound(
        &config,
        &clock,
        &mut ledger,
        action_id,
        vec![PieceObservation {
            ordinal: 0,
            outcome: PieceOutcome::Unknown,
        }],
    );
    assert!(matches!(outcome, SendDispatchResult::DispatchedPending));

    clock.advance_seconds(config.outbound_limits.unknown_after_seconds as i64 + 1);
    recover_outbound(&config, &clock, &mut ledger);
    assert_eq!(
        ledger.outbound_entry(action_id).unwrap().state,
        OutboundState::Unknown
    );
    assert!(ledger
        .outbound_entry(action_id)
        .unwrap()
        .attempts
        .iter()
        .any(|a| a.kind == "recover"));
}

#[test]
fn late_confirmation_reconciles_dispatched_row_to_confirmed() {
    let config = config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::Timeout);

    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000097";
    let block = send_block(action_id, "session-main", &["Hello."]);
    let _ = dispatch(&config, &mut ledger, &mut transport, &block);
    assert_eq!(
        ledger.outbound_entry(action_id).unwrap().state,
        OutboundState::Dispatched
    );

    let mut clock = clock();
    let outcome = observe_outbound(
        &config,
        &clock,
        &mut ledger,
        action_id,
        vec![PieceObservation {
            ordinal: 0,
            outcome: PieceOutcome::Confirmed {
                transport_message_id: "late-mid".to_string(),
            },
        }],
    );
    match outcome {
        SendDispatchResult::Terminal { state, .. } => {
            assert_eq!(state, OutboundState::Confirmed);
        }
        other => panic!("expected Terminal confirmed, got {other:?}"),
    }
}

#[test]
fn non_channel_owner_action_is_rejected_before_any_effect() {
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);

    let block = non_channel_action_block("0198ab31-6c44-7e8a-b2bb-000000000098");
    let parsed = parse_send_action(&block);
    match parsed {
        Err(error) => {
            assert_eq!(error.code, "CHANNEL_AUTHORIZATION_FAILED");
        }
        Ok(_) => panic!("foreign-owner action must not parse as a channel send"),
    }
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(ledger.outbound.is_empty(), "zero durable outbound mutation");
}

#[test]
fn asset_part_is_rejected_at_the_wp013b_seam_with_zero_effect() {
    let config = config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);

    let mut block = send_block("0198ab31-6c44-7e8a-b2bb-000000000099", "session-main", &["Hello."]);
    block["body"]["actions"][0]["arguments"]["parts"] = serde_json::json!([
        {"kind": "text", "text": "Hello.", "format": "plain"},
        {
            "kind": "asset",
            "asset_id": "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "media_type": "image/png"
        }
    ]);
    let outcome = dispatch(&config, &mut ledger, &mut transport, &block);
    match outcome {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_UNSUPPORTED_MODALITY");
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0);
    assert!(ledger.outbound.is_empty());
}

#[test]
fn stale_result_validator_revision_is_a_contract_mismatch() {
    let config = config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);

    let block = send_block_wrong_validator_revision(
        "0198ab31-6c44-7e8a-b2bb-000000000100",
        "session-main",
    );
    let outcome = dispatch(&config, &mut ledger, &mut transport, &block);
    match outcome {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_RESULT_CONTRACT_MISMATCH");
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0);
    assert!(ledger.outbound.is_empty());
}

#[test]
fn session_not_owned_by_account_is_rejected_before_dispatch() {
    let config = config();
    let mut ledger = ChannelLedger::new();
    // No session ever mapped to this account exists.
    let mut transport = ScriptedTransport::new(true);

    let block = send_block(
        "0198ab31-6c44-7e8a-b2bb-000000000101",
        "session-main",
        &["Hello."],
    );
    let outcome = dispatch(&config, &mut ledger, &mut transport, &block);
    match outcome {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_SESSION_MISSING");
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0);
}

#[test]
fn rate_limit_backpressure_is_deterministic() {
    let config = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .max_pieces_per_second_per_session(1)
        .build();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut clock = clock();
    let mut admission = OutboundAdmission::new();
    let action = parse_send_action(&send_block(
        "0198ab31-6c44-7e8a-b2bb-000000000102",
        "session-main",
        &["Hello."],
    ))
    .unwrap();
    let mut transport = ScriptedTransport::new(true);

    // First send admitted and confirmed.
    let mut t1 = transport.clone();
    t1.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m1".to_string()],
    });
    let first = dispatch_send(
        &config,
        &clock,
        &mut ledger,
        &mut t1,
        &mut admission,
        &action,
    );
    assert!(matches!(first, SendDispatchResult::Terminal { state: OutboundState::Confirmed, .. }));

    // Second send in the same second is rate-limited before any effect.
    let action2 = parse_send_action(&send_block(
        "0198ab31-6c44-7e8a-b2bb-000000000103",
        "session-main",
        &["Again."],
    ))
    .unwrap();
    let mut t2 = ScriptedTransport::new(true);
    let second = dispatch_send(
        &config,
        &clock,
        &mut ledger,
        &mut t2,
        &mut admission,
        &action2,
    );
    match second {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_RATE_LIMITED");
            assert_eq!(error.retryable, true);
            assert_eq!(error.outcome, dolly_channel::ChannelOutcome::NotApplied);
        }
        other => panic!("expected Rejected rate-limited, got {other:?}"),
    }
    assert_eq!(t2.calls().len(), 0);
    assert!(ledger.outbound_entry("0198ab31-6c44-7e8a-b2bb-000000000103").is_none());

    // After the window elapses the same action is admitted.
    clock.advance_seconds(1);
    let mut t3 = ScriptedTransport::new(true);
    t3.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m2".to_string()],
    });
    let third = dispatch_send(
        &config,
        &clock,
        &mut ledger,
        &mut t3,
        &mut admission,
        &action2,
    );
    assert!(matches!(third, SendDispatchResult::Terminal { state: OutboundState::Confirmed, .. }));
}

#[test]
fn ledger_epoch_round_trip_preserves_exact_attempt_history() {
    let config = config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m1".to_string()],
    });
    let block = send_block(
        "0198ab31-6c44-7e8a-b2bb-000000000104",
        "session-main",
        &["Hello."],
    );
    let _ = dispatch(&config, &mut ledger, &mut transport, &block);

    let snap = dolly_channel::ledger_to_json_string(&ledger).unwrap();
    let restored = dolly_channel::ledger_from_json_string(&snap).unwrap();
    let before = ledger.outbound_entry("0198ab31-6c44-7e8a-b2bb-000000000104").unwrap();
    let after = restored.outbound_entry("0198ab31-6c44-7e8a-b2bb-000000000104").unwrap();
    assert_eq!(before.state, after.state);
    assert_eq!(before.attempts, after.attempts, "exact attempt history preserved");
    assert_eq!(before.result_jcs, after.result_jcs);
}
