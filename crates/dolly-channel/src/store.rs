//! Durable Channel ledger backing (G4-C runtime persistence).
//!
//! The Channel's durable state is one [`ChannelLedger`] document (the exact
//! record shapes from `ledger.rs`: account-scoped inbound rows, outbound rows,
//! the session map, and the echoed-ID set). This module stores that document
//! in module-scoped SQLite storage as a single canonical-JSON singleton row
//! guarded by its SHA-256 digest, so stop/restart and crash recovery load the
//! exact same ledger and any tamper or loss fails closed instead of silently
//! resetting deduplication state.
//!
//! The store is Channel-owned state only: it never touches Core state, Pages,
//! the Host ingress slice, or any other authority. The Host ingress premise
//! and its authority fences live in the `dolly-storage` seam; the Channel
//! ledger records the account-scoped event identity, the stable ingress key
//! and operation digest, the ordered target Pages, and the lifecycle relation
//! captured under the config revision.

use dolly_canonical_json::Sha256Digest;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::ledger::{ChannelLedger, ledger_from_json_string, ledger_to_json_string};

/// The logical table the Channel ledger singleton row lives in.
pub const CHANNEL_LEDGER_TABLE: &str = "channel_ledger_state";

/// The schema discriminator stored in the singleton row.
pub const CHANNEL_LEDGER_SCHEMA_DISCRIMINATOR: &str = "dolly.channel-ledger/v1";

/// The physical schema version of the Channel ledger slice.
pub const CHANNEL_LEDGER_SCHEMA_VERSION: i64 = 1;

/// The authoritative Channel ledger schema: one singleton row holding the
/// canonical ledger document plus its digest.
pub const CHANNEL_LEDGER_SCHEMA_SQL: &str = r#"
CREATE TABLE channel_ledger_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.channel-ledger/v1'),
    state_digest TEXT NOT NULL,
    state_jcs BLOB NOT NULL
)"#;

const CHANNEL_LEDGER_COLUMNS: &[&str] = &[
    "singleton",
    "schema_version",
    "schema_discriminator",
    "state_digest",
    "state_jcs",
];

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

fn verify_table(connection: &Connection) -> Result<(), ChannelError> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT type, sql FROM sqlite_master WHERE name = ?1",
            [CHANNEL_LEDGER_TABLE],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(map_sqlite)?;
    match row {
        Some((object_type, actual))
            if object_type == "table"
                && normalize_schema_sql(&actual)
                    == normalize_schema_sql(CHANNEL_LEDGER_SCHEMA_SQL) =>
        {
            Ok(())
        }
        Some(_) => Err(corrupted(
            "channel ledger table does not match the exact schema",
        )),
        None => Err(ChannelError::new(
            codes::LEDGER_MIGRATION_REQUIRED,
            false,
            ChannelOutcome::NotApplied,
            "channel ledger table is missing",
        )),
    }
}

fn verify_columns(connection: &Connection) -> Result<(), ChannelError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({CHANNEL_LEDGER_TABLE})"))
        .map_err(map_sqlite)?;
    let actual = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(map_sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_sqlite)?;
    if actual != CHANNEL_LEDGER_COLUMNS {
        return Err(corrupted("channel ledger table columns are wrong"));
    }
    Ok(())
}

/// Fail-closed schema gate every Channel ledger reader/writer must pass:
/// the table must exist with the exact SQL and columns.
pub fn gate_channel_ledger_schema(connection: &Connection) -> Result<(), ChannelError> {
    verify_table(connection)?;
    verify_columns(connection)
}

/// Create the Channel ledger schema on an existing connection, inside its own
/// immediate transaction. Existing partial or malformed objects fail closed.
/// This is Channel-owned module storage; the row itself appears on the first
/// [`ChannelLedgerStore::save`].
pub fn create_channel_ledger_schema(connection: &mut Connection) -> Result<(), ChannelError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_sqlite)?;
    transaction
        .execute_batch(CHANNEL_LEDGER_SCHEMA_SQL)
        .map_err(map_sqlite)?;
    transaction.commit().map_err(map_sqlite)?;
    gate_channel_ledger_schema(connection)
}

/// The storage-agnostic load/save boundary of the durable Channel ledger.
///
/// `load` returns the exact prior ledger (an empty ledger on first use) and
/// `save` atomically replaces it; any structural violation or digest mismatch
/// fails closed so deduplication state can never silently reset.
pub trait ChannelLedgerStore {
    fn load(&mut self) -> Result<ChannelLedger, ChannelError>;
    fn save(&mut self, ledger: &ChannelLedger) -> Result<(), ChannelError>;
}

/// The durable Channel ledger over one verified module-scoped SQLite
/// connection.
pub struct SqliteChannelLedgerStore<'connection> {
    connection: &'connection mut Connection,
}

impl<'connection> SqliteChannelLedgerStore<'connection> {
    /// Create the store and verify the Channel ledger schema is present and
    /// exact. Missing or malformed schema fails closed (no repair).
    pub fn new(connection: &'connection mut Connection) -> Result<Self, ChannelError> {
        gate_channel_ledger_schema(connection)?;
        Ok(Self { connection })
    }
}

impl ChannelLedgerStore for SqliteChannelLedgerStore<'_> {
    fn load(&mut self) -> Result<ChannelLedger, ChannelError> {
        gate_channel_ledger_schema(self.connection)?;
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
            // No committed ledger document yet: a fresh Channel starts empty.
            return Ok(ChannelLedger::new());
        };
        if version != CHANNEL_LEDGER_SCHEMA_VERSION
            || discriminator != CHANNEL_LEDGER_SCHEMA_DISCRIMINATOR
        {
            return Err(ChannelError::new(
                codes::LEDGER_MIGRATION_REQUIRED,
                false,
                ChannelOutcome::NotApplied,
                "channel ledger state version or discriminator is stale",
            ));
        }
        let computed = Sha256Digest::compute(&jcs).to_canonical_string();
        if computed != digest {
            return Err(corrupted("channel ledger state digest mismatch (tampered)"));
        }
        let json = std::str::from_utf8(&jcs)
            .map_err(|_| corrupted("channel ledger state is not UTF-8"))?;
        ledger_from_json_string(json)
            .map_err(|_| corrupted("channel ledger state failed to deserialize"))
    }

    fn save(&mut self, ledger: &ChannelLedger) -> Result<(), ChannelError> {
        gate_channel_ledger_schema(self.connection)?;
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
                    CHANNEL_LEDGER_SCHEMA_VERSION,
                    CHANNEL_LEDGER_SCHEMA_DISCRIMINATOR,
                    digest,
                    bytes
                ],
            )
            .map_err(map_sqlite)?;
        transaction.commit().map_err(map_sqlite)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        create_channel_ledger_schema(&mut connection).unwrap();
        connection
    }

    #[test]
    fn fresh_store_loads_an_empty_ledger() {
        let mut connection = connection();
        let mut store = SqliteChannelLedgerStore::new(&mut connection).unwrap();
        let ledger = store.load().unwrap();
        assert!(ledger.inbound.is_empty());
        assert!(ledger.sessions.is_empty());
    }

    #[test]
    fn save_then_load_returns_the_exact_ledger() {
        let mut connection = connection();
        let mut store = SqliteChannelLedgerStore::new(&mut connection).unwrap();
        let mut ledger = ChannelLedger::new();
        ledger.insert_session("account-a", "conv-1", "session-main");
        store.save(&ledger).unwrap();
        let restored = store.load().unwrap();
        assert_eq!(
            restored.session("account-a", "conv-1").map(String::as_str),
            Some("session-main")
        );
    }

    #[test]
    fn tampered_state_fails_closed() {
        let mut connection = connection();
        {
            let mut store = SqliteChannelLedgerStore::new(&mut connection).unwrap();
            let mut ledger = ChannelLedger::new();
            ledger.insert_session("account-a", "conv-1", "session-main");
            store.save(&ledger).unwrap();
        }
        // Flip a byte inside the stored canonical document.
        {
            let mut jcs = {
                let mut statement = connection
                    .prepare("SELECT state_jcs FROM channel_ledger_state WHERE singleton = 1")
                    .unwrap();
                statement
                    .query_row([], |row| row.get::<_, Vec<u8>>(0))
                    .unwrap()
            };
            jcs[0] ^= 0x01;
            connection
                .execute(
                    "UPDATE channel_ledger_state SET state_jcs = ?1 WHERE singleton = 1",
                    [&jcs],
                )
                .unwrap();
        }
        let error = {
            let mut store = SqliteChannelLedgerStore::new(&mut connection).unwrap();
            store.load().expect_err("tamper must fail closed")
        };
        assert_eq!(error.code, codes::LEDGER_CORRUPT);
    }
}
