//! Durable SQLite alarm authority.
//!
//! The store owns the alarm records, their materialized occurrences, the
//! claim/lease/ack/result state, the misfire diagnostics, and the action
//! reconciliation log. Every effect is one immediate transaction so a crash
//! at any effect boundary leaves the exact pre-effect state; the occurrence
//! identity rules are deterministic so restart, tzdb change, and replay
//! converge on the same rows (`INSERT OR IGNORE` by the canonical identity).
//!
//! The store never reads a wall clock, constructs an Action, or mutates a
//! Page/cursor — it only persists authority the scheduler derives from
//! committed Actions and injected time.

use crate::error::{AlarmError, AlarmErrorCode};
use crate::failpoint::{Failpoint, FailpointBoundary};
use crate::record::{AlarmRecord, DeliveryShape, MisfirePolicy, ScheduleShape};
use crate::time::{UsInstant, format_utc_iso6};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::path::Path;

pub const ALARM_SCHEMA_VERSION: i64 = 1;

pub const ALARM_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS alarm_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alarms (
    alarm_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    title TEXT NOT NULL,
    schedule_json TEXT NOT NULL,
    delivery_json TEXT NOT NULL,
    misfire_policy TEXT NOT NULL,
    dst_gap_policy TEXT NOT NULL,
    dst_fold_policy TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    next_occurrence TEXT,
    tzdb_revision TEXT NOT NULL,
    config_revision TEXT NOT NULL,
    authority TEXT NOT NULL,
    action_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS occurrences (
    occurrence_id TEXT PRIMARY KEY,
    alarm_id TEXT NOT NULL,
    alarm_revision INTEGER NOT NULL,
    kind TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    scheduled_us INTEGER NOT NULL,
    fold_ordinal INTEGER NOT NULL,
    repeat_ordinal INTEGER NOT NULL DEFAULT 0,
    parent_occurrence_id TEXT,
    state TEXT NOT NULL,
    repeat_suppress_from INTEGER,
    claim_token TEXT,
    claim_holder TEXT,
    claim_made_at TEXT,
    lease_expires_us INTEGER,
    fired_at TEXT,
    lateness_us INTEGER,
    misfire_basis TEXT,
    ack_state TEXT,
    acknowledged_at TEXT,
    missed_reason TEXT,
    missed_count INTEGER,
    result_kind TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_occurrences_due ON occurrences(alarm_id, scheduled_us) WHERE state = 'due';
CREATE INDEX IF NOT EXISTS idx_occurrences_state ON occurrences(state, scheduled_us);
CREATE TABLE IF NOT EXISTS action_log (
    action_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    outcome TEXT NOT NULL,
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    alarm_id TEXT,
    applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS misfire_diagnostics (
    alarm_id TEXT NOT NULL,
    policy TEXT NOT NULL,
    from_us INTEGER NOT NULL,
    to_us INTEGER NOT NULL,
    count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (alarm_id, policy, from_us, to_us)
);
"#;

/// A won claim the caller now holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub occurrence_id: String,
    pub alarm_id: String,
    pub alarm_revision: u64,
    pub claim_token: String,
    pub scheduled_at: String,
    pub scheduled_us: UsInstant,
    pub fold_ordinal: u8,
    pub kind: OccurrenceKind,
    pub repeat_ordinal: u64,
    pub parent_occurrence_id: Option<String>,
    pub misfire_basis: Option<MisfireBasis>,
    pub claim_made_at: String,
    pub lease_expires_us: UsInstant,
}

/// The stored claim/lease/result state of one occurrence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    pub occurrence_id: String,
    pub alarm_id: String,
    pub alarm_revision: u64,
    pub kind: OccurrenceKind,
    pub scheduled_at: String,
    pub scheduled_us: UsInstant,
    pub fold_ordinal: u8,
    pub repeat_ordinal: u64,
    pub parent_occurrence_id: Option<String>,
    pub state: OccurrenceState,
    pub repeat_suppress_from: Option<u64>,
    pub claim_token: Option<String>,
    pub claim_holder: Option<String>,
    pub claim_made_at: Option<String>,
    pub lease_expires_us: Option<UsInstant>,
    pub fired_at: Option<String>,
    pub lateness_us: Option<UsInstant>,
    pub misfire_basis: Option<MisfireBasis>,
    pub ack_state: Option<String>,
    pub acknowledged_at: Option<String>,
    pub missed_reason: Option<String>,
    pub missed_count: Option<u64>,
    pub result_kind: Option<String>,
    pub result_json: Option<String>,
    pub created_at: String,
}

/// A claim held by a worker that expired and needs reconciliation.
#[derive(Debug, Clone)]
pub struct ExpiredClaim {
    pub occurrence: Occurrence,
    pub alarm: Option<AlarmRow>,
}

/// New-occurrence materialization input.
#[derive(Debug, Clone)]
pub struct NewOccurrence {
    pub occurrence_id: String,
    pub scheduled_us: UsInstant,
    pub fold_ordinal: u8,
    pub kind: OccurrenceKind,
    pub repeat_ordinal: u64,
    pub parent_occurrence_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OccurrenceKind {
    Scheduled,
    Repeat,
    Snooze,
}

impl OccurrenceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            OccurrenceKind::Scheduled => "scheduled",
            OccurrenceKind::Repeat => "repeat",
            OccurrenceKind::Snooze => "snooze",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OccurrenceState {
    Due,
    Claimed,
    Fired,
    Missed,
    Suppressed,
}

impl OccurrenceState {
    pub fn as_str(self) -> &'static str {
        match self {
            OccurrenceState::Due => "due",
            OccurrenceState::Claimed => "claimed",
            OccurrenceState::Fired => "fired",
            OccurrenceState::Missed => "missed",
            OccurrenceState::Suppressed => "suppressed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MisfireBasis {
    FireOnce,
    CatchUp,
}

impl MisfireBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            MisfireBasis::FireOnce => "fire_once",
            MisfireBasis::CatchUp => "catch_up",
        }
    }
}

/// A durable alarm row.
#[derive(Debug, Clone, PartialEq)]
pub struct AlarmRow {
    pub alarm_id: String,
    pub revision: u64,
    pub title: String,
    pub schedule_shape: ScheduleShape,
    pub delivery_shape: DeliveryShape,
    pub misfire_policy: MisfirePolicy,
    pub dst_gap_policy: crate::occurrence::DstGapPolicy,
    pub dst_fold_policy: crate::occurrence::DstFoldPolicy,
    pub enabled: bool,
    pub created_at: String,
    pub next_occurrence: Option<String>,
    pub tzdb_revision: String,
    pub config_revision: String,
    pub authority: String,
    pub action_id: String,
    pub updated_at: String,
    pub deleted: bool,
}

impl AlarmRow {
    pub fn record(&self) -> AlarmRecord {
        AlarmRecord {
            alarm_id: self.alarm_id.clone(),
            revision: self.revision,
            title: self.title.clone(),
            schedule: self.schedule_shape.clone(),
            delivery: self.delivery_shape.clone(),
            misfire_policy: self.misfire_policy,
            dst_gap_policy: self.dst_gap_policy,
            dst_fold_policy: self.dst_fold_policy,
            enabled: self.enabled,
            created_at: self.created_at.clone(),
            next_occurrence: self.next_occurrence.clone(),
            tzdb_revision: self.tzdb_revision.clone(),
        }
    }
}

/// A recorded applied action for deterministic replay.
#[derive(Debug, Clone)]
pub struct RecordedAction {
    pub name: String,
    pub result_json: serde_json::Value,
    pub alarm_id: Option<String>,
    pub applied_at: String,
}

const ALARM_SELECT: &str = "SELECT alarm_id, revision, title, schedule_json, delivery_json, \
    misfire_policy, dst_gap_policy, dst_fold_policy, enabled, created_at, next_occurrence, \
    tzdb_revision, config_revision, authority, action_id, updated_at, deleted FROM alarms";

fn db_unavailable(context: &str, error: rusqlite::Error) -> AlarmError {
    let mut details = serde_json::Map::new();
    details.insert(
        "context".to_string(),
        serde_json::Value::String(context.to_string()),
    );
    details.insert(
        "message".to_string(),
        serde_json::Value::String(error.to_string()),
    );
    AlarmError::with_details(
        AlarmErrorCode::DatabaseUnavailable,
        format!("database unavailable during {context}"),
        details,
    )
}

fn trip(failpoint: Option<&Failpoint>, boundary: FailpointBoundary) -> Result<(), AlarmError> {
    if let Some(failpoint) = failpoint {
        if let Some(error) = failpoint.trip(boundary) {
            return Err(error);
        }
    }
    Ok(())
}

fn transaction<T>(
    conn: &mut Connection,
    check: Result<(), AlarmError>,
    body: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T, AlarmError>,
) -> Result<T, AlarmError> {
    check?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| db_unavailable("transaction", e))?;
    let value = body(&tx)?;
    tx.commit().map_err(|e| db_unavailable("commit", e))?;
    Ok(value)
}

fn row_from_statement(row: &rusqlite::Row<'_>) -> rusqlite::Result<AlarmRow> {
    let schedule_json: String = row.get("schedule_json")?;
    let delivery_json: String = row.get("delivery_json")?;
    let schedule_shape = serde_json::from_str(&schedule_json).map_err(sql_convert)?;
    let delivery_shape = serde_json::from_str(&delivery_json).map_err(sql_convert)?;
    let misfire_policy =
        serde_json::from_str::<MisfirePolicy>(&row.get::<_, String>("misfire_policy")?)
            .map_err(sql_convert)?;
    let dst_gap_policy = serde_json::from_str::<crate::occurrence::DstGapPolicy>(
        &row.get::<_, String>("dst_gap_policy")?,
    )
    .map_err(sql_convert)?;
    let dst_fold_policy = serde_json::from_str::<crate::occurrence::DstFoldPolicy>(
        &row.get::<_, String>("dst_fold_policy")?,
    )
    .map_err(sql_convert)?;
    Ok(AlarmRow {
        alarm_id: row.get("alarm_id")?,
        revision: row.get::<_, i64>("revision").map(|v| v as u64)?,
        title: row.get("title")?,
        schedule_shape,
        delivery_shape,
        misfire_policy,
        dst_gap_policy,
        dst_fold_policy,
        enabled: row.get("enabled")?,
        created_at: row.get("created_at")?,
        next_occurrence: row.get("next_occurrence")?,
        tzdb_revision: row.get("tzdb_revision")?,
        config_revision: row.get("config_revision")?,
        authority: row.get("authority")?,
        action_id: row.get("action_id")?,
        updated_at: row.get("updated_at")?,
        deleted: row.get("deleted")?,
    })
}

fn sql_convert<E: std::error::Error + Send + Sync + 'static>(error: E) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

pub(crate) fn occurrence_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Occurrence> {
    Ok(Occurrence {
        occurrence_id: row.get("occurrence_id")?,
        alarm_id: row.get("alarm_id")?,
        alarm_revision: row.get::<_, i64>("alarm_revision").map(|v| v as u64)?,
        kind: match row.get::<_, String>("kind")?.as_str() {
            "repeat" => OccurrenceKind::Repeat,
            "snooze" => OccurrenceKind::Snooze,
            _ => OccurrenceKind::Scheduled,
        },
        scheduled_at: row.get("scheduled_at")?,
        scheduled_us: row.get("scheduled_us")?,
        fold_ordinal: row.get("fold_ordinal")?,
        repeat_ordinal: row.get::<_, i64>("repeat_ordinal").map(|v| v as u64)?,
        parent_occurrence_id: row.get("parent_occurrence_id")?,
        repeat_suppress_from: row
            .get::<_, Option<i64>>("repeat_suppress_from")
            .map(|v| v.map(|value| value as u64))?,
        state: match row.get::<_, String>("state")?.as_str() {
            "claimed" => OccurrenceState::Claimed,
            "fired" => OccurrenceState::Fired,
            "missed" => OccurrenceState::Missed,
            "suppressed" => OccurrenceState::Suppressed,
            _ => OccurrenceState::Due,
        },
        claim_token: row.get("claim_token")?,
        claim_holder: row.get("claim_holder")?,
        claim_made_at: row.get("claim_made_at")?,
        lease_expires_us: row.get("lease_expires_us")?,
        fired_at: row.get("fired_at")?,
        lateness_us: row.get("lateness_us")?,
        misfire_basis: match row.get::<_, Option<String>>("misfire_basis")?.as_deref() {
            Some("fire_once") => Some(MisfireBasis::FireOnce),
            Some("catch_up") => Some(MisfireBasis::CatchUp),
            _ => None,
        },
        ack_state: row.get("ack_state")?,
        acknowledged_at: row.get("acknowledged_at")?,
        missed_reason: row.get("missed_reason")?,
        missed_count: row
            .get::<_, Option<i64>>("missed_count")
            .map(|v| v.map(|value| value as u64))?,
        result_kind: row.get("result_kind")?,
        result_json: row.get("result_json")?,
        created_at: row.get("created_at")?,
    })
}

/// Durable SQLite store. Writes are serialized through immediate
/// transactions; concurrent workers use separate connections on the same
/// file and converge via compare-and-set.
pub struct AlarmStore {
    conn: Connection,
    busy_timeout_ms: u64,
}

impl AlarmStore {
    /// Open (or create) the alarm database at `path`.
    pub fn open(path: &Path, busy_timeout_ms: u64) -> Result<Self, AlarmError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| {
                AlarmError::new(
                    AlarmErrorCode::DatabaseUnavailable,
                    "cannot create store parent",
                )
            })?;
        }
        let mut connection = Connection::open(path).map_err(|e| db_unavailable("open", e))?;
        connection
            .execute_batch(&format!(
                "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = {busy_timeout_ms}; PRAGMA synchronous = FULL;"
            ))
            .map_err(|e| db_unavailable("pragmas", e))?;
        Self::install_schema(connection, busy_timeout_ms)
    }

    /// An isolated in-memory store for single-scheduler tests.
    pub fn open_in_memory() -> Result<Self, AlarmError> {
        let mut connection =
            Connection::open_in_memory().map_err(|e| db_unavailable("open in memory", e))?;
        connection
            .execute_batch("PRAGMA busy_timeout = 5000;")
            .map_err(|e| db_unavailable("pragmas", e))?;
        Self::install_schema(connection, 5000)
    }

    fn install_schema(
        mut connection: Connection,
        busy_timeout_ms: u64,
    ) -> Result<Self, AlarmError> {
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| db_unavailable("schema version", e))?;
        if version > ALARM_SCHEMA_VERSION {
            return Err(AlarmError::new(
                AlarmErrorCode::DatabaseUnavailable,
                format!("database schema {version} is newer than supported {ALARM_SCHEMA_VERSION}"),
            ));
        }
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| db_unavailable("schema migration", e))?;
        if version == 0 {
            tx.execute_batch(ALARM_SCHEMA_SQL)
                .map_err(|e| db_unavailable("schema create", e))?;
            tx.execute(
                "INSERT INTO alarm_meta (singleton, schema_version) VALUES (1, ?1)",
                params![ALARM_SCHEMA_VERSION],
            )
            .map_err(|e| db_unavailable("schema seed", e))?;
        } else {
            let existing: i64 = tx
                .query_row(
                    "SELECT schema_version FROM alarm_meta WHERE singleton = 1",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| db_unavailable("schema check", e))?;
            if existing != ALARM_SCHEMA_VERSION {
                return Err(AlarmError::new(
                    AlarmErrorCode::DatabaseUnavailable,
                    format!("alarm schema version mismatch: {existing}"),
                ));
            }
        }
        tx.execute_batch(&format!("PRAGMA user_version = {ALARM_SCHEMA_VERSION};"))
            .map_err(|e| db_unavailable("schema version write", e))?;
        tx.commit()
            .map_err(|e| db_unavailable("schema commit", e))?;
        Ok(AlarmStore {
            conn: connection,
            busy_timeout_ms,
        })
    }

    // ------------------------------------------------------------------
    // Read paths
    // ------------------------------------------------------------------

    pub fn get_alarm(&self, alarm_id: &str) -> Result<Option<AlarmRow>, AlarmError> {
        let mut statement = self
            .conn
            .prepare(&format!("{ALARM_SELECT} WHERE alarm_id = ?1"))
            .map_err(|e| db_unavailable("prepare get alarm", e))?;
        statement
            .query_row(params![alarm_id], row_from_statement)
            .optional()
            .map_err(|e| db_unavailable("get alarm", e))
    }

    fn get_alarm_conn(conn: &Connection, alarm_id: &str) -> Result<Option<AlarmRow>, AlarmError> {
        let mut statement = conn
            .prepare(&format!("{ALARM_SELECT} WHERE alarm_id = ?1"))
            .map_err(|e| db_unavailable("prepare get alarm", e))?;
        statement
            .query_row(params![alarm_id], row_from_statement)
            .optional()
            .map_err(|e| db_unavailable("get alarm", e))
    }

    /// All active alarms in deterministic list order (nulls last, bytewise
    /// alarm_id tie-break).
    pub fn list_alarms(&self, enabled: Option<bool>) -> Result<Vec<AlarmRow>, AlarmError> {
        let mut sql = format!("{ALARM_SELECT} WHERE deleted = 0");
        match enabled {
            Some(true) => sql.push_str(" AND enabled = 1"),
            Some(false) => sql.push_str(" AND enabled = 0"),
            None => {}
        }
        sql.push_str(" ORDER BY (next_occurrence IS NULL) ASC, next_occurrence ASC, alarm_id ASC");
        let mut statement = self
            .conn
            .prepare(&sql)
            .map_err(|e| db_unavailable("prepare list", e))?;
        let rows = statement
            .query_map([], row_from_statement)
            .map_err(|e| db_unavailable("list alarms", e))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| db_unavailable("list alarms", e))?;
        Ok(rows)
    }

    pub fn count_active_alarms(&self) -> Result<u64, AlarmError> {
        self.conn
            .query_row("SELECT COUNT(*) FROM alarms WHERE deleted = 0", [], |r| {
                r.get::<_, i64>(0).map(|v| v as u64)
            })
            .map_err(|e| db_unavailable("count alarms", e))
    }

    pub fn get_occurrence(&self, occurrence_id: &str) -> Result<Option<Occurrence>, AlarmError> {
        let mut statement = self
            .conn
            .prepare("SELECT * FROM occurrences WHERE occurrence_id = ?1")
            .map_err(|e| db_unavailable("prepare get occurrence", e))?;
        statement
            .query_row(params![occurrence_id], occurrence_from_row)
            .optional()
            .map_err(|e| db_unavailable("get occurrence", e))
    }

    pub fn due_occurrences(&self, for_alarm: Option<&str>) -> Result<Vec<Occurrence>, AlarmError> {
        let (sql, has_alarm) = match for_alarm {
            Some(_) => (
                "SELECT * FROM occurrences WHERE state = 'due' AND alarm_id = ?1 \
                 ORDER BY scheduled_us ASC, occurrence_id ASC",
                true,
            ),
            None => (
                "SELECT * FROM occurrences WHERE state = 'due' \
                 ORDER BY scheduled_us ASC, occurrence_id ASC",
                false,
            ),
        };
        let mut statement = self
            .conn
            .prepare(sql)
            .map_err(|e| db_unavailable("prepare due occurrences", e))?;
        let rows = if has_alarm {
            statement
                .query_map(params![for_alarm.unwrap()], occurrence_from_row)
                .map_err(|e| db_unavailable("due occurrences", e))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| db_unavailable("due occurrences", e))?
        } else {
            statement
                .query_map([], occurrence_from_row)
                .map_err(|e| db_unavailable("due occurrences", e))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| db_unavailable("due occurrences", e))?
        };
        Ok(rows)
    }

    pub fn expired_claims(&self, now: UsInstant) -> Result<Vec<ExpiredClaim>, AlarmError> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT * FROM occurrences WHERE state = 'claimed' AND lease_expires_us <= ?1 ORDER BY occurrence_id",
            )
            .map_err(|e| db_unavailable("prepare expired claims", e))?;
        let occurrences = statement
            .query_map(params![now], occurrence_from_row)
            .map_err(|e| db_unavailable("expired claims", e))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| db_unavailable("expired claims", e))?;
        let mut out = Vec::new();
        for occurrence in occurrences {
            let alarm = Self::get_alarm_conn(&self.conn, &occurrence.alarm_id)?;
            out.push(ExpiredClaim { occurrence, alarm });
        }
        Ok(out)
    }

    pub fn earliest_due(&self) -> Result<Option<(UsInstant, String, String)>, AlarmError> {
        self.conn
            .query_row(
                "SELECT o.scheduled_us, o.occurrence_id, o.alarm_id
                 FROM occurrences o JOIN alarms a ON a.alarm_id = o.alarm_id
                 WHERE o.state = 'due' AND a.deleted = 0 AND a.enabled = 1
                   AND o.alarm_revision = a.revision
                 ORDER BY o.scheduled_us ASC, o.occurrence_id ASC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| db_unavailable("earliest due", e))
    }

    pub fn max_repeat_ordinal(&self, parent_occurrence_id: &str) -> Result<u64, AlarmError> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(repeat_ordinal), 0) FROM occurrences
                 WHERE parent_occurrence_id = ?1 AND kind = 'repeat'",
                params![parent_occurrence_id],
                |r| r.get::<_, i64>(0).map(|v| v as u64),
            )
            .map_err(|e| db_unavailable("max repeat ordinal", e))
    }

    pub fn recorded_action(&self, action_id: &str) -> Result<Option<RecordedAction>, AlarmError> {
        let mut statement = self
            .conn
            .prepare("SELECT name, result_json, alarm_id, applied_at FROM action_log WHERE action_id = ?1")
            .map_err(|e| db_unavailable("prepare action log", e))?;
        let row = statement
            .query_row(params![action_id], |r| {
                Ok(RecordedAction {
                    name: r.get("name")?,
                    result_json: serde_json::from_str::<serde_json::Value>(
                        &r.get::<_, String>("result_json")?,
                    )
                    .map_err(|e| sql_convert(e))?,
                    alarm_id: r.get("alarm_id")?,
                    applied_at: r.get("applied_at")?,
                })
            })
            .optional()
            .map_err(|e| db_unavailable("action log", e))?;
        Ok(row)
    }

    /// Misfire diagnostics in a window for an alarm (bounded audit).
    pub fn misfire_diagnostics(&self, alarm_id: &str) -> Result<Vec<(String, u64)>, AlarmError> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT policy, SUM(count) FROM misfire_diagnostics WHERE alarm_id = ?1 GROUP BY policy",
            )
            .map_err(|e| db_unavailable("prepare diagnostics", e))?;
        let rows = statement
            .query_map(params![alarm_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
            })
            .map_err(|e| db_unavailable("diagnostics", e))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| db_unavailable("diagnostics", e))?;
        Ok(rows)
    }

    pub fn count_occurrences(&self, state: Option<OccurrenceState>) -> Result<u64, AlarmError> {
        match state {
            Some(state) => self
                .conn
                .query_row(
                    "SELECT COUNT(*) FROM occurrences WHERE state = ?1",
                    params![state.as_str()],
                    |r| r.get::<_, i64>(0).map(|v| v as u64),
                )
                .map_err(|e| db_unavailable("count occurrences", e)),
            None => self
                .conn
                .query_row("SELECT COUNT(*) FROM occurrences", [], |r| {
                    r.get::<_, i64>(0).map(|v| v as u64)
                })
                .map_err(|e| db_unavailable("count occurrences", e)),
        }
    }

    pub fn alarms_for_occurrence(
        &self,
        occurrence_id: &str,
    ) -> Result<Option<AlarmRow>, AlarmError> {
        let occurrence = match self.get_occurrence(occurrence_id)? {
            Some(occurrence) => occurrence,
            None => return Ok(None),
        };
        Self::get_alarm_conn(&self.conn, &occurrence.alarm_id)
    }

    // ------------------------------------------------------------------
    // Effect transitions (each one immediate transaction)
    // ------------------------------------------------------------------

    /// Apply one whole committed action in a single transaction.
    ///
    /// `body` performs every write of the action; a failpoint trips before
    /// the transaction opens, so the effect boundary is atomic either way.
    pub fn apply_action<T>(
        &mut self,
        failpoint: Option<&Failpoint>,
        boundary: FailpointBoundary,
        action_id: &str,
        name: &str,
        alarm_id: Option<&str>,
        now: UsInstant,
        result: &serde_json::Value,
        body: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<(), AlarmError>,
    ) -> Result<(), AlarmError> {
        let check = trip(failpoint, boundary);
        let now_at = format_utc_iso6(now);
        transaction(&mut self.conn, check, |tx| {
            body(tx)?;
            tx.execute(
                "INSERT OR REPLACE INTO action_log (action_id, name, outcome, result_json, alarm_id, applied_at)
                 VALUES (?1, ?2, 'applied', ?3, ?4, ?5)",
                params![action_id, name, serde_json::to_string(result).unwrap_or_default(), alarm_id, now_at],
            )
            .map_err(|e| db_unavailable("action log insert", e))?;
            Ok(())
        })
    }

    /// Composite effect: run the body inside one immediate transaction,
    /// tripping the named failpoint boundary first. Used by the scheduler for
    /// settlement and composite transitions whose reads and writes must be
    /// atomic together.
    pub fn effect<T>(
        &mut self,
        failpoint: Option<&Failpoint>,
        boundary: FailpointBoundary,
        body: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T, AlarmError>,
    ) -> Result<T, AlarmError> {
        let check = trip(failpoint, boundary);
        transaction(&mut self.conn, check, body)
    }

    /// Insert or update the alarm row plus its materialized occurrences in
    /// one transaction (create/update path).
    pub fn write_alarm_with_occurrences(
        &mut self,
        failpoint: Option<&Failpoint>,
        boundary: FailpointBoundary,
        action_id: &str,
        action_name: &str,
        now: UsInstant,
        alarm: &AlarmRow,
        occurrences: &[NewOccurrence],
        scheduled_ats: &[String],
        result: &serde_json::Value,
    ) -> Result<(), AlarmError> {
        let check = trip(failpoint, boundary);
        let now_at = format_utc_iso6(now);
        transaction(&mut self.conn, check, |tx| {
            record_alarm_insert(tx, alarm, &now_at)?;
            for (occurrence, scheduled_at) in occurrences.iter().zip(scheduled_ats.iter()) {
                insert_occurrence_tx(
                    tx,
                    occurrence,
                    alarm.revision,
                    &alarm.alarm_id,
                    scheduled_at,
                    &now_at,
                )?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO action_log (action_id, name, outcome, result_json, alarm_id, applied_at)
                 VALUES (?1, ?2, 'applied', ?3, ?4, ?5)",
                params![
                    action_id,
                    action_name,
                    serde_json::to_string(result).unwrap_or_default(),
                    alarm.alarm_id,
                    now_at
                ],
            )
            .map_err(|e| db_unavailable("action log insert", e))?;
            Ok(())
        })
    }

    /// Insert an occurrence row idempotently by canonical identity.
    pub fn insert_occurrence_if_absent(
        &mut self,
        occurrence: &NewOccurrence,
        alarm_revision: u64,
        alarm_id: &str,
        scheduled_at: &str,
        now_at: &str,
    ) -> Result<bool, AlarmError> {
        transaction(&mut self.conn, Ok(()), |tx| {
            insert_occurrence_tx(
                tx,
                occurrence,
                alarm_revision,
                alarm_id,
                scheduled_at,
                now_at,
            )
        })
    }

    /// Claim every currently-due occurrence in scheduled order via a single
    /// compare-and-set pass. Returns the claims actually won.
    pub fn claim_due(
        &mut self,
        failpoint: Option<&Failpoint>,
        now: UsInstant,
        grace_lo: UsInstant,
        claimer: &str,
        lease_expires_us: UsInstant,
    ) -> Result<Vec<Claim>, AlarmError> {
        let check = trip(failpoint, FailpointBoundary::BeforeClaim);
        transaction(&mut self.conn, check, |tx| {
            let mut statement = tx
                .prepare(
                    "SELECT o.* FROM occurrences o JOIN alarms a ON a.alarm_id = o.alarm_id
                     WHERE o.state = 'due' AND a.deleted = 0 AND a.enabled = 1
                       AND o.alarm_revision = a.revision
                       AND o.scheduled_us <= ?1
                       AND (o.misfire_basis IS NOT NULL OR o.scheduled_us >= ?2)
                     ORDER BY o.scheduled_us ASC, o.occurrence_id ASC",
                )
                .map_err(|e| db_unavailable("claim prepare", e))?;
            let rows = statement
                .query_map(params![now, grace_lo], occurrence_from_row)
                .map_err(|e| db_unavailable("claim query", e))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| db_unavailable("claim query", e))?;
            let mut claims = Vec::new();
            for occurrence in rows {
                let token = claim_token(&occurrence.occurrence_id, claimer, now, lease_expires_us);
                let claim_made_at = format_utc_iso6(now);
                let changed = tx
                    .execute(
                        "UPDATE occurrences SET state = 'claimed', claim_token = ?1,
                            claim_holder = ?2, claim_made_at = ?3, lease_expires_us = ?4
                         WHERE occurrence_id = ?5 AND state = 'due'",
                        params![
                            token,
                            claimer,
                            claim_made_at,
                            lease_expires_us,
                            occurrence.occurrence_id
                        ],
                    )
                    .map_err(|e| db_unavailable("claim cas", e))?;
                if changed == 1 {
                    claims.push(Claim {
                        occurrence_id: occurrence.occurrence_id.clone(),
                        alarm_id: occurrence.alarm_id.clone(),
                        alarm_revision: occurrence.alarm_revision,
                        claim_token: token,
                        scheduled_at: occurrence.scheduled_at.clone(),
                        scheduled_us: occurrence.scheduled_us,
                        fold_ordinal: occurrence.fold_ordinal,
                        kind: occurrence.kind,
                        repeat_ordinal: occurrence.repeat_ordinal,
                        parent_occurrence_id: occurrence.parent_occurrence_id.clone(),
                        misfire_basis: occurrence.misfire_basis,
                        claim_made_at,
                        lease_expires_us,
                    });
                }
            }
            Ok(claims)
        })
    }

    /// Complete a held claim: move it to FIRED with its committed output
    /// premise. Fails when the claim is no longer held under that token.
    pub fn complete_claim(
        &mut self,
        failpoint: Option<&Failpoint>,
        claim: &Claim,
        now: UsInstant,
        result_kind: &str,
        result_json: &str,
    ) -> Result<(), AlarmError> {
        let check = trip(failpoint, FailpointBoundary::BeforeComplete);
        transaction(&mut self.conn, check, |tx| {
            let lateness = now.saturating_sub(claim.scheduled_us);
            let fired_at = format_utc_iso6(now);
            let changed = tx
                .execute(
                    "UPDATE occurrences SET state = 'fired', fired_at = ?1, lateness_us = ?2,
                        result_kind = ?3, result_json = ?4,
                        claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                        lease_expires_us = NULL
                     WHERE occurrence_id = ?5 AND state = 'claimed' AND claim_token = ?6",
                    params![
                        fired_at,
                        lateness,
                        result_kind,
                        result_json,
                        claim.occurrence_id,
                        claim.claim_token
                    ],
                )
                .map_err(|e| db_unavailable("complete cas", e))?;
            if changed != 1 {
                return Err(occurrence_not_found(&claim.occurrence_id));
            }
            Ok(())
        })
    }

    /// Release a held claim back to DUE (host output not committed).
    pub fn release_claim(
        &mut self,
        failpoint: Option<&Failpoint>,
        claim: &Claim,
    ) -> Result<bool, AlarmError> {
        let check = trip(failpoint, FailpointBoundary::BeforeRelease);
        transaction(&mut self.conn, check, |tx| {
            let changed = tx
                .execute(
                    "UPDATE occurrences SET state = 'due',
                        claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                        lease_expires_us = NULL
                     WHERE occurrence_id = ?1 AND state = 'claimed' AND claim_token = ?2",
                    params![claim.occurrence_id, claim.claim_token],
                )
                .map_err(|e| db_unavailable("release cas", e))?;
            Ok(changed == 1)
        })
    }

    /// Mark a DUE occurrence with a terminal state plus annotation.
    pub fn set_occurrence_state(
        &mut self,
        failpoint: Option<&Failpoint>,
        boundary: FailpointBoundary,
        occurrence_id: &str,
        state: OccurrenceState,
        missed_reason: Option<&str>,
        missed_count: Option<u64>,
    ) -> Result<bool, AlarmError> {
        let check = trip(failpoint, boundary);
        transaction(&mut self.conn, check, |tx| {
            let changed = tx
                .execute(
                    "UPDATE occurrences SET state = ?1,
                        claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                        lease_expires_us = NULL, missed_reason = ?2, missed_count = ?3
                     WHERE occurrence_id = ?4 AND state = 'due'",
                    params![
                        state.as_str(),
                        missed_reason,
                        missed_count.map(|count| count as i64),
                        occurrence_id
                    ],
                )
                .map_err(|e| db_unavailable("set occurrence state", e))?;
            Ok(changed == 1)
        })
    }

    /// Suppress DUE occurrences of an alarm on rule change, preserving
    /// history rows.
    pub fn suppress_due_for_alarm(
        &mut self,
        failpoint: Option<&Failpoint>,
        boundary: FailpointBoundary,
        alarm_id: &str,
        only_revision: Option<u64>,
        reason: &str,
    ) -> Result<u64, AlarmError> {
        let check = trip(failpoint, boundary);
        transaction(&mut self.conn, check, |tx| {
            let changed = match only_revision {
                Some(revision) => tx
                    .execute(
                        "UPDATE occurrences SET state = 'suppressed', missed_reason = ?1,
                            claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                            lease_expires_us = NULL
                         WHERE alarm_id = ?2 AND alarm_revision = ?3 AND state = 'due'",
                        params![reason, alarm_id, revision as i64],
                    )
                    .map_err(|e| db_unavailable("suppress due", e))?,
                None => tx
                    .execute(
                        "UPDATE occurrences SET state = 'suppressed', missed_reason = ?1,
                            claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                            lease_expires_us = NULL
                         WHERE alarm_id = ?2 AND state = 'due'",
                        params![reason, alarm_id],
                    )
                    .map_err(|e| db_unavailable("suppress due", e))?,
            };
            Ok(changed as u64)
        })
    }

    /// Set the acknowledgement state of one occurrence and suppress its and
    /// later repeats, all atomically.
    pub fn acknowledge_occurrence(
        &mut self,
        failpoint: Option<&Failpoint>,
        acked_occurrence_id: &str,
        source_occurrence_id: &str,
        suppress_from: u64,
        acknowledged_at: &str,
    ) -> Result<bool, AlarmError> {
        let check = trip(failpoint, FailpointBoundary::BeforeAcknowledge);
        transaction(&mut self.conn, check, |tx| {
            // Mark the acked occurrence itself (only when not already
            // acknowledged; the first acknowledged_at is preserved).
            let changed = tx
                .execute(
                    "UPDATE occurrences SET ack_state = 'acknowledged', acknowledged_at = ?2
                     WHERE occurrence_id = ?1 AND ack_state IS NULL",
                    params![acked_occurrence_id, acknowledged_at],
                )
                .map_err(|e| db_unavailable("ack cas", e))?;
            // Persist the suppression threshold on the source occurrence.
            tx.execute(
                "UPDATE occurrences SET repeat_suppress_from = MIN(COALESCE(repeat_suppress_from, ?2), ?1)
                 WHERE occurrence_id = ?3",
                params![suppress_from as i64, i64::MAX, source_occurrence_id],
            )
            .map_err(|e| db_unavailable("ack suppress threshold", e))?;
            // Suppress that and all later repeats atomically.
            tx.execute(
                "UPDATE occurrences SET state = 'suppressed', missed_reason = 'acknowledged',
                    claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                    lease_expires_us = NULL
                 WHERE parent_occurrence_id = ?1 AND kind = 'repeat'
                   AND repeat_ordinal >= ?2 AND state = 'due'",
                params![source_occurrence_id, suppress_from as i64],
            )
            .map_err(|e| db_unavailable("ack suppress repeats", e))?;
            Ok(changed == 1)
        })
    }

    /// Record a durable misfire diagnostic (bounded count audit).
    pub fn record_misfire_diagnostic(
        &mut self,
        alarm_id: &str,
        policy: &str,
        from_us: UsInstant,
        to_us: UsInstant,
        count: u64,
        now_at: &str,
    ) -> Result<(), AlarmError> {
        transaction(&mut self.conn, Ok(()), |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO misfire_diagnostics (alarm_id, policy, from_us, to_us, count, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![alarm_id, policy, from_us, to_us, count as i64, now_at],
            )
            .map_err(|e| db_unavailable("misfire diagnostic", e))?;
            Ok(())
        })
    }

    /// Recompute and persist an alarm's `next_occurrence` from its DUE rows.
    pub fn recompute_next_occurrence(
        &mut self,
        failpoint: Option<&Failpoint>,
        boundary: FailpointBoundary,
        alarm_id: &str,
        now: UsInstant,
        only_future: bool,
    ) -> Result<Option<String>, AlarmError> {
        let check = trip(failpoint, boundary);
        transaction(&mut self.conn, check, |tx| {
            let next: Option<String> = if only_future {
                tx.query_row(
                    "SELECT MIN(o.scheduled_at) FROM occurrences o
                     JOIN alarms a ON a.alarm_id = o.alarm_id
                     WHERE o.alarm_id = ?1 AND o.state = 'due' AND o.scheduled_us > ?2
                       AND a.deleted = 0",
                    params![alarm_id, now],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| db_unavailable("next occurrence query", e))?
            } else {
                tx.query_row(
                    "SELECT MIN(o.scheduled_at) FROM occurrences o
                     WHERE o.alarm_id = ?1 AND o.state = 'due'",
                    params![alarm_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| db_unavailable("next occurrence query", e))?
            };
            tx.execute(
                "UPDATE alarms SET next_occurrence = ?1 WHERE alarm_id = ?2",
                params![next, alarm_id],
            )
            .map_err(|e| db_unavailable("next occurrence write", e))?;
            Ok(next)
        })
    }

    /// Prune terminal history older than the retention window.
    pub fn prune_history(
        &mut self,
        failpoint: Option<&Failpoint>,
        older_than_us: UsInstant,
    ) -> Result<u64, AlarmError> {
        let check = trip(failpoint, FailpointBoundary::BeforePrune);
        transaction(&mut self.conn, check, |tx| {
            let removed = tx
                .execute(
                    "DELETE FROM occurrences
                     WHERE state IN ('fired', 'missed', 'suppressed') AND scheduled_us < ?1",
                    params![older_than_us],
                )
                .map_err(|e| db_unavailable("prune history", e))?;
            Ok(removed as u64)
        })
    }
}

fn record_alarm_insert(
    tx: &rusqlite::Transaction<'_>,
    row: &AlarmRow,
    updated_at: &str,
) -> Result<(), AlarmError> {
    tx.execute(
        "INSERT OR REPLACE INTO alarms (alarm_id, revision, title, schedule_json, delivery_json,
            misfire_policy, dst_gap_policy, dst_fold_policy, enabled, created_at,
            next_occurrence, tzdb_revision, config_revision, authority, action_id,
            updated_at, deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            row.alarm_id,
            row.revision as i64,
            row.title,
            serde_json::to_string(&row.schedule_shape).unwrap_or_default(),
            serde_json::to_string(&row.delivery_shape).unwrap_or_default(),
            row.misfire_policy.as_str(),
            row.dst_gap_policy.as_str(),
            row.dst_fold_policy.as_str(),
            row.enabled,
            row.created_at,
            row.next_occurrence,
            row.tzdb_revision,
            row.config_revision,
            row.authority,
            row.action_id,
            updated_at,
            row.deleted,
        ],
    )
    .map_err(|e| db_unavailable("insert alarm", e))?;
    Ok(())
}

pub(crate) fn insert_occurrence_tx(
    tx: &rusqlite::Transaction<'_>,
    occurrence: &NewOccurrence,
    alarm_revision: u64,
    alarm_id: &str,
    scheduled_at: &str,
    now_at: &str,
) -> Result<bool, AlarmError> {
    let changed = tx
        .execute(
            "INSERT OR IGNORE INTO occurrences (occurrence_id, alarm_id, alarm_revision, kind,
                scheduled_at, scheduled_us, fold_ordinal, repeat_ordinal, parent_occurrence_id,
                state, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'due', ?10)",
            params![
                occurrence.occurrence_id,
                alarm_id,
                alarm_revision as i64,
                occurrence.kind.as_str(),
                scheduled_at,
                occurrence.scheduled_us,
                i64::from(occurrence.fold_ordinal),
                occurrence.repeat_ordinal as i64,
                occurrence.parent_occurrence_id,
                now_at,
            ],
        )
        .map_err(|e| db_unavailable("insert occurrence", e))?;
    Ok(changed == 1)
}

/// Field update for `update_alarm_row`; SQL is positional.
#[derive(Debug, Default)]
pub struct AlarmRowUpdate {
    pub title: Option<String>,
    pub schedule_json: Option<String>,
    pub delivery_json: Option<String>,
    pub misfire_policy: Option<String>,
    pub dst_gap_policy: Option<String>,
    pub dst_fold_policy: Option<String>,
    pub enabled: Option<bool>,
    pub next_occurrence: Option<Option<String>>,
    pub tzdb_revision: Option<String>,
    pub config_revision: Option<String>,
    pub authority: Option<String>,
    pub action_id: Option<String>,
    pub revision_bump: bool,
    pub deleted: Option<bool>,
    pub updated_at: Option<String>,
}

fn build_alarm_update(fields: &AlarmRowUpdate) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut sets: Vec<String> = Vec::new();
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut add = |sets: &mut Vec<String>,
                   params_vec: &mut Vec<Box<dyn rusqlite::ToSql>>,
                   column: &str,
                   value: Box<dyn rusqlite::ToSql>| {
        let index = params_vec.len() + 1;
        sets.push(format!("{column} = ?{index}"));
        params_vec.push(value);
    };
    if let Some(value) = &fields.title {
        add(&mut sets, &mut params_vec, "title", Box::new(value.clone()));
    }
    if let Some(value) = &fields.schedule_json {
        add(
            &mut sets,
            &mut params_vec,
            "schedule_json",
            Box::new(value.clone()),
        );
    }
    if let Some(value) = &fields.delivery_json {
        add(
            &mut sets,
            &mut params_vec,
            "delivery_json",
            Box::new(value.clone()),
        );
    }
    if let Some(value) = &fields.misfire_policy {
        add(
            &mut sets,
            &mut params_vec,
            "misfire_policy",
            Box::new(value.clone()),
        );
    }
    if let Some(value) = &fields.dst_gap_policy {
        add(
            &mut sets,
            &mut params_vec,
            "dst_gap_policy",
            Box::new(value.clone()),
        );
    }
    if let Some(value) = &fields.dst_fold_policy {
        add(
            &mut sets,
            &mut params_vec,
            "dst_fold_policy",
            Box::new(value.clone()),
        );
    }
    if let Some(value) = fields.enabled {
        add(&mut sets, &mut params_vec, "enabled", Box::new(value));
    }
    match &fields.next_occurrence {
        Some(Some(value)) => add(
            &mut sets,
            &mut params_vec,
            "next_occurrence",
            Box::new(value.clone()),
        ),
        Some(None) => add(
            &mut sets,
            &mut params_vec,
            "next_occurrence",
            Box::new(None::<String>),
        ),
        None => {}
    }
    if let Some(value) = &fields.tzdb_revision {
        add(
            &mut sets,
            &mut params_vec,
            "tzdb_revision",
            Box::new(value.clone()),
        );
    }
    if let Some(value) = &fields.config_revision {
        add(
            &mut sets,
            &mut params_vec,
            "config_revision",
            Box::new(value.clone()),
        );
    }
    if let Some(value) = &fields.authority {
        add(
            &mut sets,
            &mut params_vec,
            "authority",
            Box::new(value.clone()),
        );
    }
    if let Some(value) = &fields.action_id {
        add(
            &mut sets,
            &mut params_vec,
            "action_id",
            Box::new(value.clone()),
        );
    }
    if fields.revision_bump {
        sets.push("revision = revision + 1".to_string());
    }
    if let Some(value) = fields.deleted {
        add(&mut sets, &mut params_vec, "deleted", Box::new(value));
    }
    if let Some(value) = &fields.updated_at {
        add(
            &mut sets,
            &mut params_vec,
            "updated_at",
            Box::new(value.clone()),
        );
    }
    let sql = format!("UPDATE alarms SET {}", sets.join(", "));
    (sql, params_vec)
}

fn occurrence_not_found(occurrence_id: &str) -> AlarmError {
    let mut details = serde_json::Map::new();
    details.insert(
        "occurrence_id".to_string(),
        serde_json::Value::String(occurrence_id.to_string()),
    );
    AlarmError::with_details(
        AlarmErrorCode::OccurrenceNotFound,
        "occurrence not found in the expected claimable state",
        details,
    )
}

/// Due occurrences of one alarm in scheduled order, within a transaction.
pub(crate) fn due_occurrences_tx(
    tx: &rusqlite::Transaction<'_>,
    alarm_id: &str,
) -> Result<Vec<Occurrence>, AlarmError> {
    let mut statement = tx
        .prepare(
            "SELECT * FROM occurrences WHERE alarm_id = ?1 AND state = 'due' \
             ORDER BY scheduled_us ASC, occurrence_id ASC",
        )
        .map_err(|e| db_unavailable("prepare due tx", e))?;
    let rows = statement
        .query_map(params![alarm_id], occurrence_from_row)
        .map_err(|e| db_unavailable("due tx", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| db_unavailable("due tx", e))?;
    Ok(rows)
}

/// One alarm row within a transaction.
pub(crate) fn get_alarm_tx(
    tx: &rusqlite::Transaction<'_>,
    alarm_id: &str,
) -> Result<Option<AlarmRow>, AlarmError> {
    let mut statement = tx
        .prepare(&format!("{ALARM_SELECT} WHERE alarm_id = ?1"))
        .map_err(|e| db_unavailable("prepare get alarm", e))?;
    statement
        .query_row(params![alarm_id], row_from_statement)
        .optional()
        .map_err(|e| db_unavailable("get alarm", e))
}

/// One occurrence within a transaction.
pub(crate) fn get_occurrence_tx(
    tx: &rusqlite::Transaction<'_>,
    occurrence_id: &str,
) -> Result<Option<Occurrence>, AlarmError> {
    let mut statement = tx
        .prepare("SELECT * FROM occurrences WHERE occurrence_id = ?1")
        .map_err(|e| db_unavailable("prepare get occurrence tx", e))?;
    statement
        .query_row(params![occurrence_id], occurrence_from_row)
        .optional()
        .map_err(|e| db_unavailable("get occurrence tx", e))
}

/// Transition one DUE occurrence to a target state inside a transaction.
pub(crate) fn update_occurrence_state_tx(
    tx: &rusqlite::Transaction<'_>,
    occurrence_id: &str,
    state: OccurrenceState,
    missed_reason: Option<&str>,
    misfire_basis: Option<MisfireBasis>,
    missed_count: Option<u64>,
) -> Result<bool, AlarmError> {
    let changed = tx
        .execute(
            "UPDATE occurrences SET state = ?1, missed_reason = ?2, misfire_basis = ?3,
                missed_count = ?4,
                claim_token = NULL, claim_holder = NULL, claim_made_at = NULL,
                lease_expires_us = NULL
             WHERE occurrence_id = ?5 AND state = 'due'",
            params![
                state.as_str(),
                missed_reason,
                misfire_basis.map(|b| b.as_str()),
                missed_count.map(|count| count as i64),
                occurrence_id
            ],
        )
        .map_err(|e| db_unavailable("update occurrence tx", e))?;
    Ok(changed == 1)
}

/// Record an applied action inside a transaction.
pub(crate) fn record_action_log_tx(
    tx: &rusqlite::Transaction<'_>,
    action_id: &str,
    name: &str,
    result: &serde_json::Value,
    alarm_id: Option<&str>,
    now_at: &str,
) -> Result<(), AlarmError> {
    tx.execute(
        "INSERT OR REPLACE INTO action_log (action_id, name, outcome, result_json, alarm_id, applied_at)
         VALUES (?1, ?2, 'applied', ?3, ?4, ?5)",
        params![action_id, name, serde_json::to_string(result).unwrap_or_default(), alarm_id, now_at],
    )
    .map_err(|e| db_unavailable("action log tx", e))?;
    Ok(())
}

/// Recompute and persist a record's `next_occurrence` inside a transaction.
pub(crate) fn recompute_next_tx(
    tx: &rusqlite::Transaction<'_>,
    alarm_id: &str,
    now: UsInstant,
    only_future: bool,
) -> Result<Option<String>, AlarmError> {
    let next: Option<String> = if only_future {
        tx.query_row(
            "SELECT MIN(o.scheduled_at) FROM occurrences o
             WHERE o.alarm_id = ?1 AND o.state = 'due' AND o.scheduled_us > ?2",
            params![alarm_id, now],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| db_unavailable("next tx query", e))?
    } else {
        tx.query_row(
            "SELECT MIN(o.scheduled_at) FROM occurrences o
             WHERE o.alarm_id = ?1 AND o.state = 'due'",
            params![alarm_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| db_unavailable("next tx query", e))?
    };
    tx.execute(
        "UPDATE alarms SET next_occurrence = ?1 WHERE alarm_id = ?2",
        params![next, alarm_id],
    )
    .map_err(|e| db_unavailable("next tx write", e))?;
    Ok(next)
}

/// Apply comma-positional alarm field updates inside a transaction, guarded
/// by the expected revision.
pub(crate) fn update_alarm_fields_tx(
    tx: &rusqlite::Transaction<'_>,
    alarm_id: &str,
    expected_revision: u64,
    fields: &AlarmRowUpdate,
) -> Result<bool, AlarmError> {
    let (sql, mut params_vec) = build_alarm_update(fields);
    let mut complete_sql = sql;
    complete_sql.push_str(" WHERE alarm_id = ?");
    complete_sql.push_str(&(params_vec.len() + 1).to_string());
    complete_sql.push_str(" AND revision = ?");
    complete_sql.push_str(&(params_vec.len() + 2).to_string());
    params_vec.push(Box::new(alarm_id.to_string()));
    params_vec.push(Box::new(expected_revision as i64));
    let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
    let changed = tx
        .execute(&complete_sql, rusqlite::params_from_iter(params_refs))
        .map_err(|e| db_unavailable("update alarm fields tx", e))?;
    Ok(changed == 1)
}

/// Record a misfire diagnostic inside a transaction.
pub(crate) fn record_diagnostic_tx(
    tx: &rusqlite::Transaction<'_>,
    alarm_id: &str,
    policy: &str,
    from_us: UsInstant,
    to_us: UsInstant,
    count: u64,
    now_at: &str,
) -> Result<(), AlarmError> {
    if count == 0 {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO misfire_diagnostics (alarm_id, policy, from_us, to_us, count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![alarm_id, policy, from_us, to_us, count as i64, now_at],
    )
    .map_err(|e| db_unavailable("diagnostic tx", e))?;
    Ok(())
}

pub fn claim_token(
    occurrence_id: &str,
    claimer: &str,
    now: UsInstant,
    lease_expires_us: UsInstant,
) -> String {
    let tuple = (
        "dolly.alarm.claim/v1",
        occurrence_id,
        claimer,
        crate::time::format_utc_iso6(now),
        lease_expires_us,
    );
    let (_, digest) = dolly_canonical_json::canonicalize(&tuple)
        .expect("claim token tuple is trivially canonicalizable");
    digest.to_canonical_string()
}
