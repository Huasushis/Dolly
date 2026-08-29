//! Durable Channel store (G4-C runtime persistence).
//!
//! One module-scoped SQLite connection owns three slices, all write and read
//! through this module only:
//!
//! - the **owner singleton**: the exact Extension/Module/Channel-account the
//!   store is bound to. A store opened under a different owner fails closed,
//!   so cross-module or cross-account reuse of a database file is impossible;
//! - the **Channel ledger document**: the accepted [`ChannelLedger`] record
//!   shapes (sessions, echo suppression, terminal inbound/outbound rows),
//!   persisted as one digest-guarded canonical document;
//! - the **intent records** ([`ChannelIntent`]): the principal-bound
//!   prepared/accepted/rejected lifecycle persisted before any Host submit or
//!   Core effect and reconciled status-first after a crash.
//!
//! Every record is stored as canonical bytes guarded by its SHA-256 digest;
//! tamper, loss, or schema drift fails closed instead of silently resetting
//! deduplication or losing an already-started effect.

use dolly_canonical_json::Sha256Digest;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::intent::{CHANNEL_INTENT_RECORD_SCHEMA, ChannelIntent, IntentState};
use crate::ledger::{ChannelLedger, ledger_from_json_string, ledger_to_json_string};

/// The logical table holding the store-owner binding.
pub const CHANNEL_STORE_OWNER_TABLE: &str = "channel_store_owner";
/// The logical table holding the Channel ledger document.
pub const CHANNEL_LEDGER_TABLE: &str = "channel_ledger_state";
/// The logical table holding prepared/accepted/rejected intents.
pub const CHANNEL_INTENT_TABLE: &str = "channel_intent";

/// The schema discriminator stored in the owner singleton.
pub const CHANNEL_STORE_SCHEMA_DISCRIMINATOR: &str = "dolly.channel-store/v1";
/// The ledger document schema discriminator.
pub const CHANNEL_LEDGER_SCHEMA_DISCRIMINATOR: &str = "dolly.channel-ledger/v1";
/// The physical schema version of the Channel store.
pub const CHANNEL_STORE_SCHEMA_VERSION: i64 = 1;

/// The authoritative Channel store schema (all three tables).
pub const CHANNEL_STORE_SCHEMA_SQL: &str = r#"
CREATE TABLE channel_store_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.channel-store/v1'),
    owner_jcs TEXT NOT NULL,
    owner_digest TEXT NOT NULL
);
CREATE TABLE channel_ledger_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.channel-ledger/v1'),
    state_digest TEXT NOT NULL,
    state_jcs BLOB NOT NULL
);
CREATE TABLE channel_intent (
    intent_key TEXT PRIMARY KEY NOT NULL,
    record_digest TEXT NOT NULL,
    canonical_jcs BLOB NOT NULL
)"#;

/// The exact owner-table definition used both in the batch SQL and the gate.
pub const CHANNEL_STORE_OWNER_SCHEMA_SQL: &str = "\
CREATE TABLE channel_store_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.channel-store/v1'),
    owner_jcs TEXT NOT NULL,
    owner_digest TEXT NOT NULL
)";

/// The exact ledger-document table definition used both in the batch and gate.
pub const CHANNEL_LEDGER_SCHEMA_SQL: &str = "\
CREATE TABLE channel_ledger_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.channel-ledger/v1'),
    state_digest TEXT NOT NULL,
    state_jcs BLOB NOT NULL
)";

/// The exact intent-table definition used both in the batch and gate.
pub const CHANNEL_INTENT_SCHEMA_SQL: &str = "\
CREATE TABLE channel_intent (
    intent_key TEXT PRIMARY KEY NOT NULL,
    record_digest TEXT NOT NULL,
    canonical_jcs BLOB NOT NULL
)";

const OWNER_COLUMNS: &[&str] = &[
    "singleton",
    "schema_version",
    "schema_discriminator",
    "owner_jcs",
    "owner_digest",
];
const LEDGER_COLUMNS: &[&str] = &[
    "singleton",
    "schema_version",
    "schema_discriminator",
    "state_digest",
    "state_jcs",
];
const INTENT_COLUMNS: &[&str] = &["intent_key", "record_digest", "canonical_jcs"];

/// The exact module ownership a Channel store is bound to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelStoreOwner {
    pub extension_id: String,
    pub module_id: String,
    /// The principal-derived Channel account (dedup namespace root).
    pub account: String,
}

fn map_sqlite(error: rusqlite::Error) -> ChannelError {
    ChannelError::new(
        codes::INTERNAL,
        false,
        ChannelOutcome::NotApplied,
        format!("channel ledger storage failure: {error}"),
    )
}

fn corrupted(message: &str) -> ChannelError {
    ChannelError::new(
        codes::LEDGER_CORRUPT,
        false,
        ChannelOutcome::NotApplied,
        message,
    )
}

fn normalize_schema_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<String>()
}

fn verify_table(connection: &Connection, name: &str, expected: &str) -> Result<(), ChannelError> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT type, sql FROM sqlite_master WHERE name = ?1",
            [name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(map_sqlite)?;
    match row {
        Some((object_type, actual))
            if object_type == "table"
                && normalize_schema_sql(&actual) == normalize_schema_sql(expected) =>
        {
            Ok(())
        }
        Some(_) => Err(corrupted(&format!(
            "channel store table {name} does not match the exact schema"
        ))),
        None => Err(ChannelError::new(
            codes::LEDGER_MIGRATION_REQUIRED,
            false,
            ChannelOutcome::NotApplied,
            format!("channel store table {name} is missing"),
        )),
    }
}

fn verify_columns(
    connection: &Connection,
    table: &str,
    expected: &[&str],
) -> Result<(), ChannelError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(map_sqlite)?;
    let actual = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(map_sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_sqlite)?;
    if actual != expected {
        return Err(corrupted(&format!(
            "channel store table {table} columns are wrong"
        )));
    }
    Ok(())
}

/// Fail-closed schema gate every Channel store reader/writer must pass.
pub fn gate_channel_store_schema(connection: &Connection) -> Result<(), ChannelError> {
    verify_table(
        connection,
        CHANNEL_STORE_OWNER_TABLE,
        CHANNEL_STORE_OWNER_SCHEMA_SQL,
    )?;
    verify_table(connection, CHANNEL_LEDGER_TABLE, CHANNEL_LEDGER_SCHEMA_SQL)?;
    verify_table(connection, CHANNEL_INTENT_TABLE, CHANNEL_INTENT_SCHEMA_SQL)?;
    verify_columns(connection, CHANNEL_STORE_OWNER_TABLE, OWNER_COLUMNS)?;
    verify_columns(connection, CHANNEL_LEDGER_TABLE, LEDGER_COLUMNS)?;
    verify_columns(connection, CHANNEL_INTENT_TABLE, INTENT_COLUMNS)
}

/// Create the Channel store schema on an existing connection, inside its own
/// immediate transaction. Existing partial or malformed objects fail closed.
pub fn create_channel_store_schema(connection: &mut Connection) -> Result<(), ChannelError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sqlite)?;
    transaction
        .execute_batch(CHANNEL_STORE_SCHEMA_SQL)
        .map_err(map_sqlite)?;
    transaction.commit().map_err(map_sqlite)?;
    gate_channel_store_schema(connection)
}

/// The storage-agnostic Channel store boundary: the ledger document
/// (sessions, echo suppression, terminal rows) plus the per-event durable
/// intent lifecycle (prepared before any effect, settled or rejected after).
pub trait ChannelStore {
    fn load(&mut self) -> Result<ChannelLedger, ChannelError>;
    fn save(&mut self, ledger: &ChannelLedger) -> Result<(), ChannelError>;
    fn find_intent(&mut self, intent_key: &str) -> Result<Option<ChannelIntent>, ChannelError>;
    /// Durably record a `prepared` intent BEFORE any Host submit or Core
    /// effect. Idempotent for the same key and digest; a different digest
    /// under the same key fails closed as an idempotency conflict and changes
    /// nothing. Never downgrades a terminal record.
    fn write_prepared(&mut self, intent: &ChannelIntent) -> Result<(), ChannelError>;
    fn settle_accepted(&mut self, intent_key: &str, block_id: &str) -> Result<(), ChannelError>;
    fn mark_rejected(&mut self, intent_key: &str, code: &str) -> Result<(), ChannelError>;
    fn list_pending(&mut self) -> Result<Vec<ChannelIntent>, ChannelError>;
}

/// The durable Channel store over one verified, ownership-bound module-scoped
/// SQLite connection.
#[derive(Debug)]
pub struct SqliteChannelStore<'connection> {
    connection: &'connection mut Connection,
}

fn bind_owner(connection: &mut Connection, owner: &ChannelStoreOwner) -> Result<(), ChannelError> {
    let owner_record = serde_json::json!({
        "schema": "dolly.channel-store-owner/v1",
        "extension_id": owner.extension_id,
        "module_id": owner.module_id,
        "account": owner.account,
    });
    let owner_bytes = dolly_canonical_json::canonicalize(&owner_record)
        .map_err(|error| {
            corrupted(&format!(
                "channel store owner failed canonicalization: {error}"
            ))
        })?
        .0
        .as_bytes()
        .to_vec();
    let owner_text = String::from_utf8(owner_bytes).expect("canonical encoding is UTF-8");
    let owner_digest = Sha256Digest::compute(owner_text.as_bytes()).to_canonical_string();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sqlite)?;
    let existing: Option<String> = transaction
        .query_row(
            "SELECT owner_digest FROM channel_store_owner WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite)?;
    match existing {
        Some(stored) if stored == owner_digest => {}
        Some(_) => {
            drop(transaction);
            return Err(ChannelError::new(
                codes::AUTHENTICATION_FAILED,
                false,
                ChannelOutcome::NotApplied,
                "channel store is bound to a different module ownership (cross-module reuse)",
            ));
        }
        None => {
            transaction
                .execute(
                    "INSERT INTO channel_store_owner
                        (singleton, schema_version, schema_discriminator, owner_jcs, owner_digest)
                     VALUES (1, ?1, ?2, ?3, ?4)",
                    params![
                        CHANNEL_STORE_SCHEMA_VERSION,
                        CHANNEL_STORE_SCHEMA_DISCRIMINATOR,
                        owner_text,
                        owner_digest
                    ],
                )
                .map_err(map_sqlite)?;
        }
    }
    transaction.commit().map_err(map_sqlite)
}

impl<'connection> SqliteChannelStore<'connection> {
    /// Open and verify the store, and bind it to the exact module ownership.
    /// The first open records the owner; every later open (or cross-module
    /// reuse) must present the same owner or fails closed.
    pub fn new(
        connection: &'connection mut Connection,
        owner: ChannelStoreOwner,
    ) -> Result<Self, ChannelError> {
        gate_channel_store_schema(connection)?;
        bind_owner(connection, &owner)?;
        Ok(Self { connection })
    }

    fn verify_owner(&self) -> Result<(), ChannelError> {
        let row: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT owner_digest, owner_jcs FROM channel_store_owner WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(map_sqlite)?;
        match row {
            Some((digest, jcs)) => {
                let computed = Sha256Digest::compute(jcs.as_bytes()).to_canonical_string();
                if computed != digest {
                    return Err(corrupted("channel store owner binding digest mismatch"));
                }
            }
            None => {
                return Err(ChannelError::new(
                    codes::LEDGER_MIGRATION_REQUIRED,
                    false,
                    ChannelOutcome::NotApplied,
                    "channel store owner binding is missing",
                ));
            }
        }
        Ok(())
    }

    fn load_intent_row(&mut self, intent_key: &str) -> Result<Option<ChannelIntent>, ChannelError> {
        self.verify_owner()?;
        let row: Option<(String, Vec<u8>)> = self
            .connection
            .query_row(
                "SELECT record_digest, canonical_jcs FROM channel_intent WHERE intent_key = ?1",
                [intent_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(map_sqlite)?;
        let Some((digest, jcs)) = row else {
            return Ok(None);
        };
        let computed = Sha256Digest::compute(&jcs).to_canonical_string();
        if computed != digest {
            return Err(corrupted(
                "channel intent record digest mismatch (tampered)",
            ));
        }
        let text = std::str::from_utf8(&jcs)
            .map_err(|_| corrupted("channel intent record is not UTF-8"))?;
        ChannelIntent::from_canonical_string(text).map(Some)
    }

    fn write_intent_row(&mut self, intent: &ChannelIntent) -> Result<(), ChannelError> {
        self.verify_owner()?;
        let text = intent.canonical_string()?;
        let digest = Sha256Digest::compute(text.as_bytes()).to_canonical_string();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite)?;
        transaction
            .execute(
                "INSERT INTO channel_intent (intent_key, record_digest, canonical_jcs)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(intent_key) DO UPDATE SET
                    record_digest = ?2,
                    canonical_jcs = ?3",
                params![intent.intent_key, digest, text.as_bytes()],
            )
            .map_err(map_sqlite)?;
        transaction.commit().map_err(map_sqlite)
    }

    fn mutate_intent(
        &mut self,
        intent_key: &str,
        mutate: impl FnOnce(&mut ChannelIntent),
    ) -> Result<(), ChannelError> {
        self.verify_owner()?;
        let Some(existing) = self.load_intent_row(intent_key)? else {
            return Err(corrupted("channel intent row missing for lifecycle update"));
        };
        let mut updated = existing;
        mutate(&mut updated);
        self.write_intent_row(&updated)
    }
}

impl ChannelStore for SqliteChannelStore<'_> {
    fn load(&mut self) -> Result<ChannelLedger, ChannelError> {
        self.verify_owner()?;
        let row: Option<(i64, String, String, Vec<u8>)> = self
            .connection
            .query_row(
                "SELECT schema_version, schema_discriminator, state_digest, state_jcs
                 FROM channel_ledger_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(map_sqlite)?;
        let Some((version, discriminator, digest, jcs)) = row else {
            return Ok(ChannelLedger::new());
        };
        if version != CHANNEL_STORE_SCHEMA_VERSION
            || discriminator != CHANNEL_LEDGER_SCHEMA_DISCRIMINATOR
        {
            return Err(ChannelError::new(
                codes::LEDGER_MIGRATION_REQUIRED,
                false,
                ChannelOutcome::NotApplied,
                "channel ledger document version or discriminator is stale",
            ));
        }
        let computed = Sha256Digest::compute(&jcs).to_canonical_string();
        if computed != digest {
            return Err(corrupted(
                "channel ledger document digest mismatch (tampered)",
            ));
        }
        let json = std::str::from_utf8(&jcs)
            .map_err(|_| corrupted("channel ledger document is not UTF-8"))?;
        ledger_from_json_string(json)
            .map_err(|_| corrupted("channel ledger document failed to deserialize"))
    }

    fn save(&mut self, ledger: &ChannelLedger) -> Result<(), ChannelError> {
        self.verify_owner()?;
        let json = ledger_to_json_string(ledger)?;
        let bytes = json.as_bytes();
        let digest = Sha256Digest::compute(bytes).to_canonical_string();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite)?;
        transaction
            .execute(
                "INSERT INTO channel_ledger_state
                    (singleton, schema_version, schema_discriminator, state_digest, state_jcs)
                 VALUES (1, ?1, ?2, ?3, ?4)
                 ON CONFLICT(singleton) DO UPDATE SET
                    schema_version = ?1,
                    schema_discriminator = ?2,
                    state_digest = ?3,
                    state_jcs = ?4",
                params![
                    CHANNEL_STORE_SCHEMA_VERSION,
                    CHANNEL_LEDGER_SCHEMA_DISCRIMINATOR,
                    digest,
                    bytes
                ],
            )
            .map_err(map_sqlite)?;
        transaction.commit().map_err(map_sqlite)
    }

    fn find_intent(&mut self, intent_key: &str) -> Result<Option<ChannelIntent>, ChannelError> {
        self.load_intent_row(intent_key)
    }

    fn write_prepared(&mut self, intent: &ChannelIntent) -> Result<(), ChannelError> {
        self.verify_owner()?;
        if intent.state != IntentState::Prepared {
            return Err(corrupted("write_prepared requires a prepared intent"));
        }
        if intent.schema != CHANNEL_INTENT_RECORD_SCHEMA {
            return Err(corrupted("channel intent record discriminator mismatch"));
        }
        if let Some(existing) = self.load_intent_row(&intent.intent_key)? {
            if existing.digest != intent.digest {
                return Err(ChannelError::new(
                    codes::OPERATION_CONFLICT,
                    false,
                    ChannelOutcome::NotApplied,
                    "channel intent key already carries a different operation digest",
                ));
            }
            if existing.state != IntentState::Prepared {
                // A terminal outcome already exists; nothing to prepare.
                return Ok(());
            }
            if existing == *intent {
                return Ok(());
            }
        }
        self.write_intent_row(intent)
    }

    fn settle_accepted(&mut self, intent_key: &str, block_id: &str) -> Result<(), ChannelError> {
        self.mutate_intent(intent_key, |intent| {
            intent.state = IntentState::Accepted;
            intent.block_id = Some(block_id.to_string());
        })
    }

    fn mark_rejected(&mut self, intent_key: &str, code: &str) -> Result<(), ChannelError> {
        self.mutate_intent(intent_key, |intent| {
            intent.state = IntentState::Rejected;
            intent.rejected_code = Some(code.to_string());
        })
    }

    fn list_pending(&mut self) -> Result<Vec<ChannelIntent>, ChannelError> {
        self.verify_owner()?;
        let mut statement = self
            .connection
            .prepare("SELECT record_digest, canonical_jcs FROM channel_intent")
            .map_err(map_sqlite)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(map_sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_sqlite)?;
        let mut pending = Vec::new();
        for (digest, jcs) in rows {
            let computed = Sha256Digest::compute(&jcs).to_canonical_string();
            if computed != digest {
                return Err(corrupted(
                    "channel intent record digest mismatch (tampered)",
                ));
            }
            let text = std::str::from_utf8(&jcs)
                .map_err(|_| corrupted("channel intent record is not UTF-8"))?;
            let intent = ChannelIntent::from_canonical_string(text)?;
            if intent.state == IntentState::Prepared {
                pending.push(intent);
            }
        }
        Ok(pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::EventKind;

    fn owner() -> ChannelStoreOwner {
        ChannelStoreOwner {
            extension_id: "org.dolly.channel".to_string(),
            module_id: "receiver".to_string(),
            account: "dolly-account-0123456789abcdef".to_string(),
        }
    }

    fn connection() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        create_channel_store_schema(&mut connection).unwrap();
        connection
    }

    fn intent(key: &str) -> ChannelIntent {
        ChannelIntent {
            schema: CHANNEL_INTENT_RECORD_SCHEMA.to_string(),
            intent_key: key.to_string(),
            digest: "sha256:0000000000".to_string(),
            state: IntentState::Prepared,
            owner: "owner-1".to_string(),
            extension_id: "org.dolly.channel".to_string(),
            module_id: "receiver".to_string(),
            instance_id: "worker-1".to_string(),
            generation: 1,
            revision: 1,
            graph_revision: 1,
            config_revision: 1,
            account: "dolly-account-0123456789abcdef".to_string(),
            external_event_id: "msg-1".to_string(),
            kind: EventKind::Message,
            references_external_event_id: None,
            target_page_ids: vec!["page-a".to_string()],
            payload_digest: "sha256:ab".to_string(),
            request_jcs: "{}".to_string(),
            block_id: None,
            rejected_code: None,
        }
    }

    #[test]
    fn store_binds_owner_and_rejects_cross_module_reuse() {
        let mut connection = connection();
        {
            let mut store = SqliteChannelStore::new(&mut connection, owner()).unwrap();
            let mut ledger = ChannelLedger::new();
            ledger.insert_session("account-1", "conv-1", "session-main");
            store.save(&ledger).unwrap();
        }
        let wrong = ChannelStoreOwner {
            extension_id: "org.dolly.other".to_string(),
            module_id: "other-module".to_string(),
            account: "dolly-account-ffffffffffffffff".to_string(),
        };
        let error =
            SqliteChannelStore::new(&mut connection, wrong).expect_err("cross-module reuse");
        assert_eq!(error.code, codes::AUTHENTICATION_FAILED);
    }

    #[test]
    fn intent_lifecycle_prepared_to_accepted_survives_reload() {
        let mut connection = connection();
        {
            let mut store = SqliteChannelStore::new(&mut connection, owner()).unwrap();
            let intent = intent("key-1");
            store.write_prepared(&intent).unwrap();
            store.settle_accepted("key-1", "block-1").unwrap();
        }
        {
            let mut store = SqliteChannelStore::new(&mut connection, owner()).unwrap();
            let loaded = store.find_intent("key-1").unwrap().expect("intent row");
            assert_eq!(loaded.state, IntentState::Accepted);
            assert_eq!(loaded.block_id.as_deref(), Some("block-1"));
            assert!(
                store.list_pending().unwrap().is_empty(),
                "prepared rows only"
            );
        }
    }

    #[test]
    fn tampered_intent_fails_closed() {
        let mut connection = connection();
        {
            let mut store = SqliteChannelStore::new(&mut connection, owner()).unwrap();
            store.write_prepared(&intent("key-tamper")).unwrap();
        }
        connection
            .execute(
                "UPDATE channel_intent SET canonical_jcs = X'AABB' WHERE intent_key = 'key-tamper'",
                [],
            )
            .unwrap();
        {
            let mut store = SqliteChannelStore::new(&mut connection, owner()).unwrap();
            let error = store
                .find_intent("key-tamper")
                .expect_err("tamper must fail closed");
            assert_eq!(error.code, codes::LEDGER_CORRUPT);
        }
    }
}
