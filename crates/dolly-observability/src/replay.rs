use dolly_canonical_json::{
    canonicalize, deserialize_core_json, CanonicalBytes, ParseLimits, Sha256Digest,
};
use dolly_core_domain::{ModuleId, ModuleStorageScopeId};
use dolly_storage::ModuleStateProjection;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const REPLAY_SCHEMA: &str = "dolly.replay-evidence/v1";
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

/// Hard ceilings for one replay evidence document.
pub const MAX_REPLAY_RECORDS: usize = 4_096;
pub const MAX_REPLAY_RECORD_BYTES: usize = 64 * 1024;
pub const MAX_REPLAY_TOTAL_BYTES: usize = 4 * 1024 * 1024;

/// Replay mode is descriptive evidence only. This crate does not execute a
/// replay or grant the authority needed for a live side effect.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplayMode {
    Simulation,
    Verification,
    LiveReplay,
}

/// Finite limits for one deterministic replay evidence record.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReplayLimits {
    max_records: usize,
    max_record_bytes: usize,
    max_total_bytes: usize,
}

impl ReplayLimits {
    pub const fn new(
        max_records: usize,
        max_record_bytes: usize,
        max_total_bytes: usize,
    ) -> Result<Self, ReplayError> {
        if max_records == 0
            || max_records > MAX_REPLAY_RECORDS
            || max_record_bytes == 0
            || max_record_bytes > MAX_REPLAY_RECORD_BYTES
            || max_total_bytes == 0
            || max_total_bytes > MAX_REPLAY_TOTAL_BYTES
        {
            return Err(ReplayError::InvalidLimits);
        }
        Ok(Self {
            max_records,
            max_record_bytes,
            max_total_bytes,
        })
    }

    pub const fn max_records(self) -> usize {
        self.max_records
    }

    pub const fn max_record_bytes(self) -> usize {
        self.max_record_bytes
    }

    pub const fn max_total_bytes(self) -> usize {
        self.max_total_bytes
    }
}

impl Default for ReplayLimits {
    fn default() -> Self {
        Self {
            max_records: MAX_REPLAY_RECORDS,
            max_record_bytes: MAX_REPLAY_RECORD_BYTES,
            max_total_bytes: MAX_REPLAY_TOTAL_BYTES,
        }
    }
}

/// One semantic Host observation admitted to replay evidence.
///
/// The fixed catalog carries only semantic classifications and SHA-256
/// digests. It has no caller text, JSON, map, vector, bytes, serializer,
/// callback material, authority, or upstream premise.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostReplayEvent {
    /// The Host accepted an input whose canonical bytes have this digest.
    InputAccepted { input_digest: Sha256Digest },
    /// The Host completed an input and produced a result with this digest.
    Succeeded {
        input_digest: Sha256Digest,
        result_digest: Sha256Digest,
    },
    /// The Host classified an input as failed, optionally with a result digest.
    Failed {
        input_digest: Sha256Digest,
        result_digest: Option<Sha256Digest>,
    },
    /// The Host skipped an input without carrying a result or failure detail.
    Skipped { input_digest: Sha256Digest },
}

impl HostReplayEvent {
    fn to_wire(&self) -> ReplayEventWire {
        match self {
            Self::InputAccepted { input_digest } => ReplayEventWire::InputAccepted {
                input_digest: input_digest.clone(),
            },
            Self::Succeeded {
                input_digest,
                result_digest,
            } => ReplayEventWire::Succeeded {
                input_digest: input_digest.clone(),
                result_digest: result_digest.clone(),
            },
            Self::Failed {
                input_digest,
                result_digest,
            } => ReplayEventWire::Failed {
                input_digest: input_digest.clone(),
                result_digest: result_digest.clone(),
            },
            Self::Skipped { input_digest } => ReplayEventWire::Skipped {
                input_digest: input_digest.clone(),
            },
        }
    }

    fn from_wire(event: ReplayEventWire) -> Self {
        match event {
            ReplayEventWire::InputAccepted { input_digest } => Self::InputAccepted { input_digest },
            ReplayEventWire::Succeeded {
                input_digest,
                result_digest,
            } => Self::Succeeded {
                input_digest,
                result_digest,
            },
            ReplayEventWire::Failed {
                input_digest,
                result_digest,
            } => Self::Failed {
                input_digest,
                result_digest,
            },
            ReplayEventWire::Skipped { input_digest } => Self::Skipped { input_digest },
        }
    }
}

/// One ordered typed Host observation. Raw record content is not exposed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplayRecord {
    sequence: u64,
    event: HostReplayEvent,
}

impl ReplayRecord {
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn event(&self) -> &HostReplayEvent {
        &self.event
    }

    fn to_wire(&self) -> ReplayRecordWire {
        ReplayRecordWire {
            sequence: self.sequence,
            event: self.event.to_wire(),
        }
    }

    fn from_wire(record: ReplayRecordWire) -> Self {
        Self {
            sequence: record.sequence,
            event: HostReplayEvent::from_wire(record.event),
        }
    }
}

/// A mutable recorder bound to one storage-issued Module projection.
///
/// The projection is issued only by verified Host storage. Its private
/// provenance prevents a caller from choosing or relabeling Module, scope,
/// revision, Host-incarnation binding, or lifecycle identity. The recorder is
/// bounded and append-only. An append that fails validation or a limit check
/// leaves the recorder unchanged. Call [`Self::finish`] to make the immutable,
/// digest-bound evidence document.
///
/// ```compile_fail
/// use dolly_core_domain::{ModuleId, ModuleStorageScopeId};
/// use dolly_observability::ReplayRecorder;
///
/// let module = ModuleId::from_string("memory-main".to_owned()).unwrap();
/// let scope = ModuleStorageScopeId::from_uuid_v7(
///     "0198ab31-6c44-7e8a-b2bb-000000000154".parse().unwrap(),
/// );
/// let _recorder = ReplayRecorder::simulation(module, scope);
/// ```
///
/// ```compile_fail
/// use dolly_observability::ReplayRecorder;
/// use serde_json::json;
///
/// let mut recorder: ReplayRecorder<'_> = todo!();
/// recorder.append(json!({"note": "g3-secret"}), None);
/// ```
pub struct ReplayRecorder<'a> {
    projection: &'a ModuleStateProjection,
    mode: ReplayMode,
    limits: ReplayLimits,
    records: Vec<ReplayRecord>,
}

impl<'a> ReplayRecorder<'a> {
    /// Construct a recorder from the exact storage projection issued by Host.
    pub fn new(
        projection: &'a ModuleStateProjection,
        mode: ReplayMode,
        limits: ReplayLimits,
    ) -> Result<Self, ReplayError> {
        ReplayProvenance::from_projection(projection)?;
        if mode == ReplayMode::LiveReplay {
            return Err(ReplayError::LiveReplayNotSupported);
        }
        Ok(Self {
            projection,
            mode,
            limits,
            records: Vec::new(),
        })
    }

    /// Construct bounded simulation evidence from a storage-issued projection.
    pub fn simulation(projection: &'a ModuleStateProjection) -> Self {
        Self::new(projection, ReplayMode::Simulation, ReplayLimits::default())
            .expect("default replay limits and simulation mode are valid")
    }

    /// Construct bounded verification evidence from a storage-issued projection.
    pub fn verification(projection: &'a ModuleStateProjection) -> Self {
        Self::new(
            projection,
            ReplayMode::Verification,
            ReplayLimits::default(),
        )
        .expect("default replay limits and verification mode are valid")
    }

    pub fn append(&mut self, event: HostReplayEvent) -> Result<u64, ReplayError> {
        let sequence = self
            .records
            .len()
            .checked_add(1)
            .ok_or(ReplayError::SequenceExhausted)? as u64;
        self.append_ordered(sequence, event)
    }

    pub fn append_ordered(
        &mut self,
        sequence: u64,
        event: HostReplayEvent,
    ) -> Result<u64, ReplayError> {
        let expected = self
            .records
            .len()
            .checked_add(1)
            .ok_or(ReplayError::SequenceExhausted)? as u64;
        if sequence != expected || sequence > MAX_SAFE_JSON_INTEGER {
            return Err(ReplayError::Ordering {
                expected,
                actual: sequence,
            });
        }
        let record = ReplayRecord { sequence, event };
        let record_wire = record.to_wire();
        let record_bytes = canonicalize(&record_wire)
            .map_err(|_| ReplayError::Canonical("replay record encoding failed".to_owned()))?
            .0;
        if record_bytes.as_bytes().len() > self.limits.max_record_bytes() {
            return Err(ReplayError::RecordTooLarge {
                actual: record_bytes.as_bytes().len(),
                limit: self.limits.max_record_bytes(),
            });
        }
        if self.records.len() >= self.limits.max_records() {
            return Err(ReplayError::RecordLimit {
                limit: self.limits.max_records(),
            });
        }

        let mut records: Vec<_> = self.records.iter().map(ReplayRecord::to_wire).collect();
        records.push(record_wire);
        let provenance = ReplayProvenance::from_projection(self.projection)?;
        let unsigned = ReplayUnsignedDocument::new(&provenance, self.mode, records);
        let digest = digest_unsigned(&unsigned)?;
        let document = ReplayDocument::from_unsigned(unsigned, digest);
        let bytes = canonicalize(&document)
            .map_err(|_| ReplayError::Canonical("replay evidence encoding failed".to_owned()))?
            .0;
        if bytes.as_bytes().len() > self.limits.max_total_bytes() {
            return Err(ReplayError::TotalLimit {
                actual: bytes.as_bytes().len(),
                limit: self.limits.max_total_bytes(),
            });
        }
        self.records.push(record);
        Ok(sequence)
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn limits(&self) -> ReplayLimits {
        self.limits
    }

    /// Finish the recorder as a digest-bound, non-authoritative evidence value.
    pub fn finish(self) -> Result<ReplayEvidence, ReplayError> {
        let provenance = ReplayProvenance::from_projection(self.projection)?;
        let records: Vec<_> = self.records.iter().map(ReplayRecord::to_wire).collect();
        let unsigned = ReplayUnsignedDocument::new(&provenance, self.mode, records);
        let digest = digest_unsigned(&unsigned)?;
        let document = ReplayDocument::from_unsigned(unsigned, digest.clone());
        let bytes = canonicalize(&document)
            .map_err(|_| ReplayError::Canonical("replay evidence encoding failed".to_owned()))?
            .0;
        if bytes.as_bytes().len() > self.limits.max_total_bytes() {
            return Err(ReplayError::TotalLimit {
                actual: bytes.as_bytes().len(),
                limit: self.limits.max_total_bytes(),
            });
        }
        Ok(ReplayEvidence {
            provenance,
            mode: document.mode,
            records: document
                .records
                .into_iter()
                .map(ReplayRecord::from_wire)
                .collect(),
            digest,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ReplayProvenance {
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    revision: u64,
    durable_commit_seq: u64,
}

impl ReplayProvenance {
    fn from_projection(projection: &ModuleStateProjection) -> Result<Self, ReplayError> {
        validate_identity(projection.revision(), projection.durable_commit_seq())?;
        Ok(Self {
            module_id: projection.module_id().clone(),
            storage_scope_id: projection.storage_scope_id().clone(),
            revision: projection.revision(),
            durable_commit_seq: projection.durable_commit_seq(),
        })
    }
}

fn validate_identity(revision: u64, durable_commit_seq: u64) -> Result<(), ReplayError> {
    if revision == 0
        || revision > MAX_SAFE_JSON_INTEGER
        || durable_commit_seq == 0
        || durable_commit_seq > MAX_SAFE_JSON_INTEGER
    {
        return Err(ReplayError::InvalidIdentity);
    }
    Ok(())
}

/// Immutable deterministic replay evidence. It is explicitly non-authoritative
/// and exposes no operation that can execute work, mint a capability, or commit
/// an effect. Recovery requires the same storage-issued projection that bound
/// the evidence, so wire identity cannot be self-asserted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplayEvidence {
    provenance: ReplayProvenance,
    mode: ReplayMode,
    records: Vec<ReplayRecord>,
    digest: Sha256Digest,
}

impl ReplayEvidence {
    pub fn mode(&self) -> ReplayMode {
        self.mode
    }

    pub fn module_id(&self) -> &ModuleId {
        &self.provenance.module_id
    }

    pub fn storage_scope_id(&self) -> &ModuleStorageScopeId {
        &self.provenance.storage_scope_id
    }

    pub const fn revision(&self) -> u64 {
        self.provenance.revision
    }

    pub const fn durable_commit_seq(&self) -> u64 {
        self.provenance.durable_commit_seq
    }

    pub fn records(&self) -> &[ReplayRecord] {
        &self.records
    }

    pub fn digest(&self) -> &Sha256Digest {
        &self.digest
    }

    pub const fn is_authoritative(&self) -> bool {
        false
    }

    pub fn canonical_bytes(&self) -> Result<CanonicalBytes, ReplayError> {
        let records: Vec<_> = self.records.iter().map(ReplayRecord::to_wire).collect();
        let unsigned = ReplayUnsignedDocument::new(&self.provenance, self.mode, records);
        let digest = digest_unsigned(&unsigned)?;
        if digest != self.digest {
            return Err(ReplayError::DigestMismatch);
        }
        canonicalize(&ReplayDocument::from_unsigned(unsigned, digest))
            .map(|(bytes, _)| bytes)
            .map_err(|_| ReplayError::Canonical("replay evidence encoding failed".to_owned()))
    }

    /// Recover complete canonical evidence bound to the supplied current Host
    /// storage projection. A wire document with a different Module, scope,
    /// revision, or durable commit sequence is rejected.
    pub fn recover_from_bytes(
        input: &[u8],
        projection: &ModuleStateProjection,
    ) -> Result<Self, ReplayError> {
        let limits = ReplayLimits::default();
        if input.is_empty() {
            return Err(ReplayError::Corrupt("replay evidence is empty".to_owned()));
        }
        if input.len() > limits.max_total_bytes() {
            return Err(ReplayError::TotalLimit {
                actual: input.len(),
                limit: limits.max_total_bytes(),
            });
        }
        let document: ReplayDocument = deserialize_core_json(
            input,
            ParseLimits::new(64).expect("64 is a valid semantic depth"),
        )
        .map_err(|_| ReplayError::Corrupt("invalid replay evidence".to_owned()))?;
        let canonical = canonicalize(&document)
            .map_err(|_| ReplayError::Canonical("replay evidence encoding failed".to_owned()))?
            .0;
        if canonical.as_bytes() != input {
            return Err(ReplayError::Corrupt(
                "replay evidence bytes are not canonical JSON".to_owned(),
            ));
        }
        validate_document(&document, projection, limits)?;
        let unsigned = document.unsigned();
        let digest = digest_unsigned(&unsigned)?;
        if digest != document.evidence_digest {
            return Err(ReplayError::DigestMismatch);
        }
        let provenance = ReplayProvenance::from_projection(projection)?;
        Ok(Self {
            provenance,
            mode: document.mode,
            records: document
                .records
                .into_iter()
                .map(ReplayRecord::from_wire)
                .collect(),
            digest,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReplayDocument {
    schema: String,
    non_authoritative: bool,
    mode: ReplayMode,
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    revision: u64,
    durable_commit_seq: u64,
    records: Vec<ReplayRecordWire>,
    evidence_digest: Sha256Digest,
}

impl ReplayDocument {
    fn from_unsigned(unsigned: ReplayUnsignedDocument, digest: Sha256Digest) -> Self {
        Self {
            schema: unsigned.schema,
            non_authoritative: true,
            mode: unsigned.mode,
            module_id: unsigned.module_id,
            storage_scope_id: unsigned.storage_scope_id,
            revision: unsigned.revision,
            durable_commit_seq: unsigned.durable_commit_seq,
            records: unsigned.records,
            evidence_digest: digest,
        }
    }

    fn unsigned(&self) -> ReplayUnsignedDocument {
        ReplayUnsignedDocument {
            schema: self.schema.clone(),
            mode: self.mode,
            module_id: self.module_id.clone(),
            storage_scope_id: self.storage_scope_id.clone(),
            revision: self.revision,
            durable_commit_seq: self.durable_commit_seq,
            records: self.records.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct ReplayUnsignedDocument {
    schema: String,
    mode: ReplayMode,
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    revision: u64,
    durable_commit_seq: u64,
    records: Vec<ReplayRecordWire>,
}

impl ReplayUnsignedDocument {
    fn new(
        provenance: &ReplayProvenance,
        mode: ReplayMode,
        records: Vec<ReplayRecordWire>,
    ) -> Self {
        Self {
            schema: REPLAY_SCHEMA.to_owned(),
            mode,
            module_id: provenance.module_id.clone(),
            storage_scope_id: provenance.storage_scope_id.clone(),
            revision: provenance.revision,
            durable_commit_seq: provenance.durable_commit_seq,
            records,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReplayRecordWire {
    sequence: u64,
    event: ReplayEventWire,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ReplayEventWire {
    InputAccepted {
        input_digest: Sha256Digest,
    },
    Succeeded {
        input_digest: Sha256Digest,
        result_digest: Sha256Digest,
    },
    Failed {
        input_digest: Sha256Digest,
        #[serde(skip_serializing_if = "Option::is_none")]
        result_digest: Option<Sha256Digest>,
    },
    Skipped {
        input_digest: Sha256Digest,
    },
}

fn digest_unsigned(unsigned: &ReplayUnsignedDocument) -> Result<Sha256Digest, ReplayError> {
    canonicalize(unsigned)
        .map(|(_, digest)| digest)
        .map_err(|_| ReplayError::Canonical("replay digest encoding failed".to_owned()))
}

fn validate_document(
    document: &ReplayDocument,
    projection: &ModuleStateProjection,
    limits: ReplayLimits,
) -> Result<(), ReplayError> {
    if document.schema != REPLAY_SCHEMA {
        return Err(ReplayError::Corrupt("unsupported replay schema".to_owned()));
    }
    if !document.non_authoritative {
        return Err(ReplayError::Corrupt(
            "replay evidence must be marked non-authoritative".to_owned(),
        ));
    }
    if document.mode == ReplayMode::LiveReplay {
        return Err(ReplayError::LiveReplayNotSupported);
    }
    let expected = ReplayProvenance::from_projection(projection)?;
    if document.module_id != expected.module_id
        || document.storage_scope_id != expected.storage_scope_id
        || document.revision != expected.revision
        || document.durable_commit_seq != expected.durable_commit_seq
    {
        return Err(ReplayError::IdentityMismatch);
    }
    if document.records.len() > limits.max_records() {
        return Err(ReplayError::RecordLimit {
            limit: limits.max_records(),
        });
    }
    for (index, record) in document.records.iter().enumerate() {
        let expected_sequence = index as u64 + 1;
        if record.sequence != expected_sequence {
            return Err(ReplayError::Ordering {
                expected: expected_sequence,
                actual: record.sequence,
            });
        }
        let record_bytes = canonicalize(record)
            .map_err(|_| ReplayError::Canonical("replay record encoding failed".to_owned()))?
            .0;
        if record_bytes.as_bytes().len() > limits.max_record_bytes() {
            return Err(ReplayError::RecordTooLarge {
                actual: record_bytes.as_bytes().len(),
                limit: limits.max_record_bytes(),
            });
        }
    }
    let total_bytes = canonicalize(document)
        .map_err(|_| ReplayError::Canonical("replay evidence encoding failed".to_owned()))?
        .0
        .as_bytes()
        .len();
    if total_bytes > limits.max_total_bytes() {
        return Err(ReplayError::TotalLimit {
            actual: total_bytes,
            limit: limits.max_total_bytes(),
        });
    }
    Ok(())
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ReplayError {
    #[error("invalid replay limits")]
    InvalidLimits,
    #[error("live replay is unavailable in the authority-free evidence module")]
    LiveReplayNotSupported,
    #[error("replay identity is outside the safe positive integer range")]
    InvalidIdentity,
    #[error("replay evidence identity does not match the storage projection")]
    IdentityMismatch,
    #[error("replay sequence expected {expected}, got {actual}")]
    Ordering { expected: u64, actual: u64 },
    #[error("replay sequence is exhausted")]
    SequenceExhausted,
    #[error("replay record is {actual} bytes, over the {limit}-byte limit")]
    RecordTooLarge { actual: usize, limit: usize },
    #[error("replay record limit {limit} reached")]
    RecordLimit { limit: usize },
    #[error("replay evidence is {actual} bytes, over the {limit}-byte limit")]
    TotalLimit { actual: usize, limit: usize },
    #[error("replay evidence digest does not match its canonical content")]
    DigestMismatch,
    #[error("corrupt replay evidence: {0}")]
    Corrupt(String),
    #[error("canonical replay encoding failed: {0}")]
    Canonical(String),
}
