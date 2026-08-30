//! Authoritative G4 conformance for the WP-010 Asset and WP-013A/013B
//! Channel content/channel substrate.
//!
//! This suite freezes the PRODUCT_RED/acceptance matrix for G4. The matrix
//! fixture is the authoritative document: every case names its expected
//! outcome (`product_red`, `pass`, or `blocked`), the stable interface seam
//! it expects from Asset and Channel, and the exact causal red when product
//! behavior is missing.
//!
//! Executables here split into four groups:
//!
//! - fail-closed controls (`G4-CONTROL-*`, expected `pass`): negative
//!   authority and premise-direction properties already enforced by the
//!   accepted G1-G3 boundaries. They run against the current product and must
//!   stay green.
//! - verified crate contracts (`G4-WP010-*`, `G4-WP013A-*`, expected
//!   `pass`): the probe drives the integrated surfaces — the `dolly-asset`
//!   and `dolly-channel` public surfaces directly, AND the integrator-assigned
//!   runtime registrations (`dolly_runtime::AssetHostRoute` and
//!   `dolly-runtime`'s Channel inbound route) that expose them to activated
//!   modules under the sealed current Host authority and capability grant.
//!   Where the behavior meets the spec, the case is a real green acceptance
//!   and a regression here is a product violation.
//! - product-red probes (`G4-WP010-*`, `G4-WP013A-*`, expected
//!   `product_red`): each first drives the harness (config install, graph
//!   install, durable Core ingress commit) AND the integrated surface for the
//!   seam it names, so every contract exercised above is proven working; only
//!   the exact absent Host/runtime adapter seam named in `causal_red` turns
//!   the case red. With the integrator-assigned runtime wiring complete, the
//!   Asset Host seam (A: `AssetHostRoute` routes an already Host-authorized
//!   Asset capability/import request into `AssetService`), the Core ingress
//!   Host seam (B: the runtime Channel inbound route binds
//!   `host.ingress.submit`/`host.ingress.status` to the real durable Host
//!   ingress slice), and the committed-Action outbound consumer seam
//!   (D: `ChannelOutboundRoute` owns the one identity-bound gate+limiter,
//!   injects it into the sealed `OutboundConsumer`, and runs a bounded
//!   status-first consumer/recovery loop over an injected status-capable
//!   transport) are all wired: the matrix is fully green with no executable
//!   PRODUCT_RED.
//! - blocked declarations (`G4-WP013B-*`, expected `product_red` with
//!   `blocked: true`): retained in the matrix, asserted to be blocked, and
//!   never executed until WP-010 and WP-013A interfaces freeze.
//!
//! Premise direction is invariant: producer/upstream premise -> durable
//! explicit premise -> consumer/downstream only. There is no echo, reverse
//! authority, cross-Extension leakage, or opposite-direction premise; the
//! controls prove the Core transaction enforces that today.

use dolly_canonical_json::canonicalize;
use dolly_core_domain::{ActionName, ExtensionId};
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, IngressCommand, InstallConfigCommand, InstallGraphCommand,
    Transition, TransitionOutcome,
};
use dolly_storage::{
    HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore,
    create_host_ingress_schema,
};
use rusqlite::Connection;
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Integrated crate surfaces under test (dev-dependencies).
// ---------------------------------------------------------------------------

use dolly_asset::clock::FixedClock;
use dolly_asset::config::{ReplicaConfig, ResolvedAssetConfig};
use dolly_asset::error::AssetErrorCode;
use dolly_asset::identity::{AssetId, ContentHash};
use dolly_asset::record::{ImportRequest, MediaKind, Source};
use dolly_asset::remote::DeniedFetcher;
use dolly_asset::replica::{DisabledReplica, InMemoryReplica};
use dolly_asset::service::AssetService;
use dolly_asset::AssetCapability;
use dolly_runtime::{
    AssetHostRoute, ChannelOutboundRoute, authenticated_channel_event,
    install_channel_store_schema, open_channel_inbound_route,
    reconcile_channel_inbound_route,
};
use dolly_channel::config::SessionMappingPolicy;
use dolly_channel::{
    AuthenticatedChannelEvent, ChannelConfig, ChannelConfigBuilder, ChannelEventContent,
    ChannelLedger, CoreIngress, CoreIngressError, EventKind, IngressCommit, IngressOutcome,
    IngressStatusResult, IngressSubmitReceipt, IngressSubmitRequest, OutboundAdmission,
    OutboundState, ScriptedTransport, SendDispatchResult, SqliteChannelStore,
    TransportPieceOutcome, TransportSendResult, VirtualClock, create_channel_store_schema,
    dispatch_send, parse_event, parse_send_action, process_event, reconcile_inbound,
};

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MATRIX: &str = include_str!("fixtures/g4_content_channel_conformance.json");
const TARGET_PAGE: &str = "page-web-primary";
/// The Channel module’s dedicated input page (outbound consumer targets).
const ROUTE_INPUT_PAGE: &str = "page-in";
const CHANNEL_NOW: &str = "2026-08-28T00:00:00.000000Z";
/// A fixed unix-millisecond instant for the asset harness.
const ASSET_T0: u64 = 1_800_000_000_000;

fn matrix() -> Value {
    serde_json::from_str(MATRIX).expect("G4 matrix fixture must be valid JSON")
}

fn case(id: &str) -> Value {
    matrix()["cases"]
        .as_array()
        .expect("G4 matrix cases must be an array")
        .iter()
        .find(|candidate| candidate["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("G4 matrix case {id} is missing"))
}

fn canonical_digest(value: &Value) -> String {
    canonicalize(value)
        .expect("fixture value must be canonical JSON")
        .1
        .to_canonical_string()
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
        "accepts": {"summary":"input","part_kinds":["text"],"action_names":[]},
        "emits": {"summary":"output","part_kinds":["text"],"action_names":["org.dolly.channel.send"]},
        "actions": [
            {
                "name": "org.dolly.channel.send",
                "summary": "send a message through the configured Channel transport"
            }
        ],
        "activation_replay_contract": {
            "mode":"fenced_replay",
            "evidence":"pure_compute",
            "ledger":null
        },
        "trust": "trusted",
        "metadata": {}
    })
}

fn graph_snapshot(module_id: &str) -> Value {
    let descriptor = descriptor(module_id);
    let mut descriptors = serde_json::Map::new();
    descriptors.insert(
        module_id.into(),
        json!({
            "module_id": module_id,
            "descriptor_revision": 1,
            "source_descriptor_digest": canonical_digest(&descriptor),
            "value": descriptor
        }),
    );
    json!({
        "receiving_module": module_id,
        "input_pages": {"page-web-primary": ["web-channel"]},
        "output_pages": {},
        "subscriptions": {},
        "descriptors": descriptors,
        "authorized_metadata_namespaces": ["org.dolly.channel"],
        "authorized_action_names": ["org.dolly.channel.send"]
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
    let transition = store
        .transact(&command, &input())
        .expect("configuration transaction must execute");
    assert_eq!(
        transition.outcome,
        TransitionOutcome::Committed,
        "harness: config install must commit"
    );
    store
        .bootstrap_host_connection()
        .expect("Host connection bootstrap");
}

fn install_graph(store: &mut SqliteCoreStore<'_>, module_id: &str, mark: &str) {
    let graph = graph_snapshot(module_id);
    let command = CoreCommand::InstallGraph(InstallGraphCommand {
        command_id: format!("{mark}-graph"),
        revision: 1,
        digest: canonical_digest(&graph),
        graph,
    });
    let transition = store
        .transact(&command, &input())
        .expect("graph transaction must execute");
    assert_eq!(
        transition.outcome,
        TransitionOutcome::Committed,
        "harness: graph install must commit"
    );
}

/// One fresh in-memory Core connection with config and graph installed.
/// Every probe starts from this proven-healthy harness base so that a later
/// `PRODUCT_RED` is causally attributable to the missing product seam.
fn probe_connection(module_id: &str, mark: &str) -> Connection {
    let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
    {
        let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
        install_config(&mut store, mark);
        install_graph(&mut store, module_id, mark);
    }
    connection
}

// ---------------------------------------------------------------------------
// Production-route harness: the actual registration path (dolly-runtime
// host routes) over a real runtime DB with a Host connection, capability
// grants, and the durable Host ingress slice.
// ---------------------------------------------------------------------------

/// Graph body for the route probes: the module is a producer of the given
/// output pages and its graph admission names the granted Extension owner
/// (both required by the durable Host ingress slice's grant-to-descriptor and
/// Extension-owner derivation).
fn route_graph_snapshot(module_id: &str, extension_id: &str, output_pages: &[&str]) -> Value {
    let descriptor = descriptor(module_id);
    let mut descriptors = serde_json::Map::new();
    descriptors.insert(
        module_id.into(),
        json!({
            "module_id": module_id,
            "descriptor_revision": 1,
            "source_descriptor_digest": canonical_digest(&descriptor),
            "owner_extension_id": extension_id,
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

/// A real runtime DB with config, a producer graph naming the granted
/// Extension owner, a bootstrap Host connection, a capability grant for the
/// module authorizing the given host methods, and the durable Host ingress
/// slice installed — the exact state the runtime registration binds to.
fn route_harness(
    module_id: &str,
    extension_id: &str,
    mark: &str,
    methods: &[&str],
    output_pages: &[&str],
) -> (Connection, HostConnectionAuthority, HostCapabilityGrant) {
    let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
    let authority = {
        let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
        install_config(&mut store, mark);
        let body = route_graph_snapshot(module_id, extension_id, output_pages);
        let digest = canonical_digest(&body);
        let transition = store
            .transact(
                &CoreCommand::InstallGraph(InstallGraphCommand {
                    command_id: format!("{mark}-graph"),
                    revision: 1,
                    digest: digest.clone(),
                    graph: body,
                }),
                &input(),
            )
            .expect("graph transaction must execute");
        assert_eq!(
            transition.outcome,
            TransitionOutcome::Committed,
            "harness: producer graph install must commit"
        );
        let authority = store.authenticated_host_connection().expect("host authority");
        store
            .install_host_capability_grant(
                &authority,
                extension_id,
                module_id,
                1,
                1,
                &canonical_digest(&descriptor(module_id)),
                1,
                &canonical_digest(&json!({"manifest": 1})),
                1,
                &digest,
                methods,
            )
            .expect("host capability grant");
        authority
    };
    create_host_ingress_schema(&mut connection).expect("host ingress schema");
    let grant = {
        let store = SqliteCoreStore::new(&mut connection).expect("core schema");
        store
            .current_host_capability_grant(&authority, extension_id, module_id)
            .expect("current grant read")
            .expect("grant present")
    };
    (connection, authority, grant)
}

/// A fresh module-scoped Channel store connection with the production-route
/// schema installed (the reserved registration-owned installation).
fn channel_store_connection() -> Connection {
    let mut connection = Connection::open_in_memory().expect("module store");
    install_channel_store_schema(&mut connection).expect("module channel store schema");
    connection
}

/// One authenticated Channel transport event's content (no authority/account
/// claim of its own; the sealed event derives those from the grant).
fn route_content_event(conversation: &str, message_id: &str, text: &str) -> ChannelEventContent {
    ChannelEventContent {
        channel_id: "web-primary".to_string(),
        transport: "web".to_string(),
        external_conversation_id: conversation.to_string(),
        external_message_id: message_id.to_string(),
        sender_class: "user".to_string(),
        sender_id: format!("sender-{message_id}"),
        text: text.to_string(),
        received_at: CHANNEL_NOW.parse().expect("timestamp"),
        event_kind: EventKind::Message,
        references_external_message_id: None,
    }
}

/// A route-bound `host.asset.import` request naming the granted module and
/// instance (the rest of the request is the shared crate request).
fn route_asset_request(
    module: &str,
    instance: &str,
    id: &str,
    source: Source,
    declared: Option<&str>,
) -> ImportRequest {
    let mut request = asset_request(id, source, declared, false);
    request.module_id = module.to_string();
    request.instance_id = instance.to_string();
    request
}
/// A deterministic shared status-capable transport: the consumer owns a boxed
/// copy while the probe drives the script and inspects recorded calls through
/// the Arc.
#[derive(Clone, Default)]
struct RouteSharedTransport {
    idempotent: bool,
    inner: std::sync::Arc<std::sync::Mutex<RouteSharedInner>>,
}

#[derive(Default)]
struct RouteSharedInner {
    script: Vec<TransportSendResult>,
    calls: Vec<dolly_channel::transport::TransportSendRequest>,
    status_script: Vec<(String, dolly_channel::transport::TransportStatusResult)>,
    status_calls: Vec<dolly_channel::transport::TransportStatusRequest>,
}

impl RouteSharedTransport {
    fn new(idempotent: bool) -> Self {
        Self {
            idempotent,
            inner: std::sync::Arc::new(std::sync::Mutex::new(RouteSharedInner::default())),
        }
    }
    fn push(&self, result: TransportSendResult) {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .script
            .push(result);
    }
    fn push_status(&self, action_id: &str, result: dolly_channel::transport::TransportStatusResult) {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .status_script
            .push((action_id.to_string(), result));
    }
    fn calls(&self) -> Vec<dolly_channel::transport::TransportSendRequest> {
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
    fn script_len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .script
            .len()
    }
}

impl dolly_channel::ChannelTransport for RouteSharedTransport {
    fn idempotency_supported(&self) -> bool {
        self.idempotent
    }
    fn send(&mut self, request: &dolly_channel::transport::TransportSendRequest) -> TransportSendResult {
        let mut inner = self.inner.lock().unwrap_or_else(|poison| poison.into_inner());
        inner.calls.push(request.clone());
        if inner.script.is_empty() {
            return TransportSendResult::Timeout;
        }
        inner.script.remove(0)
    }
    fn status(&mut self, request: &dolly_channel::transport::TransportStatusRequest) -> dolly_channel::transport::TransportStatusResult {
        let mut inner = self.inner.lock().unwrap_or_else(|poison| poison.into_inner());
        inner.status_calls.push(request.clone());
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

/// A committed targeted send block with the authoritative contract digest
/// (matching the accepted seam D consumer's verification).

/// A far-future caller deadline for consumer passes.

/// Commit a targeted send block durably and persist an ACTIVATED manifest
/// selecting it — the exact input the sealed outbound consumer drains (never
/// caller-injected blocks or retained upstream premises).

/// A fixed guest clock pinned to a later instant than the caller deadline,
/// for deterministic caller-deadline expiry in the queue-bound probe.
#[derive(Clone, Debug)]
struct ChannelLateClock {
    at: std::sync::Arc<std::sync::Mutex<dolly_core_domain::Timestamp>>,
}

impl ChannelLateClock {
    fn at(timestamp: dolly_core_domain::Timestamp) -> Self {
        Self {
            at: std::sync::Arc::new(std::sync::Mutex::new(timestamp)),
        }
    }
}

impl dolly_channel::Clock for ChannelLateClock {
    fn now(&self) -> dolly_core_domain::Timestamp {
        self.at
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }
}


fn route_send_block(module_id: &str, action_ids: &[&str], session_id: &str, texts: &[&str]) -> Value {
    let parts: Vec<Value> = texts
        .iter()
        .map(|t| json!({"kind": "text", "text": t, "format": "plain"}))
        .collect();
    let actions = action_ids
        .iter()
        .enumerate()
        .map(|(index, action_id)| {
            let action_parts = if index == 0 {
                parts.clone()
            } else {
                parts.clone()
            };
            let mut action = json!({
                "action_id": action_id,
                "name": "org.dolly.channel.send",
                "target": {"module_id": module_id},
                "arguments": {
                    "session_id": session_id,
                    "parts": action_parts,
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
            let contract =
                action["contract_binding"]["action_contract"].clone();
            action["contract_binding"]["action_contract_digest"] =
                json!(canonical_digest(&contract));
            action
        })
        .collect::<Vec<Value>>();
    json!({
        "schema": "dolly.block/v1",
        "id": format!("block-{}", action_ids[0]),
        "body": {
            "description": "model response",
            "parts": parts,
            "actions": actions
        }
    })
}

/// A far-future caller deadline for consumer passes.
fn far_deadline_str() -> String {
    dolly_channel::timestamp_plus_seconds(CHANNEL_NOW, 60)
}

/// Commit a targeted send block durably and persist an ACTIVATED manifest
/// selecting it — the exact input the sealed outbound consumer drains (never
/// caller-injected blocks or retained upstream premises).
fn commit_send_and_activate(
    connection: &mut Connection,
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    mark: &str,
    page: &str,
    block: Value,
    frozen_config: ChannelConfig,
) -> String {
    let action_ids: Vec<String> = block["body"]["actions"]
        .as_array()
        .expect("actions")
        .iter()
        .map(|a| a["action_id"].as_str().expect("action id").to_string())
        .collect();
    let block_id = format!("send-{mark}");
    let mut store = SqliteCoreStore::new(connection).expect("core schema");
    // 1. Fence any prior activation of the same module (single active).
    let prior: Vec<String> = store
        .snapshot()
        .expect("snapshot")
        .activations
        .iter()
        .filter(|(_, activation)| {
            activation
                .manifest
                .as_ref()
                .and_then(|manifest| manifest.get("module_id"))
                .and_then(Value::as_str)
                == Some("web-channel")
        })
        .map(|(id, _)| id.clone())
        .collect();
    for activation_id in prior {
        let transition = store
            .transact(
                &CoreCommand::BeginFence(dolly_core_reducer::BeginFenceCommand {
                    command_id: format!("{mark}-fence-{activation_id}"),
                    activation_id,
                }),
                &input(),
            )
            .expect("fence transaction");
        assert_eq!(transition.outcome, TransitionOutcome::Committed);
    }
    // 2. The send block is committed to the durable Core journal under the
    //    recording model source.
    let transition = store
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
        .expect("send commit");
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    drop(store);

    // 3. An activated manifest selects that block as the sole input item.
    let activation_id = format!("activation-{mark}");
    let occurrences: Vec<Value> = vec![json!({"page_id": page, "page_seq": 1, "commit_seq": 1})];
    let mut config = frozen_config;
    let principal_account =
        dolly_channel::ChannelPrincipal::from_authority_grant(authority, grant)
            .expect("principal")
            .account()
            .to_string();
    config.transport_account = principal_account;
    let effective_config = serde_json::to_value(config.clone()).expect("config serializable");
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
    let mut store = SqliteCoreStore::new(connection).expect("core schema");
    let transition = store
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
        .expect("manifest build");
    assert_eq!(transition.outcome, TransitionOutcome::Committed);

    // 4. Activate: lease + dispatch started make this the authoritative
    //    active manifest the consumer reads.
    let lease_id = format!("lease-{mark}");
    let token_digest = canonical_digest(&json!({"activation_id": activation_id, "lease_id": lease_id}));
    let transition = store
        .transact(
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
        )
        .expect("lease");
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    let transition = store
        .transact(
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
        )
        .expect("dispatch");
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    let _ = &action_ids;
    activation_id
}


fn transact_ingress(
    connection: &mut Connection,
    source: &str,
    key: &str,
    operation_digest: &str,
    block_id: &str,
    block: Value,
    pages: Vec<String>,
    command_id: &str,
) -> Transition {
    let mut store = SqliteCoreStore::new(connection).expect("core schema");
    store
        .transact(
            &CoreCommand::Ingress(IngressCommand {
                command_id: command_id.into(),
                runtime_source: source.into(),
                ingress_key: key.into(),
                operation_digest: operation_digest.into(),
                block_id: block_id.into(),
                block,
                pages,
            }),
            &input(),
        )
        .expect("ingress transaction must execute")
}

/// The exact causal red: every causal step this probe ACTUALLY drove
/// succeeded; only the missing product behavior named by the seam turns the
/// case red. Each cause states exactly which real Core transaction and/or
/// integrated dolly-asset/dolly-channel surface operations ran, so no
/// diagnostic claims steps a probe did not execute.
fn product_red(case_id: &str, seam: &str, cause: &str, area: &str) -> ! {
    panic!(
        "PRODUCT_RED [{case_id}] seam={seam} cause={cause} area={area}; \
         every causal step this probe actually drove (the real Core transaction \
         and/or integrated dolly-asset/dolly-channel surface operations named \
         in the cause) succeeded, so this failure is attributable to the \
         missing Host/runtime adapter seam named in the cause — not a harness, \
         build, or environment failure"
    )
}

fn text_block(message: &str) -> Value {
    json!({
        "schema": "dolly.block/v1",
        "parts": [{"kind": "text", "text": message, "format": "plain"}]
    })
}

fn channel_metadata_block(message: &str) -> Value {
    json!({
        "schema": "dolly.block/v1",
        "parts": [{"kind": "text", "text": message, "format": "plain"}],
        "metadata": {
            "org.dolly.channel": {
                "channel_id": "web-primary",
                "transport": "web",
                "session_id": "session-main",
                "external_conversation_id": "opaque-redacted-id",
                "external_message_id": "ext-msg-42",
                "sender_class": "user",
                "received_at": "2026-08-28T00:00:00.000000Z",
                "event_kind": "message"
            }
        }
    })
}

fn asset_input_draft(media_type: &str, base64_payload: &str, domain: &str) -> Value {
    json!({
        "schema": "dolly.block/v1",
        "parts": [],
        "asset_input": {
            "source_kind": "inline_base64",
            "media_type": media_type,
            "base64": base64_payload,
            "import_id": "0198ab31-6c44-7e8a-b2bb-000000000201",
            "max_bytes": 1048576,
            "security_domain": domain
        }
    })
}

// ---------------------------------------------------------------------------
// Asset harness: the integrated dolly-asset public surface.
// ---------------------------------------------------------------------------

/// A unique scratch root per test; removed on drop. No extra dependency.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new(tag: &str) -> Self {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "g4-asset-{tag}-{}-{stamp:x}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        ScratchDir(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A minimal byte sequence that sniffs as a WxH PNG (signature + IHDR + pad).
fn png_bytes(w: u32, h: u32) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0, 0, 0, 13]);
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&w.to_be_bytes());
    bytes.extend_from_slice(&h.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
    bytes.extend_from_slice(&[0u8; 24]); // tail junk; the sniffer reads only the head
    bytes
}

fn base64(bytes: &[u8]) -> String {
    const B64: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(B64[((acc >> bits) & 0x3f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B64[((acc << (6 - bits)) & 0x3f) as usize] as char);
    }
    while out.len() % 4 != 0 {
        out.push('=');
    }
    let _ = dolly_asset::source::strict_base64_decoded_len(&out)
        .expect("round-trip encoding is canonical");
    out
}

fn import_id(n: u64) -> String {
    format!("0198ab31-6c44-7e8a-b2bb-{n:012}")
}

fn asset_config_at(dir: &Path) -> ResolvedAssetConfig {
    let mut config = ResolvedAssetConfig::with_local_root(dir.to_path_buf());
    config.max_decoded_bytes = 64 * 1024;
    config.max_inline_base64_chars = 128 * 1024;
    config.max_image_pixels = 1_000_000;
    config.gc_grace_ms = 60_000;
    config
}

/// A shared, advanceable clock: the test advances the SAME clock instance
/// the service holds, so GC expiry and grace paths are deterministic.
#[derive(Clone)]
struct SharedClock(Arc<Mutex<u64>>);

impl SharedClock {
    fn new(millis: u64) -> Self {
        Self(Arc::new(Mutex::new(millis)))
    }
    fn advance(&self, delta_ms: u64) {
        *self.0.lock().expect("clock mutex") += delta_ms;
    }
}

impl dolly_asset::clock::Clock for SharedClock {
    fn now(&mut self) -> dolly_asset::ClockTime {
        let millis = *self.0.lock().expect("clock mutex");
        dolly_asset::ClockTime::new(millis)
    }
}

/// A fixed-clock, single-instance asset service over a scratch root. The
/// returned clock is the very clock the service advances on, so the test can
/// drive expiry deterministically.
fn asset_service_at(dir: &Path) -> (AssetService, SharedClock) {
    let clock = SharedClock::new(ASSET_T0);
    let service = AssetService::open_with(
        asset_config_at(dir),
        clock.clone(),
        DeniedFetcher,
        DisabledReplica::new("assets"),
    )
    .expect("asset service opens");
    (service, clock)
}

fn asset_capability(service: &AssetService) -> AssetCapability {
    service.issue_capability("personal", "instance-a", "module-a")
}

fn asset_request(
    import_id: &str,
    source: Source,
    declared: Option<&str>,
    remote_required: bool,
) -> ImportRequest {
    ImportRequest {
        import_id: import_id.to_string(),
        instance_id: "instance-a".to_string(),
        module_id: "module-a".to_string(),
        activation_id: None,
        lease_token: None,
        media_kind: MediaKind::Image,
        source,
        declared_media_type: declared.map(|m| m.parse().expect("valid media type")),
        remote_required,
        expected_byte_length: None,
        deadline: "2026-08-09T15:00:00.000000Z".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Channel harness: the in-test host.ingress.* adapter over the real Core.
// ---------------------------------------------------------------------------

/// The in-test `host.ingress.submit` / `host.ingress.status` adapter backing
/// the integrated `dolly_channel` pipeline with the REAL Core transaction
/// (`CoreCommand::Ingress` over `SqliteCoreStore`). It plays the exact
/// product adapter seam B that the shipping runtime does not ship; here it is
/// the harness that lets the Channel's real production modules talk to the
/// real Core, so every crate contract is proven against the actual durable
/// premise.
struct CoreBackedIngress<'a> {
    connection: &'a mut Connection,
    runtime_source: String,
    fail_submits: u64,
    /// Submits that COMMIT durably to Core but whose response is lost.
    commit_then_drop_submits: u64,
    fail_statuses: u64,
    next_seq: u64,
    pub submit_calls: u64,
    pub status_calls: u64,
}

impl<'a> CoreBackedIngress<'a> {
    fn new(connection: &'a mut Connection, module_id: &str) -> Self {
        Self {
            connection,
            runtime_source: format!("{module_id}/channel"),
            fail_submits: 0,
            commit_then_drop_submits: 0,
            fail_statuses: 0,
            next_seq: 0,
            submit_calls: 0,
            status_calls: 0,
        }
    }

    fn mint_block_id(&mut self) -> String {
        self.next_seq += 1;
        format!("0198ab31-6c44-7e8a-b2bb-{:012}", self.next_seq)
    }

    fn identity(&self, idempotency_key: &str) -> String {
        format!("{}\0{}", self.runtime_source, idempotency_key)
    }

    fn commit_from_snapshot(
        &mut self,
        snapshot: &dolly_core_reducer::CoreSnapshot,
        block_id: &str,
    ) -> IngressCommit {
        let graph_revision = snapshot
            .graph
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap_or(1);
        let deliveries: Vec<(String, i64, i64)> = snapshot
            .deliveries
            .iter()
            .filter(|delivery| delivery["block_id"] == block_id)
            .enumerate()
            .map(|(index, delivery)| {
                let page_id = delivery["page_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                let commit_seq = delivery["commit_seq"].as_i64().unwrap_or(index as i64);
                (page_id, index as i64 + 1, commit_seq)
            })
            .collect();
        IngressCommit {
            ingress_id: format!("ingress-{block_id}"),
            block_id: block_id.to_string(),
            graph_revision,
            deliveries,
        }
    }
}

impl CoreIngress for CoreBackedIngress<'_> {
    fn submit(
        &mut self,
        request: &IngressSubmitRequest,
    ) -> Result<IngressSubmitReceipt, CoreIngressError> {
        self.submit_calls += 1;
        if self.fail_submits > 0 {
            self.fail_submits -= 1;
            return Err(CoreIngressError::UnknownOutcome);
        }
        let digest = request
            .operation_digest()
            .map_err(|_| CoreIngressError::Rejected {
                code: "CORE_INVALID_JSON".to_string(),
            })?;
        let block: Value = serde_json::to_value(&request.draft)
            .map_err(|_| CoreIngressError::Rejected {
                code: "CORE_INVALID_JSON".to_string(),
            })?;
        let block_id = self.mint_block_id();
        let transition = transact_ingress(
            &mut *self.connection,
            &self.runtime_source,
            &request.idempotency_key,
            &digest,
            &block_id,
            block,
            request.target_page_ids.clone(),
            &format!("channel-submit-{}", self.submit_calls),
        );
        match transition.outcome {
            TransitionOutcome::Committed => {
                let idempotent = transition
                    .reply
                    .as_ref()
                    .and_then(|reply| reply.get("idempotent"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if self.commit_then_drop_submits > 0 {
                    self.commit_then_drop_submits -= 1;
                    // The commit IS durable in Core; only this response is lost.
                    return Err(CoreIngressError::UnknownOutcome);
                }
                let committed_block_id = transition
                    .reply
                    .as_ref()
                    .and_then(|reply| reply.get("block_id"))
                    .and_then(Value::as_str)
                    .unwrap_or(&block_id)
                    .to_string();
                let commit =
                    self.commit_from_snapshot(&transition.state, &committed_block_id);
                Ok(IngressSubmitReceipt::Committed {
                    idempotent,
                    commit,
                })
            }
            TransitionOutcome::RolledBack => {
                let code = transition
                    .error
                    .map(|error| error.code)
                    .unwrap_or_else(|| "CORE_REJECTED".to_string());
                Err(CoreIngressError::Rejected { code })
            }
            TransitionOutcome::RolledBackWithSafetyStop => {
                let code = transition
                    .error
                    .map(|error| error.code)
                    .unwrap_or_else(|| "CORE_SAFETY_STOP".to_string());
                Err(CoreIngressError::Rejected { code })
            }
        }
    }

    fn status(
        &mut self,
        _operation_id: &str,
        _module_id: &str,
        idempotency_key: &str,
        _deadline: &str,
    ) -> Result<IngressStatusResult, CoreIngressError> {
        self.status_calls += 1;
        if self.fail_statuses > 0 {
            self.fail_statuses -= 1;
            return Err(CoreIngressError::UnknownOutcome);
        }
        let store = SqliteCoreStore::new(&mut *self.connection).expect("core schema");
        let snapshot = store.snapshot().expect("snapshot");
        let identity = self.identity(idempotency_key);
        match snapshot.ingress.get(&identity) {
            Some(record) => {
                let commit = self.commit_from_snapshot(&snapshot, &record.block_id);
                Ok(IngressStatusResult::Committed { commit })
            }
            None => Ok(IngressStatusResult::Absent),
        }
    }
}

fn channel_config() -> ChannelConfig {
    ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .target_pages(&[TARGET_PAGE])
        .build()
}

fn channel_clock() -> VirtualClock {
    use std::str::FromStr;
    VirtualClock::at(dolly_core_domain::Timestamp::from_str(CHANNEL_NOW).expect("timestamp"))
}

fn channel_event(
    account: &str,
    conversation: &str,
    message_id: &str,
    text: &str,
) -> dolly_channel::InboundEvent {
    use std::str::FromStr;
    dolly_channel::InboundEvent {
        channel_id: "web-primary".to_string(),
        transport: "web".to_string(),
        account: account.to_string(),
        external_conversation_id: conversation.to_string(),
        external_message_id: message_id.to_string(),
        sender_class: "user".to_string(),
        sender_id: format!("sender-{account}"),
        text: text.to_string(),
        received_at: dolly_core_domain::Timestamp::from_str(CHANNEL_NOW).expect("timestamp"),
        event_kind: EventKind::Message,
        references_external_message_id: None,
    }
}

/// The exact raw transport event JSON accepted by `parse_event`, with room
/// for hostile extra fields on top (parse must ignore them).
fn channel_raw_event(extra: &Value) -> Value {
    let mut raw = json!({
        "channel_id": "web-primary",
        "transport": "web",
        "account": "account-a",
        "external_conversation_id": "conv-1",
        "external_message_id": "msg-1",
        "sender_class": "user",
        "sender_id": "sender-account-a",
        "event_kind": "message",
        "text": "Hello, Dolly.",
        "received_at": CHANNEL_NOW
    });
    if let Some(object) = extra.as_object() {
        for (key, value) in object {
            raw[key] = value.clone();
        }
    }
    raw
}

/// A committed Block carrying a targeted channel send action, exactly as Core
/// would deliver committed Actions to the module (the seam-D input shape).
fn channel_send_block(action_id: &str, session_id: &str, texts: &[&str]) -> Value {
    let parts: Vec<Value> = texts
        .iter()
        .map(|t| json!({"kind": "text", "text": t, "format": "plain"}))
        .collect();
    json!({
        "schema": "dolly.block/v1",
        "id": "0198ab31-6c44-7e8a-b2bb-000000000001",
        "body": {
            "description": "model response",
            "parts": parts,
            "actions": [{
                "action_id": action_id,
                "name": "org.dolly.channel.send",
                "target": {"module_id": "web-channel"},
                "arguments": {
                    "session_id": session_id,
                    "parts": parts,
                    "reply_to_external_message_id": null
                },
                "contract_binding": {
                    "module_id": "web-channel",
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

/// Dispatch a committed block's send action; requires an existing session.
fn channel_dispatch(
    config: &ChannelConfig,
    ledger: &mut ChannelLedger,
    transport: &mut ScriptedTransport,
    block: &Value,
    action_id: &str,
) -> SendDispatchResult {
    let action = parse_send_action(block).expect("block carries a channel send action");
    assert_eq!(action.action_id, action_id, "block action id matches");
    let mut admission = OutboundAdmission::new();
    dispatch_send(config, &channel_clock(), ledger, transport, &mut admission, &action)
}

// ---------------------------------------------------------------------------
// Matrix retention: the authoritative document stays canonical.
// ---------------------------------------------------------------------------

#[test]
fn g4_matrix_retains_all_declared_cases_and_causal_classification() {
    let document = matrix();
    assert_eq!(document["schema"], "dolly.g4-content-channel-conformance/v1");
    assert!(
        !document["spec_basis"].as_array().expect("spec_basis").is_empty(),
        "matrix must name its normative spec basis"
    );

    let source_boundary = &document["source_boundary"];
    assert_eq!(source_boundary["g1_fixture"], "crates/dolly-runtime/tests/fixtures/g1_runtime_conformance.json");
    assert_eq!(source_boundary["g1_case"], "G1-EXEC-001");
    assert_eq!(source_boundary["g2_fixture"], "crates/dolly-runtime/tests/fixtures/g2_extension_host_sdk_conformance.json");
    assert_eq!(source_boundary["g2_case"], "G2-ADMISSION-001");
    assert!(
        source_boundary["handoff"]
            .as_str()
            .expect("handoff")
            .contains("WP-010 Asset and WP-013A/013B Channel seams")
    );
    assert!(
        source_boundary["authority"]
            .as_str()
            .expect("authority")
            .contains("Core remains the only authority")
    );
    assert_eq!(
        source_boundary["effect_boundary"],
        "before Asset import, host.ingress.submit, and outbound Channel effects"
    );

    let classification = &document["classification"];
    for expected in ["product_red", "pass", "blocked"] {
        assert!(
            classification[expected]
                .as_str()
                .expect("classification entry")
                .len()
                > 30,
            "classification must explain {expected}"
        );
    }

    let cases = document["cases"].as_array().expect("cases");
    let mut ids = std::collections::BTreeSet::new();
    for entry in cases {
        let id = entry["id"].as_str().expect("case id");
        assert!(ids.insert(id.to_owned()), "duplicate G4 case id {id}");
        assert!(!entry["name"].as_str().expect("case name").is_empty());
        assert!(
            entry["kind"].as_str().expect("case kind").len() >= 4,
            "case {id} must carry a kind"
        );
        let expected = entry["expected"].as_str().expect("case expected");
        assert!(
            expected == "product_red" || expected == "pass",
            "case {id}: expected must be product_red or pass, got {expected}"
        );
        if expected == "product_red" {
            if entry["blocked"].as_bool().unwrap_or(false) {
                let reason = entry["blocked_reason"].as_str().expect("blocked_reason");
                assert!(
                    reason.contains("not frozen"),
                    "case {id}: blocked_reason must require frozen interfaces"
                );
                assert!(
                    entry["unblocked_when"].as_array().expect("unblocked_when").len() >= 1,
                    "case {id}: blocked cases must name the unblock conditions"
                );
            } else {
                assert!(
                    entry["seam"].as_str().expect("seam").len() > 20,
                    "case {id} must name the stable interface seam expected from Asset and Channel"
                );
                assert!(
                    entry["causal_red"].as_str().expect("causal_red").len() > 20,
                    "case {id} must state the exact causal red"
                );
            }
        } else {
            let references = entry["references"]
                .as_array()
                .expect("pass case must reference the crate surface it drives");
            assert!(!references.is_empty(), "case {id}: pass case needs references");
            if !id.starts_with("G4-CONTROL-") {
                let basis = entry["pass_basis"].as_str().expect("pass_basis");
                assert!(
                    basis.len() > 20,
                    "case {id}: pass_basis must state the exact verified contract"
                );
            }
        }
    }

    let evidence = document["evidence"].as_object().expect("evidence");
    assert!(!evidence.is_empty(), "matrix must declare its evidence coverage");
    for (area, case_ids) in evidence {
        let case_ids = case_ids.as_array().expect("evidence case ids");
        assert!(!case_ids.is_empty(), "evidence area {area} has no cases");
        for case_id in case_ids {
            let case_id = case_id.as_str().expect("evidence case id");
            assert!(ids.contains(case_id), "evidence area {area} references undeclared case {case_id}");
        }
    }

    // Every declared evidence area requested by the gate is present.
    for required in [
        "wp010_import_bound_and_crash_recovery",
        "wp010_canonical_identity_and_dedup",
        "wp010_mime_and_security_refusal",
        "wp010_leases_and_gc",
        "wp010_replicas_and_domain_isolation",
        "wp013a_authenticated_text_round_trip",
        "wp013a_committed_action_consumer",
        "wp013a_ingress_reconciliation",
        "wp013a_authorization",
        "wp013a_replay_and_idempotency",
        "wp013a_unknown_and_partial_outbound",
        "wp013a_backpressure",
        "wp013a_redaction",
        "wp013a_no_direct_page_or_cursor_mutation",
        "wp013b_asset_import_and_send_seam",
        "wp013b_mime_lease_media_abuse_round_trip",
        "premise_direction_controls",
    ] {
        assert!(
            evidence.contains_key(required),
            "matrix must cover evidence area {required}"
        );
    }
}

#[test]
fn g4_matrix_retains_all_declared_controls() {
    for entry in matrix()["cases"].as_array().expect("cases") {
        let id = entry["id"].as_str().expect("control id");
        if id.starts_with("G4-CONTROL-") {
            assert_eq!(entry["expected"], "pass", "control {id} must be pass");
            let assertion = entry["assertion"].as_str().expect("control assertion");
            assert!(
                assertion.len() > 20,
                "control {id} must state its executable assertion"
            );
        } else if entry["expected"] == "pass" {
            // Verified WP-010/013A crate-contract cases carry a causal basis
            // and their own references; they are not controls.
            let basis = entry["pass_basis"].as_str().expect("wp pass_basis");
            assert!(basis.len() > 20, "case {id} must state its verified contract");
            assert!(
                entry["references"].as_array().expect("references").len() >= 1,
                "case {id} must reference the crate surface it drives"
            );
        }
    }
}

#[test]
fn g4_wp013b_multimodal_cases_remain_blocked_until_interfaces_freeze() {
    for id in [
        "G4-WP013B-ASSET-SEND-SEAM-001",
        "G4-WP013B-MIME-LEASE-001",
        "G4-WP013B-MEDIA-ABUSE-001",
    ] {
        let entry = case(id);
        assert_eq!(entry["expected"], "product_red");
        assert_eq!(
            entry["blocked"], true,
            "WP-013B case {id} must remain blocked while WP-010 and WP-013A are not frozen"
        );
        let reason = entry["blocked_reason"].as_str().expect("blocked_reason");
        assert!(
            reason.contains("WP-010") && reason.contains("WP-013A"),
            "case {id}: blocked_reason must name both prerequisite work packages"
        );
        let unblocked = entry["unblocked_when"].as_array().expect("unblocked_when");
        for condition in unblocked {
            let condition = condition.as_str().expect("unblock condition");
            assert!(
                condition.starts_with("G4-WP010-") || condition.starts_with("G4-WP013A-"),
                "case {id}: unblock condition {condition} must be a frozen WP-010/013A case"
            );
        }
        // No executable body may run for a blocked seam; the seam is declared
        // only in the matrix.
    }
}

// ---------------------------------------------------------------------------
// Fail-closed controls (expected pass): premise direction and authority.
// ---------------------------------------------------------------------------

#[test]
fn g4_control_premise_direction_is_durable_explicit_and_never_reversible() {
    let entry = case("G4-CONTROL-PREMISE-DIRECTION-001");
    assert_eq!(entry["expected"], "pass");

    let mut connection = probe_connection("web-channel", "g4-premise");
    let block = text_block("Hello.");
    let digest = canonical_digest(&block);

    let first = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &digest,
        "g4-premise-block",
        block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-premise-1",
    );
    assert_eq!(first.outcome, TransitionOutcome::Committed);
    let ingress_identity = "channel-web\0ext-42";
    assert_eq!(
        first.state.ingress[ingress_identity].block_id, "g4-premise-block",
        "producer premise must resolve to its durable block"
    );
    assert!(
        first.state.blocks.contains_key("g4-premise-block"),
        "the committed block is the durable explicit premise consumers see"
    );

    // Identical replay returns the prior mapping and emits nothing new.
    let replay = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &digest,
        "g4-premise-block",
        block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-premise-2",
    );
    assert_eq!(replay.outcome, TransitionOutcome::Committed);
    assert_eq!(
        replay.reply,
        Some(json!({"block_id": "g4-premise-block", "idempotent": true}))
    );
    assert!(replay.events.is_empty(), "replay must not re-emit an event");

    // A different digest under the same key is a conflict, never an overwrite:
    // there is no reverse authority to replace a committed premise.
    let tampered = text_block("Tampered.");
    let tampered_digest = canonical_digest(&tampered);
    let conflict = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &tampered_digest,
        "g4-premise-block-tampered",
        tampered,
        vec![TARGET_PAGE.into()],
        "g4-premise-3",
    );
    assert_eq!(conflict.outcome, TransitionOutcome::RolledBack);
    let error = conflict.error.expect("conflict must carry a Core error");
    assert_eq!(error.code, "STORAGE_IDEMPOTENCY_CONFLICT");
    assert!(
        conflict.state.blocks.contains_key("g4-premise-block"),
        "the committed premise survives the conflict attempt"
    );
    assert!(
        !conflict.state.blocks.contains_key("g4-premise-block-tampered"),
        "the conflicting block must not be committed"
    );

    // The premise is durable: a fresh store over the same connection still
    // resolves the producer key to the committed mapping.
    {
        let reopened = SqliteCoreStore::new(&mut connection).expect("reopened core schema");
        let snapshot = reopened.snapshot().expect("reopened snapshot");
        assert_eq!(
            snapshot.ingress[ingress_identity].block_id, "g4-premise-block",
            "the durable explicit premise must survive a store reopen"
        );
    }
}

#[test]
fn g4_control_ingress_keys_are_producer_scoped_without_echo_collision() {
    let entry = case("G4-CONTROL-SOURCE-SCOPED-001");
    assert_eq!(entry["expected"], "pass");

    let mut connection = probe_connection("web-channel", "g4-scoped");
    let web_block = channel_metadata_block("from web");
    let cli_block = channel_metadata_block("from cli");

    let web = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&web_block),
        "g4-scoped-web-block",
        web_block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-scoped-web",
    );
    assert_eq!(web.outcome, TransitionOutcome::Committed);
    let cli = transact_ingress(
        &mut connection,
        "channel-cli",
        "ext-42",
        &canonical_digest(&cli_block),
        "g4-scoped-cli-block",
        cli_block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-scoped-cli",
    );
    assert_eq!(cli.outcome, TransitionOutcome::Committed);

    // Same external key under two producers are independent records; there is
    // no echo: replaying the web key returns only the web mapping.
    let snapshot = {
        let store = SqliteCoreStore::new(&mut connection).expect("core schema");
        store.snapshot().expect("snapshot")
    };
    assert_eq!(snapshot.ingress.len(), 2, "producer-scoped keys must not collide");
    assert_eq!(snapshot.ingress["channel-web\0ext-42"].block_id, "g4-scoped-web-block");
    assert_eq!(snapshot.ingress["channel-cli\0ext-42"].block_id, "g4-scoped-cli-block");

    let web_replay = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&web_block),
        "g4-scoped-web-block",
        web_block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-scoped-web-replay",
    );
    assert_eq!(
        web_replay.reply,
        Some(json!({"block_id": "g4-scoped-web-block", "idempotent": true})),
        "replaying one producer must return only that producer's prior mapping"
    );
}

#[test]
fn g4_control_action_names_are_owner_fenced_against_cross_extension_forgery() {
    let entry = case("G4-CONTROL-ACTION-OWNER-001");
    assert_eq!(entry["expected"], "pass");

    let channel = ExtensionId::from_string("org.dolly.channel".into()).expect("channel extension id");
    let other = ExtensionId::from_string("org.example.other".into()).expect("other extension id");

    let send = ActionName::parse_for_owner(&channel, "org.dolly.channel.send")
        .expect("the Channel owns org.dolly.channel.send");
    assert_eq!(send.as_str(), "org.dolly.channel.send");
    assert_eq!(send.owner().as_str(), "org.dolly.channel");

    // A cross-extension forgery cannot even be constructed with the Channel's
    // owner: parse_for_owner binds the exact owner prefix.
    assert!(
        ActionName::parse_for_owner(&other, "org.dolly.channel.send").is_err(),
        "another Extension must not construct the Channel action name"
    );
    assert!(
        ActionName::parse_for_owner(&channel, "org.example.other.send").is_err(),
        "the Channel must not construct another Extension's action name"
    );
    assert!(
        ActionName::parse_for_owner(&channel, "org.dolly.channel").is_err(),
        "an action name requires an operation label after the owner"
    );
}

#[test]
fn g4_control_core_catalog_has_no_third_party_page_or_cursor_mutation() {
    let entry = case("G4-CONTROL-NO-DIRECT-MUTATION-001");
    assert_eq!(entry["expected"], "pass");

    // The exhaustive match is the durable binding: the Core transaction
    // catalog is exactly this set, and none of its variants is a direct
    // page-append or Module-cursor-advance command reachable by a third party.
    fn catalog_binding(command: &CoreCommand) -> &'static str {
        match command {
            CoreCommand::InstallConfig(_) => "config",
            CoreCommand::InstallGraph(_) => "graph",
            CoreCommand::Ingress(_) => "external_draft:block_publication",
            CoreCommand::RuntimeEvent(_) => "host_event:block_publication",
            CoreCommand::GrantStorageWriter(_) => "storage_authority",
            CoreCommand::ReleaseStorageWriter(_) => "storage_authority",
            CoreCommand::BuildManifest(_) => "activation:premise",
            CoreCommand::IssueLease(_) => "activation:lease",
            CoreCommand::DispatchLease(_) => "activation:lease",
            CoreCommand::ReceiveResult(_) => "activation:result",
            CoreCommand::BeginFence(_) => "activation:fence",
            CoreCommand::RecordReplayEvidence(_) => "activation:replay_evidence",
            CoreCommand::FenceComplete(_) => "activation:fence",
            CoreCommand::ApplyResult(_) => "activation:result_commit",
            CoreCommand::CancelActivation(_) => "activation:cancel",
            CoreCommand::ResolveQuarantine(_) => "activation:quarantine",
            CoreCommand::CompleteQuarantineFence(_) => "activation:quarantine",
            CoreCommand::DeadLetterRange(_) => "delivery:dead_letter",
            CoreCommand::SkipRange(_) => "delivery:skip",
            CoreCommand::LossyEvict(_) => "delivery:lossy_evict",
            CoreCommand::Recover(_) => "recovery",
        }
    }

    let samples = [
        CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "c".into(),
            revision: 1,
            effective_config: json!({}),
            digest: String::new(),
        }),
        CoreCommand::Ingress(IngressCommand {
            command_id: "c".into(),
            runtime_source: "s".into(),
            ingress_key: "k".into(),
            operation_digest: "d".into(),
            block_id: "b".into(),
            block: json!({}),
            pages: vec![],
        }),
    ];
    for command in &samples {
        let binding = catalog_binding(command);
        assert!(
            binding != "page_append" && binding != "cursor_advance",
            "catalog must contain no direct page or cursor mutation"
        );
    }

    // External drafts reach a Page only through block publication, never by
    // mutating Page or cursor records directly.
    let mut connection = probe_connection("web-channel", "g4-nodirect");
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&text_block("Hello.")),
        "g4-nodirect-block",
        text_block("Hello."),
        vec![TARGET_PAGE.into()],
        "g4-nodirect",
    );
    assert_eq!(transition.outcome, TransitionOutcome::Committed);
    let snapshot = {
        let store = SqliteCoreStore::new(&mut connection).expect("core schema");
        store.snapshot().expect("snapshot")
    };
    assert!(snapshot.blocks.contains_key("g4-nodirect-block"));
    assert!(
        snapshot.deliveries.iter().any(|delivery| {
            delivery["block_id"] == "g4-nodirect-block" && delivery["page_id"] == TARGET_PAGE
        }),
        "the block, not a Page handle, is what carries the draft to the consumer"
    );
}

#[test]
fn g4_control_block_bytes_stay_untrusted_until_a_core_asset_authority_exists() {
    let entry = case("G4-CONTROL-ASSET-UNTRUSTED-001");
    assert_eq!(entry["expected"], "pass");

    let mut connection = probe_connection("web-channel", "g4-untrusted");
    let draft = asset_input_draft("image/png", "aW1hZ2UtYnl0ZXM=", "personal");
    let transition = transact_ingress(
        &mut connection,
        "channel-web",
        "ext-42",
        &canonical_digest(&draft),
        "g4-untrusted-block",
        draft.clone(),
        vec![TARGET_PAGE.into()],
        "g4-untrusted",
    );
    assert_eq!(transition.outcome, TransitionOutcome::Committed);

    // The asset_input bytes ride verbatim as untrusted Block content: no
    // ImportId result, no content-hash Asset record, no availability claim,
    // and no asset/pin/replica store in the durable snapshot.
    let committed = &transition.state.blocks["g4-untrusted-block"];
    assert_eq!(
        committed["asset_input"]["base64"], "aW1hZ2UtYnl0ZXM=",
        "harness: the draft bytes are persisted verbatim"
    );
    assert!(
        committed.get("asset_id").is_none(),
        "no AssetId may be minted from block content"
    );
    assert_eq!(
        transition.reply,
        Some(json!({"block_id": "g4-untrusted-block", "idempotent": false})),
        "the only durable reply today is the ingress mapping"
    );
    let snapshot_value = serde_json::to_value(&transition.state).expect("snapshot JSON");
    for absent in ["imports", "asset_records", "assets", "asset_views", "pins", "replicas"] {
        assert!(
            snapshot_value.get(absent).is_none(),
            "the durable snapshot must not fabricate an {absent} store before WP-010"
        );
    }
}

// ---------------------------------------------------------------------------
// WP-010 Asset probes: the integrated dolly-asset public surface.
// ---------------------------------------------------------------------------

#[test]
fn g4_wp010_bounded_import_and_crash_recovery_round_trip() {
    let entry = case("G4-WP010-IMPORT-BOUND-001");
    assert_eq!(entry["expected"], "pass");

    // The actual registration path: host.asset.import / host.asset.status
    // bound to an activated module under the sealed current Host authority
    // and capability grant (dolly_runtime::AssetHostRoute). The capability is
    // derived inside from sealed grant facts — no caller mints one, and no
    // Core Block ever derives import authority.
    let scratch = ScratchDir::new("route-import-bound");
    let asset_root = scratch.path().to_path_buf();
    let config = asset_config_at(&asset_root);
    let (mut connection, authority, grant) = route_harness(
        "module-a",
        "org.dolly.asset",
        "g4-asset-route",
        &["host.asset.import", "host.asset.status"],
        &[],
    );
    // 1. Bounded import through the route -> AVAILABLE canonical AssetRef.
    //    The granted instance identity comes from the route itself (derived
    //    from the sealed worker epoch), never from caller input.
    let png = png_bytes(4, 2);
    let mut route = AssetHostRoute::for_activated_module(
        &mut connection,
        config,
        &authority,
        &grant,
    )
    .expect("asset route registration binds under the sealed grant");
    let instance = route.instance_id().to_string();
    let result = route
        .import(&route_asset_request(
            "module-a",
            &instance,
            &import_id(601),
            Source::InlineBase64 {
                base64: base64(&png),
            },
            Some("image/png"),
        ))
        .expect("route host.asset.import commits");
    assert_eq!(result.state, "available");
    assert!(result.terminal);
    let asset = result.asset.as_ref().expect("AssetRef on AVAILABLE");
    assert_eq!(asset.byte_length, png.len() as u64);
    assert_eq!(
        asset.asset_id,
        AssetId::from_digest(ContentHash::of_bytes(&png).digest)
    );

    // 2. Over-limit source through the route: SIZE_LIMIT, no asset.
    let mut big = png_bytes(4, 2);
    big.resize(200 * 1024, 0); // exceeds the bounded 64 KiB decoded bound
    let rejected = route
        .import(&route_asset_request(
            "module-a",
            &instance,
            &import_id(602),
            Source::InlineBase64 {
                base64: base64(&big),
            },
            Some("image/png"),
        ))
        .expect("over-limit import is a recorded rejection");
    assert_eq!(rejected.state, "rejected");
    assert!(rejected.asset.is_none());
    assert_eq!(rejected.error.as_ref().expect("envelope")["code"], "SIZE_LIMIT");

    // 3. Crash restart through the route: a fresh registration over the same
    //    content root and runtime DB resolves the durable record exactly.
    let mut route2 = AssetHostRoute::for_activated_module(
        &mut connection,
        asset_config_at(&asset_root),
        &authority,
        &grant,
    )
    .expect("route re-registration over the same root");
    let recovered = route2
        .status(
            &dolly_asset::facade::AssetStatusRequest::new(
                "0198ab31-6c44-7e8a-b2bb-000000000811",
                "module-a",
                &import_id(601),
                "2026-08-28T00:00:00.000000Z",
            )
            .expect("valid asset status request"),
        )
        .expect("durable import record survives route restart");
    assert_eq!(recovered.state, "available");

    // 4. The Sol-accepted absent contract through the route: never-created
    //    ImportIds answer an authoritative explicit absent StatusResult,
    //    nondisclosing and with no asset/lifecycle masquerade.
    let never_created = route2
        .status(
            &dolly_asset::facade::AssetStatusRequest::new(
                "0198ab31-6c44-7e8a-b2bb-000000000812",
                "module-a",
                &import_id(901),
                "2026-08-28T00:00:00.000000Z",
            )
            .expect("valid asset status request"),
        )
        .expect("absent is an authoritative StatusResult");
    assert_eq!(
        never_created.state, "absent",
        "explicit absent state through the route"
    );
    assert!(
        !never_created.terminal,
        "absent must not masquerade as a terminal state"
    );
    assert!(
        never_created.asset.is_none(),
        "absent must never mint an AssetRef"
    );
    assert!(
        never_created.error.is_none(),
        "absent must not carry an error envelope"
    );
    assert_eq!(
        never_created.import_id, import_id(901),
        "absent must bind exactly the queried ImportId and disclose nothing else"
    );
    for masquerade in ["accepted", "available", "rejected", "cancelled"] {
        assert_ne!(
            never_created.state, masquerade,
            "absent must not collide with the recorded lifecycle state {masquerade}"
        );
    }

    // 5. A request naming a different granted module never reaches the
    //    Asset façade: the route refuses it as a capability violation.
    let cross_instance = route2.instance_id().to_string();
    let cross = route2.import(&route_asset_request(
        "module-b",
        &cross_instance,
        &import_id(701),
        Source::InlineBase64 {
            base64: base64(&png),
        },
        Some("image/png"),
    ));
    assert!(
        matches!(
            cross,
            Err(dolly_runtime::HostRouteError::CapabilityDenied { .. })
        ),
        "a cross-module import must be refused by the route before any effect"
    );
}
#[test]
fn g4_wp010_canonical_identity_and_dedup_are_core_authority_only() {
    let entry = case("G4-WP010-IDENTITY-DEDUP-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("identity-dedup");
    let (mut service, _clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);
    let png = png_bytes(4, 2);
    let encoded = base64(&png);

    let first = service
        .import(
            &capability,
            &asset_request(
                &import_id(611),
                Source::InlineBase64 {
                    base64: encoded.clone(),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("first import");
    let second = service
        .import(
            &capability,
            &asset_request(
                &import_id(612),
                Source::InlineBase64 { base64: encoded },
                Some("image/png"),
                false,
            ),
        )
        .expect("second import");

    // Identical accepted bytes within one security domain resolve to one
    // AssetId and one durable lifecycle record.
    let id1 = first.asset.expect("first AssetRef").asset_id;
    let id2 = second.asset.expect("second AssetRef").asset_id;
    assert_eq!(id1, id2, "identical bytes must deduplicate to one AssetId");
    assert!(id1.as_str().starts_with("ast_b3_"), "canonical AssetId prefix");
    assert_eq!(
        id1,
        AssetId::from_digest(ContentHash::of_bytes(&png).digest),
        "AssetId is ast_b3_ + base32(blake3-256) over accepted bytes"
    );
    assert!(
        scratch.path().join("objects").join(id1.as_str()).exists(),
        "one content-addressed object"
    );

    // Non-canonical encodings are rejected: an AssetId string must match the
    // exact pattern and re-encode to the canonical base32 form. A real minted
    // AssetId round-trips; hand-crafted near-misses are refused.
    let canonical = AssetId::from_digest([0u8; 32]);
    assert!(
        canonical.as_str().parse::<AssetId>().is_ok(),
        "a minted AssetId parses back to itself"
    );
    assert!(
        "ast-b3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"
            .parse::<AssetId>()
            .is_err(),
        "wrong prefix"
    );
    assert!(
        "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaz"
            .parse::<AssetId>()
            .is_err(),
        "z is outside the base32 alphabet"
    );
    assert!(
        "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .parse::<AssetId>()
            .is_err(),
        "too short"
    );
}

#[test]
fn g4_wp010_mime_and_security_refusal_precede_availability() {
    let entry = case("G4-WP010-MIME-SECURITY-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("mime-security");
    let (mut service, _clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);

    // 1. Active content declared as image/png is refused: MEDIA_TYPE_MISMATCH,
    //    never relabeled to an available asset.
    let svg = b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\"/>";
    let refused = service
        .import(
            &capability,
            &asset_request(
                &import_id(621),
                Source::InlineBase64 {
                    base64: base64(svg),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("media mismatch is a recorded rejection");
    assert_eq!(refused.state, "rejected");
    assert_eq!(
        refused.error.as_ref().expect("envelope")["code"],
        "MEDIA_TYPE_MISMATCH"
    );
    assert!(refused.asset.is_none(), "no availability before refusal");

    // 2. Over-limit source: cut off and rejected with SIZE_LIMIT before any
    //    availability; no asset and no partial authority.
    let mut big = png_bytes(4, 2);
    big.resize(200 * 1024, 0); // exceeds the 64 KiB decoded bound
    let over = service
        .import(
            &capability,
            &asset_request(
                &import_id(622),
                Source::InlineBase64 {
                    base64: base64(&big),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("over-limit import is a recorded rejection");
    assert_eq!(over.state, "rejected");
    assert!(over.asset.is_none(), "no availability before the size refusal");
    assert_eq!(over.error.as_ref().expect("envelope")["code"], "SIZE_LIMIT");

    // 3. Strict base64: malformed encodings fail before any durable record.
    let invalid = service
        .import(
            &capability,
            &asset_request(
                &import_id(623),
                Source::InlineBase64 {
                    base64: "aGVsbG8!".to_string(),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect_err("invalid base64 must be refused");
    assert_eq!(invalid.code, AssetErrorCode::InvalidBase64);

    // 4. SSRF policy: a remote URL carrying credentials is SOURCE_DENIED.
    let denied = service
        .import(
            &capability,
            &asset_request(
                &import_id(624),
                Source::RemoteUrl {
                    url: "https://user:pass@example.com/a.png".to_string(),
                    max_bytes: 1024,
                },
                Some("image/png"),
                false,
            ),
        )
        .expect_err("credential-bearing remote source must be denied");
    assert_eq!(denied.code, AssetErrorCode::SourceDenied);

    // 5. A remote URL with no Host transport is unavailable, never fabricated.
    let unavailable = service
        .import(
            &capability,
            &asset_request(
                &import_id(625),
                Source::RemoteUrl {
                    url: "https://example.com/a.png".to_string(),
                    max_bytes: 1024,
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("remote without transport records rejection");
    assert_eq!(unavailable.state, "rejected");
    assert_eq!(
        unavailable.error.as_ref().expect("envelope")["code"],
        "SOURCE_UNAVAILABLE"
    );
}

#[test]
fn g4_wp010_leases_pins_and_gc_use_atomic_durable_retention() {
    let entry = case("G4-WP010-LEASE-GC-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("lease-gc");
    let (mut service, clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &asset_request(
                &import_id(631),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("import");
    let asset_id = available.asset.expect("AssetRef").asset_id.as_str().to_string();

    // Finite lease with an unguessable id; the lease blocks GC while live.
    let lease = service
        .lease(&capability, &asset_id, "model-op-1", "provider output", 240_000)
        .expect("finite lease");
    assert!(lease.lease_id.len() >= 32, "unguessable LeaseId");
    assert!(lease.expires_at > lease.created_at, "finite expiry");
    clock.advance(120_000);
    let gc = service.run_gc().expect("gc");
    assert_eq!(gc.tombstones_created, 0, "a live lease is atomic against GC");
    assert!(service.release_lease(&lease.lease_id).expect("release"));

    // After the lease and grace pass, the sweep tombstones the object.
    clock.advance(120_000);
    let gc = service.run_gc().expect("gc");
    assert_eq!(gc.tombstones_created, 1);
    assert!(
        !scratch.path().join("objects").join(&asset_id).exists(),
        "sweep removes the object"
    );

    // The tombstone never resurrects: a new lease against it fails.
    let err = service
        .lease(&capability, &asset_id, "model-op-2", "late lease", 1000)
        .expect_err("tombstone must block new leases");
    assert_eq!(err.code, AssetErrorCode::NotFound);

    // Pin retention: an expiry-less pin requires privilege, and a durable pin
    // blocks the sweep (atomic non-tombstone check on retention, not just
    // lease ownership).
    let second = service
        .import(
            &capability,
            &asset_request(
                &import_id(632),
                Source::InlineBase64 {
                    base64: base64(&png_bytes(6, 2)),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("second import for pin retention");
    let pinned_id = second.asset.expect("AssetRef").asset_id.as_str().to_string();
    let unprivileged = service
        .pin(&capability, &pinned_id, "ops", "keep", None, false)
        .expect_err("expiry-less pin without privilege must be refused");
    assert_eq!(unprivileged.code, AssetErrorCode::Unauthorized);
    service
        .pin(&capability, &pinned_id, "ops", "keep", None, true)
        .expect("privileged expiry-less pin");
    let gc = service.run_gc().expect("gc");
    assert_eq!(
        gc.tombstones_created, 0,
        "the durable pin blocks the sweep after lease expiry"
    );

    // Durable-reference retention: a live reference blocks GC; removing it
    // lets the sweep tombstone; a reference created after the tombstone never
    // wins (durable-reference/recheck semantics).
    let third = service
        .import(
            &capability,
            &asset_request(
                &import_id(633),
                Source::InlineBase64 {
                    base64: base64(&png_bytes(8, 2)),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("third import for reference retention");
    let referenced_id = third.asset.expect("AssetRef").asset_id.as_str().to_string();
    let reference = service
        .create_reference(&capability, &referenced_id, "block:b1", "block:b1")
        .expect("durable reference");
    let gc = service.run_gc().expect("gc");
    assert_eq!(
        gc.tombstones_created, 0,
        "a live durable reference blocks the sweep"
    );
    service
        .remove_reference(&capability, &referenced_id, reference.generation, "block:b1")
        .expect("reference removed");
    clock.advance(120_000);
    let gc = service.run_gc().expect("gc");
    assert_eq!(
        gc.tombstones_created, 1,
        "the sweep tombstones the unreferenced object"
    );
    let late = service
        .create_reference(&capability, &referenced_id, "block:b2", "block:b2")
        .expect_err("a reference racing a tombstone must never win");
    assert!(
        matches!(
            late.code,
            AssetErrorCode::NotFound | AssetErrorCode::Tombstoned
        ),
        "tombstone never resurrects"
    );
}

#[test]
fn g4_wp010_required_replicas_never_expose_unverified_bytes() {
    let entry = case("G4-WP010-REPLICA-001");
    assert_eq!(entry["expected"], "pass");

    // 1. remote_required with no replica is refused before acquisition.
    let scratch = ScratchDir::new("replica-none");
    let (mut service, _clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);
    let png = png_bytes(4, 2);
    let refused = service
        .import(
            &capability,
            &asset_request(
                &import_id(641),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                true,
            ),
        )
        .expect_err("remote_required without a replica must refuse");
    assert_eq!(refused.code, AssetErrorCode::RemoteReplicaFailed);

    // 2. remote_required with a failing replica: the row is REPLICA_FAILED
    //    and never exposes an asset (REMOTE_REPLICA_FAILED).
    let scratch2 = ScratchDir::new("replica-failing");
    let mut config = asset_config_at(scratch2.path());
    config.replica = ReplicaConfig {
        enabled: true,
        endpoint: Some("https://oss.example".to_string()),
        bucket: Some("dolly".to_string()),
        prefix: Some("assets".to_string()),
        credential_ref: Some("k8s://dolly/oss".to_string()),
    };
    let mut replica = InMemoryReplica::new("assets", "dolly", "dolly-bucket");
    replica.fail_uploads = true;
    let mut service2 = AssetService::open_with(
        config,
        FixedClock::new(ASSET_T0),
        DeniedFetcher,
        replica,
    )
    .expect("service with failing replica");
    let capability2 = asset_capability(&service2);
    let held = service2
        .import(
            &capability2,
            &asset_request(
                &import_id(642),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                true,
            ),
        )
        .expect("replica failure is a recorded state");
    assert_eq!(held.state, "replica_failed");
    assert!(!held.terminal, "REPLICA_FAILED is not AVAILABLE");
    assert!(held.asset.is_none(), "unverified replica bytes are not exposed");
    assert_eq!(
        held.error.as_ref().expect("envelope")["code"],
        "REMOTE_REPLICA_FAILED"
    );

    // 3. remote_required with a working replica reaches AVAILABLE only after
    //    the replica verifies the same content hash.
    let scratch3 = ScratchDir::new("replica-working");
    let mut config3 = asset_config_at(scratch3.path());
    config3.replica = ReplicaConfig {
        enabled: true,
        endpoint: Some("https://oss.example".to_string()),
        bucket: Some("dolly".to_string()),
        prefix: Some("assets".to_string()),
        credential_ref: Some("k8s://dolly/oss".to_string()),
    };
    let mut service3 = AssetService::open_with(
        config3,
        FixedClock::new(ASSET_T0),
        DeniedFetcher,
        InMemoryReplica::new("assets", "dolly", "dolly-bucket"),
    )
    .expect("service with working replica");
    let capability3 = asset_capability(&service3);
    let verified = service3
        .import(
            &capability3,
            &asset_request(
                &import_id(643),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                true,
            ),
        )
        .expect("verified replica import");
    assert_eq!(verified.state, "available");
    assert_eq!(
        verified.asset.expect("AssetRef").asset_id,
        AssetId::from_digest(ContentHash::of_bytes(&png).digest)
    );
}

#[test]
fn g4_wp010_security_domain_isolation_is_recorded_and_enforced() {
    let entry = case("G4-WP010-DOMAIN-ISOLATION-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("domain-isolation");
    let (mut service, _clock) = asset_service_at(scratch.path());
    let domain_a = service.issue_capability("work", "instance-a", "module-a");
    let domain_b = service.issue_capability("personal", "instance-a", "module-a");
    let png = png_bytes(4, 2);

    let a = service
        .import(
            &domain_a,
            &asset_request(
                &import_id(651),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("domain A import");
    let b = service
        .import(
            &domain_b,
            &asset_request(
                &import_id(652),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("domain B import");
    let asset_a = a.asset.expect("A AssetRef");
    let asset_b = b.asset.expect("B AssetRef");
    assert_eq!(asset_a.asset_id, asset_b.asset_id, "identical bytes");

    // Domain isolation: a domain that never imported the bytes must NOT read
    // them, even though a hash match exists in another domain.
    assert!(service.read(&domain_a, asset_a.asset_id.as_str()).is_ok());
    let uninvolved = service.issue_capability("other", "instance-a", "module-a");
    match service.read(&uninvolved, asset_a.asset_id.as_str()) {
        Ok(_) => panic!("cross-domain read must be denied"),
        Err(denied) => assert_eq!(denied.code, AssetErrorCode::NotFound),
    }

    // Capability coupling: module+instance must match the request.
    let wrong_module = service.issue_capability("personal", "instance-a", "module-b");
    let denied = service
        .import(
            &wrong_module,
            &asset_request(
                &import_id(653),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect_err("capability module mismatch must be Unauthorized");
    assert_eq!(denied.code, AssetErrorCode::Unauthorized);

    // Shared object is retained: neither domain's live row may be GC'd away.
    let gc = service.run_gc().expect("gc");
    assert_eq!(gc.tombstones_created, 0);
    assert!(
        scratch.path().join("objects").join(asset_a.asset_id.as_str()).exists()
    );
}

// ---------------------------------------------------------------------------
// WP-013A Channel probes: the integrated dolly-channel public surface over
// the real Core transaction.
// ---------------------------------------------------------------------------

#[test]
fn g4_wp013a_authenticated_text_round_trip_runs_producer_to_premise_to_consumer() {
    let entry = case("G4-WP013A-ROUNDTRIP-001");
    assert_eq!(entry["expected"], "pass");

    // The actual registration path: the durable Channel inbound route binds an
    // authenticated event under the sealed current Host authority and its
    // host.ingress.submit grant, feeds it through the accepted InboundReceiver
    // over one runtime DB plus the module-scoped Channel store, and commits
    // the premise through the REAL durable Host ingress slice. Core assigns
    // Ingress/Block identity from the authenticated principal — the caller
    // supplies only message content and can never choose a block_id.
    let (mut runtime, authority, grant) = route_harness(
        "web-channel",
        "org.dolly.channel",
        "g4-roundtrip",
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    let mut module_store = channel_store_connection();
    let config = channel_config();
    let clock = channel_clock();
    let mapping_count = |runtime: &Connection| -> i64 {
        runtime
            .query_row("SELECT COUNT(*) FROM host_ingress_mappings", [], |row| row.get(0))
            .expect("mapping count")
    };
    let operation_count = |runtime: &Connection| -> i64 {
        runtime
            .query_row(
                "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
                [],
                |row| row.get(0),
            )
            .expect("operation count")
    };

    // 1. Producer leg: an authenticated event becomes a committed durable
    //    premise under a Host-derived identity.
    let block_id = {
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
            route_content_event("conv-1", "in-1", "What is the weather?"),
        )
        .expect("authenticated event seals under the grant");
        match receiver.ingest_event(&event) {
            IngressOutcome::Committed { block_id, .. } => block_id,
            other => panic!("authenticated event must commit through the route, got {other:?}"),
        }
    };
    let snapshot = {
        let store = SqliteCoreStore::new(&mut runtime).expect("core schema");
        store.snapshot().expect("snapshot")
    };
    assert!(
        snapshot.blocks.contains_key(&block_id),
        "the Channel premise is durable in the real Core snapshot under the Host-assigned identity"
    );
    assert_eq!(
        snapshot.blocks[&block_id]["metadata"]["org.dolly.channel"]["sender_class"],
        json!("user"),
        "the durable premise is bound to the authenticated event, not caller-shaped authority"
    );
    // The premise is mapped under the sealed principal, never a caller id.
    let principal_row: (String, String, String) = runtime
        .query_row(
            "SELECT owner, module_id, external_event_id FROM host_ingress_mappings",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("mapping row");
    assert_eq!(principal_row.0, authority.extension_connection_id(), "owner is sealed");
    assert_eq!(principal_row.1, "web-channel", "module is granted");
    assert_eq!(principal_row.2, "in-1", "external event is the authenticated one");
    assert_eq!(mapping_count(&runtime), 1);
    assert_eq!(operation_count(&runtime), 1);

    // 2. Byte-identical replay through the route is idempotent: the prior
    //    mapping returns and nothing new is allocated.
    let replay = {
        let mut receiver = open_channel_inbound_route(
            &mut runtime,
            &mut module_store,
            config.clone(),
            Box::new(clock.clone()),
            &authority,
            &grant,
        )
        .expect("channel route re-registration");
        let event = authenticated_channel_event(
            &authority,
            &grant,
            config.revision,
            route_content_event("conv-1", "in-1", "What is the weather?"),
        )
        .expect("replay event seals");
        receiver.ingest_event(&event)
    };
    match replay {
        IngressOutcome::IdempotentReplay { block_id: replayed } => {
            assert_eq!(replayed, block_id, "replay returns the existing identity");
        }
        other => panic!("byte-identical replay must be idempotent through the route, got {other:?}"),
    }
    assert_eq!(mapping_count(&runtime), 1, "no duplicate premise");
    assert_eq!(operation_count(&runtime), 1, "no re-dispatch or re-mint");

    // 3. Opposite premise: the committed producer key cannot be replaced with
    //    different content, and nothing changes.
    let conflict = {
        let mut receiver = open_channel_inbound_route(
            &mut runtime,
            &mut module_store,
            config.clone(),
            Box::new(clock.clone()),
            &authority,
            &grant,
        )
        .expect("channel route re-registration");
        let event = authenticated_channel_event(
            &authority,
            &grant,
            config.revision,
            route_content_event("conv-1", "in-1", "Different question?"),
        )
        .expect("conflict event seals");
        receiver.ingest_event(&event)
    };
    match conflict {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_OPERATION_CONFLICT");
        }
        other => panic!("a premise must not be overwritable, got {other:?}"),
    }
    assert_eq!(mapping_count(&runtime), 1, "the premise survives the conflict attempt");
    assert_eq!(operation_count(&runtime), 1);
}
#[test]
fn g4_wp013a_committed_action_consumer_remains_an_absent_runtime_loop() {
    let entry = case("G4-WP013A-CONSUMER-001");
    assert_eq!(entry["expected"], "pass");

    // The actual registration path: the runtime owns the ONE identity-bound
    // OutboundQueueGate for this store/account/config identity and injects it
    // into the sealed OutboundConsumer over the real Core journal and the
    // module-scoped Channel store, with an injected status-capable transport.
    let (mut runtime, authority, grant) = route_harness(
        "web-channel",
        "org.dolly.channel",
        "g4-consumer-route",
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    let mut module_store = channel_store_connection();
    let config = channel_config();
    let clock = channel_clock();

    // 1. Upstream producer premise commits under the sealed authority and
    //    yields the account-owned session the downstream send is bound to.
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
            route_content_event("conv-1", "in-1", "What is the weather?"),
        )
        .expect("authenticated event seals under the grant");
        assert!(
            matches!(receiver.ingest_event(&event), IngressOutcome::Committed { .. }),
            "the upstream premise commits through the route"
        );
    }
    let principal = dolly_channel::ChannelPrincipal::from_authority_grant(&authority, &grant)
        .expect("principal");
    let session_id = dolly_channel::ids::dolly_session_id(principal.account(), "conv-1");

    // 2. A targeted send Action is committed durably and an activating
    //    manifest selects it — the exact input the sealed consumer drains.
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000712";
    let send_block = route_send_block("web-channel", &[action_id], &session_id, &["It will be sunny."]);
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "g4-consumer",
        ROUTE_INPUT_PAGE,
        send_block,
        config.clone(),
    );

    // 3. The runtime route owns the shared gate: registering twice returns
    //    the same identity-bound Arc, so no consumer-created gate exists.
    let route = ChannelOutboundRoute::register(
        config.clone(),
        &mut module_store,
        &authority,
        &grant,
    )
    .expect("outbound route registration");
    let gate = route.gate();
    let route2 = ChannelOutboundRoute::register(
        config.clone(),
        &mut module_store,
        &authority,
        &grant,
    )
    .expect("outbound route re-registration");
    assert!(
        std::sync::Arc::ptr_eq(&gate, &route2.gate()),
        "exactly one identity-bound gate per store/account/config"
    );

    // 4. The runtime consumer pass turns the committed targeted Action into a
    //    frozen Terminal ActionResult through the injected transport — no
    //    block scanning, no raw dispatch_send, no retained upstream premise.
    let transport = RouteSharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-reply-1".to_string()],
    });
    let report = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(transport.clone()),
            &far_deadline_str(),
        )
        .expect("runtime consumer pass");
    assert_eq!(report.transported, 1, "exactly one send dispatched");
    assert_eq!(report.rejected, 0);
    assert_eq!(report.pending, 0);
    assert_eq!(report.remaining, 0, "status-first reconcile leaves nothing");
    let terminal_jcs = match &report.terminal[0] {
        dolly_channel::ConsumerOutcome::Terminal {
            state,
            result_jcs,
            ..
        } => {
            assert_eq!(state, &OutboundState::Confirmed);
            result_jcs.clone()
        }
        other => panic!("expected Terminal Confirmed, got {other:?}"),
    };
    let envelope: Value = serde_json::from_str(&terminal_jcs).expect("action result envelope");
    assert_eq!(envelope["schema"], "dolly.action-result/v1");
    assert_eq!(envelope["action_id"], action_id);
    assert_eq!(envelope["status"], "succeeded");
    assert_eq!(transport.calls().len(), 1, "exactly one transport call");

    // 5. Re-consuming the same committed Action returns the stored frozen
    //    result with ZERO re-dispatch (idempotent replay through the route).
    let transport2 = RouteSharedTransport::new(true);
    let replay = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(transport2.clone()),
            &far_deadline_str(),
        )
        .expect("replay consumer pass");
    assert_eq!(replay.transported, 1, "replay returns the stored terminal");
    assert!(matches!(
        &replay.terminal[0],
        dolly_channel::ConsumerOutcome::Terminal {
            state,
            ..
        } if state == &OutboundState::Confirmed
    ));
    assert_eq!(transport2.calls().len(), 0, "zero re-dispatch on replay");
}



#[test]
fn g4_wp013a_ingress_reconciliation_reads_status_instead_of_resubmitting() {
    let entry = case("G4-WP013A-INGRESS-RECONCILE-001");
    assert_eq!(entry["expected"], "pass");

    // The actual registration path: host.ingress.status-first reconciliation
    // on activation/restart. A lost submit response leaves a durable
    // `prepared` Channel intent (Host committed, terminal store commit
    // failed); reconcile() through the runtime route reopens it, consults
    // Host status with the current sealed authority FIRST, and settles the
    // terminal state exactly once — never resubmitting.
    let mapping_count = |runtime: &Connection| -> i64 {
        runtime
            .query_row("SELECT COUNT(*) FROM host_ingress_mappings", [], |row| row.get(0))
            .expect("mapping count")
    };
    let operation_count = |runtime: &Connection| -> i64 {
        runtime
            .query_row(
                "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
                [],
                |row| row.get(0),
            )
            .expect("operation count")
    };

    // 1. A committed submit through the route leaves exactly one Host premise
    //    and one Core effect.
    let (mut runtime, authority, grant) = route_harness(
        "web-channel",
        "org.dolly.channel",
        "g4-reconcile",
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    let mut module_store = channel_store_connection();
    let config = channel_config();
    let clock = channel_clock();
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
            route_content_event("conv-1", "in-1", "Hello."),
        )
        .expect("authenticated event seals under the grant");
        assert!(
            matches!(receiver.ingest_event(&event), IngressOutcome::Committed { .. }),
            "the first submit commits through the route"
        );
    }
    assert_eq!(mapping_count(&runtime), 1);
    assert_eq!(operation_count(&runtime), 1);

    // 2. Lost response: the Host commits the premise but the terminal Channel
    //    store transaction fails, leaving a durable `prepared` intent (no
    //    terminal row). This is the crash window reconcile exists for.
    let (mut runtime2, authority2, grant2) = route_harness(
        "web-channel",
        "org.dolly.channel",
        "g4-reconcile-lost",
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    let mut module_store2 = channel_store_connection();
    let principal = dolly_channel::ChannelPrincipal::from_authority_grant(&authority2, &grant2)
        .expect("principal derives from the sealed grant");
    {
        let mut store = SqliteChannelStore::new(&mut module_store2, &principal, config.revision)
            .expect("module store opens under the principal");
        store.inject_commit_outcome_failure(1);
        let mut receiver = dolly_channel::InboundReceiver::new_with_store(
            config.clone(),
            Box::new(clock.clone()),
            store,
            dolly_storage::SqliteHostIngressStore::new(&mut runtime2)
                .expect("host ingress store"),
            &authority2,
            &grant2,
        )
        .expect("receiver with failpoint store");
        let event = authenticated_channel_event(
            &authority2,
            &grant2,
            config.revision,
            route_content_event("conv-1", "in-lost", "Hello lost."),
        )
        .expect("lost-response event seals");
        assert!(
            matches!(
                receiver.ingest_event(&event),
                IngressOutcome::SubmissionPending
            ),
            "a lost response must leave the intent prepared, retryable"
        );
    }
    assert_eq!(
        mapping_count(&runtime2), 1,
        "the Host committed the premise before the response was lost"
    );
    assert_eq!(operation_count(&runtime2), 1);

    // 3. Reconcile through the actual registration path (activation/restart
    //    hook): status-first, exactly once, with no resubmission.
    let remaining = reconcile_channel_inbound_route(
        &mut runtime2,
        &mut module_store2,
        config.clone(),
        Box::new(clock.clone()),
        &authority2,
        &grant2,
    )
    .expect("reconcile through the route");
    assert_eq!(remaining, 0, "status settled the prepared intent");
    assert_eq!(mapping_count(&runtime2), 1, "no duplicate premise");
    assert_eq!(operation_count(&runtime2), 1, "status-first: no blind resend");

    // 4. Restart stability: a fresh route over the SAME runtime DB and module
    //    store (a fresh receiver, as on restart/activation) reconciles to zero
    //    and never rewrites history.
    let again = reconcile_channel_inbound_route(
        &mut runtime2,
        &mut module_store2,
        config.clone(),
        Box::new(clock.clone()),
        &authority2,
        &grant2,
    )
    .expect("reconcile on restart");
    assert_eq!(again, 0, "restart reconcile is a no-op");
    assert_eq!(operation_count(&runtime2), 1, "history is never rewritten");
}
#[test]
fn g4_wp013a_sender_conversation_session_and_capability_are_authorized_before_dispatch() {
    let entry = case("G4-WP013A-AUTHORIZATION-001");
    assert_eq!(entry["expected"], "pass");

    let mut connection = probe_connection("web-channel", "g4-authz");
    let config = channel_config();
    let clock = channel_clock();
    let mut ledger = ChannelLedger::new();

    // 1. Cross-owner account: refused before any durable mutation.
    let outcome = {
        let mut core = CoreBackedIngress::new(&mut connection, "web-channel");
        process_event(
            &config,
            &clock,
            &mut ledger,
            &mut core,
            &channel_event("account-other", "conv-1", "m1", "hello"),
        )
    };
    match outcome {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_AUTHENTICATION_FAILED");
        }
        other => panic!("expected rejection, got {other:?}"),
    }
    assert!(ledger.inbound.is_empty(), "no durable mutation before refusal");
    assert!(ledger.sessions.is_empty(), "no session created");

    // 2. Unauthorized sender: refused before any Core call.
    let mut hostile = channel_event("account-a", "conv-1", "m2", "hello");
    hostile.sender_id = "mallory".to_string();
    let config_restricted = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .allowed_senders(&["sender-account-a"])
        .target_pages(&[TARGET_PAGE])
        .build();
    let outcome = {
        let mut core = CoreBackedIngress::new(&mut connection, "web-channel");
        process_event(
            &config_restricted,
            &clock,
            &mut ledger,
            &mut core,
            &hostile,
        )
    };
    match outcome {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_AUTHORIZATION_FAILED");
        }
        other => panic!("expected rejection, got {other:?}"),
    }

    // 3. Session-missing send under require_known: refused before dispatch.
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["mid".to_string()],
    });
    let config_known = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .target_pages(&[TARGET_PAGE])
        .session_policy(SessionMappingPolicy::RequireKnown)
        .build();
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000702";
    let wrong_session_block = channel_send_block(action_id, "session-not-owned", &["hi"]);
    let outcome = channel_dispatch(
        &config_known,
        &mut ledger,
        &mut transport,
        &wrong_session_block,
        action_id,
    );
    match outcome {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_SESSION_MISSING");
        }
        other => panic!("expected pre-dispatch rejection, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0, "no transport call before authorization");
}

#[test]
fn g4_wp013a_outbound_replay_returns_the_existing_result_without_resend() {
    let entry = case("G4-WP013A-REPLAY-001");
    assert_eq!(entry["expected"], "pass");

    let config = channel_config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-msg-001".to_string()],
    });
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000703";
    let block = channel_send_block(action_id, "session-main", &["Hello."]);

    let first = channel_dispatch(&config, &mut ledger, &mut transport, &block, action_id);
    let (first_state, first_result) = match &first {
        SendDispatchResult::Terminal { state, result } => (state.clone(), result.clone()),
        other => panic!("expected Terminal, got {other:?}"),
    };

    // At-least-once redelivery of the same committed action: the confirmed
    // replay returns the existing result and never re-dispatches.
    let second = channel_dispatch(&config, &mut ledger, &mut transport, &block, action_id);
    match second {
        SendDispatchResult::Terminal { state, result } => {
            assert_eq!(state, first_state);
            assert_eq!(result, first_result, "replay returns the existing result");
        }
        other => panic!("expected Terminal replay, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 1, "no re-dispatch of a confirmed send");
    let entry = ledger.outbound_entry(action_id).expect("one outbound row");
    assert_eq!(
        entry.attempts.iter().filter(|a| a.kind == "settle").count(),
        1,
        "exactly one terminal settle for the single dispatch"
    );
    assert_eq!(
        entry.attempts.iter().filter(|a| a.kind == "prepare").count(),
        1,
        "the replay added no second prepare"
    );
}

#[test]
fn g4_wp013a_unknown_and_partial_outcomes_are_explicit_and_non_retryable() {
    let entry = case("G4-WP013A-UNKNOWN-PARTIAL-001");
    assert_eq!(entry["expected"], "pass");

    let config = channel_config();

    // 1. Lost send response: the row stays dispatched, then recovery
    //    reconciles to a terminal `unknown` (never `failed`, never re-sent).
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(false);
    transport.push(TransportSendResult::Timeout);
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000704";
    let block = channel_send_block(action_id, "session-main", &["Hello."]);
    let outcome = channel_dispatch(&config, &mut ledger, &mut transport, &block, action_id);
    assert!(
        matches!(outcome, SendDispatchResult::DispatchedPending),
        "timeout after possible send must be unresolved"
    );
    assert_eq!(
        ledger.outbound_entry(action_id).unwrap().state,
        OutboundState::Dispatched
    );
    let mut clock = channel_clock();
    clock.advance_seconds(config.outbound_limits.unknown_after_seconds as i64 + 1);
    let recovered = dolly_channel::recover_outbound(&config, &clock, &mut ledger);
    assert_eq!(recovered, vec![action_id.to_string()]);
    assert_eq!(
        ledger.outbound_entry(action_id).unwrap().state,
        OutboundState::Unknown
    );
    assert_eq!(transport.calls().len(), 1, "recovery never re-dispatches");

    // 2. Partial multi-piece send: terminal `partial` with the exact frozen
    //    ActionResult mapping (CHANNEL_PARTIAL_DELIVERY, retryable false,
    //    outcome applied, per-piece ordinals).
    let mut ledger2 = ChannelLedger::new();
    ledger2.insert_session("account-a", "conv-1", "session-main");
    let mut transport2 = ScriptedTransport::new(true);
    transport2.push(TransportSendResult::PerPiece {
        pieces: vec![
            TransportPieceOutcome::Confirmed {
                ordinal: 0,
                message_id: "mid-0".to_string(),
            },
            TransportPieceOutcome::Rejected {
                ordinal: 1,
                code: "REMOTE_REFUSED".to_string(),
            },
        ],
    });
    let action_id2 = "0198ab31-6c44-7e8a-b2bb-000000000705";
    let block2 = channel_send_block(action_id2, "session-main", &["part one", "part two"]);
    let outcome2 = channel_dispatch(&config, &mut ledger2, &mut transport2, &block2, action_id2);
    match outcome2 {
        SendDispatchResult::Terminal { state, result } => {
            assert_eq!(state, OutboundState::Partial);
            let json: Value = serde_json::from_str(
                &dolly_canonical_json::canonicalize(&result)
                    .map(|(bytes, _)| String::from_utf8(bytes.as_bytes().to_vec()).unwrap())
                    .expect("canonical result"),
            )
            .expect("result JSON");
            assert_eq!(json["status"], "failed");
            assert_eq!(json["result"], Value::Null);
            assert_eq!(json["error"]["code"], "CHANNEL_PARTIAL_DELIVERY");
            assert_eq!(json["error"]["retryable"], false);
            assert_eq!(json["error"]["outcome"], "applied");
            assert_eq!(json["error"]["details"]["delivery_outcome"], "partial");
            assert_eq!(
                json["error"]["details"]["confirmed_ordinals"],
                json!([0])
            );
            assert_eq!(json["error"]["details"]["failed_ordinals"], json!([1]));
            assert_eq!(json["error"]["details"]["unknown_ordinals"], json!([]));
        }
        other => panic!("expected terminal partial, got {other:?}"),
    }
    // Never collapsed to success and never retried wholesale.
    let replay = channel_dispatch(&config, &mut ledger2, &mut transport2, &block2, action_id2);
    assert!(matches!(
        replay,
        SendDispatchResult::Terminal {
            state: OutboundState::Partial,
            ..
        }
    ));
    assert_eq!(transport2.calls().len(), 1, "no wholesale retry of a partial send");
}

#[test]
fn g4_wp013a_outbound_rate_limits_use_bounded_queues_and_caller_deadlines() {
    let entry = case("G4-WP013A-BACKPRESSURE-001");
    assert_eq!(entry["expected"], "pass");

    // Through the runtime route the identity-bound gate owns the bounded
    // caller-deadline queue: an expired caller deadline admits nothing and
    // every action is refused RATE_LIMITED (retryable) with zero transport
    // and zero Core input mutation; transport unavailability never blocks
    // Core input state — the durable Dispatched row is settled status-first,
    // never blind-resent. (The per-session token-bucket limiter itself is the
    // accepted dolly-channel surface, proven in its own suite.)

    // ---- Leg A: caller-deadline bound (isolated fixture) -----------------
    let (mut runtime_a, authority_a, grant_a) = route_harness(
        "web-channel",
        "org.dolly.channel",
        "g4-backpressure-deadline",
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    let mut store_a = channel_store_connection();
    let config = channel_config();
    let clock_a = channel_clock();
    {
        let mut receiver = open_channel_inbound_route(
            &mut runtime_a,
            &mut store_a,
            config.clone(),
            Box::new(clock_a.clone()),
            &authority_a,
            &grant_a,
        )
        .expect("channel route registration");
        let event = authenticated_channel_event(
            &authority_a,
            &grant_a,
            config.revision,
            route_content_event("conv-1", "in-1", "burst"),
        )
        .expect("sealed event");
        assert!(matches!(receiver.ingest_event(&event), IngressOutcome::Committed { .. }));
    }
    let host_ingress_ops_a = runtime_a
        .query_row(
            "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("baseline");
    let principal_a = dolly_channel::ChannelPrincipal::from_authority_grant(&authority_a, &grant_a)
        .expect("principal");
    let session_a = dolly_channel::ids::dolly_session_id(principal_a.account(), "conv-1");

    // A three-piece burst (one committed block, three targeted sends).
    let action_ids = [
        "0198ab31-6c44-7e8a-b2bb-000000000721",
        "0198ab31-6c44-7e8a-b2bb-000000000722",
        "0198ab31-6c44-7e8a-b2bb-000000000723",
    ];
    let burst = route_send_block(
        "web-channel",
        &action_ids,
        &session_a,
        &["step one", "step two", "step three"],
    );
    commit_send_and_activate(
        &mut runtime_a,
        &authority_a,
        &grant_a,
        "g4-backpressure",
        ROUTE_INPUT_PAGE,
        burst,
        config.clone(),
    );
    let route_a = ChannelOutboundRoute::register(
        config.clone(),
        &mut store_a,
        &authority_a,
        &grant_a,
    )
    .expect("outbound route registration");

    // The guest clock is already past the caller deadline: the bounded queue
    // admits nothing — every action is refused RATE_LIMITED (retryable)
    // BEFORE any transport effect, and Core inputs are untouched.
    let late_clock = ChannelLateClock::at(
        dolly_channel::timestamp_plus_seconds(CHANNEL_NOW, 90)
            .parse()
            .expect("late timestamp"),
    );
    let expired_deadline = dolly_channel::timestamp_plus_seconds(CHANNEL_NOW, 60);
    let transport_a = RouteSharedTransport::new(true);
    for _ in 0..3 {
        transport_a.push(TransportSendResult::AllConfirmed {
            message_ids: vec!["transport-burst-1".to_string()],
        });
    }
    let report = route_a
        .consume_once(
            &mut store_a,
            &mut runtime_a,
            Box::new(late_clock),
            Box::new(transport_a.clone()),
            &expired_deadline,
        )
        .expect("caller-deadline bounded pass");
    assert_eq!(report.transported, 0, "nothing is sent past the caller deadline");
    assert_eq!(report.rejected, 3, "every burst action is refused by the deadline bound");
    assert!(
        report
            .rejected_codes
            .iter()
            .all(|code| code == "CHANNEL_RATE_LIMITED"),
        "deadline refusals are retryable backpressure, got {:?}",
        report.rejected_codes
    );
    assert_eq!(transport_a.calls().len(), 0, "zero transport effect");
    assert_eq!(
        runtime_a
            .query_row(
                "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("operations"),
        host_ingress_ops_a,
        "Core input state is untouched by the bounded pass"
    );

    // ---- Leg B: transport unavailability + status-first (isolated) ------
    let (mut runtime_b, authority_b, grant_b) = route_harness(
        "web-channel",
        "org.dolly.channel",
        "g4-backpressure-transport",
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    let mut store_b = channel_store_connection();
    let clock_b = channel_clock();
    {
        let mut receiver = open_channel_inbound_route(
            &mut runtime_b,
            &mut store_b,
            config.clone(),
            Box::new(clock_b.clone()),
            &authority_b,
            &grant_b,
        )
        .expect("channel route registration");
        let event = authenticated_channel_event(
            &authority_b,
            &grant_b,
            config.revision,
            route_content_event("conv-1", "in-1", "later"),
        )
        .expect("sealed event");
        assert!(matches!(receiver.ingest_event(&event), IngressOutcome::Committed { .. }));
    }
    let host_ingress_ops_b = runtime_b
        .query_row(
            "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("baseline");
    let principal_b = dolly_channel::ChannelPrincipal::from_authority_grant(&authority_b, &grant_b)
        .expect("principal");
    let session_b = dolly_channel::ids::dolly_session_id(principal_b.account(), "conv-1");
    let second_id = "0198ab31-6c44-7e8a-b2bb-000000000731";
    let second = route_send_block("web-channel", &[second_id], &session_b, &["later"]);
    commit_send_and_activate(
        &mut runtime_b,
        &authority_b,
        &grant_b,
        "g4-backpressure-unknown",
        ROUTE_INPUT_PAGE,
        second,
        config.clone(),
    );
    let route_b = ChannelOutboundRoute::register(
        config.clone(),
        &mut store_b,
        &authority_b,
        &grant_b,
    )
    .expect("outbound route registration");

    // With a live caller deadline and an unavailable transport, the committed
    // send is dispatched durably (never a fabricated success), stays
    // unresolved, and Core inputs are untouched.
    let silent = RouteSharedTransport::new(true);
    let pass = route_b
        .consume_once(
            &mut store_b,
            &mut runtime_b,
            Box::new(clock_b.clone()),
            Box::new(silent.clone()),
            &far_deadline_str(),
        )
        .expect("transport-unavailable pass");
    assert_eq!(silent.calls().len(), 1, "one dispatch attempted, none re-sent");
    assert_eq!(
        runtime_b
            .query_row(
                "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("operation count"),
        host_ingress_ops_b,
        "transport unavailability never mutates Core input state"
    );

    // Status-first settle: the transport now reports the exact confirmed
    // status; reconcile rests the row with no re-send and Core stays intact.
    let reporting = RouteSharedTransport::new(true);
    reporting.push_status(
        second_id,
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec!["transport-status-1".to_string()],
        },
    );
    let settle = route_b
        .consume_once(
            &mut store_b,
            &mut runtime_b,
            Box::new(clock_b.clone()),
            Box::new(reporting.clone()),
            &far_deadline_str(),
        )
        .expect("status-first consumer pass");
    assert_eq!(settle.remaining, 0, "status-first reconcile rests the row");
    assert_eq!(reporting.status_calls().len(), 1, "one status query");
    assert_eq!(reporting.calls().len(), 0, "zero re-dispatch after dispatch");
    assert_eq!(
        runtime_b
            .query_row(
                "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("operation count"),
        host_ingress_ops_b,
        "Core input state untouched throughout"
    );
}

#[test]
fn g4_wp013a_credentials_paths_and_signed_urls_never_enter_metadata_or_logs() {
    let entry = case("G4-WP013A-REDACTION-001");
    assert_eq!(entry["expected"], "pass");

    let mut connection = probe_connection("web-channel", "g4-redaction");
    let config = channel_config();
    let clock = channel_clock();
    let mut ledger = ChannelLedger::new();

    // A hostile raw event carries credentials, a local path, and a signed
    // URL. parse_event reads only the validated allowlist; the committed
    // draft must never contain any of them.
    let raw = channel_raw_event(&json!({
        "authorization": "Bearer super-secret-token",
        "cookie": "session=leaky",
        "attachment_path": "/home/ubuntu/secrets/private.png",
        "signed_url": "https://storage.example/presigned?token=abc"
    }));
    let event = parse_event(&raw).expect("hostile fields are ignored by parse");
    let outcome = {
        let mut core = CoreBackedIngress::new(&mut connection, "web-channel");
        process_event(&config, &clock, &mut ledger, &mut core, &event)
    };
    assert!(
        outcome.committed_block_id().is_some(),
        "the event committed through the Channel's only durable route"
    );

    let entry = ledger
        .inbound_entry("account-a", "msg-1")
        .expect("ledger row");
    for secret in [
        "authorization".to_string(),
        "Bearer".to_string(),
        "cookie".to_string(),
        "attachment_path".to_string(),
        "signed_url".to_string(),
        "super-secret-token".to_string(),
        "secrets/private.png".to_string(),
    ] {
        assert!(
            !entry.request_jcs.contains(&secret),
            "draft must not contain {secret}"
        );
        assert!(
            !entry
                .attempts
                .iter()
                .any(|a| a.detail_digest.contains(&secret)),
            "attempt history must not contain {secret}"
        );
    }
    // The namespaced metadata record is the fixed allowlist, and the draft
    // schema is the channel block-draft tag, not a caller-shaped block.
    assert!(
        entry.request_jcs.contains("\"org.dolly.channel\""),
        "channel metadata namespace present"
    );
    assert!(
        entry.request_jcs.contains("\"dolly.block-draft/v1\""),
        "draft is the channel block-draft schema"
    );
    assert!(
        !entry.request_jcs.contains("dolly.block/v1"),
        "the producer cannot force a caller-shaped block through the Channel"
    );
}

#[test]
fn g4_wp013a_channel_cannot_append_to_a_page_or_advance_a_cursor_directly() {
    let entry = case("G4-WP013A-NO-DIRECT-MUTATION-001");
    assert_eq!(entry["expected"], "pass");

    // The Channel's only durable write route is the host.ingress.submit seam
    // backed by the real Core transaction. Drive the full inbound pipeline
    // and prove the draft reaches the Page as a committed Block delivery,
    // never as a Page append or Module cursor advance.
    let mut connection = probe_connection("web-channel", "g4-nodirect-channel");
    let config = channel_config();
    let clock = channel_clock();
    let mut ledger = ChannelLedger::new();
    let block_id = {
        let mut core = CoreBackedIngress::new(&mut connection, "web-channel");
        let outcome = process_event(
            &config,
            &clock,
            &mut ledger,
            &mut core,
            &channel_event("account-a", "conv-1", "in-1", "Hello."),
        );
        outcome
            .committed_block_id()
            .expect("inbound event committed")
            .to_string()
    };

    let snapshot = {
        let store = SqliteCoreStore::new(&mut connection).expect("core schema");
        store.snapshot().expect("snapshot")
    };
    // The committed Block is the durable premise; the Page sees it only
    // through the block's deliveries, and no Page record is fabricated and no
    // Module cursor is advanced by the Channel.
    assert!(snapshot.blocks.contains_key(&block_id));
    assert!(
        snapshot.deliveries.iter().any(|delivery| {
            delivery["block_id"] == block_id && delivery["page_id"] == TARGET_PAGE
        }),
        "the draft reaches the Page only as a committed Block delivery"
    );
    assert!(
        snapshot.pages.is_empty(),
        "no Page record is fabricated by the Channel"
    );
    assert!(
        snapshot.ingress.values().all(|record| record.block_id == block_id),
        "the only durable write is the Core ingress premise"
    );
    // The channel ledger rows carry pages: the target is declared there for
    // the Host adapter, never applied by the Channel itself.
    let entry = ledger
        .inbound_entry("account-a", "in-1")
        .expect("ledger row");
    assert_eq!(entry.pages, vec![TARGET_PAGE.to_string()]);
}
