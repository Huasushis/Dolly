//! Manifest-selected committed targeted-Action boundary (seam D).
//!
//! Authority is EXACTLY a targeted `org.dolly.channel.send` Action inside an
//! immutable committed Block that was delivered through a configured Page and
//! selected into the configured Module's persisted
//! `ActivationManifest.input_items` (spec: ActivationManifest and
//! Page-Delivery-Subscription). The Action identity binds `action_id`,
//! `activation_id`, `manifest_digest`, the input occurrence (the input
//! item's index in Manifest Delivery order), `block_id`, and the action's
//! index within the Block's `body.actions`.
//!
//! Only `CoreSnapshot.activations[*].manifest` may mint this identity;
//! `CoreSnapshot.blocks`, `IngressCommitted` journal membership, `ingress`,
//! `runtime_events`, or graph-descriptor membership alone NEVER mint send
//! authority. [`CommittedSendAction`] is private-construction-only: no caller
//! can feed a Block or Action into the pipeline.

use crate::config::ChannelConfig;
use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ledger::{ChannelLedger, OutboundPiece};
use crate::outbound::{SendAction, authorize_send, parse_send_action_at};
use crate::principal::ChannelPrincipal;
use serde_json::Value;

/// One targeted `org.dolly.channel.send` Action selected from the configured
/// Module's persisted ActivationManifest. Private construction only: produced
/// solely by [`CommittedSendAction::from_manifest_input`] from an immutable
/// committed Block frozen in `manifest.input_items`; every field is derived,
/// no caller-shaped Action/Block/transport authority reaches it.
#[derive(Debug, Clone, PartialEq)]
pub struct CommittedSendAction {
    /// The parsed, name- and shape-verified send Action.
    pub(crate) action: SendAction,
    /// The committed Block identity this Action was selected from.
    pub(crate) block_id: String,
    /// The activation whose persisted manifest selected the input.
    pub(crate) activation_id: String,
    /// Deterministic digest of the frozen manifest bytes (tamper-evident).
    pub(crate) manifest_digest: String,
    /// The input item's index in Manifest Delivery order.
    pub(crate) input_index: usize,
    /// The send Action's index within `body.actions` of the frozen Block.
    pub(crate) action_index: usize,
    /// The account-owned session the send is authorized into.
    pub(crate) session_id: String,
    /// The v1 text pieces (validated here, used by dispatch).
    pub(crate) pieces: Vec<OutboundPiece>,
    /// Canonical bytes of the frozen `body.actions[action_index]` object.
    pub(crate) action_jcs: String,
    /// Authority-bound operation digest: full principal fences + targeted
    /// module + canonical committed Action bytes + exact Manifest coordinates.
    /// The same `action_id` under a different target/content/config/
    /// base-identity conflicts before enqueue.
    pub(crate) operation_digest: String,
}

impl CommittedSendAction {
    /// Construct one committed targeted send from a frozen ActivationManifest
    /// input item. `item` is the manifest `input_items[input_index]` element
    /// (`{block, occurrences, occurrence_count}`, in immutable Manifest
    /// Delivery order) and `action_index` is the index of the send Action in
    /// the frozen Block's `body.actions`. This is the ONLY construction path.
    pub(crate) fn from_manifest_input(
        manifest: &Value,
        item: &Value,
        input_index: usize,
        action_index: usize,
        principal: &ChannelPrincipal,
        config: &ChannelConfig,
        ledger: &ChannelLedger,
    ) -> Result<Self, ChannelError> {
        let rejected = |message: &str| {
            ChannelError::new(
                codes::AUTHORIZATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                message,
            )
        };
        let activation_id = manifest
            .get("activation_id")
            .and_then(Value::as_str)
            .ok_or_else(|| rejected("manifest has no activation_id"))?
            .to_string();
        let fragment = dolly_canonical_json::canonicalize(manifest)
            .map_err(|e| rejected(&format!("manifest is not canonical JSON: {e}")))?;
        let manifest_digest =
            dolly_canonical_json::Sha256Digest::compute(fragment.0.as_bytes()).to_canonical_string();
        let block = item
            .get("block")
            .ok_or_else(|| rejected("manifest input item has no frozen block"))?;
        let block_id = block
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| rejected("frozen block has no id"))?
            .to_string();
        // The action at the manifest-selected index of the frozen Block's
        // `body.actions` (Action array order is part of the identity).
        let action = parse_send_action_at(block, action_index)?;
        // Name/target/contract/schema/session validation (authority checks
        // shared with the dispatch layer; no caller input reaches them).
        let authorized = authorize_send(config, ledger, &action)?;
        let action_obj = block
            .get("body")
            .and_then(Value::as_object)
            .and_then(|body| body.get("actions"))
            .and_then(Value::as_array)
            .and_then(|actions| actions.get(action_index))
            .cloned()
            .ok_or_else(|| {
                ChannelError::new(
                    codes::MALFORMED_EVENT,
                    false,
                    ChannelOutcome::NotApplied,
                    "frozen block has no action at the manifest-selected index",
                )
            })?;
        let action_jcs = String::from_utf8(
            dolly_canonical_json::canonicalize(&action_obj)
                .map_err(|_| rejected("frozen action is not canonical JSON"))?
                .0
                .as_bytes()
                .to_vec(),
        )
        .map_err(|_| rejected("frozen action is not UTF-8"))?;
        let base_digest = crate::host_adapter::outbound_operation_digest(
            principal.extension_id(),
            principal.module_id(),
            principal.instance_id(),
            principal.generation(),
            principal.revision(),
            principal.graph_revision(),
            principal.graph_digest(),
            config.revision,
            principal.account(),
            &action_jcs,
            &action.target_module_id,
        );
        // Bind the exact Manifest coordinates into the operation identity so
        // a same action_id under a different Activation/Manifest/occurrence
        // conflicts before enqueue.
        let mut identity = serde_json::Map::new();
        identity.insert(
            "schema".into(),
            serde_json::json!("dolly.channel-outbound/manifest-selected/v1"),
        );
        identity.insert("base".into(), serde_json::json!(base_digest));
        identity.insert("activation_id".into(), serde_json::json!(activation_id));
        identity.insert("manifest_digest".into(), serde_json::json!(manifest_digest));
        identity.insert("input_index".into(), serde_json::json!(input_index));
        identity.insert("action_index".into(), serde_json::json!(action_index));
        identity.insert("block_id".into(), serde_json::json!(block_id));
        let operation_digest = dolly_canonical_json::Sha256Digest::compute(
            dolly_canonical_json::canonicalize(&serde_json::Value::Object(identity))
                .expect("identity is canonical JSON")
                .0
                .as_bytes(),
        )
        .to_canonical_string();
        Ok(CommittedSendAction {
            action,
            block_id,
            activation_id,
            manifest_digest,
            input_index,
            action_index,
            session_id: authorized.session_id,
            pieces: authorized.pieces,
            action_jcs,
            operation_digest,
        })
    }
}
