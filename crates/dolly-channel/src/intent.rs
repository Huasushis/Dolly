//! Durable per-event Channel intent — the sole per-event state machine.
//!
//! One already-authenticated event becomes a `prepared` intent row in
//! module-scoped SQLite BEFORE any `HostIngress::submit` or Core effect. The
//! row is the single crash/recovery anchor and the single deduplication
//! source of truth: it binds the principal-derived account, the granted
//! Extension/Module and worker epoch, the lifecycle kind and edit/delete
//! relation, the ordered target Pages, the content digest, and the complete
//! authority fences (generation, incarnation revision, graph revision, config
//! revision) to one canonical, digest-guarded record.
//!
//! Lifecycle (one source of truth):
//! - `Prepared`: durably recorded before any Host submit; the Host outcome is
//!   unknown. A crash, lost response, or failed final transaction here must
//!   stay `Prepared` so `reconcile()` (no event redelivery) can status-first
//!   restore the terminal state exactly once.
//! - `Accepted`: the Host mapping committed; the final Channel ledger row and
//!   the terminal intent are written in ONE Channel DB transaction.
//! - `Rejected`: durably rejected before or by the Host; nothing resubmits.

use dolly_canonical_json::canonicalize;
use serde::{Deserialize, Serialize};

use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ledger::EventKind;

/// The closed record discriminator of one Channel intent.
pub(crate) const CHANNEL_INTENT_RECORD_SCHEMA: &str = "dolly.channel-intent/v1";

/// The lifecycle of one Channel intent (the sole per-event state machine).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentState {
    /// Durably recorded before any Host submit; the Host outcome is unknown.
    Prepared,
    /// The Host mapping committed and the final ledger row landed atomically.
    Accepted,
    /// Durably rejected; nothing resubmits.
    Rejected,
}

impl IntentState {
    #[allow(dead_code)]
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            IntentState::Prepared => "prepared",
            IntentState::Accepted => "accepted",
            IntentState::Rejected => "rejected",
        }
    }

    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, IntentState::Accepted | IntentState::Rejected)
    }
}

/// One canonical, principal-bound intent record — the sole durable per-event
/// state. Fields are authority-bound (derived from the sealed current Host
/// authority/grant) plus caller-supplied event content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelIntent {
    pub schema: String,
    /// The principal-bound account-scoped ingress key (dedup namespace).
    pub intent_key: String,
    /// The Channel-local operation digest binding every field below
    /// (including the ordered target Pages and the complete authority fences).
    pub digest: String,
    pub state: IntentState,
    pub owner: String,
    pub extension_id: String,
    pub module_id: String,
    pub instance_id: String,
    pub generation: i64,
    pub revision: i64,
    pub graph_revision: i64,
    pub graph_digest: String,
    pub config_revision: i64,
    pub account: String,
    pub external_event_id: String,
    /// Transport-sourced content facts preserved for the lossless ChannelLedger
    /// projection (real conversation/session/channel/sender/time).
    pub channel_id: String,
    pub transport: String,
    pub external_conversation_id: String,
    pub sender_class: String,
    pub received_at: String,
    pub kind: EventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references_external_event_id: Option<String>,
    /// The ordered target Pages; order is part of the identity.
    pub target_page_ids: Vec<String>,
    /// Digest of the canonical draft bytes.
    pub payload_digest: String,
    /// The canonical draft (the byte-identical replay unit).
    pub request_jcs: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejected_code: Option<String>,
}

impl ChannelIntent {
    /// The canonical JSON text of the full record (including its current
    /// lifecycle state), used as the tamper-guarded storage encoding.
    pub fn canonical_string(&self) -> Result<String, ChannelError> {
        canonicalize(self)
            .map(|(bytes, _)| {
                String::from_utf8(bytes.as_bytes().to_vec()).expect("canonical encoding is UTF-8")
            })
            .map_err(|error| {
                ChannelError::new(
                    codes::INTERNAL,
                    false,
                    ChannelOutcome::NotApplied,
                    format!("channel intent failed canonicalization: {error}"),
                )
            })
    }

    /// Rebuild an intent from its canonical encoding; any structural
    /// violation fails closed.
    pub fn from_canonical_string(text: &str) -> Result<Self, ChannelError> {
        let record: ChannelIntent = serde_json::from_str(text).map_err(|error| {
            ChannelError::new(
                codes::LEDGER_CORRUPT,
                false,
                ChannelOutcome::NotApplied,
                format!("channel intent is not a canonical record: {error}"),
            )
        })?;
        if record.schema != CHANNEL_INTENT_RECORD_SCHEMA {
            return Err(ChannelError::new(
                codes::LEDGER_CORRUPT,
                false,
                ChannelOutcome::NotApplied,
                "channel intent record discriminator mismatch",
            ));
        }
        Ok(record)
    }
}
