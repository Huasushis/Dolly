//! Authoritative WP-013B multimodal conformance seed — frozen at base
//! `5edbd46ab4abb488d6c010c2eeb8d7f41e0b9dc3` (the G4 gate is closed: the
//! Asset Host route, the durable Channel inbound route, and the committed
//! targeted-Action outbound route are all wired and green).
//!
//! The matrix fixture is the authoritative document; the executables split
//! into:
//!
//! - `pass` (`WP013B-AVAIL-LEASE-001`): the accepted base already satisfies
//!   the Asset-side contract through the real public route/surface — a
//!   canonical AVAILABLE AssetRef imported under the sealed Host authority,
//!   and a valid current lease/read of that same asset in the same security
//!   domain with deterministic GC and fail-closed tombstone refusal. A
//!   regression here is a product violation.
//! - causal `product_red` (`WP013B-STALE-REF-EFFECT-001`): the frozen
//!   channel-send arguments schema already admits `{"kind":"asset"}` Parts,
//!   but the v1 send authority rejects any asset Part with
//!   `CHANNEL_UNSUPPORTED_MODALITY` and the committed-Action consumer drops
//!   the Action silently, so a committed Action carrying a stale/revoked
//!   (tombstoned) AssetRef is never refused by an asset authority at effect
//!   time — no refusal outcome, no durable outbound row, no transport call.
//!   The probe first proves the entire real causal chain works (a text twin
//!   drains to Terminal Confirmed through the very same route), so the
//!   failure is attributable only to the missing WP-013B AssetPart effect
//!   authority, never to the harness.
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
    AssetHostRoute, ChannelOutboundRoute, authenticated_channel_event,
    install_channel_store_schema, open_channel_inbound_route,
};
use dolly_channel::{
    ChannelConfig, ChannelConfigBuilder, ChannelEventContent, EventKind, IngressOutcome,
    TransportSendResult, VirtualClock,
};

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
    fn calls(&self) -> Vec<dolly_channel::transport::TransportSendRequest> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .calls
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
        _request: &dolly_channel::transport::TransportStatusRequest,
    ) -> dolly_channel::transport::TransportStatusResult {
        dolly_channel::transport::TransportStatusResult::Unknown
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

/// A committed send block whose only Part binds an AssetRef (`asset_id`).
/// The frozen channel-send arguments schema admits this `kind:"asset"` Part;
/// the v1 send authority does not.
fn route_asset_send_block(
    module_id: &str,
    action_id: &str,
    session_id: &str,
    asset_id: &str,
) -> Value {
    let part = json!({
        "kind": "asset",
        "asset_id": asset_id,
        "media_type": "image/png"
    });
    send_action(module_id, action_id, session_id, vec![part])
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

    // The seed freezes exactly one pass and one causal product_red.
    let counts = &document["expected_counts"];
    assert_eq!(counts["pass"], 1);
    assert_eq!(counts["product_red"], 1);

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

    let cases = document["cases"].as_array().expect("cases");
    let mut ids = std::collections::BTreeSet::new();
    let mut pass = 0;
    let mut red = 0;
    for entry in cases {
        let id = entry["id"].as_str().expect("case id");
        assert!(ids.insert(id.to_owned()), "duplicate WP-013B case id {id}");
        assert!(!entry["name"].as_str().expect("case name").is_empty());
        assert!(entry["kind"].as_str().expect("case kind").len() >= 4);
        let expected = entry["expected"].as_str().expect("case expected");
        match expected {
            "pass" => {
                pass += 1;
                assert!(entry["pass_basis"].as_str().expect("pass_basis").len() > 20);
                assert!(
                    entry["assertion"].as_str().expect("assertion").len() > 20
                );
                assert!(
                    entry["references"].as_array().expect("references").len() >= 1,
                    "case {id} must reference the crate surface it drives"
                );
                assert!(
                    entry.get("seam").is_none() && entry.get("causal_red").is_none(),
                    "case {id}: a pass case must not declare a missing seam"
                );
            }
            "product_red" => {
                red += 1;
                assert!(
                    entry.get("blocked").is_none(),
                    "case {id}: an executable WP-013B red must not be blocked in this suite"
                );
                assert!(entry["seam"].as_str().expect("seam").len() > 20);
                assert!(entry["causal_red"].as_str().expect("causal_red").len() > 20);
            }
            other => panic!("case {id}: unexpected expected classification {other}"),
        }
    }
    assert_eq!(pass, 1, "the seed matrix freezes exactly one pass case");
    assert_eq!(red, 1, "the seed matrix freezes exactly one causal product_red");
    assert_eq!(
        case("WP013B-AVAIL-LEASE-001")["expected"],
        "pass",
        "frozen pass case id"
    );
    assert_eq!(
        case("WP013B-STALE-REF-EFFECT-001")["expected"],
        "product_red",
        "frozen product_red case id"
    );

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
        "wp013b_stale_ref_effect_authority",
    ] {
        assert!(
            evidence.contains_key(required),
            "matrix must cover evidence area {required}"
        );
    }
}

// ---------------------------------------------------------------------------
// Pass: canonical AVAILABLE AssetRef with a valid current lease under the
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
    let capability = service.issue_capability(
        domain.clone(),
        asset_route_instance(&authority),
        "module-a",
    );
    let lease = service
        .lease(
            &capability,
            &asset_id,
            "wp013b-send",
            "channel asset part",
            240_000,
        )
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
// Causal PRODUCT_RED: a stale (tombstoned) AssetRef is refused by an asset
// authority at Channel effect time.
// ---------------------------------------------------------------------------

#[test]
fn wp013b_stale_assetref_refused_at_effect_time() {
    let entry = case("WP013B-STALE-REF-EFFECT-001");
    assert_eq!(entry["expected"], "product_red");

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
        .lease(
            &capability,
            &stale_asset_id,
            "model-op",
            "provider output",
            60_000,
        )
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
    let (mut runtime, authority, grant) = route_harness(
        "web-channel",
        "org.dolly.channel",
        "wp013b-stale",
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    let mut module_store = channel_store_connection();
    let config = channel_config();
    let clock_c = channel_clock();
    {
        let mut receiver = open_channel_inbound_route(
            &mut runtime,
            &mut module_store,
            config.clone(),
            Box::new(clock_c.clone()),
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

    let text_id = "0198ab31-6c44-7e8a-b2bb-000000000801";
    let text_block = route_send_block("web-channel", text_id, &session_id, &["control text"]);
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "wp013b-ctl",
        ROUTE_INPUT_PAGE,
        text_block,
        config.clone(),
    );
    let route = ChannelOutboundRoute::register(
        config.clone(),
        &mut module_store,
        &authority,
        &grant,
    )
    .expect("outbound route registration");
    let control_transport = RouteSharedTransport::new(true);
    control_transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-control-1".to_string()],
    });
    let control = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock_c.clone()),
            Box::new(control_transport.clone()),
            &far_deadline_str(),
        )
        .expect("control consumer pass must succeed (harness health)");
    assert_eq!(
        control.transported, 1,
        "harness control: the committed-Action text twin must dispatch"
    );
    assert_eq!(
        control_transport.calls().len(),
        1,
        "harness control: exactly one transport call for the text twin"
    );

    // ---- Leg 2: the committed Action now carries an ASSET Part whose
    // AssetRef is stale (tombstoned). Per the frozen WP-013B contract the
    // consumer MUST refuse it at effect time with a fail-closed asset
    // authority code before any transport effect, durable outbound row, or
    // success envelope.
    let asset_id_action = "0198ab31-6c44-7e8a-b2bb-000000000802";
    let asset_block = route_asset_send_block(
        "web-channel",
        asset_id_action,
        &session_id,
        &stale_asset_id,
    );
    commit_send_and_activate(
        &mut runtime,
        &authority,
        &grant,
        "wp013b-stale",
        ROUTE_INPUT_PAGE,
        asset_block,
        config.clone(),
    );
    let stale_transport = RouteSharedTransport::new(true);
    let pass = route
        .consume_once(
            &mut module_store,
            &mut runtime,
            Box::new(clock_c.clone()),
            Box::new(stale_transport.clone()),
            &far_deadline_str(),
        )
        .expect("consumer pass over the stale AssetRef action");

    // The observed base behavior: the action is silently dropped — no
    // refusal outcome, no durable row, zero transport. Every causal step
    // above actually succeeded (asset authority works in Leg 0, the consumer
    // route works in Leg 1), so this is the missing WP-013B effect-time
    // AssetPart authority, never a harness failure.
    assert_eq!(
        stale_transport.calls().len(),
        0,
        "a stale AssetRef must never reach the transport"
    );
    if pass.rejected == 0 && pass.transported == 0 && pass.terminal.is_empty() {
        product_red(
            "WP013B-STALE-REF-EFFECT-001",
            "committed-Action AssetPart authority at effect time (ChannelOutboundRoute::consume_once / sealed OutboundConsumer)",
            "the frozen channel-send arguments schema admits an asset Part, but authorize_send rejects every asset part with CHANNEL_UNSUPPORTED_MODALITY and CommittedSendAction::from_manifest_input silently drops the committed Action, so the stale (tombstoned) AssetRef is never refused by an asset authority at effect time — no refusal outcome, no durable outbound row, and zero transport calls, while the identical route dispatched a text twin to Terminal Confirmed",
            "channel_multimodal_effect_authority",
        );
    }
    // If the base ever reported a rejection instead, that is a different but
    // still causal product red: the refusal must come from an asset authority
    // (lease/availability/domain), not a generic profile refusal, and the
    // run report records exactly what happened.
    product_red(
        "WP013B-STALE-REF-EFFECT-001",
        "committed-Action AssetPart authority at effect time",
        &format!(
            "the run reported rejections {:?}, transported {}, terminal {}, pending {}, remaining {} instead of refusing the stale AssetRef through an asset authority before dispatch",
            pass.rejected_codes, pass.transported, pass.terminal.len(), pass.pending, pass.remaining
        ),
        "channel_multimodal_effect_authority",
    );
}
