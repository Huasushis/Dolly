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
    AssetLeaseProof, AssetPayload, AssetPremise, AssetPreparation, DenyAssetParts, PreparedAsset,
};
use dolly_schema::CropRect;
use dolly_channel::{
    ChannelConfig, ChannelLedger, OutboundAdmission, OutboundState, ScriptedTransport,
    SendDispatchResult, TransportSendResult, dispatch_send, parse_send_action,
};
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
        asset_id: asset_id.to_string(),
        media_type: media_type.to_string(),
        view,
    }
}

/// Deterministic injected-seam test double: accepts every premise in order
/// and mints one typed proof per premise (or refuses per the configured
/// code / forged media type / oversized metadata); controls the ephemeral
/// payload length; optionally fails post-blocking lease revalidation.
#[derive(Debug, Clone, Default)]
struct TestAssetPreparation {
    refuse_code: Option<String>,
    revalidate_fails: bool,
    forge_media_type: Option<String>,
    proof_byte_length: u64,
    proof_orientation: u8,
    payload_byte_length: Option<usize>,
    prepared: Vec<AssetPremise>,
    revalidated: Vec<AssetLeaseProof>,
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
            proof_byte_length: 1000,
            proof_orientation: 1,
            refuse_code: Some(code.to_string()),
            ..Self::default()
        }
    }
    fn proof(&self, premise: &AssetPremise) -> AssetLeaseProof {
        AssetLeaseProof {
            lease_id: format!("lease-{}", premise.ordinal),
            lease_expires_at: "2026-08-29T00:00:00.000000Z".to_string(),
            lease_generation: 1,
            media_type: self
                .forge_media_type
                .clone()
                .unwrap_or_else(|| premise.media_type.clone()),
            byte_length: self.proof_byte_length,
            encoded_width: 1000,
            encoded_height: 500,
            orientation: self.proof_orientation,
            content_digest: format!("sha256:{:064}", premise.ordinal),
        }
    }
    fn payload(&self, proof: &AssetLeaseProof) -> AssetPayload {
        let len = self.payload_byte_length.unwrap_or(proof.byte_length as usize);
        AssetPayload {
            bytes: vec![0x55; len],
        }
    }
}

impl AssetPreparation for TestAssetPreparation {
    fn prepare_assets(
        &mut self,
        premises: &[AssetPremise],
    ) -> Result<Vec<AssetLeaseProof>, dolly_channel::ChannelError> {
        self.prepared.extend_from_slice(premises);
        if let Some(code) = &self.refuse_code {
            return Err(dolly_channel::ChannelError::new(
                code.clone(),
                false,
                dolly_channel::ChannelOutcome::NotApplied,
                "asset not prepared under the Channel authority",
            ));
        }
        Ok(premises.iter().map(|premise| self.proof(premise)).collect())
    }

    fn asset_payload(
        &mut self,
        proof: &AssetLeaseProof,
    ) -> Result<AssetPayload, dolly_channel::ChannelError> {
        Ok(self.payload(proof))
    }

    fn revalidate_leases(
        &mut self,
        proofs: &[AssetLeaseProof],
    ) -> Result<(), dolly_channel::ChannelError> {
        self.revalidated.extend_from_slice(proofs);
        if self.revalidate_fails {
            return Err(dolly_channel::ChannelError::new(
                dolly_channel::error::codes::AUTHORIZATION_FAILED,
                false,
                dolly_channel::ChannelOutcome::NotApplied,
                "asset lease invalidated after blocking work",
            ));
        }
        Ok(())
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
        config, &clock, ledger, transport, &mut admission, assets, &action,
    )
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

    // The transport received all four pieces in order; text pieces keep their
    // text, asset pieces carry premise + typed proof + EPHEMERAL payload and
    // no fabricated text.
    let request = &transport.calls()[0];
    assert_eq!(request.pieces.len(), 4);
    assert_eq!(request.pieces[0].text, "First.");
    assert_eq!(request.pieces[0].asset, None);
    assert_eq!(request.pieces[0].asset_payload, None);
    let prepared_a = request.pieces[1].asset.as_ref().expect("asset piece A");
    assert_eq!(prepared_a.premise.ordinal, 1);
    assert_eq!(prepared_a.premise.asset_id, ASSET_ID_A);
    assert_eq!(prepared_a.premise.media_type, "image/png");
    assert_eq!(prepared_a.lease_proof.lease_id, "lease-1");
    assert_eq!(prepared_a.lease_proof.media_type, "image/png");
    assert_eq!(prepared_a.lease_proof.byte_length, 1000);
    let payload_a = request.pieces[1].asset_payload.as_ref().expect("payload A");
    assert_eq!(payload_a.bytes.len(), 1000);
    assert_eq!(request.pieces[1].text, "", "asset pieces carry no text");
    assert_eq!(request.pieces[2].text, "Second.");
    let prepared_b = request.pieces[3].asset.as_ref().expect("asset piece B");
    assert_eq!(prepared_b.premise.ordinal, 3);
    assert_eq!(prepared_b.premise.asset_id, asset_b);
    assert_eq!(request.pieces[3].asset_payload.as_ref().unwrap().bytes.len(), 1000);

    // The durable ledger row persists ONLY the canonical premise/proof
    // metadata, never the ephemeral payload bytes.
    let entry = ledger
        .outbound_entry("0198ab31-6c44-7e8a-b2bb-000000000201")
        .unwrap();
    assert_eq!(entry.pieces.len(), 4);
    assert_eq!(entry.pieces[1].asset, Some(PreparedAsset {
        premise: asset_premise_of(1, ASSET_ID_A, "image/png", Some(crop)),
        lease_proof: AssetLeaseProof {
            lease_id: "lease-1".to_string(),
            lease_expires_at: "2026-08-29T00:00:00.000000Z".to_string(),
            lease_generation: 1,
            media_type: "image/png".to_string(),
            byte_length: 1000,
            encoded_width: 1000,
            encoded_height: 500,
            orientation: 1,
            content_digest: format!("sha256:{:064}", 1),
        },
    }));
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
    match outcome {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_UNSUPPORTED_MODALITY");
            assert!(!error.retryable);
            assert_eq!(error.outcome, dolly_channel::ChannelOutcome::NotApplied);
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(ledger.outbound.is_empty(), "zero durable outbound mutation");
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
    match outcome {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_ASSET_IMPORT_FAILED");
            assert!(!error.retryable);
            assert_eq!(error.outcome, dolly_channel::ChannelOutcome::NotApplied);
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(ledger.outbound.is_empty(), "zero durable outbound mutation");
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
    match outcome {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_MALFORMED_EVENT");
            assert!(error.message.contains("byte length"));
            assert_eq!(error.outcome, dolly_channel::ChannelOutcome::NotApplied);
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(ledger.outbound.is_empty(), "zero durable outbound mutation");
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
    match outcome {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_MALFORMED_EVENT");
            assert!(error.message.contains("media type"));
            assert_eq!(error.outcome, dolly_channel::ChannelOutcome::NotApplied);
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(ledger.outbound.is_empty(), "zero durable outbound mutation");
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
    match outcome {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_MALFORMED_EVENT");
            assert!(error.message.contains("payload"));
            assert_eq!(error.outcome, dolly_channel::ChannelOutcome::NotApplied);
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    // The durable row stays Prepared (never dispatched, never terminal); the
    // refusal occurred at the transport boundary AFTER the durable prepare.
    let entry = ledger.outbound_entry("0198ab31-6c44-7e8a-b2bb-000000000209").unwrap();
    assert_eq!(entry.state, OutboundState::Prepared);
    assert!(entry.pieces.iter().all(|p| p.outcome.is_none()));
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
    match outcome {
        SendDispatchResult::Rejected(error) => {
            assert_eq!(error.code, "CHANNEL_MALFORMED_EVENT");
            assert_eq!(error.outcome, dolly_channel::ChannelOutcome::NotApplied);
        }
        other => panic!("expected Rejected malformed, got {other:?}"),
    }
    assert_eq!(transport.calls().len(), 0, "zero transport effect");
    assert!(ledger.outbound.is_empty(), "zero durable outbound mutation");
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
    assert_eq!(request.pieces[0].text, "Hello.");
    assert_eq!(request.pieces[0].asset, None);
    let entry = ledger
        .outbound_entry("0198ab31-6c44-7e8a-b2bb-000000000205")
        .unwrap();
    assert_eq!(entry.pieces.len(), 1);
    assert!(entry.pieces[0].asset.is_none());
    assert!(entry.pieces[0].outcome.is_some());
}
