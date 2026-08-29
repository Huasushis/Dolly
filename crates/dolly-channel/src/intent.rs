//! Durable per-event Channel intent records (the pre-effect ledger).
//!
//! One already-authenticated event becomes a `prepared` intent row in
//! module-scoped SQLite BEFORE any `HostIngress::submit` or Core effect. The
//! row is the crash/recovery anchor: it binds the principal-derived account,
//! the granted Extension/Module and worker epoch, the lifecycle kind and
//! edit/delete relation, the ordered target Pages, the content digest, and
//! the complete authority fences (generation, incarnation revision, graph
//! revision, config revision) to one canonical, digest-guarded record. A
//! crash or lost response after a Host commit reopens this row, asks `status`
//! first, and converges without a duplicate effect or a false success.
//!
//! The record shape mirrors the accepted ledger types but is deliberately
//! per-event and principal-bound: never an authority model, only durable
//! intent plus its terminal outcome.

use dolly_canonical_json::canonicalize;
use serde::{Deserialize, Serialize};

use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ledger::EventKind;

/// The closed record discriminator of one Channel intent.
pub const CHANNEL_INTENT_RECORD_SCHEMA: &str = "dolly.channel-intent/v1";

/// The lifecycle of a prepared Channel intent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentState {
    /// The intent is durably recorded; the Host effect outcome is unknown
    /// (not yet submitted, or the response was lost). Always reconciled
    /// through `status` first.
    Prepared,
    /// The Host mapping is committed and the block identity is known.
    Accepted,
    /// The intent was durably rejected; nothing will be submitted again.
    Rejected,
}

impl IntentState {
    pub fn as_str(self) -> &'static str {
        match self {
            IntentState::Prepared => "prepared",
            IntentState::Accepted => "accepted",
            IntentState::Rejected => "rejected",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, IntentState::Accepted | IntentState::Rejected)
    }
}

/// One canonical, principal-bound intent record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelIntent {
    pub schema: String,
    /// The principal-bound account-scoped ingress key (dedup namespace).
    pub intent_key: String,
    /// The Channel-local operation digest binding every field below
    /// (including the ordered target Pages).
    pub digest: String,
    pub state: IntentState,
    pub owner: String,
    pub extension_id: String,
    pub module_id: String,
    pub instance_id: String,
    pub generation: i64,
    pub revision: i64,
    pub graph_revision: i64,
    pub config_revision: i64,
    pub account: String,
    pub external_event_id: String,
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
