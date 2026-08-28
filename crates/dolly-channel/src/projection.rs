//! Content-free structured projections of Channel ledger state.
//!
//! Ledger projections are for observability only: they carry states, keys,
//! ordinals, and digests but NEVER message payload text, transport message
//! payloads, credentials, or secrets. `details` in a partial ActionResult
//! uses the same discipline: confirmed/failed/unknown piece ordinals, no
//! payload content.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::ledger::{AttemptRecord, InboundEntry, OutboundEntry, PieceOutcome};

/// A content-free inbound ledger row projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InboundProjection {
    pub transport_account: String,
    pub external_message_id: String,
    pub ingress_key: String,
    pub state: &'static str,
    pub event_kind: &'static str,
    pub block_id: Option<String>,
    pub config_revision: i64,
    pub attempt_count: usize,
}

/// A content-free outbound ledger row projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OutboundProjection {
    pub action_id: String,
    pub session_id: String,
    pub state: &'static str,
    pub config_revision: i64,
    pub piece_count: usize,
    pub confirmed_ordinals: Vec<u32>,
    pub failed_ordinals: Vec<u32>,
    pub unknown_ordinals: Vec<u32>,
    pub attempt_count: usize,
    /// Whether the entry supplies a transport idempotency key.
    pub idempotency_supported: bool,
}

impl InboundProjection {
    pub fn of(entry: &InboundEntry) -> Self {
        Self {
            transport_account: entry.transport_account.clone(),
            external_message_id: entry.external_message_id.clone(),
            ingress_key: entry.ingress_key.clone(),
            state: entry.state.as_str(),
            event_kind: entry.event_kind.as_str(),
            block_id: entry.block_id.clone(),
            config_revision: entry.config_revision,
            attempt_count: entry.attempts.len(),
        }
    }
}

impl OutboundProjection {
    pub fn of(entry: &OutboundEntry) -> Self {
        let mut confirmed = Vec::new();
        let mut failed = Vec::new();
        let mut unknown = Vec::new();
        for piece in &entry.pieces {
            match &piece.outcome {
                Some(PieceOutcome::Confirmed { .. }) => confirmed.push(piece.ordinal),
                Some(PieceOutcome::Rejected { .. }) => failed.push(piece.ordinal),
                Some(PieceOutcome::Unknown) | None => unknown.push(piece.ordinal),
            }
        }
        Self {
            action_id: entry.action_id.clone(),
            session_id: entry.session_id.clone(),
            state: entry.state.as_str(),
            config_revision: entry.config_revision,
            piece_count: entry.pieces.len(),
            confirmed_ordinals: confirmed,
            failed_ordinals: failed,
            unknown_ordinals: unknown,
            attempt_count: entry.attempts.len(),
            idempotency_supported: entry.idempotency_supported,
        }
    }
}

/// Render the exact attempt history in content-free form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttemptProjection {
    pub attempts: Vec<AttemptRecord>,
}

/// The whole ledger as a content-free observability snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LedgerSnapshotProjection {
    pub inbound: BTreeMap<String, InboundProjection>,
    pub outbound: BTreeMap<String, OutboundProjection>,
    pub session_count: usize,
}

pub fn inbound_projection_key(account: &str, external_message_id: &str) -> String {
    format!("{account}\0{external_message_id}")
}
