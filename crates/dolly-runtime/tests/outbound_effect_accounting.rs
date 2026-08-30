//! Deterministic proofs for the runtime `ChannelOutboundRunReport` effect
//! accounting (direct transport sent/confirmed evidence):
//!
//! - a pre-effect refusal (asset/authority failure before transport) is a
//!   zero-effect terminal `Failed` row and is reported transported = 0 with
//!   zero transport requests, not as a successful dispatch;
//! - one confirmed send is reported transported = 1 with the terminal
//!   `Confirmed` outcome;
//! - status-first recovery is idempotent: an effect settled by a status
//!   query is never counted twice across consume/reconcile/replay passes;
//! - an unknown (lost-response) send is never falsely reported confirmed.

use std::sync::Arc;

use dolly_canonical_json::canonicalize;
use dolly_channel::{
    ChannelConfig, ChannelConfigBuilder, ChannelEventContent, ChannelPrincipal, EventKind,
    IngressOutcome, OutboundState, VirtualClock,
};
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand, TransitionOutcome,
};
use dolly_runtime::{
    ChannelOutboundRoute, authenticated_channel_event, install_channel_store_schema,
    open_channel_inbound_route,
};
use dolly_storage::{
    HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore, create_host_ingress_schema,
};
use rusqlite::Connection;
use serde_json::{json, Value};

const CHANNEL_NOW: &str = "2026-08-28T00:00:00.000000Z";
const TARGET_PAGE: &str = "page-web-primary";
const ROUTE_INPUT_PAGE: &str = "page-in";
const EXTENSION_ID: &str = "org.dolly.channel";

fn canonical_digest(value: &Value) -> String {
    canonicalize(value).unwrap().1.to_canonical_string()
}

fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: CHANNEL_NOW.into(),
        ..Default::default()
    }
}

fn descriptor(module_id: &str) -> Value {
    json!({
        "schema": "dolly.module-descriptor/v1",
        "module_id": module_id,
        "descriptor_revision": 1,
        "display_name": module_id,
        "accepts": {"summary":"input","part_kinds":["text","asset"],"action_names":[]},
        "emits": {"summary":"output","part_kinds":["text","asset"],"action_names":["org.dolly.channel.send"]},
        "actions": [{"name":"org.dolly.channel.send","summary":"send"}],
        "activation_replay_contract": {"mode":"fenced_replay","evidence":"pure_compute","ledger":null},
        "trust": "trusted",
        "metadata": {}
    })
}

fn install_config(store: &mut SqliteCoreStore<'_>, mark: &str) {
    let effective_config = json!({
        "execution_timeout_ms": 120000,
        "lease_grace_ms": 30000,
        "fencing_grace_ms": 5000,
        "extension_connection_id": format!("{mark}-connection"),
        "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000110",
        "worker_epoch_fence": 17
    });
    let command = CoreCommand::InstallConfig(InstallConfigCommand {
        command_id: format!("{mark}-config"),
        revision: 1,
        digest: canonical_digest(&effective_config),
        effective_config,
    });
    let transition = store.transact(&command, &input()).unwrap();
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    store.bootstrap_host_connection().unwrap();
}

fn graph_snapshot(module_id: &str, output_pages: &[&str]) -> Value {
    let descriptor = descriptor(module_id);
    let mut descriptors = serde_json::Map::new();
    descriptors.insert(
        module_id.into(),
        json!({
            "module_id": module_id,
            "descriptor_revision": 1,
            "source_descriptor_digest": canonical_digest(&descriptor),
            "owner_extension_id": EXTENSION_ID,
            "value": descriptor
        }),
    );
    let mut output = serde_json::Map::new();
    output.insert(module_id.into(), json!(output_pages));
    json!({
        "receiving_module": module_id,
        "input_pages": {module_id: [ROUTE_INPUT_PAGE]},
        "output_pages": output,
        "subscriptions": {},
        "descriptors": descriptors,
        "authorized_metadata_namespaces": ["org.dolly.channel"],
        "authorized_action_names": ["org.dolly.channel.send"]
    })
}

/// Real runtime DB + config + producer graph + sealed authority + grant +
/// Host ingress slice + module-scoped Channel store schema — the exact state
/// the runtime registration binds to.
fn harness(mark: &str) -> (Connection, Connection, HostConnectionAuthority, HostCapabilityGrant) {
    let mut runtime = Connection::open_in_memory().unwrap();
    let authority = {
        let mut store = SqliteCoreStore::new(&mut runtime).unwrap();
        install_config(&mut store, mark);
        let body = graph_snapshot("web-channel", &[TARGET_PAGE]);
        let transition = store
            .transact(
                &CoreCommand::InstallGraph(InstallGraphCommand {
                    command_id: format!("{mark}-graph"),
                    revision: 1,
                    digest: canonical_digest(&body),
                    graph: body,
                }),
                &input(),
            )
            .unwrap();
        assert_eq!(transition.outcome, TransitionOutcome::Committed);
        let authority = store.authenticated_host_connection().unwrap();
        store
            .install_host_capability_grant(
                &authority,
                EXTENSION_ID,
                "web-channel",
                1,
                1,
                &canonical_digest(&descriptor("web-channel")),
                1,
                &canonical_digest(&json!({"manifest": 1})),
                1,
                &canonical_digest(&graph_snapshot("web-channel", &[TARGET_PAGE])),
                &["host.ingress.submit"],
            )
            .unwrap();
        authority
    };
    create_host_ingress_schema(&mut runtime).unwrap();
    let grant = {
        let store = SqliteCoreStore::new(&mut runtime).unwrap();
        store
            .current_host_capability_grant(&authority, EXTENSION_ID, "web-channel")
            .unwrap()
            .unwrap()
    };
    let mut module_store = Connection::open_in_memory().unwrap();
    install_channel_store_schema(&mut module_store).unwrap();
    (runtime, module_store, authority, grant)
}

fn channel_config() -> ChannelConfig {
    ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .target_pages(&[TARGET_PAGE])
        .build()
}

fn multimodal_config() -> ChannelConfig {
    ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .target_pages(&[TARGET_PAGE])
        .accepted_modalities(&["text", "asset"])
        .build()
}

fn far_deadline_str() -> String {
    dolly_channel::timestamp_plus_seconds(CHANNEL_NOW, 60)
}

fn message(event_key: &str, text: &str) -> ChannelEventContent {
    ChannelEventContent {
        channel_id: "web-primary".to_string(),
        transport: "web".to_string(),
        external_conversation_id: "conv-1".to_string(),
        external_message_id: event_key.to_string(),
        sender_class: "user".to_string(),
        sender_id: format!("sender-{event_key}"),
        text: text.to_string(),
        received_at: CHANNEL_NOW.parse().unwrap(),
        event_kind: EventKind::Message,
        references_external_message_id: None,
    }
}

/// One targeted send Action with the authoritative contract binding.
fn send_action(module_id: &str, action_id: &str, session_id: &str, parts: Vec<Value>) -> Value {
    let mut action = json!({
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
            "action_contract_digest": null,
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
    });
    let contract = action["contract_binding"]["action_contract"].clone();
    action["contract_binding"]["action_contract_digest"] = json!(canonical_digest(&contract));
    json!({
        "schema": "dolly.block/v1",
        "id": format!("block-{action_id}"),
        "body": {
            "description": "model response",
            "parts": [],
            "actions": [action]
        }
    })
}

fn route_send_block(module_id: &str, action_id: &str, session_id: &str, texts: &[&str]) -> Value {
    let parts: Vec<Value> = texts
        .iter()
        .map(|t| json!({"kind": "text", "text": t, "format": "plain"}))
        .collect();
    send_action(module_id, action_id, session_id, parts)
}

fn asset_part(asset_id: &str, media_type: &str) -> Value {
    json!({
        "kind": "asset",
        "asset_id": asset_id,
        "media_type": media_type
    })
}

/// A deterministic shared status-capable transport; records every call.
#[derive(Clone, Default)]
struct RouteSharedTransport {
    idempotent: bool,
    inner: Arc<parking_lot::Mutex<RouteSharedInner>>,
}

#[derive(Default)]
struct RouteSharedInner {
    script: Vec<dolly_channel::transport::TransportSendResult>,
    calls: Vec<dolly_channel::transport::TransportSendRequest>,
    status_script: Vec<(String, dolly_channel::transport::TransportStatusResult)>,
}

impl RouteSharedTransport {
    fn new(idempotent: bool) -> Self {
        Self {
            idempotent,
            inner: Arc::new(parking_lot::Mutex::new(RouteSharedInner::default())),
        }
    }
    fn push(&self, result: dolly_channel::transport::TransportSendResult) {
        self.inner.lock().script.push(result);
    }
    fn push_status(
        &self,
        action_id: &str,
        result: dolly_channel::transport::TransportStatusResult,
    ) {
        self.inner
            .lock()
            .status_script
            .push((action_id.to_string(), result));
    }
    fn calls(&self) -> Vec<dolly_channel::transport::TransportSendRequest> {
        self.inner.lock().calls.clone()
    }
}

impl dolly_channel::ChannelTransport for RouteSharedTransport {
    fn idempotency_supported(&self) -> bool {
        self.idempotent
    }
    fn send(
        &mut self,
        request: &dolly_channel::transport::TransportSendRequest,
    ) -> dolly_channel::transport::TransportSendResult {
        let mut inner = self.inner.lock();
        inner.calls.push(request.clone());
        if inner.script.is_empty() {
            return dolly_channel::transport::TransportSendResult::Timeout;
        }
        inner.script.remove(0)
    }
    fn status(
        &mut self,
        request: &dolly_channel::transport::TransportStatusRequest,
    ) -> dolly_channel::transport::TransportStatusResult {
        let mut inner = self.inner.lock();
        let pos = inner
            .status_script
            .iter()
            .position(|(id, _)| id == &request.action_id);
        match pos {
            Some(idx) => inner.status_script.remove(idx).1.clone(),
            None => dolly_channel::transport::TransportStatusResult::Unknown,
        }
    }
}

/// Commit a targeted send block durably and persist an ACTIVATED manifest
/// selecting it — the exact input the sealed outbound consumer drains.
fn commit_send_and_activate(
    connection: &mut Connection,
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    mark: &str,
    page: &str,
    block: Value,
    frozen_config: ChannelConfig,
) {
    let action_ids: Vec<String> = block["body"]["actions"]
        .as_array()
        .expect("actions")
        .iter()
        .map(|a| a["action_id"].as_str().expect("action id").to_string())
        .collect();
    let block_id = format!("send-{mark}");
    // 2. Commit the send block to the durable Core journal under the
    //    recording model source.
    let transition = SqliteCoreStore::new(connection)
        .unwrap()
        .transact(
            &CoreCommand::Ingress(dolly_core_reducer::IngressCommand {
                command_id: format!("{mark}-send"),
                runtime_source: "model/web-channel".to_string(),
                ingress_key: format!("{mark}-send-key"),
                operation_digest: canonical_digest(&block),
                block_id: block_id.clone(),
                block: block.clone(),
                pages: vec![page.to_string()],
            }),
            &input(),
        )
        .unwrap();
    assert_eq!(transition.outcome, TransitionOutcome::Committed);

    // 3. An activated manifest selects that block as the sole input item.
    let activation_id = format!("activation-{mark}");
    let occurrences: Vec<Value> = vec![json!({"page_id": page, "page_seq": 1, "commit_seq": 1})];
    let mut config = frozen_config;
    let principal_account =
        dolly_channel::ChannelPrincipal::from_authority_grant(authority, grant)
            .unwrap()
            .account()
            .to_string();
    config.transport_account = principal_account;
    let effective_config = serde_json::to_value(config.clone()).unwrap();
    let effective_config_digest = canonical_digest(&effective_config);
    let mut manifest = json!({
        "schema": "dolly.activation-manifest/v1",
        "activation_id": activation_id.clone(),
        "module_id": "web-channel",
        "reason": "input",
        "created_at": CHANNEL_NOW,
        "graph_revision": 1,
        "config_revision": config.revision,
        "descriptor_revision": 1,
        "effective_config": effective_config,
        "effective_config_digest": effective_config_digest,
        "required_frame_bytes": 2048,
        "required_frame_nesting_depth": 4,
        "input_items": [{
            "block": block,
            "occurrences": occurrences,
            "occurrence_count": 1
        }],
        "cursor_spans": [],
        "lossy_gaps": [],
        "output_page_ids": [],
        "neighbor_descriptors": [],
        "deadline": far_deadline_str()
    });
    let manifest_digest = canonical_digest(&manifest);
    manifest["manifest_digest"] = json!(manifest_digest);
    let _ = &action_ids;
    let transition = SqliteCoreStore::new(connection)
        .unwrap()
        .transact(
            &CoreCommand::BuildManifest(dolly_core_reducer::BuildManifestCommand {
                command_id: format!("{mark}-build"),
                activation_id: activation_id.clone(),
                manifest,
                expected_graph_revision: None,
                expected_descriptor_revision: None,
            }),
            &input(),
        )
        .unwrap();
    assert_eq!(transition.outcome, TransitionOutcome::Committed);

    // 4. Activate: lease + dispatch started makes this authoritative.
    let lease_id = format!("lease-{mark}");
    let token_digest =
        canonical_digest(&json!({"activation_id": activation_id, "lease_id": lease_id}));
    let mut store = SqliteCoreStore::new(connection).unwrap();
    let lease = store.transact(
        &CoreCommand::IssueLease(dolly_core_reducer::IssueLeaseCommand {
            command_id: format!("{mark}-lease"),
            activation_id: activation_id.clone(),
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
        &input(),
    );
    assert_eq!(lease.unwrap().outcome, TransitionOutcome::Committed);
    let dispatch = store.transact(
        &CoreCommand::DispatchLease(dolly_core_reducer::DispatchLeaseCommand {
            command_id: format!("{mark}-dispatch"),
            activation_id: activation_id.clone(),
            lease_id,
            dispatch_state: dolly_core_reducer::DispatchState::Started,
            reservation_id: None,
            request_id: None,
            extension_connection_id: None,
            incarnation_revision: None,
            frame_digest: None,
        }),
        &input(),
    );
    assert_eq!(dispatch.unwrap().outcome, TransitionOutcome::Committed);
}

/// Real registration path: an authenticated text premise creates the
/// account-owned session, exactly what every outbound probe starts from.
fn consumer_scaffold(
    mark: &str,
    config: ChannelConfig,
) -> (
    Connection,
    Connection,
    HostConnectionAuthority,
    HostCapabilityGrant,
    ChannelConfig,
    VirtualClock,
    String,
) {
    let (mut runtime, mut module_store, authority, grant) = harness(mark);
    let clock = VirtualClock::at(CHANNEL_NOW.parse().unwrap());
    {
        let mut receiver = open_channel_inbound_route(
            &mut runtime,
            &mut module_store,
            config.clone(),
            Box::new(clock.clone()),
            &authority,
            &grant,
        )
        .expect("channel route registration");
        let event = authenticated_channel_event(
            &authority,
            &grant,
            config.revision,
            message("premise-1", "What is the weather?"),
        )
        .expect("authenticated event");
        assert!(
            matches!(receiver.ingest_event(&event), IngressOutcome::Committed { .. }),
            "the upstream premise commits through the route"
        );
    }
    let principal = ChannelPrincipal::from_authority_grant(&authority, &grant).unwrap();
    let session_id = dolly_channel::ids::dolly_session_id(principal.account(), "conv-1");
    (
        runtime,
        module_store,
        authority,
        grant,
        config,
        clock,
        session_id,
    )
}

/// One bounded consumer pass over the committed send block.
fn consume(
    module_store: &mut Connection,
    runtime: &mut Connection,
    clock: &VirtualClock,
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config: &ChannelConfig,
    transport: RouteSharedTransport,
) -> dolly_runtime::ChannelOutboundRunReport {
    let route = ChannelOutboundRoute::register(config.clone(), module_store, authority, grant)
        .expect("outbound route registration");
    route
        .consume_once(
            module_store,
            runtime,
            Box::new(clock.clone()),
            Box::new(transport),
            &far_deadline_str(),
        )
        .expect("consumer pass must succeed")
}

// ---------------------------------------------------------------------------
// 1. Pre-effect refusal terminal is never reported transported.
// ---------------------------------------------------------------------------

#[test]
fn pre_effect_asset_refusal_is_reported_zero_effect_not_transported() {
    let config = multimodal_config();
    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("acc-pre", config);
    // A canonical but never-imported AssetRef: authorize_send admits the
    // asset part under the declared modality, and the runtime's unbound
    // Asset seam refuses before any transport (no bound Asset store).
    let canonical_zero =
        dolly_channel::asset::AssetId::from_digest([0u8; 32]).as_str().to_string();
    let block = send_action(
        "web-channel",
        "0198ab31-6c44-7e8a-b2bb-000000000901",
        &session_id,
        vec![asset_part(&canonical_zero, "image/png")],
    );
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "acc-pre",
        ROUTE_INPUT_PAGE,
        block,
        config.clone(),
    );
    let transport = RouteSharedTransport::new(true);
    let report = consume(
        &mut module_store,
        &mut runtime,
        &clock,
        &authority,
        &grant,
        &config,
        transport.clone(),
    );

    // The refusal is a durable terminal `Failed` row with zero transport
    // effect: transported MUST be 0 and rejected MUST carry the asset code.
    assert_eq!(
        report.transported, 0,
        "a pre-effect refusal is never transported"
    );
    assert_eq!(transport.calls().len(), 0, "zero transport requests");
    assert_eq!(report.rejected, 1, "the zero-effect refusal counts rejected");
    assert_eq!(
        report.rejected_codes,
        vec!["CHANNEL_ASSET_IMPORT_FAILED"],
        "the zero-effect refusal reports its asset-authority code"
    );
    assert_eq!(report.pending, 0);
    assert_eq!(report.terminal.len(), 1, "the refusal is a durable terminal");
    match &report.terminal[0] {
        dolly_channel::ConsumerOutcome::Terminal {
            state: OutboundState::Failed,
            ..
        } => {}
        other => panic!("expected terminal Failed, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 2. One confirmed send is reported transported once.
// ---------------------------------------------------------------------------

#[test]
fn confirmed_send_is_reported_transported_exactly_once() {
    let config = channel_config();
    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("acc-conf", config);
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000902";
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "acc-conf",
        ROUTE_INPUT_PAGE,
        route_send_block("web-channel", action_id, &session_id, &["confirmed hello"]),
        config.clone(),
    );
    let transport = RouteSharedTransport::new(true);
    transport.push(dolly_channel::transport::TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-conf-1".to_string()],
    });
    let report = consume(
        &mut module_store,
        &mut runtime,
        &clock,
        &authority,
        &grant,
        &config,
        transport.clone(),
    );
    assert_eq!(transport.calls().len(), 1, "one transport call");
    assert_eq!(report.transported, 1, "the confirmed send is transported");
    assert_eq!(report.rejected, 0);
    assert_eq!(report.pending, 0);
    assert_eq!(report.remaining, 0);
    assert_eq!(report.terminal.len(), 1);
    match &report.terminal[0] {
        dolly_channel::ConsumerOutcome::Terminal {
            state: OutboundState::Confirmed,
            ..
        } => {}
        other => panic!("expected terminal Confirmed, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 3. Status-first recovery is idempotent (no double count across passes).
// ---------------------------------------------------------------------------

#[test]
fn status_first_recovery_never_counts_the_same_effect_twice() {
    let config = channel_config();
    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("acc-status", config);
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000903";
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "acc-status",
        ROUTE_INPUT_PAGE,
        route_send_block("web-channel", action_id, &session_id, &["lost response"]),
        config.clone(),
    );

    // Pass 1: the transport loses the response (Timeout) — the row is
    // dispatched/unknown, NEVER reported transported.
    let lost = RouteSharedTransport::new(true);
    let pass1 = consume(
        &mut module_store,
        &mut runtime,
        &clock,
        &authority,
        &grant,
        &config,
        lost,
    );
    assert_eq!(pass1.transported, 0, "a lost send is never transported");
    assert_eq!(pass1.pending, 1, "the unknown send stays pending");
    assert!(pass1.terminal.is_empty());

    // Pass 2: status-first recovery settles the dispatched row via an
    // authoritative status query; the settlement itself emits NO report
    // outcome, so the pass reports zero transported.
    let reporting = RouteSharedTransport::new(true);
    reporting.push_status(
        action_id,
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec!["transport-status-1".to_string()],
        },
    );
    let pass2 = consume(
        &mut module_store,
        &mut runtime,
        &clock,
        &authority,
        &grant,
        &config,
        reporting,
    );
    assert_eq!(pass2.transported, 0, "settling via status is not a new dispatch");
    assert_eq!(pass2.remaining, 0, "status-first settle drains the dispatched row");
    assert!(pass2.terminal.is_empty(), "the settle pass emits no terminal outcome");

    // Pass 3: the replay re-observes the single durable Confirmed row. The
    // effect is counted exactly once across all three passes.
    let replay = RouteSharedTransport::new(true);
    let pass3 = consume(
        &mut module_store,
        &mut runtime,
        &clock,
        &authority,
        &grant,
        &config,
        replay,
    );
    assert_eq!(pass3.transported, 1, "the stored Confirmed row is observed once");
    assert_eq!(
        pass1.transported + pass2.transported + pass3.transported,
        1,
        "the same effect is never counted twice across consume/reconcile/replay"
    );
    match &pass3.terminal[0] {
        dolly_channel::ConsumerOutcome::Terminal {
            state: OutboundState::Confirmed,
            ..
        } => {}
        other => panic!("expected terminal Confirmed on replay, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 4. Unknown outcomes are never falsely confirmed.
// ---------------------------------------------------------------------------

#[test]
fn unknown_outcome_is_never_reported_as_confirmed_or_transported() {
    let config = channel_config();
    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("acc-unknown", config);
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000904";
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "acc-unknown",
        ROUTE_INPUT_PAGE,
        route_send_block("web-channel", action_id, &session_id, &["lost forever"]),
        config.clone(),
    );

    let lost = RouteSharedTransport::new(true);
    let pass1 = consume(
        &mut module_store,
        &mut runtime,
        &clock,
        &authority,
        &grant,
        &config,
        lost,
    );
    assert_eq!(pass1.transported, 0);
    assert!(pass1.terminal.is_empty(), "no fabricated outcome after a lost send");

    // A transport that only answers Unknown: the row stays dispatched with
    // no sent evidence, and no later pass may report it confirmed.
    let stale = RouteSharedTransport::new(true);
    stale.push_status(action_id, dolly_channel::transport::TransportStatusResult::Unknown);
    let pass2 = consume(
        &mut module_store,
        &mut runtime,
        &clock,
        &authority,
        &grant,
        &config,
        stale,
    );
    assert_eq!(pass2.transported, 0, "unknown is never transported");
    assert!(pass2.terminal.is_empty(), "unknown never becomes a confirmed terminal");
    assert!(
        pass2.remaining >= 1,
        "the unresolved dispatched row stays unresolved, not failed/confirmed"
    );

    // A fully silent replay pass: still never transported, still no terminal.
    let again = RouteSharedTransport::new(true);
    let pass3 = consume(
        &mut module_store,
        &mut runtime,
        &clock,
        &authority,
        &grant,
        &config,
        again,
    );
    assert_eq!(pass3.transported, 0, "silent replay is never transported");
    assert!(pass3.terminal.is_empty(), "silent replay fabricates no confirmation");
}
