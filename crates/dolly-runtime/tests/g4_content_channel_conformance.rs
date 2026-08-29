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
//!   `pass`): the probe drives the integrated `dolly-asset`/`dolly-channel`
//!   public surface directly — `AssetService`/`ImportPipeline`, and the
//!   Channel pipeline (`process_event`/`reconcile_inbound`/`dispatch_send`)
//!   through an in-test `host.ingress.*` adapter backed by the real Core
//!   transaction. Where the crate behavior meets the spec, the case is a real
//!   green acceptance and a regression here is a product violation.
//! - product-red probes (`G4-WP010-*`, `G4-WP013A-*`, expected
//!   `product_red`): each first drives the harness (config install, graph
//!   install, durable Core ingress commit) AND the integrated crate surface
//!   for the seam it names, so every crate contract exercised above is proven
//!   working; only the exact absent Host/runtime adapter seam named in
//!   `causal_red` turns the case red. Remaining REDs are confined to the four
//!   Host/runtime adapter seams: (A) Asset Host — no runtime
//!   `host.asset.import`/`host.asset.status` registration routing an already
//!   Host-authorized Asset capability/import request into `AssetService`
//!   (durable ImportRecord, AVAILABLE canonical AssetRef, authoritative
//!   `absent`); Core ingress never mints or imports asset authority and a
//!   later consumer may only reference the AVAILABLE AssetRef;
//!   (B) Core ingress Host — no `host.ingress.submit`/`host.ingress.status`
//!   adapter backed by the real Core (the only `CoreIngress` impls in the
//!   workspace are test doubles); (C) Channel inbound persistence/wiring —
//!   no runtime backing for the Channel durable ledger; (D) committed-Action
//!   outbound consumer — no runtime consumer that feeds committed blocks
//!   into `dispatch_send`, and no caller-deadline queue in that path. The
//!   message distinguishes compile/API absence from runtime behavior and
//!   never calls a harness failure a PRODUCT_RED.
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
use dolly_storage::SqliteCoreStore;
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
use dolly_channel::config::SessionMappingPolicy;
use dolly_channel::{
    ChannelConfig, ChannelConfigBuilder, ChannelLedger, CoreIngress, CoreIngressError,
    EventKind, IngressCommit, IngressOutcome, IngressStatusResult, IngressSubmitReceipt,
    IngressSubmitRequest, OutboundAdmission, OutboundState, ScriptedTransport,
    SendDispatchResult, TransportPieceOutcome, TransportSendResult, VirtualClock,
    dispatch_send, parse_event, parse_send_action, process_event, reconcile_inbound,
};

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MATRIX: &str = include_str!("fixtures/g4_content_channel_conformance.json");
const TARGET_PAGE: &str = "page-web-primary";
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
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    // 1. Prove the crate surface: bounded inline import reaches AVAILABLE
    //    with a canonical AssetRef, and an over-limit source is cut off.
    let scratch = ScratchDir::new("import-bound");
    let (mut service, _clock) = asset_service_at(scratch.path());
    let capability = asset_capability(&service);
    let png = png_bytes(4, 2);
    let result = service
        .import(
            &capability,
            &asset_request(
                &import_id(601),
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("bounded import must commit at the crate surface");
    assert_eq!(result.state, "available");
    assert!(result.terminal);
    let asset = result.asset.as_ref().expect("AssetRef on AVAILABLE");
    assert_eq!(asset.byte_length, png.len() as u64);
    assert_eq!(
        asset.asset_id,
        AssetId::from_digest(ContentHash::of_bytes(&png).digest)
    );

    // 2. Over-limit source: rejected with SIZE_LIMIT and no asset.
    let mut big = png_bytes(4, 2);
    big.resize(200 * 1024, 0); // exceeds the 64 KiB decoded bound
    let rejected = service
        .import(
            &capability,
            &asset_request(
                &import_id(602),
                Source::InlineBase64 {
                    base64: base64(&big),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("over-limit import is a recorded rejection");
    assert_eq!(rejected.state, "rejected");
    assert!(rejected.asset.is_none());
    assert_eq!(rejected.error.as_ref().expect("envelope")["code"], "SIZE_LIMIT");

    // 3. Crash recovery: a fresh service over the same root resolves the
    //    durable record exactly (crash restart from the durable state).
    let (mut service2, _clock2) = asset_service_at(scratch.path());
    let capability2 = asset_capability(&service2);
    let recovered = service2
        .status(&capability2, &import_id(601))
        .expect("durable import record survives reopen");
    assert_eq!(recovered.state, "available");

    // 4. The Sol-accepted Asset Host absent contract: status for a
    //    never-created ImportId answers an authoritative explicit `absent`
    //    StatusResult — not an error, never minting an AssetRef, carrying
    //    no lifecycle/terminal state, and disclosing nothing beyond the
    //    queried ImportId.
    let never_created = service
        .status(&capability, &import_id(901))
        .expect("status for a never-created import must answer an authoritative absent StatusResult");
    assert_eq!(
        never_created.state, "absent",
        "explicit absent state for a never-created import"
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

    product_red(
        "G4-WP010-IMPORT-BOUND-001",
        seam,
        "the exercised dolly_asset surface implements bounded ACCEPTED->AVAILABLE import, crash recovery, and answers the authoritative explicit absent StatusResult for a never-created import (all proven above); this probe does not drive the runtime Core route, and no runtime host.asset.import/status registration routes an already Host-authorized Asset capability/import request to this service — asset_input is not a Block member and Core ingress never mints or imports asset authority, so a later consumer may only reference the AVAILABLE AssetRef and no host can observe status across the runtime route (Asset Host seam A)",
        "WP-010 Asset Host seam (A)",
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
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    // Integrate the Channel pipeline with the REAL Core transaction through
    // the in-test host.ingress adapter.
    let mut connection = probe_connection("web-channel", "g4-roundtrip");
    let config = channel_config();
    let clock = channel_clock();
    let mut ledger = ChannelLedger::new();

    // 1. Producer leg: an authenticated event becomes a committed durable
    //    premise in real Core; the Channel ledger settles to accepted.
    let (block_id, submit_calls) = {
        let mut core = CoreBackedIngress::new(&mut connection, "web-channel");
        let outcome = process_event(
            &config,
            &clock,
            &mut ledger,
            &mut core,
            &channel_event("account-a", "conv-1", "in-1", "What is the weather?"),
        );
        (
            outcome
                .committed_block_id()
                .expect("inbound event committed")
                .to_string(),
            core.submit_calls,
        )
    };
    assert_eq!(submit_calls, 1);
    let snapshot = {
        let store = SqliteCoreStore::new(&mut connection).expect("core schema");
        store.snapshot().expect("snapshot")
    };
    assert!(
        snapshot.blocks.contains_key(&block_id),
        "the Channel premise is durable in the real Core snapshot"
    );

    // 2. The downstream outbound Action is causally derived from the
    //    committed upstream premise: the session comes from the premise's
    //    session map and the reply text is derived from the premise's
    //    committed text part (read back from real Core, not from the test).
    let premise_text = snapshot.blocks[&block_id]["parts"][0]["text"]
        .as_str()
        .expect("premise text part")
        .to_string();
    let session_id = ledger
        .session("account-a", "conv-1")
        .expect("session mapped")
        .clone();
    let reply = format!("Reply to: {premise_text}");
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000701";
    let send_block = channel_send_block(action_id, &session_id, &[reply.as_str()]);
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-reply-1".to_string()],
    });
    let outbound = channel_dispatch(&config, &mut ledger, &mut transport, &send_block, action_id);
    match outbound {
        SendDispatchResult::Terminal {
            state: OutboundState::Confirmed,
            ..
        } => {}
        other => panic!("expected confirmed outbound, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 1);
    assert_eq!(
        transport.calls()[0].session_id, session_id,
        "the downstream send stays bound to the upstream premise session"
    );
    assert_eq!(
        transport.calls()[0].pieces[0].text, reply,
        "the dispatched reply is causally derived from the committed premise"
    );

    // 3. Transport echo suppression: the confirmed external message ID
    //    re-entering as an inbound event is ignored with zero Core calls, so
    //    an outbound effect can never re-enter as a user premise.
    let echo = {
        let mut core2 = CoreBackedIngress::new(&mut connection, "web-channel");
        let outcome = process_event(
            &config,
            &clock,
            &mut ledger,
            &mut core2,
            &channel_event("account-a", "conv-1", "transport-reply-1", &reply),
        );
        (outcome, core2.submit_calls)
    };
    match echo.0 {
        IngressOutcome::EchoIgnored => {}
        other => panic!("transport echo must be suppressed inbound, got {other:?}"),
    }
    assert_eq!(echo.1, 0, "the echo never reaches Core");

    // 4. Opposite premise: the committed producer key cannot be replaced with
    //    different content — the premise is durable and irreversible.
    let conflict = {
        let mut core3 = CoreBackedIngress::new(&mut connection, "web-channel");
        process_event(
            &config,
            &clock,
            &mut ledger,
            &mut core3,
            &channel_event("account-a", "conv-1", "in-1", "Different question?"),
        )
    };
    match conflict {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_OPERATION_CONFLICT");
        }
        other => panic!("a premise must not be overwritable, got {other:?}"),
    }

    // 5. Cross-Extension leakage: a foreign-owner action is refused by the
    //    Channel before any dispatch.
    let foreign = json!({
        "schema": "dolly.block/v1",
        "id": "0198ab31-6c44-7e8a-b2bb-000000000002",
        "body": {
            "description": "other",
            "parts": [],
            "actions": [{
                "action_id": "0198ab31-6c44-7e8a-b2bb-000000000099",
                "name": "org.dolly.other.something",
                "target": {"module_id": "web-channel"},
                "arguments": {}
            }]
        }
    });
    assert!(
        parse_send_action(&foreign).is_err(),
        "a foreign-owner action must not be consumable by the Channel"
    );

    product_red(
        "G4-WP013A-ROUNDTRIP-001",
        seam,
        "the producer-bound premise, the causally derived downstream send, transport echo suppression, the opposite-premise conflict, and cross-Extension refusal all work over the real Core when a host.ingress adapter supplies identity (proven above), but the shipping runtime ships no host.ingress.submit service — the only CoreIngress impls in the workspace are test doubles — and CoreCommand::Ingress takes a caller-chosen block_id, so no product process can derive a producer-bound ingress or have Block/Ingress identity assigned by the Host (Core ingress Host seam B)",
        "WP-013A Core ingress Host seam (B)",
    );
}

#[test]
fn g4_wp013a_committed_action_consumer_remains_an_absent_runtime_loop() {
    let entry = case("G4-WP013A-CONSUMER-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-consumer");
    let config = channel_config();
    let clock = channel_clock();
    let mut ledger = ChannelLedger::new();

    // 1. A session derived from a real committed upstream premise, so the
    //    downstream dispatch is authorized under the premise's own identity.
    {
        let mut core = CoreBackedIngress::new(&mut connection, "web-channel");
        let outcome = process_event(
            &config,
            &clock,
            &mut ledger,
            &mut core,
            &channel_event("account-a", "conv-1", "in-1", "What is the weather?"),
        );
        assert!(
            outcome.committed_block_id().is_some(),
            "upstream premise committed in real Core"
        );
    }
    let session_id = ledger
        .session("account-a", "conv-1")
        .expect("session mapped")
        .clone();

    // 2. A committed send Action exists durably in the real Core snapshot.
    let action_id = "0198ab31-6c44-7e8a-b2bb-000000000712";
    let send_block = channel_send_block(action_id, &session_id, &["It will be sunny."]);
    let committed = transact_ingress(
        &mut connection,
        "model/web-channel",
        "action-1",
        &canonical_digest(&send_block),
        &format!("{action_id}-block"),
        send_block.clone(),
        vec![TARGET_PAGE.into()],
        "g4-consumer-send",
    );
    assert_eq!(committed.outcome, TransitionOutcome::Committed);
    let committed_block_id = committed
        .reply
        .as_ref()
        .and_then(|reply| reply.get("block_id"))
        .and_then(Value::as_str)
        .expect("committed block id")
        .to_string();
    let snapshot = {
        let store = SqliteCoreStore::new(&mut connection).expect("core schema");
        store.snapshot().expect("snapshot")
    };
    let durable = &snapshot.blocks[&committed_block_id];
    assert_eq!(
        durable["body"]["actions"][0]["name"], "org.dolly.channel.send",
        "the durable committed block carries the targeted channel send Action"
    );

    // 3. The Channel outbound pipeline turns that committed Action into a
    //    confirmed ActionResult — but ONLY because this test extracts the
    //    block and invokes dispatch_send by hand. The shipping runtime has no
    //    consumer loop that does this step.
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["transport-reply-1".to_string()],
    });
    let outcome = channel_dispatch(&config, &mut ledger, &mut transport, &send_block, action_id);
    match outcome {
        SendDispatchResult::Terminal {
            state: OutboundState::Confirmed,
            ..
        } => {}
        other => panic!("expected confirmed outbound, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 1);

    product_red(
        "G4-WP013A-CONSUMER-001",
        seam,
        "the exercised committed org.dolly.channel.send Action sits durable in the real Core snapshot and the dolly_channel outbound pipeline turns it into a confirmed ActionResult, but only because this probe extracts the block and invokes parse_send_action/dispatch_send manually — the shipping runtime has no committed-Action outbound consumer loop that selects targeted Actions from committed Blocks and drives them through the ledger and transport (committed-Action consumer seam D)",
        "WP-013A committed-Action consumer seam (D)",
    );
}

#[test]
fn g4_wp013a_ingress_reconciliation_reads_status_instead_of_resubmitting() {
    let entry = case("G4-WP013A-INGRESS-RECONCILE-001");
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    let mut connection = probe_connection("web-channel", "g4-reconcile");
    let config = channel_config();
    let clock = channel_clock();
    let mut ledger = ChannelLedger::new();
    let mut core = CoreBackedIngress::new(&mut connection, "web-channel");
    // The submit COMMITS durably in real Core, but the response is lost.
    core.commit_then_drop_submits = 1;

    let outcome = process_event(
        &config,
        &clock,
        &mut ledger,
        &mut core,
        &channel_event("account-a", "conv-1", "in-1", "Hello."),
    );
    assert!(
        matches!(outcome, IngressOutcome::SubmissionPending),
        "lost response leaves the row submitted"
    );

    // Reconciliation reads status and settles — with NO resubmission.
    let unresolved = reconcile_inbound(&config, &clock, &mut ledger, &mut core);
    assert_eq!(unresolved, 0, "status read settles the row");
    assert_eq!(core.submit_calls, 1, "no resubmission after a committed state");
    assert_eq!(core.status_calls, 1, "reconciliation used the status read");
    let entry = ledger
        .inbound_entry("account-a", "in-1")
        .expect("ledger row");
    assert_eq!(entry.state, dolly_channel::InboundState::Accepted);
    assert!(entry.block_id.is_some(), "status returned the prior mapping");

    product_red(
        "G4-WP013A-INGRESS-RECONCILE-001",
        seam,
        "dolly_channel::reconcile_inbound fully implements status-first reconciliation against the real Core (proven above: a lost-submit row is settled by a status read with no resubmission), but the runtime ships no host.ingress.status service and no CoreIngress implementation, so a lost-response caller in any running product process cannot read absent|committed and must resubmit (Core ingress Host seam B)",
        "WP-013A Core ingress Host seam (B)",
    );
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
    assert_eq!(entry["expected"], "product_red");
    let seam = entry["seam"].as_str().expect("seam");

    // Prove the crate's bounded admission at the surface: one piece is
    // admitted; a burst past the per-session rate limit is refused as
    // retryable CHANNEL_RATE_LIMITED.
    let config = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .target_pages(&[TARGET_PAGE])
        .max_pieces_per_second_per_session(2)
        .build();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["m1".to_string()],
    });
    let action_id1 = "0198ab31-6c44-7e8a-b2bb-000000000706";
    let block1 = channel_send_block(action_id1, "session-main", &["one"]);
    let admitted = channel_dispatch(&config, &mut ledger, &mut transport, &block1, action_id1);
    assert!(
        matches!(admitted, SendDispatchResult::Terminal { .. }),
        "a one-piece dispatch under the limit succeeds at the crate surface"
    );

    // A three-piece burst on the same session in the same second is refused.
    let action_id2 = "0198ab31-6c44-7e8a-b2bb-000000000707";
    let block2 = channel_send_block(
        action_id2,
        "session-main",
        &["one", "two", "three"],
    );
    let over = channel_dispatch(&config, &mut ledger, &mut transport, &block2, action_id2);
    match over {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_RATE_LIMITED");
            assert!(error.retryable, "rate refusal is retryable, not a failure");
        }
        other => panic!("expected rate-limited rejection, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 1, "the refused burst never reaches the transport");

    product_red(
        "G4-WP013A-BACKPRESSURE-001",
        seam,
        "the exercised dolly_channel admission path rate-limits per session with a token bucket: a one-piece send is admitted and confirmed, while a three-piece burst in the same second is refused as CHANNEL_RATE_LIMITED retryable with no transport call (verified above). That proves the rate bucket, not queuing: there is no bounded outbound QUEUE primitive and no caller-deadline wait/expiry anywhere in the dispatch path, so a burst is REJECTED rather than queued under a caller deadline (committed-Action consumer seam D)",
        "WP-013A committed-Action consumer seam (D)",
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
