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
    /// Accepted input modalities; v1 accepts only `text`.
    pub accepted_modalities: BTreeSet<String>,
    /// Maximum text octets per inbound event text part.
    pub max_text_bytes: usize,
    /// Maximum parts per inbound event.
    pub max_parts: usize,
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
        // Lock v1 modality set to exactly {text}; asset ground is a WP-013B
        // capability and is rejected before dispatch.
        let modalities = std::mem::take(&mut self.accepted_modalities);
        if modalities != BTreeSet::from(["text".to_string()]) {
            return Err(invalid(
                "channel v1 accepted_modalities must be exactly {\"text\"}",
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
}
