//! Dolly Tool Broker — pure-core slice (TST-TOOL-005/008, REQ-TOOL-005/008).
//!
//! This crate validates only: resolved registry admission, configuration,
//! canonical digests, and the frozen protocol-version boundary. It performs
//! no network access, no provider or server process, no tool execution, and
//! no async transport: every decision is pure over the inputs it is given.
//!
//! Authority is closed. The `ResolvedToolBrokerConfig` is produced only by
//! `admit_config`; discovery and results are never consulted to expand it.

pub mod dispatch;
pub mod effect_journal;
pub mod invoke;
pub mod registry;
pub mod result;
pub mod status;
pub mod version;

/// The fixed durable ledger record discriminator value and the closed
/// binding discriminator (re-exported from `invoke`).
pub use dispatch::{
    ConfirmationDecision, DispatchDisposition, EVENT_TOOL_DISPATCH_PROVED_NOT_APPLIED,
    EVENT_TOOL_OPERATION_DISPATCHED, EVENT_TOOL_OUTCOME_UNKNOWN, LedgerRecordError, LedgerState,
    RecoveryFacts, TOOL_CALL_LEDGER_RECORD_SCHEMA, TOOL_OPERATION_BINDING_SCHEMA,
    ToolCallLedgerRecord, ToolCallLedgerRecordSchemaTag, ToolOperationBinding,
    ToolOperationBindingSchemaTag, recover_operation,
};

pub use invoke::{
    ExistingOperation, FrozenBinding, InvokeCandidate, InvokeOutcome, ResolutionBackend,
    evaluate_invoke, operation_digest, request_digest, resolve_json_pointer,
};
pub use registry::{
    AdmissionOutcome, ConfigRejection, IdempotencyPolicy, RejectionReason, ResolvedServer,
    ResolvedTool, ResolvedToolBrokerConfig, SideEffectClass, TOOL_BROKER_CONFIG_SCHEMA_ID,
    admit_config,
};
pub use result::{ErrorOutcome, ToolError, ToolErrorCode, ToolResult, ToolStatus};
pub use status::{StatusOutcome, lookup_status};
pub use version::{
    MCP_PROTOCOL_VERSION_2025_06_18, TOOL_CONFIG_INVALID, UnsupportedProtocolVersion,
};

/// Shared embedded schema catalog used by registry admission.
pub(crate) fn schema_catalog() -> Result<&'static dolly_schema::SchemaCatalog, String> {
    dolly_schema::embedded_schema_catalog().map_err(|error| error.to_string())
}

/// Canonical JCS digest helper re-exported for callers and tests.
pub use dolly_canonical_json::canonicalize;
