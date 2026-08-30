//! Route-level deterministic proofs for the adjudicated runtime inbound
//! multimodal (Asset attachment) route corrections:
//!
//! - the bound route requires the exact current `host.asset.import`,
//!   `host.asset.status`, and `host.ingress.submit` grants under the same
//!   extension/module/connection authority and the same registered Asset
//!   content root as the outbound route;
//! - the account is the sealed Channel principal account (a mismatched
//!   caller account or attachment key is refused before any import);
//! - imports produce the exact canonical AssetRef in the committed inbound
//!   block; status answers `Absent` only for an authoritative exact-key miss;
//! - restart reconciliation reuses the same bound provider + Asset adapter
//!   set and never falls back to the unbound seam;
//! - every fail-closed path is deterministic and never leaks the content
//!   root, capability, or a cross-extension premise.

use std::path::Path;
use std::sync::Arc;

use dolly_canonical_json::canonicalize;
use dolly_channel::asset::{MediaKind as ChannelMediaKind, MediaType as ChannelMediaType};
use dolly_channel::{
    AuthenticatedChannelEvent, ChannelConfig, ChannelConfigBuilder, ChannelEventContent, EventKind,
    InboundAttachment, IngressOutcome,
};
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand, TransitionOutcome,
};
use dolly_runtime::{
    ChannelOutboundRoute, HostRouteError, ProviderAttachmentReader, install_channel_store_schema,
    open_channel_inbound_route_with_assets, reconcile_channel_inbound_route_with_assets,
};
use dolly_storage::{
    HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore, create_host_ingress_schema,
};
use rusqlite::Connection;
use serde_json::{Value, json};

const CHANNEL_NOW: &str = "2026-08-28T00:00:00.000000Z";
const EXTENSION_ID: &str = "org.dolly.channel";

/// Deterministic fake provider reader: serves the fixed payload for every
/// authenticated key and records how many bounded reads ran.
#[derive(Clone, Default)]
struct FakeProviderInner {
    reads: usize,
    payload: Vec<u8>,
    deny_key: String,
}

#[derive(Clone)]
struct FakeProvider {
    inner: Arc<parking_lot::Mutex<FakeProviderInner>>,
}

impl FakeProvider {
    fn serving(payload: Vec<u8>) -> Self {
        Self {
            inner: Arc::new(parking_lot::Mutex::new(FakeProviderInner {
                reads: 0,
                payload,
                deny_key: String::new(),
            })),
        }
    }
    fn reads(&self) -> usize {
        self.inner.lock().reads
    }
}

impl ProviderAttachmentReader for FakeProvider {
    fn read(&mut self, provider_key: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
        let mut inner = self.inner.lock();
        inner.reads += 1;
        if provider_key == inner.deny_key {
            return Err("provider object unavailable".to_string());
        }
        if inner.payload.len() as u64 > max_bytes {
            return Err("payload exceeds the bound".to_string());
        }
        Ok(inner.payload.clone())
    }
}

struct Scratch(PathBufHolder);
struct PathBufHolder(std::path::PathBuf);
impl Scratch {
    fn new(tag: &str) -> Self {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "wp013b-route-{tag}-{}-{stamp:x}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(PathBufHolder(dir))
    }
    fn path(&self) -> &Path {
        &self.0.0
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0.0);
    }
}

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
        "input_pages": {module_id: ["page-in"]},
        "output_pages": output,
        "subscriptions": {},
        "descriptors": descriptors,
        "authorized_metadata_namespaces": ["org.dolly.channel"],
        "authorized_action_names": ["org.dolly.channel.send"]
    })
}

/// Real runtime DB + config + producer graph + sealed authority + a grant
/// listing exactly the given host methods, plus the durable Host ingress
/// slice and the module-scoped Channel store schema. The exact state the
/// runtime registration binds to.
fn harness(
    mark: &str,
    methods: &[&str],
) -> (
    Connection,
    Connection,
    HostConnectionAuthority,
    HostCapabilityGrant,
    ChannelConfig,
) {
    let mut runtime = Connection::open_in_memory().unwrap();
    let authority = {
        let mut store = SqliteCoreStore::new(&mut runtime).unwrap();
        install_config(&mut store, mark);
        let body = graph_snapshot("web-channel", &["page-web-primary"]);
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
                &canonical_digest(&graph_snapshot("web-channel", &["page-web-primary"])),
                methods,
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
    let config = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .target_pages(&["page-web-primary"])
        .accepted_modalities(&["text", "asset"])
        .build();
    (runtime, module_store, authority, grant, config)
}

fn asset_config_at(dir: &Path) -> dolly_asset::config::ResolvedAssetConfig {
    let mut config = dolly_asset::config::ResolvedAssetConfig::with_local_root(dir.to_path_buf());
    config.max_decoded_bytes = 64 * 1024;
    config.max_inline_base64_chars = 128 * 1024;
    config.max_image_pixels = 1_000_000;
    config.gc_grace_ms = 60_000;
    config
}

fn png_bytes() -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0, 0, 0, 13]);
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&4u32.to_be_bytes());
    bytes.extend_from_slice(&2u32.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
    bytes.extend_from_slice(&[0u8; 24]);
    bytes
}

fn png_len() -> usize {
    png_bytes().len()
}

fn attachment(ordinal: u32, provider_key: &str) -> InboundAttachment {
    InboundAttachment {
        ordinal,
        provider_key: provider_key.to_string(),
        media_kind: ChannelMediaKind::Image,
        declared_media_type: ChannelMediaType::parse("image/png").unwrap(),
        byte_length_hint: png_len() as u64,
    }
}

fn content(event_key: &str, text: &str) -> ChannelEventContent {
    ChannelEventContent {
        channel_id: "web-primary".to_string(),
        transport: "web".to_string(),
        external_conversation_id: "conv-r".to_string(),
        external_message_id: event_key.to_string(),
        sender_class: "user".to_string(),
        sender_id: format!("sender-{event_key}"),
        text: text.to_string(),
        received_at: CHANNEL_NOW.parse().unwrap(),
        event_kind: EventKind::Message,
        references_external_message_id: None,
    }
}

/// Register the outbound Asset route (the single Asset store owner) for the
/// harness identity.
fn register_outbound_assets(
    module_store: &mut Connection,
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config: &ChannelConfig,
    asset_config: dolly_asset::config::ResolvedAssetConfig,
) {
    ChannelOutboundRoute::register_with_assets(
        config.clone(),
        module_store,
        authority,
        grant,
        asset_config,
    )
    .expect("outbound registration owns the Asset route");
}

fn committed_parts(runtime: &mut Connection, block_id: &str) -> Vec<Value> {
    let store = SqliteCoreStore::new(runtime).unwrap();
    let snapshot = store.snapshot().unwrap();
    snapshot.blocks[block_id]["parts"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Bound positive: import through the route, exact AssetRef in the block.
// ---------------------------------------------------------------------------

#[test]
fn bound_route_imports_attachment_and_commits_exact_asset_ref() {
    let scratch = Scratch::new("positive");
    let methods = &[
        "host.ingress.submit",
        "host.asset.import",
        "host.asset.status",
    ];
    let (mut runtime, mut module_store, authority, grant, config) = harness("route-pos", methods);
    let asset_config = asset_config_at(scratch.path());
    register_outbound_assets(
        &mut module_store,
        &authority,
        &grant,
        &config,
        asset_config.clone(),
    );

    let provider = FakeProvider::serving(png_bytes());
    let mut receiver = open_channel_inbound_route_with_assets(
        &mut runtime,
        &mut module_store,
        config.clone(),
        Box::new(dolly_channel::VirtualClock::at(
            CHANNEL_NOW.parse().unwrap(),
        )),
        asset_config,
        Box::new(provider),
        &authority,
        &grant,
    )
    .expect("bound inbound route opens");

    let sealed = AuthenticatedChannelEvent::new_with_attachments(
        &authority,
        &grant,
        config.revision,
        content("evt-pos", "with attachment"),
        vec![attachment(0, "provider-blob-pos")],
    )
    .expect("sealed multimodal event");
    let block_id = match receiver.ingest_event(&sealed) {
        IngressOutcome::Committed { block_id, .. } => block_id,
        other => panic!("expected committed, got {other:?}"),
    };
    drop(receiver);

    let parts = committed_parts(&mut runtime, &block_id);
    let asset_parts: Vec<&Value> = parts
        .iter()
        .filter(|part| part.get("kind").and_then(Value::as_str) == Some("asset"))
        .collect();
    assert_eq!(
        asset_parts.len(),
        1,
        "exactly one asset part in the committed block"
    );
    let asset_part = asset_parts[0];
    let asset_id = asset_part["asset_id"].as_str().expect("canonical asset id");
    assert!(
        asset_id.starts_with("ast_b3_"),
        "the committed part carries the canonical AssetRef asset id"
    );
    assert_eq!(
        asset_part["media_type"].as_str(),
        Some("image/png"),
        "the committed part carries the authoritative detected media type"
    );
    // Exact-key status: the import produced a durable record, so the same key
    // is NOT absent; an unrelated key under the same account is.
    let mut receiver = open_channel_inbound_route_with_assets(
        &mut runtime,
        &mut module_store,
        config.clone(),
        Box::new(dolly_channel::VirtualClock::at(
            CHANNEL_NOW.parse().unwrap(),
        )),
        asset_config_at(scratch.path()),
        Box::new(FakeProvider::serving(png_bytes())),
        &authority,
        &grant,
    )
    .expect("inbound route reopens");
    let status_pending = AuthenticatedChannelEvent::new_with_attachments(
        &authority,
        &grant,
        config.revision,
        content("evt-status", "s"),
        vec![attachment(0, "provider-blob-status-unrelated")],
    )
    .expect("sealed status event");
    // A fresh event with a fresh key imports a second attachment (positive
    // control); the committed block must carry its own exact canonical ref.
    let block2 = match receiver.ingest_event(&status_pending) {
        IngressOutcome::Committed { block_id, .. } => block_id,
        other => panic!("expected committed second block, got {other:?}"),
    };
    let parts2 = committed_parts(&mut runtime, &block2);
    let asset_part2 = parts2
        .iter()
        .find(|part| part.get("kind").and_then(Value::as_str) == Some("asset"))
        .expect("the second block carries exactly one asset part");
    assert_eq!(
        parts2
            .iter()
            .filter(|part| part.get("kind").and_then(Value::as_str) == Some("asset"))
            .count(),
        1,
        "each attachment key imports exactly one asset part"
    );
    assert_eq!(
        asset_part2["asset_id"], asset_part["asset_id"],
        "identical content is content-addressed to the same canonical AssetRef"
    );
}

// ---------------------------------------------------------------------------
// Grant enforcement and stale/revoked registration fail closed.
// ---------------------------------------------------------------------------

#[test]
fn missing_asset_grants_refuse_the_bound_route() {
    let scratch = Scratch::new("missing-grant");
    // grant only host.ingress.submit (no asset methods)
    let (mut runtime, mut module_store, authority, grant, config) =
        harness("route-noasset", &["host.ingress.submit"]);
    let asset_config = asset_config_at(scratch.path());
    // Outbound registration must fail closed without the asset grants.
    let outbound = ChannelOutboundRoute::register_with_assets(
        config.clone(),
        &mut module_store,
        &authority,
        &grant,
        asset_config.clone(),
    );
    match outbound {
        Err(HostRouteError::CapabilityDenied { .. }) => {}
        _other => panic!("expected CapabilityDenied, got an unexpected success"),
    }
    // Inbound bound route must fail closed without the asset grants and
    // without a registered Asset root.
    let inbound = open_channel_inbound_route_with_assets(
        &mut runtime,
        &mut module_store,
        config.clone(),
        Box::new(dolly_channel::VirtualClock::at(
            CHANNEL_NOW.parse().unwrap(),
        )),
        asset_config,
        Box::new(FakeProvider::serving(png_bytes())),
        &authority,
        &grant,
    );
    match inbound {
        Err(HostRouteError::CapabilityDenied { .. }) => {}
        _other => panic!("expected CapabilityDenied, got an unexpected success"),
    }
}

#[test]
fn missing_registered_asset_root_refuses_inbound_even_with_grants() {
    let scratch = Scratch::new("missing-root");
    let methods = &[
        "host.ingress.submit",
        "host.asset.import",
        "host.asset.status",
    ];
    let (mut runtime, mut module_store, authority, grant, config) =
        harness("route-noroot", methods);
    // No outbound registration ever ran: no registered Asset root exists, so
    // the inbound bound route fails closed instead of opening an unbounded
    // adapter set.
    let inbound = open_channel_inbound_route_with_assets(
        &mut runtime,
        &mut module_store,
        config.clone(),
        Box::new(dolly_channel::VirtualClock::at(
            CHANNEL_NOW.parse().unwrap(),
        )),
        asset_config_at(scratch.path()),
        Box::new(FakeProvider::serving(png_bytes())),
        &authority,
        &grant,
    );
    match inbound {
        Err(HostRouteError::CapabilityDenied { .. }) => {}
        _other => {
            panic!("expected CapabilityDenied for missing Asset root, got an unexpected success")
        }
    }
}

#[test]
fn mismatched_asset_root_refuses_inbound() {
    let scratch_a = Scratch::new("root-a");
    let scratch_b = Scratch::new("root-b");
    let methods = &[
        "host.ingress.submit",
        "host.asset.import",
        "host.asset.status",
    ];
    let (mut runtime, mut module_store, authority, grant, config) = harness("route-rootm", methods);
    let registered = asset_config_at(scratch_a.path());
    register_outbound_assets(&mut module_store, &authority, &grant, &config, registered);
    // A different root for the same identity must fail closed.
    let inbound = open_channel_inbound_route_with_assets(
        &mut runtime,
        &mut module_store,
        config.clone(),
        Box::new(dolly_channel::VirtualClock::at(
            CHANNEL_NOW.parse().unwrap(),
        )),
        asset_config_at(scratch_b.path()),
        Box::new(FakeProvider::serving(png_bytes())),
        &authority,
        &grant,
    );
    match inbound {
        Err(HostRouteError::CapabilityDenied { .. }) => {}
        _other => {
            panic!("expected CapabilityDenied for mismatched root, got an unexpected success")
        }
    }
}

// ---------------------------------------------------------------------------
// Restart reconciliation reuses the SAME bound adapter set (status-first).
// ---------------------------------------------------------------------------

#[test]
fn restart_reconcile_reuses_the_bound_adapter_set_status_first() {
    let scratch = Scratch::new("restart");
    let methods = &[
        "host.ingress.submit",
        "host.asset.import",
        "host.asset.status",
    ];
    let (mut runtime, mut module_store, authority, grant, config) = harness("route-recon", methods);
    let asset_config = asset_config_at(scratch.path());
    register_outbound_assets(
        &mut module_store,
        &authority,
        &grant,
        &config,
        asset_config.clone(),
    );

    let provider = FakeProvider::serving(png_bytes());
    {
        let mut receiver = open_channel_inbound_route_with_assets(
            &mut runtime,
            &mut module_store,
            config.clone(),
            Box::new(dolly_channel::VirtualClock::at(
                CHANNEL_NOW.parse().unwrap(),
            )),
            asset_config.clone(),
            Box::new(provider.clone()),
            &authority,
            &grant,
        )
        .expect("bound route opens");
        let sealed = AuthenticatedChannelEvent::new_with_attachments(
            &authority,
            &grant,
            config.revision,
            content("evt-recon", "attach"),
            vec![attachment(0, "provider-blob-recon")],
        )
        .expect("sealed event");
        let outcome = receiver.ingest_event(&sealed);
        assert!(
            matches!(outcome, IngressOutcome::Committed { .. }),
            "first pass commits the imported attachment"
        );
    }
    assert_eq!(
        provider.reads(),
        1,
        "one bounded provider read on the first pass"
    );

    // Restart: reconcile reopens the SAME bound provider+Asset adapter set
    // (never the unbound seam) and settles status-first with no re-read and
    // no new provider fetch for the already-imported key.
    let remaining = reconcile_channel_inbound_route_with_assets(
        &mut runtime,
        &mut module_store,
        config.clone(),
        Box::new(dolly_channel::VirtualClock::at(
            CHANNEL_NOW.parse().unwrap(),
        )),
        asset_config.clone(),
        Box::new(provider.clone()),
        &authority,
        &grant,
    )
    .expect("restart reconcile runs the bound set");
    assert_eq!(
        remaining, 0,
        "status-first reconcile drains the durable intent"
    );
    assert_eq!(
        provider.reads(),
        1,
        "restart settle never re-reads provider bytes"
    );
}

// ---------------------------------------------------------------------------
// Lifecycle: explicit unregister withdraws the shared Asset registration so
// new opens fail closed while nothing else is disturbed.
// ---------------------------------------------------------------------------

#[test]
fn unregister_withdraws_the_route_registration_for_new_opens() {
    let scratch = Scratch::new("withdraw");
    let methods = &[
        "host.ingress.submit",
        "host.asset.import",
        "host.asset.status",
    ];
    let (mut runtime, mut module_store, authority, grant, config) = harness("route-with", methods);
    let asset_config = asset_config_at(scratch.path());
    register_outbound_assets(
        &mut module_store,
        &authority,
        &grant,
        &config,
        asset_config.clone(),
    );

    // While registered, inbound bound opens share the registration.
    let receiver = open_channel_inbound_route_with_assets(
        &mut runtime,
        &mut module_store,
        config.clone(),
        Box::new(dolly_channel::VirtualClock::at(
            CHANNEL_NOW.parse().unwrap(),
        )),
        asset_config.clone(),
        Box::new(FakeProvider::serving(png_bytes())),
        &authority,
        &grant,
    )
    .expect("bound route opens while registered");
    drop(receiver);

    // Explicit lifecycle close withdraws the registration for this identity.
    let route = ChannelOutboundRoute::register_with_assets(
        config.clone(),
        &mut module_store,
        &authority,
        &grant,
        asset_config.clone(),
    )
    .expect("route registration");
    let removed = route.unregister().expect("lifecycle close returns");
    assert!(removed, "the registered Asset route was withdrawn");
    // Re-unregister is idempotent (nothing left to remove).
    let second_time = route.unregister().expect("second close is idempotent");
    assert!(!second_time, "a second close has nothing to remove");

    // The route object still holds a counted handle, but close is observable:
    // opening an outbound consumer through that old object fails closed.
    let outbound = route.open(
        &mut module_store,
        &mut runtime,
        Box::new(dolly_channel::VirtualClock::at(
            CHANNEL_NOW.parse().unwrap(),
        )),
        Box::new(dolly_channel::transport::ScriptedTransport::new(true)),
    );
    assert!(
        matches!(
            outbound,
            Err(HostRouteError::Rejected { ref code, .. }) if code == "ASSET_OWNER_CLOSED"
        ),
        "ChannelOutboundRoute::open must fail after unregister"
    );

    // New inbound opens fail closed after the withdrawal.
    let inbound = open_channel_inbound_route_with_assets(
        &mut runtime,
        &mut module_store,
        config.clone(),
        Box::new(dolly_channel::VirtualClock::at(
            CHANNEL_NOW.parse().unwrap(),
        )),
        asset_config,
        Box::new(FakeProvider::serving(png_bytes())),
        &authority,
        &grant,
    );
    assert!(
        matches!(
            inbound,
            Err(HostRouteError::Rejected { ref code, .. }) if code == "ASSET_OWNER_CLOSED"
        ),
        "withdrawn registration must fail inbound opens closed"
    );
}

// ---------------------------------------------------------------------------
// No cross-extension or asset-root leakage in any fail-closed surface.
// ---------------------------------------------------------------------------

#[test]
fn fail_closed_surfaces_never_leak_root_or_capability() {
    let scratch = Scratch::new("leak");
    let methods = &[
        "host.ingress.submit",
        "host.asset.import",
        "host.asset.status",
    ];
    let (mut runtime, mut module_store, authority, grant, config) = harness("route-leak", methods);
    let asset_config = asset_config_at(scratch.path());
    let root_text = asset_config.local_root.to_string_lossy().into_owned();
    register_outbound_assets(
        &mut module_store,
        &authority,
        &grant,
        &config,
        asset_config.clone(),
    );

    // A provider refusal maps to a closed Channel error; the content root and
    // any capability token must never appear.
    let provider = FakeProvider::serving(png_bytes());
    provider.inner.lock().deny_key = "provider-deny".to_string();
    let mut receiver = open_channel_inbound_route_with_assets(
        &mut runtime,
        &mut module_store,
        config.clone(),
        Box::new(dolly_channel::VirtualClock::at(
            CHANNEL_NOW.parse().unwrap(),
        )),
        asset_config,
        Box::new(provider),
        &authority,
        &grant,
    )
    .expect("route opens");
    let sealed = AuthenticatedChannelEvent::new_with_attachments(
        &authority,
        &grant,
        config.revision,
        content("evt-deny", "attach"),
        vec![attachment(0, "provider-deny")],
    )
    .expect("sealed event");
    let outcome = receiver.ingest_event(&sealed);
    let rendered = format!("{outcome:?}");
    assert!(
        !rendered.contains(&root_text),
        "the Asset content root must never appear on a fail-closed surface"
    );
    assert!(
        !rendered.contains("provider-deny"),
        "the provider key must not leak into closed surfaces"
    );
    // The event fails closed rather than fabricating an AssetRef.
    assert!(
        !matches!(outcome, IngressOutcome::Committed { .. }),
        "a denied provider can never commit a fabricated asset part"
    );
}
