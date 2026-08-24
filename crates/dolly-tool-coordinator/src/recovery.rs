//! Reopen recovery (tool-broker §6): deterministic enumeration of every
//! nonterminal row, injection of the Host-owned facts provider, pure
//! decision, and application of the exact terminal/dispatch disposition
//! through [`dispatch_operation`].
//!
//! No downstream ACK/result/error/absence is read as permission: the only
//! inputs are the verified closed rows and the injected `RecoveryFacts`.

use dolly_storage::Database;
use dolly_storage::tool_ledger::enumerate_nonterminal;
use crate::dispatch::{DispatchError, DispatchOutcome, dispatch_operation};
use crate::permit::SendPermit;
use crate::ports::{RecoveryFacts, RecoveryProof};

/// Upper bound on pure re-decisions per row during one recovery pass.
const MAX_DECISIONS_PER_ROW: usize = 6;
/// The outcome of a full reopen recovery run.
#[derive(Debug)]
pub struct RecoveryOutcome {
    pub rows_visited: usize,
    pub dispatched: usize,
    pub terminalized: usize,
    pub permits: Vec<SendPermit>,
}


/// Reopen recovery boundary used before a new process generation is minted.
/// It enumerates and verifies every persisted nonterminal Claim, then applies
/// the conservative no-send decision. AUTHORIZED/DISPATCHED rows become
/// terminal UNKNOWN/NOT_APPLIED; no permit or transport path is available.
pub fn reopen_recovery(db: &mut Database) -> Result<RecoveryOutcome, DispatchError> {
    let rows = enumerate_nonterminal(db.connection()).map_err(DispatchError::Storage)?;
    let source = RecoveryProof::coordinator_reopen();
    let mut outcome = RecoveryOutcome {
        rows_visited: rows.len(),
        dispatched: 0,
        terminalized: 0,
        permits: Vec::new(),
    };
    for row in rows {
        let mut current = row;
        let mut decisions = 0;
        loop {
            decisions += 1;
            if decisions > MAX_DECISIONS_PER_ROW {
                return Err(DispatchError::Ambiguous);
            }
            let facts = RecoveryFacts::from_proof(source);
            match dispatch_operation(db, &current, &facts)? {
                DispatchOutcome::Dispatched { record, permit: None } => {
                    outcome.dispatched += 1;
                    current = record;
                }
                DispatchOutcome::Dispatched { permit: Some(_), .. } => {
                    return Err(DispatchError::Ambiguous);
                }
                DispatchOutcome::Terminalized { .. } => {
                    outcome.terminalized += 1;
                    break;
                }
                DispatchOutcome::Unchanged { .. } => break,
                DispatchOutcome::Stale { authoritative } => current = authoritative,
            }
        }
    }
    Ok(outcome)
}
