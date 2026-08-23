//! Durable Tool Broker registry and dispatch authority.
//!
//! This is the narrow producer between the current Host/runtime/MCP premises
//! and the existing durable Tool-call ledger. It admits the exact tool-broker
//! configuration from the current Host revision, verifies the live typed
//! runtime/process identities and immutable MCP readiness, and then records a
//! versioned registry revision plus one server generation transactionally.
//! No function in this module mints or advances Host, Runtime, process, or MCP
//! authority. A dispatch authority is only a closed observation of an already
//! committed registry/generation pair; it is not a result, acknowledgement, or
//! retry capability.

use std::fmt;

use dolly_canonical_json::{
    CanonicalBytes, CanonicalJsonValue, Sha256Digest, canonicalize, deserialize_core_json,
};
use dolly_core_domain::{ExtensionGeneration, ExtensionId, WorkerEpoch};
use dolly_tool_broker::{AdmissionOutcome, ResolvedToolBrokerConfig, admit_config};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::host_authority::{
    CurrentAuthoritySnapshot, HostAuthorityError, InstalledComponentOrigin, load_current_authority,
};
use crate::mcp_readiness::{MCP_TRANSPORT_READINESS_SCHEMA, McpTransportReadiness};
use crate::runtime_binding::{ProcessGeneration, RuntimeBinding};
use crate::{Database, StorageError};

/// The closed schema version for registry authority tables.
pub const TOOL_BROKER_AUTHORITY_SCHEMA_VERSION: i64 = 1;
/// The closed version of one retained resolved registry revision.
pub const TOOL_REGISTRY_RECORD_SCHEMA: &str = "dolly.tool-registry-revision/v1";
/// The closed version of one retained tool-server generation.
pub const TOOL_SERVER_GENERATION_RECORD_SCHEMA: &str = "dolly.tool-server-generation/v1";

/// Fail-closed classifications for registry publication and dispatch authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolBrokerAuthorityCode {
    StorageCorrupt,
    HostPremiseMissing,
    HostPremiseStale,
    RuntimeBindingStale,
    ProcessGenerationStale,
    ReadinessStale,
    RegistryBindingMismatch,
    RegistryConfigInvalid,
    RegistryNotCurrent,
    DuplicateGeneration,
    CanonicalInvalid,
    DispatchBindingMismatch,
}

/// Structured refusal. No partial registry or dispatch authority is returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolBrokerAuthorityError {
    pub code: ToolBrokerAuthorityCode,
    pub detail: String,
}

impl ToolBrokerAuthorityError {
    fn new(code: ToolBrokerAuthorityCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for ToolBrokerAuthorityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Tool Broker authority refused ({:?}): {}",
            self.code, self.detail
        )
    }
}

impl std::error::Error for ToolBrokerAuthorityError {}

impl From<rusqlite::Error> for ToolBrokerAuthorityError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new(ToolBrokerAuthorityCode::StorageCorrupt, error.to_string())
    }
}

impl From<HostAuthorityError> for ToolBrokerAuthorityError {
    fn from(error: HostAuthorityError) -> Self {
        Self::new(ToolBrokerAuthorityCode::HostPremiseStale, error.to_string())
    }
}

impl From<StorageError> for ToolBrokerAuthorityError {
    fn from(error: StorageError) -> Self {
        Self::new(ToolBrokerAuthorityCode::StorageCorrupt, error.to_string())
    }
}

/// Canonical, closed registry revision record.
///
/// The complete admitted tool-broker document is retained in `tool_broker_config`
/// so a later configuration cutover cannot reinterpret an in-flight operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolRegistryRecord {
    pub schema: String,
    pub registry_revision: u64,
    pub config_revision: i64,
    pub config_digest: Sha256Digest,
    pub tool_broker_config: CanonicalJsonValue,
    pub tool_broker_config_digest: Sha256Digest,
    pub premises_digest: Sha256Digest,
    pub service_candidate_digest: Sha256Digest,
    pub service_candidate_origin: InstalledComponentOrigin,
    pub extension_alias: ExtensionId,
    pub controller_generation: ExtensionGeneration,
    pub worker_epoch: WorkerEpoch,
    pub extension_generation: ExtensionGeneration,
    pub runtime_binding_digest: Sha256Digest,
    pub mcp_readiness_digest: Sha256Digest,
    pub server_id: String,
    pub server_digest: Sha256Digest,
    pub server_adapter: String,
    pub server_protocol_version: String,
    pub server_transport_kind: String,
    pub server_endpoint_digest: Sha256Digest,
    pub server_transport_digest: Sha256Digest,
    pub tool_server_generation: u64,
}

impl ToolRegistryRecord {
    /// The canonical bytes and digest stored by SQLite for this record.
    pub fn canonical_bytes_and_digest(
        &self,
    ) -> Result<(CanonicalBytes, Sha256Digest), ToolBrokerAuthorityError> {
        canonicalize(self).map_err(|error| {
            ToolBrokerAuthorityError::new(
                ToolBrokerAuthorityCode::CanonicalInvalid,
                error.to_string(),
            )
        })
    }

    /// Verify that persisted bytes and digest are exactly this closed record.
    pub fn verify_canonical(
        &self,
        bytes: &[u8],
        digest: &Sha256Digest,
    ) -> Result<(), ToolBrokerAuthorityError> {
        let (expected_bytes, expected_digest) = self.canonical_bytes_and_digest()?;
        if expected_bytes.as_ref() != bytes || &expected_digest != digest {
            return Err(ToolBrokerAuthorityError::new(
                ToolBrokerAuthorityCode::CanonicalInvalid,
                "registry record bytes or digest changed",
            ));
        }
        Ok(())
    }

    /// Validate the current Host/runtime/MCP identity projection before a
    /// dispatch authority is issued.
    #[allow(clippy::too_many_arguments)]
    pub fn validate_identity(
        &self,
        config_revision: i64,
        config_digest: &Sha256Digest,
        premises_digest: &Sha256Digest,
        runtime_binding_digest: &Sha256Digest,
        readiness_digest: &Sha256Digest,
        service_candidate_digest: &Sha256Digest,
        service_candidate_origin: &InstalledComponentOrigin,
        extension_alias: &ExtensionId,
        controller_generation: u64,
        extension_generation: u64,
        worker_epoch: &str,
        server_id: &str,
        server_digest: &Sha256Digest,
        server_adapter: &str,
        server_protocol_version: &str,
        server_transport_kind: &str,
        server_endpoint_digest: &Sha256Digest,
        server_transport_digest: &Sha256Digest,
    ) -> Result<(), ToolBrokerAuthorityError> {
        if self.config_revision != config_revision
            || &self.config_digest != config_digest
            || &self.premises_digest != premises_digest
            || &self.service_candidate_digest != service_candidate_digest
            || &self.service_candidate_origin != service_candidate_origin
            || &self.extension_alias != extension_alias
            || &self.runtime_binding_digest != runtime_binding_digest
            || self.controller_generation.value() != controller_generation
            || self.extension_generation.value() != extension_generation
            || self.worker_epoch.to_string() != worker_epoch
            || self.server_id != server_id
            || &self.server_digest != server_digest
            || self.server_adapter != server_adapter
            || self.server_protocol_version != server_protocol_version
            || self.server_transport_kind != server_transport_kind
            || &self.server_endpoint_digest != server_endpoint_digest
            || &self.server_transport_digest != server_transport_digest
        {
            return Err(ToolBrokerAuthorityError::new(
                ToolBrokerAuthorityCode::RegistryBindingMismatch,
                "registry revision is not bound to the complete Host/runtime/MCP identity",
            ));
        }
        if &self.mcp_readiness_digest != readiness_digest {
            return Err(ToolBrokerAuthorityError::new(
                ToolBrokerAuthorityCode::ReadinessStale,
                "MCP readiness digest is not the current immutable readiness evidence",
            ));
        }
        Ok(())
    }

    /// Reject a different generation under the same retained record identity.
    pub fn validate_generation(&self, generation: u64) -> Result<(), ToolBrokerAuthorityError> {
        if self.tool_server_generation != generation {
            return Err(ToolBrokerAuthorityError::new(
                ToolBrokerAuthorityCode::DuplicateGeneration,
                format!(
                    "tool-server generation {} does not equal retained generation {}",
                    generation, self.tool_server_generation
                ),
            ));
        }
        Ok(())
    }
}

/// Canonical retained registry plus the admitted pure configuration.
#[derive(Debug, Clone)]
pub struct ToolRegistryRevision {
    record: ToolRegistryRecord,
    record_bytes: CanonicalBytes,
    record_digest: Sha256Digest,
    config: ResolvedToolBrokerConfig,
}

impl ToolRegistryRevision {
    pub fn record(&self) -> &ToolRegistryRecord {
        &self.record
    }

    pub fn record_digest(&self) -> &Sha256Digest {
        &self.record_digest
    }

    pub fn canonical_bytes(&self) -> &[u8] {
        self.record_bytes.as_ref()
    }

    pub fn config(&self) -> &ResolvedToolBrokerConfig {
        &self.config
    }

    pub fn registry_revision(&self) -> u64 {
        self.record.registry_revision
    }

    pub fn server_id(&self) -> &str {
        &self.record.server_id
    }

    pub fn tool_server_generation(&self) -> u64 {
        self.record.tool_server_generation
    }
}

/// Immutable permission to cross the existing `AUTHORIZED -> DISPATCHED`
/// boundary for one exact retained server generation.
///
/// It carries no transport handle and no result authority. It is issued only
/// after the current Host/runtime/MCP premises and the current registry pointer
/// have been checked together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDispatchAuthority {
    registry_revision: u64,
    registry_record_digest: Sha256Digest,
    config_revision: i64,
    config_digest: Sha256Digest,
    server_id: String,
    tool_server_generation: u64,
    extension_alias: ExtensionId,
    extension_generation: ExtensionGeneration,
    controller_generation: ExtensionGeneration,
    worker_epoch: WorkerEpoch,
    runtime_binding_digest: Sha256Digest,
    readiness_digest: Sha256Digest,
}

impl ToolDispatchAuthority {
    pub fn registry_revision(&self) -> u64 {
        self.registry_revision
    }

    pub fn registry_record_digest(&self) -> &Sha256Digest {
        &self.registry_record_digest
    }

    pub fn config_revision(&self) -> i64 {
        self.config_revision
    }

    pub fn config_digest(&self) -> &Sha256Digest {
        &self.config_digest
    }

    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    pub fn tool_server_generation(&self) -> u64 {
        self.tool_server_generation
    }

    pub fn extension_alias(&self) -> &ExtensionId {
        &self.extension_alias
    }

    pub fn extension_generation(&self) -> ExtensionGeneration {
        self.extension_generation
    }

    pub fn controller_generation(&self) -> ExtensionGeneration {
        self.controller_generation
    }

    pub fn worker_epoch(&self) -> &WorkerEpoch {
        &self.worker_epoch
    }

    pub fn runtime_binding_digest(&self) -> &Sha256Digest {
        &self.runtime_binding_digest
    }

    pub fn readiness_digest(&self) -> &Sha256Digest {
        &self.readiness_digest
    }

    /// Check that a ledger binding names the exact registry/generation that
    /// produced this permission. No ledger or upstream state is changed.
    pub fn permits_binding(&self, config_revision: i64, server_id: &str, generation: u64) -> bool {
        self.config_revision == config_revision
            && self.server_id == server_id
            && self.tool_server_generation == generation
    }
}

/// Physical tables for append-only registry revisions, generations, and the
/// current pointer. The pointer is updated last by `publish_tool_registry`.
pub const TOOL_BROKER_AUTHORITY_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS tool_broker_authority_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1)
);
CREATE TABLE IF NOT EXISTS tool_registry_authority_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    current_registry_revision INTEGER,
    current_record_digest TEXT,
    next_registry_revision INTEGER NOT NULL CHECK (next_registry_revision BETWEEN 1 AND 9007199254740991),
    record_jcs BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_registry_authority_records (
    registry_revision INTEGER PRIMARY KEY CHECK (registry_revision BETWEEN 1 AND 9007199254740991),
    config_revision INTEGER NOT NULL CHECK (config_revision BETWEEN 1 AND 9007199254740991),
    config_digest TEXT NOT NULL,
    server_id TEXT NOT NULL,
    tool_server_generation INTEGER NOT NULL CHECK (tool_server_generation BETWEEN 1 AND 9007199254740991),
    extension_alias TEXT NOT NULL,
    extension_generation INTEGER NOT NULL CHECK (extension_generation BETWEEN 1 AND 9007199254740991),
    readiness_digest TEXT NOT NULL,
    record_jcs BLOB NOT NULL,
    record_digest TEXT NOT NULL,
    UNIQUE (config_revision, config_digest, server_id, extension_alias, extension_generation),
    UNIQUE (server_id, tool_server_generation)
);
CREATE TABLE IF NOT EXISTS tool_server_generation_authority_records (
    server_id TEXT NOT NULL,
    tool_server_generation INTEGER NOT NULL CHECK (tool_server_generation BETWEEN 1 AND 9007199254740991),
    registry_revision INTEGER NOT NULL CHECK (registry_revision BETWEEN 1 AND 9007199254740991),
    extension_alias TEXT NOT NULL,
    extension_generation INTEGER NOT NULL CHECK (extension_generation BETWEEN 1 AND 9007199254740991),
    worker_epoch TEXT NOT NULL,
    runtime_binding_digest TEXT NOT NULL,
    readiness_digest TEXT NOT NULL,
    record_jcs BLOB NOT NULL,
    record_digest TEXT NOT NULL,
    PRIMARY KEY (server_id, tool_server_generation),
    UNIQUE (server_id, registry_revision),
    FOREIGN KEY (registry_revision) REFERENCES tool_registry_authority_records(registry_revision)
);
CREATE TABLE IF NOT EXISTS tool_server_generation_state (
    server_id TEXT PRIMARY KEY,
    current_generation INTEGER,
    next_generation INTEGER NOT NULL CHECK (next_generation BETWEEN 1 AND 9007199254740991),
    record_jcs BLOB NOT NULL
);
"#;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthorityStateRecord {
    schema: String,
    current_registry_revision: Option<u64>,
    current_record_digest: Option<Sha256Digest>,
    next_registry_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GenerationStateRecord {
    schema: String,
    server_id: String,
    current_generation: Option<u64>,
    next_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolServerGenerationRecord {
    schema: String,
    server_id: String,
    tool_server_generation: u64,
    registry_revision: u64,
    extension_alias: ExtensionId,
    extension_generation: ExtensionGeneration,
    worker_epoch: WorkerEpoch,
    runtime_binding_digest: Sha256Digest,
    readiness_digest: Sha256Digest,
}

/// Create or verify the private registry/generation authority tables.
pub fn create_tool_broker_authority_schema(
    connection: &Connection,
) -> Result<(), ToolBrokerAuthorityError> {
    connection.execute_batch(TOOL_BROKER_AUTHORITY_SCHEMA_SQL)?;
    connection.execute(
        "INSERT OR IGNORE INTO tool_broker_authority_meta (singleton, authority_schema_version) VALUES (1, ?1)",
        [TOOL_BROKER_AUTHORITY_SCHEMA_VERSION],
    )?;
    let state = AuthorityStateRecord {
        schema: "dolly.tool-broker-authority-state/v1".into(),
        current_registry_revision: None,
        current_record_digest: None,
        next_registry_revision: 1,
    };
    let state_bytes = canonical_record_bytes(&state)?;
    connection.execute(
        "INSERT OR IGNORE INTO tool_registry_authority_state
            (singleton, current_registry_revision, current_record_digest, next_registry_revision, record_jcs)
         VALUES (1, NULL, NULL, 1, ?1)",
        [state_bytes.as_ref()],
    )?;
    let version: i64 = connection.query_row(
        "SELECT authority_schema_version FROM tool_broker_authority_meta WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    if version != TOOL_BROKER_AUTHORITY_SCHEMA_VERSION {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::StorageCorrupt,
            "unsupported Tool Broker authority schema version",
        ));
    }
    Ok(())
}

/// Publish the exact current Host configuration and one verified MCP server
/// generation. All registry/generation rows are committed before the current
/// pointer is updated. Repeating the same immutable process/readiness identity
/// returns the retained revision without creating a duplicate generation.
pub fn publish_tool_registry(
    db: &mut Database,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    readiness: &McpTransportReadiness,
) -> Result<ToolRegistryRevision, ToolBrokerAuthorityError> {
    create_tool_broker_authority_schema(db.connection())?;
    let snapshot = load_current_snapshot(db.connection())?;
    let (config_value, config) = validate_current_premises(
        db.connection(),
        &snapshot,
        runtime_binding,
        process_generation,
        readiness,
    )?;
    let server = config.servers().get(readiness.server_id()).ok_or_else(|| {
        ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RegistryBindingMismatch,
            "MCP readiness names a server absent from the admitted registry",
        )
    })?;
    let server_digest = canonicalize(&CanonicalJsonValue::Object(server.server_contract.clone()))
        .map_err(|error| {
            ToolBrokerAuthorityError::new(
                ToolBrokerAuthorityCode::CanonicalInvalid,
                error.to_string(),
            )
        })?
        .1;
    if &server_digest != readiness.server_digest()
        || server.adapter != readiness.adapter()
        || server.protocol_version != readiness.protocol_version()
        || server.transport_kind != readiness.transport_kind()
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RegistryBindingMismatch,
            "MCP readiness does not bind the admitted server contract",
        ));
    }

    let tx = db
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = load_current_snapshot(&tx)?;
    ensure_same_snapshot(&snapshot, &current)?;
    validate_current_premises(
        &tx,
        &current,
        runtime_binding,
        process_generation,
        readiness,
    )?;
    let state = load_authority_state(&tx)?;

    if let Some(current_revision) = state.current_registry_revision {
        let current_record = load_registry_record(&tx, current_revision)?;
        if current_record.config_revision > snapshot.mapping.config_revision {
            return Err(ToolBrokerAuthorityError::new(
                ToolBrokerAuthorityCode::HostPremiseStale,
                "current Host revision regressed below the published registry",
            ));
        }
    }

    // A process generation is single-use for a server identity. An exact
    // repeated publication is an idempotent replay; any other readiness or
    // binding under that process generation is a duplicate-generation refusal.
    let existing: Option<(u64, Vec<u8>, String)> = tx
        .query_row(
            "SELECT registry_revision, record_jcs, record_digest
             FROM tool_registry_authority_records
             WHERE config_revision = ?1 AND config_digest = ?2 AND server_id = ?3
               AND extension_alias = ?4 AND extension_generation = ?5",
            params![
                snapshot.mapping.config_revision,
                snapshot.mapping.config_digest.to_string(),
                readiness.server_id(),
                runtime_binding.extension_alias().to_string(),
                process_generation.extension_generation().value() as i64,
            ],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((_registry_revision, bytes, digest_text)) = existing {
        let digest = parse_digest(&digest_text)?;
        let record = decode_registry_record(&bytes, &digest)?;
        if record.mcp_readiness_digest == *readiness.readiness_digest()
            && record.runtime_binding_digest == *runtime_binding.binding_digest()
        {
            let config = admit_registry_config(&record.tool_broker_config)?;
            let (record_bytes, _) = record.canonical_bytes_and_digest()?;
            tx.commit()?;
            return Ok(ToolRegistryRevision {
                record,
                record_bytes,
                record_digest: digest,
                config,
            });
        }
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::DuplicateGeneration,
            "process generation already has a different retained registry/readiness identity",
        ));
    }

    let registry_revision = state.next_registry_revision;
    let generation = next_server_generation(&tx, readiness.server_id())?;
    let tool_broker_config_digest =
        Sha256Digest::compute(canonical_record_bytes(&config_value)?.as_ref());
    let record = ToolRegistryRecord {
        schema: TOOL_REGISTRY_RECORD_SCHEMA.into(),
        registry_revision,
        config_revision: snapshot.mapping.config_revision,
        config_digest: snapshot.mapping.config_digest.clone(),
        tool_broker_config: config_value,
        tool_broker_config_digest,
        premises_digest: runtime_binding.premises_digest().clone(),
        service_candidate_digest: runtime_binding.service_candidate_digest().clone(),
        service_candidate_origin: runtime_binding.service_candidate_origin().clone(),
        extension_alias: runtime_binding.extension_alias().clone(),
        controller_generation: runtime_binding.controller_generation(),
        worker_epoch: runtime_binding.worker_epoch().clone(),
        extension_generation: process_generation.extension_generation(),
        runtime_binding_digest: runtime_binding.binding_digest().clone(),
        mcp_readiness_digest: readiness.readiness_digest().clone(),
        server_id: readiness.server_id().to_owned(),
        server_digest: readiness.server_digest().clone(),
        server_adapter: readiness.adapter().to_owned(),
        server_protocol_version: readiness.protocol_version().to_owned(),
        server_transport_kind: readiness.transport_kind().to_owned(),
        server_endpoint_digest: readiness.endpoint_digest().clone(),
        server_transport_digest: readiness.transport_digest().clone(),
        tool_server_generation: generation,
    };
    let (record_bytes, record_digest) = record.canonical_bytes_and_digest()?;
    let generation_record = ToolServerGenerationRecord {
        schema: TOOL_SERVER_GENERATION_RECORD_SCHEMA.into(),
        server_id: record.server_id.clone(),
        tool_server_generation: generation,
        registry_revision,
        extension_alias: record.extension_alias.clone(),
        extension_generation: record.extension_generation,
        worker_epoch: record.worker_epoch.clone(),
        runtime_binding_digest: record.runtime_binding_digest.clone(),
        readiness_digest: record.mcp_readiness_digest.clone(),
    };
    let generation_bytes = canonical_record_bytes(&generation_record)?;
    let generation_digest = Sha256Digest::compute(generation_bytes.as_ref());

    tx.execute(
        "INSERT INTO tool_registry_authority_records
            (registry_revision, config_revision, config_digest, server_id,
             tool_server_generation, extension_alias, extension_generation,
             readiness_digest, record_jcs, record_digest)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            registry_revision as i64,
            record.config_revision,
            record.config_digest.to_string(),
            record.server_id,
            generation as i64,
            record.extension_alias.to_string(),
            record.extension_generation.value() as i64,
            record.mcp_readiness_digest.to_string(),
            record_bytes.as_ref(),
            record_digest.to_string(),
        ],
    )?;
    tx.execute(
        "INSERT INTO tool_server_generation_authority_records
            (server_id, tool_server_generation, registry_revision, extension_alias,
             extension_generation, worker_epoch, runtime_binding_digest,
             readiness_digest, record_jcs, record_digest)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            generation_record.server_id,
            generation as i64,
            registry_revision as i64,
            generation_record.extension_alias.to_string(),
            generation_record.extension_generation.value() as i64,
            generation_record.worker_epoch.to_string(),
            generation_record.runtime_binding_digest.to_string(),
            generation_record.readiness_digest.to_string(),
            generation_bytes.as_ref(),
            generation_digest.to_string(),
        ],
    )?;
    persist_generation_state(&tx, readiness.server_id(), generation)?;
    let next_registry_revision = registry_revision.checked_add(1).ok_or_else(|| {
        ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::DuplicateGeneration,
            "registry revision exhausted",
        )
    })?;
    persist_authority_state(
        &tx,
        registry_revision,
        &record_digest,
        next_registry_revision,
    )?;
    tx.commit()?;

    Ok(ToolRegistryRevision {
        record,
        record_bytes,
        record_digest,
        config,
    })
}

/// Revalidate the current pointer, registry record, typed runtime/process
/// identities, and immutable MCP readiness before issuing a dispatch token.
pub fn authorize_tool_dispatch(
    db: &mut Database,
    registry: &ToolRegistryRevision,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    readiness: &McpTransportReadiness,
) -> Result<ToolDispatchAuthority, ToolBrokerAuthorityError> {
    let snapshot = load_current_snapshot(db.connection())?;
    let (_config_value, _config) = validate_current_premises(
        db.connection(),
        &snapshot,
        runtime_binding,
        process_generation,
        readiness,
    )?;
    let state = load_authority_state(db.connection())?;
    if state.current_registry_revision != Some(registry.registry_revision()) {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RegistryNotCurrent,
            "registry revision is not the current authority pointer",
        ));
    }
    let persisted = load_registry_record(db.connection(), registry.registry_revision())?;
    let (bytes, digest) = persisted.canonical_bytes_and_digest()?;
    let generation_record = load_generation_record(
        db.connection(),
        &persisted.server_id,
        persisted.tool_server_generation,
        persisted.registry_revision,
    )?;
    if generation_record.extension_alias != persisted.extension_alias
        || generation_record.extension_generation != persisted.extension_generation
        || generation_record.worker_epoch != persisted.worker_epoch
        || generation_record.runtime_binding_digest != persisted.runtime_binding_digest
        || generation_record.readiness_digest != persisted.mcp_readiness_digest
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::CanonicalInvalid,
            "tool-server generation projection differs from registry revision",
        ));
    }
    if &digest != registry.record_digest() || bytes.as_ref() != registry.canonical_bytes() {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::CanonicalInvalid,
            "caller registry differs from the canonical persisted revision",
        ));
    }
    persisted.validate_identity(
        snapshot.mapping.config_revision,
        &snapshot.mapping.config_digest,
        runtime_binding.premises_digest(),
        runtime_binding.binding_digest(),
        readiness.readiness_digest(),
        runtime_binding.service_candidate_digest(),
        runtime_binding.service_candidate_origin(),
        runtime_binding.extension_alias(),
        runtime_binding.controller_generation().value(),
        process_generation.extension_generation().value(),
        &runtime_binding.worker_epoch().to_string(),
        readiness.server_id(),
        readiness.server_digest(),
        readiness.adapter(),
        readiness.protocol_version(),
        readiness.transport_kind(),
        readiness.endpoint_digest(),
        readiness.transport_digest(),
    )?;
    if persisted.server_id != readiness.server_id()
        || persisted.tool_server_generation != registry.tool_server_generation()
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RegistryBindingMismatch,
            "dispatch target is not the retained ready server generation",
        ));
    }
    Ok(ToolDispatchAuthority {
        registry_revision: persisted.registry_revision,
        registry_record_digest: digest,
        config_revision: persisted.config_revision,
        config_digest: persisted.config_digest,

        server_id: persisted.server_id,
        tool_server_generation: persisted.tool_server_generation,
        extension_alias: persisted.extension_alias,
        extension_generation: persisted.extension_generation,
        controller_generation: persisted.controller_generation,
        worker_epoch: persisted.worker_epoch,
        runtime_binding_digest: persisted.runtime_binding_digest,
        readiness_digest: persisted.mcp_readiness_digest,
    })
}
/// Revalidate a previously issued private authority at the exact dispatch
/// boundary. This reloads the current Host/runtime/process/MCP premises and
/// the durable registry pointer/record/generation; no cloned authority can
/// survive a cutover or premise change.
pub fn revalidate_tool_dispatch_authority(
    db: &mut Database,
    authority: &ToolDispatchAuthority,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    readiness: &McpTransportReadiness,
) -> Result<(), ToolBrokerAuthorityError> {
    let snapshot = load_current_snapshot(db.connection())?;
    let (_config_value, _config) = validate_current_premises(
        db.connection(),
        &snapshot,
        runtime_binding,
        process_generation,
        readiness,
    )?;
    let state = load_authority_state(db.connection())?;
    if state.current_registry_revision != Some(authority.registry_revision) {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RegistryNotCurrent,
            "dispatch authority is not the current registry pointer",
        ));
    }
    let persisted = load_registry_record(db.connection(), authority.registry_revision)?;
    let (_bytes, digest) = persisted.canonical_bytes_and_digest()?;
    if &digest != &authority.registry_record_digest {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::CanonicalInvalid,
            "dispatch authority does not name the canonical persisted registry record",
        ));
    }
    let generation_record = load_generation_record(
        db.connection(),
        &persisted.server_id,
        persisted.tool_server_generation,
        persisted.registry_revision,
    )?;
    if generation_record.extension_alias != persisted.extension_alias
        || generation_record.extension_generation != persisted.extension_generation
        || generation_record.worker_epoch != persisted.worker_epoch
        || generation_record.runtime_binding_digest != persisted.runtime_binding_digest
        || generation_record.readiness_digest != persisted.mcp_readiness_digest
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::CanonicalInvalid,
            "tool-server generation projection differs from registry revision",
        ));
    }
    if persisted.config_revision != authority.config_revision
        || persisted.config_digest != authority.config_digest
        || persisted.server_id != authority.server_id
        || persisted.tool_server_generation != authority.tool_server_generation
        || persisted.extension_alias != authority.extension_alias
        || persisted.extension_generation != authority.extension_generation
        || persisted.controller_generation != authority.controller_generation
        || persisted.worker_epoch != authority.worker_epoch
        || persisted.runtime_binding_digest != authority.runtime_binding_digest
        || persisted.mcp_readiness_digest != authority.readiness_digest
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RegistryBindingMismatch,
            "dispatch authority fields differ from the retained registry record",
        ));
    }
    persisted.validate_identity(
        snapshot.mapping.config_revision,
        &snapshot.mapping.config_digest,
        runtime_binding.premises_digest(),
        runtime_binding.binding_digest(),
        readiness.readiness_digest(),
        runtime_binding.service_candidate_digest(),
        runtime_binding.service_candidate_origin(),
        runtime_binding.extension_alias(),
        runtime_binding.controller_generation().value(),
        process_generation.extension_generation().value(),
        &runtime_binding.worker_epoch().to_string(),
        readiness.server_id(),
        readiness.server_digest(),
        readiness.adapter(),
        readiness.protocol_version(),
        readiness.transport_kind(),
        readiness.endpoint_digest(),
        readiness.transport_digest(),
    )?;
    Ok(())
}

/// Validate a ledger binding against a previously issued dispatch authority.
pub fn validate_dispatch_binding(
    authority: &ToolDispatchAuthority,
    config_revision: i64,
    server_id: &str,
    generation: u64,
) -> Result<(), ToolBrokerAuthorityError> {
    if authority.permits_binding(config_revision, server_id, generation) {
        Ok(())
    } else {
        Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::DispatchBindingMismatch,
            "ledger binding is not the exact registry/generation dispatch authority",
        ))
    }
}

fn load_current_snapshot(
    connection: &Connection,
) -> Result<CurrentAuthoritySnapshot, ToolBrokerAuthorityError> {
    load_current_authority(connection)?.ok_or_else(|| {
        ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::HostPremiseMissing,
            "current Host authority pointer is absent",
        )
    })
}

fn ensure_same_snapshot(
    initial: &CurrentAuthoritySnapshot,
    final_snapshot: &CurrentAuthoritySnapshot,
) -> Result<(), ToolBrokerAuthorityError> {
    let initial_identity = (
        initial.mapping.daemon_installation_id.as_str(),
        initial.mapping.instance_id.as_str(),
        initial.mapping.config_revision,
        &initial.mapping.config_digest,
        initial
            .premise
            .as_ref()
            .map(|premise| &premise.premises_digest),
    );
    let final_identity = (
        final_snapshot.mapping.daemon_installation_id.as_str(),
        final_snapshot.mapping.instance_id.as_str(),
        final_snapshot.mapping.config_revision,
        &final_snapshot.mapping.config_digest,
        final_snapshot
            .premise
            .as_ref()
            .map(|premise| &premise.premises_digest),
    );
    if initial_identity != final_identity {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::HostPremiseStale,
            "Host authority changed during registry validation",
        ));
    }
    Ok(())
}

fn validate_current_premises(
    connection: &Connection,
    snapshot: &CurrentAuthoritySnapshot,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
    readiness: &McpTransportReadiness,
) -> Result<(CanonicalJsonValue, ResolvedToolBrokerConfig), ToolBrokerAuthorityError> {
    let premise = snapshot.premise.as_ref().ok_or_else(|| {
        ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::HostPremiseMissing,
            "current Host authority has no activation premise",
        )
    })?;
    if snapshot.mapping.config_revision != runtime_binding.config_revision()
        || snapshot.mapping.config_digest != *runtime_binding.config_digest()
        || premise.premises_digest != *runtime_binding.premises_digest()
        || premise.service_candidate.candidate_digest != *runtime_binding.service_candidate_digest()
        || premise.service_candidate.origin != *runtime_binding.service_candidate_origin()
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RuntimeBindingStale,
            "RuntimeBinding does not match the current Host revision/premise/origin",
        ));
    }
    if process_generation.extension_alias() != runtime_binding.extension_alias()
        || process_generation.controller_generation() != runtime_binding.controller_generation()
        || process_generation.worker_epoch() != runtime_binding.worker_epoch()
        || process_generation.config_revision() != runtime_binding.config_revision()
        || process_generation.config_digest() != runtime_binding.config_digest()
        || process_generation.binding_digest() != runtime_binding.binding_digest()
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::ProcessGenerationStale,
            "ProcessGeneration does not match the accepted RuntimeBinding",
        ));
    }
    if readiness.schema() != MCP_TRANSPORT_READINESS_SCHEMA
        || readiness.daemon_installation_id() != runtime_binding.daemon_installation_id()
        || readiness.instance_id() != runtime_binding.instance_id()
        || readiness.config_revision() != runtime_binding.config_revision()
        || readiness.config_digest() != runtime_binding.config_digest()
        || readiness.premises_digest() != runtime_binding.premises_digest()
        || readiness.controller_generation() != runtime_binding.controller_generation()
        || readiness.worker_epoch() != runtime_binding.worker_epoch().to_string()
        || readiness.extension_alias() != runtime_binding.extension_alias().as_str()
        || readiness.extension_generation() != process_generation.extension_generation()
        || readiness.binding_digest() != runtime_binding.binding_digest()
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::ReadinessStale,
            "MCP readiness is not bound to the current Host/runtime/process identity",
        ));
    }
    validate_runtime_rows(connection, runtime_binding, process_generation)?;

    let runtime_root = as_object(
        &snapshot.mapping.canonical_config.runtime_config,
        "runtime config",
    )?;
    let spec = as_object(
        required_field(runtime_root, "spec", "runtime config")?,
        "runtime spec",
    )?;
    let services = as_object(
        required_field(spec, "services", "runtime spec")?,
        "runtime services",
    )?;
    let config_value = required_field(services, "tool_broker", "runtime services")?.clone();
    let config = admit_registry_config(&config_value)?;
    let server = config.servers().get(readiness.server_id()).ok_or_else(|| {
        ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RegistryBindingMismatch,
            "readiness server is absent from current tool-broker configuration",
        )
    })?;
    let server_digest = canonicalize(&CanonicalJsonValue::Object(server.server_contract.clone()))
        .map_err(|error| {
            ToolBrokerAuthorityError::new(
                ToolBrokerAuthorityCode::CanonicalInvalid,
                error.to_string(),
            )
        })?
        .1;
    if &server_digest != readiness.server_digest()
        || server.adapter != readiness.adapter()
        || server.protocol_version != readiness.protocol_version()
        || server.transport_kind != readiness.transport_kind()
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RegistryBindingMismatch,
            "current tool-broker server contract differs from MCP readiness",
        ));
    }
    Ok((config_value, config))
}

fn validate_runtime_rows(
    connection: &Connection,
    runtime_binding: &RuntimeBinding,
    process_generation: &ProcessGeneration,
) -> Result<(), ToolBrokerAuthorityError> {
    let alias = runtime_binding.extension_alias().to_string();
    let controller = runtime_binding.controller_generation().value() as i64;
    let binding_row: Option<(String, String, i64, String, String, String, String, String)> =
        connection
            .query_row(
                "SELECT daemon_installation_id, instance_id, config_revision, config_digest,
                    premises_digest, service_candidate_digest, worker_epoch, binding_digest
             FROM runtime_binding_authority_records
             WHERE extension_alias = ?1 AND controller_generation = ?2",
                params![alias, controller],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| {
                ToolBrokerAuthorityError::new(
                    ToolBrokerAuthorityCode::RuntimeBindingStale,
                    error.to_string(),
                )
            })?;
    let Some((
        daemon,
        instance,
        revision,
        config_digest,
        premises_digest,
        candidate_digest,
        worker,
        binding_digest,
    )) = binding_row
    else {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RuntimeBindingStale,
            "current runtime binding reservation is absent",
        ));
    };
    if daemon != runtime_binding.daemon_installation_id()
        || instance != runtime_binding.instance_id()
        || revision != runtime_binding.config_revision()
        || config_digest != runtime_binding.config_digest().to_string()
        || premises_digest != runtime_binding.premises_digest().to_string()
        || candidate_digest != runtime_binding.service_candidate_digest().to_string()
        || worker != runtime_binding.worker_epoch().to_string()
        || binding_digest != runtime_binding.binding_digest().to_string()
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RuntimeBindingStale,
            "runtime binding reservation differs from the accepted typed binding",
        ));
    }

    let process_row: Option<(
        String,
        i64,
        String,
        String,
        i64,
        String,
        String,
        String,
        String,
    )> = connection
        .query_row(
            "SELECT worker_epoch, controller_generation, daemon_installation_id, instance_id,
                    config_revision, config_digest, premises_digest, service_candidate_digest,
                    binding_digest
             FROM process_generation_authority_records
             WHERE extension_alias = ?1 AND extension_generation = ?2",
            params![
                alias,
                process_generation.extension_generation().value() as i64
            ],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            ToolBrokerAuthorityError::new(
                ToolBrokerAuthorityCode::ProcessGenerationStale,
                error.to_string(),
            )
        })?;
    let Some((
        worker,
        controller,
        daemon,
        instance,
        revision,
        config_digest,
        premises_digest,
        candidate_digest,
        binding_digest,
    )) = process_row
    else {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::ProcessGenerationStale,
            "current process generation reservation is absent",
        ));
    };
    if worker != process_generation.worker_epoch().to_string()
        || controller != process_generation.controller_generation().value() as i64
        || daemon != process_generation.daemon_installation_id()
        || instance != process_generation.instance_id()
        || revision != process_generation.config_revision()
        || config_digest != process_generation.config_digest().to_string()
        || premises_digest != runtime_binding.premises_digest().to_string()
        || candidate_digest != runtime_binding.service_candidate_digest().to_string()
        || binding_digest != process_generation.binding_digest().to_string()
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::ProcessGenerationStale,
            "process generation reservation differs from the accepted typed identity",
        ));
    }
    Ok(())
}

fn admit_registry_config(
    value: &CanonicalJsonValue,
) -> Result<ResolvedToolBrokerConfig, ToolBrokerAuthorityError> {
    let bytes = canonical_record_bytes(value)?;
    match admit_config(bytes.as_ref()) {
        AdmissionOutcome::Admitted(config) => Ok(config),
        AdmissionOutcome::Rejected(rejection) => Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RegistryConfigInvalid,
            format!("{rejection:?}"),
        )),
    }
}

fn as_object<'a>(
    value: &'a CanonicalJsonValue,
    name: &str,
) -> Result<&'a dolly_canonical_json::CanonicalJsonObject, ToolBrokerAuthorityError> {
    match value {
        CanonicalJsonValue::Object(value) => Ok(value),
        _ => Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RegistryConfigInvalid,
            format!("{name} must be an object"),
        )),
    }
}

fn required_field<'a>(
    object: &'a dolly_canonical_json::CanonicalJsonObject,
    name: &str,
    parent: &str,
) -> Result<&'a CanonicalJsonValue, ToolBrokerAuthorityError> {
    object.get(name).ok_or_else(|| {
        ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::RegistryConfigInvalid,
            format!("{parent} is missing {name}"),
        )
    })
}

fn canonical_record_bytes<T: Serialize>(
    value: &T,
) -> Result<CanonicalBytes, ToolBrokerAuthorityError> {
    canonicalize(value)
        .map(|(bytes, _)| bytes)
        .map_err(|error| {
            ToolBrokerAuthorityError::new(
                ToolBrokerAuthorityCode::CanonicalInvalid,
                error.to_string(),
            )
        })
}

fn parse_digest(value: &str) -> Result<Sha256Digest, ToolBrokerAuthorityError> {
    value.parse().map_err(|_| {
        ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::CanonicalInvalid,
            format!("invalid digest {value}"),
        )
    })
}

fn load_authority_state(
    connection: &Connection,
) -> Result<AuthorityStateRecord, ToolBrokerAuthorityError> {
    let (revision, digest, next, bytes): (Option<i64>, Option<String>, i64, Vec<u8>) = connection.query_row(
        "SELECT current_registry_revision, current_record_digest, next_registry_revision, record_jcs
         FROM tool_registry_authority_state WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let state: AuthorityStateRecord = deserialize_core_json(
        &bytes,
        dolly_canonical_json::ParseLimits::new(64).expect("valid storage limit"),
    )
    .map_err(|error| {
        ToolBrokerAuthorityError::new(ToolBrokerAuthorityCode::CanonicalInvalid, error.to_string())
    })?;
    let expected_revision = revision.map(|value| value as u64);
    let expected_digest = digest.as_deref().map(parse_digest).transpose()?;
    if canonical_record_bytes(&state)?.as_ref() != bytes.as_slice()
        || state.schema != "dolly.tool-broker-authority-state/v1"
        || state.current_registry_revision != expected_revision
        || state.current_record_digest != expected_digest
        || state.next_registry_revision != next as u64
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::CanonicalInvalid,
            "registry authority pointer is not canonical",
        ));
    }
    Ok(state)
}

fn persist_authority_state(
    tx: &rusqlite::Transaction<'_>,
    current_registry_revision: u64,
    current_record_digest: &Sha256Digest,
    next_registry_revision: u64,
) -> Result<(), ToolBrokerAuthorityError> {
    let state = AuthorityStateRecord {
        schema: "dolly.tool-broker-authority-state/v1".into(),
        current_registry_revision: Some(current_registry_revision),
        current_record_digest: Some(current_record_digest.clone()),
        next_registry_revision,
    };
    let bytes = canonical_record_bytes(&state)?;
    tx.execute(
        "UPDATE tool_registry_authority_state
         SET current_registry_revision = ?1, current_record_digest = ?2,
             next_registry_revision = ?3, record_jcs = ?4
         WHERE singleton = 1",
        params![
            current_registry_revision as i64,
            current_record_digest.to_string(),
            next_registry_revision as i64,
            bytes.as_ref(),
        ],
    )?;
    Ok(())
}

fn next_server_generation(
    tx: &rusqlite::Transaction<'_>,
    server_id: &str,
) -> Result<u64, ToolBrokerAuthorityError> {
    let row: Option<(i64, Vec<u8>)> = tx
        .query_row(
            "SELECT next_generation, record_jcs
             FROM tool_server_generation_state WHERE server_id = ?1",
            [server_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((next, bytes)) = row else {
        return Ok(1);
    };
    let state: GenerationStateRecord = deserialize_core_json(
        &bytes,
        dolly_canonical_json::ParseLimits::new(64).expect("valid storage limit"),
    )
    .map_err(|error| {
        ToolBrokerAuthorityError::new(ToolBrokerAuthorityCode::CanonicalInvalid, error.to_string())
    })?;
    if canonical_record_bytes(&state)?.as_ref() != bytes.as_slice()
        || state.schema != "dolly.tool-server-generation-state/v1"
        || state.server_id != server_id
        || state.next_generation != next as u64
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::CanonicalInvalid,
            "tool-server generation pointer is not canonical",
        ));
    }
    Ok(next as u64)
}

fn persist_generation_state(
    tx: &rusqlite::Transaction<'_>,
    server_id: &str,
    generation: u64,
) -> Result<(), ToolBrokerAuthorityError> {
    let next = generation.checked_add(1).ok_or_else(|| {
        ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::DuplicateGeneration,
            "tool-server generation exhausted",
        )
    })?;
    let state = GenerationStateRecord {
        schema: "dolly.tool-server-generation-state/v1".into(),
        server_id: server_id.into(),
        current_generation: Some(generation),
        next_generation: next,
    };
    let bytes = canonical_record_bytes(&state)?;
    tx.execute(
        "INSERT INTO tool_server_generation_state
             (server_id, current_generation, next_generation, record_jcs)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(server_id) DO UPDATE SET
             current_generation = excluded.current_generation,
             next_generation = excluded.next_generation,
             record_jcs = excluded.record_jcs",
        params![server_id, generation as i64, next as i64, bytes.as_ref()],
    )?;
    Ok(())
}

fn load_registry_record(
    connection: &Connection,
    revision: u64,
) -> Result<ToolRegistryRecord, ToolBrokerAuthorityError> {
    let (bytes, digest_text): (Vec<u8>, String) = connection.query_row(
        "SELECT record_jcs, record_digest FROM tool_registry_authority_records WHERE registry_revision = ?1",
        [revision as i64],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let digest = parse_digest(&digest_text)?;
    decode_registry_record(&bytes, &digest)
}

fn load_generation_record(
    connection: &Connection,
    server_id: &str,
    generation: u64,
    registry_revision: u64,
) -> Result<ToolServerGenerationRecord, ToolBrokerAuthorityError> {
    let (bytes, digest_text): (Vec<u8>, String) = connection.query_row(
        "SELECT record_jcs, record_digest
         FROM tool_server_generation_authority_records
         WHERE server_id = ?1 AND tool_server_generation = ?2
           AND registry_revision = ?3",
        params![server_id, generation as i64, registry_revision as i64],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let digest = parse_digest(&digest_text)?;
    let record: ToolServerGenerationRecord = deserialize_core_json(
        &bytes,
        dolly_canonical_json::ParseLimits::new(64).expect("valid storage limit"),
    )
    .map_err(|error| {
        ToolBrokerAuthorityError::new(ToolBrokerAuthorityCode::CanonicalInvalid, error.to_string())
    })?;
    if canonical_record_bytes(&record)?.as_ref() != bytes.as_slice()
        || digest != Sha256Digest::compute(bytes.as_slice())
        || record.schema != TOOL_SERVER_GENERATION_RECORD_SCHEMA
        || record.server_id != server_id
        || record.tool_server_generation != generation
        || record.registry_revision != registry_revision
    {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::CanonicalInvalid,
            "tool-server generation record is not canonical",
        ));
    }
    Ok(record)
}

fn decode_registry_record(
    bytes: &[u8],
    digest: &Sha256Digest,
) -> Result<ToolRegistryRecord, ToolBrokerAuthorityError> {
    let record: ToolRegistryRecord = deserialize_core_json(
        bytes,
        dolly_canonical_json::ParseLimits::new(64).expect("valid storage limit"),
    )
    .map_err(|error| {
        ToolBrokerAuthorityError::new(ToolBrokerAuthorityCode::CanonicalInvalid, error.to_string())
    })?;
    record.verify_canonical(bytes, digest)?;
    if record.schema != TOOL_REGISTRY_RECORD_SCHEMA {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::CanonicalInvalid,
            "unknown Tool Registry record schema",
        ));
    }
    let config_digest =
        Sha256Digest::compute(canonical_record_bytes(&record.tool_broker_config)?.as_ref());
    if config_digest != record.tool_broker_config_digest {
        return Err(ToolBrokerAuthorityError::new(
            ToolBrokerAuthorityCode::CanonicalInvalid,
            "tool-broker configuration digest does not match retained bytes",
        ));
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_authority::{
        ConfigRevisionMapping, HostAuthorityRevision, InstalledComponentOrigin,
        LinuxServiceCandidate, ModuleActivationPremises, ResolvedConfiguration,
        RuntimeAuthorityIdentity, install_host_authority_revision, load_current_authority,
    };
    use crate::linux_host_verification::test_proof_for_authority;
    use crate::mcp_readiness::{
        McpHandshakeObservation, McpTransportBinding, McpTransportProbe, McpTransportProbeError,
        test_prove_current_mcp_transport_readiness,
    };
    use crate::runtime_binding::mint_runtime_binding;
    use dolly_core_domain::{ExtensionId, WorkerEpoch};
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

    fn origin() -> InstalledComponentOrigin {
        let record = json!({"component": "host-runtime", "revision": 1});
        InstalledComponentOrigin {
            schema: "dolly.installed-component-origin/v1".into(),
            kind: "installed_product_component".into(),
            component_id: "org.dolly.host-runtime".into(),
            component_revision: 1,
            component_digest: digest(&record),
        }
    }

    fn tool_broker_config() -> Value {
        let input_schema = json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {"path": {"type": "string"}}
        });
        let output_schema = json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {"text": {"type": "string"}}
        });
        json!({
            "schema": "dolly.tool-broker-config/v1",
            "servers": {
                "fs": {
                    "enabled": true,
                    "adapter": "mcp",
                    "protocol_version": "2025-06-18",
                    "transport": {
                        "kind": "stdio",
                        "package_id": "org.dolly.tools.fs",
                        "package_version": "1.0.0",
                        "package_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
                        "executable": "bin/dolly-fs-tools",
                        "executable_digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
                        "args": ["--stdio"],
                        "secret_bindings": {}
                    },
                    "allowed_modules": ["module-a"],
                    "limits": {
                        "startup_timeout_ms": 10000,
                        "request_timeout_ms": 30000,
                        "max_concurrency": 4,
                        "max_request_bytes": 1048576,
                        "max_response_bytes": 4194304
                    },
                    "tools": {
                        "read-file": {
                            "upstream_name": "read_file",
                            "description": "Read one authorized file.",
                            "input_schema": input_schema,
                            "input_schema_digest": digest(&input_schema).to_string(),
                            "output_schema": output_schema,
                            "output_schema_digest": digest(&output_schema).to_string(),
                            "side_effect_class": "read_only",
                            "idempotency": {"kind": "none"},
                            "requires_confirmation": false,
                            "enabled": true
                        }
                    }
                }
            }
        })
    }

    fn host_revision(config_revision: i64, broker_config: Value) -> HostAuthorityRevision {
        let origin = origin();
        let mut candidate_record = json!({
            "schema": "dolly.linux-service-candidate/v1",
            "origin": serde_json::to_value(&origin).unwrap(),
            "unit_name": "dollyd.service",
            "mode": "user",
            "candidate_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        });
        candidate_record["candidate_digest"] =
            json!(digest(&without(&candidate_record, "candidate_digest")).to_string());
        let candidate: LinuxServiceCandidate = serde_json::from_value(candidate_record).unwrap();
        let runtime_config = CanonicalJsonValue::try_from(json!({
            "spec": {"services": {"tool_broker": broker_config}}
        }))
        .unwrap();
        let config = ResolvedConfiguration {
            runtime_config,
            permission_policy_selections: Vec::new(),
            service_candidate: Some(candidate.clone()),
        };
        let config_digest = canonicalize(&config).unwrap().1;
        let identity = RuntimeAuthorityIdentity {
            daemon_installation_id: "0198ab31-6c44-7e8a-b2bb-000000000001".into(),
            instance_id: "instance-one".into(),
        };
        let premise_without_digest = json!({
            "schema": "dolly.module-activation-premises/v1",
            "daemon_installation_id": identity.daemon_installation_id,
            "instance_id": identity.instance_id,
            "config_revision": config_revision,
            "config_digest": config_digest,
            "permission_policy_definitions": [],
            "permission_policy_backend_bindings": [],
            "service_candidate": serde_json::to_value(&candidate).unwrap()
        });
        let premise = ModuleActivationPremises {
            schema: "dolly.module-activation-premises/v1".into(),
            daemon_installation_id: identity.daemon_installation_id.clone(),
            instance_id: identity.instance_id.clone(),
            config_revision,
            config_digest: config_digest.clone(),
            permission_policy_definitions: Vec::new(),
            permission_policy_backend_bindings: Vec::new(),
            service_candidate: candidate,
            premises_digest: digest(&premise_without_digest),
        };
        HostAuthorityRevision {
            identity,
            mapping: ConfigRevisionMapping {
                schema: "dolly.config-revision-mapping/v1".into(),
                daemon_installation_id: premise.daemon_installation_id.clone(),
                instance_id: premise.instance_id.clone(),
                config_revision,
                config_digest,
                canonical_config: config,
            },
            premise: Some(premise),
        }
    }

    struct Probe {
        controller_generation: ExtensionGeneration,
        worker_epoch: WorkerEpoch,
        extension_alias: ExtensionId,
        extension_generation: ExtensionGeneration,
        binding_digest: Sha256Digest,
    }

    impl McpTransportProbe for Probe {
        fn observe(
            &mut self,
            binding: &McpTransportBinding,
        ) -> Result<McpHandshakeObservation, McpTransportProbeError> {
            Ok(McpHandshakeObservation {
                server_id: Some(binding.server_id().into()),
                adapter: Some(binding.adapter().into()),
                daemon_installation_id: Some(binding.daemon_installation_id().into()),
                instance_id: Some(binding.instance_id().into()),
                controller_generation: Some(self.controller_generation),
                worker_epoch: Some(self.worker_epoch.clone()),
                extension_alias: Some(self.extension_alias.clone()),
                extension_generation: Some(self.extension_generation),
                runtime_binding_digest: Some(self.binding_digest.clone()),
                transport_kind: Some(binding.transport_kind().into()),
                endpoint: Some(binding.endpoint().into()),
                transport_digest: Some(binding.transport_digest().clone()),
                initialize_request_protocol_version: Some(binding.protocol_version().into()),
                initialize_response_protocol_version: Some(binding.protocol_version().into()),
                initialized_notification_sent: true,
                session_ids: vec!["session-one".into()],
            })
        }
    }

    struct Fixture {
        directory: TempDir,
        db: Database,
        runtime_binding: RuntimeBinding,
        process_generation: ProcessGeneration,
        readiness: McpTransportReadiness,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempdir().unwrap();
            let path = directory.path().join("authority.sqlite");
            let mut db = Database::open_for_migration(&path)
                .unwrap()
                .install_host_authority_revision(host_revision(1, tool_broker_config()))
                .unwrap();
            let snapshot = load_current_authority(db.connection()).unwrap().unwrap();
            let proof = test_proof_for_authority(&snapshot);
            let alias: ExtensionId = "org.dolly.tools".parse().unwrap();
            let mut runtime_binding = mint_runtime_binding(&mut db, alias.clone(), proof).unwrap();
            let process_generation = runtime_binding.mint_process_generation(&mut db).unwrap();
            let mut probe = Probe {
                controller_generation: runtime_binding.controller_generation(),
                worker_epoch: runtime_binding.worker_epoch().clone(),
                extension_alias: alias,
                extension_generation: process_generation.extension_generation(),
                binding_digest: runtime_binding.binding_digest().clone(),
            };
            let readiness = test_prove_current_mcp_transport_readiness(
                db.connection(),
                &runtime_binding,
                &process_generation,
                "fs",
                &mut probe,
            )
            .unwrap();
            Self {
                directory,
                db,
                runtime_binding,
                process_generation,
                readiness,
            }
        }

        fn next_identity(&mut self) -> (RuntimeBinding, ProcessGeneration, McpTransportReadiness) {
            let snapshot = load_current_authority(self.db.connection())
                .unwrap()
                .unwrap();
            let proof = test_proof_for_authority(&snapshot);
            let alias: ExtensionId = "org.dolly.tools".parse().unwrap();
            let mut runtime_binding =
                mint_runtime_binding(&mut self.db, alias.clone(), proof).unwrap();
            let process_generation = runtime_binding
                .mint_process_generation(&mut self.db)
                .unwrap();
            let mut probe = Probe {
                controller_generation: runtime_binding.controller_generation(),
                worker_epoch: runtime_binding.worker_epoch().clone(),
                extension_alias: alias,
                extension_generation: process_generation.extension_generation(),
                binding_digest: runtime_binding.binding_digest().clone(),
            };
            let readiness = test_prove_current_mcp_transport_readiness(
                self.db.connection(),
                &runtime_binding,
                &process_generation,
                "fs",
                &mut probe,
            )
            .unwrap();
            (runtime_binding, process_generation, readiness)
        }
    }

    #[test]
    fn successful_publication_survives_fresh_connection() {
        let mut fixture = Fixture::new();
        let registry = publish_tool_registry(
            &mut fixture.db,
            &fixture.runtime_binding,
            &fixture.process_generation,
            &fixture.readiness,
        )
        .unwrap();
        let revision = registry.registry_revision();
        let path = fixture.directory.path().join("authority.sqlite");
        drop(fixture.db);
        let reopened = Database::open(&path).unwrap();
        assert_eq!(
            reopened
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM tool_registry_authority_records",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            reopened
                .connection()
                .query_row(
                    "SELECT current_registry_revision FROM tool_registry_authority_state WHERE singleton = 1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            revision as i64
        );
    }

    #[test]
    fn publication_failure_rolls_back_registry_generation_and_pointer() {
        let mut fixture = Fixture::new();
        create_tool_broker_authority_schema(fixture.db.connection()).unwrap();
        fixture
            .db
            .connection_mut()
            .execute_batch(
                "CREATE TRIGGER fail_tool_registry_pointer
                 BEFORE UPDATE ON tool_registry_authority_state
                 BEGIN SELECT RAISE(ABORT, 'injected pointer failure'); END;",
            )
            .unwrap();
        assert!(
            publish_tool_registry(
                &mut fixture.db,
                &fixture.runtime_binding,
                &fixture.process_generation,
                &fixture.readiness,
            )
            .is_err()
        );
        assert_eq!(
            fixture
                .db
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM tool_registry_authority_records",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            fixture
                .db
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM tool_server_generation_authority_records",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            fixture
                .db
                .connection()
                .query_row(
                    "SELECT current_registry_revision FROM tool_registry_authority_state WHERE singleton = 1",
                    [],
                    |row| row.get::<_, Option<i64>>(0)
                )
                .unwrap(),
            None
        );
        let path = fixture.directory.path().join("authority.sqlite");
        drop(fixture.db);
        let reopened = Database::open(&path).unwrap();
        assert_eq!(
            reopened
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM tool_registry_authority_records",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            reopened
                .connection()
                .query_row(
                    "SELECT current_registry_revision FROM tool_registry_authority_state WHERE singleton = 1",
                    [],
                    |row| row.get::<_, Option<i64>>(0)
                )
                .unwrap(),
            None
        );
    }

    #[test]
    fn revalidation_rejects_authority_after_registry_pointer_cutover() {
        let mut fixture = Fixture::new();
        let registry = publish_tool_registry(
            &mut fixture.db,
            &fixture.runtime_binding,
            &fixture.process_generation,
            &fixture.readiness,
        )
        .unwrap();
        let authority = authorize_tool_dispatch(
            &mut fixture.db,
            &registry,
            &fixture.runtime_binding,
            &fixture.process_generation,
            &fixture.readiness,
        )
        .unwrap();
        let (runtime_binding, process_generation, readiness) = fixture.next_identity();
        let _next_registry = publish_tool_registry(
            &mut fixture.db,
            &runtime_binding,
            &process_generation,
            &readiness,
        )
        .unwrap();
        let error = revalidate_tool_dispatch_authority(
            &mut fixture.db,
            &authority,
            &fixture.runtime_binding,
            &fixture.process_generation,
            &fixture.readiness,
        )
        .unwrap_err();
        assert_eq!(error.code, ToolBrokerAuthorityCode::RegistryNotCurrent);
    }

    #[test]
    fn revalidation_rejects_authority_after_host_premise_cutover() {
        let mut fixture = Fixture::new();
        let registry = publish_tool_registry(
            &mut fixture.db,
            &fixture.runtime_binding,
            &fixture.process_generation,
            &fixture.readiness,
        )
        .unwrap();
        let authority = authorize_tool_dispatch(
            &mut fixture.db,
            &registry,
            &fixture.runtime_binding,
            &fixture.process_generation,
            &fixture.readiness,
        )
        .unwrap();
        let mut changed_config = tool_broker_config();
        changed_config["servers"]["fs"]["transport"]["args"] = json!(["--changed"]);
        install_host_authority_revision(&mut fixture.db, host_revision(2, changed_config)).unwrap();
        let error = revalidate_tool_dispatch_authority(
            &mut fixture.db,
            &authority,
            &fixture.runtime_binding,
            &fixture.process_generation,
            &fixture.readiness,
        )
        .unwrap_err();
        assert!(matches!(
            error.code,
            ToolBrokerAuthorityCode::RuntimeBindingStale | ToolBrokerAuthorityCode::ReadinessStale
        ));
    }
}
