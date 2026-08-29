//! Committed targeted-Action verification boundary (seam D).
//!
//! The outbound pipeline begins ONLY from a committed targeted
//! `org.dolly.channel.send` Action selected into this Module's Activation
//! and verified against the authoritative Core operation/journal under the
//! exact current sealed principal and configuration. Nothing on this
//! boundary is caller-shaped: the committed Block and its targeted Action are
//! the only inputs, every authority fact (owner, Extension, module, instance,
//! generation, incarnation revision, graph revision + digest, config
//! revision, account) is derived from the sealed [`ChannelPrincipal`], and
//! the returned authority-bound operation digest makes a same `action_id`
//! under a different target/content/config conflict before enqueue. No
//! transport, inbound premise, or echo object can mint or reverse an Action
//! here.

use serde_json::Value;

use crate::config::ChannelConfig;
use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ledger::{ChannelLedger, OutboundPiece};
use crate::outbound::{SendAction, authorize_send, parse_send_action};
use crate::principal::ChannelPrincipal;

/// One targeted `org.dolly.channel.send` action verified from a committed
/// Block under the exact current sealed principal and config. Every field is
/// derived; no caller-shaped Action/Block/transport authority reaches it.
#[derive(Debug, Clone, PartialEq)]
pub struct CommittedSendAction {
    /// The parsed, name- and shape-verified send Action.
    pub action: SendAction,
    /// The committed Block identity this Action was selected from.
    pub block_id: String,
    /// The account-owned session the send is authorized into.
    pub session_id: String,
    /// The v1 text pieces (validated here, used by dispatch).
    pub pieces: Vec<OutboundPiece>,
    /// Canonical bytes of the committed `body.actions[..]` Action object.
    pub action_jcs: String,
    /// Authority-bound operation digest: full principal fences + targeted
    /// module + canonical committed Action bytes. The same `action_id` under
    /// a different target/content/config conflicts before enqueue.
    pub operation_digest: String,
}

/// Verify one committed Block's targeted channel send Action under the exact
/// current sealed principal and config. The Block MUST be an authoritative
/// committed Core Block delivered through the committed-Action source; this
/// boundary never accepts an Action, Block, or transport authority from a
/// caller.
///
/// Rejects (before any durable effect or enqueue) a foreign-owner Action, a
/// target other than the configured module, a stale result contract, invalid
/// arguments, an unsupported modality, or a session this account does not
/// own.
pub fn committed_send_from_block(
    block_id: &str,
    block: &Value,
    principal: &ChannelPrincipal,
    config: &ChannelConfig,
    ledger: &ChannelLedger,
) -> Result<CommittedSendAction, ChannelError> {
    let action = parse_send_action(block)?;
    let authorized = authorize_send(config, ledger, &action)?;
    let action_jcs = canonical_send_action_jcs(block)?;
    let operation_digest = crate::host_adapter::outbound_operation_digest(
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
    Ok(CommittedSendAction {
        action,
        block_id: block_id.to_string(),
        session_id: authorized.session_id,
        pieces: authorized.pieces,
        action_jcs,
        operation_digest,
    })
}

/// The canonical bytes of the committed `org.dolly.channel.send` Action
/// object that [`parse_send_action`] matched. The block's own object is
/// canonicalized (never a caller-rebuilt copy), so the operation digest and
/// the durable Prepared record bind the exact committed bytes.
fn canonical_send_action_jcs(block: &Value) -> Result<String, ChannelError> {
    let rejected = |message: &str| {
        ChannelError::new(
            codes::MALFORMED_EVENT,
            false,
            ChannelOutcome::NotApplied,
            message,
        )
    };
    let obj = block
        .as_object()
        .ok_or_else(|| rejected("outbound block must be a JSON object"))?;
    let body = obj
        .get("body")
        .and_then(Value::as_object)
        .ok_or_else(|| rejected("outbound block missing body"))?;
    let actions = body
        .get("actions")
        .and_then(Value::as_array)
        .ok_or_else(|| rejected("outbound block body missing actions"))?;
    for action in actions {
        let action_obj = action
            .as_object()
            .ok_or_else(|| rejected("action must be an object"))?;
        let name = action_obj.get("name").and_then(Value::as_str);
        if name == Some(crate::config::SEND_ACTION_NAME) {
            let canonical = dolly_canonical_json::canonicalize(action)
                .map_err(|_| rejected("committed send action is not canonical JSON"))?
                .0
                .as_bytes()
                .to_vec();
            return String::from_utf8(canonical)
                .map_err(|_| rejected("committed send action is not UTF-8"));
        }
    }
    Err(rejected("committed block has no targeted channel send action"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::{ChannelLedger, OutboundPiece};
    use crate::principal::ChannelPrincipal;
    use serde_json::{Value, json};

    fn principal() -> ChannelPrincipal {
        ChannelPrincipal::from_parts(
            "owner-1",
            "org.dolly.channel",
            "receiver",
            "worker-1",
            1,
            1,
            1,
            "digest-g",
        )
    }

    fn config() -> ChannelConfig {
        ChannelConfigBuilder::new("web", "account-a", "receiver", 1).build()
    }

    use crate::config::ChannelConfigBuilder;

    /// A committed Block carrying one targeted channel send Action (the exact
    /// shape the accepted dispatch path consumes).
    fn send_block(action_id: &str, session_id: &str, target: &str, text: &str) -> Value {
        let part = json!({"kind": "text", "text": text, "format": "plain"});
        json!({
            "schema": "dolly.block/v1",
            "id": "0198ab31-6c44-7e8a-b2bb-000000000001",
            "body": {
                "description": "model response",
                "parts": [part.clone()],
                "actions": [{
                    "action_id": action_id,
                    "name": "org.dolly.channel.send",
                    "target": {"module_id": target},
                    "arguments": {
                        "session_id": session_id,
                        "parts": [part],
                        "reply_to_external_message_id": null
                    },
                    "contract_binding": {
                        "module_id": target,
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

    fn sessioned_ledger(session_id: &str) -> ChannelLedger {
        let mut ledger = ChannelLedger::new();
        ledger.insert_session("account-a", "conv-1", session_id);
        ledger
    }

    #[test]
    fn committed_send_verification_is_derived_deterministic_and_authoritative() {
        let config = config();
        let ledger = sessioned_ledger("session-main");
        let block = send_block("0198ab31-6c44-7e8a-b2bb-000000000701", "session-main", "receiver", "Hello.");
        let first = committed_send_from_block("block-1", &block, &principal(), &config, &ledger)
            .expect("committed send verifies");
        assert_eq!(first.action.action_id, "0198ab31-6c44-7e8a-b2bb-000000000701");
        assert_eq!(first.session_id, "session-main");
        assert_eq!(first.pieces.len(), 1);
        assert_eq!(
            first.pieces,
            vec![OutboundPiece {
                ordinal: 0,
                text: "Hello.".to_string(),
                transport_message_id: None,
                outcome: None,
            }]
        );
        // The canonical action bytes are the exact canonical committed object.
        let reparsed: Value = serde_json::from_str(&first.action_jcs).unwrap();
        assert_eq!(reparsed["action_id"], "0198ab31-6c44-7e8a-b2bb-000000000701");
        // Deterministic across calls.
        let second = committed_send_from_block("block-1", &block, &principal(), &config, &ledger).unwrap();
        assert_eq!(first.operation_digest, second.operation_digest);
        assert_eq!(first.action_jcs, second.action_jcs);
    }

    #[test]
    fn committed_send_rejects_wrong_target_foreign_owner_and_unowned_session() {
        let config = config();
        let ledger = sessioned_ledger("session-main");

        // Action targeting another module is refused before any durable effect.
        let wrong_target = send_block("0198ab31-6c44-7e8a-b2bb-000000000702", "session-main", "receiver-other", "Hi");
        let error = committed_send_from_block("block-2", &wrong_target, &principal(), &config, &ledger)
            .expect_err("non-targeted action must be refused");
        assert_eq!(error.code, codes::AUTHORIZATION_FAILED);

        // Foreign-owner action never parses as a channel send.
        let mut foreign = send_block("0198ab31-6c44-7e8a-b2bb-000000000703", "session-main", "receiver", "Hi");
        foreign["body"]["actions"][0]["name"] = json!("org.dolly.other.something");
        let error = committed_send_from_block("block-3", &foreign, &principal(), &config, &ledger)
            .expect_err("foreign-owner action must be refused");
        assert_eq!(error.code, codes::AUTHORIZATION_FAILED);

        // A session this account does not own is refused.
        let unowned = send_block("0198ab31-6c44-7e8a-b2bb-000000000704", "session-not-owned", "receiver", "Hi");
        let error = committed_send_from_block("block-4", &unowned, &principal(), &config, &ledger)
            .expect_err("unowned session must be refused");
        assert_eq!(error.code, codes::SESSION_MISSING);
    }

    #[test]
    fn committed_send_digest_binds_content_target_and_config() {
        let config = config();
        let ledger = sessioned_ledger("session-main");

        let base = send_block("0198ab31-6c44-7e8a-b2bb-000000000705", "session-main", "receiver", "Hello.");
        let base_verified = committed_send_from_block("b", &base, &principal(), &config, &ledger).unwrap();

        // Same action_id + different content conflicts at the digest boundary.
        let changed = send_block("0198ab31-6c44-7e8a-b2bb-000000000705", "session-main", "receiver", "Different.");
        let changed_verified = committed_send_from_block("b", &changed, &principal(), &config, &ledger).unwrap();
        assert_ne!(base_verified.operation_digest, changed_verified.operation_digest);

        // Same action_id + same content under a different config revision
        // conflicts at the digest boundary.
        let config2 = ChannelConfigBuilder::new("web", "account-a", "receiver", 2).build();
        let under_config2 = committed_send_from_block("b", &base, &principal(), &config2, &ledger).unwrap();
        assert_ne!(base_verified.operation_digest, under_config2.operation_digest);

        // Same action_id + same content + different target module conflicts.
        let retargeted = send_block("0198ab31-6c44-7e8a-b2bb-000000000705", "session-main", "receiver-other", "Hello.");
        let mut config_other = config.clone();
        config_other.module_id = "receiver-other".to_string();
        let retargeted_verified =
            committed_send_from_block("b", &retargeted, &principal(), &config_other, &ledger).unwrap();
        assert_ne!(base_verified.operation_digest, retargeted_verified.operation_digest);
    }
}
