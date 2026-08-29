//! Authenticated text ingress RED/GREEN evidence.

mod common;

use common::*;
use dolly_channel::{
    ChannelConfigBuilder, ChannelLedger, EventKind, IngressOutcome, InboundState,
    ledger_from_json_string, ledger_to_json_string, parse_event, process_event,
    reconcile_inbound,
};
use serde_json::json;

#[test]
fn authenticated_message_commits_to_durable_premise() {
    let config = config();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    let outcome = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "msg-1", "Hello, Dolly."),
    );

    let block_id = match outcome {
        IngressOutcome::Committed {
            block_id,
            idempotent,
            ..
        } => {
            assert!(!idempotent);
            block_id
        }
        other => panic!("expected Committed, got {other:?}"),
    };
    assert_eq!(core.submit_calls, 1);
    // The durable premise: Core holds exactly one committed entry.
    assert_eq!(core.committed_count(), 1);
    // The module ledger agrees and is account-scoped.
    let entry = ledger
        .inbound_entry("account-a", "msg-1")
        .expect("ledger row exists");
    assert_eq!(entry.state, InboundState::Accepted);
    assert_eq!(entry.block_id.as_deref(), Some(block_id.as_str()));
    assert_eq!(entry.transport_account, "account-a");
    // The namespaced metadata record is present in the byte-identical draft.
    assert!(
        entry.request_jcs.contains("\"org.dolly.channel\""),
        "draft carries the channel metadata namespace"
    );
    assert!(
        entry.request_jcs.contains("external_message_id"),
        "draft carries the external message identity"
    );
    assert!(
        !entry.request_jcs.contains("secret") && !entry.request_jcs.contains("cookie"),
        "no credentials leak into the draft"
    );
    assert_eq!(ledger.session("account-a", "conv-1").is_some(), true);
}

#[test]
fn duplicate_delivery_replays_prior_mapping_without_core_call() {
    let config = config();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    let first = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "dup-1", "same text"),
    );
    let first_block = first.committed_block_id().unwrap().to_string();
    let submits_after_first = core.submit_calls;

    // The same external message arrives again (e.g. poll + webhook overlap).
    let second = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "dup-1", "same text"),
    );

    match second {
        IngressOutcome::IdempotentReplay { block_id } => {
            assert_eq!(block_id, first_block);
        }
        other => panic!("expected IdempotentReplay, got {other:?}"),
    }
    assert_eq!(core.submit_calls, submits_after_first, "no new Core call on replay");
    assert_eq!(core.committed_count(), 1);
    // Attempt history preserved exactly: a submit attempt plus the accepted
    // settlement; the pure replay added no third entry.
    let kinds: Vec<&str> = ledger
        .inbound_entry("account-a", "dup-1")
        .unwrap()
        .attempts
        .iter()
        .map(|a| a.kind.as_str())
        .collect();
    assert_eq!(kinds, vec!["submit", "accepted"]);
}

#[test]
fn same_id_different_content_is_an_idempotency_conflict_before_mutation() {
    let config = config();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    let _ = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "m1", "original"),
    );
    let submits = core.submit_calls;

    let second = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "m1", "different content same id"),
    );
    match second {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_OPERATION_CONFLICT");
        }
        other => panic!("expected RejectedBeforeMutation, got {other:?}"),
    }
    assert_eq!(core.submit_calls, submits, "no second Core call");
}

#[test]
fn cross_owner_account_fails_before_mutation() {
    let config = config();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    let outcome = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-other", "conv-1", "m1", "hello"),
    );
    match outcome {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_AUTHENTICATION_FAILED");
        }
        other => panic!("expected RejectedBeforeMutation, got {other:?}"),
    }
    assert_eq!(core.submit_calls, 0);
    assert_eq!(core.status_calls, 0);
    assert!(ledger.inbound.is_empty(), "no durable inbound mutation");
    assert!(ledger.sessions.is_empty(), "no session created");
}

#[test]
fn unauthorized_sender_fails_before_mutation() {
    let config = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .allowed_senders(&["sender-account-a"])
        .build();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    let mut event = message_event("account-a", "conv-1", "m1", "hello");
    event.sender_id = "mallory".to_string();
    let outcome = process_event(&config, &clock, &mut ledger, &mut core, &event);
    match outcome {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_AUTHORIZATION_FAILED");
        }
        other => panic!("expected RejectedBeforeMutation, got {other:?}"),
    }
    assert_eq!(core.submit_calls, 0);
    assert!(ledger.inbound.is_empty());
}

#[test]
fn malformed_event_fails_before_mutation() {
    let config = config();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    // An edit without its reference is malformed at parse time.
    let raw = json!({
        "channel_id": "web-primary",
        "transport": "web",
        "account": "account-a",
        "external_conversation_id": "conv-1",
        "external_message_id": "m1",
        "sender_class": "user",
        "sender_id": "sender-account-a",
        "event_kind": "edit",
        "text": "edited",
        "received_at": NOW,
    });
    assert!(parse_event(&raw).is_err());

    // Over-size text is malformed after normalization.
    let mut event = message_event("account-a", "conv-1", "m2", "x");
    event.text = "a".repeat(1024 * 1024);
    let outcome = process_event(&config, &clock, &mut ledger, &mut core, &event);
    match outcome {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_MALFORMED_EVENT");
        }
        other => panic!("expected RejectedBeforeMutation, got {other:?}"),
    }
    assert_eq!(core.submit_calls, 0);
    assert!(ledger.inbound.is_empty());
}

#[test]
fn stale_edit_of_unknown_message_fails_before_mutation() {
    let config = config();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    let mut event = message_event("account-a", "conv-1", "edit-1", "edited");
    event.event_kind = EventKind::Edit;
    event.references_external_message_id = Some("never-seen".to_string());
    let outcome = process_event(&config, &clock, &mut ledger, &mut core, &event);
    match outcome {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_STALE_EVENT");
        }
        other => panic!("expected RejectedBeforeMutation, got {other:?}"),
    }
    assert_eq!(core.submit_calls, 0);
    assert!(ledger.inbound.is_empty());
}

#[test]
fn account_change_starts_fresh_dedup_namespace_without_collision() {
    let mut config = config();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    let _ = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "shared-id", "from a"),
    );

    // Hot reload to another account: same external ID is a separate
    // deduplication namespace and commits independently.
    config = ChannelConfigBuilder::new("web", "account-b", "web-channel", 2).build();
    let outcome = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-b", "conv-2", "shared-id", "from b"),
    );
    assert!(outcome.committed_block_id().is_some());
    assert_eq!(core.committed_count(), 2);
    let a = ledger.inbound_entry("account-a", "shared-id").unwrap();
    let b = ledger.inbound_entry("account-b", "shared-id").unwrap();
    assert_ne!(a.ingress_key, b.ingress_key);
    assert_ne!(a.block_id, b.block_id);
}

#[test]
fn stop_restart_preserves_ledger_and_pending_rows() {
    let config = config();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    let _ = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "ok-1", "hello"),
    );
    // A row stuck in the crash state (response lost).
    core.fail_submits = 1;
    let _ = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "lost-1", "hello 2"),
    );
    let snap = ledger_to_json_string(&ledger).unwrap();

    // Restart: restore and reconcile; pending row survives verbatim.
    let mut restored = ledger_from_json_string(&snap).unwrap();
    assert_eq!(restored.inbound.len(), 2);
    assert!(restored.inbound_entry("account-a", "ok-1").is_some());
    assert!(restored.inbound_entry("account-a", "lost-1").is_some());
    let mut core2 = MemCoreIngress::new();
    let remaining = reconcile_inbound(&config, &clock, &mut restored, &mut core2);
    assert_eq!(remaining, 0);
    assert!(restored
        .inbound
        .values()
        .all(|e| e.state == InboundState::Accepted));
}

#[test]
fn lost_response_reconciles_through_status_then_committed_without_replay() {
    let config = config();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    core.commit_then_drop_submits = 1; // Core committed but the response was lost
    let outcome = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "lost-1", "hello"),
    );
    assert!(matches!(outcome, IngressOutcome::SubmissionPending));
    // The durable Core side actually committed; the module row is `submitted`.
    assert_eq!(core.committed_count(), 1);
    assert_eq!(
        ledger.inbound_entry("account-a", "lost-1").unwrap().state,
        InboundState::Submitted
    );

    // Reconcile: status says committed -> settled to accepted, no re-submit.
    let remaining = reconcile_inbound(&config, &clock, &mut ledger, &mut core);
    assert_eq!(remaining, 0);
    assert_eq!(
        ledger.inbound_entry("account-a", "lost-1").unwrap().state,
        InboundState::Accepted
    );
    // Status before resubmit, and no replay submit happened.
    assert_eq!(core.status_calls, 1);
    assert_eq!(core.submit_calls, 1);
    let entry = ledger.inbound_entry("account-a", "lost-1").unwrap();
    assert!(entry.attempts.iter().any(|a| a.kind == "reconcile"));
}

#[test]
fn lost_response_with_authoritative_absent_replays_byte_identical() {
    let config = config();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    core.fail_submits = 1; // response lost and Core genuinely dropped it
    let _ = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "absent-1", "hello"),
    );
    assert_eq!(core.committed_count(), 0, "Core dropped the request outright");

    let remaining = reconcile_inbound(&config, &clock, &mut ledger, &mut core);
    assert_eq!(remaining, 0);
    assert_eq!(
        ledger.inbound_entry("account-a", "absent-1").unwrap().state,
        InboundState::Accepted
    );
    // status (absent) then a byte-identical replay submit.
    assert_eq!(core.status_calls, 1);
    assert_eq!(core.submit_calls, 2);
    assert_eq!(core.committed_count(), 1);
    let entry = ledger.inbound_entry("account-a", "absent-1").unwrap();
    assert_eq!(
        entry.block_id.as_deref(),
        core.last_block().as_deref(),
        "module ledger agrees with the durable Core premise"
    );
    assert!(entry.attempts.iter().any(|a| a.kind == "replay"));
}

#[test]
fn echoed_outbound_id_is_suppressed_with_zero_effect() {
    let config = config();
    let clock = clock();
    let mut ledger = ChannelLedger::new();
    let mut core = MemCoreIngress::new();

    // Simulate a confirmed outbound piece that the transport echoes back.
    ledger.record_echoed("account-a", "transport-msg-001");
    let outcome = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &message_event("account-a", "conv-1", "transport-msg-001", "echo"),
    );
    assert!(matches!(outcome, IngressOutcome::EchoIgnored));
    assert_eq!(core.submit_calls, 0);
    assert_eq!(core.status_calls, 0);
    assert!(ledger.inbound.is_empty());
}
