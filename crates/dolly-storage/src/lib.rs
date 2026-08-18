//! `dolly-storage` first slice: the SQLite build-attestation gate and the
//! DB-open slice (open, PRAGMA, lock, migration).
//!
//! The crate depends on the bundled SQLite (`rusqlite` +
//! `libsqlite3-sys`, ADR 0006/REQ-TECH-003) and deliberately has no Tokio or
//! network dependency. It provides the closed attestation types and the gate
//! that enforces REQ-TECH-003 / ADR 0006 on the real library probe, the
//! instance-open sequence of storage-and-recovery §2/§10, plus the frozen
//! `CoreTransaction` boundary required by INV-TXN-001 for the future atomic
//! transition and journal/outbox implementation.

pub mod attestation;
pub mod database;
pub mod error;
pub mod transaction;

pub use attestation::{
    LoadedSqlite, ReleaseAttestation, SQLITE_VERSION_NUMBER_MIN, SqliteBuildGate,
    VerifiedSqliteBuild, release_attestation,
};
pub use database::{
    ConnectionConfiguration, Database, SCHEMA_VERSION, probe_loaded_sqlite, required,
};
pub use error::{StorageError, StorageResult};
pub use transaction::CoreTransaction;
