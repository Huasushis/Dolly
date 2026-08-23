//! One-use, opaque, non-Clone send permit (tool-broker §6,
//! INV-STORAGE-017).
//!
//! A [`SendPermit`] is created ONLY from a committed `DISPATCHED` ledger
//! record returned by [`crate::dispatch_operation`] — never from a stale
//! observation, an error, a lost acknowledgement, or an unknown state.
//! Consuming it once yields the exact bound identity a future transport
//! must attach to its first request byte; it cannot be cloned or reused.

use dolly_canonical_json::Sha256Digest;
use dolly_tool_broker::ToolCallLedgerRecord;

/// The exact identity a [`SendPermit`] is bound to (tool-broker §6): the
/// operation key, the new ledger revision, the frozen server generation,
/// the Host-assigned `server_request_id`, and the exact outbound digest.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SendPermitBinding {
    /// The operation's Module identity.
    pub module_id: String,
    /// The original invoke operation identity.
    pub operation_id: String,
    /// Host configuration revision bound by the registry authority.
    pub config_revision: i64,
    /// Frozen tool-server identity bound by the registry authority.
    pub tool_server_id: String,
    /// Frozen process generation selected by the registry authority.
    pub tool_server_generation: u64,
    /// The new ledger revision after the committed dispatch CAS (2).
    pub ledger_revision: u64,
    /// The exact accepted operation deadline from the durable binding.
    pub authorized_deadline: String,
    /// The Host-assigned outbound request identity.
    pub server_request_id: String,
    /// Digest of the exact outbound application payload.
    pub outbound_digest: Sha256Digest,
}

/// An opaque, one-use, non-Clone send permission.
#[derive(Debug)]
pub struct SendPermit {
    binding: SendPermitBinding,
}

impl SendPermit {
    /// Create the permit bound to a committed `DISPATCHED` record.
    pub(crate) fn from_committed(record: &ToolCallLedgerRecord) -> Self {
        debug_assert_eq!(
            record.state,
            dolly_tool_broker::LedgerState::Dispatched,
            "only a committed DISPATCHED record may release a send permit"
        );
        let outbound_digest = record
            .outbound_digest
            .clone()
            .expect("committed DISPATCHED record carries an outbound digest");
        Self {
            binding: SendPermitBinding {
                module_id: record.operation_binding.module_id.clone(),
                operation_id: record.operation_binding.operation_id.clone(),
                config_revision: record.operation_binding.config_revision as i64,
                tool_server_id: record.operation_binding.tool_server_id.clone(),
                ledger_revision: record.ledger_revision,
                tool_server_generation: record.operation_binding.tool_server_generation,
                authorized_deadline: record.operation_binding.authorized_deadline.clone(),
                server_request_id: record.operation_binding.server_request_id.clone(),
                outbound_digest,
            },
        }
    }

    /// Consume the permit exactly once, returning the bound identity that a
    /// future transport must use for its request bytes. Rust's move
    /// semantics make a second consumption a compile error.
    pub fn consume(self) -> SendPermitBinding {
        self.binding
    }

    pub(crate) fn binding(&self) -> &SendPermitBinding {
        &self.binding
    }
}
