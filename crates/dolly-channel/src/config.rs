//! Strict, revisioned `org.dolly.channel` module configuration.
//!
//! Configuration is schema-validated and revisioned. Unknown fields are
//! rejected (`deny_unknown_fields`). A hot reload must first validate the new
//! configuration (and the adapter it implies) before any new work is routed
//! to it; in-flight inbound and outbound operations retain the revision they
//! were captured under. Changing the transport account creates a new
//! deduplication namespace because every inbound ledger key embeds the
//! account.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::error::{ChannelError, ChannelOutcome, codes};
use dolly_core_domain::SecretRef;

/// The fixed Extension ID of the built-in channel package.
pub const EXTENSION_ID: &str = "org.dolly.channel";

/// The v1 outbound action name.
pub const SEND_ACTION_NAME: &str = "org.dolly.channel.send";

/// Bound mirrors: the channel-send schema permits at most 32 parts and Core
/// permits at most 262144 octets per text part.
pub const MAX_PARTS: usize = 32;
pub const MAX_TEXT_BYTES: usize = 262_144;
/// Largest outbound asset byte length a Channel send may carry (mirrors the
/// default Asset Service encoded-byte bound).
pub const MAX_ASSET_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_EXTERNAL_ID_BYTES: usize = 512;
pub const MAX_SEND_RESULT_MESSAGES: usize = 32;
pub const MAX_CONCURRENT_ATTEMPTS: usize = 64;

/// How a new external conversation is treated when no session exists yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMappingPolicy {
    /// Reject events for conversations that have no mapped session.
    RequireKnown,
    /// Create a Dolly session on the first message of a conversation.
    CreateOnFirstMessage,
}

/// Outbound admission limits (bounded queues and caller deadlines).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutboundLimits {
    /// Maximum pieces sent per second per session.
    pub max_pieces_per_second_per_session: u64,
    /// Maximum pending (dispatched, unreconciled) sends per session.
    pub max_pending_per_session: usize,
    /// Maximum pending sends ledger-wide.
    pub max_pending_total: usize,
    /// A dispatched send with no confirmation older than this many seconds is
    /// reconciled to `unknown` by recovery (never to `failed`).
    pub unknown_after_seconds: u64,
}

impl Default for OutboundLimits {
    fn default() -> Self {
        Self {
            max_pieces_per_second_per_session: 5,
            max_pending_per_session: 8,
            max_pending_total: MAX_CONCURRENT_ATTEMPTS,
            unknown_after_seconds: 60,
        }
    }
}

/// Durable ledger retention bounds (deterministic, bounded resources).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LedgerBounds {
    /// Maximum inbound ledger entries; settled entries are evicted first.
    pub inbound_max_entries: usize,
    /// Maximum outbound ledger entries; settled entries are evicted first.
    pub outbound_max_entries: usize,
}

impl Default for LedgerBounds {
    fn default() -> Self {
        Self {
            inbound_max_entries: 4096,
            outbound_max_entries: 4096,
        }
    }
}

/// Edit/delete handling policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditDeletePolicy {
    /// Whether external edit and delete events are accepted. When disabled,
    /// such events are rejected before mutation.
    pub enabled: bool,
}

impl Default for EditDeletePolicy {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// The strict, revisioned Channel configuration document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelConfig {
    /// Config revision; every ledger entry captures the revision it was
    /// processed under (current-revision fencing).
    pub revision: i64,
    /// The Extension ID; a resolved record MUST equal `org.dolly.channel`.
    pub extension_id: String,
    /// The configured Module ID that outbound actions must target.
    pub module_id: String,
    /// Transport kind (`web`, `cli`, `test-harness`, ...).
    pub transport_kind: String,
    /// Transport account identity. The root of the deduplication namespace.
    pub transport_account: String,
    /// Whether external events are accepted at all.
    pub ingress_enabled: bool,
    /// Accepted input modalities: the frozen v1 default is exactly `{text}`;
    /// the WP-013B multimodal profile adds `asset`. The set gates asset
    /// parts fail-closed at the committed-Action boundary.
    pub accepted_modalities: BTreeSet<String>,
    /// Maximum text octets per inbound event text part.
    pub max_text_bytes: usize,
    /// Maximum parts per inbound event.
    pub max_parts: usize,
    /// Maximum outbound asset byte length one prepared Asset may carry
    /// (WP-013B media size bound).
    #[serde(default = "default_max_asset_bytes")]
    pub max_asset_bytes: usize,
    /// Session mapping policy for new conversations.
    pub session_mapping_policy: SessionMappingPolicy,
    /// If present, the only senders permitted to deliver inbound events.
    pub allowed_senders: Option<BTreeSet<String>>,
    /// If present, the only external conversations permitted.
    pub allowed_conversations: Option<BTreeSet<String>>,
    /// Outbound rate/concurrency bounds.
    pub outbound_limits: OutboundLimits,
    /// Durable ledger retention bounds.
    pub ledger_bounds: LedgerBounds,
    /// Edit/delete handling.
    pub edit_delete: EditDeletePolicy,
    /// Opaque reference to transport credentials, never materialized into
    /// drafts, ledger entries, or projections.
    pub secrets: Option<SecretRef>,
    /// Sender classes accepted for inbound delivery (for example `user`).
    pub allowed_sender_classes: BTreeSet<String>,
    /// The only Pages the Channel may target for committed inbound Blocks.
    pub target_page_ids: Vec<String>,
    /// Deadlines for `host.ingress.*` and outbound calls, relative seconds.
    pub operation_deadline_seconds: u64,
}

/// The default outbound asset byte bound (serde default for config documents
/// that predate the WP-013B profile).
fn default_max_asset_bytes() -> usize {
    MAX_ASSET_BYTES
}

impl ChannelConfig {
    /// Validate every field of a strictly deserialized configuration document.
    pub fn validate(mut self) -> Result<Self, ChannelError> {
        let invalid = |message: &str| {
            ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                message,
            )
        };
        if self.extension_id != EXTENSION_ID {
            return Err(invalid(&format!(
                "channel Extension ID must be {EXTENSION_ID}, got {}",
                self.extension_id
            )));
        }
        if self.revision < 0 {
            return Err(invalid("channel config revision must be non-negative"));
        }
        if self.module_id.is_empty() {
            return Err(invalid("channel config module_id must not be empty"));
        }
        if self.transport_account.is_empty() {
            return Err(invalid("channel config transport_account must not be empty"));
        }
        if self.transport_kind.is_empty() {
            return Err(invalid("channel config transport_kind must not be empty"));
        }
        if self.max_parts == 0 || self.max_parts > MAX_PARTS {
            return Err(invalid(&format!(
                "channel config max_parts must be in 1..={MAX_PARTS}, got {}",
                self.max_parts
            )));
        }
        if self.max_text_bytes == 0 || self.max_text_bytes > MAX_TEXT_BYTES {
            return Err(invalid(&format!(
                "channel config max_text_bytes must be in 1..={MAX_TEXT_BYTES}, got {}",
                self.max_text_bytes
            )));
        }
        if self.max_asset_bytes == 0 || self.max_asset_bytes > MAX_ASSET_BYTES {
            return Err(invalid(&format!(
                "channel config max_asset_bytes must be in 1..={MAX_ASSET_BYTES}, got {}",
                self.max_asset_bytes
            )));
        }
        // Modality policy: `text` is always required and the only optional
        // addition is `asset` (the WP-013B multimodal profile). The frozen
        // v1 default is exactly {text}; unknown modalities are rejected.
        // The accepted set gates asset parts fail-closed at the committed
        // Action boundary (never at Config time alone).
        let modalities = std::mem::take(&mut self.accepted_modalities);
        if !modalities.contains("text")
            || modalities
                .difference(&BTreeSet::from([
                    "text".to_string(),
                    "asset".to_string(),
                ]))
                .next()
                .is_some()
        {
            return Err(invalid(
                "channel accepted_modalities must contain {\"text\"} and may add only {\"asset\"}",
            ));
        }
        self.accepted_modalities = modalities;
        if let Some(senders) = &self.allowed_senders {
            if senders.is_empty() {
                return Err(invalid(
                    "channel config allowed_senders must not be empty when present",
                ));
            }
        }
        if let Some(conversations) = &self.allowed_conversations {
            if conversations.is_empty() {
                return Err(invalid(
                    "channel config allowed_conversations must not be empty when present",
                ));
            }
        }
        if self
            .allowed_sender_classes
            .iter()
            .any(|c| {
                c.is_empty()
                    || !c
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
        {
            return Err(invalid(
                "channel config allowed_sender_classes entries must be lower-case identifiers",
            ));
        }
        if self.target_page_ids.is_empty() || self.target_page_ids.len() > 256 {
            return Err(invalid(
                "channel config target_page_ids must contain 1..=256 pages",
            ));
        }
        if self.operation_deadline_seconds == 0 {
            return Err(invalid(
                "channel config operation_deadline_seconds must be positive",
            ));
        }
        Ok(self)
    }

    /// Hot-reload check: the new configuration must itself be valid. In-flight
    /// operations are not affected here; they retain their captured revision.
    /// An account change is allowed but starts a new deduplication namespace
    /// (keys embed the account), so old keys are never re-read under the new
    /// account.
    pub fn hot_reload(&self, candidate: Self) -> Result<Self, ChannelError> {
        let candidate = candidate.validate()?;
        if candidate.revision <= self.revision {
            return Err(ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                format!(
                    "hot reload must raise the config revision: {} -> {}",
                    self.revision, candidate.revision
                ),
            ));
        }
        Ok(candidate)
    }
}

/// A convenience builder for tests and static configurations.
#[derive(Debug, Clone)]
pub struct ChannelConfigBuilder {
    config: ChannelConfig,
}

impl Default for ChannelConfigBuilder {
    fn default() -> Self {
        Self::new("web", "account-a", "web-channel", 1)
    }
}

impl ChannelConfigBuilder {
    pub fn new(transport_kind: &str, account: &str, module_id: &str, revision: i64) -> Self {
        Self {
            config: ChannelConfig {
                revision,
                extension_id: EXTENSION_ID.to_string(),
                module_id: module_id.to_string(),
                transport_kind: transport_kind.to_string(),
                transport_account: account.to_string(),
                ingress_enabled: true,
                accepted_modalities: BTreeSet::from(["text".to_string()]),
                max_text_bytes: 64 * 1024,
                max_parts: MAX_PARTS,
                max_asset_bytes: MAX_ASSET_BYTES,
                session_mapping_policy: SessionMappingPolicy::CreateOnFirstMessage,
                allowed_senders: None,
                allowed_conversations: None,
                outbound_limits: OutboundLimits::default(),
                ledger_bounds: LedgerBounds::default(),
                edit_delete: EditDeletePolicy::default(),
                secrets: None,
                allowed_sender_classes: BTreeSet::from(["user".to_string()]),
                target_page_ids: vec!["user-input".to_string()],
                operation_deadline_seconds: 30,
            },
        }
    }

    pub fn revision(mut self, revision: i64) -> Self {
        self.config.revision = revision;
        self
    }

    pub fn account(mut self, account: &str) -> Self {
        self.config.transport_account = account.to_string();
        self
    }

    pub fn module_id(mut self, module_id: &str) -> Self {
        self.config.module_id = module_id.to_string();
        self
    }

    pub fn ingress_enabled(mut self, enabled: bool) -> Self {
        self.config.ingress_enabled = enabled;
        self
    }
    pub fn accepted_modalities(mut self, modalities: &[&str]) -> Self {
        self.config.accepted_modalities = modalities
            .iter()
            .map(|modality| modality.to_string())
            .collect::<BTreeSet<_>>();
        self
    }

    pub fn max_asset_bytes(mut self, bytes: usize) -> Self {
        self.config.max_asset_bytes = bytes;
        self
    }

    pub fn session_policy(mut self, policy: SessionMappingPolicy) -> Self {
        self.config.session_mapping_policy = policy;
        self
    }

    pub fn allowed_senders(mut self, senders: &[&str]) -> Self {
        self.config.allowed_senders =
            Some(senders.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>());
        self
    }

    pub fn allowed_conversations(mut self, conversations: &[&str]) -> Self {
        self.config.allowed_conversations = Some(
            conversations
                .iter()
                .map(|s| s.to_string())
                .collect::<BTreeSet<_>>(),
        );
        self
    }

    pub fn secrets(mut self, secret: Option<&str>) -> Self {
        self.config.secrets =
            secret.map(|s| SecretRef::from_string(s.to_string()).expect("valid secret ref"));
        self
    }

    pub fn unknown_after_seconds(mut self, seconds: u64) -> Self {
        self.config.outbound_limits.unknown_after_seconds = seconds;
        self
    }

    pub fn max_pending_per_session(mut self, n: usize) -> Self {
        self.config.outbound_limits.max_pending_per_session = n;
        self
    }

    pub fn max_pieces_per_second_per_session(mut self, n: u64) -> Self {
        self.config.outbound_limits.max_pieces_per_second_per_session = n;
        self
    }

    pub fn inbound_max_entries(mut self, n: usize) -> Self {
        self.config.ledger_bounds.inbound_max_entries = n;
        self
    }

    pub fn outbound_max_entries(mut self, n: usize) -> Self {
        self.config.ledger_bounds.outbound_max_entries = n;
        self
    }

    pub fn edit_delete(mut self, enabled: bool) -> Self {
        self.config.edit_delete.enabled = enabled;
        self
    }

    pub fn target_pages(mut self, pages: &[&str]) -> Self {
        self.config.target_page_ids = pages.iter().map(|s| s.to_string()).collect();
        self
    }

    pub fn operation_deadline_seconds(mut self, seconds: u64) -> Self {
        self.config.operation_deadline_seconds = seconds;
        self
    }

    pub fn build(self) -> ChannelConfig {
        self.config.validate().expect("builder always yields valid config")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_yields_valid_config() {
        let config = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1).build();
        assert_eq!(config.transport_account, "account-a");
        assert_eq!(config.revision, 1);
    }

    #[test]
    fn hot_reload_requires_higher_revision() {
        let a = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1).build();
        let b = ChannelConfigBuilder::new("web", "account-b", "web-channel", 2).build();
        let reloaded = a.hot_reload(b).unwrap();
        assert_eq!(reloaded.transport_account, "account-b");
        assert_eq!(reloaded.revision, 2);

        let stale = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1).build();
        assert!(a.hot_reload(stale).is_err());
    }

    #[test]
    fn unknown_modalities_rejected() {
        let mut config =
            ChannelConfigBuilder::new("web", "account-a", "web-channel", 1).build();
        config.accepted_modalities = BTreeSet::from(["asset".to_string()]);
        assert!(config.validate().is_err());
    }

    #[test]
    fn multimodal_modality_policy() {
        // The frozen v1 default is exactly {text}; the multimodal profile
        // adds {asset}; text is always required and unknown modalities are
        // rejected (build validates).
        assert_eq!(
            ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
                .build()
                .accepted_modalities,
            BTreeSet::from(["text".to_string()])
        );
        let multimodal = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
            .accepted_modalities(&["text", "asset"])
            .build();
        assert_eq!(
            multimodal.accepted_modalities,
            BTreeSet::from(["text".to_string(), "asset".to_string()])
        );
        // An unknown modality (outside {text, asset}) is rejected by
        // validation, even with text present.
        let builder = ChannelConfigBuilder::new("web", "account-a", "web-channel", 1);
        let mut unknown = builder.build();
        unknown.accepted_modalities = BTreeSet::from(["text".to_string(), "image".to_string()]);
        assert!(unknown.validate().is_err());
    }

    #[test]
    fn asset_byte_bound_has_default_and_range() {
        assert_eq!(
            ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
                .build()
                .max_asset_bytes,
            MAX_ASSET_BYTES
        );
        let mut too_small =
            ChannelConfigBuilder::new("web", "account-a", "web-channel", 1).build();
        too_small.max_asset_bytes = 0;
        assert!(too_small.validate().is_err());
        let mut too_large =
            ChannelConfigBuilder::new("web", "account-a", "web-channel", 1).build();
        too_large.max_asset_bytes = MAX_ASSET_BYTES + 1;
        assert!(too_large.validate().is_err());
        let bounded =
            ChannelConfigBuilder::new("web", "account-a", "web-channel", 1)
                .max_asset_bytes(100)
                .build();
        assert_eq!(bounded.max_asset_bytes, 100);
    }
}
