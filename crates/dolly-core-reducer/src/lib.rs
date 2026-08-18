//! Deterministic pure Core reference reducer for the closed 21-command model.
//! All authority, clock, crash, and storage observations arrive in the explicit
//! input tape; the reducer performs no input/output.

mod command;
mod disposition;
pub mod neighbors;
mod projection;
mod reducer;
mod types;

pub use command::{
    ApplyResultCommand, BeginFenceCommand, BuildManifestCommand, CancelActivationCommand,
    CompleteQuarantineFenceCommand, CoreCommand, DeadLetterRangeCommand, DispatchLeaseCommand,
    DispatchState, FenceCompleteCommand, GrantStorageWriterCommand, IngressCommand,
    InstallConfigCommand, InstallGraphCommand, IssueLeaseCommand, LossyEvictCommand,
    ReceiveResultCommand, ReceiveResultStatus, RecordReplayEvidenceCommand, RecoverCommand,
    ReleaseStorageWriterCommand, ResolveQuarantineCommand, ResolveQuarantineResolution,
    RuntimeEventCommand, SkipRangeCommand,
};
pub use disposition::{Disposition, DispositionShapeError, validate_disposition_candidate};
pub use neighbors::{
    AUTHORIZED_CONTRACTS_TOKEN, CONTRACT_TOKEN, FrozenDescriptor, INPUT_PRODUCER,
    NeighborDescriptor, NeighborGraph, OUTPUT_CONSUMER, build_neighbor_descriptors,
};
pub use projection::{hash_core_state, project_core_state};
pub use reducer::{SafetyStop, Transition, reduce};
pub use types::{
    ActivationRecord, ActivationState, CoreError, CoreEvent, CoreSnapshot, EnvironmentInput,
    ErrorOutcome, HostFenceVerification, HostReplayEvidence, HostResultVerification, IngressRecord,
    InstanceMode, PROJECTION_KIND, PageRecord, RecoveryVerification, ReplayEvidenceObservation,
    RuntimeEventRecord, StagedResult, StorageObservation, SubscriptionRecord, TransitionOutcome,
    empty_core_snapshot,
};
