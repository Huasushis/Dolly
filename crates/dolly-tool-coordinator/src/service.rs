//! Tool dispatch service (tool-broker §6/§8, REQ-TOOL-002/006,
//! INV-STORAGE-017).
//!
//! `ToolDispatchService` is the transport-facing half of the coordinator:
//! it consumes ONE non-Clone [`SendPermit`] exactly once, dispatches through
//! the injected Host transport AT MOST ONCE, and settles the authoritative
//! row only after the closed-response checks pass. Timeout, disconnect,
//! transport-decode, correlation, closed-envelope, and bound failures after
//! dispatch are terminal `UNKNOWN` (`TOOL_EXTERNAL_OUTCOME_UNKNOWN`); a
//! present output that violates the frozen output schema is terminal `FAILED`
//! with the Tool Broker's `TOOL_OUTPUT_INVALID`/`applied` authority. The
//! service never retries or redispatches, and no downstream response/ACK ever
//! authorizes a new permit, generation rotation, or replay.
//!
//! The caller supplies the expected request bytes along with the permit;
//! the service verifies `sha256(request_bytes) == binding.outbound_digest`
//! BEFORE the transport is consulted. On mismatch the service fails closed
//! through the existing ledger transition authority (the same
//! `cas_terminal` used by [`crate::dispatch_operation`]) and never touches
//! the transport.

use dolly_canonical_json::{
    CanonicalJsonValue, ParseLimits, Sha256Digest, canonicalize, parse_core_json,
};
use dolly_schema::SchemaValidator;
use dolly_storage::mcp_readiness::{McpTransportReadiness, prove_current_mcp_transport_readiness};
use dolly_storage::runtime_binding::{ProcessGeneration, RuntimeBinding};
use dolly_storage::tool_broker_authority::{
    ToolBrokerAuthorityError, ToolDispatchAuthority, revalidate_tool_dispatch_authority,
    validate_dispatch_binding,
};
use dolly_storage::tool_ledger::{
    CasKey, CasOutcome, TransportCorrelation, cas_terminal, load_exact,
};
use dolly_storage::{Database, StorageError};
use dolly_tool_broker::{
    ErrorOutcome, LedgerState, ToolCallLedgerRecord, ToolError, ToolErrorCode,
    ToolOperationBinding, ToolResult, ToolStatus,
};
use serde::de::IntoDeserializer;
use serde::{Deserialize, Serialize};

use crate::mcp_stdio::{
    HostMcpStdioProcessHandle, HostOwnedMcpStdioSession, McpStdioProbe, StdioTransportLimits,
    absolute_deadline,
};
use crate::permit::{SendPermit, SendPermitBinding};

/// Closed bounds on a response the service will admit (tool-broker §3/§6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DispatchLimits {
    /// Maximum admitted response frame size in bytes.
    pub max_response_bytes: usize,
    /// Maximum total JSON object members across the whole response tree.
    pub max_members: usize,
    /// Maximum JSON nesting depth (enforced during parse).
    pub max_depth: u16,
}

/// The only downstream input a [`ToolDispatchService`] reads: one
/// request/response exchange or its absence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportOutcome {
    /// A complete response frame arrived with exactly these bytes.
    Response(Vec<u8>),
    /// No response within the Host-configured deadline.
    Timeout,
    /// The connection dropped before a complete response frame arrived.
    Disconnect,
    /// Transport-level failure (framing, protocol, credential, …).
    Error(String),
}

/// Transport injected by the Host, fake-testable. The service calls it AT
/// MOST ONCE per [`ToolDispatchService::dispatch`].
pub trait ToolTransport {
    /// Exactly one request/response exchange. `request_bytes` are the
    /// exact bytes the service verified against the permit's outbound
    /// digest before this call.
    fn call(&mut self, request_bytes: &[u8]) -> TransportOutcome;

    /// Abort the shared transport/process control after the permit has been
    /// consumed and a request cannot be admitted or durably settled.
    fn abort(&mut self) {}
}

struct AbortTransport;

impl ToolTransport for AbortTransport {
    fn call(&mut self, _request_bytes: &[u8]) -> TransportOutcome {
        TransportOutcome::Error("stdio admission aborted".to_owned())
    }

    fn abort(&mut self) {}
}

/// The result of one [`ToolDispatchService::dispatch`].
#[derive(Debug)]
pub enum ServiceOutcome {
    /// A correlated, closed, bounded response committed durably as
    /// `SUCCEEDED`. The result carries the admitted upstream output.
    Succeeded {
        record: ToolCallLedgerRecord,
        result: ToolResult,
    },
    /// A complete correlated response whose present output violates the
    /// frozen output schema, committed as `FAILED` (`TOOL_OUTPUT_INVALID`,
    /// `applied`).
    Failed {
        record: ToolCallLedgerRecord,
        result: ToolResult,
    },
    /// A post-dispatch failure class (timeout, disconnect, malformed or
    /// closed-envelope response, correlation, or bound) committed durably as
    /// `UNKNOWN` (`TOOL_EXTERNAL_OUTCOME_UNKNOWN`).
    Unknown {
        record: ToolCallLedgerRecord,
        result: ToolResult,
    },
    /// The authoritative row was not `DISPATCHED` (already settled, or
    /// absent): nothing was mutated and the transport was NOT called.
    Stale {
        authoritative: Option<ToolCallLedgerRecord>,
    },
}

/// Service failure; nothing was mutated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceError {
    /// The committed row could not support the requested transition.
    InvalidRecord,
    /// The producer's registry/generation permission did not match the row.
    Authority(ToolBrokerAuthorityError),
    /// Storage failure (including corruption and lost commits).
    Storage(StorageError),
}

#[derive(Debug)]
pub(crate) enum StdioDispatchError {
    Service(ServiceError),
}

impl StdioDispatchError {
    pub(crate) fn message(&self) -> String {
        let Self::Service(error) = self;
        format!("MCP service: {error:?}")
    }
}

/// The single transport-facing entry point of the coordinator.
pub struct ToolDispatchService {
    limits: DispatchLimits,
}

impl ToolDispatchService {
    /// Create the service with the closed admission bounds.
    pub fn new(limits: DispatchLimits) -> Self {
        Self { limits }
    }

    /// Consume `permit` exactly once and settle one operation.
    ///
    /// This low-level form is retained for the existing pure ledger tests.
    /// A Host-facing caller MUST use [`Self::dispatch_authorized`] so the
    /// storage-produced registry/generation authority is checked before the
    /// transport boundary.
    pub(crate) fn dispatch(
        &self,
        db: &mut Database,
        permit: SendPermit,
        request_bytes: &[u8],
        transport: &mut dyn ToolTransport,
    ) -> Result<ServiceOutcome, ServiceError> {
        self.dispatch_inner(db, permit, request_bytes, transport)
    }

    /// Production coordinator invocation for one Host-owned MCP stdio
    /// composition. The separately retained process handle is passed
    /// explicitly so the transport cannot accidentally become the lifecycle
    /// owner.
    pub(crate) fn dispatch_authorized(
        &self,
        db: &mut Database,
        authority: &ToolDispatchAuthority,
        runtime_binding: &RuntimeBinding,
        process_generation: &ProcessGeneration,
        readiness: &McpTransportReadiness,
        host_session: HostOwnedMcpStdioSession,
        host_handle: HostMcpStdioProcessHandle,
        limits: StdioTransportLimits,
        permit: SendPermit,
        request_bytes: &[u8],
    ) -> Result<ServiceOutcome, StdioDispatchError> {
        self.dispatch_stdio_authorized(
            db,
            authority,
            runtime_binding,
            process_generation,
            readiness,
            host_session,
            host_handle,
            limits,
            permit,
            request_bytes,
        )
    }

    /// Host-owned stdio composition: readiness is freshly proven against the
    /// current Runtime binding/process generation before this exact permit is
    /// routed through the authority-checked dispatch path.
    pub(crate) fn dispatch_stdio_authorized(
        &self,
        db: &mut Database,
        authority: &ToolDispatchAuthority,
        runtime_binding: &RuntimeBinding,
        process_generation: &ProcessGeneration,
        readiness: &McpTransportReadiness,
        host_session: HostOwnedMcpStdioSession,
        host_handle: HostMcpStdioProcessHandle,
        limits: StdioTransportLimits,
        permit: SendPermit,
        request_bytes: &[u8],
    ) -> Result<ServiceOutcome, StdioDispatchError> {
        if revalidate_tool_dispatch_authority(
            db,
            authority,
            runtime_binding,
            process_generation,
            readiness,
        )
        .is_err()
            || validate_dispatch_binding(
                authority,
                permit.binding().config_revision,
                &permit.binding().tool_server_id,
                permit.binding().tool_server_generation,
            )
            .is_err()
        {
            return self.settle_admission_unknown(db, host_handle, permit, request_bytes);
        }
        let deadline = match absolute_deadline(&permit.binding().authorized_deadline) {
            Ok(deadline) => deadline,
            Err(_) => return self.settle_admission_unknown(db, host_handle, permit, request_bytes),
        };
        let server_id = permit.binding().tool_server_id.clone();
        let mut probe = match McpStdioProbe::from_host_session(
            host_session,
            host_handle.clone(),
            limits,
            deadline,
        ) {
            Ok(probe) => probe,
            Err(_) => return self.settle_admission_unknown(db, host_handle, permit, request_bytes),
        };
        let readiness = match prove_current_mcp_transport_readiness(
            db.connection(),
            runtime_binding,
            process_generation,
            &server_id,
            &mut probe,
        ) {
            Ok(readiness) => readiness,
            Err(_) => {
                probe.abort();
                return self.settle_admission_unknown(db, host_handle, permit, request_bytes);
            }
        };
        let permit_binding = permit.binding().clone();
        let mut transport = match probe.into_transport(&readiness, authority, &permit_binding) {
            Ok(transport) => transport,
            Err(_) => return self.settle_admission_unknown(db, host_handle, permit, request_bytes),
        };
        self.dispatch_inner(db, permit, request_bytes, &mut transport)
            .map_err(StdioDispatchError::Service)
    }

    fn settle_admission_unknown(
        &self,
        db: &mut Database,
        host_handle: HostMcpStdioProcessHandle,
        permit: SendPermit,
        request_bytes: &[u8],
    ) -> Result<ServiceOutcome, StdioDispatchError> {
        host_handle.terminate();
        let mut transport = AbortTransport;
        self.dispatch_inner(db, permit, request_bytes, &mut transport)
            .map_err(StdioDispatchError::Service)
    }

    fn dispatch_inner(
        &self,
        db: &mut Database,
        permit: SendPermit,
        request_bytes: &[u8],
        transport: &mut dyn ToolTransport,
    ) -> Result<ServiceOutcome, ServiceError> {
        let binding = permit.consume();

        let current = match load_exact(db.connection(), &binding.module_id, &binding.operation_id) {
            Ok(current) => current,
            Err(error) => {
                transport.abort();
                return Err(ServiceError::Storage(error));
            }
        };
        let Some(current) = current else {
            transport.abort();
            return Ok(ServiceOutcome::Stale {
                authoritative: None,
            });
        };
        if current.state != LedgerState::Dispatched {
            transport.abort();
            return Ok(ServiceOutcome::Stale {
                authoritative: Some(current),
            });
        }

        if Sha256Digest::compute(request_bytes) != binding.outbound_digest {
            // Fail closed with NO transport call: the caller did not supply
            // the exact bytes whose digest was durably bound at dispatch.
            transport.abort();
            let result = unknown_outcome_result(&binding);
            let settled = self.settle(db, &current, Terminal::unknown(result));
            return settled;
        }

        match transport.call(request_bytes) {
            TransportOutcome::Response(bytes) => {
                match self.classify(&bytes, &current.operation_binding) {
                    Classification::Succeeded(output) => {
                        let result = succeeded_result(&binding, output);
                        let settled = self.settle(db, &current, Terminal::succeeded(result));
                        abort_if_settlement_not_committed(transport, &settled);
                        settled
                    }
                    Classification::OutputInvalid => {
                        transport.abort();
                        let result = output_invalid_result(&binding);
                        let settled = self.settle(db, &current, Terminal::failed(result));
                        settled
                    }
                    Classification::Rejected => {
                        transport.abort();
                        let result = unknown_outcome_result(&binding);
                        let settled = self.settle(db, &current, Terminal::unknown(result));
                        settled
                    }
                }
            }
            TransportOutcome::Timeout
            | TransportOutcome::Disconnect
            | TransportOutcome::Error(_) => {
                transport.abort();
                let result = unknown_outcome_result(&binding);
                let settled = self.settle(db, &current, Terminal::unknown(result));
                settled
            }
        }
    }

    /// Classify a response frame (pure, no I/O).
    fn classify(&self, bytes: &[u8], binding: &ToolOperationBinding) -> Classification {
        if bytes.len() > self.limits.max_response_bytes {
            return Classification::Rejected;
        }
        let Ok(limits) = ParseLimits::new(self.limits.max_depth) else {
            return Classification::Rejected;
        };
        let tree = match parse_core_json(bytes, limits) {
            Ok(tree) => tree,
            Err(_) => return Classification::Rejected,
        };
        if count_members(&tree) > self.limits.max_members {
            return Classification::Rejected;
        }
        let envelope = match ToolResponseEnvelope::deserialize(tree.into_deserializer()) {
            Ok(envelope) => envelope,
            Err(_) => return Classification::Rejected,
        };
        // Closed protocol/correlation: JSON-RPC 2.0 and the exact id.
        if envelope.jsonrpc != "2.0" || envelope.id != binding.server_request_id {
            return Classification::Rejected;
        }
        match (envelope.result, envelope.error) {
            (Some(output), None) => {
                let canonical_output = match CanonicalJsonValue::try_from(output.clone()) {
                    Ok(output) => output,
                    Err(_) => return Classification::Rejected,
                };
                let Some((schema, digest)) = frozen_output_schema(binding) else {
                    return Classification::Rejected;
                };
                let Ok(validator) = SchemaValidator::compile_embedded(schema, &digest) else {
                    return Classification::Rejected;
                };
                if validator.validate(&canonical_output).is_ok() {
                    Classification::Succeeded(output)
                } else {
                    Classification::OutputInvalid
                }
            }
            // The presence of an upstream error does not prove that the
            // operation was not applied. No closed disposition is carried by
            // this response envelope, so it remains externally ambiguous.
            (None, Some(_)) => Classification::Rejected,
            _ => Classification::Rejected, // zero or both members: closed schema
        }
    }

    /// Settle a `DISPATCHED` row to the given terminal via `cas_terminal`
    /// (the SAME writer used by [`crate::dispatch_operation`]).
    ///
    /// The outcome only claims the disposition when the CAS actually
    /// committed. A stale CAS means another writer already settled the row:
    /// the result is `ServiceOutcome::Stale` with the authoritative row, and
    /// this service's disposition grants nothing.
    fn settle(
        &self,
        db: &mut Database,
        current: &ToolCallLedgerRecord,
        terminal: Terminal,
    ) -> Result<ServiceOutcome, ServiceError> {
        let Terminal { state, result } = terminal;
        let transport_correlation = TransportCorrelation {
            tool_server_id: current.operation_binding.tool_server_id.clone(),
            tool_name: current.operation_binding.tool_name.clone(),
            tool_server_generation: current.operation_binding.tool_server_generation,
            server_request_id: current.operation_binding.server_request_id.clone(),
            outbound_digest: current
                .outbound_digest
                .clone()
                .ok_or(ServiceError::InvalidRecord)?,
        };
        let expected = CasKey {
            module_id: current.operation_binding.module_id.clone(),
            operation_id: current.operation_binding.operation_id.clone(),
            expected_ledger_revision: current.ledger_revision,
            expected_state: current.state,
            correlation: Some(transport_correlation),
        };
        let terminal_digest = canonicalize(&result)
            .map(|(_bytes, digest)| digest)
            .map_err(|_| ServiceError::InvalidRecord)?;
        let terminal_record = ToolCallLedgerRecord {
            ledger_revision: 3,
            state,
            outbound_digest: current.outbound_digest.clone(),
            terminal_result: Some(result.clone()),
            terminal_result_digest: Some(terminal_digest),
            ..current.clone()
        };
        match cas_terminal(db.connection_mut(), &expected, &terminal_record) {
            Ok(CasOutcome::Committed { record }) => Ok(match state {
                LedgerState::Succeeded => ServiceOutcome::Succeeded { record, result },
                LedgerState::Failed => ServiceOutcome::Failed { record, result },
                _ => ServiceOutcome::Unknown { record, result },
            }),
            Ok(CasOutcome::Stale { authoritative }) => Ok(ServiceOutcome::Stale {
                authoritative: Some(authoritative),
            }),
            Err(error) => Err(ServiceError::Storage(error)),
        }
    }
}
fn abort_if_settlement_not_committed(
    transport: &mut dyn ToolTransport,
    settled: &Result<ServiceOutcome, ServiceError>,
) {
    if !matches!(settled.as_ref(), Ok(ServiceOutcome::Succeeded { .. })) {
        transport.abort();
    }
}

/// Build the `SUCCEEDED` result with exact correlation evidence.
fn succeeded_result(binding: &SendPermitBinding, output: serde_json::Value) -> ToolResult {
    ToolResult {
        operation_id: binding.operation_id.clone(),
        status: ToolStatus::Succeeded,
        output,
        error: None,
        server_request_id: Some(binding.server_request_id.clone()),
    }
}

/// Build the authoritative `FAILED` result for a complete response whose
/// present output violates the frozen output schema. The output is not
/// copied into the public result; the Tool Broker authority is `applied`.
fn output_invalid_result(binding: &SendPermitBinding) -> ToolResult {
    ToolResult {
        operation_id: binding.operation_id.clone(),
        status: ToolStatus::Failed,
        output: serde_json::Value::Null,
        error: Some(ToolError {
            code: ToolErrorCode::OutputInvalid,
            retryable: false,
            outcome: ErrorOutcome::Applied,
            message: "upstream output failed the frozen output schema".into(),
            details: Default::default(),
        }),
        server_request_id: Some(binding.server_request_id.clone()),
    }
}

/// Build the terminal `UNKNOWN` result (`TOOL_EXTERNAL_OUTCOME_UNKNOWN`).
fn unknown_outcome_result(binding: &SendPermitBinding) -> ToolResult {
    ToolResult::unknown_outcome(binding.operation_id.clone())
}

/// One terminal disposition to commit.
struct Terminal {
    state: LedgerState,
    result: ToolResult,
}

impl Terminal {
    fn succeeded(result: ToolResult) -> Self {
        Self {
            state: LedgerState::Succeeded,
            result,
        }
    }
    fn failed(result: ToolResult) -> Self {
        Self {
            state: LedgerState::Failed,
            result,
        }
    }
    fn unknown(result: ToolResult) -> Self {
        Self {
            state: LedgerState::Unknown,
            result,
        }
    }
}

/// The classification of one response frame.
enum Classification {
    Succeeded(serde_json::Value),
    OutputInvalid,
    Rejected,
}

/// The closed JSON-RPC 2.0 response envelope the service admits. Any other
/// member is a schema failure; `deny_unknown_fields` keeps it closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResponseEnvelope {
    pub jsonrpc: String,
    pub id: String,
    /// `None` means the member was absent; `Some(Value::Null)` means it was
    /// present with JSON null.
    #[serde(default, deserialize_with = "deserialize_present_value")]
    pub result: Option<serde_json::Value>,
    /// Presence is retained for the same reason as `result`; any present
    /// error remains ambiguous and cannot prove `not_applied`.
    #[serde(default, deserialize_with = "deserialize_present_value")]
    pub error: Option<serde_json::Value>,
}

fn deserialize_present_value<'de, D>(deserializer: D) -> Result<Option<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    serde_json::Value::deserialize(deserializer).map(Some)
}

/// Resolve the retained output schema and parse its typed digest from the
/// frozen server contract. The contract is already bound into the ledger
/// operation, so no live registry lookup is permitted here.
fn frozen_output_schema(
    binding: &ToolOperationBinding,
) -> Option<(&CanonicalJsonValue, Sha256Digest)> {
    let tools = match binding.server_contract.get("tools")? {
        CanonicalJsonValue::Object(tools) => tools,
        _ => return None,
    };
    let tool = match tools.get(&binding.tool_name)? {
        CanonicalJsonValue::Object(tool) => tool,
        _ => return None,
    };
    let schema = tool.get("output_schema")?;
    let digest = match tool.get("output_schema_digest")? {
        CanonicalJsonValue::String(digest) => digest.parse().ok()?,
        _ => return None,
    };
    Some((schema, digest))
}

/// Total number of object members across the whole value tree. A response
/// with more than this many members is rejected.
fn count_members(value: &CanonicalJsonValue) -> usize {
    match value {
        CanonicalJsonValue::Object(map) => {
            let mut total = map.len();
            for (_name, member) in map.iter() {
                total += count_members(member);
            }
            total
        }
        CanonicalJsonValue::Array(items) => items.iter().map(count_members).sum(),
        _ => 0,
    }
}
