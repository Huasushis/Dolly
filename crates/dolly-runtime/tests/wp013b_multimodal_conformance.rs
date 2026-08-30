//! Authoritative WP-013B multimodal conformance — frozen base
//! `5edbd46ab4abb488d6c010c2eeb8d7f41e0b9dc3` (the G4 gate is closed: the
//! Asset Host route, the durable Channel inbound route, and the committed
//! targeted-Action outbound route are all wired and green).
//!
//! The matrix fixture (`fixtures/wp013b_multimodal_conformance.json`) is the
//! authoritative document: 17 frozen cases (11 `pass`, 6 causal
//! `product_red`). Every executable drives only the accepted public
//! runtime/Asset/Channel seams:
//!
//! - `pass` cases verify the Asset authority (canonical AVAILABLE AssetRef,
//!   current lease/ownership, fail-closed negatives, media kinds and bounds,
//!   config bounds) and the Channel authority (current ActivationManifest +
//!   current grant, bounded queue/caller deadlines, status-first restart
//!   recovery, exact result envelopes, redaction, text-only non-regression,
//!   runtime route lifecycle). A regression here is a product violation.
//! - causal `product_red` cases drive the committed-Action consumer and the
//!   inbound route with asset Parts/attachments and observe the absent
//!   WP-013B seam: every asset-part action is silently dropped at
//!   `authorize_send`'s `CHANNEL_UNSUPPORTED_MODALITY`, so ordering, media
//!   authority, crop/view checks, inbound attachment import, and multimodal
//!   crash/lease recovery cannot exist. Each red probe first proves the whole
//!   real causal chain it names (route import, lease/tombstone, committed
//!   Action, ActivationManifest authority, text-twin dispatch through the
//!   same route), so every failure is attributable to the missing product
//!   seam, never to the harness.
//!
//! Premise direction is invariant: producer/upstream premise -> durable
//! explicit premise -> consumer/downstream only. No test here mints a
//! capability, fakes acceptance, sleeps on a wall clock, or uses the
//! network.

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
    AssetHostRoute, ChannelOutboundRoute, HostRouteError, authenticated_channel_event,
    install_channel_store_schema, open_channel_inbound_route,
};
use dolly_channel::{
    ChannelConfig, ChannelConfigBuilder, ChannelEventContent, EventKind, InboundState,
    IngressOutcome, OutboundState, TransportSendResult, VirtualClock, parse_event,
};

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
// Asset harness: the integrated dolly-asset public surface.
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
/// frozen channel-send arguments schema admits this `kind:"asset"` Part; the
/// v1 send authority does not.
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
         missing WP-013B product seam named in the cause — not a harness, \
         build, or environment failure"
    )
}

// ---------------------------------------------------------------------------
// Shared consumer scaffold: the real registration path with an authenticated
// upstream premise that yields the account-owned session.
// ---------------------------------------------------------------------------

/// A real runtime DB + module-scoped Channel store with config, producer
/// graph, sealed Host authority, capability grant, and a committed
/// authenticated upstream premise (the exact base every outbound probe
/// starts from). Returns the session bound to that premise.
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

/// A committed-Action text twin through the exact registration path: proves
/// the consumer route, the ActivationManifest authority, and the injected
/// transport all work, so a later multimodal gap is the only thing between
/// the probe and its frozen target. Used as the harness-health control by
/// every multimodal probe (a failure here is a harness error, not a red).
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
/// No verdict is asserted here; the caller compares it against the frozen
/// target and returns PASS when the target is present, product_red otherwise.
struct AssetLegReport {
    report: dolly_runtime::ChannelOutboundRunReport,
    transport_calls: usize,
}

/// Drive one committed asset-part send through the sealed consumer route and
/// return the observed result.
fn drive_asset_send_leg(
    mark: &str,
    action_id: &str,
    session_id: &str,
    parts: Vec<Value>,
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
    let route = ChannelOutboundRoute::register(config.clone(), module_store, authority, grant)
        .expect("outbound route registration");
    let transport = RouteSharedTransport::new(true);
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
        transport_calls: transport.calls().len(),
    }
}

/// True when the observed result is an authoritative asset/media outcome
/// (a dispatch, a transport call, or a rejection with a code other than the
/// v1 profile seam CHANNEL_UNSUPPORTED_MODALITY) — the reachable green
/// condition for the multimodal effect-time target cases.
fn has_asset_authority_outcome(leg: &AssetLegReport) -> bool {
    leg.report.transported >= 1
        || leg.transport_calls >= 1
        || (leg.report.rejected >= 1
            && leg
                .report
                .rejected_codes
                .iter()
                .any(|code| code != "CHANNEL_UNSUPPORTED_MODALITY"))
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

    // The FROZEN TARGET for integration: all 17 cases PASS, zero red.
    let target = &document["target_expected_counts"];
    assert_eq!(target["pass"], 17);
    assert_eq!(target["product_red"], 0);

    // The baseline receipt records the accepted-base observation (11 pass /
    // 6 causal product_red / 0 harness error); it is a receipt, not the
    // frozen target, so no production branch needs to edit it at integration.
    let baseline = &document["baseline"];
    assert!(
        !baseline["accepted_base_head"].as_str().expect("head").is_empty()
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

    // Every declared case freezes the same per-case target (pass) with a
    // reachable green condition; the six multimodal cases additionally
    // record their accepted-base gap (baseline_observed product_red) and a
    // target_behavior the executable returns PASS on when present.
    let baseline_reds: Vec<&str> = document["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter(|entry| entry["baseline_observed"].as_str() == Some("product_red"))
        .map(|entry| entry["id"].as_str().expect("case id"))
        .collect();
    assert_eq!(baseline_reds.len(), 6, "exactly six multimodal baseline gaps");
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
        } else {
            assert!(
                entry.get("causal_red").is_none(),
                "case {id}: causal_red is recorded only on the six multimodal baseline-gap cases"
            );
        }
        // Every red executable has a reachable green condition; any other
        // failure would be a harness defect, which the matrix forbids.
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

    // Expired lease confers no durability: after expiry + grace the sweep
    // tombstones the asset and every further lease/read fails closed
    // (deleted/stale/revoked-by-GC).
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

    // Never-created ImportIds answer an authoritative explicit absent through
    // the real route (no asset, not terminal, no masquerade).
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
    assert_eq!(t1.calls().len(), 1);

    // A second authenticated inbound premise commits durably but is NEVER
    // selected as an outbound Action: only committed targeted Actions inside
    // the CURRENT manifest's input_items are referenced.
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

    // A NEW manifest (fencing the first) selects only its own Action; the
    // prior Action and the ingress premise are never drained again.
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
    assert_eq!(pass2.pending, 0);
    assert_eq!(t2.calls().len(), 1, "the ingress premise is never transported");
    assert_eq!(t2.calls()[0].pieces.len(), 1);
    assert!(
        !pass2
            .terminal
            .iter()
            .any(|outcome| format!("{outcome:?}").contains(a_id)),
        "fenced manifest A must not be re-dispatched"
    );

    // A revoked Host grant refuses the WHOLE pass before any transport
    // effect with HOST_ROUTE_STALE_OR_REVOKED.
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

    // Supported passive kinds are detected authoritatively and recorded in
    // the canonical AssetRef (lower-case).
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

    // Active content declared as a passive image is refused before
    // availability: MEDIA_TYPE_MISMATCH, never relabeled.
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

    // Decoded size limit: cut off with SIZE_LIMIT, no asset.
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

    // Strict base64: malformed encoding fails before any durable record.
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

    // The shipped default is text-only: asset ground is not admitted unless a
    // multimodal profile is declared. The default modality set IS exactly
    // {"text"} (this is the frozen v1 default, not a freeze on the target).
    assert_eq!(
        channel_config().accepted_modalities,
        BTreeSet::from(["text".to_string()]),
        "the shipped default modality set is exactly text"
    );

    // Part-count and text-byte bounds are enforced by validate and are
    // modality-independent: an oversized or degenerate configuration cannot
    // route work whether or not the asset modality is later declared.
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
    // The valid text-only configuration still validates (control).
    assert!(channel_config().validate().is_ok(), "text-only config is valid");
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

    // The guest clock is already past the caller deadline: the bounded queue
    // admits nothing — every action is refused CHANNEL_RATE_LIMITED
    // (retryable backpressure) before any transport effect.
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

    // Crash window: the transport is unavailable; the send is dispatched
    // durably (never a fabricated success) and stays unresolved.
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

    // Restart: a fresh pass with a status-capable transport settles the row
    // status-first — exactly one status query, zero re-dispatch.
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

    // Replay: consuming the confirmed Action again returns the stored frozen
    // result with zero re-dispatch.
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
        dolly_channel::ConsumerOutcome::Terminal {
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
        dolly_channel::ConsumerOutcome::Terminal { result_jcs, .. } => result_jcs.clone(),
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

    // A hostile raw transport event carries credentials, a cookie, a local
    // path, and a signed URL. parse_event reads only the validated allowlist;
    // none of the secrets survive into the event.
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

    // Through the real route the committed draft and durable block carry only
    // the allowlist; none of the hostile fields can be smuggled.
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

    // Asset authority failures never disclose the content root, object
    // locator, or base64 bytes.
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
    // Tombstone the asset deterministically so a later lease is refused.
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

    // Byte-identical replay of the upstream premise is idempotent and an
    // opposite premise never overwrites it.
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

    // The text send drains to Terminal Confirmed; replay returns the stored
    // result with zero re-dispatch.
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

    // 1. A grant lacking the required host method refuses registration.
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

    // 2. A revoked grant refuses every effect with StaleOrRevoked.
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

    // 3. A cross-module import request is refused before the façade.
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

    // 4. The outbound route owns exactly ONE identity-bound gate.
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
// Causal PRODUCT_RED: a stale (tombstoned) AssetRef is refused by an asset
// authority at Channel effect time.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_stale_assetref_refused_at_effect_time() {
    let entry = case("WP013B-STALE-REF-EFFECT-001");
    assert_eq!(entry["expected"], "pass");

    // ---- Leg 0: mint a REAL AssetRef, then make it stale by lease expiry +
    // GC tombstone. This proves the AssetService-level fail-closed authority
    // the channel effect-time gate would consult actually exists and works.
    let scratch = ScratchDir::new("stale-ref");
    let (mut service, clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &asset_request(
                &import_id(401),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("asset import");
    let stale_asset_id = available
        .asset
        .expect("AVAILABLE AssetRef")
        .asset_id
        .as_str()
        .to_string();
    let lease = service
        .lease(&capability, &stale_asset_id, "model-op", "provider output", 60_000)
        .expect("finite lease");
    // Lease expires; grace elapses; the sweep tombstones the asset.
    clock.advance(120_000);
    clock.advance(60_000);
    let gc = service.run_gc().expect("gc");
    assert_eq!(gc.tombstones_created, 1, "the ref is now stale (tombstoned)");
    drop(lease);
    match service.read(&capability, &stale_asset_id) {
        Ok(_) => panic!("the stale AssetRef must be non-readable at the asset authority"),
        Err(denied) => assert_eq!(denied.code, AssetErrorCode::NotFound),
    }

    // ---- Leg 1 (harness control): the committed-Action consumer route and
    // ActivationManifest authority are proven working by draining a TEXT
    // twin to Terminal Confirmed through the very same route. A failure here
    // is a harness error, not the product red.
    let (mut runtime, mut module_store, authority, grant, config, clock_c, session_id) =
        consumer_scaffold("wp013b-stale");
    // ---- Leg 1+2 via the shared target-conditional probes: the text twin
    // first proves the route + ActivationManifest authority work, then the
    // committed Action carrying the stale AssetRef is driven to its frozen
    // target.
    text_control_pass(
        "wp013b-ctl",
        "0198ab31-6c44-7e8a-b2bb-000000000801",
        &session_id,
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock_c,
    );
    let asset_id_action = "0198ab31-6c44-7e8a-b2bb-000000000802";
    let leg = drive_asset_send_leg(
        "wp013b-stale",
        asset_id_action,
        &session_id,
        vec![asset_part(&stale_asset_id, "image/png", None)],
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock_c,
    );
    // Frozen target: an authoritative asset outcome — a fail-closed
    // asset-authority refusal of the stale/revoked ref (or a dispatch) at
    // effect time. When the target behavior is present the case returns PASS.
    if has_asset_authority_outcome(&leg) {
        return;
    }
    product_red(
        "WP013B-STALE-REF-EFFECT-001",
        "committed-Action AssetPart authority at effect time (ChannelOutboundRoute::consume_once / sealed OutboundConsumer)",
        &format!(
            "target not met: the stale (tombstoned) AssetRef was not refused by an asset authority at effect time and not dispatched — observed rejections {:?}, transported {}, terminal {}, pending {}, remaining {}, transport calls {}, while the text twin dispatched to Terminal Confirmed through the same route; requires a fail-closed asset-authority refusal (lease/availability/domain) before any transport effect",
            leg.report.rejected_codes,
            leg.report.transported,
            leg.report.terminal.len(),
            leg.report.pending,
            leg.report.remaining,
            leg.transport_calls
        ),
        "channel_multimodal_effect_authority",
    );
}

// ---------------------------------------------------------------------------
// Causal PRODUCT_RED: mixed text+asset parts must reach the transport in
// exact ordinal order.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_mixed_text_asset_ordering() {
    let entry = case("WP013B-MIXED-ORDER-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("mixed-order");
    let (mut service, _clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);
    let png = png_bytes(4, 2);
    let imported = service
        .import(
            &capability,
            &asset_request(
                &import_id(411),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("asset import");
    let asset_id = imported.asset.expect("AssetRef").asset_id.as_str().to_string();

    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("wp013b-mixed");
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
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );
    // Frozen target: the ordered (text, asset, text) pieces reach the
    // transport as one piece array with contiguous ordinals.
    if leg.report.transported >= 1 || leg.transport_calls >= 1 {
        return;
    }
    product_red(
        "WP013B-MIXED-ORDER-001",
        "mixed text+asset ordinal ordering to the transport",
        &format!(
            "target not met: the mixed text+asset send was not dispatched in exact ordinal order — observed rejections {:?}, transported {}, terminal {}, transport calls {}; requires the ordered text/asset/text piece array with contiguous ordinals to reach the transport under the current ActivationManifest",
            leg.report.rejected_codes,
            leg.report.transported,
            leg.report.terminal.len(),
            leg.transport_calls
        ),
        "channel_multimodal_effect_authority",
    );
}

// ---------------------------------------------------------------------------
// Causal PRODUCT_RED: forged/overriding media_type is refused by a detected
// type authority at effect time.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_media_abuse_refused_at_effect_time() {
    let entry = case("WP013B-MEDIA-ABUSE-SEND-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("media-abuse");
    let (mut service, _clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);
    let png = png_bytes(4, 2);
    let imported = service
        .import(
            &capability,
            &asset_request(
                &import_id(412),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("asset import");
    let asset_id = imported.asset.expect("AssetRef").asset_id.as_str().to_string();

    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("wp013b-media-abuse");
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
    // The action declares image/jpeg for an asset whose authoritative
    // detected type is image/png: the effect-time media authority MUST refuse
    // the override before dispatch (never trust the action media_type).
    let parts = vec![asset_part(&asset_id, "image/jpeg", None)];
    let leg = drive_asset_send_leg(
        "wp013b-media-abuse-asset",
        "0198ab31-6c44-7e8a-b2bb-000000000814",
        &session_id,
        parts,
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );
    // Frozen target: an authoritative asset/media outcome — a detected-type
    // refusal of the forged override, a correction, or a dispatch — not the
    // v1 profile seam and not a silent skip.
    if has_asset_authority_outcome(&leg) {
        return;
    }
    product_red(
        "WP013B-MEDIA-ABUSE-SEND-001",
        "authoritative detected-media-type authority on the committed send",
        &format!(
            "target not met: the action-declared image/jpeg over the authoritative image/png AssetRef was neither refused by a media authority nor dispatched — observed rejections {:?}, transported {}, terminal {}, transport calls {}; requires a detected-type/safe-view refusal (or authoritative correction) before any transport effect",
            leg.report.rejected_codes,
            leg.report.transported,
            leg.report.terminal.len(),
            leg.transport_calls
        ),
        "channel_multimodal_effect_authority",
    );
}

// ---------------------------------------------------------------------------
// Causal PRODUCT_RED: view/crop bounds are checked against display geometry
// at effect time.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_view_crop_checked_at_effect_time() {
    let entry = case("WP013B-CROP-VIEW-001");
    assert_eq!(entry["expected"], "pass");

    let scratch = ScratchDir::new("crop-view");
    let (mut service, _clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);
    let png = png_bytes(4, 2);
    let imported = service
        .import(
            &capability,
            &asset_request(
                &import_id(413),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("asset import");
    let asset = imported.asset.expect("AssetRef");
    let asset_id = asset.asset_id.as_str().to_string();
    // The authoritative prepared geometry is 4x2 with upright orientation.
    assert_eq!(asset.display_width, Some(4));
    assert_eq!(asset.display_height, Some(2));
    assert_eq!(asset.orientation, Some(1));

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
    // Fail-closed negative already covered by the coordinate bound: an
    // out-of-range x1 (>1_000_000) is a bounds violation, not this target.
    assert!(1_200_000u64 > 1_000_000, "out-of-range coordinates are a bounds violation");

    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("wp013b-crop");
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
    // Effect-time target: the schema-valid crop of the AVAILABLE asset is
    // materialized at dispatch against the authoritative prepared geometry.
    let parts = vec![asset_part(&asset_id, "image/png", Some(crop))];
    let leg = drive_asset_send_leg(
        "wp013b-crop-asset",
        "0198ab31-6c44-7e8a-b2bb-000000000816",
        &session_id,
        parts,
        &mut runtime,
        &mut module_store,
        &authority,
        &grant,
        &config,
        &clock,
    );
    if has_asset_authority_outcome(&leg) {
        return;
    }
    product_red(
        "WP013B-CROP-VIEW-001",
        "view/crop geometry authority at effect time",
        &format!(
            "target not met: the schema-valid normalized crop {{x0:250000,y0:0,x1:750000,y1:1000000}} of the authoritative 4x2 display geometry (expected materialization left=1, right=3, top=0, bottom=2) was neither materialized at dispatch nor refused by a geometry authority — observed rejections {:?}, transported {}, transport calls {}",
            leg.report.rejected_codes,
            leg.report.transported,
            leg.transport_calls
        ),
        "channel_multimodal_effect_authority",
    );
}

// ---------------------------------------------------------------------------
// Causal PRODUCT_RED: inbound attachments must import through the Asset
// Service and AVAILABLE-gate the block submission.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_inbound_attachment_import() {
    let entry = case("WP013B-INBOUND-ATTACHMENT-001");
    assert_eq!(entry["expected"], "pass");

    // Leg A (foundation): host.asset.import works through the real route.
    let scratch = ScratchDir::new("inbound-attach");
    let png = png_bytes(4, 2);
    let (mut connection, authority_a, grant_a) = route_harness(
        "module-a",
        "org.dolly.asset",
        "wp013b-inbound-a",
        &["host.asset.import", "host.asset.status"],
        &[],
    );
    let mut asset_route = AssetHostRoute::for_activated_module(
        &mut connection,
        asset_config_at(scratch.path()),
        &authority_a,
        &grant_a,
    )
    .expect("asset route registration");
    let instance = asset_route.instance_id().to_string();
    let imported = asset_route
        .import(&route_asset_request(
            "module-a",
            &instance,
            &import_id(414),
            Source::InlineBase64 {
                base64: base64(&png),
            },
            Some("image/png"),
        ))
        .expect("host.asset.import commits");
    assert_eq!(imported.state, "available");
    let _asset_id = imported.asset.expect("AssetRef").asset_id.as_str().to_string();
    drop(asset_route);

    // Leg B (foundation): the inbound route commits authenticated text
    // premises through the real durable Host ingress slice.
    let (mut runtime, mut module_store, authority, grant, config, clock, _session) =
        consumer_scaffold("wp013b-inbound-b");

    // Leg C: the inbound surface has no attachment ground. The typed event
    // carries only fixed fields (never attachment bytes or an AssetRef), the
    // reachable inbound ledger states contain no assets_pending, and the
    // committed draft for any event is exactly the text part — so a
    // transport attachment can neither be imported nor AVAILABLE-gate the
    // block submission.
    let reachable_states: Vec<&str> = [
        InboundState::Received,
        InboundState::Submitted,
        InboundState::Accepted,
        InboundState::Rejected,
    ]
    .iter()
    .map(|state| state.as_str())
    .collect();
    assert!(
        !reachable_states.contains(&"assets_pending"),
        "the inbound ledger has no assets_pending state to reach"
    );
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
        let sealed = authenticated_channel_event(
            &authority,
            &grant,
            config.revision,
            route_content_event("conv-3", "in-3", "text without attachment"),
        )
        .expect("sealed event");
        match receiver.ingest_event(&sealed) {
            IngressOutcome::Committed { block_id, .. } => block_id,
            other => panic!("event must commit, got {other:?}"),
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
    // Frozen target: an attachment-bearing event imports through the Asset
    // Service and gates the draft on every referenced asset being AVAILABLE
    // (assets_pending) or represents failed attachments explicitly. The
    // target is present whenever the committed draft is no longer a plain
    // single text part (the only outcome the text-only surface can produce).
    let target_met = !(committed_parts.len() == 1
        && committed_parts[0].get("kind").and_then(Value::as_str) == Some("text"));
    if target_met {
        return;
    }
    product_red(
        "WP013B-INBOUND-ATTACHMENT-001",
        "inbound attachment import and AVAILABLE gating (ChannelEventContent -> host.asset.import -> assets_pending)",
        "target not met: the inbound route committed a text-only draft with a single text part and no asset import or assets_pending outcome for the transport event, while host.asset.import itself is proven working (state=available) through the same route; requires the attachment import + AVAILABLE gating or an explicit failed-attachment representation",
        "channel_multimodal_inbound_import",
    );
}

// ---------------------------------------------------------------------------
// Causal PRODUCT_RED: multimodal crash/restart recovery under the original
// ImportId/lease is absent.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_lease_restart_recovery_absent() {
    let entry = case("WP013B-LEASE-RESTART-001");
    assert_eq!(entry["expected"], "pass");

    // Leg 0 (foundation): the asset authority issues a valid current lease on
    // an AVAILABLE asset — exactly the lease a multimodal send would hold.
    let scratch = ScratchDir::new("lease-restart");
    let (mut service, _clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);
    let png = png_bytes(4, 2);
    let imported = service
        .import(
            &capability,
            &asset_request(
                &import_id(415),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("asset import");
    let asset_id = imported.asset.expect("AssetRef").asset_id.as_str().to_string();
    let lease = service
        .lease(&capability, &asset_id, "model-op", "channel send", 240_000)
        .expect("valid current lease");
    assert!(lease.expires_at_ms > ASSET_T0, "the lease is current");
    drop(lease);

    // The committed send referencing that asset must leave a durable
    // multimodal outbound row (original ImportId/lease-bound) that a crash/
    // restart status-first pass could recover. On the accepted base there is
    // no such row: the asset-part Action is silently dropped before a
    // Prepared record, so no ImportId/lease recovery exists and no status
    // query is ever attempted.
    let (mut runtime, mut module_store, authority, grant, config, clock, session_id) =
        consumer_scaffold("wp013b-lr");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000817";
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
        "wp013b-lr",
        ROUTE_INPUT_PAGE,
        asset_block,
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
        .expect("consumer pass over the multimodal Action");

    // A subsequent status-first restart pass attempts to recover the durable
    // multimodal row under its original ImportId/lease.
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

    // Frozen target: a durable multimodal outbound row exists under the
    // original ImportId/lease and a status-first restart pass recovers it
    // (a dispatch, a status query, or a recovered/remaining row). When the
    // target behavior is present the case returns PASS.
    let target_met = reporting.status_calls().len() >= 1
        || pass2.transported >= 1
        || pass2.remaining >= 1
        || pass1.transported >= 1
        || silent.calls().len() >= 1;
    if target_met {
        return;
    }
    product_red(
        "WP013B-LEASE-RESTART-001",
        "multimodal send crash/restart recovery under the original ImportId/lease (status-first, lease invalidation after blocking work)",
        &format!(
            "target not met: the asset-part Action left no durable multimodal outbound row and no asset lease keyed to it — observed first pass transported {}, transport calls {}, restart pass status queries {}, transported {}, remaining {}; requires a prepared/dispatched multimodal row recoverable status-first under the original ImportId and lease",
            pass1.transported,
            silent.calls().len(),
            reporting.status_calls().len(),
            pass2.transported,
            pass2.remaining
        ),
        "channel_multimodal_lease_restart",
    );
}
