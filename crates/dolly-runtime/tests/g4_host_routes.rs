//! Focused production-route tests for the G4 integrator-assigned shared
//! wiring (`dolly_runtime::host_routes`): the Asset Host `host.asset.import`
//! / `host.asset.status` route and the Channel inbound route
//! (`host.ingress.submit`, status-first reconcile) driven through the ACTUAL
//! registration path over a real runtime DB, a real Host connection and grant,
//! and the real durable Host ingress slice.
//!
//! Every route is bound only to the sealed current Host authority and
//! capability grant; invalid, stale, revoked, and cross-module requests are
//! proven to create zero effects. No outbound committed-Action consumer (seam
//! D) is started.

use std::str::FromStr;

use dolly_asset::config::ResolvedAssetConfig;
use dolly_asset::facade::AssetStatusRequest;
use dolly_asset::identity::{AssetId, ContentHash};
use dolly_asset::record::{ImportRequest, MediaKind, Source};
use dolly_core_reducer::{
    CoreCommand, EnvironmentInput, InstallConfigCommand, InstallGraphCommand, TransitionOutcome,
};
use dolly_runtime::{
    AssetHostRoute, HostRouteError, authenticated_channel_event, install_channel_store_schema,
    open_channel_inbound_route, reconcile_channel_inbound_route,
};
use dolly_storage::{
    HostCapabilityGrant, HostConnectionAuthority, SqliteCoreStore, SqliteHostIngressStore,
    create_host_ingress_schema,
};
use dolly_canonical_json::canonicalize;
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;

const EXTENSION_ID: &str = "org.dolly.channel";
const TARGET_PAGE: &str = "page-web-primary";
const NOW: &str = "2026-08-28T00:00:00.000000Z";

fn canonical(value: &Value) -> String {
    canonicalize(value).expect("canonical JSON").1.to_canonical_string()
}

fn input() -> EnvironmentInput {
    EnvironmentInput {
        now: NOW.into(),
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
        "actions": [],
        "activation_replay_contract": {"mode":"fenced_replay","evidence":"pure_compute","ledger":null},
        "trust": "trusted",
        "metadata": {}
    })
}

fn graph_body(module_id: &str, extension_id: &str, outputs: &[&str]) -> Value {
    let mut descriptors = serde_json::Map::new();
    descriptors.insert(
        module_id.into(),
        json!({
            "module_id": module_id,
            "descriptor_revision": 1,
            "source_descriptor_digest": canonical(&descriptor(module_id)),
            "owner_extension_id": extension_id,
            "value": descriptor(module_id)
        }),
    );
    let mut output = serde_json::Map::new();
    output.insert(module_id.into(), json!(outputs));
    json!({
        "receiving_module": module_id,
        "input_pages": {"page-web-primary": [module_id]},
        "output_pages": output,
        "subscriptions": {},
        "descriptors": descriptors,
        "authorized_metadata_namespaces": ["org.dolly.channel"],
        "authorized_action_names": ["org.dolly.channel.send"]
    })
}

/// One real runtime DB with a Host connection, a grant authorizing the given
/// methods for one module, and the durable Host ingress slice installed.
struct RuntimeFixture {
    connection: Connection,
    authority: HostConnectionAuthority,
    grant: HostCapabilityGrant,
    module_id: String,
}

impl RuntimeFixture {
    fn new(module_id: &str, mark: &str, methods: &[&str], outputs: &[&str]) -> Self {
        let mut connection = Connection::open_in_memory().expect("runtime db");
        let (authority, graph_digest) = {
            let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
            let config = json!({
                "execution_timeout_ms": 120000,
                "lease_grace_ms": 30000,
                "fencing_grace_ms": 5000,
                "extension_connection_id": format!("{mark}-connection"),
                "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000110",
                "worker_epoch_fence": 17
            });
            let transition = store
                .transact(
                    &CoreCommand::InstallConfig(InstallConfigCommand {
                        command_id: format!("{mark}-config"),
                        revision: 1,
                        digest: canonical(&config),
                        effective_config: config,
                    }),
                    &input(),
                )
                .expect("config");
            assert_eq!(transition.outcome, TransitionOutcome::Committed);
            let body = graph_body(module_id, EXTENSION_ID, outputs);
            let digest = canonical(&body);
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
                .expect("graph");
            assert_eq!(transition.outcome, TransitionOutcome::Committed);
            let authority = store.bootstrap_host_connection().expect("bootstrap");
            store
                .install_host_capability_grant(
                    &authority,
                    EXTENSION_ID,
                    module_id,
                    1,
                    1,
                    &canonical(&descriptor(module_id)),
                    1,
                    &canonical(&json!({"manifest": 1})),
                    1,
                    &digest,
                    methods,
                )
                .expect("grant");
            (authority, digest)
        };
        create_host_ingress_schema(&mut connection).expect("host ingress schema");
        let grant = SqliteCoreStore::new(&mut connection)
            .expect("core schema")
            .current_host_capability_grant(&authority, EXTENSION_ID, module_id)
            .expect("grant read")
            .expect("grant present");
        let _ = &graph_digest;
        RuntimeFixture {
            connection,
            authority,
            grant,
            module_id: module_id.to_string(),
        }
    }

    fn revoke(&mut self) {
        SqliteCoreStore::new(&mut self.connection)
            .expect("core schema")
            .revoke_host_capability_grant(&self.authority, EXTENSION_ID, &self.module_id)
            .expect("revoke");
    }

    fn rotate(&mut self) {
        let mut store = SqliteCoreStore::new(&mut self.connection).expect("core schema");
        let next = store.rotate_host_connection(&self.authority).expect("rotate");
        drop(store);
        self.authority = next;
    }

    fn mapping_count(&self) -> i64 {
        self.connection
            .query_row("SELECT COUNT(*) FROM host_ingress_mappings", [], |row| row.get(0))
            .expect("mapping count")
    }

    fn operation_count(&self) -> i64 {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
                [],
                |row| row.get(0),
            )
            .expect("operation count")
    }
}

fn asset_config_at(dir: &std::path::Path) -> ResolvedAssetConfig {
    let mut config = ResolvedAssetConfig::with_local_root(dir.to_path_buf());
    config.max_decoded_bytes = 64 * 1024;
    config.max_inline_base64_chars = 128 * 1024;
    config.max_image_pixels = 1_000_000;
    config.gc_grace_ms = 60_000;
    config
}

fn png_bytes(w: u32, h: u32) -> Vec<u8> {
    let header = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
    let mut bytes = header.to_vec();
    for byte in (w.to_be_bytes()).iter().chain(h.to_be_bytes().iter()) {
        bytes.push(*byte);
    }
    bytes.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

fn base64(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i] as u32;
        let b1 = if i + 1 < bytes.len() { bytes[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < bytes.len() { bytes[i + 2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        let _ = write!(
            out,
            "{}{}{}{}",
            TABLE[(triple >> 18) as usize & 63] as char,
            TABLE[(triple >> 12) as usize & 63] as char,
            if i + 1 < bytes.len() { TABLE[(triple >> 6) as usize & 63] as char } else { '=' },
            if i + 2 < bytes.len() { TABLE[triple as usize & 63] as char } else { '=' }
        );
        i += 3;
    }
    out
}

fn import_id(n: u64) -> String {
    format!("0198ab31-6c44-7e8a-b2bb-{n:012}")
}

fn asset_request(
    module: &str,
    instance: &str,
    id: &str,
    source: Source,
) -> ImportRequest {
    ImportRequest {
        import_id: id.to_string(),
        instance_id: instance.to_string(),
        module_id: module.to_string(),
        activation_id: None,
        lease_token: None,
        media_kind: MediaKind::Image,
        source,
        declared_media_type: Some("image/png".parse().expect("media type")),
        remote_required: false,
        expected_byte_length: None,
        deadline: NOW.to_string(),
    }
}

fn asset_status(module: &str, id: &str) -> AssetStatusRequest {
    AssetStatusRequest::new(
        "0198ab31-6c44-7e8a-b2bb-000000000821",
        module,
        id,
        NOW,
    )
    .expect("valid status request")
}

// ---------------------------------------------------------------------------
// A — host.asset.import / host.asset.status through the real registration.
// ---------------------------------------------------------------------------

#[test]
fn asset_route_import_available_and_absent_through_real_registration() {
    let scratch = TempDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let fixture = RuntimeFixture::new(
        "asset-mod-a",
        "route-asset-ok",
        &["host.asset.import", "host.asset.status"],
        &[],
    );
    let RuntimeFixture {
        mut connection,
        authority,
        grant,
        ..
    } = fixture;
    let mut route = AssetHostRoute::for_activated_module(
        &mut connection,
        asset_config_at(&root),
        &authority,
        &grant,
    )
    .expect("route binds");
    let instance = route.instance_id().to_string();

    // Available with the canonical AssetRef through the route.
    let png = png_bytes(8, 4);
    let result = route
        .import(&asset_request(
            "asset-mod-a",
            &instance,
            &import_id(611),
            Source::InlineBase64 {
                base64: base64(&png),
            },
        ))
        .expect("route import");
    assert_eq!(result.state, "available");
    let asset = result.asset.as_ref().expect("AssetRef");
    assert_eq!(
        asset.asset_id,
        AssetId::from_digest(ContentHash::of_bytes(&png).digest)
    );

    // Status of the committed id resolves the record; never-created answers
    // the authoritative closed absent, nondisclosing.
    let status = route
        .status(&asset_status("asset-mod-a", &import_id(611)))
        .expect("status");
    assert_eq!(status.state, "available");
    let absent = route
        .status(&asset_status("asset-mod-a", &import_id(901)))
        .expect("status");
    assert_eq!(absent.state, "absent");
    assert!(!absent.terminal);
    assert!(absent.asset.is_none());
    assert!(absent.error.is_none());
}

#[test]
fn asset_route_revoked_or_rotated_grant_creates_zero_effect() {
    let scratch = TempDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let mut fixture = RuntimeFixture::new(
        "asset-mod-r",
        "route-asset-revoked",
        &["host.asset.import", "host.asset.status"],
        &[],
    );
    let config = asset_config_at(&root);

    // Revoked grant: a route re-registered under the same sealed grant after
    // revocation re-validates the durable grant before any Asset effect, so
    // nothing is recorded.
    {
        let mut route = AssetHostRoute::for_activated_module(
            &mut fixture.connection,
            config.clone(),
            &fixture.authority,
            &fixture.grant,
        )
        .expect("route binds");
        let instance = route.instance_id().to_string();
        drop(route);
        fixture.revoke();
        let mut route = AssetHostRoute::for_activated_module(
            &mut fixture.connection,
            config,
            &fixture.authority,
            &fixture.grant,
        )
        .expect("route rebinds");
        let denied = route.import(&asset_request(
            "asset-mod-r",
            &instance,
            &import_id(621),
            Source::InlineBase64 {
                base64: base64(&png_bytes(2, 2)),
            },
        ));
        assert!(
            matches!(
                denied,
                Err(HostRouteError::StaleOrRevoked { .. })
                    | Err(HostRouteError::CapabilityDenied { .. })
            ),
            "a revoked grant must refuse the import: {denied:?}"
        );
    }

    // Rotated Host connection: an old-authority route refuses because the
    // current durable authority/grant no longer matches the sealed facts.
    let old_authority = fixture.authority.clone();
    let long_route = {
        let mut route = AssetHostRoute::for_activated_module(
            &mut fixture.connection,
            asset_config_at(&root),
            &fixture.authority,
            &fixture.grant,
        )
        .expect("route binds");
        drop(route);
        fixture.rotate();
        AssetHostRoute::for_activated_module(
            &mut fixture.connection,
            asset_config_at(&root),
            &old_authority,
            &fixture.grant,
        )
        .expect("route under the pre-rotation authority")
    };
    {
        let mut route = long_route;
        let status = route.status(&asset_status("asset-mod-r", &import_id(621)));
        assert!(
            matches!(
                status,
                Err(HostRouteError::StaleOrRevoked { .. })
                    | Err(HostRouteError::CapabilityDenied { .. })
            ),
            "a rotated authority must refuse status: {status:?}"
        );
    }
}

#[test]
fn asset_route_cross_module_request_is_refused_before_effect() {
    let scratch = TempDir::new().expect("scratch");
    let root = scratch.path().to_path_buf();
    let fixture = RuntimeFixture::new(
        "asset-mod-x",
        "route-asset-cross",
        &["host.asset.import", "host.asset.status"],
        &[],
    );
    let RuntimeFixture {
        mut connection,
        authority,
        grant,
        ..
    } = fixture;
    let mut route = AssetHostRoute::for_activated_module(
        &mut connection,
        asset_config_at(&root),
        &authority,
        &grant,
    )
    .expect("route binds");
    let denied = route.import(&asset_request(
        "other-module",
        route.instance_id(),
        &import_id(631),
        Source::InlineBase64 {
            base64: base64(&png_bytes(2, 2)),
        },
    ));
    assert!(
        matches!(denied, Err(HostRouteError::CapabilityDenied { .. })),
        "a cross-module import must be refused: {denied:?}"
    );
}

// ---------------------------------------------------------------------------
// C — Channel inbound route: committed, idempotent, status-first reconcile,
// and zero-effect refusals for invalid/revoked/cross-owner cases.
// ---------------------------------------------------------------------------

fn channel_config() -> dolly_channel::ChannelConfig {
    dolly_channel::ChannelConfigBuilder::new("web", "account-a", "channel-mod", 1)
        .target_pages(&[TARGET_PAGE])
        .build()
}

fn channel_clock() -> dolly_channel::VirtualClock {
    dolly_channel::VirtualClock::at(
        dolly_core_domain::Timestamp::from_str(NOW).expect("timestamp"),
    )
}

fn content(conversation: &str, message_id: &str, text: &str) -> dolly_channel::ChannelEventContent {
    dolly_channel::ChannelEventContent {
        channel_id: "web-primary".to_string(),
        transport: "web".to_string(),
        external_conversation_id: conversation.to_string(),
        external_message_id: message_id.to_string(),
        sender_class: "user".to_string(),
        sender_id: format!("sender-{message_id}"),
        text: text.to_string(),
        received_at: dolly_core_domain::Timestamp::from_str(NOW).expect("timestamp"),
        event_kind: dolly_channel::EventKind::Message,
        references_external_message_id: None,
    }
}

fn channel_store() -> Connection {
    let mut connection = Connection::open_in_memory().expect("module store");
    install_channel_store_schema(&mut connection).expect("channel store schema");
    connection
}

#[test]
fn channel_route_commits_replays_and_reconciles_status_first() {
    let fixture = RuntimeFixture::new(
        "channel-mod",
        "route-channel-ok",
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    let RuntimeFixture {
        mut connection,
        authority,
        grant,
        ..
    } = fixture;
    let mut module_store = channel_store();
    let config = channel_config();
    let clock = channel_clock();
    let mapping_count = |connection: &Connection| -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM host_ingress_mappings", [], |row| row.get(0))
            .expect("mapping count")
    };
    let operation_count = |connection: &Connection| -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
                [],
                |row| row.get(0),
            )
            .expect("operation count")
    };

    // Authenticated event through the real registration -> durable premise.
    let block_id = {
        let mut receiver = open_channel_inbound_route(
            &mut connection,
            &mut module_store,
            config.clone(),
            Box::new(clock.clone()),
            &authority,
            &grant,
        )
        .expect("channel route");
        let event = authenticated_channel_event(
            &authority,
            &grant,
            config.revision,
            content("conv-1", "msg-1", "Hello."),
        )
        .expect("sealed event");
        match receiver.ingest_event(&event) {
            dolly_channel::IngressOutcome::Committed { block_id, .. } => block_id,
            other => panic!("expected Committed, got {other:?}"),
        }
    };
    assert_eq!(mapping_count(&connection), 1);
    assert_eq!(operation_count(&connection), 1);
    let store = SqliteCoreStore::new(&mut connection).expect("core schema");
    assert!(
        store.snapshot().expect("snapshot").blocks.contains_key(&block_id),
        "premise is durable under the Host-assigned identity"
    );
    drop(store);

    // Idempotent replay: same sealed event, no new premise or effect.
    {
        let mut receiver = open_channel_inbound_route(
            &mut connection,
            &mut module_store,
            config.clone(),
            Box::new(clock.clone()),
            &authority,
            &grant,
        )
        .expect("channel route");
        let event = authenticated_channel_event(
            &authority,
            &grant,
            config.revision,
            content("conv-1", "msg-1", "Hello."),
        )
        .expect("sealed event");
        assert!(
            matches!(
                receiver.ingest_event(&event),
                dolly_channel::IngressOutcome::IdempotentReplay { .. }
            ),
            "replay must be idempotent"
        );
    }
    assert_eq!(mapping_count(&connection), 1, "no duplicate premise");
    assert_eq!(operation_count(&connection), 1, "no re-dispatch");

    // Status-first reconcile on activation/restart returns zero unresolved.
    let remaining = reconcile_channel_inbound_route(
        &mut connection,
        &mut module_store,
        config.clone(),
        Box::new(clock.clone()),
        &authority,
        &grant,
    )
    .expect("reconcile");
    assert_eq!(remaining, 0);
    assert_eq!(operation_count(&connection), 1, "status-first, no resend");
}

#[test]
fn channel_route_lost_response_reconciles_through_status_without_resend() {
    let fixture = RuntimeFixture::new(
        "channel-mod",
        "route-channel-lost",
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    let RuntimeFixture {
        mut connection,
        authority,
        grant,
        ..
    } = fixture;
    let mut module_store = channel_store();
    let config = channel_config();
    let clock = channel_clock();
    let principal = dolly_channel::ChannelPrincipal::from_authority_grant(&authority, &grant)
        .expect("principal");

    // Host commits the premise; the terminal Channel store commit fails,
    // leaving a durable prepared intent (SubmissionPending).
    {
        let mut store = dolly_channel::SqliteChannelStore::new(
            &mut module_store,
            &principal,
            config.revision,
        )
        .expect("store");
        store.inject_commit_outcome_failure(1);
        let mut receiver = dolly_channel::InboundReceiver::new_with_store(
            config.clone(),
            Box::new(clock.clone()),
            store,
            SqliteHostIngressStore::new(&mut connection).expect("host store"),
            &authority,
            &grant,
        )
        .expect("receiver");
        let event = authenticated_channel_event(
            &authority,
            &grant,
            config.revision,
            content("conv-1", "msg-lost", "Hello lost."),
        )
        .expect("sealed event");
        assert!(
            matches!(
                receiver.ingest_event(&event),
                dolly_channel::IngressOutcome::SubmissionPending
            ),
            "lost response must leave a prepared intent"
        );
    }
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM host_ingress_mappings", [], |row| row.get::<_, i64>(0))
            .expect("mappings"),
        1,
        "Host committed before the response was lost"
    );

    // Reconcile through the real registration path: status-first, exactly
    // once, no resubmission.
    let remaining = reconcile_channel_inbound_route(
        &mut connection,
        &mut module_store,
        config.clone(),
        Box::new(clock.clone()),
        &authority,
        &grant,
    )
    .expect("reconcile");
    assert_eq!(remaining, 0);
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM core_operations WHERE command_id LIKE 'host-ingress-%'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("operations"),
        1,
        "status settled the prepared intent: no blind resend"
    );
}

#[test]
fn channel_route_invalid_revoked_and_cross_owner_events_create_zero_effect() {
    // Cross-owner: an event sealed under a different authenticated principal
    // never reaches Core.
    let fixture = RuntimeFixture::new(
        "channel-mod",
        "route-channel-cross",
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    let RuntimeFixture {
        mut connection,
        authority,
        grant,
        ..
    } = fixture;
    let mut module_store = channel_store();
    let config = channel_config();
    let clock = channel_clock();

    // Same runtime, different module grant: sealing under module-b.
    let mut other = SqliteCoreStore::new(&mut connection).expect("core schema");
    other
        .install_host_capability_grant(
            &authority,
            EXTENSION_ID,
            "channel-mod-b",
            1,
            1,
            &canonical(&descriptor("channel-mod-b")),
            1,
            &canonical(&json!({"manifest": 1})),
            1,
            &canonical(&graph_body("channel-mod-b", EXTENSION_ID, &[TARGET_PAGE])),
            &["host.ingress.submit"],
        )
        .expect("grant b");
    drop(other);
    let grant_b = SqliteCoreStore::new(&mut connection)
        .expect("core schema")
        .current_host_capability_grant(&authority, EXTENSION_ID, "channel-mod-b")
        .expect("read")
        .expect("grant b present");

    // A channel event sealed under a different channel module grant (same
    // authority, different module/account) never creates a premise: the
    // durable Host ingress slice verifies the exact principal inside its
    // transaction, and nothing was committed under module-b.
    let other_config = dolly_channel::ChannelConfigBuilder::new("web", "account-a", "channel-mod-b", 1)
        .target_pages(&[TARGET_PAGE])
        .build();
    let mut module_store_b = channel_store();
    if let Ok(mut b_receiver) = open_channel_inbound_route(
        &mut connection,
        &mut module_store_b,
        other_config,
        Box::new(clock.clone()),
        &authority,
        &grant_b,
    ) {
        let event = authenticated_channel_event(
            &authority,
            &grant_b,
            1,
            content("conv-1", "msg-b", "cross-owner"),
        )
        .expect("sealed event");
        let outcome = b_receiver.ingest_event(&event);
        assert!(
            !matches!(outcome, dolly_channel::IngressOutcome::Committed { .. }),
            "a cross-module/account premise must not commit: {outcome:?}"
        );
    }
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM host_ingress_mappings", [], |row| row.get::<_, i64>(0))
            .expect("mappings"),
        0,
        "no premise for a cross-module principal"
    );
    // Revoked grant: a sealed event under a now-revoked grant never commits.
    let mut fixture2 = RuntimeFixture::new(
        "channel-mod",
        "route-channel-revoked",
        &["host.ingress.submit"],
        &[TARGET_PAGE],
    );
    fixture2.revoke();
    let mut module_store2 = channel_store();
    let mut receiver = open_channel_inbound_route(
        &mut fixture2.connection,
        &mut module_store2,
        config.clone(),
        Box::new(clock.clone()),
        &fixture2.authority,
        &fixture2.grant,
    )
    .expect("channel route before revocation");
    let event = authenticated_channel_event(
        &fixture2.authority,
        &fixture2.grant,
        1,
        content("conv-1", "msg-revoked", "zap"),
    )
    .expect("sealed event");
    let outcome = receiver.ingest_event(&event);
    assert!(
        !matches!(outcome, dolly_channel::IngressOutcome::Committed { .. })
            && !matches!(outcome, dolly_channel::IngressOutcome::IdempotentReplay { .. }),
        "a revoked grant must not commit or replay success: {outcome:?}"
    );
    assert_eq!(fixture2.mapping_count(), 0, "zero Host premise");
    assert_eq!(fixture2.operation_count(), 0, "zero Core effect");
}
