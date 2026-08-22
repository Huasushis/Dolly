//! ToolDispatchService — the internal component that turns a one-use
//! [`SendPermit`] into exactly one injected transport dispatch (tool-broker
//! §6, REQ-TOOL-002/006, INV-STORAGE-017).
//!
//! The coordinator owns no transport, Host, or network: the Host injects a
//! [`ToolTransport`] implementation. The service consumes the permit exactly
//! once, reloads the authoritative `DISPATCHED` row, re-verifies that the
//! permit still binds that exact row, and calls the injected transport at
//! most once with the exact frozen outbound bytes. It never redispatches:
//! an already-terminal row or a concurrent settle voids the permit without a
//! second send.
//!
//! A successful, correlated response is validated against the frozen output
//! contract (the retained `output_schema` digest and document) and persisted
//! as a terminal record by compare-and-set. A timeout, disconnect, or
//! ambiguous transport outcome has no authoritative disposition and is
//! persisted as terminal `UNKNOWN` (`TOOL_EXTERNAL_OUTCOME_UNKNOWN`), never
//! as `FAILED` and never redispatched.

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_schema::SchemaValidator;
use dolly_storage::Database;
use dolly_storage::tool_ledger::{
    CasKey, TransportCorrelation, cas_terminal as storage_cas_terminal, load_exact,
};
use dolly_tool_broker::{
    ErrorOutcome, LedgerState, ToolCallLedgerRecord, ToolError, ToolErrorCode, ToolResult,
    ToolStatus,
};

use crate::dispatch::DispatchError;
use crate::permit::{SendPermit, SendPermitBinding};

/// The frozen outbound request handed to the injected transport. `payload`
/// is the exact adapter payload bytes committed as `outbound_digest` at the
/// dispatch boundary.
#[derive(Debug)]
pub struct ToolDispatchRequest<'a> {
    /// The exact outbound application payload (adapter bytes), whose digest
    /// equals the permit's `outbound_digest`.
    pub payload: &'a [u8],
    /// The Host-assigned request identity the transport must echo.
    pub server_request_id: &'a str,
    /// The frozen server generation the request is bound to.
    pub tool_server_generation: u64,
}

/// The injected transport's outcome for one request. A `Result` is only an
/// authoritative disposition when it correlates to the request (checked by
/// the service); everything else has no authoritative disposition and maps to
/// `UNKNOWN`.
#[derive(Debug)]
pub enum TransportDispatch {
    /// The transport returned a result envelope from the request.
    Result { result: ToolResult },
    /// No authoritative result before the bounded request deadline.
    Timeout,
    /// The connection dropped before an authoritative result.
    Disconnect,
    /// The transport cannot attribute an outcome to this request.
    Ambiguous,
}

/// A transport seam injected by the Host. Implementations send at most the
/// one request they are given and return the outcome above; they do not
/// decide ledger transitions.
pub trait ToolTransport {
    /// Send exactly one request and return its outcome. The service guarantees
    /// this is called at most once per consumed [`SendPermit`].
    fn dispatch(&self, request: &ToolDispatchRequest<'_>) -> TransportDispatch;
}

/// The settled outcome of one service dispatch.
#[derive(Debug)]
pub enum ToolDispatchOutcome {
    /// A terminal transition committed durably (`SUCCEEDED`, `FAILED`, or
    /// `UNKNOWN`); the returned row is the authoritative committed record.
    Terminalized { record: ToolCallLedgerRecord },
    /// The row was already terminal before any dispatch; the permit is void
    /// and not one byte is sent (never redispatch).
    AlreadyTerminal { record: ToolCallLedgerRecord },
    /// The injected transport returned a response whose correlation does not
    /// match the frozen request identity, or a non-terminal result. Retained
    /// as bounded evidence; no transition, no redispatch.
    ResponseRejected { record: ToolCallLedgerRecord },
    /// A concurrent compare-and-set won; nothing was mutated. The caller may
    /// rerun the pure decision on the returned authoritative row.
    Stale { authoritative: ToolCallLedgerRecord },
}

/// The internal Tool Dispatch service over the authoritative ledger database.
pub struct ToolDispatchService<'a> {
    db: &'a mut Database,
}

impl<'a> ToolDispatchService<'a> {
    /// Bind the service to the authoritative ledger `Database`.
    pub fn new(db: &'a mut Database) -> Self {
        Self { db }
    }

    /// Consume the one-use [`SendPermit`] and perform exactly one injected
    /// transport dispatch, then persist the terminal state. Never
    /// redispatches: an already-terminal row, a permit that no longer bounds
    /// the authoritative row, or a mismatched response produce no send and no
    /// second attempt.
    pub fn dispatch(
        &mut self,
        permit: SendPermit,
        transport: &dyn ToolTransport,
    ) -> Result<ToolDispatchOutcome, DispatchError> {
        let granted = permit.consume();
        let Some(authoritative) = load_exact(
            self.db.connection(),
            &granted.module_id,
            &granted.operation_id,
        )
        .map_err(DispatchError::Storage)?
        else {
            // A permit names a committed row; its absence is corruption.
            return Err(DispatchError::InvalidRecord);
        };
        if authoritative.state.is_terminal() {
            return Ok(ToolDispatchOutcome::AlreadyTerminal {
                record: authoritative,
            });
        }
        if !permit_binds(&granted, &authoritative) {
            return Err(DispatchError::InvalidRecord);
        }

        // The exact frozen outbound bytes; their digest must equal the
        // committed outbound_digest the permit is bound to.
        let payload = authoritative
            .operation_binding
            .recompute_outbound_payload()
            .ok_or(DispatchError::InvalidRecord)?;
        if Sha256Digest::compute(payload.as_ref()) != granted.outbound_digest {
            return Err(DispatchError::InvalidRecord);
        }
        let request = ToolDispatchRequest {
            payload: payload.as_ref(),
            server_request_id: &granted.server_request_id,
            tool_server_generation: granted.tool_server_generation,
        };

        match transport.dispatch(&request) {
            TransportDispatch::Result { result } => self.settle_response(authoritative, result),
            TransportDispatch::Timeout
            | TransportDispatch::Disconnect
            | TransportDispatch::Ambiguous => self.settle_unknown(authoritative),
        }
    }
}

/// Whether a permit still bounds the authoritative row exactly: same
/// revision/state, generation, request identity, and outbound digest.
fn permit_binds(granted: &SendPermitBinding, authoritative: &ToolCallLedgerRecord) -> bool {
    authoritative.state == LedgerState::Dispatched
        && authoritative.ledger_revision == 2
        && authoritative.operation_binding.tool_server_generation == granted.tool_server_generation
        && authoritative.operation_binding.server_request_id == granted.server_request_id
        && authoritative.outbound_digest.as_ref() == Some(&granted.outbound_digest)
}

impl ToolDispatchService<'_> {
    /// Persist the transport's correlated terminal result, or the frozen
    /// output-contract failure as `TOOL_OUTPUT_INVALID`.
    fn settle_response(
        &mut self,
        record: ToolCallLedgerRecord,
        result: ToolResult,
    ) -> Result<ToolDispatchOutcome, DispatchError> {
        if !correlates(&record, &result) {
            return Ok(ToolDispatchOutcome::ResponseRejected { record });
        }
        // Only terminal statuses may settle a row; anything else is a
        // cross-request/non-terminal observation and settles nothing.
        if !matches!(
            result.status,
            ToolStatus::Succeeded | ToolStatus::Failed | ToolStatus::Unknown
        ) {
            return Ok(ToolDispatchOutcome::ResponseRejected { record });
        }
        let result = if result.status == ToolStatus::Succeeded {
            match self.validate_output_contract(&record, &result) {
                Ok(()) => result,
                Err(message) => ToolResult {
                    operation_id: record.operation_binding.operation_id.clone(),
                    status: ToolStatus::Failed,
                    output: serde_json::Value::Null,
                    error: Some(ToolError {
                        code: ToolErrorCode::OutputInvalid,
                        retryable: false,
                        outcome: ErrorOutcome::Applied,
                        message,
                        details: serde_json::Map::new(),
                    }),
                    server_request_id: Some(record.operation_binding.server_request_id.clone()),
                },
            }
        } else {
            result
        };
        self.apply_terminal(record, result)
    }

    /// Persist terminal `UNKNOWN` for a timeout/disconnect/ambiguous outcome.
    fn settle_unknown(
        &mut self,
        record: ToolCallLedgerRecord,
    ) -> Result<ToolDispatchOutcome, DispatchError> {
        let result = ToolResult::unknown_outcome(record.operation_binding.operation_id.clone());
        self.apply_terminal(record, result)
    }

    /// Apply the given terminal result by compare-and-set against the exact
    /// `(module_id, operation_id, revision, state)` plus the frozen transport
    /// correlation. A stale CAS mutates nothing and returns the authoritative
    /// row; the caller reruns the pure decision (never redispatch).
    fn apply_terminal(
        &mut self,
        current: ToolCallLedgerRecord,
        result: ToolResult,
    ) -> Result<ToolDispatchOutcome, DispatchError> {
        let terminal_digest = canonicalize(&result)
            .map(|(_bytes, digest)| digest)
            .map_err(|_| DispatchError::InvalidRecord)?;
        let state = match result.status {
            ToolStatus::Succeeded => LedgerState::Succeeded,
            ToolStatus::Failed => LedgerState::Failed,
            ToolStatus::Unknown => LedgerState::Unknown,
            _ => return Err(DispatchError::InvalidRecord),
        };
        let terminal = ToolCallLedgerRecord {
            ledger_revision: 3,
            state,
            outbound_digest: current.outbound_digest.clone(),
            terminal_result: Some(result.clone()),
            terminal_result_digest: Some(terminal_digest),
            ..current.clone()
        };
        terminal
            .verify_field_combination()
            .map_err(|_| DispatchError::InvalidRecord)?;
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
                outbound_digest: current
                    .outbound_digest
                    .clone()
                    .ok_or(DispatchError::InvalidRecord)?,
            }),
        };
        match storage_cas_terminal(self.db.connection_mut(), &expected, &terminal) {
            Ok(dolly_storage::tool_ledger::CasOutcome::Committed { record }) => {
                Ok(ToolDispatchOutcome::Terminalized { record })
            }
            Ok(dolly_storage::tool_ledger::CasOutcome::Stale { authoritative }) => {
                Ok(ToolDispatchOutcome::Stale { authoritative })
            }
            Err(error) => Err(DispatchError::Storage(error)),
        }
    }
}

/// Whether the transport result correlates to the exact frozen request:
/// original operation identity and the Host-assigned request identity.
fn correlates(record: &ToolCallLedgerRecord, result: &ToolResult) -> bool {
    let binding = &record.operation_binding;
    result.operation_id == binding.operation_id
        && result.server_request_id.as_deref() == Some(binding.server_request_id.as_str())
}

impl ToolDispatchService<'_> {
    /// Recompute the retained tool `output_schema` digest and validate the
    /// succeeded output against the frozen output contract. Returns the
    /// diagnostic to record as `TOOL_OUTPUT_INVALID` on failure.
    fn validate_output_contract(
        &self,
        record: &ToolCallLedgerRecord,
        result: &ToolResult,
    ) -> Result<(), String> {
        let Some(schema) = frozen_output_schema(record) else {
            // No schema entry in the frozen server contract: corrupt binding.
            return Err("frozen server contract lacks the output_schema entry".into());
        };
        let expected_digest = match frozen_output_schema_digest(record) {
            Some(d) => d,
            None => return Err("frozen server contract lacks output_schema_digest".into()),
        };
        let actual_digest = canonicalize(schema)
            .map(|(_d, digest)| digest)
            .unwrap_or_else(|_| Sha256Digest::compute(&[]));
        if actual_digest != expected_digest {
            return Err("frozen output_schema digest does not match its document".into());
        }
        let validator = SchemaValidator::from_embedded_schema(schema)
            .map_err(|e| format!("frozen output_schema does not compile: {e}"))?;
        validator
            .validate(
                &CanonicalJsonValue::try_from(result.output.clone())
                    .map_err(|_| "succeeded response output is not canonical JSON".to_string())?,
            )
            .map_err(|issues| format!("output violates frozen contract: {issues}"))
    }
}

/// The frozen `output_schema` document of the bound tool, if present.
fn frozen_output_schema(record: &ToolCallLedgerRecord) -> Option<&CanonicalJsonValue> {
    let binding = &record.operation_binding;
    let tools = binding.server_contract.get("tools")?;
    let tools = match tools {
        CanonicalJsonValue::Object(tools) => tools,
        _ => return None,
    };
    let tool = tools.get(&binding.tool_name)?;
    let tool = match tool {
        CanonicalJsonValue::Object(tool) => tool,
        _ => return None,
    };
    tool.get("output_schema")
}

/// The frozen `output_schema_digest` of the bound tool, if present.
fn frozen_output_schema_digest(record: &ToolCallLedgerRecord) -> Option<Sha256Digest> {
    let binding = &record.operation_binding;
    let tools = binding.server_contract.get("tools")?;
    let tools = match tools {
        CanonicalJsonValue::Object(tools) => tools,
        _ => return None,
    };
    let tool = tools.get(&binding.tool_name)?;
    let tool = match tool {
        CanonicalJsonValue::Object(tool) => tool,
        _ => return None,
    };
    match tool.get("output_schema_digest") {
        Some(CanonicalJsonValue::String(s)) => s.parse().ok(),
        _ => None,
    }
}
