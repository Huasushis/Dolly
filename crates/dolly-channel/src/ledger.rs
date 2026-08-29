//! Durable Channel ledger model.
//!
//! The Channel owns three pieces of durable state (Channel specification
//! section 3): the `SessionMap`, the `InboundLedger`, and the `OutboundLedger`
//! plus its echoed-transport-ID suppression set. This module defines the
//! exact records, the closed state machines, deterministic bounds, and a
//! self-contained in-memory [`ChannelLedger`] that serializes to canonical
//! JSON so stop/restart behavior is testable without a storage engine. The
//! production storage engine implements the same record shapes in the
//! Module's scoped storage; this crate never assumes a storage engine.
//!
//! Every ledger key embeds the transport account, so reusing an external ID
//! in another account never collides and an account change starts a fresh
//! deduplication namespace.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::error::{ChannelError, ChannelOutcome, codes};

/// One recorded attempt in the exact attempt history of an inbound or
/// outbound operation. Payload content is never stored here; only a digest of
/// the exact context, so history is preserved without retaining secret or
/// message material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttemptRecord {
    /// Wall-clock instant of the attempt (injected clock).
    pub at: String,
    /// Closed attempt kind: `submit`, `replay`, `dispatch`, `reconcile`,
    /// `recover`, `prepare`.
    pub kind: String,
    /// SHA-256 hex digest over the exact attempt context; no payload.
    pub detail_digest: String,
}

// ---------------------------------------------------------------------------
// Inbound ledger
// ---------------------------------------------------------------------------

/// Inbound ledger states (text modality; `assets_pending` is a WP-013B
/// extension and is not reachable in v1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboundState {
    Received,
    Submitted,
    Accepted,
    Rejected,
}

impl InboundState {
    pub fn as_str(self) -> &'static str {
        match self {
            InboundState::Received => "received",
            InboundState::Submitted => "submitted",
            InboundState::Accepted => "accepted",
            InboundState::Rejected => "rejected",
        }
    }

    /// Whether a later identical event may replay the prior outcome.
    pub fn is_terminal(self) -> bool {
        matches!(self, InboundState::Accepted | InboundState::Rejected)
    }
}

/// The kind of an external event. Edits and deletions are always new
/// immutable events referencing the original external message; they never
/// mutate an accepted Block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Message,
    Edit,
    Delete,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::Message => "message",
            EventKind::Edit => "edit",
            EventKind::Delete => "delete",
        }
    }
}

/// One durable inbound ledger row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboundEntry {
    pub transport_account: String,
    pub external_message_id: String,
    /// For edit/delete events: the referenced original external message ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references_external_message_id: Option<String>,
    pub state: InboundState,
    pub event_kind: EventKind,
    pub session_id: String,
    pub external_conversation_id: String,
    pub channel_id: String,
    pub sender_class: String,
    pub received_at: String,
    /// Stable account-scoped ingress key and operation digest.
    pub ingress_key: String,
    pub operation_digest: String,
    /// The Core-minted Block ID returned from the durable premise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    pub pages: Vec<String>,
    /// Config revision under which this event was authorized.
    pub config_revision: i64,
    /// Exact attempt history.
    pub attempts: Vec<AttemptRecord>,
    /// Canonical JSON bytes of the byte-identical draft replay request.
    pub request_jcs: String,
    /// Terminal rejection code, present only when `state == Rejected`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejected_code: Option<String>,
}

// ---------------------------------------------------------------------------
// Outbound ledger
// ---------------------------------------------------------------------------

/// Outbound ledger states. `confirmed`, `partial`, `failed`, and `unknown`
/// are terminal; `prepared`, `queued`, and `dispatched` are recoverable crash
/// states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboundState {
    Prepared,
    Queued,
    Dispatched,
    Confirmed,
    Partial,
    Failed,
    Unknown,
}

impl OutboundState {
    pub fn as_str(self) -> &'static str {
        match self {
            OutboundState::Prepared => "prepared",
            OutboundState::Queued => "queued",
            OutboundState::Dispatched => "dispatched",
            OutboundState::Confirmed => "confirmed",
            OutboundState::Partial => "partial",
            OutboundState::Failed => "failed",
            OutboundState::Unknown => "unknown",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            OutboundState::Confirmed
                | OutboundState::Partial
                | OutboundState::Failed
                | OutboundState::Unknown
        )
    }

    /// The two non-terminal states that may be CAS-claimed for dispatch:
    /// `prepared` (not yet queued) and `queued` (admitted to the shared
    /// queue, awaiting the dispatch CAS winner).
    pub fn is_dispatchable(self) -> bool {
        matches!(self, OutboundState::Prepared | OutboundState::Queued)
    }
}

/// The outcome of one outbound piece.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PieceOutcome {
    Confirmed {
        transport_message_id: String,
    },
    Rejected {
        code: String,
    },
    Unknown,
}

impl PieceOutcome {
    pub fn label(&self) -> &'static str {
        match self {
            PieceOutcome::Confirmed { .. } => "confirmed",
            PieceOutcome::Rejected { .. } => "failed",
            PieceOutcome::Unknown => "unknown",
        }
    }
}

/// One piece of an outbound send: its ordinal, text payload (used only for
/// dispatch), the resulting transport message ID, and its outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboundPiece {
    pub ordinal: u32,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<PieceOutcome>,
}

/// One durable outbound ledger row, keyed by `action_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboundEntry {
    pub action_id: String,
    pub session_id: String,
    pub config_revision: i64,
    pub state: OutboundState,
    pub pieces: Vec<OutboundPiece>,
    pub idempotency_supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub attempts: Vec<AttemptRecord>,
    /// Wall-clock time of dispatch (for unknown-after recovery).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatched_at: Option<String>,
    /// Frozen `ActionResult` canonical bytes for terminal entries; a
    /// confirmed replay MUST return the existing result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_jcs: Option<String>,
    /// Durable FIFO sequence assigned when the row is admitted to the
    /// outbound queue (`Prepared` -> `Queued`). The queue is reconstructed
    /// from nonterminal rows in this order after restart; no caller-visible
    /// sequence exists before admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_seq: Option<i64>,
}

// ---------------------------------------------------------------------------
// ChannelLedger
// ---------------------------------------------------------------------------

/// The self-contained Channel durable state.
///
/// Keys are `(transport_account, external_message_id)` for inbound rows,
/// `action_id` for outbound rows, and `(transport_account,
/// external_conversation_id)` for the session map. The echoed-ID set records
/// transport message IDs of confirmed outbound pieces so a transport echo is
/// suppressed by the inbound path.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChannelLedger {
    /// Keyed by [`inbound_key`] = `account NUL external_message_id`.
    pub inbound: BTreeMap<String, InboundEntry>,
    pub outbound: BTreeMap<String, OutboundEntry>,
    /// Keyed by `account NUL external_conversation_id`.
    pub sessions: BTreeMap<String, String>,
    /// Keyed by `account NUL transport_message_id`.
    pub echoed_message_ids: BTreeSet<String>,
}

/// Composite account-scoped inbound key. The account is part of the key, so
/// reusing an external ID in another account can never collide.
pub fn inbound_key(account: &str, external_message_id: &str) -> String {
    format!("{account}\u{0}{external_message_id}")
}

fn session_key(account: &str, conversation: &str) -> String {
    format!("{account}\u{0}{conversation}")
}

fn echo_key(account: &str, message_id: &str) -> String {
    format!("{account}\u{0}{message_id}")
}

impl ChannelLedger {
    pub fn new() -> Self {
        Self::default()
    }

    // -- inbound -----------------------------------------------------------

    pub fn inbound_entry(&self, account: &str, external_message_id: &str) -> Option<&InboundEntry> {
        self.inbound.get(&inbound_key(account, external_message_id))
    }

    pub fn inbound_get_mut(
        &mut self,
        account: &str,
        external_message_id: &str,
    ) -> Option<&mut InboundEntry> {
        self.inbound.get_mut(&inbound_key(account, external_message_id))
    }

    /// Insert an inbound entry under account-scoped deterministic bounds:
    /// terminal entries are evicted oldest-first before accepting an insert;
    /// if nothing can be freed the insert fails closed with
    /// `CHANNEL_LEDGER_FULL`.
    pub fn insert_inbound(&mut self, entry: InboundEntry, max_entries: usize) -> Result<(), ChannelError> {
        let key = inbound_key(&entry.transport_account, &entry.external_message_id);
        if self.inbound.contains_key(&key) {
            self.inbound.insert(key, entry);
            return Ok(());
        }
        if self.inbound.len() < max_entries {
            self.inbound.insert(key, entry);
            return Ok(());
        }
        // Deterministic oldest-settled-first eviction.
        let mut settled: Vec<(String, String)> = self
            .inbound
            .iter()
            .filter(|(_, e)| e.state.is_terminal())
            .map(|(k, e)| (k.clone(), e.received_at.clone()))
            .collect();
        settled.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        if settled.is_empty() {
            return Err(ChannelError::new(
                codes::LEDGER_FULL,
                false,
                ChannelOutcome::NotApplied,
                "inbound ledger is at capacity and no settled entries are evictable",
            ));
        }
        let (evict_key, _) = settled.remove(0);
        self.inbound.remove(&evict_key);
        self.inbound.insert(key, entry);
        Ok(())
    }

    // -- outbound ----------------------------------------------------------

    pub fn outbound_entry(&self, action_id: &str) -> Option<&OutboundEntry> {
        self.outbound.get(action_id)
    }

    pub fn insert_outbound(&mut self, entry: OutboundEntry, max_entries: usize) -> Result<(), ChannelError> {
        let action_id = entry.action_id.clone();
        if self.outbound.contains_key(&action_id) {
            self.outbound.insert(action_id, entry);
            return Ok(());
        }
        if self.outbound.len() < max_entries {
            self.outbound.insert(action_id, entry);
            return Ok(());
        }
        let mut settled: Vec<(String, String)> = self
            .outbound
            .iter()
            .filter(|(_, e)| e.state.is_terminal())
            .map(|(k, e)| {
                let at = e
                    .attempts
                    .first()
                    .map(|a| a.at.clone())
                    .unwrap_or_default();
                (k.clone(), at)
            })
            .collect();
        settled.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        if settled.is_empty() {
            return Err(ChannelError::new(
                codes::LEDGER_FULL,
                false,
                ChannelOutcome::NotApplied,
                "outbound ledger is at capacity and no settled entries are evictable",
            ));
        }
        let (evict_key, _) = settled.remove(0);
        self.outbound.remove(&evict_key);
        self.outbound.insert(action_id, entry);
        Ok(())
    }

    // -- sessions ----------------------------------------------------------

    pub fn session(&self, account: &str, conversation_id: &str) -> Option<&String> {
        self.sessions.get(&session_key(account, conversation_id))
    }

    pub fn insert_session(&mut self, account: &str, conversation_id: &str, session_id: &str) {
        self.sessions
            .insert(session_key(account, conversation_id), session_id.to_string());
    }

    // -- echo suppression --------------------------------------------------

    pub fn record_echoed(&mut self, account: &str, transport_message_id: &str) {
        self.echoed_message_ids
            .insert(echo_key(account, transport_message_id));
    }

    pub fn is_echo(&self, account: &str, external_message_id: &str) -> bool {
        self.echoed_message_ids.contains(&echo_key(account, external_message_id))
    }
}

/// Serialize the whole ledger deterministically (for durability simulation).
///
/// This is the Module scoped-state encoding, not the Core canonical-JSON
/// profile: object keys are plain strings (tuple ledger keys serialize as
/// `(account, id)` strings), and ordering is deterministic because struct
/// fields serialize in declaration order and `BTreeMap` iteration is sorted.
pub fn ledger_to_json_string(ledger: &ChannelLedger) -> Result<String, ChannelError> {
    serde_json::to_string(ledger).map_err(|e| {
        ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::NotApplied,
            format!("failed to serialize channel ledger: {e}"),
        )
    })
}

/// Rebuild a ledger from its deterministic JSON encoding; any structural
/// violation fails closed. Pending (`received`/`submitted` inbound,
/// `prepared`/`dispatched`
/// outbound) rows survive verbatim, which is what stop/restart recovery
/// requires.
pub fn ledger_from_json_string(json: &str) -> Result<ChannelLedger, ChannelError> {
    serde_json::from_str(json).map_err(|e| {
        ChannelError::new(
            codes::INTERNAL,
            false,
            ChannelOutcome::NotApplied,
            format!("channel ledger restore failed: {e}"),
        )
    })
}
