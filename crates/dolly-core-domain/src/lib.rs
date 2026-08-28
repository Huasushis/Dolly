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
mod ingress;

pub use error_envelope::{
    CoreErrorCode, CoreErrorEnvelope, CoreOutcome, CursorSpan, DeliveryKey, FrozenConfig,
};
pub use ingress::{
    HOST_INGRESS_PREMISE_RECORD_SCHEMA, HOST_INGRESS_RECORD_SCHEMA, HOST_INGRESS_SCHEMA_VERSION,
    HOST_INGRESS_SUBMIT_METHOD, HostIngressError, HostIngressErrorCode, HostIngressKey,
    HostIngressKind, HostIngressMapping, HostIngressStatus, HostIngressStatusRequest,
    HostIngressSubmitOutcome, HostIngressSubmitRequest, IngressDelivery,
    MAX_HOST_INGRESS_ID_TEXT_BYTES, MAX_HOST_INGRESS_PAYLOAD_JCS_BYTES,
    MAX_HOST_INGRESS_PRINCIPAL_TEXT_BYTES, MAX_HOST_INGRESS_REVISION,
    MAX_HOST_INGRESS_TARGET_PAGES,
};
pub use identifiers::{
    ActionId, ActionName, ActivationId, BlockId, DaemonInstallationId, ExtensionId, IngressId,
    InstanceId, LeaseToken, ModuleId, ModuleStorageScopeId, PageId, RuntimeEventId, SecretRef,
    TraceId, UuidV7, WorkerEpoch,
};
pub use numbers::{
    Attempt, CommitSeq, ConfigRevision, DescriptorRevision, ExtensionGeneration, GraphRevision,
    LeaseGeneration, PageSeq, SafeU53,
};
pub use timestamp::Timestamp;
