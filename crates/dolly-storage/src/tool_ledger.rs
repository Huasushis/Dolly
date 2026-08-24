//! Authoritative SQLite Tool-call ledger slice (storage-and-recovery §5.10,
//! Tool Broker spec §5/§6, INV-11/INV-STORAGE-017).
//!
//! This module owns the exact `tool_call_ledger` table, its `PRIMARY KEY`,
//! `UNIQUE` transport-correlation constraint, per-state `CHECK`, foreign-key
//! references, and the `tool_call_ledger_recovery` index. It is the only
//! writer of the ledger inside the one authoritative Runtime database, under
//! the same exclusive instance lock and durability profile as Core state.
//!
//! Every row stores the exact canonical record JCS (`record_jcs`) plus its
//! digest (`record_digest`); every read recomputes the digest, re-decodes the
//! closed record, verifies the per-state field combination, and verifies every
//! indexed column against the decoded record. A stale compare-and-set, a
//! wrong expected revision/state, a response that does not correlate to the
//! stored transport identity, or corrupt bytes/digests change nothing and
//! fail closed (`CasOutcome::Stale`, `StorageError::Corrupt`).
//!
//! The minimal `activations` and `config_revisions` parent tables are created
//! with only the referenced key so the §5.10 foreign keys are real and
//! enforced; their fuller column sets arrive with their own storage slices.

use dolly_canonical_json::{ParseLimits, Sha256Digest, deserialize_core_json};
use dolly_tool_broker::{LedgerState, ToolCallLedgerRecord};
use rusqlite::{Connection, OptionalExtension, Row, Transaction};

use crate::database::map_sqlite_error;
use crate::error::{StorageError, StorageResult};

/// The logical table this slice writes.
pub const TOOL_CALL_LEDGER_TABLE: &str = "tool_call_ledger";

/// The authoritative Tool-call ledger schema (storage-and-recovery §5.10):
/// the minimum parent tables referenced by the foreign keys, the ledger
/// table, and the recovery index. Idempotent (`IF NOT EXISTS`).
pub const TOOL_CALL_LEDGER_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS activations (
    activation_id TEXT PRIMARY KEY NOT NULL
);
CREATE TABLE IF NOT EXISTS config_revisions (
    config_revision INTEGER PRIMARY KEY NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_call_ledger (
    instance_id                  TEXT    NOT NULL,
    module_id                    TEXT    NOT NULL,
    operation_id                 TEXT    NOT NULL,
    ledger_revision              INTEGER NOT NULL
                                 CHECK (ledger_revision BETWEEN 1 AND 9007199254740991),
    state                        TEXT    NOT NULL
                                 CHECK (state IN (
                                   'AUTHORIZED', 'DISPATCHED',
                                   'SUCCEEDED', 'FAILED', 'UNKNOWN'
                                 )),
    activation_id                TEXT    NOT NULL,
    config_revision              INTEGER NOT NULL,
    tool_server_id               TEXT    NOT NULL,
    tool_name                    TEXT    NOT NULL,
    tool_server_generation       INTEGER NOT NULL,
    server_request_id            TEXT    NOT NULL,
    request_digest               TEXT    NOT NULL,
    operation_digest             TEXT    NOT NULL,
    outbound_digest              TEXT,
    idempotency_argument_pointer TEXT,
    confirmation_id              TEXT    UNIQUE,
    terminal_result_digest       TEXT,
    record_jcs                   BLOB    NOT NULL,
    record_digest                TEXT    NOT NULL,
    PRIMARY KEY (module_id, operation_id),
    UNIQUE (tool_server_id, tool_server_generation, server_request_id),
    FOREIGN KEY (activation_id) REFERENCES activations(activation_id),
    FOREIGN KEY (config_revision) REFERENCES config_revisions(config_revision),
    CHECK (
        (state = 'AUTHORIZED' AND ledger_revision = 1
                               AND outbound_digest IS NULL
                               AND terminal_result_digest IS NULL) OR
        (state = 'DISPATCHED' AND ledger_revision = 2
                               AND outbound_digest IS NOT NULL
                               AND terminal_result_digest IS NULL) OR
        (state IN ('SUCCEEDED', 'UNKNOWN') AND ledger_revision = 3
                                            AND outbound_digest IS NOT NULL
                                            AND terminal_result_digest IS NOT NULL) OR
        (state = 'FAILED' AND ledger_revision IN (2, 3)
                          AND terminal_result_digest IS NOT NULL)
    )
);
"#;

/// Deterministic recovery-order index over nonterminal rows (spec §5.10/§6).
pub const TOOL_CALL_LEDGER_RECOVERY_INDEX_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS tool_call_ledger_recovery
    ON tool_call_ledger(state, module_id, operation_id);
"#;

/// Create the authoritative Tool-call ledger schema (table, parents, index).
/// Existing objects are never repaired: their exact definitions and physical
/// constraint/index properties are verified immediately and any mismatch fails
/// closed.
pub fn create_tool_ledger_schema(connection: &rusqlite::Connection) -> StorageResult<()> {
    let expected = authoritative_schema_sql()?;
    verify_existing_schema_sql(connection, "table", "activations", &expected.0)?;
    verify_existing_schema_sql(connection, "table", "config_revisions", &expected.1)?;
    verify_existing_schema_sql(connection, "table", TOOL_CALL_LEDGER_TABLE, &expected.2)?;
    verify_existing_schema_sql(
        connection,
        "index",
        "tool_call_ledger_recovery",
        &expected.3,
    )?;

    // `IF NOT EXISTS` is only allowed to install genuinely missing objects.
    // Existing objects were checked above, so a malformed lookalike cannot be
    // repaired or blessed by this idempotent initializer.
    connection
        .execute_batch(TOOL_CALL_LEDGER_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    connection
        .execute_batch(TOOL_CALL_LEDGER_RECOVERY_INDEX_SQL)
        .map_err(map_sqlite_error)?;
    gate_tool_ledger_schema(connection)
}
/// Build the expected sqlite_master definitions using the same authoritative
/// SQL that the offline initializer uses. Comparing against this reference
/// prevents a column-only lookalike from passing the physical schema gate.
fn authoritative_schema_sql() -> StorageResult<(String, String, String, String)> {
    let connection = Connection::open_in_memory().map_err(map_sqlite_error)?;
    connection
        .execute_batch(TOOL_CALL_LEDGER_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    connection
        .execute_batch(TOOL_CALL_LEDGER_RECOVERY_INDEX_SQL)
        .map_err(map_sqlite_error)?;

    let object_sql = |object_type: &str, name: &str| -> StorageResult<String> {
        connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = ?1 AND name = ?2",
                rusqlite::params![object_type, name],
                |row| row.get(0),
            )
            .map_err(map_sqlite_error)
    };
    Ok((
        object_sql("table", "activations")?,
        object_sql("table", "config_revisions")?,
        object_sql("table", TOOL_CALL_LEDGER_TABLE)?,
        object_sql("index", "tool_call_ledger_recovery")?,
    ))
}
fn normalized_schema_sql(sql: &str) -> String {
    // Preserve quoted literals: CHECK values such as `AUTHORIZED` are
    // case-sensitive, so lowercasing the complete SQL would bless a replaced
    // state constraint.
    sql.split_whitespace().collect::<String>()
}

fn verify_existing_schema_sql(
    connection: &rusqlite::Connection,
    object_type: &str,
    name: &str,
    expected: &str,
) -> StorageResult<()> {
    let actual: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = ?1 AND name = ?2",
            rusqlite::params![object_type, name],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    if let Some(actual) = actual {
        if normalized_schema_sql(&actual) != normalized_schema_sql(expected) {
            return Err(StorageError::Corrupt);
        }
    }
    Ok(())
}

fn verify_schema_objects(
    connection: &rusqlite::Connection,
    expected: &[(&str, &str, &str)],
) -> StorageResult<()> {
    let mut missing = false;
    for (object_type, name, expected_sql) in expected {
        let actual: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = ?1 AND name = ?2",
                rusqlite::params![object_type, name],
                |row| row.get(0),
            )
            .optional()
            .map_err(map_sqlite_error)?;
        match actual {
            Some(actual)
                if normalized_schema_sql(&actual) == normalized_schema_sql(expected_sql) => {}
            Some(_) => return Err(StorageError::Corrupt),
            None => missing = true,
        }
    }
    if missing {
        Err(StorageError::MigrationRequired)
    } else {
        Ok(())
    }
}

fn index_columns(connection: &rusqlite::Connection, index: &str) -> StorageResult<Vec<String>> {
    let mut statement = connection
        .prepare(&format!("PRAGMA index_info({index})"))
        .map_err(map_sqlite_error)?;
    let columns = statement
        .query_map([], |row| row.get::<_, Option<String>>(2))
        .map_err(map_sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_sqlite_error)?;
    columns
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or(StorageError::Corrupt)
}

fn verify_unique_constraints(connection: &rusqlite::Connection) -> StorageResult<()> {
    let mut statement = connection
        .prepare("PRAGMA index_list(tool_call_ledger)")
        .map_err(map_sqlite_error)?;
    let mut actual = Vec::new();
    for row in statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(map_sqlite_error)?
    {
        let (name, unique, origin, partial) = row.map_err(map_sqlite_error)?;
        if unique != 0 {
            if partial != 0 || (origin != "pk" && origin != "u") {
                return Err(StorageError::Corrupt);
            }
            actual.push((origin, index_columns(connection, &name)?));
        }
    }
    actual.sort();

    let mut expected = vec![
        (
            "pk".to_owned(),
            vec!["module_id".to_owned(), "operation_id".to_owned()],
        ),
        ("u".to_owned(), vec!["confirmation_id".to_owned()]),
        (
            "u".to_owned(),
            vec![
                "tool_server_id".to_owned(),
                "tool_server_generation".to_owned(),
                "server_request_id".to_owned(),
            ],
        ),
    ];
    expected.sort();
    if actual != expected {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

fn verify_foreign_keys(connection: &rusqlite::Connection) -> StorageResult<()> {
    let mut statement = connection
        .prepare("PRAGMA foreign_key_list(tool_call_ledger)")
        .map_err(map_sqlite_error)?;
    let mut actual = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(map_sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_sqlite_error)?;
    actual.sort();
    let mut expected = vec![
        (
            "activations".to_owned(),
            "activation_id".to_owned(),
            "activation_id".to_owned(),
            "NO ACTION".to_owned(),
            "NO ACTION".to_owned(),
            "NONE".to_owned(),
        ),
        (
            "config_revisions".to_owned(),
            "config_revision".to_owned(),
            "config_revision".to_owned(),
            "NO ACTION".to_owned(),
            "NO ACTION".to_owned(),
            "NONE".to_owned(),
        ),
    ];
    expected.sort();
    if actual != expected {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

fn verify_recovery_index(connection: &rusqlite::Connection) -> StorageResult<()> {
    let mut statement = connection
        .prepare("PRAGMA index_list(tool_call_ledger)")
        .map_err(map_sqlite_error)?;
    let mut recovery = None;
    for row in statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(map_sqlite_error)?
    {
        let (name, unique, origin, partial) = row.map_err(map_sqlite_error)?;
        if name == "tool_call_ledger_recovery" {
            recovery = Some((unique, origin, partial));
            break;
        }
    }
    if recovery != Some((0, "c".to_owned(), 0)) {
        return Err(StorageError::Corrupt);
    }
    if index_columns(connection, "tool_call_ledger_recovery")?
        != vec![
            "state".to_owned(),
            "module_id".to_owned(),
            "operation_id".to_owned(),
        ]
    {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

/// Verify the physical Tool-call ledger schema before any recovery query.
/// Missing objects are migration-required; malformed objects are corrupt.
pub fn gate_tool_ledger_schema(connection: &rusqlite::Connection) -> StorageResult<()> {
    let expected = authoritative_schema_sql()?;
    verify_schema_objects(
        connection,
        &[
            ("table", "activations", &expected.0),
            ("table", "config_revisions", &expected.1),
            ("table", TOOL_CALL_LEDGER_TABLE, &expected.2),
            ("index", "tool_call_ledger_recovery", &expected.3),
        ],
    )?;
    verify_required_columns(
        connection,
        "activations",
        &[("activation_id", "TEXT", 1, 1)],
        false,
    )?;
    verify_required_columns(
        connection,
        "config_revisions",
        &[("config_revision", "INTEGER", 1, 1)],
        false,
    )?;
    verify_required_columns(
        connection,
        TOOL_CALL_LEDGER_TABLE,
        &[
            ("instance_id", "TEXT", 1, 0),
            ("module_id", "TEXT", 1, 1),
            ("operation_id", "TEXT", 1, 2),
            ("ledger_revision", "INTEGER", 1, 0),
            ("state", "TEXT", 1, 0),
            ("activation_id", "TEXT", 1, 0),
            ("config_revision", "INTEGER", 1, 0),
            ("tool_server_id", "TEXT", 1, 0),
            ("tool_name", "TEXT", 1, 0),
            ("tool_server_generation", "INTEGER", 1, 0),
            ("server_request_id", "TEXT", 1, 0),
            ("request_digest", "TEXT", 1, 0),
            ("operation_digest", "TEXT", 1, 0),
            ("outbound_digest", "TEXT", 0, 0),
            ("idempotency_argument_pointer", "TEXT", 0, 0),
            ("confirmation_id", "TEXT", 0, 0),
            ("terminal_result_digest", "TEXT", 0, 0),
            ("record_jcs", "BLOB", 1, 0),
            ("record_digest", "TEXT", 1, 0),
        ],
        true,
    )?;
    verify_unique_constraints(connection)?;
    verify_foreign_keys(connection)?;
    verify_recovery_index(connection)?;
    Ok(())
}

fn verify_required_columns(
    connection: &rusqlite::Connection,
    table: &str,
    expected: &[(&str, &str, i64, i64)],
    exact: bool,
) -> StorageResult<()> {
    let exists: Option<String> = connection
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    if exists.is_none() {
        return Err(StorageError::MigrationRequired);
    }
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(map_sqlite_error)?;
    let actual = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(map_sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_sqlite_error)?;
    if (exact && actual.len() != expected.len())
        || actual.len() < expected.len()
        || actual
            .iter()
            .take(expected.len())
            .zip(expected)
            .any(|(actual, expected)| {
                actual.0 != expected.0
                    || actual.1 != expected.1
                    || actual.2 != expected.2
                    || actual.3 != expected.3
            })
    {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

/// The result of inserting an `AUTHORIZED` ledger row.
#[derive(Debug, Clone, PartialEq)]
pub enum LedgerInsertDisposition {
    /// A brand-new revision-1 `AUTHORIZED` row was committed.
    Inserted { record: ToolCallLedgerRecord },
    /// A row with the same `(module_id, operation_id)` and an equal
    /// `request_digest` already existed; the verified authoritative row is
    /// returned unchanged (REQ-TOOL-005 replay).
    Replayed { record: ToolCallLedgerRecord },
}

/// The expected current state of a row being compared-and-set.
#[derive(Debug, Clone, PartialEq)]
pub struct CasKey {
    pub module_id: String,
    pub operation_id: String,
    pub expected_ledger_revision: u64,
    pub expected_state: LedgerState,
    /// Correlation that a terminal response must satisfy; when `Some`, the
    /// stored row's transport correlation must equal it exactly or the CAS is
    /// stale (TST-TOOL-013: a wrong-generation/request response settles
    /// nothing and mutates nothing).
    pub correlation: Option<TransportCorrelation>,
}

/// Exact transport correlation of one dispatched on-wire identity.
#[derive(Debug, Clone, PartialEq)]
pub struct TransportCorrelation {
    pub tool_server_id: String,
    pub tool_name: String,
    pub tool_server_generation: u64,
    pub server_request_id: String,
    pub outbound_digest: Sha256Digest,
}

/// The outcome of a compare-and-set.
#[derive(Debug, Clone, PartialEq)]
pub enum CasOutcome {
    /// The transition committed; the authoritative new record is returned.
    /// For the dispatch CAS this commit is the durable boundary BEFORE any
    /// send permit may be released (INV-STORAGE-017).
    Committed { record: ToolCallLedgerRecord },
    /// Zero rows matched the expected revision/state (or correlation): nothing
    /// changed. The caller rereads the verified authoritative row and applies
    /// its recorded disposition; it never retries the stale write.
    Stale { authoritative: ToolCallLedgerRecord },
}

/// Insert the revision-1 `AUTHORIZED` record (spec §5.10 authorization
/// transaction). Performs the scoped primary-key lookup first: an existing
/// equal `request_digest` returns the stored row unchanged, a different digest
/// is `STORAGE_IDEMPOTENCY_CONFLICT` with zero mutation, and an absent key
/// inserts the closed record atomically with its canonical bytes and digest.
pub fn insert_authorized(
    connection: &mut rusqlite::Connection,
    record: &ToolCallLedgerRecord,
) -> StorageResult<LedgerInsertDisposition> {
    if record.state != LedgerState::Authorized {
        return Err(StorageError::Corrupt);
    }
    record
        .verify_field_combination()
        .map_err(|_| StorageError::Corrupt)?;

    let tx = connection.transaction().map_err(map_sqlite_error)?;

    let module_id = record.operation_binding.module_id.clone();
    let operation_id = record.operation_binding.operation_id.clone();

    let existing_request_digest: Option<String> = tx
        .query_row(
            "SELECT request_digest FROM tool_call_ledger
             WHERE module_id = ?1 AND operation_id = ?2",
            rusqlite::params![module_id, operation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite_error)?;

    if let Some(stored) = existing_request_digest {
        let authoritative =
            load_verified_inner(&tx, &module_id, &operation_id)?.ok_or(StorageError::Corrupt)?;
        if stored
            == record
                .operation_binding
                .request_digest
                .to_canonical_string()
        {
            // Equal digest: replay the authoritative row, no mutation.
            return tx
                .commit()
                .map(|()| LedgerInsertDisposition::Replayed {
                    record: authoritative,
                })
                .map_err(map_sqlite_error);
        }
        return Err(StorageError::IdempotencyConflict);
    }

    let (jcs, digest) = record
        .canonical_bytes_and_digest()
        .map_err(|_| StorageError::Corrupt)?;
    tx.execute(
        "INSERT INTO tool_call_ledger (
            instance_id, module_id, operation_id, ledger_revision, state,
            activation_id, config_revision, tool_server_id, tool_name,
            tool_server_generation, server_request_id, request_digest,
            operation_digest, outbound_digest, idempotency_argument_pointer,
            confirmation_id, terminal_result_digest, record_jcs, record_digest
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
            ?16, ?17, ?18, ?19
         )",
        rusqlite::params![
            record.operation_binding.instance_id,
            module_id,
            operation_id,
            record.ledger_revision as i64,
            record.state.wire_name(),
            record.operation_binding.activation_id,
            record.operation_binding.config_revision as i64,
            record.operation_binding.tool_server_id,
            record.operation_binding.tool_name,
            record.operation_binding.tool_server_generation as i64,
            record.operation_binding.server_request_id,
            record
                .operation_binding
                .request_digest
                .to_canonical_string(),
            record.operation_digest.to_canonical_string(),
            record
                .outbound_digest
                .as_ref()
                .map(|d| d.to_canonical_string()),
            record
                .operation_binding
                .idempotency_argument_pointer()
                .map(str::to_owned),
            record
                .operation_binding
                .confirmation_id()
                .map(str::to_owned),
            record
                .terminal_result_digest
                .as_ref()
                .map(|d| d.to_canonical_string()),
            jcs.as_ref(),
            digest.to_canonical_string(),
        ],
    )
    .map_err(map_sqlite_error)?;

    tx.commit().map_err(map_sqlite_error)?;
    Ok(LedgerInsertDisposition::Inserted {
        record: load_exact(connection, &module_id, &operation_id)?.ok_or(StorageError::Corrupt)?,
    })
}

/// Compare-and-set `AUTHORIZED -> DISPATCHED` (spec §5.10/§6). The transition
/// only commits when the stored row still has the expected revision and
/// state; a send permit may be released only after this commit returns
/// `Committed`. A zero-row result is a stale observation with no mutation.
pub fn cas_to_dispatched(
    connection: &mut rusqlite::Connection,
    expected: &CasKey,
    dispatched: &ToolCallLedgerRecord,
) -> StorageResult<CasOutcome> {
    if dispatched.state != LedgerState::Dispatched {
        return Err(StorageError::Corrupt);
    }
    cas(connection, expected, dispatched)
}

/// Compare-and-set `DISPATCHED -> SUCCEEDED|FAILED|UNKNOWN`, or the sole
/// pre-dispatch `AUTHORIZED -> FAILED` (`TOOL_DISPATCH_NOT_APPLIED`) terminal.
pub fn cas_terminal(
    connection: &mut rusqlite::Connection,
    expected: &CasKey,
    terminal: &ToolCallLedgerRecord,
) -> StorageResult<CasOutcome> {
    if !terminal.state.is_terminal() {
        return Err(StorageError::Corrupt);
    }
    cas(connection, expected, terminal)
}

fn cas(
    connection: &mut rusqlite::Connection,
    expected: &CasKey,
    incoming: &ToolCallLedgerRecord,
) -> StorageResult<CasOutcome> {
    incoming
        .verify_field_combination()
        .map_err(|_| StorageError::Corrupt)?;

    let tx = connection.transaction().map_err(map_sqlite_error)?;

    let authoritative = match load_verified_inner(&tx, &expected.module_id, &expected.operation_id)?
    {
        Some(authoritative) => authoritative,
        None => return Err(StorageError::Corrupt),
    };

    // Expected revision/state must still hold.
    if authoritative.ledger_revision != expected.expected_ledger_revision
        || authoritative.state != expected.expected_state
    {
        return tx
            .commit()
            .map(|()| CasOutcome::Stale { authoritative })
            .map_err(map_sqlite_error);
    }

    // A terminal settle must correlate exactly with the stored transport
    // identity (server id, tool, generation, request id, outbound digest).
    if let Some(correlation) = &expected.correlation {
        let binding = &authoritative.operation_binding;
        let matches = binding.tool_server_id == correlation.tool_server_id
            && binding.tool_name == correlation.tool_name
            && binding.tool_server_generation == correlation.tool_server_generation
            && binding.server_request_id == correlation.server_request_id
            && authoritative.outbound_digest.as_ref() == Some(&correlation.outbound_digest);
        if !matches {
            return tx
                .commit()
                .map(|()| CasOutcome::Stale { authoritative })
                .map_err(map_sqlite_error);
        }
    }

    // Revisions must step by exactly one (no regress, no skip).
    if incoming.ledger_revision != expected.expected_ledger_revision + 1 {
        return Err(StorageError::Corrupt);
    }

    let (jcs, digest) = incoming
        .canonical_bytes_and_digest()
        .map_err(|_| StorageError::Corrupt)?;

    let changed = tx
        .execute(
            "UPDATE tool_call_ledger SET
                ledger_revision = ?3, state = ?4, outbound_digest = ?5,
                terminal_result_digest = ?6, record_jcs = ?7, record_digest = ?8
             WHERE module_id = ?1 AND operation_id = ?2
               AND ledger_revision = ?9 AND state = ?10",
            rusqlite::params![
                expected.module_id,
                expected.operation_id,
                incoming.ledger_revision as i64,
                incoming.state.wire_name(),
                incoming
                    .outbound_digest
                    .as_ref()
                    .map(|d| d.to_canonical_string()),
                incoming
                    .terminal_result_digest
                    .as_ref()
                    .map(|d| d.to_canonical_string()),
                jcs.as_ref(),
                digest.to_canonical_string(),
                expected.expected_ledger_revision as i64,
                expected.expected_state.wire_name(),
            ],
        )
        .map_err(map_sqlite_error)?;

    if changed == 0 {
        // Lost the compare-and-set race; reread the winning verified row.
        let authoritative = load_verified_inner(&tx, &expected.module_id, &expected.operation_id)?
            .ok_or(StorageError::Corrupt)?;
        return tx
            .commit()
            .map(|()| CasOutcome::Stale { authoritative })
            .map_err(map_sqlite_error);
    }

    tx.commit().map_err(map_sqlite_error)?;
    Ok(CasOutcome::Committed {
        record: load_exact(connection, &expected.module_id, &expected.operation_id)?
            .ok_or(StorageError::Corrupt)?,
    })
}

/// Exact `(module_id, operation_id)` load with full canonical-byte/digest and
/// indexed-column verification. `Ok(None)` is an absent key.
pub fn load_exact(
    connection: &rusqlite::Connection,
    module_id: &str,
    operation_id: &str,
) -> StorageResult<Option<ToolCallLedgerRecord>> {
    let mut stmt = connection.prepare(SELECT_SQL).map_err(map_sqlite_error)?;
    let mut rows = stmt
        .query(rusqlite::params![module_id, operation_id])
        .map_err(map_sqlite_error)?;
    let Some(row) = rows.next().map_err(map_sqlite_error)? else {
        return Ok(None);
    };
    verify_row(row).map(Some)
}

pub(crate) fn load_verified_inner(
    transaction: &Transaction,
    module_id: &str,
    operation_id: &str,
) -> StorageResult<Option<ToolCallLedgerRecord>> {
    let mut stmt = transaction.prepare(SELECT_SQL).map_err(map_sqlite_error)?;
    let mut rows = stmt
        .query(rusqlite::params![module_id, operation_id])
        .map_err(map_sqlite_error)?;
    let Some(row) = rows.next().map_err(map_sqlite_error)? else {
        return Ok(None);
    };
    verify_row(row).map(Some)
}

/// The ledger row projection, shared by load paths.
const SELECT_SQL: &str = "SELECT instance_id, module_id, operation_id, ledger_revision, state,
                    activation_id, config_revision, tool_server_id, tool_name,
                    tool_server_generation, server_request_id, request_digest,
                    operation_digest, outbound_digest, idempotency_argument_pointer,
                    confirmation_id, terminal_result_digest, record_jcs, record_digest
             FROM tool_call_ledger WHERE module_id = ?1 AND operation_id = ?2";

/// The full verification every read must pass (spec §6/§7):
///   - `record_digest` recomputes to `sha256(record_jcs)`;
///   - `record_jcs` re-decodes to a closed, field-consistent record;
///   - the embedded operation/outbound/terminal digests recompute;
///   - every indexed column equals the decoded record.
///
/// Any mismatch is `STORAGE_CORRUPT`: no repair, deletion, or reinterpretation.
fn verify_row(row: &Row) -> StorageResult<ToolCallLedgerRecord> {
    let instance_id: String = row.get(0).map_err(map_sqlite_error)?;
    let module_id: String = row.get(1).map_err(map_sqlite_error)?;
    let operation_id: String = row.get(2).map_err(map_sqlite_error)?;
    let ledger_revision: i64 = row.get(3).map_err(map_sqlite_error)?;
    let state: String = row.get(4).map_err(map_sqlite_error)?;
    let activation_id: String = row.get(5).map_err(map_sqlite_error)?;
    let config_revision: i64 = row.get(6).map_err(map_sqlite_error)?;
    let tool_server_id: String = row.get(7).map_err(map_sqlite_error)?;
    let tool_name: String = row.get(8).map_err(map_sqlite_error)?;
    let tool_server_generation: i64 = row.get(9).map_err(map_sqlite_error)?;
    let server_request_id: String = row.get(10).map_err(map_sqlite_error)?;
    let request_digest: String = row.get(11).map_err(map_sqlite_error)?;
    let operation_digest: String = row.get(12).map_err(map_sqlite_error)?;
    let outbound_digest: Option<String> = row.get(13).map_err(map_sqlite_error)?;
    let idempotency_argument_pointer: Option<String> = row.get(14).map_err(map_sqlite_error)?;
    let confirmation_id: Option<String> = row.get(15).map_err(map_sqlite_error)?;
    let terminal_result_digest: Option<String> = row.get(16).map_err(map_sqlite_error)?;
    let record_jcs: Vec<u8> = row.get(17).map_err(map_sqlite_error)?;
    let record_digest: String = row.get(18).map_err(map_sqlite_error)?;

    if Sha256Digest::compute(&record_jcs).to_canonical_string() != record_digest {
        return Err(StorageError::Corrupt);
    }

    let decoded: ToolCallLedgerRecord =
        deserialize_core_json(&record_jcs, ParseLimits::protocol_wire())
            .map_err(|_| StorageError::Corrupt)?;
    decoded
        .verify_field_combination()
        .map_err(|_| StorageError::Corrupt)?;

    if decoded.ledger_revision != ledger_revision as u64
        || decoded.state.wire_name() != state
        || decoded.operation_binding.instance_id != instance_id
        || decoded.operation_binding.module_id != module_id
        || decoded.operation_binding.operation_id != operation_id
        || decoded.operation_binding.activation_id != activation_id
        || decoded.operation_binding.config_revision != config_revision as u64
        || decoded.operation_binding.tool_server_id != tool_server_id
        || decoded.operation_binding.tool_name != tool_name
        || decoded.operation_binding.tool_server_generation != tool_server_generation as u64
        || decoded.operation_binding.server_request_id != server_request_id
        || decoded
            .operation_binding
            .request_digest
            .to_canonical_string()
            != request_digest
        || decoded.operation_digest.to_canonical_string() != operation_digest
        || decoded
            .outbound_digest
            .as_ref()
            .map(|d| d.to_canonical_string())
            != outbound_digest
        || decoded
            .operation_binding
            .idempotency_argument_pointer()
            .map(str::to_owned)
            != idempotency_argument_pointer
        || decoded
            .operation_binding
            .confirmation_id()
            .map(str::to_owned)
            != confirmation_id
        || decoded
            .terminal_result_digest
            .as_ref()
            .map(|d| d.to_canonical_string())
            != terminal_result_digest
    {
        return Err(StorageError::Corrupt);
    }

    Ok(decoded)
}

/// Enumerate every nonterminal (`AUTHORIZED`, `DISPATCHED`) row in
/// deterministic `(module_id, operation_id)` order (spec §6). Every row is
/// fully verified; any corrupt row fails the whole enumeration (fail-closed,
/// no partial list).
pub fn enumerate_nonterminal(
    connection: &rusqlite::Connection,
) -> StorageResult<Vec<ToolCallLedgerRecord>> {
    gate_tool_ledger_schema(connection)?;
    let mut stmt = connection
        .prepare(ENUMERATE_SQL)
        .map_err(map_sqlite_error)?;
    let mut rows = stmt.query([]).map_err(map_sqlite_error)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(map_sqlite_error)? {
        out.push(verify_row(row)?);
    }
    Ok(out)
}

const ENUMERATE_SQL: &str = "SELECT instance_id, module_id, operation_id, ledger_revision, state,
                    activation_id, config_revision, tool_server_id, tool_name,
                    tool_server_generation, server_request_id, request_digest,
                    operation_digest, outbound_digest, idempotency_argument_pointer,
                    confirmation_id, terminal_result_digest, record_jcs, record_digest
             FROM tool_call_ledger
             WHERE state IN ('AUTHORIZED', 'DISPATCHED')
             ORDER BY module_id, operation_id";
