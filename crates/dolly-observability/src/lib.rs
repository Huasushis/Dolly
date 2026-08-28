//! Independent bounded observability and Module-state evidence primitives.
//!
//! The logging and replay products are explicitly non-authoritative: they do
//! not advance Core state, issue execution authority, carry Host capabilities,
//! or commit effects. The backup product is a single-Module, canonical,
//! digest-bound value built only from a typed Host state projection; it can
//! return verified bytes only after identity and revision checks. Daemon,
//! configuration, filesystem, network, effect, and Event Journal orchestration
//! intentionally remain outside this crate.

mod security;

pub mod backup;
pub mod logs;
pub mod replay;

pub use backup::{BackupError, ModuleBackup, ModuleRestoreRequest, RestoredModuleState};
pub use dolly_storage::ModuleStateProjection;
pub use logs::{
    BoundedLogBuffer, HostLogContext, HostLogEvent, LogError, LogLevel, LogLimits, LogPushOutcome,
    StructuredLogEvent,
};
pub use replay::{
    ReplayError, ReplayEvidence, ReplayLimits, ReplayMode, ReplayRecord, ReplayRecorder,
};
