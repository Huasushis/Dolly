use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchState {
    Prepared,
    Started,
    TransportStarted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiveResultStatus {
    Success,
    Retryable,
    Permanent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolveQuarantineResolution {
    Retry,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CoreCommand {
    InstallConfig(InstallConfigCommand),
    InstallGraph(InstallGraphCommand),
    Ingress(IngressCommand),
    RuntimeEvent(RuntimeEventCommand),
    GrantStorageWriter(GrantStorageWriterCommand),
    ReleaseStorageWriter(ReleaseStorageWriterCommand),
    BuildManifest(BuildManifestCommand),
    IssueLease(IssueLeaseCommand),
    DispatchLease(DispatchLeaseCommand),
    ReceiveResult(ReceiveResultCommand),
    BeginFence(BeginFenceCommand),
    RecordReplayEvidence(RecordReplayEvidenceCommand),
    FenceComplete(FenceCompleteCommand),
    ApplyResult(ApplyResultCommand),
    CancelActivation(CancelActivationCommand),
    ResolveQuarantine(ResolveQuarantineCommand),
    CompleteQuarantineFence(CompleteQuarantineFenceCommand),
    DeadLetterRange(DeadLetterRangeCommand),
    SkipRange(SkipRangeCommand),
    LossyEvict(LossyEvictCommand),
    Recover(RecoverCommand),
}
impl CoreCommand {
    pub fn command_id(&self) -> &str {
        match self {
            Self::InstallConfig(c) => &c.command_id,
            Self::InstallGraph(c) => &c.command_id,
            Self::Ingress(c) => &c.command_id,
            Self::RuntimeEvent(c) => &c.command_id,
            Self::GrantStorageWriter(c) => &c.command_id,
            Self::ReleaseStorageWriter(c) => &c.command_id,
            Self::BuildManifest(c) => &c.command_id,
            Self::IssueLease(c) => &c.command_id,
            Self::DispatchLease(c) => &c.command_id,
            Self::ReceiveResult(c) => &c.command_id,
            Self::BeginFence(c) => &c.command_id,
            Self::RecordReplayEvidence(c) => &c.command_id,
            Self::FenceComplete(c) => &c.command_id,
            Self::ApplyResult(c) => &c.command_id,
            Self::CancelActivation(c) => &c.command_id,
            Self::ResolveQuarantine(c) => &c.command_id,
            Self::CompleteQuarantineFence(c) => &c.command_id,
            Self::DeadLetterRange(c) => &c.command_id,
            Self::SkipRange(c) => &c.command_id,
            Self::LossyEvict(c) => &c.command_id,
            Self::Recover(c) => &c.command_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallConfigCommand {
    pub command_id: String,
    pub revision: i64,
    pub effective_config: Value,
    pub digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallGraphCommand {
    pub command_id: String,
    pub revision: i64,
    pub graph: Value,
    pub digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngressCommand {
    pub command_id: String,
    pub runtime_source: String,
    pub ingress_key: String,
    pub operation_digest: String,
    pub block_id: String,
    pub block: Value,
    pub pages: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeEventCommand {
    pub command_id: String,
    pub runtime_source: String,
    pub event_key: String,
    pub operation_digest: String,
    pub block_id: String,
    pub block: Value,
    pub pages: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantStorageWriterCommand {
    pub command_id: String,
    pub owner: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseStorageWriterCommand {
    pub command_id: String,
    pub owner: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BuildManifestCommand {
    pub command_id: String,
    pub activation_id: String,
    pub manifest: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_graph_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_descriptor_revision: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueLeaseCommand {
    pub command_id: String,
    pub activation_id: String,
    pub lease_id: String,
    pub token_digest: String,
    pub extension_connection_id: String,
    pub worker_epoch: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_epoch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_generation: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchLeaseCommand {
    pub command_id: String,
    pub activation_id: String,
    pub lease_id: String,
    pub dispatch_state: DispatchState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_digest: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiveResultCommand {
    pub command_id: String,
    pub activation_id: String,
    pub lease_id: String,
    pub result_digest: String,
    pub status: ReceiveResultStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeginFenceCommand {
    pub command_id: String,
    pub activation_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordReplayEvidenceCommand {
    pub command_id: String,
    pub activation_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FenceCompleteCommand {
    pub command_id: String,
    pub activation_id: String,
    pub retry_delay: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyResultCommand {
    pub command_id: String,
    pub activation_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancelActivationCommand {
    pub command_id: String,
    pub activation_id: String,
    pub reason: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolveQuarantineCommand {
    pub command_id: String,
    pub activation_id: String,
    pub resolution: ResolveQuarantineResolution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_delay: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompleteQuarantineFenceCommand {
    pub command_id: String,
    pub activation_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeadLetterRangeCommand {
    pub command_id: String,
    pub subscription_id: String,
    pub start: i64,
    pub end_exclusive: i64,
    pub reason: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkipRangeCommand {
    pub command_id: String,
    pub subscription_id: String,
    pub start: i64,
    pub end_exclusive: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LossyEvictCommand {
    pub command_id: String,
    pub page_id: String,
    pub start: i64,
    pub end_exclusive: i64,
    pub reason: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoverCommand {
    pub command_id: String,
    pub persisted_next_page_seq: i64,
}
