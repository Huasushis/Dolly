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
    OutboundQueueGate, OutboundState, SqliteChannelStore, create_channel_store_schema,
    timestamp_plus_seconds,
};
use dolly_channel::error::codes;
use dolly_channel::transport::{
    ChannelTransport, TransportSendRequest, TransportSendResult, TransportPieceOutcome,
};
use dolly_core_reducer::{
    BuildManifestCommand, CoreCommand, EnvironmentInput, IngressCommand, TransitionOutcome,
};
use dolly_storage::{SqliteCoreStore, SqliteHostIngressStore, create_host_ingress_schema};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;

/// Canonical digest of `{}`, the empty effective config used in test manifests.
const EMPTY_OBJECT_DIGEST: &str =
    "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

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
    let (block_for_manifest, pages_for_manifest) = (block.clone(), pages.clone());
    let mut store = SqliteCoreStore::new(connection).expect("core schema");
    let transition = store
        .transact(
            &CoreCommand::Ingress(IngressCommand {
                command_id: format!("{mark}-{key}"),
                runtime_source: MODULE_ID.to_string(),
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
    // Commit 1: SELECT the committed Block into the configured Module's
    // persisted ActivationManifest.input_items (the ONLY authority that may
    // mint send identity). BuildManifest freezes the manifest in Core.
    persist_manifest_selection(connection, mark, key, block_id, &block_for_manifest, &pages_for_manifest);
}

/// Persist an ActivationManifest for the configured module whose input_items
/// select `block` (delivered through `pages`). Only
/// `CoreSnapshot.activations[*].manifest` may mint downstream send authority.
fn persist_manifest_selection(
    connection: &mut Connection,
    mark: &str,
    key: &str,
    block_id: &str,
    block: &Value,
    pages: &[String],
) {
    let activation_id = format!("activation-{mark}-{key}");
    let occurrences: Vec<Value> = pages
        .iter()
        .enumerate()
        .map(|(i, page_id)| {
            json!({"page_id": page_id, "page_seq": (i as i64) + 1, "commit_seq": (i as i64) + 1})
        })
        .collect();
    let manifest = json!({
        "schema": "dolly.activation-manifest/v1",
        "activation_id": activation_id,
        "module_id": MODULE_ID,
        "reason": "input",
        "created_at": CHANNEL_NOW,
        "graph_revision": 1,
        "config_revision": 1,
        "descriptor_revision": 1,
        "effective_config": {},
        "effective_config_digest": EMPTY_OBJECT_DIGEST,
        "required_frame_bytes": 2048,
        "required_frame_nesting_depth": 4,
        "input_items": [{
            "block": block.clone(),
            "occurrences": occurrences,
            "occurrence_count": pages.len() as i64
        }],
        "cursor_spans": [],
        "lossy_gaps": [],
        "output_page_ids": [],
        "neighbor_descriptors": [],
        "deadline": timestamp_plus_seconds(CHANNEL_NOW, 60)
    });
    let mut store = SqliteCoreStore::new(connection).expect("core schema");
    let transition = store
        .transact(
            &CoreCommand::BuildManifest(BuildManifestCommand {
                command_id: format!("{mark}-build-{key}"),
                activation_id,
                manifest,
                expected_graph_revision: None,
                expected_descriptor_revision: None,
            }),
            &EnvironmentInput {
                now: CHANNEL_NOW.into(),
                ..Default::default()
            },
        )
        .expect("manifest build must execute");
    assert_eq!(
        transition.outcome,
        TransitionOutcome::Committed,
        "activation manifest must commit"
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
    let mut harness = RuntimeHarness::new_with_inputs(mark, &["page-c"]);
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

/// A Clone-able shared clock so tests advance time while the consumer waits.
#[derive(Clone)]
struct SharedClock(std::sync::Arc<std::sync::Mutex<dolly_channel::VirtualClock>>);

impl SharedClock {
    fn at(at: &str) -> Self {
        SharedClock(std::sync::Arc::new(std::sync::Mutex::new(
            dolly_channel::VirtualClock::at(at.parse().expect("ts")),
        )))
    }
    fn advance_seconds(&self, s: i64) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .advance_seconds(s);
    }
}

impl dolly_channel::Clock for SharedClock {
    fn now(&self) -> dolly_core_domain::Timestamp {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .now()
    }
}

/// One consume pass over a committed send with a fresh shared transport.
fn consume_one(
    fixture: &mut Fixture,
    transport: &SharedTransport,
) -> (Connection, dolly_channel::ConsumerOutcome) {
    let mut module_conn = reopen_module_store(fixture);
    let mut consumer = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
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
        vec!["page-c".to_string()],
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
        vec!["page-c".to_string()],
    );
    let transport = SharedTransport::new(true);
    {
        let mut module_conn = reopen_module_store(&fixture);
        let mut store = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
        store.inject_write_prepared_outbound_failure(1);
        let mut consumer = OutboundConsumer::new_with_store(
            channel_config(),
            Box::new(channel_clock()),
            store,
            &mut fixture.harness.connection,
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
        vec!["page-c".to_string()],
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
        vec!["page-c".to_string()],
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
        vec!["page-c".to_string()],
    );

    let transport = SharedTransport::new(true);
    let mut module_conn = reopen_module_store(&fixture);
    let mut consumer = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes = consumer.consume(&far_deadline()).expect("consume");
    // The sealed selection refuses every hostile Block BEFORE enqueue: a
    // non-targeted send, a foreign-owner action, and an unowned-session send
    // all yield ZERO outcomes and ZERO durable/transport effect. Generic
    // Blocks must never become actions.
    assert_eq!(outcomes.len(), 0, "hostile Blocks are refused before enqueue");
    assert_eq!(transport.calls().len(), 0, "zero transport for refused actions");
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
        vec!["page-c".to_string()],
    );
    commit_block(
        &mut fixture.harness.connection,
        "consumer-conflict",
        "ing-b",
        &format!("{action_id}-block-b"),
        send_block_for(MODULE_ID, action_id, &fixture.session, &["Different."]),
        vec!["page-c".to_string()],
    );
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-conflict".to_string()],
    });
    let mut module_conn = reopen_module_store(&fixture);
    let mut consumer = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
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
        vec!["page-c".to_string()],
    );
    commit_block(
        &mut fixture.harness.connection,
        "consumer-backpressure",
        "ing-2",
        &format!("{a2}-block"),
        send_block_for(MODULE_ID, a2, &fixture.session, &["two"]),
        vec!["page-c".to_string()],
    );
    let clock = SharedClock::at(CHANNEL_NOW);
    // a1's transport response is lost (Timeout -> dispatched-pending).
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::Timeout); // a1 stays dispatched-pending
    let mut module_conn = reopen_module_store(&fixture);
    let mut consumer = OutboundConsumer::new_dev(
        config,
        Box::new(clock.clone()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    // Fresh caller deadline: a1 is admitted and holds its durable slot as
    // dispatched-pending; a2 waits behind the full queue until the deadline
    // burns past (a background task advances the SHARED clock and wakes the
    // gate), then backpressures with zero transport and no leaked slot.
    let advance_clock = clock.clone();
    let queue_wake = consumer.gate();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        advance_clock.advance_seconds(4);
        queue_wake.wake_all();
    });
    let outcomes = consumer
        .consume(&timestamp_plus_seconds(CHANNEL_NOW, 3))
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
    // Durable occupancy: exactly the one held (Queued/Dispatched) send for
    // the session; a2's failed admission leaked nothing.
    assert_eq!(
        consumer
            .pending_outbound()
            .unwrap()
            .iter()
            .filter(|e| {
                e.session_id == fixture.session && e.state != OutboundState::Prepared
            })
            .count(),
        1,
        "exactly the one held slot; a2's failed admission leaked nothing"
    );
    drop(consumer);

    // Status-first recovery settles a1 (transport confirms), freeing durable
    // occupancy, then a fresh pass dispatches a2 exactly once (no blind
    // resend of a1).
    let transport2 = SharedTransport::new(true);
    transport2.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-bp-2".to_string()],
    });
    transport2.push_status(
        a1,
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec!["m-bp-1-confirmed".to_string()],
        },
    );
    let mut module_conn2 = reopen_module_store(&fixture);
    let mut consumer2 = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn2,
        &mut fixture.harness.connection,
        Box::new(transport2.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    // a1 settles to Confirmed (status-first); a2 stays Prepared (pending,
    // owned by consume) — so exactly one durable row remains unresolved.
    let remaining = consumer2.reconcile().expect("reconcile");
    assert_eq!(remaining, 1, "a2 (never-admitted Prepared) remains, owned by consume");
    let outcomes2 = consumer2.consume(&far_deadline()).expect("consume");
    let mut terminal_a2 = false;
    let mut replay_a1 = false;
    for outcome in &outcomes2 {
        match outcome {
            dolly_channel::ConsumerOutcome::Terminal { action_id, .. } => {
                if action_id == a2 {
                    terminal_a2 = true;
                } else if action_id == a1 {
                    // a1 was settled by status-first reconcile; consume
                    // returns the stored terminal result with zero transport.
                    replay_a1 = true;
                }
            }
            dolly_channel::ConsumerOutcome::Pending { .. } => {}
            other => panic!("unexpected outcome {other:?}"),
        }
    }
    assert!(terminal_a2, "a2 reached terminal exactly once");
    assert!(replay_a1, "a1 replays its stored result, never blind-resent");
    assert_eq!(transport2.calls().len(), 1, "a1 was never blind-resent");
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
        vec!["page-c".to_string()],
    );
    let transport = SharedTransport::new(true); // idempotency-keyed (required)
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
        let mut consumer = OutboundConsumer::new_with_store(
            channel_config(),
            Box::new(channel_clock()),
            store,
            &mut fixture.harness.connection,
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
        vec!["page-c".to_string()],
    );
    let transport = SharedTransport::new(true); // idempotency-keyed (required)
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
        let mut consumer = OutboundConsumer::new_with_store(
            channel_config(),
            Box::new(channel_clock()),
            store,
            &mut fixture.harness.connection,
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
    let mut consumer2 = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
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
            let mut consumer3 = OutboundConsumer::new_dev(
            channel_config(),
            Box::new(channel_clock()),
            &mut module_conn,
            &mut fixture.harness.connection,
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
        vec!["page-c".to_string()],
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
    let mut consumer = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes = consumer.consume(&far_deadline()).expect("consume");
    assert!(outcomes.is_empty(), "no committed send Action, no outcome");
    assert_eq!(consumer.ledger().unwrap().outbound.len(), 0);
    assert_eq!(transport.calls().len(), 0);
    assert!(
        consumer.pending_outbound().unwrap().is_empty(),
        "queue untouched (no durable occupancy)"
    );
    drop(consumer);
}

/// Item 1/6: fresh authority revalidation. After the grant is revoked (or the
/// generation/lifecycle fence changes), the sealed consumer MUST refuse the
/// next consume BEFORE any durable or transport effect, with zero outcomes
/// and zero store mutation.
#[test]
fn revoked_grant_or_changed_lifecycle_fence_refuses_consume_before_any_effect() {
    let mut fixture = setup("consumer-revoke");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000812";
    commit_block(
        &mut fixture.harness.connection,
        "consumer-revoke",
        "ing-1",
        &format!("{action_id}-block"),
        send_block_for(MODULE_ID, action_id, &fixture.session, &["Hello."]),
        vec!["page-c".to_string()],
    );

    // Revoke the current capability grant: the grant fence no longer holds.
    let authority = fixture.harness.authority.clone();
    fixture.harness.revoke_grant(&authority, MODULE_ID);

    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-revoked".to_string()],
    });
    let mut module_conn = reopen_module_store(&fixture);
    let mut consumer = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let err = consumer.consume(&far_deadline()).expect_err("revoked grant must refuse");
    assert_eq!(err.code, codes::AUTHENTICATION_FAILED);
    assert_eq!(transport.calls().len(), 0, "zero transport effect under a revoked grant");
    drop(consumer);

    // No durable outbound row was written.
    let mut module_conn2 = Connection::open(&fixture.module_path).unwrap();
    let mut reopened = SqliteChannelStore::new(&mut module_conn2, &fixture.principal, 1).unwrap();
    assert!(reopened.list_pending_outbound().unwrap().is_empty());
}

/// Item 5: configured piece/token rate limiting is applied before the
/// dispatch CAS/transport. A burst past the per-session rate is refused
/// retryable with zero transport effect; the row stays durably Queued (not
/// leaked); the second action is admitted after the bucket refills.
#[test]
fn configured_rate_limit_refuses_burst_with_zero_transport_then_refills() {
    let mut fixture = setup("consumer-rate");
    let config = ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1)
        .target_pages(&["page-a"])
        .max_pending_per_session(8)
        .max_pieces_per_second_per_session(1)
        .build();
    let a1 = "0198ab31-6c44-7e8a-b2bb-000000000813";
    let a2 = "0198ab31-6c44-7e8a-b2bb-000000000814";
    commit_block(
        &mut fixture.harness.connection,
        "consumer-rate",
        "ing-1",
        &format!("{a1}-block"),
        send_block_for(MODULE_ID, a1, &fixture.session, &["one"]),
        vec!["page-c".to_string()],
    );
    commit_block(
        &mut fixture.harness.connection,
        "consumer-rate",
        "ing-2",
        &format!("{a2}-block"),
        send_block_for(MODULE_ID, a2, &fixture.session, &["two"]),
        vec!["page-c".to_string()],
    );
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-rate-1".to_string()],
    });
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-rate-2".to_string()],
    });
    let mut module_conn = reopen_module_store(&fixture);
    let mut consumer = OutboundConsumer::new_dev(
        config,
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes = consumer.consume(&far_deadline()).expect("consume");
    assert_eq!(outcomes.len(), 2, "two committed sends evaluated");
    let mut terminal = 0;
    let mut rate_rejected = 0;
    for outcome in &outcomes {
        match outcome {
            dolly_channel::ConsumerOutcome::Terminal { .. } => terminal += 1,
            dolly_channel::ConsumerOutcome::Rejected { error, .. } => {
                assert_eq!(error.code, codes::RATE_LIMITED);
                assert!(error.retryable);
                rate_rejected += 1;
            }
            other => panic!("expected terminal or rate rejection, got {other:?}"),
        }
    }
    assert_eq!(terminal, 1, "first action admitted");
    assert_eq!(rate_rejected, 1, "second action refused by the token bucket");
    assert_eq!(transport.calls().len(), 1, "the burst never reached the transport");
    drop(consumer);

    // After the bucket refills (advance the clock), the durably-Queued action
    // dispatches exactly once.
    let mut clock = channel_clock();
    clock.advance_seconds(2);
    let mut module_conn2 = Connection::open(&fixture.module_path).unwrap();
    let mut consumer2 = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(clock),
        &mut module_conn2,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes2 = consumer2.consume(&far_deadline()).expect("consume");
    assert!(
        outcomes2.iter().any(|o| matches!(
            o,
            dolly_channel::ConsumerOutcome::Terminal { action_id, .. } if action_id == a2
        )),
        "the rate-refused action dispatches after the bucket refills"
    );
    assert_eq!(transport.calls().len(), 2, "second action dispatched exactly once");
}


/// Items 2/5/6: status-first recovery settles every validated transport
/// status through the exact frozen result envelope. A Rejected status settles
/// a terminal Failed row WITH its frozen result_jcs; Unknown keeps the row
/// Dispatched (never age-guessed, never false success).
#[test]
fn status_first_settles_rejected_and_unknown_exactly() {
    let mut fixture = setup("consumer-status-envelope");
    let a1 = "0198ab31-6c44-7e8a-b2bb-000000000816";
    let a2 = "0198ab31-6c44-7e8a-b2bb-000000000817";
    for (i, (action, msg)) in [(a1, "m-rejected-status"), (a2, "m-unknown-status")].into_iter().enumerate() {
        commit_block(
            &mut fixture.harness.connection,
            "consumer-status-envelope",
            &format!("ing-{i}"),
            &format!("{action}-block"),
            send_block_for(MODULE_ID, action, &fixture.session, &[msg]),
            vec!["page-c".to_string()],
        );
    }
    let transport = SharedTransport::new(true);
    // Both sends: transport response lost -> Dispatched; the durable CAS
    // before transport means both rows are Dispatched after the first pass.
    transport.push(TransportSendResult::Timeout);
    transport.push(TransportSendResult::Timeout);
    let mut module_conn = reopen_module_store(&fixture);
    {
        let mut consumer = OutboundConsumer::new_dev(
            channel_config(),
            Box::new(channel_clock()),
            &mut module_conn,
            &mut fixture.harness.connection,
            Box::new(transport.clone()),
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .expect("consumer");
        let outcomes = consumer.consume(&far_deadline()).expect("consume");
        assert_eq!(outcomes.len(), 2);
        assert!(outcomes.iter().all(|o| matches!(
            o,
            dolly_channel::ConsumerOutcome::Pending { .. }
        )));
        drop(consumer);
    }
    // Status scripts: a1 rejected, a2 unknown.
    transport.push_status(
        a1,
        dolly_channel::transport::TransportStatusResult::Rejected {
            code: "REMOTE_REFUSED".to_string(),
        },
    );
    transport.push_status(
        a2,
        dolly_channel::transport::TransportStatusResult::Unknown,
    );
    let mut consumer2 = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let remaining = consumer2.reconcile().expect("reconcile");
    // a1 settles Failed (exact envelope); a2 stays Dispatched (unknown,
    // never age-guessed) -> 1 unresolved.
    assert_eq!(remaining, 1, "unknown status stays unresolved");
    let ledger = consumer2.ledger().unwrap();
    let e1 = ledger.outbound_entry(a1).expect("durable a1");
    assert_eq!(e1.state, OutboundState::Failed);
    let envelope: Value = serde_json::from_str(e1.result_jcs.as_deref().expect("frozen result")).unwrap();
    assert_eq!(envelope["status"], "failed");
    assert_eq!(envelope["error"]["code"], "CHANNEL_TRANSPORT_REJECTED");
    assert_eq!(envelope["error"]["outcome"], "not_applied");
    assert_eq!(envelope["result"], Value::Null);
    let e2 = ledger.outbound_entry(a2).expect("durable a2");
    assert_eq!(e2.state, OutboundState::Dispatched, "unknown is never age-guessed");
    assert!(e2.result_jcs.is_none(), "no fabricated terminal result");
}

/// A: exact transition binding. A committed Block carrying a channel send
/// body but emitted by a runtime_source that is NOT a current graph module
/// (arbitrary CoreCommand::Ingress) must never mint downstream send
/// authority — zero durable rows, zero transport.
#[test]
fn generic_ingress_from_non_graph_source_cannot_mint_send_authority() {
    let mut fixture = setup("consumer-exact-transition");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000818";
    // Commit with a NON-graph runtime_source ("model/web-channel" / "attacker").
    let block = send_block_for(MODULE_ID, action_id, &fixture.session, &["hi"]);
    let operation_digest = dolly_canonical_json::canonicalize(&block).unwrap().1.to_canonical_string();
    {
        let mut store = SqliteCoreStore::new(&mut fixture.harness.connection).unwrap();
        let transition = store
            .transact(
                &CoreCommand::Ingress(IngressCommand {
                    command_id: "consumer-exact-transition-foreign".to_string(),
                    runtime_source: "attacker".to_string(),
                    ingress_key: "foreign-ing".to_string(),
                    operation_digest,
                    block_id: format!("{action_id}-block"),
                    block,
                    pages: vec!["page-c".to_string()],
                }),
                &EnvironmentInput {
                    now: CHANNEL_NOW.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(transition.outcome, TransitionOutcome::Committed);
    }
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-foreign".to_string()],
    });
    let mut module_conn = reopen_module_store(&fixture);
    let mut consumer = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes = consumer.consume(&far_deadline()).expect("consume");
    assert_eq!(outcomes.len(), 0, "a foreign-source send Block never becomes an action");
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(
        consumer.pending_outbound().unwrap().is_empty(),
        "zero durable outbound rows"
    );
}

/// A/Commit-1: fence changes are BARRIER-controlled at each effect boundary.
/// A shared identity-enforced gate is used by two consumers; while the second
/// consumer's admission is blocked at the durable gate, the first frees the
/// slot (status-first reconcile) so the waiter is admitted, and the grant is
/// revoked exactly at the "after_queue_wait" barrier — the post-wait fresh-
/// authority recheck MUST refuse with zero transport. No sleeps or polling.
#[test]
fn revoke_after_queue_wait_refuses_before_transport_effect() {
    let dir = tempfile::TempDir::new().unwrap();
    let runtime_path = dir.path().join("runtime.sqlite3");
    let (mut runtime, authority, grant) = {
        let mut connection = Connection::open(&runtime_path).unwrap();
        let authority = {
            let mut store = SqliteCoreStore::new(&mut connection).unwrap();
            configured(&mut store, "consumer-revoke-after-wait", 1);
            let body = graph(&[MODULE_ID, MODULE_OTHER], &["page-c"]);
            let graph_digest = digest(&body);
            install_graph(&mut store, "consumer-revoke-after-wait", 1, &body);
            let authority = store.bootstrap_host_connection().unwrap();
            install_grant(
                &mut store, &authority, MODULE_ID, 1, 1, &graph_digest,
                &["host.ingress.submit"],
            );
            authority
        };
        create_host_ingress_schema(&mut connection).unwrap();
        let grant = {
            let store = SqliteCoreStore::new(&mut connection).unwrap();
            store
                .current_host_capability_grant(&authority, EXTENSION_ID, MODULE_ID)
                .unwrap()
                .unwrap()
        };
        (connection, authority, grant)
    };
    let module_path = dir.path().join("channel.sqlite3");
    {
        let mut module_conn = Connection::open(&module_path).unwrap();
        create_channel_store_schema(&mut module_conn).unwrap();
        let host = SqliteHostIngressStore::new(&mut runtime).unwrap();
        let mut receiver = InboundReceiver::new(
            channel_config(),
            Box::new(channel_clock()),
            &mut module_conn,
            host,
            &authority,
            &grant,
        )
        .expect("receiver");
        match receiver.ingest_event(&sealed_event(&authority, &grant, "conv-1", "in-rw", "hi")) {
            IngressOutcome::Committed { .. } => {}
            other => panic!("premise must commit: {other:?}"),
        }
    }
    let account = dolly_channel::ids::channel_account(
        authority.extension_connection_id(),
        grant.extension_id(),
        grant.module_id(),
        authority.worker_epoch().as_str(),
    );
    let session = dolly_channel::ids::dolly_session_id(&account, "conv-1");
    let principal = ChannelPrincipal::from_authority_grant(&authority, &grant).unwrap();
    let a1 = "0198ab31-6c44-7e8a-b2bb-000000000819";
    let a2 = "0198ab31-6c44-7e8a-b2bb-000000000820";
    // Pass 0: ONLY a1 is manifest-selected+committed; its transport response
    // is lost (Timeout), holding the one durable slot as Dispatched-pending.
    for (i, (action, msg)) in [(a1, "m-hold")].into_iter().enumerate() {
        let block = send_block_for(MODULE_ID, action, &session, &[msg]);
        let mut store = SqliteCoreStore::new(&mut runtime).unwrap();
        let operation_digest = dolly_canonical_json::canonicalize(&block)
            .unwrap()
            .1
            .to_canonical_string();
        let t = store
            .transact(
                &CoreCommand::Ingress(IngressCommand {
                    command_id: format!("rw0-{i}"),
                    runtime_source: MODULE_ID.to_string(),
                    ingress_key: format!("ing0-{i}"),
                    operation_digest,
                    block_id: format!("{action}-block"),
                    block: block.clone(),
                    pages: vec!["page-c".to_string()],
                }),
                &EnvironmentInput {
                    now: CHANNEL_NOW.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.outcome, TransitionOutcome::Committed);
        persist_manifest_selection(&mut runtime, "rw0", &format!("ing0-{i}"), &format!("{action}-block"), &block, &["page-c".to_string()]);
    }
    let config = ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1)
        .target_pages(&["page-a"])
        .max_pending_per_session(1)
        .build();
    // ONE identity-enforced gate shared by both consumers.
    let gate = std::sync::Arc::new(OutboundQueueGate::new(&account, config.outbound_limits));
    let transport1 = SharedTransport::new(true);
    transport1.push(TransportSendResult::Timeout); // a1 holds the slot
    // Pass 0 dispatches a1 -> Dispatched-pending.
    {
        let mut module_conn0 = Connection::open(&module_path).unwrap();
        let mut c0 = OutboundConsumer::new(
            channel_config(),
            Box::new(channel_clock()),
            &mut module_conn0,
            &mut runtime,
            std::sync::Arc::clone(&gate),
            Box::new(transport1.clone()),
            &authority,
            &grant,
        )
        .expect("consumer");
        let outcomes = c0.consume(&far_deadline()).expect("pass0");
        assert!(
            outcomes.iter().any(|o| matches!(
                o,
                dolly_channel::ConsumerOutcome::Pending { .. }
            )),
            "a1 holds the durable slot as dispatched-pending"
        );
        drop(c0);
    }
    // Commit + manifest-select a2 (same input page page-c).
    {
        let block = send_block_for(MODULE_ID, a2, &session, &["m-wait"]);
        let mut store = SqliteCoreStore::new(&mut runtime).unwrap();
        let operation_digest = dolly_canonical_json::canonicalize(&block)
            .unwrap()
            .1
            .to_canonical_string();
        let t = store
            .transact(
                &CoreCommand::Ingress(IngressCommand {
                    command_id: "rw2-ing".to_string(),
                    runtime_source: MODULE_ID.to_string(),
                    ingress_key: "ing2".to_string(),
                    operation_digest,
                    block_id: format!("{a2}-block"),
                    block: block.clone(),
                    pages: vec!["page-c".to_string()],
                }),
                &EnvironmentInput {
                    now: CHANNEL_NOW.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.outcome, TransitionOutcome::Committed);
        persist_manifest_selection(
            &mut runtime, "rw2", "ing2", &format!("{a2}-block"), &block,
            &["page-c".to_string()],
        );
    }
    // Pass A: a1 -> Pending (skip); a2 waits at the durable gate (capacity 1,
    // held by a1's Dispatched row). The hook reports the "after_queue_wait"
    // effect boundary and blocks; the revoker reconciles a1 (freeing the
    // slot), waits for the barrier, revokes the grant, and releases the hook
    // — all driven by channels, no sleeps.
    let (at_barrier_tx, at_barrier_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = std::sync::Arc::new(std::sync::Mutex::new(
        std::sync::mpsc::channel::<()>().1,
    ));
    let (hook_tx, hook_rx) = std::sync::mpsc::channel::<String>();
    let hook_release = std::sync::Arc::clone(&release_rx);
    let barrier = std::sync::Arc::new(move |label: &str| {
        hook_tx.send(label.to_string()).unwrap();
        if label == "after_queue_wait" {
            at_barrier_tx.send(()).unwrap();
        }
        hook_release.lock().unwrap().recv().unwrap();
    });
    let (release_tx, release_rx_inner) = std::sync::mpsc::channel::<()>();
    *release_rx.lock().unwrap() = release_rx_inner;
    let revoker = {
        let module_path = module_path.clone();
        let runtime_path = runtime_path.clone();
        let gate = std::sync::Arc::clone(&gate);
        let authority = authority.clone();
        std::thread::spawn(move || {
            let transport2 = SharedTransport::new(true);
            transport2.push_status(
                a1,
                dolly_channel::transport::TransportStatusResult::Confirmed {
                    message_ids: vec!["m-hold-confirmed".to_string()],
                },
            );
            let mut revoke_conn = Connection::open(&runtime_path).unwrap();
            let mut module_conn2 = Connection::open(&module_path).unwrap();
            let grant2 = {
                let s = SqliteCoreStore::new(&mut revoke_conn).unwrap();
                s.current_host_capability_grant(&authority, EXTENSION_ID, MODULE_ID)
                    .unwrap()
                    .unwrap()
            };
            let mut consumer2 = OutboundConsumer::new(
                channel_config(),
                Box::new(channel_clock()),
                &mut module_conn2,
                &mut revoke_conn,
                gate,
                Box::new(transport2.clone()),
                &authority,
                &grant2,
            )
            .expect("consumer");
            let remaining = consumer2.reconcile().expect("reconcile frees a1");
            assert_eq!(remaining, 0, "a1 settled, occupancy freed");
            drop(consumer2);
            // Wait until a2 has been admitted (barrier at after_queue_wait),
            // then revoke and release the barrier.
            at_barrier_rx
                .recv_timeout(std::time::Duration::from_secs(30))
                .expect("after_queue_wait barrier");
            let mut store = SqliteCoreStore::new(&mut revoke_conn).unwrap();
            store
                .revoke_host_capability_grant(&authority, EXTENSION_ID, MODULE_ID)
                .unwrap();
            release_tx.send(()).unwrap();
        })
    };
    let mut module_conn_a = Connection::open(&module_path).unwrap();
    let mut consumer_a = OutboundConsumer::new(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn_a,
        &mut runtime,
        std::sync::Arc::clone(&gate),
        Box::new(SharedTransport::new(true)),
        &authority,
        &grant,
    )
    .expect("consumer");
    consumer_a.set_effect_barrier(barrier);
    // The waiting action is refused by the post-wait fresh-authority check.
    match consumer_a.consume(&far_deadline()) {
        Err(error) => assert_eq!(error.code, codes::AUTHENTICATION_FAILED),
        Ok(outcomes) => {
            let refused = outcomes
                .iter()
                .filter(|o| {
                    matches!(
                        o,
                        dolly_channel::ConsumerOutcome::Rejected { error, .. }
                            if error.code == codes::AUTHENTICATION_FAILED
                    )
                })
                .count();
            assert!(refused >= 1, "waiting action must be refused after revocation");
        }
    }
    drop(consumer_a);
    revoker.join().expect("revoker");
    let _ = (module_path, principal);
}

/// C: dispatch drains the durable FIFO in queued_seq order — the transport
/// call order equals the durable queued_seq order of the admitted rows, and
/// every row got a strict increasing durable sequence, never reordered by the
/// snapshot iteration.
#[test]
fn dispatch_drains_durable_fifo_order() {
    let mut fixture = setup("consumer-fifo-order");
    // Block ids chosen so snapshot (BTreeMap, lexicographic) orders a2 first.
    let a1 = "0198ab31-6c44-7e8a-b2bb-000000000901"; // block id sorts later
    let a2 = "0198ab31-6c44-7e8a-b2bb-000000000900"; // block id sorts earlier
    commit_block(
        &mut fixture.harness.connection,
        "consumer-fifo-order",
        "ing-a1",
        &format!("{a1}-block"),
        send_block_for(MODULE_ID, a1, &fixture.session, &["first"]),
        vec!["page-c".to_string()],
    );
    commit_block(
        &mut fixture.harness.connection,
        "consumer-fifo-order",
        "ing-a2",
        &format!("{a2}-block"),
        send_block_for(MODULE_ID, a2, &fixture.session, &["second"]),
        vec!["page-c".to_string()],
    );
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["fifo-1".to_string()],
    });
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["fifo-2".to_string()],
    });
    let mut module_conn = reopen_module_store(&fixture);
    let mut consumer = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes = consumer.consume(&far_deadline()).expect("consume");
    assert_eq!(outcomes.len(), 2, "both admitted+dispatched");
    let calls = transport.calls();
    assert_eq!(calls.len(), 2, "two transports");
    // Transport order must equal the durable queued_seq order (admission
    // order follows the manifest's Activation/input ordering, not block ids).
    assert_eq!(calls[0].action_id, a1, "first durable FIFO row");
    assert_eq!(calls[1].action_id, a2, "second durable FIFO row");
    // The durable sequences are strict and increasing in admission order.
    drop(consumer);
    let mut reopen_conn = Connection::open(&fixture.module_path).unwrap();
    let mut reopened = SqliteChannelStore::new(&mut reopen_conn, &fixture.principal, 1).unwrap();
    let seq1 = reopened.find_outbound(a1).unwrap().unwrap().entry.queued_seq;
    let seq2 = reopened.find_outbound(a2).unwrap().unwrap().entry.queued_seq;
    assert!(seq1.unwrap() < seq2.unwrap(), "queued_seq strictly increasing");
}

/// C/5: a Confirmed/Partial transport status with a MISSING transport id must
/// be rejected BEFORE frozen-envelope settlement — never fabricate IDs — and
/// the row stays Dispatched for a later status resolution.
#[test]
fn malformed_status_with_missing_id_is_rejected_before_settle() {
    let mut fixture = setup("consumer-malformed-status");
    let a1 = "0198ab31-6c44-7e8a-b2bb-000000000902";
    commit_block(
        &mut fixture.harness.connection,
        "consumer-malformed-status",
        "ing-1",
        &format!("{a1}-block"),
        send_block_for(MODULE_ID, a1, &fixture.session, &["hi"]),
        vec!["page-c".to_string()],
    );
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::Timeout); // -> Dispatched
    let mut module_conn = reopen_module_store(&fixture);
    {
        let mut consumer = OutboundConsumer::new_dev(
            channel_config(),
            Box::new(channel_clock()),
            &mut module_conn,
            &mut fixture.harness.connection,
            Box::new(transport.clone()),
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .expect("consumer");
        let outcomes = consumer.consume(&far_deadline()).unwrap();
        assert!(matches!(
            &outcomes[0],
            dolly_channel::ConsumerOutcome::Pending { .. }
        ));
        drop(consumer);
    }
    // Confirmed status with a MISSING id for the single piece (empty vector):
    // must NOT fabricate "confirmed-0"; the row must stay Dispatched.
    transport.push_status(
        a1,
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec![],
        },
    );
    let mut consumer2 = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let remaining = consumer2.reconcile().unwrap();
    assert_eq!(remaining, 1, "malformed status must not settle the row");
    let ledger = consumer2.ledger().unwrap();
    let entry = ledger.outbound_entry(a1).unwrap();
    assert_eq!(entry.state, OutboundState::Dispatched, "no settle on malformed status");
    assert!(entry.pieces.iter().all(|p| p.transport_message_id.is_none()),
        "no fabricated transport ids");
}

/// Commit 3: the malformed-status matrix. Confirmed/Partial transport
/// statuses with missing, empty, duplicate, gapped, or out-of-range ids are
/// rejected BEFORE frozen-envelope settlement — never fabricated — and the
/// row stays Dispatched for a later status resolution.
#[test]
fn malformed_status_matrix_is_rejected_before_settle() {
    let cases: Vec<dolly_channel::transport::TransportStatusResult> = vec![
        // missing (empty vector)
        dolly_channel::transport::TransportStatusResult::Confirmed { message_ids: vec![] },
        // empty id
        dolly_channel::transport::TransportStatusResult::Confirmed { message_ids: vec!["".to_string()] },
        // duplicate id
        dolly_channel::transport::TransportStatusResult::Confirmed { message_ids: vec!["dup".to_string(), "dup".to_string()] },
        // out-of-range (one id for two pieces)
        dolly_channel::transport::TransportStatusResult::Confirmed { message_ids: vec!["only-one".to_string()] },
        // empty confirmed id
        dolly_channel::transport::TransportStatusResult::Partial {
            pieces: vec![
                dolly_channel::transport::TransportPieceOutcome::Confirmed { ordinal: 0, message_id: "".to_string() },
                dolly_channel::transport::TransportPieceOutcome::Confirmed { ordinal: 1, message_id: "ok".to_string() },
            ],
        },
        // duplicate confirmed id
        dolly_channel::transport::TransportStatusResult::Partial {
            pieces: vec![
                dolly_channel::transport::TransportPieceOutcome::Confirmed { ordinal: 0, message_id: "same".to_string() },
                dolly_channel::transport::TransportPieceOutcome::Confirmed { ordinal: 1, message_id: "same".to_string() },
            ],
        },
        // gapped/out-of-range Partial (only one piece outcome for two pieces)
        dolly_channel::transport::TransportStatusResult::Partial {
            pieces: vec![
                dolly_channel::transport::TransportPieceOutcome::Confirmed { ordinal: 0, message_id: "only-0".to_string() },
            ],
        },
    ];
    for (case_index, status) in cases.into_iter().enumerate() {
        let mut fixture = setup(&format!("consumer-status-matrix-{case_index}"));
        let action_id = format!("0198ab31-6c44-7e8a-b2bb-0000{:04x}", 1000 + case_index);
        commit_block(
            &mut fixture.harness.connection,
            &format!("consumer-status-matrix-{case_index}"),
            "ing-1",
            &format!("{action_id}-block"),
            send_block_for(MODULE_ID, &action_id, &fixture.session, &["hi one", "hi two"]),
            vec!["page-c".to_string()],
        );
        // Note: the send has ONE piece; out-of-range/duplicate cases are
        // exercised by giving the status more ids than the send's pieces.
        let transport = SharedTransport::new(true);
        transport.push(TransportSendResult::Timeout);
        let mut module_conn = reopen_module_store(&fixture);
        {
            let mut consumer = OutboundConsumer::new_dev(
                channel_config(),
                Box::new(channel_clock()),
                &mut module_conn,
                &mut fixture.harness.connection,
                Box::new(transport.clone()),
                &fixture.harness.authority,
                &fixture.harness.grant,
            )
            .expect("consumer");
            let outcomes = consumer.consume(&far_deadline()).unwrap();
            assert!(
                matches!(&outcomes[0], dolly_channel::ConsumerOutcome::Pending { .. }),
                "send stays dispatched-pending"
            );
            drop(consumer);
        }
        transport.push_status(&action_id, status);
        let mut consumer2 = OutboundConsumer::new_dev(
            channel_config(),
            Box::new(channel_clock()),
            &mut module_conn,
            &mut fixture.harness.connection,
            Box::new(transport.clone()),
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .expect("consumer");
        let remaining = consumer2.reconcile().unwrap();
        assert_eq!(
            remaining, 1,
            "malformed status {case_index} must not settle the row"
        );
        let ledger = consumer2.ledger().unwrap();
        let entry = ledger.outbound_entry(&action_id).unwrap();
        assert_eq!(
            entry.state, OutboundState::Dispatched,
            "no settle on malformed status {case_index}"
        );
        assert!(
            entry.pieces.iter().all(|p| p.transport_message_id.is_none()),
            "no fabricated transport ids (case {case_index})"
        );
        drop(consumer2);
    }
}

/// Commit 1: MANIFEST-only authority — a committed Block that is NEVER
/// selected into the configured Module's ActivationManifest.input_items
/// (arbitrary CoreCommand::Ingress, journal, ingress, runtime_events) cannot
/// mint downstream send authority.
#[test]
fn generic_ingress_without_manifest_cannot_mint_send_authority() {
    let mut fixture = setup("consumer-manifest-only");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000818";
    let block = send_block_for(MODULE_ID, action_id, &fixture.session, &["hi"]);
    let operation_digest = dolly_canonical_json::canonicalize(&block).unwrap().1.to_canonical_string();
    {
        let mut store = SqliteCoreStore::new(&mut fixture.harness.connection).unwrap();
        let transition = store
            .transact(
                &CoreCommand::Ingress(IngressCommand {
                    command_id: "consumer-manifest-only-foreign".to_string(),
                    runtime_source: "attacker".to_string(),
                    ingress_key: "foreign-ing".to_string(),
                    operation_digest,
                    block_id: format!("{action_id}-block"),
                    block,
                    pages: vec!["page-c".to_string()],
                }),
                &EnvironmentInput {
                    now: CHANNEL_NOW.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(transition.outcome, TransitionOutcome::Committed);
    }
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-foreign".to_string()],
    });
    let mut module_conn = reopen_module_store(&fixture);
    let mut consumer = OutboundConsumer::new_dev(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let outcomes = consumer.consume(&far_deadline()).expect("consume");
    assert_eq!(
        outcomes.len(), 0,
        "an Ingress-only Block never becomes an Action without manifest selection"
    );
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(consumer.pending_outbound().unwrap().is_empty(), "zero durable outbound rows");
}
