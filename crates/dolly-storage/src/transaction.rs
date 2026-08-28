//! SQLite-backed Core transaction and snapshot storage.
//!
//! `SqliteCoreTransaction` is the one-writer boundary for the pure reducer.
//! It opens an immediate SQLite transaction, loads and verifies the durable
//! projection, applies one reducer transition, appends its journal batch, and
//! commits once. The reducer remains the authority for semantic transitions;
//! SQLite only supplies atomicity, optimistic fencing, replay identity, and
//! tamper detection.

use dolly_canonical_json::{
    ParseLimits, Sha256Digest, canonicalize, deserialize_core_json,
};
use dolly_core_reducer::{
    ActivationState, CoreCommand, CoreError, CoreEvent, CoreSnapshot, EnvironmentInput,
    ErrorOutcome, HostConnectionIdentity, HostConnectionRecord, InstanceMode, PROJECTION_KIND,
    RuntimeEventCommand, StorageObservation, Transition, TransitionOutcome, empty_core_snapshot,
    hash_core_state, project_core_state, reduce,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::database::map_sqlite_error;
use crate::error::{StorageError, StorageResult};

/// One atomic Core transition plus its journal under a single storage commit.
///
/// Implementations load the pre-command snapshot, accept only a reducer
/// transition whose canonical projection matches the optimistic fence, append
/// the matching event batch, and commit once. No method opens a second
/// connection or acknowledges a semantic write before `commit`.
pub trait CoreTransaction {
    /// Load and verify the snapshot for one command.
    fn load_command_snapshot(&mut self, command: &CoreCommand) -> StorageResult<CoreSnapshot>;

    /// Persist the reducer-produced transition inside the current transaction.
    fn compare_and_apply(&mut self, transition: &Transition) -> StorageResult<()>;

    /// Append the exact event batch produced by that transition.
    fn append_journal(&mut self, events: &[CoreEvent]) -> StorageResult<()>;

    /// Commit the accumulated state and journal changes.
    fn commit(self) -> StorageResult<()>;
}

/// Physical schema version for the reducer projection and journal.
pub const CORE_ENGINE_SCHEMA_VERSION: i64 = 1;

/// The tables owned by the Page/Activation transaction engine.
///
/// The semantic records remain in one canonical reducer projection so that the
/// production path and the reference vector runner share exactly one state
/// shape. The journal and operation table provide durable replay and audit
/// identities without making SQL callbacks a second reducer.
pub const CORE_ENGINE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS core_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
    state_hash TEXT NOT NULL,
    state_jcs BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS core_operations (
    command_id TEXT PRIMARY KEY NOT NULL,
    request_digest TEXT NOT NULL,
    transition_digest TEXT NOT NULL,
    transition_jcs BLOB NOT NULL,
    state_revision INTEGER NOT NULL CHECK (state_revision >= 0)
);
CREATE TABLE IF NOT EXISTS core_journal (
    journal_seq INTEGER PRIMARY KEY CHECK (journal_seq > 0),
    commit_seq INTEGER NOT NULL CHECK (commit_seq > 0),
    command_id TEXT NOT NULL,
    event_digest TEXT NOT NULL UNIQUE,
    event_jcs BLOB NOT NULL
);
"#;

const CORE_STATE_COLUMNS: &[&str] = &[
    "singleton",
    "schema_version",
    "state_revision",
    "state_hash",
    "state_jcs",
];
const CORE_OPERATION_COLUMNS: &[&str] = &[
    "command_id",
    "request_digest",
    "transition_digest",
    "transition_jcs",
    "state_revision",
];
const CORE_JOURNAL_COLUMNS: &[&str] = &[
    "journal_seq",
    "commit_seq",
    "command_id",
    "event_digest",
    "event_jcs",
];

/// Install and gate the reducer projection tables on an already-open
/// connection. Existing partial or malformed objects fail closed.
pub fn initialize_core_engine_schema(connection: &Connection) -> StorageResult<()> {
    let existing = existing_core_object_count(connection)?;
    if existing != 0 && existing != 3 {
        return Err(StorageError::MigrationRequired);
    }
    connection
        .execute_batch(CORE_ENGINE_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    verify_core_engine_schema(connection)?;
    ensure_initial_state(connection, existing == 0)
}

/// Transaction-local form used by the database initializer so the initial
/// reducer snapshot is installed atomically with the rest of the schema.
pub(crate) fn initialize_core_engine_schema_in_transaction(
    transaction: &Transaction<'_>,
) -> StorageResult<()> {
    let existing = existing_core_object_count(transaction)?;
    if existing != 0 && existing != 3 {
        return Err(StorageError::MigrationRequired);
    }
    transaction
        .execute_batch(CORE_ENGINE_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    verify_core_engine_schema(transaction)?;
    ensure_initial_state(transaction, existing == 0)
}

fn existing_core_object_count(connection: &Connection) -> StorageResult<i64> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE name IN ('core_state', 'core_operations', 'core_journal')",
            [],
            |row| row.get(0),
        )
        .map_err(map_sqlite_error)
}

fn verify_core_engine_schema(connection: &Connection) -> StorageResult<()> {
    verify_table_columns(connection, "core_state", CORE_STATE_COLUMNS)?;
    verify_table_columns(connection, "core_operations", CORE_OPERATION_COLUMNS)?;
    verify_table_columns(connection, "core_journal", CORE_JOURNAL_COLUMNS)?;
    Ok(())
}

fn verify_table_columns(
    connection: &Connection,
    table: &str,
    expected: &[&str],
) -> StorageResult<()> {
    let object_type: Option<String> = connection
        .query_row(
            "SELECT type FROM sqlite_master WHERE name = ?1",
            [table],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    if object_type.as_deref() != Some("table") {
        return Err(StorageError::MigrationRequired);
    }
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(map_sqlite_error)?;
    let actual = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(map_sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_sqlite_error)?;
    if actual != expected {
        return Err(StorageError::MigrationRequired);
    }
    Ok(())
}

fn ensure_initial_state(connection: &Connection, tables_were_new: bool) -> StorageResult<()> {
    let existing: Option<(i64, i64, String, Vec<u8>)> = connection
        .query_row(
            "SELECT schema_version, state_revision, state_hash, state_jcs
             FROM core_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    if existing.is_some() {
        return Ok(());
    }
    if !tables_were_new {
        return Err(StorageError::Corrupt);
    }
    let (bytes, digest) = encode_projection(&empty_core_snapshot())?;
    connection
        .execute(
            "INSERT INTO core_state
             (singleton, schema_version, state_revision, state_hash, state_jcs)
             VALUES (1, ?1, 0, ?2, ?3)",
            params![CORE_ENGINE_SCHEMA_VERSION, digest, bytes],
        )
        .map_err(map_sqlite_error)?;
    Ok(())
}

pub(crate) fn canonical_digest<T: Serialize>(value: &T) -> StorageResult<(Vec<u8>, String)> {
    let (bytes, digest) = canonicalize(value).map_err(|_| StorageError::Corrupt)?;
    Ok((bytes.into_vec(), digest.to_canonical_string()))
}

fn encode_projection(state: &CoreSnapshot) -> StorageResult<(Vec<u8>, String)> {
    canonical_digest(&project_core_state(state))
}

pub(crate) fn decode_canonical<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> StorageResult<T> {
    let value: Value = deserialize_core_json(
        bytes,
        ParseLimits::semantic(64).map_err(|_| StorageError::Corrupt)?,
    )
    .map_err(|_| StorageError::Corrupt)?;
    let (canonical, _) = canonicalize(&value).map_err(|_| StorageError::Corrupt)?;
    if canonical.as_bytes() != bytes {
        return Err(StorageError::Corrupt);
    }
    serde_json::from_value(value).map_err(|_| StorageError::Corrupt)
}

fn parse_digest(value: &str) -> StorageResult<Sha256Digest> {
    value.parse().map_err(|_| StorageError::Corrupt)
}

fn load_snapshot(connection: &Connection) -> StorageResult<(CoreSnapshot, i64, String)> {
    let (schema_version, state_revision, state_hash, state_bytes): (i64, i64, String, Vec<u8>) =
        connection
            .query_row(
                "SELECT schema_version, state_revision, state_hash, state_jcs
                 FROM core_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(map_sqlite_error)?;
    if schema_version != CORE_ENGINE_SCHEMA_VERSION || state_revision < 0 {
        return Err(StorageError::MigrationRequired);
    }
    let stored_digest = parse_digest(&state_hash)?;
    if stored_digest != Sha256Digest::compute(&state_bytes) {
        return Err(StorageError::Corrupt);
    }
    let mut full_value: Value = decode_canonical(&state_bytes)?;
    let Some(object) = full_value.as_object_mut() else {
        return Err(StorageError::Corrupt);
    };
    if object.contains_key("volatile_lossy_entries") {
        return Err(StorageError::Corrupt);
    }
    object.insert(
        "volatile_lossy_entries".into(),
        Value::Array(Vec::new()),
    );
    let snapshot: CoreSnapshot =
        serde_json::from_value(full_value).map_err(|_| StorageError::Corrupt)?;
    if snapshot.projection_kind != PROJECTION_KIND {
        return Err(StorageError::Corrupt);
    }
    let computed_hash = hash_core_state(&snapshot).map_err(|_| StorageError::Corrupt)?;
    if computed_hash != state_hash {
        return Err(StorageError::Corrupt);
    }
    verify_journal(connection, &snapshot)?;
    Ok((snapshot, state_revision, state_hash))
}

fn verify_journal(connection: &Connection, snapshot: &CoreSnapshot) -> StorageResult<()> {
    let mut statement = connection
        .prepare(
            "SELECT journal_seq, commit_seq, command_id, event_digest, event_jcs
             FROM core_journal ORDER BY journal_seq",
        )
        .map_err(map_sqlite_error)?;
    let mut rows = statement.query([]).map_err(map_sqlite_error)?;
    let mut events = Vec::new();
    while let Some(row) = rows.next().map_err(map_sqlite_error)? {
        let _journal_seq: i64 = row.get(0).map_err(map_sqlite_error)?;
        let commit_seq: i64 = row.get(1).map_err(map_sqlite_error)?;
        let command_id: String = row.get(2).map_err(map_sqlite_error)?;
        let event_digest: String = row.get(3).map_err(map_sqlite_error)?;
        let event_bytes: Vec<u8> = row.get(4).map_err(map_sqlite_error)?;
        let event: CoreEvent = decode_canonical(&event_bytes)?;
        let (_, computed_digest) = canonical_digest(&event)?;
        if computed_digest != event_digest
            || event.commit_seq != commit_seq
            || event.command_id != command_id
        {
            return Err(StorageError::Corrupt);
        }
        events.push(event);
    }
    if events != snapshot.journal {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

#[derive(Serialize)]
struct TransactionRequest<'a> {
    command: &'a CoreCommand,
    input: &'a EnvironmentInput,
}

/// A SQLite transaction carrying one reducer command and its optimistic fence.
pub struct SqliteCoreTransaction<'connection> {
    transaction: Option<Transaction<'connection>>,
    loaded_state: Option<CoreSnapshot>,
    loaded_state_revision: Option<i64>,
    loaded_state_hash: Option<String>,
    expected_command_id: Option<String>,
    request_digest: Option<String>,
    replay: Option<Transition>,
    expected_events: Option<Vec<CoreEvent>>,
    state_written: bool,
    operation_written: bool,
    journal_appended: bool,
}

impl<'connection> SqliteCoreTransaction<'connection> {
    /// Begin one immediate transaction on the single Core writer connection.
    pub fn begin(connection: &'connection mut Connection) -> StorageResult<Self> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        initialize_core_engine_schema_in_transaction(&transaction)?;
        Ok(Self {
            transaction: Some(transaction),
            loaded_state: None,
            loaded_state_revision: None,
            loaded_state_hash: None,
            expected_command_id: None,
            request_digest: None,
            replay: None,
            expected_events: None,
            state_written: false,
            operation_written: false,
            journal_appended: false,
        })
    }

    /// Begin a transaction with the complete Host-supplied request identity.
    ///
    /// The reducer still decides semantic authority. This digest only prevents
    /// a reused command ID from being paired with different environment or
    /// fence evidence after a commit.
    pub fn begin_for(
        connection: &'connection mut Connection,
        command: &CoreCommand,
        input: &EnvironmentInput,
    ) -> StorageResult<Self> {
        let (bytes, request_digest) = canonical_digest(&TransactionRequest { command, input })?;
        let _ = bytes;
        let mut transaction = Self::begin(connection)?;
        transaction.expected_command_id = Some(command.command_id().to_owned());
        transaction.request_digest = Some(request_digest);
        Ok(transaction)
    }

    /// Crate-private access to the live SQLite transaction so sibling storage
    /// slices (the Host ingress mapping) execute inside the same atomic
    /// commit without opening a second writer connection.
    /// Return the exact transition retained for an idempotent command replay.
    pub fn replayed_transition(&self) -> Option<&Transition> {
        self.replay.as_ref()
    }

    pub(crate) fn sql_transaction(&self) -> StorageResult<&Transaction<'connection>> {
        self.transaction.as_ref().ok_or(StorageError::Corrupt)
    }

    /// Crate-private mutating access to the live SQLite transaction.
    pub(crate) fn sql_transaction_mut(&mut self) -> StorageResult<&mut Transaction<'connection>> {
        self.transaction.as_mut().ok_or(StorageError::Corrupt)
    }

    fn transaction(&self) -> StorageResult<&Transaction<'connection>> {
        self.transaction.as_ref().ok_or(StorageError::Corrupt)
    }

    fn transaction_mut(&mut self) -> StorageResult<&mut Transaction<'connection>> {
        self.transaction.as_mut().ok_or(StorageError::Corrupt)
    }
}

impl CoreTransaction for SqliteCoreTransaction<'_> {
    fn load_command_snapshot(&mut self, command: &CoreCommand) -> StorageResult<CoreSnapshot> {
        if let Some(snapshot) = &self.loaded_state {
            if self.expected_command_id.as_deref() != Some(command.command_id()) {
                return Err(StorageError::IdempotencyConflict);
            }
            return Ok(snapshot.clone());
        }
        if self
            .expected_command_id
            .as_deref()
            .is_some_and(|id| id != command.command_id())
        {
            return Err(StorageError::IdempotencyConflict);
        }
        let (snapshot, state_revision, state_hash) = {
            let transaction = self.transaction()?;
            load_snapshot(transaction)?
        };
        let (_, command_digest) = canonical_digest(command)?;
        let request_digest = self.request_digest.clone().unwrap_or(command_digest);
        let existing: Option<(String, String, Vec<u8>)> = if command.command_id().is_empty() {
            None
        } else {
            self.transaction()?
                .query_row(
                    "SELECT request_digest, transition_digest, transition_jcs
                     FROM core_operations WHERE command_id = ?1",
                    [command.command_id()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(map_sqlite_error)?
        };
        if let Some((stored_request_digest, stored_transition_digest, transition_bytes)) = existing
        {
            if stored_request_digest != request_digest {
                return Err(StorageError::IdempotencyConflict);
            }
            let (_, computed_transition_digest) = canonical_digest(
                &decode_canonical::<Transition>(&transition_bytes)?,
            )?;
            if computed_transition_digest != stored_transition_digest {
                return Err(StorageError::Corrupt);
            }
            self.replay = Some(decode_canonical(&transition_bytes)?);
        }
        self.expected_command_id = Some(command.command_id().to_owned());
        self.request_digest = Some(request_digest);
        self.loaded_state_revision = Some(state_revision);
        self.loaded_state_hash = Some(state_hash);
        self.loaded_state = Some(snapshot.clone());
        Ok(snapshot)
    }

    fn compare_and_apply(&mut self, transition: &Transition) -> StorageResult<()> {
        if let Some(replayed) = &self.replay {
            if replayed != transition {
                return Err(StorageError::IdempotencyConflict);
            }
            self.expected_events = Some(Vec::new());
            return Ok(());
        }
        let loaded_state = self.loaded_state.as_ref().ok_or(StorageError::Corrupt)?;
        let expected_events = transition.events.clone();
        self.expected_events = Some(expected_events);
        if transition.outcome == TransitionOutcome::RolledBack {
            if transition.state != *loaded_state {
                return Err(StorageError::Corrupt);
            }
            if !self.operation_written
                && !self.expected_command_id.as_deref().unwrap_or("").is_empty()
            {
                let command_id = self
                    .expected_command_id
                    .clone()
                    .ok_or(StorageError::Corrupt)?;
                let request_digest = self.request_digest.clone().ok_or(StorageError::Corrupt)?;
                let (transition_bytes, transition_digest) = canonical_digest(transition)?;
                let state_revision = self.loaded_state_revision.ok_or(StorageError::Corrupt)?;
                self.transaction_mut()?
                    .execute(
                        "INSERT INTO core_operations
                         (command_id, request_digest, transition_digest, transition_jcs, state_revision)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            command_id,
                            request_digest,
                            transition_digest,
                            transition_bytes,
                            state_revision
                        ],
                    )
                    .map_err(map_sqlite_error)?;
                self.operation_written = true;
            }
            self.journal_appended = true;
            return Ok(());
        }
        let (state_bytes, state_hash) = encode_projection(&transition.state)?;
        if state_hash != transition.state_hash || transition.state.projection_kind != PROJECTION_KIND {
            return Err(StorageError::Corrupt);
        }
        let expected_loaded_hash = self.loaded_state_hash.as_ref().ok_or(StorageError::Corrupt)?;
        let (current_hash, current_revision): (String, i64) = self
            .transaction()?
            .query_row(
                "SELECT state_hash, state_revision FROM core_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(map_sqlite_error)?;
        if &current_hash != expected_loaded_hash {
            return Err(StorageError::SequenceConflict);
        }
        if current_revision != self.loaded_state_revision.ok_or(StorageError::Corrupt)? {
            return Err(StorageError::SequenceConflict);
        }
        let state_changed = current_hash != state_hash;
        let next_revision = if state_changed {
            current_revision.checked_add(1).ok_or(StorageError::SequenceConflict)?
        } else {
            current_revision
        };
        if state_changed {
            self.transaction_mut()?
                .execute(
                    "UPDATE core_state
                     SET state_revision = ?1, state_hash = ?2, state_jcs = ?3
                     WHERE singleton = 1",
                    params![next_revision, state_hash, state_bytes],
                )
                .map_err(map_sqlite_error)?;
            self.state_written = true;
        }
        if !self.operation_written && !self.expected_command_id.as_deref().unwrap_or("").is_empty()
        {
            let command_id = self
                .expected_command_id
                .clone()
                .ok_or(StorageError::Corrupt)?;
            let request_digest = self.request_digest.clone().ok_or(StorageError::Corrupt)?;
            let (transition_bytes, transition_digest) = canonical_digest(transition)?;
            self.transaction_mut()?
                .execute(
                    "INSERT INTO core_operations
                     (command_id, request_digest, transition_digest, transition_jcs, state_revision)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        command_id,
                        request_digest,
                        transition_digest,
                        transition_bytes,
                        next_revision
                    ],
                )
                .map_err(map_sqlite_error)?;
            self.operation_written = true;
        }
        Ok(())
    }

    fn append_journal(&mut self, events: &[CoreEvent]) -> StorageResult<()> {
        if let Some(replayed) = &self.replay {
            if events != replayed.events {
                return Err(StorageError::IdempotencyConflict);
            }
            self.journal_appended = true;
            return Ok(());
        }
        let expected = self.expected_events.as_ref().ok_or(StorageError::Corrupt)?;
        if expected != events {
            return Err(StorageError::Corrupt);
        }
        if self.journal_appended {
            return Err(StorageError::IdempotencyConflict);
        }
        if !self.state_written && !events.is_empty() {
            return Err(StorageError::Corrupt);
        }
        let mut next_journal_seq: i64 = self
            .transaction()?
            .query_row(
                "SELECT COALESCE(MAX(journal_seq), 0) + 1 FROM core_journal",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite_error)?;
        for event in events {
            if event.commit_seq <= 0 {
                return Err(StorageError::Corrupt);
            }
            let (event_bytes, event_digest) = canonical_digest(event)?;
            self.transaction_mut()?
                .execute(
                    "INSERT INTO core_journal
                     (journal_seq, commit_seq, command_id, event_digest, event_jcs)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        next_journal_seq,
                        event.commit_seq,
                        event.command_id,
                        event_digest,
                        event_bytes
                    ],
                )
                .map_err(map_sqlite_error)?;
            next_journal_seq = next_journal_seq
                .checked_add(1)
                .ok_or(StorageError::SequenceConflict)?;
        }
        self.journal_appended = true;
        Ok(())
    }

    fn commit(mut self) -> StorageResult<()> {
        if self.expected_events.as_ref().is_some_and(|events| {
            !events.is_empty() && !self.journal_appended && self.replay.is_none()
        }) {
            return Err(StorageError::Corrupt);
        }
        let transaction = self.transaction.take().ok_or(StorageError::Corrupt)?;
        transaction.commit().map_err(map_sqlite_error)
    }
}

/// Opaque authority returned for the currently verified Host connection.
///
/// Its fields and construction stay private so callers cannot choose a
/// connection identity, WorkerEpoch, or fence. The store checks this value
/// again inside the allocation transaction before changing durable state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostConnectionAuthority {
    identity: HostConnectionIdentity,
    worker_epoch: dolly_core_domain::WorkerEpoch,
    incarnation_revision: i64,
}

impl HostConnectionAuthority {
    /// The authenticated Extension connection identity.
    pub fn extension_connection_id(&self) -> &str {
        &self.identity.extension_connection_id
    }

    /// The authenticated typed WorkerEpoch.
    pub fn worker_epoch(&self) -> &dolly_core_domain::WorkerEpoch {
        &self.worker_epoch
    }

    /// The authenticated numeric WorkerEpoch fence.
    pub fn worker_epoch_fence(&self) -> i64 {
        self.identity.worker_epoch_fence
    }

    /// The non-reusable Host incarnation revision.
    pub fn incarnation_revision(&self) -> i64 {
        self.incarnation_revision
    }
}
/// Schema for the Host-owned capability grant table.
pub const HOST_CAPABILITY_GRANT_RECORD_SCHEMA: &str =
    "dolly.host-capability-grant/v1";
const HOST_CAPABILITY_GRANT_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS host_capability_grants (
    extension_id TEXT NOT NULL,
    module_id TEXT NOT NULL,
    grant_revision INTEGER NOT NULL CHECK (grant_revision BETWEEN 1 AND 9007199254740991),
    grant_digest TEXT NOT NULL,
    extension_connection_id TEXT NOT NULL,
    worker_epoch TEXT NOT NULL,
    worker_epoch_fence INTEGER NOT NULL CHECK (worker_epoch_fence BETWEEN 1 AND 9007199254740991),
    incarnation_revision INTEGER NOT NULL CHECK (incarnation_revision BETWEEN 1 AND 9007199254740991),
    extension_generation INTEGER NOT NULL CHECK (extension_generation BETWEEN 1 AND 9007199254740991),
    descriptor_revision INTEGER NOT NULL CHECK (descriptor_revision BETWEEN 1 AND 9007199254740991),
    descriptor_digest TEXT NOT NULL,
    manifest_revision INTEGER NOT NULL CHECK (manifest_revision BETWEEN 1 AND 9007199254740991),
    manifest_digest TEXT NOT NULL,
    graph_revision INTEGER NOT NULL CHECK (graph_revision BETWEEN 1 AND 9007199254740991),
    graph_digest TEXT NOT NULL,
    methods_jcs BLOB NOT NULL,
    revoked INTEGER NOT NULL CHECK (revoked IN (0, 1)),
    record_jcs BLOB NOT NULL,
    PRIMARY KEY (extension_id, module_id)
);
"#;
const HOST_CAPABILITY_GRANT_COLUMNS: &[&str] = &[
    "extension_id",
    "module_id",
    "grant_revision",
    "grant_digest",
    "extension_connection_id",
    "worker_epoch",
    "worker_epoch_fence",
    "incarnation_revision",
    "extension_generation",
    "descriptor_revision",
    "descriptor_digest",
    "manifest_revision",
    "manifest_digest",
    "graph_revision",
    "graph_digest",
    "methods_jcs",
    "revoked",
    "record_jcs",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct StoredHostCapabilityGrant {
    schema: String,
    extension_id: String,
    module_id: String,
    extension_connection_id: String,
    worker_epoch: String,
    worker_epoch_fence: i64,
    incarnation_revision: i64,
    extension_generation: i64,
    descriptor_revision: i64,
    descriptor_digest: String,
    manifest_revision: i64,
    manifest_digest: String,
    graph_revision: i64,
    graph_digest: String,
    grant_revision: i64,
    methods: Vec<String>,
    revoked: bool,
}

/// A sealed Host grant loaded from the dedicated durable grant table.
///
/// The type has no public constructor, clone, or deserializer. It can only be
/// returned by a store after the current opaque Host authority was verified.
#[derive(Debug, PartialEq, Eq)]
pub struct HostCapabilityGrant {
    record: StoredHostCapabilityGrant,
    grant_digest: String,
}

impl HostCapabilityGrant {
    pub fn extension_id(&self) -> &str {
        &self.record.extension_id
    }

    pub fn module_id(&self) -> &str {
        &self.record.module_id
    }

    pub fn extension_connection_id(&self) -> &str {
        &self.record.extension_connection_id
    }

    pub fn worker_epoch(&self) -> &str {
        &self.record.worker_epoch
    }

    pub fn worker_epoch_fence(&self) -> i64 {
        self.record.worker_epoch_fence
    }

    pub fn incarnation_revision(&self) -> i64 {
        self.record.incarnation_revision
    }

    pub fn extension_generation(&self) -> i64 {
        self.record.extension_generation
    }

    pub fn descriptor_revision(&self) -> i64 {
        self.record.descriptor_revision
    }

    pub fn descriptor_digest(&self) -> &str {
        &self.record.descriptor_digest
    }

    pub fn manifest_revision(&self) -> i64 {
        self.record.manifest_revision
    }

    pub fn manifest_digest(&self) -> &str {
        &self.record.manifest_digest
    }

    pub fn graph_revision(&self) -> i64 {
        self.record.graph_revision
    }

    pub fn graph_digest(&self) -> &str {
        &self.record.graph_digest
    }

    pub fn grant_revision(&self) -> i64 {
        self.record.grant_revision
    }

    pub fn grant_digest(&self) -> &str {
        &self.grant_digest
    }

    pub fn allows(&self, method: &str) -> bool {
        self.record.methods.iter().any(|candidate| candidate == method)
    }
}

fn ensure_host_capability_grant_schema(connection: &Connection) -> StorageResult<()> {
    connection
        .execute_batch(HOST_CAPABILITY_GRANT_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    verify_table_columns(
        connection,
        "host_capability_grants",
        HOST_CAPABILITY_GRANT_COLUMNS,
    )
}

fn valid_grant_method(method: &str) -> bool {
    !method.is_empty()
        && method.len() <= 160
        && method.starts_with("host.")
        && method.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn validate_grant_text(value: &str) -> StorageResult<()> {
    if value.is_empty() || value.len() > 256 || value.contains('\0') {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

fn validate_grant_digest(value: &str) -> StorageResult<()> {
    let digest: Sha256Digest = value.parse().map_err(|_| StorageError::Corrupt)?;
    if digest.to_canonical_string() != value {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

fn validate_grant_methods(methods: &[&str]) -> StorageResult<Vec<String>> {
    let mut normalized = methods
        .iter()
        .map(|method| {
            if !valid_grant_method(method) {
                return Err(StorageError::Corrupt);
            }
            Ok((*method).to_owned())
        })
        .collect::<StorageResult<Vec<_>>>()?;
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

fn validate_host_capability_grant_input(
    extension_id: &str,
    module_id: &str,
    extension_generation: i64,
    descriptor_revision: i64,
    descriptor_digest: &str,
    manifest_revision: i64,
    manifest_digest: &str,
    graph_revision: i64,
    graph_digest: &str,
    methods: &[&str],
) -> StorageResult<()> {
    validate_grant_text(extension_id)?;
    validate_grant_text(module_id)?;
    for revision in [
        extension_generation,
        descriptor_revision,
        manifest_revision,
        graph_revision,
    ] {
        if !(1..=CORE_MAX_SAFE_INTEGER).contains(&revision) {
            return Err(StorageError::Corrupt);
        }
    }
    for digest in [descriptor_digest, manifest_digest, graph_digest] {
        validate_grant_digest(digest)?;
    }
    validate_grant_methods(methods)?;
    Ok(())
}

fn persist_host_capability_grant(
    transaction: &Transaction<'_>,
    record: &StoredHostCapabilityGrant,
) -> StorageResult<()> {
    let (methods_jcs, _) = canonical_digest(&record.methods)?;
    let (record_jcs, grant_digest) = canonical_digest(record)?;
    transaction
        .execute(
            "INSERT INTO host_capability_grants (
                extension_id, module_id, grant_revision, grant_digest,
                extension_connection_id, worker_epoch, worker_epoch_fence,
                incarnation_revision, extension_generation, descriptor_revision,
                descriptor_digest, manifest_revision, manifest_digest,
                graph_revision, graph_digest, methods_jcs, revoked, record_jcs
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17, ?18
             )
             ON CONFLICT(extension_id, module_id) DO UPDATE SET
                grant_revision = excluded.grant_revision,
                grant_digest = excluded.grant_digest,
                extension_connection_id = excluded.extension_connection_id,
                worker_epoch = excluded.worker_epoch,
                worker_epoch_fence = excluded.worker_epoch_fence,
                incarnation_revision = excluded.incarnation_revision,
                extension_generation = excluded.extension_generation,
                descriptor_revision = excluded.descriptor_revision,
                descriptor_digest = excluded.descriptor_digest,
                manifest_revision = excluded.manifest_revision,
                manifest_digest = excluded.manifest_digest,
                graph_revision = excluded.graph_revision,
                graph_digest = excluded.graph_digest,
                methods_jcs = excluded.methods_jcs,
                revoked = excluded.revoked,
                record_jcs = excluded.record_jcs",
            params![
                record.extension_id,
                record.module_id,
                record.grant_revision,
                grant_digest,
                record.extension_connection_id,
                record.worker_epoch,
                record.worker_epoch_fence,
                record.incarnation_revision,
                record.extension_generation,
                record.descriptor_revision,
                record.descriptor_digest,
                record.manifest_revision,
                record.manifest_digest,
                record.graph_revision,
                record.graph_digest,
                methods_jcs,
                i64::from(record.revoked),
                record_jcs,
            ],
        )
        .map_err(map_sqlite_error)?;
    Ok(())
}

fn load_host_capability_grant_row(
    connection: &Connection,
    extension_id: &str,
    module_id: &str,
) -> StorageResult<Option<HostCapabilityGrant>> {
    let row: Option<(
        String,
        String,
        i64,
        String,
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        String,
        i64,
        String,
        i64,
        String,
        Vec<u8>,
        i64,
        Vec<u8>,
    )> = connection
        .query_row(
            "SELECT extension_id, module_id, grant_revision, grant_digest,
                    extension_connection_id, worker_epoch, worker_epoch_fence,
                    incarnation_revision, extension_generation, descriptor_revision,
                    descriptor_digest, manifest_revision, manifest_digest,
                    graph_revision, graph_digest, methods_jcs, revoked, record_jcs
             FROM host_capability_grants
             WHERE extension_id = ?1 AND module_id = ?2",
            params![extension_id, module_id],
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
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    row.get(14)?,
                    row.get(15)?,
                    row.get(16)?,
                    row.get(17)?,
                ))
            },
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some((
        row_extension_id,
        row_module_id,
        row_grant_revision,
        row_grant_digest,
        row_extension_connection_id,
        row_worker_epoch,
        row_worker_epoch_fence,
        row_incarnation_revision,
        row_extension_generation,
        row_descriptor_revision,
        row_descriptor_digest,
        row_manifest_revision,
        row_manifest_digest,
        row_graph_revision,
        row_graph_digest,
        methods_jcs,
        row_revoked,
        record_jcs,
    )) = row
    else {
        return Ok(None);
    };
    let record: StoredHostCapabilityGrant = decode_canonical(&record_jcs)?;
    let (record_bytes, record_digest) = canonical_digest(&record)?;
    if record_bytes != record_jcs
        || record_digest != row_grant_digest
        || record.schema != HOST_CAPABILITY_GRANT_RECORD_SCHEMA
        || record.extension_id != row_extension_id
        || record.module_id != row_module_id
        || record.extension_connection_id != row_extension_connection_id
        || record.worker_epoch != row_worker_epoch
        || record.worker_epoch_fence != row_worker_epoch_fence
        || record.incarnation_revision != row_incarnation_revision
        || record.extension_generation != row_extension_generation
        || record.descriptor_revision != row_descriptor_revision
        || record.descriptor_digest != row_descriptor_digest
        || record.manifest_revision != row_manifest_revision
        || record.manifest_digest != row_manifest_digest
        || record.graph_revision != row_graph_revision
        || record.graph_digest != row_graph_digest
        || record.revoked != (row_revoked != 0)
        || record.grant_revision != row_grant_revision
        || record.methods.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(StorageError::Corrupt);
    }
    let (methods_bytes, _) = canonical_digest(&record.methods)?;
    if methods_bytes != methods_jcs {
        return Err(StorageError::Corrupt);
    }
    for digest in [
        record.descriptor_digest.as_str(),
        record.manifest_digest.as_str(),
        record.graph_digest.as_str(),
    ] {
        validate_grant_digest(digest)?;
    }
    Ok(Some(HostCapabilityGrant {
        record,
        grant_digest: row_grant_digest,
    }))
}
fn load_current_host_capability_grant(
    transaction: &Transaction<'_>,
    authority: &HostConnectionAuthority,
    extension_id: &str,
    module_id: &str,
    expected_grant: Option<(i64, &str)>,
) -> StorageResult<Option<HostCapabilityGrant>> {
    let snapshot = load_snapshot(transaction)?.0;
    if host_connection_authority_from_snapshot(&snapshot)? != *authority {
        return Err(StorageError::IdempotencyConflict);
    }
    let Some(grant) = load_host_capability_grant_row(transaction, extension_id, module_id)? else {
        return Ok(None);
    };
    if grant.record.revoked {
        return Ok(None);
    }
    let worker_epoch = authority.worker_epoch().to_string();
    if grant.extension_id() != extension_id
        || grant.module_id() != module_id
        || grant.extension_connection_id() != authority.extension_connection_id()
        || grant.worker_epoch() != worker_epoch
        || grant.worker_epoch_fence() != authority.worker_epoch_fence()
        || grant.incarnation_revision() != authority.incarnation_revision()
    {
        return Ok(None);
    }
    if let Some((expected_revision, expected_digest)) = expected_grant {
        if grant.grant_revision() != expected_revision
            || grant.grant_digest() != expected_digest
        {
            return Ok(None);
        }
    }
    Ok(Some(grant))
}

fn host_connection_identity_from_snapshot(
    snapshot: &CoreSnapshot,
) -> StorageResult<HostConnectionIdentity> {
    let config = snapshot
        .config
        .get("effective_config")
        .unwrap_or(&snapshot.config);
    let extension_connection_id = config
        .get("extension_connection_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(StorageError::Corrupt)?
        .to_owned();
    let worker_epoch_id = config
        .get("worker_epoch")
        .and_then(Value::as_str)
        .ok_or(StorageError::Corrupt)?
        .to_owned();
    worker_epoch_id
        .parse::<dolly_core_domain::WorkerEpoch>()
        .map_err(|_| StorageError::Corrupt)?;
    let worker_epoch_fence = config
        .get("worker_epoch_fence")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or(StorageError::Corrupt)?;
    Ok(HostConnectionIdentity {
        extension_connection_id,
        worker_epoch_id,
        worker_epoch_fence,
    })
}

fn host_connection_authority_from_snapshot(
    snapshot: &CoreSnapshot,
) -> StorageResult<HostConnectionAuthority> {
    let record = snapshot.host_connection.as_ref().ok_or(StorageError::Corrupt)?;
    if record.incarnation_revision <= 0
        || !snapshot.host_connection_history.contains(&record.identity)
    {
        return Err(StorageError::Corrupt);
    }
    let worker_epoch = record
        .identity
        .worker_epoch_id
        .parse::<dolly_core_domain::WorkerEpoch>()
        .map_err(|_| StorageError::Corrupt)?;
    if record.identity.extension_connection_id.is_empty()
        || record.identity.worker_epoch_fence <= 0
    {
        return Err(StorageError::Corrupt);
    }
    Ok(HostConnectionAuthority {
        identity: record.identity.clone(),
        worker_epoch,
        incarnation_revision: record.incarnation_revision,
    })
}

const CORE_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn allocation_failure_with_details(
    state: &CoreSnapshot,
    code: &str,
    details: Option<Value>,
) -> StorageResult<Transition> {
    let projection = project_core_state(state);
    let state_hash = hash_core_state(state).map_err(|_| StorageError::Corrupt)?;
    Ok(Transition {
        outcome: TransitionOutcome::RolledBack,
        state: state.clone(),
        events: Vec::new(),
        error: Some(CoreError {
            code: code.into(),
            retryable: false,
            outcome: ErrorOutcome::NotApplied,
            details,
        }),
        reply: None,
        projection,
        state_hash,
        safety_stop: None,
    })
}

fn allocation_failure(state: &CoreSnapshot, code: &str) -> StorageResult<Transition> {
    allocation_failure_with_details(state, code, None)
}
fn host_connection_transition(
    state: &CoreSnapshot,
    command_id: &str,
    identity: HostConnectionIdentity,
    incarnation_revision: i64,
    event_name: &str,
) -> StorageResult<Transition> {
    if command_id.is_empty()
        || incarnation_revision <= 0
        || state.next_commit_seq <= 0
        || state.next_commit_seq >= CORE_MAX_SAFE_INTEGER
    {
        return allocation_failure(state, "HOST_CONNECTION_STATE_INVALID");
    }
    let mut next = state.clone();
    next.host_connection = Some(HostConnectionRecord {
        identity: identity.clone(),
        incarnation_revision,
    });
    next.host_connection_history.insert(identity.clone());
    let event = CoreEvent {
        event: event_name.into(),
        commit_seq: next.next_commit_seq,
        command_id: command_id.into(),
        details: Some(serde_json::json!({
            "extension_connection_id": identity.extension_connection_id,
            "worker_epoch_id": identity.worker_epoch_id,
            "worker_epoch_fence": identity.worker_epoch_fence,
            "incarnation_revision": incarnation_revision,
        })),
    };
    next.next_commit_seq += 1;
    next.journal.push(event.clone());
    let projection = project_core_state(&next);
    let state_hash = hash_core_state(&next).map_err(|_| StorageError::Corrupt)?;
    Ok(Transition {
        outcome: TransitionOutcome::Committed,
        state: next,
        events: vec![event],
        error: None,
        reply: None,
        projection,
        state_hash,
        safety_stop: None,
    })
}

fn host_lifecycle_command(
    command_id: String,
    event_key: &str,
    block: Value,
) -> StorageResult<CoreCommand> {
    let (_, operation_digest) = canonical_digest(&block)?;
    Ok(CoreCommand::RuntimeEvent(RuntimeEventCommand {
        command_id: command_id.clone(),
        runtime_source: "host".into(),
        event_key: event_key.into(),
        operation_digest,
        block_id: command_id,
        block,
        pages: Vec::new(),
    }))
}


fn host_authority_matches(
    snapshot: &CoreSnapshot,
    extension_connection_id: &str,
    worker_epoch_id: &str,
    worker_epoch_fence: i64,
    incarnation_revision: i64,
) -> StorageResult<bool> {
    let authority = host_connection_authority_from_snapshot(snapshot)?;
    Ok(authority.extension_connection_id() == extension_connection_id
        && authority.worker_epoch().to_string() == worker_epoch_id
        && authority.worker_epoch_fence() == worker_epoch_fence
        && authority.incarnation_revision() == incarnation_revision)
}

pub fn allocate_host_request_transition(
    state: &CoreSnapshot,
    command_id: &str,
    authority: &HostConnectionAuthority,
    activation_id: &str,
    lease_id: &str,
    input: &EnvironmentInput,
) -> StorageResult<Transition> {
    if state.next_commit_seq <= 0 || state.next_commit_seq > CORE_MAX_SAFE_INTEGER {
        return allocation_failure(state, "CORE_STATE_COUNTER_INVALID");
    }
    if state.mode == InstanceMode::RecoveryRequired {
        return allocation_failure(state, "RECOVERY_REQUIRED");
    }
    if input.storage_observation == Some(StorageObservation::BeforeCommit) {
        return allocation_failure_with_details(
            state,
            "SIMULATED_CRASH",
            input
                .crash_point
                .as_ref()
                .map(|label| serde_json::json!({"crash_point": label})),
        );
    }
    if state.next_commit_seq == CORE_MAX_SAFE_INTEGER {
        return allocation_failure(state, "COMMIT_SEQUENCE_EXHAUSTED");
    }
    if command_id.is_empty()
        || activation_id.is_empty()
        || lease_id.is_empty()
        || authority.extension_connection_id().is_empty()
        || authority.worker_epoch_fence() <= 0
    {
        return allocation_failure(state, "REQUEST_ALLOCATION_INVALID");
    }
    let Some(item) = state.activations.get(activation_id) else {
        return allocation_failure(state, "ACTIVATION_NOT_LEASABLE");
    };
    if item.state != ActivationState::Ready || item.manifest.is_none() {
        return allocation_failure(state, "ACTIVATION_NOT_LEASABLE");
    }
    if state.leases.contains_key(lease_id)
        || state.host_request_reservations.values().any(|record| {
            record.get("state").and_then(Value::as_str) == Some("bound")
                && record.get("activation_id").and_then(Value::as_str) == Some(activation_id)
        })
    {
        return allocation_failure(state, "REQUEST_RESERVATION_CONFLICT");
    }
    let sequence = state.next_commit_seq;
    let request_id = format!("rpc-{sequence}");
    let reservation_id = format!("host-request-{sequence}");
    if request_id.is_empty()
        || request_id.len() > 128
        || request_id.contains('\0')
        || state.host_request_reservations.contains_key(&reservation_id)
        || state.host_request_reservations.values().any(|record| {
            record.get("state").and_then(Value::as_str) == Some("bound")
                && record.get("request_id").and_then(Value::as_str) == Some(request_id.as_str())
                && record.get("extension_connection_id").and_then(Value::as_str)
                    == Some(authority.extension_connection_id())
        })
    {
        return allocation_failure(state, "REQUEST_ALLOCATION_INVALID");
    }
    let worker_epoch_id = authority.worker_epoch().to_string();
    let mut next = state.clone();
    next.host_request_reservations.insert(
        reservation_id.clone(),
        serde_json::json!({
            "state": "bound",
            "allocation_command_id": command_id,
            "activation_id": activation_id,
            "lease_id": lease_id,
            "request_id": request_id,
            "extension_connection_id": authority.extension_connection_id(),
            "worker_epoch_id": worker_epoch_id,
            "worker_epoch": authority.worker_epoch_fence(),
            "incarnation_revision": authority.incarnation_revision(),
        }),
    );
    let event = CoreEvent {
        event: "HostRequestAllocated".into(),
        commit_seq: next.next_commit_seq,
        command_id: command_id.into(),
        details: Some(serde_json::json!({
            "reservation_id": reservation_id,
            "request_id": request_id,
            "extension_connection_id": authority.extension_connection_id(),
            "worker_epoch_id": worker_epoch_id,
            "incarnation_revision": authority.incarnation_revision(),
        })),
    };
    next.next_commit_seq += 1;
    next.journal.push(event.clone());
    let projection = project_core_state(&next);
    let state_hash = hash_core_state(&next).map_err(|_| StorageError::Corrupt)?;
    Ok(Transition {
        outcome: TransitionOutcome::Committed,
        state: next,
        events: vec![event],
        error: None,
        reply: Some(serde_json::json!({
            "reservation_id": reservation_id,
            "request_id": request_id,
        })),
        projection,
        state_hash,
        safety_stop: None,
    })
}

/// One request-scoped transactional activation.
///
/// Holds one immediate SQLite write transaction for the whole request: Host
/// authority and grant validation, manifest acceptance, request allocation,
/// lease issue, dispatch/journal, and the final G2 admission all execute
/// inside it and commit once via [`Self::commit`]. Dropping without commit
/// rolls back every request-owned activation, lease, journal, reservation,
/// and operation row, so a daemon kill at any stage leaves no durable partial
/// activation and no fence residue. The immediate transaction also holds the
/// database write lock, which serializes grant replace/revoke commits from
/// any other connection against this activation.
pub struct ActivationTransaction<'connection> {
    transaction: Option<Transaction<'connection>>,
}

impl<'connection> ActivationTransaction<'connection> {
    /// Begin one immediate activation transaction and initialize the Core
    /// schema inside it.
    pub fn begin(connection: &'connection mut Connection) -> StorageResult<Self> {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        initialize_core_engine_schema_in_transaction(&transaction)?;
        Ok(Self {
            transaction: Some(transaction),
        })
    }

    fn transaction(&self) -> StorageResult<&Transaction<'connection>> {
        self.transaction.as_ref().ok_or(StorageError::Corrupt)
    }

    fn transaction_mut(&mut self) -> StorageResult<&mut Transaction<'connection>> {
        self.transaction.as_mut().ok_or(StorageError::Corrupt)
    }

    /// The verified snapshot as of the last step of this transaction,
    /// including its own uncommitted writes.
    pub fn snapshot(&self) -> StorageResult<CoreSnapshot> {
        load_snapshot(self.transaction()?).map(|(snapshot, _, _)| snapshot)
    }

    /// The exact current Host authority inside this transaction.
    pub fn authority(&self) -> StorageResult<HostConnectionAuthority> {
        let (snapshot, _, _) = load_snapshot(self.transaction()?)?;
        host_connection_authority_from_snapshot(&snapshot)
    }

    /// The current active grant inside this transaction.
    pub fn current_grant(
        &self,
        authority: &HostConnectionAuthority,
        extension_id: &str,
        module_id: &str,
    ) -> StorageResult<Option<HostCapabilityGrant>> {
        load_current_host_capability_grant(
            self.transaction()?,
            authority,
            extension_id,
            module_id,
            None,
        )
    }

    /// Reduce and persist one Core command as the next step of this
    /// activation. An exact command replay returns the retained transition
    /// without writing another state revision, operation, or journal row.
    pub fn apply(
        &mut self,
        command: &CoreCommand,
        input: &EnvironmentInput,
    ) -> StorageResult<Transition> {
        let (snapshot, state_revision, state_hash) = load_snapshot(self.transaction()?)?;
        let transition = reduce(&snapshot, command, input);
        self.write_transition(command, input, transition, &snapshot, &state_hash, state_revision)
    }

    /// Persist a caller-built transition (for example the storage
    /// request-allocation transition) as the next step of this activation.
    /// Replay identity and journaling behave exactly like [`Self::apply`].
    pub fn apply_with_transition(
        &mut self,
        command: &CoreCommand,
        input: &EnvironmentInput,
        transition: Transition,
    ) -> StorageResult<Transition> {
        let (snapshot, state_revision, state_hash) = load_snapshot(self.transaction()?)?;
        self.write_transition(
            command,
            input,
            transition,
            &snapshot,
            &state_hash,
            state_revision,
        )
    }

    fn write_transition(
        &mut self,
        command: &CoreCommand,
        input: &EnvironmentInput,
        transition: Transition,
        snapshot: &CoreSnapshot,
        state_hash: &str,
        state_revision: i64,
    ) -> StorageResult<Transition> {
        let (_, request_digest) = canonical_digest(&TransactionRequest { command, input })?;
        let command_id = command.command_id().to_owned();
        if !command_id.is_empty() {
            let existing: Option<(String, String, Vec<u8>)> = self
                .transaction()?
                .query_row(
                    "SELECT request_digest, transition_digest, transition_jcs
                     FROM core_operations WHERE command_id = ?1",
                    [&command_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            if let Some((stored_request_digest, stored_transition_digest, transition_bytes)) =
                existing
            {
                if stored_request_digest != request_digest {
                    return Err(StorageError::IdempotencyConflict);
                }
                let replayed = decode_canonical::<Transition>(&transition_bytes)?;
                let (_, computed_transition_digest) = canonical_digest(&replayed)?;
                if computed_transition_digest != stored_transition_digest {
                    return Err(StorageError::Corrupt);
                }
                return Ok(replayed);
            }
        }
        if transition.outcome == TransitionOutcome::RolledBack {
            if transition.state != *snapshot {
                return Err(StorageError::Corrupt);
            }
            if !command_id.is_empty() {
                let (transition_bytes, transition_digest) = canonical_digest(&transition)?;
                self.transaction_mut()?
                    .execute(
                        "INSERT INTO core_operations
                         (command_id, request_digest, transition_digest, transition_jcs, state_revision)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            command_id,
                            request_digest,
                            transition_digest,
                            transition_bytes,
                            state_revision
                        ],
                    )
                    .map_err(map_sqlite_error)?;
            }
            return Ok(transition);
        }
        let state_changed =
            self.persist_committed(&command_id, &request_digest, &transition, state_hash, state_revision)?;
        self.append_journal(&transition.events, state_changed)?;
        Ok(transition)
    }

    fn persist_committed(
        &mut self,
        command_id: &str,
        request_digest: &str,
        transition: &Transition,
        expected_state_hash: &str,
        expected_state_revision: i64,
    ) -> StorageResult<bool> {
        let (state_bytes, state_hash) = encode_projection(&transition.state)?;
        if state_hash != transition.state_hash
            || transition.state.projection_kind != PROJECTION_KIND
        {
            return Err(StorageError::Corrupt);
        }
        let (current_hash, current_revision): (String, i64) = self
            .transaction()?
            .query_row(
                "SELECT state_hash, state_revision FROM core_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(map_sqlite_error)?;
        if &current_hash != expected_state_hash || current_revision != expected_state_revision {
            return Err(StorageError::SequenceConflict);
        }
        let state_changed = current_hash != state_hash;
        let next_revision = if state_changed {
            expected_state_revision
                .checked_add(1)
                .ok_or(StorageError::SequenceConflict)?
        } else {
            expected_state_revision
        };
        if state_changed {
            self.transaction_mut()?
                .execute(
                    "UPDATE core_state
                     SET state_revision = ?1, state_hash = ?2, state_jcs = ?3
                     WHERE singleton = 1",
                    params![next_revision, state_hash, state_bytes],
                )
                .map_err(map_sqlite_error)?;
        }
        if !command_id.is_empty() {
            let (transition_bytes, transition_digest) = canonical_digest(transition)?;
            self.transaction_mut()?
                .execute(
                    "INSERT INTO core_operations
                     (command_id, request_digest, transition_digest, transition_jcs, state_revision)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        command_id,
                        request_digest,
                        transition_digest,
                        transition_bytes,
                        next_revision
                    ],
                )
                .map_err(map_sqlite_error)?;
        }
        Ok(state_changed)
    }

    fn append_journal(&mut self, events: &[CoreEvent], state_changed: bool) -> StorageResult<()> {
        if !state_changed && !events.is_empty() {
            return Err(StorageError::Corrupt);
        }
        let mut next_journal_seq: i64 = self
            .transaction()?
            .query_row(
                "SELECT COALESCE(MAX(journal_seq), 0) + 1 FROM core_journal",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite_error)?;
        for event in events {
            if event.commit_seq <= 0 {
                return Err(StorageError::Corrupt);
            }
            let (event_bytes, event_digest) = canonical_digest(event)?;
            self.transaction_mut()?
                .execute(
                    "INSERT INTO core_journal
                     (journal_seq, commit_seq, command_id, event_digest, event_jcs)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        next_journal_seq,
                        event.commit_seq,
                        event.command_id,
                        event_digest,
                        event_bytes
                    ],
                )
                .map_err(map_sqlite_error)?;
            next_journal_seq = next_journal_seq
                .checked_add(1)
                .ok_or(StorageError::SequenceConflict)?;
        }
        Ok(())
    }

    /// Commit the whole activation atomically.
    pub fn commit(self) -> StorageResult<()> {
        let transaction = self.transaction.ok_or(StorageError::Corrupt)?;
        transaction.commit().map_err(map_sqlite_error)
    }
}

/// Build the immutable Host request allocation Core command for one
/// activation step. The identity is derived from the current snapshot, so it
/// can be composed into the request-scoped [`ActivationTransaction`].
pub fn host_request_allocation_command(
    snapshot: &CoreSnapshot,
    authority: &HostConnectionAuthority,
    activation_id: &str,
    lease_id: &str,
) -> StorageResult<CoreCommand> {
    let command_id = format!(
        "runtime-host-request-allocation-{}",
        snapshot.next_commit_seq
    );
    let block = serde_json::json!({
        "activation_id": activation_id,
        "lease_id": lease_id,
        "extension_connection_id": authority.extension_connection_id(),
        "worker_epoch_id": authority.worker_epoch().to_string(),
        "worker_epoch": authority.worker_epoch_fence(),
        "incarnation_revision": authority.incarnation_revision(),
    });
    host_lifecycle_command(command_id, "host_request_allocation", block)
}

/// The production Core store façade. It keeps semantic transitions on the
/// reducer path and exposes only one mutable SQLite writer reference.
pub struct SqliteCoreStore<'connection> {
    connection: &'connection mut Connection,
}

impl<'connection> SqliteCoreStore<'connection> {
    /// Create a store over a verified writable Runtime connection.
    pub fn new(connection: &'connection mut Connection) -> StorageResult<Self> {
        initialize_core_engine_schema(connection)?;
        crate::module_state::initialize_module_storage_schema(connection)?;
        Ok(Self { connection })
    }

    /// Execute one command atomically and return its committed or rolled-back
    /// transition. An exact command replay returns the retained transition
    /// without allocating another state revision, journal row, or delivery.
    pub fn transact(
        &mut self,
        command: &CoreCommand,
        input: &EnvironmentInput,
    ) -> StorageResult<Transition> {
        let mut transaction = SqliteCoreTransaction::begin_for(self.connection, command, input)?;
        let snapshot = transaction.load_command_snapshot(command)?;
        match command {
            CoreCommand::IssueLease(command) if command.reservation_id.is_some() => {
                let (Some(connection_id), Some(worker_epoch_id), Some(revision)) = (
                    Some(command.extension_connection_id.as_str()),
                    command.worker_epoch_id.as_deref(),
                    command.incarnation_revision,
                ) else {
                    return Err(StorageError::IdempotencyConflict);
                };
                if !host_authority_matches(
                    &snapshot,
                    connection_id,
                    worker_epoch_id,
                    command.worker_epoch,
                    revision,
                )? {
                    return Err(StorageError::IdempotencyConflict);
                }
            }
            CoreCommand::DispatchLease(command) if command.reservation_id.is_some() => {
                let Some(lease) = snapshot.leases.get(&command.lease_id) else {
                    return Err(StorageError::IdempotencyConflict);
                };
                let (Some(connection_id), Some(revision), Some(worker_epoch_id), Some(fence)) = (
                    command.extension_connection_id.as_deref(),
                    command.incarnation_revision,
                    lease.get("worker_epoch_id").and_then(Value::as_str),
                    lease.get("worker_epoch").and_then(Value::as_i64),
                ) else {
                    return Err(StorageError::IdempotencyConflict);
                };
                if !host_authority_matches(
                    &snapshot,
                    connection_id,
                    worker_epoch_id,
                    fence,
                    revision,
                )? {
                    return Err(StorageError::IdempotencyConflict);
                }
            }
            _ => {}
        }
        if let Some(replayed) = transaction.replayed_transition().cloned() {
            transaction.commit()?;
            return Ok(replayed);
        }
        let transition = reduce(&snapshot, command, input);
        transaction.compare_and_apply(&transition)?;
        if transition.outcome != TransitionOutcome::RolledBack {
            transaction.append_journal(&transition.events)?;
        }
        transaction.commit()?;
        Ok(transition)
    }
    /// Bootstrap the dedicated Host connection state from the accepted
    /// lifecycle configuration, without changing it when already initialized.
    pub fn bootstrap_host_connection(&mut self) -> StorageResult<HostConnectionAuthority> {
        let seed = self.snapshot()?;
        if seed.host_connection.is_some() {
            return host_connection_authority_from_snapshot(&seed);
        }
        let candidate = host_connection_identity_from_snapshot(&seed)?;
        let command_id = format!("runtime-host-bootstrap-{}", seed.next_commit_seq);
        let command = host_lifecycle_command(
            command_id.clone(),
            "host_connection_bootstrap",
            serde_json::json!({"identity": candidate}),
        )?;
        let mut transaction = SqliteCoreTransaction::begin_for(self.connection, &command, &EnvironmentInput::default())?;
        let snapshot = transaction.load_command_snapshot(&command)?;
        if snapshot.host_connection.is_some() {
            let authority = host_connection_authority_from_snapshot(&snapshot)?;
            transaction.commit()?;
            return Ok(authority);
        }
        if !snapshot.host_connection_history.is_empty() {
            transaction.commit()?;
            return Err(StorageError::Corrupt);
        }
        if transaction.replayed_transition().is_some() {
            transaction.commit()?;
            return Err(StorageError::Corrupt);
        }
        let candidate = host_connection_identity_from_snapshot(&snapshot)?;
        let transition = host_connection_transition(
            &snapshot,
            &command_id,
            candidate,
            1,
            "HostConnectionBootstrapped",
        )?;
        transaction.compare_and_apply(&transition)?;
        transaction.append_journal(&transition.events)?;
        transaction.commit()?;
        host_connection_authority_from_snapshot(&transition.state)
    }

    /// Rotate dedicated Host connection state using the opaque prior
    /// authority and the accepted lifecycle configuration as the candidate.
    pub fn rotate_host_connection(
        &mut self,
        current: &HostConnectionAuthority,
    ) -> StorageResult<HostConnectionAuthority> {
        let seed = self.snapshot()?;
        let candidate = host_connection_identity_from_snapshot(&seed)?;
        let command_id = format!("runtime-host-rotation-{}", seed.next_commit_seq);
        let command = host_lifecycle_command(
            command_id.clone(),
            "host_connection_rotation",
            serde_json::json!({
                "current_revision": current.incarnation_revision,
                "candidate": candidate,
            }),
        )?;
        let mut transaction = SqliteCoreTransaction::begin_for(self.connection, &command, &EnvironmentInput::default())?;
        let snapshot = transaction.load_command_snapshot(&command)?;
        let actual = host_connection_authority_from_snapshot(&snapshot)?;
        if actual != *current {
            transaction.commit()?;
            return Err(StorageError::IdempotencyConflict);
        }
        if transaction.replayed_transition().is_some() {
            transaction.commit()?;
            return Ok(actual);
        }
        let candidate = host_connection_identity_from_snapshot(&snapshot)?;
        if candidate == current.identity {
            transaction.commit()?;
            return Ok(actual);
        }
        if snapshot.host_connection_history.contains(&candidate) {
            transaction.commit()?;
            return Err(StorageError::IdempotencyConflict);
        }
        let revision = current
            .incarnation_revision
            .checked_add(1)
            .ok_or(StorageError::Corrupt)?;
        let transition = host_connection_transition(
            &snapshot,
            &command_id,
            candidate,
            revision,
            "HostConnectionRotated",
        )?;
        transaction.compare_and_apply(&transition)?;
        transaction.append_journal(&transition.events)?;
        transaction.commit()?;
        host_connection_authority_from_snapshot(&transition.state)
    }


    /// Return an opaque authority for the current verified Host connection.
    ///
    /// The returned value cannot be deserialized or constructed with a chosen
    /// connection identity, WorkerEpoch, or fence.
    pub fn authenticated_host_connection(&self) -> StorageResult<HostConnectionAuthority> {
        host_connection_authority_from_snapshot(&self.snapshot()?)
    }

    /// Admit one currently configured Module to its durable storage owner.
    ///
    /// The storage scope is generated here and persisted; callers cannot
    /// choose a scope, revision, or state payload. Re-admission after a Host
    /// rotation refreshes only the current Host incarnation binding.
    pub fn admit_module(
        &mut self,
        authority: &HostConnectionAuthority,
        module_id: &dolly_core_domain::ModuleId,
    ) -> StorageResult<dolly_core_domain::ModuleStorageScopeId> {
        let transaction =
            Transaction::new_unchecked(self.connection, TransactionBehavior::Immediate)
                .map_err(map_sqlite_error)?;
        let (snapshot, _, _) = load_snapshot(&transaction)?;
        if host_connection_authority_from_snapshot(&snapshot)? != *authority {
            return Err(StorageError::IdempotencyConflict);
        }
        let Some(admitted_module_id) =
            crate::module_state::admitted_module_id(&snapshot, module_id)
        else {
            return Err(StorageError::IdempotencyConflict);
        };
        if let Some((storage_scope_id, _)) =
            crate::module_state::load_owner(&transaction, &admitted_module_id)?
        {
            crate::module_state::update_owner_incarnation(
                &transaction,
                &admitted_module_id,
                authority.incarnation_revision(),
            )?;
            transaction.commit().map_err(map_sqlite_error)?;
            return Ok(storage_scope_id);
        }
        let storage_scope_id = crate::module_state::mint_storage_scope_id()?;
        crate::module_state::insert_owner(
            &transaction,
            &admitted_module_id,
            &storage_scope_id,
            authority.incarnation_revision(),
        )?;
        transaction.commit().map_err(map_sqlite_error)?;
        Ok(storage_scope_id)
    }

    /// Issue a sealed projection from the current durable state of one
    /// previously admitted Module.
    ///
    /// The module identifier is only a lookup key. Scope, revision, and safe
    /// state come from the verified owner row and Core snapshot.
    pub fn issue_module_state_projection(
        &mut self,
        authority: &HostConnectionAuthority,
        module_id: &dolly_core_domain::ModuleId,
    ) -> StorageResult<crate::module_state::ModuleStateProjection> {
        let transaction =
            Transaction::new_unchecked(self.connection, TransactionBehavior::Immediate)
                .map_err(map_sqlite_error)?;
        let (snapshot, state_revision, _) = load_snapshot(&transaction)?;
        if host_connection_authority_from_snapshot(&snapshot)? != *authority {
            return Err(StorageError::IdempotencyConflict);
        }
        let Some(admitted_module_id) =
            crate::module_state::admitted_module_id(&snapshot, module_id)
        else {
            return Err(StorageError::IdempotencyConflict);
        };
        let Some((storage_scope_id, owner_incarnation_revision)) =
            crate::module_state::load_owner(&transaction, &admitted_module_id)?
        else {
            return Err(StorageError::IdempotencyConflict);
        };
        if owner_incarnation_revision != authority.incarnation_revision() {
            return Err(StorageError::IdempotencyConflict);
        }
        let projection = crate::module_state::module_projection(
            &snapshot,
            &admitted_module_id,
            storage_scope_id,
            state_revision,
        )?;
        transaction.commit().map_err(map_sqlite_error)?;
        Ok(projection)
    }

    /// Install or replace the current Host-owned capability grant.
    ///
    /// The opaque current Host authority is checked inside the same immediate
    /// transaction that writes the dedicated grant row. Callers cannot submit
    /// a Core command or construct a grant value directly.
    pub fn install_host_capability_grant(
        &mut self,
        authority: &HostConnectionAuthority,
        extension_id: &str,
        module_id: &str,
        extension_generation: i64,
        descriptor_revision: i64,
        descriptor_digest: &str,
        manifest_revision: i64,
        manifest_digest: &str,
        graph_revision: i64,
        graph_digest: &str,
        methods: &[&str],
    ) -> StorageResult<()> {
        validate_host_capability_grant_input(
            extension_id,
            module_id,
            extension_generation,
            descriptor_revision,
            descriptor_digest,
            manifest_revision,
            manifest_digest,
            graph_revision,
            graph_digest,
            methods,
        )?;
        ensure_host_capability_grant_schema(self.connection)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        let snapshot = load_snapshot(&transaction)?.0;
        if host_connection_authority_from_snapshot(&snapshot)? != *authority {
            return Err(StorageError::IdempotencyConflict);
        }
        let previous = load_host_capability_grant_row(&transaction, extension_id, module_id)?;
        let grant_revision = previous
            .map(|grant| grant.record.grant_revision)
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(StorageError::SequenceConflict)?;
        let record = StoredHostCapabilityGrant {
            schema: HOST_CAPABILITY_GRANT_RECORD_SCHEMA.into(),
            extension_id: extension_id.into(),
            module_id: module_id.into(),
            extension_connection_id: authority.extension_connection_id().into(),
            worker_epoch: authority.worker_epoch().to_string(),
            worker_epoch_fence: authority.worker_epoch_fence(),
            incarnation_revision: authority.incarnation_revision(),
            extension_generation,
            descriptor_revision,
            descriptor_digest: descriptor_digest.into(),
            manifest_revision,
            manifest_digest: manifest_digest.into(),
            graph_revision,
            graph_digest: graph_digest.into(),
            grant_revision,
            methods: validate_grant_methods(methods)?,
            revoked: false,
        };
        persist_host_capability_grant(&transaction, &record)?;
        transaction.commit().map_err(map_sqlite_error)
    }

    /// Revoke the current grant with an atomic monotonic revision update.
    pub fn revoke_host_capability_grant(
        &mut self,
        authority: &HostConnectionAuthority,
        extension_id: &str,
        module_id: &str,
    ) -> StorageResult<()> {
        validate_grant_text(extension_id)?;
        validate_grant_text(module_id)?;
        ensure_host_capability_grant_schema(self.connection)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        let snapshot = load_snapshot(&transaction)?.0;
        if host_connection_authority_from_snapshot(&snapshot)? != *authority {
            return Err(StorageError::IdempotencyConflict);
        }
        let Some(mut record) =
            load_host_capability_grant_row(&transaction, extension_id, module_id)?
                .map(|grant| grant.record)
        else {
            return Err(StorageError::IdempotencyConflict);
        };
        if record.revoked {
            transaction.commit().map_err(map_sqlite_error)?;
            return Ok(());
        }
        record.grant_revision = record
            .grant_revision
            .checked_add(1)
            .ok_or(StorageError::SequenceConflict)?;
        record.revoked = true;
        persist_host_capability_grant(&transaction, &record)?;
        transaction.commit().map_err(map_sqlite_error)
    }

    /// Load the current active grant for one extension package and module.
    pub fn current_host_capability_grant(
        &self,
        authority: &HostConnectionAuthority,
        extension_id: &str,
        module_id: &str,
    ) -> StorageResult<Option<HostCapabilityGrant>> {
        validate_grant_text(extension_id)?;
        validate_grant_text(module_id)?;
        ensure_host_capability_grant_schema(self.connection)?;
        let transaction = Transaction::new_unchecked(self.connection, TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        let result = load_current_host_capability_grant(
            &transaction,
            authority,
            extension_id,
            module_id,
            None,
        )?;
        transaction.commit().map_err(map_sqlite_error)?;
        Ok(result)
    }

    /// Verify one admitted premise against the current Host grant and authority
    /// in one immediate SQLite read transaction.
    pub fn verify_host_capability_grant(
        &self,
        authority: &HostConnectionAuthority,
        extension_id: &str,
        module_id: &str,
        grant_revision: i64,
        grant_digest: &str,
    ) -> StorageResult<Option<HostCapabilityGrant>> {
        validate_grant_text(extension_id)?;
        validate_grant_text(module_id)?;
        if !(1..=CORE_MAX_SAFE_INTEGER).contains(&grant_revision) {
            return Err(StorageError::Corrupt);
        }
        validate_grant_digest(grant_digest)?;
        ensure_host_capability_grant_schema(self.connection)?;
        let transaction = Transaction::new_unchecked(self.connection, TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        let result = load_current_host_capability_grant(
            &transaction,
            authority,
            extension_id,
            module_id,
            Some((grant_revision, grant_digest)),
        )?;
        transaction.commit().map_err(map_sqlite_error)?;
        Ok(result)
    }

    /// Allocate a request identity while atomically checking the current Host
    /// connection authority.
    pub fn allocate_host_request(
        &mut self,
        authority: &HostConnectionAuthority,
        activation_id: &str,
        lease_id: &str,
        input: &EnvironmentInput,
    ) -> StorageResult<Transition> {
        let seed = self.snapshot()?;
        let command =
            host_request_allocation_command(&seed, authority, activation_id, lease_id)?;
        let command_id = command.command_id().to_owned();
        let mut transaction = SqliteCoreTransaction::begin_for(self.connection, &command, input)?;
        let snapshot = transaction.load_command_snapshot(&command)?;
        let current_authority = host_connection_authority_from_snapshot(&snapshot)?;
        if current_authority != *authority {
            transaction.commit()?;
            return Err(StorageError::IdempotencyConflict);
        }
        if let Some(replayed) = transaction.replayed_transition().cloned() {
            transaction.commit()?;
            return Ok(replayed);
        }
        let transition = allocate_host_request_transition(
            &snapshot,
            &command_id,
            authority,
            activation_id,
            lease_id,
            input,
        )?;
        transaction.compare_and_apply(&transition)?;
        if transition.outcome != TransitionOutcome::RolledBack {
            transaction.append_journal(&transition.events)?;
        }
        transaction.commit()?;
        Ok(transition)
    }

    /// Load and verify the current durable reducer snapshot.
    pub fn snapshot(&self) -> StorageResult<CoreSnapshot> {
        load_snapshot(self.connection).map(|(snapshot, _, _)| snapshot)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::StorageError;

    /// Minimal bookkeeping implementation; only proves the interface freezes.
    struct Counting {
        applied: usize,
        journal: usize,
    }

    impl CoreTransaction for Counting {
        fn load_command_snapshot(&mut self, _command: &CoreCommand) -> StorageResult<CoreSnapshot> {
            Err(StorageError::MigrationRequired)
        }
        fn compare_and_apply(&mut self, _transition: &Transition) -> StorageResult<()> {
            self.applied += 1;
            Ok(())
        }
        fn append_journal(&mut self, events: &[CoreEvent]) -> StorageResult<()> {
            self.journal += events.len();
            Ok(())
        }
        fn commit(self) -> StorageResult<()> {
            Ok(())
        }
    }

    #[test]
    fn trait_freeze_shapes() {
        let result = Counting {
            applied: 0,
            journal: 0,
        }
        .load_command_snapshot(&CoreCommand::SkipRange(
            dolly_core_reducer::SkipRangeCommand {
                command_id: "c1".into(),
                subscription_id: "s1".into(),
                start: 0,
                end_exclusive: 0,
            },
        ));
        assert!(result.is_err());
        let mut tx = Counting {
            applied: 0,
            journal: 0,
        };
        let _ = tx.compare_and_apply(&tmpl());
        let _ = tx.append_journal(&[]);
        assert!(tx.commit().is_ok());
    }

    #[test]
    fn rolled_back_transition_replay_is_identity_bound() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
        let input = EnvironmentInput {
            now: "2026-08-27T00:00:00Z".into(),
            ..Default::default()
        };
        let issue = CoreCommand::IssueLease(dolly_core_reducer::IssueLeaseCommand {
            command_id: "rollback-issue".into(),
            activation_id: "activation-later".into(),
            lease_id: "lease-1".into(),
            reservation_id: None,
            token_digest: "sha256:token".into(),
            extension_connection_id: "connection-1".into(),
            worker_epoch: 1,
            request_id: None,
            worker_epoch_id: None,
            incarnation_revision: None,
            extension_generation: None,
        });

        let rollback = store.transact(&issue, &input).expect("rollback transition");
        assert_eq!(rollback.outcome, TransitionOutcome::RolledBack);
        assert!(rollback.events.is_empty());
        assert_eq!(store.snapshot().expect("rollback snapshot"), empty_core_snapshot());

        let build = CoreCommand::BuildManifest(dolly_core_reducer::BuildManifestCommand {
            command_id: "build-later".into(),
            activation_id: "activation-later".into(),
            manifest: serde_json::json!({"producer":"later"}),
            expected_graph_revision: None,
            expected_descriptor_revision: None,
        });
        let built = store.transact(&build, &input).expect("later manifest");
        assert_eq!(built.outcome, TransitionOutcome::Committed);
        let after_build = store.snapshot().expect("built snapshot");

        let replay = store.transact(&issue, &input).expect("rollback replay");
        assert_eq!(replay, rollback);
        assert_eq!(store.snapshot().expect("replay snapshot"), after_build);

        let different_request = match &issue {
            CoreCommand::IssueLease(command) => {
                let mut command = command.clone();
                command.lease_id = "lease-2".into();
                CoreCommand::IssueLease(command)
            }
            _ => unreachable!("issue command shape"),
        };
        assert_eq!(
            store.transact(&different_request, &input).unwrap_err(),
            StorageError::IdempotencyConflict
        );
    }

    #[test]
    fn public_commands_cannot_allocate_a_host_request() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
        let input = EnvironmentInput::default();
        assert!(
            serde_json::from_value::<CoreCommand>(serde_json::json!({
                "type": "AllocateRequest",
                "command_id": "forged",
                "activation_id": "activation",
                "lease_id": "lease",
                "extension_connection_id": "attacker",
                "worker_epoch_id": "0198ab31-6c44-7e8a-b2bb-000000000010",
                "worker_epoch": 99
            }))
            .is_err()
        );
        let block = serde_json::json!({
            "activation_id": "activation",
            "lease_id": "lease",
            "extension_connection_id": "attacker",
            "worker_epoch": 99
        });
        let (_, operation_digest) = canonical_digest(&block).expect("canonical forged event");
        let forged = CoreCommand::RuntimeEvent(RuntimeEventCommand {
            command_id: "forged-allocation".into(),
            runtime_source: "host".into(),
            event_key: "host_request_allocation".into(),
            operation_digest,
            block_id: "forged-allocation".into(),
            block,
            pages: Vec::new(),
        });
        let transition = store
            .transact(&forged, &input)
            .expect("generic runtime event transition");
        assert_eq!(transition.outcome, TransitionOutcome::Committed);
        assert!(store
            .snapshot()
            .expect("snapshot after forged event")
            .host_request_reservations
            .is_empty());
    }

    #[test]
    fn a_to_b_to_a_rejects_stale_host_capability() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        let mut store = SqliteCoreStore::new(&mut connection).expect("core schema");
        let input = EnvironmentInput::default();
        let install = |store: &mut SqliteCoreStore<'_>, command_id: &str, revision: i64, config: Value| {
            let (_, digest) = canonical_digest(&config).expect("config digest");
            let command = CoreCommand::InstallConfig(dolly_core_reducer::InstallConfigCommand {
                command_id: command_id.into(),
                revision,
                effective_config: config,
                digest,
            });
            assert_eq!(
                store.transact(&command, &input).expect("config").outcome,
                TransitionOutcome::Committed
            );
        };
        let config_a = serde_json::json!({
            "extension_connection_id": "connection-1",
            "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000010",
            "worker_epoch_fence": 1
        });
        install(&mut store, "install-host-a", 1, config_a.clone());
        let authority_a = store
            .bootstrap_host_connection()
            .expect("Host A bootstrap");
        let retained_a = authority_a.clone();
        let config_b = serde_json::json!({
            "extension_connection_id": "connection-2",
            "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000011",
            "worker_epoch_fence": 2
        });
        install(&mut store, "install-host-b", 2, config_b);
        let authority_b = store
            .rotate_host_connection(&authority_a)
            .expect("Host B rotation");
        assert_eq!(authority_b.incarnation_revision(), 2);
        let config_a_again = serde_json::json!({
            "extension_connection_id": "connection-1",
            "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000010",
            "worker_epoch_fence": 1
        });
        install(&mut store, "install-host-a-again", 3, config_a_again);
        assert_eq!(
            store.authenticated_host_connection().unwrap(),
            authority_b
        );
        assert_eq!(
            store
                .allocate_host_request(&retained_a, "activation", "lease", &input)
                .unwrap_err(),
            StorageError::IdempotencyConflict
        );
        assert_eq!(
            store.rotate_host_connection(&authority_b).unwrap_err(),
            StorageError::IdempotencyConflict
        );
        let state = store.snapshot().expect("Host lifecycle snapshot");
        assert_eq!(state.host_connection_history.len(), 2);
        assert_eq!(
            state.host_connection.as_ref().unwrap().incarnation_revision,
            2
        );
    }

    fn tmpl() -> Transition {
        let state = empty_core_snapshot();
        Transition {
            outcome: TransitionOutcome::Committed,
            state: state.clone(),
            events: vec![],
            error: None,
            reply: None,
            projection: serde_json::Value::Null,
            state_hash: "".into(),
            safety_stop: None,
        }
    }
}
