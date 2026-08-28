//! `dolly-storage` owns the attested SQLite connection, Host authority
//! records, and the Page/Activation transaction engine.
//!
//! The engine executes the pure reducer inside one immediate SQLite
//! transaction, verifies the canonical durable projection on every load, and
//! publishes no semantic acknowledgement before commit.

pub mod attestation;
pub mod database;
pub mod effect_journal;
pub mod error;
pub mod grant_fence;
pub mod host_authority;
pub mod module_state;
pub mod linux_host_verification;
pub mod mcp_readiness;
pub mod restore_identity;
pub mod runtime_binding;
pub mod tool_broker_authority;
pub mod tool_ledger;
pub mod transaction;
pub use attestation::{
    LoadedSqlite, ReleaseAttestation, SQLITE_VERSION_NUMBER_MIN, SqliteBuildGate,
    VerifiedSqliteBuild, release_attestation,
};
pub use database::{
    ConnectionConfiguration, Database, SCHEMA_VERSION, probe_loaded_sqlite, required,
};
pub use error::{StorageError, StorageResult};
pub use restore_identity::{
    MAX_SAFE_JSON_INTEGER, RestoreIdentityAuditEvent, RestoreIdentityBackupEntry,
    RestoreIdentityMode, RestoreIdentityModesPlan, RestoreIdentityPlannerError,
    RestoreIdentityPlannerErrorCode, evaluate_restore_identity_modes,
};
pub use transaction::{
    CoreTransaction, GrantFenceExpectation, HostCapabilityGrant, HostConnectionAuthority,
    HOST_CAPABILITY_GRANT_RECORD_SCHEMA, CORE_ENGINE_SCHEMA_SQL, CORE_ENGINE_SCHEMA_VERSION,
    SqliteCoreStore, SqliteCoreTransaction, initialize_core_engine_schema,
};
pub use module_state::ModuleStateProjection;
