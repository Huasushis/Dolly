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
use dolly_storage::{HostIngress as _, SqliteHostIngressStore};
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
    let mut store = SqliteChannelStore::new(&mut channel_connection, &principal, 1).unwrap();
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
        let mut store = SqliteChannelStore::new(&mut channel_connection, &principal, 1).unwrap();
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
    // Config revision 2 receiver reaching for the SAME store: the store is
    // bound to the exact config revision, so reopening under a different
    // config fence fails closed at the receiver/store ownership boundary
    // (cross-config replay is rejected before any Core path).
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let result = InboundReceiver::new(
        dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 2).target_pages(&["page-a"]).build(),
        Box::new(channel_clock()), &mut channel_connection,
        host2, &harness.authority, &harness.grant);
    match result {
        Err(e) => assert_eq!(e.code, "CHANNEL_AUTHENTICATION_FAILED"),
        Ok(mut ok) => {
            // If construction passes, ingest must still reject (belt + braces).
            let outcome = ok.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-cross", "x"));
            assert!(matches!(outcome, IngressOutcome::RejectedBeforeMutation { .. }));
            drop(ok);
        }
    }
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
    // Same principal+store, SAME config revision but a different ordered
    // target set: the store owner (config rev 1) matches so construction
    // succeeds, and the Channel-local digest conflict fires on the pre-check
    // BEFORE any Core path.
    let host2 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver2 = InboundReceiver::new(
        dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1).target_pages(&["page-b"]).build(),
        Box::new(channel_clock()), &mut channel_connection,
        host2, &harness.authority, &harness.grant).unwrap();
    // Re-seal under the same principal/config facts so provenance passes and
    // the pre-replay digest conflict triggers.
    let event = AuthenticatedChannelEvent::new(&harness.authority, &harness.grant, 1, content_event("conv-1", "msg-pages", "same")).unwrap();
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
    let principal = principal_of(&harness);
    // Record a durable echo marker in the owner-bound store.
    {
        let mut store = SqliteChannelStore::new(&mut channel_connection, &principal, 1).unwrap();
        store.record_echo(&principal_of(&harness), 1, "transport-echo-1").unwrap();
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
        let mut store = SqliteChannelStore::new(&mut channel_connection, &principal, 1).unwrap();
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

// --- One complete validate_host_mapping path: crafted bad mappings refuse ---

/// Fetch the REAL committed Host mapping for an event (used as the baseline
/// a crafted mutation is derived from).
fn real_mapping_for(harness: &mut RuntimeHarness, external_event_id: &str) -> dolly_core_domain::HostIngressMapping {
    let mut store = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let request = dolly_core_domain::HostIngressStatusRequest { external_event_id: external_event_id.to_string() };
    match store.status(&harness.authority, &harness.grant, &request) {
        Ok(dolly_core_domain::HostIngressStatus::Committed(mapping)) => (*mapping).clone(),
        Ok(_) => panic!("baseline mapping absent"),
        Err(e) => panic!("baseline mapping read failed: {e}"),
    }
}

/// Re-ingest an already-accepted event under a Host whose `status` returns a
/// CRAFTED mapping (derived from the real one with one mutation); the receiver
/// must refuse the cached success via the complete validate_host_mapping,
/// never say Committed/IdempotentReplay.
fn assert_crafted_mapping_refuses(
    harness: &mut RuntimeHarness,
    channel_connection: &mut rusqlite::Connection,
    event: &AuthenticatedChannelEvent,
    label: &str,
    mutated: impl FnOnce(&mut dolly_core_domain::HostIngressMapping),
) {
    let mut crafted = real_mapping_for(harness, "msg-R");
    mutated(&mut crafted);
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let override_host = MappingOverrideHost::new(host)
        .with_status_override(dolly_core_domain::HostIngressStatus::Committed(Box::new(crafted)));
    let two_page = dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1)
        .target_pages(&["page-a", "page-b"]).build();
    let mut receiver = InboundReceiver::new(
        two_page, Box::new(channel_clock()), channel_connection,
        override_host, &harness.authority, &harness.grant).unwrap();
    let outcome = receiver.ingest_event(event);
    assert!(
        !matches!(outcome, IngressOutcome::Committed { .. } | IngressOutcome::IdempotentReplay { .. }),
        "crafted [{label}] must refuse success: {outcome:?}"
    );
    drop(receiver);
}

#[test]
fn crafted_bad_mapping_replay_always_refuses_before_success() {
    let mut harness = RuntimeHarness::new("recv-crafted");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    // Two ordered target pages so duplicate/reorder/missing delivery cases are
    // genuinely distinct from the valid sequence.
    let two_page = dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1)
        .target_pages(&["page-a", "page-b"]).build();
    let event = sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-R", "hello");

    // Baseline accept with a plain Host under the two-page config.
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            two_page.clone(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        assert!(matches!(receiver.ingest_event(&event), IngressOutcome::Committed { .. }));
        drop(receiver);
        assert_eq!(harness.mapping_count(), 1);
    }

    // Bad schema.
    assert_crafted_mapping_refuses(&mut harness, &mut channel_connection, &event, "bad schema", |m| { m.schema = "dolly.evil/v1".into(); });
    // Wrong deterministic ingress key.
    assert_crafted_mapping_refuses(&mut harness, &mut channel_connection, &event, "bad ingress key", |m| { m.ingress_key = "sha256:0000000000000000000000000000000000000000000000000000000000000000".into(); });
    // Wrong ingress identity (command linkage breaks).
    assert_crafted_mapping_refuses(&mut harness, &mut channel_connection, &event, "bad ingress identity", |m| { m.ingress_id = "0198ab31-6c44-7e8a-b2bb-0000000009ff".into(); });
    // Wrong block identity vs the stored accepted intent.
    assert_crafted_mapping_refuses(&mut harness, &mut channel_connection, &event, "bad block identity", |m| { m.block_id = "0198ab31-6c44-7e8a-b2bb-0000000000ff".into(); });
    // Zero deliveries.
    assert_crafted_mapping_refuses(&mut harness, &mut channel_connection, &event, "zero deliveries", |m| { m.deliveries.clear(); });
    // Missing (dropped) delivery.
    assert_crafted_mapping_refuses(&mut harness, &mut channel_connection, &event, "dropped delivery", |m| { m.deliveries.pop(); });
    // Duplicate delivery.
    assert_crafted_mapping_refuses(&mut harness, &mut channel_connection, &event, "duplicate delivery", |m| {
        let first = m.deliveries[0].clone();
        m.deliveries.push(first);
    });
    // Reordered delivery list.
    assert_crafted_mapping_refuses(&mut harness, &mut channel_connection, &event, "reordered deliveries", |m| { m.deliveries.reverse(); });
    // Wrong payload/content.
    assert_crafted_mapping_refuses(&mut harness, &mut channel_connection, &event, "wrong payload", |m| {
        m.payload = serde_json::from_value(serde_json::json!({"schema":"dolly.block/v1","parts":[]})).unwrap();
    });

    assert_eq!(harness.mapping_count(), 1, "no crafted mapping was adopted");
    assert_eq!(harness.operation_count(), 1, "exactly one real Core effect");
}

#[test]
fn wrong_positive_echo_config_revision_is_refused() {
    let mut harness = RuntimeHarness::new("recv-echo-cfg");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let acct = account(&harness.authority, &harness.grant);
    // Store bound to config revision 1.
    let mut store = SqliteChannelStore::new(&mut channel_connection, &principal_of(&harness), 1).unwrap();
    // Recording under a DIFFERENT still-positive config revision must fail.
    let err = store.record_echo(&principal_of(&harness), 2, "transport-echo-1").expect_err("wrong positive echo config must be refused");
    assert_eq!(err.code, "CHANNEL_AUTHENTICATION_FAILED");
    // A correct record works.
    store.record_echo(&principal_of(&harness), 1, "transport-echo-1").unwrap();
    drop(store);
    // Forge the row with a wrong-but-positive config revision + recomputed
    // outer hash: full verification must fail closed and never suppress.
    let echo_key = format!("{acct}\u{0}transport-echo-1");
    let row: (String, Vec<u8>) = channel_connection.query_row(
        "SELECT record_digest, canonical_jcs FROM channel_echo WHERE echo_key = ?1", [&echo_key],
        |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    let text = String::from_utf8(row.1).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
    value["config_revision"] = serde_json::json!(2);
    forge_echo_row(&channel_connection, &echo_key, &value.to_string());
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host, &harness.authority, &harness.grant).unwrap();
    let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "transport-echo-1", "echo"));
    assert!(matches!(outcome, IngressOutcome::SubmissionPending), "forged echo config must fail closed: {outcome:?}");
    drop(receiver);
    assert_eq!(harness.mapping_count(), 0, "zero Host premise");
    assert_eq!(harness.operation_count(), 0, "zero Core effect");
}

/// Hard-code a NONCANONICAL echo record: object keys in the wrong order, with
/// a recomputed outer digest. The receiver must fail closed with zero
/// suppression and zero Host/Core effect.
#[test]
fn noncanonical_echo_bytes_fail_closed_zero_effect() {
    let mut harness = RuntimeHarness::new("recv-echo-noncanonical");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let acct = account(&harness.authority, &harness.grant);
    {
        let mut store = SqliteChannelStore::new(&mut channel_connection, &principal_of(&harness), 1).unwrap();
        store.record_echo(&principal_of(&harness), 1, "transport-echo-1").unwrap();
    }
    let echo_key = format!("{acct}\u{0}transport-echo-1");
    // Deliberately noncanonical: keys emitted out of canonical order; a
    // recomputed outer digest keeps the hash self-consistent.
    let noncanonical = format!(
        r#"{{"echo_key":"{echo_key}","transport_event_id":"transport-echo-1","account":"{acct}","config_revision":1,"graph_digest":"g","graph_revision":1,"revision":1,"generation":1,"instance_id":"w","module_id":"receiver","extension_id":"org.dolly.channel","owner":"o","version":1,"schema":"dolly.channel-echo/v1"}}"#
    );
    forge_echo_row(&channel_connection, &echo_key, &noncanonical);
    let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host, &harness.authority, &harness.grant).unwrap();
    let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "transport-echo-1", "echo"));
    assert!(matches!(outcome, IngressOutcome::SubmissionPending), "noncanonical echo must fail closed, got {outcome:?}");
    drop(receiver);
    assert_eq!(harness.mapping_count(), 0, "zero Host premise");
    assert_eq!(harness.operation_count(), 0, "zero Core effect");
}

// --- Strict echo/intent canonical tests (receiver level) ---

/// A helper to forge the stored echo row with a recomputed outer hash.
fn forge_echo_row(connection: &rusqlite::Connection, echo_key: &str, text: &str) {
    let digest = dolly_canonical_json::Sha256Digest::compute(text.as_bytes()).to_canonical_string();
    connection.execute(
        "UPDATE channel_echo SET record_digest = ?1, canonical_jcs = ?2 WHERE echo_key = ?3",
        rusqlite::params![digest, text.as_bytes(), echo_key],
    ).unwrap();
}

#[test]
fn malformed_or_unknown_or_noncanonical_echo_fails_closed_zero_effect() {
    let mut harness = RuntimeHarness::new("recv-echo-strict");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let acct = account(&harness.authority, &harness.grant);
    let echo_key = format!("{acct}\u{0}transport-echo-1");
    // Seed a valid echo marker, then corrupt it in three distinct ways.
    {
        let mut store = SqliteChannelStore::new(&mut channel_connection, &principal_of(&harness), 1).unwrap();
        store.record_echo(&principal_of(&harness), 1, "transport-echo-1").unwrap();
    }
    // (a) noncanonical: rebuild the same record with object keys in a
    // noncanonical order and a recomputed outer hash.
    {
        let row: (String, Vec<u8>) = channel_connection.query_row(
            "SELECT record_digest, canonical_jcs FROM channel_echo WHERE echo_key = ?1", [&echo_key],
            |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        let text = String::from_utf8(row.1).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        // Re-serialize with default serde_json object order (insertion order):
        // build a fresh object with keys expressed out of canonical order.
        let mut map = serde_json::Map::new();
        for (k, v) in value.as_object().unwrap() { map.insert(k.clone(), v.clone()); }
        let noncanonical = serde_json::Value::Object(map);
        drop(noncanonical);
    }
    // Simpler deterministic corruption set:
    // (a) unknown field with recomputed hash.
    {
        let row: (String, Vec<u8>) = channel_connection.query_row(
            "SELECT record_digest, canonical_jcs FROM channel_echo WHERE echo_key = ?1", [&echo_key],
            |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        let text = String::from_utf8(row.1).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
        value.as_object_mut().unwrap().insert("forged".into(), serde_json::json!(1));
        forge_echo_row(&channel_connection, &echo_key, &value.to_string());
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        assert!(receiver.ledger().is_err(), "unknown-field echo must fail closed");
        drop(receiver);
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "transport-echo-1", "echo"));
        assert!(matches!(outcome, IngressOutcome::SubmissionPending), "corrupt echo store must fail closed, got {outcome:?}");
        drop(receiver);
        assert_eq!(harness.mapping_count(), 0, "zero Host premise while echo store corrupt");
        assert_eq!(harness.operation_count(), 0, "zero Core effect while echo store corrupt");
    }
    // (b) malformed/non-canonical bytes with a recomputed hash.
    {
        let malformed = r#"{"schema":"dolly.channel-echo/v1","version":1,"owner":"o","extension_id":"org.dolly.channel","module_id":"receiver","instance_id":"w","generation":1,"revision":1,"graph_revision":1,"graph_digest":"g","config_revision":1,"account":"a","transport_event_id":"transport-echo-1","echo_key":"k"}"#;
        forge_echo_row(&channel_connection, &echo_key, malformed);
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "transport-echo-1", "echo"));
        assert!(matches!(outcome, IngressOutcome::SubmissionPending), "malformed echo store must fail closed, got {outcome:?}");
        drop(receiver);
        assert_eq!(harness.mapping_count(), 0);
        assert_eq!(harness.operation_count(), 0);
    }
}

// --- Submit-path status-first issuance: coherent mutation refused, then B
//     authoritative mapping adopted by reconcile ---

#[test]
fn coherent_submit_identity_mutation_is_refused_then_authoritative_adopted() {
    let mut harness = RuntimeHarness::new("recv-submit-id");
    let dir = tempdir().unwrap();
    let (mut channel_connection, _path) = channel_store_connection(dir.path());
    let acct = account(&harness.authority, &harness.grant);
    // Phase A: baseline accepts capture the real authoritative mappings for
    // two keys and bind the store.
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            host, &harness.authority, &harness.grant).unwrap();
        assert!(matches!(receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-S1", "X")), IngressOutcome::Committed { .. }));
        assert!(matches!(receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-S2", "Y")), IngressOutcome::Committed { .. }));
        drop(receiver);
        assert_eq!(harness.mapping_count(), 2);
    }
    // Phase B: delete both Channel rows so each key re-ingests (fresh intent
    // with the SAME content as its authoritative mapping).
    for (msg, content) in [("msg-S1", "X"), ("msg-S2", "Y")] {
        let key = dolly_channel::ids::inbound_ingress_key(&acct, msg);
        channel_connection.execute("DELETE FROM channel_intent WHERE intent_key = ?1", [&key]).unwrap();
        let real = real_mapping_for(&mut harness, msg);
        let mut crafted = real.clone();
        if msg == "msg-S1" {
            // Coherent ingress+command mutation: new minted-looking ingress id
            // and a matching command_id — shape is internally consistent, so
            // only the status-first byte-equality confirmation can catch it.
            crafted.ingress_id = "0198ab31-6c44-7e8a-b2bb-ffffffffffff".into();
            crafted.command_id = format!("host-ingress-{}-{}", crafted.ingress_key, crafted.ingress_id);
        } else {
            // Arbitrary block id in the submit result.
            crafted.block_id = "0198ab31-6c44-7e8a-b2bb-00000000beef".into();
        }
        let host = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let override_host = MappingOverrideHost::new(host)
            .with_submit_override(dolly_core_domain::HostIngressSubmitOutcome::Committed { mapping: Box::new(crafted), idempotent: false })
            .with_status_override(dolly_core_domain::HostIngressStatus::Committed(Box::new(real)));
        let mut receiver = InboundReceiver::new(
            channel_config(), Box::new(channel_clock()), &mut channel_connection,
            override_host, &harness.authority, &harness.grant).unwrap();
        let outcome = receiver.ingest_event(&sealed_event(&harness.authority, &harness.grant, "conv-1", msg, content));
        assert!(
            !matches!(outcome, IngressOutcome::Committed { .. } | IngressOutcome::IdempotentReplay { .. }),
            "submit identity mutation for {msg} must be refused on Prepared: {outcome:?}"
        );
        drop(receiver);
    }
    // Phase C: reconcile (no redelivery) adopts each B-authoritative mapping
    // once, exactly.
    let host3 = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver3 = InboundReceiver::new(
        channel_config(), Box::new(channel_clock()), &mut channel_connection,
        host3, &harness.authority, &harness.grant).unwrap();
    assert_eq!(receiver3.reconcile().unwrap(), 0, "reconcile adopts the authoritative mappings");
    drop(receiver3);
    assert_eq!(harness.mapping_count(), 2, "exactly the two authoritative mappings");
    assert_eq!(harness.operation_count(), 2, "exactly two Core effects");
}
