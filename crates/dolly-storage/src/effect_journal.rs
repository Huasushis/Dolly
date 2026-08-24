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
use dolly_tool_broker::ToolCallLedgerRecord;
use dolly_tool_broker::effect_journal::{
    Claim, EFFECT_JOURNAL_RECORD_SCHEMA, EffectClass, EffectJournalState, EffectSettlement,
    ExternalEffectJournalRecord, recover_effect_journal,
};
use rusqlite::{Row, Transaction};

use crate::database::{Database, map_sqlite_error};
use crate::error::{StorageError, StorageResult};

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
/// journal table, and the recovery index. Autonomic (`IF NOT EXISTS`).
pub const EFFECT_JOURNAL_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS external_effect_journal_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_discriminator TEXT NOT NULL
        CHECK (schema_discriminator = 'dolly.external-effect-journal/v1')
);
CREATE TABLE IF NOT EXISTS external_effect_journal (
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
CREATE INDEX IF NOT EXISTS effect_journal_recovery
    ON external_effect_journal(state, instance_id, module_id, operation_id, claim_token);
"#;

/// Create the authoritative effect-journal schema (meta singleton, journal
/// table, recovery index). Idempotent (`IF NOT EXISTS`).
pub fn create_effect_journal_schema(connection: &rusqlite::Connection) -> StorageResult<()> {
    connection
        .execute_batch(EFFECT_JOURNAL_SCHEMA_SQL)
        .map_err(map_sqlite_error)?;
    connection
        .execute_batch(EFFECT_JOURNAL_RECOVERY_INDEX_SQL)
        .map_err(map_sqlite_error)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO external_effect_journal_meta
                (singleton, schema_version, schema_discriminator)
             VALUES (1, 1, 'dolly.external-effect-journal/v1')",
            [],
        )
        .map_err(map_sqlite_error)?;
    gate_schema_version(connection)
}

/// Fail-closed schema-version gate every writer/reader must pass. A missing
/// meta singleton, a wrong schema version, or a wrong discriminator is a
/// version-mismatched premise: `STORAGE_MIGRATION_REQUIRED`. A missing
/// journal table is `STORAGE_CORRUPT`.
pub fn gate_schema_version(connection: &rusqlite::Connection) -> StorageResult<()> {
    let mut stmt = connection
        .prepare(
            "SELECT schema_version, schema_discriminator
             FROM external_effect_journal_meta WHERE singleton = 1",
        )
        .map_err(map_sqlite_error)?;
    let mut rows = stmt.query([]).map_err(map_sqlite_error)?;
    let Some(row) = rows.next().map_err(map_sqlite_error)? else {
        return Err(StorageError::MigrationRequired);
    };
    let version: i64 = row.get(0).map_err(map_sqlite_error)?;
    let discriminator: String = row.get(1).map_err(map_sqlite_error)?;
    if version != 1 || discriminator != EFFECT_JOURNAL_RECORD_SCHEMA {
        return Err(StorageError::MigrationRequired);
    }
    Ok(())
}

/// The result of inserting an `INTENDED` journal intent row.
#[derive(Debug, Clone, PartialEq)]
pub enum EffectJournalInsertDisposition {
    /// A brand-new revision-1 `INTENDED` row committed.
    Inserted { record: ExternalEffectJournalRecord },
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
    /// Correlation the incoming settled record must satisfy and the stored
    /// row must match, present exactly for `APPLIED`/`NOT_APPLIED` settles.
    /// A mismatch is ambiguity: nothing changes.
    pub correlation: Option<EffectCorrelation>,
}

/// The identity correlation that must match the row being settled.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectCorrelation {
    /// The exact operation identity digest of the evidence operation.
    pub operation_digest: Sha256Digest,
    /// The exact effect identity (intent digest == dispatched outbound
    /// digest) of the evidence operation.
    pub intent_digest: Sha256Digest,
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

    // Whole-journal ceiling: run safe retention first inside the same
    // transaction, then fail closed when the journal is still at the cap.
    let total: i64 = tx
        .query_row("SELECT COUNT(*) FROM external_effect_journal", [], |row| row.get(0))
        .map_err(map_sqlite_error)?;
    if (total as u64) >= MAX_EFFECT_JOURNAL_ROWS {
        retain_bounded_rows(&tx)?;
    }
    // Re-check after retention: an intent that still cannot be admitted is a
    // journal at its ceiling and its pending intent must be refused: STORAGE_FULL.
    let total_after: i64 = tx
        .query_row("SELECT COUNT(*) FROM external_effect_journal", [], |row| row.get(0))
        .map_err(map_sqlite_error)?;
    if (total_after as u64) >= MAX_EFFECT_JOURNAL_ROWS {
        return Err(StorageError::Full);
    }

    let claim = &record.claim;
    let authoritative = load_verified_inner(&tx, claim)?;
    if let Some(authoritative) = authoritative {
        // Same Claim: replay the authoritative row. Never a second Intent
        // under one Claim; a new attempt requires a new Claim.
        return tx
            .commit()
            .map(|()| EffectJournalInsertDisposition::Replayed {
                record: authoritative,
            })
            .map_err(map_sqlite_error);
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
    Ok(EffectJournalInsertDisposition::Inserted {
        record: load_exact(connection, claim)?.ok_or(StorageError::Corrupt)?,
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
    // Delete the deterministically oldest safe rows until the journal would
    // have room again (below the whole-journal ceiling); a fresh recheck is
    // cheap and keeps the transaction small.
    loop {
        let free: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM external_effect_journal
                 WHERE state IN ('APPLIED', 'NOT_APPLIED')",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite_error)?;
        let total: i64 = transaction
            .query_row("SELECT COUNT(*) FROM external_effect_journal", [], |row| row.get(0))
            .map_err(map_sqlite_error)?;
        if free == 0 || (total as u64) < MAX_EFFECT_JOURNAL_ROWS {
            break;
        }
        // Delete exactly the rows needed to fall below the ceiling (an
        // intent insert needs one slot), never more than the deletable set.
        let delete = ((total as u64) - MAX_EFFECT_JOURNAL_ROWS + 1).min(free as u64) as i64;
        transaction
            .execute(
                "DELETE FROM external_effect_journal
                 WHERE rowid IN (
                    SELECT rowid FROM external_effect_journal
                    WHERE state IN ('APPLIED', 'NOT_APPLIED')
                    ORDER BY instance_id, module_id, operation_id, claim_token
                    LIMIT ?1
                 )",
                rusqlite::params![delete],
            )
            .map_err(map_sqlite_error)?;
        let left: i64 = transaction
            .query_row("SELECT COUNT(*) FROM external_effect_journal", [], |row| row.get(0))
            .map_err(map_sqlite_error)?;
        if (left as u64) < MAX_EFFECT_JOURNAL_ROWS {
            break;
        }
    }
    Ok(())
}

/// Settle `INTENDED` to `APPLIED`/`NOT_APPLIED`/`UNKNOWN_OUTCOME`.
///
/// The transition commits only when the stored row still has the expected
/// Claim, revision, and state. For `APPLIED`/`NOT_APPLIED` the caller must
/// also provide the exact correlation (operation + effect identity) that both
/// the stored row and the incoming record satisfy; a mismatch is
/// `EffectCasOutcome::Stale` with zero mutation. `UNKNOWN_OUTCOME` needs no
/// correlation. No transition across terminal rows exists (settled rows are
/// immutable).
pub fn cas_settle(
    connection: &mut rusqlite::Connection,
    expected: &EffectCasKey,
    incoming: &ExternalEffectJournalRecord,
) -> StorageResult<EffectCasOutcome> {
    if !incoming.state.is_terminal() || incoming.journal_revision != 2 {
        return Err(StorageError::Corrupt);
    }
    incoming.verify().map_err(|_| StorageError::Corrupt)?;

    // For applied/not-applied the evidence digest must be present; the
    // evidence identity itself is enforced below against the stored row. The
    // broker decision (recover_effect_journal) owns provenance of the digest.
    if let Some(correlation) = expected.correlation.as_ref() {
        if incoming.evidence_digest.is_none() {
            return Err(StorageError::Corrupt);
        }
        let _ = correlation;
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

    // A settled applied/not-applied must correlate with the stored row's
    // operation and effect identity (same Claim and generation).
    if let Some(correlation) = &expected.correlation {
        if authoritative.operation_digest != correlation.operation_digest
            || authoritative.intent_digest != correlation.intent_digest
        {
            return tx
                .commit()
                .map(|()| EffectCasOutcome::Stale { authoritative })
                .map_err(map_sqlite_error);
        }
    }

    // Revisions must step by exactly one (1 -> 2, no regress, no skip).
    if incoming.journal_revision != expected.expected_journal_revision + 1 {
        return Err(StorageError::Corrupt);
    }

    let (jcs, digest) = incoming
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
                incoming.journal_revision as i64,
                incoming.state.wire_name(),
                incoming
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
            let settlement = recover_effect_journal(&current, ledger.as_ref());
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
                correlation: match &settlement {
                    EffectSettlement::Applied { .. } | EffectSettlement::NotApplied { .. } => {
                        Some(EffectCorrelation {
                            operation_digest: current.operation_digest.clone(),
                            intent_digest: current.intent_digest.clone(),
                        })
                    }
                    EffectSettlement::UnknownOutcome => None,
                },
            };
            match cas_settle(db.connection_mut(), &key, &incoming)? {
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
