//! Durable dispatch-boundary recovery (spec §6, REQ-TOOL-002/REQ-TOOL-006,
//! TST-TOOL-001/002/006).
//!
//! The pure-core decision for a persisted Tool-call row after a crash or a
//! lost authoritative result. It operates only on the durable journal form of
//! the row, never on a downstream ACK/result/error/absence and never through
//! a backend or transport seam, so:
//!   - a row that durably crossed the `DISPATCHED` marker and lost its
//!     authoritative result recovers to terminal `UNKNOWN` /
//!     `TOOL_EXTERNAL_OUTCOME_UNKNOWN` for every v1 side-effect class, with
//!     `automatic_redispatch_count = 0` and an unchanged
//!     `server_effect_count` (REQ-TOOL-002);
//!   - a crash before the durable dispatch marker with authoritative
//!     zero-byte proof terminates `FAILED` / `TOOL_DISPATCH_NOT_APPLIED`
//!     (`not_applied`); any ambiguity is `UNKNOWN` (REQ-TOOL-006).
//!
//! The decision is a pure function of the row, so re-opening the same journal
//! bytes after a restart re-derives the identical disposition.

use dolly_canonical_json::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::result::ToolErrorCode;
use crate::result::ToolResult;

/// Durable Tool-call ledger states (spec §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum LedgerState {
    Authorized,
    Dispatched,
    Succeeded,
    Failed,
    Unknown,
}

impl LedgerState {
    /// Whether the row has durably crossed the dispatch boundary.
    pub fn crossed_dispatch_boundary(self) -> bool {
        matches!(self, LedgerState::Dispatched)
    }
}

/// The event published when a dispatch fact cannot be resolved.
pub const EVENT_TOOL_OUTCOME_UNKNOWN: &str = "ToolOutcomeUnknown";
/// The event published when zero-byte non-application is authoritatively
/// proved (TST-TOOL-006).
pub const EVENT_TOOL_DISPATCH_PROVED_NOT_APPLIED: &str = "ToolDispatchProvedNotApplied";

/// The durable journal form of a Tool-call row. Serializing these bytes IS
/// the durable dispatch journal; the Host persists them atomically with each
/// transition and re-reads them after restart. Purely a snapshot: no method
/// on it mutates the row or re-dispatches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DurableDispatchRow {
    /// Original invoke operation identity (unchanged across the lifecycle).
    pub operation_id: String,
    /// Pre-resolution identity digest (REQ-TOOL-005), frozen at acceptance.
    pub request_digest: Sha256Digest,
    /// Stage-2 binding digest, frozen at acceptance.
    pub operation_digest: Sha256Digest,
    /// The exactly selected, retained server generation.
    pub tool_server_generation: u64,
    /// Durable ledger state.
    pub ledger_state: LedgerState,
    /// Bytes made eligible for transmission (transport fence input).
    pub transport_eligible_byte_count: u64,
    /// Bytes actually sent (transport fence input).
    pub transport_sent_byte_count: u64,
    /// Server-side effect counter maintained by the Host; the recovery
    /// decision never increments it (no re-dispatch, no status probe).
    pub server_effect_count: u64,
    /// A durable recorded result, if any (terminal rows carry one).
    pub result: Option<ToolResult>,
}

impl DurableDispatchRow {
    /// The durable server-effect counter is part of the row and is never
    /// changed by the recovery decision (the decision has no dispatch seam).
    pub fn server_effect_count(&self) -> u64 {
        self.server_effect_count
    }

    /// Authoritative zero-byte proof: no request byte was eligible or sent.
    pub fn zero_bytes_proved(&self) -> bool {
        self.transport_eligible_byte_count == 0 && self.transport_sent_byte_count == 0
    }
}

/// The recovery decision for a durable Tool-call row.
///
/// Every variant is terminal: none of them can re-dispatch, re-resolve, or
/// re-authorize the same identity. Re-authorization after `not_applied` is a
/// separately authorized fresh operation outside this crate's boundary.
#[derive(Debug, Clone, PartialEq)]
pub enum DispatchDisposition {
    /// The row already records a terminal result; replay it verbatim.
    AlreadyTerminal { result: ToolResult },
    /// Authoritative zero-byte non-application: FAILED /
    /// TOOL_DISPATCH_NOT_APPLIED. The row identity and digests are kept.
    ProvedNotApplied { result: ToolResult },
    /// The durable dispatch boundary may have been crossed (DISPATCHED, or
    /// an AUTHORIZED row without zero-byte proof): UNKNOWN /
    /// TOOL_EXTERNAL_OUTCOME_UNKNOWN. Never relabeled failed.
    Unknown { result: ToolResult },
}

impl DispatchDisposition {
    /// Spec §6/REQ-TOOL-002: recovery never automatically redispatches the
    /// original operation, so this is always `0` for every disposition.
    pub fn automatic_redispatch_count(&self) -> u64 {
        0
    }

    /// REQ-TOOL-006 / TST-TOOL-006: a proved non-application never lets a
    /// replacement generation dispatch under this identity.
    pub fn automatic_replacement_generation_dispatch_count(&self) -> u64 {
        0
    }

    /// The emitted event name, if the disposition publishes one
    /// (TST-TOOL-001/002 emit `ToolOutcomeUnknown`; TST-TOOL-006 emits
    /// `ToolDispatchProvedNotApplied`; AlreadyTerminal replays the recorded
    /// result and emits nothing new).
    pub fn emitted_event(&self) -> Option<&'static str> {
        match self {
            DispatchDisposition::AlreadyTerminal { .. } => None,
            DispatchDisposition::ProvedNotApplied { .. } => {
                Some(EVENT_TOOL_DISPATCH_PROVED_NOT_APPLIED)
            }
            DispatchDisposition::Unknown { .. } => Some(EVENT_TOOL_OUTCOME_UNKNOWN),
        }
    }

    /// The terminal result carried by the disposition.
    pub fn into_result(self) -> ToolResult {
        match self {
            DispatchDisposition::AlreadyTerminal { result }
            | DispatchDisposition::ProvedNotApplied { result }
            | DispatchDisposition::Unknown { result } => result,
        }
    }
}

/// Recover a durable Tool-call row to its terminal disposition.
///
/// The row is the durable journal form; this function never consults a
/// downstream result, error, ACK, or absence, and has no backend/transport
/// seam, so no downstream fact can become upstream redispatch authority.
///
/// Decision table:
///   - `result` present                → AlreadyTerminal (verbatim replay);
///   - `Dispatched`                    → Unknown (durable marker crossed,
///                                        no proof of non-application);
///   - `Authorized` + zero-byte proof  → ProvedNotApplied (REQ-TOOL-006);
///   - `Authorized` without the proof  → Unknown (ambiguity);
///   - other terminal marker w/o result→ Unknown (defensive; the durable
///                                        fact survives, nothing redispatched).
pub fn recover_operation(row: &DurableDispatchRow) -> DispatchDisposition {
    if let Some(result) = &row.result {
        return DispatchDisposition::AlreadyTerminal {
            result: result.clone(),
        };
    }
    match row.ledger_state {
        LedgerState::Dispatched => DispatchDisposition::Unknown {
            result: ToolResult::unknown_outcome(row.operation_id.clone()),
        },
        LedgerState::Authorized => {
            if row.zero_bytes_proved() {
                DispatchDisposition::ProvedNotApplied {
                    result: ToolResult::failed(
                        row.operation_id.clone(),
                        ToolErrorCode::DispatchNotApplied,
                        "durable zero-byte proof: no request byte was eligible or sent before the dispatch boundary",
                    ),
                }
            } else {
                DispatchDisposition::Unknown {
                    result: ToolResult::unknown_outcome(row.operation_id.clone()),
                }
            }
        }
        // Terminal markers without a recorded result are inconsistent with a
        // well-formed journal; recover conservatively to UNKNOWN rather than
        // invent a failed/not_applied fact that could read as authority.
        LedgerState::Succeeded | LedgerState::Failed | LedgerState::Unknown => {
            DispatchDisposition::Unknown {
                result: ToolResult::unknown_outcome(row.operation_id.clone()),
            }
        }
    }
}
