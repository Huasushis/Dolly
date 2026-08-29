//! G4-C focused end-to-end, crash/replay, conflict, tamper, and authority
//! tests.
//!
//! These tests drive the shipping-runtime Channel inbound wiring
//! ([`InboundReceiver`]) over the REAL durable Host ingress slice and the
//! REAL Core reducer transaction (via `dolly-storage`), with the Channel
//! store (ledger document + prepared intents) backed by a real module-scoped
//! SQLite file so stop/restart and crash behavior is exercised, not
//! simulated:
//!
//! - the durable `prepared` intent precedes any Host submit or Core effect;
//! - status-first reconciliation after a lost response or a post-Host
//!   crash — one Core effect, never a blind resend, never a false success;
//! - same key + same digest replays after revalidating the CURRENT
//!   authority/grant and status; same key + changed ordered target
//!   Pages/content/relation conflicts before Core;
//! - stale/revoked authority, wrong-principal events, echoes, and
//!   opposite-direction targets fail closed with no premise or effect;
//! - tampered durable records fail closed;
//! - no root lock / conformance / registration file is touched by these
//!   tests: they exercise only the Channel crate surfaces.

mod common;

use std::path::Path;

use common::g4::*;
use dolly_channel::{
    ChannelLedger, ChannelStore, InboundReceiver, InboundState, IngressOutcome, SqliteChannelStore,
    create_channel_store_schema,
};
use dolly_storage::SqliteHostIngressStore;
use rusqlite::Connection;
use tempfile::tempdir;

/// Open a fresh module-scoped Channel store database file and create its
/// schema.
fn channel_store_connection(dir: &Path) -> (Connection, std::path::PathBuf) {
    let path = dir.join("channel-store.sqlite3");
    let mut connection = Connection::open(&path).unwrap();
    create_channel_store_schema(&mut connection).unwrap();
    (connection, path)
}

/// Assert a committed outcome and return its block id.
fn committed_block(outcome: &IngressOutcome) -> String {
    match outcome {
        IngressOutcome::Committed { block_id, .. } => block_id.clone(),
        other => panic!("expected Committed, got {other:?}"),
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

    let block_id;
    {
        let store = dolly_channel::SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
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

        let event = sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-1",
            "Hello, Dolly.",
        );
        let first = receiver.ingest_event(&event);
        block_id = committed_block(&first);
        let entry = receiver
            .ledger()
            .inbound_entry(
                &dolly_channel::ids::channel_account(
                    harness.authority.extension_connection_id(),
                    harness.grant.extension_id(),
                    harness.grant.module_id(),
                    harness.authority.worker_epoch().as_str(),
                ),
                "msg-1",
            )
            .expect("ledger row");
        assert_eq!(entry.state, InboundState::Accepted);
    }

    // Durable store: ledger document AND the accepted intent survive.
    let account = dolly_channel::ids::channel_account(
        harness.authority.extension_connection_id(),
        harness.grant.extension_id(),
        harness.grant.module_id(),
        harness.authority.worker_epoch().as_str(),
    );
    let mut channel_connection2 = Connection::open(&path).unwrap();
    {
        let mut store = SqliteChannelStore::new(
            &mut channel_connection2,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
        let durable = store.load().unwrap();
        let durable_entry = durable
            .inbound_entry(&account, "msg-1")
            .expect("durable ledger row");
        assert_eq!(durable_entry.state, InboundState::Accepted);
        assert_eq!(durable_entry.block_id.as_deref(), Some(block_id.as_str()));
        let intent = store
            .find_intent(&dolly_channel::ids::inbound_ingress_key(&account, "msg-1"))
            .unwrap()
            .expect("intent row");
        assert_eq!(intent.state, dolly_channel::IntentState::Accepted);
        assert_eq!(intent.block_id.as_deref(), Some(block_id.as_str()));
        assert_eq!(intent.target_page_ids, vec!["page-a".to_string()]);
        assert_eq!(intent.module_id, MODULE_ID);
    }

    assert_eq!(harness.mapping_count(), 1, "one durable Host mapping");
    assert_eq!(harness.operation_count(), 1, "one Core effect");
}

// ---------------------------------------------------------------------------
// Durable prepared intent BEFORE any Host/Core effect
// ---------------------------------------------------------------------------

#[test]
fn durable_prepared_intent_precedes_any_host_or_core_effect() {
    let mut harness = RuntimeHarness::new("recv-prepared");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());

    {
        let store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut faulty = FaultyHostIngress::new(inner);
        // The submit response is lost BEFORE it reaches the Host slice; only
        // the prepared intent is durable.
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
        let outcome = receiver.ingest_event(&sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-prepared",
            "pending",
        ));
        assert!(matches!(outcome, IngressOutcome::SubmissionPending));
    }

    // The durable prepared intent row exists in the real SQLite file, while
    // NO Host premise and NO Core effect exist: durable pending precedes any
    // effect.
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let mut store = SqliteChannelStore::new(
        &mut channel_connection2,
        store_owner(&harness.authority, &harness.grant),
    )
    .unwrap();
    let intents = store.list_pending().unwrap();
    assert_eq!(intents.len(), 1, "one durable prepared intent");
    assert_eq!(intents[0].external_event_id, "msg-prepared");
    assert_eq!(intents[0].state, dolly_channel::IntentState::Prepared);
    assert_eq!(
        harness.mapping_count(),
        0,
        "no Host premise before a successful submit"
    );
    assert_eq!(
        harness.operation_count(),
        0,
        "no Core effect before the submit"
    );
}

#[test]
fn initial_prepared_persistence_failure_prevents_any_core_effect() {
    let mut harness = RuntimeHarness::new("recv-persist-fail");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    {
        let inner_store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
        let mut store = FailpointChannelStore::new(inner_store);
        store.fail_prepared_writes = 1;
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
        let outcome = receiver.ingest_event(&sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-nopersist",
            "x",
        ));
        assert!(
            matches!(
                outcome,
                IngressOutcome::CoreRejected { .. } | IngressOutcome::RejectedBeforeMutation { .. }
            ),
            "a persistence failure must never look like a commit: {outcome:?}"
        );
    }
    assert_eq!(harness.mapping_count(), 0, "no Host submit ran");
    assert_eq!(harness.operation_count(), 0, "no Core effect ran");
}

// ---------------------------------------------------------------------------
// Crash / replay / reconciliation
// ---------------------------------------------------------------------------

#[test]
fn lost_response_is_reconciled_status_first_without_resend() {
    let mut harness = RuntimeHarness::new("recv-reconcile");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());

    // Phase A: the submit COMMITS durably inside the Host slice, but the
    // response is lost. The prepared intent is durable; the doc row is
    // `submitted`.
    {
        let store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut faulty = FaultyHostIngress::new(inner);
        faulty.commit_then_drop_submits = 1;
        let mut receiver = InboundReceiver::new(
            channel_config(),
            Box::new(channel_clock()),
            store,
            faulty,
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let outcome = receiver.ingest_event(&sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-4",
            "lost",
        ));
        assert!(matches!(outcome, IngressOutcome::SubmissionPending));
    }

    // Restart: reopen the real SQLite rows and reconcile status-first.
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let store2 = SqliteChannelStore::new(
        &mut channel_connection2,
        store_owner(&harness.authority, &harness.grant),
    )
    .unwrap();
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        channel_config(),
        Box::new(channel_clock()),
        store2,
        host2,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();
    let remaining = receiver2.reconcile().unwrap();
    assert_eq!(remaining, 0, "status settled the pending intent");
    let entry = receiver2
        .ledger()
        .inbound_entry(
            &dolly_channel::ids::channel_account(
                harness.authority.extension_connection_id(),
                harness.grant.extension_id(),
                harness.grant.module_id(),
                harness.authority.worker_epoch().as_str(),
            ),
            "msg-4",
        )
        .expect("row");
    assert_eq!(entry.state, InboundState::Accepted);
    assert!(entry.block_id.is_some());
    drop(receiver2);

    assert_eq!(harness.mapping_count(), 1, "no duplicate mapping");
    assert_eq!(
        harness.operation_count(),
        1,
        "status settled the intent: no blind resend"
    );
}

#[test]
fn post_host_commit_pre_final_save_crash_converges_status_first() {
    let mut harness = RuntimeHarness::new("recv-crash");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());
    let config = channel_config();

    // Phase A: the Host slice commits and the core effect lands, but the
    // ledger-document save (the "final" save) fails — the durable prepared
    // intent is the only Channel-side record that survived.
    let first_block;
    {
        let inner_store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
        let mut store = FailpointChannelStore::new(inner_store);
        store.fail_doc_saves = 1;
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
        let outcome = receiver.ingest_event(&sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-crash",
            "once",
        ));
        // The effect IS durable in the Host slice; only the Channel-side
        // final save failed, so the acknowledgement is withheld.
        assert!(matches!(outcome, IngressOutcome::SubmissionPending));
        first_block = {
            // read the accepted intent from a second connection to observe
            // the durable state
            let mut reader = Connection::open(&path).unwrap();
            let mut store2 = SqliteChannelStore::new(
                &mut reader,
                store_owner(&harness.authority, &harness.grant),
            )
            .unwrap();
            let intent = store2
                .find_intent(&dolly_channel::ids::inbound_ingress_key(
                    &dolly_channel::ids::channel_account(
                        harness.authority.extension_connection_id(),
                        harness.grant.extension_id(),
                        harness.grant.module_id(),
                        harness.authority.worker_epoch().as_str(),
                    ),
                    "msg-crash",
                ))
                .unwrap()
                .expect("durable intent");
            assert_eq!(intent.state, dolly_channel::IntentState::Accepted);
            intent.block_id.clone().expect("committed block")
        };
    }

    // Reopen: the ledger document never received the row, but the durable
    // intent did. Re-ingesting the same event must converge status-first with
    // the SAME block and exactly one Core effect.
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let store2 = SqliteChannelStore::new(
        &mut channel_connection2,
        store_owner(&harness.authority, &harness.grant),
    )
    .unwrap();
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        config,
        Box::new(channel_clock()),
        store2,
        host2,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();
    let replay = receiver2.ingest_event(&sealed_event(
        &harness.authority,
        &harness.grant,
        "conv-1",
        "msg-crash",
        "once",
    ));
    let replayed = committed_block(&replay);
    assert_eq!(
        replayed, first_block,
        "the same durable block is authoritative"
    );
    drop(receiver2);

    assert_eq!(harness.mapping_count(), 1, "no duplicate premise");
    assert_eq!(harness.operation_count(), 1, "no duplicate Core effect");
    let snapshot = harness.core_store().snapshot().unwrap();
    assert_eq!(snapshot.blocks.len(), 1);
}

// ---------------------------------------------------------------------------
// Conflicts before Core
// ---------------------------------------------------------------------------

#[test]
fn same_key_different_content_conflicts_before_core() {
    let mut harness = RuntimeHarness::new("recv-content");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    {
        let store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
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

        let original = sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-2",
            "original",
        );
        assert!(matches!(
            receiver.ingest_event(&original),
            IngressOutcome::Committed { .. }
        ));
        let changed = sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-2",
            "changed",
        );
        match receiver.ingest_event(&changed) {
            IngressOutcome::RejectedBeforeMutation { error } => {
                assert_eq!(error.code, "CHANNEL_OPERATION_CONFLICT");
            }
            other => panic!("expected RejectedBeforeMutation, got {other:?}"),
        }
    }
    assert_eq!(harness.mapping_count(), 1, "no new premise");
    assert_eq!(harness.operation_count(), 1, "no new Core effect");
}

#[test]
fn same_key_changed_target_pages_conflicts_before_core() {
    let mut harness = RuntimeHarness::new("recv-pages");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());

    // Receiver v1 targets [page-a].
    {
        let store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
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
        let outcome = receiver.ingest_event(&sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-pages",
            "same",
        ));
        assert!(matches!(outcome, IngressOutcome::Committed { .. }));
    }

    // Receiver v2 (config revision 2) targets only [page-b]: the same event
    // key now carries a different ordered target set, so the Channel-local
    // digest conflicts BEFORE any new Core effect.
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let store2 = SqliteChannelStore::new(
        &mut channel_connection2,
        store_owner(&harness.authority, &harness.grant),
    )
    .unwrap();
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 2)
            .target_pages(&["page-b"])
            .build(),
        Box::new(channel_clock()),
        store2,
        host2,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();
    let outcome = receiver2.ingest_event(&sealed_event(
        &harness.authority,
        &harness.grant,
        "conv-1",
        "msg-pages",
        "same",
    ));
    match outcome {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_OPERATION_CONFLICT");
        }
        other => panic!("expected RejectedBeforeMutation conflict, got {other:?}"),
    }
    drop(receiver2);

    assert_eq!(harness.mapping_count(), 1, "no second premise");
    assert_eq!(harness.operation_count(), 1, "no second Core effect");
}

#[test]
fn crash_after_commit_with_no_channel_document_reconciles_status_first() {
    let mut harness = RuntimeHarness::new("recv-empty-doc");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());

    // The Host slice commits, but BOTH the submit response and the final
    // ledger-document save are lost: the only durable Channel-side record is
    // the prepared intent row. This is the "empty-ledger path" the recovery
    // must never silently lose.
    let account = dolly_channel::ids::channel_account(
        harness.authority.extension_connection_id(),
        harness.grant.extension_id(),
        harness.grant.module_id(),
        harness.authority.worker_epoch().as_str(),
    );
    {
        let inner_store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
        let mut store = FailpointChannelStore::new(inner_store);
        store.fail_doc_saves = 1;
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut faulty = FaultyHostIngress::new(inner);
        faulty.commit_then_drop_submits = 1;
        let mut receiver = InboundReceiver::new(
            channel_config(),
            Box::new(channel_clock()),
            store,
            faulty,
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let outcome = receiver.ingest_event(&sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-empty-doc",
            "effect started",
        ));
        assert!(matches!(outcome, IngressOutcome::SubmissionPending));
    }

    // Reopen: the ledger document has NO row; the prepared intent is the only
    // durable Channel-side record. Reconcile must open that SQLite row, call
    // Host `status` first, and converge with exactly one Core effect.
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let mut store2 = SqliteChannelStore::new(
        &mut channel_connection2,
        store_owner(&harness.authority, &harness.grant),
    )
    .unwrap();
    let ledger_before = store2.load().unwrap();
    assert!(
        ledger_before
            .inbound_entry(&account, "msg-empty-doc")
            .is_none(),
        "the empty-ledger path is real: no terminal document row survived"
    );
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        channel_config(),
        Box::new(channel_clock()),
        store2,
        host2,
        &harness.authority,
        &harness.grant,
    )
    .unwrap();
    let remaining = receiver2.reconcile().unwrap();
    assert_eq!(remaining, 0, "the prepared intent converged");
    drop(receiver2);

    assert_eq!(harness.mapping_count(), 1, "no duplicate premise");
    assert_eq!(
        harness.operation_count(),
        1,
        "status first: no blind resend"
    );
    let snapshot = harness.core_store().snapshot().unwrap();
    assert_eq!(
        snapshot.blocks.len(),
        1,
        "the started effect reached Core once"
    );
}

#[test]
fn current_authority_replay_revalidates_and_keeps_one_effect() {
    let mut harness = RuntimeHarness::new("recv-replay");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    let first_block;
    {
        let store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
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
        let event = sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-replay",
            "hi",
        );
        first_block = committed_block(&receiver.ingest_event(&event));

        // Replay under the SAME current authority: revalidated, same block,
        // zero new Core effect.
        match receiver.ingest_event(&event) {
            IngressOutcome::IdempotentReplay { block_id } => {
                assert_eq!(block_id, first_block);
            }
            other => panic!("expected IdempotentReplay, got {other:?}"),
        }
    }
    assert_eq!(harness.mapping_count(), 1);
    assert_eq!(
        harness.operation_count(),
        1,
        "replay revalidates, never re-effects"
    );
}

#[test]
fn stale_or_revoked_authority_replay_never_returns_cached_success() {
    let mut harness = RuntimeHarness::new("recv-revoked");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    // Commit under a live grant.
    {
        let store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
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
        let event = sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-revoked",
            "zap",
        );
        assert!(matches!(
            receiver.ingest_event(&event),
            IngressOutcome::Committed { .. }
        ));
    }

    // Revoke the grant, then replay the exact same event: the receiver must
    // NOT return the cached mapping — it must fail closed by revalidation.
    let authority = harness.authority.clone();
    harness.revoke_grant(&authority, MODULE_ID);

    let store = SqliteChannelStore::new(
        &mut channel_connection,
        store_owner(&harness.authority, &harness.grant),
    )
    .unwrap();
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
    let event = sealed_event(
        &harness.authority,
        &harness.grant,
        "conv-1",
        "msg-revoked",
        "zap",
    );
    let outcome = receiver.ingest_event(&event);
    match outcome {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_ne!(error.code, "CHANNEL_OPERATION_CONFLICT");
        }
        other => panic!("expected a fail-closed rejection, got {other:?}"),
    }
    drop(receiver);
    assert_eq!(
        harness.mapping_count(),
        1,
        "the revoke changes no durable mapping"
    );
    assert_eq!(harness.operation_count(), 1, "no new Core effect");
}

#[test]
fn event_bound_to_another_principal_fails_closed() {
    let mut harness = RuntimeHarness::new("recv-principal");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    let store = SqliteChannelStore::new(
        &mut channel_connection,
        store_owner(&harness.authority, &harness.grant),
    )
    .unwrap();
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

    // The event is sealed under a DIFFERENT grant/module principal.
    let foreign = sealed_event(
        &harness.authority,
        &harness.grant_other,
        "conv-1",
        "msg-x",
        "spoof",
    );
    match receiver.ingest_event(&foreign) {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_AUTHENTICATION_FAILED");
        }
        other => panic!("expected RejectedBeforeMutation, got {other:?}"),
    }
    drop(receiver);
    assert_eq!(harness.mapping_count(), 0);
    assert_eq!(harness.operation_count(), 0);
}

// ---------------------------------------------------------------------------
// Direction, relation, echo, tamper
// ---------------------------------------------------------------------------

#[test]
fn echo_of_confirmed_outbound_is_suppressed_without_core() {
    let mut harness = RuntimeHarness::new("recv-echo");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());

    // Seed the durable ledger document with a confirmed outbound echo.
    {
        let mut seed = ChannelLedger::new();
        seed.record_echoed("transport-echo-1", "any"); // note: echo keys are account-scoped; use raw store below
        drop(seed);
        // The echo set is keyed by `account NUL message`; account is
        // principal-derived, so seed through the store with the right account.
        let mut store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
        let mut ledger = ChannelLedger::new();
        ledger.record_echoed(
            &dolly_channel::ids::channel_account(
                harness.authority.extension_connection_id(),
                harness.grant.extension_id(),
                harness.grant.module_id(),
                harness.authority.worker_epoch().as_str(),
            ),
            "transport-echo-1",
        );
        store.save(&ledger).unwrap();
    }

    let store = SqliteChannelStore::new(
        &mut channel_connection,
        store_owner(&harness.authority, &harness.grant),
    )
    .unwrap();
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
    let outcome = receiver.ingest_event(&sealed_event(
        &harness.authority,
        &harness.grant,
        "conv-1",
        "transport-echo-1",
        "echo",
    ));
    assert!(matches!(outcome, IngressOutcome::EchoIgnored));
    drop(receiver);
    assert_eq!(harness.mapping_count(), 0, "an echo never reaches Core");
    assert_eq!(harness.operation_count(), 0);
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
        let store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
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
        let outcome = receiver.ingest_event(&sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-10",
            "wrong way",
        ));
        assert!(
            matches!(
                outcome,
                IngressOutcome::CoreRejected { .. } | IngressOutcome::RejectedBeforeMutation { .. }
            ),
            "opposite target must fail closed: {outcome:?}"
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
        let store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
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

        let original = sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-original",
            "original",
        );
        assert!(matches!(
            receiver.ingest_event(&original),
            IngressOutcome::Committed { .. }
        ));

        let edit = sealed_edit_event(
            &harness.authority,
            &harness.grant,
            "msg-edit",
            "msg-original",
            "edited",
        );
        assert!(matches!(
            receiver.ingest_event(&edit),
            IngressOutcome::Committed { .. }
        ));

        let stale = sealed_edit_event(
            &harness.authority,
            &harness.grant,
            "msg-stale",
            "msg-unknown",
            "edited",
        );
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

#[test]
fn tampered_durable_channel_store_fails_closed_at_reload() {
    let mut harness = RuntimeHarness::new("recv-tamper");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());

    {
        let store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
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
        let _ = receiver.ingest_event(&sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-11",
            "durable",
        ));
    }

    // Tamper with the durable ledger document.
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
        let mut store = SqliteChannelStore::new(
            &mut channel_connection2,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
        store.load().expect_err("tamper must fail closed")
    };
    assert_eq!(error.code, "CHANNEL_LEDGER_CORRUPT");
}

#[test]
fn cross_module_store_reuse_fails_closed() {
    let mut harness = RuntimeHarness::new("recv-crossmod");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());

    {
        let store = SqliteChannelStore::new(
            &mut channel_connection,
            store_owner(&harness.authority, &harness.grant),
        )
        .unwrap();
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
        let _ = receiver.ingest_event(&sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-12",
            "bound",
        ));
    }

    // Reopen the same file under a DIFFERENT module ownership: fail closed.
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let wrong = dolly_channel::ChannelStoreOwner {
        extension_id: "org.dolly.other".to_string(),
        module_id: "other-module".to_string(),
        account: "dolly-account-ffffffffffffffff".to_string(),
    };
    let error =
        SqliteChannelStore::new(&mut channel_connection2, wrong).expect_err("cross-module reuse");
    assert_eq!(error.code, "CHANNEL_AUTHENTICATION_FAILED");
}
