//! Dolly Core domain types: identifiers, numbers, timestamps, and error envelopes.
//!
//! This crate provides the standard domain scalar types used by the Dolly
//! runtime. All types implement serde Serialize/Deserialize with rejection
//! semantics matching the Dolly Core specification.

mod error_envelope;
mod identifiers;
mod numbers;
mod shared;
mod timestamp;

pub use error_envelope::{
    CoreErrorCode, CoreErrorEnvelope, CoreOutcome, CursorSpan, DeliveryKey, FrozenConfig,
};
pub use identifiers::{
    ActionId, ActionName, ActivationId, BlockId, DaemonInstallationId, ExtensionId, IngressId,
    InstanceId, LeaseToken, ModuleId, ModuleStorageScopeId, PageId, RuntimeEventId, TraceId,
    UuidV7, WorkerEpoch,
};
pub use numbers::{
    Attempt, CommitSeq, ConfigRevision, DescriptorRevision, ExtensionGeneration, GraphRevision,
    LeaseGeneration, PageSeq, SafeU53,
};
pub use timestamp::Timestamp;
