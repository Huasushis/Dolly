//! Manifest-selected committed targeted-Action boundary (seam D).
//!
//! Authority is exactly a targeted `org.dolly.channel.send` Action inside an
//! immutable committed Block selected by the one current
//! `ActivationManifest` for the configured module. The identity binds the
//! normative persisted manifest digest, the exact Delivery occurrence
//! (`page_id`, `page_seq`, `commit_seq`, and occurrence index), the Block, and
//! the Action's index within `body.actions`.
//!
//! Only that current manifest may mint this identity. `CoreSnapshot.blocks`,
//! `IngressCommitted` journal membership, `ingress`, `runtime_events`, or
//! graph-descriptor membership alone never mint send authority.

use crate::config::ChannelConfig;
use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ledger::{ChannelLedger, OutboundPiece};
use crate::outbound::{SendAction, authorize_send, parse_send_action_at};
use crate::principal::ChannelPrincipal;
use serde_json::Value;

/// One targeted `org.dolly.channel.send` Action selected from the current
/// module `ActivationManifest`. Construction is crate-private and every field
/// is derived from the frozen manifest bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct CommittedSendAction {
    pub(crate) action: SendAction,
    pub(crate) block_id: String,
    pub(crate) activation_id: String,
    /// Persisted `manifest_digest`, verified by hashing the manifest with that
    /// field removed.
    pub(crate) manifest_digest: String,
    pub(crate) occurrence_index: usize,
    pub(crate) page_id: String,
    pub(crate) page_seq: i64,
    pub(crate) commit_seq: i64,
    pub(crate) action_index: usize,
    pub(crate) session_id: String,
    pub(crate) pieces: Vec<OutboundPiece>,
    pub(crate) action_jcs: String,
    pub(crate) operation_digest: String,
}

impl CommittedSendAction {
    /// Construct from one exact Delivery occurrence in a frozen manifest
    /// input item. The manifest digest is the normative persisted digest:
    /// canonicalize and hash the manifest only after removing its
    /// `manifest_digest` field.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_manifest_input(
        manifest: &Value,
        item: &Value,
        occurrence_index: usize,
        occurrence: &Value,
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
        let manifest_digest = verified_manifest_digest(manifest)?;
        let page_id = occurrence
            .get("page_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| rejected("manifest Delivery occurrence has no page_id"))?
            .to_string();
        let page_seq = occurrence
            .get("page_seq")
            .and_then(Value::as_i64)
            .filter(|value| *value >= 0)
            .ok_or_else(|| rejected("manifest Delivery occurrence has invalid page_seq"))?;
        let commit_seq = occurrence
            .get("commit_seq")
            .and_then(Value::as_i64)
            .filter(|value| *value >= 0)
            .ok_or_else(|| rejected("manifest Delivery occurrence has invalid commit_seq"))?;
        let block = item
            .get("block")
            .ok_or_else(|| rejected("manifest input item has no frozen block"))?;
        let block_id = block
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| rejected("frozen block has no id"))?
            .to_string();
        let action = parse_send_action_at(block, action_index)?;
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
        let binding = action_obj
            .get("contract_binding")
            .ok_or_else(|| rejected("frozen action has no contract_binding"))?;
        let manifest_descriptor_revision = manifest
            .get("descriptor_revision")
            .and_then(Value::as_i64)
            .ok_or_else(|| rejected("manifest has no descriptor_revision"))?;
        let action_contract = binding
            .get("action_contract")
            .ok_or_else(|| rejected("frozen Action binding has no action_contract"))?;
        let contract_digest = dolly_canonical_json::canonicalize(action_contract)
            .map_err(|_| rejected("frozen Action contract is not canonical JSON"))?
            .1
            .to_canonical_string();
        if binding.get("module_id").and_then(Value::as_str) != Some(config.module_id.as_str())
            || binding.get("descriptor_revision").and_then(Value::as_i64)
                != Some(manifest_descriptor_revision)
            || binding
                .get("action_contract_digest")
                .and_then(Value::as_str)
                != Some(contract_digest.as_str())
            || action_contract.get("name").and_then(Value::as_str)
                != Some(crate::config::SEND_ACTION_NAME)
            || action_contract
                .get("arguments_schema")
                .and_then(|schema| schema.get("uri"))
                .and_then(Value::as_str)
                != Some("https://dolly.example/spec/0.1/schemas/channel-send.schema.json")
            || action_contract
                .get("result_schema")
                .and_then(|schema| schema.get("uri"))
                .and_then(Value::as_str)
                != Some("https://dolly.example/spec/0.1/schemas/channel-send-result.schema.json")
            || action_contract
                .get("side_effect_class")
                .and_then(Value::as_str)
                != Some("idempotent_write")
        {
            return Err(rejected(
                "frozen Action contract binding does not match the manifest-selected module descriptor",
            ));
        }
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
        let operation_digest = manifest_operation_digest(
            &base_digest,
            &activation_id,
            &manifest_digest,
            occurrence_index,
            &page_id,
            page_seq,
            commit_seq,
            action_index,
            &block_id,
        );
        Ok(Self {
            action,
            block_id,
            activation_id,
            manifest_digest,
            occurrence_index,
            page_id,
            page_seq,
            commit_seq,
            action_index,
            session_id: authorized.session_id,
            pieces: authorized.pieces,
            action_jcs,
            operation_digest,
        })
    }
}

/// Verify and return the normative digest carried by a manifest. The digest
/// field is excluded from its own digest input.
pub(crate) fn verified_manifest_digest(manifest: &Value) -> Result<String, ChannelError> {
    let rejected = |message: &str| {
        ChannelError::new(
            codes::AUTHORIZATION_FAILED,
            false,
            ChannelOutcome::NotApplied,
            message,
        )
    };
    let persisted = manifest
        .get("manifest_digest")
        .and_then(Value::as_str)
        .ok_or_else(|| rejected("manifest has no persisted manifest_digest"))?;
    let mut digestable = manifest.clone();
    digestable
        .as_object_mut()
        .ok_or_else(|| rejected("manifest is not an object"))?
        .remove("manifest_digest");
    let computed = dolly_canonical_json::canonicalize(&digestable)
        .map_err(|error| rejected(&format!("manifest is not canonical JSON: {error}")))?
        .1
        .to_canonical_string();
    if computed != persisted {
        return Err(rejected(
            "manifest_digest does not match the frozen manifest bytes",
        ));
    }
    Ok(persisted.to_string())
}

/// Digest the exact Manifest-selected action coordinates.
#[allow(clippy::too_many_arguments)]
pub(crate) fn manifest_operation_digest(
    base_digest: &str,
    activation_id: &str,
    manifest_digest: &str,
    occurrence_index: usize,
    page_id: &str,
    page_seq: i64,
    commit_seq: i64,
    action_index: usize,
    block_id: &str,
) -> String {
    let identity = serde_json::json!({
        "schema": "dolly.channel-outbound/manifest-selected/v1",
        "base": base_digest,
        "activation_id": activation_id,
        "manifest_digest": manifest_digest,
        "occurrence_index": occurrence_index,
        "page_id": page_id,
        "page_seq": page_seq,
        "commit_seq": commit_seq,
        "action_index": action_index,
        "block_id": block_id,
    });
    dolly_canonical_json::canonicalize(&identity)
        .expect("manifest action identity is canonical JSON")
        .1
        .to_canonical_string()
}
