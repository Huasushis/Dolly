use crate::security::{UnsafeData, validate_closed_data};
use dolly_canonical_json::{
    CanonicalBytes, ParseLimits, Sha256Digest, canonicalize, deserialize_core_json,
};
use dolly_core_domain::{ModuleId, ModuleStorageScopeId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

const MODULE_BACKUP_SCHEMA: &str = "dolly.module-backup/v1";
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

/// Hard ceilings for one canonical Module snapshot and its manifest.
pub const MAX_MODULE_STATE_BYTES: usize = 1024 * 1024;
pub const MAX_MODULE_BACKUP_BYTES: usize = 4 * 1024 * 1024;

/// One explicit target identity and revision expected by a Module restore.
///
/// This request carries no Worker, execution, capability, grant, reservation,
/// or effect authority. It only states what immutable Module bytes the caller
/// expects to receive.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleRestoreRequest {
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    revision: u64,
    backup_digest: Sha256Digest,
}

impl ModuleRestoreRequest {
    pub fn new(
        module_id: ModuleId,
        storage_scope_id: ModuleStorageScopeId,
        revision: u64,
        backup_digest: Sha256Digest,
    ) -> Result<Self, BackupError> {
        validate_revision(revision)?;
        Ok(Self {
            module_id,
            storage_scope_id,
            revision,
            backup_digest,
        })
    }

    pub fn module_id(&self) -> &ModuleId {
        &self.module_id
    }

    pub fn storage_scope_id(&self) -> &ModuleStorageScopeId {
        &self.storage_scope_id
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn backup_digest(&self) -> &Sha256Digest {
        &self.backup_digest
    }
}

/// A read-only Module state returned after all restore checks pass.
///
/// The value is deliberately not serializable into any Host control record and
/// has no method that can mint execution, capability, or effect authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestoredModuleState {
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    revision: u64,
    state: CanonicalBytes,
    state_digest: Sha256Digest,
    backup_digest: Sha256Digest,
}

impl RestoredModuleState {
    pub fn module_id(&self) -> &ModuleId {
        &self.module_id
    }

    pub fn storage_scope_id(&self) -> &ModuleStorageScopeId {
        &self.storage_scope_id
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn state_bytes(&self) -> &[u8] {
        self.state.as_bytes()
    }

    pub fn state_digest(&self) -> &Sha256Digest {
        &self.state_digest
    }

    pub fn backup_digest(&self) -> &Sha256Digest {
        &self.backup_digest
    }
}

/// An exact, single-Module backup document.
///
/// The document contains one Module ID and one stable storage scope ID; it has
/// no collection of Modules, Extension state, Host premise, or authority
/// material. State and manifest bytes are canonical JSON and are both
/// integrity-bound by SHA-256 digests.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleBackup {
    document: ModuleBackupDocument,
    state: CanonicalBytes,
}

impl ModuleBackup {
    /// Capture one already materialized Module state as canonical JSON.
    pub fn new(
        module_id: ModuleId,
        storage_scope_id: ModuleStorageScopeId,
        revision: u64,
        state: Value,
    ) -> Result<Self, BackupError> {
        validate_revision(revision)?;
        validate_closed_data(&state).map_err(unsafe_data)?;
        let state = canonicalize(&state)
            .map_err(|error| BackupError::Canonical(error.to_string()))?
            .0;
        if state.as_bytes().len() > MAX_MODULE_STATE_BYTES {
            return Err(BackupError::SizeLimit {
                kind: "Module state",
                actual: state.as_bytes().len(),
                limit: MAX_MODULE_STATE_BYTES,
            });
        }
        let state_digest = Sha256Digest::compute(state.as_bytes());
        let unsigned = ModuleBackupUnsignedDocument {
            schema: MODULE_BACKUP_SCHEMA.to_owned(),
            module_id,
            storage_scope_id,
            revision,
            state: serde_json::from_slice(state.as_bytes())
                .map_err(|error| BackupError::Canonical(error.to_string()))?,
            state_digest,
        };
        let backup_digest = digest_unsigned(&unsigned)?;
        let document = ModuleBackupDocument::from_unsigned(unsigned, backup_digest);
        let manifest = canonicalize(&document)
            .map_err(|error| BackupError::Canonical(error.to_string()))?
            .0;
        if manifest.as_bytes().len() > MAX_MODULE_BACKUP_BYTES {
            return Err(BackupError::SizeLimit {
                kind: "Module backup",
                actual: manifest.as_bytes().len(),
                limit: MAX_MODULE_BACKUP_BYTES,
            });
        }
        Ok(Self { document, state })
    }

    /// Capture any serializable state using the same closed data checks.
    pub fn capture<T: Serialize>(
        module_id: ModuleId,
        storage_scope_id: ModuleStorageScopeId,
        revision: u64,
        state: &T,
    ) -> Result<Self, BackupError> {
        let state = serde_json::to_value(state)
            .map_err(|error| BackupError::StateEncoding(error.to_string()))?;
        Self::new(module_id, storage_scope_id, revision, state)
    }

    pub fn module_id(&self) -> &ModuleId {
        &self.document.module_id
    }

    pub fn storage_scope_id(&self) -> &ModuleStorageScopeId {
        &self.document.storage_scope_id
    }

    pub const fn revision(&self) -> u64 {
        self.document.revision
    }

    pub fn state(&self) -> &Value {
        &self.document.state
    }

    pub fn state_bytes(&self) -> &[u8] {
        self.state.as_bytes()
    }

    pub fn state_digest(&self) -> &Sha256Digest {
        &self.document.state_digest
    }

    pub fn backup_digest(&self) -> &Sha256Digest {
        &self.document.backup_digest
    }

    pub fn canonical_bytes(&self) -> Result<CanonicalBytes, BackupError> {
        self.verify_integrity()?;
        canonicalize(&self.document)
            .map(|(bytes, _)| bytes)
            .map_err(|error| BackupError::Canonical(error.to_string()))
    }

    pub fn verify_integrity(&self) -> Result<(), BackupError> {
        validate_document(&self.document)?;
        let canonical_state = canonicalize(&self.document.state)
            .map_err(|error| BackupError::Canonical(error.to_string()))?
            .0;
        if canonical_state.as_bytes() != self.state.as_bytes() {
            return Err(BackupError::DigestMismatch("state bytes"));
        }
        Ok(())
    }

    /// Restore only when target identity, revision, backup digest, state
    /// digest, and canonical bytes all agree. The returned value is data only.
    pub fn restore(
        &self,
        request: &ModuleRestoreRequest,
    ) -> Result<RestoredModuleState, BackupError> {
        self.verify_integrity()?;
        if request.module_id() != self.module_id()
            || request.storage_scope_id() != self.storage_scope_id()
        {
            return Err(BackupError::IdentityMismatch);
        }
        if request.revision() != self.revision() {
            return Err(BackupError::RevisionMismatch {
                expected: request.revision(),
                actual: self.revision(),
            });
        }
        if request.backup_digest() != self.backup_digest() {
            return Err(BackupError::DigestMismatch("backup digest"));
        }
        Ok(RestoredModuleState {
            module_id: self.module_id().clone(),
            storage_scope_id: self.storage_scope_id().clone(),
            revision: self.revision(),
            state: self.state.clone(),
            state_digest: self.state_digest().clone(),
            backup_digest: self.backup_digest().clone(),
        })
    }

    /// Recover a complete canonical backup. A truncated or partially written
    /// document is rejected; no prefix is treated as a usable snapshot.
    pub fn recover_from_bytes(input: &[u8]) -> Result<Self, BackupError> {
        if input.is_empty() {
            return Err(BackupError::Corrupt("backup is empty".to_owned()));
        }
        if input.len() > MAX_MODULE_BACKUP_BYTES {
            return Err(BackupError::SizeLimit {
                kind: "Module backup",
                actual: input.len(),
                limit: MAX_MODULE_BACKUP_BYTES,
            });
        }
        let document: ModuleBackupDocument = deserialize_core_json(
            input,
            ParseLimits::new(64).expect("64 is a valid semantic depth"),
        )
        .map_err(|error| BackupError::Corrupt(error.to_string()))?;
        let canonical = canonicalize(&document)
            .map_err(|error| BackupError::Canonical(error.to_string()))?
            .0;
        if canonical.as_bytes() != input {
            return Err(BackupError::Corrupt(
                "backup bytes are not canonical JSON".to_owned(),
            ));
        }
        validate_document(&document)?;
        let state = canonicalize(&document.state)
            .map_err(|error| BackupError::Canonical(error.to_string()))?
            .0;
        Ok(Self { document, state })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ModuleBackupDocument {
    schema: String,
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    revision: u64,
    state: Value,
    state_digest: Sha256Digest,
    backup_digest: Sha256Digest,
}

impl ModuleBackupDocument {
    fn from_unsigned(unsigned: ModuleBackupUnsignedDocument, backup_digest: Sha256Digest) -> Self {
        Self {
            schema: unsigned.schema,
            module_id: unsigned.module_id,
            storage_scope_id: unsigned.storage_scope_id,
            revision: unsigned.revision,
            state: unsigned.state,
            state_digest: unsigned.state_digest,
            backup_digest,
        }
    }

    fn unsigned(&self) -> ModuleBackupUnsignedDocument {
        ModuleBackupUnsignedDocument {
            schema: self.schema.clone(),
            module_id: self.module_id.clone(),
            storage_scope_id: self.storage_scope_id.clone(),
            revision: self.revision,
            state: self.state.clone(),
            state_digest: self.state_digest.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct ModuleBackupUnsignedDocument {
    schema: String,
    module_id: ModuleId,
    storage_scope_id: ModuleStorageScopeId,
    revision: u64,
    state: Value,
    state_digest: Sha256Digest,
}

fn digest_unsigned(unsigned: &ModuleBackupUnsignedDocument) -> Result<Sha256Digest, BackupError> {
    canonicalize(unsigned)
        .map(|(_, digest)| digest)
        .map_err(|error| BackupError::Canonical(error.to_string()))
}

fn validate_document(document: &ModuleBackupDocument) -> Result<(), BackupError> {
    if document.schema != MODULE_BACKUP_SCHEMA {
        return Err(BackupError::Corrupt(
            "unsupported Module backup schema".to_owned(),
        ));
    }
    validate_revision(document.revision)?;
    validate_closed_data(&document.state).map_err(unsafe_data)?;
    let state = canonicalize(&document.state)
        .map_err(|error| BackupError::Canonical(error.to_string()))?
        .0;
    if state.as_bytes().len() > MAX_MODULE_STATE_BYTES {
        return Err(BackupError::SizeLimit {
            kind: "Module state",
            actual: state.as_bytes().len(),
            limit: MAX_MODULE_STATE_BYTES,
        });
    }
    let manifest = canonicalize(document)
        .map_err(|error| BackupError::Canonical(error.to_string()))?
        .0;
    if manifest.as_bytes().len() > MAX_MODULE_BACKUP_BYTES {
        return Err(BackupError::SizeLimit {
            kind: "Module backup",
            actual: manifest.as_bytes().len(),
            limit: MAX_MODULE_BACKUP_BYTES,
        });
    }
    let state_digest = Sha256Digest::compute(state.as_bytes());
    if state_digest != document.state_digest {
        return Err(BackupError::DigestMismatch("state digest"));
    }
    let backup_digest = digest_unsigned(&document.unsigned())?;
    if backup_digest != document.backup_digest {
        return Err(BackupError::DigestMismatch("backup digest"));
    }
    Ok(())
}
fn validate_revision(revision: u64) -> Result<(), BackupError> {
    if !(1..=MAX_SAFE_JSON_INTEGER).contains(&revision) {
        return Err(BackupError::InvalidRevision(revision));
    }
    Ok(())
}

fn unsafe_data(error: UnsafeData) -> BackupError {
    BackupError::ForbiddenData {
        path: error.path,
        kind: error.kind.to_string(),
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum BackupError {
    #[error("invalid Module revision {0}; expected 1..=9007199254740991")]
    InvalidRevision(u64),
    #[error("Module {kind} is {actual} bytes, over the {limit}-byte limit")]
    SizeLimit {
        kind: &'static str,
        actual: usize,
        limit: usize,
    },
    #[error("Module backup contains forbidden {kind} at {path}")]
    ForbiddenData { path: String, kind: String },
    #[error("backup state encoding failed: {0}")]
    StateEncoding(String),
    #[error("canonical Module backup encoding failed: {0}")]
    Canonical(String),
    #[error("corrupt Module backup: {0}")]
    Corrupt(String),
    #[error("Module backup {0} digest does not match canonical content")]
    DigestMismatch(&'static str),
    #[error("Module identity or storage scope does not match restore target")]
    IdentityMismatch,
    #[error("Module revision expected {expected}, got {actual}")]
    RevisionMismatch { expected: u64, actual: u64 },
}
