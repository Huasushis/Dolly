//! Durable Channel store — the single per-event state machine (G4-C).
//!
//! One module-scoped SQLite connection owns the per-event [`ChannelIntent`]
//! rows and the owner-bound sent-echo markers. There is no parallel ledger
//! document: the accepted [`ChannelLedger`] / [`InboundEntry`] are an
//! in-memory projection built from the durable intents (with real
//! conversation/session/channel/sender/time/content/relation/target data) for
//! the accepted `process_event` dedup path, never a second source of truth. A
//! `prepared` intent is persisted before any Host submit or Core effect; after
//! a Host success the final terminal state is written as one atomic Channel DB
//! transaction, so a crash or failed final transaction leaves the row
//! `prepared` (reconcilable by `status`-first), never an
//! `accepted`-without-ledger inconsistency.
//!
//! The store is bound to the exact sealed [`ChannelPrincipal`] (all fence
//! facts, not the account hash alone) and verifies the DB meta against the
//! current principal on every open/use, so cross-module or cross-principal
//! reuse fails closed at the public receiver boundary.
//!
//! Every record is stored as canonical bytes; on read the store re-encodes,
//! recomputes the payload digest, the operation digest, the event key, the
//! account, the full-authority/ordered-target/content/relation digests and
//! the record digest, verifies the table key equals the record key, the meta
//! owner equality and the valid state/terminal/ledger invariants — so even a
//! self-consistent semantic tamper (fields edited and the outer hash
//! recomputed) fails closed.

use dolly_canonical_json::Sha256Digest;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::host_adapter::{channel_intent_digest, payload_digest_of};
use crate::intent::{CHANNEL_INTENT_RECORD_SCHEMA, ChannelIntent, IntentState};
use crate::ledger::{ChannelLedger, InboundEntry, InboundState};
use crate::principal::ChannelPrincipal;

/// The logical table holding the per-event intent rows.
const CHANNEL_INTENT_TABLE: &str = "channel_intent";
/// The logical table holding the store-owner binding.
const CHANNEL_OWNER_TABLE: &str = "channel_store_owner";
/// The logical table holding durable sent-transport echo markers.
const CHANNEL_ECHO_TABLE: &str = "channel_echo";

/// The schema discriminator stored in the owner singleton.
const CHANNEL_STORE_SCHEMA_DISCRIMINATOR: &str = "dolly.channel-store/v1";
/// The physical schema version of the Channel store.
const CHANNEL_STORE_SCHEMA_VERSION: i64 = 1;

#[cfg(feature = "test-support")]
/// The authoritative Channel store schema (owner singleton, intent table,
/// echo-marker table).
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
);
CREATE TABLE channel_echo (
    echo_key TEXT PRIMARY KEY NOT NULL,
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

pub(crate) const CHANNEL_ECHO_SCHEMA_SQL: &str = "CREATE TABLE channel_echo (
    echo_key TEXT PRIMARY KEY NOT NULL,
    record_digest TEXT NOT NULL,
    canonical_jcs BLOB NOT NULL
)";

const OWNER_COLUMNS: &[&str] = &["singleton", "schema_version", "schema_discriminator", "owner_jcs", "owner_digest"];
const INTENT_COLUMNS: &[&str] = &["intent_key", "record_digest", "canonical_jcs"];
const ECHO_COLUMNS: &[&str] = &["echo_key", "record_digest", "canonical_jcs"];

/// The sealed store ownership, derived only from a [`ChannelPrincipal`] and
/// carrying the COMPLETE principal fence facts. Constructed solely inside
/// this crate; a caller cannot fabricate one.
#[derive(PartialEq, Eq)]
pub(crate) struct StoreOwner {
    owner: String,
    extension_id: String,
    module_id: String,
    instance_id: String,
    generation: i64,
    revision: i64,
    graph_revision: i64,
    graph_digest: String,
    account: String,
}

impl StoreOwner {
    fn canonical_record(&self) -> serde_json::Value {
        serde_json::json!({
            "schema": "dolly.channel-store-owner/v1",
            "owner": self.owner,
            "extension_id": self.extension_id,
            "module_id": self.module_id,
            "instance_id": self.instance_id,
            "generation": self.generation,
            "revision": self.revision,
            "graph_revision": self.graph_revision,
            "graph_digest": self.graph_digest,
            "account": self.account,
        })
    }
}

impl From<&ChannelPrincipal> for StoreOwner {
    fn from(principal: &ChannelPrincipal) -> Self {
        Self {
            owner: principal.owner().to_string(),
            extension_id: principal.extension_id().to_string(),
            module_id: principal.module_id().to_string(),
            instance_id: principal.instance_id().to_string(),
            generation: principal.generation() as i64,
            revision: principal.revision(),
            graph_revision: principal.graph_revision(),
            graph_digest: principal.graph_digest().to_string(),
            account: principal.account().to_string(),
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
    verify_table(connection, CHANNEL_ECHO_TABLE, CHANNEL_ECHO_SCHEMA_SQL)?;
    verify_columns(connection, CHANNEL_OWNER_TABLE, OWNER_COLUMNS)?;
    verify_columns(connection, CHANNEL_INTENT_TABLE, INTENT_COLUMNS)?;
    verify_columns(connection, CHANNEL_ECHO_TABLE, ECHO_COLUMNS)
}

#[cfg(feature = "test-support")]
/// Create the Channel store schema. Test/internal only; production
/// registration owns schema installation.
pub fn create_channel_store_schema(connection: &mut Connection) -> Result<(), ChannelError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(map_sqlite)?;
    transaction.execute_batch(CHANNEL_STORE_SCHEMA_SQL).map_err(map_sqlite)?;
    transaction.commit().map_err(map_sqlite)?;
    gate_channel_store_schema(connection)
}

/// The durable Channel store over one verified, ownership-bound module-scoped
/// SQLite connection.
pub struct SqliteChannelStore<'connection> {
    connection: &'connection mut Connection,
    owner: StoreOwner,
    owner_digest: String,
    /// Test-support failpoints; zero (the default) in production.
    fail_write_prepared: u64,
    fail_commit_outcome: u64,
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
    pub fn new(
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
        Ok(Self { connection, owner, owner_digest, fail_write_prepared: 0, fail_commit_outcome: 0 })
    }

    #[cfg(feature = "test-support")]
    /// Test-support only: inject failures into the next `n` prepared writes.
    pub fn inject_write_prepared_failure(&mut self, n: u64) {
        self.fail_write_prepared = n;
    }

    #[cfg(feature = "test-support")]
    /// Test-support only: inject failures into the next `n` commit_outcome
    /// terminal transactions.
    pub fn inject_commit_outcome_failure(&mut self, n: u64) {
        self.fail_commit_outcome = n;
    }

    /// Verify the store is bound to the exact current principal (full fence
    /// facts). Used by the receiver test-support constructor to enforce
    /// store/principal equality.
    #[cfg(feature = "test-support")]
    pub(crate) fn verify_owner_against(&self, principal: &ChannelPrincipal) -> Result<(), ChannelError> {
        self.verify_owner_meta()?;
        let expected = StoreOwner::from(principal);
        if self.owner != expected {
            return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "channel store is bound to a different principal"));
        }
        Ok(())
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

    /// Full canonical/invariant verification of one loaded intent: re-encode
    /// and recompute the record digest; recompute the payload digest, the
    /// operation digest (binding full authority incl. graph digest, ordered
    /// targets, content, relation, config revision), the event key and the
    /// account; verify the table key == record key, the meta owner equality
    /// against the full bound principal, and the valid lifecycle/terminal
    /// invariants. A self-consistent semantic tamper (fields edited and the
    /// outer hash recomputed) is caught by the digest/key/owner re-derivation.
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
        // Recompute the content payload digest from the canonical draft.
        let recomputed_payload = payload_digest_of(&record.request_jcs);
        if recomputed_payload != record.payload_digest {
            return Err(corrupted("channel intent payload digest mismatch"));
        }
        // Recompute the operation digest binding full authority incl. graph
        // digest, ordered targets, content, relation, config revision.
        let recomputed_digest = channel_intent_digest(
            &record.account, &record.extension_id, &record.module_id, &record.instance_id,
            record.generation as u64, record.revision, record.graph_revision, &record.graph_digest,
            record.config_revision, &record.external_event_id, record.kind,
            record.references_external_event_id.as_deref(), &record.target_page_ids,
            &record.payload_digest,
        );
        if recomputed_digest != record.digest {
            return Err(corrupted("channel intent operation digest mismatch (semantic tamper)"));
        }
        // Full bound principal equality against the store owner.
        if record.owner != owner.owner
            || record.extension_id != owner.extension_id
            || record.module_id != owner.module_id
            || record.instance_id != owner.instance_id
            || record.generation != owner.generation
            || record.revision != owner.revision
            || record.graph_revision != owner.graph_revision
            || record.graph_digest != owner.graph_digest
            || record.account != owner.account
        {
            return Err(corrupted("channel intent record owner/meta does not match the bound principal"));
        }
        // Lifecycle/terminal invariants.
        match record.state {
            IntentState::Accepted => {
                if record.block_id.is_none() || record.rejected_code.is_some() {
                    return Err(corrupted("accepted channel intent lacks a block id or carries a rejection code"));
                }
            }
            IntentState::Rejected => {
                if record.rejected_code.is_none() || record.block_id.is_some() {
                    return Err(corrupted("rejected channel intent lacks a rejection code or carries a block id"));
                }
            }
            IntentState::Prepared => {
                if record.block_id.is_some() || record.rejected_code.is_some() {
                    return Err(corrupted("prepared channel intent already carries a terminal marker"));
                }
            }
        }
        // Relation invariant: edit/delete must name a reference; message must not.
        match record.kind {
            crate::ledger::EventKind::Edit | crate::ledger::EventKind::Delete => {
                if record.references_external_event_id.is_none() {
                    return Err(corrupted("edit/delete channel intent lacks a referenced event"));
                }
            }
            crate::ledger::EventKind::Message => {
                if record.references_external_event_id.is_some() {
                    return Err(corrupted("message channel intent carries a referenced event"));
                }
            }
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
    pub fn write_prepared(&mut self, intent: &ChannelIntent) -> Result<(), ChannelError> {
        if self.fail_write_prepared > 0 {
            self.fail_write_prepared -= 1;
            return Err(ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "injected prepared write failure"));
        }
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

    /// Atomically commit the terminal outcome in ONE Channel DB transaction.
    /// If this transaction fails, the durable row stays `prepared`
    /// (reconcilable by `status`-first), never `accepted`-without-ledger.
    pub fn commit_outcome(
        &mut self,
        intent_key: &str,
        accepted_block_id: Option<&str>,
        rejected_code: Option<&str>,
    ) -> Result<(), ChannelError> {
        if self.fail_commit_outcome > 0 {
            self.fail_commit_outcome -= 1;
            return Err(ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "injected commit_outcome failure"));
        }
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

    pub fn find_intent(&mut self, intent_key: &str) -> Result<Option<ChannelIntent>, ChannelError> {
        self.load_intent(intent_key)
    }

    /// Every non-terminal (`prepared`) intent, for status-first recovery.
    pub fn list_pending(&mut self) -> Result<Vec<ChannelIntent>, ChannelError> {
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
            Self::verify_intent(self.connection, &key, &record, &self.owner)?;
            if record.state == IntentState::Prepared {
                pending.push(record);
            }
        }
        Ok(pending)
    }

    /// Durably record a sent-transport echo marker (distinct from inbound
    /// event state: its only purpose is inbound-echo suppression). This is the
    /// write seam for the outbound registration side; the receiver only reads
    /// markers for suppression, and tests exercise durability.
    #[allow(dead_code)]
    pub fn record_echo(&mut self, account: &str, transport_message_id: &str) -> Result<(), ChannelError> {
        self.verify_owner_meta()?;
        let echo_key = format!("{account}\u{0}{transport_message_id}");
        let record = serde_json::json!({
            "schema": "dolly.channel-echo/v1",
            "account": account,
            "transport_message_id": transport_message_id,
        });
        let bytes = dolly_canonical_json::canonicalize(&record)
            .map_err(|e| corrupted(&format!("channel echo failed canonicalization: {e}")))?
            .0
            .as_bytes()
            .to_vec();
        let text = String::from_utf8(bytes).expect("canonical encoding is UTF-8");
        let digest = Sha256Digest::compute(text.as_bytes()).to_canonical_string();
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(map_sqlite)?;
        transaction
            .execute(
                "INSERT INTO channel_echo (echo_key, record_digest, canonical_jcs) VALUES (?1, ?2, ?3)
                 ON CONFLICT(echo_key) DO UPDATE SET record_digest = ?2, canonical_jcs = ?3",
                params![echo_key, digest, text.as_bytes()],
            )
            .map_err(map_sqlite)?;
        transaction.commit().map_err(map_sqlite)
    }

    /// Whether a sent-transport echo marker exists for the account+message id.
    #[allow(dead_code)]
    pub fn is_echo(&mut self, account: &str, transport_message_id: &str) -> Result<bool, ChannelError> {
        self.verify_owner_meta()?;
        let echo_key = format!("{account}\u{0}{transport_message_id}");
        let row: Option<(String, Vec<u8>)> = self
            .connection
            .query_row("SELECT record_digest, canonical_jcs FROM channel_echo WHERE echo_key = ?1", [&echo_key], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(map_sqlite)?;
        let Some((digest, jcs)) = row else { return Ok(false); };
        let computed = Sha256Digest::compute(&jcs).to_canonical_string();
        if computed != digest {
            return Err(corrupted("channel echo marker digest mismatch (tampered)"));
        }
        let text = std::str::from_utf8(&jcs).map_err(|_| corrupted("channel echo marker is not UTF-8"))?;
        let record: serde_json::Value = serde_json::from_str(text).map_err(|_| corrupted("channel echo marker is not a canonical record"))?;
        if record.get("account").and_then(serde_json::Value::as_str) != Some(account) {
            return Err(corrupted("channel echo marker account mismatch"));
        }
        Ok(true)
    }

    /// Every durable echo key, seeded into the ledger projection so
    /// `process_event` suppresses a matching inbound echo before Host/Core.
    fn list_echo_keys(&mut self) -> Result<Vec<String>, ChannelError> {
        self.verify_owner_meta()?;
        let mut statement = self.connection.prepare("SELECT echo_key FROM channel_echo ORDER BY echo_key").map_err(map_sqlite)?;
        let keys = statement.query_map([], |row| row.get::<_, String>(0)).map_err(map_sqlite)?.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)?;
        Ok(keys)
    }

    /// Build the in-memory [`ChannelLedger`] projection from the durable
    /// intents plus the durable echo markers, with real content facts. The
    /// accepted `process_event` dedup path uses this; it is never a second
    /// source of truth.
    pub(crate) fn project_ledger(&mut self) -> Result<ChannelLedger, ChannelError> {
        self.verify_owner_meta()?;
        let mut ledger = ChannelLedger::new();
        let rows: Vec<(String, String, Vec<u8>)> = {
            let mut statement = self.connection.prepare("SELECT intent_key, record_digest, canonical_jcs FROM channel_intent").map_err(map_sqlite)?;
            statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Vec<u8>>(2)?))).map_err(map_sqlite)?.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)?
        };
        for (key, digest, jcs) in rows {
            let computed = Sha256Digest::compute(&jcs).to_canonical_string();
            if computed != digest {
                return Err(corrupted("channel intent stored digest mismatch during projection"));
            }
            let text = std::str::from_utf8(&jcs).map_err(|_| corrupted("channel intent record is not UTF-8"))?;
            let record = ChannelIntent::from_canonical_string(text)?;
            Self::verify_intent(self.connection, &key, &record, &self.owner)?;
            if record.state == IntentState::Accepted || record.state == IntentState::Rejected {
                let state = match record.state {
                    IntentState::Accepted => InboundState::Accepted,
                    _ => InboundState::Rejected,
                };
                let entry = InboundEntry {
                    transport_account: record.account.clone(),
                    external_message_id: record.external_event_id.clone(),
                    references_external_message_id: record.references_external_event_id.clone(),
                    state,
                    event_kind: record.kind,
                    session_id: crate::ids::dolly_session_id(&record.account, &record.external_conversation_id),
                    external_conversation_id: record.external_conversation_id.clone(),
                    channel_id: record.channel_id.clone(),
                    sender_class: record.sender_class.clone(),
                    received_at: record.received_at.clone(),
                    ingress_key: record.intent_key.clone(),
                    operation_digest: record.digest.clone(),
                    block_id: record.block_id.clone(),
                    pages: record.target_page_ids.clone(),
                    config_revision: record.config_revision,
                    attempts: Vec::new(),
                    request_jcs: record.request_jcs.clone(),
                    rejected_code: record.rejected_code.clone(),
                };
                let _ = ledger.insert_inbound(entry, 4096);
            }
        }
        // Seed durable sent-transport echo markers for suppression (keys are
        // `{account} NUL {message_id}`, exactly the ledger's echo-key shape).
        for key in self.list_echo_keys()? {
            ledger.echoed_message_ids.insert(key);
        }
        Ok(ledger)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::CHANNEL_INTENT_RECORD_SCHEMA as SCHEMA;
    use crate::ledger::EventKind;

    fn principal() -> ChannelPrincipal {
        ChannelPrincipal::from_parts("owner-1", "org.dolly.channel", "receiver", "worker-1", 1, 1, 1, "digest-g")
    }

    fn connection() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        create_channel_store_schema(&mut connection).unwrap();
        connection
    }

    fn intent(key: &str, account: &str) -> ChannelIntent {
        ChannelIntent {
            schema: SCHEMA.to_string(),
            intent_key: key.to_string(),
            digest: "sha256:deadbeef".to_string(),
            state: IntentState::Prepared,
            owner: "owner-1".to_string(),
            extension_id: "org.dolly.channel".to_string(),
            module_id: "receiver".to_string(),
            instance_id: "worker-1".to_string(),
            generation: 1,
            revision: 1,
            graph_revision: 1,
            graph_digest: "digest-g".to_string(),
            config_revision: 1,
            account: account.to_string(),
            external_event_id: "msg-1".to_string(),
            channel_id: "web-primary".to_string(),
            transport: "web".to_string(),
            external_conversation_id: "conv-1".to_string(),
            sender_class: "user".to_string(),
            received_at: "2026-08-28T00:00:00.000000Z".to_string(),
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
            let store = SqliteChannelStore::new(&mut connection, &principal()).unwrap();
            drop(store);
        }
        let other = ChannelPrincipal::from_parts("owner-2", "org.dolly.channel", "receiver", "worker-1", 1, 1, 1, "digest-g");
        let error = SqliteChannelStore::new(&mut connection, &other).expect_err("cross-principal reuse");
        assert_eq!(error.code, codes::AUTHENTICATION_FAILED);
    }

    #[test]
    fn semantic_tamper_with_recomputed_hash_fails_closed() {
        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        let key = crate::ids::inbound_ingress_key(&account, "msg-1");
        {
            // Record a semantically valid intent (correct payload/digest/key).
            let mut intent = intent(&key, &account);
            intent.payload_digest = crate::host_adapter::payload_digest_of(&intent.request_jcs);
            intent.digest = crate::host_adapter::channel_intent_digest(
                &account, "org.dolly.channel", "receiver", "worker-1",
                1, 1, 1, "digest-g", 1, "msg-1", EventKind::Message, None,
                &["page-a".to_string()], &intent.payload_digest,
            );
            let mut store = SqliteChannelStore::new(&mut connection, &principal()).unwrap();
            store.write_prepared(&intent).unwrap();
        }
        // Semantic tamper: change target pages AND recompute the outer hash so
        // the record parses and its hash matches — verify_intent must still
        // fail because the operation digest no longer matches.
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal()).unwrap();
            let mut intent = store.find_intent(&key).unwrap().unwrap();
            intent.target_page_ids = vec!["page-b".to_string()];
            let canonical = intent.canonical_string().unwrap();
            let digest = Sha256Digest::compute(canonical.as_bytes()).to_canonical_string();
            connection
                .execute(
                    "UPDATE channel_intent SET record_digest = ?1, canonical_jcs = ?2 WHERE intent_key = ?3",
                    rusqlite::params![digest, canonical.as_bytes(), key],
                )
                .unwrap();
        }
        let mut store = SqliteChannelStore::new(&mut connection, &principal()).unwrap();
        let error = store.find_intent(&key).expect_err("semantic tamper must fail closed");
        assert_eq!(error.code, codes::LEDGER_CORRUPT);
    }

    #[test]
    fn echo_markers_survive_reopen() {
        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal()).unwrap();
            store.record_echo(&account, "transport-msg-1").unwrap();
            assert!(store.is_echo(&account, "transport-msg-1").unwrap());
        }
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal()).unwrap();
            assert!(store.is_echo(&account, "transport-msg-1").unwrap());
            assert!(!store.is_echo(&account, "other").unwrap());
            let ledger = store.project_ledger().unwrap();
            assert!(ledger.is_echo(&account, "transport-msg-1"));
        }
    }
}
