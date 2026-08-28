use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const PROJECTION_KIND: &str = "dolly.state-projection/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionOutcome {
    Committed,
    RolledBack,
    RolledBackWithSafetyStop,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceMode {
    Running,
    RecoveryRequired,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationState {
    #[default]
    Ready,
    Leased,
    Dispatched,
    Fencing,
    ResultStaged,
    CommitBlocked,
    Committed,
    RetryWait,
    Quarantined,
    Cancelled,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorOutcome {
    NotApplied,
    Applied,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageObservation {
    BeforeCommit,
    AfterCommit,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplayEvidenceObservation {
    NotStarted,
    Succeeded,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscriptionRecord {
    pub cursor: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageRecord {
    pub page_seq: i64,
    pub entries: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lossy: Option<bool>,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedResult {
    pub expected_cursors: BTreeMap<String, i64>,
    pub outputs: Vec<Value>,
    pub admitted_pages: BTreeMap<String, Vec<PageRecord>>,
    pub projected_admission_entries: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation: Option<Value>,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivationRecord {
    pub state: ActivationState,
    pub attempt: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authoritative_disposition: Option<ActivationState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged_result: Option<StagedResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_attempt_authorization: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_evidence: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_delay: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_generation: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation: Option<Value>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CoreSnapshot {
    pub projection_kind: String,
    pub mode: InstanceMode,
    pub next_commit_seq: i64,
    pub next_page_seq: i64,
    pub storage_writer_owner: Option<String>,
    pub config: Value,
    pub graph: Value,
    pub ingress: BTreeMap<String, IngressRecord>,
    pub runtime_events: BTreeMap<String, RuntimeEventRecord>,
    pub blocks: BTreeMap<String, Value>,
    pub deliveries: Vec<Value>,
    pub pages: BTreeMap<String, Vec<PageRecord>>,
    pub subscriptions: BTreeMap<String, SubscriptionRecord>,
    pub manifests: BTreeMap<String, Value>,
    pub activations: BTreeMap<String, ActivationRecord>,
    pub leases: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub host_request_reservations: BTreeMap<String, Value>,
    pub quarantines: BTreeMap<String, Value>,
    pub generations: Vec<Value>,
    pub current_generation: Option<i64>,
    pub outputs: Vec<Value>,
    pub lossy_gaps: Vec<Value>,
    pub volatile_lossy_entries: Vec<Value>,
    pub journal: Vec<CoreEvent>,
    pub security_incidents: Vec<Value>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngressRecord {
    pub operation_digest: String,
    pub block_id: String,
    pub pages: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeEventRecord {
    pub operation_digest: String,
    pub block_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoreEvent {
    pub event: String,
    pub commit_seq: i64,
    pub command_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoreError {
    pub code: String,
    pub retryable: bool,
    pub outcome: ErrorOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostResultVerification {
    pub verified: bool,
    pub activation_id: String,
    pub lease_id: String,
    pub token_digest: String,
    pub attempt: i64,
    pub extension_connection_id: String,
    pub worker_epoch: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_generation: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_digest: Option<String>,
    pub result_digest: String,
    pub payload_valid: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostReplayEvidence {
    pub verified: bool,
    pub activation_id: String,
    pub source_attempt: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_generation: Option<i64>,
    pub observation: ReplayEvidenceObservation,
    pub record: Value,
    pub digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostFenceVerification {
    pub verified: bool,
    pub activation_id: String,
    pub source_attempt: i64,
    pub execution_slot_empty: bool,
    pub proof_digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryVerification {
    pub ordered_checks_complete: bool,
    pub invariants_valid: bool,
    pub persisted_values_valid: bool,
    pub process_fences_valid: bool,
    pub staged_results_valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentInput {
    pub now: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_jitter: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crash_point: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_observation: Option<StorageObservation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_result_verification: Option<HostResultVerification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_replay_evidence: Option<HostReplayEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_fence_verification: Option<HostFenceVerification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_verification: Option<RecoveryVerification>,
}

pub fn empty_core_snapshot() -> CoreSnapshot {
    CoreSnapshot {
        projection_kind: PROJECTION_KIND.to_string(),
        mode: InstanceMode::Running,
        next_commit_seq: 1,
        next_page_seq: 1,
        storage_writer_owner: None,
        config: Value::Object(Default::default()),
        graph: Value::Object(Default::default()),
        ingress: BTreeMap::new(),
        runtime_events: BTreeMap::new(),
        blocks: BTreeMap::new(),
        deliveries: Vec::new(),
        pages: BTreeMap::new(),
        subscriptions: BTreeMap::new(),
        manifests: BTreeMap::new(),
        activations: BTreeMap::new(),
        leases: BTreeMap::new(),
        host_request_reservations: BTreeMap::new(),
        quarantines: BTreeMap::new(),
        generations: Vec::new(),
        current_generation: None,
        outputs: Vec::new(),
        lossy_gaps: Vec::new(),
        volatile_lossy_entries: Vec::new(),
        journal: Vec::new(),
        security_incidents: Vec::new(),
    }
}
