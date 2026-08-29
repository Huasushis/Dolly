//! G4-C focused end-to-end, crash/replay, conflict, tamper, and authority
//! tests over the real durable Host ingress slice and the real Core reducer
//! transaction, with the Channel store backed by a real module-scoped SQLite
//! file and deterministic failpoints. Compiled only under the non-default
//! `test-support` feature.

#![cfg(feature = "test-support")]

mod common;

use std::path::Path;

use common::g4::*;
use dolly_channel::{
    AuthenticatedChannelEvent, ChannelPrincipal, InboundReceiver, IngressOutcome, InboundState,
    SqliteChannelStore, create_channel_store_schema,
};
use dolly_storage::SqliteHostIngressStore;
use rusqlite::Connection;
use tempfile::tempdir;

fn channel_store_connection(dir: &Path) -> (Connection, std::path::PathBuf) {
    let path = dir.join("channel-store.sqlite3");
    let mut connection = Connection::open(&path).unwrap();
    create_channel_store_schema(&mut connection).unwrap();
    (connection, path)
}

fn committed_block(outcome: &IngressOutcome) -> String {
    match outcome {
        IngressOutcome::Committed { block_id, .. } => block_id.clone(),
        other => panic!("expected Committed, got {other:?}"),
    }
}

fn principal_of(harness: &RuntimeHarness) -> ChannelPrincipal {
    ChannelPrincipal::from_authority_grant(&harness.authority, &harness.grant).unwrap()
}

// --- Pre-effect durability: initial Channel write failure -> zero effect ---

#[test]
fn initial_channel_write_failure_yields_zero_effect() {
    let mut harness = RuntimeHarness::new("recv-write-fail");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let principal = principal_of(&harness);
    let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut store = SqliteChannelStore::new(&mut channel_connection, &principal).unwrap();
    store.inject_write_prepared_failure(1);
    let mut receiver = InboundReceiver::new_with_store(
        channel_config(), Box::new(channel_clock()), store,
        inner, &harness.authority, &harness.grant).unwrap();
    let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-pf", "x"));
    assert!(matches!(outcome, IngressOutcome::SubmissionPending), "initial write failure must not look committed: {outcome:?}");
    drop(receiver);
    assert_eq!(harness.mapping_count(), 0, "zero Host premise");
    assert_eq!(harness.operation_count(), 0, "zero Core effect");
}

// --- Post-Host final transaction failure -> SubmissionPending, reconcile-alone ---

#[test]
fn post_host_final_transaction_failure_reconciles_alone_to_one_effect() {
    let mut harness = RuntimeHarness::new("recv-commit-fail");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let acct = account(&harness.authority, &harness.grant);

    let principal = principal_of(&harness);
    // Phase A: bind owner with a normal receiver, then drop it.
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        drop(receiver);
    }

    // Phase B: the Host submits with PLAIN SUCCESS (no lost response); the
    // commit_outcome SQLite failpoint fires AFTER the Host commit.
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        // `principal` was computed before borrowing harness.connection.
        let mut store = SqliteChannelStore::new(&mut channel_connection, &principal).unwrap();
        store.inject_commit_outcome_failure(1);
        let mut receiver = InboundReceiver::new_with_store(
            channel_config(), Box::new(channel_clock()), store,
            host, &harness.authority, &harness.grant).unwrap();
        let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-cf", "once"));
        assert!(matches!(outcome, IngressOutcome::SubmissionPending), "commit_outcome failure must yield retryable SubmissionPending, got {outcome:?}");
        // No terminal ledger row while the durable intent is Prepared.
        assert!(receiver.ledger().unwrap().inbound_entry(&acct, "msg-cf").is_none(), "no terminal row while Prepared");
    }
    assert_eq!(harness.mapping_count(), 1, "Host committed");
    assert_eq!(harness.operation_count(), 1);

    // Phase C: reopen and reconcile() ALONE — no re-ingest — status-first
    // restores the terminal state + complete ledger result exactly once.
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host2, &harness.authority, &harness.grant).unwrap();
    assert_eq!(receiver2.reconcile().unwrap(), 0, "reconcile alone converged");
    let ledger = receiver2.ledger().unwrap();
        let entry = ledger.inbound_entry(&acct, "msg-cf").expect("complete ledger result");
    assert_eq!(entry.state, InboundState::Accepted);
    assert!(entry.block_id.is_some());
    drop(receiver2);
    assert_eq!(harness.mapping_count(), 1, "no duplicate premise");
    assert_eq!(harness.operation_count(), 1, "exactly one Core effect");
}

// --- Lost response reconcile-alone (status-first, no resend) ---

#[test]
fn lost_response_reconciled_status_first_without_resend() {
    let mut harness = RuntimeHarness::new("recv-reconcile");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let acct = account(&harness.authority, &harness.grant);
    {
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut faulty = FaultyHostIngress::new(inner);
        faulty.commit_then_drop_submits = 1;
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            faulty, &harness.authority, &harness.grant).unwrap();
        let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-4", "lost"));
        assert!(matches!(outcome, IngressOutcome::SubmissionPending));
    }
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host2, &harness.authority, &harness.grant).unwrap();
    assert_eq!(receiver2.reconcile().unwrap(), 0, "status settled the pending intent");
    let ledger = receiver2.ledger().unwrap();
        let entry = ledger.inbound_entry(&acct, "msg-4").expect("row");
    assert_eq!(entry.state, InboundState::Accepted);
    drop(receiver2);
    assert_eq!(harness.mapping_count(), 1);
    assert_eq!(harness.operation_count(), 1, "status settled: no blind resend");
}

// --- Lifecycle/config/graph crossing replay rejection ---

#[test]
fn config_crossing_replay_is_rejected_before_core() {
    let mut harness = RuntimeHarness::new("recv-config-cross");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        assert!(matches!(receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-cross", "x")), IngressOutcome::Committed { .. }));
    }
    // Config revision 2 receiver; same event sealed under config revision 1 =>
    // the bound config revision no longer matches the current one.
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 2).target_pages(&["page-a"]).build(),
        Box::new(channel_clock()), &mut channel_connection,
        host2, &harness.authority, &harness.grant).unwrap();
    match receiver2.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-cross", "x")) {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert!(error.code == "CHANNEL_AUTHENTICATION_FAILED" || error.code == "CHANNEL_OPERATION_CONFLICT", "got {error:?}");
        }
        other => panic!("expected rejection, got {other:?}"),
    }
    drop(receiver2);
    assert_eq!(harness.mapping_count(), 1);
    assert_eq!(harness.operation_count(), 1, "no second Core effect");
}

#[test]
fn generation_crossing_replay_is_rejected() {
    let mut harness = RuntimeHarness::new("recv-gen-cross");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        assert!(matches!(receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-gen", "g")), IngressOutcome::Committed { .. }));
    }
    // Install a new grant with generation 2; attempt to replay the SAME old
    // sealed event (bound to generation 1).
    let new_grant = harness.reinstall_grant_with_generation(2);
    // A fresh channel store bound to the NEW principal (generation 2).
    let mut fresh_connection = Connection::open_in_memory().unwrap();
    create_channel_store_schema(&mut fresh_connection).unwrap();
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut fresh_connection,
        host2, &harness.authority, &new_grant).unwrap();
    let old_event = sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-gen", "g");
    match receiver2.ingest_event(&old_event) {
        IngressOutcome::RejectedBeforeMutation { error } => assert_eq!(error.code, "CHANNEL_AUTHENTICATION_FAILED"),
        other => panic!("expected generation crossing to be rejected, got {other:?}"),
    }
    drop(receiver2);
    assert_eq!(harness.mapping_count(), 1, "one durable mapping from phase A");
    assert_eq!(harness.operation_count(), 1, "no second Core effect");
}

// --- Receiver-level cross-module/store refusal reaching the owner check ---

#[test]
fn cross_module_store_reuse_fails_closed_at_receiver() {
    let mut harness = RuntimeHarness::new("recv-crossmod");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        drop(receiver);
    }
    // A second otherwise-valid principal/grant for the same owner (module-b)
    // with its own matching config attempts the SAME Channel DB: the receiver
    // must reach the store-owner rejection (cross-principal reuse fails at the
    // public boundary), not the config-mismatch check.
    let module_b_config = dolly_channel::ChannelConfigBuilder::new("web", "account-b", MODULE_OTHER, 1)
        .target_pages(&["page-a"]).build();
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let result = InboundReceiver::new(
        module_b_config, Box::new(channel_clock()), &mut channel_connection,
        host, &harness.authority, &harness.grant_other);
    match result {
        Err(e) => assert_eq!(e.code, "CHANNEL_AUTHENTICATION_FAILED"),
        Ok(_) => panic!("cross-module reuse must fail at the receiver boundary"),
    }
}

// --- Changed targets conflict ---

#[test]
fn same_key_changed_target_pages_conflicts_before_core() {
    let mut harness = RuntimeHarness::new("recv-pages");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        assert!(matches!(receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-pages", "same")), IngressOutcome::Committed { .. }));
    }
    // Receiver bound to the same principal+store with config revision 2 and
    // a different ordered target set.
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 2).target_pages(&["page-b"]).build(),
        Box::new(channel_clock()), &mut channel_connection,
        host2, &harness.authority, &harness.grant).unwrap();
    // Re-seal under the same principal/config facts so provenance passes and
    // the pre-replay digest conflict triggers.
    let event = AuthenticatedChannelEvent::new(&harness.authority, &harness.grant, 2, content_event("conv-1", "msg-pages", "same")).unwrap();
    match receiver2.ingest_event(&event) {
        IngressOutcome::RejectedBeforeMutation { error } => assert_eq!(error.code, "CHANNEL_OPERATION_CONFLICT"),
        other => panic!("expected conflict, got {other:?}"),
    }
    drop(receiver2);
    assert_eq!(harness.mapping_count(), 1);
    assert_eq!(harness.operation_count(), 1);
}

// --- End-to-end exactly-once + lossless projection ---

#[test]
fn authenticated_event_reaches_core_exactly_once_with_lossless_projection() {
    let mut harness = RuntimeHarness::new("recv-e2e");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());
    let acct = account(&harness.authority, &harness.grant);
    let block_id;
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        let event = sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-1", "Hello, Dolly.");
        block_id = committed_block(&receiver.ingest_event(&event));
        let ledger = receiver.ledger().unwrap();
        let entry = ledger.inbound_entry(&acct, "msg-1").expect("ledger row");
        assert_eq!(entry.state, InboundState::Accepted);
        assert_eq!(entry.channel_id, "web-primary");
        assert_eq!(entry.external_conversation_id, "conv-1");
        assert_eq!(entry.sender_class, "user");
        assert_eq!(entry.pages, vec!["page-a".to_string()]);
        assert_eq!(entry.received_at, CHANNEL_NOW);
    }
    let mut channel_connection2 = Connection::open(&path).unwrap();
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection2,
        host2, &harness.authority, &harness.grant).unwrap();
    let ledger = receiver2.ledger().unwrap();
        let entry = ledger.inbound_entry(&acct, "msg-1").expect("durable ledger row");
    assert_eq!(entry.state, InboundState::Accepted);
    assert_eq!(entry.block_id.as_deref(), Some(block_id.as_str()));
    drop(receiver2);
    assert_eq!(harness.mapping_count(), 1);
    assert_eq!(harness.operation_count(), 1);
}

// --- Durable echo markers: suppression with zero Host/Core ---

#[test]
fn durable_echo_marker_suppresses_matching_inbound_with_zero_core() {
    let mut harness = RuntimeHarness::new("recv-echo");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let acct = account(&harness.authority, &harness.grant);
    let principal = principal_of(&harness);
    // Record a durable echo marker in the owner-bound store.
    {
        let mut store = SqliteChannelStore::new(&mut channel_connection, &principal).unwrap();
        store.record_echo(&principal_of(&harness), "transport-echo-1").unwrap();
    }
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host, &harness.authority, &harness.grant).unwrap();
    let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "transport-echo-1", "echo"));
    assert!(matches!(outcome, IngressOutcome::EchoIgnored), "echo must be suppressed before Host/Core, got {outcome:?}");
    drop(receiver);
    assert_eq!(harness.mapping_count(), 0, "zero Host premise for an echo");
    assert_eq!(harness.operation_count(), 0, "zero Core effect for an echo");

    // Markers survive reopen.
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host2, &harness.authority, &harness.grant).unwrap();
    let outcome2 = receiver2.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "transport-echo-1", "echo"));
    assert!(matches!(outcome2, IngressOutcome::EchoIgnored), "echo marker must survive reopen, got {outcome2:?}");
    drop(receiver2);
    assert_eq!(harness.mapping_count(), 0);
}

// --- Semantic tamper with recomputed outer hash fails closed ---

#[test]
fn semantic_tamper_with_recomputed_hash_fails_closed() {
    let mut harness = RuntimeHarness::new("recv-semtamper");
    let dir = tempdir().unwrap();
    let (mut channel_connection, path) = channel_store_connection(dir.path());
    let acct = account(&harness.authority, &harness.grant);
    let principal = principal_of(&harness);
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        assert!(matches!(receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-tamper", "data")), IngressOutcome::Committed { .. }));
    }
    // Semantic tamper: change the ordered target pages AND recompute the outer
    // record hash so the bytes parse and hash-match. verify_intent must still
    // fail because the operation digest is recomputed from the (tampered)
    // fields and compared.
    {
        let mut store = SqliteChannelStore::new(&mut channel_connection, &principal).unwrap();
        let key = dolly_channel::ids::inbound_ingress_key(&acct, "msg-tamper");
        let mut intent = store.find_intent(&key).unwrap().unwrap();
        intent.target_page_ids = vec!["page-b".to_string()];
        let canonical = intent.canonical_string().unwrap();
        let digest = dolly_canonical_json::Sha256Digest::compute(canonical.as_bytes()).to_canonical_string();
        channel_connection.execute(
            "UPDATE channel_intent SET record_digest = ?1, canonical_jcs = ?2 WHERE intent_key = ?3",
            rusqlite::params![digest, canonical.as_bytes(), key],
        ).unwrap();
    }
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host2, &harness.authority, &harness.grant).unwrap();
    let err = receiver2.ledger().expect_err("semantic tamper must fail closed");
    assert_eq!(err.code, "CHANNEL_LEDGER_CORRUPT");
    let _ = path;
}

// --- Authority replay revalidation ---

#[test]
fn current_authority_replay_revalidates_and_keeps_one_effect() {
    let mut harness = RuntimeHarness::new("recv-replay");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host, &harness.authority, &harness.grant).unwrap();
    let event = sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-replay", "hi");
    let first = committed_block(&receiver.ingest_event(&event));
    match receiver.ingest_event(&event) {
        IngressOutcome::IdempotentReplay { block_id } => assert_eq!(block_id, first),
        other => panic!("expected IdempotentReplay, got {other:?}"),
    }
    drop(receiver);
    assert_eq!(harness.mapping_count(), 1);
    assert_eq!(harness.operation_count(), 1, "replay revalidates, never re-effects");
}

#[test]
fn revoked_authority_replay_never_returns_cached_success() {
    let mut harness = RuntimeHarness::new("recv-revoked");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        assert!(matches!(receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-revoked", "zap")), IngressOutcome::Committed { .. }));
    }
    let authority = harness.authority.clone();
    harness.revoke_grant(&authority, MODULE_ID);
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host, &harness.authority, &harness.grant).unwrap();
    let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-revoked", "zap"));
    assert!(!matches!(outcome, IngressOutcome::IdempotentReplay { .. }), "must not return cached success under revoked authority: {outcome:?}");
    drop(receiver);
    assert_eq!(harness.mapping_count(), 1);
    assert_eq!(harness.operation_count(), 1);
}

#[test]
fn event_bound_to_another_principal_fails_closed() {
    let mut harness = RuntimeHarness::new("recv-principal");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host, &harness.authority, &harness.grant).unwrap();
    let foreign = sealed_event(&harness.authority, &harness.grant_other, "conv-1", "msg-x", "spoof");
    match receiver.ingest_event(&foreign) {
        IngressOutcome::RejectedBeforeMutation { error } => assert_eq!(error.code, "CHANNEL_AUTHENTICATION_FAILED"),
        other => panic!("expected RejectedBeforeMutation, got {other:?}"),
    }
    drop(receiver);
    assert_eq!(harness.mapping_count(), 0);
    assert_eq!(harness.operation_count(), 0);
}

// --- Direction, relation ---

#[test]
fn opposite_direction_target_fails_closed() {
    let mut harness = RuntimeHarness::new_with_outputs("recv-opposite", &["page-b"], &["page-a"]);
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let config = dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1).target_pages(&["page-a"]).build();
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        config, Box::new(channel_clock()), &mut channel_connection,
        host, &harness.authority, &harness.grant).unwrap();
    let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-10", "wrong way"));
    assert!(matches!(outcome, IngressOutcome::CoreRejected { .. } | IngressOutcome::RejectedBeforeMutation { .. }), "opposite target must fail closed: {outcome:?}");
    drop(receiver);
    assert_eq!(harness.mapping_count(), 0);
    assert_eq!(harness.operation_count(), 0);
}

#[test]
fn edit_delete_relation_and_stale_reference_fails_closed() {
    let mut harness = RuntimeHarness::new("recv-relation");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host, &harness.authority, &harness.grant).unwrap();
    assert!(matches!(receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-original", "original")), IngressOutcome::Committed { .. }));
    assert!(matches!(receiver.ingest_event(&sealed_edit_event(&harness.authority, &harness.grant, "msg-edit", "msg-original", "edited")), IngressOutcome::Committed { .. }));
    match receiver.ingest_event(&sealed_edit_event(&harness.authority, &harness.grant, "msg-stale", "msg-unknown", "edited")) {
        IngressOutcome::RejectedBeforeMutation { error } => assert_eq!(error.code, "CHANNEL_STALE_EVENT"),
        other => panic!("expected RejectedBeforeMutation, got {other:?}"),
    }
    drop(receiver);
    assert_eq!(harness.mapping_count(), 2, "original + edit only");
    assert_eq!(harness.operation_count(), 2);
}

#[test]
fn graph_crossing_replay_is_rejected() {
    let mut harness = RuntimeHarness::new("recv-graph-cross");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        assert!(matches!(receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-g", "g")), IngressOutcome::Committed { .. }));
    }
    // Install a NEW grant pinned to a different graph revision AND digest.
    let other_body = graph_with_outputs(&[MODULE_ID, MODULE_OTHER], &[], &["page-x", "page-y"]);
    let new_grant = harness.reinstall_grant_with_graph(2, &digest(&other_body));
    let mut fresh_connection = Connection::open_in_memory().unwrap();
    create_channel_store_schema(&mut fresh_connection).unwrap();
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut fresh_connection,
        host2, &harness.authority, &new_grant).unwrap();
    let old_event = sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-g", "g");
    match receiver2.ingest_event(&old_event) {
        IngressOutcome::RejectedBeforeMutation { error } => assert_eq!(error.code, "CHANNEL_AUTHENTICATION_FAILED"),
        other => panic!("expected graph crossing to be rejected, got {other:?}"),
    }
    drop(receiver2);
    assert_eq!(harness.mapping_count(), 1, "one durable mapping from phase A");
    assert_eq!(harness.operation_count(), 1, "no second Core effect");
}

#[test]
fn host_conflict_for_changed_content_then_reconcile_rejects() {
    let mut harness = RuntimeHarness::new("recv-hostconflict");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let acct = account(&harness.authority, &harness.grant);
    // 1. Accept msg content A under targets [page-a].
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        assert!(matches!(receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-hc", "A")), IngressOutcome::Committed { .. }));
    }
    // 2. Delete the Channel intent row (recreated Channel) so the same key
    //    re-ingests with DIFFERENT content B.
    let key = dolly_channel::ids::inbound_ingress_key(&acct, "msg-hc");
    channel_connection.execute("DELETE FROM channel_intent WHERE intent_key = ?1", [&key]).unwrap();
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-hc", "B"));
        // The Host has a committed mapping for the ORIGINAL content A under
        // the same key; the recreated Channel row with content B must never
        // adopt it — success is impossible.
        assert!(
            !matches!(outcome, IngressOutcome::Committed { .. } | IngressOutcome::IdempotentReplay { .. }),
            "a recreated row for changed content must not adopt the old Host effect: {outcome:?}"
        );
        drop(receiver);
    }
    assert_eq!(harness.mapping_count(), 1, "only the original A mapping exists");
    assert_eq!(harness.operation_count(), 1, "no second Core effect");

    // 3. reconcile() over the durable prepared B intent must REJECT the
    //    conflicting Host mapping, keeping the row pending.
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host2, &harness.authority, &harness.grant).unwrap();
    let err = receiver2.reconcile().expect_err("conflicting host mapping must be rejected");
    assert_eq!(err.code, "CHANNEL_OPERATION_CONFLICT");
    drop(receiver2);
    assert_eq!(harness.mapping_count(), 1, "no new premise after rejected reconcile");
    assert_eq!(harness.operation_count(), 1, "exactly one Core effect");
}
