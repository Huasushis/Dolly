//! `dolly-storage` first slice: the pure SQLite build-attestation gate.
//!
//! This crate intentionally has no SQLite, Tokio, or network dependency. It
//! provides the closed attestation types and the gate that enforces
//! REQ-TECH-003 / ADR 0006 on data supplied from the real library probe
//! (added with the provisioned backend), plus the frozen `CoreTransaction`
//! boundary required by INV-TXN-001 for the future atomic transition and
//! journal/outbox implementation.

pub mod attestation;
pub mod error;
pub mod transaction;

pub use attestation::{
    LoadedSqlite, ReleaseAttestation, SQLITE_VERSION_NUMBER_MIN, SqliteBuildGate,
    VerifiedSqliteBuild,
};
pub use error::{StorageError, StorageResult};
pub use transaction::CoreTransaction;
