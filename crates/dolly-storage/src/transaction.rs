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
    CoreCommand, CoreEvent, CoreSnapshot, EnvironmentInput, PROJECTION_KIND, Transition,
    TransitionOutcome, empty_core_snapshot, hash_core_state, project_core_state, reduce,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;
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

fn canonical_digest<T: Serialize>(value: &T) -> StorageResult<(Vec<u8>, String)> {
    let (bytes, digest) = canonicalize(value).map_err(|_| StorageError::Corrupt)?;
    Ok((bytes.into_vec(), digest.to_canonical_string()))
}

fn encode_projection(state: &CoreSnapshot) -> StorageResult<(Vec<u8>, String)> {
    canonical_digest(&project_core_state(state))
}

fn decode_canonical<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> StorageResult<T> {
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

    /// Return the exact transition retained for an idempotent command replay.
    pub fn replayed_transition(&self) -> Option<&Transition> {
        self.replay.as_ref()
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

/// The production Core store façade. It keeps semantic transitions on the
/// reducer path and exposes only one mutable SQLite writer reference.
pub struct SqliteCoreStore<'connection> {
    connection: &'connection mut Connection,
}

impl<'connection> SqliteCoreStore<'connection> {
    /// Create a store over a verified writable Runtime connection.
    pub fn new(connection: &'connection mut Connection) -> StorageResult<Self> {
        initialize_core_engine_schema(connection)?;
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
        if let Some(replayed) = transaction.replayed_transition().cloned() {
            transaction.commit()?;
            return Ok(replayed);
        }
        let transition = reduce(&snapshot, command, input);
        if transition.outcome != TransitionOutcome::RolledBack {
            transaction.compare_and_apply(&transition)?;
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
