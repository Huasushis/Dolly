//! Authoritative SQLite external-effect journal slice (v1).
//!
//! This module owns the exact `external_effect_journal` table, its `PRIMARY
//! KEY` over the frozen Claim identity, per-state `CHECK`, the
//! `effect_journal_meta` schema-version singleton, and the recovery index.
//! It is the only writer of the journal inside the one authoritative Runtime
//! database, under the same exclusive instance lock and durability profile as
//! Core state.
//!
//! Every row stores the exact canonical record JCS (`record_jcs`) plus its
//! digest (`record_digest`); every read recomputes the digest, re-decodes the
//! closed record, verifies the per-state field combination, and verifies every
//! indexed column against the decoded record (including the derivable claim
//! token). The schema-version singleton MUST match
//! `dolly-tool-broker::effect_journal::EFFECT_JOURNAL_SCHEMA_VERSION`
//! (`1`); a missing, stale, or future version, or a missing/corrupt table,
//! fails closed (`STORAGE_MIGRATION_REQUIRED` / `STORAGE_CORRUPT`) instead
//! of being repaired.
//!
//! Storage is bounded over the ENTIRE journal: an insert that would push the
//! total row count past the authoritative whole-journal ceiling first runs
//! safe deterministic retention (releasing only fully settled deterministic
//! rows, never unresolved `INTENDED` rows or `UNKNOWN_OUTCOME` ambiguity
//! evidence needed for recovery) and fails closed with `STORAGE_FULL` when
//! retention cannot free capacity. The per-record JCS byte ceiling is also
//! enforced before any mutation, and every open-time gate re-verifies the
//! same limits.

use dolly_canonical_json::{ParseLimits, Sha256Digest, deserialize_core_json};
use dolly_tool_broker::effect_journal::{
    Claim, EFFECT_JOURNAL_RECORD_SCHEMA, EffectClass, EffectJournalState, EffectSettlement,
    ExternalEffectJournalRecord, recover_effect_journal,
};
use dolly_tool_broker::{LedgerState, ToolCallLedgerRecord};
use rusqlite::{Connection, OptionalExtension, Row, Transaction};

use crate::database::{Database, map_sqlite_error};
use crate::error::{StorageError, StorageResult};
use crate::runtime_binding::{ProcessGeneration, RuntimeBinding};

/// The logical table this slice writes.
pub const EFFECT_JOURNAL_TABLE: &str = "external_effect_journal";

/// Authoritative ceiling over the ENTIRE effect journal (all states, not only
/// pending ones). Fail closed with `STORAGE_FULL` when an insert would exceed
/// it and safe retention cannot free capacity. Kept deliberately far below
/// the protocol byte floor so the premise never unboundedly grows.
pub const MAX_EFFECT_JOURNAL_ROWS: u64 = 4096;
/// The per-record JCS byte ceiling, a fixed bound far below the protocol
/// limit, enforced before any mutation.
pub const MAX_EFFECT_JOURNAL_JCS_BYTES: usize = 64 * 1024;

/// The authoritative external-effect journal schema: the meta singleton, the
/// journal table, and the recovery index. This SQL is used only by the
/// controller-owned offline initialization transaction; ordinary opens never
/// execute it.
pub const EFFECT_JOURNAL_SCHEMA_SQL: &str = r#"
CREATE TABLE external_effect_journal_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.external-effect-journal/v1')
);
CREATE TABLE external_effect_journal (
    instance_id TEXT NOT NULL,
    module_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    claim_token TEXT NOT NULL,
    journal_revision INTEGER NOT NULL
        CHECK (journal_revision BETWEEN 1 AND 9007199254740991),
    state TEXT NOT NULL
        CHECK (state IN ('INTENDED', 'APPLIED', 'NOT_APPLIED', 'UNKNOWN_OUTCOME')),
    controller_generation INTEGER NOT NULL
        CHECK (controller_generation BETWEEN 1 AND 9007199254740991),
    extension_generation INTEGER NOT NULL
        CHECK (extension_generation BETWEEN 1 AND 9007199254740991),
    worker_epoch TEXT NOT NULL,
    package_digest TEXT NOT NULL,
    policy_premise_digest TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    effect_class TEXT NOT NULL
        CHECK (effect_class = 'MCP_TOOLS_CALL'),
    intent_digest TEXT NOT NULL,
    evidence_digest TEXT,
    record_jcs BLOB NOT NULL,
    record_digest TEXT NOT NULL,
    PRIMARY KEY (instance_id, module_id, operation_id, claim_token),
    CHECK (
        (state = 'INTENDED' AND journal_revision = 1
                             AND evidence_digest IS NULL) OR
        (state IN ('APPLIED', 'NOT_APPLIED') AND journal_revision = 2
                                               AND evidence_digest IS NOT NULL) OR
        (state = 'UNKNOWN_OUTCOME' AND journal_revision = 2
                                    AND evidence_digest IS NULL)
    )
);
"#;

/// Deterministic recovery-order index over journal rows (parallel to the
/// Tool-call ledger recovery index).
pub const EFFECT_JOURNAL_RECOVERY_INDEX_SQL: &str = r#"
CREATE INDEX effect_journal_recovery
    ON external_effect_journal(state, instance_id, module_id, operation_id, claim_token);
"#;

/// Install the journal schema only inside the controller-owned fresh/offline
/// initialization transaction. The SQL intentionally has no `IF NOT EXISTS`
/// or repair operation.
pub(crate) fn initialize_effect_journal_schema(transaction: &Transaction<'_>) -> StorageResult<()> {
    let has_effect_objects: i64 = transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                WHERE type IN ('table', 'index')
                  AND name IN (
                    'external_effect_journal_meta',
                    'external_effect_journal',
                    'effect_journal_recovery'
                  )
             )",
            [],
            |row| row.get(0),
        )
        .map_err(map_sqlite_error)?;
    if has_effect_objects != 0 {
        // An explicit migration may encounter an already-installed journal.
        // Validate its exact shape/version; never recreate or repair any
        // partial or corrupt object set.
        return gate_schema_version(transaction);
    }
    transaction
        .execute_batch(EFFECT_JOURNAL_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    transaction
        .execute_batch(EFFECT_JOURNAL_RECOVERY_INDEX_SQL)
        .map_err(map_sqlite_error)?;
    transaction
        .execute(
            "INSERT INTO external_effect_journal_meta
                (singleton, schema_version, schema_discriminator)
             VALUES (1, 1, 'dolly.external-effect-journal/v1')",
            [],
        )
        .map(|_| ())
        .map_err(map_sqlite_error)
}

/// Fail-closed schema-version and physical-shape gate every journal
/// reader/writer must pass. Ordinary opens never create or repair a missing
/// table, index, metadata row, or metadata value.
pub fn gate_schema_version(connection: &Connection) -> StorageResult<()> {
    verify_table_shape(
        connection,
        "external_effect_journal_meta",
        &[
            ("singleton", "INTEGER", 0, 1),
            ("schema_version", "INTEGER", 1, 0),
            ("schema_discriminator", "TEXT", 1, 0),
        ],
        StorageError::MigrationRequired,
    )?;
    verify_table_shape(
        connection,
        EFFECT_JOURNAL_TABLE,
        &[
            ("instance_id", "TEXT", 1, 1),
            ("module_id", "TEXT", 1, 2),
            ("operation_id", "TEXT", 1, 3),
            ("claim_token", "TEXT", 1, 4),
            ("journal_revision", "INTEGER", 1, 0),
            ("state", "TEXT", 1, 0),
            ("controller_generation", "INTEGER", 1, 0),
            ("extension_generation", "INTEGER", 1, 0),
            ("worker_epoch", "TEXT", 1, 0),
            ("package_digest", "TEXT", 1, 0),
            ("policy_premise_digest", "TEXT", 1, 0),
            ("operation_digest", "TEXT", 1, 0),
            ("effect_class", "TEXT", 1, 0),
            ("intent_digest", "TEXT", 1, 0),
            ("evidence_digest", "TEXT", 0, 0),
            ("record_jcs", "BLOB", 1, 0),
            ("record_digest", "TEXT", 1, 0),
        ],
        StorageError::Corrupt,
    )?;
    let index_exists: Option<String> = connection
        .query_row(
            "SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'effect_journal_recovery'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    if index_exists.is_none() {
        return Err(StorageError::Corrupt);
    }
    let metadata: Option<(i64, String)> = connection
        .query_row(
            "SELECT schema_version, schema_discriminator
             FROM external_effect_journal_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some((version, discriminator)) = metadata else {
        return Err(StorageError::MigrationRequired);
    };
    if version != 1 || discriminator != EFFECT_JOURNAL_RECORD_SCHEMA {
        return Err(StorageError::MigrationRequired);
    }
    Ok(())
}
/// Re-verify the bounded row count and every persisted row during an ordinary
/// database open. Exactly-at-cap is valid; over-cap or any invalid digest,
/// record, state, or indexed column fails closed before the handle is exposed.
pub(crate) fn verify_open_limits(connection: &Connection) -> StorageResult<()> {
    gate_schema_version(connection)?;
    let total: i64 = connection
        .query_row("SELECT COUNT(*) FROM external_effect_journal", [], |row| {
            row.get(0)
        })
        .map_err(map_sqlite_error)?;
    if total < 0 || total as u64 > MAX_EFFECT_JOURNAL_ROWS {
        return Err(StorageError::Full);
    }
    let mut statement = connection
        .prepare(ALL_SELECT_SQL)
        .map_err(map_sqlite_error)?;
    let mut rows = statement.query([]).map_err(map_sqlite_error)?;
    while let Some(row) = rows.next().map_err(map_sqlite_error)? {
        verify_row(row)?;
    }
    Ok(())
}

fn verify_table_shape(
    connection: &Connection,
    table: &str,
    expected: &[(&str, &str, i64, i64)],
    missing_error: StorageError,
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
        return Err(missing_error);
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
    if actual.len() != expected.len()
        || actual.iter().zip(expected).any(|(actual, expected)| {
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

/// The unforgeable capability returned only after a new Claim intent commits.
/// Coordinator stdio dispatch requires this exact capability and re-verifies
/// the durable row and every frozen generation/premise before admitting a
/// send permit.
#[derive(Debug, PartialEq)]
pub struct EffectJournalIntentAuthority {
    record: ExternalEffectJournalRecord,
}

impl EffectJournalIntentAuthority {
    /// Revalidate this capability against the authoritative ledger row,
    /// current Worker generations, installed package, policy premise, and
    /// exact outbound bytes. Any mismatch fails closed before child I/O.
    pub fn verify_for_dispatch(
        &self,
        connection: &Connection,
        row: &ToolCallLedgerRecord,
        runtime_binding: &RuntimeBinding,
        process_generation: &ProcessGeneration,
        package_digest: &Sha256Digest,
        request_bytes: &[u8],
    ) -> StorageResult<()> {
        gate_schema_version(connection)?;
        if self.record.state != EffectJournalState::Intended
            || self.record.journal_revision != 1
            || row.state != LedgerState::Authorized
            || row.verify_field_combination().is_err()
        {
            return Err(StorageError::Corrupt);
        }
        let stored = load_exact(connection, &self.record.claim)?.ok_or(StorageError::Corrupt)?;
        if stored != self.record
            || self.record.claim.instance_id != row.operation_binding.instance_id
            || self.record.claim.module_id != row.operation_binding.module_id
            || self.record.claim.operation_id != row.operation_binding.operation_id
            || self.record.operation_digest != row.operation_digest
            || self.record.operation_digest != row.operation_binding.operation_digest()
            || self.record.intent_digest != Sha256Digest::compute(request_bytes)
            || row.operation_binding.recompute_outbound_digest().as_ref()
                != Some(&self.record.intent_digest)
            || self.record.controller_generation != runtime_binding.controller_generation().value()
            || self.record.controller_generation
                != process_generation.controller_generation().value()
            || self.record.extension_generation != process_generation.extension_generation().value()
            || self.record.worker_epoch != runtime_binding.worker_epoch().to_string()
            || self.record.worker_epoch != process_generation.worker_epoch().to_string()
            || self.record.package_digest != *package_digest
            || self.record.policy_premise_digest != *runtime_binding.premises_digest()
            || self.record.effect_class != EffectClass::McpToolsCall
            || row.operation_binding.instance_id != runtime_binding.instance_id()
            || process_generation.instance_id() != runtime_binding.instance_id()
        {
            return Err(StorageError::Corrupt);
        }
        Ok(())
    }
}

/// The result of inserting an `INTENDED` journal intent row.
#[derive(Debug, PartialEq)]
pub enum EffectJournalInsertDisposition {
    /// A brand-new revision-1 `INTENDED` row committed, with the only
    /// capability accepted by the coordinator's stdio dispatch boundary.
    Inserted {
        record: ExternalEffectJournalRecord,
        authority: EffectJournalIntentAuthority,
    },
    /// A row with the same Claim (primary key) already existed. Because a
    /// Claim is a new-attempt identity, this is a replay of the SAME attempt:
    /// the verified authoritative row is returned without mutation and the
    /// caller must NOT dispatch (a new attempt requires a new Claim).
    Replayed { record: ExternalEffectJournalRecord },
}

/// The expected current state of a journal row being compared-and-set.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectCasKey {
    /// The exact frozen Claim identity of the row.
    pub claim: Claim,
    /// Expected `journal_revision`.
    pub expected_journal_revision: u64,
    /// Expected current state.
    pub expected_state: EffectJournalState,
    /// The complete frozen correlation. Every field is required for a
    /// settlement, including all generations, package, policy, operation,
    /// outbound-effect digest, and effect class.
    pub correlation: Option<EffectCorrelation>,
}

/// The exact identity correlation that must match both the stored Claim and
/// authoritative provider evidence.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectCorrelation {
    pub controller_generation: u64,
    pub extension_generation: u64,
    pub worker_epoch: String,
    pub package_digest: Sha256Digest,
    pub policy_premise_digest: Sha256Digest,
    pub operation_digest: Sha256Digest,
    pub outbound_digest: Sha256Digest,
    pub effect_class: EffectClass,
}
impl EffectCorrelation {
    /// Build the complete settlement correlation from one verified journal
    /// intent. This is used by the reopen recovery driver; callers cannot
    /// omit or substitute one of the bound fields.
    pub fn from_record(record: &ExternalEffectJournalRecord) -> Self {
        Self {
            controller_generation: record.controller_generation,
            extension_generation: record.extension_generation,
            worker_epoch: record.worker_epoch.clone(),
            package_digest: record.package_digest.clone(),
            policy_premise_digest: record.policy_premise_digest.clone(),
            operation_digest: record.operation_digest.clone(),
            outbound_digest: record.intent_digest.clone(),
            effect_class: record.effect_class,
        }
    }
}

/// The outcome of a compare-and-set on a journal row.
#[derive(Debug, Clone, PartialEq)]
pub enum EffectCasOutcome {
    /// The transition committed; the authoritative new record is returned.
    Committed { record: ExternalEffectJournalRecord },
    /// No row matched the expected Claim/revision/state (or correlation):
    /// nothing changed. The caller rereads the verified authoritative row; it
    /// never retries the stale write.
    Stale {
        authoritative: ExternalEffectJournalRecord,
    },
}

/// Insert the revision-1 `INTENDED` intent row (v1 intent transaction).
///
/// Fail-closed gates, in order: schema-version gate; single-record size
/// bound; operation-identity/effect-class closedness; pending-row ceiling;
/// scoped primary-key lookup (equal Claim replays the authoritative row,
/// never a fresh row); then the atomic insert of the closed record and its
/// digest.
pub fn insert_intent(
    connection: &mut rusqlite::Connection,
    record: &ExternalEffectJournalRecord,
) -> StorageResult<EffectJournalInsertDisposition> {
    gate_schema_version(connection)?;
    if record.state != EffectJournalState::Intended
        || record.journal_revision != 1
        || record.evidence_digest.is_some()
    {
        return Err(StorageError::Corrupt);
    }
    record.verify().map_err(|_| StorageError::Corrupt)?;

    let (jcs, digest) = record
        .canonical_bytes_and_digest()
        .map_err(|_| StorageError::Corrupt)?;
    if jcs.as_ref().len() > MAX_EFFECT_JOURNAL_JCS_BYTES {
        return Err(StorageError::Full);
    }

    let tx = connection.transaction().map_err(map_sqlite_error)?;

    let claim = &record.claim;
    let authoritative = load_verified_inner(&tx, claim)?;
    if let Some(authoritative) = authoritative {
        // Same Claim: replay the authoritative row. Never a second Intent
        // under one Claim; a new attempt requires a new Claim. Replay is
        // checked before capacity so a full journal cannot turn idempotent
        // replay into a new dispatch attempt.
        return tx
            .commit()
            .map(|()| EffectJournalInsertDisposition::Replayed {
                record: authoritative,
            })
            .map_err(map_sqlite_error);
    }

    // Whole-journal ceiling: run safe retention first inside the same
    // transaction, then fail closed when the journal is still at the cap.
    let total: i64 = tx
        .query_row("SELECT COUNT(*) FROM external_effect_journal", [], |row| {
            row.get(0)
        })
        .map_err(map_sqlite_error)?;
    if (total as u64) >= MAX_EFFECT_JOURNAL_ROWS {
        retain_bounded_rows(&tx)?;
    }
    // Re-check after retention: an intent that still cannot be admitted is a
    // journal at its ceiling and its pending intent must be refused: STORAGE_FULL.
    let total_after: i64 = tx
        .query_row("SELECT COUNT(*) FROM external_effect_journal", [], |row| {
            row.get(0)
        })
        .map_err(map_sqlite_error)?;
    if (total_after as u64) >= MAX_EFFECT_JOURNAL_ROWS {
        return Err(StorageError::Full);
    }

    tx.execute(
        "INSERT INTO external_effect_journal (
            instance_id, module_id, operation_id, claim_token, journal_revision,
            state, controller_generation, extension_generation, worker_epoch,
            package_digest, policy_premise_digest, operation_digest,
            effect_class, intent_digest, evidence_digest, record_jcs, record_digest
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
            ?16, ?17
         )",
        rusqlite::params![
            claim.instance_id,
            claim.module_id,
            claim.operation_id,
            claim.claim_token.to_canonical_string(),
            record.journal_revision as i64,
            record.state.wire_name(),
            record.controller_generation as i64,
            record.extension_generation as i64,
            record.worker_epoch,
            record.package_digest.to_canonical_string(),
            record.policy_premise_digest.to_canonical_string(),
            record.operation_digest.to_canonical_string(),
            record.effect_class.wire_name(),
            record.intent_digest.to_canonical_string(),
            record
                .evidence_digest
                .as_ref()
                .map(|d| d.to_canonical_string()),
            jcs.as_ref(),
            digest.to_canonical_string(),
        ],
    )
    .map_err(map_sqlite_error)?;

    tx.commit().map_err(map_sqlite_error)?;
    let authoritative = load_exact(connection, claim)?.ok_or(StorageError::Corrupt)?;
    Ok(EffectJournalInsertDisposition::Inserted {
        record: authoritative.clone(),
        authority: EffectJournalIntentAuthority {
            record: authoritative,
        },
    })
}

/// Safe deterministic retention over the whole journal, run inside the
/// insert transaction when the authoritative [`MAX_EFFECT_JOURNAL_ROWS`]
/// ceiling is reached.
///
/// Only rows whose recovery job is already complete may be released: a row
/// settled `APPLIED` or `NOT_APPLIED` by identity-matching deterministic
/// provider evidence no longer participates in recovery. Rows that are still
/// `INTENDED` (unresolved) or `UNKNOWN_OUTCOME` (ambiguity evidence needed by
/// recovery) are NEVER deleted.
///
/// Deletion order is deterministic (lexicographic over the full frozen Claim
/// identity of the deletable rows) so retention is reproducible. The caller
/// re-checks the ceiling after this runs and fails closed (`STORAGE_FULL`) if
/// capacity still cannot be freed.
fn retain_bounded_rows(transaction: &Transaction<'_>) -> StorageResult<()> {
    loop {
        let total: i64 = transaction
            .query_row("SELECT COUNT(*) FROM external_effect_journal", [], |row| {
                row.get(0)
            })
            .map_err(map_sqlite_error)?;
        if (total as u64) < MAX_EFFECT_JOURNAL_ROWS {
            return Ok(());
        }
        let needed = (total as u64 - MAX_EFFECT_JOURNAL_ROWS + 1) as usize;
        // Read and fully verify every candidate before deleting any of them.
        // The state predicate excludes unresolved INTENDED rows and
        // UNKNOWN_OUTCOME ambiguity evidence by construction.
        let candidates = {
            let mut statement = transaction
                .prepare(RETENTION_SELECT_SQL)
                .map_err(map_sqlite_error)?;
            let mut rows = statement.query([]).map_err(map_sqlite_error)?;
            let mut candidates = Vec::new();
            while let Some(row) = rows.next().map_err(map_sqlite_error)? {
                let record = verify_row(row)?;
                if !matches!(
                    record.state,
                    EffectJournalState::Applied | EffectJournalState::NotApplied
                ) || record.evidence_digest.is_none()
                {
                    return Err(StorageError::Corrupt);
                }
                candidates.push(record);
            }
            candidates
        };
        if candidates.is_empty() {
            return Ok(());
        }
        for record in candidates.into_iter().take(needed) {
            let (_, record_digest) = record
                .canonical_bytes_and_digest()
                .map_err(|_| StorageError::Corrupt)?;
            let deleted = transaction
                .execute(
                    "DELETE FROM external_effect_journal
                     WHERE instance_id = ?1 AND module_id = ?2
                       AND operation_id = ?3 AND claim_token = ?4
                       AND state IN ('APPLIED', 'NOT_APPLIED')
                       AND record_digest = ?5",
                    rusqlite::params![
                        record.claim.instance_id,
                        record.claim.module_id,
                        record.claim.operation_id,
                        record.claim.claim_token.to_canonical_string(),
                        record_digest.to_canonical_string(),
                    ],
                )
                .map_err(map_sqlite_error)?;
            if deleted != 1 {
                return Err(StorageError::Corrupt);
            }
        }
    }
}

/// Settle `INTENDED` to a terminal state.
///
/// Public callers may settle only from the exact authoritative terminal
/// Tool-call ledger record already persisted for the same operation. The
/// incoming record is merely a proposed state and evidence digest; it is
/// accepted only when the stored ledger deterministically derives the same
/// transition and every Claim/generation/premise correlation matches.
/// `UNKNOWN_OUTCOME` is available only to the private reopen recovery driver,
/// which supplies no caller observation.
pub fn cas_settle(
    connection: &mut rusqlite::Connection,
    expected: &EffectCasKey,
    incoming: &ExternalEffectJournalRecord,
) -> StorageResult<EffectCasOutcome> {
    if incoming.state == EffectJournalState::UnknownOutcome {
        return Err(StorageError::Corrupt);
    }
    cas_settle_inner(connection, expected, incoming, false)
}

fn cas_settle_recovery(
    connection: &mut rusqlite::Connection,
    expected: &EffectCasKey,
    incoming: &ExternalEffectJournalRecord,
) -> StorageResult<EffectCasOutcome> {
    cas_settle_inner(connection, expected, incoming, true)
}

fn cas_settle_inner(
    connection: &mut rusqlite::Connection,
    expected: &EffectCasKey,
    incoming: &ExternalEffectJournalRecord,
    allow_unknown: bool,
) -> StorageResult<EffectCasOutcome> {
    gate_schema_version(connection)?;
    if incoming.journal_revision != 2
        || !incoming.state.is_terminal()
        || (!allow_unknown && incoming.state == EffectJournalState::UnknownOutcome)
    {
        return Err(StorageError::Corrupt);
    }
    let Some(correlation) = expected.correlation.as_ref() else {
        return Err(StorageError::Corrupt);
    };
    incoming.verify().map_err(|_| StorageError::Corrupt)?;
    let (incoming_jcs, _) = incoming
        .canonical_bytes_and_digest()
        .map_err(|_| StorageError::Corrupt)?;
    if incoming_jcs.as_ref().len() > MAX_EFFECT_JOURNAL_JCS_BYTES {
        return Err(StorageError::Full);
    }

    let tx = connection.transaction().map_err(map_sqlite_error)?;
    let authoritative = match load_verified_inner(&tx, &expected.claim)? {
        Some(row) => row,
        None => return Err(StorageError::Corrupt),
    };

    if authoritative.journal_revision != expected.expected_journal_revision
        || authoritative.state != expected.expected_state
    {
        return tx
            .commit()
            .map(|()| EffectCasOutcome::Stale { authoritative })
            .map_err(map_sqlite_error);
    }
    if authoritative.state != EffectJournalState::Intended
        || authoritative.journal_revision != 1
        || expected.expected_journal_revision != 1
        || expected.expected_state != EffectJournalState::Intended
        || !correlation_matches(correlation, &authoritative)
        || !same_intent_context(incoming, &authoritative)
    {
        return tx
            .commit()
            .map(|()| EffectCasOutcome::Stale { authoritative })
            .map_err(map_sqlite_error);
    }

    // A terminal ledger fact with this operation/effect identity cannot prove
    // which Claim it belongs to when another Claim already carries the same
    // frozen operation and outbound digest. Treat the evidence as ambiguous;
    // never let a new Claim consume an old Claim's terminal evidence.
    let competing = has_competing_claim(&tx, &authoritative)?;
    if competing && (!allow_unknown || incoming.state != EffectJournalState::UnknownOutcome) {
        return tx
            .commit()
            .map(|()| EffectCasOutcome::Stale { authoritative })
            .map_err(map_sqlite_error);
    }

    let ledger = crate::tool_ledger::load_verified_inner(
        &tx,
        &authoritative.claim.module_id,
        &authoritative.claim.operation_id,
    )?;
    let settlement = recover_effect_journal(&authoritative, ledger.as_ref());
    let expected_incoming = match settlement {
        EffectSettlement::Applied { evidence_digest } => ExternalEffectJournalRecord {
            journal_revision: 2,
            state: EffectJournalState::Applied,
            evidence_digest: Some(evidence_digest),
            ..authoritative.clone()
        },
        EffectSettlement::NotApplied { evidence_digest } => ExternalEffectJournalRecord {
            journal_revision: 2,
            state: EffectJournalState::NotApplied,
            evidence_digest: Some(evidence_digest),
            ..authoritative.clone()
        },
        EffectSettlement::UnknownOutcome => ExternalEffectJournalRecord {
            journal_revision: 2,
            state: EffectJournalState::UnknownOutcome,
            evidence_digest: None,
            ..authoritative.clone()
        },
    };
    if expected_incoming != *incoming
        || (!allow_unknown && expected_incoming.state == EffectJournalState::UnknownOutcome)
    {
        return tx
            .commit()
            .map(|()| EffectCasOutcome::Stale { authoritative })
            .map_err(map_sqlite_error);
    }

    let (jcs, digest) = expected_incoming
        .canonical_bytes_and_digest()
        .map_err(|_| StorageError::Corrupt)?;
    let changed = tx
        .execute(
            "UPDATE external_effect_journal SET
                journal_revision = ?4, state = ?5, evidence_digest = ?6,
                record_jcs = ?7, record_digest = ?8
             WHERE instance_id = ?1 AND module_id = ?2 AND operation_id = ?3
               AND claim_token = ?9
               AND journal_revision = ?10 AND state = ?11",
            rusqlite::params![
                expected.claim.instance_id,
                expected.claim.module_id,
                expected.claim.operation_id,
                expected_incoming.journal_revision as i64,
                expected_incoming.state.wire_name(),
                expected_incoming
                    .evidence_digest
                    .as_ref()
                    .map(|d| d.to_canonical_string()),
                jcs.as_ref(),
                digest.to_canonical_string(),
                expected.claim.claim_token.to_canonical_string(),
                expected.expected_journal_revision as i64,
                expected.expected_state.wire_name(),
            ],
        )
        .map_err(map_sqlite_error)?;

    if changed == 0 {
        let authoritative =
            load_verified_inner(&tx, &expected.claim)?.ok_or(StorageError::Corrupt)?;
        return tx
            .commit()
            .map(|()| EffectCasOutcome::Stale { authoritative })
            .map_err(map_sqlite_error);
    }

    tx.commit().map_err(map_sqlite_error)?;
    Ok(EffectCasOutcome::Committed {
        record: load_exact(connection, &expected.claim)?.ok_or(StorageError::Corrupt)?,
    })
}

fn same_intent_context(
    left: &ExternalEffectJournalRecord,
    right: &ExternalEffectJournalRecord,
) -> bool {
    left.claim == right.claim
        && left.controller_generation == right.controller_generation
        && left.extension_generation == right.extension_generation
        && left.worker_epoch == right.worker_epoch
        && left.package_digest == right.package_digest
        && left.policy_premise_digest == right.policy_premise_digest
        && left.operation_digest == right.operation_digest
        && left.effect_class == right.effect_class
        && left.intent_digest == right.intent_digest
}

fn correlation_matches(
    correlation: &EffectCorrelation,
    record: &ExternalEffectJournalRecord,
) -> bool {
    correlation.controller_generation == record.controller_generation
        && correlation.extension_generation == record.extension_generation
        && correlation.worker_epoch == record.worker_epoch
        && correlation.package_digest == record.package_digest
        && correlation.policy_premise_digest == record.policy_premise_digest
        && correlation.operation_digest == record.operation_digest
        && correlation.outbound_digest == record.intent_digest
        && correlation.effect_class == record.effect_class
}
fn correlation_of(record: &ExternalEffectJournalRecord) -> EffectCorrelation {
    EffectCorrelation {
        controller_generation: record.controller_generation,
        extension_generation: record.extension_generation,
        worker_epoch: record.worker_epoch.clone(),
        package_digest: record.package_digest.clone(),
        policy_premise_digest: record.policy_premise_digest.clone(),
        operation_digest: record.operation_digest.clone(),
        outbound_digest: record.intent_digest.clone(),
        effect_class: record.effect_class,
    }
}

fn has_competing_claim(
    transaction: &Transaction<'_>,
    record: &ExternalEffectJournalRecord,
) -> StorageResult<bool> {
    let mut statement = transaction
        .prepare(COMPETING_SELECT_SQL)
        .map_err(map_sqlite_error)?;
    let mut rows = statement
        .query(rusqlite::params![
            record.claim.instance_id,
            record.claim.module_id,
            record.claim.operation_id,
            record.operation_digest.to_canonical_string(),
            record.intent_digest.to_canonical_string(),
            record.claim.claim_token.to_canonical_string(),
        ])
        .map_err(map_sqlite_error)?;
    while let Some(row) = rows.next().map_err(map_sqlite_error)? {
        let competing = verify_row(row)?;
        if competing.claim != record.claim {
            return Ok(true);
        }
    }
    Ok(false)
}
fn has_competing_claim_connection(
    connection: &Connection,
    record: &ExternalEffectJournalRecord,
) -> StorageResult<bool> {
    let mut statement = connection
        .prepare(COMPETING_SELECT_SQL)
        .map_err(map_sqlite_error)?;
    let mut rows = statement
        .query(rusqlite::params![
            record.claim.instance_id,
            record.claim.module_id,
            record.claim.operation_id,
            record.operation_digest.to_canonical_string(),
            record.intent_digest.to_canonical_string(),
            record.claim.claim_token.to_canonical_string(),
        ])
        .map_err(map_sqlite_error)?;
    while let Some(row) = rows.next().map_err(map_sqlite_error)? {
        let competing = verify_row(row)?;
        if competing.claim != record.claim {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Exact Claim load with full canonical-byte/digest verification and
/// per-indexed-column checks (including the derivable claim token).
/// `Ok(None)` is an absent Claim.
pub fn load_exact(
    connection: &rusqlite::Connection,
    claim: &Claim,
) -> StorageResult<Option<ExternalEffectJournalRecord>> {
    gate_schema_version(connection)?;
    let mut stmt = connection.prepare(SELECT_SQL).map_err(map_sqlite_error)?;
    let mut rows = stmt
        .query(rusqlite::params![
            claim.instance_id,
            claim.module_id,
            claim.operation_id,
            claim.claim_token.to_canonical_string(),
        ])
        .map_err(map_sqlite_error)?;
    let Some(row) = rows.next().map_err(map_sqlite_error)? else {
        return Ok(None);
    };
    verify_row(row).map(Some)
}

fn load_verified_inner(
    transaction: &Transaction,
    claim: &Claim,
) -> StorageResult<Option<ExternalEffectJournalRecord>> {
    let mut stmt = transaction.prepare(SELECT_SQL).map_err(map_sqlite_error)?;
    let mut rows = stmt
        .query(rusqlite::params![
            claim.instance_id,
            claim.module_id,
            claim.operation_id,
            claim.claim_token.to_canonical_string(),
        ])
        .map_err(map_sqlite_error)?;
    let Some(row) = rows.next().map_err(map_sqlite_error)? else {
        return Ok(None);
    };
    verify_row(row).map(Some)
}

const SELECT_SQL: &str = "SELECT instance_id, module_id, operation_id, claim_token,
                    journal_revision, state, controller_generation,
                    extension_generation, worker_epoch, package_digest,
                    policy_premise_digest, operation_digest, effect_class,
                    intent_digest, evidence_digest, record_jcs, record_digest
             FROM external_effect_journal
             WHERE instance_id = ?1 AND module_id = ?2 AND operation_id = ?3
               AND claim_token = ?4";
const RETENTION_SELECT_SQL: &str = "SELECT instance_id, module_id, operation_id, claim_token,
                    journal_revision, state, controller_generation,
                    extension_generation, worker_epoch, package_digest,
                    policy_premise_digest, operation_digest, effect_class,
                    intent_digest, evidence_digest, record_jcs, record_digest
             FROM external_effect_journal
             WHERE state IN ('APPLIED', 'NOT_APPLIED')
             ORDER BY instance_id, module_id, operation_id, claim_token";
const ALL_SELECT_SQL: &str = "SELECT instance_id, module_id, operation_id, claim_token,
                    journal_revision, state, controller_generation,
                    extension_generation, worker_epoch, package_digest,
                    policy_premise_digest, operation_digest, effect_class,
                    intent_digest, evidence_digest, record_jcs, record_digest
             FROM external_effect_journal
             ORDER BY instance_id, module_id, operation_id, claim_token";

const COMPETING_SELECT_SQL: &str = "SELECT instance_id, module_id, operation_id, claim_token,
                    journal_revision, state, controller_generation,
                    extension_generation, worker_epoch, package_digest,
                    policy_premise_digest, operation_digest, effect_class,
                    intent_digest, evidence_digest, record_jcs, record_digest
             FROM external_effect_journal
             WHERE instance_id = ?1 AND module_id = ?2 AND operation_id = ?3
               AND operation_digest = ?4 AND intent_digest = ?5
               AND claim_token <> ?6
             ORDER BY claim_token";

/// The full verification every read passes:
///   - `record_digest` recomputes to `sha256(record_jcs)`;
///   - `record_jcs` re-decodes to a closed, field-consistent record;
///   - the derivable claim token recomputes;
///   - every indexed column equals the decoded record.
///
/// Any mismatch is `STORAGE_CORRUPT`: no repair, deletion, or
/// reinterpretation.
fn verify_row(row: &Row) -> StorageResult<ExternalEffectJournalRecord> {
    let instance_id: String = row.get(0).map_err(map_sqlite_error)?;
    let module_id: String = row.get(1).map_err(map_sqlite_error)?;
    let operation_id: String = row.get(2).map_err(map_sqlite_error)?;
    let claim_token: String = row.get(3).map_err(map_sqlite_error)?;
    let journal_revision: i64 = row.get(4).map_err(map_sqlite_error)?;
    let state: String = row.get(5).map_err(map_sqlite_error)?;
    let controller_generation: i64 = row.get(6).map_err(map_sqlite_error)?;
    let extension_generation: i64 = row.get(7).map_err(map_sqlite_error)?;
    let worker_epoch: String = row.get(8).map_err(map_sqlite_error)?;
    let package_digest: String = row.get(9).map_err(map_sqlite_error)?;
    let policy_premise_digest: String = row.get(10).map_err(map_sqlite_error)?;
    let operation_digest: String = row.get(11).map_err(map_sqlite_error)?;
    let effect_class: String = row.get(12).map_err(map_sqlite_error)?;
    let intent_digest: String = row.get(13).map_err(map_sqlite_error)?;
    let evidence_digest: Option<String> = row.get(14).map_err(map_sqlite_error)?;
    let record_jcs: Vec<u8> = row.get(15).map_err(map_sqlite_error)?;
    let record_digest: String = row.get(16).map_err(map_sqlite_error)?;

    if record_jcs.len() > MAX_EFFECT_JOURNAL_JCS_BYTES
        || journal_revision <= 0
        || controller_generation <= 0
        || extension_generation <= 0
    {
        return Err(StorageError::Corrupt);
    }
    if Sha256Digest::compute(&record_jcs).to_canonical_string() != record_digest {
        return Err(StorageError::Corrupt);
    }
    let decoded: ExternalEffectJournalRecord =
        deserialize_core_json(&record_jcs, ParseLimits::protocol_wire())
            .map_err(|_| StorageError::Corrupt)?;
    decoded.verify().map_err(|_| StorageError::Corrupt)?;

    let effect_class_value = EffectClass::from_wire(&effect_class).ok_or(StorageError::Corrupt)?;
    let state_value = EffectJournalState::from_wire(&state).ok_or(StorageError::Corrupt)?;
    if decoded.journal_revision != journal_revision as u64
        || decoded.state != state_value
        || decoded.state.wire_name() != state
        || decoded.claim.instance_id != instance_id
        || decoded.claim.module_id != module_id
        || decoded.claim.operation_id != operation_id
        || decoded.claim.claim_token.to_canonical_string() != claim_token
        || decoded.controller_generation != controller_generation as u64
        || decoded.extension_generation != extension_generation as u64
        || decoded.worker_epoch != worker_epoch
        || decoded.package_digest.to_canonical_string() != package_digest
        || decoded.policy_premise_digest.to_canonical_string() != policy_premise_digest
        || decoded.operation_digest.to_canonical_string() != operation_digest
        || decoded.effect_class != effect_class_value
        || decoded.intent_digest.to_canonical_string() != intent_digest
        || decoded
            .evidence_digest
            .as_ref()
            .map(|d| d.to_canonical_string())
            != evidence_digest
    {
        return Err(StorageError::Corrupt);
    }

    Ok(decoded)
}

/// Enumerate every pending (`INTENDED`) row in deterministic
/// `(instance_id, module_id, operation_id, claim_token)` order. Every row is
/// fully verified; any corrupt row fails the whole enumeration (fail-closed,
/// no partial list).
pub fn enumerate_pending(
    connection: &rusqlite::Connection,
) -> StorageResult<Vec<ExternalEffectJournalRecord>> {
    gate_schema_version(connection)?;
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

const ENUMERATE_SQL: &str = "SELECT instance_id, module_id, operation_id, claim_token,
                    journal_revision, state, controller_generation,
                    extension_generation, worker_epoch, package_digest,
                    policy_premise_digest, operation_digest, effect_class,
                    intent_digest, evidence_digest, record_jcs, record_digest
             FROM external_effect_journal
             WHERE state = 'INTENDED'
             ORDER BY instance_id, module_id, operation_id, claim_token";

/// Apply the pure recovery decision to one stored pending row (pure, no I/O;
/// the caller then compare-and-sets the proposal).
pub fn propose_effect_recovery(
    record: &ExternalEffectJournalRecord,
    ledger: Option<&ToolCallLedgerRecord>,
) -> EffectSettlement {
    recover_effect_journal(record, ledger)
}

/// Bound on pure re-decisions per row inside [`settle_pending_effect_journal`]
/// (a CAS can legally return stale once; a repeated stale loop is refused).
pub const MAX_REOPEN_DECISIONS_PER_ROW: usize = 6;

/// Outcome of one deterministic reopen pass over the journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectJournalRecoveryOutcome {
    /// Number of `INTENDED` rows enumerated in deterministic order.
    pub rows_visited: usize,
    /// Settled `APPLIED` from identity-matching provider evidence.
    pub settled_applied: usize,
    /// Settled `NOT_APPLIED` from identity-matching provider evidence.
    pub settled_not_applied: usize,
    /// Settled `UNKNOWN_OUTCOME` (ambiguous; absence or mismatched evidence).
    pub settled_unknown: usize,
    /// Rows left `INTENDED` because the bounded re-decision loop could not
    /// land one settlement (stale storm). Recovery fails closed on this.
    pub refused: usize,
}

/// The reopen recovery seam the sole Rust Worker runs after startup: a
/// deterministic enumeration of every pending `INTENDED` row, a pure decision
/// over ONLY the authoritative Tool-call ledger terminal record of the exact
/// same operation, and a compare-and-set of the resulting settlement. No
/// downstream ACK/response/cache/readiness/process-exit/stale-authority is an
/// input, and nothing is ever re-dispatched.
///
/// A pending row whose decision is `Stale` is re-loaded and re-decided a
/// bounded number of times; a repeated stale loop refuses the whole pass
/// (`Err(StorageError::Busy)`-like fail-closed instead of a partial write).
pub fn settle_pending_effect_journal(
    db: &mut Database,
) -> StorageResult<EffectJournalRecoveryOutcome> {
    gate_schema_version(db.connection())?;
    let pending = enumerate_pending(db.connection())?;
    let mut outcome = EffectJournalRecoveryOutcome {
        rows_visited: pending.len(),
        settled_applied: 0,
        settled_not_applied: 0,
        settled_unknown: 0,
        refused: 0,
    };
    for mut current in pending {
        let mut settled = false;
        for _ in 0..MAX_REOPEN_DECISIONS_PER_ROW {
            if current.state != EffectJournalState::Intended {
                break;
            }
            let ledger = crate::tool_ledger::load_exact(
                db.connection(),
                &current.claim.module_id,
                &current.claim.operation_id,
            )?;
            let settlement = if has_competing_claim_connection(db.connection(), &current)? {
                EffectSettlement::UnknownOutcome
            } else {
                recover_effect_journal(&current, ledger.as_ref())
            };
            let incoming = match &settlement {
                EffectSettlement::Applied { evidence_digest } => ExternalEffectJournalRecord {
                    journal_revision: 2,
                    state: EffectJournalState::Applied,
                    evidence_digest: Some(evidence_digest.clone()),
                    ..current.clone()
                },
                EffectSettlement::NotApplied { evidence_digest } => ExternalEffectJournalRecord {
                    journal_revision: 2,
                    state: EffectJournalState::NotApplied,
                    evidence_digest: Some(evidence_digest.clone()),
                    ..current.clone()
                },
                EffectSettlement::UnknownOutcome => ExternalEffectJournalRecord {
                    journal_revision: 2,
                    state: EffectJournalState::UnknownOutcome,
                    evidence_digest: None,
                    ..current.clone()
                },
            };
            let key = EffectCasKey {
                claim: current.claim.clone(),
                expected_journal_revision: current.journal_revision,
                expected_state: current.state,
                correlation: Some(correlation_of(&current)),
            };
            match cas_settle_recovery(db.connection_mut(), &key, &incoming)? {
                EffectCasOutcome::Committed { record } => {
                    match &settlement {
                        EffectSettlement::Applied { .. } => outcome.settled_applied += 1,
                        EffectSettlement::NotApplied { .. } => outcome.settled_not_applied += 1,
                        EffectSettlement::UnknownOutcome => outcome.settled_unknown += 1,
                    }
                    let _ = record;
                    settled = true;
                    break;
                }
                EffectCasOutcome::Stale { authoritative } => {
                    // Another ready chain already settled (or spoiled) it;
                    // re-decide the verified authoritative row.
                    current = authoritative;
                }
            }
        }
        if !settled {
            outcome.refused += 1;
            return Err(StorageError::Corrupt);
        }
    }
    Ok(outcome)
}
