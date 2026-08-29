//! G4-C focused end-to-end, crash/replay, and tamper tests.
//!
//! These tests drive the shipping-runtime Channel inbound wiring
//! ([`InboundReceiver`]) over the REAL durable Host ingress slice and the
//! REAL Core reducer transaction (via `dolly-storage`), with the Channel
//! ledger backed by a real module-scoped SQLite file so stop/restart
//! behavior is exercised, not simulated:
//!
//! - durable record before acknowledged outcome, then sealed B premise,
//!   reaching Core exactly once;
//! - ordered target Pages bound into the operation digest (same key +
//!   different targets conflicts before Core);
//! - same key + different content conflicts before Core;
//! - replay of the same key + digest returns the existing mapping with zero
//!   duplicate Core mutation;
//! - lost response / lost Channel state reconciles status-first (never a
//!   blind resend, never a false success);
//! - authorization and direction fences (wrong account, revoked grant,
//!   opposite-direction target, echo) fail closed with no premise or effect
//!   leakage;
//! - tampered durable Channel ledger fails closed.

mod common;

use std::path::Path;
use std::str::FromStr;

use common::g4::*;
use dolly_channel::{
    ChannelLedger, ChannelLedgerStore, CoreIngress, EventKind, HostIngressCoreAdapter,
    InboundEvent, InboundReceiver, InboundState, IngressOutcome, IngressSubmitRequest,
    SqliteChannelLedgerStore, create_channel_ledger_schema,
};
use dolly_core_domain::Timestamp;
use dolly_storage::SqliteHostIngressStore;
use rusqlite::Connection;
use tempfile::tempdir;

/// Open a fresh module-scoped Channel ledger database file and create its
/// schema.
fn channel_store_connection(dir: &Path) -> (Connection, std::path::PathBuf) {
    let path = dir.join("channel-ledger.sqlite3");
    let mut connection = Connection::open(&path).unwrap();
    create_channel_ledger_schema(&mut connection).unwrap();
    (connection, path)
}

fn edit_event(message_id: &str, references: &str, text: &str) -> InboundEvent {
    InboundEvent {
        channel_id: "web-primary".to_string(),
        transport: "web".to_string(),
        account: "account-a".to_string(),
        external_conversation_id: "conv-1".to_string(),
        external_message_id: message_id.to_string(),
        sender_class: "user".to_string(),
        sender_id: "sender-account-a".to_string(),
        text: text.to_string(),
        received_at: Timestamp::from_str(CHANNEL_NOW).expect("timestamp"),
        event_kind: EventKind::Edit,
        references_external_message_id: Some(references.to_string()),
    }
}

// ---------------------------------------------------------------------------
// End-to-end exactly-once durability
// ---------------------------------------------------------------------------

#[test]
fn authenticated_event_is_durably_recorded_and_reaches_core_exactly_once() {
    let mut harness = RuntimeHarness::new("recv-e2e");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());
    let config = channel_config();

    // Phase A: ingest through the durable receiver.
    let block_id;
    let replayed_block_id;
    {
        let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            config.clone(),
            Box::new(channel_clock()),
            store,
            host,
            &harness.authority,
            &harness.grant,
        )
        .unwrap();

        let event = channel_event("account-a", "conv-1", "msg-1", "Hello, Dolly.");
        let outcome = receiver.ingest_event(&event);
        block_id = match outcome {
            IngressOutcome::Committed {
                block_id,
                idempotent,
                ..
            } => {
                assert!(!idempotent, "a first commit is never an idempotent replay");
                block_id
            }
            other => panic!("expected Committed, got {other:?}"),
        };
        let entry = receiver
            .ledger()
            .inbound_entry("account-a", "msg-1")
            .expect("in-memory ledger row");
        assert_eq!(entry.state, InboundState::Accepted);
        assert_eq!(entry.block_id.as_deref(), Some(block_id.as_str()));
        assert_eq!(entry.event_kind, EventKind::Message);

        // Replaying the exact same event returns the existing mapping with no
        // new Core call.
        let replay = receiver.ingest_event(&event);
        replayed_block_id = match replay {
            IngressOutcome::IdempotentReplay { block_id } => block_id,
            other => panic!("expected IdempotentReplay, got {other:?}"),
        };
        assert_eq!(replayed_block_id, block_id);
    }

    // Phase B: Core + durable Channel state settled exactly once.
    assert_eq!(harness.mapping_count(), 1, "one durable Host mapping");
    assert_eq!(harness.operation_count(), 1, "one Core operation");
    let snapshot = harness.core_store().snapshot().unwrap();
    assert_eq!(snapshot.ingress.len(), 1, "one Core ingress record");
    assert_eq!(snapshot.blocks.len(), 1, "one Core Block");
    let stored_block = snapshot.blocks.get(&block_id).expect("block present");
    assert_eq!(
        stored_block["metadata"]["org.dolly.channel"]["external_message_id"],
        "msg-1"
    );
    let record = snapshot.ingress.values().next().expect("ingress record");
    assert_eq!(record.block_id, block_id);
    assert_eq!(record.pages, vec!["page-a".to_string()]);
    assert_eq!(
        snapshot
            .deliveries
            .iter()
            .filter(|d| d["block_id"] == serde_json::json!(block_id))
            .map(|d| d["page_id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>(),
        vec!["page-a".to_string()],
        "delivered to the ordered target Page"
    );

    // The Channel ledger is durable on the module-scoped file.
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let mut store2 = SqliteChannelLedgerStore::new(&mut channel_connection2).unwrap();
    let durable = store2.load().unwrap();
    let durable_entry = durable
        .inbound_entry("account-a", "msg-1")
        .expect("durable row");
    assert_eq!(durable_entry.state, InboundState::Accepted);
    assert_eq!(durable_entry.block_id.as_deref(), Some(block_id.as_str()));
    assert_eq!(durable_entry.pages, vec!["page-a".to_string()]);
    assert_eq!(durable_entry.config_revision, 1);
}

#[test]
fn same_key_different_content_conflicts_before_core() {
    let mut harness = RuntimeHarness::new("recv-conflict");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        channel_config(),
        Box::new(channel_clock()),
        store,
        host,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();

    let original = channel_event("account-a", "conv-1", "msg-2", "original");
    assert!(matches!(
        receiver.ingest_event(&original),
        IngressOutcome::Committed { .. }
    ));

    // Same external message identity, different content: conflict BEFORE any
    // Core mutation.
    let changed = channel_event("account-a", "conv-1", "msg-2", "changed content");
    let outcome = receiver.ingest_event(&changed);
    match outcome {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_OPERATION_CONFLICT");
        }
        other => panic!("expected RejectedBeforeMutation, got {other:?}"),
    }
    assert_eq!(
        receiver
            .ledger()
            .inbound_entry("account-a", "msg-2")
            .unwrap()
            .state,
        InboundState::Accepted,
        "the conflict must not change the prior settled row"
    );
    drop(receiver);
    assert_eq!(harness.mapping_count(), 1, "no new premise");
    assert_eq!(harness.operation_count(), 1, "no new Core effect");
}

#[test]
fn same_key_different_target_pages_conflict_before_core() {
    let mut harness = RuntimeHarness::new("recv-pages");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    // Build the exact Channel-style draft metadata the adapter reads.
    fn draft(message_id: &str) -> dolly_canonical_json::CanonicalJsonValue {
        let draft = serde_json::json!({
            "schema": "dolly.block-draft/v1",
            "parts": [{"kind": "text", "text": "targets", "format": "plain"}],
            "actions": [],
            "metadata": {
                "org.dolly.channel": {
                    "channel_id": "web-primary",
                    "transport": "web",
                    "session_id": "session-main",
                    "external_conversation_id": "conv-1",
                    "external_message_id": message_id,
                    "sender_class": "user",
                    "sender_id": "sender-account-a",
                    "received_at": CHANNEL_NOW,
                    "event_kind": "message"
                }
            }
        });
        dolly_canonical_json::CanonicalJsonValue::try_from(draft).unwrap()
    }

    let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
    let mut host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut adapter = HostIngressCoreAdapter::new(&mut host, &harness.authority, &harness.grant);

    let request = |pages: &[&str]| IngressSubmitRequest {
        operation_id: "0198ab31-6c44-7e8a-b2bb-000000000099".to_string(),
        module_id: MODULE_ID.to_string(),
        idempotency_key: "channel-key-pages".to_string(),
        draft: draft("msg-3"),
        target_page_ids: pages.iter().map(|p| p.to_string()).collect(),
        deadline: CHANNEL_NOW.to_string(),
    };

    // Same external event identity + same content, ordered pages differ.
    let first = adapter
        .submit(&request(&["page-a", "page-b"]))
        .expect("first submit commits");
    assert!(matches!(
        first,
        dolly_channel::IngressSubmitReceipt::Committed {
            idempotent: false,
            ..
        }
    ));

    let conflict = adapter.submit(&request(&["page-b", "page-a"]));
    match conflict {
        Err(dolly_channel::CoreIngressError::Rejected { code }) => {
            assert_eq!(code, "STORAGE_IDEMPOTENCY_CONFLICT");
        }
        other => panic!("expected an idempotency conflict, got {other:?}"),
    }
    drop(adapter);
    drop(host);
    drop(store);
    assert_eq!(
        harness.mapping_count(),
        1,
        "reordered targets changed nothing"
    );
    assert_eq!(harness.operation_count(), 1, "no second Core effect");
}

// ---------------------------------------------------------------------------
// Crash / replay / reconciliation
// ---------------------------------------------------------------------------

#[test]
fn lost_response_is_reconciled_status_first_without_resend() {
    let mut harness = RuntimeHarness::new("recv-reconcile");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());
    let config = channel_config();

    // Phase A: the submit COMMITS durably inside the Host slice, but the
    // response is lost. Durable Channel row is `submitted`.
    {
        let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut faulty = FaultyHostIngress::new(inner);
        faulty.commit_then_drop_submits = 1;
        let mut receiver = InboundReceiver::new(
            config.clone(),
            Box::new(channel_clock()),
            store,
            faulty,
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let outcome = receiver.ingest_event(&channel_event("account-a", "conv-1", "msg-4", "lost"));
        assert!(matches!(outcome, IngressOutcome::SubmissionPending));
        let entry = receiver
            .ledger()
            .inbound_entry("account-a", "msg-4")
            .expect("row");
        assert_eq!(entry.state, InboundState::Submitted);
    }

    // Restart: the durable Channel ledger (file) still holds the submitted
    // row, and the Host slice holds the committed mapping.
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let store2 = SqliteChannelLedgerStore::new(&mut channel_connection2).unwrap();
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        config.clone(),
        Box::new(channel_clock()),
        store2,
        host2,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();
    let remaining = receiver2.reconcile().unwrap();
    assert_eq!(remaining, 0, "leftover submitted rows");
    let entry = receiver2
        .ledger()
        .inbound_entry("account-a", "msg-4")
        .expect("row");
    assert_eq!(entry.state, InboundState::Accepted, "settled by status");
    assert!(entry.block_id.is_some());
    let block_id = entry.block_id.clone().unwrap();
    drop(receiver2);
    drop(channel_connection2);

    assert_eq!(harness.mapping_count(), 1, "no duplicate mapping");
    // Exactly ONE Core operation: reconcile settled through `status` and did
    // NOT resubmit the request.
    assert_eq!(harness.operation_count(), 1, "no blind resend");
    let snapshot = harness.core_store().snapshot().unwrap();
    assert_eq!(snapshot.ingress.len(), 1);
    assert!(snapshot.blocks.contains_key(&block_id));
}

#[test]
fn lost_submit_with_authoritative_absent_replays_byte_identical() {
    let mut harness = RuntimeHarness::new("recv-absent");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());
    let config = channel_config();

    // Phase A: the submit never reaches the Host slice (response dropped
    // before the store); the durable Channel row is `submitted`.
    {
        let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut faulty = FaultyHostIngress::new(inner);
        faulty.fail_submits = 1;
        let mut receiver = InboundReceiver::new(
            config.clone(),
            Box::new(channel_clock()),
            store,
            faulty,
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let outcome =
            receiver.ingest_event(&channel_event("account-a", "conv-1", "msg-5", "absent"));
        assert!(matches!(outcome, IngressOutcome::SubmissionPending));
    }
    assert_eq!(harness.mapping_count(), 0, "nothing committed yet");

    // Restart + reconcile: status answers authoritative `absent`, so the
    // byte-identical request is replayed exactly once and commits.
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let store2 = SqliteChannelLedgerStore::new(&mut channel_connection2).unwrap();
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        config.clone(),
        Box::new(channel_clock()),
        store2,
        host2,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();
    let remaining = receiver2.reconcile().unwrap();
    assert_eq!(remaining, 0);
    let entry = receiver2
        .ledger()
        .inbound_entry("account-a", "msg-5")
        .expect("row");
    assert_eq!(entry.state, InboundState::Accepted);
    drop(receiver2);

    assert_eq!(
        harness.mapping_count(),
        1,
        "exactly one premise after replay"
    );
    assert_eq!(harness.operation_count(), 1, "exactly one Core effect");
}

#[test]
fn restart_when_channel_ledger_lost_but_core_committed_never_duplicates() {
    let mut harness = RuntimeHarness::new("recv-lost-ledger");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let config = channel_config();

    // Phase A: a receiver whose Channel ledger persistence is lost (crash
    // after Core committed, before the Channel document was durably saved).
    let first_block;
    {
        let store = NullChannelLedgerStore::new();
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            config.clone(),
            Box::new(channel_clock()),
            store,
            host,
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let outcome = receiver.ingest_event(&channel_event("account-a", "conv-1", "msg-6", "once"));
        first_block = match outcome {
            IngressOutcome::Committed { block_id, .. } => block_id,
            other => panic!("expected Committed, got {other:?}"),
        };
    }

    // Restart with an EMPTY durable Channel ledger, same Host slice: the
    // same external event re-ingests and the sealed B premise returns the
    // existing mapping idempotently — the same Core Block, zero duplication.
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let store2 = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        config.clone(),
        Box::new(channel_clock()),
        store2,
        host2,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();
    let outcome2 = receiver2.ingest_event(&channel_event("account-a", "conv-1", "msg-6", "once"));
    let replayed = match outcome2 {
        IngressOutcome::Committed {
            block_id,
            idempotent,
            ..
        } => {
            assert!(
                idempotent,
                "the Host slice must report the idempotent replay"
            );
            block_id
        }
        other => panic!("expected Committed idempotent replay, got {other:?}"),
    };
    assert_eq!(replayed, first_block, "the same Block is authoritative");
    drop(receiver2);

    assert_eq!(harness.mapping_count(), 1, "no duplicate premise");
    assert_eq!(harness.operation_count(), 1, "no duplicate Core effect");
    let snapshot = harness.core_store().snapshot().unwrap();
    assert_eq!(snapshot.blocks.len(), 1);
    assert!(snapshot.blocks.contains_key(&first_block));
}

#[test]
fn status_that_stays_lost_never_false_succeeds() {
    let mut harness = RuntimeHarness::new("recv-status-lost");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());

    {
        let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut faulty = FaultyHostIngress::new(inner);
        faulty.fail_submits = 1;
        let mut receiver = InboundReceiver::new(
            channel_config(),
            Box::new(channel_clock()),
            store,
            faulty,
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let _ = receiver.ingest_event(&channel_event("account-a", "conv-1", "msg-7", "stuck"));
    }

    // Reconcile while status is ALSO lost: the row must stay `submitted`, be
    // reported unresolved, and neither resubmitted nor falsely settled.
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let store2 = SqliteChannelLedgerStore::new(&mut channel_connection2).unwrap();
    let inner2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut faulty2 = FaultyHostIngress::new(inner2);
    faulty2.fail_statuses = 1;
    let mut receiver2 = InboundReceiver::new(
        channel_config(),
        Box::new(channel_clock()),
        store2,
        faulty2,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();
    let remaining = receiver2.reconcile().unwrap();
    assert_eq!(remaining, 1, "the unresolved row is reported");
    assert_eq!(
        receiver2
            .ledger()
            .inbound_entry("account-a", "msg-7")
            .unwrap()
            .state,
        InboundState::Submitted,
        "no false success while the durable outcome is unknown"
    );
    drop(receiver2);
    // A blind resend while status is unknown would have reached the Host
    // slice and committed; nothing committed proves no resend happened.
    assert_eq!(
        harness.mapping_count(),
        0,
        "no premise on an unknown outcome"
    );
    assert_eq!(
        harness.operation_count(),
        0,
        "no blind resend on an unknown outcome"
    );
}

// ---------------------------------------------------------------------------
// Fail-closed authorization, direction, and echo
// ---------------------------------------------------------------------------

#[test]
fn wrong_account_fails_closed_with_no_premise_or_effect() {
    let mut harness = RuntimeHarness::new("recv-account");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let mut config = channel_config();
    config.transport_account = "account-a".to_string();

    let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        config.clone(),
        Box::new(channel_clock()),
        store,
        host,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();
    // The account does not match the configured transport account.
    let outcome = receiver.ingest_event(&channel_event("account-evil", "conv-1", "msg-8", "spoof"));
    match outcome {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_AUTHENTICATION_FAILED");
        }
        other => panic!("expected RejectedBeforeMutation, got {other:?}"),
    }
    assert!(
        receiver
            .ledger()
            .inbound_entry("account-evil", "msg-8")
            .is_none(),
        "no durable row for a rejected event"
    );
    drop(receiver);
    assert_eq!(harness.mapping_count(), 0, "no premise");
    assert_eq!(harness.operation_count(), 0, "no Core effect");
}

#[test]
fn revoked_grant_fails_closed_before_core() {
    let mut harness = RuntimeHarness::new("recv-revoked");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    let authority = harness.authority.clone();
    harness.revoke_grant(&authority, MODULE_ID);

    let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        channel_config(),
        Box::new(channel_clock()),
        store,
        host,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();
    let outcome = receiver.ingest_event(&channel_event("account-a", "conv-1", "msg-9", "denied"));
    match outcome {
        IngressOutcome::CoreRejected { error } => {
            assert_eq!(error.code, "CHANNEL_OPERATION_CONFLICT");
        }
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_OPERATION_CONFLICT");
        }
        other => panic!("expected a rejection, got {other:?}"),
    }
    assert_eq!(
        receiver
            .ledger()
            .inbound_entry("account-a", "msg-9")
            .unwrap()
            .state,
        InboundState::Rejected,
        "the rejection is durable"
    );
    drop(receiver);
    assert_eq!(harness.mapping_count(), 0, "no premise leaked");
    assert_eq!(harness.operation_count(), 0, "no Core effect leaked");
}

#[test]
fn echo_of_confirmed_outbound_is_suppressed_without_core() {
    let mut harness = RuntimeHarness::new("recv-echo");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    // Seed the durable Channel ledger with a confirmed outbound echo.
    {
        let mut seed = ChannelLedger::new();
        seed.record_echoed("account-a", "transport-echo-1");
        let mut store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
        store.save(&seed).unwrap();
    }

    let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        channel_config(),
        Box::new(channel_clock()),
        store,
        host,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();

    // The transport echoes a confirmed outbound piece back as an inbound
    // event; it must be ignored: no row, no premise, no Core effect.
    let outcome = receiver.ingest_event(&channel_event(
        "account-a",
        "conv-1",
        "transport-echo-1",
        "echo",
    ));
    assert!(matches!(outcome, IngressOutcome::EchoIgnored));
    assert!(
        receiver
            .ledger()
            .inbound_entry("account-a", "transport-echo-1")
            .is_none(),
        "an echo never becomes a ledger row"
    );
    drop(receiver);
    assert_eq!(harness.mapping_count(), 0, "no premise for an echo");
    assert_eq!(harness.operation_count(), 0, "no Core effect for an echo");
}

#[test]
fn opposite_direction_target_fails_closed_with_no_premise_or_effect() {
    // A graph in which `page-a` is an INPUT (consumer-direction) page of the
    // receiver, so targeting it is an opposite-direction violation.
    let mut harness = RuntimeHarness::new_with_outputs("recv-opposite", &["page-b"], &["page-a"]);
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    let config = dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1)
        .target_pages(&["page-a"])
        .build();

    {
        let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            config,
            Box::new(channel_clock()),
            store,
            host,
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let outcome =
            receiver.ingest_event(&channel_event("account-a", "conv-1", "msg-10", "wrong way"));
        assert!(matches!(
            outcome,
            IngressOutcome::CoreRejected { .. } | IngressOutcome::RejectedBeforeMutation { .. }
        ));
        assert_eq!(
            receiver
                .ledger()
                .inbound_entry("account-a", "msg-10")
                .unwrap()
                .state,
            InboundState::Rejected,
            "the direction rejection is durable"
        );
    }
    assert_eq!(
        harness.mapping_count(),
        0,
        "no premise for an opposite target"
    );
    assert_eq!(
        harness.operation_count(),
        0,
        "no Core effect for an opposite target"
    );
}

#[test]
fn edit_delete_relation_is_wired_and_stale_reference_fails_closed() {
    let mut harness = RuntimeHarness::new("recv-relation");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    {
        let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(),
            Box::new(channel_clock()),
            store,
            host,
            &harness.authority,
            &harness.grant,
        )
        .unwrap();

        // Original message commits.
        let original = channel_event("account-a", "conv-1", "msg-original", "original");
        assert!(matches!(
            receiver.ingest_event(&original),
            IngressOutcome::Committed { .. }
        ));

        // Edit referencing a committed original commits as its own event.
        let edit = edit_event("msg-edit", "msg-original", "edited");
        assert!(matches!(
            receiver.ingest_event(&edit),
            IngressOutcome::Committed { .. }
        ));

        // Edit referencing an unknown external message fails closed before
        // any mutation, and never mutates the accepted row.
        let stale = edit_event("msg-stale-edit", "msg-unknown", "edited");
        match receiver.ingest_event(&stale) {
            IngressOutcome::RejectedBeforeMutation { error } => {
                assert_eq!(error.code, "CHANNEL_STALE_EVENT");
            }
            other => panic!("expected RejectedBeforeMutation, got {other:?}"),
        }
    }
    assert_eq!(harness.mapping_count(), 2, "original + edit only");
    assert_eq!(harness.operation_count(), 2);
}

// ---------------------------------------------------------------------------
// Tamper
// ---------------------------------------------------------------------------

#[test]
fn tampered_durable_channel_ledger_fails_closed_at_reload() {
    let mut harness = RuntimeHarness::new("recv-tamper");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());

    {
        let store = SqliteChannelLedgerStore::new(&mut channel_connection).unwrap();
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(),
            Box::new(channel_clock()),
            store,
            host,
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let _ = receiver.ingest_event(&channel_event("account-a", "conv-1", "msg-11", "durable"));
    }

    // Tamper with the durable Channel document.
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let mut jcs = channel_connection2
        .query_row(
            "SELECT state_jcs FROM channel_ledger_state WHERE singleton = 1",
            [],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .unwrap();
    jcs[0] ^= 0x01;
    channel_connection2
        .execute(
            "UPDATE channel_ledger_state SET state_jcs = ?1 WHERE singleton = 1",
            [&jcs],
        )
        .unwrap();
    let error = {
        let mut store = SqliteChannelLedgerStore::new(&mut channel_connection2).unwrap();
        store.load().expect_err("tamper must fail closed")
    };
    assert_eq!(error.code, "CHANNEL_LEDGER_CORRUPT");
}
