//! Fresh live runtime-binding and process-generation authority.
//!
//! The only producer in this module accepts the private
//! [`VerifiedLinuxHostProof`] returned by the storage verifier. It reloads the
//! durable Host premise before every authority transition, persists only closed
//! provenance and monotonic reservations, and returns non-copyable live
//! objects. Process observations are deliberately not inputs to this module.

use std::fmt;

use dolly_canonical_json::{
    MAX_SEMANTIC_JSON_NESTING_DEPTH, ParseLimits, Sha256Digest, canonicalize, deserialize_core_json,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::Database;
use crate::host_authority::{
    CurrentAuthoritySnapshot, HostAuthorityError, InstalledComponentOrigin, load_current_authority,
};
use crate::linux_host_verification::{
    LINUX_HOST_VERIFICATION_PROOF_SCHEMA, LinuxHostVerificationError, VerifiedDelegatedCgroupRoot,
    VerifiedLinuxHostProof, VerifiedLinuxServiceIdentity, verify_current_linux_host,
};

/// The largest generation representable by the frozen safe-integer contract.
pub const MAX_GENERATION: u64 = 9_007_199_254_740_991;
/// Schema version for the closed runtime-binding reservation tables.
pub const RUNTIME_BINDING_SCHEMA_VERSION: i64 = 1;
/// Closed provenance record schema for one runtime-binding reservation.
pub const RUNTIME_BINDING_RECORD_SCHEMA: &str = "dolly.runtime-binding-authority/v1";
/// Closed provenance record schema for one process-generation reservation.
pub const PROCESS_GENERATION_RECORD_SCHEMA: &str = "dolly.process-generation-authority/v1";

/// Tables holding only closed provenance and monotonic reservation pointers.
pub const RUNTIME_BINDING_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS runtime_binding_authority_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1)
);
INSERT OR IGNORE INTO runtime_binding_authority_meta (singleton, authority_schema_version)
VALUES (1, 1);
CREATE TABLE IF NOT EXISTS runtime_binding_authority_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1),
    daemon_installation_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    current_config_revision INTEGER NOT NULL CHECK (current_config_revision BETWEEN 1 AND 9007199254740991),
    current_config_digest TEXT NOT NULL,
    current_premises_digest TEXT NOT NULL,
    current_service_candidate_digest TEXT NOT NULL,
    current_controller_generation INTEGER CHECK (current_controller_generation IS NULL OR current_controller_generation BETWEEN 1 AND 9007199254740991),
    current_binding_digest TEXT,
    current_process_generation INTEGER CHECK (current_process_generation IS NULL OR current_process_generation BETWEEN 1 AND 9007199254740991),
    next_controller_generation INTEGER NOT NULL CHECK (next_controller_generation BETWEEN 1 AND 9007199254740991),
    next_process_generation INTEGER NOT NULL CHECK (next_process_generation BETWEEN 1 AND 9007199254740991),
    record_jcs BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_binding_authority_records (
    controller_generation INTEGER PRIMARY KEY CHECK (controller_generation BETWEEN 1 AND 9007199254740991),
    daemon_installation_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    config_revision INTEGER NOT NULL CHECK (config_revision BETWEEN 1 AND 9007199254740991),
    config_digest TEXT NOT NULL,
    premises_digest TEXT NOT NULL,
    service_candidate_digest TEXT NOT NULL,
    binding_digest TEXT NOT NULL,
    record_jcs BLOB NOT NULL,
    UNIQUE (controller_generation, binding_digest)
);
CREATE TABLE IF NOT EXISTS process_generation_authority_records (
    process_generation INTEGER PRIMARY KEY CHECK (process_generation BETWEEN 1 AND 9007199254740991),
    controller_generation INTEGER NOT NULL CHECK (controller_generation BETWEEN 1 AND 9007199254740991),
    daemon_installation_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    config_revision INTEGER NOT NULL CHECK (config_revision BETWEEN 1 AND 9007199254740991),
    config_digest TEXT NOT NULL,
    premises_digest TEXT NOT NULL,
    service_candidate_digest TEXT NOT NULL,
    binding_digest TEXT NOT NULL,
    record_jcs BLOB NOT NULL,
    UNIQUE (daemon_installation_id, instance_id, process_generation),
    FOREIGN KEY (controller_generation)
      REFERENCES runtime_binding_authority_records(controller_generation)
);
"#;

/// A fresh runtime binding minted only after the current persistent premise and
/// a live [`VerifiedLinuxHostProof`] agree. The type intentionally has no
/// `Clone` or `Copy` implementation; its private fields prevent structural
/// construction by callers.
#[derive(Debug)]
pub struct RuntimeBinding {
    controller_generation: u64,
    binding_digest: Sha256Digest,
    daemon_installation_id: String,
    instance_id: String,
    config_revision: i64,
    config_digest: Sha256Digest,
    premises_digest: Sha256Digest,
    service_candidate_digest: Sha256Digest,
    service_candidate_origin: InstalledComponentOrigin,
    service: VerifiedLinuxServiceIdentity,
    delegated_root: VerifiedDelegatedCgroupRoot,
    process_generation_minted: bool,
}

impl RuntimeBinding {
    /// Fresh controller generation associated with this binding.
    pub fn controller_generation(&self) -> u64 {
        self.controller_generation
    }

    /// Digest of the closed proof-bound binding record.
    pub fn binding_digest(&self) -> &Sha256Digest {
        &self.binding_digest
    }

    pub fn daemon_installation_id(&self) -> &str {
        &self.daemon_installation_id
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn config_revision(&self) -> i64 {
        self.config_revision
    }

    pub fn config_digest(&self) -> &Sha256Digest {
        &self.config_digest
    }

    pub fn premises_digest(&self) -> &Sha256Digest {
        &self.premises_digest
    }

    pub fn service_candidate_digest(&self) -> &Sha256Digest {
        &self.service_candidate_digest
    }

    /// Mint exactly one fresh process-generation identity from this binding.
    ///
    /// The current Host premise is reloaded inside the transaction. A changed
    /// pointer, tampered binding row, duplicate generation, or failed partial
    /// write refuses and leaves both the binding and process-generation
    /// pointers unchanged.
    pub fn mint_process_generation(
        &mut self,
        db: &mut Database,
    ) -> Result<ProcessGeneration, RuntimeBindingError> {
        if self.process_generation_minted {
            return Err(RuntimeBindingError::BindingConsumed);
        }

        create_runtime_binding_schema(db.connection())?;
        let snapshot = load_authority(db.connection())?;
        self.ensure_snapshot_matches(&snapshot)?;

        let tx = db
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_authority(&tx)?;
        self.ensure_snapshot_matches(&current)?;
        let state = load_state(&tx)?.ok_or(RuntimeBindingError::AuthorityStateMissing)?;
        state.record.ensure_snapshot_matches(&current)?;
        if state.record.current_controller_generation != Some(self.controller_generation)
            || state.record.current_binding_digest.as_ref() != Some(&self.binding_digest)
            || state.record.current_process_generation.is_some()
        {
            return Err(RuntimeBindingError::BindingStale(
                "runtime binding is not the current unconsumed binding".into(),
            ));
        }

        let persisted = load_binding_record(&tx, self.controller_generation)?.ok_or(
            RuntimeBindingError::BindingStale("runtime binding reservation is missing".into()),
        )?;
        if persisted != self.binding_record() {
            return Err(RuntimeBindingError::BindingStale(
                "runtime binding reservation differs from the live binding".into(),
            ));
        }

        let process_generation = state.record.next_process_generation;
        ensure_generation_available(process_generation, "process generation")?;
        if tx
            .query_row(
                "SELECT 1 FROM process_generation_authority_records WHERE process_generation = ?1",
                [process_generation as i64],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(RuntimeBindingError::GenerationConflict {
                kind: "process",
                generation: process_generation,
            });
        }

        let unsigned = ProcessGenerationRecordUnsigned {
            schema: PROCESS_GENERATION_RECORD_SCHEMA.to_string(),
            process_generation,
            controller_generation: self.controller_generation,
            daemon_installation_id: self.daemon_installation_id.clone(),
            instance_id: self.instance_id.clone(),
            config_revision: self.config_revision,
            config_digest: self.config_digest.clone(),
            premises_digest: self.premises_digest.clone(),
            service_candidate_digest: self.service_candidate_digest.clone(),
            binding_digest: self.binding_digest.clone(),
        };
        let (record, record_bytes) = ProcessGenerationRecord::from_unsigned(unsigned)?;
        tx.execute(
            "INSERT INTO process_generation_authority_records (
                process_generation, controller_generation, daemon_installation_id,
                instance_id, config_revision, config_digest, premises_digest,
                service_candidate_digest, binding_digest, record_jcs
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                record.process_generation() as i64,
                record.controller_generation() as i64,
                record.daemon_installation_id(),
                record.instance_id(),
                record.config_revision(),
                record.config_digest().to_string(),
                record.premises_digest().to_string(),
                record.service_candidate_digest().to_string(),
                record.binding_digest().to_string(),
                record_bytes,
            ],
        )?;

        let next_process_generation = next_generation(process_generation, "process generation")?;
        let next_state = state
            .record
            .with_process_generation(process_generation, next_process_generation);
        persist_state(&tx, &next_state)?;
        tx.commit()?;
        self.process_generation_minted = true;

        Ok(ProcessGeneration {
            record,
            service: self.service.clone(),
            delegated_root: self.delegated_root.clone(),
        })
    }

    fn ensure_snapshot_matches(
        &self,
        snapshot: &CurrentAuthoritySnapshot,
    ) -> Result<(), RuntimeBindingError> {
        if snapshot.mapping.daemon_installation_id != self.daemon_installation_id
            || snapshot.mapping.instance_id != self.instance_id
            || snapshot.mapping.config_revision != self.config_revision
            || snapshot.mapping.config_digest != self.config_digest
        {
            return Err(RuntimeBindingError::BindingStale(
                "current Host authority identity, revision, or config changed".into(),
            ));
        }
        let Some(premise) = snapshot.premise.as_ref() else {
            return Err(RuntimeBindingError::AuthorityMissing);
        };
        if premise.premises_digest != self.premises_digest
            || premise.service_candidate.candidate_digest != self.service_candidate_digest
            || premise.service_candidate.origin != self.service_candidate_origin
        {
            return Err(RuntimeBindingError::BindingStale(
                "current Host premise or candidate origin changed".into(),
            ));
        }
        Ok(())
    }

    fn binding_record(&self) -> RuntimeBindingRecord {
        RuntimeBindingRecord {
            unsigned: RuntimeBindingRecordUnsigned {
                schema: RUNTIME_BINDING_RECORD_SCHEMA.to_string(),
                controller_generation: self.controller_generation,
                daemon_installation_id: self.daemon_installation_id.clone(),
                instance_id: self.instance_id.clone(),
                config_revision: self.config_revision,
                config_digest: self.config_digest.clone(),
                premises_digest: self.premises_digest.clone(),
                service_candidate_digest: self.service_candidate_digest.clone(),
                service_candidate_origin: self.service_candidate_origin.clone(),
                service: ServiceEvidence::from(&self.service),
                delegated_root: DelegatedRootEvidence::from(&self.delegated_root),
            },
            binding_digest: self.binding_digest.clone(),
        }
    }
}

/// A fresh process-generation identity tied to one live runtime binding.
///
/// This is closed, non-serializable Rust state. The durable record stores only
/// its provenance and reservation identity; process success, readiness, ACK,
/// absence, and transport observations have no API here and cannot mint it.
#[derive(Debug, PartialEq, Eq)]
pub struct ProcessGeneration {
    record: ProcessGenerationRecord,
    service: VerifiedLinuxServiceIdentity,
    delegated_root: VerifiedDelegatedCgroupRoot,
}

impl ProcessGeneration {
    pub fn process_generation(&self) -> u64 {
        self.record.process_generation()
    }

    pub fn controller_generation(&self) -> u64 {
        self.record.controller_generation()
    }

    pub fn daemon_installation_id(&self) -> &str {
        self.record.daemon_installation_id()
    }

    pub fn instance_id(&self) -> &str {
        self.record.instance_id()
    }

    pub fn config_revision(&self) -> i64 {
        self.record.config_revision()
    }

    pub fn config_digest(&self) -> &Sha256Digest {
        self.record.config_digest()
    }

    pub fn binding_digest(&self) -> &Sha256Digest {
        self.record.binding_digest()
    }
    pub fn service(&self) -> &VerifiedLinuxServiceIdentity {
        &self.service
    }

    pub fn delegated_root(&self) -> &VerifiedDelegatedCgroupRoot {
        &self.delegated_root
    }
}

/// Create the runtime-binding and process-generation reservation schema.
pub fn create_runtime_binding_schema(connection: &Connection) -> Result<(), RuntimeBindingError> {
    connection.execute_batch(RUNTIME_BINDING_SCHEMA_SQL)?;
    let version: i64 = connection.query_row(
        "SELECT authority_schema_version FROM runtime_binding_authority_meta WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    if version != RUNTIME_BINDING_SCHEMA_VERSION {
        return Err(RuntimeBindingError::Malformed(
            "unsupported runtime-binding authority schema version".into(),
        ));
    }
    Ok(())
}

/// Verify the current SQLite Host premise and mint one fresh runtime binding.
///
/// This is the producer's normal entry point. It never accepts a caller
/// snapshot or an equal-looking proof; the proof is created internally by
/// [`verify_current_linux_host`].
pub fn mint_current_runtime_binding(
    db: &mut Database,
) -> Result<RuntimeBinding, RuntimeBindingError> {
    let proof = verify_current_linux_host(db.connection())?;
    mint_runtime_binding(db, proof)
}

/// Consume one private live Host proof and mint a fresh runtime binding.
///
/// The proof type has private fields and no public constructor. The durable
/// current pointer and complete premise are loaded again before this function
/// can commit a reservation.
pub fn mint_runtime_binding(
    db: &mut Database,
    proof: VerifiedLinuxHostProof,
) -> Result<RuntimeBinding, RuntimeBindingError> {
    create_runtime_binding_schema(db.connection())?;
    let snapshot = load_authority(db.connection())?;
    validate_proof(&snapshot, &proof)?;

    let tx = db
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = load_authority(&tx)?;
    validate_proof(&current, &proof)?;
    let state = load_state(&tx)?;
    let (next_controller_generation, next_process_generation) = match state {
        None => (1, 1),
        Some(state) => {
            state.record.ensure_snapshot_matches(&current)?;
            (
                state.record.next_controller_generation,
                state.record.next_process_generation,
            )
        }
    };
    ensure_generation_available(next_controller_generation, "controller generation")?;
    ensure_generation_available(next_process_generation, "process generation")?;

    let binding_unsigned = RuntimeBindingRecordUnsigned {
        schema: RUNTIME_BINDING_RECORD_SCHEMA.to_string(),
        controller_generation: next_controller_generation,
        daemon_installation_id: proof.daemon_installation_id().to_string(),
        instance_id: proof.instance_id().to_string(),
        config_revision: proof.config_revision(),
        config_digest: proof.config_digest().clone(),
        premises_digest: proof.premises_digest().clone(),
        service_candidate_digest: proof.service_candidate_digest().clone(),
        service_candidate_origin: proof.service_candidate_origin().clone(),
        service: ServiceEvidence::from(proof.service()),
        delegated_root: DelegatedRootEvidence::from(proof.delegated_root()),
    };
    let (binding_record, binding_bytes) = RuntimeBindingRecord::from_unsigned(binding_unsigned)?;
    if tx
        .query_row(
            "SELECT 1 FROM runtime_binding_authority_records WHERE controller_generation = ?1",
            [next_controller_generation as i64],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Err(RuntimeBindingError::GenerationConflict {
            kind: "controller",
            generation: next_controller_generation,
        });
    }

    // The closed proof-bound reservation is inserted before publishing the
    // current pointer. A failed insert rolls back all authority changes.
    tx.execute(
        "INSERT INTO runtime_binding_authority_records (
            controller_generation, daemon_installation_id, instance_id,
            config_revision, config_digest, premises_digest,
            service_candidate_digest, binding_digest, record_jcs
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            binding_record.unsigned.controller_generation as i64,
            &binding_record.unsigned.daemon_installation_id,
            &binding_record.unsigned.instance_id,
            binding_record.unsigned.config_revision,
            binding_record.unsigned.config_digest.to_string(),
            binding_record.unsigned.premises_digest.to_string(),
            binding_record.unsigned.service_candidate_digest.to_string(),
            binding_record.binding_digest.to_string(),
            binding_bytes,
        ],
    )?;

    let state_record = RuntimeBindingStateRecord {
        schema: "dolly.runtime-binding-authority-state/v1".into(),
        authority_schema_version: RUNTIME_BINDING_SCHEMA_VERSION,
        daemon_installation_id: binding_record.unsigned.daemon_installation_id.clone(),
        instance_id: binding_record.unsigned.instance_id.clone(),
        current_config_revision: binding_record.unsigned.config_revision,
        current_config_digest: binding_record.unsigned.config_digest.clone(),
        current_premises_digest: binding_record.unsigned.premises_digest.clone(),
        current_service_candidate_digest: binding_record.unsigned.service_candidate_digest.clone(),
        current_controller_generation: Some(next_controller_generation),
        current_binding_digest: Some(binding_record.binding_digest.clone()),
        current_process_generation: None,
        next_controller_generation: next_generation(
            next_controller_generation,
            "controller generation",
        )?,
        next_process_generation,
    };
    persist_state(&tx, &state_record)?;
    tx.commit()?;

    Ok(RuntimeBinding {
        controller_generation: binding_record.unsigned.controller_generation,
        binding_digest: binding_record.binding_digest,
        daemon_installation_id: binding_record.unsigned.daemon_installation_id,
        instance_id: binding_record.unsigned.instance_id,
        config_revision: binding_record.unsigned.config_revision,
        config_digest: binding_record.unsigned.config_digest,
        premises_digest: binding_record.unsigned.premises_digest,
        service_candidate_digest: binding_record.unsigned.service_candidate_digest,
        service_candidate_origin: binding_record.unsigned.service_candidate_origin,
        service: proof.service().clone(),
        delegated_root: proof.delegated_root().clone(),
        process_generation_minted: false,
    })
}

#[derive(Debug, Error)]
pub enum RuntimeBindingError {
    #[error("runtime-binding storage failure: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("live Linux Host proof refused: {0}")]
    HostVerification(#[from] LinuxHostVerificationError),
    #[error("current Host authority premise is missing")]
    AuthorityMissing,
    #[error("runtime-binding authority state is missing")]
    AuthorityStateMissing,
    #[error("current Host authority is stale: {0}")]
    AuthorityStale(String),
    #[error("runtime binding is stale: {0}")]
    BindingStale(String),
    #[error("runtime binding proof mismatch: {0}")]
    ProofMismatch(String),
    #[error("runtime binding was already consumed for a process generation")]
    BindingConsumed,
    #[error("{kind} generation {generation} is already reserved")]
    GenerationConflict { kind: &'static str, generation: u64 },
    #[error("{kind} generation sequence is exhausted")]
    GenerationExhausted { kind: &'static str },
    #[error("malformed runtime-binding authority: {0}")]
    Malformed(String),
    #[error("runtime-binding canonical record failure: {0}")]
    Canonical(String),
    #[error("runtime-binding record digest mismatch: {0}")]
    DigestMismatch(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ServiceEvidence {
    unit_name: String,
    mode: String,
    invocation_id: String,
    boot_id: String,
    main_pid: u32,
    control_group: String,
    host_cgroup_path: String,
}

impl From<&VerifiedLinuxServiceIdentity> for ServiceEvidence {
    fn from(value: &VerifiedLinuxServiceIdentity) -> Self {
        Self {
            unit_name: value.unit_name.clone(),
            mode: value.mode.clone(),
            invocation_id: value.invocation_id.clone(),
            boot_id: value.boot_id.clone(),
            main_pid: value.main_pid,
            control_group: value.control_group.clone(),
            host_cgroup_path: value.host_cgroup_path.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DelegatedRootEvidence {
    cgroup_path: String,
    filesystem_path: String,
    controllers: Vec<String>,
    subtree_control: Vec<String>,
}

impl From<&VerifiedDelegatedCgroupRoot> for DelegatedRootEvidence {
    fn from(value: &VerifiedDelegatedCgroupRoot) -> Self {
        Self {
            cgroup_path: value.cgroup_path.clone(),
            filesystem_path: value.filesystem_path.clone(),
            controllers: value.controllers.clone(),
            subtree_control: value.subtree_control.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeBindingRecordUnsigned {
    schema: String,
    controller_generation: u64,
    daemon_installation_id: String,
    instance_id: String,
    config_revision: i64,
    config_digest: Sha256Digest,
    premises_digest: Sha256Digest,
    service_candidate_digest: Sha256Digest,
    service_candidate_origin: InstalledComponentOrigin,
    service: ServiceEvidence,
    delegated_root: DelegatedRootEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeBindingRecord {
    #[serde(flatten)]
    unsigned: RuntimeBindingRecordUnsigned,
    binding_digest: Sha256Digest,
}

impl RuntimeBindingRecord {
    fn from_unsigned(
        unsigned: RuntimeBindingRecordUnsigned,
    ) -> Result<(Self, Vec<u8>), RuntimeBindingError> {
        let (_, digest) = canonicalize(&unsigned).map_err(canonical_error)?;
        let record = Self {
            unsigned,
            binding_digest: digest,
        };
        let full_bytes = canonical_bytes(&record)?;
        Ok((record, full_bytes))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProcessGenerationRecordUnsigned {
    schema: String,
    process_generation: u64,
    controller_generation: u64,
    daemon_installation_id: String,
    instance_id: String,
    config_revision: i64,
    config_digest: Sha256Digest,
    premises_digest: Sha256Digest,
    service_candidate_digest: Sha256Digest,
    binding_digest: Sha256Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProcessGenerationRecord {
    #[serde(flatten)]
    unsigned: ProcessGenerationRecordUnsigned,
    process_generation_digest: Sha256Digest,
}

impl ProcessGenerationRecord {
    fn from_unsigned(
        unsigned: ProcessGenerationRecordUnsigned,
    ) -> Result<(Self, Vec<u8>), RuntimeBindingError> {
        let (_, digest) = canonicalize(&unsigned).map_err(canonical_error)?;
        let record = Self {
            unsigned,
            process_generation_digest: digest,
        };
        Ok((record.clone(), canonical_bytes(&record)?))
    }

    fn process_generation(&self) -> u64 {
        self.unsigned.process_generation
    }

    fn controller_generation(&self) -> u64 {
        self.unsigned.controller_generation
    }

    fn daemon_installation_id(&self) -> &str {
        &self.unsigned.daemon_installation_id
    }

    fn instance_id(&self) -> &str {
        &self.unsigned.instance_id
    }

    fn config_revision(&self) -> i64 {
        self.unsigned.config_revision
    }

    fn config_digest(&self) -> &Sha256Digest {
        &self.unsigned.config_digest
    }

    fn premises_digest(&self) -> &Sha256Digest {
        &self.unsigned.premises_digest
    }

    fn service_candidate_digest(&self) -> &Sha256Digest {
        &self.unsigned.service_candidate_digest
    }

    fn binding_digest(&self) -> &Sha256Digest {
        &self.unsigned.binding_digest
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeBindingStateRecord {
    schema: String,
    authority_schema_version: i64,
    daemon_installation_id: String,
    instance_id: String,
    current_config_revision: i64,
    current_config_digest: Sha256Digest,
    current_premises_digest: Sha256Digest,
    current_service_candidate_digest: Sha256Digest,
    current_controller_generation: Option<u64>,
    current_binding_digest: Option<Sha256Digest>,
    current_process_generation: Option<u64>,
    next_controller_generation: u64,
    next_process_generation: u64,
}

impl RuntimeBindingStateRecord {
    fn ensure_snapshot_matches(
        &self,
        snapshot: &CurrentAuthoritySnapshot,
    ) -> Result<(), RuntimeBindingError> {
        let Some(premise) = snapshot.premise.as_ref() else {
            return Err(RuntimeBindingError::AuthorityMissing);
        };
        if self.daemon_installation_id != snapshot.mapping.daemon_installation_id
            || self.instance_id != snapshot.mapping.instance_id
            || self.current_config_revision != snapshot.mapping.config_revision
            || self.current_config_digest != snapshot.mapping.config_digest
            || self.current_premises_digest != premise.premises_digest
            || self.current_service_candidate_digest != premise.service_candidate.candidate_digest
        {
            return Err(RuntimeBindingError::AuthorityStale(
                "runtime-binding pointer no longer names the current Host premise".into(),
            ));
        }
        Ok(())
    }

    fn with_process_generation(&self, current: u64, next: u64) -> Self {
        let mut state = self.clone();
        state.current_process_generation = Some(current);
        state.next_process_generation = next;
        state
    }
}

#[derive(Debug)]
struct LoadedState {
    record: RuntimeBindingStateRecord,
}

fn load_authority(
    connection: &Connection,
) -> Result<CurrentAuthoritySnapshot, RuntimeBindingError> {
    load_current_authority(connection)
        .map_err(|error| match error {
            HostAuthorityError::Storage(error) => RuntimeBindingError::Storage(error),
            other => RuntimeBindingError::AuthorityStale(other.to_string()),
        })?
        .ok_or(RuntimeBindingError::AuthorityMissing)
}

fn validate_proof(
    snapshot: &CurrentAuthoritySnapshot,
    proof: &VerifiedLinuxHostProof,
) -> Result<(), RuntimeBindingError> {
    let Some(premise) = snapshot.premise.as_ref() else {
        return Err(RuntimeBindingError::AuthorityMissing);
    };
    if proof.schema() != LINUX_HOST_VERIFICATION_PROOF_SCHEMA {
        return Err(RuntimeBindingError::ProofMismatch(
            "unsupported Linux Host proof schema".into(),
        ));
    }
    let mapping = &snapshot.mapping;
    if proof.daemon_installation_id() != mapping.daemon_installation_id
        || proof.instance_id() != mapping.instance_id
        || proof.config_revision() != mapping.config_revision
        || proof.config_digest() != &mapping.config_digest
    {
        return Err(RuntimeBindingError::ProofMismatch(
            "proof does not name the current Runtime identity, revision, or config digest".into(),
        ));
    }
    if proof.premises_digest() != &premise.premises_digest
        || proof.service_candidate_digest() != &premise.service_candidate.candidate_digest
        || proof.service_candidate_origin() != &premise.service_candidate.origin
    {
        return Err(RuntimeBindingError::ProofMismatch(
            "proof does not name the current premise, candidate, or installed origin".into(),
        ));
    }
    let service = proof.service();
    let candidate = &premise.service_candidate;
    if service.unit_name != candidate.unit_name || service.mode != candidate.mode {
        return Err(RuntimeBindingError::ProofMismatch(
            "proof service identity differs from the durable candidate".into(),
        ));
    }
    Ok(())
}

fn load_state(connection: &Connection) -> Result<Option<LoadedState>, RuntimeBindingError> {
    let Some((
        record_bytes,
        schema_version,
        daemon,
        instance,
        config_revision,
        config_digest,
        premises_digest,
        candidate_digest,
        current_controller,
        current_binding,
        current_process,
        next_controller,
        next_process,
    )) = connection
        .query_row(
            "SELECT record_jcs, authority_schema_version, daemon_installation_id,
                    instance_id, current_config_revision, current_config_digest,
                    current_premises_digest, current_service_candidate_digest,
                    current_controller_generation, current_binding_digest,
                    current_process_generation, next_controller_generation,
                    next_process_generation
             FROM runtime_binding_authority_state WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let record: RuntimeBindingStateRecord = decode_record(&record_bytes, "runtime-binding state")?;
    if canonical_bytes(&record)? != record_bytes
        || record.schema != "dolly.runtime-binding-authority-state/v1"
        || record.authority_schema_version != schema_version
        || record.authority_schema_version != RUNTIME_BINDING_SCHEMA_VERSION
        || record.daemon_installation_id != daemon
        || record.instance_id != instance
        || record.current_config_revision != config_revision
        || record.current_config_digest.to_string() != config_digest
        || record.current_premises_digest.to_string() != premises_digest
        || record.current_service_candidate_digest.to_string() != candidate_digest
        || record.current_controller_generation.map(|v| v as i64) != current_controller
        || record
            .current_binding_digest
            .as_ref()
            .map(ToString::to_string)
            != current_binding
        || record.current_process_generation.map(|v| v as i64) != current_process
        || record.next_controller_generation as i64 != next_controller
        || record.next_process_generation as i64 != next_process
    {
        return Err(RuntimeBindingError::DigestMismatch(
            "runtime-binding state projection".into(),
        ));
    }
    ensure_generation_available(record.next_controller_generation, "controller generation")?;
    ensure_generation_available(record.next_process_generation, "process generation")?;
    if let Some(controller_generation) = record.current_controller_generation {
        let binding = load_binding_record(connection, controller_generation)?.ok_or_else(|| {
            RuntimeBindingError::DigestMismatch("current runtime-binding record is missing".into())
        })?;
        if record.current_binding_digest.as_ref() != Some(&binding.binding_digest)
            || binding.unsigned.daemon_installation_id != record.daemon_installation_id
            || binding.unsigned.instance_id != record.instance_id
            || binding.unsigned.config_revision != record.current_config_revision
            || binding.unsigned.config_digest != record.current_config_digest
            || binding.unsigned.premises_digest != record.current_premises_digest
            || binding.unsigned.service_candidate_digest != record.current_service_candidate_digest
        {
            return Err(RuntimeBindingError::DigestMismatch(
                "current runtime-binding pointer".into(),
            ));
        }
        if let Some(process_generation) = record.current_process_generation {
            let process =
                load_process_record(connection, process_generation)?.ok_or_else(|| {
                    RuntimeBindingError::DigestMismatch(
                        "current process-generation record is missing".into(),
                    )
                })?;
            if process.unsigned.controller_generation != controller_generation
                || process.unsigned.binding_digest != binding.binding_digest
            {
                return Err(RuntimeBindingError::DigestMismatch(
                    "current process-generation pointer".into(),
                ));
            }
        }
    } else if record.current_binding_digest.is_some() || record.current_process_generation.is_some()
    {
        return Err(RuntimeBindingError::DigestMismatch(
            "runtime-binding pointer has an incomplete current identity".into(),
        ));
    }
    Ok(Some(LoadedState { record }))
}

fn persist_state(
    tx: &Transaction<'_>,
    record: &RuntimeBindingStateRecord,
) -> Result<(), RuntimeBindingError> {
    let bytes = canonical_bytes(record)?;
    tx.execute(
        "INSERT INTO runtime_binding_authority_state (
            singleton, authority_schema_version, daemon_installation_id,
            instance_id, current_config_revision, current_config_digest,
            current_premises_digest, current_service_candidate_digest,
            current_controller_generation, current_binding_digest,
            current_process_generation, next_controller_generation,
            next_process_generation, record_jcs
         ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(singleton) DO UPDATE SET
            authority_schema_version = excluded.authority_schema_version,
            daemon_installation_id = excluded.daemon_installation_id,
            instance_id = excluded.instance_id,
            current_config_revision = excluded.current_config_revision,
            current_config_digest = excluded.current_config_digest,
            current_premises_digest = excluded.current_premises_digest,
            current_service_candidate_digest = excluded.current_service_candidate_digest,
            current_controller_generation = excluded.current_controller_generation,
            current_binding_digest = excluded.current_binding_digest,
            current_process_generation = excluded.current_process_generation,
            next_controller_generation = excluded.next_controller_generation,
            next_process_generation = excluded.next_process_generation,
            record_jcs = excluded.record_jcs",
        params![
            record.authority_schema_version,
            &record.daemon_installation_id,
            &record.instance_id,
            record.current_config_revision,
            record.current_config_digest.to_string(),
            record.current_premises_digest.to_string(),
            record.current_service_candidate_digest.to_string(),
            record.current_controller_generation.map(|v| v as i64),
            record
                .current_binding_digest
                .as_ref()
                .map(ToString::to_string),
            record.current_process_generation.map(|v| v as i64),
            record.next_controller_generation as i64,
            record.next_process_generation as i64,
            bytes,
        ],
    )?;
    Ok(())
}

fn load_binding_record(
    connection: &Connection,
    controller_generation: u64,
) -> Result<Option<RuntimeBindingRecord>, RuntimeBindingError> {
    let Some((
        bytes,
        daemon,
        instance,
        config_revision,
        config_digest,
        premises_digest,
        candidate_digest,
        binding_digest_text,
    )) = connection
        .query_row(
            "SELECT record_jcs, daemon_installation_id, instance_id,
                    config_revision, config_digest, premises_digest,
                    service_candidate_digest, binding_digest
             FROM runtime_binding_authority_records
             WHERE controller_generation = ?1",
            [controller_generation as i64],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let record: RuntimeBindingRecord = decode_record(&bytes, "runtime binding")?;
    let (_, digest) = canonicalize(&record.unsigned).map_err(canonical_error)?;
    if canonical_bytes(&record)? != bytes
        || record.unsigned.schema != RUNTIME_BINDING_RECORD_SCHEMA
        || record.unsigned.controller_generation != controller_generation
        || record.binding_digest != digest
        || record.unsigned.daemon_installation_id != daemon
        || record.unsigned.instance_id != instance
        || record.unsigned.config_revision != config_revision
        || record.unsigned.config_digest.to_string() != config_digest
        || record.unsigned.premises_digest.to_string() != premises_digest
        || record.unsigned.service_candidate_digest.to_string() != candidate_digest
        || record.binding_digest.to_string() != binding_digest_text
    {
        return Err(RuntimeBindingError::DigestMismatch(
            "runtime binding record".into(),
        ));
    }
    Ok(Some(record))
}

fn load_process_record(
    connection: &Connection,
    process_generation: u64,
) -> Result<Option<ProcessGenerationRecord>, RuntimeBindingError> {
    let Some((
        bytes,
        controller,
        daemon,
        instance,
        config_revision,
        config_digest,
        premises_digest,
        candidate_digest,
        binding_digest_text,
    )) = connection
        .query_row(
            "SELECT record_jcs, controller_generation, daemon_installation_id,
                    instance_id, config_revision, config_digest, premises_digest,
                    service_candidate_digest, binding_digest
             FROM process_generation_authority_records
             WHERE process_generation = ?1",
            [process_generation as i64],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let record: ProcessGenerationRecord = decode_record(&bytes, "process generation")?;
    let (_, digest) = canonicalize(&record.unsigned).map_err(canonical_error)?;
    if canonical_bytes(&record)? != bytes
        || record.unsigned.schema != PROCESS_GENERATION_RECORD_SCHEMA
        || record.unsigned.process_generation != process_generation
        || record.process_generation_digest != digest
        || record.unsigned.controller_generation as i64 != controller
        || record.unsigned.daemon_installation_id != daemon
        || record.unsigned.instance_id != instance
        || record.unsigned.config_revision != config_revision
        || record.unsigned.config_digest.to_string() != config_digest
        || record.unsigned.premises_digest.to_string() != premises_digest
        || record.unsigned.service_candidate_digest.to_string() != candidate_digest
        || record.unsigned.binding_digest.to_string() != binding_digest_text
    {
        return Err(RuntimeBindingError::DigestMismatch(
            "process generation record".into(),
        ));
    }
    Ok(Some(record))
}

fn ensure_generation_available(value: u64, kind: &'static str) -> Result<(), RuntimeBindingError> {
    if !(1..=MAX_GENERATION).contains(&value) {
        return Err(RuntimeBindingError::GenerationExhausted { kind });
    }
    Ok(())
}

fn next_generation(value: u64, kind: &'static str) -> Result<u64, RuntimeBindingError> {
    if value >= MAX_GENERATION {
        return Err(RuntimeBindingError::GenerationExhausted { kind });
    }
    Ok(value + 1)
}

fn canonical_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, RuntimeBindingError> {
    let (bytes, _) = canonicalize(value).map_err(canonical_error)?;
    Ok(bytes.as_ref().to_vec())
}

fn decode_record<T: serde::de::DeserializeOwned>(
    bytes: &[u8],
    label: &str,
) -> Result<T, RuntimeBindingError> {
    deserialize_core_json(
        bytes,
        ParseLimits::semantic(MAX_SEMANTIC_JSON_NESTING_DEPTH).map_err(canonical_error)?,
    )
    .map_err(|error| RuntimeBindingError::Malformed(format!("{label}: {error}")))
}

fn canonical_error(error: impl fmt::Display) -> RuntimeBindingError {
    RuntimeBindingError::Canonical(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_authority::{
        ConfigRevisionMapping, HostAuthorityRevision, LinuxServiceCandidate,
        ModuleActivationPremises, ResolvedConfiguration, RuntimeAuthorityIdentity,
        create_host_authority_schema, install_host_authority_revision,
    };
    use crate::linux_host_verification::test_proof_for_authority;
    use dolly_canonical_json::CanonicalJsonValue;
    use serde_json::{Value, json};
    use tempfile::{TempDir, tempdir};

    fn digest(value: &Value) -> Sha256Digest {
        canonicalize(value).unwrap().1
    }

    fn without(value: &Value, field: &str) -> Value {
        let mut object = value.as_object().unwrap().clone();
        object.remove(field);
        Value::Object(object)
    }

    fn authority_revision(instance_id: &str, with_premise: bool) -> HostAuthorityRevision {
        let origin = InstalledComponentOrigin {
            schema: "dolly.installed-component-origin/v1".into(),
            kind: "installed_product_component".into(),
            component_id: "org.dolly.host-runtime".into(),
            component_revision: 1,
            component_digest: digest(&json!({"component": "host-runtime"})),
        };
        let mut candidate_record = json!({
            "schema": "dolly.linux-service-candidate/v1",
            "origin": serde_json::to_value(&origin).unwrap(),
            "unit_name": "dollyd@main.service",
            "mode": "user",
            "candidate_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        });
        candidate_record["candidate_digest"] =
            json!(digest(&without(&candidate_record, "candidate_digest")).to_string());
        let candidate: LinuxServiceCandidate = serde_json::from_value(candidate_record).unwrap();
        let config = ResolvedConfiguration {
            runtime_config: CanonicalJsonValue::try_from(json!({"modules": ["installed"]}))
                .unwrap(),
            permission_policy_selections: Vec::new(),
            service_candidate: with_premise.then_some(candidate.clone()),
        };
        let config_digest = canonicalize(&config).unwrap().1;
        let premise = with_premise.then(|| {
            let mut premise_record = json!({
                "schema": "dolly.module-activation-premises/v1",
                "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
                "instance_id": instance_id,
                "config_revision": 1,
                "config_digest": config_digest,
                "permission_policy_definitions": [],
                "permission_policy_backend_bindings": [],
                "service_candidate": serde_json::to_value(&candidate).unwrap(),
                "premises_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            });
            premise_record["premises_digest"] =
                json!(digest(&without(&premise_record, "premises_digest")).to_string());
            serde_json::from_value::<ModuleActivationPremises>(premise_record).unwrap()
        });
        HostAuthorityRevision {
            identity: RuntimeAuthorityIdentity {
                daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
                instance_id: instance_id.into(),
            },
            mapping: ConfigRevisionMapping {
                schema: "dolly.config-revision-mapping/v1".into(),
                daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
                instance_id: instance_id.into(),
                config_revision: 1,
                config_digest,
                canonical_config: config,
            },
            premise,
        }
    }

    fn durable_database(
        instance_id: &str,
        with_premise: bool,
    ) -> (TempDir, Database, CurrentAuthoritySnapshot) {
        let directory = tempdir().unwrap();
        let path = directory.path().join("runtime.sqlite3");
        let mut db = Database::open(&path).unwrap();
        create_host_authority_schema(db.connection()).unwrap();
        install_host_authority_revision(&mut db, authority_revision(instance_id, with_premise))
            .unwrap();
        let snapshot = load_authority(db.connection()).unwrap();
        (directory, db, snapshot)
    }

    #[test]
    fn exact_proof_binding_mints_fresh_generation_and_rejects_reuse() {
        let (_directory, mut db, snapshot) = durable_database("instance-one", true);
        let proof = test_proof_for_authority(&snapshot);
        let mut binding = mint_runtime_binding(&mut db, proof).unwrap();
        assert_eq!(binding.controller_generation(), 1);
        assert_eq!(binding.instance_id(), "instance-one");
        assert_eq!(
            binding.service_candidate_digest(),
            &snapshot
                .premise
                .as_ref()
                .unwrap()
                .service_candidate
                .candidate_digest
        );

        let generation = binding.mint_process_generation(&mut db).unwrap();
        assert_eq!(generation.controller_generation(), 1);
        assert_eq!(generation.process_generation(), 1);
        assert_eq!(generation.instance_id(), "instance-one");
        assert_eq!(generation.service().unit_name, "dollyd@main.service");
        assert_eq!(
            generation.delegated_root().controllers,
            vec!["cpu", "memory", "pids"]
        );
        assert!(matches!(
            binding.mint_process_generation(&mut db),
            Err(RuntimeBindingError::BindingConsumed)
        ));
        assert_eq!(
            db.connection()
                .query_row(
                    "SELECT COUNT(*) FROM process_generation_authority_records",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn fresh_binding_and_process_generation_never_reuse_prior_values() {
        let (_directory, mut db, snapshot) = durable_database("instance-one", true);
        let mut first = mint_runtime_binding(&mut db, test_proof_for_authority(&snapshot)).unwrap();
        let first_generation = first.mint_process_generation(&mut db).unwrap();
        let mut second =
            mint_runtime_binding(&mut db, test_proof_for_authority(&snapshot)).unwrap();
        let second_generation = second.mint_process_generation(&mut db).unwrap();
        assert_eq!(first_generation.controller_generation(), 1);
        assert_eq!(first_generation.process_generation(), 1);
        assert_eq!(second.controller_generation(), 2);
        assert_eq!(second_generation.controller_generation(), 2);
        assert_eq!(second_generation.process_generation(), 2);
        assert_ne!(first.binding_digest(), second.binding_digest());
    }

    #[test]
    fn proof_from_another_authority_is_rejected_without_rows() {
        let (_first_directory, _first_db, first_snapshot) = durable_database("instance-one", true);
        let (_second_directory, mut second_db, _second_snapshot) =
            durable_database("instance-two", true);
        let error = mint_runtime_binding(&mut second_db, test_proof_for_authority(&first_snapshot))
            .unwrap_err();
        assert!(matches!(error, RuntimeBindingError::ProofMismatch(_)));
        assert_eq!(
            second_db
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM runtime_binding_authority_records",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn changed_current_pointer_refuses_binding_and_process_generation() {
        let (_directory, mut db, snapshot) = durable_database("instance-one", true);
        let proof = test_proof_for_authority(&snapshot);
        db.connection()
            .execute(
                "UPDATE runtime_authority_state SET instance_id = 'changed-instance'",
                [],
            )
            .unwrap();
        let error = mint_runtime_binding(&mut db, proof).unwrap_err();
        assert!(matches!(
            error,
            RuntimeBindingError::AuthorityStale(_) | RuntimeBindingError::ProofMismatch(_)
        ));
        assert_eq!(
            db.connection()
                .query_row(
                    "SELECT COUNT(*) FROM runtime_binding_authority_records",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );

        let (_directory, mut db, snapshot) = durable_database("instance-one", true);
        let mut binding =
            mint_runtime_binding(&mut db, test_proof_for_authority(&snapshot)).unwrap();
        db.connection()
            .execute(
                "UPDATE runtime_authority_state SET instance_id = 'changed-instance'",
                [],
            )
            .unwrap();
        let error = binding.mint_process_generation(&mut db).unwrap_err();
        assert!(matches!(
            error,
            RuntimeBindingError::AuthorityStale(_) | RuntimeBindingError::BindingStale(_)
        ));
        assert_eq!(
            db.connection()
                .query_row(
                    "SELECT COUNT(*) FROM process_generation_authority_records",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn absent_premise_fails_closed_before_binding() {
        let (_directory, mut db, _snapshot) = durable_database("instance-one", false);
        let error = mint_current_runtime_binding(&mut db).unwrap_err();
        assert!(matches!(
            error,
            RuntimeBindingError::HostVerification(error)
                if error.code == crate::linux_host_verification::LinuxHostVerificationCode::PremiseMissing
        ));
        create_runtime_binding_schema(db.connection()).unwrap();
        assert_eq!(
            db.connection()
                .query_row(
                    "SELECT COUNT(*) FROM runtime_binding_authority_records",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn duplicate_process_generation_refuses_and_rolls_back_pointer() {
        let (_directory, mut db, snapshot) = durable_database("instance-one", true);
        let mut binding =
            mint_runtime_binding(&mut db, test_proof_for_authority(&snapshot)).unwrap();
        db.connection()
            .execute(
                "INSERT INTO process_generation_authority_records (
                    process_generation, controller_generation, daemon_installation_id,
                    instance_id, config_revision, config_digest, premises_digest,
                    service_candidate_digest, binding_digest, record_jcs
                 ) VALUES (1, 1, '0198ab31-6c44-7e8a-b2bb-000000000001',
                    'instance-one', 1, 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
                    'sha256:0000000000000000000000000000000000000000000000000000000000000000',
                    'sha256:0000000000000000000000000000000000000000000000000000000000000000',
                    'sha256:0000000000000000000000000000000000000000000000000000000000000000',
                    '{}')",
                [],
            )
            .unwrap();
        let error = binding.mint_process_generation(&mut db).unwrap_err();
        assert!(matches!(
            error,
            RuntimeBindingError::GenerationConflict {
                kind: "process",
                generation: 1
            }
        ));
        assert_eq!(
            db.connection()
                .query_row(
                    "SELECT current_process_generation FROM runtime_binding_authority_state",
                    [],
                    |row| row.get::<_, Option<i64>>(0)
                )
                .unwrap(),
            None
        );
    }

    #[test]
    fn state_projection_tampering_refuses_partial_advance() {
        let (_directory, mut db, snapshot) = durable_database("instance-one", true);
        let mut binding =
            mint_runtime_binding(&mut db, test_proof_for_authority(&snapshot)).unwrap();
        db.connection()
            .execute(
                "UPDATE runtime_binding_authority_state SET next_process_generation = 2",
                [],
            )
            .unwrap();
        let error = binding.mint_process_generation(&mut db).unwrap_err();
        assert!(matches!(error, RuntimeBindingError::DigestMismatch(_)));
        assert_eq!(
            db.connection()
                .query_row(
                    "SELECT COUNT(*) FROM process_generation_authority_records",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn unsupported_platform_fails_closed_before_binding() {
        let (_directory, mut db, _snapshot) = durable_database("instance-one", true);
        let error = mint_current_runtime_binding(&mut db).unwrap_err();
        assert!(matches!(
            error,
            RuntimeBindingError::HostVerification(error)
                if error.code == crate::linux_host_verification::LinuxHostVerificationCode::PlatformUnsupported
        ));
    }
}
