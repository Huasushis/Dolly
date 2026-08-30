//! WP-013B first boundary: ordered multimodal asset premises parse ONLY from
//! the committed `org.dolly.channel.send` Action path, in Action part order,
//! and noncanonical or unprepared AssetRef premises are refused before any
//! durable or transport effect. The default seam stays v1 text-only.
#![cfg(feature = "test-support")]

mod common;

use common::*;
use dolly_channel::asset::{
    AssetLeaseProof, AssetPremise, AssetPreparation, CropRect, DenyAssetParts, PreparedAsset,
};
use dolly_channel::{
    ChannelLedger, OutboundAdmission, OutboundState, ScriptedTransport, SendDispatchResult,
    TransportSendResult, dispatch_send, parse_send_action,
};
use serde_json::json;

/// Deterministic injected-seam test double: accepts every premise in order
/// and mints one opaque proof per premise, or refuses per the configured
/// code; optionally fails post-blocking lease revalidation.
#[derive(Debug, Clone, Default)]
struct TestAssetPreparation {
    refuse_code: Option<String>,
    revalidate_fails: bool,
    prepared: Vec<AssetPremise>,
    revalidated: Vec<AssetLeaseProof>,
}

impl TestAssetPreparation {
    fn accepting() -> Self {
        Self::default()
    }
    fn refusing(code: &str) -> Self {
        Self {
            refuse_code: Some(code.to_string()),
            ..Self::default()
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
        Ok(premises
            .iter()
            .map(|premise| AssetLeaseProof {
                value: json!({ "lease_id": format!("lease-{}", premise.ordinal) }),
            })
            .collect())
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
fn send_block_with_parts(action_id: &str, session_id: &str, parts: serde_json::Value) -> serde_json::Value {
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

fn expected_premise(ordinal: u32, asset_id: &str, view: Option<CropRect>) -> AssetPremise {
    AssetPremise {
        ordinal,
        asset_id: asset_id.to_string(),
        media_type: "image/png".to_string(),
        view,
    }
}

#[test]
fn ordered_mixed_text_and_asset_premises_prepare_in_action_order() {
    let config = config();
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
    // order, with canonical identity and the crop preserved.
    let crop = CropRect { x0: 100000, y0: 200000, x1: 600000, y1: 600000 };
    assert_eq!(
        assets.prepared,
        vec![
            expected_premise(1, ASSET_ID_A, Some(crop)),
            expected_premise(3, &asset_b, None)
        ]
    );

    // The transport received all four pieces in order; text pieces keep their
    // text and no asset, asset pieces carry their premise + lease proof and
    // no fabricated text.
    let request = &transport.calls()[0];
    assert_eq!(request.pieces.len(), 4);
    assert_eq!(request.pieces[0].text, "First.");
    assert_eq!(request.pieces[0].asset, None);
    let prepared_a = request.pieces[1].asset.as_ref().expect("asset piece A");
    assert_eq!(prepared_a.premise.ordinal, 1);
    assert_eq!(prepared_a.premise.asset_id, ASSET_ID_A);
    assert_eq!(prepared_a.premise.media_type, "image/png");
    assert_eq!(prepared_a.premise.view, Some(crop));
    assert_eq!(prepared_a.lease_proof.value["lease_id"], "lease-1");
    assert_eq!(request.pieces[1].text, "", "asset pieces carry no text");
    assert_eq!(request.pieces[2].text, "Second.");
    let prepared_b = request.pieces[3].asset.as_ref().expect("asset piece B");
    assert_eq!(prepared_b.premise.ordinal, 3);
    assert_eq!(prepared_b.premise.asset_id, asset_b);
    assert_eq!(prepared_b.premise.view, None);
    assert_eq!(prepared_b.lease_proof.value["lease_id"], "lease-3");

    // The durable ledger row persists the prepared asset pieces verbatim.
    let entry = ledger
        .outbound_entry("0198ab31-6c44-7e8a-b2bb-000000000201")
        .unwrap();
    assert_eq!(entry.pieces.len(), 4);
    assert_eq!(entry.pieces[1].asset, Some(PreparedAsset {
        premise: expected_premise(1, ASSET_ID_A, Some(crop)),
        lease_proof: AssetLeaseProof { value: json!({ "lease_id": "lease-1" }) },
    }));
}

#[test]
fn default_deny_seam_refuses_asset_parts_with_zero_effect() {
    let config = config();
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
fn noncanonical_asset_premise_is_refused_before_any_effect() {
    let config = config();
    // A forged/uppercase AssetId (not canonical).
    let mut bad_id = asset_part(ASSET_ID_A, false);
    bad_id["asset_id"] =
        json!("ast_b3_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    for parts in [
        json!([bad_id]),
        // An uppercase, parameterized media type is not canonical.
        json!([{
            "kind": "asset",
            "asset_id": ASSET_ID_A,
            "media_type": "Image/PNG"
        }]),
        // A crop whose bottom-right corner does not extend past its top-left
        // corner is structurally invalid (the JSON Schema range alone cannot
        // express this).
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
    let config = config();
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
    // The seam was consulted with the exact ordered premise.
    assert_eq!(assets.prepared, vec![expected_premise(1, ASSET_ID_A, None)]);
}

#[test]
fn text_only_send_is_unchanged_under_the_injected_seam() {
    let config = config();
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
    // The frozen text-only result envelope is unchanged.
    let entry = ledger.outbound_entry("0198ab31-6c44-7e8a-b2bb-000000000205").unwrap();
    assert_eq!(entry.pieces.len(), 1);
    assert!(entry.pieces[0].asset.is_none());
    assert!(entry.pieces[0].outcome.is_some());
}
