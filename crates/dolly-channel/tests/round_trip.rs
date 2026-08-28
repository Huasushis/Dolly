//! Exact positive text round-trip evidence and denied-path zero-effect proof.

mod common;

use common::*;
use dolly_channel::{
    ChannelConfigBuilder, ChannelLedger, EventKind, IngressOutcome, OutboundAdmission,
    OutboundState, ScriptedTransport, SendDispatchResult, TransportSendResult,
    dispatch_send, parse_send_action, parse_event, process_event,
};

#[test]
fn text_round_trip_has_exact_positive_evidence() {
    let config = config();
    let mut clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-reply-1".to_string()],
    });

    // 1. Authenticated inbound text reaches Core through the durable premise.
    let ingress = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "in-1", "What is the weather?"),
    );
    let inbound_block = ingress
        .committed_block_id()
        .expect("inbound event committed")
        .to_string();
    assert_eq!(core.committed_count(), 1);
    let session_id = ledger
        .session("account-a", "conv-1")
        .expect("session mapped")
        .clone();

    // 2. Core later emits a committed Block whose targeted action addresses
    //    this module (the model's outbound reply).
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000111";
    let block = send_block(action_id, &session_id, &["It will be sunny."]);
    let action = parse_send_action(&block).expect("block carries the send action");
    let mut admission = OutboundAdmission::new();
    let outbound = dispatch_send(
        &config,
        &clock,
        &mut ledger,
        &mut transport,
        &mut admission,
        &action,
    );

    // 3. Exact positive evidence on both legs.
    match outbound {
        SendDispatchResult::Terminal {
            state: OutboundState::Confirmed,
            result,
        } => {
            let json: serde_json::Value = serde_json::from_str(
                &dolly_canonical_json::canonicalize(&result)
                    .map(|(b, _)| String::from_utf8(b.as_bytes().to_vec()).unwrap())
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(json["status"], "succeeded");
            assert_eq!(json["error"], serde_json::Value::Null);
            assert_eq!(json["result"]["delivery_outcome"], "sent");
            assert_eq!(json["result"]["messages"][0]["ordinal"], 0);
            assert_eq!(json["result"]["messages"][0]["external_message_id"], "transport-reply-1");
            let send_result: dolly_canonical_json::CanonicalJsonValue =
                dolly_canonical_json::CanonicalJsonValue::try_from(json["result"].clone()).unwrap();
            assert!(dolly_channel::validate_send_result(&send_result).is_ok());
        }
        other => panic!("expected confirmed terminal, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 1);
    assert_eq!(core.submit_calls, 1);

    // 4. The sent reply, if echoed by the transport, is suppressed inbound:
    //    the same external ID that was confirmed outbound never re-enters.
    let echo = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "transport-reply-1", "It will be sunny."),
    );
    assert!(matches!(echo, IngressOutcome::EchoIgnored));
    assert_eq!(core.submit_calls, 1, "echo did not re-enter Core");

    // Evidence summary: one durable premise, one confirmed effect, one reply.
    assert_eq!(inbound_block.len() > 0, true);
}

#[test]
fn denied_path_has_zero_callback_effect_and_durable_mutation() {
    let disabled_config = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .ingress_enabled(false)
        .build();
    let mut clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();
    let mut transport = ScriptedTransport::new(true);

    // A transport echo of an unknown id, plus a disabled-ingress event, plus a
    // malformed event: none reach Core, none reach the ledger, none reach the
    // transport.
    let outcome = process_event(
        &disabled_config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "x-1", "hello"),
    );
    assert!(matches!(outcome, IngressOutcome::RejectedBeforeMutation { .. }));
    assert_eq!(core.submit_calls, 0, "zero Core ingress callback");
    assert_eq!(core.status_calls, 0);
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(ledger.inbound.is_empty(), "zero durable inbound mutation");
    assert!(ledger.outbound.is_empty(), "zero durable outbound mutation");
    assert!(ledger.sessions.is_empty(), "zero session mutation");

    // A malformed raw event never even parses.
    let malformed = parse_event(&serde_json::json!({"event_kind": "bogus"}));
    assert!(malformed.is_err());

    // Edit/delete of an unknown original is stale.
    let mut ledger2 = ChannelLedger::new();
    let mut core2 = MemCoreIngress::new();
    let mut event = message_event("account-a", "conv-1", "del-1", "");
    event.event_kind = EventKind::Delete;
    event.references_external_message_id = Some("unknown-original".to_string());
    let stale = process_event(&disabled_config, &clock, &mut ledger2, &mut core2, &event);
    match stale {
        // ingress disabled fires first; use an enabled config to prove the
        // stale gate itself rejects before mutation.
        IngressOutcome::RejectedBeforeMutation { .. } => {}
        other => panic!("unexpected {other:?}"),
    }
    let enabled_config = common::config();
    let stale2 = process_event(&enabled_config, &clock, &mut ledger2, &mut core2, &event);
    match stale2 {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_STALE_EVENT");
        }
        other => panic!("expected stale rejection, got {other:?}"),
    }
    assert_eq!(core2.submit_calls, 0);
    assert!(ledger2.inbound.is_empty());
}
