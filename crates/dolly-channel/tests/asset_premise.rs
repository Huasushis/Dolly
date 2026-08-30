//! WP-013B boundary: ordered multimodal asset premises parse ONLY from the
//! committed `org.dolly.channel.send` Action path, in Action part order, and
//! noncanonical, unprepared, over-bound, forged-media, or unsafely-viewed
//! premises are refused before any durable or transport effect. The
//! accepted-modality policy gates asset parts fail-closed; ephemeral payloads
//! reach the transport only at send and are never persisted; the default seam
//! stays v1 text-only.
#![cfg(feature = "test-support")]

mod common;

use common::*;
use dolly_channel::ChannelConfigBuilder;
use dolly_channel::asset::{
    AssetId, AssetPayload, AssetPremise, AssetPreparation, AssetRef, ContentHash, DenyAssetParts,
    MediaKind, MediaType, OutboundAsset,
};
use dolly_channel::{
    ChannelConfig, ChannelLedger, OutboundAdmission, OutboundState, ScriptedTransport,
    SendDispatchResult, TransportSendResult, dispatch_send, parse_send_action,
};
use dolly_schema::CropRect;
use serde_json::json;

/// The WP-013B multimodal profile: text + asset accepted (with the default
/// outbound asset byte bound).
fn multimodal_config() -> ChannelConfig {
    ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .accepted_modalities(&["text", "asset"])
        .build()
}

/// The multimodal profile with a bounded outbound asset size.
fn bounded_asset_config(max_asset_bytes: usize) -> ChannelConfig {
    ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
        .accepted_modalities(&["text", "asset"])
        .max_asset_bytes(max_asset_bytes)
        .build()
}

fn asset_premise_of(
    ordinal: u32,
    asset_id: &str,
    media_type: &str,
    view: Option<CropRect>,
) -> AssetPremise {
    AssetPremise {
        ordinal,
        asset_id: AssetId::parse(asset_id).unwrap(),
        media_type: MediaType::parse(media_type).unwrap(),
        view,
    }
}

/// Deterministic injected Asset preparation seam.
#[derive(Debug, Clone, Default)]
struct TestAssetPreparation {
    refuse_code: Option<String>,
    forge_media_type: Option<String>,
    proof_byte_length: u64,
    proof_orientation: u8,
    payload_byte_length: Option<usize>,
    prepared: Vec<AssetPremise>,
}

impl TestAssetPreparation {
    fn accepting() -> Self {
        Self {
            proof_byte_length: 1000,
            proof_orientation: 1,
            ..Self::default()
        }
    }

    fn refusing(code: &str) -> Self {
        Self {
            refuse_code: Some(code.to_string()),
            ..Self::accepting()
        }
    }

    fn payload(&self, premise: &AssetPremise) -> AssetPayload {
        let media_type = self
            .forge_media_type
            .as_deref()
            .map(MediaType::parse)
            .transpose()
            .unwrap()
            .unwrap_or_else(|| premise.media_type.clone());
        let media_kind = if media_type.as_str().starts_with("image/") {
            MediaKind::Image
        } else if media_type.as_str().starts_with("audio/") {
            MediaKind::Audio
        } else if media_type.as_str().starts_with("video/") {
            MediaKind::Video
        } else {
            MediaKind::File
        };
        let digest: [u8; 32] = (&premise.asset_id).into();
        let byte_length = self.proof_byte_length;
        AssetPayload {
            asset_ref: AssetRef {
                asset_id: premise.asset_id.clone(),
                media_type,
                byte_length,
                orientation: Some(self.proof_orientation),
                encoded_width: Some(1000),
                encoded_height: Some(500),
                display_width: Some(1000),
                display_height: Some(500),
            },
            media_kind,
            generation: 1,
            digest: ContentHash::from_digest(digest),
            lease_id: format!("lease-{}", premise.ordinal),
            lease_expiry_unix_ms: 2_000_000_000_000,
            bytes: vec![0x55; self.payload_byte_length.unwrap_or(byte_length as usize)],
        }
    }
}

impl AssetPreparation for TestAssetPreparation {
    fn prepare_assets(
        &mut self,
        premises: &[AssetPremise],
    ) -> Result<Vec<AssetPayload>, dolly_channel::ChannelError> {
        self.prepared.extend_from_slice(premises);
        if let Some(code) = &self.refuse_code {
            return Err(dolly_channel::ChannelError::new(
                code.clone(),
                false,
                dolly_channel::ChannelOutcome::NotApplied,
                "Asset payload preparation failed under Channel authority",
            ));
        }
        Ok(premises
            .iter()
            .map(|premise| self.payload(premise))
            .collect())
    }
}

fn dispatch(
    config: &dolly_channel::ChannelConfig,
    ledger: &mut ChannelLedger,
    transport: &mut ScriptedTransport,
    block: &serde_json::Value,
    assets: &mut dyn AssetPreparation,
) -> SendDispatchResult {
    let clock = clock();
    let action = parse_send_action(block).expect("block carries a channel send");
    let mut admission = OutboundAdmission::new();
    dispatch_send(
        config,
        &clock,
        ledger,
        transport,
        &mut admission,
        assets,
        &action,
    )
}

fn assert_zero_effect_terminal(
    outcome: SendDispatchResult,
    ledger: &ChannelLedger,
    action_id: &str,
    code: &str,
) {
    match outcome {
        SendDispatchResult::Terminal { state, .. } => {
            assert_eq!(state, OutboundState::Failed);
        }
        other => panic!("expected durable terminal rejection, got {other:?}"),
    }
    let entry = ledger.outbound_entry(action_id).expect("durable rejection");
    assert_eq!(entry.state, OutboundState::Failed);
    assert!(entry.pieces.iter().all(|piece| {
        matches!(
            piece.outcome.as_ref(),
            Some(dolly_channel::ledger::PieceOutcome::Rejected { code: actual })
                if actual == code
        )
    }));
}
/// A committed send Block whose parts array is exactly the given part list.
fn send_block_with_parts(
    action_id: &str,
    session_id: &str,
    parts: serde_json::Value,
) -> serde_json::Value {
    let mut block = send_block(action_id, session_id, &["Hello."]);
    block["body"]["actions"][0]["arguments"]["parts"] = parts.clone();
    block
}

const ASSET_ID_A: &str = "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn asset_part(asset_id: &str, with_view: bool) -> serde_json::Value {
    let mut part = json!({
        "kind": "asset",
        "asset_id": asset_id,
        "media_type": "image/png"
    });
    if with_view {
        part["view"] = json!({
            "kind": "image_rect_v1",
            "x0": 100000,
            "y0": 200000,
            "x1": 600000,
            "y1": 600000
        });
    }
    part
}

#[test]
fn ordered_mixed_text_and_asset_premises_prepare_in_action_order() {
    let config = multimodal_config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: (0..4).map(|i| format!("msg-{i}")).collect(),
    });
    // A second canonical AssetId: 51 base32 `b` chars ending in `q`.
    let asset_b = format!("ast_b3_{}q", "b".repeat(51));
    let parts = serde_json::Value::Array(vec![
        json!({ "kind": "text", "text": "First.", "format": "plain" }),
        asset_part(ASSET_ID_A, true),
        json!({ "kind": "text", "text": "Second.", "format": "plain" }),
        asset_part(&asset_b, false),
    ]);
    let block = send_block_with_parts(
        "0198ab31-6c44-7e8a-b2bb-000000000201",
        "session-main",
        parts,
    );
    let mut assets = TestAssetPreparation::accepting();

    let outcome = dispatch(&config, &mut ledger, &mut transport, &block, &mut assets);
    let state = match outcome {
        SendDispatchResult::Terminal { state, .. } => state,
        other => panic!("expected Terminal confirmed, got {other:?}"),
    };
    assert_eq!(state, OutboundState::Confirmed);

    // The injected seam sees exactly the two asset premises, in Action part
    // order, with canonical identity.
    let crop = CropRect::new(100_000, 200_000, 600_000, 600_000).unwrap();
    assert_eq!(
        assets.prepared,
        vec![
            asset_premise_of(1, ASSET_ID_A, "image/png", Some(crop.clone())),
            asset_premise_of(3, &asset_b, "image/png", None)
        ]
    );

    // Channel delivers one closed ordered composition. The adapter receives
    // exact PreparedMedia payloads and exact materialized views, with no
    // independently optional modality fields.
    let request = &transport.calls()[0];
    assert_eq!(request.pieces.len(), 4);
    match &request.pieces[0] {
        dolly_channel::TransportPiece::Text { ordinal, text } => {
            assert_eq!((*ordinal, text.as_str()), (0, "First."));
        }
        other => panic!("expected closed text variant, got {other:?}"),
    }
    match &request.pieces[1] {
        dolly_channel::TransportPiece::Asset {
            ordinal,
            payload,
            view,
        } => {
            assert_eq!(*ordinal, 1);
            assert_eq!(payload.asset_ref.asset_id.as_str(), ASSET_ID_A);
            assert_eq!(payload.asset_ref.media_type.as_str(), "image/png");
            assert_eq!(payload.lease_id, "lease-1");
            assert_eq!(payload.bytes.len(), 1000);
            let view = view.as_ref().expect("crop materialized by Channel");
            assert_eq!(
                (view.left(), view.top(), view.right(), view.bottom()),
                (100, 100, 600, 300)
            );
        }
        other => panic!("expected closed asset variant, got {other:?}"),
    }
    match &request.pieces[2] {
        dolly_channel::TransportPiece::Text { ordinal, text } => {
            assert_eq!((*ordinal, text.as_str()), (2, "Second."));
        }
        other => panic!("expected closed text variant, got {other:?}"),
    }
    match &request.pieces[3] {
        dolly_channel::TransportPiece::Asset {
            ordinal,
            payload,
            view,
        } => {
            assert_eq!(*ordinal, 3);
            assert_eq!(payload.asset_ref.asset_id.as_str(), asset_b);
            assert_eq!(payload.bytes.len(), 1000);
            assert_eq!(*view, None);
        }
        other => panic!("expected closed asset variant, got {other:?}"),
    }

    // The durable ledger row persists only the premise and proof.
    let entry = ledger
        .outbound_entry("0198ab31-6c44-7e8a-b2bb-000000000201")
        .unwrap();
    assert_eq!(entry.pieces.len(), 4);
    let expected_premise = asset_premise_of(1, ASSET_ID_A, "image/png", Some(crop));
    let expected_proof = TestAssetPreparation::accepting()
        .payload(&expected_premise)
        .lease_proof();
    assert_eq!(
        entry.pieces[1].asset,
        Some(OutboundAsset {
            premise: expected_premise,
            lease_proof: Some(expected_proof),
        })
    );
    let serialized = dolly_channel::ledger_to_json_string(&ledger).unwrap();
    assert!(
        !serialized.contains("\u{55}") && !serialized.contains("payload"),
        "ephemeral payload bytes never reach the durable ledger"
    );
}

#[test]
fn default_deny_seam_refuses_asset_parts_with_zero_effect() {
    let config = multimodal_config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    let block = send_block_with_parts(
        "0198ab31-6c44-7e8a-b2bb-000000000202",
        "session-main",
        json!([asset_part(ASSET_ID_A, false)]),
    );
    let mut assets = DenyAssetParts;

    let outcome = dispatch(&config, &mut ledger, &mut transport, &block, &mut assets);
    assert_zero_effect_terminal(
        outcome,
        &ledger,
        "0198ab31-6c44-7e8a-b2bb-000000000202",
        "CHANNEL_UNSUPPORTED_MODALITY",
    );
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
}

#[test]
fn asset_modality_gate_fails_closed_unless_accepted() {
    let config = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1).build();
    assert_eq!(
        config.accepted_modalities,
        std::collections::BTreeSet::from(["text".to_string()])
    );
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    let block = send_block_with_parts(
        "0198ab31-6c44-7e8a-b2bb-000000000206",
        "session-main",
        json!([asset_part(ASSET_ID_A, false)]),
    );
    let mut assets = TestAssetPreparation::accepting();

    let outcome = dispatch(&config, &mut ledger, &mut transport, &block, &mut assets);
    match outcome {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_UNSUPPORTED_MODALITY");
            assert_eq!(error.outcome, dolly_channel::ChannelOutcome::NotApplied);
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(ledger.outbound.is_empty(), "zero durable outbound mutation");
    assert!(
        assets.prepared.is_empty(),
        "the seam is never consulted when the modality gate refuses"
    );
}

#[test]
fn noncanonical_asset_premise_is_refused_before_any_effect() {
    let config = multimodal_config();
    // A forged/uppercase AssetId (not canonical).
    let mut bad_id = asset_part(ASSET_ID_A, false);
    bad_id["asset_id"] = json!("ast_b3_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    for parts in [
        json!([bad_id]),
        // An uppercase, parameterized media type is not canonical.
        json!([{
            "kind": "asset",
            "asset_id": ASSET_ID_A,
            "media_type": "Image/PNG"
        }]),
        // A crop whose bottom-right corner does not extend past its top-left
        // corner is structurally invalid (the shared CropRect rejects it).
        json!([{
            "kind": "asset",
            "asset_id": ASSET_ID_A,
            "media_type": "image/png",
            "view": { "kind": "image_rect_v1", "x0": 600000, "y0": 600000, "x1": 100000, "y1": 100000 }
        }]),
    ] {
        let mut ledger = ChannelLedger::new();
        ledger.insert_session("account-a", "conv-1", "session-main");
        let mut transport = ScriptedTransport::new(true);
        let block = send_block_with_parts(
            "0198ab31-6c44-7e8a-b2bb-000000000203",
            "session-main",
            parts,
        );
        let mut assets = TestAssetPreparation::accepting();
        let outcome = dispatch(&config, &mut ledger, &mut transport, &block, &mut assets);
        match outcome {
            SendDispatchResult::Rejected(error) => {
                assert_eq!(error.code, "CHANNEL_MALFORMED_EVENT");
            }
            other => panic!("expected Rejected malformed, got {other:?}"),
        }
        assert_eq!(transport.calls().len(), 0, "zero transport effect");
        assert!(ledger.outbound.is_empty(), "zero durable outbound mutation");
        assert!(
            assets.prepared.is_empty(),
            "the seam is never consulted for a noncanonical premise"
        );
    }
}

#[test]
fn unprepared_premise_refused_by_injected_seam_is_a_frozen_rejection_with_zero_effect() {
    let config = multimodal_config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    let block = send_block_with_parts(
        "0198ab31-6c44-7e8a-b2bb-000000000204",
        "session-main",
        json!([
            { "kind": "text", "text": "Hello.", "format": "plain" },
            asset_part(ASSET_ID_A, false)
        ]),
    );
    let mut assets = TestAssetPreparation::refusing("CHANNEL_ASSET_IMPORT_FAILED");

    let outcome = dispatch(&config, &mut ledger, &mut transport, &block, &mut assets);
    assert_zero_effect_terminal(
        outcome,
        &ledger,
        "0198ab31-6c44-7e8a-b2bb-000000000204",
        "CHANNEL_ASSET_IMPORT_FAILED",
    );
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert_eq!(
        assets.prepared,
        vec![asset_premise_of(1, ASSET_ID_A, "image/png", None)]
    );
}

#[test]
fn prepared_asset_over_size_bound_is_refused_before_any_effect() {
    let config = bounded_asset_config(100);
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    let block = send_block_with_parts(
        "0198ab31-6c44-7e8a-b2bb-000000000207",
        "session-main",
        json!([
            { "kind": "text", "text": "Hello.", "format": "plain" },
            asset_part(ASSET_ID_A, false)
        ]),
    );
    let mut assets = TestAssetPreparation::accepting();

    let outcome = dispatch(&config, &mut ledger, &mut transport, &block, &mut assets);
    assert_zero_effect_terminal(
        outcome,
        &ledger,
        "0198ab31-6c44-7e8a-b2bb-000000000207",
        "CHANNEL_MALFORMED_EVENT",
    );
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
}

#[test]
fn forged_authoritative_media_type_is_refused_before_any_effect() {
    let config = multimodal_config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    let block = send_block_with_parts(
        "0198ab31-6c44-7e8a-b2bb-000000000208",
        "session-main",
        json!([asset_part(ASSET_ID_A, false)]),
    );
    let mut assets = TestAssetPreparation::accepting();
    assets.forge_media_type = Some("image/jpeg".to_string());

    let outcome = dispatch(&config, &mut ledger, &mut transport, &block, &mut assets);
    assert_zero_effect_terminal(
        outcome,
        &ledger,
        "0198ab31-6c44-7e8a-b2bb-000000000208",
        "CHANNEL_MALFORMED_EVENT",
    );
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
}

#[test]
fn oversized_ephemeral_payload_is_refused_before_any_effect() {
    // The prepared proof (1000 bytes) passes the 2000-byte bound, but the
    // adapter hands back a 3000-byte payload: refused at the transport
    // boundary with zero transport effect.
    let config = bounded_asset_config(2000);
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    let block = send_block_with_parts(
        "0198ab31-6c44-7e8a-b2bb-000000000209",
        "session-main",
        json!([
            { "kind": "text", "text": "Hello.", "format": "plain" },
            asset_part(ASSET_ID_A, false)
        ]),
    );
    let mut assets = TestAssetPreparation::accepting();
    assets.payload_byte_length = Some(3000);

    let outcome = dispatch(&config, &mut ledger, &mut transport, &block, &mut assets);
    assert_zero_effect_terminal(
        outcome,
        &ledger,
        "0198ab31-6c44-7e8a-b2bb-000000000209",
        "CHANNEL_MALFORMED_EVENT",
    );
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    // The durable row is terminal before any transport effect.
}

#[test]
fn unsafe_authoritative_media_is_refused_before_any_effect() {
    // A safely-normalized premised crop is materialized by the SHARED crop
    // module against the authoritative prepared display; a noncanonical
    // authoritative orientation makes the Channel refuse before any durable
    // or transport effect (the Channel never trusts the action's declared
    // geometry as an override).
    let config = multimodal_config();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    let block = send_block_with_parts(
        "0198ab31-6c44-7e8a-b2bb-000000000210",
        "session-main",
        json!([asset_part(ASSET_ID_A, true)]),
    );
    let mut assets = TestAssetPreparation::accepting();
    assets.proof_orientation = 9;

    let outcome = dispatch(&config, &mut ledger, &mut transport, &block, &mut assets);
    assert_zero_effect_terminal(
        outcome,
        &ledger,
        "0198ab31-6c44-7e8a-b2bb-000000000210",
        "CHANNEL_MALFORMED_EVENT",
    );
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
}

#[test]
fn text_only_send_is_unchanged_under_the_injected_seam() {
    let config = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1).build();
    let mut ledger = ChannelLedger::new();
    ledger.insert_session("account-a", "conv-1", "session-main");
    let mut transport = ScriptedTransport::new(true);
    transport.push(TransportSendResult::AllConfirmed {
        message_ids: vec!["msg-text-0".to_string()],
    });
    let block = send_block(
        "0198ab31-6c44-7e8a-b2bb-000000000205",
        "session-main",
        &["Hello."],
    );
    let mut assets = TestAssetPreparation::accepting();

    let outcome = dispatch(&config, &mut ledger, &mut transport, &block, &mut assets);
    match outcome {
        SendDispatchResult::Terminal {
            state: OutboundState::Confirmed,
            ..
        } => {}
        other => panic!("expected Terminal confirmed, got {other:?}"),
    }
    assert!(
        assets.prepared.is_empty(),
        "text-only sends never consult the asset seam"
    );
    let request = &transport.calls()[0];
    assert_eq!(request.pieces.len(), 1);
    assert_eq!(
        request.pieces[0],
        dolly_channel::TransportPiece::Text {
            ordinal: 0,
            text: "Hello.".to_string(),
        }
    );
    let entry = ledger
        .outbound_entry("0198ab31-6c44-7e8a-b2bb-000000000205")
        .unwrap();
    assert_eq!(entry.pieces.len(), 1);
    assert!(entry.pieces[0].asset.is_none());
    assert!(entry.pieces[0].outcome.is_some());
}
