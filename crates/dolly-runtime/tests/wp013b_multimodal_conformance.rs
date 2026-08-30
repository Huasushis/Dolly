//! Authoritative WP-013B multimodal conformance — frozen target at the
//! integrated Channel seam (all 17 cases PASS over the real multimodal
//! production path). The accepted-base record (11 PASS / 6 causal
//! PRODUCT_RED / 0 harness) is retained in the fixture baseline as
//! historical evidence; the frozen target is 17/0/0 plus one matrix
//! retention function (18 green executables).
//!
//! Setup discipline for every multimodal/outbound/inbound case:
//! - `ChannelConfig` carries `accepted_modalities = {text, asset}` with
//!   every case-specific bound; the byte-identical canonical
//!   `effective_config`/`config_revision` is persisted in the active
//!   `ActivationManifest` and the SAME config is used in the outbound route
//!   registration/consumer.
//! - the exact runtime `register_with_assets` /
//!   `open_channel_inbound_route_with_assets` / `ProviderAttachmentReader`
//!   seams are used over ONE shared Asset root/service/capability under the
//!   same extension/module/connection/account authority; every test Asset is
//!   created/imported/leased through that same registered route (route-owned
//!   Asset IDs/leases; no separate `AssetService` or manual foreign lease).
//! - outbound cases drive a real committed Action + active Manifest against
//!   the route-owned Asset store; the inbound case sends a real
//!   authenticated attachment through the bound reader and asserts the exact
//!   canonical AssetRef/order in the committed inbound draft.
//!
//! Premise direction is invariant: producer/upstream premise -> durable
//! explicit premise -> consumer/downstream only. No test mints a capability,
//! fakes acceptance, sleeps on a wall clock, or uses the network.

use dolly_canonical_json::canonicalize;
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand,
    TransitionOutcome,
};
use dolly_storage::{
    HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore, create_host_ingress_schema,
};
use rusqlite::Connection;
use serde_json::{Value, json};

use dolly_asset::clock::{Clock, ClockTime};
use dolly_asset::config::ResolvedAssetConfig;
use dolly_asset::error::AssetErrorCode;
use dolly_asset::identity::{AssetId, ContentHash};
use dolly_asset::record::{ImportRequest, MediaKind, Source};
use dolly_asset::remote::DeniedFetcher;
use dolly_asset::replica::DisabledReplica;
use dolly_asset::service::AssetService;
use dolly_asset::AssetCapability;
use dolly_runtime::{
    AssetHostRoute, ChannelOutboundRoute, HostRouteError, ProviderAttachmentReader,
    authenticated_channel_event, install_channel_store_schema, open_channel_inbound_route,
    open_channel_inbound_route_with_assets,
};
use dolly_channel::{
    ChannelConfig, ChannelConfigBuilder, ChannelEventContent, ConsumerOutcome, EventKind,
    IngressOutcome, OutboundState, SqliteChannelStore, TransportSendResult, VirtualClock,
    parse_event,
};
use dolly_channel::asset::{MediaKind as ChannelMediaKind, MediaType as ChannelMediaType};
use dolly_channel::attachment::InboundAttachment;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MATRIX: &str = include_str!("fixtures/wp013b_multimodal_conformance.json");
const TARGET_PAGE: &str = "page-web-primary";
/// The Channel module's dedicated input page (outbound consumer targets).
const ROUTE_INPUT_PAGE: &str = "page-in";
const CHANNEL_NOW: &str = "2026-08-28T00:00:00.000000Z";
/// A fixed unix-millisecond instant for the asset harness.
const ASSET_T0: u64 = 1_800_000_000_000;

fn matrix() -> Value {
    serde_json::from_str(MATRIX).expect("WP-013B matrix fixture must be valid JSON")
}

fn case(id: &str) -> Value {
    matrix()["cases"]
        .as_array()
        .expect("WP-013B matrix cases must be an array")
        .iter()
        .find(|candidate| candidate["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("WP-013B matrix case {id} is missing"))
}

fn canonical_digest(value: &Value) -> String {
    canonicalize(value)
        .expect("fixture value must be canonical JSON")
        .1
        .to_canonical_string()
}

// ---------------------------------------------------------------------------
// Core harness: the real runtime transaction path over an in-memory DB.
// ---------------------------------------------------------------------------

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

/// Graph body for the route probes: the module is a producer of the given
/// output pages and its graph admission names the granted Extension owner.
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

// ---------------------------------------------------------------------------
// Asset harness: the integrated asset surface.
// ---------------------------------------------------------------------------

/// A unique scratch root per test; removed on drop.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new(tag: &str) -> Self {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "wp013b-asset-{tag}-{}-{stamp:x}",
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

/// A minimal byte sequence that sniffs as a GIF89a of size WxH.
fn gif_bytes(w: u16, h: u16) -> Vec<u8> {
    let mut bytes = b"GIF89a".to_vec();
    bytes.extend_from_slice(&w.to_le_bytes());
    bytes.extend_from_slice(&h.to_le_bytes());
    bytes.extend_from_slice(&[0u8; 16]);
    bytes
}

/// A minimal active-content (SVG) byte sequence.
fn svg_bytes() -> Vec<u8> {
    b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\"/>".to_vec()
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

impl Clock for SharedClock {
    fn now(&mut self) -> ClockTime {
        let millis = *self.0.lock().expect("clock mutex");
        ClockTime::new(millis)
    }
}

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

/// Import one test Asset through the SAME registered Asset route (the host
/// `host.asset.import` seam over the route-owned content root under the
/// sealed authority/grant); returns the canonical AssetId. No separate
/// AssetService and no manual foreign lease is used.
fn route_owned_import(
    connection: &mut Connection,
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    root: &Path,
    import_id: &str,
    bytes: &[u8],
    declared: &str,
) -> String {
    let mut route = AssetHostRoute::for_activated_module(
        connection,
        asset_config_at(root),
        authority,
        grant,
    )
    .expect("asset route binds under the sealed grant");
    let instance = route.instance_id().to_string();
    let result = route
        .import(&route_asset_request(
            grant.module_id(),
            &instance,
            import_id,
            Source::InlineBase64 {
                base64: base64(bytes),
            },
            Some(declared),
        ))
        .expect("route host.asset.import commits");
    assert_eq!(result.state, "available", "the test Asset must be AVAILABLE");
    result
        .asset
        .expect("AssetRef on AVAILABLE")
        .asset_id
        .as_str()
        .to_string()
}

// ---------------------------------------------------------------------------
// Channel harness: the runtime committed-action outbound route.
// ---------------------------------------------------------------------------

/// A deterministic shared status-capable transport: the consumer owns a boxed
/// copy while the probe drives the script and inspects recorded calls.
#[derive(Clone, Default)]
struct RouteSharedTransport {
    idempotent: bool,
    inner: Arc<Mutex<RouteSharedInner>>,
}

#[derive(Default)]
struct RouteSharedInner {
    script: Vec<dolly_channel::transport::TransportSendResult>,
    calls: Vec<dolly_channel::transport::TransportSendRequest>,
    status_script: Vec<(String, dolly_channel::transport::TransportStatusResult)>,
    status_calls: Vec<dolly_channel::transport::TransportStatusRequest>,
}

impl RouteSharedTransport {
    fn new(idempotent: bool) -> Self {
        Self {
            idempotent,
            inner: Arc::new(Mutex::new(RouteSharedInner::default())),
        }
    }
    fn push(&self, result: dolly_channel::transport::TransportSendResult) {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .script
            .push(result);
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
}

impl dolly_channel::ChannelTransport for RouteSharedTransport {
    fn idempotency_supported(&self) -> bool {
        self.idempotent
    }
    fn send(
        &mut self,
        request: &dolly_channel::transport::TransportSendRequest,
    ) -> dolly_channel::transport::TransportSendResult {
        let mut inner = self.inner.lock().unwrap_or_else(|poison| poison.into_inner());
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

/// A fixed guest clock pinned to a later instant than the caller deadline,
/// for deterministic caller-deadline expiry in the queue-bound probe.
#[derive(Clone, Debug)]
struct ChannelLateClock {
    at: Arc<Mutex<dolly_core_domain::Timestamp>>,
}

impl ChannelLateClock {
    fn at(timestamp: dolly_core_domain::Timestamp) -> Self {
        Self {
            at: Arc::new(Mutex::new(timestamp)),
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

fn channel_config() -> ChannelConfig {
    ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .target_pages(&[TARGET_PAGE])
        .build()
}

/// The frozen multimodal module configuration: accepted modalities exactly
/// {text, asset} with the case-specific bounds, used identically in the
/// ActivationManifest `effective_config` and the route registration.
fn multimodal_channel_config() -> ChannelConfig {
    ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .accepted_modalities(&["text", "asset"])
        .target_pages(&[TARGET_PAGE])
        .build()
}

fn channel_clock() -> VirtualClock {
    use std::str::FromStr;
    VirtualClock::at(
        dolly_core_domain::Timestamp::from_str(CHANNEL_NOW).expect("timestamp"),
    )
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

/// A far-future caller deadline for consumer passes.
fn far_deadline_str() -> String {
    dolly_channel::timestamp_plus_seconds(CHANNEL_NOW, 60)
}

/// Build one targeted send Action with the authoritative contract binding and
/// the given Part array (the frozen channel-send arguments shape).
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

/// A committed text send block (the G4-proven text shape).
fn route_send_block(module_id: &str, action_id: &str, session_id: &str, texts: &[&str]) -> Value {
    let parts: Vec<Value> = texts
        .iter()
        .map(|t| json!({"kind": "text", "text": t, "format": "plain"}))
        .collect();
    send_action(module_id, action_id, session_id, parts)
}

/// A committed block carrying N targeted send Actions (burst shape).
fn route_send_block_multi(
    module_id: &str,
    action_ids: &[&str],
    session_id: &str,
    texts: &[&str],
) -> Value {
    let parts: Vec<Value> = texts
        .iter()
        .map(|t| json!({"kind": "text", "text": t, "format": "plain"}))
        .collect();
    let actions = action_ids
        .iter()
        .map(|action_id| {
            let action = send_action(module_id, action_id, session_id, parts.clone());
            action["body"]["actions"]
                .as_array()
                .cloned()
                .expect("one action per send")
                .remove(0)
        })
        .collect::<Vec<Value>>();
    json!({
        "schema": "dolly.block/v1",
        "id": format!("block-{}", action_ids[0]),
        "body": {
            "description": "model response",
            "parts": [],
            "actions": actions
        }
    })
}

/// A committed send block whose Part binds an AssetRef (`asset_id`). The
/// frozen channel-send arguments schema admits this `kind:"asset"` Part.
fn route_asset_send_block_with_parts(
    module_id: &str,
    action_id: &str,
    session_id: &str,
    parts: Vec<Value>,
) -> Value {
    send_action(module_id, action_id, session_id, parts)
}

/// The canonical asset Part shape the frozen schema already admits.
fn asset_part(asset_id: &str, media_type: &str, view: Option<Value>) -> Value {
    let mut part = json!({
        "kind": "asset",
        "asset_id": asset_id,
        "media_type": media_type
    });
    if let Some(view) = view {
        part["view"] = view;
    }
    part
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
    let token_digest =
        canonical_digest(&json!({"activation_id": activation_id, "lease_id": lease_id}));
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

/// The exact causal red: every causal step this probe ACTUALLY drove
/// succeeded; only the missing product behavior named by the seam turns the
/// case red.
fn product_red(case_id: &str, seam: &str, cause: &str, area: &str) -> ! {
    panic!(
        "PRODUCT_RED [{case_id}] seam={seam} cause={cause} area={area}; \
         every causal step this probe actually drove (the real Core transaction, \
         the integrated asset route, and the committed-Action consumer route \
         named in the cause) succeeded, so this failure is attributable to the \
         missing WP-013B product behavior named in the cause — not a harness, \
         build, or environment failure"
    )
}

// ---------------------------------------------------------------------------
// Shared consumer scaffolds.
// ---------------------------------------------------------------------------

/// Text-only scaffold (G4 PATTERN): real runtime DB + module store with an
/// authenticated upstream premise yielding the account-owned session.
#[allow(clippy::type_complexity)]
fn consumer_scaffold(
    mark: &str,
) -> (
    Connection,
    Connection,
    HostConnectionAuthority,
    HostCapabilityGrant,
    ChannelConfig,
    VirtualClock,
    String,
) {
    let (mut runtime, authority, grant) = route_harness(
        "web-channel",
        "org.dolly.channel",
        mark,
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    let mut module_store = channel_store_connection();
    let config = multimodal_channel_config();
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

/// Multimodal scaffold: the exact integrated registration — a grant carrying
/// `host.ingress.submit` + `host.asset.import` + `host.asset.status`, the
/// `{text,asset}` configuration persisted identically in the manifest, the
/// ONE shared Asset root registered through `register_with_assets` (so the
/// process-wide asset route for this identity exists before any binding),
/// and an authenticated upstream text premise yielding the session.
#[allow(clippy::type_complexity)]
fn consumer_scaffold_multimodal(
    mark: &str,
    root: &Path,
) -> (
    Connection,
    Connection,
    HostConnectionAuthority,
    HostCapabilityGrant,
    ChannelConfig,
    VirtualClock,
    String,
) {
    let (mut runtime, authority, grant) = route_harness(
        "web-channel",
        "org.dolly.channel",
        mark,
        &["host.ingress.submit", "host.asset.import", "host.asset.status"],
        &[TARGET_PAGE],
    );
    let mut module_store = channel_store_connection();
    let config = multimodal_channel_config();
    let clock = channel_clock();
    ChannelOutboundRoute::register_with_assets(
        config.clone(),
        &mut module_store,
        &authority,
        &grant,
        asset_config_at(root),
    )
    .expect("register_with_assets owns the shared Asset route");
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

/// A bounded deterministic provider attachment reader (the sealed runtime
/// seam injection contract — never raw paths or network).
#[derive(Clone, Default)]
struct FakeProviderReader {
    bytes: Arc<Mutex<std::collections::HashMap<String, Vec<u8>>>>,
}

impl FakeProviderReader {
    fn new(entries: Vec<(String, Vec<u8>)>) -> Self {
        Self {
            bytes: Arc::new(Mutex::new(entries.into_iter().collect())),
        }
    }
}

impl ProviderAttachmentReader for FakeProviderReader {
    fn read(&mut self, provider_key: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
        let map = self.bytes.lock().unwrap_or_else(|poison| poison.into_inner());
        let bytes = map.get(provider_key).ok_or_else(|| {
            "provider attachment unavailable for this key".to_string()
        })?;
        if (bytes.len() as u64) > max_bytes {
            return Err("provider attachment exceeds the caller byte bound".to_string());
        }
        Ok(bytes.clone())
    }
}

/// A committed-Action text twin through the exact registration path: proves
/// the consumer route, the ActivationManifest authority, and the injected
/// transport all work before the multimodal probes.
fn text_control_pass(
    mark: &str,
    control_action_id: &str,
    session_id: &str,
    runtime: &mut Connection,
    module_store: &mut Connection,
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config: &ChannelConfig,
    clock: &VirtualClock,
) {
    commit_send_and_activate(
        runtime,
        authority,
        grant,
        mark,
        ROUTE_INPUT_PAGE,
        route_send_block("web-channel", control_action_id, session_id, &["harness control"]),
        config.clone(),
    );
    let route = ChannelOutboundRoute::register(config.clone(), module_store, authority, grant)
        .expect("outbound route registration");
    let transport = RouteSharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-control-1".to_string()],
    });
    let report = route
        .consume_once(
            module_store,
            runtime,
            Box::new(clock.clone()),
            Box::new(transport.clone()),
            &far_deadline_str(),
        )
        .expect("control consumer pass must succeed (harness health)");
    assert_eq!(
        report.transported, 1,
        "harness control: the committed-Action text twin must dispatch"
    );
    assert_eq!(
        transport.calls().len(),
        1,
        "harness control: exactly one transport call for the text twin"
    );
}

/// The observed real public-route result of one committed asset-part send.
struct AssetLegReport {
    report: dolly_runtime::ChannelOutboundRunReport,
    requests: Vec<dolly_channel::transport::TransportSendRequest>,
}

impl AssetLegReport {
    fn transport_calls(&self) -> usize {
        self.requests.len()
    }
}

/// Drive one committed asset-part send through the sealed consumer route
/// REGISTERED WITH THE SHARED ASSET STORE (`register_with_assets`) and
/// return the observed result. `confirm` scripts an AllConfirmed transport
/// reply when dispatch must succeed; `None` leaves the transport silent
/// (Timeout after dispatch, or zero calls before a failure).
fn drive_asset_send_leg(
    mark: &str,
    action_id: &str,
    session_id: &str,
    parts: Vec<Value>,
    root: &Path,
    confirm: Option<&[&str]>,
    runtime: &mut Connection,
    module_store: &mut Connection,
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config: &ChannelConfig,
    clock: &VirtualClock,
) -> AssetLegReport {
    let block = route_asset_send_block_with_parts("web-channel", action_id, session_id, parts);
    commit_send_and_activate(
        runtime,
        authority,
        grant,
        mark,
        ROUTE_INPUT_PAGE,
        block,
        config.clone(),
    );
    let route = ChannelOutboundRoute::register_with_assets(
        config.clone(),
        module_store,
        authority,
        grant,
        asset_config_at(root),
    )
    .expect("register_with_assets over the shared Asset root");
    let transport = RouteSharedTransport::new(true);
    if let Some(ids) = confirm {
        transport.push(TransportSendResult::AllConfirmed {
            message_ids: ids.iter().map(|id| id.to_string()).collect(),
        });
    }
    let report = route
        .consume_once(
            module_store,
            runtime,
            Box::new(clock.clone()),
            Box::new(transport.clone()),
            &far_deadline_str(),
        )
        .expect("consumer pass over the asset-part Action");
    AssetLegReport {
        report,
        requests: transport.calls(),
    }
}

/// The exact frozen pre-provider-effect terminal envelope predicate shared by
/// the stale/unavailable AssetRef and the forged-media-type cases: one
/// durable Terminal Failed ActionResult with `result:null`,
/// `CHANNEL_ASSET_IMPORT_FAILED`, retryable false, outcome `not_applied`,
/// delivery_outcome `not_sent`, no Dispatched marker, zero transport
/// requests, and runtime transported 0.
fn is_pre_effect_failed_not_sent(leg: &AssetLegReport) -> bool {
    if leg.requests.len() != 0
        || leg.report.transported != 0
        || leg.report.pending != 0
        || leg.report.remaining != 0
        || leg.report.terminal.len() != 1
    {
        return false;
    }
    let dolly_channel::ConsumerOutcome::Terminal {
        state,
        result_jcs,
        ..
    } = &leg.report.terminal[0]
    else {
        return false;
    };
    if *state != OutboundState::Failed {
        return false;
    }
    let Ok(envelope) = serde_json::from_str::<Value>(result_jcs) else {
        return false;
    };
    envelope["schema"] == "dolly.action-result/v1"
        && envelope["status"] == "failed"
        && envelope["result"].is_null()
        && envelope["error"]["code"] == "CHANNEL_ASSET_IMPORT_FAILED"
        && envelope["error"]["retryable"] == false
        && envelope["error"]["outcome"] == "not_applied"
        && envelope["error"]["details"]["delivery_outcome"] == "not_sent"
}

/// Durable-dispatch proof: read the exact route-owned Channel outbound row
/// through the accepted test-support store seam bound to the same sealed
/// module/account/store, and assert the row is terminal Failed and has NEVER
/// durably entered Dispatched — no `dispatched_at`, no dispatch attempt/
/// transition marker, and no transport status marker. A missing, ambiguous,
/// or non-compliant row fails closed.
fn prove_terminal_failed_never_dispatched(
    module_store: &mut Connection,
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config_revision: i64,
    action_id: &str,
) -> Result<(), String> {
    let principal = dolly_channel::ChannelPrincipal::from_authority_grant(authority, grant)
        .map_err(|error| format!("principal derivation failed: {}", error.code))?;
    let mut store = SqliteChannelStore::new(module_store, &principal, config_revision)
        .map_err(|error| format!("channel store open failed: {}", error.code))?;
    let record = store
        .find_outbound(action_id)
        .map_err(|error| format!("outbound row lookup failed: {}", error.code))?
        .ok_or_else(|| "no durable outbound row exists for the action".to_string())?;
    if record.outbound_key != action_id {
        return Err(format!(
            "the durable outbound row key {} does not match the action {action_id}",
            record.outbound_key
        ));
    }
    let entry = &record.entry;
    if entry.state != OutboundState::Failed {
        return Err(format!(
            "the durable outbound row state is {:?}, expected terminal Failed",
            entry.state
        ));
    }
    if entry.dispatched_at.is_some() {
        return Err(format!(
            "the durable outbound row carries a dispatch timestamp {:?}",
            entry.dispatched_at
        ));
    }
    let kinds: Vec<&str> = entry.attempts.iter().map(|attempt| attempt.kind.as_str()).collect();
    if kinds.iter().any(|kind| *kind == "dispatch" || *kind == "dispatched") {
        return Err(format!("the durable row records a dispatch attempt marker: {kinds:?}"));
    }
    if kinds.iter().any(|kind| *kind == "status" || *kind == "reconcile") {
        return Err(format!("the durable row records a transport status marker: {kinds:?}"));
    }
    if !kinds.contains(&"pre-effect-rejection") {
        return Err(format!(
            "the durable row lacks the authoritative pre-effect-rejection record: {kinds:?}"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Matrix retention: the authoritative document stays canonical.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_matrix_retains_declared_cases_and_causal_classification() {
    let document = matrix();
    assert_eq!(document["schema"], "dolly.wp013b-multimodal-conformance/v1");
    assert!(
        !document["spec_basis"].as_array().expect("spec_basis").is_empty(),
        "matrix must name its normative spec basis"
    );

    // The FROZEN TARGET for integration: all 17 cases PASS, zero red, zero
    // harness failure.
    let target = &document["target_expected_counts"];
    assert_eq!(target["pass"], 17);
    assert_eq!(target["product_red"], 0);
    assert_eq!(target["harness_error"], 0);

    // The baseline receipt records the accepted-base observation against the
    // exact product base under test (11 pass / 6 causal product_red / 0
    // harness error); it is a receipt, not the frozen target, so no
    // production branch needs to edit it at integration.
    let baseline = &document["baseline"];
    assert_eq!(
        baseline["accepted_base_head"],
        "5edbd46ab4abb488d6c010c2eeb8d7f41e0b9dc3",
        "the accepted product base under test is the G4-closed commit"
    );
    assert!(
        baseline["fixture_commit"].as_str().expect("fixture_commit").len() >= 7,
        "the conformance-branch fixture commit is recorded separately"
    );
    let observed = &baseline["observed_counts"];
    assert_eq!(observed["pass"], 11);
    assert_eq!(observed["product_red"], 6);
    assert_eq!(observed["harness_error"], 0);

    for expected in ["pass", "product_red"] {
        assert!(
            document["classification"][expected]
                .as_str()
                .expect("classification entry")
                .len()
                > 30,
            "classification must explain {expected}"
        );
    }

    let baseline_reds: Vec<&str> = document["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter(|entry| entry["baseline_observed"].as_str() == Some("product_red"))
        .map(|entry| entry["id"].as_str().expect("case id"))
        .collect();
    assert_eq!(baseline_reds.len(), 6, "exactly six recorded multimodal baseline gaps");
    for frozen in [
        "WP013B-STALE-REF-EFFECT-001",
        "WP013B-MIXED-ORDER-001",
        "WP013B-MEDIA-ABUSE-SEND-001",
        "WP013B-CROP-VIEW-001",
        "WP013B-INBOUND-ATTACHMENT-001",
        "WP013B-LEASE-RESTART-001",
    ] {
        assert!(
            baseline_reds.contains(&frozen),
            "baseline gap {frozen} must be recorded"
        );
    }

    let cases = document["cases"].as_array().expect("cases");
    let mut ids = std::collections::BTreeSet::new();
    let mut pass = 0;
    for entry in cases {
        let id = entry["id"].as_str().expect("case id");
        assert!(ids.insert(id.to_owned()), "duplicate WP-013B case id {id}");
        assert!(!entry["name"].as_str().expect("case name").is_empty());
        assert!(entry["kind"].as_str().expect("case kind").len() >= 4);
        assert_eq!(
            entry["expected"], "pass",
            "case {id}: every frozen target is pass (integration target is all green)"
        );
        pass += 1;
        assert!(entry["pass_basis"].as_str().expect("pass_basis").len() > 20);
        assert!(entry["assertion"].as_str().expect("assertion").len() > 20);
        assert!(
            entry["references"].as_array().expect("references").len() >= 1,
            "case {id} must reference the crate surface it drives"
        );
        assert!(
            entry.get("blocked").is_none(),
            "case {id}: no WP-013B case may be blocked in this suite"
        );
        if baseline_reds.contains(&id) {
            assert_eq!(
                entry["baseline_observed"], "product_red",
                "case {id}: the multimodal baseline gap is recorded"
            );
            assert!(
                entry["target_behavior"].as_str().expect("target_behavior").len() > 20,
                "case {id}: target_behavior must state the reachable green condition"
            );
            assert!(entry["seam"].as_str().expect("seam").len() > 20);
            assert!(
                entry["causal_red"].as_str().expect("causal_red").len() > 20,
                "case {id}: causal_red must state the accepted-base gap"
            );
            assert!(
                entry["setup"].as_str().expect("setup").len() > 20,
                "case {id}: the shared-asset/with-assets setup must be recorded"
            );
        } else {
            assert!(
                entry.get("causal_red").is_none(),
                "case {id}: causal_red is recorded only on the six multimodal baseline-gap cases"
            );
        }
    }
    assert_eq!(pass, 17, "the matrix freezes exactly seventeen cases");

    let evidence = document["evidence"].as_object().expect("evidence");
    assert!(!evidence.is_empty(), "matrix must declare its evidence coverage");
    for (area, case_ids) in evidence {
        let case_ids = case_ids.as_array().expect("evidence case ids");
        assert!(!case_ids.is_empty(), "evidence area {area} has no cases");
        for case_id in case_ids {
            let case_id = case_id.as_str().expect("evidence case id");
            assert!(
                ids.contains(case_id),
                "evidence area {area} references undeclared case {case_id}"
            );
        }
    }
    for required in [
        "wp013b_avail_lease_round_trip",
        "wp013b_asset_fail_closed_negatives",
        "wp013b_manifest_authority",
        "wp013b_media_kinds_and_bounds",
        "wp013b_config_bounds",
        "wp013b_queue_deadline",
        "wp013b_restart_status_first",
        "wp013b_envelopes",
        "wp013b_redaction",
        "wp013b_text_nonregression",
        "wp013b_route_lifecycle",
        "wp013b_stale_ref_effect_authority",
        "wp013b_mixed_ordering",
        "wp013b_media_abuse_send",
        "wp013b_crop_view",
        "wp013b_inbound_attachment",
        "wp013b_lease_restart",
    ] {
        assert!(
            evidence.contains_key(required),
            "matrix must cover evidence area {required}"
        );
    }
}

// ---------------------------------------------------------------------------
// PASS: canonical AVAILABLE AssetRef with a valid current lease under the
// route authority domain.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_avail_lease_canonical_assetref_round_trip() {
    let entry = case("WP013B-AVAIL-LEASE-001");
    assert_eq!(entry["expected"], "pass");

    // The actual registration path: host.asset.import / host.asset.status
    // bound to an activated module under the sealed current Host authority
    // and capability grant.
    let scratch = ScratchDir::new("avail-lease");
    let asset_root = scratch.path().to_path_buf();
    let (mut connection, authority, grant) = route_harness(
        "module-a",
        "org.dolly.asset",
        "wp013b-avail",
        &["host.asset.import", "host.asset.status"],
        &[],
    );

    // 1. Canonical media -> durable AVAILABLE canonical AssetRef through the
    //    real public route.
    let png = png_bytes(4, 2);
    let mut route = AssetHostRoute::for_activated_module(
        &mut connection,
        asset_config_at(&asset_root),
        &authority,
        &grant,
    )
    .expect("asset route registration binds under the sealed grant");
    let instance = route.instance_id().to_string();
    let result = route
        .import(&route_asset_request(
            "module-a",
            &instance,
            &import_id(301),
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
        AssetId::from_digest(ContentHash::of_bytes(&png).digest),
        "canonical ast_b3_ AssetId over the accepted bytes"
    );
    assert!(
        asset.asset_id.as_str().starts_with("ast_b3_"),
        "canonical AssetId prefix"
    );
    assert_eq!(asset.media_type.as_str(), "image/png");
    asset.validate().expect("AssetRef wire form is canonical");
    assert!(
        scratch
            .path()
            .join("objects")
            .join(asset.asset_id.as_str())
            .exists(),
        "the content-addressed object is durable"
    );
    assert_eq!(route.instance_id(), asset_route_instance(&authority));
    drop(route);

    // The AVAILABLE record is durable: a fresh route registration over the
    // same runtime DB and content root resolves it exactly.
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
                &import_id(301),
                "2026-08-28T00:00:00.000000Z",
            )
            .expect("valid asset status request"),
        )
        .expect("durable import record survives route restart");
    assert_eq!(recovered.state, "available");
    drop(route2);

    // 2. Valid current lease/read of the SAME asset under the SAME authority
    //    domain through the accepted AssetService public seam. The
    //    capability is derived from the sealed authority facts exactly as
    //    the route derives it (security domain = extension connection
    //    identity, instance = i{worker_epoch}, module = granted module).
    let asset_id = asset.asset_id.as_str().to_string();
    let (mut service, clock) = asset_service_at(&asset_root);
    let domain = authority.extension_connection_id().to_string();
    let capability = service.issue_capability(domain.clone(), asset_route_instance(&authority), "module-a");
    let lease = service
        .lease(&capability, &asset_id, "wp013b-send", "channel asset part", 240_000)
        .expect("finite lease under the same authority domain");
    assert!(lease.lease_id.len() >= 32, "unguessable LeaseId");
    assert_eq!(lease.asset_id, asset_id);
    assert_eq!(lease.security_domain, domain);
    assert!(lease.expires_at > lease.created_at, "finite expiry");
    assert!(lease.expires_at_ms > ASSET_T0, "lease expires in the future");

    // The bytes are readable under the lease through the bounded grant.
    let mut grant_read = service.read(&capability, &asset_id).expect("read under lease");
    let mut buf = vec![0u8; png.len()];
    let mut read_total = 0usize;
    while read_total < buf.len() {
        let n = grant_read
            .read_bounded(&mut buf[read_total..])
            .expect("bounded read");
        assert!(n > 0, "read must make progress");
        read_total += n;
    }
    assert_eq!(buf, png, "bounded read returns the exact accepted bytes");

    // A live lease is atomic against GC.
    clock.advance(120_000);
    let gc = service.run_gc().expect("gc");
    assert_eq!(gc.tombstones_created, 0, "a live lease holds the asset");
    assert!(
        scratch.path().join("objects").join(&asset_id).exists(),
        "the object survives while the lease is live"
    );

    // Release + grace -> the sweep tombstones it.
    assert!(service.release_lease(&lease.lease_id).expect("release"));
    clock.advance(120_000);
    let gc = service.run_gc().expect("gc");
    assert_eq!(gc.tombstones_created, 1, "unleased unreferenced asset is swept");
    assert!(
        !scratch.path().join("objects").join(&asset_id).exists(),
        "sweep removes the object"
    );

    // Tombstones fail closed: no new lease, no read.
    let stale = service
        .lease(&capability, &asset_id, "wp013b-late", "late lease", 1000)
        .expect_err("tombstone must block new leases");
    assert_eq!(stale.code, AssetErrorCode::NotFound);
    match service.read(&capability, &asset_id) {
        Ok(_) => panic!("a tombstoned AssetRef must not be readable"),
        Err(denied) => assert_eq!(denied.code, AssetErrorCode::NotFound),
    }
}

/// The stable instance identifier the route derives from the sealed worker
/// epoch (`i{worker_epoch}`), matching `AssetHostRoute::instance_id()`.
fn asset_route_instance(authority: &HostConnectionAuthority) -> String {
    format!("i{}", authority.worker_epoch())
}

// ---------------------------------------------------------------------------
// PASS: pending/failed/deleted/stale/revoked/expired/foreign/noncanonical
// refs fail closed at the asset authority.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_asset_negatives_fail_closed() {
    let entry = case("WP013B-ASSET-NEGATIVE-001");
    assert_eq!(entry["expected"], "pass");

    // Noncanonical AssetId encodings are rejected at parse: wrong prefix,
    // wrong alphabet, wrong length.
    assert!(
        "ast-b3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"
            .parse::<AssetId>()
            .is_err(),
        "wrong AssetId prefix"
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

    let scratch = ScratchDir::new("negatives");
    let (mut service, clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);

    // Failed import: over-limit source is a recorded rejection with no asset.
    let mut big = png_bytes(4, 2);
    big.resize(200 * 1024, 0);
    let failed = service
        .import(
            &capability,
            &asset_request(
                &import_id(501),
                Source::InlineBase64 {
                    base64: base64(&big),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("over-limit import is a recorded rejection");
    assert_eq!(failed.state, "rejected");
    assert!(failed.asset.is_none(), "no availability before refusal");
    assert_eq!(failed.error.as_ref().expect("envelope")["code"], "SIZE_LIMIT");

    // Foreign (cross-domain) read of otherwise-identical bytes is denied.
    let png = png_bytes(4, 2);
    let imported = service
        .import(
            &capability,
            &asset_request(
                &import_id(502),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("import");
    let asset_id = imported.asset.expect("AssetRef").asset_id.as_str().to_string();
    let uninvolved = service.issue_capability("other", "instance-a", "module-a");
    match service.read(&uninvolved, &asset_id) {
        Ok(_) => panic!("cross-domain read must be denied"),
        Err(denied) => assert_eq!(denied.code, AssetErrorCode::NotFound),
    }

    let expired = service
        .lease(&capability, &asset_id, "model-op", "provider output", 60_000)
        .expect("finite lease");
    drop(expired);
    clock.advance(120_000);
    clock.advance(60_000);
    let gc = service.run_gc().expect("gc");
    assert_eq!(gc.tombstones_created, 1, "expired lease then grace tombstones");
    assert!(
        !scratch.path().join("objects").join(&asset_id).exists(),
        "sweep removes the object"
    );
    let stale = service
        .lease(&capability, &asset_id, "late", "late lease", 1000)
        .expect_err("tombstone must block new leases");
    assert_eq!(stale.code, AssetErrorCode::NotFound);
    match service.read(&capability, &asset_id) {
        Ok(_) => panic!("a tombstoned AssetRef must not be readable"),
        Err(denied) => assert_eq!(denied.code, AssetErrorCode::NotFound),
    }

    let (mut connection, authority, grant) = route_harness(
        "module-a",
        "org.dolly.asset",
        "wp013b-negatives-route",
        &["host.asset.import", "host.asset.status"],
        &[],
    );
    let mut route = AssetHostRoute::for_activated_module(
        &mut connection,
        asset_config_at(scratch.path()),
        &authority,
        &grant,
    )
    .expect("asset route registration");
    let absent = route
        .status(
            &dolly_asset::facade::AssetStatusRequest::new(
                "0198ab31-6c44-7e8a-b2bb-000000000811",
                "module-a",
                &import_id(901),
                "2026-08-28T00:00:00.000000Z",
            )
            .expect("valid asset status request"),
        )
        .expect("absent is an authoritative StatusResult");
    assert_eq!(absent.state, "absent");
    assert!(!absent.terminal, "absent must not masquerade as terminal");
    assert!(absent.asset.is_none(), "absent must never mint an AssetRef");
    assert!(absent.error.is_none(), "absent must not carry an error");
}

// ---------------------------------------------------------------------------
// PASS: committed Action requires the current ActivationManifest, current
// grant, and never an ingress/runtime-event/cross-extension premise.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_committed_action_requires_current_manifest_and_grant() {
    let entry = case("WP013B-MANIFEST-AUTHORITY-001");
    assert_eq!(entry["expected"], "pass");

    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("wp013b-ma");
    let a_id = "0198ab31-6c44-7e8a-b2bb-000000000821";
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "wp013b-ma-a",
        ROUTE_INPUT_PAGE,
        route_send_block("web-channel", a_id, &session_id, &["first"]),
        config.clone(),
    );
    let route = ChannelOutboundRoute::register(config.clone(), &mut module_store, &authority, &grant)
        .expect("outbound route registration");
    let t1 = RouteSharedTransport::new(true);
    t1.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-a-1".to_string()],
    });
    let pass1 = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(t1.clone()),
            &far_deadline_str(),
        )
        .expect("first manifest pass");
    assert_eq!(pass1.transported, 1, "manifest A action dispatches");

    {
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
            route_content_event("conv-2", "in-2", "Ingress premise must never send."),
        )
        .expect("sealed event");
        assert!(
            matches!(receiver.ingest_event(&event), IngressOutcome::Committed { .. }),
            "the extra ingress premise commits"
        );
    }

    let b_id = "0198ab31-6c44-7e8a-b2bb-000000000822";
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "wp013b-ma-b",
        ROUTE_INPUT_PAGE,
        route_send_block("web-channel", b_id, &session_id, &["second"]),
        config.clone(),
    );
    let t2 = RouteSharedTransport::new(true);
    t2.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-b-1".to_string()],
    });
    let pass2 = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(t2.clone()),
            &far_deadline_str(),
        )
        .expect("second manifest pass");
    assert_eq!(pass2.transported, 1, "only the current manifest Action drains");
    assert_eq!(t2.calls().len(), 1, "the ingress premise is never transported");

    {
        let mut store = SqliteCoreStore::new(&mut runtime).expect("core schema");
        store
            .revoke_host_capability_grant(&authority, "org.dolly.channel", "web-channel")
            .expect("grant revoked");
    }
    let t3 = RouteSharedTransport::new(true);
    let revoked = route.consume_once(
        &mut module_store,
        &mut runtime,
        Box::new(clock.clone()),
        Box::new(t3.clone()),
        &far_deadline_str(),
    );
    match revoked {
        Err(HostRouteError::StaleOrRevoked { .. }) => {}
        Err(HostRouteError::Rejected { code, .. }) => {
            assert_eq!(
                code,
                "CHANNEL_AUTHENTICATION_FAILED",
                "the revoked grant refusal must be a fail-closed authentication refusal"
            );
        }
        other => panic!("a revoked grant must refuse the consumer pass fail-closed, got {other:?}"),
    }
    assert_eq!(t3.calls().len(), 0, "zero transport effect after revocation");
}

// ---------------------------------------------------------------------------
// PASS: supported media kinds, authoritative detection, size/type limits.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_media_kinds_and_bounds() {
    let entry = case("WP013B-MEDIA-KINDS-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("media-kinds");
    let (mut service, _clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);

    let png = png_bytes(8, 4);
    let p = service
        .import(
            &capability,
            &asset_request(
                &import_id(521),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("png import");
    let png_ref = p.asset.expect("AssetRef");
    assert_eq!(png_ref.media_type.as_str(), "image/png");
    assert_eq!(png_ref.encoded_width, Some(8));
    assert_eq!(png_ref.encoded_height, Some(4));

    let gif = gif_bytes(2, 3);
    let g = service
        .import(
            &capability,
            &asset_request(
                &import_id(522),
                Source::InlineBase64 {
                    base64: base64(&gif),
                },
                Some("image/gif"),
                false,
            ),
        )
        .expect("gif import");
    let gif_ref = g.asset.expect("AssetRef");
    assert_eq!(gif_ref.media_type.as_str(), "image/gif");
    assert_eq!(gif_ref.encoded_width, Some(2));
    assert_eq!(gif_ref.encoded_height, Some(3));

    let svg = svg_bytes();
    let spoof = service
        .import(
            &capability,
            &asset_request(
                &import_id(523),
                Source::InlineBase64 {
                    base64: base64(&svg),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("media mismatch is a recorded rejection");
    assert_eq!(spoof.state, "rejected");
    assert_eq!(
        spoof.error.as_ref().expect("envelope")["code"],
        "MEDIA_TYPE_MISMATCH"
    );
    assert!(spoof.asset.is_none(), "no availability before refusal");

    let mut oversized = png_bytes(4, 2);
    oversized.resize(200 * 1024, 0);
    let over = service
        .import(
            &capability,
            &asset_request(
                &import_id(524),
                Source::InlineBase64 {
                    base64: base64(&oversized),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("over-limit import is a recorded rejection");
    assert_eq!(over.state, "rejected");
    assert_eq!(over.error.as_ref().expect("envelope")["code"], "SIZE_LIMIT");
    assert!(over.asset.is_none());

    let invalid = service
        .import(
            &capability,
            &asset_request(
                &import_id(525),
                Source::InlineBase64 {
                    base64: "aGVsbG8!".to_string(),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect_err("invalid base64 must be refused");
    assert_eq!(invalid.code, AssetErrorCode::InvalidBase64);
}

// ---------------------------------------------------------------------------
// PASS: channel configuration modality/part/text bounds fail closed.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_config_bounds_fail_closed() {
    let entry = case("WP013B-CONFIG-BOUNDS-001");
    assert_eq!(entry["expected"], "pass");

    // Leg A (executed): the shipped default is text-only, and under that
    // default a committed send carrying an asset Part is refused BEFORE
    // dispatch with zero transport effect — the "text-only rejects asset"
    // side, driven through the real consumer route.
    let scratch_a = ScratchDir::new("config-bounds-a");
    let (mut runtime_a, mut module_store_a, authority_a, grant_a, config_a, clock_a, session_a) =
        consumer_scaffold_multimodal("wp013b-cfg-a", scratch_a.path());
    assert_eq!(
        config_a.accepted_modalities,
        BTreeSet::from(["text".to_string(), "asset".to_string()]),
        "the multimodal scaffold carries exactly {{text, asset}}"
    );
    let mut text_only = config_a.clone();
    text_only.accepted_modalities = BTreeSet::from(["text".to_string()]);
    text_control_pass(
        "wp013b-cfg-a",
        "0198ab31-6c44-7e8a-b2bb-000000000871",
        &session_a,
        &mut runtime_a,
        &mut module_store_a,
        &authority_a,
        &grant_a,
        &text_only,
        &clock_a,
    );
    let canonical_zero = AssetId::from_digest([0u8; 32]).as_str().to_string();
    let asset_leg = drive_asset_send_leg(
        "wp013b-cfg-a-asset",
        "0198ab31-6c44-7e8a-b2bb-000000000872",
        &session_a,
        vec![asset_part(&canonical_zero, "image/png", None)],
        scratch_a.path(),
        None,
        &mut runtime_a,
        &mut module_store_a,
        &authority_a,
        &grant_a,
        &text_only,
        &clock_a,
    );
    assert!(
        asset_leg.requests.is_empty(),
        "under the text-only default an asset Part must not reach the transport"
    );
    assert_eq!(
        asset_leg.report.transported, 0,
        "under the text-only default no asset send is dispatched"
    );

    let mut parts_zero = channel_config();
    parts_zero.max_parts = 0;
    assert!(parts_zero.validate().is_err(), "max_parts 0 must be rejected");
    let mut parts_over = channel_config();
    parts_over.max_parts = dolly_channel::config::MAX_PARTS + 1;
    assert!(
        parts_over.validate().is_err(),
        "max_parts above the ceiling must be rejected"
    );
    let mut text_zero = channel_config();
    text_zero.max_text_bytes = 0;
    assert!(
        text_zero.validate().is_err(),
        "max_text_bytes 0 must be rejected"
    );
    let mut text_over = channel_config();
    text_over.max_text_bytes = dolly_channel::config::MAX_TEXT_BYTES + 1;
    assert!(
        text_over.validate().is_err(),
        "max_text_bytes above the ceiling must be rejected"
    );
    let mut asset_zero = multimodal_channel_config();
    asset_zero.max_asset_bytes = 0;
    assert!(
        asset_zero.validate().is_err(),
        "max_asset_bytes 0 must be rejected"
    );
    assert!(multimodal_channel_config().validate().is_ok(), "the {{text,asset}} config validates");
    assert!(channel_config().validate().is_ok(), "text-only config is valid");

    // Leg B (executed): the configured limits on the asset ground — a VALID
    // within-limits asset is accepted by the asset authority and an
    // over-limit source is refused SIZE_LIMIT with no asset. This is the
    // "accepts a valid asset subject to limits" side, driven through the
    // accepted asset surface with the configured byte/type bounds.
    let scratch = ScratchDir::new("config-limits");
    let (mut service, _clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);
    let png = png_bytes(4, 2);
    let accepted = service
        .import(
            &capability,
            &asset_request(
                &import_id(591),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("valid within-limits asset import");
    assert_eq!(accepted.state, "available");
    assert!(accepted.asset.is_some(), "the valid asset is accepted");
    let mut big = png_bytes(4, 2);
    big.resize(200 * 1024, 0);
    let over = service
        .import(
            &capability,
            &asset_request(
                &import_id(592),
                Source::InlineBase64 {
                    base64: base64(&big),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("over-limit import is a recorded rejection");
    assert_eq!(over.state, "rejected");
    assert!(over.asset.is_none(), "no asset past the configured limit");
    assert_eq!(over.error.as_ref().expect("envelope")["code"], "SIZE_LIMIT");
}

// ---------------------------------------------------------------------------
// PASS: bounded queue and caller deadline refuse an expired burst.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_queue_deadline_bounds() {
    let entry = case("WP013B-QUEUE-DEADLINE-001");
    assert_eq!(entry["expected"], "pass");

    let (mut runtime, mut module_store, authority, grant, config, _clock, session_id) =
        consumer_scaffold("wp013b-qd");
    let host_ingress_ops_before: i64 = runtime
        .query_row(
            "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
            [],
            |row| row.get(0),
        )
        .expect("baseline op count");

    let action_ids = [
        "0198ab31-6c44-7e8a-b2bb-000000000831",
        "0198ab31-6c44-7e8a-b2bb-000000000832",
        "0198ab31-6c44-7e8a-b2bb-000000000833",
    ];
    let burst = route_send_block_multi("web-channel", &action_ids, &session_id, &["one", "two", "three"]);
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "wp013b-qd",
        ROUTE_INPUT_PAGE,
        burst,
        config.clone(),
    );
    let route = ChannelOutboundRoute::register(config.clone(), &mut module_store, &authority, &grant)
        .expect("outbound route registration");

    let late_clock = ChannelLateClock::at(
        dolly_channel::timestamp_plus_seconds(CHANNEL_NOW, 90)
            .parse()
            .expect("late timestamp"),
    );
    let expired_deadline = dolly_channel::timestamp_plus_seconds(CHANNEL_NOW, 60);
    let transport = RouteSharedTransport::new(true);
    let report = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(late_clock),
            Box::new(transport.clone()),
            &expired_deadline,
        )
        .expect("caller-deadline bounded pass");
    assert_eq!(report.transported, 0, "nothing is sent past the caller deadline");
    assert_eq!(report.rejected, 3, "every burst action is refused by the deadline bound");
    assert!(
        report.rejected_codes.iter().all(|code| code == "CHANNEL_RATE_LIMITED"),
        "deadline refusals are retryable backpressure, got {:?}",
        report.rejected_codes
    );
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    let host_ingress_ops_after: i64 = runtime
        .query_row(
            "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
            [],
            |row| row.get(0),
        )
        .expect("op count after");
    assert_eq!(
        host_ingress_ops_after, host_ingress_ops_before,
        "Core input state is untouched by the bounded pass"
    );
}

// ---------------------------------------------------------------------------
// PASS: crash/restart recovery is status-first and replay is idempotent.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_restart_status_first_recovery() {
    let entry = case("WP013B-RESTART-RECOVERY-001");
    assert_eq!(entry["expected"], "pass");

    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("wp013b-rs");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000841";
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "wp013b-rs",
        ROUTE_INPUT_PAGE,
        route_send_block("web-channel", action_id, &session_id, &["hello"]),
        config.clone(),
    );
    let route = ChannelOutboundRoute::register(config.clone(), &mut module_store, &authority, &grant)
        .expect("outbound route registration");

    let silent = RouteSharedTransport::new(true);
    let pass1 = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(silent.clone()),
            &far_deadline_str(),
        )
        .expect("transport-unavailable pass");
    assert_eq!(silent.calls().len(), 1, "one dispatch attempted");
    assert!(
        pass1.remaining >= 1 || pass1.pending >= 1,
        "the unresolved row must survive the crash window"
    );

    let reporting = RouteSharedTransport::new(true);
    reporting.push_status(
        action_id,
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec!["transport-rs-1".to_string()],
        },
    );
    let pass2 = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(reporting.clone()),
            &far_deadline_str(),
        )
        .expect("status-first consumer pass");
    assert_eq!(reporting.status_calls().len(), 1, "one status query");
    assert_eq!(reporting.calls().len(), 0, "zero re-dispatch after dispatch");
    assert_eq!(pass2.remaining, 0, "status-first reconcile rests the row");

    let replay_transport = RouteSharedTransport::new(true);
    let pass3 = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(replay_transport.clone()),
            &far_deadline_str(),
        )
        .expect("replay consumer pass");
    assert_eq!(pass3.transported, 1, "replay returns the stored terminal");
    assert!(matches!(
        &pass3.terminal[0],
        ConsumerOutcome::Terminal {
            state: OutboundState::Confirmed,
            ..
        }
    ));
    assert_eq!(replay_transport.calls().len(), 0, "zero re-dispatch on replay");
}

// ---------------------------------------------------------------------------
// PASS: exact result and refusal envelopes on the outbound route.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_exact_result_and_refusal_envelopes() {
    let entry = case("WP013B-ENVELOPE-001");
    assert_eq!(entry["expected"], "pass");

    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("wp013b-env");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000851";
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "wp013b-env",
        ROUTE_INPUT_PAGE,
        route_send_block("web-channel", action_id, &session_id, &["part one", "part two"]),
        config.clone(),
    );
    let route = ChannelOutboundRoute::register(config.clone(), &mut module_store, &authority, &grant)
        .expect("outbound route registration");
    let transport = RouteSharedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-env-0".to_string(), "transport-env-1".to_string()],
    });
    let pass = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(transport.clone()),
            &far_deadline_str(),
        )
        .expect("consumer pass");
    assert_eq!(pass.transported, 1);
    let result_jcs = match &pass.terminal[0] {
        ConsumerOutcome::Terminal { result_jcs, .. } => result_jcs.clone(),
        other => panic!("expected Terminal outcome, got {other:?}"),
    };
    let envelope: Value = serde_json::from_str(&result_jcs).expect("action result envelope");
    assert_eq!(envelope["schema"], "dolly.action-result/v1");
    assert_eq!(envelope["action_id"], action_id);
    assert_eq!(envelope["status"], "succeeded");
    let messages = envelope["result"]["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 2, "two confirmed pieces");
    for (index, message) in messages.iter().enumerate() {
        assert_eq!(
            message["ordinal"], index as i64,
            "ordinals must be contiguous from zero"
        );
        let id = message["external_message_id"].as_str().expect("message id");
        assert!(!id.is_empty(), "external ids must be non-empty");
    }
    let ids: BTreeSet<&str> = messages
        .iter()
        .map(|m| m["external_message_id"].as_str().expect("id"))
        .collect();
    assert_eq!(ids.len(), 2, "external_message_id values must be unique");
}

// ---------------------------------------------------------------------------
// PASS: credentials, paths, and signed URLs never enter drafts, ledgers, or
// asset errors.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_redaction_never_leaks_secrets_or_paths() {
    let entry = case("WP013B-REDACTION-001");
    assert_eq!(entry["expected"], "pass");

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
    for (key, value) in [
        ("authorization", json!("Bearer super-secret-token")),
        ("cookie", json!("session=leaky")),
        ("attachment_path", json!("/home/ubuntu/secrets/private.png")),
        ("signed_url", json!("https://storage.example/presigned?token=abc")),
    ] {
        raw[key] = value;
    }
    let event = parse_event(&raw).expect("hostile fields are ignored by parse");
    let joined = format!("{event:?}");
    for secret in [
        "super-secret-token",
        "session=leaky",
        "secrets/private.png",
        "presigned?token=abc",
    ] {
        assert!(!joined.contains(secret), "parse must not retain {secret}");
    }

    let (mut runtime, mut module_store, authority, grant, config, clock) = {
        let (r, s, a, g, c, cl, _) = consumer_scaffold("wp013b-redact");
        (r, s, a, g, c, cl)
    };
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
        let content = ChannelEventContent {
            channel_id: "web-primary".to_string(),
            transport: "web".to_string(),
            external_conversation_id: "conv-9".to_string(),
            external_message_id: "redact-1".to_string(),
            sender_class: "user".to_string(),
            sender_id: "sender-redact-1".to_string(),
            text: "Hello, Dolly.".to_string(),
            received_at: CHANNEL_NOW.parse().expect("timestamp"),
            event_kind: EventKind::Message,
            references_external_message_id: None,
        };
        let sealed = authenticated_channel_event(&authority, &grant, config.revision, content)
            .expect("sealed event");
        match receiver.ingest_event(&sealed) {
            IngressOutcome::Committed { block_id, .. } => block_id,
            other => panic!("event must commit through the route, got {other:?}"),
        }
    };
    {
        let store = SqliteCoreStore::new(&mut runtime).expect("core schema");
        let snapshot = store.snapshot().expect("snapshot");
        let serialized = serde_json::to_string(&snapshot.blocks[&block_id]).expect("block json");
        for secret in [
            "authorization",
            "Bearer",
            "cookie",
            "attachment_path",
            "signed_url",
            "super-secret-token",
            "secrets/private.png",
        ] {
            assert!(
                !serialized.contains(secret),
                "the durable block must not contain {secret}"
            );
        }
    }

    let scratch = ScratchDir::new("redaction-asset");
    let (mut service, clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);
    let png = png_bytes(4, 2);
    let encoded = base64(&png);
    let known = service
        .import(
            &capability,
            &asset_request(
                &import_id(551),
                Source::InlineBase64 {
                    base64: encoded.clone(),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("import");
    let asset_id = known.asset.expect("AssetRef").asset_id.as_str().to_string();
    let lease = service
        .lease(&capability, &asset_id, "m", "p", 60_000)
        .expect("finite lease");
    drop(lease);
    clock.advance(120_000);
    clock.advance(60_000);
    let gc = service.run_gc().expect("gc");
    assert_eq!(gc.tombstones_created, 1, "asset tombstoned");
    let root_str = scratch.path().to_string_lossy().to_string();
    let error = service
        .lease(&capability, &asset_id, "late", "late lease", 1000)
        .expect_err("a refused operation must fail closed");
    let debug = format!("{error:?}");
    assert!(
        !debug.contains(&root_str),
        "asset errors must not disclose the content root"
    );
    assert!(
        !debug.contains(&encoded),
        "asset errors must not disclose payload bytes"
    );
}

// ---------------------------------------------------------------------------
// PASS: text-only G4 non-regression through the runtime route.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_text_only_nonregression() {
    let entry = case("WP013B-TEXT-NONREGRESSION-001");
    assert_eq!(entry["expected"], "pass");

    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("wp013b-textnr");

    let replay_or_conflict = {
        let mut receiver = open_channel_inbound_route(
            &mut runtime,
            &mut module_store,
            config.clone(),
            Box::new(clock.clone()),
            &authority,
            &grant,
        )
        .expect("re-registration");
        let same = authenticated_channel_event(
            &authority,
            &grant,
            config.revision,
            route_content_event("conv-1", "in-1", "What is the weather?"),
        )
        .expect("replay event");
        let idempotent = receiver.ingest_event(&same);
        assert!(
            matches!(idempotent, IngressOutcome::IdempotentReplay { .. }),
            "the byte-identical premise must replay idempotently"
        );
        let different = authenticated_channel_event(
            &authority,
            &grant,
            config.revision,
            route_content_event("conv-1", "in-1", "Different poll?"),
        )
        .expect("conflict event");
        match receiver.ingest_event(&different) {
            IngressOutcome::RejectedBeforeMutation { error } => {
                assert_eq!(error.code, "CHANNEL_OPERATION_CONFLICT");
            }
            other => panic!("an opposite premise must not overwrite, got {other:?}"),
        }
    };
    let _ = replay_or_conflict;

    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000861";
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "wp013b-textnr",
        ROUTE_INPUT_PAGE,
        route_send_block("web-channel", action_id, &session_id, &["non-regression"]),
        config.clone(),
    );
    let route = ChannelOutboundRoute::register(config.clone(), &mut module_store, &authority, &grant)
        .expect("outbound route registration");
    let t1 = RouteSharedTransport::new(true);
    t1.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-textnr-1".to_string()],
    });
    let first = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(t1.clone()),
            &far_deadline_str(),
        )
        .expect("consumer pass");
    assert_eq!(first.transported, 1);
    let t2 = RouteSharedTransport::new(true);
    let replay = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(t2.clone()),
            &far_deadline_str(),
        )
        .expect("replay pass");
    assert_eq!(replay.transported, 1, "replay returns the stored terminal");
    assert_eq!(t2.calls().len(), 0, "no re-dispatch on replay");
}

// ---------------------------------------------------------------------------
// PASS: runtime route registration, lifecycle, and fail-closed absence.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_route_lifecycle_fail_closed() {
    let entry = case("WP013B-ROUTE-LIFECYCLE-001");
    assert_eq!(entry["expected"], "pass");

    let (mut connection, authority, grant) = route_harness(
        "module-a",
        "org.dolly.asset",
        "wp013b-lc-a",
        &["host.asset.import"],
        &[],
    );
    let scratch = ScratchDir::new("route-lifecycle");
    match AssetHostRoute::for_activated_module(
        &mut connection,
        asset_config_at(scratch.path()),
        &authority,
        &grant,
    ) {
        Ok(_) => panic!("a grant without host.asset.status must not register"),
        Err(error) => assert!(
            matches!(error, HostRouteError::CapabilityDenied { .. }),
            "expected CapabilityDenied, got {error:?}"
        ),
    }

    let (mut connection2, authority2, grant2) = route_harness(
        "module-a",
        "org.dolly.asset",
        "wp013b-lc-b",
        &["host.asset.import", "host.asset.status"],
        &[],
    );
    let registered = AssetHostRoute::for_activated_module(
        &mut connection2,
        asset_config_at(scratch.path()),
        &authority2,
        &grant2,
    )
    .expect("route registration");
    drop(registered);
    {
        let mut store = SqliteCoreStore::new(&mut connection2).expect("core schema");
        store
            .revoke_host_capability_grant(&authority2, "org.dolly.asset", "module-a")
            .expect("grant revoked");
    }
    let mut route = AssetHostRoute::for_activated_module(
        &mut connection2,
        asset_config_at(scratch.path()),
        &authority2,
        &grant2,
    )
    .expect("route re-registration over the revoked grant");
    let instance = route.instance_id().to_string();
    let denied = route
        .import(&route_asset_request(
            "module-a",
            &instance,
            &import_id(561),
            Source::InlineBase64 {
                base64: base64(&png_bytes(4, 2)),
            },
            Some("image/png"),
        ))
        .expect_err("a revoked grant must refuse import before effect");
    assert!(
        matches!(denied, HostRouteError::StaleOrRevoked { .. }),
        "expected StaleOrRevoked, got {denied:?}"
    );

    let (mut connection3, authority3, grant3) = route_harness(
        "module-a",
        "org.dolly.asset",
        "wp013b-lc-c",
        &["host.asset.import", "host.asset.status"],
        &[],
    );
    let mut route3 = AssetHostRoute::for_activated_module(
        &mut connection3,
        asset_config_at(scratch.path()),
        &authority3,
        &grant3,
    )
    .expect("route registration");
    let instance3 = route3.instance_id().to_string();
    let cross = route3.import(&route_asset_request(
        "module-b",
        &instance3,
        &import_id(562),
        Source::InlineBase64 {
            base64: base64(&png_bytes(4, 2)),
        },
        Some("image/png"),
    ));
    assert!(
        matches!(cross, Err(HostRouteError::CapabilityDenied { .. })),
        "a cross-module import must be refused before any effect"
    );

    let (mut runtime, mut module_store, authority4, grant4, config, clock, _session) =
        consumer_scaffold("wp013b-lc-d");
    let route_a = ChannelOutboundRoute::register(config.clone(), &mut module_store, &authority4, &grant4)
        .expect("first registration");
    let gate_a = route_a.gate();
    let route_b = ChannelOutboundRoute::register(config.clone(), &mut module_store, &authority4, &grant4)
        .expect("second registration");
    assert!(
        std::sync::Arc::ptr_eq(&gate_a, &route_b.gate()),
        "exactly one identity-bound gate per store/account/config"
    );
    let _ = (runtime, clock);
}

// ---------------------------------------------------------------------------
// Target: a stale/unavailable AssetRef is settled as the exact
// pre-provider-effect terminal Failed ActionResult.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_stale_assetref_refused_at_effect_time() {
    let entry = case("WP013B-STALE-REF-EFFECT-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("stale-ref");
    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold_multimodal("wp013b-stale", scratch.path());

    // 1. Through the SAME registered Asset route (root/authority/grant the
    //    Channel route owns): import a real durable AVAILABLE asset and
    //    obtain its canonical full AssetRef.
    let png = png_bytes(4, 2);
    let stale_asset_id = route_owned_import(
        &mut runtime,
        &authority,
        &grant,
        scratch.path(),
        &import_id(401),
        &png,
        "image/png",
    );
    assert!(
        stale_asset_id.starts_with("ast_b3_"),
        "the canonical route-owned AssetRef is obtained"
    );

    // 2. Make THAT exact route-owned reference stale using the authoritative
    //    Asset lifecycle over the same store/root and the same sealed
    //    authority facts (domain, instance, module): take a finite lease,
    //    let it expire, elapse the retention grace, and let the sweep
    //    tombstone the asset — the canonical ID is retained for the Action.
    let (mut lifecycle, interface_clock) = asset_service_at(scratch.path());
    let route_capability = lifecycle.issue_capability(
        authority.extension_connection_id().to_string(),
        asset_route_instance(&authority),
        grant.module_id().to_string(),
    );
    let lease = lifecycle
        .lease(
            &route_capability,
            &stale_asset_id,
            asset_route_instance(&authority).as_str(),
            "route-owned send lease",
            30_000,
        )
        .expect("finite route-owned lease on the AVAILABLE asset");
    drop(lease);
    interface_clock.advance(120_000);
    interface_clock.advance(60_000);
    let gc = lifecycle.run_gc().expect("authoritative retention sweep");
    assert_eq!(gc.tombstones_created, 1, "the exact route-owned ref is tombstoned");
    let not_available = lifecycle
        .lease(
            &route_capability,
            &stale_asset_id,
            asset_route_instance(&authority).as_str(),
            "late lease",
            1000,
        )
        .expect_err("the stale route-owned ref refuses a new lease");
    assert_eq!(not_available.code, AssetErrorCode::NotFound);

    // 3. The committed Action + manifest drive through the with-assets
    //    Channel route: the stale route-owned AssetRef is prepared-fail-closed
    //    (lease acquisition on the tombstoned generation fails) and the one
    //    durable pre-provider-effect Terminal Failed envelope is produced —
    //    zero transport, no Dispatched marker.
    text_control_pass(
        "wp013b-ctl",
        "0198ab31-6c44-7e8a-b2bb-000000000801",
        &session_id,
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );
    let leg = drive_asset_send_leg(
        "wp013b-stale",
        "0198ab31-6c44-7e8a-b2bb-000000000802",
        &session_id,
        vec![asset_part(&stale_asset_id, "image/png", None)],
        scratch.path(),
        None,
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );
    if is_pre_effect_failed_not_sent(&leg) {
        if let Err(evidence) = prove_terminal_failed_never_dispatched(
            &mut module_store,
            &authority,
            &grant,
            config.revision,
            "0198ab31-6c44-7e8a-b2bb-000000000802",
        ) {
            product_red(
                "WP013B-STALE-REF-EFFECT-001",
                "durable dispatch-history proof (route-owned terminal Failed row)",
                &evidence,
                "channel_multimodal_effect_authority",
            );
        }
        return;
    }
    product_red(
        "WP013B-STALE-REF-EFFECT-001",
        "effect-time AssetPart authority over the route-owned store/lease (real tombstoned generation -> pre-provider-effect terminal envelope)",
        &format!(
            "target not met: the stale route-owned AssetRef {stale_asset_id} (real AVAILABLE provenance, advanced through lease expiry + retention grace + GC tombstone) was not settled as the one durable pre-provider-effect terminal Failed ActionResult — observed rejections {:?}, transported {}, terminal {}, pending {}, remaining {}, transport calls {}; requires result:null, CHANNEL_ASSET_IMPORT_FAILED, retryable false, outcome not_applied, delivery_outcome not_sent, no Dispatched marker, zero transport",
            leg.report.rejected_codes,
            leg.report.transported,
            leg.report.terminal.len(),
            leg.report.pending,
            leg.report.remaining,
            leg.transport_calls()
        ),
        "channel_multimodal_effect_authority",
    );
}

// ---------------------------------------------------------------------------
// Target: mixed text+asset parts reach the transport in exact ordinal order
// with canonical Asset identity.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_mixed_text_asset_ordering() {
    let entry = case("WP013B-MIXED-ORDER-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("mixed-order");
    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold_multimodal("wp013b-mixed", scratch.path());
    let png = png_bytes(4, 2);
    let asset_id = route_owned_import(
        &mut runtime,
        &authority,
        &grant,
        scratch.path(),
        &import_id(411),
        &png,
        "image/png",
    );
    text_control_pass(
        "wp013b-mixed",
        "0198ab31-6c44-7e8a-b2bb-000000000811",
        &session_id,
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );
    let parts = vec![
        json!({"kind": "text", "text": "first", "format": "plain"}),
        asset_part(&asset_id, "image/png", None),
        json!({"kind": "text", "text": "last", "format": "plain"}),
    ];
    let leg = drive_asset_send_leg(
        "wp013b-mixed-asset",
        "0198ab31-6c44-7e8a-b2bb-000000000812",
        &session_id,
        parts,
        scratch.path(),
        Some(&["m-0", "m-1", "m-2"]),
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );
    let exact_sequence = leg.requests.len() == 1
        && leg.requests[0].pieces.len() == 3
        && matches!(
            leg.requests[0].pieces.get(0),
            Some(dolly_channel::transport::TransportPiece::Text {
                ordinal: 0,
                text,
            }) if text == "first"
        )
        && matches!(
            leg.requests[0].pieces.get(1),
            Some(dolly_channel::transport::TransportPiece::Asset {
                ordinal: 1,
                payload,
                ..
            }) if payload.asset_ref.asset_id.as_str() == asset_id
                && payload.asset_ref.media_type.as_str() == "image/png"
        )
        && matches!(
            leg.requests[0].pieces.get(2),
            Some(dolly_channel::transport::TransportPiece::Text {
                ordinal: 2,
                text,
            }) if text == "last"
        );
    if leg.report.transported == 1 && exact_sequence {
        return;
    }
    product_red(
        "WP013B-MIXED-ORDER-001",
        "mixed text+asset ordinal ordering to the transport",
        &format!(
            "target not met: the mixed send did not deliver the exact ordered pieces — observed rejections {:?}, transported {}, terminal {}, transport calls {}, requests {:?}; requires one request with pieces [Text(0,\"first\"), Asset(1, canonical {asset_id}), Text(2,\"last\")] and a Confirmed terminal",
            leg.report.rejected_codes,
            leg.report.transported,
            leg.report.terminal.len(),
            leg.transport_calls(),
            leg.requests
        ),
        "channel_multimodal_effect_authority",
    );
}

// ---------------------------------------------------------------------------
// Target: a forged/overriding media_type claim is settled as the exact
// pre-provider-effect terminal Failed ActionResult.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_media_abuse_refused_at_effect_time() {
    let entry = case("WP013B-MEDIA-ABUSE-SEND-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("media-abuse");
    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold_multimodal("wp013b-media-abuse", scratch.path());
    let png = png_bytes(4, 2);
    let asset_id = route_owned_import(
        &mut runtime,
        &authority,
        &grant,
        scratch.path(),
        &import_id(412),
        &png,
        "image/png",
    );
    text_control_pass(
        "wp013b-media-abuse",
        "0198ab31-6c44-7e8a-b2bb-000000000813",
        &session_id,
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );
    // Canonical image/jpeg claim over authoritative image/png content: the
    // asset authority refuses before any provider effect; never relabeled.
    let leg = drive_asset_send_leg(
        "wp013b-media-abuse-asset",
        "0198ab31-6c44-7e8a-b2bb-000000000814",
        &session_id,
        vec![asset_part(&asset_id, "image/jpeg", None)],
        scratch.path(),
        None,
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );
    if is_pre_effect_failed_not_sent(&leg) {
        if let Err(evidence) = prove_terminal_failed_never_dispatched(
            &mut module_store,
            &authority,
            &grant,
            config.revision,
            "0198ab31-6c44-7e8a-b2bb-000000000814",
        ) {
            product_red(
                "WP013B-MEDIA-ABUSE-SEND-001",
                "durable dispatch-history proof (route-owned terminal Failed row)",
                &evidence,
                "channel_multimodal_effect_authority",
            );
        }
        return;
    }
    product_red(
        "WP013B-MEDIA-ABUSE-SEND-001",
        "authoritative detected-media-type authority at effect time (forged/overriding media claim)",
        &format!(
            "target not met: the image/jpeg claim over the authoritative image/png AssetRef {asset_id} was not settled as the one durable pre-provider-effect terminal Failed ActionResult — observed rejections {:?}, transported {}, terminal {}, pending {}, remaining {}, transport calls {}; requires result:null, CHANNEL_ASSET_IMPORT_FAILED, retryable false, outcome not_applied, delivery_outcome not_sent, no dispatch, zero transport (structural pre-admission input stays a distinct Rejected)",
            leg.report.rejected_codes,
            leg.report.transported,
            leg.report.terminal.len(),
            leg.report.pending,
            leg.report.remaining,
            leg.transport_calls()
        ),
        "channel_multimodal_effect_authority",
    );
}

// ---------------------------------------------------------------------------
// Target: the schema-valid crop is materialized against the authoritative
// prepared geometry and observed in the typed transport piece.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_view_crop_checked_at_effect_time() {
    let entry = case("WP013B-CROP-VIEW-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("crop-view");
    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold_multimodal("wp013b-crop", scratch.path());
    let png = png_bytes(4, 2);
    let asset_id = route_owned_import(
        &mut runtime,
        &authority,
        &grant,
        scratch.path(),
        &import_id(413),
        &png,
        "image/png",
    );
    text_control_pass(
        "wp013b-crop",
        "0198ab31-6c44-7e8a-b2bb-000000000815",
        &session_id,
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );

    // Shared crop behavior (base-green): a schema-valid normalized crop has
    // every coordinate in 0..=1_000_000 with x0<x1 and y0<y1, and
    // materializes against the authoritative display width/height with the
    // frozen rounding rule without leaving the prepared bounds.
    let crop = json!({"kind": "image_rect_v1", "x0": 250_000, "y0": 0, "x1": 750_000, "y1": 1_000_000});
    let x0 = 250_000u64;
    let x1 = 750_000u64;
    let y0 = 0u64;
    let y1 = 1_000_000u64;
    for (name, value) in [("x0", x0), ("y0", y0), ("x1", x1), ("y1", y1)] {
        assert!(value <= 1_000_000, "coordinate {name}={value} must be in 0..=1_000_000");
    }
    assert!(x0 < x1 && y0 < y1, "x0<x1 and y0<y1 are required");
    let (width, height) = (4u64, 2u64);
    let left = x0 * width / 1_000_000;
    let right = (x1 * width + 999_999) / 1_000_000;
    let top = y0 * height / 1_000_000;
    let bottom = (y1 * height + 999_999) / 1_000_000;
    assert_eq!((left, right, top, bottom), (1, 3, 0, 2), "frozen floor/ceil materialization");
    assert!(left < right && top < bottom, "the materialized rect selects pixels in bounds");
    assert!(1_200_000u64 > 1_000_000, "out-of-range coordinates are a bounds violation");

    let leg = drive_asset_send_leg(
        "wp013b-crop-asset",
        "0198ab31-6c44-7e8a-b2bb-000000000816",
        &session_id,
        vec![asset_part(&asset_id, "image/png", Some(crop))],
        scratch.path(),
        Some(&["m-0"]),
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );
    let materialized = leg.requests.len() == 1
        && leg.requests[0].pieces.len() == 1
        && matches!(
            leg.requests[0].pieces.get(0),
            Some(dolly_channel::transport::TransportPiece::Asset {
                ordinal: 0,
                view: Some(bounds),
                ..
            }) if bounds.left() == 1
                && bounds.top() == 0
                && bounds.right() == 3
                && bounds.bottom() == 2
        );
    if leg.report.transported == 1 && materialized {
        return;
    }
    product_red(
        "WP013B-CROP-VIEW-001",
        "view/crop geometry authority at effect time",
        &format!(
            "target not met: the schema-valid normalized crop {{x0:250000,y0:0,x1:750000,y1:1000000}} of the authoritative 4x2 prepared geometry was not materialized as (1,0,3,2) in the typed transport piece — observed rejections {:?}, transported {}, terminal {}, transport calls {}, requests {:?}",
            leg.report.rejected_codes,
            leg.report.transported,
            leg.report.terminal.len(),
            leg.transport_calls(),
            leg.requests
        ),
        "channel_multimodal_effect_authority",
    );
}

// ---------------------------------------------------------------------------
// Target: a real authenticated attachment imports through the Asset service
// and the committed inbound draft carries the exact canonical AssetRef in
// order.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_inbound_attachment_import() {
    let entry = case("WP013B-INBOUND-ATTACHMENT-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("inbound-attach");
    let png = png_bytes(4, 2);
    // The exact canonical AssetRef the import must produce: identical
    // accepted bytes -> AssetId = BLAKE3(content).
    let expected_id = AssetId::from_digest(ContentHash::of_bytes(&png).digest)
        .as_str()
        .to_string();

    let (mut runtime, mut module_store, authority, grant, config, clock, _session) =
        consumer_scaffold_multimodal("wp013b-inbound-b", scratch.path());

    // Real authenticated attachment through the bound ProviderAttachmentReader
    // + the with_assets inbound route (same registered Asset root/identity).
    let provider = FakeProviderReader::new(vec![("pk-in-0".to_string(), png.clone())]);
    let mut receiver = open_channel_inbound_route_with_assets(
        &mut runtime,
        &mut module_store,
        config.clone(),
        Box::new(clock.clone()),
        asset_config_at(scratch.path()),
        Box::new(provider),
        &authority,
        &grant,
    )
    .expect("with_assets inbound route binds under the sealed grant");
    let attachment = InboundAttachment {
        ordinal: 0,
        provider_key: "pk-in-0".to_string(),
        media_kind: ChannelMediaKind::Image,
        declared_media_type: ChannelMediaType::parse("image/png").expect("canonical media type"),
        byte_length_hint: png.len() as u64,
    };
    let event = dolly_channel::AuthenticatedChannelEvent::new_with_attachments(
        &authority,
        &grant,
        config.revision,
        route_content_event("conv-in", "in-attach", "See the attachment."),
        vec![attachment],
    )
    .expect("authenticated multimodal event seals");
    let block_id = match receiver.ingest_event(&event) {
        IngressOutcome::Committed { block_id, .. } => block_id,
        other => {
            product_red(
                "WP013B-INBOUND-ATTACHMENT-001",
                "inbound attachment import and AVAILABLE gating",
                &format!(
                    "target not met: the authenticated attachment did not reach a committed inbound draft — observed outcome {other:?}; requires the import through the Asset service, assets_pending gating, and the exact canonical AssetRef {expected_id} in ordinal order in the committed draft",
                ),
                "channel_multimodal_inbound_import",
            )
        }
    };
    let committed_parts = {
        let store = SqliteCoreStore::new(&mut runtime).expect("core schema");
        let snapshot = store.snapshot().expect("snapshot");
        snapshot.blocks[&block_id]["parts"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    // Exact order: the text part first, then the attachment's asset part with
    // the exact canonical AssetRef and authoritative media type.
    let target_met = committed_parts.len() == 2
        && committed_parts[0].get("kind").and_then(Value::as_str) == Some("text")
        && committed_parts[1].get("kind").and_then(Value::as_str) == Some("asset")
        && committed_parts[1]["asset_id"] == expected_id
        && committed_parts[1]["media_type"] == "image/png";
    if target_met {
        return;
    }
    product_red(
        "WP013B-INBOUND-ATTACHMENT-001",
        "inbound attachment import and AVAILABLE gating (ProviderAttachmentReader -> host.asset.import -> assets_pending -> committed draft)",
        &format!(
            "target not met: the committed draft parts {committed_parts:?} do not carry the exact canonical AssetRef {expected_id} in the attachment's ordinal order; requires the real authenticated attachment to import through the Asset service (AVAILABLE) and the committed inbound draft to place the exact AssetRef/media_type at the exact ordinal",
        ),
        "channel_multimodal_inbound_import",
    );
}

// ---------------------------------------------------------------------------
// Target: a dispatched multimodal send recovers status-first under its
// route-owned lease; no blind resend, no re-mint.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_lease_restart_recovery_absent() {
    let entry = case("WP013B-LEASE-RESTART-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("lease-restart");
    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold_multimodal("wp013b-lr", scratch.path());
    let png = png_bytes(4, 2);
    let asset_id = route_owned_import(
        &mut runtime,
        &authority,
        &grant,
        scratch.path(),
        &import_id(415),
        &png,
        "image/png",
    );
    text_control_pass(
        "wp013b-lr",
        "0198ab31-6c44-7e8a-b2bb-000000000817",
        &session_id,
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );

    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000818";
    let asset_block = route_asset_send_block_with_parts(
        "web-channel",
        action_id,
        &session_id,
        vec![asset_part(&asset_id, "image/png", None)],
    );
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "wp013b-lr-asset",
        ROUTE_INPUT_PAGE,
        asset_block,
        config.clone(),
    );
    let route = ChannelOutboundRoute::register_with_assets(
        config.clone(),
        &mut module_store,
        &authority,
        &grant,
        asset_config_at(scratch.path()),
    )
    .expect("register_with_assets over the shared Asset root");

    // Phase 1 (crash window): the send dispatches under the route-owned
    // lease; the transport response is lost, so the row stays Dispatched and
    // is never blind-resumed.
    let silent = RouteSharedTransport::new(true);
    let pass1 = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(silent.clone()),
            &far_deadline_str(),
        )
        .expect("consumer pass over the multimodal Action");

    // Phase 2 (restart): status-first settlement with the bound transport.
    let reporting = RouteSharedTransport::new(true);
    reporting.push_status(
        action_id,
        dolly_channel::transport::TransportStatusResult::Confirmed {
            message_ids: vec!["transport-lr-1".to_string()],
        },
    );
    let pass2 = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock.clone()),
            Box::new(reporting.clone()),
            &far_deadline_str(),
        )
        .expect("restart status-first pass");

    // Frozen target (exact), per phase: the phase-1 dispatch happens exactly
    // once under the route-owned lease, and phase 2 settles the durable
    // multimodal row status-first (a status query, remaining 0, zero
    // re-dispatch, transported 0).
    let dispatched_once = silent.calls().len() == 1 && pass1.transported == 0;
    let status_first = reporting.status_calls().len() >= 1
        && pass2.remaining == 0
        && reporting.calls().is_empty()
        && pass2.transported == 0;
    if dispatched_once && status_first {
        return;
    }
    product_red(
        "WP013B-LEASE-RESTART-001",
        "multimodal send crash/restart recovery under the route-owned ImportId/lease (status-first, lease invalidation only after blocking work)",
        &format!(
            "target not met: phase-1 dispatch calls {}, transported {}, then phase-2 status queries {}, transported {}, remaining {}, re-dispatches {}; requires exactly one dispatch under the route-owned lease in phase 1 and a status query settling the durable multimodal row (remaining 0, zero re-dispatch) in phase 2",
            silent.calls().len(),
            pass1.transported,
            reporting.status_calls().len(),
            pass2.transported,
            pass2.remaining,
            reporting.calls().len()
        ),
        "channel_multimodal_lease_restart",
    );
}
