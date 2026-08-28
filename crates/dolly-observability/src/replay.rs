use crate::security::{UnsafeData, validate_closed_data};
use dolly_canonical_json::{CanonicalBytes, Sha256Digest, canonicalize, deserialize_core_json};
use dolly_core_domain::{ActivationId, ModuleId, ModuleStorageScopeId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
            max_records: 4_096,
            max_record_bytes: 64 * 1024,
            max_total_bytes: 4 * 1024 * 1024,
        }
    }
}

/// One ordered semantic input and recorded result. No execution premise,
/// capability, grant, reservation, credential, or effect handle is stored.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayRecord {
    sequence: u64,
    input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
}

impl ReplayRecord {
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn input(&self) -> &Value {
        &self.input
    }

    pub fn result(&self) -> Option<&Value> {
        self.result.as_ref()
    }
}

/// A mutable recorder for one Module's deterministic semantic evidence.
///
/// The recorder is bounded and append-only. An append that fails validation or
/// a limit check leaves the recorder unchanged. Call [`Self::finish`] to make
/// the immutable, digest-bound evidence document.
pub struct ReplayRecorder {
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    activation_id: Option<ActivationId>,
    mode: ReplayMode,
    limits: ReplayLimits,
    records: Vec<ReplayRecord>,
}

impl ReplayRecorder {
    pub fn new(
        module_id: ModuleId,
        storage_scope_id: ModuleStorageScopeId,
        mode: ReplayMode,
        limits: ReplayLimits,
    ) -> Result<Self, ReplayError> {
        if mode == ReplayMode::LiveReplay {
            return Err(ReplayError::LiveReplayNotSupported);
        }
        Ok(Self {
            module_id,
            storage_scope_id,
            activation_id: None,
            mode,
            limits,
            records: Vec::new(),
        })
    }

    pub fn simulation(module_id: ModuleId, storage_scope_id: ModuleStorageScopeId) -> Self {
        Self::new(
            module_id,
            storage_scope_id,
            ReplayMode::Simulation,
            ReplayLimits::default(),
        )
        .expect("default replay limits and simulation mode are valid")
    }

    pub fn verification(module_id: ModuleId, storage_scope_id: ModuleStorageScopeId) -> Self {
        Self::new(
            module_id,
            storage_scope_id,
            ReplayMode::Verification,
            ReplayLimits::default(),
        )
        .expect("default replay limits and verification mode are valid")
    }

    pub fn with_activation_id(mut self, activation_id: ActivationId) -> Self {
        self.activation_id = Some(activation_id);
        self
    }

    pub fn append(&mut self, input: Value, result: Option<Value>) -> Result<u64, ReplayError> {
        let sequence = self
            .records
            .len()
            .checked_add(1)
            .ok_or(ReplayError::SequenceExhausted)? as u64;
        self.append_ordered(sequence, input, result)
    }

    pub fn append_ordered(
        &mut self,
        sequence: u64,
        input: Value,
        result: Option<Value>,
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
        validate_closed_data(&input).map_err(unsafe_data)?;
        if let Some(result) = result.as_ref() {
            validate_closed_data(result).map_err(unsafe_data)?;
        }
        let record = ReplayRecord {
            sequence,
            input,
            result,
        };
        let record_bytes = canonicalize(&record)
            .map_err(|error| ReplayError::Canonical(error.to_string()))?
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

        let mut records = self.records.clone();
        records.push(record.clone());
        let unsigned = ReplayUnsignedDocument::new(
            self.mode,
            &self.module_id,
            &self.storage_scope_id,
            self.activation_id.as_ref(),
            records,
        );
        let digest = digest_unsigned(&unsigned)?;
        let document = ReplayDocument::from_unsigned(unsigned, digest);
        let bytes = canonicalize(&document)
            .map_err(|error| ReplayError::Canonical(error.to_string()))?
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
        let unsigned = ReplayUnsignedDocument::new(
            self.mode,
            &self.module_id,
            &self.storage_scope_id,
            self.activation_id.as_ref(),
            self.records,
        );
        let digest = digest_unsigned(&unsigned)?;
        let document = ReplayDocument::from_unsigned(unsigned, digest.clone());
        let bytes = canonicalize(&document)
            .map_err(|error| ReplayError::Canonical(error.to_string()))?
            .0;
        if bytes.as_bytes().len() > self.limits.max_total_bytes() {
            return Err(ReplayError::TotalLimit {
                actual: bytes.as_bytes().len(),
                limit: self.limits.max_total_bytes(),
            });
        }
        Ok(ReplayEvidence {
            mode: document.mode,
            module_id: document.module_id,
            storage_scope_id: document.storage_scope_id,
            activation_id: document.activation_id,
            records: document.records,
            digest,
        })
    }
}

/// Immutable deterministic replay evidence. It is explicitly non-authoritative
/// and exposes no operation that can execute work, mint a capability, or commit
/// an effect.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplayEvidence {
    mode: ReplayMode,
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    activation_id: Option<ActivationId>,
    records: Vec<ReplayRecord>,
    digest: Sha256Digest,
}

impl ReplayEvidence {
    pub fn mode(&self) -> ReplayMode {
        self.mode
    }

    pub fn module_id(&self) -> &ModuleId {
        &self.module_id
    }

    pub fn storage_scope_id(&self) -> &ModuleStorageScopeId {
        &self.storage_scope_id
    }

    pub fn activation_id(&self) -> Option<&ActivationId> {
        self.activation_id.as_ref()
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
        let unsigned = ReplayUnsignedDocument::new(
            self.mode,
            &self.module_id,
            &self.storage_scope_id,
            self.activation_id.as_ref(),
            self.records.clone(),
        );
        let digest = digest_unsigned(&unsigned)?;
        if digest != self.digest {
            return Err(ReplayError::DigestMismatch);
        }
        canonicalize(&ReplayDocument::from_unsigned(unsigned, digest))
            .map(|(bytes, _)| bytes)
            .map_err(|error| ReplayError::Canonical(error.to_string()))
    }

    pub fn recover_from_bytes(input: &[u8]) -> Result<Self, ReplayError> {
        let limits = ReplayLimits::default();
        if input.is_empty() {
            return Err(ReplayError::Corrupt("evidence is empty".to_owned()));
        }
        if input.len() > limits.max_total_bytes() {
            return Err(ReplayError::TotalLimit {
                actual: input.len(),
                limit: limits.max_total_bytes(),
            });
        }
        let document: ReplayDocument = deserialize_core_json(
            input,
            dolly_canonical_json::ParseLimits::new(64).expect("64 is a valid semantic depth"),
        )
        .map_err(|error| ReplayError::Corrupt(error.to_string()))?;
        let canonical = canonicalize(&document)
            .map_err(|error| ReplayError::Canonical(error.to_string()))?
            .0;
        if canonical.as_bytes() != input {
            return Err(ReplayError::Corrupt(
                "evidence bytes are not canonical JSON".to_owned(),
            ));
        }
        validate_document(&document, limits)?;
        let unsigned = document.unsigned();
        let digest = digest_unsigned(&unsigned)?;
        if digest != document.evidence_digest {
            return Err(ReplayError::DigestMismatch);
        }
        Ok(Self {
            mode: document.mode,
            module_id: document.module_id,
            storage_scope_id: document.storage_scope_id,
            activation_id: document.activation_id,
            records: document.records,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    activation_id: Option<ActivationId>,
    records: Vec<ReplayRecord>,
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
            activation_id: unsigned.activation_id,
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
            activation_id: self.activation_id.clone(),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    activation_id: Option<ActivationId>,
    records: Vec<ReplayRecord>,
}

impl ReplayUnsignedDocument {
    fn new(
        mode: ReplayMode,
        module_id: &ModuleId,
        storage_scope_id: &ModuleStorageScopeId,
        activation_id: Option<&ActivationId>,
        records: Vec<ReplayRecord>,
    ) -> Self {
        Self {
            schema: REPLAY_SCHEMA.to_owned(),
            mode,
            module_id: module_id.clone(),
            storage_scope_id: storage_scope_id.clone(),
            activation_id: activation_id.cloned(),
            records,
        }
    }
}

fn digest_unsigned(unsigned: &ReplayUnsignedDocument) -> Result<Sha256Digest, ReplayError> {
    canonicalize(unsigned)
        .map(|(_, digest)| digest)
        .map_err(|error| ReplayError::Canonical(error.to_string()))
}

fn validate_document(document: &ReplayDocument, limits: ReplayLimits) -> Result<(), ReplayError> {
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
    if document.records.len() > limits.max_records() {
        return Err(ReplayError::RecordLimit {
            limit: limits.max_records(),
        });
    }
    for (index, record) in document.records.iter().enumerate() {
        let expected = index as u64 + 1;
        if record.sequence != expected {
            return Err(ReplayError::Ordering {
                expected,
                actual: record.sequence,
            });
        }
        validate_closed_data(&record.input).map_err(unsafe_data)?;
        if let Some(result) = record.result.as_ref() {
            validate_closed_data(result).map_err(unsafe_data)?;
        }
        let record_bytes = canonicalize(record)
            .map_err(|error| ReplayError::Canonical(error.to_string()))?
            .0;
        if record_bytes.as_bytes().len() > limits.max_record_bytes() {
            return Err(ReplayError::RecordTooLarge {
                actual: record_bytes.as_bytes().len(),
                limit: limits.max_record_bytes(),
            });
        }
    }
    let total_bytes = canonicalize(document)
        .map_err(|error| ReplayError::Canonical(error.to_string()))?
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

fn unsafe_data(error: UnsafeData) -> ReplayError {
    ReplayError::ForbiddenData {
        path: error.path,
        kind: error.kind.to_string(),
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ReplayError {
    #[error("invalid replay limits")]
    InvalidLimits,
    #[error("live replay is unavailable in the authority-free evidence module")]
    LiveReplayNotSupported,
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
    #[error("replay evidence contains forbidden {kind} at {path}")]
    ForbiddenData { path: String, kind: String },
    #[error("replay evidence digest does not match its canonical content")]
    DigestMismatch,
    #[error("corrupt replay evidence: {0}")]
    Corrupt(String),
    #[error("canonical replay encoding failed: {0}")]
    Canonical(String),
}
