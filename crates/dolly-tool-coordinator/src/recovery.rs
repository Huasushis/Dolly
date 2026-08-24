//! Reopen recovery (tool-broker §6): deterministic enumeration of every
//! nonterminal row, injection of the Host-owned facts provider, pure
//! decision, and application of the exact terminal/dispatch disposition
//! through [`dispatch_operation`].
//!
//! No downstream ACK/result/error/absence is read as permission: the only
//! inputs are the verified closed rows and the injected `RecoveryFacts`.

use std::time::SystemTime;
use dolly_storage::Database;
use dolly_storage::mcp_readiness::McpTransportReadiness;
use dolly_storage::runtime_binding::{ProcessGeneration, RuntimeBinding};
use dolly_storage::tool_broker_authority::{
    ToolDispatchAuthority, revalidate_tool_dispatch_authority,
};
use dolly_storage::tool_ledger::enumerate_nonterminal;
use crate::dispatch::{DispatchError, DispatchOutcome, dispatch_operation};
use crate::permit::SendPermit;
use crate::ports::{Clock, FencedFactsProvider, RecoveryFactsProvider};

/// Upper bound on pure re-decisions per row during one recovery pass.
const MAX_DECISIONS_PER_ROW: usize = 6;
/// The outcome of a full reopen recovery run.
#[derive(Debug)]
pub struct RecoveryOutcome {
    /// Number of nonterminal rows enumerated in deterministic
    /// `(module_id, operation_id)` order.
    pub rows_visited: usize,
    /// Number of `AUTHORIZED -> DISPATCHED` transitions that committed
    /// during recovery.
    pub dispatched: usize,
    /// Number of rows terminalized during recovery.
    pub terminalized: usize,
    /// Every send permit released; each is bound to a distinct committed
    /// DISPATCHED transition and must be consumed by a future transport.
    pub permits: Vec<SendPermit>,
}

/// Wall clock used by the coordinator's conservative reopen fence.
struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

/// Reopen recovery boundary used by Worker startup. It derives conservative
/// no-send facts inside the coordinator fence, so persisted nonterminal rows
/// become terminal UNKNOWN/NOT_APPLIED and are never redispatched.
pub fn reopen_recovery(
    db: &mut Database,
    authority: &ToolDispatchAuthority,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    readiness: &McpTransportReadiness,
) -> Result<RecoveryOutcome, DispatchError> {
    let clock = SystemClock;
    let facts = FencedFactsProvider {
        zero_bytes_proved: false,
        readiness,
        clock: &clock,
    };
    reopen_recovery_with_facts(
        db,
        authority,
        runtime_binding,
        process_generation,
        readiness,
        &facts,
    )
}

/// Run reopen recovery with one producer-issued authority and the Host-owned
/// facts provider. Authority and current premises are revalidated before every
/// row disposition, so stale recovery cannot reach CAS or release a permit.
///
/// Fails closed: corrupt rows or storage errors stop the pass. A stale row's
/// current-generation facts make it terminal UNKNOWN/NOT_APPLIED; it is never
/// redispatched.
pub(crate) fn reopen_recovery_with_facts(
    db: &mut Database,
    authority: &ToolDispatchAuthority,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    readiness: &McpTransportReadiness,
    facts: &dyn RecoveryFactsProvider,
) -> Result<RecoveryOutcome, DispatchError> {
    let rows = enumerate_nonterminal(db.connection()).map_err(DispatchError::Storage)?;
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
            let row_facts = facts.facts_for(&current);
            revalidate_tool_dispatch_authority(
                db,
                authority,
                runtime_binding,
                process_generation,
                readiness,
            )?;
            let outcome_step = dispatch_operation(db, &current, &row_facts)?;
            match outcome_step {
                DispatchOutcome::Dispatched {
                    record: _,
                    permit: Some(permit),
                } => {
                    // Permit-eligible dispatch committed: the Host now owns
                    // a one-use permit. Stop driving this row.
                    outcome.dispatched += 1;
                    outcome.permits.push(permit);
                    break;
                }
                DispatchOutcome::Dispatched {
                    record,
                    permit: None,
                } => {
                    // No-proof chain: DISPATCHED committed without a permit;
                    // re-decide the new row (-> UNKNOWN).
                    outcome.dispatched += 1;
                    current = record;
                }
                DispatchOutcome::Terminalized { record: _ } => {
                    outcome.terminalized += 1;
                    break;
                }
                DispatchOutcome::Unchanged { record: _ } => break,
                DispatchOutcome::Stale { authoritative } => {
                    current = authoritative;
                }
            }
        }
    }
    Ok(outcome)
}
