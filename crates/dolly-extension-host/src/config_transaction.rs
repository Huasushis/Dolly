//! Atomic configuration revisions with rollback and exact replay.
//!
//! [`ConfigurationStore`] is a single-writer SQLite boundary. A replacement
//! or rollback writes the immutable revision, current pointer, and idempotency
//! receipt in one immediate transaction. The durable record contains only
//! canonical configuration bytes; credential values must be represented by a
//! `SecretRef` URI and are rejected when supplied as plaintext.

use dolly_canonical_json::{Sha256Digest, canonicalize};
use dolly_core_domain::WorkerEpoch;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};
use thiserror::Error;

use crate::operability::ConfigurationTransactionAuthority;
/// Maximum configuration revision accepted by the safe integer contract.
pub const MAX_CONFIGURATION_REVISION: u64 = 9_007_199_254_740_991;
/// Logical schema version for the configuration transaction ledger.
pub const CONFIGURATION_SCHEMA_VERSION: i64 = 2;

/// Tables owned by the configuration transaction ledger.
pub const CONFIGURATION_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS configuration_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 2)
);
INSERT OR IGNORE INTO configuration_meta (singleton, schema_version) VALUES (1, 2);
CREATE TABLE IF NOT EXISTS configuration_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    current_revision INTEGER NOT NULL CHECK (current_revision BETWEEN 0 AND 9007199254740991),
    current_digest TEXT NOT NULL,
    current_jcs BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS configuration_authority (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    extension_id TEXT NOT NULL,
    module_id TEXT NOT NULL,
    extension_connection_id TEXT NOT NULL,
    host_incarnation_revision INTEGER NOT NULL CHECK (host_incarnation_revision BETWEEN 1 AND 9007199254740991),
    worker_epoch TEXT NOT NULL,
    worker_epoch_fence INTEGER NOT NULL CHECK (worker_epoch_fence BETWEEN 1 AND 9007199254740991),
    daemon_generation INTEGER NOT NULL CHECK (daemon_generation BETWEEN 1 AND 9007199254740991),
    extension_generation INTEGER NOT NULL CHECK (extension_generation BETWEEN 1 AND 9007199254740991),
    base_config_revision INTEGER NOT NULL CHECK (base_config_revision BETWEEN 0 AND 9007199254740991),
    base_config_digest TEXT NOT NULL,
    graph_revision INTEGER NOT NULL CHECK (graph_revision BETWEEN 1 AND 9007199254740991),
    graph_digest TEXT NOT NULL,
    control_channel_id TEXT NOT NULL,
    authority_digest TEXT NOT NULL,
    authority_jcs BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS configuration_revisions (
    revision INTEGER PRIMARY KEY CHECK (revision BETWEEN 1 AND 9007199254740991),
    digest TEXT NOT NULL,
    config_jcs BLOB NOT NULL,
    authority_digest TEXT NOT NULL,
    transaction_id TEXT NOT NULL UNIQUE,
    previous_revision INTEGER NOT NULL CHECK (previous_revision BETWEEN 0 AND 9007199254740991),
    operation TEXT NOT NULL CHECK (operation IN ('replace', 'rollback')),
    rollback_target_revision INTEGER
);
CREATE TABLE IF NOT EXISTS configuration_transactions (
    transaction_id TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL,
    authority_digest TEXT NOT NULL,
    request_jcs BLOB NOT NULL,
    result_revision INTEGER NOT NULL CHECK (result_revision BETWEEN 1 AND 9007199254740991),
    result_digest TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition = 'committed')
);
"#;

const INITIAL_CONFIGURATION: &str = "{}";
const CONFIGURATION_TABLE_COLUMNS: &[(&str, &[&str])] = &[
    ("configuration_meta", &["singleton", "schema_version"]),
    (
        "configuration_state",
        &[
            "singleton",
            "current_revision",
            "current_digest",
            "current_jcs",
        ],
    ),
    (
        "configuration_authority",
        &[
            "singleton",
            "extension_id",
            "module_id",
            "extension_connection_id",
            "host_incarnation_revision",
            "worker_epoch",
            "worker_epoch_fence",
            "daemon_generation",
            "extension_generation",
            "base_config_revision",
            "base_config_digest",
            "graph_revision",
            "graph_digest",
            "control_channel_id",
            "authority_digest",
            "authority_jcs",
        ],
    ),
    (
        "configuration_revisions",
        &[
            "revision",
            "digest",
            "config_jcs",
            "authority_digest",
            "transaction_id",
            "previous_revision",
            "operation",
            "rollback_target_revision",
        ],
    ),
    (
        "configuration_transactions",
        &[
            "transaction_id",
            "request_digest",
            "authority_digest",
            "request_jcs",
            "result_revision",
            "result_digest",
            "disposition",
        ],
    ),
];

/// A requested configuration replacement or rollback.
#[derive(Clone, Debug, PartialEq)]
pub enum ConfigurationChange {
    Replace(Value),
    Rollback { target_revision: u64 },
}

#[derive(Deserialize)]
struct AuthorityRecord {
    extension_id: String,
    module_id: String,
    extension_connection_id: String,
    host_incarnation_revision: i64,
    worker_epoch: String,
    worker_epoch_fence: i64,
    daemon_generation: u64,
    extension_generation: i64,
    base_config_revision: u64,
    base_config_digest: String,
    graph_revision: u64,
    graph_digest: String,
    control_channel_id: String,
}

#[derive(Debug, PartialEq, Eq)]
struct AuthorityFields {
    extension_id: String,
    module_id: String,
    extension_connection_id: String,
    host_incarnation_revision: i64,
    worker_epoch: WorkerEpoch,
    worker_epoch_fence: i64,
    daemon_generation: u64,
    extension_generation: i64,
    base_config_revision: u64,
    base_config_digest: Sha256Digest,
    graph_revision: u64,
    graph_digest: Sha256Digest,
    control_channel_id: String,
    authority_digest: Sha256Digest,
}

fn authority_fields(
    authority: &ConfigurationTransactionAuthority,
) -> Result<AuthorityFields, ConfigurationError> {
    let value: Value = serde_json::from_slice(authority.authority_jcs())
        .map_err(|_| ConfigurationError::InvalidAuthority)?;
    let object = value
        .as_object()
        .ok_or(ConfigurationError::InvalidAuthority)?;
    const AUTHORITY_KEYS: &[&str] = &[
        "extension_id",
        "module_id",
        "extension_connection_id",
        "host_incarnation_revision",
        "worker_epoch",
        "worker_epoch_fence",
        "daemon_generation",
        "extension_generation",
        "base_config_revision",
        "base_config_digest",
        "graph_revision",
        "graph_digest",
        "control_channel_id",
    ];
    if object.len() != AUTHORITY_KEYS.len()
        || AUTHORITY_KEYS.iter().any(|key| !object.contains_key(*key))
    {
        return Err(ConfigurationError::InvalidAuthority);
    }
    let (canonical, digest) =
        canonicalize(&value).map_err(|_| ConfigurationError::InvalidAuthority)?;
    if canonical.as_ref() != authority.authority_jcs() || digest != *authority.authority_digest() {
        return Err(ConfigurationError::InvalidAuthority);
    }
    let record: AuthorityRecord =
        serde_json::from_value(value).map_err(|_| ConfigurationError::InvalidAuthority)?;
    let worker_epoch: WorkerEpoch = record
        .worker_epoch
        .parse()
        .map_err(|_| ConfigurationError::InvalidAuthority)?;
    let base_config_digest: Sha256Digest = record
        .base_config_digest
        .parse()
        .map_err(|_| ConfigurationError::InvalidAuthority)?;
    let graph_digest: Sha256Digest = record
        .graph_digest
        .parse()
        .map_err(|_| ConfigurationError::InvalidAuthority)?;
    if !valid_authority_identifier(&record.extension_id)
        || !valid_authority_identifier(&record.module_id)
        || !valid_authority_identifier(&record.extension_connection_id)
        || !valid_authority_identifier(&record.control_channel_id)
        || record.extension_connection_id != record.control_channel_id
        || record.host_incarnation_revision <= 0
        || record.host_incarnation_revision > MAX_CONFIGURATION_REVISION as i64
        || record.worker_epoch_fence <= 0
        || record.worker_epoch_fence > MAX_CONFIGURATION_REVISION as i64
        || record.daemon_generation == 0
        || record.daemon_generation > MAX_CONFIGURATION_REVISION
        || record.extension_generation <= 0
        || record.extension_generation as u64 > MAX_CONFIGURATION_REVISION
        || record.base_config_revision > MAX_CONFIGURATION_REVISION
        || record.graph_revision == 0
        || record.graph_revision > MAX_CONFIGURATION_REVISION
    {
        return Err(ConfigurationError::InvalidAuthority);
    }
    Ok(AuthorityFields {
        extension_id: record.extension_id,
        module_id: record.module_id,
        extension_connection_id: record.extension_connection_id,
        host_incarnation_revision: record.host_incarnation_revision,
        worker_epoch,
        worker_epoch_fence: record.worker_epoch_fence,
        daemon_generation: record.daemon_generation,
        extension_generation: record.extension_generation,
        base_config_revision: record.base_config_revision,
        base_config_digest,
        graph_revision: record.graph_revision,
        graph_digest,
        control_channel_id: record.control_channel_id,
        authority_digest: authority.authority_digest().clone(),
    })
}

fn next_generation(previous: &AuthorityFields, next: &AuthorityFields) -> bool {
    previous.extension_id == next.extension_id
        && previous.module_id == next.module_id
        && previous.extension_connection_id == next.extension_connection_id
        && previous.host_incarnation_revision == next.host_incarnation_revision
        && previous.worker_epoch == next.worker_epoch
        && previous.worker_epoch_fence == next.worker_epoch_fence
        && previous.control_channel_id == next.control_channel_id
        && next.daemon_generation == previous.daemon_generation.saturating_add(1)
        && next.extension_generation == previous.extension_generation.saturating_add(1)
}

fn valid_authority_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 255 && !value.chars().any(char::is_whitespace)
}

fn verify_current_host_authority(
    connection: &Connection,
    authority: &ConfigurationTransactionAuthority,
) -> Result<AuthorityFields, ConfigurationError> {
    let authority = authority_fields(authority)?;
    let row: Option<(String, Vec<u8>)> = connection
        .query_row(
            "SELECT state_hash, state_jcs FROM core_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(ConfigurationError::Storage)?;
    let Some((state_hash, state_jcs)) = row else {
        return Err(ConfigurationError::AuthorityUnavailable);
    };
    let state: Value =
        serde_json::from_slice(&state_jcs).map_err(|_| ConfigurationError::Corrupt)?;
    let (canonical_state, state_digest) =
        canonicalize(&state).map_err(|_| ConfigurationError::Corrupt)?;
    let stored_digest: Sha256Digest = state_hash
        .parse()
        .map_err(|_| ConfigurationError::Corrupt)?;
    if canonical_state.as_ref() != state_jcs.as_slice()
        || stored_digest.to_canonical_string() != state_hash
        || stored_digest != state_digest
    {
        return Err(ConfigurationError::Corrupt);
    }
    let host_connection = state
        .get("host_connection")
        .and_then(Value::as_object)
        .ok_or(ConfigurationError::AuthorityUnavailable)?;
    let identity = host_connection
        .get("identity")
        .and_then(Value::as_object)
        .ok_or(ConfigurationError::AuthorityUnavailable)?;
    let current_connection = identity
        .get("extension_connection_id")
        .and_then(Value::as_str)
        .ok_or(ConfigurationError::Corrupt)?;
    let current_epoch: WorkerEpoch = identity
        .get("worker_epoch_id")
        .and_then(Value::as_str)
        .ok_or(ConfigurationError::Corrupt)?
        .parse()
        .map_err(|_| ConfigurationError::Corrupt)?;
    let current_fence = identity
        .get("worker_epoch_fence")
        .and_then(Value::as_i64)
        .ok_or(ConfigurationError::Corrupt)?;
    let current_incarnation = host_connection
        .get("incarnation_revision")
        .and_then(Value::as_i64)
        .ok_or(ConfigurationError::Corrupt)?;
    if current_connection != authority.extension_connection_id
        || current_epoch != authority.worker_epoch
        || current_fence != authority.worker_epoch_fence
        || current_incarnation != authority.host_incarnation_revision
        || authority.control_channel_id != authority.extension_connection_id
    {
        return Err(ConfigurationError::AuthorityConflict);
    }
    let grant: Option<(
        String,
        String,
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        String,
        i64,
    )> = connection
        .query_row(
            "SELECT extension_id, module_id, extension_connection_id, worker_epoch,
                        worker_epoch_fence, incarnation_revision, extension_generation,
                        graph_revision, graph_digest, revoked
                 FROM host_capability_grants WHERE extension_id = ?1 AND module_id = ?2",
            params![&authority.extension_id, &authority.module_id],
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
                    row.get(9)?,
                ))
            },
        )
        .optional()
        .map_err(ConfigurationError::Storage)?;
    let Some((
        grant_extension_id,
        grant_module_id,
        grant_connection_id,
        grant_worker_epoch,
        grant_fence,
        grant_incarnation,
        grant_generation,
        grant_graph_revision,
        grant_graph_digest,
        revoked,
    )) = grant
    else {
        return Err(ConfigurationError::AuthorityUnavailable);
    };
    let grant_worker_epoch: WorkerEpoch = grant_worker_epoch
        .parse()
        .map_err(|_| ConfigurationError::Corrupt)?;
    let grant_graph_digest: Sha256Digest = grant_graph_digest
        .parse()
        .map_err(|_| ConfigurationError::Corrupt)?;
    if revoked != 0
        || grant_extension_id != authority.extension_id
        || grant_module_id != authority.module_id
        || grant_connection_id != authority.extension_connection_id
        || grant_worker_epoch != authority.worker_epoch
        || grant_fence != authority.worker_epoch_fence
        || grant_incarnation != authority.host_incarnation_revision
        || grant_generation != authority.extension_generation
        || grant_graph_revision != authority.graph_revision as i64
        || grant_graph_digest != authority.graph_digest
    {
        return Err(ConfigurationError::AuthorityConflict);
    }
    Ok(authority)
}

fn verify_current_configuration_base(
    transaction: &Transaction<'_>,
    authority: &AuthorityFields,
) -> Result<(), ConfigurationError> {
    let current = load_state(transaction)?;
    if current.revision != authority.base_config_revision
        || current.digest != authority.base_config_digest
    {
        return Err(ConfigurationError::AuthorityConflict);
    }
    Ok(())
}

/// Immutable configuration bytes and their canonical revision digest.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigurationSnapshot {
    revision: u64,
    digest: Sha256Digest,
    configuration: Value,
}

/// A caller-supplied transaction identity and optimistic revision fence.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigurationTransaction {
    transaction_id: String,
    expected_revision: Option<u64>,
    change: ConfigurationChange,
}

impl ConfigurationTransaction {
    /// Create a replacement transaction.
    pub fn new(
        transaction_id: impl Into<String>,
        expected_revision: Option<u64>,
        configuration: Value,
    ) -> Result<Self, ConfigurationError> {
        Self::replace(transaction_id, expected_revision, configuration)
    }

    pub fn replace(
        transaction_id: impl Into<String>,
        expected_revision: Option<u64>,
        configuration: Value,
    ) -> Result<Self, ConfigurationError> {
        let transaction = Self {
            transaction_id: transaction_id.into(),
            expected_revision,
            change: ConfigurationChange::Replace(configuration),
        };
        transaction.validate()?;
        Ok(transaction)
    }

    pub fn rollback(
        transaction_id: impl Into<String>,
        expected_revision: Option<u64>,
        target_revision: u64,
    ) -> Result<Self, ConfigurationError> {
        let transaction = Self {
            transaction_id: transaction_id.into(),
            expected_revision,
            change: ConfigurationChange::Rollback { target_revision },
        };
        transaction.validate()?;
        Ok(transaction)
    }

    pub fn transaction_id(&self) -> &str {
        &self.transaction_id
    }

    pub fn expected_revision(&self) -> Option<u64> {
        self.expected_revision
    }

    pub fn change(&self) -> &ConfigurationChange {
        &self.change
    }

    fn validate(&self) -> Result<(), ConfigurationError> {
        if self.transaction_id.is_empty() || self.transaction_id.len() > 255 {
            return Err(ConfigurationError::InvalidTransaction);
        }
        if !self
            .transaction_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(ConfigurationError::InvalidTransaction);
        }
        if self
            .expected_revision
            .is_some_and(|revision| revision > MAX_CONFIGURATION_REVISION)
        {
            return Err(ConfigurationError::InvalidTransaction);
        }
        match &self.change {
            ConfigurationChange::Replace(configuration) => {
                reject_plaintext_secrets(configuration)?;
                canonicalize(configuration)
                    .map_err(|_| ConfigurationError::InvalidConfiguration)?;
            }
            ConfigurationChange::Rollback { target_revision } => {
                if *target_revision > MAX_CONFIGURATION_REVISION {
                    return Err(ConfigurationError::InvalidTransaction);
                }
            }
        }
        Ok(())
    }
}

/// The result of one accepted transaction. Exact replay returns the same
/// revision and digest without allocating a second revision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigurationDisposition {
    Committed,
    Replayed,
}

/// Immutable receipt for a committed or replayed configuration transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigurationReceipt {
    transaction_id: String,
    revision: u64,
    digest: Sha256Digest,
    request_digest: Sha256Digest,
    authority_digest: Sha256Digest,
    disposition: ConfigurationDisposition,
}

impl ConfigurationReceipt {
    pub fn transaction_id(&self) -> &str {
        &self.transaction_id
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn digest(&self) -> &Sha256Digest {
        &self.digest
    }

    pub fn request_digest(&self) -> &Sha256Digest {
        &self.request_digest
    }

    pub fn authority_digest(&self) -> &Sha256Digest {
        &self.authority_digest
    }

    pub fn disposition(&self) -> ConfigurationDisposition {
        self.disposition
    }
}
impl ConfigurationSnapshot {
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn digest(&self) -> &Sha256Digest {
        &self.digest
    }

    pub fn configuration(&self) -> &Value {
        &self.configuration
    }
}

/// Fail-closed configuration ledger errors. Configuration values are never
/// included in an error message.
#[derive(Debug, Error)]
pub enum ConfigurationError {
    #[error("configuration storage operation failed")]
    Storage(#[source] rusqlite::Error),
    #[error("configuration ledger has an unsupported schema")]
    Schema,
    #[error("configuration ledger is corrupt")]
    Corrupt,
    #[error("configuration transaction is invalid")]
    InvalidTransaction,
    #[error("configuration authority is invalid")]
    InvalidAuthority,
    #[error("configuration contains plaintext secret material")]
    PlaintextSecret,
    #[error("configuration value is invalid")]
    InvalidConfiguration,
    #[error("configuration revision conflict")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("configuration authority is unavailable")]
    AuthorityUnavailable,
    #[error("configuration authority is unavailable or stale")]
    AuthorityConflict,
    #[error("configuration rollback target is incompatible with current authority")]
    RollbackAuthorityConflict,
    #[error("configuration transaction replay identity conflicts")]
    IdempotencyConflict,
    #[error("configuration rollback target is unavailable")]
    RollbackTargetUnavailable,
    #[error("configuration revision sequence is exhausted")]
    SequenceExhausted,
    #[error("configuration transaction receipt is unavailable")]
    TransactionUnavailable,
}

/// The production configuration store over one verified SQLite writer.
pub struct ConfigurationStore<'connection> {
    connection: &'connection mut Connection,
}

impl<'connection> ConfigurationStore<'connection> {
    pub fn new(connection: &'connection mut Connection) -> Result<Self, ConfigurationError> {
        initialize_configuration_schema(connection)?;
        Ok(Self { connection })
    }

    pub fn current(&self) -> Result<ConfigurationSnapshot, ConfigurationError> {
        load_state(self.connection)
    }

    pub(crate) fn bind_authority(
        &mut self,
        authority: &ConfigurationTransactionAuthority,
    ) -> Result<(), ConfigurationError> {
        authority.check_live()?;
        let mut current_revision = authority.write_current_configuration_revision()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(ConfigurationError::Storage)?;
        let authority_fields = verify_current_host_authority(&transaction, authority)?;
        verify_current_configuration_base(&transaction, &authority_fields)?;
        if let Some(current) = load_authority_digest(&transaction)? {
            if current != authority_fields.authority_digest {
                return Err(ConfigurationError::AuthorityConflict);
            }
            transaction.commit().map_err(ConfigurationError::Storage)?;
            *current_revision = Some(authority_fields.base_config_revision);
            return Ok(());
        }
        write_authority(&transaction, authority, &authority_fields)?;
        transaction.commit().map_err(ConfigurationError::Storage)?;
        *current_revision = Some(authority_fields.base_config_revision);
        Ok(())
    }

    /// Replace the current authority only with the exact next generation.
    pub(crate) fn rotate_authority(
        &mut self,
        previous: &ConfigurationTransactionAuthority,
        next: &ConfigurationTransactionAuthority,
    ) -> Result<(), ConfigurationError> {
        next.check_live()?;
        let previous_fields = authority_fields(previous)?;
        let next_fields = authority_fields(next)?;
        if !next_generation(&previous_fields, &next_fields) {
            return Err(ConfigurationError::AuthorityConflict);
        }
        let mut current_revision = next.write_current_configuration_revision()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(ConfigurationError::Storage)?;
        let current_next = verify_current_host_authority(&transaction, next)?;
        verify_current_configuration_base(&transaction, &current_next)?;
        let current =
            load_authority_digest(&transaction)?.ok_or(ConfigurationError::AuthorityUnavailable)?;
        if current != previous_fields.authority_digest {
            return Err(ConfigurationError::AuthorityConflict);
        }
        write_authority(&transaction, next, &current_next)?;
        transaction.commit().map_err(ConfigurationError::Storage)?;
        *current_revision = Some(current_next.base_config_revision);
        Ok(())
    }
    /// Atomically apply a replacement or rollback under the exact authority.
    pub fn apply(
        &mut self,
        authority: &ConfigurationTransactionAuthority,
        request: &ConfigurationTransaction,
    ) -> Result<ConfigurationReceipt, ConfigurationError> {
        request.validate()?;
        authority.check_live()?;
        let (request_jcs, request_digest_value) = request_identity(request, authority)?;
        let request_digest = request_digest_value.to_canonical_string();
        let mut current_revision = authority.write_current_configuration_revision()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(ConfigurationError::Storage)?;
        verify_current_host_authority(&transaction, authority)?;

        let current_authority =
            load_authority_digest(&transaction)?.ok_or(ConfigurationError::AuthorityUnavailable)?;
        if current_authority != *authority.authority_digest() {
            return Err(ConfigurationError::AuthorityConflict);
        }

        let current = load_state(&transaction)?;
        if let Some(receipt) = load_transaction(&transaction, request.transaction_id())? {
            if receipt.request_digest != request_digest {
                return Err(ConfigurationError::IdempotencyConflict);
            }
            let authority_digest: Sha256Digest = receipt
                .authority_digest
                .parse()
                .map_err(|_| ConfigurationError::Corrupt)?;
            transaction.commit().map_err(ConfigurationError::Storage)?;
            *current_revision = Some(current.revision);
            return Ok(ConfigurationReceipt {
                transaction_id: request.transaction_id().to_owned(),
                revision: receipt.revision,
                digest: receipt.result_digest,
                request_digest: request_digest_value,
                authority_digest,
                disposition: ConfigurationDisposition::Replayed,
            });
        }

        if let Some(expected) = request.expected_revision() {
            if expected != current.revision {
                return Err(ConfigurationError::RevisionConflict {
                    expected,
                    actual: current.revision,
                });
            }
        }

        let (configuration, operation, rollback_target_revision) = match request.change() {
            ConfigurationChange::Replace(configuration) => (configuration.clone(), "replace", None),
            ConfigurationChange::Rollback { target_revision } => {
                let (configuration, target_authority) =
                    load_revision_configuration(&transaction, *target_revision)?;
                if target_authority.as_ref() != Some(authority.authority_digest()) {
                    return Err(ConfigurationError::RollbackAuthorityConflict);
                }
                (configuration, "rollback", Some(*target_revision))
            }
        };
        reject_plaintext_secrets(&configuration)?;
        let (canonical_bytes, digest) = canonical_configuration(&configuration)?;
        let next_revision = current
            .revision
            .checked_add(1)
            .ok_or(ConfigurationError::SequenceExhausted)?;
        if next_revision == 0 || next_revision > MAX_CONFIGURATION_REVISION {
            return Err(ConfigurationError::SequenceExhausted);
        }
        let digest_text = digest.to_canonical_string();
        transaction
            .execute(
                "INSERT INTO configuration_revisions
                 (revision, digest, config_jcs, authority_digest, transaction_id, previous_revision,
                  operation, rollback_target_revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    next_revision as i64,
                    digest_text,
                    canonical_bytes,
                    authority.authority_digest().to_canonical_string(),
                    request.transaction_id(),
                    current.revision as i64,
                    operation,
                    rollback_target_revision.map(|revision| revision as i64),
                ],
            )
            .map_err(ConfigurationError::Storage)?;
        transaction
            .execute(
                "UPDATE configuration_state
                 SET current_revision = ?1, current_digest = ?2, current_jcs = ?3
                 WHERE singleton = 1",
                params![
                    next_revision as i64,
                    digest.to_canonical_string(),
                    canonical_bytes
                ],
            )
            .map_err(ConfigurationError::Storage)?;
        transaction
            .execute(
                "INSERT INTO configuration_transactions
                 (transaction_id, request_digest, authority_digest, request_jcs,
                  result_revision, result_digest, disposition)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'committed')",
                params![
                    request.transaction_id(),
                    request_digest,
                    authority.authority_digest().to_canonical_string(),
                    request_jcs,
                    next_revision as i64,
                    digest.to_canonical_string(),
                ],
            )
            .map_err(ConfigurationError::Storage)?;
        transaction.commit().map_err(ConfigurationError::Storage)?;
        *current_revision = Some(next_revision);
        Ok(ConfigurationReceipt {
            transaction_id: request.transaction_id().to_owned(),
            revision: next_revision,
            digest,
            request_digest: request_digest_value,
            authority_digest: authority.authority_digest().clone(),
            disposition: ConfigurationDisposition::Committed,
        })
    }

    /// Return the durable receipt for an already accepted transaction.
    pub fn replay(&self, transaction_id: &str) -> Result<ConfigurationReceipt, ConfigurationError> {
        validate_transaction_id(transaction_id)?;
        let receipt = load_transaction(self.connection, transaction_id)?
            .ok_or(ConfigurationError::TransactionUnavailable)?;
        Ok(ConfigurationReceipt {
            transaction_id: transaction_id.to_owned(),
            revision: receipt.revision,
            digest: receipt.result_digest,
            request_digest: receipt
                .request_digest
                .parse()
                .map_err(|_| ConfigurationError::Corrupt)?,
            authority_digest: receipt
                .authority_digest
                .parse()
                .map_err(|_| ConfigurationError::Corrupt)?,
            disposition: ConfigurationDisposition::Replayed,
        })
    }

    /// Load an immutable historical revision, including revision zero's empty
    /// configuration.
    pub fn revision(&self, revision: u64) -> Result<ConfigurationSnapshot, ConfigurationError> {
        if revision > MAX_CONFIGURATION_REVISION {
            return Err(ConfigurationError::RollbackTargetUnavailable);
        }
        if revision == 0 {
            return initial_snapshot();
        }
        let bytes: Vec<u8> = self
            .connection
            .query_row(
                "SELECT config_jcs FROM configuration_revisions WHERE revision = ?1",
                [revision as i64],
                |row| row.get(0),
            )
            .optional()
            .map_err(ConfigurationError::Storage)?
            .ok_or(ConfigurationError::RollbackTargetUnavailable)?;
        decode_snapshot(revision, &bytes)
    }
}

fn initialize_configuration_schema(connection: &Connection) -> Result<(), ConfigurationError> {
    connection
        .execute_batch(CONFIGURATION_SCHEMA_SQL)
        .map_err(ConfigurationError::Storage)?;
    for (table, columns) in CONFIGURATION_TABLE_COLUMNS {
        verify_table_columns(connection, table, columns)?;
    }
    let version: Option<i64> = connection
        .query_row(
            "SELECT schema_version FROM configuration_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(ConfigurationError::Storage)?;
    match version {
        Some(CONFIGURATION_SCHEMA_VERSION) => {}
        Some(_) | None => return Err(ConfigurationError::Schema),
    }
    let state_exists: Option<i64> = connection
        .query_row(
            "SELECT singleton FROM configuration_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(ConfigurationError::Storage)?;
    if state_exists.is_none() {
        let (_, digest) =
            canonicalize(&json!({})).map_err(|_| ConfigurationError::InvalidConfiguration)?;
        connection
            .execute(
                "INSERT INTO configuration_state
                 (singleton, current_revision, current_digest, current_jcs)
                 VALUES (1, 0, ?1, ?2)",
                params![
                    digest.to_canonical_string(),
                    INITIAL_CONFIGURATION.as_bytes()
                ],
            )
            .map_err(ConfigurationError::Storage)?;
    }
    let _ = load_state(connection)?;
    Ok(())
}

fn verify_table_columns(
    connection: &Connection,
    table: &str,
    expected: &[&str],
) -> Result<(), ConfigurationError> {
    let object_type: Option<String> = connection
        .query_row(
            "SELECT type FROM sqlite_master WHERE name = ?1",
            [table],
            |row| row.get(0),
        )
        .optional()
        .map_err(ConfigurationError::Storage)?;
    if object_type.as_deref() != Some("table") {
        return Err(ConfigurationError::Schema);
    }
    let actual = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(ConfigurationError::Storage)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(ConfigurationError::Storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ConfigurationError::Storage)?;
    if actual != expected {
        return Err(ConfigurationError::Schema);
    }
    Ok(())
}

fn initial_snapshot() -> Result<ConfigurationSnapshot, ConfigurationError> {
    let configuration = json!({});
    let (_, digest) =
        canonicalize(&configuration).map_err(|_| ConfigurationError::InvalidConfiguration)?;
    Ok(ConfigurationSnapshot {
        revision: 0,
        digest,
        configuration,
    })
}

fn load_state(connection: &Connection) -> Result<ConfigurationSnapshot, ConfigurationError> {
    let (revision, digest_text, bytes): (i64, String, Vec<u8>) = connection
        .query_row(
            "SELECT current_revision, current_digest, current_jcs
             FROM configuration_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(ConfigurationError::Storage)?;
    if !(0..=MAX_CONFIGURATION_REVISION as i64).contains(&revision) {
        return Err(ConfigurationError::Corrupt);
    }
    let expected_digest: Sha256Digest = digest_text
        .parse()
        .map_err(|_| ConfigurationError::Corrupt)?;
    let snapshot = decode_snapshot(revision as u64, &bytes)?;
    if snapshot.digest != expected_digest {
        return Err(ConfigurationError::Corrupt);
    }
    Ok(snapshot)
}

fn load_authority_digest(
    connection: &Connection,
) -> Result<Option<Sha256Digest>, ConfigurationError> {
    let authority_digest: Option<String> = connection
        .query_row(
            "SELECT authority_digest FROM configuration_authority WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(ConfigurationError::Storage)?;
    authority_digest
        .map(|value| {
            let digest: Sha256Digest = value.parse().map_err(|_| ConfigurationError::Corrupt)?;
            if digest.to_canonical_string() != value {
                return Err(ConfigurationError::Corrupt);
            }
            Ok(digest)
        })
        .transpose()
}

fn write_authority(
    transaction: &Transaction<'_>,
    authority: &ConfigurationTransactionAuthority,
    fields: &AuthorityFields,
) -> Result<(), ConfigurationError> {
    transaction
        .execute(
            "INSERT INTO configuration_authority
             (singleton, extension_id, module_id, extension_connection_id,
              host_incarnation_revision, worker_epoch, worker_epoch_fence,
              daemon_generation, extension_generation, base_config_revision,
              base_config_digest, graph_revision, graph_digest, control_channel_id,
              authority_digest, authority_jcs)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(singleton) DO UPDATE SET
              extension_id = excluded.extension_id,
              module_id = excluded.module_id,
              extension_connection_id = excluded.extension_connection_id,
              host_incarnation_revision = excluded.host_incarnation_revision,
              worker_epoch = excluded.worker_epoch,
              worker_epoch_fence = excluded.worker_epoch_fence,
              daemon_generation = excluded.daemon_generation,
              extension_generation = excluded.extension_generation,
              base_config_revision = excluded.base_config_revision,
              base_config_digest = excluded.base_config_digest,
              graph_revision = excluded.graph_revision,
              graph_digest = excluded.graph_digest,
              control_channel_id = excluded.control_channel_id,
              authority_digest = excluded.authority_digest,
              authority_jcs = excluded.authority_jcs",
            params![
                &fields.extension_id,
                &fields.module_id,
                &fields.extension_connection_id,
                fields.host_incarnation_revision,
                fields.worker_epoch.to_string(),
                fields.worker_epoch_fence,
                fields.daemon_generation as i64,
                fields.extension_generation,
                fields.base_config_revision as i64,
                fields.base_config_digest.to_canonical_string(),
                fields.graph_revision as i64,
                fields.graph_digest.to_canonical_string(),
                &fields.control_channel_id,
                fields.authority_digest.to_canonical_string(),
                authority.authority_jcs(),
            ],
        )
        .map_err(ConfigurationError::Storage)?;
    Ok(())
}

fn load_revision_configuration(
    transaction: &Transaction<'_>,
    revision: u64,
) -> Result<(Value, Option<Sha256Digest>), ConfigurationError> {
    if revision == 0 {
        return Ok((json!({}), None));
    }
    if revision > MAX_CONFIGURATION_REVISION {
        return Err(ConfigurationError::RollbackTargetUnavailable);
    }
    let row: Option<(Vec<u8>, String, String)> = transaction
        .query_row(
            "SELECT config_jcs, digest, authority_digest
             FROM configuration_revisions WHERE revision = ?1",
            [revision as i64],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(ConfigurationError::Storage)?;
    let Some((bytes, digest_text, authority_text)) = row else {
        return Err(ConfigurationError::RollbackTargetUnavailable);
    };
    let expected_digest: Sha256Digest = digest_text
        .parse()
        .map_err(|_| ConfigurationError::Corrupt)?;
    if expected_digest.to_canonical_string() != digest_text {
        return Err(ConfigurationError::Corrupt);
    }
    let authority_digest: Sha256Digest = authority_text
        .parse()
        .map_err(|_| ConfigurationError::Corrupt)?;
    if authority_digest.to_canonical_string() != authority_text {
        return Err(ConfigurationError::Corrupt);
    }
    let snapshot = decode_snapshot(revision, &bytes)?;
    if snapshot.digest != expected_digest {
        return Err(ConfigurationError::Corrupt);
    }
    Ok((snapshot.configuration, Some(authority_digest)))
}

fn decode_snapshot(
    revision: u64,
    bytes: &[u8],
) -> Result<ConfigurationSnapshot, ConfigurationError> {
    let configuration: Value =
        serde_json::from_slice(bytes).map_err(|_| ConfigurationError::Corrupt)?;
    reject_plaintext_secrets(&configuration).map_err(|_| ConfigurationError::Corrupt)?;
    let (canonical_bytes, digest) = canonical_configuration(&configuration)?;
    if canonical_bytes.as_slice() != bytes {
        return Err(ConfigurationError::Corrupt);
    }
    Ok(ConfigurationSnapshot {
        revision,
        digest,
        configuration,
    })
}

fn canonical_configuration(
    configuration: &Value,
) -> Result<(Vec<u8>, Sha256Digest), ConfigurationError> {
    let (bytes, digest) =
        canonicalize(configuration).map_err(|_| ConfigurationError::InvalidConfiguration)?;
    Ok((bytes.into_vec(), digest))
}
fn request_identity(
    request: &ConfigurationTransaction,
    authority: &ConfigurationTransactionAuthority,
) -> Result<(Vec<u8>, Sha256Digest), ConfigurationError> {
    let change = match request.change() {
        ConfigurationChange::Replace(configuration) => json!({
            "operation": "replace",
            "configuration": configuration,
        }),
        ConfigurationChange::Rollback { target_revision } => json!({
            "operation": "rollback",
            "target_revision": target_revision,
        }),
    };
    let authority_value: Value = serde_json::from_slice(authority.authority_jcs())
        .map_err(|_| ConfigurationError::Corrupt)?;
    let request_value = json!({
        "transaction_id": request.transaction_id(),
        "expected_revision": request.expected_revision(),
        "change": change,
        "authority": authority_value,
    });
    let (bytes, digest) =
        canonicalize(&request_value).map_err(|_| ConfigurationError::InvalidTransaction)?;
    Ok((bytes.into_vec(), digest))
}

struct StoredTransaction {
    request_digest: String,
    authority_digest: String,
    revision: u64,
    result_digest: Sha256Digest,
}

fn load_transaction(
    connection: &Connection,
    transaction_id: &str,
) -> Result<Option<StoredTransaction>, ConfigurationError> {
    let row: Option<(String, String, Vec<u8>, i64, String)> = connection
        .query_row(
            "SELECT request_digest, authority_digest, request_jcs,
                    result_revision, result_digest
             FROM configuration_transactions WHERE transaction_id = ?1",
            [transaction_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(ConfigurationError::Storage)?;
    let Some((request_digest, authority_digest, request_jcs, revision, result_digest_text)) = row
    else {
        return Ok(None);
    };
    if !(1..=MAX_CONFIGURATION_REVISION as i64).contains(&revision) {
        return Err(ConfigurationError::Corrupt);
    }
    let request_digest_value: Sha256Digest = request_digest
        .parse()
        .map_err(|_| ConfigurationError::Corrupt)?;
    if request_digest_value.to_canonical_string() != request_digest {
        return Err(ConfigurationError::Corrupt);
    }
    let authority_digest_value: Sha256Digest = authority_digest
        .parse()
        .map_err(|_| ConfigurationError::Corrupt)?;
    if authority_digest_value.to_canonical_string() != authority_digest {
        return Err(ConfigurationError::Corrupt);
    }
    let request_value: Value =
        serde_json::from_slice(&request_jcs).map_err(|_| ConfigurationError::Corrupt)?;
    let (canonical_request, computed_request_digest) =
        canonicalize(&request_value).map_err(|_| ConfigurationError::Corrupt)?;
    if canonical_request.as_ref() != request_jcs.as_slice()
        || computed_request_digest != request_digest_value
    {
        return Err(ConfigurationError::Corrupt);
    }
    let result_digest: Sha256Digest = result_digest_text
        .parse()
        .map_err(|_| ConfigurationError::Corrupt)?;
    if result_digest.to_canonical_string() != result_digest_text {
        return Err(ConfigurationError::Corrupt);
    }
    Ok(Some(StoredTransaction {
        request_digest,
        authority_digest,
        revision: revision as u64,
        result_digest,
    }))
}

fn validate_transaction_id(transaction_id: &str) -> Result<(), ConfigurationError> {
    if transaction_id.is_empty()
        || transaction_id.len() > 255
        || !transaction_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(ConfigurationError::InvalidTransaction);
    }
    Ok(())
}

fn reject_plaintext_secrets(configuration: &Value) -> Result<(), ConfigurationError> {
    fn walk(value: &Value) -> Result<(), ConfigurationError> {
        match value {
            Value::Object(object) => {
                for (key, value) in object {
                    if key == "secret_ref" {
                        if !matches!(value, Value::String(reference) if valid_secret_ref(reference))
                        {
                            return Err(ConfigurationError::PlaintextSecret);
                        }
                        continue;
                    }
                    if sensitive_key(key) && !is_secret_reference(value) {
                        return Err(ConfigurationError::PlaintextSecret);
                    }
                    walk(value)?;
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item)?;
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
        Ok(())
    }
    walk(configuration)
}

fn is_secret_reference(value: &Value) -> bool {
    matches!(value, Value::String(reference) if valid_secret_ref(reference))
        || matches!(
            value,
            Value::Object(object)
                if object.len() == 1
                    && object.get("secret_ref").is_some_and(|reference| {
                        matches!(reference, Value::String(value) if valid_secret_ref(value))
                    })
        )
}

fn sensitive_key(key: &str) -> bool {
    static SENSITIVE_KEYS: &[&str] = &[
        "secret",
        "password",
        "token",
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "client_secret",
        "private_key",
        "authorization",
        "credential",
    ];
    let normalized = key.to_ascii_lowercase();
    SENSITIVE_KEYS.contains(&normalized.as_str())
}

fn valid_secret_ref(reference: &str) -> bool {
    if !(10..=255).contains(&reference.len()) || !reference.starts_with("secret://") {
        return false;
    }
    let name = &reference["secret://".len()..];
    !name.is_empty()
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.contains("//")
        && !name.contains("..")
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'/' | b'_' | b'-' | b'.')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dolly_core_reducer::{
        CoreCommand, EnvironmentInput, InstallConfigCommand, TransitionOutcome,
    };
    use rusqlite::{Connection, types::Value as SqlValue};

    use dolly_storage::{HostConnectionAuthority, SqliteCoreStore};

    fn host_authority(connection: &mut Connection) -> HostConnectionAuthority {
        let mut core = SqliteCoreStore::new(connection).expect("core schema");
        let configuration = json!({
            "extension_connection_id": "connection-one",
            "worker_epoch": "018f0f00-0000-7000-8000-000000000001",
            "worker_epoch_fence": 1
        });
        let (_, digest) = canonicalize(&configuration).expect("configuration digest");
        let command = CoreCommand::InstallConfig(InstallConfigCommand {
            command_id: "config-authority-test".into(),
            revision: 1,
            effective_config: configuration,
            digest: digest.to_canonical_string(),
        });
        assert_eq!(
            core.transact(&command, &EnvironmentInput::default())
                .expect("configuration")
                .outcome,
            TransitionOutcome::Committed
        );
        let host = core.bootstrap_host_connection().expect("Host authority");
        let descriptor_digest = Sha256Digest::compute(b"descriptor").to_canonical_string();
        let manifest_digest = Sha256Digest::compute(b"manifest").to_canonical_string();
        let graph_digest = Sha256Digest::compute(b"graph-v1").to_canonical_string();
        core.install_host_capability_grant(
            &host,
            "org.example.extension",
            "module-one",
            1,
            1,
            &descriptor_digest,
            1,
            &manifest_digest,
            1,
            &graph_digest,
            &["host.block.get"],
        )
        .expect("Host capability grant");
        host
    }

    fn new_store<'connection>(
        connection: &'connection mut Connection,
    ) -> ConfigurationStore<'connection> {
        ConfigurationStore::new(connection).expect("schema")
    }

    fn authority(
        daemon_generation: u64,
        extension_generation: i64,
        base_revision: u64,
        base_digest: Sha256Digest,
        graph_revision: u64,
        graph_digest: Sha256Digest,
    ) -> ConfigurationTransactionAuthority {
        ConfigurationTransactionAuthority::from_test_parts(
            "org.example.extension",
            "module-one",
            "connection-one",
            1,
            "018f0f00-0000-7000-8000-000000000001"
                .parse()
                .expect("WorkerEpoch"),
            1,
            daemon_generation,
            extension_generation,
            base_revision,
            base_digest,
            graph_revision,
            graph_digest,
            "connection-one",
        )
        .expect("authority")
    }

    fn authority_for(
        store: &ConfigurationStore<'_>,
        daemon_generation: u64,
        extension_generation: i64,
    ) -> ConfigurationTransactionAuthority {
        let base = store.current().expect("current");
        authority(
            daemon_generation,
            extension_generation,
            base.revision(),
            base.digest().clone(),
            1,
            Sha256Digest::compute(b"graph-v1"),
        )
    }

    fn database_rows(store: &ConfigurationStore<'_>) -> Vec<(String, Vec<Vec<SqlValue>>)> {
        [
            "configuration_meta",
            "configuration_state",
            "configuration_authority",
            "configuration_revisions",
            "configuration_transactions",
        ]
        .into_iter()
        .map(|table| {
            let mut statement = store
                .connection
                .prepare(&format!("SELECT * FROM {table}"))
                .expect("query");
            let column_count = statement.column_count();
            let mut rows = statement.query([]).expect("rows");
            let mut values = Vec::new();
            while let Some(row) = rows.next().expect("row") {
                values.push(
                    (0..column_count)
                        .map(|column| row.get(column).expect("value"))
                        .collect(),
                );
            }
            (table.to_owned(), values)
        })
        .collect()
    }

    #[test]
    fn replacement_is_atomic_and_exact_replay_is_idempotent() {
        let mut connection = Connection::open_in_memory().expect("database");
        let _host = host_authority(&mut connection);
        let mut store = new_store(&mut connection);
        let authority = authority_for(&store, 1, 1);
        store.bind_authority(&authority).expect("bind");
        let request = ConfigurationTransaction::new(
            "tx-1",
            Some(0),
            json!({"endpoint": "https://example.test", "credential": "secret://vault/api"}),
        )
        .expect("request");
        let committed = store.apply(&authority, &request).expect("commit");
        assert_eq!(committed.disposition(), ConfigurationDisposition::Committed);
        assert_eq!(committed.revision(), 1);
        let replayed = store.apply(&authority, &request).expect("replay");
        assert_eq!(replayed.transaction_id(), committed.transaction_id());
        assert_eq!(replayed.revision(), committed.revision());
        assert_eq!(replayed.digest(), committed.digest());
        assert_eq!(replayed.request_digest(), committed.request_digest());
        assert_eq!(replayed.authority_digest(), committed.authority_digest());
        assert_eq!(replayed.disposition(), ConfigurationDisposition::Replayed);
        assert_eq!(store.current().expect("current").revision(), 1);
    }

    #[test]
    fn stale_revision_and_plaintext_secret_are_rejected_without_writes() {
        let mut connection = Connection::open_in_memory().expect("database");
        let _host = host_authority(&mut connection);
        let mut store = new_store(&mut connection);
        let authority = authority_for(&store, 1, 1);
        store.bind_authority(&authority).expect("bind");
        let first =
            ConfigurationTransaction::new("tx-1", Some(0), json!({"value": 1})).expect("request");
        store.apply(&authority, &first).expect("first");
        let stale =
            ConfigurationTransaction::new("tx-2", Some(0), json!({"value": 2})).expect("request");
        assert!(matches!(
            store.apply(&authority, &stale),
            Err(ConfigurationError::RevisionConflict { .. })
        ));
        let plaintext =
            ConfigurationTransaction::new("tx-3", Some(1), json!({"password": "not-a-reference"}));
        assert!(matches!(
            plaintext,
            Err(ConfigurationError::PlaintextSecret)
        ));
        assert_eq!(store.current().expect("current").revision(), 1);
    }

    #[test]
    fn rollback_creates_new_revision_and_restores_historical_value() {
        let mut connection = Connection::open_in_memory().expect("database");
        let _host = host_authority(&mut connection);
        let mut store = new_store(&mut connection);
        let authority = authority_for(&store, 1, 1);
        store.bind_authority(&authority).expect("bind");
        store
            .apply(
                &authority,
                &ConfigurationTransaction::new("tx-1", Some(0), json!({"v": 1})).unwrap(),
            )
            .expect("first");
        store
            .apply(
                &authority,
                &ConfigurationTransaction::new("tx-2", Some(1), json!({"v": 2})).unwrap(),
            )
            .expect("second");
        let rollback = ConfigurationTransaction::rollback("tx-3", Some(2), 1).unwrap();
        let receipt = store.apply(&authority, &rollback).expect("rollback");
        assert_eq!(receipt.revision(), 3);
        assert_eq!(store.current().unwrap().configuration(), &json!({"v": 1}));
        assert_eq!(store.revision(2).unwrap().configuration(), &json!({"v": 2}));
    }

    #[test]
    fn rotation_rejects_stale_and_incompatible_requests_without_database_changes() {
        let mut connection = Connection::open_in_memory().expect("database");
        let host = host_authority(&mut connection);
        let mut store = new_store(&mut connection);
        let old_authority = authority_for(&store, 1, 1);
        store.bind_authority(&old_authority).expect("bind");
        store
            .apply(
                &old_authority,
                &ConfigurationTransaction::new("baseline", Some(0), json!({"mode": "base"}))
                    .unwrap(),
            )
            .expect("baseline");

        drop(store);
        let mut core = SqliteCoreStore::new(&mut connection).expect("core schema");
        let descriptor_digest = Sha256Digest::compute(b"descriptor").to_canonical_string();
        let manifest_digest = Sha256Digest::compute(b"manifest").to_canonical_string();
        let graph_digest = Sha256Digest::compute(b"graph-v1").to_canonical_string();
        core.install_host_capability_grant(
            &host,
            "org.example.extension",
            "module-one",
            2,
            1,
            &descriptor_digest,
            1,
            &manifest_digest,
            1,
            &graph_digest,
            &["host.block.get"],
        )
        .expect("fresh Host capability grant");
        drop(core);
        let mut store = new_store(&mut connection);
        let fresh_authority = authority_for(&store, 2, 2);
        store
            .rotate_authority(&old_authority, &fresh_authority)
            .expect("rotate");
        let proposed =
            ConfigurationTransaction::new("proposal-n", Some(1), json!({"mode": "next"}))
                .expect("proposal");
        let stale_rollback =
            ConfigurationTransaction::rollback("rollback-n", Some(1), 1).expect("rollback");

        let before = database_rows(&store);
        assert!(matches!(
            store.apply(&old_authority, &proposed),
            Err(ConfigurationError::AuthorityConflict)
        ));
        assert_eq!(database_rows(&store), before);
        assert!(matches!(
            store.apply(&old_authority, &stale_rollback),
            Err(ConfigurationError::AuthorityConflict)
        ));
        assert_eq!(database_rows(&store), before);

        let wrong_base = authority(
            2,
            2,
            0,
            Sha256Digest::compute(b"wrong-base"),
            1,
            Sha256Digest::compute(b"graph-v1"),
        );
        assert!(matches!(
            store.apply(&wrong_base, &proposed),
            Err(ConfigurationError::AuthorityConflict)
        ));
        assert_eq!(database_rows(&store), before);
        let wrong_graph = authority(
            2,
            2,
            fresh_authority_base_revision(&store),
            fresh_authority_base_digest(&store),
            2,
            Sha256Digest::compute(b"graph-v2"),
        );
        assert!(matches!(
            store.apply(&wrong_graph, &proposed),
            Err(ConfigurationError::AuthorityConflict)
        ));
        assert_eq!(database_rows(&store), before);

        let committed = store
            .apply(&fresh_authority, &proposed)
            .expect("fresh apply");
        assert_eq!(committed.disposition(), ConfigurationDisposition::Committed);
        let replayed = store.apply(&fresh_authority, &proposed).expect("replay");
        assert_eq!(replayed.disposition(), ConfigurationDisposition::Replayed);
        let after_replay = database_rows(&store);
        let changed_request =
            ConfigurationTransaction::new("proposal-n", Some(1), json!({"mode": "changed"}))
                .expect("changed request");
        assert!(matches!(
            store.apply(&fresh_authority, &changed_request),
            Err(ConfigurationError::IdempotencyConflict)
        ));
        assert_eq!(database_rows(&store), after_replay);

        let rollback_current =
            ConfigurationTransaction::rollback("rollback-current", Some(2), 1).expect("rollback");
        assert!(matches!(
            store.apply(&fresh_authority, &rollback_current),
            Err(ConfigurationError::RollbackAuthorityConflict)
        ));
        assert_eq!(database_rows(&store), after_replay);

        let future_authority = authority_for(&store, 3, 3);
        assert!(matches!(
            store.apply(&future_authority, &proposed),
            Err(ConfigurationError::AuthorityConflict)
        ));
        assert_eq!(database_rows(&store), after_replay);
    }

    fn fresh_authority_base_revision(store: &ConfigurationStore<'_>) -> u64 {
        store.current().expect("current").revision()
    }

    fn fresh_authority_base_digest(store: &ConfigurationStore<'_>) -> Sha256Digest {
        store.current().expect("current").digest().clone()
    }

    #[test]
    fn malformed_secret_reference_is_not_accepted_as_a_reference() {
        assert!(!valid_secret_ref("secret://../password"));
        assert!(matches!(
            ConfigurationTransaction::new(
                "tx",
                Some(0),
                json!({"credential": "secret://vault/password"}),
            ),
            Ok(_)
        ));
    }
}
