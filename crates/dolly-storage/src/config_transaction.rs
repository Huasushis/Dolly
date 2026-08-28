//! Atomic configuration revisions with rollback and exact replay.
//!
//! [`ConfigurationStore`] is a single-writer SQLite boundary. A replacement
//! or rollback writes the immutable revision, current pointer, and idempotency
//! receipt in one immediate transaction. The durable record contains only
//! canonical configuration bytes; credential values must be represented by a
//! `SecretRef` URI and are rejected when supplied as plaintext.

use dolly_canonical_json::{Sha256Digest, canonicalize};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use thiserror::Error;

/// Maximum configuration revision accepted by the safe integer contract.
pub const MAX_CONFIGURATION_REVISION: u64 = 9_007_199_254_740_991;
/// Logical schema version for the configuration transaction ledger.
pub const CONFIGURATION_SCHEMA_VERSION: i64 = 1;

/// Tables owned by the configuration transaction ledger.
pub const CONFIGURATION_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS configuration_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1)
);
INSERT OR IGNORE INTO configuration_meta (singleton, schema_version) VALUES (1, 1);
CREATE TABLE IF NOT EXISTS configuration_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    current_revision INTEGER NOT NULL CHECK (current_revision BETWEEN 0 AND 9007199254740991),
    current_digest TEXT NOT NULL,
    current_jcs BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS configuration_revisions (
    revision INTEGER PRIMARY KEY CHECK (revision BETWEEN 1 AND 9007199254740991),
    digest TEXT NOT NULL,
    config_jcs BLOB NOT NULL,
    transaction_id TEXT NOT NULL UNIQUE,
    previous_revision INTEGER NOT NULL CHECK (previous_revision BETWEEN 0 AND 9007199254740991),
    operation TEXT NOT NULL CHECK (operation IN ('replace', 'rollback')),
    rollback_target_revision INTEGER
);
CREATE TABLE IF NOT EXISTS configuration_transactions (
    transaction_id TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL,
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
        "configuration_revisions",
        &[
            "revision",
            "digest",
            "config_jcs",
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

    pub fn disposition(&self) -> ConfigurationDisposition {
        self.disposition
    }
}

/// Current canonical configuration pointer and decoded value.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigurationSnapshot {
    revision: u64,
    digest: Sha256Digest,
    configuration: Value,
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
    #[error("configuration contains plaintext secret material")]
    PlaintextSecret,
    #[error("configuration value is invalid")]
    InvalidConfiguration,
    #[error("configuration revision conflict")]
    RevisionConflict { expected: u64, actual: u64 },
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

    /// Atomically apply a replacement or rollback and record its replay key.
    pub fn apply(
        &mut self,
        request: &ConfigurationTransaction,
    ) -> Result<ConfigurationReceipt, ConfigurationError> {
        request.validate()?;
        let request_digest = request_digest(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(ConfigurationError::Storage)?;

        if let Some(receipt) = load_transaction(&transaction, request.transaction_id())? {
            if receipt.0 != request_digest {
                return Err(ConfigurationError::IdempotencyConflict);
            }
            transaction.commit().map_err(ConfigurationError::Storage)?;
            return Ok(ConfigurationReceipt {
                transaction_id: request.transaction_id().to_owned(),
                revision: receipt.1,
                digest: receipt.2,
                disposition: ConfigurationDisposition::Replayed,
            });
        }

        let current = load_state(&transaction)?;
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
            ConfigurationChange::Rollback { target_revision } => (
                load_revision_configuration(&transaction, *target_revision)?,
                "rollback",
                Some(*target_revision),
            ),
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
                 (revision, digest, config_jcs, transaction_id, previous_revision,
                  operation, rollback_target_revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    next_revision as i64,
                    digest_text,
                    canonical_bytes,
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
                 (transaction_id, request_digest, result_revision, result_digest, disposition)
                 VALUES (?1, ?2, ?3, ?4, 'committed')",
                params![
                    request.transaction_id(),
                    request_digest,
                    next_revision as i64,
                    digest.to_canonical_string(),
                ],
            )
            .map_err(ConfigurationError::Storage)?;
        transaction.commit().map_err(ConfigurationError::Storage)?;
        Ok(ConfigurationReceipt {
            transaction_id: request.transaction_id().to_owned(),
            revision: next_revision,
            digest,
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
            revision: receipt.1,
            digest: receipt.2,
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

fn load_revision_configuration(
    transaction: &Transaction<'_>,
    revision: u64,
) -> Result<Value, ConfigurationError> {
    if revision == 0 {
        return Ok(json!({}));
    }
    if revision > MAX_CONFIGURATION_REVISION {
        return Err(ConfigurationError::RollbackTargetUnavailable);
    }
    let bytes: Option<Vec<u8>> = transaction
        .query_row(
            "SELECT config_jcs FROM configuration_revisions WHERE revision = ?1",
            [revision as i64],
            |row| row.get(0),
        )
        .optional()
        .map_err(ConfigurationError::Storage)?;
    let bytes = bytes.ok_or(ConfigurationError::RollbackTargetUnavailable)?;
    decode_snapshot(revision, &bytes).map(|snapshot| snapshot.configuration)
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

fn request_digest(request: &ConfigurationTransaction) -> Result<String, ConfigurationError> {
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
    let request_value = json!({
        "transaction_id": request.transaction_id(),
        "expected_revision": request.expected_revision(),
        "change": change,
    });
    canonicalize(&request_value)
        .map(|(_, digest)| digest.to_canonical_string())
        .map_err(|_| ConfigurationError::InvalidTransaction)
}

fn load_transaction(
    connection: &Connection,
    transaction_id: &str,
) -> Result<Option<(String, u64, Sha256Digest)>, ConfigurationError> {
    let row: Option<(String, i64, String)> = connection
        .query_row(
            "SELECT request_digest, result_revision, result_digest
             FROM configuration_transactions WHERE transaction_id = ?1",
            [transaction_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(ConfigurationError::Storage)?;
    let Some((request_digest, revision, digest_text)) = row else {
        return Ok(None);
    };
    if !(1..=MAX_CONFIGURATION_REVISION as i64).contains(&revision) {
        return Err(ConfigurationError::Corrupt);
    }
    let digest = digest_text
        .parse()
        .map_err(|_| ConfigurationError::Corrupt)?;
    Ok(Some((request_digest, revision as u64, digest)))
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
    use rusqlite::Connection;

    fn new_store<'connection>(
        connection: &'connection mut Connection,
    ) -> ConfigurationStore<'connection> {
        ConfigurationStore::new(connection).expect("schema")
    }

    #[test]
    fn replacement_is_atomic_and_exact_replay_is_idempotent() {
        let mut connection = Connection::open_in_memory().expect("database");
        let mut store = new_store(&mut connection);
        let request = ConfigurationTransaction::new(
            "tx-1",
            Some(0),
            json!({"endpoint": "https://example.test", "credential": "secret://vault/api"}),
        )
        .expect("request");
        let committed = store.apply(&request).expect("commit");
        assert_eq!(committed.disposition(), ConfigurationDisposition::Committed);
        assert_eq!(committed.revision(), 1);
        let replayed = store.apply(&request).expect("replay");
        assert_eq!(
            replayed,
            ConfigurationReceipt {
                transaction_id: "tx-1".into(),
                revision: 1,
                digest: committed.digest().clone(),
                disposition: ConfigurationDisposition::Replayed,
            }
        );
        assert_eq!(store.current().expect("current").revision(), 1);
    }

    #[test]
    fn stale_revision_and_plaintext_secret_are_rejected_without_writes() {
        let mut connection = Connection::open_in_memory().expect("database");
        let mut store = new_store(&mut connection);
        let first =
            ConfigurationTransaction::new("tx-1", Some(0), json!({"value": 1})).expect("request");
        store.apply(&first).expect("first");
        let stale =
            ConfigurationTransaction::new("tx-2", Some(0), json!({"value": 2})).expect("request");
        assert!(matches!(
            store.apply(&stale),
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
        let mut store = new_store(&mut connection);
        store
            .apply(&ConfigurationTransaction::new("tx-1", Some(0), json!({"v": 1})).unwrap())
            .expect("first");
        store
            .apply(&ConfigurationTransaction::new("tx-2", Some(1), json!({"v": 2})).unwrap())
            .expect("second");
        let rollback = ConfigurationTransaction::rollback("tx-3", Some(2), 1).unwrap();
        let receipt = store.apply(&rollback).expect("rollback");
        assert_eq!(receipt.revision(), 3);
        assert_eq!(store.current().unwrap().configuration(), &json!({"v": 1}));
        assert_eq!(store.revision(2).unwrap().configuration(), &json!({"v": 2}));
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
