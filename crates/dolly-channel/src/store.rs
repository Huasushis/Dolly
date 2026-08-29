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

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::error::{ChannelError, ChannelOutcome, codes};
use crate::host_adapter::{channel_facts_from_draft, channel_intent_digest, payload_digest_of};
use crate::intent::{CHANNEL_INTENT_RECORD_SCHEMA, ChannelIntent, IntentState};
use crate::ledger::{
    AttemptRecord, ChannelLedger, EventKind, InboundEntry, InboundState, OutboundEntry,
    OutboundState, PieceOutcome,
};
use crate::principal::ChannelPrincipal;

/// Derive the content facts from the canonical draft (`request_jcs`) — the
/// single source of content truth. Projection fields and digest inputs are
/// re-derived here and compared, never trusted from divergent stored copies.
fn derive_draft_facts(intent: &ChannelIntent) -> Result<crate::host_adapter::ChannelDraftFacts, ChannelError> {
    let parsed = serde_json::from_str::<serde_json::Value>(&intent.request_jcs)
        .map_err(|_| corrupted("channel intent draft is not JSON"))?;
    let draft = dolly_canonical_json::CanonicalJsonValue::try_from(parsed)
        .map_err(|_| corrupted("channel intent draft is not canonical JSON"))?;
    channel_facts_from_draft(&draft).map_err(|_| corrupted("channel intent draft metadata is malformed"))
}

/// The exact top-level fields the accepted draft builder emits.
const DRAFT_ROOT_KEYS: &[&str] = &["schema", "parts", "actions", "metadata"];
/// The exact metadata namespaces the accepted draft builder emits.
const DRAFT_NAMESPACE_KEYS: &[&str] = &["org.dolly.channel"];
/// The exact channel-metadata fields the accepted draft builder emits.
const CHANNEL_METADATA_KEYS: &[&str] = &[
    "channel_id", "transport", "session_id", "external_conversation_id",
    "external_message_id", "sender_class", "received_at", "event_kind",
    "references_external_message_id",
];
/// Channel metadata fields REQUIRED by the draft builder (all non-empty
/// strings); `references_external_message_id` is the only optional field.
const CHANNEL_REQUIRED_KEYS: &[&str] = &[
    "channel_id", "transport", "session_id", "external_conversation_id",
    "external_message_id", "sender_class", "received_at", "event_kind",
];

/// Strict canonical verification of the stored draft (`request_jcs`): it must
/// parse as Dolly-core canonical JSON, re-encode byte-identically, and carry
/// exactly the known top-level and channel-metadata key sets. A rehashed
/// noncanonical or unknown-field draft fails closed.
fn verify_draft_canonical(intent: &ChannelIntent) -> Result<(), ChannelError> {
    let parsed = dolly_canonical_json::parse_core_json(
        intent.request_jcs.as_bytes(),
        dolly_canonical_json::ParseLimits::protocol_wire(),
    )
    .map_err(|_| corrupted("channel intent draft is not canonical JSON"))?;
    let recanon = dolly_canonical_json::canonicalize(&parsed)
        .map_err(|_| corrupted("channel intent draft failed canonical re-encoding"))?
        .0
        .as_bytes()
        .to_vec();
    if recanon != intent.request_jcs.as_bytes() {
        return Err(corrupted("channel intent draft is not canonically encoded"));
    }
    // ---- Exact authoritative `dolly.block-draft/v1` shape ----
    // 1. Top level: required {schema, parts, actions, metadata} only, with the
    //    required types and the exact schema tag.
    let CanonicalJsonValue::Object(root) = &parsed else {
        return Err(corrupted("channel intent draft is not an object"));
    };
    for key in root.iter().map(|(k, _)| k) {
        if !DRAFT_ROOT_KEYS.contains(&key) {
            return Err(corrupted("channel intent draft carries an unknown top-level field"));
        }
    }
    for key in DRAFT_ROOT_KEYS {
        if root.get(key).is_none() {
            return Err(corrupted(&format!("channel intent draft lacks required top-level field {key}")));
        }
    }
    match root.get("schema") {
        Some(CanonicalJsonValue::String(tag)) if tag == crate::ingress::BLOCK_DRAFT_SCHEMA_TAG => {}
        _ => return Err(corrupted("channel intent draft schema must equal dolly.block-draft/v1")),
    }
    if !matches!(root.get("parts"), Some(CanonicalJsonValue::Array(_))) {
        return Err(corrupted("channel intent draft parts must be an array"));
    }
    if !matches!(root.get("actions"), Some(CanonicalJsonValue::Array(_))) {
        return Err(corrupted("channel intent draft actions must be an array"));
    }
    // 2. Metadata namespaces: exactly `org.dolly.channel`.
    let Some(CanonicalJsonValue::Object(metadata)) = root.get("metadata") else {
        return Err(corrupted("channel intent draft metadata must be an object"));
    };
    for key in metadata.iter().map(|(k, _)| k) {
        if !DRAFT_NAMESPACE_KEYS.contains(&key) {
            return Err(corrupted("channel intent draft carries an unknown metadata namespace"));
        }
    }
    // 3. Channel metadata: every spec-required field present with the correct
    //    type (non-empty strings used by the lossless projection), no unknown
    //    fields; the edit/delete reference is the only optional field.
    let Some(CanonicalJsonValue::Object(channel)) = metadata.get("org.dolly.channel") else {
        return Err(corrupted("channel intent draft lacks the channel metadata namespace"));
    };
    for key in channel.iter().map(|(k, _)| k) {
        if !CHANNEL_METADATA_KEYS.contains(&key) {
            return Err(corrupted("channel intent draft carries an unknown metadata field"));
        }
    }
    for key in CHANNEL_REQUIRED_KEYS {
        if channel.get(key).is_none() {
            return Err(corrupted(&format!("channel metadata lacks required field {key}")));
        }
        if !matches!(channel.get(key), Some(CanonicalJsonValue::String(value)) if !value.is_empty()) {
            return Err(corrupted(&format!("channel metadata field {key} must be a non-empty string")));
        }
    }
    if let Some(references) = channel.get("references_external_message_id") {
        // If present it must be a nonempty valid external identity string; a
        // present empty/invalid value is rejected, never normalized to None.
        match references {
            CanonicalJsonValue::String(value) if !value.is_empty() && value.len() <= crate::ingress::MAX_EXTERNAL_ID_BYTES
                && !value.chars().any(|c| c.is_control()) => {}
            _ => return Err(corrupted("channel metadata references_external_message_id must be a nonempty valid external identity")),
        }
    }
    // Exact relation shape consistent with the accepted builder: a message
    // must not carry a reference; edit/delete must carry a nonempty reference.
    let kind = match channel_text_value(channel, "event_kind") {
        Some(kind) => kind,
        None => return Err(corrupted("channel metadata lacks event_kind")),
    };
    let has_reference = channel.get("references_external_message_id").is_some();
    match kind {
        "message" => {
            if has_reference {
                return Err(corrupted("message draft must not carry a reference"));
            }
        }
        "edit" | "delete" => {
            if !has_reference {
                return Err(corrupted("edit/delete draft must carry a nonempty reference"));
            }
        }
        _ => return Err(corrupted("channel metadata event_kind is invalid")),
    }
    Ok(())
}

fn channel_text_value<'a>(
    channel: &'a dolly_canonical_json::CanonicalJsonObject,
    field: &str,
) -> Option<&'a str> {
    match channel.get(field) {
        Some(CanonicalJsonValue::String(value)) if !value.is_empty() => Some(value),
        _ => None,
    }
}

fn facts_event_kind(facts: &crate::host_adapter::ChannelDraftFacts) -> EventKind {
    match facts.kind {
        dolly_core_domain::HostIngressKind::Message => EventKind::Message,
        dolly_core_domain::HostIngressKind::Edit => EventKind::Edit,
        dolly_core_domain::HostIngressKind::Delete => EventKind::Delete,
    }
}

/// The logical table holding the per-event intent rows.
const CHANNEL_INTENT_TABLE: &str = "channel_intent";
/// The logical table holding the store-owner binding.
const CHANNEL_OWNER_TABLE: &str = "channel_store_owner";
/// The logical table holding durable sent-transport echo markers.
const CHANNEL_ECHO_TABLE: &str = "channel_echo";

/// The closed schema discriminator of one Channel echo marker.
const ECHO_RECORD_SCHEMA: &str = "dolly.channel-echo/v1";

/// The strict canonical echo-marker record. `deny_unknown_fields` rejects any
/// unknown or forged field; the full sealed principal facts are carried and
/// verified against the bound store owner.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EchoRecord {
    schema: String,
    version: i64,
    owner: String,
    extension_id: String,
    module_id: String,
    instance_id: String,
    generation: i64,
    revision: i64,
    graph_revision: i64,
    graph_digest: String,
    config_revision: i64,
    account: String,
    transport_event_id: String,
    echo_key: String,
}

/// The logical table holding the durable outbound records (single durable
/// source of truth for the committed targeted-Action outbound pipeline).
const CHANNEL_OUTBOUND_TABLE: &str = "channel_outbound";

/// The closed schema discriminator of one durable `Prepared` outbound record.
pub(crate) const OUTBOUND_RECORD_SCHEMA: &str = "dolly.channel-outbound/v1";

/// The result of persisting the durable `Prepared` outbound row for one
/// committed action key (`action_id`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutboundPreparedOutcome {
    /// A fresh Prepared row was durably persisted (key+digest not seen).
    Prepared,
    /// An identical (same key, same operation digest) non-terminal row
    /// already exists (crash re-entry); it is the surviving authority and was
    /// NOT overwritten or downgraded.
    PreparedExisting,
    /// A terminal row already exists for this key+digest: the exact frozen
    /// result MUST be returned with zero re-dispatch.
    ReplayTerminal {
        state: OutboundState,
        result_jcs: String,
    },
}

/// The result of the atomic Prepared/Queued -> Dispatched CAS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchClaim {
    /// This caller won the CAS: the row is now `Dispatched` and this caller
    /// is the ONLY one authorized to call the transport. The returned record
    /// is the verified durable Dispatched row.
    Won(DurableOutboundRecord),
    /// Another concurrent claimant already won the CAS (or the row changed
    /// between load and CAS). This caller MUST NOT call the transport.
    LostRace,
    /// The row was already `Dispatched` by a prior pass (crash re-entry after
    /// the marker but before the transport). This caller MUST NOT transport
    /// and MUST status-first reconcile.
    AlreadyDispatched,
    /// The row is already terminal (a prior pass settled it). The frozen
    /// result MUST be returned with zero re-dispatch.
    AlreadyTerminal {
        state: OutboundState,
        result_jcs: Option<String>,
    },
}

/// The strict canonical durable outbound record: the complete sealed
/// principal fence facts, the canonical committed Action bytes, the
/// authority-bound operation digest, and the accepted [`OutboundEntry`]
/// working state. `deny_unknown_fields` rejects any unknown or forged field;
/// every field is re-verified against the bound store owner on read.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DurableOutboundRecord {
    pub schema: String,
    pub version: i64,
    /// The durable row key: the committed Action's `action_id`.
    pub outbound_key: String,
    /// Authority-bound operation digest (fences + target + canonical Action +
    /// exact Manifest coordinates).
    pub digest: String,
    /// The canonical committed `org.dolly.channel.send` Action bytes.
    pub action_jcs: String,
    /// The Activation whose persisted manifest selected the input.
    pub activation_id: String,
    /// Deterministic digest of the frozen manifest bytes.
    pub manifest_digest: String,
    /// The input item's index in Manifest Delivery order.
    pub input_index: usize,
    /// The send Action's index within the frozen Block's `body.actions`.
    pub action_index: usize,
    /// The committed Block that delivered the Action.
    pub block_id: String,
    /// The exactly targeted module of the committed Action.
    pub target_module_id: String,
    pub owner: String,
    pub extension_id: String,
    pub module_id: String,
    pub instance_id: String,
    pub generation: i64,
    pub revision: i64,
    pub graph_revision: i64,
    pub graph_digest: String,
    pub config_revision: i64,
    pub account: String,
    /// The accepted outbound ledger working state.
    pub entry: OutboundEntry,
}

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
);
CREATE TABLE channel_outbound (
    outbound_key TEXT PRIMARY KEY NOT NULL,
    record_digest TEXT NOT NULL,
    canonical_jcs BLOB NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared','queued','dispatched','confirmed','partial','failed','unknown')),
    session_id TEXT NOT NULL,
    queued_seq INTEGER
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

pub(crate) const CHANNEL_OUTBOUND_SCHEMA_SQL: &str = "CREATE TABLE channel_outbound (
    outbound_key TEXT PRIMARY KEY NOT NULL,
    record_digest TEXT NOT NULL,
    canonical_jcs BLOB NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared','queued','dispatched','confirmed','partial','failed','unknown')),
    session_id TEXT NOT NULL,
    queued_seq INTEGER
)";

const OWNER_COLUMNS: &[&str] = &["singleton", "schema_version", "schema_discriminator", "owner_jcs", "owner_digest"];
const INTENT_COLUMNS: &[&str] = &["intent_key", "record_digest", "canonical_jcs"];
const ECHO_COLUMNS: &[&str] = &["echo_key", "record_digest", "canonical_jcs"];
const OUTBOUND_COLUMNS: &[&str] = &["outbound_key", "record_digest", "canonical_jcs", "state", "session_id", "queued_seq"];

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
    config_revision: i64,
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
            "config_revision": self.config_revision,
            "account": self.account,
        })
    }
}

struct StoreOwnerBinding {
    principal: ChannelPrincipal,
    config_revision: i64,
}

/// Derive the store owner from the sealed principal and the current config
/// revision; the config fence is part of the store principal binding.
impl From<StoreOwnerBinding> for StoreOwner {
    fn from(binding: StoreOwnerBinding) -> Self {
        let principal = &binding.principal;
        Self {
            owner: principal.owner().to_string(),
            extension_id: principal.extension_id().to_string(),
            module_id: principal.module_id().to_string(),
            instance_id: principal.instance_id().to_string(),
            generation: principal.generation() as i64,
            revision: principal.revision(),
            graph_revision: principal.graph_revision(),
            graph_digest: principal.graph_digest().to_string(),
            config_revision: binding.config_revision,
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
    verify_table(connection, CHANNEL_OUTBOUND_TABLE, CHANNEL_OUTBOUND_SCHEMA_SQL)?;
    verify_columns(connection, CHANNEL_OWNER_TABLE, OWNER_COLUMNS)?;
    verify_columns(connection, CHANNEL_INTENT_TABLE, INTENT_COLUMNS)?;
    verify_columns(connection, CHANNEL_ECHO_TABLE, ECHO_COLUMNS)?;
    verify_columns(connection, CHANNEL_OUTBOUND_TABLE, OUTBOUND_COLUMNS)
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
    fail_write_prepared_outbound: u64,
    fail_mark_dispatched: u64,
    fail_after_dispatch_cas: u64,
    fail_commit_outbound_terminal: u64,
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
        config_revision: i64,
    ) -> Result<Self, ChannelError> {
        gate_channel_store_schema(connection)?;
        if config_revision < 1 {
            return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "store config revision must be positive"));
        }
        let owner = StoreOwner::from(StoreOwnerBinding { principal: principal.clone(), config_revision });
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
        Ok(Self {
            connection,
            owner,
            owner_digest,
            fail_write_prepared: 0,
            fail_commit_outcome: 0,
            fail_write_prepared_outbound: 0,
            fail_mark_dispatched: 0,
            fail_after_dispatch_cas: 0,
            fail_commit_outbound_terminal: 0,
        })
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

    #[cfg(feature = "test-support")]
    /// Test-support only: inject failures into the next `n` durable outbound
    /// Prepared writes (the pre-admission/idempotency persistence step).
    pub fn inject_write_prepared_outbound_failure(&mut self, n: u64) {
        self.fail_write_prepared_outbound = n;
    }

    #[cfg(feature = "test-support")]
    /// Test-support only: inject failures into the next `n` durable outbound
    /// dispatched-marker writes.
    pub fn inject_mark_dispatched_failure(&mut self, n: u64) {
        self.fail_mark_dispatched = n;
    }

    #[cfg(feature = "test-support")]
    /// Test-support only: inject failures into the next `n` atomic outbound
    /// terminal+echo commits.
    pub fn inject_commit_outbound_terminal_failure(&mut self, n: u64) {
        self.fail_commit_outbound_terminal = n;
    }

    #[cfg(feature = "test-support")]
    /// Test-support only: inject a failure AFTER the dispatch CAS UPDATE
    /// succeeds but BEFORE its COMMIT (transaction-boundary crash), proving
    /// the whole CAS rolls back atomically.
    pub fn inject_after_dispatch_cas_failure(&mut self, n: u64) {
        self.fail_after_dispatch_cas = n;
    }

    /// Verify the store is bound to the exact current principal (full fence
    /// facts). Used by the receiver test-support constructor to enforce
    /// store/principal equality.
    #[cfg(feature = "test-support")]
    pub(crate) fn verify_owner_against(&self, principal: &ChannelPrincipal, config_revision: i64) -> Result<(), ChannelError> {
        self.verify_owner_meta()?;
        let expected = StoreOwner::from(StoreOwnerBinding { principal: principal.clone(), config_revision });
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
        // The stored draft must be strictly canonical (re-encoded
        // byte-identical, exact key sets) and its payload digest recomputed.
        verify_draft_canonical(record)?;
        let recomputed_payload = payload_digest_of(&record.request_jcs);
        if recomputed_payload != record.payload_digest {
            return Err(corrupted("channel intent payload digest mismatch"));
        }
        // Derive event identity/kind/relation from the canonical draft (the
        // single source of truth) and require the stored fields to agree —
        // no divergent copies.
        let facts = derive_draft_facts(record)?;
        if facts.external_event_id != record.external_event_id {
            return Err(corrupted("channel intent external identity does not match the canonical draft"));
        }
        if facts_event_kind(&facts) != record.kind
            || facts.references_external_event_id.as_deref() != record.references_external_event_id.as_deref()
        {
            return Err(corrupted("channel intent kind/relation does not match the canonical draft"));
        }
        // Recompute the operation digest binding full authority incl. graph
        // digest, ordered targets, content, relation, config revision — from
        // the DERIVED facts.
        let recomputed_digest = channel_intent_digest(
            &record.account, &record.extension_id, &record.module_id, &record.instance_id,
            record.generation as u64, record.revision, record.graph_revision, &record.graph_digest,
            record.config_revision, &facts.external_event_id, facts_event_kind(&facts),
            facts.references_external_event_id.as_deref(), &record.target_page_ids,
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

    /// Full canonical/invariant verification of one loaded durable outbound
    /// record: record digest recomputed, table key == record key ==
    /// `entry.action_id`, canonical committed Action bytes re-encoded
    /// byte-identically, operation digest recomputed from the exact Action
    /// bytes + complete principal fences, idempotency-key derivation, derived
    /// account, complete sealed principal == bound store owner, and the
    /// prepared-state invariants. A self-consistent semantic tamper (fields
    /// edited and the outer hash recomputed) fails closed at the digest/key/
    /// owner re-derivation.
    fn verify_outbound_record(
        connection: &Connection,
        outbound_key: &str,
        record: &DurableOutboundRecord,
        owner: &StoreOwner,
    ) -> Result<(), ChannelError> {
        // Re-encode and recompute the record digest.
        let bytes = dolly_canonical_json::canonicalize(record)
            .map_err(|e| corrupted(&format!("channel outbound record failed canonicalization: {e}")))?
            .0
            .as_bytes()
            .to_vec();
        let recomputed = Sha256Digest::compute(&bytes).to_canonical_string();
        let stored_digest: String = connection
            .query_row("SELECT record_digest FROM channel_outbound WHERE outbound_key = ?1", [outbound_key], |row| row.get(0))
            .map_err(map_sqlite)?;
        if recomputed != stored_digest {
            return Err(corrupted("channel outbound record digest mismatch"));
        }
        // Derived columns (state/session_id/queued_seq) must exactly mirror
        // the canonical record; an independent column edit fails closed.
        let (state, session_id, queued_seq): (String, String, Option<i64>) = connection
            .query_row(
                "SELECT state, session_id, queued_seq FROM channel_outbound WHERE outbound_key = ?1",
                [outbound_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(map_sqlite)?;
        if state != record.entry.state.as_str()
            || session_id != record.entry.session_id
            || queued_seq != record.entry.queued_seq
        {
            return Err(corrupted("channel outbound derived columns do not match the canonical record"));
        }
        // Table key must equal the record key and the entry action id.
        if record.outbound_key != outbound_key {
            return Err(corrupted("channel outbound record key does not match the table key"));
        }
        if record.entry.action_id != outbound_key {
            return Err(corrupted("channel outbound record action id does not match the record key"));
        }
        if record.entry.session_id.is_empty() {
            return Err(corrupted("channel outbound record session is empty"));
        }
        // The committed Action bytes must be strictly canonical JSON.
        let parsed = dolly_canonical_json::parse_core_json(
            record.action_jcs.as_bytes(),
            dolly_canonical_json::ParseLimits::protocol_wire(),
        )
        .map_err(|_| corrupted("channel outbound action bytes are not canonical JSON"))?;
        let recanon = dolly_canonical_json::canonicalize(&parsed)
            .map_err(|_| corrupted("channel outbound action bytes failed canonical re-encoding"))?
            .0
            .as_bytes()
            .to_vec();
        if recanon != record.action_jcs.as_bytes() {
            return Err(corrupted("channel outbound action bytes are not canonically encoded"));
        }
        // Recompute the authority-bound operation digest from the exact
        // committed Action bytes, the targeted module, the config revision,
        // the complete principal fences AND the exact Manifest coordinates.
        let base_digest = crate::host_adapter::outbound_operation_digest(
            &record.extension_id,
            &record.module_id,
            &record.instance_id,
            record.generation as u64,
            record.revision,
            record.graph_revision,
            &record.graph_digest,
            record.config_revision,
            &record.account,
            &record.action_jcs,
            &record.target_module_id,
        );
        let mut identity = serde_json::Map::new();
        identity.insert(
            "schema".into(),
            serde_json::json!("dolly.channel-outbound/manifest-selected/v1"),
        );
        identity.insert("base".into(), serde_json::json!(base_digest));
        identity.insert("activation_id".into(), serde_json::json!(record.activation_id));
        identity.insert("manifest_digest".into(), serde_json::json!(record.manifest_digest));
        identity.insert("input_index".into(), serde_json::json!(record.input_index));
        identity.insert("action_index".into(), serde_json::json!(record.action_index));
        identity.insert("block_id".into(), serde_json::json!(record.block_id));
        let recomputed_digest = Sha256Digest::compute(
            dolly_canonical_json::canonicalize(&serde_json::Value::Object(identity))
                .expect("identity is canonical JSON")
                .0
                .as_bytes(),
        )
        .to_canonical_string();
        if recomputed_digest != record.digest {
            return Err(corrupted("channel outbound operation digest mismatch (semantic tamper)"));
        }
        // Idempotency-key derivation is deterministic from the action id.
        let expected_key = if record.entry.idempotency_supported {
            Some(crate::ids::outbound_idempotency_key(&record.outbound_key))
        } else {
            None
        };
        if record.entry.idempotency_key != expected_key {
            return Err(corrupted("channel outbound idempotency key does not match the action id"));
        }
        // Derived account must equal the stored account.
        let expected_account = crate::ids::channel_account(
            &record.owner,
            &record.extension_id,
            &record.module_id,
            &record.instance_id,
        );
        if record.account != expected_account {
            return Err(corrupted("channel outbound record account does not match the derived principal account"));
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
            || record.config_revision != owner.config_revision
            || record.account != owner.account
        {
            return Err(corrupted("channel outbound record owner/meta does not match the bound principal"));
        }
        if !record.target_module_id.is_empty() && record.target_module_id != record.module_id {
            // A committed outbound Action targets the current module; any
            // other target is opposite-direction authority and fails closed.
            return Err(corrupted("channel outbound record targets a different module"));
        }
        // Prepared-state invariants: a non-terminal row never carries a
        // frozen result, and a Prepared row was never dispatched.
        if !record.entry.state.is_terminal() && record.entry.result_jcs.is_some() {
            return Err(corrupted("channel outbound non-terminal record carries a frozen result"));
        }
        if record.entry.state == OutboundState::Prepared && record.entry.dispatched_at.is_some() {
            return Err(corrupted("channel outbound prepared record is already dispatched"));
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

    fn load_outbound(&mut self, outbound_key: &str) -> Result<Option<DurableOutboundRecord>, ChannelError> {
        self.verify_owner_meta()?;
        let row: Option<(String, Vec<u8>)> = self
            .connection
            .query_row("SELECT record_digest, canonical_jcs FROM channel_outbound WHERE outbound_key = ?1", [outbound_key], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(map_sqlite)?;
        let Some((digest, jcs)) = row else { return Ok(None); };
        let computed = Sha256Digest::compute(&jcs).to_canonical_string();
        if computed != digest {
            return Err(corrupted("channel outbound stored digest mismatch (tampered)"));
        }
        let text = std::str::from_utf8(&jcs).map_err(|_| corrupted("channel outbound record is not UTF-8"))?;
        let record: DurableOutboundRecord = serde_json::from_str(text)
            .map_err(|_| corrupted("channel outbound record is not a strict canonical record"))?;
        Self::verify_outbound_record(self.connection, outbound_key, &record, &self.owner)?;
        Ok(Some(record))
    }

    /// Serialize one outbound record to canonical bytes + its record digest.
    fn outbound_record_bytes(
        record: &DurableOutboundRecord,
    ) -> Result<(Vec<u8>, String), ChannelError> {
        let bytes = dolly_canonical_json::canonicalize(record)
            .map_err(|e| corrupted(&format!("channel outbound record failed canonicalization: {e}")))?
            .0
            .as_bytes()
            .to_vec();
        let digest = Sha256Digest::compute(&bytes).to_canonical_string();
        Ok((bytes, digest))
    }

    /// Atomically INSERT one outbound row. Returns whether the row was newly
    /// inserted (`true`) or a row already existed under the key (`false`).
    /// Never upserts: an existing key is never overwritten by this call.
    fn insert_outbound_row(
        transaction: &rusqlite::Transaction<'_>,
        record: &DurableOutboundRecord,
    ) -> Result<bool, ChannelError> {
        let (bytes, digest) = Self::outbound_record_bytes(record)?;
        let inserted = transaction
            .execute(
                "INSERT INTO channel_outbound (outbound_key, record_digest, canonical_jcs, state, session_id, queued_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(outbound_key) DO NOTHING",
                params![record.outbound_key, digest, bytes.as_slice(), record.entry.state.as_str(), record.entry.session_id, record.entry.queued_seq],
            )
            .map_err(map_sqlite)?;
        Ok(inserted == 1)
    }

    /// Atomically UPDATE one outbound row's canonical bytes. Used only by the
    /// dispatch CAS winner and the terminal+echo commit; both load+verify the
    /// existing row before calling this.
    fn update_outbound_row(
        transaction: &rusqlite::Transaction<'_>,
        record: &DurableOutboundRecord,
    ) -> Result<(), ChannelError> {
        let (bytes, digest) = Self::outbound_record_bytes(record)?;
        let changed = transaction
            .execute(
                "UPDATE channel_outbound SET record_digest = ?2, canonical_jcs = ?3, state = ?4, session_id = ?5, queued_seq = ?6 WHERE outbound_key = ?1",
                params![record.outbound_key, digest, bytes.as_slice(), record.entry.state.as_str(), record.entry.session_id, record.entry.queued_seq],
            )
            .map_err(map_sqlite)?;
        if changed == 0 {
            return Err(corrupted("channel outbound row vanished during update"));
        }
        Ok(())
    }

    /// Atomically insert the exact action key + operation digest as a
    /// `Prepared` row BEFORE any queue admission or transport call. One
    /// SQLite transaction: `INSERT ... ON CONFLICT DO NOTHING` — a fresh key
    /// inserts as Prepared; an existing key does NOT insert and is then
    /// loaded+verified for replay/conflict. The same key + same digest
    /// replays idempotently (a terminal row returns its frozen result with
    /// zero re-dispatch, a non-terminal row is returned unchanged and never
    /// downgraded); the same key with a different digest (different
    /// target/content/config) conflicts before enqueue and changes nothing.
    pub fn insert_prepared_or_replay(
        &mut self,
        record: &DurableOutboundRecord,
    ) -> Result<OutboundPreparedOutcome, ChannelError> {
        if self.fail_write_prepared_outbound > 0 {
            self.fail_write_prepared_outbound -= 1;
            return Err(ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "injected durable outbound prepared write failure"));
        }
        self.verify_owner_meta()?;
        if record.schema != OUTBOUND_RECORD_SCHEMA || record.version != 1 {
            return Err(corrupted("channel outbound record discriminator mismatch"));
        }
        if record.entry.state != OutboundState::Prepared {
            return Err(corrupted("insert_prepared_or_replay requires a prepared outbound record"));
        }
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(map_sqlite)?;
        let inserted = Self::insert_outbound_row(&transaction, record)?;
        if inserted {
            transaction.commit().map_err(map_sqlite)?;
            return Ok(OutboundPreparedOutcome::Prepared);
        }
        // A row already exists under this key: read it from the same
        // transaction (the row cannot change between the failed insert and
        // this read under the Immediate lock), then commit.
        let row: Option<(String, Vec<u8>)> = transaction
            .query_row(
                "SELECT record_digest, canonical_jcs FROM channel_outbound WHERE outbound_key = ?1",
                [&record.outbound_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(map_sqlite)?;
        transaction.commit().map_err(map_sqlite)?;
        let (digest, jcs) = row.ok_or_else(|| corrupted("outbound row existed at insert but vanished on load"))?;
        let computed = Sha256Digest::compute(&jcs).to_canonical_string();
        if computed != digest {
            return Err(corrupted("channel outbound stored digest mismatch (tampered)"));
        }
        let text = std::str::from_utf8(&jcs).map_err(|_| corrupted("channel outbound record is not UTF-8"))?;
        let existing: DurableOutboundRecord = serde_json::from_str(text)
            .map_err(|_| corrupted("channel outbound record is not a strict canonical record"))?;
        Self::verify_outbound_record(self.connection, &record.outbound_key, &existing, &self.owner)?;
        if existing.digest != record.digest {
            return Err(ChannelError::new(
                codes::OPERATION_CONFLICT,
                false,
                ChannelOutcome::NotApplied,
                "durable outbound key already carries a different operation digest (different target/content/config)",
            ));
        }
        if existing.entry.state.is_terminal() {
            let result_jcs = existing.entry.result_jcs.clone().ok_or_else(|| {
                corrupted("terminal outbound record has no frozen result")
            })?;
            return Ok(OutboundPreparedOutcome::ReplayTerminal {
                state: existing.entry.state,
                result_jcs,
            });
        }
        Ok(OutboundPreparedOutcome::PreparedExisting)
    }

    /// The verified durable outbound record for one action key.
    pub fn find_outbound(&mut self, outbound_key: &str) -> Result<Option<DurableOutboundRecord>, ChannelError> {
        self.load_outbound(outbound_key)
    }

    /// Every non-terminal (`Prepared`) durable outbound record, for
    /// restart/recovery and the committed-Action pipeline.
    pub fn list_pending_outbound(&mut self) -> Result<Vec<DurableOutboundRecord>, ChannelError> {
        self.verify_owner_meta()?;
        let mut statement = self.connection.prepare("SELECT outbound_key, record_digest, canonical_jcs FROM channel_outbound").map_err(map_sqlite)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Vec<u8>>(2)?))).map_err(map_sqlite)?.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)?;
        let mut pending = Vec::new();
        for (key, digest, jcs) in rows {
            let computed = Sha256Digest::compute(&jcs).to_canonical_string();
            if computed != digest {
                return Err(corrupted("channel outbound stored digest mismatch (tampered)"));
            }
            let text = std::str::from_utf8(&jcs).map_err(|_| corrupted("channel outbound record is not UTF-8"))?;
            let record: DurableOutboundRecord = serde_json::from_str(text)
                .map_err(|_| corrupted("channel outbound record is not a strict canonical record"))?;
            Self::verify_outbound_record(self.connection, &key, &record, &self.owner)?;
            if !record.entry.state.is_terminal() {
                pending.push(record);
            }
        }
        Ok(pending)
    }

    /// Atomically claim the dispatch of one outbound row with a single
    /// SQLite compare-and-swap: the UPDATE only fires when the durable row's
    /// current record_digest still equals the loaded+verified digest (which
    /// encodes the Prepared/Queued state). Exactly one concurrent claimant
    /// wins (rows-changed == 1); all others see 0 and MUST NOT call the
    /// transport. The CAS winner transitions to `Dispatched` BEFORE transport
    /// initiation; a CAS failure (already dispatched, terminal, or missing)
    /// means zero transport.
    /// Atomically admit one `Prepared` row into the durable outbound FIFO:
    /// transitions `Prepared` -> `Queued` with a monotonic `queued_seq`,
    /// bounded by the configured pending occupancy (`max_pending_per_session`
    /// and `max_pending_total` over nonterminal Prepared/Queued/Dispatched
    /// rows). One Immediate transaction: a concurrent admission cannot
    /// exceed the bound. Returns whether the row was admitted; `false` means
    /// the queue is at capacity (the caller waits under its deadline, never
    /// leaks a slot).
    pub(crate) fn admit_to_queue(
        &mut self,
        outbound_key: &str,
        session_id: &str,
        max_pending_per_session: usize,
        max_pending_total: usize,
        waiting_reservations: usize,
        now: &str,
    ) -> Result<bool, ChannelError> {
        self.verify_owner_meta()?;
        // ONE Immediate transaction: load, occupancy-bound, and transition
        // Prepared -> Queued atomically so the bound can never be exceeded by
        // concurrent admissions.
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite)?;
        let current_state: Option<String> = transaction
            .query_row(
                "SELECT state FROM channel_outbound WHERE outbound_key = ?1",
                [outbound_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(map_sqlite)?;
        let Some(current_state) = current_state else {
            transaction.commit().map_err(map_sqlite)?;
            return Ok(false);
        };
        if current_state != OutboundState::Prepared.as_str() {
            // Already Queued by a prior admission or later state: idempotent,
            // never downgraded.
            transaction.commit().map_err(map_sqlite)?;
            return Ok(false);
        }
        let nonterminal_filter = "state IN ('queued','dispatched')";
        let per_session: i64 = transaction
            .query_row(
                &format!("SELECT COUNT(*) FROM channel_outbound WHERE session_id = ?1 AND {nonterminal_filter}"),
                [session_id],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;
        let total: i64 = transaction
            .query_row(
                &format!("SELECT COUNT(*) FROM channel_outbound WHERE {nonterminal_filter}"),
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;
        // ONE combined bound: durable queued/in-flight plus waiting
        // reservations <= max_pending_per_session; the ledger-wide durable
        // bound is max_pending_total.
        if per_session as usize + waiting_reservations >= max_pending_per_session
            || total as usize >= max_pending_total
        {
            transaction.commit().map_err(map_sqlite)?;
            return Ok(false);
        }
        // Load+verify the durable truth inside the same transaction.
        let mut record = Self::load_outbound_txn(&transaction, outbound_key, &self.owner)?
            .ok_or_else(|| corrupted("outbound row vanished during queue admission"))?;
        let next_seq: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(queued_seq), 0) + 1 FROM channel_outbound",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;
        record.entry.state = OutboundState::Queued;
        record.entry.queued_seq = Some(next_seq);
        record.entry.attempts.push(AttemptRecord {
            at: now.to_string(),
            kind: "enqueue".to_string(),
            detail_digest: Sha256Digest::compute(b"enqueue").to_canonical_string(),
        });
        Self::update_outbound_row(&transaction, &record)?;
        transaction.commit().map_err(map_sqlite)?;
        Ok(true)
    }

    /// The durable outbound FIFO (reconstructed from nonterminal rows in
    /// `queued_seq` order), for tests and restart reconstruction.
    pub(crate) fn fifo_pending(&mut self) -> Result<Vec<DurableOutboundRecord>, ChannelError> {
        let mut pending = self.list_pending_outbound()?;
        pending.sort_by_key(|r| r.entry.queued_seq.unwrap_or(i64::MAX));
        Ok(pending)
    }

    fn load_outbound_txn(
        transaction: &rusqlite::Transaction<'_>,
        outbound_key: &str,
        owner: &StoreOwner,
    ) -> Result<Option<DurableOutboundRecord>, ChannelError> {
        let row: Option<(String, Vec<u8>)> = transaction
            .query_row(
                "SELECT record_digest, canonical_jcs FROM channel_outbound WHERE outbound_key = ?1",
                [outbound_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(map_sqlite)?;
        let Some((digest, jcs)) = row else { return Ok(None); };
        let computed = Sha256Digest::compute(&jcs).to_canonical_string();
        if computed != digest {
            return Err(corrupted("channel outbound stored digest mismatch (tampered)"));
        }
        let text = std::str::from_utf8(&jcs).map_err(|_| corrupted("channel outbound record is not UTF-8"))?;
        let record: DurableOutboundRecord = serde_json::from_str(text)
            .map_err(|_| corrupted("channel outbound record is not a strict canonical record"))?;
        Self::verify_outbound_record(transaction, outbound_key, &record, owner)?;
        Ok(Some(record))
    }

    pub(crate) fn claim_dispatch(
        &mut self,
        outbound_key: &str,
        now: &str,
    ) -> Result<DispatchClaim, ChannelError> {
        if self.fail_mark_dispatched > 0 {
            self.fail_mark_dispatched -= 1;
            return Err(ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "injected dispatched-marker write failure"));
        }
        self.verify_owner_meta()?;
        let mut record = self
            .load_outbound(outbound_key)?
            .ok_or_else(|| corrupted("outbound row missing for dispatch CAS"))?;
        if record.entry.state.is_terminal() {
            return Ok(DispatchClaim::AlreadyTerminal {
                state: record.entry.state,
                result_jcs: record.entry.result_jcs.clone(),
            });
        }
        if record.entry.state == OutboundState::Dispatched {
            return Ok(DispatchClaim::AlreadyDispatched);
        }
        // Build the Dispatched record (recomputed canonical bytes + digest
        // from the loaded+verified durable truth) and remember the EXACT
        // digest of the row this caller verified BEFORE the CAS.
        let original_state = record.entry.state;
        let verified_digest = {
            let (_, d) = Self::outbound_record_bytes(&record)?;
            d
        };
        record.entry.state = OutboundState::Dispatched;
        record.entry.dispatched_at = Some(now.to_string());
        record.entry.attempts.push(AttemptRecord {
            at: now.to_string(),
            kind: "dispatch".to_string(),
            detail_digest: Sha256Digest::compute(b"dispatch-cas").to_canonical_string(),
        });
        let (bytes, digest) = Self::outbound_record_bytes(&record)?;
        // Digest-bound single CAS in ONE Immediate transaction: the UPDATE
        // predicate binds the EXACT verified record digest AND the
        // Prepared/Queued state. A row that changed between load and CAS (same
        // state but different bytes) can never win; SQLite serializes the
        // transaction so exactly one concurrent claimant sees rows-changed==1,
        // all others see 0 and MUST NOT transport. A CAS failure means zero
        // transport.
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite)?;
        let changed = transaction
            .execute(
                "UPDATE channel_outbound
                 SET record_digest = ?2, canonical_jcs = ?3, state = ?5, queued_seq = ?6
                 WHERE outbound_key = ?1 AND record_digest = ?7 AND state = ?4",
                params![
                    outbound_key,
                    digest,
                    bytes.as_slice(),
                    original_state.as_str(),
                    record.entry.state.as_str(),
                    record.entry.queued_seq,
                    verified_digest,
                ],
            )
            .map_err(map_sqlite)?;
        // Transaction-boundary failpoint: a failure after the UPDATE but
        // before COMMIT must roll the whole CAS back, leaving the row
        // Queued/Prepared (verified in tests) so a later claimer can win.
        if self.fail_after_dispatch_cas > 0 {
            self.fail_after_dispatch_cas -= 1;
            drop(transaction);
            return Err(ChannelError::new(
                codes::INTERNAL,
                false,
                ChannelOutcome::NotApplied,
                "injected dispatch-CAS transaction-boundary failure",
            ));
        }
        transaction.commit().map_err(map_sqlite)?;
        if changed == 0 {
            return Ok(DispatchClaim::LostRace);
        }
        Ok(DispatchClaim::Won(record))
    }

    /// Atomically commit the terminal outbound record AND every sent-transport
    /// echo marker (for CONFIRMED pieces) in ONE Channel DB transaction: a
    /// confirmed transport ID becomes a durable echo-suppression fact in the
    /// same commit as its terminal result. A failure leaves the durable row
    /// `dispatched` (reconcilable status-first), never a terminal-without-
    /// marker inconsistency.
    pub(crate) fn commit_outbound_terminal(
        &mut self,
        record: &DurableOutboundRecord,
    ) -> Result<(), ChannelError> {
        if self.fail_commit_outbound_terminal > 0 {
            self.fail_commit_outbound_terminal -= 1;
            return Err(ChannelError::new(codes::INTERNAL, false, ChannelOutcome::NotApplied, "injected outbound terminal commit failure"));
        }
        self.verify_owner_meta()?;
        if record.schema != OUTBOUND_RECORD_SCHEMA || record.version != 1 {
            return Err(corrupted("channel outbound record discriminator mismatch"));
        }
        if !record.entry.state.is_terminal() {
            return Err(corrupted("commit_outbound_terminal requires a terminal outbound record"));
        }
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(map_sqlite)?;
        Self::update_outbound_row(&transaction, record)?;
        for piece in record.entry.pieces.iter().filter_map(|p| match &p.outcome {
            Some(PieceOutcome::Confirmed { transport_message_id }) => Some(transport_message_id),
            _ => None,
        }) {
            let echo = EchoRecord {
                schema: ECHO_RECORD_SCHEMA.to_string(),
                version: 1,
                owner: record.owner.clone(),
                extension_id: record.extension_id.clone(),
                module_id: record.module_id.clone(),
                instance_id: record.instance_id.clone(),
                generation: record.generation,
                revision: record.revision,
                graph_revision: record.graph_revision,
                graph_digest: record.graph_digest.clone(),
                config_revision: record.config_revision,
                account: record.account.clone(),
                transport_event_id: piece.clone(),
                echo_key: format!("{}\u{0}{}", record.account, piece),
            };
            let bytes = dolly_canonical_json::canonicalize(&echo)
                .map_err(|e| corrupted(&format!("channel echo failed canonicalization: {e}")))?
                .0
                .as_bytes()
                .to_vec();
            let digest = Sha256Digest::compute(&bytes).to_canonical_string();
            transaction
                .execute(
                    "INSERT INTO channel_echo (echo_key, record_digest, canonical_jcs) VALUES (?1, ?2, ?3)
                     ON CONFLICT(echo_key) DO UPDATE SET record_digest = ?2, canonical_jcs = ?3",
                    params![echo.echo_key, digest, bytes.as_slice()],
                )
                .map_err(map_sqlite)?;
        }
        transaction.commit().map_err(map_sqlite)
    }

    /// Durably record a sent-transport echo marker (distinct from inbound
    /// event state: its only purpose is inbound-echo suppression). The record
    /// is a canonical, owner-bound JSON document carrying schema/version, the
    /// complete sealed principal facts (owner, Extension, module, instance/
    /// domain, generation, incarnation revision, graph revision+digest,
    /// config revision, account), the transport event ID, and the derived echo
    /// key, guarded by its record digest. Write seam for the outbound
    /// registration side; the receiver only reads markers for suppression.
    #[allow(dead_code)]
    pub fn record_echo(
        &mut self,
        principal: &ChannelPrincipal,
        config_revision: i64,
        transport_event_id: &str,
    ) -> Result<(), ChannelError> {
        self.verify_owner_meta()?;
        if config_revision != self.owner.config_revision {
            return Err(ChannelError::new(codes::AUTHENTICATION_FAILED, false, ChannelOutcome::NotApplied, "echo record config revision does not match the bound store principal"));
        }
        let account = principal.account();
        let echo_key = format!("{account}\u{0}{transport_event_id}");
        let record = EchoRecord {
            schema: ECHO_RECORD_SCHEMA.to_string(),
            version: 1,
            owner: principal.owner().to_string(),
            extension_id: principal.extension_id().to_string(),
            module_id: principal.module_id().to_string(),
            instance_id: principal.instance_id().to_string(),
            generation: principal.generation() as i64,
            revision: principal.revision(),
            graph_revision: principal.graph_revision(),
            graph_digest: principal.graph_digest().to_string(),
            config_revision,
            account: account.to_string(),
            transport_event_id: transport_event_id.to_string(),
            echo_key: echo_key.clone(),
        };
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

    /// Fully verify ONE echo row (strict deny-unknown-fields parsing, canonical
    /// re-encode byte equality, digest, derived key == table key, complete
    /// sealed principal == bound store owner) and return its transport ID.
    fn verified_echo_id(&self, echo_key: &str) -> Result<String, ChannelError> {
        let row: Option<(String, Vec<u8>)> = self
            .connection
            .query_row("SELECT record_digest, canonical_jcs FROM channel_echo WHERE echo_key = ?1", [echo_key], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(map_sqlite)?;
        let Some((digest, jcs)) = row else { return Ok("".to_string()); };
        let recomputed = Sha256Digest::compute(&jcs).to_canonical_string();
        if recomputed != digest {
            return Err(corrupted("channel echo marker record digest mismatch (tampered)"));
        }
        let text = std::str::from_utf8(&jcs).map_err(|_| corrupted("channel echo marker is not UTF-8"))?;
        // Strict parsing: unknown fields are rejected (deny_unknown_fields).
        let record: EchoRecord =
            serde_json::from_str(text).map_err(|_| corrupted("channel echo marker is not a strict canonical record"))?;
        // Canonical re-encode must be byte-equal to the stored canonical bytes.
        let recanon = dolly_canonical_json::canonicalize(&record)
            .map_err(|e| corrupted(&format!("channel echo marker failed re-encoding: {e}")))?
            .0
            .as_bytes()
            .to_vec();
        if recanon != jcs {
            return Err(corrupted("channel echo marker is not canonically encoded"));
        }
        if record.schema != ECHO_RECORD_SCHEMA || record.version != 1 {
            return Err(corrupted("channel echo marker schema/version mismatch"));
        }
        if record.echo_key != echo_key {
            return Err(corrupted("channel echo marker key does not match the table key"));
        }
        // Derived key == table key == transport id.
        let derived = format!("{}\u{0}{}", record.account, record.transport_event_id);
        if derived != echo_key {
            return Err(corrupted("channel echo marker derived key mismatch"));
        }
        // Complete sealed principal equality against the bound store owner.
        if record.config_revision != self.owner.config_revision {
            return Err(corrupted("channel echo marker config revision does not match the bound store principal"));
        }
        if record.owner != self.owner.owner
            || record.extension_id != self.owner.extension_id
            || record.module_id != self.owner.module_id
            || record.instance_id != self.owner.instance_id
            || record.generation != self.owner.generation
            || record.revision != self.owner.revision
            || record.graph_revision != self.owner.graph_revision
            || record.graph_digest != self.owner.graph_digest
            || record.account != self.owner.account
        {
            return Err(corrupted("channel echo marker owner/meta does not match the bound principal"));
        }
        Ok(record.transport_event_id)
    }

    /// Whether a sent-transport echo marker exists for the account+message id,
    /// after full canonical verification.
    #[allow(dead_code)]
    pub fn is_echo(&mut self, account: &str, transport_event_id: &str) -> Result<bool, ChannelError> {
        self.verify_owner_meta()?;
        let echo_key = format!("{account}\u{0}{transport_event_id}");
        match self.verified_echo_id(&echo_key)? {
            id if id.is_empty() => Ok(false),
            id => Ok(id == transport_event_id),
        }
    }

    /// Fully verified echo keys, seeded into the ledger projection so
    /// `process_event` suppresses a matching inbound echo before Host/Core. A
    /// malformed or forged echo row fails closed here (never suppresses).
    fn list_verified_echo_keys(&mut self) -> Result<Vec<String>, ChannelError> {
        self.verify_owner_meta()?;
        let mut statement = self.connection.prepare("SELECT echo_key FROM channel_echo ORDER BY echo_key").map_err(map_sqlite)?;
        let keys = statement.query_map([], |row| row.get::<_, String>(0)).map_err(map_sqlite)?.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)?;
        for key in &keys {
            let _ = self.verified_echo_id(key)?;
        }
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
                // Projection fields are DERIVED from the canonical draft (the
                // single content source), not persisted copies: real
                // channel/session(session_id)/conversation/sender/time/relation
                // round-trip exactly, including non-default session mappings.
                let facts = derive_draft_facts(&record)?;
                // The SessionMap is part of the accepted three-piece durable
                // ledger state; it is restored here from committed intents so
                // session ownership survives restart for the outbound path.
                ledger.insert_session(&record.account, &facts.external_conversation_id, &facts.session_id);
                let entry = InboundEntry {
                    transport_account: record.account.clone(),
                    external_message_id: facts.external_event_id.clone(),
                    references_external_message_id: facts.references_external_event_id.clone(),
                    state,
                    event_kind: facts_event_kind(&facts),
                    session_id: facts.session_id.clone(),
                    external_conversation_id: facts.external_conversation_id.clone(),
                    channel_id: facts.channel_id.clone(),
                    sender_class: facts.sender_class.clone(),
                    received_at: facts.received_at.clone(),
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
        // Seed the durable outbound rows (single source of truth) into the
        // in-memory outbound ledger; every row is fully verified so the
        // accepted dispatch/recovery/observe pipeline sees the durable truth.
        {
            let mut statement = self.connection.prepare("SELECT outbound_key, record_digest, canonical_jcs FROM channel_outbound").map_err(map_sqlite)?;
            let outbound_rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Vec<u8>>(2)?))).map_err(map_sqlite)?.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)?;
            for (key, digest, jcs) in outbound_rows {
                let computed = Sha256Digest::compute(&jcs).to_canonical_string();
                if computed != digest {
                    return Err(corrupted("channel outbound stored digest mismatch during projection"));
                }
                let text = std::str::from_utf8(&jcs).map_err(|_| corrupted("channel outbound record is not UTF-8"))?;
                let record: DurableOutboundRecord = serde_json::from_str(text)
                    .map_err(|_| corrupted("channel outbound record is not a strict canonical record"))?;
                Self::verify_outbound_record(self.connection, &key, &record, &self.owner)?;
                let _ = ledger.insert_outbound(record.entry, 4096);
            }
        }
        // Seed durable sent-transport echo markers for suppression (keys are
        // `{account} NUL {message_id}`, exactly the ledger's echo-key shape).
        // Every marker is fully verified; a malformed/forged row fails closed
        // here and never suppresses.
        for key in self.list_verified_echo_keys()? {
            ledger.echoed_message_ids.insert(key);
        }
        Ok(ledger)
    }
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;
    use crate::host_adapter::channel_intent_digest;
    use crate::intent::CHANNEL_INTENT_RECORD_SCHEMA as SCHEMA;
    use crate::ledger::{EventKind, OutboundPiece, OutboundState};

    fn principal() -> ChannelPrincipal {
        ChannelPrincipal::from_parts("owner-1", "org.dolly.channel", "receiver", "worker-1", 1, 1, 1, "digest-g")
    }

    fn connection() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        create_channel_store_schema(&mut connection).unwrap();
        connection
    }

    /// A canonical draft whose `org.dolly.channel` metadata carries the full
    /// transport content facts (the single content source for the projection).
    fn draft(external_message_id: &str, kind: &str, references: Option<&str>) -> String {
        let mut channel = serde_json::Map::new();
        channel.insert("channel_id".into(), serde_json::json!("web-primary"));
        channel.insert("transport".into(), serde_json::json!("web"));
        channel.insert("session_id".into(), serde_json::json!("session-mapped"));
        channel.insert("external_conversation_id".into(), serde_json::json!("conv-1"));
        channel.insert("external_message_id".into(), serde_json::json!(external_message_id));
        channel.insert("sender_class".into(), serde_json::json!("user"));
        channel.insert("received_at".into(), serde_json::json!("2026-08-28T00:00:00.000000Z"));
        channel.insert("event_kind".into(), serde_json::json!(kind));
        if let Some(references) = references {
            channel.insert("references_external_message_id".into(), serde_json::json!(references));
        }
        let draft = serde_json::json!({
            "schema": "dolly.block-draft/v1",
            "parts": [{"kind": "text", "text": "hello", "format": "plain"}],
            "actions": [],
            "metadata": { "org.dolly.channel": serde_json::Value::Object(channel) }
        });
        String::from_utf8(dolly_canonical_json::canonicalize(&draft).unwrap().0.as_bytes().to_vec()).expect("draft is UTF-8")
    }

    /// A semantically valid prepared intent (correct key, payload and
    /// operation digests derived from the canonical draft).
    fn valid_intent(key: &str, account: &str, external_message_id: &str, kind: EventKind, references: Option<&str>) -> ChannelIntent {
        let (kind_name, reference_opt) = match kind {
            EventKind::Message => ("message", None),
            EventKind::Edit => ("edit", Some(references.expect("edit requires a reference"))),
            EventKind::Delete => ("delete", Some(references.expect("delete requires a reference"))),
        };
        let request_jcs = draft(external_message_id, kind_name, reference_opt);
        let payload_digest = crate::host_adapter::payload_digest_of(&request_jcs);
        let digest = channel_intent_digest(
            account, "org.dolly.channel", "receiver", "worker-1", 1, 1, 1, "digest-g",
            1, external_message_id, kind, reference_opt,
            &["page-a".to_string()], &payload_digest,
        );
        ChannelIntent {
            schema: SCHEMA.to_string(),
            intent_key: key.to_string(),
            digest,
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
            external_event_id: external_message_id.to_string(),
            kind,
            references_external_event_id: reference_opt.map(str::to_owned),
            target_page_ids: vec!["page-a".to_string()],
            payload_digest,
            request_jcs,
            block_id: None,
            rejected_code: None,
        }
    }

    #[test]
    fn store_binds_principal_and_rejects_cross_principal_reuse() {
        let mut connection = connection();
        {
            let store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            drop(store);
        }
        let other = ChannelPrincipal::from_parts("owner-2", "org.dolly.channel", "receiver", "worker-1", 1, 1, 1, "digest-g");
        let error = SqliteChannelStore::new(&mut connection, &other, 1).expect_err("cross-principal reuse");
        assert_eq!(error.code, codes::AUTHENTICATION_FAILED);
    }

    #[test]
    fn semantic_tamper_with_recomputed_hash_fails_closed() {
        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        let key = crate::ids::inbound_ingress_key(&account, "msg-1");
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.write_prepared(&valid_intent(&key, &account, "msg-1", EventKind::Message, None)).unwrap();
            // Sanity: the valid record reads back.
            assert!(store.find_intent(&key).unwrap().is_some());
        }
        // Semantic tamper: change the ordered target pages AND recompute the
        // outer hash; verify_intent must still fail (operation digest match).
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
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
        let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
        let error = store.find_intent(&key).expect_err("semantic tamper must fail closed");
        assert_eq!(error.code, codes::LEDGER_CORRUPT);
    }

    #[test]
    fn metadata_tamper_with_recomputed_hash_fails_closed() {
        // Semantic tamper on the CANONICAL DRAFT metadata (external identity):
        // the outer hash is recomputed, but the derived facts no longer match
        // the stored key/digest, so verification fails closed.
        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        let key = crate::ids::inbound_ingress_key(&account, "msg-1");
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.write_prepared(&valid_intent(&key, &account, "msg-1", EventKind::Message, None)).unwrap();
        }
        // Rewrite the draft metadata to a different external message id.
        let intent = {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            let mut i = store.find_intent(&key).unwrap().unwrap();
            i.request_jcs = draft("msg-9", "message", None);
            i
        };
        let canonical = intent.canonical_string().unwrap();
        let digest = Sha256Digest::compute(canonical.as_bytes()).to_canonical_string();
        connection.execute(
            "UPDATE channel_intent SET record_digest = ?1, canonical_jcs = ?2 WHERE intent_key = ?3",
            rusqlite::params![digest, canonical.as_bytes(), key],
        ).unwrap();
        let error = {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.find_intent(&key).expect_err("metadata tamper must fail closed")
        };
        assert_eq!(error.code, codes::LEDGER_CORRUPT);
    }

    #[test]
    fn project_derives_real_facts_from_the_canonical_draft() {
        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        let key = crate::ids::inbound_ingress_key(&account, "msg-1");
        let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
        let intent = valid_intent(&key, &account, "msg-1", EventKind::Message, None);
        store.write_prepared(&intent).unwrap();
        store.commit_outcome(&key, Some("block-1"), None).unwrap();
        let ledger = store.project_ledger().unwrap();
        let entry = ledger.inbound_entry(&account, "msg-1").expect("projected entry");
        assert_eq!(entry.channel_id, "web-primary");
        assert_eq!(entry.session_id, "session-mapped", "non-default session mapping round-trips exactly");
        assert_eq!(entry.external_conversation_id, "conv-1");
        assert_eq!(entry.sender_class, "user");
        assert_eq!(entry.received_at, "2026-08-28T00:00:00.000000Z");
        assert_eq!(entry.block_id.as_deref(), Some("block-1"));
        assert_eq!(entry.event_kind, EventKind::Message);
    }

    #[test]
    fn noncanonical_draft_with_recomputed_hash_fails_closed() {
        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        let key = crate::ids::inbound_ingress_key(&account, "msg-1");
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.write_prepared(&valid_intent(&key, &account, "msg-1", EventKind::Message, None)).unwrap();
        }
        // Rewrite the stored draft with the SAME canonical value but serialized
        // in a noncanonical key order (object keys unsorted), and recompute the
        // outer record hash: strict draft verification must fail closed.
        let mut intent = {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            let mut i = store.find_intent(&key).unwrap().unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&i.request_jcs).unwrap();
        let obj = parsed.as_object().unwrap();
        let mut reversed = serde_json::Map::new();
        // insert in reverse order to force noncanonical serialization
        for k in obj.keys().rev() {
            reversed.insert(k.clone(), obj[k].clone());
        }
        i.request_jcs = serde_json::Value::Object(reversed).to_string();
        i
        };
        let _ = &mut intent;
        let canonical = intent.canonical_string().unwrap();
        let digest = Sha256Digest::compute(canonical.as_bytes()).to_canonical_string();
        connection.execute(
            "UPDATE channel_intent SET record_digest = ?1, canonical_jcs = ?2 WHERE intent_key = ?3",
            rusqlite::params![digest, canonical.as_bytes(), key],
        ).unwrap();
        let error = {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.find_intent(&key).expect_err("noncanonical draft must fail closed")
        };
        assert_eq!(error.code, codes::LEDGER_CORRUPT);
    }

    #[test]
    fn unknown_field_draft_with_recomputed_hash_fails_closed() {
        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        let key = crate::ids::inbound_ingress_key(&account, "msg-1");
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.write_prepared(&valid_intent(&key, &account, "msg-1", EventKind::Message, None)).unwrap();
        }
        // Inject an unknown field into the channel metadata and recompute the
        // outer hash: strict metadata key-set verification must fail closed.
        let intent = {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            let mut i = store.find_intent(&key).unwrap().unwrap();
            let mut draft: serde_json::Value = serde_json::from_str(&i.request_jcs).unwrap();
            draft["metadata"]["org.dolly.channel"]["forged"] = serde_json::json!(1);
            i.request_jcs = draft.to_string();
            i
        };
        let _ = &intent;
        let canonical = intent.canonical_string().unwrap();
        let digest = Sha256Digest::compute(canonical.as_bytes()).to_canonical_string();
        connection.execute(
            "UPDATE channel_intent SET record_digest = ?1, canonical_jcs = ?2 WHERE intent_key = ?3",
            rusqlite::params![digest, canonical.as_bytes(), key],
        ).unwrap();
        let error = {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.find_intent(&key).expect_err("unknown draft field must fail closed")
        };
        assert_eq!(error.code, codes::LEDGER_CORRUPT);
    }

    #[test]
    fn unknown_top_level_draft_field_fails_closed() {
        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        let key = crate::ids::inbound_ingress_key(&account, "msg-1");
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.write_prepared(&valid_intent(&key, &account, "msg-1", EventKind::Message, None)).unwrap();
        }
        let intent = {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            let mut i = store.find_intent(&key).unwrap().unwrap();
            let mut draft: serde_json::Value = serde_json::from_str(&i.request_jcs).unwrap();
            draft["evil_top"] = serde_json::json!(1);
            i.request_jcs = draft.to_string();
            i
        };
        let canonical = intent.canonical_string().unwrap();
        let digest = Sha256Digest::compute(canonical.as_bytes()).to_canonical_string();
        connection.execute(
            "UPDATE channel_intent SET record_digest = ?1, canonical_jcs = ?2 WHERE intent_key = ?3",
            rusqlite::params![digest, canonical.as_bytes(), key],
        ).unwrap();
        let error = {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.find_intent(&key).expect_err("unknown top-level draft field must fail closed")
        };
        assert_eq!(error.code, codes::LEDGER_CORRUPT);
    }

    /// Parameterized draft-shape invariants: a canonical fully-rehashed
    /// intent with a removed required root/namespace/channel field, a wrong
    /// schema, or a wrong type must fail closed; the valid draft passes.
    #[test]
    fn draft_exact_shape_invariants_fail_closed() {
        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        let key = crate::ids::inbound_ingress_key(&account, "msg-1");

        // Each case re-seeds a valid base intent, tampers one invariant in the
        // stored draft, recomputes the outer record hash so the record is
        // self-consistent, and requires exact-shape verification to fail
        // closed. A valid draft always passes.
        fn tamper_case(connection: &mut Connection, key: &str, account: &str, label: &str,
            mutate: impl FnOnce(&mut serde_json::Value)) {
            connection.execute("DELETE FROM channel_intent WHERE intent_key = ?1", [key]).unwrap();
            {
                let mut store = SqliteChannelStore::new(connection, &principal(), 1).unwrap();
                store.write_prepared(&valid_intent(key, account, "msg-1", EventKind::Message, None)).unwrap();
            }
            let intent = {
                let mut store = SqliteChannelStore::new(connection, &principal(), 1).unwrap();
                let intent = store.find_intent(key).unwrap().expect("base intent");
                let mut draft: serde_json::Value = serde_json::from_str(&intent.request_jcs).unwrap();
                mutate(&mut draft);
                let mut i2 = intent;
                i2.request_jcs = draft.to_string();
                i2
            };
            let canonical = intent.canonical_string().unwrap();
            let digest = Sha256Digest::compute(canonical.as_bytes()).to_canonical_string();
            connection.execute(
                "UPDATE channel_intent SET record_digest = ?1, canonical_jcs = ?2 WHERE intent_key = ?3",
                rusqlite::params![digest, canonical.as_bytes(), key],
            ).unwrap();
            let error = {
                let mut store = SqliteChannelStore::new(connection, &principal(), 1).unwrap();
                store.find_intent(key).expect_err(&format!("{label} must fail closed"))
            };
            assert_eq!(error.code, codes::LEDGER_CORRUPT);
        }

        tamper_case(&mut connection, &key, &account, "missing root schema", |d| { d.as_object_mut().unwrap().remove("schema"); });
        tamper_case(&mut connection, &key, &account, "wrong root schema", |d| { d["schema"] = serde_json::json!("dolly.evil/v1"); });
        tamper_case(&mut connection, &key, &account, "missing root parts", |d| { d.as_object_mut().unwrap().remove("parts"); });
        tamper_case(&mut connection, &key, &account, "missing root actions", |d| { d.as_object_mut().unwrap().remove("actions"); });
        tamper_case(&mut connection, &key, &account, "wrong parts type", |d| { d["parts"] = serde_json::json!("text"); });
        tamper_case(&mut connection, &key, &account, "wrong actions type", |d| { d["actions"] = serde_json::json!({"a": 1}); });
        tamper_case(&mut connection, &key, &account, "wrong schema type", |d| { d["schema"] = serde_json::json!(1); });
        tamper_case(&mut connection, &key, &account, "missing channel transport", |d| { d["metadata"]["org.dolly.channel"].as_object_mut().unwrap().remove("transport"); });
        tamper_case(&mut connection, &key, &account, "missing channel sender_class", |d| { d["metadata"]["org.dolly.channel"].as_object_mut().unwrap().remove("sender_class"); });
        tamper_case(&mut connection, &key, &account, "missing channel session_id", |d| { d["metadata"]["org.dolly.channel"].as_object_mut().unwrap().remove("session_id"); });
        tamper_case(&mut connection, &key, &account, "wrong channel transport type", |d| { d["metadata"]["org.dolly.channel"]["transport"] = serde_json::json!(3); });
        tamper_case(&mut connection, &key, &account, "missing metadata namespace", |d| { d["metadata"].as_object_mut().unwrap().remove("org.dolly.channel"); });

        // A valid, unmodified draft still passes exact-shape verification.
        connection.execute("DELETE FROM channel_intent WHERE intent_key = ?1", [&key]).unwrap();
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.write_prepared(&valid_intent(&key, &account, "msg-1", EventKind::Message, None)).unwrap();
        }
        let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
        assert!(store.find_intent(&key).unwrap().is_some(), "valid draft must pass");
    }

    #[test]
    fn unknown_metadata_namespace_fails_closed() {
        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        let key = crate::ids::inbound_ingress_key(&account, "msg-1");
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.write_prepared(&valid_intent(&key, &account, "msg-1", EventKind::Message, None)).unwrap();
        }
        let intent = {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            let mut i = store.find_intent(&key).unwrap().unwrap();
            let mut draft: serde_json::Value = serde_json::from_str(&i.request_jcs).unwrap();
            draft["metadata"]["org.evil.namespace"] = serde_json::json!({"x":1});
            i.request_jcs = draft.to_string();
            i
        };
        let canonical = intent.canonical_string().unwrap();
        let digest = Sha256Digest::compute(canonical.as_bytes()).to_canonical_string();
        connection.execute(
            "UPDATE channel_intent SET record_digest = ?1, canonical_jcs = ?2 WHERE intent_key = ?3",
            rusqlite::params![digest, canonical.as_bytes(), key],
        ).unwrap();
        let error = {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.find_intent(&key).expect_err("unknown metadata namespace must fail closed")
        };
        assert_eq!(error.code, codes::LEDGER_CORRUPT);
    }

    /// Focused optional-reference/event-kind invariants. Every mutated
    /// canonical request_jcs case ALSO recomputes the authoritative payload
    /// digest and Channel operation digest from the mutated draft / full
    /// intent (and resyncs the stored kind/reference fields), then recomputes
    /// the outer record hash, so it passes all earlier digest checks and fails
    /// SPECIFICALLY at the optional-reference/event-kind invariant. Valid
    /// absent-message and valid nonempty edit/delete still pass.
    #[test]
    fn references_shape_invariants_fail_closed_and_valid_relations_pass() {
        /// Resync an intent's authoritative digests (and kind/reference
        /// fields) from its (mutated) canonical draft, so a later read passes
        /// every digest check and fails only on the semantic draft invariant.
        fn resync_from_draft(mut intent: ChannelIntent) -> ChannelIntent {
            let draft: serde_json::Value = serde_json::from_str(&intent.request_jcs).unwrap();
            let channel = &draft["metadata"]["org.dolly.channel"];
            let kind = match channel.get("event_kind").and_then(serde_json::Value::as_str) {
                Some("edit") => EventKind::Edit,
                Some("delete") => EventKind::Delete,
                _ => EventKind::Message,
            };
            let references = match channel.get("references_external_message_id") {
                Some(serde_json::Value::String(value)) => Some(value.clone()),
                _ => None,
            };
            intent.kind = kind;
            intent.references_external_event_id = references.clone();
            intent.payload_digest = crate::host_adapter::payload_digest_of(&intent.request_jcs);
            intent.digest = channel_intent_digest(
                &intent.account, "org.dolly.channel", "receiver", "worker-1",
                1, 1, 1, "digest-g", intent.config_revision, &intent.external_event_id,
                kind, references.as_deref(), &intent.target_page_ids, &intent.payload_digest,
            );
            intent
        }

        #[allow(clippy::too_many_arguments)]
        fn reference_case(connection: &mut Connection, key: &str, account: &str,
            external_message_id: &str, kind: EventKind, references: Option<&str>, label: &str,
            mutate: impl FnOnce(&mut serde_json::Value)) {
            connection.execute("DELETE FROM channel_intent WHERE intent_key = ?1", [key]).unwrap();
            {
                let mut store = SqliteChannelStore::new(connection, &principal(), 1).unwrap();
                store.write_prepared(&valid_intent(key, account, external_message_id, kind, references)).unwrap();
            }
            let intent = {
                let mut store = SqliteChannelStore::new(connection, &principal(), 1).unwrap();
                let intent = store.find_intent(key).unwrap().expect("base intent");
                let mut draft: serde_json::Value = serde_json::from_str(&intent.request_jcs).unwrap();
                mutate(&mut draft);
                let mut i2 = intent;
                // Re-canonicalize so the stored draft passes canonical byte
                // equality and reaches the reference/event-kind invariant.
                i2.request_jcs = String::from_utf8(
                    dolly_canonical_json::canonicalize(&draft).unwrap().0.as_bytes().to_vec(),
                ).expect("canonical draft is UTF-8");
                resync_from_draft(i2)
            };
            let canonical = intent.canonical_string().unwrap();
            let digest = Sha256Digest::compute(canonical.as_bytes()).to_canonical_string();
            connection.execute(
                "UPDATE channel_intent SET record_digest = ?1, canonical_jcs = ?2 WHERE intent_key = ?3",
                rusqlite::params![digest, canonical.as_bytes(), key],
            ).unwrap();
            let error = {
                let mut store = SqliteChannelStore::new(connection, &principal(), 1).unwrap();
                store.find_intent(key).expect_err(&format!("{label} must fail closed"))
            };
            assert_eq!(error.code, codes::LEDGER_CORRUPT);
            // The failure must be the optional-reference/event-kind invariant
            // itself (all inner+outer digests were recomputed), never an
            // earlier digest mismatch.
            assert!(
                error.message.contains("reference") || error.message.contains("event_kind"),
                "{label}: expected the reference/event-kind invariant to fail, got: {error:?}"
            );
        }

        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        // Message carrying a present BUT empty reference must fail closed (an
        // empty string is never normalized to None) — with inner+outer digests
        // recomputed, so the failure is the reference invariant itself.
        reference_case(&mut connection, &crate::ids::inbound_ingress_key(&account, "mref"), &account, "mref", EventKind::Message, None, "empty reference on message",
            |d| { d["metadata"]["org.dolly.channel"]["references_external_message_id"] = serde_json::json!(""); });
        // Edit carrying a present BUT empty reference must fail closed.
        reference_case(&mut connection, &crate::ids::inbound_ingress_key(&account, "eref"), &account, "eref", EventKind::Edit, Some("msg-original"), "empty reference on edit",
            |d| { d["metadata"]["org.dolly.channel"]["references_external_message_id"] = serde_json::json!(""); });
        // Delete carrying a present BUT empty reference must fail closed.
        reference_case(&mut connection, &crate::ids::inbound_ingress_key(&account, "dref"), &account, "dref", EventKind::Delete, Some("msg-original"), "empty reference on delete",
            |d| { d["metadata"]["org.dolly.channel"]["references_external_message_id"] = serde_json::json!(""); });
        // A message whose draft illegally GAINS a reference must fail closed
        // (relation shape), with all digests recomputed.
        reference_case(&mut connection, &crate::ids::inbound_ingress_key(&account, "gref"), &account, "gref", EventKind::Message, None, "message gaining a reference",
            |d| { d["metadata"]["org.dolly.channel"]["references_external_message_id"] = serde_json::json!("msg-original"); });
        // Present NON-STRING reference (a number) must fail closed.
        reference_case(&mut connection, &crate::ids::inbound_ingress_key(&account, "nref"), &account, "nref", EventKind::Message, None, "non-string reference",
            |d| { d["metadata"]["org.dolly.channel"]["references_external_message_id"] = serde_json::json!(5); });
        // Present NULL reference (distinct from absent) must fail closed.
        reference_case(&mut connection, &crate::ids::inbound_ingress_key(&account, "nulref"), &account, "nulref", EventKind::Message, None, "null reference",
            |d| { d["metadata"]["org.dolly.channel"]["references_external_message_id"] = serde_json::Value::Null; });
        // Invalid event_kind string must fail closed (event-kind invariant).
        reference_case(&mut connection, &crate::ids::inbound_ingress_key(&account, "kref"), &account, "kref", EventKind::Message, None, "invalid event_kind string",
            |d| { d["metadata"]["org.dolly.channel"]["event_kind"] = serde_json::json!("bogus"); });
        // Invalid event_kind type must fail closed (event-kind invariant).
        reference_case(&mut connection, &crate::ids::inbound_ingress_key(&account, "tref"), &account, "tref", EventKind::Message, None, "invalid event_kind type",
            |d| { d["metadata"]["org.dolly.channel"]["event_kind"] = serde_json::json!(7); });

        // Valid absent-message passes.
        connection.execute("DELETE FROM channel_intent WHERE intent_key = ?1", [&crate::ids::inbound_ingress_key(&account, "vm")]).unwrap();
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            let key = crate::ids::inbound_ingress_key(&account, "vm");
            store.write_prepared(&valid_intent(&key, &account, "vm", EventKind::Message, None)).unwrap();
            assert!(store.find_intent(&key).unwrap().is_some(), "valid absent-message draft must pass");
        }
        // Valid nonempty edit/delete pass.
        for (kind, suffix) in [(EventKind::Edit, "ve"), (EventKind::Delete, "vd")] {
            connection.execute("DELETE FROM channel_intent WHERE intent_key = ?1", [&crate::ids::inbound_ingress_key(&account, suffix)]).unwrap();
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            let key = crate::ids::inbound_ingress_key(&account, suffix);
            store.write_prepared(&valid_intent(&key, &account, suffix, kind, Some("msg-original"))).unwrap();
            assert!(store.find_intent(&key).unwrap().is_some(), "valid {kind:?} draft must pass");
        }
    }

    #[test]
    fn echo_markers_survive_reopen_and_forgery_fails_closed() {
        let mut connection = connection();
        let account = crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.record_echo(&principal(), 1, "transport-msg-1").unwrap();
            assert!(store.is_echo(&account, "transport-msg-1").unwrap());
        }
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            assert!(store.is_echo(&account, "transport-msg-1").unwrap());
            assert!(!store.is_echo(&account, "other").unwrap());
            let ledger = store.project_ledger().unwrap();
            assert!(ledger.is_echo(&account, "transport-msg-1"));
        }
        // Forged/rehashed echo record: recompute the outer hash after editing
        // the transport event ID; full verification must fail closed and the
        // forged marker must NEVER suppress (project_ledger errors).
        {
            let echo_key = format!("{account}\u{0}transport-msg-1");
            let row: (String, Vec<u8>) = connection.query_row(
                "SELECT record_digest, canonical_jcs FROM channel_echo WHERE echo_key = ?1",
                [&echo_key], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            let text = String::from_utf8(row.1).unwrap();
            let mut record: serde_json::Value = serde_json::from_str(&text).unwrap();
            record["transport_event_id"] = serde_json::json!("forged-id");
            let forged = serde_json::to_string(&record).unwrap();
            let digest = Sha256Digest::compute(forged.as_bytes()).to_canonical_string();
            connection.execute(
                "UPDATE channel_echo SET record_digest = ?1, canonical_jcs = ?2 WHERE echo_key = ?3",
                rusqlite::params![digest, forged.as_bytes(), echo_key],
            ).unwrap();
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            let err = store.project_ledger().expect_err("forged echo must fail closed");
            assert_eq!(err.code, codes::LEDGER_CORRUPT);
        }
    }

    // -- durable Prepared outbound record ----------------------------------

    fn outbound_account() -> String {
        crate::ids::channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1")
    }

    /// A canonical committed send Action JSON object (text part only).
    fn send_action_jcs(action_id: &str, session_id: &str, target: &str, text: &str) -> String {
        let action = serde_json::json!({
            "action_id": action_id,
            "name": "org.dolly.channel.send",
            "target": {"module_id": target},
            "arguments": {
                "session_id": session_id,
                "parts": [{"kind": "text", "text": text, "format": "plain"}],
                "reply_to_external_message_id": null
            },
            "contract_binding": {
                "module_id": target,
                "descriptor_revision": 1,
                "action_contract_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                "action_contract": {
                    "name": "org.dolly.channel.send",
                    "arguments_schema": {
                        "uri": "https://dolly.example/spec/0.1/schemas/channel-send.schema.json",
                        "schema_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                        "semantic_validator": null
                    },
                    "result_schema": {
                        "uri": "https://dolly.example/spec/0.1/schemas/channel-send-result.schema.json",
                        "schema_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                        "semantic_validator": {
                            "id": "org.dolly.validator.channel-send-result",
                            "revision": 1
                        }
                    },
                    "description": "send a message",
                    "side_effect_class": "idempotent_write"
                }
            }
        });
        String::from_utf8(
            dolly_canonical_json::canonicalize(&action).unwrap().0.as_bytes().to_vec(),
        )
        .expect("canonical action is UTF-8")
    }

    /// A semantically valid durable Prepared outbound record bound to the
    /// test store owner and config revision, with the authority-bound digest
    /// recomputed from the canonical Action bytes.
    fn valid_outbound_record(action_id: &str, session_id: &str, target: &str, text: &str) -> DurableOutboundRecord {
        let action_jcs = send_action_jcs(action_id, session_id, target, text);
        let account = outbound_account();
        let base_digest = crate::host_adapter::outbound_operation_digest(
            "org.dolly.channel", "receiver", "worker-1", 1, 1, 1, "digest-g",
            1, &account, &action_jcs, target,
        );
        // Extended manifest-selected digest (matches verify_outbound_record).
        let mut identity = serde_json::Map::new();
        identity.insert("schema".into(), serde_json::json!("dolly.channel-outbound/manifest-selected/v1"));
        identity.insert("base".into(), serde_json::json!(base_digest));
        identity.insert("activation_id".into(), serde_json::json!("activation-test"));
        identity.insert("manifest_digest".into(), serde_json::json!("sha256:manifest-test"));
        identity.insert("input_index".into(), serde_json::json!(0usize));
        identity.insert("action_index".into(), serde_json::json!(0usize));
        identity.insert("block_id".into(), serde_json::json!("block-test"));
        let digest = Sha256Digest::compute(
            dolly_canonical_json::canonicalize(&serde_json::Value::Object(identity))
                .expect("identity is canonical JSON")
                .0
                .as_bytes(),
        )
        .to_canonical_string();
        DurableOutboundRecord {
            schema: OUTBOUND_RECORD_SCHEMA.to_string(),
            version: 1,
            outbound_key: action_id.to_string(),
            digest,
            action_jcs,
            activation_id: "activation-test".to_string(),
            manifest_digest: "sha256:manifest-test".to_string(),
            input_index: 0,
            action_index: 0,
            block_id: "block-test".to_string(),
            target_module_id: target.to_string(),
            owner: "owner-1".to_string(),
            extension_id: "org.dolly.channel".to_string(),
            module_id: "receiver".to_string(),
            instance_id: "worker-1".to_string(),
            generation: 1,
            revision: 1,
            graph_revision: 1,
            graph_digest: "digest-g".to_string(),
            config_revision: 1,
            account,
            entry: OutboundEntry {
                action_id: action_id.to_string(),
                session_id: session_id.to_string(),
                config_revision: 1,
                state: OutboundState::Prepared,
                pieces: vec![OutboundPiece {
                    ordinal: 0,
                    text: text.to_string(),
                    transport_message_id: None,
                    outcome: None,
                }],
                idempotency_supported: true,
                idempotency_key: Some(crate::ids::outbound_idempotency_key(action_id)),
                attempts: vec![],
                dispatched_at: None,
                result_jcs: None,
                queued_seq: None,
            },
        }
    }

    #[test]
    fn prepared_outbound_record_is_idempotent_conflicts_on_change_and_durable() {
        let mut connection = connection();
        let account = outbound_account();
        let action_id = "0198ab31-6c44-7e8a-b2bb-000000000201";
        let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
        let first = valid_outbound_record(action_id, "session-main", "receiver", "Hello.");
        assert_eq!(
            store.insert_prepared_or_replay(&first).unwrap(),
            OutboundPreparedOutcome::Prepared,
            "a fresh key+digest persists as Prepared"
        );
        // Same key + digest replays with nothing changed and no downgrade.
        let replay = valid_outbound_record(action_id, "session-main", "receiver", "Hello.");
        assert_eq!(
            store.insert_prepared_or_replay(&replay).unwrap(),
            OutboundPreparedOutcome::PreparedExisting,
            "same key+digest is idempotent"
        );
        // Same key + different content (different text) conflicts before enqueue.
        let changed = valid_outbound_record(action_id, "session-main", "receiver", "Different.");
        let error = store.insert_prepared_or_replay(&changed).expect_err("different content must conflict");
        assert_eq!(error.code, codes::OPERATION_CONFLICT);
        // The durable row is unchanged by the conflict attempt.
        let loaded = store.find_outbound(action_id).unwrap().expect("durable row");
        assert_eq!(loaded.entry.pieces[0].text, "Hello.");
        // Reopen (restart) still sees the durable Prepared row.
        drop(store);
        let mut reopened = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
        let again = reopened.find_outbound(action_id).unwrap().expect("survives restart");
        assert_eq!(again.entry.state, OutboundState::Prepared);
        assert_eq!(again.digest, first.digest);
        assert_eq!(reopened.list_pending_outbound().unwrap().len(), 1);
        let _ = account;
    }

    #[test]
    fn prepared_outbound_tamper_fails_closed() {
        let mut connection = connection();
        let action_id = "0198ab31-6c44-7e8a-b2bb-000000000202";
        let record = valid_outbound_record(action_id, "session-main", "receiver", "Hello.");
        {
            let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
            store.insert_prepared_or_replay(&record).unwrap();
        }
        // Re-hash a tampered canonical record: change the targeted module and
        // recompute the outer hash. Full verification must fail closed.
        let row: (String, Vec<u8>) = connection.query_row(
            "SELECT record_digest, canonical_jcs FROM channel_outbound WHERE outbound_key = ?1",
            [action_id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        let text = String::from_utf8(row.1).unwrap();
        let mut forged: serde_json::Value = serde_json::from_str(&text).unwrap();
        forged["target_module_id"] = serde_json::json!("receiver-other");
        let forged = serde_json::to_string(&forged).unwrap();
        let digest = Sha256Digest::compute(forged.as_bytes()).to_canonical_string();
        connection.execute(
            "UPDATE channel_outbound SET record_digest = ?1, canonical_jcs = ?2 WHERE outbound_key = ?3",
            rusqlite::params![digest, forged.as_bytes(), action_id],
        ).unwrap();
        let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
        let err = store.find_outbound(action_id).expect_err("semantic tamper must fail closed");
        assert_eq!(err.code, codes::LEDGER_CORRUPT);
    }

    #[test]
    fn prepared_outbound_write_failure_leaves_no_row() {
        let mut connection = connection();
        let action_id = "0198ab31-6c44-7e8a-b2bb-000000000203";
        let record = valid_outbound_record(action_id, "session-main", "receiver", "Hello.");
        let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
        store.inject_write_prepared_outbound_failure(1);
        let err = store.insert_prepared_or_replay(&record).expect_err("injected write failure");
        assert_eq!(err.code, codes::INTERNAL);
        assert!(store.find_outbound(action_id).unwrap().is_none(), "no durable row after a failed pre-admission write");
    }
    #[test]
    fn fifo_pending_reconstructs_the_durable_queue_after_restart() {
        let mut connection = connection();
        let account = outbound_account();
        let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
        for (action_id, text) in [
            ("0198ab31-6c44-7e8a-b2bb-000000000301", "first"),
            ("0198ab31-6c44-7e8a-b2bb-000000000302", "second"),
        ] {
            store
                .insert_prepared_or_replay(&valid_outbound_record(action_id, "session-main", "receiver", text))
                .unwrap();
            assert!(
                store
                    .admit_to_queue(action_id, "session-main", 8, 64, 0, "2026-08-09T15:00:00.000000Z")
                    .unwrap(),
                "admission succeeds"
            );
        }
        let order_before: Vec<String> = store
            .fifo_pending()
            .unwrap()
            .into_iter()
            .map(|r| r.entry.action_id)
            .collect();
        assert_eq!(
            order_before,
            vec![
                "0198ab31-6c44-7e8a-b2bb-000000000301".to_string(),
                "0198ab31-6c44-7e8a-b2bb-000000000302".to_string()
            ],
            "durable FIFO order follows admission order"
        );
        drop(store);
        // Restart: reopen the SAME store; the queue is reconstructed from
        // durable nonterminal rows in queued_seq order.
        let _ = account;
        let mut reopened = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
        let order_after: Vec<(String, OutboundState)> = reopened
            .fifo_pending()
            .unwrap()
            .into_iter()
            .map(|r| (r.entry.action_id, r.entry.state))
            .collect();
        assert_eq!(order_after.len(), 2, "both nonterminal rows reconstructed");
        assert_eq!(order_after[0].0, "0198ab31-6c44-7e8a-b2bb-000000000301");
        assert_eq!(order_after[1].0, "0198ab31-6c44-7e8a-b2bb-000000000302");
        assert!(
            order_after.iter().all(|(_, s)| *s == OutboundState::Queued),
            "restart retains Queued state"
        );
    }

    #[test]
    fn concurrent_dispatch_cas_has_exactly_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cas.sqlite3");
        let action_id = "0198ab31-6c44-7e8a-b2bb-000000000303";
        {
            let mut conn = Connection::open(&path).unwrap();
            create_channel_store_schema(&mut conn).unwrap();
            let mut store = SqliteChannelStore::new(&mut conn, &principal(), 1).unwrap();
            store
                .insert_prepared_or_replay(&valid_outbound_record(action_id, "session-main", "receiver", "hi"))
                .unwrap();
            store
                .admit_to_queue(action_id, "session-main", 8, 64, 0, "2026-08-09T15:00:00.000000Z")
                .unwrap();
        }
        // Two INDEPENDENT SQLite connections race the dispatch CAS on the SAME
        // row simultaneously. Exactly one must Win; the loser sees LostRace.
        let conn_path = path.clone();
        let wins = std::sync::Arc::new(std::sync::Mutex::new(0u32));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let wins = std::sync::Arc::clone(&wins);
            let conn_path = conn_path.clone();
            handles.push(std::thread::spawn(move || {
                let mut conn = Connection::open(&conn_path).unwrap();
                let mut store = SqliteChannelStore::new(&mut conn, &principal(), 1).unwrap();
                match store.claim_dispatch(action_id, "2026-08-09T15:00:00.000000Z").unwrap() {
                    DispatchClaim::Won(_) => {
                        *wins.lock().unwrap() += 1;
                    }
                    DispatchClaim::LostRace | DispatchClaim::AlreadyDispatched => {}
                    other => panic!("unexpected claim {other:?}"),
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(*wins.lock().unwrap(), 1, "exactly one concurrent claimant wins");
        // The winner's Dispatched transition is durable and the CAS was bound
        // to the verified row digest (state + bytes advanced atomically).
        let mut s3conn = Connection::open(&path).unwrap();
        let mut s3 = SqliteChannelStore::new(&mut s3conn, &principal(), 1).unwrap();
        let record = s3.find_outbound(action_id).unwrap().unwrap();
        assert_eq!(record.entry.state, OutboundState::Dispatched);
        assert!(record.entry.dispatched_at.is_some());
    }

    #[test]
    fn dispatch_cas_transaction_boundary_failure_rolls_back_atomically() {
        let mut connection = connection();
        let action_id = "0198ab31-6c44-7e8a-b2bb-000000000304";
        let mut store = SqliteChannelStore::new(&mut connection, &principal(), 1).unwrap();
        store
            .insert_prepared_or_replay(&valid_outbound_record(action_id, "session-main", "receiver", "hi"))
            .unwrap();
        store
            .admit_to_queue(action_id, "session-main", 8, 64, 0, "2026-08-09T15:00:00.000000Z")
            .unwrap();
        // Crash AFTER the CAS UPDATE but BEFORE COMMIT: the whole transaction
        // must roll back, leaving the row durably Queued (never a half-applied
        // Dispatched marker, never a leaked winner).
        store.inject_after_dispatch_cas_failure(1);
        let err = store
            .claim_dispatch(action_id, "2026-08-09T15:00:00.000000Z")
            .expect_err("transaction-boundary failure propagates");
        assert_eq!(err.code, codes::INTERNAL);
        let record = store.find_outbound(action_id).unwrap().unwrap();
        assert_eq!(record.entry.state, OutboundState::Queued, "CAS rolled back atomically");
        assert!(record.entry.dispatched_at.is_none());
        // A later clean claimer still wins exactly once (no leaked state).
        match store.claim_dispatch(action_id, "2026-08-09T15:00:01.000000Z").unwrap() {
            DispatchClaim::Won(_) => {}
            other => panic!("later claimer must win after rollback, got {other:?}"),
        }
        let record = store.find_outbound(action_id).unwrap().unwrap();
        assert_eq!(record.entry.state, OutboundState::Dispatched);
    }


}
