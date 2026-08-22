//! Dispatch orchestration (tool-broker §6, REQ-TOOL-002/006,
//! INV-STORAGE-017).
//!
//! `dispatch_operation` is the single orchestration primitive over one
//! nonterminal ledger row: it runs the pure decision [`recover_operation`],
//! then applies ONE disposition through the authoritative storage
//! compare-and-set. A [`SendPermit`] is released only after an unambiguous
//! `CasOutcome::Committed` of the `AUTHORIZED -> DISPATCHED` transition with
//! `allow_send_permit` true. A stale, busy, full, corrupt,
//! lost-acknowledgement, or unknown observation never releases a permit.
//!
//! This crate owns no transport, Host, or network: the only outside inputs
//! are the verified `RecoveryFacts` and the storage database.

use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_storage::tool_broker_authority::{
    ToolBrokerAuthorityError, ToolDispatchAuthority, validate_dispatch_binding,
};
use dolly_storage::tool_ledger::{CasKey, TransportCorrelation, cas_terminal, cas_to_dispatched};
use dolly_storage::{Database, StorageError};
use dolly_tool_broker::{
    DispatchDisposition, LedgerState, RecoveryFacts, ToolCallLedgerRecord, ToolResult,
    recover_operation,
};

use crate::permit::SendPermit;

/// Orchestration failure. No variant ever releases a send permit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchError {
    /// The supplied record is not a closed nonterminal row consistent with
    /// the requested disposition (caller bug); nothing was mutated.
    InvalidRecord,
    /// The row did not name the exact registry/generation that produced the
    /// dispatch permission; nothing was mutated.
    Authority(ToolBrokerAuthorityError),
    /// The row could not be settled within the bounded pure re-decisions.
    /// No permit.
    Ambiguous,
    /// Storage failure (`STORAGE_*`), including corruption and lost commit
    /// acknowledgements surfaced as errors. No permit.
    Storage(StorageError),
}

impl From<ToolBrokerAuthorityError> for DispatchError {
    fn from(error: ToolBrokerAuthorityError) -> Self {
        Self::Authority(error)
    }
}

/// The outcome of [`dispatch_operation`] for one applied transition.
#[derive(Debug)]
pub enum DispatchOutcome {
    /// The `AUTHORIZED -> DISPATCHED` transition committed durably; the
    /// returned row is `DISPATCHED`. `permit` is `Some` only when the pure
    /// decision allowed a send permit AND the CAS returned unambiguous
    /// `Committed`. The no-proof chain commits `DISPATCHED` with `permit:
    /// None`; the caller re-decides that row toward `UNKNOWN`.
    Dispatched {
        record: ToolCallLedgerRecord,
        permit: Option<SendPermit>,
    },
    /// A terminal transition committed (`AUTHORIZED -> FAILED`
    /// `TOOL_DISPATCH_NOT_APPLIED`, or `DISPATCHED -> UNKNOWN`). No permit.
    Terminalized { record: ToolCallLedgerRecord },
    /// The row was already terminal; no mutation, no permit.
    Unchanged { record: ToolCallLedgerRecord },
    /// The compare-and-set found a different revision/state: nothing changed
    /// and no permit was released. The caller reruns the pure decision on
    /// the authoritative row (tool-broker §6: a stale proposal is discarded
    /// and the decision is rerun on the new row).
    Stale { authoritative: ToolCallLedgerRecord },
}

/// Orchestrate one transition of a nonterminal operation (tool-broker §6).
///
/// The disposition is decided purely from the closed row and the injected
/// facts, then applied by compare-and-set against the exact
/// `(module_id, operation_id, ledger_revision, state)` of the row. No
/// downstream ACK/result/error/absence is consulted.
pub fn dispatch_operation(
    db: &mut Database,
    row: &ToolCallLedgerRecord,
    facts: &RecoveryFacts,
) -> Result<DispatchOutcome, DispatchError> {
    let proposal = match recover_operation(row, facts) {
        DispatchDisposition::AlreadyTerminal { .. } => {
            return Ok(DispatchOutcome::Unchanged {
                record: row.clone(),
            });
        }
        DispatchDisposition::ProposeDispatch {
            outbound_digest,
            allow_send_permit,
        } => Proposal::Dispatch {
            outbound_digest,
            allow_send_permit,
        },
        DispatchDisposition::ProvedNotApplied { result } => Proposal::FailedNotApplied { result },
        DispatchDisposition::Unknown { result } => Proposal::Unknown { result },
    };
    match apply_proposal(db, row, proposal)? {
        Applied::Committed { record, permit } => {
            if record.state.is_terminal() {
                Ok(DispatchOutcome::Terminalized { record })
            } else {
                // Committed non-terminal: the dispatch boundary.
                Ok(DispatchOutcome::Dispatched { record, permit })
            }
        }
        Applied::Stale { authoritative } => {
            if authoritative.state.is_terminal() {
                Ok(DispatchOutcome::Unchanged {
                    record: authoritative,
                })
            } else {
                Ok(DispatchOutcome::Stale { authoritative })
            }
        }
    }
}
/// Authoritative dispatch entry point. The storage producer must first issue
/// `ToolDispatchAuthority`; a binding mismatch is rejected before the existing
/// compare-and-set or any send permit can be reached.
pub fn dispatch_operation_authorized(
    db: &mut Database,
    authority: &ToolDispatchAuthority,
    row: &ToolCallLedgerRecord,
    facts: &RecoveryFacts,
) -> Result<DispatchOutcome, DispatchError> {
    validate_dispatch_binding(
        authority,
        row.operation_binding.config_revision as i64,
        &row.operation_binding.tool_server_id,
        row.operation_binding.tool_server_generation,
    )?;
    dispatch_operation(db, row, facts)
}

/// One pure-decision proposal to apply.
enum Proposal {
    Dispatch {
        outbound_digest: Sha256Digest,
        allow_send_permit: bool,
    },
    FailedNotApplied {
        result: ToolResult,
    },
    Unknown {
        result: ToolResult,
    },
}

enum Applied {
    /// One transition committed with the authoritative new record; `permit`
    /// exists only for a permit-enabled dispatch commit.
    Committed {
        record: ToolCallLedgerRecord,
        permit: Option<SendPermit>,
    },
    /// Compare-and-set did not match; nothing was mutated.
    Stale { authoritative: ToolCallLedgerRecord },
}

fn apply_proposal(
    db: &mut Database,
    current: &ToolCallLedgerRecord,
    proposal: Proposal,
) -> Result<Applied, DispatchError> {
    match proposal {
        Proposal::Dispatch {
            outbound_digest,
            allow_send_permit,
        } => {
            if current.state != LedgerState::Authorized || current.ledger_revision != 1 {
                return Err(DispatchError::InvalidRecord);
            }
            if current.outbound_digest.is_some() {
                return Err(DispatchError::InvalidRecord);
            }
            let dispatched = ToolCallLedgerRecord {
                ledger_revision: 2,
                state: LedgerState::Dispatched,
                outbound_digest: Some(outbound_digest),
                terminal_result: None,
                terminal_result_digest: None,
                ..current.clone()
            };
            match cas_to_dispatched(db.connection_mut(), &key_of(current), &dispatched) {
                Ok(dolly_storage::tool_ledger::CasOutcome::Committed { record }) => {
                    let permit = if allow_send_permit {
                        Some(SendPermit::from_committed(&record))
                    } else {
                        None
                    };
                    Ok(Applied::Committed { record, permit })
                }
                Ok(dolly_storage::tool_ledger::CasOutcome::Stale { authoritative }) => {
                    Ok(Applied::Stale { authoritative })
                }
                Err(error) => Err(DispatchError::Storage(error)),
            }
        }
        Proposal::FailedNotApplied { result } => {
            if current.state != LedgerState::Authorized {
                return Err(DispatchError::InvalidRecord);
            }
            let terminal_digest = canonicalize(&result)
                .map(|(_bytes, digest)| digest)
                .map_err(|_| DispatchError::InvalidRecord)?;
            let terminal = ToolCallLedgerRecord {
                ledger_revision: 2,
                state: LedgerState::Failed,
                outbound_digest: None,
                terminal_result: Some(result.clone()),
                terminal_result_digest: Some(terminal_digest),
                ..current.clone()
            };
            match cas_terminal(db.connection_mut(), &key_of(current), &terminal) {
                Ok(dolly_storage::tool_ledger::CasOutcome::Committed { record }) => {
                    Ok(Applied::Committed {
                        record,
                        permit: None,
                    })
                }
                Ok(dolly_storage::tool_ledger::CasOutcome::Stale { authoritative }) => {
                    Ok(Applied::Stale { authoritative })
                }
                Err(error) => Err(DispatchError::Storage(error)),
            }
        }
        Proposal::Unknown { result } => {
            let outbound_digest = current
                .outbound_digest
                .clone()
                .ok_or(DispatchError::InvalidRecord)?;
            let terminal_digest = canonicalize(&result)
                .map(|(_bytes, digest)| digest)
                .map_err(|_| DispatchError::InvalidRecord)?;
            let terminal = ToolCallLedgerRecord {
                ledger_revision: 3,
                state: LedgerState::Unknown,
                outbound_digest: Some(outbound_digest.clone()),
                terminal_result: Some(result.clone()),
                terminal_result_digest: Some(terminal_digest),
                ..current.clone()
            };
            let expected = CasKey {
                module_id: current.operation_binding.module_id.clone(),
                operation_id: current.operation_binding.operation_id.clone(),
                expected_ledger_revision: current.ledger_revision,
                expected_state: current.state,
                correlation: Some(TransportCorrelation {
                    tool_server_id: current.operation_binding.tool_server_id.clone(),
                    tool_name: current.operation_binding.tool_name.clone(),
                    tool_server_generation: current.operation_binding.tool_server_generation,
                    server_request_id: current.operation_binding.server_request_id.clone(),
                    outbound_digest,
                }),
            };
            match cas_terminal(db.connection_mut(), &expected, &terminal) {
                Ok(dolly_storage::tool_ledger::CasOutcome::Committed { record }) => {
                    Ok(Applied::Committed {
                        record,
                        permit: None,
                    })
                }
                Ok(dolly_storage::tool_ledger::CasOutcome::Stale { authoritative }) => {
                    Ok(Applied::Stale { authoritative })
                }
                Err(error) => Err(DispatchError::Storage(error)),
            }
        }
    }
}

/// The exact compare-and-set key of a row: identity plus expected revision and
/// state, with no transport correlation (dispatch transitions do not settle a
/// response).
fn key_of(row: &ToolCallLedgerRecord) -> CasKey {
    CasKey {
        module_id: row.operation_binding.module_id.clone(),
        operation_id: row.operation_binding.operation_id.clone(),
        expected_ledger_revision: row.ledger_revision,
        expected_state: row.state,
        correlation: None,
    }
}
