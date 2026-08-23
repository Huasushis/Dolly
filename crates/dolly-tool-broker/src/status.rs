//! Module-scoped status lookup (REQ-TOOL-004): reveal only the exact
//! `(module_id, target_operation_id)` row and never perform a global UUID
//! lookup. A missing composite key is an indistinguishable `absent` result.

use crate::invoke::ExistingOperation;
use crate::registry::ResolvedToolBrokerConfig;
use crate::result::ToolResult;

/// Outcome of a module-scoped status lookup.
#[derive(Debug)]
pub enum StatusOutcome {
    /// No row for the exact composite key: indistinguishable `absent`.
    Absent { result: ToolResult },
    /// A durable row exists; its recorded result is returned.
    Present { result: ToolResult },
}

/// Look up the exact `(module_id, target_operation_id)` composite key.
///
/// The registry is passed for future capability/authority checks; this path
/// never invokes, retries, cancels, or advances anything (spec §6).
#[allow(unused_variables)]
pub fn lookup_status(
    registry: &ResolvedToolBrokerConfig,
    module_id: &str,
    target_operation_id: &str,
    existing: Option<&ExistingOperation>,
) -> StatusOutcome {
    match existing {
        Some(row) => {
            let result = row
                .result
                .clone()
                .unwrap_or_else(|| ToolResult::absent(target_operation_id));
            StatusOutcome::Present { result }
        }
        None => StatusOutcome::Absent {
            result: ToolResult::absent(target_operation_id),
        },
    }
}
