//! Immutable authority handed to the later execution consumer.
//!
//! The premise deliberately carries identities, fences, digests, ordering, and
//! replay scope only. It does not contain a Block draft, an effect operation,
//! a capability, or a callable consumer. Those remain outside this gate.

use dolly_core_domain::WorkerEpoch;
use std::fmt;

/// The identity of the one Activation and Module being prepared.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionIdentity {
    activation_id: String,
    module_id: String,
}

impl ExecutionIdentity {
    pub(crate) fn new(activation_id: String, module_id: String) -> Self {
        Self {
            activation_id,
            module_id,
        }
    }

    /// The Runtime-assigned Activation identity.
    pub fn activation_id(&self) -> &str {
        &self.activation_id
    }

    /// The configured Module identity.
    pub fn module_id(&self) -> &str {
        &self.module_id
    }
}

/// The durable fence that must remain current for the prepared attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionFence {
    lease_id: String,
    reservation_id: String,
    request_id: String,
    worker_epoch: WorkerEpoch,
    worker_epoch_fence: i64,
    incarnation_revision: i64,
    extension_generation: i64,
    lease_generation: i64,
    extension_connection_id: String,
}

impl ExecutionFence {
    pub(crate) fn new(
        lease_id: String,
        reservation_id: String,
        request_id: String,
        worker_epoch: WorkerEpoch,
        worker_epoch_fence: i64,
        incarnation_revision: i64,
        extension_generation: i64,
        lease_generation: i64,
        extension_connection_id: String,
    ) -> Self {
        Self {
            lease_id,
            reservation_id,
            request_id,
            worker_epoch,
            worker_epoch_fence,
            incarnation_revision,
            extension_generation,
            lease_generation,
            extension_connection_id,
        }
    }

    /// The unique durable lease identity.
    pub fn lease_id(&self) -> &str {
        &self.lease_id
    }
    /// The Host-allocated JSON-RPC request identity bound to this attempt.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    /// The opaque Host request reservation bound to this attempt.
    pub fn reservation_id(&self) -> &str {
        &self.reservation_id
    }

    /// The canonical typed Worker incarnation bound to this attempt.
    pub fn worker_epoch(&self) -> &WorkerEpoch {
        &self.worker_epoch
    }

    /// The legacy numeric fence retained by the accepted Core contract.
    pub fn worker_epoch_fence(&self) -> i64 {
        self.worker_epoch_fence
    }

    /// The non-reusable Host incarnation revision bound to this attempt.
    pub fn incarnation_revision(&self) -> i64 {
        self.incarnation_revision
    }

    /// The Extension process generation bound to this attempt.
    pub fn extension_generation(&self) -> i64 {
        self.extension_generation
    }

    /// The monotonic per-Activation lease fence.
    ///
    /// WP-004 persists the attempt number as the per-lease monotonic fence;
    /// this gate exposes that durable value under the normative fence name.
    pub fn lease_generation(&self) -> i64 {
        self.lease_generation
    }

    /// The accepted WP-004 attempt number, represented by `lease_generation`.
    pub fn attempt(&self) -> i64 {
        self.lease_generation
    }

    /// The authenticated Extension connection bound to this attempt.
    pub fn extension_connection_id(&self) -> &str {
        &self.extension_connection_id
    }
}

/// Digests that bind the premise to immutable Core inputs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionDigests {
    graph_digest: String,
    descriptor_digest: String,
    manifest_digest: String,
    effective_config_digest: String,
    effective_config_schema_digest: String,
}

impl ExecutionDigests {
    pub(crate) fn new(
        graph_digest: String,
        descriptor_digest: String,
        manifest_digest: String,
        effective_config_digest: String,
        effective_config_schema_digest: String,
    ) -> Self {
        Self {
            graph_digest,
            descriptor_digest,
            manifest_digest,
            effective_config_digest,
            effective_config_schema_digest,
        }
    }

    /// Digest of the graph snapshot used to build the manifest.
    pub fn graph_digest(&self) -> &str {
        &self.graph_digest
    }

    /// Digest of the receiving Module Descriptor selected by the graph.
    pub fn descriptor_digest(&self) -> &str {
        &self.descriptor_digest
    }

    /// Digest of the complete canonical Activation Manifest.
    pub fn manifest_digest(&self) -> &str {
        &self.manifest_digest
    }

    /// Digest of the frozen effective Module configuration.
    pub fn effective_config_digest(&self) -> &str {
        &self.effective_config_digest
    }

    /// Digest of the frozen effective-configuration schema bundle.
    pub fn effective_config_schema_digest(&self) -> &str {
        &self.effective_config_schema_digest
    }
}

/// One ordered occurrence of an input Block on a Page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputOccurrence {
    page_id: String,
    page_seq: u64,
    commit_seq: u64,
}

impl InputOccurrence {
    pub(crate) fn new(page_id: String, page_seq: u64, commit_seq: u64) -> Self {
        Self {
            page_id,
            page_seq,
            commit_seq,
        }
    }

    pub fn page_id(&self) -> &str {
        &self.page_id
    }

    pub fn page_seq(&self) -> u64 {
        self.page_seq
    }

    pub fn commit_seq(&self) -> u64 {
        self.commit_seq
    }
}

/// One manifest input item in first-occurrence order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputItemOrder {
    block_id: String,
    block_digest: String,
    occurrences: Vec<InputOccurrence>,
}

impl InputItemOrder {
    pub(crate) fn new(
        block_id: String,
        block_digest: String,
        occurrences: Vec<InputOccurrence>,
    ) -> Self {
        Self {
            block_id,
            block_digest,
            occurrences,
        }
    }

    pub fn block_id(&self) -> &str {
        &self.block_id
    }

    pub fn block_digest(&self) -> &str {
        &self.block_digest
    }

    pub fn occurrences(&self) -> &[InputOccurrence] {
        &self.occurrences
    }
}

/// One frozen half-open cursor interval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CursorSpan {
    page_id: String,
    from_page_seq: u64,
    to_page_seq: u64,
}

impl CursorSpan {
    pub(crate) fn new(page_id: String, from_page_seq: u64, to_page_seq: u64) -> Self {
        Self {
            page_id,
            from_page_seq,
            to_page_seq,
        }
    }

    pub fn page_id(&self) -> &str {
        &self.page_id
    }

    pub fn from_page_seq(&self) -> u64 {
        self.from_page_seq
    }

    pub fn to_page_seq(&self) -> u64 {
        self.to_page_seq
    }
}

/// One frozen lossy input gap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LossyGap {
    page_id: String,
    from_page_seq: Option<u64>,
    to_page_seq: u64,
    reason: String,
}

impl LossyGap {
    pub(crate) fn new(
        page_id: String,
        from_page_seq: Option<u64>,
        to_page_seq: u64,
        reason: String,
    ) -> Self {
        Self {
            page_id,
            from_page_seq,
            to_page_seq,
            reason,
        }
    }

    pub fn page_id(&self) -> &str {
        &self.page_id
    }

    pub fn from_page_seq(&self) -> Option<u64> {
        self.from_page_seq
    }

    pub fn to_page_seq(&self) -> u64 {
        self.to_page_seq
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }
}

/// The immutable ordering and fan-out scope frozen by the Manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionOrder {
    input_items: Vec<InputItemOrder>,
    cursor_spans: Vec<CursorSpan>,
    lossy_gaps: Vec<LossyGap>,
    output_page_ids: Vec<String>,
}

impl ExecutionOrder {
    pub(crate) fn new(
        input_items: Vec<InputItemOrder>,
        cursor_spans: Vec<CursorSpan>,
        lossy_gaps: Vec<LossyGap>,
        output_page_ids: Vec<String>,
    ) -> Self {
        Self {
            input_items,
            cursor_spans,
            lossy_gaps,
            output_page_ids,
        }
    }

    /// Input Blocks and their ordered Page occurrences.
    pub fn input_items(&self) -> &[InputItemOrder] {
        &self.input_items
    }

    /// Frozen durable cursor intervals.
    pub fn cursor_spans(&self) -> &[CursorSpan] {
        &self.cursor_spans
    }

    /// Frozen lossy gaps that remain part of replay scope.
    pub fn lossy_gaps(&self) -> &[LossyGap] {
        &self.lossy_gaps
    }

    /// The sorted, immutable output Page set.
    pub fn output_page_ids(&self) -> &[String] {
        &self.output_page_ids
    }
}

/// The replay contract selected by the receiving Descriptor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayScope {
    mode: ReplayMode,
    evidence: ReplayEvidence,
    ledger_namespace: Option<String>,
    ledger_schema_version: Option<String>,
    ledger_location: Option<String>,
}

impl ReplayScope {
    pub(crate) fn new(
        mode: ReplayMode,
        evidence: ReplayEvidence,
        ledger_namespace: Option<String>,
        ledger_schema_version: Option<String>,
        ledger_location: Option<String>,
    ) -> Self {
        Self {
            mode,
            evidence,
            ledger_namespace,
            ledger_schema_version,
            ledger_location,
        }
    }

    pub fn mode(&self) -> ReplayMode {
        self.mode
    }

    pub fn evidence(&self) -> ReplayEvidence {
        self.evidence
    }

    pub fn ledger_namespace(&self) -> Option<&str> {
        self.ledger_namespace.as_deref()
    }

    pub fn ledger_schema_version(&self) -> Option<&str> {
        self.ledger_schema_version.as_deref()
    }

    pub fn ledger_location(&self) -> Option<&str> {
        self.ledger_location.as_deref()
    }
}

/// Whether an uncertain started attempt may be replayed automatically.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayMode {
    NeverAutoRetry,
    FencedReplay,
}

/// Evidence required by the replay contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayEvidence {
    None,
    PureCompute,
    ActivationLedger,
}

/// The complete, immutable G1 authority premise.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionPremise {
    identity: ExecutionIdentity,
    fence: ExecutionFence,
    digests: ExecutionDigests,
    order: ExecutionOrder,
    replay_scope: ReplayScope,
}

impl ExecutionPremise {
    pub(crate) fn new(
        identity: ExecutionIdentity,
        fence: ExecutionFence,
        digests: ExecutionDigests,
        order: ExecutionOrder,
        replay_scope: ReplayScope,
    ) -> Self {
        Self {
            identity,
            fence,
            digests,
            order,
            replay_scope,
        }
    }

    pub fn identity(&self) -> &ExecutionIdentity {
        &self.identity
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }

    pub fn digests(&self) -> &ExecutionDigests {
        &self.digests
    }

    pub fn order(&self) -> &ExecutionOrder {
        &self.order
    }

    pub fn replay_scope(&self) -> &ReplayScope {
        &self.replay_scope
    }
}

impl fmt::Display for ReplayMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NeverAutoRetry => "never_auto_retry",
            Self::FencedReplay => "fenced_replay",
        })
    }
}

impl fmt::Display for ReplayEvidence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::None => "none",
            Self::PureCompute => "pure_compute",
            Self::ActivationLedger => "activation_ledger",
        })
    }
}
