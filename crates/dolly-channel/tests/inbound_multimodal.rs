//! WP-013B inbound multimodal: typed provider attachments -> injected Asset
//! import seam -> durable `assets_pending` -> status-first recovery, with the
//! Block draft submitted ONLY when every required asset is AVAILABLE, in
//! exact attachment order, with canonical identity and explicit refusals.
//! Runs over the real durable Host ingress slice / Core transaction and a
//! real module-scoped SQLite store (deterministic clock/seam/failpoints).
#![cfg(feature = "test-support")]

mod common;

use std::path::Path;
use std::sync::{Arc, Mutex};

use common::g4::*;
use dolly_channel::{
    AttachmentImportRequest, AttachmentImportStatus, AttachmentState,
    AuthenticatedChannelEvent, AvailableAttachment, ChannelPrincipal, InboundAssetImport,
    InboundAttachment, InboundReceiver, IngressOutcome, SqliteChannelStore,
    create_channel_store_schema,
};
use dolly_storage::SqliteHostIngressStore;
use rusqlite::Connection;
use serde_json::Value;
use tempfile::tempdir;

/// Deterministic injected inbound Asset import seam: `import` consumes a
/// script in call order; `status` looks results up per provider key. Records
/// every request so tests assert premise direction (explicit import requests
/// only, no path/caller authority).
#[derive(Clone, Default)]
struct ScriptedAssetImport {
    import_script: Vec<AttachmentImportStatus>,
    status_script: Vec<(String, AttachmentImportStatus)>,
    imports: Arc<Mutex<Vec<AttachmentImportRequest>>>,
    statuses: Arc<Mutex<Vec<AttachmentImportRequest>>>,
}

impl ScriptedAssetImport {
    fn pending() -> Self {
        Self {
            import_script: vec![AttachmentImportStatus::Pending],
            ..Self::default()
        }
    }
    fn all_available(ids: &[&str]) -> Self {
        Self {
            import_script: ids
                .iter()
                .map(|id| available("image/png", id))
                .collect(),
            ..Self::default()
        }
    }
    fn refused(code: &str) -> Self {
        Self {
            import_script: vec![AttachmentImportStatus::Refused {
                code: code.to_string(),
            }],
            ..Self::default()
        }
    }
    fn with_status(&mut self, provider_key: &str, status: AttachmentImportStatus) -> &mut Self {
        self.status_script
            .push((provider_key.to_string(), status));
        self
    }
    fn imports(&self) -> Vec<AttachmentImportRequest> {
        self.imports
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }
}

fn available(media_type: &str, asset_id: &str) -> AttachmentImportStatus {
    AttachmentImportStatus::Available(AvailableAttachment {
        asset_id: asset_id.to_string(),
        media_type: media_type.to_string(),
        view: None,
        byte_length: 1000,
        content_digest: format!("sha256:{}", "0".repeat(64)),
    })
}

impl InboundAssetImport for ScriptedAssetImport {
    fn import(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, dolly_channel::ChannelError> {
        self.imports
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .push(request.clone());
        if self.import_script.is_empty() {
            return Err(dolly_channel::ChannelError::new(
                dolly_channel::error::codes::INTERNAL,
                false,
                dolly_channel::ChannelOutcome::NotApplied,
                "no scripted import result",
            ));
        }
        Ok(self.import_script.remove(0))
    }

    fn status(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, dolly_channel::ChannelError> {
        self.statuses
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .push(request.clone());
        let pos = self
            .status_script
            .iter()
            .position(|(key, _)| key == &request.provider_key);
        match pos {
            Some(idx) => Ok(self.status_script.remove(idx).1),
            None => Err(dolly_channel::ChannelError::new(
                dolly_channel::error::codes::INTERNAL,
                false,
                dolly_channel::ChannelOutcome::NotApplied,
                "no scripted status for provider key",
            )),
        }
    }
}


/// The WP-013B multimodal channel config (text + asset accepted) used by the
/// receiver and the manifest effective_config.
fn multimodal_channel_config() -> dolly_channel::ChannelConfig {
    dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1)
        .accepted_modalities(&["text", "asset"])
        .target_pages(&["page-a"])
        .build()
}

fn channel_store_connection(dir: &Path) -> (Connection, std::path::PathBuf) {
    let path = dir.join("channel-store.sqlite3");
    let mut connection = Connection::open(&path).unwrap();
    create_channel_store_schema(&mut connection).unwrap();
    (connection, path)
}

fn principal_of(harness: &RuntimeHarness) -> ChannelPrincipal {
    ChannelPrincipal::from_authority_grant(&harness.authority, &harness.grant).unwrap()
}

fn attachment(ordinal: u32, provider_key: &str, media_type: &str) -> InboundAttachment {
    InboundAttachment {
        ordinal,
        provider_key: provider_key.to_string(),
        declared_media_type: media_type.to_string(),
        byte_length_hint: 1000,
    }
}

fn sealed_attachments(
    authority: &dolly_storage::HostConnectionAuthority,
    grant: &dolly_storage::HostCapabilityGrant,
    conversation: &str,
    message_id: &str,
    text: &str,
    attachments: Vec<InboundAttachment>,
) -> AuthenticatedChannelEvent {
    AuthenticatedChannelEvent::new_with_attachments(
        authority,
        grant,
        1,
        content_event(conversation, message_id, text),
        attachments,
    )
    .unwrap()
}

/// The committed Block body parts for the given message, from the real Core
/// snapshot (the authoritative emitted draft).
fn committed_parts(harness: &mut RuntimeHarness, message_id: &str) -> Vec<Value> {
    let snapshot = harness.core_store().snapshot().unwrap();
    snapshot
        .blocks
        .values()
        .find(|block| {
            block
                .get("metadata")
                .and_then(|m| m.get("org.dolly.channel"))
                .and_then(|c| c.get("external_message_id"))
                .and_then(Value::as_str)
                == Some(message_id)
        })
        .and_then(|block| block.get("parts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[test]
fn attachments_submit_only_when_all_available_with_exact_order() {
    let mut harness = RuntimeHarness::new("multi-commit");
    let dir = tempdir().unwrap();
    let (mut conn, _path) = channel_store_connection(dir.path());
    let principal = principal_of(&harness);
    let assets = ScriptedAssetImport::all_available(&[
        "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "ast_b3_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbq",
    ]);
    let event = sealed_attachments(
        &harness.authority,
        &harness.grant,
        "conv-1",
        "msg-ma",
        "Look:",
        vec![
            attachment(0, "pk-a", "image/png"),
            attachment(1, "pk-b", "image/png"),
        ],
    );
    {
        let store = SqliteChannelStore::new(&mut conn, &principal, 1).unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(assets.clone()),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let outcome = receiver.ingest_event(&event);
        match &outcome {
            IngressOutcome::Committed { .. } => {}
            other => panic!("expected Committed, got {other:?}"),
        }
        drop(receiver);
    }
    // The seam received exactly the two ordered explicit import requests
    // (premise direction: provider attachment -> import request, never a raw
    // path or a Channel-minted AssetRef).
    let imports = assets.imports();
    assert_eq!(imports.len(), 2);
    assert_eq!(imports[0].provider_key, "pk-a");
    assert_eq!(imports[0].attachment_key.contains("msg-ma"), true);
    assert_eq!(imports[1].provider_key, "pk-b");
    assert_eq!(harness.operation_count(), 1, "one Core effect");
    // The committed Block draft carried exactly [text, asset(0), asset(1)] in
    // attachment order with canonical identity.
    let parts = committed_parts(&mut harness, "msg-ma");
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0]["kind"], "text");
    assert_eq!(parts[1]["kind"], "asset");
    assert_eq!(
        parts[1]["asset_id"],
        "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert_eq!(parts[1]["media_type"], "image/png");
    assert_eq!(parts[2]["kind"], "asset");
    assert_eq!(
        parts[2]["asset_id"],
        "ast_b3_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbq"
    );
}

#[test]
fn pending_attachment_waits_durably_then_restart_resumes_and_replays() {
    let mut harness = RuntimeHarness::new("multi-pending-restart");
    let dir = tempdir().unwrap();
    let (mut conn, path) = channel_store_connection(dir.path());
    let principal = principal_of(&harness);
    let event = sealed_attachments(
        &harness.authority,
        &harness.grant,
        "conv-1",
        "msg-pa",
        "Wait:",
        vec![attachment(0, "pk-a", "image/png")],
    );

    // Phase A: the import is Pending -> submission is withheld, nothing
    // reaches Core, and the durable intent carries the attachment records.
    {
        let store = SqliteChannelStore::new(&mut conn, &principal, 1).unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(ScriptedAssetImport::pending()),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let outcome = receiver.ingest_event(&event);
        assert!(
            matches!(outcome, IngressOutcome::SubmissionPending),
            "pending import must not submit: {outcome:?}"
        );
        drop(receiver);
        let mut store = SqliteChannelStore::new(&mut conn, &principal, 1).unwrap();
        let pending = store.list_pending().unwrap();
        assert_eq!(pending.len(), 1, "durable crash anchor");
        assert_eq!(pending[0].attachments.len(), 1);
        assert_eq!(pending[0].attachments[0].state, AttachmentState::Pending);
        drop(store);
    }
    assert_eq!(harness.operation_count(), 0, "zero Core effect while pending");

    // Phase B: restart. The same prepared intent resumes status-first; once
    // the asset is AVAILABLE the final Asset-bearing draft commits exactly
    // once.
    {
        let mut conn2 = Connection::open(&path).unwrap();
        let store = SqliteChannelStore::new(&mut conn2, &principal, 1).unwrap();
        let mut seam = ScriptedAssetImport::default();
        seam.with_status(
            "pk-a",
            available("image/png", "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        );
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(seam),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let remaining = receiver.reconcile().unwrap();
        assert_eq!(remaining, 0, "recovery resolved the pending import");
        assert_eq!(
            receiver.ledger().unwrap().inbound.len(),
            1,
            "projected accepted row"
        );
        drop(receiver);
        let mut store = SqliteChannelStore::new(&mut conn2, &principal, 1).unwrap();
        assert_eq!(store.list_pending().unwrap().len(), 0, "no indefinite pending");
        let account = account(&harness.authority, &harness.grant);
        let intent = store
            .find_intent(&dolly_channel::ids::inbound_ingress_key(&account, "msg-pa"))
            .unwrap()
            .unwrap();
        assert_eq!(intent.state, dolly_channel::IntentState::Accepted);
        assert!(intent.block_id.is_some());
        drop(store);
    }
    assert_eq!(harness.operation_count(), 1, "one Core effect after recovery");
    let parts = committed_parts(&mut harness, "msg-pa");
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[1]["kind"], "asset");
    assert_eq!(
        parts[1]["asset_id"],
        "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );

    // Phase C: byte-identical redelivery is an idempotent replay with zero
    // new Core effect (the seam re-discovers the same durable premise
    // deterministically and never duplicates the Block).
    {
        let mut conn3 = Connection::open(&path).unwrap();
        let store = SqliteChannelStore::new(&mut conn3, &principal, 1).unwrap();
        let seam = ScriptedAssetImport::all_available(&[
            "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ]);
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(seam.clone()),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let outcome = receiver.ingest_event(&event);
        assert!(
            matches!(outcome, IngressOutcome::IdempotentReplay { .. }),
            "redelivery replays: {outcome:?}"
        );
        drop(receiver);
        let imports = seam.imports();
        assert_eq!(imports.len(), 1, "idempotent re-import on replay");
        assert_eq!(imports[0].provider_key, "pk-a");
    }
    assert_eq!(harness.operation_count(), 1, "no duplicate Core effect");
}

#[test]
fn partial_import_waits_then_completes_in_attachment_order() {
    let mut harness = RuntimeHarness::new("multi-partial");
    let dir = tempdir().unwrap();
    let (mut conn, path) = channel_store_connection(dir.path());
    let principal = principal_of(&harness);
    let event = sealed_attachments(
        &harness.authority,
        &harness.grant,
        "conv-1",
        "msg-x",
        "Partial:",
        vec![
            attachment(0, "pk-a", "image/png"),
            attachment(1, "pk-b", "image/png"),
        ],
    );

    // First attachment is AVAILABLE immediately, the second is Pending.
    let mut seam = ScriptedAssetImport::default();
    seam.import_script = vec![
        available("image/png", "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        AttachmentImportStatus::Pending,
    ];
    {
        let store = SqliteChannelStore::new(&mut conn, &principal, 1).unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(seam),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        assert!(matches!(
            receiver.ingest_event(&event),
            IngressOutcome::SubmissionPending
        ));
        drop(receiver);
    }
    assert_eq!(harness.operation_count(), 0);
    // Restart: the second attachment becomes AVAILABLE; both parts must be
    // present in attachment order in the committed draft.
    {
        let mut conn2 = Connection::open(&path).unwrap();
        let store = SqliteChannelStore::new(&mut conn2, &principal, 1).unwrap();
        let mut seam = ScriptedAssetImport::default();
        seam.status_script = vec![(
            "pk-b".to_string(),
            available("image/png", "ast_b3_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbq"),
        )];
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(seam),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        assert_eq!(receiver.reconcile().unwrap(), 0);
        drop(receiver);
    }
    assert_eq!(harness.operation_count(), 1);
    let parts = committed_parts(&mut harness, "msg-x");
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[1]["asset_id"], "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert_eq!(parts[2]["asset_id"], "ast_b3_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbq");
}

#[test]
fn refused_attachment_rejects_before_mutation() {
    let mut harness = RuntimeHarness::new("multi-refuse");
    let dir = tempdir().unwrap();
    let (mut conn, _path) = channel_store_connection(dir.path());
    let principal = principal_of(&harness);
    let event = sealed_attachments(
        &harness.authority,
        &harness.grant,
        "conv-1",
        "msg-r",
        "No:",
        vec![attachment(0, "pk-r", "image/png")],
    );
    let store = SqliteChannelStore::new(&mut conn, &principal, 1).unwrap();
    let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
    let mut receiver = InboundReceiver::with_asset_import_on_store(
        multimodal_channel_config(),
        Box::new(channel_clock()),
        store,
        inner,
        Box::new(ScriptedAssetImport::refused("CHANNEL_ASSET_IMPORT_FAILED")),
        &harness.authority,
        &harness.grant,
    )
    .unwrap();
    let outcome = receiver.ingest_event(&event);
    match outcome {
        IngressOutcome::RejectedBeforeMutation { error } => {
            assert_eq!(error.code, "CHANNEL_ASSET_IMPORT_FAILED");
        }
        other => panic!("expected RejectedBeforeMutation, got {other:?}"),
    }
    drop(receiver);
    assert_eq!(harness.operation_count(), 0, "zero Core effect");
}

#[test]
fn refusal_during_recovery_is_durable_rejection_with_no_resubmit() {
    let mut harness = RuntimeHarness::new("multi-refuse-recover");
    let dir = tempdir().unwrap();
    let (mut conn, path) = channel_store_connection(dir.path());
    let principal = principal_of(&harness);
    let event = sealed_attachments(
        &harness.authority,
        &harness.grant,
        "conv-1",
        "msg-rr",
        "No:",
        vec![attachment(0, "pk-rr", "image/png")],
    );
    {
        let store = SqliteChannelStore::new(&mut conn, &principal, 1).unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(ScriptedAssetImport::pending()),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        assert!(matches!(
            receiver.ingest_event(&event),
            IngressOutcome::SubmissionPending
        ));
        drop(receiver);
    }
    {
        let mut conn2 = Connection::open(&path).unwrap();
        let store = SqliteChannelStore::new(&mut conn2, &principal, 1).unwrap();
        let mut seam = ScriptedAssetImport::default();
        seam.status_script = vec![(
            "pk-rr".to_string(),
            AttachmentImportStatus::Refused {
                code: "CHANNEL_ASSET_IMPORT_FAILED".to_string(),
            },
        )];
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(seam),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        assert_eq!(receiver.reconcile().unwrap(), 0, "refusal resolves the row");
        drop(receiver);
        let mut store = SqliteChannelStore::new(&mut conn2, &principal, 1).unwrap();
        assert_eq!(store.list_pending().unwrap().len(), 0, "nothing remains pending");
        let account = account(&harness.authority, &harness.grant);
        let rejected = store
            .find_intent(&dolly_channel::ids::inbound_ingress_key(&account, "msg-rr"))
            .unwrap()
            .expect("durable rejection");
        assert_eq!(rejected.state, dolly_channel::IntentState::Rejected);
        assert_eq!(
            rejected.rejected_code.as_deref(),
            Some("CHANNEL_ASSET_IMPORT_FAILED")
        );
    }
    assert_eq!(harness.operation_count(), 0, "zero Core effect and no resubmit");
}

#[test]
fn forged_media_type_on_recovery_is_explicit_rejection() {
    let mut harness = RuntimeHarness::new("multi-forged");
    let dir = tempdir().unwrap();
    let (mut conn, path) = channel_store_connection(dir.path());
    let principal = principal_of(&harness);
    let event = sealed_attachments(
        &harness.authority,
        &harness.grant,
        "conv-1",
        "msg-fg",
        "No:",
        vec![attachment(0, "pk-fg", "image/png")],
    );
    {
        let store = SqliteChannelStore::new(&mut conn, &principal, 1).unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(ScriptedAssetImport::pending()),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        assert!(matches!(
            receiver.ingest_event(&event),
            IngressOutcome::SubmissionPending
        ));
        drop(receiver);
    }
    {
        let mut conn2 = Connection::open(&path).unwrap();
        let store = SqliteChannelStore::new(&mut conn2, &principal, 1).unwrap();
        let mut seam = ScriptedAssetImport::default();
        // The Asset service result relabels active content as jpeg while the
        // event declared png: explicit refusal, never a fabricated reference.
        seam.status_script = vec![(
            "pk-fg".to_string(),
            available("image/jpeg", "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        )];
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(seam),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        assert_eq!(receiver.reconcile().unwrap(), 0);
        drop(receiver);
        let mut store = SqliteChannelStore::new(&mut conn2, &principal, 1).unwrap();
        let account = account(&harness.authority, &harness.grant);
        let rejected = store
            .find_intent(&dolly_channel::ids::inbound_ingress_key(&account, "msg-fg"))
            .unwrap()
            .expect("durable forged rejection");
        assert_eq!(rejected.state, dolly_channel::IntentState::Rejected);
        assert_eq!(
            rejected.rejected_code.as_deref(),
            Some("CHANNEL_MALFORMED_EVENT")
        );
    }
    assert_eq!(harness.operation_count(), 0);
}

#[test]
fn attachment_abuse_bounds_and_modality_gate_fail_closed() {
    let mut harness = RuntimeHarness::new("multi-abuse");
    let dir = tempdir().unwrap();
    let (mut conn, _path) = channel_store_connection(dir.path());
    let principal = principal_of(&harness);

    // Modality gate: the accepted default receiver (no injected seam) refuses
    // attachment events fail-closed before any import or Core effect.
    {
        let store = SqliteChannelStore::new(&mut conn, &principal, 1).unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::new_with_store(
            dolly_channel::ChannelConfigBuilder::new("web", "account-a", MODULE_ID, 1)
                .target_pages(&["page-a"])
                .build(),
            Box::new(channel_clock()),
            store,
            inner,
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let event = sealed_attachments(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-ab0",
            "No:",
            vec![attachment(0, "pk-a", "image/png")],
        );
        let outcome = receiver.ingest_event(&event);
        match outcome {
            IngressOutcome::RejectedBeforeMutation { error } => {
                assert_eq!(error.code, "CHANNEL_UNSUPPORTED_MODALITY");
            }
            other => panic!("expected RejectedBeforeMutation, got {other:?}"),
        }
        drop(receiver);
        assert_eq!(harness.operation_count(), 0);
    }
    // Size-bound abuse: a byte hint beyond the configured media bound is
    // refused by the injected-seam pipeline before any import/Core effect.
    {
        let store = SqliteChannelStore::new(&mut conn, &principal, 1).unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let seam = ScriptedAssetImport::default();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(seam.clone()),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let mut bad = attachment(0, "pk-big", "image/png");
        bad.byte_length_hint = 1_000_000_000;
        let event = sealed_attachments(
            &harness.authority,
            &harness.grant,
            "conv-1",
            "msg-ab1",
            "No:",
            vec![bad],
        );
        let outcome = receiver.ingest_event(&event);
        match outcome {
            IngressOutcome::RejectedBeforeMutation { error } => {
                assert_eq!(error.code, "CHANNEL_MALFORMED_EVENT");
            }
            other => panic!("expected RejectedBeforeMutation, got {other:?}"),
        }
        drop(receiver);
        assert_eq!(
            seam.imports().len(),
            0,
            "the seam is never consulted for an over-bound hint"
        );
        assert_eq!(harness.operation_count(), 0);
    }
}

#[test]
fn text_only_events_are_unchanged_under_the_asset_seam() {
    let mut harness = RuntimeHarness::new("multi-text-only");
    let dir = tempdir().unwrap();
    let (mut conn, _path) = channel_store_connection(dir.path());
    let principal = principal_of(&harness);
    let seam = ScriptedAssetImport::default();
    let event = sealed_event(&harness.authority, &harness.grant, "conv-1", "msg-tx", "Hi");
    {
        let store = SqliteChannelStore::new(&mut conn, &principal, 1).unwrap();
        let inner = SqliteHostIngressStore::new(&mut harness.connection).unwrap();
        let mut receiver = InboundReceiver::with_asset_import_on_store(
            multimodal_channel_config(),
            Box::new(channel_clock()),
            store,
            inner,
            Box::new(seam.clone()),
            &harness.authority,
            &harness.grant,
        )
        .unwrap();
        let outcome = receiver.ingest_event(&event);
        assert!(matches!(outcome, IngressOutcome::Committed { .. }));
        drop(receiver);
    }
    assert_eq!(harness.operation_count(), 1);
    assert_eq!(seam.imports().len(), 0, "text-only never consults the seam");
    let parts = committed_parts(&mut harness, "msg-tx");
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0]["kind"], "text");
    assert_eq!(parts[0]["text"], "Hi");
}
