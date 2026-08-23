//! Dolly Tool Coordinator — pure orchestration for the durable Tool-call
//! ledger (tool-broker §6, REQ-TOOL-002/006, INV-STORAGE-017).
//!
//! This crate composes the pure decision crate (`dolly-tool-broker`) with
//! authoritative ledger storage (`dolly-storage`) and the private stdio MCP
//! transport seam. It does not own Host startup or public activation: the Host
//! supplies readiness, authority, clock, and zero-byte-proof facts through
//! the existing ports, and a send permit comes out only after an unambiguous
//! committed `AUTHORIZED -> DISPATCHED` compare-and-set.
//!
//! Surface:
//! - [`dispatch_operation`] — orchestrate one row to its durable
//!   disposition; release at most one permit, only after a committed CAS;
//! - [`reopen_recovery`] — deterministic enumeration + pure decision +
//!   disposition application across every nonterminal row after reopen;
//! - [`service::ToolDispatchService`] — consume one permit exactly once,
//!   dispatch through the injected fake-testable `ToolTransport` at most
//!   once, and settle the row after closed correlation/schema/bounds checks;
//! - [`service::ToolResponseEnvelope`] — the closed JSON-RPC response the
//!   service admits;
//! - [`ports::FencedFactsProvider`] — composite Host-owned facts provider;
//! - [`SendPermit`] — the opaque one-use permit a transport consumes once.

extern crate self as dolly_tool_coordinator;
pub mod dispatch;
mod mcp_stdio;
pub mod permit;
pub mod ports;
pub mod recovery;
pub mod service;

#[cfg(test)]
pub(crate) use dispatch::dispatch_operation;

#[cfg(test)]
mod coordinator_tests;
#[cfg(test)]
mod service_tests;

pub(crate) use dispatch::load_authoritative_row;
pub use dispatch::{
    DispatchError, DispatchOutcome, HostMcpStdioInvocation, dispatch_operation_authorized,
    dispatch_operation_authorized_reusable,
};
pub use mcp_stdio::{
    HostMcpStdioInstalledChildAttestation, HostMcpStdioProcessHandle, StdioTransportError,
    StdioTransportLimits,
};
pub use permit::{SendPermit, SendPermitBinding};
pub use ports::{Clock, FencedFactsProvider, GenerationReadiness, RecoveryFactsProvider};
#[cfg(test)]
pub(crate) use recovery::{RecoveryOutcome, reopen_recovery};
pub use service::{
    DispatchLimits, ServiceError, ServiceOutcome, ToolDispatchService, ToolResponseEnvelope,
    ToolTransport, TransportOutcome,
};
