//! Deterministic pure Core reference reducer for the closed 21-command model.
//! All authority, clock, crash, and storage observations arrive in the explicit
//! input tape; the reducer performs no input/output.

mod command;
mod disposition;
mod effective_config;
mod host_ingress;
pub mod neighbors;
mod projection;
mod reducer;
mod types;

pub use command::{
    ApplyResultCommand, BeginFenceCommand, BuildManifestCommand,
    CompleteQuarantineFenceCommand, CoreCommand, DeadLetterRangeCommand, DispatchLeaseCommand,
    DispatchState, FenceCompleteCommand, GrantStorageWriterCommand, IngressCommand,
    InstallConfigCommand, InstallGraphCommand, IssueLeaseCommand, LossyEvictCommand,
    ReceiveResultCommand, ReceiveResultStatus, RecordReplayEvidenceCommand, RecoverCommand,
    ReleaseStorageWriterCommand, ResolveQuarantineCommand, ResolveQuarantineResolution,
    RuntimeEventCommand, SkipRangeCommand,
};
pub use host_ingress::{
    HostIngressPremiseError, IngressAuthorityFacts, IngressIdentity, build_ingress_command,
    canonical_target_page_ids, derive_ingress_identity, derive_ingress_key,
    validate_ingress_request,
};
pub use disposition::{Disposition, DispositionShapeError, validate_disposition_candidate};
pub use effective_config::{
    EFFECTIVE_CONFIG_MAX_PROPERTIES, EFFECTIVE_CONFIG_MAX_PROPERTIES_CODE, EffectiveConfigError,
    MAX_EFFECTIVE_CONFIG_PROPERTIES, NormalizedEffectiveConfig, normalize_effective_config,
};
pub use neighbors::{
    FrozenDescriptor, INPUT_PRODUCER, NeighborDescriptor, NeighborError, NeighborGraph,
    OUTPUT_CONSUMER, build_neighbor_descriptors,
};
pub use projection::{hash_core_state, project_core_state};
pub use reducer::{SafetyStop, Transition, reduce};
pub use types::{
    ActivationRecord, ActivationState, CoreError, CoreEvent, CoreSnapshot, EnvironmentInput,
    ErrorOutcome, HostConnectionIdentity, HostConnectionRecord, HostFenceVerification,
    HostReplayEvidence, HostResultVerification, InstanceMode, PROJECTION_KIND, PageRecord,
    RecoveryVerification, ReplayEvidenceObservation, RuntimeEventRecord, StagedResult,
    StorageObservation, SubscriptionRecord, TransitionOutcome,
    empty_core_snapshot,
};
