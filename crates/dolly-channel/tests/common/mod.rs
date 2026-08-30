//! Shared test doubles for the dolly-channel integration tests.

#![allow(dead_code)]

pub mod g4;

use std::collections::BTreeMap;
use std::str::FromStr;

use dolly_channel::{
    ChannelConfig, ChannelConfigBuilder, CoreIngress, CoreIngressError, IngressCommit,
    IngressStatusResult, IngressSubmitReceipt, IngressSubmitRequest, VirtualClock,
};

/// A deterministic `host.ingress.*` double implementing the exact reducer
/// contract used by the real Core:
///
/// - identity is `(module_id, idempotency_key)`;
/// - a fresh submit mints a block ID and returns the mapping;
/// - a re-submit under an existing identity replays the prior mapping
///   (`idempotent: true`) and returns `STORAGE_IDEMPOTENCY_CONFLICT` when the
///   operation digest differs (never for byte-identical replays);
/// - `status` returns the committed mapping or authoritative `absent`.
pub struct MemCoreIngress {
    committed: BTreeMap<(String, String), IngressCommit>,
    digests: BTreeMap<(String, String), String>,
    next_seq: u64,
    pub submit_calls: u64,
    pub status_calls: u64,
    /// Remaining `host.ingress.submit` responses to drop (response lost).
    pub fail_submits: u64,
    /// Remaining `host.ingress.status` responses to drop (response lost).
    pub fail_statuses: u64,
    /// Remaining submits that COMMIT durably but whose response is lost
    /// (crash after Core submission).
    pub commit_then_drop_submits: u64,
}

impl MemCoreIngress {
    pub fn new() -> Self {
        Self {
            committed: BTreeMap::new(),
            digests: BTreeMap::new(),
            next_seq: 0,
            submit_calls: 0,
            status_calls: 0,
            fail_submits: 0,
            fail_statuses: 0,
            commit_then_drop_submits: 0,
        }
    }

    pub fn mint_block_id(&mut self) -> String {
        self.next_seq += 1;
        format!("0198ab31-6c44-7e8a-b2bb-{:012}", self.next_seq)
    }

    pub fn is_committed(&self, module_id: &str, idempotency_key: &str) -> bool {
        self.committed
            .contains_key(&(module_id.to_string(), idempotency_key.to_string()))
    }

    pub fn committed_count(&self) -> usize {
        self.committed.len()
    }

    /// The block ID of the most recently committed ingress mapping.
    pub fn last_block(&self) -> Option<String> {
        self.committed.values().last().map(|c| c.block_id.clone())
    }
}

impl CoreIngress for MemCoreIngress {
    fn submit(
        &mut self,
        request: &IngressSubmitRequest,
    ) -> Result<IngressSubmitReceipt, CoreIngressError> {
        self.submit_calls += 1;
        if self.fail_submits > 0 {
            self.fail_submits -= 1;
            return Err(CoreIngressError::UnknownOutcome);
        }
        let key = (request.module_id.clone(), request.idempotency_key.clone());
        if let Some(commit) = self.committed.get(&key) {
            let prior = self.digests.get(&key);
            let digest = request
                .operation_digest()
                .map_err(|_| CoreIngressError::Rejected {
                    code: "CORE_INVALID_JSON".to_string(),
                })?;
            if prior != Some(&digest) {
                return Err(CoreIngressError::Rejected {
                    code: "STORAGE_IDEMPOTENCY_CONFLICT".to_string(),
                });
            }
            return Ok(IngressSubmitReceipt::Committed {
                idempotent: true,
                commit: commit.clone(),
            });
        }
        let seq = self.mint_block_id();
        let commit = IngressCommit {
            ingress_id: format!("ingress-{seq}"),
            block_id: seq.clone(),
            graph_revision: 1,
            deliveries: vec![("user-input".to_string(), 1, 1)],
        };
        let digest = request
            .operation_digest()
            .map_err(|_| CoreIngressError::Rejected {
                code: "CORE_INVALID_JSON".to_string(),
            })?;
        self.digests.insert(key.clone(), digest);
        self.committed.insert(key, commit.clone());
        if self.commit_then_drop_submits > 0 {
            self.commit_then_drop_submits -= 1;
            return Err(CoreIngressError::UnknownOutcome);
        }
        Ok(IngressSubmitReceipt::Committed {
            idempotent: false,
            commit,
        })
    }

    fn status(
        &mut self,
        _operation_id: &str,
        module_id: &str,
        idempotency_key: &str,
        _deadline: &str,
    ) -> Result<IngressStatusResult, CoreIngressError> {
        self.status_calls += 1;
        if self.fail_statuses > 0 {
            self.fail_statuses -= 1;
            return Err(CoreIngressError::UnknownOutcome);
        }
        let key = (module_id.to_string(), idempotency_key.to_string());
        match self.committed.get(&key) {
            Some(commit) => Ok(IngressStatusResult::Committed {
                commit: commit.clone(),
            }),
            None => Ok(IngressStatusResult::Absent),
        }
    }
}

pub const NOW: &str = "2026-08-09T15:00:00.000000Z";

pub fn clock() -> VirtualClock {
    VirtualClock::at(dolly_core_domain::Timestamp::from_str(NOW).unwrap())
}

pub fn config() -> ChannelConfig {
    ChannelConfigBuilder::new("web", "account-a", "web-channel", 1).build()
}

pub fn message_event(
    account: &str,
    conversation: &str,
    message_id: &str,
    text: &str,
) -> dolly_channel::InboundEvent {
    dolly_channel::InboundEvent {
        channel_id: "web-primary".to_string(),
        transport: "web".to_string(),
        account: account.to_string(),
        external_conversation_id: conversation.to_string(),
        external_message_id: message_id.to_string(),
        sender_class: "user".to_string(),
        sender_id: format!("sender-{account}"),
        text: text.to_string(),
        received_at: dolly_core_domain::Timestamp::from_str(NOW).unwrap(),
        event_kind: dolly_channel::EventKind::Message,
        references_external_message_id: None,
        attachments: Vec::new(),
    }
}

/// A committed Block containing a targeted channel send action, as Core would
/// deliver to the Module Activation.
pub fn send_block(action_id: &str, session_id: &str, texts: &[&str]) -> serde_json::Value {
    let parts: Vec<serde_json::Value> = texts
        .iter()
        .map(|t| serde_json::json!({"kind": "text", "text": t, "format": "plain"}))
        .collect();
    serde_json::json!({
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

/// A committed Block whose action contract carries a stale result-validator
/// revision (must be refused before dispatch).
pub fn send_block_wrong_validator_revision(action_id: &str, session_id: &str) -> serde_json::Value {
    let mut block = send_block(action_id, session_id, &["Hello"]);
    let contract = &mut block["body"]["actions"][0]["contract_binding"]["action_contract"];
    contract["result_schema"]["semantic_validator"]["revision"] = serde_json::json!(2);
    block
}

/// A committed Block carrying an action from a different Extension owner.
pub fn non_channel_action_block(action_id: &str) -> serde_json::Value {
    serde_json::json!({
        "schema": "dolly.block/v1",
        "id": "0198ab31-6c44-7e8a-b2bb-000000000002",
        "body": {
            "description": "other",
            "parts": [],
            "actions": [{
                "action_id": action_id,
                "name": "org.dolly.other.something",
                "target": {"module_id": "web-channel"},
                "arguments": {}
            }]
        }
    })
}
