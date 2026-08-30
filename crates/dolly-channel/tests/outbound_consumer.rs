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
use dolly_channel::error::codes;
use dolly_channel::transport::{
    ChannelTransport, TransportPieceOutcome, TransportSendRequest, TransportSendResult,
};
use dolly_channel::asset::{AssetLeaseProof, AssetPremise, AssetPreparation};
use dolly_channel::{
    ChannelOutcome, ChannelPrincipal, InboundReceiver, IngressOutcome, OutboundConsumer,
    OutboundQueueGate, OutboundState, SqliteChannelStore, create_channel_store_schema,
    timestamp_plus_seconds,
};
use dolly_core_reducer::{
    ActivationState, BeginFenceCommand, BuildManifestCommand, CoreCommand, DispatchLeaseCommand,
    DispatchState, EnvironmentInput, IngressCommand, IssueLeaseCommand, TransitionOutcome,
};
use dolly_storage::{SqliteCoreStore, SqliteHostIngressStore, create_host_ingress_schema};
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
    status_calls: Vec<dolly_channel::transport::TransportStatusRequest>,
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
    fn status_calls(&self) -> Vec<dolly_channel::transport::TransportStatusRequest> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .status_calls
            .clone()
    }

    fn push_status(
        &self,
        action_id: &str,
        result: dolly_channel::transport::TransportStatusResult,
    ) {
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
    fn status(
        &mut self,
        request: &dolly_channel::transport::TransportStatusRequest,
    ) -> dolly_channel::transport::TransportStatusResult {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        inner.status_calls.push(request.clone());
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
    let mut block = json!({
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
    });
    let action_contract =
        block["body"]["actions"][0]["contract_binding"]["action_contract"].clone();
    block["body"]["actions"][0]["contract_binding"]["action_contract_digest"] =
        json!(digest(&action_contract));
    block
}

/// Commit and select a Block using the default Channel config.
fn commit_block(
    harness: &mut RuntimeHarness,
    mark: &str,
    key: &str,
    block_id: &str,
    block: Value,
    pages: Vec<String>,
) {
    commit_block_with_config(harness, mark, key, block_id, block, pages, channel_config());
}

/// Commit and select a Block, then make that exact manifest/config the current
/// dispatched execution authority for the fixture.
#[allow(clippy::too_many_arguments)]
fn commit_block_with_config(
    harness: &mut RuntimeHarness,
    mark: &str,
    key: &str,
    block_id: &str,
    block: Value,
    pages: Vec<String>,
    mut frozen_config: dolly_channel::ChannelConfig,
) {
    let operation_digest = dolly_canonical_json::canonicalize(&block)
        .unwrap()
        .1
        .to_canonical_string();
    let (block_for_manifest, pages_for_manifest) = (block.clone(), pages.clone());
    let mut store = SqliteCoreStore::new(&mut harness.connection).expect("core schema");
    let prior_activations: Vec<String> = store
        .snapshot()
        .unwrap()
        .activations
        .into_iter()
        .filter_map(|(activation_id, activation)| {
            (activation.state == ActivationState::Dispatched
                && activation
                    .manifest
                    .as_ref()
                    .and_then(|manifest| manifest.get("module_id"))
                    .and_then(Value::as_str)
                    == Some(MODULE_ID))
            .then_some(activation_id)
        })
        .collect();
    for activation_id in prior_activations {
        let transition = store
            .transact(
                &CoreCommand::BeginFence(BeginFenceCommand {
                    command_id: format!("{mark}-fence-{activation_id}"),
                    activation_id,
                }),
                &EnvironmentInput {
                    now: CHANNEL_NOW.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(transition.outcome, TransitionOutcome::Committed);
    }
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
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    drop(store);
    frozen_config.transport_account = account(&harness.authority, &harness.grant);
    let (activation_id, _manifest_digest) = persist_manifest_selection(
        &mut harness.connection,
        mark,
        key,
        &block_for_manifest,
        &pages_for_manifest,
        &frozen_config,
    );
    activate_manifest(
        &mut harness.connection,
        &harness.authority,
        mark,
        key,
        &activation_id,
    );
}

/// Persist one normative manifest and return its activation ID and digest.
fn persist_manifest_selection(
    connection: &mut Connection,
    mark: &str,
    key: &str,
    block: &Value,
    pages: &[String],
    frozen_config: &dolly_channel::ChannelConfig,
) -> (String, String) {
    let activation_id = format!("activation-{mark}-{key}");
    let occurrences: Vec<Value> = pages
        .iter()
        .enumerate()
        .map(|(index, page_id)| {
            json!({
                "page_id": page_id,
                "page_seq": (index as i64) + 1,
                "commit_seq": (index as i64) + 1
            })
        })
        .collect();
    let effective_config = serde_json::to_value(frozen_config).unwrap();
    let effective_config_digest = digest(&effective_config);
    let mut manifest = json!({
        "schema": "dolly.activation-manifest/v1",
        "activation_id": activation_id,
        "module_id": MODULE_ID,
        "reason": "input",
        "created_at": CHANNEL_NOW,
        "graph_revision": 1,
        "config_revision": frozen_config.revision,
        "descriptor_revision": 1,
        "effective_config": effective_config,
        "effective_config_digest": effective_config_digest,
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
    let manifest_digest = digest(&manifest);
    manifest["manifest_digest"] = json!(manifest_digest);
    let mut store = SqliteCoreStore::new(connection).expect("core schema");
    let transition = store
        .transact(
            &CoreCommand::BuildManifest(BuildManifestCommand {
                command_id: format!("{mark}-build-{key}"),
                activation_id: activation_id.clone(),
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
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    (activation_id, manifest_digest)
}

fn activate_manifest(
    connection: &mut Connection,
    authority: &dolly_storage::HostConnectionAuthority,
    mark: &str,
    key: &str,
    activation_id: &str,
) {
    let lease_id = format!("lease-{mark}-{key}");
    let token_digest = digest(&json!({
        "activation_id": activation_id,
        "lease_id": lease_id
    }));
    let mut store = SqliteCoreStore::new(connection).unwrap();
    assert_eq!(
        store
            .transact(
                &CoreCommand::IssueLease(IssueLeaseCommand {
                    command_id: format!("{mark}-lease-{key}"),
                    activation_id: activation_id.to_string(),
                    lease_id: lease_id.clone(),
                    reservation_id: None,
                    token_digest,
                    extension_connection_id: authority.extension_connection_id().to_string(),
                    worker_epoch: authority.worker_epoch_fence(),
                    request_id: None,
                    worker_epoch_id: None,
                    incarnation_revision: None,
                    extension_generation: Some(1),
                }),
                &EnvironmentInput {
                    now: CHANNEL_NOW.into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .outcome,
        TransitionOutcome::Committed
    );
    assert_eq!(
        store
            .transact(
                &CoreCommand::DispatchLease(DispatchLeaseCommand {
                    command_id: format!("{mark}-dispatch-{key}"),
                    activation_id: activation_id.to_string(),
                    lease_id,
                    dispatch_state: DispatchState::Started,
                    reservation_id: None,
                    request_id: None,
                    extension_connection_id: None,
                    incarnation_revision: None,
                    frame_digest: None,
                }),
                &EnvironmentInput {
                    now: CHANNEL_NOW.into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .outcome,
        TransitionOutcome::Committed
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

struct FileSendFixture {
    _dir: TempDir,
    runtime_path: std::path::PathBuf,
    module_path: std::path::PathBuf,
    runtime: Connection,
    authority: dolly_storage::HostConnectionAuthority,
    grant: dolly_storage::HostCapabilityGrant,
    config: dolly_channel::ChannelConfig,
    principal: ChannelPrincipal,
    activation_id: String,
}

fn setup_file_send(mark: &str, action_id: &str) -> FileSendFixture {
    setup_file_send_with_revisions(mark, action_id, 1, 1)
}

fn setup_file_send_with_revisions(
    mark: &str,
    action_id: &str,
    activation_config_revision: i64,
    extension_manifest_revision: i64,
) -> FileSendFixture {
    let dir = TempDir::new().unwrap();
    let runtime_path = dir.path().join("runtime.sqlite3");
    let graph_body = graph(&[MODULE_ID, MODULE_OTHER], &["page-c"]);
    let graph_digest = digest(&graph_body);
    let mut config = channel_config();
    config.revision = activation_config_revision;
    let (mut runtime, authority, initial_grant) = {
        let mut connection = Connection::open(&runtime_path).unwrap();
        let authority = {
            let mut store = SqliteCoreStore::new(&mut connection).unwrap();
            configured(&mut store, mark, activation_config_revision);
            install_graph(&mut store, mark, 1, &graph_body);
            let authority = store.bootstrap_host_connection().unwrap();
            store
                .install_host_capability_grant(
                    &authority,
                    EXTENSION_ID,
                    MODULE_ID,
                    1,
                    1,
                    &descriptor_digest(MODULE_ID),
                    extension_manifest_revision,
                    &digest(&json!({
                        "extension_manifest_revision": extension_manifest_revision
                    })),
                    1,
                    &graph_digest,
                    &["host.ingress.submit"],
                )
                .unwrap();
            authority
        };
        create_host_ingress_schema(&mut connection).unwrap();
        let grant = SqliteCoreStore::new(&mut connection)
            .unwrap()
            .current_host_capability_grant(&authority, EXTENSION_ID, MODULE_ID)
            .unwrap()
            .unwrap();
        (connection, authority, grant)
    };
    let module_path = dir.path().join("channel.sqlite3");
    {
        let mut module_connection = Connection::open(&module_path).unwrap();
        create_channel_store_schema(&mut module_connection).unwrap();
        let host = SqliteHostIngressStore::new(&mut runtime).unwrap();
        let mut receiver = InboundReceiver::new(
            config.clone(),
            Box::new(channel_clock()),
            &mut module_connection,
            host,
            &authority,
            &initial_grant,
        )
        .unwrap();
        assert!(matches!(
            receiver.ingest_event(
                &dolly_channel::AuthenticatedChannelEvent::new(
                    &authority,
                    &initial_grant,
                    activation_config_revision,
                    content_event("conv-1", &format!("{mark}-inbound"), "hi"),
                )
                .unwrap(),
            ),
            IngressOutcome::Committed { .. }
        ));
    }
    let account = account(&authority, &initial_grant);
    let session = dolly_channel::ids::dolly_session_id(&account, "conv-1");
    config.transport_account = account;
    let block = send_block_for(MODULE_ID, action_id, &session, &["held"]);
    assert_eq!(
        SqliteCoreStore::new(&mut runtime)
            .unwrap()
            .transact(
                &CoreCommand::Ingress(IngressCommand {
                    command_id: format!("{mark}-ingress"),
                    runtime_source: MODULE_ID.to_string(),
                    ingress_key: format!("{mark}-ingress"),
                    operation_digest: digest(&block),
                    block_id: format!("{action_id}-block"),
                    block: block.clone(),
                    pages: vec!["page-c".to_string()],
                }),
                &EnvironmentInput {
                    now: CHANNEL_NOW.into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .outcome,
        TransitionOutcome::Committed
    );
    let (activation_id, _manifest_digest) = persist_manifest_selection(
        &mut runtime,
        mark,
        "ingress",
        &block,
        &["page-c".to_string()],
        &config,
    );
    activate_manifest(&mut runtime, &authority, mark, "ingress", &activation_id);
    let grant = initial_grant;
    let principal = ChannelPrincipal::from_authority_grant(&authority, &grant).unwrap();
    FileSendFixture {
        _dir: dir,
        runtime_path,
        module_path,
        runtime,
        authority,
        grant,
        config,
        principal,
        activation_id,
    }
}

fn open_consumer<'store, 'core, 'principal>(
    config: dolly_channel::ChannelConfig,
    clock: Box<dyn dolly_channel::Clock>,
    module_connection: &'store mut Connection,
    runtime_connection: &'core mut Connection,
    transport: Box<dyn ChannelTransport>,
    authority: &'principal dolly_storage::HostConnectionAuthority,
    grant: &'principal dolly_storage::HostCapabilityGrant,
) -> Result<OutboundConsumer<'store, 'core, 'principal>, dolly_channel::ChannelError> {
    let gate = OutboundQueueGate::register(&config, module_connection, authority, grant)?;
    OutboundConsumer::new(
        config,
        clock,
        module_connection,
        runtime_connection,
        gate,
        transport,
        authority,
        grant,
    )
}

/// One consume pass over a committed send with a fresh shared transport.
fn consume_one(
    fixture: &mut Fixture,
    transport: &SharedTransport,
) -> (Connection, dolly_channel::ConsumerOutcome) {
    let mut module_conn = reopen_module_store(fixture);
    let mut consumer = open_consumer(
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
        &mut fixture.harness,
        "consumer-basic",
        "ing-1",
        &format!("{action_id}-block"),
        send_block_for(
            MODULE_ID,
            action_id,
            &fixture.session,
            &["It will be sunny."],
        ),
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
    assert!(
        reopened
            .is_echo(&fixture.account, "transport-reply-1")
            .expect("echo check")
    );
    // Durable terminal row with the frozen result.
    let record = reopened
        .find_outbound(action_id)
        .unwrap()
        .expect("durable row");
    assert_eq!(record.entry.state, OutboundState::Confirmed);
    assert_eq!(
        record.entry.result_jcs.as_deref(),
        Some(result_jcs.as_str())
    );
    assert_ne!(
        record.manifest_digest,
        fixture.harness.grant.manifest_digest(),
        "Activation Manifest digest is not the Extension manifest digest",
    );
    assert_eq!(record.occurrence_index, 0);
    assert_eq!(record.page_id, "page-c");
    assert_eq!((record.page_seq, record.commit_seq), (1, 1));
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
            assert_eq!(
                replayed_jcs, result_jcs,
                "replay returns the existing result"
            );
        }
        other => panic!("expected terminal replay, got {other:?}"),
    }
    assert_eq!(transport2.calls().len(), 0, "zero re-dispatch on replay");
}

#[test]
fn unchanged_extension_grant_authorizes_distinct_activation_manifest_and_config_revision() {
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000828";
    let mut fixture = setup_file_send_with_revisions(
        "separate-extension-activation-authority",
        action_id,
        2,
        7,
    );
    assert_eq!(fixture.grant.manifest_revision(), 7);
    assert_eq!(fixture.config.revision, 2);
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["separate-authority-id".to_string()],
    });
    let mut module_connection = Connection::open(&fixture.module_path).unwrap();
    let gate = OutboundQueueGate::register(
        &fixture.config,
        &mut module_connection,
        &fixture.authority,
        &fixture.grant,
    )
    .unwrap();
    let mut consumer = OutboundConsumer::new(
        fixture.config.clone(),
        Box::new(channel_clock()),
        &mut module_connection,
        &mut fixture.runtime,
        gate,
        Box::new(transport.clone()),
        &fixture.authority,
        &fixture.grant,
    )
    .unwrap();
    assert!(matches!(
        &consumer.consume(&far_deadline()).unwrap()[0],
        dolly_channel::ConsumerOutcome::Terminal { .. }
    ));
    drop(consumer);
    let mut store =
        SqliteChannelStore::new(&mut module_connection, &fixture.principal, 2).unwrap();
    let record = store.find_outbound(action_id).unwrap().unwrap();
    assert_eq!(record.config_revision, 2);
    assert_ne!(record.config_revision, fixture.grant.manifest_revision());
    assert_ne!(record.manifest_digest, fixture.grant.manifest_digest());
    assert_eq!(transport.calls().len(), 1);
}

#[test]
fn wrong_resolved_activation_config_is_rejected_with_unchanged_extension_grant() {
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000829";
    let mut fixture = setup_file_send("wrong-activation-config", action_id);
    let mut wrong_config = fixture.config.clone();
    wrong_config
        .target_page_ids
        .push("page-not-in-activation-config".to_string());
    let transport = SharedTransport::new(true);
    let mut module_connection = Connection::open(&fixture.module_path).unwrap();
    let gate = OutboundQueueGate::register(
        &wrong_config,
        &mut module_connection,
        &fixture.authority,
        &fixture.grant,
    )
    .unwrap();
    let mut consumer = OutboundConsumer::new(
        wrong_config,
        Box::new(channel_clock()),
        &mut module_connection,
        &mut fixture.runtime,
        gate,
        Box::new(transport.clone()),
        &fixture.authority,
        &fixture.grant,
    )
    .unwrap();
    let error = consumer.consume(&far_deadline()).unwrap_err();
    assert_eq!(error.code, codes::AUTHENTICATION_FAILED);
    assert!(transport.calls().is_empty());
    drop(consumer);
    let current_grant = SqliteCoreStore::new(&mut fixture.runtime)
        .unwrap()
        .current_host_capability_grant(&fixture.authority, EXTENSION_ID, MODULE_ID)
        .unwrap()
        .unwrap();
    assert_eq!(current_grant, fixture.grant);
}

#[test]
fn stale_active_activation_is_rejected_with_unchanged_extension_grant() {
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000830";
    let mut fixture = setup_file_send("stale-active-activation", action_id);
    let gate = {
        let mut registration = Connection::open(&fixture.module_path).unwrap();
        OutboundQueueGate::register(
            &fixture.config,
            &mut registration,
            &fixture.authority,
            &fixture.grant,
        )
        .unwrap()
    };
    let (at_boundary_tx, at_boundary_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = std::sync::Arc::new(std::sync::Mutex::new(release_rx));
    let hook_release = std::sync::Arc::clone(&release_rx);
    let barrier = std::sync::Arc::new(move |observed: &str| {
        if observed == "after_dispatch_cas" {
            at_boundary_tx.send(()).unwrap();
            hook_release.lock().unwrap().recv().unwrap();
        }
    });
    let mutator = {
        let runtime_path = fixture.runtime_path.clone();
        let activation_id = fixture.activation_id.clone();
        std::thread::spawn(move || {
            at_boundary_rx
                .recv_timeout(std::time::Duration::from_secs(30))
                .unwrap();
            let mut connection = Connection::open(runtime_path).unwrap();
            let transition = SqliteCoreStore::new(&mut connection)
                .unwrap()
                .transact(
                    &CoreCommand::BeginFence(BeginFenceCommand {
                        command_id: "stale-active-activation-fence".to_string(),
                        activation_id,
                    }),
                    &EnvironmentInput {
                        now: CHANNEL_NOW.into(),
                        ..Default::default()
                    },
                )
                .unwrap();
            assert_eq!(transition.outcome, TransitionOutcome::Committed);
            release_tx.send(()).unwrap();
        })
    };
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["must-not-send".to_string()],
    });
    let mut module_connection = Connection::open(&fixture.module_path).unwrap();
    let mut consumer = OutboundConsumer::new(
        fixture.config.clone(),
        Box::new(channel_clock()),
        &mut module_connection,
        &mut fixture.runtime,
        gate,
        Box::new(transport.clone()),
        &fixture.authority,
        &fixture.grant,
    )
    .unwrap();
    consumer.set_effect_barrier(barrier);
    let error = consumer.consume(&far_deadline()).unwrap_err();
    assert_eq!(error.code, codes::AUTHENTICATION_FAILED);
    assert!(transport.calls().is_empty());
    drop(consumer);
    mutator.join().unwrap();
    let current_grant = SqliteCoreStore::new(&mut fixture.runtime)
        .unwrap()
        .current_host_capability_grant(&fixture.authority, EXTENSION_ID, MODULE_ID)
        .unwrap()
        .unwrap();
    assert_eq!(current_grant, fixture.grant);
}

#[test]
fn pre_admission_durability_failure_yields_zero_effect() {
    let mut fixture = setup("consumer-write-fail");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000802";
    commit_block(
        &mut fixture.harness,
        "consumer-write-fail",
        "ing-1",
        &format!("{action_id}-block"),
        send_block_for(MODULE_ID, action_id, &fixture.session, &["Hello."]),
        vec!["page-c".to_string()],
    );
    let transport = SharedTransport::new(true);
    {
        let mut module_conn = reopen_module_store(&fixture);
        let config = channel_config();
        let gate = OutboundQueueGate::register(
            &config,
            &mut module_conn,
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .unwrap();
        let mut store = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
        store.inject_write_prepared_outbound_failure(1);
        let mut consumer = OutboundConsumer::new_with_store(
            config,
            Box::new(channel_clock()),
            store,
            &mut fixture.harness.connection,
            gate,
            Box::new(transport.clone()),
            Box::new(dolly_channel::asset::DenyAssetParts),
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
        &mut fixture.harness,
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
        &mut fixture.harness,
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
        &mut fixture.harness,
        "consumer-reject",
        "ing-unowned",
        "block-unowned",
        unowned,
        vec!["page-c".to_string()],
    );

    let transport = SharedTransport::new(true);
    let mut module_conn = reopen_module_store(&fixture);
    let mut consumer = open_consumer(
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
    // Each commit fences the previous Activation, so the ONE current
    // dispatched manifest selects only the last Block (the unowned-session
    // send). Its failure MUST surface as a frozen zero-effect Rejected
    // outcome, never a silent drop. The foreign-owner action renamed off the
    // channel send name is not a targeted channel send and stays skipped.
    assert_eq!(
        outcomes.len(),
        1,
        "the hostile targeted send is refused with one Rejected outcome, never a silent drop"
    );
    match outcomes.into_iter().next().unwrap() {
        dolly_channel::ConsumerOutcome::Rejected {
            action_id, error,
        } => {
            assert_eq!(action_id, "0198ab31-6c44-7e8a-b2bb-000000000805");
            assert_eq!(error.code, codes::SESSION_MISSING);
            assert!(!error.retryable);
            assert_eq!(error.outcome, dolly_channel::ChannelOutcome::NotApplied);
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert_eq!(
        transport.calls().len(),
        0,
        "zero transport for refused actions"
    );
    drop(consumer);
    let mut reopened = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
    assert!(
        reopened.list_pending_outbound().unwrap().is_empty(),
        "no durable outbound rows"
    );
}

#[test]
fn same_key_different_content_conflicts_before_enqueue() {
    let mut fixture = setup("consumer-conflict");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000806";
    let mut block = send_block_for(MODULE_ID, action_id, &fixture.session, &["Hello."]);
    let second = send_block_for(MODULE_ID, action_id, &fixture.session, &["Different."]);
    block["body"]["actions"]
        .as_array_mut()
        .unwrap()
        .push(second["body"]["actions"][0].clone());
    commit_block(
        &mut fixture.harness,
        "consumer-conflict",
        "ing-conflict",
        &format!("{action_id}-block"),
        block,
        vec!["page-c".to_string()],
    );
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m-conflict".to_string()],
    });
    let mut module_conn = reopen_module_store(&fixture);
    let mut consumer = open_consumer(
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
    assert_eq!(
        transport.calls().len(),
        1,
        "only the winning action reached the transport"
    );
    drop(consumer);
    let mut reopened = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
    let record = reopened
        .find_outbound(action_id)
        .unwrap()
        .expect("durable row");
    assert_eq!(
        record.entry.pieces[0].text, "Hello.",
        "the durable row keeps the first content; the conflict changed nothing"
    );
}

#[test]
fn crash_after_prepared_before_dispatch_redispatch_and_never_duplicates() {
    let mut fixture = setup("consumer-crash-prepared");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000809";
    commit_block(
        &mut fixture.harness,
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
        let config = channel_config();
        let gate = OutboundQueueGate::register(
            &config,
            &mut module_conn,
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .unwrap();
        let mut store = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
        store.inject_mark_dispatched_failure(1);
        let mut consumer = OutboundConsumer::new_with_store(
            config,
            Box::new(channel_clock()),
            store,
            &mut fixture.harness.connection,
            gate,
            Box::new(transport.clone()),
            Box::new(dolly_channel::asset::DenyAssetParts),
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .expect("consumer with store");
        assert!(consumer.consume(&far_deadline()).is_err());
        drop(consumer);
        drop(module_conn);
    }
    assert_eq!(
        transport.calls().len(),
        0,
        "no transport before the dispatched marker"
    );
    // Phase B: restart. The durable Prepared row was NEVER dispatched, so the
    // consumer safely dispatches it exactly once.
    let (_, outcome) = consume_one(&mut fixture, &transport);
    match outcome {
        dolly_channel::ConsumerOutcome::Terminal { state, .. } => {
            assert_eq!(state, OutboundState::Confirmed)
        }
        other => panic!("expected terminal after restart, got {other:?}"),
    }
    assert_eq!(
        transport.calls().len(),
        1,
        "exactly one dispatch after restart"
    );
}

#[test]
fn crash_after_dispatch_marker_never_blind_resends_and_reconciles_status_first() {
    let mut fixture = setup("consumer-crash-dispatched");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000810";
    commit_block(
        &mut fixture.harness,
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
        let config = channel_config();
        let gate = OutboundQueueGate::register(
            &config,
            &mut module_conn,
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .unwrap();
        let mut store = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
        store.inject_commit_outbound_terminal_failure(1);
        let mut consumer = OutboundConsumer::new_with_store(
            config,
            Box::new(channel_clock()),
            store,
            &mut fixture.harness.connection,
            gate,
            Box::new(transport.clone()),
            Box::new(dolly_channel::asset::DenyAssetParts),
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
    let mut consumer2 = open_consumer(
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
    assert_eq!(
        transport.calls().len(),
        1,
        "no blind resend of a dispatched send"
    );

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
        let mut consumer3 = open_consumer(
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
        assert_eq!(
            entry.state,
            OutboundState::Confirmed,
            "status-first settle to Confirmed"
        );
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
        &mut fixture.harness,
        "consumer-partial",
        "ing-1",
        &format!("{action_id}-block"),
        send_block_for(
            MODULE_ID,
            action_id,
            &fixture.session,
            &["part one", "part two"],
        ),
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
    assert_eq!(
        envelope["error"]["details"]["confirmed_ordinals"],
        json!([0])
    );
    assert_eq!(envelope["error"]["details"]["failed_ordinals"], json!([1]));
    // Confirmed piece id became a durable echo fact atomically.
    let mut reopened = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
    assert!(reopened.is_echo(&fixture.account, "mid-partial").unwrap());
    // Redaction: neither the result nor the echo path carries message text.
    assert!(
        !result_jcs.contains("part one"),
        "result envelope carries no message text"
    );
    drop(reopened);
}

#[test]
fn zero_reverse_echo_or_premise_leakage() {
    let mut fixture = setup("consumer-leak");
    // Only the committed INBOUND premise (no send Action) exists in Core.
    let transport = SharedTransport::new(true);
    let mut module_conn = reopen_module_store(&fixture);
    let mut consumer = open_consumer(
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
        &mut fixture.harness,
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
    let mut consumer = open_consumer(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let err = consumer
        .consume(&far_deadline())
        .expect_err("revoked grant must refuse");
    assert_eq!(err.code, codes::AUTHENTICATION_FAILED);
    assert_eq!(
        transport.calls().len(),
        0,
        "zero transport effect under a revoked grant"
    );
    drop(consumer);

    // No durable outbound row was written.
    let mut module_conn2 = Connection::open(&fixture.module_path).unwrap();
    let mut reopened = SqliteChannelStore::new(&mut module_conn2, &fixture.principal, 1).unwrap();
    assert!(reopened.list_pending_outbound().unwrap().is_empty());
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
    let mut block = send_block_for(MODULE_ID, a1, &fixture.session, &["m-rejected-status"]);
    let second = send_block_for(MODULE_ID, a2, &fixture.session, &["m-unknown-status"]);
    block["body"]["actions"]
        .as_array_mut()
        .unwrap()
        .push(second["body"]["actions"][0].clone());
    commit_block(
        &mut fixture.harness,
        "consumer-status-envelope",
        "ing-statuses",
        "status-block",
        block,
        vec!["page-c".to_string()],
    );
    let transport = SharedTransport::new(true);
    // Both sends: transport response lost -> Dispatched; the durable CAS
    // before transport means both rows are Dispatched after the first pass.
    transport.push(TransportSendResult::Timeout);
    transport.push(TransportSendResult::Timeout);
    let mut module_conn = reopen_module_store(&fixture);
    {
        let mut consumer = open_consumer(
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
        assert!(
            outcomes
                .iter()
                .all(|o| matches!(o, dolly_channel::ConsumerOutcome::Pending { .. }))
        );
        drop(consumer);
    }
    // Status scripts: a1 rejected, a2 unknown.
    transport.push_status(
        a1,
        dolly_channel::transport::TransportStatusResult::Rejected {
            code: "REMOTE_REFUSED".to_string(),
        },
    );
    transport.push_status(a2, dolly_channel::transport::TransportStatusResult::Unknown);
    {
        let mut consumer = open_consumer(
            channel_config(),
            Box::new(channel_clock()),
            &mut module_conn,
            &mut fixture.harness.connection,
            Box::new(transport.clone()),
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .expect("consumer");
        assert_eq!(consumer.reconcile().expect("reconcile first FIFO row"), 1);
        let ledger = consumer.ledger().unwrap();
        let e1 = ledger.outbound_entry(a1).expect("durable a1");
        assert_eq!(e1.state, OutboundState::Failed);
        let envelope: Value =
            serde_json::from_str(e1.result_jcs.as_deref().expect("frozen result")).unwrap();
        assert_eq!(envelope["status"], "failed");
        assert_eq!(envelope["error"]["code"], "CHANNEL_TRANSPORT_REJECTED");
        assert_eq!(envelope["error"]["outcome"], "not_applied");
        assert_eq!(envelope["result"], Value::Null);
        assert_eq!(
            ledger.outbound_entry(a2).unwrap().state,
            OutboundState::Queued,
            "strict FIFO keeps the next action queued until the first is terminal",
        );
    }
    {
        let mut consumer = open_consumer(
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
        assert!(outcomes.iter().any(|outcome| matches!(
            outcome,
            dolly_channel::ConsumerOutcome::Pending { action_id, .. } if action_id == a2
        )));
    }
    let mut consumer = open_consumer(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    assert_eq!(consumer.reconcile().unwrap(), 1);
    let ledger = consumer.ledger().unwrap();
    let e2 = ledger.outbound_entry(a2).expect("durable a2");
    assert_eq!(
        e2.state,
        OutboundState::Dispatched,
        "unknown is never age-guessed"
    );
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
    let operation_digest = dolly_canonical_json::canonicalize(&block)
        .unwrap()
        .1
        .to_canonical_string();
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
    let mut consumer = open_consumer(
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
        outcomes.len(),
        0,
        "a foreign-source send Block never becomes an action"
    );
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(
        consumer.pending_outbound().unwrap().is_empty(),
        "zero durable outbound rows"
    );
}

fn assert_send_revocation_fence(label: &'static str, action_id: &'static str) {
    let mut fixture = setup_file_send(&format!("send-fence-{label}"), action_id);
    let gate = {
        let mut registration = Connection::open(&fixture.module_path).unwrap();
        OutboundQueueGate::register(
            &fixture.config,
            &mut registration,
            &fixture.authority,
            &fixture.grant,
        )
        .unwrap()
    };
    let (at_boundary_tx, at_boundary_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = std::sync::Arc::new(std::sync::Mutex::new(release_rx));
    let hook_release = std::sync::Arc::clone(&release_rx);
    let barrier = std::sync::Arc::new(move |observed: &str| {
        if observed == label {
            at_boundary_tx.send(()).unwrap();
            hook_release.lock().unwrap().recv().unwrap();
        }
    });
    let revoker = {
        let runtime_path = fixture.runtime_path.clone();
        let authority = fixture.authority.clone();
        std::thread::spawn(move || {
            at_boundary_rx
                .recv_timeout(std::time::Duration::from_secs(30))
                .unwrap();
            let mut connection = Connection::open(runtime_path).unwrap();
            SqliteCoreStore::new(&mut connection)
                .unwrap()
                .revoke_host_capability_grant(&authority, EXTENSION_ID, MODULE_ID)
                .unwrap();
            release_tx.send(()).unwrap();
        })
    };
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["authorized-before-revocation".to_string()],
    });
    let mut module_connection = Connection::open(&fixture.module_path).unwrap();
    let mut consumer = OutboundConsumer::new(
        fixture.config.clone(),
        Box::new(channel_clock()),
        &mut module_connection,
        &mut fixture.runtime,
        gate,
        Box::new(transport.clone()),
        &fixture.authority,
        &fixture.grant,
    )
    .unwrap();
    consumer.set_effect_barrier(barrier);
    let error = consumer.consume(&far_deadline()).unwrap_err();
    assert_eq!(error.code, codes::AUTHENTICATION_FAILED);
    let expected_sends = usize::from(label == "before_terminal_commit");
    assert_eq!(
        transport.calls().len(),
        expected_sends,
        "{label} performs no send after authority is revoked",
    );
    drop(consumer);
    revoker.join().unwrap();
}

/// Every blocking send-path boundary has a deterministic revocation barrier.
/// The post-boundary authority check runs before the next external or terminal
/// effect; no sleep or polling is involved.
#[test]
fn revocation_fences_queue_dispatch_and_terminal_boundaries() {
    for (label, action_id) in [
        ("after_queue_wait", "0198ab31-6c44-7e8a-b2bb-000000000819"),
        ("after_dispatch_cas", "0198ab31-6c44-7e8a-b2bb-000000000820"),
        (
            "before_terminal_commit",
            "0198ab31-6c44-7e8a-b2bb-000000000821",
        ),
    ] {
        assert_send_revocation_fence(label, action_id);
    }
}

/// A changed installed Extension manifest identity at the post-dispatch-CAS
/// barrier is rejected before transport without changing the valid active
/// Activation Manifest.
#[test]
fn extension_grant_switch_after_dispatch_cas_refuses_transport() {
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000825";
    let mut fixture = setup_file_send("extension-grant-switch-dispatch", action_id);
    let gate = {
        let mut registration = Connection::open(&fixture.module_path).unwrap();
        OutboundQueueGate::register(
            &fixture.config,
            &mut registration,
            &fixture.authority,
            &fixture.grant,
        )
        .unwrap()
    };
    let (at_boundary_tx, at_boundary_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = std::sync::Arc::new(std::sync::Mutex::new(release_rx));
    let hook_release = std::sync::Arc::clone(&release_rx);
    let barrier = std::sync::Arc::new(move |observed: &str| {
        if observed == "after_dispatch_cas" {
            at_boundary_tx.send(()).unwrap();
            hook_release.lock().unwrap().recv().unwrap();
        }
    });
    let switcher = {
        let runtime_path = fixture.runtime_path.clone();
        let authority = fixture.authority.clone();
        let graph_digest = fixture.grant.graph_digest().to_string();
        std::thread::spawn(move || {
            at_boundary_rx
                .recv_timeout(std::time::Duration::from_secs(30))
                .unwrap();
            let mut connection = Connection::open(runtime_path).unwrap();
            SqliteCoreStore::new(&mut connection)
                .unwrap()
                .install_host_capability_grant(
                    &authority,
                    EXTENSION_ID,
                    MODULE_ID,
                    1,
                    1,
                    &descriptor_digest(MODULE_ID),
                    2,
                    &digest(&json!({"extension_manifest_revision": 2})),
                    1,
                    &graph_digest,
                    &["host.ingress.submit"],
                )
                .unwrap();
            release_tx.send(()).unwrap();
        })
    };
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["must-not-send".to_string()],
    });
    let mut module_connection = Connection::open(&fixture.module_path).unwrap();
    let mut consumer = OutboundConsumer::new(
        fixture.config.clone(),
        Box::new(channel_clock()),
        &mut module_connection,
        &mut fixture.runtime,
        gate,
        Box::new(transport.clone()),
        &fixture.authority,
        &fixture.grant,
    )
    .unwrap();
    consumer.set_effect_barrier(barrier);
    let error = consumer.consume(&far_deadline()).unwrap_err();
    assert_eq!(error.code, codes::AUTHENTICATION_FAILED);
    assert!(transport.calls().is_empty());
    drop(consumer);
    switcher.join().unwrap();
}

fn assert_status_revocation_fence(label: &'static str, action_id: &'static str) {
    let mut fixture = setup_file_send(&format!("status-fence-{label}"), action_id);
    let transport = SharedTransport::new(true);
    transport.push(TransportSendResult::Timeout);
    {
        let mut module_connection = Connection::open(&fixture.module_path).unwrap();
        let gate = OutboundQueueGate::register(
            &fixture.config,
            &mut module_connection,
            &fixture.authority,
            &fixture.grant,
        )
        .unwrap();
        let mut consumer = OutboundConsumer::new(
            fixture.config.clone(),
            Box::new(channel_clock()),
            &mut module_connection,
            &mut fixture.runtime,
            gate,
            Box::new(transport.clone()),
            &fixture.authority,
            &fixture.grant,
        )
        .unwrap();
        assert!(matches!(
            &consumer.consume(&far_deadline()).unwrap()[0],
            dolly_channel::ConsumerOutcome::Pending { .. }
        ));
    }
    transport.push_status(
        action_id,
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec!["status-confirmed".to_string()],
        },
    );
    let (at_boundary_tx, at_boundary_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = std::sync::Arc::new(std::sync::Mutex::new(release_rx));
    let hook_release = std::sync::Arc::clone(&release_rx);
    let barrier = std::sync::Arc::new(move |observed: &str| {
        if observed == label {
            at_boundary_tx.send(()).unwrap();
            hook_release.lock().unwrap().recv().unwrap();
        }
    });
    let revoker = {
        let runtime_path = fixture.runtime_path.clone();
        let authority = fixture.authority.clone();
        std::thread::spawn(move || {
            at_boundary_rx
                .recv_timeout(std::time::Duration::from_secs(30))
                .unwrap();
            let mut connection = Connection::open(runtime_path).unwrap();
            SqliteCoreStore::new(&mut connection)
                .unwrap()
                .revoke_host_capability_grant(&authority, EXTENSION_ID, MODULE_ID)
                .unwrap();
            release_tx.send(()).unwrap();
        })
    };
    let mut module_connection = Connection::open(&fixture.module_path).unwrap();
    let gate = OutboundQueueGate::register(
        &fixture.config,
        &mut module_connection,
        &fixture.authority,
        &fixture.grant,
    )
    .unwrap();
    let mut consumer = OutboundConsumer::new(
        fixture.config.clone(),
        Box::new(channel_clock()),
        &mut module_connection,
        &mut fixture.runtime,
        gate,
        Box::new(transport.clone()),
        &fixture.authority,
        &fixture.grant,
    )
    .unwrap();
    consumer.set_effect_barrier(barrier);
    let error = consumer.reconcile().unwrap_err();
    assert_eq!(error.code, codes::AUTHENTICATION_FAILED);
    let expected_status_calls = usize::from(label != "before_status");
    assert_eq!(transport.status_calls().len(), expected_status_calls);
    drop(consumer);
    revoker.join().unwrap();
    let mut reopened_connection = Connection::open(&fixture.module_path).unwrap();
    let mut store =
        SqliteChannelStore::new(&mut reopened_connection, &fixture.principal, 1).unwrap();
    let record = store
        .list_pending_outbound()
        .unwrap()
        .into_iter()
        .find(|record| record.outbound_key == action_id)
        .unwrap();
    assert_eq!(record.entry.state, OutboundState::Dispatched);
}

#[test]
fn terminal_and_recovery_commits_notify_the_shared_gate_after_commit() {
    let mut terminal_fixture = setup("gate-terminal-wake");
    let terminal_action = "0198ab31-6c44-7e8a-b2bb-000000000826";
    commit_block(
        &mut terminal_fixture.harness,
        "gate-terminal-wake",
        "ingress",
        "terminal-block",
        send_block_for(
            MODULE_ID,
            terminal_action,
            &terminal_fixture.session,
            &["terminal"],
        ),
        vec!["page-c".to_string()],
    );
    let terminal_transport = SharedTransport::new(true);
    terminal_transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["terminal-id".to_string()],
    });
    let mut terminal_connection = reopen_module_store(&terminal_fixture);
    let mut terminal_consumer = open_consumer(
        channel_config(),
        Box::new(channel_clock()),
        &mut terminal_connection,
        &mut terminal_fixture.harness.connection,
        Box::new(terminal_transport),
        &terminal_fixture.harness.authority,
        &terminal_fixture.harness.grant,
    )
    .unwrap();
    let terminal_gate = terminal_consumer.gate();
    let before_terminal = terminal_gate.notification_generation();
    assert!(matches!(
        &terminal_consumer.consume(&far_deadline()).unwrap()[0],
        dolly_channel::ConsumerOutcome::Terminal { .. }
    ));
    assert!(terminal_gate.notification_generation() > before_terminal);
    drop(terminal_consumer);
    let terminal_record =
        SqliteChannelStore::new(&mut terminal_connection, &terminal_fixture.principal, 1)
            .unwrap()
            .find_outbound(terminal_action)
            .unwrap()
            .unwrap();
    assert!(terminal_record.entry.state.is_terminal());

    let mut recovery_fixture = setup("gate-recovery-wake");
    let recovery_action = "0198ab31-6c44-7e8a-b2bb-000000000827";
    commit_block(
        &mut recovery_fixture.harness,
        "gate-recovery-wake",
        "ingress",
        "recovery-block",
        send_block_for(
            MODULE_ID,
            recovery_action,
            &recovery_fixture.session,
            &["recovery"],
        ),
        vec!["page-c".to_string()],
    );
    let recovery_transport = SharedTransport::new(true);
    recovery_transport.push(TransportSendResult::Timeout);
    let mut recovery_connection = reopen_module_store(&recovery_fixture);
    let recovery_gate = {
        let mut consumer = open_consumer(
            channel_config(),
            Box::new(channel_clock()),
            &mut recovery_connection,
            &mut recovery_fixture.harness.connection,
            Box::new(recovery_transport.clone()),
            &recovery_fixture.harness.authority,
            &recovery_fixture.harness.grant,
        )
        .unwrap();
        assert!(matches!(
            &consumer.consume(&far_deadline()).unwrap()[0],
            dolly_channel::ConsumerOutcome::Pending { .. }
        ));
        consumer.gate()
    };
    recovery_transport.push_status(
        recovery_action,
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec!["recovery-id".to_string()],
        },
    );
    let before_recovery = recovery_gate.notification_generation();
    let mut consumer = open_consumer(
        channel_config(),
        Box::new(channel_clock()),
        &mut recovery_connection,
        &mut recovery_fixture.harness.connection,
        Box::new(recovery_transport),
        &recovery_fixture.harness.authority,
        &recovery_fixture.harness.grant,
    )
    .unwrap();
    assert_eq!(consumer.reconcile().unwrap(), 0);
    assert!(recovery_gate.notification_generation() > before_recovery);
    drop(consumer);
    let recovery_record =
        SqliteChannelStore::new(&mut recovery_connection, &recovery_fixture.principal, 1)
            .unwrap()
            .find_outbound(recovery_action)
            .unwrap()
            .unwrap();
    assert!(recovery_record.entry.state.is_terminal());
}

#[test]
fn gate_registration_is_unique_and_consumer_checks_the_full_identity() {
    let mut fixture = setup("gate-identity");
    let config = channel_config();
    let first = {
        let mut connection = reopen_module_store(&fixture);
        OutboundQueueGate::register(
            &config,
            &mut connection,
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .unwrap()
    };
    let second = {
        let mut connection = reopen_module_store(&fixture);
        OutboundQueueGate::register(
            &config,
            &mut connection,
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .unwrap()
    };
    assert!(std::sync::Arc::ptr_eq(&first, &second));
    let mut mismatched = config.clone();
    mismatched.outbound_limits.max_pending_total += 1;
    let wrong = {
        let mut connection = reopen_module_store(&fixture);
        OutboundQueueGate::register(
            &mismatched,
            &mut connection,
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .unwrap()
    };
    let mut module_connection = reopen_module_store(&fixture);
    let error = match OutboundConsumer::new(
        config,
        Box::new(channel_clock()),
        &mut module_connection,
        &mut fixture.harness.connection,
        wrong,
        Box::new(SharedTransport::new(true)),
        &fixture.harness.authority,
        &fixture.harness.grant,
    ) {
        Ok(_) => panic!("consumer accepted a gate with a different limits digest"),
        Err(error) => error,
    };
    assert_eq!(error.code, codes::AUTHENTICATION_FAILED);
}

/// Status checks are fenced immediately before and after every transport
/// status call and again before terminal commit.
#[test]
fn revocation_fences_every_status_boundary() {
    for (label, action_id) in [
        ("before_status", "0198ab31-6c44-7e8a-b2bb-000000000822"),
        ("after_status", "0198ab31-6c44-7e8a-b2bb-000000000823"),
        (
            "before_terminal_commit",
            "0198ab31-6c44-7e8a-b2bb-000000000824",
        ),
    ] {
        assert_status_revocation_fence(label, action_id);
    }
}

/// C: dispatch drains the durable FIFO in queued_seq order — the transport
/// call order equals the durable queued_seq order of the admitted rows, and
/// every row got a strict increasing durable sequence, never reordered by the
/// snapshot iteration.
#[test]
fn dispatch_drains_durable_fifo_order() {
    let mut fixture = setup("consumer-fifo-order");
    let a1 = "0198ab31-6c44-7e8a-b2bb-000000000901";
    let a2 = "0198ab31-6c44-7e8a-b2bb-000000000900";
    let mut block = send_block_for(MODULE_ID, a1, &fixture.session, &["first"]);
    let second = send_block_for(MODULE_ID, a2, &fixture.session, &["second"]);
    block["body"]["actions"]
        .as_array_mut()
        .unwrap()
        .push(second["body"]["actions"][0].clone());
    commit_block(
        &mut fixture.harness,
        "consumer-fifo-order",
        "ing-actions",
        "fifo-block",
        block,
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
    let mut consumer = open_consumer(
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
    let seq1 = reopened
        .find_outbound(a1)
        .unwrap()
        .unwrap()
        .entry
        .queued_seq;
    let seq2 = reopened
        .find_outbound(a2)
        .unwrap()
        .unwrap()
        .entry
        .queued_seq;
    assert!(
        seq1.unwrap() < seq2.unwrap(),
        "queued_seq strictly increasing"
    );
}

/// C/5: a Confirmed/Partial transport status with a MISSING transport id must
/// be rejected BEFORE frozen-envelope settlement — never fabricate IDs — and
/// the row stays Dispatched for a later status resolution.
#[test]
fn malformed_status_with_missing_id_is_rejected_before_settle() {
    let mut fixture = setup("consumer-malformed-status");
    let a1 = "0198ab31-6c44-7e8a-b2bb-000000000902";
    commit_block(
        &mut fixture.harness,
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
        let mut consumer = open_consumer(
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
    let mut consumer2 = open_consumer(
        channel_config(),
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        Box::new(transport.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer");
    let error = consumer2.reconcile().unwrap_err();
    assert_eq!(error.code, codes::MALFORMED_EVENT);
    let ledger = consumer2.ledger().unwrap();
    let entry = ledger.outbound_entry(a1).unwrap();
    assert_eq!(
        entry.state,
        OutboundState::Dispatched,
        "no settle on malformed status"
    );
    assert!(
        entry
            .pieces
            .iter()
            .all(|p| p.transport_message_id.is_none()),
        "no fabricated transport ids"
    );
}

/// Commit 3: the malformed-status matrix. Confirmed/Partial transport
/// statuses with missing, empty, duplicate, gapped, or out-of-range ids are
/// rejected BEFORE frozen-envelope settlement — never fabricated — and the
/// row stays Dispatched for a later status resolution.
#[test]
fn malformed_status_matrix_is_rejected_before_settle() {
    let cases: Vec<dolly_channel::transport::TransportStatusResult> = vec![
        // missing (empty vector)
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec![],
        },
        // empty id
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec!["".to_string()],
        },
        // duplicate id
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec!["dup".to_string(), "dup".to_string()],
        },
        // out-of-range (one id for two pieces)
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec!["only-one".to_string()],
        },
        // empty confirmed id
        dolly_channel::transport::TransportStatusResult::Partial {
            pieces: vec![
                dolly_channel::transport::TransportPieceOutcome::Confirmed {
                    ordinal: 0,
                    message_id: "".to_string(),
                },
                dolly_channel::transport::TransportPieceOutcome::Confirmed {
                    ordinal: 1,
                    message_id: "ok".to_string(),
                },
            ],
        },
        // duplicate confirmed id
        dolly_channel::transport::TransportStatusResult::Partial {
            pieces: vec![
                dolly_channel::transport::TransportPieceOutcome::Confirmed {
                    ordinal: 0,
                    message_id: "same".to_string(),
                },
                dolly_channel::transport::TransportPieceOutcome::Confirmed {
                    ordinal: 1,
                    message_id: "same".to_string(),
                },
            ],
        },
        // duplicate Partial ordinal
        dolly_channel::transport::TransportStatusResult::Partial {
            pieces: vec![
                dolly_channel::transport::TransportPieceOutcome::Confirmed {
                    ordinal: 0,
                    message_id: "zero-a".to_string(),
                },
                dolly_channel::transport::TransportPieceOutcome::Confirmed {
                    ordinal: 0,
                    message_id: "zero-b".to_string(),
                },
            ],
        },
        // gapped/out-of-range Partial ordinal set
        dolly_channel::transport::TransportStatusResult::Partial {
            pieces: vec![
                dolly_channel::transport::TransportPieceOutcome::Confirmed {
                    ordinal: 0,
                    message_id: "zero".to_string(),
                },
                dolly_channel::transport::TransportPieceOutcome::Confirmed {
                    ordinal: 2,
                    message_id: "two".to_string(),
                },
            ],
        },
        // gapped/out-of-range Partial (only one piece outcome for two pieces)
        dolly_channel::transport::TransportStatusResult::Partial {
            pieces: vec![dolly_channel::transport::TransportPieceOutcome::Confirmed {
                ordinal: 0,
                message_id: "only-0".to_string(),
            }],
        },
    ];
    for (case_index, status) in cases.into_iter().enumerate() {
        let mut fixture = setup(&format!("consumer-status-matrix-{case_index}"));
        let action_id = format!("0198ab31-6c44-7e8a-b2bb-0000{:04x}", 1000 + case_index);
        commit_block(
            &mut fixture.harness,
            &format!("consumer-status-matrix-{case_index}"),
            "ing-1",
            &format!("{action_id}-block"),
            send_block_for(
                MODULE_ID,
                &action_id,
                &fixture.session,
                &["hi one", "hi two"],
            ),
            vec!["page-c".to_string()],
        );
        // Note: the send has ONE piece; out-of-range/duplicate cases are
        // exercised by giving the status more ids than the send's pieces.
        let transport = SharedTransport::new(true);
        transport.push(TransportSendResult::Timeout);
        let mut module_conn = reopen_module_store(&fixture);
        {
            let mut consumer = open_consumer(
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
        let mut consumer2 = open_consumer(
            channel_config(),
            Box::new(channel_clock()),
            &mut module_conn,
            &mut fixture.harness.connection,
            Box::new(transport.clone()),
            &fixture.harness.authority,
            &fixture.harness.grant,
        )
        .expect("consumer");
        let error = consumer2.reconcile().unwrap_err();
        assert_eq!(
            error.code,
            codes::MALFORMED_EVENT,
            "malformed status {case_index} is explicitly rejected",
        );
        let ledger = consumer2.ledger().unwrap();
        let entry = ledger.outbound_entry(&action_id).unwrap();
        assert_eq!(
            entry.state,
            OutboundState::Dispatched,
            "no settle on malformed status {case_index}"
        );
        assert!(
            entry
                .pieces
                .iter()
                .all(|p| p.transport_message_id.is_none()),
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
    let operation_digest = dolly_canonical_json::canonicalize(&block)
        .unwrap()
        .1
        .to_canonical_string();
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
    let mut consumer = open_consumer(
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
        outcomes.len(),
        0,
        "an Ingress-only Block never becomes an Action without manifest selection"
    );
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(
        consumer.pending_outbound().unwrap().is_empty(),
        "zero durable outbound rows"
    );
}

/// Injected AssetPreparation seam test double for the production consumer.
/// Shares its recorded premises and refusal via an Arc so the test can
/// observe exactly what the sealed consumer requested (premise direction).
#[derive(Clone, Default)]
struct RefusingAssetPreparation {
    refuse_code: Option<String>,
    inner: std::sync::Arc<std::sync::Mutex<RefusingInner>>,
}

#[derive(Default)]
struct RefusingInner {
    prepared: Vec<AssetPremise>,
}

impl RefusingAssetPreparation {
    fn refusing(code: &str) -> Self {
        Self {
            refuse_code: Some(code.to_string()),
            ..Self::default()
        }
    }
    fn prepared(&self) -> Vec<AssetPremise> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .prepared
            .clone()
    }
}

impl AssetPreparation for RefusingAssetPreparation {
    fn prepare_assets(
        &mut self,
        premises: &[AssetPremise],
    ) -> Result<Vec<AssetLeaseProof>, dolly_channel::ChannelError> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .prepared
            .extend_from_slice(premises);
        match &self.refuse_code {
            Some(code) => Err(dolly_channel::ChannelError::new(
                code.clone(),
                false,
                ChannelOutcome::NotApplied,
                "asset not prepared under the Channel authority",
            )),
            None => Ok(premises
                .iter()
                .map(|premise| AssetLeaseProof {
                    value: json!({ "lease_id": format!("lease-{}", premise.ordinal) }),
                })
                .collect()),
        }
    }

    fn revalidate_leases(
        &mut self,
        _proofs: &[AssetLeaseProof],
    ) -> Result<(), dolly_channel::ChannelError> {
        Ok(())
    }
}

/// A committed send Block whose `arguments.parts` is exactly the given list.
fn send_block_with_asset_parts(
    module_id: &str,
    action_id: &str,
    session_id: &str,
    parts: Value,
) -> Value {
    let mut block = send_block_for(module_id, action_id, session_id, &["Hello."]);
    block["body"]["actions"][0]["arguments"]["parts"] = parts;
    block
}

fn asset_part(asset_id: &str, media_type: &str) -> Value {
    json!({
        "kind": "asset",
        "asset_id": asset_id,
        "media_type": media_type
    })
}

#[test]
fn targeted_asset_send_refused_by_injected_seam_yields_frozen_rejected_with_zero_effect() {
    const ASSET_ID: &str = "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let mut fixture = setup("consumer-asset-refuse");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000840";
    commit_block(
        &mut fixture.harness,
        "consumer-asset-refuse",
        "ing-1",
        &format!("{action_id}-block"),
        send_block_with_asset_parts(
            MODULE_ID,
            action_id,
            &fixture.session,
            json!([
                { "kind": "text", "text": "Hello.", "format": "plain" },
                asset_part(ASSET_ID, "image/png")
            ]),
        ),
        vec!["page-c".to_string()],
    );
    let transport = SharedTransport::new(true);
    let assets = RefusingAssetPreparation::refusing(codes::ASSET_IMPORT_FAILED);
    let mut module_conn = reopen_module_store(&fixture);
    let config = channel_config();
    let gate = OutboundQueueGate::register(
        &config,
        &mut module_conn,
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .unwrap();
    let mut consumer = OutboundConsumer::with_asset_preparation(
        config,
        Box::new(channel_clock()),
        &mut module_conn,
        &mut fixture.harness.connection,
        gate,
        Box::new(transport.clone()),
        Box::new(assets.clone()),
        &fixture.harness.authority,
        &fixture.harness.grant,
    )
    .expect("consumer registration");

    let outcomes = consumer.consume(&far_deadline()).expect("consume");
    assert_eq!(
        outcomes.len(),
        1,
        "one frozen Rejected outcome, never a silent drop"
    );
    match outcomes.into_iter().next().unwrap() {
        dolly_channel::ConsumerOutcome::Rejected {
            action_id: rejected_id,
            error,
        } => {
            assert_eq!(rejected_id, action_id);
            assert_eq!(error.code, codes::ASSET_IMPORT_FAILED);
            assert!(!error.retryable);
            assert_eq!(error.outcome, ChannelOutcome::NotApplied);
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0, "zero transport calls");
    drop(consumer);

    // No Prepared row, no queue occupancy, no echo marker.
    let mut reopened = SqliteChannelStore::new(&mut module_conn, &fixture.principal, 1).unwrap();
    assert!(
        reopened.find_outbound(action_id).unwrap().is_none(),
        "no durable Prepared row"
    );
    assert!(
        reopened.list_pending_outbound().unwrap().is_empty(),
        "no durable queue occupancy"
    );
    drop(reopened);

    // Premise direction intact: the seam received ONLY the committed Action's
    // AssetId/media_type/view (no raw path, no bytes, no caller-supplied full
    // AssetRef), in Action part order.
    let prepared = assets.prepared();
    assert_eq!(prepared.len(), 1);
    assert_eq!(prepared[0].ordinal, 1);
    assert_eq!(prepared[0].asset_id, ASSET_ID);
    assert_eq!(prepared[0].media_type, "image/png");
    assert_eq!(prepared[0].view, None);
}

#[test]
fn targeted_asset_send_is_never_silently_dropped_by_the_production_consumer() {
    const ASSET_ID: &str = "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    // A canonical asset part under the accepted default text-only seam used
    // to vanish without an outcome; it must now surface one frozen
    // zero-effect Rejected outcome. A noncanonical asset part must surface
    // the same way (schema/boundary rejection), never a silent drop.
    for (label, parts, expected_code) in [
        (
            "default-deny",
            json!([asset_part(ASSET_ID, "image/png")]),
            codes::UNSUPPORTED_MODALITY.to_string(),
        ),
        (
            "noncanonical",
            json!([asset_part(ASSET_ID, "Image/PNG")]),
            codes::MALFORMED_EVENT.to_string(),
        ),
    ] {
        let mark = format!("non-silent-{label}");
        let mut fixture = setup(&mark);
        let action_id = "0198ab31-6c44-7e8a-b2bb-000000000841";
        commit_block(
            &mut fixture.harness,
            &mark,
            "ing-1",
            &format!("{action_id}-block"),
            send_block_with_asset_parts(MODULE_ID, action_id, &fixture.session, parts),
            vec!["page-c".to_string()],
        );
        let transport = SharedTransport::new(true);
        let mut module_conn = reopen_module_store(&fixture);
        let mut consumer = open_consumer(
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
            outcomes.len(),
            1,
            "{label}: exactly one Rejected outcome, never a silent drop"
        );
        match outcomes.into_iter().next().unwrap() {
            dolly_channel::ConsumerOutcome::Rejected {
                action_id: rejected_id,
                error,
            } => {
                assert_eq!(rejected_id, action_id, "{label}");
                assert_eq!(error.code, expected_code, "{label}");
                assert!(!error.retryable, "{label}");
                assert_eq!(error.outcome, ChannelOutcome::NotApplied, "{label}");
            }
            other => panic!("{label}: expected Rejected, got {other:?}"),
        }
        assert_eq!(transport.calls().len(), 0, "{label}: zero transport calls");
        assert!(
            consumer.pending_outbound().unwrap().is_empty(),
            "{label}: zero durable outbound rows"
        );
        drop(consumer);
    }
}
