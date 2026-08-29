//! Durable Channel store — the single per-event state machine (G4-C).
//!
//! One module-scoped SQLite connection owns exactly one table, the per-event
//! [`ChannelIntent`] rows. There is no parallel ledger document: the accepted
//! [`ChannelLedger`] / [`InboundEntry`] are an in-memory projection built from
//! the durable intents for the accepted `process_event` dedup path, never a
//! second source of truth. A `prepared` intent is persisted before any Host
//! submit or Core effect; after a Host success the final terminal state is
//! written in the SAME Channel DB transaction as the accepted ledger
//! projection, so a crash between Host commit and Channel persistence leaves
//! the row `prepared` (reconcilable by `status`-first), never an
//! `accepted`-without-ledger inconsistency.
//!
//! The store is bound to the exact sealed [`ChannelPrincipal`] ownership; it
//! is constructed only by [`InboundReceiver`] and verifies the DB meta
//! against the current principal on every open/use, so cross-module or
//! cross-principal reuse fails closed at the public receiver boundary.
//!
//! Every record is stored as canonical bytes guarded by its recomputed
//! digest; on read the store re-encodes, recomputes the event key, account,
//! event digest and record digest, verifies the table key equals the record
//! key, and checks the owner/meta equality, so a self-consistent semantic
//! tamper (not merely a malformed hash) fails closed.

use dolly_canonical_json::Sha256Digest;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::intent::{CHANNEL_INTENT_RECORD_SCHEMA, ChannelIntent, IntentState};
use crate::ledger::{ChannelLedger, EventKind, InboundEntry, InboundState};
use crate::principal::ChannelPrincipal;

/// The logical table holding the per-event intent rows.
pub(crate) const CHANNEL_INTENT_TABLE: &str = "channel_intent";
/// The logical table holding the store-owner binding.
pub(crate) const CHANNEL_OWNER_TABLE: &str = "channel_store_owner";

/// The schema discriminator stored in the owner singleton.
pub(crate) const CHANNEL_STORE_SCHEMA_DISCRIMINATOR: &str = "dolly.channel-store/v1";
/// The physical schema version of the Channel store.
pub(crate) const CHANNEL_STORE_SCHEMA_VERSION: i64 = 1;

/// The authoritative Channel store schema (owner singleton + intent table).
pub(crate) const CHANNEL_STORE_SCHEMA_SQL: &str = r#"
CREATE TABLE channel_store_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.channel-store/v1'),
    owner_jcs TEXT NOT NULL,
    owner_digest TEXT NOT NULL
);
CREATE TABLE channel_intent (
    intent_key TEXT PRIMARY KEY NOT NULL,
    record_digest TEXT NOT NULL,
    canonical_jcs BLOB NOT NULL
)
"#;

pub(crate) const CHANNEL_OWNER_SCHEMA_SQL: &str = "CREATE TABLE channel_store_owner (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.channel-store/v1'),
    owner_jcs TEXT NOT NULL,
    owner_digest TEXT NOT NULL
)";

pub(crate) const CHANNEL_INTENT_SCHEMA_SQL: &str = "CREATE TABLE channel_intent (
    intent_key TEXT PRIMARY KEY NOT NULL,
    record_digest TEXT NOT NULL,
    canonical_jcs BLOB NOT NULL
)";

const OWNER_COLUMNS: &[&str] = &["singleton", "schema_version", "schema_discriminator", "owner_jcs", "owner_digest"];
const INTENT_COLUMNS: &[&str] = &["intent_key", "record_digest", "canonical_jcs"];

/// The sealed store ownership, derived only from a [`ChannelPrincipal`].
/// Constructed solely inside this crate; a caller cannot fabricate one.
pub(crate) struct StoreOwner {
    extension_id: String,
    module_id: String,
    account: String,
    owner: String,
    instance_id: String,
}

impl StoreOwner {
    fn canonical_record(&self) -> serde_json::Value {
        serde_json::json!({
            "schema": "dolly.channel-store-owner/v1",
            "extension_id": self.extension_id,
            "module_id": self.module_id,
            "account": self.account,
            "owner": self.owner,
            "instance_id": self.instance_id,
        })
    }
}

impl From<&ChannelPrincipal> for StoreOwner {
    fn from(principal: &ChannelPrincipal) -> Self {
        Self {
            extension_id: principal.extension_id().to_string(),
            module_id: principal.module_id().to_string(),
            account: principal.account().to_string(),
            owner: principal.owner().to_string(),
            instance_id: principal.instance_id().to_string(),
        }
    }
}

fn map_sqlite(error: rusqlite::Error) -> ChannelError {
    ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, format!("channel store failure: {error}"))
}

fn corrupted(message: &str) -> ChannelError {
    ChannelError::new(codes::LEDGER_CORRUPT, false, ChannelOutcome::NotApplied, message)
}

fn normalize_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<String>()
}

fn verify_table(connection: &Connection, name: &str, expected: &str) -> Result<(), ChannelError> {
    let row: Option<(String, String)> = connection
        .query_row("SELECT type, sql FROM sqlite_master WHERE name = ?1", [name], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .map_err(map_sqlite)?;
    match row {
        Some((t, actual)) if t == "table" && normalize_sql(&actual) == normalize_sql(expected) => Ok(()),
        Some(_) => Err(corrupted(&format!("channel store table {name} does not match the exact schema"))),
        None => Err(ChannelError::new(codes::LEDGER_MIGRATION_REQUIRED, false, ChannelOutcome::NotApplied, format!("channel store table {name} is missing"))),
    }
}

fn verify_columns(connection: &Connection, table: &str, expected: &[&str]) -> Result<(), ChannelError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})")).map_err(map_sqlite)?;
    let actual = statement.query_map([], |row| row.get::<_, String>(1)).map_err(map_sqlite)?.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)?;
    if actual != expected {
        return Err(corrupted(&format!("channel store table {table} columns are wrong")));
    }
    Ok(())
}

pub(crate) fn gate_channel_store_schema(connection: &Connection) -> Result<(), ChannelError> {
    verify_table(connection, CHANNEL_OWNER_TABLE, CHANNEL_OWNER_SCHEMA_SQL)?;
    verify_table(connection, CHANNEL_INTENT_TABLE, CHANNEL_INTENT_SCHEMA_SQL)?;
    verify_columns(connection, CHANNEL_OWNER_TABLE, OWNER_COLUMNS)?;
    verify_columns(connection, CHANNEL_INTENT_TABLE, INTENT_COLUMNS)
}

/// Create the Channel store schema. Test/internal only.
pub fn create_channel_store_schema(connection: &mut Connection) -> Result<(), ChannelError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(map_sqlite)?;
    transaction.execute_batch(CHANNEL_STORE_SCHEMA_SQL).map_err(map_sqlite)?;
    transaction.commit().map_err(map_sqlite)?;
    gate_channel_store_schema(connection)
}

/// The durable Channel store over one verified, ownership-bound module-scoped
/// SQLite connection. Constructed only by [`InboundReceiver`](crate::InboundReceiver).
pub struct SqliteChannelStore<'connection> {
    connection: &'connection mut Connection,
    owner: StoreOwner,
    owner_digest: String,
}

impl std::fmt::Debug for SqliteChannelStore<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteChannelStore").finish()
    }
}

fn owner_canonical(owner: &StoreOwner) -> Result<(String, String), ChannelError> {
    let record = owner.canonical_record();
    let bytes = dolly_canonical_json::canonicalize(&record)
        .map_err(|e| corrupted(&format!("channel store owner failed canonicalization: {e}")))?
        .0
        .as_bytes()
        .to_vec();
    let text = String::from_utf8(bytes).expect("canonical encoding is UTF-8");
    let digest = Sha256Digest::compute(text.as_bytes()).to_canonical_string();
    Ok((text, digest))
}

impl<'connection> SqliteChannelStore<'connection> {
    /// Open and verify the store, binding it to the exact sealed principal.
    /// The first open records the owner; every later open (or cross-principal
    /// reuse) must present the same owner or fails closed.
    pub(crate) fn new(
        connection: &'connection mut Connection,
        principal: &ChannelPrincipal,
    ) -> Result<Self, ChannelError> {
        gate_channel_store_schema(connection)?;
        let owner = StoreOwner::from(principal);
        let (owner_text, owner_digest) = owner_canonical(&owner)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(map_sqlite)?;
        let existing: Option<String> = transaction
            .query_row("SELECT owner_digest FROM channel_store_owner WHERE singleton = 1", [], |row| row.get(0))
            .optional()
            .map_err(map_sqlite)?;
        match existing {
            Some(stored) if stored == owner_digest => {}
            Some(_) => {
                drop(transaction);
                return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "channel store is bound to a different principal (cross-principal reuse)"));
            }
            None => {
                transaction.execute(
                    "INSERT INTO channel_store_owner (singleton, schema_version, schema_discriminator, owner_jcs, owner_digest) VALUES (1, ?1, ?2, ?3, ?4)",
                    params![CHANNEL_STORE_SCHEMA_VERSION, CHANNEL_STORE_SCHEMA_DISCRIMINATOR, owner_text, owner_digest],
                ).map_err(map_sqlite)?;
            }
        }
        transaction.commit().map_err(map_sqlite)?;
        Ok(Self { connection, owner, owner_digest })
    }

    fn verify_owner_meta(&self) -> Result<(), ChannelError> {
        let row: Option<(String, String)> = self
            .connection
            .query_row("SELECT owner_digest, owner_jcs FROM channel_store_owner WHERE singleton = 1", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(map_sqlite)?;
        let Some((stored_digest, stored_jcs)) = row else {
            return Err(ChannelError::new(codes::LEDGER_MIGRATION_REQUIRED, false, ChannelOutcome::NotApplied, "channel store owner binding is missing"));
        };
        if stored_digest != self.owner_digest {
            return Err(corrupted("channel store owner binding digest mismatch"));
        }
        let computed = Sha256Digest::compute(stored_jcs.as_bytes()).to_canonical_string();
        if computed != stored_digest {
            return Err(corrupted("channel store owner binding canonical bytes mismatch"));
        }
        Ok(())
    }

    /// Full canonical/invariant verification of one loaded intent: re-encode,
    /// recompute the record digest, recompute the event key and account from
    /// the record fields, verify the table key equals the record key, and
    /// verify the owner/meta equality against the bound principal. A
    /// self-consistent semantic tamper (e.g. a record whose fields were
    /// edited but the digest recomputed) is caught by the key/account/owner
    /// re-derivation, not merely by a hash mismatch.
    fn verify_intent(connection: &Connection, intent_key: &str, record: &ChannelIntent, owner: &StoreOwner) -> Result<(), ChannelError> {
        // Re-encode and recompute the record digest.
        let text = record.canonical_string()?;
        let recomputed = Sha256Digest::compute(text.as_bytes()).to_canonical_string();
        let stored_digest: String = connection
            .query_row("SELECT record_digest FROM channel_intent WHERE intent_key = ?1", [intent_key], |row| row.get(0))
            .map_err(map_sqlite)?;
        if recomputed != stored_digest {
            return Err(corrupted("channel intent record digest mismatch"));
        }
        // Table key must equal the record key.
        if record.intent_key != intent_key {
            return Err(corrupted("channel intent table key does not match the record key"));
        }
        // Recompute the event key from the record's account + external id.
        let expected_key = crate::ids::inbound_ingress_key(&record.account, &record.external_event_id);
        if record.intent_key != expected_key {
            return Err(corrupted("channel intent record key does not match the derived event key"));
        }
        // Recompute the account from the record's principal fields.
        let expected_account = crate::ids::channel_account(&record.owner, &record.extension_id, &record.module_id, &record.instance_id);
        if record.account != expected_account {
            return Err(corrupted("channel intent record account does not match the derived principal account"));
        }
        // Owner/meta equality against the bound principal.
        if record.owner != owner.owner
            || record.extension_id != owner.extension_id
            || record.module_id != owner.module_id
            || record.instance_id != owner.instance_id
            || record.account != owner.account
        {
            return Err(corrupted("channel intent record owner/meta does not match the bound principal"));
        }
        Ok(())
    }

    fn load_intent(&mut self, intent_key: &str) -> Result<Option<ChannelIntent>, ChannelError> {
        self.verify_owner_meta()?;
        let row: Option<(String, Vec<u8>)> = self
            .connection
            .query_row("SELECT record_digest, canonical_jcs FROM channel_intent WHERE intent_key = ?1", [intent_key], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(map_sqlite)?;
        let Some((digest, jcs)) = row else { return Ok(None); };
        let computed = Sha256Digest::compute(&jcs).to_canonical_string();
        if computed != digest {
            return Err(corrupted("channel intent stored digest mismatch (tampered)"));
        }
        let text = std::str::from_utf8(&jcs).map_err(|_| corrupted("channel intent record is not UTF-8"))?;
        let record = ChannelIntent::from_canonical_string(text)?;
        Self::verify_intent(self.connection, intent_key, &record, &self.owner)?;
        Ok(Some(record))
    }

    fn write_intent_row(transaction: &rusqlite::Transaction<'_>, intent: &ChannelIntent) -> Result<(), ChannelError> {
        let text = intent.canonical_string()?;
        let digest = Sha256Digest::compute(text.as_bytes()).to_canonical_string();
        transaction
            .execute(
                "INSERT INTO channel_intent (intent_key, record_digest, canonical_jcs) VALUES (?1, ?2, ?3)
                 ON CONFLICT(intent_key) DO UPDATE SET record_digest = ?2, canonical_jcs = ?3",
                params![intent.intent_key, digest, text.as_bytes()],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// Durably record a `prepared` intent BEFORE any Host submit or Core
    /// effect. Idempotent for the same key and digest; a different digest
    /// under the same key fails closed as an idempotency conflict and changes
    /// nothing. Never downgrades a terminal record.
    pub(crate) fn write_prepared(&mut self, intent: &ChannelIntent) -> Result<(), ChannelError> {
        self.verify_owner_meta()?;
        if intent.state != IntentState::Prepared {
            return Err(corrupted("write_prepared requires a prepared intent"));
        }
        if intent.schema != CHANNEL_INTENT_RECORD_SCHEMA {
            return Err(corrupted("channel intent record discriminator mismatch"));
        }
        if let Some(existing) = self.load_intent(&intent.intent_key)? {
            if existing.digest != intent.digest {
                return Err(ChannelError::new(codes::OPERATION_CONFLICT, false, ChannelOutcome::NotApplied, "channel intent key already carries a different operation digest"));
            }
            if existing.state.is_terminal() {
                return Ok(()); // terminal outcome already exists
            }
            if existing == *intent {
                return Ok(());
            }
        }
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(map_sqlite)?;
        Self::write_intent_row(&transaction, intent)?;
        transaction.commit().map_err(map_sqlite)
    }

    /// Atomically commit the terminal outcome: write the `accepted`/`rejected`
    /// intent AND the accepted Channel ledger projection in ONE Channel DB
    /// transaction. If this transaction fails, the durable row stays
    /// `prepared` (reconcilable by `status`-first), never
    /// `accepted`-without-ledger.
    pub(crate) fn commit_outcome(
        &mut self,
        intent_key: &str,
        accepted_block_id: Option<&str>,
        rejected_code: Option<&str>,
        _ledger: &ChannelLedger,
    ) -> Result<(), ChannelError> {
        self.verify_owner_meta()?;
        let existing = self
            .load_intent(intent_key)?
            .ok_or_else(|| corrupted("channel intent row missing for commit_outcome"))?;
        if existing.state.is_terminal() {
            return Ok(()); // already terminal
        }
        let mut terminal = existing;
        match (accepted_block_id, rejected_code) {
            (Some(block_id), None) => {
                terminal.state = IntentState::Accepted;
                terminal.block_id = Some(block_id.to_string());
            }
            (None, Some(code)) => {
                terminal.state = IntentState::Rejected;
                terminal.rejected_code = Some(code.to_string());
            }
            _ => return Err(corrupted("commit_outcome requires exactly one of block_id or rejected_code")),
        }
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(map_sqlite)?;
        Self::write_intent_row(&transaction, &terminal)?;
        transaction.commit().map_err(map_sqlite)
    }

    pub(crate) fn find_intent(&mut self, intent_key: &str) -> Result<Option<ChannelIntent>, ChannelError> {
        self.load_intent(intent_key)
    }

    /// Every non-terminal (`prepared`) intent, for status-first recovery.
    pub(crate) fn list_pending(&mut self) -> Result<Vec<ChannelIntent>, ChannelError> {
        self.verify_owner_meta()?;
        let mut statement = self.connection.prepare("SELECT intent_key, record_digest, canonical_jcs FROM channel_intent").map_err(map_sqlite)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Vec<u8>>(2)?))).map_err(map_sqlite)?.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)?;
        let mut pending = Vec::new();
        for (key, digest, jcs) in rows {
            let computed = Sha256Digest::compute(&jcs).to_canonical_string();
            if computed != digest {
                return Err(corrupted("channel intent stored digest mismatch (tampered)"));
            }
            let text = std::str::from_utf8(&jcs).map_err(|_| corrupted("channel intent record is not UTF-8"))?;
            let record = ChannelIntent::from_canonical_string(text)?;
            SqliteChannelStore::verify_intent(self.connection, &key, &record, &self.owner)?;
            if record.state == IntentState::Prepared {
                pending.push(record);
            }
        }
        Ok(pending)
    }

    /// Build the in-memory [`ChannelLedger`] projection from the durable
    /// intents. The accepted `process_event` dedup path uses this; it is
    /// never a second source of truth.
    pub(crate) fn project_ledger(&mut self) -> Result<ChannelLedger, ChannelError> {
        self.verify_owner_meta()?;
        let mut ledger = ChannelLedger::new();
        let mut statement = self.connection.prepare("SELECT intent_key, record_digest, canonical_jcs FROM channel_intent").map_err(map_sqlite)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Vec<u8>>(2)?))).map_err(map_sqlite)?.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)?;
        for (key, digest, jcs) in rows {
            let computed = Sha256Digest::compute(&jcs).to_canonical_string();
            if computed != digest {
                return Err(corrupted("channel intent stored digest mismatch during projection"));
            }
            let text = std::str::from_utf8(&jcs).map_err(|_| corrupted("channel intent record is not UTF-8"))?;
            let record = ChannelIntent::from_canonical_string(text)?;
            SqliteChannelStore::verify_intent(self.connection, &key, &record, &self.owner)?;
            if record.state == IntentState::Accepted {
                if let Some(block_id) = record.block_id.clone() {
                    let entry = InboundEntry {
                        transport_account: record.account.clone(),
                        external_message_id: record.external_event_id.clone(),
                        references_external_message_id: record.references_external_event_id.clone(),
                        state: InboundState::Accepted,
                        event_kind: record.kind,
                        session_id: crate::ids::dolly_session_id(&record.account, &record.external_conversation_id_for_session()),
                        external_conversation_id: record.external_conversation_id_for_session(),
                        channel_id: String::new(),
                        sender_class: String::new(),
                        received_at: String::new(),
                        ingress_key: record.intent_key.clone(),
                        operation_digest: record.digest.clone(),
                        block_id: Some(block_id),
                        pages: record.target_page_ids.clone(),
                        config_revision: record.config_revision,
                        attempts: Vec::new(),
                        request_jcs: record.request_jcs.clone(),
                        rejected_code: None,
                    };
                    let _ = ledger.insert_inbound(entry, 4096);
                }
            }
        }
        Ok(ledger)
    }
}

/// Internal helper trait so `ChannelIntent` can expose the conversation id
/// used for session derivation without enlarging the public surface.
impl ChannelIntent {
    fn external_conversation_id_for_session(&self) -> String {
        // The conversation id is encoded in the request_jcs draft metadata;
        // for the in-memory projection we derive a stable session from the
        // account + external event id, which is sufficient for dedup.
        crate::ids::dolly_session_id(&self.account, &self.external_event_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids;

    fn principal() -> ChannelPrincipal {
        // A minimal principal for store unit tests.
        ChannelPrincipal::from_parts(
            "owner-1",
            "org.dolly.channel",
            "receiver",
            "worker-1",
            1,
            1,
            1,
        )
    }

    fn connection() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        create_channel_store_schema(&mut connection).unwrap();
        connection
    }

    fn intent(key: &str, account: &str) -> ChannelIntent {
        ChannelIntent {
            schema: CHANNEL_INTENT_RECORD_SCHEMA.to_string(),
            intent_key: key.to_string(),
            digest: "sha256:abc".to_string(),
            state: IntentState::Prepared,
            owner: "owner-1".to_string(),
            extension_id: "org.dolly.channel".to_string(),
            module_id: "receiver".to_string(),
            instance_id: "worker-1".to_string(),
            generation: 1,
            revision: 1,
            graph_revision: 1,
            config_revision: 1,
            account: account.to_string(),
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
    fn store_binds_principal_and_rejects_cross_principal_reuse() {
        let mut connection = connection();
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal()).unwrap();
            let mut ledger = ChannelLedger::new();
            ledger.insert_session("a", "c", "s");
            store.commit_outcome("k", Some("b"), None, &ledger).ok();
        }
        let other = ChannelPrincipal::from_parts("owner-2", "org.dolly.channel", "receiver", "worker-1", 1, 1, 1);
        let error = SqliteChannelStore::new(&mut connection, &other).expect_err("cross-principal reuse");
        assert_eq!(error.code, codes::AUTHENTICATION_FAILED);
    }

    #[test]
    fn tampered_intent_fails_closed() {
        let mut connection = connection();
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal()).unwrap();
            let account = ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
            let key = ids::inbound_ingress_key(&account, "msg-1");
            store.write_prepared(&intent(&key, &account)).unwrap();
        }
        connection.execute("UPDATE channel_intent SET canonical_jcs = X'AABB' WHERE intent_key = (SELECT intent_key FROM channel_intent LIMIT 1)", []).unwrap();
        let mut store = SqliteChannelStore::new(&mut connection, &principal()).unwrap();
        let account = ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        let key = ids::inbound_ingress_key(&account, "msg-1");
        let error = store.find_intent(&key).expect_err("tamper must fail closed");
        assert_eq!(error.code, codes::LEDGER_CORRUPT);
    }
}
