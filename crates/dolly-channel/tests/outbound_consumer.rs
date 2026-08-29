//! Seam D focused evidence: the committed targeted-Action outbound consumer
//! over the real Core journal + real module-scoped SQLite Channel store, the
//! bounded caller-deadline queue, deterministic fake transport/clock, and
//! store failpoints. Compiled only under the non-default `test-support`
//! feature.
//!
//! Proves: pre-effect durability, committed-Action verification (never
//! caller-shaped), exactly-once/idempotency/conflict, queue bound + caller
//! deadline expiry + slot release, crash at every ledger/dispatch/result/
//! echo transition, status-first reconciliation (never blind resend, never
//! false success), exact result envelope, durable echo markers, redaction,
//! and zero reverse/echo/premise leakage. The module has exactly one store
//! writer (one module-scoped SQLite connection), so concurrent duplicate
//! dispatch is serialized at the durable Prepared/dispatch-marker CAS and
//! replays always return the stored result with zero re-dispatch.

#![cfg(feature = "test-support")]

mod common;

use common::g4::*;
use dolly_channel::{
    ChannelConfigBuilder, ChannelPrincipal, InboundReceiver, IngressOutcome, OutboundConsumer,
    OutboundState, SnapshotCommittedActionSource, SqliteChannelStore, create_channel_store_schema,
    timestamp_plus_seconds,
};
use dolly_channel::error::codes;
use dolly_channel::transport::{
    ChannelTransport, TransportSendRequest, TransportSendResult, TransportPieceOutcome,
};
use dolly_core_reducer::{CoreCommand, EnvironmentInput, IngressCommand, TransitionOutcome};
use dolly_storage::{SqliteCoreStore, SqliteHostIngressStore};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;

/// A deterministic shared transport: the consumer owns a boxed copy while the
/// test drives the script and inspects recorded calls through the Arc.
#[derive(Clone)]
struct SharedTransport {
    idempotent: bool,
    inner: std::sync::Arc<std::sync::Mutex<SharedInner>>,
}

#[derive(Default)]
struct SharedInner {
    script: Vec<TransportSendResult>,
    calls: Vec<TransportSendRequest>,
    status_script: Vec<(String, dolly_channel::transport::TransportStatusResult)>,
}

impl SharedTransport {
    fn new(idempotent: bool) -> Self {
        Self {
            idempotent,
            inner: std::sync::Arc::new(std::sync::Mutex::new(SharedInner::default())),
        }
    }
    fn push(&self, result: TransportSendResult) {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .script
            .push(result);
    }
    fn calls(&self) -> Vec<TransportSendRequest> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .calls
            .clone()
    }

    fn push_status(&self, action_id: &str, result: dolly_channel::transport::TransportStatusResult) {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .status_script
            .push((action_id.to_string(), result));
    }
}

impl ChannelTransport for SharedTransport {
    fn idempotency_supported(&self) -> bool {
        self.idempotent
    }
    fn send(&mut self, request: &TransportSendRequest) -> TransportSendResult {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        inner.calls.push(request.clone());
        if inner.script.is_empty() {
            return TransportSendResult::Timeout;
        }
        inner.script.remove(0)
    }
    fn status(&mut self, request: &dolly_channel::transport::TransportStatusRequest) -> dolly_channel::transport::TransportStatusResult {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let pos = inner
            .status_script
            .iter()
            .position(|(id, _)| id == &request.action_id);
        match pos {
            Some(idx) => inner.status_script.remove(idx).1,
            None => dolly_channel::transport::TransportStatusResult::Unknown,
        }
    }
}

/// A committed send Block targeted at `module_id` with the accepted action
/// contract shape.
fn send_block_for(module_id: &str, action_id: &str, session_id: &str, texts: &[&str]) -> Value {
    let parts: Vec<Value> = texts
        .iter()
        .map(|t| json!({"kind": "text", "text": t, "format": "plain"}))
        .collect();
    json!({
        "schema": "dolly.block/v1",
        "id": format!("block-{action_id}"),
        "body": {
            "description": "model response",
            "parts": parts.clone(),
            "actions": [{
                "action_id": action_id,
                "name": "org.dolly.channel.send",
                "target": {"module_id": module_id},
                "arguments": {
                    "session_id": session_id,
                    "parts": parts,
                    "reply_to_external_message_id": null
                },
                "contract_binding": {
                    "module_id": module_id,
                    "descriptor_revision": 1,
                    "action_contract_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                    "action_contract": {
                        "name": "org.dolly.channel.send",
                        "arguments_schema": {
                            "uri": "https://dolly.example/spec/0.1/schemas/channel-send.schema.json",
                            "schema_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                            "semantic_validator": null
                        },
                        "result_schema": {
                            "uri": "https://dolly.example/spec/0.1/schemas/channel-send-result.schema.json",
                            "schema_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                            "semantic_validator": {
                                "id": "org.dolly.validator.channel-send-result",
                                "revision": 1
                            }
                        },
                        "description": "send a message",
                        "side_effect_class": "idempotent_write"
                    }
                }
            }]
        }
    })
}

/// Commit a Block into the real Core operation/journal (the authoritative
/// committed-Action source the consumer reads).
fn commit_block(
    connection: &mut Connection,
    mark: &str,
    key: &str,
    block_id: &str,
    block: Value,
    pages: Vec<String>,
) {
    let operation_digest = dolly_canonical_json::canonicalize(&block)
        .unwrap()
        .1
        .to_canonical_string();
    let mut store = SqliteCoreStore::new(connection).expect("core schema");
    let transition = store
        .transact(
            &CoreCommand::Ingress(IngressCommand {
                command_id: format!("{mark}-{key}"),
                runtime_source: "model/web-channel".to_string(),
                ingress_key: key.to_string(),
                operation_digest,
                block_id: block_id.to_string(),
                block,
                pages,
            }),
            &EnvironmentInput {
                now: CHANNEL_NOW.into(),
                ..Default::default()
            },
        )
        .expect("ingress transaction must execute");
    assert_eq!(
        transition.outcome,
        TransitionOutcome::Committed,
        "committed send block must commit"
    );
}

struct Fixture {
    harness: RuntimeHarness,
    _dir: TempDir,
    module_path: std::path::PathBuf,
    account: String,
    session: String,
    principal: ChannelPrincipal,
}

/// Real harness (Core DB, Host authority/grant), a real module-scoped Channel
/// store FILE, and a real committed inbound premise so the session is
/// account-owned and restores from the durable intent's projection.
fn setup(mark: &str) -> Fixture {
    let mut harness = RuntimeHarness::new(mark);
    let dir = TempDir::new().expect("temp dir");
    let module_path = dir.path().join("channel.sqlite3");
    let mut module_conn = Connection::open(&module_path).expect("module store");
    create_channel_store_schema(&mut module_conn).expect("module store schema");
    {
        let host = SqliteHostIngressStore::new(&mut harness.connection).expect("host ingress");
        let mut receiver = InboundReceiver::new(
            channel_config(),
            Box::new(channel_clock()),
            &mut module_conn,
            host,
            &harness.authority,
            &harness.grant,
        )
        .expect("receiver registration");
        let outcome = receiver.ingest_event(&sealed_event(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "in-1",
            "hello",
        ));
        assert!(
            matches!(outcome, IngressOutcome::Committed { .. }),
            "upstream premise commits: {outcome:?}"
        );
    }
    let account = account(&harness.authority, &harness.grant);
    let principal = ChannelPrincipal::from_authority_grant(&harness.authority, &harness.grant)
        .expect("principal");
    // The accepted CreateOnFirstMessage policy derives the session
    // deterministically; the durable-premise projection restores the same id.
    let session = dolly_channel::ids::dolly_session_id(&account, "conv-1");
    drop(module_conn);
    Fixture {
        harness,
        _dir: dir,
        module_path,
        account,
        session,
        principal,
    }
}

/// Open the module store over the fixture's SQLite file.
fn reopen_module_store(fixture: &Fixture) -> Connection {
    Connection::open(&fixture.module_path).expect("module store reopen")
}

fn far_deadline() -> String {
    timestamp_plus_seconds(CHANNEL_NOW, 60)
}

/// One consume pass over a committed send with a fresh shared transport.
fn consume_one(
    fixture: &mut Fixture,
    transport: &SharedTransport,
) -> (Connection, dolly_channel::ConsumerOutcome) {
    let mut module_conn = reopen_module_store(fixture);
    let source = SnapshotCommittedActionSource::new(&mut fixture.harness.connection)
        .expect("committed-action source over the real Core journal");
    let mut consumer = OutboundConsumer::new(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        source,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer registration");
    let outcomes = consumer.consume(&far_deadline()).expect("consume");
    assert_eq!(outcomes.len(), 1, "one committed send processed");
    let outcome = outcomes.into_iter().next().expect("one outcome");
    drop(consumer);
    (module_conn, outcome)
}

#[test]
fn committed_send_consumes_durably_with_exact_result_and_echo() {
    let mut fixture = setup("consumer-basic");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000801";
    commit_block(
        &mut fixture.harness.connection,
        "consumer-basic",
        "ing-1",
        &format!("{action_id}-block"),
        send_block_for(MODULE_ID, action_id, &fixture.session, &["It will be sunny."]),
        vec!["page-a".to_string()],
    );
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-reply-1".to_string()],
    });
    let (mut module_conn, outcome) = consume_one(&mut fixture, &transport);
    let (state, result_jcs) = match outcome {
        dolly_channel::ConsumerOutcome::Terminal {
            state, result_jcs, ..
        } => (state, result_jcs),
        other => panic!("expected Terminal, got {other:?}"),
    };
    assert_eq!(state, OutboundState::Confirmed);
    // Exact frozen ActionResult envelope.
    let envelope: Value = serde_json::from_str(&result_jcs).unwrap();
    assert_eq!(envelope["schema"], "dolly.action-result/v1");
    assert_eq!(envelope["action_id"], action_id);
    assert_eq!(envelope["status"], "succeeded");
    assert_eq!(envelope["error"], Value::Null);
    let send_result: dolly_canonical_json::CanonicalJsonValue =
        dolly_canonical_json::CanonicalJsonValue::try_from(envelope["result"].clone()).unwrap();
    assert!(dolly_channel::validate_send_result(&send_result).is_ok());
    assert_eq!(transport.calls().len(), 1, "exactly one transport call");

    // Durable echo marker (reopen the store): the confirmed transport ID is
    // an echo-suppression fact in the same Channel DB.
    let mut reopened = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
    assert!(reopened
        .is_echo(&fixture.account, "transport-reply-1")
        .expect("echo check"));
    // Durable terminal row with the frozen result.
    let record = reopened.find_outbound(action_id).unwrap().expect("durable row");
    assert_eq!(record.entry.state, OutboundState::Confirmed);
    assert_eq!(record.entry.result_jcs.as_deref(), Some(result_jcs.as_str()));
    drop(reopened);

    // Same committed Action re-consumed: replay returns the exact stored
    // result with ZERO duplicate transport.
    let transport2 = SharedTransport::new(true);
    let (_, replayed) = consume_one(&mut fixture, &transport2);
    match replayed {
        dolly_channel::ConsumerOutcome::Terminal {
            result_jcs: replayed_jcs,
            state,
            ..
        } => {
            assert_eq!(state, OutboundState::Confirmed);
            assert_eq!(replayed_jcs, result_jcs, "replay returns the existing result");
        }
        other => panic!("expected terminal replay, got {other:?}"),
    }
    assert_eq!(transport2.calls().len(), 0, "zero re-dispatch on replay");
}

#[test]
fn pre_admission_durability_failure_yields_zero_effect() {
    let mut fixture = setup("consumer-write-fail");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000802";
    commit_block(
        &mut fixture.harness.connection,
        "consumer-write-fail",
        "ing-1",
        &format!("{action_id}-block"),
        send_block_for(MODULE_ID, action_id, &fixture.session, &["Hello."]),
        vec!["page-a".to_string()],
    );
    let transport = SharedTransport::new(true);
    {
        let mut module_conn = reopen_module_store(&fixture);
        let mut store = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
        store.inject_write_prepared_outbound_failure(1);
        let source = SnapshotCommittedActionSource::new(&mut fixture.harness.connection)
            .expect("committed-action source");
        let mut consumer = OutboundConsumer::new_with_store(
            channel_config(),
            Box::new(channel_clock()),
            store,
            source,
            Box::new(transport.clone()),
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .expect("consumer with store");
        // The durable Prepared write fails: consume errors and nothing was
        // enqueued or transported.
        assert!(consumer.consume(&far_deadline()).is_err());
        drop(consumer);
        drop(module_conn);
    }
    assert_eq!(transport.calls().len(), 0, "zero transport call");
    let mut module_conn = reopen_module_store(&fixture);
    let mut reopened = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
    assert!(
        reopened.find_outbound(action_id).unwrap().is_none(),
        "no durable row after a failed pre-admission write"
    );
    assert!(reopened.list_pending_outbound().unwrap().is_empty());
}

#[test]
fn wrong_target_foreign_owner_and_unowned_session_are_rejected_with_zero_effect() {
    let mut fixture = setup("consumer-reject");

    let other = send_block_for(
        "receiver-other",
        "0198ab31-6c44-7e8a-b2bb-000000000803",
        &fixture.session,
        &["Hi"],
    );
    commit_block(
        &mut fixture.harness.connection,
        "consumer-reject",
        "ing-other",
        "block-other",
        other,
        vec!["page-a".to_string()],
    );
    let mut foreign = send_block_for(
        MODULE_ID,
        "0198ab31-6c44-7e8a-b2bb-000000000804",
        &fixture.session,
        &["Hi"],
    );
    foreign["body"]["actions"][0]["name"] = json!("org.dolly.other.something");
    commit_block(
        &mut fixture.harness.connection,
        "consumer-reject",
        "ing-foreign",
        "block-foreign",
        foreign,
        vec!["page-a".to_string()],
    );
    let unowned = send_block_for(
        MODULE_ID,
        "0198ab31-6c44-7e8a-b2bb-000000000805",
        "session-not-owned",
        &["Hi"],
    );
    commit_block(
        &mut fixture.harness.connection,
        "consumer-reject",
        "ing-unowned",
        "block-unowned",
        unowned,
        vec!["page-a".to_string()],
    );

    let transport = SharedTransport::new(true);
    let mut module_conn = reopen_module_store(&fixture);
    let source = SnapshotCommittedActionSource::new(&mut fixture.harness.connection).unwrap();
    let mut consumer = OutboundConsumer::new(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        source,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes = consumer.consume(&far_deadline()).expect("consume");
    // The foreign-owner block is not a channel send Action (the cheap filter
    // skips it: zero leakage), so the non-targeted and unowned-session send
    // Actions are the only outcomes.
    assert_eq!(outcomes.len(), 2, "the two real channel send Actions processed");
    for outcome in &outcomes {
        match outcome {
            dolly_channel::ConsumerOutcome::Rejected { error, .. } => {
                assert!(
                    error.code == codes::AUTHORIZATION_FAILED
                        || error.code == codes::SESSION_MISSING,
                    "unexpected rejection code: {}",
                    error.code
                );
            }
            other => panic!("expected deterministic rejection, got {other:?}"),
        }
    }
    assert_eq!(transport.calls().len(), 0, "zero transport for rejected actions");
    drop(consumer);
    let mut reopened = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
    assert!(reopened.list_pending_outbound().unwrap().is_empty(), "no durable outbound rows");
}

#[test]
fn same_key_different_content_conflicts_before_enqueue() {
    let mut fixture = setup("consumer-conflict");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000806";
    commit_block(
        &mut fixture.harness.connection,
        "consumer-conflict",
        "ing-a",
        &format!("{action_id}-block-a"),
        send_block_for(MODULE_ID, action_id, &fixture.session, &["Hello."]),
        vec!["page-a".to_string()],
    );
    commit_block(
        &mut fixture.harness.connection,
        "consumer-conflict",
        "ing-b",
        &format!("{action_id}-block-b"),
        send_block_for(MODULE_ID, action_id, &fixture.session, &["Different."]),
        vec!["page-a".to_string()],
    );
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-conflict".to_string()],
    });
    let mut module_conn = reopen_module_store(&fixture);
    let source = SnapshotCommittedActionSource::new(&mut fixture.harness.connection).unwrap();
    let mut consumer = OutboundConsumer::new(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        source,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes = consumer.consume(&far_deadline()).expect("consume");
    assert_eq!(outcomes.len(), 2);
    let mut terminal = 0;
    let mut rejected = 0;
    for outcome in &outcomes {
        match outcome {
            dolly_channel::ConsumerOutcome::Terminal { .. } => terminal += 1,
            dolly_channel::ConsumerOutcome::Rejected { error, .. } => {
                assert_eq!(error.code, codes::OPERATION_CONFLICT);
                rejected += 1;
            }
            other => panic!("expected terminal or conflict, got {other:?}"),
        }
    }
    assert_eq!(terminal, 1);
    assert_eq!(rejected, 1);
    assert_eq!(transport.calls().len(), 1, "only the winning action reached the transport");
    drop(consumer);
    let mut reopened = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
    let record = reopened.find_outbound(action_id).unwrap().expect("durable row");
    assert_eq!(
        record.entry.pieces[0].text, "Hello.",
        "the durable row keeps the first content; the conflict changed nothing"
    );
}

#[test]
fn bounded_queue_waits_then_expires_and_releases_no_slot() {
    let mut fixture = setup("consumer-backpressure");
    let config = ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1)
        .target_pages(&["page-a"])
        .max_pending_per_session(1)
        .build();
    let a1 = "0198ab31-6c44-7e8a-b2bb-000000000807";
    let a2 = "0198ab31-6c44-7e8a-b2bb-000000000808";
    commit_block(
        &mut fixture.harness.connection,
        "consumer-backpressure",
        "ing-1",
        &format!("{a1}-block"),
        send_block_for(MODULE_ID, a1, &fixture.session, &["one"]),
        vec!["page-a".to_string()],
    );
    commit_block(
        &mut fixture.harness.connection,
        "consumer-backpressure",
        "ing-2",
        &format!("{a2}-block"),
        send_block_for(MODULE_ID, a2, &fixture.session, &["two"]),
        vec!["page-a".to_string()],
    );
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::Timeout); // a1 stays dispatched-pending
    {
        // a1's slot is held across the pass (dispatched-pending), so when a2
        // is admitted the session queue is FULL: with an ALREADY-PASSED
        // caller deadline it backpressures with zero transport call and no
        // additional slot leak.
        let mut module_conn = reopen_module_store(&fixture);
        let source = SnapshotCommittedActionSource::new(&mut fixture.harness.connection).unwrap();
        let mut consumer = OutboundConsumer::new(
            config,
            Box::new(channel_clock()),
            &mut module_conn,
            source,
            Box::new(transport.clone()),
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .expect("consumer");
        let outcomes = consumer
            .consume(&timestamp_plus_seconds(CHANNEL_NOW, -1))
            .expect("consume");
        let mut pending = 0;
        let mut backpressure = 0;
        for outcome in &outcomes {
            match outcome {
                dolly_channel::ConsumerOutcome::Pending { .. } => pending += 1,
                dolly_channel::ConsumerOutcome::Rejected { error, .. } => {
                    assert_eq!(error.code, codes::RATE_LIMITED);
                    assert!(error.retryable);
                    backpressure += 1;
                }
                other => panic!("expected pending or backpressure, got {other:?}"),
            }
        }
        assert_eq!(pending, 1, "a1 stays dispatched-pending and holds its slot");
        assert_eq!(backpressure, 1, "a2 backpressured at the expired deadline");
        assert_eq!(transport.calls().len(), 1, "only the granted slot dispatched");
        assert_eq!(
            consumer
                .queue()
                .inflight(&format!("{}\u{0}{}", fixture.account, fixture.session)),
            1,
            "exactly the one held slot; a2's failed admission leaked nothing"
        );
        drop(consumer);
    }
    // The deadline-expired action was NOT transported and remains durable
    // Prepared; a later pass with a fresh deadline dispatches it exactly once
    // (a1 stays dispatched-pending with no resend).
    let transport2 = SharedTransport::new(true);
    transport2.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-bp-2".to_string()],
    });
    let mut module_conn = reopen_module_store(&fixture);
    let source2 = SnapshotCommittedActionSource::new(&mut fixture.harness.connection).unwrap();
    let mut consumer2 = OutboundConsumer::new(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        source2,
        Box::new(transport2.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes2 = consumer2.consume(&far_deadline()).expect("consume");
    assert_eq!(outcomes2.len(), 2, "a1 (pending) + a2 (dispatched now)");
    let mut terminal_a2 = false;
    for outcome in &outcomes2 {
        match outcome {
            dolly_channel::ConsumerOutcome::Terminal { action_id, .. } => {
                assert_eq!(action_id, a2, "the backpressured action dispatches later");
                terminal_a2 = true;
            }
            dolly_channel::ConsumerOutcome::Pending { .. } => {}
            other => panic!("unexpected outcome {other:?}"),
        }
    }
    assert!(terminal_a2, "a2 reached terminal");
    assert_eq!(transport2.calls().len(), 1);
}

#[test]
fn crash_after_prepared_before_dispatch_redispatch_and_never_duplicates() {
    let mut fixture = setup("consumer-crash-prepared");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000809";
    commit_block(
        &mut fixture.harness.connection,
        "consumer-crash-prepared",
        "ing-1",
        &format!("{action_id}-block"),
        send_block_for(MODULE_ID, action_id, &fixture.session, &["Hello."]),
        vec!["page-a".to_string()],
    );
    let transport = SharedTransport::new(false); // no idempotency: pre-send CAS
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-after-prepare".to_string()],
    });
    {
        // Phase A: the durable Pre-Send dispatch-marker write fails (crash
        // after the durable Prepared row, before the transport). No transport
        // call; the durable row stays Prepared.
        let mut module_conn = reopen_module_store(&fixture);
        let mut store = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
        store.inject_mark_dispatched_failure(1);
        let source = SnapshotCommittedActionSource::new(&mut fixture.harness.connection)
            .expect("committed-action source");
        let mut consumer = OutboundConsumer::new_with_store(
            channel_config(),
            Box::new(channel_clock()),
            store,
            source,
            Box::new(transport.clone()),
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .expect("consumer with store");
        assert!(consumer.consume(&far_deadline()).is_err());
        drop(consumer);
        drop(module_conn);
    }
    assert_eq!(transport.calls().len(), 0, "no transport before the dispatched marker");
    // Phase B: restart. The durable Prepared row was NEVER dispatched, so the
    // consumer safely dispatches it exactly once.
    let (_, outcome) = consume_one(&mut fixture, &transport);
    match outcome {
        dolly_channel::ConsumerOutcome::Terminal { state, .. } => {
            assert_eq!(state, OutboundState::Confirmed)
        }
        other => panic!("expected terminal after restart, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 1, "exactly one dispatch after restart");
}

#[test]
fn crash_after_dispatch_marker_never_blind_resends_and_reconciles_status_first() {
    let mut fixture = setup("consumer-crash-dispatched");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000810";
    commit_block(
        &mut fixture.harness.connection,
        "consumer-crash-dispatched",
        "ing-1",
        &format!("{action_id}-block"),
        send_block_for(MODULE_ID, action_id, &fixture.session, &["Hello."]),
        vec!["page-a".to_string()],
    );
    let transport = SharedTransport::new(false); // no idempotency support
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-result-crash".to_string()],
    });
    {
        // Phase A: the durable dispatched marker (before send) succeeds and
        // the send is confirmed, but the terminal commit failpoint fires
        // after the transport call — a crash at the result transition.
        let mut module_conn = reopen_module_store(&fixture);
        let mut store = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
        store.inject_commit_outbound_terminal_failure(1);
        let source = SnapshotCommittedActionSource::new(&mut fixture.harness.connection)
            .expect("committed-action source");
        let mut consumer = OutboundConsumer::new_with_store(
            channel_config(),
            Box::new(channel_clock()),
            store,
            source,
            Box::new(transport.clone()),
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .expect("consumer with store");
        assert!(consumer.consume(&far_deadline()).is_err());
        drop(consumer);
        drop(module_conn);
    }
    assert_eq!(transport.calls().len(), 1, "the transport was called once");
    // Phase B: restart. The durable row is Dispatched: it MUST NOT be
    // re-dispatched (no blind resend) and MUST NOT be reported success.
    let mut module_conn = reopen_module_store(&fixture);
    let source = SnapshotCommittedActionSource::new(&mut fixture.harness.connection).unwrap();
    let mut consumer2 = OutboundConsumer::new(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        source,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes = consumer2.consume(&far_deadline()).expect("consume");
    match &outcomes[0] {
        dolly_channel::ConsumerOutcome::Pending { action_id: id } => {
            assert_eq!(id, action_id, "dispatched row stays pending, never resent")
        }
        other => panic!("expected Pending (dispatched, unresolved), got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 1, "no blind resend of a dispatched send");

    // Phase C: status-first recovery. The transport confirmed the send in
    // Phase A (AllConfirmed); the terminal commit failed (crash), leaving
    // the row Dispatched. Reconcile queries transport.status() and the
    // transport reports Confirmed — the row settles to Confirmed (never
    // blind-resent, never age-guessed to unknown).
    transport.push_status(
        action_id,
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec!["m-result-crash".to_string()],
        },
    );
    {
        let source = SnapshotCommittedActionSource::new(&mut fixture.harness.connection).unwrap();
        let mut consumer3 = OutboundConsumer::new(
            channel_config(),
            Box::new(channel_clock()),
            &mut module_conn,
            source,
            Box::new(transport.clone()),
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .expect("consumer");
        let remaining = consumer3.reconcile().expect("reconcile");
        assert_eq!(remaining, 0, "status-first reconcile converged");
        let ledger = consumer3.ledger().unwrap();
        let entry = ledger.outbound_entry(action_id).expect("durable row");
        assert_eq!(entry.state, OutboundState::Confirmed, "status-first settle to Confirmed");
        let envelope: Value = serde_json::from_str(entry.result_jcs.as_deref().unwrap()).unwrap();
        assert_eq!(envelope["status"], "succeeded");
    }
    assert_eq!(transport.calls().len(), 1, "recovery never re-dispatches");
}

#[test]
fn partial_outcome_is_exact_and_non_retryable_with_durable_echo() {
    let mut fixture = setup("consumer-partial");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000811";
    commit_block(
        &mut fixture.harness.connection,
        "consumer-partial",
        "ing-1",
        &format!("{action_id}-block"),
        send_block_for(MODULE_ID, action_id, &fixture.session, &["part one", "part two"]),
        vec!["page-a".to_string()],
    );
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::PerPiece {
        pieces: vec![
            TransportPieceOutcome::Confirmed {
                ordinal: 0,
                message_id: "mid-partial".to_string(),
            },
            TransportPieceOutcome::Rejected {
                ordinal: 1,
                code: "REMOTE_REFUSED".to_string(),
            },
        ],
    });
    let (mut module_conn, outcome) = consume_one(&mut fixture, &transport);
    let result_jcs = match outcome {
        dolly_channel::ConsumerOutcome::Terminal {
            state, result_jcs, ..
        } => {
            assert_eq!(state, OutboundState::Partial);
            result_jcs
        }
        other => panic!("expected terminal partial, got {other:?}"),
    };
    let envelope: Value = serde_json::from_str(&result_jcs).unwrap();
    assert_eq!(envelope["status"], "failed");
    assert_eq!(envelope["result"], Value::Null);
    assert_eq!(envelope["error"]["code"], "CHANNEL_PARTIAL_DELIVERY");
    assert_eq!(envelope["error"]["retryable"], false);
    assert_eq!(envelope["error"]["outcome"], "applied");
    assert_eq!(envelope["error"]["details"]["confirmed_ordinals"], json!([0]));
    assert_eq!(envelope["error"]["details"]["failed_ordinals"], json!([1]));
    // Confirmed piece id became a durable echo fact atomically.
    let mut reopened = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
    assert!(reopened.is_echo(&fixture.account, "mid-partial").unwrap());
    // Redaction: neither the result nor the echo path carries message text.
    assert!(!result_jcs.contains("part one"), "result envelope carries no message text");
    drop(reopened);
}

#[test]
fn zero_reverse_echo_or_premise_leakage() {
    let mut fixture = setup("consumer-leak");
    // Only the committed INBOUND premise (no send Action) exists in Core.
    let transport = SharedTransport::new(true);
    let mut module_conn = reopen_module_store(&fixture);
    let source = SnapshotCommittedActionSource::new(&mut fixture.harness.connection).unwrap();
    let mut consumer = OutboundConsumer::new(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        source,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes = consumer.consume(&far_deadline()).expect("consume");
    assert!(outcomes.is_empty(), "no committed send Action, no outcome");
    assert_eq!(consumer.ledger().unwrap().outbound.len(), 0);
    assert_eq!(transport.calls().len(), 0);
    assert_eq!(consumer.queue().total_inflight(), 0, "queue untouched");
    drop(consumer);
}
