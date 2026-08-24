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

use std::mem;
use std::process::Child;
use std::time::{Instant, SystemTime};
use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_storage::effect_journal::{
    EffectJournalIntentAuthority, retain_settled_effect_journal, settle_pending_effect_journal,
    settle_unknown_intent,
};
use dolly_storage::mcp_readiness::{McpReadinessError, McpTransportReadiness};
use dolly_storage::tool_broker_authority::{
    ToolBrokerAuthorityError, ToolDispatchAuthority, revalidate_tool_dispatch_authority,
    validate_dispatch_binding,
};
use dolly_storage::runtime_binding::{ProcessGeneration, RuntimeBinding};
use dolly_storage::tool_ledger::{
    CasKey, TransportCorrelation, cas_terminal, cas_to_dispatched, load_exact,
};
use dolly_storage::{Database, StorageError};
use dolly_tool_broker::effect_journal::ExternalEffectJournalRecord;
use dolly_tool_broker::{
    DispatchDisposition, LedgerState, ToolCallLedgerRecord, ToolErrorCode, ToolResult,
};
use crate::ports::RecoveryFacts;

use crate::mcp_stdio::{
    HostMcpStdioInstalledChildAttestation, HostMcpStdioProcessHandle, HostOwnedMcpStdioSession,
    McpStdioProbe, StdioTransportError, StdioTransportLimits, host_session_from_installed_child,
};
use crate::permit::SendPermit;
use crate::service::{ServiceOutcome, ToolDispatchService};

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
    /// The committed permit could not complete its Host-owned MCP stdio
    /// exchange.
    Stdio(String),
}

impl From<ToolBrokerAuthorityError> for DispatchError {
    fn from(error: ToolBrokerAuthorityError) -> Self {
        Self::Authority(error)
    }
}

pub(crate) fn load_authoritative_row(
    db: &Database,
    supplied: &ToolCallLedgerRecord,
) -> Result<ToolCallLedgerRecord, DispatchError> {
    let Some(authoritative) = load_exact(
        db.connection(),
        &supplied.operation_binding.module_id,
        &supplied.operation_binding.operation_id,
    )
    .map_err(DispatchError::Storage)?
    else {
        return Err(DispatchError::InvalidRecord);
    };
    if authoritative != *supplied {
        return Err(DispatchError::InvalidRecord);
    }
    Ok(authoritative)
}
struct SystemClock;

impl crate::ports::Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

pub(crate) fn fenced_facts(
    row: &ToolCallLedgerRecord,
    readiness: &McpTransportReadiness,
    zero_bytes_proved: bool,
) -> RecoveryFacts {
    let clock = SystemClock;
    let fence = crate::ports::FencedFactsProvider {
        zero_bytes_proved,
        readiness,
        clock: &clock,
    };
    crate::ports::RecoveryFactsProvider::facts_for(&fence, row)
}
/// Opaque Host-owned stdio composition handed to the existing authorized
/// dispatch entrypoint. The fields cannot be paired or replaced by callers;
/// the installed-child verifier supplies the session and the Host retains
/// the separate process handle.
pub struct HostMcpStdioInvocation {
    session: HostMcpStdioSessionState,
    host_handle: HostMcpStdioProcessHandle,
    limits: StdioTransportLimits,
    handshake_authority: EffectJournalIntentAuthority,
    handshake_intent: ExternalEffectJournalRecord,
    attestation_digest: Sha256Digest,
    request_bytes: Vec<u8>,
}

pub(crate) enum HostMcpStdioSessionState {
    Raw(HostOwnedMcpStdioSession),
    Prepared(McpStdioProbe),
    Consumed,
}

pub(crate) struct HostMcpStdioInvocationParts {
    pub(crate) session: HostMcpStdioSessionState,
    pub(crate) host_handle: HostMcpStdioProcessHandle,
    pub(crate) handshake_authority: EffectJournalIntentAuthority,
    pub(crate) handshake_intent: ExternalEffectJournalRecord,
    pub(crate) attestation_digest: Sha256Digest,
    pub(crate) limits: StdioTransportLimits,
    pub(crate) request_bytes: Vec<u8>,
}

impl HostMcpStdioInvocation {
    /// Verify an installed Host-owned child, bind it to the current process
    /// generation, and return both the invocation and the separately retained
    /// owner handle. Raw child claims are not trusted by this constructor.
    pub fn from_installed_child(
        child: Child,
        attestation: HostMcpStdioInstalledChildAttestation,
        runtime_binding: &RuntimeBinding,
        process_generation: &ProcessGeneration,
        limits: StdioTransportLimits,
        request_bytes: Vec<u8>,
        database: &Database,
        handshake_authority: &EffectJournalIntentAuthority,
        handshake_intent: &ExternalEffectJournalRecord,
    ) -> Result<(Self, HostMcpStdioProcessHandle), StdioTransportError> {
        let attestation_digest = attestation.attestation_digest();
        if handshake_authority
            .verify_for_initialize(
                database.connection(),
                handshake_intent,
                runtime_binding,
                process_generation,
                attestation.package_digest(),
                attestation.server_id(),
                &attestation_digest,
            )
            .is_err()
        {
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(StdioTransportError::HandshakeAuthorityMismatch);
        }
        let (host_session, retained_handle) =
            host_session_from_installed_child(child, attestation, process_generation)?;
        let invocation = Self {
            session: HostMcpStdioSessionState::Raw(host_session),
            host_handle: retained_handle.clone(),
            limits,
            handshake_authority: handshake_authority.clone(),
            handshake_intent: handshake_intent.clone(),
            attestation_digest,
            request_bytes,
        };
        Ok((invocation, retained_handle))
    }

    pub fn with_request_bytes(mut self, request_bytes: Vec<u8>) -> Self {
        self.request_bytes = request_bytes;
        self
    }
    pub fn set_request_bytes(&mut self, request_bytes: Vec<u8>) {
        self.request_bytes = request_bytes;
    }

    /// Complete the one MCP initialize/initialized lifecycle on this exact
    /// verified child. The resulting readiness is consumer-only evidence; the
    /// child session remains owned by this invocation for the later dispatch.
    /// The caller must present the same opaque durable handshake authority
    /// that was committed before the child was touched.
    pub fn initialize(
        &mut self,
        handshake_authority: &EffectJournalIntentAuthority,
        database: &Database,
        runtime_binding: &RuntimeBinding,
        process_generation: &ProcessGeneration,
        server_id: &str,
        deadline: Instant,
    ) -> Result<McpTransportReadiness, StdioTransportError> {
        if self.handshake_authority != *handshake_authority {
            self.host_handle.terminate();
            return Err(StdioTransportError::HandshakeAuthorityMismatch);
        }
        if self
            .handshake_authority
            .verify_for_initialize(
                database.connection(),
                &self.handshake_intent,
                runtime_binding,
                process_generation,
                &self.handshake_intent.package_digest,
                server_id,
                &self.attestation_digest,
            )
            .is_err()
        {
            self.host_handle.terminate();
            return Err(StdioTransportError::HandshakeAuthorityMismatch);
        }
        let handshake_authority = self.handshake_authority.clone();
        let handshake_intent = self.handshake_intent.clone();
        let attestation_digest = self.attestation_digest.clone();
        self.initialize_with_readiness(
            database,
            runtime_binding,
            process_generation,
            server_id,
            deadline,
            move |connection, runtime, process, server, probe| {
                dolly_storage::mcp_readiness::prove_current_mcp_transport_readiness_with_intent(
                    connection,
                    runtime,
                    process,
                    server,
                    probe,
                    &handshake_authority,
                    &handshake_intent,
                    &handshake_intent.package_digest,
                    &attestation_digest,
                )
            },
        )
    }

    /// Test-support-only initializer. It preserves the same durable
    /// handshake authority checks while substituting the isolated fixture
    /// readiness prover; it is absent from default builds.
    #[cfg(feature = "test-support")]
    pub fn initialize_for_test(
        &mut self,
        handshake_authority: &EffectJournalIntentAuthority,
        database: &Database,
        runtime_binding: &RuntimeBinding,
        process_generation: &ProcessGeneration,
        server_id: &str,
        deadline: Instant,
    ) -> Result<McpTransportReadiness, StdioTransportError> {
        if self.handshake_authority != *handshake_authority
            || self
                .handshake_authority
                .verify_for_initialize(
                    database.connection(),
                    &self.handshake_intent,
                    runtime_binding,
                    process_generation,
                    &self.handshake_intent.package_digest,
                    server_id,
                    &self.attestation_digest,
                )
                .is_err()
        {
            self.host_handle.terminate();
            return Err(StdioTransportError::HandshakeAuthorityMismatch);
        }
        let handshake_authority = self.handshake_authority.clone();
        let handshake_intent = self.handshake_intent.clone();
        let attestation_digest = self.attestation_digest.clone();
        self.initialize_with_readiness(
            database,
            runtime_binding,
            process_generation,
            server_id,
            deadline,
            move |connection, runtime, process, server, probe| {
                dolly_storage::mcp_readiness::test_prove_current_mcp_transport_readiness_with_intent(
                    connection,
                    runtime,
                    process,
                    server,
                    probe,
                    &handshake_authority,
                    &handshake_intent,
                    &handshake_intent.package_digest,
                    &attestation_digest,
                )
            },
        )
    }
    /// Internal readiness prover used only after handshake authority validation.
    fn initialize_with_readiness<F>(
        &mut self,
        database: &Database,
        runtime_binding: &RuntimeBinding,
        process_generation: &ProcessGeneration,
        server_id: &str,
        deadline: Instant,
        prove: F,
    ) -> Result<McpTransportReadiness, StdioTransportError>
    where
        F: FnOnce(
            &rusqlite::Connection,
            &RuntimeBinding,
            &ProcessGeneration,
            &str,
            &mut McpStdioProbe,
        ) -> Result<McpTransportReadiness, McpReadinessError>,
    {
        let session = mem::replace(&mut self.session, HostMcpStdioSessionState::Consumed);
        let HostMcpStdioSessionState::Raw(host_session) = session else {
            self.host_handle.terminate();
            return Err(StdioTransportError::AlreadyInitialized);
        };
        let mut probe = McpStdioProbe::from_host_session(
            host_session,
            self.host_handle.clone(),
            self.limits,
            deadline,
        )?;
        match prove(
            database.connection(),
            runtime_binding,
            process_generation,
            server_id,
            &mut probe,
        ) {
            Ok(readiness) => {
                self.session = HostMcpStdioSessionState::Prepared(probe);
                Ok(readiness)
            }
            Err(error) => {
                probe.abort();
                Err(StdioTransportError::Readiness(error.to_string()))
            }
        }
    }

    fn into_parts(self) -> HostMcpStdioInvocationParts {
        HostMcpStdioInvocationParts {
            session: self.session,
            host_handle: self.host_handle,
            handshake_authority: self.handshake_authority,
            handshake_intent: self.handshake_intent,
            attestation_digest: self.attestation_digest,
            limits: self.limits,
            request_bytes: self.request_bytes,
        }
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
fn recover_operation(
    record: &ToolCallLedgerRecord,
    facts: &RecoveryFacts,
) -> DispatchDisposition {
    if let Some(result) = &record.terminal_result {
        return DispatchDisposition::AlreadyTerminal {
            result: result.clone(),
        };
    }
    match record.state {
        LedgerState::Dispatched => DispatchDisposition::Unknown {
            result: ToolResult::unknown_outcome(record.operation_binding.operation_id.clone()),
        },
        LedgerState::Authorized => {
            let outbound_digest = record
                .recompute_outbound_digest()
                .unwrap_or_else(|| Sha256Digest::compute(&[]));
            if facts.zero_bytes_proved() {
                if facts.exact_generation_ready() && !facts.deadline_expired() {
                    DispatchDisposition::ProposeDispatch {
                        outbound_digest,
                        allow_send_permit: true,
                    }
                } else {
                    DispatchDisposition::ProvedNotApplied {
                        result: ToolResult::failed(
                            record.operation_binding.operation_id.clone(),
                            ToolErrorCode::DispatchNotApplied,
                            "durable zero-byte proof: no request byte was eligible or sent before the dispatch boundary",
                        ),
                    }
                }
            } else {
                DispatchDisposition::ProposeDispatch {
                    outbound_digest,
                    allow_send_permit: false,
                }
            }
        }
        LedgerState::Succeeded | LedgerState::Failed | LedgerState::Unknown => {
            DispatchDisposition::Unknown {
                result: ToolResult::unknown_outcome(record.operation_binding.operation_id.clone()),
            }
        }
    }
}

pub(crate) fn dispatch_operation(
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
pub fn dispatch_operation_authorized(
    db: &mut Database,
    journal_authority: &EffectJournalIntentAuthority,
    authority: &ToolDispatchAuthority,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    readiness: &McpTransportReadiness,
    package_digest: &Sha256Digest,
    row: &ToolCallLedgerRecord,
    service: &ToolDispatchService,
    invocation: HostMcpStdioInvocation,
) -> Result<DispatchOutcome, DispatchError> {
    let row = match load_authoritative_row(db, row) {
        Ok(row) => row,
        Err(error) => {
            invocation.host_handle.terminate();
            return Err(error);
        }
    };
    revalidate_tool_dispatch_authority(
        db,
        authority,
        runtime_binding,
        process_generation,
        readiness,
    )?;
    validate_dispatch_binding(
        authority,
        row.operation_binding.config_revision as i64,
        &row.operation_binding.tool_server_id,
        row.operation_binding.tool_server_generation,
    )?;
    if let Err(error) = journal_authority.verify_for_dispatch(
        db.connection(),
        &row,
        runtime_binding,
        process_generation,
        package_digest,
        &invocation.request_bytes,
    ) {
        invocation.host_handle.terminate();
        return Err(DispatchError::Storage(error));
    }
    // The fence is derived only after the authoritative row, generation, and
    // Claim-bound intent have all been revalidated.
    let facts = fenced_facts(&row, readiness, true);
    let outcome = dispatch_operation(db, &row, &facts)?;
    let permit = match outcome {
        DispatchOutcome::Dispatched {
            record: _,
            permit: Some(permit),
        } => permit,
        DispatchOutcome::Dispatched {
            record,
            permit: None,
        } => {
            // A committed DISPATCHED row without an eligible permit is
            // immediately ambiguous. Terminalize the ledger and journal it
            // before returning; never leave a live child/session behind.
            invocation.host_handle.terminate();
            let terminal = dispatch_operation(db, &record, &facts)?;
            if matches!(terminal, DispatchOutcome::Dispatched { .. }) {
                return match settle_unknown_intent(db.connection_mut(), journal_authority) {
                    Ok(_) => Err(DispatchError::Ambiguous),
                    Err(storage_error) => Err(DispatchError::Storage(storage_error)),
                };
            }
            settle_unknown_intent(db.connection_mut(), journal_authority)
                .map_err(DispatchError::Storage)?;
            return Ok(match terminal {
                DispatchOutcome::Stale { authoritative } => {
                    dispatch_operation(db, &authoritative, &facts)?
                }
                other => other,
            });
        }
        other => {
            invocation.host_handle.terminate();
            settle_and_retain(db)?;
            return Ok(other);
        }
    };
    let parts = invocation.into_parts();
    let request_bytes = parts.request_bytes;
    let service_outcome = match parts.session {
        HostMcpStdioSessionState::Raw(host_session) => service.dispatch_authorized(
            db,
            authority,
            runtime_binding,
            process_generation,
            readiness,
            &parts.handshake_authority,
            &parts.handshake_intent,
            &parts.attestation_digest,
            host_session,
            parts.host_handle,
            parts.limits,
            permit,
            &request_bytes,
        ),
        HostMcpStdioSessionState::Prepared(probe) => service.dispatch_prepared(
            db,
            authority,
            runtime_binding,
            process_generation,
            readiness,
            probe,
            parts.host_handle,
            parts.limits,
            permit,
            &request_bytes,
        ),
        HostMcpStdioSessionState::Consumed => {
            service.settle_admission_unknown(db, parts.host_handle, permit, &request_bytes)
        }
    };
    let service_outcome = match service_outcome {
        Ok(outcome) => outcome,
        Err(error) => match settle_unknown_intent(db.connection_mut(), journal_authority) {
            Ok(_) => return Err(DispatchError::Stdio(error.message())),
            Err(storage_error) => return Err(DispatchError::Storage(storage_error)),
        },
    };
    settle_and_retain(db)?;
    map_service_outcome(service_outcome)
}

/// Reusable Worker-owned dispatch boundary. The initialized probe remains in
/// the invocation after a successful call, so sequential tools/call rows share
/// the same MCP session and Host process.
pub fn dispatch_operation_authorized_reusable(
    db: &mut Database,
    journal_authority: &EffectJournalIntentAuthority,
    authority: &ToolDispatchAuthority,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    readiness: &McpTransportReadiness,
    package_digest: &Sha256Digest,
    row: &ToolCallLedgerRecord,
    service: &ToolDispatchService,
    invocation: &mut HostMcpStdioInvocation,
) -> Result<DispatchOutcome, DispatchError> {
    let row = load_authoritative_row(db, row)?;
    revalidate_tool_dispatch_authority(
        db,
        authority,
        runtime_binding,
        process_generation,
        readiness,
    )?;
    validate_dispatch_binding(
        authority,
        row.operation_binding.config_revision as i64,
        &row.operation_binding.tool_server_id,
        row.operation_binding.tool_server_generation,
    )?;
    if let Err(error) = journal_authority.verify_for_dispatch(
        db.connection(),
        &row,
        runtime_binding,
        process_generation,
        package_digest,
        &invocation.request_bytes,
    ) {
        invocation.host_handle.terminate();
        return Err(DispatchError::Storage(error));
    }
    // This fence is coordinator-owned; Worker callers cannot inject facts.
    let facts = fenced_facts(&row, readiness, true);
    let outcome = dispatch_operation(db, &row, &facts)?;
    let permit = match outcome {
        DispatchOutcome::Dispatched {
            record: _,
            permit: Some(permit),
        } => permit,
        DispatchOutcome::Dispatched {
            record,
            permit: None,
        } => {
            let terminal = dispatch_operation(db, &record, &facts)?;
            if matches!(terminal, DispatchOutcome::Dispatched { .. }) {
                return match settle_unknown_intent(db.connection_mut(), journal_authority) {
                    Ok(_) => Err(DispatchError::Ambiguous),
                    Err(storage_error) => Err(DispatchError::Storage(storage_error)),
                };
            }
            settle_unknown_intent(db.connection_mut(), journal_authority)
                .map_err(DispatchError::Storage)?;
            return Ok(match terminal {
                DispatchOutcome::Stale { authoritative } => {
                    dispatch_operation(db, &authoritative, &facts)?
                }
                other => other,
            });
        }
        other => {
            invocation.host_handle.terminate();
            settle_and_retain(db)?;
            return Ok(other);
        }
    };
    let service_outcome = match &mut invocation.session {
        HostMcpStdioSessionState::Prepared(probe) => service.dispatch_prepared_reusable(
            db,
            authority,
            runtime_binding,
            process_generation,
            readiness,
            probe,
            invocation.host_handle.clone(),
            permit,
            &invocation.request_bytes,
        ),
        HostMcpStdioSessionState::Raw(_) | HostMcpStdioSessionState::Consumed => service
            .settle_admission_unknown(
                db,
                invocation.host_handle.clone(),
                permit,
                &invocation.request_bytes,
            ),
    };
    let service_outcome = match service_outcome {
        Ok(outcome) => outcome,
        Err(error) => match settle_unknown_intent(db.connection_mut(), journal_authority) {
            Ok(_) => return Err(DispatchError::Stdio(error.message())),
            Err(storage_error) => return Err(DispatchError::Storage(storage_error)),
        },
    };
    settle_and_retain(db)?;
    map_service_outcome(service_outcome)
}
fn settle_and_retain(db: &mut Database) -> Result<(), DispatchError> {
    settle_pending_effect_journal(db).map_err(DispatchError::Storage)?;
    retain_settled_effect_journal(db).map_err(DispatchError::Storage)?;
    Ok(())
}
fn map_service_outcome(outcome: ServiceOutcome) -> Result<DispatchOutcome, DispatchError> {
    match outcome {
        ServiceOutcome::Succeeded { record, .. }
        | ServiceOutcome::Failed { record, .. }
        | ServiceOutcome::Unknown { record, .. } => Ok(DispatchOutcome::Terminalized { record }),
        ServiceOutcome::Stale {
            authoritative: Some(record),
        } if record.state.is_terminal() => Ok(DispatchOutcome::Unchanged { record }),
        ServiceOutcome::Stale {
            authoritative: Some(authoritative),
        } => Ok(DispatchOutcome::Stale { authoritative }),
        ServiceOutcome::Stale {
            authoritative: None,
        } => Err(DispatchError::InvalidRecord),
    }
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
