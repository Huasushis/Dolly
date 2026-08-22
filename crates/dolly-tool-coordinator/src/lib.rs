//! Dolly Tool Coordinator — pure orchestration for the durable Tool-call
//! ledger (tool-broker §6, REQ-TOOL-002/006, INV-STORAGE-017).
//!
//! This crate composes the pure decision crate (`dolly-tool-broker`) with
//! the authoritative ledger storage (`dolly-storage`) and nothing else. It
//! owns no transport, Host, or network: the Host injects the readiness,
//! clock, and zero-byte-proof facts through [`ports`], the storage database
//! goes in through `dolly_storage::Database`, and a send permit comes out
//! only after an unambiguous committed `AUTHORIZED -> DISPATCHED`
//! compare-and-set.
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

pub mod dispatch;
pub mod permit;
pub mod ports;
pub mod recovery;
pub mod service;

pub use dispatch::{DispatchError, DispatchOutcome, dispatch_operation};
pub use permit::{SendPermit, SendPermitBinding};
pub use ports::{Clock, FencedFactsProvider, GenerationReadiness, RecoveryFactsProvider};
pub use recovery::{RecoveryOutcome, reopen_recovery};
pub use service::{
    DispatchLimits, ServiceError, ServiceOutcome, ToolDispatchService, ToolResponseEnvelope,
    ToolTransport, TransportOutcome,
};
